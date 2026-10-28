// Engine limits: every number that sizes the Skua engines, in one place (2026-10-29, the owner: "people may run our
// engine on a super computer or a good gaming PC instead of the potato laptop ... give the user freedom").
//
// Each value comes from, first match wins:
//   1. hub.json in SERAPH_ROOT - the dashboard's System page writes it      "maxEngines": 12
//   2. an environment variable - for systemd units and containers           SERAPH_MAX_ENGINES=12
//   3. a default sized to this machine's RAM and cores ("auto")
// Unset, null, "" or "auto" means auto. The auto values are what the 2-core 3 GB laptop Seraph grew up on needs, and
// they scale up from there. None of them is a hard ceiling: any number the machine can carry may be set.
'use strict';
const os = require('os');

const MB = 1048576;
const GB = 1024 * MB;

// What each key means, its environment variable and the range a value is clamped to. `zero` says what 0 means where
// it is not "auto" (keys without it treat 0 as auto, the way hub.json's maxEngines always has).
const KEYS = {
  maxEngines: { env: 'SERAPH_MAX_ENGINES', min: 1, max: 4096, unit: 'engines',
    label: 'Engines that always run', help: 'This many characters can run a script at the same time, whatever the load. Each running script is one .NET process.' },
  engineCeiling: { env: 'SERAPH_ENGINE_CEILING', min: 1, max: 4096, unit: 'engines',
    label: 'Most engines at once', help: 'Above the first number, more engines start only while CPU and memory have room (Linux). Auto: one per character.' },
  engineMemoryMb: { env: 'SERAPH_ENGINE_MEMORY_MB', min: 256, max: 16777216, unit: 'MB', zero: 'no budget',
    label: 'Memory for all engines', help: 'No new engine starts while the running ones use this much together. 0 = no budget (the machine\'s free memory still counts).' },
  engineHeapMb: { env: 'SERAPH_ENGINE_HEAP_MB', min: 0, max: 1048576, unit: 'MB', zero: 'no limit',
    label: 'Heap per engine', help: 'The .NET garbage-collected heap of one engine. A script that needs more fails instead of eating the machine. 0 = no limit.' },
  engineRecycleMb: { env: 'SERAPH_ENGINE_RECYCLE_MB', min: 0, max: 1048576, unit: 'MB', zero: 'never',
    label: 'Fresh engine above', help: '.NET never unloads a compiled script, so engines grow. Between scripts, one this big is replaced by a fresh one. 0 = never.' },
  engineMb: { env: 'SERAPH_ENGINE_MB', min: 16, max: 1048576, unit: 'MB',
    label: 'One engine costs about', help: 'What the next engine is expected to take, used to decide whether it fits.' },
  engineNice: { env: 'SERAPH_ENGINE_NICE', min: 0, max: 19, zero: 'off',
    label: 'Engine priority (nice)', help: 'Linux: engines run this many nice levels below the hub, so the hub answers them first when the cores are full. 0 = same priority.' },
  engineBurst: { env: 'SERAPH_ENGINE_BURST', bool: true,
    label: 'Start more when there is room', help: 'Off = never more than the first number.' },
  engineAdmitCpu: { env: 'SERAPH_ENGINE_ADMIT_CPU', min: 1, max: 100, unit: '%',
    label: 'Start more below CPU pressure, 1 min', help: 'Kernel CPU pressure: the share of time a thread waited for a core.' },
  engineAdmitCpu10: { env: 'SERAPH_ENGINE_ADMIT_CPU10', min: 1, max: 100, unit: '%',
    label: 'Start more below CPU pressure, 10 s', help: 'The same over the last 10 seconds.' },
  engineShedCpu: { env: 'SERAPH_ENGINE_SHED_CPU', min: 1, max: 100, unit: '%',
    label: 'Hand an extra engine back above', help: 'CPU pressure (1 min) twice in a row: the newest extra engine goes back to the queue.' },
  engineStaggerSec: { env: 'SERAPH_ENGINE_STAGGER_SEC', min: 0, max: 3600, unit: 's', zero: 'no wait',
    label: 'Between two extra engine starts', help: 'A cold start compiles CoreBots: a full core for 20-30 s on a slow CPU.' },
  engineCoolMin: { env: 'SERAPH_ENGINE_COOL_MIN', min: 0, max: 1440, unit: 'min', zero: 'no rest',
    label: 'Rest after an overload', help: 'No extra engine starts this long after one was handed back.' },
};

function machine() {
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : ((os.cpus() || []).length || 1);
  return { totalBytes: os.totalmem(), cpus };
}

// The defaults. Engines, not characters, are what a machine has to carry: a logged-in headless character is ~15 MB in
// node, a running engine a .NET process of ~150-330 MB that takes most of a core while it compiles.
function autoValues(m, { headless = true, characters = 0 } = {}) {
  const totalMb = m.totalBytes / MB;
  let floor;
  // The desktop app answers every engine call from the one Flash game thread: that thread, not the machine, is the limit.
  if (!headless) floor = 4;
  // The 3 GB laptop: 3 engines (~900 MB) and the other services on it keep running.
  else if (m.totalBytes < 4 * GB) floor = 3;
  // Bigger machines: ~330 MB per engine after 1.5 GB for the system and node, two engines per core (an engine uses
  // 7-12 % of a core once its script runs), and never fewer than the 4 the laptop runs.
  else floor = Math.max(4, Math.min(Math.floor((totalMb - 1536) / 330), m.cpus * 2));
  const heap = m.totalBytes < 8 * GB ? 256 : 512;
  return {
    maxEngines: floor,
    engineCeiling: Math.max(floor, characters || 0),
    engineMemoryMb: 0,
    engineHeapMb: heap,
    engineRecycleMb: heap + 74,
    engineMb: 160,
    engineNice: 4,
    engineBurst: true,
    engineAdmitCpu: 40,
    engineAdmitCpu10: 60,
    engineShedCpu: 80,
    engineStaggerSec: m.cpus <= 2 ? 60 : Math.max(10, Math.round(120 / m.cpus)),
    engineCoolMin: 10,
  };
}

// One raw value (hub.json or env) -> the value, or undefined for auto.
function parse(key, raw) {
  const k = KEYS[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    raw = raw.trim();
    if (raw === '' || raw.toLowerCase() === 'auto') return undefined;
  }
  if (k.bool) {
    if (raw === true || raw === false) return raw;
    const t = String(raw).toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(t)) return true;
    if (['0', 'false', 'off', 'no'].includes(t)) return false;
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  if (n === 0) return k.zero ? 0 : undefined;
  return Math.min(k.max, Math.max(k.min, n));
}

// The older env name for the heap: bytes, often hex (SERAPH_ENGINE_HEAP=0x10000000).
function envRaw(key, env) {
  const v = env[KEYS[key].env];
  if (v != null && v !== '') return v;
  if (key === 'engineHeapMb' && env.SERAPH_ENGINE_HEAP) { const b = Number(env.SERAPH_ENGINE_HEAP); return Number.isFinite(b) ? Math.round(b / MB) : undefined; }
  return undefined;
}

// Every value, and where each came from ('hub.json', 'env' or 'auto').
//   opts.machine     { totalBytes, cpus } (tests pass a fake one)
//   opts.headless    false for the desktop app with the Flash game
//   opts.characters  how many characters the hub runs (the auto ceiling is one engine per character)
function resolve(settings = {}, opts = {}) {
  const m = opts.machine || machine();
  const env = opts.env || process.env;
  const auto = autoValues(m, opts);
  const values = {};
  const source = {};
  for (const key of Object.keys(KEYS)) {
    const fromHub = parse(key, settings[key]);
    const fromEnv = fromHub === undefined ? parse(key, envRaw(key, env)) : undefined;
    if (fromHub !== undefined) { values[key] = fromHub; source[key] = 'hub.json'; }
    else if (fromEnv !== undefined) { values[key] = fromEnv; source[key] = 'env'; }
    else { values[key] = auto[key]; source[key] = 'auto'; }
  }
  // The auto ceiling is one engine per character above the floor actually in force, not above the auto floor.
  if (source.engineCeiling === 'auto') values.engineCeiling = Math.max(values.maxEngines, opts.characters || 0);
  // A ceiling someone set also caps an automatic floor ("at most 10" means 10), but a floor someone set always holds.
  if (source.engineCeiling !== 'auto' && source.maxEngines === 'auto') values.maxEngines = Math.min(values.maxEngines, values.engineCeiling);
  if (!values.engineBurst) values.engineCeiling = values.maxEngines;
  values.engineCeiling = Math.max(values.maxEngines, values.engineCeiling);
  // A bigger heap someone set needs a bigger recycle point, or every engine would be replaced after each script.
  if (source.engineRecycleMb === 'auto') values.engineRecycleMb = values.engineHeapMb > 0 ? values.engineHeapMb + 74 : Math.max(1024, auto.engineRecycleMb);
  return { values, source, auto, machine: { totalMb: Math.round(m.totalBytes / MB), cpus: m.cpus } };
}

// A change from the dashboard or the API: { key: value | null }. null, "" or "auto" go back to auto (the key is
// removed from hub.json). Unknown keys and values that are not numbers are refused, never guessed at.
function validate(patch = {}) {
  const set = {};
  const unset = [];
  const errors = [];
  for (const [key, raw] of Object.entries(patch || {})) {
    const k = KEYS[key];
    if (!k) { errors.push(`unknown setting ${key}`); continue; }
    if (raw === null || raw === undefined || (typeof raw === 'string' && (raw.trim() === '' || raw.trim().toLowerCase() === 'auto'))) { unset.push(key); continue; }
    if (k.bool) {
      const v = parse(key, raw);
      if (v === undefined) errors.push(`${key} must be true or false`); else set[key] = v;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) { errors.push(`${key} must be a number`); continue; }
    if (n === 0) { if (k.zero) set[key] = 0; else unset.push(key); continue; }
    if (n < k.min || n > k.max) { errors.push(`${key} must be between ${k.min} and ${k.max}`); continue; }
    set[key] = n;
  }
  return { ok: errors.length === 0, set, unset, errors };
}

module.exports = { KEYS, resolve, validate, autoValues, machine, MB, GB };
