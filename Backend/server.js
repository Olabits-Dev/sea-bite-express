// Backend/server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { pool } = require("./db");

// Routes
const financeRoutes = require("./routes/finance");
const inventoryRoutes = require("./routes/inventory"); // <-- must exist in your project

const app = express();

/**
 * -----------------------
 * CORS (IMPORTANT FIX)
 * -----------------------
 * This fixes "Network error: Backend unreachable" when calling POST /api/admin/reset
 * from your frontend domain (because browser preflight OPTIONS was blocked).
 */
function buildAllowedOrigins() {
  const set = new Set();

  // allow env list: comma-separated
  const env = String(process.env.FRONTEND_ORIGIN || "").trim();
  if (env) {
    env.split(",").map(s => s.trim()).filter(Boolean).forEach(o => set.add(o));
  }

  // common Render static site domains (add yours)
  set.add("https://sea-bite-express-1.onrender.com");

  // allow local dev
  set.add("http://localhost:3000");
  set.add("http://localhost:5500");
  set.add("http://127.0.0.1:5500");
  set.add("http://localhost:5000");

  return Array.from(set);
}

const allowedOrigins = buildAllowedOrigins();

app.use(
  cors({
    origin: (origin, cb) => {
      // allow same-origin / curl / server-to-server (no Origin header)
      if (!origin) return cb(null, true);

      if (allowedOrigins.includes(origin)) return cb(null, true);

      // optional: allow any *.onrender.com frontend
      if (/^https:\/\/.*\.onrender\.com$/.test(origin)) return cb(null, true);

      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-reset-token"],
    maxAge: 86400,
  })
);

// IMPORTANT: respond to preflight
app.options("*", cors());

/**
 * Body parsing
 */
app.use(express.json({ limit: "1mb" }));

/**
 * Small request log (helpful in Render logs)
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
  });
});

/**
 * -----------------------
 * Admin Reset (TOKEN)
 * -----------------------
 * Token can be sent in:
 *  - Header: x-admin-reset-token
 *  - Header: Authorization: Bearer <token>
 *  - Body: { token }
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
    // ---- AUTH ----
    const provided =
      String(req.body?.token || "").trim() ||
      String(req.headers["x-admin-reset-token"] || "").trim();

    const expected = String(process.env.ADMIN_RESET_TOKEN || "").trim();
    if (!expected) {
      return res.status(500).json({ error: "ADMIN_RESET_TOKEN not set on server" });
    }
    if (provided !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const RESET_IMPL_VERSION = "reset-safe-final-v4";

    /**
     * 🔑 KEY FIX:
     * Only truncate REAL TABLES (relkind = 'r')
     * Views (v) are ignored automatically
     */
    const tableQuery = `
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
    `;

    const { rows } = await pool.query(tableQuery);
    const existingTables = new Set(rows.map(r => r.tablename));

    // Desired logical tables (names your app ever used)
    const wanted = [
      "sales",
      "sale_items",
      "expenses",
      "products",
      "stock_movements",
      "losses",
      "inventory_losses", // ← safe now (will be skipped)
    ];

    const truncated = [];

    for (const name of wanted) {
      if (!existingTables.has(name)) continue;

      await pool.query(
        `TRUNCATE TABLE "${name}" RESTART IDENTITY CASCADE`
      );
      truncated.push(name);
    }

    return res.json({
      ok: true,
      RESET_IMPL_VERSION,
      truncated,
      skipped: wanted.filter(t => !existingTables.has(t)),
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
 * Error handler (also catches CORS errors)
 */
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);
  res.status(500).json({ error: err.message || "Server error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));