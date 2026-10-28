// The owner's gold rule (2026-10-15): a script that starts grinding gold stops, its work waits until the gold is there,
// and only runs with goldOk (farming the gold itself) when nothing else is left.

function goldBot(gold) {
  const journal = [];
  return {
    journal, id: 'goldtest', gold_: gold, journal_: journal,
    goldNow() { return this.gold_; },
    taskKey(t) { return [t.type, t.path || '', t.entry || '', t.args || '', t.name || '', t.goal || '', t.event || ''].join('|'); },
  };
}

test('gold rule: a gold stop is no failure, waits for the gold, then frees the task', async () => {
  const { Brain } = require('../lib/brain');
  const brain = Object.create(Brain.prototype);
  const st = { goalFails: {} };
  brain.state = () => st;
  brain.saveState = () => {};
  brain.today = () => ({ goalsToday: {}, dailies: {}, goalChunks: 0 });
  const lines = [];
  const bot = goldBot(1000000);
  bot.journal = (m) => lines.push(m);
  const task = { type: 'script', path: 'Nation/AFDL/0DoAll.cs', goal: 'archfiend-doomlord', brain: true, startedAt: Date.now() };
  await brain.done(bot, task, { ok: true, goldWait: 12500000 });
  eq(st.goalFails['archfiend-doomlord'], undefined, 'not a failure');
  assert(brain.goldShort(bot, { ...task, startedAt: 0 }), 'waits below the gold');
  bot.gold_ = 13000000;
  assert(!brain.goldShort(bot, task), 'free once the gold is there');
  assert(!st.goldWait[bot.taskKey(task)], 'entry cleared');
  assert(lines.some((l) => /can run again/.test(l)), 'journals it');
});

test('gold rule: bot.isSkipped holds gold-waiting work, except the goldOk last resort', () => {
  const { Bot } = require('../lib/bot');
  const self = { skipped: null, taskKey: (t) => t.goal, brain: { goldShort: () => true } };
  assert(Bot.prototype.isSkipped.call(self, { goal: 'x' }), 'skipped while short');
  assert(!Bot.prototype.isSkipped.call(self, { goal: 'x', goldOk: true }), 'goldOk runs');
});

test('gold rule: an order that stopped for gold goes back in the queue and waits', () => {
  const { Bot } = require('../lib/bot');
  const self = { queue: [], save() {}, goldNow: () => 100, crowdBlocked: () => false };
  Bot.prototype.afterOrder.call(self, { type: 'script', path: 'x.cs', startedAt: 1 }, { ok: true, goldWait: 5000 });
  eq(self.queue.length, 1, 'requeued');
  eq(self.queue[0].waitGold, 5000, 'with its gold');
  eq(Bot.prototype.nextOrder.call(self), undefined, 'not picked while short');
  self.goldNow = () => 6000;
  eq(Bot.prototype.nextOrder.call(self).path, 'x.cs', 'picked with the gold');
});

// 2026-10-19: ultra focus paused AFDL, yet step 8 farmed and spent its 12.5 M; and Oren's Valiance (25 M) was about
// to spend the 22 M he was saving for King's Echo (50 M, the ultra caster seat).
test('gold rule: step 8 skips paused goals and keeps savings for an earlier requiresGold goal', async () => {
  const { Brain } = require('../lib/brain');
  const brain = Object.create(Brain.prototype);
  const st = { goalFails: {}, goldWait: {
    a: { gold: 12500000, at: 1, label: 'archfiend-doomlord', task: { type: 'script', path: 'AFDL.cs', goal: 'archfiend-doomlord' } },
    v: { gold: 25000000, at: 2, label: 'forge-valiance', task: { type: 'script', path: 'Forge.cs', entry: 'HerosValiance', goal: 'forge-valiance' } },
  } };
  brain.state = () => st;
  brain.goalReady = async (bot, goal) => goal.id === 'kings-echo';
  const bot = { gold: async () => 22000000 };
  const goals = [{ id: 'kings-echo', label: "King's Echo", script: 'KE.cs', requiresGold: 50000000 }, { id: 'forge-valiance', script: 'Forge.cs' }, { id: 'archfiend-doomlord', script: 'AFDL.cs' }];
  let t = await brain.goldStep(bot, { goals, paused: ['archfiend-doomlord'] }, 100, {});
  eq(t.type, 'kill', 'plain gold farming, not Valiance');
  assert(/saving gold for King's Echo: 22 of 50 M/.test(t.why), t.why);
  brain.goalReady = async () => false;   // KE owned
  t = await brain.goldStep(bot, { goals, paused: ['archfiend-doomlord'] }, 100, {});
  eq(t.goal, 'forge-valiance', 'then the first wait that is not paused');
  t = await brain.goldStep(bot, { goals, paused: ['archfiend-doomlord', 'forge-valiance'] }, 100, {});
  eq(t.why, 'level 100 - farming gold');
});
