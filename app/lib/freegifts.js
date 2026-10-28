// Free gifts (the owner, 2026-10-05): "make sure that the bots are aware of the AQW birthday event and they claim the free
// acs". Each gift in freegifts.json is a Skua script claimed once while its event is live. "Once" is per version of the
// script: the yearly free-AC script (Other/FreeAcGifts[Yearly]) is rewritten upstream for each year's quest, so a new
// file is a new claim. The scripts check their own requirements (level 20, verified email, already done) and end.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { P } = require('./paths');
const { readJson } = require('./util');

const GIFTS = (readJson(path.join(__dirname, 'freegifts.json'), {}) || {}).gifts || [];
const MAX_TRIES = 2;
// Versions never to run: last year's script asks the server about a quest that is gone, and the server answers by
// disconnecting the account - a relog, a restart of the claim, another kick (2026-10-05, all four for 4 min).
const STALE = new Set((readJson(path.join(__dirname, 'freegifts.json'), {}) || {}).staleVersions || []);

function version(script) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(P.SCRIPTS, script))).digest('hex').slice(0, 16); } catch { return null; }
}

// The quest ids a gift script works on (EnsureAccept/EnsureComplete/isCompletedBefore, or a `questID = n` default).
function questsIn(script, read = (s) => fs.readFileSync(path.join(P.SCRIPTS, s), 'utf8')) {
  let src = '';
  try { src = read(script); } catch { return []; }
  const out = new Set();
  for (const m of src.matchAll(/(?:EnsureAccept|EnsureComplete|isCompletedBefore)\((\d{3,6})\b|questID\s*=\s*(\d{3,6})\b/g)) out.add(Number(m[1] || m[2]));
  return [...out];
}

// `until` is a day of the year ("11-01"): the claim window of THIS year's event. A full date ("2026-11-01") made the
// gift a one-year thing - next year's birthday ACs would have been skipped. A day before the event's first month
// belongs to the next year (Frostvale Dec-Jan: "01-10").
function pastUntil(g, now) {
  if (!g.until) return false;
  if (/^\d{4}-/.test(g.until)) return now >= Date.parse(g.until);
  const [mm, dd] = g.until.split('-').map(Number);
  const d = new Date(now);
  let y = d.getUTCFullYear();
  const start = Number(g.fromMonth || 0);
  if (start && mm < start && d.getUTCMonth() + 1 >= start) y += 1;   // the window runs into next January
  return now >= Date.UTC(y, mm - 1, dd);
}

// The first gift this character should claim now, as a brain task, or null. `events`: the day's live events.
function next(state, { level, events, now = Date.now(), gifts = GIFTS, versionOf = version, questsOf = questsIn } = {}) {
  const got = state.gifts || {};
  for (const g of gifts) {
    if (!events || !events[g.event] || level < (g.minLevel || 1)) continue;
    if (pastUntil(g, now)) continue;
    const v = versionOf(g.script);
    if (!v || STALE.has(v) || (g.stale || []).includes(v)) continue;
    // Still last year's quest (Skua has not rewritten the script for this year): asking the server about a quest that
    // is gone gets the account kicked (2026-10-05), so it waits for the new version.
    const qs = g.staleQuests ? questsOf(g.script) : [];
    if (qs.length && qs.every((q) => g.staleQuests.includes(q))) continue;
    const s = got[g.id];
    // Tries made under the gift's level don't count (2026-10-21: the badge was minLevel 1, and the level-2 Vexa and
    // Edda used theirs up dying to Birthday Cake). A record from before levels were kept counts only if it worked.
    const under = !!(s && Number(g.minLevel) > 1 && (s.lvl == null ? !s.ok : s.lvl < g.minLevel));
    // Starts count, not only endings: a claim cut short by a disconnect never reaches ended().
    if (s && s.v === v && !under && (s.ok || Math.max(s.tries || 0, s.starts || 0) >= MAX_TRIES)) continue;
    return { type: 'script', path: g.script, gift: g.id, giftV: v, giftLvl: level, ...(under ? { giftFresh: true } : {}), brain: true, why: `${g.event} is live - claiming the free gift: ${g.label}` };
  }
  return null;
}

// The claim is starting (not in a dry run).
function began(state, task, now = Date.now()) {
  if (!task || !task.gift) return;
  const got = (state.gifts = state.gifts || {});
  const s = got[task.gift] && got[task.gift].v === task.giftV && !task.giftFresh ? got[task.gift] : { v: task.giftV, tries: 0, starts: 0 };
  if (task.giftLvl) s.lvl = task.giftLvl;
  s.starts = (s.starts || 0) + 1;
  s.startedAt = new Date(now).toISOString();
  got[task.gift] = s;
}

// The claim ended: done for this version, or one more failed try.
function ended(state, task, ok, now = Date.now()) {
  if (!task || !task.gift) return;
  const got = (state.gifts = state.gifts || {});
  const s = got[task.gift] && got[task.gift].v === task.giftV ? got[task.gift] : { v: task.giftV, tries: 0 };
  if (task.giftLvl) s.lvl = task.giftLvl;
  s.tries = (s.tries || 0) + 1;
  s.ok = !!ok;
  s.at = new Date(now).toISOString();
  got[task.gift] = s;
}

// Scripts in the Skua library that look like a free-AC claim and are not in freegifts.json yet (the owner 2026-10-13: "their
// only way is free acs that aqw gives so make sure they never miss those"). The hub DMs the owner about each new one, so a
// claim nobody listed is added the same day. Spenders (spins, donations, checkers) are left out.
const FREE_RE = /free\s*ac|ac'?s?\b[^\n]{0,30}\bfree|free[^\n]{0,30}\bacs?\b|participation/i;
const NOT_RE = /waste|spam|donat|generosity|checker|check for|spend/i;
const NOT_GIFTS = (readJson(path.join(__dirname, 'freegifts.json'), {}) || {}).notGifts || [];
function discover(root = P.SCRIPTS, gifts = GIFTS, notGifts = NOT_GIFTS) {
  const known = new Set([...gifts.map((g) => g.script), ...notGifts].map((s) => s.toLowerCase()));
  const out = [];
  const walk = (dir, depth) => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { if (depth < 3 && !/^(\.git|Cached-Scripts|Templates)$/i.test(d.name)) walk(full, depth + 1); continue; }
      if (!d.name.endsWith('.cs')) continue;
      let head = '';
      try { head = fs.readFileSync(full, 'utf8').slice(0, 600); } catch { continue; }
      const m = /\/\*([\s\S]*?)\*\//.exec(head);
      const about = `${d.name} ${m ? m[1] : ''}`;
      if (!FREE_RE.test(about) || NOT_RE.test(about)) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (known.has(rel.toLowerCase())) continue;
      const name = (/name:\s*(.*)/i.exec(about) || [])[1];
      out.push({ script: rel, name: name ? name.trim() : d.name, version: version(rel) });
    }
  };
  for (const top of ['Other', 'Seasonal', 'Dailies']) walk(path.join(root, top), 0);
  return out;
}

module.exports = { GIFTS, next, began, ended, version, questsIn, pastUntil, discover };
