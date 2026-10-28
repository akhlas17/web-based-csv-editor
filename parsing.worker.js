/* Web Worker: parses + normalises CSV off the main thread so the tab stays
   responsive no matter the file size. Talks to app.js via a small tagged
   protocol. Kept dependency-free: it reuses the same RFC-4180 parser that
   runs on the main thread as a fallback. */

let parseCsv;

self.onmessage = (e) => {
  const d = e.data || {};
  try {
    if (!parseCsv) parseCsv = makeParser();
    let rows = parseCsv(d.raw);
    while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();

    let headers, data, singleRow;
    if (!rows.length) {
      headers = ["Column 1"];
      data = [[""]];
      singleRow = true;
    } else {
      const maxC = rows.reduce((m, r) => Math.max(m, r.length), 0);
      for (const r of rows) while (r.length < maxC) r.push("");
      if (rows.length === 1) {
        headers = rows[0].map((h, i) => h !== "" ? h : "Column " + (i + 1));
        data = [new Array(headers.length).fill("")];
        singleRow = true;
      } else {
        headers = rows[0].map((h, i) => h !== "" ? h : "Column " + (i + 1));
        data = rows.slice(1);
        singleRow = false;
      }
    }
    self.postMessage({ id: d.id, ok: true, singleRow, headers, data });
  } catch (err) {
    self.postMessage({ id: d.id, ok: false, error: String(err && err.message || err) });
  }
};

function makeParser() {
  return function parse(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    const len = text.length;
    for (let i = 0; i < len; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { inQuotes = false; }
        } else { field += c; }
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\n" || c === "\r") {
          if (c === "\r" && text[i + 1] === "\n") i++;
          row.push(field); field = "";
          rows.push(row); row = [];
        } else { field += c; }
      }
    }
    if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
  };
}
