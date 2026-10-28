// The owner's own accounts (kind 'guest', 2026-10-07): orders only, left out of the party's automation, never logged back
// in over him; repeating and daily orders; "farm until I have N"; the item finder.
const fs = require('fs');
const path = require('path');
const { FakeGame } = require('./fakegame');
const { Bot } = require('../lib/bot');
const { P } = require('../lib/paths');
const { Hub } = require('../lib/hub');
const accounts = require('../lib/accounts');
const finder = require('../lib/finder');
const { serverDay } = require('../lib/util');

async function mk(id, hub, kind = 'party') {
  const dir = P.account(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'login.txt'), `Username: ${id}\nPassword: pw\n`);
  const game = new FakeGame();
  const bot = new Bot(game, { id, label: id, username: id, loginFile: path.join(dir, 'login.txt'), status: 'active', kind }, { hub });
  await bot.login();
  bot.running = true;
  return bot;
}
function fakeHub() {
  const hub = { headless: true, bots: new Map(), clients: new Map(), settings: { levelParty: { enabled: true, room: 94242, maxGap: 25 }, assist: { enabled: false, members: [] }, party: {} }, info() {}, notify() {}, emit() {}, saveSettings() {}, bot(id) { return this.bots.get(id) || null; } };
  for (const k of ['partyBots', 'levelPartyBots', 'inLevelParty', 'assistFor', 'sharedServer', 'goOffline', 'goOnline', 'ownerClear', 'ownerFriend', 'reconnect', 'standAside', 'struggle', 'takeRoute', 'mainNeedsParty', 'soloBosses', 'helpCoolingFor', 'stale', ...Hub.HELP_METHODS]) hub[k] = Hub.prototype[k].bind(hub);
  return hub;
}

test('accounts: a guest account is registered with its kind; removing it deletes its own login file', async () => {
  const acc = accounts.add({ username: 'GuestMain1', password: 'secret', kind: 'guest', owner: 'owner' });
  eq([acc.kind, acc.online, acc.persona], ['guest', false, null]);
  assert(fs.existsSync(acc.loginFile), 'login file written');
  accounts.remove(acc.id);
  assert(!accounts.load().accounts.some((a) => a.id === acc.id), 'unregistered');
  assert(!fs.existsSync(acc.loginFile), 'no password left behind');
});

test('accounts: guests stay out of the party, the level room, shared servers and help calls', async () => {
  const hub = fakeHub();
  const a = await mk('partya1', hub); const g = await mk('guestg1', hub, 'guest');
  hub.bots.set(a.id, a); hub.bots.set(g.id, g);
  eq(hub.levelPartyBots().map((b) => b.id), ['partya1']);
  eq(hub.partyBots().map((b) => b.id), ['partya1']);
  eq(hub.sharedServer(g.account), null, 'picks its own server');
  let restarts = 0; g.restart = () => { restarts++; return Promise.resolve(); };
  g.current = { type: 'script', path: 'Other/Boss.cs', brain: true };
  eq(await hub.struggle(g, { name: 'Boss', hpMax: 1e6 }, 3), null, 'never calls the party (a guest that is not a helper)');
  // The owner 2026-10-15: a boss the main can't solo is reported to him; 2026-10-25: it rests that task and goes on, never stops.
  assert(!g.stopFlag && !g.stoppedByHand, 'the account is not stopped');
  eq(restarts, 1, 'it moves on to other work');
  assert(g.isSkipped(g.current), 'and rests the task');
  assert(!hub.help, 'and no help call is open');
  assert(Hub.isGuest(g) && !Hub.isGuest(a));
});

test('accounts: a daily boss the main cannot solo skips that daily for today and keeps the loop going', async () => {
  const hub = fakeHub();
  const g = await mk('guestg3', hub, 'guest');
  hub.bots.set(g.id, g);
  const day = { dailies: {} };
  hub.brain = { today: () => day, dailyFailed: require('../lib/brain').Brain.prototype.dailyFailed, saveState() {} };
  let restarts = 0; g.restart = () => { restarts++; return Promise.resolve(); };
  g.current = { type: 'daily', name: 'NSoDDaily', why: 'daily NSoDDaily is up' };
  eq(await hub.struggle(g, { name: 'Warlord Icewing', hpMax: 1e6 }, 2), null);
  assert(!g.stoppedByHand, 'not stopped by hand');
  eq([restarts, day.dailies.NSoDDaily, day.dailyFails.NSoDDaily], [1, 'failed', 3]);
  assert(g.isSkipped(g.current), 'held for today');
});

test('accounts: someone logging in to a guest account makes the bot step aside, not log back in', async () => {
  const hub = fakeHub();
  const g = await mk('guestg2', hub, 'guest');
  hub.bots.set(g.id, g);
  const client = g.client;
  let restarted = 0;
  client.reset = () => {}; client.start = () => { restarted++; return Promise.resolve(); }; client.stop = () => {};
  client.state = { loaded: false };
  hub.clients.set(g.id, client);
  client._multiLoginAt = Date.now();
  hub.reconnect(g.account, client, g);
  await new Promise((r) => setTimeout(r, 50));
  eq(restarted, 0, 'no login over the player');
  eq(client._holdOffline, true, 'held offline');
  assert(g.lastLog.some((l) => /staying out/.test(l)), 'said so');
  hub.reconnect(g.account, client, g);
  eq(restarted, 0, 'a later disconnect does not log in either');
  hub.goOnline(g.id);
  eq([restarted, client._holdOffline], [1, false], 'Start brings it back');
});

test('orders: "keep repeating" goes back in the queue; "every day" becomes a routine queued once a day', async () => {
  const bot = await mk('repeater1', null);
  bot.queue = [];
  bot.afterOrder({ type: 'script', path: 'Farm/GoldFarm.cs', repeat: 'always', why: 'gold', startedAt: Date.now() - 120000 }, true);
  eq(bot.queue.length, 1);
  eq(bot.queue[0].startedAt, undefined, 'a fresh copy');
  bot.queue = [];
  bot.afterOrder({ type: 'script', path: 'Farm/GoldFarm.cs', repeat: 'always', why: 'gold', startedAt: Date.now() - 5000 }, false);
  eq(bot.queue.length, 0, 'failed at once: not repeated');
  bot.afterOrder({ type: 'script', path: 'Dailies/0AllDailies.cs', repeat: 'daily', why: 'dailies' }, true);
  eq(bot.settings.routines.length, 1);
  eq(bot.takeRoutines(), 0, 'done today already');
  bot.settings.routines[0].lastDay = '2000-01-01';
  eq(bot.takeRoutines(), 1, 'a new day: queued');
  eq(bot.queue[0].path, 'Dailies/0AllDailies.cs');
  eq(bot.takeRoutines(), 0, 'once a day');
  eq(bot.settings.routines[0].lastDay, serverDay());
});

test('orders: guests keep their own class and gear; the wardrobe never touches them', async () => {
  const g = await mk('guestg3', null, 'guest');
  g.settings.autoGear = false;
  eq(await g.tidyWardrobe(), { sold: 0, banked: 0, skipped: 'guest' });
  eq(await g.saveOutfit(), false);
  eq(await g.showLook(), 0);
  const cbo = require('../lib/skua/cbo');
  g.settings.soloClass = 'Legion Revenant';
  const keys = await cbo.keysFor(g);
  eq([keys.SoloClassSelect, keys.FarmClassSelect], ['Legion Revenant', undefined], "the owner's class picks only");
});

test('orders: farm until I have N - backpack and bank count', async () => {
  const bot = await mk('untilhave1', null);
  bot.client.root.world.myAvatar.items.push({ sName: 'Bone Dust', ItemID: 77, CharItemID: 770, iQty: 40, sES: 'None' });
  bot.bankItems = async () => [{ sName: 'Bone Dust', ItemID: 77, iQty: 25 }];
  eq(await Hub.held(bot, 'bone dust'), 65);
});

test('finder: merge products, Core methods, scripts named after the item, monsters from hunt lines', async () => {
  const dir = path.join(P.ROOT, 'finder-scripts');
  fs.mkdirSync(path.join(dir, 'Other', 'MergeShops'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Farm'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Other', 'MergeShops', 'TestMerge.cs'), 'public void BuyAllMerge(string buyOnlyThis = null) { switch (x) { case "Shiny Rock": Core.HuntMonster("cave", "Rock Golem", "Shiny Rock", 5); break; } }\npublic List<IOption> Select = new() { new Option<bool>(\n "123",\n "Shiny Sword",\n "buy?", false) };');
  fs.writeFileSync(path.join(dir, 'CoreFarmsTest.cs'), 'public class CoreFarms {\n public void ShinyRock(int quant = 10) { Core.HuntMonster("cave", "Rock Golem", "Shiny Rock", quant); }\n}');
  fs.writeFileSync(path.join(dir, 'Farm', 'ShinyRockFarm.cs'), 'public void ScriptMain() { }');
  const sword = await finder.find('Shiny Sword', { dir });
  eq(sword.ways.map((w) => [w.kind, w.entry, w.args]), [['merge', 'BuyAllMerge', '"Shiny Sword"']]);
  const rock = await finder.find('Shiny Rock', { dir, qty: 30 });
  const kinds = rock.ways.map((w) => w.kind);
  assert(!kinds.includes('merge'), 'an ingredient is not bought from the merge');
  assert(rock.ways.some((w) => w.kind === 'method' && w.entry === 'ShinyRock' && w.args === '30'), JSON.stringify(rock.ways));
  assert(rock.ways.some((w) => w.kind === 'script' && w.path === 'Farm/ShinyRockFarm.cs'), 'named after it');
  eq(rock.hunts[0], { map: 'cave', monster: 'Rock Golem', from: rock.hunts[0].from });
  eq((await finder.find('ab', { dir })).note, 'Type at least 3 letters.');
});

// The owner's main, 2026-10-14: first added with a wrong password, then removed and added again. The old client's reconnect
// loop kept logging in every few minutes and restarted the old bot - two copies kicked each other off for 4 hours.
test('accounts: a removed (or replaced) client never reconnects', async () => {
  const hub = fakeHub();
  hub.stale = Hub.prototype.stale.bind(hub);
  const g = await mk('guestg4', hub, 'guest');
  hub.bots.set(g.id, g);
  const client = g.client;
  let starts = 0;
  client.reset = () => {}; client.start = () => { starts++; return Promise.resolve(); }; client.stop = () => {};
  hub.clients.set(g.id, { replaced: true });                  // the account was added again: a new client owns the id
  hub.reconnect(g.account, client, g);
  await new Promise((r) => setTimeout(r, 30));
  eq([starts, !!client._reconnecting], [0, false], 'the old client stays down');
  hub.clients.set(g.id, client); client._closed = true;      // closed by hub.close()
  hub.reconnect(g.account, client, g);
  await new Promise((r) => setTimeout(r, 30));
  eq(starts, 0, 'closed: no reconnect');
});

test('accounts: a guest marked helper answers help calls; a plain guest does not', async () => {
  const g = await mk('guestg5', null, 'guest');
  eq(Hub.helper(g), false);
  g.account.helper = true;
  eq(Hub.helper(g), true);
  eq(Hub.helper({ account: { kind: 'party', helper: true } }), false, 'only for guests');
  const hub = fakeHub();
  hub.helpTask = Hub.prototype.helpTask.bind(hub); hub.assistTaskFor = Hub.prototype.assistTaskFor.bind(hub); hub.endHelp = () => {};
  hub.help = { id: 'h1', by: 'x', who: 'X', server: 'Swordhaven', map: 'frozenlair', room: 1, cell: 'r1', monster: 'Boss', at: Date.now(), until: Date.now() + 600000, helpers: [] };
  g.current = { type: 'script', path: 'Other/Foo.cs', brain: true };   // a goal: on the owner's own orders it answers nothing (ownerdrop.test.js)
  eq(hub.helpTask(g).type, 'assist', 'the helper main joins');
  g.account.helper = false; hub.help.helpers = [];
  eq(hub.helpTask(g), null, 'a plain guest stays out');
});
