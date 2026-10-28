// Boost & event watcher. Sources:
//  1. The official Artix calendar (https://www.artix.com/calendar/), which lists every scheduled AQW boost by day:
//     Double EXP / Gold / Rep / Class Points / ALL, Triple, and farming-resource boosts (Legion Token, Void Aura, Spirit
//     Orbs, Blood Gems, …). Scheduled boosts start 12:01 AM EST and last that server day (aq.com/lore/calendar).
//  2. Live server messages in game chat ("Double Legion Tokens for the next hour!") seen by any bot.
// State: <seraph>\boosts.json. The brain and the AI Brain read active() / upcoming().
const path = require('path');
const { P } = require('./paths');
const { readJson, writeJson, serverDay } = require('./util');
let web = null;
try { web = require(require('path').join(process.env.SERAPH_AI_CORE || 'seraph-ai-core', 'web')); } catch (e) { web = null; }
// The laptop has no <ai>: a plain HTTPS GET (with redirects) is all the calendar needs. Without it the boost calendar
// never refreshed there (log: "boosts: refresh failed: <ai>\core is missing").
function httpGet(url, timeoutMs = 30000, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = require('https').get(url, { headers: { 'user-agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume();
        return resolve(httpGet(new URL(res.headers.location, url).toString(), timeoutMs, hops + 1));
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ text }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}
if (!web) web = { fetch: (url, o) => httpGet(url, (o && o.timeoutMs) || 30000) };

const FILE = () => path.join(P.ROOT, 'boosts.json');

// Title → boost kinds. Anything else with "Boost" is a resource boost named by its title.
function classify(title) {
  const t = String(title).toLowerCase();
  const kinds = [];
  if (/double all|triple/.test(t)) kinds.push('exp', 'gold', 'rep', 'cp');
  if (/double (exp|xp)|\bexp\b.*boost|experience/.test(t)) kinds.push('exp');
  if (/double gold/.test(t)) kinds.push('gold');
  if (/double rep|reputation/.test(t)) kinds.push('rep');
  if (/class points?|\bcp\b/.test(t)) kinds.push('cp');
  if (/legion token/.test(t)) kinds.push('legionToken');
  if (/void aura/.test(t)) kinds.push('voidAura');
  if (/dark spirit orb/.test(t)) kinds.push('darkSpiritOrb');
  else if (/spirit orb/.test(t)) kinds.push('spiritOrb');
  if (/blood gem/.test(t)) kinds.push('bloodGem');
  if (/\brib\b|ribs\b/.test(t)) kinds.push('rib');
  if (/metals?\b/.test(t)) kinds.push('metal');
  if (/essence|totem/.test(t)) kinds.push('essenceTotem');
  if (/unidentified/.test(t)) kinds.push('unidentified');
  if (/dungeon/.test(t)) kinds.push('dungeon');
  return [...new Set(kinds)];
}

const LABEL = { exp: '2x XP', gold: '2x Gold', rep: '2x Reputation', cp: '2x Class Points', legionToken: 'Legion Tokens', voidAura: 'Void Auras', spiritOrb: 'Spirit Orbs', darkSpiritOrb: 'Dark Spirit Orbs', bloodGem: 'Blood Gems', rib: 'Ribs', metal: 'Metals', essenceTotem: 'Essences + Totems', unidentified: 'Unidentified items', dungeon: 'Dungeon drops' };

// Parse the fullCalendar `events: [ {title: '...', url: '...', start: 'YYYY-MM-DD'[, end: '...']} ]` block.
function parseCalendar(html) {
  const out = [];
  const re = /\{title: '((?:[^'\\]|\\.)*)',url: '([^']*)'[\s\S]*?start: '([^']*)'(?:,\s*end: '([^']*)')?/g;
  let m;
  while ((m = re.exec(html))) {
    const title = m[1].replace(/\\u0026/g, '&').replace(/\\'/g, "'").replace(/&amp;/g, '&');
    const kinds = /boost/i.test(title) ? classify(title) : [];
    out.push({ date: m[3], end: m[4] || null, title, url: m[2].split("' +")[0], kinds, boost: /boost/i.test(title) && !/break/i.test(title) });
  }
  return out;
}

class Boosts {
  constructor(log) {
    this.log = log || (() => {});
    this.state = readJson(FILE(), { fetchedAt: null, calendar: [], live: [] });
  }
  save() { writeJson(FILE(), this.state); }

  async refresh() {
    const r = await web.fetch('https://www.artix.com/calendar/', { timeoutMs: 30000 });
    const events = parseCalendar(r.text);
    if (!events.length) throw new Error('calendar format changed (no events found)');
    this.state.calendar = events.filter((e) => e.date >= serverDay(new Date(Date.now() - 7 * 86400000)));
    this.state.fetchedAt = new Date().toISOString();
    this.save();
    const today = this.active().map((b) => b.title);
    this.log(`boosts: calendar refreshed (${events.length} entries); today: ${today.join(', ') || 'none'}`);
    return this.state;
  }

  // A server chat message from the game (["server", "-1", "text"] packets). Returns the boost if one was recognised.
  noteServerMessage(text) {
    const t = String(text || '');
    if (!/(double|triple|2x|3x|boost|bonus)/i.test(t)) return null;
    const kinds = classify(t.replace(/2x/ig, 'double').replace(/3x/ig, 'triple'));
    if (!kinds.length) return null;
    const mins = /(\d+)\s*(minute|min)/i.exec(t); const hours = /(\d+)\s*hour/i.exec(t);
    const until = Date.now() + (mins ? Number(mins[1]) * 60000 : hours ? Number(hours[1]) * 3600000 : 3600000);
    const live = { t: Date.now(), until, title: t.slice(0, 160), kinds, source: 'in-game message' };
    this.state.live = (this.state.live || []).filter((x) => x.until > Date.now() && x.title !== live.title).concat(live);
    this.save();
    this.log(`boosts: live boost from server message: ${live.title}`);
    return live;
  }

  active(now = new Date()) {
    const day = serverDay(now);
    const cal = (this.state.calendar || []).filter((e) => e.boost && (e.end ? e.date <= day && day < e.end : e.date === day))
      .map((e) => ({ title: e.title, kinds: e.kinds, source: 'artix calendar', until: 'end of the server day (midnight EST)', url: e.url }));
    const live = (this.state.live || []).filter((x) => x.until > now.getTime())
      .map((x) => ({ title: x.title, kinds: x.kinds, source: x.source, until: new Date(x.until).toISOString() }));
    return cal.concat(live);
  }
  activeKinds(now) { return [...new Set(this.active(now).reduce((a, b) => a.concat(b.kinds), []))]; }
  has(kind, now) { return this.activeKinds(now).includes(kind); }

  upcoming(days = 7, now = new Date()) {
    const today = serverDay(now);
    const last = serverDay(new Date(now.getTime() + days * 86400000));
    return (this.state.calendar || []).filter((e) => e.date > today && e.date <= last).map((e) => ({ date: e.date, title: e.title, kinds: e.kinds, boost: e.boost }));
  }
  events(now = new Date()) {
    const today = serverDay(now);
    return (this.state.calendar || []).filter((e) => !e.boost && e.date <= today && e.date >= serverDay(new Date(now.getTime() - 14 * 86400000)));
  }
  summary(now) {
    const a = this.active(now);
    return { active: a, kinds: this.activeKinds(now), labels: this.activeKinds(now).map((k) => LABEL[k] || k), upcoming: this.upcoming(7, now), recentEvents: this.events(now).map((e) => `${e.date} ${e.title}`), fetchedAt: this.state.fetchedAt };
  }
}

module.exports = { Boosts, classify, parseCalendar, LABEL };
