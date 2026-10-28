// Adaptive combat, ported from VibeSkua's function-based skill engine (NinjaXz/VibeSkua, MasterSkillProvider.cs, MIT).
//  - Stance: each new target starts "evaluating" (defensive) for 7 s. Losing ≥ 20% HP in one tick locks DEFENSE
//    (a high-DPS boss). Taking ≥ 40% of the target's HP in one tick, or 7 s without burst damage, locks OFFENSE.
//  - Pass 1, emergency: any ready survival skill the class routine flags (heal / shield / dodge) is cast first.
//  - Pass 2, smart round robin: the class's skill order; every skill must pass its routine rule (HP %, mana %,
//    self/target aura present, stack count, seconds remaining).
//  - Nothing usable → auto attack.
// Skill ids: 0 auto attack, 1-4 class skills (same as the bridge's useSkill).
const SEQUENCES = require('./adaptive-sequences.json');

class Stance {
  constructor() { this.reset(); }
  reset() { this.lastHp = -1; this.lastTargetHp = -1; this.hadTarget = false; this.fightStart = 0; this.mode = 'evaluating'; }
  get highDps() { return this.mode === 'defense'; }
  get defensive() { return this.mode !== 'offense'; }
  update(st, now = Date.now()) {
    if (!st.alive || st.hpMax <= 0 || !st.hasTarget) { this.reset(); return; }
    if (!this.hadTarget) {
      this.hadTarget = true; this.fightStart = now; this.mode = 'evaluating';
      this.lastHp = st.hp; this.lastTargetHp = st.targetHp;
      return;
    }
    if (this.lastHp > 0 && this.lastHp - st.hp >= st.hpMax * 0.20) this.mode = 'defense';
    if (this.lastTargetHp > 0 && st.targetHp > 0 && st.targetHpMax > 0
      && this.lastTargetHp - st.targetHp >= st.targetHpMax * 0.40 && this.mode !== 'defense') this.mode = 'offense';
    if (this.mode === 'evaluating' && now - this.fightStart >= 7000) this.mode = 'offense';
    this.lastHp = st.hp; this.lastTargetHp = st.targetHp;
  }
}

// Default emergency rule: skills 2 and 4 are treated as survival skills when HP drops.
function defaultEmergency(i, c) { return (i === 2 || i === 4) && (c.def ? c.H < 0.88 : c.H < 0.70); }

// Class routines: `use(i, c)` → should skill i be cast now; optional `emergency(i, c)`.
// c = { H, M, def, highDps, evaluating, self(name), target(name) }; self/target return { value, remaining } or null.
const R = [
  [/void highlord|void tracker|hobo highlord/, {
    use: (i, c) => {
      if (i === 3 && c.highDps) return false;
      const sh = c.self('Shackled'); const un = c.self('Unshackled');
      if (i === 1) return c.highDps || c.evaluating || c.H <= 0.65 || !!un || !sh || sh.remaining <= 2;
      if (i === 3) return !c.highDps && !c.evaluating && ((c.H >= 0.90 && !!sh) || (c.H >= 0.80 && !sh && (!un || un.remaining <= 2)));
      return true;
    } }],
  // Legion Revenant (aqwwiki kit, Research-2026-10-20 item 5; the old rule read 'Anathema' / 'Depths of Tartarus', which
  // are no auras in today's kit, so 2 always and 4 always fired): Wicked Purgatory (2) keeps Enveloped (-20..-40 %
  // damage taken, 5 stacks, 12 s) up; Depraved Empowerment (3, party Depravity/Immorality + Arcane Shield) and Anathema
  // (4) whenever ready; Atramentous Shade (1) is the Decay button, also whenever ready.
  [/legion revenant/, { use: (i, c) => { if (i !== 2) return true; const e = c.self('Enveloped'); return c.def || c.H < 0.75 || !e || e.value < 5 || e.remaining <= 2; } }],
  [/archfiend/, { use: (i, c) => (i === 2 ? c.def || c.H <= 0.70 : i === 4 ? !c.self('Fiend Frenzy') : true) }],
  [/verus doomknight/, {
    use: (i, c) => {
      if (i === 2) return c.def || c.H <= 0.75;
      if (i === 4) { const d = c.self('Doom'); return !c.self('Unleashed Doom') && !!d && d.value >= 10; }
      // Soul Fracture (1, -50 % DR on the target, +1 Doom) every cycle: the community combos press it each time
      // (2345-234x2-5234-2354 in keys); gating it to Unleashed Doom threw half of them away (Research-2026-10-20 item 6).
      return true;
    } }],
  // King's Echo (the owner 2026-10-16 + community rules 2026-10-20, vault KNOWLEDGE/Class-Playbooks, Research item 2): the
  // damage is 8 Residual Energy from Bolt (2) infused into the next 20 s of Dragon Sword autos by CORVAK (4), which also
  // hits harder the more mana is missing and refills it. So CORVAK on 8 stacks, on 6 with mana under 40 %, or under 20 %
  // mana (the refill: a dry KE can't Bolt and never reaches 8) - it used to fire at 60 % mana, before the stacks were up.
  // King's Shield (3) goes up straight after it (its barrier only returns after CORVAK) and whenever Royal Resolve has
  // dropped on a hard boss. Ultras v3 raids don't use this table (their KE gates the Shield, a Focus taunt, itself).
  // Bolt (2) needs 25 mana. Emergency: the shield, not Bolt/CORVAK as the default rule would pick.
  [/king'?s echo/, {
    emergency: (i, c) => i === 3 && c.H < (c.def ? 0.60 : 0.45),
    use: (i, c) => {
      if (i === 4) { const re = c.self('Residual Energy'); const n = re ? re.value : 0; return n >= 8 || (n >= 6 && c.M < 0.40) || c.M < 0.20; }
      if (i === 3) return c.H < 0.70 || (!!c.def && !c.self('Royal Resolve'));
      if (i === 2) return c.M >= 0.25;
      return true;
    } }],
  // Chaos Avenger, the tank: Chaotic Armor (Bulwark, 3) never drops; Fury (4) only while it is up.
  [/chaos avenger|chaos champion prime/, { use: (i, c) => (i === 4 ? !!c.self('Chaotic Armor') : i === 3 ? c.def || c.H <= 0.85 || !c.self('Chaotic Armor') : true) }],
  [/dragon of time/, { use: (i, c) => (i === 4 ? !c.def || c.H >= 0.90 : i === 2 ? (c.def ? c.H <= 0.85 : c.H <= 0.60) || !!c.self('Convergence') : true) }],
  [/archmage/, {
    emergency: (i, c) => {
      if (i === 3 && c.self('Corporeal Ascension') && (c.H < 0.65 || (c.def && c.H < 0.85))) return true;
      return i === 1 ? c.def || c.H < 0.90 : false;
    },
    use: (i, c) => {
      const asc = c.self('Corporeal Ascension');
      if (i === 3) {
        if (c.H < 0.65 || (c.def && c.H < 0.85)) return !!asc;
        if (!c.def && c.H >= 0.80) return !asc;
        return false;
      }
      if (i === 2) return !asc || c.H >= 0.70;
      if (i === 1) return c.def || c.H < 0.90 || c.M < 0.50;
      return true;
    } }],
  [/archpaladin/, { use: (i, c) => { if (i === 4) { const cm = c.target('Commandment'); return !!cm && cm.value >= 50; } return i === 2 ? (c.def ? c.H < 0.95 : c.H < 0.70) : true; } }],
  [/stonecrusher|infinity titan/, { use: (i, c) => (i === 3 ? c.def || c.H <= 0.85 : i === 4 ? !!c.self('Magnitude') : true) }],
  [/yami no ronin/, { use: (i, c) => { if (i === 4) { const y = c.self('Yami'); return !!y && y.value >= 4; } return true; } }],
  [/chronoassassin|thief of hours/, {
    emergency: (i, c) => { const td = c.self('Temporal Dodge'); if (i === 4) return c.def || !td || td.remaining <= 2; return i === 2 ? c.def || c.H < 0.85 : false; },
    use: (i, c) => { const td = c.self('Temporal Dodge'); if (i === 4) return c.def || !td || td.remaining <= 2; return i === 2 ? c.def || c.H < 0.85 || c.M >= 0.3 : true; } }],
  [/shaman/, { use: (i, c) => { const e = c.self('Elemental Embrace'); return i === 4 ? !e || e.remaining <= 2 : i === 2 ? (c.def ? c.H < 0.95 : c.H < 0.70) : true; } }],
  [/scarlet sorceress|blood sorceress/, { use: (i, c) => { const r = c.self('Crimson Ritual'); return i === 4 ? !r || r.value < 5 || r.remaining <= 2 : i === 3 ? (c.def ? c.H < 0.85 : c.H < 0.60) : true; } }],
  [/necrotic chronomancer|nechronomancer/, { use: (i, c) => { if (i === 4) { const r = c.target('Chaos Rift'); return (c.def ? c.H <= 0.75 : c.H <= 0.50) && !!r && r.value >= 1; } return true; } }],
  [/glacial berserker|glaceran warlord|glacial warlord/, { use: (i, c) => (i === 3 ? c.def || c.H <= 0.80 || !!c.self('Ancestral Presence') : true) }],
  [/blood titan|frostblood titan/, { use: (i, c) => ((i === 4 || i === 3) ? !c.def && !c.self("Titan's Bloodline") : (c.def ? c.H >= 0.85 : c.H >= 0.70) || !!c.self('Life Drinker')) }],
  [/arachnomancer/, { use: (i, c) => (i === 2 ? (c.def ? c.H < 0.85 : c.H < 0.60) : true) }],
  [/vindicator of they|hollowborn vindicator/, { use: (i, c) => (i === 2 ? c.def || c.H < 0.75 : i === 3 ? c.M > 0.40 : i === 4 ? !!c.self('Massive Strike') : true) }],
  [/necromancer|pinkomancer/, { use: (i, c) => (i === 1 ? !c.self('Summon Minion') : i === 4 ? (c.def ? c.H > 0.75 : c.H > 0.40) : true) }],
  [/paladin/, { use: (i, c) => { if (/legion paladin/.test(c.name) && i === 2) { const s = c.self('Soul'); return !!s && s.value >= 10; } return i === 1 ? (c.def ? c.H < 0.95 : c.H < 0.80) : i === 4 ? !c.self('Aegis') : true; } }],
  [/chronomancer|time/, {
    use: (i, c) => {
      if (i === 4) { const r = c.target('Temporal Rift'); return !!r && r.value >= 4; }
      if (/corrupted chronomancer|timeless chronomancer/.test(c.name)) { if (i === 2) return c.def ? c.H < 0.80 : c.H < 0.50; } else if (c.def && i === 2) return c.H < 0.85;
      return true;
    } }],
  [/chaos slayer|dark chaos berserker/, { use: (i, c) => { if (i === 4 && c.target('Courageous')) return false; return i === 4 ? !c.self('Chaotic Defense') : i === 2 ? !c.self('Surge') && (c.def ? c.H < 0.85 : c.H < 0.60) : true; } }],
  [/rustbucket|enforcer|protosartorium/, { use: (i, c) => (i === 3 ? c.def || c.H < 0.80 || !c.self('Event Horizon') : true) }],
  [/naval commander|highseas commander|pirate/, { use: (i, c) => (i === 1 ? c.def || c.H < 0.75 || !c.self('Broadside') || !c.self('Armada') : true) }],
  [/dragon shinobi/, { use: (i, c) => (i === 3 ? c.M < 0.40 : i === 2 ? (c.def ? c.H < 0.85 : c.H < 0.60) : true) }],
  [/great thief/, { use: (i) => i !== 2 }],
  [/lich/, { use: (i, c) => (i === 1 ? !!c.self('Ex Mortis') && (!c.def || c.H > 0.60) : true) }],
  [/master of moglins/, { use: (i, c) => { if (i === 4) { const w = c.self("Moglin's Will"); return !!w && w.value >= 3; } return i === 3 ? c.def || c.H < 0.80 : true; } }],
  [/lightcaster|lightmage|lord of order/, { use: (i, c) => (i === 1 ? (c.def ? c.H < 0.95 : c.H < 0.80) : true) }],
  [/vampire|lycan/, { use: (i, c) => (i === 2 ? (c.def ? c.H < 0.85 : c.H < 0.65) : true) }],
  // Arcana Invoker (measured 2026-10-19 on the Class Hall Testing Dummy, vault JOURNAL/2026-10-19): The Beginning and
  // the End (1) starts the cycle, opens The World on Judgement and otherwise resets it - pressed inside The World it ends
  // it at once (13k DPS against 24k). The World's damage ramps the longer it lasts, so it is kept until it is about to
  // run out (the cash-out). In The World mana sits full: One With the Cycle (Sacrifice ramps it) first, then Invocation,
  // then Revocation. Before it, Invocation first to reach Judgement. No emergency skill: none of them heal.
  [/arcana invoker/, {
    emergency: () => false,
    priority: (c) => (c.self('XXI - The World') ? [1, 4, 2, 3] : [1, 2, 4, 3]),
    use: (i, c) => {
      const world = c.self('XXI - The World');
      if (i === 1) return world ? world.remaining <= 3 : !c.self('0 - The Fool') || !!c.self('XX - Judgement');
      return true;
    } }],
  [/elemental warrior/, { use: (i, c) => (i === 1 ? c.def || c.H < 0.80 : true) }],
  [/swordmaster/, { use: (i, c) => (i === 1 ? c.def || c.H < 0.85 : true) }],
  [/ultra omniknight/, { use: (i, c) => (i === 2 ? c.def || c.H < 0.80 : true) }],
  [/shadowscythe general/, { use: (i, c) => (i === 1 ? c.def || c.H < 0.85 : true) }],
  [/master ranger/, { use: (i, c) => (i === 1 ? (c.def ? c.H < 0.90 : c.H < 0.70) : true) }],
  [/artifact hunter/, { use: (i, c) => (i === 3 ? c.def || c.H < 0.75 : true) }],
  [/darkblood stormking/, { use: (i, c) => (i === 1 ? (c.def ? c.H < 0.85 : c.H < 0.65) : true) }],
  [/archivist of time/, { use: (i, c) => (i === 1 ? (c.def ? c.H < 0.90 : c.H < 0.75) : true) }],
  [/northlands monk/, { use: (i, c) => (i === 2 ? (c.def ? c.H < 0.90 : c.H < 0.75) : true) }],
  [/sentinel/, { use: (i, c) => (i === 1 ? (c.def ? c.H < 0.85 : c.H < 0.65) : true) }],
  [/undead goat/, { use: (i, c) => (i === 1 ? (c.def ? c.H < 0.85 : c.H < 0.65) : true) }],
];

// Routine for a class name, or null when VibeSkua has nothing specific (then Skua's AdvancedSkills rotation is used).
function routineFor(className) {
  const name = String(className || '').toLowerCase();
  const sequence = SEQUENCES[name] || null;
  const logic = (R.find(([re]) => re.test(name)) || [])[1] || null;
  if (!sequence && !logic) return null;
  return { name, sequence: sequence || [1, 2, 3, 4], use: (logic && logic.use) || (() => true), emergency: (logic && logic.emergency) || defaultEmergency, priority: (logic && logic.priority) || null };
}

// Aura list from the bridge (getSubjectAuras) → lookup with seconds remaining, like VibeSkua's Aura.RemainingTime.
function auraLookup(list, now = Date.now()) {
  const map = new Map();
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || !a.nam) continue;
    const remaining = a.dur && a.ts ? Math.max(0, Math.floor((Number(a.ts) + Number(a.dur) * 1000 - now) / 1000)) : 999;
    map.set(String(a.nam).toLowerCase(), { value: Number(a.val ?? 1), remaining, category: a.cat || '' });
  }
  return (name) => map.get(String(name).toLowerCase()) || null;
}

// Choose the next skill: emergency pass, then round robin from `pointer` (or a routine's own priority list, first usable
// wins). Returns { skill, pointer, reason }.
function choose(routine, ctx, ready, pointer) {
  const seq = routine.sequence;
  for (const k of seq) if (ready(k) && routine.emergency(k, ctx) && routine.use(k, ctx) === true) return { skill: k, pointer, reason: 'emergency' };
  if (routine.priority) {
    for (const k of routine.priority(ctx)) if (ready(k) && routine.use(k, ctx) === true) return { skill: k, pointer, reason: 'rotation' };
    return { skill: 0, pointer, reason: 'auto' };
  }
  for (let n = 0; n < seq.length; n++) {
    const idx = (pointer + n) % seq.length;
    const k = seq[idx];
    if (ready(k) && routine.use(k, ctx) === true) return { skill: k, pointer: (idx + 1) % seq.length, reason: 'rotation' };
  }
  return { skill: 0, pointer: (pointer + 1) % seq.length, reason: 'auto' };
}

module.exports = { Stance, routineFor, auraLookup, choose, SEQUENCES };
