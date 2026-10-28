// Seraph 5 help squads (lib/squad.js, hub.requestHelp / escalateHelp / helpTick / guard calls, room limits).
// 2026-10-26: Vexa called all seven 77 times in a day, each veteran answered ~140 calls, and the forge scripts the
// calls interrupted had 0 finishes in 120-166 starts.
const path = require('path');
const squad = require('../lib/squad');
const { Hub } = require('../lib/hub');
const { Bot } = require('../lib/bot');

const CLASSES = {
  support: [{ name: 'Lord of Order', cp: 302500 }, { name: 'ArchPaladin', cp: 302500 }],
  dps: [{ name: 'Void Highlord', cp: 302500 }, { name: 'Dragon of Time', cp: 302500 }],
};

function fakeHub(settings = {}) {
  const hub = { settings: { levelParty: { room: 13579 }, notify: {}, ...settings }, bots: new Map(), clients: new Map(), infos: [], info(m) { this.infos.push(m); }, notify() {}, raid: null, assistFor: () => null, partyWalls: {} };
  for (const k of ['isBoss', 'soloBosses', 'bossKilled', 'bossDeath', 'struggle', 'takeRoute', 'requestHelp', 'assistTaskFor', 'helpTask', 'helpDone', 'loadWalls', 'isPartyWall', 'deathCap', 'canGoPublic', 'goPublic', 'helpCoolingFor', 'forgetSolo', 'helpFarmKill', 'helpMinLevel', 'levelOf', 'engineYield', 'engineNext', 'engineUrgent', ...Hub.HELP_METHODS]) hub[k] = Hub.prototype[k].bind(hub);
  hub.bot = (id) => hub.bots.get(id) || null;
  hub._squadBook = new squad.SquadBook(path.join(process.env.SERAPH_ROOT, `squads-${Math.random().toString(36).slice(2)}.json`));
  hub.engineWaiting = new Set(); hub.engineBusy = new Set(); hub.engineSince = new Map(); hub.engineWaitSince = new Map();
  return hub;
}
function fakeBot(id, hub, { level = 100, kind = 'party', classes = CLASSES.dps, current = { type: 'script', path: 'x.cs' }, area = 'infernalspire-13579' } = {}) {
  const b = {
    id, account: { label: id, status: 'active', kind, helper: kind === 'guest' }, running: true, paused: false, current, journals: [], ran: [],
    client: { w: { strAreaName: area, strMapName: area.split('-')[0], myAvatar: { dataLeaf: { intHPMax: 3000 } } }, playersHere: () => [] },
    name: async () => id, map: async () => area.split('-')[0], cell: async () => 'r21a', level: async () => level, classPoints: async () => classes,
    journal(m) { this.journals.push(m); }, runNow(t) { this.ran.push(t); return Promise.resolve(true); },
    restarts: 0, restart() { this.restarts++; return Promise.resolve(true); }, taskKey(t) { return t ? [t.type, t.path || '', t.name || ''].join('|') : ''; },
  };
  hub.bots.set(id, b);
  hub.clients.set(id, b.client);
  return b;
}
// The 2026-10-26 party: four veterans at 100, three new girls in the 80s, the owner's main as a helper.
function party(hub) {
  const vets = ['sable7', 'valen7', 'nova7', 'oren7'].map((id, i) => fakeBot(id, hub, { classes: i === 0 ? CLASSES.support : CLASSES.dps }));
  const girls = [['vexa', 85], ['edda', 86], ['sunna', 78]].map(([id, level]) => fakeBot(id, hub, { level }));
  const main = fakeBot('grail26', hub, { kind: 'guest' });
  return { vets, girls, main };
}
const malxas = { name: 'Malxas', cell: 'r21a', hpMax: 2000000 };

test('squad: the cheapest helpers go - waiting or idle first, a running script last, the owner\'s main only when nobody else', async () => {
  const c = (id, x) => ({ id, level: 100, ...x });
  const picks = squad.pick([
    c('busy', { engine: true, heldMs: 30 * 60000, task: 'script' }),
    c('fresh', { engine: true, heldMs: 60000, task: 'script' }),
    c('waiter', { waiting: true, task: 'script' }),
    c('hunter', { task: 'kill' }),
    c('main', { guest: true, waiting: true, task: 'script' }),
    c('idle', { task: null }),
  ], { size: 3, callerLevel: 85 });
  eq(picks, ['idle', 'waiter', 'hunter'], 'idle and waiting first, then work without an engine');
  eq(squad.cost({ engine: true, heldMs: 60000, task: 'script' }) > squad.cost({ engine: true, heldMs: 3600000, task: 'script' }), true, 'a script that just started is the costliest to stop');
  eq(squad.cost({ guest: true, waiting: true }) > squad.cost({ engine: true, heldMs: 3600000 }), true, 'the main comes after every party character');
});

test('squad: two strong helpers and one support class when there are any; never more than the room takes', async () => {
  const picks = squad.pick([
    { id: 'girl1', level: 85, waiting: true }, { id: 'girl2', level: 86, waiting: true }, { id: 'girl3', level: 78, waiting: true },
    { id: 'vet1', level: 100, engine: true, heldMs: 3600000, task: 'script' }, { id: 'vet2', level: 100, engine: true, heldMs: 3600000, task: 'script', support: true },
  ], { size: 3, callerLevel: 85 });
  eq(picks.filter((id) => id.startsWith('vet')).length, 2, `two veterans for a level-85 caller: ${picks}`);
  assert(picks.includes('vet2'), 'the support class is in');
  eq(squad.pick([{ id: 'a' }, { id: 'b' }, { id: 'c' }], { size: 3, cap: 1 }).length, 1, 'a room with one seat left takes one');
  eq(squad.pick([{ id: 'a' }], { size: 3, cap: 0 }), [], 'a full room takes nobody');
});

test('help squad: a call sends three, picked by cost; the rest keep working, the main is not pulled', async () => {
  const hub = fakeHub();
  const { vets, girls, main } = party(hub);
  const [vel] = girls;
  // Valen and Oren run forge scripts with engines; Sable and Nova wait for an engine; the main farms.
  hub.engineBusy = new Set(['valen7', 'oren7', 'grail26']);
  hub.engineSince = new Map([['valen7', Date.now() - 20 * 60000], ['oren7', Date.now() - 50 * 60000], ['grail26', Date.now() - 60 * 60000]]);
  hub.engineWaiting = new Set(['sable7', 'nova7', 'edda']);
  hub.engineWaitSince = new Map([['sable7', Date.now() - 600000], ['nova7', Date.now() - 300000], ['edda', Date.now() - 100000]]);
  const h = await hub.requestHelp(vel, { map: 'infernalspire', cell: 'r21a', monster: 'Malxas', hpMax: 2e6, why: 'test' });
  assert(h, 'a call went out');
  eq(h.full, false, 'a squad, not everyone');
  eq(h.helpers.length, 3);
  assert(h.helpers.includes('sable7') && h.helpers.includes('nova7'), `the two veterans waiting for an engine go: ${h.helpers}`);
  eq(main.ran.length, 0, 'the owner\'s main keeps farming');
  eq(vets[1].ran.length + vets[3].ran.length, h.helpers.filter((id) => ['valen7', 'oren7'].includes(id)).length, 'only picked engine holders are pulled');
  assert(hub.infos.some((i) => /a squad \(/.test(i)), hub.infos.join(' | '));
  eq(hub.engineTurns.get('sable7').since, hub.engineWaitSince.get('sable7'), 'a waiter keeps its place in the engine line');
  eq(hub.helpTask(vets[1]), null, 'a character not in the squad does not join on its next loop');
});

test('help squad: deaths with no kill call everyone, and the party wall only counts deaths from there', async () => {
  const hub = fakeHub();
  const { girls } = party(hub);
  const [vel] = girls;
  const h = await hub.requestHelp(vel, { map: 'infernalspire', cell: 'r21a', monster: 'Malxas', hpMax: 2e6, why: 'test' });
  const squadIds = h.helpers.slice();
  const t0 = Date.now();
  for (let i = 0; i < squad.ESCALATE_DEATHS; i++) await hub.bossDeath(hub.bots.get(squadIds[i % squadIds.length]), malxas, t0 + i * 1000);
  await new Promise((r) => setImmediate(r));
  eq(h.full, true, 'escalated');
  assert(h.helpers.length > squadIds.length, 'more came');
  assert(hub.infos.some((i) => /squad needs more \(3 deaths, no kill\)/.test(i)), hub.infos.join(' | '));
  for (let i = 0; i < 7; i++) await hub.bossDeath(vel, malxas, t0 + 10000 + i * 1000);
  assert(hub.help === h, '7 deaths after calling everyone: no wall yet');
  await hub.bossDeath(vel, malxas, t0 + 30000);
  eq(hub.help, null, '8 deaths with everyone there: the wall');
  eq(hub.isPartyWall('Malxas'), true);
});

test('help squad: no kill after a few minutes calls everyone; a boss that needed everyone starts with everyone next time', async () => {
  const hub = fakeHub();
  const { girls } = party(hub);
  const [vel] = girls;
  const h = await hub.requestHelp(vel, { map: 'infernalspire', cell: 'r21a', monster: 'Malxas', hpMax: 2e6, why: 'test' });
  await hub.helpTick(h.at + 60000);
  eq(h.full, false, 'a minute in: still the squad');
  await hub.helpTick(h.at + squad.ESCALATE_MS + 1000);
  eq(h.full, true, 'no kill after the limit: everyone');
  hub.bossKilled(vel, { name: 'Malxas', hpMax: 2e6, byMe: true, others: 3, map: 'infernalspire' });
  eq(hub.help, null, 'killed: over');
  eq(hub.squadBook().needsAll('Malxas'), true, 'Malxas needed everyone');
  hub._helpCooldown = 0;
  const h2 = await hub.requestHelp(girls[1], { map: 'infernalspire', cell: 'r21a', monster: 'Malxas', hpMax: 2e6, why: 'test' });
  eq([h2.full, h2.startedFull], [true, true], 'the next call for it brings everyone at once');
});

test('guard: the caller\'s script stays on the boss, the squad fights next to it until the step moves on', async () => {
  const hub = fakeHub();
  const { girls } = party(hub);
  const [vel] = girls;
  vel.current = { type: 'script', path: 'Enhancement/UnlockForgeEnhancements.cs', entry: 'ForgeCapeEnhancement', goal: 'forge-cape' };
  vel.scriptStepRaw = '(HuntMonster) Killing Malxas for item: "Wings Of Destruction" 0/1';
  let wings = 0;
  vel.count = async () => wings;
  const h = await hub.struggle(vel, malxas, 3);
  assert(h && h.guard, 'a guard call');
  eq([h.farm.item, h.farm.untilOwned], ['Wings Of Destruction', true], 'one rare drop is a farm until it is there');
  eq(vel.ran.length, 0, 'the caller is not pulled off its script');
  assert(vel.journals.some((j) => /my script keeps going/.test(j)));
  const kill = (at) => hub.bossKilled(hub.bots.get(h.helpers[0]), { name: 'Malxas', hpMax: 2e6, byMe: true, others: 3, map: 'infernalspire' });
  kill();
  eq(hub.help, h, 'Malxas died without the wings: the squad stays');
  wings = 1; h.lastKillAt -= 10000; kill();
  await new Promise((r) => setImmediate(r));
  eq(hub.help, null, 'the wings dropped: the guard is over');

  // A guard on a boss the caller needs once: it ends when the script's step has moved past the boss.
  hub._helpCooldown = 0;
  vel.scriptStepRaw = '(HuntMonster) Killing Azkorath for item: "Azkorath\'s Wing" 1/1';
  const g = await hub.struggle(vel, { name: 'Azkorath', cell: 'r21a', hpMax: 2e6 }, 3);
  assert(g && g.guard);
  vel.scriptStepRaw = '(HuntMonster) Killing Azkorath for item: "Azkorath\'s Wing" 1/1';
  await hub.helpTick(g.at + 30000);
  eq(hub.help, g, 'still on Azkorath');
  vel.scriptStepRaw = '(QuestProgression) Doing Quest: [9999] - "Next"';
  await hub.helpTick(g.at + 40000);
  await hub.helpTick(g.at + 40000 + 91000);
  eq(hub.help, null, 'moved on for 90 s: over');
  assert(hub.infos.some((i) => /has moved on from Azkorath/.test(i)), hub.infos.join(' | '));
});

test('help squads: two callers get two squads, nobody is in both, and a third waits when everyone is taken', async () => {
  const hub = fakeHub({ squadSize: 2 });
  const { girls } = party(hub);
  const [vel, ela, sor] = girls;
  const h1 = await hub.requestHelp(vel, { map: 'infernalspire', cell: 'r21a', monster: 'Malxas', hpMax: 2e6, why: 'test' });
  const h2 = await hub.requestHelp(ela, { map: 'timekeep', cell: 'r9', monster: 'Mal-formed Gar', hpMax: 2e6, why: 'test' });
  assert(h1 && h2 && h1 !== h2, 'two calls at once');
  eq(h1.helpers.filter((id) => h2.helpers.includes(id) || id === h2.by), [], 'nobody is in both');
  eq(hub.helpOf(ela), h2);
  eq(await hub.requestHelp(vel, { map: 'infernalspire', monster: 'Malxas', why: 'again' }), h1, 'a caller has one call');
  // Everyone left: the third caller's call would be empty.
  const left = [...hub.bots.keys()].filter((id) => ![h1.by, h2.by, ...h1.helpers, ...h2.helpers].includes(id));
  for (const id of left) if (id !== 'sunna') hub.bots.get(id).running = false;
  const h3 = await hub.requestHelp(sor, { map: 'stormtemple', cell: 'r2', monster: 'Chaos Lord Lionfang', hpMax: 2e6, why: 'test' });
  eq(h3, null, 'nobody free: no empty call');
  assert(sor.journals.some((j) => /busy in other calls/.test(j)), sor.journals.join(' | '));
  hub.bossKilled(ela, { name: 'Mal-formed Gar', hpMax: 2e6, byMe: true, others: 3, map: 'timekeep' });
  eq(hub.helpOf(ela), null, 'Edda\'s call is over');
  eq(hub.help, h1, 'Vexa\'s goes on');
});

test('room limits: a full private room teaches the map\'s size; calls and late joiners respect it; a full room is no wall', async () => {
  const hub = fakeHub();
  const { vets, girls } = party(hub);
  const [vel] = girls;
  // Vexa and two veterans stand in chaosrealm-13579; a third is refused.
  for (const b of [vel, vets[0], vets[1]]) b.client.w.strAreaName = 'chaosrealm-13579';
  eq(hub.roomFull(vets[2], 'chaosrealm', 'chaosrealm-13579'), 3);
  eq(hub.roomFull(vets[3], 'chaosrealm', 'chaosrealm-4'), null, 'a public room teaches nothing (strangers)');
  eq(hub.squadBook().cap('chaosrealm'), 3);
  hub.settings.squadSize = 6;
  const h = await hub.requestHelp(vel, { map: 'chaosrealm', cell: 'r24', monster: 'Alteon', hpMax: 2e6, why: 'test' });
  eq(h.helpers.length, 2, 'three fit: the caller and two');
  // A helper refused at the door leaves the call; the call goes on.
  hub.helpUnreachable(hub.bots.get(h.helpers[0]), { id: h.id }, 'room full', true);
  eq(hub.help, h, 'no wall, no end');
  eq(hub.isPartyWall('Alteon'), false);
  eq(h.helpers.length, 1);
});

// 2026-10-26 22:32-23:19: Vexa's Alteon call in chaosrealm (one seat). Edda took the seat and killed Alteon 60 times
// for nothing (the farm call counted every kill), Vexa could not get back in, and helpTask handed six of ours - the
// main too - the call they had just been turned away from, ~1 join a second each.
test('one-seat rooms: no call into them; a helper turned away never takes the call back; a kill outside the caller\'s room is no kill', async () => {
  const hub = fakeHub();
  const { vets, girls, main } = party(hub);
  const [vel] = girls;
  const h = await hub.requestHelp(vel, { map: 'infernalspire', cell: 'r21a', monster: 'Malxas', hpMax: 2e6, why: 'test' });
  await hub.escalateHelp('test', Date.now(), h);
  eq(h.full, true);
  const gone = hub.bots.get(h.helpers[0]);
  hub.helpUnreachable(gone, { id: h.id }, 'could not join infernalspire: room infernalspire-13579 is full', true);
  eq(hub.helpTask(gone), null, 'turned away once: the call is not handed back on the next loop');
  // A room size learned mid-call holds for the calls already open.
  const free = [...vets, main].find((b) => b.id !== h.by && !h.helpers.includes(b.id) && !(h.unreachable || []).includes(b.id));
  for (const b of hub.bots.values()) b.client.w.strAreaName = 'whitemap-1';
  for (const id of [h.by, ...h.helpers]) hub.bots.get(id).client.w.strAreaName = 'infernalspire-13579';
  const inside = 1 + h.helpers.length;
  eq(hub.roomFull(gone, 'infernalspire', 'infernalspire-13579'), inside);
  eq(h.cap, inside, 'the open call learned the size');
  if (free) eq(hub.helpTask(free), null, 'the room is at its size: nobody else is handed the call');

  // A kill in a room the caller is not in does not count for the caller's call.
  vel.client.w.strAreaName = 'whitemap-1';
  hub.bossKilled(hub.bots.get(h.helpers[0]), { name: 'Malxas', hpMax: 2e6, byMe: true, others: 0, map: 'infernalspire' });
  eq(hub.help, h, 'the caller was outside: the call goes on');
  vel.client.w.strAreaName = 'infernalspire-13579';
  hub.bossKilled(hub.bots.get(h.helpers[0]), { name: 'Malxas', hpMax: 2e6, byMe: true, others: 1, map: 'infernalspire' });
  eq(hub.help, null, 'in the caller\'s room: killed, the call is over');

  // A map whose rooms hold one player gets no call at all.
  hub._helpCooldown = 0;
  hub.squadBook().roomFull('chaosrealm', 1);
  eq(await hub.requestHelp(vel, { map: 'chaosrealm', cell: 'r24', monster: 'Alteon', hpMax: 94570, why: 'test' }), null, 'nobody can come');
  assert(vel.journals.some((j) => /chaosrealm holds one player/.test(j)), vel.journals.join(' | '));
  eq(hub.helpCalls().length, 0, 'no call left open');
});

test('bot.join: "destination room is full" ends the join at once - no retries, no relog, the hub learns the size', async () => {
  const sent = []; const full = [];
  const b = {
    settings: {}, hub: { roomFull: (bot, map, area) => full.push([map, area]), partyRoom: () => 13579 }, client: { headless: true, send: async (s) => { sent.push(s); b.lastRoomFull = { t: Date.now() }; } },
    journals: [], journal(m) { this.journals.push(m); }, check() {}, wait: async () => {}, leaveCombat: async () => {}, unstick: async () => {},
    map: async () => 'battleon', g: async () => 'battleon-3', room: async () => 1, name: async () => 'Oren7', roomNumber: () => 13579, publicRoom: () => false, jump: async () => {},
  };
  b.waitFor = Bot.prototype.waitFor.bind(b);
  let err = null;
  try { await Bot.prototype.join.call(b, 'chaosrealm-13579', 'r24', 'Left'); } catch (e) { err = e; }
  eq(err && err.code, 'ROOM_FULL');
  assert(/could not join chaosrealm: room chaosrealm-13579 is full/.test(err.message), err && err.message);
  eq(sent.length, 1, 'one try');
  eq(full, [['chaosrealm', 'chaosrealm-13579']]);
  eq(b._joinFails || 0, 0, 'not counted toward a relog');
});

test('engine turns: a helper keeps its turn; the owner\'s main never takes the slot of a script that just started', async () => {
  const hub = fakeHub();
  const { vets, main } = party(hub);
  const now = Date.now();
  hub.engineBusy = new Set(['valen7']); hub.engineSince = new Map([['valen7', now - 60000]]);
  eq(hub.keepEngineTurn(vets[1], now), 1, 'a holder goes to the front');
  eq(hub.engineTurnBack('valen7', now + 1000), 1);
  eq(hub.engineTurnBack('valen7', now + 1000), null, 'used once');
  hub.engineWaitSince = new Map([['nova7', now - 999]]);
  hub.keepEngineTurn(vets[2], now);
  eq(hub.engineTurnBack('nova7', now + 5 * 3600000), null, 'kept 4 h, not forever');
  // The main waits; the only holder started a minute ago.
  hub.engineWaiting = new Set(['grail26']); hub.engineWaitSince = new Map([['grail26', now - 1000]]);
  hub.settings.maxEngines = 1; hub.headless = true;
  vets[1].current = { type: 'script', path: 'Enhancement/UnlockForgeEnhancements.cs', why: 'forge' };
  eq(hub.engineYield(now), null, 'a minute-old script keeps its engine');
  hub.engineSince.set('valen7', now - 4 * 60000);
  eq(hub.engineYield(now), 'valen7', 'after 3 min it gives way to the main');
  assert(main && vets[1].journals.some((j) => /giving my Skua engine to grail26/.test(j)));
});
