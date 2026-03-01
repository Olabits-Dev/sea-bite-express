// Backend/routes/inventory.js
const express = require("express");
const router = express.Router();

const { all, get, query, pool } = require("../db");
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
function toIsoDateOnly(d) {
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// Admin lock (for destructive ops like reset/hard delete)
function requireAdmin(req, res, next) {
  const provided = cleanStr(req.headers["x-admin-key"] || req.query.admin_key || "");
  const expected = cleanStr(process.env.ADMIN_KEY || "");
  if (!expected) {
    return res.status(500).json({ error: "ADMIN_KEY not set on server" });
  }
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: "Unauthorized (admin key required)" });
  }
  next();
}

// -------------------- schema alignment (safe) --------------------
async function ensureSchema() {
  // Make sure core tables/columns exist in Postgres (safe for repeated runs)
  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      sku TEXT DEFAULT '',
      unit TEXT DEFAULT 'pcs',
      qty NUMERIC DEFAULT 0,
      reorder_level NUMERIC DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Soft-delete support (prevents FK delete issues)
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='products' AND column_name='is_active'
      ) THEN
        ALTER TABLE products ADD COLUMN is_active BOOLEAN DEFAULT TRUE;
      END IF;
    END $$;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('IN','OUT')),
      qty NUMERIC NOT NULL,
      reason TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS losses (
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES products(id),
      qty NUMERIC NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('SPOILAGE','MISHANDLING')),
      note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Compatibility views (keep old frontend working)
  await query(`DROP VIEW IF EXISTS inventory_moves;`);
  await query(`CREATE VIEW inventory_moves AS SELECT * FROM stock_movements;`);

  await query(`DROP VIEW IF EXISTS inventory_losses;`);
  await query(`CREATE VIEW inventory_losses AS SELECT * FROM losses;`);
}

// Run once at startup (non-blocking-ish but awaited here to be safe)
let _schemaReady = false;
async function ready(req, res, next) {
  try {
    if (!_schemaReady) {
      await ensureSchema();
      _schemaReady = true;
    }
    next();
  } catch (e) {
    console.error("Schema ensure failed:", e);
    res.status(500).json({ error: "Database schema is not ready" });
  }
}

router.use(ready);

// -------------------- CSV builders --------------------
function buildInventoryCsv(rows) {
  let csv = "";
  csv += "INVENTORY REPORT\n";
  csv += `Generated On,${csvEscape(new Date().toLocaleString())}\n\n`;
  csv += "ID,Name,SKU,Unit,Qty,Reorder Level,Active,Updated At\n";

  for (const r of rows) {
    csv += [
      csvEscape(r.id),
      csvEscape(r.name),
      csvEscape(r.sku || ""),
      csvEscape(r.unit || ""),
      csvEscape(r.qty ?? 0),
      csvEscape(r.reorder_level ?? 0),
      csvEscape(String(r.is_active ?? true)),
      csvEscape(r.updated_at || "")
    ].join(",") + "\n";
  }
  return csv;
}

function buildLossCsv(rows) {
  let csv = "";
  csv += "LOSS REPORT\n";
  csv += `Generated On,${csvEscape(new Date().toLocaleString())}\n\n`;
  csv += "ID,Product ID,Product Name,Reason,Qty,Unit,Note,Date & Time\n";

  for (const r of rows) {
    csv += [
      csvEscape(r.id),
      csvEscape(r.product_id),
      csvEscape(r.product_name || ""),
      csvEscape(r.reason || ""),
      csvEscape(r.qty ?? 0),
      csvEscape(r.unit || ""),
      csvEscape(r.note || ""),
      csvEscape(r.created_at || "")
    ].join(",") + "\n";
  }
  return csv;
}

// =====================================================
// PRODUCTS
// =====================================================

// GET all active products
router.get("/products", async (req, res) => {
  try {
    const includeInactive = cleanStr(req.query.include_inactive).toLowerCase() === "true";

    const sql = includeInactive
      ? `SELECT id, name, sku, unit, qty, reorder_level, is_active, updated_at
         FROM products
         ORDER BY updated_at DESC, id DESC`
      : `SELECT id, name, sku, unit, qty, reorder_level, is_active, updated_at
         FROM products
         WHERE COALESCE(is_active, TRUE) = TRUE
         ORDER BY updated_at DESC, id DESC`;

    const rows = await all(sql);
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
      `INSERT INTO products (name, sku, unit, qty, reorder_level, is_active, updated_at)
       VALUES ($1,$2,$3,$4,$5, TRUE, NOW())
       RETURNING id, name, sku, unit, qty, reorder_level, is_active, updated_at`,
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

    if (!id) return res.status(400).json({ error: "Invalid product id" });
    if (!name) return res.status(400).json({ error: "Product name is required" });

    const row = await get(
      `UPDATE products
       SET name=$1, sku=$2, unit=$3, reorder_level=$4, updated_at=NOW()
       WHERE id=$5
       RETURNING id, name, sku, unit, qty, reorder_level, is_active, updated_at`,
      [name, sku, unit, reorder_level, id]
    );

    if (!row) return res.status(404).json({ error: "Product not found" });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to update product" });
  }
});

// DELETE product (SAFE): soft delete to avoid FK constraint errors
router.delete("/products/:id", async (req, res) => {
  try {
    const id = toNumber(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid product id" });

    const row = await get(`SELECT id FROM products WHERE id=$1`, [id]);
    if (!row) return res.status(404).json({ error: "Product not found" });

    await query(`UPDATE products SET is_active=FALSE, updated_at=NOW() WHERE id=$1`, [id]);
    res.json({ ok: true, soft_deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to delete product" });
  }
});

// OPTIONAL: HARD delete (ADMIN ONLY) - use only if you really want to remove rows
router.delete("/products/:id/hard", requireAdmin, async (req, res) => {
  try {
    const id = toNumber(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid product id" });

    const row = await get(`SELECT id FROM products WHERE id=$1`, [id]);
    if (!row) return res.status(404).json({ error: "Product not found" });

    // This can fail if other tables reference product_id without ON DELETE CASCADE
    await query(`DELETE FROM products WHERE id=$1`, [id]);
    res.json({ ok: true, hard_deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Hard delete failed" });
  }
});

// Stock move IN/OUT (manual)
router.post("/products/:id/move", async (req, res) => {
  const id = toNumber(req.params.id);
  const type = cleanStr(req.body?.type).toUpperCase();
  const qty = toNumber(req.body?.qty, 0);
  const note = cleanStr(req.body?.note);
  const reason = cleanStr(req.body?.reason || (type === "IN" ? "MANUAL_IN" : "MANUAL_OUT"));

  if (!id) return res.status(400).json({ error: "Invalid product id" });
  if (!["IN", "OUT"].includes(type)) return res.status(400).json({ error: "type must be IN or OUT" });
  if (qty <= 0) return res.status(400).json({ error: "qty must be greater than 0" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const p = await client.query(
      `SELECT id, qty, is_active FROM products WHERE id=$1 FOR UPDATE`,
      [id]
    );
    if (!p.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Product not found" });
    }
    if (p.rows[0].is_active === false) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Product is inactive (restore it before moving stock)" });
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
       RETURNING id, name, sku, unit, qty, reorder_level, is_active, updated_at`,
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

// =====================================================
// LOSSES (SPOILAGE / MISHANDLING)
// Canonical table: losses
// Also writes to stock_movements (OUT) to keep qty + history consistent
// =====================================================

// Record inventory loss (spoilage/mishandling) = stock OUT with reason
router.post("/products/:id/loss", async (req, res) => {
  const id = toNumber(req.params.id);
  const qty = toNumber(req.body?.qty, 0);
  const reason = cleanStr(req.body?.reason).toUpperCase(); // SPOILAGE | MISHANDLING
  const note = cleanStr(req.body?.note);

  if (!id) return res.status(400).json({ error: "Invalid product id" });
  if (!["SPOILAGE", "MISHANDLING"].includes(reason)) {
    return res.status(400).json({ error: "reason must be SPOILAGE or MISHANDLING" });
  }
  if (qty <= 0) return res.status(400).json({ error: "qty must be greater than 0" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const p = await client.query(`SELECT id, qty, is_active FROM products WHERE id=$1 FOR UPDATE`, [id]);
    if (!p.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Product not found" });
    }
    if (p.rows[0].is_active === false) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Product is inactive" });
    }

    const currentQty = Number(p.rows[0].qty) || 0;
    const newQty = currentQty - qty;
    if (newQty < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient stock" });
    }

    // 1) write canonical loss history
    const lossIns = await client.query(
      `INSERT INTO losses (product_id, qty, reason, note, created_at)
       VALUES ($1,$2,$3,$4, NOW())
       RETURNING id, product_id, qty, reason, note, created_at`,
      [id, qty, reason, note]
    );

    // 2) also write stock movement OUT (keeps compatibility + analytics)
    await client.query(
      `INSERT INTO stock_movements (product_id, type, qty, reason, note, created_at)
       VALUES ($1,'OUT',$2,$3,$4, NOW())`,
      [id, qty, reason, note]
    );

    // 3) update product qty
    const updated = await client.query(
      `UPDATE products SET qty=$1, updated_at=NOW()
       WHERE id=$2
       RETURNING id, name, sku, unit, qty, reorder_level, is_active, updated_at`,
      [newQty, id]
    );

    await client.query("COMMIT");
    res.json({ ok: true, loss: lossIns.rows[0], updated: updated.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message || "Failed to record loss" });
  } finally {
    client.release();
  }
});

// GET losses (with filters)
router.get("/losses", async (req, res) => {
  try {
    const productId = toNumber(req.query.product_id, 0);
    const reason = cleanStr(req.query.reason).toUpperCase(); // optional
    const minQty = req.query.min_qty != null ? toNumber(req.query.min_qty, 0) : null;
    const maxQty = req.query.max_qty != null ? toNumber(req.query.max_qty, 0) : null;
    const dateFrom = cleanStr(req.query.date_from); // YYYY-MM-DD
    const dateTo = cleanStr(req.query.date_to); // YYYY-MM-DD

    const where = [];
    const params = [];

    if (productId) {
      params.push(productId);
      where.push(`l.product_id = $${params.length}`);
    }
    if (reason && ["SPOILAGE", "MISHANDLING"].includes(reason)) {
      params.push(reason);
      where.push(`l.reason = $${params.length}`);
    }
    if (minQty != null) {
      params.push(minQty);
      where.push(`l.qty >= $${params.length}`);
    }
    if (maxQty != null) {
      params.push(maxQty);
      where.push(`l.qty <= $${params.length}`);
    }
    if (dateFrom) {
      params.push(dateFrom);
      where.push(`l.created_at >= $${params.length}::date`);
    }
    if (dateTo) {
      // include entire day
      params.push(dateTo);
      where.push(`l.created_at < ($${params.length}::date + interval '1 day')`);
    }

    const sql = `
      SELECT
        l.id,
        l.product_id,
        p.name AS product_name,
        p.unit AS unit,
        l.reason,
        l.qty,
        l.note,
        l.created_at
      FROM losses l
      LEFT JOIN products p ON p.id = l.product_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY l.created_at DESC, l.id DESC
    `;

    const rows = await all(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to fetch losses" });
  }
});

// UPDATE loss record (also keeps stock consistent via adjustment)
router.put("/losses/:id", async (req, res) => {
  const lossId = toNumber(req.params.id);
  const qty = toNumber(req.body?.qty, 0);
  const reason = cleanStr(req.body?.reason).toUpperCase();
  const note = cleanStr(req.body?.note);

  if (!lossId) return res.status(400).json({ error: "Invalid loss id" });
  if (qty <= 0) return res.status(400).json({ error: "qty must be greater than 0" });
  if (!["SPOILAGE", "MISHANDLING"].includes(reason)) {
    return res.status(400).json({ error: "reason must be SPOILAGE or MISHANDLING" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT id, product_id, qty FROM losses WHERE id=$1 FOR UPDATE`,
      [lossId]
    );
    if (!existing.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Loss not found" });
    }

    const productId = existing.rows[0].product_id;
    const oldQty = Number(existing.rows[0].qty) || 0;
    const diff = qty - oldQty; // if +diff => we need to reduce stock more; if -diff => restore stock

    const p = await client.query(`SELECT id, qty, is_active FROM products WHERE id=$1 FOR UPDATE`, [productId]);
    if (!p.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Product not found for this loss" });
    }

    const currentQty = Number(p.rows[0].qty) || 0;
    const newQty = currentQty - diff; // because losses are OUT; increasing loss qty reduces stock

    if (newQty < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient stock for this edit" });
    }

    const updLoss = await client.query(
      `UPDATE losses
       SET qty=$1, reason=$2, note=$3
       WHERE id=$4
       RETURNING id, product_id, qty, reason, note, created_at`,
      [qty, reason, note, lossId]
    );

    // record adjustment in stock_movements for audit
    if (diff !== 0) {
      const adjType = diff > 0 ? "OUT" : "IN";
      const adjQty = Math.abs(diff);
      await client.query(
        `INSERT INTO stock_movements (product_id, type, qty, reason, note, created_at)
         VALUES ($1,$2,$3,$4,$5, NOW())`,
        [
          productId,
          adjType,
          adjQty,
          "LOSS_EDIT_ADJUST",
          `Adjustment due to editing loss #${lossId}`
        ]
      );
    }

    const updProduct = await client.query(
      `UPDATE products SET qty=$1, updated_at=NOW()
       WHERE id=$2
       RETURNING id, name, sku, unit, qty, reorder_level, is_active, updated_at`,
      [newQty, productId]
    );

    await client.query("COMMIT");
    res.json({ ok: true, loss: updLoss.rows[0], updated: updProduct.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message || "Failed to update loss" });
  } finally {
    client.release();
  }
});

// DELETE loss record (admin-only safe delete; reverses stock)
router.delete("/losses/:id", requireAdmin, async (req, res) => {
  const lossId = toNumber(req.params.id);
  if (!lossId) return res.status(400).json({ error: "Invalid loss id" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT id, product_id, qty FROM losses WHERE id=$1 FOR UPDATE`,
      [lossId]
    );
    if (!existing.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Loss not found" });
    }

    const productId = existing.rows[0].product_id;
    const lossQty = Number(existing.rows[0].qty) || 0;

    const p = await client.query(`SELECT id, qty FROM products WHERE id=$1 FOR UPDATE`, [productId]);
    if (!p.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Product not found for this loss" });
    }

    const currentQty = Number(p.rows[0].qty) || 0;
    const newQty = currentQty + lossQty; // deleting a loss restores stock

    // delete loss row
    await client.query(`DELETE FROM losses WHERE id=$1`, [lossId]);

    // record stock restore movement
    await client.query(
      `INSERT INTO stock_movements (product_id, type, qty, reason, note, created_at)
       VALUES ($1,'IN',$2,$3,$4, NOW())`,
      [productId, lossQty, "LOSS_DELETE_RESTORE", `Restored stock after deleting loss #${lossId}`]
    );

    const updProduct = await client.query(
      `UPDATE products SET qty=$1, updated_at=NOW()
       WHERE id=$2
       RETURNING id, name, sku, unit, qty, reorder_level, is_active, updated_at`,
      [newQty, productId]
    );

    await client.query("COMMIT");
    res.json({ ok: true, restored: true, updated: updProduct.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message || "Failed to delete loss" });
  } finally {
    client.release();
  }
});

// Export losses CSV (supports same filters)
router.get("/export/losses.csv", async (req, res) => {
  try {
    // reuse /losses filters by calling the same logic
    // (quick: call query building again)
    const productId = toNumber(req.query.product_id, 0);
    const reason = cleanStr(req.query.reason).toUpperCase();
    const minQty = req.query.min_qty != null ? toNumber(req.query.min_qty, 0) : null;
    const maxQty = req.query.max_qty != null ? toNumber(req.query.max_qty, 0) : null;
    const dateFrom = cleanStr(req.query.date_from);
    const dateTo = cleanStr(req.query.date_to);

    const where = [];
    const params = [];

    if (productId) {
      params.push(productId);
      where.push(`l.product_id = $${params.length}`);
    }
    if (reason && ["SPOILAGE", "MISHANDLING"].includes(reason)) {
      params.push(reason);
      where.push(`l.reason = $${params.length}`);
    }
    if (minQty != null) {
      params.push(minQty);
      where.push(`l.qty >= $${params.length}`);
    }
    if (maxQty != null) {
      params.push(maxQty);
      where.push(`l.qty <= $${params.length}`);
    }
    if (dateFrom) {
      params.push(dateFrom);
      where.push(`l.created_at >= $${params.length}::date`);
    }
    if (dateTo) {
      params.push(dateTo);
      where.push(`l.created_at < ($${params.length}::date + interval '1 day')`);
    }

    const sql = `
      SELECT
        l.id,
        l.product_id,
        p.name AS product_name,
        p.unit AS unit,
        l.reason,
        l.qty,
        l.note,
        l.created_at
      FROM losses l
      LEFT JOIN products p ON p.id = l.product_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY l.created_at DESC, l.id DESC
    `;

    const rows = await all(sql, params);
    const csv = buildLossCsv(rows);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="losses-${toIsoDateOnly(new Date())}.csv"`
    );
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to export losses CSV" });
  }
});

// =====================================================
// EXPORT / EMAIL INVENTORY
// =====================================================

// Export inventory CSV
router.get("/export/inventory.csv", async (req, res) => {
  try {
    const includeInactive = cleanStr(req.query.include_inactive).toLowerCase() === "true";

    const sql = includeInactive
      ? `SELECT id, name, sku, unit, qty, reorder_level, is_active, updated_at
         FROM products
         ORDER BY updated_at DESC, id DESC`
      : `SELECT id, name, sku, unit, qty, reorder_level, is_active, updated_at
         FROM products
         WHERE COALESCE(is_active, TRUE) = TRUE
         ORDER BY updated_at DESC, id DESC`;

    const rows = await all(sql);

    const csv = buildInventoryCsv(rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="inventory-${toIsoDateOnly(new Date())}.csv"`
    );
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
      `SELECT id, name, sku, unit, qty, reorder_level, is_active, updated_at
       FROM products
       WHERE COALESCE(is_active, TRUE) = TRUE
       ORDER BY updated_at DESC, id DESC`
    );

    const csv = buildInventoryCsv(rows);
    const filename = `inventory-${toIsoDateOnly(new Date())}.csv`;

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