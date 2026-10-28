// Help squads (Seraph 5, 2026-10-26). Every help call and escort used to pull EVERY free character: on 10-26 Vexa
// called the whole party 63 times (Azkorath, Malxas, Alteon), each veteran answered ~140 calls a day, and each answer
// stopped its Skua script and gave its engine away - Forge Valiance 166 starts and 0 finishes, Dauntless 164/0,
// Ravenous 122/0 in one day, while 4 of the 8 characters sat idle waiting for an engine at any moment.
// A squad is the right number of helpers at the lowest cost: characters with nothing running first (waiting for an
// engine, idle), work without an engine next, a running Skua script last, the owner's main only when the call escalates.
// At least two strong characters (level 100 or ten levels over the caller) and one support class when there are any.
// A squad that dies or stalls calls everyone (hub.escalateHelp) - "there is nothing 7 people cant kill" still holds,
// the seven just stop coming for bosses three of them kill in seconds.
'use strict';
const path = require('path');
const { P } = require('./paths');
const { readJson, writeJson } = require('./util');
const partycomp = require('./partycomp');

const SIZE = 3;                 // helpers in a squad (the caller makes four, AQW's party)
const ESCORT_SIZE = 3;          // helpers in an escort
const MIN_STRONG = 2;           // ...of them strong, when there are that many
const ESCALATE_DEATHS = 3;      // deaths in the help room with no kill before everyone is called
const ESCALATE_MS = 4 * 60000;  // a squad with no kill after this long calls everyone
const FARM_ESCALATE_DEATHS = 6; // a farm call: deaths since the last kill before everyone is called
const FRESH_MS = 3 * 60000;     // an engine started this recently just paid its start-up: the costliest to stop
const REMEMBER_MS = 7 * 86400000; // a boss that needed everyone starts with everyone for this long

// What stopping this character costs. Lower is cheaper.
//  0 nothing running: waiting for a Skua engine, idle, a wait
//  1 work without an engine (hunts, wishes, escort following) - it picks up where it was
//  3 a running Skua script (the script restarts and the engine goes to the next in line)
//  4 ...that started under FRESH_MS ago
// +3 the owner's main: his own goals, and he takes an engine back the moment he returns
function cost(c) {
  let n;
  if (c.waiting || !c.task || ['idle', 'wait'].includes(c.task)) n = 0;
  else if (c.engine) n = c.heldMs != null && c.heldMs < FRESH_MS ? 4 : 3;
  else n = 1;
  return n + (c.guest ? 3 : 0);
}

const strongFor = (callerLevel) => (c) => (Number(c.level) || 0) >= Math.min(100, (Number(callerLevel) || 0) + 10) || (Number(c.level) || 0) >= 100;

// cands: [{ id, level, waiting, engine, heldMs, task, guest, support, rank }] -> the ids to send, cheapest first.
// opts: { size, callerLevel, callerSupport, cap (helpers the room still takes), minStrong }
function pick(cands, opts = {}) {
  const size = Math.max(0, Math.min(opts.size == null ? SIZE : opts.size, opts.cap == null ? Infinity : opts.cap));
  if (!size) return [];
  const strong = strongFor(opts.callerLevel);
  const order = cands.slice().sort((a, b) => cost(a) - cost(b) || (strong(b) ? 1 : 0) - (strong(a) ? 1 : 0)
    || (Number(b.level) || 0) - (Number(a.level) || 0) || (a.rank ?? 99) - (b.rank ?? 99) || String(a.id).localeCompare(String(b.id)));
  const out = order.slice(0, size);
  const rest = order.slice(size);
  // Strong ones first: swap the costliest weak pick for the cheapest strong one left, until MIN_STRONG.
  const wantStrong = Math.min(opts.minStrong == null ? MIN_STRONG : opts.minStrong, size, order.filter(strong).length);
  for (;;) {
    if (out.filter(strong).length >= wantStrong) break;
    const inIdx = out.map((c, i) => [c, i]).filter(([c]) => !strong(c)).pop();
    const outIdx = rest.findIndex(strong);
    if (!inIdx || outIdx < 0) break;
    out[inIdx[1]] = rest[outIdx];
    rest.splice(outIdx, 1, inIdx[0]);
  }
  // One support class in the party (the owner 2026-10-13), when the caller has none and someone left has one.
  if (!opts.callerSupport && !out.some((c) => c.support)) {
    const sIdx = rest.findIndex((c) => c.support);
    if (sIdx >= 0) {
      // Never trade away one of the strong ones the rule above wanted.
      const swap = out.map((c, i) => [c, i]).reverse().find(([c]) => !strong(c) || out.filter(strong).length > wantStrong);
      if (swap) out[swap[1]] = rest[sIdx];
    }
  }
  return out.map((c) => c.id);
}

// Owns a rank-10 support class (lib/partycomp.js SUPPORT).
function hasSupport(classes) {
  const names = Object.keys(partycomp.SUPPORT).map((n) => n.toLowerCase());
  return (classes || []).some((c) => Number(c.cp) >= partycomp.RANK10_CP && names.includes(String(c.name).toLowerCase()));
}

// What squads learned, kept across restarts: bosses that needed everyone, and how many of ours a room takes.
class SquadBook {
  constructor(file = path.join(P.ROOT, 'squads.json')) {
    this.file = file;
    this.data = readJson(file, null) || {};
    this.data.bosses = this.data.bosses || {};
    this.data.rooms = this.data.rooms || {};
  }
  save() { try { writeJson(this.file, this.data); } catch (e) { /* memory still has it */ } }
  // Start with everyone: this boss needed the whole party lately.
  needsAll(boss, now = Date.now()) {
    const b = this.data.bosses[String(boss || '').toLowerCase()];
    return !!(b && b.full && now - b.at < REMEMBER_MS);
  }
  result(boss, { full, kills, deaths, size }, now = Date.now()) {
    const k = String(boss || '').toLowerCase();
    if (!k) return;
    const old = this.data.bosses[k];
    // A squad that killed it without help clears the mark; a call that escalated and then killed it sets it. A call that
    // escalated and still lost keeps whatever was there (the party wall handles that one).
    if (!full && kills) this.data.bosses[k] = { full: false, at: now, kills, deaths, size };
    else if (full && kills) this.data.bosses[k] = { full: true, at: now, kills, deaths, size };
    else if (!old) return;
    this.save();
  }
  // "Room join failed, destination room is full": `ours` of our characters were in it then. The smallest count seen.
  roomFull(map, ours) {
    const k = String(map || '').toLowerCase();
    const n = Number(ours) || 0;
    if (!k || n < 1) return null;
    const old = this.data.rooms[k];
    if (old && old.cap <= n) { old.at = Date.now(); old.seen = (old.seen || 1) + 1; this.save(); return old.cap; }
    this.data.rooms[k] = { cap: n, at: Date.now(), seen: 1 };
    this.save();
    return n;
  }
  // How many of ours fit in this map's room, or null when nobody has hit the limit.
  cap(map) {
    const r = this.data.rooms[String(map || '').toLowerCase()];
    return r ? r.cap : null;
  }
}

module.exports = { SIZE, ESCORT_SIZE, MIN_STRONG, ESCALATE_DEATHS, ESCALATE_MS, FARM_ESCALATE_DEATHS, FRESH_MS, cost, pick, hasSupport, strongFor, SquadBook };
