const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const dbPath = path.join(__dirname, "database.sqlite");
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // INVENTORY
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sku TEXT,
      unit TEXT DEFAULT 'pcs',
      qty REAL DEFAULT 0,
      reorder_level REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('IN','OUT')),
      qty REAL NOT NULL,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(product_id) REFERENCES products(id)
    )
  `);

  // FINANCE
  db.run(`
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
});

module.exports = db;