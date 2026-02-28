// backend/routes/inventory.js
const express = require("express");
const router = express.Router();

// These helpers assume you already have db + run/get/all in your project.
// If your project exports db differently, adjust the imports below.
const { db, run, get, all } = require("../db");
const { sendMailWithAttachment } = require("../utils/mailer");

// --------------------------
// Helpers
// --------------------------
function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function cleanStr(v, fallback = "") {
  const s = String(v ?? fallback).trim();
  return s;
}

function csvEscape(value) {
  const s = String(value ?? "");
  // wrap in quotes if contains comma, quote, newline
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

// --------------------------
// ROUTES
// --------------------------

// GET all products
router.get("/products", async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, name, sku, unit, qty, reorder_level, updated_at
       FROM products
       ORDER BY datetime(updated_at) DESC, id DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to fetch products" });
  }
});

// GET one product
router.get("/products/:id", async (req, res) => {
  try {
    const id = toNumber(req.params.id);
    const row = await get(
      `SELECT id, name, sku, unit, qty, reorder_level, updated_at
       FROM products WHERE id=?`,
      [id]
    );
    if (!row) return res.status(404).json({ error: "Product not found" });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to fetch product" });
  }
});

// CREATE PRODUCT (MERGED: supports initial_qty and auto Stock IN record)
router.post("/products", async (req, res) => {
  try {
    const name = cleanStr(req.body?.name);
    const sku = cleanStr(req.body?.sku);
    const unit = cleanStr(req.body?.unit || "pcs") || "pcs";
    const reorder_level = toNumber(req.body?.reorder_level, 0);
    const initial_qty = toNumber(req.body?.initial_qty, 0);

    if (!name) return res.status(400).json({ error: "Product name is required" });
    if (!Number.isFinite(initial_qty) || initial_qty < 0) {
      return res.status(400).json({ error: "initial_qty must be 0 or more" });
    }

    db.serialize(() => {
      db.run("BEGIN TRANSACTION");
      (async () => {
        try {
          const insert = await run(
            `INSERT INTO products (name, sku, unit, qty, reorder_level, updated_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`,
            [name, sku, unit, initial_qty || 0, reorder_level]
          );

          const productId = insert.lastID;

          // Auto Stock IN movement for initial qty
          if (initial_qty > 0) {
            await run(
              `INSERT INTO stock_movements (product_id, type, qty, note, created_at)
               VALUES (?, 'IN', ?, ?, datetime('now'))`,
              [productId, initial_qty, "Initial Stock IN on product creation"]
            );
          }

          await run("COMMIT");

          const row = await get(
            `SELECT id, name, sku, unit, qty, reorder_level, updated_at
             FROM products WHERE id=?`,
            [productId]
          );
          res.json(row);
        } catch (e) {
          try { await run("ROLLBACK"); } catch {}
          res.status(500).json({ error: e.message || "Failed to create product" });
        }
      })();
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to create product" });
  }
});

// UPDATE PRODUCT
router.put("/products/:id", async (req, res) => {
  try {
    const id = toNumber(req.params.id);
    const name = cleanStr(req.body?.name);
    const sku = cleanStr(req.body?.sku);
    const unit = cleanStr(req.body?.unit || "pcs") || "pcs";
    const reorder_level = toNumber(req.body?.reorder_level, 0);

    if (!name) return res.status(400).json({ error: "Product name is required" });

    const existing = await get(`SELECT id FROM products WHERE id=?`, [id]);
    if (!existing) return res.status(404).json({ error: "Product not found" });

    await run(
      `UPDATE products
       SET name=?, sku=?, unit=?, reorder_level=?, updated_at=datetime('now')
       WHERE id=?`,
      [name, sku, unit, reorder_level, id]
    );

    const row = await get(
      `SELECT id, name, sku, unit, qty, reorder_level, updated_at
       FROM products WHERE id=?`,
      [id]
    );

    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to update product" });
  }
});

// DELETE PRODUCT
router.delete("/products/:id", async (req, res) => {
  try {
    const id = toNumber(req.params.id);

    const existing = await get(`SELECT id FROM products WHERE id=?`, [id]);
    if (!existing) return res.status(404).json({ error: "Product not found" });

    // remove movements first (if you have FK constraints)
    await run(`DELETE FROM stock_movements WHERE product_id=?`, [id]);
    await run(`DELETE FROM products WHERE id=?`, [id]);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to delete product" });
  }
});

// STOCK MOVE: IN / OUT
router.post("/products/:id/move", async (req, res) => {
  try {
    const id = toNumber(req.params.id);
    const type = cleanStr(req.body?.type).toUpperCase(); // IN | OUT
    const qty = toNumber(req.body?.qty, 0);
    const note = cleanStr(req.body?.note);

    if (!["IN", "OUT"].includes(type)) {
      return res.status(400).json({ error: "type must be IN or OUT" });
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: "qty must be greater than 0" });
    }

    const product = await get(`SELECT id, qty FROM products WHERE id=?`, [id]);
    if (!product) return res.status(404).json({ error: "Product not found" });

    const currentQty = toNumber(product.qty, 0);
    const newQty = type === "IN" ? currentQty + qty : currentQty - qty;

    if (newQty < 0) return res.status(400).json({ error: "Insufficient stock" });

    db.serialize(() => {
      db.run("BEGIN TRANSACTION");
      (async () => {
        try {
          await run(
            `INSERT INTO stock_movements (product_id, type, qty, note, created_at)
             VALUES (?, ?, ?, ?, datetime('now'))`,
            [id, type, qty, note]
          );

          await run(
            `UPDATE products SET qty=?, updated_at=datetime('now') WHERE id=?`,
            [newQty, id]
          );

          await run("COMMIT");

          const row = await get(
            `SELECT id, name, sku, unit, qty, reorder_level, updated_at
             FROM products WHERE id=?`,
            [id]
          );

          res.json(row);
        } catch (e) {
          try { await run("ROLLBACK"); } catch {}
          res.status(500).json({ error: e.message || "Failed to move stock" });
        }
      })();
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to move stock" });
  }
});

// EXPORT INVENTORY CSV
router.get("/export/inventory.csv", async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, name, sku, unit, qty, reorder_level, updated_at
       FROM products
       ORDER BY datetime(updated_at) DESC, id DESC`
    );

    const csv = buildInventoryCsv(rows);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="inventory-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to export inventory CSV" });
  }
});

// EMAIL INVENTORY CSV
router.post("/email/inventory", async (req, res) => {
  try {
    const to = cleanStr(req.body?.to);
    if (!to) return res.status(400).json({ error: "Recipient email is required" });

    const rows = await all(
      `SELECT id, name, sku, unit, qty, reorder_level, updated_at
       FROM products
       ORDER BY datetime(updated_at) DESC, id DESC`
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