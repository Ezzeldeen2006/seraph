// The ledger: one place per character for what the brain has tried and what came of it (audit A5, 2026-09-28).
// accounts/<id>/ledger.json, written atomically.
//
//   items   per work item (bot.taskKey): the last attempts (outcome, minutes, items, quests, XP, deaths, step), the hold
//           that keeps it from being picked (until, why) and the wall that blocks it, if one is known.
//   walls   per boss or step that stops work (Phase 4 fills in HP, kills, the plan).
//   routes  per route (goal, script, grind): minutes, XP, items, deaths - measured XP/h for the planner (Phase 5).
//
// Before, the holds lived in memory only (bot.skipped), so every restart retried every wall at once, and nothing
// remembered that a script had finished ten times in a row without gaining anything (fj-cryomancer: 183 starts for
// 0.8 h). The brain still decides from brain.json; the ledger is the memory underneath: holds that survive restarts,
// the back-off for work that makes no progress, and the reasons the dashboard shows.
'use strict';
const path = require('path');
const { readJson, writeJson, serverDay } = require('./util');

const KEEP_ATTEMPTS = 20;
const BACKOFF_BASE_MS = 30 * 60000;     // second attempt in a row with nothing gained: 30 min, then 1 h, 2 h ... 24 h
const BACKOFF_MAX_MS = 24 * 3600000;
const HOLD_KEEP_MS = 7 * 24 * 3600000;  // expired holds are dropped after a week

class Ledger {
  constructor(file) {
    this.file = file;
    this.data = readJson(file, null) || { v: 1, items: {}, walls: {}, routes: {}, createdAt: Date.now() };
    for (const k of ['items', 'walls', 'routes', 'xpDays', 'xpTable']) this.data[k] = this.data[k] || {};
    this._saveTimer = null;
    this._slowTimer = null;
  }

  // XP per server day (every addGoldExp, lib/bot.js), for the ETA to level 100 (lib/eta.js). Kept 30 days.
  addXp(n, day = serverDay()) {
    if (!(n > 0)) return;
    this.data.xpDays[day] = (this.data.xpDays[day] || 0) + n;
    this.saveSlow();
  }
  // The XP a level costs, from the levelUp packet (intExpToLevel of the new level).
  levelCost(level, xp) {
    if (!(level > 0 && xp > 0)) return;
    this.data.xpTable[level] = xp;
    this.saveSlow();
  }
  // Counters that change every kill: written at most once a minute.
  saveSlow() {
    if (this._slowTimer || this._saveTimer) return;
    this._slowTimer = setTimeout(() => { this._slowTimer = null; this.flush(); }, 60000);
    if (this._slowTimer.unref) this._slowTimer.unref();
  }

  static forBot(bot) {
    if (!bot._ledger) bot._ledger = new Ledger(path.join(bot.dir || require('./paths').P.account(bot.id), 'ledger.json'));
    return bot._ledger;
  }

  item(key, label) {
    const it = this.data.items[key] || (this.data.items[key] = { key, attempts: [], nothingRun: 0 });
    if (label) it.label = label;
    return it;
  }

  // One finished (or stopped) try: outcome 'progress' | 'nothing' | 'done' | 'failed' | 'stopped' | 'parked'.
  attempt(key, a, label) {
    const it = this.item(key, label);
    const rec = { at: a.at || Date.now(), minutes: Math.round(((a.minutes || 0)) * 10) / 10, outcome: a.outcome };
    for (const k of ['items', 'quests', 'xp', 'kills', 'deaths', 'step', 'why']) if (a[k] !== undefined && a[k] !== null && a[k] !== 0 && a[k] !== '') rec[k] = a[k];
    it.attempts.push(rec);
    if (it.attempts.length > KEEP_ATTEMPTS) it.attempts.splice(0, it.attempts.length - KEEP_ATTEMPTS);
    if (a.outcome === 'nothing') it.nothingRun = (it.nothingRun || 0) + 1;
    else if (a.outcome === 'progress' || a.outcome === 'done') it.nothingRun = 0;
    it.lastAt = rec.at;
    if (a.route) this.route(a.route, a);
    this.save();
    return it;
  }

  // Back-off for work that ends without gaining anything: none for the first, then 30 min doubling to 24 h.
  static backoffMs(run) { return run < 2 ? 0 : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, run - 2)); }

  hold(key, until, why, wall) {
    const it = this.item(key);
    it.hold = { until, why: why || null, at: Date.now() };
    if (wall) it.wall = wall;
    this.save();
  }
  release(key) { const it = this.data.items[key]; if (it && it.hold) { delete it.hold; this.save(); } }
  releaseAll() { for (const it of Object.values(this.data.items)) delete it.hold; this.save(); }
  held(key, now = Date.now()) { const it = this.data.items[key]; return it && it.hold && it.hold.until > now ? it.hold : null; }
  holds(now = Date.now()) {
    const out = new Map();
    for (const [k, it] of Object.entries(this.data.items)) if (it.hold && it.hold.until > now) out.set(k, it.hold.until);
    return out;
  }

  route(key, a) {
    const r = this.data.routes[key] || (this.data.routes[key] = { minutes: 0, xp: 0, items: 0, quests: 0, deaths: 0, runs: 0 });
    r.minutes += a.minutes || 0; r.xp += a.xp || 0; r.items += a.items || 0; r.quests += a.quests || 0; r.deaths += a.deaths || 0; r.runs++;
    r.lastAt = Date.now();
    r.xpPerHour = r.minutes > 0 ? Math.round(r.xp / (r.minutes / 60)) : 0;
    return r;
  }

  wall(name, patch = {}) {
    const w = this.data.walls[name] || (this.data.walls[name] = { name, firstAt: Date.now(), deaths: 0, stops: 0, blocks: [] });
    Object.assign(w, patch, { lastAt: Date.now() });
    return w;
  }

  // What the dashboard shows: work on hold now, with why and until; the last attempts of each.
  summary(now = Date.now()) {
    const held = [];
    for (const it of Object.values(this.data.items)) {
      if (!it.hold || it.hold.until <= now) continue;
      held.push({ key: it.key, label: it.label || Ledger.labelOf(it.key), until: it.hold.until, why: it.hold.why, wall: it.wall || null, last: it.attempts.slice(-3) });
    }
    held.sort((a, b) => a.until - b.until);
    const routes = Object.entries(this.data.routes).map(([k, r]) => ({ route: k, ...r })).filter((r) => r.minutes >= 10).sort((a, b) => b.xpPerHour - a.xpPerHour);
    return { held, routes: routes.slice(0, 15) };
  }

  // A readable name for a bot.taskKey ("type|path|entry|args|name|goal|event") or a "goal:x" / "rank:x" key.
  static labelOf(key) {
    const k = String(key || '');
    if (/^(goal|rank|wish):/.test(k)) return k.replace(/^goal:/, '').replace(/^rank:/, 'rank up ').replace(/^wish:/, 'me time: ');
    const [type, p, entry, , name, goal, event] = k.split('|');
    const file = p ? p.split(/[\\/]/).pop().replace(/\.cs$/, '') : '';
    const script = file ? `${file}${entry ? ` · ${entry}` : ''}` : '';
    return goal || name || event || script || type || k;
  }

  // Old attempts and long-expired holds go; a week of history is plenty.
  prune(now = Date.now()) {
    const days = Object.keys(this.data.xpDays || {}).sort();
    for (const d of days.slice(0, Math.max(0, days.length - 30))) delete this.data.xpDays[d];
    for (const [k, it] of Object.entries(this.data.items)) {
      if (it.hold && it.hold.until < now - HOLD_KEEP_MS) delete it.hold;
      if (!it.hold && (it.lastAt || 0) < now - 4 * HOLD_KEEP_MS) delete this.data.items[k];
    }
  }

  // Written at most once a second: attempts come in bursts (a watchdog restart books several things at once).
  save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => this.flush(), 1000);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }
  flush() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    try { this.prune(); writeJson(this.file, this.data); } catch (e) { /* the next save tries again */ }
  }

  // First load: the parks already in brain.json become holds with their reasons, so the dashboard explains them.
  migrate(brainState, now = Date.now()) {
    if (this.data.migratedAt) return 0;
    let n = 0;
    const st = brainState || {};
    for (const [goal, fails] of Object.entries(st.goalFails || {})) {
      const at = (st.goalFailAt || {})[goal] || now;
      if (fails >= 3 && at + 24 * 3600000 > now) { this.item(`goal:${goal}`, goal).hold = { until: at + 24 * 3600000, why: `${fails} failed tries (brain.json)`, at }; n++; }
    }
    for (const [cls, f] of Object.entries(st.rankFails || {})) {
      if (f && f.n >= 2 && f.at + 24 * 3600000 > now) { this.item(`rank:${cls}`, `rank up ${cls}`).hold = { until: f.at + 24 * 3600000, why: `${f.n} failed rank-ups (brain.json)`, at: f.at }; n++; }
    }
    for (const [wish, f] of Object.entries(st.wishFails || {})) {
      if (f && f.n >= 2 && f.at + 3 * 24 * 3600000 > now) { this.item(`wish:${wish}`, `me time: ${wish}`).hold = { until: f.at + 3 * 24 * 3600000, why: f.season ? 'out of season (brain.json)' : `${f.n} tries without it (brain.json)`, at: f.at }; n++; }
    }
    this.data.migratedAt = now;
    this.save();
    return n;
  }
}

// bot.skipped with memory: the same Map interface everything already uses (set / get / has / delete / clear), kept in
// the ledger so a restart no longer forgets which work was resting and why.
class Holds extends Map {
  constructor(ledger, now = Date.now()) {
    super();
    this.ledger = ledger;
    for (const [k, until] of ledger.holds(now)) super.set(k, until);
    this.why = null;   // set just before set() to record a reason: bot.skipped.why = '...'; bot.skipped.set(k, t)
  }
  set(k, until) {
    super.set(k, until);
    if (this.ledger) this.ledger.hold(k, until, this.why);
    this.why = null;
    return this;
  }
  delete(k) { const had = super.delete(k); if (this.ledger) this.ledger.release(k); return had; }
  clear() { for (const k of [...this.keys()]) if (this.ledger) this.ledger.release(k); super.clear(); }
}

module.exports = { Ledger, Holds, BACKOFF_BASE_MS, BACKOFF_MAX_MS };
