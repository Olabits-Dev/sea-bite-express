let sales = JSON.parse(localStorage.getItem("sales")) || [];
let expenses = JSON.parse(localStorage.getItem("expenses")) || [];
let currentReportData = [];
let lastReportType = null;
let deferredPrompt;

// ===== CURRENCY FORMATTER =====
function formatCurrency(amount) {
    return new Intl.NumberFormat('en-NG', {
        style: 'currency',
        currency: 'NGN'
    }).format(amount);
}

// ===== SAVE DATA =====
function saveData() {
    localStorage.setItem("sales", JSON.stringify(sales));
    localStorage.setItem("expenses", JSON.stringify(expenses));
    renderTable();
}

// ===== ADD SALE =====
function addSale() {
    const amount = parseFloat(document.getElementById("saleAmount").value);
    const desc = document.getElementById("saleDesc").value;

    if (!amount || !desc) return alert("Please enter valid sale details");

    sales.push({ id: Date.now(), amount, desc, date: new Date() });
    saveData();
}

// ===== ADD EXPENSE =====
function addExpense() {
    const amount = parseFloat(document.getElementById("expenseAmount").value);
    const desc = document.getElementById("expenseDesc").value;

    if (!amount || !desc) return alert("Please enter valid expense details");

    expenses.push({ id: Date.now(), amount, desc, date: new Date() });
    saveData();
}

// ===== RENDER TABLE =====
function renderTable() {
    const table = document.getElementById("recordTable");
    table.innerHTML = "";

    const allRecords = [
        ...sales.map(s => ({ ...s, type: "Sale" })),
        ...expenses.map(e => ({ ...e, type: "Expense" }))
    ];

    // Sort newest first
    allRecords.sort((a, b) => new Date(b.date) - new Date(a.date));

    allRecords.forEach(item => {
        table.innerHTML += `
        <tr>
            <td>${item.type}</td>
            <td>${formatCurrency(item.amount)}</td>
            <td>${item.desc}</td>
            <td>${new Date(item.date).toLocaleString()}</td>
            <td>
                <button class="edit-btn" onclick="editRecord(${item.id}, '${item.type}')">Edit</button>
                <button class="delete-btn" onclick="deleteRecord(${item.id}, '${item.type}')">Delete</button>
            </td>
        </tr>
        `;
    });
}

// ===== DELETE =====
function deleteRecord(id, type) {
    if (type === "Sale") {
        sales = sales.filter(s => s.id !== id);
    } else {
        expenses = expenses.filter(e => e.id !== id);
    }
    saveData();
}

// ===== EDIT =====
function editRecord(id, type) {
    let record;

    if (type === "Sale") {
        record = sales.find(s => s.id === id);
    } else {
        record = expenses.find(e => e.id === id);
    }

    const newAmount = prompt("Edit Amount:", record.amount);
    const newDesc = prompt("Edit Description:", record.desc);

    if (!newAmount || !newDesc) return;

    record.amount = parseFloat(newAmount);
    record.desc = newDesc;

    saveData();
}

// ===== FILTER BY DATE =====
function filterByDate(type, data) {
    const now = new Date();

    return data.filter(item => {
        const itemDate = new Date(item.date);

        if (type === "daily")
            return itemDate.toDateString() === now.toDateString();

        if (type === "weekly") {
            const weekAgo = new Date();
            weekAgo.setDate(now.getDate() - 7);
            return itemDate >= weekAgo;
        }

        if (type === "monthly")
            return itemDate.getMonth() === now.getMonth() &&
                   itemDate.getFullYear() === now.getFullYear();

        if (type === "yearly")
            return itemDate.getFullYear() === now.getFullYear();
    });
}

// ===== GENERATE REPORT =====
function generateReport(type) {

    lastReportType = type;

    const filteredSales = filterByDate(type, sales);
    const filteredExpenses = filterByDate(type, expenses);

    const totalSales = filteredSales.reduce((sum, s) => sum + s.amount, 0);
    const totalExpenses = filteredExpenses.reduce((sum, e) => sum + e.amount, 0);
    const profit = totalSales - totalExpenses;

    currentReportData = [
        { type: "Sales", amount: totalSales },
        { type: "Expenses", amount: totalExpenses },
        { type: "Profit", amount: profit }
    ];

    document.getElementById("reportResult").innerHTML = `
        <h3>${type.toUpperCase()} REPORT</h3>
        <p>Total Sales: ${formatCurrency(totalSales)}</p>
        <p>Total Expenses: ${formatCurrency(totalExpenses)}</p>
        <p>Profit: ${formatCurrency(profit)}</p>
    `;

    new Chart(document.getElementById("chart"), {
        type: 'bar',
        data: {
            labels: ['Sales', 'Expenses'],
            datasets: [{
                label: 'Amount (₦)',
                data: [totalSales, totalExpenses]
            }]
        }
    });
}

// ===== EXPORT CSV (SUMMARY + DETAILS) =====
function exportCSV() {

    if (!lastReportType) {
        alert("Please generate a report first.");
        return;
    }

    const filteredSales = filterByDate(lastReportType, sales);
    const filteredExpenses = filterByDate(lastReportType, expenses);

    const totalSales = filteredSales.reduce((sum, s) => sum + s.amount, 0);
    const totalExpenses = filteredExpenses.reduce((sum, e) => sum + e.amount, 0);
    const profit = totalSales - totalExpenses;

    let csv = "";

    csv += "BUSINESS REPORT\n";
    csv += `Report Type:,${lastReportType.toUpperCase()}\n`;
    csv += `Generated On:,${new Date().toLocaleString()}\n\n`;

    csv += "SUMMARY\n";
    csv += "Total Sales (NGN),Total Expenses (NGN),Profit (NGN)\n";
    csv += `${totalSales},${totalExpenses},${profit}\n\n`;

    csv += "DETAILED RECORDS\n";
    csv += "Type,Amount (NGN),Description,Date\n";

    filteredSales.forEach(s => {
        csv += `"Sale",${s.amount},"${s.desc}","${new Date(s.date).toLocaleString()}"\n`;
    });

    filteredExpenses.forEach(e => {
        csv += `"Expense",${e.amount},"${e.desc}","${new Date(e.date).toLocaleString()}"\n`;
    });

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = `business-report-${lastReportType}-${new Date().toISOString().split("T")[0]}.csv`;
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
    document.getElementById("installBtn").style.display = "block";
});

document.getElementById("installBtn").addEventListener("click", () => {
    deferredPrompt.prompt();
});

// ===== SERVICE WORKER =====
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js");
}
