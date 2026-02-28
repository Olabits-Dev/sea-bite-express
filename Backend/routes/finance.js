const express = require("express");
const db = require("../db");
const { sendMailWithAttachment } = require("../utils/mailer");

const router = express.Router();

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function parsePeriod(period) {
  const p = String(period || "").toLowerCase();
  return ["daily", "weekly", "monthly", "yearly"].includes(p) ? p : "monthly";
}
function startISO(period) {
  const now = new Date();
  const s = new Date(now);
  if (period === "daily") s.setHours(0, 0, 0, 0);
  if (period === "weekly") s.setDate(now.getDate() - 7);
  if (period === "monthly") { s.setDate(1); s.setHours(0, 0, 0, 0); }
  if (period === "yearly") { s.setMonth(0, 1); s.setHours(0, 0, 0, 0); }
  return s.toISOString();
}
function okAmount(n) { return Number.isFinite(n) && n > 0; }
function okQty(n) { return Number.isFinite(n) && n > 0; }

// LIST SALES (with items)
router.get("/sales", async (_req, res) => {
  try {
    const sales = await all(`SELECT * FROM sales ORDER BY datetime(created_at) DESC LIMIT 500`);
    const ids = sales.map(s => s.id);

    let items = [];
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      items = await all(`
        SELECT si.sale_id, si.product_id, si.qty_used,
               p.name AS product_name, p.unit AS product_unit
        FROM sale_items si
        JOIN products p ON p.id = si.product_id
        WHERE si.sale_id IN (${placeholders})
      `, ids);
    }

    const map = new Map();
    for (const s of sales) map.set(s.id, { ...s, items: [] });

    for (const it of items) {
      const t = map.get(it.sale_id);
      if (t) t.items.push({
        product_id: it.product_id,
        product_name: it.product_name,
        product_unit: it.product_unit,
        qty_used: it.qty_used
      });
    }

    res.json(Array.from(map.values()));
  } catch {
    res.status(500).json({ error: "Failed to fetch sales" });
  }
});

// CREATE SALE + STOCK OUT per item
router.post("/sales", async (req, res) => {
  const amount = Number(req.body?.amount);
  const description = String(req.body?.description || "").trim();
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!okAmount(amount) || !description) {
    return res.status(400).json({ error: "Valid amount (>0) and description required" });
  }

  for (const it of items) {
    const pid = Number(it.product_id);
    const qty = Number(it.qty_used);
    if (!Number.isFinite(pid) || pid <= 0) return res.status(400).json({ error: "Invalid product_id in items" });
    if (!okQty(qty)) return res.status(400).json({ error: "qty_used must be > 0 in items" });
  }

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");
    (async () => {
      try {
        // Validate stock
        for (const it of items) {
          const pid = Number(it.product_id);
          const qty = Number(it.qty_used);
          const product = await get(`SELECT * FROM products WHERE id=?`, [pid]);
          if (!product) throw new Error(`Product not found (ID ${pid})`);
          if (Number(product.qty) - qty < 0) throw new Error(`Insufficient stock for ${product.name}`);
        }

        const r = await run(`INSERT INTO sales (amount, description) VALUES (?, ?)`, [amount, description]);
        const saleId = r.lastID;

        for (const it of items) {
          const pid = Number(it.product_id);
          const qty = Number(it.qty_used);

          await run(`INSERT INTO sale_items (sale_id, product_id, qty_used) VALUES (?, ?, ?)`, [saleId, pid, qty]);

          await run(
            `INSERT INTO stock_movements (product_id, type, qty, note) VALUES (?, 'OUT', ?, ?)`,
            [pid, qty, `Auto OUT for Sale #${saleId}`]
          );

          const product = await get(`SELECT * FROM products WHERE id=?`, [pid]);
          const newQty = Number(product.qty) - qty;
          await run(`UPDATE products SET qty=?, updated_at=datetime('now') WHERE id=?`, [newQty, pid]);
        }

        await run("COMMIT");

        const sale = await get(`SELECT * FROM sales WHERE id=?`, [saleId]);
        const saleItems = await all(`
          SELECT si.product_id, si.qty_used, p.name AS product_name, p.unit AS product_unit
          FROM sale_items si
          JOIN products p ON p.id = si.product_id
          WHERE si.sale_id=?
        `, [saleId]);

        res.json({ ...sale, items: saleItems });
      } catch (e) {
        await run("ROLLBACK");
        res.status(400).json({ error: e.message || "Failed to create sale" });
      }
    })();
  });
});

// UPDATE sale (amount/description only)
router.put("/sales/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const amount = Number(req.body?.amount);
    const description = String(req.body?.description || "").trim();

    if (!okAmount(amount) || !description) return res.status(400).json({ error: "Valid amount and description required" });

    const ex = await get(`SELECT * FROM sales WHERE id=?`, [id]);
    if (!ex) return res.status(404).json({ error: "Sale not found" });

    await run(`UPDATE sales SET amount=?, description=? WHERE id=?`, [amount, description, id]);

    const sale = await get(`SELECT * FROM sales WHERE id=?`, [id]);
    const saleItems = await all(`
      SELECT si.product_id, si.qty_used, p.name AS product_name, p.unit AS product_unit
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      WHERE si.sale_id=?
    `, [id]);

    res.json({ ...sale, items: saleItems });
  } catch {
    res.status(500).json({ error: "Failed to update sale" });
  }
});

// DELETE sale (revert stock for each item)
router.delete("/sales/:id", async (req, res) => {
  const id = Number(req.params.id);

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");
    (async () => {
      try {
        const sale = await get(`SELECT * FROM sales WHERE id=?`, [id]);
        if (!sale) throw new Error("Sale not found");

        const items = await all(`SELECT * FROM sale_items WHERE sale_id=?`, [id]);

        for (const it of items) {
          const pid = Number(it.product_id);
          const qty = Number(it.qty_used);

          const product = await get(`SELECT * FROM products WHERE id=?`, [pid]);
          if (product) {
            await run(
              `INSERT INTO stock_movements (product_id, type, qty, note) VALUES (?, 'IN', ?, ?)`,
              [pid, qty, `Revert IN for deleted Sale #${id}`]
            );

            const newQty = Number(product.qty) + qty;
            await run(`UPDATE products SET qty=?, updated_at=datetime('now') WHERE id=?`, [newQty, pid]);
          }
        }

        await run(`DELETE FROM sale_items WHERE sale_id=?`, [id]);
        await run(`DELETE FROM sales WHERE id=?`, [id]);

        await run("COMMIT");
        res.json({ ok: true });
      } catch (e) {
        await run("ROLLBACK");
        res.status(400).json({ error: e.message || "Failed to delete sale" });
      }
    })();
  });
});

// EXPENSES
router.get("/expenses", async (_req, res) => {
  try {
    const rows = await all(`SELECT * FROM expenses ORDER BY datetime(created_at) DESC LIMIT 500`);
    res.json(rows);
  } catch {
    res.status(500).json({ error: "Failed to fetch expenses" });
  }
});
router.post("/expenses", async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    const description = String(req.body?.description || "").trim();
    if (!okAmount(amount) || !description) return res.status(400).json({ error: "Valid amount and description required" });

    const r = await run(`INSERT INTO expenses (amount, description) VALUES (?, ?)`, [amount, description]);
    const row = await get(`SELECT * FROM expenses WHERE id=?`, [r.lastID]);
    res.json(row);
  } catch {
    res.status(500).json({ error: "Failed to create expense" });
  }
});
router.put("/expenses/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const amount = Number(req.body?.amount);
    const description = String(req.body?.description || "").trim();
    if (!okAmount(amount) || !description) return res.status(400).json({ error: "Valid amount and description required" });

    const ex = await get(`SELECT * FROM expenses WHERE id=?`, [id]);
    if (!ex) return res.status(404).json({ error: "Expense not found" });

    await run(`UPDATE expenses SET amount=?, description=? WHERE id=?`, [amount, description, id]);
    const row = await get(`SELECT * FROM expenses WHERE id=?`, [id]);
    res.json(row);
  } catch {
    res.status(500).json({ error: "Failed to update expense" });
  }
});
router.delete("/expenses/:id", async (req, res) => {
  try {
    await run(`DELETE FROM expenses WHERE id=?`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to delete expense" });
  }
});

// REPORT
router.get("/report", async (req, res) => {
  try {
    const period = parsePeriod(req.query.period);
    const from = startISO(period);

    const s = await all(`SELECT amount FROM sales WHERE datetime(created_at) >= datetime(?)`, [from]);
    const e = await all(`SELECT amount FROM expenses WHERE datetime(created_at) >= datetime(?)`, [from]);

    const totalSales = s.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const totalExpenses = e.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const profit = totalSales - totalExpenses;

    res.json({ period, from, totals: { totalSales, totalExpenses, profit } });
  } catch {
    res.status(500).json({ error: "Failed to generate report" });
  }
});

// EXPORT CSV (includes Products Used)
router.get("/export/finance.csv", async (req, res) => {
  try {
    const period = parsePeriod(req.query.period);
    const from = startISO(period);

    const sales = await all(`
      SELECT s.id, s.amount, s.description, s.created_at
      FROM sales s
      WHERE datetime(s.created_at) >= datetime(?)
      ORDER BY datetime(s.created_at) DESC
    `, [from]);

    const ids = sales.map(s => s.id);
    let items = [];
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      items = await all(`
        SELECT si.sale_id, si.qty_used, p.name AS product_name
        FROM sale_items si
        JOIN products p ON p.id = si.product_id
        WHERE si.sale_id IN (${placeholders})
      `, ids);
    }

    const itemsBySale = new Map();
    for (const it of items) {
      const arr = itemsBySale.get(it.sale_id) || [];
      arr.push(`${it.product_name} x${Number(it.qty_used)}`);
      itemsBySale.set(it.sale_id, arr);
    }

    const expenses = await all(
      `SELECT amount, description, created_at FROM expenses WHERE datetime(created_at) >= datetime(?) ORDER BY datetime(created_at) DESC`,
      [from]
    );

    const totalSales = sales.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const totalExpenses = expenses.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const profit = totalSales - totalExpenses;

    let csv = "";
    csv += "BUSINESS REPORT\n";
    csv += `Report Type:,${period.toUpperCase()}\n`;
    csv += `Generated On:,${new Date().toLocaleString()}\n\n`;

    csv += "SUMMARY\n";
    csv += "Total Sales (NGN),Total Expenses (NGN),Profit (NGN)\n";
    csv += `${totalSales},${totalExpenses},${profit}\n\n`;

    csv += "DETAILED RECORDS\n";
    csv += "Type,Amount (NGN),Description,Products Used,Date\n";

    sales.forEach(r => {
      const d = String(r.description || "").replaceAll('"', '""');
      const used = (itemsBySale.get(r.id) || []).join("; ").replaceAll('"', '""');
      csv += `"Sale",${Number(r.amount) || 0},"${d}","${used}","${new Date(r.created_at).toLocaleString()}"\n`;
    });

    expenses.forEach(r => {
      const d = String(r.description || "").replaceAll('"', '""');
      csv += `"Expense",${Number(r.amount) || 0},"${d}","","${new Date(r.created_at).toLocaleString()}"\n`;
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=finance-${period}.csv`);
    res.send(csv);
  } catch {
    res.status(500).json({ error: "Failed to export finance CSV" });
  }
});

// EMAIL FINANCE CSV
router.post("/email/finance", async (req, res) => {
  try {
    const to = String(req.body?.to || "").trim();
    const period = parsePeriod(req.body?.period);
    if (!to) return res.status(400).json({ error: "Recipient email is required" });

    // Build CSV using same logic as export
    const from = startISO(period);

    const sales = await all(`
      SELECT s.id, s.amount, s.description, s.created_at
      FROM sales s
      WHERE datetime(s.created_at) >= datetime(?)
      ORDER BY datetime(s.created_at) DESC
    `, [from]);

    const ids = sales.map(s => s.id);
    let items = [];
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      items = await all(`
        SELECT si.sale_id, si.qty_used, p.name AS product_name
        FROM sale_items si
        JOIN products p ON p.id = si.product_id
        WHERE si.sale_id IN (${placeholders})
      `, ids);
    }

    const itemsBySale = new Map();
    for (const it of items) {
      const arr = itemsBySale.get(it.sale_id) || [];
      arr.push(`${it.product_name} x${Number(it.qty_used)}`);
      itemsBySale.set(it.sale_id, arr);
    }

    const expenses = await all(
      `SELECT amount, description, created_at FROM expenses WHERE datetime(created_at) >= datetime(?) ORDER BY datetime(created_at) DESC`,
      [from]
    );

    const totalSales = sales.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const totalExpenses = expenses.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const profit = totalSales - totalExpenses;

    let csv = "";
    csv += "BUSINESS REPORT\n";
    csv += `Report Type:,${period.toUpperCase()}\n`;
    csv += `Generated On:,${new Date().toLocaleString()}\n\n`;
    csv += "SUMMARY\n";
    csv += "Total Sales (NGN),Total Expenses (NGN),Profit (NGN)\n";
    csv += `${totalSales},${totalExpenses},${profit}\n\n`;
    csv += "DETAILED RECORDS\n";
    csv += "Type,Amount (NGN),Description,Products Used,Date\n";

    sales.forEach(r => {
      const d = String(r.description || "").replaceAll('"', '""');
      const used = (itemsBySale.get(r.id) || []).join("; ").replaceAll('"', '""');
      csv += `"Sale",${Number(r.amount) || 0},"${d}","${used}","${new Date(r.created_at).toLocaleString()}"\n`;
    });

    expenses.forEach(r => {
      const d = String(r.description || "").replaceAll('"', '""');
      csv += `"Expense",${Number(r.amount) || 0},"${d}","","${new Date(r.created_at).toLocaleString()}"\n`;
    });

    await sendMailWithAttachment({
      to,
      subject: `Finance Report (${period.toUpperCase()})`,
      text: "Attached is your finance report (summary + detailed records).",
      filename: `finance-${period}-${new Date().toISOString().split("T")[0]}.csv`,
      content: csv
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to send finance email" });
  }
});

module.exports = router;