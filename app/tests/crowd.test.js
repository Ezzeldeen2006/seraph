// Crowded or quiet (lib/crowd.js) and the struggle rule (hub.struggle), the owner 2026-09-25.
const crowd = require('../lib/crowd');
const { HeadlessClient } = require('../lib/net/headless');
const { Hub } = require('../lib/hub');
const { SquadBook } = require('../lib/squad');
// The routing before the boss ladder (crowd.json "ladder": false): crowded content starts on Artix in a public room.
const oldRules = (fn) => async () => { const was = crowd.LADDER; crowd.setLadder(false); try { return await fn(); } finally { crowd.setLadder(was); } };

test('crowd: dailies, void auras and boss farms are crowded; ultras are private; the rest is quiet (old routing)', oldRules(async () => {
  eq(crowd.kindOf({ type: 'kill', map: 'ultraalteon', monster: 'Alteon' }), 'quiet', 'ultras never go public');
  eq(crowd.isPrivate({ type: 'kill', map: 'ultraalteon-4' }), true);
  eq(crowd.isPrivate({ type: 'script', path: 'Ultrasv3/IndividualUltras/10UltraSpeakerv3.cs' }), true);
  eq(crowd.kindOf({ type: 'script', path: 'Ultras/UltraDage.cs' }), 'quiet', 'ultra script');
  eq(crowd.kindOf({ type: 'daily', name: 'NSoDDaily' }), 'crowd', 'a daily goes where the players are');
  eq(crowd.kindOf({ type: 'script', path: 'Dailies/LordOfOrder.cs' }), 'crowd', 'daily script');
  eq(crowd.kindOf({ type: 'script', path: 'Other/Classes/Daily-Classes/BlazeBinder.cs' }), 'crowd', 'daily class');
  eq(crowd.kindOf({ type: 'kill', map: 'thevoid', monster: 'Nightbane' }), 'crowd', 'thevoid');
  eq(crowd.publicArea('thevoid-3'), true); eq(crowd.publicArea('thevoid-13579'), false); eq(crowd.publicArea('thevoid'), true);
  eq(crowd.kindOf({ type: 'kill', map: 'shadowrealmpast-3' }), 'crowd', 'void aura map with a room');
  eq(crowd.kindOf({ type: 'script', path: 'Evil/NSoD/VoidAuras/RetreiveVoidAuras.cs' }), 'crowd', 'void aura script');
  eq(crowd.kindOf({ type: 'script', path: 'Farm/FarmerJoe/0FarmerJoeDoAll.cs' }), 'quiet', 'Farmer Joe');
  eq(crowd.kindOf({ type: 'farmLevel', to: 100 }), 'quiet', 'leveling');
  eq(crowd.kindOf({ type: 'script', raid: 'ultra-speaker', path: 'Ultrasv3/IndividualUltras/10UltraSpeakerv3.cs' }), 'quiet', 'a raid keeps its room');
  eq(crowd.kindOf({ type: 'armyFarm', map: 'ultradage', room: 13579 }), 'quiet', 'a shared room stays private');
  eq(crowd.kindOf({ type: 'assist', server: 'Swordhaven', map: 'ultraalteon' }), 'quiet', 'the help call names its server');
  eq(crowd.kindOf({ type: 'idle' }), null, 'idle has no say');
  eq(crowd.kindOf({ type: 'bankAc', brain: true }), null, 'a bank trip never gives up a seat on a full Artix');
  eq(crowd.kindOf({ type: 'sellJunk' }), null, 'nor does selling junk');
  eq(crowd.serverFor('crowd'), 'Artix');
  eq(crowd.serverFor('quiet'), 'Swordhaven');
}));

test('crowd: Artix is allowed; a full Artix is retried for an hour, then the busiest server with room', async () => {
  const s = (sName, iCount, iMax = 1500) => ({ sName, iCount, iMax, bOnline: 1, bUpg: 0, iLevel: 0, accessLevel: 0 });
  const fake = (want) => ({ opts: { preferServer: () => want }, account: {}, login: { level: 90 } });
  const list = [s('Artix', 900), s('Swordhaven', 200), s('Yorumi', 600), s('Twilly', 50)];
  let c = fake('Artix');
  eq(HeadlessClient.prototype.pickServer.call(c, list).sName, 'Artix', 'Artix when it has room');
  eq(c.wantedServer, 'artix', 'remembers the ask');
  c = fake('Artix');
  const full = [s('Artix', 1500), ...list.slice(1)];
  let err = null;
  try { HeadlessClient.prototype.pickServer.call(c, full); } catch (e) { err = e; }
  eq(err && err.code, 'SERVER_FULL', 'full: no other server, the login fails so hub.reconnect knocks again');
  c._fullSince = Date.now() - 61 * 60000;
  eq(HeadlessClient.prototype.pickServer.call(c, full).sName, 'Yorumi', 'full for an hour: busiest with room');
  eq(c.wantedServer, 'artix', 'still counts as the Artix ask (no relog loop)');
  eq(c._fullSince, null, 'the next crowded task knocks for a full hour again');
  eq(HeadlessClient.prototype.pickServer.call(fake('Swordhaven'), list).sName, 'Swordhaven');
  // 2026-10-01: the list says "Swordhaven (EU)"; the exact match failed and all four landed on the emptiest server.
  const eu = [s('Artix', 900), s('Swordhaven (EU)', 200), s('Sepulchure', 100), s('Twilly', 500)];
  eq(HeadlessClient.prototype.pickServer.call(fake('Swordhaven'), eu).sName, 'Swordhaven (EU)');
});

test('crowd: a dying bot sees which players stand in its cell and which bosses it killed', async () => {
  const events = [];
  const c = {
    w: { strFrame: 'r2', strMapName: 'ultraalteon', myAvatar: { objData: { strUsername: 'Nova7' } }, users: { nova7: { strFrame: 'r2' }, bob: { strFrame: 'r2' }, amy: { strFrame: 'Enter' } } },
    myHits: new Map([[7, Date.now()]]),
    emit: (k, v) => events.push([k, v]),
  };
  c.isAlive = HeadlessClient.prototype.isAlive;
  c.playersHere = HeadlessClient.prototype.playersHere;
  eq(c.playersHere(), ['bob'], 'only other players in my cell');
  const boss = { MonMapID: 7, strMonName: 'Alteon', strFrame: 'r2', intHPMax: 900000, intHP: 0, intState: 0 };
  HeadlessClient.prototype.monsterUpdated.call(c, boss, true);
  eq(events.length, 1);
  eq(events[0][1].byMe, true); eq(events[0][1].others, 1); eq(events[0][1].map, 'ultraalteon');
  HeadlessClient.prototype.monsterUpdated.call(c, boss, false);
  eq(events.length, 1, 'a monster that was already dead is not a new kill');
});

function fakeHub() {
  const hub = { settings: { levelParty: { room: 13579 }, notify: {} }, bots: new Map(), infos: [], info(m) { this.infos.push(m); }, notify() {}, raid: null, assistFor: () => null, partyWalls: {} };
  for (const k of ['isBoss', 'soloBosses', 'bossKilled', 'bossDeath', 'endHelp', 'struggle', 'takeRoute', 'requestHelp', 'assistTaskFor', 'helpTask', 'helpDone', 'loadWalls', 'isPartyWall', 'deathCap', 'canGoPublic', 'goPublic', 'helpCoolingFor', 'forgetSolo', 'helpFarmKill', 'recordHelp', 'helpMinLevel', 'levelOf', ...Hub.HELP_METHODS]) hub[k] = Hub.prototype[k].bind(hub);
  // Each test hub has its own squad book (lib/squad.js), so what one test teaches it never leaks into another.
  hub._squadBook = new SquadBook(require('path').join(process.env.SERAPH_ROOT, `squads-${Math.random().toString(36).slice(2)}.json`));
  return hub;
}
function fakeBot(id, hub, here = []) {
  const b = {
    id, account: { label: id, status: 'active' }, running: true, paused: false, current: { type: 'script', path: 'x.cs' }, journals: [], ran: [],
    client: { w: { strAreaName: 'ultraalteon-13579', myAvatar: { dataLeaf: { intHPMax: 3000 } } }, playersHere: () => here },
    name: async () => id, map: async () => 'ultraalteon', cell: async () => 'r2',
    journal(m) { this.journals.push(m); }, runNow(t) { this.ran.push(t); return Promise.resolve(true); },
    restarts: 0, restart() { this.restarts++; }, taskKey(t) { return t ? [t.type, t.path || '', t.name || ''].join('|') : ''; },
  };
  hub.bots.set(id, b);
  return b;
}

test('struggle: nobody helping -> the whole party meets on Swordhaven, kills it, and the call ends', async () => {
  const hub = fakeHub();
  const nyx = fakeBot('nova7', hub);
  const vae = fakeBot('valen7', hub);
  const ser = fakeBot('sable7', hub);
  ser.running = false;                                     // stopped characters are left alone
  const killer = { name: 'Alteon', cell: 'r2', hpMax: 900000 };
  const h = await hub.struggle(nyx, killer, 2);
  assert(h, 'a call went out');
  eq([h.server, h.map, h.room, h.monster], ['Swordhaven', 'ultraalteon', 13579, 'Alteon']);
  eq(nyx.ran.length, 1, 'the one in trouble goes too'); eq(nyx.ran[0].server, 'Swordhaven');
  eq(vae.ran.length, 1, 'the others drop what they do'); eq(ser.ran.length, 0);
  eq(await hub.struggle(nyx, killer, 3), null, 'one call at a time');
  hub.bossKilled(vae, { name: 'Alteon', hpMax: 900000, byMe: true, others: 1, map: 'ultraalteon' });
  eq(hub.help, null, 'boss dead: everyone goes back');
  eq(Object.keys(hub.soloBosses(vae)), [], 'a party kill is not a solo kill');
});

test('struggle: players in the cell, or a boss killed solo before, mean no call', async () => {
  const hub = fakeHub();
  const nyx = fakeBot('nova7', hub, ['stranger1']);
  fakeBot('valen7', hub);
  const killer = { name: 'Alteon', cell: 'r2', hpMax: 900000 };
  eq(await hub.struggle(nyx, killer, 2), null, 'a real player is helping');
  const alone = fakeBot('oren7', hub, ['valen7']);    // our own bots are not "help from players"
  hub.bossKilled(alone, { name: 'Alteon', hpMax: 900000, byMe: true, others: 0, map: 'ultraalteon' });
  eq(await hub.struggle(alone, killer, 2), null, 'killed it solo once: not struggling');
  assert(alone.journals.some((j) => /killed it solo before/.test(j)));
  hub.bossKilled(alone, { name: 'Small Fry', hpMax: 2000, byMe: true, others: 0, map: 'x' });
  eq(Object.keys(hub.soloBosses(alone)), ['Alteon'], 'small monsters are not bosses');
  // 2026-10-12: a hunt that gives up on it forgets the old solo kill, so the next struggle calls the party.
  eq(hub.forgetSolo(alone, 'alteon'), true);
  eq(Object.keys(hub.soloBosses(alone)), []);
  assert(alone.journals.some((j) => /gave up on Alteon - my old solo kill/.test(j)));
  eq(hub.forgetSolo(alone, 'Alteon'), false, 'nothing to forget twice');
});

test('struggle: an old solo kill stops vetoing the call from the third death (2026-10-25)', async () => {
  const hub = fakeHub();
  const ser = fakeBot('sable7', hub, ['valen7']);
  fakeBot('valen7', hub);
  const dragon = { name: 'Mutated Void Dragon', cell: 'r2', hpMax: 900000 };
  hub.bossKilled(ser, { name: dragon.name, hpMax: dragon.hpMax, byMe: true, others: 0, map: 'bosschallenge' });
  eq(await hub.struggle(ser, dragon, 2), null, 'two deaths: still a bad pull');
  assert(await hub.struggle(ser, dragon, 3), 'three deaths: the party is called');
  eq(Object.keys(hub.soloBosses(ser)), [], 'the old solo kill is forgotten');
  assert(ser.journals.some((j) => /my old solo kill of it no longer counts/.test(j)));
});

test('struggle: the cooldown after a call holds that boss only (NSoD: Icewing, then Hydra)', async () => {
  const hub = fakeHub();
  const ser = fakeBot('sable7', hub);
  fakeBot('valen7', hub);
  const icewing = { name: 'Warlord Icewing', cell: 'Enter', hpMax: 600000 };
  assert(await hub.struggle(ser, icewing, 2), 'Icewing call');
  hub.bossKilled(ser, { name: 'Warlord Icewing', hpMax: 600000, byMe: true, others: 1, map: hub.help.map });
  eq(hub.help, null);
  eq(await hub.struggle(ser, icewing, 2), null, 'the same boss right after: no new call');
  assert(await hub.struggle(ser, { name: 'Hydra Head 90', cell: 'Boss', hpMax: 400000 }, 2), 'the next boss of the daily gets its call');
});

test('struggle: a call the whole party keeps losing ends, and nobody calls for that boss again today', async () => {
  const hub = fakeHub();
  const ser = fakeBot('sable7', hub);
  const vae = fakeBot('valen7', hub);
  for (const b of [ser, vae]) { b.level = async () => 85; b.roomNumber = () => 13579; }
  const dragon = { name: 'Eternal Dragon', cell: 'r10', hpMax: 600000, hp: 500000 };
  assert(await hub.struggle(ser, dragon, 2), 'first call goes out');
  const t0 = Date.now();
  vae.client.w.strAreaName = 'deadlines-1';                // still on the way / somewhere else: not counted
  for (let i = 0; i < 6; i++) await hub.bossDeath(vae, dragon, t0 + i * 1000);
  assert(hub.help, 'deaths outside the help room do not end the call');
  vae.client.w.strAreaName = 'ultraalteon-13579';
  for (let i = 0; i < 8; i++) await hub.bossDeath(i % 2 ? vae : ser, dragon, t0 + i * 1000);
  eq(hub.help, null, 'called off after 8 party deaths');
  eq(await hub.struggle(ser, dragon, 2), null, 'no second call for the same boss');
  // The ladder (the owner 2026-10-09): the party lost, so the last option - this task waits for players in a public room.
  assert(ser.journals.some((j) => /the whole party lost to it today - last option: taking "x.cs" to a public room on Artix/.test(j)), ser.journals.join(' | '));
  eq([ser.restarts, ser.publicFor.get('script|x.cs|') > Date.now()], [1, true], 'the task restarts at the public step');
  ser.current = { type: 'script', path: 'x.cs', publicStep: true };
  eq(await hub.struggle(ser, dragon, 2), null, 'already public: nothing more to climb');
  assert(ser.journals.some((j) => /could not kill it today either, not calling them/.test(j)));
  hub._helpCooldown = 0;
  assert(await hub.struggle(ser, { name: 'Other Boss', cell: 'r1', hpMax: 600000 }, 2), 'other bosses still get help');
});

test('death cap: 8 deaths to one monster inside one script park it; orders are dropped', async () => {
  const hub = fakeHub();
  const parked = [];
  hub.brain = { park: (bot, t, step) => { parked.push(step); return 'for 24 h'; } };
  const nyx = fakeBot('nova7', hub);
  let restarts = 0;
  nyx.restart = async () => { restarts++; };
  nyx.taskKey = (t) => `${t.type}|${t.path}`;
  nyx.current = { type: 'script', path: 'Seasonal/X.cs', brain: true };
  const zheng = { name: 'Admiral Zheng' };
  const t0 = Date.now();
  for (let i = 0; i < 7; i++) eq(hub.deathCap(nyx, zheng, t0 + i * 1000), false);
  eq(hub.deathCap(nyx, { name: 'Other' }, t0 + 8000), false, 'a different monster');
  eq(hub.deathCap(nyx, zheng, t0 + 9000), true, 'the 8th');
  eq(restarts, 1); assert(/died 8x to Admiral Zheng/.test(parked[0]));
  await new Promise((r) => setTimeout(r, 10));
  nyx.current = { type: 'script', path: 'order.cs' };
  for (let i = 0; i < 8; i++) hub.deathCap(nyx, zheng, t0 + 60000 + i * 1000);
  eq(nyx._dropCurrent, true, 'an order is dropped');
  nyx.current = { type: 'daily', name: 'X' };
  for (let i = 0; i < 9; i++) eq(hub.deathCap(nyx, zheng, t0 + 120000 + i * 1000), false, 'own hunts stop at giveUpDeaths');
});

// Audit 2026-09-28: 778 reconnects on 09-27, mostly hops between Artix and Swordhaven.
test('crowd hops: chores never hop, and crowded retries share two-hour windows', async () => {
  eq(crowd.kindOf({ type: 'style', brain: true }), null, 'dressing up sent Valen from Artix to Swordhaven and back (09-27 04:04)');
  const t = Date.UTC(2026, 8, 28, 5, 10);
  eq(new Date(crowd.windowAfter(t)).toISOString(), '2026-09-28T08:00:00.000Z', 'at least 2 h, then the next even hour');
  eq(crowd.windowAfter(Date.UTC(2026, 8, 28, 6, 0)), Date.UTC(2026, 8, 28, 8, 0), 'already on a window: 2 h later');
  eq(crowd.windowAfter(Date.UTC(2026, 8, 28, 5, 50)), crowd.windowAfter(Date.UTC(2026, 8, 28, 5, 1)), 'two failures an hour apart retry together');
});

test('crowd hops (crowdKnockOffline false): a full Artix is not knocked on - quiet work goes on and a seat brings the character back (old routing)', oldRules(async () => {
  const { Bot } = require('../lib/bot');
  const id = `hop${Math.random().toString(36).slice(2, 7)}`;
  const calls = [];
  const c = { headless: true, on() {}, removeListener() {}, get: async () => null, call: async (fn) => { calls.push(fn); return true; }, wantedServer: 'swordhaven', serverName: 'Swordhaven', state: { loaded: true } };
  const hub = { settings: { crowdKnockOffline: false }, serverFor: () => 'Swordhaven', crowdFull: async () => '1500/1500', assistFor: () => null };
  const bot = new Bot(c, { id, label: id }, { hub });
  let err = null;
  try { await bot.ensureServer({ type: 'daily', name: 'NCSGem', brain: true }); } catch (e) { err = e; }
  eq(err && err.code, 'CROWD_FULL');
  eq(calls.includes('sfc.disconnect'), false, 'did not log out');
  assert(bot.crowdFullUntil > Date.now(), 'crowded work rests');
  eq(bot.crowdBlocked({ type: 'daily', name: 'X' }), true);
  eq(bot.crowdBlocked({ type: 'script', path: 'Other/FarmJoeKits/0FarmerJoeDoAll.cs' }), false, 'quiet work goes on');
  bot.crowdSkip({ type: 'daily', name: 'NCSGem', brain: true });
  eq(bot.isSkipped({ type: 'daily', name: 'NCSGem' }), true);
  bot.queue = [{ type: 'daily', name: 'Order' }, { type: 'kill', map: 'battleon' }];
  eq(bot.nextOrder().map, 'battleon', 'a crowded order waits in the queue');
  // The hub watches the server list; a seat sends the character back.
  const h = { bots: new Map([[id, bot]]), crowdFull: async () => null };
  let restarted = 0;
  bot.running = true; bot.current = { type: 'script', path: 'Other/FarmJoeKits/0FarmerJoeDoAll.cs', brain: true };
  bot.restart = async () => { restarted++; };
  eq(await Hub.prototype.crowdTick.call(h), false, 'one sighting of a seat is not enough (Artix hovers at the limit)');
  eq(await Hub.prototype.crowdTick.call(h), true, 'two in a row');
  eq(bot.crowdFullUntil, 0); eq(bot.isSkipped({ type: 'daily', name: 'NCSGem' }), false, 'the skip is lifted');
  eq(restarted, 1, 'the quiet stopgap gives way');
  // Seat or not, with room the character moves as before.
  hub.crowdFull = async () => null;
  bot.ensureServer({ type: 'daily', name: 'NCSGem', brain: true }).catch(() => null);
  await new Promise((r) => setTimeout(r, 50));
  assert(calls.includes('sfc.disconnect'), 'room on Artix: hops');
  bot.stop();
}));

// 2026-09-29 04:00-05:30: Artix at 1498-1503/1500, and Nova went back and forth 8 times in 13 min.
test('crowd hops: one free seat is room (as in the game), and each stopgap miss in a row waits longer (5, 10, 20, 40 min)', async () => {
  const protocol = require('../lib/net/protocol');
  const real = protocol.servers;
  try {
    const hub = { };
    let count = 1497;
    protocol.servers = async () => [{ sName: 'Artix', iCount: count, iMax: 1500, bOnline: 1 }];
    eq(await Hub.prototype.crowdFull.call(hub), null, '3 free is room: knock (the owner 2026-10-05)');
    count = 1500;
    eq(await Hub.prototype.crowdFull.call(hub), '1500/1500', 'full is full');
    const bot = { running: true, crowdFullUntil: Date.now() + 60000, _crowdRetryAt: Date.now() + 5 * 60000, crowdOpen() { this.opened = true; }, journal() {}, current: null };
    const h = { bots: new Map([['b', bot]]), crowdFull: async () => null };
    await Hub.prototype.crowdTick.call(h); await Hub.prototype.crowdTick.call(h);
    eq(bot.opened, undefined, 'still inside its back-off');
  } finally { protocol.servers = real; }
  // The back-off grows with each Artix-full login in a row (hub.reconnect -> Hub.crowdMiss).
  const b2 = {};
  const now = Date.now();
  eq([1, 2, 3, 4, 5].map(() => (Hub.crowdMiss(b2, now) - now) / 60000), [5, 10, 20, 40, 40]);
  eq(b2.crowdFullUntil, now + 40 * 60000, 'crowded work rests as long');
});

// 2026-09-30/10-01: Artix at 1491-1502/1500 all day, one seat sighting a day; Nova ran no daily for three days.
test('crowd hops (crowdKnockOffline false): after the wait the crowded work goes to the busiest other server, then home (old routing)', oldRules(async () => {
  const { Bot } = require('../lib/bot');
  const protocol = require('../lib/net/protocol');
  const real = protocol.servers;
  const id = `alt${Math.random().toString(36).slice(2, 7)}`;
  const calls = [];
  const c = { headless: true, on() {}, removeListener() {}, get: async () => null, call: async (fn) => { calls.push(fn); return true; }, wantedServer: 'swordhaven', serverName: 'Swordhaven', state: { loaded: true } };
  try {
    protocol.servers = async () => [
      { sName: 'Artix', iCount: 1499, iMax: 1500, bOnline: 1 }, { sName: 'Twilly', iCount: 480, iMax: 1000, bOnline: 1 },
      { sName: 'Alteon', iCount: 407, iMax: 1500, bOnline: 1 }, { sName: 'Sir Ver', iCount: 900, iMax: 1200, bOnline: 1, bUpg: 1 },
      { sName: 'Yorumi', iCount: 990, iMax: 1000, bOnline: 1 }, { sName: 'Galanoth', iCount: 950, iMax: 1500, bOnline: 0 }];
    eq(await Hub.prototype.crowdAlt.call({}, 90), 'Twilly', 'not the member server, the full one or the offline one');
    const hub = { settings: { crowdKnockOffline: false }, serverFor: () => 'Swordhaven', assistFor: () => null, crowdFull: () => Hub.prototype.crowdFull.call({}), crowdAlt: (l) => Hub.prototype.crowdAlt.call({}, l) };
    const bot = new Bot(c, { id, label: id }, { hub });
    const daily = { type: 'daily', name: 'NCSGem', brain: true };
    let err = null;
    // 1499/1500 has a seat now; a full 1500 makes it wait.
    protocol.servers = async () => [
      { sName: 'Artix', iCount: 1500, iMax: 1500, bOnline: 1 }, { sName: 'Twilly', iCount: 480, iMax: 1000, bOnline: 1 },
      { sName: 'Alteon', iCount: 407, iMax: 1500, bOnline: 1 }];
    try { await bot.ensureServer(daily); } catch (e) { err = e; }
    eq([err && err.code, calls.includes('sfc.disconnect')], ['CROWD_FULL', false], 'the first half hour: wait for a seat as before');
    bot._crowdWaitSince = Date.now() - 31 * 60000;
    bot.ensureServer(daily).catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    eq([bot.crowdAlt, bot.wantServer, calls.includes('sfc.disconnect'), bot.crowdFullUntil], ['Twilly', 'Twilly', true, 0], 'logs out to log in on Twilly');
    bot.stop();
    // Logged in there: crowded work stays, quiet work goes home and the next wait starts from zero.
    c.wantedServer = 'twilly'; c.serverName = 'Twilly'; calls.length = 0;
    const bot2 = new Bot(c, { id, label: id }, { hub });
    bot2.crowdAlt = 'Twilly';
    await bot2.ensureServer(daily);
    eq(calls.includes('sfc.disconnect'), false, 'the dailies run on Twilly');
    bot2.ensureServer({ type: 'farmLevel', to: 100, brain: true }).catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    eq([bot2.crowdAlt, bot2.wantServer, calls.includes('sfc.disconnect'), bot2._crowdWaitSince || null], [null, 'Swordhaven', true, null]);
    bot2.stop();
  } finally { protocol.servers = real; }
}));

// The owner 2026-10-17: "the party help each other in everything" - me time and events call the party too.
test('struggle: me time and events call the party; a wish call stays until the piece is owned', async () => {
  const hub = fakeHub();
  const nyx = fakeBot('nova7', hub);
  fakeBot('valen7', hub);
  nyx.current = { type: 'wish', route: { kind: 'drop', map: 'necroproject', monster: 'Imperial Noxus' }, item: 'Imperial Noxus Tassels', wish: 'Imperial Noxus Tassels', style: true };
  const h = await hub.struggle(nyx, { name: 'Imperial Noxus', cell: 'r5', hpMax: 120000 }, 2);
  assert(h, 'me time calls');
  eq([h.farm.item, h.farm.untilOwned], ['Imperial Noxus Tassels', true]);
  const t0 = Date.now();
  assert(hub.helpFarmKill(h, t0), 'the first kill does not end it');
  assert(hub.helpFarmKill(h, t0 + 6000), 'nor the second');
  assert(!hub.helpFarmKill(h, h.hardUntil + 10000), 'the 3 h cap still does');
  hub.help = null; hub._helpCooldown = 0;
  nyx.current = { type: 'script', path: 'Seasonal/X/Story.cs', event: 'TalkLikeaPirateDay' };
  assert(await hub.struggle(nyx, { name: 'Admiral Zheng', cell: 'r10', hpMax: 900000 }, 2), 'an event calls too');
});

test('struggle: no party call for a daily in a public room or a boss that needs a crowd', async () => {
  const hub = fakeHub();
  const nyx = fakeBot('nova7', hub);
  fakeBot('valen7', hub);
  const zheng = { name: 'Admiral Zheng', cell: 'r10', hpMax: 900000 };
  nyx.current = { type: 'daily', name: 'NSoDDaily' };
  const area0 = nyx.client.w.strAreaName;
  nyx.client.w.strAreaName = 'ultraalteon-4';
  eq(await hub.struggle(nyx, zheng, 2), null, 'daily in a public room');
  nyx.client.w.strAreaName = area0;
  nyx.current = { type: 'script', path: 'Good/ArchPaladin.cs', goal: 'archpaladin', brain: true };
  crowd.setLadder(false);
  try { eq(await hub.struggle(nyx, { name: 'Desolich', cell: 'r3', hpMax: 8195130 }, 2), null, 'old rules - Desolich: 2,700x my HP'); } finally { crowd.setLadder(true); }
  assert(await hub.struggle(nyx, zheng, 2), 'a progress goal still calls');
});

// The owner 2026-10-09: "IF A BOSS CAN BE soloed by a bot then he doesnt need to wait for people, if it cant be soloed call
// the party, if they cant do it as a 4 then the last option is to wait for public people to help."
test('ladder: crowded content starts in the party room; only a task at the public step goes to Artix', async () => {
  eq(crowd.LADDER, true, 'on by default (crowd.json ladder)');
  eq(crowd.kindOf({ type: 'daily', name: 'NSoDDaily' }), 'quiet', 'a daily starts in the party room');
  eq(crowd.kindOf({ type: 'script', path: 'Evil/NSoD/VoidAuras/RetreiveVoidAuras.cs' }), 'quiet', 'void auras too');
  eq(crowd.kindOf({ type: 'script', path: 'Enhancement/UnlockForgeEnhancements.cs', entry: 'Lament' }), 'quiet', 'Forge: Lament too');
  eq(crowd.contentKind({ type: 'daily', name: 'NSoDDaily' }), 'crowd', 'what the content is does not change');
  eq(crowd.kindOf({ type: 'daily', name: 'NSoDDaily', publicStep: true }), 'crowd', 'the party lost: Artix, public room');
  eq(crowd.kindOf({ type: 'script', path: 'Good/ArchPaladin.cs', publicStep: true }), 'crowd', 'any work at the public step');
  eq(crowd.kindOf({ type: 'script', path: 'Ultrasv3/IndividualUltras/10UltraSpeakerv3.cs', publicStep: true }), 'quiet', 'ultras never go public');
  eq(crowd.kindOf({ type: 'script', raid: 'x', path: 'y.cs', publicStep: true }), 'quiet', 'nor raids');
  eq(crowd.kindOf({ type: 'armyFarm', map: 'ultradage', room: 13579, publicStep: true }), 'quiet', 'a shared room stays');
  eq(crowd.kindOf({ type: 'bankAc', publicStep: true }), null, 'chores have no say');
});

test('ladder: a boss far bigger than the character still gets the party first; helpers, raids and guests never go public', async () => {
  const hub = fakeHub();
  const nyx = fakeBot('nova7', hub);
  fakeBot('valen7', hub);
  nyx.current = { type: 'script', path: 'Good/ArchPaladin.cs', goal: 'archpaladin', brain: true };
  assert(await hub.struggle(nyx, { name: 'Desolich', cell: 'r3', hpMax: 8195130 }, 2), 'HP is no proof: the party tries it');
  for (const t of [{ type: 'assist' }, { type: 'script', path: 'x.cs', raid: 'speaker' }, { type: 'script', path: 'Ultras/UltraDage.cs' }, { type: 'kill', map: 'ultradage', room: 13579 }]) {
    nyx.current = t;
    eq(hub.canGoPublic(nyx), false, JSON.stringify(t));
  }
  nyx.current = { type: 'daily', name: 'NSoDDaily' };
  eq(hub.canGoPublic(nyx), true);
  nyx.account.kind = 'guest';
  eq(hub.canGoPublic(nyx), false, "the owner's own account");
});

test('me time: a boss that keeps killing the character rests the wish for days and never DMs the owner', async () => {
  const { Brain } = require('../lib/brain');
  const brain = new Brain();
  const hub = fakeHub();
  const nyx = fakeBot('nova7', hub);
  nyx.file = null; nyx.taskKey = (t) => `${t.type}|${t.path}|${t.wish}`; nyx.level = async () => 89; nyx.serverName = 'Swordhaven';
  nyx.current = { type: 'script', path: 'Seasonal/TalkLikeaPirateDay/MergeShops/YokaiTreasureMerge.cs', entry: 'BuyAllMerge', style: true, wish: 'Shinobi Pirate Master', brain: true };
  const sends = [];
  hub.discord = { send: (text) => { sends.push(text); return true; } };
  const zheng = { name: 'Admiral Zheng', cell: 'r10', hpMax: 900000, hp: 800000 };
  const t0 = Date.now();
  await hub.bossDeath(nyx, zheng, t0); await hub.bossDeath(nyx, zheng, t0 + 1000);
  eq(sends.length, 0, 'cosmetic: no DM');
  assert(hub.infos.some((i) => /no DM \(me time \/ event: cosmetic\)/.test(i)), hub.infos.join(' | '));
  nyx.id = `park${Math.random().toString(36).slice(2, 6)}`;
  const what = brain.park(nyx, nyx.current, 'died 8x to Admiral Zheng in 30 min', { deaths: true });
  eq(what, 'for 3 days (the boss is too strong for now)');
  const st = brain.state(nyx);
  eq(st.wishFails['Shinobi Pirate Master'].n, 2, 'the wish rests');
  assert(Object.keys(st.routeFails).some((k) => /YokaiTreasureMerge/.test(k)), 'and so does its route');
});

test('help calls: characters doing dailies or Lord of Order keep doing them', async () => {
  const hub = fakeHub();
  const nyx = fakeBot('nova7', hub);
  const ser = fakeBot('sable7', hub);
  ser.current = { type: 'script', path: 'Dailies/LordOfOrder.cs', recurring: 'loo-daily' };
  const vae = fakeBot('valen7', hub);
  vae.current = { type: 'daily', name: 'NCSGem' };
  const h = await hub.struggle(nyx, { name: 'Gallaeon', cell: 'r4', hpMax: 900000 }, 2);
  eq(h.helpers, [], 'nobody pulled out of a daily');
  eq(nyx.ran.length, 1);
});

test('crowd knock (the owner 2026-10-05): a full Artix and crowded work - the character logs out and knocks, alone (old routing)', oldRules(async () => {
  const { Bot } = require('../lib/bot');
  const id = `knock${Math.random().toString(36).slice(2, 7)}`;
  const calls = []; const lines = [];
  const c = { headless: true, on() {}, removeListener() {}, get: async () => null, call: async (fn) => { calls.push(fn); return true; }, wantedServer: 'swordhaven', serverName: 'Swordhaven', state: { loaded: true } };
  const hub = { settings: {}, serverFor: (k) => (k === 'crowd' ? 'Artix' : 'Swordhaven'), crowdFull: async () => '1500/1500', assistFor: () => null };
  const bot = new Bot(c, { id, label: id }, { hub });
  bot.journal = (t) => lines.push(t);
  bot.ensureServer({ type: 'daily', name: 'NCSGem', brain: true }).catch(() => null);
  await new Promise((r) => setTimeout(r, 50));
  eq([bot.wantServer, calls.includes('sfc.disconnect')], ['Artix', true], 'logs out to knock on Artix (hub.reconnect waits for a seat)');
  assert(lines.some((l) => /knocking on it until a seat opens \(up to 30 min\)/.test(l)), lines.join(' | '));
  eq(bot.crowdBlocked({ type: 'daily', name: 'X' }), false, 'no quiet stopgap, no rest for the crowded work');
  bot.stop();
}));

// The owner 2026-10-07: "ultra blood titan doesnt count as an ultra boss" - only the weekly party-of-4 bosses are ultras.
test('crowd: the Forge unlocks farm their bosses on Artix; weekly ultras stay private (old routing)', oldRules(async () => {
  eq(crowd.kindOf({ type: 'script', path: 'Enhancement/UnlockForgeEnhancements.cs', entry: 'Lament' }), 'crowd', 'Forge: Lament');
  eq(crowd.kindOf({ type: 'script', path: 'Enhancement\\UnlockForgeEnhancements.cs', entry: 'Vainglory' }), 'crowd', 'Windows path');
  eq(crowd.privateMap('bloodtitan'), false, 'Ultra Blood Titan is a farm boss');
  eq(crowd.privateMap('ultraezrajal'), true, 'a weekly ultra map stays private');
  eq(crowd.privateMap('championdrakath'), true);
  eq(crowd.kindOf({ type: 'script', path: 'Ultrasv3/IndividualUltras/10UltraSpeakerv3.cs' }), 'quiet', 'weekly ultras stay on the quiet server');
  eq(crowd.kindOf({ type: 'script', path: 'Enhancement/UnlockAllEnhancements.cs' }), 'quiet', 'other enhancement scripts unchanged');
}));

test('ladder: a task the party lost runs at the public step until the mark runs out (bot.stampPublic)', async () => {
  const { Bot } = require('../lib/bot');
  const b = Object.create(Bot.prototype);
  const t = { type: 'daily', name: 'NSoDDaily', brain: true };
  eq([b.stampPublic({ ...t }), crowd.kindOf(t)], [false, 'quiet'], 'no mark: the party room');
  b.publicFor = new Map([[b.taskKey(t), Date.now() + 60000]]);
  const t2 = { ...t };
  eq([b.stampPublic(t2), crowd.kindOf(t2)], [true, 'crowd'], 'marked: Artix, public room');
  eq(b.stampPublic({ type: 'daily', name: 'Other' }), false, 'other work is not affected');
  b.publicFor.set(b.taskKey(t), Date.now() - 1);
  eq([b.stampPublic({ ...t }), b.publicFor.size], [false, 0], 'a mark that ran out is dropped');
});

// 2026-10-13: Legion Lich Lord (Forge: Lament wants 100 Sapphire Orbs, one per kill) one-shots everyone. The call ended
// at the first kill (one orb per call), and the 10-11 call got the 24 h wall from 8 deaths with only two fighters there.
test('struggle: a step that farms the boss many times keeps the party there until the caller has them all', async () => {
  const hub = fakeHub();
  const orr = fakeBot('oren7', hub);
  const vae = fakeBot('valen7', hub);
  orr.scriptStep = '(HuntMonster) Killing Legion Lich Lord for item: "Sapphire Orb" #/#';   // as bot.js keeps it
  orr.scriptStepRaw = '(HuntMonster) Killing Legion Lich Lord for item: "Sapphire Orb" 97/100';
  let orbs = 97; orr.count = async () => orbs;
  const lll = { name: 'Legion Lich Lord', cell: 'r3', hpMax: 848160, hp: 848160 };
  const h = await hub.struggle(orr, lll, 2);
  assert(h && h.farm, 'a farm call');
  eq([h.farm.item, h.farm.have, h.farm.want, h.kills], ['Sapphire Orb', 97, 100, 0]);
  const kill = () => hub.bossKilled(vae, { name: 'Legion Lich Lord', hpMax: 848160, byMe: true, others: 1, map: 'ultraalteon' });
  h.map = 'ultraalteon';                                   // the fake bots report this map
  kill();
  eq(hub.help, h, 'first kill: the party stays');
  assert(h.until > Date.now() + 10 * 60000, 'each kill buys more time');
  orbs = 100; h.lastKillAt -= 60000; kill();                 // the next kill, a minute later
  await new Promise((r) => setImmediate(r));
  eq(hub.help, null, 'the caller has all 100: the call is over');
  eq(hub.isPartyWall('Legion Lich Lord'), false, 'no wall after a farm call');
});

// 2026-10-20: Valen's Forge: Elysium step was "(_KillForItem) Farming Sapphire Orb (13/26)" - no boss name, so the call
// ended at the first kill, he died alone and the goal parked for 24 h.
test('struggle: a step that names no monster is a farm call too, unless it farms another monster', async () => {
  const hub = fakeHub();
  const vae = fakeBot('valen7', hub);
  fakeBot('oren7', hub);
  vae.scriptStep = '(_KillForItem) Farming Sapphire Orb (#/#)';
  vae.scriptStepRaw = '(_KillForItem) Farming Sapphire Orb (13/26)';
  vae.farm = { monster: null, items: ['Sapphire Orb'], map: null };
  const lll = { name: 'Legion Lich Lord', cell: 'r3', hpMax: 848160, hp: 848160 };
  const h = await hub.struggle(vae, lll, 2);
  assert(h && h.farm, 'a farm call');
  eq([h.farm.item, h.farm.have, h.farm.want], ['Sapphire Orb', 13, 26]);

  const hub2 = fakeHub();
  const vae2 = fakeBot('valen7', hub2);
  fakeBot('oren7', hub2);
  vae2.scriptStep = vae.scriptStep; vae2.scriptStepRaw = vae.scriptStepRaw;
  vae2.farm = { monster: 'Frost Invader', items: ['Sapphire Orb'], map: null };
  const h2 = await hub2.struggle(vae2, lll, 2);
  assert(h2 && !h2.farm, 'the step farms another monster: a one-kill call');
});

test('struggle: deaths in a fight the party is winning are no party wall', async () => {
  const hub = fakeHub();
  const orr = fakeBot('oren7', hub);
  const vae = fakeBot('valen7', hub);
  for (const b of [orr, vae]) { b.level = async () => 99; b.roomNumber = () => 13579; }
  const lll = { name: 'Legion Lich Lord', cell: 'r3', hpMax: 848160, hp: 300000 };
  assert(await hub.struggle(orr, lll, 2));
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) await hub.bossDeath(i % 2 ? vae : orr, lll, t0 + i * 1000);
  assert(hub.help, 'boss under half HP: 10 deaths do not call it off');
  for (let i = 10; i < 24; i++) await hub.bossDeath(i % 2 ? vae : orr, lll, t0 + i * 1000);
  eq(hub.help, null, '3x the deaths without a kill: called off');
  eq(hub.isPartyWall('Legion Lich Lord'), true);
});

test('struggle: a call that killed the boss and then ran out of time is no wall', async () => {
  const hub = fakeHub();
  const orr = fakeBot('oren7', hub);
  fakeBot('valen7', hub);
  orr.scriptStep = '(HuntMonster) Killing Legion Lich Lord for item: "Sapphire Orb" #/#';
  orr.scriptStepRaw = '(HuntMonster) Killing Legion Lich Lord for item: "Sapphire Orb" 13/100';
  orr.count = async () => 14;
  const lll = { name: 'Legion Lich Lord', cell: 'r3', hpMax: 848160, hp: 848160 };
  const h = await hub.struggle(orr, lll, 2);
  h.map = 'ultraalteon';
  hub.bossKilled(orr, { name: 'Legion Lich Lord', hpMax: 848160, byMe: true, others: 1, map: 'ultraalteon' });
  h.until = Date.now() - 1;
  hub._helpCooldown = 0;
  await hub.struggle(orr, lll, 2);
  eq(hub.isPartyWall('Legion Lich Lord'), false);
});

test('struggle: a farm call counts one kill when every character in the room reports it', async () => {
  const hub = fakeHub();
  const orr = fakeBot('oren7', hub);
  const vae = fakeBot('valen7', hub);
  orr.scriptStep = '(HuntMonster) Killing Legion Lich Lord for item: "Sapphire Orb" #/#';
  orr.scriptStepRaw = '(HuntMonster) Killing Legion Lich Lord for item: "Sapphire Orb" 10/100';
  orr.count = async () => 11;
  const h = await hub.struggle(orr, { name: 'Legion Lich Lord', cell: 'r3', hpMax: 848160, hp: 848160 }, 2);
  h.map = 'ultraalteon';
  for (const b of [orr, vae, orr, vae]) hub.bossKilled(b, { name: 'Legion Lich Lord', hpMax: 848160, byMe: true, others: 3, map: 'ultraalteon' });
  eq(h.kills, 1, 'four reports, one kill');
});

test('struggle: an ultra raid boss never calls the party, even a death landing after the raid ended (Speaker 2026-10-23)', async () => {
  const hub = fakeHub();
  const vae = fakeBot('valen7', hub);
  const nyx = fakeBot('nova7', hub);
  vae.current = { type: 'script', path: 'Enhancement/UnlockForgeEnhancements.cs', goal: 'forge-ravenous' };
  eq(await hub.struggle(vae, { name: 'The First Speaker', cell: 'Boss', hpMax: 50e6 }, 9), null, 'the raid was called off a second ago');
  eq(await hub.struggle(vae, { name: 'Ultra Ezrajal', cell: 'Boss', hpMax: 30e6 }, 3), null, 'a Time Inn boss by its raid name');
  eq(hub.help, undefined, 'no call went out');
  eq(nyx.ran.length, 0, 'nobody was pulled into the raid map');
  hub.raid = { members: ['valen7'] };
  eq(await hub.struggle(vae, { name: 'Alteon', cell: 'r2', hpMax: 900000 }, 3), null, 'a raid member never calls');
  eq(vae.journals.length, 0, 'and writes no "not calling them" line per death');
});
