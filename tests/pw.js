// Single, robust resolver for the globally-installed Playwright module.
// Used by helpers.js and (indirectly) every test file so we only search once.
const path = require("path");
const os = require("os");
const fs = require("fs");

function tryRequire(c) {
  try { return require(c); } catch (_) { return null; }
}

function resolve() {
  // 1. Normal resolution (honours NODE_PATH if set).
  let mod = tryRequire("playwright");
  if (mod && mod.chromium) return { mod, chromium: mod.chromium };

  const candidates = [];
  if (process.env.NODE_PATH) candidates.push(...process.env.NODE_PATH.split(path.delimiter));
  const nvmBase = path.join(os.homedir(), ".nvm", "versions", "node");
  if (fs.existsSync(nvmBase)) {
    for (const v of fs.readdirSync(nvmBase).sort().reverse()) {
      candidates.push(path.join(nvmBase, v, "lib", "node_modules"));
    }
  }
  const sysDirs = [
    "/usr/lib/node_modules", "/usr/local/lib/node_modules",
    "/usr/local/share/node_modules",
  ];
  for (const d of sysDirs) if (fs.existsSync(d)) candidates.push(d);

  for (const c of candidates) {
    mod = tryRequire(path.join(c, "playwright"));
    if (mod && mod.chromium) return { mod, chromium: mod.chromium };
  }

  console.error(
    "\nCould not locate Playwright. Install it once (test-runner only, not used by the app):\n" +
      "  npm i -g playwright && npx playwright install chromium\n" +
      "or point NODE_PATH at a node_modules directory that contains 'playwright'.\n"
  );
  process.exit(1);
}

module.exports = resolve();
