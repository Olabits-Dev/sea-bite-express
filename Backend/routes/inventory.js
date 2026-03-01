// Backend/routes/inventory.js
const express = require("express");
const router = express.Router();

const { all, get, query, pool } = require("../db");
const { sendMailWithAttachment } = require("../utils/mailer");

function cleanStr(v, fallback = "") { return String(v ?? fallback).trim(); }
function toNumber(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

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

function buildLossCsv(rows) {
  let csv = "";
  csv += "LOSS HISTORY REPORT\n";
  csv += `Generated On,${csvEscape(new Date().toLocaleString())}\n\n`;
  csv += "Loss ID,Product ID,Product,Unit,Qty Lost,Reason,Note,Date\n";

  for (const r of rows) {
    csv += [
      csvEscape(r.id),
      csvEscape(r.product_id),
      csvEscape(r.product_name),
      csvEscape(r.product_unit || ""),
      csvEscape(r.qty),
      csvEscape(r.reason),
      csvEscape(r.note || ""),
      csvEscape(r.created_at || "")
    ].join(",") + "\n";
  }
  return csv;
}

/** ---------------------------
 * PRODUCTS
 * --------------------------*/

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

// CREATE product + initial_qty auto stock-in
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
        `INSERT INTO stock_movements (product_id, type, qty, reason, note, created_at)
         VALUES ($1,'IN',$2,$3,$4, NOW())`,
        [product.id, initial_qty, "INITIAL", "Initial Stock IN on product creation"]
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

// UPDATE product metadata
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

// Stock move IN/OUT (manual)
router.post("/products/:id/move", async (req, res) => {
  const id = toNumber(req.params.id);
  const type = cleanStr(req.body?.type).toUpperCase();
  const qty = toNumber(req.body?.qty, 0);
  const note = cleanStr(req.body?.note);
  const reason = cleanStr(req.body?.reason || (type === "IN" ? "MANUAL_IN" : "MANUAL_OUT"));

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
      `INSERT INTO stock_movements (product_id, type, qty, reason, note, created_at)
       VALUES ($1,$2,$3,$4,$5, NOW())`,
      [id, type, qty, reason, note]
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

// record inventory loss (spoilage/mishandling) = stock OUT with reason
router.post("/products/:id/loss", async (req, res) => {
  const id = toNumber(req.params.id);
  const qty = toNumber(req.body?.qty, 0);
  const reason = cleanStr(req.body?.reason).toUpperCase(); // SPOILAGE | MISHANDLING
  const note = cleanStr(req.body?.note);

  if (!["SPOILAGE", "MISHANDLING"].includes(reason)) {
    return res.status(400).json({ error: "reason must be SPOILAGE or MISHANDLING" });
  }
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
    const newQty = currentQty - qty;
    if (newQty < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient stock" });
    }

    const ins = await client.query(
      `INSERT INTO stock_movements (product_id, type, qty, reason, note, created_at)
       VALUES ($1,'OUT',$2,$3,$4, NOW())
       RETURNING id, product_id, type, qty, reason, note, created_at`,
      [id, qty, reason, note]
    );

    const updated = await client.query(
      `UPDATE products SET qty=$1, updated_at=NOW()
       WHERE id=$2
       RETURNING id, name, sku, unit, qty, reorder_level, updated_at`,
      [newQty, id]
    );

    await client.query("COMMIT");
    res.json({ ok: true, loss: ins.rows[0], updated: updated.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message || "Failed to record loss" });
  } finally {
    client.release();
  }
});

/** ---------------------------
 * LOSS HISTORY (NEW)
 * --------------------------*/

// List loss history (from stock_movements)
router.get("/losses", async (req, res) => {
  try {
    const rows = await all(
      `SELECT sm.id, sm.product_id, p.name AS product_name, p.unit AS product_unit,
              sm.qty, sm.reason, sm.note, sm.created_at
       FROM stock_movements sm
       JOIN products p ON p.id = sm.product_id
       WHERE sm.type='OUT' AND sm.reason IN ('SPOILAGE','MISHANDLING')
       ORDER BY sm.created_at DESC, sm.id DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to fetch losses" });
  }
});

// Edit loss record (adjust product qty safely)
router.put("/losses/:id", async (req, res) => {
  const lossId = toNumber(req.params.id);
  const qtyNew = toNumber(req.body?.qty, 0);
  const reasonNew = cleanStr(req.body?.reason).toUpperCase();
  const noteNew = cleanStr(req.body?.note);

  if (!lossId) return res.status(400).json({ error: "Invalid loss id" });
  if (!["SPOILAGE", "MISHANDLING"].includes(reasonNew)) {
    return res.status(400).json({ error: "reason must be SPOILAGE or MISHANDLING" });
  }
  if (qtyNew <= 0) return res.status(400).json({ error: "qty must be greater than 0" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // lock loss row
    const lossRes = await client.query(
      `SELECT id, product_id, qty, reason
       FROM stock_movements
       WHERE id=$1 AND type='OUT' AND reason IN ('SPOILAGE','MISHANDLING')
       FOR UPDATE`,
      [lossId]
    );
    const loss = lossRes.rows[0];
    if (!loss) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Loss record not found" });
    }

    const productId = Number(loss.product_id);
    const qtyOld = Number(loss.qty) || 0;

    // lock product
    const pRes = await client.query(`SELECT id, qty FROM products WHERE id=$1 FOR UPDATE`, [productId]);
    const p = pRes.rows[0];
    if (!p) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Product not found for this loss" });
    }

    const currentQty = Number(p.qty) || 0;
    const delta = qtyNew - qtyOld; // + means increasing loss (more stock out)

    if (delta > 0 && currentQty - delta < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient stock to increase loss qty" });
    }

    // adjust product qty: loss reduces stock, so increasing loss reduces product qty more
    const newProductQty = currentQty - delta;
    await client.query(`UPDATE products SET qty=$1, updated_at=NOW() WHERE id=$2`, [newProductQty, productId]);

    // update loss row
    const upd = await client.query(
      `UPDATE stock_movements
       SET qty=$1, reason=$2, note=$3
       WHERE id=$4
       RETURNING id, product_id, type, qty, reason, note, created_at`,
      [qtyNew, reasonNew, noteNew, lossId]
    );

    await client.query("COMMIT");
    res.json({ ok: true, loss: upd.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message || "Failed to update loss record" });
  } finally {
    client.release();
  }
});

// Delete loss record (restore product qty safely)
router.delete("/losses/:id", async (req, res) => {
  const lossId = toNumber(req.params.id);
  if (!lossId) return res.status(400).json({ error: "Invalid loss id" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const lossRes = await client.query(
      `SELECT id, product_id, qty
       FROM stock_movements
       WHERE id=$1 AND type='OUT' AND reason IN ('SPOILAGE','MISHANDLING')
       FOR UPDATE`,
      [lossId]
    );
    const loss = lossRes.rows[0];
    if (!loss) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Loss record not found" });
    }

    const productId = Number(loss.product_id);
    const qtyOld = Number(loss.qty) || 0;

    const pRes = await client.query(`SELECT id, qty FROM products WHERE id=$1 FOR UPDATE`, [productId]);
    const p = pRes.rows[0];
    if (!p) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Product not found for this loss" });
    }

    const currentQty = Number(p.qty) || 0;
    const restoredQty = currentQty + qtyOld;

    await client.query(`UPDATE products SET qty=$1, updated_at=NOW() WHERE id=$2`, [restoredQty, productId]);
    await client.query(`DELETE FROM stock_movements WHERE id=$1`, [lossId]);

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message || "Failed to delete loss record" });
  } finally {
    client.release();
  }
});

// Export loss history CSV (NEW)
router.get("/export/losses.csv", async (req, res) => {
  try {
    const rows = await all(
      `SELECT sm.id, sm.product_id, p.name AS product_name, p.unit AS product_unit,
              sm.qty, sm.reason, sm.note, sm.created_at
       FROM stock_movements sm
       JOIN products p ON p.id = sm.product_id
       WHERE sm.type='OUT' AND sm.reason IN ('SPOILAGE','MISHANDLING')
       ORDER BY sm.created_at DESC, sm.id DESC`
    );

    const csv = buildLossCsv(rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="loss-history-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to export loss history CSV" });
  }
});

/** ---------------------------
 * EXPORT / EMAIL INVENTORY
 * --------------------------*/

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

// Email inventory CSV (SMTP)
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