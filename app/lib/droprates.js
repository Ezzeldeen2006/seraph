'use strict';
// Farming rare drops (2026-10-13, the owner: "fix the issue with goals getting parked for things that rarely drop ... the
// bots are in a loop and achieving nothing").
// A Skua farm step logs once ('Killing Taro Blademaster for item: "Taro's Manslayer" 0/1') and then kills in silence
// until the drop comes. The watchdog called 30 quiet minutes "stuck", restarted the script (which replays its whole
// prelude) and parked the goal after the second stall: 136 restarts and 29 parks in the week to 10-13, nearly all on
// such steps. The packet logs say Taro's Manslayer needs ~290 Taro kills per drop (Valen: 31 drops in 9,011 kills,
// dry streaks up to ~490), so two half hours (~60 kills) could never be enough.
// Now: kills of the step's own monster are progress until the dry streak (kills since that item last came, per bot)
// passes the item's budget. The budget is learned from every bot's farming: 4x the mean kills per drop (a longer
// streak happens ~2% of the time by bad luck), 300-3000; 400 for an item with fewer than 2 drops seen. Items that
// really never drop (Valen killed Earth Elementals for six hours for one, 2026-09-20) still end - at the budget.
// lib/rare-drops.json may set `kills` for an item by hand. State persists in ~/seraph/droprates.json.
const fs = require('fs');
const path = require('path');

const MIN = 300;
const MAX = 3000;
const DEFAULT = 400;
const FACTOR = 4;

// The item (and monster) a Skua log line farms, or null. Numbers must be present (scriptStepRaw, not scriptStep).
//   (HuntMonster) Killing Taro Blademaster for item: "Taro's Manslayer" 0/1
//   (HuntMonsterMapID) Farming 💎 Asherion Armor (0/1)      (_KillForItem) Farming Weapon Imprint (3/15)
//   (BuyAllMerge) Farming Monster Blood (0/1)                (_MonsterHuntBatch) Farming monster "Gummy Tapeworm" for items: [Cartilage Gathered x9, Dolls Collected x9]
function parseStep(line) {
  const s = String(line || '').replace(/^\[\d\d:\d\d:\d\d\]\s*/, '');
  let m = /Killing (.+?) for item: "?(.+?)"?\s+(\d+)\s*\/\s*(\d+)\s*$/i.exec(s);
  if (m) return done({ monster: clean(m[1]), items: [clean(m[2])], have: Number(m[3]), want: Number(m[4]) });
  m = /Farming monster "(.+?)" for items: \[(.+)\]/i.exec(s);
  if (m) return done({ monster: clean(m[1]), items: m[2].split(/,\s*/).map((x) => clean(x.replace(/\s+x[\d#]+\s*$/i, ''))).filter(Boolean), have: null, want: null });
  m = /Farming\s+(?!reputation\b|monster\s+")(.+?)\s*\((\d+)\s*\/\s*(\d+)\)/i.exec(s);
  if (m) return done({ monster: null, items: [clean(m[1])], have: Number(m[2]), want: Number(m[3]) });
  return null;
  function done(f) {
    if (!f.items.length || !f.items[0]) return null;
    if (f.want !== null && f.want > 0 && f.have >= f.want) return null;   // already has them: not farming
    if (f.monster === '*') f.monster = null;
    return { ...f, line: s.slice(0, 160) };
  }
}
function clean(x) { return String(x || '').replace(/^[^A-Za-z0-9'"]+/, '').replace(/^"|"$/g, '').trim(); }

// Lines that mean the script moved on from its farm step (a new quest, a story check): the farm is over.
function endsFarm(line) {
  return /Doing Quest|Completed Quest|Already Completed|completion check|Bot Started|Script ran for|Bot stopped/i.test(String(line || ''));
}

class DropRates {
  constructor(file, opts = {}) {
    this.file = file;
    this.rareFile = opts.rareFile || path.join(__dirname, 'rare-drops.json');
    this.data = { items: {}, dry: {} };
    try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); this.data = { items: d.items || {}, dry: d.dry || {} }; } catch (e) { /* first run */ }
    this._dirty = false;
    this._savedAt = 0;
  }
  static key(item) { return String(item || '').trim().toLowerCase(); }
  rec(item) { const k = DropRates.key(item); return this.data.items[k] || (this.data.items[k] = { name: String(item).trim(), kills: 0, drops: 0 }); }
  dryOf(bot) { return this.data.dry[bot] || (this.data.dry[bot] = {}); }
  // One kill of the monster farmed for `items` (all the step's items share the kill).
  kill(bot, items) {
    for (const it of items) { this.rec(it).kills++; const d = this.dryOf(bot); const k = DropRates.key(it); d[k] = (d[k] || 0) + 1; }
    this.touch();
  }
  drop(bot, item) {
    const r = this.rec(item);
    r.drops++; r.lastAt = Date.now();
    this.dryOf(bot)[DropRates.key(item)] = 0;
    this.touch();
  }
  dry(bot, item) { return this.dryOf(bot)[DropRates.key(item)] || 0; }
  // A park at the budget gives the next try half a budget, not a whole one and not none.
  parked(bot, item) { const d = this.dryOf(bot); const k = DropRates.key(item); d[k] = Math.floor(this.budget(item) / 2); this.touch(true); }
  rare() {
    if (this._rare === undefined) { try { this._rare = JSON.parse(fs.readFileSync(this.rareFile, 'utf8')).items || {}; } catch (e) { this._rare = {}; } }
    return this._rare;
  }
  budget(item) {
    const k = DropRates.key(item);
    const hand = Object.entries(this.rare()).find(([n]) => n.toLowerCase() === k);
    if (hand && Number(hand[1].kills) > 0) return Number(hand[1].kills);
    const r = this.data.items[k];
    if (!r || r.drops < 2) return DEFAULT;
    return Math.max(MIN, Math.min(MAX, Math.round(FACTOR * r.kills / r.drops)));
  }
  // Mean kills per drop, for the journal ("~290 kills a drop"), or null before 2 drops.
  mean(item) { const r = this.data.items[DropRates.key(item)]; return r && r.drops >= 2 ? Math.round(r.kills / r.drops) : null; }
  touch(now) { this._dirty = true; if (now || Date.now() - this._savedAt > 60000) this.save(); }
  save() {
    if (!this._dirty || !this.file) return;
    this._dirty = false; this._savedAt = Date.now();
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1)); } catch (e) { /* stats only */ }
  }
}

module.exports = { DropRates, parseStep, endsFarm, MIN, MAX, DEFAULT, FACTOR };
