// Party line-ups for help calls (the owner, 2026-10-13): "when the party is fighting as a 4 dont make all of them use
// archpaladin make them smart and adapt to the boss like any other party of 4 they will atleast have 1 support and
// 3 dps or 2 supports and 2 dps ... generally as a party it should atleast have 1 support class".
// shape() picks the roles from what the boss does to us; assign() gives every character the best rank-10 class it owns
// for its role, without doubling a class (auras of the same class don't stack) unless nothing else is owned.
'use strict';
const classplan = require('./classplan');

const RANK10_CP = 302500;

// How good a class is in each role, for the classes free players can get (classplan.CLASSES), and the Skua
// AdvancedSkills mode to fight in. Scores only compare classes inside one role.
const SUPPORT = {
  'Lord of Order': { score: 100, mode: 'Base' },
  'Legion Revenant': { score: 90, mode: 'Base' },
  StoneCrusher: { score: 85, mode: 'Supp' },
  "King's Echo": { score: 80, mode: 'Def' },
  ArchPaladin: { score: 75, mode: 'Def' },
  Healer: { score: 30, mode: 'Base' },
};
// Damage scores follow the measured dummy DPS (vault JOURNAL/2026-09-23, Class Hall Testing Dummy, 60 s at each
// class's real haste): CSH 20-30k, KE 22.3k, LR 17.8k, VHL 14.0k, CAV 13.4k, AP 10.0k, VDK ~8.6k, SC 5.4k - score =
// kDPS x 4. The owner 2026-10-17: his main sat in a damage seat as Verus DoomKnight, which this table had first. Classes
// nobody measured stay below the measured ones they were ranked under before. Arcana Invoker (2026-10-19, same dummy,
// combat packets over 8 min, v2 rotation): 24.4k sustained, but ~12k over its first minute while it climbs to The
// World - so it sits just under KE rather than at 97.
const DPS = {
  'Chrono ShadowHunter': { score: 100, mode: 'Base' },
  "King's Echo": { score: 89, mode: 'Base' },
  'Arcana Invoker': { score: 88, mode: 'Solo' },
  'Legion Revenant': { score: 71, mode: 'Base' },
  'Void Highlord': { score: 56, mode: 'Atk' },
  'Chaos Avenger': { score: 54, mode: 'Base' },
  'Dragon of Time': { score: 50, mode: 'Base' },
  ArchPaladin: { score: 40, mode: 'Atk' },
  'Verus DoomKnight': { score: 34, mode: 'Base' },
  'Chaos Slayer': { score: 30, mode: 'Base' },
  'Scarlet Sorceress': { score: 29, mode: 'Base' },
  'Glacial Berserker': { score: 28, mode: 'Base' },
  'Dragonslayer General': { score: 26, mode: 'Base' },
  'DragonSoul Shinobi': { score: 25, mode: 'Base' },
  StoneCrusher: { score: 22, mode: 'Supp' },
  'Blaze Binder': { score: 22, mode: 'Base' },
  'Blood Sorceress': { score: 20, mode: 'Base' },
};
const TABLE = { support: SUPPORT, dps: DPS };
// A second copy of a class is worth this much: support auras don't stack; damage mostly adds up anyway.
const DUPLICATE = { support: 0.6, dps: 0.85 };

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
function lookup(role, name) {
  const t = TABLE[role];
  const k = Object.keys(t).find((c) => norm(c) === norm(name));
  return k ? { name: k, ...t[k] } : null;
}

// Roles for a party of `n` against this boss. boss = { name, hpMax }, fight = { hit, ownHp, dps } (the caller's own
// numbers from headless fightStats), past = { kills, deaths } of the last call for this boss.
function shape(n, boss = {}, fight = {}, past = null) {
  if (n < 2) return { roles: n ? ['dps'] : [], why: 'alone' };
  const setup = classplan.ultraSetup(boss.name);
  if (setup !== classplan.ULTRA_SETUPS.default) {
    const roles = setup.party.map((r) => (r === 'tank' ? 'support' : r)).slice(0, n);
    if (!roles.includes('support')) roles[0] = 'support';
    return { roles, why: `${boss.name}: the usual line-up${setup.note ? ` (${setup.note})` : ''}` };
  }
  const why = [];
  const hitRatio = fight.hit && fight.ownHp ? fight.hit / fight.ownHp : null;
  if (hitRatio !== null && hitRatio >= 0.5) why.push(`it hits for ${Math.round(hitRatio * 100)}% of my HP`);
  const ttkMin = fight.dps && boss.hpMax ? boss.hpMax / (fight.dps * n) / 60 : null;
  if (ttkMin !== null && ttkMin > 4) why.push(`a long fight (~${Math.round(ttkMin)} min for ${n})`);
  if (past && (past.kills === 0 ? past.deaths >= 4 : past.deaths / past.kills > 3)) why.push(`the last call died ${past.deaths}x for ${past.kills} kill(s)`);
  const supports = why.length && n >= 3 ? 2 : 1;
  const roles = [...Array(supports).fill('support'), ...Array(n - supports).fill('dps')];
  return { roles, why: why.length ? `${supports} supports: ${why.join(', ')}` : '1 support, the rest damage' };
}

// Every distinct order of a multiset of roles.
function perms(roles) {
  if (roles.length <= 1) return [roles.slice()];
  const out = []; const seen = new Set();
  roles.forEach((r, i) => {
    if (seen.has(r)) return;
    seen.add(r);
    for (const rest of perms([...roles.slice(0, i), ...roles.slice(i + 1)])) out.push([r, ...rest]);
  });
  return out;
}

// members = [{ id, classes: [{ name, cp }] }] -> { seats: { id: { cls, role, mode, score } }, score }.
function assign(roles, members) {
  const options = members.map((m) => {
    const ranked = (m.classes || []).filter((c) => Number(c.cp) >= RANK10_CP).map((c) => c.name);
    const by = {};
    for (const role of ['support', 'dps']) {
      by[role] = ranked.map((c) => lookup(role, c)).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 4);
    }
    return by;
  });
  let best = null;
  for (const order of perms(roles.slice(0, members.length))) {
    // For this role order, try every mix of each member's top candidates (at most 4^4).
    const lists = members.map((m, i) => (options[i][order[i]].length ? options[i][order[i]] : [null]));
    const walk = (i, used, seats, score) => {
      if (i === members.length) { if (!best || score > best.score) best = { seats: { ...seats }, score }; return; }
      for (const c of lists[i]) {
        if (!c) { walk(i + 1, used, { ...seats, [members[i].id]: null }, score); continue; }
        const s = used.has(c.name) ? c.score * DUPLICATE[order[i]] : c.score;
        const u = new Set(used); u.add(c.name);
        walk(i + 1, u, { ...seats, [members[i].id]: { cls: c.name, role: order[i], mode: c.mode, score: Math.round(s) } }, score + s);
      }
    };
    walk(0, new Set(), {}, 0);
  }
  return best || { seats: {}, score: 0 };
}

// A character joining an open call late: the role the party is short of, then the best class it owns for it.
function lateSeat(roles, seats, member) {
  const have = Object.values(seats).filter(Boolean);
  const supportsWanted = roles.filter((r) => r === 'support').length;
  const role = have.filter((s) => s.role === 'support').length < Math.max(1, supportsWanted) ? 'support' : 'dps';
  const used = new Set(have.map((s) => s.cls));
  const own = (member.classes || []).filter((c) => Number(c.cp) >= RANK10_CP).map((c) => lookup(role, c.name)).filter(Boolean)
    .map((c) => ({ ...c, score: used.has(c.name) ? c.score * DUPLICATE[role] : c.score })).sort((a, b) => b.score - a.score);
  return own.length ? { cls: own[0].name, role, mode: own[0].mode, score: Math.round(own[0].score) } : null;
}

function describe(plan) {
  return Object.entries(plan.seats || {}).map(([id, s]) => (s ? `${id} ${s.cls} (${s.role})` : `${id} own class`)).join(', ');
}

module.exports = { SUPPORT, DPS, RANK10_CP, shape, assign, lateSeat, describe, perms };
