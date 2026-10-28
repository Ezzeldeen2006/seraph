// A compact copy of Skua's QuestData.json with only the fields Seraph reads (audit B3, 2026-09-28).
//
// lib/knowledge.js used to keep the whole file parsed: ~20 MB of JSON for 10k quests, most of it item descriptions and
// display fields, inside a process that runs with a 256 MB heap on the laptop. The brain and the bots read a handful
// of fields (slot/value, daily field, level, member flag, requirement and reward names and counts). The copy is built
// in a child process, like lib/questorder.js, and cached in <root>/questindex.json until QuestData.json changes.
'use strict';
const fs = require('fs');
const path = require('path');

const ITEM = ['ItemID', 'ID', 'sName', 'Name', 'iQty', 'Quantity'];
const QUEST = ['ID', 'Slot', 'Value', 'Name', 'Once', 'Field', 'Index', 'Upgrade', 'Level'];
const pick = (o, keys) => { const out = {}; for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) out[k] = o[k]; return out; };
const items = (list) => (Array.isArray(list) ? list.map((r) => pick(r, ITEM)) : []);

function compact(q) {
  const o = pick(q, QUEST);
  if (o.Field === undefined) o.Field = null;
  o.AcceptRequirements = items(q.AcceptRequirements);
  o.Requirements = items(q.Requirements);
  o.Rewards = items(q.Rewards);
  return o;
}

function build(src, dest) {
  const st = fs.statSync(src);
  const list = JSON.parse(fs.readFileSync(src, 'utf8'));
  const quests = (Array.isArray(list) ? list : []).map(compact);
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ src: { size: st.size, mtimeMs: Math.round(st.mtimeMs) }, quests }));
  fs.renameSync(tmp, dest);
  return quests.length;
}

function paths() {
  const { P } = require('./paths');
  return { src: path.join(P.SCRIPTS, 'QuestData.json'), dest: path.join(P.ROOT, 'questindex.json') };
}

function fresh(ix, src) {
  try { const st = fs.statSync(src); return !!ix && !!ix.src && ix.src.size === st.size && ix.src.mtimeMs === Math.round(st.mtimeMs); } catch (e) { return false; }
}

// The compact quest list when it matches today's QuestData.json, else null (the caller reads the full file).
function read() {
  const { src, dest } = paths();
  let ix = null;
  try { ix = JSON.parse(fs.readFileSync(dest, 'utf8')); } catch (e) { return null; }
  return fresh(ix, src) && Array.isArray(ix.quests) ? ix.quests : null;
}

// Rebuild in the background when QuestData.json changed; `onBuilt` runs after a new copy is written.
let building = null;
function refresh(log = () => {}, onBuilt = () => {}) {
  const { src, dest } = paths();
  if (building) return building;
  if (!fs.existsSync(src) || read()) return Promise.resolve(false);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  building = new Promise((resolve) => {
    require('child_process').execFile(process.execPath, [__filename, '--build', src, dest], { env, windowsHide: true, timeout: 180000 }, (err, stdout) => {
      building = null;
      if (err) { log(`quest index: build failed: ${String(err.message).split(/\r?\n/)[0]}`); return resolve(false); }
      log(`quest index: ${String(stdout).trim()}`);
      try { onBuilt(); } catch (e) { /* */ }
      resolve(true);
    });
  });
  return building;
}

module.exports = { compact, build, read, refresh, fresh, paths };

if (require.main === module && process.argv[2] === '--build') {
  const n = build(process.argv[3], process.argv[4]);
  console.log(`${n} quests in the compact index`);
}
