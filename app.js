/* =========================================================
   TASKFLOW — APP LOGIC (Vanilla JS, tanpa framework)
   Struktur file ini:
   1. Util umum (uuid, tanggal, debounce, toast)
   2. DB Layer — wrapper Promise di atas IndexedDB
   3. State management in-memory
   4. CRUD Task
   5. Render: Dashboard, Kanban, Activity Log, Settings
   6. Drag & Drop Kanban
   7. Search & Filter
   8. Canvas Charts (tanpa library)
   9. Export / Import (CSV & JSON) + deteksi duplikat
   10. Backup / Restore
   11. Activity Log (lazy load / pagination)
   12. Navigasi & Modal
   13. Inisialisasi App + Service Worker
   ========================================================= */

"use strict";

/* =========================================================
   1. UTIL UMUM
   ========================================================= */
function uuid() {
  // RFC4122-ish UUID v4 generator tanpa dependensi eksternal
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function nowISO() { return new Date().toISOString(); }

function fmtDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
}

function getDueState(task) {
  // mengembalikan 'overdue' | 'today' | null  (hanya relevan jika belum done)
  if (!task.dueDate || task.status === "done") return null;
  const due = new Date(task.dueDate);
  if (isNaN(due.getTime())) return null;
  const today = new Date();
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  if (due.getTime() < today.getTime()) return "overdue";
  if (due.getTime() === today.getTime()) return "today";
  return null;
}

function debounce(fn, delay = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function escapeHtml(str) {
  if (str === undefined || str === null) return "";
  return String(str).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => toast.remove(), 300);
  }, 2600);
}

/* =========================================================
   2. DB LAYER — IndexedDB Promise Wrapper
   ========================================================= */
const DB_NAME = "TaskFlowDB";
const DB_VERSION = 1;
const STORE_TASKS = "tasks";
const STORE_LOGS = "activityLogs";

let dbInstance = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains(STORE_TASKS)) {
        const taskStore = db.createObjectStore(STORE_TASKS, { keyPath: "id" });
        taskStore.createIndex("status", "status", { unique: false });
        taskStore.createIndex("priority", "priority", { unique: false });
        taskStore.createIndex("dueDate", "dueDate", { unique: false });
        taskStore.createIndex("title", "title", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_LOGS)) {
        const logStore = db.createObjectStore(STORE_LOGS, { keyPath: "id", autoIncrement: true });
        logStore.createIndex("timestamp", "timestamp", { unique: false });
      }
    };

    req.onsuccess = (e) => { dbInstance = e.target.result; resolve(dbInstance); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function tx(storeName, mode = "readonly") {
  return dbInstance.transaction(storeName, mode).objectStore(storeName);
}

const DB = {
  getAllTasks() {
    return new Promise((resolve, reject) => {
      const req = tx(STORE_TASKS).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  putTask(task) {
    return new Promise((resolve, reject) => {
      const req = tx(STORE_TASKS, "readwrite").put(task);
      req.onsuccess = () => resolve(task);
      req.onerror = () => reject(req.error);
    });
  },
  deleteTask(id) {
    return new Promise((resolve, reject) => {
      const req = tx(STORE_TASKS, "readwrite").delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  clearTasks() {
    return new Promise((resolve, reject) => {
      const req = tx(STORE_TASKS, "readwrite").clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  addLog(entry) {
    return new Promise((resolve, reject) => {
      const req = tx(STORE_LOGS, "readwrite").add(entry);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  // mengambil log terbaru dengan pagination via cursor (efisien untuk 50.000+ entri)
  getLogsPage(offset, limit) {
    return new Promise((resolve, reject) => {
      const index = tx(STORE_LOGS).index("timestamp");
      const results = [];
      let skipped = 0;
      const req = index.openCursor(null, "prev"); // urutan terbaru dulu
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) { resolve(results); return; }
        if (skipped < offset) { skipped++; cursor.continue(); return; }
        if (results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => reject(req.error);
    });
  },
  countLogs() {
    return new Promise((resolve, reject) => {
      const req = tx(STORE_LOGS).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  clearLogs() {
    return new Promise((resolve, reject) => {
      const req = tx(STORE_LOGS, "readwrite").clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  getAllLogs() {
    return new Promise((resolve, reject) => {
      const req = tx(STORE_LOGS).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
};

async function logActivity(action, detail) {
  await DB.addLog({ action, detail, timestamp: nowISO() });
  // refresh tampilan log jika sedang dibuka
  if (AppState.currentView === "activity") {
    AppState.logOffset = 0;
    renderActivityLogPage(true);
  }
}

/* =========================================================
   3. STATE MANAGEMENT (in-memory cache)
   ========================================================= */
const AppState = {
  tasks: [],          // seluruh task dimuat di memori (cepat untuk hingga ribuan task)
  currentView: "dashboard",
  searchTerm: "",
  filterPriority: "",
  filterDue: "",
  logOffset: 0,
  logPageSize: 50,
  darkMode: false,
  cardRenderCap: 150  // batas render kartu per kolom (lazy render demi performa)
};

function loadSettings() {
  const saved = localStorage.getItem("taskflow_settings");
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      AppState.darkMode = !!parsed.darkMode;
    } catch (e) { /* ignore corrupt settings */ }
  }
}
function saveSettings() {
  localStorage.setItem("taskflow_settings", JSON.stringify({ darkMode: AppState.darkMode }));
}

/* =========================================================
   4. CRUD TASK
   ========================================================= */
function getTaskById(id) { return AppState.tasks.find(t => t.id === id); }

async function createTask(data) {
  const task = {
    id: uuid(),
    title: data.title.trim(),
    description: data.description || "",
    priority: data.priority || "medium",
    status: data.status || "todo",
    startDate: data.startDate || "",
    dueDate: data.dueDate || "",
    progress: Number(data.progress) || 0,
    tags: data.tags || [],
    notes: data.notes || "",
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
  await DB.putTask(task);
  AppState.tasks.push(task);
  await logActivity("Create Task", task.title);
  return task;
}

async function updateTask(id, data) {
  const task = getTaskById(id);
  if (!task) return null;
  Object.assign(task, data, { updatedAt: nowISO() });
  await DB.putTask(task);
  await logActivity("Update Task", task.title);
  return task;
}

async function changeTaskStatus(id, newStatus) {
  const task = getTaskById(id);
  if (!task) return;
  const oldStatus = task.status;
  task.status = newStatus;
  task.updatedAt = nowISO();
  if (newStatus === "done") task.progress = 100;
  await DB.putTask(task);
  await logActivity("Change Status", `${task.title}: ${oldStatus} → ${newStatus}`);
}

async function deleteTask(id) {
  const task = getTaskById(id);
  if (!task) return;
  await DB.deleteTask(id);
  AppState.tasks = AppState.tasks.filter(t => t.id !== id);
  await logActivity("Delete Task", task.title);
}

/* =========================================================
   5. RENDER — DASHBOARD
   ========================================================= */
function renderDashboard() {
  const tasks = AppState.tasks;
  const total = tasks.length;
  const todo = tasks.filter(t => t.status === "todo").length;
  const inprogress = tasks.filter(t => t.status === "inprogress").length;
  const done = tasks.filter(t => t.status === "done").length;
  const overdue = tasks.filter(t => getDueState(t) === "overdue").length;

  document.getElementById("stat-total").textContent = total;
  document.getElementById("stat-todo").textContent = todo;
  document.getElementById("stat-inprogress").textContent = inprogress;
  document.getElementById("stat-done").textContent = done;
  document.getElementById("stat-overdue").textContent = overdue;

  drawStatusChart(todo, inprogress, done);
  drawPriorityChart(
    tasks.filter(t => t.priority === "low").length,
    tasks.filter(t => t.priority === "medium").length,
    tasks.filter(t => t.priority === "high").length
  );
  drawCompletionChart(total ? Math.round((done / total) * 100) : 0);
}

/* =========================================================
   6. RENDER — KANBAN BOARD
   ========================================================= */
function getFilteredTasks() {
  const term = AppState.searchTerm.trim().toLowerCase();
  return AppState.tasks.filter(t => {
    if (term) {
      const haystack = (t.title + " " + t.description + " " + (t.tags || []).join(" ")).toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    if (AppState.filterPriority && t.priority !== AppState.filterPriority) return false;
    if (AppState.filterDue) {
      const state = getDueState(t);
      if (AppState.filterDue === "overdue" && state !== "overdue") return false;
      if (AppState.filterDue === "today" && state !== "today") return false;
      if (AppState.filterDue === "week") {
        if (!t.dueDate) return false;
        const due = new Date(t.dueDate);
        const today = new Date();
        const weekLater = new Date();
        weekLater.setDate(today.getDate() + 7);
        if (due < today || due > weekLater) return false;
      }
    }
    return true;
  });
}

function renderKanban() {
  const filtered = getFilteredTasks();
  const columns = { todo: [], inprogress: [], done: [] };
  filtered.forEach(t => { if (columns[t.status]) columns[t.status].push(t); });

  // urutkan: overdue paling atas, lalu berdasarkan updatedAt terbaru
  Object.keys(columns).forEach(key => {
    columns[key].sort((a, b) => {
      const aOver = getDueState(a) === "overdue" ? 0 : 1;
      const bOver = getDueState(b) === "overdue" ? 0 : 1;
      if (aOver !== bOver) return aOver - bOver;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
  });

  ["todo", "inprogress", "done"].forEach(status => {
    const container = document.getElementById(`cards-${status}`);
    const list = columns[status];
    document.getElementById(`count-${status}`).textContent = list.length;
    container.innerHTML = "";

    if (list.length === 0) {
      container.innerHTML = `<div class="empty-state">Tidak ada tugas</div>`;
      return;
    }

    // lazy render: batasi jumlah kartu yang dirender sekaligus demi performa
    const renderList = list.slice(0, AppState.cardRenderCap);
    const frag = document.createDocumentFragment();
    renderList.forEach(task => frag.appendChild(buildTaskCard(task)));
    container.appendChild(frag);

    if (list.length > AppState.cardRenderCap) {
      const more = document.createElement("div");
      more.className = "empty-state";
      more.textContent = `+${list.length - AppState.cardRenderCap} tugas lain (gunakan pencarian untuk menemukan)`;
      container.appendChild(more);
    }
  });
}

function buildTaskCard(task) {
  const card = document.createElement("div");
  const dueState = getDueState(task);
  card.className = "task-card" + (dueState === "overdue" ? " overdue" : dueState === "today" ? " due-today" : task.status === "done" ? " is-done" : "");
  card.draggable = true;
  card.dataset.id = task.id;

  const tagsHtml = (task.tags || []).map(tag => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join("");

  let dueBadge = "";
  if (dueState === "overdue") dueBadge = `<span class="badge badge-overdue">Overdue</span>`;
  else if (dueState === "today") dueBadge = `<span class="badge badge-today">Hari Ini</span>`;
  else if (task.status === "done") dueBadge = `<span class="badge badge-done">Done</span>`;

  card.innerHTML = `
    <div class="task-card-title">${escapeHtml(task.title)}</div>
    ${task.description ? `<div class="task-card-desc">${escapeHtml(task.description)}</div>` : ""}
    <div class="task-card-meta">
      <span class="badge badge-${task.priority}">${task.priority}</span>
      ${dueBadge}
    </div>
    ${tagsHtml ? `<div class="task-card-tags">${tagsHtml}</div>` : ""}
    <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${task.progress}%"></div></div>
    <div class="task-card-footer">
      <span>📅 ${fmtDate(task.dueDate)}</span>
      <span>${task.progress}%</span>
    </div>
  `;

  card.addEventListener("click", () => openTaskModal(task.id));
  card.addEventListener("dragstart", () => { card.classList.add("dragging"); dragState.taskId = task.id; });
  card.addEventListener("dragend", () => { card.classList.remove("dragging"); dragState.taskId = null; });

  return card;
}

/* =========================================================
   7. DRAG & DROP KANBAN
   ========================================================= */
const dragState = { taskId: null };

function setupDragAndDrop() {
  document.querySelectorAll(".kanban-cards").forEach(col => {
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("drag-over");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("drag-over");
      const newStatus = col.dataset.status;
      if (dragState.taskId) {
        await changeTaskStatus(dragState.taskId, newStatus);
        renderKanban();
        renderDashboard();
      }
    });
  });
}

/* =========================================================
   8. SEARCH & FILTER
   ========================================================= */
function setupSearchAndFilter() {
  const searchInput = document.getElementById("search-input");
  searchInput.addEventListener("input", debounce(() => {
    AppState.searchTerm = searchInput.value;
    renderKanban();
  }, 200));

  document.getElementById("filter-priority").addEventListener("change", (e) => {
    AppState.filterPriority = e.target.value;
    renderKanban();
  });
  document.getElementById("filter-due").addEventListener("change", (e) => {
    AppState.filterDue = e.target.value;
    renderKanban();
  });
  document.getElementById("btn-clear-filter").addEventListener("click", () => {
    AppState.searchTerm = ""; AppState.filterPriority = ""; AppState.filterDue = "";
    searchInput.value = "";
    document.getElementById("filter-priority").value = "";
    document.getElementById("filter-due").value = "";
    renderKanban();
  });
}

/* =========================================================
   9. CANVAS CHARTS (native, tanpa library eksternal)
   ========================================================= */
function clearCanvas(ctx, canvas) { ctx.clearRect(0, 0, canvas.width, canvas.height); }

function getCssVar(name) { return getComputedStyle(document.body).getPropertyValue(name).trim(); }

function drawStatusChart(todo, inprogress, done) {
  const canvas = document.getElementById("chart-status");
  const ctx = canvas.getContext("2d");
  clearCanvas(ctx, canvas);
  const data = [
    { label: "To Do", value: todo, color: getCssVar("--text-soft") },
    { label: "Progress", value: inprogress, color: getCssVar("--yellow") },
    { label: "Done", value: done, color: getCssVar("--green") }
  ];
  drawBarChart(ctx, canvas, data);
}

function drawPriorityChart(low, medium, high) {
  const canvas = document.getElementById("chart-priority");
  const ctx = canvas.getContext("2d");
  clearCanvas(ctx, canvas);
  const data = [
    { label: "Low", value: low, color: getCssVar("--text-soft") },
    { label: "Medium", value: medium, color: getCssVar("--yellow") },
    { label: "High", value: high, color: getCssVar("--red") }
  ];
  drawBarChart(ctx, canvas, data);
}

function drawBarChart(ctx, canvas, data) {
  const W = canvas.width, H = canvas.height;
  const max = Math.max(1, ...data.map(d => d.value));
  const barWidth = 56;
  const gap = (W - barWidth * data.length) / (data.length + 1);
  const chartTop = 20, chartBottom = H - 36;
  const chartHeight = chartBottom - chartTop;

  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";

  data.forEach((d, i) => {
    const x = gap + i * (barWidth + gap);
    const barH = (d.value / max) * chartHeight;
    const y = chartBottom - barH;

    // batang
    ctx.fillStyle = d.color || "#5B5FEF";
    roundRect(ctx, x, y, barWidth, barH, 8);
    ctx.fill();

    // nilai di atas batang
    ctx.fillStyle = getCssVar("--text");
    ctx.fillText(d.value, x + barWidth / 2, y - 8);

    // label di bawah
    ctx.fillStyle = getCssVar("--text-soft");
    ctx.fillText(d.label, x + barWidth / 2, chartBottom + 18);
  });

  // garis dasar
  ctx.strokeStyle = getCssVar("--border");
  ctx.beginPath();
  ctx.moveTo(0, chartBottom);
  ctx.lineTo(W, chartBottom);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  if (h < 1) h = 1;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCompletionChart(percent) {
  const canvas = document.getElementById("chart-completion");
  const ctx = canvas.getContext("2d");
  clearCanvas(ctx, canvas);
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2 - 5, radius = 75;

  // lingkar latar
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.lineWidth = 18;
  ctx.strokeStyle = getCssVar("--border");
  ctx.stroke();

  // arc completion
  const endAngle = -Math.PI / 2 + (percent / 100) * Math.PI * 2;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, -Math.PI / 2, endAngle);
  ctx.lineWidth = 18;
  ctx.strokeStyle = getCssVar("--primary");
  ctx.lineCap = "round";
  ctx.stroke();

  // teks tengah
  ctx.fillStyle = getCssVar("--text");
  ctx.font = "bold 26px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(percent + "%", cx, cy);
  ctx.font = "12px sans-serif";
  ctx.fillStyle = getCssVar("--text-soft");
  ctx.fillText("Selesai", cx, cy + 22);
}

/* =========================================================
   10. EXPORT DATA (CSV & JSON)
   ========================================================= */
const EXPORT_FIELDS = ["id", "title", "description", "priority", "status", "startDate", "dueDate", "progress", "tags", "notes", "createdAt", "updatedAt"];

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const str = value === undefined || value === null ? "" : String(value);
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

function tasksToCSV(tasks) {
  const header = EXPORT_FIELDS.join(",");
  const rows = tasks.map(t => EXPORT_FIELDS.map(f => {
    const val = f === "tags" ? (t.tags || []).join("|") : t[f];
    return csvEscape(val);
  }).join(","));
  return [header, ...rows].join("\n");
}

function exportCSV() {
  const csv = tasksToCSV(AppState.tasks);
  downloadFile(csv, `taskflow-export-${Date.now()}.csv`, "text/csv");
  logActivity("Export Data", `CSV (${AppState.tasks.length} task)`);
  showToast("Export CSV berhasil", "success");
}

function exportJSON() {
  const json = JSON.stringify(AppState.tasks, null, 2);
  downloadFile(json, `taskflow-export-${Date.now()}.json`, "application/json");
  logActivity("Export Data", `JSON (${AppState.tasks.length} task)`);
  showToast("Export JSON berhasil", "success");
}

/* =========================================================
   11. IMPORT DATA — parsing, validasi, preview, deteksi duplikat
   ========================================================= */

// parser CSV sederhana yang mendukung quoted field (termasuk koma/newline di dalam quote)
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

function csvRowsToTasks(rows) {
  if (rows.length === 0) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(cols => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = cols[i] !== undefined ? cols[i] : ""; });
    obj.tags = obj.tags ? obj.tags.split("|").map(s => s.trim()).filter(Boolean) : [];
    obj.progress = Number(obj.progress) || 0;
    return obj;
  });
}

// validasi satu baris data import. Mengembalikan { valid, reason }
function validateImportRow(row) {
  if (!row.title || !String(row.title).trim()) return { valid: false, reason: "Judul kosong" };
  if (row.priority && !["low", "medium", "high"].includes(row.priority)) row.priority = "medium";
  if (row.status && !["todo", "inprogress", "done"].includes(row.status)) row.status = "todo";
  if (!row.priority) row.priority = "medium";
  if (!row.status) row.status = "todo";
  return { valid: true };
}

// deteksi duplikat sesuai aturan: prioritas 1 = ID sama, prioritas 2 = title+dueDate+status sama
function findDuplicate(row, existingTasks) {
  if (row.id) {
    const byId = existingTasks.find(t => t.id === row.id);
    if (byId) return byId;
  }
  return existingTasks.find(t =>
    t.title === row.title &&
    (t.dueDate || "") === (row.dueDate || "") &&
    t.status === (row.status || "todo")
  ) || null;
}

let pendingImportRows = []; // baris yang valid & baru, siap diimport setelah konfirmasi

function processImportRows(rawRows) {
  const existingTasks = AppState.tasks;
  let totalData = rawRows.length, dataBaru = 0, dataDuplikat = 0, dataInvalid = 0;
  const previewRows = [];

  rawRows.forEach(row => {
    const validation = validateImportRow(row);
    if (!validation.valid) {
      dataInvalid++;
      previewRows.push({ row, statusLabel: "Invalid", cls: "import-status-invalid" });
      return;
    }
    const dup = findDuplicate(row, existingTasks);
    if (dup) {
      dataDuplikat++;
      previewRows.push({ row, statusLabel: "Duplikat", cls: "import-status-dup" });
    } else {
      dataBaru++;
      previewRows.push({ row, statusLabel: "Baru", cls: "import-status-new" });
      pendingImportRows.push(row);
    }
  });

  renderImportPreview(previewRows, { totalData, dataBaru, dataDuplikat, dataInvalid });
}

function renderImportPreview(previewRows, summary) {
  const summaryEl = document.getElementById("import-summary");
  summaryEl.innerHTML = `
    <strong>Preview Import</strong><br>
    Total Data: ${summary.totalData}<br>
    Data Baru: <span class="import-status-new">${summary.dataBaru}</span><br>
    Data Duplikat: <span class="import-status-dup">${summary.dataDuplikat}</span><br>
    Data Tidak Valid: <span class="import-status-invalid">${summary.dataInvalid}</span>
  `;

  const tbody = document.getElementById("import-preview-tbody");
  tbody.innerHTML = "";
  previewRows.slice(0, 200).forEach(({ row, statusLabel, cls }) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.title || "-")}</td>
      <td>${escapeHtml(row.status || "-")}</td>
      <td>${escapeHtml(row.priority || "-")}</td>
      <td>${escapeHtml(row.dueDate || "-")}</td>
      <td class="${cls}">${statusLabel}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("modal-import").classList.add("active");
}

async function confirmImport() {
  let added = 0;
  for (const row of pendingImportRows) {
    const task = {
      id: row.id && row.id.trim() ? row.id.trim() : uuid(),
      title: row.title.trim(),
      description: row.description || "",
      priority: row.priority || "medium",
      status: row.status || "todo",
      startDate: row.startDate || "",
      dueDate: row.dueDate || "",
      progress: Number(row.progress) || 0,
      tags: row.tags || [],
      notes: row.notes || "",
      createdAt: row.createdAt || nowISO(),
      updatedAt: nowISO()
    };
    await DB.putTask(task);
    AppState.tasks.push(task);
    added++;
  }
  await logActivity("Import Data", `${added} task ditambahkan`);
  showToast(`Import selesai. ${added} task baru ditambahkan.`, "success");
  pendingImportRows = [];
  document.getElementById("modal-import").classList.remove("active");
  renderKanban(); renderDashboard();
}

function handleImportFile(file, type) {
  const reader = new FileReader();
  reader.onload = (e) => {
    pendingImportRows = [];
    try {
      let rows;
      if (type === "json") {
        const parsed = JSON.parse(e.target.result);
        rows = Array.isArray(parsed) ? parsed : (parsed.tasks || []);
      } else {
        rows = csvRowsToTasks(parseCSV(e.target.result));
      }
      processImportRows(rows);
    } catch (err) {
      showToast("Gagal membaca file: format tidak valid", "error");
      console.error(err);
    }
  };
  reader.readAsText(file);
}

/* =========================================================
   12. BACKUP & RESTORE (seluruh database, format JSON)
   ========================================================= */
async function backupData() {
  const tasks = AppState.tasks;
  const logs = await DB.getAllLogs();
  const payload = { type: "taskflow-backup", version: 1, exportedAt: nowISO(), tasks, logs };
  downloadFile(JSON.stringify(payload, null, 2), `taskflow-backup-${Date.now()}.json`, "application/json");
  showToast("Backup berhasil dibuat", "success");
}

function restoreData(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const payload = JSON.parse(e.target.result);
      if (!payload || !Array.isArray(payload.tasks)) throw new Error("Format backup tidak valid");
      if (!confirm(`Restore akan MENGGANTI seluruh data saat ini dengan ${payload.tasks.length} task dari file backup. Lanjutkan?`)) return;

      await DB.clearTasks();
      await DB.clearLogs();
      for (const t of payload.tasks) await DB.putTask(t);
      if (Array.isArray(payload.logs)) {
        for (const l of payload.logs) await DB.addLog({ action: l.action, detail: l.detail, timestamp: l.timestamp });
      }
      AppState.tasks = await DB.getAllTasks();
      await logActivity("Restore Data", `${payload.tasks.length} task dipulihkan dari backup`);
      renderKanban(); renderDashboard(); AppState.logOffset = 0; renderActivityLogPage(true);
      showToast("Restore data berhasil", "success");
    } catch (err) {
      showToast("Gagal restore: " + err.message, "error");
    }
  };
  reader.readAsText(file);
}

/* =========================================================
   13. ACTIVITY LOG — lazy load / pagination
   ========================================================= */
async function renderActivityLogPage(reset = false) {
  if (reset) {
    AppState.logOffset = 0;
    document.getElementById("activity-tbody").innerHTML = "";
  }
  const logs = await DB.getLogsPage(AppState.logOffset, AppState.logPageSize);
  const tbody = document.getElementById("activity-tbody");

  if (logs.length === 0 && AppState.logOffset === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="empty-state">Belum ada aktivitas</td></tr>`;
  }

  const frag = document.createDocumentFragment();
  logs.forEach(log => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${fmtDateTime(log.timestamp)}</td><td>${escapeHtml(log.action)}</td><td>${escapeHtml(log.detail || "")}</td>`;
    frag.appendChild(tr);
  });
  tbody.appendChild(frag);
  AppState.logOffset += logs.length;

  const loadMoreBtn = document.getElementById("btn-load-more-log");
  const total = await DB.countLogs();
  loadMoreBtn.style.display = AppState.logOffset >= total ? "none" : "block";
}

/* =========================================================
   14. NAVIGASI ANTAR VIEW
   ========================================================= */
const VIEW_TITLES = { dashboard: "Dashboard", kanban: "Kanban Board", activity: "Activity Log", settings: "Settings" };

function switchView(view) {
  AppState.currentView = view;
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById(`view-${view}`).classList.add("active");
  document.getElementById("view-title").textContent = VIEW_TITLES[view];

  document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === view));

  if (view === "dashboard") renderDashboard();
  if (view === "kanban") renderKanban();
  if (view === "activity") renderActivityLogPage(true);

  // tutup sidebar mobile setelah navigasi
  document.getElementById("sidebar").classList.remove("open");
}

function setupNavigation() {
  document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener("click", () => switchView(item.dataset.view));
  });
  document.getElementById("btn-menu-toggle").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("open");
  });
}

/* =========================================================
   15. MODAL TASK (Tambah / Edit)
   ========================================================= */
function openTaskModal(taskId = null) {
  const modal = document.getElementById("modal-task");
  const form = document.getElementById("form-task");
  form.reset();
  document.getElementById("task-id").value = "";
  document.getElementById("btn-delete-task").style.display = "none";
  document.getElementById("progress-value-label").textContent = "0";

  if (taskId) {
    const task = getTaskById(taskId);
    if (!task) return;
    document.getElementById("modal-task-title").textContent = "Edit Tugas";
    document.getElementById("task-id").value = task.id;
    document.getElementById("task-title").value = task.title;
    document.getElementById("task-description").value = task.description || "";
    document.getElementById("task-priority").value = task.priority;
    document.getElementById("task-status").value = task.status;
    document.getElementById("task-start-date").value = task.startDate || "";
    document.getElementById("task-due-date").value = task.dueDate || "";
    document.getElementById("task-progress").value = task.progress || 0;
    document.getElementById("progress-value-label").textContent = task.progress || 0;
    document.getElementById("task-tags").value = (task.tags || []).join(", ");
    document.getElementById("task-notes").value = task.notes || "";
    document.getElementById("btn-delete-task").style.display = "inline-block";
  } else {
    document.getElementById("modal-task-title").textContent = "Tugas Baru";
  }

  modal.classList.add("active");
}

function closeTaskModal() { document.getElementById("modal-task").classList.remove("active"); }

function setupTaskModal() {
  document.getElementById("btn-new-task").addEventListener("click", () => openTaskModal());
  document.getElementById("btn-close-task-modal").addEventListener("click", closeTaskModal);
  document.getElementById("btn-cancel-task").addEventListener("click", closeTaskModal);
  document.getElementById("modal-task").addEventListener("click", (e) => { if (e.target.id === "modal-task") closeTaskModal(); });

  document.getElementById("task-progress").addEventListener("input", (e) => {
    document.getElementById("progress-value-label").textContent = e.target.value;
  });

  document.getElementById("form-task").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("task-id").value;
    const data = {
      title: document.getElementById("task-title").value,
      description: document.getElementById("task-description").value,
      priority: document.getElementById("task-priority").value,
      status: document.getElementById("task-status").value,
      startDate: document.getElementById("task-start-date").value,
      dueDate: document.getElementById("task-due-date").value,
      progress: Number(document.getElementById("task-progress").value),
      tags: document.getElementById("task-tags").value.split(",").map(s => s.trim()).filter(Boolean),
      notes: document.getElementById("task-notes").value
    };

    if (!data.title.trim()) { showToast("Judul tugas wajib diisi", "error"); return; }

    if (id) await updateTask(id, data);
    else await createTask(data);

    closeTaskModal();
    renderKanban();
    renderDashboard();
    showToast("Tugas berhasil disimpan", "success");
  });

  document.getElementById("btn-delete-task").addEventListener("click", async () => {
    const id = document.getElementById("task-id").value;
    if (!id) return;
    if (!confirm("Hapus tugas ini?")) return;
    await deleteTask(id);
    closeTaskModal();
    renderKanban();
    renderDashboard();
    showToast("Tugas dihapus", "info");
  });
}

/* =========================================================
   16. MODAL IMPORT
   ========================================================= */
function setupImportModal() {
  document.getElementById("btn-close-import-modal").addEventListener("click", () => {
    pendingImportRows = [];
    document.getElementById("modal-import").classList.remove("active");
  });
  document.getElementById("btn-cancel-import").addEventListener("click", () => {
    pendingImportRows = [];
    document.getElementById("modal-import").classList.remove("active");
  });
  document.getElementById("btn-confirm-import").addEventListener("click", confirmImport);
}

/* =========================================================
   17. SETTINGS
   ========================================================= */
function applyTheme() {
  document.body.classList.toggle("dark", AppState.darkMode);
  document.getElementById("toggle-dark-mode").checked = AppState.darkMode;
  document.getElementById("btn-theme-toggle").textContent = AppState.darkMode ? "☀️" : "🌙";
  // redraw chart agar warna sesuai tema baru
  if (AppState.currentView === "dashboard") renderDashboard();
}

function setupSettings() {
  document.getElementById("toggle-dark-mode").addEventListener("change", (e) => {
    AppState.darkMode = e.target.checked;
    saveSettings();
    applyTheme();
  });
  document.getElementById("btn-theme-toggle").addEventListener("click", () => {
    AppState.darkMode = !AppState.darkMode;
    saveSettings();
    applyTheme();
  });

  document.getElementById("btn-export-csv").addEventListener("click", exportCSV);
  document.getElementById("btn-export-json").addEventListener("click", exportJSON);

  document.getElementById("btn-import-csv").addEventListener("click", () => document.getElementById("file-import-csv").click());
  document.getElementById("btn-import-json").addEventListener("click", () => document.getElementById("file-import-json").click());
  document.getElementById("file-import-csv").addEventListener("change", (e) => { if (e.target.files[0]) handleImportFile(e.target.files[0], "csv"); e.target.value = ""; });
  document.getElementById("file-import-json").addEventListener("change", (e) => { if (e.target.files[0]) handleImportFile(e.target.files[0], "json"); e.target.value = ""; });

  document.getElementById("btn-backup").addEventListener("click", backupData);
  document.getElementById("btn-restore").addEventListener("click", () => document.getElementById("file-restore").click());
  document.getElementById("file-restore").addEventListener("change", (e) => { if (e.target.files[0]) restoreData(e.target.files[0]); e.target.value = ""; });

  document.getElementById("btn-reset-all").addEventListener("click", async () => {
    if (!confirm("Semua data task dan log aktivitas akan DIHAPUS PERMANEN. Lanjutkan?")) return;
    await DB.clearTasks();
    await DB.clearLogs();
    AppState.tasks = [];
    renderKanban(); renderDashboard(); AppState.logOffset = 0; renderActivityLogPage(true);
    showToast("Semua data telah direset", "info");
  });

  document.getElementById("btn-clear-log").addEventListener("click", async () => {
    if (!confirm("Hapus seluruh riwayat aktivitas?")) return;
    await DB.clearLogs();
    AppState.logOffset = 0;
    renderActivityLogPage(true);
    showToast("Log aktivitas dihapus", "info");
  });

  document.getElementById("btn-load-more-log").addEventListener("click", () => renderActivityLogPage(false));
}

/* =========================================================
   18. INISIALISASI APLIKASI
   ========================================================= */
async function initApp() {
  loadSettings();
  applyTheme();

  await openDB();
  AppState.tasks = await DB.getAllTasks();

  setupNavigation();
  setupTaskModal();
  setupImportModal();
  setupSearchAndFilter();
  setupSettings();
  setupDragAndDrop();

  renderDashboard();
  renderKanban();

  // registrasi Service Worker untuk dukungan offline / PWA
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(err => {
      console.warn("Service worker gagal didaftarkan:", err);
    });
  }
}

document.addEventListener("DOMContentLoaded", initApp);
