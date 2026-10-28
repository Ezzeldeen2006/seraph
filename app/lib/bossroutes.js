// Second ways to a boss's items (lib/boss-routes.json, the owner 2026-10-20: "if the skua script cant kill nulgath then find
// another way ... get 4 Roentgenium of nulgath and get mortal coil"). Seraph can't change what a Skua script farms from
// outside, so the switch is a file: <account>/skua/seraph-routes.txt ("<boss> <until ms>" lines, SKUA_DIR in the engine),
// read by the Seraph fixes of the scripts that farm those items (script-fixes/fixes.json).
'use strict';
const fs = require('fs');
const path = require('path');

let table = null;
function routes() {
  if (!table) { try { table = JSON.parse(fs.readFileSync(path.join(__dirname, 'boss-routes.json'), 'utf8')); } catch { table = {}; } }
  return table;
}
const lc = (s) => String(s || '').trim().toLowerCase();

// The route for `boss` when `step` (the Skua line the script is on) farms one of its items, or null.
function routeFor(boss, step) {
  const name = Object.keys(routes()).find((k) => k !== '_' && lc(k) === lc(boss));
  if (!name) return null;
  const r = routes()[name];
  const s = lc(step);
  if (!s || !(r.items || []).some((it) => s.includes(lc(it)))) return null;
  return { boss: name, ...r };
}

function file(dir) { return path.join(dir, 'skua', 'seraph-routes.txt'); }

// The bosses switched on for this account (expired lines dropped).
function active(dir, now = Date.now()) {
  let lines = [];
  try { lines = fs.readFileSync(file(dir), 'utf8').split(/\r?\n/); } catch { return {}; }
  const out = {};
  for (const l of lines) {
    const m = /^(.+?)\s+(\d+)\s*$/.exec(l.trim());
    if (m && Number(m[2]) > now) out[m[1]] = Number(m[2]);
  }
  return out;
}

// Switch the route on for `days`; true when it was not on before.
function enable(dir, route, now = Date.now()) {
  const on = active(dir, now);
  const was = !!on[route.boss];
  on[route.boss] = now + (Number(route.days) || 14) * 86400000;
  fs.mkdirSync(path.dirname(file(dir)), { recursive: true });
  fs.writeFileSync(file(dir), Object.entries(on).map(([b, t]) => `${b} ${t}`).join('\n') + '\n');
  return !was;
}

module.exports = { routeFor, active, enable, file, reload: () => { table = null; } };
