// The real-Flash standby on the Linux laptop (2026-10-11, the owner: "develop the flash player there and keep it on standby
// if the bots failed to login"). One virtual screen (Xvfb) and one Flash host process (flashhost/main.js on the Artix
// Games Launcher's Linux Electron + PepperFlash, ~/seraph/flash/rt) for every character in Flash mode, started on first
// use and stopped when no character needs it. lib/net/flashclient.js is the client a character uses through it.
// Measured on the laptop (login screen, 3 games in one page, helpers folded in): 548 MB in all.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const { spawn } = require('child_process');
const readline = require('readline');

const HOME = os.homedir();
const RT = process.env.SERAPH_FLASH_RT || path.join(HOME, 'seraph', 'flash', 'rt');
const DISPLAY = process.env.SERAPH_FLASH_DISPLAY || ':99';
const CALL_MS = 15000;
const IDLE_STOP_MS = 5 * 60000;   // no character in Flash mode this long: free the memory

class FlashHost extends EventEmitter {
  constructor(log = () => {}, opts = {}) {
    super();
    this.log = log;
    this.opts = opts;
    this.proc = null;
    this.xvfb = null;
    this.ready = null;
    this.pending = new Map();
    this.seq = 0;
    this.open = new Set();
    this.started = 0;
    this.restarts = 0;
    this.setMaxListeners(50);
  }

  static installed() {
    return fs.existsSync(path.join(RT, 'artixgamelauncher')) && fs.existsSync(path.join(RT, 'resources', 'plugins', 'libpepflashplayer.so'))
      && fs.existsSync(path.join(RT, 'resources', 'app', 'main.js'));
  }

  running() { return !!(this.proc && this.proc.exitCode === null); }

  start() {
    if (this.ready) return this.ready;
    if (!FlashHost.installed()) return Promise.reject(new Error(`the Flash runtime is not installed (${RT})`));
    clearTimeout(this._idle);
    this.ready = new Promise((resolve, reject) => {
      // A display of its own, small and 16-bit (nothing watches it; the dashboard takes screenshots).
      if (!this.xvfb || this.xvfb.exitCode !== null) {
        this.xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '960x900x16', '-nolisten', 'tcp', '-noreset'], { stdio: 'ignore' });
        this.xvfb.on('exit', (c) => { this.log(`flash: the virtual screen stopped (${c})`); this.xvfb = null; });
      }
      setTimeout(() => {
        // separate: one Flash process (and page) per character, so the laptop's two cores run two games at once; shared:
        // one Flash process for all (less memory, but every game and bridge call waits on its single thread - calls
        // took ~1 s with three games in game, 2026-10-11).
        const sep = this.opts && typeof this.opts.separate === 'function' ? this.opts.separate() : false;
        const env = { ...process.env, DISPLAY, FLASH_PROFILE: path.join(HOME, 'seraph', 'flash', 'profile'), FLASH_PLUGIN: path.join(RT, 'resources', 'plugins', 'libpepflashplayer.so'), FLASH_SHARED: sep ? '0' : '1',
          ...(this.opts && typeof this.opts.render === 'function' ? this.opts.render() : {}) };
        this.separate = sep;
        this.launched = this.opts && typeof this.opts.describe === 'function' ? this.opts.describe() : { separate: sep };
        delete env.ELECTRON_RUN_AS_NODE;
        this.proc = spawn(path.join(RT, 'artixgamelauncher'), ['--no-sandbox'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        this.started = Date.now();
        let err = '';
        this.proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
        const fail = setTimeout(() => reject(new Error('the Flash host did not start in 60 s')), 60000);
        readline.createInterface({ input: this.proc.stdout }).on('line', (l) => {
          let m;
          try { m = JSON.parse(l); } catch (e) { return; }
          if (m.t === 'ready') { clearTimeout(fail); this.log(`flash: host up (${m.size}, shared ${m.shared})`); resolve(true); for (const id of this.open) this.write({ t: 'open', id }); }
          else if (m.t === 'r') { const p = this.pending.get(m.i); if (p) { this.pending.delete(m.i); clearTimeout(p.timer); p.resolve(m); } }
          else if (m.t === 'ev') this.emit(`ev:${m.id}`, m.kind, m.data);
          else if (m.t === 'crash') this.emit(`crash:${m.id}`, m.what);
          else if (m.t === 'log') this.log(`flash: ${m.text}`);
        });
        this.proc.on('exit', (code, sig) => {
          clearTimeout(fail);
          this.log(`flash: host exited (${code === null ? sig : code})${err ? ` - ${err.split('\n').filter((x) => x && !/allowRendererProcessReuse/.test(x)).slice(-2).join(' | ')}` : ''}`);
          this.proc = null;
          this.ready = null;
          for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'the Flash host exited' }); }
          this.pending.clear();
          for (const id of this.open) this.emit(`crash:${id}`, 'the Flash host exited');
          // Characters still in Flash mode: bring it back (at most once a minute).
          if (this.open.size && !this._stopping) {
            this.restarts++;
            setTimeout(() => { if (this.open.size && !this.proc) this.start().catch((e) => this.log(`flash: ${e.message}`)); }, Math.min(60000, 5000 * this.restarts));
          }
          reject(new Error('the Flash host exited'));
        });
      }, this.xvfb ? 1500 : 0);
    });
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }

  write(o) { if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(o) + '\n'); }

  async request(o, ms = CALL_MS) {
    await this.start();
    const i = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(i); resolve({ ok: false, error: `no answer from the Flash host in ${ms / 1000} s` }); }, ms);
      this.pending.set(i, { resolve, timer });
      this.write({ ...o, i });
    });
  }

  async openGame(id) {
    this.open.add(id);
    clearTimeout(this._idle);
    await this.start();
    this.write({ t: 'open', id });
  }

  closeGame(id) {
    this.open.delete(id);
    this.write({ t: 'close', id });
    if (!this.open.size) {
      clearTimeout(this._idle);
      this._idle = setTimeout(() => { if (!this.open.size) this.stop(); }, IDLE_STOP_MS);
    }
  }

  // Every bridge call runs ActionScript inside Flash (ExternalInterface is slow): counted per call for the 10-min line.
  async call(id, fn, args) {
    const key = `${fn}${args && typeof args[0] === 'string' ? ` ${args[0].replace(/\d+/g, '#').slice(0, 50)}` : ''}`;
    const t0 = Date.now();
    const r = await this.request({ t: 'call', id, fn, args });
    const st = (this.calls = this.calls || new Map()).get(key) || { n: 0, ms: 0, host: 0 };
    st.n++; st.ms += Date.now() - t0; st.host += Number(r && r.ms) || 0;
    this.calls.set(key, st);
    return r;
  }
  // Several bridge calls in one round trip: [[fn, args], ...] -> [{ok, value}|null, ...].
  async batch(id, calls) {
    const t0 = Date.now();
    const r = await this.request({ t: 'batch', id, calls });
    const st = (this.calls = this.calls || new Map()).get(`batch (${calls.length})`) || { n: 0, ms: 0, host: 0 };
    st.n++; st.ms += Date.now() - t0; st.host += Number(r && r.ms) || 0;
    this.calls.set(`batch (${calls.length})`, st);
    return r && r.ok && Array.isArray(r.value) ? r.value : null;
  }
  callStats(reset = false) {
    const out = [...(this.calls || new Map()).entries()].map(([call, v]) => ({ call, ...v })).sort((a, b) => b.n - a.n);
    if (reset) this.calls = new Map();
    return out;
  }
  shot(id, file) { return this.request({ t: 'shot', id, file }, 30000); }
  metrics() { return this.running() ? this.request({ t: 'metrics' }, 10000) : Promise.resolve({ ok: true, value: { windows: [], procs: [], totalMb: 0 } }); }

  stop() {
    this._stopping = true;
    this.write({ t: 'quit' });
    const p = this.proc;
    setTimeout(() => { try { if (p && p.exitCode === null) p.kill('SIGKILL'); } catch (e) { /* gone */ } try { if (this.xvfb) this.xvfb.kill(); } catch (e) { /* gone */ } this._stopping = false; }, 5000);
    this.log('flash: host stopped (no character in Flash mode)');
  }

  // A new process layout: stop the host; the games come back on their own (open set, restart on exit).
  restart() {
    if (!this.proc) return;
    this.log('flash: restarting the host for the new process layout');
    this.write({ t: 'quit' });
    const p = this.proc;
    setTimeout(() => { try { if (p && p.exitCode === null) p.kill('SIGKILL'); } catch (e) { /* gone */ } }, 5000);
  }

  status() {
    return { installed: FlashHost.installed(), running: this.running(), games: [...this.open], since: this.started ? new Date(this.started).toISOString() : null, restarts: this.restarts, separate: !!this.separate, launched: this.launched || null };
  }
}

module.exports = { FlashHost, RT };
