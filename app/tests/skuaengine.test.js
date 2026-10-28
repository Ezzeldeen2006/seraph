// Skua's real engine on the headless client: the skua.swf model (lib/skua/swfworld.js), the wrapper that calls one
// method of a script (lib/skua/entry.js), and full runs of real C# scripts against a fake AQW server
// (tests/fakeaqw.js). The full runs need the engine binaries; without them those tests are skipped.
const fs = require('fs');
const path = require('path');
const protocol = require('../lib/net/protocol');
const { HeadlessClient } = require('../lib/net/headless');
const entry = require('../lib/skua/entry');

// Tests use a throwaway SERAPH_ROOT, so point the engine at a build if there is one.
if (!process.env.SERAPH_ENGINE) {
  const rid = process.platform === 'win32' ? 'win-x64' : `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  for (const dir of [path.join(__dirname, '..', 'engine', rid), path.join(__dirname, '..', '..', 'engine', 'bin', rid), path.join(__dirname, '..', '..', 'engine', 'host', 'bin', 'Release', 'net10.0')]) {
    if (fs.existsSync(path.join(dir, 'SeraphSkua.dll'))) { process.env.SERAPH_ENGINE = dir; break; }
  }
}
const engine = require('../lib/skua/engine');
const haveEngine = engine.available() && fs.existsSync(path.join(require('../lib/paths').P.SCRIPTS, 'CoreBots.cs'));

function client() {
  const c = new HeadlessClient({ id: 'swftest', label: 'swftest', username: 'Tester' });
  c.sent = [];
  c.write = (m) => { c.sent.push(m); c.swf.onOutgoing(m); };
  c.sock = { destroyed: false };
  c.state.loaded = true;
  c.w.myAvatar.uid = 11;
  return c;
}
const pkt = (o) => protocol.parse(JSON.stringify({ t: 'xt', b: { r: -1, o } }));
const call = (c, f, ...a) => c.swf.call(f, a);
const obj = (c, p) => JSON.parse(call(c, 'getGameObject', p));

function area(c) {
  c.handle(pkt({ cmd: 'moveToArea', areaId: 77, areaName: 'faerie-77', strMapName: 'faerie', strMapFileName: '',
    monmap: [{ MonMapID: 1, MonID: 9, strFrame: 'r2' }, { MonMapID: 2, MonID: 9, strFrame: 'r3' }], mondef: [{ MonID: 9, strMonName: 'Pixie', intLevel: 5 }],
    monBranch: [{ MonMapID: 1, MonID: 9, intHP: 80, intHPMax: 100, intState: 1 }, { MonMapID: 2, MonID: 9, intHP: 100, intHPMax: 100, intState: 1 }],
    uoBranch: [{ uoName: 'tester', strUsername: 'Tester', entID: 11, intHP: 500, intHPMax: 600, intMP: 50, intMPMax: 100, intState: 1, intLevel: 20, strFrame: 'Enter', strPad: 'Spawn' }] }));
  c.handle(pkt({ cmd: 'initUserData', uid: 11, data: { strUsername: 'Tester', intLevel: 20, intGold: 100, iCP: 1200, strQuests: '0a', iUpgDays: -1, iBagSlots: 30, eqp: {} } }));
  c.handle(pkt({ cmd: 'loadInventoryBig', items: [{ ItemID: 1, sName: 'Sword', CharItemID: 5, iQty: 1, bEquip: 1, sES: 'Weapon' }], factions: [{ FactionID: 2, sName: 'Good', iRep: 1000 }], bankCount: 0 }));
  c.handle(pkt({ cmd: 'sAct', actions: { active: [{ ref: 'aa', typ: 'aa', tgt: 'h', cd: 2000, auto: true, isOK: true }, { ref: 'a1', tgt: 'h', cd: 3000, mp: 10, isOK: true, tgtMax: 2 }], passive: [] } }));
  c.handle(pkt({ cmd: 'stu', sta: { $tha: 0, $cmc: 1 } }));
}

test('skua.swf model: the paths and callbacks Skua reads look like the real game', async () => {
  const c = client();
  area(c);
  eq([obj(c, 'world.strMapName'), obj(c, 'world.curRoom'), obj(c, 'world.myAvatar.dataLeaf.intHPMax'), obj(c, 'world.myAvatar.objData.intGold')], ['faerie', 77, 600, 100]);
  eq(obj(c, 'world.myAvatar.objData.iRank'), 2, 'class rank worked out from class points like Avatar.updateRep');
  eq(call(c, 'isNull', 'world'), 'false');
  eq(call(c, 'isNull', 'world.shopinfo'), 'true');
  eq(obj(c, 'world.myAvatar.items').length, 1);
  eq(obj(c, 'world.uoTree["tester"]'.split('[')[0])['tester'].intHP, 500);
  eq(call(c, 'getGameObjectKey', 'world.uoTree', 'tester') !== null, true);
  eq(call(c, 'callGameFunction', 'world.getQuestValue', 1), '10', 'base-36 quest slots');
  eq(call(c, 'callGameFunction', 'world.myAvatar.getRep', 2), '1000');
  c.handle(pkt({ cmd: 'addFaction', faction: { FactionID: '20', sName: 'Fishing', iRep: 0 } }));
  c.handle(pkt({ cmd: 'CatchResult', catchResult: { act: 'CatchDynamite', fish: [{ act: 'CatchFish', rep: 85 }, { act: 'CatchFish', rep: 75 }], myRep: 160, tool: 'Dynamite' } }));
  eq(call(c, 'callGameFunction', 'world.myAvatar.getRep', 20), '160', 'fishing rep arrives in CatchResult, as Game.as addRep(20, myRep)');
  eq(call(c, 'callGameFunction0', 'world.myAvatar.pMC.artLoaded'), 'true', 'loaded once the inventory arrived');
  c.swf.w.myAvatar.invLoaded = false;
  eq(call(c, 'callGameFunction0', 'world.myAvatar.pMC.artLoaded'), 'false');
  c.swf.w.myAvatar.invLoaded = true;
  eq(JSON.parse(call(c, 'availableMonsters')).length, 0, 'no monsters in Enter');
  call(c, 'jumpCorrectRoom', 'r2', 'Left');
  eq([obj(c, 'world.strFrame'), c.sent.pop()], ['r2', '%xt%zm%moveToCell%77%r2%Left%']);
  eq(JSON.parse(call(c, 'availableMonsters')).map((m) => [m.strMonName, m.intHP]), [['Pixie', 80]]);
  eq(call(c, 'attackMonsterName', 'pix'), 'true');
  assert(c.sent.includes('%xt%zm%gar%1%0%aa>m:1%wvz%'), `targeting starts auto attack, as World.approachTarget does: ${c.sent.join(' | ')}`);
  eq(call(c, 'canUseSkill', 1), 'true');
  eq(call(c, 'useSkill', 1), 'true');
  assert(c.sent.includes('%xt%zm%gar%1%1%a1>m:1%wvz%'), `skill packet: ${c.sent.join(' | ')}`);
  eq(c.sent.filter((m) => /aa>m:1/.test(m)).length, 1, 'no second auto attack while one is running');
  eq(call(c, 'canUseSkill', 1), 'false', 'global cooldown');
  c.handle(pkt({ cmd: 'ct', m: { 1: { intHP: 0, intState: 0 } }, sara: [{ actionResult: { cInf: 'p:11', tInf: 'm:1', hp: 80 }, actID: 1, iRes: 1 }] }));
  eq(JSON.parse(call(c, 'getTargetMonster')), {}, 'a dead target is dropped');
  c.swf.w.cancelAutoAttack();
});

// Sable, 2026-10-12: Lord of Order at rank 1 has only a self-buff besides the auto attack, and approachTarget was a
// no-op, so she held a Frost Spirit as target in icestormunder for hours and never hit it.
test('skua.swf model: a class whose skills are all buffs still auto attacks its target', async () => {
  const c = client();
  area(c);
  c.handle(pkt({ cmd: 'sAct', actions: { active: [{ ref: 'aa', typ: 'aa', tgt: 'h', cd: 2000, auto: true, isOK: true }, { ref: 'a1', tgt: 's', cd: 3000, mp: 0, isOK: true }], passive: [] } }));
  call(c, 'jumpCorrectRoom', 'r2', 'Left');
  eq(call(c, 'attackMonsterName', '*'), 'true');
  eq(call(c, 'useSkill', 1), 'true');
  assert(c.sent.some((m) => /%gar%.*%aa>m:1%/.test(m)), `auto attack sent: ${c.sent.join(' | ')}`);
  c.swf.w.cancelAutoAttack();
  const dead = client();
  area(dead);
  call(dead, 'jumpCorrectRoom', 'r2', 'Left');
  dead.handle(pkt({ cmd: 'ct', m: { 1: { intHP: 0, intState: 0 } } }));
  call(dead, 'attackMonsterName', '*');
  eq(dead.sent.filter((m) => /%gar%/.test(m)).length, 0, 'nothing alive to hit: no attack');
  dead.swf.w.cancelAutoAttack();
});

test('skua.swf model: quests, items, drops, bank and auras follow the game rules', async () => {
  const c = client();
  area(c);
  c.handle(pkt({ cmd: 'getQuests', quests: { 500: { QuestID: 500, sName: 'Q', turnin: [{ ItemID: 70, iQty: 2 }], oItems: { 70: { ItemID: 70, sName: 'Fang' } }, oRewards: {}, oReqd: {} } } }));
  call(c, 'callGameFunction', 'world.acceptQuest', 500);
  eq([obj(c, 'world.questTree.500.status'), c.sent.pop()], ['p', '%xt%zm%acceptQuest%77%500%']);
  c.handle(pkt({ cmd: 'addItems', items: { 70: { ItemID: 70, sName: 'Fang', iQty: 1, bTemp: 1 } } }));
  eq(obj(c, 'world.questTree.500.status'), 'p');
  c.handle(pkt({ cmd: 'addItems', items: { 70: { ItemID: 70, sName: 'Fang', iQty: 1, bTemp: 1 } } }));
  eq([obj(c, 'world.questTree.500.status'), obj(c, 'world.myAvatar.tempitems')[0].iQty], ['c', 2], 'completable once the turn-in items are held');
  eq(call(c, 'callGameFunction', 'world.maximumQuestTurnIns', 500), '1');
  c.handle(pkt({ cmd: 'turnIn', sItems: '70:2' }));
  c.handle(pkt({ cmd: 'ccqr', QuestID: 500, bSuccess: 1 }));
  eq([obj(c, 'world.myAvatar.tempitems').length, obj(c, 'world.questTree.500.status')], [0, null]);
  c.handle(pkt({ cmd: 'dropItem', items: { 80: { ItemID: 80, sName: 'Gem', iQty: 1, bCoins: 1 } } }));
  c.handle(pkt({ cmd: 'getDrop', bSuccess: 1, ItemID: 80, CharItemID: 9, iQty: 1 }));
  eq(obj(c, 'world.myAvatar.items').map((i) => i.sName), ['Sword', 'Gem']);
  c.handle(pkt({ cmd: 'loadBank', bitSuccess: 1, items: [{ ItemID: 90, sName: 'Old Cape', CharItemID: 12, iQty: 1, bCoins: 0 }] }));
  eq(obj(c, 'world.bankinfo.items').map((i) => i.sName), ['Old Cape']);
  c.handle(pkt({ cmd: 'bankToInv', ItemID: 90 }));
  eq([obj(c, 'world.bankinfo.items').length, obj(c, 'world.myAvatar.items').length], [0, 3]);
  c.handle(pkt({ cmd: 'aura+', tInf: 'p:11', auras: [{ nam: 'Focus', val: 4, isNew: true }] }));
  eq([call(c, 'GetAurasValue', 'Self', 'focus'), call(c, 'HasAnyActiveAura', 'Self', 'Rage, focus')], ['4', 'true']);
  eq(call(c, 'GetAurasValue', 'Self', 'nothing'), '444', 'skua.swf answers 444 for a missing aura');
  c.handle(pkt({ cmd: 'aura-', tInf: 'p:11', aura: { nam: 'Focus' } }));
  eq(JSON.parse(call(c, 'GetPlayerAura', 'Tester')), []);
  call(c, 'sendClientPacket', '{"t":"xt","b":{"r":-1,"o":{"cmd":"updateQuest","iValue":5,"iIndex":3}}}', 'json');
  eq(call(c, 'callGameFunction', 'world.getQuestValue', 3), '5', 'a client packet is handled as if the server sent it');
  const id = call(c, 'lnkCreate', 'world.actions.active');
  const ts = call(c, 'lnkGetChild', call(c, 'lnkGetArray', id, 0), 'ts');
  call(c, 'lnkSetValue', ts, 1234);
  eq(obj(c, 'world.actions.active')[0].ts, 1234, 'linked objects write through');
});

test('swf model: a refreshed aura restarts its timer (stacking auras stay visible)', async () => {
  const c = client();
  area(c);
  const real = Date.now;
  const t0 = real();
  try {
    Date.now = () => t0;
    c.handle(pkt({ cmd: 'aura+', tInf: 'p:11', auras: [{ nam: 'End of the World', t: 's', dur: 8, val: 1, isNew: true }] }));
    Date.now = () => t0 + 7000;
    c.handle(pkt({ cmd: 'aura++', tInf: 'p:11', auras: [{ nam: 'End of the World', t: 's', dur: 8, val: 2 }] }));
    Date.now = () => t0 + 14000;
    eq(call(c, 'GetAurasValue', 'Self', 'End of the World'), '2', 'renewed at 7 s, still up at 14 s');
    Date.now = () => t0 + 18000;
    eq(call(c, 'GetAurasValue', 'Self', 'End of the World'), '444', 'gone once the renewed timer runs out');
  } finally { Date.now = real; }
  c.applyAura({ cmd: 'aura+', tInf: 'p:11', auras: [{ nam: 'Doom', val: 1, dur: 30 }] });
  c.applyAura({ cmd: 'aura++', tInf: 'p:11', auras: [{ nam: 'Doom', val: 2, dur: 30 }] });
  eq(c.aurasOf('Self').filter((a) => a.nam === 'Doom').map((a) => a.val), [2], 'combat engine: aura++ stacks instead of deleting');
});

test('entry: wraps one method of a script, with its arguments, for the engine', async () => {
  const dir = path.join(process.env.SERAPH_ROOT, 'entry');
  const file = entry.wrapper('unused', path.join(__dirname, 'skua', 'EntryTarget.cs'), 'GetRing', dir, '2, note: "x"');
  const code = fs.readFileSync(file, 'utf8');
  assert(code.includes('new EntryTarget().GetRing(2, note: "x");'), code);
  assert(code.includes('Core.SetOptions();'), 'CoreBots is started like any script');
  let threw = false;
  try { entry.wrapper('unused', path.join(__dirname, 'skua', 'EntryTarget.cs'), 'Nope', dir); } catch (e) { threw = true; }
  assert(threw, 'unknown method refused');
});

async function withFakeServer(fn) {
  const fake = require('./fakeaqw');
  const srv = await fake.start();
  const c = new HeadlessClient({ id: 'enginetest', label: 'enginetest', username: 'Tester' });
  const info = { username: 'Tester', token: 'tok', userId: 1, level: 30, upgradeDays: -1, servers: [srv.server] };
  c.login = info;
  c.swf.setLogin(info, 'x');
  c.swf.setServer(srv.server);
  await c.connect(srv.server, info);
  try { return await fn(c, srv); } finally { c.disconnect(); srv.close(); }
}

test('engine: a real Skua script (quests, hunting, drops, shop, bank, equip) runs start to finish', async () => {
  if (!haveEngine) { console.log('      (skipped: no engine build or no script library)'); return; }
  await withFakeServer(async (c) => {
    const { SkuaEngine } = engine;
    const eng = new SkuaEngine(c);
    const lines = [];
    eng.on('log', (l) => { if (l.kind === 'script' || l.kind === 'error') lines.push(l.msg); });
    await eng.run(path.join(__dirname, 'skua', 'EngineSmoke.cs'));
    const r = await eng.waitDone(150000);
    eng.dispose();
    const fails = lines.filter((l) => l.startsWith('FAIL'));
    eq([r.error || null, fails], [null, []], lines.join('\n'));
    assert(lines.includes('SMOKE DONE'), lines.join('\n'));
  });
}, 200000);

// Engine patch 13 (2026-09-21): VibeSkua's per-class adaptive skills replace the JSON rotation when switched on.
test('engine: the same script hunts with VibeSkua adaptive skills switched on (patch 13)', async () => {
  if (!haveEngine) { console.log('      (skipped: no engine build or no script library)'); return; }
  await withFakeServer(async (c) => {
    const { SkuaEngine, callStats } = engine;
    callStats(true);
    const eng = new SkuaEngine(c, { adaptiveSkills: true });
    const lines = [];
    eng.on('log', (l) => { if (l.kind === 'script' || l.kind === 'error') lines.push(l.msg); });
    await eng.run(path.join(__dirname, 'skua', 'EngineSmoke.cs'));
    const r = await eng.waitDone(150000);
    eng.dispose();
    const fails = lines.filter((l) => l.startsWith('FAIL'));
    eq([r.error || null, fails], [null, []], lines.join('\n'));
    assert(lines.includes('SMOKE DONE'), lines.join('\n'));
    const used = callStats(true).filter((p) => p.call === 'useSkill' || p.call === 'canUseSkill');
    assert(used.length === 2, `skills were checked and used: ${JSON.stringify(used)}`);
  });
}, 200000);

test('engine: the bot runs a script method through the hub (entry wrapper, CoreBots, engine slot)', async () => {
  if (!haveEngine) { console.log('      (skipped: no engine build or no script library)'); return; }
  const { Hub } = require('../lib/hub');
  const { Bot } = require('../lib/bot');
  require('../lib/paths').ensureDirs();
  await withFakeServer(async (c) => {
    const hub = new Hub(null, { headless: true, autoOpen: false });
    const bot = new Bot(c, { id: 'enginetest', label: 'enginetest', status: 'active' }, { hub });
    const journal = [];
    bot.journal = (m) => journal.push(m);
    const r = await bot.runScript(path.join(__dirname, 'skua', 'EntryTarget.cs'), 120000, 'GetRing', { args: '3' });
    eq(r.engine, 'skua', journal.join('\n'));
    assert(journal.some((l) => l.includes('GetRing called with times=3')), journal.join('\n'));
    assert(journal.some((l) => l.includes('ENTRY DONE')), journal.join('\n'));
    assert(!journal.some((l) => l.includes('ScriptMain should not run')), 'only the method ran');
    eq(hub.engineBusy.size, 0, 'engine slot given back');
    hub.dispose();
  });
}, 200000);

test('cbo: CoreBots options follow Seraph (public room unless one is set, planned classes), other keys kept', async () => {
  const cbo = require('../lib/skua/cbo');
  const dir = path.join(process.env.SERAPH_ROOT, 'cbo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CBO_Storage(Tester).txt'), 'BankMiscAC: True\nPrivateRooms: True\n');
  const bot = { id: 'valen7', settings: { privateRoom: null }, ownedClasses: async () => ['Warrior', 'Master Ranger'] };
  const file = cbo.write(dir, 'Tester', await cbo.keysFor(bot));
  const text = fs.readFileSync(file, 'utf8');
  assert(/^BankMiscAC: True$/m.test(text), 'unrelated keys stay');
  eq(path.basename(file), 'CBO_Storage(tester).txt', 'the name CoreBots looks up (sfc.myUserName is lower case; Linux is case-sensitive)');
  assert(/^PrivateRooms: False$/m.test(text), text);
  assert(/^FarmClassSelect: Master Ranger$/m.test(text), text);
  bot.settings.privateRoom = 44444;
  cbo.write(dir, 'Tester', await cbo.keysFor(bot));
  const t2 = fs.readFileSync(file, 'utf8');
  assert(/^PrivateRooms: True$/m.test(t2) && /^PrivateRoomNr: 44444$/m.test(t2), t2);
});

// Found by engine/tests/flashscan.js (2026-09-20): game functions CoreBots calls that the model lacked.
test('skua.swf model: maximumShopBuys, toggleItemEquip and world.rootClass follow the game', async () => {
  const { SwfWorld } = require('../lib/skua/swfworld');
  const client = { id: 'fn', headless: true, state: { loaded: true }, w: { myAvatar: { uid: 11, objData: { strUsername: 'Fn' } } }, write() {}, send() {}, record() {}, emit() {}, on() {} };
  const swf = new SwfWorld(client);
  const sent = [];
  swf.game.sfc.sendXtMessage = (z, cmd, args) => sent.push([cmd, ...args]);
  const pkt = (o) => swf.onPacket({ kind: 'json', cmd: o.cmd, data: o });
  pkt({ cmd: 'moveToArea', areaId: 5, areaName: 'battleon-1', strMapName: 'battleon', monmap: [], mondef: [], uoBranch: [{ entID: 11, strUsername: 'Fn', intHP: 500, intHPMax: 500, intState: 1, intLevel: 50, strFrame: 'Enter' }] });
  pkt({ cmd: 'initUserData', uid: 11, data: { strUsername: 'Fn', intLevel: 50, intGold: 1000, intCoins: 30, iUpgDays: -1 } });
  pkt({ cmd: 'loadInventoryBig', items: [{ ItemID: 7, sName: 'Ore', iQty: 25, iStk: 999 }, { ItemID: 8, sName: 'Potion', sType: 'Item', sES: 'None', sLink: 'pot', iQty: 3, iStk: 10 }], hitems: [], factions: [] });
  const w = swf.game.world;
  eq(w.maximumShopBuys({ ItemID: 99, iStk: 50, iCost: 300, bCoins: 0 }), 3, 'gold: 1000 / 300');
  eq(w.maximumShopBuys({ ItemID: 99, iStk: 50, iCost: 0, iQty: 1, turnin: [{ ItemID: 7, iQty: 10 }] }), 2, 'merge: 25 ore / 10 each');
  eq(w.maximumShopBuys({ ItemID: 99, iStk: 50, iCost: 0, iQty: 1, turnin: [{ ItemID: 123, iQty: 1 }] }), 0, 'a missing material');
  eq(w.maximumShopBuys({ ItemID: 7, iStk: 30, iCost: 0 }), 5, 'stack room: 30 - 25');
  eq(w.maximumShopBuys(JSON.stringify({ ItemID: 99, iStk: 5, iCost: 1, bCoins: 1 })), 5, 'AC, capped by the stack, JSON text too');
  eq(w.maximumShopBuys({ ItemID: 5, sES: 'ar', iStk: 1 }), 1, 'a class: one');
  eq(swf.game.toggleItemEquip({ ItemID: 3, sES: 'he', sType: 'Helm', bEquip: 0, EnhID: 0, EnhLvl: 1 }), false, 'an unenhanced helm is refused');
  eq(swf.game.toggleItemEquip({ ItemID: 8, sES: 'None', sType: 'Item', sLink: 'pot', bEquip: 0, EnhLvl: 1 }), true, 'a consumable goes on the item slot');
  assert(sent.some((x) => x[0] === 'geia'), JSON.stringify(sent));
  swf.game.world.myAvatar.dataLeaf.intState = 2;
  eq(swf.game.toggleItemEquip({ ItemID: 8, sES: 'None', sType: 'Item', bEquip: 1 }), false, 'not in combat');
  eq(swf.call('setGameObject', ['world.rootClass.ui.mcPortrait.strName.text', 'X']), null);
  eq(swf.game.ui.mcPortrait.strName.text, 'X', 'world.rootClass is the game');
  // Flash reads a property and calls it with no arguments the same way; Ultrasv3 asks for the equipped pet through
  // CallGameFunction, which used to come back "no game function 'world.myAvatar.intPetID'".
  eq(JSON.parse(swf.call('callGameFunction', ['world.myAvatar.intPetID'])), 0, 'no pet equipped');
  w.myAvatar.items.push({ ItemID: 4242, sName: 'Baby Dragon', sES: 'pe', bEquip: true, iQty: 1 });
  eq(JSON.parse(swf.call('callGameFunction', ['world.myAvatar.intPetID'])), 4242, 'the equipped pet');
  eq(swf.call('callGameFunction', ['world.myAvatar.nothingHere']).error, "no game function 'world.myAvatar.nothingHere'");
});

// Laptop profile 2026-09-21: 2,053 backpack reads cost 10.7 s of CPU in 10 min. Big reads are reused until the next
// packet or action - and never after one.
test('skua.swf model: big reads are reused until a packet or an action changes the world', async () => {
  const c = client();
  area(c);
  const first = call(c, 'getGameObject', 'world.myAvatar.items');
  let resolved = 0;
  const orig = c.swf.resolve.bind(c.swf);
  c.swf.resolve = (o, p) => { if (p === 'world.myAvatar.items') resolved++; return orig(o, p); };
  eq(call(c, 'getGameObject', 'world.myAvatar.items'), first, 'same answer');
  call(c, 'isNull', 'world.myAvatar'); call(c, 'getGameObject', 'world.strFrame');
  call(c, 'getGameObject', 'world.myAvatar.items');
  eq(resolved, 0, 'reads in between keep the cached answer');
  c.handle(pkt({ cmd: 'dropItem', items: { 81: { ItemID: 81, sName: 'Ruby', iQty: 1, bCoins: 0 } } }));
  c.handle(pkt({ cmd: 'getDrop', bSuccess: 1, ItemID: 81, CharItemID: 10, iQty: 1 }));
  assert(obj(c, 'world.myAvatar.items').some((i) => i.sName === 'Ruby'), 'a packet makes the next read fresh');
  const before = resolved;
  call(c, 'callGameFunction', 'world.toggleItemEquip', 1);
  call(c, 'getGameObject', 'world.myAvatar.items');
  eq(resolved, before + 1, 'an action makes the next read fresh');
});

// Check-up 2026-09-21: .NET never unloads a compiled script, so a long-lived engine grew to 511 MB and the service hit
// its memory limit. Between scripts, a big engine that has run at least two scripts is swapped for a fresh one.
test('engine: an engine over the memory limit is replaced between scripts, never during one', async () => {
  const EventEmitter = require('events');
  const eng = new engine.SkuaEngine(client());
  const sent = [];
  const fake = new EventEmitter();
  fake.pid = 1; fake.exitCode = null;
  fake.stdin = { writable: true, write: (s) => { sent.push(JSON.parse(s)); if (JSON.parse(s).op === 'exit') setImmediate(() => fake.emit('exit', 0)); } };
  eng.proc = fake;
  eng.rssMb = () => 510;
  eng.runs = 1;
  eq(await eng.recycleIfBig(330), false, 'a fresh engine (one script) is left alone');
  eng.runs = 3; eng.running = true;
  eq(await eng.recycleIfBig(330), false, 'never while a script runs');
  eng.running = false;
  eng.rssMb = () => 300;
  eq(await eng.recycleIfBig(330), false, 'under the limit: kept');
  eng.rssMb = () => 510;
  eq(await eng.recycleIfBig(330), true, 'over the limit after 3 scripts: replaced');
  assert(sent.some((m) => m.op === 'exit'), 'asked the host to exit');
  eq(eng.runs, 0, 'the count starts again');
  assert(eng.logs.some((l) => /engine uses 510 MB/.test(l.msg)), 'says why');
});

// Game.as rules for which bag an item goes to and leaves from (check-up 2026-09-22): the model sent an item with no
// bTemp to the backpack, where the game puts it in the temporary bag.
test('skua.swf model: items join and leave the same bag the game uses, bTemp or not', async () => {
  const c = client();
  area(c);
  c.handle(pkt({ cmd: 'getQuests', quests: { 8809: { QuestID: 8809, sName: 'Reflection in the Puddle', iSlot: 471, iValue: 17, turnin: [{ ItemID: 500, iQty: 7 }], oItems: { 500: { ItemID: 500, sName: 'Mumbler Destroyed', bTemp: true, iStk: 7 } }, oRewards: {} } } }));
  c.handle(pkt({ cmd: 'addItems', items: { 500: { ItemID: 500, iQty: 7 } } }));
  const temp = () => c.swf.w.myAvatar.tempitems.map((i) => `${i.sName || i.ItemID}x${i.iQty}`);
  eq(temp(), ['Mumbler Destroyedx7'], 'a quest item goes to the temporary bag');
  c.handle(pkt({ cmd: 'turnIn', sItems: '500:7' }));
  eq(temp(), [], 'and leaves it on turn-in');
  c.handle(pkt({ cmd: 'addItems', items: { 600: { ItemID: 600, iQty: 1 } } }));
  eq(temp(), ['600x1'], 'an unknown item with no bTemp is temporary, as in Game.as');
  c.handle(pkt({ cmd: 'addItems', items: { 700: { iQty: 5, iQtyNow: 5, CharItemID: 9, bBank: 0 } } }));
  assert(c.swf.w.myAvatar.items.some((i) => Number(i.ItemID) === 700), 'a stack update with a CharItemID is a backpack item');
  assert(c.swf.w.myAvatar.items.every((i) => typeof i.sName === 'string'), 'never a null name (Skua: Name.ToLower(), 2026-09-22)');
  c.swf.w.bankinfo.addItemsToBank([{ ItemID: 800, sName: 'Glacera Ice Token', sType: 'Item', iQty: 3, bTemp: 0 }]);
  c.handle(pkt({ cmd: 'addItems', items: { 800: { iQty: 4, CharItemID: 12 } } }));
  eq((c.swf.w.myAvatar.items.find((i) => Number(i.ItemID) === 800) || {}).sName, 'Glacera Ice Token', 'a stack update for a banked item keeps its name');
  c.handle(pkt({ cmd: 'turnIn', sItems: '600:1' }));
  eq(temp(), [], 'an item with no invTree entry leaves the bag that holds it');
});

test('engine: Skua\'s quest-progression relog loop saves the last packets and the model\'s view, once per 10 min', async () => {
  const { P } = require('../lib/paths');
  const c = client();
  area(c);
  c.trace('in', '{"cmd":"getQuests"}');
  c.trace('out', '%xt%zm%getQuests%77%8811%');
  const eng = new engine.SkuaEngine(c);
  const dir = path.join(P.account(c.id), 'logs');
  const before = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('questloop-')).length : 0;
  eng.watchQuestLoop('[16:21:39] (QuestProgression) Quest [8811] "Distractions" still not unlocked after retries. Relogging...');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('questloop-'));
  eq(files.length, before + 1, 'one dump');
  const text = fs.readFileSync(path.join(dir, files.sort().pop()), 'utf8');
  assert(/# quest loop .*8811/.test(text) && /# tempitems:/.test(text) && /out %xt%zm%getQuests%77%8811%/.test(text), text.slice(0, 400));
  eng.watchQuestLoop('⚡ Relogin Triggered: Quest progression recovery failed, relogging.');
  eq(fs.readdirSync(dir).filter((f) => f.startsWith('questloop-')).length, before + 1, 'not again within 10 min');
});
