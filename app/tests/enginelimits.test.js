// Engine limits (2026-10-29, the owner: "maybe people will run our engine on a super computer or a good gaming PC
// instead of the potato laptop ... give the user the option to set the number of skua engines or memory"):
// lib/enginelimits.js sizes the engines to the machine, and hub.json / env override any of it.
const L = require('../lib/enginelimits');
const { Hub } = require('../lib/hub');

const GB = 1073741824;
const laptop = { totalBytes: 3 * GB, cpus: 2 };
const gaming = { totalBytes: 32 * GB, cpus: 8 };
const server = { totalBytes: 128 * GB, cpus: 32 };
const R = (settings, machine, opts = {}) => L.resolve(settings, { machine, env: {}, ...opts });

test('engine limits: auto keeps the laptop exactly as it ran and scales up on bigger machines', () => {
  const lap = R({ maxEngines: 4 }, laptop, { characters: 8 }).values;
  eq([lap.maxEngines, lap.engineCeiling, lap.engineHeapMb, lap.engineRecycleMb, lap.engineStaggerSec, lap.engineNice], [4, 8, 256, 330, 60, 4],
    'the laptop with its hub.json: floor 4, up to 8, 256 MB heap, fresh at 330 MB, 60 s apart, nice 4');
  eq(R({}, laptop).values.maxEngines, 3, 'the 3 GB laptop on auto: 3');
  const g = R({}, gaming, { characters: 12 }).values;
  eq([g.maxEngines, g.engineCeiling, g.engineHeapMb, g.engineRecycleMb], [16, 16, 512, 586], 'a 32 GB 8-core PC: two engines a core, a bigger heap');
  eq(R({}, server, { characters: 40 }).values.maxEngines, 64, 'a 128 GB 32-core server: 64, no cap of 8');
  eq(R({}, { totalBytes: 8 * GB, cpus: 2 }).values.maxEngines, 4, 'RAM alone does not raise it: 2 cores = 4');
  eq(R({}, gaming, { headless: false }).values.maxEngines, 4, 'the desktop app: the Flash thread decides, not the machine');
  eq(R({}, gaming).values.engineMemoryMb, 0, 'no engine memory budget unless someone sets one');
});

test('engine limits: hub.json beats env beats auto, and each value says where it came from', () => {
  const env = { SERAPH_MAX_ENGINES: '20', SERAPH_ENGINE_HEAP_MB: '1024', SERAPH_ENGINE_BURST: 'off' };
  const r = L.resolve({ maxEngines: 6 }, { machine: gaming, env });
  eq(r.values.maxEngines, 6); eq(r.source.maxEngines, 'hub.json');
  eq(r.values.engineHeapMb, 1024); eq(r.source.engineHeapMb, 'env');
  eq(r.values.engineRecycleMb, 1098, 'a bigger heap moves the auto recycle point with it');
  eq(r.values.engineBurst, false); eq(r.values.engineCeiling, 6, 'no burst: never more than the floor');
  eq(r.source.engineNice, 'auto');
  eq(L.resolve({}, { machine: gaming, env: { SERAPH_ENGINE_HEAP: '0x10000000' } }).values.engineHeapMb, 256, 'the old env name, in bytes');
  for (const unset of [null, '', 'auto', 0]) eq(R({ maxEngines: unset }, laptop).source.maxEngines, 'auto', `maxEngines ${JSON.stringify(unset)} = auto`);
});

test('engine limits: the ceiling is one per character unless set, and a set ceiling caps an auto floor', () => {
  eq(R({}, server, { characters: 30 }).values.engineCeiling, 64, 'never below the floor');
  eq(R({ maxEngines: 4 }, server, { characters: 30 }).values.engineCeiling, 30, 'one per character - no fixed 8');
  const capped = R({ engineCeiling: 10 }, server, { characters: 40 }).values;
  eq([capped.maxEngines, capped.engineCeiling], [10, 10], '"at most 10" means 10, even where auto would give 64');
  const both = R({ maxEngines: 12, engineCeiling: 10 }, server).values;
  eq([both.maxEngines, both.engineCeiling], [12, 12], 'a floor someone set always holds');
  eq(Hub.engineCeiling({ maxEngines: 4 }, 12), 12, 'Hub.engineCeiling: 12 characters, 12');
  eq(Hub.maxEngines({}, true, 8 * GB, 4), 8, 'Hub.maxEngines takes the core count too');
});

test('engine limits: 0 means none where that makes sense, and values are clamped', () => {
  const r = R({ engineHeapMb: 0, engineNice: 0, engineMemoryMb: 0, engineCoolMin: 0, engineStaggerSec: 0 }, gaming).values;
  eq([r.engineHeapMb, r.engineNice, r.engineMemoryMb, r.engineCoolMin, r.engineStaggerSec], [0, 0, 0, 0, 0], '0 = no heap limit, no nice, no budget, no rest, no wait');
  eq(r.engineRecycleMb, 1024, 'no heap limit: engines are refreshed at 1 GB');
  eq(R({ engineShedCpu: 500 }, gaming).values.engineShedCpu, 100, 'a percentage stays a percentage');
  eq(R({ engineHeapMb: 'lots' }, gaming).source.engineHeapMb, 'auto', 'garbage in hub.json is ignored, not guessed at');
});

test('engine limits: validate refuses what it cannot read and turns null/auto into "remove"', () => {
  const v = L.validate({ maxEngines: '12', engineHeapMb: 'abc', bogus: 1, engineCeiling: 'auto', engineBurst: 'off', engineMemoryMb: 100, engineNice: 0 });
  eq(v.ok, false);
  eq(v.set, { maxEngines: 12, engineBurst: false, engineNice: 0 });
  eq(v.unset, ['engineCeiling']);
  eq(v.errors, ['engineHeapMb must be a number', 'unknown setting bogus', 'engineMemoryMb must be between 256 and 16777216']);
  eq(L.validate({ engineMemoryMb: 0 }).set, { engineMemoryMb: 0 }, '0 = no budget is a real choice');
  eq(L.validate({ maxEngines: 0 }).unset, ['maxEngines'], '0 engines = auto, never "no engines"');
  eq(L.validate({ maxEngines: 5000 }).errors, ['maxEngines must be between 1 and 4096']);
});

function budgetHub(settings, rss) {
  const engines = new Map(Object.entries(rss).map(([id, mb]) => [id, { rssMb: () => mb }]));
  return Object.assign(Object.create(Hub.prototype), {
    settings, headless: true, info() {}, bots: new Map(), engines, engineBusy: new Set(Object.keys(rss)),
    engineLoadNow: () => ({ ok: false }), engineUrgent: () => false,
  });
}

test('engine limits: the memory budget for all engines is the hard line, before the floor', () => {
  const now = Date.now();
  let h = budgetHub({ maxEngines: 10, engineMemoryMb: 1000 }, { a: 500, b: 400 });
  const r = h.engineRoom(null, now);
  eq(r.ok, false, '900 MB used + ~160 for the next one > 1000');
  assert(/engine memory 900\/1000 MB/.test(r.why), r.why);
  h = budgetHub({ maxEngines: 10, engineMemoryMb: 1000 }, { a: 300 });
  eq(h.engineRoom(null, now).ok, true, '300 + 160 fits');
  h = budgetHub({ maxEngines: 10, engineMemoryMb: 100 }, {});
  eq(h.engineRoom(null, now).ok, true, 'one engine always may run, whatever the budget');
  h = budgetHub({ maxEngines: 10 }, { a: 4000, b: 4000 });
  eq(h.engineRoom(null, now).ok, true, 'no budget set: only the floor and the machine count');
  const b = budgetHub({ maxEngines: 2, engineMemoryMb: 3000 }, { a: 1200, b: 900 }).engineBudget(now);
  eq([b.floor, b.memoryMb, b.memoryBudgetMb], [2, 2100, 3000]);
  // Where the OS gives no reading (Windows), each running engine counts as engineMb.
  h = budgetHub({ maxEngines: 10, engineMemoryMb: 500, engineMb: 200 }, {});
  h.engineBusy = new Set(['x', 'y']);
  assert(/engine memory 400\/500/.test(h.engineRoom(null, now).why), 'two unmeasured engines at 200 MB each');
});

test('engine limits: each engine takes its heap, recycle point and nice from the hub', async () => {
  const { SkuaEngine } = require('../lib/skua/engine');
  const client = { id: 'limits-test', headless: true, on() {}, off() {}, removeListener() {} };
  const e = new SkuaEngine(client, { heapMb: 1024, recycleMb: 0, nice: 0 });
  eq([e.limit('heapMb', 'engineHeapMb'), e.limit('recycleMb', 'engineRecycleMb'), e.limit('nice', 'engineNice')], [1024, 0, 0]);
  e.proc = { pid: 1 }; e.runs = 5; e.rssMb = () => 9999;
  eq(await e.recycleIfBig(), false, 'recycle 0 = never refresh, however big');
  const d = new SkuaEngine(client, {});
  eq(d.limit('nice', 'engineNice'), 4, 'nothing passed: env or the machine default');
});
