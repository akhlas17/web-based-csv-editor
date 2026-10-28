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
- **Edit like a spreadsheet** — click any cell, or use the keyboard:
  - `Enter` / `Space` — start editing the selected cell
  - `Tab` / `Shift+Tab` — edit the next / previous cell
  - `↑` `↓` `←` `→` — move around the grid
  - `Backspace` or `Delete` — delete the selected row
- **Sort** any column (click the column‑header arrows)
- **Search** across all cells, with match highlighting
- **Add / delete** rows and columns
- **Undo / Redo** (`Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`)
- **Autosave** to `localStorage` — revisit the same grid later
- **Export** to a `.csv` file (button, or `Ctrl/Cmd+S`)
- **Big files stay fast** — DOM virtualization keeps the grid responsive at tens
  of thousands of rows, and parsing runs in a Web Worker so the UI never freezes

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
