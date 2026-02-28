const express = require("express");
const db = require("../db");
const { sendMailWithAttachment } = require("../utils/mailer");

const router = express.Router();

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function parsePeriod(period) {
  const p = String(period || "").toLowerCase();
  return ["daily", "weekly", "monthly", "yearly"].includes(p) ? p : "monthly";
}
function startISO(period) {
  const now = new Date();
  const s = new Date(now);
  if (period === "daily") s.setHours(0, 0, 0, 0);
  if (period === "weekly") s.setDate(now.getDate() - 7);
  if (period === "monthly") { s.setDate(1); s.setHours(0, 0, 0, 0); }
  if (period === "yearly") { s.setMonth(0, 1); s.setHours(0, 0, 0, 0); }
  return s.toISOString();
}
function okAmount(n) { return Number.isFinite(n) && n > 0; }

// SALES
router.get("/sales", async (_req, res) => {
  try {
    const rows = await all(`SELECT * FROM sales ORDER BY datetime(created_at) DESC LIMIT 500`);
    res.json(rows);
  } catch {
    res.status(500).json({ error: "Failed to fetch sales" });
  }
});
router.post("/sales", async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    const description = String(req.body?.description || "").trim();
    if (!okAmount(amount) || !description) return res.status(400).json({ error: "Valid amount and description required" });

    const r = await run(`INSERT INTO sales (amount, description) VALUES (?, ?)`, [amount, description]);
    const row = await get(`SELECT * FROM sales WHERE id=?`, [r.lastID]);
    res.json(row);
  } catch {
    res.status(500).json({ error: "Failed to create sale" });
  }
});
router.put("/sales/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const amount = Number(req.body?.amount);
    const description = String(req.body?.description || "").trim();
    if (!okAmount(amount) || !description) return res.status(400).json({ error: "Valid amount and description required" });

    const ex = await get(`SELECT * FROM sales WHERE id=?`, [id]);
    if (!ex) return res.status(404).json({ error: "Sale not found" });

    await run(`UPDATE sales SET amount=?, description=? WHERE id=?`, [amount, description, id]);
    const row = await get(`SELECT * FROM sales WHERE id=?`, [id]);
    res.json(row);
  } catch {
    res.status(500).json({ error: "Failed to update sale" });
  }
});
router.delete("/sales/:id", async (req, res) => {
  try {
    await run(`DELETE FROM sales WHERE id=?`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to delete sale" });
  }
});

// EXPENSES
router.get("/expenses", async (_req, res) => {
  try {
    const rows = await all(`SELECT * FROM expenses ORDER BY datetime(created_at) DESC LIMIT 500`);
    res.json(rows);
  } catch {
    res.status(500).json({ error: "Failed to fetch expenses" });
  }
});
router.post("/expenses", async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    const description = String(req.body?.description || "").trim();
    if (!okAmount(amount) || !description) return res.status(400).json({ error: "Valid amount and description required" });

    const r = await run(`INSERT INTO expenses (amount, description) VALUES (?, ?)`, [amount, description]);
    const row = await get(`SELECT * FROM expenses WHERE id=?`, [r.lastID]);
    res.json(row);
  } catch {
    res.status(500).json({ error: "Failed to create expense" });
  }
});
router.put("/expenses/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const amount = Number(req.body?.amount);
    const description = String(req.body?.description || "").trim();
    if (!okAmount(amount) || !description) return res.status(400).json({ error: "Valid amount and description required" });

    const ex = await get(`SELECT * FROM expenses WHERE id=?`, [id]);
    if (!ex) return res.status(404).json({ error: "Expense not found" });

    await run(`UPDATE expenses SET amount=?, description=? WHERE id=?`, [amount, description, id]);
    const row = await get(`SELECT * FROM expenses WHERE id=?`, [id]);
    res.json(row);
  } catch {
    res.status(500).json({ error: "Failed to update expense" });
  }
});
router.delete("/expenses/:id", async (req, res) => {
  try {
    await run(`DELETE FROM expenses WHERE id=?`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to delete expense" });
  }
});

// REPORT SUMMARY
router.get("/report", async (req, res) => {
  try {
    const period = parsePeriod(req.query.period);
    const from = startISO(period);

    const s = await all(`SELECT amount FROM sales WHERE datetime(created_at) >= datetime(?)`, [from]);
    const e = await all(`SELECT amount FROM expenses WHERE datetime(created_at) >= datetime(?)`, [from]);

    const totalSales = s.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const totalExpenses = e.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const profit = totalSales - totalExpenses;

    res.json({ period, from, totals: { totalSales, totalExpenses, profit } });
  } catch {
    res.status(500).json({ error: "Failed to generate report" });
  }
});

// EXPORT CSV
router.get("/export/finance.csv", async (req, res) => {
  try {
    const period = parsePeriod(req.query.period);
    const from = startISO(period);

    const sales = await all(
      `SELECT amount, description, created_at FROM sales WHERE datetime(created_at) >= datetime(?) ORDER BY datetime(created_at) DESC`,
      [from]
    );
    const expenses = await all(
      `SELECT amount, description, created_at FROM expenses WHERE datetime(created_at) >= datetime(?) ORDER BY datetime(created_at) DESC`,
      [from]
    );

    const totalSales = sales.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const totalExpenses = expenses.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const profit = totalSales - totalExpenses;

    let csv = "";
    csv += "BUSINESS REPORT\n";
    csv += `Report Type:,${period.toUpperCase()}\n`;
    csv += `Generated On:,${new Date().toLocaleString()}\n\n`;

    csv += "SUMMARY\n";
    csv += "Total Sales (NGN),Total Expenses (NGN),Profit (NGN)\n";
    csv += `${totalSales},${totalExpenses},${profit}\n\n`;

    csv += "DETAILED RECORDS\n";
    csv += "Type,Amount (NGN),Description,Date\n";

    sales.forEach(r => {
      const d = String(r.description || "").replaceAll('"', '""');
      csv += `"Sale",${Number(r.amount) || 0},"${d}","${new Date(r.created_at).toLocaleString()}"\n`;
    });
    expenses.forEach(r => {
      const d = String(r.description || "").replaceAll('"', '""');
      csv += `"Expense",${Number(r.amount) || 0},"${d}","${new Date(r.created_at).toLocaleString()}"\n`;
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=finance-${period}.csv`);
    res.send(csv);
  } catch {
    res.status(500).json({ error: "Failed to export finance CSV" });
  }
});

// EMAIL FINANCE CSV
router.post("/email/finance", async (req, res) => {
  try {
    const to = String(req.body?.to || "").trim();
    const period = parsePeriod(req.body?.period);
    if (!to) return res.status(400).json({ error: "Recipient email is required" });

    // reuse export logic (build csv)
    const from = startISO(period);
    const sales = await all(
      `SELECT amount, description, created_at FROM sales WHERE datetime(created_at) >= datetime(?) ORDER BY datetime(created_at) DESC`,
      [from]
    );
    const expenses = await all(
      `SELECT amount, description, created_at FROM expenses WHERE datetime(created_at) >= datetime(?) ORDER BY datetime(created_at) DESC`,
      [from]
    );

    const totalSales = sales.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const totalExpenses = expenses.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const profit = totalSales - totalExpenses;

    let csv = "";
    csv += "BUSINESS REPORT\n";
    csv += `Report Type:,${period.toUpperCase()}\n`;
    csv += `Generated On:,${new Date().toLocaleString()}\n\n`;
    csv += "SUMMARY\n";
    csv += "Total Sales (NGN),Total Expenses (NGN),Profit (NGN)\n";
    csv += `${totalSales},${totalExpenses},${profit}\n\n`;
    csv += "DETAILED RECORDS\n";
    csv += "Type,Amount (NGN),Description,Date\n";
    sales.forEach(r => {
      const d = String(r.description || "").replaceAll('"', '""');
      csv += `"Sale",${Number(r.amount) || 0},"${d}","${new Date(r.created_at).toLocaleString()}"\n`;
    });
    expenses.forEach(r => {
      const d = String(r.description || "").replaceAll('"', '""');
      csv += `"Expense",${Number(r.amount) || 0},"${d}","${new Date(r.created_at).toLocaleString()}"\n`;
    });

    await sendMailWithAttachment({
      to,
      subject: `Finance Report (${period.toUpperCase()})`,
      text: "Attached is your finance report (summary + detailed records).",
      filename: `finance-${period}-${new Date().toISOString().split("T")[0]}.csv`,
      content: csv
    });

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to send finance email" });
  }
});

module.exports = router;