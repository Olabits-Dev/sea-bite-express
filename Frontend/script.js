/***********************
 * CONFIG
 ***********************/
const PROD_API_BASE = "https://sea-bite-express.onrender.com"; // ✅ backend
const API_BASE = (() => {
  const host = window.location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host.endsWith(".local");
  return isLocal ? "http://localhost:5000" : PROD_API_BASE;
})();

console.log("API_BASE:", API_BASE);

/***********************
 * HELPERS
 ***********************/
function $(id) { return document.getElementById(id); }
function getVal(id) { return $(id)?.value ?? ""; }
function setVal(id, v) { const el = $(id); if (el) el.value = v; }

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatCurrency(amount) {
  return new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" }).format(Number(amount) || 0);
}

function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function isValidAmount(n) { return Number.isFinite(n) && n > 0; }
function isValidQty(n) { return Number.isFinite(n) && n > 0; }

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function cleanStr(v, fallback = "") { return String(v ?? fallback).trim(); }

function normalizeCategory(v) {
  const s = String(v || "").trim().toUpperCase();
  if (s === "SEAFOOD") return "SEAFOOD";
  if (s === "KITCHEN" || s === "OTHER" || s === "OTHER_KITCHEN" || s === "OTHER KITCHEN") return "KITCHEN";
  return "KITCHEN";
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Seafood conversions
function calcPortionFromQty(qty, portionSize) {
  const ps = Number(portionSize) || 0;
  if (ps <= 0) return 0;
  return qty / ps;
}
function calcQtyFromPortion(portion, portionSize) {
  const ps = Number(portionSize) || 0;
  if (ps <= 0) return 0;
  return portion * ps;
}

/**
 * ✅ FIXED: mailto needs to be triggered directly from a user action.
 * Also adds a fallback when mail client isn't configured.
 */
function openMailto(to, subject, body) {
  const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  const before = Date.now();
  try { window.location.href = url; } catch {}

  setTimeout(() => {
    const ok = confirm(
      "Your browser/device may not have a default email app configured.\n\n" +
      "Tap OK to copy the email content, then paste it into Gmail/Yahoo app."
    );
    if (ok) {
      const text = `To: ${to}\nSubject: ${subject}\n\n${body}`;
      (navigator.clipboard?.writeText(text) || Promise.resolve())
        .then(() => alert("✅ Email content copied. Open your email app and paste it."))
        .catch(() => alert("⚠️ Could not copy automatically. Please manually copy the email text from the page."));
    }
  }, Math.max(800, Date.now() - before));
}

function isNetworkMailError(msg = "") {
  const m = String(msg).toUpperCase();
  return (
    m.includes("ENETUNREACH") ||
    m.includes("ECONNREFUSED") ||
    m.includes("ETIMEDOUT") ||
    m.includes("EHOSTUNREACH") ||
    m.includes("NETWORK") ||
    m.includes("UNREACH")
  );
}

function isMailNotConfigured(payloadOrMsg) {
  const raw = typeof payloadOrMsg === "string" ? payloadOrMsg : (payloadOrMsg?.error || "");
  return String(raw).toUpperCase().includes("EMAIL NOT CONFIGURED");
}

/***********************
 * CSV HELPERS
 ***********************/
function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadTextFile(filename, text, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/***********************
 * STATUS UI
 ***********************/
function setNetUI() {
  const net = $("netStatus");
  if (!net) return;
  net.textContent = navigator.onLine ? "Status: Online" : "Status: Offline (queued)";
}

async function setQueueUI() {
  const q = $("queueStatus");
  if (!q) return;
  const items = await queueAll();
  q.textContent = `Pending: ${items.length}`;
}

/***********************
 * IndexedDB (offline queue + cached data)
 ***********************/
const DB_NAME = "seabite_offline_db";
/**
 * ⬇️ bumped to 4 because we added new product fields (category/portion_size)
 */
const DB_VERSION = 4;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "qid", autoIncrement: true });
      if (!db.objectStoreNames.contains("sales")) db.createObjectStore("sales", { keyPath: "id" });
      if (!db.objectStoreNames.contains("expenses")) db.createObjectStore("expenses", { keyPath: "id" });
      if (!db.objectStoreNames.contains("products")) db.createObjectStore("products", { keyPath: "id" });
      if (!db.objectStoreNames.contains("losses")) db.createObjectStore("losses", { keyPath: "id" });
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

/***********************
 * Queue
 ***********************/
async function queueAdd(action) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("queue", "readwrite");
    tx.objectStore("queue").add({ ...action, ts: Date.now() });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function queueAll() { return idbGetAll("queue"); }
async function queueClearItem(qid) { return idbDelete("queue", qid); }

/***********************
 * API
 ***********************/
async function api(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const headers = { ...(options.headers || {}) };
  const hasBody = options.body !== undefined && options.body !== null;
  if (hasBody && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(url, { ...options, headers });
  } catch (e) {
    const err = new Error(`Network error: Backend unreachable (${API_BASE})`);
    err.data = { error: err.message };
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.data = data;
    err.status = res.status;
    throw err;
  }

  return data;
}

async function apiOrQueue(action) {
  try {
    if (!navigator.onLine) throw new Error("offline");
    const data = await api(action.path, action.options);
    return { ok: true, data };
  } catch (e) {
    await queueAdd(action);
    await setQueueUI();
    return { ok: false, queued: true, error: e.message };
  }
}

/***********************
 * STATE
 ***********************/
let deferredPrompt;
let lastReportType = null;

let sales = [];
let expenses = [];
let products = [];
let losses = [];
let pendingUsage = [];

/***********************
 * MINI CHART
 ***********************/
function updateMiniChart(totalSales, totalExpenses) {
  const miniChart = $("miniChart");
  if (!miniChart) return;

  const salesBar = $("salesBar");
  const expensesBar = $("expensesBar");
  const salesValue = $("salesValue");
  const expensesValue = $("expensesValue");
  const miniChartTotal = $("miniChartTotal");

  const maxVal = Math.max(totalSales, totalExpenses, 1);
  miniChart.style.display = "block";

  salesBar.style.width = `${(totalSales / maxVal) * 100}%`;
  expensesBar.style.width = `${(totalExpenses / maxVal) * 100}%`;

  salesValue.textContent = formatCurrency(totalSales);
  expensesValue.textContent = formatCurrency(totalExpenses);
  miniChartTotal.textContent = `Max: ${formatCurrency(maxVal)}`;
}

/***********************
 * LOAD DATA
 ***********************/
function normalizeProducts(list) {
  return (list || []).map(p => {
    const cat = normalizeCategory(p.category);
    const qty = toNumber(p.qty, 0);
    const ps = toNumber(p.portion_size, 0);
    const portion = cat === "SEAFOOD" ? round2(calcPortionFromQty(qty, ps)) : undefined;
    return {
      ...p,
      category: cat,
      qty,
      portion_size: ps,
      portion,
      unit: p.unit || "pcs",
      reorder_level: toNumber(p.reorder_level, 0),
    };
  });
}

async function loadAll() {
  setNetUI();
  await setQueueUI();

  if (navigator.onLine) {
    try {
      sales = await api("/api/finance/sales");
      expenses = await api("/api/finance/expenses");
      products = normalizeProducts(await api("/api/inventory/products"));
      losses = await api("/api/inventory/losses");

      await idbPutMany("sales", sales);
      await idbPutMany("expenses", expenses);
      await idbPutMany("products", products);
      await idbPutMany("losses", losses);
    } catch {
      sales = await idbGetAll("sales");
      expenses = await idbGetAll("expenses");
      products = normalizeProducts(await idbGetAll("products"));
      losses = await idbGetAll("losses");
    }
  } else {
    sales = await idbGetAll("sales");
    expenses = await idbGetAll("expenses");
    products = normalizeProducts(await idbGetAll("products"));
    losses = await idbGetAll("losses");
  }

  renderFinanceTable();
  renderProductsTables(); // ✅ NEW (split tables)
  renderUsageSummary();
  renderLossTable();
}

/***********************
 * PRODUCTS USED MODAL
 ***********************/
function openUsageModal() {
  if (!products.length) {
    alert("No products in inventory yet. Add products first.");
    return;
  }

  const usable = products
    .filter(p => Number(p.qty) > 0)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const modal = $("usageModal");
  const list = $("usageList");
  if (!modal || !list) return;

  list.innerHTML = "";

  if (!usable.length) {
    list.innerHTML = `
      <div class="usage-row">
        <div>
          <div class="u-name">No stocked products</div>
          <div class="u-meta">Stock IN some items first.</div>
        </div>
      </div>
    `;
  } else {
    usable.forEach(p => {
      const existing = pendingUsage.find(x => String(x.product_id) === String(p.id));
      const val = existing ? Number(existing.qty_used) : 0;

      const row = document.createElement("div");
      row.className = "usage-row";
      row.innerHTML = `
        <div>
          <div class="u-name">${escapeHtml(p.name)}</div>
          <div class="u-meta">Available: ${p.qty} ${escapeHtml(p.unit || "")}</div>
        </div>
        <input type="number" min="0" step="any" inputmode="decimal"
               data-pid="${p.id}" placeholder="Qty used" value="${val}" />
      `;
      list.appendChild(row);
    });
  }

  modal.classList.add("show");
  modal.setAttribute("aria-hidden", "false");
}

function closeUsageModal() {
  const modal = $("usageModal");
  if (!modal) return;
  modal.classList.remove("show");
  modal.setAttribute("aria-hidden", "true");
}

function clearUsage() {
  pendingUsage = [];
  renderUsageSummary();
  const list = $("usageList");
  if (!list) return;
  list.querySelectorAll("input[data-pid]").forEach(i => (i.value = 0));
}

function saveUsage() {
  const list = $("usageList");
  if (!list) return;

  const inputs = Array.from(list.querySelectorAll("input[data-pid]"));
  const next = [];

  for (const inp of inputs) {
    const pid = Number(inp.getAttribute("data-pid"));
    const qty = Number(inp.value || 0);
    if (qty > 0) next.push({ product_id: pid, qty_used: qty });
  }

  pendingUsage = next;
  renderUsageSummary();
  closeUsageModal();
}

function renderUsageSummary() {
  const box = $("usageSummary");
  if (!box) return;

  if (!pendingUsage.length) {
    box.textContent = "No products selected.";
    return;
  }

  const lines = pendingUsage.map(it => {
    const p = products.find(x => Number(x.id) === Number(it.product_id));
    const name = p ? p.name : `Product#${it.product_id}`;
    const unit = p?.unit ? ` ${p.unit}` : "";
    return `${name} x${it.qty_used}${unit}`;
  });

  box.textContent = lines.join(" • ");
}

/***********************
 * FINANCE CRUD
 ***********************/
function formatProductsUsed(items) {
  if (!items || !items.length) return "";
  return items
    .map(it => `${it.product_name || ""} x${it.qty_used}${it.product_unit ? " " + it.product_unit : ""}`.trim())
    .join(", ");
}

function renderFinanceTable() {
  const table = $("recordTable");
  if (!table) return;
  table.innerHTML = "";

  const allRecords = [
    ...sales.map(s => ({
      id: s.id,
      type: "Sale",
      amount: s.amount,
      desc: s.description,
      used: formatProductsUsed(s.items),
      date: s.created_at
    })),
    ...expenses.map(e => ({
      id: e.id,
      type: "Expense",
      amount: e.amount,
      desc: e.description,
      used: "",
      date: e.created_at
    }))
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  allRecords.forEach(item => {
    table.innerHTML += `
      <tr>
        <td>${item.type}</td>
        <td>${formatCurrency(item.amount)}</td>
        <td>${escapeHtml(item.desc)}</td>
        <td>${escapeHtml(item.used)}</td>
        <td>${formatDateTime(item.date)}</td>
        <td>
          <div class="action-buttons">
            <button class="edit-btn" type="button" onclick="editRecord('${item.id}','${item.type}')">Edit</button>
            <button class="delete-btn" type="button" onclick="deleteRecord('${item.id}','${item.type}')">Delete</button>
          </div>
        </td>
      </tr>
    `;
  });
}

async function addSale() {
  const amount = parseFloat(getVal("saleAmount"));
  const description = getVal("saleDesc").trim();

  if (!isValidAmount(amount) || !description) {
    alert("Enter valid sale amount and description.");
    return;
  }

  if (products.length && pendingUsage.length === 0) {
    const ok = confirm("Do you want to record products used for this sale? (Recommended)");
    if (ok) {
      openUsageModal();
      return;
    }
  }

  for (const it of pendingUsage) {
    const p = products.find(x => Number(x.id) === Number(it.product_id));
    if (p && Number(p.qty) - Number(it.qty_used) < 0) {
      alert(`Insufficient stock for ${p.name}. Reduce qty used.`);
      return;
    }
  }

  const tempId = `tmp-${Date.now()}`;
  const saleTemp = {
    id: tempId,
    amount,
    description,
    created_at: new Date().toISOString(),
    items: pendingUsage.map(it => {
      const p = products.find(x => Number(x.id) === Number(it.product_id));
      return {
        product_id: it.product_id,
        qty_used: it.qty_used,
        product_name: p?.name || "",
        product_unit: p?.unit || ""
      };
    })
  };

  sales.unshift(saleTemp);
  await idbPut("sales", saleTemp);

  for (const it of pendingUsage) {
    const p = products.find(x => Number(x.id) === Number(it.product_id));
    if (p) {
      p.qty = Number(p.qty) - Number(it.qty_used);
      if (p.category === "SEAFOOD") {
        p.portion = round2(calcPortionFromQty(p.qty, p.portion_size));
      }
      p.updated_at = new Date().toISOString();
      await idbPut("products", p);
    }
  }

  renderFinanceTable();
  renderProductsTables();

  setVal("saleAmount", "");
  setVal("saleDesc", "");
  pendingUsage = [];
  renderUsageSummary();

  const result = await apiOrQueue({
    kind: "sale_create",
    path: "/api/finance/sales",
    options: {
      method: "POST",
      body: JSON.stringify({
        amount,
        description,
        items: saleTemp.items.map(x => ({ product_id: x.product_id, qty_used: x.qty_used }))
      })
    }
  });

  if (navigator.onLine && !result.ok) {
    alert(`Sale failed: ${result.error}`);
    await loadAll();
  } else if (navigator.onLine && result.ok) {
    await loadAll();
  }
}

async function addExpense() {
  const amount = parseFloat(getVal("expenseAmount"));
  const description = getVal("expenseDesc").trim();

  if (!isValidAmount(amount) || !description) {
    alert("Enter valid expense amount and description.");
    return;
  }

  const temp = { id: `tmp-${Date.now()}`, amount, description, created_at: new Date().toISOString() };

  expenses.unshift(temp);
  await idbPut("expenses", temp);
  renderFinanceTable();

  setVal("expenseAmount", "");
  setVal("expenseDesc", "");

  const result = await apiOrQueue({
    kind: "expense_create",
    path: "/api/finance/expenses",
    options: { method: "POST", body: JSON.stringify({ amount, description }) }
  });

  if (navigator.onLine && !result.ok) {
    alert(`Expense failed: ${result.error}`);
    await loadAll();
  } else if (navigator.onLine && result.ok) {
    await loadAll();
  }
}

async function deleteRecord(id, type) {
  if (!confirm(`Delete this ${type.toLowerCase()} record?`)) return;

  if (type === "Sale") {
    sales = sales.filter(s => String(s.id) !== String(id));
    await idbDelete("sales", id);
    renderFinanceTable();

    const result = await apiOrQueue({
      kind: "sale_delete",
      path: `/api/finance/sales/${id}`,
      options: { method: "DELETE" }
    });

    if (navigator.onLine && !result.ok) {
      alert(`Delete failed: ${result.error}`);
      await loadAll();
    } else if (navigator.onLine && result.ok) {
      await loadAll();
    }
    return;
  }

  expenses = expenses.filter(e => String(e.id) !== String(id));
  await idbDelete("expenses", id);
  renderFinanceTable();

  const result = await apiOrQueue({
    kind: "expense_delete",
    path: `/api/finance/expenses/${id}`,
    options: { method: "DELETE" }
    });

  if (navigator.onLine && !result.ok) {
    alert(`Delete failed: ${result.error}`);
    await loadAll();
  } else if (navigator.onLine && result.ok) {
    await loadAll();
  }
}

async function editRecord(id, type) {
  if (type === "Sale") {
    const rec = sales.find(x => String(x.id) === String(id));
    if (!rec) return alert("Record not found.");

    const newAmountRaw = prompt("Edit Amount:", rec.amount);
    const newDescRaw = prompt("Edit Description:", rec.description);
    if (newAmountRaw === null || newDescRaw === null) return;

    const amount = parseFloat(newAmountRaw);
    const description = String(newDescRaw).trim();
    if (!isValidAmount(amount) || !description) return alert("Invalid inputs");

    rec.amount = amount;
    rec.description = description;

    await idbPut("sales", rec);
    renderFinanceTable();

    const result = await apiOrQueue({
      kind: "sale_update",
      path: `/api/finance/sales/${id}`,
      options: { method: "PUT", body: JSON.stringify({ amount, description }) }
    });

    if (navigator.onLine && !result.ok) {
      alert(`Update failed: ${result.error}`);
      await loadAll();
    } else if (navigator.onLine && result.ok) {
      await loadAll();
    }
    return;
  }

  const rec = expenses.find(x => String(x.id) === String(id));
  if (!rec) return alert("Record not found.");

  const newAmountRaw = prompt("Edit Amount:", rec.amount);
  const newDescRaw = prompt("Edit Description:", rec.description);
  if (newAmountRaw === null || newDescRaw === null) return;

  const amount = parseFloat(newAmountRaw);
  const description = String(newDescRaw).trim();
  if (!isValidAmount(amount) || !description) return alert("Invalid inputs");

  rec.amount = amount;
  rec.description = description;

  await idbPut("expenses", rec);
  renderFinanceTable();

  const result = await apiOrQueue({
    kind: "expense_update",
    path: `/api/finance/expenses/${id}`,
    options: { method: "PUT", body: JSON.stringify({ amount, description }) }
  });

  if (navigator.onLine && !result.ok) {
    alert(`Update failed: ${result.error}`);
    await loadAll();
  } else if (navigator.onLine && result.ok) {
    await loadAll();
  }
}

/***********************
 * REPORTS / CSV
 ***********************/
async function generateReport(type) {
  lastReportType = type;

  if (!navigator.onLine) {
    const totalSales = sales.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
    const totalExpenses = expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const profit = totalSales - totalExpenses;

    $("reportResult").innerHTML = `
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

  $("reportResult").innerHTML = `
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

/***********************
 * INVENTORY (SEAFOOD + KITCHEN)
 ***********************/
async function addProduct() {
  const name = cleanStr(getVal("pName"));
  const sku = cleanStr(getVal("pSku"));
  const category = normalizeCategory(getVal("pCategory"));
  const unit = cleanStr(getVal("pUnit")) || "pcs";
  const reorder_level = toNumber(getVal("pReorder"), 0);
  const portion_size = toNumber(getVal("pPortionSize"), 0); // qty per 1 portion (seafood only)

  if (!name) return alert("Product name is required.");

  if (category === "SEAFOOD" && portion_size <= 0) {
    return alert("Seafood needs 'Qty per 1 Portion' (example: 2).");
  }

  const initialQtyRaw = prompt("Initial QUANTITY to Stock IN now?", "0");
  if (initialQtyRaw === null) return;
  const initial_qty = toNumber(initialQtyRaw, 0);
  if (initial_qty < 0) return alert("Initial quantity must be 0 or more.");

  const temp = {
    id: `tmp-${Date.now()}`,
    name,
    sku,
    category,
    unit: category === "SEAFOOD" ? (unit || "qty") : unit,
    qty: initial_qty,
    portion_size: category === "SEAFOOD" ? portion_size : 0,
    portion: category === "SEAFOOD" ? round2(calcPortionFromQty(initial_qty, portion_size)) : undefined,
    reorder_level,
    updated_at: new Date().toISOString()
  };

  products.unshift(temp);
  await idbPut("products", temp);

  renderProductsTables();
  renderUsageSummary();

  setVal("pName", "");
  setVal("pSku", "");
  setVal("pUnit", "");
  setVal("pPortionSize", "");
  setVal("pReorder", "");

  const result = await apiOrQueue({
    kind: "product_create",
    path: "/api/inventory/products",
    options: {
      method: "POST",
      body: JSON.stringify({
        name,
        sku,
        category,
        unit,
        reorder_level,
        initial_qty,
        portion_size: category === "SEAFOOD" ? portion_size : null
      })
    }
  });

  if (navigator.onLine && !result.ok) {
    alert(`Product create failed: ${result.error}`);
    await loadAll();
  } else if (navigator.onLine && result.ok) {
    await loadAll();
  }
}

async function editProduct(id) {
  const p = products.find(x => String(x.id) === String(id));
  if (!p) return alert("Product not found.");

  const name = prompt("Name:", p.name); if (name === null) return;
  const sku = prompt("SKU:", p.sku || ""); if (sku === null) return;

  const category = normalizeCategory(prompt("Category (SEAFOOD or KITCHEN):", p.category || "KITCHEN"));
  if (!category) return;

  let unit = p.unit || "pcs";
  let portion_size = toNumber(p.portion_size, 0);

  if (category === "SEAFOOD") {
    const ps = prompt("Qty per 1 Portion:", String(portion_size || ""));
    if (ps === null) return;
    portion_size = toNumber(ps, 0);
    if (portion_size <= 0) return alert("Qty per Portion must be > 0 for Seafood.");
  } else {
    const u = prompt("Unit:", p.unit || "pcs");
    if (u === null) return;
    unit = cleanStr(u) || "pcs";
    portion_size = 0;
  }

  const reorder = prompt("Reorder level:", p.reorder_level ?? 0); if (reorder === null) return;

  p.name = cleanStr(name);
  p.sku = cleanStr(sku);
  p.category = category;
  p.unit = unit;
  p.portion_size = portion_size;
  p.reorder_level = toNumber(reorder, 0);
  if (p.category === "SEAFOOD") {
    p.portion = round2(calcPortionFromQty(toNumber(p.qty, 0), p.portion_size));
  } else {
    p.portion = undefined;
  }
  p.updated_at = new Date().toISOString();

  await idbPut("products", p);
  renderProductsTables();
  renderUsageSummary();

  const result = await apiOrQueue({
    kind: "product_update",
    path: `/api/inventory/products/${id}`,
    options: {
      method: "PUT",
      body: JSON.stringify({
        name: p.name,
        sku: p.sku,
        category: p.category,
        unit: p.unit,
        reorder_level: p.reorder_level,
        portion_size: p.category === "SEAFOOD" ? p.portion_size : null
      })
    }
  });

  if (navigator.onLine && !result.ok) {
    alert(`Product update failed: ${result.error}`);
    await loadAll();
  } else if (navigator.onLine && result.ok) {
    await loadAll();
  }
}

async function deleteProduct(id) {
  if (!confirm("Delete this product?")) return;

  products = products.filter(x => String(x.id) !== String(id));
  await idbDelete("products", id);
  pendingUsage = pendingUsage.filter(x => String(x.product_id) !== String(id));

  renderProductsTables();
  renderUsageSummary();

  const result = await apiOrQueue({
    kind: "product_delete",
    path: `/api/inventory/products/${id}`,
    options: { method: "DELETE" }
  });

  if (navigator.onLine && !result.ok) {
    alert(`Product delete failed: ${result.error}`);
    await loadAll();
  } else if (navigator.onLine && result.ok) {
    await loadAll();
  }
}

/**
 * ✅ Stock move:
 * - Seafood: choose Quantity or Portion; sync both.
 * - Kitchen: Quantity only.
 */
async function stockMove(productId, type) {
  const p = products.find(x => String(x.id) === String(productId));
  if (!p) return alert("Product not found.");

  const note = prompt("Note (optional):", "") ?? "";

  let deltaQty = 0;
  let label = "";

  if (p.category === "SEAFOOD") {
    const mode = prompt("Stock by: QTY or PORTION?", "QTY");
    if (mode === null) return;
    const m = String(mode).trim().toUpperCase();

    if (m === "PORTION") {
      const portionRaw = prompt(`Enter PORTION to Stock ${type}:`, "1");
      if (portionRaw === null) return;
      const portion = toNumber(portionRaw, 0);
      if (!isValidQty(portion)) return alert("Portion must be > 0");

      deltaQty = calcQtyFromPortion(portion, p.portion_size);
      label = `${round2(portion)} portion`;
    } else {
      const qtyRaw = prompt(`Enter QUANTITY to Stock ${type}:`, "1");
      if (qtyRaw === null) return;
      const qty = toNumber(qtyRaw, 0);
      if (!isValidQty(qty)) return alert("Quantity must be > 0");

      deltaQty = qty;
      label = `${round2(qty)} qty`;
    }
  } else {
    const qtyRaw = prompt(`Enter quantity to Stock ${type}:`, "1");
    if (qtyRaw === null) return;
    const qty = toNumber(qtyRaw, 0);
    if (!isValidQty(qty)) return alert("Quantity must be > 0");
    deltaQty = qty;
    label = `${round2(qty)} ${p.unit || ""}`.trim();
  }

  const nextQty = type === "IN" ? (toNumber(p.qty, 0) + deltaQty) : (toNumber(p.qty, 0) - deltaQty);
  if (type === "OUT" && nextQty < 0) return alert("Insufficient stock.");

  // optimistic update
  p.qty = nextQty;
  if (p.category === "SEAFOOD") {
    p.portion = round2(calcPortionFromQty(p.qty, p.portion_size));
  }
  p.updated_at = new Date().toISOString();
  await idbPut("products", p);

  renderProductsTables();
  renderUsageSummary();

  const result = await apiOrQueue({
    kind: "stock_move",
    path: `/api/inventory/products/${productId}/move`,
    options: {
      method: "POST",
      body: JSON.stringify({
        type,
        qty: deltaQty,
        note: note ? `${note} (${label})` : `(${label})`
      })
    }
  });

  if (navigator.onLine && !result.ok) {
    alert(`Stock move failed: ${result.error}`);
    await loadAll();
  } else if (navigator.onLine && result.ok) {
    await loadAll();
  }
}

async function recordLoss(productId, reason) {
  const p = products.find(x => String(x.id) === String(productId));
  if (!p) return alert("Product not found.");

  let qty = 0;

  if (p.category === "SEAFOOD") {
    const mode = prompt("Loss by: QTY or PORTION?", "QTY");
    if (mode === null) return;
    const m = String(mode).trim().toUpperCase();

    if (m === "PORTION") {
      const portionRaw = prompt(`Enter PORTION for ${reason}:`, "1");
      if (portionRaw === null) return;
      const portion = toNumber(portionRaw, 0);
      if (!isValidQty(portion)) return alert("Portion must be > 0");
      qty = calcQtyFromPortion(portion, p.portion_size);
    } else {
      const qtyRaw = prompt(`Enter QUANTITY for ${reason}:`, "1");
      if (qtyRaw === null) return;
      qty = toNumber(qtyRaw, 0);
      if (!isValidQty(qty)) return alert("Quantity must be > 0");
    }
  } else {
    const qtyRaw = prompt(`Enter quantity for ${reason}:`, "1");
    if (qtyRaw === null) return;
    qty = toNumber(qtyRaw, 0);
    if (!isValidQty(qty)) return alert("Quantity must be > 0");
  }

  const note = prompt("Note (optional):", "") ?? "";

  if (toNumber(p.qty, 0) - qty < 0) return alert("Insufficient stock.");

  // optimistic product update
  p.qty = toNumber(p.qty, 0) - qty;
  if (p.category === "SEAFOOD") p.portion = round2(calcPortionFromQty(p.qty, p.portion_size));
  p.updated_at = new Date().toISOString();
  await idbPut("products", p);

  // optimistic loss entry
  const tmpLoss = {
    id: `tmp-${Date.now()}`,
    product_id: Number(productId),
    product_name: p.name,
    product_unit: p.unit || "",
    qty,
    reason: String(reason || "").toUpperCase(),
    note,
    created_at: new Date().toISOString()
  };
  losses.unshift(tmpLoss);
  await idbPut("losses", tmpLoss);

  renderProductsTables();
  renderUsageSummary();
  renderLossTable();

  const result = await apiOrQueue({
    kind: "stock_loss",
    path: `/api/inventory/products/${productId}/loss`,
    options: { method: "POST", body: JSON.stringify({ qty, reason, note }) }
  });

  if (navigator.onLine && !result.ok) {
    alert(`Loss record failed: ${result.error}`);
    await loadAll();
  } else if (navigator.onLine && result.ok) {
    await loadAll();
  }
}

/***********************
 * LOSS HISTORY TABLE
 ***********************/
function renderLossTable() {
  const tbody = $("lossTable");
  if (!tbody) return;

  tbody.innerHTML = "";

  if (!losses.length) {
    tbody.innerHTML = `<tr><td colspan="6">No loss records yet.</td></tr>`;
    return;
  }

  const sorted = [...losses].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  sorted.forEach(l => {
    const productName = l.product_name || l.name || `Product#${l.product_id ?? ""}`;
    const qty = Number(l.qty ?? l.qty_lost ?? 0) || 0;
    const unit = l.product_unit || l.unit || "";
    const reason = String(l.reason || "").toUpperCase();
    const date = l.created_at || l.date || "";

    tbody.innerHTML += `
      <tr>
        <td>${escapeHtml(productName)}</td>
        <td>${round2(qty)}</td>
        <td>${escapeHtml(unit)}</td>
        <td>${escapeHtml(reason)}</td>
        <td>${formatDateTime(date)}</td>
        <td>
          <div class="action-buttons">
            <button class="edit-btn" type="button" onclick="editLoss('${l.id}')">Edit</button>
            <button class="delete-btn" type="button" onclick="deleteLoss('${l.id}')">Delete</button>
          </div>
        </td>
      </tr>
    `;
  });
}

async function editLoss(lossId) {
  const rec = losses.find(x => String(x.id) === String(lossId));
  if (!rec) return alert("Loss record not found.");

  const newQtyRaw = prompt("Edit loss Qty:", rec.qty ?? rec.qty_lost ?? 1);
  if (newQtyRaw === null) return;

  const newReasonRaw = prompt("Edit reason (SPOILAGE or MISHANDLING):", String(rec.reason || "").toUpperCase());
  if (newReasonRaw === null) return;

  const qty = toNumber(newQtyRaw, 0);
  const reason = String(newReasonRaw).trim().toUpperCase();

  if (!isValidQty(qty)) return alert("Qty must be > 0");
  if (!["SPOILAGE", "MISHANDLING"].includes(reason)) return alert("Reason must be SPOILAGE or MISHANDLING");

  const note = prompt("Edit note (optional):", rec.note || "") ?? (rec.note || "");

  rec.qty = qty;
  rec.reason = reason;
  rec.note = note;
  await idbPut("losses", rec);
  renderLossTable();

  const result = await apiOrQueue({
    kind: "loss_update",
    path: `/api/inventory/losses/${lossId}`,
    options: { method: "PUT", body: JSON.stringify({ qty, reason, note }) }
  });

  if (navigator.onLine && !result.ok) {
    alert(`Loss update failed: ${result.error}`);
    await loadAll();
  } else if (navigator.onLine && result.ok) {
    await loadAll();
  }
}

async function deleteLoss(lossId) {
  if (!confirm("Delete this loss record?")) return;

  losses = losses.filter(x => String(x.id) !== String(lossId));
  await idbDelete("losses", lossId);
  renderLossTable();

  const result = await apiOrQueue({
    kind: "loss_delete",
    path: `/api/inventory/losses/${lossId}`,
    options: { method: "DELETE" }
  });

  if (navigator.onLine && !result.ok) {
    alert(`Loss delete failed: ${result.error}`);
    await loadAll();
  } else if (navigator.onLine && result.ok) {
    await loadAll();
  }
}

function exportLossCSV() {
  const rows = [...losses].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  let csv = "";
  csv += "LOSS HISTORY\n";
  csv += `Generated On,${csvEscape(new Date().toLocaleString())}\n\n`;
  csv += "Product,Qty,Unit,Reason,Date,Note\n";

  for (const l of rows) {
    const productName = l.product_name || l.name || `Product#${l.product_id ?? ""}`;
    const qty = Number(l.qty ?? l.qty_lost ?? 0) || 0;
    const unit = l.product_unit || l.unit || "";
    const reason = String(l.reason || "").toUpperCase();
    const date = formatDateTime(l.created_at || l.date || "");
    const note = l.note || "";

    csv += [
      csvEscape(productName),
      csvEscape(round2(qty)),
      csvEscape(unit),
      csvEscape(reason),
      csvEscape(date),
      csvEscape(note),
    ].join(",") + "\n";
  }

  const filename = `loss-history-${new Date().toISOString().slice(0, 10)}.csv`;
  downloadTextFile(filename, csv, "text/csv;charset=utf-8");
}

/***********************
 * RENDER INVENTORY TABLES (SEAFOOD + KITCHEN)
 ***********************/
function renderProductsTables() {
  const seafoodBody = $("seafoodTable");
  const kitchenBody = $("kitchenTable");

  // Backward compatibility (if old html still exists)
  const legacyBody = $("productsTable");

  const seafood = products.filter(p => normalizeCategory(p.category) === "SEAFOOD");
  const kitchen = products.filter(p => normalizeCategory(p.category) === "KITCHEN");

  const sortFn = (a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
  seafood.sort(sortFn);
  kitchen.sort(sortFn);

  if (seafoodBody) {
    seafoodBody.innerHTML = "";
    if (!seafood.length) {
      seafoodBody.innerHTML = `<tr><td colspan="6">No seafood products yet.</td></tr>`;
    } else {
      seafood.forEach(p => {
        const portion = round2(calcPortionFromQty(toNumber(p.qty, 0), toNumber(p.portion_size, 0)));
        seafoodBody.innerHTML += `
          <tr>
            <td>${escapeHtml(p.name)}</td>
            <td>${escapeHtml(p.sku || "")}</td>
            <td>${round2(toNumber(p.qty, 0))}</td>
            <td>${portion}</td>
            <td>${toNumber(p.reorder_level, 0)}</td>
            <td>
              <div class="inv-actions">
                <button class="in-btn" type="button" onclick="stockMove('${p.id}', 'IN')">Stock IN</button>
                <button class="out-btn" type="button" onclick="stockMove('${p.id}', 'OUT')">Stock OUT</button>
                <button class="warn-btn" type="button" onclick="recordLoss('${p.id}', 'SPOILAGE')">Spoilage</button>
                <button class="warn-btn" type="button" onclick="recordLoss('${p.id}', 'MISHANDLING')">Mishandling</button>
                <button class="edit-btn" type="button" onclick="editProduct('${p.id}')">Edit</button>
                <button class="delete-btn" type="button" onclick="deleteProduct('${p.id}')">Delete</button>
              </div>
            </td>
          </tr>
        `;
      });
    }
  }

  if (kitchenBody) {
    kitchenBody.innerHTML = "";
    if (!kitchen.length) {
      kitchenBody.innerHTML = `<tr><td colspan="6">No kitchen products yet.</td></tr>`;
    } else {
      kitchen.forEach(p => {
        kitchenBody.innerHTML += `
          <tr>
            <td>${escapeHtml(p.name)}</td>
            <td>${escapeHtml(p.sku || "")}</td>
            <td>${round2(toNumber(p.qty, 0))}</td>
            <td>${escapeHtml(p.unit || "pcs")}</td>
            <td>${toNumber(p.reorder_level, 0)}</td>
            <td>
              <div class="inv-actions">
                <button class="in-btn" type="button" onclick="stockMove('${p.id}', 'IN')">Stock IN</button>
                <button class="out-btn" type="button" onclick="stockMove('${p.id}', 'OUT')">Stock OUT</button>
                <button class="warn-btn" type="button" onclick="recordLoss('${p.id}', 'SPOILAGE')">Spoilage</button>
                <button class="warn-btn" type="button" onclick="recordLoss('${p.id}', 'MISHANDLING')">Mishandling</button>
                <button class="edit-btn" type="button" onclick="editProduct('${p.id}')">Edit</button>
                <button class="delete-btn" type="button" onclick="deleteProduct('${p.id}')">Delete</button>
              </div>
            </td>
          </tr>
        `;
      });
    }
  }

  // If user still loads old HTML that uses #productsTable, render kitchen+seafood combined there too.
  if (legacyBody && !seafoodBody && !kitchenBody) {
    legacyBody.innerHTML = "";
    if (!products.length) {
      legacyBody.innerHTML = `<tr><td colspan="6">No products yet.</td></tr>`;
      return;
    }
    products.sort(sortFn);
    products.forEach(p => {
      legacyBody.innerHTML += `
        <tr>
          <td>${escapeHtml(p.name)}</td>
          <td>${escapeHtml(p.sku || "")}</td>
          <td>${escapeHtml(p.unit || "pcs")}</td>
          <td>${round2(toNumber(p.qty, 0))}</td>
          <td>${toNumber(p.reorder_level, 0)}</td>
          <td>
            <div class="inv-actions">
              <button class="in-btn" type="button" onclick="stockMove('${p.id}', 'IN')">Stock IN</button>
              <button class="out-btn" type="button" onclick="stockMove('${p.id}', 'OUT')">Stock OUT</button>
              <button class="warn-btn" type="button" onclick="recordLoss('${p.id}', 'SPOILAGE')">Spoilage</button>
              <button class="warn-btn" type="button" onclick="recordLoss('${p.id}', 'MISHANDLING')">Mishandling</button>
              <button class="edit-btn" type="button" onclick="editProduct('${p.id}')">Edit</button>
              <button class="delete-btn" type="button" onclick="deleteProduct('${p.id}')">Delete</button>
            </div>
          </td>
        </tr>
      `;
    });
  }
}

/***********************
 * INVENTORY EXPORT/EMAIL
 ***********************/
function downloadInventoryCSV() {
  if (!navigator.onLine) return alert("You must be online to export server CSV.");
  window.open(`${API_BASE}/api/inventory/export/inventory.csv`, "_blank");
}

async function emailInventoryCSV() {
  if (!navigator.onLine) return alert("You must be online to email inventory CSV.");

  const to = getVal("invEmail").trim();
  if (!to) return alert("Enter recipient email.");

  const status = $("invStatus");
  if (status) status.textContent = "Sending...";

  try {
    const resp = await api("/api/inventory/email/inventory", {
      method: "POST",
      body: JSON.stringify({ to })
    });

    if (status) status.textContent = `✅ Sent! ${JSON.stringify(resp)}`;
    setVal("invEmail", "");
  } catch (e) {
    const payload = e.data || { error: e.message };
    if (status) status.textContent = `❌ Failed: ${JSON.stringify(payload)}`;

    const msg = payload?.error || e.message || "";

    if (isMailNotConfigured(payload) || isNetworkMailError(msg)) {
      const ok = confirm("SMTP email is not available right now. Use Email (Easy) instead?");
      if (ok) return emailInventoryEasy();
    }

    alert(`❌ Inventory email failed: ${msg}`);
  }
}

/**
 * ✅ FIXED: mailto first (must be direct click), then CSV download after a delay.
 */
async function emailInventoryEasy() {
  const to = getVal("invEmail").trim();
  if (!to) return alert("Enter recipient email.");

  const status = $("invStatus");
  if (status) status.textContent = "Opening email app...";

  const csvUrl = `${API_BASE}/api/inventory/export/inventory.csv`;

  const body =
`Hello,

Please find the Inventory Report.

✅ Please attach the downloaded CSV file to this email.

Download link (CSV):
${csvUrl}

Generated: ${new Date().toLocaleString()}

Regards.`;

  openMailto(to, "Inventory Report - SeaBite Tracker", body);

  if (navigator.onLine) {
    setTimeout(() => {
      window.open(csvUrl, "_blank");
      if (status) status.textContent = "✅ Email opened. CSV download opened in a new tab — attach it to the email.";
    }, 600);
  } else {
    if (status) status.textContent = "✅ Email opened. Go online to download the CSV attachment.";
  }
}

/***********************
 * QUEUE SYNC
 ***********************/
async function flushQueue() {
  if (!navigator.onLine) return;

  const items = await queueAll();
  if (!items.length) return;

  for (const item of items) {
    try {
      await api(item.path, item.options);
      await queueClearItem(item.qid);
    } catch {
      break;
    }
  }

  await setQueueUI();
  await loadAll();
}

$("syncBtn")?.addEventListener("click", async () => {
  await flushQueue();
  alert("✅ Sync complete (or nothing to sync).");
});

window.addEventListener("online", async () => { setNetUI(); await flushQueue(); });
window.addEventListener("offline", () => setNetUI());

/***********************
 * ADMIN RESET DATABASE
 ***********************/
function initAdminReset() {
  const panel = $("adminPanel");
  const btn = $("resetDbBtn");
  const tokenInput = $("adminResetToken");
  const status = $("adminStatus");

  if (!panel || !btn || !tokenInput) return;

  tokenInput.addEventListener("input", () => {
    panel.style.display = "block";
  });

  panel.style.display = "block";

  btn.addEventListener("click", async () => {
    if (!navigator.onLine) return alert("You must be online to reset database.");

    const token = tokenInput.value.trim();
    if (!token) return alert("Enter admin reset token first.");

    const confirmText = prompt("Type RESET to confirm database reset:");
    if (confirmText !== "RESET") return alert("Cancelled.");

    if (status) status.textContent = "Resetting...";

    try {
      const resp = await api("/api/admin/reset", {
        method: "POST",
        headers: {
          "x-admin-reset-token": token,
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ token })
      });

      if (status) status.textContent = `✅ Reset done: ${JSON.stringify(resp)}`;

      // clear local caches too (best effort)
      await idbPutMany("sales", []);
      await idbPutMany("expenses", []);
      await idbPutMany("products", []);
      await idbPutMany("losses", []);

      await loadAll();
      alert("✅ Database reset completed.");
    } catch (e) {
      const payload = e.data || { error: e.message };
      if (status) status.textContent = `❌ Reset failed: ${JSON.stringify(payload)}`;
      alert(`Reset failed: ${payload.error || e.message}`);
    }
  });
}

/***********************
 * PWA INSTALL
 ***********************/
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = $("installBtn");
  if (btn) btn.style.display = "block";
});

$("installBtn")?.addEventListener("click", () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt = null;
});

/***********************
 * INIT
 ***********************/
setNetUI();
initAdminReset();
loadAll();