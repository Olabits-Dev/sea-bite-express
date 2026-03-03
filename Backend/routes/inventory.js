const express = require("express");
const router = express.Router();
const { pool } = require("../db");

/* =====================================================
   SCHEMA ENSURE
===================================================== */
async function ensureSchema() {
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
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS losses (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      qty NUMERIC NOT NULL,
      reason TEXT NOT NULL,
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      qty_change NUMERIC NOT NULL,
      mode TEXT DEFAULT 'QTY',
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 🔥 Prevent duplicate product (critical for sync)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS unique_product_name_category
    ON products (LOWER(name), category)
  `);
}

router.use(async (req, res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (e) {
    console.error("Schema error:", e);
    res.status(500).json({ error: "Database schema not ready" });
  }
});

/* =====================================================
   HELPERS
===================================================== */
const normCategory = v =>
  String(v || "KITCHEN").trim().toUpperCase() === "SEAFOOD"
    ? "SEAFOOD"
    : "KITCHEN";

const toNumber = (v, f = 0) =>
  Number.isFinite(Number(v)) ? Number(v) : f;

const effectivePortionSize = p =>
  toNumber(p?.portion_size, 0) > 0 ? Number(p.portion_size) : 0;

/* =====================================================
   GET PRODUCTS
===================================================== */
router.get("/products", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id,name,sku,unit,qty,reorder_level,
      COALESCE(UPPER(category),'KITCHEN') AS category,
      portion_size,updated_at,created_at
      FROM products
      ORDER BY updated_at DESC NULLS LAST,id DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load products" });
  }
});

/* =====================================================
   CREATE PRODUCT (SYNC SAFE)
===================================================== */
router.post("/products", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Name required" });

    const category = normCategory(req.body.category);
    const unit = String(req.body.unit || "pcs").trim();
    const reorder = toNumber(req.body.reorder_level, 0);
    const initial = toNumber(req.body.initial_qty, 0);

    let portion_size = null;
    if (category === "SEAFOOD") {
      portion_size = toNumber(req.body.portion_size, 0);
      if (portion_size <= 0)
        return res.status(400).json({ error: "Seafood needs portion_size > 0" });
    }

    // 🔥 Check duplicate first (sync protection)
    const existing = await pool.query(
      `SELECT * FROM products WHERE LOWER(name)=LOWER($1) AND category=$2`,
      [name, category]
    );

    if (existing.rows.length) {
      return res.json(existing.rows[0]); // return existing instead of creating new
    }

    const { rows } = await pool.query(`
      INSERT INTO products
      (name,unit,qty,reorder_level,category,portion_size,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,NOW())
      RETURNING *
    `, [name, unit, initial, reorder, category, portion_size]);

    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create product" });
  }
});

/* =====================================================
   STOCK MOVE
===================================================== */
router.post("/products/:id/move", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const qtyIn = toNumber(req.body.qty, 0);
    const type = String(req.body.type).toUpperCase();
    const mode = String(req.body.mode || "QTY").toUpperCase();

    const { rows } = await pool.query(
      `SELECT * FROM products WHERE id=$1`, [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });

    const p = rows[0];
    let delta = qtyIn;

    if (p.category === "SEAFOOD" && mode === "PORTION") {
      delta = qtyIn * effectivePortionSize(p);
    }

    if (type === "OUT") delta = -delta;

    const newQty = toNumber(p.qty) + delta;
    if (newQty < 0) return res.status(400).json({ error: "Insufficient stock" });

    const updated = await pool.query(`
      UPDATE products SET qty=$1,updated_at=NOW()
      WHERE id=$2 RETURNING *
    `, [newQty, id]);

    await pool.query(`
      INSERT INTO stock_movements
      (product_id,type,qty_change,mode)
      VALUES ($1,$2,$3,$4)
    `, [id, type, delta, mode]);

    res.json(updated.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Move failed" });
  }
});

/* =====================================================
   LOSS (SYNC SAFE)
===================================================== */
router.post("/products/:id/loss", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const qtyIn = toNumber(req.body.qty, 0);
    const reason = String(req.body.reason).toUpperCase();
    const mode = String(req.body.mode || "QTY").toUpperCase();

    const { rows } = await pool.query(
      `SELECT * FROM products WHERE id=$1`, [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });

    const p = rows[0];
    let lossQty = qtyIn;

    if (p.category === "SEAFOOD" && mode === "PORTION") {
      lossQty = qtyIn * effectivePortionSize(p);
    }

    const newQty = toNumber(p.qty) - lossQty;
    if (newQty < 0) return res.status(400).json({ error: "Insufficient stock" });

    await pool.query(
      `UPDATE products SET qty=$1,updated_at=NOW() WHERE id=$2`,
      [newQty, id]
    );

    const inserted = await pool.query(`
      INSERT INTO losses (product_id,qty,reason)
      VALUES ($1,$2,$3)
      RETURNING *
    `, [id, lossQty, reason]);

    res.json(inserted.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Loss failed" });
  }
});

/* =====================================================
   GET LOSSES (FIXED FOR MULTI-USER VISIBILITY)
===================================================== */
router.get("/losses", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        l.*,
        p.name AS product_name,
        p.unit AS product_unit,
        p.category AS product_category
      FROM losses l
      LEFT JOIN products p ON p.id = l.product_id
      ORDER BY l.created_at DESC
    `);

    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load losses" });
  }
});

module.exports = router;