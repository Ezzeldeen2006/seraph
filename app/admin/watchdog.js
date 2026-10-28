// Bots watchdog (2026-10-27, the owner: "make sure the app can continue without you"). The bots' own health check
// (lib/health.js) runs inside the bots' process, so it can't report that process crash-looping, hanging or failed.
// This one runs in the admin service, which stays up when the bots are down. Every WATCH.everyMs:
//   - systemd's automatic restarts of seraph-bots (NRestarts): WATCH.crashes in WATCH.crashWindowMs -> one alert
//   - the service "failed" (systemd gave up) -> one alert
//   - up, but its API silent WATCH.apiDmMs -> one alert; silent WATCH.apiRestartMs -> the watchdog restarts it
//     (sudo -n systemctl restart, at most once per WATCH.restartGapMs) and says so
// A service stopped by hand (dashboard Stop, a deploy) is left alone. Alerts go through lib/discord.js with the
// bots' discord.json (a DM to the app owner, the channel webhook when the DM fails), WATCH.quietMs apart per kind.
'use strict';
const http = require('http');
const { execFile } = require('child_process');

const WATCH = { everyMs: 120000, crashes: 3, crashWindowMs: 30 * 60000, apiDmMs: 10 * 60000, apiRestartMs: 20 * 60000, restartGapMs: 2 * 3600000, quietMs: 6 * 3600000, pingMs: 20000 };

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => execFile(cmd, args, { timeout, windowsHide: true }, (err, out, errOut) => resolve({ ok: !err, out: String(out || ''), err: String(errOut || (err && err.message) || '') })));
}

// The bots' API answers a cheap GET (the open help calls) within WATCH.pingMs.
function ping(bots, ms = WATCH.pingMs) {
  return new Promise((resolve) => {
    const r = http.request({ ...bots, path: '/help', method: 'GET', timeout: ms }, (up) => { up.resume(); up.on('end', () => resolve(up.statusCode < 500)); });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', () => resolve(false));
    r.end();
  });
}

function discordSay() {
  let d = null;
  return (title, text) => {
    try {
      if (!d) { const { Discord } = require('../lib/discord'); d = new Discord((m) => console.log(`watchdog: ${m}`)); }
      d.send(`⚠️ **${title}**\n${text}`, { kind: 'alert', key: `watchdog:${title}`, dm: true });
    } catch (e) { console.log(`watchdog: discord failed: ${e.message}`); }
  };
}

class Watchdog {
  constructor(opts = {}) {
    this.o = { ...WATCH, ...(opts.limits || {}) };
    this.service = opts.service || 'seraph-bots';
    this.bots = opts.bots || { host: '127.0.0.1', port: 47101 };
    this.run = opts.run || run;
    this.ping = opts.ping || ((b) => ping(b, this.o.pingMs));
    this.say = opts.say || discordSay();
    this.log = opts.log || ((m) => console.log(`${new Date().toISOString()} watchdog: ${m}`));
    this.now = opts.now || (() => Date.now());
    this.crashes = [];
    this.lastN = null;
    this.apiOkAt = this.now();
    this.sent = {};
    this.restartedAt = 0;
  }

  start() {
    this.timer = setInterval(() => { this.tick().catch((e) => this.log(`tick: ${e.message}`)); }, this.o.everyMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  tell(key, title, text) {
    const now = this.now();
    if (this.sent[key] && now - this.sent[key] < this.o.quietMs) return false;
    this.sent[key] = now;
    this.log(`${title} - ${text}`);
    this.say(title, text);
    return true;
  }

  async tick() {
    const now = this.now();
    const r = await this.run('systemctl', ['show', this.service, '-p', 'ActiveState', '-p', 'NRestarts']);
    const s = Object.fromEntries(r.out.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
    const n = Number(s.NRestarts);
    if (s.NRestarts !== undefined && Number.isFinite(n)) {
      if (this.lastN !== null && n > this.lastN) for (let i = 0; i < n - this.lastN; i++) this.crashes.push(now);
      this.lastN = n;
    }
    this.crashes = this.crashes.filter((t) => now - t < this.o.crashWindowMs);
    const mins = (ms) => Math.round(ms / 60000);
    if (this.crashes.length >= this.o.crashes) {
      this.tell('crashloop', 'Seraph bots keep crashing', `${this.crashes.length} crash restarts in ${mins(this.o.crashWindowMs)} min: the bots start and fall over again. The reason is at the end of ~/seraph/logs/bots.log (dashboard: Log). After an update, roll back with the backup-app-<tag>.tgz it made.`);
    }
    if (s.ActiveState === 'failed') this.tell('failed', 'Seraph bots service failed', 'systemd gave up restarting it. Dashboard -> Start, or: ssh server "sudo systemctl restart seraph-bots".');
    // Stopped (by hand, a deploy) or between two restarts: nothing to ask.
    if (s.ActiveState !== 'active') { this.apiOkAt = now; return { state: s.ActiveState || 'unknown' }; }
    if (await this.ping(this.bots)) { this.apiOkAt = now; return { state: 'active', api: true }; }
    const silent = now - this.apiOkAt;
    if (silent >= this.o.apiRestartMs && now - this.restartedAt >= this.o.restartGapMs) {
      this.restartedAt = now;
      this.apiOkAt = now;
      const rr = await this.run('sudo', ['-n', 'systemctl', 'restart', this.service], 90000);
      this.tell('restart', 'Seraph bots restarted by the watchdog', `The bots' process was running but had not answered for ${mins(silent)} min (hung). ${rr.ok ? 'Restarted it; the bots log in again by themselves.' : `The restart failed (${rr.err.slice(0, 120) || 'no sudo'}).`}`);
      return { state: 'active', api: false, restarted: rr.ok };
    }
    if (silent >= this.o.apiDmMs) this.tell('silent', 'Seraph bots not answering', `Running, but silent for ${mins(silent)} min. The watchdog restarts it at ${mins(this.o.apiRestartMs)} min.`);
    return { state: 'active', api: false };
  }
}

module.exports = { Watchdog, WATCH, ping };
