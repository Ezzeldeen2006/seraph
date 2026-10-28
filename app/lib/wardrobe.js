// Wardrobe (the owner, 2026-10-07): "at the end of the day all we want is 1 cosmetic armor, 1 cosmetic helm, 1 cosmetic
// cape, 1 cosmetic weapon. these things will be shown to other players but actually we will be wearing the dmg boost
// items ... girls are allowed to have multiple cool and sexy outfits. boys are limited to 2. ... each bot has their own
// personality if they want that gear keep it if they dont sell it ... just place the things they dont need in the bank.
// ... make multiple outfits in every account based on each class the bot is using ... when switching outfits you switch
// class and apply the proper enhancements to that class."
//
// How AQW does it (Game.as, interface OutfitSets/outfitsetsr2.swf):
//   - "Show" (wearItem) lays an item's look over its slot (armor 'co', helm, cape, weapon) while the equipped item keeps
//     giving the stats. One shown item per slot (bWear).
//   - Outfits are server-side "loadouts" (20 slots on a free account): addLoadout(name, {ar, Weapon, he, ba, co, pe, am,
//     mi, colors}), equipLoadout (really equips them, class included) and wearLoadout (shows them).
// So a character keeps: its looks (what it shows), its boost gear and classes (what it fights in), what quests ask for,
// and every material stack. Regular (non-AC) gear nobody keeps is sold; AC items it doesn't need go to the bank, which
// keeps AC items for free.
'use strict';
const { parseMeta } = require('./gear');
const stylist = require('./stylist');

const SHOW = ['co', 'he', 'ba', 'Weapon'];                       // the slots "Show" works on (LPFLayoutInvShopEnh.as)
const GEAR = new Set(['Weapon', 'he', 'ba', 'co', 'pe', 'am', 'mi']);
const SLOT_NAME = { co: 'armor', he: 'helm', ba: 'cape', Weapon: 'weapon' };
const LOOKS = { female: 4, male: 2 };                            // girls may have several outfits, boys two
const BOOST_KEEP = 2;                                            // per slot and boost kind: the best two are kept
const OUTFIT_NAME_MAX = 30;                                     // outfitedit.as: maxChars 30, letters, digits, spaces

const lc = (s) => String(s || '').toLowerCase();
const isAc = (i) => Number(i.bCoins) === 1 || i.bCoins === true;
const isMember = (i) => Number(i.bUpg) === 1 || i.bUpg === true;
const usable = (i, member) => member || !isMember(i);

function looksAllowed(persona) { return LOOKS[persona && persona.sex] || LOOKS.male; }

// Up to looksAllowed() sets of armor + helm + cape + weapon this character likes (stylist.score > 0: dream pieces first,
// then its taste). Look k takes each slot's k-th favourite; a slot with fewer favourites repeats its best one. A look is
// only made while some slot still has a new piece for it.
// The colours a look is shown in (the owner, 2026-10-17: "make sure her colors matches everything"): the character's palette
// from <aqw>\Party Looks (dreams.json `colors`) with the look's own changes on top (N01 has silver hair, S09 the red
// palette). Hex strings without '#': { hair, eye, skin?, base, trim, accessory }.
function lookColors(persona, look) {
  const f = (persona && persona.fashion) || {};
  const own = look && look.code ? [...(f.main || []), ...(f.extra || [])].find((m) => m.code === look.code) : null;
  const c = { ...(f.colors || {}), ...((own && own.colors) || {}) };
  return Object.keys(c).length ? c : null;
}
// A look keeps its code and colours as hidden fields: callers read the four slots (and JSON of a look is the slots).
function tag(look, code, persona) {
  Object.defineProperty(look, 'code', { value: code || null, enumerable: false, writable: true });
  Object.defineProperty(look, 'colors', { value: lookColors(persona, { code }), enumerable: false, writable: true });
  return look;
}
// Which look today (the owner, 2026-10-17: Nova rotates N01, N03, N07, N08, N10 - "the most used is N03 then N07 and the
// others have a lower percentage"): fashion.rotation = { code: weight }; the pick is fixed for the whole (UTC) day.
// Without weights, one look after the other.
function pickLook(list, persona, now = Date.now()) {
  if (!list.length) return null;
  const day = Math.floor(now / 86400000);
  const w = (persona && persona.fashion && persona.fashion.rotation) || null;
  if (!w) return list[day % list.length];
  const weights = list.map((l) => Number(w[l.code]) || 0);
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total) return list[day % list.length];
  const x = Math.sin(day * 12.9898 + 78.233) * 43758.5453;
  let r = (x - Math.floor(x)) * total;
  for (let i = 0; i < list.length; i++) { r -= weights[i]; if (r < 0) return list[i]; }
  return list[list.length - 1];
}

function looks(persona, owned, member = false) {
  const n = looksAllowed(persona);
  // The owner's picks (2026-10-14): "the ones i choose will be their main looks". Once a main look is fully owned, the
  // character shows only its complete main looks; until then the taste below (main pieces score highest) fills in.
  // With a rotation (fashion.rotation) the extra looks it names join once complete.
  const f = (persona && persona.fashion) || {};
  const rot = f.rotation || null;
  const main = rot ? [...(f.main || []), ...(f.extra || [])].filter((m) => rot[m.code] !== undefined) : (f.main || []);
  let partial = null;
  let partialCode = null;
  if (main.length) {
    const have = (name, slot) => owned.some((i) => i && i.sES === slot && !i.bTemp && usable(i, member) && lc(i.sName) === lc(name));
    const done = [];
    let best = -1;
    for (const m of main) {
      const look = tag({}, m.code, persona);
      let ok = true;
      let got = 0;
      for (const [slot, name] of [['co', m.armor], ['he', m.helm], ['ba', m.cape], ['Weapon', m.weapon]]) {
        if (!name) continue;
        if (!have(name, slot)) { ok = false; continue; }
        look[slot] = name;
        got++;
      }
      // The look's pet (the owner 2026-10-21): worn with it when owned, but a look is complete without it - pets can be
      // long farms, and the game has no "Show" for pets (bot.wearLookPet equips it instead).
      if (m.pet && have(m.pet, 'pe')) look.pe = m.pet;
      if (ok && Object.keys(look).length) done.push(look);
      // The owner, 2026-10-17 ("all the bots are starting to look good except nova"): Nova owned the Astravian Duelist
      // armor + helm but no complete main look, so she rotated through taste looks he never picked. Until a main look
      // is complete, the closest one (its armor owned, most pieces) is the only look; its missing slots are filled below.
      if (!ok && look.co && got > best && (f.main || []).includes(m)) { best = got; partial = look; partialCode = m.code; }
    }
    if (done.length) return rot ? done : done.slice(0, n);
  }
  const bySlot = {};
  for (const slot of SHOW) {
    const seen = new Set();
    bySlot[slot] = owned
      .filter((i) => i && i.sES === slot && !i.bTemp && usable(i, member))
      .map((i) => ({ name: i.sName, score: stylist.score(i.sName, persona) }))
      .filter((x) => x.score > 0 && !seen.has(lc(x.name)) && seen.add(lc(x.name)))
      .sort((a, b) => b.score - a.score);
  }
  if (partial) {
    for (const slot of SHOW) if (!partial[slot] && bySlot[slot].length) partial[slot] = bySlot[slot][0].name;
    return [tag(partial, partialCode, persona)];
  }
  const out = [];
  for (let k = 0; k < n; k++) {
    const look = tag({}, null, persona);
    let fresh = false;
    for (const slot of SHOW) {
      const list = bySlot[slot];
      if (!list.length) continue;
      look[slot] = list[Math.min(k, list.length - 1)].name;
      if (k < list.length) fresh = true;
    }
    if (!fresh) break;
    out.push(look);
  }
  return out;
}

// Boost gear worth keeping: for every slot and boost kind (dmgAll, exp, cp, gold, rep, a race...), the best two pieces.
function boostKeep(owned, member = false) {
  const best = {};
  for (const i of owned) {
    if (!i || !GEAR.has(i.sES) || i.bTemp || !usable(i, member)) continue;
    for (const [k, v] of Object.entries(parseMeta(i.sMeta))) {
      if (k === 'ref' || !(v > 0)) continue;
      (best[`${i.sES}|${k}`] = best[`${i.sES}|${k}`] || []).push({ name: i.sName, v });
    }
  }
  const keep = new Set();
  for (const list of Object.values(best)) for (const x of list.sort((a, b) => b.v - a.v).slice(0, BOOST_KEEP)) keep.add(lc(x.name));
  return keep;
}

// What gets sold. Only regular (non-AC) gear nobody keeps, member-only gear a free account can never wear, and
// enhancement items bought but never applied. Never sold: AC items (the bank keeps them for free), materials and stacks
// (quests and merges use them up), classes, temp and house items, anything equipped or shown, anything a quest asks for.
// `keep` = lower-case names to keep; `questNeeds` = lower-case names any quest requires.
function sellPlan({ items = [], bank = [], keep = new Set(), questNeeds = new Set(), member = false }) {
  const out = [];
  const seen = new Set();
  const consider = (i, where) => {
    if (!i || isAc(i) || i.bTemp || i.bHouse || Number(i.bEquip) === 1 || i.bEquip === true || Number(i.bWear) === 1) return;
    const type = String(i.sType || '');
    if (type === 'Class' || type === 'ServerUse') return;
    const enh = type === 'Enhancement';
    if (!enh && !GEAR.has(i.sES)) return;
    if (Number(i.iQty) > 1) return;
    const n = lc(i.sName);
    if (questNeeds.has(n) || seen.has(Number(i.CharItemID))) return;
    const member0 = isMember(i) && !member;
    if (!member0 && !enh && keep.has(n)) return;
    seen.add(Number(i.CharItemID));
    out.push({ name: i.sName, ItemID: Number(i.ItemID), CharItemID: Number(i.CharItemID), iQty: Number(i.iQty) || 1, where,
      why: member0 ? 'member-only (free account)' : enh ? 'enhancement never applied' : 'nobody wears it' });
  };
  for (const i of items) consider(i, 'backpack');
  for (const i of bank) consider(i, 'bank');
  return out;
}

// Does an item carry the enhancement this class plan wants? Same rule as Skua CoreAdvanced (IsEnhanced /
// WeaponAlreadyHasRequestedEnhancement): class = type; cape/helm = their special's pattern, else the type; weapon = the
// special's ProcID with pattern type (Awe procs 1-6) or 10 (forge), else the type. `e` = knowledge.enh().
function enhMatches(item, plan, e) {
  if (!item || !plan || !e) return true;
  const type = e.typeId[plan.type];
  if (!type) return true;                                         // a class we can't place: leave it alone
  const pat = Number(item.EnhPatternID || 0);
  const proc = Number(item.ProcID || 0);
  switch (item.sES) {
    case 'ar': return pat === type;
    case 'he': return plan.helm ? pat === Number(e.helmPattern[plan.helm]) : pat === type;
    case 'ba': return plan.cape ? pat === Number(e.capePattern[plan.cape]) : pat === type;
    case 'Weapon': {
      if (!plan.weapon) return pat === type;
      const p = Number(e.weaponProc[plan.weapon] || 0);
      // The plain Forge special shares proc 1 with nothing else; which pattern the server gives it (the class type, as
      // CoreAdvanced assumes, or 10 like the other forge specials) is not known yet - either counts.
      if (plan.weapon === 'Forge') return proc === p && (pat === type || pat === 10);
      return proc === p && pat === (p > 0 && p <= 6 ? type : 10);
    }
    default: return true;
  }
}

function outfitName(cls) { return String(cls || '').replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, OUTFIT_NAME_MAX); }

// The loadout body addLoadout takes (outfitedit.as): ItemIDs per slot plus the colours.
function outfitBody(equipped, colors) {
  const body = {};
  for (const it of equipped) if (it && ['he', 'ba', 'ar', 'co', 'Weapon', 'pe', 'am', 'mi'].includes(it.sES)) body[it.sES] = Number(it.ItemID);
  body.colors = colors;
  return body;
}
function sameOutfit(a, b) {
  if (!a || !b) return false;
  return ['he', 'ba', 'ar', 'co', 'Weapon', 'pe', 'am', 'mi'].every((k) => Number(a[k] || 0) === Number(b[k] || 0));
}

module.exports = { SHOW, GEAR, SLOT_NAME, LOOKS, looksAllowed, looks, lookColors, pickLook, boostKeep, sellPlan, enhMatches, outfitName, outfitBody, sameOutfit, isAc, isMember };
