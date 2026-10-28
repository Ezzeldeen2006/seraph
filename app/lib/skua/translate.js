// Skua C# script -> Seraph step list. Reads scripts from the local auqw/Scripts clone, walks ScriptMain, inlines the
// script's own helper methods and the shared story/farm helpers it includes, and turns the quest-flow calls
// (EnsureAccept, KillQuest, HuntMonster, KillMonster, MapItemQuest, BuyItem, RegisterQuests...) into steps the bot can run.
// Port of K&B AutoClicker's skua.py, extended for packet-level actions (map items, buying).
const fs = require('fs');
const path = require('path');

function stripComments(src) {
  let out = ''; let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i];
    if (src.startsWith('//', i)) { const j = src.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (src.startsWith('/*', i)) { const j = src.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue; }
    if (c === '"' || ((c === '@' || c === '$') && src[i + 1] === '"')) { const j = skipString(src, i); out += src.slice(i, j); i = j; continue; }
    if (c === "'") { let j = i + 1; while (j < n && src[j] !== "'") j += src[j] === '\\' ? 2 : 1; out += src.slice(i, j + 1); i = j + 1; continue; }
    out += c; i++;
  }
  return out;
}

function skipString(src, i) {
  const verbatim = src[i] === '@';
  i += (src[i] === '@' || src[i] === '$') ? 2 : 1;
  while (i < src.length) {
    if (verbatim && src.startsWith('""', i)) { i += 2; continue; }
    if (!verbatim && src[i] === '\\') { i += 2; continue; }
    if (src[i] === '"') return i + 1;
    i++;
  }
  return i;
}

function match(src, i, open, close) {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || ((c === '@' || c === '$') && src[i + 1] === '"')) { i = skipString(src, i); continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

const METHOD = /\b(?:void|bool|int|string|Task|List<\w+>)\s+([A-Za-z_]\w*)\s*\(/g;

function methods(source) {
  const src = stripComments(source);
  const found = {};
  METHOD.lastIndex = 0;
  let m;
  while ((m = METHOD.exec(src))) {
    const close = match(src, m.index + m[0].length - 1, '(', ')');
    if (close < 0) continue;
    const rest = src.slice(close + 1);
    const brace = /^\s*\{/.exec(rest);
    if (!brace) continue;
    const start = close + brace[0].length;
    const end = match(src, start, '{', '}');
    if (end > 0 && !(m[1] in found)) found[m[1]] = src.slice(start + 1, end);
  }
  return found;
}

function splitArgs(text) {
  const parts = []; let depth = 0; let cur = ''; let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || ((c === '@' || c === '$') && text[i + 1] === '"')) { const j = skipString(text, i); cur += text.slice(i, j); i = j; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += c;
    i++;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function literal(text) {
  const t = String(text).trim();
  let m = /^@?"((?:[^"\\]|\\.|"")*)"$/s.exec(t);
  if (m) return t.startsWith('@') ? m[1].replace(/""/g, '"') : m[1].replace(/\\(.)/g, '$1');
  if (/^-?\d+$/.test(t)) return Number(t);
  if (t === 'true' || t === 'false') return t === 'true';
  if (t === 'null') return null;
  m = /^(?:new\s*(?:\w+\s*)?\[\s*\]\s*)?\{(.*)\}$|^\[(.*)\]$|^\((.*)\)$/s.exec(t);
  if (m) { const inner = m[1] ?? m[2] ?? m[3]; return splitArgs(inner).map(literal); }
  return null;
}

function callArgs(text, names) {
  const out = {}; let pos = 0;
  for (const a of splitArgs(text)) {
    const m = /^([A-Za-z_]\w*)\s*:\s*(?!:)([\s\S]+)$/.exec(a);
    if (m && names.includes(m[1])) out[m[1]] = literal(m[2]);
    else { if (pos < names.length) out[names[pos]] = literal(a); pos++; }
  }
  return out;
}

const SIG = {
  KillQuest: ['QuestID', 'MapName', 'MonsterName'],
  MapItemQuest: ['QuestID', 'MapName', 'MapItemID', 'Amount'],
  BuyQuest: ['QuestID', 'MapName', 'ShopID', 'ItemName', 'Amount'],
  ChainQuest: ['QuestID'],
  HuntMonster: ['map', 'monster', 'item', 'quant', 'isTemp'],
  KillMonster: ['map', 'cell', 'pad', 'monster', 'item', 'quant', 'isTemp'],
  HuntMonsterMapID: ['map', 'monsterMapID', 'item', 'quant', 'isTemp'],
  Join: ['map', 'cell', 'pad'],
  BuyItem: ['map', 'shopID', 'itemName', 'quant'],
  GetMapItem: ['itemID', 'quant', 'map'],
  EquipClass: ['classType'],
};
const KEYWORDS = new Set(['if', 'while', 'for', 'foreach', 'switch', 'return', 'new', 'catch', 'using', 'lock', 'nameof', 'typeof', 'sizeof', 'default', 'when', 'base', 'this']);
const LIBS = new Set(['Core', 'Story', 'Bot', 'Adv', 'Farm', 'Daily', 'Nation', 'Legion', 'Army', 'Quests', 'Map', 'Player', 'Wait', 'Inventory', 'TempInv', 'Bank', 'Drops', 'Options', 'Skills', 'Kill', 'Shops', 'Monsters', 'Log', 'Math', 'string', 'Enumerable', 'Thread', 'Task', 'List', 'Array', 'Console']);
const LIBRARY_FILES = { Farm: 'CoreFarms.cs', Story: 'CoreStory.cs', Daily: 'CoreDailies.cs' };
const CALL = /\b((?:[A-Za-z_]\w*\.)*)([A-Za-z_]\w*)\s*\(/g;

const step = (kind, kw = {}) => Object.assign({ kind, quest: null, map: null, monsters: [], item: null, qty: 1, temp: true, cell: null, pad: null, note: '' }, kw);
const mapName = (s) => (typeof s === 'string' && /^[a-z0-9_-]+$/i.test(s.trim()) ? s.trim().toLowerCase() : null);

function handle(name, args) {
  const sig = SIG[name];
  const a = sig ? callArgs(args, sig) : {};
  switch (name) {
    case 'KillQuest': {
      let mons = a.MonsterName;
      mons = Array.isArray(mons) ? mons.filter((x) => typeof x === 'string') : typeof mons === 'string' ? [mons] : [];
      return [step('quest', { quest: a.QuestID, map: mapName(a.MapName), monsters: mons })];
    }
    case 'MapItemQuest': {
      const ids = Array.isArray(a.MapItemID) ? a.MapItemID : [a.MapItemID];
      return [step('mapitem', { quest: a.QuestID, map: mapName(a.MapName), note: ids.filter((x) => typeof x === 'number').join(','), qty: typeof a.Amount === 'number' ? a.Amount : 1 })];
    }
    case 'BuyQuest':
      return [step('buyquest', { quest: a.QuestID, map: mapName(a.MapName), item: a.ItemName, qty: a.Amount || 1, note: String(a.ShopID) })];
    case 'ChainQuest':
      return [step('accept', { quest: a.QuestID }), step('turnin', { quest: a.QuestID })];
    case 'HuntMonster': case 'KillMonster': case 'HuntMonsterMapID': {
      const monster = a.monster;
      return [step('hunt', {
        map: mapName(a.map), monsters: typeof monster === 'string' ? [monster] : [],
        item: typeof a.item === 'string' ? a.item : null, qty: typeof a.quant === 'number' ? a.quant : 1,
        temp: a.isTemp !== false, cell: typeof a.cell === 'string' ? a.cell : null, pad: typeof a.pad === 'string' ? a.pad : null,
        note: typeof monster === 'string' ? '' : `monsterMapID ${a.monsterMapID}`,
      })];
    }
    case 'EnsureAccept':
      return splitArgs(args).map(literal).filter((q) => typeof q === 'number').map((q) => step('accept', { quest: q }));
    case 'EnsureComplete': case 'EnsureCompleteChoose': case 'EnsureCompleteMulti': {
      let ids = splitArgs(args).map(literal).filter((q) => typeof q === 'number');
      let reward = -1;
      if (name === 'EnsureComplete' && ids.length === 2) { reward = ids[1]; ids = ids.slice(0, 1); }
      return ids.map((q) => step('turnin', { quest: q, qty: reward }));
    }
    case 'RegisterQuests': {
      const ids = splitArgs(args).map(literal).filter((q) => typeof q === 'number');
      return ids.length ? [step('register', { note: ids.join(',') })] : null;
    }
    case 'CancelRegisteredQuests': return [step('unregister')];
    case 'Join': return mapName(a.map) ? [step('join', { map: mapName(a.map), cell: a.cell || null, pad: a.pad || null })] : null;
    case 'BuyItem':
      return typeof a.itemName === 'string' ? [step('buy', { map: mapName(a.map), item: a.itemName, qty: typeof a.quant === 'number' ? a.quant : 1, note: String(a.shopID) })] : null;
    case 'GetMapItem': return typeof a.itemID === 'number' ? [step('mapitem', { map: mapName(a.map), note: String(a.itemID), qty: a.quant || 1 })] : null;
    case 'EquipClass': return [step('class', { note: String(args).replace(/ClassType\./, '').trim() })];
    default: return null;
  }
}

function fillMaps(steps) {
  const byQuest = {};
  for (const s of steps) if (s.map && s.quest != null && !(s.quest in byQuest)) byQuest[s.quest] = s.map;
  let last = null;
  for (const s of steps) {
    if (!s.map && ['accept', 'turnin'].includes(s.kind) && byQuest[s.quest]) s.map = byQuest[s.quest];
    if (s.map) last = s.map; else if (['accept', 'turnin'].includes(s.kind) && last) s.map = last;
  }
  let next = null;
  for (const s of [...steps].reverse()) {
    if (s.map) next = s.map; else if (['accept', 'turnin'].includes(s.kind) && next) s.map = next;
  }
  return steps;
}

function includes(source) {
  const out = [];
  const re = /^\s*\/\/cs_include\s+Scripts\/(\S+)/gm;
  let m;
  while ((m = re.exec(source))) if (m[1].includes('/')) out.push(m[1].trim());
  return out;
}

// scriptPath is relative to the Scripts repo, e.g. "Story/Cleric.cs".
// The bots are free accounts: an `if (Core.IsMember) { ... }` block never runs for them, so its steps are dropped
// (an `else` block stays). CoreDailies.NSoDDaily hunted the member quest 8652 (Chaos Kraken, then gravechallenge
// and ancienttrigoras, which a free account can't join) every day and never reached the free quest 8653 (2026-09-27).
function stripMember(src) {
  const re = /\bif\s*\(\s*Core\.IsMember\s*\)\s*\{/g;
  let out = src; let m;
  while ((m = re.exec(out))) {
    const open = m.index + m[0].length - 1;
    const end = match(out, open, '{', '}');
    if (end < 0) break;
    const rest = out.slice(end + 1);
    const els = /^\s*else\s*\{/.exec(rest);
    out = out.slice(0, m.index) + (els ? rest.slice(els[0].length - 1) : rest);
    re.lastIndex = m.index;
  }
  return out;
}

function translate(root, scriptPath, entry = 'ScriptMain', limit = 16) {
  const read = (p) => stripMember(fs.readFileSync(path.join(root, ...p.split('/')), 'utf8'));
  const sources = {};
  const todo = [scriptPath];
  while (todo.length && Object.keys(sources).length < limit) {
    const p = todo.shift();
    if (sources[p]) continue;
    try { sources[p] = read(p); } catch { continue; }
    for (const inc of includes(sources[p])) if (!sources[inc]) todo.push(inc);
  }
  if (!sources[scriptPath]) throw new Error(`script not found: ${scriptPath}`);
  const table = {};
  for (const p of [scriptPath, ...Object.keys(sources).filter((x) => x !== scriptPath)]) {
    for (const [name, body] of Object.entries(methods(sources[p]))) if (!(name in table)) table[name] = body;
  }
  const libTables = {};
  const allText = Object.values(sources).join('\n');
  for (const [lib, file] of Object.entries(LIBRARY_FILES)) {
    if (new RegExp(`\\b${lib}\\.\\w+\\s*\\(`).test(allText)) { try { libTables[lib] = methods(read(file)); } catch { /* not in repo */ } }
  }
  const steps = []; const skipped = {}; const done = new Set();

  function walk(body, depth, scope) {
    const re = new RegExp(CALL.source, 'g');
    let i = 0;
    for (;;) {
      re.lastIndex = i;
      const m = re.exec(body);
      if (!m) return;
      const receiver = m[1].replace(/\.$/, ''); const name = m[2];
      const close = match(body, m.index + m[0].length - 1, '(', ')');
      if (close < 0) return;
      const args = body.slice(m.index + m[0].length, close);
      i = m.index + m[0].length;
      if (KEYWORDS.has(name)) continue;
      // A local function declared inline (`void QuestLogic() { ... }`) is not a call: skip its body.
      if (/\b(?:void|bool|int|string|Task)\s+$/.test(body.slice(Math.max(0, m.index - 12), m.index)) && /^\s*\{/.test(body.slice(close + 1))) {
        const open = body.indexOf('{', close);
        const end = match(body, open, '{', '}');
        if (end > 0) { i = end + 1; continue; }
      }
      if (name === 'LegacyQuestManager') { legacy(args, depth, scope, body, close); i = close + 1; continue; }
      const first = receiver ? receiver.split('.')[0] : '';
      const lib = libTables[receiver] ? receiver : (!receiver && scope ? scope : null);
      let target = null; let key = null; let libUsed = null;
      if (handle(name, args) === null) {
        if (lib && libTables[lib] && libTables[lib][name]) { target = libTables[lib][name]; key = `${lib}.${name}`; libUsed = lib; }
        else if (table[name] && !LIBS.has(first) && name !== entry) { target = table[name]; key = name; }
      }
      if (target !== null) {
        if (!done.has(key) && depth < 30) { done.add(key); walk(target, depth + 1, libUsed); }
        i = close + 1;
        continue;
      }
      const made = handle(name, args);
      if (!made) { if (LIBS.has(first)) { const k = `${receiver}.${name}`; skipped[k] = (skipped[k] || 0) + 1; } continue; }
      steps.push(...made);
      i = close + 1;
    }
  }

  // Story.LegacyQuestManager(QuestLogic, 4513, 4514, ...): CoreStory accepts each quest in order, runs
  // `switch (Story.LegacyQuestID) { case 4514: ... }` for it, then turns it in. Quest items only drop while
  // the quest is accepted, so every step of a case belongs to that case's quest.
  function legacy(args, depth, scope, outer, from) {
    const parts = splitArgs(args);
    const fn = /^[A-Za-z_]\w*$/.test(parts[0] || '') ? parts[0] : null;
    const ids = [];
    for (const p of parts.slice(1)) {
      const range = /^Core\.FromTo\(\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(p);   // Core.FromTo(4751, 4761) = 4751..4761
      if (range) { for (let q = Number(range[1]); q <= Number(range[2]); q++) ids.push(q); continue; }
      const v = literal(p);
      if (typeof v === 'number') ids.push(v); else if (Array.isArray(v)) ids.push(...v.filter((q) => typeof q === 'number'));
    }
    // Scripts often declare several local `void QuestLogic()` functions: use the one declared next to this call.
    let body = fn ? (table[fn] || '') : (parts[0] || '');
    if (fn) {
      const decl = new RegExp(`\\bvoid\\s+${fn}\\s*\\(\\s*\\)\\s*\\{`, 'g');
      decl.lastIndex = from;
      const d = decl.exec(outer);
      if (d) { const end = match(outer, d.index + d[0].length - 1, '{', '}'); if (end > 0) body = outer.slice(d.index + d[0].length, end); }
      done.add(fn);
    }
    const labels = [];
    const re = /\bcase\s+(\d+)\s*:/g;
    let m;
    while ((m = re.exec(body))) labels.push({ id: Number(m[1]), start: m.index, end: m.index + m[0].length });
    const cases = {};
    for (let k = 0; k < labels.length; k++) cases[labels[k].id] = body.slice(labels[k].end, labels[k + 1] ? labels[k + 1].start : body.length);
    // `case 1: case 2: <code>` falls through: empty labels share the next non-empty body.
    for (let k = labels.length - 2; k >= 0; k--) if (!cases[labels[k].id].trim()) cases[labels[k].id] = cases[labels[k + 1].id];
    const caseSteps = {};
    for (const label of labels) {
      if (caseSteps[label.id]) continue;
      const at = steps.length;
      walk(cases[label.id], depth + 1, scope);
      caseSteps[label.id] = steps.splice(at);
    }
    // Case labels are not always the quest that needs the items (BlazeBeardStory: `case 4514` farms Dwakel Scrap
    // Metal, which quest 4513 asks for). Every item step goes to the quest whose requirements name that item;
    // steps without an item (map items, kills) stay with their case label.
    let quest = () => null;
    try { quest = require('../knowledge').quest; } catch { /* no quest data: trust the labels */ }
    const needs = (id, item) => { const q = quest(id); return !!q && (q.Requirements || []).some((r) => String(r.sName || r.Name || '').toLowerCase() === item.toLowerCase()); };
    const byQuest = {};
    for (const [caseId, list] of Object.entries(caseSteps)) {
      for (const s of list) {
        const owner = (s.item && !needs(Number(caseId), s.item) && ids.find((id) => needs(id, s.item))) || Number(caseId);
        (byQuest[owner] = byQuest[owner] || []).push(Object.assign({}, s, { quest: s.quest == null ? owner : s.quest }));
      }
    }
    const chain = ids.slice();
    for (const id of ids) {
      steps.push(step('accept', { quest: id, chain }));
      for (const s of byQuest[id] || []) steps.push(Object.assign(s, { chain }));
      steps.push(step('turnin', { quest: id, chain }));
    }
  }

  const main = methods(sources[scriptPath]);
  walk(main[entry] || '', 0, null);
  const title = /^\s*name:\s*(.+)$/m.exec(sources[scriptPath]);
  return { title: title && title[1].trim() !== 'null' ? title[1].trim() : path.basename(scriptPath, '.cs'), path: scriptPath, steps: fillMaps(steps), skipped };
}

module.exports = { translate, methods, splitArgs, literal, callArgs, stripComments, stripMember, handle };
