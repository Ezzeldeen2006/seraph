// Friend watch: AQWBot DMs the owner when a watched player logs in to AQW.
// The owner, 2026-09-23: "can you make the AQW bot dm me on discord when User WatchedPlayer become online in AQW."
//
// AQW has no /who. The only thing that shows another player coming online is the friends list:
//   {"cmd":"friends"|"loadFriendsList","friends":[{ID,sName,iLvl,sServer}, ...]}   the whole list (Game.as; rarely seen)
//   {"cmd":"updateFriend","friend":{ID,sName,iLvl,sServer}}                         a friend logged in or out
//   {"cmd":"addFriend","friend":{...}}                                              a friend request was accepted
// sServer is "Offline" when they are gone (seen live for grail26 on 2026-09-23, with a "<name> has logged in."
// server line). So a watched name has to be on at least one bot's friend list: until a bot has seen it, one bot
// (requestFrom) sends it ONE friend request after logging in, remembered in the state file so it is never sent again.
//
// The names live in lib/friendwatch.json and ship with the code. Every bot gets the same updateFriend, so the
// online/offline state is kept here, once, and only the offline -> online change sends a DM.
'use strict';
const fs = require('fs');
const path = require('path');
const { P } = require('./paths');

const LIST = path.join(__dirname, 'friendwatch.json');
const STATE = () => path.join(P.ROOT, 'friendwatch-state.json');
const RETRY_MS = 20 * 60000;
const FRIEND_CMDS = new Set(['friends', 'loadFriendsList', 'updateFriend', 'addFriend']);

function readJson(file, dflt) {
  try { return Object.assign(dflt, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return dflt; }
}

class FriendWatch {
  constructor(hub, { list = LIST } = {}) {
    this.hub = hub;
    this.cfg = readJson(list, { watch: [], requestFrom: null });
    this.state = readJson(STATE(), { seen: {}, requested: {} });
    this.pending = new Map();     // names asked a moment ago, waiting to hear whether the server found them
  }

  get watched() { return (this.cfg.watch || []).map((n) => String(n)); }
  isWatched(name) { return this.watched.some((n) => n.toLowerCase() === String(name || '').toLowerCase()); }
  display(name) { return this.watched.find((n) => n.toLowerCase() === String(name).toLowerCase()) || name; }

  save() { try { fs.writeFileSync(STATE(), JSON.stringify(this.state, null, 1)); } catch (e) { this.hub.info(`friend watch: ${e.message}`); } }

  // bot.handlePacket hands over every friend packet.
  onPacket(bot, o) {
    if (!o || !FRIEND_CMDS.has(o.cmd)) return;
    const whole = o.cmd === 'friends' || o.cmd === 'loadFriendsList';
    const list = whole ? (Array.isArray(o.friends) ? o.friends : null) : [o.friend];
    if (!list) return;     // "friends" without a list is just the UI toggle
    // The owner's own characters too: one he logged in to comes back after he logs out (hub.ownerFriend). Only a change
    // (updateFriend) counts - a whole list is a snapshot, not a logout.
    if (o.cmd === 'updateFriend' && typeof this.hub.ownerFriend === 'function') for (const f of list) if (f) this.hub.ownerFriend(f, bot);
    for (const f of list) if (f && this.isWatched(f.sName)) this.update(bot, f);
  }

  update(bot, f) {
    const key = String(f.sName).toLowerCase();
    const online = !!f.sServer && f.sServer !== 'Offline';
    const prev = this.state.seen[key];
    if (prev && prev.online === online && prev.server === f.sServer) return;
    this.state.seen[key] = { online, server: f.sServer, level: f.iLvl, at: Date.now() };
    this.save();
    const name = this.display(f.sName);
    this.hub.info(`friend watch: ${name} is ${online ? `online on ${f.sServer}` : 'offline'} (seen by ${bot.account.label})`);
    if (!online || (prev && prev.online)) return;   // a server change while online is not a new login
    const lvl = f.iLvl ? ` (lvl ${f.iLvl})` : '';
    const text = `🟢 **${name}**${lvl} just came online in AQW - server **${f.sServer}**`;
    // A quick relog or server hop comes back within minutes: one DM per 10 minutes is enough.
    if (this.hub.discord) this.hub.discord.send(text, { kind: 'friend', key: `friend:${key}`, quiet: 10 * 60000, dm: true });
  }

  // A watched name on no friend list can never be seen, so requestFrom asks it, a few seconds after logging in.
  // The server does not send the friend list at login, and getfriendlist answered {"cmd":"friends","showList":false}
  // with no list (oren7, 2026-09-23), so "never seen by any bot" stands for "not a friend yet".
  // A request only reaches a player who is online: otherwise the server answers ["warning","-1","WatchedPlayer not found."]
  // (first try, 2026-09-23). So it is retried every 20 minutes until one goes through (no warning), then never again.
  // The other way round works too: a request FROM a watched name is accepted by whichever bot gets it.
  onLogin(bot, delay = 8000) {
    if (!this.cfg.requestFrom || String(bot.account.label).toLowerCase() !== String(this.cfg.requestFrom).toLowerCase()) return;
    this.requester = bot;
    this.schedule(delay);
  }

  due() { return this.watched.filter((n) => !this.state.seen[n.toLowerCase()] && !(this.state.requested[n.toLowerCase()] || {}).delivered); }

  schedule(delay) {
    clearTimeout(this.timer);
    if (!this.due().length) return;
    this.timer = setTimeout(() => this.ask(), delay);
    if (this.timer.unref) this.timer.unref();
  }

  ask(retry = RETRY_MS, confirm = 5000) {
    const bot = this.requester;
    if (!bot || !bot.client || typeof bot.client.xt !== 'function') return;
    for (const name of this.due()) {
      const key = name.toLowerCase();
      const r = this.state.requested[key] = { by: bot.account.label, at: Date.now(), tries: ((this.state.requested[key] || {}).tries || 0) + 1, delivered: false };
      this.save();
      try { bot.client.xt('requestFriend', [name], 1); } catch (e) { this.hub.info(`friend watch: ${e.message}`); continue; }   // World.requestFriend
      this.pending.set(key, true);
      const t = setTimeout(() => {
        if (!this.pending.delete(key)) return;        // "not found" came back: onWarning already rescheduled
        r.delivered = true; this.save();
        this.hub.info(`friend watch: ${bot.account.label} sent ${name} a friend request (try ${r.tries}) - it has to be accepted in game`);
      }, confirm);
      if (t.unref) t.unref();
    }
    this.schedule(retry);
  }

  // bot.handlePacket: ["warning","-1","<name> not found."]
  onWarning(text) {
    const m = /^(.+) not found\.$/.exec(String(text).trim());
    if (!m || !this.pending.delete(m[1].toLowerCase())) return false;
    if (!this.logged) { this.hub.info(`friend watch: ${m[1]} is not online - the friend request is retried every ${RETRY_MS / 60000} min`); this.logged = true; }
    return true;
  }

  // bot.handlePacket: {"cmd":"requestFriend","unm":"WatchedPlayer"} - accept it, the same packet the game's Accept button sends.
  // The owner's own characters too (2026-10-22: "make the new bots accept my friend request" - grail26's requests to
  // the girls were ignored): every account in the registry, his main included.
  isOurs(unm) {
    const n = String(unm || '').toLowerCase();
    if (!n || !this.hub.bots) return false;
    for (const b of this.hub.bots.values()) {
      const a = b.account || {};
      if ([a.username, a.label, b.id].some((x) => x && String(x).toLowerCase() === n)) return true;
    }
    return false;
  }

  onRequest(bot, unm) {
    if (!(this.isWatched(unm) || this.isOurs(unm)) || !bot.client || typeof bot.client.xt !== 'function') return false;
    bot.client.xt('addFriend', [unm], 1);   // World.addFriend
    this.hub.info(`friend watch: ${bot.account.label} accepted ${unm}'s friend request`);
    return true;
  }

  stop() { clearTimeout(this.timer); }

  status() {
    return this.watched.map((n) => ({ name: n, ...(this.state.seen[n.toLowerCase()] || { online: null }), requested: this.state.requested[n.toLowerCase()] || null }));
  }
}

module.exports = { FriendWatch, FRIEND_CMDS };
