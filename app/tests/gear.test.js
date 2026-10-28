// Boost gear, ultra enhancement presets, Legion/AC requirements, the barber and "ask a character".
const fs = require('fs');
const path = require('path');
const { FakeGame } = require('./fakegame');
const { Bot } = require('../lib/bot');
const { Brain } = require('../lib/brain');
const { P } = require('../lib/paths');
const gear = require('../lib/gear');
const knowledge = require('../lib/knowledge');
const progression = require('../lib/progression');
const personas = require('../lib/personas');
const stylist = require('../lib/stylist');
const { ask, match } = require('../lib/ask');

function account(id, persona = null) {
  const dir = P.account(id);
  fs.mkdirSync(dir, { recursive: true });
  const loginFile = path.join(dir, 'login.txt');
  fs.writeFileSync(loginFile, `Username: ${id}\nPassword: pw\n`);
  return { id, label: id, username: id, owner: 'test', loginFile, persona, status: 'active' };
}
async function online(id, persona, opts = {}) {
  const game = new FakeGame(opts);
  const bot = new Bot(game, account(id, persona));
  await bot.login();
  return { game, bot };
}

test('gear: reads item boosts and picks the best piece per job, never a weak unenhanced weapon', async () => {
  eq(gear.parseMeta('dmgAll:0.51,Undead:0.3'), { dmgall: 0.51, undead: 0.3 });
  const items = [
    { sName: 'Old Sword', sES: 'Weapon', bEquip: true, EnhLvl: 60, sMeta: '' },
    { sName: 'Lucky Stick', sES: 'Weapon', EnhLvl: 1, sMeta: 'dmgAll:0.05' },
    { sName: 'Undead Slayer Blade', sES: 'Weapon', EnhLvl: 58, sMeta: 'Undead:0.25' },
    { sName: 'Gold Helm', sES: 'he', sMeta: 'gold:0.5' },
    { sName: 'XP Cape', sES: 'ba', sMeta: 'exp:0.2,cp:0.2' },
  ];
  const bank = [{ sName: 'Necrotic Sword of Doom', sES: 'Weapon', EnhLvl: 1, sMeta: 'dmgAll:0.51', ItemID: 9, CharItemID: 9 }];
  const boss = gear.plan(items, gear.wantsFor('boss', 'Undead'), bank);
  eq(boss.find((p) => p.slot === 'Weapon').name, 'Necrotic Sword of Doom', '51% beats everything, even from the bank');
  assert(boss.find((p) => p.slot === 'Weapon').inBank, 'knows it is banked');
  eq(gear.plan(items, gear.wantsFor('boss', 'Undead')).find((p) => p.slot === 'Weapon').name, 'Undead Slayer Blade', 'race boost');
  eq(gear.plan(items, gear.wantsFor('fight')).length, 0, 'a +5% unenhanced stick is not worth a lvl 60 sword');
  eq(gear.plan(items, gear.wantsFor('gold')).map((p) => p.name), ['Gold Helm']);
  eq(gear.plan(items, gear.wantsFor('exp')).map((p) => p.name), ['XP Cape']);
  // stylist never swaps out boosted gear
  const worn = [{ sName: 'ArchFiend DoomLord', sES: 'co', bEquip: true, sMeta: 'dmgAll:0.3', ItemID: 1 }, { sName: 'Celestial Seraph Robes', sES: 'co', ItemID: 2 }];
  eq(stylist.plan(worn, personas.get('sable7').style).equip.length, 0);
});

// 2026-09-22: the game writes boosts as multipliers (Burning Blade "dmgAll:1.15", Blade of Awe "Undead:1.10,...").
// Read raw, two +10% boosts (2.2) beat one +50% (1.5), and every boosted weapon cleared the 30% "big boost" bar.
test('gear: game-format multipliers are read as fractions', async () => {
  eq(gear.parseMeta('dmgAll:1.15'), { dmgall: 0.15 });
  eq(gear.parseMeta('Undead:1.10,Dragonkin:1.10'), { undead: 0.1, dragonkin: 0.1 });
  eq(gear.parseMeta('rep:1.15,gold:1.15,exp:1.15,cp:1.15'), { rep: 0.15, gold: 0.15, exp: 0.15, cp: 0.15 });
  eq(gear.parseMeta('1932'), {}, 'a class id is not a boost');
  const items = [
    { sName: 'Old Sword', sES: 'Weapon', bEquip: true, EnhLvl: 60, sMeta: '' },
    { sName: 'Rocky Club', sES: 'Weapon', EnhLvl: 1, sMeta: 'Elemental:1.05' },
    { sName: 'Two Tens', sES: 'ba', sMeta: 'Undead:1.10,Elemental:1.10' },
    { sName: 'One Fifty', sES: 'ba', sMeta: 'Elemental:1.50' },
  ];
  const picks = gear.plan(items, gear.wantsFor('boss', 'Elemental'));
  eq(picks.find((p) => p.slot === 'Weapon'), undefined, 'a +5% unenhanced club is not worth a lvl 60 sword');
  eq([picks.find((p) => p.slot === 'ba').name, picks.find((p) => p.slot === 'ba').score], ['One Fifty', 50], '+50% beats +10%');
});

test('gear: bot pulls the boss weapon out of the bank and wears it', async () => {
  const { game, bot } = await online('gearbot', 'nova7');
  game.bank = [{ sName: 'Necrotic Sword of Doom', sES: 'Weapon', EnhLvl: 1, sMeta: 'dmgAll:0.51', ItemID: 777, CharItemID: 7770, iQty: 1 }];
  const origPacket = game.packet.bind(game);
  game.packet = (p) => {
    if (p.includes('%bankToInv%')) { const it = game.bank.shift(); game.addItem(it, 1); return null; }
    return origPacket(p);
  };
  eq(await bot.gearUp('boss'), 1);
  eq(game.item('Necrotic Sword of Doom').bEquip, true);
});

test('ultra enhancements: per-boss presets, with fallbacks for locked specials', async () => {
  const none = knowledge.ultraPlan('Lord of Order', 'default', new Set(), 90);
  assert(/ultra:default/.test(none.source), none.source);
  eq(none.type, 'Lucky', 'community class enhancement for LoO (2026-10-20)');
  const awe = knowledge.ultraPlan('Lord of Order', 'default', new Set(['Awe']), 90);
  eq(awe.weapon, 'Awe_Blast', 'Arcanas Concerto locked -> Awe Blast fallback');
  const dage = knowledge.ultraPlan('Verus DoomKnight', 'dage', new Set(['Awe', 'Anima', 'Lament']), 100);
  eq([dage.type, dage.weapon, dage.helm, dage.cape], ['Lucky', 'Health_Vamp', 'Anima', 'Lament'], 'Ultra Dage VDK preset');
  eq(progression.ultraFor('ultradage-1').enh, 'dage');
  assert(/no ultra preset/.test(knowledge.ultraPlan('Healer', 'dage', new Set(), 20).source), 'unknown class -> normal plan');
});

// 2026-10-20 community builds (vault STRATEGY/Research-2026-10-20 item 1): King's Echo is Lucky / Ravenous / Examen /
// Vainglory, never Healer / Elysium; StoneCrusher stays Fighter; no Vainglory where the boss cuts healing.
test('ultra enhancements: King\'s Echo community build, StoneCrusher Fighter, no Vainglory at Darkon/Nightbane', async () => {
  const all = new Set(['Awe', 'Ravenous', 'Valiance', 'Examen', 'Vainglory', 'Lament', 'Penitence', 'Anima', 'Forge', 'ForgeCape', 'Pneuma', 'Elysium']);
  const ke = knowledge.ultraPlan("King's Echo", 'nulgath', all, 100);
  eq([ke.type, ke.weapon, ke.helm, ke.cape], ['Lucky', 'Ravenous', 'Examen', 'Vainglory'], 'KE at Nulgath');
  const keMid = knowledge.ultraPlan("King's Echo", 'default', new Set(['Valiance', 'Examen', 'Vainglory']), 100);
  eq(keMid.weapon, 'Valiance', 'no Ravenous yet -> Valiance');
  eq(knowledge.ultraPlan("King's Echo", 'darkon', all, 100).cape, 'Lament', 'Darkon: no Vainglory');
  eq(knowledge.ultraPlan('Legion Revenant', 'default', all, 100).cape, 'Vainglory', 'LR default preset wears Vainglory');
  eq(knowledge.ultraPlan('Legion Revenant', 'nightbane', all, 100).cape, 'Lament', 'Nightbane: Vainglory swapped for Lament');
  eq(knowledge.ultraPlan('StoneCrusher', 'default', all, 100).type, 'Fighter', 'StoneCrusher heal scales on attack power');
  eq(knowledge.ultraPlan('Dragon of Time', 'default', all, 100).type, 'Wizard', 'DoT Wizard, not Healer');
});

test('brain: Legion goals wait for 1,080 AC or membership; gear goals exist for every account', async () => {
  const d = knowledge.dailies; const e = knowledge.eventCandidates;
  knowledge.dailies = () => []; knowledge.eventCandidates = () => [];
  try {
    const brain = new Brain();
    const { game, bot } = await online('legionless', 'sable7', { level: 55 });
    const day = brain.today(bot); day.enhancedAt = Date.now(); day.styledAt = Date.now();
    brain.state(bot).barberAt = Date.now();
    require('../lib/schedule').markDone(brain.state(bot), 'loo-daily', 'day');   // not about the Lord of Order clock
    brain.goals = () => ({ goals: [{ id: 'join-legion', ...progression.GOALS['join-legion'] }, { id: 'legion-revenant', ...progression.GOALS['legion-revenant'], when: 50 }], paused: [] });
    game.root.world.myAvatar.objData.intCoins = 200;
    eq((await brain.next(bot)).type, 'farmLevel', 'no AC and no Legion -> skip both');
    game.root.world.myAvatar.objData.intCoins = 1500;
    eq((await brain.next(bot)).goal, 'join-legion', 'enough AC -> join');
    for (const p of Object.values(personas.PERSONAS)) assert(progression.goalsFor(p).some((g) => g.id === 'necrotic-sword-of-doom'), `${p.id} has the 51% weapon goal`);
    for (const g of Object.values(progression.GOALS)) assert(fs.existsSync(path.join(P.SCRIPTS, ...g.script.split('/'))), `script ${g.script}`);
  } finally { knowledge.dailies = d; knowledge.eventCandidates = e; }
});

test('barber: picks the persona hairstyle from the shop and sends the game packets', async () => {
  const { game, bot } = await online('barberbot', 'nova7', { level: 10 });
  const o = game.root.world.myAvatar.objData;
  Object.assign(o, { HairID: 375, intColorSkin: 111, intColorHair: 1, intColorEye: 2 });
  const b = bot.persona.barber;
  const hex = (c) => parseInt(String(c).replace('#', ''), 16);
  const want = String(b.hair[0]).replace(/[\^$]/g, '');   // the first pick, written as a pattern
  const calls = [];
  const orig = game.gameFn.bind(game);
  game.gameFn = (p, a) => {
    calls.push([p, ...a]);
    if (p === 'world.sendLoadHairShopRequest') game.root.world.hairshopinfo = { HairShopID: 1, hair: [{ HairID: '2', sName: 'Blank' }, { HairID: '44', sName: 'Braid3' }, { HairID: '45', sName: want }] };
    if (p === 'world.sendChangeColorRequest') Object.assign(o, { intColorSkin: a[0], intColorHair: a[1], intColorEye: a[2], HairID: a[3] });
    if (p === 'world.sendChangeArmorColorRequest') Object.assign(o, { intColorBase: a[0], intColorTrim: a[1], intColorAccessory: a[2] });
    return orig(p, a);
  };
  eq(await bot.visitBarber(), true);
  const change = calls.find((c) => c[0] === 'world.sendChangeColorRequest');
  eq(change.slice(1), [111, hex(b.hairColor), hex(b.eyeColor), 45], `keeps skin, the persona's hair and eye colours, ${want}`);
  assert(calls.some((c) => c[0] === 'world.sendChangeArmorColorRequest'), 'armor colours');
  assert(calls.some((c) => c[0] === 'ui.mcPopup.fClose'), 'closes the customize popup');
});

test('ask: answers from backpack, bank, history and quests - and says no when it does not know', async () => {
  eq(match('blade of awe', ['Blade of Awe', 'Cape of Awe', 'Awe Blast'])[0].name, 'Blade of Awe');
  const brain = new Brain();
  const { game, bot } = await online('asker', 'oren7', { level: 20 });
  game.root.world.myAvatar.items.push({ sName: 'Blade of Awe', ItemID: 501, CharItemID: 501, sES: 'Weapon', iQty: 1 });
  game.bank = [{ sName: 'Moglin MEAL', ItemID: 502, CharItemID: 502, iQty: 3, bCoins: 1 }];
  bot.remember('drop', { item: 'Moglin MEAL', qty: 1, ac: true });
  bot.remember('quest', { id: 4007, name: 'Quest to Slay Bone Berserker' });
  bot.remember('death', { map: 'deathpits', cell: 'r5' });
  const A = async (q) => (await ask(bot, q, { brain, persona: bot.persona })).answer;
  assert(/Blade of Awe: yes - 1 in my backpack/.test(await A('did you get blade of awe?')), await A('did you get blade of awe?'));
  const meal = await A('do you have moglin meal');
  assert(/3 in the bank/.test(meal) && /Dropped for me 1x/.test(meal), meal);
  assert(/^No\./.test(await A('did you find the Necrotic Sword of Doom?')), 'honest no');
  assert(/turned in 1x/.test(await A('did you do quest to slay bone berserker?')), await A('did you do quest to slay bone berserker?'));
  assert(/13 Lords of Chaos story: not yet/.test(await A('did you finish 13 lords of chaos?')), await A('did you finish 13 lords of chaos?'));
  assert(/\/battleon/.test(await A('where are you?')), 'where');
  assert(/1 deaths in the last 24 h/.test(await A('how many deaths?')), await A('how many deaths?'));
  assert(/gold/.test(await A('how much gold do you have?')), 'gold');
  eq((await ask(bot, 'did you get blade of awe?', { brain })).who, 'Oren');
  brain.today(bot).dailies.EldersBlood = 'done';
  assert(/Daily EldersBlood today: done/.test(await A('did you do Elders Blood?')), await A('did you do Elders Blood?'));
});
