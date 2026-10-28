// Phase 2 of the 2026-09-28 overhaul: the laptop's CPU. Big reads (bags, bank, quest tree) are reused until their own
// structure changes (per-structure revisions, here and in the engine host), the values Skua polls are pushed to the
// host instead of asked for (the mirror), plus the smaller memory items (compact quest index, idle engines, send queue).
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const protocol = require('../lib/net/protocol');
const { HeadlessClient } = require('../lib/net/headless');
const { SwfWorld } = require('../lib/skua/swfworld');

function client() {
  const c = new HeadlessClient({ id: 'perftest', label: 'perftest', username: 'Tester' });
  c.sent = [];
  c.write = (m) => { c.sent.push(m); c.swf.onOutgoing(m); };
  c.sock = { destroyed: false };
  c.state.loaded = true;
  c.w.myAvatar.uid = 11;
  return c;
}
const pkt = (o) => protocol.parse(JSON.stringify({ t: 'xt', b: { r: -1, o } }));
function area(c) {
  c.handle(pkt({ cmd: 'moveToArea', areaId: 77, areaName: 'faerie-77', strMapName: 'faerie', strMapFileName: '',
    monmap: [{ MonMapID: 1, MonID: 9, strFrame: 'r2' }], mondef: [{ MonID: 9, strMonName: 'Pixie', intLevel: 5 }],
    monBranch: [{ MonMapID: 1, MonID: 9, intHP: 80, intHPMax: 100, intState: 1 }],
    uoBranch: [{ uoName: 'tester', strUsername: 'Tester', entID: 11, intHP: 500, intHPMax: 600, intMP: 50, intMPMax: 100, intState: 1, intLevel: 20, strFrame: 'Enter', strPad: 'Spawn' }] }));
  c.handle(pkt({ cmd: 'initUserData', uid: 11, data: { strUsername: 'Tester', intLevel: 20, intGold: 100, iCP: 1200, strQuests: '0a', iUpgDays: -1, iBagSlots: 30, eqp: {} } }));
  c.handle(pkt({ cmd: 'loadInventoryBig', items: [{ ItemID: 1, sName: 'Sword', CharItemID: 5, iQty: 1, bEquip: 1, sES: 'Weapon' }], factions: [], bankCount: 0 }));
  c.handle(pkt({ cmd: 'sAct', actions: { active: [{ ref: 'aa', typ: 'aa', tgt: 'h', cd: 2000, auto: true, isOK: true }, { ref: 'a1', tgt: 'h', cd: 3000, mp: 10, isOK: true }], passive: [] } }));
}

test('revisions: each big structure moves only with what changes it', async () => {
  const c = client();
  area(c);
  const r = () => ({ ...c.swf.rev });
  let before = r();
  const moved = () => { const now = r(); const out = Object.keys(now).filter((k) => now[k] !== before[k]).sort(); before = now; return out; };
  c.handle(pkt({ cmd: 'ct', m: { 1: { intHP: 50 } }, p: { tester: { intHP: 480 } } }));
  c.handle(pkt({ cmd: 'cb', m: { 1: { intHP: 40 } } }));
  c.handle(pkt({ cmd: 'aura+', tInf: 'p:11', auras: [{ nam: 'Focus', val: 4 }] }));
  eq(moved(), [], 'combat and auras leave the bags alone');
  c.swf.call('useSkill', [1]); c.swf.call('attackMonsterName', ['pixie']); c.swf.call('jumpCorrectRoom', ['r2', 'Left']);
  c.swf.call('getGameObject', ['world.myAvatar.items']); c.swf.call('killLag', [true]);
  c.swf.call('callGameFunction', ['world.getQuestValue', 3]); c.swf.call('callGameFunction', ['world.moveToCell', 'r2', 'Left']);
  eq(moved(), [], 'skills, attacks, jumps, reads and options too');
  c.handle(pkt({ cmd: 'loadBank', bitSuccess: 1, items: [{ ItemID: 90, sName: 'Old Cape', CharItemID: 12, iQty: 1 }] }));
  eq(moved(), ['bank'], 'loadBank');
  c.handle(pkt({ cmd: 'getQuests', quests: { 500: { QuestID: 500, sName: 'Q', turnin: [{ ItemID: 70, iQty: 1 }], oItems: { 70: { ItemID: 70, sName: 'Fang' } } } } }));
  eq(moved(), ['quests'], 'getQuests');
  c.swf.call('callGameFunction', ['world.acceptQuest', 500]);
  eq(moved(), ['quests'], 'acceptQuest (the model marks it at once, as the game does)');
  c.handle(pkt({ cmd: 'addItems', items: { 70: { ItemID: 70, sName: 'Fang', iQty: 1, bTemp: 1 } } }));
  eq(moved(), ['items', 'quests', 'temp'], 'addItems (a temp drop never touches the bank)');
  c.handle(pkt({ cmd: 'turnIn', sItems: '70:1' }));
  eq(moved(), ['items', 'quests', 'temp'], 'turnIn');
  c.handle(pkt({ cmd: 'loadShop', shopinfo: { ShopID: 3, items: [] } }));
  eq(moved(), ['shop'], 'loadShop');
  c.handle(pkt({ cmd: 'addGoldExp', intExp: 10, intGold: 5, typ: 'm' }));
  eq(moved(), [], 'gold and XP alone');
  c.handle(pkt({ cmd: 'addGoldExp', intExp: 10, iCP: 20, typ: 'm' }));
  eq(moved(), ['items'], 'class points (the class item carries them)');
  c.swf.call('setGameObject', ['world.myAvatar.objData.intGold', 5]);
  eq(moved(), ['bank', 'house', 'items', 'quests', 'shop', 'temp'], 'a write anyone could make moves everything');
  c.swf.call('callGameFunction', ['world.someNewThing']);
  eq(moved(), ['bank', 'house', 'items', 'quests', 'shop', 'temp'], 'so does an unknown game function');
  c.swf.reset();
  eq(moved(), ['bank', 'house', 'items', 'quests', 'shop', 'temp'], 'a fresh connection');
  c.swf.w.cancelAutoAttack();
});

test('revisions: a big read is computed once per revision, and a change is seen at once', async () => {
  const c = client();
  area(c);
  c.handle(pkt({ cmd: 'loadBank', bitSuccess: 1, items: [{ ItemID: 90, sName: 'Old Cape', CharItemID: 12, iQty: 1 }] }));
  let resolved = 0;
  const orig = c.swf.resolve.bind(c.swf);
  c.swf.resolve = (o, p) => { if (p === 'world.bankinfo.items') resolved++; return orig(o, p); };
  const first = c.swf.call('getGameObject', ['world.bankinfo.items']);
  for (let i = 0; i < 5; i++) { c.swf.call('useSkill', [1]); c.handle(pkt({ cmd: 'ct', m: { 1: { intHP: 60 - i } } })); c.handle(pkt({ cmd: 'moveToCell', strFrame: 'r2' })); }
  eq(c.swf.call('getGameObject', ['world.bankinfo.items']), first);
  eq(resolved, 1, 'skills, combat and other packets keep the answer (before: every one threw it away)');
  c.handle(pkt({ cmd: 'bankToInv', ItemID: 90 }));
  eq(JSON.parse(c.swf.call('getGameObject', ['world.bankinfo.items'])), [], 'the bank changed: fresh at once');
  eq(resolved, 2);
  c.swf.w.cancelAutoAttack();
});

test('mirror: the pushed values are exactly what a call would answer, and reading them changes nothing', async () => {
  const c = client();
  area(c);
  const rev = JSON.stringify(c.swf.rev);
  const m = c.swf.mirrorSnapshot();
  eq(JSON.stringify(c.swf.rev), rev, 'no revision moved');
  eq(Object.keys(m).length, 23);
  for (const [k, v] of Object.entries(m)) {
    const [fn, a] = k.split('|');
    eq(v, c.swf.call(fn, a ? [a] : []), k);
  }
  eq([m['getGameObject|world.strMapName'], m['isLoggedIn|'], m['getGameObject|world.myAvatar.dataLeaf.intHP']], ['"faerie"', 'true', '500']);
  c.swf.w.cancelAutoAttack();
});

// Laptop, first window after the deploy (19:13): syncing after every call cost more Node time than the calls it saved.
test('dirty flag: pure reads leave the model clean, so the engine skips its sync after them', async () => {
  const c = client();
  area(c);
  const swf = c.swf;
  swf.dirty = false;
  for (const [f, a] of [['canUseSkill', [1]], ['getGameObject', ['world.myAvatar.items']], ['isNull', ['world.myAvatar.target']], ['GetAurasValue', ['Self', 'x']],
    ['callGameFunction', ['world.isQuestInProgress', 5]], ['callGameFunction0', ['world.myAvatar.pMC.artLoaded']], ['getMonsters', []]]) swf.call(f, a);
  swf.mirrorSnapshot();
  eq(swf.dirty, false, 'reads and the snapshot itself');
  swf.call('getTargetMonster', []);
  eq(swf.dirty, false, 'getTargetMonster with no target (15,000 calls in 10 min on the laptop)');
  swf.call('jumpCorrectRoom', ['r2', 'Left']);
  swf.call('attackMonsterName', ['pixie']);
  assert(swf.w.myAvatar.target, 'targeted the pixie');
  swf.dirty = false;
  swf.call('getTargetMonster', []);
  eq(swf.dirty, false, 'a live target: a plain read');
  swf.w.myAvatar.target.dataLeaf.intHP = 0;
  swf.call('getTargetMonster', []);
  eq(swf.dirty, true, 'a dead target is dropped: that is a change');
  swf.dirty = false; swf.call('useSkill', [1]); eq(swf.dirty, true, 'a skill');
  swf.dirty = false; c.handle(pkt({ cmd: 'mtls', id: 1, o: { intHP: 5 } })); eq(swf.dirty, true, 'a packet');
  swf.dirty = false; swf.onOutgoing('%xt%zm%moveToCell%77%r2%Left%'); eq(swf.dirty, true, 'an outgoing packet');
  swf.dirty = false; swf.bump('bank'); eq(swf.dirty, true, 'a revision');
  swf.dirty = false; swf.w.touched(); eq(swf.dirty, true, 'a change made by a model timer (map load done, auto attack)');
  c.swf.w.cancelAutoAttack();
});

// Laptop 2026-10-11: every quest drop (addItems) moved the bank revision, so Skua re-read the whole bank 340x per 10 min.
test('bank revision: only packets that really write to the bank move it', async () => {
  const c = client();
  area(c);
  c.handle(pkt({ cmd: 'loadBank', bitSuccess: 1, items: [{ ItemID: 90, sName: 'Old Cape', CharItemID: 12, iQty: 1, bBank: 1 }, { ItemID: 91, sName: 'Banked Ore', CharItemID: 13, iQty: 3, iStk: 99, bBank: 1 }] }));
  const r0 = { ...c.swf.rev };
  c.handle(pkt({ cmd: 'addItems', items: { 700: { ItemID: 700, sName: 'Void Aura', CharItemID: 55, iQty: 1, iQtyNow: 1, bTemp: 0 } } }));
  eq(c.swf.rev.bank, r0.bank, 'a drop into the bag leaves the cached bank alone');
  assert(c.swf.rev.items > r0.items && c.swf.rev.quests > r0.quests, 'bags and quests still move');
  c.handle(pkt({ cmd: 'getDrop', bSuccess: 1, ItemID: 700, CharItemID: 55, iQty: 1, bBank: 0 }));
  eq(c.swf.rev.bank, r0.bank, 'a picked-up drop into the bag');
  c.handle(pkt({ cmd: 'addItems', items: { 91: { ItemID: 91, CharItemID: 13, iQty: 1, iQtyNow: 4, bBank: 1 } } }));
  eq(c.swf.rev.bank, r0.bank + 1, 'a grant straight into a banked stack moves it');
  eq(c.swf.w.bankinfo.bankItems[91].iQty, 4);
  c.handle(pkt({ cmd: 'removeItem', CharItemID: 13, bBank: 1, iQty: 4 }));
  eq(c.swf.rev.bank, r0.bank + 2, 'removing from the bank moves it');
  c.swf.w.cancelAutoAttack();
});

function fakeEngine(c) {
  const engine = require('../lib/skua/engine');
  const eng = new engine.SkuaEngine(c);
  const sent = [];
  const proc = new EventEmitter();
  proc.pid = 1; proc.exitCode = null;
  proc.stdin = { writable: true, write: (s) => sent.push(JSON.parse(s)) };
  eng.proc = proc;
  eng._sent = { rev: null, mirror: {} };
  return { eng, sent };
}

test('engine sync: revisions and mirror go to the host before the answer or packet that follows a change', async () => {
  const c = client();
  area(c);
  const { eng, sent } = fakeEngine(c);
  eng.syncState();
  eq(sent.map((m) => m.t), ['v', 'm'], 'everything at start');
  eq(Object.keys(sent[1].v).length, 23);
  sent.length = 0;
  eng.syncState();
  eq(sent.length, 0, 'nothing changed, nothing sent');
  eng.answerCall({ t: 'c', i: 1, f: 'getGameObject', a: ['world.strFrame'] });
  eq(sent.map((m) => m.t), ['r'], 'a read: just the answer');
  sent.length = 0;
  eng.answerCall({ t: 'c', i: 2, f: 'jumpCorrectRoom', a: ['r2', 'Left'] });
  eq(sent.map((m) => m.t), ['m', 'r'], 'a jump: the new cell first, then the answer');
  eq(sent[0].v, { 'getGameObject|world.strFrame': '"r2"', 'getGameObject|world.strPad': '"Left"' });
  sent.length = 0;
  c.handle(pkt({ cmd: 'loadBank', bitSuccess: 1, items: [{ ItemID: 90, sName: 'Old Cape', CharItemID: 12, iQty: 1 }] }));
  eng.forwardPacket(pkt({ cmd: 'loadBank' }));
  eq(sent.map((m) => m.t), ['v', 'f'], 'a bank packet: the new revision before the packet');
  eq(sent[0].r.bank, c.swf.rev.bank);
  sent.length = 0;
  c.handle(pkt({ cmd: 'ct', p: { tester: { intHP: 321 } } }));
  eng.forwardPacket(pkt({ cmd: 'ct' }));
  eq(sent.map((m) => m.t), ['m', 'f'], 'combat: HP in the mirror, no revision');
  eq(sent[0].v, { 'getGameObject|world.myAvatar.dataLeaf.intHP': '321' });
  eq(sent[1].k, 'c');
  sent.length = 0;
  process.env.SERAPH_MIRROR = '0';
  try {
    c.handle(pkt({ cmd: 'ct', p: { tester: { intHP: 300 } } }));
    eng.syncState();
    eq(sent.length, 0, 'SERAPH_MIRROR=0 turns the mirror off');
  } finally { delete process.env.SERAPH_MIRROR; }
  eng.proc = null;
  c.swf.w.cancelAutoAttack();
});

// The owner 2026-10-09: after a relog the bots "didn't own" banked things. Every login starts with an empty bank, and Skua
// took the server's loadBank answer (no classes, armor or capes) as "loaded". The answer now waits for the HTTP bank.
test('engine: a loadBank answer waits until the whole bank of this login is in, then goes to Skua', async () => {
  const c = client();
  area(c);
  const { eng, sent } = fakeEngine(c);
  eng.syncState(); sent.length = 0;
  const game = c.swf.game;
  const packets = () => sent.filter((m) => m.t === 'f').length;
  let asked = 0;
  game.getBank = () => { asked++; return true; };
  eng.forwardPacket(pkt({ cmd: 'loadBank', bitSuccess: 1, items: [] }));
  eq([asked, packets()], [1, 0], 'held, and the HTTP bank asked for');
  await new Promise((r) => setTimeout(r, 450));
  eq(packets(), 0, 'still held while the bank is on its way');
  game.world.bankinfo.addItemsToBank([{ ItemID: 36920, sName: 'ArchPaladin', sType: 'Class', CharItemID: 70, iQty: 1 }]);
  game.world.bankinfo.loadedAt = Date.now();
  await new Promise((r) => setTimeout(r, 450));
  eq(packets(), 1, 'the bank is in: the answer goes on');
  eng.forwardPacket(pkt({ cmd: 'loadBank', bitSuccess: 1, items: [] }));
  eq([asked, packets()], [1, 2], 'loaded this login: straight through');
  game.world.bankinfo.loadedAt = 0;
  game.getBank = () => { game.world.bankinfo.failedAt = Date.now(); return true; };
  eng.forwardPacket(pkt({ cmd: 'loadBank', bitSuccess: 1, items: [] }));
  await new Promise((r) => setTimeout(r, 450));
  eq(packets(), 3, 'a failed fetch does not hold it');
  game.getBank = () => false;
  eng.forwardPacket(pkt({ cmd: 'loadBank', bitSuccess: 1, items: [] }));
  eq(packets(), 4, 'no fetch possible (no login token): straight through');
  eng.proc = null;
  c.swf.w.cancelAutoAttack();
});

test('engine sync: the packet census counts what goes to the engines', async () => {
  const engine = require('../lib/skua/engine');
  engine.packetStats(true);
  const c = client();
  area(c);
  const { eng } = fakeEngine(c);
  eng.forwardPacket(pkt({ cmd: 'ct', m: {} }));
  eng.forwardPacket(pkt({ cmd: 'ct', m: {} }));
  eng.forwardPacket(pkt({ cmd: 'loadBank', items: [] }));
  const s = engine.packetStats(true);
  eq(s.map((p) => [p.cmd, p.n]).sort(), [['ct', 2], ['loadBank', 1]]);
  assert(s.every((p) => p.bytes > 0));
  eq(engine.packetStats(true), [], 'reset after reading');
  eng.proc = null;
  c.swf.w.cancelAutoAttack();
});

test('quest index: a compact copy with the fields Seraph reads, rebuilt when QuestData.json changes', async () => {
  const qi = require('../lib/questindex');
  const dir = path.join(process.env.SERAPH_ROOT, 'questindex');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'QuestData.json');
  const dest = path.join(dir, 'questindex.json');
  const q = { ID: 7, Slot: 3, Value: 2, Name: 'Seven', Once: true, Field: 'im', Index: 4, Upgrade: false, Level: 10, RequiredClassID: 0, Gold: 5, XP: 9,
    AcceptRequirements: [{ ItemID: 1, sName: 'Key', iQty: 1, sDesc: 'long text', sFile: 'x.swf' }],
    Requirements: [{ ItemID: 2, sName: 'Fang', iQty: 5, sDesc: 'more text', bTemp: '1' }], Rewards: [{ ItemID: 3, sName: 'Ring', iQty: 1, sMeta: 'x' }], SimpleRewards: [{ a: 1 }] };
  fs.writeFileSync(src, JSON.stringify([q]));
  eq(qi.build(src, dest), 1);
  const ix = JSON.parse(fs.readFileSync(dest, 'utf8'));
  eq(ix.quests[0], { ID: 7, Slot: 3, Value: 2, Name: 'Seven', Once: true, Field: 'im', Index: 4, Upgrade: false, Level: 10,
    AcceptRequirements: [{ ItemID: 1, sName: 'Key', iQty: 1 }], Requirements: [{ ItemID: 2, sName: 'Fang', iQty: 5 }], Rewards: [{ ItemID: 3, sName: 'Ring', iQty: 1 }] });
  eq(qi.fresh(ix, src), true);
  fs.writeFileSync(src, JSON.stringify([q, { ...q, ID: 8 }]));
  eq(qi.fresh(ix, src), false, 'a changed file is noticed');
  eq(qi.compact({ ID: 1, Field: null }).Field, null, 'no daily field stays null');
});

test('engines: an idle engine lingers 10 min when memory allows, and makes room for a working one', async () => {
  const { Hub } = require('../lib/hub');
  eq(Hub.engineIdleMs(2000 * 1048576), 10 * 60000);
  eq(Hub.engineIdleMs(300 * 1048576), 3 * 60000, 'short on memory: 3 min, as before');
  // 8 characters on 3 engines: holding 300 MB for a "maybe" is what makes everyone else queue (2026-10-21).
  eq(Hub.engineIdleMs(2000 * 1048576, 1), 20000, 'somebody is waiting: let the slot go at once');
  const disposed = [];
  const idle = (id) => ({ id, client: {}, opts: {}, dispose() { disposed.push(id); } });
  const hub = Object.assign(Object.create(Hub.prototype), { settings: { maxEngines: 2 }, headless: true, info() {}, engines: new Map([['a', idle('a')], ['b', idle('b')]]), engineBusy: new Set(['b']) });
  const bot = { id: 'c', client: new HeadlessClient({ id: 'c', label: 'c', username: 'C' }), settings: {}, journal() {}, wait: async () => {} };
  const eng = await Hub.prototype.engineFor.call(hub, bot);
  eq(disposed, ['a'], 'the idle engine went, the busy one stayed');
  eq([...hub.engines.keys()].sort(), ['b', 'c']);
  assert(eng.client === bot.client, 'a new engine for the character that asked');
});

test('engines: how many may run is decided in one place, and 8 characters do not change it', () => {
  const { Hub } = require('../lib/hub');
  const GB = 1073741824;
  eq(Hub.maxEngines({}, true, 3 * GB), 3, 'the 3 GB laptop: 3 engines (~900 MB), other services untouched');
  eq(Hub.maxEngines({}, true, 8 * GB), 4);
  eq(Hub.maxEngines({}, false, 3 * GB), 4, 'on the PC the Flash client decides, not RAM');
  eq(Hub.maxEngines({ maxEngines: 5 }, true, 3 * GB), 5, 'hub.json still wins');
  // The point of the 2026-10-21 change: the cap is on engines, not characters. A logged-in headless character costs
  // ~15 MB in node, so 8 of them sharing 3 engines is lighter than 4 sharing 5.
  const hub = Object.assign(Object.create(Hub.prototype), { settings: {}, headless: true, info() {}, engines: new Map(), engineBusy: new Set() });
  eq(hub.reclaimIdleEngines('x', 3), 0, 'nothing to free');
});

test('engines: an idle engine is freed before a character queues, not after it wins a slot', () => {
  const { Hub } = require('../lib/hub');
  const gone = [];
  const eng = (id) => ({ id, client: {}, opts: {}, dispose() { gone.push(id); } });
  const hub = Object.assign(Object.create(Hub.prototype), { settings: { maxEngines: 2 }, headless: true, info() {},
    engines: new Map([['a', eng('a')], ['b', eng('b')], ['c', eng('c')]]), engineBusy: new Set(['c']) });
  eq(hub.reclaimIdleEngines('b', 2), 1, 'down to max alive, no further');
  eq(gone, ['a'], 'the idle engine of another character went first');
  assert(hub.engines.has('c') && hub.engines.has('b'), 'the busy one and the asking one stayed');
  // Nothing left to give back once the pool is at its cap with a busy and a kept engine.
  eq(hub.reclaimIdleEngines('b', 2), 0);
});

test('standAside: the owner logging in stops the knocking instead of kicking him back out', async () => {
  const { Hub } = require('../lib/hub');
  const journal = []; const notes = [];
  const client = { state: { loaded: true }, _reconnecting: true, stop() { this.stopped = true; } };
  const bot = { id: 'nova7', running: true, account: {}, journal: (m) => journal.push(m), stop() { this.stopped = true; } };
  const acc = { id: 'nova7', label: 'Nova7', owner: 'claude', kind: 'party', autostart: true };
  const hub = Object.assign(Object.create(Hub.prototype), { settings: { standAsideMin: 120 }, info() {}, emit() {},
    notify: (t, b) => notes.push(`${t}: ${b}`), bots: new Map([['nova7', bot]]), clients: new Map([['nova7', client]]) });
  const r = hub.standAside(acc, client, bot);
  eq(r.minutes, 120, 'first time: the configured wait');
  assert(client._holdOffline, 'it holds itself offline');
  eq(client._reconnecting, false, 'a reconnect already in flight is cancelled - this was the bug');
  assert(client.stopped && bot.stopped, 'logged out and the bot stopped');
  assert(/staying out/.test(journal.join(' ')), journal.join(' '));
  clearTimeout(client._standAsideTimer);
  // He logs in again while it is still standing aside: the wait doubles rather than fighting him for the character.
  const r2 = hub.standAside(acc, client, bot);
  eq(r2.minutes, 240);
  clearTimeout(client._standAsideTimer);
  const r3 = hub.standAside(acc, client, bot);
  eq(r3.minutes, 480, 'capped at 8 h');
  clearTimeout(client._standAsideTimer);
  const r4 = hub.standAside(acc, client, bot);
  eq(r4.minutes, 480, 'and it stays there');
  clearTimeout(client._standAsideTimer);
  assert(notes.length >= 4 && /press Start/.test(notes[0]), notes[0]);
});

test('standAside: one of the owner own accounts stays out until he presses Start', () => {
  const { Hub } = require('../lib/hub');
  const client = { state: { loaded: false } };
  const bot = { id: 'grail26', running: false, account: {}, journal() {}, stop() {} };
  const acc = { id: 'grail26', label: 'grail26', owner: 'owner', kind: 'guest' };
  const hub = Object.assign(Object.create(Hub.prototype), { settings: {}, info() {}, emit() {}, notify() {},
    bots: new Map(), clients: new Map() });
  const r = hub.standAside(acc, client, bot);
  eq(r.until, null, 'no timer: it waits for him');
  eq(r.minutes, null);
  assert(client._holdOffline);
});

test('standAside: the owner own account comes back 10 min after the friend list shows him logged out (2026-10-24)', async () => {
  const { Hub } = require('../lib/hub');
  const { FriendWatch } = require('../lib/friendwatch');
  const notes = []; const info = [];
  const acc = { id: 'grail26', label: 'grail26', username: 'Grail26', owner: 'owner', kind: 'guest', autostart: true };
  const client = { state: { loaded: false } };
  const main = { id: 'grail26', running: true, account: acc, journal() {}, stop() { this.running = false; }, start() { this.started = true; } };
  const seer = { id: 'sable7', account: { label: 'Sable7' } };
  const hub = Object.assign(Object.create(Hub.prototype), { settings: { ownerLogoutMin: 0.001 }, info: (m) => info.push(m), emit() {},
    notify: (t, b) => notes.push(`${t}: ${b}`), bots: new Map([['grail26', main]]), clients: new Map([['grail26', client]]) });
  const online = [];
  hub.goOnline = (id) => { online.push(id); hub.ownerClear(id); client._holdOffline = false; return { ok: true }; };
  hub.standAside(acc, client, main);
  assert(acc.ownerOn > 0 && client._holdOffline, 'marked as his');
  assert(/after you log out/.test(notes[0]), notes[0]);
  const fw = new FriendWatch(hub, { list: '/nonexistent.json' });
  // A whole friend list is a snapshot, not a logout; a server hop (offline, then online again) cancels the wait.
  fw.onPacket(seer, { cmd: 'loadFriendsList', friends: [{ sName: 'Grail26', sServer: 'Offline' }] });
  eq(hub._ownerOff && hub._ownerOff.grail26, undefined, 'no wait from a whole list');
  hub.settings.ownerLogoutMin = 60;
  fw.onPacket(seer, { cmd: 'updateFriend', friend: { sName: 'Grail26', sServer: 'Offline' } });
  assert(hub._ownerOff.grail26, 'his logout starts the wait');
  fw.onPacket(seer, { cmd: 'updateFriend', friend: { sName: 'Grail26', sServer: 'Artix' } });
  eq(hub._ownerOff.grail26, undefined, 'back online: cancelled');
  // He logs out for good: the character comes back and goes to work.
  hub.settings.ownerLogoutMin = 0.0005;   // 30 ms
  fw.onPacket(seer, { cmd: 'updateFriend', friend: { sName: 'Grail26', sServer: 'Offline' } });
  fw.onPacket({ id: 'valen7', account: { label: 'Valen7' } }, { cmd: 'updateFriend', friend: { sName: 'Grail26', sServer: 'Offline' } });
  await new Promise((r) => setTimeout(r, 120));
  eq(online, ['grail26'], 'logged back in once, not once per bot');
  eq(acc.ownerOn, 0, 'no longer marked');
  assert(notes.some((n) => /back online/.test(n)), notes.join(' | '));
  // A dashboard Log out is on purpose: his logout afterwards brings nothing back.
  hub.standAside(acc, client, main);
  hub.ownerClear('grail26');
  eq(hub.ownerFriend({ sName: 'Grail26', sServer: 'Offline' }, seer), null, 'not his any more: nothing happens');
});

test('send queue: packets thrown away over the limit are reported, not silently lost', async () => {
  const c = new HeadlessClient({ id: 'queue', label: 'queue', username: 'Q' });
  const wrote = [];
  c.sock = { destroyed: false, write: (s) => wrote.push(s) };
  const rec = [];
  c.record = (kind, msg) => rec.push([kind, msg]);
  for (let i = 0; i < 70; i++) c.write(`%xt%zm%getMapItem%1%${i}%`);
  await new Promise((r) => setTimeout(r, 300));
  const note = rec.find(([, m]) => /send queue over 60/.test(m));
  assert(note, JSON.stringify(rec));
  assert(/dropped \d+ packet\(s\) \(getMapItem\)/.test(note[1]), note[1]);
  assert(c.outboxDropped > 0);
  c.outbox.length = 0;
  c.sock.destroyed = true;
});

test('send queue: a scroll or potion (taunt) goes ahead of queued attacks (Ultra Speaker 2026-10-24)', async () => {
  const c = new HeadlessClient({ id: 'queue2', label: 'queue2', username: 'Q' });
  const wrote = [];
  c.sock = { destroyed: false, write: (s) => wrote.push(s) };
  c.record = () => {};
  c.write('%xt%zm%gar%1%1%aa>m:1%wvz%');          // goes out at once
  c.write('%xt%zm%gar%1%2%a1>m:1%wvz%');          // waits for the send gap
  c.write('%xt%zm%gar%1%3%a2>m:1%wvz%');
  c.write('%xt%zm%gar%1%4%i1>m:1%12917%wvz%');    // Scroll of Enrage
  await new Promise((r) => setTimeout(r, 900));
  const order = wrote.map((s) => s.split('%')[6]);
  eq(order, ['aa>m:1', 'i1>m:1', 'a1>m:1', 'a2>m:1'], 'the taunt is the next packet out');
  c.sock.destroyed = true;
});

test('skua model: a skill the server refused ("Please slow down") is given back, once (Ultra Speaker Decay 2026-10-24)', () => {
  const c = client();
  area(c);
  const w = c.swf.w;
  const decay = { ref: 'a4', cd: 10000, tgt: 'h', ts: 0, lock: false };
  w.GCDTS = 5;
  w.getActionResult(decay, []);
  assert(decay.lock && decay.ts > 0 && w.GCDTS > 5, 'cast: locked, on cooldown, GCD running');
  const slow = () => c.handle(protocol.parse('%xt%warning%-1%Please slow down. Last action was too soon!%'));
  slow();
  eq(decay.ts, 0, 'its cooldown is back to before the refused cast');
  eq(decay.lock, false);
  eq(w.GCDTS, 5, 'and the global cooldown too');
  w.getActionResult(decay, []);
  const ts = decay.ts;
  slow();
  eq(decay.ts, ts, 'a second refusal within 3 s does not give it back again (no retry loop)');
  c.swf.w.cancelAutoAttack();
});

test('health: the bot process reports its own memory', async () => {
  const { memory } = require('../lib/health');
  const m = memory();
  for (const k of ['rssMb', 'heapUsedMb', 'heapTotalMb', 'heapLimitMb', 'externalMb']) assert(Number.isFinite(m[k]), k);
});

// The whole engine on the fake server with the host comparing every cached and mirrored answer against a fresh one.
test('engine: with the mirror and revision caches on, no answer differs from a fresh one (EngineSmoke, check mode)', async () => {
  const engine = require('../lib/skua/engine');
  const haveEngine = engine.available() && fs.existsSync(path.join(require('../lib/paths').P.SCRIPTS, 'CoreBots.cs'));
  if (!haveEngine) { console.log('      (skipped: no engine build or no script library)'); return; }
  const fake = require('./fakeaqw');
  const srv = await fake.start();
  const c = new HeadlessClient({ id: 'cachecheck', label: 'cachecheck', username: 'Tester' });
  const info = { username: 'Tester', token: 'tok', userId: 1, level: 30, upgradeDays: -1, servers: [srv.server] };
  c.login = info;
  c.swf.setLogin(info, 'x');
  c.swf.setServer(srv.server);
  await c.connect(srv.server, info);
  process.env.SERAPH_CACHE_CHECK = '1';
  try {
    const eng = new engine.SkuaEngine(c);
    const lines = [];
    eng.on('log', (l) => { if (l.kind === 'script' || l.kind === 'error' || /cache mismatch/.test(l.msg)) lines.push(l.msg); });
    await eng.run(path.join(__dirname, 'skua', 'EngineSmoke.cs'));
    const r = await eng.waitDone(150000);
    const st = await eng.status();
    eng.dispose();
    eq([r.error || null, lines.filter((l) => l.startsWith('FAIL') || /cache mismatch/.test(l))], [null, []], lines.join('\n'));
    assert(lines.includes('SMOKE DONE'), lines.join('\n'));
    const f = st.flash || {};
    assert(f.mirrorOn && f.revsOn, JSON.stringify(f));
    assert(f.mirrorHits > 0 && f.revHits > 0 && f.localHits > 0, `every path was used: ${JSON.stringify(f)}`);
    eq(f.checkMismatches, 0);
  } finally { delete process.env.SERAPH_CACHE_CHECK; c.disconnect(); srv.close(); }
}, 200000);

test('inventory: a "Missing Turn In Item" answer re-reads the bags from the server, without a new login (Valen 2026-10-08)', async () => {
  const c = client();
  let logins = 0;
  c.on('loaded', () => logins++);
  area(c);
  const inv = (q) => pkt({ cmd: 'loadInventoryBig', items: [{ ItemID: 43797, sName: 'Hydra Scale Piece', CharItemID: 9, iQty: q, iStk: 5000 }], factions: [], bankCount: 0 });
  c.handle(inv(73));
  eq(logins, 2);
  const add = () => c.handle(pkt({ cmd: 'addItems', items: { 43797: { iQty: 1, iQtyNow: 74, CharItemID: 9, bBank: 0 } } }));
  add(); add();
  const held = () => Number(c.swf.w.invTree[43797].iQty);
  eq(held(), 75, 'two grants with the same iQtyNow count as two');
  c.sent = [];
  c.handle(pkt({ cmd: 'ccqr', bSuccess: 0, QuestID: 8736, sName: 'Monster Machining', msg: 'Missing Turn In Item' }));
  assert(c.sent.some((m) => m.includes('retrieveInventory')), c.sent.join(' | '));
  c.handle(inv(74));
  eq(held(), 74, 'the server count wins');
  eq(logins, 2, 'a re-read is not a login');
  c.sent = [];
  c.handle(pkt({ cmd: 'ccqr', bSuccess: 0, QuestID: 8736, sName: 'Monster Machining', msg: 'Missing Turn In Item' }));
  eq(c.sent.filter((m) => m.includes('retrieveInventory')).length, 0, 'once a minute at most');
});

test('engine: every server packet also reaches Skua raw as "packetFromServer", first, like skua.swf (Ultra Speaker 2026-10-24)', async () => {
  const c = client();
  area(c);
  const { eng, sent } = fakeEngine(c);
  eng.attach();
  const raw = JSON.stringify({ t: 'xt', b: { r: -1, o: { cmd: 'ct', anims: [{ msg: 'All stand equal beneath the eyes of the Eternal.' }] } } });
  c.emit('sfs', protocol.parse(raw), raw);
  const f = sent.filter((m) => m.t === 'f');
  eq(f.map((m) => m.f), ['packetFromServer', 'pext'], 'raw first, then the parsed packet');
  eq(f[0].a, [raw], 'the text exactly as the server sent it - scripts read packet["b"]["o"]');
  eq(f[0].k, 'c', 'never moves the host cache generation a second time');
  c.emit('sfs', protocol.parse(raw));
  eq(sent.filter((m) => m.t === 'f').length, 3, 'an injected packet (no raw text) goes as pext only');
  eng.detach();
  eng.proc = null;
  c.swf.w.cancelAutoAttack();
});
