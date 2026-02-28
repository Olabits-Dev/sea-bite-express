const express = require("express");
const db = require("../db");
const { toCSV } = require("../utils/csv");
const { sendMailWithAttachment } = require("../utils/mailer");

const router = express.Router();

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

// PRODUCTS
router.get("/products", async (_req, res) => {
  try {
    const rows = await all(`SELECT * FROM products ORDER BY datetime(updated_at) DESC`);
    res.json(rows);
  } catch {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

router.post("/products", async (req, res) => {
  try {
    const { name, sku = "", unit = "pcs", reorder_level = 0 } = req.body || {};
    if (!name || String(name).trim() === "") return res.status(400).json({ error: "Product name is required" });

    const result = await run(
      `INSERT INTO products (name, sku, unit, qty, reorder_level, updated_at)
       VALUES (?, ?, ?, 0, ?, datetime('now'))`,
      [String(name).trim(), String(sku).trim(), String(unit).trim(), Number(reorder_level) || 0]
    );

    const product = await get(`SELECT * FROM products WHERE id = ?`, [result.lastID]);
    res.json(product);
  } catch {
    res.status(500).json({ error: "Failed to create product" });
  }
});

router.put("/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await get(`SELECT * FROM products WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ error: "Product not found" });

    const name = String(req.body?.name ?? existing.name).trim();
    const sku = String(req.body?.sku ?? existing.sku ?? "").trim();
    const unit = String(req.body?.unit ?? existing.unit ?? "pcs").trim();
    const reorder_level = Number(req.body?.reorder_level ?? existing.reorder_level) || 0;

    if (!name) return res.status(400).json({ error: "Product name is required" });

    await run(
      `UPDATE products SET name=?, sku=?, unit=?, reorder_level=?, updated_at=datetime('now') WHERE id=?`,
      [name, sku, unit, reorder_level, id]
    );

    const updated = await get(`SELECT * FROM products WHERE id = ?`, [id]);
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Failed to update product" });
  }
});

router.delete("/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await run(`DELETE FROM stock_movements WHERE product_id = ?`, [id]);
    await run(`DELETE FROM products WHERE id = ?`, [id]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to delete product" });
  }
});

// STOCK MOVE
router.post("/products/:id/move", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const product = await get(`SELECT * FROM products WHERE id = ?`, [id]);
    if (!product) return res.status(404).json({ error: "Product not found" });

    const type = String(req.body?.type || "").toUpperCase();
    const qty = Number(req.body?.qty);
    const note = String(req.body?.note || "");

    if (!["IN", "OUT"].includes(type)) return res.status(400).json({ error: "type must be IN or OUT" });
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: "qty must be > 0" });
    if (type === "OUT" && Number(product.qty) - qty < 0) return res.status(400).json({ error: "Insufficient stock" });

    await run(`INSERT INTO stock_movements (product_id, type, qty, note) VALUES (?, ?, ?, ?)`, [id, type, qty, note]);

    const newQty = type === "IN" ? Number(product.qty) + qty : Number(product.qty) - qty;
    await run(`UPDATE products SET qty=?, updated_at=datetime('now') WHERE id=?`, [newQty, id]);

    const updated = await get(`SELECT * FROM products WHERE id = ?`, [id]);
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Failed to apply stock movement" });
  }
});

// CSV EXPORT
router.get("/export/inventory.csv", async (_req, res) => {
  try {
    const products = await all(`SELECT * FROM products ORDER BY name ASC`);
    const rows = products.map(p => ({
      id: p.id, name: p.name, sku: p.sku, unit: p.unit, qty: p.qty,
      reorder_level: p.reorder_level, updated_at: p.updated_at
    }));
    const csv = toCSV(rows, ["id", "name", "sku", "unit", "qty", "reorder_level", "updated_at"]);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=inventory.csv");
    res.send(csv);
  } catch {
    res.status(500).json({ error: "Failed to export inventory CSV" });
  }
});

// EMAIL INVENTORY CSV
router.post("/email/inventory", async (req, res) => {
  try {
    const to = String(req.body?.to || "").trim();
    if (!to) return res.status(400).json({ error: "Recipient email is required" });

    const products = await all(`SELECT * FROM products ORDER BY name ASC`);
    const rows = products.map(p => ({
      id: p.id, name: p.name, sku: p.sku, unit: p.unit, qty: p.qty,
      reorder_level: p.reorder_level, updated_at: p.updated_at
    }));
    const csv = toCSV(rows, ["id", "name", "sku", "unit", "qty", "reorder_level", "updated_at"]);

    await sendMailWithAttachment({
      to,
      subject: "Inventory Report (CSV)",
      text: "Attached is your inventory snapshot report in CSV format.",
      filename: `inventory-${new Date().toISOString().split("T")[0]}.csv`,
      content: csv
    });

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to send inventory email" });
  }
});

module.exports = router;