/* ============ CSV Parser ============ */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; }
        else { inQuotes = false; i++; }
      } else { field += c; i++; }
    } else {
      if (c === '"') { inQuotes = true; i++; }
      else if (c === ",") { row.push(field); field = ""; i++; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        rows.push(row); row = [];
        i++;
      } else { field += c; i++; }
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function toCsv(headers, rows) {
  const out = [headers];
  for (const r of rows) out.push(r);
  const q = s => {
    const v = String(s);
    return (v.includes('"') || v.includes(",") || v.includes("\n") || v.includes("\r"))
      ? '"' + v.replace(/"/g, '""') + '"'
      : v;
  };
  return out.map(r => r.map(q).join(",")).join("\n");
}

/* ============ State ============
   Model: a real header row + data rows (spreadsheet-style).
   All arrays are equal length = colCount. */
const state = {
  headers: [],     // string[]
  rows: [],        // string[][]
  colCount: 0,
  selectedRow: -1, // hovered/active row (for keyboard nav), -1 = none
  editingRow: -1,  // row index being edited
  editingCol: -1,  // col index being edited
  searchQuery: "",
  sortCol: -1,     // -1 = none
  sortDir: 0,      // 1 asc, -1 desc
  history: [],
  historyIndex: -1,
};
const LS_KEY = "tabula:v1";
const HISTORY_MAX = 50; // cap undo snapshots so a large grid doesn't bloat memory
let isSaved = true; // false once the grid diverges from any exported/saved file
let windowState = null; // { start, end, vis } shared by renderBody() and renderStats()

const save = () => JSON.stringify({ headers: state.headers, rows: state.rows });
const restore = (snap) => {
  const d = JSON.parse(snap);
  state.headers = d.headers;
  state.rows = d.rows;
  state.colCount = d.headers.length;
};

/* ============ DOM refs ============ */
const $ = id => document.getElementById(id);
const scroller = $("scroller");
const head = $("head");
const body = $("body");
const empty = $("empty");
const dragOverlay = $("dragOverlay");
const toast = $("toast");
const fileInput = $("fileInput");
const filenameInput = $("filename");
const dot = $("dot");
const searchInput = $("search");
const searchClear = $("searchClear");
const statCounts = $("statCounts");
const statSort = $("statSort");
const statSearch = $("statSearch");
const btnUndo = $("btnUndo");
const btnRedo = $("btnRedo");
const btnPaste = $("btnPaste");
const btnNew = $("btnNew");
const btnExport = $("btnExport");
const btnSample = $("btnSample");
const btnEmptyOpen = $("btnEmptyOpen");
const modalRoot = $("modalRoot");
const modalTitle = $("modalTitle");
const modalText = $("modalText");
const modalCancel = $("modalCancel");
const modalOk = $("modalOk");

/* ============ Toast ============ */
let toastTimer = null;
function showToast(msg, type) {
  toast.textContent = msg;
  toast.className = "toast show" + (type === "error" ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

/* ============ Autosave / dirty state ============ */
function markDirty() {
  if (isSaved) { isSaved = false; updateDirty(); }
  scheduleAutosave();
}
function updateDirty() {
  dot.hidden = isSaved;
}
let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveToLocal, 400);
}
function saveToLocal() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      version: 1,
      filename: filenameInput.value,
      headers: state.headers,
      rows: state.rows,
    }));
  } catch (_) { /* quota / private mode */ }
}
function markSaved() {
  isSaved = true;
  updateDirty();
  saveToLocal();
}
function loadFromLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.headers) || !Array.isArray(d.rows)) return false;
    let maxC = d.headers.length;
    for (const r of d.rows) if (r.length > maxC) maxC = r.length;
    for (const r of d.rows) while (r.length < maxC) r.push("");
    state.headers = d.headers;
    state.rows = d.rows;
    if (d.filename) filenameInput.value = d.filename;
    resetState(true);
    state.history = []; state.historyIndex = -1;
    pushHistory();
    scroller.scrollTop = 0;
    render();
    return true;
  } catch (_) { return false; }
}

/* ============ Undo / Redo ============ */
function pushHistory() {
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(save());
  state.historyIndex++;
  if (state.history.length > HISTORY_MAX) {
    const drop = state.history.length - HISTORY_MAX;
    state.history.splice(0, drop);
    state.historyIndex -= drop;
  }
  updateUndoButtons();
}
function undo() {
  if (state.historyIndex < 0) return;
  state.historyIndex--;
  restore(state.history[state.historyIndex]);
  stopEdit();
  render();
  updateUndoButtons();
}
function redo() {
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex++;
  restore(state.history[state.historyIndex]);
  stopEdit();
  render();
  updateUndoButtons();
}
function updateUndoButtons() {
  btnUndo.disabled = state.historyIndex < 0;
  btnRedo.disabled = state.historyIndex >= state.history.length - 1;
}

/* ============ Search ============ */
function visibleRows() {
  if (!state.searchQuery) return state.rows.map((_, i) => i);
  const q = state.searchQuery.toLowerCase();
  const out = [];
  for (let i = 0; i < state.rows.length; i++) {
    if (state.rows[i].some(c => String(c).toLowerCase().includes(q))) out.push(i);
  }
  return out;
}

/* ============ Sort ============ */
function applySort() {
  if (state.sortCol < 0 || state.sortDir === 0) return;
  const col = state.sortCol, dir = state.sortDir;
  state.rows.sort((a, b) => {
    const av = String(a[col] ?? ""), bv = String(b[col] ?? "");
    const an = Number(av.replace(/[$,\s]/g, ""));
    const bn = Number(bv.replace(/[$,\s]/g, ""));
    if (av !== "" && av.trim() !== "" && !isNaN(an) && isFinite(an) && bv.trim() !== "" && !isNaN(bn) && isFinite(bn)) {
      return (an - bn) * dir;
    }
    return av.localeCompare(bv, undefined, { numeric: true }) * dir;
  });
}
function toggleSort(col) {
  if (state.sortCol !== col) { state.sortCol = col; state.sortDir = 1; }
  else if (state.sortDir === 1) { state.sortDir = -1; }
  else { state.sortCol = -1; state.sortDir = 0; }
  if (state.sortCol >= 0) applySort();
  pushHistory();
  markDirty();
  render();
}

/* ============ Rendering ============ */
function render() {
  const hasData = state.rows.length > 0 || state.headers.length > 0;
  empty.hidden = hasData;
  scroller.style.visibility = hasData ? "" : "hidden";

  if (!hasData) {
    windowState = { vis: [] };
    head.innerHTML = "<tr><th class='colnum'>&nbsp;</th></tr>";
    body.innerHTML = "";
    scroller.scrollTop = 0;
    statCounts.textContent = "empty grid";
    statSort.hidden = true;
    statSearch.hidden = true;
    dot.hidden = true;
    return;
  }

  renderHeader();
  renderBody();
  renderStats();
}

const esc = s => {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
};
const escAttr = s => (s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderHeader() {
  // Fixed column widths: table sizes itself to colnum(46)+addcol(34)+N*120,
  // so wide files stay readable and scroll instead of squishing to the viewport.
  if (head.parentElement) head.parentElement.style.setProperty("--grid-cols", state.headers.length);
  let html = "<tr><th class='colnum'>#</th>";
  for (let c = 0; c < state.headers.length; c++) {
    const isSorted = state.sortCol === c;
    const cls = isSorted ? (state.sortDir === 1 ? "sorted-asc" : "sorted-desc") : "";
    html += `<th class="${cls}"><div class="th-inner">
      <span class="th-label">${esc(state.headers[c] || "Column " + (c + 1))}
        <svg class="sort-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path data-dir="asc" d="M18 15l-6-6-6 6"/><path data-dir="desc" d="M6 9l6 6 6-6"/>
        </svg>
      </span>
      <div class="th-actions">
        <button type="button" title="Sort ascending" data-action="sort-asc" data-col="${c}" aria-label="Sort ${esc(state.headers[c])} ascending">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 15l-6-6-6 6"/></svg>
        </button>
        <button type="button" title="Sort descending" data-action="sort-desc" data-col="${c}" aria-label="Sort ${esc(state.headers[c])} descending">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <button type="button" title="Delete column" class="danger" data-action="del-col" data-col="${c}" aria-label="Delete column ${c + 1}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div></th>`;
  }
  html += `<th class="th-addcol"><div class="th-inner"><div class="th-actions" style="opacity:1;position:static">
    <button type="button" title="Add column" data-action="add-col" aria-label="Add column">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
  </div></div></th>`;
  html += "</tr>";
  head.innerHTML = html;
}

/* ---------- Virtualisation ----------
   Only the rows in the viewport (+ overscan) are in the DOM; a `#padTop`
   spacer provides the scrollback. Row height is fixed at 30px, so the window
   can be computed from scrollTop alone. DOM stays ~40-60 rows regardless of
   file size, which is what keeps a 50k-row grid responsive. */
const ROW_H = 30;
const OVERSCAN = 10;

function windowBounds(total) {
  const st = scroller.scrollTop;
  const vh = scroller.clientHeight || 800;
  let s = Math.floor(st / ROW_H) - OVERSCAN;
  let e = Math.ceil((st + vh) / ROW_H) + OVERSCAN;
  return { s: Math.max(0, s), e: Math.min(total, e) };
}

function paintBody() {
  const vis = windowState.vis;
  const total = vis.length;
  const searching = state.searchQuery !== "";
  const { s, e } = windowBounds(total);
  let html = `<tr id="padTop" class="pad" aria-hidden="true"><td style="width:100%;"></td></tr>`;
  if (searching && total === 0) {
    html += `<tr class="no-match"><td colspan="${state.headers.length + 2}">No rows match &ldquo;${esc(state.searchQuery)}&rdquo;</td></tr>`;
  }
  for (let p = s; p < e; p++) {
    const i = vis[p];
    const parts = [];
    if (i % 2 === 1) parts.push("zebra");
    if (searching) parts.push("is-match");
    if (i === state.selectedRow) parts.push("active-row");
    html += rowHtml(i, parts.join(" "));
  }
  html += `<tr class="row-add">
    <td class="rownum" data-action="add-row" role="button" tabindex="0" title="Add row">+</td>
    <td class="add-hint" colspan="${state.headers.length}" data-action="add-row" role="button" tabindex="0">Click to add a new row</td>
    <td class="rowdel"></td>
  </tr>`;
  body.innerHTML = html;
  const pad = body.querySelector("#padTop");
  if (pad) pad.style.height = (s * ROW_H) + "px";
}

function rowHtml(i, cls) {
  const row = state.rows[i];
  let h = `<tr class="${cls}" data-ri="${i}"><td class="rownum">${i + 1}</td>`;
  for (let c = 0; c < state.headers.length; c++) {
    const val = row[c] !== undefined ? row[c] : "";
    if (state.editingRow === i && state.editingCol === c) {
      h += `<td class="cell editing"><input type="text" class="cell-input" value="${escAttr(val)}" data-ri="${i}" data-c="${c}"/></td>`;
    } else {
      h += `<td class="cell" data-ri="${i}" data-c="${c}"><span class="cell-display ${val !== "" ? "" : "is-empty"}">${val === "" ? "&nbsp;" : esc(val)}</span></td>`;
    }
  }
  h += `<td class="rowdel"><button type="button" class="rowdel-btn" data-action="del-row" data-ri="${i}" title="Delete row ${i + 1}" aria-label="Delete row ${i + 1}">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
  </button></td></tr>`;
  return h;
}

function renderBody() {
  windowState = { vis: visibleRows() };
  paintBody();
  if (state.editingRow >= 0) {
    const input = body.querySelector('.cell-input[data-ri="' + state.editingRow + '"][data-c="' + state.editingCol + '"]');
    if (input) { input.focus(); input.select(); }
  }
}

let scrollRAF = 0;
function onScroll() {
  if (scrollRAF) return;
  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = 0;
    if (windowState) paintBody(); // vis unchanged; only the window shifts
  });
}
scroller.addEventListener("scroll", onScroll, { passive: true });

function scrollToEnd() {
  if (!windowState) return;
  scroller.scrollTop = scroller.scrollHeight;
  paintBody();
}

function renderStats() {
  updateDirty();
  statCounts.textContent = `${state.rows.length} rows × ${state.headers.length} columns`;
  if (state.sortCol >= 0) {
    const h = state.headers[state.sortCol] || "Column " + (state.sortCol + 1);
    statSort.textContent = (state.sortDir === 1 ? "↑" : "↓") + ` sorted by "${h}"`;
    statSort.hidden = false;
  } else {
    statSort.hidden = true;
  }
  if (state.searchQuery) {
    const n = windowState ? windowState.vis.length : visibleRows().length;
    statSearch.textContent = `${n} of ${state.rows.length} match`;
    statSearch.hidden = false;
  } else {
    statSearch.hidden = true;
  }
}

/* ============ Editing ============ */
function startEdit(ri, c) {
  if (ri < 0 || ri >= state.rows.length) return;
  state.editingRow = ri;
  state.editingCol = c;
  state.selectedRow = ri;
  render();
}
function stopEdit() {
  state.editingRow = -1;
  state.editingCol = -1;
}
// Commit the active cell editor into the model. Reads the current input value,
// records history only if the value actually changed, then clears the editor.
function commitEditing() {
  if (state.editingRow < 0) return;
  const ri = state.editingRow, c = state.editingCol;
  let val = state.rows[ri][c];
  const active = document.activeElement;
  if (active && active.classList && active.classList.contains("cell-input")) {
    val = active.value;
  }
  state.editingRow = -1;
  state.editingCol = -1;
  if (val !== state.rows[ri][c]) {
    state.rows[ri][c] = val;
    markDirty();
    pushHistory();
  }
}
function commitEdit(down) {
  if (state.editingRow < 0) { render(); return; }
  const ri = state.editingRow;
  commitEditing();
  if (down && ri < state.rows.length - 1) state.selectedRow = ri + 1;
  render();
}

/* ============ Body clicks ============ */
body.addEventListener("click", (e) => {
  const del = e.target.closest('[data-action="del-row"]');
  if (del) {
    if (state.editingRow >= 0) commitEditing();
    deleteRow(parseInt(del.dataset.ri, 10));
    return;
  }
  const add = e.target.closest('[data-action="add-row"]');
  if (add) {
    if (state.editingRow >= 0) commitEditing();
    addRow();
    return;
  }
  const cell = e.target.closest("td.cell");
  if (cell) {
    if (state.editingRow >= 0) commitEditing();
    startEdit(parseInt(cell.dataset.ri, 10), parseInt(cell.dataset.c, 10));
    return;
  }
  const rownum = e.target.closest("td.rownum[data-ri]");
  if (rownum && document.activeElement !== document.body) state.selectedRow = parseInt(rownum.dataset.ri, 10);
});
// Start a new edit when clicking into the header/gutter while an editor is open.
document.addEventListener("mousedown", (e) => {
  if (state.editingRow < 0) return;
  if (e.target.closest && e.target.closest("td.cell.editing")) return;
  commitEditing();
  render();
});

/* ============ Keyboard ============ */
document.addEventListener("keydown", (e) => {
  const editingInput = document.activeElement && document.activeElement.classList &&
                       document.activeElement.classList.contains("cell-input");

  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    exportCsv();
    return;
  }
  if (editingInput) {
    const ri = state.editingRow, c = state.editingCol;
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit(false);
      if (ri < state.rows.length - 1) startEdit(ri + 1, c);
      else render();
    } else if (e.key === "Escape") {
      e.preventDefault();
      state.editingRow = -1; state.editingCol = -1;
      render();
    } else if (e.key === "Tab") {
      e.preventDefault();
      commitEditing();
      if (e.shiftKey) {
        if (c > 0) startEdit(ri, c - 1);
        else if (ri > 0) startEdit(ri - 1, state.headers.length - 1);
        else render();
      } else {
        if (c < state.headers.length - 1) startEdit(ri, c + 1);
        else if (ri < state.rows.length - 1) startEdit(ri + 1, 0);
        else render();
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault(); commitEdit(false); if (ri < state.rows.length - 1) startEdit(ri + 1, c);
    } else if (e.key === "ArrowUp") {
      e.preventDefault(); commitEdit(false); if (ri > 0) startEdit(ri - 1, c);
    }
    return;
  }

  // not editing
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.activeElement === searchInput) return;

  const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " ", "Backspace", "Delete"];
  if (!keys.includes(e.key)) return;
  e.preventDefault();

  if (e.key === "Backspace" || e.key === "Delete") {
    if (state.selectedRow >= 0) {
      const ri = state.selectedRow;
      deleteRow(ri);
      state.selectedRow = Math.max(0, Math.min(ri, state.rows.length - 1));
      render();
    }
    return;
  }
  if (state.rows.length === 0) {
    if (e.key === "Enter" || e.key === " ") addRow();
    return;
  }
  if (state.selectedRow < 0) state.selectedRow = 0;
  if (e.key === "ArrowDown") state.selectedRow = Math.min(state.rows.length - 1, state.selectedRow + 1);
  else if (e.key === "ArrowUp") state.selectedRow = Math.max(0, state.selectedRow - 1);
  if (e.key === "ArrowUp" || e.key === "ArrowDown") { render(); return; }
  if (e.key === "Enter" || e.key === " ") {
    const c = state.editingCol >= 0 ? state.editingCol : 0;
    startEdit(state.selectedRow, c);
    return;
  }
});

/* ============ Row / column ops ============ */
function addRow() {
  state.rows.push(new Array(state.headers.length).fill(""));
  markDirty();
  pushHistory();
  scroller.scrollTop = scroller.scrollHeight; // jump to the new (last) row
  render();
  if (state.rows.length) startEdit(state.rows.length - 1, 0);
}

function deleteRow(ri) {
  if (state.rows.length === 0) return;
  if (state.rows.length === 1) {
    confirmAction("Delete the only row?", "This clears every row of the grid.", () => {
      state.rows = [];
      state.selectedRow = -1;
      markDirty();
      pushHistory();
      render();
      showToast("Row deleted");
    });
    return;
  }
  state.rows.splice(ri, 1);
  state.selectedRow = Math.min(Math.max(0, ri), state.rows.length - 1);
  markDirty();
  pushHistory();
  render();
  showToast("Row deleted");
}

function addColumn() {
  state.headers.push("Column " + (state.headers.length + 1));
  for (const r of state.rows) { while (r.length < state.headers.length) r.push(""); }
  markDirty();
  pushHistory();
  render();
  showToast("Column added");
}

function deleteColumn(c) {
  confirmAction(`Delete column "${state.headers[c] || "Column " + (c + 1)}"?`,
    "Removes this column from every row. Undo is available after.", () => {
      state.headers.splice(c, 1);
      for (const r of state.rows) r.splice(c, 1);
      if (state.sortCol === c) { state.sortCol = -1; state.sortDir = 0; }
      else if (state.sortCol > c) state.sortCol--;
      markDirty();
      pushHistory();
      render();
      showToast("Column deleted");
    });
}

/* ============ Header clicks ============ */
head.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (btn) {
    const a = btn.dataset.action, c = parseInt(btn.dataset.col, 10);
    if (a === "add-col") addColumn();
    else if (a === "del-col") deleteColumn(c);
    else if (a === "sort-asc") { state.sortCol = c; state.sortDir = 1; applySort(); pushHistory(); render(); }
    else if (a === "sort-desc") { state.sortCol = c; state.sortDir = -1; applySort(); pushHistory(); render(); }
    return;
  }
  const th = e.target.closest("th");
  if (!th) return;
  const cells = head.querySelectorAll("tr > th");
  let idx = Array.prototype.indexOf.call(cells, th);
  if (idx <= 0 || idx > state.headers.length) return; // gutter or add-col header
  toggleSort(idx - 1);
});

/* ============ Search ============ */
let searchTimer = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.searchQuery = searchInput.value.trim();
    searchClear.hidden = !state.searchQuery;
    render();
  }, 120);
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    searchInput.value = "";
    state.searchQuery = "";
    searchClear.hidden = true;
    searchInput.blur();
    render();
  }
});
searchClear.addEventListener("click", () => {
  searchInput.value = "";
  state.searchQuery = "";
  searchClear.hidden = true;
  searchInput.focus();
  render();
});

/* ============ Load data ============ */
function resetState(keepFilename) {
  state.selectedRow = -1;
  state.editingRow = -1;
  state.editingCol = -1;
  state.sortCol = -1;
  state.sortDir = 0;
  state.searchQuery = "";
  searchInput.value = "";
  searchClear.hidden = true;
  state.history = [];
  state.historyIndex = -1;
  if (!keepFilename) filenameInput.value = "untitled";
  // every resetState() call is a fresh load -> grid matches source, not dirty
  isSaved = true;
  updateDirty();
  saveToLocal();
}

/* Parse + normalise, always succeeds or throws. Works on the main thread (and
   is duplicated inside parsing.worker.js so large files don't block the UI). */
function parseText(text) {
  const rows = parseCsv(text);
  while (rows.length && rows[rows.length - 1].every(c => c === "")) rows.pop();
  if (!rows.length) return { headers: ["Column 1"], data: [[""]] };
  let maxC = 0;
  for (const r of rows) if (r.length > maxC) maxC = r.length;
  for (const r of rows) while (r.length < maxC) r.push("");
  const headers = rows[0].map((h, i) => h !== "" ? h : "Column " + (i + 1));
  const data = rows.length === 1 ? [new Array(headers.length).fill("")] : rows.slice(1);
  return { headers, data };
}

let parseWorker = null;
let parseSeq = 0;
function worker() {
  if (!parseWorker) {
    try { parseWorker = new Worker("parsing.worker.js"); } catch (_) { parseWorker = null; }
  }
  return parseWorker;
}
function parseAsync(text) {
  return new Promise((resolve, reject) => {
    const w = worker();
    if (!w) {
      try { resolve(parseText(text)); } catch (e) { reject(e); }
      return;
    }
    const id = ++parseSeq;
    const settle = (fn, val) => { clearTimeout(timer); fn(val); };
    // If the worker never answers, recover by parsing on the main thread
    // rather than leaving the user hung.
    const timer = setTimeout(() => {
      try { resolve(parseText(text)); } catch (e) { reject(e); }
      try { w.terminate(); } catch (_) {}
      parseWorker = null;
    }, 15000);
    w.onmessage = (e) => {
      const d = e.data || {};
      if (d.id !== id) return;
      if (d.ok) settle(resolve, { headers: d.headers, data: d.data });
      else settle(reject, new Error(d.error || "parse failed"));
    };
    try { w.postMessage({ id, raw: text }); }
    catch (e) { clearTimeout(timer); reject(e); }
  });
}

function applyLoaded(headers, data) {
  state.headers = headers;
  state.rows = data;
  resetState(true);
  scroller.scrollTop = 0;
  pushHistory();
  render();
}

async function loadText(text, name) {
  let res;
  try { res = await parseAsync(text); }
  catch (err) { showToast("Could not parse file", "error"); return; }
  if (name) filenameInput.value = name.replace(/\.[^.]+$/, "");
  applyLoaded(res.headers, res.data);
  showToast(`Loaded ${res.data.length} data row${res.data.length === 1 ? "" : "s"}`);
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(Error("read failed"));
    r.readAsText(file);
  });
}

/* ============ Buttons ============ */
btnUndo.addEventListener("click", undo);
btnRedo.addEventListener("click", redo);
btnExport.addEventListener("click", exportCsv);
btnSample.addEventListener("click", loadSample);
btnEmptyOpen.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  readFileAsText(f).then(text => loadText(text, f.name)).catch(() => showToast("Could not read file", "error"));
  e.target.value = "";
});

btnNew.addEventListener("click", () => {
  confirmAction("Start a new grid?", "All current data will be lost (it cannot be undone).", () => {
    state.headers = ["Column 1"];
    state.rows = [[""]];
    resetState(false);
    pushHistory();
    render();
    showToast("New grid started");
  });
});

btnPaste.addEventListener("click", async () => {
  let text;
  try { text = await navigator.clipboard.readText(); }
  catch { showToast("Clipboard blocked — paste with Ctrl+V into a cell instead", "error"); return; }
  if (!text || !text.trim()) { showToast("Clipboard is empty", "error"); return; }
  if (state.rows.some(r => r.some(c => c !== ""))) {
    confirmAction("Paste from clipboard?", "Replaces the current grid with the pasted CSV data.", () => loadText(text, filenameInput.value));
  } else {
    loadText(text, filenameInput.value);
  }
});

/* ============ Drag & drop ============ */
const dropzone = $("dropzone");
let dragDepth = 0;
dropzone.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; dragOverlay.hidden = false; });
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; });
dropzone.addEventListener("dragleave", (e) => { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) dragOverlay.hidden = true; });
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  dragOverlay.hidden = true;
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  readFileAsText(f).then(text => loadText(text, f.name)).catch(() => showToast("Could not read file", "error"));
});

/* ============ Export ============ */
function exportCsv() {
  if (state.rows.length === 0 && state.headers.length === 0) { showToast("Nothing to export", "error"); return; }
  const csv = toCsv(state.headers, state.rows);
  const name = (filenameInput.value.trim() || "untitled").replace(/\.[^.]+$/, "");
  const blob = new Blob([csv + "\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name + ".csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  markSaved();
  showToast(`Exported ${name}.csv`);
}

/* ============ Sample data ============ */
function loadSample() {
  const headers = ["Name", "Department", "Salary", "Joined", "Location"];
  const rows = [
    ["Alice Chen", "Engineering", "128000", "2021-03-15", "Berlin"],
    ["Bob Martinez", "Design", "95000", "2019-08-01", "Remote"],
    ["Carla Novak", "Engineering", "135000", "2020-01-10", "Prague"],
    ["David Kim", "Product", "112000", "2022-06-20", "Seoul"],
    ["Emma Wilson", "Marketing", "88000", "2023-02-14", "London"],
    ["Farid Haddad", "Engineering", "142000", "2018-11-05", "Tel Aviv"],
    ["Greta Müller", "Finance", "105000", "2021-09-01", "Munich"],
    ["Hiro Tanaka", "Design", "98000", "2020-04-18", "Tokyo"],
    ["Ingrid Larsen", "Engineering", "138000", "2019-07-22", "Oslo"],
  ];
  state.headers = headers;
  state.rows = rows;
  resetState(true);
  filenameInput.value = "sample";
  pushHistory();
  render();
  showToast("Sample data loaded");
}

/* ============ Modal ============ */
let modalCallback = null;
function confirmAction(title, text, cb) {
  modalTitle.textContent = title;
  modalText.textContent = text;
  modalRoot.hidden = false;
  modalCallback = cb;
  modalOk.focus();
}
modalOk.addEventListener("click", () => {
  modalRoot.hidden = true;
  const cb = modalCallback; modalCallback = null;
  if (cb) cb();
});
modalCancel.addEventListener("click", () => { modalRoot.hidden = true; modalCallback = null; });
modalRoot.addEventListener("click", (e) => { if (e.target === modalRoot) { modalRoot.hidden = true; modalCallback = null; } });

/* ============ Init ============ */
updateUndoButtons();
if (!loadFromLocal()) loadSample();
