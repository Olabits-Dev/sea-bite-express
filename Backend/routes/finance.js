// Backend/routes/finance.js
const express = require("express");
const router = express.Router();
const { pool, all, get, query } = require("../db");
const { sendMailWithAttachment } = require("../utils/mailer");

function cleanStr(v, fallback = "") {
  return String(v ?? fallback).trim();
}
function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function periodWhere(period) {
  // created_at is timestamp
  switch (period) {
    case "daily":
      return `created_at >= NOW() - INTERVAL '1 day'`;
    case "weekly":
      return `created_at >= NOW() - INTERVAL '7 days'`;
    case "monthly":
      return `date_trunc('month', created_at) = date_trunc('month', NOW())`;
    case "yearly":
      return `date_trunc('year', created_at) = date_trunc('year', NOW())`;
    default:
      return null;
  }
}

async function fetchSalesWithItems(whereSql) {
  const sales = await all(
    `SELECT id, amount, description, created_at
     FROM sales
     ${whereSql ? `WHERE ${whereSql}` : ""}
     ORDER BY created_at DESC, id DESC`
  );

  if (!sales.length) return [];

  const ids = sales.map(s => s.id);
  const items = await all(
    `SELECT si.sale_id, si.product_id, si.qty_used, p.name as product_name, p.unit as product_unit
     FROM sale_items si
     JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ANY($1::int[])`,
    [ids]
  );

  const map = new Map();
  for (const s of sales) map.set(s.id, { ...s, items: [] });
  for (const it of items) {
    map.get(it.sale_id)?.items.push({
      product_id: it.product_id,
      qty_used: Number(it.qty_used),
      product_name: it.product_name,
      product_unit: it.product_unit
    });
  }

  return Array.from(map.values());
}

// ---- Sales ----
router.get("/sales", async (req, res) => {
  try {
    const rows = await fetchSalesWithItems(null);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to fetch sales" });
  }
});

router.post("/sales", async (req, res) => {
  const amount = toNumber(req.body?.amount, 0);
  const description = cleanStr(req.body?.description);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (amount <= 0) return res.status(400).json({ error: "amount must be > 0" });
  if (!description) return res.status(400).json({ error: "description is required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // lock products for stock-out
    for (const it of items) {
      const pid = toNumber(it.product_id);
      const qtyUsed = toNumber(it.qty_used);
      if (!pid || qtyUsed <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Invalid sale items" });
      }

      const p = await client.query(`SELECT id, qty FROM products WHERE id=$1 FOR UPDATE`, [pid]);
      if (!p.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: `Product not found: ${pid}` });
      }

      const currentQty = Number(p.rows[0].qty) || 0;
      if (currentQty - qtyUsed < 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Insufficient stock for product ${pid}` });
      }

      const newQty = currentQty - qtyUsed;

      // record movement + update qty
      await client.query(
        `INSERT INTO stock_movements (product_id, type, qty, note, created_at)
         VALUES ($1,'OUT',$2,$3, NOW())`,
        [pid, qtyUsed, `Auto stock-out from sale: ${description}`]
      );

      await client.query(`UPDATE products SET qty=$1, updated_at=NOW() WHERE id=$2`, [newQty, pid]);
    }

    // create sale
    const saleIns = await client.query(
      `INSERT INTO sales (amount, description, created_at)
       VALUES ($1,$2, NOW())
       RETURNING id, amount, description, created_at`,
      [amount, description]
    );

    const sale = saleIns.rows[0];

    // create sale items
    for (const it of items) {
      const pid = toNumber(it.product_id);
      const qtyUsed = toNumber(it.qty_used);
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, qty_used)
         VALUES ($1,$2,$3)`,
        [sale.id, pid, qtyUsed]
      );
    }

    await client.query("COMMIT");

    // return with items
    const full = await fetchSalesWithItems(`id = ${sale.id}`);
    res.json(full[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message || "Failed to create sale" });
  } finally {
    client.release();
  }
});

router.put("/sales/:id", async (req, res) => {
  try {
    const id = toNumber(req.params.id);
    const amount = toNumber(req.body?.amount, 0);
    const description = cleanStr(req.body?.description);

    if (amount <= 0) return res.status(400).json({ error: "amount must be > 0" });
    if (!description) return res.status(400).json({ error: "description is required" });

    const row = await get(
      `UPDATE sales
       SET amount=$1, description=$2
       WHERE id=$3
       RETURNING id, amount, description, created_at`,
      [amount, description, id]
    );

    if (!row) return res.status(404).json({ error: "Sale not found" });

    const full = await fetchSalesWithItems(`id = ${id}`);
    res.json(full[0]);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to update sale" });
  }
});

// Delete sale: restore stock back (reverse OUT movements using sale_items)
router.delete("/sales/:id", async (req, res) => {
  const id = toNumber(req.params.id);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const sale = await client.query(`SELECT id, description FROM sales WHERE id=$1`, [id]);
    if (!sale.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Sale not found" });
    }

    const items = await client.query(
      `SELECT product_id, qty_used FROM sale_items WHERE sale_id=$1`,
      [id]
    );

    // restore qty
    for (const it of items.rows) {
      const pid = Number(it.product_id);
      const qtyUsed = Number(it.qty_used);

      const p = await client.query(`SELECT id, qty FROM products WHERE id=$1 FOR UPDATE`, [pid]);
      if (p.rows[0]) {
        const currentQty = Number(p.rows[0].qty) || 0;
        const newQty = currentQty + qtyUsed;

        await client.query(
          `INSERT INTO stock_movements (product_id, type, qty, note, created_at)
           VALUES ($1,'IN',$2,$3, NOW())`,
          [pid, qtyUsed, `Restore stock from deleted sale: ${sale.rows[0].description}`]
        );

        await client.query(`UPDATE products SET qty=$1, updated_at=NOW() WHERE id=$2`, [newQty, pid]);
      }
    }

    // delete sale (cascades sale_items)
    await client.query(`DELETE FROM sales WHERE id=$1`, [id]);

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message || "Failed to delete sale" });
  } finally {
    client.release();
  }
});

// ---- Expenses ----
router.get("/expenses", async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, amount, description, created_at
       FROM expenses
       ORDER BY created_at DESC, id DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to fetch expenses" });
  }
});

router.post("/expenses", async (req, res) => {
  try {
    const amount = toNumber(req.body?.amount, 0);
    const description = cleanStr(req.body?.description);

    if (amount <= 0) return res.status(400).json({ error: "amount must be > 0" });
    if (!description) return res.status(400).json({ error: "description is required" });

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
    const id = toNumber(req.params.id);
    const amount = toNumber(req.body?.amount, 0);
    const description = cleanStr(req.body?.description);

    if (amount <= 0) return res.status(400).json({ error: "amount must be > 0" });
    if (!description) return res.status(400).json({ error: "description is required" });

    const row = await get(
      `UPDATE expenses
       SET amount=$1, description=$2
       WHERE id=$3
       RETURNING id, amount, description, created_at`,
      [amount, description, id]
    );

    if (!row) return res.status(404).json({ error: "Expense not found" });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to update expense" });
  }
});

router.delete("/expenses/:id", async (req, res) => {
  try {
    const id = toNumber(req.params.id);
    const row = await get(`SELECT id FROM expenses WHERE id=$1`, [id]);
    if (!row) return res.status(404).json({ error: "Expense not found" });

    await query(`DELETE FROM expenses WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to delete expense" });
  }
});

// ---- Reports ----
router.get("/report", async (req, res) => {
  try {
    const period = cleanStr(req.query?.period).toLowerCase();
    const where = periodWhere(period);
    if (!where) return res.status(400).json({ error: "Invalid period" });

    const salesSum = await get(`SELECT COALESCE(SUM(amount),0) AS total FROM sales WHERE ${where}`);
    const expSum = await get(`SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE ${where}`);

    const totalSales = Number(salesSum.total) || 0;
    const totalExpenses = Number(expSum.total) || 0;

    res.json({
      period,
      totals: {
        totalSales,
        totalExpenses,
        profit: totalSales - totalExpenses
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to generate report" });
  }
});

// Export finance CSV (summary + detailed)
router.get("/export/finance.csv", async (req, res) => {
  try {
    const period = cleanStr(req.query?.period).toLowerCase();
    const where = periodWhere(period);
    if (!where) return res.status(400).json({ error: "Invalid period" });

    const sales = await fetchSalesWithItems(where);
    const expenses = await all(
      `SELECT id, amount, description, created_at FROM expenses
       WHERE ${where}
       ORDER BY created_at DESC, id DESC`
    );

    const totalSales = sales.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const totalExpenses = expenses.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const profit = totalSales - totalExpenses;

    let csv = "";
    csv += "BUSINESS REPORT\n";
    csv += `Report Type,${csvEscape(period.toUpperCase())}\n`;
    csv += `Generated On,${csvEscape(new Date().toLocaleString())}\n\n`;

    csv += "SUMMARY\n";
    csv += "Total Sales (NGN),Total Expenses (NGN),Profit (NGN)\n";
    csv += `${totalSales},${totalExpenses},${profit}\n\n`;

    csv += "DETAILED RECORDS\n";
    csv += "Type,Amount (NGN),Description,Products Used,Date\n";

    for (const s of sales) {
      const used = (s.items || [])
        .map(it => `${it.product_name} x${it.qty_used}${it.product_unit ? " " + it.product_unit : ""}`)
        .join("; ");
      csv += `Sale,${s.amount},${csvEscape(s.description)},${csvEscape(used)},${csvEscape(new Date(s.created_at).toLocaleString())}\n`;
    }

    for (const e of expenses) {
      csv += `Expense,${e.amount},${csvEscape(e.description)},,${csvEscape(new Date(e.created_at).toLocaleString())}\n`;
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="finance-${period}-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to export finance CSV" });
  }
});

// Email finance CSV
router.post("/email/finance", async (req, res) => {
  try {
    const to = cleanStr(req.body?.to);
    const period = cleanStr(req.body?.period).toLowerCase();
    const where = periodWhere(period);

    if (!to) return res.status(400).json({ error: "Recipient email is required" });
    if (!where) return res.status(400).json({ error: "Invalid period" });

    // reuse export logic to build CSV
    const sales = await fetchSalesWithItems(where);
    const expenses = await all(
      `SELECT id, amount, description, created_at FROM expenses
       WHERE ${where}
       ORDER BY created_at DESC, id DESC`
    );

    const totalSales = sales.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const totalExpenses = expenses.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const profit = totalSales - totalExpenses;

    let csv = "";
    csv += "BUSINESS REPORT\n";
    csv += `Report Type,${csvEscape(period.toUpperCase())}\n`;
    csv += `Generated On,${csvEscape(new Date().toLocaleString())}\n\n`;
    csv += "SUMMARY\n";
    csv += "Total Sales (NGN),Total Expenses (NGN),Profit (NGN)\n";
    csv += `${totalSales},${totalExpenses},${profit}\n\n`;
    csv += "DETAILED RECORDS\n";
    csv += "Type,Amount (NGN),Description,Products Used,Date\n";

    for (const s of sales) {
      const used = (s.items || [])
        .map(it => `${it.product_name} x${it.qty_used}${it.product_unit ? " " + it.product_unit : ""}`)
        .join("; ");
      csv += `Sale,${s.amount},${csvEscape(s.description)},${csvEscape(used)},${csvEscape(new Date(s.created_at).toLocaleString())}\n`;
    }

    for (const e of expenses) {
      csv += `Expense,${e.amount},${csvEscape(e.description)},,${csvEscape(new Date(e.created_at).toLocaleString())}\n`;
    }

    const filename = `finance-${period}-${new Date().toISOString().slice(0,10)}.csv`;

    await sendMailWithAttachment({
      to,
      subject: "Finance Report (CSV)",
      text: "Attached is your finance report in CSV format.",
      filename,
      content: csv,
      contentType: "text/csv"
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to send finance email" });
  }
});

module.exports = router;