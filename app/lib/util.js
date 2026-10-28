const fs = require('fs');
const path = require('path');

// SERAPH_TIME_SCALE < 1 speeds up every wait (unit tests run the real bot logic on a fast clock).
const SCALE = Number(process.env.SERAPH_TIME_SCALE || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SCALE));

// A missing or empty file is the fallback. A file that exists but is not JSON used to be the fallback too, silently: a
// corrupted brain.json would have reset every counter without a word. Now it is kept as <file>.corrupt and reported.
function readJson(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  if (!text.trim()) return fallback;
  try { return JSON.parse(text); } catch (e) {
    try { fs.copyFileSync(file, `${file}.corrupt`); } catch { /* read-only */ }
    console.error(`readJson: ${file} is not valid JSON (${e.message}) - kept as ${path.basename(file)}.corrupt, using the default`);
    return fallback;
  }
}

// Atomic write so a crash never leaves a half-written queue or registry.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

// AQW server day: the daily reset is midnight US Eastern time.
function serverDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localDay(date = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${z(date.getMonth() + 1)}-${z(date.getDate())}`;
}

module.exports = { SCALE, sleep, readJson, writeJson, slug, serverDay, localDay };
