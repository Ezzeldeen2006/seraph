// Knowledge the brain uses, generated from the auqw/Scripts clone so a `git pull` keeps it current:
//  quests (QuestData.json), skill rotations (Skills/AdvancedSkills.json), junk items, class enhancement tables
//  (CoreAdvanced.cs), dailies (CoreDailies.cs), seasonal events (Seasonal/*), leveling routes (CoreFarms.cs).
const fs = require('fs');
const path = require('path');
const { P } = require('./paths');
const { readJson, writeJson } = require('./util');
const { translate, methods } = require('./skua/translate');

const K = { quests: null, skills: null, junk: null, enh: null, dailies: null, events: null, generatedAt: null };

// ---------------- quests ----------------
// The compact copy (lib/questindex.js) when it is current; the full 20 MB file only until it has been built.
function quests() {
  if (!K.quests) {
    const list = require('./questindex').read() || readJson(path.join(P.SCRIPTS, 'QuestData.json'), []);
    K.quests = new Map(list.map((q) => [q.ID, q]));
  }
  return K.quests;
}
// A fresh compact copy was written: drop the parsed quests so the next read takes it.
function questsChanged() { K.quests = null; }
const quest = (id) => quests().get(Number(id)) || null;

// ---------------- skills ----------------
function skills() {
  if (!K.skills) {
    K.skills = readJson(path.join(P.SCRIPTS, 'Skills', 'AdvancedSkills.json'), null)
      || readJson(require('path').join(process.env.SKUA_HOME || '', 'data', 'AdvancedSkills.json'), {});
    K.skillsLower = new Map(Object.keys(K.skills).map((k) => [k.toLowerCase(), k]));
  }
  return K.skills;
}
// Rotation for a class and mode (Farm / Solo / Base…), falling back to Base.
function rotation(className, mode = 'Base') {
  const all = skills();
  const key = K.skillsLower.get(String(className || '').toLowerCase());
  const cls = key ? all[key] : null;
  if (!cls) return null;
  return cls[mode] || cls.Base || Object.values(cls)[0];
}

function junk() {
  if (!K.junk) {
    const j = readJson(path.join(P.SCRIPTS, 'JunkItems.json'), []);
    K.junk = new Set((Array.isArray(j) ? j : Object.values(j).flat()).map((x) => String(x && x.Name ? x.Name : x).toLowerCase()));
  }
  return K.junk;
}

// ---------------- enhancements (CoreAdvanced.cs) ----------------
const WEAPON_RANK = { Dauntless: 10, Ravenous: 10, Valiance: 9, Arcanas_Concerto: 9, Elysium: 9, Acheron: 9, Praxis: 8, Smite: 8, Lacerate: 8, Forge: 6, Awe_Blast: 4, Spiral_Carve: 4, Health_Vamp: 4, Mana_Vamp: 4, Powerword_Die: 3, None: 0 };
const TYPE_ID = { Fighter: 2, Thief: 3, Hybrid: 5, Wizard: 6, Healer: 7, SpellBreaker: 8, Lucky: 9 };
const WEAPON_PROC = { None: 0, Forge: 1, Spiral_Carve: 2, Awe_Blast: 3, Health_Vamp: 4, Mana_Vamp: 5, Powerword_Die: 6, Lacerate: 7, Smite: 8, Valiance: 9, Arcanas_Concerto: 10, Acheron: 11, Elysium: 12, Praxis: 13, Dauntless: 14, Ravenous: 15 };
const CAPE_PATTERN = { None: 0, Forge: 10, Absolution: 11, Avarice: 12, Vainglory: 24, Penitence: 29, Lament: 30 };
const HELM_PATTERN = { None: 0, Forge: 10, Vim: 25, Examen: 26, Pneuma: 27, Anima: 28, Hearty: 32 };
// unlock function name for each special
const UNLOCK_FOR = {
  weapon: { Forge: 'ForgeWeapon', Spiral_Carve: 'Awe', Awe_Blast: 'Awe', Health_Vamp: 'Awe', Mana_Vamp: 'Awe', Powerword_Die: 'Awe', Lacerate: 'Lacerate', Smite: 'Smite', Valiance: 'Valiance', Arcanas_Concerto: 'ArcanasConcerto', Acheron: 'Acheron', Elysium: 'Elysium', Praxis: 'Praxis', Dauntless: 'Dauntless', Ravenous: 'Ravenous' },
  cape: { Forge: 'ForgeCape', Absolution: 'Absolution', Avarice: 'Avarice', Vainglory: 'Vainglory', Penitence: 'Penitence', Lament: 'Lament' },
  helm: { Forge: 'ForgeHelm', Vim: 'Vim', Examen: 'Examen', Pneuma: 'Pneuma', Anima: 'Anima', Hearty: 'Hearty' },
};

function parseLibrary(body) {
  const out = {};
  const lines = body.split(/\r?\n/);
  let cases = []; let region = ''; let stmt = ''; let group = null;
  const flush = () => {
    if (!cases.length || !group) { cases = []; group = null; return; }
    if (!group.type) {
      const m = /^\s*(Lucky|Luck|Fighter|Thief|Hybrid|Wizard|Healer|SpellBreaker)\b\s*-\s*([A-Za-z_ ]+?)(?:\s*-|$)/i.exec(region);
      if (m) { group.type = /^luck/i.test(m[1]) ? 'Lucky' : m[1][0].toUpperCase() + m[1].slice(1); const w = m[2].trim().replace(/\s+/g, '_'); if (WEAPON_PROC[w] !== undefined) group.weapon.push(w); }
    }
    for (const c of cases) out[c] = { type: group.type || null, weapon: [...new Set(group.weapon)], cape: [...new Set(group.cape)], helm: [...new Set(group.helm)], requires: [...new Set(group.requires)] };
    cases = []; group = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    const reg = /^#region\s+(.*)$/.exec(line);
    if (reg) { region = reg[1]; continue; }
    const cm = /^case\s+"([^"]+)"\s*:/.exec(line);
    if (cm) {
      if (group && group.closed) flush();
      if (!group) group = { type: null, weapon: [], cape: [], helm: [], requires: [], closed: false };
      cases.push(cm[1].toLowerCase());
      continue;
    }
    if (!group) continue;
    stmt += ' ' + line;
    if (!/;\s*$/.test(line) && !/goto default;/.test(line)) continue;
    const s = stmt; stmt = '';
    if (/goto default/.test(s) && /if\s*\(/.test(s)) { for (const u of s.matchAll(/!u(\w+)\(\)/g)) group.requires.push(u[1]); continue; }
    let m = /EnhancementType\.(\w+)/.exec(s); if (/\btype\s*=/.test(s) && m) group.type = m[1];
    if (/wSpecial\s*=/.test(s)) for (const x of s.matchAll(/WeaponSpecial\.(\w+)/g)) group.weapon.push(x[1]);
    if (/cSpecial\s*=/.test(s)) for (const x of s.matchAll(/CapeSpecial\.(\w+)/g)) group.cape.push(x[1]);
    if (/hSpecial\s*=/.test(s)) for (const x of s.matchAll(/HelmSpecial\.(\w+)/g)) group.helm.push(x[1]);
    if (/\bbreak;/.test(s)) { group.closed = true; flush(); }
  }
  flush();
  return out;
}

function genEnhancements() {
  const src = fs.readFileSync(path.join(P.SCRIPTS, 'CoreAdvanced.cs'), 'utf8');
  const unlocks = {};
  for (const m of src.matchAll(/public bool u(\w+)\(\)\s*=>\s*Core\.isCompletedBefore\((\d+)\)/g)) unlocks[m[1]] = Number(m[2]);
  const body = (name) => {
    const i = src.indexOf(name);
    if (i < 0) return '';
    const start = src.indexOf('{', i);
    let depth = 0;
    for (let j = start; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(start, j);
    }
    return '';
  };
  const data = {
    unlocks,
    forge: parseLibrary(body('bool ForgeEnhancementLibrary()')),
    awe: parseLibrary(body('void AweEnhancementLibrary()')),
    basicShops: { Fighter: [141, 768], Thief: [142, 767], Hybrid: [143, 766], Wizard: [144, 765], Healer: [145, 762], SpellBreaker: [146, 764], Lucky: [147, 763] },
    aweShops: { Fighter: 635, Thief: 637, Hybrid: 633, Wizard: 636, SpellBreaker: 636, Healer: 638, Lucky: 639 },
    forgeShops: { weapon: 2142, cape: 2143, helm: 2164, map: 'forge' },
    typeId: TYPE_ID, weaponProc: WEAPON_PROC, capePattern: CAPE_PATTERN, helmPattern: HELM_PATTERN, unlockFor: UNLOCK_FOR, weaponRank: WEAPON_RANK,
  };
  return data;
}

// Bootiest's community sheet, "All Classes Forge Enhancements" (the owner 2026-10-13: "an Excel sheet that tells you the
// best forge ench for every class"), built into lib/forge-sheet.json by <work>\forgesheet\build.js: per class the
// enhancement type and, per slot, the specials in order of preference. A type word in a slot ("Pneuma, Wizard") = the
// basic enhancement.
let SHEET = null;
function forgeSheet() {
  if (!SHEET) SHEET = (readJson(path.join(__dirname, 'forge-sheet.json'), {}) || {}).classes || {};
  return SHEET;
}

// Decide the enhancement plan for a class given which unlocks the account has (Set of unlock names). The sheet first:
// for each slot its first unlocked special; a slot where none is unlocked takes CoreAdvanced's pick (skuaPlan), whose
// Awe weapon is also the cheap weapon while gold is short.
function enhancementPlan(className, unlocked, level) {
  const base = skuaPlan(className, unlocked, level);
  const row = forgeSheet()[String(className || '').toLowerCase()];
  if (!row) return base;
  const e = enh();
  const tables = { weapon: e.weaponProc, cape: e.capePattern, helm: e.helmPattern };
  const pick = (slot) => {
    for (const o of row[slot] || []) {
      if (/^(lucky|luck|wizard|fighter|healer|thief|hybrid|spellbreaker)$/i.test(o)) return { v: null, sheet: true };   // basic
      if (!(o in tables[slot])) continue;
      const need = e.unlockFor[slot][o];
      if (!need || unlocked.has(need)) return { v: o, sheet: true };
    }
    return { v: base[slot], sheet: false };
  };
  const w = pick('weapon');
  const c = pick('cape');
  const h = pick('helm');
  // The Awe weapon for the cheap plan: the sheet's own Awe pick when it lists one, else CoreAdvanced's.
  const aweFirst = (row.weapon || []).find((o) => Number(e.weaponProc[o] || 0) > 1 && Number(e.weaponProc[o] || 0) <= 6 && unlocked.has('Awe'));
  const weaponAwe = aweFirst || base.weaponAwe || (Number(e.weaponProc[base.weapon] || 0) <= 6 ? base.weapon : null) || null;
  return { source: w.sheet || c.sheet || h.sheet ? 'sheet' : base.source, type: row.type, weapon: w.v || (w.sheet ? null : weaponAwe), cape: c.v, helm: h.v, weaponAwe, shopTier: level >= 50 ? 1 : 0 };
}

function skuaPlan(className, unlocked, level) {
  const e = enh();
  const name = String(className || '').toLowerCase();
  const pick = (options, slot) => {
    const ok = options.filter((o) => o !== 'None' && (!e.unlockFor[slot][o] || unlocked.has(e.unlockFor[slot][o])));
    if (slot === 'weapon') ok.sort((a, b) => (e.weaponRank[b] || 0) - (e.weaponRank[a] || 0));
    return ok[0] || null;
  };
  const forge = e.forge[name];
  const awe = e.awe[name];
  const type = (awe && awe.type) || (forge && forge.type) || guessType(name);
  const weapon = awe && unlocked.has('Awe') ? pick(awe.weapon, 'weapon') : null;
  // weaponAwe: the cheap weapon pick (10k gold) for while forge specials (60k-300k each) wait for gold (cheapPlan).
  if (forge && forge.type && forge.requires.every((r) => unlocked.has(r))) {
    return { source: 'forge', type: forge.type, weapon: pick(forge.weapon, 'weapon'), cape: pick(forge.cape, 'cape'), helm: pick(forge.helm, 'helm'), weaponAwe: weapon };
  }
  // Slot by slot (2026-10-13): CoreAdvanced drops a class to Awe as soon as ONE of its forge specials is missing, so
  // all four bots held Vainglory, Absolution, Avarice, Anima, Examen, Vim, Pneuma, Lacerate and Smite and wore none
  // of them (Void Highlord without Valiance = basic helm and cape; ArchPaladin without Penitence = no Forge helm).
  // The specials of the class's own forge set that ARE unlocked go on their slot; the weapon keeps the Awe pick when
  // that ranks higher; the rest stays basic.
  if (forge && forge.type) {
    const w = pick(forge.weapon, 'weapon');
    const cape = pick(forge.cape, 'cape');
    const helm = pick(forge.helm, 'helm');
    if (w || cape || helm) {
      const best = w && (e.weaponRank[w] || 0) >= (e.weaponRank[weapon] || 0) ? w : weapon;
      return { source: 'forge-partial', type: forge.type, weapon: best, cape, helm, weaponAwe: weapon, shopTier: level >= 50 ? 1 : 0 };
    }
  }
  return { source: awe ? 'awe' : forge ? 'forge-fallback' : 'guess', type, weapon, cape: null, helm: null, shopTier: level >= 50 ? 1 : 0 };
}

// A forge special costs 60k-300k gold at level 100 (Pneuma, Avarice, Anima, Vainglory 300k; Lacerate 150k; the Forge
// helm 60k), a basic or Awe enhancement ~10k (live 2026-10-13). The same plan without them, for a character short of gold.
function isForgeSpecial(slot, special, e = enh()) {
  if (!special) return false;
  if (slot === 'weapon') return special === 'Forge' || Number(e.weaponProc[special] || 0) > 6;
  return true;   // every cape and helm special comes from the forge shops
}
function cheapPlan(plan) {
  if (!plan) return plan;
  const e = enh();
  return { ...plan, source: `${plan.source} (cheap)`, weapon: isForgeSpecial('weapon', plan.weapon, e) ? (plan.weaponAwe || null) : plan.weapon, cape: null, helm: null };
}

// Enhancement plan for an ultra boss fight (Skua Ultrasv3 UltraEnhancements presets per boss and class, corrected to the
// community builds on 2026-10-20: Lucky class for AP/LoO/VDK/VHL/KE, KE Ravenous/Examen/Vainglory, Dragon of Time Wizard;
// vault STRATEGY/Research-2026-10-20 item 1). Specials the account hasn't unlocked fall back to the preset's alternative,
// then to the normal class plan. Never Vainglory where the boss cuts healing (Darkon, Nightbane's Dire Wound -80 %):
// VG's -50 % healing intake on top turns heals negative.
const NO_VAINGLORY = /darkon|nightbane/i;
let ULTRA_ENH = null;
function ultraPlan(className, boss, unlocked, level) {
  if (!ULTRA_ENH) ULTRA_ENH = require('./ultra-enhancements.json');
  const e = enh();
  const tables = Object.fromEntries(Object.entries(ULTRA_ENH).map(([k, v]) => [k.toLowerCase(), v]));
  const name = String(className || '').toLowerCase();
  const preset = (tables[String(boss || 'default').toLowerCase()] || {})[name] || (tables.default || {})[name];
  const base = enhancementPlan(className, unlocked, level);
  if (!preset) return { ...base, source: `${base.source} (no ultra preset)` };
  const ok = (slot, v) => v && (!e.unlockFor[slot][v] || unlocked.has(e.unlockFor[slot][v]));
  const weapon = ok('weapon', preset.weapon) ? preset.weapon : ok('weapon', preset.weaponFallback) ? preset.weaponFallback : base.weapon;
  let cape = ok('cape', preset.cape) ? preset.cape : base.cape;
  if (cape === 'Vainglory' && NO_VAINGLORY.test(String(boss || ''))) cape = ok('cape', 'Lament') ? 'Lament' : ok('cape', 'Penitence') ? 'Penitence' : null;
  return { source: `ultra:${boss || 'default'}`, type: preset.type, weapon, cape, helm: ok('helm', preset.helm) ? preset.helm : base.helm, shopTier: level >= 50 ? 1 : 0 };
}

function guessType(name) {
  if (/healer|cleric|paladin|priest/.test(name)) return 'Healer';
  if (/mage|sorcer|wizard|caster|mancer|witch|invoker|warlock/.test(name)) return 'Wizard';
  if (/rogue|thief|ninja|assassin|ranger|hunter/.test(name)) return 'Thief';
  if (/warrior|knight|berserker|barbarian|fighter/.test(name)) return 'Fighter';
  return 'Lucky';
}

// ---------------- dailies (CoreDailies.cs) ----------------
// translate() leaves two hunt steps with no map ("monsterMapID undefined") next to the real DailyRoutine steps of some
// dailies, and one mapless hunt makes a daily "not runnable". These two are cleaned and switched on (2026-09-22: the
// Dage's Scroll Fragment and Elders' Blood clocks gate Hero's Valiance and Ravenous); the other dailies with the same
// problem stay off until one is needed and tested. `enough` = the Skua script's own stop (it returns at that count).
const FIXED_DAILIES = {
  DagesScrollFragment: { enough: ["Dage's Scroll Fragment", 13] },   // Drakath the Eternal (Hero's Valiance) needs 13
  EldersBlood: { enough: ["Elders' Blood", 20] },                     // Roentgenium of Nulgath (Ravenous, Void Highlord)
};
const DAILIES_GEN = 3;   // bump to rebuild a cached dailies.json when the generator changes

function genDailies() {
  const file = path.join(P.SCRIPTS, 'CoreDailies.cs');
  const src = fs.readFileSync(file, 'utf8');
  const all = methods(src);
  const out = [];
  for (const [name, body] of Object.entries(all)) {
    if (['ScriptMain', 'DailyRoutine', 'CheckDailyv2', 'CheckDaily'].includes(name)) continue;
    const ids = [...body.matchAll(/(?:CheckDailyv2|CheckDaily|DailyRoutine|EnsureAccept)\(\s*(\d+)/g)].map((m) => Number(m[1]));
    if (!ids.length) continue;
    let steps = [];
    try { steps = translate(P.SCRIPTS, 'CoreDailies.cs', name).steps; } catch { steps = []; }
    // DailyRoutine(quest, map, monster, item, quant, isTemp, cell, pad) -> accept, hunt, turnin
    for (const m of body.matchAll(/DailyRoutine\(([\s\S]*?)\);/g)) {
      const { callArgs } = require('./skua/translate');
      const a = callArgs(m[1], ['quest', 'map', 'monster', 'item', 'quant', 'isTemp', 'cell', 'pad', 'publicRoom']);
      if (typeof a.quest === 'number' && typeof a.map === 'string') {
        steps.push({ kind: 'accept', quest: a.quest, map: a.map.toLowerCase(), monsters: [], item: null, qty: 1 });
        steps.push({ kind: 'hunt', quest: a.quest, map: a.map.toLowerCase(), monsters: typeof a.monster === 'string' ? [a.monster] : [], item: a.item, qty: typeof a.quant === 'number' ? a.quant : 1, temp: a.isTemp !== false, cell: a.cell || null, pad: a.pad || null });
        steps.push({ kind: 'turnin', quest: a.quest, map: a.map.toLowerCase(), monsters: [], qty: -1 });
      }
    }
    const fixed = FIXED_DAILIES[name];
    if (fixed && steps.some((s) => s.kind === 'hunt' && s.map)) steps = steps.filter((s) => s.kind !== 'hunt' || s.map);
    const qs = ids.map(quest).filter(Boolean);
    const memberOnly = /!\s*Core\.IsMember\s*\|\|/.test(body) || /if\s*\(\s*!\s*Core\.IsMember\s*\)\s*return/.test(body) || (qs.length > 0 && qs.every((q) => q.Upgrade));
    const needsItems = [...body.matchAll(/if\s*\(\s*!Core\.CheckInventory\("([^"]+)"\)\s*\)[\s\S]{0,120}?return/g)].map((m) => m[1]);
    out.push({
      gen: DAILIES_GEN, name, quests: [...new Set(ids)], memberOnly, needsItems, ...(fixed && fixed.enough ? { enough: fixed.enough } : {}),
      minLevel: Math.max(0, ...qs.map((q) => q.Level || 0)),
      steps: steps.filter((s) => s.kind === 'hunt' || s.kind === 'accept' || s.kind === 'turnin' || s.kind === 'buy' || s.kind === 'quest'),
      // runnable = F2P, no owned-item prerequisite, every hunt has a literal map, and no shop purchase in the flow
      runnable: !memberOnly && !needsItems.length && steps.some((s) => s.kind === 'hunt' && s.map)
        && steps.every((s) => s.kind !== 'hunt' || s.map) && !steps.some((s) => s.kind === 'buy' || s.kind === 'buyquest')
        && !/CheckInventory\("[^"]+"\)\s*\)\s*\{?\s*Core\.Logger\([^)]*own/i.test(body),
    });
  }
  return out;
}

// ---------------- events (Seasonal/) ----------------
// Month windows when each seasonal folder's event usually runs (probing the map confirms it).
const CALENDAR = {
  NewYear: [12, 1], AkibaNewYear: [1, 2], HerosHeartDay: [2], LuckyDay: [3], 'Grenwog(Easter)': [3, 4], AprilFools: [4], EarthDay: [4],
  MayThe4th: [5], FathersDay: [6], FrostvalInJuly: [7], SummerBreak: [6, 7, 8], BackToSchool: [8, 9], TalkLikeaPirateDay: [9],
  Mogloween: [10, 11], AqwBirthday: [10, 11], Friday13th: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], HarvestDay: [11], BlackFriday: [11, 12],
  Frostvale: [12, 1], Carnaval: [2, 3], ObrigadoBrasil: [9], IndonesianDay: [8], SolarNewYear: [3, 4], StarFestival: [7], Eclipse: [4, 10],
  StaffBirthdays: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
};

function genEvents() {
  const root = path.join(P.SCRIPTS, 'Seasonal');
  const out = [];
  for (const folder of fs.readdirSync(root)) {
    const dir = path.join(root, folder);
    if (!fs.statSync(dir).isDirectory()) continue;
    const files = [];
    const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.cs')) files.push(p); } };
    walk(dir);
    const maps = new Set(); const scripts = [];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/isSeasonalMapActive\("([^"]+)"/g)) maps.add(m[1].toLowerCase());
      const rel = path.relative(P.SCRIPTS, f).split(path.sep).join('/');
      const member = /\[mem\]|member/i.test(path.basename(f));
      if (/ScriptMain/.test(text) && !/\/Core[A-Z]/.test('/' + path.basename(f)) && !member) scripts.push(rel);
    }
    out.push({ folder, months: CALENDAR[folder] || [], maps: [...maps], scripts });
  }
  return out;
}

// ---------------- generation ----------------
function generate() {
  const started = Date.now();
  const result = {};
  const tryGen = (name, fn) => { try { const d = fn(); writeJson(path.join(P.KNOWLEDGE, `${name}.json`), d); result[name] = 'ok'; } catch (e) { result[name] = `error: ${e.message}`; } };
  tryGen('enhancements', genEnhancements);
  tryGen('dailies', genDailies);
  tryGen('events', genEvents);
  K.enh = K.dailies = K.events = K.quests = K.skills = K.junk = null;
  writeJson(path.join(P.KNOWLEDGE, 'meta.json'), { generatedAt: new Date().toISOString(), ms: Date.now() - started, result });
  return result;
}

function enh() { if (!K.enh) K.enh = readJson(path.join(P.KNOWLEDGE, 'enhancements.json'), null) || genEnhancements(); return K.enh; }
function dailies() {
  if (K.dailies) return K.dailies;
  const file = path.join(P.KNOWLEDGE, 'dailies.json');
  const cached = readJson(file, null);
  if (Array.isArray(cached) && cached.length && cached[0].gen === DAILIES_GEN) return (K.dailies = cached);
  K.dailies = genDailies();
  try { writeJson(file, K.dailies); } catch (e) { /* read-only knowledge dir: keep it in memory */ }
  return K.dailies;
}
function events() { if (!K.events) K.events = readJson(path.join(P.KNOWLEDGE, 'events.json'), null) || genEvents(); return K.events; }
function meta() { return readJson(path.join(P.KNOWLEDGE, 'meta.json'), {}); }

// Events to probe: calendar window for this month, plus any event the news/game title mentions (by folder words or
// one of its map names), so surprise or shifted events are caught too.
function eventCandidates(date = new Date(), newsText = '') {
  const month = date.getMonth() + 1;
  const squash = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
  const news = squash(newsText);
  const words = (folder) => folder.replace(/\(.*\)/, '').replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  return events().filter((e) => {
    if (!e.maps.length) return false;
    if (e.folder === 'Friday13th') return date.getDay() === 5 && date.getDate() === 13;
    const inNews = news && (news.includes(squash(e.folder)) || e.maps.some((m) => m.length > 4 && news.includes(squash(m)))
      || (words(e.folder).length >= 2 && words(e.folder).every((w) => news.includes(w))));
    if (e.folder === 'StaffBirthdays') return !!inNews;
    return e.months.includes(month) || inNews;
  });
}

module.exports = { generate, quest, quests, questsChanged, rotation, skills, junk, enh, enhancementPlan, cheapPlan, isForgeSpecial, ultraPlan, NO_VAINGLORY, dailies, events, eventCandidates, meta, parseLibrary, guessType };
