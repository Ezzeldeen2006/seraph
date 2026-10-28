// Discord slash commands for the bots: /report, /bot <name>, /ultras, /where. Runs inside the Seraph process on the laptop.
//
// A long-lived connection to Discord's gateway (outbound only, so no open ports on the home server), using the
// WebSocket built into Node 22. Only the owner - the application's owner - can use the commands.
// Config (discord.json next to accounts.json): { token, webhook, guildId }.
'use strict';
const https = require('https');
const report = require('./report');

const API = 'discord.com';

function rest(token, method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      host: API, path: `/api/v10${route}`, method,
      headers: { authorization: `Bot ${token}`, 'content-type': 'application/json', 'user-agent': 'Seraph (bots, 1.0)', ...(data ? { 'content-length': data.length } : {}) },
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => (res.statusCode < 300 ? resolve(b ? JSON.parse(b) : {}) : reject(new Error(`discord ${method} ${route} ${res.statusCode}: ${b.slice(0, 200)}`))));
    });
    req.setTimeout(20000, () => req.destroy(new Error('discord timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const COMMANDS = [
  { name: 'report', description: 'What every bot is doing, what it got and what is next', options: [{ type: 4, name: 'hours', description: 'How far back for "got" (default 24)', required: false, min_value: 1, max_value: 168 }] },
  { name: 'bot', description: 'Detailed status for one character', options: [{ type: 3, name: 'name', description: 'Sable7, Valen7, Nova7 or Oren7', required: true, autocomplete: false }] },
  { name: 'ultras', description: 'Is the party ready for ultras, and what is still missing' },
  { name: 'where', description: 'Where every bot is right now: server, map, room number, and the /join line' },
  { name: 'resetscripts', description: 'Skua\'s "Reset Scripts": download the script library again and clear its compile cache' },
];

// /where: one block per character. /goto fails on "locked zone" maps, so the line to type is /join <map>-<room>.
function whereText(rows) {
  return rows.map((r) => {
    if (!r.online) return `**${r.label}** — offline or between maps (${r.doing})`;
    return [`**${r.label}** — ${r.server || 'server ?'} · map **${r.map}** · room **${r.room || '?'}**${r.isPublic ? ' (public)' : ' (private)'}${r.cell ? ` · cell ${r.cell}` : ''}`,
      `\`/join ${r.area}\``, `_${String(r.doing).slice(0, 110)}_`].join('\n');
  }).join('\n\n') + '\n\nBe on the same server first. If `/goto` says locked zone, type the `/join` line.';
}

class DiscordBot {
  constructor(hub, cfg, log = () => {}) {
    this.hub = hub;
    this.cfg = cfg;
    this.log = log;
    this.ws = null;
    this.seq = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.stopped = false;
    this.backoff = 5000;
  }

  get token() { return this.cfg.token; }

  async start() {
    if (!this.token || typeof WebSocket === 'undefined') { this.log('discord bot: no token or no WebSocket - commands off'); return false; }
    try {
      const app = await rest(this.token, 'GET', '/oauth2/applications/@me');
      this.appId = app.id;
      this.ownerId = app.owner && app.owner.id;
      // Server commands appear instantly; global ones can take up to an hour.
      if (this.cfg.guildId) await rest(this.token, 'PUT', `/applications/${this.appId}/guilds/${this.cfg.guildId}/commands`, COMMANDS);
      else await rest(this.token, 'PUT', `/applications/${this.appId}/commands`, COMMANDS);
      this.registered = true;
      this.log(`discord bot: commands registered (${COMMANDS.map((c) => '/' + c.name).join(' ')})`);
    } catch (e) { this.log(/50001/.test(e.message) ? 'discord bot: not in the server yet - commands appear as soon as it is invited' : `discord bot: ${e.message}`); }
    this.connect();
    return true;
  }

  // Who may use the commands: the application's owner. Retried until Discord answers (slow networks happen).
  lookupOwner(attempt = 1) {
    rest(this.token, 'GET', '/oauth2/applications/@me').then((app) => {
      this.ownerId = app.owner && app.owner.id;
      if (!this.appId) this.appId = app.id;
    }).catch(() => { if (!this.stopped && attempt < 20) setTimeout(() => this.lookupOwner(attempt + 1), 30000); });
  }

  stop() { this.stopped = true; clearInterval(this.beat); try { if (this.ws) this.ws.close(); } catch (e) { /* gone */ } }

  connect(resume = false) {
    if (this.stopped) return;
    const url = (resume && this.resumeUrl) || 'wss://gateway.discord.gg';
    const ws = new WebSocket(`${url}/?v=10&encoding=json`);
    this.ws = ws;
    ws.addEventListener('message', (ev) => { if (this.ws !== ws) return; try { this.onMessage(JSON.parse(ev.data), resume); } catch (e) { this.log(`discord bot: ${e.message}`); } });
    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return;   // a socket we already dropped (reconnectNow): its late close changes nothing
      clearInterval(this.beat);
      if (this.stopped) return;
      const fatal = [4004, 4010, 4011, 4012, 4013, 4014].includes(ev.code);   // bad token / intents: retrying won't help
      this.log(`discord bot: disconnected (${ev.code})${fatal ? ' - check the token' : ', reconnecting'}`);
      if (!fatal) { setTimeout(() => this.connect(!!this.sessionId), this.backoff); this.backoff = Math.min(this.backoff * 2, 5 * 60000); }
    });
    ws.addEventListener('error', () => { /* close follows */ });
  }

  // Drop the current socket and open a new one now. close() on a dead TCP link waits for Discord's close frame, which
  // never comes: the 'close' event came ~5 min later and the bot sat offline that long after every Wi-Fi stall
  // ("no heartbeat ack" every 41 s, 2026-10-09).
  reconnectNow(why) {
    const old = this.ws;
    this.ws = null;
    clearInterval(this.beat);
    this.log(`discord bot: ${why} - reconnecting`);
    try { if (old) old.close(4000); } catch (e) { /* gone */ }
    if (!this.stopped) setTimeout(() => this.connect(!!this.sessionId), 1000);
  }

  send(op, d) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ op, d })); }

  onMessage(msg, resume) {
    if (msg.s) this.seq = msg.s;
    switch (msg.op) {
      case 10: {   // hello: start heartbeating, then identify or resume
        clearInterval(this.beat);
        // A heartbeat that was never acknowledged means a dead socket (the laptop's Wi-Fi drops them silently):
        // close it and resume, or the bot looks online but never answers again.
        this.acked = true;
        this.beat = setInterval(() => {
          if (!this.acked) { this.reconnectNow('no heartbeat ack'); return; }
          this.acked = false;
          this.send(1, this.seq);
        }, msg.d.heartbeat_interval);
        if (resume && this.sessionId) this.send(6, { token: this.token, session_id: this.sessionId, seq: this.seq });
        else this.send(2, { token: this.token, intents: 1, properties: { os: 'linux', browser: 'seraph', device: 'seraph' } });
        return;
      }
      case 1: this.send(1, this.seq); return;
      case 11: this.acked = true; return;                                            // heartbeat ack
      case 7: try { this.ws.close(4000); } catch (e) { /* */ } return;               // reconnect requested
      case 9: this.sessionId = null; setTimeout(() => { try { this.ws.close(4000); } catch (e) { /* */ } }, 2000); return;   // invalid session
      case 0:
        if (msg.t === 'RESUMED') { this.backoff = 5000; this.log('discord bot: resumed'); }
        if (msg.t === 'READY') {
          this.sessionId = msg.d.session_id; this.resumeUrl = msg.d.resume_gateway_url; this.backoff = 5000;
          if (msg.d.application && msg.d.application.id) this.appId = msg.d.application.id;
          this.log('discord bot: online');
          if (!this.ownerId) this.lookupOwner();
        }
        // Invited (or reconnected) to the server: make sure the commands exist there.
        if (msg.t === 'GUILD_CREATE' && msg.d && (!this.cfg.guildId || msg.d.id === this.cfg.guildId) && !this.registered) {
          rest(this.token, 'PUT', `/applications/${this.appId}/guilds/${msg.d.id}/commands`, COMMANDS)
            .then(() => { this.registered = true; this.log(`discord bot: commands ready in ${msg.d.name}`); })
            .catch((e) => this.log(`discord bot: ${e.message}`));
        }
        if (msg.t === 'INTERACTION_CREATE') this.onInteraction(msg.d).catch((e) => this.log(`discord bot: ${e.message}`));
        return;
      default:
    }
  }

  async reply(i, content, first = true) {
    const parts = [];
    let rest0 = String(content || '(nothing)');
    while (rest0.length > 1900) { const cut = rest0.lastIndexOf('\n', 1900) > 0 ? rest0.lastIndexOf('\n', 1900) : 1900; parts.push(rest0.slice(0, cut)); rest0 = rest0.slice(cut); }
    parts.push(rest0);
    for (let k = 0; k < parts.length; k++) {
      if (first && k === 0) await rest(this.token, 'PATCH', `/webhooks/${this.appId}/${i.token}/messages/@original`, { content: parts[k] });
      else await rest(this.token, 'POST', `/webhooks/${this.appId}/${i.token}`, { content: parts[k] });
    }
  }

  async onInteraction(i) {
    if (i.type !== 2) return;   // slash commands only
    const user = (i.member && i.member.user) || i.user || {};
    // Deferred reply first: building a report can take a few seconds and Discord only waits three.
    await rest(this.token, 'POST', `/interactions/${i.id}/${i.token}/callback`, { type: 5, data: { flags: user.id === this.ownerId ? 0 : 64 } });
    if (!this.ownerId || user.id !== this.ownerId) return this.reply(i, this.ownerId ? 'These bots answer to their owner only.' : 'Still starting up - try again in a minute.');
    const opt = (name) => ((i.data.options || []).find((o) => o.name === name) || {}).value;
    const hub = this.hub;
    switch (i.data.name) {
      case 'report': {
        const sections = await report.build(hub, { hours: opt('hours') || 24 });
        return this.reply(i, sections.join('\n\n'));
      }
      case 'bot': {
        const want = String(opt('name') || '').toLowerCase();
        const bot = [...hub.bots.values()].find((b) => b.id.toLowerCase() === want || b.account.label.toLowerCase() === want || b.id.toLowerCase().startsWith(want));
        if (!bot) return this.reply(i, `No character called "${opt('name')}". Try: ${[...hub.bots.values()].map((b) => b.account.label).join(', ')}`);
        const sections = await report.build(hub, { hours: 24 });
        const mine = sections.find((s) => s.includes(`**${bot.account.label}**`)) || '';
        const journal = (bot.lastLog || []).slice(-6).map((l) => `\`${l.slice(11, 16)}\` ${l.slice(25, 140)}`).join('\n');
        return this.reply(i, `${mine}\n\n__Last lines of the journal__\n${journal || '(empty)'}`);
      }
      case 'ultras': {
        const u = hub.ultraReady ? hub.ultraReady() : { ready: false, missing: ['not checked yet'] };
        // Ultras-v3 (lib/ultraready.js): one line per boss - ready or not, and who plays which class.
        const seats = Object.values(u.bosses || {}).map((b) => `${b.ready ? '✅' : '⏳'} ${b.name}: ${b.seats.map((s) => `${s.id} ${s.cls}`).join(', ')}`).join('\n');
        return this.reply(i, `${u.ready ? `✅ **Ready** - ${u.compName}` : '⏳ **Not ready yet**'}\n${seats}\n${(u.missing || []).length ? `\n__Missing__\n${u.missing.slice(0, 15).map((m) => `• ${m}`).join('\n')}` : ''}${u.advice ? `\n\n${u.advice}` : ''}`);
      }
      case 'where': return this.reply(i, whereText(hub.where()));
      case 'resetscripts': {
        const r = await hub.updater.resetScripts('the owner asked on Discord');
        return this.reply(i, r.ok ? `✅ Scripts reset to ${String(r.head).slice(0, 7)} and the compile cache cleared. Scripts already running finish first; the next ones compile fresh.` : `❌ Reset failed: ${r.error || 'see the hub log'}`);
      }
      default: return this.reply(i, 'Unknown command.');
    }
  }
}

module.exports = { DiscordBot, COMMANDS, rest, whereText };
