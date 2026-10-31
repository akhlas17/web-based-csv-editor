# Tabula

A fast, privacy‑first CSV editor for the browser. Open a file, work on it like a
real spreadsheet, and save it back — no account, no server, no build step.
Everything runs locally in your browser; **your data never leaves your machine**
(the only network request is an optional web font).

```
index.html   →  the page shell
styles.css   →  the design system
app.js       →  all application logic
 parsing.worker.js →  large-file parsing off the main thread
  ```

That's the whole project. No `package.json`, no bundler, no dependencies.

## Keyboard‑driven

Everything you do has a shortcut — and you can bring them all up in‑app with
**`?`** (or the hint in the status bar): arrow navigation, `Shift+Arrow` range
extension, `Enter`/`Tab` commit, `F2` formula‑bar edit, `⌘/Ctrl+C/Z/S/D`,
`⌘/Ctrl+B/I/U` formatting, and more. It's fast even at scale because only the
visible rows are in the DOM.

> **Live demo →** [akhlas17.github.io/web-based-csv-editor](https://akhlas17.github.io/web-based-csv-editor/)
>
> Full key list: **[CHEATSHEET.md](CHEATSHEET.md)** — or press `?` inside the app.

## Look — a native spreadsheet

The interface is built to feel like a real spreadsheet rather than a web widget: a
neutral **grey command bar** up top, a **Excel‑style sheet tab** and a clean
status bar at the bottom, and a spreadsheet grid beneath. The accent is the
familiar **Excel green** on file, selection, and the active sheet — and the whole
chrome reads naturally in both **light and dark** themes (toggle in the top‑right).

## Get started

There is nothing to install. Either open `index.html` directly in your browser,
or serve the folder:

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

Then open a file (or drop it onto the window) and you're editing.

## Features

- **Open** CSV files by picking one, dragging one in, or pasting from the clipboard
- **Edit like a spreadsheet**
  - `Enter` / `Space` — start (or move-edit) the active cell
  - `Tab` / `Shift+Tab` — move to the next / previous cell
  - `↑` `↓` `←` `→` — move the active cell
  - `Shift + ↑↓←→` — extend the selection range from the anchor (like Google Sheets)
  - `Ctrl/Cmd+A` — select the whole grid
  - `Ctrl/Cmd+B` / `I` / `U` — bold / italic / underline the selection
  - `Backspace` / `Delete` — clear the selected cells
  - **Save on blur** — click away, press a key, or move on; the value is never lost
- **Selection engine** — click a cell, row number, or column header; drag to
  multi-select; the whole grid, a row, a column, or any rectangular range
- **Right-click context menu** — a two-pane menu with a left category rail
  (Clipboard · Text · Format · Fill · Sort · Rows · Columns · Freeze) and the items
  for the active category on the right; hover to switch categories or use the
  arrow keys (`←`/`→` category, `↑`/`↓` item, `Enter` run, `Esc` close). The items
  adapt to what you right-click — a cell, a row, or a column header
- **Statistics bar** — live `Σ Sum` / `x̄ Average` / `min` / `max` / `n Count` for
  the selection, with a `Σ more` menu; understands `$`, `%`, `(1,234)` negatives,
  and dates
- **Automatic formatting** (Google-Sheets style): numbers, percentages, currency
  and dates right-align with tabular figures, negatives highlight in red, text
  and booleans align left
- **Manual formatting** — **Bold / Italic / Underline** (toolbar buttons, or
  `Ctrl/Cmd+B/I/U`), **Align** left / center / right, **Word wrap** (tall rows
  for wrapped text), and **Clear formatting** — applied to any selection, all
  in the context menu too, all undo-able and remembered with the file
- **Formulas** — type `=` into any cell (or the formula bar) and compute:
  - **Arithmetic** — `+ - * / ( )`, unary minus, Excel-style trailing `%`
    (`=Salary*0.10`, `=16%*100`)
  - **Functions** — `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT` over a cell, range
    (`A1:B3`), whole column (`C:C`), or a **header-name alias** (`=SUM(Salary)`)
  - **Live recompute** — values update as source cells change; **circular
    references are caught** and show `#CYCLE!`; errors (`#DIV/0!`, `#VALUE!`,
    `#REF!`, `#NAME?`) render right in the grid like Excel
  - **Integrates everywhere** — resolved values drive the grid (right-aligned
    numbers), the statistics bar, sorting, and copy & export (`Ctrl+C` and
    `Ctrl/Cmd+S` yield computed values, not formula text)
  - **Formula bar** — name box (`C3`) + editable input; `Enter` commits,
    `Esc` reverts, `F2` jumps in; clicking another cell commits first, then
    moves (Excel semantics)
- **Auto-filter** — click a column's funnel to open an Excel‑style filter with
  five modes, plus a live match count as you tweak it:
  - **In list** — multi‑select the exact values to keep (with per‑value counts)
  - **Contains / Starts‑with** — case‑insensitive text filters
  - **Is** — exact match · **Is empty** — keep only blank cells
  - Multiple columns combine with **AND**; the status bar shows `Col: kept/total`
    per column, and filtered columns keep their blue funnel on the header
- **Charts** — hit **Chart** (toolbar) over a selection to preview a **Bar**,
  **Line** or **Pie** chart on a live canvas; "Show" pins it in a floating
  panel that **redraws automatically** as you edit the data. One numeric
  column = bars against that column's labels; several columns = one series
  each; formulas resolve to their numbers for the chart
- **Copy as** — `Copy as ▾` turns the selection into **Markdown**
  (`| a | b |` table), **JSON** (array of objects, numbers stay numbers), or
  **SQL** (`INSERT INTO …` statements with proper quote escaping) — all written
  to the clipboard
- **Conditional formatting** — the **Format** button adds highlight rules to a
  selection: **is / is not / greater-than / at-least / less-than / at-most /
  contains / between / top-N / bottom-N / blank**, each with a color swatch.
  First matching rule wins; colors are drawn live as the data changes, and the
  rules are undo-able and remembered with the file
- **Data tools**
  - Fill down (`Ctrl/Cmd+D`) and Fill right (`Ctrl/Cmd+Shift+R`)
  - Case conversion: lowercase / UPPERCASE / Title Case
  - Find & Replace (`Ctrl/Cmd+H`) with match-case and whole-cell options
  - Sort any column by value (numeric or text) — one toggle per header cycles
    **unsorted → A→Z → Z→A** (a small arrow shows the active direction)
  - Per-column **duplicate** and **move up / down**
  - Add / delete rows and columns, insert above/below and left/right
- **Layout** — resizable columns (drag the grip, double‑click to auto‑fit), widths
  remembered per file; sticky header; light & dark themes
- **Freeze panes** — the **Freeze** button pins the top 1 / 2 / 3 / 5 rows so they
  stay visible while the rest of the grid scrolls; right-click any row and choose
  **Freeze rows above** to freeze everything above *that* row (or **Unfreeze** to
  clear it). Frozen rows keep working (edit, select, delete) and the freeze count
  is remembered with the file
- **Move safely** — **Undo / Redo** (`Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`)
- **Autosave** to `localStorage` — revisit the same grid later
- **Export** to `.csv` (button, or `Ctrl/Cmd+S`)
- **Big files stay fast** — DOM virtualization keeps the grid responsive at tens of
  thousands of rows, and parsing runs in a Web Worker so the UI never freezes

## Try it

The app ships with a small sample dataset so you can feel the keyboard flow
immediately. Press `Enter` on any cell, `Tab` through it, sort a column, then hit
`Ctrl/Cmd+S` to download the result as a CSV.

## How it works (and how to extend it)

The app is a single‑page module with no framework and no state library: one
`state` object is the source of truth, and every change calls `render()` to
re‑draw the visible part of the grid. Because of virtualization, only the rows
inside the viewport (plus a small overscan buffer) ever exist in the DOM — that
is what makes large files cheap to scroll.

A few places that are friendly to tinker with:

- `app.js → renderHeader()` / `renderBody()` — the row and column rendering
- `app.js → parseText()` / `parsing.worker.js` — the RFC‑4180 CSV parser
- `styles.css` — a token‑based design system (colors, spacing, fonts via CSS
  custom properties under `:root`)

The app is plain JavaScript, so a browser devtools console is the fastest way to
inspect state while you work. There is no build step to keep green.

## Contributing

We welcome contributions. The bar is simple: **small, focused, working.**
Please read [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up, what we
accept, and how to open a good pull request.

## License

[MIT](LICENSE) — do whatever you want, just keep the attribution.
