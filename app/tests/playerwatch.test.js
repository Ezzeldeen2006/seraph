// Player watch: a spare account hops the servers asking /goto, and the owner gets one DM per login.
const EventEmitter = require('events');
const { PlayerWatch } = require('../lib/playerwatch');

const SERVERS = [
  { sName: 'Twilly', bOnline: 1, bUpg: 0, iCount: 600, iMax: 1000 },
  { sName: 'Artix', bOnline: 1, bUpg: 0, iCount: 1500, iMax: 1500 },
  { sName: 'Sir Ver', bOnline: 1, bUpg: 1, iCount: 50, iMax: 1200 },
  { sName: 'Yorumi', bOnline: 1, bUpg: 0, iCount: 180, iMax: 1500 },
  { sName: 'Espada', bOnline: 1, bUpg: 0, iCount: 280, iMax: 1000 },
];

// A fake game: `where` says which server WatchedPlayer is on (null = offline).
function fake() {
  const world = { where: null, connects: [], gotos: 0 };
  const client = new EventEmitter();
  Object.assign(client, {
    w: { users: {} },
    scriptLogin: async () => ({ level: 1, upgradeDays: 0, servers: SERVERS }),
    scriptConnect: async (s) => { world.connects.push(s.sName); client.server = s.sName; },
    disconnect: () => { client.server = null; },
    xt: (cmd, args) => {
      world.gotos++;
      setImmediate(() => {
        if (world.where === client.server) client.emit('sfs', { kind: 'json', data: { cmd: 'moveToArea', areaName: 'battleon-1234' } });
        else client.emit('sfs', { kind: 'xt', cmd: 'warning', args: ['-1', `Player '${args[1]}' could not be found.`] });
      });
    },
  });
  const sent = []; const logs = [];
  const hub = { info: (m) => logs.push(m), discord: { send: (text, o) => { sent.push({ text, ...o }); return true; } } };
  const pw = new PlayerWatch(hub, { watch: ['WatchedPlayer'], account: { username: 'Watcher' }, gapMs: 0 }, { makeClient: () => client, wait: async () => {} });
  return { pw, world, sent, logs };
}

test('player watch: sweeps free servers busiest first, skips full and member-only ones', async () => {
  const { pw, world, sent, logs } = fake();
  await pw.sweep();
  eq(world.connects, ['Twilly', 'Espada', 'Yorumi'], 'order');
  eq(sent.length, 0, 'offline: no DM');
  assert(!logs.some((l) => /online/.test(l)), logs.join('|'));
});

test('player watch: one DM with server and room, next sweep starts where WatchedPlayer was', async () => {
  const { pw, world, sent } = fake();
  world.where = 'Yorumi';
  await pw.sweep();
  eq(world.connects, ['Twilly', 'Espada', 'Yorumi']);
  eq(sent.length, 1);
  assert(sent[0].dm && /WatchedPlayer/.test(sent[0].text) && /Yorumi/.test(sent[0].text) && /battleon-1234/.test(sent[0].text), sent[0].text);
  world.connects = [];
  await pw.sweep();
  eq(world.connects, ['Yorumi'], 'found at once, nothing else visited');
  eq(sent.length, 1, 'still online: no second DM');
  world.where = 'Twilly';
  await pw.sweep();
  eq(sent.length, 1, 'server hop is not a new login');
});

test('player watch: offline after two empty sweeps, then a new login DMs again', async () => {
  const { pw, world, sent } = fake();
  world.where = 'Espada'; await pw.sweep();
  world.where = null; await pw.sweep();
  eq(pw.status.watchedplayer.online, true, 'one miss is not enough');
  await pw.sweep();
  eq(pw.status.watchedplayer.online, false);
  world.where = 'Twilly'; await pw.sweep();
  eq(sent.length, 2);
});
