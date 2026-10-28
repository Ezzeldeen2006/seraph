// Static scan: every Flash call, game-function call and game-object path that the Skua library and Skua's engine use
// (string literals only), checked against lib/skua/swfworld.js, the headless stand-in for skua.swf + the game.
//   node engine/tests/flashscan.js [scriptsDir]
// A missing entry fails only when a script reaches that line, so this finds gaps before a bot does.
'use strict';
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..', '..', 'runtime', 'resources', 'app');
const SCRIPTS = process.argv[2] || process.env.SERAPH_SCRIPTS || require('path').join(require('os').homedir(), 'seraph', 'Scripts');
const CORE = path.join(__dirname, '..', 'vendor');
process.env.SERAPH_ROOT = process.env.SERAPH_ROOT || path.join(require('os').tmpdir(), 'seraph-flashscan');

const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (/[\\/](\.git|bin|obj|Cached-Scripts)$/.test(p)) continue; if (e.isDirectory()) walk(p); else if (e.name.endsWith('.cs')) files.push(p); } })(SCRIPTS);
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (/[\\/](bin|obj)$/.test(p)) continue; if (e.isDirectory()) walk(p); else if (e.name.endsWith('.cs')) files.push(p); } })(CORE);

const found = { call: new Map(), fn: new Map(), obj: new Map(), cb: new Map() };
const add = (kind, key, file) => { const m = found[kind]; const e = m.get(key) || { n: 0, files: new Set() }; e.n++; e.files.add(path.relative(path.dirname(SCRIPTS), file)); m.set(key, e); };
const RE = [
  ['call', /Flash\.Call(?:<[^>]+>)?\(\s*"([A-Za-z_]\w*)"/g],
  ['fn', /CallGameFunction(?:<[^>]+>)?\(\s*"([\w.]+)"/g],
  ['obj', /(?:GetGameObject(?:Static)?(?:<[^>]+>)?|SetGameObject|IsNull)\(\s*"([\w.\[\]]+)"/g],
  ['obj', /ObjectBinding\(\s*"([\w.\[\]]+)"/g],
  // Callbacks a script waits for from Flash (Bot.Flash.FlashCall handlers: name == "packetFromServer")
  ['cb', /name\s*[!=]=\s*"([A-Za-z_][\w-]*)"|name\.Equals\(\s*"([A-Za-z_][\w-]*)"/g],
];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const [kind, re] of RE) { if (kind === 'cb' && !/FlashCall/.test(src)) continue; re.lastIndex = 0; let m; while ((m = re.exec(src))) add(kind, m[1] || m[2], f); }
  // [ObjectBinding("a", "b")] alternatives
  const alt = /ObjectBinding\(([^)]*)\)/g; let m;
  while ((m = alt.exec(src))) for (const s of m[1].match(/"([\w.\[\]]+)"/g) || []) add('obj', s.slice(1, -1), f);
}

// A model with a typical character loaded (the same packets the live client gets first).
const { SwfWorld } = require(path.join(APP, 'lib', 'skua', 'swfworld'));
const client = { id: 'scan', headless: true, state: { loaded: true }, w: { myAvatar: { uid: 11, objData: { strUsername: 'Scan' } } }, write() {}, send() {}, record() {}, emit() {}, on() {}, login: { username: 'Scan' }, serverName: 'Test' };
const swf = new SwfWorld(client);
const pkt = (o) => swf.onPacket({ kind: 'json', cmd: o.cmd, data: o });
try {
  swf.setLogin({ username: 'Scan', token: 't', level: 50, upgradeDays: -1, userId: 1, servers: [{ sName: 'Test', sIP: '127.0.0.1', iPort: 5588, bOnline: 1, iCount: 1, iMax: 100 }] }, 'pw');
  swf.setServer({ sName: 'Test', sIP: '127.0.0.1', iPort: 5588 });
  pkt({ cmd: 'moveToArea', areaId: 5, areaName: 'battleon-1', strMapName: 'battleon', strMapFileName: 'battleon.swf', intType: 1, monmap: [{ MonMapID: 1, MonID: 9, strFrame: 'r2' }], mondef: [{ MonID: 9, strMonName: 'Frogzard', intLevel: 3, intHP: 100, intHPMax: 100 }], uoBranch: [{ entID: 11, strUsername: 'Scan', intHP: 500, intHPMax: 500, intMP: 50, intMPMax: 100, intState: 1, intLevel: 50, strFrame: 'Enter', strPad: 'Spawn' }] });
  pkt({ cmd: 'initUserData', uid: 11, data: { strUsername: 'Scan', intLevel: 50, intGold: 1000, intCoins: 10, iUpgDays: -1, strClassName: 'Rogue', iCP: 302500, strQuests: '0'.repeat(100), ia0: 0, ia1: 0, iBagSlots: 100, iBankSlots: 50, iHouseSlots: 20,
    dCreated: '2026-09-16T00:00:00', strEmail: 'x@y.z', intAQ: 0, intExp: 0, intExpToLevel: 1000, intMP: 100, intAccessLevel: 1, CharID: 1, strGender: 'F', guild: { Name: 'G' } } });
  pkt({ cmd: 'stu', sta: { $STR: 10 } });
  pkt({ cmd: 'uotls', unm: 'scan', o: 'afk:false' });
  pkt({ cmd: 'loadShop', shopinfo: { ShopID: 1, sName: 'Shop', items: [], sField: '', iIndex: -1, reqItems: '' } });
  pkt({ cmd: 'loadInventoryBig', items: [{ ItemID: 5, sName: 'Rogue', sType: 'Class', sES: 'ar', bEquip: 1, iQty: 302500, CharItemID: 1 }], hitems: [], factions: [{ FactionID: 1, sName: 'Good', iRep: 0 }] });
  pkt({ cmd: 'sAct', actions: { active: [{ ref: 'aa', nam: 'Auto attack', cd: 2000, mp: 0 }, { ref: 'a1', nam: 'Skill', cd: 5000, mp: 10 }], passive: [] } });
} catch (e) { console.error('model setup:', e.message); }

// skua.swf externals the model answers: the names in SwfWorld.call()'s switch and answer()'s, where call() hands
// most of them since the 2026-09-28 overhaul (the scan reported 21 false gaps until 10-05).
const swfSrc = fs.readFileSync(path.join(APP, 'lib', 'skua', 'swfworld.js'), 'utf8');
const bodyOf = (head) => { const i = swfSrc.indexOf(head); return i < 0 ? '' : swfSrc.slice(i, swfSrc.indexOf('\n  }\n', i)); };
const callBody = bodyOf('  call(fn, args) {') + bodyOf('  answer(fn, a) {');
const externals = new Set([...callBody.matchAll(/case '([A-Za-z_]\w*)'/g)].map((m) => m[1]));
const STATIC_ROOTS = /^(loginInfo|objLogin|serverIP)\b/;   // read with getGameObjectS (the model's statics)
const resolves = (p) => { try { const v = swf.call(STATIC_ROOTS.test(p) ? 'getGameObjectS' : 'getGameObject', [p]); return v !== undefined && v !== null && v !== 'undefined'; } catch (e) { return false; } };
const isPath = (p) => /^[A-Za-z_]\w*(\.[\w\[\]]+)*$/.test(p) && !/^(string\.Empty|true|false|null|name|sFilePath)$/.test(p) && (p.includes('.') || STATIC_ROOTS.test(p));
// A readable property counts: ActionScript makes no difference between reading one and calling it with no
// arguments, and callFunction answers both spellings.
const fnExists = (p) => { const parts = p.split('.'); const name = parts.pop(); try { const owner = parts.length ? swf.resolve(swf.game, parts.join('.')) : swf.game; return !!(owner && (typeof owner[name] === 'function' || (name in owner && owner[name] !== undefined))); } catch (e) { return false; } };

const report = (title, list) => {
  console.log(`\n${title}: ${list.length}`);
  for (const [k, e] of list.sort((a, b) => b[1].n - a[1].n)) console.log(`  ${String(e.n).padStart(4)}x ${k}   e.g. ${[...e.files].slice(0, 2).join(', ')}`);
};
const missCall = [...found.call].filter(([k]) => !externals.has(k));
const missFn = [...found.fn].filter(([k]) => !fnExists(k));
const missObj = [...found.obj].filter(([k]) => isPath(k) && !resolves(k));
console.log(`scanned ${files.length} files: ${found.call.size} Flash calls, ${found.fn.size} game functions, ${found.obj.size} object paths (literals)`);
report('Flash calls the model does not answer', missCall);
report('Game functions the model does not have', missFn);
report('Object paths that do not resolve on a loaded character (may be fine when empty)', missObj);
// Callbacks skua.swf makes to Skua (Main.as external.call) that Seraph's engine sends (lib/skua/engine.js): a script
// listening for any other name hears nothing - Ultra Speaker's packetFromServer handler was deaf until 2026-10-24.
const engSrc = fs.readFileSync(path.join(APP, 'lib', 'skua', 'engine.js'), 'utf8');
const sent = new Set([...engSrc.matchAll(/f: '([A-Za-z_][\w-]*)'/g)].map((m) => m[1]).concat(['loaded', 'pre-load']));
report('Flash callbacks scripts wait for that Seraph never sends', [...found.cb].filter(([k]) => !sent.has(k)));
