// A small simulated AQW client that speaks the Skua bridge API, for unit tests (no network, no Flash).
const EventEmitter = require('events');

function getPath(root, p) {
  return String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), root);
}
function setPath(root, p, v) {
  const parts = String(p).split('.');
  const last = parts.pop();
  const obj = parts.reduce((o, k) => (o[k] = o[k] || {}), root);
  obj[last] = v;
}

class FakeGame extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.state = { page: true, bridge: true, loaded: true };
    this.sent = [];
    this.opts = Object.assign({ killEvery: 1, dropItem: null, unavailableMaps: [], password: 'pw' }, opts);
    this.questDb = opts.questDb || {};         // id -> {turnin:[{ItemID,iQty}], rewardItem?}
    this.questValues = {};                      // slot -> value
    this.dailies = {};                          // field:index -> value
    this.shops = opts.shops || {};              // id -> items
    this.monsterDrops = opts.monsterDrops || {}; // monster name -> {ItemID, sName, bTemp}
    this.root = {
      sfc: { isConnected: false },
      mcExtSWF: { numChildren: 0 },
      objLogin: null,
      world: null,
    };
    this.inProgress = new Set();
    this.hits = 0;
  }

  enterWorld(level = 5) {
    this.root.sfc.isConnected = true;
    this.root.world = {
      visible: true, strMapName: 'battleon', strFrame: 'Enter', curRoom: 7, questTree: {},
      myAvatar: {
        target: null,
        objData: { strUsername: 'Tester', intLevel: level, intGold: 100000, intExp: 0, intExpToLevel: 1000, strClassName: 'Healer', iBagSlots: 30, iUpgDays: -1 },
        dataLeaf: { intHP: 1000, intHPMax: 1000, intMP: 100, intMPMax: 100 },
        items: [
          { sName: 'Healer', ItemID: 1, CharItemID: 11, sES: 'ar', bEquip: true, EnhLvl: 1, EnhID: 0, iQty: 1 },
          { sName: 'Default Staff', ItemID: 3, CharItemID: 13, sES: 'Weapon', bEquip: true, EnhLvl: 1, EnhID: 0, iQty: 1 },
          { sName: 'Spare Sword', ItemID: 28, CharItemID: 28, sES: 'Weapon', bEquip: false, EnhLvl: 1, EnhID: 0, iQty: 1 },
          { sName: 'A Fish', ItemID: 76322, CharItemID: 99, sES: 'None', bEquip: false, iQty: 1 },
        ],
        tempitems: [],
      },
      actions: { active: { 1: { mp: 0 }, 2: { mp: 20 }, 3: { mp: 500 }, 4: { mp: 0 }, 5: { mp: 0 } } },
      shopinfo: null,
      monsters: [{ strMonName: 'Frogzard', strFrame: 'r2', intHP: 100 }, { strMonName: 'Slime', strFrame: 'r3', intHP: 100 }],
    };
  }

  // ---- GameClient surface ----
  async get(p) { return this.call('getGameObject', p); }
  async fn(p, ...a) { return this.call('callGameFunction', p, ...a); }
  async send(packet) { return this.call('callGameFunction', 'sfc.sendString', packet); }

  pext(obj) { this.emit('event', { kind: 'pext', data: JSON.stringify({ params: { type: 'json', dataObj: obj } }) }); }
  pstr(arr) { this.emit('event', { kind: 'pext', data: JSON.stringify({ params: { type: 'str', dataObj: arr } }) }); }

  item(name) { return this.root.world.myAvatar.items.find((i) => i.sName === name) || this.root.world.myAvatar.tempitems.find((i) => i.sName === name); }
  addItem(it, qty = 1) {
    const list = it.bTemp ? this.root.world.myAvatar.tempitems : this.root.world.myAvatar.items;
    const have = list.find((i) => i.ItemID === it.ItemID);
    if (have) have.iQty += qty; else list.push(Object.assign({ iQty: qty, bEquip: false, sES: 'None' }, it));
  }

  async call(fn, ...args) {
    const w = this.root.world;
    switch (fn) {
      case 'getGameObject': { if (args[0] === 'world.myAvatar.target' && w && w.myAvatar.target) throw new Error('An invalid exception was thrown.'); return getPath(this.root, args[0]) ?? null; }
      case 'getGameObjectS': return JSON.stringify(getPath(this.root, args[0]) ?? null);
      case 'setGameObject': setPath(this.root, args[0], args[1]); return null;
      case 'isNull': return getPath(this.root, args[0]) == null;
      case 'skipCutscenes': this.root.mcExtSWF.numChildren = 0; return null;
      case 'connectToServer': setTimeout(() => this.enterWorld(this.opts.level || 5), 20); return true;
      case 'jumpCorrectRoom': w.strFrame = args[0]; return null;
      case 'getMonsters': return w.monsters;
      case 'GetAurasValue': return 444;
      case 'canUseSkill': return !!w.myAvatar.target;
      case 'useSkill': this.hits++; this.hitTarget(); return true;
      case 'attackMonsterName': {
        const m = w.monsters.find((x) => x.strFrame === w.strFrame && (args[0] === '*' || x.strMonName.toLowerCase().includes(String(args[0]).toLowerCase())));
        if (!m) return false;
        w.myAvatar.target = { name: m.strMonName };
        return true;
      }
      case 'buyItemByName': {
        const it = (w.shopinfo.items || []).find((i) => i.sName === args[0]);
        if (it) { w.myAvatar.objData.intGold -= it.iCost || 0; this.addItem({ sName: it.sName, ItemID: it.ItemID }, args[1] || 1); }
        return null;
      }
      case 'callGameFunction': return this.gameFn(args[0], args.slice(1));
      default: throw new Error(`fake: no bridge fn ${fn}`);
    }
  }

  hitTarget() {
    const w = this.root.world;
    if (!w.myAvatar.target) return;
    const name = w.myAvatar.target.name;
    w.myAvatar.target = null;
    this.pext({ cmd: 'addGoldExp', typ: 'm', intGold: 10, intExp: 50 });
    w.myAvatar.objData.intExp += 50;
    const drop = this.monsterDrops[name];
    if (drop) {
      if (drop.bTemp) this.addItem(drop, 1);
      else this.pext({ cmd: 'dropItem', items: { [drop.ItemID]: { sName: drop.sName, iQty: 1, bCoins: drop.bCoins || 0 } } });
    }
  }

  gameFn(path, a) {
    const w = this.root.world;
    this.sent.push([path, ...a]);
    switch (path) {
      case 'login':
        this.root.objLogin = a[1] === this.opts.password
          ? { bSuccess: 1, sMsg: 'ok', servers: [{ sName: 'Twig', bOnline: 1, bUpg: 0, iMax: 1000, iCount: 10, iChat: 0 }, { sName: 'Full', bOnline: 1, bUpg: 0, iMax: 1000, iCount: 990, iChat: 0 }] }
          : { bSuccess: 0, sMsg: 'bad password', servers: [] };
        return null;
      case 'gotoAndPlay': case 'sfc.disconnect': return null;
      case 'world.isQuestInProgress': return this.inProgress.has(Number(a[0]));
      case 'world.acceptQuest': this.inProgress.add(Number(a[0])); return null;
      case 'world.getQuestValue': return this.questValues[a[0]] || 0;
      case 'world.getAchievement': return this.dailies[`${a[0]}:${a[1]}`] || 0;
      case 'world.cancelTarget': w.myAvatar.target = null; return null;
      case 'world.approachTarget': this.approaches = (this.approaches || 0) + 1; return null;
      case 'world.rest': if (w.myAvatar.dataLeaf.intHP > 0) w.myAvatar.dataLeaf.intHP = w.myAvatar.dataLeaf.intHPMax; return null;
      case 'world.sendLoadShopRequest': w.shopinfo = { ShopID: a[0], items: this.shops[a[0]] || [] }; return null;
      case 'world.getMapItem': this.mapItems = (this.mapItems || 0) + 1; return null;
      case 'sfc.sendString': return this.packet(a[0]);
      default: return null;
    }
  }

  packet(p) {
    const w = this.root.world;
    const parts = p.split('%');
    const cmd = parts[3] === 'cmd' ? parts[5] : parts[3];
    switch (cmd) {
      case 'tfer': {
        const map = parts[7].split('-')[0];
        if (this.opts.ignoreTfer) { this.tfers = (this.tfers || 0) + 1; return null; }   // in combat: the server says nothing
        if (this.opts.unavailableMaps.includes(map)) { setTimeout(() => this.pstr(['warning', '-1', `"${map}" is not available.`]), 10); return null; }
        setTimeout(() => { w.strMapName = map; w.strAreaName = parts[7]; w.strFrame = parts[8] || 'Enter'; }, 10);
        return null;
      }
      case 'getQuests':
        for (const id of parts.slice(5).filter(Boolean)) w.questTree[id] = { sName: `Quest ${id}`, turnin: (this.questDb[id] || {}).turnin || [] };
        return null;
      case 'tryQuestComplete': {
        const id = Number(parts[5]);
        const q = this.questDb[id] || { turnin: [] };
        for (const r of q.turnin) {
          for (const list of [w.myAvatar.items, w.myAvatar.tempitems]) {
            const it = list.find((i) => i.ItemID === r.ItemID);
            if (it) it.iQty -= r.iQty;
          }
        }
        w.myAvatar.tempitems = w.myAvatar.tempitems.filter((i) => i.iQty > 0);
        this.inProgress.delete(id);
        this.completed = (this.completed || 0) + 1;
        this.pext({ cmd: 'ccqr', bSuccess: 1, QuestID: id });
        return null;
      }
      case 'getDrop': {
        const id = Number(parts[5]);
        const drop = Object.values(this.monsterDrops).find((d) => d.ItemID === id);
        // The live server refuses when the stack is at the item's cap: "Already have a full stack of that item."
        const held = drop && this.item(drop.sName);
        if (drop && drop.iStk && held && Number(held.iQty || 0) >= Number(drop.iStk)) {
          this.pext({ cmd: 'getDrop', bSuccess: 0, ItemID: id });
          return null;
        }
        if (drop) this.addItem(drop, 1);
        this.pext({ cmd: 'getDrop', bSuccess: 1, ItemID: id, iQty: 1 });
        return null;
      }
      case 'equipItem': {
        const id = Number(parts[5]);
        const it = w.myAvatar.items.find((i) => i.ItemID === id);
        if (it) { for (const o of w.myAvatar.items) if (o.sES === it.sES) o.bEquip = false; it.bEquip = true; }
        return null;
      }
      case 'loadBank': w.bankinfo = { items: this.bank || [] }; return null;
      case 'bankFromInv': {
        const it = w.myAvatar.items.find((i) => i.ItemID === Number(parts[5]));
        if (it) { w.myAvatar.items = w.myAvatar.items.filter((i) => i !== it); (this.bank = this.bank || []).push(it); }
        return null;
      }
      case 'goto': {
        const who = String(parts[6]).toLowerCase();
        const p2 = (this.players || {})[who];
        if (p2) setTimeout(() => { w.strMapName = p2.map; w.uoTree = { [who]: { strFrame: p2.cell, strPad: 'Left' } }; }, 10);
        return null;
      }
      case 'sellItem': w.myAvatar.items = w.myAvatar.items.filter((i) => i.ItemID !== Number(parts[5])); (this.soldLog = this.soldLog || []).push(Number(parts[5])); return null;
      case 'bankToInv': {
        const it = (this.bank || []).find((i) => Number(i.CharItemID) === Number(parts[6]) || (parts[6] === undefined && i.ItemID === Number(parts[5])));
        if (it) { this.bank = this.bank.filter((i) => i !== it); w.myAvatar.items.push(it); }
        return null;
      }
      case 'wearItem': {
        const it = w.myAvatar.items.find((i) => i.ItemID === Number(parts[5]));
        if (it) { for (const o of w.myAvatar.items) if (o.sES === it.sES) o.bWear = 0; it.bWear = 1; }
        return null;
      }
      case 'addLoadout': {
        (this.loadouts = this.loadouts || {})[parts[5]] = JSON.parse(parts[6]);
        if (parts[7] && parts[7] !== parts[5]) delete this.loadouts[parts[7]];
        this.pext({ cmd: 'addLoadout', success: true });
        return null;
      }
      case 'equipLoadout': {
        const lo = (this.loadouts || {})[parts[6]];
        if (!lo) return null;
        for (const [es, id] of Object.entries(lo)) {
          const it = w.myAvatar.items.find((i) => i.ItemID === Number(id) && i.sES === es);
          if (!it) continue;
          for (const o of w.myAvatar.items) if (o.sES === es) o.bEquip = false;
          it.bEquip = true;
          if (es === 'ar') w.myAvatar.objData.strClassName = it.sName;
        }
        return null;
      }
      case 'enhanceItemShop': {
        const it = w.myAvatar.items.find((i) => i.ItemID === Number(parts[5]));
        const enh = (this.shops[parts[7]] || []).find((e) => e.ItemID === Number(parts[6]));
        if (it && enh) { it.EnhID = enh.ItemID; it.EnhLvl = enh.iLvl; w.myAvatar.objData.intGold -= enh.iCost; it.EnhPatternID = enh.EnhPatternID || require('../lib/knowledge').enh().typeId[String(enh.sName).split(' ')[0]] || 0; }   // the server sends EnhPID
        return null;
      }
      default: return null;
    }
  }
}

module.exports = { FakeGame };
