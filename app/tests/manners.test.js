// Public-room manners (lib/manners.js), the owner 2026-09-27: wait for 5 players and a boss already being fought.
const manners = require('../lib/manners');
const { HeadlessClient } = require('../lib/net/headless');
const crowd = require('../lib/crowd');
// The rules before the boss ladder (crowd.json "ladder": false): dailies public only, "hopeless" bosses wait for a crowd.
const oldRules = (fn) => async () => { const was = crowd.LADDER; crowd.setLadder(false); try { return await fn(); } finally { crowd.setLadder(was); } };

// A headless client in thevoid-3 (public) with a boss in r5, run through the real attack/useSkill code.
function voidClient({ area = 'thevoid-3', crowdTask = true, daily = false, chain = false, solo = {}, strangers = 0, inCell = 0, ours = [], privateRoom = null, bossHp = 900000 } = {}) {
  const c = new HeadlessClient({ id: 'nova7', username: 'Nova7' });
  c.reset();
  const sent = [];
  c.xt = (cmd, args) => sent.push([cmd, args]);     // no socket
  c.w.strAreaName = area; c.w.strMapName = 'thevoid'; c.w.strFrame = 'r5';
  c.w.myAvatar.uid = 1; c.w.myAvatar.dataLeaf.intHPMax = 3000;
  c.w.users = { nova7: { strFrame: 'r5' } };
  c.w.myAvatar.objData.strUsername = 'nova7';
  for (let i = 0; i < strangers; i++) c.w.users[`player${i}`] = { strFrame: i < inCell ? 'r5' : 'Enter' };
  for (const n of ours) c.w.users[n] = { strFrame: 'r5' };
  c.w.monsters = [
    { MonMapID: 1, strMonName: 'Nightbane', strFrame: 'r5', intHP: bossHp, intHPMax: bossHp, intState: 1, intLevel: 100 },
    { MonMapID: 2, strMonName: 'Void Shade', strFrame: 'r5', intHP: 2000, intHPMax: 2000, intState: 1, intLevel: 60 },
  ];
  const said = [];
  c.on('manners', (e) => said.push(e));
  c.manners = { crowd: () => crowdTask, daily: () => daily, chainDaily: () => chain, isBoss: (hp) => hp >= 24000, solo: () => solo, ours: () => ({ names: new Set(ours), uids: new Set(['p:77']) }), wall: () => false, privateRoom: () => privateRoom };
  return { c, said, sent };
}
const nightbane = (c) => c.w.monsters[0];
const hitBy = (c, who, dmgTo = 850000) => c.onCombat({ m: { 1: { intHP: dmgTo } }, sara: [{ actionResult: { cInf: `p:${who}`, tInf: 'm:1' } }] });

test('manners: never opens a boss fight in a public room; trash is fine', async () => {
  const { c, said, sent } = voidClient({ strangers: 8 });
  eq(c.attack('Nightbane'), false, 'nobody is fighting it yet');
  eq(sent.find((x) => x[0] === 'moveToCell'), ['moveToCell', ['Enter', 'Spawn']], 'waits outside the boss cell');
  eq(c.w.myAvatar.target, null);
  assert(c.mannersWait && !c.mannersWait.gaveUp, 'waiting');
  eq(said.length, 1, 'said once'); assert(/not starting it alone/.test(said[0].text), said[0].text);
  c.attack('Nightbane');
  eq(said.length, 1, 'not repeated');
  c.w.strFrame = 'r5';
  eq(c.attack('Void Shade'), true, 'ordinary monsters are not held back');
});

test('manners: players standing in the boss cell count as fighting it', async () => {
  const { c, sent } = voidClient({ strangers: 5, inCell: 2 });
  c.w.strFrame = 'Enter';
  eq(manners.check(c, nightbane(c)).ok, true, '5 in the room, 2 at the boss');
  eq(sent.find((x) => x[0] === 'moveToCell'), ['moveToCell', ['r5', 'Left']], 'goes back into the boss cell');
});

test('manners: a jump into the cell of a boss it waits on is held back', async () => {
  const { c } = voidClient({ strangers: 1 });
  c.attack('Nightbane');
  c.w.strFrame = 'Enter';
  eq(manners.blocksCell(c, 'r5'), true, 'boss cell held');
  eq(manners.blocksCell(c, 'r2'), false, 'other cells are fine');
  c.sock = { destroyed: false, write: () => {} }; c.swf = { onOutgoing() {} }; c.flush = () => {};
  c.outbox = [];
  c.write('%xt%zm%moveToCell%1%r5%Left%');
  eq(c.outbox.length, 0, 'the packet is not sent');
  c.write('%xt%zm%moveToCell%1%r2%Left%');
  eq(c.outbox.length, 1);
  c.sock = null;
});

test('manners: 5 real players and falling HP -> joins; our own bots do not count', async () => {
  let { c } = voidClient({ strangers: 4, ours: ['valen7', 'oren7'] });
  hitBy(c, 42);
  eq(c.attack('Nightbane'), false, '4 real players + 2 of ours is not 5 people');
  ({ c } = voidClient({ strangers: 5 }));
  hitBy(c, 77);
  eq(c.attack('Nightbane'), false, 'a hit from one of our bots is not "being fought"');
  hitBy(c, 42);
  eq(c.attack('Nightbane'), true, '5 players and a stranger hitting it');
  eq(c.mannersWait, null);
  c.myHits.set(1, Date.now());
  c.othersHits.set(1, Date.now() - 45000);
  c.w.users = { nova7: { strFrame: 'r5' }, a: {}, b: {} };                  // most players left mid-fight
  eq(manners.check(c, nightbane(c)).ok, true, 'keeps helping while others still hit it');
  c.othersHits.set(1, Date.now() - 90000);
  eq(manners.check(c, nightbane(c)).ok, false, 'stops when it would finish it alone');
  c.w.myAvatar.target = nightbane(c);
  eq(c.useSkill(1), false, 'skills are held too'); eq(c.w.myAvatar.target, null, 'and the target dropped');
});

test('manners: a boss beaten before is simply fought (the owner: do it by themselves)', async () => {
  let { c } = voidClient({ solo: { Nightbane: '2026-09-20' } });
  eq(c.attack('Nightbane'), true, 'empty room, beaten it before');
  ({ c } = voidClient({ solo: { Nightbane: 'seeded: daily NCSGem turned in before' }, strangers: 2, inCell: 2 }));
  eq(c.attack('Nightbane'), true, 'players around do not change that');
});

test('manners: after the wait, a boss it may beat is tried in the party room; a hopeless one is left alone (old rules)', oldRules(async () => {
  let { c, said, sent } = voidClient({ strangers: 1, privateRoom: 13579 });
  const t0 = Date.now();
  for (let m = 0; m < 15; m++) manners.check(c, nightbane(c), t0 + m * 60000);
  const v = manners.check(c, nightbane(c), t0 + 15 * 60000);
  eq([v.gaveUp, v.fallback], [true, true]);
  assert(said.some((e) => e.kind === 'private'), 'said so');
  eq(sent.find((x) => x[0] === 'cmd'), ['cmd', ['tfer', 'nova7', 'thevoid-13579', 'r5', 'Left']], 'same map, party room');
  ({ c, said, sent } = voidClient({ strangers: 1, privateRoom: 13579, bossHp: 8195130 }));
  for (let m = 0; m <= 30; m++) manners.check(c, nightbane(c), t0 + m * 60000);
  assert(said.some((e) => e.kind === 'skip' && /needs a crowd/.test(e.text)), 'Desolich-sized: waits for players another time');
  eq(sent.filter((x) => x[0] === 'cmd').length, 0, 'no private try');
}));

test('manners: private rooms and quiet content are not held back; ultras never public', async () => {
  let { c } = voidClient({ area: 'thevoid-13579' });
  eq(c.attack('Nightbane'), true, 'private room');
  ({ c } = voidClient({ crowdTask: false }));
  eq(c.attack('Nightbane'), true, 'not crowded content');
});

test('manners: gives up after the wait limit and leaves the boss alone for a while', async () => {
  const { c, said } = voidClient({ daily: true, strangers: 1 });
  const t0 = Date.now();
  eq(manners.check(c, nightbane(c), t0).ok, false);
  for (let m = 1; m < 15; m++) manners.check(c, nightbane(c), t0 + m * 60000);
  const v = manners.check(c, nightbane(c), t0 + 15 * 60000);
  eq(v.gaveUp, true, 'dailies wait 15 min');
  assert(said.some((e) => e.kind === 'skip'), 'said so');
  eq(manners.check(c, nightbane(c), t0 + 60 * 60000).gaveUp, true, 'still skipped an hour later');
  eq(manners.check(c, nightbane(c), t0 + 3 * 3600000).gaveUp, false, 'a new wait after the skip');
});

test('manners: no whole-cell pulls with strangers in the cell', async () => {
  const sent = [];
  let { c } = voidClient({ strangers: 1 });
  c.xt = (cmd, args) => sent.push([cmd, args]);
  c.provoke = true;
  c.attack('*');
  eq(sent.find((x) => x[0] === 'aggroMon')[1], [2], 'one monster only');
  ({ c } = voidClient({ area: 'thevoid-13579', strangers: 1 }));
  sent.length = 0; c.xt = (cmd, args) => sent.push([cmd, args]); c.provoke = true;
  c.w.myAvatar.objData.intLevel = 100;                // provoke only pulls what this character out-levels
  c.attack('*');
  eq(sent.find((x) => x[0] === 'aggroMon')[1].length, 2, 'private room: pull as before');
});

test('dailies: a failed daily is tried again on the next shared window after 2 h, 3 tries a day; done stays done', async () => {
  const { Brain } = require('../lib/brain');
  const crowd = require('../lib/crowd');
  const b = Object.create(Brain.prototype);
  const day = { dailies: { NCSGem: 'failed', MineCrafting: 'done' } };
  eq(b.dailyRetry(day, 'NCSGem'), true, 'an old failure (no time kept) is retried');
  eq(b.dailyRetry(day, 'MineCrafting'), false);
  b.dailyFailed(day, 'NCSGem');
  eq(b.dailyRetry(day, 'NCSGem'), false, 'not right away');
  const at = day.dailyFailAt.NCSGem;
  eq(b.dailyRetry(day, 'NCSGem', at + 2 * 3600000 - 1000), false, 'not before 2 h');
  eq(b.dailyRetry(day, 'NCSGem', crowd.windowAfter(at)), true, 'on the shared window after 2 h (with every other retry)');
  day.dailyFailAt.NCSGem -= 4 * 3600000 + 1000;
  eq(b.dailyRetry(day, 'NCSGem'), true, 'hours later');
  b.dailyFailed(day, 'NCSGem'); b.dailyFailed(day, 'NCSGem');
  day.dailyFailAt.NCSGem -= 3 * 3600000;
  eq(b.dailyRetry(day, 'NCSGem'), false, 'three tries a day');
});

test('manners: waiting outside the boss cell keeps the wait alive and steps in when players come', async () => {
  const { c, sent } = voidClient({ strangers: 1 });
  eq(c.attack('Nightbane'), false);
  c.w.strFrame = 'Enter';                            // stepped out
  c.mannersWait.last = Date.now() - 60000;
  eq(c.attack('Nightbane'), false, 'nothing to hit from Enter');
  assert(Date.now() - c.mannersWait.last < 1000, 'the wait is still alive (not "no monster here")');
  for (let i = 0; i < 5; i++) c.w.users[`late${i}`] = { strFrame: i < 2 ? 'r5' : 'Enter' };
  sent.length = 0;
  c.attack('Nightbane');
  eq(c.mannersWait, null, 'the fight may start');
  eq(sent.find((x) => x[0] === 'moveToCell'), ['moveToCell', ['r5', 'Left']], 'steps into the boss cell');
});

test('manners: a character waiting outside the boss cell moves once a minute (NoAFK maps kick AFK players)', async () => {
  const { c, sent } = voidClient({ strangers: 1 });
  const t0 = Date.now();
  manners.check(c, nightbane(c), t0);                // steps out to Enter
  c.w.strFrame = 'Enter';
  sent.length = 0;
  for (let s = 1; s <= 30; s++) manners.check(c, nightbane(c), t0 + s * 1000);
  eq(sent.filter((x) => x[0] === 'moveToCell').length, 0, 'not every check');
  for (let s = 31; s <= 190; s++) manners.check(c, nightbane(c), t0 + s * 1000);
  const moves = sent.filter((x) => x[0] === 'moveToCell');
  eq(moves.length, 3, 'once a minute (61, 121, 181 s)');
  eq(moves[0][1][0], 'Enter', 'in the cell it waits in');
  assert(moves[0][1][1] !== moves[1][1][1], 'changing pads');
});

test('manners: a daily wait kept alive only by recheck still gives up after dailyWaitMin (watchdog, 2026-09-28)', async () => {
  const { c, said } = voidClient({ strangers: 1, daily: true });
  const t0 = Date.now();
  eq(c.attack('Nightbane'), false);
  c.w.strFrame = 'Enter';                            // outside the cell; the Skua script stops asking
  let r = null;
  for (let m = 1; m <= 16 && !(r && r.gaveUp); m++) r = manners.recheck(c, c.mannersWait.boss, t0 + m * 60000);
  assert(r && r.gaveUp, 'the watchdog recheck reaches the daily limit');
  assert(said.some((e) => e.kind === 'skip' || e.kind === 'private'), 'says it gives up');
});

test('watchdog: a stuck step whose Skua anti-AFK cell alternates still counts as the same step', async () => {
  const { Hub } = require('../lib/hub');
  const bot = { itemProgress: 0, taskKey: () => 'loo' };
  const t = { type: 'script', path: 'Dailies/LordOfOrder.cs' };
  eq(Hub.stuckAgain(bot, t, '(RetryCellOnAFK) Jump request to [Enter, Spawn] sent as an anti-AFK measure.'), false);
  eq(Hub.stuckAgain(bot, t, '(RetryCellOnAFK) Jump request to [Enter, Left] sent as an anti-AFK measure.'), true);
});

// A4 (audit 2026-09-28): Archfiend restarted ~10 times on 09-27 without parking, because unrelated drops counted.
test('watchdog: a step that names its item counts only that item (or a turn-in) as progress', async () => {
  const { Hub } = require('../lib/hub');
  eq(Hub.stepItem('(HuntMonster) Killing Desolich for item: "Steadfast Medal" 0/1'), { item: 'Steadfast Medal', have: 0, want: 1 });
  eq(Hub.stepItem('(_KillForItem) Farming Dreadhaven Helm (3/10)'), { item: 'Dreadhaven Helm', have: 3, want: 10 });
  eq(Hub.stepItem('(BuyAllMerge) Farming Doom Doubloon (12/300)'), { item: 'Doom Doubloon', have: 12, want: 300 });
  eq(Hub.stepItem('(HuntMonster) Killing Earth Elemental for item: No Explosion 0/15'), { item: 'No Explosion', have: 0, want: 15 });
  eq(Hub.stepItem('(RetryCellOnAFK) Jump request to [Enter, Spawn] sent as an anti-AFK measure.'), null);
  const t = { type: 'script', path: 'Other/Archfiend.cs' };
  const bot = { itemProgress: 0, stats: { quests: 0 }, taskKey: () => 'arch' };
  eq(Hub.stuckAgain(bot, t, '(HuntMonster) Killing Archfiend for item: "Archfiend Essence" 2/5'), false);
  bot.itemProgress = 7;                                   // other drops came in
  eq(Hub.stuckAgain(bot, t, '(HuntMonster) Killing Archfiend for item: "Archfiend Essence" 2/5'), true, 'its own item did not move: parked');
  eq(Hub.stuckAgain(bot, t, '(HuntMonster) Killing Archfiend for item: "Archfiend Essence" 2/5'), false);
  eq(Hub.stuckAgain(bot, t, '(HuntMonster) Killing Archfiend for item: "Archfiend Essence" 3/5'), false, 'its own item moved: working');
  bot.stats.quests++;
  eq(Hub.stuckAgain(bot, t, '(HuntMonster) Killing Archfiend for item: "Archfiend Essence" 3/5'), false, 'a turn-in of the chain is progress too');
});

// Nova 2026-10-07: Asherion Armor is a 1% drop; two stalls parked VerusDoomKnight for 24 h every time.
test('watchdog: a rare drop keeps farming while kills come, and parks when they stop', async () => {
  const { Hub } = require('../lib/hub');
  const step = '(HuntMonsterMapID) Farming 💎 Asherion Armor (#/#)';
  eq(Hub.rareDrop(step).item, 'Asherion Armor');
  eq(Hub.rareDrop('(HuntMonster) Killing Archfiend for item: "Archfiend Essence" #/#'), null);
  const t = { type: 'script', path: 'Other/Classes/VerusDoomKnight.cs' };
  const bot = { itemProgress: 0, stats: { quests: 0, kills: 0 }, taskKey: () => 'vdk' };
  eq(Hub.stuckAgain(bot, t, step), false);
  for (let i = 0; i < 5; i++) { bot.stats.kills += 40; eq(Hub.stuckAgain(bot, t, step), false, `stall ${i + 2} with kills: still farming`); }
  eq(Hub.stuckAgain(bot, t, step), true, 'no kills since the last stall: parked');
  const b2 = { itemProgress: 0, stats: { quests: 0, kills: 0 }, taskKey: () => 'vdk2' };
  eq(Hub.stuckAgain(b2, t, step), false);
  for (let i = 0; i < 6; i++) { b2.stats.kills += 40; eq(Hub.stuckAgain(b2, t, step), false); }
  b2.stats.kills += 40;
  eq(Hub.stuckAgain(b2, t, step), true, 'the stall cap (8) parks it even with kills');
});

// The owner 2026-10-05: wait for players only when the party couldn't take the boss either.
test('manners: partyFirst - a boss the party can take goes to the party room at once, no public wait', async () => {
  const { c, said, sent } = voidClient({ strangers: 1, privateRoom: 13579 });
  const v = manners.check(c, nightbane(c));
  eq([v.ok, v.gaveUp, v.fallback], [false, true, true], 'no wait');
  assert(said.some((e) => e.kind === 'private' && /party can take it/.test(e.text)), 'said so');
  eq(sent.find((x) => x[0] === 'cmd'), ['cmd', ['tfer', 'nova7', 'thevoid-13579', 'r5', 'Left']]);
  const w = voidClient({ strangers: 1, privateRoom: 13579 });
  w.c.manners.wall = () => true;
  eq(manners.check(w.c, nightbane(w.c)).gaveUp, false, 'a party wall still waits for players');
});

test('manners: a boss the quest wants you to die to (Akriloth, firewar) is attacked at once', async () => {
  const { c } = voidClient({ strangers: 0, bossHp: 819830970 });
  c.w.strMapName = 'firewar'; c.w.strAreaName = 'firewar-1';
  c.w.monsters[0].strMonName = 'Akriloth';
  eq(manners.check(c, nightbane(c)).ok, true, 'Confront Akriloth needs the death, not a kill');
  c.w.strMapName = 'thevoid';
  eq(manners.check(c, nightbane(c)).ok, false, 'only on its own map');
});

test('hub: deaths to a dieTo boss are not struggling or a death cap; a daily in the party room may call the party', async () => {
  const { Hub } = require('../lib/hub');
  const h = Object.create(Hub.prototype);
  const w = { strMapName: 'firewar', strAreaName: 'firewar-1', myAvatar: { dataLeaf: { intHPMax: 3000 } } };
  const bot = { id: 'b', client: { w }, current: { type: 'script', path: 'Dailies/LordOfOrder.cs', recurring: 'loo-daily', brain: true }, taskKey: () => 'loo' };
  eq(await h.bossDeath(bot, { name: 'Akriloth', hpMax: 819830970 }), null);
  eq(h.deathCap(bot, { name: 'Akriloth', hpMax: 819830970 }), false);
  let called = null;
  h.settings = { levelParty: { room: 13579 } }; h.bots = new Map(); h.partyWalls = {};
  h.soloBosses = () => ({});
  h.requestHelp = async (b, info) => (called = info);
  const b2 = { ...bot, client: { w: { ...w, strMapName: 'thevoid', strAreaName: 'thevoid-13579' }, playersHere: () => [] }, journal() {}, map: async () => 'thevoid', cell: async () => 'r5', name: async () => 'b' };
  await h.struggle(b2, { name: 'Nightbane', hpMax: 900000, cell: 'r5' }, 2);
  assert(called && called.monster === 'Nightbane', 'party called in the private room');
  called = null;
  b2.client.w.strAreaName = 'thevoid-3';
  await h.struggle(b2, { name: 'Nightbane', hpMax: 900000, cell: 'r5' }, 2);
  eq(called, null, 'not from a public room');
});

test('headless: dying to Akriloth in firewar with Confront Akriloth in progress asks for map item 5799 (map code)', async () => {
  const { c, sent } = voidClient();
  c.w.strMapName = 'firewar'; c.w.myAvatar.uid = 1;
  const notes = []; c.on('mapNote', (t) => notes.push(t));
  c.handleJson('playerDeath', { cmd: 'playerDeath', userID: 1, monPad: 23 });
  eq(sent.filter((x) => x[0] === 'getMapItem').length, 0, 'quest not in progress');
  c.accepted.add(6299);
  c.handleJson('playerDeath', { cmd: 'playerDeath', userID: 2, monPad: 23 });
  eq(sent.filter((x) => x[0] === 'getMapItem').length, 0, 'someone else died');
  c.handleJson('playerDeath', { cmd: 'playerDeath', userID: 1, monPad: 23 });
  eq(sent.find((x) => x[0] === 'getMapItem'), ['getMapItem', [5799]]);
  eq(notes.length, 1);
});

// The owner 2026-10-07: "the NSoD daily itself should be done at artix, dont start the fight unless there is enough people".
test('manners: a chain daily (Lord of Order) takes a boss the party can handle to the party room at once (old rules)', oldRules(async () => {
  const { c, said } = voidClient({ daily: true, chain: true, privateRoom: 13579 });
  const v = manners.check(c, nightbane(c));
  eq([v.ok, v.fallback], [false, true], 'partyFirst: straight to the party room, no public wait');
  assert(said.some((e) => e.kind === 'private') && !said.some((e) => e.kind === 'wait'));
  const h = voidClient({ daily: true, chain: true, privateRoom: 13579, bossHp: 3000 * 500 });
  eq(!!manners.check(h.c, nightbane(h.c)).fallback, false, 'a hopeless boss still waits for a crowd'); assert(h.said.some((e) => e.kind === 'wait'));
  const crowd = require('../lib/crowd');
  eq([crowd.chainDaily('Dailies/LordOfOrder.cs'), crowd.chainDaily('Dailies\\LordOfOrder.cs'), crowd.chainDaily('Dailies/NSoDDaily.cs')], [true, true, false]);
}));

test('manners: a daily boss is never taken to the party room - it waits for players in public, then leaves it (old rules)', oldRules(async () => {
  const { c, said, sent } = voidClient({ daily: true, strangers: 1, privateRoom: 13579 });
  const t0 = Date.now();
  const v0 = manners.check(c, nightbane(c), t0);
  eq([v0.ok, v0.gaveUp], [false, false], 'no partyFirst for a daily: it waits');
  assert(said.some((e) => e.kind === 'wait'), 'said it waits');
  for (let m = 1; m < 15; m++) manners.check(c, nightbane(c), t0 + m * 60000);
  const v = manners.check(c, nightbane(c), t0 + 15 * 60000);
  eq([v.gaveUp, v.fallback], [true, false], 'after dailyWaitMin it is left alone, no private try');
  eq(sent.filter((x) => x[0] === 'cmd').length, 0, 'never moved to the party room');
  assert(said.some((e) => e.kind === 'skip') && !said.some((e) => e.kind === 'private'));
  const w = voidClient({ daily: true, strangers: 5, privateRoom: 13579 });
  hitBy(w.c, 42);
  eq(manners.check(w.c, nightbane(w.c)).ok, true, 'joins once 5 players are fighting it');
  const s2 = voidClient({ daily: true, privateRoom: 13579, solo: { Nightbane: '2026-10-01' } });
  eq(manners.check(s2.c, nightbane(s2.c)).ok, true, 'a boss beaten before is still just fought');
}));

// The owner 2026-10-09: "IF A BOSS CAN BE soloed by a bot then he doesnt need to wait for people, if it cant be soloed call
// the party, if they cant do it as a 4 then the last option is to wait for public people to help."
test('ladder: at the public step, a daily or a huge boss the party has not lost to still goes to the party room first', async () => {
  for (const opts of [{ daily: true }, { bossHp: 8195130 }, { daily: true, bossHp: 8195130 }]) {
    const { c, said, sent } = voidClient({ ...opts, strangers: 1, privateRoom: 13579 });
    const v = manners.check(c, nightbane(c));
    eq([v.ok, v.fallback], [false, true], JSON.stringify(opts) + ': the party room, no public wait');
    assert(said.some((e) => e.kind === 'private') && !said.some((e) => e.kind === 'wait'), JSON.stringify(opts));
    eq(sent.find((x) => x[0] === 'cmd'), ['cmd', ['tfer', 'nova7', 'thevoid-13579', 'r5', 'Left']]);
  }
});

test('ladder: a boss the whole party lost to waits for players in public - the last option - and never goes back private', async () => {
  const { c, said, sent } = voidClient({ daily: true, strangers: 1, privateRoom: 13579 });
  c.manners.wall = (n) => n === 'Nightbane';
  const t0 = Date.now();
  const v0 = manners.check(c, nightbane(c), t0);
  eq([v0.ok, v0.gaveUp], [false, false], 'waits');
  assert(said.some((e) => e.kind === 'wait'));
  for (let m = 1; m <= 15; m++) manners.check(c, nightbane(c), t0 + m * 60000);
  assert(said.some((e) => e.kind === 'skip' && /could not kill it either/.test(e.text)), said.map((e) => e.text).join(' | '));
  eq(sent.filter((x) => x[0] === 'cmd').length, 0, 'never back to the party room');
  const w = voidClient({ daily: true, strangers: 5, privateRoom: 13579 });
  w.c.manners.wall = () => true;
  hitBy(w.c, 42);
  eq(manners.check(w.c, nightbane(w.c)).ok, true, 'joins once 5 players are fighting it');
});

test('ladder: in the party room a boss the party lost to today sends the task public; anything else is just fought', async () => {
  const mk = (over = {}) => {
    const r = voidClient({ area: 'thevoid-13579', crowdTask: false, privateRoom: 13579 });
    Object.assign(r.c.manners, { wall: (n) => n === 'Nightbane', canGoPublic: () => true }, over);
    return r;
  };
  let { c, said } = mk();
  const t0 = Date.now();
  const v = manners.check(c, nightbane(c), t0);
  eq([v.ok, v.gaveUp], [false, true], 'not fought again in the party room');
  eq(said.filter((e) => e.kind === 'public').length, 1, 'the hub is told (goPublic)');
  manners.check(c, nightbane(c), t0 + 20000);
  eq(said.filter((e) => e.kind === 'public').length, 1, 'once a minute at most');
  manners.check(c, nightbane(c), t0 + 61000);
  eq(said.filter((e) => e.kind === 'public').length, 2);
  eq(manners.check(c, c.w.monsters[1], t0).ok, true, 'trash is fought');
  ({ c } = mk({ wall: () => false }));
  eq(manners.check(c, nightbane(c)).ok, true, 'not a party wall: solo, then the party');
  ({ c } = mk({ solo: () => ({ Nightbane: '2026-10-01' }) }));
  eq(manners.check(c, nightbane(c)).ok, true, 'beaten alone before: fought');
  ({ c } = mk({ canGoPublic: () => false }));
  eq(manners.check(c, nightbane(c)).ok, true, 'raids, helpers, guests: never sent public');
  const was = crowd.LADDER;
  crowd.setLadder(false);
  try { ({ c } = mk()); eq(manners.check(c, nightbane(c)).ok, true, 'old rules: no ladder'); } finally { crowd.setLadder(was); }
});

// 2026-10-22: the main's "Unlock Elysium" order was dropped while its cause (backpack full) was being fixed.
test('watchdog: a fixable stall runs its remedy first and keeps the task; a second one inside 2 h falls back to the old rules', async () => {
  const { Hub } = require('../lib/hub');
  const bot = { taskKey: (t) => t.path, save() {} };
  const t = { type: 'script', path: 'Enhancement/UnlockForgeEnhancements.cs', why: 'Unlock Elysium' };
  const dx = { cause: 'backpack full', remedy: { type: 'bankAc' } };
  const now = Date.now();
  eq(Hub.remedyFirst(bot, t, dx, now), true, 'first time: fix it and keep the order');
  eq([bot._pushFront.length, bot._pushFront[0].type], [1, 'bankAc'], 'the remedy goes ahead of the requeued order');
  eq(Hub.remedyFirst(bot, t, dx, now + 60000), false, 'the fix did not help: no second free pass');
  eq(Hub.remedyFirst(bot, t, { cause: 'other', remedy: { type: 'tidy' } }, now + 60000), true, 'another cause gets its own try');
  eq(Hub.remedyFirst(bot, t, dx, now + 3 * 3600000), true, 'and the same cause again after 2 h');
});
