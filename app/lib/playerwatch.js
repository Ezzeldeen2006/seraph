// Player watch: find out when a player who is NOT our friend comes online, and DM the owner.
// The owner, 2026-09-23: "WatchedPlayer wont accept our friend request i just want to know when he is online, maybe create an
// account that keeps trying to goto WatchedPlayer every some time, and try major servers like artix."
//
// AQW has no global "is X online": /who lists only your own room and the character page shows no status. What does
// work is /goto, but only on the server you are on (Chat /goto -> %xt%zm%cmd%1%goto%<name>%):
//   ["warning","-1","Player 'watchedplayer' could not be found."]   not on this server (tested 2026-09-23 from Swordhaven)
//   {"cmd":"moveToArea", ...}                                  found: the server moves us into their room
// So a spare account (never one of the party) logs in once per sweep and hops server to server asking /goto. It leaves
// the moment it has an answer, so it spends a second or two next to the player at most. While the player stays
// online, each sweep starts with the server they were found on, which is usually the only one it needs.
// A full server (Artix sits at 1500/1500 in the evening) cannot be entered, so it is skipped and noted in the log.
'use strict';
const { HeadlessClient } = require('./net/headless');

const NOT_FOUND = /Player '(.+)' could not be found/i;

class PlayerWatch {
  constructor(hub, cfg, { makeClient = (acc) => new HeadlessClient(acc), wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.hub = hub;
    this.cfg = Object.assign({ everyMin: 5, gapMs: 2500, answerMs: 6000, missesForOffline: 2 }, cfg);
    this.names = (cfg.watch || []).map(String);
    this.makeClient = makeClient;
    this.wait = wait;
    this.status = {};     // lower name -> { online, server, room, misses, at }
    this.running = false;
    this.stopped = false;
  }

  start() {
    if (this.running || !this.names.length) return;
    this.running = true;
    this.hub.info(`player watch: ${this.cfg.account.username} sweeps the servers every ${this.cfg.everyMin} min for ${this.names.join(', ')}`);
    (async () => {
      while (!this.stopped) {
        const t0 = Date.now();
        try { await this.sweep(); } catch (e) { this.hub.info(`player watch: ${e.message}`); }
        await this.wait(Math.max(30000, this.cfg.everyMin * 60000 - (Date.now() - t0)));
      }
    })();
  }

  stop() { this.stopped = true; if (this.client) try { this.client.disconnect(); } catch { /* gone */ } }

  // The servers a free account can enter, the ones the watched players were last seen on first, then busiest first
  // (a busy server is the likelier place to find anyone).
  order(servers, level = 1, member = false) {
    const last = new Set(Object.values(this.status).filter((s) => s.online).map((s) => s.server));
    return servers
      .filter((s) => s.bOnline && !Number(s.accessLevel) && (member || !Number(s.bUpg)) && level >= Number(s.iLevel || 0) && !/^(class test|ptr)$/i.test(s.sName))
      .sort((a, b) => (last.has(b.sName) - last.has(a.sName)) || (b.iCount - a.iCount));
  }

  async sweep() {
    const client = this.client || (this.client = this.makeClient({ id: 'playerwatch', ...this.cfg.account }));
    const info = await client.scriptLogin();
    const servers = this.order(info.servers || [], Number(info.level) || 1, Number(info.upgradeDays) > 0);
    const left = new Set(this.names.map((n) => n.toLowerCase()));
    const skipped = [];
    for (const s of servers) {
      if (!left.size || this.stopped) break;
      if (Number(s.iCount) >= Number(s.iMax)) { skipped.push(s.sName); continue; }
      try { await client.scriptConnect(s); } catch (e) { skipped.push(s.sName); this.hub.info(`player watch: ${s.sName}: ${e.message}`); await this.wait(this.cfg.gapMs); continue; }
      for (const name of this.names) {
        if (!left.has(name.toLowerCase())) continue;
        const r = await this.probe(client, name);
        if (r.found) { left.delete(name.toLowerCase()); this.seen(name, s.sName, r.room); }
        if (r.found || this.stopped) break;    // /goto moved us: re-join the server fresh for the next name
      }
      try { client.disconnect(); } catch { /* gone */ }
      await this.wait(this.cfg.gapMs);
    }
    for (const n of left) this.missed(this.names.find((x) => x.toLowerCase() === n), skipped);
  }

  // Ask the server for /goto <name> and wait for its answer.
  probe(client, name) {
    const me = String(name).toLowerCase();
    if (client.w && client.w.users && client.w.users[me]) return Promise.resolve({ found: true, room: client.w.strAreaName || null });   // already in our room
    return new Promise((resolve) => {
      const done = (r) => { clearTimeout(t); client.removeListener('sfs', onSfs); resolve(r); };
      const onSfs = (p) => {
        if (p.kind === 'xt' && p.cmd === 'warning') {
          const m = NOT_FOUND.exec(p.args.join(' '));
          if (m && m[1].toLowerCase() === me) done({ found: false });
        } else if (p.kind === 'json' && p.data && p.data.cmd === 'moveToArea') done({ found: true, room: p.data.areaName || p.data.strMapName || null });
      };
      const t = setTimeout(() => done({ found: false, unknown: true }), this.cfg.answerMs);
      client.on('sfs', onSfs);
      client.xt('cmd', ['goto', me], 1);
    });
  }

  seen(name, server, room) {
    const key = name.toLowerCase();
    const prev = this.status[key] || {};
    this.status[key] = { online: true, server, room, misses: 0, at: Date.now() };
    if (prev.online) { if (prev.server !== server) this.hub.info(`player watch: ${name} moved to ${server}`); return; }
    this.hub.info(`player watch: ${name} is online on ${server}${room ? ` in ${room}` : ''}`);
    const text = `🟢 **${name}** is online in AQW - server **${server}**${room ? `, room \`${room}\` (/join ${room})` : ''}`;
    if (this.hub.discord) this.hub.discord.send(text, { kind: 'playerwatch', key: `playerwatch:${key}`, quiet: 15 * 60000, dm: true });
  }

  // Not found on any server we could enter. Two sweeps in a row before calling it offline: a relog or a server hop
  // mid-sweep, or a stay on a full server, should not produce a second "online" DM a few minutes later.
  missed(name, skipped) {
    const key = name.toLowerCase();
    const s = this.status[key] || (this.status[key] = { online: false, misses: 0 });
    s.misses = (s.misses || 0) + 1;
    if (s.online && s.misses >= this.cfg.missesForOffline) {
      s.online = false;
      this.hub.info(`player watch: ${name} went offline${skipped.length ? ` (or is on ${skipped.join(', ')}: full)` : ''}`);
    }
  }
}

module.exports = { PlayerWatch, NOT_FOUND };
