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
app.use(express.json({ limit: "2mb" }));

/**
 * CORS (Render + local)
 */
const allowedOrigins = new Set([
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://sea-bite-express.onrender.com",
  "https://sea-bite-express-1.onrender.com"
]);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      if (/^https:\/\/.*\.onrender\.com$/.test(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
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
    finance: "/api/finance/sales"
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
 * Error handler
 */
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

/**
 * DB Migration + Schema Alignment
 * - Creates required tables
 * - Ensures stock_movements has reason/note (backward compatible)
 * - Ensures losses table exists (inventory_losses legacy name)
 * - Creates compatibility VIEWS: inventory_moves, inventory_losses
 *   ✅ Safe even if old TABLE exists with same name (drops it)
 */
async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ---- Core tables ----
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

    await client.query(`
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

    // Ensure columns exist (for old DBs)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='stock_movements' AND column_name='reason'
        ) THEN
          ALTER TABLE stock_movements ADD COLUMN reason TEXT DEFAULT '';
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='stock_movements' AND column_name='note'
        ) THEN
          ALTER TABLE stock_movements ADD COLUMN note TEXT DEFAULT '';
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        amount NUMERIC NOT NULL,
        description TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sale_items (
        id SERIAL PRIMARY KEY,
        sale_id INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        product_id INT NOT NULL REFERENCES products(id),
        qty_used NUMERIC NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        amount NUMERIC NOT NULL,
        description TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    /**
     * losses table (for spoilage/mishandling reports)
     * Your app currently records losses as stock_movements (OUT with reason),
     * but some older schema uses a separate losses table.
     * We create it for compatibility, and we’ll map inventory_losses -> losses via VIEW.
     */
    await client.query(`
      CREATE TABLE IF NOT EXISTS losses (
        id SERIAL PRIMARY KEY,
        product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        qty NUMERIC NOT NULL,
        reason TEXT DEFAULT '',
        note TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ---- Compatibility Views (safe drop: TABLE or VIEW) ----
    await client.query(`
      DO $$
      BEGIN
        -- inventory_moves -> stock_movements
        IF EXISTS (SELECT 1 FROM pg_class WHERE relname='inventory_moves' AND relkind='r') THEN
          EXECUTE 'DROP TABLE inventory_moves CASCADE';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_class WHERE relname='inventory_moves' AND relkind='v') THEN
          EXECUTE 'DROP VIEW inventory_moves CASCADE';
        END IF;
        EXECUTE 'CREATE VIEW inventory_moves AS SELECT * FROM stock_movements';

        -- inventory_losses -> losses
        IF EXISTS (SELECT 1 FROM pg_class WHERE relname='inventory_losses' AND relkind='r') THEN
          EXECUTE 'DROP TABLE inventory_losses CASCADE';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_class WHERE relname='inventory_losses' AND relkind='v') THEN
          EXECUTE 'DROP VIEW inventory_losses CASCADE';
        END IF;
        EXECUTE 'CREATE VIEW inventory_losses AS SELECT * FROM losses';
      END $$;
    `);

    /**
     * Optional: a safe reset helper function you can call from an admin route later.
     * (Doesn't run now; just creates the function.)
     */
    await client.query(`
      CREATE OR REPLACE FUNCTION reset_seabite_data()
      RETURNS void
      LANGUAGE plpgsql
      AS $$
      BEGIN
        -- delete children first
        DELETE FROM sale_items;
        DELETE FROM sales;
        DELETE FROM expenses;
        DELETE FROM losses;
        DELETE FROM stock_movements;
        DELETE FROM products;
      END;
      $$;
    `);

    await client.query("COMMIT");
    console.log("✅ Database migration completed");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err);
    // Keep exiting so Render shows the real migration error
    process.exit(1);
  } finally {
    client.release();
  }
}

const PORT = process.env.PORT || 5000;

runMigrations().then(() => {
  app.listen(PORT, () => console.log("🚀 Server running on port", PORT));
});