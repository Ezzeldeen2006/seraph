// Class kits (the owner 2026-10-13: "make sure the bots apply the correct enchantments to their gear and when they switch a
// class they equip the required enchantments"). Skua scripts swap between the Solo and the Farm class all day
// (CoreBots.EquipClass, ~50 swaps a day per bot) and upstream Skua no longer re-enhances on a swap (the OnEquipClass
// hook in CoreAdvanced is commented out), so Blaze Binder (Wizard) fought with ArchPaladin's Lucky weapon, helm and cape.
// Each class a bot fights with gets its own weapon, helm and cape, enhanced once for that class; CoreBots wears the
// Solo and Farm kits with their class (CBO "EquipCheck" sets), Seraph wears the others (seats, help calls, raids).
//
// A forge special stays where it is (the owner, same day: "if weapon X is on Vainglory and another class needs another
// forge enchantment, don't enhance and waste money on weapon X again - leave it and enhance weapon Y"). A piece that
// carries a forge special (60k-300k) belongs to the class it was bought for: no other kit takes it, whatever its
// boosts. The main class (the Solo class unless settings.mainClass says otherwise) picks first, so the boosted pieces
// get its enhancements; every other class takes other pieces from the bag and bank.
//
// Boosts don't add up across items (one XP/gold/rep/CP boost counts; two "all damage" boosts don't stack), so a piece
// is worth what it adds to its kit. A slot two classes enhance the same way is shared.
'use strict';
const gear = require('./gear');
const wardrobe = require('./wardrobe');

const SLOTS = ['Weapon', 'he', 'ba'];
// Helm and cape first: a weapon is then judged by what it adds to them (a +25% XP helm makes Doomblade's +25% XP worth
// nothing, so a kit takes Burning Blade of Abezeth's +30% damage instead).
const ORDER = ['he', 'ba', 'Weapon'];
// What a kit values: damage (dmgAll) and the farming boosts (XP/gold/rep/CP).
const WEIGHT = { main: { dmg: 1, farm: 0.5 }, solo: { dmg: 1, farm: 0.5 }, farm: { dmg: 1, farm: 1 }, seat: { dmg: 1, farm: 0.25 } };
// Bumped when the way kits are built changes, so every bot rebuilds its kits once.
const VERSION = 3;

// The enhancement a slot needs under a plan, as a key: two classes with the same key can share the item.
function slotKey(slot, plan, e) {
  if (!plan) return null;
  if (slot === 'Weapon') {
    if (!plan.weapon) return `type:${plan.type}`;
    const p = Number(e.weaponProc[plan.weapon] || 0);
    return p > 1 && p <= 6 ? `awe:${plan.weapon}:${plan.type}` : `forge:${plan.weapon}`;
  }
  if (slot === 'he') return plan.helm ? `helm:${plan.helm}` : `type:${plan.type}`;
  if (slot === 'ba') return plan.cape ? `cape:${plan.cape}` : `type:${plan.type}`;
  return null;
}

// The forge special a piece already carries, as a slot key (same shape as slotKey), or null for none / basic / Awe.
function forgeKey(item, e) {
  if (!item || !e) return null;
  const pat = Number(item.EnhPatternID || 0);
  const name = (table, v) => Object.keys(table).find((k) => k !== 'None' && Number(table[k]) === v) || null;
  if (item.sES === 'Weapon') {
    const proc = Number(item.ProcID || 0);
    if (proc > 6) { const n = name(e.weaponProc, proc); return n ? `forge:${n}` : null; }
    if (proc === 1 && pat === 10) return 'forge:Forge';
    return null;
  }
  if (item.sES === 'he' && pat >= 10) { const n = name(e.helmPattern, pat); return n ? `helm:${n}` : null; }
  if (item.sES === 'ba' && pat >= 10) { const n = name(e.capePattern, pat); return n ? `cape:${n}` : null; }
  return null;
}

function boosts(item) {
  const m = gear.parseMeta(item && item.sMeta);
  return { dmg: m.dmgall || 0, farm: Math.max(m.exp || 0, m.gold || 0, m.rep || 0, m.cp || 0) };
}

// Items that can sit in a kit: owned, not temporary, not member-only on a free account, a real weapon/helm/cape, not
// one the server refused to enhance (`exclude`, bot.noEnhance).
function candidates(items, bank, slot, member, exclude = null) {
  const seen = new Set();
  const out = [];
  for (const [list, inBank] of [[items || [], false], [bank || [], true]]) {
    for (const i of list) {
      if (!i || i.sES !== slot || i.bTemp || String(i.sType) === 'ServerUse') continue;
      if (!member && (Number(i.bUpg) === 1 || i.bUpg === true)) continue;
      const k = String(i.sName).toLowerCase();
      if (seen.has(k) || (exclude && exclude.has(k))) continue;
      seen.add(k);
      out.push({ item: i, inBank });
    }
  }
  return out;
}

// All kits of a set, old shape ({solo, farm}) or new ({list: [...]}).
function all(kits) {
  if (!kits) return [];
  if (Array.isArray(kits.list)) return kits.list;
  return ['solo', 'farm'].map((r) => kits[r]).filter(Boolean);
}

// roles: [{ role: 'solo'|'farm'|'seat', cls, plan }], the main class first (it takes the boosted pieces). The older
// call shape `plans: { solo: {cls, plan}, farm: {cls, plan} }` still works. prev: the last kits (sticky; a class may
// change the forge special on its own piece when its plan changes). exclude: names never to use. avoid: names a quest
// takes (a turn-in can use them up). Returns { solo, farm, list: [{ role, cls, Weapon, he, ba }] }.
function build({ roles = null, plans = null, items, bank, member = false, e, prev = null, exclude = null, avoid = null }) {
  if (!roles) roles = ['solo', 'farm'].filter((r) => plans && plans[r] && plans[r].cls).map((r) => ({ role: r, ...plans[r] }));
  const seenCls = new Set();
  roles = roles.filter((r) => { const c = String(r.cls).toLowerCase(); if (seenCls.has(c)) return false; seenCls.add(c); return true; });
  const prevOf = (cls) => all(prev).find((k) => String(k.cls).toLowerCase() === String(cls).toLowerCase()) || null;
  const list = roles.map((r) => ({ role: r.role, cls: r.cls }));
  const have = list.map(() => ({ dmg: 0, farm: 0 }));   // the best boosts each kit already holds
  for (const slot of ORDER) {
    const pool = candidates(items, bank, slot, member, exclude);
    const taken = new Map();   // item name (lower) -> the slot key it is enhanced for in a kit
    roles.forEach((r, i) => {
      const key = slotKey(slot, r.plan, e);
      // A class before it enhances this slot the same way: share its piece.
      const j = roles.findIndex((o, k) => k < i && list[k][slot] && slotKey(slot, o.plan, e) === key);
      if (j >= 0) { list[i][slot] = list[j][slot]; return; }
      const mine = prevOf(r.cls);
      let best = null;
      for (const c of pool) {
        const n = String(c.item.sName).toLowerCase();
        if (taken.has(n) && taken.get(n) !== key) continue;   // another kit's piece, enhanced another way
        // A forge special belongs to its class: never bought over for another one. Only the class that holds the
        // piece in its kit may change it (its own plan got better).
        const fk = forgeKey(c.item, e);
        const own = mine && String(mine[slot] || '').toLowerCase() === n;
        if (fk && fk !== key && !own) continue;
        const b = boosts(c.item);
        const w = WEIGHT[i === 0 ? 'main' : r.role] || WEIGHT.seat;
        // What it adds to the kit, plus a little of its raw boost so a boosted piece still wins a tie (in case
        // boosts do add up after all).
        let score = w.dmg * Math.max(0, b.dmg - have[i].dmg) + w.farm * Math.max(0, b.farm - have[i].farm) + 0.01 * (b.dmg + b.farm);
        if (fk && fk === key) score += 0.05;   // already carries this very forge special: 60k-300k not spent again
        if (r.plan && wardrobe.enhMatches(c.item, r.plan, e) && Number(c.item.EnhLvl || 0) > 0) score += 0.002;
        if (own) score += 0.003;
        if (!c.inBank) score += 0.001;
        score += Math.min(Number(c.item.EnhLvl || 0), 100) / 1e6;
        // A quest ingredient, or an old fixed enhancement (pattern 1 / 23, which the server may not change): last resort.
        if (avoid && avoid.has(n)) score -= 0.005;
        if ([1, 23].includes(Number(c.item.EnhPatternID))) score -= 0.005;
        if (!best || score > best.score) best = { score, name: c.item.sName, n };
      }
      if (best) { list[i][slot] = best.name; taken.set(best.n, key); }
    });
    list.forEach((k, i) => {
      const it = k[slot] && pool.find((c) => c.item.sName === k[slot]);
      if (it) { const b = boosts(it.item); have[i].dmg = Math.max(have[i].dmg, b.dmg); have[i].farm = Math.max(have[i].farm, b.farm); }
    });
  }
  const out = { list };
  for (const r of ['solo', 'farm']) { const k = list.find((x) => x.role === r); if (k) out[r] = k; }
  // The Solo and Farm picks can be the same class: then both point at that one kit.
  for (const r of ['solo', 'farm']) {
    const want = roles.find((x) => x.role === r) || (plans && plans[r]);
    if (!out[r] && want) out[r] = list.find((x) => String(x.cls).toLowerCase() === String(want.cls).toLowerCase()) || null;
  }
  return out;
}

// Every item name a kit holds (kept in the backpack, never banked or sold).
function names(kits) {
  const out = new Set();
  for (const k of all(kits)) for (const s of SLOTS) if (k && k[s]) out.add(String(k[s]).toLowerCase());
  return out;
}

// The kit for a class name, or null.
function forClass(kits, cls) {
  const c = String(cls || '').toLowerCase();
  return all(kits).find((k) => String(k.cls).toLowerCase() === c) || null;
}

// The class whose kit holds this piece in this slot, or null.
function ownerOf(kits, slot, name) {
  const n = String(name || '').toLowerCase();
  const k = all(kits).find((x) => String(x[slot] || '').toLowerCase() === n);
  return k ? k.cls : null;
}

// CoreBots option keys for the kits: set 1 = Solo, set 2 = Farm (CoreBots.ReadCBO "Helm1Select" ... "Weapon2Select").
// With a kit on, Skua's own enhancing is off (DisableAutoEnhance): many scripts call SmartEnhance / GearStore(EnhAfter)
// with CoreAdvanced's all-or-nothing library, which would put basic enhancements back over the kits' forge specials
// (300k each) for Seraph to buy again. A class a script gets unenhanced is still enhanced (SmartEnhance ForceEnh).
function cboKeys(kits) {
  const keys = {};
  for (const [r, n] of [['solo', 1], ['farm', 2]]) {
    const k = kits && kits[r];
    const on = !!(k && SLOTS.some((s) => k[s]));
    keys[r === 'solo' ? 'SoloEquipCheck' : 'FarmEquipCheck'] = on ? 'True' : 'False';
    keys[`Weapon${n}Select`] = (on && k.Weapon) || '';
    keys[`Helm${n}Select`] = (on && k.he) || '';
    keys[`Cape${n}Select`] = (on && k.ba) || '';
  }
  keys.DisableAutoEnhance = keys.SoloEquipCheck === 'True' || keys.FarmEquipCheck === 'True' ? 'True' : 'False';
  return keys;
}

module.exports = { VERSION, SLOTS, slotKey, forgeKey, boosts, candidates, build, all, names, forClass, ownerOf, cboKeys };
