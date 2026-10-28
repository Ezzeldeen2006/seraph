// Which ultras the party can fight, boss by boss.
//
// The fights run Skua's Ultras-v3 scripts (Scripts/Ultrasv3/IndividualUltras, the owner 2026-09-22: "kill every major
// ultra"). Each script needs four different classes at once - one per character - and v3 hands them out itself
// (UltraCustomClassSync) from what every account owns. So a boss is ready when the four online characters can cover
// its four class slots with four different people.
//
// The owner's hard rules (2026-09-18 / 2026-09-22) still hold on top: everyone level 100 ("you cant make them do ultras
// when they are still under level and will keep dying") and a weapon with at least 30% "all damage" each.
// The old composition rule (Ravenous DPS + Valiance + Awe Blast, before v3) is gone: v3 picks the enhancements
// per class and boss (UltraEnhancements.cs), and its line-ups need King's Echo and Verus DoomKnight, which that rule
// never asked for.
'use strict';
const { parseMeta } = require('./gear');

const WEAPON_MIN = 0.30;
const WEAPON_GOOD = 0.40;
const LEVEL = 100;

const LOO = 'Lord of Order'; const SC = 'StoneCrusher'; const VDK = 'Verus DoomKnight'; const KE = "King's Echo";
const AP = 'ArchPaladin'; const AF = 'ArchFiend'; const SHAMAN = 'Shaman';
const VHL = 'Void Highlord';
const CORE = [[LOO], [SC, 'Infinity Titan'], [VDK], [KE]];
// The three Time Inn ultras also take Void Highlord for the VDK seat and ArchPaladin for King's Echo (Seraph's script
// fix, script-fixes/fixes.json, the owner 2026-10-13: "loo, sc, vhl and ap ... this comp can beat the ultras"). Their
// insignias buy the 51% Exalted Apotheosis, so these are the first bosses the party farms.
const TIME_INN = [[LOO], [SC, 'Infinity Titan'], [VDK, VHL], [KE, AP]];
// Ultra Nulgath with what the party owns (the owner 2026-10-18: learn the mechanics, see how others beat it): two tanky
// taunters (AQWG: AP, CAv, VHL or LR) on Frailty - AP leads, VHL on the "Behold the power of the Abyss" cue - LoO, and
// ArchFiend tapping the Overfiend Blade (AQWHub: AF or VHL in place of DoT). Seraph comps seraph-ap-vhl-loo-af/-sc in
// lib/ultras-comps.json; with VDK + King's Echo owned the slots still fill the core line-up.
const NULGATH = [[LOO], [AF, SC, 'Infinity Titan'], [VDK, VHL], [KE, AP]];
const DAGE_DPS = [AF, 'Chrono ShadowHunter', 'Chrono ShadowSlayer', 'Chaos Avenger', VHL];

// quest = the ultra quest the v3 script turns in (a turn-in during a raid = a kill); every = its reset (the four Time
// Inn / Exaltia ultras are daily quests, the rest weekly). Slot classes are copied from each v3 script's
// UltraClassesByRole (checked 2026-09-22, Scripts 625ac47); StoneCrusher's alternative is the one v3's
// PrerequisitesChecker accepts.
const BOSSES = [
  { id: 'ultra-ezrajal', quest: 8152, every: 'day', name: 'Ultra Ezrajal', script: 'SeraphUltras/IndividualUltras/1UltraEzrajalv3.cs', slots: TIME_INN, chain: true },
  { id: 'ultra-warden', quest: 8153, every: 'day', name: 'Ultra Warden', script: 'SeraphUltras/IndividualUltras/2UltraWardenv3.cs', slots: TIME_INN, chain: true },
  { id: 'ultra-engineer', quest: 8154, every: 'day', name: 'Ultra Engineer', script: 'SeraphUltras/IndividualUltras/3UltraEngineerv3.cs', slots: TIME_INN, chain: true },
  { id: 'ultra-tyndarius', quest: 8245, every: 'day', name: 'Ultra Avatar Tyndarius', script: 'SeraphUltras/IndividualUltras/4UltraAvatarTyndariusv3.cs', slots: CORE },
  { id: 'champion-drakath', quest: 8300, every: 'week', name: 'Champion Drakath', script: 'SeraphUltras/IndividualUltras/5ChampionDrakathv3.cs', slots: [[LOO], [SC, 'Infinity Titan'], [AP], [SHAMAN]], dpsSeat: SC, monster: 'Champion Drakath' },   // v3: three taunters pulse-taunt in turn, StoneCrusher is the DPS
  { id: 'ultra-nulgath', quest: 8692, every: 'week', name: 'Ultra Nulgath', script: 'SeraphUltras/IndividualUltras/6UltraNulgathv3.cs', slots: NULGATH, monster: 'Nulgath the Archfiend' },
  { id: 'ultra-drago', quest: 8397, every: 'week', name: 'Ultra Drago', script: 'SeraphUltras/IndividualUltras/7UltraDragov3.cs', slots: CORE, monster: 'King Drago' },
  { id: 'ultra-darkon', quest: 8746, every: 'week', name: 'Ultra Darkon', script: 'SeraphUltras/IndividualUltras/8UltraDarkonv3.cs', slots: CORE, monster: 'Darkon the Conductor' },
  // Dage's DPS seat is never King's Echo (community bosses sheet: KE 1★ at Dage, vault Research-2026-10-20 item 3);
  // ArchFiend / Chrono ShadowHunter 5★, Chaos Avenger, Void Highlord 4★. tools/vendor-ultras.js widens the script's role.
  { id: 'ultra-dage', quest: 8547, every: 'week', name: 'Ultra Dage', script: 'SeraphUltras/IndividualUltras/9UltraDagev3.cs', slots: [[LOO], [AP], [VDK], DAGE_DPS], monster: 'Dage the Dark Lord' },
  { id: 'ultra-speaker', quest: 9173, every: 'week', name: 'Ultra Speaker', script: 'SeraphUltras/IndividualUltras/10UltraSpeakerv3.cs', slots: [[LOO], [SC, 'Infinity Titan'], [VDK], [AP]], monster: 'The First Speaker', critical: [3] },
  { id: 'ultra-gramiel', quest: 10301, every: 'week', name: 'Ultra Gramiel', script: 'SeraphUltras/IndividualUltras/11UltraGramielv3.cs', slots: [[LOO], [SC, 'Infinity Titan'], [AP], [AF]], monster: 'Gramiel the Graceful' },
];

// The owner's main in one seat (2026-10-22: "if the bots cant do it without LR then make my main help them and make sure
// that everyone gets the quest done"). Per boss: the three bot seats, and the classes the main may play there (the
// first he owns at rank 10). Legion Revenant where the Simplified bosses guide puts LR in the group and Seraph's script
// fixes seat it (tools/vendor-ultras.js SeraphSeatOr: Drakath's third taunter, Drago's and Darkon's VDK taunter,
// Gramiel's right crystal) or a Comp has it (Warden seraph-loo-lr-sc-ap,
// Nulgath seraph-loo-lr-sc-af/-vhl). Void Highlord at Ezrajal and Engineer: the Time Inn line-up that won (LoO, SC, AP, VHL;
// 2026-10-22 his King's Echo there did 4k HP/min and was called off - seraph-loo-sc-ap-ke never won), King's Echo the
// fallback. Verus DoomKnight at
// Dage and Speaker (the scripts' own line-ups): the classes the bots lack there.
const LR = 'Legion Revenant';
const DPS_ANY = [VHL, AF, 'Chrono ShadowHunter', AP];
const SC_SEAT = [SC, 'Infinity Titan'];
const WITH_MAIN = {
  'ultra-ezrajal': { slots: [[LOO], SC_SEAT, [AP]], main: [VHL, KE] },
  'ultra-warden': { slots: [[LOO], SC_SEAT, [AP]], main: [LR] },
  'ultra-engineer': { slots: [[LOO], SC_SEAT, [AP]], main: [VHL, KE] },
  // Tyndarius: upstream's loo-sc-ap-ke (the fork's 91 s kill: SC + KE taunt one orb each, AP + LoO loop-taunt
  // Tyndarius). 2026-10-22 the LR/VHL variant wiped 7x at 87-100 %: nobody taunted the right orb.
  'ultra-tyndarius': { slots: [[LOO], SC_SEAT, [AP]], main: [LR, KE] },   // The owner 2026-10-26: his main is Legion Revenant (left orb), seraph-loo-sc-ap-lr
  'champion-drakath': { slots: [[LOO], SC_SEAT, [AP]], main: [LR] },
  'ultra-nulgath': { slots: [[LOO], [SC], [AF, VHL]], main: [LR] },
  'ultra-drago': { slots: [[LOO], SC_SEAT, [KE, ...DPS_ANY]], main: [LR] },
  'ultra-darkon': { slots: [[LOO], SC_SEAT, [KE, ...DPS_ANY]], main: [LR] },
  'ultra-dage': { slots: [[LOO], [AP], DAGE_DPS], main: [VDK] },
  // The AP is v3's only Listen taunter: a weak one there loses the VDK's Decay to Stasis (assign `critical`).
  'ultra-speaker': { slots: [[LOO], SC_SEAT, [AP]], main: [VDK], critical: [2] },
  'ultra-gramiel': { slots: [[LOO], SC_SEAT, [AP]], main: [LR] },
};

// Who grows into which class, so between them the four cover every line-up above:
//   core (7 bosses): Sable LoO, Valen SC, Nova VDK, Oren KE
//   Speaker: Oren swaps to AP · Dage: Oren AP + Valen VHL (no KE there) · Gramiel: Oren AP + Nova ArchFiend
//   Champion Drakath: Oren AP + Nova Shaman
// First for everyone: the story unlocks for every boss map (ultra-stories). Farmer Joe hands out ArchPaladin, Lord of
// Order, StoneCrusher and ArchFiend on its own route, so the other seat goals (brain 5d2, after Farmer Joe at level
// 100) are the long extras: Verus DoomKnight and King's Echo. Lord of Order's ten dailies run from the schedule
// (loo-daily) from day one.
const SEATS = {
  sable7: { cls: LOO, also: [], goals: ['ultra-stories', 'lord-of-order'] },
  valen7: { cls: SC, also: [AP, VHL], goals: ['ultra-stories', 'stonecrusher', 'archpaladin'] },
  // Shaman (a quick rep class) before the long Verus DoomKnight farm: with it, Champion Drakath (LoO/SC/AP/Shaman) and
  // Gramiel (LoO/SC/AP/ArchFiend) can be fought right after Farmer Joe, weeks before VDK and King's Echo are done.
  nova7: { cls: VDK, also: [AF, SHAMAN], goals: ['ultra-stories', 'shaman', 'verus-doomknight'] },
  oren7: { cls: KE, also: [AP], goals: ['ultra-stories', 'kings-echo', 'archpaladin'] },
  // The second wave (the owner 2026-10-21, vault PARTY/Seven-Party-Plan): each takes one of the classes the first four had
  // to double up on, so a line-up never needs one character to be two classes.
  vexa: { cls: VDK, also: [], goals: ['ultra-stories', 'verus-doomknight'] },
  edda: { cls: KE, also: [], goals: ['ultra-stories', 'kings-echo'] },
  sunna: { cls: LOO, also: [], goals: ['ultra-stories', 'lord-of-order'] },
};
// Every seat also needs a 30%+ all-damage weapon (vault STRATEGY/Weapon-Route, 2026-09-29). Burning Blade of Abezeth
// (30%, the quickest) comes before the seat goals: its damage speeds up every farm after it. Then, after the seat,
// Void Avenger Scythe (40%, recommended), and the long ones (Hollowborn scythe 40%, NSoD and Exalted Apotheosis 51%).
// The brain skips a weapon goal that would not beat the best one the character already has (goal.allDamage).
// What v3 drinks at a raid (UltraPotions.GetRecommendedPotions): the best tonic + elixir for the seat's main stat (STR:
// Might Tonic + Potent Battle Elixir, INT: Sage Tonic + Potent Malevolence Elixir) or a boss's own set (Body / Fate
// Tonic, Unstable Divine / Potent Destruction Elixir), plus Honor (or Malice over 30). It wants 10 of each and brews
// what is short at the start of the raid while the others wait at the rendezvous with no time limit (Valen farmed
// 8 M gold for 2 Battle Elixirs in the first Time Inn raid, 2026-10-13), so the hub checks before it starts one.
const RAID_POTIONS = ['Might Tonic', 'Sage Tonic', 'Potent Battle Elixir', 'Potent Malevolence Elixir', 'Body Tonic', 'Fate Tonic', 'Unstable Divine Elixir', 'Potent Destruction Elixir', 'Potent Honor Potion'];
const RAID_POTION_MIN = 10;
const FIRST_WEAPON = 'burning-blade-of-abezeth';
const WEAPON_GOALS = ['void-avenger-scythe', 'hollowborn-reaper-scythe', 'necrotic-sword-of-doom', 'exalted-apotheosis'];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const ENH_ALIASES = { awe_blast: ['aweblast', 'awe'], valiance: ['valiance'], ravenous: ['ravenous'] };
function hasEnh(unlocked, enh) {
  const want = ENH_ALIASES[String(enh).toLowerCase()] || [norm(enh)];
  for (const u of unlocked || []) if (want.includes(norm(u))) return true;
  return false;
}

// Highest "all damage" boost among the weapons a character owns (backpack or bank), as a fraction (0.51 = +51%). The
// game writes multipliers ("dmgAll:1.15" = +15%); gear.parseMeta converts them.
function bestAllDamage(items) {
  let best = 0;
  let name = null;
  for (const it of items || []) {
    if (it.sES !== 'Weapon') continue;
    const v = parseMeta(it.sMeta).dmgall || 0;
    if (v > best) { best = v; name = it.sName; }
  }
  return { value: best, name };
}

const owns = (m, cls) => (m.classes || []).some((c) => norm(c) === norm(cls));
const planned = (id) => SEATS[String(id || '').toLowerCase()];

// Four different members for a boss's four slots, preferring each member's planned class. Backtracking over 4 x 4.
// Returns { seats, gaps } with the fewest uncovered slots; a gap names the class nobody free owns.
// prefer: ids to seat first (the hub's members who still need the turn-in), after the fewest gaps.
// boss.critical: slot indexes a character outside its planned classes (SEATS) must not take when another layout avoids
// it. Ultra Speaker 2026-10-24: Nova (planned VDK) was seated as the AP Listen taunter for her turn-in, died 16 / 10
// times in a fight, the Listen went untaunted, its Stasis stunned the VDK and its Decay was lost - three fights lost,
// while Oren in that seat (the one kill) died 0 times.
function assign(boss, members, prefer = null) {
  let best = null;
  const used = new Set();
  const pick = [];
  const want = new Set(prefer || []);
  const critical = new Set(boss.critical || []);
  const isOff = (p) => { const s = planned(p.id); return !s || ![s.cls, ...s.also].some((c) => boss.slots[p.slot].includes(c)); };
  const walk = (i) => {
    if (i === boss.slots.length) {
      const gaps = pick.filter((p) => !p.cls).length;
      const need = -pick.filter((p) => p.cls && want.has(p.id)).length;
      const crit = pick.filter((p) => critical.has(p.slot) && isOff(p)).length;
      const off = pick.filter(isOff).length;
      const better = !best || gaps < best.gaps || (gaps === best.gaps && (need < best.need || (need === best.need
        && (crit < best.crit || (crit === best.crit && off < best.off)))));
      if (better) best = { gaps, need, crit, off, seats: pick.map((p) => ({ ...p })) };
      return;
    }
    for (const m of members) {
      if (used.has(m.id)) continue;
      used.add(m.id);
      pick.push({ slot: i, id: m.id, cls: boss.slots[i].find((c) => owns(m, c)) || null, want: boss.slots[i][0] });
      walk(i + 1);
      pick.pop();
      used.delete(m.id);
    }
  };
  walk(0);
  return best;
}

// members: [{ id, level, classes: [...], enhancements: [...], weapon: {value, name} }]
// Returns the old shape (ready, comp, compName, seats, missing, advice) for the brain, dashboard and Discord, plus
// `bosses`: per boss { ready, seats, missing }. `ready` = at least one boss can be fought.
function check(members) {
  const online = (members || []).filter(Boolean);
  if (online.length < 4) return { ready: false, comp: null, compName: null, missing: [`four characters online (have ${online.length})`], seats: [], bosses: {} };
  // Level and weapon are per character: they decide who may take a seat, not whether anyone may. With seven characters
  // a new level-2 one online must not stop the four level-100s (2026-10-21: Vexa and Edda logging in would have
  // marked all 11 bosses not ready). Only when fewer than four qualify do the others sit in - and show what they lack.
  const unready = {};
  for (const m of online) {
    const why = [];
    if (Number(m.level || 0) < LEVEL) why.push(`${m.id}: level ${LEVEL} (is ${m.level})`);
    const v = m.weapon ? m.weapon.value : 0;
    if (v < WEAPON_MIN) why.push(`${m.id}: a weapon with at least ${WEAPON_MIN * 100}% all damage (has ${Math.round(v * 100)}%)`);
    if (why.length) unready[m.id] = why;
  }
  const fit = online.filter((m) => !unready[m.id]);
  const pool = fit.length >= 4 ? fit : online;
  const common = Object.values(unready).flat();
  const bosses = {};
  for (const b of BOSSES) {
    const a = assign(b, pool);
    const missing = a.seats.flatMap((s) => unready[s.id] || []);
    for (const s of a.seats) if (!s.cls) missing.push(`${s.id}: ${b.slots[s.slot].join(' or ')} for ${b.name}`);
    bosses[b.id] = { name: b.name, script: b.script, quest: b.quest, every: b.every, ready: missing.length === 0, seats: a.seats.map((s) => ({ id: s.id, cls: s.cls || s.want })), missing };
    if (WITH_MAIN[b.id]) bosses[b.id].withMain = withMain(b, fit.length >= 3 ? fit : online, unready);
  }
  const main = bosses['ultra-nulgath'];
  // One line per character and class ("oren7: King's Echo (8 bosses)"), not one per boss: 44 lines flooded /ultras.
  const gapBosses = new Map();
  for (const b of BOSSES) for (const s of assign(b, pool).seats) if (!s.cls) {
    const key = `${s.id}: ${b.slots[s.slot].join(' or ')}`;
    gapBosses.set(key, (gapBosses.get(key) || 0) + 1);
  }
  const classGaps = [...gapBosses].map(([k, n]) => `${k} (${n} boss${n === 1 ? '' : 'es'})`);
  const weak = online.filter((m) => m.weapon && m.weapon.value >= WEAPON_MIN && m.weapon.value < WEAPON_GOOD).map((m) => m.id);
  const readyNames = Object.values(bosses).filter((x) => x.ready).map((x) => x.name);
  return {
    ready: readyNames.length > 0,
    comp: 'v3',
    compName: `Ultras-v3 line-ups (${readyNames.length}/${BOSSES.length} bosses ready${readyNames.length ? `: ${readyNames.join(', ')}` : ''})`,
    seats: main.seats.map((s) => ({ id: s.id, cls: s.cls })),
    missing: [...common, ...classGaps],
    advice: weak.length ? `weapons of ${weak.join(', ')} are above the 30% minimum but under the recommended 40%` : null,
    bosses,
  };
}

// The three bot seats beside the main (WITH_MAIN): { ready, main: [classes], seats, missing }. prefer: see assign.
function withMain(b, pool, unready = {}, prefer = null) {
  const wm = WITH_MAIN[b.id];
  if (!wm) return null;
  const a = assign({ slots: wm.slots, critical: wm.critical }, pool, prefer);
  if (!a) return { ready: false, main: wm.main, seats: [], missing: [`three characters for ${b.name} beside the main`] };
  const missing = a.seats.flatMap((s) => unready[s.id] || []);
  for (const s of a.seats) if (!s.cls) missing.push(`${s.id}: ${wm.slots[s.slot].join(' or ')} for ${b.name} beside the main`);
  return { ready: missing.length === 0, main: wm.main, seats: a.seats.map((s) => ({ id: s.id, cls: s.cls || s.want })), missing };
}

// Goals a character should push first so the party covers the v3 line-ups.
function goalsFor(botId) {
  const seat = planned(botId);
  return seat ? [FIRST_WEAPON, ...seat.goals, ...WEAPON_GOALS] : [FIRST_WEAPON, ...WEAPON_GOALS];
}

module.exports = { RAID_POTIONS, RAID_POTION_MIN, BOSSES, SEATS, WITH_MAIN, WEAPON_MIN, WEAPON_GOOD, WEAPON_GOALS, FIRST_WEAPON, LEVEL, check, goalsFor, bestAllDamage, hasEnh, assign, withMain };
