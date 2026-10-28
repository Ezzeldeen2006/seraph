// Proven recipes (the owner 2026-10-24: "if we beat an ultra why dont we save the way we beat it so its consistent? ... you
// keep testing until you kill an ultra and then the next day you struggle to kill that same ultra boss"): a win saves
// the line-up, comp, potions and a frozen copy of the script; the autopilot replays exactly that, first, every period.
const fs = require('fs');
const path = require('path');
const { Hub } = require('../lib/hub');
const recipes = require('../lib/recipes');
const { P } = require('../lib/paths');
const ultraready = require('../lib/ultraready');

recipes.installProven = () => 0;   // the frozen copies stay in the test root, never in the real Skua library
const SPEAKER = ultraready.BOSSES.find((b) => b.id === 'ultra-speaker');
const WIN = [['sable7', 'Lord of Order', 'TruthTaunter1'], ['valen7', 'StoneCrusher', 'TruthTaunter2'], ['oren7', 'ArchPaladin', 'ListenTaunter'], ['grail26', 'Verus DoomKnight', 'TruthTaunter3']];
function clean() {
  try { fs.unlinkSync(path.join(P.ROOT, 'raid-recipes.json')); } catch (e) { /* none */ }
  fs.rmSync(path.join(P.ROOT, 'proven'), { recursive: true, force: true });
}
function hub() {
  const h = Object.create(Hub.prototype);
  h._recipesForTest = true;
  h.settings = { raids: { done: {}, tries: {} }, potionPolicy: { 'ultra-speaker': { on: true } } };
  h.infos = []; h.notes = [];
  h.info = (t) => h.infos.push(t); h.notify = (title) => h.notes.push(title); h.saveSettings = () => {};
  h.partyRoom = () => 13579;
  h.raidSeats = (s) => s;   // no library writes from the tests
  h.ultraReady = () => ({ bosses: {} });
  h.bots = new Map();
  for (const id of ['sable7', 'valen7', 'oren7', 'nova7', 'grail26']) {
    const b = { id, running: true, paused: false, serverName: 'Swordhaven', client: { state: { loaded: true } }, current: { type: 'script', brain: true },
      account: { label: id, username: id, kind: id === 'grail26' ? 'guest' : 'party' }, restarts: 0, journal() {}, restart() { b.restarts++; },
      turnedIn: new Map(), questAvailable: async () => true, dailyDone: async () => false, classPoints: async () => [] };
    h.bots.set(id, b);
  }
  h.bot = (id) => h.bots.get(id);
  return h;
}
// A raid that ends with the boss dead (every member back "kill" with Attempt reports) or lost.
function finish(h, r, won) {
  r.attempts = r.members.map((id) => { const s = (r.seats || []).find((x) => x.id === id) || {}; const w = WIN.find((x) => x[0] === id) || []; return { id, cls: s.cls, role: w[2], comp: 'default', outcome: won ? 'kill' : 'wipe' }; });
  r.fight = { startAt: r.started };
  for (const id of r.members) r.back[id] = won ? 'kill' : 'called off';
  h.raidClose(won);
}

test('proven: a win saves who sat where, the comp, potions and a frozen copy of the script that ran', () => {
  clean();
  const h = hub();
  const crew = WIN.map(([id]) => h.bot(id));
  const r = h.beginRaid(SPEAKER, crew, Date.now(), WIN.map(([id, cls]) => ({ id, cls })));
  finish(h, r, true);
  const e = recipes.get('ultra-speaker');
  assert(e && e.recipe, 'saved');
  eq(e.recipe.seats.map((s) => [s.id, s.cls, s.role]), WIN);
  eq(e.recipe.comp, 'default');
  assert(e.recipe.seats.every((s) => typeof s.potions === 'boolean'), 'potions per seat');
  assert(/^SeraphProven\/ultra-speaker-[0-9a-f]{10}\/IndividualUltras\/10UltraSpeakerv3\.cs$/.test(e.recipe.script), e.recipe.script);
  const frozen = fs.readFileSync(path.join(P.ROOT, 'proven', e.recipe.script.replace(/^SeraphProven\//, '')), 'utf8');
  assert(frozen.includes(`//cs_include Scripts/SeraphProven/${e.recipe.script.split('/')[1]}/DependenciesUltras/CoreUltrav3.cs`), 'includes point at the frozen dependencies');
  assert(fs.existsSync(path.join(P.ROOT, 'proven', e.recipe.script.split('/')[1], 'DependenciesUltras', 'UltraComp.cs')), 'dependencies frozen too');
  assert(h.notes.some((n) => /winning line-up saved/.test(n)), h.notes.join(' | '));
  clean();
});

test('proven: the next period replays exactly that line-up from the frozen script, before any other pick', async () => {
  clean();
  const h = hub();
  const r0 = h.beginRaid(SPEAKER, WIN.map(([id]) => h.bot(id)), Date.now(), WIN.map(([id, cls]) => ({ id, cls })));
  finish(h, r0, true);
  const rec = recipes.active('ultra-speaker');
  recipes.installProven = recipes.installProven;   // frozen file exists under P.ROOT/proven; make the library check pass
  const realExists = fs.existsSync;
  fs.existsSync = (p) => (String(p).replace(/\\/g, '/').includes('SeraphProven/') ? true : realExists(p));
  try {
    const r = await h.raidProvenTick(Date.now() + 8 * 86400000);
    assert(r, h.infos.join(' | '));
    eq(r.members, WIN.map(([id]) => id), 'same four - Nova is not slipped in');
    eq(r.seats.map((s) => [s.id, s.cls]), WIN.map(([id, cls]) => [id, cls]));
    eq(r.script, rec.script, 'the frozen copy runs, not today\'s script');
    eq(r.recipe, rec.id);
    assert(h._provenHold.has('ultra-speaker'), 'the boss stays out of the other picks');
    const cfg = fs.readFileSync(path.join(P.ROOT, 'skua-options', 'DoAllUltras.cfg'), 'utf8');
    assert(cfg.includes('Options:UltraSpeakerComp=\n') || /Options:UltraSpeakerComp=$/m.test(cfg), 'the winning comp by name (default)');
  } finally { fs.existsSync = realExists; }
  clean();
});

test('proven: a busy crew member makes the boss wait for it (no other line-up takes it); forcing says who', async () => {
  clean();
  const h = hub();
  finish(h, h.beginRaid(SPEAKER, WIN.map(([id]) => h.bot(id)), Date.now(), WIN.map(([id, cls]) => ({ id, cls }))), true);
  h.bot('grail26').client._standAsideUntil = Date.now() + 9 * 86400000;   // The owner is playing his main
  const later = Date.now() + 8 * 86400000;
  eq(await h.raidProvenTick(later), null);
  assert(h._provenHold.has('ultra-speaker'), 'held for the proven crew');
  assert(h.infos.some((t) => /waits for its proven line-up - grail26 is not free/.test(t)), h.infos.join(' | '));
  const f = await h.raidProvenStart('ultra-speaker');
  assert(!f.ok && /grail26 is not free/.test(f.error), f.error);
  eq(await h.raidProvenTick(later + 7 * 3600000), null);
  assert(!h._provenHold.has('ultra-speaker'), 'released to the other picks after 6 h of waiting');
  clean();
});

test('proven: three lost replays in a row make it stale (the owner is told); then the next win becomes the recipe', async () => {
  clean();
  const h = hub();
  finish(h, h.beginRaid(SPEAKER, WIN.map(([id]) => h.bot(id)), Date.now(), WIN.map(([id, cls]) => ({ id, cls }))), true);
  const first = recipes.active('ultra-speaker');
  const realExists = fs.existsSync;
  fs.existsSync = (p) => (String(p).replace(/\\/g, '/').includes('SeraphProven/') ? true : realExists(p));
  try {
    for (let i = 0; i < 3; i++) {
      h.settings.raids.recipeTries = {};   // a new period each time
      const r = await h.raidProvenTick(Date.now() + (i + 1) * 8 * 86400000);
      assert(r && r.recipe === first.id, `replay ${i + 1}: ${h.infos.slice(-3).join(' | ')}`);
      finish(h, r, false);
    }
  } finally { fs.existsSync = realExists; }
  eq(recipes.active('ultra-speaker'), null, 'stale');
  assert(h.notes.some((n) => /stopped winning/.test(n)), h.notes.join(' | '));
  eq(h.settings.raids.tries['ultra-speaker'], undefined, 'replays never used the autopilot tries');
  // Another line-up wins: it is the proven one now.
  const alt = [['sable7', 'Lord of Order'], ['valen7', 'StoneCrusher'], ['nova7', 'ArchPaladin'], ['grail26', 'Verus DoomKnight']];
  finish(h, h.beginRaid(SPEAKER, alt.map(([id]) => h.bot(id)), Date.now(), alt.map(([id, cls]) => ({ id, cls }))), true);
  const now = recipes.active('ultra-speaker');
  assert(now && now.id !== first.id && now.seats.some((s) => s.id === 'nova7'), JSON.stringify(now));
  eq(recipes.get('ultra-speaker').alternates[0].id, first.id, 'the old one kept as an alternate');
  clean();
});

test('proven: a different winning line-up while the recipe is good is only an alternate; it can be promoted', () => {
  clean();
  const h = hub();
  finish(h, h.beginRaid(SPEAKER, WIN.map(([id]) => h.bot(id)), Date.now(), WIN.map(([id, cls]) => ({ id, cls }))), true);
  const first = recipes.active('ultra-speaker');
  const alt = [['sable7', 'Lord of Order'], ['valen7', 'StoneCrusher'], ['nova7', 'ArchPaladin'], ['grail26', 'Verus DoomKnight']];
  finish(h, h.beginRaid(SPEAKER, alt.map(([id]) => h.bot(id)), Date.now(), alt.map(([id, cls]) => ({ id, cls }))), true);
  eq(recipes.active('ultra-speaker').id, first.id, 'the proven one stays');
  const a = recipes.get('ultra-speaker').alternates[0];
  assert(a.seats.some((s) => s.id === 'nova7'));
  eq(recipes.promote('ultra-speaker', a.id).id, a.id);
  eq(recipes.active('ultra-speaker').id, a.id);
  clean();
});

test('proven: wins from before recipes existed are seeded from the raid log (once, never over an existing recipe)', async () => {
  clean();
  const h = hub();
  const kill = (id, cls, role) => ({ id, cls, role, comp: 'default', outcome: 'kill' });
  h.settings.raids.log = [
    { boss: 'ultra-speaker', at: '2026-10-24T11:04:05.364Z', minutes: 8, killed: true, back: {}, attempts: WIN.map(([id, cls, role]) => kill(id, cls, role)) },
    { boss: 'ultra-speaker', at: '2026-10-24T12:03:58.658Z', minutes: 20, killed: false, back: {} },
    { boss: 'ultra-dage', at: '2026-10-23T19:15:27.591Z', minutes: 30, killed: false, back: {} },
  ];
  h.bot('grail26').client._standAsideUntil = Date.now() + 86400000;   // nothing starts; only the seeding runs
  await h.raidProvenTick(Date.now());
  const e = recipes.get('ultra-speaker');
  assert(e && e.recipe.seeded, 'seeded');
  eq(e.recipe.script, null, 'nothing frozen for a seeded line-up');
  eq(e.recipe.seats.map((s) => [s.id, s.cls, s.role]), WIN);
  eq(e.recipe.seats.map((s) => s.potions), [true, true, true, true], 'bots by the boss potion policy, the main by mainPotions');
  eq(recipes.get('ultra-dage'), null, 'no win, no recipe');
  assert(h.infos.some((t) => /seeded from earlier wins: ultra-speaker/.test(t)), h.infos.join(' | '));
  clean();
});

test('proven: a seeded line-up runs today\'s script; its first win freezes that script, and any other win replaces it', async () => {
  clean();
  const kill = (id, cls, role) => ({ id, cls, role, comp: 'default', outcome: 'kill' });
  const log = [{ boss: 'ultra-speaker', at: '2026-10-24T11:04:05.364Z', minutes: 8, killed: true, back: {}, attempts: WIN.map(([id, cls, role]) => kill(id, cls, role)) }];
  // 1. The seeded line-up wins with today's script: now it is frozen and no longer seeded.
  let h = hub();
  h.settings.raids.log = log;
  const r = await h.raidProvenTick(Date.now());
  assert(r, h.infos.join(' | '));
  eq(r.script, SPEAKER.script, 'today\'s script, nothing frozen yet');
  eq(recipes.get('ultra-speaker').recipe.script, null);
  finish(h, r, true);
  let rec = recipes.get('ultra-speaker').recipe;
  eq([rec.seeded, rec.wins], [false, 2]);
  assert(/^SeraphProven\/ultra-speaker-/.test(rec.script), 'the script that won is frozen now');
  clean();
  // 2. Another line-up wins first: it replaces the seeded one (kept as an alternate).
  h = hub();
  h.settings.raids.log = log;
  h.bot('grail26').client._standAsideUntil = Date.now() + 86400000;
  await h.raidProvenTick(Date.now());   // seeds, starts nothing
  const alt = [['sable7', 'Lord of Order'], ['valen7', 'StoneCrusher'], ['oren7', 'ArchPaladin'], ['nova7', 'Verus DoomKnight']];
  finish(h, h.beginRaid(SPEAKER, alt.map(([id]) => h.bot(id)), Date.now(), alt.map(([id, cls]) => ({ id, cls }))), true);
  rec = recipes.get('ultra-speaker');
  assert(rec.recipe.seats.some((s) => s.id === 'nova7') && !rec.recipe.seeded && rec.recipe.script, JSON.stringify(rec.recipe));
  assert(rec.alternates[0].seeded, 'the seeded one kept as an alternate');
  clean();
});
