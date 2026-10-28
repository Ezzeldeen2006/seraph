// Seraph's copy of the Ultras v3 scripts from noelrohi/Scripts (app/ultras/SeraphUltras, tools/vendor-ultras.js;
// 2026-10-18, vault STRATEGY/Ultra-Research-2026-10-18). The fork plays each boss by a named Comp (4 classes, roles,
// potions, taunt timing) and a party layout ("Username=Class; ..."), counts a kill for the whole party, checks that
// all four stand in the same room, and logs every Attempt as "[UltraAttempt] {json}".
//  - install(): copies the folder into the Skua library as Scripts/SeraphUltras. The Scripts clone is git-managed
//    (Reset Scripts runs `git clean -fdx`), so this runs at start and after every pull or reset.
//  - setRaidOptions(): writes "<Boss>Layout" and "<Boss>Comp" into the shared DoAllUltras.cfg the scripts read.
//  - attempt(): parses an "[UltraAttempt]" log line.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { P } = require('./paths');

const SRC = path.join(P.APP, 'ultras', 'SeraphUltras');
const DIRNAME = 'SeraphUltras';

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const sum = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');

// Copy what differs; drop files the copy no longer has. Returns the number of files written.
function install(scripts = P.SCRIPTS, src = SRC) {
  if (!fs.existsSync(src) || !scripts || !fs.existsSync(scripts)) return 0;
  const dest = path.join(scripts, DIRNAME);
  let n = 0;
  const want = new Set();
  for (const f of walk(src)) {
    const rel = path.relative(src, f);
    want.add(rel);
    const to = path.join(dest, rel);
    if (fs.existsSync(to) && sum(to) === sum(f)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f, to);
    n++;
  }
  for (const f of walk(dest)) if (!want.has(path.relative(dest, f))) { try { fs.unlinkSync(f); } catch (e) { /* gone */ } }
  return n;
}

// The DoAllUltras option names: Ultra Ezrajal -> UltraEzrajal (the script's Boss constant).
const optionKey = (boss) => String(boss.layoutKey || boss.name || '').replace(/[^A-Za-z]/g, '');

// "Options:<key>Layout=user=Class; ..." and "Options:<key>Comp=<name>" in <optionsDir>/DoAllUltras.cfg, other lines kept.
function setRaidOptions(optionsDir, boss, seats, comp = '') {
  const key = optionKey(boss);
  const file = path.join(optionsDir, 'DoAllUltras.cfg');
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); } catch (e) { lines = []; }
  const set = (name, value) => {
    const prefix = `Options:${name}=`;
    lines = lines.filter((l) => !l.startsWith(prefix));
    lines.push(prefix + value);
  };
  set(`${key}Layout`, (seats || []).map((s) => `${s.user}=${s.cls}`).join('; '));
  set(`${key}Comp`, comp || '');
  fs.mkdirSync(optionsDir, { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { key, layout: `${key}Layout`, comp: comp || '(default)' };
}

// Seraph's Comps (lib/ultras-comps.json, vendored into the scripts): the one for this boss whose four classes are the
// seats' classes; else one of the script's own Comps with those classes (scriptComps - 2026-10-22: the proven
// Tyndarius kill is upstream's loo-sc-ap-ke, which Seraph never picked). '' = the boss's default Comp (bosses without
// Comps ignore the option).
function compFor(boss, classes) {
  let comps = [];
  try { comps = JSON.parse(fs.readFileSync(path.join(__dirname, 'ultras-comps.json'), 'utf8')); } catch (e) { comps = []; }
  const key = optionKey(boss);
  const sorted = (list) => list.map((c) => String(c).toLowerCase()).sort().join('|');
  const want = sorted([...(classes || [])]);
  const hit = comps.find((c) => c.boss === key && sorted(c.entries.map((e) => e.class)) === want);
  if (hit) return hit.name;
  const own = scriptComps(boss).find((c) => c.classes.length === (classes || []).length && sorted(c.classes) === want);
  return own ? own.name : (boss.comp || '');
}

// The Comps in a vendored boss script: [{ name ('' = UltraComp.Default), classes }]. An entry kept in a shared field
// (Nulgath's BladeHittingDragonOfTime) has no Class line here, so that Comp lists fewer classes and matches nothing.
function scriptComps(boss, src = SRC) {
  let text = '';
  try { text = fs.readFileSync(path.join(src, String(boss.script || '').replace(/^SeraphUltras\//, '')), 'utf8'); } catch (e) { return []; }
  const i = text.indexOf('public static readonly UltraComp[] Comps =');
  const end = i >= 0 ? text.indexOf('\n    };', i) : -1;
  if (end < 0) return [];
  return text.slice(i, end).split(/\n {8}new\(/).slice(1).map((p) => {
    const m = /^(?:UltraComp\.Default|"([^"]+)")/.exec(p);
    return m ? { name: m[1] || '', classes: [...p.matchAll(/Class = "([^"]+)"/g)].map((x) => x[1]) } : null;
  }).filter(Boolean);
}

// What the Raid Planner (dashboard, the owner 2026-10-24: "decide which characters take which role and how they act and what
// potions they use") can offer for a boss, read from its vendored script:
//  - kind 'comp' (bosses with Comps): every Comp's entries { class, role, potions, scroll }, and the roles with the
//    classes, potions and scroll the script plays them with. Any owned class can take any role; the role's code and
//    taunt timing come from the script's entry for it (UltraComp SeraphPlan, tools/vendor-ultras.js).
//  - kind 'slots' (bosses whose code checks the class itself, UltraClassesByRole): one slot per role with the classes
//    allowed in it. The class decides the role there, so a plan only picks classes.
function planInfo(boss, src = SRC) {
  let text = '';
  try { text = fs.readFileSync(path.join(src, String(boss.script || '').replace(/^SeraphUltras\//, '')), 'utf8'); } catch (e) { return null; }
  const consts = {};
  for (const m of text.matchAll(/const string (\w+) = "([^"]*)"/g)) consts[m[1]] = m[2];
  // A role the hub may seat a second class in (vendor FIX: `string X => UltraPotions.SeraphSeatOr("A", "B")`).
  const either = {};
  for (const m of text.matchAll(/static string (\w+) => UltraPotions\.SeraphSeatOr\("([^"]+)", "([^"]+)"\)/g)) either[m[1]] = [m[2], m[3]];
  const value = (tok) => {
    const t = String(tok || '').trim();
    if (/^".*"$/.test(t)) return t.slice(1, -1);
    if (t === 'UltraPotions.HonorOrMalice') return 'Potent Honor or Malice Potion';
    if (/^UltraLoadout\.ScrollOf(\w+)$/.test(t)) return `Scroll of ${t.replace(/^UltraLoadout\.ScrollOf/, '')}`;
    return consts[t] != null ? consts[t] : t;
  };
  const i = text.indexOf('public static readonly UltraComp[] Comps =');
  if (i >= 0) {
    const end = text.indexOf('\n    };', i);
    const comps = text.slice(i, end).split(/\n {8}new\(/).slice(1).map((p) => {
      const m = /^(?:UltraComp\.Default|"([^"]+)")/.exec(p);
      if (!m) return null;
      const entries = p.split('new UltraCompEntry').slice(1).map((e) => {
        const cls = /Class = "([^"]+)"/.exec(e);
        const role = /Role = ([^,\n]+),/.exec(e);
        const pots = /Potions = new\[\] \{([^}]*)\}/.exec(e);
        const scroll = /Scroll = ([^,\n]+),/.exec(e);
        return cls && role ? { class: cls[1], role: value(role[1]), potions: pots ? pots[1].split(',').map(value).filter(Boolean) : [], scroll: scroll ? value(scroll[1]) : '' } : null;
      }).filter(Boolean);
      return { name: m[1] || 'default', entries };
    }).filter(Boolean);
    const roles = [];
    for (const c of comps) {
      for (const e of c.entries) {
        let r = roles.find((x) => x.role === e.role);
        if (!r) roles.push(r = { role: e.role, classes: [], potions: e.potions, scroll: e.scroll });
        if (!r.classes.includes(e.class)) r.classes.push(e.class);
      }
    }
    return { kind: 'comp', comps, roles };
  }
  const j = text.indexOf('UltraClassesByRole =');
  if (j < 0) return null;
  const block = text.slice(j, text.indexOf('\n    };', j));
  const slots = [...block.matchAll(/new\[\] \{([^}]*)\}/g)].map((m) => {
    const toks = m[1].split(',').map((t) => t.trim()).filter(Boolean);
    // A role named after its first constant (Taunter1, Decayer...); a SeraphSeatOr("X", "Y") seat allows both.
    const classes = [];
    for (const t of toks) {
      const seat = /SeraphSeatOr\("([^"]+)", "([^"]+)"\)/.exec(t);
      if (seat) classes.push(seat[1], seat[2]); else if (either[t]) classes.push(...either[t]); else classes.push(value(t));
    }
    const name = toks.find((t) => /^[A-Za-z]\w*$/.test(t)) || `Seat${classes[0] || ''}`;
    return { role: name, classes: [...new Set(classes)] };
  });
  return { kind: 'slots', slots };
}

// The plan file the vendored UltraComp reads when a boss's Comp option is "seraph-plan": next to the seats file,
// "boss=<option key>" then one "Class|Role|potion, potion|scroll" line per seat. raidEnd removes it.
const PLAN_COMP = 'seraph-plan';
function writePlan(root, boss, seats) {
  const lines = [`boss=${optionKey(boss)}`, ...seats.map((s) => [s.cls, s.role, (s.potionList || []).join(', '), s.scroll || '', ...(s.tauntAt === null || s.tauntAt === undefined ? [] : [s.tauntAt])].map((x) => String(x).replace(/[|\r\n]/g, ' ')).join('|'))];
  fs.writeFileSync(path.join(root, 'raid-plan.txt'), lines.join('\n') + '\n');
  return lines;
}
function clearPlan(root) { try { fs.unlinkSync(path.join(root, 'raid-plan.txt')); } catch (e) { /* none */ } }

function attempt(line) {
  const m = /\[UltraAttempt\]\s*(\{.*\})\s*$/.exec(String(line || ''));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

module.exports = { SRC, DIRNAME, PLAN_COMP, install, setRaidOptions, optionKey, compFor, scriptComps, planInfo, writePlan, clearPlan, attempt };
