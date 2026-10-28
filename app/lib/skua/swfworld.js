// A stand-in for skua.swf and the AQW game file, for the headless client.
//
// Skua's real engine (engine/host, C#) talks to the game only through skua.swf's ExternalInterface callbacks:
// getGameObject("world.myAvatar.items"), callGameFunction("world.acceptQuest", 123), useSkill(2), ...
// This module answers exactly those calls, with the same return strings, from a model of the game that is kept
// up to date the way the game keeps its own: every rule below is ported from the decompiled client
// (Game.as onExtensionResponseHandler, World.as, Avatar.as, BankController.as; <work>\gamesrc) and from
// skua.swf's own source (Skua.AS3/skua/src). Nothing is drawn, so display-only work is left out, and a few
// things only a renderer knows (positions, frame labels) are approximated and marked as such.
'use strict';
const https = require('https');
const manners = require('../manners');

const RANK_POINTS = (() => {       // Game.initArrRep: points needed for ranks 1..10
  const r = [0];
  for (let i = 1; i < 10; i++) {
    const p = Math.pow(i + 1, 3) * 100;
    r.push(i > 1 ? p + r[i - 1] : p + 100);
  }
  return r;
})();
function rankFromPoints(points) {
  let rank = 1;
  const p = Math.max(0, Number(points) || 0);
  for (let i = 1; i < RANK_POINTS.length; i++) { if (p < RANK_POINTS[i]) return rank; rank++; }
  return rank;
}

// A stack's size after a grant. The server's iQtyNow lags when several grants of one item land together: Nova7's
// Suppressed Undead read 48 -> 49 -> 49 on 2026-10-07 while the real stack reached 50 (47 grants + a pickup of 3).
// At the quest's amount the item stops dropping, so nothing ever corrected it and LordOfOrder's HuntMonster for 50
// waited at 49/50 for 2 h. A grant whose iQtyNow is no higher than what we already hold goes on top instead; any
// other iQtyNow is trusted as before (it also fixes a model that drifted high).
function stackAfterGrant(held, grant, now, cap) {
  held = Number(held) || 0;
  grant = Number(grant) || 0;
  if (now === undefined) return held + grant;
  let q = Number(now);
  if (grant > 0 && q <= held && held - q < grant) {
    q = held + grant;
    if (Number(cap) > 0) q = Math.min(q, Number(cap));
  }
  return q;
}

// World.lock: client-side cooldowns for actions the server would otherwise refuse ("Please slow down").
const LOCKS = {
  loadShop: 3000, loadEnhShop: 3000, loadHairShop: 3000, equipItem: 1500, unequipItem: 1500, buyItem: 1000,
  sellItem: 1000, getMapItem: 1000, tryQuestComplete: 1250, acceptQuest: 1000, doIA: 1000, rest: 1900,
  who: 3000, tfer: 3000, wearItem: 1500, unwearItem: 1500, addLoadout: 1500, removeLoadout: 1500,
  wearLoadout: 3000, equipLoadout: 3000, friendshipTalk: 1000, friendshipChoice: 1000, friendshipInfo: 1500,
  friendshipGift: 1500, friendshipStats: 3000, dungeonQueue: 5000, dungeonRejoin: 5000, dungeonMTC: 1000,
};

const LITE_DEFAULTS = {
  bAuras: false, bBattlepet: false, bCachePlayers: false, bCharSelect: false, bChatFilter: false, bChatUI: false,
  bColorSets: false, bCustomDrops: false, bDebugger: false, bDisAuraAnim: true, bDisChatScroll: false,
  bDisDmgDisplay: true, bDisDmgStrobe: true, bDisGround: true, bDisHealBubble: true, bDisMonAnim: true,
  bDisQPopup: true, bDisQTracker: true, bDisSelfMAnim: true, bDisSkillAnim: true, bDisSoundFX: true,
  bDisWepAnim: true, bDraggable: false, bFreezeMons: false, bHideMons: false, bHideNames: false,
  bHidePlayers: false, bHideUI: false, bMonsType: false, bQuestLog: false, bQuestNotif: false, bQuestPin: false,
  bReaccept: false, bSkillCD: false, bSmoothBG: false, bUntargetDead: true, bUntargetSelf: true,
  dOptions: {}, blackList: [],
};

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
// Quest requirements in the real client's order, not JavaScript's ascending item IDs (lib/questorder.js).
const questorder = require('../questorder');
// The inventory, bank and quest tree are big (40 KB for a full backpack, up to 210 KB for the bank) and Skua reads them
// over and over: their answers are reused until their own revision moves (REV_OF below).
const QUEST_WAIT = 8000;     // a quest request waits this long for its answer before it may be sent again (VWorld.getQuests)
const QUEST_NOWAIT = 60000;  // after an unanswered wait, that quest is not waited for again this long
const questWaitMs = () => Number(process.env.SERAPH_QUEST_WAIT_MS) || QUEST_WAIT;   // tests shorten it
// Option toggles CoreBots re-applies every few seconds, and game functions that only read (as in IpcFlashUtil.cs).
const HARMLESS = new Set(['killLag', 'infiniteRange', 'skipCutscenes', 'rejectExcept', 'modEnable', 'modDisable', 'disableDeathAd',
  'callGameFunction0|world.myAvatar.pMC.artLoaded', 'callGameFunction|world.isQuestInProgress', 'callGameFunction|world.getQuestValue',
  'callGameFunction|world.maximumQuestTurnIns']);
// Combat traffic (most packets in a fight) only touches the user, monster and aura trees - never the backpack, bank
// or quests - so it leaves big reads cached, here and in the engine host (engine.js tags it, Ipc.cs counts the rest).
const COMBAT_PACKETS = new Set(['ct', 'cb', 'uotls', 'mtls', 'mvna', 'mvnb', 'aura+', 'aura*', 'aura-', 'aura--', 'aura++', 'aura+p', 'clearAuras', 'respawnMon']);

// Revisions (audit 2026-09-28): every big read belongs to one structure, and each structure has a counter that moves
// only when something that can change it happens. A read is reused - here and in the engine host, which gets the
// counters pushed (engine.js) - until its own counter moves. Before, any non-combat packet and any action (every skill
// cast) threw every cached read away: ~1,200 bank reads of 100-210 KB per 10 min on the laptop.
const REV_OF = {
  'world.myAvatar.items': 'items', 'world.myAvatar.items.length': 'items', 'world.myAvatar.tempitems': 'temp',
  'world.myAvatar.houseitems': 'house', 'world.bankinfo.items': 'bank', 'world.questTree': 'quests', 'world.shopinfo': 'shop',
};
const REV_KEYS = ['items', 'temp', 'house', 'bank', 'quests', 'shop'];
// The packets that change those structures: exactly the handlers in onJson that touch the bags, the bank, the quest
// tree or the shop (any other packet leaves them alone).
function bumpsFor(d) {
  switch (d && d.cmd) {
    case 'addGoldExp': return d.iCP !== undefined ? ['items'] : null;            // class points = the class item's iQty
    case 'loadInventoryBig': return ['items', 'house'];
    case 'initInventory': return ['items'];
    case 'loadHouseInventory': return ['house'];
    case 'loadBank': return ['bank'];
    case 'loadShop': return ['shop'];
    case 'enhanceItemShop': case 'enhanceItemLocal': case 'updateClass': case 'equipItem': case 'unequipItem': case 'wearItem': case 'unwearItem': case 'wearLoadout': case 'turninscroll': case 'buyBagSlots': case 'buyBankSlots': return ['items'];
    case 'Wheel': return ['items', 'quests'];
    case 'bankFromInv': case 'bankToInv': case 'bankSwapInv':
    case 'buyItem': case 'sellItem': case 'removeItem': case 'getDrop': case 'powerGem': case 'forceAddItem': return ['items', 'house', 'bank', 'quests'];
    case 'addItems': return ['items', 'temp', 'bank', 'quests'];
    case 'turnIn': return ['items', 'temp', 'quests'];
    case 'getQuests': case 'getQuests2': case 'acceptQuest': case 'ccqr': return ['quests'];
    default: return null;
  }
}
// skua.swf 1.4.5.0 reads (AQW 5.0 inventory pools, shop requirements, HUD aura stacks): they only look.
const INVENTORY_READS = ['hasInventoryCategories', 'inventoryBagUsedSlots', 'inventoryMiscSlots', 'inventoryMiscUsedSlots', 'isFavoriteItem',
  'inventoryPool', 'inventoryHasSpaceFor', 'getUnmetPurchaseRequirements', 'GetAuraSnapshots',
  'callGameFunction|loaderInfo.applicationDomain.hasDefinition', 'callGameFunction|loaderInfo.applicationDomain.getDefinition'];
// Calls that never change a big structure (reads, targeting, skills, movement, options the model ignores). Anything
// else (set*, game functions that are not plain reads, links that write) moves every counter.
const NO_BAG_CHANGE = new Set(['isTrue', 'isNull', 'getGameObject', 'getGameObjectS', 'getGameObjectKey', 'getArrayObject', 'selectArrayObjects',
  'isLoggedIn', 'isKicked', 'walkTo', 'untargetSelf', 'attackPlayer', 'getAvatar', 'getLoadouts', 'gender', 'rejectExcept', 'jumpCorrectRoom',
  'disableDeathAd', 'skipCutscenes', 'hidePlayers', 'disableFX', 'killLag', 'availableMonsters', 'getMonsters', 'getTargetMonster',
  'attackMonsterName', 'attackMonsterID', 'canUseSkill', 'useSkill', 'infiniteRange', 'magnetize', 'magnetise', 'buyItemByName', 'buyItemByID',
  'getShopItem', 'getShopItemByID', 'getSubjectAuras', 'rebuildAuraArray', 'HasAnyActiveAura', 'GetAurasValue', 'GetPlayerAura',
  'GetMonsterAuraByName', 'GetMonsterAuraByID', 'rebuilduoTree', 'rebuildmonTree', 'catchPackets', 'sendClientPacket', 'clickServer',
  'connectToServer', 'lnkCreate', 'lnkGetChild', 'lnkGetArray', 'lnkDestroy', 'lnkGetValue', 'fcCreate', 'fcPush', 'fcPushDirect', 'fcClear',
  'fcCallFlash', 'fcCall', 'modEnable', 'modDisable', 'setBackgroundValues', 'loadClient', 'injectScript', ...INVENTORY_READS]);
// Game functions Skua calls and what they can change in the big structures ([] = nothing: they send a packet, whose
// answer moves the revision, or touch only targets, cells and timers). Not listed = could change anything.
const FN_BUMPS = {
  'world.acceptQuest': ['quests'], 'world.showQuests': ['quests'], 'world.showQuestList': ['quests'], 'world.abandonQuest': ['quests'],
  'world.completeQuest': ['quests'], 'world.checkAllQuestStatus': ['quests'], 'world.updateQuestProgress': ['quests'],
  'world.equipUseableItem': ['items'], 'world.unequipUseableItem': ['items'], 'toggleItemEquip': ['items'],
  'world.getQuests': [], 'world.getMapItem': [], 'world.tryQuestComplete': [], 'world.sendLoadShopRequest': [], 'world.sendLoadHairShopRequest': [],
  'world.sendLoadEnhShopRequest': [], 'world.sendLoadBankRequest': [], 'world.toggleBank': [], 'world.sendBuyItemRequest': [],
  'world.sendBuyItemRequestWithQuantity': [], 'world.sendSellItemRequest': [], 'world.sendEquipItemRequest': [], 'world.sendUnequipItemRequest': [],
  'world.moveToCell': [], 'world.setSpawnPoint': [], 'world.goto': [], 'world.reloadCurrentMap': [], 'world.loadMap': [], 'world.moveRequest': [],
  'world.rest': [], 'world.aggroMons': [], 'world.aggroAllMon': [], 'world.partyInvite': [], 'world.partyLeave': [], 'world.setTarget': [],
  'world.cancelTarget': [], 'world.approachTarget': [], 'world.cancelAutoAttack': [], 'world.exitCombat': [], 'world.maximumShopBuys': [],
  'world.getAvatarByUserName': [], 'world.getAvatarByUserID': [], 'world.getMonster': [], 'world.getMonstersByCell': [], 'world.uoTreeLeaf': [],
  'world.isPartyMember': [], 'world.getAchievement': [], 'world.testAction': [], 'sfc.sendString': [], 'sfc.sendXtString': [],
  'loaderInfo.applicationDomain.hasDefinition': [], 'loaderInfo.applicationDomain.getDefinition': [],
};
// The small values Skua polls from several threads (70 % of all engine calls on 2026-09-28): engine.js pushes them to
// the host whenever one changes, and the host answers them without a round trip (host Ipc.Mirror).
const MIRROR = [
  ['isLoggedIn'], ['isNull', 'world'], ['isNull', 'world.myAvatar'], ['getGameObjectS', 'serverIP'], ['isNull', 'mcConnDetail.stage'],
  ['getGameObject', 'world.myAvatar.dataLeaf.intState'], ['getGameObject', 'world.myAvatar.dataLeaf.intHP'], ['getGameObject', 'world.myAvatar.dataLeaf.intHPMax'],
  ['getGameObject', 'world.myAvatar.dataLeaf.intMP'], ['getGameObject', 'world.myAvatar.dataLeaf.intMPMax'], ['getGameObject', 'world.myAvatar.dataLeaf.intLevel'],
  ['getGameObject', 'world.strMapName'], ['getGameObject', 'world.strFrame'], ['getGameObject', 'world.strPad'], ['getGameObject', 'world.curRoom'],
  ['getGameObject', 'world.mapLoadInProgress'], ['isNull', 'world.myAvatar.target'], ['getGameObject', 'world.myAvatar.objData.strClassName'],
  ['getGameObject', 'sfc.myUserName'], ['getGameObjectS', 'loginInfo.strUsername'], ['callGameFunction0', 'world.myAvatar.pMC.artLoaded'],
  ['getGameObject', 'litePreference.data.bUntargetDead'], ['getGameObject', 'litePreference.data.bUntargetSelf'],
];
// Calls that only read: they change nothing the mirror or the revisions show, so engine.js skips its sync after them
// (canUseSkill alone is ~40 % of all calls). Anything else marks the model dirty (SwfWorld.dirty).
const PURE = new Set(['isTrue', 'isNull', 'getGameObject', 'getGameObjectS', 'getGameObjectKey', 'getArrayObject', 'selectArrayObjects',
  'isLoggedIn', 'isKicked', 'getAvatar', 'getLoadouts', 'gender', 'availableMonsters', 'getMonsters', 'canUseSkill', 'getShopItem',
  'getShopItemByID', 'getSubjectAuras', 'rebuildAuraArray', 'HasAnyActiveAura', 'GetAurasValue', 'GetPlayerAura', 'GetMonsterAuraByName',
  'GetMonsterAuraByID', 'rebuilduoTree', 'rebuildmonTree', 'lnkGetValue', 'getTargetMonster',   // marks dirty itself when it drops a dead target
  'callGameFunction0|world.myAvatar.pMC.artLoaded', 'callGameFunction|world.isQuestInProgress', 'callGameFunction|world.getQuestValue',
  'callGameFunction|world.maximumQuestTurnIns', ...INVENTORY_READS]);
const lc =(s) => String(s === undefined || s === null ? '' : s).toLowerCase();
const hidden = (obj, key, value) => Object.defineProperty(obj, key, { value, writable: true, enumerable: false, configurable: true });

// ---------------------------------------------------------------- AQW 5.0 inventory pools
// Game4000r1 InvCat (2026-10-10): the backpack is four pools. Classes never use a slot and cannot go to the bank;
// "misc" (Item, Note, Quest Item, Resource - not an Item whose sMeta is a plain number) has its own cap, sent as
// loadInventoryBig.iMiscSlots; house items are their own inventory; everything else is the bag (iBagSlots).
// skua.swf 1.4.5.0 (api/Inventory.as) asks the game's InvCat for slot counts and room; this is that class.
const InvCat = {
  MISC_TYPES: ['Item', 'Note', 'Quest Item', 'Resource'],
  KEPT_AT_ZERO: 45739,
  isClass: (it) => !!it && it.sType === 'Class',
  isMisc: (it) => !!it && InvCat.MISC_TYPES.includes(it.sType) && !(it.sType === 'Item' && it.sMeta != null && /^\s*\d+\s*$/.test(String(it.sMeta))),
  isHouse: (it) => !!it && (Number(it.bHouse) === 1 || it.bHouse === true || ['House', 'Wall Item', 'Floor Item', 'Guild'].includes(it.sType)),
  isBag: (it) => !!it && !InvCat.isClass(it) && !InvCat.isMisc(it) && !InvCat.isHouse(it),
  countBag: (items) => (items || []).filter(InvCat.isBag).length,
  countMisc: (items) => (items || []).filter(InvCat.isMisc).length,
  owned: (items, id) => (items || []).find((x) => x && Number(x.ItemID) === Number(id)) || null,
  poolOf: (it) => (InvCat.isClass(it) ? 'class' : InvCat.isHouse(it) ? 'house' : InvCat.isMisc(it) ? 'misc' : 'bag'),
  isFullFor(items, it, bagSlots, freed = 0, miscSlots = 100) {
    if (!it || InvCat.isClass(it)) return false;
    const have = InvCat.owned(items, it.ItemID);
    if (have && Number(have.iQty) < Number(have.iStk)) return false;
    if (InvCat.isMisc(it)) return !have && InvCat.countMisc(items) - freed >= miscSlots;
    return InvCat.countBag(items) - freed >= Number(bagSlots);
  },
  isToken: (it) => !!it && Number(it.TokID) > 0 && Number(it.TokQty) > 0,
  tokenNeed: (it, qty) => Math.trunc(Number(it.TokQty) * Math.max(1, Math.floor(qty / (Number(it.iQty) > 0 ? Number(it.iQty) : 1)))),
  // Slots a purchase empties: materials (and the token) whose whole stack the purchase uses up, in the same pool.
  freedBy(items, it, qty) {
    if (!it || InvCat.owned(items, it.ItemID)) return 0;
    const pool = InvCat.poolOf(it);
    if (pool !== 'bag' && pool !== 'misc') return 0;
    const bundles = Math.max(1, Math.floor(qty / (Number(it.iQty) > 0 ? Number(it.iQty) : 1)));
    let freed = 0;
    let tokenSeen = false;
    for (const t of it.turnin || []) {
      let need = Number(t.iQty) * bundles;
      if (InvCat.isToken(it) && Number(t.ItemID) === Number(it.TokID)) { tokenSeen = true; need += InvCat.tokenNeed(it, qty); }
      const o = InvCat.owned(items, t.ItemID);
      if (o && Number(t.ItemID) !== InvCat.KEPT_AT_ZERO && InvCat.poolOf(o) === pool && (o.sES === 'ar' || Number(o.iQty) <= need)) freed++;
    }
    if (InvCat.isToken(it) && !tokenSeen && Number(it.TokID) !== InvCat.KEPT_AT_ZERO) {
      const o = InvCat.owned(items, it.TokID);
      if (o && InvCat.poolOf(o) === pool && Number(o.iQty) <= InvCat.tokenNeed(it, qty)) freed++;
    }
    return freed;
  },
};

// ---------------------------------------------------------------- avatars
class VAvatar {
  constructor(world, uid, name) {
    hidden(this, 'world', world);
    this.uid = uid;
    this.pnm = lc(name);
    this.objData = null;
    this.npcType = 'player';
    hidden(this, 'target', null);
  }
  get dataLeaf() { return this.world.uoTree[this.pnm] || null; }
  get isMyAvatar() { return this.world === this.world.game.world && this.uid === this.world.game.sfc.myUserId; }
}

// The player's own avatar: inventory, factions and the functions Skua calls on it.
class VMyAvatar extends VAvatar {
  loadMovieAtES() { return null; }   // Avatar.loadMovieAtES draws gear: nothing to draw headless
  constructor(world) {
    super(world, 0, '');
    // The player's uid and name come from the connection, whenever this avatar is read.
    Object.defineProperty(this, 'uid', { get: () => world.game.sfc.myUserId, set: () => {}, enumerable: true, configurable: true });
    Object.defineProperty(this, 'pnm', { get: () => world.me, set: () => {}, enumerable: true, configurable: true });
    this.objData = { eqp: {} };
    this.items = [];
    this.tempitems = [];
    this.houseitems = [];
    this.factions = [];
    this.iBankCount = 0;
    this.invLoaded = false;
    hidden(this, 'pMC', new VAvatarMC(this));
  }
  // Avatar.getItemByID / isItemEquipped / getCPByID / getRep, as in Avatar.as
  getItemByID(id) {
    id = Number(id);
    return this.items.find((x) => Number(x.ItemID) === id) || this.houseitems.find((x) => Number(x.ItemID) === id) || null;
  }
  isItemEquipped(id) { const it = this.getItemByID(id); return !!(it && it.bEquip && Number(it.bEquip) !== 0); }
  isItemInInventory(id) { return !!this.getItemByID(id); }
  isItemInBank(id) { return !!this.world.bankinfo.bankItems[Number(id)]; }
  getCPByID(id) { const it = this.getItemByID(id); return it ? Number(it.iQty) : -1; }
  getFaction(key) {
    const n = Number(key);
    return Number.isNaN(n) ? this.factions.find((f) => lc(f.sName) === lc(key)) || null : this.factions.find((f) => Number(f.FactionID) === n) || null;
  }
  getRep(key) { const f = this.getFaction(key); return f ? Number(f.iRep) : 0; }
  isUpgraded() { return Number(this.objData.iUpgDays) >= 0; }
  isEmailVerified() { return Number(this.objData.intActivationFlag) === 5 || Number(this.objData.iEmailStatus) > 2; }
  get intPetID() { const pet = this.items.find((x) => x.bEquip && x.sES === 'pe'); return pet ? Number(pet.ItemID) : 0; }
  getItemByEquipSlot(es) { return this.items.find((x) => x.bEquip && x.sES === es) || null; }
  // Avatar.updateArmorRep: the equipped class item's quantity IS its class points. Skua reads rank 10 from it
  // (Quantity >= 302500); without this every class looked unranked and RankUpClass never finished.
  updateArmorRep() { const ar = this.getItemByEquipSlot('ar'); if (ar) ar.iQty = Number(this.objData.iCP) || 0; }

  initFaction(f) {
    f.iRep = Number(f.iRep) || 0;
    f.iRank = rankFromPoints(f.iRep);
    f.iRepToRank = f.iRank < 10 ? RANK_POINTS[f.iRank] - RANK_POINTS[f.iRank - 1] : 0;
    f.iSpillRep = f.iRep - RANK_POINTS[f.iRank - 1];
  }
  addRep(id, rep) {
    const f = this.getFaction(id);
    if (!f) return;
    f.iRep = Number(f.iRep) + Number(rep || 0);
    this.initFaction(f);
  }
  updateRep() {
    const cp = Number(this.objData.iCP) || 0;
    const rank = rankFromPoints(cp);
    this.objData.iCurCP = cp - RANK_POINTS[rank - 1];
    this.objData.iRank = rank;
    this.objData.iCPToRank = rank < 10 ? RANK_POINTS[rank] - RANK_POINTS[rank - 1] : 0;
  }

  // Avatar.addItem: bank items move to the bank, stacks grow, new items join the bag and invTree.
  addItem(item) {
    if (item.bBank && Number(item.bBank)) {
      const inv = this.items.find((x) => Number(x.CharItemID) === Number(item.CharItemID));
      if (inv) this.bankFromInv(inv.ItemID);
      this.world.bankinfo.addToBank(item);
      return;
    }
    const house = Number(item.bHouse) === 1 || ['House', 'Floor Item', 'Wall Item'].includes(item.sType);
    const bag = house ? this.houseitems : this.items;
    const have = bag.find((x) => Number(x.ItemID) === Number(item.ItemID));
    if (have) {
      have.iQty = stackAfterGrant(have.iQty, item.iQty, item.iQtyNow, have.iStk);
      return;
    }
    item.iQty = Number(item.iQty) || 0;
    this.world.invTree[item.ItemID] = item;
    bag.push(item);
  }
  // Avatar.removeItem
  removeItem(o) {
    if (o.bBank && Number(o.bBank)) { this.world.bankinfo.removeByCharItemID(o.CharItemID, o); return; }
    const qty = o.iQty === undefined ? 1 : Number(o.iQty);
    for (const bag of [this.items, this.houseitems]) {
      const i = bag.findIndex((x) => Number(x.CharItemID) === Number(o.CharItemID));
      if (i < 0) continue;
      const left = o.iQtyNow !== undefined ? Number(o.iQtyNow) : Number(bag[i].iQty) - qty;
      if (bag[i].sES === 'ar' || left < 1) {
        bag[i].iQty = 0;
        if (this.world.invTree[bag[i].ItemID]) this.world.invTree[bag[i].ItemID].iQty = 0;
        bag.splice(i, 1);
      } else bag[i].iQty = left;
      return;
    }
  }
  removeItemByID(id, qty) {
    const it = this.items.find((x) => Number(x.ItemID) === Number(id)) || this.houseitems.find((x) => Number(x.ItemID) === Number(id));
    if (it) this.removeItem({ CharItemID: it.CharItemID, iQty: qty });
  }
  addTempItem(item) {
    const have = this.tempitems.find((x) => Number(x.ItemID) === Number(item.ItemID));
    if (have) { have.iQty = Number(have.iQty) + Number(item.iQty || 0); return; }
    item.iQty = Number(item.iQty) || 0;
    this.tempitems.push(item);
    this.world.invTree[item.ItemID] = item;
  }
  removeTempItem(id, qty) {
    const i = this.tempitems.findIndex((x) => Number(x.ItemID) === Number(id));
    if (i < 0) return;
    this.tempitems[i].iQty = Number(this.tempitems[i].iQty) - Number(qty);
    if (this.tempitems[i].iQty < 1) this.tempitems.splice(i, 1);
  }
  // Avatar.bankFromInv / bankToInv / bankSwapInv
  bankFromInv(id) {
    for (const bag of [this.items, this.houseitems]) {
      const i = bag.findIndex((x) => Number(x.ItemID) === Number(id));
      if (i < 0) continue;
      if (Number(bag[i].bCoins) === 0) this.iBankCount++;
      const [it] = bag.splice(i, 1);
      this.world.bankinfo.addItemsToBank([clone(it)]);
      if (this.world.invTree[id]) this.world.invTree[id].iQty = 0;
      return;
    }
  }
  bankToInv(id) {
    const it = this.world.bankinfo.bankToInv(id);
    if (!it) return;
    const house = Number(it.bHouse) === 1 || ['House', 'Floor Item', 'Wall Item'].includes(it.sType);
    (house ? this.houseitems : this.items).push(it);
    this.world.invTree[id] = it;
  }
  bankSwapInv(invId, bankId) {
    let out = null;
    for (const bag of [this.items, this.houseitems]) {
      const i = bag.findIndex((x) => Number(x.ItemID) === Number(invId));
      if (i >= 0) { out = bag.splice(i, 1)[0]; }
    }
    const inn = this.world.bankinfo.bankToInv(bankId);
    if (!inn || !out) return;
    this.world.bankinfo.addItem(clone(out));
    if (Number(out.bCoins) === 0) this.iBankCount++;
    if (this.world.invTree[invId]) this.world.invTree[invId].iQty = 0;
    const house = Number(inn.bHouse) === 1 || ['House', 'Floor Item', 'Wall Item'].includes(inn.sType);
    (house ? this.houseitems : this.items).push(inn);
    if (Number(inn.bCoins) === 0) this.iBankCount--;
    this.world.invTree[bankId] = inn;
  }
  // Avatar.equipItem: one item per equip slot
  equipItem(id) {
    const it = this.getItemByID(id);
    if (!it) return;
    for (const x of this.items) if (x !== it && x.sES === it.sES && x.bEquip) x.bEquip = 0;
    it.bEquip = 1;
  }
  unequipItem(id) { const it = this.getItemByID(id); if (it) it.bEquip = 0; }
}

// What skua.swf reads from pMC. There is no display list, so the avatar is "loaded" as soon as the map is.
class VAvatarMC {
  constructor(avt) { hidden(this, 'avt', avt); this.x = 0; this.y = 0; this.pname = { ti: { text: '', textColor: 0xFFFFFF }, tg: { text: '', textColor: 0xFFFFFF } }; }
  artLoaded() { return this.avt.world.game.sfc.isConnected && this.avt.invLoaded; }
}

class VMonster {
  constructor(world, objData) {
    hidden(this, 'world', world);
    this.npcType = 'monster';
    this.objData = objData;
  }
  // A map slot (MonMapID) can hold a cluster of monsters; only the one whose MonID the slot's leaf carries is there
  // (World.initMonsters, Game.as spcs). The others have no dataLeaf, so Skua never sees or targets them.
  get dataLeaf() {
    const d = this.world.monTree[this.objData.MonMapID] || null;
    if (d && d.MonID !== undefined && this.objData.MonID !== undefined && Number(d.MonID) !== Number(this.objData.MonID)) return null;
    return d;
  }
  // A monster's clip exists only in the cell the player is in (World.getMonstersByCell + cell entry).
  get pMC() { const d = this.dataLeaf; return d && d.strFrame === this.world.strFrame ? {} : null; }
}

// ---------------------------------------------------------------- bank (BankController.as)
class VBank {
  // `changes` counts every write, so onPacket knows whether a packet really touched the bank (see bumpsFor).
  constructor() { this.bankItems = {}; this.requested = {}; this.loaded = false; this.changes = 0; }
  get items() { return Object.values(this.bankItems); }
  addItemsToBank(arr) { for (const it of arr || []) if (it) { this.bankItems[Number(it.ItemID)] = it; this.changes++; } }
  addItem(it) { this.bankItems[Number(it.ItemID)] = it; this.changes++; }
  addToBank(o) {
    const it = this.bankItems[Number(o.ItemID)];
    if (!it) return;
    it.iQty = stackAfterGrant(it.iQty, o.iQty, o.iQtyNow, it.iStk);
    this.changes++;
  }
  bankToInv(id) { const it = this.bankItems[Number(id)]; if (!it) return null; delete this.bankItems[Number(id)]; this.changes++; return it; }
  removeByCharItemID(cid, o) {
    for (const [k, it] of Object.entries(this.bankItems)) {
      if (Number(it.CharItemID) !== Number(cid)) continue;
      const left = o.iQtyNow !== undefined ? Number(o.iQtyNow) : Number(it.iQty) - Number(o.iQty || 1);
      if (left < 1) delete this.bankItems[k]; else it.iQty = left;
      this.changes++;
    }
  }
  isItemInBank(id) { return !!this.bankItems[Number(id)]; }
}

// ---------------------------------------------------------------- the world (World.as)
class VWorld {
  constructor(game) {
    hidden(this, 'game', game);
    hidden(this, 'bankController', new VBank());
    hidden(this, 'rootClass', game);   // World.rootClass: scripts reach the game (ui, preferences) through it
    this.myAvatar = new VMyAvatar(this);
    this.uoTree = {};
    this.monTree = {};
    this.monsters = [];
    this.mondef = [];
    this.monmap = [];
    this.avatars = {};
    this.areaUsers = [];
    this.questTree = {};
    this.invTree = {};
    this.miscSlots = 100;      // InvCat.MISC_SLOTS, from loadInventoryBig.iMiscSlots (AQW 5.0)
    this.auraDescs = {};       // World.auraDescs: aura name -> tooltip text (AQW 5.0 HUD auras)
    this.hudAuraSeq = 0;
    this.shopinfo = null;
    this.hairshopinfo = null;
    this.enhShopID = null;
    this.actions = { active: [], passive: [] };
    this.actionMap = [];
    this.strMapName = '';
    this.strMapFileName = '';
    this.strAreaName = '';
    this.strFrame = '';
    this.strPad = '';
    this.curRoom = 1;
    this.intType = 0;
    this.intKillCount = 0;
    this.objLock = null;
    this.mapLoadInProgress = false;
    this.spawnPoint = { strFrame: 'Enter', strPad: 'Spawn' };
    this.SCALE = 1;
    this.WALKSPEED = 8;
    this.GCD = 1500;
    this.GCDO = 1500;
    this.GCDTS = 0;
    this.actionID = 0;
    this.partyMembers = [];
    this.partyOwner = '';
    this.partyID = 0;
    this.bPvP = false;
    this.visible = true;
    this.uiLock = false;
    this.lock = {};
    for (const [k, cd] of Object.entries(LOCKS)) this.lock[k] = { cd, ts: 0 };
    this.map = { currentScene: { labels: [] }, currentLabel: '' };
    this.objExtra = {};
    hidden(this, 'autoTimer', null);
    hidden(this, 'shopBuyItem', null);
  }

  get bankinfo() { return this.bankController; }
  get me() { return lc(this.game.sfc.myUserName); }
  get players() { return Object.values(this.avatars).filter((a) => a && a.objData).map((a) => a.objData); }

  uoTreeLeaf(name) { return this.uoTree[lc(name)] || null; }
  uoTreeLeafSet(name, o) {
    const k = lc(name);
    const leaf = this.uoTree[k] || (this.uoTree[k] = {});
    Object.assign(leaf, o);
    return leaf;
  }
  getUoLeafById(uid) { return Object.values(this.uoTree).find((l) => Number(l.entID) === Number(uid)) || null; }
  getAvatarByUserID(uid) { return this.avatars[Number(uid)] || (Number(uid) === this.game.sfc.myUserId ? this.myAvatar : null); }
  getAvatarByUserName(name) {
    if (lc(name) === this.me) return this.myAvatar;
    return Object.values(this.avatars).find((a) => a && a.pnm === lc(name)) || null;
  }
  getMonster(id) { const all = this.monsters.filter((m) => Number(m.objData.MonMapID) === Number(id)); return all.find((m) => m.dataLeaf) || all[0] || null; }
  getMonstersByCell(cell) { return this.monsters.filter((m) => m.dataLeaf && m.dataLeaf.strFrame === cell); }
  isPartyMember(name) { return this.partyMembers.map(lc).includes(lc(name)); }

  coolDown(action) {
    const l = this.lock[action];
    if (!l) return true;
    const now = Date.now();
    if (now - l.ts < l.cd) return false;
    l.ts = now;
    return true;
  }

  send(cmd, args, room) { this.game.sfc.sendXtMessage('zm', cmd, args, 'str', room === undefined ? this.curRoom : room); }

  // ---- quests
  // The server drops quest requests that come too fast ("Please slow down") and Skua's loaders retry every ~100 ms. In
  // a network stall (2026-09-22 capture: 8.9 s with nothing coming in) Sable7 asked for quest 3931 41 times and got
  // 14 answers; CoreBots.EnsureLoad gave up, fell back to the quest file (no requirements), Story.KillQuest skipped the
  // quest and the next one stayed locked: Skua's "Quest progression recovery failed" relog loop, which parked the 13 LoC
  // goal. A quest still waiting for its answer is not asked for again for QUEST_WAIT ms, and engine.answerCall holds
  // Skua's showQuests call until the answer is here (questWait), so Skua waits instead of retrying.
  getQuests(ids) {
    const now = Date.now();
    const asked = this._questAsked || (this._questAsked = new Map());
    const fresh = [].concat(ids).map(String).filter((id) => id !== '' && !(asked.has(id) && now - asked.get(id) < questWaitMs()));
    for (const id of fresh) asked.set(id, now);
    if (fresh.length) this.send('getQuests', fresh);
  }
  // Answers arrived (SwfWorld 'getQuests'): release whoever waits for them.
  questsIn(ids) {
    for (const id of ids) if (this._questAsked) this._questAsked.delete(String(id));
    for (const wt of [...(this._questWaiters || [])]) if (wt.ids.every((id) => this.questTree[id])) wt.done(true);
  }
  // A promise for the engine, or null when there is nothing to wait for: the quests asked for and not here yet. A quest
  // the server left unanswered for QUEST_WAIT is not waited for again for QUEST_NOWAIT (a quest id it never answers must
  // not cost 8 s on every one of Skua's 20 retries).
  questWait(ids) {
    const now = Date.now();
    const noWait = this._questNoWait || (this._questNoWait = new Map());
    const want = String(ids).split(',').map((x) => x.trim()).filter((id) => id !== '' && !this.questTree[id]
      && this._questAsked && this._questAsked.has(id) && !(noWait.get(id) > now));
    if (!want.length) return null;
    const waiters = this._questWaiters || (this._questWaiters = []);
    return new Promise((resolve) => {
      const wt = { ids: want, done: (ok) => { clearTimeout(wt.timer); const i = waiters.indexOf(wt); if (i >= 0) waiters.splice(i, 1); resolve(ok); } };
      wt.timer = setTimeout(() => { for (const id of want) if (!this.questTree[id]) noWait.set(id, Date.now() + QUEST_NOWAIT); wt.done(false); }, questWaitMs());
      if (wt.timer.unref) wt.timer.unref();
      waiters.push(wt);
    });
  }
  acceptQuest(id) {
    if (!this.questTree[id]) this.getQuests([id]);
    else if (this.questTree[id].status === undefined || this.questTree[id].status === null) this.questTree[id].status = 'p';
    this._pendingAccept = this._pendingAccept || new Set();
    if (!this.questTree[id]) this._pendingAccept.add(Number(id));
    this.send('acceptQuest', [id]);
  }
  tryQuestComplete(id, itemId = -1, special = false, qty = 1) { this.send('tryQuestComplete', [id, itemId, !!special, qty, 'wvz']); }
  getMapItem(id) { if (this.coolDown('getMapItem')) this.send('getMapItem', [id]); }
  isQuestInProgress(id) { const q = this.questTree[id]; return !!(q && q.status !== undefined && q.status !== null); }
  abandonQuest(id) { if (this.questTree[id]) this.questTree[id].status = null; }
  completeQuest(id) { if (this.questTree[id]) this.questTree[id].status = null; }
  showQuests(ids, mode) { this.showQuestList(mode, ids, ids); }
  showQuestList(mode, ids) {
    const missing = String(ids).split(',').filter((x) => x !== '' && (!this.questTree[x] || this.questTree[x].strDynamic !== undefined));
    for (const id of missing) delete this.questTree[id];
    if (missing.length && ids !== '') this.getQuests(missing);
  }
  getQuestValue(slot) {
    const o = this.myAvatar.objData;
    if (!o) return -1;
    const bank = Math.floor(Number(slot) / 100);
    const field = bank > 0 ? `strQuests${bank + 1}` : 'strQuests';
    if (typeof o[field] !== 'string') return -1;
    const ch = o[field].charAt(Number(slot) - bank * 100);
    return ch === '' ? 0 : parseInt(ch, 36) || 0;
  }
  setQuestValue(slot, value) {
    const o = this.myAvatar.objData;
    const bank = Math.floor(Number(slot) / 100);
    const field = bank > 0 ? `strQuests${bank + 1}` : 'strQuests';
    let s = typeof o[field] === 'string' ? o[field] : '';
    const i = Number(slot) - bank * 100;
    while (s.length <= i) s += '0';
    o[field] = s.slice(0, i) + Number(value).toString(36) + s.slice(i + 1);
  }
  getAchievement(field, index) {
    if (index < 0 || index > 31) return -1;
    const v = this.myAvatar.objData[field];
    if (v === undefined || v === null) return -1;
    return (Number(v) & Math.pow(2, index)) === 0 ? 0 : 1;
  }
  maximumQuestTurnIns(id) {
    const q = this.questTree[id];
    let max = -1;
    if (q && Array.isArray(q.turnin) && q.turnin.length) {
      for (const t of q.turnin) {
        const inv = this.invTree[t.ItemID];
        if (!inv || Number(inv.iQty) < Number(t.iQty)) return 0;
        if (this.myAvatar.isItemEquipped(t.ItemID)) return 0;
        const n = Math.floor(Number(inv.iQty) / Number(t.iQty));
        if (max === -1 || max > n) max = n;
      }
    }
    return Math.min(max, 250);
  }
  // World.checkAllQuestStatus: a quest in progress becomes "c" (completable) once every turn-in item is held.
  checkAllQuestStatus(only) {
    const ids = only !== undefined && only !== null ? [String(only)] : Object.keys(this.questTree);
    for (const id of ids) {
      const q = this.questTree[id];
      if (!q || q.status === undefined || q.status === null) continue;
      let ok = true;
      for (const t of Array.isArray(q.turnin) ? q.turnin : []) {
        const inv = this.invTree[t.ItemID];
        if (!inv || Number(inv.iQty) < Number(t.iQty)) { ok = false; break; }
      }
      if (q.iTime !== undefined && q.iTime !== null && !(q.ts && Date.now() - q.ts <= q.iTime)) ok = false;
      q.status = ok ? 'c' : 'p';
    }
  }
  updateQuestProgress() {
    for (const [id, q] of Object.entries(this.questTree)) if (q && q.status === 'p') this.checkAllQuestStatus(id);
  }

  // Game.getQuestValidationString, only the parts that decide "can this be accepted again" (bReaccept).
  questAcceptable(q) {
    if (!q) return false;
    const me = this.myAvatar;
    if (Number(q.bUpg) === 1 && !me.isUpgraded()) return false;
    if (Number(q.iLvl) > Number(me.objData.intLevel || 0)) return false;
    if (Number(q.FactionID) > 1 && me.getRep(q.FactionID) < Number(q.iReqRep || 0)) return false;
    if (Number(q.iClass) > 0 && me.getCPByID(q.iClass) < Number(q.iReqCP || 0)) return false;
    for (const id of Object.keys(q.oReqd || {})) if (!me.getItemByID(id)) return false;
    return true;
  }

  // ---- items
  sendEquipItemRequest(item) {
    if (!item || this.myAvatar.isItemEquipped(item.ItemID)) return false;
    if (!this.coolDown('equipItem')) return false;
    this.send('equipItem', [item.ItemID]);
    return true;
  }
  sendUnequipItemRequest(item) {
    if (item && this.myAvatar.isItemEquipped(item.ItemID) && this.coolDown('unequipItem')) this.send('unequipItem', [item.ItemID]);
  }
  // World.unequipUseableItem
  unequipUseableItem(item = null) {
    const slot = (this.actions.active || []).find((a) => a && a.ref === 'i1');
    if (!slot) return;
    const was = slot.sArg1;
    slot.sArg1 = '';
    slot.sArg2 = '';
    const it = item ? this.myAvatar.getItemByID(item.ItemID) || item : this.myAvatar.items.find((x) => String(x.ItemID) === String(was));
    if (it) it.bEquip = 0;
  }
  // World.maximumShopBuys: how many of a shop item can be bought (stack room, gold/AC, merge materials). CoreBots'
  // MaxBuyQuant asks this before every merge-shop purchase (found missing by engine/tests/flashscan.js, 2026-09-20).
  maximumShopBuys(o) {
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { return 0; } }
    if (!o) return 0;
    const me = this.myAvatar;
    const have = me.getItemByID(o.ItemID);
    if (o.sES === 'ar') return 1;
    const room = have ? Number(o.iStk) - Number(have.iQty) : Number(o.iStk);
    let n = room;
    if (n < 1) return 0;
    if (Number(o.iCost) > 0) {
      const wallet = Number(o.bCoins) === 1 || o.bCoins === true ? Number(me.objData.intCoins) : Number(me.objData.intGold);
      n = Math.min(Math.floor(wallet / Number(o.iCost)), n);
    }
    if (o.turnin !== undefined && o.turnin !== null) {
      for (const t of o.turnin) {
        const inv = me.getItemByID(t.ItemID);
        if (!inv) return 0;
        const k = Math.floor(Number(inv.iQty) / Number(t.iQty));
        if (k === 0) return 0;
        n = Math.min(n, k);
      }
      n *= Number(o.iQty);
    }
    return Math.min(Math.min(n, 100000), room);
  }
  equipUseableItem(item) {
    const slot = (this.actions.active || []).find((a) => a && a.ref === 'i1');
    if (slot) { slot.sArg1 = String(item.ItemID); slot.sArg2 = String(item.sDesc || ''); }
    for (const it of this.myAvatar.items) {
      if (lc(it.sType) === 'item' && lc(it.sLink) !== 'none') {
        if (Number(it.ItemID) === Number(item.ItemID)) {
          it.bEquip = 1;
          this.send('geia', [it.sLink, it.sMeta, item.ItemID]);
        } else it.bEquip = 0;
      }
    }
  }
  sendSellItemRequest(item) { if (item && this.coolDown('sellItem')) this.send('sellItem', [item.ItemID, item.iQty || 1, item.CharItemID]); }
  sendLoadShopRequest(id) {
    if (!this.shopinfo || Number(this.shopinfo.ShopID) !== Number(id) || this.shopinfo.bLimited) {
      if (this.coolDown('loadShop')) this.send('loadShop', [id]);
    }
  }
  sendLoadHairShopRequest(id) { if (!this.hairshopinfo || Number(this.hairshopinfo.HairShopID) !== Number(id)) this.send('loadHairShop', [id]); }
  sendLoadEnhShopRequest(id) { this.send('loadEnhShop', [id]); }
  // AC wallet lock (the owner 2026-10-13: the bots' only ACs are the free ones AQW hands out). No item priced in AC is
  // bought - by Seraph or by any Skua script - unless the running task allowed it by name (client.acAllow, e.g.
  // join-legion's Undead Warrior, which is sold back). CoreBots asks first, but scripts calling Shops.BuyItem don't.
  acLocked(item) {
    if (!item || !(Number(item.bCoins) === 1 || item.bCoins === true) || !(Number(item.iCost) > 0)) return false;
    const c = this.game && this.game.client;
    if (c && c.acAllow && c.acAllow.has(String(item.sName || '').toLowerCase())) return false;
    if (c && typeof c.emit === 'function') c.emit('acRefused', { name: item.sName, cost: Number(item.iCost) });
    return true;
  }
  sendBuyItemRequest(item) {
    if (!item || !this.shopinfo || !this.coolDown('buyItem')) return;
    if (this.acLocked(item)) return;
    const me = this.myAvatar;
    if (Number(item.bStaff) === 1 && Number(me.objData.intAccessLevel) < 40) return;
    if (this.shopinfo.sField && this.getAchievement(this.shopinfo.sField, this.shopinfo.iIndex) !== 1) return;
    if (Number(item.bUpg) === 1 && !me.isUpgraded()) return;
    if (Number(item.FactionID) > 1 && me.getRep(item.FactionID) < Number(item.iReqRep)) return;
    if (Number(item.iQSindex) >= 0 && item.iQSindex !== undefined && this.getQuestValue(item.iQSindex) < Number(item.iQSvalue)) return;
    if (Number(item.bCoins) === 0 && Number(item.iCost) > Number(me.objData.intGold)) return;
    if (Number(item.bCoins) === 1 && Number(item.iCost) > Number(me.objData.intCoins)) return;
    if (!this.shopBuyItem || this.shopBuyItem.ShopItemID !== item.ShopItemID) this.shopBuyItem = item;
    this.send('buyItem', [this.shopBuyItem.ItemID, this.shopinfo.ShopID, this.shopBuyItem.ShopItemID]);
  }
  sendBuyItemRequestWithQuantity(o) {
    if (!o || !o.accept || !this.shopinfo) return;
    if (this.acLocked(o.iSel)) return;
    this.shopBuyItem = o.iSel;
    this.send('buyItem', [o.iSel.ItemID, this.shopinfo.ShopID, o.iSel.ShopItemID, o.iQty]);
  }
  sendLoadBankRequest(types = ['All']) { this.send('loadBank', types[0] === '*' ? ['All'] : types); }
  // World.toggleBank: the game fetches the whole bank over HTTP (Game.getBank -> api/char/bank) and opens it.
  toggleBank() {
    const popup = this.game.ui.mcPopup;
    if (!this.bankinfo.loaded) this.game.getBank();
    popup.currentLabel = popup.currentLabel === 'Bank' ? 'Init' : 'Bank';
  }
  // ---- movement
  moveToCell(cell, pad, clientOnly = false) {
    if (this.objLock && this.objLock[cell] !== undefined && Number(this.objLock[cell]) > Number(this.intKillCount)) return;
    this.uoTreeLeafSet(this.me, { strFrame: cell, strPad: pad, tx: 0, ty: 0 });
    this.strFrame = cell;
    this.strPad = pad;
    this.map.currentLabel = cell;
    if (!clientOnly) this.send('moveToCell', [cell, pad]);
    this.setTarget(null);
  }
  setSpawnPoint(cell, pad) { this.spawnPoint.strFrame = cell; this.spawnPoint.strPad = pad; }
  goto(name) { const me = this.uoTree[this.me]; if (me && Number(me.intState) === 1 && this.uoTree[lc(name)]) this.send('cmd', ['goto', lc(name)], 1); }
  reloadCurrentMap() { this.mapLoadInProgress = true; setTimeout(() => { this.mapLoadInProgress = false; this.touched(); }, 800); }
  // A change made by a timer, not by a packet or a call: engine.js must sync the host (SwfWorld.dirty).
  touched() { const swf = this.game && this.game.client && this.game.client.swf; if (swf) swf.dirty = true; }
  loadMap() { return this.reloadCurrentMap(); }
  moveRequest(o) { if (o) this.send('mv', [o.tx, o.ty, o.sp || this.WALKSPEED]); }
  rest() {
    const me = this.uoTree[this.me];
    if (!me || Number(me.intState) !== 1) return;
    if (this.coolDown('rest')) this.send('restRequest', [''], 1);
  }
  aggroMons(ids) { if (ids.length) this.send('aggroMon', ids); }
  aggroAllMon() { this.aggroMons(Object.keys(this.monTree).filter((k) => this.monTree[k].strFrame === this.strFrame)); }
  partyInvite(name) { this.send('gp', ['pi', name], 1); }
  partyLeave() { this.send('gp', ['pl'], 1); }
  toggleQuestLog() { }
  toggleMonsters() { }
  showMonsters() { }
  // ---- combat (World.setTarget / testAction / getActionResult / autoActionHandler)
  setTarget(t) {
    const me = this.myAvatar;
    if (t && t === me && this.game.litePreference.data.bUntargetSelf) return;
    if (me.target === t) return;
    if (t) {
      if (t.npcType === 'player' && !this.bPvP) this.cancelAutoAttack();
      me.target = t;
    } else {
      const leaf = this.uoTree[this.me];
      if (leaf && Number(leaf.intState) > 0) this.exitCombat();
      me.target = null;
    }
  }
  cancelTarget() {
    if (this.autoTimer) { this.cancelAutoAttack(); return; }
    if (this.myAvatar.target) this.setTarget(null);
  }
  // World.as approachTarget: with a living monster targeted, the auto attack starts (testAction(getAutoAttack())). The
  // walk into range is left out - the server only checks that both are in the same cell. It used to be a no-op, so the
  // auto attack only started as a side effect of a damaging skill: Sable ranking Lord of Order (rank 1, whose only
  // skill is a self-buff) stood next to 15 Frost Spirits with a target and never hit one (2026-10-12).
  approachTarget() {
    const me = this.myAvatar;
    const t = me && me.target;
    const myLeaf = this.uoTree[this.me];
    if (!t || !myLeaf || Number(myLeaf.intState) === 0) return;
    if (t.npcType !== 'monster' && !this.bPvP) return;
    const leaf = t.npcType === 'monster' ? this.monTree[t.objData.MonMapID] : t.dataLeaf;
    if (!leaf || Number(leaf.intState) === 0) return;
    if (!this.autoTimer) this.testAction(this.getAutoAttack());
  }
  cancelAutoAttack() { if (this.autoTimer) { clearTimeout(this.autoTimer); this.autoTimer = null; } }
  exitCombat() {
    for (const a of this.actions.active || []) if (a) a.lock = false;
    const leaf = this.uoTree[this.me];
    if (leaf) leaf.targets = {};
    this.cancelAutoAttack();
  }
  haste() { const leaf = this.uoTree[this.me] || {}; const sta = leaf.sta || {}; return 1 - Math.min(Math.max(Number(sta.$tha || 0), -1), 0.5); }
  getAutoAttack() { return (this.actions.active || []).find((a) => a && a.auto === true) || (this.actions.active || [])[0]; }
  getActionByActID(id) { return (this.actions.active || []).find((a) => a && a.actID === id) || null; }
  actionTimeCheck(a, noGcd = false) {
    if (!a) return false;
    const now = Date.now();
    if (a.auto) return !this.autoTimer;
    if (!noGcd && now - this.GCDTS < this.GCD) return false;
    const cd = Math.round((a.OldCD !== undefined ? a.OldCD : a.cd) * this.haste());
    if (now - Number(a.ts || 0) >= cd) { delete a.OldCD; return true; }
    return false;
  }
  cellTargets() {
    const out = [];
    for (const m of this.getMonstersByCell(this.strFrame)) if (m.dataLeaf) out.push(m);
    for (const [name, leaf] of Object.entries(this.uoTree)) {
      if (leaf.strFrame !== this.strFrame) continue;
      const avt = name === this.me ? this.myAvatar : this.getAvatarByUserName(name);
      if (avt) out.push(avt);
    }
    return out;
  }
  testAction(a, depth = 0) {
    if (!a || depth > 3) return;
    const me = this.myAvatar;
    const cLeaf = this.uoTree[this.me];
    if (!cLeaf) return;
    const tgtMin = a.tgtMin !== undefined ? Number(a.tgtMin) : 1;
    const tgtMax = a.tgtMax !== undefined ? Number(a.tgtMax) : 1;
    let err = null;
    if (!this.actionTimeCheck(a)) err = 'not ready';
    const sta = cLeaf.sta || {};
    if (!err && a.mp !== undefined && Math.round(Number(a.mp) * Number(sta.$cmc === undefined ? 1 : sta.$cmc)) > Number(cLeaf.intMP)) err = 'mana';
    if (!err && a.ref === 'i1' && !a.sArg1) err = 'no item';
    if (!err) for (const au of cLeaf.auras || []) if (['stun', 'stone', 'paralyze', 'disable', 'disabled'].includes(lc(au.cat))) err = 'stunned';
    let t = me.target;
    const scan = this.cellTargets();
    switch (a.tgt) {
      case 'h':
        if (!t) {
          if (tgtMin > 0) {
            const first = scan.find((x) => x.npcType === 'monster' && x.dataLeaf && Number(x.dataLeaf.intState) !== 0);
            if (first) { this.setTarget(first); return this.testAction(a, depth + 1); }
            err = err || 'no target';
            if (a.typ === 'aa') this.cancelAutoAttack();
          }
        } else if (t.npcType === 'player') {
          err = err || 'bad target';
          if (a.typ === 'aa') this.cancelAutoAttack();
        } else if (tgtMin > 0 && t.dataLeaf && Number(t.dataLeaf.intState) === 0) err = err || 'target dead';
        break;
      case 'f':
        if (!t) { this.setTarget(me); t = me; }
        if (t.npcType === 'monster') t = me;
        break;
      case 's':
        t = me;
        break;
      default:
    }
    if (err) return;
    const primary = t;
    let targets = [];
    for (const x of scan) {
      const leaf = x.dataLeaf;
      if (!leaf || Number(leaf.intState) === 0) continue;
      if (a.filter && x.objData && x.objData.sRace && lc(x.objData.sRace) !== lc(a.filter)) continue;
      if (a.tgt === 'h' && x.npcType !== 'monster') continue;
      if (a.tgt === 'f' && x.npcType !== 'player') continue;
      if (a.tgt === 's' && x !== me) continue;
      targets.push({ avt: x, hp: Number(leaf.intHP) });
    }
    targets.sort((p, q) => p.hp - q.hp);
    const pi = targets.findIndex((x) => x.avt === primary);
    if (pi > 0) targets.unshift(targets.splice(pi, 1)[0]);
    targets = targets.slice(0, tgtMax);
    const tLeaf = targets.length ? targets[0].avt.dataLeaf : null;
    if (Number(cLeaf.intState) === 0) return;
    if (!a.lock && (!tLeaf || Number(tLeaf.intState) !== 0) && targets.length >= tgtMin) this.doAction(a, targets);
    if (!me.target || !tLeaf || Number(tLeaf.intState) === 0) { if (a.tgt === 'h') this.exitCombat(); }
  }
  doAction(a, targets) {
    const leaf = this.uoTree[this.me];
    if (leaf) {
      leaf.targets = leaf.targets || {};
      for (const t of targets) {
        if (t.avt.npcType === 'monster') leaf.targets[t.avt.objData.MonMapID] = 'm';
        else leaf.targets[t.avt.uid] = 'p';
      }
    }
    this.getActionResult(a, targets);
  }
  getActionResult(a, targets) {
    const tgt = targets.length
      ? targets.map((t) => `${a.ref}>${t.avt.npcType === 'monster' ? `m:${t.avt.objData.MonMapID}` : `p:${t.avt.uid}`}`).join(',')
      : `${a.ref}>`;
    const args = [this.actionID, tgt];
    if (a.ref === 'i1') args.push(a.sArg1);
    args.push('wvz');
    this.send('gar', args, 1);
    const now = Date.now();
    a.lock = true;
    a.actID = this.actionID;
    this.actionID = this.actionID >= 250 ? 0 : this.actionID + 1;
    a.lastTS = a.ts;
    a.ts = now;
    if (!a.auto) {
      this._lastAct = { a, ts: a.lastTS, gcd: this.GCDTS, at: now };
      this.GCDTS = now;
      if (!this.autoTimer && a.tgt === 'h') this.testAction(this.getAutoAttack());
    } else {
      // The server's answer re-arms auto attack (showActionResult). If it never comes, try again anyway.
      this.armAutoAttack(Math.round(Number(a.cd || 2000) * this.haste()) + 1500);
    }
  }
  // "Please slow down. Last action was too soon!" comes instead of an answer: the server never did that skill. Its own
  // cooldown, the global cooldown and the lock go back to how they were, so the script can cast it again - a refused
  // Unleash Doom left Ultra Speaker's heal un-Decayed for its whole 10 s cooldown (2026-10-24). Once per skill in 3 s,
  // so a skill the server did take (the refusal was for something else) is retried once, never in a loop.
  actionRefused(now = Date.now()) {
    const u = this._lastAct;
    if (!u || now - u.at > 1000 || (u.a._refusedAt && now - u.a._refusedAt < 3000)) return false;
    this._lastAct = null;
    u.a._refusedAt = now;
    u.a.ts = u.ts;
    u.a.lock = false;
    if (this.GCDTS === u.at) this.GCDTS = u.gcd;
    return true;
  }
  armAutoAttack(ms) {
    this.cancelAutoAttack();
    this.autoTimer = setTimeout(() => { this.autoTimer = null; this.autoActionHandler(); this.touched(); }, Math.max(100, ms));
  }
  autoActionHandler() {
    const me = this.myAvatar;
    const t = me.target;
    if (this.game.litePreference.data.bUntargetDead && t && t !== me && t.dataLeaf && Number(t.dataLeaf.intState) === 0) { this.cancelTarget(); return; }
    const leaf = this.uoTree[this.me];
    if (leaf && Number(leaf.intState) !== 0 && t && t.dataLeaf && Number(t.dataLeaf.intState) !== 0) this.testAction(this.getAutoAttack());
    else this.exitCombat();
  }
  showActionResult(result, actID) {
    const a = this.getActionByActID(actID);
    if (!a) return;
    a.lock = false;
    a.actID = -1;
    const now = Date.now();
    if (a.typ === 'aa' || a.auto) {
      const cd = Math.round(Number(a.cd || 2000) * this.haste());
      let aacd = cd - (now - Number(a.ts || now));
      aacd = Math.min(cd, Math.max(cd - 100, aacd));
      this.armAutoAttack(aacd);
    }
    if (!result) a.ts = a.lastTS;
    else for (const x of this.actions.active || []) if (x && x !== a) x.lock = false;
  }
}

// ---------------------------------------------------------------- the game root (Game.as + skua.swf Main)
class VGame {
  // Game.toggleItemEquip (CoreBots equips consumables with it). MsgBox refusals return false.
  toggleItemEquip(o) {
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { return false; } }
    const w = this.world;
    const me = w.myAvatar;
    if (!o || Number((me.dataLeaf || {}).intState) !== 1 || w.bPvP) return false;   // combat / PvP
    if (Number(o.bEquip) === 1) {
      if (o.sES === 'Weapon' || o.sES === 'ar') return false;
      if (lc(o.sType) !== 'item') w.sendUnequipItemRequest(o); else w.unequipUseableItem(o);
      return true;
    }
    if (Number(o.bUpg) === 1 && !me.isUpgraded()) return false;
    if (Number(o.EnhLvl) > Number(me.objData.intLevel)) return false;
    if (lc(o.sType) !== 'item' && !['mi', 'co', 'pe', 'am'].includes(o.sES) && !(Number(o.EnhID) > 0)) return false;
    if (lc(o.sType) !== 'item') return w.sendEquipItemRequest(o);
    w.equipUseableItem(o);
    return true;
  }

  constructor(client) {
    hidden(this, 'client', client);
    this.sfc = new VSfc(client, this);
    this.world = new VWorld(this);
    this.mcLogin = { visible: false, sl: { iList: { numChildren: 0 } }, warning: { visible: false } };
    this.mcConnDetail = { stage: null, txtDetail: { text: '' } };
    this.ui = {
      mcPopup: { currentLabel: 'Init' },
      mcInterface: { areaList: { title: { t1: { text: '' } } }, mcGold: { strGold: { text: '' } } },
      monsterIcon: { redX: { visible: false } },
      mcFPS: { visible: false },
      mcPortrait: { strName: { text: '' } },
    };
    this.litePreference = { data: clone(LITE_DEFAULTS) };
    this.userPreference = { data: { bDeathAd: true } };
    this.uoPref = { bParty: true, bDuel: true, bGoto: true, bFriend: true, bWhisper: true, bTT: true, bPet: true };
    this.mcExtSWF = { numChildren: 0 };
    this.stage = { frameRate: 30 };
    this.serialCmd = { servers: [] };
    this.serialCmdMode = false;
    this.params = { sBG: '' };
    hidden(this, 'statics', { loginInfo: { strUsername: '', strPassword: '', strToken: '' }, objLogin: null, serverIP: '' });
    // The game SWF's own classes. CoreBots (AQW 5.0 update, 2026-10-10) asks for InvCat through
    // loaderInfo.applicationDomain and stops the script when it can't tell whether the client has inventory pools.
    const world = this.world;
    hidden(this, 'loaderInfo', { applicationDomain: {
      hasDefinition: (name) => name === 'InvCat',
      getDefinition: (name) => (name === 'InvCat' ? { MISC_SLOTS: world.miscSlots, MISC_TYPES: InvCat.MISC_TYPES.slice() } : null),
    } });
  }
  showInterface() { }
  menuClose() { }
  showTracking() { }
  gotoAndPlay(label) {
    if (label === 'Login') { this.mcLogin.visible = true; this.client.emit('swf-logout'); }
  }
  // The login screen: skua's Servers.Login/Relogin drive these; the headless client does the real work.
  login(user, pass) { this.client.emit('swf-login', { user, pass }); }
  logout() { this.client.emit('swf-logout'); this.mcLogin.visible = true; }
  connectTo(ip, port) { this.client.emit('swf-connect', { ip, port }); }
  getBank() {
    const w = this.world;
    const bumpBank = () => { if (this.client && this.client.swf && this.client.swf.bump) this.client.swf.bump('bank'); };
    const token = this.statics.loginInfo.strToken;
    const ccid = w.myAvatar.objData.CharID;
    // True when a request is on its way (this one or one already asked for), false when none can be made.
    if (!token || !ccid) return false;
    // One request at a time: the login fetch (hub), a held loadBank (engine.forwardPacket) and bot.bankItems can all
    // ask within the same seconds after a login. `failedAt` lets a held loadBank go on without waiting 15 s.
    if (this._bankAsked && Date.now() - this._bankAsked < 25000) return true;
    this._bankAsked = Date.now();
    const done = (ok) => { this._bankAsked = 0; if (!ok) w.bankinfo.failedAt = Date.now(); };
    const body = new URLSearchParams({ layout: JSON.stringify({ cat: 'all' }) }).toString();
    const req = https.request({
      host: 'game.aq.com', path: `/game/api/char/bank?v=${Math.random()}`, method: 'POST', timeout: 20000,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body), ccid: String(ccid), token, 'user-agent': 'Mozilla/5.0', referer: 'https://game.aq.com/game/gamefiles/' },
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let ok = false;
        try {
          const arr = JSON.parse(b);
          if (Array.isArray(arr)) { w.bankinfo.addItemsToBank(arr); w.bankinfo.loaded = true; w.bankinfo.loadedAt = Date.now(); bumpBank(); ok = true; }
        } catch (e) { this.client.record('error', `bank api: ${String(b).slice(0, 120)}`); }
        done(ok);
      });
    });
    req.on('timeout', () => req.destroy(new Error('bank api timed out')));
    req.on('error', (e) => { done(false); this.client.record('error', `bank api: ${e.message}`); });
    req.end(body);
    return true;
  }
}

class VSfc {
  constructor(client, game) { hidden(this, 'client', client); hidden(this, 'game', game); }
  get isConnected() { return !!(this.client.sock && !this.client.sock.destroyed); }
  get myUserId() { return Number(this.client.w.myAvatar.uid) || 0; }
  get myUserName() { return lc(this.client.w.myAvatar.objData.strUsername); }
  // Enhance requests a Skua script sends (CoreAdvanced, v3 UltraEnhancements / UltraLoadout) are dropped while the
  // client says so (client.blockScriptEnhance: the owner's own account always, every account in an ultra raid). Seraph's
  // own enhancing writes to the socket directly and never passes here. The owner 2026-10-17: "make sure you dont mess up
  // my enchantments" - on 10-16 v3's Drakath preset re-enhanced his StoneCrusher in a raid.
  blocked(s) {
    if (!/%xt%zm%enhanceItem(Shop|Local)%/.test(String(s))) return false;
    const on = typeof this.client.blockScriptEnhance === 'function' ? this.client.blockScriptEnhance() : !!this.client.blockScriptEnhance;
    if (on && typeof this.client.emit === 'function') this.client.emit('scriptEnhanceBlocked', String(s));
    return on;
  }
  sendString(s) { if (!this.blocked(s)) this.client.write(String(s)); }
  sendXtString(s) { if (!this.blocked(s)) this.client.write(String(s)); }
  sendJson(s) { this.client.write(typeof s === 'string' ? s : JSON.stringify(s)); }
  sendXtMessage(ext, cmd, args, type, room) {
    const a = (args || []).map((x) => (x === undefined || x === null ? '' : typeof x === 'boolean' ? String(x) : String(x)));
    const s = `%xt%${ext}%${cmd}%${room}%${a.join('%')}%`;
    if (!this.blocked(s)) this.client.write(s);
  }
  disconnect() { this.client.disconnect(); }
}

// ---------------------------------------------------------------- the packet side (Game.as handler)
class SwfWorld {
  constructor(client) {
    this.client = client;
    this.game = new VGame(client);
    this.links = new Map();        // RemoteRegistry: id -> path
    this.nextLink = 1;
    this.catching = false;         // catchPackets(): outgoing packets are reported back to Skua
    this.rev = Object.fromEntries(REV_KEYS.map((k) => [k, 1]));   // see REV_OF; they only ever grow
    this._reads = new Map();       // big read path -> { r: its structure's revision, out: the JSON }
    this.dirty = true;             // something may have changed since engine.js last synced the host (PURE)
  }

  get w() { return this.game.world; }

  bump(...keys) { for (const k of keys.length ? keys : REV_KEYS) this.rev[k]++; this.dirty = true; }

  // The mirrored values, as the exact strings call() answers (engine.js sends the ones that changed).
  mirrorSnapshot() {
    const out = {};
    for (const [fn, a] of MIRROR) {
      let v;
      try { v = this.answer(fn, a === undefined ? [] : [a]); } catch (e) { v = null; }
      out[a === undefined ? `${fn}|` : `${fn}|${a}`] = typeof v === 'string' ? v : null;
    }
    return out;
  }

  // A fresh connection starts from an empty client, as a relaunched game would. Settings survive.
  reset() {
    const lite = this.game.litePreference;
    this.w.cancelAutoAttack();
    this.game = new VGame(this.client);
    this.game.litePreference = lite;
    this.links.clear();
    this.bump();
  }

  setLogin(info, pass) {
    const s = this.game.statics;
    s.loginInfo = { strUsername: info.username, strPassword: pass || '', strToken: info.token };
    s.objLogin = { unm: info.username, iUpgDays: Number(info.upgradeDays), iLvl: info.level, userid: info.userId, bSuccess: 1, servers: info.servers || [] };
    this.game.serialCmd.servers = (info.servers || []).map((x) => ({ ...x }));
    this.game.mcLogin.sl.iList.numChildren = (info.servers || []).length;
  }
  setServer(server) { this.game.statics.serverIP = server.sIP; this.game.mcLogin.visible = false; }

  // ---- incoming, parsed by protocol.parse: {kind, cmd, room, args, data}
  onPacket(p) {
    this.dirty = true;
    const bank0 = this.w.bankinfo.changes;
    try {
      if (p.kind === 'xt') this.onStr(p.cmd, p.args || [], p.room);
      else if (p.kind === 'json') this.onJson(p.data || {});
    } catch (e) {
      this.client.record('error', `swf model (${p.cmd}): ${e.message}`);
    }
    // Cached big reads stay valid until a packet that can change their structure (bumpsFor). The bank only when the
    // packet really wrote to it: every addItems (each quest drop) used to throw the cached bank away, and Skua then
    // re-read all ~450 KB of it - 340 bank reads per 10 min on the laptop on 2026-10-11, the top engine cost.
    if (p.kind === 'json') {
      let b = bumpsFor(p.data);
      if (b && b.includes('bank') && this.w.bankinfo.changes === bank0) b = b.filter((k) => k !== 'bank');
      if (b && b.length) this.bump(...b);
    }
  }

  onStr(cmd, a) {
    const w = this.w;
    switch (cmd) {
      case 'loginResponse':
        if (a[0] === 'true') { this.game.mcLogin.visible = false; }
        return;
      case 'respawnMon':
        for (const id of String(a[0] || '').split(',')) {
          const leaf = w.monTree[id];
          if (leaf) { leaf.targets = {}; if (leaf.intHPMax !== undefined) leaf.intHP = leaf.intHPMax; leaf.intState = 1; }
        }
        return;
      case 'resTimed':
        if (a.length > 1 && a[0]) w.moveToCell(String(a[0]), String(a[1]));
        else w.moveToCell(w.spawnPoint.strFrame, w.spawnPoint.strPad);
        return;
      case 'exitArea': {
        const uid = Number(a[0]);
        const unm = lc(a[1]);
        delete w.uoTree[unm];
        const avt = w.avatars[uid];
        if (avt && w.myAvatar.target === avt) w.setTarget(null);
        delete w.avatars[uid];
        w.areaUsers = w.areaUsers.filter((x) => lc(x) !== unm);
        return;
      }
      case 'uotls': return this.userTreeWrite(a[0], this.csv(a[1]));
      case 'mtls': return this.monsterTreeWrite(Number(a[0]), this.csv(a[1]));
      case 'mvna': case 'mvnb': return;
      // Game.as spcs: a slot's monster changes into another (boss phases, transformations). It starts dead and empty;
      // its mtls brings it to life.
      case 'spcs': {
        const leaf = w.monTree[String(a[0])];
        const def = (w.mondef || []).find((x) => Number(x.MonID) === Number(a[1])) || {};
        if (!leaf) return;
        Object.assign(leaf, { intHP: 0, intMP: 0, intHPMax: def.intHPMax, intMPMax: def.intMPMax, intState: 0, iLvl: def.iLvl, MonID: Number(a[1]) });
        if (!w.monsters.some((m) => Number(m.objData.MonMapID) === Number(a[0]) && Number(m.objData.MonID) === Number(a[1]))) {
          const base = w.monsters.find((m) => Number(m.objData.MonMapID) === Number(a[0]));
          if (base) w.monsters.push(new VMonster(w, Object.assign({}, def, base.objData, { MonID: Number(a[1]), strMonName: def.strMonName || base.objData.strMonName })));
        }
        if (w.myAvatar.target && w.myAvatar.target.objData && Number(w.myAvatar.target.objData.MonMapID) === Number(a[0])) w.setTarget(null);
        return;
      }
      // The server moves the character (Game.as gtc / dungeonMTC): the client walks there and tells the server.
      // headless.js sends the moveToCell; this copy only follows (clientOnly).
      case 'gtc': if (a[0] != null && a[1] != null) w.moveToCell(String(a[0]), String(a[1]), true); return;
      // A map pad the server walked us through (Game.as mtcid, lib/mtcid-pads.json): Bot.Player.Cell follows.
      case 'mtcid': { const pad = mtcidPad(w.strMapName, a[0]); if (pad) w.moveToCell(pad[0], pad[1], true); return; }
      case 'dungeonMTC': if (a[0] === 'true') { const [cell, pad] = String(a[1] || '').split(','); if (cell) w.moveToCell(cell, pad || 'Spawn', true); } return;
      default:
    }
  }

  csv(s) {
    const o = {};
    for (const pair of String(s || '').split(',')) {
      const i = pair.indexOf(':');
      if (i > 0) o[pair.slice(0, i)] = pair.slice(i + 1);
    }
    return o;
  }

  // Game.userTreeWrite: numbers for int*/tx/ty/sp fields, afk as a boolean.
  userTreeWrite(name, o) {
    const w = this.w;
    const set = {};
    for (const [k, v0] of Object.entries(o || {})) {
      let v = v0;
      const kl = k.toLowerCase();
      if (kl.includes('int') || kl === 'tx' || kl === 'ty' || kl === 'sp' || kl === 'pvpteam') v = Math.trunc(Number(v)) || 0;
      if (kl === 'afk') v = v === true || v === 'true';
      set[k] = v;
    }
    const leaf = w.uoTreeLeafSet(name, set);
    // Game.userTreeWrite: a strFrame update means the player is in this area (World.manageAreaUser "+", lower case).
    // Without it Skua's Map.PlayerNames only knew who was here when the bot joined, and the SeraphUltras same-room check
    // saw no party at all (2026-10-18, Ultra Engineer: "Not in this room after 60 s" with all four in the room).
    if (set.strFrame !== undefined && !w.areaUsers.some((x) => lc(x) === lc(name))) w.areaUsers.push(lc(name));
    if (set.intState !== undefined && Number(set.intState) !== 2) this.hudAuraClear(leaf, false);   // Game.userTreeWrite (AQW 5.0)
    if (lc(name) === w.me) {
      // Skua reads mana and level from objData too; keep them in step with the live values.
      if (set.intMP !== undefined) w.myAvatar.objData.intMP = set.intMP;
      if (set.intLevel !== undefined) w.myAvatar.objData.intLevel = set.intLevel;
      if (set.strFrame !== undefined) { w.strFrame = set.strFrame; }
      if (set.strPad !== undefined) { w.strPad = set.strPad; }
      if (set.intState !== undefined && Number(set.intState) === 0) { w.setTarget(null); w.cancelAutoAttack(); }
    }
    return leaf;
  }

  // Game.monsterTreeWrite
  monsterTreeWrite(id, o) {
    const w = this.w;
    const leaf = w.monTree[id];
    if (!leaf) return;
    for (const [k, v0] of Object.entries(o || {})) {
      let v = v0;
      if (k.toLowerCase().includes('int')) v = Number(v);
      if (k === 'react') v = String(v).split(',').map(Number);
      leaf[k] = v;
    }
    const mon = w.getMonster(id);
    if (mon) {
      for (const k of Object.keys(o || {})) {
        if (/hp|state/i.test(k)) mon.objData[k] = Number(o[k]);
      }
    }
    if ((o.intHP !== undefined && Number(o.intHP) <= 0) || (o.intState !== undefined && Number(o.intState) !== 2)) {
      if (o.intHP !== undefined && Number(o.intHP) <= 0) {
        leaf.auras = [];
        leaf.targets = {};
        const me = w.uoTree[w.me];
        if (me && me.targets) delete me.targets[id];
        if (w.objLock) w.intKillCount++;
      } else if (o.intState !== undefined && Number(o.intState) !== 2) {
        leaf.auras = [];
        leaf.targets = {};
      }
    }
  }

  onJson(d) {
    const w = this.w;
    const me = w.myAvatar;
    switch (d.cmd) {
      case 'moveToArea': return this.onMoveToArea(d);
      case 'initUserData': return this.applyInitUserData(d);
      case 'initUserDatas': for (const o of d.a || []) this.applyInitUserData(o); return;
      case 'addGoldExp':
        if (Number(d.intExp) > 0) me.objData.intExp = Number(me.objData.intExp || 0) + Number(d.intExp);
        if (Number(d.intGold) > 0) me.objData.intGold = Number(me.objData.intGold || 0) + Number(d.intGold);
        if (d.iCP !== undefined) { me.objData.iCP = Number(me.objData.iCP || 0) + Number(d.iCP); me.updateArmorRep(); me.updateRep(); }
        if (d.FactionID !== undefined) me.addRep(d.FactionID, d.iRep);
        return;
      case 'levelUp':
        me.objData.intLevel = d.intLevel;
        me.objData.intExpToLevel = d.intExpToLevel;
        me.objData.intExp = d.xp;
        return;   // not dataLeaf/uoTree: see Game.as. The server's uotls brings real level-ups there
      case 'loadInventoryBig':
        me.iBankCount = Number(d.bankCount) || 0;
        if (d.iMiscSlots !== undefined) w.miscSlots = Number(d.iMiscSlots) || 0;
        me.items = (d.items || []).filter(Boolean);
        for (const it of me.items) { it.iQty = Number(it.iQty) || 0; w.invTree[it.ItemID] = it; }
        me.houseitems = (d.hitems || []).filter(Boolean);
        me.factions = d.factions || [];
        for (const f of me.factions) me.initFaction(f);
        if (d.guild) me.objData.guild = d.guild;
        me.invLoaded = true;
        w.uiLock = false;
        return;
      case 'initInventory':
        me.items = (d.items || []).filter(Boolean);
        for (const it of me.items) { it.iQty = Number(it.iQty) || 0; w.invTree[it.ItemID] = it; }
        return;
      case 'loadHouseInventory': me.houseitems = d.items || []; return;
      case 'loadBank':
        if (d.bitSuccess && Array.isArray(d.items)) w.bankinfo.addItemsToBank(d.items);
        return;
      case 'bankFromInv': if (Number(d.bSuccess) === 1) { me.bankFromInv(d.ItemID); w.checkAllQuestStatus(); } return;
      case 'bankToInv': me.bankToInv(d.ItemID); w.checkAllQuestStatus(); return;
      case 'bankSwapInv': me.bankSwapInv(d.invItemID, d.bankItemID); w.checkAllQuestStatus(); return;
      case 'loadShop': {
        const si = d.shopinfo;
        if (!si) return;
        if (w.shopinfo && Number(w.shopinfo.ShopID) === Number(si.ShopID) && w.shopinfo.bLimited) {
          for (const it of si.items || []) { w.shopinfo.items.push(it); w.shopinfo.items.shift(); }
        } else w.shopinfo = si;
        return;
      }
      case 'loadEnhShop': if (d.shopinfo) { w.enhShopID = d.shopinfo.ShopID; w.enhShopItems = d.shopinfo.items; } return;
      case 'loadHairShop': w.hairshopinfo = d.hairshopinfo || d; return;
      case 'enhanceItemShop': case 'enhanceItemLocal': {
        // As Game.as does it: the shop reply names its items in an `ItemIDs` list (enhanceItemLocal sends one
        // `ItemID`) and calls the pattern `EnhPID`. This used to read `ItemID` and `EnhPatternID` only, so a shop
        // enhancement never reached the model: the bot went on seeing the old level and bought the same enhancement
        // again every half hour until the next relog refreshed the inventory (check-up 2026-10-04, ~600k gold a day).
        if (d.iCost !== undefined) me.objData.intGold = Number(me.objData.intGold) - Number(d.iCost);
        const ids = (Array.isArray(d.ItemIDs) ? d.ItemIDs : d.ItemID !== undefined ? [d.ItemID] : []).map(Number);
        for (const it of me.items || []) {
          if (!ids.includes(Number(it.ItemID))) continue;
          it.iEnh = d.EnhID;
          it.EnhID = d.EnhID;
          it.EnhPatternID = d.EnhPID !== undefined ? d.EnhPID : d.EnhPatternID;
          it.EnhLvl = d.EnhLvl;
          it.EnhDPS = d.EnhDPS;
          it.EnhRng = d.EnhRng;
          it.EnhRty = d.EnhRty;
          it.ProcID = d.ProcID;
        }
        return;
      }
      case 'buyItem': {
        if (Number(d.bitSuccess) === 0 || !w.shopBuyItem) return;
        const item = clone(w.shopBuyItem);
        item.iQty = d.iQty;
        item.CharItemID = d.CharItemID;
        item.bBank = d.bBank;
        const cost = Number(item.iCost) * Number(d.iQty || 1);
        if (Number(item.bCoins) === 0) me.objData.intGold = Number(me.objData.intGold) - cost;
        else me.objData.intCoins = Number(me.objData.intCoins) - cost;
        if (!w.invTree[item.ItemID]) { w.invTree[item.ItemID] = clone(d); w.invTree[item.ItemID].iQty = 0; }
        if (!d.virtual) me.addItem(item);
        w.updateQuestProgress();
        return;
      }
      case 'sellItem':
        me.removeItem({ CharItemID: d.CharItemID, iQty: d.iQty });
        if (Number(d.bCoins) === 1) me.objData.intCoins = Number(me.objData.intCoins) + Number(d.intAmount);
        else if (Number(me.objData.intGold) < 100000000) me.objData.intGold = Number(me.objData.intGold) + Number(d.intAmount);
        w.checkAllQuestStatus();
        return;
      case 'removeItem': me.removeItem(d); w.checkAllQuestStatus(); return;
      case 'updateClass': {
        if (Number(d.uid) !== this.game.sfc.myUserId) { const avt = w.avatars[d.uid]; if (avt && avt.objData) avt.objData.strClassName = d.sClassName; return; }
        me.objData.strClassName = d.sClassName;
        me.objData.iCP = d.iCP;
        me.objData.sClassCat = d.sClassCat;
        me.updateRep();   // not updateArmorRep: the game only does that on class points (addGoldExp)
        // The inventory's class-point count can be stale (Rogue listed at 157 while the server's updateClass says 302,500).
        // updateClass carries the real points of the class just equipped: put them on that class's item, by name.
        { const cls = me.items.find((x) => x && x.sType === 'Class' && String(x.sName) === String(d.sClassName)); if (cls && d.iCP !== undefined) cls.iQty = Number(d.iCP); }
        this.newClass = true;
        return;
      }
      case 'equipItem': {
        const avt = w.getAvatarByUserID(d.uid);
        if (!avt || !avt.objData) return;
        avt.objData.eqp = avt.objData.eqp || {};
        avt.objData.eqp[d.strES] = { sFile: d.sFile === 'undefined' ? '' : d.sFile, sLink: d.sLink, sType: d.sType, ItemID: d.ItemID, sMeta: d.sMeta };
        if (avt === me && me.getItemByID(d.ItemID)) me.equipItem(d.ItemID);
        return;
      }
      case 'unequipItem': {
        const avt = w.getAvatarByUserID(d.uid);
        if (!avt || !avt.objData) return;
        if (avt.objData.eqp) delete avt.objData.eqp[d.strES];
        if (avt === me) me.unequipItem(d.ItemID);
        return;
      }
      // Cosmetics and outfits (Game.as wearItem/unwearItem/wearLoadout/loadPrefs, interface OutfitSets/outfitsetsr2.swf).
      // "Show" (wearItem) puts an item's look over a slot while the equipped item keeps giving the stats: bWear on the
      // item, one per slot. Outfits ("loadouts") are saved on the server in the prefs the server pushes (loadPrefs).
      case 'wearItem': {
        if (Number(d.uid) !== this.game.sfc.myUserId || d.success === false || d.success === 0) return;
        const it = me.getItemByID(d.ItemID);
        if (!it) return;
        for (const x of me.items) if (x.sES === it.sES) x.bWear = 0;
        it.bWear = 1;
        return;
      }
      case 'unwearItem': {
        if (Number(d.uid) !== this.game.sfc.myUserId) return;
        for (const x of me.items) if ((d.ItemID !== undefined && Number(x.ItemID) === Number(d.ItemID)) || (d.ItemID === undefined && x.sES === d.sES)) x.bWear = 0;
        return;
      }
      case 'wearLoadout': {
        if (Number(d.uid) !== this.game.sfc.myUserId || !d.costume) return;
        for (const spot of ['Weapon', 'he', 'ba', 'co']) {
          for (const x of me.items) if (x.sES === spot) x.bWear = 0;
          const c = d.costume[spot];
          const it = c && me.getItemByID(c.ItemID);
          if (it) it.bWear = 1;
        }
        return;
      }
      // Game.as balance: the server's own gold / XP numbers.
      case 'balance':
        if (d.intExp != null) me.objData.intExp = Number(d.intExp);
        if (d.intGold != null) me.objData.intGold = Number(d.intGold);
        return;
      case 'buyBagSlots': case 'buyBankSlots': case 'buyHouseSlots': case 'buyLoadoutSlots': {
        if (Number(d.bitSuccess) !== 1) return;
        const key = { buyBagSlots: 'iBagSlots', buyBankSlots: 'iBankSlots', buyHouseSlots: 'iHouseSlots', buyLoadoutSlots: 'iLoadoutSlots' }[d.cmd];
        me.objData[key] = Number(me.objData[key] || 0) + Number(d.iSlots || 0);
        me.objData.intCoins = Number(me.objData.intCoins || 0) - Number(d.iSlots || 0) * 200;
        return;
      }
      // Game.as Wheel (Wheel of Doom): two fixed drops plus the prize go straight into the backpack.
      case 'Wheel': {
        const add = (src, cid, qty) => {
          if (!src) return;
          const it = clone(src);
          it.CharItemID = cid;
          if (!w.invTree[it.ItemID]) it.bBank = 0;
          it.iQty = qty;
          if (!w.invTree[it.ItemID]) w.invTree[it.ItemID] = clone(it);
          me.addItem(it);
        };
        add((d.dropItems || {})['18927'], d.charItem1, d.dropQty != null ? Number(d.dropQty) : 1);
        add((d.dropItems || {})['19189'], d.charItem2, 1);
        add(d.Item, d.CharItemID, 1);
        w.checkAllQuestStatus();
        return;
      }
      // Game.as turninscroll -> Avatar.updateScrolls: one bit per spell scroll in objData.scrolls.
      case 'turninscroll':
        for (const id of d.IDs || []) {
          let s = me.objData.scrolls == null ? '\u0000'.repeat(500) : String(me.objData.scrolls);
          const i = Math.floor(Number(id) >> 3);
          const v = s.charCodeAt(i) | (1 << (Number(id) % 8));
          s = s.substr(0, i) + String.fromCharCode(v) + s.substr(i + 1);
          me.objData.scrolls = s;
        }
        return;
      case 'getScrolls': w.scrollData = d.scrolls; return;
      case 'loadWarVars': w.objResponse = w.objResponse || {}; w.objResponse.loadWarVars = d; return;
      case 'warvalues': w.warValues = d.wars; return;
      case 'loadQuestStringData': w.objQuestString = d.obj; return;
      case 'loadPrefs': {
        if (d.success !== false && d.result) { w.objInfo = w.objInfo || {}; w.objInfo.customs = d.result; }
        return;
      }
      case 'dropItem': case 'monsterDrops': case 'referralReward':
        for (const [id, it] of Object.entries(d.items || {})) {
          if (!w.invTree[id]) { w.invTree[id] = clone(it); w.invTree[id].iQty = 0; } else for (const [k, v] of Object.entries(it)) if (k !== 'iQty') w.invTree[id][k] = v;
        }
        return;
      case 'getDrop': {
        if (Number(d.bSuccess) !== 1) return;
        const base = w.invTree[d.ItemID];
        if (!base) return;
        const it = clone(base);
        it.CharItemID = d.CharItemID;
        it.bBank = d.bBank;
        it.iQty = Number(d.iQty);
        // The clone carries the iQtyNow of an older addItems (invTree keeps every field but iQty); use this answer's.
        if (d.iQtyNow !== undefined) it.iQtyNow = d.iQtyNow; else delete it.iQtyNow;
        if (d.EnhID !== undefined) Object.assign(it, { EnhID: Number(d.EnhID), EnhLvl: Number(d.EnhLvl), EnhPatternID: Number(d.EnhPatternID), EnhRty: Number(d.EnhRty) });
        me.addItem(it);
        w.updateQuestProgress();
        return;
      }
      case 'addItems':
        for (const [id, it0] of Object.entries(d.items || {})) {
          let it;
          if (!w.invTree[id]) {
            // A stack update (ItemID, iQty, CharItemID - no sName) for an item this world has not seen in invTree: take
            // the rest from where it was last seen (the bank, the bags). A nameless item crashed Skua's
            // CoreAdvanced.SmartEnhance (`i.Name.ToLower()`) and with it Sable7's Farmer Joe, 3x on 2026-09-22,
            // while the Cryomancer loop moved Glacera Ice Token out of the bank every 14 s.
            const known = (w.bankinfo && w.bankinfo.bankItems && w.bankinfo.bankItems[Number(id)])
              || me.items.find((x) => Number(x.ItemID) === Number(id)) || me.tempitems.find((x) => Number(x.ItemID) === Number(id));
            it = known ? Object.assign(clone(known), clone(it0)) : clone(it0);
          } else {
            it = clone(w.invTree[id]);
            for (const [k, v] of Object.entries(it0)) { it[k] = v; if (k !== 'iQty') w.invTree[id][k] = v; }
          }
          if (it.ItemID === undefined) it.ItemID = Number(id);
          if (typeof it.sName !== 'string') it.sName = '';   // Skua calls Name.ToLower() on every item
          // Game.as: `Number(bTemp) == 0` goes to the backpack, anything else to the temporary bag. With no bTemp at all
          // (an item this world has never seen), a backpack stack update carries a CharItemID and a temp item never does.
          if (it.bTemp === undefined ? it.CharItemID !== undefined : Number(it.bTemp) === 0) me.addItem(it); else me.addTempItem(it);
        }
        w.updateQuestProgress();
        return;
      case 'powerGem':
        for (const [id, it0] of Object.entries(d.items || {})) {
          const it = w.invTree[id] ? clone(w.invTree[id]) : clone(it0);
          it.iQty = Number(it0.iQty);
          me.addItem(it);
        }
        return;
      case 'forceAddItem': for (const it of Object.values(d.items || {})) me.addItem(clone(it)); return;
      case 'turnIn':
        if (d.sItems && d.sItems.length >= 3) {
          for (const part of String(d.sItems).split(',')) {
            const [id, q] = part.split(':');
            const inv = w.invTree[id];
            // Game.as: `invTree[id].bTemp == 0` leaves the backpack, anything else (true, 1, missing) the temporary bag.
            // With no invTree entry at all, whichever bag holds the item.
            const temp = inv ? !(inv.bTemp == 0) : me.tempitems.some((x) => Number(x.ItemID) === Number(id));   // eslint-disable-line eqeqeq
            if (temp) me.removeTempItem(id, Number(q)); else me.removeItemByID(id, Number(q));
          }
        }
        w.checkAllQuestStatus();
        return;
      case 'getQuests': case 'getQuests2':
        setImmediate(() => w.questsIn(Object.keys(d.quests || {})));   // after the tree below is filled
        for (const [qi, o] of Object.entries(d.quests || {})) {
          if (w.questTree[qi]) continue;
          w.questTree[qi] = o;
          for (const [k, v] of Object.entries(o.oReqd || {})) if (!w.invTree[k]) { w.invTree[k] = clone(v); w.invTree[k].iQty = 0; }
          for (const [k, v] of Object.entries(o.oItems || {})) if (!w.invTree[k]) { w.invTree[k] = clone(v); w.invTree[k].iQty = 0; }
          for (const s of ['itemsS', 'itemsC', 'itemsR', 'itemsrand']) {
            const r = o.oRewards && o.oRewards[s];
            if (!r) continue;
            for (const v of Object.values(r)) if (v && v.ItemID !== undefined && !w.invTree[v.ItemID]) { w.invTree[v.ItemID] = clone(v); w.invTree[v.ItemID].iQty = 0; }
          }
          // acceptQuest before the quest was loaded: the game marks it in progress once the data arrives.
          if (w._pendingAccept && w._pendingAccept.delete(Number(qi))) { o.status = 'p'; w.checkAllQuestStatus(qi); }
        }
        return;
      case 'acceptQuest':
        if (d.bSuccess !== undefined && Number(d.bSuccess) === 0 && w.questTree[d.QuestID]) w.questTree[d.QuestID].status = null;
        else if (d.QuestID !== undefined && w.questTree[d.QuestID]) { if (!w.questTree[d.QuestID].status) w.questTree[d.QuestID].status = 'p'; w.checkAllQuestStatus(d.QuestID); }
        return;
      case 'ccqr':
        if (Number(d.bSuccess) === 0) return;
        w.completeQuest(d.QuestID);
        if (this.game.litePreference.data.bReaccept) {
          const q = w.questTree[d.QuestID];
          if (q && !(Number(q.bOnce) > 0) && w.questAcceptable(q)) w.acceptQuest(Number(d.QuestID));
        }
        return;
      case 'updateQuest': w.setQuestValue(d.iIndex, d.iValue); return;
      case 'setAchievement': {
        const o = me.objData;
        const v = Number(o[d.field] || 0);
        o[d.field] = Number(d.value) === 1 ? (v | Math.pow(2, d.index)) : (v & ~Math.pow(2, d.index));
        return;
      }
      case 'initMonData': return;
      case 'aura+': case 'aura*': case 'aura-': case 'aura--': case 'aura++': case 'aura+p': return this.handleAuraEvent(d.cmd, d);
      case 'clearAuras': {
        const leaf = w.uoTree[w.me];
        if (leaf) leaf.auras = (leaf.auras || []).filter((x) => x.persist);
        this.hudAuraClear(leaf, true);
        return;
      }
      case 'auSnap': return this.hudAuraSnap(d);
      case 'uotls': this.userTreeWrite(d.unm, d.o); return;
      case 'mtls': this.monsterTreeWrite(Number(d.id), d.o); return;
      case 'cb': case 'ct':
        for (const [id, o] of Object.entries(d.m || {})) this.monsterTreeWrite(Number(id), o);
        for (const [name, o] of Object.entries(d.p || {})) this.userTreeWrite(name, o);
        for (const x of d.a || []) if (x) this.handleAuraEvent(x.cmd, x);
        for (const o of d.sara || []) this.handleSAR(o);
        for (const o of d.sarsa || []) this.handleSARS(o);
        return;
      case 'sar': return this.handleSAR(d);
      case 'sars': return this.handleSARS(d);
      case 'sAct': return this.onSAct(d);
      case 'seia': {
        if (Number(d.iRes) !== 1) return;
        for (const a of w.actions.active || []) {
          if (!a || a.ref !== 'i1') continue;
          delete a.tgtMax; delete a.tgtMin; delete a.auras;
          if (!w.actionTimeCheck(a, true)) { if (a.OldCD === undefined) a.OldCD = a.cd; } else a.ts = 0;
          for (const [k, v] of Object.entries(d.o || {})) if (!['nam', 'ref', 'desc', 'typ'].includes(k)) a[k] = v;
        }
        return;
      }
      case 'stu': {
        const leaf = w.uoTree[w.me];
        if (!leaf) return;
        if (d.wDPS !== undefined) leaf.wDPS = d.wDPS;
        if (d.mDPS !== undefined) leaf.mDPS = d.mDPS;
        leaf.sta = leaf.sta || {};
        for (const [k, v] of Object.entries(d.sta || {})) leaf.sta[k] = Number(v);
        if (d.tempSta) leaf.tempSta = d.tempSta;
        w.GCD = Math.round(w.haste() * w.GCDO);
        return;
      }
      // Game.as adds each name in `ul` (minus your own) to the party rather than replacing the list: the leader is
      // only ever told about the member who just joined, so replacing it dropped everyone who joined before.
      case 'pa':
        if (Array.isArray(d.ul)) w.partyMembers = [...new Set([...w.partyMembers, ...d.ul.map(lc)])].filter((n) => n && n !== w.me);
        if (d.owner) w.partyOwner = d.owner;
        if (d.pid) w.partyID = d.pid;
        return;
      case 'pr': case 'pl': case 'pk': {
        // `owner` on a pr is the NEW leader, not the member who left - reading it as the leaver removed the wrong name.
        if (d.cmd === 'pr' && d.owner) w.partyOwner = d.owner;
        const gone = lc(d.unm);
        if (!gone) return;
        if (gone === w.me) { w.partyMembers = []; w.partyID = 0; w.partyOwner = ''; } else w.partyMembers = w.partyMembers.filter((x) => x !== gone);
        return;
      }
      case 'pd': return;   // Game.as: "<name> has declined your invitation" - not a disbanded party
      case 'loadFactions': me.factions = d.factions || []; for (const f of me.factions) me.initFaction(f); return;
      case 'addFaction': if (d.faction) { me.factions.push(d.faction); me.initFaction(d.faction); } return;
      // Game.as: fishing rep comes only in CatchResult (addRep(20, myRep)), never in addGoldExp. Without it Skua's
      // FishingREP read rank < 10 forever and cast 2,500+ times after the server had capped the rep.
      case 'CatchResult': if (d.catchResult) me.addRep(20, d.catchResult.myRep); return;
      case 'xpboost': case 'gboost': case 'repboost': case 'cpboost': {
        const key = { xpboost: 'iBoostXP', gboost: 'iBoostG', repboost: 'iBoostRep', cpboost: 'iBoostCP' }[d.cmd];
        if (d.bShowShop !== undefined || d.iBoostXP !== undefined || d.iSecsLeft !== undefined) me.objData[key] = Number(d.iSecsLeft !== undefined ? d.iSecsLeft : d[key] || 0);
        return;
      }
      case 'playerDeath': return;
      default:
    }
  }

  onMoveToArea(d) {
    const w = this.w;
    const me = w.me;
    w.mapLoadInProgress = true;
    w.strAreaName = d.areaName || '';
    w.areaUsers = [];
    const myLeaf = w.uoTree[me] ? clone(w.uoTree[me]) : null;
    w.uoTree = {};
    if (myLeaf) w.uoTree[me] = myLeaf;
    w.bPvP = d.pvpTeam !== undefined;
    for (const [k, v] of Object.entries(d.auDesc || {})) w.auraDescs[k] = v;
    for (const b of d.uoBranch || []) {
      const leaf = {};
      for (const [k, v] of Object.entries(b)) {
        const kl = k.toLowerCase();
        leaf[k] = kl.includes('int') || kl === 'tx' || kl === 'ty' || kl === 'sp' ? Math.trunc(Number(v)) || 0 : v;
      }
      const name = lc(b.uoName || b.strUsername);
      if (name !== me) leaf.auras = [];
      leaf.targets = {};
      const au = leaf.au;
      delete leaf.au;
      w.uoTreeLeafSet(name, leaf);
      this.hudAuraSeed(w.uoTree[name], au);
      if (!w.areaUsers.includes(name)) w.areaUsers.push(name);   // World.manageAreaUser: lower case, once
      if (name !== me && b.entID !== undefined) {
        const avt = w.avatars[b.entID] || new VAvatar(w, Number(b.entID), name);
        w.avatars[b.entID] = avt;
      }
    }
    // Avatars of players who are no longer here go with the old map.
    for (const [uid, avt] of Object.entries(w.avatars)) if (!w.uoTree[avt.pnm]) delete w.avatars[uid];
    w.monTree = {};
    for (const b of d.monBranch || []) {
      const leaf = {};
      for (const [k, v] of Object.entries(b)) {
        const kl = k.toLowerCase();
        leaf[k] = kl.includes('int') || kl.includes('monid') || kl.includes('monmapid') ? Number(v) : v;
      }
      leaf.auras = [];
      leaf.targets = {};
      leaf.strBehave = 'walk';
      if (leaf.au != null) { this.hudAuraSeed(leaf, leaf.au); delete leaf.au; }
      w.monTree[String(b.MonMapID)] = leaf;
    }
    w.strMapName = d.strMapName || String(d.areaName || '').split('-')[0];
    w.strMapFileName = d.strMapFileName || '';
    w.intType = d.intType;
    w.intKillCount = d.intKillCount || 0;
    w.objLock = d.objLock || null;
    w.mondef = d.mondef || [];
    w.monmap = d.monmap || [];
    w.curRoom = Number(d.areaId);
    // World.initMonsters: objData = mondef merged with monmap, dataLeaf = monTree entry.
    w.monsters = [];
    for (const mm of w.monmap) {
      const def = w.mondef.find((x) => Number(x.MonID) === Number(mm.MonID)) || {};
      const objData = Object.assign({}, def, mm);
      const leaf = w.monTree[String(objData.MonMapID)];
      if (leaf) leaf.strFrame = String(objData.strFrame);
      w.monsters.push(new VMonster(w, objData));
    }
    w.myAvatar.target = null;
    w.cancelAutoAttack();
    w.shopinfo = w.shopinfo || null;
    this.game.ui.mcInterface.areaList.title.t1.text = `Map: ${w.strAreaName}`;
    this.game.world.map = { currentScene: { labels: [] }, currentLabel: w.strFrame };
    require('./mapcells').labels(w.strMapFileName).then((labels) => {
      if (this.w === w && w.strMapFileName === (d.strMapFileName || '')) w.map.currentScene.labels = labels.map((name) => ({ name }));
    }).catch(() => null);
    // No map file to load: the map is ready once the client has picked its cell (HeadlessClient does that).
    clearTimeout(this._loadTimer);
    this._loadTimer = setTimeout(() => { if (this.w === w) w.mapLoadInProgress = false; this.dirty = true; }, 900);
  }

  // Game.applyInitUserData: objData for the avatar, the player's own adds rank and dates.
  applyInitUserData(o) {
    const w = this.w;
    const data = o.data || o;
    const uid = Number(o.uid !== undefined ? o.uid : data.uid);
    if (uid === this.game.sfc.myUserId || lc(data.strUsername) === w.me) {
      const me = w.myAvatar;
      me.uid = this.game.sfc.myUserId;
      me.pnm = w.me;
      me.objData = Object.assign(me.objData || {}, data);
      me.objData.eqp = me.objData.eqp || {};
      for (const k of ['intGold', 'intCoins']) if (k in me.objData) me.objData[k] = Number(me.objData[k]);
      me.updateRep();
      w.avatars[me.uid] = me;
      const leaf = w.uoTree[w.me];
      if (leaf) leaf.intSP = 100;
      this.game.ui.mcPortrait.strName.text = data.strUsername || '';
      return;
    }
    const avt = w.avatars[uid] || new VAvatar(w, uid, data.strUsername);
    avt.objData = data;
    w.avatars[uid] = avt;
  }

  // World.handleAuraEvent + auraDataOnly (the data half; the other half only draws).
  handleAuraEvent(cmd, d) {
    const w = this.w;
    if (!d || !d.tInf) return;
    this.hudAuraSync(d, cmd);
    const leafOf = (inf) => {
      const [typ, id] = String(inf).split(':');
      return typ === 'm' ? w.monTree[Number(id)] : w.getUoLeafById(Number(id));
    };
    const tLeaf = leafOf(d.tInf);
    const cLeaf = d.cInf ? leafOf(d.cInf) : null;
    if (!tLeaf) return;
    tLeaf.auras = tLeaf.auras || [];
    tLeaf.passives = tLeaf.passives || [];
    const kind = d.cmd || cmd;
    const casterType = cLeaf ? (cLeaf.MonID !== undefined ? 'm' : 'p') : null;
    const casterId = cLeaf ? (cLeaf.MonID !== undefined ? cLeaf.MonMapID : cLeaf.entID) : null;
    if (kind === 'aura+' || kind === 'aura++' || kind === 'aura*') {
      for (const a of d.auras || []) {
        a.passive = false;
        a.casterType = casterType;
        a.casterId = casterId;
        if (a.t !== undefined) a.ts = Date.now();
        if (a.isNew || kind === 'aura*') tLeaf.auras.push(a);
        // A refresh restarts the timer too: kept at the first application, rebuildAuras dropped a stacking aura one
        // duration after it first landed while the server kept renewing it (Arcana Invoker's End of the World, 8 s,
        // re-applied every Invocation - 2026-10-19).
        else for (const x of tLeaf.auras) if (x.nam === a.nam && x.casterType === casterType && x.casterId === casterId) { x.dur = a.dur; x.val = a.val; if (a.ts) x.ts = a.ts; }
      }
    } else if (kind === 'aura+p') {
      for (const a of d.auras || []) { a.passive = true; a.casterType = casterType; a.casterId = casterId; tLeaf.passives.push(a); }
    } else if (kind === 'aura-' || kind === 'aura--') {
      const rem = d.auras || (d.aura ? [d.aura] : []);
      for (const r of rem) {
        let j = tLeaf.auras.findIndex((x) => x && x.nam === r.nam);
        if (j >= 0) tLeaf.auras.splice(j, 1);
        j = tLeaf.passives.findIndex((x) => x && x.nam === r.nam);
        if (j >= 0) tLeaf.passives.splice(j, 1);
      }
    }
  }

  // AQW 5.0 HUD auras (World.hudAuraSync / hudAuraSeed / hudAuraSnap / hudAuraClear): per leaf, aura name ->
  // {seq, n (stacks), icon, persist, dur (s), end (ms, 0 = no expiry)}. The server sends stack counts (stk) on aura
  // events, the new "aura=" (stacks only) inside cb/ct, a full list (au) per player and monster in moveToArea, and
  // auSnap for one player. Skua 1.4.5.0 reads stacks from here (GetAuraSnapshots): Advanced Skills' aura stack
  // conditions used to sum aura values instead.
  hudAuraSync(d, cmd) {
    const w = this.w;
    if (!d || !d.tInf) return;
    const kind = String(d.cmd || cmd);
    const add = kind === 'aura+' || kind === 'aura++';
    const eq = kind === 'aura=';
    if (!add && !eq && kind !== 'aura-' && kind !== 'aura--') return;
    const list = d.auras || (d.aura ? [d.aura] : null);
    if (!list) return;
    const [typ, id] = String(d.tInf).split(':');
    const leaf = typ === 'm' ? w.monTree[Number(id)] : w.getUoLeafById(Number(id));
    if (!leaf) return;
    if (typ === 'm' && leaf.intState !== undefined && leaf.intState !== null && Number(leaf.intState) === 0) return;
    const hud = leaf.hudAuras || (leaf.hudAuras = {});
    leaf.hudAurasV = (Number(leaf.hudAurasV) || 0) + 1;
    const now = Date.now();
    for (const a of list) {
      if (!a || a.nam == null) continue;
      let h = hud[a.nam];
      if (eq) {
        if (h && a.stk != null) h.n = Math.max(1, Math.trunc(Number(a.stk)) || 0);
      } else if (!add) {
        if (!h) continue;
        if (a.stk != null && Math.trunc(Number(a.stk)) > 0) {
          h.n = Math.trunc(Number(a.stk));
          if (a.dur != null && h.end > 0) { h.end = now + Number(a.dur) * 1000; if (h.dur < Number(a.dur)) h.dur = Number(a.dur); }
        } else delete hud[a.nam];
      } else {
        if (a.desc != null) w.auraDescs[a.nam] = a.desc;
        if (!h) h = hud[a.nam] = { seq: ++w.hudAuraSeq };
        h.n = a.stk != null ? Math.trunc(Number(a.stk)) || 0 : 1;
        if (a.icon != null) h.icon = String(a.icon);
        h.persist = a.persist === true;
        const dur = Number(a.dur);
        if (a.t === 's' && dur > 0) { h.dur = !a.isNew && h.dur > dur ? h.dur : dur; h.end = now + dur * 1000; } else { h.dur = 0; h.end = 0; }
      }
    }
  }
  // au: [[name, icon, dur, stacks, persist, fullDur], ...]
  hudAuraSeed(leaf, au) {
    if (!leaf) return;
    const hud = {};
    leaf.hudAuras = hud;
    leaf.hudAurasV = (Number(leaf.hudAurasV) || 0) + 1;
    if (!Array.isArray(au)) return;
    const now = Date.now();
    for (const x of au) {
      if (!Array.isArray(x) || x.length < 5 || x[0] == null) continue;
      const dur = Number(x[2]);
      const full = Number(x[5]);
      hud[x[0]] = { seq: ++this.w.hudAuraSeq, n: Math.max(1, Math.trunc(Number(x[3])) || 0), icon: String(x[1]), persist: Number(x[4]) === 1,
        dur: dur > 0 ? (full > dur ? full : dur) : 0, end: dur > 0 ? now + dur * 1000 : 0 };
    }
  }
  hudAuraSnap(d) {
    if (!d || d.unm == null || !Array.isArray(d.au)) return;
    const leaf = this.w.uoTree[lc(d.unm)];
    if (!leaf) return;
    for (const [k, v] of Object.entries(d.auDesc || {})) this.w.auraDescs[k] = v;
    this.hudAuraSeed(leaf, d.au);
  }
  // keepPersistent: clearAuras keeps persistent ones; leaving combat (intState != 2) clears them all.
  hudAuraClear(leaf, keepPersistent) {
    if (!leaf || !leaf.hudAuras) return;
    for (const k of Object.keys(leaf.hudAuras)) if (!keepPersistent || leaf.hudAuras[k].persist !== true) delete leaf.hudAuras[k];
    leaf.hudAurasV = (Number(leaf.hudAurasV) || 0) + 1;
  }
  // skua.swf 1.4.5.0 Auras.GetAuraSnapshots
  auraSnapshots(subject) {
    const w = this.w;
    const leaf = subject === 'Self' ? w.uoTree[w.me] : (w.myAvatar.target && w.myAvatar.target.dataLeaf) || null;
    if (!leaf || !leaf.hudAuras) return [];
    const now = Date.now();
    return Object.entries(leaf.hudAuras).filter(([, a]) => a).map(([nam, a]) => ({
      nam, n: Math.trunc(Number(a.n)) || 0, dur: Number(a.dur) || 0, remaining: Number(a.end) > 0 ? Math.max(0, (Number(a.end) - now) / 1000) : 0,
      persist: a.persist === true, icon: a.icon != null ? String(a.icon) : '', desc: w.auraDescs[nam] != null ? String(w.auraDescs[nam]) : '', seq: Math.trunc(Number(a.seq)) || 0,
    })).sort((x, y) => x.seq - y.seq);
  }

  handleSAR(o) {
    if (!o || !o.actionResult) return;
    const r = o.actionResult;
    const mine = String(r.cInf || '') === `p:${this.game.sfc.myUserId}`;
    if (Number(o.iRes) === 0) { if (String(r.cInf || '').startsWith('p')) this.w.showActionResult(null, o.actID); return; }
    if (mine) this.w.showActionResult(r, o.actID);
  }

  handleSARS(o) {
    if (!o) return;
    const mine = String(o.cInf || '') === `p:${this.game.sfc.myUserId}`;
    if (Number(o.iRes) === 0) { if (String(o.cInf || '').startsWith('p')) this.w.showActionResult(null, o.actID); return; }
    if (mine) this.w.showActionResult(o, o.actID);
  }

  // Game "sAct": the class skill bar. A new class replaces the bar (the potion slot survives).
  onSAct(d) {
    const w = this.w;
    const POTION = 5;
    const acts = d.actions || {};
    const incoming = acts.active || [];
    if (this.newClass || !w.actions.active || !w.actions.active.length) {
      const pot = (w.actions.active || []).find((x) => x && x.ref === 'i1');
      w.actions = { active: pot ? [null, null, null, null, null, pot] : [], passive: [] };
      w.actionMap = [];
      for (let i = 0; i < incoming.length; i++) {
        const a = incoming[i];
        if (!a) continue;
        const slot = a.ref === 'i1' ? POTION : i;
        if (a.ref === 'i1' && w.actions.active[POTION]) continue;
        a.sArg1 = ''; a.sArg2 = ''; a.ts = 0; a.actID = -1; a.lock = false;
        if (a.auto !== true) a.auto = false;
        w.actions.active[slot] = a;
        w.actionMap[slot] = a.ref;
      }
    } else {
      // Same class: only newly unlocked skills change (rank up).
      for (let i = 0; i < incoming.length; i++) {
        const a = incoming[i];
        if (!a) continue;
        const slot = a.ref === 'i1' ? POTION : i;
        const have = w.actions.active[slot];
        if (have && a.isOK && !have.isOK) have.isOK = true;
        if (!have) { a.ts = 0; a.actID = -1; a.lock = false; w.actions.active[slot] = a; }
      }
    }
    const leaf = w.uoTree[w.me];
    if (leaf) leaf.passives = [];
    w.actions.passive = [];
    for (const p of acts.passive || []) {
      const a = clone(p);
      a.sArg1 = ''; a.sArg2 = '';
      w.actions.passive.push(a);
      if (leaf && a.auras) leaf.passives.push(...a.auras);
    }
    this.newClass = false;
  }

  // ---- outgoing packets, whoever sent them (Skua, bot.js, the model itself)
  onOutgoing(msg) {
    this.dirty = true;
    const s = String(msg);
    if (!s.startsWith('%xt%')) return;
    const parts = s.split('%');       // ['', 'xt', 'zm', cmd, room, ...args, '']
    const cmd = parts[3];
    const a = parts.slice(5, -1);
    const w = this.w;
    if (cmd === 'moveToCell' && a[0] !== undefined) {
      w.strFrame = a[0];
      w.strPad = a[1] || 'Spawn';
      w.map.currentLabel = a[0];
      w.uoTreeLeafSet(w.me, { strFrame: a[0], strPad: w.strPad });
    } else if (cmd === 'acceptQuest' && w.questTree[a[0]] && !w.questTree[a[0]].status) {
      w.questTree[a[0]].status = 'p';
      this.bump('quests');
    } else if (cmd === 'buyItem' && w.shopinfo && !w.shopBuyItem) {
      w.shopBuyItem = (w.shopinfo.items || []).find((x) => Number(x.ItemID) === Number(a[0]) && Number(x.ShopItemID) === Number(a[2])) || null;
    } else if (cmd === 'buyItem' && w.shopinfo && w.shopBuyItem && Number(w.shopBuyItem.ShopItemID) !== Number(a[2])) {
      w.shopBuyItem = (w.shopinfo.items || []).find((x) => Number(x.ItemID) === Number(a[0]) && Number(x.ShopItemID) === Number(a[2])) || w.shopBuyItem;
    } else if (cmd === 'loadBank') {
      this.game.ui.mcPopup.currentLabel = this.game.ui.mcPopup.currentLabel || 'Init';
    }
  }

  // ================================================================ skua.swf's ExternalInterface
  // Returns what skua.swf returns: a string (JSON for objects), or null for void.
  call(fn, args) {
    const a = args || [];
    // A call that may change a big structure moves its revision, after it ran (so the answer and the counters agree).
    // Known game functions move only what they touch; anything unknown moves them all.
    let bumps = null;
    if (fn === 'callGameFunction' || fn === 'callGameFunction0') bumps = HARMLESS.has(`${fn}|${a[0]}`) ? [] : (FN_BUMPS[a[0]] || REV_KEYS);
    else if (!NO_BAG_CHANGE.has(fn) && !HARMLESS.has(fn)) bumps = REV_KEYS;
    if (!PURE.has(fn) && !((fn === 'callGameFunction' || fn === 'callGameFunction0') && PURE.has(`${fn}|${a[0]}`))) this.dirty = true;
    try { return this.answer(fn, a); } finally { if (bumps && bumps.length) this.bump(...bumps); }
  }

  answer(fn, a) {
    switch (fn) {
      case 'isTrue': return 'true';
      case 'isNull': return String(this.isNullPath(a[0]));
      case 'getGameObject': {
        const rk = REV_OF[a[0]];
        const hit = rk && this._reads.get(a[0]);
        if (hit && hit.r === this.rev[rk]) return hit.out;
        const v = this.resolve(this.game, a[0]);
        const out = /questTree/.test(a[0]) ? questorder.json(v) : this.json(v);
        if (rk) this._reads.set(a[0], { r: this.rev[rk], out });
        return out;
      }
      case 'getGameObjectS': return this.json(this.resolve(this.game.statics, a[0]));
      case 'getGameObjectKey': { const o = this.resolve(this.game, a[0]); const v = o === null || o === undefined ? undefined : o[a[1]]; return /questTree/.test(a[0]) ? questorder.json(v) : this.json(v); }
      case 'setGameObject': this.setPath(a[0], a[1]); return null;
      case 'setGameObjectKey': { const o = this.resolve(this.game, a[0]); if (o && typeof o === 'object') o[a[1]] = a[2]; return null; }
      case 'getArrayObject': { const o = this.resolve(this.game, a[0]); return this.json(o ? o[a[1]] : undefined); }
      case 'setArrayObject': { const o = this.resolve(this.game, a[0]); if (o) o[a[1]] = a[2]; return null; }
      case 'callGameFunction': return this.callFunction(a[0], a.slice(1));
      case 'callGameFunction0': return this.callFunction(a[0], []);
      case 'selectArrayObjects': {
        const o = this.resolve(this.game, a[0]);
        if (!Array.isArray(o)) return '';
        return JSON.stringify(o.map((x) => this.resolve(x, a[1])));
      }
      // Player.as
      case 'isLoggedIn': return String(this.game.sfc.isConnected && !!this.client.state.loaded);
      case 'isKicked': return String(!!this.game.mcLogin.warning.visible);
      case 'walkTo': {
        const pmc = this.w.myAvatar.pMC;
        pmc.x = Number(a[0]) || 0; pmc.y = Number(a[1]) || 0;
        this.w.moveRequest({ tx: pmc.x, ty: pmc.y, sp: Number(a[2]) === 8 ? this.w.WALKSPEED : Number(a[2]) });
        return null;
      }
      case 'untargetSelf': if (this.w.myAvatar.target === this.w.myAvatar) this.w.cancelTarget(); return null;
      case 'attackPlayer': {
        const p = this.w.getAvatarByUserName(a[0]);
        if (p && p.dataLeaf && p.dataLeaf.strFrame === this.w.strFrame) { this.w.setTarget(p); return 'true'; }
        return 'false';
      }
      case 'getAvatar': { const avt = this.w.avatars[Number(a[0])]; return this.json(avt ? avt.objData : undefined); }
      case 'getLoadouts': return this.json((this.w.objInfo && this.w.objInfo.customs && this.w.objInfo.customs.loadouts) || undefined);
      case 'gender': return `"${String(this.w.myAvatar.objData.strGender || '').toUpperCase()}"`;
      // No drop windows to close: unwanted drops simply expire. skua.swf 1.4.5.0 answers "true" when it rejected them, and
      // only then does Skua forget the rejected drops (ScriptDrop.RejectExceptCore).
      case 'rejectExcept': return 'true';
      // Inventory.as (skua.swf 1.4.5.0, AQW 5.0 inventory pools - see InvCat above)
      case 'hasInventoryCategories': return 'true';
      case 'inventoryBagUsedSlots': return String(InvCat.countBag(this.w.myAvatar.items));
      case 'inventoryMiscSlots': return String(this.w.miscSlots);
      case 'inventoryMiscUsedSlots': return String(InvCat.countMisc(this.w.myAvatar.items));
      case 'isFavoriteItem': return 'false';   // favourites are a mark kept by the player's own game client (FavStore); a bot has none
      case 'inventoryPool': { const it = this.parseArg(a[0]); return it ? InvCat.poolOf(it) : 'bag'; }
      case 'inventoryHasSpaceFor': return String(this.hasSpaceFor(this.parseArg(a[0]), Number(a[1] === undefined ? 1 : a[1]), a[2] === true || a[2] === 'true', this.parseArg(a[3])));
      case 'getUnmetPurchaseRequirements': return JSON.stringify(this.unmetPurchase(Number(a[0]), Number(a[1]), a[2] === undefined ? -1 : Number(a[2])));
      case 'GetAuraSnapshots': return JSON.stringify(this.auraSnapshots(a[0]));
      // World.as (skua)
      case 'jumpCorrectRoom': this.w.moveToCell(String(a[0]), String(a[1] || 'Spawn'), a[3] === true || a[3] === 'true'); return null;
      case 'disableDeathAd': this.game.userPreference.data.bDeathAd = !a[0]; return null;
      case 'skipCutscenes': this.game.mcExtSWF.numChildren = 0; return null;
      case 'hidePlayers': case 'disableFX': return null;
      case 'killLag': this.w.visible = !(a[0] === true || a[0] === 'true'); return null;
      // Monster.as
      case 'availableMonsters': return JSON.stringify(this.w.getMonstersByCell(this.w.strFrame).filter((m) => m.pMC).map((m) => this.monData(m)));
      case 'getMonsters': return JSON.stringify(this.w.monsters.map((m) => this.monData(m)));
      case 'getTargetMonster': {
        const t = this.w.myAvatar.target;
        if (!t || (t.dataLeaf && Number(t.dataLeaf.intHP) <= 0)) { this.w.cancelTarget(); if (t) this.dirty = true; return '{}'; }
        return JSON.stringify(t.npcType === 'monster' ? this.monData(t) : {});
      }
      case 'attackMonsterName': return this.attack(this.bestMonster((m) => a[0] === '*' || lc(m.objData.strMonName).includes(lc(a[0]))));
      case 'attackMonsterID': return this.attack(this.bestMonster((m) => Number(m.objData.MonMapID) === Number(a[0]) || Number(m.objData.MonID) === Number(a[0])));
      // Skills.as
      case 'canUseSkill': {
        const s = (this.w.actions.active || [])[Number(a[0])];
        const t = this.w.myAvatar.target;
        return String(!!(t && t.dataLeaf && Number(t.dataLeaf.intHP) > 0 && s && this.skuaTimeCheck(s) && s.isOK && !s.skillLock && !s.lock));
      }
      case 'useSkill': {
        const s = (this.w.actions.active || [])[Number(a[0])];
        const tg = this.w.myAvatar.target;
        if (tg && tg.npcType === 'monster' && tg.objData && !manners.checkId(this.client, tg.objData.MonMapID).ok) { this.w.cancelTarget(); return 'false'; }
        if (s && this.skuaTimeCheck(s)) { this.w.testAction(s); return 'true'; }
        return 'false';
      }
      // Combat.as
      case 'infiniteRange': for (const s of this.w.actions.active || []) if (s) s.range = 20000; return null;
      case 'magnetize': case 'magnetise': return null;
      // Shop.as
      case 'buyItemByName': return this.buy(this.shopItem((x) => lc(x.sName) === lc(a[0])), a[1]);
      case 'buyItemByID': return this.buy(this.shopItem((x) => Number(x.ItemID) === Number(a[0]) && (Number(a[1]) === -1 || Number(x.ShopItemID) === Number(a[1]))), a[2]);
      case 'getShopItem': return this.json(this.shopItem((x) => lc(x.sName) === lc(a[0])));
      case 'getShopItemByID': return this.json(this.shopItem((x) => Number(x.ItemID) === Number(a[0]) && (Number(a[1]) === -1 || Number(x.ShopItemID) === Number(a[1]))));
      // Auras.as
      case 'getSubjectAuras': return JSON.stringify(this.subjectAuras(a[0]));
      case 'rebuildAuraArray': return JSON.stringify(this.rebuildAuras(a[0]));
      case 'HasAnyActiveAura': {
        const names = String(a[1] || '').split(',').map((x) => lc(x.trim()));
        return String(this.subjectAuras(a[0]).some((x) => names.includes(lc(x.nam))));
      }
      case 'GetAurasValue': {
        const found = this.subjectAuras(a[0]).find((x) => lc(x.nam) === lc(a[1]));
        return String(found ? found.val : 444);
      }
      case 'GetPlayerAura': { const leaf = this.w.uoTree[lc(a[0])]; return JSON.stringify(leaf ? this.rebuildAuras(leaf.auras) : []); }
      case 'GetMonsterAuraByName': {
        let id = 0;
        for (const m of this.w.monsters) if (lc(m.objData.strMonName) === lc(a[0])) id = m.objData.MonMapID;
        const leaf = this.w.monTree[id];
        return leaf ? JSON.stringify(this.rebuildAuras(leaf.auras)) : "Error: Couldn't get Monster Object Tree";
      }
      case 'GetMonsterAuraByID': {
        const leaf = this.w.monTree[Number(a[0])];
        return leaf ? JSON.stringify(this.rebuildAuras(leaf.auras)) : "Error: Couldn't get Monster Object Tree";
      }
      case 'rebuilduoTree': { const leaf = this.w.uoTree[lc(a[0])]; return JSON.stringify(leaf ? { ...leaf, auras: this.rebuildAuras(leaf.auras) } : {}); }
      case 'rebuildmonTree': { const leaf = this.w.monTree[Number(a[0])]; return JSON.stringify(leaf ? { ...leaf, auras: this.rebuildAuras(leaf.auras) } : {}); }
      // Main.as packets
      case 'catchPackets': this.catching = true; return null;
      case 'sendClientPacket': this.client.inject(String(a[0]), String(a[1] || 'str')); return null;
      // Server.as
      case 'clickServer': {
        const s = (this.game.serialCmd.servers || []).find((x) => lc(x.sName).includes(lc(a[0])));
        if (!s) return 'false';
        this.client.emit('swf-connect', { server: s });
        return 'true';
      }
      case 'connectToServer': {
        let s = null;
        try { s = JSON.parse(a[0]); } catch (e) { s = null; }
        if (s) this.client.emit('swf-connect', { server: s });
        return 'true';
      }
      // RemoteRegistry.as: handles on a path, read live on every use
      case 'lnkCreate': return this.link(String(a[0]));
      case 'lnkGetChild': return this.link(`${this.links.get(Number(a[0])) || ''}.${a[1]}`);
      case 'lnkGetArray': return this.link(`${this.links.get(Number(a[0])) || ''}.${a[1]}`);
      case 'lnkDestroy': this.links.delete(Number(a[0])); return null;
      case 'lnkDeleteChild': { const p = this.links.get(Number(a[0])); if (p) this.setPath(`${p}.${a[1]}`, undefined); return null; }
      case 'lnkGetValue': { const p = this.links.get(Number(a[0])); return p ? this.json(this.resolve(this.game, p)) : null; }
      case 'lnkSetValue': { const p = this.links.get(Number(a[0])); if (p) this.setPath(p, a[1]); return null; }
      case 'lnkSetArray': { const p = this.links.get(Number(a[0])); if (p) this.setPath(`${p}.${a[1]}`, a[2]); return null; }
      case 'lnkCall': { const p = this.links.get(Number(a[0])); return p ? this.callFunction(`${p}.${a[1]}`, a.slice(2)) : null; }
      case 'fcCreate': case 'fcPush': case 'fcPushDirect': case 'fcClear': case 'fcCallFlash': case 'fcCall': return null;
      case 'modEnable': case 'modDisable': case 'setBackgroundValues': case 'loadClient': case 'injectScript': return null;
      default:
        return { error: `skua.swf has no '${fn}'` };
    }
  }

  link(path) { const id = this.nextLink++; this.links.set(id, path); return String(id); }

  parseArg(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (e) { return null; }
  }

  // Inventory.inventoryHasSpaceFor (skua.swf 1.4.5.0): room in the item's own pool. `qty` is the amount bought, and a
  // purchase counts the slots its materials free; `outgoing` is the item a bank swap sends back (same pool = one free).
  hasSpaceFor(item, qty = 1, purchase = false, outgoing = null) {
    if (!item) return false;
    const me = this.w.myAvatar;
    const items = me.items || [];
    if (InvCat.isHouse(item)) return (me.houseitems || []).length < Number(me.objData.iHouseSlots || 0);
    let freed = purchase ? InvCat.freedBy(items, item, qty) : 0;
    if (outgoing && InvCat.poolOf(outgoing) === InvCat.poolOf(item)) freed++;
    return !InvCat.isFullFor(items, item, Number(me.objData.iBagSlots || 0), freed, this.w.miscSlots);
  }

  // Shop.getUnmetPurchaseRequirements (skua.swf 1.4.5.0): what the backpack lacks for one purchase. Banked materials
  // do not count. Skua buys nothing while this list is not empty.
  unmetPurchase(itemID, shopItemID, quantity = -1) {
    const w = this.w;
    const item = this.shopItem((x) => Number(x.ItemID) === itemID && (shopItemID === -1 || Number(x.ShopItemID) === shopItemID));
    if (!item) return ['Item is not in the loaded shop.'];
    const missing = [];
    const bundle = Math.max(1, Math.trunc(Number(item.iQty)) || 0);
    const bought = quantity === -1 ? bundle : quantity;
    if (!(bought > 0)) return ['Purchase quantity must be positive.'];
    if (item.iQSindex != null && Number(item.iQSindex) >= 0 && Number(w.getQuestValue(item.iQSindex)) < Number(item.iQSvalue)) missing.push('Quest requirement not met.');
    const bundles = Math.max(1, Math.floor(bought / bundle));
    const need = {};
    const names = {};
    for (const m of item.turnin || []) {
      const id = Math.trunc(Number(m.ItemID));
      need[id] = (need[id] || 0) + Number(m.iQty) * bundles;
      names[id] = m.sName;
    }
    if (Number(item.TokID) > 0 && Number(item.TokQty) > 0) {
      const id = Math.trunc(Number(item.TokID));
      need[id] = (need[id] || 0) + Math.trunc(Number(item.TokQty) * bundles);
      if (item.TokName) names[id] = item.TokName;
    }
    for (const [id, n] of Object.entries(need)) {
      const owned = w.invTree[id];
      const have = owned ? Math.trunc(Number(owned.iQty)) || 0 : 0;
      if (have < n) missing.push(`Missing ${n - have} x ${names[id] != null ? names[id] : owned ? owned.sName : `Item #${id}`} in inventory.`);
    }
    return missing;
  }

  json(v) { if (v === undefined) return null; try { return JSON.stringify(v); } catch (e) { return null; } }

  // Main._getObjectA: walk a dotted path. Getters (bankinfo.items, dataLeaf, pMC) count as properties.
  resolve(root, path) {
    if (path === undefined || path === null) return undefined;
    let o = root;
    for (const part of String(path).split('.')) {
      if (o === null || o === undefined) return undefined;
      o = o[part];
    }
    return o;
  }

  isNullPath(path) {
    try { const v = this.resolve(this.game, path); return v === null || v === undefined; } catch (e) { return true; }
  }

  setPath(path, value) {
    const parts = String(path).split('.');
    const key = parts.pop();
    const o = this.resolve(this.game, parts.join('.'));
    if (!o || typeof o !== 'object') return;
    if (value === undefined) delete o[key]; else o[key] = value;
  }

  callFunction(path, args) {
    const parts = String(path).split('.');
    const name = parts.pop();
    const owner = parts.length ? this.resolve(this.game, parts.join('.')) : this.game;
    if (!owner) return { error: `no game function '${path}'` };
    // ActionScript makes no difference between reading a property and calling it with no arguments, so scripts use
    // both spellings for the same thing (Ultrasv3 asks for world.myAvatar.intPetID through CallGameFunction).
    if (typeof owner[name] !== 'function') {
      if (!(name in owner) || owner[name] === undefined) return { error: `no game function '${path}'` };
      return JSON.stringify(owner[name]);
    }
    const out = owner[name](...args);
    return out === undefined ? null : JSON.stringify(out);
  }

  // Monster.getMonData
  monData(m) {
    const o = { ...m.objData };
    const d = m.dataLeaf;
    if (d) { o.intHP = d.intHP; o.intHPMax = d.intHPMax; o.intState = d.intState; }
    return o;
  }

  // Monster.getBestMonsterTarget: live ones first, then lowest HP, then lowest map id.
  bestMonster(match) {
    const list = this.w.getMonstersByCell(this.w.strFrame).filter((m) => m.pMC && match(m));
    if (!list.length) return null;
    const hp = (m) => (m.dataLeaf && m.dataLeaf.intHP ? Number(m.dataLeaf.intHP) : 0);
    list.sort((x, y) => ((hp(x) > 0) !== (hp(y) > 0) ? (hp(x) > 0 ? -1 : 1) : hp(x) !== hp(y) ? hp(x) - hp(y) : Number(x.objData.MonMapID) - Number(y.objData.MonMapID)));
    return list[0];
  }

  attack(target) {
    if (!target || !target.pMC) return 'false';
    if (target.objData && !manners.checkId(this.client, target.objData.MonMapID).ok) return 'false';   // lib/manners.js
    this.w.setTarget(target);
    this.w.approachTarget();
    return 'true';
  }

  // Skills.actionTimeCheck (skua's copy: the global cooldown always applies, auto attack included)
  skuaTimeCheck(s) {
    const now = Date.now();
    if (now - this.w.GCDTS < this.w.GCD) return false;
    const cd = Math.round((s.OldCD !== undefined ? s.OldCD : s.cd) * this.w.haste());
    if (now - Number(s.ts || 0) >= cd) { delete s.OldCD; return true; }
    return false;
  }

  shopItem(match) {
    const si = this.w.shopinfo;
    if (!si || !Array.isArray(si.items)) return null;
    const hit = si.items.find((x) => x && match(x));
    if (!hit) return null;
    return si.items.find((x) => x && Number(x.ItemID) === Number(hit.ItemID) && Number(x.ShopItemID) === Number(hit.ShopItemID)) || hit;
  }

  buy(item, qty) {
    if (!item) return null;
    const q = qty === undefined || qty === null ? -1 : Number(qty);
    if (q === -1) this.w.sendBuyItemRequest(item);
    else this.w.sendBuyItemRequestWithQuantity({ iSel: item, iQty: q, accept: 1 });
    return null;
  }

  // Auras.getSubjectAuras / rebuildAuraArray
  subjectAuras(subject) {
    const w = this.w;
    if (subject === 'Self') { const leaf = w.uoTree[w.me]; return this.rebuildAuras(leaf ? leaf.auras : []); }
    const t = w.myAvatar.target;
    const id = t && t.dataLeaf ? Number(t.dataLeaf.MonMapID || 0) : 0;
    const leaf = w.monTree[id];
    return this.rebuildAuras(leaf ? leaf.auras : []);
  }
  rebuildAuras(auras) {
    const out = [];
    const now = Date.now();
    for (const a of Array.isArray(auras) ? auras : []) {
      if (!a || !a.nam || Number(a.e) === 1) continue;
      // The game drops an aura when the server says so; a lost "aura-" would otherwise leave it forever.
      if (a.dur && a.ts && Number(a.ts) + Number(a.dur) * 1000 + 2000 < now) continue;
      const r = {};
      for (const [k, v] of Object.entries(a)) r[k] = k === 'cLeaf' ? 'cycle_' : v;
      if (r.val === undefined || r.val === null || Number.isNaN(Number(r.val))) r.val = 1;
      out.push(r);
    }
    return out;
  }
}

// Server-driven moves through a map's event pads (Game.as mtcid -> World.moveToCellByIDb): tID -> [cell, pad].
let MTCID_PADS = null;
function mtcidPad(map, tid) {
  if (!MTCID_PADS) { try { MTCID_PADS = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'mtcid-pads.json'), 'utf8')); } catch (e) { MTCID_PADS = {}; } }
  const t = MTCID_PADS[String(map || '').toLowerCase().split('-')[0]];
  return (t && t[String(Number(tid))]) || null;
}

module.exports = { SwfWorld, rankFromPoints, RANK_POINTS, COMBAT_PACKETS, InvCat, MIRROR, mtcidPad };
