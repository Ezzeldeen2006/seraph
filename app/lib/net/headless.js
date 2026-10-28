// A whole AQW client with no Flash, no browser and no rendering: just the socket and a model of the world.
// It exposes exactly the surface the bots already use (get / call / fn / send), so bot.js, brain.js and the
// Skua script translator run on top of it unchanged. Roughly 30 MB per character instead of ~500 MB.
//
// The packet shapes below are the real ones, taken from the live game file and from recorded sessions.
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { P } = require('../paths');
const protocol = require('./protocol');
const { SwfWorld } = require('../skua/swfworld');
const manners = require('../manners');
// Only the fields a packet actually carries: an undefined intHPMax used to wipe the real one (status showed max HP 1).
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

const SKILL_REFS = ['aa', 'a1', 'a2', 'a3', 'a4'];   // 0 = auto attack, 1..4 = the class skills
// Map code that runs when a monster kills you (onPlayerDeath), keyed by map.
// Map items each map's own code hands out (<work>\mapscan\scan.js decompiles every map the bots use and
// writes lib/map-hooks.json): { "<map file>": [{ mapItem, on: join|cell|event|timer|click|other, cell, event, quest,
// questValue: {slot, op, value}, monPad, where }] }. Read once; missing file = no hooks.
let MAP_HOOKS = null;
let MAP_HOOKS_AT = 0;
function mapHooksFor(file) {
  if (!MAP_HOOKS || Date.now() - MAP_HOOKS_AT > 600000) {   // re-read every 10 min: a new scan needs no restart
    MAP_HOOKS_AT = Date.now();
    try { MAP_HOOKS = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'map-hooks.json'), 'utf8')).hooks || {}; } catch (e) { MAP_HOOKS = {}; }
  }
  const key = String(file || '').split('?')[0].replace(/^\/+/, '');
  return MAP_HOOKS[key] || MAP_HOOKS[`/${key}`] || [];
}
const CMP = { '==': (a, b) => a === b, '!=': (a, b) => a !== b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b };
// The event name a map's eventTrigger sees for a server message (Game.as mapEventTrigger callers).
const MAP_EVENT_NAMES = { dungeonCompleted: 'DungeonComplete', playerDeath: 'playerDeath', clockTick: 'clockTick' };
const { mtcidPad } = require('../skua/swfworld');
const MAP_DEATH_HOOKS ={ firewar: [{ monPad: 23, quest: 6299, mapItem: 5799, what: 'Akriloth' }] };
const CROWD_FULL_MAX = 60 * 60000;   // how long a character keeps knocking on a full Artix before any busy server will do
// Requests the server always answers (a map change, quests, shops, bank, our own data, a turn-in, a trade).
const EXPECT_REPLY = /^%xt%zm%(cmd%\d+%tfer|getQuests|acceptQuest|loadShop|loadBank|retrieveUserData|tryQuestComplete|loadHairShop|buyItem|sellItem|bankFromInv|bankToInv)%/;
// Actions the game client clears its AFK flag for (World.afkPostpone callers).
const AFK_ACTIONS = /^%xt%zm%(gar|moveToCell|cmd%\d+%tfer|restRequest|resPlayerTimed|aggroMon|mv)%/;
const LIVE = { awaitMs: 25000, probeMs: 10000 };   // liveness: silence after a request, then the probe's own wait
// "Please slow down. Last action was too soon!": 44 to 12,610 a day per bot, each one a refused action (audit C3,
// 2026-09-28). After one, packets leave 500 ms apart instead of 220 for 30 s.
const SEND_GAP = { normal: 220, slow: 500, holdMs: 30000 };
const AGGRO_REPEAT_MS = 2000;
const QUEUE_FILLER = /^%xt%zm%(aggroMon|mv)%/;

class HeadlessClient extends EventEmitter {
  constructor(account, opts = {}) {
    super();
    this.account = account;
    this.id = account.id;
    this.opts = opts;
    this.headless = true;          // bot.js and hub.js branch on this
    this.serverName = null;
    this.state = { page: true, bridge: true, loaded: false, started: Date.now(), crashes: 0 };
    this.dir = P.account(account.id);
    fs.mkdirSync(path.join(this.dir, 'logs'), { recursive: true });
    this.logFile = null;
    this.events = [];
    this.seq = 0;
    this.sock = null;
    this.buf = '';
    this.actionId = 0;
    this.timers = [];
    this.reset();
    // A model of the game as skua.swf sees it, so Skua's real engine can run on this client (lib/skua/engine.js).
    this.swf = new SwfWorld(this);
    this.setMaxListeners(50);
  }

  // The world as the game would hold it. Paths here match what the bot asks for (world.myAvatar.dataLeaf.intHP, …).
  reset() {
    this.w = {
      visible: true, strMapName: '', strAreaName: '', strFrame: 'Enter', strPad: 'Spawn', curRoom: 1, areaId: 1,
      myAvatar: {
        target: null, uid: 0,
        objData: { strUsername: this.account.username || this.account.id, intLevel: 1, intGold: 0, intExp: 0, intExpToLevel: 0, strClassName: '', iBagSlots: 0, iUpgDays: 0, CharID: 0 },
        dataLeaf: { intHP: 1, intHPMax: 1, intMP: 0, intMPMax: 0, intState: 1 },
        items: [], tempitems: [],
      },
      monsters: [], mondef: {}, users: {},
      questTree: {}, shopinfo: null, hairshopinfo: null, bankinfo: { items: [] },
      actions: { active: [] },
    };
    this.sawHp = false;            // the server has sent our hit points at least once (see checkDeath)
    this.myHits = new Map();       // MonMapID -> when this character last hit it (a boss it killed, hub.bossKilled)
    this.othersHits = new Map();   // MonMapID -> when another real player last hit it (lib/manners.js: is it being fought?)
    this.accepted = new Set();     // quests in progress
    this.auras = {};               // 'p:<uid>' / 'm:<monMapId>' -> Map(name -> aura), for the combat engine
    this.cooldowns = {};           // skill ref -> ready-at timestamp
    this.inventoryLoaded = false;
    // The inventory is a live view of the skua.swf model (lib/skua/swfworld.js), which follows the game's own code for
    // every change: drops, purchases, sales, turn-ins, temp items, equipping, class points. A second hand-kept copy
    // here caused every inventory bug of 2026-09-19 (double counts, bought classes missing, two "equipped" classes,
    // class points on the wrong class, temp counts that only grew).
    for (const key of ['items', 'tempitems']) {
      Object.defineProperty(this.w.myAvatar, key, {
        enumerable: true,
        configurable: true,
        get: () => { const a = this.swf && this.swf.w && this.swf.w.myAvatar; return (a && a[key]) || []; },
        set: () => { /* read-only view */ },
      });
    }
    if (this.swf) this.swf.reset();
  }

  // Same event shape as the Flash client (kind + data), so bot.js reads packets without knowing the difference.
  record(kind, data) {
    const ev = { n: ++this.seq, t: Date.now(), kind, data };
    this.events.push(ev);
    if (this.events.length > 3000) this.events.splice(0, this.events.length - 3000);
    let text = typeof data === 'string' ? data : JSON.stringify(data);
    // Combat ticks, movement and aura updates arrive several times a second per character: the bots see them
    // (the event above), but writing them to disk would grind an old laptop's drive for nothing. Combat batches (`cb`,
    // 30-230k a day per character) are kept only when they change our own state.
    if (kind === 'pext' && /^(\{"cmd":"(ct|uotls|aura[^"]*|mtls|mv|clearAuras)"|\["(uotls|respawnMon|mv|ct)")/.test(text)) { this.emit('event', ev); return; }
    if (kind === 'pext' && text.startsWith('{"cmd":"cb"') && !text.includes(`"${String(this.w.myAvatar.objData.strUsername).toLowerCase()}":{"`)) { this.emit('event', ev); return; }
    if (kind === 'pext' || kind === 'packet') text = text.slice(0, 300);
    const day = new Date().toISOString().slice(0, 10);
    if (!this.logFile || this.logDay !== day) {
      if (this.logFile) this.logFile.end();
      this.logDay = day;
      this.logFile = fs.createWriteStream(path.join(this.dir, 'logs', `session-${day}.log`), { flags: 'a' });
    }
    this.logFile.write(`${new Date(ev.t).toISOString()} ${kind} ${text}\n`);
    this.emit('event', ev);
  }

  // ---------------- connection ----------------
  async start() {
    const creds = this.credentials();
    const info = await protocol.login(creds.username, creds.password);
    this.login = info;
    this.swf.setLogin(info, creds.password);
    this.w.myAvatar.objData.strUsername = info.username;
    const server = this.pickServer(info.servers);
    if (!server) throw new Error('no game server is online');
    this.serverName = server.sName;
    this.swf.setServer(server);
    this.record('state', `logging in as ${info.username} on ${server.sName} (${server.iCount}/${server.iMax})`);
    await this.connect(server, info);
    return true;
  }

  credentials() {
    const { credentials } = require('../accounts');
    const c = credentials(this.account);
    return { username: c.user, password: c.pass };
  }

  // Least busy server that is online, unless the account asks for one by name.
  // Free accounts cannot enter upgrade-only servers (bUpg) or level-gated ones (iLevel), and
  // accessLevel > 0 is staff only. Picking one of those gets the login refused outright.
  pickServer(servers) {
    const want = this.opts.server || this.account.server || (this.opts.preferServer && this.opts.preferServer());
    const level = Number(this.login && this.login.level) || 1;
    const member = Number(this.login && this.login.upgradeDays) > 0;
    const usable = servers.filter((s) => s.bOnline && !Number(s.accessLevel)
      && (member || !Number(s.bUpg)) && level >= Number(s.iLevel || 0)
      && !/^(class test|ptr)$/i.test(s.sName));
    // What was asked for, even when it was full: bot.ensureServer compares the ask, not where the login landed, or a
    // full Artix would send the character through a relog on every task.
    this.wantedServer = want ? String(want).toLowerCase() : null;
    const room = usable.filter((s) => s.iCount < s.iMax - 20);
    if (want) {
      // The list names regions too: "Swordhaven (EU)", "Yokai (SEA)". Asked for "Swordhaven", the exact match failed
      // and every login went to the emptiest server instead (all four on Sepulchure, 2026-10-01).
      const w0 = String(want).toLowerCase();
      const s = usable.find((x) => x.sName.toLowerCase() === w0) || usable.find((x) => x.sName.toLowerCase().startsWith(`${w0} (`));
      if (s && s.iCount < s.iMax) { this._fullSince = null; return s; }
      // Artix sits at 1500/1500 in the evening. The owner, 2026-09-27: "keep the bots trying to join artix until they join
      // if they tried for 20 minutes straight they will get in for sure". So no other server: the login fails as
      // SERVER_FULL and hub.reconnect tries again every 30 s. After CROWD_FULL_MAX the old fallback (busiest server with
      // room) keeps a character from sitting offline all night.
      const { CROWD_SERVER, KNOCK_MIN } = require('../crowd');
      if (String(want).toLowerCase() === CROWD_SERVER.toLowerCase()) {
        if (!this._fullSince) this._fullSince = Date.now();
        if (Date.now() - this._fullSince < (KNOCK_MIN ? KNOCK_MIN * 60000 : CROWD_FULL_MAX)) {
          const e = new Error(`${CROWD_SERVER} is full (${s ? `${s.iCount}/${s.iMax}` : 'offline'}) - trying again, ${Math.round((Date.now() - this._fullSince) / 60000)} min so far`);
          e.code = 'SERVER_FULL';
          throw e;
        }
        this._fullSince = null;   // the next crowded task knocks for a full hour again
        if (room.length) return room.sort((a, b) => b.iCount - a.iCount)[0];
      }
    }
    this._fullSince = null;
    return room.sort((a, b) => a.iCount - b.iCount)[0] || usable[0];
  }

  connect(server, info) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(server.iPort, server.sIP);
      this.sock = sock;
      sock.setKeepAlive(true, 30000);
      sock.setNoDelay(true);
      let settled = false;
      const fail = (e) => { if (this._offRefused) this._offRefused(); if (!settled) { settled = true; reject(e); } };
      sock.on('connect', () => this.write(protocol.verChk()));
      // The game server can still refuse the login (the last seat went a moment earlier): that is SERVER_FULL right away,
      // so the knock carries on, instead of waiting two minutes for the load timeout and backing off.
      const refused = (m) => {
        const e = new Error(`login refused: ${String(m).split('%').slice(3).join(' ') || m}`);
        if (/full/i.test(String(m))) { e.code = 'SERVER_FULL'; this._fullSince = this._fullSince || Date.now(); }
        fail(e);
        try { sock.destroy(); } catch { /* already closed */ }
      };
      this.once('loginFailed', refused);
      this._offRefused = () => this.off('loginFailed', refused);
      // One decoder per socket: a multi-byte character split between two TCP chunks stays whole.
      const decoder = new (require('string_decoder').StringDecoder)('utf8');
      this.lastInbound = Date.now();
      this._awaitSince = 0; this._probeAt = 0;
      // One liveness timer per client, replaced on every connect (a socket the network killed never runs disconnect()).
      clearInterval(this._liveTimer);
      this._liveTimer = setInterval(() => this.checkLive(), 5000);
      if (this._liveTimer.unref) this._liveTimer.unref();
      sock.on('data', (d) => {
        this.lastInbound = Date.now();
        this._awaitSince = 0;
        this.buf += decoder.write(d);
        let i;
        while ((i = this.buf.indexOf('\0')) >= 0) {
          const msg = protocol.unpack(this.buf.slice(0, i));   // AQW 5.0 "Z" packets (protocol.unpack)
          this.buf = this.buf.slice(i + 1);
          if (msg) {
            // Debugging aid: SERAPH_PACKET_LOG=<file> records every packet the server sends (off by default).
            if (process.env.SERAPH_PACKET_LOG) try { fs.appendFileSync(process.env.SERAPH_PACKET_LOG, `${new Date().toISOString().slice(11, 23)} ${this.id} ${msg.slice(0, 2000)}\n`); } catch { /* */ }
            this.trace('in', msg);
            // The raw text rides along: skua.swf hands every received packet to Skua as "packetFromServer" too (engine.js).
            try { const p = protocol.parse(msg); this.handle(p, msg); this.emit('sfs', p, msg); } catch (e) { this.record('error', `packet: ${e.message}`); }
            if (!settled && this.state.loaded) { settled = true; if (this._offRefused) this._offRefused(); resolve(true); }
          }
        }
      });
      sock.on('error', (e) => { this.record('error', `socket: ${e.message}`); fail(e); });
      sock.on('close', () => { this.state.loaded = false; if (this.swf) this.swf.dirty = true; this.emit('disconnected'); this.record('state', 'disconnected'); fail(new Error('socket closed before login finished')); });
      this.timers.push(setTimeout(() => fail(new Error('the game did not finish loading this character')), 120000));
    });
  }

  // Is the connection alive? Linux takes 10-30 min to give up on a socket the Wi-Fi silently killed, and Valen sent
  // joins into a silent connection for 45 min on 2026-09-26. After a request the server always answers (EXPECT_REPLY),
  // 25 s without a single packet in means: ask for our own data (always answered); nothing within 10 s more = dead,
  // drop the socket and let hub.reconnect log in again.
  checkLive(now = Date.now()) {
    if (!this.sock || this.sock.destroyed || !this.state.loaded) return 'idle';
    if (this._probeAt) {
      if (this.lastInbound >= this._probeAt) { this._probeAt = 0; return 'alive'; }
      if (now - this._probeAt < LIVE.probeMs) return 'probing';
      this._probeAt = 0;
      this.record('state', `connection dead: nothing from the server for ${Math.round((now - this.lastInbound) / 1000)} s - reconnecting`);
      this.emit('dead', { silentSec: Math.round((now - this.lastInbound) / 1000) });
      try { this.sock.destroy(); } catch (e) { /* gone */ }
      return 'dead';
    }
    if (this._awaitSince && now - this._awaitSince > LIVE.awaitMs && now - this.lastInbound > LIVE.awaitMs) { this.probe(now); return 'probing'; }
    return 'ok';
  }
  probe(now = Date.now()) {
    this._probeAt = now;
    this.xt('retrieveUserData', [this.w.myAvatar.uid]);
  }
  // Promise for callers (bot.join): true when anything arrives within ms after a probe.
  alive(ms = LIVE.probeMs) {
    if (!this.sock || this.sock.destroyed) return Promise.resolve(false);
    const t0 = Date.now();
    this.probe(t0);
    return new Promise((resolve) => {
      const tick = setInterval(() => {
        if (this.lastInbound >= t0) { clearInterval(tick); this._probeAt = 0; resolve(true); } else if (Date.now() - t0 > ms) { clearInterval(tick); resolve(false); }
      }, 250);
    });
  }

  // World.afkPostpone: the game client clears the AFK flag before its actions (skills, moves, rest, respawn). The
  // headless client never did, so a character the server had marked AFK stayed that way until a Skua script started
  // and sent it (Valen, 2026-09-26: "You are no longer set to AFK" only at 08:02).
  afkPostpone(now = Date.now()) {
    const me = this.w.myAvatar.dataLeaf;
    if (!me || me.afk !== true || now - (this._afkTs || 0) < 500) return;
    this._afkTs = now;
    this.sock.write('%xt%zm%afk%1%false%\0');
  }

  // Game packets leave one at a time with a small gap, like a person clicking: bursts (a pile of drops, a quest
  // turn-in right after a kill) are what make the server answer "Please slow down".
  write(msg) {
    this.trace(this.sock && !this.sock.destroyed ? 'out' : 'out-dropped', msg);
    if (!this.sock || this.sock.destroyed) return;
    // Public-room manners, rule 4 (lib/manners.js): no jumping into the cell of a boss this character is waiting on.
    if (String(msg).startsWith('%xt%zm%moveToCell%')) {
      const cell = String(msg).split('%')[5];
      if (cell && manners.blocksCell(this, cell)) return;
    }
    if (AFK_ACTIONS.test(msg)) this.afkPostpone();
    if (!this._awaitSince && EXPECT_REPLY.test(msg)) this._awaitSince = Date.now();
    this.swf.onOutgoing(msg);
    this.emit('out', msg);
    // A cell change made by anyone (a Skua script included) is where bot.js must think the character is.
    if (String(msg).startsWith('%xt%zm%moveToCell%')) {
      const a = String(msg).split('%');
      if (a[5]) { this.w.strFrame = a[5]; this.w.strPad = a[6] || 'Spawn'; }
      if (a[5]) setTimeout(() => { try { this.mapHooks('cell', a[5]); } catch (e) { /* never break a move */ } }, 1500);
    }
    if (!String(msg).startsWith('%xt%')) { this.sock.write(msg + '\0'); return; }
    this.outbox = this.outbox || [];
    // Skua's aggro options (CoreBots turns BOTH on for farms) each send aggroMon every 250 ms: 8 a second against a
    // 2-4.5/s send rate, so the queue filled with aggro and the real attacks waited ~30 s behind it or were dropped
    // (Valen at /escherion 2026-10-13 only ever cast his self-damage skill). Aggro sticks server-side, so one
    // queued aggroMon at a time (the newest replaces it) and the same pull at most every 2 s.
    if (String(msg).startsWith('%xt%zm%aggroMon%')) {
      const now = Date.now();
      if (msg === this._aggroMsg && now - (this._aggroAt || 0) < AGGRO_REPEAT_MS) return;
      this._aggroMsg = msg; this._aggroAt = now;
      const i = this.outbox.findIndex((m) => String(m).startsWith('%xt%zm%aggroMon%'));
      if (i >= 0) { this.outbox[i] = msg; return; }
    }
    // A scroll or potion (gar "i1") is nearly always a taunt or a timed answer to a boss line: it goes ahead of the queued
    // attacks. Ultra Speaker's Listen taunt (Scroll of Enrage) landed after the 2 s charge, the Stasis hit the VDK and
    // its Decay never went out (2026-10-24).
    if (/^%xt%zm%gar%\d+%\d+%i1>/.test(String(msg))) { this.outbox.unshift(msg); this.flush(); return; }
    // A walk (Skua WalkTo) answers a boss line too - Nightmare Carnax's laser lands 5 s after it names the safe zone, and
    // the main died in it with a dozen "slow down"s queued ahead (2026-10-28 13:07). It goes first; only the newest walk counts.
    if (String(msg).startsWith('%xt%zm%mv%')) {
      const i = this.outbox.findIndex((m) => String(m).startsWith('%xt%zm%mv%'));
      if (i >= 0) this.outbox.splice(i, 1);
      this.outbox.unshift(msg); this.flush(); return;
    }
    this.outbox.push(msg);
    this.flush();
  }

  // The server said "slow down": widen the send gap for a while, and remember when (slowWarnings).
  slowedDown(now = Date.now()) {
    this._slowUntil = now + SEND_GAP.holdMs;
    const s = this._slow || (this._slow = []);
    s.push(now);
    if (s.length > 5000) s.splice(0, s.length - 5000);
  }
  // Warnings in the last `windowMs`. Over 100 in 10 min, the watchdog stops counting script lines as progress.
  slowWarnings(now = Date.now(), windowMs = 600000) {
    const s = this._slow || [];
    let i = 0;
    while (i < s.length && now - s[i] > windowMs) i++;
    if (i) s.splice(0, i);
    return s.length;
  }
  sendGap(now = Date.now()) { return now < (this._slowUntil || 0) ? SEND_GAP.slow : SEND_GAP.normal; }

  flush() {
    if (this.flushing) return;
    const next = () => {
      if (!this.outbox.length || !this.sock || this.sock.destroyed) { this.flushing = false; return; }
      const wait = Math.max(0, (this._lastWrite || 0) + this.sendGap() - Date.now());
      if (wait > 0) { setTimeout(next, wait); return; }
      this._lastWrite = Date.now();
      this.sock.write(this.outbox.shift() + '\0');
      if (this.outbox.length > 60) {   // never build a backlog - but say what was thrown away (at most once a minute)
        // Filler (aggro pulls, walking) goes first; attacks, turn-ins and buys only when nothing else is left to drop.
        let excess = this.outbox.length - 60;
        const lost = [];
        this.outbox = this.outbox.filter((m) => {
          if (excess > 0 && QUEUE_FILLER.test(m)) { excess--; lost.push(m); return false; }
          return true;
        });
        if (excess > 0) lost.push(...this.outbox.splice(0, excess));
        this.outboxDropped = (this.outboxDropped || 0) + lost.length;
        if (Date.now() - (this._dropNoted || 0) > 60000) {
          this._dropNoted = Date.now();
          this.record('error', `send queue over 60: dropped ${lost.length} packet(s) (${[...new Set(lost.map((m) => String(m).split('%')[3]))].join(', ')}), ${this.outboxDropped} since start`);
        }
      }
      setImmediate(next);
    };
    this.flushing = true;
    next();
  }
  xt(cmd, args = [], room) { this.write(protocol.xt(cmd, args, room === undefined ? this.w.curRoom : room)); }

  disconnect() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
    if (this._mail) { clearTimeout(this._mail.waitTimer); this._mail = null; }
    clearInterval(this._liveTimer); this._liveTimer = null;
    this.deathOver();
    try { this.xt('cmd', ['logout'], 1); } catch (e) { /* already gone */ }
    if (this.sock) { this.sock.destroy(); this.sock = null; }
    this.state.loaded = false;
    if (this.swf) this.swf.dirty = true;
  }

  // ---------------- incoming packets ----------------
  handle(p, raw) {
    // The skua.swf model sees every packet first, as the game does before skua.swf's own listener.
    if (p.kind === 'xt' || p.kind === 'json') this.swf.onPacket(p);
    // Hand every game message to the bot in the shape the Flash bridge used: an array for %xt% strings,
    // the object itself for JSON ones. bot.js then counts kills, drops, quests and level-ups as before.
    if (p.kind === 'xt') this.record('pext', JSON.stringify([p.cmd, String(p.room), ...p.args]));
    else if (p.kind === 'json' && !(this.injecting && p.data && p.data.cmd === 'levelUp')) this.record('pext', JSON.stringify(p.data));
    if (p.kind === 'sys') {
      if (p.cmd === 'apiOK') this.write(protocol.loginMsg(this.login.username, this.login.token));
      if (p.cmd === 'apiKO') this.record('error', 'the server rejected the client version');
      if (p.cmd === 'joinOK') { this.w.areaId = p.room; this.w.curRoom = p.room; }
      if (p.cmd === 'logKO') this.emit('loginFailed', raw);
      return;
    }
    if (p.kind === 'xt') return this.handleXt(p, raw);
    if (p.kind === 'json') return this.handleJson(p.cmd, p.data);
  }

  handleXt(p, raw) {
    const a = p.args;
    switch (p.cmd) {
      case 'loginResponse':
        if (a[0] === 'true') { this.w.myAvatar.uid = Number(a[1]); this.record('state', 'logged in'); setTimeout(() => this.xt('firstJoin', [], 1), 700); }
        else { this.record('error', `login refused: ${a.slice(3).join(' ')}`); this.emit('loginFailed', a.join('%')); }
        return;
      case 'uotls': return this.applyUotls(a[0], a[1]);
      case 'mtls': return this.applyMtls(a[0], this.pairs(a[1]));
      // Game.as: "Your AQWorlds game account has been logged on from another window session or computer". The
      // hub must not log straight back in (it would kick the owner off his own account): hub.reconnect reads this.
      case 'multiLoginWarning': this._multiLoginAt = Date.now(); this.record('state', 'logged in somewhere else'); this.emit('multiLogin'); return;
      case 'server': case 'warning':
        if (/slow down|too soon/i.test(a.join(' '))) {
          this.slowedDown();
          // The refused skill never happened: the Skua model gives it back (swfworld VWorld.actionRefused).
          if (this.swf && this.swf.w && typeof this.swf.w.actionRefused === 'function') this.swf.w.actionRefused();
        }
        this.record('server', a.join(' '));
        this.emit('server', a.join(' '));
        return;
      // Game.as spcs: the monster in a slot changes into another one (boss phases): new name, level, race and HP.
      case 'spcs': {
        const mon = this.w.monsters.find((m) => String(m.MonMapID) === String(a[0]));
        const def = (this.w.mondef || {})[a[1]] || {};
        if (mon) Object.assign(mon, { MonID: Number(a[1]), strMonName: def.strMonName || mon.strMonName, intLevel: def.intLevel || mon.intLevel, sRace: def.sRace || mon.sRace, intHP: 0, intHPMax: Number(def.intHPMax) || mon.intHPMax, intState: 0 });
        if (mon && this.w.myAvatar.target && Number(this.w.myAvatar.target.MonMapID) === Number(a[0])) this.w.myAvatar.target = null;
        this.record('state', `monster ${a[0]} became ${def.strMonName || a[1]}`);
        return;
      }
      // The server moves the character (Game.as gtc / dungeonMTC).
      case 'gtc': if (a[0] != null && a[1] != null) this.jump(String(a[0]), String(a[1])); return;
      case 'dungeonMTC': if (a[0] === 'true') { const [cell, pad] = String(a[1] || '').split(','); if (cell) this.jump(cell, pad || 'Spawn'); } return;
      // The server moved us through a map pad (Game.as mtcid -> World.moveToCellByIDb(tID), moveToCell(.., true, true):
      // no packet back). Skua's CoreBots.PvPMove (/dagepvp, Forge Elysium's Sword Scroll Fragments) waits for the cell;
      // with only a note here all three bots stalled at "Farming Sword Scroll Fragment (0/1000)" (2026-10-17/18).
      case 'mtcid': {
        const pad = mtcidPad(this.w.strMapName, a[0]);
        if (!pad) { this.noteMapEvent(p.cmd, a); return; }
        this.w.strFrame = pad[0];
        this.w.strPad = pad[1];
        return;
      }
      // Server notices the game shows in chat or a box: kept like any server line (journals, Skua's warnings).
      case 'serverf': case 'notify': case 'popup': case 'logoutWarning': case 'wheel':
        this.record('server', a.join(' '));
        this.emit('server', a.join(' '));
        return;
      // Map-script events: the map file's own code would run here, and a headless client has none. Noted once per
      // map, so maps whose quests depend on them can be found and handled (knowledge/map-events.json).
      case 'dungeonCompleted': case 'Dragon Buff': case 'trap door': case 'elmSwitch': case 'gsupdate': case 'frostupdate':
        this.noteMapEvent(p.cmd, a);
        return;
      case 'respawnMon': {
        const mon = this.w.monsters.find((m) => String(m.MonMapID) === String(a[0]));
        if (mon) { mon.intHP = mon.intHPMax; mon.intState = 1; }
        return;
      }
      case 'exitArea': {
        const name = a[2] || a[1];
        if (name && name.toLowerCase() === String(this.w.myAvatar.objData.strUsername).toLowerCase()) return;
        delete this.w.users[String(name).toLowerCase()];
        return;
      }
      default:
        this.emit('packet', raw);
    }
  }

  // skua.swf sendClientPacket: a packet handed to the client as if the server had sent it.
  inject(packet, type = 'str') {
    if (type === 'xml') return;
    const p = protocol.parse(String(packet));
    if (p.kind === 'bad') return;
    this.injecting = true;
    try { this.handle(p, String(packet)); } catch (e) { this.record('error', `client packet: ${e.message}`); } finally { this.injecting = false; }
    this.emit('sfs', p);
  }

  // Skua's Servers.Login/Connect, for the few scripts that log out and pick a server themselves.
  async scriptLogin(user, pass) {
    const info = await protocol.login(user || this.credentials().username, pass || this.credentials().password);
    this.login = info;
    this.swf.setLogin(info, pass || this.credentials().password);
    return info;
  }

  async scriptConnect(server) {
    if (!this.login) await this.scriptLogin();
    const s = (this.login.servers || []).find((x) => String(x.sName).toLowerCase() === String(server.sName || server.name || '').toLowerCase()) || server;
    this.scriptDriven = true;          // hub.reconnect leaves this drop to the script
    if (this.sock && !this.sock.destroyed) this.disconnect();
    this.reset();
    this.serverName = s.sName;
    this.swf.setServer(s);
    this.record('state', `script connects to ${s.sName}`);
    await this.connect(s, this.login);
    return true;
  }

  // "%xt%uotls%-1%<user>%k:v,k:v" — live updates for a player (hp, state, cell…).
  applyUotls(user, csv) {
    if (!csv) return;
    const me = String(this.w.myAvatar.objData.strUsername).toLowerCase();
    const target = String(user).toLowerCase() === me ? this.w.myAvatar.dataLeaf : (this.w.users[String(user).toLowerCase()] = this.w.users[String(user).toLowerCase()] || {});
    for (const pair of csv.split(',')) {
      const k = pair.slice(0, pair.indexOf(':'));
      let v = pair.slice(pair.indexOf(':') + 1);
      if (!k) continue;
      if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
      if (v === 'true' || v === 'false') v = v === 'true';
      target[k] = v;
      if (target === this.w.myAvatar.dataLeaf) {
        if (k === 'intHP' && Number(v) > 0) this.sawHp = true;
        if (k === 'intHP' || k === 'intState') setImmediate(() => this.checkDeath());
        if (k === 'strFrame') this.w.strFrame = v;
        if (k === 'strPad') this.w.strPad = v;
        // The server marks a character AFK after ~2 min without input and a NoAFK map (icewing, icestormunder) removes it a
        // minute later: Valen and Oren were sent to battleon while waiting outside a boss cell for a crowd (NSoDDaily,
        // 2026-10-02). A bot is never really away, so clear the flag the moment it is set.
        if (k === 'afk' && v === true) setImmediate(() => this.afkPostpone());
        if (k === 'intLevel') this.w.myAvatar.objData.intLevel = v;
      }
    }
  }

  // "k:v,k:v" -> { k: v }, the way Game.as unpacks the string form of uotls/mtls.
  pairs(csv) {
    const o = {};
    for (const pair of String(csv || '').split(',')) { const i = pair.indexOf(':'); if (i > 0) o[pair.slice(0, i)] = pair.slice(i + 1); }
    return o;
  }

  applyUotlsObj(user, o) {
    if (!o) return;
    this.applyUotls(user, Object.entries(o).map(([k, v]) => `${k}:${v}`).join(','));
  }

  // Monster hit points and state (monsterTreeWrite in Game.as).
  applyMtls(id, o) {
    const mon = this.w.monsters.find((m) => Number(m.MonMapID) === Number(id));
    if (!mon || !o) return;
    const alive = this.isAlive(mon);
    for (const [k, v] of Object.entries(o)) mon[k] = /^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : v;
    this.monsterUpdated(mon, alive);
    const t = this.w.myAvatar.target;
    if (t && Number(t.MonMapID) === Number(id) && (Number(mon.intHP) <= 0 || Number(mon.intState) === 0)) { this.w.myAvatar.target = null; this.emit('kill', mon); }
  }

  // What a map's own code does when a monster kills you (its eventTrigger "playerDeath"). No map SWF runs here, so the
  // item it hands out never came: LoO's Confront Akriloth waited in firewar for ever (2026-10-05). From the decompiled
  // map (FireWar/town-firewar-16Sep19.swf): pad 23 = Akriloth, quest 6299 in progress -> getMapItem(5799).
  onPlayerDeath(d) {
    const me = this.w.myAvatar;
    const mine = [me.uid, me.objData && me.objData.UserID].filter((x) => x !== undefined && x !== null).map(String);
    if (!mine.includes(String(d.userID))) return;
    if (this.mapHooks('event', null, { ...d, event: 'playerDeath' })) return;   // the scanned table knows this map
    const hooks = MAP_DEATH_HOOKS[String(this.w.strMapName || '').toLowerCase()] || [];
    for (const h of hooks) {
      if (Number(d.monPad) !== h.monPad) continue;
      const model = this.swf && this.swf.w;
      const going = this.accepted.has(h.quest) || !!(model && typeof model.isQuestInProgress === 'function' && model.isQuestInProgress(h.quest));
      if (!going) continue;
      this.xt('getMapItem', [h.mapItem]);
      this.emit('mapNote', `the map gives its item for dying to ${h.what} (map item ${h.mapItem}, quest ${h.quest})`);
    }
  }

  // ---------------- mailbox (AQW 5.0, liteAssets/draw/MailHub.as in Game4000r5) ----------------
  // Letters from the AQW Team carry attachments (items, gold, AC, XP, rep, class points). The owner 2026-10-19: every bot
  // opens its mail and claims everything. Same packets as the game's Claim All: zm mailList [cursor] -> {mails, next},
  // mailRead [id], mailClaim [id] -> {id, ok, claimed, got, skip, msg, busy}; mailNew pushes a letter while online.
  // One request at a time, 1.2 s apart (the game waits 1.1 s between list pages). A refused claim (full backpack) is
  // tried again at the next login, and the daily-reset relog makes that at least once a day.
  mailCheck(cursor = 0) {
    if (!this.inventoryLoaded || !this.sock) return;
    this.mailSend('mailList', [cursor]);
  }

  mailSend(cmd, args) {
    const m = (this._mail = this._mail || { out: [], at: 0, waiting: null, tries: {}, gained: false });
    m.out.push({ cmd, args });
    this.mailPump();
  }

  mailPump() {
    const m = this._mail;
    if (!m || m.waiting || m.timer || !m.out.length) return;
    const wait = Math.max(0, 1200 - (Date.now() - m.at));
    m.timer = setTimeout(() => {
      m.timer = null;
      const next = m.out.shift();
      if (!next || !this.sock) return;
      m.at = Date.now();
      this.xt(next.cmd, next.args);
      if (next.cmd === 'mailClaim') {
        m.waiting = next.args[0];
        // MailHub gives up on an answer after 6 s; so do we, and the letter waits for the next login.
        m.waitTimer = setTimeout(() => { m.waiting = null; this.mailPump(); }, 8000);
        return;
      }
      this.mailPump();
    }, wait);
    this.timers.push(m.timer);
  }

  static mailHasRewards(x) { return !!(x && Array.isArray(x.att) && x.att.some((a) => !a || Number(a.ok) !== 1)); }

  onMail(cmd, d) {
    const m = (this._mail = this._mail || { out: [], at: 0, waiting: null, tries: {}, gained: false });
    m.subj = m.subj || {};
    if (cmd === 'mailList' || cmd === 'mailNew') {
      const list = cmd === 'mailNew' ? [d.mail] : (d.mails || []);
      for (const x of list) {
        if (!x || x.id === undefined) continue;
        m.subj[x.id] = String(x.subj || x.id);
        if (!Number(x.read)) this.mailSend('mailRead', [x.id]);
        const queued = m.out.some((o) => o.cmd === 'mailClaim' && o.args[0] === x.id) || m.waiting === x.id;
        if (HeadlessClient.mailHasRewards(x) && !queued && (m.tries[x.id] || 0) < 3) {
          m.tries[x.id] = (m.tries[x.id] || 0) + 1;
          this.mailSend('mailClaim', [x.id]);
        }
      }
      if (cmd === 'mailList' && Number(d.next) > 0) this.mailSend('mailList', [Number(d.next)]);
      return;
    }
    // mailClaim
    if (m.waiting !== null && String(m.waiting) === String(d.id)) { clearTimeout(m.waitTimer); m.waiting = null; }
    const subj = m.subj[d.id] || d.id;
    if (Number(d.busy) === 1) {
      // The server is still handing out an earlier claim: ask again in a moment.
      if ((m.tries[d.id] || 0) < 3) { m.tries[d.id] = (m.tries[d.id] || 0) + 1; this.mailSend('mailClaim', [d.id]); }
    } else if (Number(d.ok) === 1 || Number(d.claimed) === 1) {
      this.record('state', `mail: claimed the rewards from "${subj}"`);
      this.emit('mailNote', `mail: claimed the rewards from "${subj}"`);
      m.gained = true;
    } else {
      const why = `mail: could not claim "${subj}"${d.msg ? `: ${d.msg}` : ''} - trying again at the next login`;
      this.record('server', why);
      this.emit('mailNote', why);
    }
    for (const n of d.notes || []) this.record('server', `mail: ${n}`);
    // Items arrive in the backpack: once the queue is empty, re-read the inventory as ccqr does, so the skua.swf
    // model (what scripts see) holds them too. It is a resync, not a login (see loadInventoryBig).
    if (m.gained && !m.out.some((o) => o.cmd === 'mailClaim') && !m.waiting) {
      m.gained = false;
      this._invResyncLast = this._invResyncAt = Date.now();
      this.timers.push(setTimeout(() => this.xt('retrieveInventory', [this.w.myAvatar.uid]), 1500));
    }
    this.mailPump();
  }

  handleJson(cmd, d) {
    switch (cmd) {
      case 'mailList': case 'mailNew': case 'mailClaim': return this.onMail(cmd, d);
      case 'mailBody': return;
      case 'playerDeath': return this.onPlayerDeath(d);
      case 'callfct': case 'clockTick': case 'alchOnStart': case 'alchComplete': case 'spellOnStart': case 'spellComplete': case 'spellWaitTimer': case 'castWait': case 'ia': case 'siau': case 'reloadmap':
        this.noteMapEvent(cmd, d);
        return;
      case 'balance':
        if (d.intGold != null) this.w.myAvatar.objData.intGold = Number(d.intGold);
        if (d.intExp != null) this.w.myAvatar.objData.intExp = Number(d.intExp);
        return;
      case 'multiLoginWarning': this._multiLoginAt = Date.now(); this.record('state', 'logged in somewhere else'); this.emit('multiLogin'); return;
      case 'moveToArea': return this.onMoveToArea(d);
      // The server sends live player and monster updates two ways: "%xt%uotls%-1%<user>%k:v,..." and
      // {"cmd":"uotls","unm":"<user>","o":{...}} (Game.as handles both, into the same tree). Only the string form
      // was applied here, so a character whose HP only ever came as JSON stayed at 0 and looked dead for ever -
      // Oren sat "dead" at full health for hours on 2026-09-20 while the server kept saying intHP 2197.
      case 'uotls': return this.applyUotlsObj(d.unm, d.o);
      case 'mtls': return this.applyMtls(d.id, d.o);
      case 'initUserData': return this.onInitUserData(d.data || d);
      case 'initUserDatas': {
        for (const u of d.a || []) if (String(u.strUsername || '').toLowerCase() === String(this.w.myAvatar.objData.strUsername).toLowerCase()) this.onInitUserData(u);
        return;
      }
      case 'loadInventoryBig': {
        // The items themselves live in the skua.swf model (see reset()).
        // A resync (ccqr below) is not a login: 'loaded' would book a new login day and a friend-watch login.
        if (this.inventoryLoaded && this._invResyncAt && Date.now() - this._invResyncAt < 30000) {
          this._invResyncAt = 0;
          this.record('state', `inventory re-read from the server: ${(d.items || []).length} items`);
          return;
        }
        this.inventoryLoaded = true;
        this.state.loaded = true;
        this.record('state', `character loaded: ${(d.items || []).length} items`);
        this.emit('loaded');
        this.timers.push(setTimeout(() => this.mailCheck(0), 8000));   // the game's MailHub asks once the HUD is up
        return;
      }
      case 'sAct': {
        const acts = d.actions || {};
        const active = acts.active || [];
        this.w.actions.active = active;
        this.w.actions.passive = acts.passive || [];
        return;
      }
      case 'addGoldExp': {
        // Experience and gold are what "XP an hour" and "gold an hour" are measured from. They only ever came from
        // the login packet here, so every character read 0 an hour however well it was farming (2026-09-20).
        const o = this.w.myAvatar.objData;
        if (Number(d.intExp) > 0) o.intExp = Number(o.intExp || 0) + Number(d.intExp);
        if (Number(d.intGold) > 0) o.intGold = Number(o.intGold || 0) + Number(d.intGold);
        if (d.iCP !== undefined) o.iCP = Number(o.iCP || 0) + Number(d.iCP);   // the class item's points: Avatar.updateArmorRep in the skua.swf model
        return;
      }
      case 'updateClass':
        if (d.uid !== undefined && Number(d.uid) !== Number(this.w.myAvatar.uid)) return;   // someone else's class
        if (d.iCP !== undefined) this.w.myAvatar.objData.iCP = Number(d.iCP);
        if (d.sClassName) this.w.myAvatar.objData.strClassName = d.sClassName;
        if (d.actions) this.w.actions.active = d.actions.active || this.w.actions.active;
        return;
      case 'equipItem': case 'unequipItem': return;   // the skua.swf model tracks equipment
      case 'dropItem': {
        const items = d.items || {};
        for (const id of Object.keys(items)) this.emit('drop', Object.assign({ ItemID: Number(id) }, items[id]));   // offered, not taken yet
        return;
      }
      case 'addItems': return;   // the skua.swf model adds it
      case 'getDrop': return;
      case 'pa': {
        // Game.as adds every name in `ul` except your own, so a leader's list is the others - never itself. Keeping
        // yourself in it made the party look one member fuller than it is (hub.partyTick, World.isPartyFull).
        const me = String(this.w.myAvatar.objData.strUsername || '').toLowerCase();
        if (Array.isArray(d.ul)) {
          const have = new Set((this.w.partyMembers || []).map((x) => String(x).toLowerCase()));
          for (const n of d.ul) { const x = String(n).toLowerCase(); if (x && x !== me) have.add(x); }
          this.w.partyMembers = [...have];
        }
        if (d.owner) this.w.partyOwner = d.owner;
        if (d.pid) this.w.partyID = d.pid;
        return;
      }
      case 'pr': case 'pl': case 'pk': {
        // `owner` on a pr is the NEW leader, not the member who left - reading it as the leaver removed the wrong name.
        if (d.cmd === 'pr' && d.owner) this.w.partyOwner = d.owner;
        const gone = String(d.unm || '').toLowerCase();
        if (!gone) return;
        if (gone === String(this.w.myAvatar.objData.strUsername || '').toLowerCase()) { this.w.partyMembers = []; this.w.partyID = 0; this.w.partyOwner = ''; }
        else this.w.partyMembers = (this.w.partyMembers || []).filter((x) => x !== gone);
        return;
      }
      case 'pd': return;   // Game.as: "<name> has declined your invitation" - the party itself is untouched
      // `cb` (combat begin/end batches) carries the same {m, p} state as `ct`, our own intState 2 (in combat) included.
      // Only `ct` was read, so bot.inCombat() missed fights and every join was silently refused while monsters kept
      // us in combat (Valen, 2026-09-26: 26 failed joins in 43 min). skua.swf's model always read both.
      case 'ct': case 'cb': return this.onCombat(d);
      case 'sars': return this.skillResult(d);
      case 'aura+': case 'aura+p': case 'aura++': case 'aura*': case 'aura-': case 'aura--': case 'aura-p': case 'clearAuras': return this.applyAura(d);
      case 'updateQuest': { this.setQuestValue(Number(d.iIndex), Number(d.iValue)); return; }   // Game.as: world.setQuestValue
      case 'getQuests': {
        const quests = d.quests || {};
        for (const id of Object.keys(quests)) this.w.questTree[id] = { ...quests[id] };   // own copy (see loadInventoryBig)
        return;
      }
      case 'ccqr': {   // quest turn-in result
        if (d.bSuccess) this.accepted.delete(Number(d.QuestID));
        // AC rewards (the 500 free birthday ACs, 2026-10-10) only showed after the next login: Game.as only prints
        // rewardObj.intCoins and the balance comes with the next login. Seraph counts them now (dashboard, reports);
        // gold and XP come through addGoldExp.
        if (Number(d.bSuccess) === 1 && d.rewardObj && Number(d.rewardObj.intCoins) > 0) {
          const o = this.w.myAvatar.objData;
          o.intCoins = Number(o.intCoins || 0) + Number(d.rewardObj.intCoins);
          if (this.swf && this.swf.w && this.swf.w.myAvatar.objData !== o) this.swf.w.myAvatar.objData.intCoins = Number(this.swf.w.myAvatar.objData.intCoins || 0) + Number(d.rewardObj.intCoins);
        }
        if (d.bSuccess) { try { this.mapHooks('event', null, { event: 'questComplete', args: Number(d.QuestID) }); } catch (e) { /* notes only */ } }
        // The server says an item is missing that the model counts as held: a stack count drifted (two addItems with
        // the same iQtyNow are sometimes two grants, sometimes one). Valen's model read 75/75 Hydra Scale Piece while the
        // server had 74, so Skua stopped hunting and quest 8736 failed every 2 s for 20 min (2026-10-08). Re-read the
        // inventory, as the game does at login - once a minute at most.
        else if (/missing turn in item/i.test(String(d.msg || '')) && this.inventoryLoaded && Date.now() - (this._invResyncLast || 0) > 60000) {
          this._invResyncLast = this._invResyncAt = Date.now();
          this.record('state', `quest ${d.QuestID}: server says a turn-in item is missing - re-reading the inventory`);
          this.xt('retrieveInventory', [this.w.myAvatar.uid]);
        }
        return;
      }
      case 'loadShop': this.w.shopinfo = d.shopinfo || d; return;
      case 'loadHairShop': this.w.hairshopinfo = d.hairshopinfo || d; return;
      // The server's answer to a barber visit (Game.as changeColor / changeArmorColor): our own avatar's new look.
      case 'changeColor': {
        if (d.uid !== undefined && Number(d.uid) !== Number(this.w.myAvatar.uid)) return;
        const o = this.w.myAvatar.objData;
        if (d.HairID != null) Object.assign(o, { HairID: d.HairID, strHairName: d.strHairName, strHairFilename: d.strHairFilename });
        for (const k of ['intColorSkin', 'intColorHair', 'intColorEye']) if (d[k] != null) o[k] = Number(d[k]);
        return;
      }
      case 'changeArmorColor': {
        if (d.uid !== undefined && Number(d.uid) !== Number(this.w.myAvatar.uid)) return;
        for (const k of ['intColorBase', 'intColorTrim', 'intColorAccessory']) if (d[k] != null) this.w.myAvatar.objData[k] = Number(d[k]);
        return;
      }
      case 'loadBank': {
        // One entry per CharItemID: every reload used to stack another copy on top of the old list.
        const fresh = (d.items || []).filter(Boolean).map((o) => ({ ...o }));
        const ids = new Set(fresh.map((o) => String(o.CharItemID)));
        this.w.bankinfo.items = fresh.concat((this.w.bankinfo.items || []).filter((o) => !ids.has(String(o.CharItemID))));
        this.w.bankinfo.loadedAt = Date.now();
        return;
      }
      case 'levelUp': {
        if (d.intLevel) this.w.myAvatar.objData.intLevel = d.intLevel;
        if (!this.injecting) {
          if (d.intExpToLevel !== undefined) this.w.myAvatar.objData.intExpToLevel = Number(d.intExpToLevel);
          if (d.xp !== undefined) this.w.myAvatar.objData.intExp = Number(d.xp);
        }
        // CoreBots injects {levelUp, intLevel: 100} on every /icestormarena join to open level-locked cells: not a level.
        if (!this.injecting) { if (d.intLevel) this.w.myAvatar.dataLeaf.intLevel = d.intLevel; this.emit('levelUp', d.intLevel); }
        return;
      }
      case 'stu': {
        if (d.sta) this.w.myAvatar.dataLeaf.sta = Object.assign(this.w.myAvatar.dataLeaf.sta || {}, d.sta);
        const o = d.sStats || d;
        if (o && o.intLevel) this.w.myAvatar.objData.intLevel = o.intLevel;
        return;
      }
      default: return;
    }
  }

  onMoveToArea(d) {
    this.w.areaId = d.areaId;
    this.w.curRoom = d.areaId;
    this.w.strAreaName = d.areaName || '';
    this.w.strMapName = d.strMapName || String(d.areaName || '').split('-')[0];
    this.w.strMapFileName = d.strMapFileName || '';
    this._hookFired = new Set();   // map hooks fire once per visit (events excepted)
    this.w.mondef = {};
    for (const m of d.mondef || []) this.w.mondef[m.MonID] = m;
    this.w.monsters = (d.monmap || []).map((m) => {
      const def = this.w.mondef[m.MonID] || {};
      return {
        MonMapID: m.MonMapID, MonID: m.MonID, strFrame: m.strFrame, bRed: m.bRed,
        strMonName: def.strMonName || `Monster ${m.MonID}`, intLevel: def.intLevel || 0,
        sRace: def.sRace, strBehave: def.strBehave,
        intHP: 100, intHPMax: 100, intState: 1,
      };
    });
    // A slot (MonMapID) can list several possible monsters (a cluster); the live one is the MonID its monBranch entry
    // names (World.initMonsters). Keep only that one, so a find by MonMapID gets the right monster.
    const live = new Map((d.monBranch || []).filter((mb) => mb.MonID !== undefined).map((mb) => [String(mb.MonMapID), Number(mb.MonID)]));
    this.w.monsters = this.w.monsters.filter((m, i, all) => {
      const want = live.get(String(m.MonMapID));
      if (want !== undefined) return Number(m.MonID) === want || !all.some((x) => String(x.MonMapID) === String(m.MonMapID) && Number(x.MonID) === want);
      return all.findIndex((x) => String(x.MonMapID) === String(m.MonMapID)) === i;
    });
    // Real hit points and state come in monBranch; the numbers above were only placeholders.
    for (const mb of d.monBranch || []) {
      const mon = this.w.monsters.find((x) => x.MonMapID === mb.MonMapID);
      if (mon) Object.assign(mon, { intHP: mb.intHP, intHPMax: mb.intHPMax, intState: mb.intState, intLevel: mb.iLvl || mon.intLevel });
    }
    this.w.users = {};
    for (const u of d.uoBranch || []) {
      this.w.users[String(u.strUsername).toLowerCase()] = u;
      if (String(u.strUsername).toLowerCase() === String(this.w.myAvatar.objData.strUsername).toLowerCase()) {
        const live = defined({ intHP: u.intHP, intHPMax: u.intHPMax, intMP: u.intMP, intMPMax: u.intMPMax, intState: u.intState, intLevel: u.intLevel });
        if (Number(live.intHP) === 0 && Number(live.intState) !== 0 && Number(this.w.myAvatar.dataLeaf.intHP) > 0) delete live.intHP;   // blank, not dead
        Object.assign(this.w.myAvatar.dataLeaf, live);
        if (Number(live.intHP) > 0) this.sawHp = true;
        this.w.myAvatar.objData.intLevel = u.intLevel;
        this.w.strFrame = u.strFrame || 'Enter';
      }
    }
    this.w.myAvatar.target = null;
    this.record('state', `joined ${this.w.strAreaName}`);
    this.emit('area', this.w.strAreaName);
    // What the map's load code hands out, once the character's quests are known (a few seconds after the join).
    setTimeout(() => { try { this.mapHooks('join'); this.mapHooks('cell', this.w.strFrame); } catch (e) { /* never break a join */ } }, 4000);
    // The map is only "entered" for the server once the client picks a cell, and the server sends no character
    // data until the client asks for it. Without these three the account sits in limbo with an empty inventory.
    setTimeout(() => this.xt('moveToCell', [this.w.strFrame || 'Enter', this.w.strPad || 'Spawn']), 400);
    // Like the game (World.objectByIDArray), every map join re-reads this character's data from the server. That also
    // undoes CoreBots' client-side "level 100" spoof (sent on every /icestormarena join): without it Skua kept
    // believing a level-47 character was 100 and sent her to /icestormunder, which the server refuses below 75.
    if (this.inventoryLoaded) setTimeout(() => this.xt('retrieveUserData', [this.w.myAvatar.uid]), 50);
    if (!this.inventoryLoaded) {
      const ids = (d.uoBranch || []).map((u) => u.entID).filter(Boolean);
      setTimeout(() => { if (ids.length) this.xt('retrieveUserDatas', ids); }, 900);
      setTimeout(() => this.xt('retrieveUserData', [this.w.myAvatar.uid]), 1300);
      setTimeout(() => this.xt('retrieveInventory', [this.w.myAvatar.uid]), 1800);
    }
  }

  onInitUserData(u) {
    if (!u) return;
    if (String(u.strUsername || '').toLowerCase() !== String(this.w.myAvatar.objData.strUsername).toLowerCase() && u.strUsername) return;
    Object.assign(this.w.myAvatar.objData, u);
    if (u.intLevel) this.w.myAvatar.dataLeaf.intLevel = Number(u.intLevel);
    // initUserData never carries live hit points - it says intHP 0 for every character, at login and in the answer
    // to retrieveUserData, which Seraph asks for after every room change. Copying that 0 wiped the real number each
    // time a character changed map, and a character in a quiet room (no uotls) then looked dead for ever.
    if (u.intHP !== undefined) {
      const live = defined({ intHP: u.intHP, intHPMax: u.intHPMax, intMP: u.intMP, intMPMax: u.intMPMax, intState: u.intState === undefined ? 1 : u.intState });
      if (!(Number(live.intHP) > 0)) { delete live.intHP; delete live.intMP; }
      if (!(Number(live.intHPMax) > 0)) delete live.intHPMax;
      Object.assign(this.w.myAvatar.dataLeaf, live);
      if (Number(live.intHP) > 0) this.sawHp = true;
    }
    if (u.CharID) this.w.myAvatar.objData.CharID = u.CharID;
  }

  // Buffs and debuffs, kept per subject so rotations can wait for a stack or refresh a debuff.
  applyAura(d) {
    const self = `p:${this.w.myAvatar.uid}`;
    if (d.cmd === 'clearAuras') { this.auras[self] = new Map(); return; }
    const key = d.tInf || self;
    const bag = this.auras[key] || (this.auras[key] = new Map());
    // aura++ / aura* (a stack or refresh, mostly inside ct) add like aura+, as lib/skua/swfworld.js reads them; they used
    // to fall through to the delete below, so a refreshed buff vanished from the combat engine (2026-10-19).
    if (d.cmd === 'aura+' || d.cmd === 'aura+p' || d.cmd === 'aura++' || d.cmd === 'aura*') {
      for (const a of d.auras || []) if (a && a.nam) bag.set(String(a.nam).toLowerCase(), { ...a, ts: a.ts || Date.now() });
    } else {
      for (const a of [d.aura, ...(d.auras || [])]) if (a && a.nam) bag.delete(String(a.nam).toLowerCase());
    }
  }

  subjectKey(subject) {
    if (String(subject).toLowerCase() === 'self') return `p:${this.w.myAvatar.uid}`;
    const t = this.w.myAvatar.target;
    return t ? `m:${t.MonMapID}` : null;
  }

  aurasOf(subject) {
    const key = this.subjectKey(subject);
    const bag = key && this.auras[key];
    if (!bag) return [];
    const now = Date.now();
    const out = [];
    for (const [name, a] of bag) {
      if (a.dur && a.ts && Number(a.ts) + Number(a.dur) * 1000 < now) { bag.delete(name); continue; }
      out.push(a);
    }
    return out;
  }

  // Same rules the game applies before sending a skill: known, unlocked, off cooldown, enough mana, live target.
  canUseSkill(index) {
    const skill = (this.w.actions.active || [])[index];
    if (!skill || skill.isOK === false) return false;
    const target = this.w.myAvatar.target;
    if (skill.tgt !== 's' && skill.tgt !== 'f' && (!target || (target.intHP !== undefined && target.intHP <= 0))) return false;
    const ref = skill.ref || SKILL_REFS[index];
    if ((this.cooldowns[ref] || 0) > Date.now()) return false;
    if (!(ref === 'aa' || skill.auto) && !this.gcdReady()) return false;
    if (skill.mp && Number(this.w.myAvatar.dataLeaf.intMP || 0) < Number(skill.mp)) return false;
    return true;
  }

  // Combat turn: hp changes for players and monsters, deaths, quest item drops.
  onCombat(d) {
    for (const sub of d.a || []) if (sub && typeof sub.cmd === 'string' && sub.cmd.startsWith('aura')) this.applyAura(sub);
    const me = String(this.w.myAvatar.objData.strUsername).toLowerCase();
    for (const [name, vals] of Object.entries(d.p || {})) {
      const t = name.toLowerCase() === me ? this.w.myAvatar.dataLeaf : (this.w.users[name.toLowerCase()] = this.w.users[name.toLowerCase()] || {});
      Object.assign(t, vals);
    }
    for (const [id, vals] of Object.entries(d.m || {})) {
      const mon = this.w.monsters.find((x) => String(x.MonMapID) === String(id));
      if (mon) { const alive = this.isAlive(mon); Object.assign(mon, vals); this.monsterUpdated(mon, alive); }
    }
    // The last monster whose attack landed on this character, so a death can name its killer (killer(), and the boss
    // alert in hub.bossDeath). Monster attacks are `sara` results: {cInf: 'm:<MonMapID>', tInf: 'p:<uid>', hp}.
    const myRef = `p:${this.w.myAvatar.uid}`;
    const ours = this.manners && this.manners.ours ? this.manners.ours().uids : null;
    for (const s of d.sara || []) {
      const r = (s && s.actionResult) || s || {};
      if (/^p:\d+$/.test(String(r.cInf)) && String(r.cInf) !== myRef && !(ours && ours.has(String(r.cInf))) && /^m:\d+$/.test(String(r.tInf))) this.othersHits.set(Number(String(r.tInf).slice(2)), Date.now());
      if (String(r.tInf) === myRef && /^m:\d+$/.test(String(r.cInf)) && Number(r.hp) > 0) { this.lastHitBy = { id: Number(String(r.cInf).slice(2)), at: Date.now() }; this.fightNote('taken', Number(String(r.cInf).slice(2)), Number(r.hp)); }
      if (String(r.cInf) === myRef && /^m:\d+$/.test(String(r.tInf))) { this.myHits.set(Number(String(r.tInf).slice(2)), Date.now()); if (Number(r.hp) > 0) { this.damageAt = Date.now(); this.fightNote('dealt', Number(String(r.tInf).slice(2)), Number(r.hp)); } }
    }
    for (const s of d.sarsa || []) this.skillResult(s);
    // Target died: forget it so the bot picks a new one.
    const t = this.w.myAvatar.target;
    if (t) {
      const mon = this.w.monsters.find((x) => x.MonMapID === t.MonMapID);
      if (!mon || mon.intHP <= 0 || mon.intState === 0) { this.w.myAvatar.target = null; this.emit('kill', mon); }
    }
    this.checkDeath();
  }

  // Fight numbers for the difficulty estimate (audit A3, lib/walls.js): damage this character deals per second of
  // fighting (per-second buckets over the last 30 min) and what each monster hits it for (last 50 hits per name).
  // This character's own attacks (World.handleSARS): {cInf: 'p:<uid>', iRes, a: [{tInf: 'm:<MonMapID>', hp}]}, inside ct
  // (sarsa) or on their own (sars). Only `sara` - monster attacks - was read, so the character's damage was never seen:
  // a solo boss fight looked like no progress (Sable at Undead Raxgore, restarted every 10 min, 2026-10-10) and
  // "killed by me" (myHits) was never set.
  skillResult(s, now = Date.now()) {
    if (!s || String(s.cInf) !== `p:${this.w.myAvatar.uid}` || Number(s.iRes) !== 1) return;
    for (const x of s.a || []) {
      if (!x || !/^m:\d+$/.test(String(x.tInf))) continue;
      const id = Number(String(x.tInf).slice(2));
      this.myHits.set(id, now);
      if (Number(x.hp) > 0) { this.damageAt = now; this.fightNote('dealt', id, Number(x.hp), now); }
    }
  }

  fightNote(kind, monMapId, hp, now = Date.now()) {
    const f = this.fight || (this.fight = { secs: [], taken: new Map() });
    if (kind === 'dealt') {
      const sec = Math.floor(now / 1000);
      const last = f.secs[f.secs.length - 1];
      if (last && last.s === sec) last.d += hp; else f.secs.push({ s: sec, d: hp });
      while (f.secs.length && f.secs[0].s < sec - 1800) f.secs.shift();
      return;
    }
    const mon = this.w.monsters.find((x) => Number(x.MonMapID) === Number(monMapId));
    const name = mon && (mon.strMonName || mon.sName);
    if (!name) return;
    const t = f.taken.get(name) || { hits: [] };
    t.hits.push(hp);
    if (t.hits.length > 50) t.hits.shift();
    t.hpMax = Number(mon.intHPMax) || t.hpMax || 0;
    t.at = now;
    f.taken.set(name, t);
    if (f.taken.size > 200) f.taken.delete(f.taken.keys().next().value);
  }
  // Damage per second while fighting (seconds with no hit landed don't count), and a monster's average hit on us.
  fightStats(name = null, now = Date.now()) {
    const f = this.fight || { secs: [], taken: new Map() };
    const recent = f.secs.filter((x) => x.s >= Math.floor(now / 1000) - 1800);
    // Hits land every ~1-2 s, so a fight second is any second within 2 s of a hit.
    let fightSecs = 0; let prev = null;
    for (const x of recent) { fightSecs += prev === null ? 1 : Math.min(2, x.s - prev); prev = x.s; }
    const dealt = recent.reduce((a, x) => a + x.d, 0);
    const out = { dps: fightSecs >= 20 ? Math.round(dealt / fightSecs) : null, fightSecs };
    const t = name ? f.taken.get(name) : null;
    if (t && t.hits.length) { out.hit = Math.round(t.hits.reduce((a, b) => a + b, 0) / t.hits.length); out.hits = t.hits.length; out.hpMax = t.hpMax || null; }
    return out;
  }

  // The Flash client shows a countdown and then asks to respawn (World.resPlayer). With no client doing that,
  // a dead character just stays dead - so ask ourselves, and keep asking until the server revives us.
  checkDeath() {
    const me = this.w.myAvatar.dataLeaf;
    if (Number(me.intHP) > 0) this.sawHp = true;
    // intState 0 is dead. 0 hit points on its own is not: the login packet carries intHP 0 for everyone and the
    // real number only arrives with the first uotls, so before that a character is loading, not dying.
    const dead = Number(me.intState) === 0 || (Number(me.intHP) <= 0 && this.sawHp);
    if (!dead) { this.deathOver(); return; }
    if (!this.deadSince) { this.deadSince = Date.now(); this.emit('died'); this.w.myAvatar.target = null; }
    // A reconnect clears every timer but used to leave this handle set, and checkDeath then returned for ever:
    // the character stayed dead, and every combat tick counted the same death again (Oren, 2026-09-20: 668
    // deaths at oaklore r3, all of them one death). Re-arm whenever nothing has asked in the last 15 s.
    if (this._respawn && Date.now() - (this._askedAt || 0) < 15000) return;
    this.stopRespawn();
    const ask = () => {
      // The 10.5 s first ask outlives a respawn or a reconnect; with the clock cleared it read "still dead 1792152646s".
      if (!this.deadSince) return;
      const leaf = this.w.myAvatar.dataLeaf;
      if (Number(leaf.intHP) > 0 && leaf.intState !== 0) { this.deathOver(); return; }
      this._askedAt = Date.now();
      this.xt('resPlayerTimed', [this.w.myAvatar.uid]);
      const secs = Math.round((Date.now() - this.deadSince) / 1000);
      if (secs >= 45 && Date.now() - (this._stuckSaid || 0) > 60000) { this._stuckSaid = Date.now(); this.emit('stuckdead', { seconds: secs }); }
    };
    this._respawn = setInterval(ask, 3000);
    this.timers.push(this._respawn);
    setTimeout(ask, 10500);   // the in-game respawn timer is about ten seconds
  }

  // Flight recorder: the last 400 packets both ways, kept in memory and written out only when something goes wrong
  // (engine.js: Skua's quest-progression relog loop). A full SERAPH_PACKET_LOG would be hundreds of MB a day.
  trace(dir, msg) {
    const r = this.recent || (this.recent = []);
    r.push(`${new Date().toISOString().slice(11, 23)} ${dir} ${String(msg).slice(0, 1500)}`);
    if (r.length > 400) r.splice(0, r.length - 400);
  }
  dumpRecent(file, header = '') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${header}\n${(this.recent || []).join('\n')}\n`);
    return file;
  }

  // Who killed this character: the monster that hit it in the last 15 s, with its hit points at that moment.
  isAlive(mon) { return (mon.intHP === undefined || Number(mon.intHP) > 0) && Number(mon.intState) !== 0; }

  // A monster just died. `byMe`: this character hit it in the last 30 s. `others`: other players standing in this cell
  // (our own bots count too), so a kill with nobody else there is a solo kill (hub.bossKilled, the struggle rule).
  monsterUpdated(mon, wasAlive) {
    if (!wasAlive || this.isAlive(mon)) return;
    const hit = this.myHits.get(Number(mon.MonMapID));
    this.emit('monsterDied', {
      name: mon.strMonName, MonMapID: mon.MonMapID, cell: mon.strFrame, hpMax: Number(mon.intHPMax) || 0,
      byMe: !!(hit && Date.now() - hit < 30000), others: this.playersHere().length, map: String(this.w.strMapName || '').toLowerCase(),
    });
    try { this.mapHooks('event', null, { event: 'monDeath', args: Number(mon.MonMapID) }); } catch (e) { /* never break combat */ }
  }

  // Other players in this character's cell right now.
  playersHere() {
    const me = String(this.w.myAvatar.objData.strUsername).toLowerCase();
    const cell = this.w.strFrame;
    return Object.entries(this.w.users || {}).filter(([n, u]) => n !== me && u && u.strFrame === cell).map(([n]) => n);
  }

  killer() {
    const h = this.lastHitBy;
    if (!h || Date.now() - h.at > 15000) return null;
    const mon = this.w.monsters.find((x) => Number(x.MonMapID) === h.id);
    if (!mon) return null;
    return { name: mon.strMonName, MonMapID: mon.MonMapID, cell: mon.strFrame || this.w.strFrame, level: Number(mon.intLevel) || 0, hp: Number(mon.intHP) || 0, hpMax: Number(mon.intHPMax) || 0 };
  }

  stopRespawn() { if (this._respawn) { clearInterval(this._respawn); this._respawn = null; } }
  // Alive again (or logging out): the bot closes its own record of this death - a Skua script never calls handleDeath.
  deathOver() {
    this.stopRespawn();
    if (!this.deadSince) return;
    this.deadSince = 0;
    this.emit('deathover');
  }

  // ---------------- the surface the bots use ----------------
  // get('world.myAvatar.dataLeaf.intHP') and friends. Async like the Flash bridge was, because callers
  // do `client.get(...).catch(...)`; read() is the synchronous version for use inside this class.
  async get(p) { return this.read(p); }

  read(p) {
    const root = {
      world: this.w,
      sfc: { isConnected: !!(this.sock && !this.sock.destroyed), myUserId: this.w.myAvatar.uid, myUserName: this.w.myAvatar.objData.strUsername },
      mcExtSWF: { numChildren: 0 },
      ui: { mcPopup: {}, ModalStack: {} },
    };
    let cur = root;
    for (const part of String(p).split('.')) {
      if (cur === null || cur === undefined) return null;
      cur = cur[part];
    }
    return cur === undefined ? null : cur;
  }

  fn(p, ...a) { return this.call('callGameFunction', p, ...a); }
  async send(packet) { this.write(packet); return true; }   // a promise, like the Flash client: callers do send(...).catch(...)

  // Everything bot.js asks the Flash bridge for, done over the socket instead.
  async call(fn, ...args) {
    switch (fn) {
      case 'getGameObject': case 'getGameObjectS': return this.read(args[0]);
      case 'setGameObject': return true;
      case 'isNull': return this.read(args[0]) === null;
      case 'callGameFunction': return this.gameFunction(args[0], args.slice(1));
      case 'getMonsters': return this.w.monsters.map((m) => ({ ...m }));
      case 'attackMonsterName': return this.attack(args[0]);
      case 'attackMonsterId': return this.attack(null, Number(args[0]));
      case 'useSkill': return this.useSkill(Number(args[0]) || 0);
      case 'jumpCorrectRoom': return this.jump(args[0], args[1]);
      case 'canUseSkill': return this.canUseSkill(Number(args[0]) || 0);
      case 'getSubjectAuras': return this.aurasOf(args[0]);
      case 'GetAurasValue': {
        const a = this.aurasOf(args[0]).find((x) => String(x.nam).toLowerCase() === String(args[1]).toLowerCase());
        return a ? Number(a.val !== undefined ? a.val : (a.stack || 1)) : 0;
      }
      case 'skipCutscenes': return true;                       // nothing renders, so nothing to skip
      case 'buyItemByName': return this.buyByName(args[0], args[1], args[2]);
      // A disconnect Seraph asked for (reset relog, server hop, seat relog): hub.reconnect logs straight back in. Any
      // other drop on the owner's own account may be him logging in (hub.ownerDropWait).
      case 'sfc.disconnect': this._plannedDropAt = Date.now(); this.disconnect(); return true;
      case 'login': case 'connectToServer': return true;       // handled by start()
      case 'gotoAndPlay': return true;
      default: throw new Error(`no headless equivalent for '${fn}'`);
    }
  }

  gameFunction(name, a) {
    const room = this.w.curRoom;
    switch (name) {
      case 'sfc.sendString': this.write(a[0]); return true;
      case 'world.acceptQuest': this.xt('acceptQuest', [a[0]], room); this.accepted.add(Number(a[0])); return true;
      case 'world.isQuestInProgress': return this.accepted.has(Number(a[0]));
      case 'world.getMapItem': this.xt('getMapItem', [a[0]], room); return true;
      case 'world.getQuestValue': return this.questValue(Number(a[0]));
      case 'world.getAchievement': return this.achievement(a[0], Number(a[1]));
      case 'world.cancelTarget': this.w.myAvatar.target = null; return true;
      case 'world.cancelAutoAttack': return true;
      case 'world.partyInvite': this.xt('gp', ['pi', a[0]], 1); return true;
      case 'world.partyLeave': this.xt('gp', ['pl'], 1); return true;
      case 'world.rest': this.xt('restRequest', [''], 1); return true;
      case 'world.approachTarget': return true;                 // no avatar to walk: the server only checks the cell
      case 'world.sendLoadShopRequest': this.xt('loadShop', [a[0]], room); return true;
      case 'world.sendLoadHairShopRequest': this.xt('loadHairShop', [a[0]], room); return true;
      // The real client adds the hair shop's id (World.sendChangeColorRequest); without it the server ignores the change,
      // which is why no barber visit ever stuck on the laptop (2026-09-24).
      case 'world.sendChangeColorRequest': this.xt('changeColor', [...a.slice(0, 4), (this.w.hairshopinfo && this.w.hairshopinfo.HairShopID) || 1], room); return true;
      case 'world.sendChangeArmorColorRequest': this.xt('changeArmorColor', a, room); return true;
      case 'ui.mcPopup.fClose': case 'ui.ModalStack.removeChildren': return true;
      default: throw new Error(`no headless equivalent for game function '${name}'`);
    }
  }

  // Quest progress is packed into strQuests/strQuests2/... one base-36 digit per quest slot.
  questValue(slot) {
    const bank = Math.floor(slot / 100);
    const field = bank > 0 ? `strQuests${bank + 1}` : 'strQuests';
    const s = this.w.myAvatar.objData[field];
    if (typeof s !== 'string') return -1;
    return parseInt(s.charAt(slot - bank * 100), 36) || 0;
  }
  setQuestValue(slot, value) {
    const bank = Math.floor(slot / 100);
    const field = bank > 0 ? `strQuests${bank + 1}` : 'strQuests';
    let s = typeof this.w.myAvatar.objData[field] === 'string' ? this.w.myAvatar.objData[field] : '';
    const i = slot - bank * 100;
    while (s.length <= i) s += '0';
    this.w.myAvatar.objData[field] = s.slice(0, i) + Number(value).toString(36) + s.slice(i + 1);
  }

  achievement(field, index) {
    if (index < 0 || index > 31) return -1;
    const v = this.w.myAvatar.objData[field];
    if (v === undefined || v === null) return -1;
    return (Number(v) & Math.pow(2, index)) === 0 ? 0 : 1;
  }

  aliveIn(cell, name) {
    const want = String(name || '*').toLowerCase();
    return this.w.monsters.filter((m) => m.strFrame === cell && (m.intHP === undefined || m.intHP > 0) && m.intState !== 0
      && (want === '*' || String(m.strMonName).toLowerCase().includes(want)));
  }

  attack(name, mapId) {
    const here = this.aliveIn(this.w.strFrame, mapId ? '*' : name);
    const mon = mapId ? here.find((m) => m.MonMapID === mapId) : here.sort((a, b) => (a.intHP || 0) - (b.intHP || 0))[0];
    if (!mon) { if (!mapId) manners.recheck(this, name); return false; }   // waiting outside a boss's cell
    // Public-room manners (lib/manners.js): a boss nobody is fighting yet is left alone.
    if (!manners.check(this, mon).ok) { if (this.w.myAvatar.target === mon) this.w.myAvatar.target = null; return false; }
    this.w.myAvatar.target = mon;
    const fresh = this._aggro && this._aggro.id === mon.MonMapID && Date.now() - this._aggro.t < 4000;
    if (!fresh && this.ready(250)) {
      this._lastAction = Date.now();
      this._aggro = { id: mon.MonMapID, t: Date.now() };
      // Provoke (Skua/Grimlite): pull every live monster in the cell at once when farming - the game's own
      // aggroMon takes a list. Bosses and helping stay single-target.
      // Only pull what this character out-levels; a support class pulling a whole cell of equals just dies.
      const lvl = Number(this.w.myAvatar.objData.intLevel || 1);
      const ids = this.provoke && manners.mayPull(this) ? here.filter((m) => m === mon || Number(m.intLevel || 0) <= lvl).map((m) => m.MonMapID) : [mon.MonMapID];
      this.xt('aggroMon', ids.length ? ids : [mon.MonMapID], this.w.curRoom);
    }
    return true;
  }

  // The game's own timing (World.as): class skills share a 1.5 s global cooldown, both it and each skill's
  // cooldown shrink with haste, and auto attack runs on its own timer. Sending faster than that is what
  // makes the server answer "Please slow down. Last action was too soon!".
  ready(minGapMs = 250) { return Date.now() - (this._lastAction || 0) >= minGapMs; }
  hasteCoeff() {
    const sta = this.w.myAvatar.dataLeaf.sta || {};
    const tha = Number(sta.$tha || 0);
    return 1 - Math.min(Math.max(tha, -1), 0.5);
  }
  gcdReady() { return Date.now() - (this._lastSkill || 0) >= Math.round(1500 * this.hasteCoeff()) + 60; }

  useSkill(index) {
    const target = this.w.myAvatar.target;
    const skill = (this.w.actions.active || [])[index];
    const selfSkill = skill && (skill.tgt === 's' || skill.tgt === 'f');
    if (!selfSkill && (!target || (target.intHP !== undefined && target.intHP <= 0))) return false;
    if (!selfSkill && !manners.check(this, target).ok) { this.w.myAvatar.target = null; return false; }
    const ref = (skill && skill.ref) || SKILL_REFS[index] || 'aa';
    const auto = ref === 'aa' || (skill && skill.auto);
    const now = Date.now();
    if ((this.cooldowns[ref] || 0) > now || !this.ready()) return false;
    if (!auto && !this.gcdReady()) return false;
    if (skill) {
      if (skill.isOK === false) return false;
      if (skill.mp && Number(this.w.myAvatar.dataLeaf.intMP || 0) < Number(skill.mp)) return false;
      this.cooldowns[ref] = now + Math.round(Number(skill.cd || 2000) * this.hasteCoeff()) + 60;
    }
    this._lastAction = now;
    if (!auto) this._lastSkill = now;
    // Heals and buffs (tgt "s" self / "f" friendly) go to the player, like World.getActionResult builds them;
    // only hostile skills go to the monster. Sending a heal at a monster simply wastes it.
    const tgt = skill && skill.tgt;
    const at = tgt === 's' || tgt === 'f' ? `p:${this.w.myAvatar.uid}` : `m:${target.MonMapID}`;
    this.xt('gar', [++this.actionId, `${ref}>${at}`, 'wvz'], 1);
    return true;
  }

  jump(cell, pad) {
    this.w.strFrame = cell || this.w.strFrame;
    this.w.strPad = pad || 'Spawn';
    this.xt('moveToCell', [this.w.strFrame, this.w.strPad]);
    return true;
  }

  buyByName(shopId, itemName, qty = 1) {
    const shop = this.w.shopinfo;
    if (!shop || !shop.items) return false;
    const it = shop.items.find((x) => String(x.sName).toLowerCase() === String(itemName).toLowerCase());
    if (!it) return false;
    this.xt('buyItem', [it.ItemID, shop.ShopID, it.ShopItemID, qty], this.w.curRoom);
    return true;
  }

  // Do what this map's own code would do now (lib/map-hooks.json): kind 'join' (its load code, and quest-gated timers),
  // 'cell' (a cell's frame script) or 'event' (its eventTrigger for a server message). Each hook only under the
  // conditions the map checks (quest in progress, quest slot value, the pad that killed you). Clicks are left to the
  // scripts (they call GetMapItem themselves). Returns how many map items were asked for.
  mapHooks(kind, cell = null, ev = null) {
    const list = mapHooksFor(this.w.strMapFileName);
    if (!list.length) return 0;
    const model = this.swf && this.swf.w;
    const inProgress = (q) => this.accepted.has(q) || !!(model && typeof model.isQuestInProgress === 'function' && model.isQuestInProgress(q));
    this._hookFired = this._hookFired || new Set();
    let n = 0;
    for (const h of list) {
      if (kind === 'join' && !(h.on === 'join' || h.on === 'timer')) continue;
      if (kind === 'cell' && !(h.on === 'cell' && h.cell && h.cell === cell)) continue;
      if (kind === 'event' && !(h.on === 'event' && h.event && ev && String(h.event).toLowerCase() === String(ev.event).toLowerCase())) continue;
      const gated = !!(h.quest || (h.questValue && h.questValue.op));
      // Unconditional hand-outs only from real load code; a quest-less timer or helper is not run blind.
      if (kind === 'join' && !gated && !/\.(frame1|onAdd|init\w*)$/i.test(String(h.where || ''))) continue;
      if (h.quest && !inProgress(h.quest)) continue;
      if (h.questValue && h.questValue.op && CMP[h.questValue.op] && !CMP[h.questValue.op](Number(this.questValue(h.questValue.slot)), Number(h.questValue.value))) continue;
      if (h.monPad != null && (!ev || Number(ev.monPad) !== Number(h.monPad))) continue;
      if (h.args != null && (!ev || Number(ev.args) !== Number(h.args))) continue;   // which monster / quest the map checks
      const key = `${kind}|${h.mapItem}|${cell || ''}`;
      if (kind !== 'event' && this._hookFired.has(key)) continue;
      this._hookFired.add(key);
      this.xt('getMapItem', [h.mapItem]);
      this.emit('mapNote', `the map's own code gives map item ${h.mapItem} here (${h.where}${h.quest ? `, quest ${h.quest}` : ''}) - asked for it`);
      n++;
    }
    return n;
  }

  // One note per map and event kind: what the map's own code would have done is unknown here.
  noteMapEvent(cmd, data) {
    const map = String(this.w.strMapName || '?');
    this._mapEvents = this._mapEvents || new Set();
    const key = `${map}|${cmd}|${cmd === 'callfct' && data ? data.fctNam : ''}`;
    try { this.mapHooks('event', null, { ...(data && typeof data === 'object' && !Array.isArray(data) ? data : {}), event: MAP_EVENT_NAMES[cmd] || cmd }); } catch (e) { /* notes only */ }
    if (this._mapEvents.has(key)) return;
    this._mapEvents.add(key);
    this.emit('mapEvent', { map, cmd, fct: cmd === 'callfct' && data ? data.fctNam : null, sample: JSON.stringify(data).slice(0, 300) });
  }

  stop() { this.disconnect(); }
  async screenshot() { return null; }   // there is no screen, and the bots do not need one
}

module.exports = { HeadlessClient, SKILL_REFS, LIVE, EXPECT_REPLY, SEND_GAP };
