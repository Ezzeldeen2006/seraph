// Discord messages from the bots. The home server sits with its lid closed, so this is how it talks to the owner.
//
// Two ways to send, whichever is configured in discord.json (next to accounts.json):
//   { "webhook": "https://discord.com/api/webhooks/..." }          simplest: a channel webhook
//   { "token": "<bot token>", "userId": "<your user id>" }         a bot that sends direct messages
// Nothing is sent when neither is set, and nothing here ever blocks the bots: failures are logged and dropped.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { P } = require('./paths');

const CONFIG = () => path.join(P.ROOT, 'discord.json');

function config() {
  try { return JSON.parse(fs.readFileSync(CONFIG(), 'utf8')); } catch (e) { return {}; }
}

function request(opts, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({ ...opts, headers: { 'content-type': 'application/json', 'user-agent': 'Seraph (bots, 1.0)', ...(opts.headers || {}), ...(data ? { 'content-length': data.length } : {}) } }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => (res.statusCode < 300 ? resolve(b ? JSON.parse(b) : {}) : reject(new Error(`discord ${res.statusCode}: ${b.slice(0, 200)}`))));
    });
    req.setTimeout(15000, () => req.destroy(new Error('discord timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// What may reach the owner as a DM (the owner 2026-10-28: "make him stop dming me useless things" - 169 DMs in a week, ~80 of
// them the weekly board's "Ultra X is still open this week" and ~25 "stuck on a boss, join room"). A DM only when he
// asked for it or has to act: a watched player online, every bot offline, the service crashing, an AQW game change, an
// engine update that failed. Everything else marked dm goes to the channel instead (discord.json "dmAll": true = old way).
const DM_KEEP = [/^friend:/, /^playerwatch:/, /^dm:party:offline/, /^watchdog:/, /^dm:(game|engine|swap|bridge):/];
const dmWanted = (key, cfg = {}) => !!cfg.dmAll || DM_KEEP.some((r) => r.test(String(key || '')));

class Discord {
  constructor(log = () => {}) {
    this.log = log;
    this.cfg = config();
    this.dmChannel = null;
    this.queue = [];
    this.sending = false;
    this.lastSent = new Map();     // message key -> time, so one stuck bot cannot spam the phone
  }

  get enabled() { return !!(this.cfg.webhook || (this.cfg.token && this.cfg.userId)); }
  reload() { this.cfg = config(); this.dmChannel = null; this._ownerId = null; return this.enabled; }

  // kind is used for rate limiting: the same kind from the same character at most once every 10 minutes.
  // `dm: true` sends a direct message to the owner even when a channel webhook is set (a boss alert has to reach his phone),
  // and falls back to the channel with an @mention if the DM fails.
  send(text, { kind = 'info', key = null, quiet = 10 * 60000, dm = false } = {}) {
    if (dm && !dmWanted(key, this.cfg)) dm = false;   // DM_KEEP: not worth his phone - the channel gets it
    if (!(this.enabled || (dm && this.cfg.token)) || !text) return false;
    const k = key || `${kind}:${text.slice(0, 40)}`;
    const now = Date.now();
    if (quiet && this.lastSent.get(k) && now - this.lastSent.get(k) < quiet) return false;
    this.lastSent.set(k, now);
    this.queue.push({ content: String(text).slice(0, 1900), dm });
    this.pump();
    return true;
  }

  async pump() {
    if (this.sending || !this.queue.length) return;
    this.sending = true;
    while (this.queue.length) {
      const item = this.queue.shift();
      try { await this.deliver(item); } catch (e) { this.log(`discord: ${e.message}`); }
      await new Promise((r) => setTimeout(r, 1200));     // stay well inside Discord's rate limits
    }
    this.sending = false;
  }

  async deliver({ content, dm = false }) {
    if (dm && this.cfg.token) {
      try { await this.directMessage(content); return; } catch (e) {
        if (!this.cfg.webhook) throw e;
        this.log(`discord: DM failed (${e.message}) - posting to the channel instead`);
        const id = await this.ownerId().catch(() => null);
        await this.postWebhook(`${id ? `<@${id}> ` : ''}${content}`, id);
        return;
      }
    }
    if (this.cfg.webhook) { await this.postWebhook(content); return; }
    await this.directMessage(content);
  }

  async postWebhook(content, mention = null) {
    const u = new URL(this.cfg.webhook);
    await request({ host: u.host, path: u.pathname + u.search, method: 'POST' }, { content, username: this.cfg.name || 'Seraph', ...(mention ? { allowed_mentions: { users: [String(mention)] } } : {}) });
  }

  // Who gets the DMs: `userId` in discord.json, or else the bot application's owner (the owner owns AQWBot).
  async ownerId() {
    if (this.cfg.userId) return String(this.cfg.userId);
    if (!this._ownerId) {
      const app = await request({ host: 'discord.com', path: '/api/v10/oauth2/applications/@me', method: 'GET', headers: { authorization: `Bot ${this.cfg.token}` } });
      this._ownerId = (app.owner && app.owner.id) || null;
    }
    if (!this._ownerId) throw new Error('no one to DM: set userId in discord.json');
    return this._ownerId;
  }

  async directMessage(content) {
    if (!this.dmChannel) {
      const ch = await request({
        host: 'discord.com', path: '/api/v10/users/@me/channels', method: 'POST',
        headers: { authorization: `Bot ${this.cfg.token}` },
      }, { recipient_id: await this.ownerId() });
      this.dmChannel = ch.id;
    }
    await request({
      host: 'discord.com', path: `/api/v10/channels/${this.dmChannel}/messages`, method: 'POST',
      headers: { authorization: `Bot ${this.cfg.token}` },
    }, { content });
  }

  // A short daily wrap-up rather than a stream of noise.
  digest(hub) {
    if (!this.enabled) return false;
    const lines = [];
    for (const bot of hub.bots.values()) {
      const s = bot.stats || {};
      const level = (bot._lastLevel = s.level || bot._lastLevel) || '?';
      lines.push(`**${bot.account.label}** lvl ${level} - ${s.kills || 0} kills, ${s.quests || 0} quests, ${s.drops || 0} drops, ${s.deaths || 0} deaths`);
    }
    const boosts = hub.boosts && hub.boosts.summary ? hub.boosts.summary() : null;
    if (boosts && boosts.labels && boosts.labels.length) lines.push(`Boost today: ${boosts.labels.join(', ')}`);
    return this.send([`__Seraph daily report__`, ...lines].join('\n'), { kind: 'digest', quiet: 6 * 3600000 });
  }
}

module.exports = { Discord, config, CONFIG, dmWanted };
