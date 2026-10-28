// Ways to get an item (dashboard "Get an item", the owner 2026-10-07: "make them farm anything i choose ... make it
// flexible"). Reads the Skua library on demand - it is not kept in memory, the laptop's process is small:
//   - merge-shop scripts that sell it  -> run BuyAllMerge("<item>") (buys only that item, farming its ingredients)
//   - Core library methods that farm it -> run that method (CoreFarms.BloodMoonToken(...)), with its parameters
//   - other scripts that name it        -> run the script
//   - HuntMonster("map", "Monster", "<item>") lines -> a plain hunt Seraph can do itself
// plus the wiki routes for wearables (data/lookbook.json) and the quests that reward it (QuestData).
'use strict';
const fs = require('fs');
const path = require('path');
const { P } = require('./paths');

const SKIP_DIRS = /^(\.git|Cached-Scripts|Templates|Tools|Prototypes|docs|SkuaScriptsGenerator|plugins|Army)$/i;
const CACHE_MS = 10 * 60000;
const cache = new Map();
const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

let catalog = null;
function describe(rel) {
  if (!catalog) {
    catalog = new Map();
    try {
      const list = JSON.parse(fs.readFileSync(path.join(P.SCRIPTS, 'scripts.json'), 'utf8'));
      for (const s of Array.isArray(list) ? list : []) catalog.set(String(s.path || s.filePath || '').replace(/\\/g, '/'), { name: s.name || s.fileName, description: s.description || '' });
    } catch (e) { /* no catalogue: names only */ }
  }
  return catalog.get(rel) || null;
}

async function* scripts(dir, base = dir) {
  let list = [];
  try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const d of list) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { if (!SKIP_DIRS.test(d.name)) yield* scripts(p, base); continue; }
    if (d.name.endsWith('.cs')) yield { file: p, rel: path.relative(base, p).replace(/\\/g, '/') };
  }
}

// The public method a position in the source sits in: [name, params] or null.
function methodAt(src, idx) {
  const re = /public\s+(?:static\s+)?(?:void|bool|int)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
  let m; let last = null;
  while ((m = re.exec(src)) && m.index < idx) last = m;
  return last ? { name: last[1], params: last[2].replace(/\s+/g, ' ').trim() } : null;
}

// Arguments for a method from its parameter list: the quantity for a leading number, the item for a leading string.
function argsFor(params, item, qty) {
  const first = String(params || '').split(',')[0].trim();
  if (/^(int|long)\b/.test(first)) return String(qty || 1);
  if (/^string\b/.test(first)) return JSON.stringify(item);
  return '';
}

async function find(item, { hub = null, bot = null, qty = 1, dir = P.SCRIPTS } = {}) {
  const q = String(item || '').trim();
  if (q.length < 3) return { item: q, ways: [], hunts: [], quests: [], note: 'Type at least 3 letters.' };
  const key = `${dir}|${q.toLowerCase()}`;
  const hit = cache.get(key);
  let found = hit && Date.now() - hit.at < CACHE_MS ? hit.found : null;
  if (!found) {
    const lq = q.toLowerCase();
    const quoted = `"${lq}"`;
    const fq = flat(lq);
    const ways = [];
    const hunts = new Map();
    for await (const { file, rel } of scripts(dir)) {
      const name = path.basename(rel, '.cs');
      const nameHit = fq.length >= 4 && flat(name).includes(fq);
      let src = '';
      try { src = await fs.promises.readFile(file, 'utf8'); } catch (e) { continue; }
      const low = src.toLowerCase();
      const idx = low.indexOf(quoted);
      if (!nameHit && idx < 0) continue;
      let count = 0;
      for (let i = idx; i >= 0 && count < 20; i = low.indexOf(quoted, i + 1)) count++;
      // A monster that drops it, straight from a hunt line: Core.HuntMonster("map", "Monster", "Item", ...)
      const hre = /HuntMonster(?:MapID)?\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/gi;
      let h;
      while ((h = hre.exec(src))) if (h[3].toLowerCase() === lq && !hunts.has(`${h[1]}|${h[2]}`)) hunts.set(`${h[1]}|${h[2]}`, { map: h[1].toLowerCase(), monster: h[2], from: rel });
      const core = /^Core/i.test(name) || rel.startsWith('Core/');
      const merge = /BuyAllMerge\s*\(/.test(src) && /MergeShops?\//i.test(rel);
      const d = describe(rel);
      const real = (v) => (v && v !== 'null' ? v : '');   // scripts.json has "null" for some
      const base = { path: rel, name: real(d && d.name) || name, desc: real(d && d.description) };
      if (merge && idx >= 0) {
        // A merge script lists what the shop sells as Option<bool>("<id>", "<item>", ...); the items it only farms as
        // ingredients appear as case "<item>": labels. Only a product can be bought with BuyAllMerge("<item>").
        const sells = new RegExp(`new\\s+Option<bool>\\(\\s*"\\d+"\\s*,\\s*${quoted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(low);
        if (sells) ways.push({ ...base, kind: 'merge', entry: 'BuyAllMerge', params: 'string buyOnlyThis', args: JSON.stringify(q), why: 'a merge shop sells it: buys only this item and farms what it costs', score: 60 + Math.min(count, 5) });
        continue;
      }
      if (core) {
        if (idx < 0) continue;
        const m = methodAt(src, idx);
        if (!m || /^(ScriptMain|Logger|Unbank|ToBank|AddDrop|EnsureAccept|EnsureComplete)$/.test(m.name)) continue;
        const named = flat(m.name).includes(fq) || fq.includes(flat(m.name));
        ways.push({ ...base, kind: 'method', entry: m.name, params: m.params, args: argsFor(m.params, q, qty), why: `${name}.${m.name}() farms it`, score: (named ? 55 : 25) + Math.min(count, 5) });
        continue;
      }
      ways.push({ ...base, kind: 'script', entry: null, params: '', args: '', why: nameHit ? 'a script named after it' : `the script mentions it${count > 1 ? ` ${count}x` : ''}`, score: (nameHit ? 50 : 10) + Math.min(count, 10) * 2 - rel.split('/').length });
    }
    ways.sort((a, b) => b.score - a.score);
    found = { ways: ways.slice(0, 14), hunts: [...hunts.values()].slice(0, 6) };
    cache.set(key, { at: Date.now(), found });
  }

  // The wiki's routes for something to wear, and the quests that reward it (names only: the scripts do the work).
  let wear = null;
  try {
    const it = require('./fashion').look(q);
    if (it) wear = { name: it.name, slot: it.slot, member: !!it.member, ac: !!it.ac, routes: (it.routes || []).slice(0, 5).map((r) => ({ kind: r.kind, map: r.map || null, monster: r.monster || null, script: r.script || null, quest: r.quest || null, event: r.event || null })) };
  } catch (e) { /* no lookbook */ }
  const quests = [];
  try {
    const lq = q.toLowerCase();
    for (const x of require('./knowledge').quests().values()) {
      if ((x.Rewards || []).some((r) => String(r.sName || r.Name || '').toLowerCase() === lq)) quests.push({ id: x.ID, name: x.Name, member: !!x.Upgrade });
      if (quests.length >= 6) break;
    }
  } catch (e) { /* no quest data */ }
  let have = null;
  if (bot && hub && hub.constructor && hub.constructor.held) have = await hub.constructor.held(bot, q).catch(() => null);
  return { item: q, have, ...found, wear, quests };
}

module.exports = { find, argsFor, methodAt };
