// Each persona dresses in its own style (lib/personas.js `fashion`). An item's score comes from, in order:
//   - the dream list (pieces the character picked by looking at them): always the top choice for its slot
//   - the lookbook (data/lookbook.json): the wiki's tags and description, matched against the persona's taste words
//   - the item's name, for anything the lookbook doesn't know yet (a brand-new drop)
// `veto` words rule an item out completely (the girls never wear something frumpy or silly).
// The armor slot has a cosmetic twin ('co', over the class) and pets are pure looks: both take the best match. Helm, cape
// and weapon carry enhancements, so they only change for a dream piece (enhanced right after, bot.dressUp) or for a
// piece enhanced at least as well. Boosted gear (damage / xp / gold multipliers) always beats looks.
'use strict';
const { parseMeta } = require('./gear');
const fashion = require('./fashion');

const COSMETIC = ['co', 'pe'];
const STAT = ['he', 'ba', 'Weapon'];
const SLOT_NAME = { co: 'armor', pe: 'pet', he: 'helm', ba: 'cape', Weapon: 'weapon' };

// Accepts a persona (with `fashion`) or an older bare `style` object.
function taste(p) {
  const f = (p && p.fashion) || {};
  const style = (p && p.style) || p || {};
  const lower = (a) => (a || []).map((w) => String(w).toLowerCase());
  const palette = String(style.palette || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && w !== 'and');
  return {
    love: lower(f.love || style.love),
    avoid: lower(f.avoid || style.avoid),
    veto: lower(f.veto),
    palette,
    dream: (f.dream || []).map((d) => String(d.name).toLowerCase()),
  };
}

function has(text, word) { return word && text.includes(word); }

function score(name, p) {
  const t = taste(p);
  const n = String(name || '').toLowerCase();
  const d = t.dream.indexOf(n);
  if (d >= 0) return 100 + (t.dream.length - d);
  const it = fashion.look(n);
  const tags = it ? it.tags.join(' ') : '';
  const desc = it ? String(it.desc || '').toLowerCase() : '';
  const all = `${n} ${tags} ${desc}`;
  for (const v of t.veto) if (has(all, v)) return -100;
  let s = 0;
  for (const k of t.love) {
    if (has(n, k)) s += 2;
    if (has(tags, k)) s += 2;
    else if (has(desc, k)) s += 1;
  }
  for (const k of t.palette) if (has(n, k) || has(desc, k)) s += 1;
  for (const k of t.avoid) if (has(all, k)) s -= 5;
  return s;
}

// Returns { equip: [{ slot, name, score, dream }], keep: [names worth keeping out of the bank] }.
function plan(items, p) {
  const equip = [];
  const keep = [];
  for (const slot of [...COSMETIC, ...STAT]) {
    const inSlot = items.filter((i) => i.sES === slot && !i.bTemp);
    if (!inSlot.length) continue;
    const worn = inSlot.find((i) => i.bEquip) || null;
    const boosted = worn && Object.keys(parseMeta(worn.sMeta)).length;
    const ranked = inSlot.map((i) => ({ item: i, score: score(i.sName, p) })).sort((a, b) => b.score - a.score);
    for (const r of ranked.slice(0, 3)) if (r.score > 0) keep.push(r.item.sName);
    if (boosted) continue;   // boosted gear (damage/xp/gold) beats looks
    const wornScore = worn ? score(worn.sName, p) : -1;
    // A weak match is no reason to change (Sable swapped her hood for a "Short Black Time Conductor" at score 1).
    const min = r0 => r0.score >= 100 || r0.score >= (STAT.includes(slot) ? 6 : 4);
    const best = ranked.find((r) => min(r) && r.score > wornScore && (!worn || r.item.ItemID !== worn.ItemID)
      && !(STAT.includes(slot) && r.score < 100 && worn && Number(r.item.EnhLvl || 0) < Number(worn.EnhLvl || 0)));
    if (best) equip.push({ slot: SLOT_NAME[slot], name: best.item.sName, score: best.score, dream: best.score >= 100 });
  }
  return { equip, keep };
}

module.exports = { score, plan, taste };
