/* ============ CSV Parser ============ */
function detectDelim(text) {
  const first = (text.split(/\r?\n/, 1)[0] || "");
  const tabs = (first.match(/\t/g) || []).length;
  const commas = (first.match(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g) || []).length;
  return tabs > commas && tabs > 0 ? "\t" : ",";
}
function parseCsv(text, delim = ",") {
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
      else if (c === delim) { row.push(field); field = ""; i++; }
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

function toCsv(headers, rows, delim = ",") {
  const out = [headers];
  for (const r of rows) out.push(r);
  const q = s => {
    const v = String(s);
    return (v.includes('"') || v.includes(delim) || v.includes("\n") || v.includes("\r"))
      ? '"' + v.replace(/"/g, '""') + '"'
      : v;
  };
  return out.map(r => r.map(q).join(delim)).join("\n");
}

/* ============ Formula engine ============
   A cell holds a formula when its text starts with "=" (after trim).
   Everything else is plain text, so old grids keep working unchanged.

   Grammar (lowest → highest precedence):
     expr   := term  ( ("+" | "-") term )*
     term   := factor ( ("*" | "/") factor )* ["%"]       "%": trailing /100
     factor := ("+" | "-") factor | primary
     primary:= NUMBER | "string" | IDENT "(" expr ("," expr)* ")"
              | IDENT (":" IDENT)?                         A1 · C:C · A1:B3 · alias

   Functions (case-insensitive): SUM, AVERAGE, MIN, MAX, COUNT.
   References: cell A1, column C:C, range A1:B5, and header-name aliases:
   "=SUM(Salary)" works when a header is "Salary"; "=Salary*0.10" uses the
   column's first data row (per-row math still uses explicit A1 refs).
   Errors (spreadsheet-style, they propagate):
   #CYCLE! circular · #REF! bad reference · #NAME? unknown function ·
   #VALUE! bad operand · #DIV/0! division by zero.

   Results are only recomputed when a render() happens (i.e. when the grid
   changed); formulas never mutate the data. */
class FErr {
  constructor(text) { this.text = text; }
  toString() { return this.text; }
}
const F_FUNCTS = {
  sum:     nums => nums.reduce((a, b) => a + b, 0),
  average: nums => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null),
  min:     nums => (nums.length ? Math.min.apply(null, nums) : null),
  max:     nums => (nums.length ? Math.max.apply(null, nums) : null),
  count:   nums => nums.length,
};
function ftokenize(src) {
  const toks = [];
  let i = 0;
  const isD = c => c >= "0" && c <= "9";
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (isD(c)) {
      let j = i;
      while (j < src.length && isD(src[j])) j++;
      if (j < src.length && src[j] === "." && isD(src[j + 1] || "0")) {
        j++;
        while (j < src.length && isD(src[j])) j++;
      }
      toks.push({ t: "num", v: parseFloat(src.slice(i, j)) });
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: "id", v: src.slice(i, j).toUpperCase() });
      i = j; continue;
    }
    if (c === '"') {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== '"' && src[j] !== "\n") {
        if (src[j] === "\\" && j + 1 < src.length) { s += src[j + 1]; j += 2; }
        else { s += src[j]; j++; }
      }
      if (j >= src.length) throw new FErr("#VALUE!");
      toks.push({ t: "str", v: s });
      i = j + 1; continue;
    }
    if ("+-*/%():,".indexOf(c) >= 0) { toks.push({ t: c }); i++; continue; }
    throw new FErr("#VALUE!");
  }
  return toks;
}
// Recursive-descent parser. Nodes:
//   {v: num} | {v: string} | {fn, args[]} | {ref: "A1"} | {ref: "A1:B3"} |
//   {op: "+|-*|/|neg", l, r?} — evaluated by fEvalNode.
function fParse(src) {
  const toks = ftokenize(src);
  if (!toks.length) throw new FErr("#VALUE!");
  let p = 0;
  const peek = () => toks[p];
  const take = () => toks[p++];
  function expr() {
    let n = term();
    for (;;) {
      const t = peek();
      if (t && (t.t === "+" || t.t === "-")) { take(); n = { op: t.t, l: n, r: term() }; }
      else break;
    }
    return n;
  }
  function term() {
    let n = factor();
    for (;;) {
      const t = peek();
      if (t && (t.t === "*" || t.t === "/")) { take(); n = { op: t.t, l: n, r: factor() }; }
      else break;
    }
    return n;
  }
  function factor() {
    const t = peek();
    if (t && (t.t === "+" || t.t === "-")) {
      take();
      const n = factor();
      return t.t === "-" ? { op: "neg", l: n } : n;
    }
    let n = primary();
    // "%" is a postfix on a single factor (Excel semantics): 16% → 0.16, so
    // "16%*100" = 16 rather than "(16*100)%" .
    const t2 = peek();
    if (t2 && t2.t === "%") { take(); n = { op: "pct", l: n }; }
    return n;
  }
  function primary() {
    const t = take();
    if (t.t === "num" || t.t === "str") return { v: t.v };
    if (t.t === "(") {
      const n = expr();
      const c = take();
      if (c.t !== ")") throw new FErr("#VALUE!");
      return n;
    }
    if (t.t === "id") {
      let nx = peek();
      if (nx && nx.t === "(") {
        take();
        const args = [];
        for (;;) {
          if (peek() && peek().t === ")") { take(); break; }
          args.push(expr());
          const nx2 = peek();
          if (nx2 && nx2.t === ",") { take(); continue; }
          const c = take();
          if (c.t !== ")") throw new FErr("#VALUE!");
          break;
        }
        return { fn: t.v.toLowerCase(), args };
      }
      if (nx && nx.t === ":") {
        take();
        const b = take();
        if (b.t !== "id") throw new FErr("#REF!");
        return { ref: t.v + ":" + b.v };
      }
      return { ref: t.v };
    }
    throw new FErr("#VALUE!");
  }
  const root = expr();
  if (p < toks.length) throw new FErr("#VALUE!");
  return root;
}
// A–Z→0, AA–… (A=0, B=1 … Z=25, AA=26). Out of grid width → null.
function fColIndex(letter) {
  const up = String(letter).toUpperCase();
  if (!/^[A-Z]{1,9}$/.test(up)) return null;
  let c = 0;
  for (let i = 0; i < up.length; i++) c = c * 26 + (up.charCodeAt(i) - 64);
  c -= 1;
  if (c < 0 || c >= state.headers.length) return null;
  return c;
}
// Resolve a reference string to a list of [row, col] cells.
//   A1 → one cell · C:C → whole column · A1:B3 → rectangle · A:B → two columns
function fRefCells(ref) {
  const parts = String(ref).trim().split(":");
  if (parts.length < 1 || parts.length > 2) return { error: new FErr("#REF!") };
  const parseOne = (s) => {
    const m = /^([A-Za-z]{1,9})(\d+)?$/.exec(s.trim());
    if (!m) return null;
    const c = fColIndex(m[1]);
    if (c === null) return null;
    const r = m[2] ? parseInt(m[2], 10) - 1 : null;
    if (r !== null && r > 1000000) return null;
    return { c, r };
  };
  const a = parseOne(parts[0]);
  if (!a) return { error: new FErr("#REF!") };
  if (parts.length === 1) {
    if (a.r === null) {                                  // whole column (e.g. SUM(A))
      if (state.rows.length === 0) return { error: new FErr("#REF!") };
      const cells = [];
      for (let r = 0; r < state.rows.length; r++) cells.push([r, a.c]);
      return { cells };
    }
    if (a.r >= state.rows.length) return { error: new FErr("#REF!") };
    return { cells: [[a.r, a.c]] };
  }
  const b = parseOne(parts[1]);
  if (!b) return { error: new FErr("#REF!") };
  if (state.rows.length === 0) return { error: new FErr("#REF!") };
  const r1 = a.r === null ? 0 : Math.min(a.r, state.rows.length - 1);
  const r2 = b.r === null ? state.rows.length - 1 : Math.min(b.r, state.rows.length - 1);
  if (r1 > r2) return { error: new FErr("#REF!") };
  const c1 = Math.min(a.c, b.c), c2 = Math.max(a.c, b.c);
  if ((r2 - r1 + 1) * (c2 - c1 + 1) > 200000) return { error: new FErr("#REF!") };
  const cells = [];
  for (let r = r1; r <= r2; r++)
    for (let c = c1; c <= c2; c++) cells.push([r, c]);
  return { cells };
}
// Evaluate a parsed node. `resolve(r, c)` returns {n, e, text?} for a
// dependency cell (implemented by resolveCellInner with cycle tracking).
// Returns { n: number|null, text?: string, e: FErr|null }.
function fEvalNode(node, resolve) {
  const fail = t => ({ n: null, e: new FErr(t) });
  if (node === null) return { n: null, e: null };
  if (node.v !== undefined) {
    return typeof node.v === "number" ? { n: node.v, e: null }
      : { n: null, text: node.v, e: null };
  }
  if (node.op === "neg") {
    const r = fEvalNode(node.l, resolve);
    if (r.e) return r;
    return { n: r.n === null ? null : -r.n, e: null };
  }
  if (node.op === "pct") {
    const r = fEvalNode(node.l, resolve);
    if (r.e) return r;
    return { n: r.n === null ? null : r.n / 100, e: null };
  }
  if (node.op) {
    const L = fEvalNode(node.l, resolve), R = fEvalNode(node.r, resolve);
    if (L.e) return L;
    if (R.e) return R;
    if (L.n === null || R.n === null) return fail("#VALUE!");
    if (node.op === "+") return { n: L.n + R.n, e: null };
    if (node.op === "-") return { n: L.n - R.n, e: null };
    if (node.op === "*") return { n: L.n * R.n, e: null };
    if (node.op === "/") {
      if (R.n === 0) return fail("#DIV/0!");
      return { n: L.n / R.n, e: null };
    }
    return fail("#VALUE!");
  }
  if (node.fn) {
    const F = F_FUNCTS[node.fn];
    if (!F) return fail("#NAME?");
    const nums = [];
    for (const a of node.args) {
      if (a.ref) {
        const rc = fRefCells(a.ref);
        if (rc.error) {
          // Header-name alias: SUM(Salary) → the column behind "Salary".
          const hi = state.headers.findIndex(h => String(h).trim().toLowerCase() === a.ref.toLowerCase());
          if (hi >= 0) {
            for (let r = 0; r < state.rows.length; r++) {
              const v = resolve(r, hi);
              if (v.e) return { n: null, e: v.e };
              if (v.n !== null) nums.push(v.n);
            }
            continue;
          }
          return { n: null, e: rc.error };
        }
        for (const [r, c] of rc.cells) {
          const v = resolve(r, c);
          if (v.e) return { n: null, e: v.e };
          if (v.n !== null) nums.push(v.n);
        }
      } else {
        const v = fEvalNode(a, resolve);
        if (v.e) return { n: null, e: v.e };
        if (v.n !== null) nums.push(v.n);
      }
    }
    const res = F(nums);
    if (res === null || res === undefined) return { n: null, e: null };
    if (!isFinite(res)) return fail("#VALUE!");
    return { n: res, e: null };
  }
  if (node.ref) {
    const rc = fRefCells(node.ref);
    if (rc.error) {
      // Header alias used as a value: =Salary*0.10 → first data row of column
      const hi = state.headers.findIndex(h => String(h).trim().toLowerCase() === node.ref.toLowerCase());
      if (hi >= 0) {
        const v = resolve(0, hi);
        return v.e ? { n: null, e: v.e } : { n: v.n, e: null };
      }
      return { n: null, e: rc.error };
    }
    if (rc.cells.length === 1) {
      const [r, c] = rc.cells[0];
      const v = resolve(r, c);
      return v.e ? { n: null, e: v.e } : { n: v.n, text: v.text, e: null };
    }
    return fail("#VALUE!"); // bare range as a value
  }
  return fail("#VALUE!");
}
function evalFormula(src, ctx) {
  const body = String(src).trim().replace(/^=/, "");
  if (!body) return { n: null, e: new FErr("#VALUE!") };
  ctx = ctx || new Set();          // safe default — the public entry needs no arg
  let root;
  try { root = fParse(body); }
  catch (err) { return { n: null, e: err instanceof FErr ? err : new FErr("#VALUE!") }; }
  try { return fEvalNode(root, (r, c) => resolveCellInner(r, c, ctx)); }
  catch (err) { return { n: null, e: err instanceof FErr ? err : new FErr("#VALUE!") }; }
}
// Resolve one cell to its *computed* value: { n: number|null, text?: string, e: FErr|null }
function resolveCell(r, c) { return resolveCellInner(r, c, new Set()); }
function cellIsFormula(r, c) {
  const v = state.rows[r] && state.rows[r][c];
  return typeof v === "string" && v.trim().charAt(0) === "=";
}
function resolveCellInner(r, c, ctx) {
  if (r < 0 || r >= state.rows.length || c < 0 || c >= (state.headers.length || 0))
    return { n: null, e: new FErr("#REF!") };
  const v = state.rows[r][c];
  if (typeof v !== "string" || v.trim().charAt(0) !== "=") {
    const ti = typeInfo(v);
    if (ti.type === "number" || ti.type === "percent" || ti.type === "currency")
      return { n: ti.value, e: null };
    return { n: null, text: v === undefined || v === null ? "" : String(v), e: null };
  }
  const k = r + "," + c;
  if (ctx.has(k)) return { n: null, e: new FErr("#CYCLE!") };
  ctx.add(k);
  const out = evalFormula(v, ctx);
  ctx.delete(k);
  return out;
}
// The human-display text for a cell (grid paint). Plain cells return their
// stored text verbatim; formula cells resolve to a formatted value.
function cellDisplayText(r, c) {
  const v = state.rows[r] && state.rows[r][c];
  const raw = v === undefined || v === null ? "" : String(v);
  if (raw.trim().charAt(0) !== "=") return raw;            // plain → original
  const rv = resolveCell(r, c);
  if (rv.e) return rv.e.text;
  if (rv.n !== null) return fmtStat(rv.n);
  if (rv.text !== undefined) return rv.text;
  return raw;
}
// The RAW cell value for copy/export: plain cells return their stored text
// (so "$1,234" copies as "$1,234"); formula cells resolve to a plain decimal
// (1041000, not 1,041,000) so the CSV round-trips; errors pass through.
function cellValueText(r, c) {
  const v = state.rows[r] && state.rows[r][c];
  const raw = v === undefined || v === null ? "" : String(v);
  if (raw.trim().charAt(0) !== "=") return raw;            // plain → original
  const rv = resolveCell(r, c);
  if (rv.e) return rv.e.text;
  if (rv.n !== null) return String(rv.n);
  if (rv.text !== undefined) return rv.text;
  return raw;
}
// Spreadsheet-style column letter for a 0-based index (0 → A, 25 → Z, 26 → AA).
function colLetter(c) {
  let s = "";
  c = c + 1;
  while (c > 0) { const d = (c - 1) % 26; s = String.fromCharCode(65 + d) + s; c = Math.floor((c - 1) / 26); }
  return s;
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
  filters: {},     // { <colIndex>: Set<allowed values> }
  selectedCol: -1, // keyboard/copy anchor column
  history: [],
  historyIndex: -1,
  formats: {},      // { "r,c": {bold?,italic?,underline?,align?,wrap?} } — per-cell overrides
  cfRules: [],       // conditional-formatting rules (see the Conditional-formatting section)
};
// Per-cell formatting: { "r,c": {bold,italic,underline,align,wrap} } — values
// are set only when they differ from the default so snapshots stay compact.
// Lives in `state` so undo/redo and localStorage persisting cover it automatically.
const LS_KEY = "tabula:v1";
const HISTORY_MAX = 50; // cap undo snapshots so a large grid doesn't bloat memory
let isSaved = true; // false once the grid diverges from any exported/saved file
let windowState = null; // { start, end, vis } shared by renderBody() and renderStats()

const save = () => JSON.stringify({ headers: state.headers, rows: state.rows, formats: state.formats || {}, cfRules: state.cfRules || [] });
const restore = (snap) => {
  const d = JSON.parse(snap);
  state.headers = d.headers;
  state.rows = d.rows;
  state.colCount = d.headers.length;
  state.formats = d.formats || {};
  state.cfRules = d.cfRules || [];
};

/* ============ DOM refs ============ */
const $ = id => document.getElementById(id);
const scroller = $("scroller");
const head = $("head");
const body = $("body");
const colgroup = $("colgroup");
const empty = $("empty");
const dragOverlay = $("dragOverlay");
const toast = $("toast");
const fileInput = $("fileInput");
const filenameInput = $("filename");
const dot = $("dot");
const searchInput = $("search");
const fxName = $("fxName");
const fxInput = $("fxInput");
const searchClear = $("searchClear");
const statCounts = $("statCounts");
const gridChip = $("gridChip");
const gridRows = $("gridRows");
const gridCols = $("gridCols");
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
const btnTheme = $("btnTheme");
const btnTools = $("btnTools");
const toolsMenu = $("toolsMenu");
const btnStats = $("btnStats");
const btnChart = $("btnChart");
const chartRoot = $("chartRoot");
const chartCanvas = $("chartCanvas");
const chartHint = $("chartHint");
const chartShow = $("chartShow");
const chartClose = $("chartClose");
const chartFloat = $("chartFloat");
const chartFloatCanvas = $("chartFloatCanvas");
const chartFloatType = $("chartFloatType");
const chartFloatClose = $("chartFloatClose");
const filterPanelRoot = $("filterPanelRoot");
const filterPanel = $("filterPanel");
const filterPanelTitle = $("filterPanelTitle");
const filterPanelSub = $("filterPanelSub");
const filterPanelBody = $("filterPanelBody");
const filterPanelClose = $("filterPanelClose");
const filterPanelClear = $("filterPanelClear");
const filterPanelApply = $("filterPanelApply");
const filterLiveCount = $("filterLiveCount");
const exportMenu = $("exportMenu");
const statFilters = $("statFilters");
const statFiltersText = $("statFiltersText");
const clearFiltersBtn = $("clearFilters");

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
// Live grid-size chip in the top bar (rows × columns), kept in sync on every render.
function updateGridChip() {
  if (!gridRows || !gridCols) return;
  gridRows.textContent = state.rows.length;
  gridCols.textContent = state.headers.length;
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
  const q = state.searchQuery.toLowerCase();
  const activeCols = Object.keys(state.filters).map(Number);
  const hasFilter = activeCols.length > 0;
  const hasSearch = q !== "";
  if (!hasSearch && !hasFilter) return state.rows.map((_, i) => i);
  const out = [];
  for (let i = 0; i < state.rows.length; i++) {
    const r = state.rows[i];
    if (hasSearch && !r.some(c => String(c).toLowerCase().includes(q))) continue;
    if (hasFilter) {
      let ok = true;
      for (const c of activeCols) {
        if (!filterPredMatches(r[c], filterConfig(c))) { ok = false; break; }
      }
      if (!ok) continue;
    }
    out.push(i);
  }
  return out;
}
function hasActiveFilterSet() {
  return Object.keys(state.filters).length > 0;
}
function distinctValues(c) {
  const s = new Set();
  for (let i = 0; i < state.rows.length; i++) s.add(state.rows[i][c] === undefined ? "" : state.rows[i][c]);
  return s;
}
function clearFilters() {
  state.filters = {};
  closeFilterPanel();
  render();
}

/* ============ Sort ============ */
// Type-aware ordering: numeric types (number/percent/currency) and
// temporal types (date/datetime/time) compare by their comparable value;
// booleans by true/false; everything else (text, unknown) as locale text;
// empty cells always sink to the bottom regardless of direction.
function sortKey(v) {
  const ti = typeInfo(v);
  if (ti.type === "empty") return { kind: "empty" };
  if (ti.type === "number" || ti.type === "percent" || ti.type === "currency" ||
      ti.type === "date" || ti.type === "datetime" || ti.type === "time" ||
      ti.type === "boolean") return { kind: "value", value: ti.value };
  return { kind: "text", text: String(v) };
}
function cmpTyped(a, b) {
  const ka = sortKey(a), kb = sortKey(b);
  if (ka.kind === "empty" && kb.kind === "empty") return 0;
  if (ka.kind === "empty") return 1;            // empty always after
  if (kb.kind === "empty") return -1;
  if (ka.kind === "value" && kb.kind === "value") {
    const d = ka.value - kb.value;
    if (d !== 0) return d;
    // Equal numeric value but different display (e.g. "1,000" vs "1000") → keep stable by text
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }
  if (ka.kind === "text" && kb.kind === "text") return ka.text.localeCompare(kb.text, undefined, { numeric: true });
  // Mixed types: value-types before text-types (deterministic)
  return ka.kind === "value" ? -1 : 1;
}
function applySort() {
  if (state.sortCol < 0 || state.sortDir === 0) return;
  const col = state.sortCol, dir = state.sortDir;
  // Compare by row *index* so formulas can be resolved with their true row.
  const order = state.rows.map((_, i) => i);
  const val = idx => {
    const v = state.rows[idx][col];
    if (typeof v !== "string" || v.trim().charAt(0) !== "=") return v === undefined ? "" : v;
    const rv = resolveCell(idx, col);
    if (rv.e) return v;                    // errors sort as text
    if (rv.n !== null) return String(rv.n);
    if (rv.text !== undefined) return rv.text;
    return v;
  };
  order.sort((ia, ib) => cmpTyped(val(ia), val(ib)) * dir);
  state.rows = order.map(i => state.rows[i]);
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
    updateGridChip();
    statCounts.textContent = "empty grid";
    statSort.hidden = true;
    statSearch.hidden = true;
    dot.hidden = true;
    return;
  }

  renderHeader();
  renderBody();
  renderStats();
  if (chart) updateChartUI();
}

const esc = s => {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
};
const escAttr = s => (s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Smart column-type detection: classify every non-empty value in the column and
// report the dominant type (≥ 60% of non-empty cells). Powers the header badge
// and gives a stable "what is this column?" across display, sort and stats.
const TYPE_BADGE = {
  number:   { label: "#",    cls: "t-num",   title: "Number" },
  percent:  { label: "%",    cls: "t-pct",   title: "Percent" },
  currency: { label: "$",    cls: "t-cur",   title: "Currency" },
  date:     { label: "📅",   cls: "t-date",  title: "Date" },
  datetime: { label: "📅",   cls: "t-date",  title: "Date & time" },
  time:     { label: "⏱",    cls: "t-time",  title: "Time" },
  boolean:  { label: "✓",    cls: "t-bool",  title: "Boolean" },
  text:     { label: "Aa",   cls: "t-text",  title: "Text" },
};
function columnType(c) {
  const counts = {};
  let nonEmpty = 0;
  for (let i = 0; i < state.rows.length; i++) {
    const v = state.rows[i][c];
    if (v === undefined || String(v).trim() === "") continue;
    nonEmpty++;
    // Resolve formulas so a computed-number column is detected as numeric.
    let t;
    if (typeof v === "string" && v.trim().charAt(0) === "=") {
      const rv = resolveCell(i, c);
      if (rv.e) t = "text";
      else if (rv.n !== null) t = "number";
      else t = "text";
    } else t = typeInfo(v).type;
    counts[t] = (counts[t] || 0) + 1;
  }
  if (nonEmpty === 0) return { type: "empty", label: "", cls: "", title: "Empty" };
  let best = "text", bestN = 0;
  for (const t of Object.keys(counts)) {
    if (counts[t] > bestN) { bestN = counts[t]; best = t; }
  }
  if (bestN / nonEmpty < 0.6) best = "mixed";
  if (best === "mixed") return { type: "mixed", label: "±", cls: "t-mix", title: "Mixed types" };
  const b = TYPE_BADGE[best] || TYPE_BADGE.text;
  return { type: best, label: b.label, cls: b.cls, title: b.title };
}
function renderHeader() {
  // Fixed column widths: table sizes itself to colnum(46)+addcol(34)+N*120,
  // so wide files stay readable and scroll instead of squishing to the viewport.
  if (head.parentElement) head.parentElement.style.setProperty("--grid-cols", state.headers.length);
  syncColgroup();
  let html = "<tr><th class='colnum'>#</th>";
  for (let c = 0; c < state.headers.length; c++) {
    const isSorted = state.sortCol === c;
    const isFiltered = Object.prototype.hasOwnProperty.call(state.filters, c);
    const type = columnType(c);
    const cls = [
      isSorted ? (state.sortDir === 1 ? "sorted-asc" : "sorted-desc") : "",
      isFiltered ? "has-filter" : "",
      type.cls ? "has-type" : "",
    ].join(" ");
    const funnel = isFiltered
      ? "" : "opacity:.45;";
    const badge = type.label
      ? `<span class="col-type-badge ${type.cls}" title="Detected type: ${esc(type.title)}">${type.label}</span>`
      : "";
    html += `<th class="${cls}" data-col="${c}"><div class="th-inner">
      <button type="button" class="th-filter ${isFiltered ? "on" : ""}" style="${funnel}" data-action="filter-col" data-col="${c}" title="Filter ${esc(state.headers[c])}" aria-label="Filter ${esc(state.headers[c])}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
      </button>
      <div class="col-resize" data-col="${c}" title="Drag to resize · double-click to auto-fit" aria-hidden="true"></div>
      <span class="th-label">${esc(state.headers[c] || "Column " + (c + 1))}
        ${badge}
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

/* ============ Cell formatting (bold/italic/underline/align/wrap/clear) ============
   Per-cell overrides live in state.formats: { "r,c": {bold?,italic?,underline?,align?,wrap?} }.
   The keys are only created when a prop is actually set, so undo snapshots stay
   compact. `clearFormatting()` wipes the selection's props (keep the row/col intact).
   The toolbar's B/I/U buttons read `sel` and apply to the whole selection. */
function fmtKey(r, c) { return r + "," + c; }
function getCellFormat(r, c) { return (state.formats && state.formats[fmtKey(r, c)]) || null; }

// Apply (or clear, if props value is null) a set of formatting props to every
// cell in `sel`. `silent` skips history/dirty/render (used by tests).
function applyFormatToSelection(props, silent) {
  if (!sel) return false;
  let dirty = false;
  const r1 = sel.r1, r2 = sel.r2, c1 = sel.c1, c2 = sel.c2;
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      const k = fmtKey(r, c);
      const cur = (state.formats && state.formats[k]) || {};
      const next = { ...cur };
      for (const p in props) {
        const v = props[p];
        if (v === null || v === undefined) delete next[p];
        else next[p] = v;
        dirty = true;
      }
      state.formats[k] = next;
    }
  }
  if (!dirty) return false;
  // Drop empty keys in-place (cheap: only rows we touched)
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      const k = fmtKey(r, c);
      if (state.formats[k] && Object.keys(state.formats[k]).length === 0) delete state.formats[k];
    }
  }
  if (!silent) {
    markDirty();
    pushHistory();
    render();
    updateSelection();
  }
  return true;
}
function clearFormatting(silent) {
  if (!sel) return false;
  let changed = false;
  for (let r = sel.r1; r <= sel.r2; r++) {
    for (let c = sel.c1; c <= sel.c2; c++) {
      const k = fmtKey(r, c);
      if (state.formats[k]) { delete state.formats[k]; changed = true; }
    }
  }
  if (!changed) return false;
  if (!silent) { markDirty(); pushHistory(); render(); updateSelection(); }
  return true;
}
// Read the "effective" format for a cell: type-based default + user override.
function effectiveFormat(r, c, type) {
  const f = getCellFormat(r, c);
  const defaultAlign = (type === "number" || type === "percent" || type === "currency" ||
                        type === "date" || type === "datetime" || type === "time") ? "right" : "left";
  return {
    bold:      !!(f && f.bold),
    italic:    !!(f && f.italic),
    underline: !!(f && f.underline),
    align:     (f && f.align) || defaultAlign,
    wrap:      !!(f && f.wrap),
  };
}

/* ---- Formatting toolbar sync + actions ---- */
const FORMATTERS = {
  bold:      (on) => ({ bold: on ? true : null }),
  italic:    (on) => ({ italic: on ? true : null }),
  underline: (on) => ({ underline: on ? true : null }),
  wrap:      (on) => ({ wrap: on ? true : null }),
};
function selCells() {
  if (!sel) return [];
  const out = [];
  for (let r = sel.r1; r <= sel.r2; r++) for (let c = sel.c1; c <= sel.c2; c++) out.push([r, c]);
  return out;
}
// True if every cell in the selection carries the given formatting prop (bold/italic/underline/wrap).
function allHave(prop) {
  const cs = selCells();
  if (!cs.length) return false;
  return cs.every(([r, c]) => effectiveFormat(r, c, typeInfo((state.rows[r] || [])[c] ?? "").type)[prop]);
}
function alignOfSel() {
  const cs = selCells();
  if (!cs.length || cs.length === 0) return null;
  // "uniform" only if every cell's effective align is the same
  let seen = null;
  for (const [r, c] of cs) {
    const a = effectiveFormat(r, c, typeInfo(state.rows[r][c] ?? "").type).align;
    if (seen === null) seen = a;
    else if (seen !== a) return null;
  }
  return seen;
}
// Sync the B/I/U / align / wrap buttons' "on" state to the current selection.
function updateFmtToolbar() {
  const set = (id, on) => {
    const el = $("" + id);
    if (!el) return;
    el.classList.toggle("on", !!on);
    el.setAttribute("aria-pressed", on ? "true" : "false");
  };
  const has = sel && cs_len();
  if (!has) {
    ["fmtBold","fmtItalic","fmtUnder","fmtAlignL","fmtAlignC","fmtAlignR","fmtWrap"].forEach(id => set(id, false));
    return;
  }
  set("fmtBold", allHave("bold"));
  set("fmtItalic", allHave("italic"));
  set("fmtUnder", allHave("underline"));
  set("fmtWrap", allHave("wrap"));
  const a = alignOfSel();
  set("fmtAlignL", a === "left");
  set("fmtAlignC", a === "center");
  set("fmtAlignR", a === "right");
}
function cs_len() { return sel ? (sel.r2 - sel.r1 + 1) * (sel.c2 - sel.c1 + 1) : 0; }

function applyFmt(btnId, prop) {
  if (!sel) { showToast("Select cells first", "error"); return; }
  if (prop === "align-left" || prop === "align-center" || prop === "align-right") {
    const want = prop.slice("align-".length);        // "left" | "center" | "right"
    const now = alignOfSel();
    // Clicking the currently-active align resets to the column's type default.
    applyFormatToSelection(now === want ? { align: null } : { align: want });
    updateFmtToolbar();
    return;
  }
  const on = !allHave(prop);                          // bold / italic / underline / wrap
  applyFormatToSelection(FORMATTERS[prop](on));
  updateFmtToolbar();
}

const FORMATTING_BTN = {
  fmtBold: "bold", fmtItalic: "italic", fmtUnder: "underline",
  fmtAlignL: "align-left", fmtAlignC: "align-center", fmtAlignR: "align-right",
  fmtWrap: "wrap",
};
for (const id in FORMATTING_BTN) {
  const el = $(id); if (!el) continue;
  el.addEventListener("click", (e) => {
    e.preventDefault();
    const prop = FORMATTING_BTN[id];
    applyFmt(id, prop);
  });
}
const fmtClear = $("fmtClear");
if (fmtClear) fmtClear.addEventListener("click", (e) => {
  e.preventDefault();
  if (!sel) { showToast("Select cells first", "error"); return; }
  clearFormatting();
  updateFmtToolbar();
  showToast("Formatting cleared");
});

/* ---------- Virtualisation ----------
   Only the rows in the viewport (+ overscan) are in the DOM; a `#padTop`
   spacer provides the scrollback. `ROW_H` is the base height of a single-line
   cell; word-wrapped cells make their row taller. `windowState` carries a
   prefix sum of the VISIBLE rows' heights so `windowBounds` can binary-search
   the visible range in O(log n) — 50k rows stay responsive even with many
   wrapped cells, and it stays correct under search/filter. Invalidate
   `windowState=null` on any data/format/column/width change (renderBody rebuilds). */
const ROW_H = 30;
const OVERSCAN = 10;
const CELL_LINE_H = 18.4;   // 13px font * 1.45 line-height
const CELL_PAD_Y  = 10;     // 5px top + 5px bottom
// Height of one absolute row = max of its cells' heights (>= ROW_H). Wrapped
// cells estimate their line count from char length / column width.
function visibleRowHeight(ri) {
  const row = state.rows[ri];
  if (!row) return ROW_H;
  let maxH = ROW_H;
  for (let c = 0; c < state.headers.length; c++) {
    const v = row[c];
    if (v === undefined || v === null) continue;
    const s = String(v);
    if (s === "") continue;
    const f = (state.formats && state.formats[ri + "," + c]) || {};
    let h = CELL_PAD_Y + CELL_LINE_H;
    if (f.wrap) {
      const colW = colWidths[c] || 120;
      const cpl = Math.max(4, Math.floor(colW / 8.2));
      const lines = Math.max(1, Math.ceil(s.length / cpl));
      h = CELL_PAD_Y + lines * CELL_LINE_H;
    }
    if (h > maxH) maxH = h;
  }
  return maxH;
}
const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
const upperBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; } return lo; };

function windowBounds() {
  const vis = windowState.vis, prefix = windowState.prefix, n = vis.length;
  if (n === 0) return { s: 0, e: 0 };
  const st = scroller.scrollTop, vh = scroller.clientHeight || 800;
  let s = Math.max(0, upperBound(prefix, st) - 1);
  let e = Math.min(n - 1, lowerBound(prefix, st + vh));
  s = Math.max(0, s - OVERSCAN);
  e = Math.min(n - 1, e + OVERSCAN);
  return { s, e };
}
function paintBody() {
  const vis = windowState.vis, n = vis.length, searching = state.searchQuery !== "";
  const filtered = hasActiveFilterSet();
  const { s, e } = windowBounds();
  let html = `<tr id="padTop" class="pad" aria-hidden="true"><td style="width:100%;"></td></tr>`;
  if ((searching || filtered) && n === 0) {
    html += `<tr class="no-match"><td colspan="${state.headers.length + 2}">No rows match the current filters / search</td></tr>`;
  } else if (n > 0) {
    for (let p = s; p <= e; p++) {
      const i = vis[p];
      const parts = [];
      if (i % 2 === 1) parts.push("zebra");
      if (searching) parts.push("is-match");
      if (act && act.r === i) parts.push("active-row");
      html += rowHtml(i, parts.join(" "));
    }
  }
  html += `<tr class="row-add">
    <td class="rownum" data-action="add-row" role="button" tabindex="0" title="Add row">+</td>
    <td class="add-hint" colspan="${state.headers.length}" data-action="add-row" role="button" tabindex="0">Click to add a new row</td>
    <td class="rowdel"></td>
  </tr>`;
  body.innerHTML = html;
  body.querySelector("#padTop").style.height = windowState.prefix[s] + "px";
}
// Absolute row index under a point in the grid's content coordinate space.
function rowFromY(contentY) {
  if (!windowState || windowState.vis.length === 0) return 0;
  const k = Math.max(0, Math.min(windowState.vis.length - 1, upperBound(windowState.prefix, contentY) - 1));
  return windowState.vis[k];
}
function renderBody() {
  const vis = visibleRows();
  const prefix = [0];
  for (const i of vis) prefix.push(prefix[prefix.length - 1] + visibleRowHeight(i));
  windowState = { vis, prefix, totalH: prefix[prefix.length - 1] };
  paintBody();
  if (state.editingRow >= 0) {
    const input = body.querySelector('.cell-input[data-ri="' + state.editingRow + '"][data-c="' + state.editingCol + '"]');
    if (input) { input.focus(); input.select(); }
  }
}

function rowHtml(i, cls) {
  const row = state.rows[i];
  const rowSel = sel && sel.c1 === 0 && sel.c2 >= state.headers.length - 1 && i >= sel.r1 && i <= sel.r2;
  let h = `<tr class="${cls}${rowSel ? " row-sel" : ""}" data-ri="${i}"><td class="rownum${rowSel ? " sel-row" : ""}">${i + 1}</td>`;
  for (let c = 0; c < state.headers.length; c++) {
    const val = row[c] !== undefined ? row[c] : "";
    const cellSel = sel && i >= sel.r1 && i <= sel.r2 && c >= sel.c1 && c <= sel.c2;
    if (state.editingRow === i && state.editingCol === c) {
      const ti = typeInfo(val);
      const ef = effectiveFormat(i, c, ti.type);
      const fcls = [
        ef.bold ? "f-bold" : "", ef.italic ? "f-italic" : "", ef.underline ? "f-underline" : "",
        "f-align-" + ef.align, ef.wrap ? "f-wrap" : "",
      ].filter(Boolean).join(" ");
      h += `<td class="cell editing${cellSel ? " sel-cell" : ""} ${fcls.trim()}" data-ri="${i}" data-c="${c}"><input type="text" class="cell-input" value="${escAttr(val)}" data-ri="${i}" data-c="${c}"/></td>`;
    } else {
      const isF = typeof val === "string" && val.trim().charAt(0) === "=";
      let dispText = val === undefined ? "" : String(val);
      let isErr = false;
      let resolvedNum = null;
      if (isF) {
        const rv = resolveCell(i, c);
        if (rv.e) { dispText = rv.e.text; isErr = true; }
        else if (rv.n !== null) { dispText = fmtStat(rv.n); resolvedNum = rv.n; }
        else if (rv.text !== undefined) dispText = rv.text;
      }
      const ti = resolvedNum !== null
        ? { type: "number", value: resolvedNum, negative: resolvedNum < 0 }
        : isErr ? { type: "text", negative: false }
        : typeInfo(val);
      const ef = effectiveFormat(i, c, ti.type);
      let cls = cellSel ? " sel-cell" : "";
      if (ti.negative) cls += " is-neg";
      if (isErr) cls += " is-err";
      const fcls = [
        ef.bold ? "f-bold" : "", ef.italic ? "f-italic" : "", ef.underline ? "f-underline" : "",
        "f-align-" + ef.align, ef.wrap ? "f-wrap" : "",
      ].filter(Boolean).join(" ");
      // Conditional formatting: apply first matching rule's colors as CSS vars.
      let cfStyleAttr = "";
      const cfStyle = cfApply(i, c);
      if (cfStyle) { cls += " cf-on"; cfStyleAttr = ` style="--cf-bg:${cfStyle.bg};--cf-fg:${cfStyle.fg}"`; }
      const spanCls = dispText === "" ? "cell-display is-empty" : "cell-display";
      const dataT = isErr ? "error" : (resolvedNum !== null ? "number" : ti.type);
      const titleAttr = isF ? ` title="${escAttr("= " + val.trim().slice(1) + "  →  " + dispText)}"` : "";
      h += `<td class="cell${cls} ${fcls}" data-ri="${i}" data-c="${c}" data-type="${dataT}"${cfStyleAttr}${titleAttr}><span class="${spanCls}">${dispText === "" ? "&nbsp;" : esc(dispText)}</span></td>`;
    }
  }
  h += `<td class="rowdel"><button type="button" class="rowdel-btn" data-action="del-row" data-ri="${i}" title="Delete row ${i + 1}" aria-label="Delete row ${i + 1}">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
  </button></td></tr>`;
  return h;
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
  updateGridChip();
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
  if (hasActiveFilterSet()) {
    const parts = [];
    for (const k of Object.keys(state.filters).map(Number).sort((a, b) => a - b)) {
      const col = state.headers[k] || "Column " + (k + 1);
      const total = state.rows.length;
      let n = 0;
      for (let i = 0; i < total; i++) {
        if (filterMatchesCell(k, state.rows[i][k])) n++;
      }
      parts.push(`${col}: ${n}/${total}`);
    }
    statFiltersText.textContent = parts.join(" · ");
    statFilters.hidden = false;
    clearFiltersBtn.hidden = false;
  } else {
    statFilters.hidden = true;
    clearFiltersBtn.hidden = true;
  }
}

/* ============ Editing ============ */
const isFiniteNumber = (n) => typeof n === "number" && isFinite(n);
// Commit a single in-progress cell edit into the model. Coordinates come from
// the input's own data-* attributes (NOT global state — by the time focusout
// fires, the grid may already have moved on to the next cell, and we must save
// exactly the value we just left, in exactly the cell we were editing).
// Returns true if the edit actually belonged to us and was applied.
function commitCellInput(input) {
  if (!input || !input.classList || !input.classList.contains("cell-input")) return false;
  const ri = +input.dataset.ri, c = +input.dataset.c;
  if (!isFiniteNumber(ri) || !isFiniteNumber(c)) return false;
  if (ri < 0 || ri >= state.rows.length) return false;
  const val = input.value;
  if (state.rows[ri][c] !== val) {
    state.rows[ri][c] = val;
    markDirty();
    pushHistory();
  }
  if (state.editingRow === ri && state.editingCol === c) {
    state.editingRow = -1;
    state.editingCol = -1;
  }
  return true;
}
// Save-on-blur: the ONE reliable commit-on-dismiss path. Works whether the
// editor is closed by Enter, Tab, Arrow, clicking another cell, clicking a
// toolbar button, or the window losing focus — the browser's standard
// blur behavior fires focusout on the input, and we save its current value.
document.addEventListener("focusout", (e) => {
  if (commitCellInput(e.target)) render();
});
// Programmatic commit (keyboard handler, toolbar actions). If the input is
// focused, blur it so the focusout handler performs the commit + render;
// otherwise close the editor and render ourselves.
function commitEditing() {
  if (state.editingRow < 0) return;
  const input = document.querySelector("td.cell.editing .cell-input");
  if (input && document.activeElement === input) {
    input.blur();            // focusout → commitCellInput → render (single path)
  } else {
    if (input) commitCellInput(input);
    state.editingRow = -1;
    state.editingCol = -1;
    render();
  }
}
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
function commitEdit(down) {
  if (state.editingRow < 0) { render(); return; }
  const ri = state.editingRow;
  commitEditing();
  if (down && ri < state.rows.length - 1) state.selectedRow = ri + 1;
  render();
}

/* ============ Body clicks + drag-selection ============ */
// Single-click selects; double-click edits; shift-click extends the range.
let dragStart = null;
let dragMoved = false;
function cellFromEvent(e) {
  const cell = e.target.closest && e.target.closest("td.cell");
  if (!cell) return null;
  return { r: +cell.dataset.ri, c: +cell.dataset.c };
}
function colFromX(clientX) {
  const left = scroller.getBoundingClientRect().left + scroller.scrollLeft;
  let x = clientX - left - 46; // skip the 46px colnum gutter
  let c = 0;
  for (; c < state.headers.length && x > 0; c++) x -= (colWidths[c] || DEFAULT_COL_W);
  return Math.max(0, Math.min(state.headers.length - 1, c - 1));
}
body.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (e.target.closest(".rowdel-btn") || e.target.closest('[data-action="del-row"]') || e.target.closest('[data-action="add-row"]')) return;
  // We call preventDefault below (to stop native text selection during a drag),
  // which suppresses the input's native blur. So commit any in-progress edit
  // here, before focusout has a chance to fire, to make "type then click away"
  // actually save.
  if (state.editingRow >= 0) {
    const input = document.querySelector("td.cell.editing .cell-input");
    if (input) commitCellInput(input);
  }
  const cc = cellFromEvent(e);
  if (cc) {
    dragStart = cc;
    dragMoved = false;
    if (e.shiftKey) extendSel(cc.r, cc.c);
    else setSel(cc.r, cc.c);
    state.selectedRow = sel.r1;
    e.preventDefault(); // prevent native text selection during drag
    return;
  }
  const rownum = e.target.closest("td.rownum");
  const rowEl = rownum ? rownum.closest("tr[data-ri]") : null;
  if (rowEl) {
    const r = +rowEl.dataset.ri;
    if (e.shiftKey && sel) extendSel(r, isMulti() ? sel.c2 : sel.c1);
    else setSelRow(r);
  }
});
document.addEventListener("mousemove", (e) => {
  if (!dragStart) return;
  if (e.buttons !== 1) return;
  const sc = scroller.getBoundingClientRect();
  if (e.clientY < sc.top || e.clientY > sc.bottom) return;
  const rowIdx = rowFromY(e.clientY - sc.top + scroller.scrollTop - 34);
  const r = Math.max(0, Math.min(state.rows.length - 1, rowIdx));
  const col = colFromX(e.clientX);
  if (r !== dragStart.r || col !== dragStart.c) dragMoved = true;
  if (dragMoved) extendSel(r, col);
});
document.addEventListener("mouseup", () => { dragStart = null; });

body.addEventListener("dblclick", (e) => {
  const cc = cellFromEvent(e);
  if (!cc) return;
  if (state.editingRow >= 0) commitEditing();
  setSel(cc.r, cc.c);
  startEdit(cc.r, cc.c);
});

body.addEventListener("click", (e) => {
  const del = e.target.closest('[data-action="del-row"]');
  if (del) { if (state.editingRow >= 0) commitEditing(); deleteRow(parseInt(del.dataset.ri, 10)); return; }
  const add = e.target.closest('[data-action="add-row"]');
  if (add) { if (state.editingRow >= 0) commitEditing(); addRow(); return; }
  // single-click on a cell is now handled by mousedown (select) / dblclick (edit)
});
// Start a new edit when clicking into the header/gutter while an editor is open.
document.addEventListener("mousedown", (e) => {
  if (state.editingRow < 0) return;
  if (e.target.closest && e.target.closest("td.cell.editing")) return;
  commitEditing();
  render();
});

/* ============ Keyboard ============
   Kept small & modular: global shortcuts first, then per-mode handlers. */
function isCellInput(el) {
  return el && el.classList && el.classList.contains("cell-input");
}
function arrowDelta(key) {
  if (key === "ArrowUp") return [-1, 0];
  if (key === "ArrowDown") return [1, 0];
  if (key === "ArrowLeft") return [0, -1];
  if (key === "ArrowRight") return [0, 1];
  return null;
}
function handleEditingKey(e) {
  const ri = state.editingRow, c = state.editingCol;
  if (e.key === "Enter") {
    e.preventDefault(); commitEdit(false);
    if (ri < state.rows.length - 1) startEdit(ri + 1, c); else render();
  } else if (e.key === "Escape") {
    e.preventDefault(); state.editingRow = -1; state.editingCol = -1; render();
  } else if (e.key === "Tab") {
    e.preventDefault(); commitEditing();
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
}
function selectWholeGrid() {
  setSel(0, 0);
  selAnchor = { r: 0, c: 0 };
  const d = maxDims();
  extendSel(d.r, d.c);
}
function handleGridKey(e) {
  if (document.activeElement === searchInput) return;
  const arrow = arrowDelta(e.key);
  if (arrow) {
    e.preventDefault();
    if (state.rows.length === 0) return;
    nudgeActive(arrow[0], arrow[1], e.shiftKey); // Shift+arrow extends the range
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Enter" || e.key === " ") {
    if (state.rows.length === 0) { e.preventDefault(); addRow(); return; }
    e.preventDefault();
    const a = activeCell() || (sel ? { r: sel.r2, c: sel.c2 } : { r: 0, c: 0 });
    startEdit(a.r, a.c);
    return;
  }
  if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    if (sel) clearSelectionCells();
    return;
  }
}
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && !e.altKey && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === "s") { e.preventDefault(); exportCsv(); return; }
  if (mod && k === "c" && sel) { e.preventDefault(); copySelectionRange(); return; }
  if (mod && !e.shiftKey && k === "d") { e.preventDefault(); fillDown(); return; }
  if (mod && e.shiftKey && k === "r") { e.preventDefault(); fillRight(); return; }
  if (mod && k === "a") { e.preventDefault(); selectWholeGrid(); return; }
  // Formatting shortcuts (outside the cell editor, where B/I/U are native)
  if (mod && !e.altKey && !e.shiftKey && !isCellInput(document.activeElement)) {
    if (k === "b") { e.preventDefault(); applyFmt("fmtBold", "bold"); return; }
    if (k === "i") { e.preventDefault(); applyFmt("fmtItalic", "italic"); return; }
    if (k === "u") { e.preventDefault(); applyFmt("fmtUnder", "underline"); return; }
  }
  if (e.key === "Escape") {
    if (isCellInput(document.activeElement)) { state.editingRow = -1; state.editingCol = -1; render(); }
    else if (sel) { e.preventDefault(); clearSel(); }
    hideCtxMenu();
    return;
  }
  if (isCellInput(document.activeElement)) { handleEditingKey(e); return; }
  handleGridKey(e);
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
  colWidths.push(DEFAULT_COL_W);
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
      colWidths.splice(c, 1);
      if (state.sortCol === c) { state.sortCol = -1; state.sortDir = 0; }
      else if (state.sortCol > c) state.sortCol--;
      remapFiltersAfterColRemoval(c);
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
    else if (a === "filter-col") { openFilterPanel(c); return; }
    else if (a === "sort-asc") { state.sortCol = c; state.sortDir = 1; applySort(); pushHistory(); render(); }
    else if (a === "sort-desc") { state.sortCol = c; state.sortDir = -1; applySort(); pushHistory(); render(); }
    return;
  }
  const th = e.target.closest("th[data-col]");
  if (!th) return;
  const c = parseInt(th.dataset.col, 10);
  setSelCol(c);                 // single click selects the whole column; double-click auto-fits (handled elsewhere)
  state.selectedRow = sel.r1;
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
  state.filters = {};
  state.selectedCol = -1;
  state.formats = {};
  searchInput.value = "";
  searchClear.hidden = true;
  state.history = [];
  state.historyIndex = -1;
  state.formats = {};
  state.cfRules = [];
  if (!keepFilename) filenameInput.value = "untitled";
  applyStoredWidths();
  // every resetState() call is a fresh load -> grid matches source, not dirty
  isSaved = true;
  updateDirty();
  saveToLocal();
}

/* Parse + normalise, always succeeds or throws. Works on the main thread (and
   is duplicated inside parsing.worker.js so large files don't block the UI). */
function parseText(text) {
  const rows = parseCsv(text, detectDelim(text));
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

/* ============ Column filters ============ */

function remapFiltersAfterColRemoval(removed) {
  const next = {};
  for (const k of Object.keys(state.filters)) {
    const n = Number(k);
    if (n === removed) continue;
    const m = n > removed ? n - 1 : n;
    next[m] = state.filters[k];
  }
  state.filters = next;
}

/* ============ Column filters (Excel-style auto-filter) ============
   A filter lives in `state.filters[c]` and is one of:
     { mode:"values",    values: [ ..string.. ] }   // keep rows whose value is in set
     { mode:"contains",  text }                      // substring, case-insensitive
     { mode:"starts",    text }                      // prefix
     { mode:"is",        text }                      // exact (raw string)
     { mode:"contains-empty" }                       // keep blank cells
   Legacy snapshots (a raw Set) also load and behave as a values-allow-list.
   The predicate below is the single source of truth for "does this cell pass"
   and is shared by `visibleRows()`, the stats counter and the live count in the
   filter panel, so every view stays consistent. */
let filterCol = -1;

function filterConfig(c) {
  const v = state.filters[c];
  return (v && typeof v === "object") ? v : null;
}
function filterMatchesCell(c, raw) {
  return filterPredMatches(raw, filterConfig(c));
}

function filterPredMatches(raw, cfg) {
  // Legacy: a raw Set (old snapshots) is treated as a values allow-list.
  if (cfg && cfg instanceof Set) return cfg.has(raw === undefined || raw === null ? "" : String(raw));
  if (!cfg) return true;
  const text = raw === undefined || raw === null ? "" : String(raw);
  if (cfg.mode === "contains-empty") return text.trim() === "";
  if (cfg.mode === "contains") return text.toLowerCase().includes(String(cfg.text || "").toLowerCase());
  if (cfg.mode === "starts")     return text.toLowerCase().startsWith(String(cfg.text || "").toLowerCase());
  if (cfg.mode === "is")         return text === String(cfg.text);
  if (cfg.mode === "values")     return new Set(cfg.values || []).has(text);
  return true;
}

/* ----- Auto-filter panel session (not committed until Apply) ----- */
const FILTER_MODES = ["values", "contains", "starts", "is", "contains-empty"];
const FILTER_MODE_LABELS = { values:"in list", contains:"contains", starts:"starts with", is:"is", "contains-empty":"is empty" };
let filterSession = { mode: "values", text: "" };

// Read the current session into a config object (null = "no filter").
function filterReadConfig() {
  if (filterSession.mode === "values") {
    const boxes = [...document.querySelectorAll('#filterPanelBody input.fv')];
    const vals = boxes.filter(b => b.checked).map(b => b.value);
    if (vals.length === boxes.length) return null; // everything checked = no filter
    return { mode: "values", values: vals };
  }
  if (filterSession.mode === "contains-empty") return { mode: "contains-empty" };
  return { mode: filterSession.mode, text: filterSession.text };
}

// Render the mode selector + the current mode's input area.
function filterRenderBody() {
  const c = filterCol;
  const entries = valueCounts(c);
  const curCfg = filterConfig(c);
  const modeSel = FILTER_MODES.map(m => {
    const active = m === filterSession.mode;
    return `<label class="filter-mode-opt ${active ? "on" : ""}">
      <input type="radio" name="fm" value="${m}" ${active ? "checked" : ""}/>
      <span>${FILTER_MODE_LABELS[m]}</span>
    </label>`;
  }).join("");
  let inputHtml = "";
  if (filterSession.mode === "values") {
    const allowed = curCfg && curCfg.mode === "values" ? new Set(curCfg.values || []) : null;
    inputHtml = `<div class="filter-input-values">` +
      entries.slice(0, 1000).map(([val, n]) => {
        const checked = allowed ? allowed.has(val) : true;
        const label = val === "" ? '<span class="dim">(empty)</span>' : esc(val);
        return `<label class="filter-item">
          <input type="checkbox" class="fv" value="${escAttr(val)}" ${checked ? "checked" : ""}/>
          <span class="filter-value">${label}</span>
          <span class="dim filter-nc">${n}</span>
        </label>`;
      }).join("") +
      (entries.length > 1000 ? `<div class="filter-truncate">Showing first 1000 of ${entries.length} distinct values.</div>` : "") +
      `</div>`;
  } else if (filterSession.mode === "contains-empty") {
    inputHtml = `<div class="filter-input-text"><span class="dim">Keep rows where this column is empty/blank.</span></div>`;
  } else {
    const ph = filterSession.mode === "is" ? "exact value" : filterSession.mode === "starts" ? "prefix" : "substring";
    inputHtml = `<div class="filter-input-text">
      <input id="filterText" type="text" value="${escAttr(filterSession.text)}" placeholder="${ph}" spellcheck="false"/>
    </div>`;
  }
  filterPanelBody.innerHTML = modeSel + inputHtml;
  filterRefreshLiveCount();
  const ft = document.getElementById("filterText");
  if (ft) { ft.focus(); ft.setSelectionRange(ft.value.length, ft.value.length); }
}

// "If you clicked Apply right now, how many rows would pass?"
function filterRefreshLiveCount() {
  const c = filterCol, total = state.rows.length;
  const cfg = filterReadConfig();
  let pass = 0;
  for (let i = 0; i < total; i++) if (filterPredMatches(state.rows[i][c], cfg)) pass++;
  filterLiveCount.textContent = `${pass} of ${total}`;
}

// Delegated (attached once) — survives re-renders of the body.
filterPanelBody.addEventListener("change", (e) => {
  if (e.target.name === "fm") { filterSession.mode = e.target.value; filterRenderBody(); }
  else if (e.target.classList && e.target.classList.contains("fv")) filterRefreshLiveCount();
});
filterPanelBody.addEventListener("input", (e) => {
  if (e.target.id === "filterText") { filterSession.text = e.target.value; filterRefreshLiveCount(); }
});

function openFilterPanel(c) {
  filterCol = c;
  const cfg = filterConfig(c);
  filterSession.mode = cfg ? (cfg.mode || "values") : "values";
  filterSession.text = (cfg && typeof cfg.text === "string") ? cfg.text : "";
  const colHeader = state.headers[c] || ("Column " + (c + 1));
  const valuesSize = distinctValues(c).size;
  const label = cfg ? (FILTER_MODE_LABELS[cfg.mode] || cfg.mode) : "no filter";
  filterPanelTitle.textContent = `Filter · ${colHeader}`;
  filterPanelSub.textContent = `${valuesSize} distinct value${valuesSize === 1 ? "" : "s"} · ${state.rows.length} row${state.rows.length === 1 ? "" : "s"} · ${label}`;
  filterRenderBody();
  // Position near the header funnel (or center as fallback).
  filterPanelRoot.hidden = false;
  const panel = filterPanel;
  const w = panel.offsetWidth, h = panel.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = Math.max(12, Math.min(vw - w - 12, (vw - w) / 2));
  let top  = Math.max(12, Math.min(vh - h - 12, (vh - h) / 2));
  const btn = document.querySelector(`th .th-filter[data-col="${c}"]`);
  if (btn) {
    const r = btn.getBoundingClientRect();
    left = Math.max(12, Math.min(vw - w - 12, r.left + (r.right - r.left) / 2 - w / 2));
    top  = Math.min(vh - h - 12, r.bottom + 8);
  }
  panel.style.left = left + "px";
  panel.style.top  = top  + "px";
  filterPanel._readConfig = filterReadConfig;
}

function closeFilterPanel() {
  filterPanelRoot.hidden = true;
  filterCol = -1;
}
function valueCounts(c) {
  const m = new Map();
  for (let i = 0; i < state.rows.length; i++) {
    const v = state.rows[i][c] === undefined ? "" : state.rows[i][c];
    m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()];
}
function applyFilterFromPanel() {
  if (filterCol < 0 || typeof filterPanel._readConfig !== "function") return;
  const cfg = filterPanel._readConfig();
  const c = filterCol;
  if (cfg) state.filters[c] = cfg;
  else delete state.filters[c];
  filterPanel._readConfig = null;
  closeFilterPanel();
  stopEdit();
  render();
  showToast(cfg ? "Filter applied" : "Filter cleared");
}
function _filterClearThisCol() {
  if (filterCol < 0) return;
  const name = state.headers[filterCol] || ("Column " + (filterCol + 1));
  delete state.filters[filterCol];
  closeFilterPanel();
  stopEdit();
  render();
  showToast(`Cleared filter on "${name}"`);
}
filterPanelApply.addEventListener("click", applyFilterFromPanel);
filterPanelClose.addEventListener("click", closeFilterPanel);
filterPanelRoot.addEventListener("click", (e) => { if (e.target === filterPanelRoot) closeFilterPanel(); });
filterPanelClear.addEventListener("click", _filterClearThisCol);
clearFiltersBtn.addEventListener("click", clearFilters);
statFilters.addEventListener("click", () => {
  const c = Object.keys(state.filters).map(Number).sort((a, b) => a - b)[0];
  if (c === undefined) return;
  openFilterPanel(c);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !filterPanelRoot.hidden) closeFilterPanel();
});

/* ============ Charts (canvas: bar / line / pie) ============
   Data is derived from the current selection — or, when nothing is selected,
   the whole grid:
     • one numeric column  → x = the column's label cells, y = numbers
     • a block (N cols)    → one series per column, x = row index (or first label)
     • a single mixed row  → one series
   Series are re-derived on every render()/data change, so the open chart
   always reflects live values without the user doing anything. */
let chart = null; // { type: "bar"|"line"|"pie", open: bool }
const CHART_PALETTE = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6", "#ec4899", "#64748b"];

function chartTheme() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  return {
    dark,
    grid: dark ? "rgba(255,255,255,.10)" : "rgba(16,24,40,.08)",
    axis: dark ? "rgba(255,255,255,.45)" : "rgba(16,24,40,.40)",
    text: dark ? "#e5e8f2" : "#1f2733",
    faint: dark ? "#9aa3b8" : "#6b7280",
    track: dark ? "#2d2d2d" : "#eef1f6",
    series: i => CHART_PALETTE[i % CHART_PALETTE.length],
  };
}

// Resolve the chart data model from the grid + selection. Returns
// { labels:[], series:[{name, values:[]}], title } or null if no numbers exist.
function chartData() {
  let r1, r2, c1, c2;
  if (sel && isMulti()) { r1 = sel.r1; r2 = sel.r2; c1 = sel.c1; c2 = sel.c2; }
  else if (sel && isFullRowSpan()) { r1 = 0; r2 = state.rows.length - 1; c1 = sel.r1; c2 = sel.r1; } // whole row
  else if (sel && isFullColSpan()) { r1 = 0; r2 = state.rows.length - 1; c1 = sel.c2; c2 = sel.c2; } // whole col
  else { r1 = 1; r2 = Math.max(1, state.rows.length - 1); c1 = 0; c2 = state.headers.length - 1; } // whole grid
  if (!state.rows.length) return null;

  const numAt = (r, c) => {
    const v = state.rows[r] && state.rows[r][c];
    const s = v === undefined ? "" : String(v);
    if (s.trim().startsWith("=")) { const rv = resolveCell(r, c); return (rv.e || rv.n === null) ? NaN : rv.n; }
    const ti = typeInfo(s);
    return (ti.type === "number" || ti.type === "percent" || ti.type === "currency") ? ti.value : NaN;
  };
  const isNumCol = c => { let n = 0; for (let r = r1; r <= r2; r++) if (!isNaN(numAt(r, c))) n++; return n > 0; };

  // single numeric column → label/value pairs
  if (c1 === c2 && isNumCol(c1)) {
    const labels = [], values = [];
    for (let r = r1; r <= r2; r++) { const v = numAt(r, c1); if (isNaN(v)) continue;
      labels.push(String(state.rows[r][c1])); values.push(v); }
    if (!values.length) return null;
    return { title: state.headers[c1], labels, series: [{ name: state.headers[c1], values }] };
  }

  // multiple numeric columns → one series each; x-axis = row index
  const series = [];
  const labels = [];
  for (let r = r1; r <= r2; r++) labels.push(String((r + 1)));
  for (let c = c1; c <= c2; c++) {
    if (!isNumCol(c)) continue;
    const values = [];
    for (let r = r1; r <= r2; r++) values.push(isNaN(numAt(r, c)) ? 0 : numAt(r, c));
    const nonZero = values.some(v => v !== 0);
    if (nonZero) series.push({ name: state.headers[c] || ("Col " + (c + 1)), values });
  }
  if (!series.length) return null;
  return { title: (state.headers[c1] || "Row") + " → " + (state.headers[Math.min(c2, state.headers.length - 1)] || "grid"), labels, series };
}

function shortNum(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (a >= 1e4) return (n / 1e3).toFixed(0) + "k";
  return String(Math.round(n * 100) / 100);
}

// Draw bar / line / pie into a canvas. `model` from chartData().
function drawChart(canvas, model, type) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = 520, cssH = 300;
  canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  canvas.style.width = cssW + "px"; canvas.style.height = cssH + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const th = chartTheme();
  const pad = { l: 52, r: 16, t: 22, b: 34 };
  const { labels, series } = model;
  const allVals = labels.map((_, i) => Math.max(...series.map(s => Math.abs(s.values[i] || 0))));
  const yMax = Math.max(1, ...allVals);

  if (type === "pie") {
    const total = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0))
                      .reduce((a, b) => a + Math.max(0, b), 0);
    // Use the first series' values as the pie parts.
    const vals = series[0].values.map(v => Math.max(0, v));
    const sum = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = cssW / 2, cy = cssH / 2, r = Math.min(cssW, cssH) / 2 - 30;
    let a = -Math.PI / 2;
    labels.forEach((lab, i) => {
      const frac = vals[i] / sum;
      const a1 = a + frac * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, a, a1);
      ctx.fillStyle = th.series(i); ctx.fill();
      a = a1;
    });
    // legend
    let ly = 26;
    labels.forEach((lab, i) => {
      ctx.fillStyle = th.series(i);
      ctx.fillRect(14, ly, 12, 12);
      ctx.fillStyle = th.text;
      ctx.font = "12px " + getComputedStyle(document.body).getPropertyValue("--font-ui");
      ctx.textAlign = "left";
      ctx.fillText((lab || "").slice(0, 14) + " · " + shortNum(Math.max(0, series[0].values[i] || 0)), 32, ly + 10);
      ly += 18;
    });
    return;
  }

  // ---- axis + bars or line ----
  const W = cssW - pad.l - pad.r, H = cssH - pad.t - pad.b;
  // gridlines + y-axis (5 ticks)
  ctx.lineWidth = 1;
  ctx.font = "11px " + getComputedStyle(document.body).getPropertyValue("--mono");
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const y = pad.t + H - t * H;
    ctx.strokeStyle = th.grid;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + W, y); ctx.stroke();
    ctx.fillStyle = th.faint; ctx.textAlign = "right";
    ctx.fillText(shortNum(yMax * t), pad.l - 8, y + 4);
  }
  const bw = W / labels.length;
  const barW = Math.max(2, Math.min(46, bw * 0.62));
  // bars
  ctx.fillStyle = th.faint; ctx.textAlign = "left";
  if (type === "bar") {
    labels.forEach((lab, i) => {
      series.forEach((s, si) => {
        const v = Math.max(0, s.values[i] || 0);
        const sub = series.length > 1 ? (si + 1) / series.length : 0.5;
        const cxl = pad.l + i * bw + bw / 2 - (series.length > 1 ? (bw - barW) / 2 : bw / 2);
        const x = pad.l + i * bw + bw / 2 - (series.length - 1) * barW / 2 + si * (series.length > 1 ? barW : 0);
        const bh = H * (v / yMax);
        ctx.fillStyle = th.series(si);
        ctx.fillRect(pad.l + i * bw + (bw - (series.length * barW)) / 2 + si * barW, pad.t + H - bh, barW - (series.length > 1 ? 1 : 0), bh);
      });
    });
  } else { // line (multi-line)
    series.forEach((s, si) => {
      ctx.strokeStyle = th.series(si); ctx.lineWidth = 2; ctx.beginPath();
      const n = labels.length;
      labels.forEach((lab, i) => {
        const x = pad.l + (n === 1 ? W / 2 : (i / (n - 1)) * W);
        const v = Math.max(0, s.values[i] || 0);
        const y = pad.t + H - H * (v / yMax);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      // point
      labels.forEach((lab, i) => {
        const x = pad.l + (n === 1 ? W / 2 : (i / (n - 1)) * W);
        const y = pad.t + H - H * (Math.max(0, s.values[i] || 0) / yMax);
        ctx.fillStyle = th.series(si); ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      });
    });
  }
  // x labels
  ctx.fillStyle = th.faint; ctx.textAlign = "center";
  const step = Math.max(1, Math.ceil(labels.length / 10));
  labels.forEach((lab, i) => {
    if (i % step !== 0 && i !== labels.length - 1) return;
    const x = pad.l + i * bw + bw / 2;
    ctx.fillText((lab || "").slice(0, 8), x, cssH - 14);
  });
  // axis line
  ctx.strokeStyle = th.axis;
  ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, pad.t + H); ctx.lineTo(pad.l + W, pad.t + H); ctx.stroke();
}

function updateChartUI() {
  if (!chart) return;
  const model = chartData();
  const hint = chartHint, float = chartFloat;
  if (!model) { hint.textContent = "No numeric values in the selection — pick numeric data."; }
  else hint.textContent = `${model.series.length} series × ${model.labels.length} points`;
  if (!float.hidden) {
    try { drawChart(chartFloatCanvas, model, chart.type); } catch (e) {}
  }
}

function openChart() {
  chart = { type: "bar", open: false };
  chartRoot.hidden = false;
  const model = chartData();
  if (model) drawChart(chartCanvas, model, "bar");
  else chartHint.textContent = "No numeric values — select numeric cells first.";
  if (model) chartCanvas.closest(".chart-canvas-wrap").style.opacity = "1";
  else chartCanvas.closest(".chart-canvas-wrap").style.opacity = "0.4";
  requestAnimationFrame(() => chartShow.blur());
}
function closeChart() { chartRoot.hidden = true; }
function currentChartType() {
  const r = chartRoot.querySelector('input[name=ctype]:checked');
  return r ? r.value : "bar";
}
function showChartOpen() {
  chart.type = currentChartType();
  const model = chartData();
  if (!model) { closeChart(); showToast("No numeric data to chart", "error"); return; }
  closeChart();
  chartFloat.hidden = false;
  requestAnimationFrame(() => drawChart(chartFloatCanvas, model, chart.type));
}
function closeChartFloat() { chartFloat.hidden = true; if (chart) { chart.open = false; } }
function reopenFromFloat() {
  // change type from float → open the modal with current selection
  const cur = currentChartType();
  chartRoot.hidden = false;
  const r = chartRoot.querySelector(`input[name=ctype][value="${cur}"]`); if (r) r.checked = true;
  const model = chartData(); if (model) drawChart(chartCanvas, model, cur);
}

btnChart && btnChart.addEventListener("click", openChart);
chartClose && chartClose.addEventListener("click", closeChart);
chartShow && chartShow.addEventListener("click", showChartOpen);
chartFloatType && chartFloatType.addEventListener("click", reopenFromFloat);
chartFloatClose && chartFloatClose.addEventListener("click", closeChartFloat);
chartRoot && chartRoot.addEventListener("click", (e) => { if (e.target === chartRoot) closeChart(); });
chartRoot && chartRoot.addEventListener("change", (e) => {
  if (e.target.name === "ctype") {
    const model = chartData();
    if (model) drawChart(chartCanvas, model, e.target.value);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !chartRoot.hidden) closeChart();
  else if (e.key === "Escape" && !chartFloat.hidden) closeChartFloat();
});
function toggleMenu(el, menu) {
  const willOpen = menu.hidden;
  // close any open
  document.querySelectorAll(".popover").forEach(m => { m.hidden = true; });
  document.querySelectorAll("[aria-haspopup=menu][aria-expanded='true']").forEach(b => b.setAttribute("aria-expanded", "false"));
  if (!willOpen) return;
  // Un-hide FIRST so offsetWidth/offsetHeight are real (measuring a
  // display:none element returns 0 and mis-positioned the menu).
  menu.hidden = false;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  // Google/Sheets pattern: left-aligned to the anchor; if it would overflow
  // the right edge, flip to right-aligned. Never overflow the viewport.
  let left = r.left;
  if (left + w > vw - 8) left = Math.max(8, r.right - w);
  left = Math.max(8, left);
  let top = r.bottom + 8;
  if (top + h > vh - 8) top = Math.max(8, r.top - h - 8);
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  el.setAttribute("aria-expanded", "true");
}
btnTools.addEventListener("click", (e) => { e.preventDefault(); toggleMenu(btnTools, toolsMenu); });
const btnExportMenu = $("btnExportMenu");
btnExportMenu.addEventListener("click", (e) => { e.preventDefault(); toggleMenu(btnExportMenu, exportMenu); });
btnExport.addEventListener("click", exportCsv);
document.addEventListener("click", (e) => {
  const menu = document.querySelectorAll(".popover:not([hidden])");
  for (const m of menu) {
    if (m.contains(e.target)) continue;
    const b = document.querySelector('[aria-haspopup=menu][aria-expanded="true"]');
    if (b && b.contains(e.target)) continue;
    m.hidden = true;
    if (b) b.setAttribute("aria-expanded", "false");
  }
});
toolsMenu.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tool]");
  if (!btn) return;
  toolsMenu.hidden = true;
  const tool = btn.dataset.tool;
  if (tool === "trim") toolTrim();
  else if (tool === "dedupe") toolDedupe();
  else if (tool === "empty-rows") toolEmptyRows();
  else if (tool === "empty-cols") toolEmptyCols();
});
/* ============ Copy-as (Markdown / JSON / SQL) ============
   In this grid, headers live in `state.headers` and `state.rows[0]` is already
   the first data row. Selection bounds are row/col indices into state.rows.
   Values come from cellValueText so formulas / numbers come out raw. */
const btnCopyAs = $("btnCopyAs");
const copyAsMenu = $("copyAsMenu");
btnCopyAs.addEventListener("click", (e) => { e.preventDefault(); toggleMenu(btnCopyAs, copyAsMenu); });

function copyAsBounds() {
  if (!sel) return null;
  return { r1: sel.r1, r2: sel.r2, c1: sel.c1, c2: sel.c2 };
}
function requireSelection(fmt) {
  if (!sel) { showToast("Select cells first to copy as " + fmt, "error"); return false; }
  return true;
}
function selectCols(b) { const out = []; for (let c = b.c1; c <= b.c2; c++) out.push(c); return out; }

// Pure content builders — no clipboard, easy to test & reuse.
function markdownOfBounds(b) {
  const heads = selectCols(b).map(c => (state.headers[c] || "Col " + (c + 1)).trim());
  const rows = [];
  for (let r = b.r1; r <= b.r2; r++)
    rows.push("| " + selectCols(b).map(c => cellValueText(r, c).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, "<br>").trim()).join(" | ") + " |");
  return heads.join(" | ") + "\n| " + heads.map(() => "---").join(" | ") + " |" + (rows.length ? "\n" + rows.join("\n") : "");
}
function jsonOfBounds(b) {
  const keys = selectCols(b).map((c, i) => state.headers[c].trim() || ("col" + (c + 1)));
  const rows = [];
  for (let r = b.r1; r <= b.r2; r++) {
    const obj = {};
    selectCols(b).forEach((c, i) => {
      const raw = cellValueText(r, c);
      const n = toNumberCore(raw === undefined ? "" : String(raw));
      obj[keys[i]] = n !== null ? n : (raw === undefined ? "" : String(raw));
    });
    rows.push(obj);
  }
  return JSON.stringify(rows, null, 2);
}
function sqlOfBounds(b) {
  const tableName = (filenameInput.value.trim() || "table").replace(/\.[^.]+$/, "");
  const cols = selectCols(b).map(c => state.headers[c].trim().replace(/[^a-zA-Z0-9_]/g, "_") || ("col" + (c + 1)));
  const lines = [];
  for (let r = b.r1; r <= b.r2; r++) {
    const vals = selectCols(b).map(c => {
      const s = cellValueText(r, c) === undefined ? "" : String(cellValueText(r, c));
      const n = toNumberCore(s);
      return n !== null ? String(n) : "'" + s.replace(/'/g, "''") + "'";
    });
    lines.push(`INSERT INTO ${tableName} (${cols.join(", ")}) VALUES (${vals.join(", ")});`);
  }
  return lines.join("\n");
}

function copyAsMarkdown() {
  if (!requireSelection("Markdown")) return;
  return writeClipboard(markdownOfBounds(copyAsBounds()))
    .then(() => showToast("Copied as Markdown")).catch(() => showToast("Copy blocked", "error"));
}
function copyAsJson() {
  if (!requireSelection("JSON")) return;
  return writeClipboard(jsonOfBounds(copyAsBounds()))
    .then(() => showToast("Copied as JSON")).catch(() => showToast("Copy blocked", "error"));
}
function copyAsSql() {
  if (!requireSelection("SQL")) return;
  return writeClipboard(sqlOfBounds(copyAsBounds()))
    .then(() => showToast("Copied as SQL")).catch(() => showToast("Copy blocked", "error"));
}

copyAsMenu.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-copyas]");
  if (!btn) return;
  copyAsMenu.hidden = true;
  const fmt = btn.dataset.copyas;
  if (fmt === "markdown") copyAsMarkdown();
  else if (fmt === "json") copyAsJson();
  else if (fmt === "sql") copyAsSql();
});

/* ============ Conditional formatting (rule engine + modal) ============
   A rule = { range:{r1,r2,c1,c2}|null(all), kind, param?, n?, style:{bg,fg} }.
   kind: is, not, gt, gte, lt, lte, contains, between, topn, bottomn, blank, notblank.
   cfApply(r,c) returns the FIRST matching rule's style (inline), or null.
   Styles are drawn via --cf-bg / --cf-fg custom props so selection still shows. */
const CF_PRESETS = [
  { bg: "#c8e6c9", fg: "#1b5e20" },  // green
  { bg: "#fff59d", fg: "#5d4b00" },  // yellow
  { bg: "#ffcdd2", fg: "#7f1d0c" },  // red
  { bg: "#bbdefb", fg: "#0d3b66" },  // blue
];
const CF_KINDS = [
  ["is","is"],["not","is not"],["gt",">","is greater than"],["gte",">=","is at least"],
  ["lt","<","is less than"],["lte","<=","is at most"],
  ["contains","contains"],["between","between"],
  ["topn","top N"],["bottomn","bottom N"],["blank","is blank"],["notblank","is not blank"],
];

function cfInRange(rule, r, c) {
  const b = rule.range;
  if (!b) return true;
  return r >= b.r1 && r <= b.r2 && c >= b.c1 && c <= b.c2;
}
function cfMatchKind(rule, r, c) {
  const raw = state.rows[r] && state.rows[r][c];
  const s = raw === undefined || raw === null ? "" : String(raw);
  // Resolve formula cells to their computed value so numeric rules compare numbers.
  const resolved = (s.trim().startsWith("=")) ? cellValueText(r, c) : raw;
  const n = (v) => { const x = toNumberCore(v === undefined ? "" : String(v)); return x; };
  const rv = n(resolved);
  switch (rule.kind) {
    case "blank":    return s.trim() === "";
    case "notblank": return s.trim() !== "";
    case "is":       return s === String(rule.param);
    case "not":      return s !== String(rule.param);
    case "contains": return s.toLowerCase().includes(String(rule.param).toLowerCase());
    case "gt":  { const a = rv, b = n(rule.param); return a !== null && b !== null && a > b; }
    case "lt":  { const a = rv, b = n(rule.param); return a !== null && b !== null && a < b; }
    case "gte": { const a = rv, b = n(rule.param); return a !== null && b !== null && a >= b; }
    case "lte": { const a = rv, b = n(rule.param); return a !== null && b !== null && a <= b; }
    case "between": { const a = rv, lo = n(rule.param.lo), hi = n(rule.param.hi);
                      return a !== null && lo !== null && hi !== null && a >= lo && a <= hi; }
    case "topn":
    case "bottomn": {
      // threshold across the column (c) within the rule's range, resolving formulas
      const b = rule.range || { r1: 0, r2: state.rows.length - 1 };
      const colVal = (rr) => { const x = state.rows[rr] && state.rows[rr][c]; const str = x === undefined ? "" : String(x); return toNumberCore(str.trim().startsWith("=") ? cellValueText(rr, c) : str); };
      const vals = [];
      for (let rr = b.r1; rr <= b.r2; rr++) { const nn = colVal(rr); if (nn !== null) vals.push(nn); }
      vals.sort((x, y) => (rule.kind === "topn" ? y - x : x - y));
      const kk = Math.max(1, rule.n | 0);
      if (!vals.length) return false;
      const threshold = vals[Math.min(kk, vals.length) - 1];
      if (rv === null) return false;
      return rule.kind === "topn" ? rv >= threshold - 1e-9 : rv <= threshold + 1e-9;
    }
  }
  return false;
}
function cfApply(r, c) {
  for (const rule of (state.cfRules || [])) {
    if (!cfInRange(rule, r, c)) continue;
    if (cfMatchKind(rule, r, c)) return rule.style;
  }
  return null;
}

// ---- Modal wiring ----
const cfRoot = $("cfRoot"), cfList = $("cfList");
const kindSel = $("cfKind"), paramIn = $("cfParam"), paramLo = $("cfParamLo"), paramHi = $("cfParamHi"), topnIn = $("cfTopN");
const cfParamWrap = $("cfParamWrap"), cfTopWrap = $("cfTopWrap"), cfBetween = document.querySelector(".cf-between");
function cfShowParam(kind) {
  const isTxt = kind === "is" || kind === "not" || kind === "contains";
  const isNum = ["gt","gte","lt","lte"].includes(kind);
  const isBetween = kind === "between";
  const isTop = kind === "topn" || kind === "bottomn";
  if (cfParamWrap) cfParamWrap.style.display = (isTxt || isNum) ? "" : "none";
  paramIn.placeholder = isTxt ? "value" : "number";
  if (cfBetween) cfBetween.style.display = isBetween ? "" : "none";
  if (cfTopWrap) cfTopWrap.style.display = isTop ? "" : "none";
}
function cfSelectedRange() {
  if (sel) return { r1: sel.r1, r2: sel.r2, c1: sel.c1, c2: sel.c2 };
  return { r1: 0, r2: Math.max(0, state.rows.length - 1), c1: 0, c2: state.headers.length - 1 };
}
function cfAddRule() {
  const kind = kindSel.value;
  const param = paramIn.value.trim();
  if (["is","not","contains","gt","gte","lt","lte"].includes(kind) && param === "") { showToast("Enter a value for that condition", "error"); return; }
  const colorInput = document.querySelector('input[name="cfcolor"]:checked');
  const style = CF_PRESETS[+(colorInput ? colorInput.value : 2)];
  const rule = { range: cfSelectedRange(), kind, style };
  if (["gt","gte","lt","lte","is","not","contains"].includes(kind)) rule.param = param;
  else if (kind === "between") rule.param = { lo: paramLo.value.trim(), hi: paramHi.value.trim() };
  else if (kind === "topn" || kind === "bottomn") rule.n = Math.max(1, parseInt(topnIn.value, 10) || 3);
  state.cfRules.push(rule);
  pushHistory(); render();
  cfPaintList();
  showToast("Rule added");
}
function cfPaintList() {
  cfList.innerHTML = (state.cfRules || []).map((r, i) => {
    const label = `${CF_KINDS.find(k => k[0] === r.kind)[1]} ${r.param ? (typeof r.param === "object" ? r.param.lo+"–"+r.param.hi : r.param) : (r.n ? r.n : "")}`;
    return `<li>
      <button type="button" class="cf-dot" style="background:${r.style.bg};color:${r.style.fg}" aria-hidden="true"></button>
      <span class="cf-rule-txt">${esc(label)}</span>
      <button type="button" class="button" data-cf-del="${i}" aria-label="Remove rule">×</button>
    </li>`;
  }).join("") || `<li class="cf-none">No rules yet — select a range, pick a condition, and add one.</li>`;
}
function openCf() {
  kindSel.value = "is"; cfShowParam("is");
  paramIn.value = ""; paramLo.value = ""; paramHi.value = ""; topnIn.value = 3;
  document.querySelector('input[name="cfcolor"][value="2"]').checked = true;
  cfPaintList();
  cfRoot.hidden = false;
}
function closeCf() { cfRoot.hidden = true; }
const btnCf = $("btnCf");
btnCf && btnCf.addEventListener("click", openCf);
cfRoot && cfRoot.querySelector("#cfClose") && cfRoot.querySelector("#cfClose").addEventListener("click", closeCf);
cfRoot && cfRoot.querySelector("#cfAdd") && cfRoot.querySelector("#cfAdd").addEventListener("click", cfAddRule);
kindSel && kindSel.addEventListener("change", () => cfShowParam(kindSel.value));
cfList && cfList.addEventListener("click", (e) => {
  const del = e.target.closest("[data-cf-del]");
  if (!del) return;
  const i = +del.dataset.cfDel;
  state.cfRules.splice(i, 1);
  pushHistory(); render(); cfPaintList();
  showToast("Rule removed");
});
if (cfRoot) cfRoot.addEventListener("click", (e) => { if (e.target === cfRoot) closeCf(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && cfRoot && !cfRoot.hidden) closeCf(); });

/* ============ Fill (productivity) ============
   Fill down: every row in the selection becomes a copy of the top row's cells.
   Fill right: every column in the selection becomes a copy of the left col's
   cells. Single-cell selection is a no-op (nothing to fill). */
function fillDown() {
  if (!sel || sel.r2 === sel.r1) { showToast("Select 2+ rows to fill down", "error"); return; }
  const top = state.rows[sel.r1];
  for (let r = sel.r2; r >= sel.r1 + 1; r--) {
    state.rows[r] = state.rows[r].slice();
    for (let c = sel.c1; c <= sel.c2; c++) state.rows[r][c] = top[c];
  }
  markDirty(); pushHistory(); render();
  showToast(`Filled ${sel.r2 - sel.r1} row(s) down`);
}
function fillRight() {
  if (!sel || sel.c2 === sel.c1) { showToast("Select 2+ columns to fill right", "error"); return; }
  for (let r = sel.r1; r <= sel.r2; r++) {
    const v = state.rows[r][sel.c1];
    for (let c = sel.c2; c >= sel.c1 + 1; c--) state.rows[r][c] = v;
  }
  markDirty(); pushHistory(); render();
  showToast(`Filled ${sel.c2 - sel.c1} column(s) right`);
}

/* ============ Case conversion (productivity) ============ */
function applyCase(kind) {
  if (!sel) { showToast("Select cells first", "error"); return; }
  const list = selCellList();
  if (!list.length) return;
  let n = list.length, skipped = 0;
  for (const [r, c] of list) {
    const s = state.rows[r][c] == null ? "" : String(state.rows[r][c]);
    if (s === "") continue;
    if (s.trim().charAt(0) === "=") { skipped++; continue; } // don't mangle formulas
    if (kind === "lower") state.rows[r][c] = s.toLowerCase();
    else if (kind === "upper") state.rows[r][c] = s.toUpperCase();
    else if (kind === "title") state.rows[r][c] = s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  }
  markDirty(); pushHistory(); render();
  const label = kind === "lower" ? "lowercase" : kind === "upper" ? "UPPERCASE" : "Title Case";
  showToast(`Converted ${n} cell${n === 1 ? "" : "s"} to ${label}${skipped ? ` (${skipped} formula untouched)` : ""}`);
}
exportMenu.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-delim]");
  if (!btn) return;
  exportMenu.hidden = true;
  exportWithDelim(btn.dataset.delim);
});

function toolTrim() {
  let n = 0;
  for (const r of state.rows) for (let c = 0; c < r.length; c++) {
    const before = r[c];
    const after = String(before).trim();
    if (after !== before) { r[c] = after; n++; }
  }
  if (!n) { showToast("No cells needed trimming"); return; }
  markDirty(); pushHistory(); render();
  showToast(`Trimmed ${n} cell${n === 1 ? "" : "s"}`);
}
function toolDedupe() {
  const seen = new Set();
  const keep = [];
  for (const r of state.rows) {
    const key = r.join("\u001f");
    if (seen.has(key)) continue;
    seen.add(key); keep.push(r);
  }
  const removed = state.rows.length - keep.length;
  if (!removed) { showToast("No duplicate rows found"); return; }
  state.rows = keep;
  markDirty(); pushHistory(); render();
  showToast(`Removed ${removed} duplicate row${removed === 1 ? "" : "s"}`);
}
function toolEmptyRows() {
  const before = state.rows.length;
  state.rows = state.rows.filter(r => r.some(c => String(c).trim() !== ""));
  const removed = before - state.rows.length;
  if (!removed) { showToast("No empty rows found"); return; }
  markDirty(); pushHistory(); remapFiltersAfterColRemoval(-1); render();
  showToast(`Removed ${removed} empty row${removed === 1 ? "" : "s"}`);
}
function toolEmptyCols() {
  const before = state.headers.length;
  const keepIdx = [];
  for (let c = 0; c < state.headers.length; c++) {
    const any = state.rows.some(r => String(r[c] ?? "").trim() !== "");
    if (any) keepIdx.push(c);
  }
  const removed = before - keepIdx.length;
  if (!removed) { showToast("No empty columns found"); return; }
  state.headers = keepIdx.map(i => state.headers[i]);
  state.rows = state.rows.map(r => keepIdx.map(i => r[i] ?? ""));
  state.sortCol = -1; state.sortDir = 0;
  state.filters = {};
  markDirty(); pushHistory(); render();
  showToast(`Removed ${removed} empty column${removed === 1 ? "" : "s"}`);
}

/* ============ "Select & Σ" button: select whole grid so the stats bar shows ============
   (The old per-column stats modal was superseded by the status-bar selection stats.) */
btnStats.addEventListener("click", () => {
  if (!state.rows.length) { showToast("No rows to select", "error"); return; }
  setSel(0, 0);
  extendSel(state.rows.length - 1, state.headers.length - 1);
  scroller.scrollTop = 0;
  paintBody();
  showToast("Whole grid selected — stats on the right");
});

/* ============ Find & Replace =======
   Ctrl+H opens the modal. Match operates on every cell within the current
   selection (whole grid if none). "Replace" hits only the first match;
   "Replace all" hits every match in the region. Escape closes. */
const findRoot     = $("findRoot");
const findInput    = $("findInput");
const replaceInput = $("replaceInput");
const findCase     = $("findCase");
const findWhole    = $("findWhole");
const findMeta     = $("findMeta");
const findReplace  = $("findReplace");
const findReplaceAll = $("findReplaceAll");
const findFind     = $("findFind");
const findCancel   = $("findCancel");
let findCursor = null; // [row, col, offset] of the *next* match to jump to

function openFind() {
  if (!state.rows.length) { showToast("No data to search", "error"); return; }
  findRoot.hidden = false;
  findInput.focus();
  findInput.select();
  findCursor = null;
  updateFindMeta();
}
function closeFind() {
  findRoot.hidden = true;
  findInput.value = replaceInput.value = "";
  findCase.checked = findWhole.checked = false;
  findCursor = null;
  findMeta.textContent = "Search in the selection or whole grid";
}
function updateFindMeta() {
  const region = sel || { r1: 0, r2: state.rows.length - 1, c1: 0, c2: state.headers.length - 1, __all: true };
  const cells = (region.r2 - region.r1 + 1) * (region.c2 - region.c1 + 1);
  findMeta.textContent = `Search ${cells} cell${cells === 1 ? "" : "s"} in ${sel ? "selection" : "the whole grid"}`;
}
function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function matchPredicate(q) {
  const flags = findCase.checked ? "" : "i";
  const re  = new RegExp(escapeReg(q), flags);
  const reW = findWhole.checked ? new RegExp("^" + escapeReg(q) + "$", flags) : re;
  return (cellv) => reW.test(String(cellv ?? ""));
}
// Apply the replacement to a single cell's value. Whole-cell mode replaces the
// entire value only if it matches exactly; otherwise substitute all occurrences
// of the search term (respecting the match-case option).
function replaceInCell(cell, q, rep) {
  const s = String(cell ?? "");
  const flags = findCase.checked ? "" : "i";
  if (findWhole.checked) {
    return new RegExp("^" + escapeReg(q) + "$", flags).test(s) ? rep : s;
  }
  return s.replace(new RegExp(escapeReg(q), flags + "g"), rep);
}
function findNext() {
  const q = findInput.value;
  if (!q) return showToast("Nothing to find", "error");
  const region = sel || { r1: 0, r2: state.rows.length - 1, c1: 0, c2: state.headers.length - 1, __all: true };
  const pred = matchPredicate(q);
  // search from findCursor.next, then loop back to region start
  const startR = findCursor ? findCursor[0] : region.r1;
  const startC = findCursor ? findCursor[1] : region.c1;
  for (let r = startR; r <= region.r2; r++) {
    for (let c = (r === startR ? startC : region.c1); c <= region.c2; c++) {
      if (pred(state.rows[r][c])) { findCursor = [r, c, 0]; setSel(r, c); scrollIntoViewCell(r, c); return showToast(`Match at row ${r + 1}, col ${c + 1}`); }
    }
  }
  showToast("No more matches", "error");
}
function doReplace(all) {
  const q = findInput.value;
  if (!q) return showToast("Nothing to replace", "error");
  const rep = replaceInput.value;
  const region = sel || { r1: 0, r2: state.rows.length - 1, c1: 0, c2: state.headers.length - 1 };
  const pred = matchPredicate(q);
  if (!all) {
    if (!findCursor) return showToast("Find a match first", "error");
    const [r, c] = findCursor;
    state.rows[r][c] = replaceInCell(state.rows[r][c], q, rep);
    markDirty(); pushHistory(); render();
    showToast("Replaced 1 match");
    findCursor = null;
    return;
  }
  let n = 0;
  for (let r = region.r1; r <= region.r2; r++) for (let c = region.c1; c <= region.c2; c++) {
    const before = state.rows[r][c];
    const after = replaceInCell(before, q, rep);
    if (after !== before && pred(before)) { state.rows[r][c] = after; n++; }
  }
  if (!n) return showToast("No matches", "error");
  markDirty(); pushHistory(); render();
  showToast(`Replaced ${n} match${n === 1 ? "" : "es"}`);
}
function scrollIntoViewCell(r, c) {
  const sc = scroller.getBoundingClientRect();
  const top = r * ROW_H;
  if (top < scroller.scrollTop) scroller.scrollTop = top;
  else if (top + ROW_H > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + ROW_H - scroller.clientHeight;
}
const btnFind = $("btnFind");
btnFind && btnFind.addEventListener("click", () => findRoot.hidden ? openFind() : (findInput.focus(), findInput.select()));
findFind.addEventListener("click", () => { findNext(); findInput.focus(); findInput.select(); });
findReplace.addEventListener("click", () => doReplace(false));
findReplaceAll.addEventListener("click", () => doReplace(true));
findCancel.addEventListener("click", closeFind);
findRoot.addEventListener("click", (e) => { if (e.target === findRoot) closeFind(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !findRoot.hidden) { e.preventDefault(); closeFind(); return; }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "h") {
    e.preventDefault(); findRoot.hidden ? openFind() : (findInput.focus(), findInput.select());
  }
});

/* ============ Clipboard: copy row (Ctrl+C) / paste block (native paste event) ============ */
// PASTE (Ctrl+V in the grid): the native `paste` event carries the clipboard
// text and is the robust, permission-free path (works on every real browser and
// in tests). The Ctrl+V keydown is a fallback for when no element is focused
// (focus the grid so the paste event lands), reading the clipboard directly.
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.altKey || e.shiftKey) return;
  const k = e.key.toLowerCase();
  if (k !== "c" && k !== "v") return;
  const ae = document.activeElement;
  const inCell = ae && ae.classList && ae.classList.contains("cell-input");
  if (ae === searchInput) return;
  if (k === "v") {
    if (inCell) return; // let the cell editor take the paste
    e.preventDefault();
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText()
        .then(t => { if (t && t.length) pasteCells(t); else showToast("Clipboard is empty", "error"); })
        .catch(() => showToast("Clipboard blocked — allow clipboard access", "error"));
    } else {
      showToast("Press Paste inside the grid to paste", "error");
    }
    return;
  }
  if (k === "c") {
    if (inCell) return; // let the browser copy the cell's selected text
    e.preventDefault();
    // Copy the current selection (range if extended, else the active row).
    if (sel && (sel.r2 > sel.r1 || sel.c2 > sel.c1 || (isFullRowSpan()))) copySelectionRange();
    else copyActiveRow();
  }
});
// Native paste handler — fires on real Ctrl+V and on synthetic ClipboardEvent.
scroller.addEventListener("paste", (e) => {
  const ae = document.activeElement;
  const inCell = ae && ae.classList && ae.classList.contains("cell-input");
  if (inCell || ae === searchInput) return; // let the field handle it
  const text = e.clipboardData && e.clipboardData.getData("text/plain");
  if (text && text.length) {
    e.preventDefault();
    pasteCells(text);
  }
});
function copyActiveRow() {
  if (state.rows.length === 0) { showToast("Nothing to copy", "error"); return; }
  const r = Math.max(0, Math.min(state.selectedRow, state.rows.length - 1));
  const rowTsv = state.rows[r].map(v => String(v === undefined ? "" : v)).join("\t");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(rowTsv)
      .then(() => showToast(`Row ${r + 1} copied to clipboard`))
      .catch(() => { fallbackCopy(rowTsv); showToast("Row copied"); });
  } else {
    fallbackCopy(rowTsv); showToast("Row copied");
  }
}
function fallbackCopy(text) {
  // Legacy path for browsers without the async clipboard API.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (_) {}
  ta.remove();
}
function pasteCells(text) {
  if (!text || !text.trim()) { showToast("Clipboard is empty", "error"); return; }
  if (!state.rows.length) {
    confirmAction("Paste from clipboard?", "Creates a grid from the pasted text.", () => loadText(text, undefined));
    return;
  }
  if (state.rows.some(r => r.some(c => c !== ""))) {
    confirmAction("Paste into grid?", "Pastes TSV/CSV block over the current grid (first row = header).", () => loadText(text, filenameInput.value));
    return;
  }
  loadText(text, filenameInput.value);
}

/* ============ Theme ============ */
function applyTheme(mode) {
  document.documentElement.setAttribute("data-theme", mode);
  try { localStorage.setItem("tabula:theme", mode); } catch (_) {}
}
btnTheme.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  applyTheme(cur === "dark" ? "light" : "dark");
});
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("tabula:theme"); } catch (_) {}
  if (saved) applyTheme(saved);
  else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) applyTheme("dark");
  else applyTheme("light");
})();

/* ============ Column widths (resize + auto-fit + persist) ============ */
/* ============ Selection (Sheets-style) ============================ */
// A normalized rectangle of cells plus an "active cell" (the one the cursor
// is on). `selAnchor` is the fixed origin used to grow the range with
// Shift+arrows; the active cell is the opposite corner that moves.
let sel = null;            // {r1, r2, c1, c2} normalized (inclusive)
let selAnchor = null;      // {r, c} fixed origin for extension
let act = null;            // {r, c} active/primary cell
function normSel(a, b) {
  return { r1: Math.min(a.r, b.r), r2: Math.max(a.r, b.r), c1: Math.min(a.c, b.c), c2: Math.max(a.c, b.c) };
}
function maxDims() { return { r: state.rows.length - 1, c: state.headers.length - 1 }; }
function setSel(r, c) {
  r = Math.max(0, Math.min(r, maxDims().r)); c = Math.max(0, Math.min(c, maxDims().c));
  selAnchor = { r, c }; act = { r, c }; sel = normSel({ r, c }, { r, c });
  state.selectedRow = r; updateSelection();
}
function setSelRow(r) {
  const c = maxDims().c; r = Math.max(0, Math.min(r, maxDims().r));
  selAnchor = { r, c: 0 }; act = { r, c }; sel = normSel({ r, c: 0 }, { r, c });
  state.selectedRow = r; updateSelection();
}
function setSelCol(c) {
  const r = maxDims().r; c = Math.max(0, Math.min(c, maxDims().c));
  selAnchor = { r: 0, c }; act = { r, c }; sel = normSel({ r: 0, c }, { r, c });
  state.selectedRow = r; updateSelection();
}
function extendSel(r, c) {
  if (!selAnchor) { selAnchor = { r, c }; }
  act = { r, c };
  sel = normSel(selAnchor, { r, c });
  state.selectedRow = r; updateSelection();
}
function clearSel() { sel = null; selAnchor = null; act = null; paintedSel = "none"; updateSelection(); }
function isMulti() { return sel && (sel.r2 > sel.r1 || sel.c2 > sel.c1); }
function isFullRowSpan() { return sel && sel.c1 === 0 && sel.c2 >= state.headers.length - 1; }
function isFullColSpan() { return sel && sel.r1 === 0 && sel.r2 >= state.rows.length - 1; }
function activeCell() {
  return act || (sel ? { r: sel.r2, c: sel.c2 } : null);
}
function selCellList() {
  if (!sel) return [];
  const a = [];
  for (let r = sel.r1; r <= sel.r2; r++) for (let c = sel.c1; c <= sel.c2; c++) a.push([r, c]);
  return a;
}
// Shift+arrow / arrow navigation operate on the active cell; Shift grows the
// range outward from the anchor, plain arrows move the single active cell.
function nudgeActive(dr, dc, extend) {
  if (!sel) { setSel(0, 0); act = { r: 0, c: 0 }; }
  if (!act) act = { r: sel.r2, c: sel.c2 };
  const d = maxDims();
  const nr = Math.max(0, Math.min(d.r, act.r + dr));
  const nc = Math.max(0, Math.min(d.c, act.c + dc));
  if (extend) {
    selAnchor = selAnchor || act;         // first Shift+arrow pins the anchor
    act = { r: nr, c: nc };
    sel = normSel(selAnchor, act);
    state.selectedRow = act.r;
    updateSelection();
  } else {
    setSel(nr, nc);
  }
  scrollCellIntoView(act.r, act.c);
}
function scrollCellIntoView(r, c) {
  const sc = scroller.getBoundingClientRect();
  const prefix = (windowState && windowState.prefix) || null;
  let top = 0, bottom = ROW_H;
  if (prefix) {
    const pos = Math.max(0, Math.min(prefix.length - 2, r));
    top = prefix[pos]; bottom = prefix[pos + 1];
  }
  if (top < scroller.scrollTop) scroller.scrollTop = top;
  else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
  const left = 46 + Array.from({ length: c }, (_, i) => colWidths[i] || DEFAULT_COL_W).reduce((a, b) => a + b, 0);
  const right = left + (colWidths[c] || DEFAULT_COL_W);
  if (left < 46 + scroller.scrollLeft) scroller.scrollLeft = Math.max(0, left - 46);
  else if (right > scroller.scrollLeft + scroller.clientWidth - 34) scroller.scrollLeft = right - scroller.clientWidth + 34;
}
/* ============ Type inference — single source of truth ============
   A cell value is classified exactly once and the result drives display
   alignment, stats (sum / avg / min / max vs. date / time / boolean),
   sorting, and per-column type detection. This replaces the old ad-hoc
   "is this a number?" checks so dates, times, booleans, percents and
   currency are handled consistently everywhere (and dates are never
   silently folded into numeric sums). */
const MONTH_NUM = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
const TWO_DIGIT_Y = (y) => (y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y);
const validDate = (y, mo, dd) =>
  Number.isInteger(y) && mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31 &&
  new Date(Date.UTC(y, mo - 1, dd)).getUTCDate() === dd &&
  new Date(Date.UTC(y, mo - 1, dd)).getUTCMonth() === mo - 1;
const mkDate = (dd, mo, y) => (validDate(y, mo, dd) ? { y, mo, dd } : null);

// Standalone time-of-day → {hh,mm,ss} | null.
function parseTimeStr(s) {
  const low = s.toLowerCase();
  let m = low.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (m) {
    let hh = +m[1], mm = +m[2], ss = m[3] ? +m[3] : 0;
    if (m[4] === "pm" && hh < 12) hh += 12;
    if (m[4] === "am" && hh === 12) hh = 0;
    if (hh > 23 || mm > 59 || ss > 59) return null;
    return { hh, mm, ss };
  }
  m = low.match(/^(\d{1,2})\s*(am|pm)$/);
  if (m) {
    let hh = +m[1];
    if (m[2] === "pm" && hh < 12) hh += 12;
    if (m[2] === "am" && hh === 12) hh = 0;
    if (hh > 23) return null;
    return { hh, mm: 0, ss: 0 };
  }
  return null;
}

// Calendar date (no time) → {y,mo,dd} | null for the formats below.
function parseDateStr(s) {
  const low = s.toLowerCase();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return mkDate(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const a = +m[1], bb = +m[2], y = TWO_DIGIT_Y(+m[3]);
    let mo, dd;
    if (a > 12) { mo = bb; dd = a; }
    else if (bb > 12) { dd = bb; mo = a; }
    else { mo = a; dd = bb; }                 // ambiguous → month-first (US)
    return mkDate(dd, mo, y);
  }
  m = low.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})$/);
  if (m && MONTH_NUM[m[1].slice(0, 3)]) return mkDate(+m[2], MONTH_NUM[m[1].slice(0, 3)], TWO_DIGIT_Y(+m[3]));
  m = low.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{2,4})$/);
  if (m && MONTH_NUM[m[2].slice(0, 3)]) return mkDate(+m[1], MONTH_NUM[m[2].slice(0, 3)], TWO_DIGIT_Y(+m[3]));
  return null;
}

// A plain/decimal/percent/currency number → finite number | null.
function toNumberCore(s) {
  if (s === undefined || s === null) return null;
  let t = String(s).trim();
  if (t === "") return null;
  if (/[a-z]/i.test(t)) {
    if (/[£$€¥₹]/.test(t)) t = t.replace(/[£$€¥₹]/g, "");
    else return null;
  }
  t = t.replace(/[$,]/g, "").trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// CLASSIFY one cell value. `value` is always a finite number when comparable
// (numeric value; date/datetime = UTC ms; time = seconds-of-day; bool = 0/1).
function typeInfo(v) {
  if (v === undefined || v === null) return { type: "empty", value: NaN, negative: false, align: "left" };
  const s = String(v).trim();
  if (s === "") return { type: "empty", value: NaN, negative: false, align: "left" };
  const low = s.toLowerCase();

  // Boolean
  if (low === "true" || low === "false" || low === "yes" || low === "no") {
    const b = low === "true" || low === "yes";
    return { type: "boolean", value: b ? 1 : 0, negative: false, align: "left", bool: b };
  }

  // Datetime (date prefix + trailing time): "2021-03-15 14:30", "03/15/2021 9:30 AM", "2021-03-15T14:30:05"
  const dtMatch = s.match(/^(.*?)[\sT]+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm))?)$/i);
  if (dtMatch) {
    const d = parseDateStr(dtMatch[1].trim());
    const t = parseTimeStr(dtMatch[2]);
    if (d && t) {
      const value = Date.UTC(d.y, d.mo - 1, d.dd, t.hh, t.mm, t.ss, 0);
      return { type: "datetime", value, negative: false, align: "right", d, t };
    }
  }

  // Date
  const d = parseDateStr(s);
  if (d) {
    const value = Date.UTC(d.y, d.mo - 1, d.dd, 12, 0, 0, 0); // noon → stable across TZ
    return { type: "date", value, negative: false, align: "right", d };
  }

  // Time
  const t = parseTimeStr(s);
  if (t) return { type: "time", value: t.hh * 3600 + t.mm * 60 + t.ss, negative: false, align: "right", t };

  // Parenthesized negative: (1,234) / ($500) / (12%)
  if (/^\(.*\)$/.test(s)) {
    const inner = s.slice(1, -1);
    const n = /%$/.test(inner) ? toNumberCore(inner.replace(/%$/).trim()) : toNumberCore(inner);
    if (n !== null) {
      const value = -Math.abs(n);
      return { type: n < 0 ? "number" : "number", value, negative: true, align: "right" };
    }
  }

  // Percent: 25% / 12.5% / 1,000%
  if (/%$/.test(s)) {
    const n = toNumberCore(s.replace(/%$/, "").trim());
    if (n !== null) return { type: "percent", value: n, negative: n < 0, align: "right" };
  }

  // Currency / plain number: $1,234.56 / 1,234 / -0.5 / .75
  const n = toNumberCore(s);
  if (n !== null) {
    const cur = /[£$€¥₹]/.test(s);
    return { type: cur ? "currency" : "number", value: n, negative: n < 0, align: "right" };
  }

  return { type: "text", value: NaN, negative: false, align: "left" };
}

// Legacy shape (used by earlier tests / the console API) — a thin view over typeInfo.
function cellNumericInfo(v) {
  const ti = typeInfo(v);
  if (ti.type === "empty") return { kind: "empty", value: NaN, negative: false };
  // Numbers, percents, currency, dates, datetimes, times → right-aligned "num".
  // Booleans and free text → left "text". (`num` was historically used for the
  // right-aligned group; `date` is preserved when a value is a pure date.)
  const kind = (ti.type === "date" || ti.type === "datetime") ? "date"
             : ti.align === "right" ? "num" : "text";
  return { kind, value: ti.value, negative: !!ti.negative };
}

function computeStats(r1, c1, r2, c2) {
  let count = 0, empty = 0, textCount = 0;
  const num = { count: 0, sum: 0, min: Infinity, max: -Infinity };
  const dates = { count: 0, minMs: Infinity, maxMs: -Infinity, minS: null, maxS: null };
  const times = { count: 0, minS: null, maxS: null, minSecs: Infinity, maxSecs: -Infinity };
  const bools = { count: 0, trueCount: 0 };
  for (let r = r1; r <= r2; r++) {
    const row = state.rows[r]; if (!row) continue;
    for (let c = c1; c <= c2; c++) {
      const v = row[c];
      const s = v === undefined ? "" : String(v).trim();
      count++;
      // Formulas resolve to their computed value first; a formula error
      // counts as text-ish (never leaks into the numeric aggregates).
      let text = s;
      if (s.charAt(0) === "=") {
        const rv = resolveCell(r, c);
        if (rv.e) { textCount++; continue; }
        if (rv.n !== null) text = String(rv.n);
        else if (rv.text !== undefined) text = rv.text;
      }
      if (text === "") { empty++; continue; }
      const ti = typeInfo(text);
      if (ti.type === "number" || ti.type === "percent" || ti.type === "currency") {
        num.count++; num.sum += ti.value;
        if (ti.value < num.min) num.min = ti.value;
        if (ti.value > num.max) num.max = ti.value;
      } else if (ti.type === "date" || ti.type === "datetime") {
        dates.count++;
        if (ti.value < dates.minMs) { dates.minMs = ti.value; dates.minS = s; }
        if (ti.value > dates.maxMs) { dates.maxMs = ti.value; dates.maxS = s; }
      } else if (ti.type === "time") {
        times.count++;
        if (ti.value < times.minSecs) { times.minSecs = ti.value; times.minS = s; }
        if (ti.value > times.maxSecs) { times.maxSecs = ti.value; times.maxS = s; }
      } else if (ti.type === "boolean") {
        bools.count++; if (ti.bool) bools.trueCount++;
      } else {
        textCount++;
      }
    }
  }
  return {
    count, empty, textCount, nonNum: textCount,
    numCount: num.count,
    hasNum: num.count > 0,
    sum: num.sum, avg: num.count ? num.sum / num.count : null,
    min: num.count ? num.min : null, max: num.count ? num.max : null,
    dateCount: dates.count, dateMin: dates.count ? dates.minS : null, dateMax: dates.count ? dates.maxS : null,
    timeCount: times.count, timeMin: times.count ? times.minS : null, timeMax: times.count ? times.maxS : null,
    boolCount: bools.count, boolTrue: bools.trueCount,
  };
}
// Format a number for the stats bar (plain integers stay integer; else up to 4 dp).
function fmtStat(x) {
  if (x === null || x === undefined || !isFinite(x)) return "—";
  if (Number.isInteger(x)) return x.toLocaleString();
  return x.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
function inSelection(r, c) { return sel && r >= sel.r1 && r <= sel.r2 && c >= sel.c1 && c <= sel.c2; }
function computeStatsFull() { return sel ? computeStats(sel.r1, sel.c1, sel.r2, sel.c2) : null; }
// Selection classes are baked into the DOM by `rowHtml`/`renderHeader` at
// paint time. `updateSelection()` decides *when* to repaint (only when the
// selection bounds actually changed) so a drag that hovers within the same
// row does not trigger a redundant DOM rebuild.
let paintedSel = null;
const selKey = (s) => (s ? s.r1 + "," + s.r2 + "," + s.c1 + "," + s.c2 : "none");
function paintSelection() {
  if (windowState) paintBody();
  refreshHeaderSel();
}
function refreshHeaderSel() {
  if (!head) return;
  const fullCol = sel && sel.r1 === 0 && sel.r2 >= state.rows.length - 1;
  for (const th of head.querySelectorAll("th[data-col]")) {
    const c = +th.dataset.col;
    th.classList.toggle("col-sel", !!(fullCol && c >= sel.c1 && c <= sel.c2));
  }
}
function updateSelection() {
  const key = selKey(sel);
  if (paintedSel !== key) {
    paintedSel = key;
    paintSelection();
  } else {
    refreshHeaderSel();
  }
  updateSelStats();
  if (typeof updateFmtToolbar === "function") updateFmtToolbar();
  if (typeof updateFxBar === "function") updateFxBar();
}

/* ---- Formula bar: name box + input for the active cell ---- */
// The cell being edited was captured when the input gained focus, so that a
// click on *another* cell first commits to this one (Excel semantics) and
// then moves the selection.
let fxTargetCell = null;
function captureFxTarget() { fxTargetCell = activeCell() || null; }
// Keep the name box and input in sync with the active cell without clobbering
// an in-progress edit (only rewrite the input when it is not focused).
function updateFxBar() {
  if (!fxName || !fxInput) return;
  const a = activeCell() && state.rows.length ? activeCell() : null;
  if (!a) { fxName.textContent = "—"; if (document.activeElement !== fxInput) fxInput.value = ""; return; }
  fxName.textContent = colLetter(a.c) + (a.r + 1);
  if (document.activeElement !== fxInput) {
    const raw = state.rows[a.r] && state.rows[a.r][a.c];
    fxInput.value = raw === undefined || raw === null ? "" : String(raw);
  }
}
function commitFxBar() {
  if (!fxInput) return;
  const a = fxTargetCell || activeCell();
  fxTargetCell = null;
  if (!a) { fxInput.blur(); return; }
  const newVal = fxInput.value;
  const old = state.rows[a.r] && state.rows[a.r][a.c];
  if ((old === undefined || old === null ? "" : String(old)) !== newVal) {
    state.rows[a.r][a.c] = newVal;
    markDirty(); pushHistory();
  }
  if (document.activeElement === fxInput) fxInput.blur();
  updateFxBar();
  render();
}
function revertFxBar() {
  if (!fxInput) return;
  const a = fxTargetCell;
  fxTargetCell = null;
  if (a) {
    const raw = state.rows[a.r] && state.rows[a.r][a.c];
    fxInput.value = raw === undefined || raw === null ? "" : String(raw);
  }
  if (document.activeElement === fxInput) fxInput.blur();
  render();
}
function focusFxBar() {
  if (!fxInput) return;
  fxInput.focus();
  fxInput.select();
}
if (fxInput) {
  fxInput.addEventListener("focus", () => captureFxTarget());
  fxInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitFxBar(); }
    else if (e.key === "Escape") { e.preventDefault(); revertFxBar(); }
    e.stopPropagation(); // keep the grid keydown handler out of the formula bar
  });
  fxInput.addEventListener("dblclick", () => fxInput.select());
  // Save-on-blur parity: focus moving elsewhere commits the pending edit.
  fxInput.addEventListener("focusout", () => {
    setTimeout(() => {
      if (document.activeElement !== fxInput && document.activeElement !== searchInput) commitFxBar();
    }, 0);
  });
}
// F2 jumps into the formula bar for the active cell (Excel convention).
document.addEventListener("keydown", (e) => {
  if (e.key !== "F2") return;
  if (fxInput && document.activeElement === fxInput) return;
  if (!activeCell()) return;
  e.preventDefault();
  focusFxBar();
});
function updateSelStats() {
  const el = $("selStats"); if (!el) return;
  if (!sel) { el.hidden = true; el.innerHTML = ""; return; }
  const st = computeStats(sel.r1, sel.c1, sel.r2, sel.c2);
  el.hidden = false;
  const multi = isMulti();
  const copyable = (label, val, title) =>
    `<span class="sel-item" data-copy="${String(val).replace(/"/g, "&quot;")}" title="${title || label} (click to copy)">${label} ${val}</span>`;
  let html = `<span class="sel-n">${st.count} cell${st.count === 1 ? "" : "s"}</span>`;
  // Numeric: sum / average / min / max
  if (st.hasNum) {
    html += copyable("Σ", fmtStat(st.sum), "Sum")
          + copyable("x̄", fmtStat(st.avg), "Average")
          + copyable("min", fmtStat(st.min), "Minimum")
          + copyable("max", fmtStat(st.max), "Maximum");
  }
  // Dates: earliest / latest (keep the original cell text, not a recomputed date)
  if (st.dateCount) {
    html += copyable("📅", st.dateMin, "Earlier")
          + copyable("📅", st.dateMax, "Later");
  }
  // Times: earliest / latest
  if (st.timeCount) {
    html += copyable("⏱", st.timeMin, "Earliest")
          + copyable("⏱", st.timeMax, "Latest");
  }
  // Booleans: how many TRUE
  if (st.boolCount) {
    html += `<span class="sel-item" title="True / total">✓ ${st.boolTrue}/${st.boolCount}</span>`;
  }
  // Breakdown + non-numerics
  if (st.textCount > 0) html += `<span class="sel-item text" title="non-numeric cells" data-copy="${st.textCount}">A→Z ${st.textCount}</span>`;
  if (st.empty > 0) html += `<span class="sel-item text" title="empty cells" data-copy="${st.empty}">∅ ${st.empty}</span>`;
  html += `<span class="sel-item" data-copy="${st.count}" title="Count of all cells" >n ${st.count}</span>`;
  if (st.hasNum) html += `<button class="sel-sigma" id="selSigma" type="button" title="Compute / copy a statistic">Σ more</button>`;
  if (multi) html += `<button class="sel-act" id="selClear" type="button" title="Clear all selected cells">Clear cells</button>`;
  if (isFullRowSpan()) html += `<button class="sel-act danger" id="selDelRows" type="button" title="Delete all selected rows">Delete ${sel.r2 - sel.r1 + 1} rows</button>`;
  el.innerHTML = html;
  // wire copy chips (click to copy the value)
  el.querySelectorAll(".sel-item[data-copy]").forEach(ch => ch.addEventListener("click", () => {
    writeClipboard(ch.dataset.copy)
      .then(() => showToast((ch.dataset.copy) + " copied"))
      .catch(() => showToast("Copy blocked", "error"));
  }));
  const sum = el.querySelector("#selSigma");
  if (sum) sum.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(sum, $("sigmaMenu")); });
  const cl = el.querySelector("#selClear");
  if (cl) cl.addEventListener("click", (e) => { e.stopPropagation(); clearSelectionCells(); });
  const dr = el.querySelector("#selDelRows");
  if (dr) dr.addEventListener("click", (e) => { e.stopPropagation(); deleteSelectedRows(); });
}
function writeClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } catch (_) {}
  ta.remove();
  return Promise.resolve();
}
function copySelectionRange() {
  if (!sel) return false;
  const lines = [];
  for (let r = sel.r1; r <= sel.r2; r++) {
    lines.push(Array.from({ length: sel.c2 - sel.c1 + 1 }, (_, k) => cellValueText(r, sel.c1 + k)).join("\t"));
  }
  writeClipboard(lines.join("\n"))
    .then(() => showToast(`Selected range copied (${lines.length} row${lines.length === 1 ? "" : "s"})`))
    .catch(() => showToast("Copy blocked", "error"));
  return true;
}
function clearSelectionCells() {
  const list = selCellList();
  if (!list.length) return;
  for (const [r, c] of list) state.rows[r][c] = "";
  markDirty(); pushHistory(); render();
  showToast(`Cleared ${list.length} cell${list.length === 1 ? "" : "s"}`);
}
function deleteSelectedRows() {
  if (!sel) return;
  const set = new Set(); for (let r = sel.r1; r <= sel.r2; r++) set.add(r);
  const n = set.size;
  confirmAction(`Delete ${n} row${n === 1 ? "" : "s"}?`, "Permanently removed from the grid. Undo is available after.", () => {
    state.rows = state.rows.filter((_, i) => !set.has(i));
    state.selectedRow = Math.max(0, Math.min(state.selectedRow, state.rows.length - 1));
    clearSel();
    markDirty(); pushHistory(); render();
    showToast(`Deleted ${n} row${n === 1 ? "" : "s"}`);
  });
}
function selectedRangeTsv() {
  if (!sel) return null;
  const lines = [];
  for (let r = sel.r1; r <= sel.r2; r++) {
    lines.push(Array.from({ length: sel.c2 - sel.c1 + 1 }, (_, k) => cellValueText(r, sel.c1 + k)).join("\t"));
  }
  return lines.join("\n");
}

/* ============ Column widths (resize + auto-fit + persist) ============ */
const DEFAULT_COL_W = 120;
const MIN_COL_W  = 60;
const MAX_COL_W  = 800;
const WS_KEY     = "tabula:widths:v1";
let colWidths = [];
// The CSS width `max(100%, …)` would stretch the table to the viewport and,
// under `table-layout: fixed`, distribute that surplus across every column,
// overriding explicit <col> widths. Google-Sheets instead sizes the grid to
// exactly the sum of its columns (blank canvas beyond). We replicate that by
// forcing the table's inline width to the true column sum in both rebuild and
// per-frame updates.
function applyTableWidth() {
  const table = document.querySelector("table.grid");
  if (!table) return;
  const sum = 46 + 34 + colWidths.reduce((a, b) => a + (b || 0), 0);
  table.style.width = sum + "px";
  table.style.minWidth = "0";
}
// Full rebuild — only when the *number* of columns changes (load / add / delete).
function syncColgroup() {
  if (!colgroup) return;
  const n = state.headers.length;
  while (colWidths.length < n) colWidths.push(DEFAULT_COL_W);
  if (colWidths.length > n) colWidths = colWidths.slice(0, n);
  let h = `<col style="width:46px">`;
  for (let c = 0; c < n; c++) h += `<col style="width:${Math.round(colWidths[c])}px">`;
  h += `<col style="width:34px">`;
  colgroup.innerHTML = h;
  applyTableWidth();
}
// O(1) width update — touch only the single <col> plus the table width (both
// constant-time). This is what runs per-frame during a drag, so a 50k-row grid
// stays fluid: no innerHTML rebuild, no full-column reflow storm.
function setColWidth(c, w) {
  if (!colgroup) return;
  const col = colgroup.children[1 + c]; // skip the 46px colnum gutter
  if (col) col.style.width = Math.round(w) + "px";
  colWidths[c] = w;
  applyTableWidth();
}
function persistWidths() {
  try {
    const store = JSON.parse(localStorage.getItem(WS_KEY) || "{}");
    const key = (filenameInput.value.trim() || "untitled").replace(/\.[^.]+$/, "");
    if (key) store[key] = colWidths.concat();
    localStorage.setItem(WS_KEY, JSON.stringify(store));
  } catch (_) {}
}
function applyStoredWidths() {
  try {
    const store = JSON.parse(localStorage.getItem(WS_KEY) || "{}");
    const key = (filenameInput.value.trim() || "untitled").replace(/\.[^.]+$/, "");
    const saved = store && store[key];
    if (saved && Array.isArray(saved)) {
      const n = state.headers.length;
      for (let i = 0; i < n; i++) if (saved[i] && isFinite(saved[i])) colWidths[i] = saved[i];
    }
  } catch (_) {}
  syncColgroup();
}
syncColgroup();

function autofitColumn(c) {
  if (c < 0 || c >= state.headers.length) return;
  let w = 0;
  const getProbe = (() => {
    let p = null;
    return () => {
      if (!p) {
        p = document.createElement("span");
        p.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;padding:0 11px;box-sizing:content-box;";
        p.style.font = "13px/1.45 " + (getComputedStyle(document.body).fontFamily || "inherit");
        document.body.appendChild(p);
      }
      return p;
    };
  })();
  const measure = (txt) => {
    const probe = getProbe();
    probe.textContent = txt || " ";
    return probe.offsetWidth;
  };
  w = Math.max(w, measure(state.headers[c] || ("Column " + (c + 1))));
  const SAMPLE = 60;
  const step = Math.max(1, Math.floor(state.rows.length / SAMPLE));
  for (let i = 0; i < state.rows.length; i += step) {
    const v = state.rows[i][c];
    if (v === undefined || v === "") continue;
    w = Math.max(w, measure(String(v)));
  }
  colWidths[c] = Math.max(MIN_COL_W, Math.min(MAX_COL_W, w + 18));
  setColWidth(c, colWidths[c]);
}

let resizing = null;
let resizeRAF = 0;
document.addEventListener("mousedown", (e) => {
  const grip = e.target.closest(".col-resize");
  if (!grip) return;
  e.preventDefault();
  e.stopPropagation();
  const c = parseInt(grip.dataset.col, 10);
  if (!isFinite(c)) return;
  const startW = colWidths[c] || DEFAULT_COL_W;
  const startX = e.clientX;
  resizing = { col: c, startW, startX };
  document.body.classList.add("user-select-none");
  const onMove = (ev) => {
    if (!resizing) return;
    const delta = ev.clientX - resizing.startX;
    const w = Math.max(MIN_COL_W, Math.min(MAX_COL_W, resizing.startW + delta));
    colWidths[resizing.col] = w;
    // Throttle to one DOM write per animation frame and touch only this <col>.
    if (resizeRAF) return;
    resizeRAF = requestAnimationFrame(() => {
      resizeRAF = 0;
      if (resizing) setColWidth(resizing.col, colWidths[resizing.col]);
    });
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    window.removeEventListener("blur", onUp, true);
    document.body.classList.remove("user-select-none");
    if (Math.round(colWidths[resizing.col]) !== Math.round(resizing.startW)) persistWidths();
    resizing = null;
  };
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("blur", onUp, true);
}, false);

// double-click → auto-fit (skip sort toggle)
head.addEventListener("dblclick", (e) => {
  const grip = e.target.closest(".col-resize");
  if (!grip) return;
  e.preventDefault(); e.stopPropagation();
  const c = parseInt(grip.dataset.col, 10);
  if (!isFinite(c)) return;
  autofitColumn(c);
  persistWidths();
});

/* ============ Context menu (right-click) ============
   A custom in-app menu. It augments — never replaces — the OS menu, since
   we can't fully suppress the browser context menu portably anyway. The
   menu appears at the cursor and dismisses on scroll / click-outside / Esc.
   All actions are context-aware (cell vs. row vs. column) so the same menu
   works whether you right-click one cell, a range, a row number, or a
   column header. */
const Ctx = (() => {
  const el = $("ctxMenu");

  const actions = {
    copy:     { label: "Copy",        kbd: "⌘C",  run: () => copySelectionRange() },
    paste:    { label: "Paste",       kbd: "⌘V",  run: pasteFromClipboard },
    clear:    { label: "Clear cells", kbd: "⌫",   run: clearSelectionCells },
    insRow:   { label: "Insert row above",   run: insertRowAbove },
    insRowB:  { label: "Insert row below",   run: insertRowBelow },
    dupRow:   { label: "Duplicate row(s)",   run: () => { duplicateRow(); } },
    moveUp:   { label: "Move row up",        run: () => { moveRow(-1); } },
    moveDn:   { label: "Move row down",      run: () => { moveRow(1); } },
    insCol:   { label: "Insert column left", run: insertColLeft },
    insColR:  { label: "Insert column right",run: insertColRight },
    delRow:   { label: "Delete row(s)", danger: true, run: deleteSelectedRows },
    delCol:   { label: "Delete column", danger: true, run: deleteSelectedColumns },
    fillDown: { label: "Fill down", kbd: "⌘D", run: fillDown },
    fillRight:{ label: "Fill right", kbd: "⌘⇧R", run: fillRight },
    caseLower:{ label: "Lowercase", run: () => applyCase("lower") },
    caseUpper:{ label: "UPPERCASE", run: () => applyCase("upper") },
    caseTitle:{ label: "Title Case", run: () => applyCase("title") },
    fmtBold:  { label: "Bold",       kbd: "⌘B", run: () => applyFmt("fmtBold", "bold") },
    fmtItalic:{ label: "Italic",     kbd: "⌘I", run: () => applyFmt("fmtItalic", "italic") },
    fmtUnder: { label: "Underline",  kbd: "⌘U", run: () => applyFmt("fmtUnder", "underline") },
    fmtAL:    { label: "Align left", run: () => applyFmt("fmtAlignL", "align-left") },
    fmtAC:    { label: "Align center", run: () => applyFmt("fmtAlignC", "align-center") },
    fmtAR:    { label: "Align right", run: () => applyFmt("fmtAlignR", "align-right") },
    fmtWrap:  { label: "Word wrap (on/off)", run: () => applyFmt("fmtWrap", "wrap") },
    fmtClear: { label: "Clear formatting", run: () => { clearFormatting(); updateSelection(); } },
    sortAsc:  { label: "Sort A → Z", run: () => sortSelColumn(1) },
    sortDesc: { label: "Sort Z → A", run: () => sortSelColumn(-1) },
    autofit:  { label: "Auto-fit column",   run: () => autofitColumn(ctxCol()) },
  };

  const ctxCol = () => (state.ctx && state.ctx.c !== undefined ? state.ctx.c : (act ? act.c : -1));

  function addBtn(id, labelOverride) {
    const a = actions[id]; if (!a) return;
    const btn = document.createElement("button");
    btn.type = "button";
    if (a.danger) btn.className = "danger";
    const span = document.createElement("span");
    span.textContent = labelOverride || a.label;
    btn.appendChild(span);
    if (a.kbd) { const k = document.createElement("kbd"); k.textContent = a.kbd; btn.appendChild(k); }
    btn.addEventListener("click", () => { hide(); a.run(); });
    el.appendChild(btn);
  }
  function addSep() { const d = document.createElement("div"); d.className = "ctx-sep"; el.appendChild(d); }

  function buildMenu(kinds) {
    el.innerHTML = "";
    if (kinds.includes("cell")) {
      addBtn("copy"); addBtn("paste"); addBtn("clear"); addSep();
      addBtn("caseLower"); addBtn("caseUpper"); addBtn("caseTitle"); addSep();
      addBtn("fmtBold"); addBtn("fmtItalic"); addBtn("fmtUnder"); addSep();
      addBtn("fmtAL"); addBtn("fmtAC"); addBtn("fmtAR"); addBtn("fmtWrap"); addSep();
      addBtn("fillDown"); addBtn("fillRight"); addSep();
      addBtn("sortAsc"); addBtn("sortDesc"); addBtn("autofit"); addSep();
      addBtn("insRow"); addBtn("insRowB"); addBtn("dupRow"); addBtn("moveUp"); addBtn("moveDn"); addSep();
      addBtn("insCol"); addBtn("insColR");
      addBtn("delRow"); addBtn("delCol"); addSep();
      addBtn("fmtClear");
    } else if (kinds.includes("row")) {
      addBtn("insRow"); addBtn("insRowB"); addBtn("dupRow"); addBtn("moveUp"); addBtn("moveDn"); addSep();
      addBtn("delRow");
    } else if (kinds.includes("col")) {
      addBtn("insCol"); addBtn("insColR"); addBtn("sortAsc"); addBtn("sortDesc"); addBtn("autofit"); addBtn("delCol");
    } else {
      addBtn("copy"); addBtn("paste"); addSep(); addBtn("insRow"); addBtn("insCol");
    }
  }

  function show(x, y, kinds, target) {
    state.ctx = target || null;
    buildMenu(kinds);
    el.hidden = true;      // reset so offsetWidth/Height are real
    el.hidden = false;
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + "px";
    el.style.top  = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + "px";
  }
  function hide() { el.hidden = true; state.ctx = null; }

  document.addEventListener("mousedown", (e) => {
    if (!el.hidden && !el.contains(e.target)) hide();
  }, true);
  scroller.addEventListener("scroll", hide, { passive: true });
  window.addEventListener("blur", hide);

  document.addEventListener("contextmenu", (e) => {
    if (!state.rows.length) return;
    if (e.target.closest && e.target.closest("button, input, select, textarea")) return;
    const closestEl = (sel) => e.target.closest && e.target.closest(sel);
    const inHead = closestEl("#head");
    const rownum = closestEl("td.rownum");
    const inRowdel = closestEl("td.rowdel");
    const cell = closestEl("td.cell");
    let kinds, target = null;
    if (inHead) {
      const th = closestEl("th[data-col]");
      if (!th) return;                              // gutter / add-col: use browser menu
      e.preventDefault();
      kinds = ["col"]; target = { c: +th.dataset.col, r: 0 };
    } else if (rownum) {
      const tr = rownum.closest("tr[data-ri]");     // index lives on the <tr>
      if (!tr) return;
      e.preventDefault();
      kinds = ["row"]; target = { r: +tr.dataset.ri, c: 0 };
    } else if (inRowdel) {
      const tr = inRowdel.closest("tr[data-ri]");
      if (!tr) return;
      e.preventDefault();
      kinds = ["row"]; target = { r: +tr.dataset.ri, c: 0 };
    } else if (cell) {
      e.preventDefault();
      const r = +cell.dataset.ri, c = +cell.dataset.c;
      ensureSelAt(r, c);
      kinds = ["cell"]; target = { r, c };
    } else {
      return;                                       // empty area: leave the browser menu
    }
    show(e.clientX, e.clientY, kinds, target);
  });

  return { hide };
})();
function hideCtxMenu() { if (Ctx.hide) Ctx.hide(); }

/* ---- context-menu insertion helpers (kept local to module above? no —
   these touch shared model, so they live here for discoverability) -------- */
function insertRowAbove() {
  const r = (state.ctx && state.ctx.r !== undefined) ? state.ctx.r : (act ? act.r : 0);
  state.rows.splice(r, 0, new Array(state.headers.length).fill(""));
  markDirty(); pushHistory(); render();
  setSel(r, sel ? sel.c1 : 0);
  showToast("Row inserted");
}
function insertRowBelow() {
  const r = (state.ctx && state.ctx.r !== undefined) ? state.ctx.r : (act ? act.r : state.rows.length - 1);
  state.rows.splice(r + 1, 0, new Array(state.headers.length).fill(""));
  markDirty(); pushHistory(); render();
  setSel(r + 1, sel ? sel.c1 : 0);
  showToast("Row inserted");
}
// Duplicate every row in the active selection (or the row under the cursor).
function duplicateRow() {
  const top = sel && isFullRowSpan() ? sel.r1 : (state.ctx && state.ctx.r !== undefined ? state.ctx.r : (act ? act.r : -1));
  const bot = sel && isFullRowSpan() ? sel.r2 : top;
  if (top < 0 || bot < 0 || top >= state.rows.length) return;
  const copies = [];
  for (let r = top; r <= bot; r++) copies.push(state.rows[r].slice());
  state.rows.splice(bot + 1, 0, ...copies);
  markDirty(); pushHistory(); render();
  setSel(bot + 1, sel ? sel.c1 : 0);
  showToast(copies.length + " " + (copies.length === 1 ? "row" : "rows") + " duplicated");
}
// Move a row (or the whole selected block) one step up or down.
function moveRow(dir) {
  const top = sel && isFullRowSpan() ? sel.r1 : (state.ctx && state.ctx.r !== undefined ? state.ctx.r : (act ? act.r : -1));
  const bot = sel && isFullRowSpan() ? sel.r2 : top;
  if (top < 0 || bot < 0 || top >= state.rows.length) return;
  if (dir < 0 && top === 0) { showToast("Already at top"); return; }
  if (dir > 0 && bot >= state.rows.length - 1) { showToast("Already at bottom"); return; }
  const block = state.rows.slice(top, bot + 1);
  state.rows.splice(top, bot - top + 1);
  const target = dir < 0 ? top - 1 : bot + 1;
  state.rows.splice(target, 0, ...block);
  markDirty(); pushHistory(); render();
  setSel(dir < 0 ? top - 1 : bot + 1, sel ? sel.c1 : 0);
}
function insertColLeft() {
  const c = (state.ctx && state.ctx.c !== undefined) ? state.ctx.c : (act ? act.c : 0);
  insertCol(c, "Column " + (c + 1));
}
function insertColRight() {
  const c = (state.ctx && state.ctx.c !== undefined) ? state.ctx.c : (act ? act.c : state.headers.length - 1);
  insertCol(c + 1, "Column " + (c + 2));
}
function insertCol(at, name) {
  state.headers.splice(at, 0, name);
  for (const r of state.rows) { r.splice(at, 0, ""); }
  colWidths.splice(at, 0, DEFAULT_COL_W);
  markDirty(); pushHistory(); render();
  showToast("Column inserted");
}
function deleteSelectedColumns() {
  if (!sel) return;
  const set = new Set(); for (let c = sel.c1; c <= sel.c2; c++) set.add(c);
  const names = [...set].map(c => state.headers[c] || "Column " + (c + 1)).join(", ");
  confirmAction(`Delete ${set.size} column${set.size === 1 ? "" : "s"}? (${names})`,
    "Removes from every row. Undo is available after.", () => {
      state.headers = state.headers.filter((_, i) => !set.has(i));
      state.rows = state.rows.map(r => r.filter((_, i) => !set.has(i)));
      colWidths = colWidths.filter((_, i) => !set.has(i));
      markDirty(); pushHistory(); render();
      showToast(`Deleted ${set.size} column${set.size === 1 ? "" : "s"}`);
    });
}
function sortSelColumn(dir) {
  const c = (state.ctx && state.ctx.c !== undefined) ? state.ctx.c
          : (act ? act.c : (sel ? sel.c1 : 0));
  state.sortCol = c; state.sortDir = dir;
  applySort(); pushHistory(); render();
  showToast(`Sorted by "${state.headers[c] || "Column " + (c + 1)}" (dir ${dir > 0 ? "asc" : "desc"})`);
}
function pasteFromClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.readText) {
    showToast("Clipboard read blocked by browser", "error"); return;
  }
  navigator.clipboard.readText()
    .then(t => { if (t && t.length) pasteCells(t); else showToast("Clipboard is empty", "error"); })
    .catch(() => showToast("Clipboard read blocked", "error"));
}
function ensureSelAt(r, c) {
  if (!sel) { setSel(r, c); return; }
  if (inSelection(r, c)) return;
  setSel(r, c);
}

/* ============ Buttons ============ */
const sigmaMenu = $("sigmaMenu");
sigmaMenu.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-sigma]");
  if (!btn) return;
  const fn = btn.dataset.sigma;
  sigmaMenu.hidden = true;
  if (!sel) { showToast("Select cells first", "error"); return; }
  const st = computeStats(sel.r1, sel.c1, sel.r2, sel.c2);
  const map = { sum: st.sum, avg: st.avg, min: st.min, max: st.max, count: st.count };
  if (fn === "clear") { clearSelectionCells(); return; }
  if (fn === "delrows") { deleteSelectedRows(); return; }
  writeClipboard(String(map[fn]))
    .then(() => showToast(`${fn.toUpperCase()} = ${fmtStat(map[fn])} copied`))
    .catch(() => showToast("Copy blocked", "error"));
});
btnUndo.addEventListener("click", undo);
btnRedo.addEventListener("click", redo);
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
// Resolve formulas to their computed values on export — a `=SUM(C:C)` cell
// must download as its number, not as formula text. Plain cells pass through.
function toExportRows(rows) {
  return rows.map((r, i) => r.map((v, c) => cellValueText(i, c)));
}
function exportWithDelim(kind) {
  const delim = kind === "semicolon" ? ";" : kind === "tab" ? "\t" : ",";
  const ext = kind === "tab" ? "tsv" : "csv";
  if (state.rows.length === 0 && state.headers.length === 0) { showToast("Nothing to export", "error"); return; }
  const csv = toCsv(state.headers, toExportRows(state.rows), delim);
  const name = (filenameInput.value.trim() || "untitled").replace(/\.[^.]+$/, "");
  const blob = new Blob([csv + "\n"], { type: kind === "tab" ? "text/tab-separated-values;charset=utf-8" : "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name + "." + ext;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  markSaved();
  showToast(`Exported ${name}.${ext}`);
}
function exportCsv() { exportWithDelim("comma"); }

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

// Expose a small, stable API for Playwright / programmatic tests and the console.
// The UI never calls these — they exist purely for external inspection/driving.
Object.defineProperty(window, "__tabula", {
  configurable: true,
  value: {
    state,
    get sel() { return sel; },
    get active() { return act; },
    setSel, setSelRow, setSelCol, extendSel, clearSel,
    selectWholeGrid, activeCell, isMulti,
    visibleRows,
    render, pushHistory,
    openFilterPanel, closeFilterPanel, applyFilterFromPanel,
    filterSession, filterReadConfig,
    filterConfig, filterPredMatches, filterMatchesCell, hasActiveFilterSet, distinctValues,
    valueCounts,
    // Charts (canvas bar / line / pie)
    chartData, drawChart, openChart, closeChart, showChartOpen, closeChartFloat,
    get chart() { return chart; }, chartTheme,
    copyAsBounds, copyAsMarkdown, copyAsJson, copyAsSql,
    markdownOfBounds, jsonOfBounds, sqlOfBounds,
    // Conditional formatting (rule engine — pure predicate exposed for tests)
    cfApply, cfInRange, cfMatchKind, openCf, closeCf, cfPaintList,
    // Formula engine (pure, testable) + helpers
    evalFormula,
    resolveCell,
    cellDisplayText,
    cellValueText,
    colLetter,
    updateFxBar, commitFxBar, revertFxBar, focusFxBar,
    applyFormatToSelection,
    clearFormatting,
    effectiveFormat,
    applyFmt, updateFmtToolbar, allHave, alignOfSel,
    rowFromY,
    windowBounds,
    computeStats,
    cellNumericInfo,
    typeInfo,
    columnType,
    loadSample,
    fillDown, fillRight, applyCase,
    copySelectionRange, selectedRangeTsv,
    findNext, doReplace, openFind, closeFind,
    addRow, addColumn, deleteRow, deleteColumn,
    duplicateRow, moveRow,
    clearSelectionCells, deleteSelectedRows,
    undo, redo,
  },
  enumerable: true,
});
