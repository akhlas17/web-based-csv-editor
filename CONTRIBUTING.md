# Contributing

Thanks for looking at Sheetlet. It is deliberately small and dependency‑free, so
we have few rules. The goal is to keep it easy to read, easy to run, and fast.

## How to work on it

1. Fork the repo and clone your fork.
2. Serve the folder locally:

   ```bash
   python3 -m http.server 8000
   # open http://localhost:8000
   ```

3. Make your change and **use it in a real browser.** Since there is no build
   step, the test for any change is: does it do the right thing on screen, and
   does it not slow the grid down on a big file?
4. If you touch parsing, try a file with quoted fields, embedded commas, embedded
   quotes, and CRLF line endings — the parser is hand‑written and these are the
   edges that matter.

## What to add

- Things that make the grid feel faster, safer, or kinder
- Better keyboard handling and accessibility
- More correct **file parsing** (CSV + Excel) and **export**

## What we probably won't merge

 - A build tool (Vite, webpack, TS, React, …) or any *runtime* dependency. SheetJS
   (for Excel `.xlsx` interop) is the only committed third‑party file and it is
   vendored directly into the repo — no `npm install`, no bundler, no lock file.
   If you feel you need anything else, open an issue first and we'll discuss it.
   Tesseract.js (OCR) is a deliberate exception: it's **lazy‑loaded from a CDN
   only on first use**, not a build or runtime dependency, and the app must keep
   working if that download is unavailable.
- Feature bloat — a spreadsheet with tabs, macros, and so on. Keep it a focused
  spreadsheet editor (CSV + Excel in, spreadsheet out).
- Changes that make the file count go up. Prefer editing the existing files.

## Tests

There is no build step to keep green, but there *is* a small browser test suite
in `tests/`. It drives the real app over Playwright (a dev-only tool) and asserts
observable behaviour — editing, undo, the filter panel, Backspace, index‑remap,
Excel, accessibility, the **HTML report** builder, and the **OCR text→table**
heuristic.

```bash
npm i -g playwright && npx playwright install chromium   # once
npm test                                                    # →  node tests/run-tests.cjs
```

## Pull requests

- Keep PRs small and do one thing. Big PRs sit longer.
- Include a short description of **what** changed and **why**.
- Show it working. Since this is a visual tool, a screenshot or a short screen
  recording is more convincing than any test we can run.
- Match the existing code style. No new patterns, helpers, or abstractions unless
  the existing ones don't fit — and if they don't, say so in the PR.

## Tone

Be helpful, and be specific. "This is slow" → "parsing a 2 MB file freezes the
tab for ~4 s; here's a snippet." Concrete, reproducible reports get answered
fast.

Thanks for helping!
