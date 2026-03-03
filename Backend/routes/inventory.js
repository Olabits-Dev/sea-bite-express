// Backend/routes/inventory.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");

/**
 * This file is aligned to your LIVE DB schema (from /api/debug/schema):
 *
 * products:
 *  id, name, sku, unit, qty, reorder_level, is_active, category, portion_size, created_at, updated_at
 *
 * losses:
 *  id, product_id, product_name, unit, qty, reason, note, created_at
 *
 * stock_movements:
 *  id, product_id, type, qty, note, reason, created_at, mode
 *
 * Key behavior:
 * - stock_movements.qty stores SIGNED delta:
 *    IN => +qtyDelta
 *    OUT => -qtyDelta
 *    LOSS => -qtyDelta
 * - SEAFOOD + mode=PORTION => qtyDelta = qty * portion_size
 */

async function ensureSchema() {
  // ---- PRODUCTS ----
  await pool.query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'KITCHEN'
  `);

  await pool.query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS portion_size NUMERIC
  `);

  await pool.query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE
  `);

  // Some DBs might have updated_at without timezone; keep as-is and just update with NOW()
  await pool.query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `);

  // ---- LOSSES ---- (match schema you showed: includes product_name + unit)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS losses (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      unit TEXT DEFAULT '',
      qty NUMERIC NOT NULL,
      reason TEXT NOT NULL,
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ---- STOCK MOVEMENTS ---- (match schema: has qty, reason, mode)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL,
      type TEXT NOT NULL,         -- IN | OUT | LOSS
      qty NUMERIC NOT NULL,       -- SIGNED delta
      note TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      mode TEXT DEFAULT 'QTY',     -- QTY | PORTION
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// Ensure schema before every request
router.use(async (req, res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (e) {
    console.error("ensureSchema error:", e);
    res.status(500).json({ error: "Database schema not ready" });
  }
});

function normCategory(v) {
  const s = String(v || "KITCHEN").trim().toUpperCase();
  return s === "SEAFOOD" ? "SEAFOOD" : "KITCHEN";
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isPositive(n) {
  return Number.isFinite(n) && n > 0;
}

function isNonNeg(n) {
  return Number.isFinite(n) && n >= 0;
}

function effectivePortionSize(product) {
  const ps = toNumber(product?.portion_size, 0);
  return ps > 0 ? ps : 0;
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function getProductById(client, id) {
  const { rows } = await client.query(
    `
    SELECT
      id, name, sku, unit, qty, reorder_level,
      COALESCE(UPPER(category), 'KITCHEN') AS category,
      portion_size,
      is_active,
      updated_at,
      created_at
    FROM products
    WHERE id=$1
    `,
    [id]
  );
  return rows[0] || null;
}

/**
 * GET all products
 */
router.get("/products", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        id, name, sku, unit, qty, reorder_level,
        COALESCE(UPPER(category), 'KITCHEN') AS category,
        portion_size,
        is_active,
        updated_at,
        created_at
      FROM products
      WHERE COALESCE(is_active, TRUE) = TRUE
      ORDER BY updated_at DESC NULLS LAST, id DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error("GET /products error:", e);
    res.status(500).json({ error: "Failed to load products" });
  }
});

/**
 * CREATE product
 * Body: { name, sku, unit, reorder_level, initial_qty, category, portion_size }
 */
router.post("/products", async (req, res) => {
  const client = await pool.connect();
  try {
    const name = String(req.body.name || "").trim();
    const sku = String(req.body.sku || "").trim();
    const reorder_level = toNumber(req.body.reorder_level, 0);
    const initial_qty = toNumber(req.body.initial_qty, 0);
    const category = normCategory(req.body.category);

    if (!name) return res.status(400).json({ error: "Product name is required" });
    if (!isNonNeg(initial_qty)) return res.status(400).json({ error: "Initial quantity must be 0 or more" });

    let unit = String(req.body.unit || "").trim() || "pcs";
    let portion_size = req.body.portion_size;

    if (category === "SEAFOOD") {
      const ps = toNumber(portion_size, 0);
      if (!isPositive(ps)) return res.status(400).json({ error: "Seafood requires portion_size > 0" });
      portion_size = ps;
      unit = unit || "qty";
    } else {
      portion_size = null;
      unit = unit || "pcs";
    }

    await client.query("BEGIN");

    const { rows } = await client.query(
      `
      INSERT INTO products
        (name, sku, unit, qty, reorder_level, category, portion_size, is_active, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,TRUE,NOW())
      RETURNING
        id, name, sku, unit, qty, reorder_level,
        COALESCE(UPPER(category), 'KITCHEN') AS category,
        portion_size,
        is_active,
        updated_at,
        created_at
      `,
      [name, sku || null, unit, initial_qty, reorder_level, category, portion_size]
    );

    const created = rows[0];

    // Log initial stock (signed delta = +initial_qty)
    if (initial_qty > 0) {
      await client.query(
        `
        INSERT INTO stock_movements (product_id, type, qty, mode, note, reason)
        VALUES ($1, 'IN', $2, 'QTY', $3, '')
        `,
        [created.id, initial_qty, "Initial stock in"]
      );
    }

    await client.query("COMMIT");
    res.json(created);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /products error:", e);
    res.status(500).json({ error: "Failed to create product" });
  } finally {
    client.release();
  }
});

/**
 * UPDATE product
 */
router.put("/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid product id" });

    const { rows: found } = await pool.query(`SELECT * FROM products WHERE id=$1`, [id]);
    if (!found.length) return res.status(404).json({ error: "Not found" });

    const prev = found[0];

    const name = String(req.body.name ?? prev.name).trim();
    const sku = String(req.body.sku ?? prev.sku ?? "").trim();
    const reorder_level = toNumber(req.body.reorder_level ?? prev.reorder_level, 0);
    const category = normCategory(req.body.category ?? prev.category);

    let unit = String(req.body.unit ?? prev.unit ?? "").trim() || "pcs";
    let portion_size = req.body.portion_size;

    if (category === "SEAFOOD") {
      const ps = toNumber(portion_size ?? prev.portion_size, 0);
      if (!isPositive(ps)) return res.status(400).json({ error: "Seafood requires portion_size > 0" });
      portion_size = ps;
      unit = unit || "qty";
    } else {
      portion_size = null;
      unit = unit || "pcs";
    }

    const { rows } = await pool.query(
      `
      UPDATE products
      SET name=$1, sku=$2, unit=$3, reorder_level=$4,
          category=$5, portion_size=$6, updated_at=NOW()
      WHERE id=$7
      RETURNING
        id, name, sku, unit, qty, reorder_level,
        COALESCE(UPPER(category), 'KITCHEN') AS category,
        portion_size,
        is_active,
        updated_at,
        created_at
      `,
      [name, sku || null, unit, reorder_level, category, portion_size, id]
    );

    res.json(rows[0]);
  } catch (e) {
    console.error("PUT /products/:id error:", e);
    res.status(500).json({ error: "Failed to update product" });
  }
});

/**
 * DELETE product (hard delete)
 */
router.delete("/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid product id" });

    const { rowCount } = await pool.query(`DELETE FROM products WHERE id=$1`, [id]);
    if (!rowCount) return res.status(404).json({ error: "Not found" });

    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /products/:id error:", e);
    res.status(500).json({ error: "Failed to delete product" });
  }
});

/**
 * STOCK MOVEMENT
 * POST /products/:id/move
 * Body: { type:"IN"|"OUT", qty:number, mode?:"QTY"|"PORTION", note?:string }
 */
router.post("/products/:id/move", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid product id" });

    const typeRaw = String(req.body.type || "").trim().toUpperCase();
    const modeRaw = String(req.body.mode || "QTY").trim().toUpperCase();
    const note = String(req.body.note || "").trim();

    if (!["IN", "OUT"].includes(typeRaw)) {
      return res.status(400).json({ error: "type must be IN or OUT" });
    }

    const qtyIn = toNumber(req.body.qty, NaN);
    if (!isPositive(qtyIn)) return res.status(400).json({ error: "qty must be > 0" });

    await client.query("BEGIN");

    const product = await getProductById(client, id);
    if (!product) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }

    const category = normCategory(product.category);

    // Convert to qty delta (real quantity)
    let qtyDelta = qtyIn;

    if (category === "SEAFOOD" && modeRaw === "PORTION") {
      const ps = effectivePortionSize(product);
      if (ps <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Seafood portion_size is not set properly" });
      }
      qtyDelta = qtyIn * ps;
    }

    // Signed delta stored in stock_movements.qty
    const signedDelta = typeRaw === "OUT" ? -qtyDelta : qtyDelta;

    const currentQty = toNumber(product.qty, 0);
    const newQty = currentQty + signedDelta;
    if (newQty < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient stock" });
    }

    await client.query(
      `UPDATE products SET qty=$1, updated_at=NOW() WHERE id=$2`,
      [newQty, id]
    );

    await client.query(
      `
      INSERT INTO stock_movements (product_id, type, qty, mode, note, reason)
      VALUES ($1, $2, $3, $4, $5, '')
      `,
      [id, typeRaw, signedDelta, (category === "SEAFOOD" ? modeRaw : "QTY"), note]
    );

    const updated = await getProductById(client, id);

    await client.query("COMMIT");
    res.json(updated);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /products/:id/move error:", e);
    res.status(500).json({ error: "Move failed" });
  } finally {
    client.release();
  }
});

/**
 * LOSS RECORD
 * POST /products/:id/loss
 * Body: { qty:number, reason:"SPOILAGE"|"MISHANDLING", note?:string, mode?:"QTY"|"PORTION" }
 */
router.post("/products/:id/loss", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid product id" });

    const reason = String(req.body.reason || "").trim().toUpperCase();
    if (!["SPOILAGE", "MISHANDLING"].includes(reason)) {
      return res.status(400).json({ error: "reason must be SPOILAGE or MISHANDLING" });
    }

    const note = String(req.body.note || "").trim();
    const modeRaw = String(req.body.mode || "QTY").trim().toUpperCase();

    const qtyIn = toNumber(req.body.qty, NaN);
    if (!isPositive(qtyIn)) return res.status(400).json({ error: "qty must be > 0" });

    await client.query("BEGIN");

    const product = await getProductById(client, id);
    if (!product) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }

    const category = normCategory(product.category);

    let lossQty = qtyIn;
    if (category === "SEAFOOD" && modeRaw === "PORTION") {
      const ps = effectivePortionSize(product);
      if (ps <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Seafood portion_size is not set properly" });
      }
      lossQty = qtyIn * ps;
    }

    const currentQty = toNumber(product.qty, 0);
    const newQty = currentQty - lossQty;
    if (newQty < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient stock" });
    }

    await client.query(
      `UPDATE products SET qty=$1, updated_at=NOW() WHERE id=$2`,
      [newQty, id]
    );

    // Insert into losses table (schema has product_name + unit)
    const { rows: lossRows } = await client.query(
      `
      INSERT INTO losses (product_id, product_name, unit, qty, reason, note)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [id, product.name, product.unit || "", lossQty, reason, note]
    );

    // Log stock movement: signed delta (LOSS is negative)
    await client.query(
      `
      INSERT INTO stock_movements (product_id, type, qty, mode, note, reason)
      VALUES ($1, 'LOSS', $2, $3, $4, $5)
      `,
      [id, -lossQty, (category === "SEAFOOD" ? modeRaw : "QTY"), note, reason]
    );

    await client.query("COMMIT");

    res.json({ ok: true, loss: lossRows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /products/:id/loss error:", e);
    res.status(500).json({ error: "Loss failed" });
  } finally {
    client.release();
  }
});

/**
 * GET losses
 * Frontend expects: product_name + product_unit
 */
router.get("/losses", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id,
        product_id,
        product_name,
        unit AS product_unit,
        qty,
        reason,
        note,
        created_at
      FROM losses
      ORDER BY created_at DESC, id DESC
      `
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /losses error:", e);
    res.status(500).json({ error: "Failed to load losses" });
  }
});

/**
 * UPDATE loss (does NOT retro-adjust product stock)
 */
router.put("/losses/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid loss id" });

    const qty = toNumber(req.body.qty, NaN);
    if (!isPositive(qty)) return res.status(400).json({ error: "qty must be > 0" });

    const reason = String(req.body.reason || "").trim().toUpperCase();
    if (!["SPOILAGE", "MISHANDLING"].includes(reason)) {
      return res.status(400).json({ error: "reason must be SPOILAGE or MISHANDLING" });
    }

    const note = String(req.body.note || "").trim();

    const { rows } = await pool.query(
      `
      UPDATE losses
      SET qty=$1, reason=$2, note=$3
      WHERE id=$4
      RETURNING
        id, product_id, product_name,
        unit AS product_unit,
        qty, reason, note, created_at
      `,
      [qty, reason, note, id]
    );

    if (!rows.length) return res.status(404).json({ error: "Loss not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error("PUT /losses/:id error:", e);
    res.status(500).json({ error: "Failed to update loss" });
  }
});

/**
 * DELETE loss
 */
router.delete("/losses/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid loss id" });

    const { rowCount } = await pool.query(`DELETE FROM losses WHERE id=$1`, [id]);
    if (!rowCount) return res.status(404).json({ error: "Loss not found" });

    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /losses/:id error:", e);
    res.status(500).json({ error: "Failed to delete loss" });
  }
});

/**
 * EXPORT inventory CSV
 * GET /export/inventory.csv
 */
router.get("/export/inventory.csv", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        id, name, sku, unit, qty, reorder_level,
        COALESCE(UPPER(category), 'KITCHEN') AS category,
        portion_size,
        updated_at
      FROM products
      WHERE COALESCE(is_active, TRUE) = TRUE
      ORDER BY updated_at DESC NULLS LAST, id DESC
    `);

    let csv = "";
    csv += "Inventory Export\n";
    csv += `Generated On,${new Date().toLocaleString()}\n\n`;
    csv += "Category,Name,SKU,Qty,Unit,PortionSize,Reorder,UpdatedAt\n";

    for (const p of rows) {
      csv += [
        csvEscape(p.category || "KITCHEN"),
        csvEscape(p.name),
        csvEscape(p.sku || ""),
        csvEscape(p.qty ?? 0),
        csvEscape(p.unit || ""),
        csvEscape(p.portion_size ?? ""),
        csvEscape(p.reorder_level ?? 0),
        csvEscape(p.updated_at ? new Date(p.updated_at).toLocaleString() : "")
      ].join(",") + "\n";
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="inventory-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error("GET /export/inventory.csv error:", e);
    res.status(500).json({ error: "Failed to export inventory CSV" });
  }
});

/**
 * EMAIL inventory CSV
 * POST /email/inventory
 * Body: { to }
 */
router.post("/email/inventory", async (req, res) => {
  try {
    const to = String(req.body.to || "").trim();
    if (!to) return res.status(400).json({ error: "Recipient email is required" });

    const SMTP_HOST = process.env.SMTP_HOST;
    const SMTP_PORT = process.env.SMTP_PORT;
    const SMTP_USER = process.env.SMTP_USER;
    const SMTP_PASS = process.env.SMTP_PASS;
    const SMTP_FROM = process.env.SMTP_FROM;

    if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
      return res.status(400).json({ error: "EMAIL NOT CONFIGURED" });
    }

    let nodemailer;
    try {
      nodemailer = require("nodemailer");
    } catch {
      return res.status(400).json({ error: "EMAIL NOT CONFIGURED" });
    }

    const { rows } = await pool.query(`
      SELECT
        name, sku, unit, qty, reorder_level,
        COALESCE(UPPER(category), 'KITCHEN') AS category,
        portion_size,
        updated_at
      FROM products
      WHERE COALESCE(is_active, TRUE) = TRUE
      ORDER BY updated_at DESC NULLS LAST, name ASC
    `);

    let csv = "Category,Name,SKU,Qty,Unit,PortionSize,Reorder,UpdatedAt\n";
    for (const p of rows) {
      csv += [
        csvEscape(p.category || "KITCHEN"),
        csvEscape(p.name),
        csvEscape(p.sku || ""),
        csvEscape(p.qty ?? 0),
        csvEscape(p.unit || ""),
        csvEscape(p.portion_size ?? ""),
        csvEscape(p.reorder_level ?? 0),
        csvEscape(p.updated_at ? new Date(p.updated_at).toLocaleString() : "")
      ].join(",") + "\n";
    }

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });

    await transporter.sendMail({
      from: SMTP_FROM,
      to,
      subject: "Inventory Report - SeaBite Tracker",
      text: "Attached is your Inventory CSV report.",
      attachments: [
        {
          filename: `inventory-${new Date().toISOString().slice(0,10)}.csv`,
          content: csv,
          contentType: "text/csv"
        }
      ]
    });

    res.json({ ok: true, sent: true });
  } catch (e) {
    console.error("POST /email/inventory error:", e);
    res.status(500).json({ error: "Failed to send inventory email" });
  }
});

module.exports = router;