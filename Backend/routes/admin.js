// Backend/routes/admin.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");

// simple admin auth via header
function requireAdmin(req, res, next) {
  const key = req.header("x-admin-key");
  if (!process.env.ADMIN_KEY) {
    return res.status(500).json({ error: "ADMIN_KEY not set on server" });
  }
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized (bad admin key)" });
  }
  next();
}

// POST /api/admin/reset  -> wipe ALL DATA (keeps tables)
router.post("/reset", requireAdmin, async (req, res, next) => {
  try {
    await pool.query("BEGIN");

    // Order matters less with TRUNCATE ... CASCADE
    await pool.query(`
      TRUNCATE TABLE
        sale_items,
        sales,
        losses,
        stock_movements,
        expenses,
        products
      RESTART IDENTITY CASCADE;
    `);

    await pool.query("COMMIT");
    res.json({ ok: true, message: "Database cleared (test data removed)." });
  } catch (err) {
    await pool.query("ROLLBACK");
    next(err);
  }
});

module.exports = router;