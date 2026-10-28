// AQW 5.0 (Game4000r1.swf, client 5.01, 2026-10-10) and Skua 1.4.5.0: inventory pools (InvCat), the new skua.swf
// calls (Inventory.as, Shop.getUnmetPurchaseRequirements, Auras.GetAuraSnapshots) and HUD aura stacks, in the skua.swf
// model Skua's scripts read (c.swf).
const protocol = require('../lib/net/protocol');
const { HeadlessClient } = require('../lib/net/headless');
const { InvCat } = require('../lib/skua/swfworld');

function client() {
  const c = new HeadlessClient({ id: 'aqw5test', label: 'aqw5test', username: 'Tester' });
  c.sent = [];
  c.write = (m) => c.sent.push(m);
  c.w.myAvatar.uid = 11;
  c.swf.game.sfc.myUserId = 11;
  const json = (o) => c.handle(protocol.parse(JSON.stringify({ t: 'xt', b: { r: -1, o } })));
  const call = (fn, ...a) => c.swf.call(fn, a);
  return { c, json, call };
}

const gear = (id, name, extra = {}) => ({ ItemID: id, sName: name, sType: 'Sword', sES: 'Weapon', iStk: 1, iQty: 1, CharItemID: 9000 + id, ...extra });
const mat = (id, name, qty, stk = 99, extra = {}) => ({ ItemID: id, sName: name, sType: 'Item', sES: 'None', iStk: stk, iQty: qty, CharItemID: 9000 + id, ...extra });
const cls = (id, name) => ({ ItemID: id, sName: name, sType: 'Class', sES: 'ar', iStk: 1, iQty: 302500, CharItemID: 9000 + id });

function loadBag(json, items, { bagSlots = 3, miscSlots = 2 } = {}) {
  json({ cmd: 'initUserData', uid: 11, data: { strUsername: 'Tester', iBagSlots: bagSlots, iHouseSlots: 1, intLevel: 50 } });
  json({ cmd: 'loadInventoryBig', items, hitems: [], factions: [], bankCount: 0, iMiscSlots: miscSlots });
}

test('aqw5: InvCat sorts items into bag, misc, class and house like the game', async () => {
  eq(InvCat.poolOf({ sType: 'Class' }), 'class');
  eq(InvCat.poolOf({ sType: 'Quest Item' }), 'misc');
  eq(InvCat.poolOf({ sType: 'Resource' }), 'misc');
  eq(InvCat.poolOf({ sType: 'Item', sMeta: '' }), 'misc');
  eq(InvCat.poolOf({ sType: 'Item', sMeta: ' 25 ' }), 'bag', 'an Item whose sMeta is a plain number stays in the bag');
  eq(InvCat.poolOf({ sType: 'Floor Item' }), 'house');
  eq(InvCat.poolOf({ sType: 'Armor', bHouse: '1' }), 'house', 'Skua sends bHouse as "1"');
  eq(InvCat.poolOf({ sType: 'Necklace' }), 'bag');
});

test('aqw5: skua.swf 1.4.5.0 slot counts - classes take no slot, materials have their own cap', async () => {
  const { json, call } = client();
  loadBag(json, [gear(1, 'Blade'), cls(2, 'ArchPaladin'), cls(3, 'StoneCrusher'), mat(4, 'Dust', 5), mat(5, 'Gem', 1, 99, { sType: 'Quest Item' })], { bagSlots: 30, miscSlots: 120 });
  eq(call('hasInventoryCategories'), 'true');
  eq(call('inventoryBagUsedSlots'), '1');
  eq(call('inventoryMiscSlots'), '120', 'the server limit from loadInventoryBig.iMiscSlots');
  eq(call('inventoryMiscUsedSlots'), '2');
  eq(call('inventoryPool', JSON.stringify(cls(9, 'X'))), 'class', 'plain string, as ExternalInterface returns it');
  eq(call('isFavoriteItem', 1), 'false');
});

test('aqw5: inventoryHasSpaceFor checks the item\'s own pool, stacks and what a purchase frees', async () => {
  const { json, call } = client();
  loadBag(json, [gear(1, 'Blade'), gear(2, 'Axe'), gear(3, 'Bow'), mat(4, 'Dust', 5), mat(5, 'Ore', 99, 99), cls(6, 'Healer')], { bagSlots: 3, miscSlots: 2 });
  const has = (it, qty = 1, buy = false, out = null) => call('inventoryHasSpaceFor', JSON.stringify(it), qty, buy, out ? JSON.stringify(out) : null);
  eq(has(gear(10, 'Spear')), 'false', 'bag full');
  eq(has(cls(11, 'Rogue')), 'true', 'a class never needs a slot');
  eq(has(mat(4, 'Dust', 1)), 'true', 'a stack that is not full takes more');
  eq(has(mat(5, 'Ore', 1)), 'true', 'a full misc stack: the game leaves the stack cap to the server (InvCat.isFullFor)');
  eq(has(mat(12, 'Bone', 1)), 'false', 'misc full (2 of 2)');
  eq(has(gear(10, 'Spear'), 1, false, gear(1, 'Blade')), 'true', 'a bank swap sends one bag item back');
  eq(has(gear(10, 'Spear'), 1, false, mat(4, 'Dust', 5)), 'false', 'but not when the outgoing item is in another pool');
  // A purchase that uses up a whole gear piece frees its slot (InvCat.freedBy).
  eq(has({ ...gear(10, 'Spear'), iQty: 1, turnin: [{ ItemID: 1, iQty: 1 }] }, 1, true), 'true');
  eq(has({ ...gear(10, 'Spear'), iQty: 1, turnin: [{ ItemID: 4, iQty: 5 }] }, 1, true), 'false', 'used-up Dust frees a misc slot, not a bag one');
});

test('aqw5: getUnmetPurchaseRequirements lists what the backpack lacks (bank does not count)', async () => {
  const { json, call } = client();
  loadBag(json, [mat(4, 'Dust', 5), mat(7, 'Token', 3)], { bagSlots: 30, miscSlots: 100 });
  json({ cmd: 'loadShop', shopinfo: { ShopID: 5, sName: 'Shop', items: [
    { ItemID: 50, ShopItemID: 500, sName: 'Big Sword', sType: 'Sword', iQty: 1, turnin: [{ ItemID: 4, iQty: 10, sName: 'Dust' }] },
    { ItemID: 51, ShopItemID: 501, sName: 'Potion', sType: 'Item', iQty: 5, TokID: 7, TokQty: 2, TokName: 'Token' },
  ] } });
  eq(JSON.parse(call('getUnmetPurchaseRequirements', 50, 500, -1)), ['Missing 5 x Dust in inventory.']);
  eq(JSON.parse(call('getUnmetPurchaseRequirements', 51, 501, -1)), [], '1 bundle of 5 = 2 tokens, 3 owned');
  eq(JSON.parse(call('getUnmetPurchaseRequirements', 51, 501, 10)), ['Missing 1 x Token in inventory.'], '2 bundles = 4 tokens');
  eq(JSON.parse(call('getUnmetPurchaseRequirements', 99, -1, -1)), ['Item is not in the loaded shop.']);
});

test('aqw5: rejectExcept answers "true" so Skua forgets the rejected drops', async () => {
  const { call } = client();
  eq(call('rejectExcept', 'dust'), 'true');
});

test('aqw5: CoreBots finds InvCat through loaderInfo.applicationDomain', async () => {
  const { json, call } = client();
  loadBag(json, [], { miscSlots: 140 });
  eq(call('callGameFunction', 'loaderInfo.applicationDomain.hasDefinition', 'InvCat'), 'true');
  eq(call('callGameFunction', 'loaderInfo.applicationDomain.hasDefinition', 'liteAssets.draw.FavStore'), 'false');
  const def = JSON.parse(call('callGameFunction', 'loaderInfo.applicationDomain.getDefinition', 'InvCat'));
  eq([def.MISC_SLOTS, def.MISC_TYPES], [140, ['Item', 'Note', 'Quest Item', 'Resource']]);
});

// 2026-10-10: right after the Scripts reset four engines rebuilt the shared Cached-Scripts at once and Valen's compile
// read a half-written DLL ("LordOfOrder could not be found"); the next compile worked. One retry before the translator.
test('engine: a compile error is retried once before falling back to the translator', async () => {
  const fs = require('fs'); const path = require('path');
  const { FakeGame } = require('./fakegame');
  const { Bot } = require('../lib/bot');
  const { P } = require('../lib/paths');
  const skuaEngine = require('../lib/skua/engine');
  const id = 'cretry';
  fs.mkdirSync(P.account(id), { recursive: true });
  fs.writeFileSync(path.join(P.account(id), 'login.txt'), `Username: ${id}\nPassword: pw\n`);
  const bot = new Bot(new FakeGame(), { id, label: id, owner: 'test', loginFile: path.join(P.account(id), 'login.txt') });
  bot.hub = { engineFor: () => null, settings: {} };
  const avail = skuaEngine.available;
  skuaEngine.available = () => true;
  const lines = [];
  bot.journal = (l) => lines.push(l);
  let tries = 0; let translated = 0;
  bot.runTranslated = async () => { translated++; return 'translated'; };
  const fail = (msg) => { const e = new Error(msg); e.fallback = true; return e; };
  try {
    bot.runSkua = async () => { tries++; if (tries === 1) throw fail("Error compiling included file 'X.cs':\n(218,20): error CS0246: The type or namespace name 'LordOfOrder' could not be found"); return 'engine'; };
    eq(await bot.runScript('Enhancement/X.cs', 60000, 'Elysium'), 'engine');
    eq([tries, translated], [2, 0], 'second compile ran on the engine');
    assert(lines.some((l) => /trying again in 30 s/.test(l)), lines.join(' | '));
    tries = 0;
    bot.runSkua = async () => { tries++; throw fail("Error compiling included file 'X.cs':\nerror CS0246: nope"); };
    eq(await bot.runScript('Enhancement/X.cs', 60000, 'Elysium'), 'translated');
    eq(tries, 2, 'only one retry, then the translator');
    tries = 0; translated = 0;
    bot.runSkua = async () => { tries++; throw fail('engine not ready'); };
    await bot.runScript('Enhancement/X.cs', 60000);
    eq([tries, translated], [1, 1], 'other engine errors fall back at once');
  } finally { skuaEngine.available = avail; }
});

// 2026-10-10: the character's own attacks come as sarsa (in ct) and sars; only sara (monster attacks) was read, so a
// solo boss fight looked like zero damage to the watchdog.
test('headless: the character\'s own skill damage (sarsa / sars) is seen', async () => {
  const { c, json } = client();
  json({ cmd: 'ct', sarsa: [{ cInf: 'p:11', iRes: 1, actID: 5, a: [{ tInf: 'm:48', hp: 12000, type: 'hit' }] }, { cInf: 'p:99', iRes: 1, a: [{ tInf: 'm:48', hp: 900 }] }] });
  assert(c.damageAt > 0 && c.myHits.get(48) > 0, 'own hit counted');
  const first = c.damageAt;
  await new Promise((r) => setTimeout(r, 5));
  json({ cmd: 'sars', cInf: 'p:11', iRes: 0, a: [], actID: 6 });
  eq(c.damageAt, first, 'a failed skill is not damage');
  json({ cmd: 'sars', cInf: 'p:11', iRes: 1, a: [{ tInf: 'm:48', hp: 300 }], actID: 7 });
  assert(c.damageAt > first, 'a standalone skill result counts too');
  json({ cmd: 'ct', sarsa: [{ cInf: 'p:11', iRes: 1, a: [{ tInf: 'p:11', hp: -500 }] }] });   // a heal on myself
  assert(c.fightStats().fightSecs >= 1, 'damage feeds the fight stats');
});

test('aqw5: HUD aura stacks follow moveToArea seeds, aura+/aura=/aura- and leaving combat', async () => {
  const { c, json, call } = client();
  json({ cmd: 'moveToArea', areaId: 9, areaName: 'arena-9', strMapName: 'arena', strMapFileName: 'arena.swf', mondef: [{ MonID: 1, strMonName: 'Dummy', intHPMax: 100 }],
    monmap: [{ MonMapID: 1, MonID: 1, strFrame: 'Enter' }], auDesc: { Focus: 'More crit' },
    monBranch: [{ MonMapID: 1, MonID: 1, intHP: 100, intHPMax: 100, intState: 1, au: [['Burn', 'ic', 5, 2, 0, 5]] }],
    uoBranch: [{ uoName: 'tester', strUsername: 'Tester', entID: 11, intHP: 100, intHPMax: 100, intState: 1, au: [['Focus', 'icf', 0, 3, 1, 0]] }] });
  const snaps = (who) => JSON.parse(call('GetAuraSnapshots', who));
  eq(snaps('Self').map((a) => [a.nam, a.n, a.persist, a.desc]), [['Focus', 3, true, 'More crit']], 'seeded from moveToArea au');
  // A cb with an aura+ (stacks), then an aura= (stacks only), then an aura- with stk 0 (gone).
  json({ cmd: 'cb', a: [{ cmd: 'aura+', tInf: 'p:11', cInf: 'p:11', auras: [{ nam: 'Rage', t: 's', dur: 10, stk: 2, isNew: true }] }] });
  eq(snaps('Self').find((a) => a.nam === 'Rage').n, 2);
  assert(snaps('Self').find((a) => a.nam === 'Rage').remaining > 9, 'timed aura counts down from its duration');
  json({ cmd: 'cb', a: [{ cmd: 'aura=', tInf: 'p:11', auras: [{ nam: 'Rage', stk: 5 }] }] });
  eq(snaps('Self').find((a) => a.nam === 'Rage').n, 5);
  json({ cmd: 'aura-', tInf: 'p:11', auras: [{ nam: 'Rage', stk: 0 }] });
  assert(!snaps('Self').some((a) => a.nam === 'Rage'), 'stk 0 removes it');
  c.swf.w.myAvatar.target = c.swf.w.getMonster(1);
  eq(snaps('Target').map((a) => [a.nam, a.n]), [['Burn', 2]], 'the target\'s HUD auras');
  json({ cmd: 'uotls', unm: 'tester', o: { intState: 1 } });
  eq(snaps('Self'), [], 'leaving combat clears the HUD (Game.userTreeWrite)');
  json({ cmd: 'auSnap', unm: 'Tester', au: [['Shield', 'ics', 0, 4, 1, 0]] });
  eq(snaps('Self').map((a) => [a.nam, a.n]), [['Shield', 4]], 'auSnap replaces the list');
  json({ cmd: 'clearAuras' });
  eq(snaps('Self').map((a) => a.nam), ['Shield'], 'clearAuras keeps persistent ones');
});
