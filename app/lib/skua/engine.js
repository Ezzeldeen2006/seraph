// Skua's real script engine for one character.
//
// engine/host (SeraphSkua) is Skua.Core itself - ScriptManager, the Roslyn compiler, ScriptInterface, CoreBots -
// running with no window and no Flash. Every game call it makes arrives here as {t:'c', f, a} and is answered
// by the character's client:
//   headless client  -> client.swf.call()   (lib/skua/swfworld.js, a model of skua.swf and the game)
//   desktop client   -> client.rawCall()    (the real skua.swf inside Electron)
// Game packets go the other way as skua.swf's own callbacks (pext / packet), so Skua's handlers, drops, quest
// and kill tracking see exactly what they would in Skua. One process per character, started on demand.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const EventEmitter = require('events');
const { P } = require('../paths');
const { COMBAT_PACKETS } = require('./swfworld');
// The command of a packet as the Flash bridge hands it over (skua.swf pext: {params:{dataObj}} or the object itself;
// string packets are arrays [cmd, room, ...]) - the same reading as bot.handlePacket.
function FlashCmd(text) {
  try {
    let o = JSON.parse(text);
    o = o && o.params ? o.params.dataObj : o;
    return Array.isArray(o) ? String(o[0]) : (o && o.cmd) || null;
  } catch (e) { return null; }
}

// Where the published host lives: engine/bin/<platform>/ next to the app (deploy copies it), or the
// development build under <seraph>\engine.
function hostCommand() {
  const rid = process.platform === 'win32' ? 'win-x64' : `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  const exe = process.platform === 'win32' ? 'SeraphSkua.exe' : 'SeraphSkua';
  const roots = [
    process.env.SERAPH_ENGINE,
    path.join(P.APP, 'engine', rid),
    path.join(P.ROOT, 'engine', 'bin', rid),
    path.join(P.APP, '..', '..', '..', 'engine', 'bin', rid),   // the PC install (<seraph>\engine) whatever SERAPH_ROOT is
    path.join(P.ROOT, 'engine', 'host', 'bin', 'Release', 'net10.0'),
  ].filter(Boolean);
  for (const r of roots) {
    // Windows: the apphost. Linux: `dotnet SeraphSkua.dll`, which needs no execute bit after a copy from Windows.
    if (process.platform === 'win32' && fs.existsSync(path.join(r, exe))) return { cmd: path.join(r, exe), args: [], dir: r };
    if (fs.existsSync(path.join(r, 'SeraphSkua.dll'))) return { cmd: dotnet(), args: [path.join(r, 'SeraphSkua.dll')], dir: r };
  }
  return null;
}

// The .NET runtime: $DOTNET, a per-user install (~/.dotnet, where dotnet-install.sh puts it), <skua>\dotnet, or PATH.
function dotnet() {
  const exe = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
  const home = process.env.HOME || process.env.USERPROFILE || '';
  for (const c of [process.env.DOTNET, process.env.DOTNET_ROOT && path.join(process.env.DOTNET_ROOT, exe), home && path.join(home, '.dotnet', exe), process.platform === 'win32' && process.env.SKUA_HOME && path.join(process.env.SKUA_HOME, 'dotnet', 'dotnet.exe')]) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'dotnet';
}

function available() { return !!hostCommand(); }

// Call profile (2026-09-21): the laptop's 2-core E1-2100 ran at load 9, most of it answering engine calls. Count, time
// and answer size per call ("getGameObject world.questTree"), for every engine in this process; hub logs the top.
const PROFILE = new Map();
function profile(key, ms, bytes) {
  let p = PROFILE.get(key);
  if (!p) { if (PROFILE.size > 500) return; p = { n: 0, ms: 0, bytes: 0 }; PROFILE.set(key, p); }
  p.n++; p.ms += ms; p.bytes += bytes;
}
function callStats(reset = true) {
  const out = [...PROFILE.entries()].map(([call, p]) => ({ call, ...p })).sort((a, b) => b.ms - a.ms);
  if (reset) PROFILE.clear();
  return out;
}
// Packets forwarded to the engines, by command (audit 2026-09-28: count before deciding what Skua can do without).
const PACKETS = new Map();
// Longest a loadBank answer waits for the HTTP bank (holdBank). Skua's own Wait.ForBankLoad gives up after 20 s.
const BANK_HOLD_MS = 15000;
function packetStats(reset = true) {
  const out = [...PACKETS.entries()].map(([cmd, p]) => ({ cmd, ...p })).sort((a, b) => b.bytes - a.bytes);
  if (reset) PACKETS.clear();
  return out;
}
// A repeat drop can come short: {"dropItem","items":{"8940":{"ItemID":"8940","iQty":1}}} - no sName (Treasure Chest,
// Undine merge farm, 2026-10-25). Skua's drop list does Name.Trim() on every drop (ScriptDrop.CurrentDrops), so one
// nameless drop crashed the whole script (Kathool Adept, 3 crashes in 13 min, then the order was dropped). The full
// item is remembered from earlier packets (any engine, any account) or read from the model; a drop that still has no
// name is left out of what Skua sees (it cannot pick it up by name anyway).
const DROP_INFO = new Map();
function rememberItems(items) {
  for (const [id, it] of Object.entries(items || {})) {
    if (it && typeof it.sName === 'string' && it.sName) { if (DROP_INFO.size > 5000) DROP_INFO.clear(); DROP_INFO.set(Number(id), it); }
  }
}
function fillDrops(d, world) {
  const items = d && d.items;
  if (!items || typeof items !== 'object') return d;
  let changed = false;
  const out = {};
  for (const [id, it] of Object.entries(items)) {
    if (it && typeof it.sName === 'string' && it.sName) { out[id] = it; continue; }
    changed = true;
    const known = DROP_INFO.get(Number(id))
      || (world && world.invTree && world.invTree[id] && world.invTree[id].sName ? world.invTree[id] : null)
      || (world && world.bankTree && world.bankTree[id] && world.bankTree[id].sName ? world.bankTree[id] : null);
    if (known) out[id] = Object.assign({}, known, it, { ItemID: Number(id), sName: known.sName });
  }
  return changed ? Object.assign({}, d, { items: out }) : d;
}
// Pushed to the host instead of answered call by call (host Ipc.Revs / Ipc.Mirror). SERAPH_MIRROR=0 turns it off.
const MIRROR_ON = () => process.env.SERAPH_MIRROR !== '0';

// Skua keeps AdvancedSkills.json and QuestData.json in its data folder; take the library's current copies.
function seedData(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(OPTIONS_DIR(), { recursive: true });
  // No <Skua folder>/Scripts link to the library on purpose: PowerShell 5.1's Remove-Item -Recurse follows
  // junctions and would empty the real library. SKUA_SCRIPTS_DIR points the engine at it instead.
  const pairs = [
    [path.join(P.SCRIPTS, 'Skills', 'AdvancedSkills.json'), path.join(dir, 'AdvancedSkills.json')],
    [path.join(P.SCRIPTS, 'QuestData.json'), path.join(dir, 'QuestData.json')],
  ];
  for (const [from, to] of pairs) {
    try {
      const a = fs.statSync(from);
      let copy = true;
      try { const b = fs.statSync(to); copy = b.size === 0 || b.mtimeMs < a.mtimeMs; } catch (e) { copy = true; }
      if (copy) fs.copyFileSync(from, to);
    } catch (e) { /* the library is missing a file; Skua copes */ }
  }
  // CoreBots asks a brand-new Skua folder for data-collection consent (a dialog, then a Google Form post per script
  // start/stop). Seraph answers None before it can ask (the owner 2026-10-15: no information gathering at all).
  const consent = path.join(dir, 'DataCollectionSettings.txt');
  if (!fs.existsSync(consent)) fs.writeFileSync(consent, 'UserID: null\ngenericDataConsent: False\nscriptNameConsent: False\nstopTimeConsent: False\n');
  writeUserSkills(dir);
}

// Skua loads UserAdvancedSkills.json when it exists (else copies AdvancedSkills.json to it). Write it ourselves: the
// community file with lib/skill-overrides.json laid over it - class modes measured live to beat the community order
// (Class Hall dummy + Battle Analyzer, 2026-09-23). Rewritten on every seed so library updates still flow in.
function writeUserSkills(dir) {
  try {
    const ov = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'skill-overrides.json'), 'utf8'));
    const skills = JSON.parse(fs.readFileSync(path.join(dir, 'AdvancedSkills.json'), 'utf8'));
    for (const [cls, modes] of Object.entries(ov.classes || {})) skills[cls] = { ...(skills[cls] || {}), ...modes };
    fs.writeFileSync(path.join(dir, 'UserAdvancedSkills.json'), JSON.stringify(skills, null, 2));
  } catch (e) { /* no overrides or no library copy: Skua falls back to its own file */ }
}

// One options folder for every character, like one Skua install: script options and army sync files live there.
const OPTIONS_DIR = () => path.join(P.ROOT, 'skua-options');

// "Options:Name=Value" lines, the format of Skua's ScriptOptionContainer.
function writeOptions(dir, storage, values) {
  if (!storage || !values) return;
  const file = path.join(OPTIONS_DIR(), `${storage}.cfg`);
  const have = new Map();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^([^:=]+):([^=]+)=(.*)$/.exec(line.trim());
      if (m) have.set(`${m[1]}:${m[2]}`, m[3]);
    }
  } catch (e) { /* first run */ }
  for (const [k, v] of Object.entries(values)) have.set(k.includes(':') ? k : `Options:${k}`, String(v));
  fs.writeFileSync(`${file}.tmp`, [...have].map(([k, v]) => `${k}=${v}`).join('\n'));
  fs.renameSync(`${file}.tmp`, file);
}

class SkuaEngine extends EventEmitter {
  constructor(client, opts = {}) {
    super();
    this.client = client;
    this.id = client.id;
    this.opts = opts;
    this.dir = path.join(P.account(client.id), 'skua');
    this.proc = null;
    this.ready = null;
    this.pending = new Map();
    this.nextId = 1;
    this.running = false;
    this.script = null;
    this.lastError = null;
    this.logs = [];
    this.answers = opts.answers || { yesno: false };
    this.onSfs = (p, raw) => { this.forwardRaw(raw); this.forwardPacket(p); };
    this.onOut = (msg) => this.forwardOutgoing(msg);
    this.onEvent = (ev) => this.forwardFlashEvent(ev);
    // Servers.Logout / Login / Connect from a script (headless only; the desktop client has a real login screen).
    this.onSwfLogout = () => { if (!this.running) return; this.client.scriptDriven = true; this.log('state', 'script logged out'); this.client.disconnect(); };
    this.onSwfLogin = ({ user, pass }) => {
      if (!this.running) return;
      this.client.scriptDriven = true;
      this._loginJob = this.client.scriptLogin(user, pass).then(() => this.log('state', 'script logged in'))
        .catch((e) => this.log('error', `script login failed: ${e.message}`));
    };
    // skua's connectToServer waits for the login answer before connecting; so does this.
    this.onSwfConnect = ({ server, ip, port }) => {
      if (!this.running) return;
      Promise.resolve(this._loginJob).then(() => {
        const list = (this.client.login && this.client.login.servers) || [];
        const s = server || list.find((x) => x.sIP === ip && (!port || Number(x.iPort) === Number(port)));
        if (!s) { this.log('error', `script asked for an unknown server ${ip || ''}`); return null; }
        return this.client.scriptConnect(s).then(() => this.log('state', `script connected to ${s.sName}`));
      }).catch((e) => this.log('error', `script connect failed: ${e.message}`));
    };
  }

  log(kind, msg) {
    const line = { t: Date.now(), kind, msg: String(msg) };
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    this.emit('log', line);
  }

  // Start the host once; later calls reuse it.
  start() {
    if (this.ready) return this.ready;
    const host = hostCommand();
    if (!host) return Promise.reject(new Error('the Skua engine is not installed (engine/bin missing)'));
    seedData(this.dir);
    // Script fixes come from the live folder lib/scriptfix.js builds against today's library (patches re-applied after
    // every Skua update), or the shipped copies before the first build.
    const env = { ...process.env, SKUA_DIR: this.dir, SKUA_SCRIPTS_DIR: P.SCRIPTS, SKUA_OPTIONS_DIR: OPTIONS_DIR(), SERAPH_FIXES_DIR: require('../scriptfix').engineDir(), SERAPH_SEATS_FILE: path.join(P.ROOT, 'raid-seats.txt'), DOTNET_gcServer: '0', DOTNET_GCHeapHardLimit: process.env.SERAPH_ENGINE_HEAP || '0x10000000', DOTNET_TieredPGO: '0', DOTNET_EnableWriteXorExecute: process.env.SERAPH_ENGINE_WX || '0', DOTNET_GCConserveMemory: process.env.SERAPH_ENGINE_CONSERVE || '5', SERAPH_ADAPTIVE_SKILLS: this.opts.adaptiveSkills ? '1' : '0',
      // The host answers the option toggles the headless model ignores (killLag, infiniteRange...) itself.
      SERAPH_HEADLESS: this.client.headless ? '1' : '0',
      // The Flash standby: every answer costs ~45 ms of the real game's thread, so polled values are reused for 0.8 s
      // and big reads (backpack, bank, quests) for up to 5 s (host IpcFlashUtil.PollTtlMs / StableMaxMs).
      ...(this.client.flash ? { SERAPH_POLL_MS: process.env.SERAPH_FLASH_POLL_MS || '800', SERAPH_STABLE_MS: process.env.SERAPH_FLASH_STABLE_MS || '5000' } : {}) };
    // The hub answers every engine's calls on one thread, so it goes first when the cores are full: on Linux an engine
    // runs SERAPH_ENGINE_NICE (4) nice levels below it - through `nice`, so every .NET thread inherits it (setpriority
    // on a pid only moves the main thread). At 99 % CPU on 10-22 the hub's ms per call doubled and every engine waited.
    const nice = process.platform === 'linux' && process.env.SERAPH_ENGINE_NICE !== '0' && fs.existsSync('/usr/bin/nice');
    const [cmd, args] = nice ? ['/usr/bin/nice', ['-n', String(Number(process.env.SERAPH_ENGINE_NICE) || 4), host.cmd, ...host.args]] : [host.cmd, host.args];
    this.proc = spawn(cmd, args, { cwd: host.dir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // The model's revisions and polled values, sent before the first call and kept current from then on.
    this._sent = { rev: null, mirror: {} };
    this.syncState(true);
    clearInterval(this._syncTimer);
    // Timer-made changes (map load done, auto attack, socket closed) mark the model dirty; every 10th tick syncs anyway.
    this._syncTick = 0;
    this._syncTimer = setInterval(() => this.syncState(++this._syncTick % 10 === 0), 100);
    if (this._syncTimer.unref) this._syncTimer.unref();
    // The Flash standby (lib/net/flashclient.js): the polled values in one batched read every 700 ms, pushed to the host's
    // mirror like the headless model's. Each was a separate Flash call before, at ~450 ms each on the busy laptop
    // (intState, isLoggedIn, isNull world.myAvatar, strMapName... were half of all Flash calls, 2026-10-11).
    clearInterval(this._flashMirror);
    // Off by default: 23 reads in one batch still cost ~1 s of the game's thread each time (2026-10-11 measurements) -
    // more than the polling it saved. The longer poll cache (SERAPH_POLL_MS above) does the job instead.
    if (this.client.flash && typeof this.client.batchRaw === 'function' && MIRROR_ON() && process.env.SERAPH_FLASH_MIRROR === '1') {
      const keys = require('./swfworld').MIRROR;
      this._flashMirror = setInterval(async () => {
        if (this._mirroring || !this.proc) return;
        // Game reloading or crashed: no stale "logged in" for Skua - the host forgets the values (asks the game again).
        if (!this.client.state || !this.client.state.loaded) {
          const stale = keys.map(([fn, a]) => (a === undefined ? `${fn}|` : `${fn}|${a}`)).filter((k) => k in this._sent.mirror);
          if (stale.length) { for (const k of stale) delete this._sent.mirror[k]; this.send({ t: 'm', v: {}, unset: stale }); }
          return;
        }
        this._mirroring = true;
        try {
          const vals = await this.client.batchRaw(keys.map(([fn, a]) => [fn, a === undefined ? [] : [a]]));
          if (vals && this.proc) {
            let diff = null;
            keys.forEach(([fn, a], i) => { const k = a === undefined ? `${fn}|` : `${fn}|${a}`; if (!(k in this._sent.mirror) || this._sent.mirror[k] !== vals[i]) { (diff = diff || {})[k] = vals[i]; this._sent.mirror[k] = vals[i]; } });
            if (diff) this.send({ t: 'm', v: diff });
          }
        } catch (e) { /* the next tick tries again */ }
        this._mirroring = false;
      }, 700);
      if (this._flashMirror.unref) this._flashMirror.unref();
    }
    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (l) => this.onLine(l));
    this.proc.stderr.on('data', (d) => this.log('stderr', String(d).trim()));
    // Writing to an engine that just exited raises EPIPE on stdin; unhandled, that would take all of Seraph down.
    this.proc.stdin.on('error', (e) => this.log('debug', `engine pipe: ${e.code || e.message}`));
    this.proc.stdout.on('error', () => {});
    this.proc.stderr.on('error', () => {});
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the Skua engine did not start in 60 s')), 60000);
      this.once('ready', () => { clearTimeout(timer); resolve(true); });
      this.proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the Skua engine exited (${code})`)); });
      this.proc.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
    this.proc.on('exit', (code) => {
      this.log('state', `engine exited (${code})`);
      clearInterval(this._syncTimer);
      clearInterval(this._flashMirror);
      this.detach();
      this.proc = null;
      this.ready = null;
      if (this.running) { this.running = false; this.emit('stopped', { script: this.script, error: this.lastError || `engine exited (${code})` }); }
      for (const [, p] of this.pending) p.reject(new Error('engine exited'));
      this.pending.clear();
    });
    this.attach();
    return this.ready.then(() => this.command({ op: 'loaded' }));
  }

  attach() {
    const c = this.client;
    if (c.headless) {
      c.on('sfs', this.onSfs);
      c.on('out', this.onOut);
      c.on('swf-logout', this.onSwfLogout);
      c.on('swf-login', this.onSwfLogin);
      c.on('swf-connect', this.onSwfConnect);
    } else c.on('event', this.onEvent);
  }
  detach() {
    const c = this.client;
    c.removeListener('sfs', this.onSfs);
    c.removeListener('out', this.onOut);
    c.removeListener('event', this.onEvent);
    c.removeListener('swf-logout', this.onSwfLogout);
    c.removeListener('swf-login', this.onSwfLogin);
    c.removeListener('swf-connect', this.onSwfConnect);
  }

  send(o) {
    if (!this.proc || !this.proc.stdin.writable || this.proc.exitCode !== null) return;
    try { this.proc.stdin.write(JSON.stringify(o) + '\n'); } catch (e) { this.log('debug', `engine pipe: ${e.message}`); }
  }

  // Tell the host what changed in the model: the big structures' revisions ({t:'v'}) and the polled values ({t:'m'}),
  // always before the packet or answer that follows (one pipe, in order), so the host never serves a stale value.
  // Only after something could have changed (swf.dirty: a packet, an outgoing packet, a call that is not a pure read);
  // the timer forces it for what changes on its own (map load done, socket closed).
  syncState(force = false) {
    const swf = this.client.headless && this.client.swf;
    if (!swf || !this.proc || !this._sent) return;
    if (!force && swf.dirty === false) return;
    swf.dirty = false;
    const rev = JSON.stringify(swf.rev);
    if (rev !== this._sent.rev) { this._sent.rev = rev; this.send({ t: 'v', r: swf.rev }); }
    if (!MIRROR_ON()) return;
    const now = swf.mirrorSnapshot();
    let diff = null;
    for (const [k, v] of Object.entries(now)) if (this._sent.mirror[k] !== v || !(k in this._sent.mirror)) { (diff = diff || {})[k] = v; this._sent.mirror[k] = v; }
    if (diff) this.send({ t: 'm', v: diff });
  }

  command(o, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const i = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(i); reject(new Error(`engine '${o.op}' timed out`)); }, timeoutMs);
      this.pending.set(i, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.send({ t: 'cmd', i, ...o });
    });
  }

  onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch (e) { this.log('stderr', line); return; }
    switch (m.t) {
      case 'c': return this.answerCall(m);
      case 'r': {
        const p = this.pending.get(m.i);
        if (p) { this.pending.delete(m.i); p.resolve(m.v); }
        return;
      }
      case 'log':
        if (m.k === 'script') { this.log('script', m.m); this.watchQuestLoop(m.m); }
        else if (m.k === 'flash') this.log('flash', m.m);
        else if (!/^(Script compilation took|Error in timer thread: Object reference)/.test(m.m)) this.log('debug', m.m);
        return;
      case 'ask': return this.answerAsk(m);
      case 'ev': return this.onEngineEvent(m.e, m.d);
      default:
    }
  }

  // Skua's "Quest progression recovery failed, relogging" loop (since 2026-09-19; parked Sable7's 13 LoC seat on
  // 09-21). The step before it logs "Doing Quest" and gives up within seconds - KillQuest returns early when the quest
  // shows no requirements or the model says the items are already there - and the cause is still open. When it
  // starts, save the client's last 400 packets and the model's view of quests and bags, at most once per 10 min.
  watchQuestLoop(line) {
    if (!/still not unlocked after retries|Relogin Triggered: Quest progression/.test(line)) return;
    if (!this.client.dumpRecent || Date.now() - (this._loopDumpAt || 0) < 600000) return;
    this._loopDumpAt = Date.now();
    try {
      const w = this.client.swf && this.client.swf.w;
      const me = w && w.myAvatar;
      const ids = [...String(line).matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]));
      const quests = w ? Object.entries(w.questTree).filter(([id]) => !ids.length || ids.some((q) => Math.abs(q - Number(id)) <= 2)) : [];
      const header = [
        `# quest loop ${new Date().toISOString()} ${this.id}: ${line}`,
        `# room ${w && w.curRoom} map ${w && w.strMapName} cell ${w && w.strFrame}`,
        `# questTree ids: ${w ? Object.keys(w.questTree).join(',') : '-'}`,
        ...quests.map(([id, q]) => `# quest ${id} ${q.sName} status=${q.status} slot=${q.iSlot}:${q.iValue} value=${w.getQuestValue(q.iSlot)} turnin=${JSON.stringify(q.turnin || [])} oItems=${Object.values(q.oItems || {}).map((i) => `${i.ItemID}:${i.sName}:bTemp=${i.bTemp}`).join('|')}`),
        `# tempitems: ${me ? me.tempitems.map((i) => `${i.ItemID}:${i.sName}x${i.iQty}`).join(', ') : '-'}`,
      ].join('\n');
      const dir = path.join(P.account(this.id), 'logs');
      const file = this.client.dumpRecent(path.join(dir, `questloop-${new Date().toISOString().replace(/[:.]/g, '-')}.log`), header);
      this.log('state', `quest loop: packets and model saved to ${file}`);
      const old = fs.readdirSync(dir).filter((f) => f.startsWith('questloop-')).sort();
      for (const f of old.slice(0, Math.max(0, old.length - 20))) fs.unlinkSync(path.join(dir, f));
    } catch (e) { this.log('debug', `quest loop dump: ${e.message}`); }
  }

  onEngineEvent(e, d) {
    switch (e) {
      case 'ready': this.log('state', `engine ready (Skua ${d && d.version}, pid ${d && d.pid})`); this.emit('ready'); return;
      case 'started': this.running = true; this.lastError = null; this.log('state', `script started: ${path.basename(String(d || ''))}`); this.emit('started', { script: d }); return;
      case 'stopped':
        this.running = false;
        this.log('state', `script stopped${this.lastError ? `: ${this.lastError}` : ''}`);
        this.emit('stopped', { script: d, error: this.lastError });
        // A script that logged out and never came back hands the connection back to Seraph's reconnect.
        if (this.client.scriptDriven) {
          this.client.scriptDriven = false;
          if (this.client.headless && !(this.client.sock && !this.client.sock.destroyed)) this.client.emit('disconnected');
        }
        return;
      case 'error': this.lastError = d && d.message ? d.message : String(d); this.log('error', this.lastError + (d && d.stack ? `\n${String(d.stack).split('\n').slice(0, 4).join('\n')}` : '')); return;
      case 'relogin': this.log('state', `Skua asked for a re-login${d && d.kicked ? ' (kicked)' : ''}`); this.emit('relogin', d); return;
      case 'fatal': this.log('error', `engine failed to start: ${d}`); return;
      default: this.log('debug', `${e} ${JSON.stringify(d)}`);
    }
  }

  // A Flash call from Skua.
  answerCall(m) {
    const c = this.client;
    if (c.headless) {
      const t0 = process.hrtime.bigint();
      let v;
      try { v = c.swf.call(m.f, m.a || []); } catch (e) { v = { error: e.message }; }
      this.syncState();   // what this call changed reaches the host before its answer
      // Skua's quest load (Quests.Load -> world.showQuests) is answered when the quest is here, at most 8 s later
      // (VWorld.questWait), so a network stall makes Skua wait instead of re-asking and giving up (the relog loop,
      // 2026-09-22). Every call waits for its own answer in the engine (Ipc.Request, 15 s), so nothing else is held up.
      const wait = m.f === 'callGameFunction' && m.a && m.a[0] === 'world.showQuests' && c.swf.w && c.swf.w.questWait ? c.swf.w.questWait(m.a[1]) : null;
      if (wait) { wait.then(() => this.send({ t: 'r', i: m.i, v: v === undefined ? null : v })); return; }
      this.send({ t: 'r', i: m.i, v: v === undefined ? null : v });
      const a0 = m.a && typeof m.a[0] === 'string' ? ` ${m.a[0].replace(/\d+/g, '#').slice(0, 60)}` : '';
      profile(`${m.f}${a0}`, Number(process.hrtime.bigint() - t0) / 1e6, typeof v === 'string' ? v.length : 0);
      return;
    }
    c.rawCall(m.f, ...(m.a || [])).then((v) => this.send({ t: 'r', i: m.i, v: v === undefined ? null : (typeof v === 'string' ? v : JSON.stringify(v)) }))
      .catch((e) => this.send({ t: 'r', i: m.i, v: { error: e.message } }));
  }

  // A script's message box. Nobody is watching, so answer the way Seraph was told to (default: no/cancel).
  answerAsk(m) {
    const text = `${m.caption ? `${m.caption}: ` : ''}${String(m.message || '').replace(/\s+/g, ' ').slice(0, 300)}`;
    if (m.kind === 'notice') { this.log('script', `[message] ${text}`); return; }
    let v = null;
    for (const rule of this.answers.rules || []) {
      if (new RegExp(rule.match, 'i').test(`${m.caption} ${m.message}`)) { v = rule.answer; break; }
    }
    if (m.kind === 'yesno') { if (typeof v !== 'boolean') v = !!this.answers.yesno; }
    else if (m.kind === 'buttons') {
      const buttons = m.buttons || [];
      if (typeof v === 'string') v = buttons.findIndex((b) => b.toLowerCase() === v.toLowerCase());
      if (typeof v !== 'number' || v < 0) v = -1;
    }
    this.log('script', `[asked] ${text} -> ${m.kind === 'yesno' ? (v ? 'yes' : 'no') : v >= 0 ? m.buttons[v] : 'cancel'}`);
    this.send({ t: 'r', i: m.i, v });
  }

  // ---- packets to Skua, in skua.swf's shapes
  // Skua's Bank.Load sends loadBank and takes the server's answer as "the bank is loaded" (BankLoadedMessage). That
  // answer leaves out classes, armor and capes, and every login starts with an empty bank (a new world), so a script
  // checking the bank right after a relog or a server move "didn't own" what sat there and farmed it again (the owner,
  // 2026-10-09). Until the whole bank has come over HTTP (Game.getBank, api/char/bank) for this login, the answer is
  // held back and the HTTP fetch started; it goes on once the bank is in, or after 15 s / a failed fetch.
  holdBank(p) {
    if (!p || p.kind !== 'json' || !p.data || p.data.cmd !== 'loadBank' || p._bankReady) return false;
    const swf = this.client && this.client.swf;
    const game = swf && swf.game;
    const w = game && game.world;
    if (!w || !w.bankinfo || w.bankinfo.loadedAt || typeof game.getBank !== 'function') return false;
    const t0 = Date.now();
    try { if (game.getBank() !== true) return false; } catch { return false; }   // no fetch possible: pass it on as it is
    const go = () => {
      const bi = w.bankinfo;
      if (swf.game !== game || bi.loadedAt || (bi.failedAt && bi.failedAt >= t0) || Date.now() - t0 > BANK_HOLD_MS) return this.forwardPacket({ ...p, _bankReady: true });
      setTimeout(go, 200);
    };
    setTimeout(go, 200);
    return true;
  }
  forwardPacket(p) {
    if (!this.proc) return;
    if (this.holdBank(p)) return;
    let dataObj;
    if (p.kind === 'json') {
      dataObj = p.data;
      if (dataObj && (dataObj.cmd === 'dropItem' || dataObj.cmd === 'addItems' || dataObj.cmd === 'monsterDrops')) rememberItems(dataObj.items);
      if (dataObj && dataObj.cmd === 'dropItem') {
        const sw = this.client && this.client.swf;
        dataObj = fillDrops(dataObj, sw && sw.game && sw.game.world);
        if (!Object.keys(dataObj.items || {}).length) return;   // nothing Skua could name: leave it out
      }
    } else if (p.kind === 'xt') dataObj = [p.cmd, String(p.room), ...(p.args || [])];
    else return;
    const packet = { type: 'onExtensionResponse', params: { type: p.kind === 'json' ? 'json' : 'str', dataObj } };
    this.syncState();   // the model has already applied this packet
    const text = JSON.stringify(packet);
    const st = PACKETS.get(p.cmd) || (PACKETS.size < 300 ? PACKETS.set(p.cmd, { n: 0, bytes: 0 }).get(p.cmd) : null);
    if (st) { st.n++; st.bytes += text.length; }
    // k:'c' = combat only: the host keeps its cached backpack/bank/quest answers (IpcFlashUtil stable reads).
    this.send(COMBAT_PACKETS.has(p.cmd) ? { t: 'f', f: 'pext', a: [text], k: 'c' } : { t: 'f', f: 'pext', a: [text] });
  }
  // skua.swf turns packet capture on at load (Main.as catchPackets) and hands EVERY received packet to Skua twice:
  // "packetFromServer" with the raw text (SmartFox's debug line, sent first) and "pext" as the parsed object. Seraph
  // sent only "pext", so the scripts that read boss lines from "packetFromServer" heard nothing: Ultra Speaker's "All
  // stand equal" handler (Equalize zone + Decay) never ran - no zone visit in 2 tries, boss stuck at ~9.95 M HP
  // (2026-10-23) - and the same for Kathool, the Entwined Eclipse bosses and the Four Harbingers (15 library scripts).
  // Tagged combat (k:'c') so it never moves the host's cache generation twice for one packet.
  forwardRaw(raw) {
    if (!this.proc || typeof raw !== 'string' || !raw) return;
    this.syncState();
    this.send({ t: 'f', f: 'packetFromServer', a: [raw], k: 'c' });
  }

  forwardOutgoing(msg) {
    if (this.proc) this.syncState();   // an outgoing packet can change the model too (acceptQuest)
    if (!this.proc || !this.client.swf || !this.client.swf.catching) return;
    const s = String(msg);
    if (s.startsWith('%xt%zm%')) this.send({ t: 'f', f: 'packet', a: [s] });
  }
  forwardFlashEvent(ev) {
    if (!this.proc) return;
    if (ev.kind === 'pext') {
      const text = typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data);
      // Combat packets leave the host's big-read cache alone, as on the headless client: untagged, every hit of a fight
      // threw the backpack away and Skua read its 40 KB again through Flash (2026-10-11).
      this.send(COMBAT_PACKETS.has(FlashCmd(text)) ? { t: 'f', f: 'pext', a: [text], k: 'c' } : { t: 'f', f: 'pext', a: [text] });
    } else if (ev.kind === 'packetOut') this.send({ t: 'f', f: 'packet', a: [String(ev.data)] });
    else if (ev.kind === 'packetFromServer') this.forwardRaw(String(ev.data));
  }

  // Resident memory of the engine process in MB (Linux /proc; null elsewhere).
  rssMb() {
    if (!this.proc || process.platform !== 'linux') return null;
    try {
      const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${this.proc.pid}/status`, 'utf8'));
      return m ? Math.round(Number(m[1]) / 1024) : null;
    } catch (e) { return null; }
  }

  // .NET never unloads a compiled script, so an engine grows with every script it starts: 511 MB after 2 h on the
  // laptop (2026-09-21), when reconnects restarted each script every few minutes, and the service hit MemoryHigh.
  // Between scripts, an engine that has run at least two and is over the limit is replaced by a fresh one (a few
  // seconds; compiled scripts come from Skua's cache).
  async recycleIfBig(limitMb = Number(process.env.SERAPH_ENGINE_RECYCLE_MB || 330)) {
    if (this.running || !this.proc || (this.runs || 0) < 2) return false;
    const mb = this.rssMb();
    if (mb === null || mb < limitMb) return false;
    this.log('state', `engine uses ${mb} MB after ${this.runs} scripts - starting a fresh one`);
    const p = this.proc;
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } resolve(); }, 8000);
      p.once('exit', () => { clearTimeout(t); resolve(); });
      this.send({ t: 'cmd', op: 'exit' });
    });
    this.runs = 0;
    return true;
  }

  // ---- public
  async run(scriptPath, opt = {}) {
    await this.recycleIfBig().catch((e) => this.log('debug', `recycle: ${e.message}`));
    await this.start();
    this.runs = (this.runs || 0) + 1;
    const full = path.isAbsolute(scriptPath) ? scriptPath : path.join(P.SCRIPTS, scriptPath);
    if (opt.options) writeOptions(this.dir, opt.storage || path.basename(full, '.cs'), opt.options);
    if (opt.answers) this.answers = opt.answers;
    this.script = full;
    this.lastError = null;
    const r = await this.command({ op: 'start', path: full }, 180000);
    if (r && r.error) throw new Error(r.error);
    return r;
  }

  async stop() {
    if (!this.proc) return { ok: true };
    return this.command({ op: 'stop' }, 45000).catch((e) => ({ error: e.message }));
  }

  async compile(scriptPath) {
    await this.start();
    const full = path.isAbsolute(scriptPath) ? scriptPath : path.join(P.SCRIPTS, scriptPath);
    return this.command({ op: 'compile', path: full }, 180000);
  }

  async status() {
    if (!this.proc) return { running: false, engine: false };
    const s = await this.command({ op: 'status' }, 10000).catch((e) => ({ error: e.message }));
    return { engine: true, ...s };
  }

  async setOption(name, value) { await this.start(); return this.command({ op: 'option', name, value }); }

  // Wait for the running script to end (or the budget to run out, which stops it).
  waitDone(budgetMs, shouldStop = () => false) {
    return new Promise((resolve) => {
      if (!this.running) { resolve({ error: this.lastError }); return; }
      const t0 = Date.now();
      const tick = setInterval(() => {
        if (Date.now() - t0 > budgetMs || shouldStop()) { clearInterval(tick); this.removeListener('stopped', done); this.stop().then(() => resolve({ timedOut: Date.now() - t0 > budgetMs, error: this.lastError })); }
      }, 1000);
      const done = (d) => { clearInterval(tick); resolve({ error: d && d.error }); };
      this.once('stopped', done);
    });
  }

  dispose() {
    clearInterval(this._syncTimer);
    this.detach();
    if (this.proc) {
      try { this.send({ t: 'cmd', op: 'exit' }); } catch (e) { /* gone */ }
      const p = this.proc;
      setTimeout(() => { try { p.kill(); } catch (e) { /* gone */ } }, 5000);
    }
  }
}

module.exports = { SkuaEngine, available, hostCommand, writeOptions, optionsDir: OPTIONS_DIR, callStats, packetStats, writeUserSkills, fillDrops, rememberItems };
