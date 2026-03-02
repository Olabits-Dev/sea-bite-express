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
    const provided =
      String(req.headers["x-admin-reset-token"] || "").trim() ||
      (String(req.headers["authorization"] || "").toLowerCase().startsWith("bearer ")
        ? String(req.headers["authorization"]).slice(7).trim()
        : "") ||
      String(req.body?.token || "").trim();

    const expected = String(process.env.ADMIN_RESET_TOKEN || "").trim();

    if (!expected) {
      return res.status(500).json({ error: "ADMIN_RESET_TOKEN is not set on server" });
    }
    if (!provided || provided !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // ✅ Only truncate tables that exist (no more "is not a table" errors)
    const tables = [
      "sale_items",
      "sales",
      "expenses",
      "stock_movements",
      "losses",
      "inventory_losses", // keep it here; it will be skipped if it doesn't exist
      "products",
    ];

    const truncated = [];

    for (const t of tables) {
      const exists = await pool.query("SELECT to_regclass($1) AS reg", [t]);
      if (exists.rows[0]?.reg) {
        await pool.query(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`);
        truncated.push(t);
      }
    }

    return res.json({
      ok: true,
      message: "Database reset completed",
      truncated,
    });
  } catch (e) {
    console.error("RESET ERROR:", e);
    return res.status(500).json({ error: e.message || "Reset failed" });
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