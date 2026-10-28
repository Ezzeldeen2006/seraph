// Fashion: what each character wants to look like and the time it spends getting it (the owner, 2026-09-24).
//   - The lookbook (data/lookbook.json, built on the PC by tools/lookbook.js) knows every wearable item the Skua
//     library can get: slot, free-player or member, wiki tags, description, pictures, and the route (a merge shop's
//     BuyAllMerge(buyOnlyThis) or a plain shop buy).
//   - Each persona has a `fashion.dream` list, picked by looking at the wiki pictures, in the order it wants them.
//   - "Me time": 1 h a day for its wishes. After that hour the character decides whether to keep going (its vanity
//     and whether the farm is moving), an hour at a time, never past 4 h a day (the owner's hard rule).
'use strict';
const fs = require('fs');
const path = require('path');

const STYLE_BASE_MS = 3600000;         // one hour a day for looks
const STYLE_MAX_MS = 4 * 3600000;      // hard cap: never more than 4 h a day on looks
const EVENT_CAP_H = 2;                 // seasonal events: 2 h a day at most
const WISH_REST_MS = 3 * 86400000;     // a wish that failed twice rests 3 days

let book = null;
function lookbook() {
  if (!book) {
    try { book = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'lookbook.json'), 'utf8')); } catch (e) { book = { items: {} }; }
  }
  return book;
}
// Routes the lookbook build doesn't know yet (data/routes-extra.json, from the wiki) are added on top.
let extra = null;
function extraRoutes() {
  if (!extra) { try { extra = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'routes-extra.json'), 'utf8')); } catch (e) { extra = {}; } }
  return extra;
}
// The wiki names a free copy of an AC item "<name> (0 AC)" or "(Non-AC)"; the game calls it just "<name>", and a look
// must use the game's name or the owned piece is never recognised (Scarlet Sorceress Armor, 2026-10-21).
const WIKI_SUFFIXES = [' (0 ac)', ' (non-ac)'];
function look(name) {
  const key = String(name || '').toLowerCase();
  const items = lookbook().items;
  const it = items[key] || WIKI_SUFFIXES.map((s) => items[key + s]).find(Boolean) || null;
  const add = extraRoutes()[key];
  // An item newer than the lookbook build (Spooky Sleepover PJs, Mogloween 2026) lives in routes-extra.json alone.
  if (!it && Array.isArray(add) && add.length) return { name, free: true, member: false, routes: [...add] };
  if (!it || !Array.isArray(add) || !add.length) return it;
  return { ...it, routes: [...(it.routes || []), ...add] };
}
function reload(data = null, routes = undefined) { book = data; if (routes !== undefined) extra = routes; }   // tests hand in their own lookbook

// How to get an item, best way first: a merge shop (Skua farms the ingredients), a plain shop buy, the quest that
// rewards it, the monster that drops it, a gold shop on its map. A merge script must exist in this machine's Skua
// library (the lookbook is built from the PC's copy). Seasonal routes (route.event, an events.json folder) only count
// while that event is live today (`live` = the brain's day.events); without `live` they all count.
const ORDER = ['merge', 'shop', 'quest', 'mapitem', 'drop', 'shopFind'];
// Staff-birthday folders hold maps that never close again (/join darkwarlegion, templesiege on the wiki, no event
// note), but events.json only calls StaffBirthdays live when the news names it, so their merges never ran.
const ALWAYS_OPEN_MAPS = new Set(['darkwarlegion', 'darkwar', 'templesiege']);
function open(r, live) { return !r.event || !live || live[r.event] === true || ALWAYS_OPEN_MAPS.has(String(r.map || '').toLowerCase()); }
// One key per way of getting things: the same boss, quest or merge script, whatever item it is for.
function routeKey(r) { return `${r.kind}:${r.script || r.map || ''}:${r.monster || r.quest || r.shop || ''}`; }
const ROUTE_REST_MS = 3 * 86400000;   // a route whose fight was too strong rests 3 days
function routes(name, live = null, rested = null) {
  const it = look(name);
  if (!it || it.member || !it.routes || !it.routes.length) return [];
  return it.routes
    .filter((r) => ORDER.includes(r.kind) && (r.kind !== 'merge' || scriptExists(r.script)) && open(r, live)
      && !(rested && rested[routeKey(r)] && Date.now() - rested[routeKey(r)] < ROUTE_REST_MS))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}
function route(name, live = null, rested = null) { return routes(name, live, rested)[0] || null; }
// Does the item come only from events that are all closed right now? (wait for them - no strike)
function waitsForEvent(name, live) {
  const it = look(name);
  return !!(it && it.routes && it.routes.length && live && !routes(name, live).length && it.routes.some((r) => r.event && live[r.event] !== true));
}
const seen = new Map();
function scriptExists(rel) {
  if (!seen.has(rel)) {
    let ok = true;
    try { ok = fs.existsSync(path.join(require('./paths').P.SCRIPTS, ...String(rel).split('/'))); } catch (e) { ok = true; }
    seen.set(rel, ok);
  }
  return seen.get(rel);
}

function taskFor(persona, wish, live = null, rested = null) {
  const r = route(wish.name, live, rested);
  if (!r) return null;
  const limited = r.event && live && live[r.event] === true;
  const why = `me time: ${wish.name} (${wish.slot || look(wish.name).slot}) - ${wish.why || 'I want it'}${limited ? ` [limited: ${r.event} is live]` : ''}`;
  const base = { style: true, wish: wish.name, brain: true, why, ...(r.event ? { wishEvent: r.event } : {}) };
  if (r.kind === 'merge') return { type: 'script', path: r.script, entry: 'BuyAllMerge', args: JSON.stringify(wish.name), ...base };
  if (r.kind === 'shop') return { type: 'buy', shop: r.shop, map: r.map, item: wish.name, qty: 1, ...base };
  return { type: 'wish', route: r, item: wish.name, ...base };
}

// What the character goes for next. Skips owned pieces, pieces with no way to get them, pieces waiting for their
// event, and pieces that just failed twice.
// With main looks (the owner, 2026-10-14: "priortize the looks i said first then when they are done with everything with
// the game make them farm the other looks"):
//   1. the pieces of its main looks (f.dream, in order), a piece from a live event first;
//   2. when no main piece can be farmed now: seasonal wishes from an event that is live today;
//   3. only with opts.free (nothing left to do in the game): the extra looks (f.later), then seasonal ones.
// Without main looks: anything wanted from a live event first, then the dream pieces in order.
async function nextWish(bot, persona, st, live = null, opts = {}) {
  const f = persona && persona.fashion;
  if (!f) return null;
  const fails = st.wishFails || {};
  const ok = async (wish) => {
    const fail = fails[wish.name];
    if (fail && fail.n >= 2 && Date.now() - fail.at < WISH_REST_MS) return false;
    if (!route(wish.name, live, st.routeFails)) return false;
    return !(await bot.owns(wish.name).catch(() => true));
  };
  const liveNow = (wish) => { const r = route(wish.name, live, st.routeFails); return !!(live && r && r.event && live[r.event] === true); };
  if (Array.isArray(f.main) && f.main.length) {
    const pick = async (wishes) => {
      for (const wish of wishes) if (liveNow(wish) && (await ok(wish))) return { ...wish, limited: route(wish.name, live, st.routeFails).event };
      for (const wish of wishes) if (await ok(wish)) return wish;
      return null;
    };
    // A priority look (dreams.json `priority`, the owner 2026-10-19: Nova's N12 from IshidoVI's page, "the highest
    // priority of outfits"): its pieces before every other wish, and the only wish opts.priorityOnly allows (ultra focus).
    // A list is ranked (the owner 2026-10-20: Nova NX2 first, then N12): each look's pieces before the next look's.
    for (const code of [].concat(f.priority || [])) {
      const pri = (f.main || []).concat(f.extra || []).find((m) => m.code === code);
      if (!pri) continue;
      const priNames = new Set([pri.armor, pri.helm, pri.cape, pri.weapon, pri.pet].filter(Boolean).map((x) => String(x).toLowerCase()));
      const first = await pick((f.dream || []).filter((w) => priNames.has(String(w.name).toLowerCase())));
      if (first) return { ...first, main: true, priority: code };
    }
    if (opts.priorityOnly) return null;
    const main = await pick(f.dream || []);
    if (main) return { ...main, main: true };
    if (opts.free) return pick([...(f.later || []), ...(f.seasonal || [])]);
    return pick((f.seasonal || []).filter(liveNow));
  }
  const list = [...(f.dream || []), ...(f.seasonal || [])];
  if (live) {
    for (const wish of list) {
      const r = route(wish.name, live, st.routeFails);
      if (r && r.event && live[r.event] === true && (await ok(wish))) return { ...wish, limited: r.event };
    }
  }
  for (const wish of f.dream || []) if (await ok(wish)) return wish;
  return null;
}

// After each hour of me time: keep going? Vain characters stay longer, but only while the farm is moving, and
// never past 4 h. `usedMs` is today's me time so far.
function keepGoing(persona, usedMs, progressed) {
  if (usedMs >= STYLE_MAX_MS) return { go: false, why: 'the 4 h a day limit' };
  if (!progressed) return { go: false, why: 'the farm is not moving' };
  const vanity = (persona && persona.fashion && persona.fashion.vanity) || 0.3;
  const hours = Math.floor(usedMs / 3600000);            // 1, 2 or 3 hours used
  const need = 0.45 + hours * 0.12;                      // 0.57 after 1 h, 0.69 after 2 h, 0.81 after 3 h
  return vanity >= need ? { go: true, why: `vanity ${vanity} >= ${need.toFixed(2)}` } : { go: false, why: 'endgame first' };
}

// A line in the character's voice, with {item} filled in.
function say(persona, key, item) {
  const lines = (persona && persona.voice && persona.voice[key]) || [];
  const list = Array.isArray(lines) ? lines : [lines];
  if (!list.length) return null;
  const line = list[Math.floor(Math.random() * list.length)];
  return `${persona.name}: "${String(line).replace(/\{item\}/g, item || '')}"`;
}

module.exports = { routeKey, STYLE_BASE_MS, STYLE_MAX_MS, EVENT_CAP_H, lookbook, look, reload, route, routes, waitsForEvent, taskFor, nextWish, keepGoing, say };
