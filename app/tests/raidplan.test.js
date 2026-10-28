// Raid Planner (the owner 2026-10-24: "decide which characters take which role and how they act and what potions do they
// use"): the dashboard picks the four, their classes, roles, potions and scroll; the hub writes the plan the vendored
// v3 UltraComp reads ("seraph-plan"), and a lost hand line-up is never one of the autopilot's tries.
const fs = require('fs');
const path = require('path');
const { Hub } = require('../lib/hub');
const ultras = require('../lib/ultras');
const { P } = require('../lib/paths');
const ultraready = require('../lib/ultraready');

const CLASSES = {
  sable7: ['Lord of Order', 'ArchPaladin'],
  valen7: ['StoneCrusher', 'Void Highlord'],
  oren7: ['ArchPaladin', 'StoneCrusher'],
  grail26: ['Verus DoomKnight', 'Legion Revenant', "King's Echo"],
};
function hub() {
  const h = Object.create(Hub.prototype);
  h.settings = { raids: { done: {}, tries: {} } }; h.infos = [];
  h.info = (t) => h.infos.push(t); h.notify = () => {}; h.saveSettings = () => {};
  h.partyRoom = () => 13579;
  h.bots = new Map();
  for (const id of Object.keys(CLASSES)) {
    const b = { id, running: true, paused: false, serverName: 'Swordhaven', client: { state: { loaded: true } }, current: { type: 'script', brain: true },
      account: { label: id, username: id, kind: id === 'grail26' ? 'guest' : 'party' }, restarts: 0, journal() {},
      restart() { b.restarts++; }, turnedIn: new Map(),
      classPoints: async () => CLASSES[id].map((name) => ({ name, cp: 302500 })) };
    h.bots.set(id, b);
  }
  h.bot = (id) => h.bots.get(id);
  return h;
}
const SPEAKER = [
  { id: 'sable7', cls: 'Lord of Order', role: 'TruthTaunter1', potions: true, potionList: ['Body Tonic', 'Unstable Divine Elixir'], scroll: 'Scroll of Enrage' },
  { id: 'valen7', cls: 'StoneCrusher', role: 'TruthTaunter2', potions: false, potionList: ['Body Tonic'], scroll: 'Scroll of Enrage' },
  { id: 'oren7', cls: 'ArchPaladin', role: 'ListenTaunter', potions: true, potionList: ['Body Tonic', 'Potent Destruction Elixir'], scroll: 'Scroll of Enrage' },
  { id: 'grail26', cls: 'Verus DoomKnight', role: 'TruthTaunter3', potions: true, potionList: [], scroll: '' },
];
const read = (f) => fs.readFileSync(path.join(P.ROOT, f), 'utf8');

test('raid plan: planInfo reads roles for Comp bosses and class seats for the others', () => {
  const sp = ultras.planInfo(ultraready.BOSSES.find((b) => b.id === 'ultra-speaker'));
  eq(sp.kind, 'comp');
  eq(sp.roles.map((r) => r.role).sort(), ['ListenTaunter', 'TruthTaunter1', 'TruthTaunter2', 'TruthTaunter3']);
  const listen = sp.roles.find((r) => r.role === 'ListenTaunter');
  eq([listen.potions, listen.scroll], [['Body Tonic', 'Potent Destruction Elixir'], 'Scroll of Enrage']);
  const dage = ultras.planInfo(ultraready.BOSSES.find((b) => b.id === 'ultra-dage'));
  eq(dage.kind, 'slots');
  eq(dage.slots.find((s) => s.role === 'Taunter1').classes, ['Verus DoomKnight']);
  const drakath = ultras.planInfo(ultraready.BOSSES.find((b) => b.id === 'champion-drakath'));
  eq(drakath.slots.find((s) => s.role === 'Taunter3').classes, ['Shaman', 'Legion Revenant'], 'SeraphSeatOr property');
  const ez = ultras.planInfo(ultraready.BOSSES.find((b) => b.id === 'ultra-ezrajal'));
  assert(ez.roles.find((r) => r.role === 'EzrajalAttacker').potions.includes('Potent Honor or Malice Potion'), 'UltraPotions.HonorOrMalice resolved');
});

test('raid plan: a Speaker line-up writes the plan, the seraph-plan Comp, the layout and per-seat potions', async () => {
  const h = hub();
  const r = await h.raidPlanStart({ boss: 'ultra-speaker', seats: SPEAKER.map((s) => ({ ...s })) });
  assert(r.ok, r.error);
  eq(h.raid.plan.seats.length, 4);
  eq(read('raid-plan.txt').trim().split('\n'), [
    'boss=UltraSpeaker',
    'Lord of Order|TruthTaunter1|Body Tonic, Unstable Divine Elixir|Scroll of Enrage',
    'StoneCrusher|TruthTaunter2||Scroll of Enrage',
    'ArchPaladin|ListenTaunter|Body Tonic, Potent Destruction Elixir|Scroll of Enrage',
    'Verus DoomKnight|TruthTaunter3||',
  ]);
  const cfg = read('skua-options/DoAllUltras.cfg');
  assert(cfg.includes('Options:UltraSpeakerComp=seraph-plan'), cfg);
  assert(cfg.includes('Options:UltraSpeakerLayout=sable7=Lord of Order; valen7=StoneCrusher; oren7=ArchPaladin; grail26=Verus DoomKnight'), cfg);
  eq(read('raid-potions.txt').trim().split('\n'), ['sable7=on', 'valen7=off', 'oren7=on', 'grail26=on']);
  eq(read('raid-seats.txt').trim().split('\n').length, 4);
  eq(h.settings.raidPlans['ultra-speaker'].seats[0].role, 'TruthTaunter1', 'remembered for next time');
  assert([...h.bots.values()].every((b) => b.restarts === 1), 'everyone switches to the raid');
});

test('raid plan: what would stop v3 at once is refused before anyone moves', async () => {
  const h = hub();
  const bad = async (seats, re) => { const r = await h.raidPlanStart({ boss: 'ultra-speaker', seats }); assert(!r.ok && re.test(r.error), `${r.error}`); };
  await bad(SPEAKER.slice(0, 3), /four seats/);
  await bad(SPEAKER.map((s, i) => (i === 1 ? { ...s, cls: 'Lord of Order' } : s)), /same class/);
  await bad(SPEAKER.map((s, i) => (i === 1 ? { ...s, id: 'sable7' } : s)), /two seats/);
  await bad(SPEAKER.map((s, i) => (i === 2 ? { ...s, cls: 'Void Highlord' } : s)), /oren7 has no rank-10 Void Highlord/);
  await bad(SPEAKER.map((s, i) => (i === 0 ? { ...s, role: 'Nope' } : s)), /no role "Nope"/);
  h.bot('valen7').paused = true;
  await bad(SPEAKER, /valen7 must be logged in/);
  h.bot('valen7').paused = false;
  h.bot('grail26').client._standAsideUntil = Date.now() + 60000;
  await bad(SPEAKER, /playing it yourself/);
  assert(!h.raid && [...h.bots.values()].every((b) => b.restarts === 0), 'nobody moved');
});

test('raid plan: a class-seat boss takes the role from the class; a lost hand fight is no try and teaches no potions', async () => {
  const h = hub();
  const r = await h.raidPlanStart({ boss: 'ultra-dage', seats: [
    { id: 'grail26', cls: 'Verus DoomKnight', potions: true }, { id: 'oren7', cls: 'ArchPaladin' },
    { id: 'sable7', cls: 'Lord of Order' }, { id: 'valen7', cls: 'Void Highlord', potions: true },
  ] });
  assert(r.ok, r.error);
  eq(h.raid.plan.seats.map((s) => s.role), ['Taunter1', 'Taunter2', 'Decayer', 'Dps1']);
  assert(!fs.existsSync(path.join(P.ROOT, 'raid-plan.txt')), 'no Comps at Dage: no plan file');
  const raid = h.raid;
  raid.fight = { startAt: Date.now(), samples: [] };
  raid.attempts = [{ id: 'oren7', outcome: 'wipe' }];
  h.raidCallOff('the party wiped');
  eq(h.settings.raids.tries['ultra-dage'], undefined, 'not a lost try');
  eq((h.settings.potionPolicy || {})['ultra-dage'], undefined, 'no potions verdict');
  eq(h.raid, null);
});

test('raid plan: the Stop button calls the raid off for everyone, not as a try, and clears the plan file', async () => {
  const h = hub();
  assert((await h.raidPlanStart({ boss: 'ultra-speaker', seats: SPEAKER.map((s) => ({ ...s })) })).ok);
  for (const b of h.bots.values()) b.current = { raid: h.raid.id, type: 'script' };
  eq(h.raidStopByHand().ok, true);
  eq(h.raid, null);
  eq(h.settings.raids.tries['ultra-speaker'], undefined);
  assert(!fs.existsSync(path.join(P.ROOT, 'raid-plan.txt')), 'plan file cleared');
  assert([...h.bots.values()].every((b) => b.restarts === 2), 'all four back to their own work');
  eq(h.raidStopByHand().ok, false, 'nothing to stop');
});

test('raid plan: the vendored UltraComp reads the plan (seraph-plan) and keeps the role code and taunts', () => {
  const cs = fs.readFileSync(path.join(ultras.SRC, 'DependenciesUltras', 'UltraComp.cs'), 'utf8');
  assert(cs.includes('public const string SeraphPlanComp = "seraph-plan";'));
  assert(cs.includes('raid-plan.txt') && cs.includes(': t.Taunt,') && cs.includes('Stop(boss, $"Seraph raid plan: {why}");'));
});
