// Overseer (local AI brain) with a fake model: decisions are validated, applied (autopilot) or proposed (advisor).
const fs = require('fs');
const path = require('path');
const { FakeGame } = require('./fakegame');
const { Bot } = require('../lib/bot');
const { Brain } = require('../lib/brain');
const { P } = require('../lib/paths');
const { Overseer, systemPrompt } = require('../lib/overseer');

async function party() {
  const brain = new Brain();
  const hub = { bots: new Map(), settings: { assist: { enabled: false, main: 'GRAIL26', members: [] } }, brain, notified: [], saveSettings() {}, notify(t, b) { this.notified.push([t, b]); }, bot(id) { return this.bots.get(id) || null; }, setAssist(p) { Object.assign(this.settings.assist, p); return this.settings.assist; } };
  brain.hub = hub;
  for (const [id, persona] of [['seraphx', 'sable7'], ['nyxx', 'nova7']]) {
    const dir = P.account(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'login.txt'), `Username: ${id}\nPassword: pw\n`);
    const bot = new Bot(new FakeGame({ level: 20 }), { id, label: id, username: id, loginFile: path.join(dir, 'login.txt'), persona, status: 'active' }, { brain, hub });
    await bot.login();
    hub.bots.set(id, bot);
  }
  return hub;
}

test('overseer: thinks with a snapshot, applies only allowed actions in autopilot', async () => {
  const hub = await party();
  let seen = null;
  const o = new Overseer(hub, {
    llm: async (prompt) => {
      seen = prompt;
      return { data: { thoughts: 'Nova keeps dying, slow her down.', nextThinkMinutes: 7, actions: [
        { action: 'setting', bot: 'nyxx', key: 'giveUpDeaths', value: 2, why: 'dying too much' },
        { action: 'queue', bot: 'seraphx', task: { type: 'script', path: 'Good/ArchPaladin.cs', hours: 9 }, why: 'get AP' },
        { action: 'queue', bot: 'seraphx', task: { type: 'eval', fn: 'x' }, why: 'hack' },
        { action: 'queue', bot: 'seraphx', task: { type: 'script', path: '../../evil.cs' }, why: 'escape' },
        { action: 'setting', bot: 'nyxx', key: 'password', value: 'x', why: 'no' },
        { action: 'assist', enabled: true, why: 'I want to' },
        { action: 'pauseGoal', bot: 'nyxx', goal: 'chaos-slayer', why: 'stuck' },
        { action: 'note', text: 'Nova dies at deathpits at level 10', why: 'remember' },
      ] } };
    },
  });
  const row = await o.think('test');
  assert(/"nyxx"/.test(seen) && /PARTY STATE/.test(seen), 'snapshot sent');
  const r = Object.fromEntries(row.actions.map((a, i) => [i, a.result]));
  eq(r[0], 'set'); eq(hub.bot('nyxx').settings.giveUpDeaths, 2);
  eq(r[1], 'queued'); eq(hub.bot('seraphx').queue[0].hours, 4, 'script hours capped');
  assert(/not allowed/.test(r[2]), r[2]);
  assert(/not found/.test(r[3]), r[3]);
  assert(/not allowed/.test(r[4]), r[4]);
  assert(/only changes when the owner asks/.test(r[5]), r[5]);
  eq(hub.settings.assist.enabled, false, 'assist untouched');
  eq(r[6], 'goal paused');
  assert(hub.brain.goals(hub.bot('nyxx')).paused.includes('chaos-slayer'));
  eq(r[7], 'remembered');
  assert(o.nextThinkAt > Date.now() + 6 * 60000, 'uses the model\'s next think time');
});

test('overseer: advisor mode proposes, the owner approves; chat can switch assist on', async () => {
  const hub = await party();
  const o = new Overseer(hub, { llm: async (_p, opts) => (opts.schema.required.includes('reply')
    ? { data: { reply: 'Sending Sable to help you.', actions: [{ action: 'assist', enabled: true, members: ['seraphx'], why: 'the owner asked' }] } }
    : { data: { thoughts: 'Queue enhance.', actions: [{ action: 'queue', bot: 'nyxx', task: { type: 'enhance' }, why: 'gear behind' }] } }) });
  o.setCfg({ mode: 'advisor' });
  await o.think('test');
  eq(hub.bot('nyxx').queue.length, 0, 'nothing applied yet');
  eq(o.proposals.length, 1);
  eq(await o.approve(o.proposals[0].id), 'queued');
  eq(hub.bot('nyxx').queue[0].type, 'enhance');
  const reply = await o.chat('have Sable help me with ultras');
  eq(Overseer.isCommand('How do I get Lord of Order?'), false);
  eq(Overseer.isCommand('why is nova dying?'), false);
  eq(Overseer.isCommand('Send everyone to level up for an hour'), true);
  eq(Overseer.isCommand('can you pause nova?'), true);
  eq(reply.text, 'Sending Sable to help you.');
  eq(hub.settings.assist.enabled, true, 'chat command applied');
  eq(o.history('chat.jsonl', 5).slice(-2).map((m) => m.role), ['owner', 'overseer']);
});

test('overseer: rejects "continue what you are doing" duplicates from small models', async () => {
  const hub = await party();
  const b = hub.bot('nyxx');
  b.queue = []; hub.bot('seraphx').queue = [];
  b.current = { type: 'farmLevel', to: 100 };
  hub.brain.today(b).dailies.EldersBlood = 'done';
  const o = new Overseer(hub, { llm: async () => ({ data: { thoughts: 'All fine, continue.', actions: [
    { action: 'queue', bot: 'nyxx', task: { type: 'farmLevel', to: 100, minutes: 30 }, why: 'continue leveling' },
    { action: 'queue', bot: 'nyxx', task: { type: 'daily', name: 'EldersBlood' }, why: 'continue daily' },
    { action: 'queue', bot: 'seraphx', task: { type: 'daily', name: 'SparrowsBlood' }, why: 'do the daily' },
    { action: 'queue', bot: 'seraphx', task: { type: 'enhance' }, why: 'gear' },
    { action: 'queue', bot: 'seraphx', task: { type: 'enhance' }, why: 'gear again' },
  ] } }) });
  const row = await o.think('test');
  const r = row.actions.map((a) => a.result);
  assert(/already doing/.test(r[0]), r[0]);
  assert(/already done today/.test(r[1]), r[1]);
  assert(/rule brain already/.test(r[2]), r[2]);
  eq(r[3], 'queued');
  assert(/already queued/.test(r[4]), r[4]);
  eq(b.queue.length, 0);
});

test('overseer: system prompt carries the rules, goals, ultras and the dashboard manual', async () => {
  const s = systemPrompt();
  for (const w of ['Never decline drops', 'lord-of-order', 'Ultra Dage', 'Ctrl+K', 'ask_character', 'nova7']) assert(s.includes(w), w);
});

test('overseer: model failure is logged and retried later, never crashes', async () => {
  const hub = await party();
  const o = new Overseer(hub, { llm: async () => { throw new Error('Ollama is not installed'); } });
  const row = await o.think('test');
  eq(row.kind, 'error');
  eq(o.lastError, 'Ollama is not installed');
  assert(!o.busy && o.nextThinkAt > Date.now(), 'retry scheduled');
  const chat = await o.chat('hello?');
  assert(chat.error && /not installed/.test(chat.text), chat.text);
});

test('bot: army helper tasks (join map, go to player)', async () => {
  const hub = await party();
  const bot = hub.bot('seraphx');
  await bot.runTask({ type: 'join', map: 'yulgar', cell: 'Enter' });
  eq(await bot.map(), 'yulgar');
  bot.client.players = { grail26: { map: 'ultradage', cell: 'Boss' } };
  eq(await bot.runTask({ type: 'gotoPlayer', player: 'GRAIL26' }), true);
  eq(await bot.map(), 'ultradage');
});

test('overseer: skipEvent marks an event too hard for today and the brain stops picking it', async () => {
  const hub = await party();
  const o = new Overseer(hub, {
    llm: async () => ({ data: { thoughts: 'Nova dies in the pirate event.', nextThinkMinutes: 10, actions: [
      { action: 'skipEvent', bot: 'nyxx', event: 'TalkLikeaPirateDay', why: '27 deaths' },
      { action: 'skipEvent', bot: 'nyxx', why: 'no event named' },
    ] } }),
  });
  const row = await o.think('test');
  eq(row.actions[0].result, 'event TalkLikeaPirateDay skipped for today');
  assert(/which event/.test(row.actions[1].result), row.actions[1].result);
  eq(hub.brain.today(hub.bot('nyxx')).eventsTooHard.TalkLikeaPirateDay, true);
});

test('brain: a failed event script makes the event too hard for today', async () => {
  const hub = await party();
  const bot = hub.bot('seraphx');
  const task = { type: 'script', path: 'Seasonal/X/Story.cs', event: 'SomeEvent', startedAt: Date.now() - 60000 };
  await hub.brain.done(bot, task, false);
  eq(hub.brain.today(bot).eventsTooHard.SomeEvent, true);
  const bot2 = hub.bot('nyxx');
  await hub.brain.failed(bot2, task);
  eq(hub.brain.today(bot2).eventsTooHard.SomeEvent, true);
});
