// ======================
// CONFIG
// ======================
const API_BASE = "http://localhost:5000"; // <-- CHANGE to hosted backend

// ======================
// IndexedDB (Offline Queue + Cache)
// ======================
const DB_NAME = "seabite_offline_db";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains("queue")) {
        db.createObjectStore("queue", { keyPath: "qid", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("sales")) {
        db.createObjectStore("sales", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("expenses")) {
        db.createObjectStore("expenses", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("products")) {
        db.createObjectStore("products", { keyPath: "id" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbPutMany(store, values) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    values.forEach(v => os.put(v));
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function queueAdd(action) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("queue", "readwrite");
    tx.objectStore("queue").add({ ...action, ts: Date.now() });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function queueAll() {
  return idbGetAll("queue");
}

async function queueClearItem(qid) {
  return idbDelete("queue", qid);
}

// ======================
// Network + API
// ======================
let deferredPrompt;
let lastReportType = null;

let sales = [];
let expenses = [];
let products = [];

function formatCurrency(amount) {
  return new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" })
    .format(Number(amount) || 0);
}

function setNetUI() {
  const net = document.getElementById("netStatus");
  if (!net) return;
  net.textContent = navigator.onLine ? "Status: Online" : "Status: Offline (queued)";
}

async function setQueueUI() {
  const q = document.getElementById("queueStatus");
  if (!q) return;
  const items = await queueAll();
  q.textContent = `Pending: ${items.length}`;
}

function getInputValue(id) { return document.getElementById(id)?.value ?? ""; }
function setInputValue(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
function isValidAmount(n) { return Number.isFinite(n) && n > 0; }

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// Try API; if it fails due to offline/network, queue it
async function apiOrQueue(action) {
  try {
    // If offline, queue immediately
    if (!navigator.onLine) throw new Error("offline");
    const data = await api(action.path, action.options);
    return { ok: true, data };
  } catch (e) {
    await queueAdd(action);
    await setQueueUI();
    return { ok: false, queued: true, error: e.message };
  }
}

// ======================
// Mini Chart (Super-light)
// ======================
function updateMiniChart(totalSales, totalExpenses) {
  const miniChart = document.getElementById("miniChart");
  if (!miniChart) return;

  const salesBar = document.getElementById("salesBar");
  const expensesBar = document.getElementById("expensesBar");
  const salesValue = document.getElementById("salesValue");
  const expensesValue = document.getElementById("expensesValue");
  const miniChartTotal = document.getElementById("miniChartTotal");

  const maxVal = Math.max(totalSales, totalExpenses, 1);
  miniChart.style.display = "block";

  salesBar.style.width = `${(totalSales / maxVal) * 100}%`;
  expensesBar.style.width = `${(totalExpenses / maxVal) * 100}%`;

  salesValue.textContent = formatCurrency(totalSales);
  expensesValue.textContent = formatCurrency(totalExpenses);
  miniChartTotal.textContent = `Max: ${formatCurrency(maxVal)}`;
}

// ======================
// Load data (online -> server -> cache; offline -> cache)
// ======================
async function loadAll() {
  setNetUI();
  await setQueueUI();

  if (navigator.onLine) {
    try {
      sales = await api("/api/finance/sales");
      expenses = await api("/api/finance/expenses");
      products = await api("/api/inventory/products");

      // cache snapshots for offline use
      await idbPutMany("sales", sales);
      await idbPutMany("expenses", expenses);
      await idbPutMany("products", products);
    } catch {
      // fallback to cache
      sales = await idbGetAll("sales");
      expenses = await idbGetAll("expenses");
      products = await idbGetAll("products");
    }
  } else {
    sales = await idbGetAll("sales");
    expenses = await idbGetAll("expenses");
    products = await idbGetAll("products");
  }

  renderFinanceTable();
  renderProductsTable();
}

// ======================
// FINANCE CRUD (offline-capable)
// ======================
async function addSale() {
  const amount = parseFloat(getInputValue("saleAmount"));
  const description = getInputValue("saleDesc").trim();
  if (!isValidAmount(amount) || !description) return alert("Enter valid sale amount and description.");

  // optimistic local add
  const temp = { id: `tmp-${Date.now()}`, amount, description, created_at: new Date().toISOString() };
  sales.unshift(temp);
  await idbPut("sales", temp);
  renderFinanceTable();

  setInputValue("saleAmount", "");
  setInputValue("saleDesc", "");

  await apiOrQueue({
    kind: "sale_create",
    path: "/api/finance/sales",
    options: { method: "POST", body: JSON.stringify({ amount, description }) }
  });
}

async function addExpense() {
  const amount = parseFloat(getInputValue("expenseAmount"));
  const description = getInputValue("expenseDesc").trim();
  if (!isValidAmount(amount) || !description) return alert("Enter valid expense amount and description.");

  const temp = { id: `tmp-${Date.now()}`, amount, description, created_at: new Date().toISOString() };
  expenses.unshift(temp);
  await idbPut("expenses", temp);
  renderFinanceTable();

  setInputValue("expenseAmount", "");
  setInputValue("expenseDesc", "");

  await apiOrQueue({
    kind: "expense_create",
    path: "/api/finance/expenses",
    options: { method: "POST", body: JSON.stringify({ amount, description }) }
  });
}

async function deleteRecord(id, type) {
  if (!confirm(`Delete this ${type.toLowerCase()} record?`)) return;

  if (type === "Sale") {
    sales = sales.filter(s => String(s.id) !== String(id));
    await idbDelete("sales", id);
    renderFinanceTable();

    await apiOrQueue({
      kind: "sale_delete",
      path: `/api/finance/sales/${id}`,
      options: { method: "DELETE" }
    });
  } else {
    expenses = expenses.filter(e => String(e.id) !== String(id));
    await idbDelete("expenses", id);
    renderFinanceTable();

    await apiOrQueue({
      kind: "expense_delete",
      path: `/api/finance/expenses/${id}`,
      options: { method: "DELETE" }
    });
  }
}

async function editRecord(id, type) {
  const list = type === "Sale" ? sales : expenses;
  const rec = list.find(x => String(x.id) === String(id));
  if (!rec) return alert("Record not found.");

  const newAmountRaw = prompt("Edit Amount:", rec.amount);
  const newDescRaw = prompt("Edit Description:", rec.description);
  if (newAmountRaw === null || newDescRaw === null) return;

  const amount = parseFloat(newAmountRaw);
  const description = String(newDescRaw).trim();
  if (!isValidAmount(amount) || !description) return alert("Invalid inputs");

  rec.amount = amount;
  rec.description = description;

  if (type === "Sale") await idbPut("sales", rec);
  else await idbPut("expenses", rec);

  renderFinanceTable();

  await apiOrQueue({
    kind: type === "Sale" ? "sale_update" : "expense_update",
    path: type === "Sale" ? `/api/finance/sales/${id}` : `/api/finance/expenses/${id}`,
    options: { method: "PUT", body: JSON.stringify({ amount, description }) }
  });
}

function renderFinanceTable() {
  const table = document.getElementById("recordTable");
  if (!table) return;
  table.innerHTML = "";

  const allRecords = [
    ...sales.map(s => ({ id: s.id, type: "Sale", amount: s.amount, desc: s.description, date: s.created_at })),
    ...expenses.map(e => ({ id: e.id, type: "Expense", amount: e.amount, desc: e.description, date: e.created_at }))
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  allRecords.forEach(item => {
    table.innerHTML += `
      <tr>
        <td>${item.type}</td>
        <td>${formatCurrency(item.amount)}</td>
        <td>${item.desc}</td>
        <td>${new Date(item.date).toLocaleString()}</td>
        <td>
          <div class="action-buttons">
            <button class="edit-btn" type="button" onclick="editRecord('${item.id}', '${item.type}')">Edit</button>
            <button class="delete-btn" type="button" onclick="deleteRecord('${item.id}', '${item.type}')">Delete</button>
          </div>
        </td>
      </tr>
    `;
  });
}

// ======================
// REPORT + EXPORT + EMAIL
// ======================
async function generateReport(type) {
  lastReportType = type;

  if (!navigator.onLine) {
    // offline report based on cached data
    const totalSales = sales.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
    const totalExpenses = expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const profit = totalSales - totalExpenses;

    document.getElementById("reportResult").innerHTML = `
      <h3>${type.toUpperCase()} REPORT (OFFLINE SNAPSHOT)</h3>
      <p>Total Sales: ${formatCurrency(totalSales)}</p>
      <p>Total Expenses: ${formatCurrency(totalExpenses)}</p>
      <p>Profit: ${formatCurrency(profit)}</p>
    `;
    updateMiniChart(totalSales, totalExpenses);
    return;
  }

  const report = await api(`/api/finance/report?period=${encodeURIComponent(type)}`);
  const { totalSales, totalExpenses, profit } = report.totals;

  document.getElementById("reportResult").innerHTML = `
    <h3>${type.toUpperCase()} REPORT</h3>
    <p>Total Sales: ${formatCurrency(totalSales)}</p>
    <p>Total Expenses: ${formatCurrency(totalExpenses)}</p>
    <p>Profit: ${formatCurrency(profit)}</p>
  `;
  updateMiniChart(totalSales, totalExpenses);
}

function exportCSV() {
  if (!lastReportType) return alert("Generate a report first.");
  if (!navigator.onLine) return alert("You must be online to export server CSV.");
  window.open(`${API_BASE}/api/finance/export/finance.csv?period=${encodeURIComponent(lastReportType)}`, "_blank");
}

async function emailFinanceCSV() {
  if (!lastReportType) return alert("Generate a report first.");
  if (!navigator.onLine) return alert("You must be online to email CSV.");

  const to = getInputValue("financeEmail").trim();
  if (!to) return alert("Enter recipient email.");

  await api("/api/finance/email/finance", {
    method: "POST",
    body: JSON.stringify({ to, period: lastReportType })
  });

  alert("✅ Finance report sent!");
  setInputValue("financeEmail", "");
}

// ======================
// INVENTORY (offline-capable)
// ======================
async function addProduct() {
  const name = getInputValue("pName").trim();
  const sku = getInputValue("pSku").trim();
  const unit = getInputValue("pUnit").trim() || "pcs";
  const reorder_level = Number(getInputValue("pReorder")) || 0;
  if (!name) return alert("Product name is required.");

  const temp = {
    id: `tmp-${Date.now()}`,
    name, sku, unit,
    qty: 0,
    reorder_level,
    updated_at: new Date().toISOString()
  };
  products.unshift(temp);
  await idbPut("products", temp);
  renderProductsTable();

  setInputValue("pName", "");
  setInputValue("pSku", "");
  setInputValue("pUnit", "");
  setInputValue("pReorder", "");

  await apiOrQueue({
    kind: "product_create",
    path: "/api/inventory/products",
    options: { method: "POST", body: JSON.stringify({ name, sku, unit, reorder_level }) }
  });
}

async function editProduct(id) {
  const p = products.find(x => String(x.id) === String(id));
  if (!p) return alert("Product not found.");

  const name = prompt("Name:", p.name); if (name === null) return;
  const sku = prompt("SKU:", p.sku || ""); if (sku === null) return;
  const unit = prompt("Unit:", p.unit || "pcs"); if (unit === null) return;
  const reorder = prompt("Reorder level:", p.reorder_level ?? 0); if (reorder === null) return;

  p.name = String(name).trim();
  p.sku = String(sku).trim();
  p.unit = String(unit).trim();
  p.reorder_level = Number(reorder) || 0;
  p.updated_at = new Date().toISOString();

  await idbPut("products", p);
  renderProductsTable();

  await apiOrQueue({
    kind: "product_update",
    path: `/api/inventory/products/${id}`,
    options: { method: "PUT", body: JSON.stringify({ name: p.name, sku: p.sku, unit: p.unit, reorder_level: p.reorder_level }) }
  });
}

async function deleteProduct(id) {
  if (!confirm("Delete this product?")) return;

  products = products.filter(x => String(x.id) !== String(id));
  await idbDelete("products", id);
  renderProductsTable();

  await apiOrQueue({
    kind: "product_delete",
    path: `/api/inventory/products/${id}`,
    options: { method: "DELETE" }
  });
}

async function stockMove(productId, type) {
  const p = products.find(x => String(x.id) === String(productId));
  if (!p) return alert("Product not found.");

  const qtyRaw = prompt(`Enter quantity to Stock ${type}:`, "1");
  if (qtyRaw === null) return;
  const qty = Number(qtyRaw);
  if (!Number.isFinite(qty) || qty <= 0) return alert("Quantity must be > 0");

  const note = prompt("Note (optional):", "") ?? "";

  // optimistic local update
  if (type === "IN") p.qty = Number(p.qty) + qty;
  else {
    if (Number(p.qty) - qty < 0) return alert("Insufficient stock (offline check).");
    p.qty = Number(p.qty) - qty;
  }
  p.updated_at = new Date().toISOString();

  await idbPut("products", p);
  renderProductsTable();

  await apiOrQueue({
    kind: "stock_move",
    path: `/api/inventory/products/${productId}/move`,
    options: { method: "POST", body: JSON.stringify({ type, qty, note }) }
  });
}

function renderProductsTable() {
  const tbody = document.getElementById("productsTable");
  if (!tbody) return;

  tbody.innerHTML = "";
  if (!products.length) {
    tbody.innerHTML = `<tr><td colspan="6">No products yet.</td></tr>`;
    return;
  }

  products.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

  products.forEach(p => {
    const low = Number(p.qty) <= Number(p.reorder_level);
    tbody.innerHTML += `
      <tr>
        <td>${p.name}</td>
        <td>${p.sku || ""}</td>
        <td>${p.unit || "pcs"}</td>
        <td>${low ? `<strong>${p.qty}</strong>` : p.qty}</td>
        <td>${p.reorder_level || 0}</td>
        <td>
          <div class="inv-actions">
            <button class="in-btn" type="button" onclick="stockMove('${p.id}', 'IN')">Stock IN</button>
            <button class="out-btn" type="button" onclick="stockMove('${p.id}', 'OUT')">Stock OUT</button>
            <button class="edit-btn" type="button" onclick="editProduct('${p.id}')">Edit</button>
            <button class="delete-btn" type="button" onclick="deleteProduct('${p.id}')">Delete</button>
          </div>
        </td>
      </tr>
    `;
  });
}

function downloadInventoryCSV() {
  if (!navigator.onLine) return alert("You must be online to export server CSV.");
  window.open(`${API_BASE}/api/inventory/export/inventory.csv`, "_blank");
}

async function emailInventoryCSV() {
  if (!navigator.onLine) return alert("You must be online to email inventory CSV.");
  const to = getInputValue("invEmail").trim();
  if (!to) return alert("Enter recipient email.");

  const status = document.getElementById("invStatus");
  if (status) status.textContent = "Sending...";

  try {
    await api("/api/inventory/email/inventory", { method: "POST", body: JSON.stringify({ to }) });
    if (status) status.textContent = "✅ Inventory report sent!";
    setInputValue("invEmail", "");
  } catch (e) {
    if (status) status.textContent = `❌ Failed: ${e.message}`;
  }
}

// ======================
// SYNC QUEUE
// ======================
async function flushQueue() {
  if (!navigator.onLine) return;

  const items = await queueAll();
  if (!items.length) return;

  // process sequentially to keep order
  for (const item of items) {
    try {
      await api(item.path, item.options);
      await queueClearItem(item.qid);
    } catch {
      // stop at first failure to avoid looping
      break;
    }
  }

  await setQueueUI();

  // after syncing, refresh from server to resolve temp IDs
  await loadAll();
}

document.getElementById("syncBtn")?.addEventListener("click", async () => {
  await flushQueue();
  alert("✅ Sync complete (or nothing to sync).");
});

// Auto sync when back online
window.addEventListener("online", async () => {
  setNetUI();
  await flushQueue();
});
window.addEventListener("offline", () => setNetUI());

// ======================
// PWA
// ======================
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = document.getElementById("installBtn");
  if (btn) btn.style.display = "block";
});

document.getElementById("installBtn")?.addEventListener("click", () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt = null;
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("service-worker.js");
}

// Initial
setNetUI();
loadAll();