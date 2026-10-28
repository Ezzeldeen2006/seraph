// What the week still owes (the owner 2026-10-25: "weekly goals that run automatically and have 0 chance of failure ... you
// should run ultra speaker weekly especially for my main"). The raids themselves are hub.raidProvenTick / raidWithMain
// (a proven recipe replays by itself every Friday reset, the main in his seat); this is the board over them: who has the
// week's turn-in, who does not and why, and one alert a day once a weekly is still open late in its week, so a weekly that
// cannot run is never found out on Thursday night.
'use strict';
const ultraready = require('./ultraready');
const schedule = require('./schedule');
const recipes = require('./recipes');

const DAY = 86400000;
const ALERT_FROM_DAY = 3;          // days into the week (Friday reset = day 0) before an open weekly is worth a DM
const ALERT_EVERY = 12 * 3600000;  // per boss

const methods = {
  async weeklyBoard(now = Date.now()) {
    const H = this.constructor;
    const book = (this.settings.raids = this.settings.raids || { done: {}, tries: {} });
    const hold = new Set(this.settings.raidHold || []);
    const ready = this.ultraReady();
    const key = schedule.periodKey('week', new Date(now));
    // The week began at the Friday reset (midnight US Eastern, 04:00-05:00 UTC).
    const started = Date.parse(`${key.slice(1)}T05:00:00Z`);
    const out = [];
    for (const b of ultraready.BOSSES.filter((x) => x.every === 'week')) {
      const st = ((ready.bosses || {})[b.id]) || {};
      const rec = recipes.active(b.id);
      if (!rec && !st.ready && !(st.withMain && st.withMain.ready)) continue;     // nobody can kill it yet: not a goal this week
      const ids = rec ? rec.seats.map((s) => s.id) : (st.seats || []).map((s) => s.id);
      const main = [...this.bots.values()].find((x) => H.helper(x));
      if (main && !ids.includes(main.id) && st.withMain && st.withMain.ready) ids.push(main.id);
      const members = [];
      for (const id of ids) {
        const bot = this.bot(id);
        if (!bot) continue;
        const aside = !!(bot.client && bot.client._standAsideUntil && bot.client._standAsideUntil > now);
        members.push({ id, guest: H.isGuest(bot), had: await this.raidHad(bot, b, key).catch(() => false), online: !!(bot.running && !bot.paused && bot.serverName), playedByYou: aside });
      }
      const open = members.filter((m) => !m.had);
      const rt = (book.recipeTries || {})[b.id]; const mt = (book.mainTries || {})[b.id]; const tt = (book.tries || {})[b.id];
      const used = Math.max(...[rt, mt, tt].map((t) => (t && t.key === key ? t.n : 0)));
      const cap = H.tryCap(b);
      const blockers = [];
      if (hold.has(b.id)) blockers.push('on raidHold');
      if (this.raidGoldShort && this.raidGoldShort(b.id)) blockers.push('a member lacks the gold for its potions');
      for (const m of open) {
        if (m.playedByYou) blockers.push(`${m.id} is being played by you (it starts ${Math.round((this.settings.ownerLogoutMin || 10))} min after you log out)`);
        else if (!m.online) blockers.push(`${m.id} is offline or stopped`);
      }
      if (used >= cap) blockers.push(`${used}/${cap} tries used this week`);
      if (rec && this._provenNoted && this._provenNoted[b.id] && now - this._provenNoted[b.id] < 2 * 3600000) blockers.push('waiting for its proven line-up to be free');
      out.push({
        boss: b.id, name: b.name, week: key, dayOfWeek: Math.floor((now - started) / DAY), proven: !!rec, booked: book.done[b.id] === key,
        members, open: open.map((m) => m.id), tries: { used, cap }, blockers,
        state: !open.length ? 'done' : blockers.length ? 'blocked' : 'waiting for its turn',
      });
    }
    return out;
  },

  // Every 30 min: a weekly still open from day 3 of its week gets one alert per 12 h with the reason.
  async weeklyTick(now = Date.now()) {
    const board = await this.weeklyBoard(now);
    const sent = (this._weeklyAlert = this._weeklyAlert || {});
    for (const w of board) {
      if (w.state === 'done' || w.dayOfWeek < ALERT_FROM_DAY) continue;
      if (now - (sent[w.boss] || 0) < ALERT_EVERY) continue;
      sent[w.boss] = now;
      const who = w.open.map((id) => { const b = this.bot(id); return (b && b.account && b.account.label) || id; }).join(', ');
      const why = w.blockers.length ? w.blockers.join('; ') : 'no blocker found - it should start by itself';
      this.info(`weekly: ${w.name} still open for ${who} on day ${w.dayOfWeek + 1} of 7 (${why})`);
      this.notify(`${w.name} is still open this week`, `${who} still need the weekly turn-in (day ${w.dayOfWeek + 1} of 7): ${why}`, 'alert');
      if (this.discord && this.discord.enabled) {
        this.discord.send(`⚠️ **${w.name}** is still open this week for ${who} (day ${w.dayOfWeek + 1} of 7)\n${why}`, { kind: 'alert', key: `dm:weekly:${w.boss}`, dm: true });
      }
    }
    return board;
  },
};

module.exports = { methods };
