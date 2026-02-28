// Backend/migrate.js
require("dotenv").config();
const { query } = require("./db");

async function migrate() {
  // PRODUCTS
  await query(`
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

  // STOCK MOVEMENTS
  await query(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('IN','OUT')),
      qty NUMERIC NOT NULL,
      note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // SALES
  await query(`
    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      amount NUMERIC NOT NULL,
      description TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // SALE ITEMS (links sale to products used)
  await query(`
    CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id INT NOT NULL REFERENCES products(id),
      qty_used NUMERIC NOT NULL
    );
  `);

  // EXPENSES
  await query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      amount NUMERIC NOT NULL,
      description TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log("✅ Migration completed");
  process.exit(0);
}

migrate().catch((e) => {
  console.error("❌ Migration failed:", e);
  process.exit(1);
});