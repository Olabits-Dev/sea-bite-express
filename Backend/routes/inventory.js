// routes/inventory.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");

/**
 * ✅ This file is aligned with your REAL production DB schema:
 *
 * stock_movements (from Render): id, product_id, type, qty, note, reason, created_at, mode
 * losses (from Render error): requires product_name NOT NULL
 *
 * FIXES INCLUDED:
 * 1) ✅ Allow 'LOSS' in stock_movements_type_check (already in your file)
 * 2) ✅ Make losses table match production: product_name (NOT NULL), product_unit, mode
 * 3) ✅ Loss route now inserts product_name + product_unit + mode so DB won’t reject
 */

async function tableExists(name) {
  const { rows } = await pool.query(`SELECT to_regclass($1) AS reg`, [`public.${name}`]);
  return !!rows?.[0]?.reg;
}

async function getColumns(table) {
  const { rows } = await pool.query(
    `
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1
    `,
    [table]
  );
  return new Set(rows.map((r) => r.column_name));
}

/**
 * ✅ Ensure schema + fix constraints
 */
async function ensureSchema() {
  // -----------------------
  // PRODUCTS TABLE UPDATES
  // -----------------------
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
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE
  `);

  // -----------------------
  // ✅ LOSSES TABLE (MATCH PRODUCTION)
  // -----------------------
  const hasLosses = await tableExists("losses");

  if (!hasLosses) {
    await pool.query(`
      CREATE TABLE losses (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        product_name TEXT NOT NULL,
        product_unit TEXT DEFAULT '',
        qty NUMERIC NOT NULL,
        reason TEXT NOT NULL,
        note TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        mode TEXT DEFAULT 'QTY'
      )
    `);
  } else {
    const cols = await getColumns("losses");

    // Add missing columns
    if (!cols.has("product_name")) {
      await pool.query(`ALTER TABLE losses ADD COLUMN product_name TEXT`);
    }
    if (!cols.has("product_unit")) {
      await pool.query(`ALTER TABLE losses ADD COLUMN product_unit TEXT DEFAULT ''`);
    }
    if (!cols.has("mode")) {
      await pool.query(`ALTER TABLE losses ADD COLUMN mode TEXT DEFAULT 'QTY'`);
    }
    if (!cols.has("note")) {
      await pool.query(`ALTER TABLE losses ADD COLUMN note TEXT DEFAULT ''`);
    }
    if (!cols.has("created_at")) {
      await pool.query(`ALTER TABLE losses ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW()`);
    }

    // Backfill any null/empty product_name using products table
    await pool.query(`
      UPDATE losses l
      SET product_name = COALESCE(NULLIF(l.product_name,''), p.name),
          product_unit = COALESCE(NULLIF(l.product_unit,''), p.unit, '')
      FROM products p
      WHERE p.id = l.product_id
        AND (l.product_name IS NULL OR l.product_name = '')
    `);

    // Try to enforce NOT NULL (won't break if still has nulls; DO block catches)
    await pool.query(`
      DO $$
      BEGIN
        BEGIN
          ALTER TABLE losses ALTER COLUMN product_name SET NOT NULL;
        EXCEPTION WHEN others THEN
          -- ignore if cannot set due to existing nulls
        END;
      END $$;
    `);
  }

  // -----------------------
  // STOCK_MOVEMENTS TABLE
  // -----------------------
  const hasMovements = await tableExists("stock_movements");

  if (!hasMovements) {
    await pool.query(`
      CREATE TABLE stock_movements (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        type TEXT NOT NULL,                 -- IN | OUT | LOSS
        qty NUMERIC NOT NULL,               -- delta (+ for IN, - for OUT/LOSS)
        note TEXT DEFAULT '',
        reason TEXT DEFAULT '',
        mode TEXT DEFAULT 'QTY',            -- QTY | PORTION
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      ALTER TABLE stock_movements
      ADD CONSTRAINT stock_movements_type_check
      CHECK (type IN ('IN','OUT','LOSS'))
    `);
  } else {
    const cols = await getColumns("stock_movements");

    if (!cols.has("qty")) {
      await pool.query(`ALTER TABLE stock_movements ADD COLUMN qty NUMERIC`);
    }
    if (!cols.has("note")) {
      await pool.query(`ALTER TABLE stock_movements ADD COLUMN note TEXT DEFAULT ''`);
    }
    if (!cols.has("reason")) {
      await pool.query(`ALTER TABLE stock_movements ADD COLUMN reason TEXT DEFAULT ''`);
    }
    if (!cols.has("mode")) {
      await pool.query(`ALTER TABLE stock_movements ADD COLUMN mode TEXT DEFAULT 'QTY'`);
    }
    if (!cols.has("created_at")) {
      await pool.query(`ALTER TABLE stock_movements ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW()`);
    }

    // ✅ Ensure LOSS is allowed
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'stock_movements_type_check'
        ) THEN
          ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_type_check;
        END IF;
      END $$;
    `);

    await pool.query(`
      ALTER TABLE stock_movements
      ADD CONSTRAINT stock_movements_type_check
      CHECK (type IN ('IN','OUT','LOSS'))
    `);

    await pool.query(`
      ALTER TABLE stock_movements
      ALTER COLUMN qty SET DEFAULT 0
    `);
  }
}

// ✅ Ensure schema before every request
router.use(async (req, res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (e) {
    console.error("ensureSchema middleware error:", e);
    res.status(500).json({ error: "Database schema not ready", detail: e.message });
  }
});

// -----------------------
// Helpers
// -----------------------
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
function effectivePortionSize(product) {
  const ps = toNumber(product?.portion_size, 0);
  return ps > 0 ? ps : 0;
}

// -----------------------
// ✅ DEBUG ROUTES (so /api/inventory/debug/schema works)
// -----------------------
router.get("/debug/ping", (req, res) => res.json({ ok: true, ping: "inventory router alive" }));

router.get("/debug/schema", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema='public'
      ORDER BY table_name, ordinal_position
    `);
    res.json({ ok: true, columns: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -----------------------
// GET PRODUCTS
// -----------------------
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
    res.status(500).json({ error: "Failed to load products", detail: e.message });
  }
});

// -----------------------
// CREATE PRODUCT
// -----------------------
router.post("/products", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const sku = String(req.body.sku || "").trim();
    const reorder_level = toNumber(req.body.reorder_level, 0);
    const initial_qty = toNumber(req.body.initial_qty, 0);
    const category = normCategory(req.body.category);

    if (!name) return res.status(400).json({ error: "Product name is required" });
    if (initial_qty < 0) return res.status(400).json({ error: "Initial quantity must be 0 or more" });

    let unit = String(req.body.unit || "").trim() || "pcs";
    let portion_size = req.body.portion_size;

    if (category === "SEAFOOD") {
      const ps = toNumber(portion_size, 0);
      if (!isPositive(ps)) {
        return res.status(400).json({ error: "Seafood requires portion_size > 0" });
      }
      portion_size = ps;
      unit = unit || "qty";
    } else {
      portion_size = null;
      unit = unit || "pcs";
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

    if (initial_qty > 0) {
      await pool.query(
        `
        INSERT INTO stock_movements (product_id, type, qty, mode, note, reason)
        VALUES ($1, 'IN', $2, 'QTY', $3, '')
        `,
        [rows[0].id, initial_qty, "Initial stock in"]
      );
    }

    res.json(rows[0]);
  } catch (e) {
    console.error("POST /products error:", e);
    res.status(500).json({ error: "Failed to create product", detail: e.message });
  }
});

// -----------------------
// UPDATE PRODUCT
// -----------------------
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
    res.status(500).json({ error: "Failed to update product", detail: e.message });
  }
});

// -----------------------
// DELETE PRODUCT
// -----------------------
router.delete("/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid product id" });

    const { rowCount } = await pool.query(`DELETE FROM products WHERE id=$1`, [id]);
    if (!rowCount) return res.status(404).json({ error: "Not found" });

    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /products/:id error:", e);
    res.status(500).json({ error: "Failed to delete product", detail: e.message });
  }
});

// -----------------------
// STOCK MOVE (IN/OUT)
// -----------------------
router.post("/products/:id/move", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid product id" });

    const typeRaw = String(req.body.type || "").trim().toUpperCase();
    const modeRaw = String(req.body.mode || "QTY").trim().toUpperCase();
    const note = String(req.body.note || "").trim();

    if (!["IN", "OUT"].includes(typeRaw)) return res.status(400).json({ error: "type must be IN or OUT" });

    const qtyIn = toNumber(req.body.qty, NaN);
    if (!isPositive(qtyIn)) return res.status(400).json({ error: "qty must be > 0" });

    const { rows: found } = await pool.query(`SELECT * FROM products WHERE id=$1`, [id]);
    if (!found.length) return res.status(404).json({ error: "Not found" });

    const product = found[0];
    const category = normCategory(product.category);

    let qtyDelta = qtyIn;

    if (category === "SEAFOOD" && modeRaw === "PORTION") {
      const ps = effectivePortionSize(product);
      if (ps <= 0) return res.status(400).json({ error: "Seafood portion_size is not set properly" });
      qtyDelta = qtyIn * ps;
    }

    if (typeRaw === "OUT") qtyDelta = -qtyDelta;

    const newQty = toNumber(product.qty, 0) + qtyDelta;
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

    await pool.query(
      `
      INSERT INTO stock_movements (product_id, type, qty, mode, note, reason)
      VALUES ($1, $2, $3, $4, $5, '')
      `,
      [id, typeRaw, qtyDelta, (category === "SEAFOOD" ? modeRaw : "QTY"), note]
    );

    res.json(updated[0]);
  } catch (e) {
    console.error("POST /products/:id/move error:", e);
    res.status(500).json({ error: "Move failed", detail: e.message });
  }
});

// -----------------------
// ✅ LOSS RECORD (FIXED FOR product_name NOT NULL)
// -----------------------
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

    const { rows: found } = await client.query(`SELECT * FROM products WHERE id=$1 FOR UPDATE`, [id]);
    if (!found.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }

    const product = found[0];
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
    if (currentQty - lossQty < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient stock" });
    }

    const newQty = currentQty - lossQty;

    // update product qty
    await client.query(`UPDATE products SET qty=$1, updated_at=NOW() WHERE id=$2`, [newQty, id]);

    // ✅ insert into losses WITH product_name + product_unit + mode (prevents NOT NULL violation)
    const { rows: lossRows } = await client.query(
      `
      INSERT INTO losses (product_id, product_name, product_unit, qty, reason, note, mode)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [
        id,
        String(product.name || "").trim() || `Product#${id}`,
        String(product.unit || ""),
        lossQty,
        reason,
        note,
        category === "SEAFOOD" ? modeRaw : "QTY",
      ]
    );

    // ✅ insert stock movement type LOSS (allowed by constraint)
    await client.query(
      `
      INSERT INTO stock_movements (product_id, type, qty, mode, note, reason)
      VALUES ($1, 'LOSS', $2, $3, $4, $5)
      `,
      [id, -lossQty, category === "SEAFOOD" ? modeRaw : "QTY", note || reason, reason]
    );

    await client.query("COMMIT");
    res.json({ ok: true, loss: lossRows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /products/:id/loss error:", e);
    res.status(500).json({ error: "Loss failed", detail: e.message });
  } finally {
    client.release();
  }
});



// -----------------------
// EXPORT INVENTORY CSV
// -----------------------
router.get("/export/inventory.csv", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        id,
        name,
        COALESCE(sku, '') AS sku,
        COALESCE(UPPER(category), 'KITCHEN') AS category,
        COALESCE(unit, '') AS unit,
        COALESCE(qty, 0) AS qty,
        COALESCE(reorder_level, 0) AS reorder_level,
        COALESCE(portion_size, 0) AS portion_size,
        updated_at,
        created_at
      FROM products
      ORDER BY name ASC, id ASC
    `);

    const esc = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    const header = [
      'ID',
      'Name',
      'SKU',
      'Category',
      'Unit',
      'Quantity',
      'Reorder Level',
      'Portion Size',
      'Updated At',
      'Created At'
    ];

    const lines = [header.join(',')];

    for (const row of rows) {
      lines.push([
        row.id,
        esc(row.name),
        esc(row.sku),
        esc(row.category),
        esc(row.unit),
        row.qty,
        row.reorder_level,
        row.portion_size,
        esc(row.updated_at ? new Date(row.updated_at).toISOString() : ''),
        esc(row.created_at ? new Date(row.created_at).toISOString() : '')
      ].join(','));
    }

    const csv = lines.join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="inventory.csv"');
    res.status(200).send(csv);
  } catch (e) {
    console.error('GET /export/inventory.csv error:', e);
    res.status(500).json({ error: 'Failed to export inventory CSV', detail: e.message });
  }
});

// -----------------------
// GET LOSSES
// -----------------------
router.get("/losses", async (req, res) => {
  try {
    // Prefer stored name/unit in losses (more reliable when product deleted)
    const { rows } = await pool.query(
      `
      SELECT
        l.*,
        COALESCE(UPPER(p.category), 'KITCHEN', 'KITCHEN') AS category,
        p.portion_size
      FROM losses l
      LEFT JOIN products p ON p.id = l.product_id
      ORDER BY l.created_at DESC, l.id DESC
      `
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /losses error:", e);
    res.status(500).json({ error: "Failed to load losses", detail: e.message });
  }
});

// -----------------------
// DELETE LOSS
// -----------------------
router.delete("/losses/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid loss id" });

    const { rowCount } = await pool.query(`DELETE FROM losses WHERE id=$1`, [id]);
    if (!rowCount) return res.status(404).json({ error: "Loss not found" });

    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /losses/:id error:", e);
    res.status(500).json({ error: "Failed to delete loss", detail: e.message });
  }
});

module.exports = router;