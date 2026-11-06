// Sheetlet test: edit / undo / redo — core cell-editing behaviour.
// Contract: test(H, ctx) where ctx = { browser, url }. Open your own pages; close them at the end.
const origRow0Col0 = "Alice Chen"; // sample dataset, first cell
const cellSel = (i, c) => `td.cell[data-ri="${i}"][data-c="${c}"]`;

async function newPage(ctx) {
  const page = await ctx.browser.newPage();
  await page.goto(ctx.url);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(350);
  return page;
}

async function test(H, ctx) {
  // ---- Page A: edit lifecycle ----
  {
    const page = await newPage(ctx);
    try {
      // 1. Double-click a cell to enter edit mode
      await page.dblclick(cellSel(0, 0));
      await page.waitForTimeout(100);
      H.pass("dblclick enters edit mode (editingRow=0, editingCol=0)",
        await page.evaluate(() => window.__sheetlet.state.editingRow === 0 && window.__sheetlet.state.editingCol === 0));

      // 2. Type a value and press Enter → commits
      await page.keyboard.insertText("EDITED");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(100);
      H.pass("Enter commits the cell edit",
        await page.evaluate(() => window.__sheetlet.state.rows[0][0] === "EDITED"));

      // 3. Escape cancels an in-progress edit (value unchanged)
      const before = await page.evaluate(() => window.__sheetlet.state.rows[5][3]);
      await page.dblclick(cellSel(5, 3));
      await page.waitForTimeout(60);
      await page.keyboard.insertText("SHOULD NOT STICK");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(80);
      H.pass("Escape cancels an in-progress edit",
        await page.evaluate((b) => window.__sheetlet.state.rows[5][3] === b, before));
    } finally {
      await page.close().catch(() => {});
    }
  }

  // ---- Page B: undo / redo, fully isolated ----
  {
    const page = await newPage(ctx);
    try {
      await page.dblclick(cellSel(0, 0));
      await page.waitForTimeout(80);
      await page.keyboard.insertText("FIRST");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(80);
      H.pass("committed edit is reflected", await page.evaluate(() => window.__sheetlet.state.rows[0][0] === "FIRST"));

      await page.evaluate(() => window.__sheetlet.undo());
      await page.waitForTimeout(80);
      H.pass("undo reverted the edit",
        await page.evaluate((o) => window.__sheetlet.state.rows[0][0] === o, origRow0Col0));

      await page.evaluate(() => window.__sheetlet.redo());
      await page.waitForTimeout(80);
      H.pass("redo reapplied the edit", await page.evaluate(() => window.__sheetlet.state.rows[0][0] === "FIRST"));

      await page.evaluate(() => window.__sheetlet.undo());
      await page.waitForTimeout(80);
      H.pass("second undo returned to the original",
        await page.evaluate((o) => window.__sheetlet.state.rows[0][0] === o, origRow0Col0));
    } finally {
      await page.close().catch(() => {});
    }
  }
}
module.exports = { test };
