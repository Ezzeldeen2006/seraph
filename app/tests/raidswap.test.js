// The owner 2026-10-16: a raid that lacks DPS gets his main in the boss script's DPS seat (Drakath: StoneCrusher); that
// seat's bot goes back to its work; after the kill one bot with its kill goes home, the swapped bot rejoins in its
// seat for its own kill with the main, then everyone goes back to what they were doing.
const { Hub } = require('../lib/hub');

const R10 = 302500;
const SEATS = [{ id: 'sable7', cls: 'Lord of Order' }, { id: 'nova7', cls: 'StoneCrusher' }, { id: 'oren7', cls: 'ArchPaladin' }, { id: 'valen7', cls: 'Shaman' }];
const OWNS = {
  sable7: ['Lord of Order', 'ArchPaladin', 'StoneCrusher', 'Shaman'],
  nova7: ['Lord of Order', 'ArchPaladin', 'StoneCrusher'],
  oren7: ['Lord of Order', 'ArchPaladin', 'StoneCrusher'],
  valen7: ['Lord of Order', 'ArchPaladin', 'StoneCrusher', 'Shaman'],
  grail26: ["King's Echo", 'StoneCrusher', 'ArchPaladin', 'Lord of Order', 'Shaman'],
};

function swapHub(bossHp) {
  const h = Object.create(Hub.prototype);
  h.settings = {}; h.infos = []; h.notes = [];
  h.info = (t) => h.infos.push(t); h.notify = (t) => h.notes.push(t); h.saveSettings = () => {};
  h.bots = new Map();
  for (const id of Object.keys(OWNS)) {
    const guest = id === 'grail26';
    h.bots.set(id, {
      id, running: true, paused: false, serverName: 'Swordhaven (EU)', queue: [], settings: {}, restarts: 0, turnedIn: new Map(),
      account: { label: id, username: id, kind: guest ? 'guest' : 'party', helper: guest },
      client: { state: { loaded: true }, call: async (fn) => (fn === 'getMonsters' ? [{ strMonName: 'Champion Drakath', intHP: bossHp.hp, intHPMax: 20000000 }] : null) },
      current: guest ? { type: 'script', path: 'Other/Classes/ArcanaInvoker.cs', brain: true } : { type: 'script', raid: 'raid-1' },
      journal() {}, restart() { this.restarts++; },
      classPoints: async () => OWNS[id].map((name) => ({ name, cp: R10 })),
    });
  }
  h.bot = (id) => h.bots.get(id);
  h.raidSeats = (s) => { h.seatsWritten = s; return s; };
  h.raid = { id: 'raid-1', boss: 'champion-drakath', name: 'Champion Drakath', quest: 8300, every: 'week', started: 0, members: ['sable7', 'nova7', 'oren7', 'valen7'], seats: SEATS, back: {} };
  return h;
}
const MIN = 60000;

test('raid swap: a fast fight is left alone', async () => {
  const hp = { hp: 20000000 };
  const h = swapHub(hp);
  for (let m = 0; m <= 20; m++) { hp.hp = 20000000 - m * 550000; await h.raidWatch(h.raid, m * MIN + 1); }
  eq(h.raid.id, 'raid-1', 'same raid');
  eq(h.raid.swap, undefined, 'no swap: ~36 min fight');
});

test('raid swap: too slow -> the main takes the DPS seat, its bot goes back to work, the others restart with him', async () => {
  const hp = { hp: 20000000 };
  const h = swapHub(hp);
  const r1 = h.raid;
  for (let m = 0; m <= 16 && h.raid === r1; m++) { hp.hp = 20000000 - m * 150000; await h.raidWatch(r1, m * MIN + 1); }
  const r = h.raid;
  assert(r !== r1, h.infos.join(' | '));
  eq(r.swap.phase, 1);
  eq(r.swap.out, 'nova7', 'the StoneCrusher (DPS) seat');
  eq(r.members.sort().join(','), 'grail26,oren7,sable7,valen7');
  eq(r.seats.find((s) => s.id === 'grail26').cls, 'StoneCrusher', 'the main in the DPS seat');
  eq(h.bot('nova7').restarts, 1, 'Nova back to her own work');
  eq(h.bot('grail26').restarts, 1, 'the main switches to the raid now');
  assert(!(h.settings.raids.tries || {})['champion-drakath'], 'a hand-over is not a failed try');
  assert(h.infos.some((t) => /lacks DPS/.test(t)), h.infos.join(' | '));
});

test('raid swap: after the kill, a bot with its kill goes home and the swapped bot rejoins for its own; round 2 books the boss', async () => {
  const hp = { hp: 20000000 };
  const h = swapHub(hp);
  h.raid.fight = { startAt: 1, samples: [{ at: 1, hp: 20000000 }] };
  hp.hp = 19000000;
  await h.raidSwapIn(h.raid, require('../lib/ultraready').BOSSES.find((b) => b.id === 'champion-drakath'), 'test', 20 * MIN);
  const r = h.raid;
  const t = Date.now();
  for (const id of r.members) { h.bot(id).turnedIn.set(8300, t); r.started = t - 1000; }
  for (const id of r.members) h.raidDone(h.bot(id), { type: 'script', raid: r.id }, true);
  await new Promise((res) => setTimeout(res, 20));
  const r2 = h.raid;
  assert(r2 && r2 !== r, `round 2 started: ${h.infos.join(' | ')}`);
  eq(r2.swap.phase, 2);
  assert(r2.members.includes('nova7') && r2.members.includes('grail26'), 'Nova rejoins with the main');
  const gone = ['sable7', 'oren7', 'valen7'].find((id) => !r2.members.includes(id));
  assert(gone, 'one bot that has its kill goes back to its work');
  eq(r2.seats.find((s) => s.id === 'nova7').cls, SEATS.find((s) => s.id === gone).cls, 'Nova takes that seat');
  eq(r2.seats.find((s) => s.id === 'grail26').cls, 'StoneCrusher', 'the main stays DPS');
  assert(!(h.settings.raids.done || {})['champion-drakath'], 'not booked before round 2');
  // Round 2: the credited ones can't turn in again - they don't call it off; Nova's kill ends it.
  h.raidDone(h.bot(r2.members.find((id) => !['nova7', 'grail26'].includes(id))), { type: 'script', raid: r2.id }, false);
  assert(h.raid === r2, 'a credited member back early does not call round 2 off');
  h.bot('nova7').turnedIn.set(8300, Date.now() + 5000);
  for (const id of r2.members) h.raidDone(h.bot(id), { type: 'script', raid: r2.id }, true);
  eq(h.raid, null, 'everyone goes back to what they were doing');
  assert(h.settings.raids.done['champion-drakath'], 'booked for the week');
});

test('raid swap: never while the owner plays his main, while it runs his own order, or for a boss without a known DPS seat', async () => {
  const hp = { hp: 20000000 };
  let h = swapHub(hp);
  h.bot('grail26').client._holdOffline = true;
  const boss = require('../lib/ultraready').BOSSES.find((b) => b.id === 'champion-drakath');
  eq(await h.raidSwapIn(h.raid, boss, 'slow', 20 * MIN), null);
  assert(h.infos.some((t) => /not free/.test(t)), 'logged why');
  h = swapHub(hp);
  h.bot('grail26').queue = [{ type: 'script', path: 'his-order.cs' }];
  eq(await h.raidSwapIn(h.raid, boss, 'slow', 20 * MIN), null, 'his order first');
  h = swapHub(hp);
  h.raid.boss = 'ultra-nulgath';
  eq(await h.raidWatch(h.raid, 30 * MIN), null, 'no dpsSeat: no swap');
});

test('raid: a fight that cannot be won before the 3 h limit is called off when no swap can help; a slow one goes on', async () => {
  const hp = { hp: 19000000 };
  let h = swapHub(hp);
  h.bot('grail26').client._holdOffline = true;   // The owner is playing his main
  const r1 = h.raid;
  for (let m = 0; m <= 30 && h.raid === r1; m++) await h.raidWatch(r1, m * MIN + 1);
  eq(h.raid, null, h.infos.join(' | '));
  assert(h.infos.some((t) => /calling off Champion Drakath - Champion Drakath is not going down/.test(t)), h.infos.join(' | '));
  eq(h.settings.raids.tries['champion-drakath'].n, 1, 'a try for the week');
  for (const id of ['sable7', 'nova7', 'oren7', 'valen7']) eq(h.bot(id).restarts, 1, `${id} back to its work`);
  // 150k HP/min: ~2 h, inside the limit - it keeps fighting.
  hp.hp = 20000000;
  h = swapHub(hp);
  h.bot('grail26').client._holdOffline = true;
  const r2 = h.raid;
  for (let m = 0; m <= 40; m++) { hp.hp = 19900000 - m * 150000; await h.raidWatch(r2, m * MIN + 1); }
  eq(h.raid, r2, h.infos.join(' | '));
});

test('raid: three wipes in 30 min (the boss resets to full each time) call the raid off', async () => {
  // The live 2026-10-16 Drakath samples, one a minute: 20 -> 14 M, reset, again.
  const live = [19784708, 18110507, 16269396, 14951313, 19954725, 18500969, 16866098, 15307992, 14031381, 19571436, 18084676, 16440725, 15067812, 18944739, 17313068];
  const hp = { hp: live[0] };
  const h = swapHub(hp);
  h.raid.swap = { phase: 1, out: 'nova7', main: 'grail26' };   // the main is already in
  const r = h.raid;
  for (let m = 0; m < live.length && h.raid === r; m++) { hp.hp = live[m]; await h.raidWatch(r, m * MIN + 1); }
  eq(h.raid, null, h.infos.join(' | '));
  assert(h.infos.some((t) => /wiped 3x in 30 min, each time at ~14\.\d M of 20 M HP/.test(t)), h.infos.join(' | '));
  // One wipe and a better second try: keep going.
  const h2 = swapHub(hp);
  const r2 = h2.raid;
  for (const [m, v] of [19800000, 17000000, 14000000, 19900000, 17000000, 13000000, 11000000].entries()) { hp.hp = v; await h2.raidWatch(r2, m * MIN + 1); }
  eq(h2.raid, r2);
});

test('raid: a member whose script ends "done" without the kill calls the raid off for the rest', async () => {
  const h = swapHub({ hp: 20000000 });
  h.raidDone(h.bot('valen7'), { type: 'script', raid: 'raid-1' }, true);
  eq(h.raid, null);
  assert(h.infos.some((t) => /Valen7|valen7 is out without the kill \(done\)/.test(t)), h.infos.join(' | '));
  eq(h.bot('oren7').restarts, 1, 'Oren stops fighting alone');
});

test('raid swap: the main never has its gear enhanced by v3 in a raid', async () => {
  const cbo = require('../lib/skua/cbo');
  const k = await cbo.keysFor({ account: { kind: 'guest' }, settings: { soloClass: "King's Echo", privateRoom: 24680 }, current: { type: 'script', raid: 'raid-2' }, taskKey: () => 'x' });
  eq(k.DisableAutoEnhance, 'True');
});

test('raid watch: a boss never damaged in 40 min is called off, not run to the 3 h cap (Gramiel crystals 2026-10-23)', async () => {
  const hp = { hp: 20000000 };
  const h = swapHub(hp);
  h.raid.started = 1000;
  let called = null;
  h.raidCallOff = (why) => { called = why; h.raid = null; };
  for (let m = 1; m <= 39; m++) await h.raidWatch(h.raid, 1000 + m * MIN);
  eq(called, null, 'still inside 40 min');
  await h.raidWatch(h.raid, 1000 + 41 * MIN);
  assert(/never damaged in 41 min/.test(called || ''), called);
  assert(/full HP/.test(called), 'says why');
  const h2 = swapHub(hp);
  h2.raid.started = 1000;
  h2.raidCallOff = (why) => { called = why; h2.raid = null; };
  called = null;
  hp.hp = 19000000;
  await h2.raidWatch(h2.raid, 1000 + 2 * MIN);
  hp.hp = 18000000;
  await h2.raidWatch(h2.raid, 1000 + 45 * MIN);
  assert(!/never damaged/.test(called || ''), 'a boss that took damage is judged by pace and wipes as before');
});
