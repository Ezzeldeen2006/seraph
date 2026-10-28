// Which class each character farms with, solos bosses with, and supports with - and how to get there.
//
// Every entry below comes from two grounded sources, not from memory:
//   * the AQW Hub class guide saved in knowledge/aqwhub-class-guide.txt (role, how to obtain, member-only)
//   * the Skua script library on disk (Other/Classes/**), which tells us what we can actually farm unattended
// `script` is only set when a real script exists, so a plan never promises a grind we cannot run.
'use strict';
const fs = require('fs');
const path = require('path');
const { P } = require('./paths');

// role: what the class is for. free: obtainable without membership. needs: prerequisites in plain words.
const CLASSES = [
  // --- free starters, no grind worth the name -------------------------------------------------
  { name: 'Oracle', role: 'solo', free: true, script: null, needs: 'free in the Game Menu class shop', note: 'slow but survives almost anything' },
  { name: 'Sorcerer', role: 'farm', free: true, script: null, needs: 'buy from the Mage trainer at /trainers', note: 'four-skill spam, fine until a real farmer arrives' },
  { name: 'Ninja', role: 'solo', free: true, script: null, needs: 'NPC at /greenguardwest', note: 'stun and dodge' },
  { name: 'Barber', role: 'support', free: true, script: null, needs: 'free at /classhalla' },

  // --- daily-quest classes: slow but completely unattended --------------------------------------
  { name: 'Pyromancer', role: 'solo', free: true, script: 'Other/Classes/Daily-Classes/BlazeBinder.cs', needs: 'a daily quest, 7 days free-to-play', note: 'also the key to Blaze Binder' },
  { name: 'Cryomancer', role: 'solo', free: true, script: null, needs: 'a daily quest, 7 days free-to-play' },

  // --- reputation classes: the bread and butter for a bot ---------------------------------------
  { name: 'Shaman', role: 'farm', free: true, script: 'Other/Classes/REP-based/Shaman.cs', needs: 'Rank 10 Arcangrove', note: 'great farmer, better with forge enhancements' },
  { name: 'Evolved Shaman', role: 'farm', free: true, script: 'Other/Classes/REP-based/EvolvedShaman.cs', needs: 'Shaman plus more Arcangrove' },
  { name: 'Master Ranger', role: 'farm', free: true, script: 'Other/Classes/REP-based/MasterRanger.cs', needs: 'Rank 10 Sandsea' },
  { name: 'Horc Evader', role: 'solo', free: true, script: 'Other/Classes/REP-based/HorcEvader.cs', needs: 'Rank 10 Horc, at /bloodtusk', note: 'dodge soloer' },
  { name: 'Elemental Dracomancer', role: 'tank', free: true, script: 'Other/Classes/REP-based/ElementalDracomancer.cs', needs: 'Rank 10 Etherstorm, at /airstorm' },
  { name: 'Chaos Slayer', role: 'farm', free: true, script: 'Other/Classes/REP-based/ChaosSlayer.cs', needs: 'Rank 10 Chaos, and the 13 Lords of Chaos story' },
  { name: 'Stonecrusher', role: 'support', free: true, script: 'Other/Classes/REP-based/StoneCrusher.cs', needs: 'Rank 10 Mythsong, Brightoak and Arcangrove', note: 'usable in some ultras' },
  { name: 'Glacial Berserker', role: 'dps', free: true, script: 'Other/Classes/REP-based/GlacialBerserker.cs', needs: 'reputation grind' },
  { name: 'Troll Spellsmith', role: 'farm', free: true, script: 'Other/Classes/REP-based/TrollSpellsmith.cs', needs: 'Rank 10 Troll' },
  { name: 'Arachnomancer', role: 'solo', free: true, script: 'Other/Classes/REP-based/Arachnomancer.cs', needs: 'reputation grind' },

  // --- quest/drop classes ------------------------------------------------------------------------
  { name: 'Blood Sorceress', role: 'farm', free: true, script: 'Other/Classes/BloodSorceress.cs', needs: 'boss drop from Scarletta at /towerofmirrors' },
  { name: 'Scarlet Sorceress', role: 'farm', free: true, script: 'Other/Classes/ScarletSorceress.cs', needs: 'Blood Sorceress and level 50', note: 'good damage with sustain' },
  { name: 'Dragonslayer', role: 'solo', free: true, script: 'Other/Classes/Dragonslayer.cs', needs: 'questline at /lair' },
  { name: 'Dragonslayer General', role: 'dps', free: true, script: 'Other/Classes/DragonslayerGeneral.cs', needs: 'Rank 10 Dragonslayer plus extra grind' },
  { name: 'Dragon Shinobi', role: 'solo', free: true, script: 'Other/Classes/DragonShinobi.cs', needs: '100 perfect Orochi Scales', note: 'damage over time, good against gimmick bosses' },
  { name: 'Necromancer', role: 'dps', free: true, script: 'Other/Classes/Necromancer.cs', needs: 'questline' },
  { name: 'Lich', role: 'dps', free: true, script: 'Other/Classes/Lich.cs', needs: 'Necromancer plus a questline' },
  { name: 'Martial Artist', role: 'solo', free: true, script: 'Other/Classes/MartialArtist.cs', needs: 'questline' },
  { name: 'Sentinel', role: 'tank', free: true, script: 'Other/Classes/Sentinel.cs', needs: 'questline' },
  { name: 'Light Caster', role: 'support', free: true, script: 'Other/Classes/LightCaster.cs', needs: 'questline' },
  { name: 'Scion of Flames', role: 'dps', free: true, script: 'Other/Classes/ScionofFlames.cs', needs: 'questline' },

  // --- the long endgame grinds: real ultra material ---------------------------------------------
  { name: 'Blaze Binder', role: 'farm', free: true, script: 'Other/Classes/Daily-Classes/BlazeBinder.cs', needs: 'Rank 10 Doomwood, Rank 10 Embersea and Pyromancer', note: 'best farmer before forge enhancements' },
  { name: 'Arcana Invoker', role: 'farm', free: true, script: 'Other/Classes/ArcanaInvoker[Non-Insignia].cs', needs: 'the Arcana Particle quests at /arcana', note: 'generalist: farms and does damage' },
  { name: 'Archmage', role: 'farm', free: true, script: 'Other/Classes/ArchMage', needs: "Warlic's questline at /archmage", note: 'arguably the best farming class in the game' },
  { name: 'Verus DoomKnight', role: 'dps', free: true, script: 'Other/Classes/VerusDoomKnight.cs', needs: 'the long Verus DoomKnight questline', note: 'ultra staple, brings debuffs' },
  { name: 'Void Highlord', role: 'dps', free: true, script: null, needs: 'Nulgath materials at the /tercessuinotlim merge shop', note: 'damage and tanking' },
  { name: 'Dragon of Time', role: 'tank', free: true, script: 'Other/Classes/DragonOfTime.cs', needs: "Kro'nar's quests at /timeinn", note: 'damage, farming and tanking as endurance scales' },
  { name: 'Kings Echo', role: 'support', free: true, script: 'Other/Classes/KingsEcho.cs', needs: 'questline' },
  { name: 'Frost Spirit Reaver', role: 'dps', free: true, script: 'Other/Classes/FrostSpiritReaver.cs', needs: 'questline' },
  { name: 'Proto Sartorium', role: 'dps', free: true, script: 'Other/Classes/ProtoSartorium.cs', needs: 'questline' },
  { name: 'Sovereign of Storms', role: 'dps', free: true, script: 'Other/Classes/SovereignOfStorms.cs', needs: 'questline' },
  { name: 'Enforcer', role: 'solo', free: true, script: 'Other/Classes/Enforcer.cs', needs: 'questline' },
  { name: 'Legion Revenant', role: 'support', free: true, script: null, needs: 'the Fealty quests many times over', note: 'ultra support and a fine farmer' },
  { name: 'ArchPaladin', role: 'tank', free: true, script: null, needs: 'the ArchPaladin questline (long)', note: 'ultra staple, tanks and supports' },
  { name: 'Lord of Order', role: 'support', free: true, script: null, needs: 'the Lord of Order questline (very long)', note: 'top tier ultra support' },

  // --- member only: listed so the bots never waste a day trying ---------------------------------
  { name: 'Legendary Hero', role: 'support', free: false, script: null, needs: 'membership' },
  { name: 'Death Knight Lord', role: 'farm', free: false, script: 'Other/Classes/DeathKnightLord[mem].cs', needs: 'membership and a 30 day daily' },
  { name: 'Legion DoomKnight', role: 'dps', free: false, script: 'Other/Classes/LegionDoomKnight[Mem].cs', needs: 'membership' },
];

const byName = (name) => CLASSES.find((c) => c.name.toLowerCase() === String(name || '').toLowerCase()) || null;

// What a character should aim for next, in order, per job. Each persona gets a different route so the
// party ends up with a farmer, a tank, damage and support rather than four of the same thing.
const ROUTES = {
  sable7: {   // support healer
    farm: ['Sorcerer', 'Shaman', 'Blaze Binder', 'Archmage'],
    solo: ['Oracle', 'Pyromancer', 'Dragonslayer'],
    support: ['Barber', 'Light Caster', 'Stonecrusher', 'Lord of Order'],
  },
  valen7: {     // tank
    farm: ['Sorcerer', 'Master Ranger', 'Chaos Slayer'],
    solo: ['Oracle', 'Dragonslayer', 'Elemental Dracomancer', 'Dragon of Time'],
    support: ['Stonecrusher', 'ArchPaladin'],
  },
  nova7: {      // damage
    farm: ['Sorcerer', 'Shaman', 'Arcana Invoker'],
    solo: ['Ninja', 'Horc Evader', 'Dragon Shinobi'],
    support: ['Barber', 'Legion Revenant'],
  },
  oren7: {     // caster
    farm: ['Sorcerer', 'Blood Sorceress', 'Scarlet Sorceress', 'Archmage'],
    solo: ['Oracle', 'Cryomancer', 'Necromancer', 'Lich'],
    support: ['Light Caster', 'Kings Echo'],
  },
};

const DEFAULT_ROUTE = { farm: ['Sorcerer', 'Shaman'], solo: ['Oracle', 'Ninja'], support: ['Barber'] };

// Ultras are level 100 group fights; each wants its own shape of party rather than one fixed line-up.
// Roles, not exact classes, so the party can field whatever it actually owns.
const ULTRA_SETUPS = {
  'ultra tyndarius': { weekly: true, party: ['support', 'support', 'dps', 'dps'], note: 'weekly boss; burst damage between his phases' },
  'ultra nulgath': { party: ['support', 'support', 'dps', 'tank'], note: 'long fight, sustain matters' },
  'ultra dage': { party: ['support', 'support', 'dps', 'dps'], note: 'brings Legion Revenant progress' },
  'ultra drago': { party: ['support', 'tank', 'dps', 'dps'] },
  'ultra darkon': { party: ['support', 'support', 'dps', 'dps'] },
  'ultra speaker': { party: ['support', 'support', 'dps', 'dps'] },
  'queen ascendant': { party: ['support', 'support', 'dps', 'tank'] },
  default: { party: ['support', 'support', 'dps', 'dps'], note: 'two supports and two damage dealers is the usual shape' },
};

function route(botId) { return ROUTES[String(botId).toLowerCase()] || DEFAULT_ROUTE; }

// The best class this character owns for a job, or null when it owns none yet.
function ownedFor(job, owned) {
  const have = new Set([...owned].map((s) => String(s).toLowerCase()));
  const wanted = CLASSES.filter((c) => c.role === job).map((c) => c.name);
  // Prefer the later entries of the character's own route, then any owned class with that role.
  return { pick: (botId) => {
    const r = route(botId)[job] || [];
    for (let i = r.length - 1; i >= 0; i--) if (have.has(r[i].toLowerCase())) return byName(r[i]);
    for (let i = wanted.length - 1; i >= 0; i--) if (have.has(wanted[i].toLowerCase())) return byName(wanted[i]);
    return null;
  } };
}

// Endgame classes beat any starter route (check-up 2026-10-05: three characters owned ArchPaladin at rank 10 and still
// solo'd Farmer Joe's bosses with Dragonslayer, the end of their starter route; Taro Blademaster parked it for days).
// Strongest first, per job; the persona's route only decides among the classes below these.
const ENDGAME = {
  solo: ['Verus DoomKnight', 'Dragon of Time', 'Void Highlord', 'ArchPaladin', 'Lord of Order', 'Legion Revenant', 'Arcana Invoker', 'StoneCrusher'],
  dps: ['Verus DoomKnight', 'Void Highlord', 'Dragon of Time', 'Arcana Invoker', 'Legion Revenant'],
  tank: ['ArchPaladin', 'Dragon of Time', 'Void Highlord', 'Lord of Order'],
  support: ['Lord of Order', 'ArchPaladin', 'Legion Revenant', 'StoneCrusher', "King's Echo", 'Kings Echo'],
  farm: ['Legion Revenant', 'Archmage', 'Arcana Invoker', 'Blaze Binder', 'Void Highlord'],
};
function classFor(botId, job, owned) {
  const have = new Set([...(owned || [])].map((s) => String(s).toLowerCase()));
  for (const name of ENDGAME[job] || []) if (have.has(name.toLowerCase())) return { ...(byName(name) || { role: job, free: true }), name };   // the game's spelling (StoneCrusher) for CBO
  return ownedFor(job, owned || []).pick(botId);
}

// The next class this character should work towards for a job (skipping what it has and member-only ones).
function nextGoal(botId, job, owned, isMember = false) {
  const have = new Set([...(owned || [])].map((s) => String(s).toLowerCase()));
  for (const name of route(botId)[job] || []) {
    if (have.has(name.toLowerCase())) continue;
    const c = byName(name);
    if (!c) continue;
    if (!c.free && !isMember) continue;
    return c;
  }
  return null;
}

// Does this character have something for every job? Used to warn when a bot cannot solo anything.
function gaps(botId, owned) {
  const missing = [];
  for (const job of ['farm', 'solo']) if (!classFor(botId, job, owned)) missing.push(job);
  return missing;
}

function ultraSetup(name) {
  const key = String(name || '').toLowerCase().trim();
  return ULTRA_SETUPS[key] || ULTRA_SETUPS[Object.keys(ULTRA_SETUPS).find((k) => k !== 'default' && key.includes(k))] || ULTRA_SETUPS.default;
}

// Scripts we can actually run for a class goal (checked against the Skua library on disk).
function scriptFor(className) {
  const c = byName(className);
  if (!c || !c.script) return null;
  const full = path.join(P.SCRIPTS, ...c.script.split('/'));
  try {
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      const inside = fs.readdirSync(full).filter((f) => f.endsWith('.cs'));
      return inside.length ? `${c.script}/${inside[0]}` : null;
    }
    return c.script;
  } catch (e) { return null; }
}

module.exports = { ENDGAME, CLASSES, ROUTES, ULTRA_SETUPS, byName, route, classFor, nextGoal, gaps, ultraSetup, scriptFor };
