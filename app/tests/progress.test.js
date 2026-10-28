// The owner's 2026-09-19 rules: every class the character owns goes to rank 10, and Farmer Joe (the real
// 0FarmerJoeDoAll.cs, in Skua's engine) drives progression until it has finished the whole route.
const fs = require('fs');
const path = require('path');
const { FakeGame } = require('./fakegame');
const { Bot } = require('../lib/bot');
const { Brain } = require('../lib/brain');
const { P } = require('../lib/paths');
const knowledge = require('../lib/knowledge');
const protocol = require('../lib/net/protocol');
const { HeadlessClient } = require('../lib/net/headless');

async function online(level, items = []) {
  const id = `prog${Math.random().toString(36).slice(2, 7)}`;
  const dir = P.account(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'login.txt'), `Username: ${id}\nPassword: pw\n`);
  const game = new FakeGame({ level });
  const bot = new Bot(game, { id, label: id, owner: 'test', loginFile: path.join(dir, 'login.txt') });
  await bot.login();
  game.root.world.myAvatar.items.push(...items);
  return { game, bot };
}

// Only the two new steps: no dailies, events, enhancing or wardrobe in the way.
async function withNewSteps(fn) {
  const was = process.env.SERAPH_TEST_SKIP_FJ;
  const d = knowledge.dailies; const e = knowledge.eventCandidates;
  delete process.env.SERAPH_TEST_SKIP_FJ;
  knowledge.dailies = () => []; knowledge.eventCandidates = () => [];
  try { return await fn(); } finally { process.env.SERAPH_TEST_SKIP_FJ = was; knowledge.dailies = d; knowledge.eventCandidates = e; }
}
const quiet = (brain, bot) => { const day = brain.today(bot); day.enhancedAt = Date.now(); day.styledAt = Date.now(); };

test('progress: an owned class below rank 10 is ranked up with Skua\'s RankUpClass; rank 10, rank-1-only and member-only are not', () => withNewSteps(async () => {
  const brain = new Brain();
  const { bot } = await online(47, [
    { sName: 'Master Ranger', sType: 'Class', ItemID: 7260, CharItemID: 70, sES: 'ar', bEquip: false, iQty: 1200 },
    { sName: 'Rogue', sType: 'Class', ItemID: 5, CharItemID: 71, sES: 'ar', bEquip: false, iQty: 302500 },
    { sName: 'Hobo Highlord', sType: 'Class', ItemID: 6, CharItemID: 72, sES: 'ar', bEquip: false, iQty: 0 },
    { sName: 'Legion Revenant', sType: 'Class', ItemID: 7, CharItemID: 73, sES: 'ar', bEquip: false, iQty: 0, bUpg: 1 },
  ]);
  quiet(brain, bot);
  const t = await brain.next(bot);
  eq([t.type, t.path, t.entry, t.args, t.rankClass], ['script', 'CoreAdvanced.cs', 'RankUpClass', '"Master Ranger"', 'Master Ranger']);
  // Still unranked after two runs: parked for a day, and Farmer Joe comes next.
  await brain.done(bot, t, { ok: true });
  await brain.done(bot, t, { ok: true });
  const t2 = await brain.next(bot);
  eq([t2.type, t2.path, t2.farmerJoe], ['script', 'Other/FarmJoeKits/0FarmerJoeDoAll.cs', true]);
}));

test('progress: Farmer Joe runs until it finishes the route, then waits a week; an early stop is a failed chunk', () => withNewSteps(async () => {
  const brain = new Brain();
  const { bot } = await online(47);
  quiet(brain, bot);
  const t = await brain.next(bot);
  eq([t.path, t.goal, t.hours === undefined], ['Other/FarmJoeKits/0FarmerJoeDoAll.cs', 'farmer-joe', true], 'no time limit: it runs until it is done (2026-09-21)');
  await brain.done(bot, { ...t, startedAt: Date.now() - 60000 }, { ok: true, timedOut: false });
  eq(brain.state(bot).goalFails['farmer-joe'], 1, 'stopped after a minute below level 100');
  await brain.done(bot, { ...t, startedAt: Date.now() - 3 * 3600000 }, { ok: true, timedOut: true });
  assert(!brain.state(bot).fjDoneAt, 'a chunk that used its whole budget is not the end of the route');
  await brain.done(bot, { ...t, startedAt: Date.now() - 2 * 3600000 }, { ok: true, timedOut: false });
  assert(brain.state(bot).fjDoneAt > 0, 'finished the route');
  const next = await brain.next(bot);
  assert(!next.farmerJoe, `done for the week, got ${JSON.stringify(next)}`);
}));

// Found live 2026-09-19: the equipped class item's quantity is its class points (Avatar.updateArmorRep). Without it
// Skua saw every class at rank 1 ("somehow... not rank 10??"), and a spoofed level 100 survived map changes.
test('progress: class points land on the equipped class item, and every map join re-reads the real level', async () => {
  const c = new HeadlessClient({ id: 'cptest', label: 'cptest', username: 'Tester' });
  c.sent = [];
  c.write = (m) => c.sent.push(m);
  c.w.myAvatar.uid = 11;
  c.swf.game.sfc.myUserId = 11;
  const pkt = (o) => c.handle(protocol.parse(JSON.stringify({ t: 'xt', b: { r: -1, o } })));
  pkt({ cmd: 'loadInventoryBig', items: [{ ItemID: 7260, sName: 'Master Ranger', sType: 'Class', sES: 'ar', bEquip: 1, iQty: 1000 }], factions: [] });
  c.swf.w.myAvatar.objData.iCP = 1000;
  pkt({ cmd: 'addGoldExp', intExp: 10, intGold: 5, iCP: 250 });
  eq(c.w.myAvatar.items[0].iQty, 1250, 'headless world');
  eq(Number(c.swf.w.invTree[7260].iQty), 1250, 'skua.swf model');
  c.inventoryLoaded = true;
  pkt({ cmd: 'moveToArea', areaId: 9, areaName: 'icestormarena-1', strMapName: 'icestormarena', monmap: [], mondef: [], uoBranch: [] });
  await new Promise((r) => setTimeout(r, 120));
  assert(c.sent.some((m) => m.startsWith('%xt%zm%retrieveUserData%9%11%')), c.sent.join(' | '));
});

// Found live 2026-09-19: CoreBots injects a fake level-100 levelUp on every /icestormarena join. The real client only
// writes it to objData (client-side map checks); Skua's Bot.Player.Level reads dataLeaf. Treating it as real sent a
// level-47 character to /icestormunder (server: "for players level 75 and above") and counted fake level-ups.
test('progress: CoreBots\' injected level-100 packet opens the arena but is not a real level', async () => {
  const c = new HeadlessClient({ id: 'lvtest', label: 'lvtest', username: 'Tester' });
  c.sent = [];
  c.write = (m) => c.sent.push(m);
  c.w.myAvatar.uid = 11;
  c.swf.game.sfc.myUserId = 11;
  c.handle(protocol.parse(JSON.stringify({ t: 'xt', b: { r: -1, o: { cmd: 'initUserData', uid: 11, data: { strUsername: 'Tester', intLevel: 47 } } } })));
  let ups = 0;
  c.on('levelUp', () => { ups++; });
  const before = c.events.length;
  c.inject('{"t":"xt","b":{"r":-1,"o":{"cmd":"levelUp","intExpToLevel":"0","intLevel":100}}}', 'json');
  eq([c.w.myAvatar.objData.intLevel, c.w.myAvatar.dataLeaf.intLevel, ups], [100, 47, 0], 'headless world');
  eq(Number(c.swf.w.myAvatar.objData.intLevel), 100, 'skua.swf objData (the client-side checks) takes the spoof');
  assert(!c.events.slice(before).some((e) => /levelUp/.test(JSON.stringify(e.data))), 'the bot never sees a level-up');
  c.handle(protocol.parse(JSON.stringify({ t: 'xt', b: { r: -1, o: { cmd: 'levelUp', intLevel: 48, intExpToLevel: '10' } } })));
  eq([c.w.myAvatar.dataLeaf.intLevel, ups], [48, 1], 'a real level-up still counts');
});

// Found live 2026-09-19: the inventory said Rogue had 157 class points; equipping it, the server said 302,500 (rank 10).
test('progress: equipping a class takes its real class points from updateClass (the inventory count can be stale)', async () => {
  const c = new HeadlessClient({ id: 'uctest', label: 'uctest', username: 'Tester' });
  c.sent = [];
  c.write = (m) => c.sent.push(m);
  c.w.myAvatar.uid = 11;
  c.swf.game.sfc.myUserId = 11;
  const pkt = (o) => c.handle(protocol.parse(JSON.stringify({ t: 'xt', b: { r: -1, o } })));
  pkt({ cmd: 'loadInventoryBig', items: [
    { ItemID: 5, sName: 'Rogue', sType: 'Class', sES: 'ar', bEquip: 0, iQty: 157 },
    { ItemID: 7260, sName: 'Master Ranger', sType: 'Class', sES: 'ar', bEquip: 1, iQty: 1 },
  ], factions: [] });
  pkt({ cmd: 'updateClass', uid: 99, sClassName: 'Rogue', iCP: 5 });   // another player
  pkt({ cmd: 'updateClass', uid: 11, sClassName: 'Rogue', sClassCat: 'M2', iCP: 302500 });
  pkt({ cmd: 'equipItem', uid: 11, strES: 'ar', ItemID: 5 });
  pkt({ cmd: 'equipItem', uid: 99, strES: 'ar', ItemID: 7260 });        // another player equips the same class
  const byName = (n) => c.w.myAvatar.items.find((i) => i.sName === n);
  eq([byName('Rogue').iQty, !!byName('Rogue').bEquip, !!byName('Master Ranger').bEquip], [302500, true, false], 'headless world');
  eq(Number(c.swf.w.invTree[5].iQty), 302500, 'skua.swf model');
});

// The owner 2026-09-19: the party plays on one server and in one room, Skua scripts included.
test('party: headless characters follow the first one online to its server, and Skua scripts use the party room', async () => {
  const { Hub } = require('../lib/hub');
  const cbo = require('../lib/skua/cbo');
  const hub = new Hub(null, { headless: true, autoOpen: false });
  const fake = (id, server) => ({ id, account: { id, status: 'active' }, running: true, client: { headless: true, serverName: server, state: { loaded: !!server } } });
  hub.bots.set('a', fake('a', 'Twilly'));
  hub.bots.set('b', fake('b', null));
  eq(hub.sharedServer({ id: 'b' }), 'Twilly', 'follows the character already online');
  eq(hub.settings.partyServer, 'Twilly', 'remembered for the next start');
  eq(hub.sharedServer({ id: 'b', server: 'Yorumi' }), null, "an account's own server wins");
  hub.settings.party = { grouped: false };
  eq(hub.sharedServer({ id: 'b' }), null, 'party off: each picks its own');
  const keys = await cbo.keysFor({ id: 'b', settings: {}, hub: { partyRoom: () => 13579 }, ownedClasses: async () => [] });
  eq([keys.PrivateRooms, keys.PrivateRoomNr], ['True', '13579']);
  const solo = await cbo.keysFor({ id: 'b', settings: {}, hub: { partyRoom: () => null }, ownedClasses: async () => [] });
  eq(solo.PrivateRooms, 'False', 'not in the party: public rooms');
});

test('health: known failure patterns and a split party are reported once, not every 15 minutes', async () => {
  const { Health } = require('../lib/health');
  const sent = [];
  const now = Date.now();
  const ts = (min) => new Date(now - min * 60000).toISOString();
  const mk = (id, server, log) => ({ id, running: true, serverName: server, account: { label: id }, stats: { deaths: 0 }, current: null, lastLog: log,
    playing: async () => true, name: async () => id, g: async (p) => (p === 'world.partyMembers' ? ['a', 'b'] : '') });
  const a = mk('a', 'Twilly', [
    `${ts(30)} [skua] [x] (RankUpClassInternal) "Master Ranger" is somehow... not rank 10??`,
    `${ts(10)} [skua] [x] (RankUpClassInternal) "Master Ranger" is somehow... not rank 10??`,
    `${ts(90)} [skua] [x] Failed to join icestormunder`,   // older than an hour: ignored
  ]);
  const b = mk('b', 'Yorumi', []);
  const hub = { settings: { crowd: false }, bots: new Map([['a', a], ['b', b]]), bot: (id) => (id === 'a' ? a : b), notify: (t, body) => sent.push(`${t}: ${body}`) };
  const h = new Health(hub);
  const f = await h.check(now);
  assert(f.some((x) => /rank-up of Master Ranger ended below rank 10 2x/.test(x.text)), JSON.stringify(f));
  assert(f.some((x) => /split over servers/.test(x.text)), JSON.stringify(f));
  assert(!f.some((x) => /join/.test(x.text)), 'an old line is not a current problem');
  const n = sent.length;
  await h.check(now + 15 * 60000);
  eq(sent.length, n, 'no repeat within 6 h');
  // Crowd mode (the default since 2026-09-25): Artix and Swordhaven on purpose, not a split party (47 false alerts/week).
  hub.settings = {};
  const f2 = await new Health(hub).check(now);
  assert(!f2.some((x) => /split over servers|outside room/.test(x.text)), JSON.stringify(f2));
});

// 2026-09-30: Oren's loop ended after the reset relog and never started again; 26 h idle on a double-XP day.
test('health: a loop that stays stopped is started again, unless it was stopped by hand or is reconnecting', async () => {
  const { Health } = require('../lib/health');
  const sent = [];
  const now = Date.now();
  const mk = (id, extra) => Object.assign({ id, running: false, starts: 0, account: { label: id, autostart: true, status: 'active' }, stats: { deaths: 0 }, lastLog: [],
    start() { this.starts++; this.running = true; return true; }, journal() {}, playing: async () => false }, extra);
  const idle = mk('idle'); const hand = mk('hand', { stoppedByHand: true }); const relog = mk('relog'); const busy = mk('busy', { running: true });
  const bots = new Map([idle, hand, relog, busy].map((b) => [b.id, b]));
  const hub = { settings: {}, bots, clients: new Map([['relog', { _reconnecting: true }]]), bot: (id) => bots.get(id), notify: (t, body) => sent.push(`${t}: ${body}`) };
  const h = new Health(hub);
  await h.check(now);
  await h.check(now + 60000);
  eq(idle.starts, 0, 'one sighting (or two a minute apart) is a restart in progress, not a stuck loop');
  const f = await h.check(now + 15 * 60000);
  eq([idle.starts, hand.starts, relog.starts, busy.starts], [1, 0, 0, 0]);
  assert(f.some((x) => x.bot === 'idle' && /not running for 15 min - started it again/.test(x.text)), JSON.stringify(f));
  assert(sent.some((s) => /not running/.test(s)), 'the owner hears about it');
  eq((await h.check(now + 30 * 60000)).filter((x) => /not running/.test(x.text)).length, 0, 'running again: nothing to report');
});

// 2026-10-10: AQW 5.0 changed the game's network format; all four failed 153 logins each over 15 h and nobody was told.
test('health: characters that can\'t log in are reported, and the whole party offline is a DM to the owner', async () => {
  const { Health } = require('../lib/health');
  const sent = []; const dms = [];
  const now = Date.now();
  const mk = (id) => ({ id, running: false, account: { label: id, status: 'active' }, stats: { deaths: 0 }, lastLog: [], start: () => false, journal() {}, playing: async () => false, stoppedByHand: true });
  const bots = new Map(['a', 'b', 'c'].map((id) => [id, mk(id)]));
  const err = 'the game did not finish loading this character';
  const clients = new Map([['a', { _reconnecting: true, _offlineSince: now - 25 * 60000, _lastLoginError: err }], ['b', { _reconnecting: true, _offlineSince: now - 5 * 60000 }], ['c', {}]]);
  const hub = { settings: {}, bots, clients, bot: (id) => bots.get(id), notify: (t, body) => sent.push(`${t}: ${body}`),
    updater: { state: { game: { sFile: 'Game4000r1.swf', clientVersion: '5.01', changedAt: new Date(now - 3 * 3600000).toISOString() } } },
    discord: { enabled: true, send: (text, o) => dms.push({ text, o }) } };
  const h = new Health(hub);
  let f = await h.check(now);
  eq(f.filter((x) => /log in/.test(x.text)).map((x) => x.bot), ['a'], 'one character 25 min offline; b only 5 min');
  eq(dms.length, 0, 'not a DM while others are in game');
  clients.get('b')._offlineSince = now - 40 * 60000;
  clients.get('c')._offlineSince = now - 21 * 60000;
  f = await h.check(now + 60000);
  const p = f.find((x) => /none of the 3 characters can log in/.test(x.text));
  assert(p && p.text.includes(err) && /Game4000r1\.swf \(client 5\.01\), new since/.test(p.text) && /AQW changed its game/.test(p.text), JSON.stringify(f));
  eq(dms.length, 1, 'the owner gets a DM');
  assert(dms[0].o.dm === true && /bots are offline/.test(dms[0].text));
  await h.check(now + 20 * 60000);
  eq(dms.length, 1, 'once per 6 h');
});

test('reconnect: the bot carries on even when its old loop is still ending as the login comes back', async () => {
  const { Hub, RECONNECT } = require('../lib/hub');
  const old = { ...RECONNECT };
  Object.assign(RECONNECT, { wait: 5, resume: 5 });
  try {
    // The loop needs 600 ms to end after stop() (a Skua script being stopped); the login is back after 10 ms.
    const bot = { running: true, starts: 0, account: { status: 'active' },
      stop() { this.stopFlag = true; setTimeout(() => { this.running = false; }, 600); },
      start() { if (this.running) return false; this.stopFlag = false; this.running = true; this.starts++; return true; },
      restart: Bot.prototype.restart };
    const client = { reset() {}, start: async () => true, serverName: 'Swordhaven' };
    const hub = Object.assign(Object.create(Hub.prototype), { info() {}, settings: {} });
    hub.reconnect({ id: 'oren7' }, client, bot);
    for (let i = 0; i < 100 && !bot.starts; i++) await new Promise((r) => setTimeout(r, 50));
    eq([bot.starts, bot.running, client._reconnecting], [1, true, false]);
  } finally { Object.assign(RECONNECT, old); }
});

// The admin dashboard (2026-09-19): autopilot off = only the owner's orders; "plan ahead" must not change the brain.
test('control: autopilot off waits for orders, and the plan-ahead preview leaves the brain untouched', () => withNewSteps(async () => {
  const brain = new Brain();
  const { bot } = await online(47);
  bot.brain = brain;
  quiet(brain, bot);
  const before = JSON.stringify(brain.state(bot));
  const a = await brain.ahead(bot);
  eq(a.brainNext && a.brainNext.farmerJoe, true, 'it would run Farmer Joe next');
  eq(JSON.stringify(brain.state(bot)), before, 'the dry run changed nothing');
  bot.settings.autopilot = false;
  const b = await brain.ahead(bot);
  eq([b.autopilot, b.brainNext], [false, null], 'manual mode: nothing from the brain');
  bot.start();
  await bot.waitFor(() => bot.current && bot.current.type === 'idle', 5000, 50);
  eq(bot.current.type, 'idle', 'waits for orders');
  bot.queue.push({ type: 'wait', minutes: 0.01, why: 'an order' });
  await bot.waitFor(() => bot.lastLog.some((l) => l.includes('task done wait')), 10000, 50);
  await bot.waitFor(() => bot.current && bot.current.type === 'idle', 5000, 50);
  eq(bot.current.type, 'idle', 'did the order, then waits again');
  bot.stop();
}));

// Found 2026-09-19: "do this now" stopped the bot and started it 3 s later, but a Skua script takes longer to stop,
// so start() was refused and the bot stayed stopped. And "skip" let the brain pick the very same task again.
test('control: restart waits for the loop to end, and a skipped task is left alone for a while', () => withNewSteps(async () => {
  const brain = new Brain();
  const { bot } = await online(47);
  bot.brain = brain;
  quiet(brain, bot);
  bot.settings.autopilot = false;   // only orders: no Farmer Joe through the (engine-less) test translator
  bot.queue.push({ type: 'wait', minutes: 30, why: 'long order' });
  bot.start();
  await bot.waitFor(() => bot.current && bot.current.why === 'long order', 5000, 50);
  bot.queue.unshift({ type: 'wait', minutes: 0.01, why: 'urgent order' });
  await bot.restart();
  assert(bot.running, 'running again after the restart');
  await bot.waitFor(() => bot.lastLog.some((l) => l.includes('task done wait')), 5000, 50);
  bot.stop();
  for (let i = 0; i < 100 && bot.running; i++) await new Promise((r) => setTimeout(r, 50));
  eq(bot.current, null, 'a stopped bot shows no task');
  bot.settings.autopilot = true;
  const preview = await brain.ahead(bot);
  eq(preview.brainNext && preview.brainNext.farmerJoe, true, 'plan ahead works for a stopped bot');
  bot.stopFlag = false;   // brain.next on its own, as the bot loop would call it
  const fj = await brain.next(bot);
  eq(fj.farmerJoe, true);
  bot.skipped = new Map([[bot.taskKey(fj), Date.now() + 3600000]]);
  const other = await brain.next(bot);
  assert(!other.farmerJoe, `skipped Farmer Joe is not picked again: ${JSON.stringify(other)}`);
}));

// 2026-09-19: one inventory. The headless client reads the skua.swf model's items (bought classes, temp items and
// equipment were missing or wrong in the old hand-kept copy).
test('inventory: the headless client shows the skua.swf model\'s items, temp items and equipment', async () => {
  const c = new HeadlessClient({ id: 'invtest', label: 'invtest', username: 'Tester' });
  c.sent = [];
  c.write = (m) => c.sent.push(m);
  c.w.myAvatar.uid = 11;
  c.swf.game.sfc.myUserId = 11;
  const pkt = (o) => c.handle(protocol.parse(JSON.stringify({ t: 'xt', b: { r: -1, o } })));
  pkt({ cmd: 'loadInventoryBig', items: [{ ItemID: 582, sName: 'Dragonslayer', sType: 'Class', sES: 'ar', bEquip: 1, iQty: 302500 }], factions: [] });
  pkt({ cmd: 'addItems', items: { 36298: { ItemID: 36298, sName: 'Blood Sorceress', sType: 'Class', sES: 'ar', bTemp: 0, iQty: 1 } } });
  pkt({ cmd: 'equipItem', uid: 11, strES: 'ar', ItemID: 36298 });
  pkt({ cmd: 'addItems', items: { 35956: { ItemID: 35956, sName: 'Dracolich Slain', bTemp: 1, iQty: 1 } } });
  pkt({ cmd: 'addItems', items: { 35956: { ItemID: 35956, iQty: 1 } } });
  assert(c.w.myAvatar.items === c.swf.w.myAvatar.items, 'the same list, not a copy');
  const bs = c.w.myAvatar.items.find((i) => i.sName === 'Blood Sorceress');
  eq([!!bs, !!(bs && bs.bEquip), !!c.w.myAvatar.items.find((i) => i.sName === 'Dragonslayer').bEquip], [true, true, false], 'a new class, equipped, the old one not');
  eq(c.w.myAvatar.tempitems.map((i) => `${i.sName}=${i.iQty}`), ['Dracolich Slain=2'], 'temp items stack');
});

// 2026-10-07: the server's iQtyNow lags when grants land together (Nova7's Suppressed Undead read 48, 49, 49 while
// the real stack hit 50), and a full quest stack never drops again to correct it - LordOfOrder waited at 49/50 for 2 h.
test('inventory: a stale iQtyNow on a grant still counts the grant, up to the stack cap', async () => {
  const c = new HeadlessClient({ id: 'stktest', label: 'stktest', username: 'Tester' });
  c.sent = [];
  c.write = (m) => c.sent.push(m);
  c.w.myAvatar.uid = 11;
  c.swf.game.sfc.myUserId = 11;
  const pkt = (o) => c.handle(protocol.parse(JSON.stringify({ t: 'xt', b: { r: -1, o } })));
  const qty = (id) => { const it = c.w.myAvatar.items.find((i) => Number(i.ItemID) === id); return it ? it.iQty : null; };
  const add = (id, n) => pkt({ cmd: 'addItems', items: { [id]: { iQty: 1, iQtyNow: n, CharItemID: 900 + id, bBank: 0 } }, msg: '' });
  pkt({ cmd: 'loadInventoryBig', items: [
    { ItemID: 50713, sName: 'Suppressed Undead', iStk: 50, bTemp: false, CharItemID: 50713 + 900, iQty: 47 },
    { ItemID: 7936, sName: 'Gold Voucher', iStk: 999, bTemp: false, CharItemID: 7936 + 900, iQty: 374 },
  ], factions: [] });
  add(50713, 48); add(50713, 49); add(50713, 49);   // the real packets from 12:20:55
  eq(qty(50713), 50, 'the repeated 49 is the 50th');
  add(50713, 50);
  eq(qty(50713), 50, 'never above the stack cap');
  // Plain grants, and a server count lower than the model (the model drifted high), are still taken as sent.
  add(7936, 375); add(7936, 376);
  eq(qty(7936), 376, 'normal grants follow iQtyNow');
  add(7936, 300);
  eq(qty(7936), 300, 'a lower server count wins');
  // getDrop: the item's invTree copy keeps the iQtyNow of an older addItems; the answer's own count is used.
  pkt({ cmd: 'dropItem', items: { 50712: { ItemID: 50712, sName: 'Suppressed Drows', iStk: 50, bTemp: false } } });
  pkt({ cmd: 'getDrop', ItemID: 50712, bSuccess: 1, CharItemID: 50712 + 900, bBank: 0, iQty: 3, iQtyNow: 3 });
  add(50712, 4);
  pkt({ cmd: 'getDrop', ItemID: 50712, bSuccess: 1, CharItemID: 50712 + 900, bBank: 0, iQty: 2, iQtyNow: 6 });
  eq(qty(50712), 6, 'getDrop takes its own iQtyNow');
});

test('rates: nothing is measured until the character\'s numbers have arrived', async () => {
  const { FakeGame } = require('./fakegame');
  const { Bot } = require('../lib/bot');
  const { P } = require('../lib/paths');
  const fs = require('fs');
  const path = require('path');
  const dir = P.account('ratesbot');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'login.txt'), 'Username: ratesbot\nPassword: pw\n');
  const game = new FakeGame({ id: 'ratesbot' });
  const bot = new Bot(game, { id: 'ratesbot', label: 'ratesbot', owner: 'test', loginFile: path.join(dir, 'login.txt') });
  await bot.login();
  const w = game.root.world.myAvatar.objData;
  w.intExp = 0; w.intGold = 0;
  await bot.status();
  eq(bot.stats.expSamples.length, 0, 'an empty character is not sampled');
  w.intExp = 120000; w.intGold = 5000;
  await bot.status();
  eq(bot.stats.expSamples.length, 1, 'now it is');
  bot.stats.expSamples[0].t -= 10 * 60000;          // ten minutes ago
  w.intExp = 140000; w.intGold = 5600;
  const s = await bot.status();
  eq(s.expPerHour, 120000, 'experience an hour is measured from the first real sample');
  eq(s.goldPerHour, 3600, 'and so is gold');
});

// The owner, 2026-09-22: "you cant make them do ultras when they are still under level and will keep dying. farmer joe is
// supposed to make them ready to end game". Farmer Joe runs first; each character's ultra seat (ultraready.SEATS) waits
// for level 100 and a finished (or parked) Farmer Joe, and never pauses a running Farmer Joe.
test('progress: Farmer Joe comes first - the ultra seat waits for level 100 and a finished Farmer Joe', () => withNewSteps(async () => {
  const brain = new Brain();
  const owned = new Set(['Lord of Order']); const done = new Set();
  const setup = (bot, id) => {
    bot.unrankedClasses = async () => [];
    bot.owns = async (n) => owned.has(n);
    bot.completedOnce = async (q) => done.has(Number(q));
    bot.id = id; bot._brainState = null; quiet(brain, bot); brain.state(bot).barberAt = Date.now();
  };
  const { bot: low } = await online(72);
  setup(low, 'valen7');
  let t = await brain.next(low);
  assert(t.farmerJoe && !t.seat, `level 72: Farmer Joe, not the seat: ${t.why}`);
  brain.state(low).fjDoneAt = Date.now();
  t = await brain.next(low);
  assert(!t.seat, `Farmer Joe finished but still level 72: no seat yet: ${t.why}`);
  brain.state(low).fjDoneAt = 0;
  brain.state(low).goalFails['farmer-joe'] = 3; brain.state(low).goalFailAt = { 'farmer-joe': Date.now() };
  t = await brain.next(low);
  assert(!t.seat, `Farmer Joe parked at level 72: still no seat: ${t.why}`);

  const { bot } = await online(100);
  setup(bot, 'valen7');
  owned.add('Lord of Order');                       // the Lord of Order daily clock (schedule loo-daily) is done
  t = await brain.next(bot);
  assert(t.farmerJoe, `level 100 with Farmer Joe unfinished: Farmer Joe first: ${t.why}`);
  brain.state(bot).fjDoneAt = Date.now();
  t = await brain.next(bot);
  eq([t.goal, t.seat, t.path], ['burning-blade-of-abezeth', true, 'Other/Weapons/BurningBladeOfAbezeth.cs'], `first the quickest 30% weapon (Weapon-Route, 2026-09-29): ${t.why}`);
  owned.add('Burning Blade Of Abezeth');
  t = await brain.next(bot);
  eq([t.goal, t.seat, t.path], ['ultra-stories', true, 'Ultrasv3/DoAllUltrasStorys.cs'], `then the story unlocks for every ultra map: ${t.why}`);
  done.add(9125);
  t = await brain.next(bot);
  eq([t.goal, t.seat, t.hours], ['stonecrusher', true, null], t.why);
  owned.add('StoneCrusher');
  t = await brain.next(bot);
  eq([t.goal, t.seat], ['archpaladin', true], `Valen also plays ArchPaladin (Dage): ${t.why}`);
  owned.add('ArchPaladin');
  t = await brain.next(bot);
  eq([t.goal, t.seat], ['void-avenger-scythe', true], `then the 40% weapon: ${t.why}`);
  // A character already holding a 40% weapon skips the 40% farms and goes for the 51% ones.
  bot._bestDmg = { at: Date.now(), value: 0.4 };
  t = await brain.next(bot);
  eq([t.goal, t.seat], ['necrotic-sword-of-doom', true], `a 40% weapon in hand: no second 40% farm: ${t.why}`);
  bot._bestDmg = null;

  // Lord of Order's ten dailies do not wait for Farmer Joe or 13 LoC (live 2026-09-22): a recurring daily clock that
  // pauses a running Farmer Joe once a day, and stops once the class is owned.
  owned.delete('Lord of Order');
  setup(low, 'sable7');
  t = await brain.next(low);
  eq([t.recurring, t.path], ['loo-daily', 'Dailies/LordOfOrder.cs'], `level 72: the Lord of Order daily first: ${t.why}`);
  low.current = { type: 'script', path: 'Other/FarmJoeKits/0FarmerJoeDoAll.cs', goal: 'farmer-joe', farmerJoe: true, brain: true, why: 'Farmer Joe', startedAt: Date.now() - 2 * 3600000 };
  eq((await brain.preempt(low) || {}).recurring, 'loo-daily', 'the daily pauses Farmer Joe');
  require('../lib/schedule').markDone(brain.state(low), 'loo-daily', 'day');
  eq(await brain.preempt(low), null, 'done for today: Farmer Joe carries on');
  owned.add('Lord of Order');
  brain.state(low).recurring = {};
  eq(await brain.preempt(low), null, 'the class is owned: no more Lord of Order dailies, and a seat goal never pauses Farmer Joe');
}));

// Check-up 2026-09-21: the persona's goal list lifts goals outside its own path to level 80/90. Seat goals keep the
// game's own level, so once Farmer Joe is done, Oren7's StoneCrusher seat runs like its own path's goals.
test("progress: after Farmer Joe, a seat goal outside the persona's own path runs too", () => withNewSteps(async () => {
  const brain = new Brain();
  const { bot } = await online(100);
  bot.id = 'oren7'; bot.account.persona = 'oren7'; bot._brainState = null;
  quiet(brain, bot);
  brain.state(bot).barberAt = Date.now();
  brain.state(bot).fjDoneAt = Date.now();
  const owned = new Set(['Lord of Order', 'Burning Blade Of Abezeth']);
  bot.unrankedClasses = async () => [];
  bot.owns = async (n) => owned.has(n);
  bot.completedOnce = async (q) => Number(q) === 9125;   // ultra stories done
  let t = await brain.next(bot);
  eq([t.goal, t.seat], ['kings-echo', true], t.why);
  owned.add("King's Echo");
  t = await brain.next(bot);
  eq([t.goal, t.seat], ['archpaladin', true], `then ArchPaladin (Speaker, Gramiel, Drakath): ${t.why}`);
}));

// 2026-09-22: Farm.Experience grinds levels 61-75 in /icestormunder. Only /icestormarena counted as progress, so the
// watchdog parked Valen7's Valiance and Nova7's Verus DoomKnight and Ravenous while they killed ~20 a minute.
test('progress: kills on every map Skua farms XP on are script progress', async () => {
  for (const m of ['icestormarena', 'icestormunder', 'IcestormUnder', 'battlegrounde']) assert(Bot.xpMap(m), m);
  for (const m of ['frozentower', 'chaoskraken', '', null]) assert(!Bot.xpMap(m), String(m));
});

// The owner, 2026-09-22: "if you see someone is stuck with a boss make the aqwbot ping me or dm me on discord with the room
// number". The client names the monster that landed the last hit; two deaths to the same boss in 20 min send a DM.
test('boss alert: two deaths to the same boss DM the owner where to join; ordinary monsters and one death do not', async () => {
  const { Hub } = require('../lib/hub');
  const c = new HeadlessClient({ id: 'bosstest', label: 'bosstest', username: 'Tester' });
  c.sent = [];
  c.write = (m) => c.sent.push(m);
  c.w.myAvatar.uid = 11;
  c.swf.game.sfc.myUserId = 11;
  c.w.myAvatar.objData.strUsername = 'Tester';
  const pkt = (o) => c.handle(protocol.parse(JSON.stringify({ t: 'xt', b: { r: -1, o } })));
  pkt({ cmd: 'moveToArea', areaId: 13579, areaName: 'chaoskraken-13579', strMapName: 'chaoskraken',
    monmap: [{ MonMapID: 1, MonID: 900, strFrame: 'r5' }, { MonMapID: 2, MonID: 901, strFrame: 'r5' }],
    mondef: [{ MonID: 900, strMonName: 'Chaos Kraken', intLevel: 60 }, { MonID: 901, strMonName: 'Kraken Tentacle', intLevel: 60 }],
    monBranch: [{ MonMapID: 1, intHP: 60000, intHPMax: 90000, intState: 1 }, { MonMapID: 2, intHP: 4000, intHPMax: 4000, intState: 1 }],
    uoBranch: [] });
  Object.assign(c.w.myAvatar.dataLeaf, { intHP: 2500, intHPMax: 2500, intState: 1 });
  c.sawHp = true;
  let died = 0;
  c.on('died', () => { died++; });
  pkt({ cmd: 'ct', m: { 1: { intHP: 57600 } }, p: { Tester: { intHP: 0, intState: 0 } }, sara: [{ iRes: 1, actionResult: { type: 'hit', hp: 2600, cInf: 'm:1', tInf: 'p:11' } }] });
  c.stopRespawn();
  eq(died, 1, 'the death is seen');
  const k = c.killer();
  eq([k && k.name, k && k.cell, k && k.hpMax, k && k.hp], ['Chaos Kraken', 'r5', 90000, 57600], 'the killer is named');

  const sends = [];
  const hub = { settings: {}, info() {}, discord: { send: (text, o) => { sends.push({ text, ...o }); return true; } } };
  const bot = { id: 'valen7', account: { label: 'Valen7' }, client: c, serverName: 'Twilly', current: { type: 'script', path: 'Story/Kraken.cs', why: 'Kraken story' }, level: async () => 75, map: async () => 'chaoskraken', roomNumber: () => 13579 };
  const t0 = Date.now();
  eq(await Hub.prototype.bossDeath.call(hub, bot, k, t0), null, 'one death is not stuck');
  eq(await Hub.prototype.bossDeath.call(hub, bot, { ...k, name: 'Kraken Tentacle', hpMax: 4000 }, t0 + 1000), null, 'an ordinary monster is not a boss');
  const r = await Hub.prototype.bossDeath.call(hub, bot, k, t0 + 5 * 60000);
  assert(r && r.sent, 'second death to the boss: alert sent');
  eq(sends.length, 1, 'one message');
  eq([sends[0].dm, sends[0].kind, sends[0].quiet], [true, 'boss', 2 * 3600000], 'a DM, at most once per 2 h per character and boss');
  assert(/Valen7 is stuck on a boss: Chaos Kraken/.test(r.text), r.text);
  assert(/Room \*\*13579\*\*: `\/join chaoskraken-13579` on \*\*Twilly\*\*/.test(r.text), r.text);
  assert(/Died 2x in 20 min · boss at 64% HP · cell r5/.test(r.text), r.text);
  eq(await Hub.prototype.bossDeath.call(hub, { ...bot, _bossDeaths: [{ name: 'Chaos Kraken', at: t0 - 25 * 60000 }] }, k, t0), null, 'deaths older than 20 min do not count');

  // The owner, 2026-09-27: DM only when the boss could not be killed at all and one more player would help.
  const again = (extra) => Hub.prototype.bossDeath.call(hub, { ...bot, _bossDeaths: [{ name: 'Chaos Kraken', at: t0 }], ...extra }, k, t0 + 60000);
  eq(await again({ _killedBosses: { 'Chaos Kraken': 'x' } }), null, 'killed it before (even with others): no DM');
  eq(await again({ _soloBosses: { 'Chaos Kraken': 'x' } }), null, 'killed it solo before: no DM');
  eq(await again({ current: { type: 'daily', why: 'daily NSoDDaily is up' } }), null, 'dailies are public-room work: no DM');
  eq(await again({ current: { type: 'script', path: 'Other/VoidAuras.cs' } }), null, 'void auras: no DM');
  assert(await again({ _killedBosses: {} }), 'never killed it, quiet content: DM');
  eq(await Hub.prototype.bossDeath.call(hub, { ...bot, _bossDeaths: [{ name: 'Desolich', at: t0 }] }, { ...k, name: 'Desolich', hpMax: 8200000, hp: 8000000 }, t0 + 60000), null, 'a boss 400x its HP needs a crowd: no DM');
});

test('boss alert: every death the bot counts asks the hub whether it was a boss', async () => {
  const { bot } = await online(75);
  const seen = [];
  bot.hub = { bossDeath: async (b, k) => { seen.push([b.id, k.name]); } };
  bot.client.killer = () => ({ name: 'Chaos Kraken', hp: 1, hpMax: 90000 });
  await bot.countDeath();
  eq(seen, [[bot.id, 'Chaos Kraken']]);
});

test('discord: a DM goes to the bot owner even with a channel webhook, and falls back to the channel with a ping', async () => {
  const { Discord } = require('../lib/discord');
  const d = new Discord();
  d.cfg = { webhook: 'https://discord.com/api/webhooks/1/x', token: 't' };
  const posted = []; const dms = [];
  d.postWebhook = async (content, mention) => { posted.push([content, mention]); };
  d.directMessage = async (content) => { dms.push(content); };
  d.ownerId = async () => '100000000000000001';
  await d.deliver({ content: 'boss', dm: true });
  await d.deliver({ content: 'daily report' });
  eq([dms, posted], [['boss'], [['daily report', undefined]]], 'DM for the alert, the channel for the rest');
  d.directMessage = async () => { throw new Error('discord 403: Cannot send messages to this user'); };
  await d.deliver({ content: 'boss', dm: true });
  eq(posted[1], ['<@100000000000000001> boss', '100000000000000001'], 'DM refused: the channel, with a ping');
  const plain = new Discord();
  plain.cfg = { token: 't' };
  assert(!plain.enabled && plain.send('x', { dm: true, quiet: 0, key: 'friend:x' }) === true, 'a bot token alone is enough for a DM');
  plain.queue.length = 0;
});

// 2026-09-22: translate() left two mapless hunt steps in some dailies, which made them "not runnable". The Dage's
// Scroll Fragment (Hero's Valiance) and Elders' Blood (Roentgenium for Ravenous) clocks are switched on; the rest of the
// dailies with the same problem stay off until needed.
test('dailies: Dage\'s Scroll Fragment and Elders\' Blood are runnable with clean steps; the other broken ones stay off', async () => {
  const fs = require('fs');
  fs.mkdirSync(P.KNOWLEDGE, { recursive: true });
  const file = path.join(P.KNOWLEDGE, 'dailies.json');
  fs.writeFileSync(file, JSON.stringify([{ name: 'Old', runnable: true, quests: [1], steps: [] }]));   // a cache from before
  // A fresh copy of the module (its in-memory list empty), put back afterwards for the other tests.
  const kpath = require.resolve('../lib/knowledge');
  const orig = require.cache[kpath];
  delete require.cache[kpath];
  try {
    const k = require('../lib/knowledge');
    const all = k.dailies();
    assert(!all.find((d) => d.name === 'Old'), 'an old cache without the generator stamp is rebuilt');
    for (const [name, map, item] of [['DagesScrollFragment', 'mountdoomskull', 'Chaos Power Increased'], ['EldersBlood', 'arcangrove', 'Slain Gorillaphant']]) {
      const d = all.find((x) => x.name === name);
      assert(d && d.runnable, `${name} runnable`);
      assert(d.steps.every((s) => s.kind !== 'hunt' || s.map), `${name}: every hunt has a map`);
      assert(d.steps.some((s) => s.kind === 'hunt' && s.map === map && s.item === item), `${name}: ${JSON.stringify(d.steps)}`);
    }
    eq(all.find((x) => x.name === 'DagesScrollFragment').enough, ["Dage's Scroll Fragment", 13]);
    eq(all.find((x) => x.name === 'EldersBlood').enough, ["Elders' Blood", 20]);
    for (const name of ['ShadowShroud', 'CryptoToken', 'Cryomancer']) assert(!all.find((x) => x.name === name).runnable, `${name} stays off`);
    assert(JSON.parse(fs.readFileSync(file, 'utf8'))[0].gen >= 2, 'the rebuilt list is saved');
  } finally { require.cache[kpath] = orig; }
});

// The owner, 2026-09-28 (audit): level 100 is the critical path. Double-XP days level all day after the dailies (was 6 h,
// after Farmer Joe); below 100 a blocked Farmer Joe means grinding, not old persona goals; events 1 h a day until 100.
// The owner 2026-10-09 replaced the double-XP part: "the bots level while doing quests and farming for items".
test('critical path: a double-XP day does not grind - the work goes on (Farmer Joe here) and earns the boost', () => withNewSteps(async () => {
  const brain = new Brain();
  const { bot } = await online(86);
  quiet(brain, bot);
  brain.state(bot).barberAt = Date.now();
  require('../lib/schedule').markDone(brain.state(bot), 'loo-daily', 'day');
  bot.unrankedClasses = async () => [];
  brain.hub = { boosts: { activeKinds: () => ['exp'], active: () => [{ kinds: ['exp'], title: 'Double EXP Boost 9.30.26' }] } };
  brain.today(bot).boostLevelMs = 7 * 3600000;
  let t = await brain.next(bot);
  assert(t.farmerJoe && !t.boost, `2x XP: Farmer Joe, not grinding (${t.type} ${t.why})`);
  // A running Farmer Joe keeps going when the boost starts.
  bot.current = { type: 'script', path: 'Other/FarmJoeKits/0FarmerJoeDoAll.cs', goal: 'farmer-joe', farmerJoe: true, brain: true, startedAt: Date.now() - 3600000 };
  t = await brain.preempt(bot);
  assert(!(t && t.boost), 'Farmer Joe is not paused for the double-XP day');
  brain.hub = null;
  bot.current = null;
  t = await brain.next(bot);
  assert(t.farmerJoe, `no boost: Farmer Joe (${t.why})`);
}));

test('critical path (the owner 2026-10-05): below 100 a blocked Farmer Joe means 13 LoC, then goals - grinding only when nothing can run', () => withNewSteps(async () => {
  const brain = new Brain();
  const { bot } = await online(86);
  quiet(brain, bot);
  brain.state(bot).barberAt = Date.now();
  require('../lib/schedule').markDone(brain.state(bot), 'loo-daily', 'day');
  bot.unrankedClasses = async () => [];
  bot.completedOnce = async () => false;
  brain.state(bot).goalFails['farmer-joe'] = 3; brain.state(bot).goalFailAt = { 'farmer-joe': Date.now() };
  let t = await brain.next(bot);
  eq(t.goal, 'story-13loc', `13 LoC first: XP-rich and the gate to Lord of Order (${t.why})`);
  bot.completedOnce = async (q) => Number(q) === 3881;
  t = await brain.next(bot);
  eq(t.type, 'script', `then a goal - it gives XP too (${t.why})`);
  assert(t.goal && t.goal !== 'farmer-joe', t.why);
  // A goal already running is not stopped for grinding.
  bot.current = { type: 'script', path: 'Nation/VHL/0VoidHighlord.cs', goal: 'void-highlord', brain: true, startedAt: Date.now() - 3600000 };
  t = await brain.preempt(bot);
  assert(!(t && t.critical), 'Void Highlord keeps going');
  // Every goal parked: grinding while nothing else can run.
  const st = brain.state(bot);
  for (const x of brain.goals(bot).goals) { st.goalFails[x.id] = 3; st.goalFailAt[x.id] = Date.now(); }
  bot.current = null;
  t = await brain.next(bot);
  eq([t.type, t.critical], ['farmLevel', 'xp'], `nothing can run: grind (${t.why})`);
  assert(/no class or goal can run/.test(t.why), t.why);
  eq(brain.eventCapH(bot, 86), 1, 'events: 1 h a day until 100');
  eq(brain.eventCapH(bot, 100), 2, 'and 2 h after');
}));

test('critical path: the Lord of Order goal never doubles the loo-daily clock', () => withNewSteps(async () => {
  const brain = new Brain();
  const { bot } = await online(100);
  quiet(brain, bot);
  brain.state(bot).barberAt = Date.now();
  brain.state(bot).fjDoneAt = Date.now();
  bot.unrankedClasses = async () => [];
  bot.owns = async () => false;
  bot.completedOnce = async () => true;
  bot.settings.noUltraPrep = true;
  fs.writeFileSync(path.join(P.account(bot.id), 'goals.json'), JSON.stringify({ version: 2, custom: true, paused: [], goals: [
    { id: 'lord-of-order', label: 'Lord of Order', script: 'Dailies/LordOfOrder.cs', when: 60, have: 'Lord of Order', repeat: 'daily' },
    { id: 'shaman', label: 'Shaman', script: 'Other/Classes/REP-based/Shaman.cs', when: 30, have: 'Shaman' },
  ] }));
  require('../lib/schedule').markDone(brain.state(bot), 'loo-daily', 'day');
  const t = await brain.next(bot);
  eq(t.goal, 'shaman', `the Lord of Order goal is the loo-daily clock, not run again the same day: ${t.why}`);
}));

test('goals: requiresHave waits for the class (Nova went to Taro without ArchPaladin, 2026-10-08)', () => withNewSteps(async () => {
  const brain = new Brain();
  const { bot } = await online(90);
  quiet(brain, bot);
  brain.state(bot).barberAt = Date.now();
  brain.state(bot).fjDoneAt = Date.now();
  bot.unrankedClasses = async () => [];
  bot.settings.noUltraPrep = true;
  require('../lib/schedule').markDone(brain.state(bot), 'loo-daily', 'day');
  let owned = new Set();
  bot.owns = async (n) => owned.has(n);
  bot.completedOnce = async () => true;
  fs.writeFileSync(path.join(P.account(bot.id), 'goals.json'), JSON.stringify({ version: 2, custom: true, paused: [], goals: [
    { id: 'void-avenger-scythe', label: 'VAS', script: 'Other/Weapons/VoidAvengerScythe.cs', when: 80, have: 'Void Avenger Scythe', requiresHave: 'ArchPaladin' },
    { id: 'shaman', label: 'Shaman', script: 'Other/Classes/REP-based/Shaman.cs', when: 30, have: 'Shaman' },
  ] }));
  let t = await brain.next(bot);
  eq(t.goal, 'shaman', `no ArchPaladin: the Taro goal waits (${t.why})`);
  owned.add('ArchPaladin');
  t = await brain.next(bot);
  eq(t.goal, 'void-avenger-scythe', 'with ArchPaladin it runs');
}));

test('critical path: while Artix is full the brain passes over crowded work (old routing); with the ladder a full Artix stops no daily', () => withNewSteps(async () => {
  const crowd = require('../lib/crowd');
  crowd.setLadder(false);
  try {
  const brain = new Brain();
  const { bot } = await online(86);
  quiet(brain, bot);
  brain.state(bot).barberAt = Date.now();
  require('../lib/schedule').markDone(brain.state(bot), 'loo-daily', 'day');
  bot.unrankedClasses = async () => [];
  knowledge.dailies = () => [{ name: 'NCSGem', quests: [9642], runnable: true, minLevel: 0, steps: [] }];
  bot.questAvailable = async () => true;
  let t = await brain.next(bot);
  eq(t.name, 'NCSGem');
  bot.crowdFullUntil = Date.now() + 600000;
  t = await brain.next(bot);
  assert(t.farmerJoe, `Artix full: quiet work instead (${t.why})`);
  bot.crowdOpen();
  t = await brain.next(bot);
  eq(t.name, 'NCSGem', 'a seat: the daily again');
  crowd.setLadder(true);
  bot.crowdFullUntil = Date.now() + 600000;
  t = await brain.next(bot);
  eq(t.name, 'NCSGem', 'the ladder: the daily runs in the party room, whatever Artix says');
  } finally { crowd.setLadder(true); }
}));

test('dailies: a daily stops at the script\'s own count, backpack and bank together', () => withNewSteps(async () => {
  const brain = new Brain();
  const { bot } = await online(72);
  quiet(brain, bot);
  brain.state(bot).barberAt = Date.now();
  require('../lib/schedule').markDone(brain.state(bot), 'loo-daily', 'day');   // not about the Lord of Order clock
  const dage = { name: 'DagesScrollFragment', quests: [3596], runnable: true, minLevel: 0, enough: ["Dage's Scroll Fragment", 13], steps: [] };
  knowledge.dailies = () => [dage];
  bot.questAvailable = async () => true;
  bot.unrankedClasses = async () => [];
  let bank = [{ sName: "Dage's Scroll Fragment", iQty: 12 }];
  bot.bankItems = async () => bank;
  let t = await brain.next(bot);
  eq([t.type, t.name], ['daily', 'DagesScrollFragment'], `12 of 13: still needed (${t.why})`);
  bank = [{ sName: "Dage's Scroll Fragment", iQty: 13 }];
  t = await brain.next(bot);
  assert(t.type !== 'daily', `13 banked: done (${t.type} ${t.why})`);
}));

// 2026-10-01: a frozen character and three days without dailies showed in no health rule.
test('health: nothing gained for 30 min and no daily 12 h after the reset are reported', async () => {
  const { Health } = require('../lib/health');
  const sent = [];
  const mark = { xp: 100, kills: 5, quests: 0, drops: 0, items: 0 };
  const day = { dailies: { PowerGem: 'unavailable' } };
  const bot = { id: 'q', running: true, account: { label: 'q', autostart: true }, settings: {}, stats: { deaths: 0 }, lastLog: [], current: { type: 'script', why: 'Farmer Joe' },
    progressMark: () => ({ ...mark }), playing: async () => false };
  const hub = { settings: {}, bots: new Map([['q', bot]]), bot: () => bot, notify: (t, body) => sent.push(body), brain: { today: () => day } };
  const h = new Health(hub);
  const t0 = Date.parse('2026-10-01T05:00:00Z');   // one hour after the reset
  const quiet = (f) => f.filter((x) => /no XP/.test(x.text));
  eq(quiet(await h.check(t0)).length, 0);
  eq(quiet(await h.check(t0 + 15 * 60000)).length, 0, '15 min is not 30');
  const f = await h.check(t0 + 30 * 60000);
  assert(/no XP, kills, quests or drops for 30 min \(Farmer Joe\)/.test(quiet(f)[0].text), JSON.stringify(f));
  mark.kills = 6;
  eq(quiet(await h.check(t0 + 45 * 60000)).length, 0, 'a kill: not quiet any more');
  eq(f.filter((x) => /no daily/.test(x.text)).length, 0, 'early in the day nobody expects the dailies yet');
  const late = Date.parse('2026-10-01T17:00:00Z');   // 13 h after the reset
  assert((await h.check(late)).some((x) => /no daily has run today, 12 h after the reset/.test(x.text)), 'unavailable ones do not count as run');
  day.dailies.MineCrafting = 'done';
  eq((await h.check(late + 60000)).filter((x) => /no daily/.test(x.text)).length, 0);
});

// 2026-10-01: Farmer Joe bought ArchPaladin and ranked it on Ice Storm Arena from rank 1; 8 deaths in 3 min parked the
// whole route for 24 h although the class was at rank 4 and safe by then.
test('death cap: a class below rank 10 on the XP maps gets three times the room; /where lists rooms to join', async () => {
  const { Hub } = require('../lib/hub');
  const parked = [];
  const mk = (cp, map) => ({ id: 'dc', account: { label: 'Valen7' }, serverName: 'Swordhaven', running: true, journal() {}, restart: async () => {}, taskKey: () => 'fj',
    current: { type: 'script', farmerJoe: true, brain: true, why: 'Farmer Joe' },
    client: { state: { loaded: true }, w: { strMapName: map, strAreaName: `${map}-13579`, strFrame: 'r3', myAvatar: { items: [{ sES: 'ar', sName: 'ArchPaladin', bEquip: 1, iQty: cp }] } } } });
  const hub = Object.assign(Object.create(Hub.prototype), { brain: { park: (b, t, step) => { parked.push(step); return 'for 24 h'; } }, notify() {}, info() {} });
  const die = (bot, n) => { let r = false; for (let i = 0; i < n; i++) r = hub.deathCap(bot, { name: 'Frost Spirit' }); return r; };
  eq(die(mk(900, 'icestormarena'), 8), false, 'rank 1 on the arena: 8 deaths are not a wall yet');
  eq(die(mk(900, 'icestormarena'), 24), true, '24 are');
  eq(die(mk(302500, 'icestormarena'), 8), true, 'rank 10: the usual cap');
  eq(die(mk(900, 'dreadfight'), 8), true, 'a boss map: the usual cap');
  eq(parked.length, 3);
  const bot = mk(302500, 'icestormarena');
  hub.bots = new Map([['dc', bot]]);
  const rows = hub.where();
  eq([rows[0].server, rows[0].map, rows[0].room, rows[0].cell, rows[0].isPublic], ['Swordhaven', 'icestormarena', '13579', 'r3', false]);
  const text = require('../lib/discordbot').whereText(rows);
  assert(/\*\*Valen7\*\* — Swordhaven · map \*\*icestormarena\*\* · room \*\*13579\*\* \(private\) · cell r3\n`\/join icestormarena-13579`/.test(text), text);
});

// 2026-10-25: Edda's Blaze Binder (rank 1) died 24x on Ice Storm Arena while it gained points and parked three forge goals
// for 24 h; forty minutes later it was rank 9. A fresh class that gains points while it dies is ranking up, not walled.
test('death cap: a fresh class that gains points while it dies is not walled; one that gains nothing still is', async () => {
  const { Hub } = require('../lib/hub');
  const parked = [];
  const items = [{ sES: 'ar', sName: 'Blaze Binder', bEquip: 1, iQty: 100 }];
  const bot = { id: 'el', account: { label: 'Edda' }, serverName: 'Swordhaven', running: true, journal() {}, restart: async () => {}, taskKey: () => 'forge',
    current: { type: 'script', brain: true, why: 'Forge' },
    client: { state: { loaded: true }, w: { strMapName: 'icestormunder', strAreaName: 'icestormunder-13579', strFrame: 'r3', myAvatar: { items } } } };
  const hub = Object.assign(Object.create(Hub.prototype), { brain: { park: (b, t, step) => { parked.push(step); return 'for 24 h'; } }, notify() {}, info() {} });
  const die = (n, gain) => { let r = false; for (let i = 0; i < n; i++) { items[0].iQty += gain; r = hub.deathCap(bot, { name: 'Frost Spirit' }); } return r; };
  eq(die(40, 5), false, '40 deaths while the class gains points: ranking up');
  eq(parked.length, 0);
  bot._capDeaths = [];                                  // a new window: the points stop coming
  eq(die(24, 0), true, 'no points gained over the window: a wall');
  eq(parked.length, 1);
});
