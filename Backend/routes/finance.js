// Backend/routes/finance.js
const express = require("express");
const router = express.Router();

const { pool, query, all, get } = require("../db");
const { sendMailWithAttachment } = require("../utils/mailer");

// --------------------------
// Helpers
// --------------------------
function parsePeriod(period) {
  const p = String(period || "").toLowerCase();
  return ["daily", "weekly", "monthly", "yearly"].includes(p) ? p : "monthly";
}

function startISO(period) {
  const now = new Date();
  const s = new Date(now);

  if (period === "daily") s.setHours(0, 0, 0, 0);

  if (period === "weekly") {
    s.setDate(now.getDate() - 7);
  }

  if (period === "monthly") {
    s.setDate(1);
    s.setHours(0, 0, 0, 0);
  }

  if (period === "yearly") {
    s.setMonth(0, 1);
    s.setHours(0, 0, 0, 0);
  }

  return s.toISOString();
}

function okAmount(n) {
  return Number.isFinite(n) && n > 0;
}
function okQty(n) {
  return Number.isFinite(n) && n > 0;
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// --------------------------
// LIST SALES (with items)
// --------------------------
router.get("/sales", async (_req, res) => {
  try {
    const sales = await all(
      `SELECT id, amount, description, created_at
       FROM sales
       ORDER BY created_at DESC
       LIMIT 500`
    );

    const ids = sales.map((s) => s.id);
    let items = [];

    if (ids.length) {
      items = await all(
        `SELECT si.sale_id, si.product_id, si.qty_used,
                p.name AS product_name, p.unit AS product_unit
         FROM sale_items si
         JOIN products p ON p.id = si.product_id
         WHERE si.sale_id = ANY($1::int[])`,
        [ids]
      );
    }

    const map = new Map();
    for (const s of sales) map.set(s.id, { ...s, items: [] });

    for (const it of items) {
      const t = map.get(it.sale_id);
      if (t) {
        t.items.push({
          product_id: it.product_id,
          product_name: it.product_name,
          product_unit: it.product_unit,
          qty_used: Number(it.qty_used)
        });
      }
    }

    res.json(Array.from(map.values()));
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to fetch sales" });
  }
});

// --------------------------
// CREATE SALE + STOCK OUT per item
// --------------------------
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

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Validate + lock products
    for (const it of items) {
      const pid = Number(it.product_id);
      const qty = Number(it.qty_used);

      const pr = await client.query(
        `SELECT id, name, qty
         FROM products
         WHERE id=$1
         FOR UPDATE`,
        [pid]
      );

      if (!pr.rows[0]) throw new Error(`Product not found (ID ${pid})`);

      const currentQty = Number(pr.rows[0].qty) || 0;
      if (currentQty - qty < 0) throw new Error(`Insufficient stock for ${pr.rows[0].name}`);
    }

    // Insert sale
    const saleIns = await client.query(
      `INSERT INTO sales (amount, description, created_at)
       VALUES ($1,$2, NOW())
       RETURNING id, amount, description, created_at`,
      [amount, description]
    );

    const sale = saleIns.rows[0];
    const saleId = sale.id;

    // Insert sale items + stock movements + update products qty
    for (const it of items) {
      const pid = Number(it.product_id);
      const qty = Number(it.qty_used);

      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, qty_used)
         VALUES ($1,$2,$3)`,
        [saleId, pid, qty]
      );

      await client.query(
        `INSERT INTO stock_movements (product_id, type, qty, note, created_at)
         VALUES ($1,'OUT',$2,$3, NOW())`,
        [pid, qty, `Auto OUT for Sale #${saleId}`]
      );

      await client.query(
        `UPDATE products
         SET qty = qty - $1,
             updated_at = NOW()
         WHERE id = $2`,
        [qty, pid]
      );
    }

    // Build response sale items with product info
    const saleItems = await client.query(
      `SELECT si.product_id, si.qty_used,
              p.name AS product_name, p.unit AS product_unit
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       WHERE si.sale_id=$1`,
      [saleId]
    );

    await client.query("COMMIT");
    res.json({ ...sale, items: saleItems.rows.map(r => ({
      product_id: r.product_id,
      product_name: r.product_name,
      product_unit: r.product_unit,
      qty_used: Number(r.qty_used)
    })) });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message || "Failed to create sale" });
  } finally {
    client.release();
  }
});

// --------------------------
// UPDATE SALE (amount/description only)
// --------------------------
router.put("/sales/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const amount = Number(req.body?.amount);
    const description = String(req.body?.description || "").trim();

    if (!okAmount(amount) || !description) {
      return res.status(400).json({ error: "Valid amount and description required" });
    }

    const ex = await get(`SELECT id FROM sales WHERE id=$1`, [id]);
    if (!ex) return res.status(404).json({ error: "Sale not found" });

    const sale = await get(
      `UPDATE sales
       SET amount=$1, description=$2
       WHERE id=$3
       RETURNING id, amount, description, created_at`,
      [amount, description, id]
    );

    const saleItems = await all(
      `SELECT si.product_id, si.qty_used,
              p.name AS product_name, p.unit AS product_unit
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       WHERE si.sale_id=$1`,
      [id]
    );

    res.json({
      ...sale,
      items: saleItems.map(r => ({
        product_id: r.product_id,
        product_name: r.product_name,
        product_unit: r.product_unit,
        qty_used: Number(r.qty_used)
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to update sale" });
  }
});

// --------------------------
// DELETE SALE (revert stock for each item)
// --------------------------
router.delete("/sales/:id", async (req, res) => {
  const id = Number(req.params.id);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const sale = await client.query(`SELECT id FROM sales WHERE id=$1`, [id]);
    if (!sale.rows[0]) throw new Error("Sale not found");

    const items = await client.query(
      `SELECT product_id, qty_used
       FROM sale_items
       WHERE sale_id=$1`,
      [id]
    );

    // revert stock
    for (const it of items.rows) {
      const pid = Number(it.product_id);
      const qty = Number(it.qty_used);

      await client.query(
        `INSERT INTO stock_movements (product_id, type, qty, note, created_at)
         VALUES ($1,'IN',$2,$3, NOW())`,
        [pid, qty, `Revert IN for deleted Sale #${id}`]
      );

      await client.query(
        `UPDATE products
         SET qty = qty + $1,
             updated_at = NOW()
         WHERE id = $2`,
        [qty, pid]
      );
    }

    await client.query(`DELETE FROM sales WHERE id=$1`, [id]); // cascades sale_items
    await client.query("COMMIT");

    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message || "Failed to delete sale" });
  } finally {
    client.release();
  }
});

// --------------------------
// EXPENSES
// --------------------------
router.get("/expenses", async (_req, res) => {
  try {
    const rows = await all(
      `SELECT id, amount, description, created_at
       FROM expenses
       ORDER BY created_at DESC
       LIMIT 500`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to fetch expenses" });
  }
});

router.post("/expenses", async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    const description = String(req.body?.description || "").trim();

    if (!okAmount(amount) || !description) {
      return res.status(400).json({ error: "Valid amount and description required" });
    }

    const row = await get(
      `INSERT INTO expenses (amount, description, created_at)
       VALUES ($1,$2, NOW())
       RETURNING id, amount, description, created_at`,
      [amount, description]
    );

    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to create expense" });
  }
});

router.put("/expenses/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const amount = Number(req.body?.amount);
    const description = String(req.body?.description || "").trim();

    if (!okAmount(amount) || !description) {
      return res.status(400).json({ error: "Valid amount and description required" });
    }

    const ex = await get(`SELECT id FROM expenses WHERE id=$1`, [id]);
    if (!ex) return res.status(404).json({ error: "Expense not found" });

    const row = await get(
      `UPDATE expenses
       SET amount=$1, description=$2
       WHERE id=$3
       RETURNING id, amount, description, created_at`,
      [amount, description, id]
    );

    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to update expense" });
  }
});

router.delete("/expenses/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await query(`DELETE FROM expenses WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to delete expense" });
  }
});

// --------------------------
// REPORT
// --------------------------
router.get("/report", async (req, res) => {
  try {
    const period = parsePeriod(req.query.period);
    const from = startISO(period);

    const s = await all(`SELECT amount FROM sales WHERE created_at >= $1`, [from]);
    const e = await all(`SELECT amount FROM expenses WHERE created_at >= $1`, [from]);

    const totalSales = s.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const totalExpenses = e.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const profit = totalSales - totalExpenses;

    res.json({ period, from, totals: { totalSales, totalExpenses, profit } });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to generate report" });
  }
});

// --------------------------
// EXPORT CSV (includes Products Used)
// --------------------------
router.get("/export/finance.csv", async (req, res) => {
  try {
    const period = parsePeriod(req.query.period);
    const from = startISO(period);

    const sales = await all(
      `SELECT id, amount, description, created_at
       FROM sales
       WHERE created_at >= $1
       ORDER BY created_at DESC`,
      [from]
    );

    const ids = sales.map((s) => s.id);
    let items = [];
    if (ids.length) {
      items = await all(
        `SELECT si.sale_id, si.qty_used, p.name AS product_name
         FROM sale_items si
         JOIN products p ON p.id = si.product_id
         WHERE si.sale_id = ANY($1::int[])`,
        [ids]
      );
    }

    const itemsBySale = new Map();
    for (const it of items) {
      const arr = itemsBySale.get(it.sale_id) || [];
      arr.push(`${it.product_name} x${Number(it.qty_used)}`);
      itemsBySale.set(it.sale_id, arr);
    }

    const expenses = await all(
      `SELECT amount, description, created_at
       FROM expenses
       WHERE created_at >= $1
       ORDER BY created_at DESC`,
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

    for (const r of sales) {
      const d = csvEscape(r.description || "");
      const used = csvEscape((itemsBySale.get(r.id) || []).join("; "));
      csv += `"Sale",${Number(r.amount) || 0},${d},${used},${csvEscape(new Date(r.created_at).toLocaleString())}\n`;
    }

    for (const r of expenses) {
      const d = csvEscape(r.description || "");
      csv += `"Expense",${Number(r.amount) || 0},${d},"",${csvEscape(new Date(r.created_at).toLocaleString())}\n`;
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=finance-${period}.csv`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to export finance CSV" });
  }
});

// --------------------------
// EMAIL FINANCE CSV
// --------------------------
router.post("/email/finance", async (req, res) => {
  try {
    const to = String(req.body?.to || "").trim();
    const period = parsePeriod(req.body?.period);
    if (!to) return res.status(400).json({ error: "Recipient email is required" });

    const from = startISO(period);

    const sales = await all(
      `SELECT id, amount, description, created_at
       FROM sales
       WHERE created_at >= $1
       ORDER BY created_at DESC`,
      [from]
    );

    const ids = sales.map((s) => s.id);
    let items = [];
    if (ids.length) {
      items = await all(
        `SELECT si.sale_id, si.qty_used, p.name AS product_name
         FROM sale_items si
         JOIN products p ON p.id = si.product_id
         WHERE si.sale_id = ANY($1::int[])`,
        [ids]
      );
    }

    const itemsBySale = new Map();
    for (const it of items) {
      const arr = itemsBySale.get(it.sale_id) || [];
      arr.push(`${it.product_name} x${Number(it.qty_used)}`);
      itemsBySale.set(it.sale_id, arr);
    }

    const expenses = await all(
      `SELECT amount, description, created_at
       FROM expenses
       WHERE created_at >= $1
       ORDER BY created_at DESC`,
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

    for (const r of sales) {
      const d = csvEscape(r.description || "");
      const used = csvEscape((itemsBySale.get(r.id) || []).join("; "));
      csv += `"Sale",${Number(r.amount) || 0},${d},${used},${csvEscape(new Date(r.created_at).toLocaleString())}\n`;
    }

    for (const r of expenses) {
      const d = csvEscape(r.description || "");
      csv += `"Expense",${Number(r.amount) || 0},${d},"",${csvEscape(new Date(r.created_at).toLocaleString())}\n`;
    }

    await sendMailWithAttachment({
      to,
      subject: `Finance Report (${period.toUpperCase()})`,
      text: "Attached is your finance report (summary + detailed records).",
      filename: `finance-${period}-${new Date().toISOString().split("T")[0]}.csv`,
      content: csv,
      contentType: "text/csv"
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to send finance email" });
  }
});

module.exports = router;