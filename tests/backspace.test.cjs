// Sheetlet test: Backspace / Delete behaviour in the grid and — critically —
// that Backspace is NOT swallowed when focus is inside a text input.
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
    // ---- Grid: single cell selected, Backspace clears it ----
    const before = await page.evaluate(() => window.__sheetlet.state.rows[3][3]);
    H.pass("precondition: cell (3,3) has a value", before !== "" && before !== null, JSON.stringify(before));
    await page.evaluate(() => window.__sheetlet.setSel(3, 3));
    await page.waitForTimeout(40);
    // Focus a non-text-input element (the grid scroller), then press Backspace.
    await page.evaluate(() => {
      const scroller = document.querySelector(".scroller");
      scroller.setAttribute("tabindex", "0");
      scroller.focus();
    });
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(80);
    H.pass("Backspace on a grid-selected cell clears it",
      await page.evaluate(() => window.__sheetlet.state.rows[3][3] === ""));

    // ---- Grid: range selected, Delete clears every cell in the range ----
    await page.evaluate(() => {
      const S = window.__sheetlet;
      S.state.rows[1][0] = "X1"; S.state.rows[1][1] = "X2"; S.state.rows[1][2] = "X3";
      S.setSel(1, 0); S.extendSel(1, 2);
    });
    await page.evaluate(() => {
      const s = document.querySelector(".scroller");
      s.setAttribute("tabindex", "0"); s.focus();
    });
    await page.keyboard.press("Delete");
    await page.waitForTimeout(80);
    H.pass("Delete clears every cell in a selected range",
      await page.evaluate(() => {
        const r = window.__sheetlet.state.rows[1];
        return r[0] === "" && r[1] === "" && r[2] === "";
      }));

    // ---- In a text input, Backspace edits the text (not swallowed by the grid) ----
    // Use #search (top bar, always in DOM). Type "ABC" → Backspace → "AB".
    // Also assert the grid's cell (3,3) is NOT cleared by the input's Backspace.
    const gridBefore = await page.evaluate(() => window.__sheetlet.state.rows[3][3]);
    H.pass("grid cell (3,3) is empty before searching (precondition for isolation)",
      gridBefore === "");
    await page.evaluate(() => window.__sheetlet.setSel(3, 3)); // so the grid "wants" to clear it on Backspace
    await page.waitForTimeout(20);
    await page.locator("#search").click();
    await page.keyboard.type("ABC");
    await page.keyboard.press("Backspace");
    const v = await page.locator("#search").inputValue();
    H.pass("Backspace in the search input edits the text (ABC → AB), not swallowed by grid",
      v === "AB", "value=" + JSON.stringify(v));
    // The grid cell must remain whatever it was (Backspace did NOT hit handleGridKey)
    H.pass("grid cell (3,3) is unchanged after Backspace in the search input",
      await page.evaluate((b) => window.__sheetlet.state.rows[3][3] === b, gridBefore));

    // ---- In the find input, Backspace edits the text ----
    const page4 = await ctx.browser.newPage();
    try {
      await page4.goto(ctx.url);
      await page4.waitForLoadState("networkidle");
      await page4.waitForTimeout(150);
      await page4.evaluate(() => window.__sheetlet.openFind());
      await page4.waitForTimeout(120);
      await page4.locator("#findInput").click();
      await page4.keyboard.type("XYZ");
      await page4.keyboard.press("Backspace");
      const v4 = await page4.locator("#findInput").inputValue();
      H.pass("Backspace in the find input edits the text (XYZ → XY)", v4 === "XY", "value=" + JSON.stringify(v4));
    } finally {
      await page4.close().catch(() => {});
    }

    // ---- In the filter-search input (only in DOM while the panel is open) ----
    const page5 = await ctx.browser.newPage();
    try {
      await page5.goto(ctx.url);
      await page5.waitForLoadState("networkidle");
      await page5.waitForTimeout(150);
      await page5.evaluate(() => window.__sheetlet.openFilterPanel(0));
      await page5.waitForTimeout(150);
      await page5.locator("#filterSearch").click();
      await page5.keyboard.type("abc");
      await page5.keyboard.press("Backspace");
      const v5 = await page5.locator("#filterSearch").inputValue();
      H.pass("Backspace in the filter-search input edits the text (abc → ab)", v5 === "ab", "value=" + JSON.stringify(v5));
    } finally {
      await page5.close().catch(() => {});
    }
  } finally {
    await page.close().catch(() => {});
  }
}
module.exports = { test };
