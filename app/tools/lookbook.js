// Lookbook builder (runs on the PC; the bots only read its output, data/lookbook.json).
//   node tools/lookbook.js catalog   every item the Skua library can get: merge shops (BuyAllMerge(buyOnlyThis)) and
//                                    plain shop buys (Core.BuyItem(map, shop, item))
//   node tools/lookbook.js wiki      the AQW wiki page of each item: slot, member-only, AC, price, description, tags
//                                    and the male / female pictures (cached; about one page a second)
//   node tools/lookbook.js build     joins both into data/lookbook.json
// No model runs anywhere: what each character likes was chosen by looking at the pictures (personas.js `dream`),
// and everything else is scored from the wiki's tags, name and description (lib/stylist.js).
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const SCRIPTS = process.env.SERAPH_SCRIPTS || require('path').join(require('os').homedir(), 'seraph', 'Scripts');
const WORK = process.env.LOOKBOOK_WORK || require('path').join(require('os').homedir(), 'seraph', 'lookbook');
const CACHE = path.join(WORK, 'wiki');
const OUT = path.join(__dirname, '..', 'data', 'lookbook.json');

const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.cs')) out.push(p);
  }
  return out;
}

function catalog() {
  const items = new Map();
  const add = (name, route, id) => {
    const key = name.toLowerCase();
    const it = items.get(key) || { name, id: id || null, routes: [] };
    if (id && !it.id) it.id = id;
    if (!it.routes.some((r) => JSON.stringify(r) === JSON.stringify(route))) it.routes.push(route);
    items.set(key, it);
  };
  for (const file of walk(SCRIPTS)) {
    const rel = path.relative(SCRIPTS, file).replace(/\\/g, '/');
    if (rel.startsWith('Tools/')) continue;
    const src = fs.readFileSync(file, 'utf8');
    const merge = /StartBuyAllMerge\(\s*"([^"]+)"\s*,\s*(\d+)/.exec(src);
    if (merge && /public void BuyAllMerge\(\s*string\?\s*buyOnlyThis/.test(src)) {
      const re = /new Option<bool>\(\s*"(\d+)"\s*,\s*"((?:[^"\\]|\\.)+)"/g;
      let m;
      while ((m = re.exec(src))) add(m[2].replace(/\\"/g, '"'), { kind: 'merge', script: rel, map: merge[1], shop: Number(merge[2]) }, Number(m[1]));
    }
    const buy = /Core\.BuyItem\(\s*"([a-z0-9-]+)"\s*,\s*(\d+)\s*,\s*"((?:[^"\\]|\\.)+)"/g;
    let b;
    while ((b = buy.exec(src))) add(b[3], { kind: 'shop', map: b[1], shop: Number(b[2]) });
  }
  const list = [...items.values()].sort((a, b) => a.name.localeCompare(b.name));
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, 'catalog.json'), JSON.stringify(list, null, 1));
  console.log(`catalog: ${list.length} items, ${list.filter((i) => i.routes.some((r) => r.kind === 'merge')).length} from merge shops`);
  return list;
}

function get(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'user-agent': 'Mozilla/5.0 (Seraph lookbook; one page a second)' }, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) { res.resume(); return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (html) => html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ');

const SLOTS = { armor: 'armor', class: 'armor', helm: 'helm', cape: 'cape', pet: 'pet', sword: 'weapon', dagger: 'weapon', staff: 'weapon', axe: 'weapon', mace: 'weapon', polearm: 'weapon', gun: 'weapon', handgun: 'weapon', rifle: 'weapon', bow: 'weapon', wand: 'weapon', gauntlet: 'weapon', whip: 'weapon', scythe: 'weapon' };

function parse(html) {
  const s = html.toString('utf8');
  const content = (/id="page-content"([\s\S]*?)id="page-info/.exec(s) || [null, ''])[1];
  if (!content || /This page doesn't exist yet/.test(content)) return null;
  const tags = [...s.matchAll(/page-tags\/tag\/([^"#]+)#pages/g)].map((m) => decodeURIComponent(m[1]).toLowerCase());
  const body = text(content);
  const field = (name) => { const m = new RegExp(`${name}:\\s*([^\\n]+)`, 'i').exec(body); return m ? m[1].trim() : null; };
  // Tag icons (seasonal, AC, legend, rare...) sit next to the pictures: only the item renders count.
  const imgs = [...content.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/wikidot\.com\/common|\/image-tags\/|icon|badge|\/local--files\/[^"]*(?:ac|legend|rare|seasonal|special)[^"]*\.png/i.test(u));
  const both = /\bMale\b/.test(body) && /\bFemale\b/.test(body) && imgs.length >= 2;
  const slotTag = tags.find((t) => SLOTS[t]);
  return {
    tags,
    slot: slotTag ? SLOTS[slotTag] : null,
    type: slotTag || null,
    member: tags.includes('legend') && !tags.includes('freeplayer'),
    free: tags.includes('freeplayer'),
    ac: tags.includes('ac'),
    location: field('Location'),
    price: field('Price'),
    rarity: field('Rarity'),
    level: field('Base Level') || field('Level'),
    desc: (field('Description') || '').slice(0, 300),
    img: both ? { m: imgs[0], f: imgs[1] } : imgs.length ? { any: imgs[0] } : null,
    title: ((/<div id="page-title">\s*([\s\S]*?)\s*<\/div>/.exec(s) || [])[1] || '').replace(/&#039;|&#39;/g, "'").replace(/&amp;/g, '&').trim() || null,
    how: how(body),
  };
}

// How the item is obtained, from the page text: the maps/shops it is listed at, the monsters that drop it, the
// quest it is a reward of, and its price. Wiki formats: "Location(s): <Shop> - <Map>" or map lines, "Price: N/A
// (Dropped by X (Level 25))", "Dropped by:" + monster lines, "Reward from the 'Q' quest.", "Price: 50,000 Gold".
function how(body) {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const idx = (re) => lines.findIndex((l) => re.test(l));
  const stop = /^(Price|Sellback|Rarity|Base Level|Base Damage|Description|Merge the following|Dropped by|Notes?|Thanks|Male|Female|Also see|Reward from)\b/i;
  const until = (from) => { const out = []; for (let i = from; i < lines.length; i++) { if (stop.test(lines[i])) break; out.push(lines[i]); } return out; };
  const loc = idx(/^Locations?:/i);
  const locations = loc < 0 ? [] : [lines[loc].replace(/^Locations?:\s*/i, '')].filter(Boolean).concat(until(loc + 1))
    .map((l) => l.replace(/\s*\(Location\)\s*$/i, '').trim()).filter(Boolean).slice(0, 12);
  const drops = [];
  const inline = /Dropped by\s+([^()\n]+?)\s*(?:\(Level[^)]*\))?\s*\)/i.exec(body);
  if (inline) drops.push(inline[1].trim());
  const dl = idx(/^Dropped by:?$/i);
  if (dl >= 0) for (const l of until(dl + 1)) drops.push(l.replace(/\s*\(.*$/, '').trim());
  const quest = ((/Reward from the '(.+?)' quest/i.exec(body) || [])[1] || '').replace(/\s+/g, ' ').trim() || null;
  // The price is on the "Price:" line, or on the next one when that line is empty (never the Sellback line).
  const pi = idx(/^Price:/i);
  const pt = pi < 0 ? '' : /^Price:\s*$/i.test(lines[pi]) && !/^Sellback/i.test(lines[pi + 1] || '') ? lines[pi + 1] || '' : lines[pi];
  const gold = (/([\d,]+)\s*Gold/i.exec(pt) || [])[1];
  const ac = (/([\d,]+)\s*AC\b/.exec(pt) || [])[1];
  const mg = idx(/^Merge the following:?/i);
  return {
    locations, drops: [...new Set(drops.filter(Boolean))].slice(0, 12), quest,
    gold: gold ? Number(gold.replace(/,/g, '')) : null, acPrice: ac ? Number(ac.replace(/,/g, '')) : null,
    merge: mg < 0 ? [] : until(mg + 1).slice(0, 8),
  };
}

// The item's page. Names shared by several items live under "<name> (Armor)" style pages: try those after the plain one.
async function wikiOne(name) {
  const base = slug(name);
  const file = path.join(CACHE, `${base}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  let found = null;
  for (const s of [base, `${base}-armor`, `${base}-class`, `${base}-helm`, `${base}-cape`, `${base}-pet`]) {
    const res = await get(`http://aqwwiki.wikidot.com/${s}`).catch(() => null);
    await sleep(650);
    if (!res || res.status !== 200) continue;
    const p = parse(res.body);
    if (p) { found = { page: s, ...p }; break; }
    if (s === base && !/doesn't exist/.test(res.body.toString('utf8'))) break;   // a real page we couldn't read
  }
  fs.writeFileSync(file, JSON.stringify(found));
  return found;
}

// Pages from the wiki's own tag lists (todo-pages.json: [slug, name]): every free-player wearable the Skua library
// never mentions - monster drops, quest rewards, event shops, birthday and seasonal items.
const PAGES = path.join(WORK, 'pages');
async function pages() {
  fs.mkdirSync(PAGES, { recursive: true });
  // "deleted:<page>" pages are gone from the wiki (and a ':' makes an NTFS stream, not a file).
  const list = JSON.parse(fs.readFileSync(path.join(WORK, 'todo-pages.json'), 'utf8')).filter(([pg]) => !pg.includes(':'));
  let n = 0; let hit = 0; let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const [pg] = list[next++];
      const file = path.join(PAGES, `${pg}.json`);
      if (!fs.existsSync(file)) {
        const res = await get(`http://aqwwiki.wikidot.com/${pg}`).catch(() => null);
        await sleep(650);
        const p = res && res.status === 200 ? parse(res.body) : null;
        fs.writeFileSync(file, JSON.stringify(p ? { page: pg, ...p } : null));
      }
      n++;
      if (n % 200 === 0) console.log(`${new Date().toISOString()} ${n}/${list.length}`);
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.LOOKBOOK_WORKERS || 4) }, worker));
  console.log(`pages: ${n}/${list.length}`);
}

async function wiki() {
  fs.mkdirSync(CACHE, { recursive: true });
  const list = JSON.parse(fs.readFileSync(path.join(WORK, 'catalog.json'), 'utf8'));
  let n = 0; let hit = 0; let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const it = list[next++];
      const w = await wikiOne(it.name).catch((e) => { console.log(`! ${it.name}: ${e.message}`); return null; });
      n++; if (w) hit++;
      if (n % 100 === 0) console.log(`${new Date().toISOString()} ${n}/${list.length} (${hit} pages)`);
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.LOOKBOOK_WORKERS || 3) }, worker));
  console.log(`wiki: ${hit}/${n} pages`);
}

// What the Skua library knows about quests, monsters and shops, so a wiki "Dropped by X" or "Reward from the 'Q'
// quest" turns into something a bot can run:
//   quests[id]   = { kind: 'quest', quest, map, monsters } (Story.KillQuest) or { kind: 'mapitem', quest, map, items, qty }
//   monsters[nm] = [{ map, cell, pad }] (Core.HuntMonster / Core.KillMonster / Story.KillQuest)
//   shops[map]   = [shop ids] (BuyItem / GetShopItems / LoadShop / StartBuyAllMerge)
function skuaIndex() {
  const quests = {}; const monsters = {}; const shops = {}; const maps = new Set(); const itemFrom = {};
  const mapId = (m) => String(m).toLowerCase().replace(/-\d+$/, '');
  const addMon = (name, map, cell = null, pad = null) => {
    if (!name || name === '*') return;
    const k = name.toLowerCase();
    const list = monsters[k] = monsters[k] || [];
    if (!list.some((x) => x.map === map)) list.push({ map, cell, pad });
    maps.add(map);
  };
  const strs = (arg) => (arg.startsWith('"') ? [arg.slice(1, -1)] : [...arg.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  for (const file of walk(SCRIPTS)) {
    const rel = path.relative(SCRIPTS, file).replace(/\\/g, '/');
    if (rel.startsWith('Tools/')) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/Story\.KillQuest\(\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(new\s*(?:string)?\s*\[\]\s*\{[^}]*\}|"[^"]+")/g)) {
      const map = mapId(m[2]); const mons = strs(m[3]);
      if (!quests[m[1]]) quests[m[1]] = { kind: 'quest', quest: Number(m[1]), map, monsters: mons };
      for (const x of mons) addMon(x, map);
    }
    for (const m of src.matchAll(/Story\.MapItemQuest\(\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(new\s*(?:int)?\s*\[\]\s*\{[^}]*\}|\d+)\s*(?:,\s*(\d+))?/g)) {
      if (!quests[m[1]]) quests[m[1]] = { kind: 'mapitem', quest: Number(m[1]), map: mapId(m[2]), items: (m[3].match(/\d+/g) || []).map(Number), qty: Number(m[4]) || 1 };
      maps.add(mapId(m[2]));
    }
    // HuntMonster(map, monster, item) / KillMonster(map, cell, pad, monster, item) also say where an item drops.
    const addItem = (item, map, monster, cell = null, pad = null) => {
      if (!item || !monster || monster === '*') return;
      const k = item.toLowerCase();
      if (!itemFrom[k]) itemFrom[k] = { map, monster, cell, pad };
    };
    for (const m of src.matchAll(/Core\.HuntMonster\(\s*"([^"]+)"\s*,\s*"([^"]+)"(?:\s*,\s*"([^"]+)")?/g)) { addMon(m[2], mapId(m[1])); addItem(m[3], mapId(m[1]), m[2]); }
    for (const m of src.matchAll(/Core\.KillMonster\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"(?:\s*,\s*"([^"]+)")?/g)) { addMon(m[4], mapId(m[1]), m[2], m[3]); addItem(m[5], mapId(m[1]), m[4], m[2], m[3]); }
    for (const m of src.matchAll(/(?:BuyItem|GetShopItems|LoadShop|StartBuyAllMerge)\(\s*"([a-z0-9-]+)"\s*,\s*(\d+)/g)) {
      const map = mapId(m[1]); const list = shops[map] = shops[map] || [];
      if (!list.includes(Number(m[2]))) list.push(Number(m[2]));
      maps.add(map);
    }
    for (const m of src.matchAll(/Core\.Join\(\s*"([a-z0-9-]+)"/g)) maps.add(mapId(m[1]));
  }
  return { quests, monsters, shops, maps, itemFrom };
}

// Which seasonal event a map or a script belongs to (knowledge/events.json: folder, months, maps, scripts).
function eventIndex() {
  let events = [];
  try { events = JSON.parse(fs.readFileSync(path.join(process.env.SERAPH_ROOT || path.join(require('os').homedir(), 'seraph'), 'knowledge', 'events.json'), 'utf8')); } catch (e) { events = []; }
  const byMap = {};
  for (const e of events) for (const m of e.maps || []) if (!byMap[m]) byMap[m] = e.folder;
  return { byMap, ofScript: (rel) => ((/^Seasonal\/([^/]+)\//.exec(rel || '') || [])[1] || null), months: Object.fromEntries(events.map((e) => [e.folder, e.months])) };
}

function build() {
  const list = JSON.parse(fs.readFileSync(path.join(WORK, 'catalog.json'), 'utf8'));
  const idx = skuaIndex();
  const ev = eventIndex();
  // Quest rewards straight from the game's quest data (Skua's QuestData.json): reward name -> quest ids.
  const rewardOf = {};
  const questById = {};
  try {
    for (const q of JSON.parse(fs.readFileSync(path.join(SCRIPTS, 'QuestData.json'), 'utf8'))) {
      questById[q.ID] = q;
      for (const r of [...(q.Rewards || []), ...(q.SimpleRewards || [])]) {
        const n = String(r.sName || r.Name || '').toLowerCase();
        if (n && !(rewardOf[n] = rewardOf[n] || []).some((x) => x[0] === q.ID)) rewardOf[n].push([q.ID, Number(r.ItemID || r.ID) || null]);
      }
    }
  } catch (e) { console.log(`no QuestData.json: ${e.message}`); }
  const squash = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const mapBySquash = {};
  for (const m of idx.maps) mapBySquash[squash(m)] = m;
  const mapOf = (loc) => mapBySquash[squash(String(loc).split(' - ').pop())] || null;
  const tagsOf = (w) => w.tags.filter((t) => !/^_|^(armor|helm|cape|pet|mergereward|shopitem|freeplayer|legend|ac|drop|questreward)$/.test(t));

  // Routes for an item the Skua library doesn't sell or merge: its quest, the monsters that drop it, or a gold shop.
  function routesFor(name, w) {
    const h = w.how || {};
    const out = [];
    for (const [qid, itemId] of rewardOf[name.toLowerCase()] || []) {
      if (out.length >= 2) break;
      const q = idx.quests[qid];
      if (q) { out.push({ ...q, rewardId: itemId }); continue; }
      // Not in a Skua story: route it by its requirements, when Skua knows where each one drops (HuntMonster item).
      const qd = questById[qid];
      if (!qd || qd.Upgrade) continue;
      const reqs = qd.Requirements || [];
      const src = reqs.map((r) => idx.itemFrom[String(r.sName || r.Name || '').toLowerCase()]);
      if (!reqs.length || src.some((x) => !x) || new Set(src.map((x) => x.map)).size > 1) continue;
      out.push({ kind: 'quest', quest: Number(qid), map: src[0].map, monsters: src.map((x) => x.monster), rewardId: itemId });
    }
    const locMaps = (h.locations || []).map(mapOf).filter(Boolean);
    for (const mon of h.drops || []) {
      const at = idx.monsters[mon.toLowerCase()] || [];
      const pick = at.find((x) => locMaps.includes(x.map)) || at[0] || (locMaps[0] ? { map: locMaps[0], cell: null, pad: null } : null);
      if (pick && out.filter((r) => r.kind === 'drop').length < 2) out.push({ kind: 'drop', map: pick.map, cell: pick.cell, pad: pick.pad, monster: mon });
    }
    if (h.gold && !h.acPrice) {
      for (const m of new Set(locMaps)) if (idx.shops[m]) out.push({ kind: 'shopFind', map: m, shops: idx.shops[m].slice(0, 12), gold: h.gold });
    }
    return out;
  }
  const withEvent = (r) => ({ ...r, event: (r.script && ev.ofScript(r.script)) || ev.byMap[r.map] || null });

  const items = {};
  const add = (name, id, w, routes) => {
    items[name.toLowerCase()] = {
      name, id: id || null, slot: w.slot, type: w.type, free: w.free, member: w.member, ac: w.ac, rarity: w.rarity,
      desc: String(w.desc || '').slice(0, 220), tags: tagsOf(w), img: w.img, seasonal: w.tags.includes('seasonal'),
      routes: routes.map(withEvent),
    };
  };
  for (const it of list) {
    const f = path.join(CACHE, `${slug(it.name)}.json`);
    const w = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    if (!w || !w.slot) continue;   // only things you can wear
    add(it.name, it.id, w, it.routes);
  }
  // The wiki's own list of free-player wearables (tools: tags.json -> todo-pages.json -> pages).
  let extra = 0;
  if (fs.existsSync(PAGES)) {
    for (const f of fs.readdirSync(PAGES)) {
      let w = null;
      try { w = JSON.parse(fs.readFileSync(path.join(PAGES, f), 'utf8')); } catch (e) { continue; }
      if (!w || !w.slot || !w.free || w.member) continue;
      const name = (w.title || '').replace(/\s*\((Armor|Class|Helm|Cape|Pet|Weapon|Sword|Dagger)\)\s*$/i, '');
      if (!name || items[name.toLowerCase()]) continue;
      add(name, null, w, routesFor(name, w));
      extra++;
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), items }));
  const v = Object.values(items);
  const kinds = {};
  for (const it of v) for (const r of it.routes) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  console.log(`lookbook: ${v.length} wearable items (${v.filter((i) => i.free).length} free-player, ${extra} from the wiki's own lists, ${v.filter((i) => i.seasonal).length} seasonal) -> ${OUT}`);
  console.log(`  with a route: ${v.filter((i) => i.routes.length).length} · routes by kind ${JSON.stringify(kinds)} · on an event map: ${v.filter((i) => i.routes.some((r) => r.event)).length}`);
}

// Candidates for one character to look at: free-player items with a route and a picture, ranked by its taste words,
// the best of each slot plus some unmatched rare armors (so it can fall for something unexpected).
function shortlist(id) {
  const personas = require('../lib/personas');
  const stylist = require('../lib/stylist');
  const p = personas.get(id);
  const g = p.sex === 'female' ? 'f' : 'm';
  const book = JSON.parse(fs.readFileSync(OUT, 'utf8')).items;
  const t = stylist.taste(p);
  const rank = (it) => {
    const all = `${it.name} ${it.tags.join(' ')} ${it.desc}`.toLowerCase();
    if (t.veto.some((v) => all.includes(v))) return -1;
    return t.love.reduce((s, k) => s + (all.includes(k) ? 1 : 0), 0) - t.avoid.reduce((s, k) => s + (all.includes(k) ? 1 : 0), 0);
  };
  const pool = Object.values(book).filter((it) => it.free && !it.member && it.img && it.routes && it.routes.length);
  const want = { armor: 90, helm: 35, cape: 35, weapon: 35, pet: 15 };
  const out = [];
  for (const [slot, n] of Object.entries(want)) {
    const list = pool.filter((it) => it.slot === slot).map((it) => ({ it, s: rank(it) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, n);
    for (const { it, s } of list) out.push({ name: it.name, slot, score: s, tags: it.tags, desc: it.desc, rarity: it.rarity, ac: it.ac, img: it.img[g] || it.img.any || it.img.m, route: it.routes[0] });
  }
  const rare = pool.filter((it) => it.slot === 'armor' && rank(it) === 0 && /rare|legendary|epic|awesome|seasonal/i.test(it.rarity || '')).slice(0, 40);
  for (const it of rare) out.push({ name: it.name, slot: 'armor', score: 0, wildcard: true, tags: it.tags, desc: it.desc, rarity: it.rarity, ac: it.ac, img: it.img[g] || it.img.any || it.img.m, route: it.routes[0] });
  const file = path.join(WORK, `candidates-${id}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`${id}: ${out.length} candidates (${pool.length} free-player items with a route) -> ${file}`);
}

// Seasonal candidates for one character, grouped by event (birthdays, Frostval, Mogloween...): items the wiki tags
// seasonal or that come from an event map / Seasonal script, with a route, ranked by its taste words.
function seasonlist(id) {
  const personas = require('../lib/personas');
  const stylist = require('../lib/stylist');
  const p = personas.get(id);
  const g = p.sex === 'female' ? 'f' : 'm';
  const book = JSON.parse(fs.readFileSync(OUT, 'utf8')).items;
  const t = stylist.taste(p);
  const rank = (it) => {
    const all = `${it.name} ${it.tags.join(' ')} ${it.desc}`.toLowerCase();
    if (t.veto.some((v) => all.includes(v))) return -1;
    return t.love.reduce((s, k) => s + (all.includes(k) ? 1 : 0), 0) - t.avoid.reduce((s, k) => s + (all.includes(k) ? 1 : 0), 0);
  };
  const groups = {};
  for (const it of Object.values(book)) {
    if (!it.free || it.member || !it.img || !it.routes.length) continue;
    const ev = (it.routes.find((r) => r.event) || {}).event || (it.seasonal ? 'seasonal (event map unknown)' : null);
    if (!ev) continue;
    const s = rank(it);
    if (s < 0) continue;
    (groups[ev] = groups[ev] || []).push({ name: it.name, slot: it.slot, score: s, tags: it.tags, desc: it.desc, img: it.img[g] || it.img.any || it.img.m, route: it.routes[0] });
  }
  const out = {};
  for (const [ev, list] of Object.entries(groups)) out[ev] = list.sort((a, b) => b.score - a.score).slice(0, ev.startsWith('seasonal') ? 40 : 25);
  const file = path.join(WORK, `season-candidates-${id}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`${id}: ${Object.keys(out).length} events, ${Object.values(out).reduce((n, l) => n + l.length, 0)} candidates -> ${file}`);
}

// The persona stylists' picks (pick-<id>.json) -> data/dreams.json, checked against the lookbook and the hair shop.
const HAIRS = {
  female: 'Blank Bald Bangs1 Bangs2 Bangs3 Braid2 Braid2Bangs1 Braid3 Braid3Bangs1 Braid3Bangs2 Pig1Bangs1 Pig1Bangs2 Pig2 Pig2Bangs1 Pig2Bangs2 Pob Pony1Bangs1 Pony1Bangs2 Pony1Bangs2Long Pony1Long Pony2 Pony2Bangs1 Pony2Bangs2 Pony3 Pony3Bangs1 Pony3Bangs2 Pony4 Pony4Bangs1 Pony4Bangs2 Pony5 Pony5Bangs2 Spike1 Spike2 Bangs1Long Bangs2Long Bangs3Long Ponytail1 Halo1 Halo2 Halo3 Ponytail2 Ponytail3 Ponytail4 Braid1 Ponytail5 Ponytail6 Ponytail7 Fro1 Fro2 Glowingeyes1 cat1 Glowingeyes2 Curls Bang22 Formal Saf1 Betty1 Saf2 Long1 Braided3 Braided2 Braided1 Rennhair1 Ziohair1 Cute1 Ryuuji SummerHairLong Bob',
  male: 'Blank Bald BaldBeard BaldStache Bangs22 Bangs22Beard Bangs22Stache Bob BobBeard BobStache Braid1 Braid1Beard Braid1Stache Curl CurlBeard CurlStache Default DefaultBeard DefaultStache Goku1 Goku1Beard Goku1Stache Goku2 Goku2Beard Goku2Stache Normal NormalBeard NormalStache Normal2 Normal2Beard Normal2Stache Pompadour PompadourBeard PompadourStache Spikedown SpikedownBeard SpikedownStache Tonsure TonsureBeard TonsureStache Wavy WavyBeard WavyStache Zhoom ZhoomBeard ZhoomStache Ponytail8 Ponytail7 Ponytail6 Ponytail5 Ponytail4 Slickback1 Mohawk1 Mohawk2 Mohawk3 Conan1 Ponytail3 Conan2 Conan3 Ponytail Slickback2 Feathered1 Feathered2 Halo1 Fro1 Fro2 Mohawk4 Glowingeyes1 Glowingeyes2 Miltonius Ponytail9 Beard1 Beard2 Beard3 Widowspeak1 Wildbeard1 Wildbeard2 Long1 Braided1 Rennhair1 Ziohair1 Ryuuji SummerHairShort',
};
function dreams() {
  const personas = require('../lib/personas');
  const book = JSON.parse(fs.readFileSync(OUT, 'utf8')).items;
  const file = path.join(__dirname, '..', 'data', 'dreams.json');
  let out = {};
  try { out = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { out = {}; }
  const hex = (c) => /^#[0-9a-f]{6}$/i.test(String(c || ''));
  for (const id of Object.keys(personas.PERSONAS)) {
    const f = path.join(WORK, `pick-${id}.json`);
    if (!fs.existsSync(f)) { console.log(`${id}: no pick yet`); continue; }
    const pick = JSON.parse(fs.readFileSync(f, 'utf8'));
    const problems = [];
    const dream = [];
    for (const d of pick.dream || []) {
      const it = book[String(d.name).toLowerCase()];
      if (!it) { problems.push(`not in the lookbook: ${d.name}`); continue; }
      if (!it.free || it.member || !it.routes.length) { problems.push(`not free / no route: ${d.name}`); continue; }
      dream.push({ name: it.name, slot: it.slot, why: String(d.why || '').slice(0, 160), seen: String(d.seen || '').slice(0, 200) });
    }
    const hairs = HAIRS[personas.PERSONAS[id].sex].split(' ');
    const b = pick.barber || {};
    const hair = (b.hair || []).filter((h) => { const ok = hairs.includes(h); if (!ok) problems.push(`no such hairstyle: ${h}`); return ok; }).map((h) => `^${h}$`);
    const barber = {};
    if (hair.length) barber.hair = hair;
    if (hex(b.hairColor)) barber.hairColor = b.hairColor; else problems.push('hairColor');
    if (hex(b.eyeColor)) barber.eyeColor = b.eyeColor; else problems.push('eyeColor');
    if (Array.isArray(b.armor) && b.armor.length === 3 && b.armor.every(hex)) barber.armor = b.armor; else problems.push('armor colours');
    // The seasonal pass (seasonal-<id>.json): what it wants from each event, farmed while that event is live.
    const seasonal = [];
    const sf = path.join(WORK, `seasonal-${id}.json`);
    if (fs.existsSync(sf)) {
      for (const d of (JSON.parse(fs.readFileSync(sf, 'utf8')).seasonal || [])) {
        const it = book[String(d.name).toLowerCase()];
        if (!it) { problems.push(`seasonal not in the lookbook: ${d.name}`); continue; }
        if (!it.free || it.member || !it.routes.length) { problems.push(`seasonal not free / no route: ${d.name}`); continue; }
        seasonal.push({ name: it.name, slot: it.slot, event: (it.routes.find((r) => r.event) || {}).event || d.event || null, why: String(d.why || '').slice(0, 160), seen: String(d.seen || '').slice(0, 200) });
      }
    }
    out[id] = { look: pick.look, palette: pick.palette, dream, seasonal, love: (pick.love || []).map((w) => String(w).toLowerCase()), veto: (pick.veto || []).map((w) => String(w).toLowerCase()), barber, notes: pick.notes, pickedAt: new Date().toISOString() };
    console.log(`${id}: ${dream.length} dream pieces (${dream.map((d) => d.name).join(', ')}), ${seasonal.length} seasonal${problems.length ? `\n  problems: ${problems.join('; ')}` : ''}`);
  }
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
}

if (require.main === module) {
  const cmd = process.argv[2];
  const cmds = { catalog, wiki, pages, build, dreams, shortlist: () => shortlist(process.argv[3]), seasonlist: () => seasonlist(process.argv[3]) };
  cmds[cmd] ? Promise.resolve(cmds[cmd]()).catch((e) => { console.error(e); process.exit(1); }) : console.log('usage: lookbook.js catalog|wiki|build|shortlist <persona>');
}

module.exports = { catalog, parse, slug, build };
