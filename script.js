let sales = JSON.parse(localStorage.getItem("sales")) || [];
let expenses = JSON.parse(localStorage.getItem("expenses")) || [];
let currentReportData = [];
let lastReportType = null;
let deferredPrompt;

// ===== CURRENCY FORMATTER =====
function formatCurrency(amount) {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
  }).format(Number(amount) || 0);
}

// ===== SAVE DATA =====
function saveData() {
  localStorage.setItem("sales", JSON.stringify(sales));
  localStorage.setItem("expenses", JSON.stringify(expenses));
  renderTable();
}

// ===== HELPERS =====
function getInputValue(id) {
  const el = document.getElementById(id);
  return el ? el.value : "";
}

function setInputValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function isValidAmount(amount) {
  return !Number.isNaN(amount) && Number.isFinite(amount) && amount > 0;
}

// ===== MINI CHART =====
function updateMiniChart(totalSales, totalExpenses) {
  const miniChart = document.getElementById("miniChart");
  if (!miniChart) return;

  const salesBar = document.getElementById("salesBar");
  const expensesBar = document.getElementById("expensesBar");
  const salesValue = document.getElementById("salesValue");
  const expensesValue = document.getElementById("expensesValue");
  const miniChartTotal = document.getElementById("miniChartTotal");

  const maxVal = Math.max(totalSales, totalExpenses, 1);
  const salesPct = (totalSales / maxVal) * 100;
  const expensesPct = (totalExpenses / maxVal) * 100;

  // Show chart once report generated
  miniChart.style.display = "block";

  // Update UI
  salesBar.style.width = `${salesPct.toFixed(2)}%`;
  expensesBar.style.width = `${expensesPct.toFixed(2)}%`;

  salesValue.textContent = formatCurrency(totalSales);
  expensesValue.textContent = formatCurrency(totalExpenses);

  miniChartTotal.textContent = `Max: ${formatCurrency(maxVal)}`;
}

// ===== ADD SALE =====
function addSale() {
  const amount = parseFloat(getInputValue("saleAmount"));
  const desc = getInputValue("saleDesc").trim();

  if (!isValidAmount(amount) || desc === "") {
    alert("Please enter a valid sale amount (> 0) and description.");
    return;
  }

  sales.push({ id: Date.now(), amount, desc, date: new Date().toISOString() });
  saveData();

  setInputValue("saleAmount", "");
  setInputValue("saleDesc", "");
}

// ===== ADD EXPENSE =====
function addExpense() {
  const amount = parseFloat(getInputValue("expenseAmount"));
  const desc = getInputValue("expenseDesc").trim();

  if (!isValidAmount(amount) || desc === "") {
    alert("Please enter a valid expense amount (> 0) and description.");
    return;
  }

  expenses.push({ id: Date.now(), amount, desc, date: new Date().toISOString() });
  saveData();

  setInputValue("expenseAmount", "");
  setInputValue("expenseDesc", "");
}

// ===== RENDER TABLE =====
function renderTable() {
  const table = document.getElementById("recordTable");
  if (!table) return;

  table.innerHTML = "";

  const allRecords = [
    ...sales.map((s) => ({ ...s, type: "Sale" })),
    ...expenses.map((e) => ({ ...e, type: "Expense" })),
  ];

  allRecords.sort((a, b) => new Date(b.date) - new Date(a.date));

  allRecords.forEach((item) => {
    const safeDesc = String(item.desc ?? "");

    table.innerHTML += `
      <tr>
        <td>${item.type}</td>
        <td>${formatCurrency(item.amount)}</td>
        <td>${safeDesc}</td>
        <td>${new Date(item.date).toLocaleString()}</td>
        <td>
          <div class="action-buttons">
            <button class="edit-btn" type="button" onclick="editRecord(${item.id}, '${item.type}')">Edit</button>
            <button class="delete-btn" type="button" onclick="deleteRecord(${item.id}, '${item.type}')">Delete</button>
          </div>
        </td>
      </tr>
    `;
  });
}

// ===== DELETE =====
function deleteRecord(id, type) {
  const ok = confirm(`Are you sure you want to delete this ${type.toLowerCase()} record?`);
  if (!ok) return;

  if (type === "Sale") sales = sales.filter((s) => s.id !== id);
  else expenses = expenses.filter((e) => e.id !== id);

  saveData();
}

// ===== EDIT =====
function editRecord(id, type) {
  let record = null;

  if (type === "Sale") record = sales.find((s) => s.id === id);
  else record = expenses.find((e) => e.id === id);

  if (!record) return alert("Record not found.");

  const newAmountRaw = prompt("Edit Amount:", record.amount);
  const newDescRaw = prompt("Edit Description:", record.desc);

  if (newAmountRaw === null || newDescRaw === null) return;

  const newAmount = parseFloat(newAmountRaw);
  const newDesc = newDescRaw.trim();

  if (!isValidAmount(newAmount) || newDesc === "") {
    alert("Please enter a valid amount (> 0) and a description.");
    return;
  }

  record.amount = newAmount;
  record.desc = newDesc;

  saveData();
}

// ===== FILTER BY DATE =====
function filterByDate(type, data) {
  const now = new Date();

  return data.filter((item) => {
    const itemDate = new Date(item.date);

    if (type === "daily") return itemDate.toDateString() === now.toDateString();

    if (type === "weekly") {
      const weekAgo = new Date();
      weekAgo.setDate(now.getDate() - 7);
      return itemDate >= weekAgo;
    }

    if (type === "monthly") {
      return itemDate.getMonth() === now.getMonth() && itemDate.getFullYear() === now.getFullYear();
    }

    if (type === "yearly") return itemDate.getFullYear() === now.getFullYear();

    return false;
  });
}

// ===== GENERATE REPORT =====
function generateReport(type) {
  lastReportType = type;

  const filteredSales = filterByDate(type, sales);
  const filteredExpenses = filterByDate(type, expenses);

  const totalSales = filteredSales.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  const totalExpenses = filteredExpenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  const profit = totalSales - totalExpenses;

  currentReportData = [
    { type: "Sales", amount: totalSales },
    { type: "Expenses", amount: totalExpenses },
    { type: "Profit", amount: profit },
  ];

  const reportDiv = document.getElementById("reportResult");
  if (reportDiv) {
    reportDiv.innerHTML = `
      <h3>${type.toUpperCase()} REPORT</h3>
      <p>Total Sales: ${formatCurrency(totalSales)}</p>
      <p>Total Expenses: ${formatCurrency(totalExpenses)}</p>
      <p>Profit: ${formatCurrency(profit)}</p>
    `;
  }

  // Update super-light mini chart
  updateMiniChart(totalSales, totalExpenses);
}

// ===== EXPORT CSV (SUMMARY + DETAILS) =====
function exportCSV() {
  if (!lastReportType) {
    alert("Please generate a report first.");
    return;
  }

  const filteredSales = filterByDate(lastReportType, sales);
  const filteredExpenses = filterByDate(lastReportType, expenses);

  const totalSales = filteredSales.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  const totalExpenses = filteredExpenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  const profit = totalSales - totalExpenses;

  let csv = "";

  csv += "BUSINESS REPORT\n";
  csv += "Business:,SeaBite Express\n";
  csv += `Report Type:,${lastReportType.toUpperCase()}\n`;
  csv += `Generated On:,${new Date().toLocaleString()}\n\n`;

  csv += "SUMMARY\n";
  csv += "Total Sales (NGN),Total Expenses (NGN),Profit (NGN)\n";
  csv += `${totalSales},${totalExpenses},${profit}\n\n`;

  csv += "DETAILED RECORDS\n";
  csv += "Type,Amount (NGN),Description,Date\n";

  filteredSales.forEach((s) => {
    csv += `"Sale",${Number(s.amount) || 0},"${String(s.desc ?? "").replaceAll('"', '""')}","${new Date(s.date).toLocaleString()}"\n`;
  });

  filteredExpenses.forEach((e) => {
    csv += `"Expense",${Number(e.amount) || 0},"${String(e.desc ?? "").replaceAll('"', '""')}","${new Date(e.date).toLocaleString()}"\n`;
  });

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = `seabite-report-${lastReportType}-${new Date().toISOString().split("T")[0]}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ===== INITIAL RENDER =====
renderTable();

// ===== PWA INSTALL =====
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;

  const btn = document.getElementById("installBtn");
  if (btn) btn.style.display = "block";
});

document.getElementById("installBtn")?.addEventListener("click", () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
});

// ===== SERVICE WORKER =====
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("service-worker.js");
}