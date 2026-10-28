// Boost watcher (Artix calendar + in-game server messages), brain reactions to boosts, stuck watchdog.
const fs = require('fs');
const path = require('path');
const { FakeGame } = require('./fakegame');
const { Bot } = require('../lib/bot');
const { Brain } = require('../lib/brain');
const { P } = require('../lib/paths');
const { Boosts, classify, parseCalendar } = require('../lib/boosts');
const { Hub } = require('../lib/hub');
const knowledge = require('../lib/knowledge');

const CAL = `$('#calendar').fullCalendar({ events: [
 {title: 'Double Class Points Boost 9.16.26',url: 'http://www.artix.com/calendar/double-class-points-boost-91626/' + '?d=x',start: '2026-09-16'} ,
 {title: 'Dark Spirit Orbs Boost 9.17.26',url: 'http://www.artix.com/calendar/dark-spirit-orbs-boost-91726/' + '?d=x',start: '2026-09-17'} ,
 {title: 'Double EXP Boost 9.18.26',url: 'http://www.artix.com/calendar/double-exp-boost-91826/' + '?d=x',start: '2026-09-18'} ,
 {title: 'Talk Like a Pirate Day + Collection Pt 1',url: 'http://www.artix.com/calendar/tlapd/' + '?d=x',start: '2026-09-18'} ,
 {title: 'Double ALL Boost 9.25.26',url: 'http://www.artix.com/calendar/double-all-boost-92526/' + '?d=x',start: '2026-09-25'} ,
 {title: 'Legion Token + Rib Boost 10.8.26',url: 'http://www.artix.com/calendar/legion-token-plus-rib-boost-10826/' + '?d=x',start: '2026-10-08'} ] });`;

test('boosts: parses the Artix calendar and classifies every boost', async () => {
  const ev = parseCalendar(CAL);
  eq(ev.length, 6);
  eq(ev[1].kinds, ['darkSpiritOrb']);
  eq(ev[2].kinds, ['exp']);
  eq(ev[3].boost, false, 'events are not boosts');
  eq(classify('Double ALL Boost 9.25.26'), ['exp', 'gold', 'rep', 'cp']);
  eq(classify('Legion Token + Rib Boost 10.8.26'), ['legionToken', 'rib']);
  const b = new Boosts(() => {});
  b.state.calendar = ev;
  const noonEst = new Date('2026-09-18T16:00:00Z');
  eq(b.activeKinds(noonEst), ['exp']);
  eq(b.active(new Date('2026-09-18T03:30:00Z')).map((x) => x.title), ['Dark Spirit Orbs Boost 9.17.26'], 'still 9/17 in EST before midnight');
  assert(b.upcoming(7, noonEst).some((u) => u.title.startsWith('Double ALL')), 'upcoming');
});

test('boosts: live boosts from in-game server messages expire', async () => {
  const b = new Boosts(() => {});
  eq(b.noteServerMessage('Profanity filter On.'), null);
  const live = b.noteServerMessage('2x Legion Tokens for the next 30 minutes!');
  eq(live.kinds, ['legionToken']);
  assert(b.has('legionToken'), 'active now');
  assert(!b.has('legionToken', new Date(Date.now() + 31 * 60000)), 'expired after 30 min');
});

async function bot(id, level, persona, hub) {
  const dir = P.account(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'login.txt'), `Username: ${id}\nPassword: pw\n`);
  const b = new Bot(new FakeGame({ level }), { id, label: id, username: id, loginFile: path.join(dir, 'login.txt'), persona, status: 'active' }, { hub });
  await b.login();
  return b;
}

test('brain: 2x XP day keeps doing goals (no grinding, the owner 10-09); 2x Rep day puts reputation classes first', async () => {
  const d = knowledge.dailies; const e = knowledge.eventCandidates;
  knowledge.dailies = () => []; knowledge.eventCandidates = () => [];
  try {
    const boosts = { kinds: [], activeKinds() { return this.kinds; }, active() { return [{ title: 'Double EXP Boost 9.18.26', kinds: ['exp'] }]; } };
    const hub = { boosts, bot: () => null };
    const brain = new Brain({ hub });
    const b = await bot('boosty', 35, 'sable7', hub);
    const day = brain.today(b); day.enhancedAt = Date.now(); day.styledAt = Date.now(); brain.state(b).barberAt = Date.now();
    const normal = await brain.next(b);
    assert(normal.type === 'script', `no boost: goals (${normal.type} ${normal.why})`);
    boosts.kinds = ['exp'];
    const t = await brain.next(b);
    assert(t.type === 'script' && !t.boost, `2x XP: still goals, no grinding (${t.type} ${t.why})`);
    boosts.kinds = ['rep'];
    const r = await brain.next(b);
    assert(/Boost today!/.test(r.why) && ['master-ranger', 'shaman', 'awe-enhancements'].includes(r.goal), `${r.goal} ${r.why}`);
  } finally { knowledge.dailies = d; knowledge.eventCandidates = e; }
});

test('watchdog: a "hunting" bot with no progress gets restarted, twice = task failed', async () => {
  const hub = { bots: new Map(), info() {}, notified: [], notify(t) { this.notified.push(t); }, overseer: { triggers: [], trigger(x) { this.triggers.push(x); } }, brain: { failed: async () => { hub.failedCalls = (hub.failedCalls || 0) + 1; } } };
  hub.watchdog = Hub.prototype.watchdog.bind(hub);
  const b = await bot('stucky', 20, null, null);
  hub.bots.set(b.id, b);
  b.running = true;
  let stops = 0; b.stop = () => { stops++; }; b.start = () => true;
  b.current = { type: 'farmLevel', brain: true, why: 'level 20 - leveling', startedAt: Date.now() - 20 * 60000 };
  await hub.watchdog();                       // first sample
  b._watch.at = Date.now() - 8 * 60000;      // 8 minutes without progress
  await hub.watchdog();
  eq(stops, 1, 'restarted');
  assert(hub.overseer.triggers.some((x) => /stuck/.test(x)), 'AI brain told');
  assert(b.lastLog.some((l) => /watchdog: no kills/.test(l)), 'journaled');
  b._watch.at = Date.now() - 8 * 60000;
  await hub.watchdog();
  eq(hub.failedCalls, 1, 'second time in 30 min: task counted as failed');
  b.stats.kills++;
  b._watch.at = Date.now() - 8 * 60000;
  await hub.watchdog();
  eq(stops, 2, 'progress resets it');
});

// Valen killed in the same cell for two hours on 2026-09-20 while its script log stood still: the kill counter
// looked like progress, so the watchdog never woke up.
test('watchdog: a script that keeps killing but says nothing new for half an hour is still stuck', async () => {
  const hub = { bots: new Map(), info() {}, notify() {}, overseer: null, brain: null };
  hub.watchdog = Hub.prototype.watchdog.bind(hub);
  const b = await bot('mutescript', 60, null, null);
  hub.bots.set(b.id, b);
  b.running = true;
  let stops = 0; b.stop = () => { stops++; }; b.start = () => true;
  b.current = { type: 'script', why: 'Farmer Joe: Skua 1-100', startedAt: Date.now() - 2 * 3600000 };

  b.scriptActivityAt = Date.now();
  for (let i = 0; i < 3; i++) { b.stats.kills++; await hub.watchdog(); }
  eq(stops, 0, 'a talking script is left alone while it kills');

  b.scriptActivityAt = Date.now() - 31 * 60000;   // half an hour of silence, kills still coming in
  b.stats.kills++;
  await hub.watchdog();
  eq(stops, 1, 'restarted even though the kill counter moved');
  const said = b.lastLog.find((l) => /watchdog:/.test(l)) || '';
  assert(/watchdog: the script has made no progress for 3\d min/.test(said), said || b.lastLog.slice(-3).join(' | '));
  const { RULES } = require('../lib/health');
  assert(RULES.find((r) => r.id === 'stuck').re.test(said), 'the health check still recognises it');
});

// Sable, 2026-10-10: Undead Raxgore (963k HP) takes ~10 min a kill solo; the watchdog restarted her just before
// kills and the rejoin reset the boss. Damage dealt is progress - but never past the 30-min mute rule.
test('watchdog: a long boss fight that keeps dealing damage is not restarted, a silent one still is', async () => {
  const hub = { bots: new Map(), info() {}, notify() {}, overseer: null, brain: null };
  hub.watchdog = Hub.prototype.watchdog.bind(hub);
  const b = await bot('bossfight', 99, null, null);
  hub.bots.set(b.id, b);
  b.running = true;
  let stops = 0; b.stop = () => { stops++; }; b.start = () => true;
  b.playing = async () => true;
  b.current = { type: 'script', why: 'Lord of Order daily', startedAt: Date.now() - 3600000 };
  b.scriptActivityAt = Date.now() - 12 * 60000;
  b.client = { damageAt: Date.now() };
  await hub.watchdog();
  b._watch.at = Date.now() - 11 * 60000;   // 11 min without kills, quests or drops...
  b.client.damageAt = Date.now() - 5000;    // ...but the boss is losing HP
  await hub.watchdog();
  eq(stops, 0, 'damage keeps a boss fight going');
  b._watch.at = Date.now() - 11 * 60000;
  b.client.damageAt = Date.now() - 11 * 60000 - 1;
  await hub.watchdog();
  eq(stops, 1, 'no damage either: restarted');
  b.scriptActivityAt = Date.now() - 31 * 60000;
  b._watch.at = Date.now() - 31 * 60000;
  b.client.damageAt = Date.now();
  await hub.watchdog();
  eq(stops, 2, 'half an hour without a script line or item: stuck, whatever the damage');
});

// Oren's FaizasMerge (audit C3, 2026-09-28): 2,184 "Please slow down" an hour for 4.4 h and 0 quests, while its log
// kept moving, so the watchdog never woke up.
test('watchdog: a script spinning on refused actions ("slow down" storm) is stuck unless items or turn-ins come', async () => {
  const hub = { bots: new Map(), info() {}, notify() {}, overseer: null, brain: null };
  hub.watchdog = Hub.prototype.watchdog.bind(hub);
  const b = await bot('stormy', 60, null, null);
  hub.bots.set(b.id, b);
  b.running = true;
  let stops = 0; b.stop = () => { stops++; }; b.start = () => true;
  b.current = { type: 'script', why: 'me time: a merge', startedAt: Date.now() - 2 * 3600000 };
  let warnings = 0;
  b.client.slowWarnings = () => warnings;
  b.scriptActivityAt = Date.now();
  await hub.watchdog();
  b._watch.at = Date.now() - 11 * 60000;
  b.scriptActivityAt = Date.now();
  await hub.watchdog();
  eq(stops, 0, 'no storm: a talking script is fine');
  warnings = 300;
  b.itemProgress = 5;
  await hub.watchdog();                              // the storm starts: baseline
  b._watch.at = Date.now() - 11 * 60000;
  b.scriptActivityAt = Date.now(); b.stats.kills++;  // lines and kills keep coming
  b.itemProgress = 6;
  await hub.watchdog();
  eq(stops, 0, 'an item gained during the storm is progress');
  b._watch.at = Date.now() - 11 * 60000;
  b.scriptActivityAt = Date.now(); b.stats.kills++;
  await hub.watchdog();
  eq(stops, 1, 'lines and kills alone are not');
  const said = b.lastLog.find((l) => /watchdog:/.test(l)) || '';
  assert(/refused its actions 300x in 10 min/.test(said), said);
  const { RULES } = require('../lib/health');
  assert(RULES.find((r) => r.id === 'stuck').re.test(said), 'the health check recognises it');
});

test('send gap: a "slow down" warning widens the gap to 500 ms for 30 s; warnings are counted over 10 min', async () => {
  const { HeadlessClient, SEND_GAP } = require('../lib/net/headless');
  const protocol = require('../lib/net/protocol');
  const c = new HeadlessClient({ id: 'gap', label: 'gap', username: 'G' });
  const t0 = Date.now();
  eq(c.sendGap(t0), SEND_GAP.normal);
  c.slowedDown(t0 - 11 * 60000);                     // an old one, long over
  eq(c.sendGap(t0), SEND_GAP.normal);
  c.handle(protocol.parse('%xt%warning%-1%Please slow down. Last action was too soon!%'));
  eq(c.sendGap(Date.now()), 500);
  eq(c.sendGap(Date.now() + 31000), 220, 'back to normal after 30 s');
  eq(c.slowWarnings(), 1, 'only the last 10 min count');
});

// Valen and Sable restarted BlazeBeardStory 35 times on 2026-09-21, each time back at "Killing Earth Elemental
// for item: No Explosion 0/15": restarting replayed the same dead step. The second stall there parks it.
test('watchdog: a script stuck twice at the same step with nothing gained is parked, not restarted for ever', async () => {
  const hub = { bots: new Map(), info() {}, notified: [], notify(t, m) { this.notified.push(`${t}: ${m}`); }, overseer: null };
  hub.watchdog = Hub.prototype.watchdog.bind(hub);
  hub.brain = new Brain({ hub });
  const b = await bot('stuckstep', 60, null, null);
  hub.bots.set(b.id, b);
  b.running = true;
  let stops = 0; b.stop = () => { stops++; }; b.start = () => true;
  const task = { type: 'script', path: 'Seasonal/TalkLikeaPirateDay/BlazeBeardStory.cs', brain: true, event: 'TalkLikeaPirateDay', why: 'TalkLikeaPirateDay is live - doing BlazeBeardStory', startedAt: Date.now() - 2 * 3600000 };
  hub.brain.preempt = async () => null;   // pausing for dailies/events has its own test
  const stall = async (t) => { b.current = { ...t }; b.scriptActivityAt = Date.now() - 31 * 60000; b._watch = null; await hub.watchdog(); };
  b.scriptStep = '(HuntMonster) Killing Earth Elemental for item: "No Explosion" #/#';
  b.itemProgress = 5;

  await stall(task);
  eq(stops, 1, 'first stall: restarted');
  assert(!b.isSkipped(task), 'not parked after one stall');
  await stall(task);
  eq(stops, 2, 'second stall: restarted as well');
  assert(b.isSkipped(task), 'second stall at the same step with nothing gained: parked');
  const day = hub.brain.today(b);
  assert((day.eventScripts.TalkLikeaPirateDay || []).includes(task.path), 'the event script is done for today');
  assert(b.lastLog.some((l) => /parked .*No Explosion/.test(l)), 'journaled with the step');
  assert(hub.notified.some((x) => /is stuck: .*parked for the rest of today/.test(x)), hub.notified.join(' | '));

  // A slow farm that keeps gaining between stalls is never parked, however long it takes; once it stops gaining, it is.
  const fj = { type: 'script', path: 'Other/FarmJoeKits/0FarmerJoeDoAll.cs', goal: 'farmer-joe', farmerJoe: true, brain: true, why: 'Farmer Joe', startedAt: Date.now() - 3 * 3600000 };
  b.scriptStep = '(_KillForItem) Farming Blinding Light Fragments (#/#)';
  for (let i = 1; i <= 6; i++) {
    b.itemProgress += 2;
    await stall(fj);
    assert(!b.isSkipped(fj), `stall ${i} with items gained: still running`);
  }
  await stall(fj);
  assert(b.isSkipped(fj), 'stalled again with nothing gained: parked');
  assert((hub.brain.state(b).goalFails['farmer-joe'] || 0) >= 3, 'Farmer Joe shows as parked on the dashboard');
  hub.brain.retry(b);
  assert(!b.isSkipped(fj) && !b._stalls, '"Try parked work again" clears it');
});

test('brain: scripts have no time limit; only daily-slice goals keep one', async () => {
  const d = knowledge.dailies; const e = knowledge.eventCandidates; const skip = process.env.SERAPH_TEST_SKIP_FJ;
  knowledge.dailies = () => []; knowledge.eventCandidates = () => [];
  try {
    const brain = new Brain({ hub: null });
    const goals = Brain.orderGoals(require('../lib/progression').goalsFor(null), 'x');
    for (const lvl of [20, 35, 45, 75]) {
      const b = await bot(`nolimit${lvl}`, lvl, null, null);
      const day = brain.today(b); day.enhancedAt = Date.now(); day.styledAt = Date.now(); brain.state(b).barberAt = Date.now();
      const t = await brain.next(b);
      if (t.type !== 'script') continue;
      const g = goals.find((x) => x.id === t.goal);
      eq(Number(t.hours) > 0, !!(g && g.repeat === 'daily'), `level ${lvl}: "${t.why}" hours ${t.hours}`);
    }
    process.env.SERAPH_TEST_SKIP_FJ = '0';
    const b = await bot('nolimitfj', 40, null, null);
    const day = brain.today(b); day.enhancedAt = Date.now(); day.styledAt = Date.now(); brain.state(b).barberAt = Date.now();
    b.unrankedClasses = async () => [];
    const fj = await brain.next(b);
    eq([fj.farmerJoe, fj.hours], [true, undefined], 'Farmer Joe runs until it is done');
    const legion = goals.find((g) => g.id === 'legion-tokens');
    assert(legion && legion.repeat === 'daily' && legion.hours, 'Legion tokens is a daily slice with its own hours');
  } finally { knowledge.dailies = d; knowledge.eventCandidates = e; process.env.SERAPH_TEST_SKIP_FJ = skip; }
});

// 2026-10-10: Valen's Forge Elysium order ran all day - no daily, no Lord of Order step. Orders on party characters
// give way to dailies (only), the daily goes in front of the order, and the order carries on after.
test('brain: an order on a party character pauses for a daily (not an event), and the daily runs before it', async () => {
  const hub = { bots: new Map() };
  const brain = new Brain({ hub });
  const lo = await bot('orderpause99', 99, null, hub);
  lo.current = { type: 'script', path: 'Enhancement/UnlockForgeEnhancements.cs', entry: 'Elysium', why: 'Forge Elysium (order)', startedAt: Date.now() - 2 * 3600000 };
  const loo = await brain.preempt(lo);
  eq(loo && [loo.recurring, loo.beforeOrder], ['loo-daily', true], 'the Lord of Order daily (a recurring daily chain) pauses an order');
  const b = await bot('orderpause', 40, null, hub);   // below Lord of Order's level: only the test daily can be due
  b.brain = brain;
  const order = { type: 'script', path: 'Enhancement/UnlockForgeEnhancements.cs', entry: 'Elysium', why: 'Forge Elysium (order)', startedAt: Date.now() - 2 * 3600000 };
  b.current = order;
  const d = knowledge.dailies; const e = knowledge.eventCandidates;
  try {
    knowledge.eventCandidates = () => [];
    knowledge.dailies = () => [];
    eq(await brain.preempt(b), null, 'nothing due: the order keeps going');
    knowledge.dailies = () => [{ name: 'Test Daily', runnable: true, minLevel: 1, quests: [1], steps: [] }];
    b.questAvailable = async () => true;
    const p = await brain.preempt(b);
    eq(p && [p.type, p.name, p.beforeOrder], ['daily', 'Test Daily', true], 'a daily that is up pauses the order');
    b.account.kind = 'guest';
    eq(await brain.preempt(b), null, "the owner's own account: his order is never paused");
    delete b.account.kind;
    // The hub puts the daily in front of the order the stop puts back.
    const { Hub } = require('../lib/hub');
    const h = { bots: new Map([[b.id, b]]), info() {}, notify() {}, overseer: null, brain: { preempt: async () => p } };
    h.watchdog = Hub.prototype.watchdog.bind(h);
    b.running = true; b.paused = false; b._preemptAt = 0;
    let restarts = 0; b.restart = () => { restarts++; };
    await h.watchdog();
    eq(restarts, 1, 'paused');
    eq((b._pushFront || []).map((t) => [t.type, t.name, t.beforeOrder]), [['daily', 'Test Daily', undefined]]);
    b.queue = [];
    b.queue.unshift(order);   // what the Stop handler does with the order
    b.takePushFront();
    eq(b.queue.map((t) => t.type), ['daily', 'script'], 'daily first, then the order carries on');
  } finally { knowledge.dailies = d; knowledge.eventCandidates = e; }
});

// 2026-10-10: Sable (Lord of Order at a 963k-HP boss) and Valen (a Forge order) never got to their free 500 ACs.
test('brain: an unclaimed free gift pauses even Lord of Order or an order; once claimed it does not', async () => {
  const freegifts = require('../lib/freegifts');
  const hub = { bots: new Map() };
  const brain = new Brain({ hub });
  const b = await bot('giftpause', 99, null, hub);
  b.current = { type: 'script', path: 'Dailies/LordOfOrder.cs', brain: true, recurring: 'loo-daily', every: 'day', why: 'Lord of Order daily', startedAt: Date.now() - 3600000 };
  const gift = freegifts.GIFTS.find((g) => g.id === 'free-ac');
  brain.today(b).events = { [gift.event]: true };
  const v = freegifts.version(gift.script);
  if (!v || Date.now() >= Date.parse(gift.until)) return;   // no library here, or the gift is over
  const p = await brain.preempt(b);
  eq(p && [p.gift, p.giftV, p.beforeOrder], ['free-ac', v, true], 'the gift goes ahead of Lord of Order');
  b.current = { type: 'script', path: 'Enhancement/UnlockForgeEnhancements.cs', entry: 'Elysium', why: 'an order', startedAt: Date.now() - 3600000 };
  eq((await brain.preempt(b) || {}).gift, 'free-ac', 'and ahead of an order');
  const st = brain.state(b);
  st.gifts = Object.fromEntries(freegifts.GIFTS.map((g) => [g.id, { v: freegifts.version(g.script), ok: true }]));
  b.current = { type: 'script', path: 'Dailies/LordOfOrder.cs', brain: true, recurring: 'loo-daily', every: 'day', why: 'Lord of Order daily', startedAt: Date.now() - 3600000 };
  eq(await brain.preempt(b), null, 'claimed: Lord of Order carries on');
  b.current = { type: 'raid', raid: true, startedAt: Date.now() - 3600000 };
  st.gifts = {};
  eq(await brain.preempt(b), null, 'never a raid');
});

test('bot: the same order queued twice with different start times is kept once', async () => {
  const fs = require('fs');
  const b = await bot('orderdedupe', 50, null, null);
  const o = { type: 'script', path: 'Enhancement/UnlockForgeEnhancements.cs', entry: 'Elysium', why: 'Forge Elysium' };
  fs.writeFileSync(b.file('queue.json'), JSON.stringify({ queue: [{ ...o, startedAt: 1 }, { type: 'kill', monster: 'Frogzard', why: 'x' }], current: { ...o, startedAt: 2 }, settings: {} }));
  b.load();
  eq(b.queue.map((t) => [t.type, t.startedAt || null]), [['script', 1], ['kill', null]]);
});

test('brain: a stopped task still books its event time; a long script is paused for a new daily', async () => {
  const hub = { bots: new Map() };
  const brain = new Brain({ hub });
  const b = await bot('preempty', 40, null, hub);
  const day = brain.today(b);
  await brain.interrupted(b, { type: 'script', brain: true, event: 'TalkLikeaPirateDay', startedAt: Date.now() - 40 * 60000 });
  assert(day.eventMs >= 39 * 60000, `event time booked (${day.eventMs})`);
  // A goal script paused after an hour is the day's goal chunk, so a restless persona's daily runs next (Nova 10-08).
  await brain.interrupted(b, { type: 'script', brain: true, goal: 'forge-x', startedAt: Date.now() - 30 * 60000 });
  eq(day.goalChunks, 0, 'half an hour of a goal is not a chunk');
  await brain.interrupted(b, { type: 'script', brain: true, goal: 'forge-x', startedAt: Date.now() - 61 * 60000 });
  eq(day.goalChunks, 1, 'an hour of a goal counts as the chunk');
  day.goalChunks = 0;

  b.current = { type: 'script', path: 'Other/FarmJoeKits/0FarmerJoeDoAll.cs', goal: 'farmer-joe', farmerJoe: true, brain: true, why: 'Farmer Joe', startedAt: Date.now() - 2 * 3600000 };
  const d = knowledge.dailies; const e = knowledge.eventCandidates;
  try {
    knowledge.eventCandidates = () => [];
    knowledge.dailies = () => [];
    const before = JSON.stringify(brain.state(b));
    eq(await brain.preempt(b), null, 'nothing more important: keep going');
    eq(JSON.stringify(brain.state(b)), before, 'the dry run leaves the brain state as it was');
    knowledge.dailies = () => [{ name: 'Test Daily', runnable: true, minLevel: 1, quests: [1], steps: [] }];
    b.questAvailable = async () => true;
    const p = await brain.preempt(b);
    eq(p && [p.type, p.name], ['daily', 'Test Daily'], 'a daily that is up pauses the long script');
    b.settings.maxEventHours = 2;
    b.current = { ...b.current, event: 'TalkLikeaPirateDay', startedAt: Date.now() - 10 * 60000 };
    eq(await brain.preempt(b), null, 'an event script inside its daily time is not paused for a daily');

    // 2026-09-22: the cap was only checked when an event script started, so events ran 5-6.5 h a day against 1.3-3 h.
    // Below level 100 the cap is 1 h (the owner, 2026-09-28): 40 min booked + 10 min running is under it; 40 + 30 is over
    // it, so the script is paused until tomorrow.
    knowledge.eventCandidates = () => [{ folder: 'TalkLikeaPirateDay', maps: ['blazebeard'], scripts: ['Seasonal/TalkLikeaPirateDay/BlazeBeardStory.cs'] }];
    day.events.TalkLikeaPirateDay = true;
    b.current = { type: 'script', path: 'Seasonal/TalkLikeaPirateDay/BlazeBeardStory.cs', brain: true, event: 'TalkLikeaPirateDay', why: 'TalkLikeaPirateDay is live - doing BlazeBeardStory', startedAt: Date.now() - 10 * 60000 };
    eq(await brain.preempt(b), null, 'under the cap: keeps going');
    b.current.startedAt = Date.now() - 30 * 60000;
    const capped = await brain.preempt(b);
    assert(capped && capped.eventCap === 1 && !capped.event, `over the cap: paused for non-event work (${JSON.stringify(capped)})`);
    await brain.interrupted(b, b.current);
    b.current = null;
    const after = await brain.next(b);
    assert(!after.event, `no event script again today (${after.why})`);
  } finally { knowledge.dailies = d; knowledge.eventCandidates = e; }
});

// Sable7, 2026-09-21: two engines compiled BlazeBeardStory at once and one lost the race on Skua's compile cache.
// That crash was booked as "TalkLikeaPirateDay is too hard for me today".
test('brain: an engine crash in an event script is retried later, not "too hard"; retry un-parks the day\'s events', async () => {
  const brain = new Brain({ hub: null });
  const b = await bot('crashy', 40, null, null);
  const task = { type: 'script', path: 'Seasonal/TalkLikeaPirateDay/BlazeBeardStory.cs', brain: true, event: 'TalkLikeaPirateDay', why: 'x' };
  await brain.failed(b, task, new Error("Could not find file '/home/seraph/seraph/Scripts/Cached-Scripts/-766942040-BlazeBeardStory.dll'."));
  const day = brain.today(b);
  assert(!(day.eventsTooHard || {}).TalkLikeaPirateDay, 'not too hard');
  assert(!(day.eventScripts.TalkLikeaPirateDay || []).length, 'not done for the day');
  assert(b.isSkipped(task), 'left alone for a few minutes');
  await brain.failed(b, task, new Error('died 3x to Blazebeard - too strong'));
  assert(day.eventsTooHard.TalkLikeaPirateDay, 'a real failure in the game still counts');
  const parked = brain.retry(b);
  assert(parked.events.includes('TalkLikeaPirateDay') && !brain.today(b).eventsTooHard.TalkLikeaPirateDay && !b.isSkipped(task), 'retry clears it');
});

// 2026-09-21: a Wi-Fi reconnect (bot.stop + start) dropped the order in progress for good, and "run now" put the
// interrupted order back in front of the new one.
test('orders: survive a restart, runNow goes first and the interrupted order follows, a skipped order is dropped', async () => {
  const b = await bot('orders', 40, null, null);
  b.brain = null;
  const ran = [];
  b.runTask = async (t) => { ran.push(t.why); for (;;) { b.check(); await new Promise((r) => setTimeout(r, 20)); } };
  b.useRole = async () => null; b.gearUp = async () => null;
  const until = async (cond, ms = 8000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); assert(cond(), `timed out; ran ${ran.join(',')}`); };
  b.queue = [{ type: 'script', path: 'Story/A.cs', why: 'A' }];
  b.start();
  await until(() => ran.includes('A'));
  b.runNow({ type: 'script', path: 'Story/B.cs', why: 'B' });
  await until(() => ran.includes('B'));
  eq(b.queue.map((t) => t.why), ['A'], 'the interrupted order waits right behind the new one');
  b.stop(); await until(() => !b.running); b.start();   // what a Wi-Fi reconnect does
  await until(() => ran.filter((x) => x === 'B').length === 2);
  eq(b.queue.map((t) => t.why), ['A'], 'the order in progress carried on after the restart');
  await b.skip(5);
  await until(() => ran.filter((x) => x === 'A').length === 2);
  eq(b.queue.length, 0, 'the skipped order was dropped, the next one runs');
  b.stop(); await until(() => !b.running);
});

test('brain: a Farmer Joe daily class runs once a day, and a goal that ends at once without its item rests', async () => {
  const goals = Brain.orderGoals(require('../lib/progression').goalsFor(null), 'x');
  const cryo = goals.find((g) => g.id === 'fj-cryomancer');
  assert(cryo && cryo.repeat === 'daily', 'fj-cryomancer (Dailies/Cryomancer.cs) is a daily goal');
  const ds = goals.find((g) => g.id === 'fj-dragonslayer');
  assert(!ds || !ds.repeat, 'an ordinary Farmer Joe class is not a daily');
  const brain = new Brain({ hub: null });
  const b = await bot('quickgoal', 60, null, null);
  b.owns = async () => false;
  const task = { type: 'script', path: 'Good/ArchPaladin.cs', goal: 'archpaladin', startedAt: Date.now() - 40000 };
  for (let i = 0; i < 3; i++) await brain.done(b, task, { ok: true });
  eq(brain.state(b).goalFails.archpaladin, 3, 'three quick empty finishes = three failed tries');
  const long = { ...task, goal: 'stonecrusher', startedAt: Date.now() - 20 * 60000 };
  await brain.done(b, long, { ok: true });
  eq(brain.state(b).goalFails.stonecrusher, undefined, 'a long run is not a failed try');
  b.owns = async () => true;
  await brain.done(b, { ...task, goal: 'master-ranger' }, { ok: true });
  eq(brain.state(b).goalFails['master-ranger'], undefined, 'a quick run that got the item is fine');
});

// 2026-10-21: the main's ArchMage order was restarted 11x while it stood in the queue for a Skua engine.
test('watchdog: a character waiting for a Skua engine is not stuck', async () => {
  const hub = { bots: new Map(), info() {}, notify() {}, overseer: { trigger() {} }, brain: { failed: async () => {} }, engineWaiting: new Set() };
  hub.watchdog = Hub.prototype.watchdog.bind(hub);
  const b = await bot('queued', 100, null, null);
  hub.bots.set(b.id, b);
  b.running = true;
  let stops = 0; b.stop = () => { stops++; }; b.start = () => true;
  b.current = { type: 'farmLevel', brain: true, why: 'waits for an engine', startedAt: Date.now() - 20 * 60000 };
  hub.engineWaiting.add(b.id);
  await hub.watchdog();
  b._watch.at = Date.now() - 15 * 60000;
  await hub.watchdog();
  eq(stops, 0, 'left alone while queued');
  hub.engineWaiting.delete(b.id);
  b._watch.at = Date.now() - 15 * 60000;
  await hub.watchdog();
  eq(stops, 1, 'stuck again once it has its engine');
});
