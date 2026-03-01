// Backend/routes/finance.js
const express = require("express");
const router = express.Router();
const { pool, all, get, query } = require("../db");
const { sendMailWithAttachment } = require("../utils/mailer");

// -------------------- helpers --------------------
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
function dateOnlyIso(d) {
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// Admin lock (for destructive ops like reset)
function requireAdmin(req, res, next) {
  const provided = cleanStr(req.headers["x-admin-key"] || req.query.admin_key || "");
  const expected = cleanStr(process.env.ADMIN_KEY || "");
  if (!expected) return res.status(500).json({ error: "ADMIN_KEY not set on server" });
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: "Unauthorized (admin key required)" });
  }
  next();
}

// -------------------- schema alignment (safe) --------------------
// ensures finance tables exist + compatibility names (if you had older names)
async function ensureFinanceSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      amount NUMERIC NOT NULL,
      description TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id INT NOT NULL REFERENCES products(id),
      qty_used NUMERIC NOT NULL
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      amount NUMERIC NOT NULL,
      description TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Compatibility view (some older code used "items" or other naming)
  // harmless if unused
  await query(`DROP VIEW IF EXISTS sales_items;`);
  await query(`CREATE VIEW sales_items AS SELECT * FROM sale_items;`);
}

let _schemaReady = false;
async function ready(req, res, next) {
  try {
    if (!_schemaReady) {
      await ensureFinanceSchema();
      _schemaReady = true;
    }
    next();
  } catch (e) {
    console.error("Finance schema ensure failed:", e);
    res.status(500).json({ error: "Finance schema not ready" });
  }
}

router.use(ready);

// -------------------- period helpers --------------------
function periodWhere(period) {
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

// -------------------- sales + items fetch --------------------
async function fetchSalesWithItems(whereSql) {
  const sales = await all(
    `SELECT id, amount, description, created_at
     FROM sales
     ${whereSql ? `WHERE ${whereSql}` : ""}
     ORDER BY created_at DESC, id DESC`
  );

  if (!sales.length) return [];

  const ids = sales.map((s) => s.id);

  // LEFT JOIN so even if product was soft-deleted (is_active=false), report still works
  const items = await all(
    `SELECT
       si.sale_id,
       si.product_id,
       si.qty_used,
       p.name as product_name,
       p.unit as product_unit
     FROM sale_items si
     LEFT JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ANY($1::int[])`,
    [ids]
  );

  const map = new Map();
  for (const s of sales) map.set(s.id, { ...s, items: [] });

  for (const it of items) {
    const row = map.get(it.sale_id);
    if (!row) continue;
    row.items.push({
      product_id: it.product_id,
      qty_used: Number(it.qty_used),
      product_name: it.product_name || `Product #${it.product_id}`,
      product_unit: it.product_unit || ""
    });
  }

  return Array.from(map.values());
}

// =====================================================
// SALES
// =====================================================
router.get("/sales", async (req, res) => {
  try {
    const rows = await fetchSalesWithItems(null);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to fetch sales" });
  }
});

// Create sale + auto stock-out + stock movement
router.post("/sales", async (req, res) => {
  const amount = toNumber(req.body?.amount, 0);
  const description = cleanStr(req.body?.description);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (amount <= 0) return res.status(400).json({ error: "amount must be > 0" });
  if (!description) return res.status(400).json({ error: "description is required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // validate items (can be empty if you want to log sales without stock usage)
    for (const it of items) {
      const pid = toNumber(it.product_id);
      const qtyUsed = toNumber(it.qty_used);
      if (!pid || qtyUsed <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Invalid sale items" });
      }

      const p = await client.query(
        `SELECT id, qty, is_active FROM products WHERE id=$1 FOR UPDATE`,
        [pid]
      );
      if (!p.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: `Product not found: ${pid}` });
      }
      if (p.rows[0].is_active === false) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Product is inactive: ${pid}` });
      }

      const currentQty = Number(p.rows[0].qty) || 0;
      if (currentQty - qtyUsed < 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Insufficient stock for product ${pid}` });
      }

      const newQty = currentQty - qtyUsed;

      // movement OUT
      await client.query(
        `INSERT INTO stock_movements (product_id, type, qty, reason, note, created_at)
         VALUES ($1,'OUT',$2,$3,$4, NOW())`,
        [pid, qtyUsed, "SALE", `Auto stock-out from sale: ${description}`]
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

    const full = await fetchSalesWithItems(`id = ${sale.id}`);
    res.json(full[0] || sale);
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message || "Failed to create sale" });
  } finally {
    client.release();
  }
});

// Update sale metadata only (does NOT change items/stock)
router.put("/sales/:id", async (req, res) => {
  try {
    const id = toNumber(req.params.id);
    const amount = toNumber(req.body?.amount, 0);
    const description = cleanStr(req.body?.description);

    if (!id) return res.status(400).json({ error: "Invalid sale id" });
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
    res.json(full[0] || row);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to update sale" });
  }
});

// Delete sale (SAFE): restore stock back + movement IN
router.delete("/sales/:id", async (req, res) => {
  const id = toNumber(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid sale id" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sale = await client.query(`SELECT id, description FROM sales WHERE id=$1`, [id]);
    if (!sale.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Sale not found" });
    }
    const saleDesc = sale.rows[0].description;

    const items = await client.query(
      `SELECT product_id, qty_used FROM sale_items WHERE sale_id=$1`,
      [id]
    );

    for (const it of items.rows) {
      const pid = Number(it.product_id);
      const qtyUsed = Number(it.qty_used);

      // restore qty (even if product is inactive, we still restore stock number)
      const p = await client.query(`SELECT id, qty FROM products WHERE id=$1 FOR UPDATE`, [pid]);
      if (p.rows[0]) {
        const currentQty = Number(p.rows[0].qty) || 0;
        const newQty = currentQty + qtyUsed;

        await client.query(
          `INSERT INTO stock_movements (product_id, type, qty, reason, note, created_at)
           VALUES ($1,'IN',$2,$3,$4, NOW())`,
          [pid, qtyUsed, "SALE_RESTORE", `Restore stock from deleted sale: ${saleDesc}`]
        );

        await client.query(`UPDATE products SET qty=$1, updated_at=NOW() WHERE id=$2`, [newQty, pid]);
      }
    }

    await client.query(`DELETE FROM sales WHERE id=$1`, [id]); // cascades sale_items
    await client.query("COMMIT");

    res.json({ ok: true, restored: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message || "Failed to delete sale" });
  } finally {
    client.release();
  }
});

// =====================================================
// EXPENSES
// =====================================================
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

    if (!id) return res.status(400).json({ error: "Invalid expense id" });
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
    if (!id) return res.status(400).json({ error: "Invalid expense id" });

    const row = await get(`SELECT id FROM expenses WHERE id=$1`, [id]);
    if (!row) return res.status(404).json({ error: "Expense not found" });

    await query(`DELETE FROM expenses WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to delete expense" });
  }
});

// =====================================================
// REPORTS + EXPORT + EMAIL
// =====================================================
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

function buildFinanceCsv({ period, sales, expenses }) {
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
      .map(
        (it) =>
          `${it.product_name} x${it.qty_used}${it.product_unit ? " " + it.product_unit : ""}`
      )
      .join("; ");
    csv += `Sale,${s.amount},${csvEscape(s.description)},${csvEscape(used)},${csvEscape(
      new Date(s.created_at).toLocaleString()
    )}\n`;
  }

  for (const e of expenses) {
    csv += `Expense,${e.amount},${csvEscape(e.description)},,${csvEscape(
      new Date(e.created_at).toLocaleString()
    )}\n`;
  }

  return { csv, totalSales, totalExpenses, profit };
}

// Export finance CSV
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

    const { csv } = buildFinanceCsv({ period, sales, expenses });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="finance-${period}-${dateOnlyIso(new Date())}.csv"`
    );
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to export finance CSV" });
  }
});

// Email finance CSV (SMTP)
router.post("/email/finance", async (req, res) => {
  try {
    const to = cleanStr(req.body?.to);
    const period = cleanStr(req.body?.period).toLowerCase();
    const where = periodWhere(period);

    if (!to) return res.status(400).json({ error: "Recipient email is required" });
    if (!where) return res.status(400).json({ error: "Invalid period" });

    const sales = await fetchSalesWithItems(where);
    const expenses = await all(
      `SELECT id, amount, description, created_at FROM expenses
       WHERE ${where}
       ORDER BY created_at DESC, id DESC`
    );

    const { csv } = buildFinanceCsv({ period, sales, expenses });
    const filename = `finance-${period}-${dateOnlyIso(new Date())}.csv`;

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

// =====================================================
// ADMIN: RESET DATABASE (TEST DATA WIPE)
// This matches your request: lock deletes safely + reset button support
// =====================================================
// IMPORTANT: you must call this with header: x-admin-key: <ADMIN_KEY>
// Example: POST /api/finance/admin/reset
router.post("/admin/reset", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // delete in FK-safe order
    await client.query(`DELETE FROM sale_items;`);
    await client.query(`DELETE FROM sales;`);
    await client.query(`DELETE FROM expenses;`);

    // inventory side (in case you want full reset from finance button)
    // If you want finance-only reset, comment these out.
    await client.query(`DELETE FROM losses;`);
    await client.query(`DELETE FROM stock_movements;`);

    // keep products but reset qty + reactivate (you can change this behavior)
    await client.query(`UPDATE products SET qty=0, is_active=TRUE, updated_at=NOW();`);

    await client.query("COMMIT");
    res.json({ ok: true, reset: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message || "Reset failed" });
  } finally {
    client.release();
  }
});

module.exports = router;