// The owner's account (2026-10-17): "make sure you dont mess up my enchatments" - Seraph never enhances on his account, a
// class switch puts on HIS outfit for that class, CoreBots auto-enhance stays off and its Solo/Farm sets are his
// outfits' pieces; the party's damage seats follow the measured dummy DPS (KE over VDK).
const fs = require('fs');
const path = require('path');
const { FakeGame } = require('./fakegame');
const { Bot } = require('../lib/bot');
const { P } = require('../lib/paths');
const partycomp = require('../lib/partycomp');

function account(id, kind) {
  const dir = P.account(id);
  fs.mkdirSync(dir, { recursive: true });
  const loginFile = path.join(dir, 'login.txt');
  fs.writeFileSync(loginFile, `[${id}]\nUsername: ${id}\nPassword: pw\n`);
  return { id, label: id, username: id, owner: 'owner', loginFile, persona: null, status: 'active', kind };
}
async function mainBot() {
  const game = new FakeGame({});
  const bot = new Bot(game, account('mainenh', 'guest'));
  await bot.login();
  const av = game.root.world.myAvatar;
  av.items = [
    { sName: "King's Echo", ItemID: 1, CharItemID: 1, sType: 'Class', sES: 'ar', iQty: 302500, bEquip: true },
    { sName: 'Verus DoomKnight', ItemID: 2, CharItemID: 2, sType: 'Class', sES: 'ar', iQty: 302500 },
    { sName: "Malgor's ShadowFlame Blade", ItemID: 10, CharItemID: 10, sType: 'Sword', sES: 'Weapon', EnhID: 5, bEquip: true },
    { sName: 'Mystica Dark Caster Locks', ItemID: 11, CharItemID: 11, sType: 'Helm', sES: 'he', EnhID: 5, bEquip: true },
    { sName: 'Arch DoomKnight Open Helm', ItemID: 12, CharItemID: 12, sType: 'Helm', sES: 'he', EnhID: 6 },
    { sName: 'Arch DoomKnight Cape', ItemID: 13, CharItemID: 13, sType: 'Cape', sES: 'ba', EnhID: 7, bEquip: true },
  ];
  bot.serverLoadouts = {
    KE: { ar: 1, Weapon: 10, he: 11, ba: 13, colors: { hair: 1 } },
    VDK: { ar: 2, Weapon: '99', he: 12, ba: 13, colors: { hair: 1 } },
  };
  return { game, bot };
}

test('main: no enhancing on the owner\'s account, whoever asks', async () => {
  const { bot } = await mainBot();
  const sent = [];
  const send0 = bot.client.send.bind(bot.client);
  bot.client.send = async (p) => { sent.push(p); return send0(p); };
  eq(await bot.needsEnhance(), false);
  eq(await bot.enhanceEquipped(), 0);
  eq(await bot.enhanceEquipped({ type: 'Lucky', weapon: 'Dauntless' }), 0, 'not even with a plan (raids, ultras)');
  assert(!sent.some((p) => /enhanceItem|loadShop/.test(p)), 'no shop, no enhance packet');
});

test('main: a class switch uses his own outfit for that class', async () => {
  const { bot } = await mainBot();
  const o = await bot.guestLoadout('Verus DoomKnight');
  eq(o.name, 'VDK');
  eq(o.ids.he, 12);
  const p = await bot.guestOutfitPieces("King's Echo");
  eq([p.outfit, p.Weapon, p.he, p.ba], ['KE', "Malgor's ShadowFlame Blade", 'Mystica Dark Caster Locks', 'Arch DoomKnight Cape']);
});

test('main: CoreBots never auto-enhances on his account and wears his outfit pieces with the Solo / Farm class', async () => {
  const { bot } = await mainBot();
  bot.settings.soloClass = "King's Echo";
  bot.settings.farmClass = 'Verus DoomKnight';
  const keys = await require('../lib/skua/cbo').keysFor(bot);
  eq(keys.DisableAutoEnhance, 'True');
  eq([keys.SoloEquipCheck, keys.Weapon1Select, keys.Helm1Select], ['True', "Malgor's ShadowFlame Blade", 'Mystica Dark Caster Locks']);
  eq([keys.FarmEquipCheck, keys.Helm2Select, keys.Cape2Select], ['True', 'Arch DoomKnight Open Helm', 'Arch DoomKnight Cape']);
});

test('party seats: damage follows the measured dummy DPS (KE before VDK)', () => {
  const r = partycomp.assign(['dps'], [{ id: 'main', classes: [{ name: 'Verus DoomKnight', cp: 302500 }, { name: "King's Echo", cp: 302500 }, { name: 'Void Highlord', cp: 302500 }] }]);
  eq(r.seats.main.cls, "King's Echo");
});

// The owner, 2026-10-21: "you have permission to modify the enchatments on my main account". One slot, named, per call.
test('main: the asked-for door enhances exactly the slot it was given, and nothing else', async () => {
  const { bot } = await mainBot();
  const tried = [];
  bot.loadShop = async (id) => { tried.push(id); return []; };   // empty shop: nothing is bought, but we see the attempt
  eq(await bot.enhanceEquipped({ type: 'Lucky', onMain: true, onlySlots: ['ar'] }), 0, 'nothing bought from an empty shop');
  assert(tried.length > 0, 'it did go shopping for the armour slot');
  assert(bot.lastLog.some((l) => /enhancing only armor on this account/.test(l)), bot.lastLog.join(' | '));
  // Without onlySlots it is still refused, however it is dressed up.
  bot.lastLog.length = 0; tried.length = 0;
  eq(await bot.enhanceEquipped({ type: 'Lucky', onMain: true }), 0);
  eq(tried.length, 0, 'no shop was opened');
  eq(await bot.enhanceEquipped({ type: 'Lucky', onlySlots: ['Weapon'] }), 0, 'and not without onMain either');
  eq(tried.length, 0);
});

// 2026-10-22, the owner: "why on my main do i have 2 weapons using dauntless? also i bought a new 51% weapon".
test('main: the weapon report shows every weapon with its damage, enhancement and outfits; an outfit slot can be re-pointed', async () => {
  const { bot } = await mainBot();
  const items = await bot.items();
  items.push(
    { sName: 'Exalted Apotheosis', ItemID: 20, CharItemID: 20, sType: 'Sword', sES: 'Weapon', sMeta: 'dmgAll:1.51', EnhID: 9, EnhPatternID: 9, ProcID: 15, EnhLvl: 100 },
    { sName: 'Empowered Hollowborn Caladbolg', ItemID: 21, CharItemID: 21, sType: 'Sword', sES: 'Weapon', sMeta: 'dmgAll:1.51', EnhID: 9, EnhPatternID: 9, ProcID: 14, EnhLvl: 100 },
  );
  bot.items = async () => items;
  bot.bankItems = async () => [];
  bot.serverLoadouts.KE.Weapon = 20;
  const rep = await bot.weaponReport();
  const ea = rep.find((w) => w.name === 'Exalted Apotheosis');
  eq([ea.allDamage, ea.enhancement.type, ea.enhancement.special, ea.outfits.join()], [51, 'Lucky', 'Ravenous', 'KE']);
  const spare = rep.find((w) => w.name === 'Empowered Hollowborn Caladbolg');
  eq([spare.enhancement.special, spare.outfits.length], ['Dauntless', 0], 'the unused Dauntless spare shows up');
  const sent = [];
  bot.client.send = async (s) => { sent.push(s); bot.loadoutReply = { success: 1 }; };
  const r = await bot.pointOutfit('VDK', 'Weapon', 'Empowered Hollowborn Caladbolg');
  eq([r.outfit, r.ItemID], ['VDK', 21]);
  assert(sent.some((s) => /addLoadout%.*%VDK%.*"Weapon":21.*%VDK%$/.test(s)), sent.join(' | '));
  eq(bot.loadoutIdsSource().VDK.Weapon, 21, 'the model follows');
  let err = null;
  try { await bot.pointOutfit('Nope', 'Weapon', 'Exalted Apotheosis'); } catch (e) { err = e.message; }
  assert(/no outfit "Nope"/.test(err), err);
});

test('main: the gear report covers helms and capes; a purpose outfit is copied from a class outfit', async () => {
  const { bot } = await mainBot();
  const items = await bot.items();
  items.push(
    { sName: 'Lament Cape', ItemID: 30, CharItemID: 30, sType: 'Cape', sES: 'ba', EnhID: 9, EnhPatternID: 30, EnhLvl: 100 },
    { sName: 'Anima Helm', ItemID: 31, CharItemID: 31, sType: 'Helm', sES: 'he', EnhID: 9, EnhPatternID: 28, EnhLvl: 100 },
  );
  bot.items = async () => items;
  bot.bankItems = async () => [];
  const rep = await bot.weaponReport(['he', 'ba']);
  eq(rep.find((g) => g.name === 'Lament Cape').enhancement.special, 'Lament');
  eq(rep.find((g) => g.name === 'Anima Helm').enhancement.special, 'Anima');
  const sent = [];
  bot.client.send = async (s) => { sent.push(s); bot.loadoutReply = { success: 1 }; };
  const r = await bot.copyOutfit('KE', 'KE Solo', { he: 'Anima Helm', ba: 'Lament Cape' });
  eq([r.body.ar, r.body.Weapon, r.body.he, r.body.ba], [1, 10, 31, 30], 'class and weapon kept, helm and cape changed');
  assert(sent.some((s) => /addLoadout%.*%KE Solo%.*%$/.test(s)), sent.join(' | '));
  let err = null;
  try { await bot.copyOutfit('KE', 'KE Solo'); } catch (e) { err = e.message; }
  assert(/exists already/.test(err), err);
});

test('main: purpose outfits - class switches and Solo keep the plain outfit, the Farm set takes "... Farm"', async () => {
  const { bot } = await mainBot();
  bot.bankItems = async () => [];
  bot.serverLoadouts['KE Farm'] = { ar: 1, Weapon: 10, he: 12, ba: 13 };
  bot.serverLoadouts['KE Solo'] = { ar: 1, Weapon: 10, he: 12, ba: 13 };
  const order = { ...bot.serverLoadouts };
  bot.serverLoadouts = { 'KE Solo': order['KE Solo'], KE: order.KE, 'KE Farm': order['KE Farm'], VDK: order.VDK };
  eq((await bot.guestLoadout("King's Echo")).name, 'KE', 'the plain one, even when a purpose outfit comes first');
  eq((await bot.guestLoadout("King's Echo", 'farm')).name, 'KE Farm');
  eq((await bot.guestLoadout('Verus DoomKnight', 'farm')).name, 'VDK', 'no Farm outfit: the plain one');
  const p = await bot.guestOutfitPieces("King's Echo", 'farm');
  eq([p.outfit, p.he], ['KE Farm', 'Arch DoomKnight Open Helm']);
});

// 2026-10-23, the owner: "when i click on my main outfits the new ones ... it tells me couldnt find items in inventory".
// The game's outfit button only looks in the backpack; Oni Look / Acoustic Look were saved from pieces in the bank.
test('main: a new outfit takes its banked pieces out of the bank; no room = a warning, nothing lost', async () => {
  const { bot } = await mainBot();
  const items = await bot.items();
  let bank = [
    { sName: 'Obsessor Oni Slayer', ItemID: 40, CharItemID: 40, sType: 'Armor', sES: 'co' },
    { sName: 'Obsessor Shadow Mask Locks', ItemID: 41, CharItemID: 41, sType: 'Helm', sES: 'he' },
    { sName: 'Some Other Helm', ItemID: 42, CharItemID: 42, sType: 'Helm', sES: 'he' },
  ];
  bot.items = async () => items;
  bot.bankItems = async () => bank;
  let room = 5;
  bot.freeSlots = async () => room;
  const sent = [];
  bot.client.send = async (s) => {
    sent.push(s);
    if (/addLoadout/.test(s)) bot.loadoutReply = { success: 1 };
    const m = /bankToInv%[^%]*%(\d+)%/.exec(s);
    if (m) { const it = bank.find((i) => i.ItemID === Number(m[1])); bank = bank.filter((i) => i !== it); items.push(it); room--; }
  };
  const r = await bot.copyOutfit('KE', 'Oni Look', { co: 'Obsessor Oni Slayer', he: 'Obsessor Shadow Mask Locks' });
  eq(r.movedToBag.sort(), ['Obsessor Oni Slayer', 'Obsessor Shadow Mask Locks']);
  assert(bank.some((i) => i.ItemID === 42), 'pieces of no outfit stay banked');
  eq(await bot.outfitsToBag(), [], 'nothing left to move');
  // A piece banked later, with a full bag: kept in the bank, and said so.
  bank.push(items.splice(items.findIndex((i) => i.ItemID === 41), 1)[0]);
  room = 0;
  eq(await bot.outfitsToBag(), []);
  assert(bot.lastLog.some((l) => /outfit pieces left in the bank \(no backpack room\): Obsessor Shadow Mask Locks/.test(l)), bot.lastLog.join(' | '));
});
