// Runner — no external deps beyond the globally-installed Playwright.
//   node tests/run-tests.cjs
// Each test file exports `async function test(H, ctx)` and reports results
// through H.pass / H.fail. Shared browser + local server are provided here.
const path = require("path");
const { chromium } = require("./pw.js");
const { startServer, shutdownServer, summary } = require("./helpers.js");

const TESTS = [
  "edit-undo.test.cjs",
  "filter-search.test.cjs",
  "backspace.test.cjs",
  "index-remap.test.cjs",
  "excel.test.cjs",
  "a11y.test.cjs",
];

(async () => {
  const server = await startServer(8123);
  const ctx = { url: server.url, browser: null };
  let browser;
  try {
    browser = await chromium.launch();
    ctx.browser = browser;
    for (const file of TESTS) {
      const H = require("./helpers.js");
      H.currentFile = file;
      console.log("\n● " + file);
      try {
        const mod = require(path.join(__dirname, file));
        if (typeof mod.test !== "function") {
          H.fail("no test() export");
          continue;
        }
        await mod.test(H, ctx);
      } catch (e) {
        H.fail("test crashed: " + (e && e.message || e));
      }
    }
    const ok = summary();
    process.exit(ok ? 0 : 1);
  } finally {
    if (browser) await browser.close().catch(() => {});
    shutdownServer(server);
  }
})().catch((e) => {
  console.error("\nRunner error: " + (e && e.stack || e));
  process.exit(1);
});
