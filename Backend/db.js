// Backend/db.js
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn("⚠️ DATABASE_URL is missing. Set it in Render Environment Variables.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined,
});

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

module.exports = { pool, query, run, get, all };