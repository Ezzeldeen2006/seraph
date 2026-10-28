// A tiny AQW game server for tests: the real wire protocol (SmartFox XML handshake, %xt% strings, JSON
// replies) over a real TCP socket, with one small world. It lets the Skua engine run real scripts end to end
// on the headless client without touching a live account.
//
//   maps      testmap (cells Enter, r2 with 2 Pixies, r3 with a Boss), shopmap (cell Enter)
//   quest     1000 "Pixie Problem": 3x Pixie Dust (temp drop), reward 100 gold + Pixie Crown
//   quest     1001 "Map item": 1x Lost Ring from getMapItem 50
//   shop      100 "Test Shop": Health Potion (5 g), Member Blade (member only)
//   drops     Pixie Wing (normal drop, must be picked up with getDrop)
'use strict';
const net = require('net');

const ITEMS = {
  1: { ItemID: 1, sName: 'Default Sword', sType: 'Sword', sES: 'Weapon', iStk: 1, bCoins: 0, sLink: 'sword', sFile: 'items/swords/sword.swf', iCost: 0 },
  2: { ItemID: 2, sName: 'Healer', sType: 'Class', sES: 'ar', iStk: 1, bCoins: 0, sLink: 'healer', sFile: 'classes/healer.swf', iCost: 0 },
  10: { ItemID: 10, sName: 'Pixie Dust', sType: 'Quest Item', sES: 'None', iStk: 10, bTemp: 1, bCoins: 0 },
  11: { ItemID: 11, sName: 'Pixie Wing', sType: 'Item', sES: 'None', iStk: 99, bTemp: 0, bCoins: 0 },
  12: { ItemID: 12, sName: 'Pixie Crown', sType: 'Helm', sES: 'he', iStk: 1, bTemp: 0, bCoins: 0 },
  13: { ItemID: 13, sName: 'Lost Ring', sType: 'Quest Item', sES: 'None', iStk: 1, bTemp: 1, bCoins: 0 },
  20: { ItemID: 20, sName: 'Health Potion', sType: 'Item', sES: 'None', iStk: 50, bCoins: 0, iCost: 5 },
  21: { ItemID: 21, sName: 'Member Blade', sType: 'Sword', sES: 'Weapon', iStk: 1, bCoins: 0, iCost: 10, bUpg: 1 },
  30: { ItemID: 30, sName: 'Old Boots', sType: 'Misc', sES: 'None', iStk: 1, bCoins: 0, iCost: 0 },
};

const QUESTS = {
  1000: { QuestID: 1000, sName: 'Pixie Problem', sDesc: 'Pixies!', sEndText: 'Thanks', iLvl: 1, bUpg: 0, bOnce: 0, iSlot: -1, iValue: 0, FactionID: 1, iReqRep: 0, iClass: 0, iReqCP: 0, iGold: 100, iExp: 50, sField: '', iIndex: -1,
    oReqd: {}, oItems: { 10: { ...ITEMS[10] } }, turnin: [{ ItemID: 10, iQty: 3 }],
    oRewards: { itemsS: { 12: { ...ITEMS[12], iQty: 1 } } }, reward: [{ ItemID: 12, iQty: 1, iRate: 100, iType: 0 }] },
  1001: { QuestID: 1001, sName: 'Map item', sDesc: 'Find the ring', sEndText: 'Nice', iLvl: 1, bUpg: 0, bOnce: 0, iSlot: -1, iValue: 0, FactionID: 1, iReqRep: 0, iClass: 0, iReqCP: 0, iGold: 10, iExp: 10, sField: '', iIndex: -1,
    oReqd: {}, oItems: { 13: { ...ITEMS[13] } }, turnin: [{ ItemID: 13, iQty: 1 }], oRewards: {}, reward: [] },
};

const MAPS = {
  testmap: {
    file: 'test/testmap.swf',
    mondef: [{ MonID: 5, strMonName: 'Pixie', intLevel: 3, sRace: 'Magical', strMonFileName: 'pixie.swf' }, { MonID: 6, strMonName: 'Pixie Queen', intLevel: 10, sRace: 'Magical', strMonFileName: 'queen.swf' }],
    monmap: [{ MonMapID: 1, MonID: 5, strFrame: 'r2', bRed: 0 }, { MonMapID: 2, MonID: 5, strFrame: 'r2', bRed: 0 }, { MonMapID: 3, MonID: 6, strFrame: 'r3', bRed: 0 }],
    hp: { 5: 100, 6: 400 },
  },
  shopmap: { file: 'test/shopmap.swf', mondef: [], monmap: [], hp: {} },
};

class Session {
  constructor(sock, server) {
    this.sock = sock;
    this.server = server;
    this.buf = '';
    this.uid = 40000 + Math.floor(Math.random() * 1000);
    this.name = null;
    this.room = 900;
    this.map = null;
    this.cell = 'Enter';
    this.pad = 'Spawn';
    this.hp = 1000; this.hpMax = 1000; this.mp = 100; this.mpMax = 100;
    this.gold = 500;
    this.charItem = 5000;
    this.inv = [
      { ...ITEMS[1], CharItemID: this.charItem++, iQty: 1, bEquip: 1 },
      { ...ITEMS[2], CharItemID: this.charItem++, iQty: 3000, bEquip: 1 },
      { ...ITEMS[30], CharItemID: this.charItem++, iQty: 1, bEquip: 0 },
    ];
    this.temp = [];
    this.bank = [{ ...ITEMS[11], CharItemID: this.charItem++, iQty: 2, bEquip: 0 }];
    this.accepted = new Set();
    this.drops = new Set();
    this.mons = {};
    this.log = [];
    sock.on('data', (d) => {
      this.buf += d.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\0')) >= 0) { const m = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); if (m) this.onMessage(m); }
    });
    sock.on('error', () => {});
  }

  raw(s) { if (!this.sock.destroyed) this.sock.write(s + '\0'); }
  // Like the AQW 5.0 server: bigger replies go out as "Z" + base64(zlib(text)) (loadPrefs at 521 chars already does).
  json(o) {
    const s = JSON.stringify({ t: 'xt', b: { r: -1, o } });
    this.raw(this.server.compress !== false && s.length > 400 ? `Z${require('zlib').deflateSync(Buffer.from(s, 'utf8')).toString('base64')}` : s);
  }
  str(cmd, ...args) { this.raw(`%xt%${cmd}%-1%${args.join('%')}%`); }

  onMessage(m) {
    if (m.startsWith('<')) {
      if (m.includes("action='verChk'")) this.raw("<msg t='sys'><body action='apiOK' r='0'></body></msg>");
      else if (m.includes("action='login'")) {
        const nick = /CDATA\[([^\]]+)\]/.exec(m)[1].split('~');
        this.name = nick[1];
        this.str('loginResponse', 'true', this.uid, this.name.toLowerCase(), 'Welcome to the test server', '');
      }
      return;
    }
    if (!m.startsWith('%xt%')) return;
    const p = m.split('%');       // ['', 'xt', 'zm', cmd, room, ...args, '']
    const cmd = p[3];
    const a = p.slice(5, -1);
    this.log.push(`${cmd} ${a.join(' ')}`);
    this.server.emit && this.server.emit('packet', { session: this, cmd, a });
    switch (cmd) {
      case 'firstJoin': return this.join('testmap', 'Enter', 'Spawn');
      case 'cmd':
        if (a[0] === 'tfer') return this.join(String(a[2]).split('-')[0], a[3] || 'Enter', a[4] || 'Spawn');
        if (a[0] === 'logout') return this.sock.end();
        return;
      case 'moveToCell':
        this.cell = a[0]; this.pad = a[1];
        return this.str('uotls', this.name.toLowerCase(), `strFrame:${a[0]},strPad:${a[1]},tx:0,ty:0`);
      case 'retrieveUserDatas': case 'retrieveUserData':
        return this.json({ cmd: 'initUserData', uid: this.uid, data: this.userData() });
      case 'retrieveInventory':
        this.json({ cmd: 'loadInventoryBig', items: this.inv, hitems: [], factions: [{ FactionID: 2, sName: 'Good', iRep: 1000 }], bankCount: this.bank.length, iMiscSlots: 100 });
        this.json({ cmd: 'sAct', actions: { active: [
          { ref: 'aa', nam: 'Auto attack', typ: 'aa', tgt: 'h', cd: 2000, mp: 0, range: 301, isOK: true, auto: true, tgtMin: 1, tgtMax: 1 },
          { ref: 'a1', nam: 'Heal', typ: 'm', tgt: 'f', cd: 3000, mp: 10, range: 301, isOK: true, tgtMin: 1, tgtMax: 1 },
          { ref: 'a2', nam: 'Smite', typ: 'm', tgt: 'h', cd: 4000, mp: 15, range: 301, isOK: true, tgtMin: 1, tgtMax: 2 },
          { ref: 'a3', nam: 'Ward', typ: 'm', tgt: 's', cd: 6000, mp: 20, range: 301, isOK: true, tgtMin: 1, tgtMax: 1 },
          { ref: 'a4', nam: 'Judgement', typ: 'm', tgt: 'h', cd: 8000, mp: 25, range: 301, isOK: true, tgtMin: 1, tgtMax: 1 },
        ], passive: [] } });
        return this.json({ cmd: 'stu', sta: { $tha: 0.1, $cmc: 1, $ap: 50, $sp: 50, $tcr: 0.1, $STR: 20, $INT: 20, $DEX: 20, $END: 20, $WIS: 20, $LCK: 20 } });
      case 'getQuests': {
        const quests = {};
        for (const id of a) if (QUESTS[id]) quests[id] = QUESTS[id];
        return this.json({ cmd: 'getQuests', quests });
      }
      case 'acceptQuest':
        if (!QUESTS[a[0]]) return;
        this.accepted.add(Number(a[0]));
        return this.json({ cmd: 'acceptQuest', QuestID: Number(a[0]), bSuccess: 1 });
      case 'aggroMon': return;
      case 'gar': return this.attack(Number(a[0]), a[1]);
      case 'restRequest':
        this.hp = this.hpMax; this.mp = this.mpMax;
        return this.str('uotls', this.name.toLowerCase(), `intHP:${this.hp},intMP:${this.mp}`);
      case 'getDrop': {
        const id = Number(a[0]);
        if (!this.drops.has(id)) return this.json({ cmd: 'getDrop', bSuccess: 0, ItemID: id });
        this.drops.delete(id);
        const inv = this.inv.find((x) => x.ItemID === id);
        let cid;
        if (inv) { inv.iQty += 1; cid = inv.CharItemID; } else { cid = this.charItem++; this.inv.push({ ...ITEMS[id], CharItemID: cid, iQty: 1, bEquip: 0 }); }
        return this.json({ cmd: 'getDrop', bSuccess: 1, ItemID: id, CharItemID: cid, iQty: 1, iQtyNow: inv ? inv.iQty : 1, bBank: false });
      }
      case 'getMapItem': {
        if (Number(a[0]) !== 50) return;
        return this.giveTemp(13, 1);
      }
      case 'tryQuestComplete': return this.complete(Number(a[0]));
      case 'loadShop':
        if (Number(a[0]) !== 100) return;
        return this.json({ cmd: 'loadShop', shopinfo: { ShopID: 100, sName: 'Test Shop', bUpgrd: 0, bHouse: 0, bStaff: 0, sField: '', iIndex: -1, items: [
          { ...ITEMS[20], ShopItemID: 7001, iQty: 1, iQSindex: -1, iQSvalue: 0, FactionID: 1, iReqRep: 0 },
          { ...ITEMS[21], ShopItemID: 7002, iQty: 1, iQSindex: -1, iQSvalue: 0, FactionID: 1, iReqRep: 0 },
        ] } });
      case 'buyItem': {
        const id = Number(a[0]);
        const it = ITEMS[id];
        const qty = Number(a[3] || 1);
        if (!it || (it.bUpg && true) || this.gold < it.iCost * qty) return this.json({ cmd: 'buyItem', bitSuccess: 0, strMessage: 'Cannot buy' });
        this.gold -= it.iCost * qty;
        let inv = this.inv.find((x) => x.ItemID === id);
        if (inv) inv.iQty += qty; else { inv = { ...it, CharItemID: this.charItem++, iQty: qty, bEquip: 0 }; this.inv.push(inv); }
        return this.json({ cmd: 'buyItem', bitSuccess: 1, CharItemID: inv.CharItemID, iQty: qty, ItemID: id, bBank: false });
      }
      case 'sellItem': {
        const cid = Number(a[2]);
        const i = this.inv.findIndex((x) => x.CharItemID === cid);
        if (i < 0) return;
        const it = this.inv[i];
        const qty = Number(a[1] || 1);
        it.iQty -= qty;
        if (it.iQty < 1) this.inv.splice(i, 1);
        this.gold += 1;
        return this.json({ cmd: 'sellItem', CharItemID: cid, iQty: qty, iQtyNow: Math.max(0, it.iQty), intAmount: 1, bCoins: 0 });
      }
      case 'loadBank': return this.json({ cmd: 'loadBank', bitSuccess: 1, items: this.bank });
      case 'bankToInv': {
        const id = Number(a[0]);
        const i = this.bank.findIndex((x) => x.ItemID === id);
        if (i < 0) return;
        this.inv.push(this.bank.splice(i, 1)[0]);
        return this.json({ cmd: 'bankToInv', ItemID: id, CharItemID: Number(a[1]), bSuccess: 1 });
      }
      case 'bankFromInv': {
        const id = Number(a[0]);
        const i = this.inv.findIndex((x) => x.ItemID === id);
        if (i < 0) return;
        this.bank.push(this.inv.splice(i, 1)[0]);
        return this.json({ cmd: 'bankFromInv', ItemID: id, CharItemID: Number(a[1]), bSuccess: 1 });
      }
      case 'equipItem': {
        const id = Number(a[0]);
        const it = this.inv.find((x) => x.ItemID === id);
        if (!it) return;
        for (const x of this.inv) if (x.sES === it.sES) x.bEquip = 0;
        it.bEquip = 1;
        return this.json({ cmd: 'equipItem', uid: this.uid, ItemID: id, strES: it.sES, sFile: it.sFile || '', sLink: it.sLink || '', sType: it.sType });
      }
      default:
    }
  }

  userData() {
    return {
      strUsername: this.name, intLevel: 30, intExp: 0, intExpToLevel: 10000, intGold: this.gold, intCoins: 0, iUpgDays: -1, iBagSlots: 40, iBankSlots: 20, iHouseSlots: 20,
      strClassName: 'Healer', iCP: 3000, CharID: 777, intAccessLevel: 1, strGender: 'F', strQuests: '0'.repeat(100), strQuests2: '0'.repeat(100), eqp: {}, intHP: this.hp, intHPMax: this.hpMax, intMP: this.mp, intMPMax: this.mpMax, intState: 1,
    };
  }

  join(mapName, cell, pad) {
    const m = MAPS[mapName];
    if (!m) return this.str('warning', `"${mapName}" is not available.`);
    this.map = mapName;
    this.room = this.room + 1;
    this.mons = {};
    for (const mm of m.monmap) this.mons[mm.MonMapID] = { hp: m.hp[mm.MonID], max: m.hp[mm.MonID], state: 1, cell: mm.strFrame, monId: mm.MonID };
    this.json({
      cmd: 'moveToArea', areaId: this.room, areaName: `${mapName}-${this.room}`, strMapName: mapName, strMapFileName: m.file, intType: 1, intKillCount: 0,
      uoBranch: [{ uoName: this.name.toLowerCase(), strUsername: this.name, entID: this.uid, entType: 'p', intHP: this.hp, intHPMax: this.hpMax, intMP: this.mp, intMPMax: this.mpMax, intState: 1, intLevel: 30, strFrame: cell, strPad: pad, tx: 0, ty: 0, afk: false }],
      monBranch: m.monmap.map((mm) => ({ MonMapID: mm.MonMapID, MonID: mm.MonID, intHP: m.hp[mm.MonID], intHPMax: m.hp[mm.MonID], intMP: 10, intMPMax: 10, intState: 1, iLvl: 3, wDPS: 5 })),
      mondef: m.mondef, monmap: m.monmap,
    });
  }

  attack(actId, targets) {
    const hits = String(targets).split(',').map((t) => { const [ref, tgt] = t.split('>'); return { ref, tgt }; });
    const m = {};
    const sara = [];
    for (const h of hits) {
      if (!h.tgt || !h.tgt.startsWith('m:')) { sara.push({ actionResult: { cInf: `p:${this.uid}`, tInf: h.tgt || `p:${this.uid}`, typ: 'hit', hp: -20 }, actID: actId, iRes: 1 }); continue; }
      const id = Number(h.tgt.slice(2));
      const mon = this.mons[id];
      if (!mon || mon.state === 0 || mon.cell !== this.cell) continue;
      mon.hp = Math.max(0, mon.hp - 50);
      if (mon.hp === 0) mon.state = 0; else mon.state = 2;
      m[id] = { intHP: mon.hp, intState: mon.state };
      sara.push({ actionResult: { cInf: `p:${this.uid}`, tInf: `m:${id}`, typ: 'hit', hp: 50 }, actID: actId, iRes: 1 });
    }
    this.json({ cmd: 'ct', m, p: { [this.name.toLowerCase()]: { intState: Object.keys(m).length ? 2 : 1 } }, sara });
    for (const [id, v] of Object.entries(m)) if (v.intState === 0) this.onKill(Number(id));
  }

  onKill(id) {
    this.gold += 5;
    this.json({ cmd: 'addGoldExp', typ: 'm', id, intExp: 10, intGold: 5 });
    this.str('uotls', this.name.toLowerCase(), 'intState:1');
    if (this.accepted.has(1000)) this.giveTemp(10, 1);
    this.drops.add(11);
    this.json({ cmd: 'dropItem', items: { 11: { ...ITEMS[11], iQty: 1 } } });
    setTimeout(() => {
      const mon = this.mons[id];
      if (!mon) return;
      mon.hp = mon.max; mon.state = 1;
      this.str('respawnMon', id);
      this.str('mtls', id, `intHP:${mon.max},intState:1`);
    }, 1500);
  }

  giveTemp(id, qty) {
    let t = this.temp.find((x) => x.ItemID === id);
    const max = ITEMS[id].iStk;
    if (!t) { t = { ...ITEMS[id], iQty: 0 }; this.temp.push(t); }
    t.iQty = Math.min(max, t.iQty + qty);
    this.json({ cmd: 'addItems', items: { [id]: { ...ITEMS[id], iQty: qty, iQtyNow: t.iQty, bTemp: 1 } } });
  }

  complete(qid) {
    const q = QUESTS[qid];
    if (!q || !this.accepted.has(qid)) return this.json({ cmd: 'ccqr', QuestID: qid, bSuccess: 0, msg: 'not accepted' });
    for (const t of q.turnin) {
      const have = this.temp.find((x) => x.ItemID === t.ItemID) || this.inv.find((x) => x.ItemID === t.ItemID);
      if (!have || have.iQty < t.iQty) return this.json({ cmd: 'ccqr', QuestID: qid, bSuccess: 0, msg: 'missing items' });
    }
    const sItems = q.turnin.map((t) => `${t.ItemID}:${t.iQty}`).join(',');
    for (const t of q.turnin) {
      const tmp = this.temp.find((x) => x.ItemID === t.ItemID);
      if (tmp) { tmp.iQty -= t.iQty; if (tmp.iQty < 1) this.temp.splice(this.temp.indexOf(tmp), 1); }
    }
    this.accepted.delete(qid);
    this.json({ cmd: 'turnIn', sItems });
    this.gold += q.iGold;
    this.json({ cmd: 'ccqr', QuestID: qid, bSuccess: 1, sName: q.sName, rewardObj: { intGold: q.iGold, intExp: q.iExp } });
    this.json({ cmd: 'addGoldExp', typ: 'q', intGold: q.iGold, intExp: q.iExp });
    for (const r of q.reward || []) {
      if (this.inv.find((x) => x.ItemID === r.ItemID)) continue;
      const cid = this.charItem++;
      this.inv.push({ ...ITEMS[r.ItemID], CharItemID: cid, iQty: r.iQty, bEquip: 0 });
      this.json({ cmd: 'addItems', items: { [r.ItemID]: { ...ITEMS[r.ItemID], CharItemID: cid, iQty: r.iQty, iQtyNow: r.iQty, bTemp: 0 } } });
    }
  }
}

function start() {
  return new Promise((resolve) => {
    const sessions = [];
    const srv = net.createServer((sock) => sessions.push(new Session(sock, srv)));
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({
        port,
        sessions,
        server: { sName: 'Sandbox', sIP: '127.0.0.1', iPort: port, bOnline: 1, iCount: 1, iMax: 1000, bUpg: 0, iChat: 0 },
        close: () => { for (const s of sessions) s.sock.destroy(); srv.close(); },
      });
    });
  });
}

module.exports = { start, ITEMS, QUESTS };
