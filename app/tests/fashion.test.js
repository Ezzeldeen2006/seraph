// Fashion (2026-09-24): personas with their own look, dream outfits, me time (1 h a day, up to 4 h), events 2 h a day.
const fs = require('fs');
const path = require('path');
const { FakeGame } = require('./fakegame');
const { Bot } = require('../lib/bot');
const { Brain } = require('../lib/brain');
const { P } = require('../lib/paths');
const knowledge = require('../lib/knowledge');
const personas = require('../lib/personas');
const stylist = require('../lib/stylist');
const fashion = require('../lib/fashion');

async function bot(id, level, persona, hub = null) {
  const dir = P.account(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'login.txt'), `Username: ${id}\nPassword: pw\n`);
  const b = new Bot(new FakeGame({ level }), { id, label: id, username: id, loginFile: path.join(dir, 'login.txt'), persona, status: 'active' }, { hub });
  await b.login();
  return b;
}

const BOOK = {
  items: {
    'velvet seraph gown': { name: 'Velvet Seraph Gown', slot: 'armor', free: true, member: false, tags: ['angel', 'dress'], desc: 'A gown for a goddess.', routes: [{ kind: 'merge', script: 'Other/MergeShops/GrimGiftMerge.cs', map: 'doomvault', shop: 655 }] },
    'member wings': { name: 'Member Wings', slot: 'cape', free: false, member: true, tags: ['wing'], desc: '', routes: [{ kind: 'shop', map: 'x', shop: 2 }] },
    'rusty bucket': { name: 'Rusty Bucket', slot: 'helm', free: true, member: false, tags: ['peasant'], desc: 'A peasant hat.', routes: [] },
  },
};

const withDream = (id, dream) => ({ ...personas.get(id), fashion: { ...personas.get(id).fashion, dream } });

test('personas v2: four different looks, 2 h of events for everyone, a vanity each', async () => {
  const ids = ['sable7', 'valen7', 'nova7', 'oren7'];
  const looks = ids.map((id) => personas.get(id).fashion.identity);
  eq(new Set(looks).size, 4, 'four identities');
  for (const id of ids) {
    eq(personas.tuning(personas.get(id)).maxEventHours, 2, `${id}: 2 h of events`);
    assert(personas.get(id).fashion.vanity > 0 && personas.get(id).version === 2, id);
  }
  assert(personas.get('sable7').fashion.vanity > personas.get('valen7').fashion.vanity, 'the diva is vainer than the vanguard');
});

test('stylist: each persona wears its own style, vetoes the silly stuff, dream pieces come first', async () => {
  fashion.reload(BOOK);
  try {
    const items = [
      { sName: 'Velvet Seraph Gown', ItemID: 1, sES: 'co' },
      { sName: 'Legion DoomKnight Plate', ItemID: 2, sES: 'co' },
      { sName: 'Scarlet Blood Kunoichi Corset', ItemID: 3, sES: 'co' },
      { sName: 'Soulfire Oni Warmonger', ItemID: 4, sES: 'co' },
      { sName: 'Clown Nose', ItemID: 5, sES: 'he', bEquip: true, EnhLvl: 50 },
      { sName: 'Crimson Kitsune Rose Locks', ItemID: 6, sES: 'he', EnhLvl: 10 },
      { sName: 'Night Fox Rose Locks', ItemID: 7, sES: 'he', EnhLvl: 60 },
    ];
    const armor = (id) => stylist.plan(items, personas.get(id)).equip.find((e) => e.slot === 'armor').name;
    eq(armor('sable7'), 'Velvet Seraph Gown');
    eq(armor('valen7'), 'Legion DoomKnight Plate');
    eq(armor('nova7'), 'Scarlet Blood Kunoichi Corset');
    eq(armor('oren7'), 'Soulfire Oni Warmonger');   // restyled 2026-10-14: badass, no more kimonos
    eq(stylist.plan(items, personas.get('nova7')).equip.find((e) => e.slot === 'helm').name, 'Night Fox Rose Locks', 'never trades enhancement for a mere match');
    eq(stylist.score('Moglin Onesie', personas.get('sable7')), -100, 'vetoed');
    eq(stylist.score('Rusty Bucket', personas.get('nova7')), -100, 'vetoed from the lookbook tags');
    const p = withDream('nova7', [{ name: 'Crimson Kitsune Rose Locks', slot: 'helm' }]);
    const pick = stylist.plan(items, p).equip.find((e) => e.slot === 'helm');
    eq([pick.name, pick.dream], ['Crimson Kitsune Rose Locks', true], 'a dream helm beats enhancement (it is enhanced right after)');
  } finally { fashion.reload(); }
});

test('fashion: routes skip member items; keep going after the hour depends on vanity and progress, never past 4 h', async () => {
  fashion.reload(BOOK);
  try {
    eq(fashion.route('Velvet Seraph Gown').kind, 'merge');
    eq(fashion.route('Member Wings'), null, 'member-only');
    const t = fashion.taskFor(personas.get('sable7'), { name: 'Velvet Seraph Gown', why: 'a gown for a goddess' });
    eq([t.type, t.entry, t.args, t.style, t.wish], ['script', 'BuyAllMerge', '"Velvet Seraph Gown"', true, 'Velvet Seraph Gown']);
    const h = 3600000;
    const sera = personas.get('sable7'); const vae = personas.get('valen7');
    assert(fashion.keepGoing(sera, 1 * h, true).go, 'the diva stays another hour');
    assert(!fashion.keepGoing(vae, 1 * h, true).go, 'the vanguard goes back to work');
    assert(!fashion.keepGoing(sera, 1 * h, false).go, 'not while the farm is stuck');
    assert(!fashion.keepGoing(sera, 4 * h, true).go, 'hard 4 h cap');
  } finally { fashion.reload(); }
});

test('brain: me time picks the dream piece after dailies, 1 h a day; the hour ends in a decision; events cap at 2 h', async () => {
  fashion.reload(BOOK);
  const d = knowledge.dailies; const e = knowledge.eventCandidates; const skip = process.env.SERAPH_TEST_SKIP_FJ; const noStyle = process.env.SERAPH_TEST_NO_STYLE;
  knowledge.dailies = () => []; knowledge.eventCandidates = () => [];
  process.env.SERAPH_TEST_SKIP_FJ = '1'; process.env.SERAPH_TEST_NO_STYLE = '0';
  try {
    const brain = new Brain({ hub: { bots: new Map() } });
    const b = await bot('dreamer', 45, 'sable7');
    const sera = withDream('sable7', [{ name: 'Velvet Seraph Gown', slot: 'armor', why: 'a gown for a goddess' }]);
    brain.persona = () => sera;
    const day = brain.today(b);
    day.enhancedAt = day.styledAt = Date.now(); brain.state(b).barberAt = Date.now();
    const t = await brain.next(b);
    eq([t.type, t.wish, t.style], ['script', 'Velvet Seraph Gown', true], `me time (${t.why})`);

    // an hour in: the vain diva keeps going while the farm moves...
    b.current = { ...t, startedAt: Date.now() - 50 * 60000 };
    eq(await brain.preempt(b), null, 'inside the hour');
    b.stats.drops += 3;
    b.current.startedAt = Date.now() - 65 * 60000;
    eq(await brain.preempt(b), null, 'another hour');
    eq(brain.today(b).styleAllowMs, 2 * 3600000);
    // ...the vanguard does not.
    const vae = withDream('valen7', [{ name: 'Velvet Seraph Gown', slot: 'armor' }]);
    brain.persona = () => vae;
    const b2 = await bot('vanguard', 45, 'valen7');
    b2.current = { ...t, startedAt: Date.now() - 50 * 60000 };
    await brain.preempt(b2);
    b2.stats.drops += 3;
    b2.current.startedAt = Date.now() - 65 * 60000;
    const stop = await brain.preempt(b2);
    assert(stop && stop.styleCap, `back to work (${JSON.stringify(stop)})`);
    await brain.interrupted(b2, b2.current);
    b2.current = null;
    assert(!(await brain.next(b2)).style, 'no more me time today');

    // got it: the wish is done and the next tick dresses up
    b.current = null;
    await brain.wishEnded(b, { ...t, startedAt: Date.now() - 10 * 60000 }, true);
    assert(!(brain.state(b).wishFails || {})['Velvet Seraph Gown'], 'a merge that ran fine but is not done yet is no strike');
    await brain.wishEnded(b, { ...t, startedAt: Date.now() - 10 * 60000 }, false);
    eq(brain.state(b).wishFails['Velvet Seraph Gown'].n, 1, 'a failed one is');
    b.client.root.world.myAvatar.items.push({ sName: 'Velvet Seraph Gown', ItemID: 990, CharItemID: 990, sES: 'co', iQty: 1 });
    await brain.wishEnded(b, { ...t, startedAt: Date.now() - 10 * 60000 }, true);
    assert(brain.state(b).wishGot['Velvet Seraph Gown'] && b._styleDirty, 'got it: dress up next');

    // events: a 3 h setting is still 2 h
    b.settings.maxEventHours = 3;
    eq(brain.eventCapH(b), 2);
  } finally { knowledge.dailies = d; knowledge.eventCandidates = e; process.env.SERAPH_TEST_SKIP_FJ = skip; process.env.SERAPH_TEST_NO_STYLE = noStyle; fashion.reload(); }
});

test('bot: a drop it loves makes it say so and dress up next', async () => {
  fashion.reload(BOOK);
  try {
    const b = await bot('crush', 60, 'sable7');
    b.noticeLook('Velvet Seraph Gown');
    assert(b._styleDirty, 'dress up soon');
    assert(b.lastLog.some((l) => /Sable: /.test(l)), 'she says something');
    b._styleDirty = false;
    b.noticeLook('Iron Bucket');
    assert(!b._styleDirty, 'not every drop');
  } finally { fashion.reload(); }
});

// ---------- seasonal / event items (2026-09-24: "make sure you went through birthday items, seasonal items") ----------
const SEASON = {
  items: {
    'birthday cake hat': { name: 'Birthday Cake Hat', slot: 'helm', free: true, member: false, tags: ['birthday'], desc: '', seasonal: true, routes: [{ kind: 'drop', map: 'battleontown', monster: 'Frogzard', event: 'AQWBirthday' }] },
    'frost gown': { name: 'Frost Gown', slot: 'armor', free: true, member: false, tags: [], desc: '', seasonal: true, routes: [{ kind: 'shopFind', map: 'frostvale', shops: [11, 12], gold: 5000, event: 'Frostval' }] },
    'plain cape': { name: 'Plain Cape', slot: 'cape', free: true, member: false, tags: [], desc: '', routes: [{ kind: 'shopFind', map: 'battleon', shops: [21, 22], gold: 100 }] },
  },
};

test('fashion: seasonal routes wait for their event; a live event\'s wish goes first ("limited time")', async () => {
  fashion.reload(SEASON);
  try {
    eq(fashion.route('Birthday Cake Hat', {}), null, 'closed event: no route');
    assert(fashion.waitsForEvent('Birthday Cake Hat', {}), 'it waits for AQWBirthday');
    eq(fashion.route('Birthday Cake Hat', { AQWBirthday: true }).kind, 'drop', 'open while the event is live');
    eq(fashion.route('Plain Cape', {}).kind, 'shopFind', 'not seasonal: always open');
    const p = { ...personas.get('nova7'), fashion: { ...personas.get('nova7').fashion, main: [], dream: [{ name: 'Plain Cape', slot: 'cape' }], seasonal: [{ name: 'Birthday Cake Hat', slot: 'helm', why: 'birthday!' }] } };
    const b = await bot('seasoner', 60, 'nova7');
    eq((await fashion.nextWish(b, p, {}, {})).name, 'Plain Cape', 'no event live: the dream list');
    const w = await fashion.nextWish(b, p, {}, { AQWBirthday: true });
    eq([w.name, w.limited], ['Birthday Cake Hat', 'AQWBirthday'], 'the live event\'s piece jumps the queue');
    const t = fashion.taskFor(p, w, { AQWBirthday: true });
    eq([t.type, t.route.kind, t.wishEvent], ['wish', 'drop', 'AQWBirthday']);
    assert(/limited/.test(t.why), t.why);
  } finally { fashion.reload(); }
});

test('brain: event time goes to what the character wants from that event before its storyline', async () => {
  fashion.reload(SEASON);
  const d = knowledge.dailies; const e = knowledge.eventCandidates; const skip = process.env.SERAPH_TEST_SKIP_FJ; const noStyle = process.env.SERAPH_TEST_NO_STYLE;
  knowledge.dailies = () => [];
  knowledge.eventCandidates = () => [{ folder: 'AQWBirthday', maps: ['battleontown'], scripts: ['Seasonal/AQWBirthday/SomeStory.cs'] }];
  process.env.SERAPH_TEST_SKIP_FJ = '1'; process.env.SERAPH_TEST_NO_STYLE = '0';
  try {
    const brain = new Brain({ hub: { bots: new Map() } });
    const b = await bot('partygirl', 45, 'nova7');
    const p = { ...personas.get('nova7'), fashion: { ...personas.get('nova7').fashion, dream: [], seasonal: [{ name: 'Birthday Cake Hat', slot: 'helm' }] } };
    brain.persona = () => p;
    const day = brain.today(b);
    day.enhancedAt = day.styledAt = Date.now(); brain.state(b).barberAt = Date.now();
    day.events.AQWBirthday = true;
    const t = await brain.next(b);
    eq([t.type, t.item, t.event, t.countAs], ['wish', 'Birthday Cake Hat', 'AQWBirthday', 'event'], t.why);
    await brain.interrupted(b, { ...t, startedAt: Date.now() - 20 * 60000 });
    assert(day.eventMs >= 19 * 60000 && day.styleMs === 0, `booked as event time, not me time (${day.eventMs}/${day.styleMs})`);
  } finally { knowledge.dailies = d; knowledge.eventCandidates = e; process.env.SERAPH_TEST_SKIP_FJ = skip; process.env.SERAPH_TEST_NO_STYLE = noStyle; fashion.reload(); }
});

test('bot: a wish finds the gold shop on its map that sells it, and farms a drop until it has it', async () => {
  const cape = { ItemID: 7001, sName: 'Plain Cape', sES: 'ba', iCost: 100, bUpg: 0, iQty: 1 };
  const drop = { ItemID: 7002, sName: 'Birthday Cake Hat', sES: 'he', bTemp: 0, iQty: 1 };
  const game = new FakeGame({ level: 60, shops: { 21: [{ ItemID: 1, sName: 'Stick' }], 22: [cape] }, monsterDrops: { Frogzard: drop } });
  const dir = P.account('wisher'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'login.txt'), 'Username: wisher\nPassword: pw\n');
  const b = new Bot(game, { id: 'wisher', label: 'wisher', username: 'wisher', loginFile: path.join(dir, 'login.txt'), persona: 'nova7', status: 'active' });
  await b.login();
  assert(await b.getWish({ item: 'Plain Cape', route: { kind: 'shopFind', map: 'battleon', shops: [21, 22] } }), 'bought from the second shop');
  assert(await b.owns('Plain Cape'));
  assert(await b.getWish({ item: 'Birthday Cake Hat', route: { kind: 'drop', map: 'battleon', monster: 'Frogzard' } }), 'farmed the drop');
  assert(await b.owns('Birthday Cake Hat'));
});

test('brain: a fight that is too strong rests that route for every wish that uses it, not "out of season"', async () => {
  fashion.reload(SEASON);
  try {
    const brain = new Brain({ hub: { bots: new Map() } });
    const b = await bot('toostrong', 60, 'nova7');
    const r = SEASON.items['birthday cake hat'].routes[0];
    const t = { type: 'wish', route: r, item: 'Birthday Cake Hat', wish: 'Birthday Cake Hat', wishEvent: 'AQWBirthday', style: true, brain: true, startedAt: Date.now() - 60000 };
    brain.today(b).events.AQWBirthday = true;
    await brain.failed(b, t, new Error('too strong: died 3x hunting Frogzard'));
    assert(brain.state(b).routeFails[fashion.routeKey(r)], 'route rested');
    assert(!b.lastLog.some((l) => /out of season/.test(l)), 'not called out of season');
    eq(fashion.route('Birthday Cake Hat', { AQWBirthday: true }, brain.state(b).routeFails), null, 'no way to get it for now');
  } finally { fashion.reload(); }
});

// 2026-10-14: Oren's Soulfire set merges at /darkwarlegion, a Dage staff-birthday map that never closed again.
// events.json only calls StaffBirthdays live when the news names it, so the wish waited for ever.
test('fashion: event-tagged routes on maps that stay open all year count every day', async () => {
  fashion.reload({ items: {
    'flaming soulfire cloak': { name: 'Flaming Soulfire Cloak', slot: 'cape', free: true, member: false, tags: [], desc: '', routes: [{ kind: 'drop', map: 'darkwarlegion', monster: 'Dreadfiend', event: 'StaffBirthdays' }] },
    'party hat': { name: 'Party Hat', slot: 'helm', free: true, member: false, tags: [], desc: '', routes: [{ kind: 'drop', map: 'artixbirthday', monster: 'Cake', event: 'StaffBirthdays' }] },
  } });
  try {
    eq(fashion.route('Flaming Soulfire Cloak', {}).map, 'darkwarlegion', 'open map: farmed without the event');
    assert(!fashion.waitsForEvent('Flaming Soulfire Cloak', {}), 'nothing to wait for');
    eq(fashion.route('Party Hat', {}), null, 'other staff-birthday maps still wait');
  } finally { fashion.reload(); }
});

test('main looks first; extra looks only in free time; live main pieces before seasonal', async () => {
  fashion.reload({ items: {
    'main suit': { name: 'Main Suit', slot: 'armor', routes: [{ kind: 'drop', map: 'a', monster: 'x' }] },
    'main hat': { name: 'Main Hat', slot: 'helm', routes: [{ kind: 'drop', map: 'b', monster: 'y', event: 'Mogloween' }] },
    'extra coat': { name: 'Extra Coat', slot: 'armor', routes: [{ kind: 'drop', map: 'c', monster: 'z' }] },
    'spooky dress': { name: 'Spooky Dress', slot: 'armor', routes: [{ kind: 'drop', map: 'd', monster: 'w', event: 'Mogloween' }] },
  } }, {});
  const owned = new Set();
  const fb = { owns: async (n) => owned.has(n) };
  const p = { fashion: { main: [{ code: 'M1' }], dream: [{ name: 'Main Suit' }, { name: 'Main Hat' }], later: [{ name: 'Extra Coat' }], seasonal: [{ name: 'Spooky Dress' }] } };
  const st = {};
  eq((await fashion.nextWish(fb, p, st, { Mogloween: true })).name, 'Main Hat', 'live main piece first');
  eq((await fashion.nextWish(fb, p, st, { Mogloween: false })).name, 'Main Suit', 'then main pieces in order');
  owned.add('Main Suit'); owned.add('Main Hat');
  eq((await fashion.nextWish(fb, p, st, { Mogloween: true })).name, 'Spooky Dress', 'main done: a live seasonal wish');
  eq(await fashion.nextWish(fb, p, st, { Mogloween: false }), null, 'no extras outside free time');
  eq((await fashion.nextWish(fb, p, st, { Mogloween: false }, { free: true })).name, 'Extra Coat', 'free time: the extra looks');
  fashion.reload(null, null);
});
