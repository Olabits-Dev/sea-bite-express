// Backend/server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { pool } = require("./db");
const inventoryRoutes = require("./routes/inventory");
const financeRoutes = require("./routes/finance");

const app = express();
app.use(express.json({ limit: "2mb" }));

// --- CORS (Netlify + local) ---
const allowedOrigins = new Set([
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://sea-bite-express.netlify.app"
]);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      if (/^https:\/\/.*\.netlify\.app$/.test(origin)) return cb(null, true); // preview deploys
      return cb(null, false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
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
    finance: "/api/finance/sales"
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// --- Routes ---
app.use("/api/inventory", inventoryRoutes);
app.use("/api/finance", financeRoutes);

// --- Error handler ---
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

// --- Auto Migration (No Render shell needed) ---
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
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_movements (
        id SERIAL PRIMARY KEY,
        product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('IN','OUT')),
        qty NUMERIC NOT NULL,
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
        product_id INT NOT NULL REFERENCES products(id),
        qty_used NUMERIC NOT NULL
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

    console.log("✅ Database migration completed");
  } catch (err) {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  }
}

const PORT = process.env.PORT || 5000;

runMigrations().then(() => {
  app.listen(PORT, () => console.log("🚀 Server running on port", PORT));
});