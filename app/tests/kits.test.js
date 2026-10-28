// 2026-10-13: forge specials slot by slot, class kits (Solo / Farm gear enhanced for their own class), the AC wallet
// lock, and free gifts that recur every year.
const knowledge = require('../lib/knowledge');
const kits = require('../lib/kits');
const wardrobe = require('../lib/wardrobe');

test('enhance plan: the community sheet first, slot by slot, CoreAdvanced where the sheet has nothing unlocked', async () => {
  // What all four bots held on 10-13 (no Valiance, Penitence, Acheron, Forge weapon / cape).
  const have = new Set(['Awe', 'Lacerate', 'Smite', 'Absolution', 'Vainglory', 'Avarice', 'Vim', 'Examen', 'ForgeHelm', 'Pneuma', 'Anima']);
  const vhl = knowledge.enhancementPlan('Void Highlord', have, 100);
  eq([vhl.source, vhl.type, vhl.weapon, vhl.cape, vhl.helm], ['sheet', 'Lucky', 'Smite', 'Vainglory', 'Anima'], 'VHL per the sheet: Smite / Vainglory / Anima');
  const ap = knowledge.enhancementPlan('ArchPaladin', have, 100);
  eq([ap.type, ap.weapon, ap.helm, ap.cape], ['Lucky', 'Awe_Blast', 'Forge', 'Vainglory'], 'AP: Awe Blast, Forge helm, Vainglory');
  const sc = knowledge.enhancementPlan('StoneCrusher', have, 100);
  eq([sc.type, sc.cape, sc.helm], ['Wizard', 'Absolution', 'Forge'], 'StoneCrusher is Wizard on the sheet (CoreAdvanced says Fighter)');
  const bb = knowledge.enhancementPlan('Blaze Binder', have, 100);
  eq([bb.type, bb.weapon, bb.cape, bb.helm], ['Wizard', 'Awe_Blast', 'Vainglory', 'Pneuma'], 'Blaze Binder: no Valiance / Elysium yet -> the Awe weapon');
  // Only Awe unlocked: no sheet special fits, CoreAdvanced's Awe plan.
  const awe = knowledge.enhancementPlan('Void Highlord', new Set(['Awe']), 100);
  eq([awe.weapon, awe.cape, awe.helm], ['Spiral_Carve', null, null]);
  // A class the sheet doesn't list: CoreAdvanced slot by slot as before.
  eq(knowledge.enhancementPlan('Totally Unknown Mage', new Set(), 10).type, 'Wizard');
});

test('enhance match: the plain Forge weapon special counts with either pattern', async () => {
  const e = knowledge.enh();
  const plan = { type: 'Lucky', weapon: 'Forge' };
  eq(wardrobe.enhMatches({ sES: 'Weapon', EnhPatternID: 9, ProcID: 1 }, plan, e), true, 'type pattern');
  eq(wardrobe.enhMatches({ sES: 'Weapon', EnhPatternID: 10, ProcID: 1 }, plan, e), true, 'forge pattern');
  eq(wardrobe.enhMatches({ sES: 'Weapon', EnhPatternID: 9, ProcID: 3 }, plan, e), false, 'Awe Blast is not Forge');
});

function gearSet() {
  const w = (sName, sMeta, extra = {}) => ({ sName, sES: 'Weapon', sType: 'Sword', sMeta, ...extra });
  const h = (sName, sMeta) => ({ sName, sES: 'he', sType: 'Helm', sMeta });
  const c = (sName, sMeta) => ({ sName, sES: 'ba', sType: 'Cape', sMeta });
  const AFDL = 'dmgAll:1.15,cp:1.25,gold:1.25,rep:1.25,exp:1.25,AutoAdd';
  return {
    items: [w('Void Avenger Scythe', 'AutoAdd,dmgAll:1.4'), w('Burning Blade Of Abezeth', 'dmgAll:1.30'), w('Doomblade of Destruction', AFDL),
      w('Night Mare Scythe', ''), h("DoomLord's War Mask", AFDL), h('Plain Hood', ''), c('ShadowFiend Cloak', AFDL), c('Plain Cape', ''),
      w('Member Blade', 'dmgAll:1.5', { bUpg: 1 })],
    bank: [h('Locks of the DoomLord', AFDL), c('Other Cape', ''), w('Temp Stick', '', { bTemp: 1 })],
  };
}

test('kits: the main (solo) class takes the boosted pieces, farm the next best, nothing is shared across enhancements', async () => {
  const e = knowledge.enh();
  const have = new Set(['Awe', 'Lacerate', 'ForgeHelm', 'Avarice', 'Pneuma']);
  const plans = { solo: { cls: 'ArchPaladin', plan: knowledge.enhancementPlan('ArchPaladin', have, 100) }, farm: { cls: 'Blaze Binder', plan: knowledge.enhancementPlan('Blaze Binder', have, 100) } };
  const { items, bank } = gearSet();
  const k = kits.build({ plans, items, bank, e });
  eq(k.solo.Weapon, 'Void Avenger Scythe', 'bosses get the 40%');
  eq(k.farm.Weapon, 'Burning Blade Of Abezeth', 'farm: +30% damage beats Doomblade, whose +25% the helm already gives');
  eq(k.solo.he, "DoomLord's War Mask", 'the main class picks the boost helm first');
  eq(k.farm.he, 'Locks of the DoomLord', 'the second DoomLord helm (in the bank) goes to the farm kit');
  eq(k.solo.ba, 'ShadowFiend Cloak');
  assert(k.farm.ba && k.farm.ba !== 'ShadowFiend Cloak', 'farm has its own cape');
  for (const s of kits.SLOTS) assert(k.solo[s] !== k.farm[s], `${s} not shared: the two classes enhance it differently`);
  assert(![k.solo.Weapon, k.farm.Weapon].includes('Member Blade'), 'member items are out on a free account');
  assert(![k.solo.Weapon, k.farm.Weapon].includes('Temp Stick'), 'temp items are out');
  // Sticky: rebuilding with the same state keeps the same picks.
  eq(kits.build({ plans, items, bank, e, prev: k }), k, 'stable');
  // Names are kept in the backpack; forClass finds a kit by class.
  assert(kits.names(k).has('void avenger scythe') && kits.names(k).has('locks of the doomlord'));
  eq(kits.forClass(k, 'blaze binder').Weapon, 'Burning Blade Of Abezeth');
  eq(kits.forClass(k, 'Lord of Order'), null);
});

test('kits: the same class (or the same enhancement) for both roles shares the pieces', async () => {
  const e = knowledge.enh();
  const { items, bank } = gearSet();
  const plan = knowledge.enhancementPlan('Void Highlord', new Set(['Awe']), 100);
  const k = kits.build({ plans: { solo: { cls: 'Void Highlord', plan }, farm: { cls: 'Void Highlord', plan } }, items, bank, e });
  eq([k.farm.Weapon, k.farm.he, k.farm.ba], [k.solo.Weapon, k.solo.he, k.solo.ba], 'one class, one kit');
  // Two classes, both plain Lucky + Awe Blast (Lord of Order and ArchPaladin with Awe only): the weapon is shared.
  const loo = knowledge.enhancementPlan('Lord of Order', new Set(['Awe']), 100);
  const ap = knowledge.enhancementPlan('ArchPaladin', new Set(['Awe']), 100);
  if (kits.slotKey('Weapon', loo, e) === kits.slotKey('Weapon', ap, e)) {
    const k2 = kits.build({ plans: { solo: { cls: 'ArchPaladin', plan: ap }, farm: { cls: 'Lord of Order', plan: loo } }, items, bank, e });
    eq(k2.farm.Weapon, k2.solo.Weapon, 'same enhancement: shared');
  }
});

test('kits: CoreBots keys - set 1 solo, set 2 farm, off without a kit', async () => {
  const keys = kits.cboKeys({ solo: { cls: 'ArchPaladin', Weapon: 'VAS', he: 'Locks', ba: 'Cape A' }, farm: { cls: 'Blaze Binder', Weapon: 'BBoA', he: 'Mask', ba: 'Cloak' } });
  eq([keys.SoloEquipCheck, keys.Weapon1Select, keys.Helm1Select, keys.Cape1Select], ['True', 'VAS', 'Locks', 'Cape A']);
  eq([keys.FarmEquipCheck, keys.Weapon2Select, keys.Helm2Select, keys.Cape2Select], ['True', 'BBoA', 'Mask', 'Cloak']);
  const off = kits.cboKeys({ solo: { cls: 'ArchPaladin' } });
  eq([off.SoloEquipCheck, off.FarmEquipCheck, off.Weapon1Select], ['False', 'False', '']);
});

test('AC lock: no AC-priced item is bought unless the task allowed it by name', async () => {
  const { SwfWorld } = require('../lib/skua/swfworld');
  const events = [];
  const client = { id: 'ac', headless: true, state: { loaded: true }, w: { myAvatar: { uid: 12, objData: { strUsername: 'Ac' } } }, write() {}, send() {}, record() {}, emit(ev, x) { events.push([ev, x]); }, on() {} };
  const swf = new SwfWorld(client);
  const sent = [];
  swf.game.sfc.sendXtMessage = (_z, cmd, args) => sent.push([cmd, ...(args || [])]);
  const pkt = (o) => swf.onPacket({ kind: 'json', cmd: o.cmd, data: o });
  pkt({ cmd: 'moveToArea', areaId: 5, areaName: 'underworld-1', strMapName: 'underworld', monmap: [], mondef: [], uoBranch: [{ entID: 12, strUsername: 'Ac', intHP: 500, intHPMax: 500, intState: 1, intLevel: 100, strFrame: 'Enter' }] });
  pkt({ cmd: 'initUserData', uid: 12, data: { strUsername: 'Ac', intLevel: 100, intGold: 100000, intCoins: 2000, iUpgDays: -1 } });
  const w = swf.game.world;
  w.shopinfo = { ShopID: 215, items: [] };
  const uw = { ItemID: 1, ShopItemID: 11, sName: 'Undead Warrior', bCoins: 1, iCost: 1080, sES: 'co' };
  const potion = { ItemID: 2, ShopItemID: 22, sName: 'Gold Thing', bCoins: 0, iCost: 500, sES: 'co' };
  w.sendBuyItemRequest(uw);
  eq(sent.filter((s) => s[0] === 'buyItem').length, 0, 'locked');
  eq(events.filter((x) => x[0] === 'acRefused').map((x) => x[1].name), ['Undead Warrior'], 'reported');
  w.lastCool = {}; if (w.cool) w.cool = {};
  client.acAllow = new Set(['undead warrior']);
  w.sendBuyItemRequestWithQuantity({ iSel: uw, iQty: 1, accept: 1 });
  eq(sent.filter((s) => s[0] === 'buyItem').length, 1, 'allowed by name for this task');
  client.acAllow = null;
  w.sendBuyItemRequestWithQuantity({ iSel: potion, iQty: 1, accept: 1 });
  eq(sent.filter((s) => s[0] === 'buyItem').length, 2, 'gold items are not touched');
  w.sendBuyItemRequestWithQuantity({ iSel: { ...uw, iCost: 0 }, iQty: 1, accept: 1 });
  eq(sent.filter((s) => s[0] === 'buyItem').length, 3, 'an AC-tagged merge item (0 AC) is fine');
});

test('free gifts: the claim window recurs every year, last year\'s quest waits for the new script', async () => {
  const fg = require('../lib/freegifts');
  const d = (s) => Date.parse(s);
  const bday = { until: '11-01', fromMonth: 10 };
  eq([fg.pastUntil(bday, d('2026-10-20')), fg.pastUntil(bday, d('2026-11-02')), fg.pastUntil(bday, d('2027-10-15'))], [false, true, false], 'birthday, every year');
  const frost = { until: '01-15', fromMonth: 12 };
  eq([fg.pastUntil(frost, d('2026-12-05')), fg.pastUntil(frost, d('2027-01-10')), fg.pastUntil(frost, d('2027-01-20'))], [false, false, true], 'Frostval runs into January');
  const gifts = [{ id: 'chilly', label: 'Chilly', event: 'Frostvale', script: 'c.cs', minLevel: 30, until: '01-15', fromMonth: 12, staleQuests: [10510] }];
  const opts = (q) => ({ level: 100, events: { Frostvale: true }, now: d('2026-12-05'), gifts, versionOf: () => 'v1', questsOf: () => q });
  eq(fg.next({}, opts([10510])), null, 'still the 2025 quest: not asked (the server kicks for a gone quest)');
  eq(fg.next({}, opts([11020])).gift, 'chilly', 'rewritten for this year: claimed');
  const src = 'public void ChillysParticipation(int questID = 10510) { if (Core.isCompletedBefore(questID, false)) return; Core.EnsureAccept(questID); }';
  eq(fg.questsIn('x', () => src), [10510]);
  eq(fg.questsIn('y', () => 'Core.EnsureAccept(10894); Core.EnsureComplete(10894);'), [10894]);
});

test('free AC watch: new free-AC scripts are found once per version, spenders are not', async () => {
  const fs = require('fs');
  const path = require('path');
  const fg = require('../lib/freegifts');
  const root = path.join(process.env.SERAPH_ROOT, 'freeac-scripts');
  const put = (rel, head) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), `/*\n${head}\n*/\npublic class X {}\n`); };
  put('Seasonal/Frostvale/ChillysParticipation.cs', 'name: Chilly\'s Participation\ndescription: required to get free acs throughout the event.');
  put('Other/FreeAcGifts[Yearly]/202xFreeAcs.cs', 'name: Free ACs\ntags: acs, free');
  put('Seasonal/NewYear/FreeAcGift2027.cs', 'name: New Year Free AC Gift\ndescription: claims the free ACs gift');
  put('Tools/WheelOfDoomSpam.cs', 'name: Wheel\ndescription: Wastes your extra ACs');
  put('Other/Various/GenerosityCoin.cs', 'name: Generosity Coin\ndescription: Donates 250 Acs');
  put('Seasonal/Frostvale/CheckForDonatedACs.cs', 'name: checker\ndescription: check for ACs recieved, free acs');
  const gifts = [{ script: 'Seasonal/Frostvale/ChillysParticipation.cs' }, { script: 'Other/FreeAcGifts[Yearly]/202xFreeAcs.cs' }];
  const found = fg.discover(root, gifts, []);
  eq(found.map((f) => f.script), ['Seasonal/NewYear/FreeAcGift2027.cs'], 'only the new claim');
  // The hub tells the owner once per version.
  const { Hub } = require('../lib/hub');
  const said = [];
  const fake = { settings: {}, info() {}, notify: (t, b) => said.push(t), saveSettings() {} };
  eq(Hub.prototype.freeAcWatch.call(fake, found).length, 1);
  eq(Hub.prototype.freeAcWatch.call(fake, found).length, 0, 'not again');
  eq(said, ['Possible free ACs']);
});

test('AC spenders: the Skua spin / donation tools never run', async () => {
  const { Bot } = require('../lib/bot');
  assert(Bot.AC_SPENDERS.test('Tools/TreasureChestSpam.cs') && Bot.AC_SPENDERS.test('Tools/WheelOfDoomSpam.cs') && Bot.AC_SPENDERS.test('Other/Various/GenerosityCoin.cs'));
  assert(!Bot.AC_SPENDERS.test('Dailies/WheelofDoom.cs'), 'the free weekly spin still runs');
});

test('enhance plan: the cheap plan drops forge specials (60k-300k) and keeps the 10k Awe weapon', async () => {
  const have = new Set(['Awe', 'Lacerate', 'ForgeHelm', 'Vainglory', 'Anima']);
  const vhl = knowledge.enhancementPlan('Void Highlord', have, 100);
  const cheap = knowledge.cheapPlan(vhl);
  eq([cheap.weapon, cheap.cape, cheap.helm, cheap.type], ['Spiral_Carve', null, null, 'Lucky']);
  const ap = knowledge.cheapPlan(knowledge.enhancementPlan('ArchPaladin', have, 100));
  eq(ap.weapon, 'Awe_Blast', 'Lacerate (forge, 150k) -> the Awe pick');
  eq([knowledge.isForgeSpecial('weapon', 'Awe_Blast'), knowledge.isForgeSpecial('weapon', 'Lacerate'), knowledge.isForgeSpecial('weapon', 'Forge'), knowledge.isForgeSpecial('cape', 'Vainglory')], [false, true, true, true]);
});

function fakeEnhancer({ gold, refuse = [] }) {
  const path = require('path');
  const { Bot } = require('../lib/bot');
  const e = knowledge.enh();
  const items = [
    { ItemID: 1, sName: 'Blade', sES: 'Weapon', bEquip: 1, EnhID: 5, EnhLvl: 100, EnhPatternID: 9, ProcID: 3 },
    { ItemID: 2, sName: 'Hood', sES: 'he', bEquip: 1, EnhID: 6, EnhLvl: 100, EnhPatternID: 6 },
    { ItemID: 3, sName: 'Cape', sES: 'ba', bEquip: 1, EnhID: 7, EnhLvl: 100, EnhPatternID: 6 },
    { ItemID: 4, sName: 'Void Highlord', sES: 'ar', bEquip: 1, EnhID: 8, EnhLvl: 100, EnhPatternID: 9 },
  ];
  const enh = (ItemID, sName, iCost, pat, proc) => ({ ItemID, sName, sType: 'Enhancement', iLvl: 100, iCost, pat, proc });
  const shops = {
    [e.basicShops.Lucky[1]]: [enh(901, 'Lucky Weapon Enhancement', 10060, 9), enh(902, 'Lucky Helm Enhancement', 10060, 9), enh(903, 'Lucky Cape Enhancement', 10060, 9), enh(904, 'Lucky Armor Enhancement', 10060, 9)],
    [e.aweShops.Lucky]: [enh(911, 'Spiral Carve', 10000, 9, 2), enh(912, 'Awe Blast', 10000, 9, 3)],
    [e.forgeShops.cape]: [enh(921, 'Vainglory', 300000, 24)],
    [e.forgeShops.helm]: [enh(931, 'Anima', 300000, 28)],
  };
  const log = [];
  const fake = {
    settings: {}, noEnhance: new Set(), kits: null, _gold: gold,
    journal: (m) => log.push(m), check() {}, remember() {}, file: (n) => path.join(process.env.SERAPH_ROOT, `fake-${n}`),
    items: async () => items, level: async () => 100, className: async () => 'Void Highlord', g: async () => -1,
    gold: async () => fake._gold, unlockedEnhancements: async () => new Set(['Awe', 'Vainglory', 'Anima']),
    loadShop: async (id) => shops[id] || [], room: async () => 'r', waitFor: async (fn) => fn(),
    markEnhanceCapped() {}, enhanceCapped: () => false,
    client: { send: async (p) => {
      const [, , , , , itemId, enhId] = p.split('%');
      const it = items.find((i) => i.ItemID === Number(itemId));
      if (refuse.includes(it.sName)) return;   // no answer from the server
      const s = Object.values(shops).flat().find((x) => x.ItemID === Number(enhId));
      Object.assign(it, { EnhID: s.ItemID, EnhLvl: 100, EnhPatternID: s.pat, ProcID: s.proc });
      fake._gold -= s.iCost;
    } },
  };
  for (const k of ['enhanceEquipped', 'enhanceReserve', 'enhGood', 'lockedForge']) fake[k] = Bot.prototype[k];
  fake.kitsOn = () => false;
  return { fake, items, log };
}

test('enhance: forge specials only while 1 M gold stays after them; a forge special already on is never removed', async () => {
  const poor = fakeEnhancer({ gold: 500000 });
  await poor.fake.enhanceEquipped();
  const by = (r, n) => r.items.find((i) => i.sName === n);
  eq([by(poor, 'Cape').EnhPatternID, by(poor, 'Hood').EnhPatternID], [9, 9], 'short of gold: basic Lucky cape and helm (10k), not Vainglory / Anima (300k)');
  eq([by(poor, 'Blade').ProcID, by(poor, 'Blade').EnhPatternID], [2, 9], 'the weapon gets its Awe pick');
  assert(poor.fake._gold > 400000, 'spent ~30k, not 600k');
  const rich = fakeEnhancer({ gold: 3000000 });
  await rich.fake.enhanceEquipped();
  eq([by(rich, 'Cape').EnhPatternID, by(rich, 'Hood').EnhPatternID], [24, 28], 'with gold: Vainglory + Anima');
  // Gold drops afterwards: the specials stay (needsEnhance / enhGood say they are fine).
  rich.fake._gold = 100000;
  const e = knowledge.enh();
  const plan = knowledge.enhancementPlan('Void Highlord', new Set(['Awe', 'Vainglory', 'Anima']), 100);
  assert(rich.fake.enhGood({ ...by(rich, 'Cape'), EnhLvl: 90 }, plan, e, 100000, 100), 'a lvl-90 Vainglory waits for gold instead of going basic');
  const before = rich.fake._gold;
  await rich.fake.enhanceEquipped();
  eq(rich.fake._gold, before, 'nothing bought again');
});

test('enhance: a piece the server will not enhance is left out after one try, not bought again and again', async () => {
  const r = fakeEnhancer({ gold: 3000000, refuse: ['Hood'] });
  await r.fake.enhanceEquipped();
  assert(r.fake.noEnhance.has('hood'), 'remembered');
  assert(r.log.some((l) => /Hood did not take/.test(l)), 'said so');
  const spent = 3000000 - r.fake._gold;
  await r.fake.enhanceEquipped();
  eq(3000000 - r.fake._gold, spent, 'the second pass buys nothing for it');
  // And kits skip it.
  const k = kits.build({ plans: { solo: { cls: 'Void Highlord', plan: knowledge.enhancementPlan('Void Highlord', new Set(['Awe']), 100) } }, items: r.items, bank: [{ sName: 'Other Hood', sES: 'he', sMeta: '' }], e: knowledge.enh(), exclude: r.fake.noEnhance });
  eq(k.solo.he, 'Other Hood');
});

test('kits: quest ingredients and old fixed enhancements are a last resort; DisableAutoEnhance goes with the kits', async () => {
  const e = knowledge.enh();
  const plan = knowledge.enhancementPlan('Void Highlord', new Set(['Awe']), 100);
  const bank = [{ sName: 'Unidentified 26', sES: 'ba', sMeta: '' }, { sName: "Templar's Cape", sES: 'ba', sMeta: '', EnhPatternID: 1 }, { sName: 'Plain Cape', sES: 'ba', sMeta: '' }];
  const k = kits.build({ plans: { solo: { cls: 'Void Highlord', plan } }, items: [], bank, e, avoid: new Set(['unidentified 26']) });
  eq(k.solo.ba, 'Plain Cape');
  eq(kits.cboKeys({ solo: { cls: 'Void Highlord', ba: 'Plain Cape' } }).DisableAutoEnhance, 'True');
  eq(kits.cboKeys({}).DisableAutoEnhance, 'False');
});

test('kits: a forge-enhanced piece stays with its class - another class gets a different piece, not a re-enhance', async () => {
  const e = knowledge.enh();
  const have = new Set(['Awe', 'Lacerate', 'ForgeHelm', 'Vainglory', 'Anima', 'Avarice', 'Pneuma']);
  const ap = { type: 'Lucky', weapon: 'Lacerate', helm: 'Forge', cape: null, weaponAwe: 'Awe_Blast' };
  const loo = { type: 'Lucky', weapon: 'Awe_Blast', helm: 'Forge', cape: 'Absolution' };
  const vhl = { type: 'Lucky', weapon: 'Smite', helm: 'Anima', cape: 'Vainglory' };
  const w = (sName, sMeta, extra = {}) => ({ sName, sES: 'Weapon', sMeta, EnhLvl: 100, ...extra });
  // Weapon X (40%) already carries Lacerate for ArchPaladin; cape X carries Vainglory for Void Highlord.
  const items = [w('Weapon X', 'dmgAll:1.4', { EnhPatternID: 10, ProcID: 7 }), w('Weapon Y', ''), w('Weapon Z', 'dmgAll:1.15'),
    { sName: 'Cape X', sES: 'ba', sMeta: 'dmgAll:1.15', EnhLvl: 100, EnhPatternID: 24 }, { sName: 'Cape Y', sES: 'ba', sMeta: '' },
    { sName: 'Helm A', sES: 'he', sMeta: '' }, { sName: 'Helm B', sES: 'he', sMeta: '' }];
  // Lord of Order is the main class here: Weapon X has the bigger boost, but its Lacerate is ArchPaladin's.
  const k = kits.build({ roles: [{ role: 'main', cls: 'Lord of Order', plan: loo }, { role: 'solo', cls: 'ArchPaladin', plan: ap }, { role: 'seat', cls: 'Void Highlord', plan: vhl }], items, bank: [], e });
  const of = (c) => kits.forClass(k, c);
  assert(of('Lord of Order').Weapon !== 'Weapon X', 'LoO does not take the Lacerate weapon');
  eq(of('ArchPaladin').Weapon, 'Weapon X', 'ArchPaladin keeps it (no 150k again)');
  eq(of('Void Highlord').ba, 'Cape X', 'Vainglory cape stays with VHL');
  assert(of('Lord of Order').ba !== 'Cape X' && of('ArchPaladin').ba !== 'Cape X', 'nobody else takes the Vainglory cape');
  eq(kits.forgeKey(items[0], e), 'forge:Lacerate');
  eq(kits.forgeKey(items[3], e), 'cape:Vainglory');
  // The owner may change its own piece when its plan gets better (Valiance unlocked): prev kit says it is AP's.
  const ap2 = { ...ap, weapon: 'Valiance' };
  const k2 = kits.build({ roles: [{ role: 'solo', cls: 'ArchPaladin', plan: ap2 }], items, bank: [], e, prev: k });
  eq(kits.forClass(k2, 'ArchPaladin').Weapon, 'Weapon X', 'its own weapon, re-enhanced for its own new plan');
});

test('enhance: a forge special another class owns is never bought over', async () => {
  const r = fakeEnhancer({ gold: 3000000 });
  const { Bot } = require('../lib/bot');
  // The cape carries Vainglory for Void Highlord's kit; the Hood carries Pneuma for Blaze Binder's (not this class).
  const by = (n) => r.items.find((i) => i.sName === n);
  Object.assign(by('Hood'), { EnhPatternID: 27 });
  r.fake.kits = { list: [{ role: 'farm', cls: 'Blaze Binder', he: 'Hood' }, { role: 'solo', cls: 'Void Highlord', Weapon: 'Blade', ba: 'Cape' }] };
  r.fake.kitsOn = () => true;
  r.fake.lockedForge = Bot.prototype.lockedForge;
  await r.fake.enhanceEquipped();
  eq(by('Hood').EnhPatternID, 27, 'Pneuma left alone (Blaze Binder owns it)');
  assert(r.log.some((l) => /keeping Hood as it is: its forge enhancement belongs to Blaze Binder/.test(l)));
  eq(by('Cape').EnhPatternID, 24, 'its own cape gets its Vainglory');
});

test('enhance: a cape two classes share waits for its Vainglory with any basic placeholder - no Lucky/Wizard ping-pong', async () => {
  const { Bot } = require('../lib/bot');
  const e = knowledge.enh();
  const fake = { settings: {}, enhanceReserve: Bot.prototype.enhanceReserve, sharedPiece: Bot.prototype.sharedPiece, kits: { list: [{ cls: 'ArchPaladin', ba: 'Shared Cape' }, { cls: 'Blaze Binder', ba: 'Shared Cape' }] } };
  const ap = { type: 'Lucky', weapon: 'Awe_Blast', cape: 'Vainglory', helm: 'Forge' };
  const bb = { type: 'Wizard', weapon: 'Awe_Blast', cape: 'Vainglory', helm: 'Pneuma' };
  const cape = { sName: 'Shared Cape', sES: 'ba', EnhID: 5, EnhLvl: 100, EnhPatternID: 9 };   // Lucky placeholder
  assert(!Bot.prototype.enhGood.call(fake, { ...cape, sName: 'Own Cape' }, bb, e, 300000, 100), 'an unshared piece still gets its own type');
  assert(Bot.prototype.enhGood.call(fake, cape, bb, e, 300000, 100), 'poor: the Lucky placeholder is fine for Blaze Binder too');
  assert(Bot.prototype.enhGood.call(fake, cape, ap, e, 300000, 100));
  assert(!Bot.prototype.enhGood.call(fake, cape, bb, e, 3000000, 100), 'with gold: Vainglory is bought');
});
