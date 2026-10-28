// Seraph bot — one instance per account. Primitives on top of the Skua AS3 bridge, a persistent task queue, script
// runner for translated Skua scripts, enhancement + gear sets, and the loop that asks the brain what to do next.
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const crowd = require('./crowd');
const manners = require('./manners');
const { P } = require('./paths');
const { SCALE, sleep, readJson, writeJson, serverDay } = require('./util');
const { Ledger, Holds } = require('./ledger');
const accounts = require('./accounts');
const knowledge = require('./knowledge');
const classplan = require('./classplan');
const { Combat } = require('./combat');
const { translate } = require('./skua/translate');
const skuaEngine = require('./skua/engine');
const skuaEntry = require('./skua/entry');
const scriptfix = require('./scriptfix');
const { InvCat } = require('./skua/swfworld');
const droprates = require('./droprates');
const kits = require('./kits');
// Skua engines share one compile cache (Scripts/Cached-Scripts/<hash>-<name>.dll): two engines compiling the same
// script at once race on the file, and the loser fails with "Could not find file". After every service restart three
// of the four bots start Farmer Joe (which includes StoneCrusher.cs) within seconds; one retry was not always enough
// (3 failed runs on 2026-09-22). Script starts take turns: each waits until the start before it logs "Bot Started"
// (compiling is done by then), fails, or COMPILE_TURN_MS has passed.
const COMPILE_TURN_MS = 90000;
let compileTurn = Promise.resolve();
function takeCompileTurn(eng, maxMs = COMPILE_TURN_MS) {
  const before = compileTurn;
  let open;
  const mine = new Promise((r) => { open = r; });
  compileTurn = mine;
  let timer = null;
  const onLog = (l) => { if (l && l.kind === 'script' && /Bot Started/.test(String(l.msg))) done(); };
  const done = () => { clearTimeout(timer); eng.removeListener('log', onLog); open(); };
  eng.on('log', onLog);
  // Real time, not util.sleep (scaled down in tests): the limit guards against a start that never logs.
  const ready = Promise.race([before, new Promise((r) => setTimeout(r, maxMs))]).then(() => { timer = setTimeout(done, maxMs); });
  return { ready, done };
}
// Maps Skua's Farm.Experience grinds XP on (CoreFarms.IcestormArena): a kill there is script progress.
const XP_MAPS = ['icestormarena', 'icestormunder', 'battlegrounde'];
const JOIN_FAILS_RELOG = 3;   // maps refused in a row before a relog (join)
const CROWD_FULL_REST = 10 * 60000;   // crowded work waits this long when Artix is full (hub.crowdTick ends it early)
const CROWD_ALT_AFTER = crowd.ALT_AFTER_MIN * 60000;   // Artix full this long: the busiest other server will do (0 = never)
// Fights the owner wants to watch: quest -> [name, map] (hub.announceFight sends where to join).
const WATCH_QUESTS = { 9124: ['Malgor', 'manacradle'], 9125: ['The Mainyu', 'manacradle'], 9173: ['Ultra Speaker', 'ultraspeaker'], 8547: ['Ultra Dage', 'ultradage'], 8692: ['Ultra Nulgath', 'ultranulgath'] };
const personas = require('./personas');
const progression = require('./progression');
const stylist = require('./stylist');
const fashion = require('./fashion');
const gear = require('./gear');
const wardrobe = require('./wardrobe');

class Stop extends Error {}

const LEVEL_ROUTES = [
  { below: 10, map: 'oaklore', cell: 'r3', pad: 'Left', monster: 'Bone Berserker', quests: [4007, 6257] },
  { below: 20, map: 'icestormarena', cell: 'r6', pad: 'Left', monster: '*', quests: [] },
  { below: 25, map: 'icestormarena', cell: 'r7', pad: 'Left', monster: '*', quests: [] },
  { below: 30, map: 'icestormarena', cell: 'r10', pad: 'Left', monster: '*', quests: [] },
  { below: 50, map: 'icestormarena', cell: 'r11', pad: 'Left', monster: '*', quests: [] },
  { below: 61, map: 'icestormarena', cell: 'r16', pad: 'Left', monster: '*', quests: [] },
  { below: 75, map: 'battlegrounde', cell: 'r2', pad: 'center', monster: '*', quests: [3991, 3992] },
  { below: 101, map: 'icestormunder', cell: 'r2', pad: 'Top', monster: '*', quests: [] },
];

class Bot extends EventEmitter {
  get serverName() { return (this.client && this.client.headless && this.client.serverName) || this._serverName || null; }
  set serverName(v) { this._serverName = v; }

  constructor(client, account, opts = {}) {
    super();
    this.client = client;
    this.account = account;
    this.id = account.id;
    this.dir = P.account(account.id);
    this.brain = opts.brain || null;
    this.hub = opts.hub || null;          // shared: other bots (party), notifier, reporter
    this.running = false;
    this.stopFlag = false;
    this.paused = false;
    this.current = null;
    this.queue = [];
    this.settings = { pickup: 'smart', server: null, privateRoom: null, combatMode: 'Base', role: account.role || 'solo', maxEventHours: 2, minEventLevel: 25, giveUpDeaths: 3 };
    this.stats = { kills: 0, quests: 0, drops: 0, deaths: 0, relogins: 0, levelUps: 0, goldStart: null, expSamples: [], started: Date.now(), sessionStart: Date.now() };
    this.dropsSeen = new Map();
    this.dropBlocked = new Map();   // ItemID -> when to try it again (the server refused the pickup; see dropHeld)
    this.registered = new Set();
    this.lastLog = [];
    this.lastProgress = Date.now();
    this.combat = new Combat({ get: (p) => client.get(p), call: (f, ...a) => client.call(f, ...a) });
    // The AC wallet lock (skua/swfworld.js acLocked) refused a purchase: journal it, and tell the owner once a day per item.
    if (client && typeof client.on === 'function') client.on('acRefused', (x) => this.acRefused(x));
    this.load();
    // Work resting from the brain, the watchdog or the crowd rule (bot.skipped), kept in the ledger across restarts.
    this.ledger = Ledger.forBot(this);
    this.skipped = new Holds(this.ledger);
    if (this.brain) { try { this.ledger.migrate(this.brain.state(this)); } catch (e) { /* no brain.json yet */ } }
    this.combat.engine = this.settings.combatEngine || 'auto';
    this.persona = personas.get(account.persona);
    const applied = this.persona ? `${this.persona.id}@${this.persona.version || 1}` : null;
    if (this.persona && this.settings.personaApplied !== applied) {
      const t = personas.tuning(this.persona);
      Object.assign(this.settings, { giveUpDeaths: t.giveUpDeaths, minEventLevel: t.minEventLevel, maxEventHours: t.maxEventHours, pickup: 'smart', personaApplied: applied });
      this.save();
    }
    this.onEvent = (ev) => this.handlePacket(ev);
    client.on('event', this.onEvent);
    // A Skua script runs its own fights and never calls handleDeath, so the client itself says when a character
    // has been lying dead too long. Logging back in is the one cure that always works.
    // The client knows how long it has really been down; a death clock left over from an earlier death made the
    // journal say "still dead 2985s" (check-up 2026-09-21).
    client.on('stuckdead', ({ seconds }) => {
      this.deadSince = Date.now() - seconds * 1000;
      this.reviveStuck().catch(() => null);
    });
    // Every death the client sees is counted, also the ones inside a Skua script: stats.deaths only counted deaths in
    // Seraph's own tasks, so the dashboard said 0 while the party lay dead at the Shadows of War bosses (2026-09-21).
    client.on('died', () => { this.countDeath().catch(() => null); });
    client.on('deathover', () => { this.deadSince = 0; this._deathCounted = false; });
    client.on('mapNote', (text) => this.journal(text));   // map code the headless client stands in for
    client.on('mailNote', (text) => this.journal(text));   // AQW 5.0 mailbox: claimed / refused letters
    // Skua scripts never enhance on the owner's account, nor in an ultra raid (skua/swfworld.js VSfc.blocked; 2026-10-18):
    // Seraph's kits put the right pieces on, and v3's per-boss presets re-forged pieces that belong to other classes.
    client.blockScriptEnhance = () => this.isGuest() || !!(this.current && (this.current.raid || this.current.crewScript));
    client.on('scriptEnhanceBlocked', (pkt) => {
      if (this._enhBlockSaid && Date.now() - this._enhBlockSaid < 600000) return;
      this._enhBlockSaid = Date.now();
      this.journal(`blocked an enhance request from the Skua script (${this.isGuest() ? 'your account' : 'ultra raid'}): ${String(pkt).slice(0, 80)}`);
    });
  }

  // ---------------- persistence ----------------
  file(name) { return path.join(this.dir, name); }
  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    const d = readJson(this.file('queue.json'), {});
    this.queue = d.queue || [];
    Object.assign(this.settings, d.settings || {});
    // A stopped order is put back in the queue and saved while it is still `current` (run loop, Stop): queue it once.
    // Each service restart used to add one more copy (Valen's Elysium order sat twice in the queue, 2026-10-09).
    // Same order = same work, whenever it started: startedAt changes on every restart, so two copies of Valen's Elysium
    // order with different start times both survived (2026-10-10).
    const same = (a, b) => a && b && Bot.orderKey(a) === Bot.orderKey(b);
    if (d.current && !d.current.brain && !this.queue.some((t) => same(t, d.current))) this.queue.unshift(d.current);
    this.queue = this.queue.filter((t, i, q) => t.brain || q.findIndex((u) => same(u, t)) === i);
    this.sets = readJson(this.file('sets.json'), {});
    this.outfits = readJson(this.file('outfits.json'), {});   // class -> { name, body, names } (lib/wardrobe.js)
    this.kits = readJson(this.file('kits.json'), null);       // { solo: {cls, Weapon, he, ba}, farm: {...} } (lib/kits.js)
    // Pieces the server would not enhance (a fixed old enhancement): never bought for again, never put in a kit.
    this.noEnhance = new Set((readJson(this.file('noenhance.json'), []) || []).map((n) => String(n).toLowerCase()));
  }
  // Structured history (accounts\<id>\history.jsonl) so the character can answer "did you get / do X".
  remember(type, data = {}) {
    try { fs.appendFileSync(this.file('history.jsonl'), JSON.stringify({ t: Date.now(), type, ...data }) + '\n'); } catch { /* disk hiccup */ }
  }
  save() { writeJson(this.file('queue.json'), { queue: this.queue, settings: this.settings, current: this.current }); }
  journal(msg, level = 'info') {
    // Same message again within 10 s: count it instead of flooding the journal.
    const now = Date.now();
    if (this._lastMsg === msg && now - this._lastMsgAt < 10000 * SCALE) { this._repeats = (this._repeats || 0) + 1; return; }
    if (this._repeats) { const n = this._repeats; this._repeats = 0; this._lastMsg = null; this.journal(`(previous line repeated ${n}x)`, 'warn'); }
    this._lastMsg = msg; this._lastMsgAt = now;
    const line = `${new Date().toISOString()} ${msg}`;
    fs.appendFileSync(this.file('journal.log'), line + '\n');
    this.lastLog.push(line);
    if (this.lastLog.length > 300) this.lastLog.shift();
    this.emit('log', { level, msg, line });
  }

  // ---------------- control ----------------
  check() { if (this.stopFlag) throw new Stop('stopped'); }
  async wait(ms) { const end = Date.now() + ms * SCALE; while (Date.now() < end) { this.check(); while (this.paused && !this.stopFlag) await sleep(300); await sleep(Math.min(250, Math.max(0, end - Date.now()))); } }
  async waitFor(cond, ms, step = 250) {
    const end = Date.now() + ms * Math.max(SCALE, 0.05);
    while (Date.now() < end) { this.check(); try { if (await cond()) return true; } catch { /* retry */ } await sleep(step); }
    return false;
  }

  start() { if (this.running || this.account.status === 'pending') return false; this.stopFlag = false; this.stoppedByHand = false; this.loop(); return true; }
  // byHand: the owner (dashboard, API) wants it to stay stopped, so the health check leaves it alone.
  stop(byHand = false) { this.stopFlag = true; if (byHand) this.stoppedByHand = true; }
  // Stop, wait until the loop has really ended (a Skua script can take ~45 s to stop), then start again. The old
  // stop() + start() 3 s later lost that race: start() saw the loop still running and the bot stayed stopped.
  async restart() {
    this.stop();
    for (let i = 0; i < 480 && this.running; i++) await new Promise((r) => setTimeout(r, 250));
    return this.start();
  }
  // Run this task next; the order it interrupts (if any) carries on after it, instead of jumping back in front.
  runNow(task) {
    (this._pushFront = this._pushFront || []).push(task);
    this.save();
    return this.restart();
  }
  takePushFront() { if (this._pushFront && this._pushFront.length) { this.queue.unshift(...this._pushFront); this._pushFront = null; this.save(); } }
  // Skip: stop the current task, and the brain leaves that same task alone for a while (it used to pick it again).
  progressMark() {
    const s = this.stats;
    return { at: Date.now(), items: this.itemProgress || 0, quests: s.quests, drops: s.drops, kills: s.kills, deaths: s.deaths, xp: s.xp || 0 };
  }
  // What a task gained since it started (its _mark), for the ledger.
  gainedSince(mark) {
    const now = this.progressMark();
    const m = mark || now;
    return { minutes: (now.at - m.at) / 60000, items: now.items - m.items, quests: now.quests - m.quests, drops: now.drops - m.drops, kills: now.kills - m.kills, deaths: now.deaths - m.deaths, xp: now.xp - m.xp };
  }
  taskKey(t) { return t ? [t.type, t.path || '', t.entry || '', t.args || '', t.name || '', t.goal || '', t.event || ''].join('|') : ''; }

  // Work the hub hands out (help calls, escorts, crews, armies, raids): it belongs to that call or round, never to the
  // order queue. A stop or the gold rule used to queue it as an order: Sunna's Flibbitiestgibbet seat from the 10-25
  // crew sat in her queue for days behind 3 M gold, and an assist cut short ran again after the call had ended.
  static hubWork(t) {
    return !!(t && (['assist', 'follow', 'armyFarm', 'crewHunt'].includes(t.type) || t.raid || t.crewScript || t.crew || t.army || t.escort));
  }
  // Hub work whose call or round is still on: a helper stopped mid-assist (a reconnect) goes back to its open call -
  // helpTask hands nothing to a character already in the call, so the queue is its only way back.
  hubWorkLive(t) {
    const h = this.hub;
    if (!h || !t) return false;
    if (t.raid) return !!(h.raid && h.raid.id === t.raid);
    if (t.crew || t.crewScript || t.type === 'crewHunt') return !!(h.crew && h.crew.id === t.crew);
    if (t.type === 'assist') return !!(h.helpById && h.helpById(t.id));
    if (t.army || t.type === 'armyFarm') return !!(h.army && h.army.id === t.army);
    if (t.escort) return !!(h.walls && h.walls.isOn && h.walls.isOn(t.escort));
    return false;
  }
  // Put back in the queue after a stop or an error? Orders yes; hub work only while its call is on, and never a crew
  // task (a stopped crew member re-ran a finished army fight, 2026-10-25).
  requeueable(t) {
    if (!Bot.hubWork(t)) return true;
    if (t.crew || t.crewScript || t.type === 'crewHunt') return false;
    return this.hubWorkLive(t);
  }

  // Loop breaker (2026-10-27, after the 10-26 join flood): work that ends within seconds again and again is a loop,
  // whatever causes it - a call handed back to a bot that just left it, a script that exits at once, an order the
  // server refuses. The same work ending within SPIN.quickMs SPIN.count times in SPIN.windowMs is held for
  // SPIN.holdMs (a second loop of it within a day: SPIN.longHoldMs and one Discord alert); a bot ending
  // SPIN.brakeCount quick tasks of any kind in that window waits SPIN.brakeMs before each next one. The flood ran ~1
  // join a second per bot for 47 min (21,000 refusals); in 48 h of journals (8 characters) normal work never ended
  // within 20 s more than 4 times in 10 min, the 6 was the start of that flood.
  static spinKey(t) {
    if (!t) return '';
    if (t.type === 'assist') return ['assist', crowd.baseMap(t.map || ''), String(t.monster || '').toLowerCase(), t.who || ''].join('|');
    if (t.type === 'follow') return ['follow', t.leader || '', t.escort || ''].join('|');
    return [t.type, t.path || '', t.entry || '', t.args || '', t.name || '', t.goal || '', t.event || '', t.item || '', t.monster || '', t.map || ''].join('|');
  }
  spinHeld(t, now = Date.now()) {
    const until = t && this._spinHolds && this._spinHolds.get(Bot.spinKey(t));
    return !!(until && until > now);
  }
  // A hub task (help call, escort) that is held: turned down here, so the next source in loop() gets its turn. A help
  // call is left for good (hub.helpUnreachable), or helpTask would hand it straight back.
  unlooped(t) {
    if (!t || !this.spinHeld(t)) return t;
    if (t.type === 'assist' && this.hub && this.hub.helpUnreachable) this.hub.helpUnreachable(this, t, 'it kept ending within seconds - loop breaker', true);
    return null;
  }
  // A task ended (done, failed or stopped): the SPIN.count-th quick end of the same work holds it. Returns the hold.
  noteTaskEnd(t, now = Date.now()) {
    if (!t || t.type === 'idle') return null;
    const S = Bot.SPIN;
    this._quickAll = (this._quickAll || []).filter((at) => now - at < S.windowMs);
    this._quickEnds = (this._quickEnds || []).filter((e) => now - e.at < S.windowMs);
    if (now - (t.startedAt || now) >= S.quickMs) return null;
    const key = Bot.spinKey(t);
    this._quickAll.push(now);
    this._quickEnds.push({ key, at: now });
    const n = this._quickEnds.filter((e) => e.key === key).length;
    if (n < S.count) return null;
    this._quickEnds = this._quickEnds.filter((e) => e.key !== key);
    const past = ((this._spinPast = this._spinPast || new Map()).get(key) || []).filter((at) => now - at < 24 * 3600000).concat(now);
    this._spinPast.set(key, past);
    const long = past.length > 1;
    const until = now + (long ? S.longHoldMs : S.holdMs);
    (this._spinHolds = this._spinHolds || new Map()).set(key, until);
    const what = String(t.why || t.path || t.type).slice(0, 120);
    const span = long ? `${Math.round(S.longHoldMs / 3600000)} h (its 2nd loop today)` : `${Math.round(S.holdMs / 60000)} min`;
    this.journal(`loop breaker: "${what}" ended within seconds ${n}x in ${Math.round(S.windowMs / 60000)} min - holding it for ${span}`, 'warn');
    // Brain work and orders: the brain's skip list too, so the next pick is other work (bot.isSkipped, nextOrder).
    if (!Bot.hubWork(t)) {
      this.skipped = this.skipped || new Map();
      this.skipped.why = 'loop breaker: it kept ending within seconds';
      this.skipped.set(this.taskKey(t), until);
    }
    if (t.type === 'assist' && this.hub && this.hub.helpUnreachable) this.hub.helpUnreachable(this, t, 'it kept ending within seconds - loop breaker', true);
    if (long && this.hub && this.hub.notify) this.hub.notify(`${this.account.label || this.id}: a loop was stopped twice today`, `"${what}" kept ending within seconds (${n}x in ${Math.round(S.windowMs / 60000)} min) - held for ${span}. The bot carries on with other work; a loop that comes back needs a fix.`, 'alert');
    return { key, until, long };
  }
  // A setting changed for a while (Edda's event time while Mogloween runs, 2026-10-26) used to wait for Claude to
  // put it back. settings.until[key] = { at: <ISO date or ms>, back: <value, or null to remove it> } does it when the
  // time comes (loop(), each task). POST /a/<id>/bot {"op":"settings","settings":{..., "until": {...}}}.
  expireSettings(now = Date.now()) {
    const u = this.settings && this.settings.until;
    if (!u || typeof u !== 'object') return 0;
    let n = 0;
    for (const [k, v] of Object.entries(u)) {
      const at = v && (typeof v.at === 'number' ? v.at : Date.parse(v.at));
      if (!(at <= now)) continue;
      if (v.back === null || v.back === undefined) delete this.settings[k]; else this.settings[k] = v.back;
      delete u[k];
      n++;
      this.journal(`setting ${k} back to ${JSON.stringify(v.back)} (changed until ${new Date(at).toISOString().slice(0, 10)})`);
    }
    if (!Object.keys(u).length) delete this.settings.until;
    if (n) this.save();
    return n;
  }
  // Quick ends of any kind piling up: the loop waits before the next task (loop()).
  spinBraking(now = Date.now()) {
    return (this._quickAll || []).filter((at) => now - at < Bot.SPIN.windowMs).length >= Bot.SPIN.brakeCount;
  }

  // The ladder's last step (hub.goPublic): the party lost to this task's boss today, so it runs in a public room
  // (crowd.kindOf -> 'crowd') until the mark runs out.
  stampPublic(task) {
    const key = this.taskKey(task);
    const until = this.publicFor && this.publicFor.get(key);
    if (until > Date.now()) task.publicStep = true;
    else if (until) this.publicFor.delete(key);
    return !!task.publicStep;
  }
  isSkipped(t) {
    const until = this.skipped && this.skipped.get(this.taskKey(t));
    if (until && until > Date.now()) return true;
    // Waiting for gold (brain.done, the owner's gold rule): skipped until the bot holds what the script wanted.
    return !!(t && !t.goldOk && this.brain && this.brain.goldShort && this.brain.goldShort(this, t));
  }
  async skip(minutes = 60) {
    if (this.current && this.current.type !== 'idle') {
      this.skipped = this.skipped || new Map();
      this.skipped.why = `skipped by hand for ${minutes} min`;
      this.skipped.set(this.taskKey(this.current), Date.now() + minutes * 60000);
      this.journal(`skipping ${this.current.why || this.current.type} for ${minutes} min (asked)`);
      this._dropCurrent = true;   // a skipped order is not put back in the queue
    }
    return this.restart();
  }

  // ---------------- game reads ----------------
  async g(p, dflt = null) { try { const v = await this.client.get(p); return v === undefined || v === null ? dflt : v; } catch { return dflt; } }
  async isNull(p) { try { return (await this.client.call('isNull', p)) === true; } catch { return true; } }
  async connected() { return (await this.g('sfc.isConnected', false)) === true; }
  async playing() { return (await this.connected()) && (await this.g('world.myAvatar.dataLeaf.intHP', null)) !== null; }
  async level() {
    const real = Number(await this.g('world.myAvatar.dataLeaf.intLevel', 0)) || 0;
    return real > 0 ? real : this.g('world.myAvatar.objData.intLevel', 0);
  }
  async gold() { return this.g('world.myAvatar.objData.intGold', 0); }
  // Gold without a round trip (the headless world); Infinity where it can't be read, so nothing waits on it.
  goldNow() {
    const o = this.client && this.client.w && this.client.w.myAvatar && this.client.w.myAvatar.objData;
    return o && o.intGold != null ? Number(o.intGold) || 0 : Infinity;
  }
  async hp() { return this.g('world.myAvatar.dataLeaf.intHP', 0); }
  async hpMax() { return this.g('world.myAvatar.dataLeaf.intHPMax', 1); }
  async map() { return String(await this.g('world.strMapName', '')).toLowerCase(); }
  async cell() { return this.g('world.strFrame', ''); }
  async room() { return this.g('world.curRoom', 1); }
  async name() { return this.g('world.myAvatar.objData.strUsername', ''); }
  async className() { return this.g('world.myAvatar.objData.strClassName', ''); }
  async items() { return (await this.g('world.myAvatar.items', [])) || []; }
  async tempItems() { return (await this.g('world.myAvatar.tempitems', [])) || []; }
  async count(name) {
    const n = String(name).toLowerCase();
    let total = 0;
    for (const it of [...await this.items(), ...await this.tempItems()]) if (it.sName && it.sName.toLowerCase() === n) total += Number(it.iQty || 0);
    return total;
  }
  // The same name in the bank (the Skua model's bank, filled from api/char/bank): the server refuses a drop the
  // character already owns there just like one in the backpack. Only the backpack was counted, so Nova asked for
  // Escherion's Chain and ArchFiend's Vampragon (both banked) again every 30 min (the owner, 2026-10-09).
  bankedCount(name) {
    const n = String(name).toLowerCase();
    let total = 0;
    for (const it of this.modelBank()) if (it.sName && it.sName.toLowerCase() === n) total += Number(it.iQty || 1);
    return total;
  }
  async countId(id) {
    let total = 0;
    for (const it of [...await this.items(), ...await this.tempItems()]) if (Number(it.ItemID) === Number(id)) total += Number(it.iQty || 0);
    return total;
  }
  // Owned anywhere: backpack, temp items or the bank (bank list cached, refreshed at most every 30 min).
  async owns(name) {
    if ((await this.count(name)) > 0) return true;
    const n = String(name).toLowerCase();
    return (await this.bankItems()).some((i) => String(i.sName).toLowerCase() === n);
  }
  async bankItems(maxAgeMs = 30 * 60000) {
    if (this._bank && Date.now() - this._bank.t < maxAgeMs) return this._bank.items;
    let items = [];
    try {
      if (!(await this.playing())) return (this._bank && this._bank.items) || [];
      const asked = Date.now();
      // The whole bank comes over HTTP, as the game loads it (Game.getBank -> api/char/bank, cat "all"); the loadBank
      // socket packet answers with some categories only - no classes, armor or capes (check-up 2026-10-05).
      const game = this.client.swf && this.client.swf.game;
      if (game && typeof game.getBank === 'function') {
        game.getBank();
        const w = this.client.swf.w;
        if (await this.waitFor(async () => Number(w.bankinfo.loadedAt || 0) >= asked, 15000, 300)) {
          items = this.modelBank();
          this._bank = { t: Date.now(), items };
          return items;
        }
      }
      await this.client.send(`%xt%zm%loadBank%${await this.room()}%All%`);
      // Wait for the reply itself: bankinfo.items starts as [] so "is it a list" was true at once, and an empty bank
      // was cached for 30 min (check-up 2026-10-05: banked ArchPaladin never counted as owned).
      await this.waitFor(async () => Number(await this.g('world.bankinfo.loadedAt', 0)) >= asked, 8000, 300);
      items = (await this.g('world.bankinfo.items', [])) || [];
      // The headless world's copy stayed empty while the Skua model's bank held everything (check-up 2026-10-05):
      // ArchPaladin rank 10 sat in three banks for days, "not owned", and every class check missed it.
      if (!items.length) items = this.modelBank();
    } catch (e) { if (e instanceof Stop) throw e; }
    // An empty answer is kept for a minute only: a bank that didn't load is not an empty bank.
    this._bank = { t: items.length ? Date.now() : Date.now() - maxAgeMs + 60000, items };
    return items;
  }
  // Boost items (the owner 2026-10-06: "use the daily boosts they get"). Daily logins hand out XP, Class, Rep and Gold
  // boosts (20 min / 1 h); the banking chore put them in the bank and nothing ever used one (4 of each per character,
  // stack size 9999). At the start of a work task each kind that is not running is used: gold and reputation come with
  // almost any work, XP only below level 100 and class points only while the class is below rank 10 (or ranking).
  // A boost in the bank is taken out first. Using one: serverUseItem (ScriptBoost.UseBoost); the time left comes back
  // as objData iBoostXP/iBoostCP/iBoostRep/iBoostG seconds.
  async useBoosts(task) {
    if (!task || Bot.BOOST_SKIP.has(task.type)) return 0;
    const lvl = await this.level().catch(() => 0);
    const isBoost = (i) => i && String(i.sType) === 'ServerUse' && Number(i.iQty) > 0 && Bot.BOOSTS.some((k) => k.name.test(String(i.sName)));
    const inv = (await this.items()).filter(isBoost);
    const bank = ((await this.bankItems().catch(() => [])) || []).filter(isBoost).map((i) => ({ ...i, inBank: true }));
    if (!inv.length && !bank.length) return 0;
    const obj = (this.client.swf && this.client.swf.w && this.client.swf.w.myAvatar && this.client.swf.w.myAvatar.objData) || {};
    const rank = this.hub && this.hub.constructor && this.hub.constructor.classRank ? this.hub.constructor.classRank(this) : null;
    const wants = { xp: lvl > 0 && lvl < 100, cp: !!task.rankClass || (rank !== null && rank < 10), rep: true, gold: true };
    let used = 0;
    for (const k of Bot.BOOSTS) {
      if (!wants[k.kind] || Number(obj[k.left]) > 0) continue;
      // The backpack first, then the bank; the bigger stack of each (the 1 h ones are rarer and stay for later).
      const pick = (list) => list.filter((i) => k.name.test(String(i.sName))).sort((a, b) => Number(b.iQty) - Number(a.iQty))[0];
      let it = pick(inv) || pick(bank);
      if (!it) continue;
      if (it.inBank) {
        if (!(await this.unbank(it.sName))) continue;
        it = (await this.items()).find((i) => i.ItemID === it.ItemID) || it;
      }
      const before = Number(it.iQty);   // the inventory object itself changes when the server answers
      await this.client.send(`%xt%zm%serverUseItem%${await this.room()}%+%${it.ItemID}%`);
      const ok = await this.waitFor(async () => !(await this.items()).some((i) => i.ItemID === it.ItemID && Number(i.iQty) >= before), 5000, 300);
      if (ok) { used++; this.journal(`used ${it.sName} for "${String(task.why || task.type).slice(0, 60)}"`); }
      await this.wait(400);
    }
    return used;
  }
  static get BOOST_SKIP() { return new Set(['bankAc', 'sellJunk', 'tidy', 'enhance', 'style', 'barber', 'equip', 'gear', 'set', 'wait', 'idle', 'probeEvent', 'buy', 'shop']); }
  static get BOOSTS() {
    return [
      { kind: 'xp', name: /\bXP Boost|Experience Boost/i, left: 'iBoostXP' },
      { kind: 'cp', name: /Class Boost/i, left: 'iBoostCP' },
      { kind: 'rep', name: /\bRep(utation)? Boost/i, left: 'iBoostRep' },
      { kind: 'gold', name: /Gold Boost/i, left: 'iBoostG' },
    ];
  }

  // Reputation points per faction name. Factions only reach the Skua model (loadFactions / addFaction), never the
  // headless world, so the world's own list is always empty (check-up 2026-10-05).
  reps() {
    try {
      const me = this.client.swf && this.client.swf.w && this.client.swf.w.myAvatar;
      return Object.fromEntries(((me && me.factions) || []).map((f) => [String(f.sName), Number(f.iRep) || 0]));
    } catch { return {}; }
  }
  // True once the Skua model holds the whole bank for this login (game.getBank over HTTP; every login starts a new,
  // empty world). Asks for it when it is missing and waits up to `ms`. Not headless: the real game loads its own bank.
  async bankReady(ms = 12000) {
    const swf = this.client && this.client.headless && this.client.swf;
    const game = swf && swf.game;
    if (!game || !game.world || typeof game.getBank !== 'function') return true;
    const bi = game.world.bankinfo;
    if (bi.loadedAt) return true;
    const t0 = Date.now();
    if (game.getBank() !== true) return false;   // no token yet: nothing to wait for
    const ok = await this.waitFor(async () => !!bi.loadedAt || (bi.failedAt >= t0) || swf.game !== game, ms, 200);
    if (!bi.loadedAt) this.journal(`the bank did not load in ${Math.round((Date.now() - t0) / 1000)} s - the script may not see banked items`, 'warn');
    return ok && !!bi.loadedAt;
  }
  modelBank() {
    try { const w = this.client.swf && this.client.swf.w; const b = w && w.bankinfo; return b ? (b.items || []).map((i) => ({ ...i })) : []; } catch { return []; }
  }
  // Out of the bank into the backpack (a class to equip, gear to wear). True when it is in the backpack after.
  async unbank(name) {
    const n = String(name).toLowerCase();
    if ((await this.items()).some((i) => String(i.sName).toLowerCase() === n)) return true;
    const it = (await this.bankItems()).find((i) => String(i.sName).toLowerCase() === n);
    if (!it || (await this.freeSlots()) <= 0) return false;
    await this.client.send(`%xt%zm%bankToInv%${await this.room()}%${it.ItemID}%${it.CharItemID}%`);
    const ok = await this.waitFor(async () => (await this.items()).some((i) => String(i.sName).toLowerCase() === n), 5000, 300);
    if (ok && this._bank) this._bank.items = this._bank.items.filter((i) => i.CharItemID !== it.CharItemID);
    if (ok) this.journal(`took ${it.sName} out of the bank`);
    return !!ok;
  }
  // Free slots in one inventory pool. AQW 5.0 (2026-10-10, Game4000 InvCat) split the backpack: classes take no slot,
  // materials (Item, Note, Quest Item, Resource) have their own "misc" cap (loadInventoryBig.iMiscSlots, 100), and only
  // the rest - gear - counts against iBagSlots. Skua 1.4.5.0's Inventory.FreeSlots and CoreBots' 20-free-slot check
  // count the bag alone now.
  async freeSlots(pool = 'bag') {
    const items = (await this.items()).filter((i) => i && !i.bTemp);
    if (pool === 'misc') return this.miscSlots() - items.filter(InvCat.isMisc).length;
    const slots = await this.g('world.myAvatar.objData.iBagSlots', 0);
    return slots - items.filter(InvCat.isBag).length;
  }
  miscSlots() {
    const w = this.client && this.client.swf && this.client.swf.w;
    return w && Number.isFinite(Number(w.miscSlots)) ? Number(w.miscSlots) : 100;
  }

  // ---------------- packets ----------------
  handlePacket(ev) {
    if (ev.kind !== 'pext') return;
    let o;
    try { o = JSON.parse(ev.data); o = o.params ? o.params.dataObj : o; } catch { return; }
    if (Array.isArray(o)) {
      if (o[0] === 'warning' && /not available|locked until event|house item/i.test(o.join(' '))) this.lastUnavailable = { t: Date.now(), text: o.slice(2).join(' ') };
      if (o[0] === 'warning' && /destination room is full/i.test(o.join(' '))) this.lastRoomFull = { t: Date.now() };
      if (o[0] === 'warning' && this.hub && this.hub.friendWatch) this.hub.friendWatch.onWarning(o.slice(2).join(' '));
      if (o[0] === 'server' && this.hub && this.hub.boosts) this.hub.boosts.noteServerMessage(o.slice(2).join(' '));
      return;
    }
    if (!o) return;
    switch (o.cmd) {
      case 'pi': this.onPartyInvite(o); break;
      case 'addLoadout': case 'removeLoadout': this.loadoutReply = o; break;
      case 'loadPrefs':
        this.serverLoadouts = (o.result && o.result.loadouts) || this.serverLoadouts || null;
        if (!this._prefsSaid) { this._prefsSaid = true; this.journal(`outfits on the server: ${Object.keys((o.result && o.result.loadouts) || {}).join(', ') || 'none'}`); }
        break;
      case 'dropItem':
        for (const [id, it] of Object.entries(o.items || {})) {
          this.dropsSeen.set(Number(id), { name: it.sName, qty: it.iQty, ac: !!it.bCoins, upg: Number(it.bUpg) === 1 || it.bUpg === true, stk: Number(it.iStk) || 0, t: Date.now(),
            pool: InvCat.poolOf(it) });   // which inventory pool it lands in (AQW 5.0)
          (this.dropNames = this.dropNames || new Map()).set(Number(id), { name: it.sName, ac: !!it.bCoins });
          this.farmGot(it.sName);
        }
        break;
      case 'addItems':   // temp quest items and rewards come this way, not as drops
        for (const [id, it] of Object.entries(o.items || {})) { this.farmGot((it && it.sName) || this.itemNameOf(id)); this.stackWatch(id, it); }
        break;
      case 'addGoldExp':
        if (o.typ === 'm') { this.stats.kills++; this.lastProgress = Date.now(); this.farmKill(o.id); }
        if (Number(o.intExp) > 0) { this.stats.xp = (this.stats.xp || 0) + Number(o.intExp); if (this.ledger) this.ledger.addXp(Number(o.intExp)); }   // XP per task and per day (ledger, lib/eta.js)
        break;
      case 'ccqr': if (o.bSuccess === 1) {
        this.stats.quests++; this.lastProgress = Date.now();
        const q = knowledge.quest(o.QuestID);
        this.remember('quest', { id: Number(o.QuestID), name: (q && q.Name) || o.sName || null });
      } break;
      case 'getDrop': {
        const seen = this.dropNames && this.dropNames.get(Number(o.ItemID));
        const name = o.sName || (seen && seen.name) || `item ${o.ItemID}`;
        if (o.bSuccess === 1) {
          this.stats.drops++;
          this.remember('drop', { item: name, qty: Number(o.iQty || 1), ac: !!(seen && seen.ac) });
          this.emit('drop', { name, qty: o.iQty });
        } else this.dropFull(o.ItemID, name, { refused: true, stk: this.dropStk && this.dropStk.get(Number(o.ItemID)) });   // refused: full stack or already owned
        break;
      }
      case 'friends': case 'loadFriendsList': case 'updateFriend': case 'addFriend':
        if (this.hub && this.hub.friendWatch) this.hub.friendWatch.onPacket(this, o);
        break;
      case 'updateGuild': if (this.hub && typeof this.hub.ownerGuild === 'function') this.hub.ownerGuild(o, this); break;
      case 'requestFriend': if (this.hub && this.hub.friendWatch) this.hub.friendWatch.onRequest(this, o.unm); break;
      case 'levelUp': this.remember('level', { level: o.intLevel }); if (this.ledger) this.ledger.levelCost(Number(o.intLevel), Number(o.intExpToLevel)); this.stats.levelUps++; this.stats.expSamples = []; this.emit('levelUp', { level: o.intLevel }); this.journal(`LEVEL UP -> ${o.intLevel}${this.persona ? ` - ${fashion.say(this.persona, 'levelUp') || ''}` : ''}`); break;
      default:
    }
  }

  // In-game party invite: accept only from another Seraph bot in the level-together party, then close the popup.
  async onPartyInvite(o) {
    const owner = String(o.owner || '').toLowerCase();
    const hub = this.hub;
    if (!hub || !hub.levelPartyBots) return;
    const ours = [];
    for (const b of hub.levelPartyBots()) if (b !== this) ours.push(String(await b.name().catch(() => '')).toLowerCase());
    if (!owner || !ours.includes(owner)) { this.journal(`ignored party invite from ${o.owner}`); return; }
    await this.client.send(`%xt%zm%gp%1%pa%${o.pid}%`).catch(() => null);
    await sleep(500);
    await this.client.fn('ui.ModalStack.removeChildren').catch(() => null);
    this.journal(`joined ${o.owner}'s party`);
  }

  // ---------------- login ----------------
  async login() {
    const { user, pass } = accounts.credentials(this.account);
    this.journal(`login as ${user}`);
    // The headless client logs in while connecting, so there is no Flash login screen to drive.
    if (this.client.headless) {
      await this.waitFor(() => this.client.state.loaded, 120000, 500);
      if (!this.client.state.loaded) throw new Error('the game did not finish loading this character');
      this.serverName = this.client.serverName || null;
      if (this.stats.goldStart === null) this.stats.goldStart = await this.gold();
      this.journal(`in game: ${await this.name()} lvl ${await this.level()} ${await this.className()}${this.serverName ? ` on ${this.serverName}` : ''}`);
      return true;
    }
    await this.waitFor(() => this.client.state.loaded, 60000, 500);
    if (await this.connected()) { try { await this.client.fn('sfc.disconnect'); } catch { /* */ } await this.wait(2000); }
    try { await this.client.fn('gotoAndPlay', 'Login'); } catch { /* */ }
    await this.wait(2500);
    await this.client.fn('login', user, pass);
    let obj = null;
    await this.waitFor(async () => {
      const s = await this.client.call('getGameObjectS', 'objLogin');
      obj = typeof s === 'string' ? JSON.parse(s) : s;
      return obj && ((obj.servers && obj.servers.length) || obj.bSuccess === 0);
    }, 30000, 1000);
    if (!obj || obj.bSuccess !== 1) throw new Error('login failed: ' + (obj && obj.sMsg));
    this.servers = obj.servers.filter((x) => x.bOnline === 1).map((x) => ({ name: x.sName, count: x.iCount, max: x.iMax, member: !!x.bUpg }));
    const servers = obj.servers.filter((s) => s.bOnline === 1 && s.bUpg === 0 && Number(s.iMax) % 2 === 0 && s.iCount < s.iMax * 0.85 && !s.iLevel);
    const want = this.settings.server || (this.hub && this.hub.partyServer && this.hub.partyServer(this));
    const server = (want && servers.find((s) => s.sName === want)) || servers.sort((a, b) => a.iCount / a.iMax - b.iCount / b.iMax)[0];
    this.journal(`connecting to ${server.sName} (${server.iCount}/${server.iMax})`);
    this.serverName = server.sName;
    await this.client.call('connectToServer', JSON.stringify(server));
    if (!(await this.waitFor(() => this.playing(), 60000, 1000))) throw new Error('connect timed out');
    await this.wait(3000);
    if (this.stats.goldStart === null) this.stats.goldStart = await this.gold();
    this.journal(`in game: ${await this.name()} lvl ${await this.level()} ${await this.className()} on ${server.sName}`);
    this.emit('online');
  }

  async ensureLogin() {
    if (await this.playing()) return;
    this.stats.relogins++;
    for (let i = 1; ; i++) {
      this.check();
      try { await this.login(); return; } catch (e) {
        if (e instanceof Stop) throw e;
        const backoff = Math.min(300000, 15000 * i);
        this.journal(`login attempt ${i} failed (${e.message}); retry in ${backoff / 1000}s`, 'warn');
        if (i === 3) this.emit('alert', { title: 'Login failing', body: e.message });
        await this.wait(backoff);
      }
    }
  }

  // ---------------- movement ----------------
  roomNumber(map = null) {
    if (this.settings.privateRoom) return this.settings.privateRoom;
    if (this._taskRoom) return this._taskRoom;          // army job or a goal shared with another bot
    if (this.hub && this.hub.partyRoom) { const r = this.hub.partyRoom(this); if (r) return r; }
    // Normal, low room numbers on purpose: other players show up there, help with bosses and share kills.
    // A private high room is only used when someone asks for it (settings.privateRoom).
    // Ultras are never fought in a public lobby (the owner 2026-09-27): the party's private room even outside the party.
    if ((crowd.isPrivate(this.current) || (map && crowd.privateMap(map))) && this.hub && this.hub.settings && this.hub.settings.levelParty) return this.hub.settings.levelParty.room;
    if (!this._room) this._room = 1 + Math.floor(Math.random() * 6);
    return this._room;
  }

  // Crowded content (lib/crowd.js) goes to a normal public room: joining a map with no room number lets the server
  // put the character where the players already are. A private room only when one is set, or a task shares a room.
  publicRoom(map) {
    if (this.settings.privateRoom || this._taskRoom || (this.current && this.current.raid)) return false;
    if (this.hub && this.hub.settings && this.hub.settings.crowd === false) return false;
    if (crowd.privateMap(map) || crowd.isPrivate(this.current)) return false;
    // Dailies and other crowded tasks (the owner 2026-09-27) go public on every map they visit, not only the listed ones.
    // The ladder (2026-10-09): a crowded map alone no longer means a public room - only a task at the public step.
    if (crowd.LADDER) return crowd.kindOf(this.current) === 'crowd';
    return crowd.crowdedMap(map) || crowd.kindOf(this.current) === 'crowd';
  }

  async join(map, cell = 'Enter', pad = 'Spawn') {
    const base = String(map).split('-')[0].toLowerCase();
    const pub = !map.includes('-') && this.publicRoom(base);
    const wantRoom = map.includes('-') || pub ? null : (this.settings.privateRoom || (this.hub && this.hub.partyRoom ? this.hub.partyRoom(this) : null));
    const area = String(await this.g('world.strAreaName', ''));
    const wrongRoom = wantRoom && (await this.map()) === base && area && area.toLowerCase() !== `${base}-${wantRoom}`;
    if (wrongRoom) this.journal(`moving to the party room ${base}-${wantRoom}`);
    if ((await this.map()) !== base || wrongRoom) {
      const target0 = map.includes('-') ? map : pub ? base : `${base}-${this.roomNumber(base)}`;
      this.lastUnavailable = null;
      this.lastRoomFull = null;
      for (let tries = 0; tries < 4 && ((await this.map()) !== base || (wrongRoom && tries === 0)); tries++) {
        this.check();
        if (tries === 0) await this.leaveCombat(); else await this.unstick(tries);
        // A plain public join the server ignored twice (mountdoomskull, arcangrove on 2026-09-27): name a normal room.
        const target = pub && tries >= 2 ? `${base}-${1 + Math.floor(Math.random() * 9)}` : target0;
        await this.client.send(`%xt%zm%cmd%${await this.room()}%tfer%${await this.name()}%${target}%${cell}%${pad}%`);
        const refused = () => (this.lastUnavailable && Date.now() - this.lastUnavailable.t < 8000) || (this.lastRoomFull && Date.now() - this.lastRoomFull.t < 8000);
        await this.waitFor(async () => (await this.map()) === base || refused(), 20000, 500);
        if (this.lastUnavailable && Date.now() - this.lastUnavailable.t < 20000) throw new Error(`map ${base} unavailable: ${this.lastUnavailable.text}`);
        // A full room is an answer, not a stall: no retries, no relog (10-26: chaosrealm-13579 refused 55 joins, each
        // one 80 s of tries, and three in a row logged the character out). A numbered room only - a plain public join
        // lets the server pick a room with space.
        if (this.lastRoomFull && Date.now() - this.lastRoomFull.t < 20000 && target.includes('-')) {
          if (this.hub && this.hub.roomFull) this.hub.roomFull(this, base, target);
          const e = new Error(`could not join ${base}: room ${target} is full`);
          e.code = 'ROOM_FULL';
          throw e;
        }
        await this.wait(1500);
      }
      if ((await this.map()) !== base) {
        // Three maps in a row refused: whatever the server thinks of this character, a fresh login clears it.
        this._joinFails = (this._joinFails || 0) + 1;
        if (this.client.headless && this._joinFails >= JOIN_FAILS_RELOG) {
          this._joinFails = 0;
          this.journal(`could not join a map ${JOIN_FAILS_RELOG} times in a row - logging back in`, 'warn');
          this.client.scriptDriven = false;
          await Promise.resolve(this.client.call('sfc.disconnect')).catch(() => null);
          await this.wait(5000);   // hub.reconnect stops this loop and logs in again
        }
        throw new Error(`could not join ${base}`);
      }
      this._joinFails = 0;
      this.journal(`joined ${base}`);
    }
    if (cell && cell !== 'Enter') await this.jump(cell, pad);
  }

  // A join the server ignored. The usual reason is combat: tfer is refused while monsters still have us, and they keep
  // us for as long as we stand in their cell (Valen, 2026-09-26: 43 min at stalagbite after a finished hunt). Drop the
  // target and step to Enter even when the model says "not in combat", then wait for it to clear. After the second
  // refusal, check that the server still answers at all; a dead connection is dropped so the hub logs in again.
  async unstick(tries) {
    await this.client.fn('world.cancelTarget').catch(() => null);
    await this.client.call('jumpCorrectRoom', 'Enter', 'Spawn', true, false).catch(() => null);
    await this.waitFor(async () => !(await this.inCombat()), 8000, 400);
    if (tries === 2 && this.client.alive && !(await this.client.alive())) {
      this.journal('the server stopped answering - reconnecting', 'warn');
      this.client.scriptDriven = false;
      await Promise.resolve(this.client.call('sfc.disconnect')).catch(() => null);
      await this.wait(5000);
    }
  }

  // The server silently ignores a map change while you are in combat (monsters keep hitting you after a hunt).
  // Stepping back to the map entrance drops the aggro; then wait for the combat state to clear.
  async inCombat() { return Number(await this.g('world.myAvatar.dataLeaf.intState', 1)) === 2; }
  async leaveCombat() {
    if (!(await this.inCombat())) return;
    await this.jump('Enter', 'Spawn').catch(() => null);
    await this.waitFor(async () => !(await this.inCombat()), 12000, 400);
  }

  async jump(cell, pad = 'Left') {
    if ((await this.cell()) === cell) return;
    // Waiting outside a boss's cell in a public room (lib/manners.js rule 4): the jump would be held back anyway.
    if (this.client.headless && manners.blocksCell(this.client, cell)) return;
    await this.client.call('jumpCorrectRoom', cell, pad || 'Left', true, false);
    await this.waitFor(async () => (await this.cell()) === cell, 8000, 250);
    await this.wait(400);
  }

  // Cells that currently hold a living monster with this name (or any, for '*').
  async cellsWith(monster) {
    const list = (await this.client.call('getMonsters').catch(() => [])) || [];
    const want = String(monster || '*').toLowerCase();
    const cells = [];
    for (const m of list) {
      if (!m || !m.strFrame) continue;
      if (want !== '*' && !String(m.strMonName || '').toLowerCase().includes(want)) continue;
      if (!cells.includes(m.strFrame)) cells.push(m.strFrame);
    }
    return cells;
  }

  // ---------------- combat ----------------
  async rest() {
    const hp = await this.hp();
    if (hp <= 0 || hp / (await this.hpMax()) > 0.6) return;   // dead: respawn is handled by handleDeath
    try { await this.client.fn('world.cancelTarget'); } catch { /* */ }
    try { await this.client.fn('world.rest'); } catch { /* */ }
    await this.waitFor(async () => (await this.hp()) / (await this.hpMax()) > 0.95, 20000, 700);
  }

  // One death, counted once, whoever notices it first: the headless client (every death, also inside Skua scripts)
  // or handleDeath (Seraph's own tasks, and the desktop client).
  async countDeath() {
    if (this._deathCounted) return;
    this._deathCounted = true;
    if (!this.deadSince) this.deadSince = Date.now();
    this.stats.deaths++;
    const map = await this.map().catch(() => null);
    this.remember('death', { map, cell: await this.cell().catch(() => null) });
    if (this.persona) { const line = fashion.say(this.persona, 'death'); if (line) this.journal(line); }
    this.deathTimes = (this.deathTimes || []).filter((t) => Date.now() - t < 600000).concat(Date.now());
    if (this.deathTimes.length === 5) this.emit('alert', { title: 'Dying a lot', body: `5 deaths in 10 min at ${map}` });
    // Killed by a boss again? the owner gets a Discord DM with the room to join (hub.bossDeath).
    const killer = this.client && this.client.killer ? this.client.killer() : null;
    // The Skua script fights the boss its own way first (scriptOwnsFight): no class ladder, restart, death cap or rest.
    if (killer && this.scriptOwnsFight(killer)) return;
    // Other classes and rotations first (hub.fightLadder, lib/fightplan.js): while the ladder has steps left it owns
    // this death - no party call, death cap or DM yet.
    if (killer && this.hub && this.hub.fightLadder) {
      try { if (await this.hub.fightLadder(this, killer)) return; } catch (e) { this.journal(`class ladder: ${e.message}`, 'warn'); }
    }
    if (killer && this.hub && this.hub.bossDeath) this.hub.bossDeath(this, killer).catch(() => null);
    // The same monster again and again inside one script: set the task aside (hub.deathCap).
    if (killer && this.hub && this.hub.deathCap) { try { this.hub.deathCap(this, killer); } catch { /* */ } }
  }

  // A Skua script fighting a boss owns the fight, deaths included (the owner 2026-10-28: "if it doesnt work then they
  // wouldnt make a script for it"). Scripts carry the boss's own answer - Voice in the Sea: ArchPaladin + Vigil on the
  // charge line; Nightmare Carnax: Dragon of Time + laser zones - and Seraph's class ladder threw that away after 3
  // deaths (AI, KE, LR, VHL, CAV forced over the script's ArchPaladin), restarted the script and rested the order.
  // Seraph steps in only after OWN_FIGHT_MS against the same boss with nothing gained; a gain restarts the clock.
  scriptOwnsFight(killer, now = Date.now()) {
    const t = this.current;
    if (!t || t.type !== 'script' || t.raid || t.escort || t.style || t.crewScript || this.assisting) return false;
    if (this.settings.scriptOwnsFights === false || !killer || !killer.name) return false;
    const key = `${this.taskKey(t)}|${String(killer.name).toLowerCase()}`;
    const items = this.itemProgress || 0;
    const f = this._ownFight;
    if (!f || f.key !== key) {
      this._ownFight = { key, since: now, items, deaths: 1 };
      this.journal(`died to ${killer.name} - the script fights it its own way; Seraph steps in after ${Math.round(Bot.OWN_FIGHT_MS / 60000)} min with nothing gained`);
      return true;
    }
    f.deaths++;
    if (items > f.items) { f.items = items; f.since = now; f.said = false; }
    if (now - f.since < Bot.OWN_FIGHT_MS) return true;
    if (!f.said) { f.said = true; this.journal(`the script's own way lost to ${killer.name} for ${Math.round(Bot.OWN_FIGHT_MS / 60000)} min with nothing gained (${f.deaths} deaths) - class ladder and party help take over`, 'warn'); }
    return false;
  }

  async handleDeath(where) {
    if ((await this.hp()) > 0) { this.deadSince = 0; this._deathCounted = false; return false; }
    // Same rule as the client: before the server has sent any hit points (initUserData says 0 for everyone), a
    // character is still loading. Counting that as a death gave every login a "death" and a persona death line.
    if (this.client.headless && !this.client.sawHp && Number(await this.g('world.myAvatar.dataLeaf.intState', 1)) !== 0) { await this.wait(1000); return false; }
    // One death is one death. While HP stays at 0 this used to count again on every tick, which inflated the
    // death count, tripped "died 3x - avoiding this spot" over and over and left the character looping there
    // (Oren at oaklore r3, 2026-09-20).
    await this.countDeath();
    await this.waitFor(async () => (await this.hp()) > 0, 25000, 500);
    if ((await this.hp()) <= 0) { await this.reviveStuck(); return true; }
    this.deadSince = 0;
    this._deathCounted = false;
    await this.wait(1500);
    if (where && where.cell) await this.jump(where.cell, where.pad);
    return true;
  }

  // Dead, and the server never brought us back. Drop the connection: the hub logs the character in again and a
  // fresh login always comes back alive. Once every five minutes at most, so this can never become a relog loop.
  async reviveStuck() {
    const waited = Math.round((Date.now() - (this.deadSince || Date.now())) / 1000);
    if (waited < 60 || Date.now() - (this.lastReviveRelog || 0) < 300000) return;
    this.lastReviveRelog = Date.now();
    this.deadSince = 0;
    this.journal(`still dead ${waited}s after asking to respawn - logging back in`, 'warn');
    this.emit('alert', { title: 'Stuck dead', body: `no respawn after ${waited}s at ${await this.map()} - relogging` });
    if (this.client.headless) { this.client.scriptDriven = false; await this.client.call('sfc.disconnect').catch(() => null); }
    else await this.client.fn('sfc.disconnect').catch(() => null);
    await this.wait(5000);
  }

  // Drop policy (the owner, 2026-09-10 / 2026-09-17): every AC-tagged drop is accepted, even trash - AC items can live in
  // the bank for free. If the backpack is full, AC items the character doesn't use are banked to make room.
  // Nothing is ever declined; non-AC drops follow the pickup setting (smart = everything except known junk).
  async pickupDrops(extraWanted = []) {
    if (!this.dropsSeen.size) return;
    const room = await this.room();
    const junk = knowledge.junk();
    const want = this.settings.pickup;
    const freeIn = {};   // free slots per inventory pool (bag / misc), counted once and then kept up to date
    let member = null;
    for (const [id, d] of [...this.dropsSeen]) {
      this.dropsSeen.delete(id);
      const name = String(d.name || '');
      const lower = name.toLowerCase();
      let take;
      if (d.ac) take = true;
      else if (Array.isArray(want)) take = want.some((w) => w.toLowerCase() === lower);
      else if (want === 'all') take = true;
      else take = !junk.has(lower);
      if (extraWanted.some((w) => String(w).toLowerCase() === lower)) take = true;
      // The owner 2026-10-07 ("how did the bots end up with member only items"): a free account cannot equip member gear,
      // so a non-AC member drop (Titan's Blood, Axe of Ruin...) only took a slot - 43-45 of them filled each bank.
      // AC member drops are still taken (the bank keeps AC for free), and so is anything the running script asks for.
      if (take && d.upg && !d.ac && !extraWanted.some((w) => String(w).toLowerCase() === lower)) {
        if (member === null) member = Number(await this.g('world.myAvatar.objData.iUpgDays', -1)) >= 0;
        if (!member) take = false;
      }
      if (!take) continue;
      if (this.dropHeld(id)) continue;
      // A class never needs a slot; a house item has its own inventory the server checks.
      const pool = d.pool === 'misc' ? 'misc' : d.pool === 'class' || d.pool === 'house' ? null : 'bag';
      if (pool && freeIn[pool] === undefined) freeIn[pool] = await this.freeSlots(pool);
      if (d.stk) (this.dropStk = this.dropStk || new Map()).set(Number(id), d.stk);
      const have = await this.count(name);
      if (d.stk && have + this.bankedCount(name) >= d.stk) { this.dropFull(id, name, { stk: d.stk }); continue; }   // owned already (bag or bank), or the stack is at its cap
      const stacks = have > 0;
      if (pool && freeIn[pool] <= 0 && !stacks) {
        // A non-AC piece of gear nobody asked for is not worth a bank trip: the daily tidy would sell it anyway.
        // Assist fights at Taro dropped 15-20 of them in a row and each one cost a banking attempt (2026-10-08).
        if (!d.ac && d.stk <= 1 && !extraWanted.some((w) => String(w).toLowerCase() === lower)) continue;
        await this.bankAc(d.ac ? 1 : 0, 1, pool).catch(() => 0);
        // Count the pool again instead of trusting bankAc's tally: mid-fight the server confirms a bank move after
        // more than 5 s, so bankAc reported 0 while the slot was already free, and Fiend Seals and the rest of
        // a Taro drop pile were left on the ground with 7-14 empty slots (Valen, Sable, 2026-10-08).
        freeIn[pool] = await this.freeSlots(pool);
        if (freeIn[pool] <= 0) {
          d.tries = (d.tries || 0) + 1;
          if (d.tries === 1) this.journal(`${pool === 'misc' ? 'misc inventory' : 'backpack'} full - could not make room for ${name}${d.ac ? ' (AC)' : ''}`, 'warn');
          if (d.ac && d.tries < 20) this.dropsSeen.set(id, d);   // keep trying while the drop is still claimable
          continue;
        }
      }
      await this.client.send(`%xt%zm%getDrop%${room}%${id}%`);
      if (pool && !stacks) freeIn[pool]--;
      if (d.ac) { this.emit('rareDrop', { name, ac: true }); if (this.persona) this.journal(`${fashion.say(this.persona, 'drop', name) || this.persona.name} (${name})`); }
      this.noticeLook(name);
      await sleep(250);
    }
  }

  // The server refuses a pickup ("Item could not be added to your inventory", Game.as) when the stack is at its cap
  // or the item is already owned. Asking again after every kill is what gave Nova 560 refused pickups an hour on
  // 2026-09-20, and each refusal counts towards the server's "Please slow down" limit, so a refused item is left
  // alone for half an hour - one refusal instead of hundreds.
  dropHeld(id) {
    const until = this.dropBlocked.get(Number(id));
    if (!until) return false;
    if (Date.now() < until) return true;
    this.dropBlocked.delete(Number(id));
    return false;
  }

  // Known before asking (bag + bank count, `refused` false): nothing to say, the character simply has it. A one-of item
  // (stack 1) stays owned, so it is left alone for the day; a full stack of materials may be used up, so 30 min.
  // Only a refusal we did not see coming goes in the journal, once per item per day (2026-09-27, 2026-10-09).
  dropFull(id, name, { refused = false, stk = 0 } = {}) {
    const again = this.dropHeld(id);
    const oneOf = Number(stk) === 1;
    this.dropBlocked.set(Number(id), Date.now() + (oneOf ? 24 * 3600000 : 30 * 60000));
    if (!refused) return;
    const key = `${serverDay()}|${id}`;
    this._fullSaid = this._fullSaid || new Set();
    if (!again && !this._fullSaid.has(key)) { this._fullSaid.add(key); this.journal(`the server would not give me ${name} (I already own it or the stack is full) - ${oneOf ? 'not asking again today' : 'asking again in 30 min'}`); }
  }

  // Names this character keeps in its backpack: saved gear sets, classes on its path or role lists, style favourites,
  // items a registered quest needs.
  keepNames({ style = true } = {}) {
    const keep = new Set();
    for (const n of Object.values(this.lookNow || {})) keep.add(String(n).toLowerCase());          // the look on show stays on hand
    for (const o of Object.values(this.outfits || {})) for (const n of o.names || []) keep.add(String(n).toLowerCase());
    for (const set of Object.values(this.sets || {})) for (const n of Object.values(set)) keep.add(String(n).toLowerCase());
    for (const n of kits.names(this.kits)) keep.add(n);   // CoreBots wears them with the Solo / Farm class
    const p = this.persona;
    if (p) {
      for (const list of Object.values(p.roles)) for (const c of list) keep.add(c.toLowerCase());
      for (const id of p.path) { const g = progression.GOALS[id]; if (g && g.have) keep.add(g.have.toLowerCase()); }
      keep.add(p.ultraClass.toLowerCase());
    }
    for (const list of Object.values(Bot.ROLE_CLASSES)) for (const c of list) keep.add(c.toLowerCase());
    for (const n of this.questWanted()) keep.add(String(n).toLowerCase());
    for (const [n, t] of (this.scriptUnbanked || new Map())) if (Date.now() - t < 24 * 3600000) keep.add(n);
    if (style) for (const n of (this.styleKeep || [])) keep.add(String(n).toLowerCase());
    for (const d of [...((p && p.fashion && p.fashion.dream) || []), ...((p && p.fashion && p.fashion.seasonal) || [])]) keep.add(String(d.name).toLowerCase());   // its dream pieces stay on hand
    return keep;
  }

  // ItemIDs in the character's server outfits (loadouts: its own and the ones the owner saved by hand). The owner, 2026-10-17:
  // the main's class outfits (SC, LOO, CAV, VHL, VDK...) lost their pieces to the bank - Seraph banked 87 AC items in
  // one go on 10-15, Exalted Apotheosis and Empowered Hollowborn Caladbolg among them - and he moved them back himself.
  loadoutIds() {
    const w = this.client && this.client.swf && this.client.swf.w;
    const lo = (w && w.objInfo && w.objInfo.customs && w.objInfo.customs.loadouts) || this.serverLoadouts || {};
    const ids = new Set();
    for (const body of Object.values(lo || {})) {
      if (!body || typeof body !== 'object') continue;
      for (const [slot, v] of Object.entries(body)) if (slot !== 'colors' && Number(v) > 0) ids.add(Number(v));
    }
    return ids;
  }
  // Never banked: the keep list, outfit pieces and - on the owner's own account - any enhanced gear (his class gear).
  bankKeepTest() {
    const keep = this.keepNames();
    const ids = this.loadoutIds();
    const guest = this.isGuest();
    return (i) => keep.has(String(i.sName).toLowerCase()) || ids.has(Number(i.ItemID)) || (guest && Number(i.EnhID) > 0);
  }

  // AC items this character won't use (see keepNames). AC items never use up bank space. Classes stay: since AQW 5.0
  // the game refuses to bank a class (AC or not), and a class takes no backpack slot anyway (Game4000 InvCat).
  async bankableAc(pool = null) {
    const kept = this.bankKeepTest();
    return (await this.items()).filter((i) => Number(i.bCoins) && !i.bEquip && !i.bTemp && String(i.sType) !== 'ServerUse' && !InvCat.isClass(i)
      && InvCat.poolOf(i) !== 'house' && (!pool || InvCat.poolOf(i) === pool) && !kept(i))
      .sort((a, b) => (Number(a.EnhID) > 0) - (Number(b.EnhID) > 0));   // plain cosmetics first, enhanced gear last
  }

  // House pool. CoreBots.ToHouseBank skips every item while the house is full (it only banks when Bot.House.FreeSlots
  // > 0), so a full house never empties itself and a script that buys a house item loops on "House full, cannot store
  // this item" - the main's Arcana Invoker tried the Arcangrove Tower House ~5,000 times on 2026-10-17. Seraph banks
  // AC house items that aren't the active house, only until `want` slots are free.
  async bankHouse(want = 2) {
    // House items live only in the skua.swf model (VMyAvatar.houseitems, loadInventoryBig hitems); the headless world
    // doesn't track them. The model also drops a house item on the bankFromInv reply.
    const me = () => (this.client && this.client.swf && this.client.swf.w && this.client.swf.w.myAvatar) || null;
    const house = async () => ((me() && me().houseitems) || []).filter((i) => i && !i.bTemp);
    const slots = Number(me() && me().objData && me().objData.iHouseSlots) || 0;
    if (!slots) return 0;
    const kept = this.bankKeepTest();
    let moved = 0;
    for (const it of (await house()).filter((i) => Number(i.bCoins) && !i.bEquip && String(i.sType) !== 'House' && !kept(i))) {
      if (slots - (await house()).length >= want) break;
      this.check();
      await this.client.send(`%xt%zm%bankFromInv%${await this.room()}%${it.ItemID}%${it.CharItemID}%`);
      const gone = await this.waitFor(async () => !(await house()).some((x) => x.CharItemID === it.CharItemID), 12000, 300);
      if (gone) { moved++; this.remember('banked', { item: it.sName }); this.journal(`banked house item ${it.sName}`); }
      await this.wait(600);
    }
    if (slots - (await house()).length < want) this.journal(`house still full (${(await house()).length}/${slots}) - no AC house item left to bank`, 'warn');
    return moved;
  }

  // A Skua line saying a pool is full (CoreBots BuyItem / _CheckHouseSpace / "make N space(s)"): make the room ourselves
  // instead of letting the script retry forever (the owner, 2026-10-17: "if you ever get stuck into inventory full make
  // sure to send anything that isnt needed to bank"). Once a minute per pool at most.
  makeRoomFor(msg) {
    const s = String(msg || '');
    const pool = /house (inventory )?(is )?full|House full/i.test(s) ? 'house'
      : /(inventory is full|inventory full|make \d+ space|destination inventory is full|Item Inventory full)/i.test(s) ? (/\bmisc\b/i.test(s) ? 'misc' : 'bag') : null;
    if (!pool) return;
    // Skua stops the script itself on this one ("Please clear space and restart the bot."): the loop must not take the
    // clean exit for "done" (fullStopRequeue).
    if (/restart the bot|clear space/i.test(s)) this._fullStopAt = Date.now();
    this._roomAt = this._roomAt || {};
    if (Date.now() - (this._roomAt[pool] || 0) < 60000) return;
    this._roomAt[pool] = Date.now();
    const job = pool === 'house' ? this.bankHouse(2) : this.bankAc(0, pool === 'misc' ? Bot.ROOM.miscTarget : Bot.ROOM.target, pool);
    job.then((n) => { if (n) this.journal(`made room for the script: banked ${n} ${pool} item(s)`); }).catch(() => {});
  }

  // Regular items that can go to the bank: same keep rules, and only as many as the bank's non-AC space still takes
  // (objData.iBankSlots, World.as). Only AC items were ever banked, so Sable filled all 100 slots with quest-reward
  // gear, totems and vouchers while 95 bank slots sat empty, and every Skua script that needs 20 free slots refused to
  // start (2026-09-24). Skua unbanks what a script needs, so gear goes first and stacks of materials last.
  async bankableOther(pool = null) {
    const slots = Number(await this.g('world.myAvatar.objData.iBankSlots', 0)) || 0;
    const room = slots - (await this.bankItems(0)).filter((i) => !Number(i.bCoins)).length;
    if (room <= 0) return [];
    const kept = this.bankKeepTest();
    const late = new Set(['item', 'resource', 'quest item', 'class']);
    return (await this.items())
      .filter((i) => !Number(i.bCoins) && !i.bEquip && !i.bTemp && !i.bHouse && i.sType !== 'Class' && String(i.sType) !== 'ServerUse' && !kept(i))
      .filter((i) => !pool || InvCat.poolOf(i) === pool)
      .sort((a, b) => late.has(String(a.sType).toLowerCase()) - late.has(String(b.sType).toLowerCase()))
      .slice(0, room);
  }

  // Bank up to `max` (0 = all) unused AC items, then regular items until `target` slots are free. With a `pool`
  // ('bag' / 'misc') only that inventory pool is emptied; without one, both: the bag up to `target`, the misc pool up
  // to ROOM.miscTarget (AQW 5.0). Returns how many left the backpack.
  async bankAc(max = 0, target = 0, pool = null) {
    let moved = 0;
    const move = async (it, what) => {
      this.check();
      await this.client.send(`%xt%zm%bankFromInv%${await this.room()}%${it.ItemID}%${it.CharItemID}%`);
      const gone = await this.waitFor(async () => !(await this.items()).some((x) => x.CharItemID === it.CharItemID), 12000, 300);
      if (gone) { moved++; this.remember('banked', { item: it.sName }); this.journal(`banked ${what} ${it.sName}`); if (this._bank) this._bank.items.push(it); }
      await this.wait(600);
    };
    // With a target, AC items only go until their pool has that much room: banking every unused AC item at once took
    // 87 pieces off the main on 10-15 (the owner, 2026-10-17: bank what isn't needed when the inventory is full).
    const goals = target > 0 ? (pool ? [[pool, target]] : [['bag', target], ['misc', Bot.ROOM.miscTarget]]) : [];
    const wants = Object.fromEntries(goals);
    for (const it of await this.bankableAc(pool)) {
      if (max && moved >= max) break;
      const p = InvCat.poolOf(it);
      if (target > 0 && (wants[p] === undefined || (await this.freeSlots(p)) >= wants[p])) continue;
      await move(it, 'AC item');
    }
    if (target > 0) {
      for (const [p, want] of goals) {
        for (const it of await this.bankableOther(p)) {
          if ((max && moved >= max) || (await this.freeSlots(p)) >= want) break;
          await move(it, 'item');
        }
      }
    }
    return moved;
  }

  // Kill `monster` until done() is true, time runs out, or the step keeps failing.
  async hunt(monster, done, where = null, maxMs = 30 * 60000, wanted = []) {
    const end = Date.now() + maxMs * SCALE;
    let errors = 0;
    let idle = 0;
    this.lastProgress = Date.now();
    this.journal(`hunting ${monster} in ${await this.map()}${where && where.cell ? ' ' + where.cell : ''}`);
    const deaths0 = this.stats.deaths;
    // Provoke the whole cell on farming work only; never on bosses, help calls or story fights.
    const farming = this.current && ['farmLevel', 'kill', 'daily', 'armyFarm'].includes(this.current.type);
    if (this.client.headless) this.client.provoke = this.settings.provoke !== false && farming && !(this.noProvokeUntil > Date.now());
    await this.combat.refresh(this.seatMode || this.settings.combatMode);   // a party seat's mode on help calls (takeSeat)
    while (Date.now() < end) {
      this.check();
      while (this.paused && !this.stopFlag) await sleep(300);
      if (!(await this.playing())) return false;
      try {
        if (await done()) return true;
        const died = await this.handleDeath(where);
        if (died && this.client.provoke) {
          // Remembered for 2 h, not just this hunt: every new 10-min band turned it back on, and Oren died ~80 times an
          // hour at icestormarena for a whole day (2026-09-18).
          this.client.provoke = false; this.noProvokeUntil = Date.now() + 2 * 3600000; this.journal('died while pulling the whole cell - one monster at a time for the next 2 h');
        }
        // Counted on every pass, not only when this loop catches 0 HP: the headless client counts the death ('died') and
        // respawns by itself, so the loop often never saw it. Nova died 18x to Shadow Lord on the NCSGem daily with
        // giveUpDeaths 6 and only the watchdog stopped it (2026-10-08).
        // A boss it can't kill solo calls the whole party (hub.struggle, from countDeath -> hub.bossDeath).
        const dead = this.stats.deaths - deaths0;
        // Not on a help call: the call has its own wall rule (hub.bossDeath). Oren quit his own Legion Lich Lord call
        // after 3 deaths on 2026-10-11, in a fight where everyone dies every few seconds and still wins.
        const onCall = this.current && (this.current.type === 'assist' || this.current.type === 'crewHunt');
        if (!onCall && dead > 0 && this.settings.giveUpDeaths !== 0 && dead >= (this.settings.giveUpDeaths || 3) && !(await done())) {
          if (this.hub && this.hub.forgetSolo) try { this.hub.forgetSolo(this, monster); } catch { /* journal only */ }
          throw new Error(`too strong: died ${dead}x hunting ${monster}`);
        }
        if (died) continue;
        if (where && where.cell && (await this.cell()) !== where.cell) await this.jump(where.cell, where.pad);
        if (!where || !where.cell) {
          const here = await this.cell();
          const cells = await this.cellsWith(monster);
          if (cells.length && !cells.includes(here)) await this.jump(cells[0], 'Left');
        }
        if (this.combat.holding()) { await sleep(300); continue; }
        if (await this.isNull('world.myAvatar.target')) {
          const ok = await this.client.call('attackMonsterName', monster).catch(() => false);
          if (ok !== true) {
            // Public-room manners (lib/manners.js): waiting for players to fight a boss is not "no monster here".
            const mw = this.client.mannersWait;
            if (mw && Date.now() - mw.last < 5000) {
              // Nobody came: unless the boss needs a crowd, the client is moving to the party's own room (manners rule 5).
              if (mw.gaveUp && !mw.fallback) throw new Error(`nobody to fight ${mw.boss} with in this public room - leaving it for now`);
              idle = 0; this.lastProgress = Date.now();
              await this.pickupDrops(wanted);
              await sleep(1000);
              continue;
            }
            idle++;
            if (idle === 15) this.journal(`no ${monster} to attack in ${await this.map()} ${await this.cell()} (cells with it: ${(await this.cellsWith(monster)).join(', ') || 'none'})`, 'warn');
            // The monster is listed in this cell but its graphic never loaded (Skua only targets loaded ones):
            // stepping out and back in reloads the cell (seen in cetoleonwar r2, 2026-09-17).
            if (idle % 10 === 0) {
              const here = await this.cell();
              if (here !== 'Enter' && (await this.cellsWith(monster)).includes(here)) {
                await this.jump('Enter', 'Spawn').catch(() => null);
                await this.wait(1500);
                await this.jump(here, (where && where.pad) || 'Left').catch(() => null);
                if (idle === 10) this.journal(`re-entered ${here} to reload its monsters`);
              }
            }
            if (idle % 20 === 0) await this.rest();
            await this.pickupDrops(wanted);
            await this.questTick();
            await sleep(400);
            continue;
          }
        }
        idle = 0;
        if (!(await this.keepInRange())) continue;
        if (!(await this.combat.tick())) await this.client.call('useSkill', 0).catch(() => null);
        await this.pickupDrops(wanted);
        await this.questTick();
        await sleep(200);
        const hpNow = await this.hp();
        if (hpNow > 0 && hpNow / (await this.hpMax()) < 0.2) { await sleep(1500); const h2 = await this.hp(); if (h2 > 0 && h2 / (await this.hpMax()) < 0.2) await this.rest(); }
        // Stuck: no kill or turn-in for 5 minutes -> rejoin the map.
        if (Date.now() - this.lastProgress > 5 * 60000) {
          this.journal('no progress for 5 min - rejoining', 'warn');
          const m = await this.map();
          this._room = null;
          await this.join('whitemap').catch(() => null);
          await this.join(m, where && where.cell, where && where.pad).catch(() => null);
          this.lastProgress = Date.now();
        }
        errors = 0;
      } catch (e) {
        if (e instanceof Stop || /^(too strong|nobody to fight)/.test(e.message)) throw e;
        if (++errors === 1) this.journal(`hunt step error: ${e.message}`, 'warn');
        if (errors > 25) throw e;
        await sleep(1000);
      }
    }
    return done();
  }

  // Range + dead-target keeper. The game only walks to a monster when it is first targeted (world.approachTarget in
  // skua.swf attackTarget); skills cast after the monster moved or we got knocked away fail with "You are out of range!"
  // and the character stands still. Every ~1.5 s: drop a dead target, otherwise walk back into range.
  // Returns false when the target was dropped (caller picks a new one).
  async keepInRange() {
    if (await this.isNull('world.myAvatar.target')) return false;
    const hp = await this.g('world.myAvatar.target.dataLeaf.intHP', null);
    if (hp !== null && Number(hp) <= 0) {
      await this.client.fn('world.cancelTarget').catch(() => null);
      return false;
    }
    if (Date.now() - (this._approachAt || 0) > 1500 * SCALE) {
      this._approachAt = Date.now();
      await this.client.fn('world.approachTarget').catch(() => null);
    }
    return true;
  }

  // ---------------- quests ----------------
  async loadQuests(ids) {
    const missing = [];
    for (const id of ids) if (await this.isNull(`world.questTree.${id}`)) missing.push(id);
    if (!missing.length) return;
    await this.client.send(`%xt%zm%getQuests%${await this.room()}%${missing.join('%')}%`);
    await this.waitFor(async () => { for (const id of missing) if (await this.isNull(`world.questTree.${id}`)) return false; return true; }, 8000, 400);
  }
  async inProgress(id) { try { return (await this.client.fn('world.isQuestInProgress', id)) === true; } catch { return false; } }
  async completedOnce(id) {
    const q = knowledge.quest(id);
    if (!q || q.Slot < 0) return false;
    const v = await this.client.fn('world.getQuestValue', q.Slot).catch(() => 0);
    return Number(v) >= q.Value;
  }
  async unlocked(id) {
    const q = knowledge.quest(id);
    if (!q || q.Slot < 0) return true;
    const v = await this.client.fn('world.getQuestValue', q.Slot).catch(() => 0);
    return Number(v) >= q.Value - 1;
  }
  async dailyDone(id) {
    const q = knowledge.quest(id);
    if (!q || !q.Field) return false;
    const v = await this.client.fn('world.getAchievement', q.Field, q.Index).catch(() => 0);
    return Number(v) > 0;
  }
  async questAvailable(id) {
    const q = knowledge.quest(id);
    if (!q) return true;
    if (q.Upgrade) return false;   // member only
    if ((await this.level()) < (q.Level || 0)) return false;
    if (q.Once && await this.completedOnce(id)) return false;
    if (q.Field && await this.dailyDone(id)) return false;
    // Items needed just to accept (e.g. Pirate Booty I for quest 4514): the game throws if they are missing.
    for (const r of q.AcceptRequirements || []) if ((await this.countId(r.ItemID ?? r.ID)) < Math.max(1, Number(r.iQty || 0))) return false;
    return this.unlocked(id);
  }
  async accept(id) {
    if (await this.inProgress(id)) return true;
    await this.loadQuests([id]);
    await this.client.fn('world.acceptQuest', id);
    return this.waitFor(() => this.inProgress(id), 5000, 300);
  }
  async canComplete(id) {
    if (!(await this.inProgress(id))) return false;
    const tree = await this.g(`world.questTree.${id}.turnin`, null);
    const reqs = tree || (knowledge.quest(id) || {}).Requirements || [];
    for (const r of reqs) if ((await this.countId(r.ItemID ?? r.ID)) < Number(r.iQty ?? r.Quantity ?? 1)) return false;
    return true;
  }
  async complete(id, reward = -1) {
    await this.client.send(`%xt%zm%tryQuestComplete%${await this.room()}%${id}%${reward}%false%1%wvz%`);
    await this.wait(1200);
  }
  // Quest rewards arrive as drops a few seconds after turning in. Chains need them right away
  // (Pirate Booty I unlocks quest 4514), so pick them up and wait until one is in the backpack.
  async collectRewards(id, timeoutMs = 15000) {
    const q = knowledge.quest(id);
    const names = ((q && q.Rewards) || []).map((r) => r.sName || r.Name).filter(Boolean);
    if (!names.length || names.length > 4) { await this.pickupDrops(names); return; }
    const end = Date.now() + timeoutMs * SCALE;
    while (Date.now() < end) {
      await this.pickupDrops(names);
      for (const n of names) if ((await this.count(n)) > 0) return;
      await this.wait(700);
    }
  }
  register(ids) { for (const id of ids) this.registered.add(Number(id)); }
  async questTick() {
    if (!this.registered.size || Date.now() - (this._qt || 0) < 2000 * SCALE) return;
    this._qt = Date.now();
    for (const id of this.registered) {
      if (!(await this.inProgress(id))) { if (await this.questAvailable(id)) await this.accept(id); continue; }
      if (await this.canComplete(id)) { await this.complete(id); if (await this.questAvailable(id)) await this.accept(id); }
    }
  }
  questWanted() {
    const names = [];
    for (const id of this.registered) { const q = knowledge.quest(id); if (q) for (const r of q.Requirements || []) names.push(r.sName || r.Name); }
    return names.filter(Boolean);
  }

  // ---------------- shops / items ----------------
  async loadShop(shopId, map = null) {
    if (map) await this.join(map);
    await this.client.fn('world.sendLoadShopRequest', shopId);
    await this.waitFor(async () => Number(await this.g('world.shopinfo.ShopID', 0)) === Number(shopId), 10000, 400);
    await this.wait(600);
    return (await this.g('world.shopinfo.items', [])) || [];
  }
  // The bots spend no AC (the owner 2026-10-13): the only ACs they get are AQW's free ones.
  acRefused({ name, cost } = {}) {
    const key = `${serverDay()}|${String(name).toLowerCase()}`;
    this._acSaid = this._acSaid || new Set();
    this.journal(`AC lock: did not buy ${name} (${cost} AC) - the bots never spend AC`, 'warn');
    if (this._acSaid.has(key)) return;
    this._acSaid.add(key);
    this.emit('alert', { title: 'AC purchase blocked', body: `Something tried to buy ${name} for ${cost} AC. The AC lock stopped it (the bots never spend AC).` });
  }
  async buy(shopId, itemName, qty = 1, map = null) {
    const items = await this.loadShop(shopId, map);
    const it = items.find((i) => String(i.sName).toLowerCase() === String(itemName).toLowerCase());
    if (!it) { this.journal(`shop ${shopId} has no ${itemName}`, 'warn'); return false; }
    if (it.bUpg) { this.journal(`${itemName} is member-only`, 'warn'); return false; }
    if ((Number(it.bCoins) === 1 || it.bCoins === true) && Number(it.iCost) > 0 && !(this.client.acAllow && this.client.acAllow.has(String(it.sName).toLowerCase()))) {
      this.acRefused({ name: it.sName, cost: it.iCost });
      return false;
    }
    const before = await this.count(itemName);
    await this.client.call('buyItemByName', itemName, qty);
    const ok = await this.waitFor(async () => (await this.count(itemName)) > before, 8000, 500);
    this.journal(`${ok ? 'bought' : 'FAILED to buy'} ${itemName} (shop ${shopId})`);
    if (ok) this.emit('bought', { item: itemName, cost: it.iCost });
    return ok;
  }
  async equip(itemName) {
    const it = (await this.items()).find((i) => i.sName && i.sName.toLowerCase() === itemName.toLowerCase());
    if (!it) return false;
    if (it.bEquip) return true;
    await this.client.send(`%xt%zm%equipItem%${await this.room()}%${it.ItemID}%`);
    await this.waitFor(async () => ((await this.items()).find((i) => i.ItemID === it.ItemID) || {}).bEquip, 5000, 400);
    this.journal(`equipped ${itemName}`);
    return true;
  }
  async sellJunk() {
    const junk = knowledge.junk();
    let sold = 0;
    for (const it of await this.items()) {
      if (it.bEquip || it.bCoins || !junk.has(String(it.sName).toLowerCase())) continue;
      await this.client.send(`%xt%zm%sellItem%${await this.room()}%${it.ItemID}%${it.iQty}%${it.CharItemID}%`);
      sold++;
      await this.wait(800);
    }
    if (sold) this.journal(`sold ${sold} junk item stacks`);
    return sold;
  }

  // ---------------- gear sets ----------------
  async equippedSet() {
    const set = {};
    for (const it of await this.items()) if (it.bEquip) set[it.sES] = it.sName;
    return set;
  }
  async saveSet(name) {
    this.sets[name] = await this.equippedSet();
    writeJson(this.file('sets.json'), this.sets);
    this.journal(`saved gear set "${name}"`);
    return this.sets[name];
  }
  async equipSet(name) {
    const set = this.sets[name];
    if (!set) return false;
    for (const slot of ['ar', 'Weapon', 'he', 'ba', 'pe', 'co', 'am', 'mi']) if (set[slot]) await this.equip(set[slot]);
    this.journal(`wearing set "${name}"`);
    await this.combat.refresh(this.settings.combatMode);
    return true;
  }

  // Is this a map Skua's Farm.Experience grinds XP on? A kill there is progress for the watchdog (runSkua).
  static xpMap(name) { return XP_MAPS.includes(String(name || '').toLowerCase()); }

  // The character's live combat stats from the server's stat packets (dataLeaf.sta, World.as keys): haste $tha (a
  // fraction, capped at 0.5), crit $tcr, dodge $tdo, attack/spell power $ap/$sp. Logged with every ultra attempt so a
  // rotation is judged against real numbers, never "haste unknown" (vault KNOWLEDGE/Combat-Mechanics s1, Research
  // 2026-10-20 item 9). Null when the client keeps no headless world (PC Flash client).
  combatStats() {
    const w = this.client && this.client.w;
    const leaf = w && w.myAvatar && w.myAvatar.dataLeaf;
    const sta = leaf && leaf.sta;
    if (!sta || !Object.keys(sta).length) return null;
    const n = (k) => (sta[k] === undefined || sta[k] === null || Number.isNaN(Number(sta[k])) ? null : Number(sta[k]));
    return { haste: n('$tha'), crit: n('$tcr'), critMult: n('$scm'), dodge: n('$tdo'), ap: n('$ap'), sp: n('$sp') };
  }
  static statsText(s) {
    const pct = (v) => (v === null || v === undefined ? '?' : `${Math.round(v * 1000) / 10}%`);
    const num = (v) => (v === null || v === undefined ? '?' : Math.round(v));
    return `haste ${pct(s.haste)}${s.haste !== null && s.haste >= 0.5 ? ' (cap)' : ''}, crit ${pct(s.crit)}, dodge ${pct(s.dodge)}, AP ${num(s.ap)}, SP ${num(s.sp)}`;
  }
  // Free backpack slots to keep: Skua's Unbank refuses to start a script with fewer than 20 ("make 20 space(s)").
  // Since AQW 5.0 that is the bag pool alone; materials have their own pool (100 slots), kept from filling up too.
  static get ROOM() { return { low: 22, target: 30, miscLow: 10, miscTarget: 20 }; }

  // ---------------- class roles ----------------
  // Best owned class for a job, from strongest to weakest F2P options (community consensus, Skua class scripts).
  static get ROLE_CLASSES() {
    return {
      boss: ['Verus DoomKnight', 'Dragon of Time', 'Void Highlord', 'ArchPaladin', 'Lord of Order', 'Arcana Invoker', 'Legion Revenant', 'StoneCrusher', 'Dragonslayer', 'Horc Evader', 'Ninja', 'Oracle', 'Warrior', 'Healer'],
      support: ['Lord of Order', 'ArchPaladin', 'Legion Revenant', 'Stonecrusher', 'Light Caster', 'Barber', 'Healer'],
      farm: ['Legion Revenant', 'Blaze Binder', 'Arcana Invoker', 'Void Highlord', 'Master Ranger', 'Scarlet Sorceress', 'Chaos Slayer', 'Necromancer', 'Rogue', 'Mage', 'Warrior', 'Healer'],
      solo: ['Verus DoomKnight', 'Dragon of Time', 'ArchPaladin', 'Lord of Order', 'Arcana Invoker', 'Legion Revenant', 'StoneCrusher', 'Scarlet Sorceress', 'Chaos Slayer', 'Void Highlord', 'Master Ranger', 'Healer', 'Warrior', 'Rogue', 'Mage'],
    };
  }
  // Classes (backpack + bank) still below rank 10 = 302,500 class points, which the class item's quantity holds.
  // Skipped: the rank-1-only classes, and member-only classes without membership (Skua's RankUpClass refuses those).
  async unrankedClasses() {
    const member = Number(await this.g('world.myAvatar.objData.iUpgDays', 0)) > 0;
    const bank = await this.bankItems().catch(() => []);
    const seen = new Set();
    const out = [];
    for (const i of [...(await this.items()), ...(bank || [])]) {
      if (!i || i.sType !== 'Class') continue;
      const name = String(i.sName);
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      if (/^(hobo highlord|no class|obsidian no class|classic pirate)$/i.test(name)) continue;   // joke classes: ranking Classic Pirate died 24x at Frost Spirit (2026-10-05)
      if ((Number(i.bUpg) === 1 || i.bUpg === true) && !member) continue;
      if (Number(i.iQty) >= 302500) continue;
      out.push({ name, id: Number(i.ItemID), cp: Number(i.iQty) || 0 });
    }
    return out;
  }
  // Backpack and bank: Skua's own scripts (RankUpClass, Farmer Joe) put a class back in the bank when they finish.
  async ownedClasses() {
    const bank = await this.bankItems().catch(() => []);
    const names = [...(await this.items()), ...(bank || [])].filter((i) => i && (i.sType === 'Class' || i.sES === 'ar')).map((i) => i.sName);
    return [...new Set(names)];
  }
  // Every class this character owns with its class points (backpack and bank), for the party line-up (lib/partycomp.js).
  async classPoints() {
    const bank = await this.bankItems().catch(() => []);
    const cp = new Map();
    for (const i of [...(await this.items()), ...(bank || [])]) {
      if (!i || !(i.sType === 'Class' || i.sES === 'ar')) continue;
      cp.set(i.sName, Math.max(cp.get(i.sName) || 0, Number(i.iQty) || 0));
    }
    return [...cp].map(([name, points]) => ({ name, cp: points }));
  }
  // Wear the class a help call's line-up gave me (hub.partySeat), enhanced for it, and fight in its mode.
  async takeSeat(seat, t) {
    if (String(await this.className()).toLowerCase() !== seat.cls.toLowerCase()) {
      if (!(await this.wearOutfit(seat.cls))) {
        if (!(await this.unbank(seat.cls))) throw new Error('not in my backpack or bank');
        await this.equip(seat.cls);
      }
      await this.wearKitFor(seat.cls).catch(() => 0);   // its own enhanced pieces when it has a kit (lib/kits.js)
      if (await this.needsEnhance()) await this.enhanceEquipped().catch(() => null);
    }
    this.seatMode = seat.mode || null;
    this.journal(`${t.who}'s ${t.monster} party: my seat is ${seat.role === 'support' ? 'support' : 'damage'} - ${seat.cls}${seat.mode ? ` (${seat.mode})` : ''}`);
  }
  async useRole(role) {
    const base = Bot.ROLE_CLASSES[role];
    if (!base) return false;
    const mine = (this.persona && this.persona.roles[role]) || [];
    const owned = (await this.ownedClasses()).map((c) => c.toLowerCase());
    // The character's own route first (classplan), then the persona's picks, then the general list.
    const planned = classplan.classFor(this.id, role, owned);
    const list = [...(planned ? [planned.name] : []), ...mine, ...base.filter((c) => !mine.includes(c))];
    const best = list.find((c) => owned.includes(c.toLowerCase()));
    const current = String(await this.className()).toLowerCase();
    if (!best || best.toLowerCase() === current) return false;
    if (!(await this.wearOutfit(best))) {
      if (!(await this.unbank(best))) return false;
      await this.equip(best);
    }
    this.journal(`switched to ${best} for ${role}`);
    this.settings.combatMode = role === 'farm' ? 'Farm' : 'Solo';
    // The class's kit before any enhancing: enhancing first would re-enhance the other class's pieces for this one.
    await this.wearKitFor(best).catch(() => 0);
    if (await this.needsEnhance()) await this.enhanceEquipped();
    await this.saveSet(role);
    return true;
  }

  // ---------------- wardrobe: looks, outfits, selling (lib/wardrobe.js, the owner 2026-10-07) ----------------
  // Every name a quest requires (to accept or to turn in): never sold.
  static questNeeds() {
    if (!Bot._questNeeds) {
      const s = new Set();
      for (const q of knowledge.quests().values()) for (const r of [...(q.Requirements || []), ...(q.AcceptRequirements || [])]) s.add(String(r.sName || r.Name || '').toLowerCase());
      s.delete('');
      Bot._questNeeds = s;
    }
    return Bot._questNeeds;
  }
  // Every item a Skua script names in a `case "..."` label (merge shops list the ingredients they farm that way): kept
  // too, so a merge ingredient is never sold (the dry run on 2026-10-07 had Primal Dread Fang, Staff of Inversion...).
  // Read once per process, file by file, so the laptop's event loop never stalls on the 3,000 scripts.
  static async scriptNames() {
    if (Bot._scriptNames) return Bot._scriptNames;
    const out = new Set();
    const walk = async (dir) => {
      let list = [];
      try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const d of list) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) { if (!/^(\.git|Cached-Scripts)$/.test(d.name)) await walk(p); continue; }
        if (!d.name.endsWith('.cs')) continue;
        const src = await fs.promises.readFile(p, 'utf8').catch(() => '');
        for (const m of src.matchAll(/case\s+"([^"]+)"\s*:/g)) out.add(m[1].toLowerCase());
      }
    };
    await walk(P.SCRIPTS);
    Bot._scriptNames = out;
    return out;
  }
  // One of the owner's own accounts (accounts kind 'guest'): orders only, its looks and gear are his.
  isGuest() { return !!(this.account && this.account.kind === 'guest'); }
  async isMember() { return Number(await this.g('world.myAvatar.objData.iUpgDays', -1)) >= 0; }
  // The looks this character shows, what it keeps and what it sells (nothing is changed here).
  async wardrobePlan() {
    const items = await this.items();
    const bank = (await this.bankItems(0).catch(() => [])) || [];
    const member = await this.isMember();
    const owned = [...items, ...bank];
    const looks = this.persona ? wardrobe.looks(this.persona, owned, member) : [];
    const keep = this.keepNames({ style: false });
    for (const l of looks) for (const n of Object.values(l)) keep.add(String(n).toLowerCase());
    for (const d of (this.persona && this.persona.fashion && this.persona.fashion.later) || []) keep.add(String(d.name).toLowerCase());   // extra looks: never sold
    for (const n of wardrobe.boostKeep(owned, member)) keep.add(n);
    const needs = new Set([...Bot.questNeeds(), ...(await Bot.scriptNames().catch(() => new Set()))]);
    const sell = wardrobe.sellPlan({ items, bank, keep, questNeeds: needs, member });
    return { looks, sell, member };
  }
  async sellOne(it) {
    const cur = (await this.items()).find((i) => Number(i.CharItemID) === Number(it.CharItemID));
    if (!cur || cur.bEquip || Number(cur.bWear) === 1) return false;
    await this.client.send(`%xt%zm%sellItem%${await this.room()}%${cur.ItemID}%${Number(cur.iQty) || 1}%${cur.CharItemID}%`);
    const gone = await this.waitFor(async () => !(await this.items()).some((i) => Number(i.CharItemID) === Number(it.CharItemID)), 5000, 300);
    if (gone) { this.journal(`sold ${cur.sName} (${it.why})`); this.remember('sold', { item: cur.sName, why: it.why }); }
    await this.wait(700);
    return !!gone;
  }
  // Sell what nobody keeps (backpack first, which makes room to bring bank pieces out and sell them too), then bank
  // the AC items and regular pieces the character doesn't need. dry = only write the plan (accounts/<id>/wardrobe.json).
  async tidyWardrobe({ dry = false } = {}) {
    if (this.isGuest()) { this.journal('wardrobe tidy: not on your own account - nothing sold'); return { sold: 0, banked: 0, skipped: 'guest' }; }
    const plan = await this.wardrobePlan();
    writeJson(this.file('wardrobe.json'), { at: new Date().toISOString(), member: plan.member, looks: plan.looks, sell: plan.sell });
    if (dry) return { looks: plan.looks, sell: plan.sell.length, list: plan.sell };
    let sold = 0;
    for (const it of plan.sell.filter((x) => x.where === 'backpack')) { this.check(); if (await this.sellOne(it)) sold++; }
    for (const it of plan.sell.filter((x) => x.where === 'bank')) {
      this.check();
      if ((await this.freeSlots()) <= 0) break;
      await this.client.send(`%xt%zm%bankToInv%${await this.room()}%${it.ItemID}%${it.CharItemID}%`);
      if (!(await this.waitFor(async () => (await this.items()).some((i) => Number(i.CharItemID) === Number(it.CharItemID)), 5000, 300))) continue;
      if (this._bank) this._bank.items = this._bank.items.filter((i) => Number(i.CharItemID) !== Number(it.CharItemID));
      if (await this.sellOne(it)) sold++;
    }
    this._bank = null;
    const banked = await this.bankAc(0, Bot.ROOM.target).catch(() => 0);
    this.journal(`wardrobe: sold ${sold} of ${plan.sell.length} pieces nobody wears, banked ${banked}, ${await this.freeSlots()} backpack slots free`);
    this.remember('wardrobe', { sold, banked, planned: plan.sell.length });
    return { sold, banked };
  }

  // The look on show (AQW "Show": the look over the equipped boost gear). Girls rotate their looks daily.
  async showLook() {
    if (!this.persona || this.isGuest()) return 0;
    const items = await this.items();
    const member = await this.isMember();
    const looks = wardrobe.looks(this.persona, [...items, ...((await this.bankItems().catch(() => [])) || [])], member);
    if (!looks.length) return 0;
    const look = wardrobe.pickLook(looks, this.persona);
    this.lookNow = look;
    let shown = 0;
    for (const slot of wardrobe.SHOW) {
      this.check();
      const name = look[slot];
      if (!name) continue;
      const n = name.toLowerCase();
      let it = (await this.items()).find((i) => String(i.sName).toLowerCase() === n && i.sES === slot);
      if (!it) { if (!(await this.unbank(name))) continue; it = (await this.items()).find((i) => String(i.sName).toLowerCase() === n && i.sES === slot); }
      if (!it || Number(it.bWear) === 1) continue;
      await this.client.send(`%xt%zm%wearItem%${await this.room()}%${it.ItemID}%`);
      if (await this.waitFor(async () => Number(((await this.items()).find((i) => i.ItemID === it.ItemID) || {}).bWear) === 1, 5000, 300)) {
        shown++;
        this.journal(`style: showing ${name} (${wardrobe.SLOT_NAME[slot]})`);
      }
      await this.wait(1600);   // the game's wearItem cool-down is 1.5 s
    }
    // A picked look with an empty slot (V-B04 has no cape) shows nothing there: an older look's piece comes off.
    if (look.code) {
      for (const slot of wardrobe.SHOW) {
        if (look[slot]) continue;
        const it = (await this.items()).find((i) => i.sES === slot && Number(i.bWear) === 1);
        if (!it) continue;
        await this.client.send(`%xt%zm%unwearItem%${await this.room()}%${it.ItemID}%`);
        await this.wait(1600);
        this.journal(`style: not showing ${it.sName} (${look.code} has no ${wardrobe.SLOT_NAME[slot]})`);
      }
      this.journal(`look of the day: ${look.code}`);
    }
    if (look.pe) await this.wearLookPet(look.pe).catch((e) => this.journal(`pet: ${e.message}`, 'warn'));
    await this.ensureColors(this.wantedColors(look), `look ${look.code || 'of the day'}`).catch((e) => this.journal(`colours: ${e.message}`, 'warn'));
    return shown;
  }
  // A look's pet is equipped (pets have no "Show" in the game, LPFLayoutInvShopEnh.as) - unless the pet on now carries a
  // boost (XP, gold, class points...), which the farm needs more than the look does.
  async wearLookPet(name) {
    const n = String(name).toLowerCase();
    const items = await this.items();
    const on = items.find((i) => i.sES === 'pe' && Number(i.bEquip) === 1);
    if (on && String(on.sName).toLowerCase() === n) return false;
    if (on && Object.keys(gear.parseMeta(on.sMeta)).length) return false;
    if (!items.some((i) => i.sES === 'pe' && String(i.sName).toLowerCase() === n) && !(await this.unbank(name))) return false;
    const ok = await this.equip(name);
    if (ok) this.journal(`style: pet ${name} with the look`);
    return ok;
  }

  // The colours an outfit is saved with: the look on show's, as the game's integers.
  colorsBody(colors) {
    const c = colors || this.wantedColors() || {};
    const n = (k) => (c[k] ? parseInt(c[k], 16) : undefined);
    const out = {};
    for (const k of ['hair', 'skin', 'eye', 'base', 'trim', 'accessory']) if (n(k) !== undefined) out[k] = n(k);
    return out;
  }

  // Outfits: one saved loadout per class this character fights with (class, boost gear, armor, pet), so a class
  // switch is one equipLoadout. Saved after the class is geared and enhanced; re-saved when the pieces change.
  async saveOutfit() {
    if (this.isGuest()) return false;
    const cls = String(await this.className().catch(() => ''));
    if (!cls) return false;
    const equipped = (await this.items()).filter((i) => i.bEquip);
    const o = 'world.myAvatar.objData.';
    const now = { hair: Number(await this.g(`${o}intColorHair`, 0)), skin: Number(await this.g(`${o}intColorSkin`, 0)), eye: Number(await this.g(`${o}intColorEye`, 0)),
      base: Number(await this.g(`${o}intColorBase`, 0)), trim: Number(await this.g(`${o}intColorTrim`, 0)), accessory: Number(await this.g(`${o}intColorAccessory`, 0)) };
    // Saved with the look's colours, never whatever happens to be on (2026-10-17).
    const colors = { ...now, ...this.colorsBody() };
    const body = wardrobe.outfitBody(equipped, colors);
    if (!body.ar) return false;
    const key = cls.toLowerCase();
    const old = this.outfits[key];
    if (old && wardrobe.sameOutfit(old.body, body)) return false;
    const name = wardrobe.outfitName(cls);
    const r = await this.addLoadout(name, body, old ? old.name : '');
    if (r && (r.success === false || r.success === 0)) { this.journal(`outfit "${name}" not saved: ${r.msg || 'refused'}`, 'warn'); return false; }
    this.outfits[key] = { name, body, names: equipped.filter((i) => body[i.sES] === Number(i.ItemID)).map((i) => i.sName), savedAt: new Date().toISOString(), confirmed: !!r };
    writeJson(this.file('outfits.json'), this.outfits);
    this.journal(`saved outfit "${name}" (${this.outfits[key].names.join(', ')})`);
    return true;
  }
  // Put on the class's outfit: its pieces out of the bank, then equipLoadout. False when there is no outfit for it or
  // the class didn't come on (the caller then equips the class itself).
  // The owner's own outfit for a class on his account (his server loadouts: SC, LOO, CAV, vhl, VDK, KE, LR...): the one whose
  // armor slot is that class, in the server's order (CAV before Tank CAV). { name, ids: {slot: ItemID} } or null.
  // Purpose outfits (2026-10-22): several outfits per class, named "<class> Farm", "<class> Solo", "AP Dage"... The plain
  // one is the default (class switches, Solo, bosses); purpose 'farm' takes the "... Farm" outfit when there is one.
  async guestLoadout(cls, purpose = null) {
    const lo = this.loadoutIdsSource();
    const owned = [...(await this.items()), ...((await this.bankItems(0).catch(() => [])) || [])];
    const clsIds = new Set(owned.filter((i) => i && String(i.sName).toLowerCase() === String(cls).toLowerCase()).map((i) => Number(i.ItemID)));
    const found = [];
    for (const [name, body] of Object.entries(lo)) {
      if (!body || typeof body !== 'object' || !clsIds.has(Number(body.ar))) continue;
      const ids = {};
      for (const [slot, v] of Object.entries(body)) if (slot !== 'colors' && Number(v) > 0) ids[slot] = Number(v);
      found.push({ name, ids });
    }
    const PURPOSE = /\b(farm|solo|dage|rav|group|boss|tank)\b/i;
    if (purpose === 'farm') { const f = found.find((o) => /\bfarm\b/i.test(o.name)); if (f) return f; }
    return found.find((o) => !PURPOSE.test(o.name)) || found[0] || null;
  }
  // Every weapon this character owns (backpack + bank): its all-damage bonus, the enhancement on it (type + forge
  // special) and the server outfits that use it - for checking a set of 51% weapons against the outfits (2026-10-22).
  async weaponReport(slots = ['Weapon']) {
    const e = knowledge.enh();
    const procName = Object.fromEntries(Object.entries(e.weaponProc).map(([k, v]) => [v, k]));
    const typeName = Object.fromEntries(Object.entries(e.typeId).map(([k, v]) => [v, k]));
    const patName = { he: Object.fromEntries(Object.entries(e.helmPattern).map(([k, v]) => [v, k])), ba: Object.fromEntries(Object.entries(e.capePattern).map(([k, v]) => [v, k])) };
    const lo = this.loadoutIdsSource();
    const owned = [...(await this.items()).map((i) => ({ ...i, where: 'backpack' })), ...((await this.bankItems(0).catch(() => [])) || []).map((i) => ({ ...i, where: 'bank' }))];
    return owned.filter((i) => i && slots.includes(i.sES)).map((i) => {
      const dmg = gear.parseMeta(i.sMeta).dmgall || 0;
      const proc = Number(i.ProcID || 0);
      const pat = Number(i.EnhPatternID || 0);
      // Helm and cape forge enhancements are patterns (Examen, Vainglory...), weapon ones a proc on the Forge pattern.
      const special = i.sES === 'Weapon' ? (proc ? (procName[proc] || `proc ${proc}`) : null) : (patName[i.sES] && !typeName[pat] ? patName[i.sES][pat] || null : null);
      return { name: i.sName, slot: i.sES, ItemID: Number(i.ItemID), where: i.where, allDamage: Math.round(dmg * 100),
        enhancement: Number(i.EnhID || 0) ? { type: typeName[pat] || (pat === 10 ? 'Forge' : special ? null : `pattern ${pat}`), special, level: Number(i.EnhLvl || 0) } : null,
        outfits: Object.entries(lo).filter(([, b]) => b && Number(b[i.sES]) === Number(i.ItemID)).map(([n]) => n) };
    }).sort((a, b) => b.allDamage - a.allDamage);
  }
  // Re-point one slot of one server outfit at another owned item (same name, same other pieces and colours). An
  // outfit stores item IDs, so this costs nothing.
  async pointOutfit(name, slot, itemName) {
    const lo = this.loadoutIdsSource();
    const body = lo[name];
    if (!body) throw new Error(`no outfit "${name}" (have: ${Object.keys(lo).join(', ')})`);
    const owned = [...(await this.items()), ...((await this.bankItems(0).catch(() => [])) || [])];
    const it = owned.find((i) => i && String(i.sName).toLowerCase() === String(itemName).toLowerCase() && (i.sES === slot || (slot === 'co' && i.sES === 'ar')));
    if (!it) throw new Error(`no owned ${slot} item "${itemName}"`);
    const next = { ...body, [slot]: Number(it.ItemID) };
    const r = await this.addLoadout(name, next, name);
    if (r && (r.success === false || r.success === 0)) throw new Error(`the server refused it: ${r.msg || 'refused'}`);
    lo[name] = next;
    this.journal(`outfit "${name}": ${slot} is now ${it.sName} (asked by hand)`);
    const moved = await this.outfitsToBag([name]).catch(() => []);
    return { outfit: name, slot, item: it.sName, ItemID: Number(it.ItemID), confirmed: !!r, movedToBag: moved };
  }
  // A new server outfit made from an existing one with some slots pointed elsewhere ({ he: 'Name', ba: 'Name' }).
  async copyOutfit(from, name, set = {}) {
    const lo = this.loadoutIdsSource();
    if (!lo[from]) throw new Error(`no outfit "${from}"`);
    if (lo[name]) throw new Error(`outfit "${name}" exists already - use outfitSlot to change it`);
    const owned = [...(await this.items()), ...((await this.bankItems(0).catch(() => [])) || [])];
    const body = { ...lo[from] };
    for (const [slot, itemName] of Object.entries(set)) {
      const it = owned.find((i) => i && String(i.sName).toLowerCase() === String(itemName).toLowerCase() && i.sES === slot);
      if (!it) throw new Error(`no owned ${slot} item "${itemName}"`);
      body[slot] = Number(it.ItemID);
    }
    const r = await this.addLoadout(name, body, '');
    if (r && (r.success === false || r.success === 0)) throw new Error(`the server refused it: ${r.msg || 'refused'}`);
    lo[name] = body;
    this.journal(`new outfit "${name}" from "${from}" (${Object.entries(set).map(([s, n]) => `${s}: ${n}`).join(', ') || 'same pieces'}) - asked by hand`);
    const moved = await this.outfitsToBag([name]).catch(() => []);
    return { outfit: name, from, body, confirmed: !!r, movedToBag: moved };
  }
  // Outfit pieces belong in the backpack (2026-10-23): the game's own outfit button only looks there ("couldn't find
  // items in inventory"), and the owner's Oni Look / Acoustic Look were saved from pieces left in the bank. Takes the banked
  // pieces of the named outfits (all of them by default) out of the bank while the bag has room; bankKeepTest then keeps
  // them out. Returns the names moved.
  async outfitsToBag(names = null) {
    const lo = this.loadoutIdsSource();
    const ids = new Set();
    for (const [n, body] of Object.entries(lo)) {
      if ((names && !names.includes(n)) || !body || typeof body !== 'object') continue;
      for (const [slot, v] of Object.entries(body)) if (slot !== 'colors' && Number(v) > 0) ids.add(Number(v));
    }
    const inBag = new Set((await this.items()).map((i) => Number(i.ItemID)));
    const banked = ((await this.bankItems(0).catch(() => [])) || []).filter((i) => i && ids.has(Number(i.ItemID)) && !inBag.has(Number(i.ItemID)));
    const moved = [];
    for (const it of banked) {
      if (await this.unbank(it.sName)) { moved.push(it.sName); continue; }
      this.journal(`outfit pieces left in the bank (no backpack room): ${banked.filter((b) => !moved.includes(b.sName)).map((b) => b.sName).join(', ')}`, 'warn');
      break;
    }
    return moved;
  }
  loadoutIdsSource() {
    const w = this.client && this.client.swf && this.client.swf.w;
    return (w && w.objInfo && w.objInfo.customs && w.objInfo.customs.loadouts) || this.serverLoadouts || {};
  }
  // Names of the weapon / helm / cape in the owner's outfit for a class (CBO Solo/Farm equip sets on his account).
  async guestOutfitPieces(cls, purpose = null) {
    const o = await this.guestLoadout(cls, purpose).catch(() => null);
    if (!o) return null;
    const owned = [...(await this.items()), ...((await this.bankItems(0).catch(() => [])) || [])];
    const name = (id) => { const it = owned.find((i) => i && Number(i.ItemID) === Number(id)); return it ? it.sName : null; };
    return { outfit: o.name, Weapon: name(o.ids.Weapon), he: name(o.ids.he), ba: name(o.ids.ba) };
  }
  async wearOutfit(cls) {
    // The owner's account (2026-10-17): a class switch puts on HIS outfit for that class, with the enhancements he gave its
    // pieces. Seraph had no kits there, so every switch (KE, LR, VDK, StoneCrusher...) re-forged the same helm and
    // weapon for the new class: 46 enhancements and 9 M gold in two days, over his KE outfit's pieces.
    if (this.isGuest && this.isGuest()) {
      const o = await this.guestLoadout(cls).catch(() => null);
      if (!o) return false;
      const bank = (await this.bankItems(0).catch(() => [])) || [];
      for (const id of Object.values(o.ids)) {
        this.check();
        if ((await this.items()).some((i) => Number(i.ItemID) === id)) continue;
        const it = bank.find((i) => Number(i.ItemID) === id);
        if (it) await this.unbank(it.sName);
      }
      await this.client.send(`%xt%zm%equipLoadout%${await this.room()}%cmd%${o.name}%1%`);
      const ok = await this.waitFor(async () => String(await this.className().catch(() => '')).toLowerCase() === String(cls).toLowerCase(), 8000, 400);
      if (ok) for (const id of Object.values(o.ids)) { const it = (await this.items()).find((i) => Number(i.ItemID) === id); if (it && !it.bEquip && it.sES !== 'co') await this.equip(it.sName).catch(() => null); }
      this.journal(ok ? `your outfit "${o.name}" on (${cls})` : `your outfit "${o.name}" did not come on - equipping ${cls} by hand`, ok ? 'info' : 'warn');
      return ok;
    }
    const rec = this.outfits[String(cls).toLowerCase()];
    if (!rec) return false;
    for (const n of rec.names || []) { this.check(); if (!(await this.owns(n).catch(() => false))) return false; await this.unbank(n); }
    await this.client.send(`%xt%zm%equipLoadout%${await this.room()}%cmd%${rec.name}%1%`);
    const ok = await this.waitFor(async () => String(await this.className().catch(() => '')).toLowerCase() === String(cls).toLowerCase(), 8000, 400);
    // The model learns about equips from equipItem packets; any piece it still shows off is put on by hand.
    if (ok) for (const n of rec.names || []) { const it = (await this.items()).find((i) => i.sName === n); if (it && !it.bEquip) await this.equip(n); }
    this.journal(ok ? `outfit "${rec.name}" on` : `outfit "${rec.name}" did not come on - equipping ${cls} by hand`, ok ? 'info' : 'warn');
    if (ok) await this.ensureColors(this.wantedColors(), `outfit ${rec.name}`).catch(() => false);
    return ok;
  }
  // After a class switch and the boost gear for a task: enhancements for this class, the outfit saved, the look shown.
  async settleOutfit() {
    if ((await this.needsEnhance().catch(() => false)) && (await this.gold()) > 50000) await this.enhanceEquipped().catch((e) => this.journal(`enhance: ${e.message}`, 'warn'));
    await this.saveOutfit().catch((e) => this.journal(`outfit: ${e.message}`, 'warn'));
    if (!this._lookAt || Date.now() - this._lookAt > 3600000) {
      this._lookAt = Date.now();
      await this.showLook().catch((e) => this.journal(`look: ${e.message}`, 'warn'));
      await this.saveLookOutfits().catch((e) => this.journal(`look outfit: ${e.message}`, 'warn'));
    }
  }

  // Save a server outfit, replacing the set called oldName. When that set is gone from the server (deleted in game, or
  // never saved), the replace is refused with "Your set could not be found." - for ever: Valen's look outfit failed at
  // every login on 2026-10-21. Then it is saved as a new set.
  async addLoadout(name, body, oldName = '') {
    const send = async (replace) => {
      this.loadoutReply = null;
      await this.client.send(`%xt%zm%addLoadout%${await this.room()}%${name}%${JSON.stringify(body)}%${replace}%`);
      await this.waitFor(async () => !!this.loadoutReply, 5000, 300);
      return this.loadoutReply;
    };
    let r = await send(oldName || '');
    if (oldName && r && (r.success === false || r.success === 0) && /could not be found/i.test(r.msg || '')) {
      this.journal(`outfit "${oldName}" is no longer on the server - saving "${name}" as a new set`);
      r = await send('');
    }
    return r;
  }

  // The owner, 2026-10-14: "make sure to create an outfit for them with this". Each main look the character fully owns is
  // saved as its own server outfit (addLoadout, named after the look): the class and boost gear on now, with the look's
  // armor shown as the cosmetic armor ('co'). Kept in outfits.json under "look:<code>" (wearOutfit only reads classes).
  async saveLookOutfits() {
    if (!this.persona || this.isGuest()) return 0;
    const f = this.persona.fashion || {};
    const main = f.rotation ? [...(f.main || []), ...(f.extra || [])].filter((m) => f.rotation[m.code] !== undefined) : (f.main || []);
    if (!main.length) return 0;
    const owned = [...(await this.items()), ...((await this.bankItems().catch(() => [])) || [])];
    const byName = (n, slot) => owned.find((i) => String(i.sName).toLowerCase() === String(n).toLowerCase() && (!slot || i.sES === slot || (slot === 'co' && i.sES === 'ar')));
    const ar = (await this.items()).find((i) => i.bEquip && i.sES === 'ar');
    if (!ar) return 0;
    const o = 'world.myAvatar.objData.';
    const colors = { hair: Number(await this.g(`${o}intColorHair`, 0)), skin: Number(await this.g(`${o}intColorSkin`, 0)), eye: Number(await this.g(`${o}intColorEye`, 0)),
      base: Number(await this.g(`${o}intColorBase`, 0)), trim: Number(await this.g(`${o}intColorTrim`, 0)), accessory: Number(await this.g(`${o}intColorAccessory`, 0)) };
    let saved = 0;
    for (const look of main) {
      const want = { co: look.armor, he: look.helm, ba: look.cape, Weapon: look.weapon };
      if (look.pet && byName(look.pet, 'pe')) want.pe = look.pet;   // the look's pet when owned (optional)
      const body = { ar: Number(ar.ItemID) };
      let complete = true;
      for (const [slot, name] of Object.entries(want)) {
        if (!name) continue;
        const it = byName(name, slot);
        if (!it) { complete = false; break; }
        body[slot] = Number(it.ItemID);
      }
      if (!complete) continue;
      body.colors = { ...colors, ...this.colorsBody(this.wantedColors({ code: look.code })) };   // the look's own colours
      const key = `look:${String(look.code).toLowerCase()}`;
      const old = this.outfits[key];
      if (old && wardrobe.sameOutfit(old.body, body)) continue;
      const name = wardrobe.outfitName(look.name);
      const r = await this.addLoadout(name, body, old ? old.name : '');
      if (r && (r.success === false || r.success === 0)) { this.journal(`look outfit "${name}" not saved: ${r.msg || 'refused'}`, 'warn'); continue; }
      this.outfits[key] = { name, body, look: look.code, names: Object.values(want).filter(Boolean), savedAt: new Date().toISOString(), confirmed: !!r };
      writeJson(this.file('outfits.json'), this.outfits);
      this.journal(`saved look outfit "${name}" (${look.code}: ${Object.values(want).filter(Boolean).join(', ')})`);
      saved++;
    }
    return saved;
  }

  // ---------------- enhancements ----------------
  async unlockedEnhancements() {
    const e = knowledge.enh();
    const out = new Set();
    for (const [name, qid] of Object.entries(e.unlocks)) if (await this.completedOnce(qid)) out.add(name);
    return out;
  }
  // Below level, or enhanced for another class (the owner 2026-10-07: "when switching outfits you switch class and apply the
  // proper enhancements to that class" - Nova's Blaze Binder (Wizard) fought with a Lucky weapon).
  async needsEnhance() {
    if (this.isGuest && this.isGuest()) return false;   // The owner's enhancements are his (2026-10-17: "make sure you dont mess up my enchatments")
    const lvl = await this.level();
    const slots = ['ar', 'Weapon', 'he', 'ba'];
    const cls = await this.className().catch(() => '');
    const plan = await this.enhancePlanFor(cls, lvl).catch(() => null);
    const e = knowledge.enh();
    const gold = Number(await this.gold().catch(() => 0));
    return (await this.items()).some((i) => i.bEquip && slots.includes(i.sES) && !this.enhanceCapped(i, cls, lvl)
      && !this.noEnhance.has(String(i.sName).toLowerCase()) && !this.lockedForge(i, cls, plan, e) && !this.enhGood(i, plan, e, gold, lvl));
  }
  // The class's enhancement plan (knowledge.enhancementPlan), kept 30 min per class and level.
  async enhancePlanFor(cls, lvl) {
    const key = `${cls}|${lvl}`;
    // One entry per class: the kits ask for the Solo and the Farm class in turn.
    const c = (this._enhPlans = this._enhPlans || new Map()).get(key);
    if (c && Date.now() - c.t < 30 * 60000) return c.plan;
    const plan = knowledge.enhancementPlan(cls, await this.unlockedEnhancements(), lvl);
    this._enhPlans.set(key, { t: Date.now(), plan });
    return plan;
  }

  // ---------------- class kits (lib/kits.js, the owner 2026-10-13) ----------------
  // Not on the owner's own accounts (autoGear off: his gear stays as he set it).
  kitsOn() { return !this.isGuest() && this.settings.autoGear !== false && this.settings.kits !== false; }
  // One kit per class this character fights with: its main class first (settings.mainClass, else the Solo class -
  // the one it uses most; it takes the boosted pieces), the Solo and Farm classes CoreBots swaps between (cbo.keysFor
  // writes those two), its ultra seat classes (ultraready.SEATS) and any class a help call or raid put it in
  // (kits.extra, added by wearKitFor). Rebuilt when a class, the level or a plan changes, at most every 30 min otherwise.
  async planKits(force = false) {
    if (!this.kitsOn()) return null;
    const owned = (await this.ownedClasses()).map((c) => c.toLowerCase());
    const has = (c) => !!c && owned.includes(String(c).toLowerCase());
    const pick = (job) => { const p = classplan.classFor(this.id, job, owned); return p ? p.name : null; };
    const solo = pick('solo');
    const farm = pick('farm');
    if (!solo && !farm) return null;
    const seat = require('./ultraready').SEATS[String(this.id).toLowerCase()] || null;
    const extra = (this.kits && this.kits.extra) || [];
    const main = has(this.settings.mainClass) ? this.settings.mainClass : (solo || farm);
    const want = [[main, 'main'], [solo, 'solo'], [farm, 'farm'], ...(seat ? [seat.cls, ...(seat.also || [])] : []).map((c) => [c, 'seat']), ...extra.map((c) => [c, 'seat'])]
      .filter(([c]) => has(c));
    const lvl = await this.level();
    const roles = [];
    for (const [cls, role] of want) {
      if (roles.some((r) => r.cls.toLowerCase() === String(cls).toLowerCase())) continue;
      roles.push({ cls, role, plan: await this.enhancePlanFor(cls, lvl) });
    }
    const sig = JSON.stringify([kits.VERSION, roles.map((r) => [r.cls, r.role, r.plan]), lvl, this.noEnhance.size]);
    if (!force && this.kits && this.kits.sig === sig && Date.now() - (this.kits.at || 0) < 30 * 60000) return this.kits;
    const member = (await this.g('world.myAvatar.objData.iUpgDays', -1)) >= 0;
    const built = kits.build({ roles, items: await this.items(), bank: await this.bankItems().catch(() => []), member, e: knowledge.enh(), prev: this.kits, exclude: this.noEnhance, avoid: Bot.questNeeds() });
    // Solo / Farm point at their class's kit (the main class is the Solo class unless mainClass says otherwise).
    const byCls = (c) => built.list.find((k) => c && k.cls.toLowerCase() === String(c).toLowerCase()) || null;
    built.solo = byCls(solo); built.farm = byCls(farm);
    const same = this.kits && JSON.stringify(kits.all(this.kits)) === JSON.stringify(built.list);
    this.kits = { ...built, extra, sig, at: Date.now() };
    writeJson(this.file('kits.json'), this.kits);
    const say = (k) => `${k.cls}${k.role === 'main' ? ' (main)' : ''}: ${[k.Weapon, k.he, k.ba].filter(Boolean).join(', ')}`;
    if (!same) this.journal(`kits: ${built.list.map(say).join(' | ')}`);
    return this.kits;
  }
  // Put a kit's weapon, helm and cape on (out of the bank first). Returns how many pieces went on.
  async wearKit(kit) {
    if (!kit) return 0;
    let on = 0;
    for (const slot of kits.SLOTS) {
      const name = kit[slot];
      if (!name) continue;
      this.check();
      const n = String(name).toLowerCase();
      let it = (await this.items()).find((i) => String(i.sName).toLowerCase() === n && i.sES === slot);
      if (it && it.bEquip) continue;
      if (!it && !(await this.unbank(name))) { this.journal(`kit: ${name} is in neither my backpack nor my bank`, 'warn'); continue; }
      await this.equip(name);
      it = (await this.items()).find((i) => String(i.sName).toLowerCase() === n && i.sES === slot);
      if (it && it.bEquip) on++;
      await this.wait(1600);   // the game's equip cool-down
    }
    return on;
  }
  // The class's kit on. A class without one (a help-call or raid seat) gets one first, from pieces no other kit uses.
  async wearKitFor(cls) {
    if (!this.kitsOn() || !cls) return 0;
    if (!this.kits || !kits.forClass(this.kits, cls)) {
      this.kits = this.kits || { list: [] };
      this.kits.extra = [...new Set([...(this.kits.extra || []), cls])].slice(-4);
      await this.planKits(true).catch((err) => this.journal(`kits: ${err.message}`, 'warn'));
    }
    return this.wearKit(kits.forClass(this.kits, cls));
  }
  // Before a Skua script: every kit in the backpack and enhanced for its own class, so CoreBots' class swaps (EquipClass
  // Solo / Farm) and Seraph's seats carry the right enhancements. Does nothing once they are right; the task's own class
  // is put back on by useRole afterwards.
  async prepareKits() {
    const k = await this.planKits().catch((err) => { this.journal(`kits: ${err.message}`, 'warn'); return null; });
    if (!k) return 0;
    const lvl = await this.level();
    const e = knowledge.enh();
    const seen = new Set();
    let ready = 0;
    for (const kit of kits.all(k)) {
      if (!kit || seen.has(String(kit.cls).toLowerCase())) continue;
      seen.add(String(kit.cls).toLowerCase());
      this.check();
      const plan = await this.enhancePlanFor(kit.cls, lvl);
      const inv = await this.items();
      const gold = Number(await this.gold());
      const right = kits.SLOTS.every((s) => {
        if (!kit[s]) return true;
        const it = inv.find((i) => String(i.sName).toLowerCase() === String(kit[s]).toLowerCase() && i.sES === s);
        if (!it) return false;   // still in the bank
        return this.enhanceCapped(it, kit.cls, lvl) || this.noEnhance.has(String(it.sName).toLowerCase()) || this.enhGood(it, plan, e, gold, lvl);
      });
      if (right) continue;
      if ((await this.gold()) < 50000) { this.journal('kits: under 50k gold - enhancing them later', 'warn'); break; }
      if (String(await this.className()).toLowerCase() !== String(kit.cls).toLowerCase()) {
        if (!(await this.unbank(kit.cls))) continue;
        await this.equip(kit.cls);
      }
      await this.wearKit(kit);
      const n = await this.enhanceEquipped().catch((err) => { this.journal(`kits: enhancing failed: ${err.message}`, 'warn'); return 0; });
      this.journal(`kit for ${kit.cls} (${kit.role}) ready - ${n} piece(s) enhanced`);
      ready++;
    }
    return ready;
  }
  // A piece two or more kits share (they enhance it the same forge way once the gold is there).
  sharedPiece(item) {
    const n = String(item && item.sName || '').toLowerCase();
    return kits.all(this.kits).filter((k) => String(k[item.sES] || '').toLowerCase() === n).length > 1;
  }
  // Before a raid script: the seat class hub.beginRaid gave me, wearing that class's own kit (lib/kits.js).
  async raidSeatGear(seatArg = null) {
    const r = this.hub && this.hub.raid;
    const seat = seatArg || (r && (r.seats || []).find((s) => s.id === this.id));
    if (!seat || !seat.cls) return false;
    if (String(await this.className()).toLowerCase() !== String(seat.cls).toLowerCase()) {
      if (!(await this.unbank(seat.cls))) return false;
      await this.equip(seat.cls);
    }
    await this.raidRoom();
    await this.wearKitFor(seat.cls);
    if (await this.needsEnhance()) await this.enhanceEquipped();
    this.journal(`raid seat ${seat.cls}: wearing its own kit`);
    return true;
  }
  // The owner's main in a raid seat (hub.raidWithMain): his own outfit for the seat's class, as he enhanced it - nothing is
  // enhanced or bought (CBO SeraphNeverEnhance keeps the Ultras' Loadouts off his gear too).
  async raidSeatOutfit(seatArg = null) {
    const r = this.hub && this.hub.raid;
    const seat = seatArg || (r && (r.seats || []).find((s) => s.id === this.id));
    if (!seat || !seat.cls) return false;
    if (!(await this.wearOutfit(seat.cls))) {
      if (!(await this.unbank(seat.cls))) return false;
      await this.equip(seat.cls);
    }
    await this.raidRoom();
    this.journal(`raid seat ${seat.cls}: your own ${seat.cls} outfit, enhancements untouched`);
    return true;
  }
  // Room for the raid's potions and their reagents before v3 starts (2026-10-22: the main's bag was full, the reagent
  // buy failed and CoreFarms.AlchemyPacket stopped his Warden script at 2 min). Banks only what the keep rules allow
  // (outfit pieces, kit pieces and, on the owner's account, enhanced gear stay).
  async raidRoom(want = 10) {
    if ((await this.freeSlots().catch(() => want)) >= want) return 0;
    const n = await this.bankAc(0, want).catch(() => 0);
    this.journal(`raid: banked ${n} item(s) for room - ${await this.freeSlots().catch(() => '?')} backpack slots free`);
    return n;
  }
  // A forge special on this piece that another class owns (the owner 2026-10-13: never bought over - "leave the
  // enchantment as it is and enhance weapon Y"). Allowed: the piece is in this class's own kit, or kits are off.
  lockedForge(item, cls, plan, e) {
    if (!this.kitsOn || !this.kitsOn()) return null;
    const fk = kits.forgeKey(item, e);
    if (!fk || !kits.SLOTS.includes(item.sES)) return null;
    if (fk === kits.slotKey(item.sES, plan, e)) return null;
    const owner = this.kits ? kits.ownerOf(this.kits, item.sES, item.sName) : null;
    if (owner && String(owner).toLowerCase() === String(cls).toLowerCase()) return null;
    return owner || 'another class';
  }
  // A slot the shop cannot take any higher for this class at this level (Awe weapon specials stop at 90): needsEnhance
  // leaves it alone until the character levels, instead of sending the brain back to the shop every 30 min to find
  // nothing better (check-up 2026-10-04: Nova at 97 ran 23 enhance tasks in a day for her lvl-90 Mana Vamp).
  enhanceCapped(item, cls, lvl) {
    const c = this._enhCapped && this._enhCapped.get(`${item.ItemID}|${cls}`);
    return !!(c && c.lvl === lvl && Number(item.EnhLvl || 0) >= c.enh);
  }
  markEnhanceCapped(item, cls, lvl, enh) {
    (this._enhCapped = this._enhCapped || new Map()).set(`${item.ItemID}|${cls}`, { lvl, enh: Number(enh || 0) });
  }
  async enhanceEquipped(override = null) {
    // Never on the owner's account, whoever asks (class switch, raid seat, ultra plan, kits): his outfits carry his own
    // enhancements, and re-forging them per class cost 9 M gold in two days (2026-10-15..17).
    // 2026-10-21: he can ask for one, by naming the slots (`override.onlySlots`) and saying so (`override.onMain`).
    // Anything else - a class switch, a raid seat, an ultra preset, the kits - still gets nothing.
    const askedOnMain = !!(override && override.onMain && Array.isArray(override.onlySlots) && override.onlySlots.length);
    if (this.isGuest && this.isGuest() && !askedOnMain) {
      if (!this._guestEnhSaid || Date.now() - this._guestEnhSaid > 6 * 3600000) { this._guestEnhSaid = Date.now(); this.journal('not enhancing anything on your account - your outfits keep the enhancements you gave them'); }
      return 0;
    }
    const e = knowledge.enh();
    const lvl = await this.level();
    const cls = await this.className();
    const plan = override || knowledge.enhancementPlan(cls, await this.unlockedEnhancements(), lvl);
    this.journal(`enhance plan for ${await this.className()}: ${plan.type} weapon=${plan.weapon || 'basic'} cape=${plan.cape || 'basic'} helm=${plan.helm || 'basic'} (${plan.source})`);
    const member = (await this.g('world.myAvatar.objData.iUpgDays', -1)) >= 0;
    const slotWord = { ar: 'armor', Weapon: 'weapon', he: 'helm', ba: 'cape' };
    const planSlot = { Weapon: 'weapon', ba: 'cape', he: 'helm' };
    const reserve = this.enhanceReserve();
    // Where an enhancement for this slot is sold, and the word its name carries.
    const where = (item, special) => {
      if (item.sES === 'Weapon' && special) {
        // The plain Forge special has proc 1 like the Awe ones, but it is a forge enhancement (CoreAdvanced sends it to
        // the Awe shops, where it is not sold): the forge shop first, the Awe shop if it isn't there.
        if (e.weaponProc[special] <= 6 && special !== 'Forge') return { shopId: e.aweShops[plan.type], map: null, special };
        return { shopId: e.forgeShops.weapon, map: e.forgeShops.map, special };
      }
      if (item.sES === 'ba' && special) return { shopId: e.forgeShops.cape, map: e.forgeShops.map, special };
      if (item.sES === 'he' && special) return { shopId: e.forgeShops.helm, map: e.forgeShops.map, special };
      return { shopId: e.basicShops[plan.type][lvl >= 50 ? 1 : 0], map: null, special: null };
    };
    const find = (shop, item, special) => {
      const word = special ? special.replace(/_/g, '').toLowerCase() : slotWord[item.sES];
      // "forge" is also part of other forge enhancements' names: the plain one is the forge item naming no other special.
      const others = word === 'forge' ? Object.keys(e.weaponProc).concat(Object.keys(e.capePattern), Object.keys(e.helmPattern)).map((s) => s.replace(/_/g, '').toLowerCase()).filter((s) => s !== 'forge' && s !== 'none') : [];
      return shop
        .filter((s) => /enhancement/i.test(String(s.sType)) && (member || !s.bUpg) && Number(s.iLvl) <= lvl)
        .filter((s) => { const n = String(s.sName).replace(/[\s']/g, '').toLowerCase(); return n.includes(word) && !others.some((o) => n.includes(o)); })
        .sort((a, b) => Number(b.iLvl) - Number(a.iLvl))[0];
    };
    let applied = 0;
    const only = override && Array.isArray(override.onlySlots) ? new Set(override.onlySlots) : null;
    if (only) this.journal(`enhancing only ${[...only].map((s) => slotWord[s] || s).join(', ')} on this account, as asked`);
    for (const item of (await this.items()).filter((i) => i.bEquip && slotWord[i.sES] && (!only || only.has(i.sES)))) {
      this.check();
      if (this.noEnhance.has(String(item.sName).toLowerCase())) continue;   // the server refused it before (fixed enhancement)
      const owner = this.lockedForge(item, cls, plan, e);
      if (owner) { this.journal(`keeping ${item.sName} as it is: its forge enhancement belongs to ${owner} (the ${cls} kit uses other pieces)`); continue; }
      // Right for this class (or as right as the gold allows): nothing to buy, and a forge special on it is never taken off.
      if (!override && this.enhGood(item, plan, e, await this.gold(), lvl)) continue;
      let w = where(item, planSlot[item.sES] ? plan[planSlot[item.sES]] : null);
      let shop = await this.loadShop(w.shopId, w.map).catch(() => []);
      let best = find(shop, item, w.special);
      if (!best && item.sES === 'Weapon' && w.special === 'Forge') {
        w = { shopId: e.aweShops[plan.type], map: null, special: 'Forge' };
        shop = await this.loadShop(w.shopId, null).catch(() => []);
        best = find(shop, item, 'Forge');
      }
      // A forge special costs 60k-300k (a basic one ~10k): bought only while the gold stays above the reserve after it;
      // until then the slot takes the cheap enhancement, and needsEnhance upgrades it once the gold is there.
      if (best && w.special && knowledge.isForgeSpecial(planSlot[item.sES], w.special, e) && (await this.gold()) - Number(best.iCost || 0) < reserve) {
        const cheap = knowledge.cheapPlan(plan);
        const c = where(item, planSlot[item.sES] ? cheap[planSlot[item.sES]] : null);
        this.journal(`${best.sName} (${best.iCost}g) waits until I keep ${Math.round(reserve / 1000)}k gold after it - ${item.sName} gets ${c.special || `a ${plan.type}`} enhancement for now`);
        w = c;
        shop = await this.loadShop(w.shopId, w.map).catch(() => []);
        best = find(shop, item, w.special);
        if (best && Number(item.EnhID) === Number(best.ItemID) && Number(item.EnhLvl || 0) >= Math.min(lvl, lvl - 4)) continue;   // already the cheap one
      }
      // A shop that did not load is not a shop without the enhancement: try again next time (no cap).
      if (!shop.length) { this.journal(`shop ${w.shopId} did not load - ${item.sName} is enhanced next time`, 'warn'); continue; }
      if (!best) { this.journal(`no ${w.special || slotWord[item.sES]} enhancement in shop ${w.shopId}`, 'warn'); this.markEnhanceCapped(item, cls, lvl, item.EnhLvl); continue; }
      if (Number(item.EnhID) === Number(best.ItemID) && Number(item.EnhLvl) === Number(best.iLvl)) { this.markEnhanceCapped(item, cls, lvl, best.iLvl); continue; }
      if ((await this.gold()) < Number(best.iCost || 0)) { this.journal(`not enough gold for ${best.sName} (${best.iCost})`, 'warn'); break; }
      await this.client.send(`%xt%zm%enhanceItemShop%${await this.room()}%${item.ItemID}%${best.ItemID}%${w.shopId}%`);
      // Done only when the server's reply put the new enhancement on (its EnhID is the shop item's ItemID, Game.tryEnhance).
      // Items with a fixed old enhancement (Templar's Helm of Light, pattern 1) get no reply: the level check that was
      // here "succeeded" at once and the same 600k pair was bought again every few seconds (2026-10-13).
      const took = await this.waitFor(async () => Number(((await this.items()).find((i) => i.ItemID === item.ItemID) || {}).EnhID) === Number(best.ItemID), 8000, 400);
      if (!took) {
        this.noEnhance.add(String(item.sName).toLowerCase());
        writeJson(this.file('noenhance.json'), [...this.noEnhance]);
        this.journal(`${item.sName} did not take ${best.sName} (no answer from the server) - it can't be enhanced; leaving it out of my kits`, 'warn');
        if (this.kits) this.kits.at = 0;   // rebuild the kits without it
        continue;
      }
      this.journal(`enhanced ${item.sName} with ${best.sName} (lvl ${best.iLvl}, ${best.iCost}g)`);
      this.remember('enhanced', { item: item.sName, with: best.sName, special: w.special || null });
      // The best the shop has is still under the bar (an Awe special at 90): done for this level.
      if (Number(best.iLvl) < Math.min(lvl, lvl - 4)) this.markEnhanceCapped(item, cls, lvl, best.iLvl);
      applied++;
    }
    return applied;
  }
  // Gold kept after buying a forge special (settings.enhanceGoldReserve, default 1 M).
  enhanceReserve() { return Number(this.settings.enhanceGoldReserve ?? 1000000); }
  // Good enough for the class at this level? The full plan at level; or, while a forge special plus the reserve is more
  // gold than there is: a forge special already on (even a few levels under - it is never swapped for a basic one),
  // or the cheap plan (knowledge.cheapPlan) at level.
  enhGood(item, plan, e, gold, lvl) {
    const atLevel = Number(item.EnhLvl || 0) >= Math.min(lvl, lvl - 4);
    if (!plan || Number(item.EnhID || 0) <= 0) return atLevel;   // nothing on it yet: only the level counts (a new character)
    const poor = gold < this.enhanceReserve() + 300000;
    const slot = { Weapon: 'weapon', ba: 'cape', he: 'helm' }[item.sES];
    if (wardrobe.enhMatches(item, plan, e)) return atLevel || (poor && !!slot && knowledge.isForgeSpecial(slot, plan[slot], e));
    if (!poor || !atLevel) return false;
    // Waiting for gold for a forge special: any basic / Awe placeholder at level will do. Two classes sharing the piece
    // (both want Vainglory) each re-did it in their own type - Lucky, Wizard, Lucky... (10k each, 2026-10-13).
    if (slot && knowledge.isForgeSpecial(slot, plan[slot], e) && !kits.forgeKey(item, e) && this.sharedPiece && this.sharedPiece(item)) return true;
    return wardrobe.enhMatches(item, knowledge.cheapPlan(plan), e);
  }

  // ---------------- scripts (translated Skua) ----------------
  async runSteps(steps, label, budgetMs = 2 * 3600000) {
    const deadline = Date.now() + budgetMs;
    const fails = {};
    this.lastStepsFailed = 0;   // steps that failed twice and were left behind (a daily is not done then)
    for (let i = 0; i < steps.length; i++) {
      this.check();
      if (Date.now() > deadline) { this.journal(`${label}: time budget used, stopping at step ${i}`); return false; }
      const s = steps[i];
      try {
        await this.runStep(s);
      } catch (e) {
        if (e instanceof Stop) throw e;
        fails[i] = (fails[i] || 0) + 1;
        this.journal(`${label} step ${i} (${s.kind} ${s.quest || ''} ${s.map || ''} ${s.item || ''}) failed: ${e.message}`, 'warn');
        if (/unavailable|too strong/.test(e.message)) return false;
        if (fails[i] < 2) i--; // retry once
        else this.lastStepsFailed++;
      }
    }
    this.registered.clear();
    return true;
  }

  // Legacy chains (quest N's reward unlocks quest N+1) keep no quest progress: owning a later quest's reward
  // means everything up to it is done. Returns the index of the last finished quest in the chain, or -1.
  async chainProgress(chain) {
    const owned = new Set([...await this.items(), ...await this.tempItems()].map((i) => String(i.sName || '').toLowerCase()));
    for (let k = chain.length - 1; k >= 0; k--) {
      const q = knowledge.quest(chain[k]);
      const rewards = ((q && q.Rewards) || []).map((r) => String(r.sName || r.Name || '').toLowerCase()).filter(Boolean);
      if (rewards.length && rewards.some((r) => owned.has(r))) return k;
    }
    return -1;
  }

  async runStep(s) {
    if (s.chain && s.quest && s.chain.indexOf(s.quest) <= (await this.chainProgress(s.chain))) return null;
    // Story helpers (KillQuest, MapItemQuest, BuyQuest) skip quests completed before, like Skua's Story.QuestProgression.
    if (['quest', 'mapitem', 'buyquest'].includes(s.kind) && s.quest && !s.chain && (await this.completedOnce(s.quest))) return null;
    switch (s.kind) {
      case 'join': return this.join(s.map, s.cell || 'Enter', s.pad || 'Spawn');
      case 'register': this.register(String(s.note).split(',').map(Number)); return null;
      case 'unregister': this.registered.clear(); return null;
      case 'accept':
        if (!s.quest || !(await this.questAvailable(s.quest))) return null;
        if (s.map) await this.join(s.map);
        return this.accept(s.quest);
      case 'turnin':
        if (s.quest && await this.canComplete(s.quest)) { await this.complete(s.quest, s.qty > 0 ? s.qty : -1); this.journal(`turned in ${s.quest}`); await this.collectRewards(s.quest); }
        return null;
      case 'hunt': {
        if (s.item && (await this.count(s.item)) >= (s.qty || 1)) return null;
        if (!s.map) throw new Error('hunt step without a map');
        await this.join(s.map, s.cell || 'Enter', s.pad || 'Spawn');
        // Quest items only drop while their quest is active: never farm for a quest that could not be accepted.
        if (s.quest && !(await this.inProgress(s.quest)) && !((await this.questAvailable(s.quest)) && (await this.accept(s.quest)))) {
          this.journal(`skipping ${s.item || s.monsters[0]}: quest ${s.quest} is not accepted (done already or locked)`);
          return null;
        }
        const monster = s.monsters[0] || '*';
        const done = s.item ? async () => (await this.count(s.item)) >= (s.qty || 1) : async () => false;
        const ok = await this.hunt(monster, done, s.cell ? { cell: s.cell, pad: s.pad } : null, s.item ? 30 * 60000 : 3 * 60000, s.item ? [s.item] : []);
        if (s.item && !ok) throw new Error(`could not get ${s.item} x${s.qty}`);
        return null;
      }
      case 'quest': {
        const q = knowledge.quest(s.quest);
        if (!(await this.questAvailable(s.quest))) return null;
        await this.join(s.map);
        await this.accept(s.quest);
        const reqs = (q && q.Requirements) || [];
        for (const r of reqs) {
          const id = r.ItemID ?? r.ID; const need = Number(r.iQty ?? r.Quantity ?? 1); const name = r.sName || r.Name;
          const mon = s.monsters.length ? s.monsters[Math.min(reqs.indexOf(r), s.monsters.length - 1)] : '*';
          if ((await this.countId(id)) >= need) continue;
          const ok = await this.hunt(mon, async () => (await this.countId(id)) >= need, null, 30 * 60000, [name]);
          if (!ok) throw new Error(`could not collect ${name} x${need} from ${mon}`);
        }
        if (!reqs.length) await this.hunt(s.monsters[0] || '*', () => this.canComplete(s.quest), null, 20 * 60000);
        if (await this.canComplete(s.quest)) { await this.complete(s.quest); this.journal(`completed quest ${s.quest} ${q ? q.Name : ''}`); }
        return null;
      }
      case 'mapitem': {
        if (s.quest && !(await this.questAvailable(s.quest))) return null;
        if (s.map) await this.join(s.map);
        if (s.quest) await this.accept(s.quest);
        for (const id of String(s.note).split(',').filter(Boolean).map(Number)) {
          for (let k = 0; k < (s.qty || 1); k++) { await this.client.fn('world.getMapItem', id).catch(() => null); await this.wait(1200); }
        }
        if (s.quest && await this.canComplete(s.quest)) await this.complete(s.quest);
        return null;
      }
      case 'buy': case 'buyquest': {
        if (s.item && (await this.count(s.item)) >= (s.qty || 1)) return null;
        if (s.quest && !(await this.questAvailable(s.quest))) return null;
        if (s.quest) { await this.join(s.map); await this.accept(s.quest); }
        await this.buy(Number(s.note), s.item, s.qty || 1, s.map);
        if (s.quest && await this.canComplete(s.quest)) await this.complete(s.quest);
        return null;
      }
      default: return null;
    }
  }

  // Skua scripts run in Skua's own engine (lib/skua/engine.js): the real C# code, compiled and executed as in
  // Skua. The old translator is only a fallback, for when the engine is missing or cannot compile a script.
  // Skua tools whose whole job is spending AC (Treasure Chest / Wheel of Doom spins, the 250 AC Generosity Coin
  // donation): never run, whoever asks (the owner 2026-10-13: the bots' ACs are only AQW's free ones).
  static get AC_SPENDERS() { return /TreasureChestSpam|WheelOfDoomSpam|GenerosityCoin/i; }
  async runScript(scriptPath, budgetMs, entry = null, opts = {}) {
    if (Bot.AC_SPENDERS.test(String(scriptPath))) { this.journal(`not running ${scriptPath}: it spends AC`, 'warn'); return false; }
    const mode = this.settings.scriptEngine || (this.hub && this.hub.settings && this.hub.settings.scriptEngine) || 'skua';
    if (mode !== 'translate' && skuaEngine.available() && this.hub && this.hub.engineFor) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await this.runSkua(scriptPath, budgetMs, entry, opts);
        } catch (e) {
          if (e instanceof Stop || !e.fallback) throw e;
          // All four engines share one compile cache (Scripts/Cached-Scripts). Right after it is emptied (a Skua
          // "Reset Scripts", 2026-10-10) they rebuild it at the same moment, and one can read another's half-written DLL:
          // "The type or namespace name 'LordOfOrder' could not be found" - the next compile worked. Retry once first.
          if (attempt === 1 && /error CS0246|Error compiling included file/.test(String(e.message))) {
            this.journal(`Skua engine could not compile ${scriptPath}${entry ? `#${entry}` : ''} - trying again in 30 s (shared compile cache)`, 'warn');
            await this.wait(30000);
            continue;
          }
          this.journal(`Skua engine could not run ${scriptPath}${entry ? `#${entry}` : ''} (${String(e.message).split(/\r?\n/)[0].slice(0, 200)}) - using the translator`, 'warn');
          break;
        }
      }
    }
    if (mode !== 'translate' && !skuaEngine.available()) this.journal(`Skua engine not installed here - ${scriptPath} runs through the translator`, 'warn');
    return this.runTranslated(scriptPath, budgetMs, entry);
  }

  // The item a running Skua script is farming and the kills it took (lib/droprates.js): a farm step logs once and then
  // kills in silence until the drop comes, so the watchdog asks hub.farmState instead of calling it stuck (2026-10-13).
  // Other lines in between (SaveState trips to /whitemap, class swaps, anti-AFK jumps) keep the farm; a new quest or
  // story check ends it.
  farmLine(msg) {
    const f = droprates.parseStep(msg);
    if (!f) { if (droprates.endsFarm(msg)) this.farm = null; return; }
    const same = this.farm && this.farm.items.join('|').toLowerCase() === f.items.join('|').toLowerCase()
      && String(this.farm.monster || '').toLowerCase() === String(f.monster || '').toLowerCase();
    if (same) { this.farm.line = f.line; return; }
    this.farm = { ...f, map: null, since: Date.now(), kills: 0, lastKillAt: 0, gotAt: 0 };
  }
  // A kill (addGoldExp typ m, `id` = MonMapID) counts for the farm only when it is the step's monster, or - for a step
  // that names no monster ("Farming Monster Blood (0/1)") - any kill on the map of the step's first kill. Skua logs the
  // step before it joins the map (Oren: "Farming Monster Blood" on /bocklincastle, Dethrix on /ebondungeon 3 s later).
  farmKill(monMapId) {
    const f = this.farm;
    if (!f) return;
    const w = this.client && this.client.w;
    if (f.monster) {
      const mon = w && (w.monsters || []).find((m) => Number(m.MonMapID) === Number(monMapId));
      if (mon && String(mon.strMonName || '').toLowerCase() !== f.monster.toLowerCase()) return;
      if (!mon && w && (w.monsters || []).length) return;
    } else if (w && w.strMapName) {
      const here = String(w.strMapName).toLowerCase();
      if (!f.map) f.map = here;
      else if (here !== f.map) return;
    }
    f.kills++;
    f.lastKillAt = Date.now();
    if (this.hub && this.hub.dropRates) this.hub.dropRates.kill(this.id, f.items);
  }
  // One of the farm's items arrived (a drop shown, or addItems for temp items and rewards).
  farmGot(name) {
    const f = this.farm;
    if (!f || !name) return;
    const n = String(name).trim().toLowerCase();
    const item = f.items.find((x) => x.toLowerCase() === n);
    if (!item) return;
    const now = Date.now();
    f.got = f.got || {};
    if (now - (f.got[n] || 0) < 3000) return;   // a drop and its pickup are one drop
    f.got[n] = now;
    f.gotAt = now;
    if (this.hub && this.hub.dropRates) this.hub.dropRates.drop(this.id, item);
  }
  // A server stack that stops counting (2026-10-20, Sable's Fiend Seals): a grant raced a turn-in and from then on
  // every addItems for that item answered iQtyNow 1 with the same CharItemID - 790 seals, never 25, until the watchdog
  // parked the goal as a "rare drop". One or two repeats are the server's normal lag (stackAfterGrant); a long run of
  // grants with the same count below the stack cap means the server's copy is stuck, and a relog rebuilds it.
  static get STACK_STUCK_GRANTS() { return 12; }
  stackWatch(id, it, now = Date.now()) {
    if (!it || !(Number(it.iQty) > 0) || it.iQtyNow == null) return false;
    const w = (this._stackWatch = this._stackWatch || new Map());
    if (it.iStk) (this._stackCap = this._stackCap || new Map()).set(String(id), Number(it.iStk));
    const cap = (this._stackCap && this._stackCap.get(String(id))) || 0;
    const qty = Number(it.iQtyNow);
    const s = w.get(String(id));
    if (!s || s.qty !== qty) { w.set(String(id), { qty, n: 1 }); return false; }
    s.n++;
    if (s.n < Bot.STACK_STUCK_GRANTS || (cap ? qty >= cap : qty !== 1)) return false;
    if (this._stackStuckAt && now - this._stackStuckAt < 30 * 60000) return false;   // one relog per 30 min
    this._stackStuckAt = now;
    w.clear();
    const name = (it && it.sName) || this.itemNameOf(id);
    this.journal(`server stack stuck: ${s.n} grants of ${name} all came back as ${qty} - logging out and back in to fix the count`);
    this.emit('stackStuck', { id: Number(id), name, qty, grants: s.n });
    return true;
  }

  itemNameOf(id) {
    const me = this.client && this.client.w && this.client.w.myAvatar;
    for (const k of ['items', 'tempitems']) for (const it of (me && me[k]) || []) if (Number(it.ItemID) === Number(id)) return it.sName || null;
    const seen = this.dropNames && this.dropNames.get(Number(id));
    return (seen && seen.name) || null;
  }

  async runSkua(scriptPath, budgetMs, entry = null, opts = {}) {
    let target = scriptPath;
    if (entry && entry !== 'ScriptMain') {
      try { target = skuaEntry.wrapper(P.SCRIPTS, scriptPath, entry, path.join(this.dir, 'skua', 'entry'), opts.args || ''); } catch (e) { e.fallback = true; throw e; }
    } else {
      // A library script that is broken upstream runs from Seraph's corrected copy (script-fixes/, lib/scriptfix.js).
      const fix = scriptfix.resolve(scriptPath);
      if (fix && fix.path) { target = fix.path; this.journal(`using Seraph's fixed copy of ${scriptPath}: ${fix.why}`); }
      else if (fix && fix.retired) this.journal(`${scriptPath} changed upstream, so Seraph's fix is retired - running the library version`, 'warn');
      else if (fix && fix.failed) this.journal(`Seraph's fix for ${scriptPath} no longer applies (${fix.detail}) - running the library version`, 'warn');
    }
    const eng = await this.hub.engineFor(this);
    const label = `${scriptPath}${entry ? `#${entry}` : ''}`;
    // The whole bank for this login before the script looks at it (the owner, 2026-10-09: bots farmed what they owned after
    // a relog). Skua's own Bank.Load waits only 2 s; engine.holdBank covers the loads it makes later.
    // A stop in this wait (before the try below) must still give the engine slot back, or the pool shrinks for good.
    try { await this.bankReady().catch(() => false); } catch (e) { this.hub.engineDone(this); throw e; }
    this.scriptActivityAt = Date.now();   // this run's clock for the watchdog, never the last run's
    this.scriptStep = null;
    this.scriptStepRaw = null;
    this.farm = null;
    const limited = Number.isFinite(budgetMs) && budgetMs > 0;
    if (!limited) budgetMs = Infinity;
    this.journal(`Skua engine: ${label} (${limited ? `budget ${Math.round(budgetMs / 60000)} min` : 'no time limit: runs until it is done or stops making progress'})`);
    const ultra = /^Ultras\/(\w+)\.cs$/i.exec(String(scriptPath).split('\\').join('/'));
    if (ultra && this.hub && this.hub.announceFight) this.hub.announceFight(this, ultra[1].replace(/([a-z])([A-Z])/g, '$1 $2'), ultra[1].toLowerCase());
    // Relog loop (seen 2026-09-19 in the Tower of Mirrors chain, 164 relogs in an hour): Skua's quest recovery relogs,
    // the game wipes temp items on relog, so a quest that needs temp items can never recover. Four relogs in 10 min
    // end the script; the brain moves on and the next chunk starts the step fresh.
    const relogs = [];
    const onRelog = (l) => {
      if (!/Relogin Triggered/.test(l.msg || '')) return;
      const now = Date.now();
      relogs.push(now);
      while (now - relogs[0] > 10 * 60000) relogs.shift();
      if (relogs.length >= 4 && !blocked) blocked = `Skua relogged ${relogs.length}x in 10 min (${String(l.msg).replace(/^.*Relogin Triggered:\s*/, '').slice(0, 80)})`;
    };
    // Script progress for the watchdog: a Skua log line that isn't one of the last few (story steps, shops and walking
    // have no kills, but a loop repeats itself). The newest such line is the step the script is on (`scriptStep`).
    const recentMsgs = [];
    // The owner's gold rule (2026-10-15): a script never grinds gold for itself. CoreFarms logs "Farming N gold using X
    // Method" when it starts (Gold, BattleGroundE, HonorHall, SCW); Nova's AFDL bought 25 Gold Vouchers that way and
    // sat at /battlegrounde for 12.5 M. The script stops, the brain does other work and comes back once the gold is
    // there - unless nothing else is left (opts.goldOk, brain step 8).
    let goldStop = null;
    const onGold = (l) => {
      if (opts.goldOk || goldStop) return;
      const m = /Farming ([\d,.]+) gold\b/i.exec(String(l.msg || ''));
      const want = m ? Number(m[1].replace(/[,.]/g, '')) : 0;
      if (want > 0 && this.goldNow() < want) goldStop = want;
    };
    const onLog = (l) => {
      onRelog(l);
      if (l.kind === 'script') onGold(l);
      if (l.kind === 'script') {
        const m = String(l.msg || '').replace(/^\[\d\d:\d\d:\d\d\]\s*/, '').replace(/\d+/g, '#');
        if (!recentMsgs.includes(m)) { this.scriptActivityAt = Date.now(); this.scriptStep = m.slice(0, 160); recentMsgs.push(m); if (recentMsgs.length > 8) recentMsgs.shift(); }
        // The same line with its numbers ("Sapphire Orb 29/100"): scriptStep blanks them, so hub.requestHelp could not tell
        // a farm step from a one-off and the Legion Lich Lord call ended at the first kill again (2026-10-13).
        if (m.slice(0, 160) === this.scriptStep) this.scriptStepRaw = String(l.msg || '').replace(/^\[\d\d:\d\d:\d\d\]\s*/, '').slice(0, 160);
        this.farmLine(l.msg);
      }
      // What the script took out of the bank stays out (keepNames): help calls banked the Nulgath materials the
      // VHL / AFDL scripts had just unbanked, and the scripts unbanked them again on the next run (2026-10-08).
      const unbanked = /\(Unbank\)\s*✅\s*(.+?) successfully moved from bank/.exec(String(l.msg || ''));
      if (unbanked) (this.scriptUnbanked = this.scriptUnbanked || new Map()).set(unbanked[1].trim().toLowerCase(), Date.now());
      if (l.kind === 'script') this.makeRoomFor(l.msg);
      // v3's seat class not in the skua.swf model (2026-10-19: Nova got Void Highlord after her last login, the model
      // is from the login, and Warden + Engineer were called off at 04:00 - hub.raidDone relogs and keeps the try).
      const seat = /\[PartyLayout:[^\]]*\] Could not equip (.+?)\.?\s*$/.exec(String(l.msg || ''));
      if (seat) this.seatEquipFailed = { cls: seat[1].trim(), at: Date.now() };
      // The raid script saw its boss go down (hub.raidDone counts it as a won fight even without an Attempt report).
      if (l.kind === 'script' && /\[BossDown\] The boss is down|\(Fight\) .+ defeated\. Finishing quest/.test(String(l.msg || ''))) this.bossDownAt = Date.now();
      // SeraphUltras' attempt record (lib/ultras.js): one line per Attempt with outcome, boss HP and deaths.
      const att = l.kind === 'script' && /\[UltraAttempt\]/.test(String(l.msg || '')) ? require('./ultras').attempt(l.msg) : null;
      if (att) {
        const hp = att.bossMaxHp ? `${Math.round((att.bossHp / att.bossMaxHp) * 100)}% boss HP left` : '';
        att.stats = this.combatStats();
        const st = att.stats ? `; ${Bot.statsText(att.stats)}` : '';
        this.journal(`ultra attempt: ${att.boss} ${att.outcome} as ${att.class} (${att.role}, comp ${att.comp})${hp ? `, ${hp}` : ''}, ${(att.deaths || []).length} death(s)${st}`);
        if (this.hub && typeof this.hub.raidAttempt === 'function') this.hub.raidAttempt(this, att);
      }
      if (l.kind === 'script') this.journal(`[skua] ${l.msg}`);
      else if (l.kind === 'error') this.journal(`[skua] ${l.msg}`, 'error');
      const fight = /Doing Quest: \[(\d+)\]/.exec(String(l.msg || ''));
      if (fight && WATCH_QUESTS[fight[1]] && this.hub && this.hub.announceFight) this.hub.announceFight(this, ...WATCH_QUESTS[fight[1]]);
    };
    // The owner's drop rule holds in Skua scripts too: AC drops are always taken, whatever the script's list says - but
    // only while there is room in the stack. Pikeman and Blazebinder Badges sat at their 1000 cap and every kill
    // asked for them again (Nova, 2026-09-20).
    // Progress for the watchdog besides new log lines: items the script gains (quest items, its own pickups, rewards)
    // and quests it turns in. Kills and XP are not: Valen killed Earth Elementals for six hours for an item that
    // could never drop. `itemProgress` only ever grows, so the watchdog can compare it across runs.
    const acAsked = new Map();   // our own AC pickups (below) are the owner's rule, not the script's progress
    const gained = () => { this.scriptActivityAt = Date.now(); this.itemProgress = (this.itemProgress || 0) + 1; };
    // An item counts only when the character holds more of it than ever before: temp items farmed again after a
    // relog (the game wipes them on logout) are not progress, a slow rare drop is. The packet is already applied
    // to the world when 'sfs' fires, so the bags hold the new quantity.
    const high = this.itemHigh || (this.itemHigh = new Map());
    const held = (id) => { const me = this.client.w && this.client.w.myAvatar; let n = 0; for (const k of ['items', 'tempitems']) for (const it of (me && me[k]) || []) if (Number(it.ItemID) === id) n += Number(it.iQty) || 0; return n; };
    const newHigh = (id) => { const n = held(Number(id)); if (n <= (high.get(Number(id)) || 0)) return false; high.set(Number(id), n); return true; };
    const onSfs = (p) => {
      if (!p || p.kind !== 'json' || !p.data) return;
      const d = p.data;
      // Turn-ins are remembered by quest: an ultra raid counts as a kill when the boss's quest came back (hub.raidDone).
      // A turn-in uses its items up, so the next round farms them again from 0: that is progress, not a relog refill.
      // The marks stayed at the old peak and Nova's Blacksmithing rep (Hydra Scale Piece 77 -> 3 -> 63) was killed as
      // "no progress for 30 min" while it gained one every 30 s (2026-10-08).
      if (d.cmd === 'ccqr' && Number(d.bSuccess) === 1) { high.clear(); (this.turnedIn = this.turnedIn || new Map()).set(Number(d.QuestID), Date.now()); return gained(); }
      // A level-up is progress; so is every kill on the maps Skua's Farm.Experience grinds on (XP_MAPS: /icestormarena,
      // /icestormunder for levels 61-75, /battlegrounde) - no item drops there, and half an hour between levels is
      // normal near 100. Only /icestormarena counted, so Valen7's Valiance and Nova7's Verus DoomKnight and Ravenous
      // were parked as stuck while they killed ~20 a minute in /icestormunder (2026-09-22).
      if (d.cmd === 'levelUp') return gained();
      if (d.cmd === 'addGoldExp' && Bot.xpMap(this.client.w && this.client.w.strMapName)) return gained();
      if (d.cmd === 'addItems') { let any = false; for (const id of Object.keys(d.items || {})) if (newHigh(id)) any = true; if (any) gained(); return; }
      if (d.cmd === 'getDrop') { if (Number(d.bSuccess) === 1 && !(Date.now() - (acAsked.get(Number(d.ItemID)) || 0) < 15000) && newHigh(d.ItemID)) gained(); return; }
      if (d.cmd !== 'dropItem') return;
      for (const [id, it] of Object.entries(d.items || {})) {
        const nid = Number(id);
        if (Number(it.bCoins) !== 1 || this.dropHeld(nid)) continue;
        (this.dropNames = this.dropNames || new Map()).set(nid, { name: it.sName, ac: true });
        setTimeout(async () => {
          if (this.dropHeld(nid)) return;
          const stk = Number(it.iStk) || 0;
          if (stk) (this.dropStk = this.dropStk || new Map()).set(nid, stk);
          if (stk && (await this.count(it.sName).catch(() => 0)) + this.bankedCount(it.sName) >= stk) { this.dropFull(nid, it.sName, { stk }); return; }
          acAsked.set(nid, Date.now());
          this.client.send(`%xt%zm%getDrop%${this.client.w.curRoom}%${nid}%`).catch(() => null);
        }, 1200);
      }
    };
    // A closed map: the server answers `"birthday" is not available.` and many scripts retry Join forever. Five refusals
    // in 2 min end the script with that reason (an event script then counts as failed for today, see brain.js).
    const refused = [];
    let blocked = null;
    const onRefused = (p) => {
      if (!p || p.kind !== 'xt' || p.cmd !== 'warning') return;
      const m = /"([^"]+)" is not available/i.exec(String((p.args || [])[0] || ''));
      if (!m) return;
      const now = Date.now();
      refused.push(now);
      while (now - refused[0] > 120000) refused.shift();
      if (refused.length >= 5 && !blocked) blocked = `/${m[1]} is unavailable right now (the server refused it ${refused.length} times)`;
    };
    eng.on('log', onLog);
    if (this.client.headless) { this.client.on('sfs', onSfs); this.client.on('sfs', onRefused); }
    // A boss with a known set-up in this cell: switch before the first death (hub.preFightTick, fightplan.preFight).
    let preBusy = false;
    const preFight = setInterval(() => {
      if (preBusy || !this.hub || !this.hub.preFightTick) return;
      preBusy = true;
      this.hub.preFightTick(this).catch(() => null).finally(() => { preBusy = false; });
    }, 4000);
    this.scriptStats = { started: Date.now(), script: label };
    // CoreBots' own options file for this character: Seraph's room and class choices (lib/skua/cbo.js).
    try {
      const cbo = require('./skua/cbo');
      const user = this.client.headless ? (this.client.login && this.client.login.username) : accounts.credentials(this.account).user;
      cbo.write(skuaEngine.optionsDir(), user, await cbo.keysFor(this));
    } catch (e) { this.journal(`could not write the CoreBots options: ${e.message}`, 'warn'); }
    // AC items this run may buy (a goal's allowAc, e.g. join-legion's Undead Warrior); none otherwise (swfworld.acLocked).
    this.client.acAllow = new Set((opts.allowAc || []).map((n) => String(n).toLowerCase()));
    try {
      // CoreBots stops at once ("Please log-in before starting the bot") while the character is still joining.
      for (let i = 0; i < 60 && !(this.client.state && this.client.state.loaded) && !this.stopFlag; i++) await sleep(1000);
      for (let attempt = 1; ; attempt++) {
        const turn = takeCompileTurn(eng);
        try {
          await turn.ready;
          await eng.run(target, { options: opts.options, storage: opts.storage, answers: opts.answers || this.settings.scriptAnswers });
          turn.done();
          break;
        } catch (e) {
          turn.done();
          // Two engines compiling the same script at once race on Skua's shared compile cache
          // (Scripts/Cached-Scripts/<hash>-<name>.dll): the loser reads a file the winner just replaced (Sable7
          // and Valen7 both started BlazeBeardStory after a restart, 2026-09-21). The second try finds it built.
          if (attempt === 1 && /Cached-Scripts/i.test(String(e.message))) {
            this.journal('Skua compile cache busy (another character is compiling the same script) - trying again', 'warn');
            await sleep(4000 + Math.random() * 4000);
            continue;
          }
          // The bot loop restarts in seconds, but a Skua script can take ~45 s to stop: the new order then failed three
          // times with "a script is already running" and was dropped (Oren7, 2026-09-21). Stop it and wait.
          if (attempt <= 2 && /already running/i.test(String(e.message))) {
            this.journal('the previous Skua script is still stopping - waiting for it before starting this one', 'warn');
            await eng.stop();
            for (let i = 0; i < 60 && eng.running && !this.stopFlag; i++) await sleep(1000);
            continue;
          }
          if (/compil|no script at|not installed|did not start|exited|ENOENT|EACCES|spawn/i.test(e.message)) e.fallback = true;
          throw e;
        }
      }
      // Offline stops the script, except while the script itself is switching servers (Servers.Logout/Connect).
      let lostAt = 0;
      const lost = () => {
        if (this.client.state && this.client.state.loaded) { lostAt = 0; return false; }
        if (!lostAt) lostAt = Date.now();
        return Date.now() - lostAt > (this.client.scriptDriven ? 180000 : 5000);
      };
      const r = await eng.waitDone(budgetMs, () => this.stopFlag || lost() || !!blocked || !!goldStop);
      if (this.stopFlag) throw new Stop('stopped');
      if (goldStop) {
        this.journal(`${label} wants ${Math.round(goldStop / 1e5) / 10} M gold and I have ${Math.round(this.goldNow() / 1e5) / 10} M - not grinding gold for it: doing other work and coming back when the gold is there`);
        return { ok: true, engine: 'skua', goldWait: goldStop };
      }
      if (blocked) throw new Error(`script stopped: ${blocked}`);
      if (lostAt && !(this.client.state && this.client.state.loaded)) throw new Error('disconnected while the script was running');
      if (r.error) throw new Error(`script error: ${r.error}`);
      this.journal(`Skua engine: ${label} ${r.timedOut ? 'stopped at its time budget' : 'finished'}`);
      return { ok: true, engine: 'skua', timedOut: !!r.timedOut };
    } finally {
      clearInterval(preFight);
      eng.removeListener('log', onLog);
      this.client.removeListener('sfs', onSfs);
      this.client.removeListener('sfs', onRefused);
      this.client.acAllow = null;
      this.scriptStats = null;
      this.farm = null;
      this.hub.engineDone(this);
    }
  }

  async runTranslated(scriptPath, budgetMs, entry = null) {
    const t = translate(P.SCRIPTS, scriptPath, entry || 'ScriptMain');
    if (!t.steps.length && entry) { this.journal(`${scriptPath}#${entry} has no runnable steps - trying the whole script`, 'warn'); return this.runTranslated(scriptPath, budgetMs); }
    this.journal(`script ${t.title} (${scriptPath}): ${t.steps.length} steps`);
    return this.runSteps(t.steps, t.title, budgetMs);
  }

  // ---------------- tasks ----------------
  async runTask(t) {
    switch (t.type) {
      case 'armyFarm': {
        await this.join(t.map, t.cell || 'Enter', 'Left');
        if (t.cell) await this.jump(t.cell, 'Left');
        if (t.quests && t.quests.length) this.register(t.quests);
        const mine = t.item ? async () => (await this.count(t.item)) >= t.qty : async () => false;
        const armyOver = () => !(this.hub && this.hub.army && this.hub.army.id === t.army);
        this.journal(`army: farming ${t.item || t.monster}${t.item ? ` x${t.qty}` : ''} with the party`);
        await this.hunt(t.monster || '*', async () => (await mine()) || armyOver(), t.cell ? { cell: t.cell, pad: 'Left' } : null, 3 * 3600000, t.item ? [t.item] : []);
        // WaitForParty: done ourselves, keep killing for the others until the whole party has its share.
        if (!armyOver() && !(this.hub.armyDone(this, t.army))) {
          this.journal('army: my share is done - helping the others finish');
          await this.hunt(t.monster || '*', async () => armyOver(), t.cell ? { cell: t.cell, pad: 'Left' } : null, 3 * 3600000, []);
        }
        this.registered.clear();
        return true;
      }
      case 'crewHunt': return this.crewHunt(t);
      case 'assist': {
        // Go to whoever called for help and fight what they are fighting until it dies. Several calls can be open at once
        // (Seraph 5 squads): this task's own call, by its id.
        const call = () => (this.hub && (this.hub.helpById ? this.hub.helpById(t.id) : (this.hub.help && this.hub.help.id === t.id ? this.hub.help : null))) || null;
        if (!call()) { this.journal(`the ${t.monster} call is over`); return true; }
        // My seat in the party's line-up (hub.partySeat, lib/partycomp.js): changed before the join, out of combat.
        // Four ArchPaladins fought every call until 2026-10-13; the owner wants at least one support, then what the boss needs.
        const seat = this.hub.partySeat ? await this.hub.partySeat(this, call()).catch(() => null) : null;
        if (seat) await this.takeSeat(seat, t).catch((e) => this.journal(`party seat ${seat.cls}: ${e.message} - fighting with what I have`, 'warn'));
        try {
          await this.join(`${t.map}-${t.room || this.roomNumber()}`, t.cell || 'Enter', t.pad || 'Left');
        } catch (e) {
          // A map this character can't enter (chaoslord needs the 13 Lords of Chaos story): it leaves the call instead
          // of failing and being sent back every few minutes (check-up 2026-10-04: 5 failed joins in 10 min).
          if (/could not join/i.test(String(e && e.message)) && this.hub && this.hub.helpUnreachable) { this.hub.helpUnreachable(this, t, e.message, e.code === 'ROOM_FULL'); return true; }
          throw e;
        }
        if (t.cell) await this.jump(t.cell, t.pad || 'Left');
        this.journal(`helping ${t.who} against ${t.monster} in ${t.map}`);
        // The call's own deadline, not a copy: a farm call (hub.requestHelp farm) grows with every kill.
        // A join can land in whitemap (Sable, 2026-10-11): she stood in "whitemap r3" for the whole call.
        let mapCheck = 0;
        const done = async () => {
          const h = call();
          if (!h || Date.now() > h.until) return true;
          if (Date.now() - mapCheck > 15000) {
            mapCheck = Date.now();
            const m = await this.map().catch(() => null);
            if (m && m !== t.map) {
              this.journal(`in ${m} instead of ${t.map} for ${t.who}'s ${t.monster} - joining again`, 'warn');
              // A full room is the same answer as at the start: leave the call (Vexa asked to get back into her own
              // Alteon room 167 times while a helper held its one seat, 2026-10-26).
              const err = await this.join(`${t.map}-${t.room || this.roomNumber()}`, t.cell || 'Enter', t.pad || 'Left').then(() => null, (e) => e);
              if (err && /could not join/i.test(String(err.message)) && this.hub && this.hub.helpUnreachable) {
                this.hub.helpUnreachable(this, t, err.message, err.code === 'ROOM_FULL');
                return true;
              }
            }
          }
          return false;
        };
        const h0 = call();
        const maxMs = Math.max((t.minutes || 8) * 60000, h0 && h0.hardUntil ? h0.hardUntil - Date.now() : 0);
        let ok;
        try { ok = await this.hunt(t.monster || '*', done, t.cell ? { cell: t.cell, pad: t.pad } : null, maxMs, []); } finally { this.seatMode = null; }
        if (this.hub && this.hub.helpDone) this.hub.helpDone(this, t, ok);
        return ok;
      }
      case 'farmLevel': return this.farmLevel(t);
      case 'kill': {
        await this.join(t.map, t.cell || 'Enter', t.pad || 'Left');
        this.registered.clear(); this.register(t.quests || []);
        const until = Date.now() + (t.minutes || 60) * 60000;
        const done = t.item ? async () => (await this.count(t.item)) >= (t.qty || 1) : async () => Date.now() > until;
        await this.hunt(t.monster || '*', done, t.cell ? { cell: t.cell, pad: t.pad || 'Left' } : null, (t.minutes || 60) * 60000, t.item ? [t.item] : this.questWanted());
        this.registered.clear();
        return true;
      }
      case 'quest': return this.runStep({ kind: 'quest', quest: t.id, map: t.map, monsters: t.monster ? [t.monster] : [] });
      // No `hours` = no time limit (the owner, 2026-09-21): a script runs until it finishes, stops making progress
      // (hub.watchdog) or something more important is due (hub.preempt). Only an explicit `hours` time-boxes it.
      case 'script':
        // An army fight of a crew that is over (or on another stage): nothing to wait for, the army would never assemble.
        if (t.crewScript && !(this.hub && this.hub.crew && this.hub.crew.id === t.crew && this.hub.crew.token === t.token)) { this.journal('the crew fight is over - dropping the army task'); return true; }
        return this.runScript(t.path, Number(t.hours) > 0 ? t.hours * 3600000 : Infinity, t.entry || null, { args: t.args || '', options: t.options, storage: t.storage, answers: t.answers, allowAc: t.allowAc, goldOk: !!t.goldOk });
      case 'daily': {
        const d = knowledge.dailies().find((x) => x.name === t.name);
        if (!d) throw new Error(`unknown daily ${t.name}`);
        // A step left behind means the quest was not turned in: NCS Gem counted as "done" on 2026-09-27 while its
        // Shadow Lord step had failed twice, so it was never tried again that day.
        const ok = await this.runSteps(d.steps, `daily ${d.name}`, 45 * 60000);
        if (ok && this.lastStepsFailed) { this.journal(`daily ${d.name}: ${this.lastStepsFailed} step(s) left undone - not finished`, 'warn'); return false; }
        return ok;
      }
      case 'buy': return this.buy(t.shop, t.item, t.qty || 1, t.map);
      case 'equip': return this.equip(t.item);
      case 'set': return t.save ? this.saveSet(t.name) : this.equipSet(t.name);
      case 'enhance': return this.enhanceEquipped();
      case 'sellJunk': return this.sellJunk();
      case 'tidy': return this.tidyWardrobe();
      case 'follow': return this.follow(t);
      case 'assist': return this.assist(t);
      case 'bankAc': return this.bankAc(0, Bot.ROOM.target);
      case 'style': return this.dressUp();
      case 'barber': return this.visitBarber();
      case 'wish': return this.getWish(t);
      case 'join': return this.join(t.map, t.cell || 'Enter', t.pad || 'Spawn');
      case 'gotoPlayer': return this.gotoPlayer(t.player);
      case 'gear': return this.gearUp(t.kind || 'fight', t.monster);
      case 'probeEvent': return this.probeEvent(t);
      case 'wait': return this.wait((t.minutes || 1) * 60000);
      default: this.journal(`unknown task ${JSON.stringify(t)}`, 'warn'); return false;
    }
  }

  // One stage of a crew daily (lib/crewdaily.js): the party's room, the stage's boss, until the crew moves on. The ones who
  // need the daily take its quest first (its items only drop while it is active) and farm the item; the helpers just fight.
  // Nobody leaves for a death or a full bag: the hub decides when a stage is over (every needy character holds the item).
  async crewHunt(t) {
    const hub = this.hub;
    const live = () => !!(hub && hub.crew && hub.crew.id === t.crew && hub.crew.token === t.token);
    if (!live()) return true;
    const seat = hub.partySeat && hub.crew.h ? await hub.partySeat(this, hub.crew.h).catch(() => null) : null;
    if (seat) await this.takeSeat(seat, t).catch((e) => this.journal(`crew seat ${seat.cls}: ${e.message} - fighting with what I have`, 'warn'));
    if (!live()) return true;
    await this.join(`${t.map}-${t.room || this.roomNumber()}`, t.cell || 'Enter', t.pad || 'Left');
    if (t.cell) await this.jump(t.cell, t.pad || 'Left');
    if (t.needy && t.quest && !(await this.inProgress(t.quest)) && (await this.questAvailable(t.quest))) await this.accept(t.quest);
    this.journal(`crew daily ${t.daily}: ${t.monster} in ${t.map}${t.needy ? ` for ${t.item} ${t.qty}` : ' (helping)'}`);
    let mapCheck = 0;
    const done = async () => {
      if (!live()) return true;
      if (Date.now() - mapCheck > 15000) {
        mapCheck = Date.now();
        const m = await this.map().catch(() => null);
        if (m && m !== t.map) await this.join(`${t.map}-${t.room || this.roomNumber()}`, t.cell || 'Enter', t.pad || 'Left').catch(() => null);
      }
      return false;
    };
    try { await this.hunt(t.monster || '*', done, t.cell ? { cell: t.cell, pad: t.pad } : null, (t.minutes || 20) * 60000, t.needy && t.item ? [t.item] : []); } finally { this.seatMode = null; }
    return true;
  }

  async farmLevel(t) {
    const target = t.to || 100;
    const chunkEnd = Date.now() + (t.minutes || 30) * 60000;
    while (Date.now() < chunkEnd) {
      this.check();
      let lvl = 0;
      await this.waitFor(async () => (lvl = await this.level()) > 0, 30000, 1000);
      if (lvl >= target) return true;
      const partyLvl = this.hub && this.hub.levelPartyLevel ? await this.hub.levelPartyLevel(this).catch(() => null) : null;
      if (partyLvl && partyLvl < lvl && (!this._partyNoteAt || Date.now() - this._partyNoteAt > 600000)) { this._partyNoteAt = Date.now(); this.journal(`leveling with the party at level ${partyLvl}'s spot`); }
      let idx = LEVEL_ROUTES.findIndex((x) => (partyLvl || lvl) < x.below);
      const natural = idx;
      if (this.fallbackUntil && Date.now() < this.fallbackUntil && idx > 0) idx--;
      // Spots that killed this character 3 times stay off-limits for 3 h: step down past every one of them.
      this.dangerSpots = this.dangerSpots || {};
      const banned = (i) => (this.dangerSpots[`${LEVEL_ROUTES[i].map} ${LEVEL_ROUTES[i].cell}`] || 0) > Date.now();
      while (idx > 0 && banned(idx)) idx--;
      // At the bottom of the list there is nothing lower to step down to, and the old loop then walked straight
      // back into the spot it had just banned. Walk back up instead, and if every band is banned, level later.
      while (idx < natural && banned(idx)) idx++;
      if (banned(idx)) { this.journal('every leveling spot for my level is on the avoid list - leveling later', 'warn'); return true; }
      const fallback = idx < natural;
      const r = LEVEL_ROUTES[idx];
      await this.join(r.map, r.cell, r.pad);
      this.registered.clear(); this.register(r.quests);
      const deaths0 = this.stats.deaths;
      const bandEnd = Math.min(chunkEnd, Date.now() + 10 * 60000);
      const started = Date.now();
      // Bug 2026-09-17 (Sable AFK in oaklore): in a fallback band the character is already above the band's level,
      // so a level-based "done" was true at once and the loop spun thousands of times a second without attacking.
      // Fallback bands end on time or deaths only.
      const levelDone = async () => !fallback && !partyLvl && (await this.level()) >= Math.min(target, r.below);
      await this.hunt(r.monster, async () => (await levelDone()) || Date.now() > bandEnd || this.stats.deaths - deaths0 >= 3,
        { cell: r.cell, pad: r.pad }, 10 * 60000, this.questWanted());
      this.registered.clear();
      if (Date.now() - started < 3000 * SCALE) await this.wait(5000);   // a band that ends instantly must never spin
      if (this.stats.deaths - deaths0 >= 3) {
        this.fallbackUntil = Date.now() + 30 * 60000;
        this.dangerSpots[`${r.map} ${r.cell}`] = Date.now() + 3 * 3600000;
        this.journal(`died ${this.stats.deaths - deaths0}x at ${r.map} ${r.cell} - avoiding it for 3 h`, 'warn');
      }
    }
    return true;
  }

  // Party: stay in the leader's room and cell, attack what the leader attacks.
  async follow(t) {
    const leader = this.hub && this.hub.bot(t.leader);
    if (!leader) throw new Error(`leader ${t.leader} not running`);
    const until = Date.now() + (t.minutes || 60) * 60000 * SCALE;
    this.journal(`following ${t.leader}`);
    await this.combat.refresh(this.settings.combatMode);
    while (Date.now() < until) {
      this.check();
      // A party escort (lib/walls.js) ends for everyone at once.
      if (t.escort && !(this.hub && this.hub.walls && this.hub.walls.isOn(t.escort))) { this.journal('the escort is over'); return true; }
      if (leader.current && leader.current.raid) { this.journal(`${t.leader} went into a raid - not following into the ultra room`); return true; }
      const lmap = await leader.map();
      const lcell = await leader.cell();
      // The leader's real room: a Skua script may have joined a public one (crowded content) instead of the party's.
      const larea = String(await leader.g('world.strAreaName', '').catch(() => '')).toLowerCase();
      const lroom = larea.startsWith(`${lmap}-`) ? larea : `${lmap}-${leader.roomNumber()}`;
      if (lmap && ((await this.map()) !== lmap || String(await this.g('world.strAreaName', '').catch(() => '')).toLowerCase() !== lroom)) {
        try { await this.join(lroom); } catch (e) {
          // The leader's room is full: this escort goes on without me (walls.leave), I go back to my own work.
          if (e && e.code === 'ROOM_FULL' && t.escort && this.hub && this.hub.walls && this.hub.walls.leave) {
            this.hub.walls.leave(this, t.escort, 'the room is full');
            return true;
          }
          throw e;
        }
      }
      if (lcell && (await this.cell()) !== lcell) await this.jump(lcell, 'Left');
      if (await this.handleDeath({ cell: lcell, pad: 'Left' })) continue;
      if (this.combat.holding()) { await sleep(300); continue; }
      if (await this.isNull('world.myAvatar.target')) await this.client.call('attackMonsterName', '*').catch(() => null);
      if (!(await this.keepInRange())) { await sleep(300); continue; }
      if (!(await this.combat.tick().catch(() => false))) await this.client.call('useSkill', 0).catch(() => null);
      await this.pickupDrops();
      await sleep(400);
    }
    return true;
  }

  // Boost gear for the job (lib/gear.js). kind: exp | gold | rep | boss | fight. Pulls pieces out of the bank if needed.
  // `keep`: slots left alone (a class kit's weapon, helm and cape, enhanced for that class).
  async gearUp(kind, monster = null, keep = null) {
    let race = null;
    if (monster && monster !== '*') {
      const mons = (await this.client.call('getMonsters').catch(() => [])) || [];
      const m = mons.find((x) => x && String(x.strMonName || '').toLowerCase().includes(String(monster).toLowerCase()));
      race = m && m.sRace ? m.sRace : null;
    }
    const wants = gear.wantsFor(kind, race);
    const picks = gear.plan(await this.items(), wants, await this.bankItems().catch(() => [])).filter((p) => !(keep || []).includes(p.slot));
    let changed = 0;
    for (const p of picks) {
      this.check();
      if (p.inBank) {
        if ((await this.freeSlots()) <= 0) continue;
        await this.client.send(`%xt%zm%bankToInv%${await this.room()}%${p.item.ItemID}%${p.item.CharItemID}%`);
        await this.waitFor(async () => (await this.count(p.name)) > 0, 5000, 300);
        if (this._bank) this._bank.items = this._bank.items.filter((i) => i.CharItemID !== p.item.CharItemID);
      }
      if (await this.equip(p.name)) { changed++; this.journal(`gear: ${p.name} for ${wants.join('+')} (+${p.score}%)`); }
    }
    return changed;
  }

  // The barber (hair shop 1, the shop Yulgar's / Battleon barbers open): the persona picks its hairstyle, hair and eye
  // colours, and armor colours. Packet shapes come from the game client (World.sendChangeColorRequest(skin, hair, eye, HairID)).
  // Colours as 6-digit hex strings ('8E1B2E'): what the character wears now, and what its look on show wants (the
  // look's own colours, else the palette the owner picked, else the persona's barber colours).
  async currentColors() {
    const o = 'world.myAvatar.objData.';
    const h = async (k) => (Number(await this.g(`${o}${k}`, 0)) || 0).toString(16).toUpperCase().padStart(6, '0');
    return { hair: await h('intColorHair'), skin: await h('intColorSkin'), eye: await h('intColorEye'), base: await h('intColorBase'), trim: await h('intColorTrim'), accessory: await h('intColorAccessory') };
  }
  wantedColors(look = this.lookNow) {
    const norm = (c) => (c ? String(c).replace('#', '').toUpperCase().padStart(6, '0') : null);
    const p = this.persona;
    if (!p) return null;
    const own = (look && look.colors) || wardrobe.lookColors(p, look) || null;
    const b = p.barber || {};
    const base = { hair: b.hairColor, eye: b.eyeColor, base: (b.armor || [])[0], trim: (b.armor || [])[1], accessory: (b.armor || [])[2] };
    const c = { ...base, ...(own || {}) };
    const out = {};
    for (const k of ['hair', 'skin', 'eye', 'base', 'trim', 'accessory']) if (c[k]) out[k] = norm(c[k]);
    return Object.keys(out).length ? out : null;
  }
  // The colours put right whenever a look or an outfit goes on (the owner, 2026-10-17: "when they switch outfits make
  // sure their colors are still correct"). One barber trip at most every 10 min, only when something differs.
  async ensureColors(want = this.wantedColors(), why = '') {
    if (!want || this.isGuest()) return false;
    const cur = await this.currentColors();
    const off = Object.keys(want).filter((k) => want[k] !== cur[k]);
    if (!off.length) return false;
    if (this._colorsAt && Date.now() - this._colorsAt < 10 * 60000) return false;
    this._colorsAt = Date.now();
    this.journal(`colours off${why ? ` (${why})` : ''}: ${off.map((k) => `${k} ${cur[k]} -> ${want[k]}`).join(', ')}`);
    return this.visitBarber(want);
  }
  async visitBarber(colors = null) {
    if (this.isGuest()) return false;
    const p = this.persona;
    if (!p || !p.barber) return false;
    const want = colors || this.wantedColors();
    const b = { ...p.barber, ...(want ? { hairColor: want.hair || p.barber.hairColor, eyeColor: want.eye || p.barber.eyeColor, armor: [want.base || p.barber.armor[0], want.trim || p.barber.armor[1], want.accessory || p.barber.armor[2]] } : {}) };
    const skinWant = want && want.skin ? parseInt(want.skin, 16) : null;
    await this.join('yulgar').catch(() => null);
    await this.client.fn('world.sendLoadHairShopRequest', b.shop || 1).catch(() => null);
    await this.waitFor(async () => !(await this.isNull('world.hairshopinfo.hair')), 8000, 400);
    const hairs = (await this.g('world.hairshopinfo.hair', [])) || [];
    await this.client.fn('ui.mcPopup.fClose').catch(() => null);   // the game pops the customize window open
    const o = 'world.myAvatar.objData.';
    const skin = skinWant !== null ? skinWant : Number(await this.g(`${o}intColorSkin`, 0));
    const currentHair = Number(await this.g(`${o}HairID`, 0));
    // The server sends the styles for this character's gender. Keep the list, so the personas' picks can be checked
    // against the real names (knowledge/hairs-<gender>.json).
    const gender = String(await this.g(`${o}strGender`, p.sex === 'female' ? 'F' : 'M'));
    if (hairs.length) { try { fs.writeFileSync(path.join(P.KNOWLEDGE, `hairs-${gender}.json`), JSON.stringify(hairs.map((h) => ({ HairID: h.HairID, sName: h.sName, sFile: h.sFile })))); } catch (e) { /* notes only */ } }
    // Each wish is an exact name or a pattern (case-insensitive), best first.
    let hair = null;
    for (const want of b.hair) {
      const w = String(want).toLowerCase();
      let re = null; try { re = new RegExp(want, 'i'); } catch (e) { re = null; }
      hair = hairs.find((h) => String(h.sName).toLowerCase() === w) || (re && hairs.find((h) => re.test(String(h.sName))));
      if (hair) break;
    }
    const hairId = hair ? Number(hair.HairID) : currentHair;
    const hex = (c) => parseInt(String(c).replace('#', ''), 16);
    await this.client.fn('world.sendChangeColorRequest', skin, hex(b.hairColor), hex(b.eyeColor), hairId);
    await this.wait(1600);
    await this.client.fn('world.sendChangeArmorColorRequest', hex(b.armor[0]), hex(b.armor[1]), hex(b.armor[2]));
    const ok = await this.waitFor(async () => Number(await this.g(`${o}intColorHair`, -1)) === hex(b.hairColor) && Number(await this.g(`${o}intColorTrim`, -1)) === hex(b.armor[1]), 6000, 500);
    this.journal(`barber: ${hair ? hair.sName : 'kept hairstyle'}, hair ${b.hairColor}, eyes ${b.eyeColor}${skinWant !== null ? `, skin ${want.skin}` : ''}, armor ${b.armor.join('/')}${ok ? '' : ' (not confirmed)'}`);
    this.remember('barber', { hair: hair ? hair.sName : null, ok });
    return ok;
  }

  // Wardrobe: wear the owned pieces that best match this persona's style (see lib/stylist.js).
  async dressUp() {
    if (!this.persona || this.isGuest()) return 0;
    const plan = stylist.plan(await this.items(), this.persona);
    this.styleKeep = plan.keep;
    // Armor, helm, cape and weapon are shown over the boost gear now (showLook); only the pet is still worn for looks.
    plan.equip = plan.equip.filter((p) => p.slot === 'pet');
    this._lookAt = Date.now();
    const shownNow = await this.showLook().catch(() => 0);
    this._styleDirty = false;
    let changed = 0;
    let dream = false;
    for (const pick of plan.equip) {
      this.check();
      await this.equip(pick.name);
      // equip() can't tell a refused swap from a done one; only a worn item counts (Valen "wore" the same pet 12 times).
      const worn = ((await this.items()).find((i) => String(i.sName).toLowerCase() === pick.name.toLowerCase()) || {}).bEquip;
      if (!worn) continue;
      changed++;
      if (pick.dream) dream = true;
      this.journal(`style: wearing ${pick.name} (${pick.slot}${pick.dream ? ', a dream piece' : `, score ${pick.score}`})`);
      if (pick.dream) { const line = fashion.say(this.persona, 'wearDream', pick.name); if (line) this.journal(line); }
    }
    // A dream helm, cape or weapon may be unenhanced: bring it up to level so looks never cost stats.
    if (dream && (await this.needsEnhance().catch(() => false))) await this.enhanceEquipped().catch(() => null);
    changed += shownNow;
    if (!changed) this.journal(`style: nothing new that fits ${this.persona.fashion ? this.persona.fashion.identity : this.persona.style.palette}`);
    return changed;
  }

  // Me time for an item no merge script makes (lib/fashion.js routes, from the wiki): farm the monster that drops it,
  // run the quest that rewards it (with the reward picked, for choose-one quests), or find the gold shop on its map
  // that sells it. Runs until the item is owned; the brain's me-time clock (preempt) is what ends a long one.
  async getWish(t) {
    const r = t.route || {};
    const item = t.item || t.wish;
    const have = async () => this.owns(item).catch(() => false);
    if (await have()) return true;
    switch (r.kind) {
      case 'drop': {
        await this.join(r.map, r.cell || 'Enter', r.pad || 'Spawn');
        await this.hunt(r.monster, have, r.cell ? { cell: r.cell, pad: r.pad || 'Left' } : null, 6 * 3600000, [item]);
        return have();
      }
      case 'quest': case 'mapitem': {
        const q = knowledge.quest(r.quest);
        for (let i = 0; i < 60 && !(await have()); i++) {
          this.check();
          if (!(await this.questAvailable(r.quest))) { this.journal(`${item}: quest ${r.quest} is not open to me (done before, locked or member)`, 'warn'); return false; }
          await this.join(r.map);
          await this.accept(r.quest);
          if (r.kind === 'mapitem') {
            for (const id of r.items || []) for (let k = 0; k < (r.qty || 1); k++) { await this.client.fn('world.getMapItem', id).catch(() => null); await this.wait(1200); }
          } else {
            const reqs = (q && q.Requirements) || [];
            for (const req of reqs) {
              const id = req.ItemID ?? req.ID; const need = Number(req.iQty ?? req.Quantity ?? 1);
              const mons = r.monsters || [];
              const mon = mons.length ? mons[Math.min(reqs.indexOf(req), mons.length - 1)] : '*';
              if ((await this.countId(id)) >= need) continue;
              if (!(await this.hunt(mon, async () => (await this.countId(id)) >= need, null, 45 * 60000, [req.sName || req.Name]))) return false;
            }
          }
          if (!(await this.canComplete(r.quest))) return false;
          await this.complete(r.quest, r.rewardId || -1);
          await this.collectRewards(r.quest).catch(() => null);
          await this.pickupDrops([item]).catch(() => null);
          if (q && q.Once) break;
        }
        return have();
      }
      case 'shop': return this.buy(r.shop, item, 1, r.map);
      case 'shopFind': {
        for (const id of r.shops || []) {
          this.check();
          const list = await this.loadShop(id, r.map).catch(() => []);
          if (list.some((i) => String(i.sName).toLowerCase() === String(item).toLowerCase())) return this.buy(id, item, 1, r.map);
        }
        this.journal(`${item}: no shop I know on /${r.map} sells it`, 'warn');
        return false;
      }
      default: return false;
    }
  }

  // A new drop the character likes the look of: say so, and dress up at the next brain tick.
  noticeLook(name) {
    if (!this.persona || !this.persona.fashion) return;
    const s = stylist.score(name, this.persona);
    if (s < 6) return;
    this._styleDirty = true;
    const line = fashion.say(this.persona, s >= 100 ? 'wishGot' : 'dropLove', name);
    if (line) this.journal(line);
    this.remember('crush', { item: name, score: s });
  }

  // ---------------- assist the owner's main account ----------------
  // The main plays by hand (any client). Bots log into the main's server, /goto the main, stay in its cell, wear the
  // class this ultra needs from them (no duplicates across the party) and fight whatever is in the cell.
  async mainInfo(main) {
    const key = String(main).toLowerCase();
    if (await this.isNull(`world.uoTree.${key}`)) return null;
    const cell = await this.g(`world.uoTree.${key}.strFrame`, null);
    const pad = await this.g(`world.uoTree.${key}.strPad`, 'Left');
    return { cell, pad };
  }

  async assist(t) {
    const hub = this.hub;
    const main = t.main;
    const until = Date.now() + (t.minutes || 20) * 60000 * SCALE;
    let lastGoto = 0; let lastMap = null; let misses = 0;
    this.journal(`assisting ${main}`);
    await this.combat.refresh(this.settings.combatMode);
    while (Date.now() < until) {
      this.check();
      while (this.paused && !this.stopFlag) await sleep(300);
      const cfg = hub && hub.assistFor ? hub.assistFor(this) : null;
      if (!cfg) { this.journal('assist switched off'); return true; }
      if (!(await this.playing())) return false;
      if (cfg.server && this.serverName && this.serverName.toLowerCase() !== cfg.server.toLowerCase() && Date.now() - (this._movedAt || 0) > 10 * 60000 * SCALE) {
        this._movedAt = Date.now();
        this.journal(`moving to ${cfg.server} where ${main} plays`);
        try { await this.client.fn('sfc.disconnect'); } catch { /* */ }
        await this.wait(3000);
        await this.ensureLogin();
        continue;
      }
      const info = await this.mainInfo(main);
      if (!info) {
        if (Date.now() - lastGoto > 15000 * SCALE) {
          lastGoto = Date.now();
          if (++misses === 4) this.emit('alert', { title: `Can't reach ${main}`, body: `Is ${main} online on ${cfg.server || this.serverName}?` });
          await this.client.send(`%xt%zm%cmd%${await this.room()}%goto%${main}%`);
        }
        await this.wait(1500);
        continue;
      }
      misses = 0;
      const map = await this.map();
      if (map !== lastMap) { lastMap = map; await this.prepareFor(map, cfg); }
      if (info.cell && (await this.cell()) !== info.cell) await this.jump(info.cell, info.pad || 'Left');
      if (await this.handleDeath(info.cell ? { cell: info.cell, pad: info.pad } : null)) continue;
      if (this.combat.holding()) { await sleep(300); continue; }
      if (await this.isNull('world.myAvatar.target')) await this.client.call('attackMonsterName', '*').catch(() => null);
      if (!(await this.keepInRange())) { await sleep(300); continue; }
      if (!(await this.combat.tick().catch(() => false))) await this.client.call('useSkill', 0).catch(() => null);
      await this.pickupDrops();
      await sleep(300);
    }
    return true;
  }

  // On arriving at a map while assisting: ultra map -> the class assigned to me; anywhere else -> best solo class.
  async prepareFor(map, cfg) {
    const ultra = progression.ultraFor(map);
    if (!ultra) { await this.useRole('solo').catch(() => false); return null; }
    const pick = this.hub && this.hub.ultraClassFor ? await this.hub.ultraClassFor(this, ultra, cfg) : null;
    if (pick && String(await this.className()).toLowerCase() !== pick.toLowerCase()) {
      await this.equip(pick);
      await this.combat.refresh(progression.ULTRA_MODE[pick] || 'Base');
    }
    await this.gearUp('boss', ultra.label.replace(/^Ultra |^Champion /, '')).catch(() => 0);
    const lvl = await this.level();
    const plan = knowledge.ultraPlan(await this.className(), ultra.enh, await this.unlockedEnhancements().catch(() => new Set()), lvl);
    if ((await this.gold()) > 5000) await this.enhanceEquipped(plan).catch((e) => this.journal(`ultra enhance failed: ${e.message}`, 'warn'));
    this.journal(`${ultra.label}: my slot is ${pick || 'my best class (no needed class owned)'}; enhancements ${plan.type} ${plan.weapon || ''} ${plan.helm || ''} ${plan.cape || ''} (${plan.source})`);
    return pick;
  }

  // /goto a player (army "jump all to player").
  async gotoPlayer(player) {
    const key = String(player || '').toLowerCase();
    if (!key) throw new Error('no player name');
    for (let i = 0; i < 4; i++) {
      await this.client.send(`%xt%zm%cmd%${await this.room()}%goto%${player}%`);
      if (await this.waitFor(async () => !(await this.isNull(`world.uoTree.${key}`)), 8000, 500)) { this.journal(`went to ${player} in /${await this.map()}`); return true; }
    }
    throw new Error(`could not reach ${player} (offline or another server?)`);
  }

  // Is a seasonal event live? Try its maps; a "locked until event" warning means no.
  async probeEvent(t) {
    for (const m of t.maps || []) {
      try { await this.join(m); this.journal(`event ${t.folder}: /${m} is OPEN`); return { open: true, map: m }; } catch (e) {
        if (!/unavailable/.test(e.message)) continue;
      }
    }
    this.journal(`event ${t.folder}: closed`);
    return { open: false };
  }

  // ---------------- crowded or quiet server (lib/crowd.js, the owner 2026-09-25) ----------------
  // Crowded content runs on Artix, everything else on Swordhaven. A character on the wrong one logs out; hub.reconnect
  // logs it in on wantServer (hub.serverFor) and starts the loop again, which picks the same work up there.
  async ensureServer(task) {
    if (!this.client.headless || !this.hub || !this.hub.serverFor) return;
    if (this.hub.settings && this.hub.settings.crowd === false) return;
    if (this.account.server || (this.hub.assistFor && (this.hub.assistFor(this) || {}).server)) return;
    const kind = crowd.kindOf(task);
    const want = crowd.serverFor(kind);
    if (!want) return;
    const here = this.client.wantedServer || String(this.serverName || '').toLowerCase();
    if (here === want.toLowerCase()) { this.wantServer = want; if (kind === 'crowd') this._crowdWaitSince = null; return; }
    // On the stand-in for a full Artix (below): the crowded work is done here.
    if (kind === 'crowd' && this.crowdAlt && here === this.crowdAlt.toLowerCase()) return;
    let go = want;
    // A full Artix: don't log out to knock on it (on 09-27/28 characters sat offline for up to an hour, and the hops
    // made 778 reconnects in a day). Keep doing quiet work here; the hub watches the server list every 5 s and sends
    // the character back to its crowded work the moment a seat shows up (hub.crowdTick, the owner's "keep trying").
    if (kind === 'crowd' && this.hub.crowdFull && !(this.hub.settings && this.hub.settings.crowdKnockOffline === false)) {
      // Knock (the owner, 2026-10-05): log out and let hub.reconnect watch Artix's seats every 2 s, logging in the moment one
      // is free; each character for itself, so whoever gets in starts its dailies without waiting for the others. After
      // crowd.KNOCK_MIN minutes headless.pickServer takes the busiest server with room instead.
      const full = await this.hub.crowdFull().catch(() => null);
      if (full) this.journal(`${want} is full (${full}) - knocking on it until a seat opens (up to ${crowd.KNOCK_MIN} min), then straight to the work`);
    } else if (kind === 'crowd' && this.hub.crowdFull) {
      const full = await this.hub.crowdFull().catch(() => null);
      if (full) {
        this._crowdWaitSince = this._crowdWaitSince || Date.now();
        // An hour of that is enough (the 60 min rule of 09-27, lost in the 09-28 change): from 09-30 Artix sat at
        // 1491-1502/1500 around the clock, no seat ever showed, and three characters ran no dailies and no Lord of
        // Order for days. The busiest other server has players too.
        const waited = Date.now() - this._crowdWaitSince;
        const alt = CROWD_ALT_AFTER > 0 && waited >= CROWD_ALT_AFTER && this.hub.crowdAlt ? await this.hub.crowdAlt(await this.level().catch(() => 1)).catch(() => null) : null;
        if (!alt) {
          this.crowdFullUntil = Date.now() + CROWD_FULL_REST;
          if (Date.now() - (this._crowdFullSaid || 0) > 30 * 60000) { this._crowdFullSaid = Date.now(); this.journal(`${want} is full (${full}) - doing other work here and watching for a seat`); }
          const e = new Error(`${want} is full`); e.code = 'CROWD_FULL';
          throw e;
        }
        this.journal(`${want} has been full for ${Math.round(waited / 60000)} min (${full}) - doing the crowded work on ${alt}, the busiest server with room`);
        this.crowdAlt = alt; this._crowdWaitSince = null;
        this.crowdOpen();
        if (here === alt.toLowerCase()) return;
        go = alt;
      }
    }
    if (kind !== 'crowd') this.crowdAlt = null;
    this.wantServer = go;
    if (go === want) this.journal(`${kind === 'crowd' ? 'crowded content - moving to ' + want + ', where the players are' : 'quiet content - moving to ' + want}`);
    await this.leaveCombat().catch(() => null);
    this.client.scriptDriven = false;
    await Promise.resolve(this.client.call('sfc.disconnect')).catch(() => null);
    await this.waitFor(() => false, 90000, 500);        // hub.reconnect stops this loop (Stop) while it logs in again
    throw new Error(`could not move to ${want}`);
  }

  // Crowded work waits while Artix is full (ensureServer); these are the tasks set aside for it, cleared the moment a
  // seat opens (hub.crowdTick).
  crowdBlocked(t) { return !!(this.crowdFullUntil > Date.now() && crowd.kindOf(t) === 'crowd'); }
  crowdSkip(t) {
    const key = this.taskKey(t);
    this.skipped = this.skipped || new Map();
    this.skipped.why = 'Artix is full - back when a seat opens';
    this.skipped.set(key, this.crowdFullUntil || Date.now() + CROWD_FULL_REST);
    (this._crowdSkips = this._crowdSkips || new Set()).add(key);
  }
  crowdOpen() {
    this.crowdFullUntil = 0;
    for (const k of this._crowdSkips || []) if (this.skipped) this.skipped.delete(k);
    if (this._crowdSkips) this._crowdSkips.clear();
  }
  // Orders that repeat (dashboard): 'always' goes back to the end of the queue when it ends, 'daily' becomes a routine
  // that is queued once per server day (settings.routines). A repeating order that failed within a minute stops
  // repeating, so a broken order can't spin.
  // A Skua script that stopped itself on a full backpack ("The destination inventory is full. Please clear space and
  // restart the bot.") is not done: room is being made (makeRoomFor), so the order goes again - 3 times at most per
  // order. The owner's Kathool Adept order "finished" this way at Glaucus Mystic on 2026-10-28 and was dropped.
  fullStopRequeue(task, now = Date.now()) {
    if (!task || task.brain || task.type !== 'script' || !this._fullStopAt) return false;
    const at = this._fullStopAt;
    this._fullStopAt = 0;
    if (now - at > 120000 || (task.startedAt && at < task.startedAt)) return false;
    const again = Bot.orderCopy(task);
    again.fullRetries = (Number(task.fullRetries) || 0) + 1;
    if (again.fullRetries > 3) { this.journal(`"${task.why || task.path}" stopped on a full backpack 3 times - leaving it`, 'warn'); return false; }
    this.queue.unshift(again);
    this.save();
    this.journal(`"${task.why || task.path}" stopped on a full backpack - room is being made, it goes again (${again.fullRetries}/3)`);
    return true;
  }

  static orderCopy(t) {
    const c = {};
    for (const [k, v] of Object.entries(t || {})) if (!['startedAt', 'tries', '_mark'].includes(k)) c[k] = v;
    return c;
  }
  afterOrder(task, result) {
    // Stopped for gold: back in the queue, picked again once the gold is there (nextOrder). Not hub work (a crew seat,
    // a help call): its round has its own gold wait and is long over by the time the gold is there.
    if (task && !task.brain && !Bot.hubWork(task) && result && result.goldWait) {
      this.queue.push({ ...Bot.orderCopy(task), waitGold: result.goldWait });
      this.save();
      return;
    }
    if (!task || task.brain || !task.repeat) return;
    if (task.repeat === 'daily') {
      const routines = (this.settings.routines = this.settings.routines || []);
      const id = task.routineId || `r${Date.now().toString(36)}`;
      const copy = { ...Bot.orderCopy(task), routineId: id };
      const r = routines.find((x) => x.id === id);
      if (r) { r.task = copy; r.lastDay = serverDay(); } else routines.push({ id, task: copy, lastDay: serverDay() });
      this.save();
      return;
    }
    if (task.repeat === 'always') {
      if (result === false && task.startedAt && Date.now() - task.startedAt < 60000) { this.journal(`"${task.why || task.type}" failed at once - not repeating it`, 'warn'); return; }
      this.queue.push(Bot.orderCopy(task));
      this.save();
    }
  }
  // Daily routines due today go into the queue (once per server day each).
  takeRoutines() {
    const list = this.settings.routines || [];
    if (!list.length) return 0;
    const today = serverDay();
    let n = 0;
    for (const r of list) {
      if (r.lastDay === today || r.paused) continue;
      if (this.queue.some((q) => q.routineId === r.id) || (this.current && this.current.routineId === r.id)) continue;
      r.lastDay = today;
      this.queue.push({ ...r.task, routineId: r.id, repeat: 'daily', why: r.task.why || 'daily routine' });
      this.journal(`daily routine: ${r.task.why || r.task.type}`);
      n++;
    }
    if (n) this.save();
    return n;
  }

  // The next queued order, leaving crowded ones in the queue while Artix is full.
  // What makes two orders the same work (queue de-duplication): everything but the clock.
  static orderKey(t) { return t ? [t.type, t.path || '', t.entry || '', t.args || '', t.item || '', t.monster || '', t.map || '', t.goal || '', t.why || ''].join('|') : ''; }

  nextOrder() {
    // An order that stopped for gold (waitGold) stays queued until the gold is there; the brain works meanwhile.
    // One the loop breaker holds waits out its hold.
    // An order resting after a boss beat the party (hub, restUntil) waits it out in the queue.
    const now = Date.now();
    const i = this.queue.findIndex((q) => !this.crowdBlocked(q) && !(q.waitGold && this.goldNow() < q.waitGold) && !(q.restUntil && q.restUntil > now) && !Bot.prototype.spinHeld.call(this, q));
    return i >= 0 ? this.queue.splice(i, 1)[0] : undefined;
  }
  // Hub work in the queue (Bot.hubWork) whose call or round is over: a crew seat from a finished round, a help call
  // that ended before the bot got to it. It is the hub's to hand out again, never an order. Returns how many went.
  purgeStaleQueue() {
    // brain: true hub work (a crew's turn-in daily, runNow) finishes even after its round closed.
    const stale = this.queue.filter((q) => Bot.hubWork(q) && !q.brain && !this.hubWorkLive(q));
    if (!stale.length) return 0;
    this.queue = this.queue.filter((q) => !stale.includes(q));
    this.journal(`dropped ${stale.length} stale task(s) from the queue (a finished crew round or help call): ${stale.map((q) => String(q.why || q.type).slice(0, 60)).join('; ')}`);
    this.save();
    return stale.length;
  }

  // ---------------- main loop ----------------
  async loop() {
    this.running = true;
    this.journal('bot loop started');
    this.emit('state');
    while (!this.stopFlag) {
      try {
        this.takePushFront();
        await this.ensureLogin();
        // The loop breaker's brake (Bot.SPIN): many tasks of any kind ending within seconds - slow down before the next.
        if (this.spinBraking()) {
          if (!this._brakeNoted || Date.now() - this._brakeNoted > Bot.SPIN.windowMs) { this._brakeNoted = Date.now(); this.journal(`loop breaker: ${Bot.SPIN.brakeCount}+ tasks ended within seconds in ${Math.round(Bot.SPIN.windowMs / 60000)} min - ${Math.round(Bot.SPIN.brakeMs / 1000)} s between tasks for now`, 'warn'); }
          await new Promise((r) => setTimeout(r, Bot.SPIN.brakeMs));
          if (this.stopFlag) break;
        }
        let task = this.hub && this.hub.helpTask ? this.unlooped(this.hub.helpTask(this)) : null;
        // A raid I'm seated in comes before army farms, escorts and orders: beginRaid restarts me, and the work it paused
        // would otherwise take the slot again while the other three wait for me (hub.raidWithMain). 2026-10-23: an
        // escort begun 20 s before the Engineer raid took Oren back and the party sat at "Ready: 3/4" for 50 min.
        if (!task && this.hub && this.hub.raidTask) task = this.hub.raidTask(this);
        // A crew daily (lib/crewdaily.js): the stage the crew is on, for everyone in its room.
        if (!task && this.hub && this.hub.crewTask) task = this.hub.crewTask(this);
        if (!task && this.hub && this.hub.armyTask) task = this.hub.armyTask(this);
        if (!task && this.hub && this.hub.escortTask) task = this.unlooped(this.hub.escortTask(this));
        this.takeRoutines();
        this.purgeStaleQueue();
        this.expireSettings();
        if (!task) task = this.nextOrder();
        if (!task && this.settings.autopilot === false) {
          if (!this._idleNoted) { this._idleNoted = true; this.journal('autopilot off - waiting for orders'); }
          this.current = { type: 'idle', why: 'autopilot off - waiting for orders', startedAt: this._idleSince || (this._idleSince = Date.now()) };
          await sleep(3000);
          continue;
        }
        this._idleNoted = false; this._idleSince = null;
        if (!task && this.brain) task = await this.brain.next(this);
        if (!task) task = { type: 'farmLevel', to: 100, minutes: 30, brain: true, why: 'default' };
        task.startedAt = Date.now();
        this.stampPublic(task);
        this._taskRoom = task.room || (this.hub && this.hub.sharedRoomFor ? this.hub.sharedRoomFor(this, task.goal) : null) || null;
        if (this._taskRoom && task.goal) this.journal(`teaming up on ${task.goal} in room ${this._taskRoom}`);
        this.current = task; this.save(); this.emit("state");
        // A boss wait belongs to the task that met the boss: Nova's citadel daily gave up on "Akriloth" right after the
        // Lord of Order run that waited on him (2026-10-05).
        if (this.client) this.client.mannersWait = null;
        this.journal(`task start ${JSON.stringify(task)}`);
        // Where the counters stood, so the brain can tell what this task gained (lib/ledger.js). Not saved with the task.
        Object.defineProperty(task, '_mark', { value: this.progressMark(), enumerable: false, writable: true, configurable: true });
        await this.ensureServer(task);
        if (this.settings.useBoosts !== false) await this.useBoosts(task).catch((e) => this.journal(`boosts: ${e.message}`, 'warn'));
        // autoGear off (the owner's own accounts by default): class, gear and enhancements stay as he set them.
        // An ultra raid: my seat's class (hub.beginRaid) with its own kit, enhanced for it, before v3 starts. v3's own
        // enhancing is off in raids (lib/skua/cbo.js), so it never buys over another class's forge special.
        if (task.raid && this.kitsOn()) await this.raidSeatGear().catch((e) => this.journal(`raid gear: ${e.message}`, 'warn'));
        else if (task.raid && this.isGuest()) await this.raidSeatOutfit().catch((e) => this.journal(`raid outfit: ${e.message}`, 'warn'));
        // A crew daily's army fight (lib/crewdaily.js): the seat's class in its own kit - on the owner's main, his own outfit.
        else if (task.crewScript && task.seat) {
          if (this.isGuest()) await this.raidSeatOutfit(task.seat).catch((e) => this.journal(`crew outfit: ${e.message}`, 'warn'));
          else if (this.kitsOn()) await this.raidSeatGear(task.seat).catch((e) => this.journal(`crew gear: ${e.message}`, 'warn'));
        }
        const role = this.settings.autoGear === false || task.raid || task.crewScript ? null : { farmLevel: 'farm', kill: 'farm', daily: 'farm', script: 'solo', quest: 'solo' }[task.type];
        // Kits (lib/kits.js) before a Skua script, so its Solo / Farm swaps wear pieces enhanced for each class.
        const kitTask = role && this.kitsOn();
        if (kitTask && task.type === 'script') await this.prepareKits().catch((e) => this.journal(`kits: ${e.message}`, 'warn'));
        if (role) await this.useRole(role).catch((e) => this.journal(`role switch failed: ${e.message}`, 'warn'));
        // useRole only acts on a class change: the kit goes on either way, and boost gear keeps off its slots.
        const kit = kitTask && this.kits ? kits.forClass(this.kits, await this.className().catch(() => '')) : null;
        if (kit) await this.wearKit(kit).catch((e) => this.journal(`kit: ${e.message}`, 'warn'));
        const kind = { farmLevel: 'exp', kill: 'gold', daily: 'rep', script: 'fight', quest: 'fight' }[task.type];
        if (kind && role) await this.gearUp(kind, task.monster, kit ? kits.SLOTS : null).catch((e) => this.journal(`gear swap failed: ${e.message}`, 'warn'));
        if (role) await this.settleOutfit().catch((e) => this.journal(`outfit: ${e.message}`, 'warn'));
        let result = await this.runTask(task);
        this.noteTaskEnd(task);
        if (task.crewScript && this.hub && this.hub.crewScriptEnded) this.hub.crewScriptEnded(this, task, result);
        if (this.brain && this.brain.done) await this.brain.done(this, task, result);
        this.journal(`task done ${task.type}`);
        if (this.fullStopRequeue(task)) result = false;
        else this.afterOrder(task, result);
        this.current = null; this.save(); this.emit('state');
      } catch (e) {
        if (e instanceof Stop) {
          // Stopped mid-task (watchdog, pre-emption, reconnect, skip): the brain still books the time it took, or an
          // event script restarted every half hour never used up the day's event time (2026-09-21).
          if (this.brain && this.brain.interrupted && this.current) await this.brain.interrupted(this, this.current).catch(() => null);
          this.noteTaskEnd(this.current);
          // An order (queued by the owner or the API) carries on after the restart - a Wi-Fi reconnect used to drop it for
          // good. Not when it was skipped on purpose or parked as stuck (_dropCurrent).
          // A free-gift claim too: a party escort took Sable and Valen off their 500 free ACs 2 s in (2026-10-10).
          // A crew task (lib/crewdaily.js) belongs to the crew's stage, not to the owner's orders: never put back after a stop.
          if (this.current && (!this.current.brain || this.current.gift) && this.current.type !== 'idle' && this.requeueable(this.current) && !this._dropCurrent) {
            const k = Bot.orderKey(this.current);
            this.queue = this.queue.filter((q) => (q.brain && !q.gift) || Bot.orderKey(q) !== k);
            this.queue.unshift(this.current); this.save();
            if (!this.current.brain) this.journal(`order "${this.current.why || this.current.path || this.current.type}" is back at the front of the queue`);
          }
          // "Farm until I have N" finished it: a repeating order goes round again.
          if (this._untilDone && this._untilDone === this.current) this.afterOrder(this.current, true);
          this._untilDone = null;
          this._dropCurrent = false;
          this.takePushFront();
          break;
        }
        // Artix full (ensureServer): not a failure of the task. The brain picks quiet work until a seat opens.
        if (e && e.code === 'CROWD_FULL') {
          if (this.current && this.current.brain) this.crowdSkip(this.current);
          if (this.current && !this.current.brain) this.queue.unshift(this.current);
          this.current = null; this.save();
          await sleep(1000);
          continue;
        }
        this.journal(`error: ${e && e.message}`, 'error');
        this.noteTaskEnd(this.current);
        if (this.brain && this.brain.failed && this.current) await this.brain.failed(this, this.current, e);
        // An order that failed goes back for another try; 3 failures in a row with nothing gained drop it. A crash after
        // real progress starts the count again: the owner's Kathool Adept order was dropped on 2026-10-25 after 3 crashes
        // (a nameless drop, lib/skua/engine.js fillDrops) while it was still farming its chits - and nobody told him.
        if (this.current && !this.current.brain && this.requeueable(this.current) && !/unavailable/.test(e.message)) {
          const g = this.current._mark ? this.gainedSince(this.current._mark) : null;
          const gained = !!(g && (g.items > 0 || g.quests > 0));
          this.current.tries = gained ? 1 : (this.current.tries || 0) + 1;
          if (this.current.tries < 3) this.queue.unshift(this.current);
          else {
            const what = this.current.why || this.current.path || this.current.type;
            this.journal(`gave up on the order "${what}" - it failed 3 times in a row without progress (${e && e.message})`, 'warn');
            if (this.hub && this.hub.notify) this.hub.notify(`${(this.account && this.account.label) || this.id}: order dropped`, `"${what}" failed 3 times in a row without progress: ${String(e && e.message).slice(0, 150)}. Queue it again once it is fixed.`, 'alert');
          }
        }
        this.current = null; this.save();
        await sleep(10000);
      }
    }
    this.registered.clear();
    this.running = false;
    this.current = null;
    this.journal('bot loop stopped');
    this.emit('state');
  }

  // Me time at a glance (dashboard): today's minutes, the allowance, and the dream piece it is after.
  styleSummary() {
    const f = this.persona && this.persona.fashion;
    if (!f || !this.brain || !this.brain.today) return null;
    try {
      const day = this.brain.today(this);
      const got = (this.brain.state(this).wishGot) || {};
      const next = (f.dream || []).find((d) => !got[d.name]);
      return { identity: f.identity, minToday: Math.round((day.styleMs || 0) / 60000), allowMin: Math.round((day.styleAllowMs || 3600000) / 60000), want: next ? next.name : null, got: Object.keys(got).length, dream: (f.dream || []).length };
    } catch (e) { return null; }
  }

  async status(full = false) {
    const { expSamples, ...stats } = this.stats;
    const s = { settings: this.settings, combat: { engine: this.combat.routine ? 'adaptive' : 'skua', ...(this.combat.last || {}) }, id: this.id, label: this.account.label, owner: this.account.owner, kind: this.account.kind || 'party', wantOnline: this.account.kind === 'guest' ? !!this.account.online : true, connecting: !!(this.client && this.client._reconnecting), knocking: !!(this.client && this.client._fullSince), color: this.account.color, status: this.account.status || 'active', persona: personas.card(this.persona), style: this.styleSummary(), assisting: !!(this.hub && this.hub.assistFor && this.hub.assistFor(this)), running: this.running, paused: this.paused, current: this.current, queue: this.queue, stats, server: this.serverName || null, client: this.client.state };
    try {
      if (await this.playing()) {
        const [level, exp, expTo, gold, hp, hpMax, map, cell, cls, name] = await Promise.all([
          this.level(), this.g('world.myAvatar.objData.intExp', 0), this.g('world.myAvatar.objData.intExpToLevel', 0), this.gold(),
          this.hp(), this.hpMax(), this.map(), this.cell(), this.className(), this.name()]);
        // Straight after a login the server has not sent our hit points yet (initUserData says 0 for everyone), so
        // the dashboard must show "not known yet" rather than a character on the floor at 0 hp.
        const hpKnown = this.client.headless ? !!this.client.sawHp : true;
        Object.assign(s, { online: true, name, level, exp, expTo, gold, hp, hpMax, hpKnown, map, cell, className: cls });
        const now = Date.now();
        // A sample taken before the server has sent this character's numbers (experience and gold arrive with the
        // login data, a moment after the socket is up) made the first rate absurd: 31 million gold an hour on
        // 2026-09-20. Sample only a character whose numbers are there.
        if (level > 0 && (exp > 0 || gold > 0)) {
          this.stats.expSamples = this.stats.expSamples.filter((x) => now - x.t < 3600000);
          this.stats.expSamples.push({ t: now, level, exp, gold });
          const first = this.stats.expSamples[0];
          const hours = (now - first.t) / 3600000;
          if (level > first.level) this.stats.expSamples = [{ t: now, level, exp, gold }];   // the bar restarted
          else if (hours >= 5 / 60) {   // rates need at least 5 minutes of samples
            s.goldPerHour = Math.round((gold - first.gold) / hours);
            const gained = exp - first.exp;
            s.expPerHour = gained >= 0 ? Math.round(gained / hours) : null;
            s.etaLevelMin = s.expPerHour > 0 ? Math.round((expTo - exp) / s.expPerHour * 60) : null;
          }
        }
        if (full) { s.sets = this.sets; s.free = await this.freeSlots(); }
      } else s.online = false;
    } catch (e) { s.err = String(e.message || e); }
    s.log = this.lastLog.slice(-40);
    return s;
  }

  dispose() { this.stop(); this.client.removeListener('event', this.onEvent); }
}

// The loop breaker's numbers (Bot.noteTaskEnd). Real time, not util.sleep's scaled clock.
// How long a Skua script fights a boss its own way, with nothing gained, before Seraph steps in (scriptOwnsFight).
Bot.OWN_FIGHT_MS = 20 * 60000;
Bot.SPIN = { quickMs: 20000, windowMs: 10 * 60000, count: 6, holdMs: 30 * 60000, longHoldMs: 6 * 3600000, brakeCount: 20, brakeMs: 30000 };

module.exports = { Bot, Stop, LEVEL_ROUTES, takeCompileTurn };
