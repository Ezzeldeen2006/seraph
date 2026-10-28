// Boost-aware gear (same idea as Skua CoreBots.GetBestItem): every AQW item carries its boosts in `sMeta`. Before a task
// the bot wears the owned pieces (backpack or bank) with the best boosts for that job: damage for bosses/quests (+ the
// monster's race), XP + class points for leveling, gold for gold farms, rep for reputation farms.
const SLOTS = ['Weapon', 'he', 'ba', 'co', 'pe'];

// Boosts as fractions: +15% is 0.15. The game writes multipliers ("dmgAll:1.15" on Burning Blade, "Undead:1.10,Chaos:1.10"
// on Blade of Awe); read raw, 1.15 looked like +115%, every weapon passed the 30% ultra minimum and two +10% boosts
// (2.2) beat one +50% (2026-09-22). A value already below 1 is taken as a fraction.
function parseMeta(meta) {
  const out = {};
  for (const part of String(meta || '').split(',')) {
    const [k, v] = part.split(':');
    const n = Number(v);
    if (k && v !== undefined && v.trim() !== '' && !Number.isNaN(n)) out[k.trim().toLowerCase()] = n >= 1 ? Math.round((n - 1) * 10000) / 10000 : n;
  }
  return out;
}

function boostScore(item, wants) {
  const m = parseMeta(item && item.sMeta);
  return wants.reduce((t, w) => t + (m[String(w).toLowerCase()] || 0), 0);
}

// Boost keys for a kind of task.
function wantsFor(kind, race = null) {
  const r = race ? [String(race)] : [];
  switch (kind) {
    case 'exp': return ['exp', 'cp'];
    case 'gold': return ['gold', 'dmgAll'];
    case 'rep': return ['rep', 'dmgAll'];
    case 'boss': return ['dmgAll', ...r];
    default: return ['dmgAll', ...r];
  }
}

// Plan: for each slot, the owned item with the highest boost if it beats what's worn. A weapon swap must not drop more
// than 5 enhancement levels unless the boost is big (≥ 30%), so a +51% sword isn't ignored and a +5% stick isn't worn.
function plan(items, wants, bankItems = []) {
  const picks = [];
  for (const slot of SLOTS) {
    const worn = items.find((i) => i.sES === slot && i.bEquip) || null;
    const wornScore = worn ? boostScore(worn, wants) : 0;
    const pool = [...items.filter((i) => i.sES === slot && !i.bTemp), ...bankItems.filter((i) => i.sES === slot).map((i) => ({ ...i, inBank: true }))];
    const best = pool
      .map((i) => ({ item: i, score: boostScore(i, wants) }))
      .filter((x) => x.score > wornScore + 0.001)
      .filter((x) => slot !== 'Weapon' || !worn || x.score >= 0.3 || Number(x.item.EnhLvl || 0) >= Number(worn.EnhLvl || 0) - 5)
      .sort((a, b) => b.score - a.score)[0];
    if (best) picks.push({ slot, name: best.item.sName, score: Math.round(best.score * 100), inBank: !!best.item.inBank, item: best.item });
  }
  return picks;
}

module.exports = { parseMeta, boostScore, wantsFor, plan, SLOTS };
