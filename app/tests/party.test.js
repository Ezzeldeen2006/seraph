// Seraph party: personas, progression plan, AC drop policy + bank, wardrobe, assisting the owner's main in ultras.
const fs = require('fs');
const path = require('path');
const { FakeGame } = require('./fakegame');
const { Bot } = require('../lib/bot');
const { Brain } = require('../lib/brain');
const { P } = require('../lib/paths');
const accounts = require('../lib/accounts');
const personas = require('../lib/personas');
const progression = require('../lib/progression');
const stylist = require('../lib/stylist');
const knowledge = require('../lib/knowledge');
const { InvCat } = require('../lib/skua/swfworld');

function account(id, persona = null) {
  const dir = P.account(id);
  fs.mkdirSync(dir, { recursive: true });
  const loginFile = path.join(dir, 'login.txt');
  fs.writeFileSync(loginFile, `[${id}]\nUsername: ${id}\nPassword: pw\n`);
  return { id, label: id, username: id, owner: 'test', loginFile, persona, status: 'active' };
}

async function online(id, persona, opts = {}, botOpts = {}) {
  const game = new FakeGame(opts);
  const bot = new Bot(game, account(id, persona), botOpts);
  await bot.login();
  return { game, bot };
}

const quiet = async (fn) => {
  const d = knowledge.dailies; const e = knowledge.eventCandidates;
  knowledge.dailies = () => []; knowledge.eventCandidates = () => [];
  try { return await fn(); } finally { knowledge.dailies = d; knowledge.eventCandidates = e; }
};

// ---------- accounts ----------
test('party accounts: one login file with several blocks, each account reads its own', async () => {
  const file = path.join(P.ROOT, 'multi-login.txt');
  fs.writeFileSync(file, '[Sable7]\nEmail: a@b.c\nUsername: Sable7\nPassword: one\n\n[Valen7]\nUsername: Valen7\nPassword: two\nStatus: NOT CREATED YET\n');
  eq(accounts.credentials({ id: 'valen7', username: 'Valen7', loginFile: file }), { user: 'Valen7', pass: 'two' });
  eq(accounts.credentials({ id: 'sable7', label: 'Sable7', loginFile: file }), { user: 'Sable7', pass: 'one' });
  let err = ''; try { accounts.credentials({ id: 'nobody', username: 'Nobody', loginFile: file }); } catch (e) { err = e.message; }
  assert(/no Username\/Password block/.test(err), err);
});

test('party accounts: a pending (not yet created) account never starts its bot', async () => {
  const game = new FakeGame();
  const acc = account('pendingone', 'valen7'); acc.status = 'pending';
  const bot = new Bot(game, acc);
  eq(bot.start(), false, 'start refused');
  assert(!bot.running, 'not running');
});

// ---------- personas ----------
test('personas: seven characters, every ultra seat owned twice, and tunings that differ', async () => {
  const all = Object.values(personas.PERSONAS);
  // 2026-10-21: three more so the party is seven. The point of the new three is NOT more variety - it is that the
  // seats the v3 line-ups need are owned by two characters each, so no boss waits on one character being two classes.
  eq(all.length, 7);
  eq(new Set(all.map((p) => p.style.palette)).size, 7, 'every character still looks different');
  const seats = all.map((p) => p.ultraClass);
  for (const seat of ['Lord of Order', "King's Echo", 'Verus DoomKnight']) {
    eq(seats.filter((s) => s === seat).length, 2, `${seat} is owned by two characters`);
  }
  eq(new Set(seats).size, 4, 'four seats between seven characters');
  eq(new Set(all.map((p) => p.sex)).size, 2, 'five girls and two boys');
  eq(all.filter((p) => p.sex === 'female').length, 5, 'the owner 2026-10-21: the three new ones are all female');
  const t = all.map((p) => personas.tuning(p));
  assert(new Set(t.map((x) => x.giveUpDeaths)).size >= 3, 'death tolerance differs');
  assert(new Set(t.map((x) => x.levelChunkMin)).size >= 3, 'grind length differs');
  eq(personas.tuning(personas.get('nova7')).dailiesFirst, false, 'Nova is not a dailies-first person');
  for (const p of all) for (const id of p.path) assert(progression.GOALS[id], `${p.id} path goal ${id} exists`);
  for (const p of all) assert(fs.existsSync(path.join(P.SCRIPTS, ...progression.GOALS[p.path[1]].script.split('/'))), `${p.id} script exists`);
});

test('progression: specialties differ early, everyone converges on the must-haves late', async () => {
  const lists = Object.values(personas.PERSONAS).map((p) => progression.goalsFor(p));
  const must = Object.entries(progression.GOALS).filter(([, g]) => g.must).map(([id]) => id);
  for (const l of lists) for (const id of must) assert(l.some((g) => g.id === id), `${id} in every plan`);
  const vael = progression.goalsFor(personas.get('valen7'));
  eq(vael.find((g) => g.id === 'archpaladin').when, 50, 'own specialty at its level');
  eq(vael.find((g) => g.id === 'lord-of-order').when, 80, "someone else's must-have waits for late game");
  eq(vael.find((g) => g.id === 'blood-sorceress').when, 90, "someone else's extra waits for end game");
  for (const g of Object.values(progression.GOALS)) assert(fs.existsSync(path.join(P.SCRIPTS, ...g.script.split('/'))), `script ${g.script}`);
});

test('progression: ultra classes are shared out without duplicates and respect the main', async () => {
  const ultra = progression.ultraFor('ultradrago-12345');
  eq(ultra.label, 'Ultra Drago');
  const members = [
    { id: 'sable7', owned: ['Lord of Order', 'StoneCrusher'], prefer: ['Lord of Order', 'StoneCrusher'] },
    { id: 'valen7', owned: ['StoneCrusher', 'ArchPaladin'], prefer: ['ArchPaladin', 'StoneCrusher'] },
    { id: 'nova7', owned: ['Verus DoomKnight', 'Lord of Order'], prefer: ['Verus DoomKnight'] },
  ];
  const r = progression.assignUltraClasses(ultra, members, ["King's Echo"]);
  eq([r.assigned.sable7, r.assigned.valen7, r.assigned.nova7], ['Lord of Order', 'StoneCrusher', 'Verus DoomKnight']);
  eq(r.missing, []);
  const r2 = progression.assignUltraClasses(ultra, members, ['Lord of Order']);
  eq(r2.assigned.sable7, 'StoneCrusher', 'main already brings LoO -> Sable switches to StoneCrusher');
  eq(r2.assigned.valen7, null, 'nothing left Valen owns');
  eq(r2.missing, ["King's Echo"]);
});

// ---------- brain ----------
test('brain: persona path drives goals and the why explains the stage', async () => {
  await quiet(async () => {
    const brain = new Brain();
    const { game, bot } = await online('orenx', 'oren7', { level: 25 });
    brain.today(bot).enhancedAt = Date.now(); brain.today(bot).styledAt = Date.now(); brain.state(bot).barberAt = Date.now();
    const t = await brain.next(bot);
    eq([t.type, t.goal], ['script', 'blood-sorceress'], 'Oren starts with Blood Sorceress');
    assert(/Early game: Blood Sorceress/.test(t.why), t.why);
    game.root.world.myAvatar.items.push({ sName: 'Blood Sorceress', ItemID: 77, CharItemID: 77, sES: 'ar', sType: 'Class', iQty: 1 });
    const n = await brain.next(bot);
    assert(n.goal !== 'blood-sorceress', 'owned goal skipped');
    const v = await online('valenx', 'valen7', { level: 25 });
    brain.today(v.bot).enhancedAt = Date.now(); brain.today(v.bot).styledAt = Date.now(); brain.state(v.bot).barberAt = Date.now();
    eq((await brain.next(v.bot)).type, 'farmLevel', 'Valen has nothing at 25 - levels instead');
  });
});

test('brain: classes kept in the bank count as owned', async () => {
  await quiet(async () => {
    const brain = new Brain();
    const { game, bot } = await online('bankowner', 'oren7', { level: 25 });
    game.bank = [{ sName: 'Blood Sorceress', ItemID: 77, CharItemID: 77, bCoins: 0 }];
    brain.today(bot).enhancedAt = Date.now(); brain.today(bot).styledAt = Date.now();
    assert(await bot.owns('Blood Sorceress'), 'owns via bank');
    assert((await brain.next(bot)).goal !== 'blood-sorceress', 'not farmed again');
  });
});

test('brain: backpack full banks unused AC items before selling junk; assist beats everything', async () => {
  await quiet(async () => {
    const hub = { settings: { assist: { enabled: false, main: 'GRAIL26', members: [] } }, bot: () => null, assistFor(b) { const a = this.settings.assist; return a.enabled && a.members.includes(b.id) ? a : null; } };
    const brain = new Brain({ hub });
    const { game, bot } = await online('bagfull', 'sable7', { level: 20 });
    game.root.world.myAvatar.objData.iBagSlots = 8;
    game.root.world.myAvatar.items.push({ sName: 'Pink Moglin Plushie', ItemID: 900, CharItemID: 900, sES: 'mi', bCoins: 1, iQty: 1 });
    eq((await brain.next(bot)).type, 'bankAc');
    eq(await bot.bankAc(), 1, 'banked the plushie');
    assert(game.bank.some((i) => i.sName === 'Pink Moglin Plushie'), 'in the bank');
    hub.settings.assist = { enabled: true, main: 'GRAIL26', server: '', members: ['bagfull'] };
    const a = await brain.next(bot);
    eq([a.type, a.main], ['assist', 'GRAIL26']);
  });
});

test('brain: a brand-new level 1 character levels to 10 before any daily', async () => {
  const d = knowledge.dailies; const e = knowledge.eventCandidates;
  knowledge.eventCandidates = () => [];
  knowledge.dailies = () => [{ name: 'TenacityChallenge', quests: [802], memberOnly: false, runnable: true, minLevel: 0, steps: [] }];
  try {
    const brain = new Brain();
    const { game, bot } = await online('newbie', 'nova7', { level: 1 });
    brain.today(bot).styledAt = Date.now(); brain.state(bot).barberAt = Date.now();
    const t = await brain.next(bot);
    eq([t.type, t.to], ['farmLevel', 10], t.why);
    game.root.world.myAvatar.objData.intLevel = 12;
    brain.today(bot).enhancedAt = Date.now();
    eq((await brain.next(bot)).type, 'daily', 'daily once strong enough');
  } finally { knowledge.dailies = d; knowledge.eventCandidates = e; }
});

test('brain: ultra focus (the owner 2026-10-19) skips the dailies it does not name', async () => {
  const d = knowledge.dailies; const e = knowledge.eventCandidates;
  knowledge.eventCandidates = () => [];
  knowledge.dailies = () => [{ name: 'NSoDDaily', quests: [802], memberOnly: false, runnable: true, minLevel: 0, steps: [] }];
  try {
    const brain = new Brain();
    const { bot } = await online('focus', 'nova7', { level: 20 });
    brain.today(bot).styledAt = Date.now(); brain.state(bot).barberAt = Date.now(); brain.today(bot).enhancedAt = Date.now();
    bot.settings.ultraFocus = true; bot.settings.noStyleTime = true;
    const t = await brain.next(bot);
    assert(!t || t.type !== 'daily', JSON.stringify(t));
    bot.settings.ultraDailies = ['NSoDDaily'];
    eq((await brain.next(bot)).type, 'daily', 'a daily it names still runs');
  } finally { knowledge.dailies = d; knowledge.eventCandidates = e; }
});

// ---------- drops ----------
test('drops: AC drops are always accepted - even junk - and banked to make room', async () => {
  const drops = { Frogzard: { ItemID: 76322, sName: 'A Fish', bCoins: 1 } };   // "A Fish" is on the junk list
  const { game, bot } = await online('acdrops', 'nova7', { monsterDrops: drops });
  game.root.world.myAvatar.objData.iBagSlots = 4;   // 4 items already -> bag full
  game.root.world.myAvatar.items = game.root.world.myAvatar.items.filter((i) => i.sName !== 'A Fish');
  game.root.world.myAvatar.items.push({ sName: 'Old AC Hat', ItemID: 901, CharItemID: 901, sES: 'he', bCoins: 1, iQty: 1 });
  game.pext({ cmd: 'dropItem', items: { 76322: { sName: 'A Fish', iQty: 1, bCoins: 1 } } });
  await bot.pickupDrops();
  assert(game.item('A Fish'), 'AC junk drop accepted');
  assert(game.bank && game.bank.some((i) => i.sName === 'Old AC Hat'), 'unused AC hat banked to make room');
});

// Nova asked for Pikeman and Blazebinder Badges after every kill while holding all 1000 of them: 560 refused
// pickups an hour, all of them counting towards the server's "Please slow down" limit (2026-09-20).
test('drops: a stack at its cap is left alone instead of asked for after every kill', async () => {
  const badge = { ItemID: 29657, sName: 'Pikeman Badge', bCoins: 1, iStk: 1000 };
  const { game, bot } = await online('fullstack', 'nova7', { monsterDrops: { Frogzard: badge } });
  game.root.world.myAvatar.items.push({ ...badge, CharItemID: 29657, sES: 'ba', iQty: 1000 });
  const asked = () => game.sent.filter((s) => String(s[1] || '').includes('%getDrop%')).length;
  for (let i = 0; i < 6; i++) {
    game.pext({ cmd: 'dropItem', items: { 29657: { sName: badge.sName, iQty: 1, bCoins: 1, iStk: 1000 } } });
    await bot.pickupDrops();
  }
  eq(asked(), 0, 'a stack already at its cap is never asked for');
  eq(bot.lastLog.filter((l) => /would not give me|already own/.test(l)).length, 0, 'a stack it knows is full is not worth a journal line');
  // The server has the last word: an item it refuses is left alone even when the stack size is unknown.
  const { game: g2, bot: b2 } = await online('refused', 'nova7', { monsterDrops: { Frogzard: badge } });
  g2.root.world.myAvatar.items.push({ ...badge, CharItemID: 29657, sES: 'ba', iQty: 1000 });
  for (let i = 0; i < 6; i++) {
    g2.pext({ cmd: 'dropItem', items: { 29657: { sName: badge.sName, iQty: 1, bCoins: 1 } } });   // no iStk this time
    await b2.pickupDrops();
  }
  eq(g2.sent.filter((s) => String(s[1] || '').includes('%getDrop%')).length, 1, 'one refusal, then it stops asking');
  assert(b2.dropHeld(29657), 'the item is held back');
  eq(b2.lastLog.filter((l) => /would not give me Pikeman Badge/.test(l)).length, 1, 'an unexpected refusal is said once');
  b2.dropBlocked.set(29657, Date.now() - 1);
  assert(!b2.dropHeld(29657), 'and tried again once the half hour is up');
});

// The owner 2026-10-09: Nova asked for Escherion's Chain and ArchFiend's Vampragon every 30 min - both sat in her bank,
// and only the backpack was counted. A one-of item owned in the bank is never asked for, and nothing is said.
test('drops: an item already owned in the bank is not asked for, and the journal stays quiet', async () => {
  const chain = { ItemID: 4401, sName: "Escherion's Chain", bCoins: 1, iStk: 1 };
  const { game, bot } = await online('bankowned', 'nova7', { monsterDrops: { Frogzard: chain } });
  bot.modelBank = () => [{ ...chain, CharItemID: 4401, iQty: 1 }];
  const asked = () => game.sent.filter((s) => String(s[1] || '').includes('%getDrop%')).length;
  for (let i = 0; i < 4; i++) {
    game.pext({ cmd: 'dropItem', items: { 4401: { sName: chain.sName, iQty: 1, bCoins: 1, iStk: 1 } } });
    await bot.pickupDrops();
  }
  eq(asked(), 0, 'owned in the bank: never asked for');
  eq(bot.lastLog.filter((l) => /Escherion/.test(l)).length, 0, 'no "cannot pick up" line');
  assert(bot.dropBlocked.get(4401) - Date.now() > 23 * 3600000, 'a one-of item is left alone for the day, not 30 min');
  eq(bot.bankedCount("escherion's chain"), 1, 'bankedCount matches names case-blind');
});

// The owner 2026-10-07: free accounts had 43-45 member-only items they can never equip in each bank.
test('drops: a free account leaves non-AC member gear; AC member drops and script-wanted items are still taken', async () => {
  const { game, bot } = await online('memberdrops', 'nova7');
  game.root.world.myAvatar.objData.iUpgDays = -20;
  const asked = (id) => game.sent.some((s) => String(s[1] || '').includes(`%getDrop%`) && String(s[1]).includes(`%${id}%`));
  game.pext({ cmd: 'dropItem', items: {
    501: { sName: "Titan's Blood", iQty: 1, bCoins: 0, bUpg: 1 },
    502: { sName: 'Member AC Cape', iQty: 1, bCoins: 1, bUpg: 1 },
    503: { sName: 'Free Sword', iQty: 1, bCoins: 0, bUpg: 0 },
  } });
  await bot.pickupDrops();
  eq([asked(501), asked(502), asked(503)], [false, true, true]);
  game.pext({ cmd: 'dropItem', items: { 504: { sName: 'Quest Member Thing', iQty: 1, bCoins: 0, bUpg: 1 } } });
  await bot.pickupDrops(['Quest Member Thing']);
  assert(asked(504), 'a script that asks for it gets it');
  game.root.world.myAvatar.objData.iUpgDays = 30;
  game.pext({ cmd: 'dropItem', items: { 505: { sName: 'Axe of Ruin', iQty: 1, bCoins: 0, bUpg: 1 } } });
  await bot.pickupDrops();
  assert(asked(505), 'a member takes member gear');
});

// Check-up 2026-10-08: a Taro pile in a full bag. Gear nobody asked for is left (no bank trip); a material still gets
// a slot made for it, and the pool is counted again after banking instead of trusting bankAc's tally.
// AQW 5.0 (2026-10-10): bag and misc are separate pools, so a material needs room in the misc pool, not the bag.
test('drops: full bag - unwanted non-AC gear is skipped, a material gets a slot', async () => {
  const { game, bot } = await online('fullbag', 'nova7');
  const av = game.root.world.myAvatar;
  av.items.push({ sName: 'Spare Note', ItemID: 911, CharItemID: 911, sType: 'Note', bCoins: 0, iQty: 1 });
  av.objData.iBagSlots = av.items.filter(InvCat.isBag).length;   // the bag pool is full
  av.objData.iBankSlots = 50;
  const asked = (id) => game.sent.some((s) => String(s[1] || '').includes('%getDrop%') && String(s[1]).includes(`%${id}%`));
  game.pext({ cmd: 'dropItem', items: { 601: { sName: 'Emerald Pickaxe', sType: 'Axe', iQty: 1, bCoins: 0, iStk: 1 } } });
  await bot.pickupDrops();
  eq(asked(601), false, 'gear nobody wants is not worth a bank trip');
  eq((game.bank || []).length, 0, 'nothing banked for it');
  game.pext({ cmd: 'dropItem', items: { 602: { sName: 'Fiend Shard', sType: 'Item', iQty: 1, bCoins: 0, iStk: 100 } } });
  await bot.pickupDrops();
  assert(asked(602), 'a material goes to the misc pool: a full bag does not stop it');
  eq((game.bank || []).length, 0, 'and nothing was banked for it');
  const misc = av.items.filter(InvCat.isMisc).length;
  bot.miscSlots = () => misc;   // now the misc pool is full as well
  game.pext({ cmd: 'dropItem', items: { 603: { sName: 'Fiend Seal', sType: 'Item', iQty: 1, bCoins: 0, iStk: 100 } } });
  await bot.pickupDrops();
  eq((game.bank || []).map((i) => i.sName), ['Spare Note'], 'one misc item banked to make room in the misc pool');
  assert(asked(603), 'and the material picked up');
  game.pext({ cmd: 'dropItem', items: { 604: { sName: 'Lucky Rogue', sType: 'Class', sES: 'ar', iQty: 1, bCoins: 0, iStk: 1 } } });
  await bot.pickupDrops();
  assert(asked(604), 'a class needs no slot');
});

test('aqw5: free slots are per pool - classes take none, materials count against the misc cap', async () => {
  const { game, bot } = await online('pools', 'valen7');
  const av = game.root.world.myAvatar;
  av.items = [
    { sName: 'ArchPaladin', ItemID: 1, CharItemID: 1, sType: 'Class', sES: 'ar', iQty: 1 },
    { sName: 'StoneCrusher', ItemID: 2, CharItemID: 2, sType: 'Class', sES: 'ar', iQty: 1 },
    { sName: 'Blade', ItemID: 3, CharItemID: 3, sType: 'Sword', sES: 'Weapon', iQty: 1 },
    { sName: 'Dust', ItemID: 4, CharItemID: 4, sType: 'Item', sES: 'None', iQty: 40 },
    { sName: 'Medal', ItemID: 5, CharItemID: 5, sType: 'Quest Item', sES: 'None', iQty: 1 },
    { sName: 'Tome', ItemID: 6, CharItemID: 6, sType: 'Item', sES: 'None', sMeta: '7', iQty: 1 },
  ];
  av.objData.iBagSlots = 30;
  eq(await bot.freeSlots(), 28, 'Blade + Tome (an Item with a numeric sMeta stays in the bag)');
  eq(await bot.freeSlots('misc'), 98, 'Dust + Medal of 100');
  av.items.push({ sName: 'Random AC Class', ItemID: 7, CharItemID: 7, sType: 'Class', sES: 'ar', bCoins: 1, iQty: 1 });
  eq((await bot.bankableAc()).map((i) => i.sName), [], 'AQW 5.0 refuses to bank a class, AC or not');
});

test('drops: what a Skua script unbanked is not banked again (for a day)', async () => {
  const { bot } = await online('unbanked', 'valen7');
  bot.scriptUnbanked = new Map([['fiend seal', Date.now()], ['old thing', Date.now() - 25 * 3600000]]);
  const keep = bot.keepNames();
  assert(keep.has('fiend seal'), 'kept');
  assert(!keep.has('old thing'), 'a day later it may go back');
});

test('drops: AC items the character uses stay in the backpack', async () => {
  const { game, bot } = await online('ackeep', 'valen7');
  game.root.world.myAvatar.items.push(
    { sName: 'ArchPaladin', ItemID: 902, CharItemID: 902, sES: 'ar', sType: 'Class', bCoins: 1, iQty: 1 },
    { sName: 'Worn AC Sword', ItemID: 903, CharItemID: 903, sES: 'Weapon', bCoins: 1, bEquip: true, iQty: 1 },
    { sName: 'Random AC Cape', ItemID: 904, CharItemID: 904, sES: 'ba', bCoins: 1, iQty: 1 },
  );
  eq((await bot.bankableAc()).map((i) => i.sName), ['Random AC Cape']);
});

test('bank: regular items go to the bank too (gear first) until 30 slots are free, never past the bank space', async () => {
  const { game, bot } = await online('bankall', 'sable7');
  const w = game.root.world;
  w.myAvatar.objData.iBagSlots = 40;
  w.myAvatar.objData.iBankSlots = 3;
  game.bank = [{ sName: 'Old Banked Helm', ItemID: 950, CharItemID: 950, bCoins: 0, iQty: 1 }];
  w.myAvatar.items = [];
  w.myAvatar.items.push(
    { sName: 'Victory Totem', ItemID: 910, CharItemID: 910, sType: 'Item', sES: 'None', bCoins: 0, iQty: 700 },
    { sName: 'Sword of Ruin', ItemID: 911, CharItemID: 911, sType: 'Sword', sES: 'Weapon', bCoins: 0, iQty: 1 },
    { sName: 'Metal head', ItemID: 912, CharItemID: 912, sType: 'Helm', sES: 'he', bCoins: 0, iQty: 1 },
    { sName: 'Worn Blade', ItemID: 913, CharItemID: 913, sType: 'Sword', sES: 'Weapon', bCoins: 0, bEquip: true, iQty: 1 },
  );
  // Gear fills the bag pool (AQW 5.0: Resources and Items have their own misc pool and would leave the bag empty).
  for (let i = 0; i < 30; i++) w.myAvatar.items.push({ sName: `Filler ${i}`, ItemID: 1000 + i, CharItemID: 1000 + i, sType: 'Gauntlet', sES: 'Weapon', bCoins: 0, bEquip: true, iQty: 1 });
  eq((await bot.bankableOther()).map((i) => i.sName), ['Sword of Ruin', 'Metal head'], 'gear first, only 2 bank slots left, equipped stays');
  eq(await bot.bankAc(0, 30), 2);
  assert(!w.myAvatar.items.some((i) => i.sName === 'Sword of Ruin') && w.myAvatar.items.some((i) => i.sName === 'Victory Totem'));
  assert(await bot.owns('Metal head'), 'a banked item still counts as owned');
});

// ---------- wardrobe ----------
// (persona styles: tests/fashion.test.js)
// Since 2026-10-07 the look is shown over the boost gear (AQW "Show", lib/wardrobe.js), not equipped.
test('style: dressUp shows the picks in game', async () => {
  const { game, bot } = await online('dresser', 'sable7');
  game.root.world.myAvatar.items.push({ sName: 'Violet Halo Wings Robe', ItemID: 950, CharItemID: 950, sES: 'co', iQty: 1 });
  eq(await bot.dressUp(), 1);
  eq(game.item('Violet Halo Wings Robe').bWear, 1, 'shown');
  assert(!game.item('Violet Halo Wings Robe').bEquip, 'not equipped: the stats stay on the boost gear');
});

// ---------- assist ----------
test('assist: bot goes to the main, stands in its cell and takes its ultra class', async () => {
  const cfg = { enabled: true, main: 'GRAIL26', server: '', mainClass: "King's Echo", members: ['helper'] };
  const hub = {
    settings: { assist: cfg }, bots: new Map(),
    bot(id) { return this.bots.get(id) || null; },
    assistFor(b) { return cfg.enabled && cfg.members.includes(b.id) ? cfg : null; },
    info() {}, notify() {},
    ultraClassFor: null,
  };
  const Hub = require('../lib/hub').Hub;
  hub.ultraClassFor = Hub.prototype.ultraClassFor.bind(hub);
  const { game, bot } = await online('helper', 'sable7', {}, { hub });
  hub.bots.set('helper', bot);
  game.players = { grail26: { map: 'ultradrago', cell: 'Boss' } };
  game.root.world.monsters = [{ strMonName: 'Ultra Drago', strFrame: 'Boss', intHP: 100 }];
  game.root.world.myAvatar.items.push({ sName: 'Lord of Order', ItemID: 960, CharItemID: 960, sES: 'ar', sType: 'Class', iQty: 1 });
  const run = bot.assist({ main: 'GRAIL26', minutes: 0.4 });
  await bot.waitFor(async () => (await bot.cell()) === 'Boss', 20000, 50);
  eq(await bot.map(), 'ultradrago', 'went to the main');
  eq(await bot.cell(), 'Boss', "main's cell");
  cfg.enabled = false;
  await run;
  assert(game.sent.some((s) => String(s[1]).includes('%goto%GRAIL26%')), 'used /goto');
  eq(game.item('Lord of Order').bEquip, true, 'wore Lord of Order for Ultra Drago');
  assert(bot.lastLog.some((l) => /Ultra Drago: my slot is Lord of Order/.test(l)), 'journaled the slot');
});
