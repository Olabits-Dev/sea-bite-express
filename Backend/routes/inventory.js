const express = require("express");
const db = require("../db");
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

function okQty(n) { return Number.isFinite(n) && n > 0; }

// LIST PRODUCTS
router.get("/products", async (_req, res) => {
  try {
    const rows = await all(`SELECT * FROM products ORDER BY datetime(updated_at) DESC LIMIT 1000`);
    res.json(rows);
  } catch {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// CREATE PRODUCT
router.post("/products", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const sku = String(req.body?.sku || "").trim();
    const unit = String(req.body?.unit || "pcs").trim() || "pcs";
    const reorder_level = Number(req.body?.reorder_level || 0);

    if (!name) return res.status(400).json({ error: "Product name is required" });

    const r = await run(
      `INSERT INTO products (name, sku, unit, qty, reorder_level) VALUES (?, ?, ?, 0, ?)`,
      [name, sku, unit, reorder_level]
    );

    const row = await get(`SELECT * FROM products WHERE id=?`, [r.lastID]);
    res.json(row);
  } catch {
    res.status(500).json({ error: "Failed to create product" });
  }
});

// UPDATE PRODUCT (not qty)
router.put("/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const name = String(req.body?.name || "").trim();
    const sku = String(req.body?.sku || "").trim();
    const unit = String(req.body?.unit || "pcs").trim() || "pcs";
    const reorder_level = Number(req.body?.reorder_level || 0);

    if (!name) return res.status(400).json({ error: "Product name is required" });

    const ex = await get(`SELECT * FROM products WHERE id=?`, [id]);
    if (!ex) return res.status(404).json({ error: "Product not found" });

    await run(
      `UPDATE products SET name=?, sku=?, unit=?, reorder_level=?, updated_at=datetime('now') WHERE id=?`,
      [name, sku, unit, reorder_level, id]
    );

    const row = await get(`SELECT * FROM products WHERE id=?`, [id]);
    res.json(row);
  } catch {
    res.status(500).json({ error: "Failed to update product" });
  }
});

// DELETE PRODUCT
router.delete("/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await run(`DELETE FROM products WHERE id=?`, [id]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to delete product" });
  }
});

// STOCK MOVE
router.post("/products/:id/move", async (req, res) => {
  const id = Number(req.params.id);
  const type = String(req.body?.type || "").toUpperCase();
  const qty = Number(req.body?.qty);
  const note = String(req.body?.note || "").trim();

  if (!["IN", "OUT"].includes(type)) return res.status(400).json({ error: "type must be IN or OUT" });
  if (!okQty(qty)) return res.status(400).json({ error: "qty must be > 0" });

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");
    (async () => {
      try {
        const product = await get(`SELECT * FROM products WHERE id=?`, [id]);
        if (!product) throw new Error("Product not found");

        const newQty = type === "IN" ? Number(product.qty) + qty : Number(product.qty) - qty;
        if (newQty < 0) throw new Error("Insufficient stock");

        await run(
          `INSERT INTO stock_movements (product_id, type, qty, note) VALUES (?, ?, ?, ?)`,
          [id, type, qty, note || null]
        );

        await run(`UPDATE products SET qty=?, updated_at=datetime('now') WHERE id=?`, [newQty, id]);

        await run("COMMIT");

        const updated = await get(`SELECT * FROM products WHERE id=?`, [id]);
        res.json(updated);
      } catch (e) {
        await run("ROLLBACK");
        res.status(400).json({ error: e.message || "Failed to move stock" });
      }
    })();
  });
});

// EXPORT INVENTORY CSV
router.get("/export/inventory.csv", async (_req, res) => {
  try {
    const rows = await all(`SELECT name, sku, unit, qty, reorder_level, updated_at FROM products ORDER BY name ASC`);

    let csv = "";
    csv += "INVENTORY REPORT\n";
    csv += `Generated On:,${new Date().toLocaleString()}\n\n`;
    csv += "Name,SKU,Unit,Qty,Reorder Level,Last Updated\n";

    rows.forEach(r => {
      const name = String(r.name || "").replaceAll('"', '""');
      const sku = String(r.sku || "").replaceAll('"', '""');
      const unit = String(r.unit || "").replaceAll('"', '""');
      csv += `"${name}","${sku}","${unit}",${Number(r.qty) || 0},${Number(r.reorder_level) || 0},"${new Date(r.updated_at).toLocaleString()}"\n`;
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=inventory-${new Date().toISOString().split("T")[0]}.csv`);
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

    const rows = await all(`SELECT name, sku, unit, qty, reorder_level, updated_at FROM products ORDER BY name ASC`);

    let csv = "";
    csv += "INVENTORY REPORT\n";
    csv += `Generated On:,${new Date().toLocaleString()}\n\n`;
    csv += "Name,SKU,Unit,Qty,Reorder Level,Last Updated\n";

    rows.forEach(r => {
      const name = String(r.name || "").replaceAll('"', '""');
      const sku = String(r.sku || "").replaceAll('"', '""');
      const unit = String(r.unit || "").replaceAll('"', '""');
      csv += `"${name}","${sku}","${unit}",${Number(r.qty) || 0},${Number(r.reorder_level) || 0},"${new Date(r.updated_at).toLocaleString()}"\n`;
    });

    await sendMailWithAttachment({
      to,
      subject: "Inventory Report",
      text: "Attached is your inventory report.",
      filename: `inventory-${new Date().toISOString().split("T")[0]}.csv`,
      content: csv
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to send inventory email" });
  }
});

module.exports = router;