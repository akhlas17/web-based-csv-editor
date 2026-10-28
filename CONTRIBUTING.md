# Contributing

Thanks for looking at Tabula. It is deliberately small and dependency‑free, so
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
- More correct CSV parsing and export

## What we probably won't merge

- New dependencies or a build tool (Vite, webpack, TS, React, …). If you think
  one is truly the right call, open an issue first and we'll discuss it.
- Feature bloat — a spreadsheet with tabs, macros, charts, and so on. Keep it a
  CSV editor.
- Changes that make the file count go up. Prefer editing the four existing files.

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
