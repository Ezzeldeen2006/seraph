// A character in the real AQW game on the Linux laptop's Flash standby (lib/flashhost.js). Same surface as the desktop
// GameClient (lib/client.js) - bridge calls, events, login through the game screen - so the bot, Skua's engine and the
// combat code treat it exactly like the Windows Flash client. Nothing here imitates the game: when Artix changes the
// game, this keeps working, which is the whole point (the owner, 2026-10-11).
'use strict';
const { GameClient } = require('../client');

class FlashClient extends GameClient {
  constructor(account, host, opts = {}) {
    super(account, null);
    this.host = host;
    this.headless = false;
    this.flash = true;
    this.fps = Number(opts.fps) || 4;   // a bot needs no animation: 4 fps keeps the CPU for four characters
    this.onEv = (kind, data) => this.onIpc(kind, data);
    this.onCrash = (what) => { this.state.crashes++; this.state.loaded = false; this.state.bridge = false; this.record('crash', what); this.emit('crash', what); };
  }

  start() {
    this.host.on(`ev:${this.id}`, this.onEv);
    this.host.on(`crash:${this.id}`, this.onCrash);
    this.wantFps(this.fps);
    this.timers.push(setInterval(() => this.watch(), 10000));
    this.record('state', 'flash: opening the real game');
    return this.host.openGame(this.id);
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.host.removeListener(`ev:${this.id}`, this.onEv);
    this.host.removeListener(`crash:${this.id}`, this.onCrash);
    this.host.closeGame(this.id);
    this.state.loaded = false;
  }

  // Called after a disconnect by the hub's code paths written for the headless client; the game screen handles itself.
  reset() {}

  async call(fn, ...args) {
    const r = await this.host.call(this.id, fn, args);
    if (!r || !r.ok) throw new Error(r ? r.error : 'bridge call failed');
    return this.parse(r.value);
  }

  async rawCall(fn, ...args) {
    const r = await this.host.call(this.id, fn, args);
    if (!r || !r.ok) throw new Error(r ? r.error : 'bridge call failed');
    return r.value === undefined ? null : r.value;
  }

  // Every 10 s, in one round trip: frame rate, cutscenes, and Skua's lag options (Kill Lag = no map drawing, Hide
  // Players, Disable FX). Each Flash call costs ~60 ms of the laptop's one shared game thread when it is busy, and this
  // watch was 17% of all calls at every 2 s (2026-10-11). `lean` false keeps the picture (dashboard live view).
  async watch() {
    if (this.watching || !this.state.loaded) return;
    this.watching = true;
    try {
      const [cut, map, noWorld] = (await this.host.batch(this.id, [['getGameObject', ['mcExtSWF.numChildren']], ['getGameObject', ['world.strMapName']], ['isNull', ['world']]])) || [];
      const val = (r) => (r && r.ok ? this.parse(r.value) : null);
      if (this.fpsWanted && this.fpsSet !== this.fpsWanted) { await this.call('setGameObject', 'stage.frameRate', this.fpsWanted); this.fpsSet = this.fpsWanted; }
      if (Number(val(cut)) > 0) { await this.call('skipCutscenes'); this.record('state', 'skipped a cutscene'); }
      const lean = this.lean !== false;
      const m = val(map);
      if (m && m !== this._leanMap) { this._leanMap = m; this._leanSet = null; }   // Hide Players / FX: again on a new map
      if (this._leanSet !== lean && val(noWorld) !== true) {
        await this.host.batch(this.id, ['killLag', 'hidePlayers', 'disableFX'].map((fn) => [fn, [lean]]));
        this._leanSet = lean;
        this.record('state', `flash: lag options ${lean ? 'on' : 'off'}`);
      }
    } catch (e) { /* not in game yet */ }
    this.watching = false;
  }

  // Raw answers of several bridge calls at once (Skua's engine mirror, lib/skua/engine.js): strings as Skua's
  // ExternalInterface would hand them over, null for a failed call.
  async batchRaw(calls) {
    const r = await this.host.batch(this.id, calls);
    if (!r) return null;
    return r.map((x) => (x && x.ok ? (x.value === undefined || x.value === null ? null : (typeof x.value === 'string' ? x.value : JSON.stringify(x.value))) : null));
  }

  onIpc(kind, data) {
    if (kind === 'state' && data === 'loaded') this._leanSet = null;   // a new game screen: apply the options again
    super.onIpc(kind, data);
  }

  async screenshot(file) {
    const r = await this.host.shot(this.id, file);
    return r && r.ok ? file : null;
  }
}

module.exports = { FlashClient };
