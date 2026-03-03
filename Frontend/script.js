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

/***********************
 * ✅ Friendly inline message (no more scary “failed” popups when queued)
 ***********************/
function toast(msg, ms = 4500) {
  const el = $("invStatus") || $("queueStatus") || $("netStatus") || $("adminStatus");
  if (el) {
    const prev = el.textContent;
    el.textContent = msg;
    setTimeout(() => {
      if (el.textContent === msg) el.textContent = prev || "";
    }, ms);
  } else {
    alert(msg);
  }
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
const DB_VERSION = 5;

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
    req.onerror = () => reject(tx.error || req.error);
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
 * ✅ HARD CLEAR HELPERS
 ***********************/
async function idbClear(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function hardClearOfflineData() {
  const stores = ["queue", "sales", "expenses", "products", "losses"];
  for (const s of stores) {
    try { await idbClear(s); } catch {}
  }

  if ("caches" in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {}
  }

  if ("serviceWorker" in navigator) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    } catch {}
  }
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

/**
 * ✅ pendingUsage stores BOTH:
 * - qty_used: the REAL qty to deduct/send to backend (always quantity)
 * - display_qty/display_unit: what the user entered (portion for seafood, unit for kitchen)
 */
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
  renderProductsTables();
  renderUsageSummary();
  renderLossTables(); // ✅ split loss tables (seafood + kitchen)
}

/***********************
 * PRODUCTS USED MODAL
 * ✅ Seafood input = PORTION
 * ✅ Kitchen input = UNIT/QTY
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
      const cat = normalizeCategory(p.category);
      const existing = pendingUsage.find(x => String(x.product_id) === String(p.id));

      // what user sees/enters:
      const isSeafood = cat === "SEAFOOD";
      const ps = toNumber(p.portion_size, 0);
      const availablePortion = isSeafood ? round2(calcPortionFromQty(toNumber(p.qty, 0), ps)) : null;
      const availableLabel = isSeafood
        ? `Available: ${availablePortion} portion`
        : `Available: ${round2(toNumber(p.qty, 0))} ${escapeHtml(p.unit || "")}`;

      const val = existing ? Number(existing.display_qty || 0) : 0;

      const row = document.createElement("div");
      row.className = "usage-row";
      row.innerHTML = `
        <div>
          <div class="u-name">${escapeHtml(p.name)}</div>
          <div class="u-meta">${availableLabel}</div>
        </div>
        <input type="number" min="0" step="any" inputmode="decimal"
               data-pid="${p.id}"
               data-cat="${cat}"
               data-ps="${ps}"
               data-unit="${escapeHtml(p.unit || "pcs")}"
               placeholder="${isSeafood ? "Portion used" : "Qty used"}"
               value="${val}" />
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
    const pid = inp.getAttribute("data-pid");
    const cat = String(inp.getAttribute("data-cat") || "KITCHEN").toUpperCase();
    const ps = toNumber(inp.getAttribute("data-ps"), 0);
    const unit = String(inp.getAttribute("data-unit") || "pcs");
    const displayQty = toNumber(inp.value || 0, 0);

    if (displayQty > 0) {
      if (cat === "SEAFOOD") {
        // user entered portion; we convert to real qty_used
        const qtyUsed = calcQtyFromPortion(displayQty, ps);
        next.push({
          product_id: Number(pid),
          qty_used: qtyUsed,
          display_qty: displayQty,
          display_unit: "portion"
        });
      } else {
        // user entered qty/unit directly
        next.push({
          product_id: Number(pid),
          qty_used: displayQty,
          display_qty: displayQty,
          display_unit: unit || "pcs"
        });
      }
    }
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
    const u = it.display_unit ? ` ${it.display_unit}` : "";
    return `${name} x${round2(toNumber(it.display_qty, 0))}${u}`;
  });

  box.textContent = lines.join(" • ");
}

/***********************
 * FINANCE CRUD
 ***********************/
function formatProductsUsed(items) {
  if (!items || !items.length) return "";
  // server items likely only have qty_used + unit; keep simple
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

  // ✅ stock validation uses REAL qty_used (quantity)
  for (const it of pendingUsage) {
    const p = products.find(x => Number(x.id) === Number(it.product_id));
    if (p && Number(p.qty) - Number(it.qty_used) < 0) {
      const cat = normalizeCategory(p.category);
      const hint = cat === "SEAFOOD"
        ? `Reduce portion used for ${p.name}.`
        : `Reduce qty used for ${p.name}.`;
      alert(`Insufficient stock for ${p.name}. ${hint}`);
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
        qty_used: it.qty_used, // ✅ always quantity (server expects this)
        product_name: p?.name || "",
        product_unit: p?.unit || "",
        display_qty: it.display_qty,
        display_unit: it.display_unit
      };
    })
  };

  sales.unshift(saleTemp);
  await idbPut("sales", saleTemp);

  // optimistic product deduct
  for (const it of pendingUsage) {
    const p = products.find(x => Number(x.id) === Number(it.product_id));
    if (p) {
      p.qty = Number(p.qty) - Number(it.qty_used);
      if (normalizeCategory(p.category) === "SEAFOOD") {
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

  if (result.queued) {
    toast("✅ Sale saved offline — it will automatically sync when you're online.");
    return;
  }

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

  if (result.queued) {
    toast("✅ Expense saved offline — it will automatically sync when you're online.");
    return;
  }

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

    if (String(id).startsWith("tmp-")) {
      toast("✅ Deleted offline sale.");
      return;
    }

    const result = await apiOrQueue({
      kind: "sale_delete",
      path: `/api/finance/sales/${id}`,
      options: { method: "DELETE" }
    });

    if (result.queued) {
      toast("✅ Sale delete queued offline — it will sync when online.");
      return;
    }

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

  if (String(id).startsWith("tmp-")) {
    toast("✅ Deleted offline expense.");
    return;
  }

  const result = await apiOrQueue({
    kind: "expense_delete",
    path: `/api/finance/expenses/${id}`,
    options: { method: "DELETE" }
  });

  if (result.queued) {
    toast("✅ Expense delete queued offline — it will sync when online.");
    return;
  }

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

    if (String(id).startsWith("tmp-")) {
      toast("✅ Sale updated offline — sync online to save to database.");
      return;
    }

    const result = await apiOrQueue({
      kind: "sale_update",
      path: `/api/finance/sales/${id}`,
      options: { method: "PUT", body: JSON.stringify({ amount, description }) }
    });

    if (result.queued) {
      toast("✅ Sale update queued offline — it will sync when online.");
      return;
    }

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

  if (String(id).startsWith("tmp-")) {
    toast("✅ Expense updated offline — sync online to save to database.");
    return;
  }

  const result = await apiOrQueue({
    kind: "expense_update",
    path: `/api/finance/expenses/${id}`,
    options: { method: "PUT", body: JSON.stringify({ amount, description }) }
  });

  if (result.queued) {
    toast("✅ Expense update queued offline — it will sync when online.");
    return;
  }

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
  const portion_size = toNumber(getVal("pPortionSize"), 0);

  if (!name) return alert("Product name is required.");

  if (category === "SEAFOOD" && portion_size <= 0) {
    return alert("Seafood needs 'Qty per 1 Portion' (example: 2).");
  }

  const initialQtyRaw = prompt("Initial QUANTITY to Stock IN now?", "0");
  if (initialQtyRaw === null) return;
  const initial_qty = toNumber(initialQtyRaw, 0);
  if (initial_qty < 0) return alert("Initial quantity must be 0 or more.");

  const tmpId = `tmp-${Date.now()}`;

  const temp = {
    id: tmpId,
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
    tmp_id: tmpId,
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

  if (result.queued) {
    toast("✅ Product saved offline — it will automatically sync to database when you're online.");
    return;
  }

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

  if (String(p.id).startsWith("tmp-")) {
    toast("ℹ️ This product is still offline. Go online and Sync to save it to the server before editing on server.");
  }

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

  if (String(id).startsWith("tmp-")) {
    toast("✅ Changes saved offline. Sync online to save to database.");
    return;
  }

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

  if (result.queued) {
    toast("✅ Update queued offline — it will sync when online.");
    return;
  }

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

  if (String(id).startsWith("tmp-")) {
    toast("✅ Deleted offline item.");
    return;
  }

  const result = await apiOrQueue({
    kind: "product_delete",
    path: `/api/inventory/products/${id}`,
    options: { method: "DELETE" }
  });

  if (result.queued) {
    toast("✅ Delete queued offline — it will sync when online.");
    return;
  }

  if (navigator.onLine && !result.ok) {
    alert(`Product delete failed: ${result.error}`);
    await loadAll();
  } else if (navigator.onLine && result.ok) {
    await loadAll();
  }
}

/**
 * ✅ Stock move: correct qty + mode for SEAFOOD
 */
async function stockMove(productId, type) {
  const p = products.find(x => String(x.id) === String(productId));
  if (!p) return alert("Product not found.");

  if (String(p.id).startsWith("tmp-")) {
    return alert("This product is not yet saved on the server. Please go online and click Sync Now, then try again.");
  }

  const note = prompt("Note (optional):", "") ?? "";

  let mode = "QTY";
  let qtyToSend = 0;
  let deltaQty = 0;
  let label = "";

  if (p.category === "SEAFOOD") {
    const modeRaw = prompt("Stock by: QTY or PORTION?", "QTY");
    if (modeRaw === null) return;
    mode = String(modeRaw).trim().toUpperCase() === "PORTION" ? "PORTION" : "QTY";

    if (mode === "PORTION") {
      const portionRaw = prompt(`Enter PORTION to Stock ${type}:`, "1");
      if (portionRaw === null) return;
      const portion = toNumber(portionRaw, 0);
      if (!isValidQty(portion)) return alert("Portion must be > 0");

      qtyToSend = portion;
      deltaQty = calcQtyFromPortion(portion, p.portion_size);
      label = `${round2(portion)} portion`;
    } else {
      const qtyRaw = prompt(`Enter QUANTITY to Stock ${type}:`, "1");
      if (qtyRaw === null) return;
      const qty = toNumber(qtyRaw, 0);
      if (!isValidQty(qty)) return alert("Quantity must be > 0");

      qtyToSend = qty;
      deltaQty = qty;
      label = `${round2(qty)} qty`;
    }
  } else {
    const qtyRaw = prompt(`Enter quantity to Stock ${type}:`, "1");
    if (qtyRaw === null) return;
    const qty = toNumber(qtyRaw, 0);
    if (!isValidQty(qty)) return alert("Quantity must be > 0");
    mode = "QTY";
    qtyToSend = qty;
    deltaQty = qty;
    label = `${round2(qty)} ${p.unit || ""}`.trim();
  }

  const nextQty = type === "IN" ? (toNumber(p.qty, 0) + deltaQty) : (toNumber(p.qty, 0) - deltaQty);
  if (type === "OUT" && nextQty < 0) return alert("Insufficient stock.");

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
        qty: qtyToSend,
        mode,
        note: note ? `${note} (${label})` : `(${label})`
      })
    }
  });

  if (result.queued) {
    toast("✅ Stock update saved offline — it will sync when you're online.");
    return;
  }

  if (navigator.onLine && !result.ok) {
    alert(`Stock move failed: ${result.error}`);
    await loadAll();
  } else if (navigator.onLine && result.ok) {
    await loadAll();
  }
}

/**
 * ✅ Loss: split seafood vs kitchen in UI + offline sync
 */
async function recordLoss(productId, reason) {
  const p = products.find(x => String(x.id) === String(productId));
  if (!p) return alert("Product not found.");

  if (String(p.id).startsWith("tmp-")) {
    return alert("This product is not yet saved on the server. Please go online and click Sync Now, then try again.");
  }

  let mode = "QTY";
  let qtyToSend = 0;
  let deltaQty = 0;

  if (p.category === "SEAFOOD") {
    const modeRaw = prompt("Loss by: QTY or PORTION?", "QTY");
    if (modeRaw === null) return;
    mode = String(modeRaw).trim().toUpperCase() === "PORTION" ? "PORTION" : "QTY";

    if (mode === "PORTION") {
      const portionRaw = prompt(`Enter PORTION for ${reason}:`, "1");
      if (portionRaw === null) return;
      const portion = toNumber(portionRaw, 0);
      if (!isValidQty(portion)) return alert("Portion must be > 0");

      qtyToSend = portion;
      deltaQty = calcQtyFromPortion(portion, p.portion_size);
    } else {
      const qtyRaw = prompt(`Enter QUANTITY for ${reason}:`, "1");
      if (qtyRaw === null) return;
      const qty = toNumber(qtyRaw, 0);
      if (!isValidQty(qty)) return alert("Quantity must be > 0");

      qtyToSend = qty;
      deltaQty = qty;
    }
  } else {
    const qtyRaw = prompt(`Enter quantity for ${reason}:`, "1");
    if (qtyRaw === null) return;
    const qty = toNumber(qtyRaw, 0);
    if (!isValidQty(qty)) return alert("Quantity must be > 0");

    mode = "QTY";
    qtyToSend = qty;
    deltaQty = qty;
  }

  const note = prompt("Note (optional):", "") ?? "";

  if (toNumber(p.qty, 0) - deltaQty < 0) return alert("Insufficient stock.");

  // optimistic product update
  p.qty = toNumber(p.qty, 0) - deltaQty;
  if (p.category === "SEAFOOD") p.portion = round2(calcPortionFromQty(p.qty, p.portion_size));
  p.updated_at = new Date().toISOString();
  await idbPut("products", p);

  // optimistic loss entry (store category snapshot)
  const tmpLossId = `tmp-${Date.now()}`;
  const tmpLoss = {
    id: tmpLossId,
    product_id: Number(productId),
    product_name: p.name,
    product_unit: p.unit || "",
    product_category: normalizeCategory(p.category),
    qty: deltaQty,
    reason: String(reason || "").toUpperCase(),
    note,
    created_at: new Date().toISOString()
  };
  losses.unshift(tmpLoss);
  await idbPut("losses", tmpLoss);

  renderProductsTables();
  renderUsageSummary();
  renderLossTables();

  const result = await apiOrQueue({
    kind: "stock_loss",
    tmp_loss_id: tmpLossId, // ✅ reconcile after sync
    path: `/api/inventory/products/${productId}/loss`,
    options: { method: "POST", body: JSON.stringify({ qty: qtyToSend, reason, note, mode }) }
  });

  if (result.queued) {
    toast("✅ Loss saved offline — it will sync when you're online.");
    return;
  }

  if (navigator.onLine && !result.ok) {
    alert(`Loss record failed: ${result.error}`);
    await loadAll();
  } else if (navigator.onLine && result.ok) {
    await loadAll();
  }
}

/***********************
 * LOSS HISTORY TABLES (SEAFOOD + KITCHEN)
 * ✅ Works offline and syncs (losses array + queue sync reconcile)
 *
 * HTML IDs supported:
 * - Seafood loss tbody:   #seafoodLossTable
 * - Kitchen loss tbody:   #kitchenLossTable
 * Backward compat:
 * - Old single tbody:     #lossTable (will render ALL losses there)
 ***********************/
function getLossCategory(loss) {
  const direct = normalizeCategory(loss?.product_category || "");
  if (direct) return direct;

  // try match products list
  const pid = loss?.product_id;
  const p = products.find(x => String(x.id) === String(pid));
  if (p) return normalizeCategory(p.category);

  return "KITCHEN";
}

function renderLossTables() {
  const seafoodBody = $("seafoodLossTable");
  const kitchenBody = $("kitchenLossTable");
  const legacyBody = $("lossTable");

  const sorted = [...(losses || [])].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  const seafoodLosses = sorted.filter(l => getLossCategory(l) === "SEAFOOD");
  const kitchenLosses = sorted.filter(l => getLossCategory(l) === "KITCHEN");

  const rowHtml = (l) => {
    const productName = l.product_name || l.name || `Product#${l.product_id ?? ""}`;
    const qty = Number(l.qty ?? l.qty_lost ?? 0) || 0;
    const unit = l.product_unit || l.unit || "";
    const reason = String(l.reason || "").toUpperCase();
    const date = l.created_at || l.date || "";
    const isTmp = String(l.id || "").startsWith("tmp-");

    return `
      <tr>
        <td>${escapeHtml(productName)} ${isTmp ? '<span style="font-size:12px;opacity:.7;">(offline)</span>' : ""}</td>
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
  };

  if (seafoodBody) {
    seafoodBody.innerHTML = "";
    if (!seafoodLosses.length) {
      seafoodBody.innerHTML = `<tr><td colspan="6">No seafood loss records yet.</td></tr>`;
    } else {
      seafoodLosses.forEach(l => { seafoodBody.innerHTML += rowHtml(l); });
    }
  }

  if (kitchenBody) {
    kitchenBody.innerHTML = "";
    if (!kitchenLosses.length) {
      kitchenBody.innerHTML = `<tr><td colspan="6">No kitchen loss records yet.</td></tr>`;
    } else {
      kitchenLosses.forEach(l => { kitchenBody.innerHTML += rowHtml(l); });
    }
  }

  // legacy single table fallback: render all if split tables not present
  if (legacyBody && !seafoodBody && !kitchenBody) {
    legacyBody.innerHTML = "";
    if (!sorted.length) {
      legacyBody.innerHTML = `<tr><td colspan="6">No loss records yet.</td></tr>`;
    } else {
      sorted.forEach(l => { legacyBody.innerHTML += rowHtml(l); });
    }
  }
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
  renderLossTables();

  // tmp loss: offline only
  if (String(lossId).startsWith("tmp-")) {
    toast("✅ Loss updated offline. Sync online to save changes to database.");
    return;
  }

  const result = await apiOrQueue({
    kind: "loss_update",
    path: `/api/inventory/losses/${lossId}`,
    options: { method: "PUT", body: JSON.stringify({ qty, reason, note }) }
  });

  if (result.queued) {
    toast("✅ Loss update queued offline — will sync when online.");
    return;
  }

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
  renderLossTables();

  if (String(lossId).startsWith("tmp-")) {
    toast("✅ Deleted offline loss record.");
    return;
  }

  const result = await apiOrQueue({
    kind: "loss_delete",
    path: `/api/inventory/losses/${lossId}`,
    options: { method: "DELETE" }
  });

  if (result.queued) {
    toast("✅ Loss delete queued offline — will sync when online.");
    return;
  }

  if (navigator.onLine && !result.ok) {
    alert(`Loss delete failed: ${result.error}`);
    await loadAll();
  } else if (navigator.onLine && result.ok) {
    await loadAll();
  }
}

/***********************
 * RENDER INVENTORY TABLES (SEAFOOD + KITCHEN)
 ***********************/
function renderProductsTables() {
  const seafoodBody = $("seafoodTable");
  const kitchenBody = $("kitchenTable");
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
        const isTmp = String(p.id).startsWith("tmp-");
        seafoodBody.innerHTML += `
          <tr>
            <td>${escapeHtml(p.name)} ${isTmp ? '<span style="font-size:12px;opacity:.7;">(offline)</span>' : ""}</td>
            <td>${escapeHtml(p.sku || "")}</td>
            <td>${round2(toNumber(p.qty, 0))}</td>
            <td>${portion}</td>
            <td>${toNumber(p.reorder_level, 0)}</td>
            <td>
              <div class="inv-actions">
                <button class="in-btn" type="button" onclick="stockMove('${p.id}', 'IN')" ${isTmp ? "disabled" : ""}>Stock IN</button>
                <button class="out-btn" type="button" onclick="stockMove('${p.id}', 'OUT')" ${isTmp ? "disabled" : ""}>Stock OUT</button>
                <button class="warn-btn" type="button" onclick="recordLoss('${p.id}', 'SPOILAGE')" ${isTmp ? "disabled" : ""}>Spoilage</button>
                <button class="warn-btn" type="button" onclick="recordLoss('${p.id}', 'MISHANDLING')" ${isTmp ? "disabled" : ""}>Mishandling</button>
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
        const isTmp = String(p.id).startsWith("tmp-");
        kitchenBody.innerHTML += `
          <tr>
            <td>${escapeHtml(p.name)} ${isTmp ? '<span style="font-size:12px;opacity:.7;">(offline)</span>' : ""}</td>
            <td>${escapeHtml(p.sku || "")}</td>
            <td>${round2(toNumber(p.qty, 0))}</td>
            <td>${escapeHtml(p.unit || "pcs")}</td>
            <td>${toNumber(p.reorder_level, 0)}</td>
            <td>
              <div class="inv-actions">
                <button class="in-btn" type="button" onclick="stockMove('${p.id}', 'IN')" ${isTmp ? "disabled" : ""}>Stock IN</button>
                <button class="out-btn" type="button" onclick="stockMove('${p.id}', 'OUT')" ${isTmp ? "disabled" : ""}>Stock OUT</button>
                <button class="warn-btn" type="button" onclick="recordLoss('${p.id}', 'SPOILAGE')" ${isTmp ? "disabled" : ""}>Spoilage</button>
                <button class="warn-btn" type="button" onclick="recordLoss('${p.id}', 'MISHANDLING')" ${isTmp ? "disabled" : ""}>Mishandling</button>
                <button class="edit-btn" type="button" onclick="editProduct('${p.id}')">Edit</button>
                <button class="delete-btn" type="button" onclick="deleteProduct('${p.id}')">Delete</button>
              </div>
            </td>
          </tr>
        `;
      });
    }
  }

  if (legacyBody && !seafoodBody && !kitchenBody) {
    legacyBody.innerHTML = "";
    if (!products.length) {
      legacyBody.innerHTML = `<tr><td colspan="6">No products yet.</td></tr>`;
      return;
    }
    products.sort(sortFn);
    products.forEach(p => {
      const isTmp = String(p.id).startsWith("tmp-");
      legacyBody.innerHTML += `
        <tr>
          <td>${escapeHtml(p.name)} ${isTmp ? '<span style="font-size:12px;opacity:.7;">(offline)</span>' : ""}</td>
          <td>${escapeHtml(p.sku || "")}</td>
          <td>${escapeHtml(p.unit || "pcs")}</td>
          <td>${round2(toNumber(p.qty, 0))}</td>
          <td>${toNumber(p.reorder_level, 0)}</td>
          <td>
            <div class="inv-actions">
              <button class="in-btn" type="button" onclick="stockMove('${p.id}', 'IN')" ${isTmp ? "disabled" : ""}>Stock IN</button>
              <button class="out-btn" type="button" onclick="stockMove('${p.id}', 'OUT')" ${isTmp ? "disabled" : ""}>Stock OUT</button>
              <button class="warn-btn" type="button" onclick="recordLoss('${p.id}', 'SPOILAGE')" ${isTmp ? "disabled" : ""}>Spoilage</button>
              <button class="warn-btn" type="button" onclick="recordLoss('${p.id}', 'MISHANDLING')" ${isTmp ? "disabled" : ""}>Mishandling</button>
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
 * ✅ QUEUE SYNC (with reconcile for product_create + stock_loss)
 ***********************/
async function reconcileCreatedProduct(tmpId, serverProduct) {
  const serverNorm = normalizeProducts([serverProduct])[0];

  products = products.filter(p => String(p.id) !== String(tmpId));
  try { await idbDelete("products", tmpId); } catch {}

  products.unshift(serverNorm);
  try { await idbPut("products", serverNorm); } catch {}

  pendingUsage = pendingUsage.filter(u => String(u.product_id) !== String(tmpId));

  renderProductsTables();
  renderUsageSummary();
}

async function reconcileCreatedLoss(tmpLossId, serverLoss) {
  // remove tmp
  losses = losses.filter(l => String(l.id) !== String(tmpLossId));
  try { await idbDelete("losses", tmpLossId); } catch {}

  // add server (best effort normalize category)
  const pid = serverLoss?.product_id;
  const p = products.find(x => String(x.id) === String(pid));
  const cat = normalizeCategory(serverLoss?.product_category || p?.category || "KITCHEN");

  const serverLossNorm = {
    ...serverLoss,
    product_category: cat
  };

  losses.unshift(serverLossNorm);
  try { await idbPut("losses", serverLossNorm); } catch {}

  renderLossTables();
}

async function flushQueue() {
  if (!navigator.onLine) return;

  const items = await queueAll();
  if (!items.length) return;

  for (const item of items) {
    try {
      const data = await api(item.path, item.options);

      if (item.kind === "product_create" && item.tmp_id && data?.id) {
        await reconcileCreatedProduct(item.tmp_id, data);
        toast("✅ Offline product synced to database.");
      }

      // ✅ reconcile offline tmp loss -> server loss
      if (item.kind === "stock_loss" && item.tmp_loss_id && data?.id) {
        await reconcileCreatedLoss(item.tmp_loss_id, data);
        toast("✅ Offline loss synced to database.");
      }

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

      await hardClearOfflineData();

      sales = [];
      expenses = [];
      products = [];
      losses = [];
      pendingUsage = [];
      lastReportType = null;

      renderFinanceTable();
      renderProductsTables();
      renderLossTables();
      renderUsageSummary();
      await setQueueUI();

      if (status) status.textContent = `✅ Reset done: ${JSON.stringify(resp)}`;

      await loadAll();

      alert("✅ Database reset completed. Offline cache cleared.");
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