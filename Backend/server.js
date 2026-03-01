// Backend/server.js
require("dotenv").config();

const dns = require("dns");
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder("ipv4first");

const express = require("express");
const cors = require("cors");

const { pool } = require("./db");
const inventoryRoutes = require("./routes/inventory");
const financeRoutes = require("./routes/finance");
const adminRoutes = require("./routes/admin");

const app = express();
app.use(express.json({ limit: "2mb" }));

// --- CORS ---
const allowedOrigins = new Set([
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://sea-bite-express-1.onrender.com",
]);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      if (/^https:\/\/.*\.onrender\.com$/.test(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-key"],
  })
);
app.options("*", cors());

// --- Root + Health ---
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "SeaBite Express API is running",
    health: "/health",
    inventory: "/api/inventory/products",
    finance: "/api/finance/sales",
    admin: "/api/admin/reset (POST)",
  });
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "connected", time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, db: "down", error: e.message });
  }
});

// --- Routes ---
app.use("/api/inventory", inventoryRoutes);
app.use("/api/finance", financeRoutes);
app.use("/api/admin", adminRoutes);

// --- Error handler ---
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

// --- Auto Migration (aligned schema) ---
async function runMigrations() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        sku TEXT DEFAULT '',
        unit TEXT DEFAULT 'pcs',
        qty NUMERIC DEFAULT 0,
        reorder_level NUMERIC DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_movements (
        id SERIAL PRIMARY KEY,
        product_id INT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        type TEXT NOT NULL CHECK (type IN ('IN','OUT')),
        qty NUMERIC NOT NULL CHECK (qty >= 0),
        reason TEXT DEFAULT '',
        note TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS losses (
        id SERIAL PRIMARY KEY,
        product_id INT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        reason TEXT NOT NULL CHECK (reason IN ('SPOILAGE','MISHANDLING')),
        qty NUMERIC NOT NULL CHECK (qty >= 0),
        note TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        amount NUMERIC NOT NULL,
        description TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sale_items (
        id SERIAL PRIMARY KEY,
        sale_id INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        product_id INT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        qty_used NUMERIC NOT NULL CHECK (qty_used > 0)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        amount NUMERIC NOT NULL,
        description TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Compatibility views
    await pool.query(`DROP VIEW IF EXISTS inventory_moves;`);
    await pool.query(`CREATE VIEW inventory_moves AS SELECT * FROM stock_movements;`);

    await pool.query(`DROP VIEW IF EXISTS inventory_losses;`);
    await pool.query(`CREATE VIEW inventory_losses AS SELECT * FROM losses;`);

    console.log("✅ Database migration completed (aligned schema)");
  } catch (err) {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  }
}

const PORT = process.env.PORT || 5000;

runMigrations().then(() => {
  app.listen(PORT, () => console.log("🚀 Server running on port", PORT));
});