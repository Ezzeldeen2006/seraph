// Friend watch: a DM when a watched player logs in, once per login, and one friend request when nobody has them.
const fs = require('fs');
const path = require('path');
const { FriendWatch } = require('../lib/friendwatch');
const { P } = require('../lib/paths');

function setup(requestFrom = 'Sable7') {
  try { fs.unlinkSync(path.join(P.ROOT, 'friendwatch-state.json')); } catch { /* none yet */ }
  const list = path.join(P.ROOT, 'friendwatch-test.json');
  fs.writeFileSync(list, JSON.stringify({ watch: ['WatchedPlayer'], requestFrom }));
  const sent = []; const logs = [];
  const hub = { info: (m) => logs.push(m), discord: { send: (text, o) => { sent.push({ text, ...o }); return true; } } };
  const fw = new FriendWatch(hub, { list });
  const bot = (label) => { const xt = []; return { xt, account: { label }, client: { xt: (...a) => xt.push(a) } }; };
  return { fw, sent, logs, bot };
}
const pkt = (sServer, cmd = 'updateFriend') => ({ cmd, friend: { ID: 1, sName: 'watchedplayer', iLvl: 100, sServer } });

test('friend watch: DMs once when WatchedPlayer comes online, not per bot or per server hop', async () => {
  const { fw, sent, bot } = setup();
  const a = bot('Sable7'); const b = bot('Valen7');
  fw.onPacket(a, { cmd: 'friends', friends: [{ ID: 1, sName: 'watchedplayer', sServer: 'Offline' }] });
  eq(sent.length, 0, 'offline at login sends nothing');
  fw.onPacket(a, pkt('Twilly'));
  fw.onPacket(b, pkt('Twilly'));
  eq(sent.length, 1, 'one DM for both bots');
  assert(sent[0].dm === true && /WatchedPlayer/.test(sent[0].text) && /Twilly/.test(sent[0].text), sent[0].text);
  fw.onPacket(a, pkt('Artix'));
  eq(sent.length, 1, 'server change while online is no new login');
  fw.onPacket(a, pkt('Offline'));
  fw.onPacket(a, pkt('Yorumi'));
  eq(sent.length, 2, 'logging in again is');
  fw.onPacket(a, { cmd: 'updateFriend', friend: { ID: 2, sName: 'grail26', sServer: 'Twilly' } });
  eq(sent.length, 2, 'other friends are ignored');
});

test('friend watch: requestFrom asks WatchedPlayer, retries while "not found", stops once it goes through', async () => {
  const { fw, bot, logs } = setup();
  const a = bot('Sable7'); const b = bot('Valen7');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fw.onLogin(b, 1); await wait(30);
  eq(b.xt.length, 0, 'only requestFrom asks');
  fw.onLogin(a, 60000);
  fw.ask(60000, 20);
  eq(a.xt, [['requestFriend', ['WatchedPlayer'], 1]]);
  assert(fw.onWarning('WatchedPlayer not found.'), 'offline answer is ours');
  await wait(40);
  assert(!fw.state.requested.watchedplayer.delivered, 'not delivered while offline');
  eq(fw.due(), ['WatchedPlayer'], 'still due for the next try');
  fw.ask(60000, 20); await wait(40);
  eq(a.xt.length, 2, 'second try');
  assert(fw.state.requested.watchedplayer.delivered && fw.state.requested.watchedplayer.tries === 2, JSON.stringify(fw.state.requested));
  eq(fw.due(), [], 'done');
  assert(!fw.onWarning('WatchedPlayer not found.'), 'late warnings are ignored');
  const again = new FriendWatch(fw.hub, { list: path.join(P.ROOT, 'friendwatch-test.json') });
  again.onLogin(a, 1); await wait(30);
  eq(a.xt.length, 2, 'remembered across restarts');
  fw.stop();
  assert(logs.some((l) => /retried every 20 min/.test(l)), logs.join('|'));
});

test('friend watch: a friend request from WatchedPlayer is accepted, others are not; seen friends are never asked', async () => {
  const { fw, bot } = setup();
  const c = bot('Nova7');
  assert(fw.onRequest(c, 'watchedplayer'));
  eq(c.xt, [['addFriend', ['watchedplayer'], 1]]);
  assert(!fw.onRequest(c, 'randomguy'));
  eq(c.xt.length, 1);
  fw.onPacket(c, pkt('Offline', 'addFriend'));
  eq(fw.due(), [], 'a bot has WatchedPlayer now');
  const a = bot('Sable7');
  fw.onLogin(a, 1); await new Promise((r) => setTimeout(r, 30));
  eq(a.xt.length, 0);
});

test('friend watch: a friend request from one of our own accounts (the owner\'s main) is accepted', async () => {
  const { fw, bot } = setup();
  fw.hub.bots = new Map([['grail26', { id: 'grail26', account: { label: 'GRAIL26', kind: 'guest' } }], ['vexa', { id: 'vexa', account: { label: 'Vexa' } }]]);
  const c = bot('Vexa');
  assert(fw.onRequest(c, 'grail26'));
  eq(c.xt, [['addFriend', ['grail26'], 1]]);
  assert(!fw.onRequest(c, 'randomguy'));
});
