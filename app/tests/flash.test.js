// The Flash standby (2026-10-11, the owner): the real AQW game for up to N characters, in his order, when the headless client
// can't log in or nobody gains anything - and back when headless works again.
const EventEmitter = require('events');
const { FlashStandby } = require('../lib/flashstandby');
const { FlashClient } = require('../lib/net/flashclient');

function fakeHub(ids = ['sable7', 'valen7', 'nova7', 'oren7']) {
  const hub = { settings: {}, bots: new Map(), clients: new Map(), log: [], notes: [], dms: [], opened: [], closed: [] };
  hub.info = (m) => hub.log.push(m);
  hub.notify = (t, b) => hub.notes.push(`${t}: ${b}`);
  hub.discord = { enabled: true, send: (t, o) => hub.dms.push({ t, o }) };
  hub.saveSettings = () => {};
  hub.bot = (id) => hub.bots.get(id) || null;
  hub.close = (id) => { hub.closed.push(id); };
  hub.open = (acc) => { hub.opened.push(`${acc.id}:${hub.standby.modeOf(acc.id)}`); const c = hub.clients.get(acc.id); c.headless = hub.standby.modeOf(acc.id) !== 'flash'; c.flash = !c.headless; };
  hub.flash = { constructor: { installed: () => true }, status: () => ({ installed: true, running: false, games: [], restarts: 0 }), running: () => false };
  for (const id of ids) {
    let sum = 0;
    hub.bots.set(id, { id, running: true, account: { id, label: id, kind: 'party', status: 'active' }, progressMark: () => ({ xp: sum, kills: 0, quests: 0, drops: 0, items: 0 }), gain() { sum += 10; } });
    hub.clients.set(id, { headless: true, state: { loaded: true } });
  }
  return hub;
}

function standby(hub, t0 = Date.UTC(2026, 9, 11, 12)) {
  let now = t0;
  const sb = new FlashStandby(hub, { now: () => now });
  sb.active.clear(); sb.autoOn = null; sb.trial = null; sb.history = []; sb.save = () => {};
  sb.serverListAnswers = async () => true;
  hub.standby = sb;
  return { sb, at: (min) => { now = t0 + min * 60000; } };
}

test('flash standby: all logins failing 20 min -> the first 3 in the owner\'s order move to the real game, with a DM', async () => {
  const hub = fakeHub();
  const { sb, at } = standby(hub);
  for (const c of hub.clients.values()) { c.state.loaded = false; c._offlineSince = Date.UTC(2026, 9, 11, 12); c._lastLoginError = 'the game did not finish loading this character'; }
  at(10); await sb.tick();
  eq(sb.active.size, 0, '10 min: not yet');
  at(21); await sb.tick();
  assert(sb.autoOn && /could log in for 21 min/.test(sb.autoOn.reason), JSON.stringify(sb.autoOn));
  eq([...sb.active], ['sable7', 'valen7', 'nova7']);
  eq(hub.opened, ['sable7:flash', 'valen7:flash', 'nova7:flash']);
  assert(hub.dms.length === 1 && hub.dms[0].o.dm, 'the owner gets a DM');
});

test('flash standby: a dead network is not a broken client; a full server is not either', async () => {
  const hub = fakeHub();
  const { sb, at } = standby(hub);
  for (const c of hub.clients.values()) { c.state.loaded = false; c._offlineSince = Date.UTC(2026, 9, 11, 12); c._lastLoginError = 'getaddrinfo EAI_AGAIN game.aq.com'; }
  sb.serverListAnswers = async () => false;
  at(30); await sb.tick();
  eq(sb.active.size, 0, 'no server list: the Wi-Fi, not the client');
  sb.serverListAnswers = async () => true;
  for (const c of hub.clients.values()) c._lastLoginError = 'Artix is full (1500/1500)';
  at(31); await sb.tick();
  eq(sb.active.size, 0, 'full Artix: knocking, not broken');
});

test('flash standby: everyone in game but nobody gaining for stallMin turns it on; gains keep it off', async () => {
  const hub = fakeHub();
  const { sb, at } = standby(hub);
  hub.settings.flash = { stallMin: 60 };
  for (let m = 0; m <= 50; m += 10) { at(m); hub.bot('nova7').gain(); await sb.tick(); }
  eq(sb.active.size, 0, 'one character gaining: fine');
  for (let m = 60; m <= 130; m += 10) { at(m); await sb.tick(); }
  assert(sb.autoOn && /gained anything for 60 min/.test(sb.autoOn.reason), JSON.stringify(sb.autoOn));
  eq(sb.active.size, 3);
});

test('flash standby: a raid or a help call gaining nothing for hours is not a broken client', async () => {
  const hub = fakeHub();
  const { sb, at } = standby(hub);
  hub.settings.flash = { stallMin: 60 };
  for (const id of ['sable7', 'valen7', 'nova7']) hub.bot(id).current = { type: 'script', raid: 'raid-1' };
  hub.bot('oren7').current = { type: 'assist', id: 'help-1' };
  for (let m = 0; m <= 150; m += 10) { at(m); await sb.tick(); }
  eq(sb.active.size, 0, JSON.stringify(sb.autoOn));
});

test('flash standby: modes and order from the dashboard; maxGames; off switches everyone back', async () => {
  const hub = fakeHub();
  const { sb, at } = standby(hub);
  sb.setCfg({ order: ['oren7', 'nova7', 'valen7', 'sable7'], maxGames: 2, modes: { nova7: 'headless', sable7: 'flash' } });
  at(1); await sb.tick();
  eq([...sb.active], ['sable7'], '"Always Flash" goes at once, standby or not');
  sb.autoOn = { at: 'x', reason: 'test' };
  at(2); await sb.tick();
  eq([...sb.active].sort(), ['oren7', 'sable7'], 'the forced one counts toward the 2; nova7 is "never"');
  sb.setCfg({ enabled: false });
  at(3); await sb.tick();
  eq(sb.active.size, 0, 'disabled: everyone back to headless');
});

test('flash standby: turns off when a headless character is in game again; with everyone in Flash, a trial login decides', async () => {
  const hub = fakeHub(['a', 'b', 'c', 'd']);
  const { sb, at } = standby(hub);
  sb.setCfg({ order: ['a', 'b', 'c', 'd'], maxGames: 3, retryHeadlessMin: 60, trialMin: 10 });
  sb.autoOn = { at: 'x', reason: 'test' };
  hub.clients.get('d').state.loaded = false; hub.clients.get('d')._offlineSince = 1;
  at(0); await sb.tick();
  eq([...sb.active], ['a', 'b', 'c']);
  // d (headless) logs in and gains: headless works.
  hub.clients.get('d').state.loaded = true; hub.clients.get('d')._offlineSince = null; hub.clients.get('d')._loadedAt = Date.UTC(2026, 9, 11, 12);
  for (let m = 1; m <= 7; m++) { at(m); hub.bot('d').gain(); await sb.tick(); if (!sb.autoOn) break; }
  eq([sb.autoOn, sb.active.size], [null, 0], 'standby off, all back on headless');

  // Everyone in Flash (maxGames 4): after retryHeadlessMin the last one tries headless; it fails, goes back.
  const hub2 = fakeHub(['a', 'b', 'c', 'd']);
  const s2 = standby(hub2);
  s2.sb.setCfg({ order: ['a', 'b', 'c', 'd'], maxGames: 4, retryHeadlessMin: 60, trialMin: 10 });
  s2.sb.autoOn = { at: 'x', reason: 'test' };
  s2.at(0); await s2.sb.tick();
  eq(s2.sb.active.size, 4);
  s2.at(61); await s2.sb.tick();
  eq([s2.sb.trial && s2.sb.trial.id, s2.sb.active.has('d')], ['d', false], 'd tries the headless client');
  hub2.clients.get('d').state.loaded = false;
  s2.at(72); await s2.sb.tick();
  eq([s2.sb.trial, s2.sb.active.has('d'), !!s2.sb.autoOn], [null, true, true], 'still broken: d back in Flash');
});

test('flash client: bridge calls, events and crashes go through the Flash host', async () => {
  const host = new EventEmitter();
  host.calls = [];
  host.openGame = async (id) => { host.opened = id; };
  host.closeGame = (id) => { host.closedId = id; };
  host.call = async (id, fn, args) => { host.calls.push([id, fn, args]); return fn === 'getGameObject' ? { ok: true, value: '{"a":1}' } : { ok: false, error: 'no' }; };
  host.shot = async () => ({ ok: true });
  const c = new FlashClient({ id: 'fc1', label: 'fc1' }, host, { fps: 3 });
  eq([c.headless, c.flash], [false, true]);
  await c.start();
  eq(host.opened, 'fc1');
  eq(await c.get('world.x'), { a: 1 });
  eq(await c.rawCall('getGameObject', 'world.x'), '{"a":1}', 'raw string for Skua\'s engine');
  let failed = false;
  try { await c.call('nope'); } catch (e) { failed = true; }
  assert(failed, 'a failed bridge call throws');
  let loaded = false;
  c.on('loaded', () => { loaded = true; });
  host.emit('ev:fc1', 'state', 'loaded');
  assert(loaded && c.state.loaded, 'loaded from the game page');
  host.emit('crash:fc1', 'plugin crashed');
  eq([c.state.loaded, c.state.crashes], [false, 1]);
  c.stop();
  eq(host.closedId, 'fc1');
});

// 2026-10-11: one batched read for the engine's mirror instead of one Flash call per polled value (~450 ms each).
test('flash client: batched raw answers come back as the strings Skua expects', async () => {
  const host = new EventEmitter();
  host.batch = async (id, calls) => calls.map(([fn]) => (fn === 'isLoggedIn' ? { ok: true, value: true } : fn === 'getGameObject' ? { ok: true, value: '"battleon"' } : { ok: false, error: 'x' }));
  const c = new FlashClient({ id: 'fc2', label: 'fc2' }, host);
  eq(await c.batchRaw([['isLoggedIn', []], ['getGameObject', ['world.strMapName']], ['nope', []]]), ['true', '"battleon"', null]);
  host.batch = async () => null;
  eq(await c.batchRaw([['isLoggedIn', []]]), null, 'no game view: nothing');
});

test('flash standby: turned on by hand it stays on while headless works, until turned off by hand', async () => {
  const hub = fakeHub(['a', 'b', 'c', 'd']);
  const { sb, at } = standby(hub);
  sb.setCfg({ order: ['a', 'b', 'c', 'd'], maxGames: 3 });
  hub.clients.get('d')._loadedAt = Date.UTC(2026, 9, 11, 11);   // d headless, in game for an hour
  sb.autoOn = { at: 'x', reason: 'turned on from the dashboard', manual: true };
  for (let m = 0; m <= 5; m++) { at(m); hub.bot('d').gain(); await sb.tick(); }
  eq([!!sb.autoOn, [...sb.active]], [true, ['a', 'b', 'c']], 'still on');
  sb.autoOn = null;
  at(6); await sb.tick();
  eq(sb.active.size, 0, 'off by hand: back to headless');
});
