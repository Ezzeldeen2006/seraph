// Second ways to a boss's items (lib/bossroutes.js, the owner 2026-10-20: Nulgath beat the main's whole class ladder on
// ArchMage's Mortal Coil, which 4 Roentgenium of Nulgath also buy).
const fs = require('fs');
const os = require('os');
const path = require('path');
const bossroutes = require('../lib/bossroutes');
const { Hub } = require('../lib/hub');

const STEP = '(_KillForItem) Farming The Mortal Coil (0/1)';

function fakeHub() {
  const hub = { notes: [], notify(t, b) { this.notes.push(t); }, soloBosses: () => ({}), discord: null, brain: null };
  for (const k of ['takeRoute', 'mainNeedsParty']) hub[k] = Hub.prototype[k].bind(hub);
  return hub;
}
function fakeBot() {
  const b = {
    id: 'grail26', account: { label: 'GRAIL26' }, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'routes-')),
    current: { type: 'script', path: 'Other/Classes/ArchMage/0ArchMage.cs' }, scriptStepRaw: STEP, journals: [],
    journal(m) { this.journals.push(m); }, restarts: 0, restart() { this.restarts++; }, stopped: false, stop() { this.stopped = true; },
    taskKey: (t) => `${t.type}|${t.path}`,
  };
  return b;
}

test('bossroutes: a route only for the boss on a step that farms its item', () => {
  eq(bossroutes.routeFor('Nulgath', STEP).boss, 'Nulgath');
  eq(bossroutes.routeFor('nulgath', '(KillMonster) Killing Nulgath for item: "The Mortal Coil" 0/1').items, ['The Mortal Coil']);
  eq(bossroutes.routeFor('Nulgath', '(_KillForItem) Farming Nulgath Insignia (0/5)'), null, 'another Nulgath item: no route');
  eq(bossroutes.routeFor('Azalith', STEP), null, 'another boss');
});

test('bossroutes: enable writes "<boss> <until>" lines the C# fix reads, and they run out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
  const now = 1_000_000;
  eq(bossroutes.enable(dir, { boss: 'Nulgath', days: 14 }, now), true);
  eq(fs.readFileSync(bossroutes.file(dir), 'utf8'), `Nulgath ${now + 14 * 86400000}\n`);
  eq(bossroutes.enable(dir, { boss: 'Nulgath', days: 14 }, now + 1), false, 'already on');
  eq(Object.keys(bossroutes.active(dir, now + 15 * 86400000)), [], 'expired');
});

test('bossroutes: the main takes the long way instead of stopping, once', () => {
  const hub = fakeHub();
  const bot = fakeBot();
  hub.mainNeedsParty(bot, { name: 'Nulgath' }, 3);
  eq([bot.stopped, bot.restarts], [false, 1], 'restarted, not stopped');
  assert(bossroutes.active(bot.dir).Nulgath, 'route on');
  assert(bot.journals.some((j) => /another way/.test(j)));
  hub.mainNeedsParty(bot, { name: 'Nulgath' }, 3);
  eq([bot.stopped, bot.restarts], [false, 2], 'route already on and still dying to it: the task rests 6 h, no stop (the owner 2026-10-25)');
});

test('bossroutes: no route for an item without one - the main rests that task and goes on, never stops', () => {
  const hub = fakeHub();
  const bot = fakeBot();
  bot.taskKey = (t) => `${t.type}|${t.path}`;
  bot.scriptStepRaw = '(_KillForItem) Farming The Divine Will (0/1)';
  hub.mainNeedsParty(bot, { name: 'Azalith' }, 3);
  eq([bot.stopped, bot.restarts], [false, 1]);
  assert(bot.skipped.get('script|Other/Classes/ArchMage/0ArchMage.cs') > Date.now() + 5 * 3600000);
});
