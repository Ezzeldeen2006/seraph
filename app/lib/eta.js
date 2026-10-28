// When each character reaches level 100, at the pace it really keeps (overhaul Phase 5, 2026-09-29).
//
// XP left: the rest of the current bar plus every level up to 100. The per-level cost comes from the levelUp packets
// the character has seen (ledger xpTable) or the measured rule: 7.58 M at level 86, +1 M per level (audit 2026-09-28).
// Pace: XP per server day from the ledger (every addGoldExp is counted), the last three full days; until two full
// days exist, the level-ups of the last week (history.jsonl) times the XP of the levels crossed.
'use strict';
const fs = require('fs');
const path = require('path');
const { P } = require('./paths');
const { serverDay } = require('./util');

const XP86 = 7.58e6;
const XP_STEP = 1e6;
const DAY = 86400000;

// intExpToLevel seen in levelUp packets on the laptop (baseline 2026-09-29): about +6 % a level up to 85, then +1 M.
const MEASURED = { 79: 4.69e6, 80: 4.98e6, 81: 5.28e6, 82: 5.59e6, 83: 5.91e6, 84: 6.24e6, 85: 6.58e6, 86: 7.58e6, 87: 8.58e6, 88: 9.58e6, 89: 10.58e6, 90: 11.58e6 };
function xpToLevel(lvl, table = {}) {
  const known = Number(table[lvl]) || MEASURED[lvl];
  if (known > 0) return known;
  if (lvl >= 86) return XP86 + (lvl - 86) * XP_STEP;
  return Math.round(MEASURED[79] * Math.pow(0.94, 79 - lvl));
}

// XP from (level, exp) to level 100.
function remaining(level, exp, expTo, table = {}) {
  level = Number(level) || 0;
  if (!level || level >= 100) return 0;
  let r = Math.max(0, (Number(expTo) || xpToLevel(level, table)) - (Number(exp) || 0));
  for (let L = level + 1; L < 100; L++) r += xpToLevel(L, table);
  return r;
}

// XP per day: the ledger's full server days (last three), else the week's level-ups.
function pace(xpDays = {}, levels = [], table = {}, now = Date.now()) {
  const today = serverDay(new Date(now));
  const full = Object.keys(xpDays).filter((d) => d < today).sort().slice(-3);
  if (full.length >= 2) {
    const sum = full.reduce((a, d) => a + Number(xpDays[d] || 0), 0);
    return { perDay: Math.round(sum / full.length), source: `XP of the last ${full.length} days` };
  }
  const recent = levels.filter((l) => now - l.t < 7 * DAY).sort((a, b) => a.t - b.t);
  if (recent.length >= 2) {
    const span = recent[recent.length - 1].t - recent[0].t;
    let xp = 0;
    for (let i = 1; i < recent.length; i++) xp += xpToLevel(Number(recent[i].level) - 1, table);
    if (span > 6 * 3600000 && xp > 0) return { perDay: Math.round((xp / span) * DAY), source: `${recent.length - 1} level-up${recent.length === 2 ? '' : 's'} this week` };
  }
  const t = Number(xpDays[today] || 0);
  return t > 0 ? { perDay: null, source: 'not enough history yet', today: t } : { perDay: null, source: 'no history yet' };
}

// Level-ups from history.jsonl, cached 10 min (the dashboard asks every 20 s).
const HIST = new Map();
function levelHistory(botId, now = Date.now()) {
  const c = HIST.get(botId);
  if (c && now - c.at < 600000) return c.data;
  const file = path.join(P.account(botId), 'history.jsonl');
  const out = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.includes('"level"')) continue;
      try { const r = JSON.parse(line); if (r.type === 'level') out.push({ t: r.t, level: r.level }); } catch (e) { /* torn line */ }
    }
  } catch (e) { /* no history */ }
  HIST.set(botId, { at: now, data: out });
  return out;
}

// { level, exp, left, perDay, days, at, source, boostNote } for one character (null values when unknown).
async function forBot(bot, hub = null, now = Date.now()) {
  const s = await bot.status().catch(() => ({}));
  const L = bot.ledger && bot.ledger.data ? bot.ledger.data : {};
  const table = L.xpTable || {};
  const level = Number(s.level) || 0;
  const left = remaining(level, s.exp, s.expTo, table);
  const p = pace(L.xpDays || {}, levelHistory(bot.id), table, now);
  const out = { level, exp: s.exp || 0, left, perDay: p.perDay, source: p.source, days: null, at: null };
  if (level >= 100) { out.days = 0; return out; }
  if (p.perDay > 0) {
    out.days = Math.round((left / p.perDay) * 10) / 10;
    out.at = new Date(now + (left / p.perDay) * DAY).toISOString().slice(0, 10);
  }
  // A double-XP day ahead (Artix calendar): a day of grinding that counts twice.
  const b = hub && hub.boosts && hub.boosts.summary ? hub.boosts.summary() : null;
  const exp2 = b && (b.upcoming || []).find((u) => u.boost && /exp/i.test(`${u.title} ${(u.kinds || []).join(' ')}`));
  if (exp2) out.boostNote = `2x XP: ${exp2.title} (${exp2.date})`;
  return out;
}

const m = (n) => `${Math.round(n / 1e5) / 10} M`;
function line(e) {
  if (!e || !e.level) return 'level 100: unknown (offline)';
  if (e.level >= 100) return 'level 100: done';
  if (!e.perDay) return `level 100: ${m(e.left)} XP to go (${e.source})`;
  return `level 100: ${m(e.left)} XP to go at ${m(e.perDay)}/day (${e.source}) → ~${e.days} days, ${e.at}${e.boostNote ? ` · ${e.boostNote}` : ''}`;
}

module.exports = { xpToLevel, remaining, pace, forBot, line, levelHistory };
