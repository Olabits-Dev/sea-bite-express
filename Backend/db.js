// Backend/db.js
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn("⚠️ DATABASE_URL is missing. Set it in Render Environment Variables.");
}

/**
 * ✅ Render Postgres commonly requires SSL.
 * Instead of checking the URL domain, use env flags:
 * - Render sets NODE_ENV=production
 * - You can also set PGSSLMODE=require explicitly in Render env
 */
const isProd = process.env.NODE_ENV === "production";
const sslMode = String(process.env.PGSSLMODE || "").toLowerCase(); // e.g. "require"
const useSSL = Boolean(DATABASE_URL) && (isProd || sslMode === "require");

/**
 * ✅ Pool config tuned for small apps on Render
 * - max: prevent too many connections
 * - idleTimeoutMillis: close idle clients
 * - connectionTimeoutMillis: fail fast instead of hanging
 * - keepAlive: reduces random disconnects
 */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 10000),
  keepAlive: true,
});

// ✅ Quick visibility (doesn't leak password)
if (DATABASE_URL) {
  const redacted = DATABASE_URL.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
  console.log(`✅ DB configured (${useSSL ? "SSL" : "No SSL"}) -> ${redacted}`);
}

/**
 * Helpers
 */
async function query(text, params = []) {
  return pool.query(text, params);
}

async function run(text, params = []) {
  const res = await pool.query(text, params);
  return { changes: res.rowCount };
}

async function get(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}

async function all(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows || [];
}

/**
 * ✅ Optional: test connection (useful in server startup)
 */
async function ping() {
  const res = await pool.query("SELECT 1 AS ok");
  return res.rows?.[0]?.ok === 1;
}

// Better error visibility
pool.on("error", (err) => {
  console.error("❌ Unexpected PG pool error:", err);
});

module.exports = { pool, query, run, get, all, ping };