// Backend/routes/inventory.js
const express = require("express");
const router = express.Router();

const { all, get, query, pool } = require("../db");
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
function buildInventoryCsv(rows) {
  let csv = "";
  csv += "INVENTORY REPORT\n";
  csv += `Generated On,${csvEscape(new Date().toLocaleString())}\n\n`;
  csv += "ID,Name,SKU,Unit,Qty,Reorder Level,Updated At\n";

  for (const r of rows) {
    csv += [
      csvEscape(r.id),
      csvEscape(r.name),
      csvEscape(r.sku || ""),
      csvEscape(r.unit || ""),
      csvEscape(r.qty ?? 0),
      csvEscape(r.reorder_level ?? 0),
      csvEscape(r.updated_at || "")
    ].join(",") + "\n";
  }
  return csv;
}

// GET all products
router.get("/products", async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, name, sku, unit, qty, reorder_level, updated_at
       FROM products
       ORDER BY updated_at DESC, id DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to fetch products" });
  }
});

// CREATE product + initial_qty auto Stock IN movement
router.post("/products", async (req, res) => {
  const name = cleanStr(req.body?.name);
  const sku = cleanStr(req.body?.sku);
  const unit = cleanStr(req.body?.unit || "pcs") || "pcs";
  const reorder_level = toNumber(req.body?.reorder_level, 0);
  const initial_qty = toNumber(req.body?.initial_qty, 0);

  if (!name) return res.status(400).json({ error: "Product name is required" });
  if (initial_qty < 0 || Number.isNaN(initial_qty)) {
    return res.status(400).json({ error: "initial_qty must be 0 or more" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const insert = await client.query(
      `INSERT INTO products (name, sku, unit, qty, reorder_level, updated_at)
       VALUES ($1,$2,$3,$4,$5, NOW())
       RETURNING id, name, sku, unit, qty, reorder_level, updated_at`,
      [name, sku, unit, initial_qty, reorder_level]
    );

    const product = insert.rows[0];

    if (initial_qty > 0) {
      await client.query(
        `INSERT INTO stock_movements (product_id, type, qty, note, created_at)
         VALUES ($1,'IN',$2,$3, NOW())`,
        [product.id, initial_qty, "Initial Stock IN on product creation"]
      );
    }

    await client.query("COMMIT");
    res.json(product);
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message || "Failed to create product" });
  } finally {
    client.release();
  }
});

// UPDATE product (metadata only)
router.put("/products/:id", async (req, res) => {
  try {
    const id = toNumber(req.params.id);
    const name = cleanStr(req.body?.name);
    const sku = cleanStr(req.body?.sku);
    const unit = cleanStr(req.body?.unit || "pcs") || "pcs";
    const reorder_level = toNumber(req.body?.reorder_level, 0);

    if (!name) return res.status(400).json({ error: "Product name is required" });

    const row = await get(
      `UPDATE products
       SET name=$1, sku=$2, unit=$3, reorder_level=$4, updated_at=NOW()
       WHERE id=$5
       RETURNING id, name, sku, unit, qty, reorder_level, updated_at`,
      [name, sku, unit, reorder_level, id]
    );

    if (!row) return res.status(404).json({ error: "Product not found" });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to update product" });
  }
});

// DELETE product
router.delete("/products/:id", async (req, res) => {
  try {
    const id = toNumber(req.params.id);
    const row = await get(`SELECT id FROM products WHERE id=$1`, [id]);
    if (!row) return res.status(404).json({ error: "Product not found" });

    await query(`DELETE FROM products WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to delete product" });
  }
});

// Stock move IN/OUT
router.post("/products/:id/move", async (req, res) => {
  const id = toNumber(req.params.id);
  const type = cleanStr(req.body?.type).toUpperCase(); // IN | OUT
  const qty = toNumber(req.body?.qty, 0);
  const note = cleanStr(req.body?.note);

  if (!["IN", "OUT"].includes(type)) return res.status(400).json({ error: "type must be IN or OUT" });
  if (qty <= 0) return res.status(400).json({ error: "qty must be greater than 0" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const p = await client.query(`SELECT id, qty FROM products WHERE id=$1 FOR UPDATE`, [id]);
    if (!p.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Product not found" });
    }

    const currentQty = Number(p.rows[0].qty) || 0;
    const newQty = type === "IN" ? currentQty + qty : currentQty - qty;

    if (newQty < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient stock" });
    }

    await client.query(
      `INSERT INTO stock_movements (product_id, type, qty, note, created_at)
       VALUES ($1,$2,$3,$4, NOW())`,
      [id, type, qty, note]
    );

    const updated = await client.query(
      `UPDATE products SET qty=$1, updated_at=NOW()
       WHERE id=$2
       RETURNING id, name, sku, unit, qty, reorder_level, updated_at`,
      [newQty, id]
    );

    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message || "Failed to move stock" });
  } finally {
    client.release();
  }
});

// Export inventory CSV
router.get("/export/inventory.csv", async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, name, sku, unit, qty, reorder_level, updated_at
       FROM products
       ORDER BY updated_at DESC, id DESC`
    );

    const csv = buildInventoryCsv(rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="inventory-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to export inventory CSV" });
  }
});

// Email inventory CSV
router.post("/email/inventory", async (req, res) => {
  try {
    const to = cleanStr(req.body?.to);
    if (!to) return res.status(400).json({ error: "Recipient email is required" });

    const rows = await all(
      `SELECT id, name, sku, unit, qty, reorder_level, updated_at
       FROM products
       ORDER BY updated_at DESC, id DESC`
    );

    const csv = buildInventoryCsv(rows);
    const filename = `inventory-${new Date().toISOString().slice(0,10)}.csv`;

    await sendMailWithAttachment({
      to,
      subject: "Inventory Report (CSV)",
      text: "Attached is your inventory report in CSV format.",
      filename,
      content: csv,
      contentType: "text/csv"
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to send inventory email" });
  }
});

module.exports = router;