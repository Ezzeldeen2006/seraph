// Crew dailies (the owner 2026-10-25): the pure part - which dailies are crewed, their stages and who goes first.
// The hub side (start, stages, turn-in, rounds) is lib/crewdaily.js; the fight itself is Bot.crewHunt.
'use strict';
const path = require('path');
const { readJson } = require('./util');

const DEFAULTS = {
  dailies: {}, maxRoom: 7, minCrew: 3, stageMaxMin: 20, stageTries: 2, maxRounds: 4, afterResetMin: 10,
  pauseAfterRoundMin: 5, fallbackHours: 14, wallDeaths: 14, stragglerMin: 4, scripts: {}, bosses: {},
};
const cfg = Object.assign({}, DEFAULTS, readJson(path.join(__dirname, 'crew.json'), {}));

const enabled = (name) => !!(cfg.dailies && cfg.dailies[name]);
const names = () => Object.keys(cfg.dailies || {});
// One-off boss rounds (crew.json "bosses", started by hand: POST /crew/boss).
const boss = (name) => (name && name[0] !== '_' && cfg.bosses && cfg.bosses[name]) || null;

// The stages of a daily (an entry of knowledge.dailies()): one per hunt step that farms a quest item. The quest is the
// step's own, or the daily's accept step: its items only drop while the quest is active.
function stagesFor(daily) {
  if (!daily || !Array.isArray(daily.steps)) return [];
  const accept = daily.steps.find((s) => s.kind === 'accept' && s.quest);
  const quest = (accept && accept.quest) || (daily.quests || [])[0] || null;
  return daily.steps.filter((s) => s.kind === 'hunt' && s.map && s.item).map((s) => ({
    map: String(s.map).toLowerCase(), monster: (s.monsters && s.monsters[0]) || '*', item: s.item, qty: Number(s.qty) || 1,
    cell: s.cell || null, pad: s.pad || null, quest: s.quest || quest,
  }));
}

// Who gets the seven places: the owner's main first (his dailies are the reason this exists), then the highest level.
// entries: [{ id, guest, level }]
function rank(entries) {
  return [...entries].sort((a, b) => (Number(!!b.guest) - Number(!!a.guest)) || ((b.level || 0) - (a.level || 0)) || String(a.id).localeCompare(String(b.id)));
}

// The room: the characters that need the daily first (best first), then helpers up to the room limit.
function pickRoom(needy, helpers, max = cfg.maxRoom) {
  const n = rank(needy).slice(0, max);
  const h = rank(helpers).slice(0, Math.max(0, max - n.length));
  return { needy: n, helpers: h, all: [...n, ...h] };
}

// A stage that runs a whole-army script instead of the generic fight (crew.json "scripts", keyed by the boss).
const scriptFor = (stage) => (stage && cfg.scripts && cfg.scripts[stage.monster]) || null;

// The class of every seat for such a script (the owner 2026-10-25: his main plays Legion Revenant; at least one each of the
// "need" classes; everyone else keeps the class they wear - "whatever they want"). members: [{ id, guest, level, classes
// (rank 10), current }]. Rarest class first, so the one character that owns Void Highlord is not spent on StoneCrusher.
// Returns { seats: { id: class }, order: [ids, main first] } or { error }.
function seatPlan(members, sc) {
  const lc = (s) => String(s || '').toLowerCase();
  const owns = (m, cls) => (m.classes || []).some((c) => lc(c) === lc(cls));
  const seats = {};
  if (sc.needMain) {
    const main = members.find((m) => m.guest);
    if (!main) return { error: 'the main must be in the crew' };
    if (!owns(main, sc.needMain)) return { error: `the main has no rank-10 ${sc.needMain}` };
    seats[main.id] = sc.needMain;
  }
  // A class named twice in "need" is wanted twice (Nightmare Carnax: two ArchPaladins).
  const want = (cls) => (sc.need || []).filter((c) => lc(c) === lc(cls)).length;
  const have = (cls) => Object.values(seats).filter((c) => lc(c) === lc(cls)).length >= Math.max(1, want(cls));
  const todo = (sc.need || []).filter((cls) => !have(cls)).sort((a, b) => members.filter((m) => owns(m, a)).length - members.filter((m) => owns(m, b)).length);
  for (const cls of todo) {
    if (have(cls)) continue;
    const cand = members.filter((m) => !seats[m.id] && owns(m, cls));
    if (!cand.length) return { error: `nobody in the crew owns ${cls}` };
    cand.sort((a, b) => (sc.need || []).filter((c) => owns(a, c)).length - (sc.need || []).filter((c) => owns(b, c)).length || (b.level || 0) - (a.level || 0));
    seats[cand[0].id] = cls;
  }
  for (const m of members) if (!seats[m.id]) seats[m.id] = m.current || (m.classes || [])[0] || '';
  const order = rank(members).map((m) => m.id);
  return { seats, order };
}

module.exports = { cfg, enabled, names, boss, stagesFor, rank, pickRoom, scriptFor, seatPlan };
