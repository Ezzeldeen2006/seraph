// Proven ultra recipes (the owner 2026-10-24: "if we beat an ultra why dont we save the way we beat it so its consistent?
// my only issue with you is that you keep testing until you kill an ultra and then the next day you struggle to kill
// that same ultra boss").
// A win saves the whole way it was won: who sat where, the class, role and comp each played, potions on/off per seat
// (and which ones and the scroll, for a Raid Planner line-up), and a frozen copy of the boss script with the v3
// dependencies that ran it. hub.raidProvenTick replays that recipe first every period, from the frozen copy, so script
// edits made after the win can't change it. A recipe is replaced only when it stops winning: STALE_AFTER lost fights in
// a row make it stale (the owner is told) and the autopilot goes back to its own picks until a win makes a new one. Other
// line-ups that win while a recipe is good are kept as alternates.
//  ~/seraph/raid-recipes.json   { <bossId>: { recipe, alternates: [...], stale } }
//  ~/seraph/proven/<snap>/      frozen IndividualUltras/<boss>.cs + DependenciesUltras/*, installed into the library
//                               as Scripts/SeraphProven/<snap>/ (includes rewritten to point there).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { P } = require('./paths');

const STALE_AFTER = 3;
const LIB_DIR = 'SeraphProven';
const file = () => path.join(P.ROOT, 'raid-recipes.json');
const store = () => path.join(P.ROOT, 'proven');

function load() { try { return JSON.parse(fs.readFileSync(file(), 'utf8')) || {}; } catch (e) { return {}; } }
function save(all) { fs.writeFileSync(file(), JSON.stringify(all, null, 2)); }
function get(bossId) { const e = load()[bossId]; return e && e.recipe ? e : null; }
// The recipe the autopilot replays: there and not stale.
function active(bossId) { const e = get(bossId); return e && !e.stale ? e.recipe : null; }

// What is about to run (hub.beginRaid): the boss file and DependenciesUltras exactly as the library has them now,
// kept in memory until the raid ends. scriptRel: 'SeraphUltras/IndividualUltras/10UltraSpeakerv3.cs'.
function capture(scriptRel, scripts = P.SCRIPTS) {
  try {
    const rel = String(scriptRel || '').replace(/\\/g, '/');
    const m = /^(SeraphUltras|SeraphProven\/[^/]+)\/(IndividualUltras\/[^/]+\.cs)$/.exec(rel);
    if (!m) return null;
    const root = path.join(scripts, m[1]);
    const files = { [m[2]]: fs.readFileSync(path.join(root, m[2]), 'utf8') };
    const deps = path.join(root, 'DependenciesUltras');
    for (const f of fs.readdirSync(deps).filter((x) => x.endsWith('.cs')).sort()) files[`DependenciesUltras/${f}`] = fs.readFileSync(path.join(deps, f), 'utf8');
    // Includes point at the folder the copy came from; normalise to SeraphUltras so a frozen copy of a frozen copy
    // hashes the same as the original.
    const norm = {};
    for (const [k, v] of Object.entries(files)) norm[k] = v.split(`Scripts/${m[1]}/`).join('Scripts/SeraphUltras/');
    const hash = crypto.createHash('sha1');
    for (const k of Object.keys(norm).sort()) hash.update(k).update('\0').update(norm[k]).update('\0');
    return { boss: m[2], files: norm, hash: hash.digest('hex').slice(0, 10) };
  } catch (e) { return null; }
}

// Writes the frozen copy (once per hash) and returns its library path, e.g. 'SeraphProven/ultra-speaker-1a2b3c4d5e/
// IndividualUltras/10UltraSpeakerv3.cs'.
function freeze(bossId, snap) {
  const id = `${bossId}-${snap.hash}`;
  const dir = path.join(store(), id);
  if (!fs.existsSync(path.join(dir, snap.boss))) {
    for (const [rel, text] of Object.entries(snap.files)) {
      const to = path.join(dir, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, text.split('Scripts/SeraphUltras/DependenciesUltras/').join(`Scripts/${LIB_DIR}/${id}/DependenciesUltras/`));
    }
  }
  return `${LIB_DIR}/${id}/${snap.boss}`;
}

// The frozen copies back into the library (a pull or Reset Scripts runs git clean, like SeraphUltras). Returns the
// number of files written.
function installProven(scripts = P.SCRIPTS) {
  if (!scripts || !fs.existsSync(scripts) || !fs.existsSync(store())) return 0;
  let n = 0;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(store())) {
    const to = path.join(scripts, LIB_DIR, path.relative(store(), f));
    const text = fs.readFileSync(f);
    if (fs.existsSync(to) && fs.readFileSync(to).equals(text)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, text);
    n++;
  }
  return n;
}

// The way a raid was won, from the raid record: seats with class, role (the Attempt reports), potions per seat, and
// the plan's potion lists and scrolls when the owner planned it.
function fromRaid(r) {
  const att = new Map();
  for (const a of r.attempts || []) if (a && a.id && a.cls) att.set(a.id, a);
  const planSeat = (id) => (r.plan ? r.plan.seats.find((s) => s.id === id) : null);
  const seats = (r.seats && r.seats.length ? r.seats : r.members.map((id) => ({ id }))).map((s) => {
    const a = att.get(s.id) || {};
    const p = planSeat(s.id);
    return { id: s.id, cls: s.cls || a.cls || '', role: (p && p.role) || a.role || '', potions: !!(r.potionsBy ? r.potionsBy[s.id] : p && p.potions),
      ...(p ? { potionList: p.potionList || [], scroll: p.scroll || '' } : {}) };
  });
  const comp = [...att.values()].map((a) => a.comp).find(Boolean) || '';
  return { boss: r.boss, at: new Date(r.started).toISOString(), minutes: Math.round(((r.endedAt || Date.now()) - r.started) / 60000), seats, comp,
    kind: r.plan ? 'plan' : 'auto', ...(r.plan ? { planKind: r.plan.kind } : {}), withMain: r.withMain || null };
}
const sameLineUp = (a, b) => !!(a && b) && JSON.stringify(a.seats.map((s) => [s.id, s.cls.toLowerCase(), s.role]).sort()) === JSON.stringify(b.seats.map((s) => [s.id, s.cls.toLowerCase(), s.role]).sort());

// A raid ended with the boss dead (won) or not. Returns what changed: 'new' | 'kept' | 'alternate' | 'lost' | 'stale'.
// A replay of the recipe (r.recipe) that wins counts a win for it; any other win becomes the recipe when there is none
// (or it went stale), else an alternate. A replay that loses counts toward stale; other losses don't touch it.
function result(r, won, snap) {
  const all = load();
  const e = all[r.boss] = all[r.boss] || { recipe: null, alternates: [] };
  const now = new Date().toISOString();
  if (won) {
    if (r.recipe && e.recipe && e.recipe.id === r.recipe) {
      e.recipe.wins = (e.recipe.wins || 0) + 1; e.recipe.lossesInRow = 0; e.recipe.lastWin = now;
      // A seeded recipe ran today's script (it had never won with a frozen one): this win freezes what ran.
      if (e.recipe.seeded && snap) { e.recipe.script = freeze(r.boss, snap); e.recipe.scriptHash = snap.hash; e.recipe.seeded = false; }
      save(all); return 'kept';
    }
    const rec = { ...fromRaid(r), id: `${r.boss}-${Date.now()}`, wins: 1, losses: 0, lossesInRow: 0, lastWin: now,
      script: snap ? freeze(r.boss, snap) : null, scriptHash: snap ? snap.hash : null };
    // A seeded recipe never won with its script (lib/recipes.js seed): any real win replaces it.
    if (!e.recipe || e.stale || e.recipe.seeded) { if (e.recipe) e.alternates.unshift(e.recipe); e.recipe = rec; e.stale = null; e.alternates = e.alternates.slice(0, 5); save(all); return 'new'; }
    const alt = e.alternates.find((a) => sameLineUp(a, rec));
    if (alt) { alt.wins = (alt.wins || 0) + 1; alt.lastWin = now; } else e.alternates.unshift(rec);
    e.alternates = e.alternates.slice(0, 5);
    save(all); return 'alternate';
  }
  if (!(r.recipe && e.recipe && e.recipe.id === r.recipe)) return null;
  e.recipe.losses = (e.recipe.losses || 0) + 1;
  e.recipe.lossesInRow = (e.recipe.lossesInRow || 0) + 1;
  e.recipe.lastLoss = now;
  if (e.recipe.lossesInRow >= STALE_AFTER) { e.stale = { at: now, why: `${e.recipe.lossesInRow} lost fights in a row with the proven line-up` }; save(all); return 'stale'; }
  save(all); return 'lost';
}

// Wins from before recipes existed (the raid log's Attempt reports): a recipe for every boss that has none, from its
// latest win with four "kill" reports. The script that ran then is gone, so a seeded recipe freezes nothing: it runs
// the library's current script until its first win freezes that one, and any other win replaces it. Returns the boss
// ids seeded.
function seed(log, bossScripts, potionsFor) {
  const all = load();
  const out = [];
  for (const l of [...(log || [])].reverse()) {
    if (!l || !l.killed || (all[l.boss] && all[l.boss].recipe) || out.includes(l.boss) || !bossScripts[l.boss]) continue;
    const kills = new Map((l.attempts || []).filter((a) => a.outcome === 'kill' && a.cls).map((a) => [a.id, a]));
    if (kills.size !== 4) continue;
    const seats = [...kills.values()].map((a) => ({ id: a.id, cls: a.cls, role: a.role || '', potions: !!potionsFor(l.boss, a.id) }));
    all[l.boss] = { recipe: { boss: l.boss, at: l.at, minutes: l.minutes, seats, comp: [...kills.values()].map((a) => a.comp).find(Boolean) || '', kind: 'auto',
      id: `${l.boss}-seed-${Date.parse(l.at) || 0}`, wins: 1, losses: 0, lossesInRow: 0, lastWin: l.at,
      script: null, scriptHash: null, seeded: true }, alternates: [] };
    out.push(l.boss);
  }
  if (out.length) save(all);
  return out;
}

// Make an alternate the recipe (dashboard), or forget the stale mark.
function promote(bossId, altId) {
  const all = load();
  const e = all[bossId];
  if (!e) return null;
  const i = (e.alternates || []).findIndex((a) => a.id === altId);
  if (i >= 0) { const [a] = e.alternates.splice(i, 1); if (e.recipe) e.alternates.unshift(e.recipe); e.recipe = { ...a, lossesInRow: 0 }; }
  else if (e.recipe && e.recipe.id === altId) e.recipe.lossesInRow = 0;
  else return null;
  e.stale = null;
  save(all);
  return e.recipe;
}

module.exports = { STALE_AFTER, LIB_DIR, load, get, active, capture, freeze, installProven, fromRaid, result, seed, promote };
