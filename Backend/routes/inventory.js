const express = require("express");
const router = express.Router();
const { pool } = require("../db");

/**
 * ✅ Migration-safe schema
 * - Works even if tables already exist with older columns
 */
async function ensureSchema() {
  // ---------- PRODUCTS ----------
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

  // ---------- LOSSES ----------
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

  // If an older losses table exists with different columns, add missing ones.
  await pool.query(`ALTER TABLE losses ADD COLUMN IF NOT EXISTS qty NUMERIC`);
  await pool.query(`ALTER TABLE losses ADD COLUMN IF NOT EXISTS reason TEXT`);
  await pool.query(`ALTER TABLE losses ADD COLUMN IF NOT EXISTS note TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE losses ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);

  // Some old schemas used qty_lost — keep compatibility (read via COALESCE later)
  await pool.query(`ALTER TABLE losses ADD COLUMN IF NOT EXISTS qty_lost NUMERIC`);

  // ---------- STOCK MOVEMENTS ----------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      type TEXT NOT NULL,               -- IN | OUT | LOSS
      qty_change NUMERIC NOT NULL,      -- positive or negative delta
      mode TEXT DEFAULT 'QTY',          -- QTY | PORTION
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // If an older stock_movements exists, add missing columns (THIS FIXES “Move failed”)
  await pool.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS mode TEXT DEFAULT 'QTY'`);
  await pool.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS note TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);

  // ---------- DUPLICATE SYNC PROTECTION ----------
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS unique_product_name_category
    ON products (LOWER(name), UPPER(category))
  `);
}

// Ensure schema before every request
router.use(async (req, res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (e) {
    console.error("ensureSchema middleware error:", e);
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
        updated_at,
        created_at
      FROM products
      ORDER BY updated_at DESC NULLS LAST, id DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error("GET /products error:", e);
    res.status(500).json({ error: "Failed to load products" });
  }
});

/**
 * CREATE product (sync-safe)
 * If same name+category already exists, return it instead of creating another row.
 */
router.post("/products", async (req, res) => {
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

    // ✅ idempotent: return existing instead of creating duplicate (fixes seafood duplication)
    const existing = await pool.query(
      `SELECT
         id, name, sku, unit, qty, reorder_level,
         COALESCE(UPPER(category), 'KITCHEN') AS category,
         portion_size, updated_at, created_at
       FROM products
       WHERE LOWER(name)=LOWER($1) AND UPPER(category)=UPPER($2)
       LIMIT 1`,
      [name, category]
    );

    if (existing.rows.length) {
      // optional: if initial_qty provided and existing qty is 0, you could choose to stock in.
      return res.json(existing.rows[0]);
    }

    const { rows } = await pool.query(
      `
      INSERT INTO products
        (name, sku, unit, qty, reorder_level, category, portion_size, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,NOW())
      RETURNING
        id, name, sku, unit, qty, reorder_level,
        COALESCE(UPPER(category), 'KITCHEN') AS category,
        portion_size,
        updated_at,
        created_at
      `,
      [name, sku || null, unit, initial_qty, reorder_level, category, portion_size]
    );

    // log initial stock move
    if (initial_qty > 0) {
      await pool.query(
        `
        INSERT INTO stock_movements (product_id, type, qty_change, mode, note)
        VALUES ($1, 'IN', $2, 'QTY', $3)
        `,
        [rows[0].id, initial_qty, "Initial stock in"]
      );
    }

    res.json(rows[0]);
  } catch (e) {
    console.error("POST /products error:", e);
    res.status(500).json({ error: "Failed to create product" });
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
 * DELETE product
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
 * STOCK MOVE
 * POST /products/:id/move
 * Body: { type: "IN"|"OUT", qty: number, mode?: "QTY"|"PORTION", note?: string }
 */
router.post("/products/:id/move", async (req, res) => {
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

    const { rows: found } = await pool.query(`SELECT * FROM products WHERE id=$1`, [id]);
    if (!found.length) return res.status(404).json({ error: "Not found" });

    const product = found[0];
    const category = normCategory(product.category);

    let qtyChange = qtyIn;
    if (category === "SEAFOOD" && modeRaw === "PORTION") {
      const ps = effectivePortionSize(product);
      if (ps <= 0) return res.status(400).json({ error: "Seafood portion_size not set" });
      qtyChange = qtyIn * ps;
    }

    if (typeRaw === "OUT") qtyChange = -qtyChange;

    const newQty = toNumber(product.qty, 0) + qtyChange;
    if (newQty < 0) return res.status(400).json({ error: "Insufficient stock" });

    const { rows: updated } = await pool.query(
      `
      UPDATE products
      SET qty=$1, updated_at=NOW()
      WHERE id=$2
      RETURNING
        id, name, sku, unit, qty, reorder_level,
        COALESCE(UPPER(category), 'KITCHEN') AS category,
        portion_size,
        updated_at,
        created_at
      `,
      [newQty, id]
    );

    // ✅ This used to fail in old DBs if "mode" column didn't exist — now ensureSchema adds it.
    await pool.query(
      `
      INSERT INTO stock_movements (product_id, type, qty_change, mode, note)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [id, typeRaw, qtyChange, (category === "SEAFOOD" ? modeRaw : "QTY"), note]
    );

    res.json(updated[0]);
  } catch (e) {
    console.error("POST /products/:id/move error:", e);
    res.status(500).json({ error: "Move failed" });
  }
});

/**
 * LOSS RECORD
 * POST /products/:id/loss
 * Body: { qty, reason, note?, mode? }
 *
 * ✅ Returns: { ok:true, loss: {...} }  (matches script.js expectations)
 */
router.post("/products/:id/loss", async (req, res) => {
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

    const { rows: found } = await pool.query(`SELECT * FROM products WHERE id=$1`, [id]);
    if (!found.length) return res.status(404).json({ error: "Not found" });

    const product = found[0];
    const category = normCategory(product.category);

    let lossQty = qtyIn;
    if (category === "SEAFOOD" && modeRaw === "PORTION") {
      const ps = effectivePortionSize(product);
      if (ps <= 0) return res.status(400).json({ error: "Seafood portion_size not set" });
      lossQty = qtyIn * ps;
    }

    const currentQty = toNumber(product.qty, 0);
    if (currentQty - lossQty < 0) return res.status(400).json({ error: "Insufficient stock" });

    const newQty = currentQty - lossQty;

    await pool.query(`UPDATE products SET qty=$1, updated_at=NOW() WHERE id=$2`, [newQty, id]);

    // ✅ Insert into BOTH qty and qty_lost for maximum compatibility
    const { rows: lossRows } = await pool.query(
      `
      INSERT INTO losses (product_id, qty, qty_lost, reason, note, created_at)
      VALUES ($1, $2, $2, $3, $4, NOW())
      RETURNING *
      `,
      [id, lossQty, reason, note]
    );

    // Log movement (won’t fail now because ensureSchema adds missing columns)
    await pool.query(
      `
      INSERT INTO stock_movements (product_id, type, qty_change, mode, note)
      VALUES ($1, 'LOSS', $2, $3, $4)
      `,
      [id, -lossQty, (category === "SEAFOOD" ? modeRaw : "QTY"), note || reason]
    );

    res.json({ ok: true, loss: lossRows[0] });
  } catch (e) {
    console.error("POST /products/:id/loss error:", e);
    res.status(500).json({ error: "Loss failed" });
  }
});

/**
 * GET losses
 * ✅ Includes product_category so other users can see it correctly split
 * ✅ Uses COALESCE(qty, qty_lost) so old rows still show
 */
router.get("/losses", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        l.id,
        l.product_id,
        COALESCE(l.qty, l.qty_lost, 0) AS qty,
        l.reason,
        l.note,
        l.created_at,
        p.name AS product_name,
        p.unit AS product_unit,
        COALESCE(UPPER(p.category), 'KITCHEN') AS product_category
      FROM losses l
      LEFT JOIN products p ON p.id = l.product_id
      ORDER BY l.created_at DESC, l.id DESC
      `
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /losses error:", e);
    res.status(500).json({ error: "Failed to load losses" });
  }
});

/**
 * UPDATE loss
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
      SET qty=$1, qty_lost=$1, reason=$2, note=$3
      WHERE id=$4
      RETURNING *
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

module.exports = router;