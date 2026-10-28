// Running without Claude (2026-10-27, the owner: "make sure the app can continue without you anymore"): the loop breaker
// (Bot.noteTaskEnd), hub work that never lands in the order queue, settings that put themselves back, raid holds that
// end by themselves, history.jsonl archiving, one pre-fight restart per task, and the admin service's bots watchdog.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Bot } = require('../lib/bot');
const { Hub } = require('../lib/hub');
const { P } = require('../lib/paths');
const { FakeGame } = require('./fakegame');
const logs = require('../lib/logs');
const { Watchdog } = require('../admin/watchdog');

function realBot(id, hub = null) {
  fs.mkdirSync(P.account(id), { recursive: true });
  fs.writeFileSync(path.join(P.account(id), 'login.txt'), `Username: ${id}\nPassword: pw\n`);
  const bot = new Bot(new FakeGame(), { id, label: id, owner: 'test', loginFile: path.join(P.account(id), 'login.txt') }, { hub });
  bot.lines = [];
  bot.journal = (m) => bot.lines.push(m);
  return bot;
}
const ALTEON = () => ({ type: 'assist', id: 'vexa-1', who: 'Vexa', server: 'Swordhaven', map: 'chaosrealm', room: 13579, cell: 'r24', monster: 'Alteon', why: 'helping Vexa with Alteon' });

// The 10-26 flood, replayed: helpTask hands the same call back however often the bot leaves it (the bug that was
// fixed in 1027ff). The loop breaker leaves the call after 6 quick ends and the loop goes on to other work.
test('loop breaker: a help call ending within seconds is left after 6 tries and the bot moves on', async () => {
  const left = [];
  const hub = { settings: {}, helpTask: () => ALTEON(), helpUnreachable: (b, t, why, full) => left.push({ why, full }), notify() {} };
  const bot = realBot('spinloop', hub);
  bot.ensureLogin = async () => true; bot.ensureServer = async () => true; bot.useBoosts = async () => null;
  bot.settings.autoGear = false;
  const ran = [];
  bot.runTask = async (t) => { ran.push(t.type); if (t.type !== 'assist') bot.stopFlag = true; return true; };
  await bot.loop();
  eq(ran.filter((x) => x === 'assist').length, 6, 'six quick assists, then held');
  eq(ran[ran.length - 1], 'farmLevel', 'other work next');
  assert(left.length >= 1 && left.every((x) => x.full === true), JSON.stringify(left));
  assert(bot.lines.some((l) => /^loop breaker: "helping Vexa with Alteon" ended within seconds 6x/.test(l)), bot.lines.join(' | '));
  assert(bot.spinHeld(ALTEON()), 'held');
  assert(!bot.spinHeld({ ...ALTEON(), monster: 'Xan', map: 'xantown' }), 'another call is not held');
});

test('loop breaker: long tasks never count; brain work is skipped; a second loop the same day holds 6 h and alerts', () => {
  const notes = [];
  const bot = realBot('spinbrain', { notify: (title, body) => notes.push(title) });
  const now = Date.now();
  const t = { type: 'script', path: 'Enhancement/X.cs', goal: 'forge-x', brain: true, why: 'forge x' };
  for (let i = 0; i < 10; i++) eq(bot.noteTaskEnd({ ...t, startedAt: now - 25000 }, now), null, 'a 25 s task is work, not a loop');
  let hold = null;
  for (let i = 0; i < 6; i++) hold = bot.noteTaskEnd({ ...t, startedAt: now - 2000 }, now + i * 1000) || hold;
  assert(hold && !hold.long, 'first loop: short hold');
  eq(Math.round((hold.until - now - 5000) / 60000), 30);
  assert(bot.isSkipped(t), 'the brain skips it (bot.skipped)');
  eq(notes.length, 0, 'no alert for the first loop');
  const later = now + 3 * 3600000;
  for (let i = 0; i < 6; i++) hold = bot.noteTaskEnd({ ...t, startedAt: later - 1000 }, later + i * 1000) || hold;
  assert(hold.long, 'second loop within a day: long hold');
  eq(Math.round((hold.until - later - 5000) / 3600000), 6);
  eq(notes.length, 1, 'one alert');
});

test('loop breaker: 20 quick ends of any kind brake the loop', () => {
  const bot = realBot('spinbrake');
  const now = Date.now();
  for (let i = 0; i < 19; i++) bot.noteTaskEnd({ type: 'enhance', why: `chore ${i}`, name: `c${i}`, startedAt: now - 1000 }, now);
  assert(!bot.spinBraking(now), '19: not yet');
  bot.noteTaskEnd({ type: 'enhance', name: 'c19', startedAt: now - 1000 }, now);
  assert(bot.spinBraking(now), '20: brake');
  assert(!bot.spinBraking(now + 11 * 60000), 'the window moves on');
});

test('hub work: never an order - stale crew seats and ended calls leave the queue, live calls and orders stay', () => {
  const hub = { crew: { id: 'crew-now' }, helpById: (id) => (id === 'live-call' ? { id } : null), notify() {} };
  const bot = realBot('hubwork', hub);
  bot.queue = [
    { type: 'script', path: 'SeraphUltras/ChallengeBosses/Flibbitiestgibbetv3.cs', crewScript: true, crew: 'crew-NSoDDaily-old', waitGold: 3000000, why: 'crew daily NSoDDaily: old seat' },
    { type: 'script', path: 'x.cs', crewScript: true, crew: 'crew-now', why: 'this round' },
    { type: 'daily', name: 'NSoDDaily', brain: true, crew: 'crew-old', why: 'crew turn-in' },
    { ...ALTEON(), id: 'dead-call' },
    { ...ALTEON(), id: 'live-call' },
    { type: 'script', path: 'the owner/order.cs', why: 'an order from the dashboard' },
  ];
  eq(bot.purgeStaleQueue(), 2);
  eq(bot.queue.map((q) => q.id || q.crew || q.path), ['crew-now', 'crew-old', 'live-call', 'the owner/order.cs']);
  // A stop: an order goes back, a crew seat never, a help call only while it is open.
  assert(bot.requeueable({ type: 'script', path: 'the owner/order.cs' }));
  assert(!bot.requeueable({ type: 'crewHunt', crew: 'crew-now' }), 'crew: never (a stopped member re-ran a finished fight)');
  assert(bot.requeueable({ ...ALTEON(), id: 'live-call' }), 'back to the open call after a reconnect');
  assert(!bot.requeueable({ ...ALTEON(), id: 'dead-call' }));
  // The gold rule's requeue: orders only.
  bot.queue = [];
  bot.afterOrder({ type: 'script', path: 'x.cs', crewScript: true, crew: 'crew-now' }, { goldWait: 3000000 });
  eq(bot.queue.length, 0, 'a crew seat is not queued to wait for gold');
  bot.afterOrder({ type: 'script', path: 'the owner/order.cs' }, { goldWait: 3000000 });
  eq(bot.queue.length, 1);
  eq(bot.queue[0].waitGold, 3000000);
});

test('settings.until: a setting changed for a while goes back by itself', () => {
  const bot = realBot('tempset');
  const now = Date.parse('2026-11-10T12:00:00Z');
  Object.assign(bot.settings, { maxEventHours: 4, minEventLevel: 30, extra: 1, until: { maxEventHours: { at: '2026-11-10', back: 2 }, minEventLevel: { at: '2026-11-10', back: 75 }, extra: { at: '2026-11-11', back: null } } });
  eq(bot.expireSettings(now - 13 * 3600000), 0, 'not yet');
  eq(bot.expireSettings(now), 2);
  eq([bot.settings.maxEventHours, bot.settings.minEventLevel], [2, 75]);
  eq(Object.keys(bot.settings.until), ['extra']);
  eq(bot.expireSettings(now + 86400000), 1);
  assert(!('extra' in bot.settings) && !('until' in bot.settings), 'removed, and the empty until with it');
  assert(bot.lines.some((l) => /setting maxEventHours back to 2/.test(l)));
});

function raidHub(settings) {
  const h = Object.create(Hub.prototype);
  h.settings = settings;
  h.infos = []; h.notes = []; h.saved = 0;
  h.info = (m) => h.infos.push(m);
  h.notify = (t) => h.notes.push(t);
  h.saveSettings = () => { h.saved++; };
  return h;
}

test('raid holds end by themselves: 14 days, then 2 lost fights hold it again for twice as long', () => {
  const day = 86400000;
  const t0 = Date.parse('2026-10-27T00:00:00Z');
  const h = raidHub({ raidHold: ['ultra-nulgath', 'ultra-tyndarius'] });
  eq([...h.raidHeld(t0)], ['ultra-nulgath', 'ultra-tyndarius'], 'held from the first look on');
  h.settings.raidHoldMeta['ultra-tyndarius'].forever = true;
  eq([...h.raidHeld(t0 + 13 * day)], ['ultra-nulgath', 'ultra-tyndarius']);
  eq([...h.raidHeld(t0 + 14 * day)], ['ultra-tyndarius'], 'Nulgath is back in the raids; forever stays');
  eq(h.notes, ['Ultra hold ended: ultra-nulgath']);
  const r = (extra = {}) => ({ boss: 'ultra-nulgath', name: 'Ultra Nulgath', attempts: [{ outcome: 'wipe' }], ...extra });
  eq(h.raidHoldResult(r({ memberLeft: 'valen7' }), false, t0 + 15 * day), null, 'a member who left is no verdict');
  eq(h.raidHoldResult(r({ attempts: [] }), false, t0 + 15 * day), null, 'a call-off without a fight is no verdict');
  eq(h.raidHoldResult(r({ plan: true }), false, t0 + 15 * day), null, "the owner's own line-up is no verdict");
  eq(h.raidHoldResult(r(), false, t0 + 15 * day), 'lost');
  eq(h.raidHoldResult(r(), false, t0 + 16 * day), 'held');
  eq(h.settings.raidHold.includes('ultra-nulgath'), true);
  eq(h.settings.raidHoldMeta['ultra-nulgath'].days, 28);
  eq(h.raidHeld(t0 + 16 * day + 27 * day).has('ultra-nulgath'), true, 'held 28 days');
  eq(h.raidHeld(t0 + 16 * day + 28 * day).has('ultra-nulgath'), false);
  eq(h.raidHoldResult(r(), true, t0 + 45 * day), 'killed');
  eq(h.settings.raidHoldMeta['ultra-nulgath'], undefined, 'a kill ends the watch');
});

test('history.jsonl over its limit: old lines move to a .gz, recent ones stay', () => {
  const dir = path.join(process.env.SERAPH_ROOT, 'histarchive');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.parse('2026-10-27T00:00:00Z');
  const old = Array.from({ length: 50 }, (_, i) => JSON.stringify({ t: now - 90 * 86400000 + i, type: 'drop', item: `old ${i}` }));
  const fresh = Array.from({ length: 20 }, (_, i) => JSON.stringify({ t: now - 86400000 + i, type: 'drop', item: `new ${i}` }));
  fs.writeFileSync(path.join(dir, 'history.jsonl'), [...old, ...fresh].join('\n') + '\n');
  eq(logs.archiveHistory(dir, now, { historyMax: 10 ** 9 }), false, 'under the limit: untouched');
  eq(logs.archiveHistory(dir, now, { historyMax: 100 }), true);
  const left = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').split('\n').filter(Boolean);
  eq(left.length, 20);
  const gz = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'history-2026-10-27.jsonl.gz'))).toString().split('\n').filter(Boolean);
  eq(gz.length, 50);
  eq(logs.archiveHistory(dir, now, { historyMax: 100 }), false, 'nothing old left to move');
});

test('pre-fight switch: one restart per task in 20 min', async () => {
  const h = Object.create(Hub.prototype);
  const now = Date.now();
  const bot = { current: { type: 'script', path: 'Enhancement/UnlockForgeEnhancements.cs', startedAt: now - 600000 }, taskKey: (t) => t.path, client: { w: { strFrame: 'r9', monsters: [{ strMonName: 'Avatar Tyndarius', strFrame: 'r9', intState: 1 }] } } };
  bot._preSwitch = { key: bot.current.path, at: now - 5 * 60000 };
  eq(await h.preFightTick(bot, now), null, 'a switch 5 min ago: the death ladder decides now');
});

test('bots watchdog: crash loops, a failed service and a hung process reach the owner; a stopped service is left alone', async () => {
  let t = 0; let state = 'active'; let restarts = 0; let api = true; const said = []; const ran = [];
  const wd = new Watchdog({
    now: () => t, log: () => null, say: (title) => said.push(title), ping: async () => api,
    run: async (cmd, args) => { ran.push([cmd, ...args].join(' ')); return cmd === 'systemctl' ? { ok: true, out: `ActiveState=${state}\nNRestarts=${restarts}\n` } : { ok: true, out: '' }; },
  });
  await wd.tick();
  for (let i = 0; i < 3; i++) { t += 5 * 60000; restarts++; await wd.tick(); }
  eq(said, ['Seraph bots keep crashing']);
  t += 60000; restarts++; await wd.tick();
  eq(said.length, 1, 'one alert per problem in 6 h');
  state = 'inactive'; api = false; t += 60 * 60000; await wd.tick(); t += 60 * 60000; await wd.tick();
  eq(said.length, 1, 'stopped by hand: no alert, no restart');
  state = 'active';
  await wd.tick();
  t += 10 * 60000; await wd.tick();
  eq(said[1], 'Seraph bots not answering');
  t += 10 * 60000; await wd.tick();
  eq(said[2], 'Seraph bots restarted by the watchdog');
  assert(ran.some((c) => c === 'sudo -n systemctl restart seraph-bots'), ran.join(' | '));
  t += 30 * 60000; await wd.tick();
  eq(ran.filter((c) => c.startsWith('sudo')).length, 1, 'at most one restart in 2 h');
  state = 'failed'; t += 60000; await wd.tick();
  eq(said[said.length - 1], 'Seraph bots service failed');
});
