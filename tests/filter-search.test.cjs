// Sheetlet test: filter panel — value search, checkbox selection, apply,
// and the matching predicate.
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
    const depts = await page.evaluate(() => {
      const s = window.__sheetlet.state;
      const counts = {};
      for (const r of s.rows) counts[r[1]] = (counts[r[1]] || 0) + 1;
      return { values: Object.keys(counts).sort(), counts, total: s.rows.length };
    });
    H.pass("sample has >=3 distinct department values", depts.values.length >= 3, JSON.stringify(depts.values));

    // ---- 1. Panel opens in values mode ----
    await page.evaluate(() => window.__sheetlet.openFilterPanel(1));
    await page.waitForTimeout(200);
    H.pass("filter panel opens", !(await page.evaluate(() => document.getElementById("filterPanelRoot").hidden)));

    const items = await page.evaluate(() => [...document.querySelectorAll("#filterValuesList .filter-item")].map((el) => ({
      val: el.dataset.val, count: +el.dataset.count, checked: el.querySelector(".fv").checked,
    })));
    H.pass("value list shows every distinct value, checked by default",
      items.length === depts.values.length && items.every((it) => it.checked), JSON.stringify(items));

    // ---- 2. Search narrows the visible list WITHOUT dropping selection ----
    await page.locator("#filterSearch").fill("Eng");
    await page.waitForTimeout(60);
    const after = await page.evaluate(() => ({
      visible: [...document.querySelectorAll("#filterValuesList .filter-item")]
        .filter((el) => !el.classList.contains("hide")).map((el) => el.dataset.val),
      engStillChecked: document.querySelector('.filter-item[data-val="Engineering"] .fv').checked,
      meta: (document.getElementById("filterSearchMeta") || {}).textContent || "",
    }));
    H.pass("search 'Eng' narrows the list to matching values only",
      after.visible.length >= 1 && after.visible.every((v) => v.toLowerCase().includes("eng")),
      JSON.stringify(after.visible));
    H.pass("Engineering stays checked while hidden by search", after.engStillChecked === true);
    H.pass("live meta shows 'showing N of M' as search narrows",
      /showing \d+ of \d+/.test(after.meta) || /no values match/.test(after.meta),
      JSON.stringify(after.meta));

    // ---- 3. Clear search → full list returns ----
    await page.locator("#filterSearch").fill("");
    await page.waitForTimeout(60);
    H.pass("clearing search restores the full list",
      await page.evaluate(() => [...document.querySelectorAll("#filterValuesList .filter-item")].every((el) => !el.classList.contains("hide"))));

    // ---- 4. Uncheck one department, Apply → it is excluded ----
    const exclude = depts.values[1]; // 2nd alphabetically (not the first, to avoid "Design" being excluded)
    const had = depts.counts[exclude];
    await page.evaluate((v) => {
      const el = [...document.querySelectorAll("#filterValuesList .filter-item")].find((x) => x.dataset.val === v);
      el.querySelector(".fv").checked = false;
      el.querySelector(".fv").dispatchEvent(new Event("change", { bubbles: true }));
    }, exclude);
    // Apply and close
    await page.click("#filterPanelApply");
    await page.keyboard.press("Escape"); // close panel if still open
    await page.waitForTimeout(120);

    // Config should be stored in state.filters[1]
    const cfg = await page.evaluate(() => window.__sheetlet.filterConfig(1));
    H.pass("Apply stored a values-allow-list config on column 1",
      cfg && cfg.mode === "values" && Array.isArray(cfg.values) && cfg.values.length > 0,
      JSON.stringify(cfg));
    H.pass("the unchecked dept " + exclude + " is excluded from the allow-list",
      cfg && !(cfg.values || []).includes(exclude), JSON.stringify(cfg && cfg.values));
    H.pass("every other dept is still allowed",
      cfg && depts.values.filter((v) => v !== exclude).every((v) => (cfg.values || []).includes(v)),
      JSON.stringify(cfg && cfg.values));
    H.pass("had >=1 rows of " + exclude + " to hide", had >= 1, "had=" + had);

    // ---- 5. visibleRows() hides only that dept's rows ----
    const vis = await page.evaluate((v) => {
      const s = window.__sheetlet.state;
      const rows = window.__sheetlet.visibleRows();
      const visibleDepts = rows.map((i) => s.rows[i][1]);
      return {
        total: s.rows.length,
        visible: rows.length,
        hiddenCount: s.rows.length - rows.length,
        hiddenHasOnlyExcl: visibleDepts.every((d) => d !== v),
      };
    }, exclude);
    H.pass("visibleRows hides exactly the excluded dept's rows",
      vis.hiddenCount === had && vis.hiddenHasOnlyExcl, JSON.stringify(vis) + " had=" + had);

    // ---- 6. Substring (contains) predicate ----
    const sub = await page.evaluate(() => {
      const rows = window.__sheetlet.state.rows;
      const cfg = { mode: "contains", text: "ing" };
      return {
        matched: rows.filter((r) => window.__sheetlet.filterPredMatches(r[0], cfg)).length,
        expected: rows.filter((r) => r[0].toLowerCase().includes("ing")).length,
        total: rows.length,
      };
    });
    H.pass("substring (contains) predicate matches the same set as plain .includes()",
      sub.matched === sub.expected && sub.expected > 0, JSON.stringify(sub));
  } finally {
    await page.close().catch(() => {});
  }
}
module.exports = { test };
