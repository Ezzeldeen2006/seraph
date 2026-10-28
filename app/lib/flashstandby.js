// Flash standby (the owner, 2026-10-11): "keep it on standby if the bots failed to login or do anything for a period of
// reasonable time make the flash player kick in and make a dashboard for it for me to manage how many account and which
// accounts should run on it". The headless client copies the game and breaks when Artix changes it (AQW 5.0 kept every
// login out for 15 h on 2026-10-10); the real game in Flash (lib/flashhost.js) does not. The laptop fits about three
// games next to the engines, so up to `maxGames` characters, in the owner's order, move to Flash when headless fails, and
// back when headless works again.
//
// Per character (cfg.modes): 'auto' (default: Flash only while headless is broken), 'flash' (always), 'headless' (never).
// Kicks in when every headless party character has been unable to log in for loginFailMin, or has gained nothing for
// stallMin while in game - and the AQW server list still answers (a dead Wi-Fi is not a broken client).
// Goes back when a headless character is in game and gaining again, or, with everyone in Flash, after a trial login.
'use strict';
const fs = require('fs');
const path = require('path');
const { P } = require('./paths');

const DEFAULTS = {
  enabled: true, auto: true, maxGames: 3,
  order: ['sable7', 'valen7', 'nova7', 'oren7'],
  modes: {},
  loginFailMin: 20, stallMin: 90, retryHeadlessMin: 60, trialMin: 10, fps: 4,
  separate: true,   // one Flash process per character (see lib/flashhost.js)
  hidden: false,    // windows never painted (saves CPU; the dashboard's live view goes blank)
  size: 'small',    // game window: tiny 240x138, small 480x275, normal 960x550
};
const STATE = () => path.join(P.ROOT, 'flash-standby.json');

class FlashStandby {
  constructor(hub, { now = Date.now } = {}) {
    this.hub = hub;
    this.now = now;
    this.gains = {};
    let s = {};
    try { s = JSON.parse(fs.readFileSync(STATE(), 'utf8')); } catch (e) { /* first run */ }
    this.active = new Set(s.active || []);          // characters in Flash mode right now
    this.autoOn = s.autoOn || null;                  // { at, reason } while the automatic standby is on
    this.trial = s.trial || null;                    // { id, at } a headless trial login with everyone in Flash
    this.lastTry = s.lastTry || 0;
    this.history = s.history || [];
  }

  cfg() {
    const c = { ...DEFAULTS, ...((this.hub.settings && this.hub.settings.flash) || {}) };
    c.modes = { ...DEFAULTS.modes, ...(c.modes || {}) };
    c.maxGames = Math.max(0, Math.min(4, Number(c.maxGames) || 0));
    return c;
  }
  setCfg(patch) {
    const cur = (this.hub.settings.flash = { ...((this.hub.settings && this.hub.settings.flash) || {}) });
    for (const k of Object.keys(DEFAULTS)) if (patch[k] !== undefined) cur[k] = patch[k];
    if (patch.modes) cur.modes = { ...(cur.modes || {}), ...patch.modes };
    if (this.hub.saveSettings) this.hub.saveSettings();
    // A new process layout or window setting takes a host restart (the games come back by themselves).
    const relaunch = ['separate', 'hidden', 'size'].some((k) => patch[k] !== undefined && this.hub.flash && this.hub.flash.running() && String((this.hub.flash.launched || {})[k]) !== String(patch[k]));
    if (relaunch) this.hub.flash.restart();
    return this.cfg();
  }
  save() {
    try { fs.writeFileSync(STATE(), JSON.stringify({ active: [...this.active], autoOn: this.autoOn, trial: this.trial, lastTry: this.lastTry, history: this.history.slice(-50) }, null, 1)); } catch (e) { /* disk hiccup */ }
  }
  note(text) {
    this.history.push({ at: new Date(this.now()).toISOString(), text });
    if (this.hub.info) this.hub.info(`flash standby: ${text}`);
    this.save();
  }

  // Which client a character opens with (hub.open).
  modeOf(id) { return this.cfg().enabled && this.active.has(id) ? 'flash' : 'headless'; }

  partyIds() {
    return [...this.hub.bots.values()].map((b) => b.account || {})
      .filter((a) => a.kind !== 'guest' && a.status !== 'pending' && a.wantOnline !== false).map((a) => a.id);
  }

  async switchTo(id, mode, why) {
    const bot = this.hub.bot(id);
    if (!bot) return false;
    const inFlash = this.active.has(id);
    if ((mode === 'flash') === inFlash) return false;
    const acc = bot.account;
    if (mode === 'flash') this.active.add(id); else this.active.delete(id);
    this.save();
    this.note(`${acc.label || id} -> ${mode === 'flash' ? 'Flash (the real game)' : 'headless'}: ${why}`);
    this.hub.close(id);
    this.hub.open(acc);
    return true;
  }

  // Characters that should be in Flash now, by the settings alone (manual 'flash', or auto while the standby is on).
  wanted(c = this.cfg()) {
    const ids = this.partyIds().concat([...this.hub.bots.keys()].filter((id) => c.modes[id] === 'flash'));
    const order = [...new Set([...c.order.filter((id) => ids.includes(id)), ...ids])];
    const forced = order.filter((id) => c.modes[id] === 'flash');
    const auto = this.autoOn ? order.filter((id) => (c.modes[id] || 'auto') === 'auto') : [];
    return [...new Set([...forced, ...auto])].slice(0, c.maxGames);
  }

  // Is the headless client broken? A reason, or null.
  async headlessBroken(c = this.cfg()) {
    const now = this.now();
    const ids = this.partyIds().filter((id) => !this.active.has(id) && c.modes[id] !== 'flash');
    if (!ids.length) return null;
    const clients = ids.map((id) => this.hub.clients.get(id)).filter(Boolean);
    if (clients.length !== ids.length) return null;
    // 1. Nobody can log in.
    const failing = clients.filter((cl) => cl._offlineSince && now - cl._offlineSince >= c.loginFailMin * 60000 && !/full/i.test(String(cl._lastLoginError || '')));
    if (failing.length === clients.length) {
      if (!(await this.serverListAnswers())) return null;   // the network, not the client
      const min = Math.round(Math.min(...failing.map((cl) => now - cl._offlineSince)) / 60000);
      return `none of the headless characters could log in for ${min} min (${String(failing[0]._lastLoginError || 'no error recorded').slice(0, 120)})`;
    }
    // 2. Everyone in game, nobody gaining anything (samples: sample(), every tick).
    let quiet = 0;
    for (const id of ids) {
      const p = this.gains[id] || [];
      if (p.length && now - p[0].t >= c.stallMin * 60000 && p.every((x) => x.sum === p[p.length - 1].sum)) quiet++;
    }
    if (quiet && quiet === ids.length) return `none of the headless characters gained anything for ${c.stallMin} min while in game`;
    return null;
  }

  async serverListAnswers() {
    try { const l = await require('./net/protocol').servers(10000); return Array.isArray(l) && l.length > 0; } catch (e) { return false; }
  }

  // Headless works again: a headless character in game and gaining in the last half hour.
  headlessWorks() {
    const now = this.now();
    for (const id of this.partyIds()) {
      if (this.active.has(id)) continue;
      const cl = this.hub.clients.get(id);
      const bot = this.hub.bot(id);
      if (!cl || !cl.headless || !cl.state || !cl.state.loaded || !bot) continue;
      const p = this.gains[id] || [];
      const recent = p.filter((x) => now - x.t <= 30 * 60000);
      if (recent.length >= 2 && recent[recent.length - 1].sum > recent[0].sum) return true;
      if (cl._loadedAt && now - cl._loadedAt > 5 * 60000 && bot.running) return true;
    }
    return false;
  }

  // What each headless character has gained (XP + kills + quests + drops + items), kept for stallMin + 20 min. A character
  // out of game or stopped has no samples (it is not "in game and gaining nothing").
  sample(c = this.cfg(), now = this.now()) {
    for (const id of this.partyIds()) {
      const bot = this.hub.bot(id);
      const cl = this.hub.clients.get(id);
      const g = bot && bot.progressMark ? bot.progressMark() : null;
      // A raid or a help call fights long stretches with nothing to show: not a broken client. On 2026-10-16 the standby
      // fired 2 h into a Drakath raid, moved three members to Flash and back, and their restarted scripts broke the raid.
      const fighting = bot && bot.current && (bot.current.raid || bot.current.type === 'assist');
      if (this.active.has(id) || !g || !bot.running || fighting || !(cl && cl.state && cl.state.loaded)) { delete this.gains[id]; continue; }
      const p = (this.gains[id] = (this.gains[id] || []).filter((x) => now - x.t <= (c.stallMin + 20) * 60000));
      p.push({ t: now, sum: g.xp + g.kills + g.quests + g.drops + g.items });
    }
  }

  async tick() {
    const c = this.cfg();
    const now = this.now();
    this.sample(c, now);
    if (!c.enabled) {
      for (const id of [...this.active]) await this.switchTo(id, 'headless', 'the Flash standby was switched off');
      this.autoOn = null; this.trial = null; this.save();
      return;
    }
    if (this.hub.flash && !this.hub.flash.constructor.installed()) return;
    // A new game speed from the dashboard reaches the games already open.
    for (const cl of this.hub.clients.values()) if (cl && cl.flash && typeof cl.wantFps === 'function' && cl.fpsWanted !== c.fps) cl.wantFps(c.fps);
    // The automatic part.
    if (c.auto && !this.autoOn) {
      const why = await this.headlessBroken(c);
      if (why) {
        this.autoOn = { at: new Date(now).toISOString(), reason: why };
        this.lastTry = now;
        this.note(`standby ON - ${why}`);
        if (this.hub.notify) this.hub.notify('Flash standby is on', `${why}. Up to ${c.maxGames} characters move to the real AQW game (${this.wanted(c).join(', ')}).`, 'alert');
        if (this.hub.discord && this.hub.discord.enabled) this.hub.discord.send(`⚠️ **Flash standby is on**\n${why}.\nMoving ${this.wanted(c).join(', ')} to the real AQW game.`, { kind: 'alert', key: `dm:flash-on:${this.autoOn.at}`, dm: true });
      }
    } else if (this.autoOn && !this.autoOn.manual && (!c.auto || this.headlessWorks())) {   // turned on by hand: stays on until turned off by hand
      this.note(c.auto ? 'standby OFF - headless characters are in game and gaining again' : 'standby OFF - automatic mode switched off');
      if (this.hub.notify && c.auto) this.hub.notify('Flash standby is off', 'The headless client works again; the characters are going back to it.', 'news');
      this.autoOn = null; this.trial = null; this.save();
    } else if (this.autoOn && !this.autoOn.manual) {
      // Everyone in Flash: no headless character left to show it works. Every retryHeadlessMin, one tries headless.
      const probes = this.partyIds().filter((id) => !this.active.has(id));
      if (!probes.length && !this.trial && now - this.lastTry >= c.retryHeadlessMin * 60000) {
        const id = this.wanted(c).filter((x) => (c.modes[x] || 'auto') === 'auto').pop();
        if (id) { this.trial = { id, at: now }; this.lastTry = now; this.save(); await this.switchTo(id, 'headless', 'trying the headless client again'); return; }
      }
      if (this.trial && now - this.trial.at >= c.trialMin * 60000) {
        const cl = this.hub.clients.get(this.trial.id);
        const ok = !!(cl && cl.headless && cl.state && cl.state.loaded);
        this.note(`headless trial with ${this.trial.id}: ${ok ? 'logged in - the headless client works again' : 'still broken'}`);
        const id = this.trial.id;
        this.trial = null; this.save();
        if (ok) { this.autoOn = null; this.save(); } else { this.lastTry = now; }
      }
    }
    // Make the characters match what should be in Flash.
    const want = new Set(this.wanted(c));
    if (this.trial) want.delete(this.trial.id);
    for (const id of [...this.active]) if (!want.has(id)) await this.switchTo(id, 'headless', this.autoOn ? 'not in the Flash list any more' : 'the standby is off');
    for (const id of want) if (!this.active.has(id)) await this.switchTo(id, 'flash', this.autoOn ? `standby: ${this.autoOn.reason}` : 'set to always use Flash');
  }

  async status() {
    const c = this.cfg();
    const host = this.hub.flash ? this.hub.flash.status() : { installed: false };
    let metrics = null;
    try { const m = this.hub.flash && this.hub.flash.running() ? await this.hub.flash.metrics() : null; metrics = m && m.ok ? m.value : null; } catch (e) { /* host busy */ }
    const accounts = [...this.hub.bots.values()].map((b) => {
      const a = b.account || {};
      const cl = this.hub.clients.get(a.id) || {};
      return { id: a.id, label: a.label || a.id, guest: a.kind === 'guest', mode: c.modes[a.id] || 'auto', inFlash: this.active.has(a.id), loaded: !!(cl.state && cl.state.loaded), offlineMin: cl._offlineSince ? Math.round((this.now() - cl._offlineSince) / 60000) : 0, error: cl._lastLoginError || null };
    });
    return { cfg: c, host, metrics, autoOn: this.autoOn, trial: this.trial, active: [...this.active], wanted: this.wanted(c), accounts, history: this.history.slice(-20).reverse() };
  }
}

module.exports = { FlashStandby, DEFAULTS };
