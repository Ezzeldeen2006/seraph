// 2026-10-21: seven characters. New level-2 characters online must not stop the level-100 four's ultras, and a raid
// sends the four ultraready seated for the boss - never a newcomer who happens to be online.
const { Hub } = require('../lib/hub');
const ultraready = require('../lib/ultraready');

const vet = (id, classes) => ({ id, level: 100, classes, enhancements: [], weapon: { value: 0.4 } });
const newbie = (id) => ({ id, level: 2, classes: ['Rogue'], enhancements: [], weapon: { value: 0 } });
const FOUR = [
  vet('sable7', ['Lord of Order', 'StoneCrusher']),
  vet('valen7', ['StoneCrusher', 'ArchPaladin', 'Shaman']),
  vet('nova7', ['Void Highlord', 'StoneCrusher', 'ArchFiend']),
  vet('oren7', ['ArchPaladin', 'Arcana Invoker']),
];

test('ultraready: level-2 newcomers online do not block the four level-100s', () => {
  const alone = ultraready.check(FOUR);
  const withNew = ultraready.check([...FOUR, newbie('vexa'), newbie('edda')]);
  eq(withNew.bosses['ultra-ezrajal'].ready, true, withNew.bosses['ultra-ezrajal'].missing.join('; '));
  eq(Object.values(withNew.bosses).filter((b) => b.ready).length, Object.values(alone.bosses).filter((b) => b.ready).length, 'same bosses ready as without them');
  assert(!withNew.bosses['ultra-ezrajal'].seats.some((s) => s.id === 'vexa' || s.id === 'edda'), 'no newcomer seated');
  assert(withNew.missing.some((m) => /vexa: level 100/.test(m)), 'what they lack is still reported');
});

test('ultraready: under four qualify - the others sit in and the boss is not ready', () => {
  const r = ultraready.check([...FOUR.slice(0, 3), newbie('vexa')]);
  eq(r.bosses['ultra-ezrajal'].ready, false);
  assert(r.bosses['ultra-ezrajal'].missing.some((m) => /vexa: level 100/.test(m)), r.bosses['ultra-ezrajal'].missing.join('; '));
});

test('ultraready: a qualified newcomer takes her planned seat', () => {
  const vexa = vet('vexa', ['Verus DoomKnight']);
  const edda = vet('edda', ["King's Echo"]);
  const r = ultraready.check([...FOUR, vexa, edda]);
  const t = r.bosses['ultra-tyndarius'];
  eq(t.ready, true, t.missing.join('; '));
  assert(t.seats.some((s) => s.id === 'vexa' && s.cls === 'Verus DoomKnight'), JSON.stringify(t.seats));
  assert(t.seats.some((s) => s.id === 'edda' && s.cls === "King's Echo"), JSON.stringify(t.seats));
});

function hubWith(ids, seats) {
  const h = Object.create(Hub.prototype);
  h.settings = {}; h.infos = [];
  h.info = (t) => h.infos.push(t); h.notify = () => {}; h.saveSettings = () => {};
  h.bots = new Map();
  for (const id of ids) h.bots.set(id, { id, running: true, paused: false, serverName: 'Swordhaven', account: { label: id }, current: null, journal() {}, restart() {}, questAvailable: async () => true });
  h.bot = (id) => h.bots.get(id);
  h.raidDue = () => [{ id: 'ultra-ezrajal', name: 'Ultra Ezrajal', script: 'x.cs', quest: 8152, every: 'day' }];
  h._ultra = { ready: true, bosses: { 'ultra-ezrajal': { ready: true, seats: seats.map((id) => ({ id, cls: 'X' })), missing: [] } } };
  return h;
}

test('raids: the seated four go, not the first four online', async () => {
  // Nova stood aside (the owner playing her): vexa is now among the first four online, but she isn't seated.
  const h = hubWith(['sable7', 'valen7', 'vexa', 'oren7', 'edda', 'nova7'], ['sable7', 'valen7', 'nova7', 'oren7']);
  const r = await h.raidTick();
  eq(r && r.members.slice().sort().join(','), 'nova7,oren7,sable7,valen7');
});

test('raids: a seated character offline skips the boss without a lock', async () => {
  const h = hubWith(['sable7', 'valen7', 'vexa', 'oren7', 'edda'], ['sable7', 'valen7', 'nova7', 'oren7']);
  eq(await h.raidTick(), null);
  assert(!(h.settings.raids.locked || {})['ultra-ezrajal'], 'not locked for an hour');
});

test('help calls: a newcomer far below the caller stays on her own work; veterans still answer hers', async () => {
  const h = Object.create(Hub.prototype);
  h.settings = { levelParty: { room: 13579, maxGap: 25 } }; h.infos = [];
  h.info = (t) => h.infos.push(t); h.notify = () => {}; h.raid = null; h.assistFor = () => null; h.partyWalls = {};
  h.bots = new Map();
  const mk = (id, level) => {
    const b = { id, account: { label: id, status: 'active' }, running: true, paused: false, current: { type: 'script', path: 'x.cs' }, ran: [],
      level: async () => level, journal() {}, runNow(t) { this.ran.push(t); return Promise.resolve(true); } };
    h.bots.set(id, b);
    return b;
  };
  const vae = mk('valen7', 100); const nyx = mk('nova7', 100); const vel = mk('vexa', 2);
  let call = await h.requestHelp(vae, { map: 'shadowrealmpast', cell: 'Boss', monster: 'Legion Lich Lord', why: 'died 2x' });
  eq(call.helpers, ['nova7'], 'level 2 is not sent to a level-100 boss');
  eq(vel.ran.length, 0);
  eq(h.helpTask(vel), null, 'nor pulled in later');
  h.help = null;
  call = await h.requestHelp(vel, { map: 'birthday', cell: 'Party', monster: 'Birthday Cake', why: 'died 2x' });
  eq(call.helpers.slice().sort(), ['nova7', 'valen7'], 'the veterans help the newcomer');
});

function engineHub(holders, now) {
  const h = Object.create(Hub.prototype);
  h.settings = { maxEngines: 2 }; h.infos = []; h.info = (t) => h.infos.push(t); h.raid = null;
  h.bots = new Map();
  const mk = (id, current) => {
    const b = { id, account: { label: id }, current, restarts: 0, journals: [], journal(m) { this.journals.push(m); }, restart() { this.restarts++; return Promise.resolve(true); } };
    h.bots.set(id, b);
    return b;
  };
  h.bot = (id) => h.bots.get(id);
  h.engineLoadNow = () => ({ ok: false });   // no kernel readings: the floor alone, as on the PC
  h.engineBusy = new Set(); h.engineSince = new Map(); h.engineWaiting = new Set(); h.engineWaitSince = new Map();
  for (const [id, cur, heldMin] of holders) { mk(id, cur); h.engineBusy.add(id); h.engineSince.set(id, now - heldMin * 60000); }
  h.mk = mk;
  return h;
}
const FJ = { type: 'script', path: 'Farm/FarmerJoe/0FarmerJoeDoAll.cs', brain: true, why: 'Farmer Joe' };

test('engines: a holder past its slice hands its engine to a character waiting 3+ min; dailies and raids are never cut', () => {
  const now = Date.now();
  const h = engineHub([['vexa', FJ, 120], ['sable7', { type: 'script', path: 'Dailies/LordOfOrder.cs', recurring: true }, 300]], now);
  h.mk('nova7', null); h.engineWaiting.add('nova7'); h.engineWaitSince.set('nova7', now - 60000);
  eq(h.engineYield(now), null, 'a 1-minute wait is not a reason yet');
  h.engineWaitSince.set('nova7', now - 4 * 60000);
  eq(h.engineYield(now), 'vexa', 'the Farmer Joe holder (2 h) goes, not the Lord of Order daily (5 h)');
  eq(h.bot('vexa').restarts, 1);
  eq(h.engineYield(now + 70000), null, 'not asked twice while her script stops');
  h.engineBusy.clear();
  h.mk('edda', null); h.engineWaiting.add('edda'); h.engineWaitSince.set('edda', now - 60000);
  eq(h.engineNext(), 'nova7', 'the longest wait is first in line');
});

test('engines: holders inside their slice keep it; a raid member takes a slot at once', () => {
  const now = Date.now();
  const h = engineHub([['vexa', FJ, 20], ['edda', FJ, 10]], now);
  h.mk('oren7', null); h.engineWaiting.add('oren7'); h.engineWaitSince.set('oren7', now - 10 * 60000);
  eq(h.engineYield(now), null, '20 min is inside the 45-min slice');
  h.mk('valen7', null); h.engineWaiting.add('valen7'); h.engineWaitSince.set('valen7', now - 5000);
  h.raid = { members: ['valen7', 'oren7'] };
  eq(h.engineNext(), 'oren7', 'raid members first, longest wait among them');
  eq(h.engineYield(now), 'vexa', 'a raid does not wait for a slice');
  eq(h.engineYield(now + 1000), 'edda', 'and needs a slot for each waiting member at once');
  eq(h.engineYield(now + 2000), null, 'two members waiting, two slots coming');
});

test('engines: a raid member takes the slot from a Daily-Classes farm when nothing else can give way (Darkon 2026-10-23)', () => {
  const now = Date.now();
  const blaze = { type: 'script', path: 'Other/Classes/Daily-Classes/BlazeBinder.cs', goal: 'blaze-binder', hours: 2.9 };
  const h = engineHub([['edda', blaze, 80], ['vexa', FJ, 5]], now);
  h.mk('nova7', null); h.engineWaiting.add('nova7'); h.engineWaitSince.set('nova7', now - 5000);
  eq(h.engineYield(now), null, 'no raid: the daily-class farm is protected and Farmer Joe is inside its slice');
  h.raid = { members: ['nova7'] };
  eq(h.engineYield(now), 'vexa', 'a raid takes the ordinary farm first');
  h.engineYielding.clear(); h.bot('vexa').current = { type: 'script', path: 'Dailies/LordOfOrder.cs', recurring: true };
  eq(h.engineYield(now + 1000), 'edda', 'then the protected one (longest held): the raid needs every slot');
});

test("engines: the owner's own account is next in line and takes a slot at once, never from another raid member", () => {
  const now = Date.now();
  const h = engineHub([['vexa', FJ, 5], ['edda', FJ, 30]], now);
  h.mk('nova7', null); h.engineWaiting.add('nova7'); h.engineWaitSince.set('nova7', now - 20 * 60000);
  const main = h.mk('grail26', null); main.account.kind = 'guest';
  h.engineWaiting.add('grail26'); h.engineWaitSince.set('grail26', now - 5000);
  eq(h.engineNext(), 'grail26', 'ahead of a party character that waited longer');
  eq(h.engineYield(now), 'edda', 'no 3-min wait, no slice: the longest holder gives way');
  eq(h.engineYield(now + 1000), null, 'one slot for the main at a time');
});

// 2026-10-23 engine budget (the owner: "push the laptop ... 4 is delaying a lot of progress"): maxEngines is the floor,
// more engines start while the kernel says there is room, and an overload sends the newest one back.
const LOAD = (cpu60, extra = {}) => ({ ok: true, cpu: { avg10: extra.avg10 != null ? extra.avg10 : cpu60, avg60: cpu60, avg300: cpu60 }, memCur: 900 * 1048576, memHigh: 1800 * 1048576, avail: 1300 * 1048576, ...extra });

test('engine budget: the kernel files are read from the service cgroup', () => {
  const files = {
    '/proc/self/cgroup': '0::/system.slice/seraph-bots.service\n',
    '/sys/fs/cgroup/system.slice/seraph-bots.service/cpu.pressure': 'some avg10=43.49 avg60=14.51 avg300=12.44 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
    '/sys/fs/cgroup/system.slice/seraph-bots.service/memory.current': '954990592\n',
    '/sys/fs/cgroup/system.slice/seraph-bots.service/memory.high': '1887436800\n',
    '/proc/meminfo': 'MemTotal:        3104768 kB\nMemAvailable:    1332224 kB\n',
  };
  const l = Hub.engineLoad((f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; });
  eq(l.ok, true);
  eq(l.cpu.avg60, 14.51);
  eq(l.memCur, 954990592);
  eq(l.memHigh, 1887436800);
  eq(l.avail, 1332224 * 1024);
  eq(Hub.engineLoad(() => { throw new Error('no /proc on the PC'); }).ok, false, 'no readings: no burst');
  files['/sys/fs/cgroup/system.slice/seraph-bots.service/memory.high'] = 'max\n';
  eq(Hub.engineLoad((f) => files[f]).memHigh, null, '"max" is no limit');
});

test('engine budget: above the floor an engine starts only with room - CPU, memory, one start at a time', () => {
  const now = Date.now();
  const h = engineHub([['vexa', FJ, 20], ['edda', FJ, 10]], now);
  for (const id of ['nova7', 'oren7', 'valen7', 'sunna', 'sable7', 'grail26']) h.mk(id, FJ);
  let load = LOAD(15);
  h.engineLoadNow = () => load;
  eq(Hub.engineCeiling(h.settings, h.bots.size), 8, 'one per character, at most 8');
  eq(Hub.engineCeiling({ maxEngines: 4, engineBurst: false }, 8), 4, 'engineBurst false = the old fixed cap');
  h.engineBusy.delete('edda');
  eq(h.engineRoom(h.bot('nova7'), now).ok, true, 'below the floor: always');
  h.engineBusy.add('edda');
  const r = h.engineRoom(h.bot('nova7'), now);
  eq(r.ok, true, 'quiet laptop: a third engine on a floor of two');
  assert(r.burst);
  h._engineStartAt = now - 20000;
  assert(/starting/.test(h.engineRoom(h.bot('nova7'), now).why), 'a cold start 20 s ago: wait for it');
  h._engineStartAt = now - 120000;
  load = LOAD(45);
  assert(/CPU pressure 45/.test(h.engineRoom(h.bot('nova7'), now).why), 'busy cores: no new engine');
  load = LOAD(15, { avg10: 70 });
  eq(h.engineRoom(h.bot('nova7'), now).ok, false, 'a spike right now counts too');
  load = LOAD(15, { memCur: 1650 * 1048576 });
  assert(/memory/.test(h.engineRoom(h.bot('nova7'), now).why), 'too close to MemoryHigh');
  load = LOAD(15, { avail: 300 * 1048576 });
  assert(/MB free/.test(h.engineRoom(h.bot('nova7'), now).why), 'the laptop itself is short');
  load = LOAD(25);
  h.raid = { members: ['oren7'] };
  eq(h.engineRoom(h.bot('nova7'), now).ok, false, 'an ultra fight halves the CPU allowance for everyone else');
  load = LOAD(70);
  h._engineStartAt = now - 1000;
  eq(h.engineRoom(h.bot('oren7'), now).ok, true, 'a raid member skips the CPU and stagger checks');
  load = LOAD(70, { memCur: 1700 * 1048576 });
  eq(h.engineRoom(h.bot('oren7'), now).ok, false, '...but never memory');
  h.raid = null; load = LOAD(10); h._engineStartAt = 0;
  h._engineShedAt = now - 5 * 60000;
  assert(/overloaded/.test(h.engineRoom(h.bot('nova7'), now).why), 'rests after an overload');
  h._engineShedAt = now - 11 * 60000;
  eq(h.engineRoom(h.bot('nova7'), now).ok, true);
  for (const id of ['nova7', 'oren7', 'valen7', 'sunna', 'sable7', 'grail26']) h.engineBusy.add(id);
  assert(/8\/8/.test(h.engineRoom(h.bot('nova7'), now).why), 'the ceiling holds');
  h.engineLoadNow = () => ({ ok: false });
  h.engineBusy = new Set(['vexa', 'edda']);
  eq(h.engineRoom(h.bot('nova7'), now).ok, false, 'no kernel readings (the PC): the floor alone');
});

test('engine budget: an overload sends the newest burst engine back; raids, dailies and the main stay', () => {
  const now = Date.now();
  const daily = { type: 'script', path: 'Dailies/LordOfOrder.cs', recurring: true };
  const h = engineHub([['vexa', FJ, 50], ['edda', FJ, 40], ['sunna', FJ, 3], ['sable7', daily, 1], ['oren7', { type: 'script', raid: 'r1', path: 'x' }, 1]], now);
  const main = h.mk('grail26', FJ); main.account.kind = 'guest'; h.engineBusy.add('grail26'); h.engineSince.set('grail26', now);
  h.raid = { members: ['oren7'] };
  let load = LOAD(85);
  h.engineLoadNow = () => load;
  eq(h.engineGovernor(now), null, 'one hot reading is not an overload yet');
  eq(h.engineGovernor(now + 30000), 'sunna', 'two in a row: the newest ordinary farm goes - not the main, the daily or the raid');
  eq(h.bot('sunna').restarts, 1);
  assert(/overloaded/.test(h.bot('sunna').journals.join(' ')));
  assert(h._engineShedAt, 'admissions rest after it');
  load = LOAD(30);
  eq(h.engineGovernor(now + 60000), null, 'calm again: nothing more');
  load = LOAD(10, { memCur: 1790 * 1048576 });
  h.engineBusy.delete('sunna');
  eq(h.engineGovernor(now + 90000), 'edda', 'memory at MemoryHigh acts at once, on the newest farm');
  h.engineBusy = new Set(['vexa', 'edda']);
  load = LOAD(99);
  eq(h.engineGovernor(now + 120000), null);
  eq(h.engineGovernor(now + 150000), null, 'at the floor nothing is ever sent back');
  // An ultra raid gets the cores: 60 % is fine on its own, too much while a raid fights.
  h.engineBusy = new Set(['vexa', 'edda', 'sunna']); h.engineSince.set('sunna', now); h.raid = null; h._engineHot = 0;
  load = LOAD(60);
  eq(h.engineGovernor(now + 160000), null); eq(h.engineGovernor(now + 190000), null, 'no raid: 60 % stays');
  h.raid = { members: ['oren7'] };
  eq(h.engineGovernor(now + 220000), null); eq(h.engineGovernor(now + 250000), 'sunna', 'raid: 60 % twice sheds the newest farm');
});

test('engine budget: engineFor gives the first in line a burst slot without waiting, and records the start', async () => {
  const { HeadlessClient } = require('../lib/net/headless');
  const now = Date.now();
  const h = engineHub([['vexa', FJ, 20], ['edda', FJ, 10]], now);
  h.headless = true; h.engines = new Map();
  h.engineLoadNow = () => LOAD(12);
  const nyx = h.mk('nova7', FJ);
  Object.assign(nyx, { client: new HeadlessClient({ id: 'nova7', label: 'nova7', username: 'N' }), settings: {}, waits: 0, wait: async () => { nyx.waits++; } });
  const eng = await h.engineFor(nyx);
  assert(eng && eng.client === nyx.client, 'a third engine on a floor of two');
  eq(nyx.waits, 0, 'no queue');
  assert(h.engineBusy.has('nova7') && h._engineStartAt, 'busy, and the next burst start waits for this one');
  eng.dispose();
});

test('engines: a free slot is never paid for twice - one waiter, one hand-over (main 2026-10-23 21:26)', () => {
  const now = Date.now();
  // Held 20 and 10 min: Seraph 5 lets the main wait up to 3 min rather than stop a script that just started (squad.test.js).
  const h = engineHub([['sable7', FJ, 20], ['valen7', FJ, 10]], now);
  const main = h.mk('grail26', null); main.account.kind = 'guest';
  h.engineWaiting.add('grail26'); h.engineWaitSince.set('grail26', now - 5000);
  eq(h.engineYield(now), 'sable7', 'the main takes a slot at once');
  // Sable's script stopped (engineDone) but the main has not polled yet; Sable now queues too.
  h.engineBusy.delete('sable7'); h.engineYielding.clear();
  h.engineWaiting.add('sable7'); h.engineWaitSince.set('sable7', now);
  eq(h.engineYield(now + 2000), null, 'the slot is free: Valen keeps his engine');
  eq(h.bot('valen7').restarts, 0);
  h.raid = { members: ['nova7', 'oren7'] };
  for (const id of ['nova7', 'oren7']) { h.mk(id, null); h.engineWaiting.add(id); h.engineWaitSince.set(id, now - 1000); }
  eq(h.engineYield(now + 3000), 'valen7', 'two raiders, one free slot: exactly one more hand-over');
  eq(h.engineYield(now + 4000), null, 'and not a second one');
  h.engineLoadNow = () => ({ ok: true, cpu: { avg10: 99, avg60: 99, avg300: 50 }, memCur: 500 * 1048576, memHigh: 1800 * 1048576, avail: 1500 * 1048576 });
  h.engineYielding.clear(); h.engineBusy.add('vexa'); h.mk('vexa', FJ); h.engineSince.set('vexa', now - 3600000);
  eq(h.engineYield(now + 5000), null, 'memory for a burst engine: a raider takes it instead of stopping anyone');
});
