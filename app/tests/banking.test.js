// Banking on a full inventory (the owner, 2026-10-17): bank only what isn't needed and only as much as it takes; never the
// pieces of a server outfit, never enhanced gear on his own account; a full house is emptied by Seraph because
// CoreBots.ToHouseBank skips every item while the house is full.
const fs = require('fs');
const path = require('path');
const { FakeGame } = require('./fakegame');
const { Bot } = require('../lib/bot');
const { P } = require('../lib/paths');

function account(id, persona = null, kind = 'party') {
  const dir = P.account(id);
  fs.mkdirSync(dir, { recursive: true });
  const loginFile = path.join(dir, 'login.txt');
  fs.writeFileSync(loginFile, `[${id}]\nUsername: ${id}\nPassword: pw\n`);
  return { id, label: id, username: id, owner: 'test', loginFile, persona, status: 'active', kind };
}
async function online(id, persona, kind) {
  const game = new FakeGame({});
  const bot = new Bot(game, account(id, persona, kind));
  await bot.login();
  return { game, bot };
}
const gear = (name, id, extra = {}) => ({ sName: name, ItemID: id, CharItemID: id, sType: 'Helm', sES: 'he', bCoins: 1, iQty: 1, ...extra });

test('banking: AC items only go until the pool has its room, plain cosmetics first', async () => {
  const { game, bot } = await online('bankroom', 'valen7');
  const av = game.root.world.myAvatar;
  av.objData.iBagSlots = 10;
  av.items = [];
  for (let i = 0; i < 9; i++) av.items.push(gear(`Cosmetic ${i}`, 100 + i, i === 0 ? { EnhID: 5 } : {}));
  eq(await bot.freeSlots(), 1);
  const moved = await bot.bankAc(0, 4, 'bag');
  eq(moved, 3, 'three to reach 4 free, not all nine');
  eq(await bot.freeSlots(), 4);
  assert(av.items.some((i) => i.sName === 'Cosmetic 0'), 'the enhanced piece goes last');
});

test('banking: outfit pieces stay, and enhanced gear stays on the owner\'s own account', async () => {
  const { game, bot } = await online('bankkeep', null, 'guest');
  const av = game.root.world.myAvatar;
  av.items = [gear('Outfit Helm', 201), gear('Exalted Apotheosis', 202, { sES: 'Weapon', sType: 'Sword', EnhID: 9 }), gear('Onsen Hair', 203)];
  bot.serverLoadouts = { LOO: { he: 201, ar: 50741, colors: { hair: 1 } } };
  eq((await bot.bankableAc()).map((i) => i.sName), ['Onsen Hair']);
});

test('banking: a full house is emptied by Seraph (AC house items, not the house), only as far as needed', async () => {
  const { game, bot } = await online('bankhouse', 'valen7');
  const house = [
    { sName: 'Legion Castle', ItemID: 301, CharItemID: 301, sType: 'House', bCoins: 1, bEquip: 1 },
    { sName: 'Plushie', ItemID: 302, CharItemID: 302, sType: 'Floor Item', bCoins: 1 },
    { sName: 'Statue', ItemID: 303, CharItemID: 303, sType: 'Floor Item', bCoins: 1 },
    { sName: 'Candle', ItemID: 304, CharItemID: 304, sType: 'Floor Item', bCoins: 0 },
    { sName: 'Pizza', ItemID: 305, CharItemID: 305, sType: 'Floor Item', bCoins: 1 },
  ];
  game.swf = { w: { myAvatar: { houseitems: house, objData: { iHouseSlots: 5 } } } };
  const send0 = game.send.bind(game);
  game.send = async (pkt) => {
    const m = /%bankFromInv%[^%]*%(\d+)%(\d+)%/.exec(pkt);
    if (m) { const i = house.findIndex((x) => x.CharItemID === Number(m[2])); if (i >= 0) house.splice(i, 1); return true; }
    return send0(pkt);
  };
  bot.wait = async () => {};
  eq(await bot.bankHouse(2), 2);
  eq(house.map((i) => i.sName), ['Legion Castle', 'Candle', 'Pizza'], 'the house and the non-AC candle stay');
});

test('banking: a Skua "House full" line makes room once a minute', async () => {
  const { bot } = await online('bankline', 'valen7');
  let calls = 0;
  bot.bankHouse = async () => { calls++; return 1; };
  bot.makeRoomFor('[18:41:13] (BuyItem) ❌ House full, cannot store this item.');
  bot.makeRoomFor('[18:41:43] (BuyItem) ❌ House full, cannot store this item.');
  bot.makeRoomFor('[18:41:43] (Unbank) something else');
  eq(calls, 1);
});
