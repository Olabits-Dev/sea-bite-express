// Backend/server.js
require("dotenv").config();

// ✅ Force IPv4 first to fix SMTP ENETUNREACH on IPv6
const dns = require("dns");
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

const express = require("express");
const cors = require("cors");

const { pool } = require("./db");
const inventoryRoutes = require("./routes/inventory");
const financeRoutes = require("./routes/finance");

const app = express();

// ---------- Middleware ----------
app.use(express.json({ limit: "2mb" }));

// ---------- CORS (Render + local) ----------
const allowedOrigins = new Set([
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://127.0.0.1:3000",

  // ✅ Your Render frontend domain (from screenshot)
  "https://sea-bite-express-1.onrender.com"
]);

const corsOptions = {
  origin: (origin, cb) => {
    // Allow server-to-server calls / Postman / curl
    if (!origin) return cb(null, true);

    // Allow explicit known origins
    if (allowedOrigins.has(origin)) return cb(null, true);

    // Allow any onrender subdomain (useful if you create another static site)
    if (/^https:\/\/.*\.onrender\.com$/.test(origin)) return cb(null, true);

    // Block everything else (and return an error)
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false
};

// ✅ Apply CORS + handle preflight
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ---------- Root + Health ----------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "SeaBite Express API is running",
    health: "/health",
    inventory: "/api/inventory/products",
    finance: "/api/finance/sales"
  });
});

app.get("/health", async (req, res) => {
  try {
    // DB ping
    await pool.query("SELECT 1 as ok");
    res.json({ ok: true, db: true, time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({
      ok: false,
      db: false,
      time: new Date().toISOString(),
      error: e.message
    });
  }
});

// ---------- Routes ----------
app.use("/api/inventory", inventoryRoutes);
app.use("/api/finance", financeRoutes);

// ---------- Error handler ----------
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

// ---------- Auto Migration ----------
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
        reason TEXT DEFAULT '',
        note TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Ensure reason column exists (safe migration)
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='stock_movements' AND column_name='reason'
        ) THEN
          ALTER TABLE stock_movements ADD COLUMN reason TEXT DEFAULT '';
        END IF;
      END $$;
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

// ---------- Start server ----------
const PORT = process.env.PORT || 5000;

runMigrations().then(() => {
  app.listen(PORT, () => console.log("🚀 Server running on port", PORT));
});