// One game client per account: an isolated Electron session (own cookies + Flash state), the Skua AS3 bridge page,
// bridge calls, an event log and the watchers that keep the screen usable (cutscenes, hidden world).
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { P } = require('./paths');

class GameClient extends EventEmitter {
  constructor(account, electron) {
    super();
    this.account = account;
    this.id = account.id;
    this.electron = electron;
    this.view = null;
    this.events = [];
    this.seq = 0;
    this.state = { page: false, bridge: false, loaded: false, started: Date.now(), crashes: 0 };
    this.dir = P.account(account.id);
    fs.mkdirSync(path.join(this.dir, 'logs'), { recursive: true });
    this.logFile = null;
    this.timers = [];
    this.setMaxListeners(50);
  }

  partition() { return `persist:acct-${this.id}`; }

  // Flash local trust inside this account's partition, so skua.swf may load game.aq.com.
  writeTrust() {
    const bases = [
      path.join(P.PROFILE, 'Partitions', `acct-${this.id}`),
      P.PROFILE,
    ];
    for (const base of bases) {
      const d = path.join(base, 'Pepper Data', 'Shockwave Flash', 'WritableRoot', '#Security', 'FlashPlayerTrust');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'seraph.cfg'), P.APP + '\r\n');
    }
  }

  start() {
    const { BrowserView } = this.electron;
    this.writeTrust();
    this.view = new BrowserView({
      webPreferences: {
        plugins: true, nodeIntegration: true, contextIsolation: false, backgroundThrottling: false,
        partition: this.partition(),
      },
    });
    this.view.setBackgroundColor && this.view.setBackgroundColor('#000000');
    const wc = this.view.webContents;
    wc.on('render-process-gone', (_e, d) => this.crash(`renderer ${JSON.stringify(d)}`));
    wc.on('crashed', () => this.crash('renderer crashed'));
    wc.on('plugin-crashed', (_e, name) => this.crash(`plugin ${name}`));
    wc.loadFile(path.join(P.APP, 'game.html'), { query: { account: this.id } });
    this.timers.push(setInterval(() => this.watch(), 1000));
  }

  crash(what) {
    this.state.crashes++;
    this.state.loaded = false;
    this.record('crash', what);
    this.emit('crash', what);
    // Reload the page after a crash; the bot's login loop takes over once the bridge is back.
    setTimeout(() => { try { this.view.webContents.reload(); } catch { /* view gone */ } }, 5000);
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.view) { try { this.view.destroy ? this.view.destroy() : this.view.webContents.destroy(); } catch { /* already gone */ } }
    this.view = null;
  }

  onIpc(kind, data) {
    if (kind === 'state') {
      if (data === 'page') this.state.page = true;
      if (data === 'bridge-ready') this.state.bridge = true;
      if (data === 'loaded') { this.state.loaded = true; this.fpsSet = null; this.emit('loaded'); }
    }
    this.record(kind, data);
  }

  record(kind, data) {
    const ev = { n: ++this.seq, t: Date.now(), kind, data };
    this.events.push(ev);
    if (this.events.length > 3000) this.events.splice(0, this.events.length - 3000);
    let text = typeof data === 'string' ? data : JSON.stringify(data);
    if (kind === 'pext' || kind === 'packet') text = text.slice(0, 300);
    const day = new Date().toISOString().slice(0, 10);
    if (!this.logFile || this.logDay !== day) {
      if (this.logFile) this.logFile.end();
      this.logDay = day;
      this.logFile = fs.createWriteStream(path.join(this.dir, 'logs', `session-${day}.log`), { flags: 'a' });
    }
    this.logFile.write(`${new Date(ev.t).toISOString()} ${kind} ${text}\n`);
    this.emit('event', ev);
  }

  parse(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return v; }
  }

  async call(fn, ...args) {
    if (!this.view) throw new Error('no game view');
    const r = await this.view.webContents.executeJavaScript(`window.__call(${JSON.stringify(fn)}, ${JSON.stringify(args)})`);
    if (!r || !r.ok) throw new Error(r ? r.error : 'bridge call failed');
    return this.parse(r.value);
  }
  // The bridge's answer exactly as skua.swf returned it (a string), for Skua's engine (lib/skua/engine.js).
  async rawCall(fn, ...args) {
    if (!this.view) throw new Error('no game view');
    const r = await this.view.webContents.executeJavaScript(`window.__call(${JSON.stringify(fn)}, ${JSON.stringify(args)})`);
    if (!r || !r.ok) throw new Error(r ? r.error : 'bridge call failed');
    return r.value === undefined ? null : r.value;
  }
  get(p) { return this.call('getGameObject', p); }
  fn(p, ...a) { return this.call('callGameFunction', p, ...a); }
  send(packet) { return this.call('callGameFunction', 'sfc.sendString', packet); }

  // Every second: skip cutscenes and make sure the world is visible.
  // The game hides `world` while a cutscene plays; skipping one early left the map black (bug 2026-09-17).
  // Flash frame rate by what's on screen (Skua's FPS option): full speed only for the character the owner watches. Four games
  // animating at 24 fps through the CPU compositor at once starved the Live page until nothing painted.
  wantFps(n) { if (this.fpsWanted !== n) { this.fpsWanted = n; this.fpsSet = null; } }

  async watch() {
    if (this.watching || !this.state.loaded) return;
    this.watching = true;
    try {
      if (this.fpsWanted && this.fpsSet !== this.fpsWanted) {
        await this.call('setGameObject', 'stage.frameRate', this.fpsWanted);
        this.fpsSet = this.fpsWanted;
      }
      const n = await this.get('mcExtSWF.numChildren');
      if (typeof n === 'number' && n > 0) {
        await this.call('skipCutscenes');
        this.record('state', 'skipped a cutscene');
      }
      if ((await this.call('isNull', 'world')) !== true) {
        const visible = await this.get('world.visible');
        if (visible === false) {
          await this.call('setGameObject', 'world.visible', true);
          this.record('state', 'world was hidden - made visible');
        }
      }
    } catch { /* not in game yet */ }
    this.watching = false;
  }

  async screenshot(file) {
    if (!this.view) return null;
    const img = await this.view.webContents.capturePage();
    if (img.isEmpty()) return null;   // nothing rendered (window minimized / view hidden)
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, img.toPNG());
    return file;
  }
}

module.exports = { GameClient };
