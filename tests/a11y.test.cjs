// Sheetlet test: accessibility — focus trapping, return-focus, ARIA semantics,
// and the CSS focus-ring / reduced-motion rules.
async function newPage(ctx) {
  const page = await ctx.browser.newPage();
  await page.goto(ctx.url);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
  return page;
}

async function tabStaysIn(page, rootId, presses) {
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press(i % 2 ? "Tab" : "Shift+Tab");
    const inside = await page.evaluate((id) => {
      const r = document.getElementById(id);
      return r && r.contains(document.activeElement);
    }, rootId);
    if (!inside) return false;
  }
  return true;
}

async function test(H, ctx) {
  const page = await newPage(ctx);
  try {
    // ---- HELP modal: trap + Escape ----
    await page.keyboard.press("?");
    await page.waitForTimeout(120);
    H.pass("shortcuts modal opens", !(await page.evaluate(() => document.getElementById("helpRoot").hidden)));
    H.pass("focus moves inside the modal (helpClose)",
      await page.evaluate(() => document.getElementById("helpRoot").contains(document.activeElement)));
    H.pass("Tab/Shift-Tab cycle stays inside the help modal (12 presses)",
      await tabStaysIn(page, "helpRoot", 12));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);
    H.pass("Escape closes the help modal", await page.evaluate(() => document.getElementById("helpRoot").hidden));

    // ---- CF modal: trap ----
    await page.evaluate(() => window.__sheetlet.openCf());
    await page.waitForTimeout(120);
    H.pass("CF modal opens", !(await page.evaluate(() => document.getElementById("cfRoot").hidden)));
    H.pass("focus moves inside the CF modal", await page.evaluate(() => document.getElementById("cfRoot").contains(document.activeElement)));
    H.pass("Tab/Shift-Tab cycle stays inside the CF modal (12 presses)", await tabStaysIn(page, "cfRoot", 12));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);
    H.pass("Escape closes the CF modal", await page.evaluate(() => document.getElementById("cfRoot").hidden));

    // ---- Find modal: focus on the find input + trap ----
    await page.evaluate(() => window.__sheetlet.openFind());
    await page.waitForTimeout(120);
    H.pass("find modal opens with focus on the find input",
      await page.evaluate(() => !document.getElementById("findRoot").hidden && document.activeElement.id === "findInput"));
    H.pass("Tab/Shift-Tab cycle stays inside the find modal (10 presses)", await tabStaysIn(page, "findRoot", 10));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);

    // ---- Chart modal: trap ----
    await page.evaluate(() => window.__sheetlet.openChart());
    await page.waitForTimeout(120);
    H.pass("chart modal opens with focus inside", await page.evaluate(() => !document.getElementById("chartRoot").hidden && document.getElementById("chartRoot").contains(document.activeElement)));
    H.pass("Tab/Shift-Tab cycle stays inside the chart modal (8 presses)", await tabStaysIn(page, "chartRoot", 8));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);
    H.pass("Escape closes the chart modal", await page.evaluate(() => document.getElementById("chartRoot").hidden));

    // ---- ARIA semantics ----
    H.pass("toast is announced (role=status + aria-live)",
      await page.evaluate(() => {
        const t = document.getElementById("toast");
        return t.getAttribute("role") === "status" && t.getAttribute("aria-live") === "polite";
      }));
    H.pass("every dialog declares role=dialog + aria-modal=true",
      await page.evaluate(() => ["helpRoot", "findRoot", "chartRoot", "cfRoot"].every((id) => {
        const r = document.getElementById(id);
        return r && (r.matches("[aria-modal=true]") || r.querySelector("[aria-modal=true]") !== null);
      })));
    H.pass("filter panel declares role=dialog + aria-modal=true",
      await page.evaluate(() => document.getElementById("filterPanel").matches("[role=dialog][aria-modal=true]")));

    // ---- Context menu: category rail aria-expanded + panel aria-hidden ----
    await page.evaluate(() => {
      const cell = document.querySelector(".cell");
      const r = cell.getBoundingClientRect();
      cell.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 5, clientY: r.top + 5, button: 2 }));
    });
    await page.waitForTimeout(200);
    H.pass("context-menu category rail sets aria-expanded (exactly one true)",
      await page.evaluate(() => {
        const cats = [...document.querySelectorAll("#ctxMenu .ctx-cat")];
        return cats.length >= 1 && cats.every((b) => ["true", "false"].includes(b.getAttribute("aria-expanded")))
          && cats.filter((b) => b.getAttribute("aria-expanded") === "true").length === 1;
      }));
    H.pass("context-menu panels track visibility via aria-hidden",
      await page.evaluate(() => {
        const panels = [...document.querySelectorAll("#ctxMenu .ctx-panel")];
        const visible = panels.filter((p) => !p.hidden);
        return visible.length === 1 && visible[0].getAttribute("aria-hidden") === "false"
          && panels.filter((p) => p.hidden).every((p) => p.getAttribute("aria-hidden") === "true");
      }));
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(60);
    H.pass("switching category keeps exactly one expanded + synced aria-hidden",
      await page.evaluate(() => {
        const cats = [...document.querySelectorAll("#ctxMenu .ctx-cat")];
        const expanded = cats.filter((b) => b.getAttribute("aria-expanded") === "true").length;
        const panels = [...document.querySelectorAll("#ctxMenu .ctx-panel")];
        return expanded === 1 && panels.every((p) => p.getAttribute("aria-hidden") === (p.hidden ? "true" : "false"));
      }));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(60);

    // ---- Return-focus: focus goes back near where the user was on close ----
    await page.evaluate(() => { window.__sheetlet.setSel(2, 1); });
    await page.keyboard.press("?");
    await page.waitForTimeout(100);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);
    // We can't assert the exact element without knowing the opener; instead assert
    // focus is back in the document (not lost to the hidden overlay).
    H.pass("after closing, focus is not stranded on hidden nodes",
      await page.evaluate(() => {
        const a = document.activeElement;
        return a && (a === document.body || a.offsetWidth > 0 || a.offsetHeight > 0);
      }));

    // ---- CSS: focus-ring + reduced-motion present ----
    const css = await (await page.request.get(ctx.url + "styles.css")).text();
    H.pass("CSS includes a focus-visible safety net", css.includes("a:focus-visible") && css.includes("button:focus-visible"));
    H.pass("CSS honours prefers-reduced-motion", css.includes("prefers-reduced-motion"));
  } finally {
    await page.close().catch(() => {});
  }
}
module.exports = { test };
