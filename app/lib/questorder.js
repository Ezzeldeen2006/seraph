// Quest requirement order, as the real game client hands it to Skua.
//
// Skua builds Quest.Requirements from `oItems` in the order the JSON lists it, and Story.KillQuest pairs the
// requirements with its monster list BY POSITION. JavaScript always enumerates integer-like keys in ascending order,
// so every getQuests the headless client parsed came out sorted by item ID - on 1,310 of 3,473 multi-item quests
// that is not the game's order. Necro-Putrefaction (9882) wants Lamprey Tentacle (88252) from Vampiric Lamprey and
// Horde's Horn (88251) from Drowned Horde; sorted, Horde's Horn was paired with the Lamprey and never dropped
// (Nova7 and Oren7, 2026-09-21).
//
// Skua's QuestData.json (in the Scripts library) was captured through the real client, so its Requirements order
// is the order every script was written against. An index of the quests whose order is not ascending is built from
// it in a child process (the file is ~20 MB; the headless process runs with a 256 MB heap) and cached in
// <root>/questorder.json. The quest tree is then serialized for Skua in that order; the world model is untouched.
'use strict';
const fs = require('fs');
const path = require('path');

const own = Object.prototype.hasOwnProperty;

// ---------------- building the index (runs in a child process) ----------------
// QuestData.json is Skua's QuestData list: "ID" first, then ..., "AcceptRequirements", "Requirements", "Rewards".
function scan(text) {
  const out = {};
  const quest = /"ID":\s*(\d+),\s*"Slot"/g;
  let m;
  while ((m = quest.exec(text))) {
    const r = text.indexOf('"Requirements"', quest.lastIndex);
    if (r < 0) break;
    const end = text.indexOf('"Rewards"', r);
    const next = text.indexOf('"Slot"', quest.lastIndex);
    if (end < 0 || (next > 0 && next < end)) continue;
    const ids = [];
    const item = /"ItemID":\s*(\d+)/g;
    const part = text.slice(r, end);
    let i;
    while ((i = item.exec(part))) ids.push(Number(i[1]));
    if (ids.length > 1 && ids.some((x, k) => k > 0 && x < ids[k - 1])) out[m[1]] = ids;
  }
  return out;
}

function build(src, dest) {
  const st = fs.statSync(src);
  const quests = scan(fs.readFileSync(src, 'utf8'));
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ src: { size: st.size, mtimeMs: Math.round(st.mtimeMs) }, quests }));
  fs.renameSync(tmp, dest);
  return Object.keys(quests).length;
}

// ---------------- using it ----------------
let index = null;          // { src, quests }
let checkedAt = 0;
let building = null;

function paths() {
  const { P } = require('./paths');
  return { src: path.join(P.SCRIPTS, 'QuestData.json'), dest: path.join(P.ROOT, 'questorder.json') };
}

function fresh(ix, src) {
  try { const st = fs.statSync(src); return !!ix && ix.src && ix.src.size === st.size && ix.src.mtimeMs === Math.round(st.mtimeMs); } catch (e) { return !!ix; }
}

// Load the cached index, and rebuild it in the background when QuestData.json changed (checked every 10 min).
function refresh(log = () => {}) {
  const { src, dest } = paths();
  if (!index) { try { index = JSON.parse(fs.readFileSync(dest, 'utf8')); } catch (e) { index = null; } }
  if (building || !fs.existsSync(src) || fresh(index, src)) return building || Promise.resolve(index);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  building = new Promise((resolve) => {
    require('child_process').execFile(process.execPath, [__filename, '--build', src, dest], { env, windowsHide: true, timeout: 180000 }, (err, stdout) => {
      building = null;
      if (err) { log(`quest order: index build failed: ${String(err.message).split(/\r?\n/)[0]}`); return resolve(index); }
      try { index = JSON.parse(fs.readFileSync(dest, 'utf8')); log(`quest order: ${String(stdout).trim()}`); } catch (e) { log(`quest order: ${e.message}`); }
      resolve(index);
    });
  });
  return building;
}

function orderFor(id) {
  if (Date.now() - checkedAt > 10 * 60000) { checkedAt = Date.now(); refresh(); }
  return index && index.quests ? index.quests[String(id)] || null : null;
}

// One quest as JSON, with oItems in the game's order. Native JSON.stringify does the work; only the oItems of a
// reordered quest is rebuilt and spliced in. (A JSON.stringify replacer did the same at 2.6x the cost, and Skua
// re-reads the whole tree constantly - the laptop's CPU is the scarcest thing Seraph has.)
const done = new WeakMap();   // quest object -> { s: its plain JSON, out: reordered JSON } - most reads repeat
function questJSON(q, id) {
  const s = JSON.stringify(q);
  if (!q || typeof q !== 'object' || !q.oItems || typeof q.oItems !== 'object') return s;
  const order = orderFor(id !== undefined ? id : q.QuestID);
  if (!order) return s;
  const hit = done.get(q);
  if (hit && hit.s === s) return hit.out;
  const items = q.oItems;
  const keys = order.map(String).filter((k) => own.call(items, k));
  if (keys.length < 2) return s;
  for (const k of Object.keys(items)) if (!keys.includes(k)) keys.push(k);
  const parts = [];
  for (const k of keys) { const v = JSON.stringify(items[k]); if (v !== undefined) parts.push(`${JSON.stringify(k)}:${v}`); }
  const nat = `"oItems":${JSON.stringify(items)}`;
  const at = s.indexOf(nat);
  const out = at < 0 ? s : `${s.slice(0, at)}"oItems":{${parts.join(',')}}${s.slice(at + nat.length)}`;
  done.set(q, { s, out });
  return out;
}

// What getGameObject answers for a questTree path: the whole tree ({id: quest}) or one quest.
function json(v) {
  if (v === undefined) return null;
  try {
    if (v && typeof v === 'object' && !Array.isArray(v) && !v.oItems) {
      const parts = [];
      for (const id of Object.keys(v)) { const s = questJSON(v[id], id); if (s !== undefined) parts.push(`${JSON.stringify(id)}:${s}`); }
      return `{${parts.join(',')}}`;
    }
    return questJSON(v);
  } catch (e) { try { return JSON.stringify(v); } catch (e2) { return null; } }
}

// Tests: use this index instead of the file.
function setIndex(quests) { index = { src: null, quests: quests || {} }; checkedAt = Date.now(); }

module.exports = { scan, build, refresh, orderFor, questJSON, json, setIndex };

if (require.main === module && process.argv[2] === '--build') {
  const n = build(process.argv[3], process.argv[4]);
  console.log(`${n} quests whose requirements are not in item-ID order`);
}
