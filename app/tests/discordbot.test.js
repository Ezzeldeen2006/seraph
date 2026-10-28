const { DiscordBot } = require('../lib/discordbot');

// 2026-10-09: a missed heartbeat ack reconnects at once, without waiting for the dead socket's close event.
test('discord: a missed heartbeat ack opens a new connection at once; the old socket\'s late close is ignored', async () => {
  const made = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 1; this.l = {}; this.sent = []; this.closed = null; made.push(this); }
    addEventListener(k, f) { this.l[k] = f; }
    send(m) { this.sent.push(JSON.parse(m)); }
    close(code) { this.closed = code; }   // a dead link: no 'close' event follows
  }
  const realWS = global.WebSocket;
  global.WebSocket = FakeWS;
  const logs = [];
  const bot = new DiscordBot({}, { token: 't' }, (m) => logs.push(m));
  try {
    bot.connect();
    eq(made.length, 1);
    made[0].l.message({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 30 } }) });
    await new Promise((r) => setTimeout(r, 1200));   // beat 1 sent, beat 2 finds no ack -> reconnect after 1 s
    eq(made[0].closed, 4000, 'the dead socket was dropped');
    assert(logs.some((m) => /no heartbeat ack - reconnecting/.test(m)), logs.join(' | '));
    eq(made.length, 2, 'a new socket at once, not after the close event');
    made[0].l.close({ code: 1006 });
    await new Promise((r) => setTimeout(r, 50));
    eq(made.length, 2, 'the old socket closing late starts nothing');
    assert(!logs.some((m) => /disconnected \(1006\)/.test(m)), 'no reconnect from the stale socket');
  } finally { bot.stop(); global.WebSocket = realWS; }
});

test('discord DMs: only what the owner needs reaches his phone; the rest goes to the channel (2026-10-28)', () => {
  const { dmWanted, Discord } = require('../lib/discord');
  for (const k of ['friend:watchedplayer', 'playerwatch:watchedplayer', 'dm:party:offline:game.swf', 'watchdog:Seraph bots crashed', 'dm:game:4001', 'dm:engine:abc', 'dm:swap:abc', 'dm:bridge:x'])
    assert(dmWanted(k), `kept: ${k}`);
  for (const k of ['dm:weekly:ultra-gramiel', 'boss:nova7:Admiral Zheng', 'dm:mainparty:grail26:Nightmare Carnax', 'dm:mainpark:grail26:x', 'dm:flash-on:1', 'dm:Possible free ACs'])
    assert(!dmWanted(k), `channel: ${k}`);
  assert(dmWanted('dm:weekly:x', { dmAll: true }), 'dmAll brings everything back');
  const d = new Discord();
  d.cfg = { webhook: 'https://discord.com/api/webhooks/1/x', token: 't' };
  d.pump = () => {};
  d.send('⚠️ **Ultra Gramiel** is still open this week', { kind: 'alert', key: 'dm:weekly:ultra-gramiel', dm: true });
  eq(d.queue[0].dm, false, 'the weekly board goes to the channel');
  d.send('🟢 WatchedPlayer just came online', { kind: 'friend', key: 'friend:watchedplayer', dm: true });
  eq(d.queue[1].dm, true, 'the watched player still DMs');
});
