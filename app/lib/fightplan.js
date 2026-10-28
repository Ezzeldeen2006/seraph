// The class ladder (the owner 2026-10-16): a boss that keeps killing a character inside its own Skua script is tried with
// other classes and rotations before the goal is parked, the party is called or the owner is pinged. "if a boss is hard to
// kill you need to time your 4th skill and use it after using the 5th skill ... if KE cant kill goto VHL ... the 4th
// skill decreases our own HP so use it on easy bosses ... if both VHL and KE fails you use CAV as its the slowest but
// most tankiest and can solo most of things".
//
// Steps, each one STEP_DEATHS deaths to the same boss (in STEP_WINDOW) before the next:
//   1. the class the script fought with, in its normal rotation (CoreBots mode Base)
//   2. the same class in its careful rotation (mode Solo in lib/skill-overrides.json: KE shields below 60 % HP and
//      CORVAKs on 8 Residual Energy, VHL never Unshackles, CAV keeps Chaotic Armor up)
//   3. the next classes of the ladder (settings.bossClasses, else the best owned damage class, then the toughest),
//      careful rotation - the boss has already shown it is hard
// The step is written into CoreBots' options (cbo.keysFor -> SoloClassSelect / SoloModeSelect, or the Farm pair when
// the script fought with its farm class) and the script restarts with it. A kill teaches the character which set-up
// beat that boss (<bot>/bossClasses.json); the next fight with it starts there. While steps are left the ladder owns
// the deaths (no party call, death cap or DM yet); once every step failed the normal rules take over.
'use strict';
const fs = require('fs');
const path = require('path');

const STEP_DEATHS = 3;
const STEP_WINDOW = 20 * 60000;
const MAX_CLASSES = 3;
const RANK10_CP = 302500;

// Measured order (vault JOURNAL/2026-09-23 dummy table: KE 22.3k > CSH > LR 17.8k > VHL > CAV > AP 10k > VDK 8.6k;
// Arcana Invoker 24.4k sustained on 2026-10-19 but slow for its first minute, so after KE), with the classes the party
// characters own after it.
const DAMAGE = ["King's Echo", 'Arcana Invoker', 'Chrono ShadowHunter', 'Legion Revenant', 'Void Highlord', 'ArchFiend', 'Scarlet Sorceress', 'Blaze Binder', 'ArchPaladin', 'Verus DoomKnight'];
const TOUGH = ['Chaos Avenger', 'ArchPaladin', 'Lord of Order', 'StoneCrusher', 'Void Highlord', 'Glacial Berserker', 'Verus DoomKnight', 'Shaman'];

// The class to open with against a boss (the owner 2026-10-19): "when fighting tyndarius make sure the bot uses LR so he
// doesnt die" (Avatar Tyndarius: 1.5 M HP, 1.4-1.7k hits - LR's Wicked Purgatory stacks to 40% less damage taken, Depraved
// Empowerment shields and heals), and Nightbane (true-damage Dive to 1 HP, heals on every hit, 10k cap per hit) is
// soloed with Arcana Invoker. Lower-case monster names; the first owned class wins. A set-up the character already
// beat the boss with (learned) comes before these.
const BOSS_PICKS = {
  'avatar tyndarius': ['Legion Revenant'],
  nightbane: ['Arcana Invoker'],
};
// Laps over the whole ladder before giving up, for characters whose ladder is a hand-picked list (the owner's main:
// "keep rotating until you find the class that can solo the bot").
const LAPS_WANTED = 3;

// Classes with a careful rotation of our own (mode Solo in lib/skill-overrides.json).
let careful = null;
function carefulClasses() {
  if (careful) return careful;
  try {
    const ov = JSON.parse(fs.readFileSync(path.join(__dirname, 'skill-overrides.json'), 'utf8'));
    careful = new Set(Object.entries(ov.classes || {}).filter(([, m]) => m && m.Solo).map(([c]) => c.toLowerCase()));
  } catch (e) { careful = new Set(); }
  return careful;
}
function hasCareful(cls) { return carefulClasses().has(String(cls || '').toLowerCase()); }

const lc = (s) => String(s || '').toLowerCase();

// The ladder for one fight. `start`: the class the script fought with; `owned`: rank-10 class names.
function steps(start, owned, wanted) {
  const have = (c) => owned.some((o) => lc(o) === lc(c));
  const name = (c) => owned.find((o) => lc(o) === lc(c)) || c;
  const classes = [start];
  // A hand-picked list (settings.bossClasses) is tried in full; the automatic picks stop at MAX_CLASSES.
  const cap = Array.isArray(wanted) && wanted.length ? wanted.length + 1 : MAX_CLASSES;
  const add = (c) => { if (c && have(c) && !classes.some((x) => lc(x) === lc(c)) && classes.length < cap) classes.push(name(c)); };
  if (Array.isArray(wanted) && wanted.length) wanted.forEach(add);
  else { add(DAMAGE.find((c) => have(c) && lc(c) !== lc(start))); add(TOUGH.find((c) => have(c) && !classes.some((x) => lc(x) === lc(c)))); }
  const out = [{ cls: start, mode: 'Base' }];
  if (hasCareful(start)) out.push({ cls: start, mode: 'Solo' });
  for (const c of classes.slice(1)) out.push({ cls: c, mode: hasCareful(c) ? 'Solo' : 'Base' });
  return out;
}

function describe(s) {
  if (!s) return '?';
  return `${s.cls} (${s.mode === 'Solo' ? 'careful rotation' : 'normal rotation'})`;
}

// What the ladder writes into CoreBots' options for the running task (cbo.keysFor), or null.
function cboKeys(bot) {
  const f = bot && bot._fight;
  if (!f || !bot.current || f.key !== bot.taskKey(bot.current)) return null;
  const s = f.steps[f.i];
  if (!s) return null;
  const P = f.slot === 'farm' ? 'Farm' : 'Solo';
  // Boss and Dodge too: CoreArchMage's Dage / Avatar Tyndarius steps call Core.UseBossClass() and Nulgath's uses
  // ClassType.Dodge; with those empty CoreBots keeps whatever class is on, so the ladder never reached them (Dage,
  // 2026-10-18: four "switches" in 3 min that changed nothing in the boss step).
  const keys = { [`${P}ClassSelect`]: s.cls, [`${P}ModeSelect`]: s.mode, [`${P}EquipCheck`]: 'False', BossClassSelect: s.cls, BossModeSelect: s.mode, BossEquipCheck: 'False', DodgeClassSelect: s.cls, DodgeModeSelect: s.mode, DodgeEquipCheck: 'False' };
  // The class's own kit (weapon, helm, cape enhanced for it), when it has one.
  const kits = bot.kits && require('./kits');
  const k = kits && kits.forClass(bot.kits, s.cls);
  if (k && kits.SLOTS.some((sl) => k[sl])) {
    const n = P === 'Solo' ? 1 : 2;
    Object.assign(keys, { [`${P}EquipCheck`]: 'True', [`Weapon${n}Select`]: k.Weapon || '', [`Helm${n}Select`]: k.he || '', [`Cape${n}Select`]: k.ba || '' });
  }
  return keys;
}

function learnedFile(bot) { return bot.file ? bot.file('bossClasses.json') : null; }
function learned(bot) {
  if (!bot._bossClasses) {
    bot._bossClasses = {};
    const f = learnedFile(bot);
    if (f) try { bot._bossClasses = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch (e) { /* none yet */ }
  }
  return bot._bossClasses;
}

// What the party has learned together (the owner 2026-10-26: "the new bots must not face what the first four already solved"):
// every kill also goes into <root>/bossClasses.shared.json. A character with no win of its own for a boss starts with the
// shared set-up when it owns that class at rank 10 - the first four tried it out so the others don't die finding it.
let sharedBook_ = null;
function sharedFile() { try { return path.join(require('./paths').P.ROOT, 'bossClasses.shared.json'); } catch (e) { return null; } }
function sharedBook() {
  if (!sharedBook_) {
    sharedBook_ = {};
    const f = sharedFile();
    if (f) try { sharedBook_ = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch (e) { /* none yet */ }
  }
  return sharedBook_;
}
// The set-up that beat `boss` for this character, else for the party when this character owns that class.
function wonWith(bot, boss, owned) {
  const own = learned(bot)[boss];
  if (own) return own;
  const sh = sharedBook()[boss];
  return sh && (owned || []).some((o) => lc(o) === lc(sh.cls)) ? sh : null;
}

// Every step was tried on this boss in this task: the normal rules (party call, DM, park) take over.
function exhausted(bot, boss) {
  const f = bot && bot._fight;
  return !!(f && f.exhausted && lc(f.boss) === lc(boss));
}

// A death to `killer` while the task runs. ctx: { now, start (equipped class), slot ('solo'|'farm'), owned, wanted }.
// Returns 'switch' (a new step: restart the script), 'hold' (the ladder still has steps: no other death rule yet) or
// null (not the ladder's business, or every step failed).
function onDeath(bot, killer, key, ctx) {
  const now = ctx.now || Date.now();
  let f = bot._fight;
  if (!f || f.key !== key || lc(f.boss) !== lc(killer.name)) {
    if (!ctx.start) return null;
    f = bot._fight = newFight(key, killer.name, ctx, now);
    // Beat it before with another set-up: start there.
    const won = wonWith(bot, killer.name, ctx.owned);
    if (won) {
      const j = f.steps.findIndex((s) => lc(s.cls) === lc(won.cls) && s.mode === won.mode);
      if (j > 0) {
        f.i = j;
        if (bot.journal) bot.journal(`${killer.name}: I beat it before with ${describe(won)} - switching to that`);
        return 'switch';
      }
      if (j < 0 && (ctx.owned || []).some((o) => lc(o) === lc(won.cls))) {
        f.steps.splice(1, 0, { cls: won.cls, mode: won.mode });
        f.i = 1;
        if (bot.journal) bot.journal(`${killer.name}: I beat it before with ${describe(won)} - switching to that`);
        return 'switch';
      }
    }
    // No win to go by: a class picked for this boss (BOSS_PICKS) that the script didn't fight with - switch to it now.
    const pick = won ? null : bossPick(killer.name, ctx.owned || []);
    if (pick && lc(pick) !== lc(ctx.start)) {
      f.steps = dedupe([{ cls: pick, mode: 'Base' }, ...f.steps]);
      f.i = 0;
      if (bot.journal) bot.journal(`${killer.name}: this one is for ${pick} - switching to it`);
      return 'switch';
    }
  }
  if (f.exhausted) return null;
  f.deaths = f.deaths.filter((t) => now - t < STEP_WINDOW).concat(now);
  if (f.deaths.length < STEP_DEATHS) return f.i + 1 < f.steps.length || (f.lap || 1) < (f.laps || 1) ? 'hold' : null;
  f.deaths = [];
  const was = f.steps[f.i];
  if (f.i + 1 >= f.steps.length) {
    if ((f.lap || 1) < (f.laps || 1)) {
      f.lap = (f.lap || 1) + 1;
      f.i = 0;
      if (bot.journal) bot.journal(`${killer.name} beat every set-up once (${f.steps.map(describe).join(' → ')}) - going round again, lap ${f.lap}/${f.laps}`, 'warn');
      return 'switch';
    }
    f.exhausted = true;
    if (bot.journal) bot.journal(`${killer.name} beat every set-up I have (${f.steps.map(describe).join(' → ')}) - handing it to the usual rules`, 'warn');
    return null;
  }
  f.i++;
  if (bot.journal) bot.journal(`${killer.name} killed me ${STEP_DEATHS}x with ${describe(was)} - trying ${describe(f.steps[f.i])}`, 'warn');
  return 'switch';
}

function newFight(key, boss, ctx, now) {
  const wanted = Array.isArray(ctx.wanted) && ctx.wanted.length;
  return { key, boss, slot: ctx.slot || 'solo', steps: steps(ctx.start, ctx.owned || [], ctx.wanted), i: 0, deaths: [], at: now, lap: 1, laps: ctx.laps || (wanted ? LAPS_WANTED : 1) };
}
function dedupe(list) { return list.filter((s, i) => list.findIndex((x) => lc(x.cls) === lc(s.cls) && x.mode === s.mode) === i); }
function bossPick(boss, owned) {
  const want = BOSS_PICKS[lc(boss)] || [];
  return want.map((c) => owned.find((o) => lc(o) === lc(c))).find(Boolean) || null;
}

// A boss is in the character's cell while its script runs: open with the set-up it beat that boss with before, or the
// class picked for it (BOSS_PICKS), before the first death. Returns 'switch' (restart the script with it) or null.
function preFight(bot, boss, key, ctx) {
  const f = bot._fight;
  if (f && f.key === key && lc(f.boss) === lc(boss)) return null;   // already on it
  const owned = ctx.owned || [];
  const won = wonWith(bot, boss, owned);
  const first = won && owned.some((o) => lc(o) === lc(won.cls)) ? { cls: won.cls, mode: won.mode } : (bossPick(boss, owned) ? { cls: bossPick(boss, owned), mode: 'Base' } : null);
  if (!first) return null;
  const nf = newFight(key, boss, ctx, ctx.now || Date.now());
  nf.steps = dedupe([first, ...nf.steps]);
  nf.pre = true;
  bot._fight = nf;                                                             // later ticks see it and stay quiet
  // The script already fights with that class: no restart, whatever the rotation. A restart for "careful rotation" put
  // Nova's Forge Elysium script back to Verus DoomKnight 136 times in 3 days at Dage (it re-equips Void Highlord
  // itself), and Sword Scroll Fragments sat at 870/1000 (2026-10-25..27).
  if (lc(first.cls) === lc(ctx.start)) return null;
  if (bot.journal) bot.journal(`${boss} ahead: ${won ? `I beat it before with ${describe(first)}` : `this one is for ${first.cls}`} - switching before the fight`);
  return 'switch';
}

// The character took part in killing `name`: remember the set-up that did it.
function onKill(bot, name, now = Date.now()) {
  const f = bot && bot._fight;
  if (!f || lc(f.boss) !== lc(name)) return false;
  const s = f.steps[f.i];
  f.deaths = [];
  f.exhausted = false;
  const book = learned(bot);
  const before = book[f.boss];
  book[f.boss] = { cls: s.cls, mode: s.mode, at: new Date(now).toISOString() };
  const file = learnedFile(bot);
  if (file) try { fs.writeFileSync(file, JSON.stringify(book, null, 1)); } catch (e) { /* memory still has it */ }
  const shared = sharedBook();
  shared[f.boss] = { cls: s.cls, mode: s.mode, at: new Date(now).toISOString(), by: bot.id || null };
  const sf = sharedFile();
  if (sf) try { fs.writeFileSync(sf, JSON.stringify(shared, null, 1)); } catch (e) { /* memory still has it */ }
  if (bot.journal && (!before || lc(before.cls) !== lc(s.cls) || before.mode !== s.mode)) bot.journal(`killed ${f.boss} with ${describe(s)} - I'll start with that next time`);
  return true;
}

function rank10(classPoints) { return (classPoints || []).filter((c) => Number(c.cp) >= RANK10_CP).map((c) => c.name); }

module.exports = { STEP_DEATHS, STEP_WINDOW, DAMAGE, TOUGH, BOSS_PICKS, LAPS_WANTED, steps, describe, cboKeys, onDeath, onKill, preFight, bossPick, exhausted, learned, sharedBook, wonWith, rank10, hasCareful };
