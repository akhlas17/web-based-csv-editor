// Sheetlet test: Excel (.xlsx) interop — import, type-aware export, round-trip,
// formula resolution, and the real download path.
async function newPage(ctx) {
  const context = await ctx.browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(ctx.url);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
  page._context = context;
  return page;
}

async function test(H, ctx) {
  const page = await newPage(ctx);
  try {
    H.pass("SheetJS (window.XLSX) is present in the page",
      await page.evaluate(() => typeof window.XLSX === "object" && typeof window.XLSX.utils.aoa_to_sheet === "function"));
    H.pass("__sheetlet exposes the Excel API",
      await page.evaluate(() => ["loadFile", "loadExcelFile", "exportAoa", "exportXlsx", "exportCellValue"].every((k) => typeof window.__sheetlet[k] === "function")));
    H.pass("xlsxSupported() === true", await page.evaluate(() => window.__sheetlet.xlsxSupported() === true));

    // Build a workbook in-page (numbers, booleans, text) → File → loadFile().
    const imported = await page.evaluate(async () => {
      const aoa = [
        ["Name", "Qty", "OnSale", "Total"],
        ["Apple", 12, true, 144],
        ["Banana", 30, false, 150],
        ["Cherry", 5, true, 40],
      ];
      const ws = window.XLSX.utils.aoa_to_sheet(aoa);
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, "Fruit");
      const buf = window.XLSX.write(wb, { type: "array", bookType: "xlsx" });
      const bytes = new Uint8Array(buf);
      const file = new File([bytes], "fruit.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      await window.__sheetlet.loadFile(file);
      return { headers: window.__sheetlet.state.headers.slice(), rows: window.__sheetlet.state.rows.map((r) => r.slice()) };
    });
    H.pass("import: headers = Name,Qty,OnSale,Total",
      JSON.stringify(imported.headers) === JSON.stringify(["Name", "Qty", "OnSale", "Total"]), JSON.stringify(imported.headers));
    H.pass("import: 3 data rows, values intact",
      imported.rows.length === 3 && JSON.stringify(imported.rows[0]) === JSON.stringify(["Apple", "12", "true", "144"]),
      JSON.stringify(imported.rows));

    // Type-aware export (numbers / booleans as real JS types, text as strings).
    const aoa = await page.evaluate(() => window.__sheetlet.exportAoa());
    H.pass("exportAoa: header row stays strings", aoa[0].every((x) => typeof x === "string"), JSON.stringify(aoa[0]));
    H.pass("exportAoa: Apple row → string, number, boolean, number",
      aoa[1][0] === "Apple" && typeof aoa[1][1] === "number" && aoa[1][1] === 12 &&
      typeof aoa[1][2] === "boolean" && aoa[1][2] === true &&
      typeof aoa[1][3] === "number" && aoa[1][3] === 144,
      aoa[1].map((x) => typeof x + ":" + x).join(","));
    H.pass("exportAoa: Banana row → 30 / false / 150",
      aoa[2][1] === 30 && aoa[2][2] === false && aoa[2][3] === 150,
      aoa[2].map((x) => typeof x + ":" + x).join(","));

    // Round-trip: export → xlsx buffer → read back natively.
    const roundtrip = await page.evaluate(() => {
      const aoa = window.__sheetlet.exportAoa();
      const ws = window.XLSX.utils.aoa_to_sheet(aoa);
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, "Fruit");
      const buf = new Uint8Array(window.XLSX.write(wb, { type: "array", bookType: "xlsx" }));
      const magic = Array.from(buf.slice(0, 4)).map((b) => b.toString(16)).join("");
      const back = window.XLSX.read(window.XLSX.write(wb, { type: "array", bookType: "xlsx" }), { type: "array" });
      const bAoa = window.XLSX.utils.sheet_to_json(back.Sheets[back.SheetNames[0]], { header: 1, raw: true, defval: "" });
      return { magic, size: buf.length, back: bAoa };
    });
    H.pass("export produces a valid .xlsx (PK/zip magic)", roundtrip.magic === "504b0304", roundtrip.magic);
    H.pass("round-trip read-back preserves types (12/true/144, 30/false/150)",
      roundtrip.back.length === 4 && roundtrip.back[1][1] === 12 && roundtrip.back[1][2] === true &&
      roundtrip.back[1][3] === 144 && roundtrip.back[2][2] === false, JSON.stringify(roundtrip.back));

    // Formula cells resolve to their computed value on export.
    await page.evaluate(() => {
      window.__sheetlet.state.rows[0][3] = "=144+50"; // Apple/Total → should export as 194
    });
    const resolved = await page.evaluate(() => {
      const v = window.__sheetlet.exportCellValue(0, 3);
      return { v, type: typeof v };
    });
    H.pass("formula =144+50 exports as the number 194", resolved.v === 194 && resolved.type === "number",
      resolved.type + ":" + resolved.v);

    // Real download path: exportXlsx() fires a download the browser can capture.
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 5000 }),
      page.evaluate(() => window.__sheetlet.exportXlsx()),
    ]);
    H.pass("exportXlsx triggers a browser download named *.xlsx", /\.xlsx$/i.test(dl.suggestedFilename()), dl.suggestedFilename());
    const path = await dl.path();
    const fs = require("fs");
    const buf = fs.readFileSync(path);
    H.pass("downloaded file has the .xlsx (PK) signature", buf.length > 1000 && buf.slice(0, 4).toString("hex") === "504b0304",
      "size=" + buf.length + " magic=" + buf.slice(0, 4).toString("hex"));
  } finally {
    await page.close().catch(() => {});
    if (page._context) await page._context.close().catch(() => {});
  }
}
module.exports = { test };
