// Phase 4 of the 2026-09-28 overhaul: walls and party escorts (lib/walls.js). SUPER Dreadhaven General re-parked
// Farmer Joe for three characters four days running; help calls killed bosses but never un-parked anything.
const fs = require('fs');
const path = require('path');
const { Walls, parseStep, estimate, describe } = require('../lib/walls');
const { Brain } = require('../lib/brain');
const { Holds, Ledger } = require('../lib/ledger');
const { P } = require('../lib/paths');

const FJ = { type: 'script', path: 'Other/FarmJoeKits/0FarmerJoeDoAll.cs', goal: 'farmer-joe', farmerJoe: true, brain: true, why: "Farmer Joe: Skua's 1-100 + endgame route" };

function fakeBot(id, extra = {}) {
  fs.mkdirSync(P.account(id), { recursive: true });
  const b = {
    id, dir: P.account(id), account: { label: id, status: 'active' }, settings: {}, running: true, paused: false, serverName: 'Swordhaven',
    lastLog: [], journal(m) { this.lastLog.push(m); }, stats: { quests: 0, drops: 0, kills: 0, deaths: 0, xp: 0 }, itemProgress: 0,
    current: { type: 'farmLevel', brain: true, why: 'grinding' }, restarts: 0, restart() { this.restarts++; return Promise.resolve(); },
    level: async () => 88, scriptStep: null, ...extra,
  };
  b.taskKey = (t) => (t ? [t.type, t.path || '', t.entry || '', t.args || '', t.name || '', t.goal || '', t.event || ''].join('|') : '');
  b.ledger = new Ledger(path.join(b.dir, 'ledger.json'));
  b.skipped = new Holds(b.ledger);
  return b;
}
function fakeHub(bots, settings = {}) {
  const hub = { bots: new Map(bots.map((b) => [b.id, b])), settings: { levelParty: { room: 13579 }, ...settings }, infos: [], info(m) { this.infos.push(m); }, notify() {}, soloBosses: () => ({}), isPartyWall: () => false };
  hub.bot = (id) => hub.bots.get(id);
  hub.constructor = require('../lib/hub').Hub;
  hub.brain = new Brain({ hub });
  hub.walls = new Walls(hub, path.join(process.env.SERAPH_ROOT, `walls-${Math.random().toString(36).slice(2, 8)}.json`));
  return hub;
}

test('walls: step lines and death caps name the wall', async () => {
  eq(parseStep('(HuntMonster) Killing SUPER Dreadhaven General for item: "Dreadhaven Helm" 0/1'), { boss: 'SUPER Dreadhaven General', item: 'Dreadhaven Helm', have: 0, want: 1 });
  eq(parseStep('died 8x to Ultra Chaos Alteon in 30 min'), { boss: 'Ultra Chaos Alteon' });
  eq(parseStep('(_KillForItem) Farming Prayer of Salvation (0/1)'), { item: 'Prayer of Salvation', have: 0, want: 1 });
  eq(parseStep('(RetryCellOnAFK) Jump request to [r2, Left] sent as an anti-AFK measure.'), null);
  const e = estimate({ dps: 2000, hit: 900 }, 2100000, 3600);
  eq([e.soloTtkMin, e.partyTtkMin, e.hitsToDie], [17.5, 4.4, 4]);
  assert(/2\.1 M HP; my DPS ~2 k → 17\.5 min alone, ~4\.4 min with the party; it hits me for ~900 \(4 hits/.test(describe({ boss: 'Taro', estimate: e })), describe({ boss: 'Taro', estimate: e }));
});

test('walls: each wall gets a plan - escort, skip (cosmetic), solo, crowd, and dailies are not walls', async () => {
  const a = fakeBot('wa1'); const b = fakeBot('wa2');
  const hub = fakeHub([a, b]);
  const W = hub.walls;
  const w = W.note(a, FJ, 'died 8x to SUPER Dreadhaven General in 30 min', { boss: 'SUPER Dreadhaven General', hpMax: 600000, ownHp: 4000, deaths: 8 });
  eq(w.plan.kind, 'escort');
  assert(a.lastLog.some((l) => /wall: SUPER Dreadhaven General blocks "Farmer Joe/.test(l)), a.lastLog.join('|'));
  eq(W.note(b, { type: 'script', style: true, brain: true, why: 'me time: a coat' }, 'died 8x to Gallaeon in 30 min', { boss: 'Gallaeon' }).plan.kind, 'skip');
  eq(W.note(a, { type: 'daily', name: 'LoO', why: 'Lord of Order daily is up this day' }, 'died 8x to Ledgermayne in 30 min', { boss: 'Ledgermayne' }), null);
  // The ladder (the owner 2026-10-09): HP is no proof - the party tries Desolich first; only a lost party fight goes public.
  eq(W.note(b, FJ, 'died 8x to Desolich in 30 min', { boss: 'Desolich', hpMax: 8195130, ownHp: 3500 }).plan.kind, 'escort');
  hub.isPartyWall = (n) => n === 'Desolich';
  const dw = W.data.walls.desolich;
  dw.plan = W.plan(dw);
  eq(dw.plan.kind, 'crowd', 'the party lost to it: a public room with players is the last option');
  assert(/last option/.test(dw.plan.why), dw.plan.why);
  hub.isPartyWall = () => false;
  const crowd = require('../lib/crowd');
  crowd.setLadder(false);
  try { dw.plan = W.plan(dw); eq(dw.plan.kind, 'crowd', 'old rules: 2,300x its HP is a crowd boss at once'); } finally { crowd.setLadder(true); }
  hub.soloBosses = (bot) => (bot.id === 'wa2' ? { Krahen: 'x' } : {});
  W.note(a, FJ, 'died 8x to Krahen in 30 min', { boss: 'Krahen' });
  eq(W.data.walls.krahen.plan.kind, 'escort', 'only the blocked character counts');
  W.note(b, FJ, 'died 8x to Krahen in 30 min', { boss: 'Krahen' });
  eq(W.data.walls.krahen.plan.kind, 'solo', 'wa2 beat it alone before');
});

test('walls: today\'s park lines in the journals seed the registry after a restart', async () => {
  const a = fakeBot('wseed');
  const hub = fakeHub([a]);
  const now = Date.now();
  const iso = (ms) => new Date(now - ms).toISOString();
  fs.writeFileSync(path.join(P.account('wseed'), 'journal.log'), [
    `${iso(3600000)} parked "Farmer Joe: Skua's 1-100 + endgame route" for 24 h: died 8x to SUPER Dreadhaven General in 30 min`,
    `${iso(1800000)} parked "ranking Cryomancer up to 10 (1 / 302,500 class points)" for 24 h: died 8x to Frost Spirit in 30 min`,
    `${iso(1200000)} parked "Farmer Joe: Skua's 1-100 + endgame route" for 24 h: stuck twice at "(HuntMonster) Killing Binky for item: "Binky's Uni. Horn" 0/1" with nothing gained`,
    `${iso(30 * 3600000)} parked "Farmer Joe: Skua's 1-100 + endgame route" for 24 h: died 8x to Old Boss in 30 min`,
    `${iso(600000)} something else`,
  ].join('\n'));
  eq(hub.walls.seedFromJournal(a), 3);
  const ids = Object.keys(hub.walls.data.walls).sort();
  eq(ids, ['binky', 'frost spirit', 'super dreadhaven general']);
  eq(Object.values(hub.walls.data.walls.binky.blocks.wseed.tasks)[0].task.farmerJoe, true);
  eq(Object.values(hub.walls.data.walls['frost spirit'].blocks.wseed.tasks)[0].task.rankClass, 'Cryomancer');
  // Got past Dreadhaven after that park: the next restart's seeding must not block it again.
  hub.walls.clear(a, hub.walls.data.walls['super dreadhaven general'], 'killed SUPER Dreadhaven General');
  hub.walls.seedFromJournal(a);
  eq(hub.walls.data.walls['super dreadhaven general'].blocks.wseed, undefined, 'an old park does not come back');
  eq(hub.walls.data.walls['super dreadhaven general'].plan.kind, 'cleared');
});

test('walls: plan-only mode says who would go where, and moves nobody', async () => {
  const a = fakeBot('wp1'); const b = fakeBot('wp2'); const c = fakeBot('wp3');
  const hub = fakeHub([a, b, c]);
  hub.walls.note(a, FJ, 'died 8x to SUPER Dreadhaven General in 30 min', { boss: 'SUPER Dreadhaven General' });
  eq(hub.walls.mode(), 'plan', 'the first day is plan-only');
  const r = await hub.walls.tick();
  eq([r.result, r.needers, r.helpers], ['plan only', ['wp1'], ['wp2', 'wp3']]);
  assert(hub.infos.some((m) => /escort \(plan only.*would take wp2, wp3 with wp1 past SUPER Dreadhaven General in room 13579/.test(m)), hub.infos.join('|'));
  eq(a.restarts + b.restarts + c.restarts, 0);
  eq(await hub.walls.tick(), null, 'the next window is 2 h later');
});

test('walls: a live escort - the needer runs its parked work, the others follow, and getting past un-parks everything', async () => {
  const a = fakeBot('wl1'); const b = fakeBot('wl2'); const c = fakeBot('wl3');
  const hub = fakeHub([a, b, c], { escorts: 'on' });
  const ArchPal = { type: 'script', path: 'Other/Classes/ArchPaladin.cs', goal: 'archpaladin', brain: true, why: 'Late game: ArchPaladin' };
  // Farmer Joe and ArchPaladin both parked at the wall; the brain's own counters too.
  for (const t of [FJ, ArchPal]) { hub.brain.park(a, { ...t }, 'died 8x to SUPER Dreadhaven General in 30 min', { deaths: true, killer: { name: 'SUPER Dreadhaven General', hpMax: 700000 }, deathsN: 8 }); }
  for (let i = 0; i < 3; i++) hub.brain.goalFailed(a, 'farmer-joe');
  assert(a.skipped.has(a.taskKey(FJ)), 'parked');
  const e = await hub.walls.tick();
  assert(e && hub.walls.active() === e, 'escort on');
  eq([a.restarts, b.restarts, c.restarts], [1, 1, 1], 'everyone switches now');
  const ta = hub.escortTask ? null : hub.walls.taskFor(a);
  eq([ta.path, ta.escort, ta.farmerJoe], [FJ.path, e.id, true], 'Farmer Joe first');
  assert(!a.skipped.has(a.taskKey(FJ)), 'the escort runs the parked work itself');
  const tb = hub.walls.taskFor(b);
  eq([tb.type, tb.leader, tb.server, tb.escort], ['follow', 'wl1', 'Swordhaven', e.id]);
  // A raid takes the needer mid-escort: the helpers don't chase it into the ultra room (2026-10-23).
  a.current = { type: 'script', path: 'SeraphUltras/IndividualUltras/6UltraGramielv3.cs', raid: 'raid-1' };
  eq(hub.walls.taskFor(b), null, 'no follow while the needer raids');
  a.current = null;
  eq(hub.walls.taskFor(b).type, 'follow', 'following again after the raid');
  // The needer reaches the wall, then moves on with its item.
  a.current = { ...ta };
  a.scriptStep = '(HuntMonster) Killing SUPER Dreadhaven General for item: "Dreadhaven Helm" 0/1';
  hub.walls.watch(e);
  eq(hub.walls.active() && hub.walls.active().id, e.id, 'still at it');
  a.itemProgress = 1;
  a.scriptStep = '(HuntMonster) Killing Vordred for item: "Vordred Soul" 0/1';
  hub.walls.watch(e);
  eq(hub.walls.active(), null, 'past it: the escort ends');
  eq(e.result, 'past for wl1');
  eq(hub.walls.isOn(e.id), false, 'the helpers stop following');
  eq(hub.brain.state(a).goalFails['farmer-joe'], undefined, 'Farmer Joe un-parked in the brain');
  assert(!a.skipped.has(a.taskKey(ArchPal)), 'ArchPaladin too');
  assert(a.lastLog.some((l) => /past SUPER Dreadhaven General \(party escort\) - un-parked: Farmer Joe.*ArchPaladin/.test(l)), a.lastLog.join('|'));
  eq(hub.walls.data.walls['super dreadhaven general'].plan.kind, 'cleared');
});

// Seraph 5 (2026-10-26): an escort takes a squad, not everyone, and a helper the needer's full room turns away leaves.
test('walls: an escort takes a squad of three; a helper refused by a full room goes back to its own work', async () => {
  const { Hub } = require('../lib/hub');
  const { SquadBook } = require('../lib/squad');
  const bots = ['ws1', 'ws2', 'ws3', 'ws4', 'ws5', 'ws6'].map((id) => fakeBot(id));
  const hub = fakeHub(bots, { escorts: 'on' });
  for (const k of ['squadInfo', 'levelOf', 'keepEngineTurn', 'squadBook']) hub[k] = Hub.prototype[k].bind(hub);
  hub._squadBook = new SquadBook(path.join(process.env.SERAPH_ROOT, `squads-${Math.random().toString(36).slice(2)}.json`));
  hub.brain.park(bots[0], { ...FJ }, 'died 8x to SUPER Dreadhaven General in 30 min', { deaths: true, killer: { name: 'SUPER Dreadhaven General', hpMax: 700000 }, deathsN: 8 });
  const e = await hub.walls.tick();
  assert(e, 'escort on');
  eq([e.needers, e.helpers.length], [['ws1'], 3], 'the needer and a squad of three');
  const out = bots.filter((b) => b.id !== 'ws1' && !e.helpers.includes(b.id));
  eq(out.map((b) => b.restarts), [0, 0], 'the other two keep working');
  const h1 = bots.find((b) => b.id === e.helpers[0]);
  eq(hub.walls.taskFor(h1).type, 'follow');
  eq(hub.walls.leave(h1, e.id, 'the room is full'), true);
  eq(hub.walls.taskFor(h1), null, 'back to its own work');
  eq(e.helpers.length, 2);
});

test('walls: two escorts without getting past it make it a "later" wall for three days; two windows a day at most', async () => {
  const a = fakeBot('wf1'); const b = fakeBot('wf2');
  const hub = fakeHub([a, b], { escorts: 'on' });
  hub.walls.note(a, FJ, 'died 8x to Ultra Chaos Alteon in 30 min', { boss: 'Ultra Chaos Alteon' });
  let now = Date.now();
  const e1 = await hub.walls.tick(now);
  hub.walls.taskEnded(a, { ...FJ, escort: e1.id }, { items: 0, quests: 0 }, now + 60000);
  eq([hub.walls.active(), e1.result], [null, 'no progress']);
  now += 3 * 3600000;
  const e2 = await hub.walls.tick(now);
  assert(e2 && e2.id !== e1.id, 'second window, 2 h+ later');
  hub.walls.end(e2, 'time is up', now + ESCORT());
  const w = hub.walls.data.walls['ultra chaos alteon'];
  eq(w.plan.kind, 'crowd', 'the ladder: the party lost twice, so public rooms are next (was "later")');
  assert(/2 escorts without getting past it - last option: a public room with players/.test(w.plan.why), w.plan.why);
  assert(w.plan.until > now, 'for the three days');
  eq(await hub.walls.tick(now + 4 * 3600000), null, 'no escort for it (and two today already)');
});
function ESCORT() { return require('../lib/walls').ESCORT_MS; }

test('walls: a restart keeps each plan (bots load later); the minute tick plans again with them', async () => {
  const file = path.join(process.env.SERAPH_ROOT, `walls-restart-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ v: 1, planOnlyUntil: Date.now() + 3600000, escorts: [], walls: {
    krahen: { id: 'krahen', boss: 'Krahen', blocks: { wr1: { tasks: { k: { task: { ...FJ }, at: Date.now() - 1000 } } } }, cleared: {}, plan: { kind: 'solo', why: 'wr1 has killed Krahen alone before' } },
  } }));
  const a = fakeBot('wr1');
  const hub = fakeHub([a]);
  hub.soloBosses = (bot) => (bot.id === 'wr1' ? { Krahen: 'x' } : {});
  const early = new Walls({ settings: {}, bot: () => null, soloBosses: () => ({}), isPartyWall: () => false }, file);
  eq(early.data.walls.krahen.plan.kind, 'solo', 'no bots yet: the saved plan stands');
  const W = new Walls(hub, file);
  hub.walls = W;
  hub.soloBosses = () => ({});                    // say the solo kill is forgotten: the tick plans it as an escort
  await W.tick();
  eq(W.data.walls.krahen.plan.kind, 'escort');
});

test('walls: killing the boss yourself un-parks what it blocked', async () => {
  const { Hub } = require('../lib/hub');
  const a = fakeBot('wk1');
  const hub = fakeHub([a]);
  hub.isBoss = Hub.prototype.isBoss;
  hub.soloBosses = () => ({});
  hub.brain.park(a, { ...FJ }, 'died 8x to Binky in 30 min', { deaths: true, killer: { name: 'Binky', hpMax: 900000 }, deathsN: 8 });
  assert(a.skipped.has(a.taskKey(FJ)));
  Hub.prototype.bossKilled.call(hub, a, { name: 'Binky', hpMax: 900000, byMe: true, others: 2, map: 'doomvault' });
  assert(!a.skipped.has(a.taskKey(FJ)), 'Farmer Joe is tried again');
  assert(a.lastLog.some((l) => /past Binky \(killed Binky\)/.test(l)), a.lastLog.join('|'));
});

// 2026-10-01: Oren's Cryomancer rank-up stayed on the Frost Spirit wall after the class reached rank 10 (the block
// came from a stale class-point read), and the escort for it pulled all four for 9 seconds.
test('walls: a rank-up block is dropped once the class is rank 10, before any escort is planned for it', async () => {
  const RANK = { type: 'script', path: 'CoreAdvanced.cs', entry: 'RankUpClass', args: '"Cryomancer"', rankClass: 'Cryomancer', brain: true, why: 'ranking Cryomancer up to 10 (1 / 302,500 class points)' };
  const a = fakeBot('wr1', { unrankedClasses: async () => [] }); const b = fakeBot('wr2', { unrankedClasses: async () => [] });
  const hub = fakeHub([a, b], { escorts: 'on' });
  const W = hub.walls;
  eq(W.note(a, RANK, 'died 8x to Frost Spirit in 30 min', { boss: 'Frost Spirit' }).plan.kind, 'escort');
  eq(await W.tick(Date.now()), null, 'no escort for a class that is rank 10');
  eq([Object.keys(W.data.walls['frost spirit'].blocks).length, W.data.walls['frost spirit'].plan.kind], [0, 'cleared']);
  assert(a.lastLog.some((l) => /Cryomancer is rank 10 - its rank-up is off the walls list/.test(l)), a.lastLog.join('|'));
  // Still below rank 10: the block stays, and other work behind the same wall is never touched.
  const c = fakeBot('wr3', { unrankedClasses: async () => [{ name: 'Cryomancer', cp: 900 }] });
  const hub2 = fakeHub([c, b]);
  hub2.walls.note(c, RANK, 'died 8x to Frost Spirit in 30 min', { boss: 'Frost Spirit' });
  hub2.walls.note(c, FJ, 'died 8x to Frost Spirit in 30 min', { boss: 'Frost Spirit' });
  await hub2.walls.pruneRanked([c]);
  eq(Object.keys(hub2.walls.data.walls['frost spirit'].blocks.wr3.tasks).length, 2);
  eq(hub2.walls.dropRank(c, 'Cryomancer'), 1);
  eq(Object.values(hub2.walls.data.walls['frost spirit'].blocks.wr3.tasks).map((t) => t.goal), ['farmer-joe']);
});

test('walls: an escort that got somebody past is followed by the next one 3 min later; failed escorts still back off', async () => {
  const a = fakeBot('ws1'); const b = fakeBot('ws2'); const c = fakeBot('ws3');
  const hub = fakeHub([a, b, c], { escorts: 'on' });
  hub.walls.note(a, FJ, 'died 8x to Ultra Chaos Alteon in 30 min', { boss: 'Ultra Chaos Alteon' });
  hub.walls.note(b, FJ, 'died 8x to Void Draconian in 30 min', { boss: 'Void Draconian' });
  let now = Date.now();
  const e1 = await hub.walls.tick(now);
  assert(e1, 'first escort');
  const first = e1.needers[0];
  hub.walls.end(Object.assign(e1, { passed: { [first]: now + 1000 } }), 'all needers are through', now + 60000);
  eq(/^past for /.test(e1.result), true);
  eq(await hub.walls.tick(now + 2 * 60000), null, 'not inside the 3 min gap');
  const e2 = await hub.walls.tick(now + 5 * 60000);
  assert(e2 && e2.id !== e1.id, 'the next wall 5 min after progress, not 2 h later');
});
