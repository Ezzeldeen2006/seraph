// Enhancements reaching the skua.swf model, in the shape the real server sends them.
// Check-up 2026-10-04: the shop reply names its items in `ItemIDs` and the pattern `EnhPID`; the model read `ItemID`
// and `EnhPatternID`, so a bought enhancement never showed and the bot bought it again every half hour.

function model() {
  const { SwfWorld } = require('../lib/skua/swfworld');
  const client = { id: 'en', headless: true, state: { loaded: true }, w: { myAvatar: { uid: 12, objData: { strUsername: 'En' } } }, write() {}, send() {}, record() {}, emit() {}, on() {} };
  const swf = new SwfWorld(client);
  swf.game.sfc.sendXtMessage = () => {};
  const pkt = (o) => swf.onPacket({ kind: 'json', cmd: o.cmd, data: o });
  pkt({ cmd: 'moveToArea', areaId: 5, areaName: 'battleon-1', strMapName: 'battleon', monmap: [], mondef: [], uoBranch: [{ entID: 12, strUsername: 'En', intHP: 500, intHPMax: 500, intState: 1, intLevel: 97, strFrame: 'Enter' }] });
  pkt({ cmd: 'initUserData', uid: 12, data: { strUsername: 'En', intLevel: 97, intGold: 100000, intCoins: 0, iUpgDays: -1 } });
  pkt({ cmd: 'loadInventoryBig', items: [
    { ItemID: 55358, sName: 'Scarf', sES: 'ba', bEquip: 1, iQty: 1, EnhID: 52000, EnhLvl: 90, EnhPatternID: 3 },
    { ItemID: 71607, sName: 'Locks', sES: 'he', bEquip: 1, iQty: 1, EnhID: 52001, EnhLvl: 90, EnhPatternID: 3 },
    { ItemID: 40427, sName: 'Blade', sES: 'Weapon', bEquip: 1, iQty: 1, EnhID: 46000, EnhLvl: 80, EnhPatternID: 3 },
  ], hitems: [], factions: [] });
  return { swf, pkt, item: (id) => swf.game.world.myAvatar.items.find((i) => i.ItemID === id) };
}

test('enhance: the shop reply (ItemIDs list, EnhPID) updates the item and the gold', async () => {
  const { swf, pkt, item } = model();
  pkt({ cmd: 'enhanceItemShop', iCost: 9760, ItemIDs: [55358], EnhID: 52173, EnhPID: 3, EnhLvl: 97, EnhDPS: 100, EnhRng: 10, EnhRty: 5, ProcID: null });
  const it = item(55358);
  eq([it.EnhID, it.EnhLvl, it.EnhPatternID, it.EnhRty], [52173, 97, 3, 5], 'the scarf carries the new enhancement');
  eq(item(71607).EnhLvl, 90, 'an item not in ItemIDs is left alone');
  eq(Number(swf.game.world.myAvatar.objData.intGold), 100000 - 9760, 'the cost comes off the gold');
});

test('enhance: one reply can enhance several items, and enhanceItemLocal (single ItemID) works too', async () => {
  const { pkt, item } = model();
  pkt({ cmd: 'enhanceItemShop', ItemIDs: [55358, 71607], EnhID: 52175, EnhPID: 6, EnhLvl: 96, EnhRty: 5 });
  eq([item(55358).EnhLvl, item(71607).EnhLvl, item(71607).EnhPatternID], [96, 96, 6]);
  pkt({ cmd: 'enhanceItemLocal', ItemID: 40427, EnhID: 46382, EnhPID: 3, EnhLvl: 90, EnhRty: 7, ProcID: 5 });
  eq([item(40427).EnhID, item(40427).EnhLvl, item(40427).ProcID], [46382, 90, 5]);
});

test('brain: a restless persona reaches its dailies after one XP-grind chunk, not only after a goal chunk', async () => {
  // Check-up 2026-10-04: below 100 the brain grinds XP instead of running goals, so a restless persona (Nova) never
  // finished a "goal chunk" and never got to a single daily all day.
  const fs = require('fs');
  const path = require('path');
  const { FakeGame } = require('./fakegame');
  const { Bot } = require('../lib/bot');
  const { Brain } = require('../lib/brain');
  const { P } = require('../lib/paths');
  const id = 'restless1';
  const dir = P.account(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'login.txt'), `Username: ${id}\nPassword: pw\n`);
  const b = new Bot(new FakeGame({ level: 97 }), { id, label: id, username: id, loginFile: path.join(dir, 'login.txt'), status: 'active' }, { hub: null });
  await b.login();
  const brain = new Brain({ hub: null });
  eq(brain.today(b).goalChunks, 0);
  await brain.done(b, { type: 'farmLevel', to: 100, minutes: 26, brain: true, critical: 'xp', startedAt: Date.now() - 60000 }, true);
  eq(brain.today(b).goalChunks, 1, 'an XP-grind chunk counts as the day\'s first chunk');
  await brain.done(b, { type: 'farmLevel', to: 30, minutes: 26, brain: true, startedAt: Date.now() - 60000 }, true);
  eq(brain.today(b).goalChunks, 1, 'a plain leveling task (not the critical grind) does not');
});
