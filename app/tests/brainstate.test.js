// Phase 3 of the 2026-09-28 overhaul: the brain's state model. Dry runs (the dashboard's plan ahead every 20 s, the
// pre-emption check while a script runs) used to snapshot brain.json, await next() for seconds and put the snapshot
// back - dropping a park, a finished daily or event time the running task wrote in the meantime.
const fs = require('fs');
const { Brain } = require('../lib/brain');
const { P } = require('../lib/paths');

function fakeBot() {
  const id = `dry${Math.random().toString(36).slice(2, 7)}`;
  fs.mkdirSync(P.account(id), { recursive: true });
  return { id, settings: {}, running: true, journal() {} };
}

test('brain: a dry run works on its own copy and never undoes a real change made meanwhile', async () => {
  const brain = new Brain();
  const bot = fakeBot();
  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = {};
  const p = brain.dryRun(bot, async () => {
    brain.today(bot).eventMs = 999;
    brain.state(bot).dryMark = true;
    brain.saveState(bot);
    await gate;                                   // seconds of game reads, as in a real next()
    await new Promise((r) => setTimeout(r, 5));
    seen.fails = brain.state(bot).goalFails;      // still the copy after awaits
    return { type: 'wait' };
  });
  // Meanwhile the running task parks a goal and books event time: the real state.
  brain.state(bot).goalFails = { 'farmer-joe': 3 };
  brain.today(bot).eventMs = 1200;
  brain.saveState(bot);
  release();
  eq(await p, { type: 'wait' });
  eq(seen.fails, {}, 'the dry run saw its own copy, taken before the park');
  eq(brain.state(bot).goalFails, { 'farmer-joe': 3 }, 'the park survived');
  eq(brain.today(bot).eventMs, 1200, 'so did the event time');
  eq(brain.state(bot).dryMark, undefined, 'the dry run changed nothing real');
  const disk = JSON.parse(fs.readFileSync(brain.stateFile(bot), 'utf8'));
  eq([disk.goalFails, disk.dryMark], [{ 'farmer-joe': 3 }, undefined], 'nor on disk');
});

test('brain: plan ahead and pre-emption use the isolated dry run', async () => {
  const brain = new Brain();
  const bot = fakeBot();
  bot.settings.autopilot = true;
  bot.level = async () => 90;
  bot.unrankedClasses = async () => [];
  bot.playing = async () => false;
  bot.current = null; bot.queue = [];
  brain.plan = async () => null;
  let during = null;
  brain.next = async (b) => {
    brain.state(b).fromDry = 1;
    brain.saveState(b);
    during = brain.state(b);
    return { type: 'wait', why: 'dry' };
  };
  const real = brain.state(bot);
  const a = await brain.ahead(bot);
  eq(a.brainNext, { type: 'wait', why: 'dry' });
  assert(during !== real, 'next() got a copy');
  assert(brain.state(bot) === real && real.fromDry === undefined, 'the real state object is untouched and still in place');
});
