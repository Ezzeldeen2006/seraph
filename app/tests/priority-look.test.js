// The owner 2026-10-19: Nova's N12 (IshidoVI's look) is "the highest priority of outfits" - its pieces come before every
// other wish, and ultra focus (noStyleTime) still lets them be farmed (brain step 7c, opts.priorityOnly).
const fashion = require('../lib/fashion');

const persona = (priority) => ({
  fashion: {
    ...(priority ? { priority } : {}),
    main: [
      { code: 'N03', armor: 'Astravian Urban Duelist', helm: 'Astravian Urban Duelist Locks' },
      { code: 'N12', armor: 'Hollowborn Vampire', helm: 'ShadowFlame Empress Locks', weapon: 'Hollowborn Thunderlord Lightning' },
    ],
    dream: [
      { name: 'Astravian Urban Duelist Locks', slot: 'helm' },
      { name: 'Hollowborn Vampire', slot: 'armor' },
      { name: 'ShadowFlame Empress Locks', slot: 'helm' },
    ],
    seasonal: [],
  },
});
const bot = (owned) => ({ owns: async (n) => owned.includes(n) });

test('priority look: its pieces come first, and priorityOnly allows nothing else', async () => {
  eq((await fashion.nextWish(bot([]), persona(null), {})).name, 'Astravian Urban Duelist Locks', 'without a priority: dream order');
  const w = await fashion.nextWish(bot([]), persona('N12'), {});
  eq(w.name, 'Hollowborn Vampire');
  eq(w.priority, 'N12');
  eq((await fashion.nextWish(bot(['Hollowborn Vampire']), persona('N12'), {}, null, { priorityOnly: true })).name, 'ShadowFlame Empress Locks');
  eq(await fashion.nextWish(bot(['Hollowborn Vampire', 'ShadowFlame Empress Locks']), persona('N12'), {}, null, { priorityOnly: true }), null, 'look done: nothing under ultra focus');
  eq((await fashion.nextWish(bot(['Hollowborn Vampire', 'ShadowFlame Empress Locks']), persona('N12'), {})).name, 'Astravian Urban Duelist Locks', 'then the other main pieces');
});

// The owner 2026-10-20: NX2 is Nova's top priority, N12 second - a ranked list, each look done before the next.
test('priority look: a ranked list farms the first look, then the second, and nothing else under ultra focus', async () => {
  const p = persona(['N03', 'N12']);
  eq((await fashion.nextWish(bot([]), p, {}, null, { priorityOnly: true })).name, 'Astravian Urban Duelist Locks');
  const w = await fashion.nextWish(bot(['Astravian Urban Duelist', 'Astravian Urban Duelist Locks']), p, {}, null, { priorityOnly: true });
  eq(w.name, 'Hollowborn Vampire');
  eq(w.priority, 'N12', 'the wish names the look it serves');
  eq(await fashion.nextWish(bot(['Astravian Urban Duelist', 'Astravian Urban Duelist Locks', 'Hollowborn Vampire', 'ShadowFlame Empress Locks']), p, {}, null, { priorityOnly: true }), null);
});

test('priority look: Nova ranks NX2 > N12 > N03; Sable is back on S01 (the owner 2026-10-21), SR2 still in rotation', async () => {
  const d = require('../data/dreams.json');
  const n = d.nova7;
  eq(JSON.stringify(n.priority), '["NX2","N12"]');
  eq(Object.entries(n.rotation).sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0]).join(','), 'NX2,N12,N03');
  eq(n.dream[0].name, "Aurola's Casual Wear", 'NX2 pieces lead the dream list');
  const s = d.sable7;
  eq(JSON.stringify(s.priority), '[]');
  eq(s.main[0].code, 'S01', 'S01 Hollowborn Witch is her main look again');
  assert(s.rotation.S01 > s.rotation.SR2, 'S01 is shown most');
  assert(s.rotation.SR2 > 0 && s.main.some((m) => m.code === 'SR2'), 'SR2 is a main look in her rotation');
  const p = require('../lib/personas').get('nova7');
  eq(JSON.stringify(p.fashion.priority), '["NX2","N12"]', 'personas carries it into fashion');
});
