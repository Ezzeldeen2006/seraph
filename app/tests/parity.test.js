// Engine parity (2026-10-07): server messages the real game client handles (Game.as), in both world copies -
// Seraph's headless world (c.w) and the skua.swf model Skua's scripts read (c.swf.w).
const protocol = require('../lib/net/protocol');
const { HeadlessClient } = require('../lib/net/headless');

function client() {
  const c = new HeadlessClient({ id: 'partest', label: 'partest', username: 'Tester' });
  c.sent = [];
  c.write = (m) => c.sent.push(m);
  c.w.myAvatar.uid = 11;
  c.swf.game.sfc.myUserId = 11;
  const json = (o) => c.handle(protocol.parse(JSON.stringify({ t: 'xt', b: { r: -1, o } })));
  const str = (...a) => c.handle(protocol.parse(`%xt%${a.join('%')}%`));
  return { c, json, str };
}
// A slot (MonMapID 1) whose cluster holds a Dragon and its second phase; the Dragon is live.
function boss(json) {
  json({ cmd: 'moveToArea', areaId: 9, areaName: 'lair-9', strMapName: 'lair', strMapFileName: 'lair.swf',
    mondef: [{ MonID: 100, strMonName: 'Red Dragon', intHPMax: 5000, intLevel: 30 }, { MonID: 101, strMonName: 'Red Dragon Unleashed', intHPMax: 9000, intLevel: 35 }],
    monmap: [{ MonMapID: 1, MonID: 100, strFrame: 'Boss' }, { MonMapID: 1, MonID: 101, strFrame: 'Boss' }],
    monBranch: [{ MonMapID: 1, MonID: 100, intHP: 5000, intHPMax: 5000, intState: 1 }], uoBranch: [] });
}

test('parity: a monster cluster shows only its live monster, and spcs swaps it (boss phases)', async () => {
  const { c, json, str } = client();
  boss(json);
  eq(c.w.monsters.filter((m) => m.MonMapID === 1).map((m) => m.strMonName), ['Red Dragon'], 'headless: one per slot');
  const live = () => c.swf.w.monsters.filter((m) => m.dataLeaf).map((m) => m.objData.strMonName);
  eq(live(), ['Red Dragon'], 'Skua model: only the live one has a dataLeaf');
  str('spcs', -1, 1, 101);
  eq([c.w.monsters[0].strMonName, c.w.monsters[0].intHPMax, c.w.monsters[0].intState], ['Red Dragon Unleashed', 9000, 0], 'headless follows the swap');
  eq(live(), ['Red Dragon Unleashed'], 'Skua model follows the swap');
  eq(c.swf.w.getMonster(1).objData.strMonName, 'Red Dragon Unleashed');
  eq(c.swf.w.monTree['1'].intHPMax, 9000);
});

test('parity: the server moving the character (gtc, dungeonMTC) moves it and tells the server', async () => {
  const { c, str } = client();
  str('gtc', -1, 'r5', 'Left');
  eq([c.w.strFrame, c.w.strPad], ['r5', 'Left']);
  assert(c.sent.some((m) => String(m).includes('%moveToCell%') && String(m).includes('%r5%Left%')), JSON.stringify(c.sent));
  str('dungeonMTC', -1, 'true', 'Boss,Spawn');
  eq(c.w.strFrame, 'Boss');
  str('dungeonMTC', -1, 'false', 'r9,Left');
  eq(c.w.strFrame, 'Boss', 'a refused move is not made');
});

test('parity: balance, slot purchases, Wheel of Doom prizes, spell scrolls, war values, quest strings', async () => {
  const { c, json } = client();
  const me = c.swf.w.myAvatar;
  json({ cmd: 'loadInventoryBig', items: [], factions: [] });
  json({ cmd: 'balance', intGold: 12345, intExp: 678 });
  eq([Number(me.objData.intGold), Number(me.objData.intExp), Number(c.w.myAvatar.objData.intGold)], [12345, 678, 12345]);
  me.objData.iBagSlots = 100; me.objData.intCoins = 1000;
  json({ cmd: 'buyBagSlots', bitSuccess: 1, iSlots: 2 });
  json({ cmd: 'buyBankSlots', bitSuccess: 0, iSlots: 5 });
  eq([me.objData.iBagSlots, me.objData.intCoins, me.objData.iBankSlots], [102, 600, undefined]);
  json({ cmd: 'Wheel', dropItems: { 18927: { ItemID: 18927, sName: 'Gear of Doom', iStk: 999 }, 19189: { ItemID: 19189, sName: 'Treasure Potion', iStk: 99 } },
    charItem1: 501, charItem2: 502, dropQty: 3, Item: { ItemID: 777, sName: 'Doom Prize Helm', sES: 'he' }, CharItemID: 503 });
  const names = me.items.map((i) => `${i.sName}x${i.iQty}`);
  eq(names.sort(), ['Doom Prize Helmx1', 'Gear of Doomx3', 'Treasure Potionx1']);
  json({ cmd: 'turninscroll', IDs: [3, 10] });
  const bit = (id) => (me.objData.scrolls.charCodeAt(id >> 3) >> (id % 8)) & 1;
  eq([bit(3), bit(10), bit(4)], [1, 1, 0]);
  json({ cmd: 'warvalues', wars: [{ warID: 1, iPercent: 40 }] });
  json({ cmd: 'loadQuestStringData', obj: { 1: 'abc' } });
  eq([c.swf.w.warValues[0].iPercent, c.swf.w.objQuestString[1]], [40, 'abc']);
});

test('parity: server notices are kept, map-script events are noted once per map', async () => {
  const { c, json, str } = client();
  const heard = []; const events = [];
  c.on('server', (m) => heard.push(m));
  c.on('mapEvent', (e) => events.push(e));
  boss(json);
  str('notify', -1, 'The boss is enraged!');
  str('logoutWarning', -1, 'Server restarting', 60);
  eq(heard.length, 2);
  str('trap door', -1, 'r3');
  str('trap door', -1, 'r4');
  json({ cmd: 'callfct', fctNam: 'openGate', fctParams: [1] });
  json({ cmd: 'callfct', fctNam: 'openGate', fctParams: [2] });
  json({ cmd: 'clockTick', t: 5 });
  eq(events.map((e) => [e.map, e.cmd, e.fct]), [['lair', 'trap door', null], ['lair', 'callfct', 'openGate'], ['lair', 'clockTick', null]]);
});

test('parity: a server-ordered move is sent once (the Skua model only follows)', async () => {
  const { c, str } = client();
  str('gtc', -1, 'r7', 'Right');
  eq(c.sent.filter((m) => String(m).includes('%moveToCell%')).length, 1);
  eq(c.swf.w.strFrame, 'r7', 'the Skua model is in the new cell too');
});

// Step 3: what a map's own code hands out (lib/map-hooks.json, built by <work>\mapscan\scan.js).
test('parity: map hooks - load code by quest slot, a cell frame, a death at a pad; clicks are left to the scripts', async () => {
  const path = require('path');
  const file = path.join(__dirname, '..', 'lib', 'map-hooks.json');
  const had = require('fs').existsSync(file);
  const backup = had ? require('fs').readFileSync(file) : null;
  require('fs').writeFileSync(file, JSON.stringify({ hooks: {
    'Overworld/town-overworld.swf': [
      { mapItem: 1804, on: 'cell', cell: 'Enter', questValue: { slot: 122, op: '==', value: 9 }, where: 'MainTimeline.frame8' },
      { mapItem: 1900, on: 'join', where: 'MainTimeline.frame1' },
      { mapItem: 1950, on: 'join', where: 'MainTimeline.giveStuff' },
      { mapItem: 1999, on: 'click', where: 'npcBtn.onClick' },
    ],
    'FireWar/town-firewar.swf': [{ mapItem: 5799, on: 'event', event: 'playerDeath', quest: 6299, monPad: 23, where: 'MainTimeline.eventTrigger' }],
  } }));
  delete require.cache[require.resolve('../lib/net/headless')];
  try {
    const { HeadlessClient: HC } = require('../lib/net/headless');
    const c = new HC({ id: 'hooktest', label: 'hooktest', username: 'Tester' });
    c.sent = []; c.write = (m) => c.sent.push(m);
    c.w.myAvatar.uid = 11;
    const asked = () => c.sent.filter((m) => String(m).includes('%getMapItem%')).map((m) => Number(String(m).split('%')[5]));
    c.w.strMapFileName = 'Overworld/town-overworld.swf'; c.w.strFrame = 'Enter';
    eq([c.mapHooks('join'), c.mapHooks('cell', 'Enter')], [1, 0], 'load code yes; quest slot 122 not at 9 yet');
    c.setQuestValue(122, 9);
    c._hookFired = new Set();
    c.mapHooks('join'); c.mapHooks('cell', 'Enter'); c.mapHooks('cell', 'Enter');
    eq(asked(), [1900, 1900, 1804], 'once per visit; never the helper without a condition, never the click');
    c.sent = [];
    c.w.strMapFileName = 'FireWar/town-firewar.swf';
    c.onPlayerDeath({ userID: 11, monPad: 23 });
    eq(asked(), [], 'quest 6299 not in progress');
    c.accepted.add(6299);
    c.onPlayerDeath({ userID: 11, monPad: 5 });
    c.onPlayerDeath({ userID: 11, monPad: 23 });
    eq(asked(), [5799], 'only for the pad the map checks');
  } finally {
    if (had) require('fs').writeFileSync(file, backup); else require('fs').unlinkSync(file);
    delete require.cache[require.resolve('../lib/net/headless')];
  }
});

// Step 5: the watchdog says why a task is stuck; known causes get a remedy, unknown ones go on the owner's list.
test('parity: stuck diagnosis - full backpack, missing monster, map code, unknown -> Needs a look', async () => {
  const fs = require('fs'); const path = require('path');
  const { Hub } = require('../lib/hub');
  const { P } = require('../lib/paths');
  const hub = Object.create(Hub.prototype);
  hub.notify = () => {};
  hub._attention = [];
  const t = { type: 'script', path: 'Dailies/LordOfOrder.cs', why: 'LoO', brain: true };
  const mk = (free, mons, map = 'wardwarf') => ({ id: 'dx', account: { label: 'dx', kind: 'party' }, lastLog: [], freeSlots: async () => free, map: async () => map,
    client: { w: { strMapName: map, monsters: mons.map((n) => ({ strMonName: n })) }, mannersWait: null, slowWarnings: () => 0 } });
  let d = await hub.diagnose(mk(0, ['Drow Assassin']), t, '(HuntMonster) Killing Drow Assassin for item: "Suppressed Drows" #/#');
  eq([d.cause, d.remedy && d.remedy.type], ['backpack full', 'tidy']);
  d = await hub.diagnose(mk(10, ['Drow Soldier']), t, '(HuntMonster) Killing Drow Assassin for item: "Suppressed Drows" #/#');
  eq([d.cause, !!d.attention], ['monster missing', false], 'first time: re-join, no alarm');
  const file = path.join(P.KNOWLEDGE, 'map-events.json');
  fs.mkdirSync(P.KNOWLEDGE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ trapmap: { 'trap door': { n: 3 } } }));
  d = await hub.diagnose(mk(10, ['Guard'], 'trapmap'), t, '(HuntMonster) Killing Guard for item: "Key Shard" 0/1');
  eq([d.cause, d.attention], ['map code', true]);
  d = await hub.diagnose(mk(10, ['Guard'], 'quietmap'), t, '(Something) odd step');
  eq([d.cause, d.attention], ['unknown', true]);
  hub.attend({ id: 'dx', account: { label: 'dx' } }, t, '(Something) odd step', d);
  hub.attend({ id: 'dx', account: { label: 'dx' } }, t, '(Something) odd step', d);
  eq([hub.attentionList().length, hub.attentionList()[0].n], [1, 2], 'one entry, counted');
  eq(hub.dismissAttention(hub.attentionList()[0].key).length, 0);
  fs.unlinkSync(file);
});

test('parity: map hooks on a monster death check which monster (roc: slot 1 dead and quest slot 22 at 33)', async () => {
  const fs = require('fs'); const path = require('path');
  const file = path.join(__dirname, '..', 'lib', 'map-hooks.json');
  const backup = fs.existsSync(file) ? fs.readFileSync(file) : null;
  fs.writeFileSync(file, JSON.stringify({ hooks: { 'Roc/town-roc.swf': [{ mapItem: 62, on: 'event', event: 'monDeath', args: 1, questValue: { slot: 22, op: '==', value: 33 }, where: 'MainTimeline.eventTrigger' }] } }));
  delete require.cache[require.resolve('../lib/net/headless')];
  try {
    const { HeadlessClient: HC } = require('../lib/net/headless');
    const c = new HC({ id: 'roctest', label: 'roctest', username: 'Tester' });
    c.sent = []; c.write = (m) => c.sent.push(m);
    c.w.strMapFileName = 'Roc/town-roc.swf';
    const asked = () => c.sent.filter((m) => String(m).includes('%getMapItem%')).length;
    c.setQuestValue(22, 33);
    c.monsterUpdated({ MonMapID: 2, strMonName: 'Bird', intHP: 0, intState: 0 }, true);
    eq(asked(), 0, 'another monster');
    c.monsterUpdated({ MonMapID: 1, strMonName: 'Roc', intHP: 0, intState: 0 }, true);
    eq(asked(), 1, 'the roc');
  } finally {
    if (backup) fs.writeFileSync(file, backup); else fs.unlinkSync(file);
    delete require.cache[require.resolve('../lib/net/headless')];
  }
});
