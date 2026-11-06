// Sheetlet test: index-remap — formatting + conditional-formatting ranges
// follow the data (not old slot indices) through row/column mutations.
async function newPage(ctx) {
  const page = await ctx.browser.newPage();
  await page.goto(ctx.url);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
  return page;
}

async function test(H, ctx) {
  const page = await newPage(ctx);
  try {
    const S = () => page.evaluate(() => window.__sheetlet.state);

    // Setup: 9 sample rows × 5 cols. Apply bold to (1,2) and a CF rule to (2,2).
    await page.evaluate(() => {
      const S = window.__sheetlet;
      S.setSel(1, 2);
      S.applyFormatToSelection({ bold: true }, true);       // silent: don't push history yet
      S.state.cfRules.push({ range: { r1: 2, r2: 2, c1: 2, c2: 2 }, kind: "is", param: "x", style: { bg: "#f00", fg: "#fff" } });
    });
    let fmt = await page.evaluate(() => window.__sheetlet.state.formats);
    let cf = await page.evaluate(() => window.__sheetlet.state.cfRules);
    H.pass("bold format on (1,2) is recorded", !!fmt["1,2"] && fmt["1,2"].bold === true, JSON.stringify(fmt));
    H.pass("CF rule targets (2,2)", cf && cf[0] && cf[0].range.r1 === 2 && cf[0].range.c1 === 2, JSON.stringify(cf));

    // ---- Delete row 0 (remap: old rows 0 → gone; 1 → 0; 2 → 1; …) ----
    await page.evaluate(() => window.__sheetlet.deleteRow(0));
    await page.waitForTimeout(80);
    fmt = await page.evaluate(() => window.__sheetlet.state.formats);
    cf = await page.evaluate(() => window.__sheetlet.state.cfRules);
    H.pass("after delete row 0: bold moves from (1,2) → (0,2)", fmt["0,2"] && fmt["0,2"].bold === true && !fmt["1,2"], JSON.stringify(fmt));
    H.pass("after delete row 0: CF range moves from (2,2) → (1,1)", cf && cf[0].range.r1 === 1 && cf[0].range.c1 === 1, JSON.stringify(cf[0] && cf[0].range));

    // ---- Insert a blank row above old row 0 (new index 0) ----
    await page.evaluate(() => { window.__sheetlet.state.ctx = { r: 0, c: 0 }; window.__sheetlet.insertRowAbove(); });
    await page.waitForTimeout(60);
    fmt = await page.evaluate(() => window.__sheetlet.state.formats);
    cf = await page.evaluate(() => window.__sheetlet.state.cfRules);
    H.pass("after insert above: bold moves (0,2) → (1,2)", fmt["1,2"] && fmt["1,2"].bold === true && !fmt["0,2"], JSON.stringify(fmt));
    H.pass("after insert above: CF moves (1,1) → (2,2)", cf && cf[0].range.r1 === 2 && cf[0].range.c1 === 2, JSON.stringify(cf[0] && cf[0].range));

    // ---- Move the bolded row down one slot (row 1 → 2) ----
    await page.evaluate(() => { window.__sheetlet.state.ctx = { r: 1, c: 0 }; window.__sheetlet.moveRow(1); });
    await page.waitForTimeout(60);
    fmt = await page.evaluate(() => window.__sheetlet.state.formats);
    H.pass("after move down: bold moves (1,2) → (2,2)", fmt["2,2"] && fmt["2,2"].bold === true && !fmt["1,2"], JSON.stringify(fmt));

    // ---- Delete column 0 (all "c" indices shift left by 1) ----
    await page.evaluate(() => window.__sheetlet.deleteColumn(0)); // triggers confirmAction
    await page.waitForTimeout(60);
    // Accept the confirm — the modal is visible now; click Confirm.
    await page.evaluate(() => document.getElementById("modalOk").click());
    await page.waitForTimeout(60);
    fmt = await page.evaluate(() => window.__sheetlet.state.formats);
    cf = await page.evaluate(() => window.__sheetlet.state.cfRules);
    // After delete-row-0, insert-above, move-down: bold is at row 2.  Column 0 was deleted
    // so (c=2) becomes (c=1).
    H.pass("after delete col 0: bold (2,2) → (2,1)", !!fmt["2,1"] && fmt["2,1"].bold === true, JSON.stringify(fmt));
    // CF was at (2,2) before, now (2,1).
    H.pass("after delete col 0: CF (2,2) → (2,1)", cf && cf[0] && cf[0].range.c1 === 1 && cf[0].range.r1 === 2, JSON.stringify(cf[0] && cf[0].range));

    // ---- Delete again a column that was the bold's column (drop the format) ----
    await page.evaluate(() => window.__sheetlet.deleteColumn(1));
    await page.waitForTimeout(60);
    await page.evaluate(() => document.getElementById("modalOk").click());
    await page.waitForTimeout(60);
    fmt = await page.evaluate(() => window.__sheetlet.state.formats);
    cf = await page.evaluate(() => window.__sheetlet.state.cfRules);
    H.pass("after deleting the bold's column: that format entry is dropped", !fmt["2,0"] && !fmt["2,1"], JSON.stringify(fmt));
    H.pass("after deleting the CF's column: CF rule is dropped from state.cfRules", !cf || cf.length === 0, JSON.stringify(cf));

    // ---- Delete the ONLY row (single-row confirm path) ----
    // Reduce to one row first by deleting all others.
    await page.evaluate(async () => {
      const S = window.__sheetlet;
      while (S.state.rows.length > 1) {
        S.deleteRow(0);
        // Accept every confirm that shows up.
        const ok = document.getElementById("modalOk");
        if (ok && !ok.closest("[hidden]") && !document.getElementById("modalRoot").hidden) ok.click();
        await new Promise(r => setTimeout(r, 20));
      }
    });
    await page.waitForTimeout(150);
    const rowCount = await page.evaluate(() => window.__sheetlet.state.rows.length);
    H.pass("delete-to-one-rows leaves exactly 1 row", rowCount === 1, "count=" + rowCount);

    // Deleting the only row uses the single-row path: triggers "Delete the only row?"
    await page.evaluate(() => window.__sheetlet.deleteRow(0));
    await page.waitForTimeout(60);
    await page.evaluate(() => document.getElementById("modalOk").click());
    await page.waitForTimeout(80);
    H.pass("delete last row empties state.rows", await page.evaluate(() => window.__sheetlet.state.rows.length === 0));
    H.pass("after deleting the only row: all CF rules are dropped", await page.evaluate(() => !window.__sheetlet.state.cfRules || window.__sheetlet.state.cfRules.length === 0));
  } finally {
    await page.close().catch(() => {});
  }
}
module.exports = { test };
