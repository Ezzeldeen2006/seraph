// Health check (the owner 2026-09-19, testing phase: "keep an eye for any bugs or issues they encounter").
// Every 15 minutes it reads each character's last hour of journal plus the party's state, and reports what looks
// wrong to Discord (via hub.notify), at most once per problem every 6 hours. GET /health shows the latest findings.
// Each rule below is a failure seen for real on the laptop.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { P } = require('./paths');

const { serverDay } = require('./util');

const HOUR = 3600000;
const QUIET_MS = 30 * 60000;       // nothing gained this long: say so
const DAILIES_BY_MS = 12 * HOUR;   // no daily run this long after the reset: say so
const OFFLINE_MS = 20 * 60000;     // a character that can't log in this long: say so
const RULES = [
  { id: 'rank', re: /\(RankUpClassInternal\) "([^"]+)" is somehow\.\.\. not rank 10/, min: 2, say: (m, n) => `rank-up of ${m[1]} ended below rank 10 ${n}x` },
  { id: 'join', re: /Failed to join (\S+)/, min: 3, say: (m, n) => `could not join /${m[1]} ${n}x` },
  { id: 'closed', re: /script stopped: \/(\S+) is unavailable right now/, min: 2, say: (m, n) => `/${m[1]} closed, ${n} scripts stopped` },
  { id: 'translator', re: /(Skua engine could not run \S+|Skua engine not installed)/, min: 1, say: (m, n) => `${m[1]} (translator used ${n}x)` },
  { id: 'engine', re: /(script error: .{0,80}|engine exited.{0,40}|engine failed to start.{0,60})/, min: 2, say: (m, n) => `engine trouble ${n}x: ${m[1]}` },
  { id: 'login', re: /Please log-in before starting the bot/, min: 2, say: (m, n) => `scripts started before the character was in game ${n}x` },
  { id: 'stuck', re: /watchdog: (?:no kills, quests or drops|the script has (?:said nothing new|made no progress)|the server refused its actions \d+x in 10 min \("slow down"\) and no item or quest came of it) for \d+ min while "([^"]{0,80})/, min: 2, say: (m, n) => `stuck ${n}x (no progress): ${m[1]}` },
  { id: 'relog', re: /script stopped: Skua relogged (\d+)x/, min: 1, say: (m, n) => `Skua relog loop stopped ${n}x (a quest that recovery can't fix)` },
  { id: 'fj', re: /Farmer Joe stopped early/, min: 2, say: (m, n) => `Farmer Joe stopped early ${n}x` },
  { id: 'failed', re: /Z error: (.{0,90})/, min: 3, say: (m, n) => `${n} failed tasks, last: ${m[1]}` },
];

class Health {
  constructor(hub) {
    this.hub = hub;
    this.sent = {};          // problem key -> last report time
    this.deaths = {};        // bot id -> [{ t, deaths }]
    this.idle = {};          // bot id -> when its loop was first seen not running
    this.gains = {};         // bot id -> [{ t, sum }] of XP + kills + quests + drops + items
    this.findings = [];
    this.checkedAt = null;
  }

  // Journal lines of the last hour: "2026-09-19T08:12:52.000Z message".
  static recent(lines, now) {
    return (lines || []).filter((l) => { const t = Date.parse(String(l).slice(0, 24)); return !Number.isNaN(t) && now - t < HOUR; });
  }

  async check(now = Date.now()) {
    const out = [];
    const bots = [...this.hub.bots.values()].filter((b) => b.running);
    for (const bot of bots) {
      const lines = Health.recent(bot.lastLog, now);
      for (const r of RULES) {
        const hits = lines.map((l) => r.re.exec(l)).filter(Boolean);
        if (hits.length >= r.min) out.push({ bot: bot.id, key: `${bot.id}:${r.id}:${hits[hits.length - 1][1] || ''}`, text: r.say(hits[hits.length - 1], hits.length) });
      }
      // Deaths per hour (the laptop once hid a 995-deaths day behind a working bot).
      const d = (this.deaths[bot.id] = (this.deaths[bot.id] || []).filter((x) => now - x.t < HOUR));
      d.push({ t: now, deaths: bot.stats.deaths });
      const died = bot.stats.deaths - d[0].deaths;
      if (died >= 8) out.push({ bot: bot.id, key: `${bot.id}:deaths`, text: `${died} deaths in the last hour (${bot.current ? bot.current.why || bot.current.type : 'idle'})` });
      // Outcomes, not symptoms (2026-10-01: a frozen character and three days without dailies showed in none of the
      // rules above). Nothing gained for 30 min: no XP, kill, quest, drop or item. Told once; the watchdog does the fixing.
      const g = bot.progressMark ? bot.progressMark() : null;
      // Queueing for a Skua engine is the pool's doing, not the character's (the watchdog skips it too; the hub logs the
      // engine budget every 10 min): Sunna's "no XP for 45 min" on 10-23 was 25 min in that queue.
      const waiting = bot.paused || (bot.current && bot.current.type === 'idle') || !!(this.hub.engineWaiting && this.hub.engineWaiting.has(bot.id));
      if (g && !waiting) {
        const sum = g.xp + g.kills + g.quests + g.drops + g.items;
        const p = (this.gains[bot.id] = (this.gains[bot.id] || []).filter((x) => now - x.t <= 46 * 60000));
        p.push({ t: now, sum });
        const old = p.filter((x) => now - x.t >= QUIET_MS);
        if (old.length && p.every((x) => x.sum === sum)) out.push({ bot: bot.id, key: `${bot.id}:quiet`, text: `no XP, kills, quests or drops for ${Math.round((now - p[0].t) / 60000)} min (${bot.current ? bot.current.why || bot.current.type : 'between tasks'})` });
      } else delete this.gains[bot.id];
      // Half a server day gone and not one daily run (done or failed).
      const brain = this.hub.brain;
      if (brain && brain.today && serverDay(new Date(now)) === serverDay(new Date(now - DAILIES_BY_MS))) {
        let day = null;
        try { day = brain.today(bot); } catch (e) { /* no state yet */ }
        const ran = day && Object.values(day.dailies || {}).some((v) => v === 'done' || v === 'failed');
        if (day && !ran && bot.settings && bot.settings.autopilot !== false) out.push({ bot: bot.id, key: `${bot.id}:dailies:${serverDay(new Date(now))}`, text: `no daily has run today, ${DAILIES_BY_MS / HOUR} h after the reset` });
      }
    }
    // A character whose loop ended and never started again (2026-09-30: Oren stood still for 26 h after the reset
    // relog, and nothing here looked at stopped bots). Seen stopped on two checks in a row, not stopped by hand and
    // not in the middle of a reconnect: start it and say so.
    for (const bot of this.hub.bots.values()) {
      const acc = bot.account || {};
      const client = this.hub.clients && this.hub.clients.get(bot.id);
      const idle = !bot.running && acc.autostart && acc.status !== 'pending' && !bot.stoppedByHand && !(client && (client._reconnecting || client._holdOffline));
      // A held-offline account (the owner playing his main, or logged out from the dashboard) waits for its Start: 2026-10-19 the
      // loop was restarted 2 h after he took over and sat in a login that never came.
      if (!idle) { delete this.idle[bot.id]; continue; }
      if (!this.idle[bot.id]) { this.idle[bot.id] = now; continue; }
      if (now - this.idle[bot.id] < 10 * 60000) continue;   // GET /health?now=1 can check twice in a minute
      const min = Math.round((now - this.idle[bot.id]) / 60000);
      const started = bot.start();
      if (bot.journal) bot.journal(`health: the bot loop was not running for ${min} min - ${started ? 'started it again' : 'it would not start'}`);
      out.push({ bot: bot.id, key: `${bot.id}:idle`, text: `the bot loop was not running for ${min} min - ${started ? 'started it again' : 'it would not start'}` });
      if (started) delete this.idle[bot.id];
    }
    // One party, one server, one room (the owner 2026-09-19).
    const grouped = !(this.hub.settings.party && this.hub.settings.party.grouped === false);
    const online = [];
    for (const b of bots) if (await b.playing().catch(() => false)) online.push(b);
    // Since the crowd rule (the owner 2026-09-25/27) characters are on Artix or Swordhaven and in public or party rooms on
    // purpose, so "split over servers" and "scripts outside the party room" are no longer problems (47 false Discord
    // alerts in the week to 09-28). The party itself is only checked among characters on the leader's server.
    const crowdMode = this.hub.settings.crowd !== false;
    if (grouped && online.length > 1) {
      const servers = new Set(online.map((b) => b.serverName).filter(Boolean));
      if (!crowdMode && servers.size > 1) out.push({ key: 'party:servers', text: `the party is split over servers: ${[...servers].join(', ')}` });
      // The same leader hub.partyTick invites from, not just the first bot that happens to be online: reading a
      // follower's party list reported the wrong characters as missing.
      const leader = (this.hub.partyLeaderOf && this.hub.partyLeaderOf(online)) || online[0];
      const members = ((await leader.g('world.partyMembers', [])) || []).map((x) => String(x).toLowerCase());
      const own = String(await leader.name().catch(() => leader.id)).toLowerCase();
      const names = [];
      for (const b of online) if (!crowdMode || b.serverName === leader.serverName) names.push(String(await b.name().catch(() => b.id)).toLowerCase());
      const missing = names.filter((n) => n !== own && !members.includes(n));   // a leader is never in its own list
      if (members.length && missing.length) out.push({ key: 'party:members', text: `not in the in-game party: ${missing.join(', ')}` });
      if (!members.length && names.length > 1) out.push({ key: 'party:none', text: 'no in-game party' });
      if (!crowdMode) {
        const scripted = [];
        for (const b of online) if (b.current && b.current.type === 'script') scripted.push([b, String(await b.g('world.strAreaName', '') || '')]);
        const room = this.hub.settings.levelParty && this.hub.settings.levelParty.room;
        const off = scripted.filter(([, area]) => room && area && !/^(whitemap|battleon|yulgar|house)/i.test(area) && !area.endsWith(`-${room}`));
        if (off.length) out.push({ key: 'party:room', text: `running scripts outside room ${room}: ${off.map(([b, a]) => `${b.id} in ${a}`).join(', ')}` });
      }
    }
    // Nobody in game (2026-10-10: AQW 5.0 changed the game's network format at 00:57 UTC and the four characters failed
    // 153 logins each over 15 h without a word from here - a character that can't log in has no running loop, so
    // none of the rules above looked at it). One character offline 20 min: said once. All of them: a DM to the owner too.
    const offline = [];
    let party = 0;
    for (const bot of this.hub.bots.values()) {
      const acc = bot.account || {};
      if (acc.kind === 'guest' || acc.status === 'pending' || acc.wantOnline === false) continue;
      party++;
      const client = this.hub.clients && this.hub.clients.get(bot.id);
      if (client && client._offlineSince && now - client._offlineSince >= OFFLINE_MS) offline.push({ bot, client, min: Math.round((now - client._offlineSince) / 60000) });
    }
    const game = (this.hub.updater && this.hub.updater.state && this.hub.updater.state.game) || {};
    const errors = [...new Set(offline.map((o) => o.client._lastLoginError).filter(Boolean))];
    if (party && offline.length === party) {
      const since = Math.max(...offline.map((o) => o.min));
      const fresh = game.changedAt && now - Date.parse(game.changedAt) < 48 * HOUR;
      const text = `none of the ${party} characters can log in (${since} min so far). Last error: ${errors[0] || 'none recorded'}. `
        + `AQW game file ${game.sFile || '?'} (client ${game.clientVersion || '?'})${fresh ? `, new since ${String(game.changedAt).slice(0, 16).replace('T', ' ')} UTC` : ''}. `
        + `${fresh ? 'AQW changed its game: Seraph\'s headless client probably needs an update (ask Claude). ' : ''}Until then the bots keep retrying by themselves.`;
      out.push({ key: `party:offline:${game.sFile || ''}`, text, dm: true });
    } else {
      for (const o of offline) out.push({ bot: o.bot.id, key: `${o.bot.id}:offline`, text: `can't log in for ${o.min} min: ${o.client._lastLoginError || 'no error recorded'}` });
    }

    // Memory: the laptop has 3 GB for the bots, four engines, the other services on the server.
    const availMb = Health.availableMb();
    if (availMb < 250) out.push({ key: 'memory', text: `memory low: ${availMb} MB available` });

    this.findings = out;
    this.checkedAt = new Date(now).toISOString();
    for (const f of out) {
      if (now - (this.sent[f.key] || 0) < 6 * HOUR) continue;
      this.sent[f.key] = now;
      this.hub.notify(`Health: ${f.bot ? this.hub.bot(f.bot).account.label : 'party'}`, f.text, 'alert');
      if (f.dm && this.hub.discord && this.hub.discord.enabled) this.hub.discord.send(`⚠️ **Seraph: the bots are offline**\n${f.text}`, { kind: 'alert', key: `dm:${f.key}`, dm: true });
      try { fs.appendFileSync(path.join(P.LOGS, 'health.log'), `${this.checkedAt} ${f.bot || 'party'}: ${f.text}\n`); } catch (e) { /* */ }
    }
    return out;
  }

  // Linux counts reclaimable cache as used in os.freemem() (214 MB "free" with 1.6 GB really available).
  static availableMb() {
    try { const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8')); if (m) return Math.round(Number(m[1]) / 1024); } catch (e) { /* not Linux */ }
    return Math.round(os.freemem() / 1048576);
  }

  // The bot process's own memory next to the findings (audit B3: it runs with a 256 MB heap on the laptop).
  status() { return { checkedAt: this.checkedAt, findings: this.findings, memory: memory() }; }
}

function memory(m = process.memoryUsage()) {
  const mb = (n) => Math.round(n / 1048576);
  const heap = require('v8').getHeapStatistics();
  return { rssMb: mb(m.rss), heapUsedMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), heapLimitMb: mb(heap.heap_size_limit), externalMb: mb(m.external) };
}

module.exports = { Health, RULES, memory };
