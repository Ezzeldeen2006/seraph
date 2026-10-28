// Farmer Joe: the Skua community's own 1-100 progression order (Other/FarmJoeKits/CoreFarmerJoe.cs), read live
// from the script library so it follows every weekly Skua update instead of a list frozen in this file.
//
// Seraph uses it for the ORDER of things and runs each step as the exact call Farmer Joe makes
// (MR.GetMR() -> Other/Classes/REP-based/MasterRanger.cs#GetMR, Farm.Experience(80) -> CoreFarms.cs#Experience("80")),
// in Skua's real engine (lib/skua/engine.js + lib/skua/entry.js), so each step is the same C# code Farmer Joe runs.
'use strict';
const fs = require('fs');
const path = require('path');
const { P } = require('./paths');

const FILE = 'Other/FarmJoeKits/CoreFarmerJoe.cs';
let cache = null;

const read = (rel) => { try { return fs.readFileSync(path.join(P.SCRIPTS, ...rel.split('/')), 'utf8'); } catch (e) { return null; } };

// Every class declared in a file, so "MR" (a MasterRanger field) can be traced to MasterRanger.cs.
function classFiles(src) {
  const map = {};
  const includes = [];
  const re = /^\s*\/\/cs_include\s+Scripts\/(\S+)/gm;
  let m;
  while ((m = re.exec(src))) includes.push(m[1].trim());
  for (const inc of includes) {
    const s = read(inc);
    if (!s) continue;
    const cr = /\bpublic\s+class\s+(\w+)/g;
    let c;
    while ((c = cr.exec(s))) if (!map[c[1]]) map[c[1]] = inc;
  }
  return map;
}

// Field/property name -> type, e.g. "MR" -> "MasterRanger", "Farm" -> "CoreFarms".
function fieldTypes(src) {
  const out = {};
  const re = /(?:private|public|internal|protected)\s+(?:static\s+)?(?:readonly\s+)?([A-Z]\w+)\s+(\w+)\s*(?:=>|=|\{|;)/g;
  let m;
  while ((m = re.exec(src))) if (!out[m[2]]) out[m[2]] = m[1];
  return out;
}

function parse() {
  const src = read(FILE);
  if (!src) return [];
  const files = classFiles(src);
  files.CoreFarms = files.CoreFarms || 'CoreFarms.cs';
  const types = fieldTypes(src);
  const lines = src.split(/\r?\n/);
  const steps = [];
  const logRe = /Core\.Logger\(\s*\$?"(?:(?:Level|Bracket level)\s*\[?(\d+)\]?[:;]?|Phase\s+(\d+):)\s*([^"]+)"/;
  let lastLevel = 1;
  for (let i = 0; i < lines.length; i++) {
    const lm = logRe.exec(lines[i]);
    if (!lm) continue;
    const level = lm[1] ? Number(lm[1]) : Math.max(lastLevel, 75 + (Number(lm[2]) - 1) * 6);
    lastLevel = level;
    const label = lm[3].replace(/\s+/g, ' ').trim();
    // The work is the first "Something.Method(" call after the log line that is not a Core/Bot helper.
    for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
      const cm = /\b([A-Z]\w*)\.(\w+)\s*\(/.exec(lines[j]);
      if (!cm) continue;
      const [, obj, method] = cm;
      if (['Core', 'Bot', 'Adv', 'Math', 'Enumerable', 'string', 'String', 'Console'].includes(obj) || method === 'SetClass') continue;
      const type = types[obj] || obj;
      const file = files[type] || (type === 'CoreFarms' || obj === 'Farm' ? 'CoreFarms.cs' : null);
      if (!file) break;
      const have = (/Acquiring\s+(?:the\s+)?(?:`)?([^`(]+?)(?:`|\s*\(|$)/i.exec(label) || [])[1];
      // The call's arguments too, when they are plain literals, so the engine can make the exact same call.
      const argm = new RegExp(`\\b${obj}\\.${method}\\s*\\(([^()]*)\\)`).exec(lines[j]);
      const bare = argm ? argm[1].replace(/"[^"]*"/g, '""').replace(/\b(true|false|null)\b/g, '').replace(/\b\w+\s*:/g, '') : '';
      const args = argm && !/[A-Za-z_]/.test(bare.replace(/""/g, '')) ? argm[1].trim() : '';
      steps.push({ level, label, have: have ? have.trim() : null, script: file, entry: file === FILE ? null : method, args, obj, type });
      break;
    }
  }
  // Keep the first mention of each script+method: later ones are re-checks of the same thing.
  const seen = new Set();
  return steps.filter((s) => { const k = `${s.script}#${s.entry}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function steps() { if (!cache) cache = parse(); return cache; }
function reload() { cache = null; return steps(); }

// The steps a character of this level should be working on (everything up to 10 levels ahead of it).
function dueFor(level) { return steps().filter((s) => s.level <= Number(level || 1) + 10); }

module.exports = { steps, reload, dueFor, parse, FILE };
