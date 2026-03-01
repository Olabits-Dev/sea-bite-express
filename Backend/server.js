// Backend/server.js
require("dotenv").config();

// ✅ Force IPv4 first (helps SMTP on some hosts)
const dns = require("dns");
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder("ipv4first");

const express = require("express");
const cors = require("cors");

const { pool } = require("./db");
const inventoryRoutes = require("./routes/inventory");
const financeRoutes = require("./routes/finance");

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * CORS (Render + local)
 * - Allows your local dev + any *.onrender.com frontend
 */
const allowedOrigins = new Set([
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://sea-bite-express-1.onrender.com", // your frontend
]);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      if (/^https:\/\/.*\.onrender\.com$/.test(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Token"],
  })
);
app.options("*", cors());

/**
 * Root + Health
 */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "SeaBite Express API is running",
    health: "/health",
    inventory: "/api/inventory/products",
    finance: "/api/finance/sales",
    adminReset: "/api/admin/reset",
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * Routes
 */
app.use("/api/inventory", inventoryRoutes);
app.use("/api/finance", financeRoutes);

/**
 * ✅ Admin Reset DB (token protected + locked)
 * ENV required on Render:
 * - ADMIN_RESET_TOKEN=your-secret
 */
app.post("/api/admin/reset", async (req, res, next) => {
  const token = req.headers["x-admin-token"];
  if (!process.env.ADMIN_RESET_TOKEN || token !== process.env.ADMIN_RESET_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const client = await pool.connect();
  try {
    // ✅ one reset at a time across all servers
    await client.query("SELECT pg_advisory_lock(777001)");
    await client.query("BEGIN");

    // ✅ Truncate in safe order (FK-safe) + reset IDs
    await client.query(`
      TRUNCATE TABLE
        sale_items,
        sales,
        expenses,
        stock_movements,
        products
      RESTART IDENTITY CASCADE;
    `);

    // Optional legacy tables (only if they exist)
    // await client.query(`TRUNCATE TABLE inventory_moves RESTART IDENTITY CASCADE;`);
    // await client.query(`TRUNCATE TABLE inventory_losses RESTART IDENTITY CASCADE;`);
    // await client.query(`TRUNCATE TABLE losses RESTART IDENTITY CASCADE;`);

    await client.query("COMMIT");
    res.json({ ok: true, message: "Database reset completed" });
  } catch (e) {
    await client.query("ROLLBACK");
    next(e);
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(777001)");
    } catch {}
    client.release();
  }
});

/**
 * Error handler
 */
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

/**
 * ✅ Auto Migration (canonical schema only)
 * - avoids your previous "inventory_moves is not a view" crash
 */
async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // products
    await client.query(`
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

    // stock_movements
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_movements (
        id SERIAL PRIMARY KEY,
        product_id INT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        type TEXT NOT NULL CHECK (type IN ('IN','OUT')),
        qty NUMERIC NOT NULL,
        reason TEXT DEFAULT '',
        note TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // sales
    await client.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        amount NUMERIC NOT NULL,
        description TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // sale_items
    await client.query(`
      CREATE TABLE IF NOT EXISTS sale_items (
        id SERIAL PRIMARY KEY,
        sale_id INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        product_id INT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        qty_used NUMERIC NOT NULL
      );
    `);

    // expenses
    await client.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        amount NUMERIC NOT NULL,
        description TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Helpful indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_stock_movements_product_id ON stock_movements(product_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sale_items_product_id ON sale_items(product_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_expenses_created_at ON expenses(created_at);`);

    await client.query("COMMIT");
    console.log("✅ Database migration completed");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
  }
}

const PORT = process.env.PORT || 5000;

runMigrations().then(() => {
  app.listen(PORT, () => console.log("🚀 Server running on port", PORT));
});