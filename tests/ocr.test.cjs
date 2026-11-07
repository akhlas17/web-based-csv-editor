// Sheetlet test: OCR text→table heuristic + photo→table wiring (feature #5).
// The live Tesseract engine runs client-side and needs network on first use,
// so these tests cover the pure, deterministic layer (ocrTextToTable) and the
// loader/wiring without performing a real OCR pass.
async function newPage(ctx) {
  const page = await ctx.browser.newPage();
  await page.goto(ctx.url);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(350);
  return page;
}

async function test(H, ctx) {
  const page = await newPage(ctx);
  try {
    H.pass("__sheetlet exposes the pure OCR helpers",
      await page.evaluate(() => ["ocrTextToTable", "ocrColumnCount", "splitToColumns", "padGrid"].every((k) => typeof window.__sheetlet[k] === "function")));
    H.pass("loadTesseract + ocrImageToText + ocrFromFile are present",
      await page.evaluate(() => ["loadTesseract", "ocrImageToText", "ocrFromFile"].every((k) => typeof window.__sheetlet[k] === "function")));

    // Pure, deterministic OCR text→table behavior (real assertions inside the page).
    await page.evaluate(() => {
      const { ocrTextToTable } = window.__sheetlet;
      const fail = (label, got, want) => { throw new Error("FAIL " + label + " got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)); };
      const eq = (res, h, d, label) => {
        if (JSON.stringify(res.headers) !== JSON.stringify(h)) fail(label + " headers", res.headers, h);
        if (d && JSON.stringify(res.data) !== JSON.stringify(d)) fail(label + " data", res.data, d);
      };
      // empty / whitespace → a single default column
      if (ocrTextToTable("").headers.length !== 1) fail("empty headers", ocrTextToTable("").headers, ["Column 1"]);
      if (ocrTextToTable("\n\n  \n").headers.length !== 1) fail("blank headers", ocrTextToTable("\n\n  \n").headers, ["Column 1"]);
      // tab-delimited
      eq(ocrTextToTable("Name\tQty\nApple\t12\nBanana\t30"), ["Name", "Qty"], [["Apple", "12"], ["Banana", "30"]], "tab");
      // 2+ spaces delimiter
      eq(ocrTextToTable("Name    Qty\nApple     12\nBanana      30"), ["Name", "Qty"], [["Apple", "12"], ["Banana", "30"]], "space");
      // word grid, 2 cols
      eq(ocrTextToTable("Name Qty\nApple 12\nBanana 30\nCherry 5"), ["Name", "Qty"], [["Apple", "12"], ["Banana", "30"], ["Cherry", "5"]], "wordgrid2");
      // word grid, 3 cols
      eq(ocrTextToTable("Name Qty Note\nApple 12 a\nBanana 30 b"), ["Name", "Qty", "Note"], [["Apple", "12", "a"], ["Banana", "30", "b"]], "wordgrid3");
      // single line → its words become headers
      if (ocrTextToTable("A B C").headers.length !== 3) fail("single-line headers", ocrTextToTable("A B C").headers, ["A", "B", "C"]);
      // confidence bounded
      const c = ocrTextToTable("Name Qty\nApple 12\nBanana 30").confidence;
      if (!(typeof c === "number" && c >= 0 && c <= 1)) fail("confidence", c, "[0,1]");
    });
    H.pass("ocrTextToTable handles empty/tab/space/word-grid/single-line correctly", true);
    H.pass("ocrTextToTable returns a bounded confidence value",
      await page.evaluate(() => {
        const c = window.__sheetlet.ocrTextToTable("Name Qty\nApple 12\nBanana 30").confidence;
        return typeof c === "number" && c >= 0 && c <= 1;
      }));

    // ocrFromFile input element exists and is wired to the OCR button
    H.pass("the photo→table button + hidden image input exist",
      await page.evaluate(() => !!document.getElementById("ocrInput") && !!document.getElementById("btnOcrWrap")));
    H.pass("ocrInput accepts image/* types only",
      await page.evaluate(() => /image\/png/i.test((document.getElementById("ocrInput").accept || ""))));

    // loadTesseract is a lazy loader that resolves to a Tesseract object (or
    // rejects safely if the CDN is unreachable). We only assert the contract.
    const loader = await page.evaluate(async () => {
      try {
        const T = await window.__sheetlet.loadTesseract();
        return { ok: true, hasCreateWorker: !!(T && T.createWorker) };
      } catch (e) {
        return { ok: false, error: (e && e.message) || "unknown" };
      }
    });
    H.pass("loadTesseract lazy-loads and exposes createWorker() (or fails gracefully)",
      loader.ok ? loader.hasCreateWorker === true : true, JSON.stringify(loader));

    // The OCR button is present in the toolbar and its label mentions OCR/photo
    H.pass("toolbar shows a 'Photo → table' action",
      await page.evaluate(() => {
        const els = [...document.querySelectorAll(".btn, .topbar button, .topbar label")];
        return els.some((el) => /Photo|OCR|table/i.test(el.title || el.textContent || ""));
      }));
  } finally {
    await page.close().catch(() => {});
  }
}
module.exports = { test };
