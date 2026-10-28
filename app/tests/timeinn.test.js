// Time Inn ultras with the party's real classes (2026-10-13, the owner: "loo, sc, vhl and ap ... this comp can beat the
// ultras"), the raid seats file, the forced test raid, and the requiresQty gate (Dauntless after Ultra Malgor).
const fs = require('fs');
const path = require('path');
const ultraready = require('../lib/ultraready');
const { Hub } = require('../lib/hub');
const { P } = require('../lib/paths');
const { Brain } = require('../lib/brain');

const BASIC = ['Healer', 'Rogue', 'Mage', 'Warrior', 'StoneCrusher', 'ArchPaladin', 'Master Ranger'];
const party = (lvlOren = 98) => [
  { id: 'sable7', level: 100, classes: [...BASIC, 'Lord of Order', 'Shaman'], weapon: { value: 0.4 } },
  { id: 'valen7', level: 100, classes: [...BASIC, 'Void Highlord', 'Shaman'], weapon: { value: 0.4 } },
  { id: 'nova7', level: 100, classes: [...BASIC, 'Lord of Order'], weapon: { value: 0.3 } },
  { id: 'oren7', level: lvlOren, classes: [...BASIC, 'Lord of Order'], weapon: { value: 0.4 } },
];
const seatsOf = (b) => Object.fromEntries(b.seats.map((s) => [s.id, s.cls]));

test('timeinn: LoO / SC / VHL / AP fill the three Time Inn line-ups; the other ultras still want VDK and KE', async () => {
  const r = ultraready.check(party(100));
  for (const id of ['ultra-ezrajal', 'ultra-warden', 'ultra-engineer']) {
    eq(r.bosses[id].ready, true, `${id}: ${r.bosses[id].missing.join('; ')}`);
    const s = seatsOf(r.bosses[id]);
    eq([s.sable7, s.valen7], ['Lord of Order', 'Void Highlord'], `${id} seats ${JSON.stringify(s)}`);
    eq([s.nova7, s.oren7].sort(), ['ArchPaladin', 'StoneCrusher'], `${id} seats ${JSON.stringify(s)}`);
  }
  eq(r.bosses['ultra-nulgath'].ready, true, `Nulgath: AP + VHL taunt (2026-10-18): ${r.bosses['ultra-nulgath'].missing.join('; ')}`);
  eq(r.bosses['ultra-tyndarius'].ready, false, 'Tyndarius too');
  const lvl = ultraready.check(party(98)).bosses['ultra-ezrajal'];
  eq([lvl.ready, lvl.missing], [false, ['oren7: level 100 (is 98)']], 'the level rule still holds for the automatic raids');
});

function raidHub(members) {
  const hub = Object.create(Hub.prototype);
  hub.bots = new Map();
  hub.settings = {};
  hub.saveSettings = () => {};
  hub.infos = []; hub.info = (m) => hub.infos.push(m);
  hub.notify = () => {};
  for (const m of members) {
    hub.bots.set(m.id, { id: m.id, account: { username: m.id[0].toUpperCase() + m.id.slice(1), label: m.id }, running: true, paused: false, serverName: 'Swordhaven', current: { type: 'script', why: 'x' }, restarted: 0, journal() {}, restart() { this.restarted++; } });
  }
  hub.refreshUltraReady = async () => { hub._ultra = ultraready.check(members); return hub._ultra; };
  return hub;
}

test('timeinn: a forced test raid waives the level rule, writes the seats, and never starts with an empty seat', async () => {
  const hub = raidHub(party(98));
  const no = await hub.startRaid('ultra-ezrajal');
  assert(!no.ok && /not ready: oren7: level 100/.test(no.error), no.error);
  const r = await hub.startRaid('ultra-ezrajal', { force: true });
  assert(r.ok, r.error);
  eq(r.waived, ['oren7: level 100 (is 98)']);
  eq(hub.raid.script, 'SeraphUltras/IndividualUltras/1UltraEzrajalv3.cs');
  const lines = fs.readFileSync(path.join(P.ROOT, 'raid-seats.txt'), 'utf8').trim().split('\n').sort();
  assert(lines.includes('Sable7=Lord of Order') && lines.includes('Valen7=Void Highlord') && lines.length === 4, lines.join(' | '));
  eq([...hub.bots.values()].map((b) => b.restarted), [1, 1, 1, 1], 'all four switch at once');
  eq((await hub.startRaid('ultra-warden', { force: true })).ok, false, 'one raid at a time');
  hub.raid = null;
  const gap = await hub.startRaid('ultra-tyndarius', { force: true });
  assert(!gap.ok && /nobody can take a seat/.test(gap.error), gap.error);
});

test('timeinn: a member short of raid potions brews them before the raid starts, once per 6 h (only with settings.raidPotions)', async () => {
  const hub = raidHub(party(100));
  eq(await hub.raidPrep([...hub.bots.values()], ultraready.BOSSES[0]), false, 'off by default (the owner: no potions)');
  hub.settings.raidPotions = true;
  const stock = { valen7: { 'Potent Battle Elixir': 8, 'Might Tonic': 8 } };
  hub.brain = { held: async (b, name) => ((stock[b.id] || {})[name] !== undefined ? stock[b.id][name] : 50) };
  const ran = [];
  for (const b of hub.bots.values()) b.runNow = (t) => ran.push([b.id, t.entry, t.args]);
  const four = [...hub.bots.values()];
  const boss = ultraready.BOSSES[0];
  eq(await hub.raidPrep(four, boss), true, 'Valen is short');
  eq(ran, [['valen7', 'PreparePotions', '20']]);
  assert(hub.infos.some((m) => /Valen7|valen7/.test(m) && /Might Tonic 8, Potent Battle Elixir 8/.test(m)), hub.infos.join(' | '));
  eq(await hub.raidPrep(four, boss), true, 'still short');
  eq(ran.length, 1, 'not sent again within 6 h');
  stock.valen7 = {};
  eq(await hub.raidPrep(four, boss), false, 'brewed: the raid can start');
  stock.oren7 = { 'Potent Honor Potion': 0, 'Potent Malice Potion': 40 };
  eq(await hub.raidPrep(four, boss), false, 'Malice over 30 stands in for Honor');
});

test('timeinn: haveAll - the potions goal is done only when every potion is stocked', async () => {
  const brain = Object.create(Brain.prototype);
  const stock = { 'Might Tonic': 20, 'Potent Battle Elixir': 8 };
  brain.held = async (b, n) => stock[n] || 0;
  eq(await brain.holdsAll({}, [['Might Tonic', 10], ['Potent Battle Elixir', 10]]), false);
  stock['Potent Battle Elixir'] = 10;
  eq(await brain.holdsAll({}, [['Might Tonic', 10], ['Potent Battle Elixir', 10]]), true);
});

test('timeinn: requiresQty holds Dauntless until the 5 Malgor Insignias are there', async () => {
  const brain = Object.create(Brain.prototype);
  let have = 0;
  brain.held = async () => have;
  const bot = { owns: async () => false, completedOnce: async () => false, g: async () => 0 };
  const goal = { id: 'forge-dauntless', script: 'Enhancement/UnlockForgeEnhancements.cs', entry: 'DauntLess', when: 100, haveQuest: 9172, requiresQty: ['Malgor Insignia', 5], repeat: 'daily' };
  const g = { paused: [] }; const st = { goalFails: {} }; const day = { goalsToday: {} };
  eq(await brain.goalReady(bot, goal, 100, g, st, day), false, 'no insignias');
  have = 5;
  eq(await brain.goalReady(bot, goal, 100, g, st, day), true, 'after the first Malgor kill');
});
