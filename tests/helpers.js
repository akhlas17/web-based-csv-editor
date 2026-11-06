// Shared helpers for the Sheetlet test suite. No external deps beyond the
// globally-installed Playwright (resolved once via ./pw.js).
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const pw = require("./pw.js");

const results = [];
let _currentFile = "";
function pass(msg) {
  results.push({ ok: true, msg, file: _currentFile });
  console.log("  PASS " + msg);
}
function fail(msg, extra) {
  results.push({ ok: false, msg, file: _currentFile });
  console.log("  FAIL " + msg + (extra ? "  got=" + extra : ""));
}

function checkAlive(port) {
  return new Promise((resolve) => {
    http.get({ host: "localhost", port, path: "/index.html" }, (res) => resolve(res.statusCode === 200))
      .on("error", () => resolve(false));
  });
}

async function startServer(port = 8123) {
  const proc = spawn("python3", ["-m", "http.server", String(port), "--directory", ROOT], {
    stdio: "ignore",
    env: { ...process.env },
  });
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await checkAlive(port)) return { url: "http://localhost:" + port + "/", port, proc };
  }
  proc.kill("SIGKILL");
  throw new Error("local server did not come up on port " + port);
}

function shutdownServer(server) {
  try { if (server && server.proc && !server.proc.killed) server.proc.kill("SIGKILL"); } catch (_) { /* ignore */ }
}

function summary() {
  const totals = new Map();
  for (const r of results) {
    const t = totals.get(r.file) || { pass: 0, fail: 0 };
    if (r.ok) t.pass++; else t.fail++;
    totals.set(r.file, t);
  }
  console.log("\n" + "=".repeat(56));
  let allPass = true;
  for (const [file, t] of totals) {
    const mark = t.fail === 0 ? "PASS" : "FAIL";
    console.log("  " + mark + "  " + file + "  —  " + t.pass + " passed, " + t.fail + " failed");
    if (t.fail > 0) allPass = false;
  }
  const grandPass = [...totals.values()].reduce((a, t) => a + t.pass, 0);
  const grandFail = [...totals.values()].reduce((a, t) => a + t.fail, 0);
  console.log("=".repeat(56));
  console.log("  " + grandPass + " passed, " + grandFail + " failed");
  console.log("  " + (allPass ? "ALL PASS ✅" : "FAILURES ❌"));
  return allPass;
}

module.exports = Object.assign(
  { pass, fail, startServer, shutdownServer, summary, results, ROOT, chromium: pw.chromium, pw },
  {
    get currentFile() { return _currentFile; },
    set currentFile(v) { _currentFile = v; },
  }
);
