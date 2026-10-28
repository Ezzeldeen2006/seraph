// 2026-10-27 fixes: (1) the owner's main was dropped with no multiLoginWarning when he logged in and the reconnect logged it
// back in over him; (2) a nameless repeat drop crashed Skua scripts (Kathool Adept); (3) that crash dropped his order.

function ownerHub(settings = {}) {
  const { Hub } = require('../lib/hub');
  const info = []; const notes = [];
  const acc = { id: 'grail26', label: 'grail26', username: 'Grail26', owner: 'owner', kind: 'guest' };
  const client = { state: { loaded: false }, reset() {}, start() { this.tries = (this.tries || 0) + 1; return new Promise(() => {}); } };
  const main = { id: 'grail26', running: true, account: acc, lines: [], journal(m) { this.lines.push(m); }, stop() { this.running = false; }, start() {} };
  const hub = Object.assign(Object.create(Hub.prototype), { settings, info: (m) => info.push(m), emit() {},
    notify: (t, b) => notes.push(`${t}: ${b}`), bots: new Map([['grail26', main]]), clients: new Map([['grail26', client]]) });
  return { hub, acc, client, main, info, notes };
}
const guild = (server) => ({ cmd: 'updateGuild', guild: { Name: 'Some Guild', ul: [{ userName: 'grail26', Server: server }, { userName: 'someone', Server: 'Artix' }] } });

test('owner drop: an unexplained drop of the main waits, and the guild list showing it online = stand aside', async () => {
  const { hub, acc, client, main, info } = ownerHub({ ownerDropWaitMin: 0.002 });   // 120 ms
  hub.reconnect(acc, client, main);
  assert(client._ownerDropAt > 0, 'waiting in case it is him');
  assert(main.lines.some((l) => /without a "logged in elsewhere" warning/.test(l)), main.lines.join(' | '));
  hub.ownerGuild(guild('Offline'), { id: 'sable7' });
  hub.ownerGuild(guild('Swordhaven (EU)'), { id: 'nova7' });
  assert(client._holdOffline, 'stood aside');
  assert(acc.ownerOn > 0, 'marked as his');
  await new Promise((r) => setTimeout(r, 200));
  eq(client.tries, undefined, 'never logged in over him');
  assert(info.some((m) => /that is you/.test(m)), info.join(' | '));
});

test('owner drop: nobody shows up in the wait - it logs back in', async () => {
  const { hub, acc, client, main } = ownerHub({ ownerDropWaitMin: 0.001 });
  hub.reconnect(acc, client, main);
  hub.ownerGuild(guild('Offline'), { id: 'sable7' });
  await new Promise((r) => setTimeout(r, 150));
  eq(client.tries, 1, 'logged back in after the wait');
  // Its own login shows on the guild list: that is not him.
  hub.ownerGuild(guild('Swordhaven (EU)'), { id: 'sable7' });
  assert(!client._holdOffline, 'our own login is not a reason to stand aside');
});

test('owner drop: a disconnect Seraph asked for, and party bots, log straight back in', async () => {
  const { hub, acc, client, main } = ownerHub({ ownerDropWaitMin: 60 });
  client._plannedDropAt = Date.now();
  hub.reconnect(acc, client, main);
  eq(client._ownerDropAt, null, 'planned: no wait');
  const party = ownerHub({ ownerDropWaitMin: 60 });
  party.acc.kind = 'party';
  party.hub.reconnect(party.acc, party.client, party.main);
  eq(party.client._ownerDropAt, null, 'a party bot never waits');
});

test('owner drop: his logout on the guild list brings a stood-aside main back (the friend list never carried it)', async () => {
  const { hub, acc, client, main } = ownerHub({ ownerLogoutMin: 0.0005 });
  const online = [];
  hub.goOnline = (id) => { online.push(id); hub.ownerClear(id); client._holdOffline = false; return { ok: true }; };
  hub.ownerGuild(guild('Swordhaven (EU)'), { id: 'sable7', account: { label: 'Sable7' } });   // first sight: a snapshot
  hub.standAside(acc, client, main);
  hub.ownerGuild(guild('Offline'), { id: 'sable7', account: { label: 'Sable7' } });
  hub.ownerGuild(guild('Offline'), { id: 'nova7', account: { label: 'Nova7' } });
  await new Promise((r) => setTimeout(r, 120));
  eq(online, ['grail26'], 'back in once');
});

test('nameless repeat drop: filled from an earlier drop, or left out - never handed to Skua without a name', () => {
  const { fillDrops, rememberItems } = require('../lib/skua/engine');
  rememberItems({ 8940: { ItemID: 8940, sName: 'Treasure Chest', iQty: 1, bTemp: 0 } });
  const a = fillDrops({ cmd: 'dropItem', items: { 8940: { ItemID: '8940', iQty: 1 } } }, null);
  eq(a.items['8940'].sName, 'Treasure Chest');
  eq(a.items['8940'].ItemID, 8940);
  const fromModel = fillDrops({ cmd: 'dropItem', items: { 77: { ItemID: '77', iQty: 2 } } }, { invTree: { 77: { ItemID: 77, sName: 'Sun Zone Chit', iQty: 5 } } });
  eq(fromModel.items['77'].sName, 'Sun Zone Chit');
  eq(fromModel.items['77'].iQty, 2, 'the drop quantity, not the stack');
  const unknown = fillDrops({ cmd: 'dropItem', items: { 99999991: { ItemID: '99999991', iQty: 1 } } }, null);
  eq(Object.keys(unknown.items).length, 0, 'nothing to name it with: left out');
  const full = { cmd: 'dropItem', items: { 5: { ItemID: 5, sName: 'Bone Dust' } } };
  assert(fillDrops(full, null) === full, 'a normal drop goes through untouched');
});

test('an order that crashes while making progress is not dropped; one that never progresses is, with an alert', async () => {
  const { Bot } = require('../lib/bot');
  const alerts = [];
  const run = async (gainEach) => {
    const bot = Object.create(Bot.prototype);
    require('events').EventEmitter.call(bot);
    Object.assign(bot, { id: 'grail26', account: { label: 'grail26' }, settings: { autopilot: false, autoGear: false }, queue: [], stats: { quests: 0, drops: 0, kills: 0, deaths: 0 }, itemProgress: 0,
      hub: { notify: (t, b) => alerts.push(`${t}: ${b}`) }, lines: [], brain: null, registered: new Map() });
    bot.journal = (m) => bot.lines.push(m);
    bot.save = () => {}; bot.ensureLogin = async () => {}; bot.ensureServer = async () => {}; bot.stampPublic = () => {};
    bot.useBoosts = async () => {}; bot.noteTaskEnd = () => {}; bot.settleOutfit = async () => {};
    let runs = 0;
    bot.runTask = async () => { runs++; if (gainEach) bot.itemProgress += 5; if (runs >= 6) { bot.stopFlag = true; return true; } throw new Error('Object reference not set to an instance of an object.'); };
    bot.queue.push({ type: 'script', path: 'Other/Classes/KathoolAdept.cs', why: 'Kathool Adept (from the dashboard)' });
    const stopper = setTimeout(() => { bot.stopFlag = true; }, 3000);
    await bot.loop();
    clearTimeout(stopper);
    return { runs, bot };
  };
  const progressing = await run(true);
  assert(progressing.runs >= 4, `kept going while it gained (${progressing.runs} runs)`);
  const stuck = await run(false);
  eq(stuck.runs, 3, 'three failures without progress, then dropped');
  assert(stuck.bot.lines.some((l) => /gave up on the order/.test(l)), stuck.bot.lines.join(' | '));
  assert(alerts.some((a) => /order dropped/.test(a)), alerts.join(' | '));
});

test('a resting order stays in the queue and runs again after its rest (2026-10-27: Kathool and ArchMage vanished)', () => {
  const { Bot } = require('../lib/bot');
  const bot = Object.create(Bot.prototype);
  Object.assign(bot, { queue: [
    { type: 'script', path: 'Other/Classes/KathoolAdept.cs', why: 'Kathool', restUntil: Date.now() + 3600000 },
    { type: 'script', path: 'ShadowsOfWar/RGOWQuestPrereq.cs', why: 'RGOW' },
  ], settings: {} });
  bot.goldNow = () => 0;
  const t = Bot.prototype.nextOrder.call(bot);
  eq(t.why, 'RGOW', 'the resting order is passed over');
  eq(bot.queue.length, 1, 'and kept');
  bot.queue[0].restUntil = Date.now() - 1;
  eq(Bot.prototype.nextOrder.call(bot).why, 'Kathool', 'its rest is over: it runs');
});

test('a Skua script owns its boss fight: deaths do nothing for 20 min, a gain restarts the clock, then Seraph steps in', () => {
  const { Bot } = require('../lib/bot');
  const bot = Object.create(Bot.prototype);
  Object.assign(bot, { settings: {}, lines: [], itemProgress: 0, current: { type: 'script', path: 'Other/Classes/KathoolAdept.cs' } });
  bot.journal = (m) => bot.lines.push(m);
  const boss = { name: 'Voice in the Sea' };
  const t0 = 1e12;
  assert(bot.scriptOwnsFight(boss, t0), 'first death: the script fights on');
  assert(bot.scriptOwnsFight(boss, t0 + 10 * 60000), '10 min in: still the script');
  bot.itemProgress = 3;
  assert(bot.scriptOwnsFight(boss, t0 + 19 * 60000), 'it gained something');
  assert(bot.scriptOwnsFight(boss, t0 + 35 * 60000), 'the clock started again at the gain');
  assert(!bot.scriptOwnsFight(boss, t0 + 40 * 60000), '21 min with nothing: Seraph steps in');
  assert(bot.lines.some((l) => /class ladder and party help take over/.test(l)), bot.lines.join(' | '));
  bot.current = { type: 'script', raid: 'r1' };
  assert(!bot.scriptOwnsFight(boss, t0), 'raids keep their own rules');
});

test('engine slots: a character between two tasks keeps its slot for a minute; a hand-over gives it away', () => {
  const { Hub } = require('../lib/hub');
  const hub = Object.assign(Object.create(Hub.prototype), { settings: { maxEngines: 2 }, headless: true, info() {},
    engineBusy: new Set(['a', 'b']), engineSince: new Map(), engineYielding: new Set(), engines: new Map(), engineWaiting: new Set(['c']) });
  hub.engineLoadNow = () => null;
  hub.engineDone({ id: 'a' });
  eq(hub.engineHeld(), 1, "a's slot is held");
  assert(!hub.engineRoom({ id: 'c' }).ok, 'the waiter does not get the held slot');
  hub.engineHolds.set('a', Date.now() - 1);
  eq(hub.engineHeld(), 0, 'the hold runs out');
  assert(hub.engineRoom({ id: 'c' }).ok, 'then the slot is free');
  hub.engineBusy.add('a');
  hub.engineYielding.add('a');
  hub.engineDone({ id: 'a' });
  eq(hub.engineHeld(), 0, 'a hand-over keeps nothing');
});

test('pre-fight: a script already on the learned class is not restarted for a rotation mode (Nova at Dage)', () => {
  const fp = require('../lib/fightplan');
  const bot = { id: 'nova7-test', journal() {}, _learned: {} };
  const book = fp.learned(bot);
  book['Dage the Evil'] = { cls: 'Void Highlord', mode: 'Solo' };
  const r = fp.preFight(bot, 'Dage the Evil', 'k', { now: Date.now(), start: 'Void Highlord', slot: 'solo', owned: ['Void Highlord', 'Verus DoomKnight'], wanted: null });
  eq(r, null, 'no restart');
  delete book['Dage the Evil'];
});

test("the owner's main on one of his orders answers no help calls; on the brain's goals it still helps", () => {
  const { Hub } = require('../lib/hub');
  const hub = Object.assign(Object.create(Hub.prototype), { settings: {} });
  const main = { account: { kind: 'guest', helper: true }, current: { type: 'script', path: 'Other/Classes/KathoolAdept.cs', why: 'Kathool Adept (from the dashboard)' }, queue: [] };
  assert(hub.mainOnOrder(main), 'his order: no calls');
  main.current = { type: 'script', path: 'Nation/AFDL/0DoAll.cs', brain: true };
  assert(!hub.mainOnOrder(main), "the brain's goal: it helps");
  main.current = null;
  main.queue = [{ type: 'script', path: 'x.cs', why: 'order' }];
  assert(hub.mainOnOrder(main), 'between tasks with an order waiting: no calls');
  main.queue[0].restUntil = Date.now() + 60000;
  assert(!hub.mainOnOrder(main), 'a resting order does not count');
  hub.settings.mainHelpsDuringOrders = true;
  main.queue[0].restUntil = 0;
  assert(!hub.mainOnOrder(main), 'switch: the old way');
  assert(!hub.mainOnOrder({ account: { kind: 'party' }, current: { type: 'script' } }), 'party bots are not affected');
});

test('an order whose script stopped on a full backpack goes again (3 times at most); other ends are left alone', () => {
  const { Bot } = require('../lib/bot');
  const bot = Object.create(Bot.prototype);
  Object.assign(bot, { queue: [], lines: [], settings: {} });
  bot.journal = (m) => bot.lines.push(m); bot.save = () => {};
  bot.bankAc = () => Promise.resolve(0); bot.bankHouse = () => Promise.resolve(0);
  const task = { type: 'script', path: 'Other/Classes/KathoolAdept.cs', why: 'Kathool', startedAt: Date.now() - 60000 };
  bot.makeRoomFor('Unbank: The destination inventory is full. Please clear space and restart the bot.');
  assert(bot.fullStopRequeue(task), 'requeued');
  eq(bot.queue[0].fullRetries, 1);
  eq(bot.queue[0].startedAt, undefined, 'a fresh copy');
  assert(!bot.fullStopRequeue(task), 'only once per stop');
  const t3 = Object.assign({}, task, { fullRetries: 3 });
  bot._fullStopAt = Date.now();
  assert(!bot.fullStopRequeue(t3), 'three times is enough');
  bot._fullStopAt = Date.now();
  assert(!bot.fullStopRequeue(Object.assign({}, task, { brain: true })), "the brain's goals are the brain's");
});

test('owner drop: a connection that went silent before it closed is the network - no wait', async () => {
  const { hub, acc, client, main } = ownerHub({ ownerDropWaitMin: 60 });
  client.lastInbound = Date.now() - 51000;
  hub.reconnect(acc, client, main);
  eq(client._ownerDropAt, null, 'silent 51 s: Wi-Fi, logs straight back in');
  const fresh = ownerHub({ ownerDropWaitMin: 60 });
  fresh.client.lastInbound = Date.now() - 1000;
  fresh.hub.reconnect(fresh.acc, fresh.client, fresh.main);
  assert(fresh.client._ownerDropAt > 0, 'closed while packets were flowing: maybe the owner - waits');
});

test('send queue: a walk goes ahead of queued attacks and only the newest walk is kept (Carnax laser)', () => {
  const { HeadlessClient } = require('../lib/net/headless');
  const c = new HeadlessClient({ id: 'walk', label: 'walk', username: 'W' });
  c.sock = { destroyed: false, write() {} };
  c.flushing = true;   // hold the queue so its order can be read
  c.swf = { onOutgoing() {} };
  c.write('%xt%zm%gar%1%1%aa>m:1%wvz%');
  c.write('%xt%zm%gar%1%2%a2>m:1%wvz%');
  c.write('%xt%zm%mv%11821%100%400%8%');
  c.write('%xt%zm%mv%11821%700%420%8%');
  eq(c.outbox[0], '%xt%zm%mv%11821%700%420%8%', 'the newest walk first');
  eq(c.outbox.filter((m) => m.includes('%mv%')).length, 1, 'one walk queued');
});
