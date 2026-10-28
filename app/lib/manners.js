// Public-room manners (the owner, 2026-09-27): "when the bots join the public rooms to do these dailes (if they cant do it
// solo or together) they wait for people in the public room and dont just spam attacking the boss until they kill it
// like in the Thevoid map make sure that they wait until atleast there are 5 people in the room before attacking and
// make sure that the bots check that the boss hp is dropping before attacking ... we dont want to ruin the people
// experience in public lobbies ... help them and help ourselves not getting reported by people."
// And later that day: "if the bots can already defeat this thing without needing an outside help make them do it by
// themselves."
//
// The rules, for crowded content (lib/crowd.js) in a public room (a low room number):
//   1. A boss this character has beaten before (hub.soloBosses: killed with no stranger helping, or a daily it has
//      turned in before) is simply fought, like any player would.
//   2. Any other boss is never opened alone. Join one only when at least `minPlayers` real players (our own bots don't
//      count) are in the room AND it is being fought: another player hit it in the last `fightingSec` seconds with its
//      HP below full, or `minInCell` strangers stand in its cell.
//   3. Once in, keep fighting only while other players still hit it (`keepFightingSec`).
//   4. Wait OUTSIDE the boss's cell: an aggressive boss (Desolich) killed the "waiting" bots 744 times in an hour in
//      desolich-1 on 2026-09-27. Jumps back into its cell are held (blocksCell) until the fight may start.
//   5. Wait at most `maxWaitMin` (`dailyWaitMin` for dailies). Then, unless the boss is hopeless without a crowd
//      (`hopelessHpRatio` times the character's HP, e.g. Desolich: 8.2M HP) or a known party wall, the character goes
//      to the party's private room on the same map and tries it there (nobody is disturbed; the struggle rule calls
//      the party if it can't). Otherwise the boss is left alone for `skipHours`.
//   6. Never pull a whole cell of monsters while strangers stand in it (net/headless.js attack).
//   2026-10-05 (the owner): the wait in 2 is only for bosses the party can't take either (hopeless or a party wall). With
//   `partyFirst` any other boss goes to the party's private room at once, as in 5. Bosses a quest wants you to die
//   to (`dieTo`, Akriloth in firewar) are attacked at once.
//   2026-10-07 (the owner): dailies are public only (`dailiesPublicOnly`): no partyFirst and no private fallback for them.
// Every attack goes through check(): the bot's own hunts (net/headless.js) and Skua scripts (skua/swfworld.js) alike.
// The client carries `manners`, the bot's side of it (hub.open): crowd(), daily(), isBoss(hpMax), solo(), ours(),
// wall(name), privateRoom().
'use strict';
const crowd = require('./crowd');

const OK = Object.freeze({ ok: true });

function me(c) { return String((c.w.myAvatar.objData || {}).strUsername || '').toLowerCase(); }
// Real players: everyone in the room (or cell) but this character and our other bots.
function strangers(c, cell = null) {
  const ours = (c.manners && c.manners.ours && c.manners.ours().names) || new Set();
  const self = me(c);
  return Object.entries(c.w.users || {})
    .filter(([n, u]) => n !== self && !ours.has(n) && u && (!cell || u.strFrame === cell))
    .map(([n]) => n);
}

// Should this character's rules apply right now? Crowded content, in a public room, on the headless client.
function active(c) {
  const m = c.manners;
  return !!(m && m.crowd && m.crowd() && crowd.publicArea(c.w.strAreaName));
}

function myHpMax(c) { return Number(c.w.myAvatar && c.w.myAvatar.dataLeaf && c.w.myAvatar.dataLeaf.intHPMax) || 0; }

// Rule 4: step out of the boss's cell while waiting, back in once the fight may start.
function stepOut(c, mon, now) {
  const st = c._manners;
  if (!mon.strFrame || c.w.strFrame !== mon.strFrame || mon.strFrame === 'Enter') return;
  if (now - (st.outAt || 0) < 8000) return;
  st.outAt = now;
  st.outOf = mon.strFrame;
  try { c.xt('moveToCell', ['Enter', 'Spawn']); } catch { /* never break combat */ }
}
// Standing still for ~2 min makes the character AFK, and a NoAFK map (icewing, icestormunder...) removes AFK players
// a minute later: Sable was sent to battleon mid-wait three times on 2026-09-27. A pad change in the cell it waits
// in, once a minute, is enough activity.
function keepAwake(c, mon, now) {
  const st = c._manners;
  if (!c.w.strFrame || c.w.strFrame === mon.strFrame) return;   // still in the boss cell: stepOut moves it anyway
  if (!st.awakeAt) { st.awakeAt = now; return; }
  if (now - st.awakeAt < 60000) return;
  st.awakeAt = now;
  st.pad = st.pad === 'Left' ? 'Spawn' : 'Left';
  try { c.xt('moveToCell', [c.w.strFrame, st.pad]); } catch { /* */ }
}

// A held-back Skua jump left its model in the boss's cell while the server has the character at Enter: going in here
// saves waiting for Skua's next anti-AFK jump.
function stepIn(c, mon, now) {
  const st = c._manners;
  st.outOf = null;
  if (!mon.strFrame || c.w.strFrame === mon.strFrame || now - (st.inAt || 0) < 5000) return;
  st.inAt = now;
  try { c.xt('moveToCell', [mon.strFrame, 'Left']); } catch { /* */ }
}

// Rule 5: the same map in the party's private room, same cell. The server moves both the headless world and the Skua
// model (a Skua script carries on hunting in the same map, now private).
function goPrivate(c, mon, now) {
  const st = c._manners;
  const room = c.manners && c.manners.privateRoom && c.manners.privateRoom();
  const base = crowd.baseMap(c.w.strMapName);
  if (!room || !base || now - (st.privAt || 0) < 20000) return false;
  st.privAt = now;
  try { c.xt('cmd', ['tfer', me(c), `${base}-${room}`, mon.strFrame || 'Enter', 'Left']); } catch { return false; }
  return true;
}

// May this character hit `mon` now? {ok} or {ok: false, why, gaveUp, fallback}. Waiting is recorded on the client
// (c.mannersWait: the hunt loop and the watchdog read it) and said once in the journal ('manners' event).
// The ladder's last step (the owner, 2026-10-09: solo, then the party, then "the last option is to wait for public people
// to help"). Solo and party fights need no manners: they happen in the party's own room. A boss the whole party lost to
// today (hub party wall) is not fought there again: the character takes its task to a public room with players
// (hub.goPublic, via the 'manners' event 'public').
function ladderUp(c, mon, now) {
  const m = c.manners;
  if (!crowd.LADDER || !m || !m.wall || !m.isBoss || !m.canGoPublic || !m.canGoPublic()) return null;
  const name = String(mon.strMonName || '');
  if (!name || !m.isBoss(Number(mon.intHPMax) || 0) || !m.wall(name)) return null;
  if ((m.solo && m.solo()[name]) || crowd.dieTo(c.w.strMapName, name)) return null;
  const st = c._manners || (c._manners = { waits: {}, skip: {}, fallback: {} });
  st.public = st.public || {};
  const key = `${crowd.baseMap(c.w.strMapName)}:${name.toLowerCase()}`;
  if (!(now - (st.public[key] || 0) < 60000)) {
    st.public[key] = now;
    try { c.emit('manners', { kind: 'public', boss: name, text: `${name}: the whole party lost to it today - last option, a public room with players` }); } catch { /* never break combat */ }
  }
  return { ok: false, why: `${name} needs players - going to a public room`, gaveUp: true, fallback: false };
}

function check(c, mon, now = Date.now()) {
  if (mon && !active(c)) { const up = ladderUp(c, mon, now); if (up) return up; }
  if (!mon || !active(c)) { if (c.mannersWait) c.mannersWait = null; return OK; }
  const m = c.manners;
  const R = crowd.MANNERS;
  const hpMax = Number(mon.intHPMax) || 0;
  if (!m.isBoss(hpMax)) return OK;
  const id = Number(mon.MonMapID);
  const name = String(mon.strMonName || 'the boss');
  const st = c._manners || (c._manners = { waits: {}, skip: {}, fallback: {} });
  st.fallback = st.fallback || {};
  const key = `${crowd.baseMap(c.w.strMapName)}:${name.toLowerCase()}`;
  const say = (kind, text, extra = {}) => { try { c.emit('manners', { kind, boss: name, text, ...extra }); } catch { /* never break combat */ } };
  const refuse = (why, gaveUp = false, fallback = false) => {
    c.mannersWait = { since: (st.waits[key] || {}).since || now, last: now, boss: name, bossId: id, cell: mon.strFrame || null, why, gaveUp, fallback };
    if (!gaveUp) { stepOut(c, mon, now); keepAwake(c, mon, now); }
    else if (fallback) goPrivate(c, mon, now);
    return { ok: false, why, gaveUp, fallback };
  };
  const allow = (why) => {
    const w = st.waits[key];
    if (w) { delete st.waits[key]; say('join', `${name}: ${why} - joining the fight`); }
    c.mannersWait = null;
    stepIn(c, mon, now);
    return { ok: true, why };
  };

  // Rule 1: beaten before, so no help is needed.
  if (m.solo && m.solo()[mon.strMonName]) return allow('beaten it before');
  // A boss the quest wants you to die to (crowd.json manners.dieTo): no crowd kills it, so there is nothing to wait for.
  if (crowd.dieTo(c.w.strMapName, name)) return allow('the quest only needs it to beat me');
  if (st.skip[key] > now) return refuse(st.fallback[key] ? `trying ${name} in the party's room` : `leaving ${name} alone: nobody came to fight it`, true, !!st.fallback[key]);
  const others = (c.othersHits && c.othersHits.get(id)) || 0;
  const mine = (c.myHits && c.myHits.get(id)) || 0;
  if (now - mine < 30000 && now - others < R.keepFightingSec * 1000) return allow('still being fought');
  const room = strangers(c);
  const inCell = mon.strFrame ? strangers(c, mon.strFrame) : [];
  const fighting = (now - others < R.fightingSec * 1000 && Number(mon.intHP) < hpMax) || inCell.length >= R.minInCell;
  if (room.length >= R.minPlayers && fighting) return allow(`${room.length} players here and they are fighting it`);

  const myMax = myHpMax(c);
  const hopeless = myMax > 0 && hpMax >= R.hopelessHpRatio * myMax;
  const wall = !!(m.wall && m.wall(name));
  // The owner, 2026-10-07: daily bosses (NSoD's Warlord Icewing...) belong to Artix - the bots need the crowd for them.
  // A daily never takes its boss to the party's room (Sable died 12x to Icewing there): it waits for players in
  // public, and after dailyWaitMin leaves the boss for skipHours (the daily retries later).
  // 2026-10-09 (the owner: "the bots can solo extriki with arch paladin"): a chain daily (crowd.json chainDailies, Lord of
  // Order: one story quest a day) is progression, not a crowd daily. Its bosses follow partyFirst like any quest;
  // hopeless ones (Desolich) still wait for a crowd. Public-only kept LoO stuck at Extriki/Guardian Spirit for days.
  // 2026-10-09 (the owner, the ladder: solo -> party -> public last): neither shortcut to the public wait is left - dailies
  // get no exception, and boss HP is no proof (Avatar Tyndarius, 1.5 M, was called "too big for four" and never tried).
  // Only a party wall (the four of them lost to it) waits for players.
  const publicOnly = !crowd.LADDER && R.dailiesPublicOnly !== false && !!(m.daily && m.daily()) && !(m.chainDaily && m.chainDaily());
  const canPrivate = R.privateFallback !== false && !publicOnly && !(hopeless && !crowd.LADDER) && !wall && !!(m.privateRoom && m.privateRoom());
  // The owner, 2026-10-05: "the rule of them must wait for people to join the room applies to only the bosses that no one
  // can solo or cant be defeated by a party of 4". A boss the party can take is done in the party's room right away
  // (the struggle rule calls the others there); the public wait is only for hopeless bosses and party walls.
  if (R.partyFirst && canPrivate) {
    st.skip[key] = now + R.fallbackMin * 60000;
    st.fallback[key] = true;
    delete st.waits[key];
    say('private', `${name} in ${c.w.strAreaName}: the party can take it - doing it in the party's own room instead of waiting for players`, { fallback: true });
    return refuse(`trying ${name} in the party's room`, true, true);
  }

  let w = st.waits[key];
  if (!w || now - w.last > 2 * 60000) w = st.waits[key] = { since: now, last: now };   // a new visit starts a new wait
  w.last = now;
  const why = `waiting for players: ${room.length}/${R.minPlayers} in the room, ${fighting ? 'boss being fought' : 'nobody fighting it yet'}`;
  const limit = ((m.daily && m.daily()) ? R.dailyWaitMin : R.maxWaitMin) * 60000;
  if (now - w.since >= limit) {
    const fallback = canPrivate;
    st.skip[key] = now + (fallback ? R.fallbackMin * 60000 : R.skipHours * 3600000);
    st.fallback[key] = fallback;
    delete st.waits[key];
    const mins = Math.round((now - w.since) / 60000);
    if (fallback) say('private', `waited ${mins} min in ${c.w.strAreaName} and nobody fought ${name} - trying it in the party's own room`, { fallback: true });
    else say('skip', `waited ${mins} min in ${c.w.strAreaName} and nobody fought ${name} - leaving it for ${R.skipHours} h${hopeless ? ` (${Math.round(hpMax / 1000)}k HP: it needs a crowd)` : wall ? ' (the party could not kill it either)' : ''}`);
    return refuse(fallback ? `trying ${name} in the party's room` : `leaving ${name} alone: nobody came to fight it`, true, fallback);
  }
  if (!w.said) { w.said = true; say('wait', `${name} in public room ${c.w.strAreaName}: not starting it alone - ${why} (waiting outside its cell)`); }
  return refuse(why);
}

// The same check for a Skua display object (skua/swfworld.js): its MonMapID points at the headless monster.
function checkId(c, monMapId, now = Date.now()) {
  if (!active(c)) { if (c.mannersWait) c.mannersWait = null; return OK; }
  const mon = (c.w.monsters || []).find((x) => Number(x.MonMapID) === Number(monMapId));
  return check(c, mon, now);
}

// Waiting outside the boss's cell, an attack on it finds nothing in the current cell. Run the check on the waited-on
// boss anyway, so the wait stays alive (the hunt loop and the watchdog read it) and the bot steps in once it may fight.
// Without it the hunt took the wait for "no monster here" and rejoined the map (2026-09-27, Sable at icewing).
function recheck(c, name, now = Date.now()) {
  const mw = c.mannersWait;
  if (!mw || !active(c)) return null;
  const mon = (c.w.monsters || []).find((x) => Number(x.MonMapID) === Number(mw.bossId));
  if (!mon || Number(mon.intHP) <= 0 || Number(mon.intState) === 0) return null;
  const want = String(name || '*').toLowerCase();
  if (want !== '*' && !String(mon.strMonName || '').toLowerCase().includes(want)) return null;
  return check(c, mon, now);
}

// Rule 4: a jump into the cell of a boss this character is waiting on is held back while the wait lasts.
function blocksCell(c, cell, now = Date.now()) {
  const mw = c.mannersWait;
  if (!mw || mw.gaveUp || !mw.cell || mw.cell !== cell || now - mw.last > 3 * 60000 || !active(c)) return false;
  const mon = (c.w.monsters || []).find((x) => Number(x.MonMapID) === Number(mw.bossId));
  if (!mon || Number(mon.intHP) <= 0) return false;
  return !check(c, mon, now).ok;
}

// Rule 6: pulling every monster in the cell at once is fine alone, rude with strangers standing in it.
function mayPull(c) {
  return !(c.manners && crowd.publicArea(c.w.strAreaName) && strangers(c, c.w.strFrame).length);
}

module.exports = { check, checkId, recheck, blocksCell, mayPull, strangers, active };
