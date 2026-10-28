// What repeats, and how often. Dailies were already handled (knowledge.dailies); this adds the slower clocks:
// weekly bosses, the once-a-week class quests and monthly chores, so nothing quietly expires unused.
//
// Every entry points at a real script in the Skua library; if the script is missing the entry is skipped,
// so this file can never send a bot after something it cannot actually run.
'use strict';
const fs = require('fs');
const path = require('path');
const { P } = require('./paths');
const { serverDay } = require('./util');

// level: what the character needs before it is worth trying. party: how many of our bots should be there.
const RECURRING = [
  // ---- ultras: not here. They run as raids - all four characters in one Ultras-v3 script at once, one boss at a
  // time, from hub.raidTick (ultraready.BOSSES). The old per-character entries (Scripts/Ultras v1) started each
  // character on its own whenever it was free, so the four never met in the same fight. ----

  // ---- daily class clocks (Skua scripts that progress once per server day), until the class is owned ----
  // Lord of Order is in every Ultras-v3 line-up. Its 10 daily quests (7156-7165) do not need 13 LoC (live 2026-09-22:
  // 7156 open to Sable7 with 13 LoC unfinished), so the clock starts now for all four instead of after Farmer Joe.
  // A recurring task pre-empts a long script (brain.preempt) and is never pre-empted itself.
  { id: 'loo-daily', name: 'Lord of Order daily', every: 'day', script: 'Dailies/LordOfOrder.cs', level: 50, party: 1, have: 'Lord of Order' },

  // ---- weekly ----
  // Wheel of Doom (the owner 2026-10-06: "spin the wheel"): non-members get the weekly spin (quest 3076, 3 Gears of Doom;
  // the daily spin 3075 is member-only, CoreDailies.WheelofDoom skips it). The dailies list never ran it: it has no hunt.
  { id: 'wheel-of-doom', name: 'Wheel of Doom spin', every: 'week', script: 'Dailies/WheelofDoom.cs', level: 8, party: 1, needItem: ['Gear of Doom', 3] },

  // ---- monthly ----
  { id: 'monthly-keys', name: 'Monthly Treasure Chest Keys', every: 'month', script: 'Dailies/MonthlyTreasureChestKeys[Mem].cs', level: 1, party: 1, member: true },
];

const has = (script) => { try { fs.accessSync(path.join(P.SCRIPTS, ...script.split('/'))); return true; } catch (e) { return false; } };

// Period keys on the AQW server clock: everything in the same period counts as "already done". Days reset at
// midnight US Eastern (a UTC day made a run at 00:06 UTC, before the 04:00 UTC reset, book the whole day and skip the
// real one - 2026-09-23), and weeklies reset Friday at that midnight ("try again Friday morning", UltraSpeaker.cs).
function periodKey(every, date = new Date()) {
  const day = serverDay(new Date(date));                 // YYYY-MM-DD, server time
  if (every === 'month') return `${Number(day.slice(0, 4))}-${Number(day.slice(5, 7))}`;
  if (every === 'week') {
    const t = new Date(`${day}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 2) % 7));   // back to Friday (Fri = 5 -> 0)
    return `w${t.toISOString().slice(0, 10)}`;
  }
  return day;
}

// Entries this character could do right now: script present, level high enough, not done this period,
// and - for group content - enough of our own characters online and ready.
function due(bot, state, opts = {}) {
  const level = Number(opts.level || 0);
  const online = Number(opts.partySize || 1);
  const member = !!opts.member;
  const done = (state && state.recurring) || {};
  const out = [];
  for (const r0 of RECURRING) {
    const r = r0.daily ? { ...r0, every: 'day' } : r0;
    if (r.member && !member) continue;
    if (!has(r.script)) continue;
    if (level < r.level) continue;
    if (online < (r.party || 1)) continue;
    if (done[r.id] === periodKey(r.every)) continue;
    out.push(r);
  }
  return out;
}

function markDone(state, id, every = 'week') {
  state.recurring = state.recurring || {};
  state.recurring[id] = periodKey(every);
  return state.recurring;
}

// Plain-language summary for the journal, the API and the Discord digest.
function summary(opts = {}) {
  const level = Number(opts.level || 0);
  const ready = RECURRING.filter((r) => has(r.script));
  const reachable = ready.filter((r) => level >= r.level);
  return {
    known: ready.length,
    reachable: reachable.length,
    blocked: ready.length - reachable.length,
    next: reachable.slice(0, 3).map((r) => r.name),
    note: reachable.length ? null : `every weekly boss here needs level ${Math.min(...ready.map((r) => r.level))}+ and a full party`,
  };
}

module.exports = { RECURRING, due, markDone, periodKey, summary, has };
