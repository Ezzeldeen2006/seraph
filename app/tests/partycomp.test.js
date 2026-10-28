// Party line-ups for help calls (lib/partycomp.js, the owner 2026-10-13): never four ArchPaladins - at least one support,
// two when the boss hits hard, the fight is long or the last call bled; the best rank-10 class per role.
const pc = require('../lib/partycomp');
const { Hub } = require('../lib/hub');

const R10 = pc.RANK10_CP;
const cls = (...names) => names.map((name) => ({ name, cp: R10 }));
// What the four own on 2026-10-13 (rank 10 only).
const PARTY = () => [
  { id: 'sable7', classes: cls('Lord of Order', 'StoneCrusher', 'ArchPaladin', 'Scarlet Sorceress', 'Healer') },
  { id: 'valen7', classes: cls('Void Highlord', 'ArchPaladin', 'StoneCrusher') },
  { id: 'nova7', classes: cls('ArchPaladin', 'StoneCrusher', 'Glacial Berserker') },
  { id: 'oren7', classes: cls('ArchPaladin', 'StoneCrusher', 'Scarlet Sorceress') },
];

test('partycomp: an ordinary boss gets one support and three damage dealers', () => {
  const sh = pc.shape(4, { name: 'Some Boss', hpMax: 300000 }, { hit: 2000, ownHp: 11000, dps: 2800 });
  eq(sh.roles, ['support', 'dps', 'dps', 'dps']);
  const plan = pc.assign(sh.roles, PARTY());
  eq(plan.seats.sable7.cls, 'Lord of Order');
  eq(plan.seats.sable7.role, 'support');
  eq(plan.seats.valen7.cls, 'Void Highlord');
  eq([plan.seats.nova7.cls, plan.seats.oren7.cls], ['ArchPaladin', 'ArchPaladin'], 'a second ArchPaladin beats a weak starter class');
  eq(plan.seats.valen7.mode, 'Atk');
});

test('partycomp: a boss that one-shots us (Legion Lich Lord) gets two supports', () => {
  const sh = pc.shape(4, { name: 'Legion Lich Lord', hpMax: 848160 }, { hit: 16000, ownHp: 11000, dps: 2800 });
  eq(sh.roles.filter((r) => r === 'support').length, 2);
  assert(/hits for 145% of my HP/.test(sh.why), sh.why);
  const plan = pc.assign(sh.roles, PARTY());
  const seats = Object.values(plan.seats);
  eq(seats.filter((s) => s.role === 'support').map((s) => s.cls).sort(), ['Lord of Order', 'StoneCrusher']);
  eq(seats.filter((s) => s.role === 'dps').map((s) => s.cls).sort(), ['ArchPaladin', 'Void Highlord']);
  eq(plan.seats.valen7.cls, 'Void Highlord', 'the only Void Highlord deals damage');
});

test('partycomp: long fights and a bloody last call also ask for two supports; two characters still take one', () => {
  eq(pc.shape(4, { name: 'Big', hpMax: 5e6 }, { hit: 1000, ownHp: 11000, dps: 2800 }).roles.filter((r) => r === 'support').length, 2, 'a ~7 min fight');
  eq(pc.shape(4, { name: 'X', hpMax: 300000 }, {}, { kills: 1, deaths: 9 }).roles.filter((r) => r === 'support').length, 2);
  eq(pc.shape(4, { name: 'X', hpMax: 300000 }, {}, { kills: 0, deaths: 2 }).roles.filter((r) => r === 'support').length, 1);
  eq(pc.shape(2, { name: 'X', hpMax: 5e6 }, { hit: 20000, ownHp: 11000 }).roles, ['support', 'dps']);
  eq(pc.shape(1, { name: 'X' }).roles, ['dps']);
});

test('partycomp: named ultras keep their usual line-up, tanks counting as supports', () => {
  const sh = pc.shape(4, { name: 'Ultra Nulgath', hpMax: 1e7 }, {});
  eq(sh.roles, ['support', 'support', 'dps', 'support']);
});

test('partycomp: classes below rank 10 are left out; a late joiner fills the missing support', () => {
  const members = PARTY();
  members[0].classes = [{ name: 'Lord of Order', cp: 27884 }, ...cls('ArchPaladin', 'StoneCrusher')];
  const plan = pc.assign(['support', 'dps', 'dps'], members.slice(0, 3));
  assert(Object.values(plan.seats).every((s) => s.cls !== 'Lord of Order'), 'rank 5 Lord of Order is not fielded');
  eq(Object.values(plan.seats).filter((s) => s.role === 'support').length, 1);
  const seats = { a: { cls: 'ArchPaladin', role: 'dps' }, b: { cls: 'Void Highlord', role: 'dps' } };
  eq(pc.lateSeat(['support', 'dps', 'dps'], seats, PARTY()[3]).role, 'support');
  eq(pc.lateSeat(['support', 'dps', 'dps'], seats, PARTY()[3]).cls, 'StoneCrusher');
  seats.c = { cls: 'StoneCrusher', role: 'support' };
  eq(pc.lateSeat(['support', 'dps', 'dps'], seats, PARTY()[2]).role, 'dps');
});

test('partycomp: a help call plans the line-up once and hands every member its seat', async () => {
  const bots = new Map();
  for (const m of PARTY()) bots.set(m.id, { id: m.id, classPoints: async () => m.classes });
  bots.get('valen7').client = { w: { myAvatar: { dataLeaf: { intHPMax: 11000 } } }, fightStats: () => ({ hit: 16000, dps: 2800 }) };
  const hub = { bots, infos: [], info(m) { this.infos.push(m); } };
  for (const k of ['planParty', 'partySeat', 'recordHelp']) hub[k] = Hub.prototype[k].bind(hub);
  const h = { by: 'valen7', who: 'Valen7', helpers: ['sable7', 'nova7'], monster: 'Legion Lich Lord', hpMax: 848160 };
  const seat = await hub.partySeat(bots.get('sable7'), h);
  eq(seat.cls, 'Lord of Order');
  eq((await hub.partySeat(bots.get('valen7'), h)).cls, 'Void Highlord');
  assert(/Legion Lich Lord party: 2 supports/.test(hub.infos.join(' | ')), hub.infos.join(' | '));
  const late = await hub.partySeat(bots.get('oren7'), h);
  assert(late && late.cls, 'a late joiner gets a seat too');
  eq(hub.infos.filter((m) => /party:/.test(m)).length, 1, 'planned once');
  hub.recordHelp({ monster: 'Legion Lich Lord', kills: 1, deaths: 12 });
  eq(hub.helpHistory['legion lich lord'].deaths, 12);
});
