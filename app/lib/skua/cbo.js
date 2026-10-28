// CoreBots Options (CBO): the per-character settings file every CoreBots script reads at start
// (<options>/CBO_Storage(<username>).txt, lines "Name: Value", see CoreBots.ReadCBO). Seraph writes the keys it
// has an opinion on before each run, so Skua scripts follow Seraph's rules; every other key is left as it is.
'use strict';
const fs = require('fs');
const path = require('path');

// Seraph's opinions, from the bot's settings and class plan, then the class ladder's step for this fight.
async function keysFor(bot) {
  const keys = await baseKeys(bot);
  // Normal rotations unless the class ladder (lib/fightplan.js) says otherwise for this task: the options file keeps
  // every key, so a careful mode from an earlier fight must not stick.
  keys.SoloModeSelect = 'Base';
  keys.FarmModeSelect = 'Base';
  try { Object.assign(keys, require('../fightplan').cboKeys(bot) || {}); } catch (e) { /* no ladder */ }
  return keys;
}

async function baseKeys(bot) {
  const keys = {};
  // The party's room when the character is in the party (one room for everyone, 2026-09-19), a private room when one
  // is set for the character, otherwise public rooms (real players help with bosses).
  let room = (bot.settings && bot.settings.privateRoom) || (bot.hub && bot.hub.partyRoom ? bot.hub.partyRoom(bot) : null);
  // Crowded content (lib/crowd.js, the owner 2026-09-25): normal public rooms on Artix, where other players help.
  const crowd = require('../crowd');
  if (!(bot.settings && bot.settings.privateRoom) && !(bot.current && bot.current.raid) && !(bot.hub && bot.hub.settings && bot.hub.settings.crowd === false)
    && crowd.kindOf(bot.current) === 'crowd') room = null;
  // Ultras are never fought in a public lobby (the owner 2026-09-27): a private room even outside the party.
  if (!room && crowd.isPrivate(bot.current)) room = (bot.hub && bot.hub.settings && bot.hub.settings.levelParty && bot.hub.settings.levelParty.room) || 100000;
  // An ultra raid: the raid's one room for all four (hub.beginRaid), also for the owner's main in a seat - his own private
  // room would put him in another instance of the boss map.
  const raid = bot.current && bot.current.raid && bot.hub && bot.hub.raid && bot.hub.raid.id === bot.current.raid ? bot.hub.raid : null;
  if (raid && raid.room) room = raid.room;
  // A crew daily's army fight: the crew's room, for the main too (his private room would be another instance of the boss map).
  const crewRun = bot.current && bot.current.crewScript && bot.hub && bot.hub.crew && bot.hub.crew.id === bot.current.crew ? bot.hub.crew : null;
  if (crewRun && crewRun.room) room = crewRun.room;
  keys.PrivateRooms = room ? 'True' : 'False';
  if (room) keys.PrivateRoomNr = String(room).replace(/\D/g, '') || '100000';
  // Classes: the same picks Seraph's own tasks use (lib/classplan.js route, then persona, then owned).
  // The owner's own account: the classes he chose in the dashboard (Settings), or whatever CoreBots already has.
  // The owner 2026-10-17: never touch his enhancements - CoreBots/v3 auto-enhance is always off on his account, and the
  // Solo / Farm class come with the weapon, helm and cape of HIS outfit for that class (his server loadouts).
  if (bot.account && bot.account.kind === 'guest') {
    const s = bot.settings || {};
    keys.DisableAutoEnhance = 'True';
    // Seraph's Ultras (tools/vendor-ultras.js): his Loadouts keep their own gear, past a Comp's EnhanceWhenAutoEnhanceIsOff.
    keys.SeraphNeverEnhance = 'True';
    // His purpose outfits (2026-10-22): the Farm set comes from the class's "... Farm" outfit when he has one.
    const pieces = async (cls, purpose) => (bot.guestOutfitPieces ? bot.guestOutfitPieces(cls, purpose).catch(() => null) : null);
    for (const [cls, check, n, sel, purpose] of [[s.soloClass, 'SoloEquipCheck', 1, 'SoloClassSelect', null], [s.farmClass, 'FarmEquipCheck', 2, 'FarmClassSelect', 'farm']]) {
      if (!cls) continue;
      keys[sel] = cls;
      const p = bot.current && (bot.current.raid || bot.current.crewScript) ? null : await pieces(cls, purpose);
      const on = !!(p && (p.Weapon || p.he || p.ba));
      keys[check] = on ? 'True' : 'False';
      keys[`Weapon${n}Select`] = (on && p.Weapon) || '';
      keys[`Helm${n}Select`] = (on && p.he) || '';
      keys[`Cape${n}Select`] = (on && p.ba) || '';
    }
    // Boss / Dodge steps (Core.UseBossClass, ClassType.Dodge) kept whatever class was on when these were empty: the
    // first class of his boss list, else his solo class. Gear stays as it is (BossEquipCheck False).
    const boss = (Array.isArray(s.bossClasses) && s.bossClasses[0]) || s.soloClass;
    if (boss) Object.assign(keys, { BossClassSelect: boss, BossModeSelect: 'Base', BossEquipCheck: 'False', DodgeClassSelect: boss, DodgeModeSelect: 'Base', DodgeEquipCheck: 'False' });
    return keys;
  }
  keys.SeraphNeverEnhance = 'False';
  try {
    const classplan = require('../classplan');
    const owned = (await bot.ownedClasses()).map((c) => c.toLowerCase());
    const pick = (job) => { const p = classplan.classFor(bot.id, job, owned); return p ? p.name : null; };
    const solo = pick('solo');
    const farm = pick('farm');
    if (solo) { keys.SoloClassSelect = solo; keys.SoloEquipCheck = 'False'; }
    // Boss / Dodge steps fall back to the class that happens to be on when these are empty (2026-10-19): the solo pick.
    if (solo && !(bot.current && (bot.current.raid || bot.current.crewScript))) Object.assign(keys, { BossClassSelect: solo, BossModeSelect: 'Base', BossEquipCheck: 'False', DodgeClassSelect: solo, DodgeModeSelect: 'Base', DodgeEquipCheck: 'False' });
    if (farm) { keys.FarmClassSelect = farm; keys.FarmEquipCheck = 'False'; }
    // Class kits (lib/kits.js, 2026-10-13): CoreBots puts the kit's weapon, helm and cape on with the class, so a swap
    // inside a script never fights with the other class's enhancements. Only kits built for these same two picks.
    // In an ultra raid v3 seats the classes itself (no Solo/Farm sets) and the seat already wears its own kit
    // (bot.raidSeatGear). v3's per-boss UltraEnhancements stay off: they would buy over forge specials that belong to
    // other classes (the owner 2026-10-13: never re-enhance a forge piece for another class).
    if (bot.current && (bot.current.raid || bot.current.crewScript)) { keys.SoloEquipCheck = 'False'; keys.FarmEquipCheck = 'False'; keys.DisableAutoEnhance = (bot.kitsOn && bot.kitsOn()) ? 'True' : 'False'; }
    else if (bot.kitsOn && bot.kitsOn()) {
      const k = await bot.planKits().catch(() => null);
      const is = (kit, cls) => !!(kit && cls && String(kit.cls).toLowerCase() === String(cls).toLowerCase());
      if (k && (!solo || is(k.solo, solo)) && (!farm || is(k.farm, farm))) Object.assign(keys, require('../kits').cboKeys(k));
    }
  } catch (e) { /* no class data yet: CoreBots keeps the current class */ }
  return keys;
}

// CoreBots finds the file by sfc.myUserName, which the game (and swfworld) gives in lower case. Windows ignores case,
// Linux doesn't: on the laptop CoreBots never saw CBO_Storage(Nova7).txt, so rooms and class picks were ignored.
function write(optionsDir, username, keys) {
  if (!username) return null;
  const lower = String(username).toLowerCase();
  const file = writeOne(optionsDir, lower, keys);
  if (process.platform !== 'win32' && lower !== String(username)) writeOne(optionsDir, String(username), keys);   // older copies
  return file;
}

function writeOne(optionsDir, username, keys) {
  const file = path.join(optionsDir, `CBO_Storage(${username}).txt`);
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== ''); } catch (e) { /* first run */ }
  // On Linux CBO_Storage(Nova7).txt and CBO_Storage(nova7).txt are two files. Start a new one from whatever
  // CoreBots wrote under the other spelling, so bank and pickup settings the scripts saved are not lost.
  if (!lines.length) {
    const want = path.basename(file).toLowerCase();
    try {
      const other = fs.readdirSync(optionsDir).find((f) => f.toLowerCase() === want && f !== path.basename(file));
      if (other) lines = fs.readFileSync(path.join(optionsDir, other), 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
    } catch (e) { /* no options folder yet */ }
  }
  for (const [k, v] of Object.entries(keys)) {
    const i = lines.findIndex((l) => l.split(': ')[0] === k);
    const line = `${k}: ${v}`;
    if (i >= 0) lines[i] = line; else lines.push(line);
  }
  fs.mkdirSync(optionsDir, { recursive: true });
  // tmp + rename: a crash mid-write must not leave CoreBots a truncated options file (rooms and classes lost).
  fs.writeFileSync(`${file}.tmp`, lines.join('\n') + '\n');
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

module.exports = { keysFor, write };
