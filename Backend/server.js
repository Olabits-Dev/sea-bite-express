// Backend/server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { pool } = require("./db");

// Routes
const financeRoutes = require("./routes/finance");
const inventoryRoutes = require("./routes/inventory");

const app = express();

/**
 * -----------------------
 * CORS
 * -----------------------
 */
function buildAllowedOrigins() {
  const set = new Set();

  // Allow env list: comma-separated
  const env = String(process.env.FRONTEND_ORIGIN || "").trim();
  if (env) {
    env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((o) => set.add(o));
  }

  // Your Render static frontend(s)
  set.add("https://sea-bite-express-1.onrender.com");
  set.add("https://sea-bite-express.onrender.com"); // ✅ add this too (sometimes frontend runs here)

  // Local dev
  set.add("http://localhost:3000");
  set.add("http://localhost:5500");
  set.add("http://127.0.0.1:5500");
  set.add("http://localhost:5000");

  return Array.from(set);
}

const allowedOrigins = buildAllowedOrigins();

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (/^https:\/\/.*\.onrender\.com$/.test(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-reset-token"],
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

/**
 * Body parsing
 */
app.use(express.json({ limit: "1mb" }));

/**
 * Small request log
 */
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

/**
 * Health + root
 */
app.get("/health", (req, res) => res.json({ ok: true, status: "healthy" }));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "SeaBite Express API is running",
    health: "/health",
    inventory: "/api/inventory/products",
    finance: "/api/finance/sales",
    adminReset: "/api/admin/reset",
    debugPing: "/api/debug/ping",
    debugSchema: "/api/debug/schema",
  });
});

/**
 * ✅ DEPLOY CHECK (MUST NOT 404)
 * If this returns 404, then you are NOT deploying the backend you think you are.
 */
app.get("/api/debug/ping", (req, res) => {
  res.json({
    ok: true,
    // change this string any time you redeploy so you know it updated
    deployTag: "debug-ping-v1",
    time: new Date().toISOString(),
  });
});

/**
 * ✅ SERVER-LEVEL SCHEMA DEBUG (does not depend on inventory.js)
 * If this is 404 => wrong service OR deploy not updated OR route after 404 (fixed here).
 */
app.get("/api/debug/schema", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name IN ('products','losses','stock_movements')
      ORDER BY table_name, ordinal_position
    `);

    res.json({ ok: true, columns: rows });
  } catch (e) {
    console.error("DEBUG SCHEMA ERROR:", e);
    res.status(500).json({ error: e.message || "debug failed" });
  }
});

/**
 * -----------------------
 * Admin Reset (TOKEN)
 * -----------------------
 */
function readResetToken(req) {
  const h1 = String(req.headers["x-admin-reset-token"] || "").trim();

  const auth = String(req.headers["authorization"] || "").trim();
  const bearer = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";

  const bodyToken = String(req.body?.token || "").trim();

  return h1 || bearer || bodyToken;
}

app.post("/api/admin/reset", async (req, res) => {
  try {
    const provided = readResetToken(req);
    const expected = String(process.env.ADMIN_RESET_TOKEN || "").trim();

    if (!expected) {
      return res.status(500).json({ error: "ADMIN_RESET_TOKEN not set on server" });
    }

    if (!provided || provided !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const RESET_IMPL_VERSION = "reset-safe-final-v5";

    const tableQuery = `
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
    `;

    const { rows } = await pool.query(tableQuery);
    const existingTables = new Set(rows.map((r) => r.tablename));

    const wanted = [
      "sales",
      "sale_items",
      "expenses",
      "products",
      "stock_movements",
      "losses",
      "inventory_losses",
    ];

    const truncated = [];

    for (const name of wanted) {
      if (!existingTables.has(name)) continue;
      await pool.query(`TRUNCATE TABLE "${name}" RESTART IDENTITY CASCADE`);
      truncated.push(name);
    }

    return res.json({
      ok: true,
      RESET_IMPL_VERSION,
      truncated,
      skipped: wanted.filter((t) => !existingTables.has(t)),
    });
  } catch (err) {
    console.error("ADMIN RESET ERROR:", err);
    return res.status(500).json({
      error: err.message || "Reset failed",
    });
  }
});

/**
 * API routes
 */
app.use("/api/finance", financeRoutes);
app.use("/api/inventory", inventoryRoutes);

/**
 * 404 handler
 */
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

/**
 * Error handler
 */
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);
  res.status(500).json({ error: err.message || "Server error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));