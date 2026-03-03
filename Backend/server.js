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
 * Allows your frontend to call backend safely (including preflight OPTIONS)
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

  // ✅ Your known frontend domains (Render static sites)
  set.add("https://sea-bite-express-1.onrender.com");

  // ✅ If you ever host frontend on same service/domain (rare but safe)
  set.add("https://sea-bite-express.onrender.com");

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
    // allow same-origin / curl / server-to-server (no Origin header)
    if (!origin) return cb(null, true);

    // allow explicit list
    if (allowedOrigins.includes(origin)) return cb(null, true);

    // allow any *.onrender.com frontend (handy during testing)
    if (/^https:\/\/.*\.onrender\.com$/.test(origin)) return cb(null, true);

    // block
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-reset-token"],
  maxAge: 86400,
};

// ✅ CORS should come before body parsing
app.use(cors(corsOptions));

// IMPORTANT: respond to preflight using same cors options
// Express 4 is fine with "*", but this is also compatible if router changes later.
app.options("*", cors(corsOptions));

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
    const provided = readResetToken(req);
    const expected = String(process.env.ADMIN_RESET_TOKEN || "").trim();

    if (!expected) {
      return res.status(500).json({ error: "ADMIN_RESET_TOKEN not set on server" });
    }

    if (!provided || provided !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const RESET_IMPL_VERSION = "reset-safe-final-v6";

    /**
     * ✅ SAFE RESET:
     * Only truncate tables that exist in public schema.
     * (Views won't appear in pg_tables, so they are ignored automatically.)
     */
    const tableQuery = `
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
    `;

    const { rows } = await pool.query(tableQuery);
    const existingTables = new Set(rows.map((r) => r.tablename));

    // Tables used by the app (add/remove as your schema changes)
    const wanted = [
      "sales",
      "sale_items",
      "expenses",
      "products",
      "stock_movements",
      "losses",
      // keep this for backward-compat; will be skipped if it doesn't exist
      "inventory_losses",
    ];

    const truncated = [];
    const skipped = [];

    for (const name of wanted) {
      if (!existingTables.has(name)) {
        skipped.push(name);
        continue;
      }
      await pool.query(`TRUNCATE TABLE "${name}" RESTART IDENTITY CASCADE`);
      truncated.push(name);
    }

    return res.json({
      ok: true,
      RESET_IMPL_VERSION,
      truncated,
      skipped,
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
 * ✅ If CORS blocks, return 403 (not 500) so debugging is clearer.
 */
app.use((err, req, res, next) => {
  const msg = String(err?.message || "Server error");

  if (msg.startsWith("CORS blocked for origin:")) {
    console.error("CORS ERROR:", msg);
    return res.status(403).json({ error: msg });
  }

  console.error("SERVER ERROR:", err);
  res.status(500).json({ error: msg });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));