// Seraph's fixes for Skua library scripts that are broken upstream (script-fixes/fixes.json). Two kinds:
//  - patches: small anchored edits ({find, replace}) applied to whatever the library file is today. A Skua update that
//    leaves the anchors alone keeps the fix working; one that changes them makes the fix fail LOUDLY (hub alert), never
//    silently. (2026-09-26: an unrelated upstream edit to Core13LoC.cs retired the old full-copy fix without a word,
//    and 13 LoC and King's Echo farmed Ryoku for a medal that can't drop for two days.)
//  - copy: a full corrected copy (script-fixes/<library path>), used only while the library file still has the sha256
//    it was written for (`base`). When Skua changes the file the copy retires, and that is reported too.
// refresh() builds the live set in <root>/script-fixes-live: the fixed files plus a fixes.json in the format the
// engine reads (engine/vendor/Skua.Core/SeraphSourceFilter.cs: base = sha256 of today's library file, LF endings).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { P } = require('./paths');

const DIR = path.join(P.APP, 'script-fixes');
const liveDir = () => path.join(P.ROOT, 'script-fixes-live');

let manifest = null;
function fixes() {
  if (!manifest) { try { manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'fixes.json'), 'utf8')); } catch (e) { manifest = {}; } }
  return manifest;
}
function reload(m = null) { manifest = m; }

const norm = (rel) => String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
const lf = (s) => String(s).replace(/\r\n/g, '\n');
const hash = (buf) => crypto.createHash('sha256').update(Buffer.from(lf(buf), 'utf8')).digest('hex');
const count = (hay, needle) => { let n = 0; let i = hay.indexOf(needle); while (i >= 0) { n++; i = hay.indexOf(needle, i + needle.length); } return n; };

// Apply every patch to the LF text. A patch whose `find` does not occur exactly `count` times (default 1) fails.
function applyPatches(text, patches) {
  let out = lf(text);
  const missing = [];
  (patches || []).forEach((p, i) => {
    const find = lf(p.find);
    const want = Number(p.count) || 1;
    const n = count(out, find);
    if (n !== want) { missing.push({ patch: i, found: n, want, anchor: find.split('\n').find((l) => l.trim()) || find }); return; }
    out = out.split(find).join(lf(p.replace));
  });
  return { ok: !missing.length, text: out, missing };
}

// One fix against one library: { rel, status: 'applied'|'failed'|'retired'|'missing', text?, base?, why, detail? }.
function build(rel, fix, scriptsDir = P.SCRIPTS) {
  let lib;
  try { lib = fs.readFileSync(path.join(scriptsDir, ...rel.split('/')), 'utf8'); } catch (e) { return { rel, status: 'missing', why: fix.why }; }
  const base = hash(lib);
  if (Array.isArray(fix.patches)) {
    const r = applyPatches(lib, fix.patches);
    if (!r.ok) return { rel, status: 'failed', base, why: fix.why, detail: r.missing.map((m) => `patch ${m.patch + 1}: anchor found ${m.found}x, want ${m.want} ("${m.anchor.trim().slice(0, 80)}")`).join('; ') };
    return { rel, status: 'applied', base, text: r.text, why: fix.why };
  }
  if (base !== fix.base) return { rel, status: 'retired', base, why: fix.why, detail: 'the library file changed upstream; the full copy no longer matches' };
  let text;
  try { text = fs.readFileSync(path.join(DIR, ...rel.split('/')), 'utf8'); } catch (e) { return { rel, status: 'missing', why: fix.why }; }
  return { rel, status: 'applied', base, text, why: fix.why };
}

// Build every fix against the current library into the live folder the engine reads. Returns the per-fix results.
function refresh({ scriptsDir = P.SCRIPTS, out = liveDir() } = {}) {
  const results = Object.entries(fixes()).map(([rel, fix]) => build(norm(rel), fix, scriptsDir));
  const live = {};
  fs.mkdirSync(out, { recursive: true });
  for (const r of results) {
    if (r.status !== 'applied') continue;
    const file = path.join(out, ...r.rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, r.text);
    fs.renameSync(tmp, file);
    live[r.rel] = { base: r.base, why: r.why };
  }
  const tmp = path.join(out, 'fixes.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(live, null, 2));
  fs.renameSync(tmp, path.join(out, 'fixes.json'));
  liveManifest = null;
  return results.map(({ text, ...r }) => r);
}

// Problems worth an alert: a fix that no longer applies or retired. Each is reported once per library version
// (<live>/alerts.json), so a restart does not repeat the same alert.
function problems(results, out = liveDir()) {
  const file = path.join(out, 'alerts.json');
  let said = {};
  try { said = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { said = {}; }
  const fresh = results.filter((r) => (r.status === 'failed' || r.status === 'retired') && said[r.rel] !== r.base);
  for (const r of fresh) said[r.rel] = r.base;
  if (fresh.length) { try { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(file, JSON.stringify(said)); } catch (e) { /* alert again next time */ } }
  return fresh;
}

let liveManifest = null;
function live(out = liveDir()) {
  if (!liveManifest) { try { liveManifest = JSON.parse(fs.readFileSync(path.join(out, 'fixes.json'), 'utf8')); } catch (e) { liveManifest = {}; } }
  return liveManifest;
}

// The folder the engine should read fixes from: the live one once refresh() has run, else the shipped copies.
function engineDir() { return fs.existsSync(path.join(liveDir(), 'fixes.json')) ? liveDir() : DIR; }

// { path, why } for a top-level script with a live fix, { retired|failed: why } when it no longer applies, or null.
function resolve(rel, scriptsDir = P.SCRIPTS) {
  const key = Object.keys(fixes()).find((k) => k.toLowerCase() === norm(rel).toLowerCase());
  if (!key) return null;
  const r = build(norm(key), fixes()[key], scriptsDir);
  if (r.status === 'retired') return { retired: r.why };
  if (r.status === 'failed') return { failed: r.why, detail: r.detail };
  if (r.status !== 'applied') return null;
  // The applied text lives in the live folder (patches) or next to fixes.json (copies).
  const lv = live();
  const file = lv[norm(key)] && lv[norm(key)].base === r.base ? path.join(liveDir(), ...norm(key).split('/')) : Array.isArray(fixes()[key].patches) ? null : path.join(DIR, ...norm(key).split('/'));
  if (file && fs.existsSync(file)) return { path: file, why: r.why };
  // Not built for this library version yet: build it now.
  const out = path.join(liveDir(), ...norm(key).split('/'));
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, r.text); return { path: out, why: r.why }; } catch (e) { return null; }
}

module.exports = { resolve, refresh, problems, build, applyPatches, hash, engineDir, liveDir, reload, DIR };
