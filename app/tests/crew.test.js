// Crew dailies, the main calling the party, the weekly board (the owner 2026-10-25: "Nsod daily bosses allow 7 in the room so
// how is my main stuck? ... the Nulgath farming item daily quest should be run by all bots daily and they all help each
// other so no one gets stuck ... you should run ultra speaker weekly especially for my main").
const fs = require('fs');
const path = require('path');
const { Hub } = require('../lib/hub');
const { Bot } = require('../lib/bot');
const crew = require('../lib/crew');
const knowledge = require('../lib/knowledge');
const { P } = require('../lib/paths');

const NSOD = {
  name: 'NSoDDaily', quests: [8652, 8653], minLevel: 75, runnable: true,
  steps: [
    { kind: 'accept', quest: 8653, map: 'icewing', monsters: [], qty: 1 },
    { kind: 'hunt', map: 'icewing', monsters: ['Warlord Icewing'], item: 'Glacial Pinion', qty: 1 },
    { kind: 'hunt', map: 'hydrachallenge', monsters: ['Hydra Head 90'], item: 'Hydra Eyeball', qty: 3 },
    { kind: 'hunt', map: 'voidflibbi', monsters: ['Flibbitiestgibbet'], item: 'Flibbitigiblets', qty: 1 },
    { kind: 'turnin', quest: 8653, map: 'voidflibbi', monsters: [], qty: -1 },
  ],
};
const IDS = ['grail26', 'sable7', 'valen7', 'nova7', 'oren7', 'vexa', 'edda', 'sunna'];
const LEVELS = { grail26: 100, sable7: 100, valen7: 100, nova7: 100, oren7: 100, vexa: 80, edda: 78, sunna: 76 };

const CLASSES = {
  grail26: ["King's Echo", 'Legion Revenant', 'Lord of Order', 'StoneCrusher', 'Void Highlord'], sable7: ['Lord of Order', 'StoneCrusher'],
  valen7: ['StoneCrusher', 'ArchPaladin', 'Void Highlord'], nova7: ['Void Highlord', 'StoneCrusher'], oren7: ['ArchPaladin'], vexa: ['Healer'], edda: ['Rogue'], sunna: ['Mage'],
};
function crewHub({ ids = IDS, done = [], items = {} } = {}) {
  const h = Object.create(Hub.prototype);
  h.settings = { levelParty: { room: 13579 }, raids: { done: {}, tries: {} } };
  h.infos = []; h.info = (t) => h.infos.push(t); h.notes = []; h.notify = (t, b, k) => h.notes.push([t, b, k]);
  h.bots = new Map();
  const days = {};
  h.brain = { today: (b) => days[b.id] || (days[b.id] = { dailies: Object.fromEntries(done.includes(b.id) ? [['NSoDDaily', 'done']] : []) }), held: async () => 0, saveState() {} };
  h.days = days;
  h.levelOf = async (b) => LEVELS[b.id] || 100;
  h.bot = (id) => h.bots.get(id) || null;
  h.assistFor = () => null;
  for (const id of ids) {
    const main = id === 'grail26';
    h.bots.set(id, {
      id, running: true, paused: false, serverName: 'Swordhaven', queue: [], settings: {}, ran: [],
      account: { label: id, status: 'active', kind: main ? 'guest' : 'party', helper: main || undefined }, client: { state: { loaded: true } },
      current: { type: 'script', brain: true }, items: items[id] || {},
      classPoints: async () => (CLASSES[id] || []).map((name) => ({ name, cp: 302500 })), className: async () => (CLASSES[id] || ['Healer'])[0],
      questAvailable: async () => true, count: async function (n) { return this.items[n] || 0; },
      runNow(t) { this.ran.push(t); }, journal() {},
    });
  }
  return h;
}
const FLIBBI = crew.cfg.scripts.Flibbitiestgibbet;
// The generic-flow tests run without the army-script stage; withScripts turns it on.
const withDailies = async (fn, scripts = {}) => {
  const orig = knowledge.dailies; const was = crew.cfg.scripts;
  const ultras = require('../lib/ultras'); const inst = ultras.install;
  knowledge.dailies = () => [NSOD]; crew.cfg.scripts = scripts; ultras.install = () => 0;
  try { return await fn(); } finally { knowledge.dailies = orig; crew.cfg.scripts = was; ultras.install = inst; }
};
const withScripts = (fn) => withDailies(fn, { Flibbitiestgibbet: FLIBBI });
const fresh = () => { try { fs.rmSync(path.join(P.ROOT, 'crew.json'), { force: true }); } catch (e) { /* none */ } };
const afterReset = (h) => { h.crewBook().firstSeen = Date.now() - 3600000; };

test('crew: the NSoD daily has three stages, each with the daily quest', () => {
  const s = crew.stagesFor(NSOD);
  eq(s.map((x) => [x.monster, x.item, x.qty, x.quest]), [['Warlord Icewing', 'Glacial Pinion', 1, 8653], ['Hydra Head 90', 'Hydra Eyeball', 3, 8653], ['Flibbitiestgibbet', 'Flibbitigiblets', 1, 8653]]);
  assert(crew.enabled('NSoDDaily') && crew.enabled('EldersBlood'), 'NSoD and the Nulgath daily are crewed');
  assert(!crew.enabled('MineCrafting'), 'a plain farm daily is not');
});

test('crew: seven places, the main first, then the highest level; helpers fill what the needy leave', () => {
  const e = (id, level, guest = false) => ({ id, level, guest });
  const r = crew.pickRoom([e('a', 100), e('main', 100, true), e('g', 76), e('b', 100), e('c', 100), e('d', 100), e('f', 100), e('h', 100)], [e('x', 100)], 7);
  eq(r.needy.map((m) => m.id)[0], 'main');
  eq(r.all.length, 7);
  assert(!r.all.some((m) => m.id === 'g'), 'the lowest level waits for the next round');
  const r2 = crew.pickRoom([e('n', 80)], [e('p', 100), e('q', 90)], 7);
  eq(r2.all.map((m) => m.id), ['n', 'p', 'q']);
});

test('crew: a round starts with everybody who needs it (main first, 7 in the room) and sends each to stage 1', async () => {
  fresh();
  await withDailies(async () => {
    const h = crewHub();
    afterReset(h);
    const c = await h.crewTick();
    assert(c, h.infos.join(' | '));
    eq(c.members.length, 7, 'room limit 7 of 8 characters');
    eq(c.members[0], 'grail26', 'his place first');
    assert(!c.members.includes('sunna'), 'the lowest level waits');
    eq(c.needy.length, 7);
    for (const id of c.members) {
      const t = h.bot(id).ran[0];
      eq([t.type, t.map, t.room, t.monster, t.item, t.qty, t.quest, t.needy], ['crewHunt', 'icewing', 13579, 'Warlord Icewing', 'Glacial Pinion', 1, 8653, true], id);
    }
    eq(h.bot('sunna').ran.length, 0);
  });
});

test('crew: nobody is pulled before the reset relogs are over, or with fewer than three free', async () => {
  fresh();
  await withDailies(async () => {
    const h = crewHub();
    eq(await h.crewTick(), null, 'the day was just seen');
    afterReset(h);
    const two = crewHub({ ids: ['sable7', 'valen7'] });
    afterReset(two);
    eq(await two.crewTick(), null, 'two free: waiting for company');
    assert(two.infos.some((i) => /waiting for company/.test(i)));
  });
});

test("crew: the owner's main is left alone while he plays it or has orders queued", async () => {
  fresh();
  await withDailies(async () => {
    const h = crewHub();
    afterReset(h);
    h.bot('grail26').client._standAsideUntil = Date.now() + 3600000;
    const c = await h.crewTick();
    assert(c && !c.members.includes('grail26'), 'he is playing it');
    h.crew = null; fresh(); h._crewBook = null; afterReset(h); h._crewPause = 0;
    h.bot('grail26').client._standAsideUntil = 0;
    h.bot('grail26').queue = [{ type: 'script', path: 'x.cs' }];
    const c2 = await h.crewTick();
    assert(c2 && !c2.members.includes('grail26'), "an order of his is his");
  });
});

test('crew: stages advance when every character that needs the item holds it; the last one turns the quest in', async () => {
  fresh();
  await withDailies(async () => {
    const h = crewHub();
    afterReset(h);
    const c = await h.crewTick();
    eq(await h.crewTick(), null, 'nobody has the pinion yet');
    eq(c.i, 0);
    for (const id of c.needy.slice(1)) h.bot(id).items['Glacial Pinion'] = 1;
    await h.crewTick();
    eq(c.i, 0, 'one still without');
    h.bot(c.needy[0]).items['Glacial Pinion'] = 1;
    await h.crewTick();
    eq([c.i, c.stages[c.i].monster], [1, 'Hydra Head 90']);
    assert(c.token !== '0.1', 'members see the new stage');
    assert(h.crewTask(h.bot('sable7')).monster === 'Hydra Head 90', 'the loop sends a member to the stage');
    // Three eyeballs each (min(n, qty) per character counts toward progress).
    for (const id of c.needy) h.bot(id).items['Hydra Eyeball'] = 3;
    await h.crewTick();
    eq(c.stages[c.i].monster, 'Flibbitiestgibbet');
    for (const id of c.needy) h.bot(id).items.Flibbitigiblets = 1;
    await h.crewTick();
    eq(c.phase, 'turnin');
    for (const id of c.needy) {
      const last = h.bot(id).ran[h.bot(id).ran.length - 1];
      eq([last.type, last.name, last.crew], ['daily', 'NSoDDaily', c.id], id);
    }
    assert(!h.crewTask(h.bot('sable7')), 'members run the daily now, not another stage');
    for (const id of c.needy) h.days[id].dailies.NSoDDaily = 'done';
    await h.crewTick();
    eq(h.crew, null, 'finished');
    assert(h.infos.some((i) => /finished: turned in/.test(i)));
  });
});

test('crew: a stage that takes too long is tried once more with a new line-up, then the round ends and the next one starts for the rest', async () => {
  fresh();
  await withDailies(async () => {
    const h = crewHub();
    afterReset(h);
    const c = await h.crewTick();
    const t0 = c.token;
    c.stageAt = Date.now() - 21 * 60000;
    await h.crewTick();
    eq(c.tries, 2);
    assert(c.token !== t0, 'a fresh line-up');
    c.stageAt = Date.now() - 21 * 60000;
    await h.crewTick();
    eq(h.crew, null, 'round over');
    assert(h.infos.some((i) => /ended: Warlord Icewing/.test(i)));
    // The next round waits a few minutes, then starts again (round 2).
    eq(await h.crewTick(), null);
    h._crewPause = 0;
    const c2 = await h.crewTick();
    eq(c2.round, 2);
  });
});

test('crew: after maxRounds the crew gives up for the day, tells the owner once, and the brain lets each character try alone', async () => {
  fresh();
  await withDailies(async () => {
    const h = crewHub();
    afterReset(h);
    const b = h.crewBook();
    b.rounds.NSoDDaily = crew.cfg.maxRounds;
    assert(h.crewOwns(h.bot('vexa'), 'NSoDDaily'), 'crewed before');
    await h.crewTick();
    assert(b.gaveUp.NSoDDaily, 'gave up');
    assert(!h.crewOwns(h.bot('vexa'), 'NSoDDaily'), 'free to try alone');
    eq(h.notes.filter((n) => /did not finish/.test(n[0])).length, 1);
    assert(!h.crewOwns(h.bot('vexa'), 'MineCrafting'), 'other dailies were never the crew\'s');
  });
});

test('crew: a member who goes offline or into a raid leaves the crew; the rest carry on', async () => {
  fresh();
  await withDailies(async () => {
    const h = crewHub();
    afterReset(h);
    const c = await h.crewTick();
    h.bot('nova7').running = false;
    h.raid = { members: ['oren7'] };
    await h.crewTick();
    assert(!c.members.includes('nova7') && !c.members.includes('oren7'), c.members.join());
    eq(c.members.length, 5);
    assert(h.infos.some((i) => /left the crew/.test(i)));
  });
});

test('crew: a character who has the daily already comes along as a helper and is not asked for the item', async () => {
  fresh();
  await withDailies(async () => {
    const h = crewHub({ done: ['sable7', 'valen7', 'nova7', 'oren7'] });
    afterReset(h);
    const c = await h.crewTick();
    eq(c.needy.sort(), ['edda', 'grail26', 'sunna', 'vexa']);
    eq(c.helpers.sort(), ['nova7', 'oren7', 'sable7'], 'seven places: the four who need it, three helpers (highest level first)');
    eq(c.members.length, 7);
    eq(h.bot('sable7').ran[0].needy, false);
    assert(/helping/.test(h.bot('sable7').ran[0].why));
  });
});

test('crew: deaths in the room count toward the wall only for crew members', async () => {
  fresh();
  await withDailies(async () => {
    const h = crewHub();
    afterReset(h);
    const c = await h.crewTick();
    eq(h.crewDeath(h.bot('vexa'), { name: 'Warlord Icewing' }), true);
    eq(c.deathsSinceProgress, 1);
    eq(h.crewDeath({ id: 'stranger' }, { name: 'x' }), false);
    c.deathsSinceProgress = crew.cfg.wallDeaths;
    c.tries = crew.cfg.stageTries;
    await h.crewTick();
    eq(h.crew, null, 'the wall ends the round at once');
  });
});

test('crewHunt: a task of a finished crew returns at once without touching the game', async () => {
  const b = Object.create(Bot.prototype);
  b.hub = { crew: null };
  eq(await b.crewHunt({ crew: 'crew-x', token: '0.1' }), true);
});

test('main: his deaths call the party like the bots do (no stop); a party wall rests the task instead of stopping him', async () => {
  const h = Object.create(Hub.prototype);
  h.settings = { levelParty: { room: 13579 } };
  h.infos = []; h.info = (t) => h.infos.push(t); h.notify = () => {}; h.discord = null;
  h.soloBosses = () => ({}); h.partyWalls = {}; h.loadWalls = () => h.partyWalls;
  const calls = [];
  h.requestHelp = async (bot, info) => { calls.push(info); return { monster: info.monster }; };
  const bot = {
    id: 'grail26', account: { label: 'GRAIL26', kind: 'guest', helper: true }, current: { type: 'daily', name: 'NSoDDaily', brain: true }, journals: [],
    journal(m) { this.journals.push(m); }, map: async () => 'icewing', cell: async () => 'Enter', restarts: 0, restart() { this.restarts++; }, stopped: false, stop() { this.stopped = true; },
    taskKey: (t) => `${t.type}|${t.name}`, skipped: null,
  };
  await h.struggle(bot, { name: 'Warlord Icewing', hpMax: 9e6 }, 2);
  eq(calls.length, 1, 'the party was called');
  eq(calls[0].monster, 'Warlord Icewing');
  eq(bot.stopped, false);
  // The whole party lost to it: a daily is skipped for today (no stop), any other task rests 6 h and the loop restarts.
  h.partyWalls['warlord icewing'] = Date.now();
  h.brain = { today: () => ({ dailyFails: { NSoDDaily: 0 }, dailies: {} }), dailyFailed() {}, saveState() {} };
  await h.struggle(bot, { name: 'Warlord Icewing', hpMax: 9e6 }, 2);
  eq(calls.length, 1, 'no second call into a wall');
  eq([bot.stopped, bot.restarts], [false, 1]);
  bot.current = { type: 'script', path: 'Other/Classes/ArchMage.cs', brain: true };
  bot.taskKey = (t) => `${t.type}|${t.path}`;
  await h.struggle(bot, { name: 'Warlord Icewing', hpMax: 9e6 }, 2);
  eq(bot.stopped, false, 'never stopped');
  assert(bot.skipped && bot.skipped.get('script|Other/Classes/ArchMage.cs') > Date.now() + 5 * 3600000, 'rests for 6 h');
  eq(bot.restarts, 2);
});

test('main: an account added for orders only (a guest that is not a helper) still never calls the party', async () => {
  const h = Object.create(Hub.prototype);
  h.settings = {}; h.infos = []; h.info = () => {}; h.notify = () => {}; h.discord = null; h.soloBosses = () => ({});
  let called = 0;
  h.requestHelp = async () => { called++; };
  h.mainNeedsParty = () => 'asked';
  eq(await h.struggle({ id: 'g', account: { kind: 'guest' }, current: { type: 'script' } }, { name: 'X' }, 3), 'asked');
  eq(called, 0);
});

test('weekly: the board shows who still needs the turn-in and why; a main being played blocks it', async () => {
  const h = crewHub();
  const ultraready = require('../lib/ultraready');
  const sp = ultraready.BOSSES.find((x) => x.id === 'ultra-speaker');
  h._ultra = { ready: true, bosses: { 'ultra-speaker': { ready: true, seats: ['sable7', 'valen7', 'oren7', 'nova7'].map((id) => ({ id })), withMain: { ready: true } } } };
  h.raidHad = async (b) => b.id !== 'grail26';
  h.raidGoldShort = () => false;
  h.bot('grail26').client._standAsideUntil = Date.now() + 3600000;
  const board = await h.weeklyBoard();
  const w = board.find((x) => x.boss === 'ultra-speaker');
  assert(w, 'Ultra Speaker is on the board');
  eq(w.open, ['grail26']);
  eq(w.state, 'blocked');
  assert(w.blockers.some((b) => /being played by you/.test(b)), w.blockers.join('; '));
  const recipes = require('../lib/recipes');
  const was = recipes.active;
  try {
    recipes.active = (id) => (id === 'ultra-speaker' ? { seats: [] } : null);
    eq(Hub.tryCap({ id: 'ultra-speaker', every: 'week' }), 6, 'a weekly with a proven recipe gets six tries');
    eq(Hub.tryCap({ id: 'champion-drakath', every: 'week' }), 2, 'a boss nobody ever killed keeps two (the deploy reopened Drakath)');
    eq(Hub.tryCap({ id: 'ultra-ezrajal', every: 'day' }), 2);
  } finally { recipes.active = was; }
  // Late in the week it alerts once, not every half hour.
  w.dayOfWeek = 5;
  const wk = require('../lib/weekly');
  h.weeklyBoard = async () => [w];
  await h.weeklyTick(); await h.weeklyTick();
  eq(h.notes.filter((n) => /still open this week/.test(n[0])).length, 1);
});

// The fight itself against the fake game: a needy member takes the quest, joins the crew's room, farms the item and
// leaves only when the hub ends the stage; a helper never touches the quest.
test('crewHunt: a member that needs the daily accepts its quest, joins the party room and fights until the stage ends', async () => {
  const { FakeGame } = require('./fakegame');
  const questDb = { 990010: { turnin: [{ ItemID: 800, iQty: 1 }] } };
  const game = new FakeGame({ questDb, monsterDrops: { Frogzard: { ItemID: 800, sName: 'Crew Item' } } });
  const acc = { id: `crew${Math.random().toString(36).slice(2, 6)}`, label: 'Crew', owner: 'test' };
  const dir = P.account(acc.id); fs.mkdirSync(dir, { recursive: true });
  acc.loginFile = path.join(dir, 'login.txt'); fs.writeFileSync(acc.loginFile, 'Username: crewt\nPassword: pw\n');
  const bot = new Bot(game, acc);
  await bot.login();
  const hub = { crew: { id: 'crew-1', token: '0.1', h: null }, partySeat: async () => null };
  bot.hub = hub;
  const t = { type: 'crewHunt', crew: 'crew-1', token: '0.1', daily: 'X', who: 'Crew', map: 'farm', room: 13579, cell: 'r2', pad: 'Left', monster: 'Frogzard', item: 'Crew Item', qty: 1, quest: 990010, needy: true, minutes: 1 };
  const run = bot.crewHunt(t);
  const end = Date.now() + 15000;
  while (Date.now() < end && (await bot.count('Crew Item')) < 1) await new Promise((r) => setTimeout(r, 100));
  assert((await bot.count('Crew Item')) >= 1, 'farmed the item');
  assert(await bot.inProgress(990010), 'took the quest first');
  assert(/farm-13579/.test(String(await bot.g('world.strAreaName', '')) || game.sent.join('|')) || game.sent.some((s) => /13579/.test(s)), "went to the party's room");
  hub.crew = null;   // the hub ends the stage
  eq(await Promise.race([run, new Promise((r) => setTimeout(() => r('hung'), 10000))]), true);
  // A helper does not take the quest.
  const game2 = new FakeGame({ questDb, monsterDrops: { Frogzard: { ItemID: 800, sName: 'Crew Item' } } });
  const acc2 = { id: `crew${Math.random().toString(36).slice(2, 6)}`, label: 'Helper', owner: 'test' };
  const dir2 = P.account(acc2.id); fs.mkdirSync(dir2, { recursive: true });
  acc2.loginFile = path.join(dir2, 'login.txt'); fs.writeFileSync(acc2.loginFile, 'Username: crewh\nPassword: pw\n');
  const helper = new Bot(game2, acc2);
  await helper.login();
  const hub2 = { crew: { id: 'crew-1', token: '0.1', h: null }, partySeat: async () => null };
  helper.hub = hub2;
  const run2 = helper.crewHunt({ ...t, needy: false });
  await new Promise((r) => setTimeout(r, 1500));
  assert(!(await helper.inProgress(990010)), 'a helper has no quest to take');
  hub2.crew = null;
  eq(await Promise.race([run2, new Promise((r) => setTimeout(() => r('hung'), 10000))]), true);
}, 60000);

test('crew: one character that cannot get the item is left behind after a few minutes; the rest go on and it gets the next round', async () => {
  fresh();
  await withDailies(async () => {
    const h = crewHub();
    afterReset(h);
    const c = await h.crewTick();
    const weak = 'sunna';
    const needyBefore = c.needy.length;
    // Seven places: sunna (lowest level) is not in this round, so use the next lowest as the straggler.
    const slow = c.needy[c.needy.length - 1];
    for (const id of c.needy) if (id !== slow) h.bot(id).items['Glacial Pinion'] = 1;
    await h.crewTick();
    eq(c.i, 0, 'not yet: the straggler may still land its hit');
    c.bestAt = Date.now() - 5 * 60000;
    await h.crewTick();
    eq(c.i, 1, 'the others moved on');
    assert(!c.needy.includes(slow) && c.helpers.includes(slow), 'it rides along as a helper');
    eq(c.needy.length, needyBefore - 1);
    assert(h.infos.some((i) => /fell behind at Warlord Icewing/.test(i)));
    // It still needs the daily, so the next round has it.
    for (const id of c.needy) { h.bot(id).items['Hydra Eyeball'] = 3; h.bot(id).items.Flibbitigiblets = 1; }
    await h.crewTick(); await h.crewTick();
    eq(c.phase, 'turnin');
    assert(!h.bot(slow).ran.some((t) => t.type === 'daily'), 'it is not sent to turn in');
    for (const id of c.needy) h.days[id].dailies.NSoDDaily = 'done';
    await h.crewTick();
    eq(h.crew, null);
    assert(await h.crewNeeds(h.bot(slow), 'NSoDDaily'), 'and it still needs it');
  });
});

test('crew: members ignore other help calls (also between two stage tasks) and are not called into them', async () => {
  fresh();
  await withDailies(async () => {
    const h = crewHub();
    afterReset(h);
    const c = await h.crewTick();
    h.help = { id: 'x', by: 'sunna', helpers: [], monster: 'Boss', map: 'x', room: 1, until: Date.now() + 600000 };
    h.bot('valen7').current = null;           // between two stage tasks
    eq(h.helpTask(h.bot('valen7')), null, 'a crew member does not take the call');
    h.crew = null;
    assert(h.helpTask(h.bot('valen7')), 'without a crew it does');
    // requestHelp skips crew members too
    h.crew = c; h.help = null; h.settings.levelParty.room = 13579; h.levelOf = async () => 100; h.helpMinLevel = async () => 0;
    h.helpCoolingFor = () => false;
    const hh = await h.requestHelp(h.bot('sunna'), { map: 'x', cell: 'Enter', monster: 'Boss', why: 't' });
    eq(hh.helpers.filter((id) => c.members.includes(id)), [], 'nobody from the crew is called');
  });
});

test('crew: when a raid takes most of the crew the round ends without counting; the rest do not die for nothing', async () => {
  fresh();
  await withDailies(async () => {
    const h = crewHub();
    afterReset(h);
    const c = await h.crewTick();
    eq(h.crewBook().rounds.NSoDDaily, 1);
    h.raid = { members: ['sable7', 'valen7', 'oren7'] };
    await h.crewTick();
    eq(h.crew, null, 'round over');
    eq(h.crewBook().rounds.NSoDDaily, 0, 'not counted');
    assert(h.infos.some((i) => /not counted/.test(i)));
    // While the raid runs nothing starts; afterwards the next round does.
    h._crewPause = 0;
    eq(await h.crewTick(), null);
    h.raid = null;
    const c2 = await h.crewTick();
    assert(c2 && c2.round === 1, 'a new round once they are free');
  });
});

test('crew: a boss that beats a crew of seven in two rounds walls the daily for 24 h - nobody tries it alone, one alert', async () => {
  fresh();
  await withDailies(async () => {
    const h = crewHub();
    afterReset(h);
    const dieOut = async () => {
      const c = await h.crewTick();
      for (const id of c.needy) { h.bot(id).items['Glacial Pinion'] = 1; h.bot(id).items['Hydra Eyeball'] = 3; }
      await h.crewTick(); await h.crewTick();           // stage 3: Flibbitiestgibbet
      for (let t = 1; t <= crew.cfg.stageTries; t++) { h.crew.deathsSinceProgress = crew.cfg.wallDeaths; if (t < crew.cfg.stageTries) { h.crew.stageAt = Date.now() - 1; } await h.crewTick(); }
      return c;
    };
    await dieOut();
    eq(h.crew, null, 'round 1 over');
    assert(!h.crewWall('NSoDDaily'), 'one round is not a wall yet');
    h._crewPause = 0;
    for (const id of IDS) { h.bot(id).items = {}; }
    await dieOut();
    assert(h.crewWall('NSoDDaily'), 'two rounds of seven: walled');
    eq(h.notes.filter((n) => /walled by Flibbitiestgibbet/.test(n[0])).length, 1);
    assert(h.crewOwns(h.bot('vexa'), 'NSoDDaily'), 'the brain still leaves it alone: nobody goes alone');
    h._crewPause = 0; h._crewIdle = {};
    eq(await h.crewTick(), null, 'no new round while the wall stands');
    h.crewBook().walls.NSoDDaily.until = Date.now() - 1;
    assert(!h.crewWall('NSoDDaily'), 'it runs out after 24 h');
    // The wall survives the day change.
    h._crewBook = null;
    assert(h.crewBook().walls.NSoDDaily, 'kept in the book');
  });
});

test('crew: the class plan for the Flibbitiestgibbet army - the main is Legion Revenant, LoO, StoneCrusher and Void Highlord are all in, the rest keep their class', () => {
  const m = (id, guest, level, classes, current) => ({ id, guest, level, classes, current });
  const mem = [m('grail26', true, 100, ['Legion Revenant', 'Lord of Order', 'StoneCrusher', 'Void Highlord'], "King's Echo"), m('sable7', false, 100, ['Lord of Order', 'StoneCrusher'], 'Lord of Order'),
    m('valen7', false, 100, ['StoneCrusher', 'ArchPaladin', 'Void Highlord'], 'StoneCrusher'), m('nova7', false, 100, ['Void Highlord', 'StoneCrusher'], 'Void Highlord'),
    m('oren7', false, 100, ['ArchPaladin'], 'ArchPaladin'), m('vexa', false, 82, [], 'Healer')];
  const r = crew.seatPlan(mem, FLIBBI);
  eq(r.seats.grail26, 'Legion Revenant');
  const have = (c) => Object.values(r.seats).includes(c);
  assert(have('Lord of Order') && have('StoneCrusher') && have('Void Highlord'), JSON.stringify(r.seats));
  eq([r.seats.oren7, r.seats.vexa], ['ArchPaladin', 'Healer'], 'the others keep what they wear');
  eq(r.order[0], 'grail26');
  eq(crew.seatPlan(mem.filter((x) => x.id !== 'grail26'), FLIBBI).error, 'the main must be in the crew');
  assert(/Void Highlord/.test(crew.seatPlan(mem.filter((x) => x.id !== 'nova7' && x.id !== 'valen7'), FLIBBI).error));
  const noLr = mem.map((x) => (x.guest ? { ...x, classes: ['Lord of Order', 'StoneCrusher', 'Void Highlord'] } : x));
  assert(/Legion Revenant/.test(crew.seatPlan(noLr, FLIBBI).error), 'without LR on the main there is no army');
});

test('crew: the last NSoD stage is the army script - class options for all seven, the crew room, urgent engines, potions file', async () => {
  fresh();
  await withScripts(async () => {
    const h = crewHub();
    afterReset(h);
    const c = await h.crewTick();
    assert(c && c.plan, h.infos.join(' | '));
    eq(c.plan.seats.grail26, 'Legion Revenant');
    assert(h.infos.some((i) => /army plan: /i.test(i)), 'the plan is logged');
    for (const id of c.needy) { h.bot(id).items['Glacial Pinion'] = 1; h.bot(id).items['Hydra Eyeball'] = 3; }
    await h.crewTick(); await h.crewTick();
    eq(c.stages[c.i].monster, 'Flibbitiestgibbet');
    eq(c.scriptStage, true);
    const t = h.crewTask(h.bot('sable7'));
    eq([t.type, t.path, t.storage, t.crewScript, t.room], ['script', FLIBBI.script, 'Flibbitiestgibbet-v3', true, 13579]);
    eq(t.seat.cls, 'Lord of Order');
    eq([t.options.ArmySize, t.options.DoEnh, t.options.UsePotions], [7, 'False', 'False']);
    eq(t.options.Class1, 'Legion Revenant,grail26', 'the main is first');
    const classes = [1, 2, 3, 4, 5, 6, 7].map((i) => String(t.options['Class' + i]).split(',')[0]);
    for (const need of ['Legion Revenant', 'Lord of Order', 'StoneCrusher', 'Void Highlord']) assert(classes.includes(need), need + ' in ' + classes);
    eq(t.options.Class8, undefined);
    assert(h.engineUrgent('vexa') && !h.engineUrgent('sunna'), 'army members take engines at once');
    assert(Hub.dailyWork(t), 'a member is not pulled off by help calls');
    assert(fs.readFileSync(path.join(P.ROOT, 'raid-potions.txt'), 'utf8').includes('sable7=off'), 'no potions for this fight: the poor ones would farm gold for them');
    // The script ended for her (army done / fight called off): she waits instead of starting it again at once.
    h.crewScriptEnded(h.bot('sable7'), t);
    eq(h.crewTask(h.bot('sable7')).type, 'wait');
    // Everybody holds Flibbitigiblets: turn in.
    for (const id of c.needy) h.bot(id).items.Flibbitigiblets = 1;
    await h.crewTick();
    eq(c.phase, 'turnin');
  });
});

test('crew: nobody farms the early stages when the army cannot be seated (the main is being played)', async () => {
  fresh();
  await withScripts(async () => {
    const h = crewHub();
    afterReset(h);
    h.bot('grail26').client._standAsideUntil = Date.now() + 3600000;
    eq(await h.crewTick(), null);
    assert(h.infos.some((i) => /waiting - the main must be in the crew/.test(i)));
    eq(h.bot('valen7').ran.length, 0);
  });
});

test('crew: a member leaving during the army fight re-seats the rest; losing the only Void Highlord ends the round uncounted', async () => {
  fresh();
  await withScripts(async () => {
    const h = crewHub({ ids: ['grail26', 'sable7', 'valen7', 'nova7', 'oren7'] });
    afterReset(h);
    const c = await h.crewTick();
    assert(c && c.plan, h.infos.join(' | '));
    for (const id of c.needy) { h.bot(id).items['Glacial Pinion'] = 1; h.bot(id).items['Hydra Eyeball'] = 3; }
    await h.crewTick(); await h.crewTick();
    eq(c.scriptStage, true);
    // Oren (ArchPaladin, a free seat) leaves: the army is re-seated for four and restarts.
    h.bot('oren7').running = false;
    await h.crewTick();
    eq(c.members.includes('oren7'), false);
    eq(h.bot('sable7').ran[h.bot('sable7').ran.length - 1].options.ArmySize, 4);
    // Now Nova and Valen leave: nobody owns Void Highlord any more.
    h.bot('nova7').running = false; h.bot('valen7').running = false;
    await h.crewTick();
    eq(h.crew, null);
    assert(h.infos.some((i) => /not counted/.test(i)));
  });
});

test("cbo: an army fight of a crew uses the crew room - the main's private room would be another instance of the boss map", async () => {
  const cbo = require('../lib/skua/cbo');
  const hub = { crew: { id: 'crew-x', room: 13579 }, settings: {}, partyRoom: () => null };
  const bot = { id: 'grail26', account: { kind: 'guest' }, settings: { privateRoom: 24680 }, hub, current: { type: 'script', path: 'SeraphUltras/ChallengeBosses/Flibbitiestgibbetv3.cs', crewScript: true, crew: 'crew-x', room: 13579 } };
  const keys = await cbo.keysFor(bot);
  eq([keys.PrivateRooms, keys.PrivateRoomNr], ['True', '13579']);
  bot.current = { type: 'script', path: 'Other/x.cs' };
  eq((await cbo.keysFor(bot)).PrivateRoomNr, '24680', 'otherwise his own room');
});

test('crewScript: the army task of a crew that is over exits at once instead of waiting for an army that never comes', async () => {
  const b = Object.create(Bot.prototype);
  b.hub = { crew: null }; b.journal = () => {};
  eq(await b.runTask({ type: 'script', crewScript: true, crew: 'crew-x', token: '2.1', path: 'SeraphUltras/ChallengeBosses/Flibbitiestgibbetv3.cs' }), true);
  b.hub = { crew: { id: 'crew-x', token: '3.1' } };
  eq(await b.runTask({ type: 'script', crewScript: true, crew: 'crew-x', token: '2.1', path: 'x.cs' }), true, 'another stage of the same crew too');
});

test('crew: a daily that finished in the last allowed round is done - not "given up"', async () => {
  fresh();
  await withDailies(async () => {
    const h = crewHub({ done: IDS });
    afterReset(h);
    const b = h.crewBook();
    b.rounds.NSoDDaily = crew.cfg.maxRounds;
    await h.crewTick();
    assert(!b.gaveUp.NSoDDaily, 'nobody needs it any more: nothing to give up');
    eq(h.notes.filter((n) => /did not finish/.test(n[0])).length, 0, 'no alert');
    assert(!(b.log || []).some((l) => /gave up/.test(l.text)), 'no "gave up" line');
  });
});

test('crew boss round: Nightmare Carnax with the party army - main as Dragon of Time, ends when every needy one has Calamitous Ruin', async () => {
  const CARNAX = crew.cfg.scripts['Nightmare Carnax'];
  assert(CARNAX && crew.boss('NightmareCarnax'), 'configured');
  await withDailies(async () => {
    const h = crewHub({ items: { sable7: { 'Calamitous Ruin': 1 } } });
    const main = h.bot('grail26');
    main.classPoints = async () => ['Dragon of Time', "King's Echo", 'Lord of Order'].map((name) => ({ name, cp: 302500 }));
    h.bot('vexa').classPoints = async () => ['ArchPaladin'].map((name) => ({ name, cp: 302500 }));
    main.current = { type: 'script', path: 'Other/Classes/KathoolAdept.cs', why: 'his order' };   // his own order: still comes
    const r = await h.crewBossStart('NightmareCarnax');
    assert(r.ok, JSON.stringify(r));
    const c = h.crew;
    assert(c.boss, 'a boss round');
    assert(!c.needy.includes('sable7') && c.helpers.includes('sable7'), 'she has it already: helper');
    assert(c.needy.includes('grail26'), 'the main needs it');
    eq(c.plan.seats.grail26, "King's Echo");
    const seats = Object.values(c.plan.seats);
    assert(seats.includes('Lord of Order') && seats.filter((x) => x === 'ArchPaladin').length === 2, JSON.stringify(c.plan.seats));
    const t = main.ran[0];
    eq(t.path, CARNAX.script);
    eq(t.options.UsePotions, 'True', 'owned potions are drunk (the vendor fix cut the buying out)');
    eq(t.options.DoEnh, 'False');
    eq(t.options.ArmySize, c.members.length);
    eq(c.members.length, 4, 'Carnax buffs 4: the room is capped at 4');
    assert(c.members.includes('grail26'), 'the main is one of them');
    // Everyone who needed it got it: the round ends, no daily turn-in.
    for (const id of c.needy) h.bot(id).items['Calamitous Ruin'] = 1;
    await h.crewCheck(c, Date.now());
    eq(h.crew, null, 'over');
    assert(!h.bots.get('grail26').ran.some((x) => x.type === 'daily'), 'no daily turn-in');
    // The characters that did not fit in the 4-seat room get the next round; the main already has it.
    const r2 = await h.crewBossStart('NightmareCarnax');
    if (r2.ok) { assert(!h.crew.needy.includes('grail26'), 'the main has it now'); for (const id of h.crew.needy) h.bot(id).items['Calamitous Ruin'] = 1; await h.crewCheck(h.crew, Date.now()); }
    for (const id of IDS) h.bot(id).items['Calamitous Ruin'] = 1;
    eq((await h.crewBossStart('NightmareCarnax')).ok, false, 'nobody needs it any more');
  }, { 'Nightmare Carnax': CARNAX });
});

test('an army script member (crew round) is left alone on deaths: no class ladder, death cap, pre-fight switch or help call', async () => {
  const h = Object.create(Hub.prototype);
  h.settings = {}; h.info = () => {};
  const bot = { id: 'grail26', account: { kind: 'guest', helper: true }, current: { type: 'script', path: 'SeraphUltras/ChallengeBosses/NightmareCarnaxv3.cs', crewScript: true, crew: 'c1' },
    client: { w: { strMapName: 'darkcarnax', myAvatar: { dataLeaf: { intHPMax: 50000 } } } }, journal() {}, restart() { throw new Error('restarted'); } };
  const killer = { name: 'Nightmare Carnax', hpMax: 5000000, hp: 4000000 };
  eq(await h.fightLadder(bot, killer), false, 'no ladder');
  eq(h.deathCap(bot, killer), false, 'no death cap');
  eq(await h.preFightTick(bot), null, 'no pre-fight switch');
  h.crewDeath = () => true;
  eq(await h.bossDeath(bot, killer), null, 'no help call or party wall');
});
