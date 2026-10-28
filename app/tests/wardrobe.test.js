// Wardrobe (lib/wardrobe.js, the owner 2026-10-07): looks per persona, what is kept / sold / banked, outfits per class,
// enhancements that fit the class.
const fs = require('fs');
const path = require('path');
const wardrobe = require('../lib/wardrobe');
const knowledge = require('../lib/knowledge');
const { FakeGame } = require('./fakegame');
const { Bot } = require('../lib/bot');
const { P } = require('../lib/paths');

const girl = { sex: 'female', name: 'G', fashion: { dream: [{ name: 'Dream Hood' }], love: ['crimson', 'shadow'], veto: ['frumpy'] }, style: { palette: 'black crimson' } };
const boy = { ...girl, sex: 'male' };
const piece = (sName, sES, extra = {}) => ({ sName, sES, ItemID: Math.floor(Math.random() * 1e6), CharItemID: Math.floor(Math.random() * 1e9), iQty: 1, bCoins: 0, ...extra });

test('wardrobe: girls get up to 4 looks, boys 2; dream pieces lead; member pieces only for members', async () => {
  const owned = [
    piece('Dream Hood', 'he'), piece('Crimson Hood', 'he'), piece('Shadow Mask', 'he'), piece('Crimson Shadow Helm', 'he'), piece('Shadow Crimson Visor', 'he'),
    piece('Crimson Shadow Plate', 'co'), piece('Shadow Robe', 'co'),
    piece('Crimson Blade', 'Weapon'), piece('Shadow Wings', 'ba'),
    piece('Crimson Member Cape', 'ba', { bUpg: 1 }), piece('Frumpy Crimson Hat', 'he'),
  ];
  const g = wardrobe.looks(girl, owned, false);
  eq(g.length, 4, 'four looks: the helm slot has 4+ liked pieces');
  eq(g[0].he, 'Dream Hood', 'dream piece first');
  assert(!g.some((l) => l.ba === 'Crimson Member Cape'), 'no member piece on a free account');
  assert(!g.some((l) => l.he === 'Frumpy Crimson Hat'), 'vetoed');
  eq(g[3].Weapon, 'Crimson Blade', 'a slot with one favourite repeats it');
  eq(wardrobe.looks(boy, owned, false).length, 2, 'boys: two');
  assert(wardrobe.looks(girl, owned, true).some((l) => l.ba === 'Crimson Member Cape'), 'members may show member pieces');
});

test('wardrobe: boost gear - the best two per slot and boost kind are kept', async () => {
  const owned = [
    piece('Blade 51', 'Weapon', { sMeta: 'dmgAll:1.51' }), piece('Blade 40', 'Weapon', { sMeta: 'dmgAll:1.40' }), piece('Blade 30', 'Weapon', { sMeta: 'dmgAll:1.30' }),
    piece('XP Helm', 'he', { sMeta: 'exp:1.25' }), piece('Undead Cape', 'ba', { sMeta: 'Undead:1.10' }), piece('Class', 'ar', { sMeta: '108', sType: 'Class' }),
  ];
  const k = wardrobe.boostKeep(owned, false);
  eq(['blade 51', 'blade 40', 'blade 30', 'xp helm', 'undead cape'].map((n) => k.has(n)), [true, true, false, true, true]);
});

test('wardrobe: sell plan - regular gear nobody keeps, member gear, unapplied enhancements; never AC, stacks, quest items, worn', async () => {
  const items = [
    piece('Old Sword', 'Weapon'),
    piece('Kept Helm', 'he'),
    piece('AC Junk Cape', 'ba', { bCoins: 1 }),
    piece('Member Axe', 'Weapon', { bUpg: 1 }),
    piece('Member Axe Kept', 'Weapon', { bUpg: 1 }),
    piece('Fighter Helm Enhancement', 'None', { sType: 'Enhancement' }),
    piece('Quest Shield', 'Weapon'),
    piece('Totems', 'None', { sType: 'Item', iQty: 400 }),
    piece('Stack Weapon', 'Weapon', { iQty: 3 }),
    piece('Worn Sword', 'Weapon', { bEquip: 1 }),
    piece('Shown Sword', 'Weapon', { bWear: 1 }),
    piece('Healer', 'ar', { sType: 'Class' }),
  ];
  const bank = [piece('Bank Hat', 'he'), piece('Bank Member Cape', 'ba', { bUpg: 1 })];
  const plan = wardrobe.sellPlan({ items, bank, keep: new Set(['kept helm', 'member axe kept']), questNeeds: new Set(['quest shield']), member: false });
  const names = plan.map((x) => x.name).sort();
  eq(names, ['Bank Hat', 'Bank Member Cape', 'Fighter Helm Enhancement', 'Member Axe', 'Member Axe Kept', 'Old Sword']);
  eq(plan.find((x) => x.name === 'Member Axe Kept').why, 'member-only (free account)', 'a free account cannot wear it even if it wants it');
  eq(plan.find((x) => x.name === 'Bank Hat').where, 'bank');
  const mem = wardrobe.sellPlan({ items, bank, keep: new Set(['kept helm', 'member axe kept']), questNeeds: new Set(['quest shield']), member: true }).map((x) => x.name);
  assert(!mem.includes('Member Axe Kept') && mem.includes('Member Axe'), 'a member keeps member gear it wants');
});

test('wardrobe: enhancement fits the class - type, cape/helm specials, Awe and forge weapon procs', async () => {
  const e = knowledge.enh();
  const wiz = { type: 'Wizard', weapon: null, cape: null, helm: null };
  eq(wardrobe.enhMatches({ sES: 'Weapon', EnhPatternID: 9 }, wiz, e), false, 'Lucky weapon on a Wizard class');
  eq(wardrobe.enhMatches({ sES: 'Weapon', EnhPatternID: 6 }, wiz, e), true);
  eq(wardrobe.enhMatches({ sES: 'ar', EnhPatternID: 6 }, wiz, e), true);
  const awe = { type: 'Lucky', weapon: 'Spiral_Carve' };
  eq(wardrobe.enhMatches({ sES: 'Weapon', EnhPatternID: 9, ProcID: 2 }, awe, e), true, 'Awe proc keeps the type pattern');
  eq(wardrobe.enhMatches({ sES: 'Weapon', EnhPatternID: 9 }, awe, e), false, 'no proc yet');
  const forge = { type: 'Lucky', weapon: 'Valiance', cape: 'Vainglory', helm: 'Pneuma' };
  eq(wardrobe.enhMatches({ sES: 'Weapon', EnhPatternID: 10, ProcID: 9 }, forge, e), true, 'forge proc = pattern 10');
  eq(wardrobe.enhMatches({ sES: 'ba', EnhPatternID: 24 }, forge, e), true);
  eq(wardrobe.enhMatches({ sES: 'ba', EnhPatternID: 9 }, forge, e), false);
  eq(wardrobe.enhMatches({ sES: 'he', EnhPatternID: 27 }, forge, e), true);
  eq(wardrobe.enhMatches({ sES: 'pe', EnhPatternID: 0 }, forge, e), true, 'pets carry none');
  eq(wardrobe.outfitName("King's Echo"), 'Kings Echo', 'outfit names: letters, digits, spaces');
});

function account(id, persona = null) {
  const dir = P.account(id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['outfits.json', 'wardrobe.json']) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* fresh */ } }
  const loginFile = path.join(dir, 'login.txt');
  fs.writeFileSync(loginFile, `[${id}]\nUsername: ${id}\nPassword: pw\n`);
  return { id, label: id, username: id, owner: 'test', loginFile, persona, status: 'active' };
}

test('wardrobe: tidy sells unwanted regular gear from backpack and bank, keeps AC, classes and quest items', async () => {
  const game = new FakeGame();
  const bot = new Bot(game, account('tidytest', 'nova7'));
  await bot.login();
  const inv = game.root.world.myAvatar.items;
  inv.push({ sName: 'Rusty Cleaver', ItemID: 501, CharItemID: 5001, sES: 'Weapon', iQty: 1, bCoins: 0 });
  inv.push({ sName: 'Thief Cape Enhancement', ItemID: 502, CharItemID: 5002, sES: 'None', sType: 'Enhancement', iQty: 1, bCoins: 0 });
  inv.push({ sName: 'Plain AC Hat', ItemID: 503, CharItemID: 5003, sES: 'he', iQty: 1, bCoins: 1 });
  game.bank = [{ sName: 'Bank Junk Helm', ItemID: 504, CharItemID: 5004, sES: 'he', iQty: 1, bCoins: 0 }];
  const qn = Bot._questNeeds; Bot._questNeeds = new Set(['spare sword']);
  try {
    const r = await bot.tidyWardrobe();
    eq(r.sold, 3, 'cleaver, enhancement and the bank helm');
    eq(game.soldLog.sort(), [501, 502, 504]);
    assert(game.item('Spare Sword'), 'a quest needs it: kept');
    assert(game.item('Healer'), 'classes are never sold');
    assert(!game.soldLog.includes(503), 'AC is never sold');
  } finally { Bot._questNeeds = qn; }
});

test('wardrobe: a class outfit is saved once, then a class switch is one equipLoadout; the look is shown over the gear', async () => {
  const game = new FakeGame();
  const bot = new Bot(game, account('outfittest', 'nova7'));
  await bot.login();
  const inv = game.root.world.myAvatar.items;
  inv.push({ sName: 'Rogue', ItemID: 601, CharItemID: 6001, sES: 'ar', sType: 'Class', iQty: 1, bCoins: 1 });
  bot.needsEnhance = async () => false;
  eq(await bot.saveOutfit(), true, 'Healer outfit saved');
  eq(await bot.saveOutfit(), false, 'unchanged: not saved again');
  eq(Object.keys(game.loadouts), ['Healer']);
  eq(game.loadouts.Healer.ar, 1);
  await bot.equip('Rogue');
  game.root.world.myAvatar.objData.strClassName = 'Rogue';
  eq(await bot.wearOutfit('Healer'), true, 'switched back through the outfit');
  eq(game.root.world.myAvatar.objData.strClassName, 'Healer');
  assert(game.sent.some((s) => String(s[1] || '').includes('%equipLoadout%7%cmd%Healer%1%')), 'one equipLoadout packet');
  eq(await bot.wearOutfit('Rogue'), false, 'no outfit for Rogue yet');
  // Looks: Nova's dream helm is shown, not equipped
  inv.push({ sName: "Enchanted Rogue's Locks", ItemID: 602, CharItemID: 6002, sES: 'he', iQty: 1, bCoins: 1 });
  const shown = await bot.showLook();
  assert(shown >= 1, 'something shown');
  eq(game.item("Enchanted Rogue's Locks").bWear, 1);
  assert(!game.item("Enchanted Rogue's Locks").bEquip, 'shown, not equipped');
  assert(bot.keepNames().has("enchanted rogue's locks"), 'the look on show stays in the backpack');
});

test('wardrobe: the brain tidies once a day, and when backpack and bank are full (before the "full" alert)', async () => {
  const { Brain } = require('../lib/brain');
  const was = process.env.SERAPH_TEST_NO_TIDY;
  process.env.SERAPH_TEST_NO_TIDY = '0';
  try {
    const game = new FakeGame();
    const bot = new Bot(game, account('tidybrain', null));
    await bot.login();
    const brain = new Brain();
    let t = await brain.next(bot);
    eq(t.type, 'tidy', 'first tidy of the day');
    t = await brain.next(bot);
    assert(t.type !== 'tidy', 'not again the same day');
    brain.state(bot).tidiedAt = Date.now() - 7 * 3600000;
    game.root.world.myAvatar.objData.iBagSlots = 5;            // 4 items: 1 free, nothing bankable
    bot.bankableAc = async () => []; bot.bankableOther = async () => [];
    t = await brain.next(bot);
    eq([t.type, /full/.test(t.why)], ['tidy', true], 'full storage: tidy before giving up');
  } finally { process.env.SERAPH_TEST_NO_TIDY = was; }
});

test('main looks (the owner 2026-10-14): a fully owned main look is what gets shown; partial ones fall back to taste', async () => {
  const main = [{ code: 'N03', name: 'Duelist', armor: 'Duelist Suit', helm: 'Duelist Locks', cape: null, weapon: 'Twin Blades' },
    { code: 'N01', name: 'Slayer', armor: 'Slayer Coat', helm: 'Oracle Locks', cape: 'Tassels', weapon: 'Twin Blades' }];
  const p = { ...girl, fashion: { ...girl.fashion, main, dream: [{ name: 'Duelist Suit' }, { name: 'Duelist Locks' }, { name: 'Twin Blades' }] } };
  const partial = [piece('Duelist Suit', 'co'), piece('Twin Blades', 'Weapon'), piece('Crimson Shadow Cape', 'ba')];
  const a = wardrobe.looks(p, partial);
  eq(a[0].co, 'Duelist Suit', 'taste path still leads with main pieces');
  const full = [...partial, piece('Duelist Locks', 'he')];
  const b = wardrobe.looks(p, full);
  eq(b.length, 1, 'only the complete main look');
  eq(JSON.stringify(b[0]), JSON.stringify({ co: 'Duelist Suit', he: 'Duelist Locks', Weapon: 'Twin Blades' }), 'the main look, no cape');
});

test('main looks (the owner 2026-10-17): no complete main look yet = only the closest one, gaps filled by taste', () => {
  const main = [{ code: 'N03', name: 'Duelist', armor: 'Duelist Suit', helm: 'Duelist Locks', cape: 'Tassels', weapon: 'Twin Blades' },
    { code: 'N01', name: 'Slayer', armor: 'Slayer Coat', helm: 'Oracle Locks', cape: 'Tassels', weapon: 'Twin Blades' }];
  const p = { ...girl, fashion: { ...girl.fashion, main, dream: [{ name: 'Duelist Suit' }, { name: 'Duelist Locks' }] } };
  const owned = [piece('Duelist Suit', 'co'), piece('Duelist Locks', 'he'), piece('Crimson Shadow Cape', 'ba'), piece('Crimson Rogue Armor', 'co'), piece('Shadow Dagger', 'Weapon')];
  const looks = wardrobe.looks(p, owned);
  eq(looks.length, 1, 'no rotation through looks the owner never picked');
  eq([looks[0].co, looks[0].he], ['Duelist Suit', 'Duelist Locks'], 'the picked pieces');
  assert(looks[0].ba && looks[0].Weapon, 'cape and weapon filled until the real ones drop');
  eq(wardrobe.looks(p, [piece('Duelist Locks', 'he'), piece('Crimson Rogue Armor', 'co')]).length > 0, true, 'without a main armor: taste looks as before');
});

// The owner 2026-10-17: Nova rotates N01, N03, N07, N08, N10 - N03 most, then N07; colours follow the look.
test('looks: weighted rotation over the complete looks it names, each look with its own colours', () => {
  const look = (code, a, h) => ({ code, name: code, armor: a, helm: h, cape: null, weapon: null });
  const p = { ...girl, fashion: { ...girl.fashion, main: [look('N03', 'Duelist', 'Duelist Locks'), look('N01', 'Slayer', 'Oracle Locks')],
    extra: [{ ...look('N07', 'Rocker', 'Duelist Locks') }, { ...look('N05', 'Duelist', 'Fire Locks') }],
    rotation: { N03: 40, N07: 25, N01: 12 }, colors: { hair: '8E1B2E', eye: 'CC0000' } } };
  p.fashion.main[1].colors = { hair: 'E8E8EE' };
  const owned = ['Duelist|co', 'Duelist Locks|he', 'Slayer|co', 'Oracle Locks|he', 'Rocker|co', 'Fire Locks|he'].map((s) => piece(...s.split('|')));
  const looks = wardrobe.looks(p, owned);
  eq(looks.map((l) => l.code).sort(), ['N01', 'N03', 'N07'], 'N05 is not in the rotation');
  eq(JSON.stringify(looks.find((l) => l.code === 'N03')), JSON.stringify({ co: 'Duelist', he: 'Duelist Locks' }), 'slots only in JSON');
  eq(looks.find((l) => l.code === 'N01').colors.hair, 'E8E8EE');
  eq(looks.find((l) => l.code === 'N03').colors.hair, '8E1B2E');
  const n = {};
  for (let d = 0; d < 3000; d++) { const c = wardrobe.pickLook(looks, p, d * 86400000).code; n[c] = (n[c] || 0) + 1; }
  assert(n.N03 > n.N07 && n.N07 > n.N01, `N03 > N07 > N01 (${JSON.stringify(n)})`);
  eq(wardrobe.pickLook(looks, p, 5 * 86400000 + 1000).code, wardrobe.pickLook(looks, p, 5 * 86400000 + 80000000).code, 'one look all day');
});

test('look pets (the owner 2026-10-21): a look wears its pet when owned, and is complete without it', async () => {
  const main = [{ code: 'S01', name: 'Witch', armor: 'Witch Dress', helm: 'Witch Locks', cape: null, weapon: 'Witch Staff', pet: 'Shadow Catmera' }];
  const persona = { ...girl, fashion: { ...girl.fashion, main } };
  const base = [piece('Witch Dress', 'co'), piece('Witch Locks', 'he'), piece('Witch Staff', 'Weapon')];
  const without = wardrobe.looks(persona, base, false);
  eq([without.length, without[0].co, without[0].pe], [1, 'Witch Dress', undefined], 'no pet yet: the look is still complete');
  const withPet = wardrobe.looks(persona, [...base, piece('Shadow Catmera', 'pe')], false);
  eq(withPet[0].pe, 'Shadow Catmera', 'the owned pet goes with the look');
  eq(withPet[0].code, 'S01');
});
