// The progression plan every Seraph account follows: what to farm at which stage, which classes are a must, and which
// classes each ultra wants. Sources (2026-09-17):
//  - Skua auqw/Scripts Ultrasv3/IndividualUltras (class per taunt role for all 11 ultras)
//  - AQW Hub "Basic Class Guide" (aqwhub.com/other-guides/basic-class-guide) — stage + purpose per class
//  - AQW Progression Guide (sites.google.com/view/aqwprogressionguide) — leveling path, daily/weekly ultras
//  - AQW Wiki — every class below is 0 AC / F2P (Lord of Order, ArchPaladin, StoneCrusher merge, VDK, King's Echo …)
// Every entry has a Skua script so the bot can actually run it.

const STAGES = [
  { id: 'early', label: 'Early game', from: 1, to: 29, focus: 'level up, starter class to rank 10, junk out, first enhancements' },
  { id: 'mid', label: 'Mid game', from: 30, to: 59, focus: 'reputation farm classes, 13 Lords of Chaos, first support classes' },
  { id: 'late', label: 'Late game', from: 60, to: 89, focus: 'ultra classes, Forge enhancements, party roles' },
  { id: 'end', label: 'End game', from: 90, to: 100, focus: 'every account gets every ultra class; daily + weekly ultras with the party' },
];

// Every goal the brain knows. `when` = min level. `must` = everyone needs it eventually (endgame convergence).
// `repeat: 'daily'` = the script only progresses once per server day (daily-quest classes).
const GOALS = {
  'story-13loc': { label: '13 Lords of Chaos story', script: 'Story/LordsofChaos/00Complete13LOC.cs', when: 30, haveQuest: 3881, purpose: 'unlocks Chaos Slayer, Lord of Order dailies, Chaos Avenger', must: true, hours: 2 },
  'blood-sorceress': { label: 'Blood Sorceress', script: 'Other/Classes/BloodSorceress.cs', when: 20, have: 'Blood Sorceress', purpose: 'early farm class, upgrades to Scarlet Sorceress' },
  'shaman': { label: 'Shaman', script: 'Other/Classes/REP-based/Shaman.cs', when: 30, have: 'Shaman', purpose: 'farm class; StoneCrusher needs Shaman Armor' },
  'master-ranger': { label: 'Master Ranger', script: 'Other/Classes/REP-based/MasterRanger.cs', when: 30, have: 'Master Ranger', purpose: 'early farm class' },
  'chaos-slayer': { label: 'Chaos Slayer', script: 'Other/Classes/REP-based/ChaosSlayer.cs', when: 50, have: 'Chaos Slayer', purpose: 'solo / farm DPS' },
  'scarlet-sorceress': { label: 'Scarlet Sorceress', script: 'Other/Classes/ScarletSorceress.cs', when: 50, have: 'Scarlet Sorceress', purpose: 'farm / solo caster' },
  'blaze-binder': { label: 'Blaze Binder', script: 'Other/Classes/Daily-Classes/BlazeBinder.cs', when: 40, have: 'Blaze Binder', purpose: 'best farm class before Forge', repeat: 'daily' },
  'archpaladin': { label: 'ArchPaladin', script: 'Good/ArchPaladin.cs', when: 50, have: 'ArchPaladin', purpose: 'tank / support — ultra taunter', must: true, ultra: true },
  'stonecrusher': { label: 'StoneCrusher', script: 'Other/Classes/REP-based/StoneCrusher.cs', when: 55, have: 'StoneCrusher', purpose: 'support — in 10 of 11 Skua ultra comps', must: true, ultra: true },
  'lord-of-order': { label: 'Lord of Order', script: 'Dailies/LordOfOrder.cs', when: 60, have: 'Lord of Order', purpose: 'top support — in all 11 Skua ultra comps', must: true, ultra: true, repeat: 'daily' },
  // Every story an Ultras-v3 boss needs (Exaltia Tower, Shadows of War, 13 LoC, Dage Challenge, Astravia, Hollowborn),
  // as Skua's own Ultrasv3/DoAllUltrasStorys.cs. Its last step is Mana Cradle, so The Mainyu (9125) marks it done.
  'ultra-stories': { label: 'Ultra story unlocks', script: 'Ultrasv3/DoAllUltrasStorys.cs', when: 80, haveQuest: 9125, purpose: 'unlocks the maps of all eleven Ultras-v3 bosses', must: true, ultra: true },
  'verus-doomknight': { label: 'Verus DoomKnight', script: 'Other/Classes/VerusDoomKnight.cs', when: 70, have: 'Verus DoomKnight', purpose: 'DPS + debuffs — in 10 of 11 ultra comps', must: true, ultra: true },
  'legion-revenant': { label: 'Legion Revenant', script: 'Legion/Revenant/0LegionRevenant.cs', when: 70, have: 'Legion Revenant', purpose: 'best generalist farm + party support', must: true, hours: 3 },
  'dragon-of-time': { label: 'Dragon of Time', script: 'Other/Classes/DragonOfTime.cs', when: 75, have: 'Dragon of Time', purpose: 'DPS / farm / tank' },
  'void-highlord': { label: 'Void Highlord', script: 'Nation/VHL/0VoidHighlord.cs', when: 70, have: 'Void Highlord', purpose: 'solo DPS (long Nulgath grind)', hours: 3 },
  'forge-enhancements': { label: 'Forge enhancements', script: 'Enhancement/UnlockForgeEnhancements.cs', when: 80, haveQuest: 8738, purpose: 'endgame enhancements', must: true, hours: 3 },
  // One Forge enhancement at a time for the ultra seats: entry points of the same script (each levels to 100 first).
  'forge-valiance': { label: 'Valiance (Forge)', script: 'Enhancement/UnlockForgeEnhancements.cs', entry: 'HerosValiance', when: 50, haveQuest: 8741, purpose: 'the Valiance weapon enhancement for the ArchPaladin / StoneCrusher ultra seats', ultra: true },
  'forge-ravenous': { label: 'Ravenous (Forge)', script: 'Enhancement/UnlockForgeEnhancements.cs', entry: 'Ravenous', when: 50, haveQuest: 9560, purpose: 'the Ravenous weapon enhancement for the ultra DPS seat', ultra: true },
  'kings-echo': { label: "King's Echo", script: 'Other/Classes/KingsEcho.cs', when: 80, have: "King's Echo", purpose: 'caster DPS — in 8 of 11 ultra comps', must: true, ultra: true },
  'arcana-invoker': { label: 'Arcana Invoker', script: 'Other/Classes/ArcanaInvoker[Non-Insignia].cs', when: 80, have: 'Arcana Invoker', purpose: 'farm / DPS generalist' },
  'archmage': { label: 'ArchMage', script: 'Other/Classes/ArchMage/0ArchMage.cs', when: 85, have: 'ArchMage', purpose: 'best farm class', hours: 3 },

  // ---- gear (Skua Farmer Joe kit order + AQW Progression Guide "51% damage weapons") ----
  'awe-enhancements': { label: 'Blade of Awe rep (Awe enhancements)', script: 'Farm/REP/BladeofAweREP.cs', when: 30, haveQuest: 2937, purpose: 'unlocks Awe Blast / Spiral Carve / Health Vamp / Mana Vamp weapon enhancements', must: true, gear: true },
  'burning-blade': { label: 'Burning Blade', script: 'Other/Weapons/BurningBlade.cs', when: 50, have: 'Burning Blade', purpose: 'strong mid-game weapon', gear: true },
  'cape-of-awe': { label: 'Cape of Awe', script: 'Good/GearOfAwe/CapeOfAwe.cs', when: 60, have: 'Cape of Awe', purpose: 'Awe cape (unlocks cape enhancements path)', gear: true },
  'join-legion': { label: 'Join the Legion', script: 'Legion/JoinLegion.cs', when: 50, haveQuest: 793, needsAc: 1080, purpose: 'Legion membership: Legion Revenant, Legion tokens, Legion gear (Undead Warrior costs 1,080 AC)', gear: true },
  'archfiend-doomlord': { label: 'ArchFiend DoomLord', script: 'Nation/AFDL/0DoAll.cs', when: 75, have: 'ArchFiend DoomLord', purpose: '+30% damage to all monsters, +25% class points / XP / gold / rep', must: true, gear: true, hours: 3 },
  'necrotic-sword-of-doom': { label: 'Necrotic Sword of Doom', script: 'Evil/NSoD/0NecroticSwordOfDoom.cs', when: 90, have: 'Necrotic Sword of Doom', allDamage: 0.51, purpose: '51% damage to all monsters (endgame weapon)', must: true, gear: true, hours: 3 },
  'exalted-apotheosis': { label: 'Exalted Apotheosis', script: 'Other/Weapons/ExaltedApotheosisPreReqs.cs', when: 90, have: 'Exalted Apotheosis', allDamage: 0.51, purpose: '51% damage weapon from /timeinn (needs the daily ultras\' insignias)', gear: true, hours: 3 },
  // The weapon route (vault STRATEGY/Weapon-Route, 2026-09-29): the cheapest 30% (the ultra minimum) and the best 40%.
  'burning-blade-of-abezeth': { label: 'Burning Blade of Abezeth', script: 'Other/Weapons/BurningBladeOfAbezeth.cs', when: 80, have: 'Burning Blade Of Abezeth', allDamage: 0.30, purpose: '30% damage to all monsters - the quickest weapon to the ultra minimum (Celestial Arena story, 20 Aranx kills, 1.5 M gold)', gear: true },
  'void-avenger-scythe': { label: 'Void Avenger Scythe', script: 'Other/Weapons/VoidAvengerScythe.cs', when: 80, have: 'Void Avenger Scythe', allDamage: 0.40, purpose: '40% damage to all monsters - the recommended ultra weapon (quest 5025 "Eternal Rest")', gear: true },
  'legion-tokens': { label: 'Legion tokens', script: 'Legion/LegionTokens/0BestAvailableLegionTokens.cs', when: 80, haveQty: ['Legion Token', 25000], requiresQuest: 793, repeat: 'daily', hours: 1, purpose: 'currency for Legion shop armors, weapons and pets', gear: true },
  'hollowborn-reaper-scythe': { label: "Hollowborn Reaper's Scythe", script: 'Hollowborn/HollowbornReapersScythe.cs', when: 100, have: "Hollowborn Reaper's Scythe", allDamage: 0.40, purpose: '40% damage to all monsters (Rank 9 Hollowborn, ~45 M gold of Fiend Essence)', gear: true, hours: 3 },
};
GOALS['legion-revenant'].requiresQuest = 793;
GOALS['lord-of-order'].requiresQuest = 3881;   // its dailies open after the 13 Lords of Chaos story
GOALS['legion-revenant'].purpose += ' (needs Legion membership)';

// Class per ultra, from the Skua v3 ultra scripts (role order = taunt slots).
const ULTRAS = {
  ultraezrajal: { label: 'Ultra Ezrajal', enh: 'default', cadence: 'daily', classes: ["King's Echo", 'Lord of Order', 'StoneCrusher', 'Verus DoomKnight'] },
  ultrawarden: { label: 'Ultra Warden', enh: 'default', cadence: 'daily', classes: ["King's Echo", 'Lord of Order', 'StoneCrusher', 'Verus DoomKnight'] },
  ultraengineer: { label: 'Ultra Engineer', enh: 'default', cadence: 'daily', classes: ["King's Echo", 'Lord of Order', 'StoneCrusher', 'Verus DoomKnight'] },
  ultratyndarius: { label: 'Ultra Avatar Tyndarius', enh: 'tyndarius', cadence: 'daily', classes: ["King's Echo", 'Lord of Order', 'StoneCrusher', 'Verus DoomKnight'] },
  championdrakath: { label: 'Champion Drakath', enh: 'drakath', cadence: 'weekly', classes: ['ArchPaladin', 'Lord of Order', 'StoneCrusher'] },
  ultranulgath: { label: 'Ultra Nulgath', enh: 'nulgath', cadence: 'weekly', classes: ["King's Echo", 'Lord of Order', 'StoneCrusher', 'Verus DoomKnight'] },
  ultradrago: { label: 'Ultra Drago', enh: 'default', cadence: 'weekly', classes: ["King's Echo", 'Lord of Order', 'StoneCrusher', 'Verus DoomKnight'] },
  ultradarkon: { label: 'Ultra Darkon', enh: 'darkon', cadence: 'weekly', classes: ["King's Echo", 'Lord of Order', 'StoneCrusher', 'Verus DoomKnight'] },
  ultradage: { label: 'Ultra Dage', enh: 'dage', cadence: 'weekly', classes: ['ArchPaladin', 'ArchFiend', 'Lord of Order', 'Verus DoomKnight'] },   // no KE at Dage (1★, Research-2026-10-20)
  ultraspeaker: { label: 'Ultra Speaker', enh: 'speaker', cadence: 'weekly', classes: ['ArchPaladin', 'Lord of Order', 'StoneCrusher', 'Verus DoomKnight'] },
  ultragramiel: { label: 'Ultra Gramiel', enh: 'gramiel', cadence: 'weekly', classes: ['ArchPaladin', 'Lord of Order', 'StoneCrusher'] },
};

// Combat mode per class when fighting an ultra (modes that exist in Skua's AdvancedSkills.json).
const ULTRA_MODE = { ArchPaladin: 'Def', StoneCrusher: 'Supp', "King's Echo": 'Base', 'Verus DoomKnight': 'Base', 'Lord of Order': 'Base' };

function stageFor(level) { return STAGES.find((s) => level >= s.from && level <= s.to) || STAGES[0]; }

function ultraFor(map) {
  const base = String(map || '').split('-')[0].toLowerCase();
  return ULTRAS[base] ? { id: base, ...ULTRAS[base] } : null;
}

// Goal list for a persona: its own path first, then every `must` goal it doesn't have in its path (endgame convergence),
// then the rest. Once a level passes 90 everyone chases the same remaining must-haves.
// Someone else's specialty waits until late game (80) for must-haves and end game (90) for the rest, so the party
// keeps different classes until then. Without a persona every goal keeps its own level.
function goalsFor(persona) {
  const path = persona ? persona.path : [];
  const order = [...path];
  for (const [id, g] of Object.entries(GOALS)) if (g.must && !order.includes(id)) order.push(id);
  for (const id of Object.keys(GOALS)) if (!order.includes(id)) order.push(id);
  return order.map((id) => {
    const g = GOALS[id];
    const signature = path.includes(id);
    const when = !persona || signature ? g.when : Math.max(g.when, g.must ? 80 : 90);
    return { id, ...g, when, signature };
  });
}

// Assign each party member one class for this ultra so nobody doubles up. `members` = [{ id, owned: [class names],
// prefer: [class names] }]; `taken` = classes already covered (e.g. the main account's class).
function assignUltraClasses(ultra, members, taken = []) {
  const need = ultra.classes.filter((c) => !taken.map((t) => t.toLowerCase()).includes(c.toLowerCase()));
  const out = {};
  const has = (m, c) => m.owned.some((o) => o.toLowerCase() === c.toLowerCase());
  const left = [...members];
  // Pass 1: members whose preferred class is needed. Pass 2: anyone who owns a needed class.
  for (const pass of [1, 2]) {
    for (const m of [...left]) {
      const pick = pass === 1
        ? (m.prefer || []).find((c) => need.includes(c) && has(m, c))
        : need.find((c) => has(m, c));
      if (!pick) continue;
      out[m.id] = pick;
      need.splice(need.indexOf(pick), 1);
      left.splice(left.indexOf(m), 1);
    }
  }
  for (const m of left) out[m.id] = null;   // no needed class owned: fight with their best own class
  return { assigned: out, missing: need };
}

module.exports = { STAGES, GOALS, ULTRAS, ULTRA_MODE, stageFor, ultraFor, goalsFor, assignUltraClasses };
