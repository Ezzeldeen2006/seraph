// Rare-drop farming (lib/droprates.js, 2026-10-13): kills of the step's own monster are progress until the item's
// learned dry-streak budget, instead of two half-hour stalls and a 24 h park.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { FakeGame } = require('./fakegame');
const { Bot } = require('../lib/bot');
const { P } = require('../lib/paths');
const { Hub } = require('../lib/hub');
const { DropRates, parseStep, endsFarm, DEFAULT, MIN, MAX } = require('../lib/droprates');

const TARO = "(HuntMonster) Killing Taro Blademaster for item: \"Taro's Manslayer\" 0/1";
let n = 0;
const tmpRates = (rare = null) => {
  const dir = path.join(process.env.SERAPH_ROOT || os.tmpdir(), `droprates-${process.pid}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  let rareFile = path.join(dir, 'rare.json');
  fs.writeFileSync(rareFile, JSON.stringify({ items: rare || {} }));
  return new DropRates(path.join(dir, 'droprates.json'), { rareFile });
};

test('droprates: reads the farm steps Skua logs, and nothing else', async () => {
  eq(parseStep(`[13:41:15] ${TARO}`).monster, 'Taro Blademaster');
  eq(parseStep(TARO).items, ["Taro's Manslayer"]);
  const mapid = parseStep('(HuntMonsterMapID) Farming 💎 Asherion Armor (0/1)');
  eq([mapid.monster, mapid.items], [null, ['Asherion Armor']]);
  eq(parseStep('(BuyAllMerge) Farming Monster Blood (0/1)').items, ['Monster Blood']);
  eq(parseStep('(_KillForItem) Farming Weapon Imprint (3/15)').items, ['Weapon Imprint']);
  const batch = parseStep('(_MonsterHuntBatch) Farming monster "Gummy Tapeworm" for items: [Cartilage Gathered x9, Dolls Collected x9]');
  eq([batch.monster, batch.items], ['Gummy Tapeworm', ['Cartilage Gathered', 'Dolls Collected']]);
  eq(parseStep('(HuntMonster) Killing Hydra Head 90 for item: "Hydra Scale Piece" 12/100').monster, 'Hydra Head 90', 'digits in a name survive');
  eq(parseStep('(GetItemReq) Farming reputation for Arcangrove (Required: 78400)'), null);
  eq(parseStep('(BattleGroundE) Farming 1,000,000 gold using BattleGroundE Method'), null);
  eq(parseStep('(_KillForItem) Farming Weapon Imprint (15/15)'), null, 'already has them');
  eq(parseStep('(SaveStateHandler) SaveState [True] We\'ll randomly goto /whitemap'), null);
  assert(endsFarm('(QuestProgression) Doing Quest: [5] - "x"') && !endsFarm('(_Equip) Equipped item: ArchPaladin (ID: 36920)'));
});

test('droprates: the budget is learned from kills per drop, clamped, overridable, halved after a park', async () => {
  const dr = tmpRates({ 'Monster Blood': { kills: 900 } });
  eq(dr.budget("Taro's Manslayer"), DEFAULT, 'unknown item');
  for (let i = 0; i < 580; i++) dr.kill('valen7', ["Taro's Manslayer"]);
  dr.drop('valen7', "Taro's Manslayer");
  eq(dr.budget("Taro's Manslayer"), DEFAULT, 'one drop is not a rate yet');
  dr.drop('valen7', "Taro's Manslayer");
  eq([dr.mean("Taro's Manslayer"), dr.budget("Taro's Manslayer")], [290, 1160], '4x the mean');
  eq(dr.dry('valen7', "Taro's Manslayer"), 0);
  for (let i = 0; i < 10; i++) dr.kill('valen7', ['Common Thing']);
  dr.drop('x', 'Common Thing'); dr.drop('x', 'Common Thing');
  eq(dr.budget('common thing'), MIN, 'floor');
  for (let i = 0; i < 100000; i++) dr.kill('x', ['Ultra Rare']);
  dr.drop('x', 'Ultra Rare'); dr.drop('x', 'Ultra Rare');
  eq(dr.budget('Ultra Rare'), MAX, 'ceiling');
  eq(dr.budget('monster blood'), 900, 'rare-drops.json kills wins');
  for (let i = 0; i < 950; i++) dr.kill('oren7', ['Monster Blood']);
  dr.parked('oren7', 'Monster Blood');
  eq(dr.dry('oren7', 'Monster Blood'), 450, 'next try gets half a budget');
  dr.save();
  const again = new DropRates(dr.file, { rareFile: dr.rareFile });
  eq([again.mean("Taro's Manslayer"), again.dry('oren7', 'Monster Blood')], [290, 450], 'persisted');
});

test('droprates: only the step\'s monster counts, other log lines keep the farm, a new quest ends it', async () => {
  const b = Object.create(Bot.prototype);
  b.id = 'nova7';
  b.hub = { dropRates: tmpRates() };
  b.client = { w: { strMapName: 'tercessuinotlim', monsters: [{ MonMapID: 1, strMonName: 'Taro Blademaster' }, { MonMapID: 2, strMonName: 'Dark Makai' }], myAvatar: { items: [{ ItemID: 538, sName: "Taro's Manslayer" }], tempitems: [] } } };
  b.farmLine(TARO);
  b.farmKill(2);
  eq(b.farm.kills, 0, 'a Dark Makai is not Taro');
  b.farmKill(1); b.farmKill(1);
  eq([b.farm.kills, b.hub.dropRates.dry('nova7', "Taro's Manslayer")], [2, 2]);
  b.farmLine('(SaveStateHandler) SaveState [True] We\'ll randomly goto /whitemap to save your progress');
  b.farmLine(TARO.replace('0/1', '0/1'));
  eq(b.farm.kills, 2, 'same step again keeps the count');
  b.farmGot("Taro's Manslayer");
  b.farmGot(b.itemNameOf(538));   // its pickup a moment later is the same drop
  eq([b.hub.dropRates.dry('nova7', "Taro's Manslayer"), b.hub.dropRates.rec("Taro's Manslayer").drops], [0, 1]);
  b.farmLine('(QuestProgression) Doing Quest: [726] - "Totem of Nulgath"');
  eq(b.farm, null, 'a new quest ends the farm');
  // A step naming no monster counts kills on the map of its first kill - Skua logs the step before it joins the map.
  b.client.w.strMapName = 'bocklincastle';
  b.farmLine('(BuyAllMerge) Farming Monster Blood (0/1)');
  b.client.w.strMapName = 'ebondungeon';
  b.farmKill(9);
  b.client.w.strMapName = 'whitemap';
  b.farmKill(9);
  eq(b.farm.kills, 1, 'kills elsewhere do not count');
});

async function scriptBot(id, hub) {
  const dir = P.account(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'login.txt'), `Username: ${id}\nPassword: pw\n`);
  const b = new Bot(new FakeGame({ level: 100 }), { id, label: id, username: id, loginFile: path.join(dir, 'login.txt'), status: 'active' }, { hub: null });
  await b.login();
  b.running = true;
  b.stops = 0; b.stop = () => { b.stops++; }; b.start = () => true;
  b.playing = async () => true;
  b.freeSlots = async () => 12;
  b.current = { type: 'script', brain: true, goal: 'archfiend-doomlord', why: 'End game: ArchFiend DoomLord', path: 'Nation/AFDL/0DoAll.cs', startedAt: Date.now() - 3 * 3600000 };
  b.scriptStep = TARO.replace(/\d+/g, '#');
  b.scriptStepRaw = TARO;
  b.farm = { ...parseStep(TARO), map: 'tercessuinotlim', since: Date.now() - 3600000, kills: 120, lastKillAt: Date.now() - 60000 };
  hub.bots.set(b.id, b);
  return b;
}
const watchHub = () => {
  const hub = { bots: new Map(), info() {}, notified: [], notify(t) { this.notified.push(t); }, overseer: null, parks: [], dropRates: tmpRates() };
  hub.brain = { park: (bot, t, step) => { hub.parks.push(step); return 'for 24 h'; }, failed: async () => null };
  hub.watchdog = Hub.prototype.watchdog.bind(hub);
  return hub;
};

test('watchdog: a farm step killing its own monster is not stuck, however quiet the script', async () => {
  const hub = watchHub();
  const b = await scriptBot('farmer1', hub);
  for (let i = 0; i < 150; i++) hub.dropRates.kill(b.id, ["Taro's Manslayer"]);
  b.scriptActivityAt = Date.now() - 3 * 3600000;   // three silent hours: before, restarted at 30 min, parked at 60
  await hub.watchdog();
  b._watch.at = Date.now() - 40 * 60000;
  await hub.watchdog();
  eq([b.stops, hub.parks.length], [0, 0], 'kills of Taro keep it going');
  assert(b.lastLog.some((l) => /farming Taro's Manslayer: 150 kills of Taro Blademaster without one so far \(gives up at 400\) - still at it/.test(l)), b.lastLog.slice(-3).join(' | '));
  b.farm.lastKillAt = Date.now() - 20 * 60000;     // Taro stopped dying: back to the old rules
  b._watch.at = Date.now() - 40 * 60000;
  await hub.watchdog();
  eq(b.stops, 1, 'no kills of its monster: restarted as before');
});

test('watchdog: past its budget the farm is parked at once, and the next try gets half a budget', async () => {
  const hub = watchHub();
  const b = await scriptBot('farmer2', hub);
  for (let i = 0; i < DEFAULT; i++) hub.dropRates.kill(b.id, ["Taro's Manslayer"]);
  b.scriptActivityAt = Date.now() - 2 * 3600000;
  await hub.watchdog();
  b._watch.at = Date.now() - 40 * 60000;
  await hub.watchdog();
  eq([b.stops, hub.parks.length], [1, 1], 'parked on the first stall, not the second');
  assert(b.lastLog.some((l) => /farming Taro's Manslayer: 400 kills of Taro Blademaster since the last one, past its budget of 400 - giving it a rest/.test(l)), b.lastLog.slice(-3).join(' | '));
  eq(hub.dropRates.dry(b.id, "Taro's Manslayer"), DEFAULT / 2);
});

test('watchdog: a full bag is not luck - the farm goes back to the stuck rules', async () => {
  const hub = watchHub();
  const b = await scriptBot('farmer3', hub);
  b.freeSlots = async () => 0;
  b.scriptActivityAt = Date.now() - 2 * 3600000;
  await hub.watchdog();
  eq([b.stops, hub.parks.length], [1, 0], 'restarted (the diagnosis makes room), not parked');
});
