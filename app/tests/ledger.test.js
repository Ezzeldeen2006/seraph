// Phase 3 of the 2026-09-28 overhaul: the ledger (lib/ledger.js) - attempts and what they gained, holds that survive
// a restart (bot.skipped used to live in memory only), the back-off for work that gains nothing, and the reasons.
const fs = require('fs');
const path = require('path');
const { Ledger, Holds, BACKOFF_BASE_MS, BACKOFF_MAX_MS } = require('../lib/ledger');
const { Brain } = require('../lib/brain');
const { P } = require('../lib/paths');

const tmpFile = () => { const d = path.join(process.env.SERAPH_ROOT, 'ledger', Math.random().toString(36).slice(2, 8)); fs.mkdirSync(d, { recursive: true }); return path.join(d, 'ledger.json'); };

test('ledger: attempts, the run of "nothing gained", routes and the back-off schedule', async () => {
  const L = new Ledger(tmpFile());
  L.attempt('k', { outcome: 'nothing', minutes: 3, route: 'fj-cryomancer' });
  eq(L.item('k').nothingRun, 1);
  L.attempt('k', { outcome: 'nothing', minutes: 2, route: 'fj-cryomancer' });
  eq(L.item('k').nothingRun, 2);
  L.attempt('k', { outcome: 'stopped', minutes: 5 });
  eq(L.item('k').nothingRun, 2, 'a stopped try neither counts nor resets');
  L.attempt('k', { outcome: 'progress', minutes: 30, xp: 500000, items: 2, route: 'fj-cryomancer' });
  eq(L.item('k').nothingRun, 0, 'progress resets it');
  const r = L.data.routes['fj-cryomancer'];
  eq([r.runs, r.minutes, r.xp, r.xpPerHour], [3, 35, 500000, Math.round(500000 / (35 / 60))]);
  eq([Ledger.backoffMs(1), Ledger.backoffMs(2), Ledger.backoffMs(3), Ledger.backoffMs(4), Ledger.backoffMs(20)], [0, BACKOFF_BASE_MS, 2 * BACKOFF_BASE_MS, 4 * BACKOFF_BASE_MS, BACKOFF_MAX_MS]);
  for (let i = 0; i < 30; i++) L.attempt('k', { outcome: 'nothing' });
  eq(L.item('k').attempts.length, 20, 'the last 20 attempts are kept');
  L.flush();
});

test('ledger: holds survive a restart through bot.skipped (the same Map interface), with their reasons', async () => {
  const file = tmpFile();
  const L = new Ledger(file);
  const skipped = new Holds(L);
  skipped.why = 'stuck twice at "Killing X"';
  skipped.set('script|a.cs', Date.now() + 3600000);
  skipped.set('script|b.cs', Date.now() + 60000);
  skipped.set('script|old.cs', Date.now() - 1000);
  skipped.delete('script|b.cs');
  L.flush();
  const again = new Holds(new Ledger(file));
  eq([...again.keys()], ['script|a.cs'], 'only live holds come back');
  const sum = again.ledger.summary();
  eq(sum.held.map((h) => [h.key, h.why]), [['script|a.cs', 'stuck twice at "Killing X"']]);
  again.clear();
  eq(again.ledger.summary().held, [], 'clear releases them in the ledger too');
});

test('ledger: parks already in brain.json are explained on first load, once', async () => {
  const L = new Ledger(tmpFile());
  const now = Date.now();
  const n = L.migrate({ goalFails: { 'farmer-joe': 3, 'blade-of-awe': 1 }, goalFailAt: { 'farmer-joe': now - 3600000 }, rankFails: { Shaman: { n: 2, at: now - 60000 } }, wishFails: { 'Pirate Coat': { n: 2, at: now - 3600000 } } }, now);
  eq(n, 3);
  eq(L.summary(now).held.map((h) => h.key).sort(), ['goal:farmer-joe', 'rank:Shaman', 'wish:Pirate Coat']);
  eq(L.migrate({ goalFails: { x: 5 } }, now), 0, 'only once');
});

function brainBot(brain) {
  const id = `ledg${Math.random().toString(36).slice(2, 7)}`;
  fs.mkdirSync(P.account(id), { recursive: true });
  const bot = { id, dir: P.account(id), settings: {}, lastLog: [], journal(m) { this.lastLog.push(m); }, stats: { quests: 0, drops: 0, kills: 0, deaths: 0, xp: 0 }, itemProgress: 0 };
  bot.taskKey = (t) => [t.type, t.path || '', t.goal || ''].join('|');
  bot.progressMark = function () { return { at: Date.now(), items: this.itemProgress, quests: this.stats.quests, drops: this.stats.drops, kills: this.stats.kills, deaths: this.stats.deaths, xp: this.stats.xp }; };
  bot.gainedSince = function (m) { const n = this.progressMark(); return { minutes: 1, items: n.items - m.items, quests: n.quests - m.quests, drops: n.drops - m.drops, kills: n.kills - m.kills, deaths: n.deaths - m.deaths, xp: n.xp - m.xp }; };
  bot.ledger = Ledger.forBot(bot);
  bot.skipped = new Holds(bot.ledger);
  bot.owns = async () => false;
  return bot;
}
const started = (bot, t) => { Object.defineProperty(t, '_mark', { value: bot.progressMark(), enumerable: false, writable: true }); t.startedAt = Date.now() - 10 * 60000; return t; };

test('brain: a script that finishes twice in a row without gaining anything rests (30 min, doubling), and says why', async () => {
  const brain = new Brain();
  const bot = brainBot(brain);
  const task = () => started(bot, { type: 'script', brain: true, path: 'Scripts/Story/Cryo.cs', goal: 'fj-cryomancer', why: 'Farmer Joe step: Cryomancer' });
  await brain.done(bot, task(), { ok: true });
  eq(bot.isSkippedKey ? 0 : bot.skipped.size, 0, 'one empty run is fine');
  await brain.done(bot, task(), { ok: true });
  const key = bot.taskKey({ type: 'script', path: 'Scripts/Story/Cryo.cs', goal: 'fj-cryomancer' });
  const until = bot.skipped.get(key);
  assert(until && Math.abs(until - Date.now() - BACKOFF_BASE_MS) < 5000, `rested 30 min: ${until && until - Date.now()}`);
  assert(bot.lastLog.some((l) => /finished 2x in a row without gaining anything - resting it 30 min/.test(l)), bot.lastLog.join(' | '));
  eq(bot.ledger.held(key).why, 'finished 2x in a row without gaining anything');
  await brain.done(bot, task(), { ok: true });
  assert(Math.abs(bot.skipped.get(key) - Date.now() - 2 * BACKOFF_BASE_MS) < 5000, 'third: 1 h');
  const t = task();
  bot.stats.xp += 90000;                         // this one gained XP
  await brain.done(bot, t, { ok: true });
  eq(bot.ledger.item(key).nothingRun, 0, 'progress resets the run');
  const lf = task();
  await brain.done(bot, { ...lf, recurring: 'loo', _mark: lf._mark }, { ok: true });
  bot.ledger.flush();
});

test('brain: parks and failures land in the ledger with a reason; "try parked work again" clears them', async () => {
  const brain = new Brain();
  const bot = brainBot(brain);
  const t = started(bot, { type: 'script', brain: true, path: 'Scripts/Other/Dread.cs', goal: 'archpaladin', why: 'ArchPaladin' });
  brain.park(bot, t, 'Killing SUPER Dreadhaven General for item: Medal 0/1');
  const key = bot.taskKey(t);
  const h = bot.ledger.held(key);
  assert(h && /stuck twice at "Killing SUPER Dreadhaven General/.test(h.why), JSON.stringify(h));
  eq(bot.ledger.item(key).attempts.slice(-1)[0].outcome, 'parked');
  for (let i = 0; i < 3; i++) brain.goalFailed(bot, 'blade-of-awe');
  assert(bot.ledger.held('goal:blade-of-awe'), 'three failed tries show as a hold');
  const sum = (await brain.ahead(Object.assign(bot, { running: true, level: async () => 60, unrankedClasses: async () => [], playing: async () => false, current: null, queue: [] }))).ledger;
  assert(sum && sum.held.length === 2, JSON.stringify(sum));
  brain.retry(bot);
  eq(bot.ledger.summary().held, [], 'retry clears every hold');
});

test('bot: a real Bot keeps its holds across a restart (the ledger file)', async () => {
  const { Bot } = require('../lib/bot');
  const { FakeGame } = require('./fakegame');
  const id = `ledbot${Math.random().toString(36).slice(2, 6)}`;
  fs.mkdirSync(P.account(id), { recursive: true });
  const b1 = new Bot(new FakeGame({ level: 50 }), { id, label: id });
  b1.skipped.why = 'test';
  b1.skipped.set('script|x.cs|', Date.now() + 3600000);
  b1.ledger.flush();
  delete b1._ledger;
  const b2 = new Bot(new FakeGame({ level: 50 }), { id, label: id });
  assert(b2.isSkipped({ type: 'script', path: 'x.cs' }) || b2.skipped.has('script|x.cs|'), `restored: ${[...b2.skipped.keys()]}`);
});
