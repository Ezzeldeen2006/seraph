// Where the players are (the owner, 2026-09-25): "things that most people farm and common places that there are people in
// make the bots goto artix and join normal room numbers instead of an empty room ... things that people are not farming
// and the bots wont even need help farming them make them goto swordhaven and whatever room number they want."
// 2026-09-27: "dailies and things that people of AQW do daily make the bots do it in public rooms ... never make them do
// ultras in public lobbies they are improving themselvs to do ultras themselvs".
// So a task is private (ultras: Swordhaven, the party's own room, always), crowded (dailies, void auras, big drop farms:
// Artix, a normal public room) or quiet (everything else: Swordhaven, the party's own room). The lists live in crowd.json.
// How the bots behave once they are in a public room is lib/manners.js.
'use strict';
const path = require('path');
const { readJson } = require('./util');

const cfg = readJson(path.join(__dirname, 'crowd.json'), {});
const CROWD_SERVER = cfg.crowdServer || 'Artix';
const QUIET_SERVER = cfg.quietServer || 'Swordhaven';
// Crowded work that has waited this long for a seat on a full crowd server goes to the busiest other server (0 = never).
const ALT_AFTER_MIN = cfg.altAfterMin === undefined ? 30 : Number(cfg.altAfterMin) || 0;
// The owner, 2026-10-05: "artix is never full all day - if you keep trying to log in on artix for a straight 30 minutes you
// will definitely find a slot". A character with crowded work logs out and knocks on Artix (the server list every
// KNOCK_POLL_MS, a login the moment a seat shows) for KNOCK_MIN minutes, then the busiest other server will do.
const KNOCK_MIN = cfg.knockMinutes === undefined ? 30 : Number(cfg.knockMinutes) || 30;
const KNOCK_POLL_MS = 2000;
const lower = (xs) => new Set((xs || []).map((m) => String(m).toLowerCase()));
const res = (xs) => (xs || []).map((p) => new RegExp(p, 'i'));
const MAPS = lower(cfg.maps);
const MAP_RES = res(cfg.mapPatterns);
const SCRIPT_RES = res(cfg.scriptPatterns);
const PRIVATE_MAPS = lower(cfg.privateMaps);
const PRIVATE_MAP_RES = res(cfg.privateMapPatterns);
const PRIVATE_SCRIPT_RES = res(cfg.privateScriptPatterns);
const DAILIES = cfg.dailies !== false;
// Chores work on any server: dressing up sent Valen from Artix to Swordhaven and straight back (09-27 04:04).
const HOUSEKEEPING = new Set(['bankAc', 'sellJunk', 'tidy', 'enhance', 'barber', 'equip', 'gear', 'set', 'buy', 'shop', 'probeEvent', 'style']);
// Crowded retries (failed dailies, Lord of Order after a boss nobody fought) start on shared two-hour windows (UTC
// even hours), so they happen in one Artix visit instead of one hop each (09-27: 250 hops in a day).
const WINDOW_MS = 2 * 3600000;
function windowAfter(t, minMs = WINDOW_MS) { return Math.ceil((Number(t) + minMs) / WINDOW_MS) * WINDOW_MS; }
const MANNERS = Object.assign({ minPlayers: 5, fightingSec: 20, keepFightingSec: 60, maxWaitMin: 30, dailyWaitMin: 15, skipHours: 2, privateRoomMin: 1000, minInCell: 2, hopelessHpRatio: 400, privateFallback: true, fallbackMin: 60 }, cfg.manners || {});

const slash = (p) => String(p || '').replace(/\\/g, '/');
function baseMap(map) { return String(map || '').split('-')[0].toLowerCase(); }
// Bosses a quest wants you to die to (2026-10-05): Akriloth in firewar "cannot be killed" (820M HP) and LoO's Confront
// Akriloth drops its item when he kills you. Waiting for a crowd there waited for a kill that never comes.
// Chain dailies (crowd.json manners.chainDailies): daily quest chains whose bosses the party takes (lib/manners.js).
function chainDaily(path) {
  const p = String(path || '').replace(/\\/g, '/').toLowerCase();
  return !!p && (MANNERS.chainDailies || []).some((x) => p.endsWith(String(x).toLowerCase()));
}
const DIE_TO = (MANNERS.dieTo || []).map((d) => ({ map: d.map ? baseMap(d.map) : null, boss: String(d.boss || '').toLowerCase() }));
function dieTo(map, boss) {
  const b = baseMap(map); const n = String(boss || '').toLowerCase();
  return DIE_TO.some((d) => d.boss === n && (!d.map || d.map === b));
}
function privateMap(map) { const b = baseMap(map); return !!b && (PRIVATE_MAPS.has(b) || PRIVATE_MAP_RES.some((r) => r.test(b))); }
function privateScript(p) { return !!p && PRIVATE_SCRIPT_RES.some((r) => r.test(slash(p))); }
function crowdedMap(map) { const b = baseMap(map); return !!b && !privateMap(b) && (MAPS.has(b) || MAP_RES.some((r) => r.test(b))); }
function crowdedScript(p) { return !!p && !privateScript(p) && SCRIPT_RES.some((r) => r.test(slash(p))); }

// Ultras and raids: the quiet server and the party's own room, never a public lobby.
function isPrivate(task) {
  if (!task) return false;
  if (task.raid) return true;
  if (task.type === 'script' && privateScript(task.path)) return true;
  return !!(task.map && privateMap(task.map));
}
// The boss ladder (the owner, 2026-10-09): "IF A BOSS CAN BE soloed by a bot then he doesnt need to wait for people, if it
// cant be soloed call the party, if they cant do it as a 4 then the last option is to wait for public people to help."
// With `ladder` on (crowd.json), crowded content no longer starts on Artix in a public room: it runs on the quiet server
// in the party's room like everything else (solo there; the struggle rule calls the party), and a task goes public
// only once it is marked `publicStep` - the party could not kill its boss (hub.goPublic). In the 24 h before this,
// knocking on a full Artix cost ~4 h of bot time and public waits where nobody came ~4.75 h.
const state = { ladder: cfg.ladder !== false };
// Where a task runs: crowded (Artix, public room), quiet (Swordhaven, the party's room), or null (this task has no say:
// stay where you are). Private tasks are 'quiet' here.
function kindOf(task) {
  const k = contentKind(task);
  if (k === null || !task || isPrivate(task) || task.server || task.room) return k;
  if (task.publicStep) return 'crowd';
  return k === 'crowd' && state.ladder ? 'quiet' : k;
}
// What the content is (the 09-25 lists), whatever the ladder decides: boss DMs still use it.
function contentKind(task) {
  if (!task) return null;
  if (isPrivate(task)) return 'quiet';
  if (task.server) return task.server === CROWD_SERVER ? 'crowd' : 'quiet';
  // Anything that brings its own shared room (army farms, orders with a room) keeps it, on the quiet server.
  if (task.room) return 'quiet';
  if (['idle', 'wait', 'follow', 'assist', 'gotoPlayer'].includes(task.type)) return null;
  // Chores work on any server. On 2026-09-27 Valen won a seat on a full Artix, left it for a bank trip on
  // Swordhaven, and then waited outside Artix again for the Lord of Order daily.
  if (HOUSEKEEPING.has(task.type)) return null;
  if (task.type === 'daily') return DAILIES ? 'crowd' : 'quiet';
  if (task.type === 'script') return crowdedScript(task.path) ? 'crowd' : 'quiet';
  if (task.map) return crowdedMap(task.map) ? 'crowd' : 'quiet';
  return 'quiet';
}
function serverFor(kind) { return kind === 'crowd' ? CROWD_SERVER : kind === 'quiet' ? QUIET_SERVER : null; }

// A room is public when it has a normal, low number ("thevoid-3"). Private rooms are the high ones the party and Skua's
// PrivateRooms pick (13579, 100000...). An area with no number yet counts as public: the server chose it.
function publicArea(area) {
  const n = Number(String(area || '').split('-')[1]);
  return !(n >= MANNERS.privateRoomMin);
}

module.exports = { KNOCK_MIN, KNOCK_POLL_MS, CROWD_SERVER, QUIET_SERVER, ALT_AFTER_MIN, MANNERS, WINDOW_MS, windowAfter, baseMap, dieTo, crowdedMap, crowdedScript, privateMap, privateScript, isPrivate, kindOf, serverFor, publicArea, chainDaily, contentKind };
// crowd.LADDER is read live (tests run the old rules with setLadder(false)).
Object.defineProperty(module.exports, 'LADDER', { get: () => state.ladder, enumerable: true });
module.exports.setLadder = (on) => { state.ladder = !!on; };
