// The hub owns every account: its game client, its bot and the shared services (brain, notifications, party rooms,
// Obsidian reports, milestone screenshots, updater).
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { P } = require('./paths');
const { localDay, readJson, writeJson, serverDay } = require('./util');
const accounts = require('./accounts');
const { GameClient } = require('./client');
const { HeadlessClient } = require('./net/headless');
const { FlashClient } = require('./net/flashclient');
const { FlashHost } = require('./flashhost');
const { FlashStandby } = require('./flashstandby');
const { SkuaEngine } = require('./skua/engine');
const enginelimits = require('./enginelimits');
const { Bot } = require('./bot');
const { Brain } = require('./brain');
const { Updater } = require('./updater');
const progression = require('./progression');
const { Overseer } = require('./overseer');
const { Boosts } = require('./boosts');
const knowledgebook = require('./knowledgebook');
const { Discord } = require('./discord');
const { FriendWatch } = require('./friendwatch');
const ultraready = require('./ultraready');
const crowd = require('./crowd');
const partycomp = require('./partycomp');
const manners = require('./manners');
const freegifts = require('./freegifts');
const fightplan = require('./fightplan');
const bossroutes = require('./bossroutes');
const squad = require('./squad');

const MUTE_SCRIPT = 30 * 60000;   // a Skua script this long without progress is stuck in one step, whatever the kill counter says
// Over this many "slow down" warnings in 10 min, a script is spinning on refused actions (Oren's FaizasMerge: 2,184
// an hour for 4.4 h, 0 quests - audit C3): only items and turn-ins count as progress then, not log lines or kills.
const SLOW_STORM = 100;
const FARM_KILL_GAP = 15 * 60000;   // a farm step whose monster died this recently is farming (a slow boss: ~5 min a kill)
// Artix counts as having room when one seat is free, as the game's own server list does (ServerList.as refuses a click
// only at iCount >= iMax). The old 25-seat margin meant the bots never tried at 1476-1499/1500, which is where Artix
// sits all evening (the owner, 2026-10-05: keep trying and a slot opens).
const SEAT_MARGIN = 0;
const ALT_MARGIN = 25;    // a stand-in server must have real room: Yorumi at 990/1000 is not one (crowdAlt)
const PREEMPT_EVERY = 10 * 60000; // how often a running brain script is checked against dailies, events and the like
const PARTY_WALL_DEATHS = 8;      // deaths to one boss during a help call before it is called off (endHelp)
const PARTY_WALL_MS = 24 * 3600000;
const HELP_FARM_MAX = 3 * 3600000;  // a farm call (requestHelp farm) stays open at most this long
const HELP_FARM_IDLE = 12 * 60000;  // ...and ends when no kill came for this long
const ENGINE_HOLD_MS = 60000;       // a character between two tasks keeps its engine slot this long (engineDone)
const ENGINE_TURN_MS = 4 * 3600000; // a helper's kept engine turn (keepEngineTurn) lasts this long
const MAX_HELP_CALLS = 3;           // help calls open at once (each with its own squad; settings.maxHelpCalls)
const HELP_GUARD_MAX = 60 * 60000;  // a guard call (requestHelp h.guard) that farms nothing stays open at most this long
const GUARD_OFF_MS = 90000;         // ...and ends this long after the caller's script left the boss (a script restart is shorter)
const BOSS_HP_RATIO = 8;          // a monster with 8x the character's hit points is a boss (bossDeath)...
const BOSS_HP_MIN = 15000;        // ...and never one with less than this
// Deaths to one monster in 30 min inside one Skua script (or me-time wish) before it is set aside. Scripts had no death
// limit: Nova died 380x to Admiral Zheng in 3 h, Oren 113x to Ultra Chaos Alteon (2026-09-27).
const DEATH_CAP = 8;
const SOLO_VETO_DEATHS = 3;   // deaths to a boss killed solo before that still skip the party call (struggle)
const BOSS_DM_QUIET = 2 * 3600000; // at most one boss DM per character and boss in this time
const FULL_WAIT_MAX = crowd.KNOCK_MIN * 60000;   // = headless knock window: after this a full Artix gives way to the busiest server
const PRE_SWITCH_GAP = 20 * 60000;  // at most one switch-before-the-fight restart per task in this time (preFightTick)
// Raid holds end by themselves (raidHeld): a held boss is tried again after RAID_HOLD_DAYS; RAID_HOLD_LOSSES lost
// fights in a row after that hold it again for twice as long, up to RAID_HOLD_MAX_DAYS.
const RAID_HOLD_DAYS = 14;
const RAID_HOLD_LOSSES = 2;
const RAID_HOLD_MAX_DAYS = 56;
const RECONNECT = { wait: 15000, resume: 3000 };   // before the first login try / before the bot carries on (tests shorten them)
const protocol = require('./net/protocol');

// The owner, 2026-09-27: "only dm me when the boss couldnt be killed at all and i would actually be able to help ... dont
// ping me in void auras or things that require more than 6 people". Returns why a boss-death DM is NOT sent, or null.
function killedBosses(bot) {
  if (!bot._killedBosses) bot._killedBosses = bot.file ? readJson(bot.file('killedBosses.json'), {}) || {} : {};
  return bot._killedBosses;
}
function dmVeto(bot, killer, myMax, now = Date.now()) {
  const solo = bot._soloBosses || (bot.file ? readJson(bot.file('soloBosses.json'), {}) : {}) || {};
  if (killedBosses(bot)[killer.name] || solo[killer.name]) return 'it has killed this boss before';
  // Me time and seasonal events are cosmetic (the owner, 2026-09-28): not worth pulling the owner (or the party) in.
  const t = bot.current || {};
  if (t.style || t.event || t.countAs === 'event') return 'me time / event: cosmetic';
  // Crowd content (void auras, NSoD, Nation/Legion farms, dailies) is done with the public room, not with the owner.
  // contentKind, not kindOf: since the 2026-10-09 ladder this content runs in the party's room first, which is not a
  // reason to ping the owner more often.
  if (crowd.contentKind(bot.current) === 'crowd') return 'crowd content - public room';
  const area = String(((bot.client && bot.client.w) || {}).strAreaName || '');
  if (area && crowd.crowdedMap(area) && crowd.publicArea(area)) return 'crowd map - public room';
  // A boss this many times the character's HP needs a crowd (Desolich 8.2M): one more player would not change it.
  if (myMax && Number(killer.hpMax) > crowd.MANNERS.hopelessHpRatio * myMax) return `boss has ${Math.round(killer.hpMax / myMax)}x its HP - needs a crowd`;
  return null;
}

class Hub extends EventEmitter {
  constructor(electron, opts = {}) {
    super();
    this.electron = electron;
    // Headless mode talks to the game over a socket: no Electron, no Flash, no screens (the Linux server).
    this.headless = opts.headless !== undefined ? !!opts.headless : !electron;
    this.autoOpen = opts.autoOpen !== false;   // headless.js opens its own list (so --only works)
    this.clients = new Map();
    this.bots = new Map();
    // The real-Flash standby (lib/flashstandby.js): on the headless server only, where Flash is not the normal client.
    if (this.headless) { this.flash = new FlashHost((m) => this.info(m), { separate: () => !!(this.standby && this.standby.cfg().separate),
      describe: () => { const c = this.standby ? this.standby.cfg() : {}; return { separate: !!c.separate, hidden: !!c.hidden, size: c.size || 'small' }; },
      render: () => { const c = this.standby ? this.standby.cfg() : {}; const size = { tiny: [240, 138], small: [480, 275], normal: [960, 550] }[c.size] || [480, 275]; return { FLASH_HIDDEN: c.hidden ? '1' : '0', FLASH_W: String(size[0]), FLASH_H: String(size[1]) }; } }); this.standby = new FlashStandby(this); }
    this.brain = new Brain({ hub: this });
    this.log = [];
    this.updater = new Updater((m) => {
      this.info(m);
      const fresh = m.match(/new design notes: (.*)/);
      if (fresh && /free|limited|event|birthday|returns|new/i.test(fresh[1])) this.notify('AQW news', fresh[1].slice(0, 200), 'news');
    });
    this.discord = new Discord((m) => this.info(m));
    this.friendWatch = new FriendWatch(this);     // DM the owner when a watched player (WatchedPlayer) logs in
    // Not a friend? A spare account sweeps the servers with /goto instead (lib/playerwatch.js). Its login block goes in
    // account.txt next to accounts.json; scanner.username in lib/friendwatch.json switches it on. Laptop only.
    const scan = this.friendWatch.cfg.scanner;
    if (this.headless && scan && scan.username) {
      const { PlayerWatch } = require('./playerwatch');
      this.playerWatch = new PlayerWatch(this, { ...scan, watch: this.friendWatch.watched, account: { username: scan.username, loginFile: scan.loginFile || path.join(P.ROOT, 'account.txt') } });
      setTimeout(() => { if (!this.disposed) this.playerWatch.start(); }, 90000).unref();
    }
    this.settings = readJson(path.join(P.ROOT, 'hub.json'), { notifications: true, reports: true, gallery: true, party: {} });
    // Notification kinds the owner can switch off (dashboard → Activity). Level-ups and drops are off by default (asked 2026-09-17).
    this.settings.notify = Object.assign({ levelUp: false, drop: false, alert: true, event: true, news: true, crash: true }, this.settings.notify || {});
    // Level together (the owner's idea 2026-09-17): every bot in one room + an in-game party, leveling at the weakest member's
    // band so the strong carry the weak. Assisting bots are excluded.
    this.settings.levelParty = Object.assign({ enabled: true, room: 90000 + Math.floor(Math.random() * 9999), maxGap: 25 }, this.settings.levelParty || {});
    if (this.settings.levelParty.room > 99999) this.settings.levelParty.room = 90000 + Math.floor(Math.random() * 9999);   // AQW caps room numbers at 5 digits (bigger = random room)
    this.settings.assist = Object.assign({ enabled: false, main: 'GRAIL26', server: '', mainClass: '', members: [] }, this.settings.assist || {});
    this.timers = [];
    // Bosses and steps that block progress, their plans and the party escorts (lib/walls.js, audit A2).
    this.walls = new (require('./walls').Walls)(this);
    this.dropRates = new (require('./droprates').DropRates)(path.join(P.ROOT, 'droprates.json'));
    // How full each server is at every hour of the week (lib/crowdhours.js).
    this.crowdHours = new (require('./crowdhours').CrowdHours)();
  }

  // The escort task for this character while an escort is on (lib/bot.js loop, like helpTask and armyTask).
  escortTask(bot) { return this.walls ? this.walls.taskFor(bot) : null; }

  saveSettings() { writeJson(path.join(P.ROOT, 'hub.json'), this.settings); }

  // Rebuild Seraph's script fixes against today's library and say, loudly, when one no longer applies.
  checkScriptFixes() {
    // Seraph's Ultras v3 copy (lib/ultras.js) back into the library: a pull or Reset Scripts (git clean) removes it.
    try { const n = require('./ultras').install(); if (n) this.info(`ultras: installed ${n} SeraphUltras file(s) into the Skua library`); } catch (e) { this.info(`ultras: install failed: ${e.message}`); }
    try { const n = require('./recipes').installProven(); if (n) this.info(`ultras: installed ${n} proven (frozen) raid script file(s)`); } catch (e) { this.info(`ultras: proven install failed: ${e.message}`); }
    try {
      const scriptfix = require('./scriptfix');
      const results = scriptfix.refresh();
      const ok = results.filter((r) => r.status === 'applied').map((r) => r.rel.split('/').pop());
      if (ok.length) this.info(`script fixes: ${ok.join(', ')} applied to the current library`);
      for (const r of scriptfix.problems(results)) {
        const what = r.status === 'failed' ? `no longer applies (${r.detail})` : 'retired: the library file changed upstream';
        this.info(`script fixes: ${r.rel} ${what}`);
        this.notify(`A Skua script fix stopped working: ${r.rel.split('/').pop()}`, `${what}. It fixed: ${r.why}. The bots run the unfixed library version until Claude re-bases it.`, 'alert');
      }
      return results;
    } catch (e) { this.info(`script fixes: ${e.message}`); return []; }
  }

  info(msg) {
    const line = `${new Date().toISOString()} ${msg}`;
    this.log.push(line);
    if (this.log.length > 500) this.log.shift();
    fs.appendFileSync(path.join(P.LOGS, 'hub.log'), line + '\n');
    this.emit('log', line);
  }

  // ---------------- accounts ----------------
  start() {
    // Staggered logins (VibeSkua): one account every 8 s so the login server isn't hammered.
    if (this.autoOpen) accounts.load().accounts.filter((acc) => acc.status !== 'pending').forEach((acc, i) => setTimeout(() => this.open(acc), i * 8000));
    this.overseer = new Overseer(this);
    // Boosts (Artix calendar) hourly; knowledge book notes + local index at start and every 12 h.
    this.boosts = new Boosts((m) => this.info(m));
    const boostRefresh = () => this.boosts.refresh().catch((e) => this.info(`boosts: refresh failed: ${e.message}`));
    setTimeout(boostRefresh, 15000);
    this.timers.push(setInterval(boostRefresh, 3600000));
    // The knowledge book needs the Obsidian vault and the local model; neither exists on the home server.
    if (process.env.SERAPH_NO_AI !== '1' && fs.existsSync(P.VAULT)) {
      const book = () => knowledgebook.rebuild(this, (m) => this.info(m)).catch((e) => this.info(`knowledge book failed: ${e.message}`));
      setTimeout(book, 90000);
      this.timers.push(setInterval(book, 12 * 3600000));
    }
    // Stuck watchdog: a bot that is "working" but has no kill, quest or drop for 7 min gets restarted; twice in 30 min
    // and the task counts as failed.
    this.timers.push(setInterval(() => this.watchdog().catch((e) => this.info(`watchdog: ${e.message}`)), 60000));
    // Health check every 15 min: known failure patterns, deaths, party/server/room, memory -> Discord (lib/health.js).
    this.health = new (require('./health').Health)(this);
    this.timers.push(setInterval(() => this.health.check().catch((e) => this.info(`health: ${e.message}`)), 15 * 60000));
    // Discord slash commands (/report, /bot, /ultras) when a bot token is configured.
    const dcfg = require('./discord').config();
    if (dcfg.token) { const { DiscordBot } = require('./discordbot'); this.discordBot = new DiscordBot(this, dcfg, (m) => this.info(m)); this.discordBot.start().catch((e) => this.info(`discord bot: ${e.message}`)); }
    setTimeout(() => this.refreshUltraReady().catch(() => null), 5 * 60000);
    // Skua's scripts are fixed and extended every week. The updater (runAll, every 6 h) is the only thing that pulls
    // them: a second puller here ran in the same second every 24 h and broke both pulls (09-25, 09-26).
    // Seraph's fixes for broken library scripts are rebuilt against the library now and after every update, and a fix
    // that no longer applies is reported (lib/scriptfix.js) instead of retiring silently.
    this.checkScriptFixes();
    this.updater.onScriptsChanged = () => this.checkScriptFixes();
    this.updater.onSkuaRelease = (tag, was) => this.notify(`Skua ${tag} released`, `Was ${was}. The script library is being reset (Skua's "Reset Scripts"); the PC's auto-update rebuilds the engine at its next run.`, 'news');
    // The real client's quest requirement order (lib/questorder.js), built in a child process when it is missing.
    setTimeout(() => require('./questorder').refresh((m) => this.info(m)), 10000);
    // The compact quest index (lib/questindex.js) instead of the whole 20 MB QuestData.json in this process's heap.
    setTimeout(() => require('./questindex').refresh((m) => this.info(m), () => require('./knowledge').questsChanged()), 20000);
    // Old session logs, quest-loop dumps and an overgrown journal (lib/logs.js), at start and daily.
    const prune = () => { try { const r = require('./logs').prune(P.ACCOUNTS_DIR); if (r.removed || r.rotated) this.info(`logs: removed ${r.removed} old files, rotated ${r.rotated} journal(s)`); } catch (e) { this.info(`logs: ${e.message}`); } };
    setTimeout(prune, 5 * 60000);
    this.timers.push(setInterval(prune, 24 * 3600000));
    this.timers.push(setInterval(() => this.refreshUltraReady().catch(() => null), 30 * 60000));
    this.timers.push(setInterval(() => this.partyTick().catch((e) => this.info(`party tick: ${e.message}`)), 60000));
    this.timers.push(setInterval(() => this.resetRelogTick(), 60000));
    this.timers.push(setInterval(() => this.crowdTick().catch(() => null), 5000));
    // Crew dailies (lib/crewdaily.js): every 15 s, a stage ends the moment the last character holds its item.
    this.timers.push(setInterval(() => this.crewTick().catch((e) => this.info(`crew: ${e.message}`)), 15000));
    // The week's open ultras (lib/weekly.js): one alert a day when a weekly is still undone late in its week.
    this.timers.push(setInterval(() => this.weeklyTick().catch((e) => this.info(`weekly: ${e.message}`)), 30 * 60000));
    // The engine budget's overload check (engineGovernor), and what it saw, every 10 min next to the engine calls.
    this.timers.push(setInterval(() => { try { this.engineGovernor(); } catch (e) { this.info(`engine budget: ${e.message}`); } }, 30000));
    // Walls: today's parks from the journals once the bots are up, then escorts checked every minute.
    setTimeout(() => { for (const b of this.bots.values()) { try { const n = this.walls.seedFromJournal(b); if (n) this.info(`walls: ${n} park(s) of ${b.id} from the journal`); } catch (e) { this.info(`walls: ${e.message}`); } } }, 60000).unref();
    this.timers.push(setInterval(() => { Promise.resolve(this.walls.tick()).catch((e) => this.info(`escort tick: ${e.message}`)); }, 60000));
    // A help squad with no kill after squad.ESCALATE_MS calls everyone (lib/squad.js).
    this.timers.push(setInterval(() => { Promise.resolve(this.helpTick()).catch((e) => this.info(`help tick: ${e.message}`)); }, 30000));
    this.timers.push(setInterval(() => { this.crowdHours.sample().catch(() => null); }, 10 * 60000));
    // What the Skua engines ask the world model for, and what it costs (lib/skua/engine.js), every 10 min.
    this.timers.push(setInterval(() => {
      const eng = require('./skua/engine');
      const top = eng.callStats();
      const pk = eng.packetStats();
      if (this.flash && this.flash.running()) {
        // How late the hub's own event loop runs (every Flash answer waits for it too).
        if (!this._loopDelay) { try { this._loopDelay = require('perf_hooks').monitorEventLoopDelay({ resolution: 20 }); this._loopDelay.enable(); } catch (e) { /* old node */ } }
        if (this._loopDelay) { this.info(`hub event loop delay (10 min): p50 ${Math.round(this._loopDelay.percentile(50) / 1e6)} ms, p99 ${Math.round(this._loopDelay.percentile(99) / 1e6)} ms, max ${Math.round(this._loopDelay.max / 1e6)} ms`); this._loopDelay.reset(); }
        const fc = this.flash.callStats(true);
        const n = fc.reduce((a, c) => a + c.n, 0);
        if (n) this.info(`flash calls (10 min): ${n} calls | ${fc.slice(0, 10).map((c) => `${c.call} ${c.n}x ${(c.ms / Math.max(1, c.n)).toFixed(0)}ms (host ${((c.host || 0) / Math.max(1, c.n)).toFixed(0)})`).join(' | ')}`);
      }
      try {
        const eb = this.engineBudget();
        const c = eb.load && eb.load.cpu;
        this.info(`engine budget: ${eb.busy.length} busy (floor ${eb.floor}, up to ${eb.ceiling}), ${eb.idle.length} idle, ${eb.waiting.length} waiting${c ? `, CPU pressure ${Math.round(c.avg60)}/${Math.round(c.avg300)} %` : ''}${eb.load && eb.load.memCur ? `, memory ${Math.round(eb.load.memCur / 1048576)} MB` : ''}${eb.room.ok ? '' : ` - next: ${eb.room.why}`}`);
      } catch (e) { /* the log line is optional */ }
      if (!top.length) return;
      const all = top.reduce((a, p) => ({ n: a.n + p.n, ms: a.ms + p.ms }), { n: 0, ms: 0 });
      this.info(`engine calls (10 min): ${all.n} calls, ${(all.ms / 1000).toFixed(1)} s | ${top.slice(0, 8).map((p) => `${p.call} ${p.n}x ${(p.ms / 1000).toFixed(1)}s ${Math.round(p.bytes / 1024)}KB`).join(' | ')}`);
      if (pk.length) {
        const sum = pk.reduce((a, p) => ({ n: a.n + p.n, bytes: a.bytes + p.bytes }), { n: 0, bytes: 0 });
        this.info(`engine packets (10 min): ${sum.n} packets, ${Math.round(sum.bytes / 1024)} KB | ${pk.slice(0, 8).map((p) => `${p.cmd} ${p.n}x ${Math.round(p.bytes / 1024)}KB`).join(' | ')}`);
      }
    }, 10 * 60000));
    // No local AI on the home server: the rule brain runs the bots there, the model only ever advised.
    this.ai = process.env.SERAPH_NO_AI !== '1';
    if (this.ai) setTimeout(() => this.overseer.start(), 30000);
    else this.info('AI brain off (SERAPH_NO_AI=1): the rules run the party');
    this.timers.push(setInterval(() => this.writeReports(), 60 * 60000));
    // One Discord summary a day rather than a running commentary.
    this.timers.push(setInterval(() => { const h = new Date().getHours(); if (h === 20 && this._digestDay !== new Date().toDateString()) { this._digestDay = new Date().toDateString(); require('./report').toDiscord(this, { hours: 24 }).catch((e) => this.info(`report: ${e.message}`)); if (new Date().getDay() === 0) require('./report').weeklyToDiscord(this).catch((e) => this.info(`weekly report: ${e.message}`)); } }, 55 * 60000));
    this.timers.push(setInterval(() => this.updater.runAll().catch((e) => this.info(`updater error ${e.message}`)), 6 * 3600000));
    if (this.standby) this.timers.push(setInterval(() => { if (!this._standbyBusy) { this._standbyBusy = true; this.standby.tick().catch((e) => this.info(`flash standby: ${e.message}`)).finally(() => { this._standbyBusy = false; }); } }, 60000));
    setTimeout(() => this.updater.runAll().catch((e) => this.info(`updater error ${e.message}`)), 20000);
  }

  // Headless clients own their connection: if the socket drops, stop the bot, reconnect, then carry on.
  // A client the hub no longer owns (account removed, or removed and added again - the owner's main on 2026-10-14, first
  // added with a wrong password): its reconnect loop kept logging in every few minutes and revived the old bot, so two
  // copies of the account kicked each other off for hours.
  stale(acc, client) { return !!client._closed || (this.clients && this.clients.get(acc.id) !== client); }

  reconnect(acc, client, bot) {
    if (client._reconnecting || this.disposed || this.stale(acc, client)) return;
    if (client.scriptDriven) return;   // a Skua script logged out on purpose and will connect again itself
    if (client._holdOffline) return;   // logged out on purpose (dashboard Log out, or someone else is playing it)
    // Somebody logged in to this account (AQW's multiLoginWarning) - the owner is playing it himself. standAside() stops
    // the knocking; the same call also runs from the client's own 'multiLogin' event, which fires mid-reconnect too.
    if (client._multiLoginAt && Date.now() - client._multiLoginAt < 5 * 60000) { this.standAside(acc, client, bot); return; }
    client._reconnecting = true;
    client._offlineSince = client._offlineSince || Date.now();   // health.js: nobody in game for long = tell the owner
    const wasRunning = bot.running;
    try { bot.stop(); } catch (e) { /* already stopped */ }
    const tryOnce = (attempt) => {
      if (this.disposed) return;
      if (this.stale(acc, client)) { client._reconnecting = false; return; }
      // The owner logged in while we were retrying (2026-10-21). The old loop carried on and logged him straight back
      // out, every 20 s: "i was on nova but cant do anything cause you are trying to log her in".
      if (client._holdOffline) { client._reconnecting = false; return; }
      this.info(`${acc.id}: reconnecting (try ${attempt})`);
      client.reset();
      client._loginInFlight = true;   // the guild list shows our own login as "online" too (ownerGuild)
      client.start().then(() => {
        client._loginInFlight = false; client._ownerDropAt = null;
        client._reconnecting = false;
        client._offlineSince = null; client._lastLoginError = null;
        this.info(`${acc.id}: back online`);
        if (String(client.serverName || '').toLowerCase() === crowd.CROWD_SERVER.toLowerCase()) bot._crowdMisses = 0;
        // restart(), not start(): a Skua script can take ~45 s to stop, and start() does nothing while the old loop is
        // still ending. Oren's reset relog came 9 s into a script on 2026-09-30: the login was back in 20 s, the
        // loop ended 6 s after that, and the character stood still for 26 h.
        if (wasRunning) setTimeout(() => bot.restart(), RECONNECT.resume);
      }).catch((e) => {
        client._loginInFlight = false;
        const full = e && e.code === 'SERVER_FULL';
        if (!full || attempt % 10 === 1) this.info(`${acc.id}: reconnect failed - ${e.message}`);
        if (!full) client._lastLoginError = String(e && e.message || e).slice(0, 200);
        // "Your game client is an older version" (AQW 5.0, 2026-10-10): the new game file has a new login version.
        // Read it now instead of at the next 6-hourly updater run (that took 52 min on the day).
        if (/older version|requires AQW game version/i.test(String(e && e.message)) && Date.now() - (this._versionCheckAt || 0) > 5 * 60000) {
          this._versionCheckAt = Date.now();
          this.updater.gameVersion().then(() => this.updater.save()).catch(() => null);
        }
        // Artix full: log in on the quiet server and keep working there; crowdTick watches the server list every 5 s
        // and brings the character back for its crowded work when a seat opens. Knocking while offline cost up to an
        // hour a time (2026-09-27/28).
        // The old stopgap (quiet server, retry later with growing waits) only when crowdKnockOffline is set to false:
        // by default the character knocks (waitForSeat), as the owner asked on 2026-10-05.
        if (full && this.settings.crowdKnockOffline === false) {
          bot.wantServer = crowd.QUIET_SERVER;
          Hub.crowdMiss(bot);
          client._fullSince = null;
          this.info(`${acc.id}: ${crowd.CROWD_SERVER} is full - working on ${crowd.QUIET_SERVER} until a seat opens`);
          setTimeout(() => tryOnce(attempt + 1), 2000);
        } else if (full) waitForSeat(attempt + 1);
        else setTimeout(() => tryOnce(attempt + 1), Math.min(5 * 60000, 20000 * attempt));
      });
    };
    // A full Artix (headless.pickServer): the owner wants a try every 5 s. A login every 5 s per character would look like
    // an attack on the login server, so the public server list is read every 5 s and the character logs in the moment
    // a seat shows up (or when headless' hour of waiting is over and any busy server will do).
    const waitForSeat = (attempt) => {
      const tick = () => {
        if (this.disposed) return;
        if (client._holdOffline) { client._reconnecting = false; return; }   // standing aside: stop knocking
        if (client._fullSince && Date.now() - client._fullSince >= FULL_WAIT_MAX) return tryOnce(attempt);
        protocol.servers().then((list) => {
          const s = (list || []).find((x) => String(x.sName).toLowerCase() === crowd.CROWD_SERVER.toLowerCase());
          if (s && s.bOnline && s.iCount < s.iMax) { this.info(`${acc.id}: a seat on ${s.sName} (${s.iCount}/${s.iMax}) - logging in`); tryOnce(attempt); } else setTimeout(tick, crowd.KNOCK_POLL_MS);
        }, () => setTimeout(tick, crowd.KNOCK_POLL_MS));
      };
      setTimeout(tick, crowd.KNOCK_POLL_MS);
    };
    // The owner's own account dropped with no multiLoginWarning and not by Seraph (2026-10-27 14:26: the server closed the
    // main's socket without the warning when he logged in; the reconnect logged it back in over him 2.5 min later and he
    // had to press Log out). Wait ownerDropWaitMin (5) first: the guild list (ownerGuild) showing him online meanwhile
    // means he is playing, and standAside ends this reconnect. A disconnect Seraph asked for logs straight back in.
    const planned = !!(client._plannedDropAt && Date.now() - client._plannedDropAt < 2 * 60000);
    client._plannedDropAt = null;
    const waitMin = this.settings.ownerDropWaitMin != null ? Math.max(0, Number(this.settings.ownerDropWaitMin) || 0) : 5;
    // Silent for 20 s before it closed = the network died (the laptop's Wi-Fi stalls); the owner logging in closes it at once.
    // A stall at 13:08 10-28 cost the main 5 min and a Nightmare Carnax crew round.
    const silent = !!(client.lastInbound && Date.now() - client.lastInbound > 20000);
    const ownWait = Hub.isGuest(acc) && !planned && !silent ? waitMin * 60000 : 0;
    if (ownWait) {
      client._ownerDropAt = Date.now();
      this.info(`${acc.id}: lost the connection without a warning - waiting ${waitMin} min before logging in, in case it is you`);
      bot.journal(`lost the connection without a "logged in elsewhere" warning - waiting ${waitMin} min before logging back in, in case you are logging in`);
    } else client._ownerDropAt = null;
    setTimeout(() => tryOnce(1), ownWait || RECONNECT.wait);
  }

  // Artix was full at login: each miss in a row waits longer before crowdTick sends the character again (5, 10, 20,
  // then 40 min); crowded work rests at least 10 min.
  static crowdMiss(bot, now = Date.now()) {
    bot._crowdMisses = (bot._crowdMisses || 0) + 1;
    bot._crowdRetryAt = now + Math.min(40, 5 * Math.pow(2, bot._crowdMisses - 1)) * 60000;
    bot.crowdFullUntil = Math.max(now + 10 * 60000, bot._crowdRetryAt);
    return bot._crowdRetryAt;
  }

  // The crowded server's seats from the public server list (shared 4 s cache): a "1500/1500" string when it is full
  // (or offline), null when there is room.
  async crowdFull() {
    const list = await protocol.servers();
    const s = (list || []).find((x) => String(x.sName).toLowerCase() === crowd.CROWD_SERVER.toLowerCase());
    if (!s) return 'not listed';
    if (!Number(s.bOnline)) return 'offline';
    // A margin, not the last seat: at 1497/1500 the seat is gone before the login finishes (2026-09-29).
    return Number(s.iCount) >= Number(s.iMax) - SEAT_MARGIN ? `${s.iCount}/${s.iMax}` : null;
  }

  // The stand-in for a full Artix (bot.ensureServer, after an hour of waiting): the busiest other server a free
  // character of this level can enter that has room. null when there is none.
  async crowdAlt(level = 1) {
    const list = await protocol.servers();
    const ok = (list || []).filter((s) => Number(s.bOnline) && !Number(s.accessLevel) && !Number(s.bUpg) && level >= Number(s.iLevel || 0)
      && !/^(class test|ptr)$/i.test(s.sName) && String(s.sName).toLowerCase() !== crowd.CROWD_SERVER.toLowerCase()
      && Number(s.iCount) < Number(s.iMax) - ALT_MARGIN);
    ok.sort((a, b) => Number(b.iCount) - Number(a.iCount));
    return ok.length ? String(ok[0].sName) : null;
  }

  // Every 5 s while someone waits for a seat on a full Artix (bot.ensureServer): the moment one opens, those characters
  // drop their quiet stopgap work (not raids, help calls or orders) and go back to their crowded work.
  async crowdTick(now = Date.now()) {
    const waiting = [...this.bots.values()].filter((b) => b.running && b.crowdFullUntil > now && !(b._crowdRetryAt > now));
    if (!waiting.length || this._crowdChecking) return null;
    this._crowdChecking = true;
    try {
      // Room on two checks in a row (5 s apart), so a seat that flickers open for a moment doesn't send anyone.
      if (await this.crowdFull().catch(() => 'unknown')) { this._seatSeen = 0; return false; }
      this._seatSeen = (this._seatSeen || 0) + 1;
      if (this._seatSeen < 2) return false;
      for (const b of waiting) {
        b.crowdOpen();
        const t = b.current;
        b.journal(`a seat opened on ${crowd.CROWD_SERVER} - back to the crowded work`);
        if (t && t.brain && !t.raid && t.type !== 'assist' && crowd.kindOf(t) !== 'crowd') b.restart();
      }
      return true;
    } finally { this._crowdChecking = false; }
  }

  // Daily reset relog (the owner, 2026-09-23): the game hands out the new day's dailies at login, so every character logs
  // out and back in once after the midnight-Eastern reset. It uses the same drop-and-reconnect path as a lost socket
  // (hub.reconnect: stop, log in, carry on with the brain), waits 2 min past the reset, does one character per minute
  // so the login server and the engines aren't hit at once, and leaves raid members alone until their raid is over.
  // A character that logged in after the reset (a restart, a Wi-Fi reconnect) is already fresh and is skipped.
  resetRelogTick(now = Date.now()) {
    if (!this.headless || this.disposed) return null;
    const day = serverDay(new Date(now - 2 * 60000));
    for (const [id, client] of this.clients) {
      if (!client._loginDay || client._loginDay >= day || client._reconnecting) continue;
      if (!client.state || !client.state.loaded) continue;
      if (this.raid && this.raid.members.includes(id)) continue;
      if (Hub.isGuest(this.bots.get(id))) continue;   // The owner's own account: he decides when it logs out
      client._loginDay = day;                        // once per day, even if this login needs retries
      this.info(`${id}: daily reset - logging out and back in so today's dailies show up`);
      const bot = this.bots.get(id);
      if (bot && bot.journal) bot.journal('daily reset: logging out and back in');
      client.scriptDriven = false;
      // The real game (Flash standby) disconnects through the game; the bot's login loop brings it back.
      Promise.resolve(client.flash ? client.fn('sfc.disconnect') : client.call('sfc.disconnect')).catch(() => null);
      return id;                                     // one per tick
    }
    return null;
  }

  // One of the owner's own accounts (accounts kind 'guest'): it does the orders it is given and nothing else - no party,
  // raids, help calls, escorts, reset relogs or ultra seats.
  // How many of an item a character holds, backpack and bank.
  static async held(bot, name) {
    const n = String(name).toLowerCase();
    let total = 0;
    for (const i of await bot.items()) if (String(i.sName).toLowerCase() === n) total += Number(i.iQty || 1);
    for (const i of (await bot.bankItems().catch(() => [])) || []) if (String(i.sName).toLowerCase() === n) total += Number(i.iQty || 1);
    return total;
  }
  // Map-script events a headless client could not act on (lib/net/headless.js noteMapEvent), kept in
  // knowledge/map-events.json: map -> event -> first seen / count / sample. The map-code scan works from this list.
  static noteMapEvent(e) {
    const file = path.join(P.KNOWLEDGE, 'map-events.json');
    let all = {};
    try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (x) { /* first one */ }
    const key = e.fct ? `${e.cmd}:${e.fct}` : e.cmd;
    const m = (all[e.map] = all[e.map] || {});
    const r = (m[key] = m[key] || { first: new Date().toISOString(), n: 0, sample: e.sample });
    r.n++;
    r.last = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(all, null, 1));
  }
  // Tries a boss gets per period before it waits for the next one: a weekly WITH a proven recipe (Ultra Speaker) gets six - its
  // fight is a ~1 in 3 win even with the proven line-up (2 wins in 9 tries on 2026-10-24) and the week is the only chance.
  // Every other boss keeps two: raising the cap for a boss nobody ever killed reopened Champion Drakath (18:57 on the day of
  // the deploy, 14 M wipes) and tied up the main and the crew.
  static tryCap(b) {
    if (!b || b.every !== 'week') return 2;
    try { return require('./recipes').active(b.id) ? 6 : 2; } catch (e) { return 2; }
  }
  static isGuest(b) { const a = b && (b.account || b); return !!(a && a.kind === 'guest'); }
  // The owner's main as a helper (2026-10-14, accounts.json `helper: true`): it answers the party's help calls and then
  // goes back to its own work. Since 2026-10-25 it calls the party like the bots (mainCallsParty); it still doesn't relog at reset.
  static helper(b) { const a = b && (b.account || b); return !!(a && a.kind === 'guest' && a.helper); }

  // The owner's main on one of HIS orders (dashboard / API, not the brain's goals) answers no help calls (2026-10-28:
  // two Flibbitiestgibbet calls into a full room pulled it off his Kathool Adept order mid Voice in the Sea fight - a
  // 6-min kill thrown away each time). hub setting mainHelpsDuringOrders: true brings the old way back.
  mainOnOrder(b, now = Date.now()) {
    if (!b || !Hub.isGuest(b) || (this.settings && this.settings.mainHelpsDuringOrders === true)) return false;
    const order = (t) => !!(t && !t.brain && t.type !== 'idle' && !Bot.hubWork(t));
    if (b.current) return order(b.current);
    return (b.queue || []).some((q) => order(q) && !(q.restUntil && q.restUntil > now) && !(q.waitGold && b.goldNow && b.goldNow() < q.waitGold));
  }

  open(acc) {
    if (this.clients.has(acc.id)) return this.clients.get(acc.id);
    // A character on the Flash standby plays the real game (lib/flashstandby.js); the rest use the headless client.
    const flash = this.standby && this.standby.modeOf(acc.id) === 'flash';
    const client = flash ? new FlashClient(acc, this.flash, { fps: this.standby.cfg().fps })
      : this.headless ? new HeadlessClient(acc, { preferServer: () => this.serverFor(acc) }) : new GameClient(acc, this.electron);
    // Headless behaviour (reconnects, manners, HTTP bank): every client on the headless server but a Flash one.
    const hl = !!(client.headless || (this.headless && !client.flash));
    const bot = new Bot(client, acc, { brain: this.brain, hub: this });
    this.clients.set(acc.id, client);
    this.bots.set(acc.id, bot);
    // The owner's own accounts stay logged out until he asks for them (acc.online): a service restart must never log in
    // over him while he plays.
    // A character the owner stepped in front of stays out over a restart too (standAside wrote the time into
    // accounts.json). It comes back by itself when the wait is up, or at once when he presses Start.
    const asideUntil = Number(acc.standAsideUntil || 0);
    const aside = hl && asideUntil > Date.now();
    if (aside) {
      client._holdOffline = true;
      client._standAsideUntil = asideUntil;
      const left = Math.round((asideUntil - Date.now()) / 60000);
      this.info(`${acc.id}: still standing aside for you - back in ${left} min (or press Start)`);
      client._standAsideTimer = setTimeout(() => {
        if (this.disposed || !client._holdOffline) return;
        client._standAsideUntil = null;
        client._holdOffline = false;
        this.goOnline(acc.id);
        if (acc.autostart) setTimeout(() => { const b = this.bot(acc.id); if (b) b.start(); }, 20000);
      }, asideUntil - Date.now());
    }
    const started = aside || (Hub.isGuest(acc) && !acc.online && hl) ? (client._holdOffline = true, null) : client.start();
    if (started && typeof started.catch === 'function') started.catch((e) => {
      this.info(`${acc.id}: ${e.message}`);
      if (hl && e && e.code === 'SERVER_FULL') this.reconnect(acc, client, bot);   // keep knocking on Artix
    });
    client.once('loaded', () => { if (acc.autostart) setTimeout(() => bot.start(), 2000); });
    if (hl) client.on('disconnected', () => this.reconnect(acc, client, bot));
    // AQW's multiLoginWarning reaches the session that loses the character, i.e. us when the owner logs in. Handle it on
    // the event, not only inside reconnect(): a reconnect already in flight never looked at it (2026-10-21).
    if (hl) client.on('multiLogin', () => { try { this.standAside(acc, client, bot); } catch (e) { this.info(`${acc.id}: ${e.message}`); } });
    client.on('monsterDied', (m) => { try { this.bossKilled(bot, m); } catch (e) { /* never break the packet loop */ } });
    client.on('mapEvent', (e) => { try { Hub.noteMapEvent(e); } catch (x) { /* notes only */ } });
    // Public-room manners (lib/manners.js, the owner 2026-09-27): what the client needs to know to behave in a public room.
    if (hl) {
      client.manners = {
        crowd: () => this.settings.crowd !== false && crowd.kindOf(bot.current) === 'crowd',
        daily: () => !!(bot.current && (bot.current.type === 'daily' || /(^|\/)Dailies\/|Daily-Classes\//i.test(String(bot.current.path || '').replace(/\\/g, '/')))),
        chainDaily: () => !!(bot.current && crowd.chainDaily(bot.current.path)),
        isBoss: (hpMax) => this.isBoss(bot, hpMax),
        solo: () => this.soloBosses(bot),
        ours: () => this.ourPlayers(),
        wall: (name) => this.isPartyWall(name),
        privateRoom: () => (this.settings.levelParty && this.settings.levelParty.room) || null,
        canGoPublic: () => this.canGoPublic(bot),
      };
      client.on('manners', (e) => {
        if (e.kind === 'public') { this.goPublic(bot, e.boss); return; }
        bot.journal(e.text);
        // A Skua script can't be told "nobody came": it would stand there until the watchdog parks it for the day.
        // Rest that task for skipHours instead; a daily's own hunt ends by itself (bot.hunt).
        const t = bot.current;
        if (e.kind === 'skip' && t && t.type === 'script' && !t.raid) {
          bot.skipped = bot.skipped || new Map();
          bot.skipped.why = 'public-room manners: gave up waiting for players - back at the next crowd window';
          bot.skipped.set(bot.taskKey(t), crowd.windowAfter(Date.now(), crowd.MANNERS.skipHours * 3600000));
          if (!t.brain) bot._dropCurrent = true;
          bot.journal(`setting "${t.why || t.path}" aside for ${crowd.MANNERS.skipHours} h: ${e.boss} needs players and none are here yet`);
          bot.restart();
        }
      });
    }
    client.on('loaded', () => { client._loginDay = serverDay(); client._loadedAt = Date.now(); });   // every login, Skua's own relogs too
    client.on('loaded', () => this.friendWatch.onLogin(bot));
    // Every login rebuilds the game world (skua.swf reset -> a new, empty bank). Skua scripts then load the bank with the
    // loadBank packet, which leaves out classes, armor and capes, and the brain kept its 30-min cache: after a server
    // move or a Wi-Fi relog the bots "didn't own" banked things and asked for them again (the owner, 2026-10-09). Fetch
    // the whole bank over HTTP (api/char/bank, as the game does) a few seconds after each login.
    client.on('loaded', () => {
      bot._bank = null;
      if (!hl || !client.swf || !client.swf.game || typeof client.swf.game.getBank !== 'function') return;
      setTimeout(() => { try { client.swf.game.getBank(); } catch (e) { /* bot.bankReady / bankItems ask again */ } }, 1000);
    });
    // The owner's account (2026-10-23): his server outfits only work from the game's outfit button when every piece is in
    // the backpack, so after each login any piece sitting in the bank is taken out.
    client.on('loaded', () => {
      if (!bot.isGuest || !bot.isGuest()) return;
      // 15 s and again at 3 min: right after a login the bag size can still read 0 (12:43 2026-10-23 "no backpack
      // room" with 33 free), so a second pass picks up what the first one could not move.
      const pass = () => bot.outfitsToBag().then((m) => { if (m.length) bot.journal(`outfit pieces back in the backpack: ${m.join(', ')}`); }).catch(() => null);
      setTimeout(pass, 15000);
      setTimeout(pass, 180000);
    });
    bot.on('levelUp', ({ level }) => {
      this.notify(`${acc.label} reached level ${level}`, 'Level up!', 'levelUp');
      if (this.settings.gallery && level % 5 === 0) this.snap(acc.id, `level-${level}`);
    });
    bot.on('rareDrop', ({ name }) => { this.notify(`${acc.label} picked up ${name}`, 'AC / rare drop', 'drop'); if (this.settings.gallery) this.snap(acc.id, `drop-${name}`); });
    bot.on('alert', ({ title, body }) => this.notify(`${acc.label}: ${title}`, body, 'alert'));
    bot.on('stackStuck', (e) => { try { this.relogForStack(acc.id, e); } catch (x) { /* never break the packet loop */ } });
    client.on('loaded', () => { if (bot._stackWatch) bot._stackWatch.clear(); });
    client.on('crash', (what) => this.notify(`${acc.label}: client crashed`, `${what} - reloading`, 'crash'));
    bot.on('state', () => this.emit('state', acc.id));
    this.info(`opened account ${acc.id}`);
    this.emit('accounts');
    return client;
  }

  // How many Skua engines may run at once. This - not the number of characters - is what the laptop's RAM has to
  // fit: a logged-in headless character costs ~15 MB inside node ([[Laptop-Server]]: "about 60 MB for all four"),
  // while every running engine is a .NET process of 250-330 MB. 8 characters sharing 3 engines is therefore LIGHTER
  // than 4 characters sharing 5, which is what the laptop ran until 2026-10-21 (1.66 GB, load 6-9, 725 MB in swap).
  // hub.json `maxEngines` (or SERAPH_MAX_ENGINES) still wins when it is set; otherwise it is sized to the machine
  // (lib/enginelimits.js: 3 on the 3 GB laptop, more on bigger machines).
  static maxEngines(settings = {}, headless = false, total = require('os').totalmem(), cpus = undefined) {
    const m = { ...enginelimits.machine(), totalBytes: total, ...(cpus ? { cpus } : {}) };
    return enginelimits.resolve(settings, { machine: m, headless }).values.maxEngines;
  }

  // ENGINE BUDGET (the owner 2026-10-23: "push the laptop ... squeeze more skua engines, 4 is delaying a lot of progress").
  // maxEngines above is the FLOOR every character can count on. Above it, up to engineCeiling (one per character,
  // at most 8) an engine starts only while the laptop has room - read from the kernel, not guessed:
  //   CPU pressure of the service's cgroup (PSI "some", % of time a thread waited for a core), its memory against
  //   MemoryHigh, MemAvailable, and one engine start at a time (a cold start is 20-30 s of a full core).
  // Why a fixed number can't do this (sar on the laptop): six engines ran 10 h at ~55 % CPU on 10-21/22, then forge
  // scripts on five of them took both cores to 99 % (load 23) at 07:40; four engines with an ultra raid hit 99 % too.
  // So engineGovernor() also hands a burst engine back when the pressure stays high. Engine patch 16 (memory-mapped
  // compiler references) took an engine from ~180 MB to ~50-75 MB private, which is what makes 8 fit in memory.
  // 2026-10-29: no fixed 8 any more - one per character unless engineCeiling says otherwise, so a big machine with 30
  // characters can run 30 (the kernel readings still decide each start above the floor).
  static engineCeiling(settings = {}, characters = 0, headless = true) {
    return enginelimits.resolve(settings, { headless, characters }).values.engineCeiling;
  }

  // Every engine limit for this hub right now (hub.json, then env, then auto) - settings can change from the dashboard.
  // `this.machine` ({ totalBytes, cpus }) stands in for the real machine where a test models one.
  engineLimits() {
    return enginelimits.resolve(this.settings || {}, { headless: !!this.headless, characters: this.bots ? this.bots.size : 0, machine: this.machine }).values;
  }

  // What the running engines take together: their resident memory where the OS tells (Linux), else the estimate.
  engineMemoryUsedMb(lim = this.engineLimits()) {
    let mb = 0;
    for (const id of this.engineBusy || []) {
      const eng = this.engines && this.engines.get(id);
      const rss = eng && typeof eng.rssMb === 'function' ? eng.rssMb() : null;
      mb += rss != null ? rss : lim.engineMb;
    }
    return mb;
  }

  // The kernel's view of the service: cgroup v2 cpu.pressure + memory.current/high, /proc/meminfo MemAvailable.
  // Anything unreadable (the PC, an old kernel) gives { ok: false }: no burst, the floor alone.
  static engineLoad(read = (f) => require('fs').readFileSync(f, 'utf8')) {
    const psi = (txt) => { const m = /some avg10=([\d.]+) avg60=([\d.]+) avg300=([\d.]+)/.exec(txt || ''); return m ? { avg10: +m[1], avg60: +m[2], avg300: +m[3] } : null; };
    const tryRead = (f) => { try { return read(f); } catch (e) { return null; } };
    const cg = ((tryRead('/proc/self/cgroup') || '').match(/^0::(\S+)/m) || [])[1];
    const dir = cg && cg !== '/' ? `/sys/fs/cgroup${cg}` : null;
    const cpu = (dir && psi(tryRead(`${dir}/cpu.pressure`))) || psi(tryRead('/proc/pressure/cpu'));
    const num = (t) => (t == null || /^\s*max\s*$/.test(t) ? null : Number(t.trim()) || null);
    const memCur = dir ? num(tryRead(`${dir}/memory.current`)) : null;
    const memHigh = dir ? num(tryRead(`${dir}/memory.high`)) : null;
    const avail = Number(((tryRead('/proc/meminfo') || '').match(/^MemAvailable:\s+(\d+)/m) || [])[1]) * 1024 || null;
    return { ok: !!cpu, cpu, memCur, memHigh, avail };
  }

  engineLoadNow(now = Date.now()) {
    if (!this._engineLoad || now - this._engineLoad.at > 5000) this._engineLoad = { at: now, v: Hub.engineLoad() };
    return this._engineLoad.v;
  }

  // May the character first in line start an engine now? Below the floor always; above it only with room to spare.
  // A raid member skips the CPU and stagger checks (v3 drops a member after 5 min) - the governor sheds the others.
  // Slots kept for characters between two tasks (engineDone): busy for everyone else until they expire.
  engineHeld(now = Date.now()) {
    if (!this.engineHolds) return 0;
    let n = 0;
    for (const [id, until] of this.engineHolds) {
      if (until <= now || (this.engineBusy && this.engineBusy.has(id))) this.engineHolds.delete(id);
      else n++;
    }
    return n;
  }

  engineRoom(bot, now = Date.now()) {
    const lim = Hub.prototype.engineLimits.call(this);
    const busy = (this.engineBusy ? this.engineBusy.size : 0) + Hub.prototype.engineHeld.call(this, now);
    // The owner's memory budget for all engines (engineMemoryMb) comes before the floor: it is the hard line. One
    // engine always may run, or nothing would ever move.
    if (lim.engineMemoryMb > 0 && busy > 0) {
      const used = Hub.prototype.engineMemoryUsedMb.call(this, lim);
      if (used + lim.engineMb > lim.engineMemoryMb) return { ok: false, why: `engine memory ${Math.round(used)}/${lim.engineMemoryMb} MB` };
    }
    const floor = lim.maxEngines;
    if (busy < floor) return { ok: true };
    const ceiling = lim.engineCeiling;
    if (busy >= ceiling) return { ok: false, why: `${busy}/${ceiling} busy` };
    const load = this.engineLoadNow(now);
    if (!load || !load.ok) return { ok: false, why: `${busy}/${floor} busy` };
    const MB = 1048576;
    const need = lim.engineMb * MB;
    if (load.memHigh && load.memCur && load.memCur + need > load.memHigh - 96 * MB) return { ok: false, why: `memory ${Math.round(load.memCur / MB)}/${Math.round(load.memHigh / MB)} MB` };
    if (load.avail && load.avail < need + 256 * MB) return { ok: false, why: `${Math.round(load.avail / MB)} MB free` };
    const raider = !!(bot && this.engineUrgent(bot.id));
    if (raider) return { ok: true, burst: true };
    const coolMs = lim.engineCoolMin * 60000;
    if (this._engineShedAt && now - this._engineShedAt < coolMs) return { ok: false, why: 'the machine was overloaded a few minutes ago' };
    const stagger = lim.engineStaggerSec * 1000;
    if (this._engineStartAt && now - this._engineStartAt < stagger) return { ok: false, why: 'another engine is starting' };
    // An ultra fight gets the cores first: half the usual pressure before another engine joins it.
    const k = this.raid ? 0.5 : 1;
    const max10 = lim.engineAdmitCpu10 * k;
    const max60 = lim.engineAdmitCpu * k;
    if (load.cpu.avg10 > max10 || load.cpu.avg60 > max60) return { ok: false, why: `CPU pressure ${Math.round(load.cpu.avg60)} %` };
    return { ok: true, burst: true };
  }

  // Every 30 s: above the floor, a CPU pressure over engineShedCpu (80 %; 48 % while an ultra raid fights - the raid
  // gets the cores) for two readings in a row, or memory at the unit's MemoryHigh, sends the most recently started
  // burst engine back to the queue (raids, dailies, gifts, escorts and the owner's own account are never the ones sent
  // back). Admissions then rest engineCoolMin. Live 10-23 21:32: eight engines plus a Gramiel raid start = avg60 72 %.
  engineGovernor(now = Date.now()) {
    if (!this.engineBusy || !this.bots) return null;
    const lim = Hub.prototype.engineLimits.call(this);
    const busy = this.engineBusy.size;
    const floor = lim.maxEngines;
    if (busy <= floor) { this._engineHot = 0; return null; }
    const load = this.engineLoadNow(now);
    if (!load || !load.ok) return null;
    const MB = 1048576;
    const overBudget = lim.engineMemoryMb > 0 && Hub.prototype.engineMemoryUsedMb.call(this, lim) > lim.engineMemoryMb;
    const memHot = !!(overBudget || (load.memHigh && load.memCur && load.memCur > load.memHigh - 32 * MB) || (load.avail && load.avail < 150 * MB));
    const cpuHot = load.cpu.avg60 > lim.engineShedCpu * (this.raid ? 0.6 : 1);
    if (!memHot && !cpuHot) { this._engineHot = 0; return null; }
    this._engineHot = (this._engineHot || 0) + 1;
    if (!memHot && this._engineHot < 2) return null;
    let pick = null;
    let since = -1;
    for (const id of this.engineBusy) {
      const b = this.bot(id);
      if (!b || Hub.isGuest(b) || this.engineUrgent(id) || (this.engineYielding && this.engineYielding.has(id))) continue;
      if (!Hub.engineYieldable(b.current)) continue;
      const t = (this.engineSince && this.engineSince.get(id)) || 0;
      if (t > since) { pick = b; since = t; }
    }
    this._engineHot = 0;
    if (!pick) return null;
    this._engineShedAt = now;
    const why = overBudget ? `engines over the ${lim.engineMemoryMb} MB budget` : memHot ? `memory ${Math.round((load.memCur || 0) / MB)} MB` : `CPU pressure ${Math.round(load.cpu.avg60)} %`;
    pick.journal(`handing my Skua engine back: the machine is overloaded (${why}, ${busy} engines) - back to "${(pick.current && (pick.current.why || pick.current.path)) || 'my work'}" on my next turn`);
    this.info(`engine budget: ${pick.account.label} steps back (${why}, ${busy} engines)`);
    Promise.resolve(pick.restart()).catch(() => null);
    return pick.id;
  }

  engineBudget(now = Date.now()) {
    const lim = Hub.prototype.engineLimits.call(this);
    const load = this.engineLoadNow(now);
    return {
      floor: lim.maxEngines,
      ceiling: lim.engineCeiling,
      memoryMb: Math.round(Hub.prototype.engineMemoryUsedMb.call(this, lim)),
      memoryBudgetMb: lim.engineMemoryMb || null,
      busy: this.engineBusy ? [...this.engineBusy] : [],
      idle: this.engines ? [...this.engines.keys()].filter((id) => !(this.engineBusy && this.engineBusy.has(id))) : [],
      waiting: this.engineWaiting ? [...this.engineWaiting] : [],
      room: this.engineRoom(null, now),
      load,
      shedAt: this._engineShedAt || null,
    };
  }

  // Idle engines linger (engineDone) but never at a working - or waiting - character's expense. Returns how many were
  // disposed. With 7-8 characters sharing 3 slots somebody is almost always waiting, so this runs BEFORE queueing.
  reclaimIdleEngines(keepId = null, max = Infinity) {
    if (!this.engines) return 0;
    let freed = 0;
    for (const [id, eng] of [...this.engines]) {
      if (this.engines.size <= max - 1) break;
      if (id === keepId || (this.engineBusy && this.engineBusy.has(id))) continue;
      if (this.engineHolds && (this.engineHolds.get(id) || 0) > Date.now()) continue;   // its owner's next task is coming
      clearTimeout(eng._idle);
      try { eng.dispose(); } catch (e) { /* going away anyway */ }
      this.engines.delete(id);
      freed++;
    }
    if (freed) this.info(`freed ${freed} idle Skua engine(s)`);
    return freed;
  }

  // Skua's real engine (lib/skua/engine.js): one process per character, only while it runs a script.
  async engineFor(bot) {
    this.engines = this.engines || new Map();
    this.engineBusy = this.engineBusy || new Set();
    this.engineWaiting = this.engineWaiting || new Set();
    this.engineWaitSince = this.engineWaitSince || new Map();
    this.engineSince = this.engineSince || new Map();
    const max = Hub.maxEngines(this.settings, this.headless);
    // Give the memory back before standing in the queue, not after winning a slot.
    this.reclaimIdleEngines(bot.id, max);
    let told = false;
    try {
      this.engineWaiting.add(bot.id);
      if (!this.engineWaitSince.has(bot.id)) this.engineWaitSince.set(bot.id, this.engineTurnBack(bot.id) || Date.now());
      // A free slot goes to whoever is first in line (raid members, then the longest wait), not to whoever polls first:
      // a character that just gave its engine up must not take it straight back. Above the floor, engineRoom decides.
      for (;;) {
        if (this.engineBusy.has(bot.id)) break;
        // Its own slot, held since its last task ended (engineDone).
        const hold = this.engineHolds && this.engineHolds.get(bot.id);
        if (hold) { this.engineHolds.delete(bot.id); if (hold > Date.now()) break; }
        const room = this.engineNext() === bot.id ? this.engineRoom(bot) : { ok: false };
        if (room.ok) break;
        if (!told) { bot.journal(`waiting for a free Skua engine (${this.engineBusy.size} busy, floor ${max}, ${this.engineWaiting.size} waiting${room.why ? `; ${room.why}` : ''})`); told = true; }
        this.engineYield();
        await bot.wait(5000);
      }
    } finally { this.engineWaiting.delete(bot.id); this.engineWaitSince.delete(bot.id); }
    this.engineBusy.add(bot.id);
    this.engineSince.set(bot.id, Date.now());
    this._engineStartAt = Date.now();
    let eng = this.engines.get(bot.id);
    // VibeSkua's per-class adaptive skills inside Skua scripts (engine patch 13), per character: `adaptiveSkills`.
    const adaptiveSkills = bot.settings.adaptiveSkills === true;
    // The per-engine limits (heap, recycle point, nice) from enginelimits: a change on the dashboard reaches each
    // character's next script, through a fresh engine.
    const lim = this.engineLimits();
    const per = { heapMb: lim.engineHeapMb, recycleMb: lim.engineRecycleMb, nice: lim.engineNice };
    const changed = eng && ['heapMb', 'recycleMb', 'nice'].some((k) => eng.opts[k] !== per[k]);
    if (!eng || eng.client !== bot.client || !!eng.opts.adaptiveSkills !== adaptiveSkills || changed) {
      if (eng) eng.dispose();
      this.reclaimIdleEngines(bot.id, max);
      eng = new SkuaEngine(bot.client, { adaptiveSkills, ...per });
      this.engines.set(bot.id, eng);
    }
    clearTimeout(eng._idle);
    return eng;
  }

  // Engine time-sharing (the owner 2026-10-21: "make sure that all 8 bots can run at the same time"). Eight characters share
  // four engines - the laptop (2 cores, 3 GB) can't hold eight .NET engines, and CPU, not RAM, is already the limit
  // (load 8 with four). Skua scripts run until done (Farmer Joe, class farms: days), so without a turn a character
  // could wait forever (the main queued 14x on 10-21). A holder past its slice gives the engine to the longest waiter
  // and carries on next turn - Skua resumes where it was, the brain books the time (brain.interrupted). Raids,
  // dailies, help calls and gifts are never cut; a raid member waiting takes a slot at once (v3 drops a member after
  // 5 min, and a raid needs all four slots).
  // A raid member, or a member of a crew daily's army fight (lib/crewdaily.js): an army script gives a member up after 5 min
  // without an engine, so these take a slot at once.
  engineUrgent(id) {
    return !!((this.raid && this.raid.members.includes(id)) || (this.crew && this.crew.phase === 'stage' && this.crew.scriptStage && this.crew.members.includes(id)));
  }

  engineNext() {
    const waiting = [...(this.engineWaiting || [])];
    if (!waiting.length) return null;
    const raiders = waiting.filter((id) => this.engineUrgent(id));
    // The owner's own account next (2026-10-21: "why is my main waiting for a free skua engine"): it never queues behind
    // the party's long farms.
    const own = this.bots ? waiting.filter((id) => { const b = this.bot(id); return !!(b && Hub.isGuest(b)); }) : [];
    const pool = raiders.length ? raiders : own.length ? own : waiting;
    const since = (id) => (this.engineWaitSince && this.engineWaitSince.get(id)) || 0;
    return pool.sort((a, b) => since(a) - since(b))[0];
  }

  static engineYieldable(t) {
    return !!(t && t.type === 'script' && !t.raid && !t.crewScript && !t.gift && !t.escort && !Hub.dailyWork(t));
  }

  engineYield(now = Date.now()) {
    if (!this.engineBusy || !this.engineWaiting || !this.engineWaiting.size) return null;
    const next = this.engineNext();
    const raider = this.engineUrgent(next);
    const nb = this.bots && this.bot(next);
    const urgent = raider || !!(nb && Hub.isGuest(nb));
    // One hand-over a minute, except for a raid: it needs every slot inside v3's 5-minute wait.
    if (!urgent && this._engineYieldAt && now - this._engineYieldAt < 60000) return null;
    this.engineYielding = this.engineYielding || new Set();
    // A slot that is already free (below the floor) or that the budget would grant (engineRoom) is the next one's on
    // its next 5-s poll - nobody has to stop for it. Without this, any other waiter's poll in those 5 s made a second
    // holder give way for the same character: 10-23 21:26 Sable AND Valen stopped for the main, and Valen's
    // forge-ravenous had 8 starts and no finish that day.
    const free = Math.max(0, Hub.maxEngines(this.settings, this.headless) - this.engineBusy.size - Hub.prototype.engineHeld.call(this, now));
    const room = !free && nb && this.engineRoom ? this.engineRoom(nb, now).ok : false;
    if (!raider && (free || room)) return null;
    // Raid members already handed slots (or with a free one waiting) count against the free ones still stopping.
    if (raider && (room || this.engineYielding.size + free >= [...this.engineWaiting].filter((id) => this.engineUrgent(id)).length)) return null;
    const waited = now - ((this.engineWaitSince && this.engineWaitSince.get(next)) || now);
    const slice = (Number(this.settings.engineSliceMin) || 45) * 60000;
    if (!urgent && waited < 3 * 60000) return null;
    // An urgent waiter takes one slot: a second hand-over waits until the first one's script has stopped.
    if (urgent && !raider && this.engineYielding.size) return null;
    let pick = null;
    let held = 0;
    // The owner's own account gives way only to a raid, and only when no party character can (a raid needs every slot).
    // A raid with nothing yieldable left takes the slot from dailies, gifts and escorts too: four engines and four
    // seats, so one protected holder keeps a member out. Edda's BlazeBinder.cs (Daily-Classes/, a 3 h DoomWood rep
    // farm) kept Nova out of Ultra Darkon for 34 min and v3 gave up on her (2026-10-23).
    const passes = raider ? [[false, false], [true, false], [false, true], [true, true]] : [[false, false]];
    for (const [guests, any] of passes) {
      for (const id of this.engineBusy) {
        const b = this.bot && this.bot(id);
        if (!b || this.engineYielding.has(id) || this.engineUrgent(id) || Hub.isGuest(b) !== guests) continue;
        if (!(any ? !!(b.current && b.current.type === 'script' && !b.current.raid && !b.current.crewScript) : Hub.engineYieldable(b.current))) continue;
        const h = now - ((this.engineSince && this.engineSince.get(id)) || now);
        if (!urgent && h < slice) continue;
        // The owner's main takes a slot at once, but never from a script that started under 3 min ago: it has just paid its
        // start-up (10-26: "giving my Skua engine to grail26 after 0 min" 101 times in a day). He waits 3 min at most.
        if (urgent && !raider && h < squad.FRESH_MS) continue;
        if (h > held) { pick = b; held = h; }
      }
      if (pick) break;
    }
    if (!pick) return null;
    this._engineYieldAt = now;
    this.engineYielding.add(pick.id);
    const who = (this.bot(next) && this.bot(next).account.label) || next;
    pick.journal(`giving my Skua engine to ${who}${raider ? ' for the raid' : ''} after ${Math.round(held / 60000)} min - back to "${pick.current.why || pick.current.path}" on my next turn`);
    this.info(`engine: ${pick.account.label} hands its engine to ${who}${raider ? ' (raid)' : ''}`);
    Promise.resolve(pick.restart()).catch(() => null);
    return pick.id;
  }

  // A character pulled off its Skua work for a help call or an escort keeps its turn (Seraph 5, 2026-10-26): a waiter keeps
  // its place in the line, a holder goes to the front of it. Before, every answer to a call sent it to the back of the
  // queue - 5-10 h a day of waiting each, and the veterans' forge scripts never ran more than a few minutes.
  keepEngineTurn(b, now = Date.now()) {
    const since = this.engineWaitSince && this.engineWaitSince.get(b.id);
    const held = !!(this.engineBusy && this.engineBusy.has(b.id));
    if (!since && !held) return null;
    this.engineTurns = this.engineTurns || new Map();
    const old = this.engineTurns.get(b.id);
    const keep = held ? 1 : since;   // 1: older than any real wait
    this.engineTurns.set(b.id, { since: old && old.until > now ? Math.min(old.since, keep) : keep, until: now + ENGINE_TURN_MS });
    return keep;
  }
  engineTurnBack(id, now = Date.now()) {
    const t = this.engineTurns && this.engineTurns.get(id);
    if (!t) return null;
    this.engineTurns.delete(id);
    return t.until > now ? t.since : null;
  }

  engineDone(bot) {
    if (!this.engineBusy) return;
    const wasHeld = this.engineBusy.has(bot.id);
    const yielded = !!(this.engineYielding && this.engineYielding.has(bot.id));
    this.engineBusy.delete(bot.id);
    if (this.engineSince) this.engineSince.delete(bot.id);
    if (this.engineYielding) this.engineYielding.delete(bot.id);
    // Its next task starts seconds later: the slot waits for it (engineHeld) instead of going to the queue - the main
    // took a running bot's engine ~80x a day because every one of its task changes sent it to the back of the line
    // (10-25..27: 240 hand-overs to grail26, 216 of them from scripts under 15 min old). Not after a hand-over.
    if (wasHeld && !yielded) (this.engineHolds = this.engineHolds || new Map()).set(bot.id, Date.now() + ENGINE_HOLD_MS);
    const eng = this.engines && this.engines.get(bot.id);
    if (!eng) return;
    clearTimeout(eng._idle);
    const waiting = this.engineWaiting ? this.engineWaiting.size : 0;
    eng._idle = setTimeout(() => {
      if (this.engineBusy.has(bot.id)) return;
      eng.dispose();
      if (this.engines.get(bot.id) === eng) this.engines.delete(bot.id);
    }, Math.max(Hub.engineIdleMs(undefined, waiting), this.engineHolds && this.engineHolds.has(bot.id) ? ENGINE_HOLD_MS + 5000 : 0));
  }

  // How long a finished engine waits for its character's next script. A cold start (the .NET host plus compiling
  // CoreBots) is the most expensive thing an engine does, and a character often starts its next script within
  // minutes, so keep it 10 min - but only 3 when memory is short, and 20 s when another character is queueing for a
  // slot (with 8 characters on 3 engines, holding 300 MB for a "maybe" is what makes everyone else wait).
  static engineIdleMs(free = require('os').freemem(), waiting = 0) {
    if (waiting > 0) return 20000;
    return free > 700 * 1048576 ? 10 * 60000 : 3 * 60000;
  }

  close(id) {
    if (this.engines && this.engines.has(id)) { this.engines.get(id).dispose(); this.engines.delete(id); }
    const bot = this.bots.get(id);
    const client = this.clients.get(id);
    if (bot) bot.dispose();
    if (client) { client._closed = true; client.stop(); }   // hub.reconnect checks it: a removed account stays gone
    this.bots.delete(id);
    this.clients.delete(id);
    this.emit('accounts');
  }

  // A planned account now exists in AQW: mark it active and open its game view.
  activate(id) {
    const acc = accounts.update(id, { status: 'active' });
    this.info(`account ${id} activated`);
    const client = this.open(acc);
    return { ok: true, id: acc.id, open: !!client };
  }

  add(data) {
    const guest = data.kind === 'guest';
    const acc = accounts.add({ ...data, kind: guest ? 'guest' : 'party', owner: data.owner || (guest ? 'owner' : 'claude'), persona: guest ? null : (data.persona || null), autostart: !guest && !!data.autostart, online: false });
    this.open(acc);
    const bot = this.bot(acc.id);
    // A new account of the owner's: orders only, its gear and class left as he set them, his boosts left for him.
    if (bot && guest) { Object.assign(bot.settings, { autopilot: false, autoGear: false, useBoosts: false, provoke: false }); bot.save(); }
    return acc;
  }

  // Take an account off the bots for good: stop it, log it out, forget it (its journal folder stays).
  remove(id) {
    this.close(id);
    accounts.remove(id);
    return { ok: true };
  }

  // Log a character in (the owner pressed Start / Log in) or out (Log out). A logged-out character stays out: no reconnect.
  goOnline(id) {
    const client = this.clients.get(id);
    const bot = this.bot(id);
    if (!client || !bot) throw new Error(`no account ${id}`);
    try { accounts.update(id, { online: true }); bot.account.online = true; } catch (e) { /* registry only */ }
    client._holdOffline = false;
    client._multiLoginAt = null;
    client._ownerDropAt = null;
    // The owner pressed Start / Log in: he is done with the character, so forget the escalating wait as well.
    clearTimeout(client._standAsideTimer);
    client._standAsideTimer = null; client._standAsideUntil = null; client._standAsideMin = 0; client._standAsideAt = 0;
    try { accounts.update(id, { standAsideUntil: 0 }); if (bot.account) bot.account.standAsideUntil = 0; } catch (e) { /* registry only */ }
    this.ownerClear(id);
    if (!(client.state && client.state.loaded) && !client._reconnecting && (client.headless || (this.headless && !client.flash))) {
      client.reset();
      const p = client.start();
      if (p && p.catch) p.catch((e) => { this.info(`${id}: ${e.message}`); if (!client._holdOffline) this.reconnect(bot.account, client, bot); });
    }
    return { ok: true };
  }
  goOffline(id, why = 'logged out from the dashboard') {
    const client = this.clients.get(id);
    const bot = this.bot(id);
    if (!client || !bot) throw new Error(`no account ${id}`);
    try { accounts.update(id, { online: false }); bot.account.online = false; } catch (e) { /* registry only */ }
    this.ownerClear(id);   // logged out on purpose: no coming back when he logs out
    client._holdOffline = true;
    bot.stop(true);
    bot.journal(why);
    if (client.state && client.state.loaded) client.stop();
    return { ok: true };
  }

  // The owner's own character that he logged in to (standAside wrote acc.ownerOn): the bots see him on their friend lists
  // ({"cmd":"updateFriend"}, sServer "Offline" when he leaves - lib/friendwatch.js). Offline for ownerLogoutMin (10)
  // minutes in a row = he is done: log it back in and carry on (the owner 2026-10-24: "dont start my main and anything that
  // needs my main delay it until i log out"). Back online inside the wait (a relog, a server hop) cancels it. The wait
  // lives in memory only: a restart in the middle leaves the character out until his next logout or Start - a stale
  // "offline" must never log in over him (AQW keeps the newest login and drops his).
  ownerFriend(f, seenBy) {
    const name = String((f && f.sName) || '').toLowerCase();
    if (!name) return null;
    const bot = [...this.bots.values()].find((b) => Hub.isGuest(b) && b.account.ownerOn && [b.account.username, b.account.label, b.id].some((x) => x && String(x).toLowerCase() === name));
    const client = bot && this.clients.get(bot.id);
    if (!client || !client._holdOffline) return null;
    const id = bot.id;
    const online = !!f.sServer && f.sServer !== 'Offline';
    const w = (this._ownerOff = this._ownerOff || {});
    if (online) {
      if (w[id]) { clearTimeout(w[id].timer); delete w[id]; this.info(`${id}: you are back on ${f.sServer} - it stays out`); }
      return 'online';
    }
    if (w[id]) return 'waiting';   // every bot on his friend list gets the same update
    const min = (Number(this.settings.ownerLogoutMin) > 0 ? Number(this.settings.ownerLogoutMin) : 10);
    this.info(`${id}: you logged out (seen by ${(seenBy && seenBy.account && seenBy.account.label) || 'a bot'}) - back in ${min} min unless you log in again`);
    const timer = setTimeout(() => {
      delete w[id];
      if (this.disposed || !bot.account.ownerOn || !client._holdOffline) return;
      this.info(`${id}: ${min} min since you logged out - logging it back in`);
      this.notify(`${bot.account.label}: back online`, `You logged out ${min} min ago, so Seraph logged it back in for its work (raids that need it included).`, 'event');
      const wasRunning = client._ownerWasRunning;
      this.goOnline(id);
      setTimeout(() => { const b = this.bot(id); if (b && !b.running && (wasRunning || b.account.autostart)) b.start(); }, 20000);
    }, min * 60000);
    if (timer.unref) timer.unref();
    w[id] = { timer, at: Date.now() };
    return 'logout';
  }
  // The guild list ({"cmd":"updateGuild","guild":{"ul":[{userName, Server}]}}): the bots share the owner's guild, and that is
  // where they see his main come and go - no updateFriend about it ever reached a bot (2026-10-27), so the 10-24 logout
  // watch (ownerFriend) never fired. Every bot gets the same list, so only a change of a member's server counts.
  ownerGuild(o, seenBy) {
    const ul = o && o.guild && Array.isArray(o.guild.ul) ? o.guild.ul : null;
    if (!ul) return null;
    const seen = (this._guildSeen = this._guildSeen || {});
    let out = null;
    for (const m of ul) {
      const name = String((m && m.userName) || '').toLowerCase();
      if (!name) continue;
      const bot = [...this.bots.values()].find((b) => Hub.isGuest(b) && b.account && [b.account.username, b.account.label, b.id].some((x) => x && String(x).toLowerCase() === name));
      if (!bot) continue;
      const server = String(m.Server || 'Offline');
      if (seen[name] === server) continue;
      const first = !(name in seen);
      seen[name] = server;
      const client = this.clients && this.clients.get(bot.id);
      const online = server !== 'Offline';
      // Our own login shows as online too: only while the character is out after an unexplained drop is "online" him.
      if (online && client && client._ownerDropAt && !client._holdOffline && !client._loginInFlight && !(client.state && client.state.loaded)) {
        this.info(`${bot.id}: the guild list shows it online on ${server} while Seraph is logged out - that is you`);
        this.standAside(bot.account, client, bot, `you logged in to this character (the guild list shows it on ${server})`);
        out = 'aside';
        continue;
      }
      if (!first) out = this.ownerFriend({ sName: m.userName, sServer: server }, seenBy) || out;
    }
    return out;
  }
  ownerClear(id) {
    const w = this._ownerOff && this._ownerOff[id];
    if (w) { clearTimeout(w.timer); delete this._ownerOff[id]; }
    const bot = this.bot(id);
    if (bot && bot.account && bot.account.ownerOn) {
      try { accounts.update(id, { ownerOn: 0 }); } catch (e) { /* registry only */ }
      bot.account.ownerOn = 0;
    }
  }

  // The owner is playing one of the characters himself (2026-10-21: "when i log in into any of the accounts dont start it
  // on seraph dude like i was on nova but cant do anything cause you are trying to log her in").
  // Step aside properly: abort any reconnect in flight, log out, and do not knock again.
  //   - his own accounts (guests) stay out until he presses Start, as before;
  //   - a party character comes back by itself after `standAsideMin` minutes (hub.json, default 120), and that wait
  //     DOUBLES up to 8 h each time he logs in again within 6 h, so the bot never fights him for the character.
  // goOnline() (Start / Log in) clears all of it at once.
  standAside(acc, client, bot, why = 'you logged in to this character') {
    if (!client || !bot) throw new Error(`no account ${acc && acc.id}`);
    const base = Math.max(5, Number(this.settings.standAsideMin) || 120);
    client._multiLoginAt = null;
    client._ownerDropAt = null;
    client._reconnecting = false;   // every step of tryOnce/waitForSeat now checks _holdOffline and gives up
    client._holdOffline = true;
    client._fullSince = null;
    const wasRunning = bot.running;
    try { bot.stop(true); } catch (e) { /* already stopped */ }
    if (this.raid) this.raidLeft(this.raid, acc.id, why);
    try { if (client.state && client.state.loaded) client.stop(); } catch (e) { /* already out */ }
    bot.journal(`${why} - logging out and staying out, so I don't kick you`);
    this.info(`${acc.id}: standing aside (${why})`);
    if (Hub.isGuest(acc)) {
      const on = Date.now();
      acc.ownerOn = on;
      if (bot.account) bot.account.ownerOn = on;
      try { accounts.update(acc.id, { online: false, ownerOn: on }); bot.account.online = false; } catch (e) { /* registry only */ }
      client._ownerWasRunning = wasRunning;
      const min = (Number(this.settings.ownerLogoutMin) > 0 ? Number(this.settings.ownerLogoutMin) : 10);
      this.notify(`${acc.label}: stepped aside`, `You logged in to the account, so the bot logged out. It comes back ${min} min after you log out (the bots see it on their friend lists) - or press Start in the dashboard.`, 'alert');
      this.emit('state', acc.id);
      return { ok: true, until: null, minutes: null };
    }
    const soon = Date.now() - (client._standAsideAt || 0) < 6 * 3600000;
    const minutes = soon ? Math.min(480, (Number(client._standAsideMin) || base) * 2) : base;
    client._standAsideAt = Date.now();
    client._standAsideMin = minutes;
    const until = Date.now() + minutes * 60000;
    client._standAsideUntil = until;
    // On disk as well: a restart (deploy, crash, reboot) used to log everyone back in, the owner's character included.
    try { accounts.update(acc.id, { standAsideUntil: until }); acc.standAsideUntil = until; } catch (e) { /* registry only */ }
    this.notify(`${acc.label}: stepped aside`, `You logged in to it, so the bot logged out. It comes back in ${minutes} min - or right away when you press Start.`, 'alert');
    clearTimeout(client._standAsideTimer);
    client._standAsideTimer = setTimeout(() => {
      if (this.disposed || !client._holdOffline || client._standAsideUntil !== until) return;
      client._standAsideUntil = null;
      client._holdOffline = false;
      this.goOnline(acc.id);
      if (wasRunning || acc.autostart) setTimeout(() => bot.start(), 20000);
    }, minutes * 60000);
    this.emit('state', acc.id);
    return { ok: true, until, minutes };
  }

  bot(id) { return this.bots.get(String(id).toLowerCase()) || null; }

  // ---------------- party ----------------
  // Accounts in the same party share a server and a private room number, so followers land next to their leader.
  partyOf(bot) { return Object.entries(this.settings.party || {}).find(([, p]) => p.members.includes(bot.id)); }
  partyRoom(bot) {
    const p = this.partyOf(bot);
    if (p) return p[1].room;
    return this.inLevelParty(bot) ? this.settings.levelParty.room : null;
  }
  // ---------------- ultra readiness (the owner's hard rule) ----------------
  // Refreshed every 30 minutes from what each character really owns: classes, unlocked enhancements, and the
  // best "all damage" weapon in backpack or bank. The brain reads the cached verdict; no ultra without it.
  ultraReady() { return this._ultra || { ready: false, missing: ['not checked yet'], seats: [] }; }

  async refreshUltraReady() {
    const members = [];
    for (const bot of this.bots.values()) {
      if (Hub.isGuest(bot)) continue;
      if (!bot.running || !(await bot.playing().catch(() => false))) continue;
      try {
        const items = [...await bot.items(), ...await bot.bankItems().catch(() => [])];
        members.push({
          id: bot.id,
          level: await this.levelOf(bot),
          // Backpack and bank: Farmer Joe banks every class it is not using (BankAllUnusedClasses), and a banked
          // King's Echo still fills its raid seat - v3 unbanks it (CheckInventory(toInv: true)).
          classes: [...new Set([...await bot.ownedClasses(), ...items.filter((i) => i.sType === 'Class').map((i) => i.sName)])],
          enhancements: [...await bot.unlockedEnhancements().catch(() => new Set())],
          weapon: ultraready.bestAllDamage(items),
        });
      } catch (e) { /* skip this one this round */ }
    }
    const before = this._ultra && this._ultra.ready;
    this._ultraMembers = members;   // raidWithMain seats the three who still need a turn-in from these
    this._ultra = { ...ultraready.check(members), checked: new Date().toISOString() };
    if (this._ultra.ready && !before) this.notify('Ultra party is ready', `${this._ultra.compName} - ultras are now on the schedule`, 'event');
    return this._ultra;
  }

  // ---------------- ultra raids (Skua Ultras-v3: all four characters, one boss at a time) ----------------
  // A v3 ultra script is an army script: all four clients run the same file at the same time, register in a shared
  // sync file (~/.config/Skua, one per machine, like the room it picks), split the classes and fight. It waits 5 min
  // for everyone to register, so the hub starts a boss for all four together: raidTask() hands the same script to
  // every member (the brain puts it above everything, and it pre-empts Farmer Joe), a member that finishes first
  // waits, and the boss is booked for its reset period once everyone is back. A boss whose quest was turned in is a
  // kill; one that failed twice in a period waits for the next period instead of feeding deaths.
  raidDue(now = Date.now()) {
    const ready = this.ultraReady();
    if (!ready.bosses) return [];
    const book = (this.settings.raids = this.settings.raids || { done: {}, tries: {} });
    const { periodKey } = require('./schedule');
    // settings.raidHold: bosses kept off the automatic raids (POST /raid/hold) - the Time Inn three until a test raid
    // with the stand-in classes kills one (2026-10-13: three tries wiped at 33-35%).
    const hold = this.raidHeld();
    return ultraready.BOSSES.filter((b) => {
      const st = ready.bosses[b.id];
      if (!st || !st.ready || hold.has(b.id) || this.raidGoldShort(b.id)) return false;
      if (this._provenHold && this._provenHold.has(b.id)) return false;   // its proven line-up runs it (raidProvenTick)
      const key = periodKey(b.every, new Date(now));
      if (book.done[b.id] === key) return false;
      const t = book.tries[b.id];
      return !(t && t.key === key && t.n >= 2);
    });
  }

  async raidTick(now = Date.now()) {
    const r = this.raid;
    if (r) {
      await this.raidWatch(r, now).catch((e) => this.info(`raid watch: ${e.message}`));
      if (this.raid !== r) return this.raid;
      const gone = this.raidMemberGone(r, now);
      if (gone) { this.raidLeft(r, gone, r.nudged && r.nudged[gone] ? `still on other work after ${Math.round(Hub.RAID_GONE_MS / 60000)} min` : `its loop has been stopped for ${Math.round(Hub.RAID_GONE_MS / 60000)} min`, now); return this.raid; }
      // A raid that never comes back (a hung script, a lost character) is closed after 3 h and counts as a try.
      if (now - r.started > 3 * 3600000) {
        this.info(`raid: ${r.name} timed out after 3 h`);
        this.raidClose(false, now);
        // Nothing else stops a raid script (the watchdog and pre-emption leave raids alone): end the stragglers.
        for (const id of r.members) { const b = this.bot && this.bot(id); if (b && b.current && b.current.raid === r.id) b.restart(); }
      }
      return this.raid;
    }
    if (this.settings.raidsOff || this._raidChecking || this._raidSwapping) return null;
    if (this._raidRelogUntil && now < this._raidRelogUntil) return null;   // a member relogs for its seat class
    this._raidChecking = true;
    let proven;
    try { proven = await this.raidProvenTick(now); } catch (e) { this.info(`raid: proven line-ups: ${e.message}`); } finally { this._raidChecking = false; }
    if (proven) return proven;
    const members = [...this.bots.values()].filter((b) => !Hub.isGuest(b) && b.running && !b.paused && b.serverName);
    if (members.length < 3) return null;
    // The period keys are UTC; the game resets on its own clock. Ask the game whether the boss quest is open to the
    // first member before sending anyone: a locked quest waits an hour and is not a failed try.
    const book = (this.settings.raids = this.settings.raids || { done: {}, tries: {} });
    const locked = (book.locked = book.locked || {});
    // The bosses the bots can't do on their own get the main in one seat first (raidWithMain).
    this._raidChecking = true;
    let viaMain;
    try { viaMain = await this.raidWithMain(members, now); } finally { this._raidChecking = false; }
    if (viaMain) return viaMain;
    if (members.length < 4) return null;
    let boss = null;
    let crew = null;
    this._raidChecking = true;
    try {
      for (const b of this.raidDue(now)) {
        if (locked[b.id] && now - locked[b.id] < 3600000) continue;
        const four = this.raidCrew(b, members);
        if (!four) continue;
        // Every member, not just the first: the boss quest stays unavailable until that character has done the story
        // that opens its map (Champion Drakath = 13 Lords of Chaos), and one locked member stalls the raid for 3 h
        // (check-up 2026-10-05: Nova had not finished 13 LoC while the other three had).
        // SeraphUltras (2026-10-18): members who can't gain this period (turned in already, or the Time Inn order -
        // Ezrajal > Warden > Engineer - not reached) still fight; the scripts skip their turn-in. The boss starts
        // while at least one member can gain from the kill.
        // Who can't gain may still come only when it isn't locked out of the map: it turned the boss in this period
        // already, or the boss is one of the Time Inn three (ultraready `chain`: the quest order, not the story, holds
        // the turn-in back). A member missing the story that opens the map still stops the raid (check-up 2026-10-05).
        const gain = [];
        const cannot = [];
        const chainWait = [];
        let storyLocked = null;
        const period = require('./schedule').periodKey(b.every, new Date(now));
        for (const m of four) {
          // Turned in this period (raidHad) beats the game's "quest open" answer, which lags a turn-in (2026-10-22 14:14:
          // Engineer restarted for Nova 30 s after her turn-in, and the empty fight was booked as a loss).
          const had = await this.raidHad(m, b, period);
          if (!had && (!m.questAvailable || (await m.questAvailable(b.quest).catch(() => true)))) { gain.push(m.id); continue; }
          const doneNow = had;
          if (b.chain || doneNow) cannot.push(m.account.label);
          else { storyLocked = m.account.label; break; }
          // Held back only by the Time Inn order (2026-10-19: Oren missed Warden, so Engineer was booked done for
          // the other three and he could never get it): the boss stays open for this member (raidDone).
          if (b.chain && !doneNow) chainWait.push(m.id);
        }
        if (storyLocked) { this.info(`raid: ${b.name} is not open for ${storyLocked} yet (story or reset) - not starting it`); locked[b.id] = now; continue; }
        if (gain.length) {
          boss = b;
          crew = four;
          this._raidGain = gain;
          this._raidChainWait = chainWait;
          this._raidHad = [];
          for (const m of four) if (!gain.includes(m.id) && await this.raidHad(m, b, period)) this._raidHad.push(m.id);
          if (cannot.length) this.info(`raid: ${b.name} - ${cannot.join(', ')} can't turn it in this period (done or story) and fight for the others`);
          break;
        }
        this.info(`raid: ${b.name} is not open for anyone in the party (story or reset) - not starting it`);
        locked[b.id] = now;
      }
    } finally { this._raidChecking = false; }
    if (!boss || this.raid) return this.raid || null;
    if (await this.raidPrep(crew, boss, now)) return null;
    const swapped = await this.raidSwapSeats(boss, crew, now).catch((e) => { this.info(`raid: seat swap failed: ${e.message}`); return null; });
    return this.beginRaid(boss, crew, now, swapped);
  }

  // ---------------- the main in a seat (the owner 2026-10-22) ----------------
  // "if the bots cant do it without LR then make my main help them and make sure that everyone gets the quest done."
  // A boss the bots have no line-up for (no VDK / King's Echo yet), or one they already lost this period (a failed try:
  // 2026-10-22 Ultra Ezrajal "heals back" twice), runs with the owner's main in the seat ultraready.WITH_MAIN gives him
  // (mostly Legion Revenant) and the three bots who still need this period's turn-in. After every kill the next
  // raidTick asks the game again who still needs it, so the bot left out comes in next - until every level-100 bot
  // with a 30% weapon has turned it in; then the boss is booked for the period. He fights in his own outfit for the
  // class (bot.raidSeatOutfit), never enhanced (CBO SeraphNeverEnhance), never with potions, in the party's room.
  // Two lost fights a period with him (mainTries), like the bots' own two. settings.mainSeat false turns it off;
  // settings.mainSeatAlways [boss ids] sends him even while the bots have a line-up and no lost try.
  async raidWithMain(members, now = Date.now()) {
    if (this.settings.mainSeat === false) return null;
    const ready = this.ultraReady();
    if (!ready.bosses) return null;
    const { periodKey } = require('./schedule');
    const book = (this.settings.raids = this.settings.raids || { done: {}, tries: {} });
    const locked = (book.locked = book.locked || {});
    const mainTries = (book.mainTries = book.mainTries || {});
    const hold = this.raidHeld();
    const always = new Set(this.settings.mainSeatAlways || []);
    const fitIds = new Set((this._ultraMembers || []).filter((m) => Number(m.level || 0) >= ultraready.LEVEL && (m.weapon ? m.weapon.value : 0) >= ultraready.WEAPON_MIN).map((m) => m.id));
    const pool = (this._ultraMembers || []).filter((m) => fitIds.has(m.id) && members.some((b) => b.id === m.id));
    if (pool.length < 3) return null;
    let main = null;
    for (const b of ultraready.BOSSES) {
      const st = ready.bosses[b.id];
      if (!st || !st.withMain || !st.withMain.ready || hold.has(b.id) || this.raidGoldShort(b.id)) continue;
      if (this._provenHold && this._provenHold.has(b.id)) continue;   // its proven line-up runs it (raidProvenTick)
      const key = periodKey(b.every, new Date(now));
      // Booked for the bots: the boss still runs once more if the main hasn't turned it in (the owner 2026-10-22: "make
      // sure he also grabs the quests").
      const botsDone = book.done[b.id] === key;
      if (locked[b.id] && now - locked[b.id] < 3600000) continue;
      const t = book.tries[b.id];
      const lost = !!(t && t.key === key && t.n >= 1);
      if (st.ready && !lost && !always.has(b.id) && !botsDone) continue;   // the bots try it on their own first
      const mt = mainTries[b.id];
      if (mt && mt.key === key && mt.n >= Hub.tryCap(b)) continue;
      main = main || this.raidMain({ orders: true });
      if (!main) {
        if (!this._mainBusyNote || now - this._mainBusyNote > 3600000) { this._mainBusyNote = now; this.info(`raid: ${b.name} needs the main in a seat - he is not free (offline, being played, paused or in another fight)`); }
        return null;
      }
      const cls = await this.raidMainClass(main, st.withMain.main);
      if (!cls) { this.info(`raid: ${b.name} - the main has no rank-10 ${st.withMain.main.join(' or ')} for his seat`); locked[b.id] = now; continue; }
      const mainNeed = !(await this.raidHad(main, b, key)) && (!main.questAvailable || (await main.questAvailable(b.quest).catch(() => false)));
      if (botsDone && !mainNeed) continue;
      // Who still needs this period's turn-in: the game's own answer (the quest is open to take), per fit bot online.
      const need = [];
      if (!botsDone) for (const m of pool) {
        const bot = this.bot(m.id);
        if (!bot || (await this.raidHad(bot, b, key))) continue;   // turned in: the game's "open" answer lags (raidTick)
        if (!bot.questAvailable || (await bot.questAvailable(b.quest).catch(() => true))) need.push(m.id);
      }
      if (!need.length && !botsDone) {
        this.info(`raid: ${b.name} - every level-100 bot has turned it in this period (or can't take it yet) - booked`);
        book.done[b.id] = key;
        this.saveSettings();
        if (!mainNeed) continue;
      }
      const rs = this.recipeSeats(b, pool, need, main.id);
      if (rs) this.info(`raid: ${b.name} - the proven line-up${rs.swaps.length ? `, with ${rs.swaps.join(', ')} for the turn-in` : ''}`);
      const wm = rs ? { ready: true, seats: rs.seats } : ultraready.withMain(b, pool, {}, need);
      if (!wm || !wm.ready) continue;
      const crew = wm.seats.map((s) => this.bot(s.id)).filter(Boolean);
      if (crew.length < 3) continue;
      // The main's own turn-in counts too: a raid he leaves without it is a partial kill and runs again.
      const gain = [...crew.map((x) => x.id).filter((id) => need.includes(id)), ...(mainNeed ? [main.id] : [])];
      if (!gain.length) continue;
      const why = !need.length ? "for the main's own turn-in (the bots have it)" : !st.ready ? `the bots have no line-up of their own (${st.missing.slice(0, 2).join('; ')})` : lost ? 'the bots lost it on their own this period' : 'mainSeatAlways';
      this.info(`raid: ${b.name} with the main as ${cls} - ${why}; still need it: ${gain.join(', ')}`);
      this._raidGain = gain;
      this._raidChainWait = [];
      return this.beginRaid(b, [...crew, main], now, [...wm.seats, { id: main.id, cls }], null, { withMain: main.id });
    }
    return null;
  }

  // Turned this boss in this period already: the hub's own record (bot.turnedIn, from the turn-in packets - kept in
  // memory only, so a restart loses it) or the game's daily / weekly flag (bot.dailyDone). 2026-10-22: after restarts
  // the hub took Sable and Oren for "still needing" Ultra Ezrajal they had turned in that morning.
  async raidHad(m, b, period = require('./schedule').periodKey(b.every, new Date())) {
    const t = m.turnedIn && m.turnedIn.get(Number(b.quest));
    if (t && require('./schedule').periodKey(b.every, new Date(t)) === period) return true;
    return !!(m.dailyDone && (await m.dailyDone(b.quest).catch(() => false)));
  }

  // The owner 2026-10-24: "i need consistency not everytime we kill an ultra the next day you fail to kill him". With the
  // main in a seat, the three bot seats start from the boss's proven recipe (the line-up that won): same characters,
  // same classes. A bot that still needs the turn-in takes the seat of a recipe member who already has it, in that
  // seat's class (one it owns) - never the boss's critical seat or the healer (Lord of Order) while another fits.
  // The 11:04 Speaker win (LoO Sable / SC Valen / AP Oren / VDK main) was followed by four losses with
  // Valen moved to AP and Nova on SC. Null: no recipe with the main in it, or nobody who needs it fits.
  recipeSeats(b, pool, need, mainId) {
    let rec = null;
    try { rec = require('./recipes').active(b.id); } catch (e) { return null; }
    if (!rec || !Array.isArray(rec.seats) || rec.seats.length !== 4 || !rec.seats.some((s) => s.id === mainId)) return null;
    const seats = rec.seats.filter((s) => s.id !== mainId).map((s) => ({ id: s.id, cls: s.cls }));
    const norm = (c) => String(c || '').toLowerCase().replace(/[^a-z]/g, '');
    const wmb = ultraready.WITH_MAIN[b.id] || {};
    const critCls = new Set((wmb.critical || []).flatMap((i) => (wmb.slots && wmb.slots[i]) || []).map(norm));
    const owns = (m, cls) => (m.classes || []).some((c) => norm(c) === norm(cls));
    const member = (id) => pool.find((m) => m.id === id);
    const swaps = [];
    for (const id of need) {
      if (seats.some((s) => s.id === id)) continue;
      const m = member(id);
      if (!m) continue;
      const order = seats.map((s, i) => i).filter((i) => !need.includes(seats[i].id) && owns(m, seats[i].cls))
        .sort((x, y) => (critCls.has(norm(seats[x].cls)) - critCls.has(norm(seats[y].cls))) || ((norm(seats[x].cls) === 'lordoforder') - (norm(seats[y].cls) === 'lordoforder')));
      if (!order.length) continue;
      const i = order[0];
      swaps.push(`${id} as ${seats[i].cls} (for ${seats[i].id})`);
      seats[i] = { id, cls: seats[i].cls };
    }
    if (seats.some((s) => !member(s.id)) || !seats.some((s) => need.includes(s.id))) return null;
    return { seats, swaps };
  }

  // The first of these classes the main owns at rank 10.
  async raidMainClass(main, classes) {
    const owned = fightplan.rank10(await main.classPoints().catch(() => [])).map((c) => c.toLowerCase());
    return (classes || []).find((c) => owned.includes(String(c).toLowerCase())) || null;
  }

  // The four characters ultraready seated for this boss. With seven characters the first four online are not the
  // raid: a level-2 newcomer would take a seat whenever a veteran was offline (2026-10-21). A seated character who
  // went offline since the last readiness check skips the boss for now (not a try, not a lock). No seats known (an
  // old readiness verdict): the first four, as before.
  raidCrew(boss, members) {
    const seats = ((this.ultraReady().bosses || {})[boss.id] || {}).seats;
    if (!seats || !seats.length) return members.slice(0, 4);
    const four = seats.map((s) => members.find((m) => m.id === s.id)).filter(Boolean);
    return four.length === 4 ? four : null;
  }

  // The owner 2026-10-19: "if a bot dies and the others get the turn in swap their classes so the bot that dies doesnt die
  // and gets the quest keep repeating until all of them turn in the quest". A rerun after a partial kill (raidBook
  // `swap`) trades each member who missed the turn-in into the class of a member who already has it - one that owns
  // the other's class at rank 10 both ways - so the seat that died (Oren's ArchPaladin BerserkTaunter at Ultra Warden,
  // 2026-10-18 and -19) goes to someone whose kill is already safe. Returns the seats, or null for the usual ones.
  async raidSwapSeats(boss, members, now = Date.now()) {
    const book = this.settings.raids || {};
    const sw = book.swap && book.swap[boss.id];
    if (!sw || sw.key !== require('./schedule').periodKey(boss.every, new Date(now)) || !(sw.ids || []).length) return null;
    const base = (((this.ultraReady().bosses || {})[boss.id] || {}).seats || []).map((s) => ({ ...s }));
    if (base.length < 4) return null;
    const owned = {};
    for (const m of members) owned[m.id] = new Set(fightplan.rank10(await m.classPoints().catch(() => [])).map((c) => c.toLowerCase()));
    const has = (id, cls) => !!(owned[id] && owned[id].has(String(cls).toLowerCase()));
    const done = new Set(sw.done || []);
    const moved = [];
    for (const id of sw.ids) {
      const me = base.find((s) => s.id === id);
      if (!me) continue;
      // The partner: already has the kill, not itself moved, owns my class and I own its class. The death seat is the
      // one the member died in, so any other class is safer for it.
      const k = base.find((s) => s.id !== id && done.has(s.id) && !moved.includes(s.id) && s.cls !== me.cls && has(s.id, me.cls) && has(id, s.cls));
      if (!k) { this.info(`raid: ${boss.name} - no seat to swap ${id} into (nobody with the kill shares classes both ways)`); continue; }
      [me.cls, k.cls] = [k.cls, me.cls];
      moved.push(id, k.id);
      this.info(`raid: ${boss.name} rerun - ${id} died without the turn-in, so ${id} plays ${me.cls} and ${k.id} takes ${k.cls}`);
      const b = this.bot(id);
      if (b && b.journal) b.journal(`${boss.name} again: I missed the turn-in, so I swap to ${me.cls} and ${k.id} takes my ${k.cls} seat`);
    }
    return moved.length ? base : null;
  }

  // Potions first (ultraready.RAID_POTIONS): a member short of any brews them now (UltraPotions PreparePotions, 20
  // each) and the raid waits for the next tick. One brew per character per 6 h, so a failing brew never loops.
  // Returns true while someone is still short.
  // Off unless hub settings raidPotions is true: the owner 2026-10-13, "there is 0 need of potions to kill the bosses" -
  // the Time Inn fix skips v3's potions altogether.
  async raidPrep(members, boss, now = Date.now()) {
    if (!this.brain || !this.brain.held || !(this.settings && this.settings.raidPotions)) return false;
    let short = false;
    this._raidPrepAt = this._raidPrepAt || {};
    for (const b of members) {
      const low = [];
      for (const name of ultraready.RAID_POTIONS) {
        const n = await this.brain.held(b, name).catch(() => 99);
        if (n >= ultraready.RAID_POTION_MIN) continue;
        if (name === 'Potent Honor Potion' && (await this.brain.held(b, 'Potent Malice Potion').catch(() => 0)) > 30) continue;
        low.push(`${name} ${n}`);
      }
      if (!low.length) continue;
      short = true;
      if (now - (this._raidPrepAt[b.id] || 0) < 6 * 3600000) continue;
      this._raidPrepAt[b.id] = now;
      this.info(`raid: ${boss.name} waits - ${b.account.label} brews raid potions first (${low.join(', ')})`);
      b.runNow({ type: 'script', path: 'SeraphUltras/DependenciesUltras/UltraPotions.cs', entry: 'PreparePotions', args: '20', brain: true, why: `raid prep: potions for ${boss.name} (${low.join(', ')})` });
    }
    return short;
  }

  // ---------------- the main as the raid's DPS (the owner 2026-10-16) ----------------
  // "if the party lacks dps for killing ultra drakath you can send in my main as a dps and swap with one bot and if
  // they manage to kill him make one bot go continue whatever he was doing and make the bot we swapped rejoin and kill
  // it again and then everyone returns to what they are doing."
  // Every boss has its own mechanic, so only bosses whose script's DPS role is known (ultraready dpsSeat: Drakath's
  // three taunters pulse-taunt in turn, the fourth just hits) get the swap, and the main takes exactly that seat.
  // Round 1: the main in the DPS seat, that seat's bot back to its own work, the other three restart with him.
  // Round 2 after that kill: one bot that has its kill goes back to its work, the swapped bot takes its seat, the main
  // stays as DPS. Then everyone goes back to what they were doing.
  // A fight that can't be won before the 3 h limit (the boss heals back, or the pace runs past the limit) is called off
  // after three such checks in a row, when no swap can help: on 2026-10-16 the four wiped at Drakath for 2 h, ~20
  // deaths each, and only the 3 h limit would have ended it.
  async raidWatch(r, now = Date.now()) {
    const boss = ultraready.BOSSES.find((b) => b.id === r.boss);
    if (!boss) return null;
    const hp = await this.raidBossHp(r, boss.monster || boss.name);
    const f = (r.fight = r.fight || { samples: [] });
    if (hp && !f.startAt && hp.hp < hp.max * 0.995) f.startAt = now;
    // A raid that never even scratches the boss has nothing for the pace and wipe checks to read, so it used to run to
    // the 3 h cap: Gramiel with the main as LR sat 65+ min in the crystal phase on 2026-10-23 (19-30 deaths an hour
    // each) with Gramiel at full HP. Kills take 2-10 min; raidNoProgressMin (40) after the start is plenty.
    const noProgressMs = (Number(this.settings.raidNoProgressMin) || 40) * 60000;
    if (!f.startAt && r.started && now - r.started > noProgressMs) {
      this.raidCallOff(`${boss.name} was never damaged in ${Math.round((now - r.started) / 60000)} min${hp ? ' (still at full HP - the party never got past the first phase)' : ' (nobody could see it)'}`, now);
      return null;
    }
    if (!hp || !f.startAt) return null;
    f.samples = f.samples.filter((s) => now - s.at < 30 * 60000).concat({ at: now, hp: hp.hp });
    // Wipes: the boss back near full after it was well down = the party died and it reset. The pace test never sees
    // this - each try drops fast - so count them: 2026-10-16 Drakath went 20 -> 14 M and reset five times in 20 min.
    const lows = [];
    let low = f.samples[0].hp;
    for (let i = 1; i < f.samples.length; i++) {
      if (f.samples[i].hp - f.samples[i - 1].hp > hp.max * 0.15) { lows.push(low); low = f.samples[i].hp; } else low = Math.min(low, f.samples[i].hp);
    }
    if (lows.length >= 3) {
      const at = Math.round(lows.reduce((a, b) => a + b, 0) / lows.length / 1e5) / 10;
      const why = `the party wiped ${lows.length}x in 30 min, each time at ~${at} M of ${Math.round(hp.max / 1e5) / 10} M HP`;
      if (boss.dpsSeat && !r.swap && !r.withMain && !r.plan && !r.recipe && this.settings.mainRaidDps !== false) {
        const swapped = await this.raidSwapIn(r, boss, why, now);
        if (swapped) return swapped;
      }
      this.raidCallOff(why, now);
      return null;
    }
    const cfg = { afterMin: 15, maxFightMin: 60, ...(this.settings.raidDpsSwap || {}) };
    if (now - f.startAt < cfg.afterMin * 60000) return null;
    const old = f.samples.find((s) => now - s.at <= cfg.afterMin * 60000) || f.samples[0];
    if (now - old.at < 5 * 60000) return null;   // too few readings (nobody saw the boss for a while) to judge the pace
    const perMin = (old.hp - hp.hp) / Math.max(1, (now - old.at) / 60000);
    const left = perMin > 0 ? hp.hp / perMin : Infinity;
    const total = (now - f.startAt) / 60000 + left;
    const capLeft = (r.started + 3 * 3600000 - now) / 60000 - 10;
    const hopeless = perMin <= 0 || left > capLeft;
    f.hopeless = hopeless ? (f.hopeless || 0) + 1 : 0;
    if (perMin > 0 && total <= cfg.maxFightMin && left <= capLeft) return null;
    const why = perMin <= 0 ? `${boss.name} is not going down (${Math.round(hp.hp / 1e5) / 10} M HP, it heals back)`
      : `${boss.name} would take ~${Math.round(total)} min (${Math.round(perMin / 1e3)}k HP/min, ${Math.round(hp.hp / 1e5) / 10} M left)`;
    if (boss.dpsSeat && !r.swap && !r.withMain && !r.plan && !r.recipe && this.settings.mainRaidDps !== false) {
      const swapped = await this.raidSwapIn(r, boss, why, now);
      if (swapped) return swapped;
    }
    if (f.hopeless >= 3) { this.raidCallOff(`${why} - it can't be won before the 3 h limit`, now); return null; }
    return null;
  }

  // The boss's HP as a member in its map sees it.
  async raidBossHp(r, name) {
    for (const id of r.members) {
      const b = this.bot(id);
      if (!b || !b.client || typeof b.client.call !== 'function') continue;
      const list = (await b.client.call('getMonsters').catch(() => null)) || [];
      const m = list.find((x) => x && String(x.strMonName || '').toLowerCase() === String(name).toLowerCase() && Number(x.intHPMax) > 0);
      if (m) return { hp: Number(m.intHP), max: Number(m.intHPMax) };
    }
    return null;
  }

  // The owner's main, free to join a raid: autopilot running and logged in (not his own session), not in another raid.
  // orders: also while he runs one of the owner's orders (raidWithMain). The owner 2026-10-22 asked for the seat with Elysium,
  // Legion tokens, ArchMage and NSoD queued - days of orders. A raid is 10-20 min: the order is paused, put back in
  // front of the queue by the restart (bot.loop), and goes on after the raid (bot.loop asks raidTask before orders).
  raidMain({ orders = false } = {}) {
    for (const b of this.bots.values()) {
      if (!Hub.helper(b) || (b.settings && b.settings.raidDps === false) || !b.running || b.paused) continue;
      if (b.client && (b.client._holdOffline || !(b.client.state && b.client.state.loaded))) continue;
      if (!b.serverName || (b.current && (b.current.raid || b.current.type === 'assist'))) continue;
      // Only on autopilot work: the owner's own orders come first in the loop (and are his), so a queued one keeps it out.
      if (!orders && (!b.current || !b.current.brain || (b.queue || []).length)) continue;
      if (orders && (!b.current || b.current.type === 'idle')) continue;
      return b;
    }
    return null;
  }

  async raidSwapIn(r, boss, why, now = Date.now()) {
    const seat = (r.seats || []).find((s) => String(s.cls).toLowerCase() === String(boss.dpsSeat).toLowerCase());
    r.swap = { tried: now };
    if (!seat) return null;
    const main = this.raidMain();
    if (!main) { this.info(`raid: ${why} - the main is not free to help (offline, being played or busy)`); return null; }
    const owned = fightplan.rank10(await main.classPoints().catch(() => []));
    if (!owned.some((c) => c.toLowerCase() === String(seat.cls).toLowerCase())) { this.info(`raid: ${why} - the main has no rank-10 ${seat.cls} for the DPS seat`); return null; }
    const out = this.bot(seat.id);
    const members = [main, ...r.members.filter((id) => id !== seat.id).map((id) => this.bot(id))].filter(Boolean);
    if (!out || members.length < 4) return null;
    const seats = [{ id: main.id, cls: seat.cls }, ...r.seats.filter((s) => s.id !== seat.id)];
    this.info(`raid: ${why} - lacks DPS: ${main.account.label} takes ${out.account.label}'s ${seat.cls} seat`);
    this.notify(`${boss.name}: the main joins as DPS`, `${why}. ${main.account.label} takes ${out.account.label}'s seat; ${out.account.label} gets its own kill right after.`, 'event');
    this.raidEnd(r, null, now);
    for (const id of r.members) { const b = this.bot(id); if (b && b.current && b.current.raid === r.id) b.restart(); }
    return this.beginRaid(boss, members, now, seats, { phase: 1, out: out.id, main: main.id, original: r.members.slice() });
  }

  // After the round-1 kill: the swapped bot comes back for its own kill, in the seat of a bot that has its kill and
  // whose class the swapped bot owns; that bot goes back to its work. The main keeps the DPS seat.
  async raidSwapBack(r, boss, now = Date.now()) {
    const sw = r.swap;
    const out = this.bot(sw.out);
    const main = this.bot(sw.main);
    if (!out || !out.running || !main) { this.info(`raid: ${boss.name} - ${sw.out} is not around for its own kill`); return null; }
    const owned = fightplan.rank10(await out.classPoints().catch(() => [])).map((c) => c.toLowerCase());
    const killed = r.members.filter((id) => id !== sw.main && r.back[id] === 'kill');
    const give = (r.seats || []).find((s) => killed.includes(s.id) && owned.includes(String(s.cls).toLowerCase()));
    if (!give) { this.info(`raid: ${boss.name} - ${out.account.label} owns none of the free seats' classes, no second kill`); return null; }
    const members = [main, out, ...r.members.filter((id) => id !== sw.main && id !== give.id).map((id) => this.bot(id))].filter(Boolean);
    if (members.length < 4) return null;
    const seats = r.seats.map((s) => (s.id === give.id ? { id: out.id, cls: give.cls } : s));
    this.info(`raid: ${boss.name} round 2 - ${this.bot(give.id).account.label} goes back to its work, ${out.account.label} takes its ${give.cls} seat for its own kill`);
    return this.beginRaid(boss, members, now, seats, { phase: 2, out: out.id, main: sw.main, original: sw.original, credited: killed });
  }

  // Start `boss` for these four: the seats file first (lib/skua/engine.js SERAPH_SEATS_FILE, read by Seraph's v3
  // script fix as the class sync's preferred assignments), then everyone switches to the raid script.
  // opts.withMain: the main's id when raidWithMain seated him (raidBook books it his way).
  // opts.plan: the owner's own line-up from the Raid Planner (raidPlanStart) - seats with role, potions and scroll each.
  // opts.recipe: the proven recipe being replayed (raidProvenTick) - its comp, its potions per seat, and opts.script =
  // its frozen copy of the boss script (lib/recipes.js).
  beginRaid(boss, members, now = Date.now(), seats = null, swap = null, opts = {}) {
    seats = seats || ((this.ultraReady().bosses || {})[boss.id] || {}).seats || [];
    this.raidSeats(seats, boss);
    if (opts.plan) this.raidPlanWrite(boss, opts.plan);
    else if (opts.recipe && opts.recipe.comp) {
      // The Comp that won, by name, not re-picked from the classes.
      try {
        const users = seats.map((s) => { const b = this.bot(s.id); return { user: (b && b.account && (b.account.username || b.account.label)) || s.id, cls: s.cls }; });
        require('./ultras').setRaidOptions(path.join(P.ROOT, 'skua-options'), boss, users, opts.recipe.comp === 'default' ? '' : opts.recipe.comp);
      } catch (e) { this.info(`raid: could not write the proven comp: ${e.message}`); }
    }
    const gain = this._raidGain && this._raidGain.length ? this._raidGain.filter((id) => members.some((b) => b.id === id)) : members.map((b) => b.id);
    this._raidGain = null;
    const chainWait = (this._raidChainWait || []).filter((id) => members.some((b) => b.id === id));
    this._raidChainWait = null;
    const had = (this._raidHad || []).filter((id) => members.some((b) => b.id === id));
    this._raidHad = null;
    this.raid = { id: `raid-${now}`, boss: boss.id, name: boss.name, script: opts.script || boss.script, quest: boss.quest, every: boss.every, started: now, members: members.map((b) => b.id), gain, chainWait, had, seats, back: {}, ...(swap ? { swap } : {}), ...(opts.withMain ? { withMain: opts.withMain } : {}), ...(opts.plan ? { plan: opts.plan } : {}), ...(opts.recipe ? { recipe: opts.recipe.id } : {}) };
    // What runs, frozen in memory: a win saves exactly this script as the boss's proven recipe (raidEnd, lib/recipes.js).
    (this._raidSnaps = this._raidSnaps || {})[this.raid.id] = require('./recipes').capture(this.raid.script);
    // One room for all four (lib/skua/cbo.js): the party's, never the main's own private room (his CBO has 24680, the
    // party fights in levelParty.room) - v3 waits for the whole party in the same room.
    const host = members.find((b) => !Hub.isGuest(b));
    this.raid.room = (host && this.partyRoom && this.partyRoom(host)) || (this.settings.levelParty && this.settings.levelParty.room) || 100000;
    this.raid.potions = opts.plan ? this.raidPlanPotions(opts.plan) : opts.recipe ? this.raidPlanPotions(opts.recipe) : this.raidPotionsWrite(boss, members);
    this.raid.potionsBy = this.raidPotionsRead();
    this.info(`raid: ${opts.recipe ? '(proven line-up) ' : opts.plan ? '(Raid Planner) ' : ''}${boss.name} with ${this.raid.members.join(', ')}${seats.length ? ` (${seats.map((s) => `${s.id} ${s.cls}`).join(', ')})` : ''}, potions ${this.raid.potions ? 'ON' : 'off'}`);
    this.notify(`Ultra raid: ${boss.name}`, `All four are heading in (${boss.script.split('/').pop()})`, 'event');
    // Everyone switches now, not at the next 10-min pre-empt check: v3 gives up on a member after 5 min.
    for (const id of this.raid.members) { const b = this.bot(id); if (b && b.current && !b.current.raid) { b.journal(`pausing "${b.current.why || b.current.type}" for the ${boss.name} raid`); b.restart(); } }
    return this.raid;
  }

  // "Username=Class" per seat, for the v3 class sync (an empty file = v3 assigns by itself).
  raidSeats(seats, boss = null) {
    const users = (seats || []).map((s) => { const b = this.bot(s.id); return b && s.cls ? { user: (b.account && (b.account.username || b.account.label)) || s.id, cls: s.cls } : null; }).filter(Boolean);
    const lines = users.map((u) => `${u.user}=${u.cls}`);
    try { fs.writeFileSync(path.join(P.ROOT, 'raid-seats.txt'), lines.join('\n') + (lines.length ? '\n' : '')); } catch (e) { this.info(`raid: could not write the seats file: ${e.message}`); }
    // SeraphUltras (lib/ultras.js) reads the party layout and the Comp from DoAllUltras.cfg: the Comp whose four
    // classes are these seats' classes, else the boss's default.
    if (boss && /^SeraphUltras\//.test(boss.script || '')) {
      try {
        const ultras = require('./ultras');
        ultras.install();
        require('./recipes').installProven();
        const comp = ultras.compFor(boss, users.map((u) => u.cls));
        const o = ultras.setRaidOptions(path.join(P.ROOT, 'skua-options'), boss, users, comp);
        this.info(`raid: ${boss.name} layout ${lines.join('; ')}, comp ${o.comp}`);
      } catch (e) { this.info(`raid: could not write the ${boss.name} layout: ${e.message}`); }
    }
    return lines;
  }

  // A raid on request (POST /raid, the owner 2026-10-13: "test the bots right now on these ultras"): past the level and
  // weapon rules, never past a class nobody owns - v3 stops the whole raid when a member fits no seat.
  async startRaid(bossId, { force = false, swap = null } = {}) {
    if (this.raid) return { ok: false, error: `a raid is running: ${this.raid.name}` };
    const boss = ultraready.BOSSES.find((b) => b.id === bossId);
    if (!boss) return { ok: false, error: `no boss ${bossId} (${ultraready.BOSSES.map((b) => b.id).join(', ')})` };
    const members = [...this.bots.values()].filter((b) => !Hub.isGuest(b) && b.running && !b.paused && b.serverName);
    if (members.length < 4) return { ok: false, error: `four characters must be online (have ${members.length})` };
    const ready = await this.refreshUltraReady();
    const st = (ready.bosses || {})[boss.id];
    if (!st) return { ok: false, error: 'readiness not known' };
    const gaps = st.missing.filter((m) => m.endsWith(` for ${boss.name}`));
    if (gaps.length) return { ok: false, error: `nobody can take a seat: ${gaps.join('; ')}` };
    if (!st.ready && !force) return { ok: false, error: `not ready: ${st.missing.join('; ')}` };
    const ids = st.seats.map((s) => s.id);
    const four = ids.map((id) => members.find((b) => b.id === id)).filter(Boolean);
    if (four.length < 4) return { ok: false, error: 'a seated character went offline' };
    if (await this.raidPrep(four, boss)) return { ok: false, error: 'waiting for raid potions - the short ones are brewing them now (see the journal); ask again when they are done' };
    if (!st.ready) this.info(`raid: ${boss.name} started by request past the rules (${st.missing.join('; ')})`);
    // { swap: [ids] }: these members died out of the turn-in earlier this period - swap them like a partial-kill rerun.
    if (Array.isArray(swap) && swap.length) {
      const book = (this.settings.raids = this.settings.raids || { done: {}, tries: {} });
      (book.swap = book.swap || {})[boss.id] = { key: require('./schedule').periodKey(boss.every, new Date()), ids: swap, done: ids.filter((id) => !swap.includes(id)) };
    }
    const seats = (await this.raidSwapSeats(boss, four).catch(() => null)) || st.seats;
    const raid = this.beginRaid(boss, four, Date.now(), seats);
    return { ok: true, raid, waived: st.ready ? [] : st.missing };
  }

  // ---- Raid Planner (dashboard; the owner 2026-10-24: "decide which characters take which role and how they act and what
  // potions do they use ... take control over the bots", like VibeSkua's army + Ultras v3 options) ----
  // Every boss with what its script lets a plan choose (lib/ultras.js planInfo), every character with its rank-10
  // classes (read from backpack + HTTP bank, cached 10 min), and the raid now.
  async raidPlanner(now = Date.now()) {
    const ultras = require('./ultras');
    const bosses = ultraready.BOSSES.map((b) => ({ id: b.id, name: b.name, every: b.every, quest: b.quest, plan: ultras.planInfo(b) }));
    const cache = (this._planClasses = this._planClasses || {});
    const members = [];
    for (const b of this.bots.values()) {
      const loaded = !!(b.client && b.client.state && b.client.state.loaded);
      let c = cache[b.id];
      if (loaded && (!c || now - c.at > 600000)) {
        const cp = await b.classPoints().catch(() => null);
        if (cp) c = cache[b.id] = { at: now, classes: fightplan.rank10(cp).sort() };
      }
      const aside = !!(b.client && b.client._standAsideUntil && b.client._standAsideUntil > now);
      members.push({ id: b.id, label: (b.account && b.account.label) || b.id, guest: Hub.isGuest(b), color: b.account && b.account.color,
        online: loaded && !!b.serverName, running: !!b.running, paused: !!b.paused, standAside: aside,
        doing: b.current ? (b.current.why || b.current.type) : null, classes: c ? c.classes : null });
    }
    const book = this.settings.raids || {};
    // The last line-up that killed each boss (its Attempt reports: who, which class, which role) - the page's starting
    // point when the owner hasn't planned that boss himself yet.
    const wins = {};
    for (const l of book.log || []) {
      const seats = [...new Map((l.attempts || []).filter((a) => a.outcome === 'kill' && a.cls).map((a) => [a.id, { id: a.id, cls: a.cls, role: a.role || '' }])).values()];
      if (l.killed && seats.length === 4) wins[l.boss] = { at: l.at, seats };
    }
    return { bosses, members, raid: this.raid || null, hold: this.settings.raidHold || [], done: book.done || {}, plans: this.settings.raidPlans || {}, wins, recipes: require('./recipes').load(), log: (book.log || []).slice(-15).reverse() };
  }

  // Start the owner's line-up: { boss, seats: [{ id, cls, role, potions (bool), potionList, scroll }] }. It checks only what
  // would make v3 stop at once (who is online and running, one class per seat, a class the character owns at rank 10,
  // a role the boss has); everything else is his call - no ultraready rules, no potion policy.
  async raidPlanStart(plan, now = Date.now()) {
    if (this.raid) return { ok: false, error: `a raid is running: ${this.raid.name} - stop it first` };
    const boss = ultraready.BOSSES.find((b) => b.id === (plan && plan.boss));
    if (!boss) return { ok: false, error: 'pick a boss' };
    const info = require('./ultras').planInfo(boss);
    if (!info) return { ok: false, error: `${boss.name}: its script could not be read` };
    const seats = ((plan && plan.seats) || []).filter((s) => s && s.id);
    if (seats.length !== 4) return { ok: false, error: `${boss.name} needs four seats (have ${seats.length})` };
    const ids = seats.map((s) => s.id);
    if (new Set(ids).size !== 4) return { ok: false, error: 'a character sits in two seats' };
    const classes = seats.map((s) => String(s.cls || '').toLowerCase());
    if (classes.some((c) => !c)) return { ok: false, error: 'every seat needs a class' };
    if (new Set(classes).size !== 4) return { ok: false, error: 'two seats have the same class - v3 tells seats apart by class' };
    const members = [];
    for (const s of seats) {
      const b = this.bot(s.id);
      if (!b) return { ok: false, error: `no character ${s.id}` };
      const label = (b.account && b.account.label) || b.id;
      if (b.client && b.client._standAsideUntil && b.client._standAsideUntil > now) return { ok: false, error: `${label}: you are playing it yourself` };
      if (!b.running || b.paused || !b.serverName) return { ok: false, error: `${label} must be logged in and running (not paused)` };
      const owned = fightplan.rank10(await b.classPoints().catch(() => [])).map((c) => c.toLowerCase());
      if (!owned.includes(String(s.cls).toLowerCase())) return { ok: false, error: `${label} has no rank-10 ${s.cls}` };
      if (info.kind === 'comp' && !info.roles.some((r) => r.role === s.role)) return { ok: false, error: `${boss.name} has no role "${s.role}"` };
      if (info.kind === 'slots') {
        const slot = info.slots.find((x) => x.role === s.role) || info.slots.find((x) => x.classes.some((c) => c.toLowerCase() === String(s.cls).toLowerCase()));
        if (!slot || !slot.classes.some((c) => c.toLowerCase() === String(s.cls).toLowerCase())) return { ok: false, error: `${boss.name}: ${s.cls} fits none of its seats (${info.slots.map((x) => `${x.role}: ${x.classes.join('/')}`).join('; ')})` };
        s.role = slot.role;
      }
      members.push(b);
    }
    const clean = seats.map((s) => ({ id: s.id, cls: s.cls, role: s.role, potions: !!s.potions,
      potionList: (Array.isArray(s.potionList) ? s.potionList : []).map((p) => String(p).trim()).filter(Boolean).slice(0, 4),
      scroll: s.scroll ? String(s.scroll).trim() : '', tauntAt: Number.isFinite(Number(s.tauntAt)) && s.tauntAt !== '' && s.tauntAt !== null ? Math.max(0, Math.min(11, Math.round(Number(s.tauntAt)))) : null }));
    const p = { boss: boss.id, kind: info.kind, seats: clean, by: plan.by || 'dashboard', at: now };
    const raid = this.beginRaid(boss, members, now, clean.map((s) => ({ id: s.id, cls: s.cls })), null, { plan: p });
    (this.settings.raidPlans = this.settings.raidPlans || {})[boss.id] = { seats: clean, at: now };
    this.saveSettings();
    return { ok: true, raid };
  }

  // The plan's files (lib/ultras.js): "seraph-plan" as the boss's Comp + raid-plan.txt. A boss without Comps reads only
  // the seats file (its class decides the role), so it only gets the potions file.
  raidPlanWrite(boss, plan) {
    const ultras = require('./ultras');
    if (plan.kind !== 'comp') { ultras.clearPlan(P.ROOT); return; }
    try {
      const users = plan.seats.map((s) => { const b = this.bot(s.id); return { user: (b && b.account && (b.account.username || b.account.label)) || s.id, cls: s.cls }; });
      ultras.writePlan(P.ROOT, boss, plan.seats.map((s) => ({ ...s, potionList: s.potions ? s.potionList : [] })));
      ultras.setRaidOptions(path.join(P.ROOT, 'skua-options'), boss, users, ultras.PLAN_COMP);
      this.info(`raid: ${boss.name} plan - ${plan.seats.map((s) => `${s.id} ${s.cls} as ${s.role}${s.potions ? ` (${s.potionList.join(', ') || 'potions'})` : ''}${s.scroll ? ` + ${s.scroll}` : ''}`).join('; ')}`);
    } catch (e) { this.info(`raid: could not write the ${boss.name} plan: ${e.message}`); }
  }
  // Potions on/off per seat as planned (raid-potions.txt, read by the v3 potions gate). True when anyone drinks.
  raidPlanPotions(plan) {
    const lines = plan.seats.map((s) => { const b = this.bot(s.id); return `${(b && b.account && (b.account.username || b.account.label)) || s.id}=${s.potions ? 'on' : 'off'}`; });
    try { fs.writeFileSync(path.join(P.ROOT, 'raid-potions.txt'), lines.join('\n') + '\n'); } catch (e) { this.info(`raid: could not write the potions file: ${e.message}`); }
    return plan.seats.some((s) => s.potions);
  }

  // Stop button: every member goes back to its own work. Not a lost try for the autopilot (raidBook memberLeft rule).
  raidStopByHand(now = Date.now()) {
    const r = this.raid;
    if (!r) return { ok: false, error: 'no raid is running' };
    r.memberLeft = r.memberLeft || 'dashboard';
    this.raidCallOff('stopped from the dashboard', now);
    return { ok: true };
  }

  // ---- proven recipes (lib/recipes.js; the owner 2026-10-24: "if we beat an ultra why dont we save the way we beat it so
  // its consistent?") ----
  // Before any other pick, a boss with a proven recipe runs that exact line-up - same characters, classes, roles, comp
  // and potions - from the frozen copy of the script that won, when every character in it is free and at least one of
  // them still needs this period's turn-in. While they still need it the boss is kept out of the other picks
  // (_provenHold), so a different line-up never takes the boss and burns the period; after 6 h of waiting for a busy
  // crew it is released. Two lost replays a period, then the next period. force (dashboard "Run the proven line-up"):
  // past the holds and tries, for that boss only. Returns the raid, { error } when forced and impossible, or null.
  async raidProvenTick(now = Date.now(), { only = null, force = false } = {}) {
    if (process.env.SERAPH_TEST_NO_RECIPES && !this._recipesForTest) return null;   // other tests' fake raids
    const recipes = require('./recipes');
    if (!this._recipesSeeded) {
      // Wins from before recipes existed become recipes too (once per start; bosses that have one are left alone).
      this._recipesSeeded = true;
      const scripts = Object.fromEntries(ultraready.BOSSES.map((b) => [b.id, b.script]));
      const potionsFor = (bossId, id) => { const b = this.bot(id); return b && Hub.isGuest(b) ? this.settings.mainPotions !== false : this.raidPotionsOn(bossId); };
      const seeded = recipes.seed((this.settings.raids || {}).log || [], scripts, potionsFor);
      if (seeded.length) this.info(`raid: proven line-ups seeded from earlier wins: ${seeded.join(', ')} (today's scripts until their first win freezes one)`);
    }
    const { periodKey } = require('./schedule');
    const book = (this.settings.raids = this.settings.raids || { done: {}, tries: {} });
    const locked = (book.locked = book.locked || {});
    const rt = (book.recipeTries = book.recipeTries || {});
    const waits = (book.provenWait = book.provenWait || {});
    const hold = this.raidHeld();
    const keep = new Set();
    let started = null;
    for (const b of ultraready.BOSSES) {
      if (only && b.id !== only) continue;
      const rec = recipes.active(b.id);
      if (!rec) { if (force) return { error: `${b.name} has no proven line-up yet (or it went stale)` }; continue; }
      if (started) { keep.add(b.id); continue; }
      if (!force && (hold.has(b.id) || this.raidGoldShort(b.id))) continue;
      const key = periodKey(b.every, new Date(now));
      // Who in the recipe still needs it this period (an unknown answer counts as needing it).
      const crew = rec.seats.map((s) => this.bot(s.id));
      const missing = rec.seats.filter((s, i) => !crew[i]).map((s) => s.id);
      if (missing.length) { if (force) return { error: `${missing.join(', ')} is not a Seraph character any more` }; continue; }
      const had = [];
      for (const m of crew) if (await this.raidHad(m, b, key)) had.push(m.id);
      if (had.length === crew.length && !force) continue;   // the whole recipe crew has it: the others may take the boss
      const t = rt[b.id];
      const triesLeft = !(t && t.key === key && t.n >= Hub.tryCap(b));
      if (!force) {
        const w = waits[b.id] && waits[b.id].key === key ? waits[b.id] : (waits[b.id] = { key, since: now });
        if (now - w.since < 6 * 3600000) keep.add(b.id);
      }
      if (!force && (!triesLeft || (locked[b.id] && now - locked[b.id] < 3600000))) continue;
      const busy = crew.find((m) => !m.running || m.paused || !m.serverName || (m.client && m.client._standAsideUntil && m.client._standAsideUntil > now)
        || (m.current && (m.current.raid || m.current.type === 'assist')) || (Hub.isGuest(m) && this.settings.mainSeat === false));
      if (busy) {
        const who = (busy.account && busy.account.label) || busy.id;
        if (force) return { error: `${who} is not free (offline, paused, played by you or in another fight)` };
        const note = (this._provenNoted = this._provenNoted || {});
        if (!note[b.id] || now - note[b.id] > 3600000) { note[b.id] = now; this.info(`raid: ${b.name} waits for its proven line-up - ${who} is not free`); }
        continue;
      }
      const gain = [];
      const chainWait = [];
      let storyLocked = null;
      for (const m of crew) {
        if (had.includes(m.id)) continue;
        if (!m.questAvailable || (await m.questAvailable(b.quest).catch(() => true))) { gain.push(m.id); continue; }
        if (b.chain) chainWait.push(m.id); else { storyLocked = (m.account && m.account.label) || m.id; break; }
      }
      if (storyLocked && !force) { this.info(`raid: ${b.name} is not open for ${storyLocked} yet - the proven line-up waits`); locked[b.id] = now; continue; }
      if (!gain.length && !chainWait.length && !force) continue;
      if (await this.raidPrep(crew, b, now)) { keep.add(b.id); continue; }
      const frozen = rec.script && fs.existsSync(path.join(P.SCRIPTS, rec.script)) ? rec.script : null;
      if (rec.script && !frozen) this.info(`raid: ${b.name} - the frozen script ${rec.script} is missing, running today's`);
      this._raidGain = gain;
      this._raidChainWait = chainWait;
      this._raidHad = had;
      this.info(`raid: ${b.name} - replaying the proven line-up (won ${rec.wins || 1}x, first on ${rec.at}): ${rec.seats.map((s) => `${s.id} ${s.cls}${s.role ? ` as ${s.role}` : ''}${s.potions ? ' +potions' : ''}`).join('; ')}${rec.comp ? `, comp ${rec.comp}` : ''}${frozen ? ', frozen script' : ''}`);
      const plan = rec.kind === 'plan' ? { boss: b.id, kind: rec.planKind || 'comp', seats: rec.seats.map((s) => ({ ...s, potionList: s.potionList || [], scroll: s.scroll || '' })), by: 'recipe', at: now } : null;
      started = this.beginRaid(b, crew, now, rec.seats.map((s) => ({ id: s.id, cls: s.cls })), null, { recipe: rec, plan, script: frozen || undefined });
    }
    if (!only) this._provenHold = keep;
    return started;
  }
  async raidProvenStart(bossId, now = Date.now()) {
    if (this.raid) return { ok: false, error: `a raid is running: ${this.raid.name} - stop it first` };
    const r = await this.raidProvenTick(now, { only: bossId, force: true });
    if (!r) return { ok: false, error: 'nobody in the proven line-up can start it now' };
    if (r.error) return { ok: false, error: r.error };
    return { ok: true, raid: r };
  }
  // A replay's booking: a kill for everyone who could gain books the boss done for the recipe crew only (the rest of
  // the party may still take it with the other picks); a partial kill reruns (PARTIAL_ROUNDS); a loss is one of its two.
  raidBookProven(r, killed, key) {
    const book = this.settings.raids;
    const rt = (book.recipeTries = book.recipeTries || {});
    if (!killed && r.partial) {
      const pk = `proven:${r.boss}`;
      const p = (book.partial = book.partial || {})[pk];
      const n = p && p.key === key ? p.n + 1 : 1;
      book.partial[pk] = { key, n };
      if (n <= Hub.PARTIAL_ROUNDS) { this.info(`raid: ${r.name} - partial kill ${n}/${Hub.PARTIAL_ROUNDS} with the proven line-up, running it again`); this.saveSettings(); return; }
    }
    if (!killed) { const t = rt[r.boss]; rt[r.boss] = { key, n: t && t.key === key ? t.n + 1 : 1 }; }
    this.saveSettings();
  }
  // Every raid that ends: a dead boss is saved (a new recipe, a win for the replayed one, or an alternate), a lost
  // replay counts toward stale. Not for a raid the owner left or stopped (memberLeft).
  raidRecipeResult(r, now = Date.now()) {
    if (process.env.SERAPH_TEST_NO_RECIPES && !this._recipesForTest) return null;
    const won = Object.values(r.back || {}).some((v) => /^kill/.test(v)) || (r.attempts || []).some((a) => a.outcome === 'kill');
    if (!won && r.memberLeft) return null;
    r.endedAt = now;
    const snap = (this._raidSnaps || {})[r.id] || null;
    if (this._raidSnaps) delete this._raidSnaps[r.id];
    let res = null;
    try { res = require('./recipes').result(r, won, snap); } catch (e) { this.info(`raid: could not save the recipe: ${e.message}`); return null; }
    const rec = require('./recipes').get(r.boss);
    if (res === 'new') {
      this.info(`raid: ${r.name} - this line-up is now the proven recipe (frozen script ${rec && rec.recipe.script}); the autopilot replays it every period`);
      this.notify(`${r.name}: winning line-up saved`, 'The autopilot replays exactly this line-up from now on (same characters, classes, roles, comp, potions and script).', 'event');
    } else if (res === 'kept') this.info(`raid: ${r.name} - the proven line-up won again (${rec && rec.recipe.wins} wins)`);
    else if (res === 'alternate') this.info(`raid: ${r.name} - won with another line-up; kept as an alternate (the proven one stays)`);
    else if (res === 'lost') this.info(`raid: ${r.name} - the proven line-up lost (${rec && rec.recipe.lossesInRow} in a row)`);
    else if (res === 'stale') {
      this.info(`raid: ${r.name} - the proven line-up lost ${rec && rec.recipe.lossesInRow}x in a row: STALE, the autopilot goes back to its own picks until a new win`);
      this.notify(`${r.name}: the proven line-up stopped winning`, `${rec && rec.stale ? rec.stale.why : ''}. Look at Ultra raids on the dashboard: run an alternate, or plan one.`, 'alert');
    }
    return res;
  }
  // raid-potions.txt as { id: true/false } (who drinks in this raid).
  raidPotionsRead() {
    const out = {};
    try {
      for (const l of fs.readFileSync(path.join(P.ROOT, 'raid-potions.txt'), 'utf8').split(/\r?\n/)) {
        const i = l.indexOf('=');
        if (i <= 0) continue;
        const user = l.slice(0, i).trim().toLowerCase();
        const b = [...this.bots.values()].find((x) => String((x.account && (x.account.username || x.account.label)) || x.id).toLowerCase() === user);
        out[b ? b.id : user] = l.slice(i + 1).trim() === 'on';
      }
    } catch (e) { /* none */ }
    return out;
  }

  // The task a member should run for the current raid: the boss script, or a short wait once it is back.
  raidTask(bot) {
    const r = this.raid;
    if (!r || !r.members.includes(bot.id)) return null;
    if (r.back[bot.id]) return { type: 'wait', minutes: 1, raid: r.id, brain: true, why: `waiting for the party to finish ${r.name}` };
    return { type: 'script', path: r.script, raid: r.id, boss: r.boss, brain: true, why: `ultra raid: ${r.name} with the party` };
  }

  // info.goldWait: the member's script stopped for gold (the gold rule) - the boss waits until it has that much.
  raidDone(bot, task, ok, info = {}) {
    const r = this.raid;
    if (!r || task.raid !== r.id || task.type !== 'script') return;
    const turned = bot.turnedIn && bot.turnedIn.get(Number(r.quest));
    // SeraphUltras reports the boss down for the whole party (BossDown + an Attempt "kill"); the turn-in can still be
    // refused ("Missing Quest Progress": the three Time Inn ultras turn in only in order, Ezrajal > Warden > Engineer).
    // That member is back from a won fight: the others finish their turn-ins instead of being called off (2026-10-18,
    // the first Ultra Engineer kill was called off this way).
    // ... or the member's script saw the boss go down (bot.bossDownAt): a member holding a defeat item from before
    // starts no Attempt, so it reports none (2026-10-22 13:52: Engineer died in 30 s, Valen came back "done" and the
    // raid was called off while Nova was turning hers in).
    const wonFight = (r.attempts || []).some((a) => a.outcome === 'kill') || !!(bot.bossDownAt && bot.bossDownAt >= r.started);
    r.back[bot.id] = turned && turned > r.started ? 'kill' : wonFight ? 'kill (no turn-in)' : ok ? 'done' : 'failed';
    // The script could not put on this member's seat class: the skua.swf model is from the last login and the class came
    // later (2026-10-19, Nova's Void Highlord - Warden and Engineer used up the day's two tries at 04:00 without a
    // fight). Not a try for the period (raidBook); the member logs out and back in once the raid is closed.
    const seat = bot.seatEquipFailed && bot.seatEquipFailed.at >= r.started ? bot.seatEquipFailed : null;
    if (seat && !/^kill/.test(r.back[bot.id])) {
      r.back[bot.id] = `no seat (${seat.cls})`;
      r.setupFail = { id: bot.id, cls: seat.cls };
      this._raidRelogUntil = Date.now() + 3 * 60000;   // raidTick waits for the relog before the next boss
      this.timers.push(setTimeout(() => this.relogForSeat(bot.id, seat.cls), 5000));
    }
    if (info.goldWait) (r.goldShort = r.goldShort || {})[bot.id] = info.goldWait;
    this.info(`raid: ${bot.account.label} is back from ${r.name} (${r.back[bot.id]}${info.goldWait ? `, needs ${Math.round(info.goldWait / 1e5) / 10} M gold` : ''})`);
    // Booked done for the period only when everyone who could gain turned it in (2026-10-18: Ultra Warden died, only
    // Valen had the defeat item, and booking it done kept the other three from another try all day).
    if (r.members.every((id) => r.back[id])) {
      const gain = r.gain && r.gain.length ? r.gain : r.members;
      // Members held back only by the Time Inn order still need this boss today (raidTick chainWait).
      // Turned in earlier this period (a hand-started rerun has no gain list, 2026-10-19 16:19: the three who had Warden
      // already read as "missed" and the kill was booked partial): not missed.
      const per = require('./schedule').periodKey(r.every, new Date(r.started));
      const hadIt = (id) => { if ((r.had || []).includes(id)) return true; const b = this.bot && this.bot(id); const t = b && b.turnedIn && b.turnedIn.get(Number(r.quest)); return !!(t && require('./schedule').periodKey(r.every, new Date(t)) === per); };
      const missed = [...new Set([...gain, ...(r.chainWait || [])])].filter((id) => r.back[id] !== 'kill' && !hadIt(id));
      if (missed.length && Object.values(r.back).some((v) => /^kill/.test(v))) {
        this.info(`raid: ${r.name} died, but ${missed.join(', ')} got no turn-in - it stays open for them`);
        // A partial kill (the owner 2026-10-19): the boss runs again, and whoever died out of the turn-in swaps classes with
        // someone who has it (raidSwapSeats). raidBook doesn't count it as a try.
        r.partial = {
          died: gain.filter((id) => r.back[id] !== 'kill' && !hadIt(id)),
          done: r.members.filter((id) => r.back[id] === 'kill' || hadIt(id) || (!gain.includes(id) && !(r.chainWait || []).includes(id))),
        };
      }
      return this.raidClose(!missed.length);
    }
    // Round 2 of a swap: the members who already have this week's kill can't turn the quest in again; only the swapped
    // bot and the main decide.
    if (r.swap && r.swap.phase === 2 && ![r.swap.out, r.swap.main].includes(bot.id)) return;
    // A member out with no kill while the others still fight: v3 bosses need all four. On 2026-10-16 Valen dropped out
    // of every Drakath / Gramiel raid within 2 min (gold rule) and the other three wiped for the full 3 h, four times.
    // A script that ends "done" without the kill is out just the same: later that day v3's class sync timed out for
    // three restarted members (they came back "done") and Oren fought Drakath alone for another 40 min.
    if (!/^kill/.test(r.back[bot.id]) && !Object.values(r.back).some((v) => /^kill/.test(v))) this.raidCallOff(`${bot.account.label} is out without the kill (${r.back[bot.id]})`);
  }

  // One SeraphUltras Attempt report from a member (lib/ultras.js): kept on the raid, so the raid log says how each try
  // went (outcome, boss HP, deaths per class) instead of only "done" or "failed".
  raidAttempt(bot, att) {
    const r = this.raid;
    if (!r || !r.members.includes(bot.id)) return null;
    (r.attempts = r.attempts || []).push({ id: bot.id, cls: att.class, role: att.role, comp: att.comp, outcome: att.outcome, bossHp: att.bossHp, bossMaxHp: att.bossMaxHp, deaths: (att.deaths || []).map((d) => d.atSec), at: att.endedAt, ...(att.stats ? { stats: att.stats } : {}) });
    if (r.attempts.length > 200) r.attempts.shift();
    return r.attempts[r.attempts.length - 1];
  }

  // Ends the raid for everyone now (a try for the period) and sends the members still inside back to their own work.
  // A member who left without coming back (the owner logged in to it, or its loop stopped after a lost connection): the
  // others waited for the army until the pace watch or the 3 h limit gave up - 2026-10-22 16:14 the owner took his main
  // mid-Tyndarius and three bots stood in /ultratyndarius; 14:45 three loops died in a network drop mid-raid.
  static get RAID_GONE_MS() { return 5 * 60000; }
  raidMemberGone(r, now = Date.now()) {
    const gone = (r.gone = r.gone || {});
    for (const id of r.members) {
      const b = this.bot && this.bot(id);
      // Running but on other work (2026-10-23: an escort took Oren's slot back): sent back to the raid once after
      // 2 min; still elsewhere at RAID_GONE_MS = gone.
      const astray = !!(b && b.running && !b.paused && b.current && b.current.raid !== r.id);
      if (r.back[id] || (b && b.running && !b.paused && !astray)) { delete gone[id]; continue; }
      gone[id] = gone[id] || now;
      if (astray && !(r.nudged && r.nudged[id]) && now - gone[id] >= 2 * 60000) {
        (r.nudged = r.nudged || {})[id] = now;
        b.journal(`back to the ${r.name} raid - "${b.current.why || b.current.type}" had taken my slot`);
        Promise.resolve(b.restart()).catch(() => null);
      }
      if (now - gone[id] >= Hub.RAID_GONE_MS) return id;
    }
    return null;
  }
  // Called off at once, and nobody's fault: not a lost try (raidBook), no potions verdict (raidPotionsLearn), and the
  // one who left is not restarted (a stood-aside character must stay out).
  raidLeft(r, id, why, now = Date.now()) {
    if (!r || this.raid !== r || !r.members.includes(id) || r.back[id]) return;
    r.memberLeft = id;
    const b = this.bot && this.bot(id);
    this.raidCallOff(`${(b && b.account && b.account.label) || id} left the raid (${why})`, now);
  }

  raidCallOff(why, now = Date.now()) {
    const r = this.raid;
    if (!r) return;
    this.info(`raid: calling off ${r.name} - ${why}`);
    for (const id of r.members) if (!r.back[id]) r.back[id] = 'called off';
    const book = (this.settings.raids = this.settings.raids || { done: {}, tries: {} });
    for (const [id, gold] of Object.entries(r.goldShort || {})) {
      (book.goldHold = book.goldHold || {})[r.boss] = { id, gold, at: now };
      this.info(`raid: ${r.name} waits until ${id} has ${Math.round(gold / 1e5) / 10} M gold`);
    }
    this.raidClose(false, now);
    for (const id of r.members) { const b = this.bot && this.bot(id); if (id !== r.memberLeft && b && b.current && b.current.raid === r.id) b.restart(); }
  }

  // A boss held for a member's gold (raidCallOff): still short?
  raidGoldShort(bossId) {
    const book = this.settings.raids || {};
    const h = book.goldHold && book.goldHold[bossId];
    if (!h) return false;
    const b = this.bot(h.id);
    const gold = b && typeof b.goldNow === 'function' ? Number(b.goldNow()) : NaN;
    if (Number.isFinite(gold) && gold >= h.gold) { delete book.goldHold[bossId]; return false; }
    return true;
  }

  raidClose(killed, now = Date.now()) {
    const r = this.raid;
    if (!r) return;
    // Round 1 of a swap killed it: the swapped bot still needs its own kill (round 2) before the boss is booked.
    if (killed && r.swap && r.swap.phase === 1) {
      const boss = ultraready.BOSSES.find((b) => b.id === r.boss);
      this.raidEnd(r, true, now);
      this.notify(`${r.name} killed with the main!`, `${Object.entries(r.back).map(([id, v]) => `${id}: ${v}`).join(', ')} - round 2 for ${r.swap.out}`, 'event');
      const book = () => this.raidBook(r, true, now);
      if (!boss) return book();
      this._raidSwapping = true;   // raidTick must not start the boss over for all four meanwhile
      this.raidSwapBack(r, boss, now).then((n) => { if (!n) book(); }).catch((e) => { this.info(`raid: round 2 did not start: ${e.message}`); book(); })
        .finally(() => { this._raidSwapping = false; });
      return;
    }
    // Round 2 ends the boss for the period either way: three of the four have it.
    if (r.swap && r.swap.phase === 2) killed = true;
    this.raidBook(r, killed, now);
    this.raidEnd(r, killed, now);
    this.notify(killed ? `${r.name} killed!` : `${r.name}: no kill this time`, `${Object.entries(r.back).map(([id, v]) => `${id}: ${v}`).join(', ')}`, killed ? 'event' : 'alert');
  }

  // The raid's log line, and the raid slot free again. killed: true / false, or null for a swap's hand-over.
  raidEnd(r, killed, now = Date.now()) {
    const book = (this.settings.raids = this.settings.raids || { done: {}, tries: {} });
    (book.log = book.log || []).push({ boss: r.boss, at: new Date(r.started).toISOString(), minutes: Math.round((now - r.started) / 60000), killed, back: r.back, ...(r.swap ? { swap: r.swap } : {}), ...(r.attempts ? { attempts: r.attempts.slice(-40) } : {}) });
    book.log = book.log.slice(-200);
    this.raidPotionsLearn(r, killed);
    if (killed !== null) this.raidRecipeResult(r, now);
    if (killed !== null) this.raidHoldResult(r, killed, now);
    if (r.plan) require('./ultras').clearPlan(P.ROOT);
    this.saveSettings();
    this.info(`raid: ${r.name} ${killed === null ? 'handed over' : killed ? 'KILLED' : 'not killed'} (${Math.round((now - r.started) / 60000)} min${r.swap && r.swap.phase ? `, swap round ${r.swap.phase}` : ''})`);
    if (this.raid === r) this.raid = null;
  }

  // settings.raidHold (POST /raid/hold) kept a boss off the raids until Claude lifted it, and that never happens when
  // nobody looks (the owner 2026-10-27: the app must carry on without Claude). Holds end by themselves now: a boss held
  // RAID_HOLD_DAYS is tried again - the party grows meanwhile (forge enhancements, 51% weapons, classes). After
  // RAID_HOLD_LOSSES lost fights in a row it goes back on hold for twice as long (up to RAID_HOLD_MAX_DAYS); a kill
  // ends the watch (its proven recipe takes over). settings.raidHoldMeta[boss] = { since, days, lifted?, losses?,
  // forever? }; forever: true (POST /raid/hold {forever: true}) stays held. Returns the held bosses (a Set).
  raidHeld(now = Date.now()) {
    const s = this.settings || {};
    const list = Array.isArray(s.raidHold) ? s.raidHold : [];
    const meta = (s.raidHoldMeta = s.raidHoldMeta || {});
    let changed = false;
    const keep = list.filter((id) => {
      let m = meta[id];
      if (!m || m.lifted) { m = meta[id] = { since: now, days: (m && m.days) || RAID_HOLD_DAYS }; changed = true; }
      if (m.forever || now - m.since < m.days * 86400000) return true;
      Object.assign(m, { lifted: now, losses: 0 });
      changed = true;
      if (typeof this.info === 'function') this.info(`raid: ${id} was held ${m.days} days - back in the raids (holds end by themselves)`);
      if (typeof this.notify === 'function') this.notify(`Ultra hold ended: ${id}`, `Held ${m.days} days, so the party tries it again. ${RAID_HOLD_LOSSES} lost fights in a row hold it again for ${Math.min(m.days * 2, RAID_HOLD_MAX_DAYS)} days; a kill saves the line-up.`, 'news');
      return false;
    });
    if (changed) { s.raidHold = keep; if (typeof this.saveSettings === 'function') this.saveSettings(); }
    return new Set(keep);
  }
  // A raid ended (raidEnd): a boss back from its hold counts real lost fights - a call-off, a member who left, a seat
  // that never went on or the owner's own Raid Planner line-up is no verdict.
  raidHoldResult(r, killed, now = Date.now()) {
    const s = this.settings || {};
    const m = s.raidHoldMeta && s.raidHoldMeta[r.boss];
    if (!m || !m.lifted) return null;
    if (killed) { delete s.raidHoldMeta[r.boss]; return 'killed'; }
    if (r.memberLeft || r.plan || r.setupFail || !(r.attempts || []).length) return null;
    m.losses = (m.losses || 0) + 1;
    if (m.losses < RAID_HOLD_LOSSES) return 'lost';
    const days = Math.min((m.days || RAID_HOLD_DAYS) * 2, RAID_HOLD_MAX_DAYS);
    s.raidHoldMeta[r.boss] = { since: now, days };
    s.raidHold = [...new Set([...(s.raidHold || []), r.boss])];
    if (typeof this.info === 'function') this.info(`raid: ${r.name || r.boss} lost ${m.losses} fights in a row after its hold - held again for ${days} days`);
    return 'held';
  }

  // Potions per boss (the owner 2026-10-20: "if there is a way that can defeat ultras without potions its preferably if
  // there is no way without potions then so be it buy potions"). Every boss starts without: the party fights it with
  // no potions bought or drunk. After POTION_FAILS real fights (attempts reported) lost without potions and no kill
  // without them, the boss switches to potions for good - v3 buys the recommended ones (UltraPotions, only with 6 M+
  // gold, never farming gold for them: the gold rule) and drinks them. The owner's main never gets potions (his account).
  // The switch reaches the scripts as <root>/raid-potions.txt ("<username>=on|off", tools/vendor-ultras.js FIXES).
  static get POTION_FAILS() { return 3; }
  raidPotionsOn(bossId) { const p = ((this.settings.potionPolicy || {})[bossId]) || null; return !!(p && p.on); }
  raidPotionsWrite(boss, members) {
    const on = this.raidPotionsOn(boss.id);
    // The owner's main drinks in every raid he joins (2026-10-22: "give my main potions" - the fork's Tyndarius wipes came
    // from one account without potions); hub setting mainPotions false turns it off. The bots follow potionPolicy.
    const lines = members.map((b) => `${(b.account && (b.account.username || b.account.label)) || b.id}=${(Hub.isGuest(b) ? this.settings.mainPotions !== false : on) ? 'on' : 'off'}`);
    try { fs.writeFileSync(path.join(P.ROOT, 'raid-potions.txt'), lines.join('\n') + '\n'); } catch (e) { this.info(`raid: could not write the potions file: ${e.message}`); }
    return on;
  }
  raidPotionsLearn(r, killed) {
    if (r && (r.plan || r.recipe)) return;   // The owner picked the potions himself (Raid Planner), or the proven recipe did
    if (killed === null || !r || !r.boss || (!killed && r.memberLeft)) return;
    // A partial kill or no real fight: no verdict. A fight called off mid-way is a real one even without Attempt
    // reports (the scripts report only when they end): 2026-10-22, Ezrajal and Engineer were called off ~10 times
    // since potions went off on 10-20 and never switched back on - every win on 10-19/20 was with potions.
    const fought = (r.attempts && r.attempts.length) || (r.fight && r.fight.startAt);
    if (!killed && (r.partial || !fought)) return;
    const pol = (this.settings.potionPolicy = this.settings.potionPolicy || {});
    const p = (pol[r.boss] = pol[r.boss] || { on: false, offKills: 0, offFails: 0, onKills: 0, onFails: 0 });
    if (r.potions) { if (killed) p.onKills++; else p.onFails++; return; }
    if (killed) { p.offKills++; return; }
    p.offFails++;
    if (!p.offKills && p.offFails >= Hub.POTION_FAILS && !p.on) {
      p.on = true;
      p.since = new Date().toISOString();
      this.info(`raid: ${r.name} lost ${p.offFails} fights without potions and was never beaten without them - potions ON for it from now on`);
      this.notify(`${r.name}: potions from now on`, `${p.offFails} fights lost without potions; the party buys and drinks the recommended ones next time`, 'alert');
    }
  }

  // The boss's period: done (killed) or one more try.
  raidBook(r, killed) {
    const book = (this.settings.raids = this.settings.raids || { done: {}, tries: {} });
    const key = require('./schedule').periodKey(r.every, new Date(r.started));
    if (!killed && r.memberLeft) { this.info(`raid: ${r.name} - ${r.memberLeft} left; not counted as a try`); this.saveSettings(); return; }
    if (r.recipe) return this.raidBookProven(r, killed, key);
    // The owner's own line-up (Raid Planner): a loss is his test, not one of the autopilot's tries; a kill books as usual.
    if (!killed && r.plan) { this.info(`raid: ${r.name} - Raid Planner line-up lost; not counted as a try`); this.saveSettings(); return; }
    // With the main in a seat (raidWithMain) the period is booked only once no bot needs the turn-in any more: a kill
    // is not the end while a bot was left out of it. A partial kill reruns up to PARTIAL_ROUNDS times like the bots'
    // own (whoever missed it still needs it, so the next pick seats them); a lost fight is one of his two a period.
    if (r.withMain) {
      const mt = (book.mainTries = book.mainTries || {});
      const lose = () => { const t = mt[r.boss]; mt[r.boss] = { key, n: t && t.key === key ? t.n + 1 : 1 }; };
      if (!killed && r.partial) {
        const pk = `main:${r.boss}`;
        const p = (book.partial = book.partial || {})[pk];
        const n = p && p.key === key ? p.n + 1 : 1;
        book.partial[pk] = { key, n };
        if (n > Hub.PARTIAL_ROUNDS) lose(); else this.info(`raid: ${r.name} - partial kill ${n}/${Hub.PARTIAL_ROUNDS} with the main, running it again for ${r.partial.died.join(', ') || 'the rest'}`);
      } else if (!killed) lose();
      this.saveSettings();
      return;
    }
    if (killed) { book.done[r.boss] = key; if (book.swap) delete book.swap[r.boss]; }
    else if (r.partial) {
      // A partial kill: another round with the seats swapped (raidSwapSeats), up to PARTIAL_ROUNDS a period before
      // they count as tries again. Members who died out of the turn-in carry over to the next round's swap.
      const p = (book.partial = book.partial || {})[r.boss];
      const n = p && p.key === key ? p.n + 1 : 1;
      book.partial[r.boss] = { key, n };
      if (r.partial.died.length) (book.swap = book.swap || {})[r.boss] = { key, ids: r.partial.died, done: r.partial.done };
      if (n > Hub.PARTIAL_ROUNDS) { const t = book.tries[r.boss]; book.tries[r.boss] = { key, n: t && t.key === key ? t.n + 1 : 1 }; }
      else this.info(`raid: ${r.name} - partial kill ${n}/${Hub.PARTIAL_ROUNDS} this period, running it again${r.partial.died.length ? ` with ${r.partial.died.join(', ')} in another seat` : ''}`);
    } else {
      // A seat the script couldn't equip (raidDone) is no fight: not a try, twice per boss and period at most, so a
      // class that is really missing can't restart the boss forever.
      const s = r.setupFail ? (book.setupFails = book.setupFails || {})[r.boss] : null;
      if (r.setupFail && !(s && s.key === key && s.n >= 2)) {
        book.setupFails[r.boss] = { key, n: s && s.key === key ? s.n + 1 : 1 };
        this.info(`raid: ${r.name} - ${r.setupFail.id} could not put on ${r.setupFail.cls}; not counted as a try`);
      } else { const t = book.tries[r.boss]; book.tries[r.boss] = { key, n: t && t.key === key ? t.n + 1 : 1 }; }
    }
    this.saveSettings();
  }

  // A raid member whose script could not see its seat class logs out and back in (the same path as the daily-reset
  // relog): the skua.swf model is rebuilt from the login, with the class in it.
  relogForSeat(id, cls) {
    const client = this.clients && this.clients.get(id);
    const bot = this.bots.get(id);
    if (!client || !client.state || !client.state.loaded || client._reconnecting || Hub.isGuest(bot)) return false;
    if (this.raid && this.raid.members.includes(id)) return false;
    this.info(`${id}: the raid script could not equip ${cls} - logging out and back in`);
    if (bot && bot.journal) bot.journal(`raid seat: the script could not equip ${cls} - logging out and back in so it sees the class`);
    client.scriptDriven = false;
    Promise.resolve(client.flash ? client.fn('sfc.disconnect') : client.call('sfc.disconnect')).catch(() => null);
    return true;
  }

  // A server stack that stopped counting (bot.stackWatch) is only rebuilt by a fresh login: same drop-and-reconnect
  // path as the daily-reset relog. Raid members and the owner's own account are left alone.
  relogForStack(id, e) {
    const client = this.clients && this.clients.get(id);
    const bot = this.bots.get(id);
    if (!client || !client.state || !client.state.loaded || client._reconnecting || Hub.isGuest(bot)) return false;
    if (this.raid && this.raid.members.includes(id)) return false;
    this.info(`${id}: ${e.grants} grants of ${e.name} stuck at ${e.qty} on the server - logging out and back in`);
    client.scriptDriven = false;
    Promise.resolve(client.flash ? client.fn('sfc.disconnect') : client.call('sfc.disconnect')).catch(() => null);
    return true;
  }

  // ---------------- army farming (Skua CoreArmyLite: StartFarm / DivideOnCells / WaitForParty) ----------------
  // Everyone online farms the same thing in one room. Each bot farms until it holds its own quota, then keeps
  // killing for the others until the whole party is done - kills land faster and nobody finishes alone.
  startArmy(opts) {
    const now = Date.now();
    const cells = [].concat(opts.cells || opts.cell || []).filter(Boolean);
    this.army = {
      id: `army-${now}`, map: String(opts.map).toLowerCase(), room: opts.room || (1 + Math.floor(Math.random() * 6)),
      cells, monster: opts.monster || '*', item: opts.item || null, qty: Number(opts.qty || 1),
      quests: [].concat(opts.quests || []).map(Number).filter(Boolean), until: now + (opts.hours || 2) * 3600000,
      members: [], done: [], by: opts.by || 'the owner',
    };
    this.info(`army: everyone to ${this.army.map}-${this.army.room} for ${this.army.item || this.army.monster}${this.army.item ? ` x${this.army.qty}` : ''}`);
    return this.army;
  }

  armyTask(bot) {
    const a = this.army;
    if (!a) return null;
    if (Date.now() > a.until) { this.info('army: time is up'); this.army = null; return null; }
    if (a.members.includes(bot.id) || !bot.serverName) return null;
    a.members.push(bot.id);
    // DivideOnCells: spread the party over the listed cells so monsters are never contested between our own bots.
    const cell = a.cells.length ? a.cells[(a.members.length - 1) % a.cells.length] : null;
    return { type: 'armyFarm', army: a.id, map: a.map, room: a.room, cell, monster: a.monster, item: a.item, qty: a.qty, quests: a.quests, why: `army farm: ${a.item || a.monster} in ${a.map}` };
  }

  armyDone(bot, id) {
    const a = this.army;
    if (!a || a.id !== id) return true;
    if (!a.done.includes(bot.id)) { a.done.push(bot.id); this.info(`army: ${bot.account.label} has its ${a.item || 'share'} (${a.done.length}/${a.members.length})`); }
    if (a.done.length >= a.members.length) { this.info('army: everyone is done'); this.notify('Army farm finished', `${a.item || a.monster} x${a.qty} for the whole party`, 'event'); this.army = null; return true; }
    return false;
  }

  // Two bots after the same goal share a room, so they farm the same monsters together instead of apart.
  sharedRoomFor(bot, goalId) {
    if (!goalId) return null;
    for (const other of this.bots.values()) {
      if (other === bot || Hub.isGuest(other) || !other.running || !other.current || other.current.goal !== goalId) continue;
      if (other.serverName && bot.serverName && other.serverName !== bot.serverName) continue;
      return other._taskRoom || other.roomNumber();
    }
    return null;
  }

  // ---------------- boss alert for the owner ----------------
  // The owner, 2026-09-22: "if you see someone is stuck with a boss make the aqwbot ping me or dm me on discord with the
  // room number". Two deaths to the same boss within 20 min means stuck: the Discord bot DMs him where to join. The game
  // has no boss flag, so a boss is a monster with BOSS_HP_RATIO times the character's own hit points (at least
  // BOSS_HP_MIN); ordinary monsters are the watchdog's business. One DM per character and boss every 30 min.
  async bossDeath(bot, killer, now = Date.now()) {
    const w = (bot.client && bot.client.w) || {};
    const myMax = Number(w.myAvatar && w.myAvatar.dataLeaf && w.myAvatar.dataLeaf.intHPMax) || 0;
    if (!killer || !killer.name || !(Number(killer.hpMax) >= Math.max(BOSS_HP_MIN, BOSS_HP_RATIO * myMax))) return null;
    if (crowd.dieTo(w.strMapName, killer.name)) return null;                  // the quest wanted that death (crowd.json dieTo)
    if (typeof this.crewDeath === 'function') this.crewDeath(bot, killer);   // a crew daily's stage counts its deaths (lib/crewdaily.js)
    // An army script's member: the army is the help, and it handles its wipes - no calls, no party wall, no main's rest.
    if (bot.current && bot.current.crewScript) return null;
    // A help call the whole party is losing ends: the four of them wiped on the Eternal Dragon again and again on
    // 2026-09-27, and the next call would only have started it over. The boss is a party wall for a day (struggle).
    const h = Hub.prototype.helpOf.call(this, bot, killer.name);   // any hub-like object (tests call this on plain ones)
    // Only deaths in the help room count: on 2026-09-27 the Desolich call was declared a wall after 2 min, from deaths
    // of characters still on their way (or dying alone in a public room).
    const inHelpRoom = String(w.strAreaName || '').toLowerCase() === `${h && h.map}-${h && h.room}`;
    if (h && inHelpRoom && now < h.until) {
      h.deaths = (h.deaths || 0) + 1;
      h.deathsSinceKill = (h.deathsSinceKill || 0) + 1;
      // A boss that one-shots everyone (Legion Lich Lord, 15-18k hits on ~11k HP) kills the party once every ~15 s even
      // in fights it wins: 4 of them killed it in under 2 min on 2026-10-10 with ~8 deaths. On 10-11 only two had arrived
      // (Sable stuck in whitemap, Nova on a daily), 8 deaths came in 2 min and it got the 24 h wall. So: no wall
      // once the call has a kill or the boss is under half HP; three times the deaths before the wall anyway.
      const hurt = Number(killer.hpMax) > 0 && Number(killer.hp) / Number(killer.hpMax) < 0.5;
      // A squad (lib/squad.js) that is dying calls everyone before anything else; the wall counts from there.
      if (h.full === false && (h.kills ? h.deathsSinceKill >= squad.FARM_ESCALATE_DEATHS : h.deaths >= squad.ESCALATE_DEATHS)) {
        this.escalateHelp(h.kills ? `${h.deathsSinceKill} deaths since the last kill` : `${h.deaths} deaths, no kill`, now, h).catch((e) => this.info(`escalate: ${e.message}`));
      } else if (h.kills) {
        if (h.deathsSinceKill >= PARTY_WALL_DEATHS * 3) this.endHelp(`the party died ${h.deathsSinceKill}x to ${h.monster} since its last kill`, false, h);
      } else {
        const d = h.deaths - (h.deathsAtFull || 0);
        if (h.full !== false && (d >= PARTY_WALL_DEATHS * 3 || (d >= PARTY_WALL_DEATHS && !hurt))) this.endHelp(`the party died ${h.deaths}x to ${h.monster}`, true, h);
      }
    }
    const deaths = (bot._bossDeaths = (bot._bossDeaths || []).filter((d) => now - d.at < 20 * 60000).concat({ name: killer.name, at: now }));
    const n = deaths.filter((d) => d.name === killer.name).length;
    if (n < 2) return null;
    const area = w.strAreaName || `${await bot.map().catch(() => '?')}-${bot.roomNumber()}`;
    if (this.struggle) await this.struggle(bot, killer, n).catch((e) => this.info(`struggle: ${e.message}`));
    const quiet = dmVeto(bot, killer, myMax, now);
    if (quiet) {
      this.info(`boss deaths: ${bot.account.label} died ${n}x to ${killer.name} in ${area} - no DM (${quiet})`);
      return null;
    }
    const room = String(area).split('-')[1] || '?';
    const pct = killer.hpMax ? Math.round((100 * killer.hp) / killer.hpMax) : null;
    const t = bot.current;
    const text = [
      `🆘 **${bot.account.label} is stuck on a boss: ${killer.name}**`,
      `Died ${n}x in 20 min${pct !== null ? ` · boss at ${pct}% HP` : ''}${killer.cell ? ` · cell ${killer.cell}` : ''}`,
      `Room **${room}**: \`/join ${area}\`${bot.serverName ? ` on **${bot.serverName}**` : ''}`,
      `${bot.account.label} lvl ${await bot.level().catch(() => '?')}${t ? ` · doing: ${String(t.why || t.path || t.type).slice(0, 120)}` : ''}`,
    ].join('\n');
    this.info(`boss alert: ${bot.account.label} died ${n}x to ${killer.name} in ${area}`);
    if (this.settings.notify && this.settings.notify.boss === false) return { text, sent: false };
    const sent = this.discord ? this.discord.send(text, { kind: 'boss', key: `boss:${bot.id}:${killer.name}`, quiet: BOSS_DM_QUIET, dm: true }) : false;
    return { text, sent };
  }

  // ---------------- the struggle rule (the owner, 2026-09-25) ----------------
  // "when someone is struggling with a boss make them go together to kill that boss then they return to what they were
  // doing. by struggling it means that the bot cant kill that boss solo at all ... if the bot can kill the boss atleast
  // once this doesnt count as strugelling". And for the busy server: "if a bot joins artix and there is no one helping
  // the bot make the bot return to swordhaven but gather all the bots to make them help that bot."
  // Struggling = two deaths to one boss in 20 min (bossDeath) and never a solo kill of it (bossKilled keeps the list).
  // Real players in the cell count as help: then the bot keeps at it where it is.
  // Our own characters as the game names them, and their combat refs (p:<uid>): they are never "real players".
  ourPlayers(now = Date.now()) {
    if (this._ours && now - this._ours.at < 10000) return this._ours;
    const names = new Set(); const uids = new Set();
    for (const [id, c] of this.clients) {
      const a = c.w && c.w.myAvatar;
      names.add(String(id).toLowerCase());
      if (c.account && c.account.username) names.add(String(c.account.username).toLowerCase());
      if (a && a.objData && a.objData.strUsername) names.add(String(a.objData.strUsername).toLowerCase());
      if (a && a.uid) uids.add(`p:${a.uid}`);
    }
    return (this._ours = { at: now, names, uids });
  }

  isBoss(bot, hpMax) {
    const w = (bot.client && bot.client.w) || {};
    const myMax = Number(w.myAvatar && w.myAvatar.dataLeaf && w.myAvatar.dataLeaf.intHPMax) || 0;
    return Number(hpMax) >= Math.max(BOSS_HP_MIN, BOSS_HP_RATIO * myMax);
  }

  // Every boss a character has killed with nobody else in the cell, kept across restarts (<bot>/soloBosses.json).
  soloBosses(bot) {
    if (!bot._soloBosses) bot._soloBosses = bot.file ? readJson(bot.file('soloBosses.json'), {}) : {};
    return bot._soloBosses;
  }

  bossKilled(bot, m) {
    if (!m || !m.name || !this.isBoss(bot, m.hpMax)) return;
    // Any kill it took part in, with or without other players: the boss can be killed, so it is no reason to DM the owner.
    if (m.byMe) {
      const beat = killedBosses(bot);
      beat[m.name] = new Date().toISOString();
      if (bot.file) try { writeJson(bot.file('killedBosses.json'), beat); } catch { /* memory still has it */ }
    }
    if (m.byMe) fightplan.onKill(bot, m.name);
    if (m.byMe && !m.others) {
      const solo = this.soloBosses(bot);
      if (!solo[m.name]) {
        solo[m.name] = new Date().toISOString();
        if (bot.file) writeJson(bot.file('soloBosses.json'), solo);
        if (bot.journal) bot.journal(`killed ${m.name} solo - it no longer counts as a boss I struggle with`);
      }
    }
    // A wall (lib/walls.js) this character took part in killing: what it blocked is tried again (and parks again, with
    // the wall, if the item still didn't come).
    // Not while it was helping someone else (an assist or a follow): it got nothing for its own blocked step there.
    // Sable helped Valen and Oren kill their Taro Blademaster, each kill un-parked her own Farmer Joe, which
    // walked her straight back to Taro alone for 8 more deaths - 104 deaths in 10 days (check-up 2026-10-04). Escorts
    // clear the characters that passed on their own (walls.end).
    const helping = bot.current && (bot.current.type === 'assist' || bot.current.type === 'follow');
    if (m.byMe && this.walls && !helping) {
      const w = this.walls.data.walls[String(m.name).toLowerCase()];
      if (w && w.blocks && w.blocks[bot.id]) this.walls.clear(bot, w, `killed ${m.name}`);
    }
    // The party came for this boss and it is dead: the call is over, everyone goes back to what they were doing.
    // Only a kill in the caller's room: drops and quest items go to the players in that room. Edda's 60 Alteon kills
    // in a chaosrealm room Vexa could not get into kept her farm call open for 47 min (2026-10-26).
    const h = Hub.prototype.helpOf.call(this, bot, m.name);
    if (h && m.map === crowd.baseMap(h.map) && Hub.prototype.inCallerRoom.call(this, bot, h)) {
      // A guard (the caller's script is still on this boss) or a farm call (the caller's step wants many drops of this
      // boss): the party stays for the next one.
      if (h.guard ? this.helpGuardKill(h) : h.farm && this.helpFarmKill(h)) return;
      this.info(`${h.who}'s ${h.monster} is dead - the party goes back to what it was doing`);
      h.kills = h.kills || 1;
      // The party's kill answers the deaths before it: the caller's death count starts again (Edda, 2026-10-25: the party
      // killed DoomKitten for her twice in 8 s, the 8 deaths around those kills still parked the ArchPaladin goal for 24 h).
      const caller = this.bots.get(h.by);
      if (caller) caller._capDeaths = [];
      this.closeHelp(h);
    }
  }

  // ---------------- help calls (several at once since Seraph 5) ----------------
  // Each open call has its own squad, and a character is in one call at most. `this.help` stays the latest open call for
  // the dashboard, the report and older code; everything else goes through these.
  helpCalls(now = Date.now()) {
    this.helps = this.helps || new Map();
    // `this.help` is always one of the open calls; set to null by hand (tests, older code) it clears them all.
    if (!this.help && this.helps.size) { for (const x of this.helps.values()) x._closed = true; this.helps.clear(); }
    if (this.help && !this.helps.has(this.help.id) && !this.help._closed) this.helps.set(this.help.id, this.help);
    return [...this.helps.values()].filter((h) => !h._closed && (now < h.until || !h.until));
  }
  anyHelp(now = Date.now()) { return this.helpCalls(now).length > 0; }
  helpById(id) {
    this.helpCalls();
    const h = this.helps.get(id);
    return h && !h._closed ? h : null;
  }
  // The open call this character is in (as the caller or a helper), for this boss when one is named.
  helpOf(bot, monster = null) {
    const id = bot && (bot.id || bot);
    const k = monster ? String(monster).toLowerCase() : null;
    return Hub.prototype.helpCalls.call(this).find((h) => (h.by === id || h.helpers.includes(id)) && (!k || String(h.monster).toLowerCase() === k)) || null;
  }
  // Calls past their time end; one that never killed its boss makes it a party wall (as the single call always did).
  expireHelps(now = Date.now()) {
    this.helpCalls(now);
    for (const h of [...this.helps.values()]) if (!h._closed && h.until && now >= h.until) this.endHelp(`the ${h.monster} call ran out of time`, !h.kills, h);
  }
  // A call is over: off the list, its cooldown starts (for that boss only).
  closeHelp(h, now = Date.now()) {
    if (!h || h._closed) return;
    h._closed = true;
    this.recordHelp(h);
    if (this.helps) this.helps.delete(h.id);
    this._helpCooldown = now;
    this._helpCooldownBoss = String(h.monster).toLowerCase();
    (this._helpCooldowns = this._helpCooldowns || {})[this._helpCooldownBoss] = now;
    const open = this.helps ? [...this.helps.values()].filter((x) => !x._closed) : [];
    this.help = open.length ? open[open.length - 1] : null;
  }

  // Bosses the whole party could not kill, kept across restarts (<root>/partyWalls.json) for PARTY_WALL_MS.
  loadWalls() {
    if (!this.partyWalls) this.partyWalls = readJson(path.join(P.ROOT, 'partyWalls.json'), {}) || {};
    return this.partyWalls;
  }
  isPartyWall(name) {
    const at = this.loadWalls()[String(name || '').toLowerCase()];
    return !!(at && Date.now() - at < PARTY_WALL_MS);
  }

  // The equipped class's rank from the world model; null when it isn't known.
  static classRank(bot) {
    const pts = Hub.classPts(bot);
    return pts === null ? null : require('./skua/swfworld').rankFromPoints(pts);
  }

  // The equipped class's points (null when the avatar is not loaded).
  static classPts(bot) {
    const me = ((bot.client && bot.client.w) || {}).myAvatar || {};
    const cls = (Array.isArray(me.items) ? me.items : []).find((i) => i && i.sES === 'ar' && i.bEquip && Number(i.bEquip) !== 0);
    return cls ? Number(cls.iQty) || 0 : null;
  }

  // Where every character is, for the owner to join them (Discord /where). /goto answers "locked zone" on some maps;
  // /join with the room number works wherever he has the map himself.
  where() {
    return [...this.bots.values()].map((bot) => {
      const w = (bot.client && bot.client.w) || {};
      const loaded = !!(bot.client && bot.client.state && bot.client.state.loaded);
      const area = String(w.strAreaName || '');
      const [map, room] = area.split('-');
      const t = bot.current;
      return { id: bot.id, label: bot.account.label, online: loaded && !!area, server: bot.serverName || null, map: map || null, room: room || null, area: area || null,
        cell: w.strFrame || null, isPublic: area ? crowd.publicArea(area) : null, doing: bot.running ? (t ? t.why || t.type : 'between tasks') : 'stopped' };
    });
  }

  // The class ladder (lib/fightplan.js, the owner 2026-10-16): a boss killing this character in its own Skua script is
  // tried with its careful rotation and other classes first. True while the ladder owns this death (the caller then
  // skips bossDeath / deathCap); a switch restarts the script with the new CoreBots class and mode.
  async fightLadder(bot, killer, now = Date.now()) {
    const t = bot.current;
    // An army script (crew round, 2026-10-28 Nightmare Carnax) syncs every member and handles wipes itself, like a raid:
    // a ladder restart of one member broke the army ("Registered 4/6").
    if (!t || !killer || !killer.name || t.type !== 'script' || t.raid || t.crewScript || t.escort || t.style) return false;
    if (!this.isBoss(bot, killer.hpMax)) return false;
    const w = (bot.client && bot.client.w) || {};
    if (crowd.dieTo(w.strMapName, killer.name)) return false;
    if (Bot.xpMap(w.strMapName) && Hub.classRank(bot) !== null && Hub.classRank(bot) < 10) return false;
    const key = bot.taskKey(t);
    let ctx = { now };
    const f = bot._fight;
    if (!f || f.key !== key || String(f.boss).toLowerCase() !== String(killer.name).toLowerCase()) {
      ctx = await this.ladderCtx(bot, now);
      if (!ctx) return false;
    }
    const r = fightplan.onDeath(bot, killer, key, ctx);
    if (r !== 'switch') return r === 'hold';
    bot._capDeaths = [];
    bot._bossDeaths = [];
    Promise.resolve(bot.restart()).catch(() => null);
    return true;
  }

  // What the ladder needs about the character now: the class it fights with, the slot (solo or farm class), its
  // rank-10 classes and its hand-picked list (settings.bossClasses).
  async ladderCtx(bot, now = Date.now()) {
    const w = (bot.client && bot.client.w) || {};
    const me = w.myAvatar || {};
    const cls = (Array.isArray(me.items) ? me.items : []).find((i) => i && i.sES === 'ar' && i.bEquip && Number(i.bEquip) !== 0);
    if (!cls) return null;
    const owned = fightplan.rank10(await bot.classPoints().catch(() => []));
    let farm = null;
    if (Hub.isGuest(bot)) farm = bot.settings.farmClass || null;
    else { try { const p = require('./classplan').classFor(bot.id, 'farm', owned.map((c) => c.toLowerCase())); farm = p ? p.name : null; } catch (e) { /* solo */ } }
    const slot = farm && String(farm).toLowerCase() === String(cls.sName).toLowerCase() && String(bot.settings.soloClass || '').toLowerCase() !== String(cls.sName).toLowerCase() ? 'farm' : 'solo';
    return { now, start: cls.sName, slot, owned, wanted: bot.settings.bossClasses };
  }

  // Before the first death (the owner 2026-10-19: LR for Avatar Tyndarius, Arcana Invoker for Nightbane): every few seconds
  // of a Skua script, a boss in the character's cell that it beat before with another set-up, or that has a picked
  // class (fightplan.BOSS_PICKS), switches the script to that set-up first. Raids, escorts and help calls keep theirs.
  async preFightTick(bot, now = Date.now()) {
    const t = bot.current;
    if (!t || t.type !== 'script' || t.raid || t.crewScript || t.escort || t.style || bot.assisting) return null;
    const w = (bot.client && bot.client.w) || {};
    const here = (w.monsters || []).filter((m) => m && m.strFrame === w.strFrame && Number(m.intState) !== 0);
    const known = Object.assign({}, fightplan.sharedBook(), fightplan.learned(bot));
    const boss = here.find((m) => fightplan.BOSS_PICKS[String(m.strMonName).toLowerCase()] || known[m.strMonName]);
    if (!boss) return null;
    // A task that just started may still stand in the last task's cell: back from a help call the character is in the
    // caller's boss room, so this saw "Hydra Head 90 ahead" of a forge script and restarted it - 9 of 23 switches on
    // 10-23/24 came right after an assist (Valen's forge-ravenous: 31 starts, 0 finished). In a task's first 2 min the
    // switch needs the script's own step to name that boss.
    const step = String(bot.scriptStepRaw || bot.scriptStep || '').toLowerCase();
    if (t.startedAt && now - t.startedAt < 120000 && !step.includes(String(boss.strMonName).toLowerCase())) return null;
    const f = bot._fight;
    if (f && f.key === bot.taskKey(t) && String(f.boss).toLowerCase() === String(boss.strMonName).toLowerCase()) return null;
    // One switch-before-the-fight restart per task in PRE_SWITCH_GAP: a script meeting bosses in turn went back and
    // forth, and every restart queued for an engine again (2026-10-26 14:04-14:17, Sable's forge-valiance:
    // Azkorath -> Rogue, Dread Fang -> ArchPaladin, Azkorath -> Rogue, 1-4 min engine wait each). After that the
    // death ladder (fightplan.onDeath) decides, as it does for every boss without a pick.
    if (bot._preSwitch && bot._preSwitch.key === bot.taskKey(t) && now - bot._preSwitch.at < PRE_SWITCH_GAP) return null;
    const ctx = await this.ladderCtx(bot, now);
    if (!ctx) return null;
    if (fightplan.preFight(bot, boss.strMonName, bot.taskKey(t), ctx) !== 'switch') return null;
    bot._preSwitch = { key: bot.taskKey(t), at: now };
    Promise.resolve(bot.restart()).catch(() => null);
    return boss.strMonName;
  }

  // Death cap for scripts (DEATH_CAP): the same monster killed this character again and again inside one task.
  deathCap(bot, killer, now = Date.now()) {
    const t = bot.current;
    if (!t || !killer || !killer.name || t.raid || t.crewScript || !(t.type === 'script' || t.style)) return false;
    if (crowd.dieTo(((bot.client && bot.client.w) || {}).strMapName, killer.name)) return false;
    const key = bot.taskKey(t);
    bot._capDeaths = (bot._capDeaths || []).filter((d) => now - d.at < 30 * 60000 && d.key === key);
    if (!bot._capDeaths.length) bot._capPts = Hub.classPts(bot);
    bot._capDeaths.push({ name: killer.name, at: now, key });
    const n = bot._capDeaths.filter((d) => d.name === killer.name).length;
    // A class below rank 10 on the XP maps dies a lot for its first minutes and then stops (Valen, 2026-10-01: Farmer
    // Joe bought ArchPaladin, 8 deaths to Frost Spirit in 3 min while it went from rank 1 to 4, one death in the next
    // 20 min - and Farmer Joe was parked for 24 h behind a "wall"). Three times the room there.
    const w = (bot.client && bot.client.w) || {};
    const fresh = Bot.xpMap(w.strMapName) && Hub.classRank(bot) !== null && Hub.classRank(bot) < 10;
    if (n < DEATH_CAP * (fresh ? 3 : 1) || bot._capping) return false;
    // A class that still gains points while it dies is paying its rank-up cost, not facing a wall (Edda, 2026-10-25: Blaze
    // Binder rank 1 on Ice Storm Arena died 24x in 5 min, three forge goals and ArchPaladin were parked for 24 h, and the class
    // was rank 9 forty minutes later). The count starts again from the points it has now; no gain at all is still a wall.
    if (fresh) {
      const pts = Hub.classPts(bot);
      if (pts !== null && bot._capPts !== null && bot._capPts !== undefined && pts > bot._capPts) {
        bot._capDeaths = []; bot._capPts = pts;
        return false;
      }
    }
    bot._capping = true;
    bot._capDeaths = [];
    const step = `died ${n}x to ${killer.name} in 30 min`;
    // One lucky solo kill (Taro Blademaster, 2026-09-27) must not stand forever: dying this often to it means it is a
    // boss this character struggles with again, so the next time it may call the party (struggle) instead of dying.
    const solo = this.soloBosses(bot);
    if (solo[killer.name] && !fresh) {
      delete solo[killer.name];
      if (bot.file) try { writeJson(bot.file('soloBosses.json'), solo); } catch { /* memory still has it */ }
      bot.journal(`${killer.name} killed me ${n}x in 30 min - my old solo kill of it no longer counts`, 'warn');
    }
    if (t.brain && this.brain && this.brain.park) {
      const what = this.brain.park(bot, t, step, { deaths: true, killer, deathsN: n });
      this.notify(`${bot.account.label} keeps dying`, `${t.why || t.path}: ${step} - parked ${what}`, 'alert');
      // The owner's main never parks quietly (Arcana Invoker, 2026-10-15: parked for a day behind Fiend Champion, no word).
      if (Hub.isGuest(bot) && this.discord && this.discord.enabled) {
        const tried = bot._fight && String(bot._fight.boss).toLowerCase() === String(killer.name).toLowerCase() ? `\nTried: ${bot._fight.steps.slice(0, bot._fight.i + 1).map(fightplan.describe).join(' → ')}` : '';
        this.discord.send(`⚠️ **${bot.account.label} parked a goal**\n${t.why || t.path}\n${step} - parked ${what}${tried}`, { kind: 'alert', key: `dm:mainpark:${bot.id}:${killer.name}`, dm: true });
      }
    } else {
      bot._dropCurrent = true;
      bot.journal(`dropping the order "${t.why || t.path}": ${step}`, 'warn');
    }
    Promise.resolve(bot.restart()).catch(() => null).then(() => { bot._capping = false; });
    return true;
  }

  // The party's line-up for a call (the owner, 2026-10-13: at least one support, then adapt to the boss - lib/partycomp.js).
  // Planned once per call from the members it has when the first of them arrives; late joiners fill what is short.
  async planParty(h) {
    const members = [];
    for (const id of [h.by, ...h.helpers]) {
      const b = this.bots.get(id);
      if (b) members.push({ id, classes: await b.classPoints().catch(() => []) });
    }
    const caller = this.bots.get(h.by);
    const c = caller && caller.client;
    const st = (c && typeof c.fightStats === 'function' ? c.fightStats(h.monster) : null) || {};
    const leaf = c && c.w && c.w.myAvatar && c.w.myAvatar.dataLeaf;
    const past = (this.helpHistory || {})[String(h.monster).toLowerCase()] || null;
    const sh = partycomp.shape(members.length, { name: h.monster, hpMax: h.hpMax || st.hpMax }, { hit: st.hit, ownHp: Number(leaf && leaf.intHPMax) || 0, dps: st.dps }, past);
    const plan = partycomp.assign(sh.roles, members);
    plan.roles = sh.roles;
    plan.why = sh.why;
    this.info(`${h.who}'s ${h.monster} party: ${sh.why} - ${partycomp.describe(plan)}`);
    return plan;
  }
  async partySeat(bot, h) {
    if (!h) return null;
    if (!h.compP) h.compP = this.planParty(h).catch((e) => { this.info(`party line-up failed: ${e.message}`); return null; });
    const plan = await h.compP;
    if (!plan) return null;
    if (!(bot.id in plan.seats)) plan.seats[bot.id] = partycomp.lateSeat(plan.roles, plan.seats, { id: bot.id, classes: await bot.classPoints().catch(() => []) });
    return plan.seats[bot.id];
  }
  // How the last call for a boss went (kills, deaths): a bloody one gets two supports next time.
  recordHelp(h) {
    this.helpHistory = this.helpHistory || {};
    this.helpHistory[String(h.monster).toLowerCase()] = { kills: h.kills || 0, deaths: h.deaths || 0, at: Date.now() };
    // A squad that won clears the boss's "needs everyone" mark, an escalated call that won sets it. A call that began
    // with everyone because of the mark leaves it to run out (7 days), then a squad tries again.
    if (!h.startedFull && this.squadBook) this.squadBook().result(h.monster, { full: !!h.escalated, kills: h.kills || 0, deaths: h.deaths || 0, size: (h.helpers || []).length + 1 });
  }

  // Ends the open help call. `wall`: the party could not kill the boss, so nobody calls for it again for a day.
  // `h`: which call (the latest one when left out - the dashboard's "end the call", older code).
  endHelp(why, wall = false, h = this.help) {
    if (!h || h._closed) return;
    this.closeHelp(h);
    if (wall) {
      this.partyWalls = this.loadWalls();
      this.partyWalls[String(h.monster).toLowerCase()] = Date.now();
      try { writeJson(path.join(P.ROOT, 'partyWalls.json'), this.partyWalls); } catch { /* memory still has it */ }
      this.info(`${why} - calling it off; nobody calls the party for ${h.monster} for 24 h`);
      this.notify(`The party can't kill ${h.monster} yet`, `${why} in ${h.map} - back to their own work`, 'alert');
    }
  }

  // The boss ladder (the owner, 2026-10-09): solo, then the party, then - the last option - a public room with players.
  // Only work the character runs for itself climbs it: not raids/ultras (always private), helpers, or the owner's account.
  canGoPublic(bot) {
    const t = bot.current;
    if (!crowd.LADDER || !t || t.publicStep || t.raid || crowd.isPrivate(t) || Hub.isGuest(bot)) return false;
    if (t.room || ['assist', 'follow', 'gotoPlayer', 'wait', 'idle', 'escort'].includes(t.type)) return false;
    return !(this.settings && this.settings.crowd === false);
  }
  // The party lost to `boss` today: this task goes to Artix and waits there for players (bot task start stamps
  // publicStep, crowd.kindOf -> 'crowd', lib/manners.js waits for 5 players fighting it). For 24 h, like the party wall.
  goPublic(bot, boss) {
    if (!this.canGoPublic(bot)) return false;
    const t = bot.current;
    bot.publicFor = bot.publicFor || new Map();
    bot.publicFor.set(bot.taskKey(t), Date.now() + 24 * 3600000);
    bot.journal(`${boss}: the whole party lost to it today - last option: taking "${t.why || t.path || t.type}" to a public room on ${crowd.CROWD_SERVER} to wait for players`);
    bot.restart();
    return true;
  }

  // The owner's main and a boss it can't solo (the owner 2026-10-15: "if something requires a boss that needs a party ping me
  // and stop"): no party call, no public room - a Discord DM with the boss and the task, then the loop stops by hand
  // (bot.stop(true), so health.check leaves it stopped). Not while it is helping the party or has killed it solo.
  mainNeedsParty(bot, killer, deaths) {
    const t = bot.current || {};
    if (['assist', 'follow', 'escort', 'crewHunt'].includes(t.type) || t.raid) return null;
    // One old solo kill does not stand once the class ladder has tried every set-up (Fiend Champion, 2026-10-15:
    // the main had killed it once, then died 8x and parked Arcana Invoker for a day without a word to the owner).
    if (this.soloBosses(bot)[killer.name] && !fightplan.exhausted(bot, killer.name)) return null;
    const tried = fightplan.exhausted(bot, killer.name) ? ` (tried ${bot._fight.steps.map(fightplan.describe).join(', ')})` : '';
    const what = (t.why || t.path || t.type || 'its task') + tried;
    // A daily (NSoD Icewing...) is not worth the whole loop: check-up 2026-10-15 found the main idle 4.5 h after the
    // NSoD daily. Ping him, drop that daily for today and go on with the goals.
    if (Hub.dailyWork(t)) {
      bot.journal(`died ${deaths}x to ${killer.name} - this daily needs a party; skipping it for today and going on`);
      this.notify(`${bot.account.label} skipped a daily`, `${killer.name} (${what}) needs a party - skipped for today`, 'alert');
      if (this.discord && this.discord.enabled) {
        this.discord.send(`⚠️ **${bot.account.label}**: ${killer.name} needs a party - ${what}\nSkipped that daily for today; it keeps farming its goals.`,
          { kind: 'alert', key: `dm:mainparty:${bot.id}:${killer.name}`, dm: true });
      }
      if (t.type === 'daily' && this.brain && this.brain.today) {
        const day = this.brain.today(bot);
        this.brain.dailyFailed(day, t.name);
        day.dailyFails[t.name] = Math.max(day.dailyFails[t.name], 3);   // no 2 h retry today
        if (this.brain.saveState) this.brain.saveState(bot);
      }
      bot.skipped = bot.skipped || new Map();
      bot.skipped.why = `${killer.name} needs a party - skipped for today`;
      bot.skipped.set(bot.taskKey(t), Date.now() + 20 * 3600000);
      bot._dropCurrent = true;
      bot.restart();
      return null;
    }
    if (this.takeRoute(bot, killer)) return null;
    // Never a stop (the owner 2026-10-25, "you cant tell me a bot is stuck at something"): the main sat stopped for 12 h after
    // "needs a party". Now the task rests 6 h and the autopilot goes on with its other goals; the party call (mainCallsParty)
    // came first, so this is only reached when the whole party lost to the boss too.
    bot.journal(`died ${deaths}x to ${killer.name} - the party could not carry it either; resting "${what}" for 6 h and going on with other work`);
    this.notify(`${bot.account.label} rests a boss`, `${killer.name} (${what}) - rests 6 h, the main goes on with other goals`, 'alert');
    if (this.discord && this.discord.enabled) {
      this.discord.send(`⚠️ **${bot.account.label}**: ${killer.name} beat the party too - ${what}\nResting that task for 6 h; it keeps working on its other goals.`,
        { kind: 'alert', key: `dm:mainparty:${bot.id}:${killer.name}`, dm: true });
    }
    bot.skipped = bot.skipped || new Map();
    bot.skipped.why = `${killer.name} beat the party - resting 6 h`;
    bot.skipped.set(bot.taskKey(t), Date.now() + 6 * 3600000);
    // The owner's own order rests in the queue, it is not thrown away: Kathool Adept, the Carnax solo and ArchMage all
    // vanished from the main's queue this way on 2026-10-27 (Voice in the Sea, Nightmare Carnax).
    if (!t.brain) t.restUntil = Date.now() + 6 * 3600000;
    else bot._dropCurrent = true;
    bot.restart();
    return null;
  }

  // The main in trouble calls the party exactly like a bot (the owner 2026-10-25). Same vetoes as the bots' struggle: an old
  // solo kill counts for the first two deaths only, one call at a time, a boss the party already lost to is a wall.
  async mainCallsParty(bot, killer, deaths) {
    const t = bot.current || {};
    if (['assist', 'follow', 'escort', 'crewHunt'].includes(t.type) || t.raid) return null;
    this.expireHelps();
    if (this.helpOf(bot)) return null;                                          // already in a call
    if (this.isPartyWall(killer.name)) return this.mainNeedsParty(bot, killer, deaths);
    if (this.helpCoolingFor(killer.name)) return null;
    if (this.soloBosses(bot)[killer.name] && !fightplan.exhausted(bot, killer.name)) {
      if (deaths < SOLO_VETO_DEATHS) { bot.journal(`died ${deaths}x to ${killer.name}, but I have killed it solo before - not calling the party`); return null; }
      this.forgetSolo(bot, killer.name);
    }
    return this.requestHelp(bot, { map: await bot.map(), cell: killer.cell || await bot.cell(), monster: killer.name, hpMax: killer.hpMax, why: `died ${deaths}x - the main calls the party too` });
  }

  // A boss the class ladder lost to, on a step that farms an item with a second way to it (lib/boss-routes.json; the owner
  // 2026-10-20: Nulgath beat the main's whole ladder on ArchMage's Mortal Coil, which 4 Roentgenium of Nulgath also
  // buy): switch the account's route file on and restart the script, whose Seraph fix then takes the long way.
  takeRoute(bot, killer) {
    const t = bot.current || {};
    if (t.type !== 'script' || !bot.dir) return false;
    const r = bossroutes.routeFor(killer.name, bot.scriptStepRaw || bot.scriptStep);
    if (!r || bossroutes.active(bot.dir)[r.boss]) return false;   // already on and still meeting the boss: usual rules
    try { bossroutes.enable(bot.dir, r); } catch (e) { bot.journal(`could not switch the ${r.boss} route on: ${e.message}`, 'warn'); return false; }
    bot.journal(`${r.boss} beat every set-up - getting ${r.items.join(', ')} another way: ${r.how}`, 'warn');
    this.notify(`${bot.account.label} goes around ${r.boss}`, `${r.items.join(', ')}: ${r.how}`, 'info');
    bot.restart();
    return true;
  }

  // An ultra raid boss (ultraready.BOSSES) is the raid's job, never a help call.
  static raidBoss(name) {
    const n = String(name || '').toLowerCase();
    return !!n && ultraready.BOSSES.some((b) => [b.monster, b.name].some((x) => x && x.toLowerCase() === n));
  }

  async struggle(bot, killer, deaths) {
    // Raid deaths are the raid watch's business. A death that landed seconds after the Ultra Speaker raid was called
    // off sent the whole party back into ultraspeaker for a 25-min help call on The First Speaker (2026-10-23 21:02),
    // and the same late death could have stopped the owner's main (mainNeedsParty) or sent a task public (goPublic).
    if (Hub.raidBoss(killer && killer.name) || (this.raid && this.raid.members.includes(bot.id))) return null;
    // The owner's main (a helper on autopilot) calls the party like the bots do (2026-10-25: "how is my main stuck? ... they all
    // help each other so no one gets stuck"); only after the party lost to the boss too does he park it (mainNeedsParty).
    // A guest that is not a helper (an account he added for orders only) still never calls.
    if (Hub.isGuest(bot)) return Hub.helper(bot) && !(this.settings && this.settings.mainCallsParty === false) ? this.mainCallsParty(bot, killer, deaths) : this.mainNeedsParty(bot, killer, deaths);
    // One call per character; several characters can each have one (Seraph 5: a squad each, settings.maxHelpCalls).
    this.expireHelps();
    if (this.helpOf(bot)) return null;
    if (this.isPartyWall(killer.name)) {
      if (this.takeRoute(bot, killer)) return null;
      // The ladder's last step (2026-10-09): the party lost to it, so this task waits for players in a public room.
      if (this.goPublic(bot, killer.name)) return null;
      bot.journal(`died ${deaths}x to ${killer.name} - the whole party could not kill it today either, not calling them`);
      return null;
    }
    if (this.helpCoolingFor(killer.name)) return null;
    if (this.raid && this.raid.members.includes(bot.id)) return null;         // a raid already is the whole party
    if (bot.current && (bot.current.type === 'assist' || bot.current.type === 'crewHunt')) return null;
    // The owner, 2026-10-17: "the party help each other in everything" - me time and events call the party too (this
    // replaces his 09-28 "no party calls for looks"; Nova's last main piece, Imperial Noxus Tassels, rested for days
    // after 6 solo deaths). The per-boss cooldown and party walls still keep one boss from calling all day.
    const t = bot.current || {};
    // Dailies and Lord of Order have their own public-room rules (lib/manners.js) and retry windows. In the party's own
    // room (manners partyFirst sent it there, 2026-10-05) a daily boss is the party's job like any other.
    if (Hub.dailyWork(t) && crowd.publicArea(((bot.client && bot.client.w) || {}).strAreaName)) return null;
    // A boss that needs a crowd (Desolich, 8.2M HP): four more characters of this size would not change it. Not with
    // the ladder (the owner, 2026-10-09): HP is a guess, the party tries first and its result decides.
    const w0 = (bot.client && bot.client.w) || {};
    const myMax = Number(w0.myAvatar && w0.myAvatar.dataLeaf && w0.myAvatar.dataLeaf.intHPMax) || 0;
    if (!crowd.LADDER && myMax && Number(killer.hpMax) > crowd.MANNERS.hopelessHpRatio * myMax) return null;
    if (this.soloBosses(bot)[killer.name]) {
      // An old solo kill vetoes the call for the first two deaths only (a bad pull). From the third the boss has beaten
      // this character again (Sable, 2026-10-25: Mutated Void Dragon killed her 8x in 4 min after the whole class
      // ladder lost, "not calling the party" every time, then a 24 h park): the old kill no longer counts and the party comes.
      if (deaths < SOLO_VETO_DEATHS) {
        bot.journal(`died ${deaths}x to ${killer.name}, but I have killed it solo before - not calling the party`);
        return null;
      }
      this.forgetSolo(bot, killer.name);
    }
    const others = bot.client && bot.client.playersHere ? bot.client.playersHere() : [];
    const ours = new Set();
    for (const b of this.bots.values()) ours.add(String(await b.name().catch(() => b.id)).toLowerCase());
    const strangers = others.filter((n) => !ours.has(n));
    if (strangers.length) {
      bot.journal(`died ${deaths}x to ${killer.name} - ${strangers.length} player(s) here are helping, staying`);
      return null;
    }
    return this.requestHelp(bot, { map: await bot.map(), cell: killer.cell || await bot.cell(), monster: killer.name, hpMax: killer.hpMax, why: `died ${deaths}x, never killed it solo` });
  }

  // The 5 min pause after a call is for that boss only (2026-10-12): the NSoD daily calls the party for Warlord Icewing
  // and meets Hydra Head 90 a minute later; a cooldown for every boss silently dropped that second call, and Sable
  // and Nova died alone until the daily gave up (a week of NSoD failures).
  // A kill on a farm call: true while the party stays for more. The caller's count is checked in the background and
  // ends the call when it has them all; until then each kill buys HELP_FARM_IDLE more (at most HELP_FARM_MAX).
  helpFarmKill(h, now = Date.now()) {
    // Every character in the room reports the same kill (four reports per kill: "40 kills" were 11 on 2026-10-13).
    if (h.lastKillAt && now - h.lastKillAt < 5000) return true;
    h.lastKillAt = now;
    h.kills = (h.kills || 0) + 1;
    h.deathsSinceKill = 0;
    const need = h.farm.want - h.farm.have;
    if ((!h.farm.untilOwned && h.kills >= need) || now >= h.hardUntil) return false;
    h.until = Math.min(h.hardUntil, Math.max(h.until, now + HELP_FARM_IDLE));
    if (h.kills === 1 || h.kills % 10 === 0) this.info(`${h.who}'s ${h.monster} farm call: ${h.kills} kill(s), the party stays (${h.farm.untilOwned ? `until ${h.farm.item} drops` : `${h.farm.item} ${h.farm.have + h.kills}/${h.farm.want}`})`);
    const by = this.bots.get(h.by);
    if (by && typeof by.count === 'function') {
      Promise.resolve(by.count(h.farm.item)).then((n) => {
        if (!h._closed && Number(n) >= h.farm.want) {
          this.info(`${h.who} has ${h.farm.want} ${h.farm.item} - the ${h.monster} farm call is over`);
          this.endHelp(`${h.who} has all the ${h.farm.item}`, false, h);
        }
      }).catch(() => null);
    }
    return true;
  }

  helpCoolingFor(monster, now = Date.now()) {
    if (!this._helpCooldown) return false;
    const k = String(monster || '').toLowerCase();
    const at = this._helpCooldowns && this._helpCooldowns[k];
    if (at) return now - at < 5 * 60000;
    if (now - this._helpCooldown >= 5 * 60000) return false;
    return !this._helpCooldownBoss || this._helpCooldownBoss === k;
  }

  // A hunt gave up on a boss ("too strong: died Nx"): an old solo kill of it no longer counts, so next time the party is
  // called. deathCap does this at 8 deaths, but hunts give up at giveUpDeaths (3-6) first, so Valen (solo kill 10-05)
  // and Oren (10-07) failed the NSoD daily at Hydra Head 90 every day without calling anyone (2026-10-12).
  forgetSolo(bot, monster) {
    const solo = this.soloBosses(bot);
    const name = Object.keys(solo).find((k) => k.toLowerCase() === String(monster || '').toLowerCase());
    if (!name) return false;
    delete solo[name];
    if (bot.file) try { writeJson(bot.file('soloBosses.json'), solo); } catch { /* memory still has it */ }
    bot.journal(`gave up on ${name} - my old solo kill of it no longer counts, next time I call the party`, 'warn');
    return true;
  }

  // Every character (the one in trouble too) drops what it is doing, goes to the quiet server and the party's room,
  // kills the boss together, and carries on with its own work (runNow puts an interrupted order back behind the call;
  // brain work is picked again by the brain).
  async requestHelp(bot, info) {
    const now = Date.now();
    this.expireHelps(now);
    const mine = this.helpOf(bot);
    if (mine) return mine;
    const open = this.helpCalls(now);
    const maxCalls = Number(this.settings.maxHelpCalls) || MAX_HELP_CALLS;
    // Said once per 5 min: struggle asks again on every death.
    const alone = (why) => { if (!bot._aloneSaid || now - bot._aloneSaid > 5 * 60000) { bot._aloneSaid = now; bot.journal(`${info.monster}: ${why} - fighting on alone for now`); } return null; };
    if (open.length >= maxCalls) return alone(`${open.length} help calls are already open`);
    if (this.helpCoolingFor(info.monster, now)) return null;
    // A room that holds one player (chaosrealm, the 12 Lords gauntlet): nobody can come, and a helper who got in first
    // took the caller's own seat - Edda killed Alteon 60 times in there while Vexa stood outside (2026-10-26).
    if (this.squadBook && Number(this.squadBook().cap(crowd.baseMap(info.map))) === 1) return alone(`${crowd.baseMap(info.map)} holds one player - nobody can come`);
    const room = this.settings.levelParty.room;
    const h = {
      id: `${bot.id}-${now}`, by: bot.id, who: bot.account.label, server: crowd.QUIET_SERVER,
      map: crowd.baseMap(info.map), room, cell: info.cell, monster: info.monster,
      at: now, until: now + 25 * 60000, helpers: [], hpMax: Number(info.hpMax) || null,
    };
    // Listed at once: the caller can't open a second call, and its squad's picks are reserved, during the awaits below.
    this.helps.set(h.id, h);
    this.help = h;
    // The caller's Skua step farms this boss many times over ("Killing Legion Lich Lord for item: \"Sapphire Orb\" 13/100",
    // Forge: Lament): the call ends at the first kill, so the caller was alone again a minute later, died 8x and parked
    // the goal for a day - one orb per call (2026-10-06..10-11). A farm call keeps the party there until the caller has
    // them all, no kill for HELP_FARM_IDLE, or HELP_FARM_MAX.
    // A step that names no monster ("(_KillForItem) Farming Sapphire Orb (13/26)") counts too when the caller farms it on
    // the boss's map: Valen's Forge: Elysium call ended at the first Legion Lich Lord kill and parked for a day (2026-10-20).
    const step = String(bot.scriptStepRaw || bot.scriptStep || '');
    const own = bot.current && bot.current.type === 'script' ? Hub.stepItem(step) : null;
    const f = bot.farm;
    const unnamed = !!(own && !/for item:/i.test(step) && (!f || (!f.monster
      && (!f.map || crowd.baseMap(f.map) === crowd.baseMap(info.map)))));
    if (own && own.want - own.have > 1 && (step.toLowerCase().includes(String(info.monster).toLowerCase()) || unnamed)) {
      h.farm = { item: own.item, want: own.want, have: own.have };
      h.hardUntil = now + HELP_FARM_MAX;
      h.kills = 0;
    }
    // A farm asked for by hand (POST /help with item + want): stays until the caller has them.
    if (!h.farm && info.farm && info.farm.item && info.farm.want > (info.farm.have || 0)) {
      h.farm = { item: info.farm.item, want: info.farm.want, have: info.farm.have || 0 };
      h.hardUntil = now + HELP_FARM_MAX;
      h.kills = 0;
    }
    // A wish (a look piece) is usually a rare drop: the party stays until the caller owns it, not one kill (2026-10-17).
    const cur = bot.current || {};
    if (!h.farm && cur.type === 'wish' && (cur.wish || cur.item)) {
      h.farm = { item: cur.wish || cur.item, want: 1, have: 0, untilOwned: true };
      h.hardUntil = now + HELP_FARM_MAX;
      h.kills = 0;
    }
    // One rare drop ("Killing Malxas for item: \"Wings Of Destruction\" 0/1", Forge cape): the party killed Malxas, left,
    // and Vexa called again - 77 calls on 2026-10-26. A 0/1 step is a farm call that lasts until the item is there.
    const named = step.toLowerCase().includes(String(info.monster).toLowerCase());
    if (!h.farm && own && own.want === 1 && own.have === 0 && named) {
      h.farm = { item: own.item, want: 1, have: 0, untilOwned: true };
      h.hardUntil = now + HELP_FARM_MAX;
      h.kills = 0;
    }
    // A guard (Seraph 5): the caller's Skua script is on this boss in the party room, so it keeps running - quests,
    // drops and turn-ins stay with the script and its engine - and the squad fights next to it until the step moves past
    // the boss (helpTick). Before, the caller stopped its script for every call and started it again after each kill.
    const area = String((bot.client && bot.client.w && bot.client.w.strAreaName) || '').toLowerCase();
    if (cur.type === 'script' && !cur.raid && (named || (h.farm && unnamed)) && area === `${h.map}-${room}` && this.settings.helpGuard !== false) {
      h.guard = true;
      h.kills = h.kills || 0;
      h.hardUntil = h.hardUntil || now + HELP_GUARD_MAX;
    }
    // Nobody far below the caller (2026-10-21, seven characters): a level-2 newcomer sent to a level-100 boss only dies,
    // and loses its own levelling to every call. The veterans still answer the newcomers' calls.
    h.minLevel = await this.helpMinLevel(bot);
    // Who goes: a squad (lib/squad.js), or everyone when this boss needed everyone lately or squads are off.
    const cands = await this.helpCandidates(bot, h);
    const book = this.squadBook();
    const cap = book.cap(h.map);
    h.cap = cap;
    h.full = h.startedFull = this.settings.squads === false || book.needsAll(info.monster, now);
    let send;
    if (h.full) send = cands.map((b) => b.id);
    else {
      const size = Number.isFinite(Number(this.settings.squadSize)) ? Number(this.settings.squadSize) : squad.SIZE;
      const callerLevel = await this.levelOf(bot);
      const callerSupport = squad.hasSupport(await Promise.resolve(bot.classPoints ? bot.classPoints() : []).catch(() => []));
      send = squad.pick(await this.squadInfo(cands, now), { size, callerLevel, callerSupport, cap: cap ? cap - 1 : null });
      // Nobody left over: the squad is everyone.
      if (send.length >= cands.length) h.full = true;
    }
    if (h.full && cap) send = send.slice(0, Math.max(0, cap - 1));
    // Another call may have taken one of them while this one was thinking.
    send = send.filter((id) => !this.helpCalls(now).some((x) => x !== h && (x.by === id || x.helpers.includes(id))));
    if (!send.length && open.length) {
      // Everyone who could come is in another call: no empty call (it would only hold the caller in the party room).
      this.helps.delete(h.id);
      const left = [...this.helps.values()].filter((x) => !x._closed);
      this.help = left.length ? left[left.length - 1] : null;
      return alone('the party is busy in other calls');
    }
    const who = h.full ? 'everyone' : `a squad (${send.join(', ') || 'nobody free'})`;
    this.info(`${bot.account.label} can't kill ${info.monster} in ${info.map} (${info.why}) - ${who} to ${h.server} ${h.map}-${room}${h.farm ? ` (farm call: ${h.farm.item} ${h.farm.have}/${h.farm.want})` : ''}`);
    this.notify(`${bot.account.label} needs the party`, `${info.monster} in ${info.map} - ${who} meets on ${h.server} ${h.map}-${room}`, 'alert');
    for (const id of send) {
      const b = this.bots.get(id);
      h.helpers.push(id);
      this.keepEngineTurn(b, now);
      Promise.resolve(b.runNow(this.assistTaskFor(b, h))).catch(() => null);
    }
    if (h.guard) bot.journal(`the party is coming to guard me against ${h.monster} - my script keeps going`);
    else if (!(this.raid && this.raid.members.includes(bot.id)) && !this.assistFor(bot)) Promise.resolve(bot.runNow(this.assistTaskFor(bot, h))).catch(() => null);
    return h;
  }

  // A kill on a guard call (requestHelp h.guard): the squad stays while the caller's script is still on this boss
  // (helpTick ends it once the step moves on). A farm guard also ends when the caller holds the item.
  helpGuardKill(h, now = Date.now()) {
    if (h.lastKillAt && now - h.lastKillAt < 5000) return true;
    h.lastKillAt = now;
    h.kills = (h.kills || 0) + 1;
    h.deathsSinceKill = 0;
    const caller = this.bots.get(h.by);
    if (caller) caller._capDeaths = [];   // the party's kill answers the deaths before it (deathCap)
    if (now >= h.hardUntil) return false;
    h.until = Math.min(h.hardUntil, Math.max(h.until, now + HELP_FARM_IDLE));
    if (h.kills === 1 || h.kills % 10 === 0) this.info(`${h.who}'s ${h.monster} guard: ${h.kills} kill(s), the squad stays while ${h.who}'s script is on it`);
    if (h.farm && caller && typeof caller.count === 'function') {
      Promise.resolve(caller.count(h.farm.item)).then((n) => {
        if (!h._closed && Number(n) >= h.farm.want) this.endHelp(`${h.who} has ${h.farm.want} ${h.farm.item}`, false, h);
      }).catch(() => null);
    }
    return true;
  }

  // Is the guarded caller still on the boss? Its live Skua step names the boss (or the farm item), on the boss's map.
  guardOn(h) {
    const c = this.bots.get(h.by);
    if (!c || !c.running || !c.current || c.current.type !== 'script') return false;
    const map = String((c.client && c.client.w && c.client.w.strMapName) || '').toLowerCase();
    if (map && map !== String(h.map).toLowerCase()) return false;
    const step = String(c.scriptStepRaw || c.scriptStep || '').toLowerCase();
    return step.includes(String(h.monster).toLowerCase()) || !!(h.farm && step.includes(String(h.farm.item).toLowerCase()));
  }

  // The characters that may answer a call from `caller` (not the caller): running, free of raids, dailies and crews,
  // not far below the caller (h.minLevel). The owner's main only as a helper (accounts.json helper:true).
  async helpCandidates(caller, h) {
    const out = [];
    for (const b of this.bots.values()) {
      if (b === caller) continue;
      if (Hub.isGuest(b) && !Hub.helper(b)) continue;
      if (Hub.prototype.mainOnOrder.call(this, b)) continue;                      // The owner's own order first
      if (!b.running || b.paused || (b.account.status && b.account.status !== 'active')) continue;
      if (this.raid && this.raid.members.includes(b.id)) continue;
      if (this.assistFor(b)) continue;                                          // busy helping the owner's main
      if (Hub.dailyWork(b.current)) continue;                                   // dailies first (LoO lost a morning to calls)
      if (this.crew && this.crew.phase === 'stage' && this.crew.members.includes(b.id)) continue;   // in the crew's room
      if (h.minLevel) { const l = await this.levelOf(b); if (l && l < h.minLevel) continue; }
      if (h.helpers.includes(b.id)) continue;
      if (this.helpCalls().some((x) => x !== h && (x.by === b.id || x.helpers.includes(b.id)))) continue;   // in another call
      out.push(b);
    }
    return out;
  }

  // What lib/squad.js needs to know about each candidate: how busy it is, how strong, and whether it has a support class.
  async squadInfo(bots, now = Date.now()) {
    const seats = Object.keys(ultraready.SEATS);
    return Promise.all(bots.map(async (b) => {
      const classes = await Promise.race([
        Promise.resolve(b.classPoints ? b.classPoints() : []).catch(() => []),
        new Promise((r) => setTimeout(() => r([]), 8000).unref()),
      ]);
      const since = this.engineSince && this.engineSince.get(b.id);
      return {
        id: b.id,
        level: await this.levelOf(b),
        waiting: !!(this.engineWaiting && this.engineWaiting.has(b.id)),
        engine: !!(this.engineBusy && this.engineBusy.has(b.id)),
        heldMs: since ? now - since : null,
        task: b.current ? b.current.type : null,
        guest: Hub.isGuest(b),
        support: squad.hasSupport(classes),
        rank: seats.indexOf(b.id) < 0 ? 99 : seats.indexOf(b.id),
      };
    }));
  }

  squadBook() { return this._squadBook || (this._squadBook = new squad.SquadBook()); }

  // The squad is losing or stalling: everyone else who can come, comes (h.full). Deaths for the party wall count again
  // from here, so the whole party gets its full share of tries before the boss is called a wall.
  async escalateHelp(why, now = Date.now(), h = this.help) {
    if (!h || h.full !== false || h._closed) return null;
    h.full = true;
    h.escalated = now;
    h.deathsAtFull = h.deaths || 0;
    const caller = this.bots.get(h.by);
    const cands = caller ? await this.helpCandidates(caller, h) : [];
    if (h._closed) return null;
    let room = h.cap ? Math.max(0, h.cap - 1 - h.helpers.length) : Infinity;
    const sent = [];
    for (const b of cands) {
      if (room <= 0) break;
      room--;
      h.helpers.push(b.id);
      sent.push(b.id);
      this.keepEngineTurn(b, now);
      Promise.resolve(b.runNow(this.assistTaskFor(b, h))).catch(() => null);
    }
    this.info(`${h.who}'s ${h.monster} squad needs more (${why}) - calling ${sent.length ? sent.join(', ') : `nobody else (${h.cap && room <= 0 ? 'the room is full' : 'everyone is busy'})`}`);
    return sent;
  }

  // Every 30 s: a squad that has not killed its boss after squad.ESCALATE_MS (or a farm squad with no kill for that long)
  // calls everyone.
  async helpTick(now = Date.now()) {
    this.expireHelps(now);
    const out = [];
    for (const h of this.helpCalls(now)) {
      // A guard ends a minute after the caller's script left the boss (its step moved on, it changed map or stopped).
      if (h.guard) {
        if (this.guardOn(h)) h.offSince = null;
        else if (!h.offSince) h.offSince = now;
        else if (now - h.offSince >= GUARD_OFF_MS) {
          this.info(`${h.who} has moved on from ${h.monster} - the squad goes back to its own work`);
          this.endHelp(`${h.who} moved on from ${h.monster}`, false, h);
          continue;
        }
      }
      if (h.full !== false) continue;   // false = a squad (calls made by hand count as everyone)
      const since = h.lastKillAt || h.at;
      if (now - since < squad.ESCALATE_MS) continue;
      out.push(await this.escalateHelp(h.kills ? `no kill for ${Math.round((now - since) / 60000)} min` : `no kill after ${Math.round((now - h.at) / 60000)} min`, now, h));
    }
    return out;
  }

  assistTaskFor(bot, h) {
    const mine = bot.id === h.by;
    return {
      type: 'assist', id: h.id, who: h.who, server: h.server, map: h.map, room: h.room, cell: h.cell, pad: 'Left', monster: h.monster,
      minutes: Math.max(5, Math.round((h.until - Date.now()) / 60000)), why: mine ? `the party is helping me with ${h.monster}` : `helping ${h.who} with ${h.monster}`,
    };
  }

  // A character that came online (or restarted) while a call is open joins it too.
  helpTask(bot) {
    this.expireHelps();
    if (this.helpOf(bot)) return null;
    if (Hub.isGuest(bot) && !Hub.helper(bot)) return null;
    if (Hub.prototype.mainOnOrder.call(this, bot)) return null;                   // The owner's own order first
    // A squad call (lib/squad.js) takes nobody else until it calls everyone; a room at its limit takes nobody.
    // Never a call this character already could not get into (2026-10-26 22:32-23:19: Vexa's Alteon call in the
    // one-seat chaosrealm handed six of ours - the main too - straight back to the call they had just left, ~1 join a
    // second each, 21,000 "room is full" refusals in 47 min). The room book counts as soon as it learns the limit.
    const book = this.squadBook ? this.squadBook() : null;
    const h = this.helpCalls().find((x) => {
      if (x.full === false || (x.unreachable || []).includes(bot.id)) return false;
      const cap = x.cap || (book && book.cap(x.map));
      return !(cap && x.helpers.length + 1 >= cap);
    });
    if (!h) return null;
    // A crew member between two stage tasks has no task for a moment: it took someone else's open call and left the crew
    // (2026-10-25 19:21, three veterans lost mid NSoD). The crew is the party's work while it runs.
    if (this.crew && this.crew.phase === 'stage' && this.crew.members.includes(bot.id)) return null;
    if (bot.current && bot.current.type === 'assist') return null;
    if (this.assistFor(bot) || (this.raid && this.raid.members.includes(bot.id))) return null;
    if (Hub.dailyWork(bot.current)) return null;
    if (h.minLevel && (this._levels || {})[bot.id] < h.minLevel) return null;   // last level seen (helpTask is sync)
    h.helpers.push(bot.id);
    return this.assistTaskFor(bot, h);
  }

  // The lowest level that may answer this caller's help call: levelParty.maxGap (25) below it. 0 = anyone.
  async helpMinLevel(caller) {
    const gap = Number((this.settings.levelParty || {}).maxGap) || 25;
    const lvl = await this.levelOf(caller);
    return lvl > gap ? lvl - gap : 0;
  }
  async levelOf(bot) {
    const lvl = Number(await Promise.resolve(bot.level ? bot.level() : 0).catch(() => 0)) || 0;
    if (lvl) (this._levels = this._levels || {})[bot.id] = lvl;
    return lvl || (this._levels || {})[bot.id] || 0;
  }

  // A daily, a daily Skua script or a recurring one (Lord of Order): not interrupted for someone else's help call.
  static dailyWork(t) {
    if (!t) return false;
    return t.type === 'daily' || t.type === 'crewHunt' || !!t.crewScript || !!t.recurring || /(^|\/)Dailies\/|Daily-Classes\//i.test(String(t.path || '').replace(/\\/g, '/'));
  }

  // This character is in the caller's room (the caller itself always is). Unknown rooms count as the same one.
  inCallerRoom(bot, h) {
    if (!h || bot.id === h.by || !this.clients || typeof this.clients.get !== 'function') return true;
    const area = (id) => { const c = this.clients.get(id); return String((c && c.w && c.w.strAreaName) || '').toLowerCase(); };
    const mine = area(bot.id); const theirs = area(h.by);
    return !mine || !theirs || mine === theirs;
  }

  // A helper could not join the call's map. It leaves the call; when nobody but the caller is left (or the caller itself
  // can't get back in), the call ends and the boss gets the 24 h party wall, so it is not called again all day.
  // A full room (ROOM_FULL from bot.join) is not a map nobody can enter: the ones inside fight on, no wall.
  helpUnreachable(bot, task, why, full = false) {
    const h = this.helpById(task.id);
    if (!h) return;
    h.unreachable = h.unreachable || [];
    if (!h.unreachable.includes(bot.id)) h.unreachable.push(bot.id);
    bot.journal(`can't get into ${h.map} (${why}) - leaving ${h.who}'s ${h.monster} call`, 'warn');
    if (full) {
      // Out of the squad, so another call can have it at once.
      h.helpers = h.helpers.filter((id) => id !== bot.id);
      if (bot.id === h.by) this.endHelp(`${h.who} can't get back into the full ${h.map} room`, false, h);
      return;
    }
    const left = h.helpers.filter((id) => !h.unreachable.includes(id));
    if (bot.id === h.by || !left.length) this.endHelp(`nobody can join ${h.map} for ${h.who}'s ${h.monster}`, true, h);
  }

  // "Room join failed, destination room is full" (bot.join): remember how many of ours that room took, so calls and
  // escorts never send more than fit (squad.SquadBook rooms). 10-26: chaosrealm-13579 refused 55 joins in a day, each
  // one 80 s of retries, and three in a row logged the character out and back in.
  roomFull(bot, map, area) {
    const target = String(area || '').toLowerCase();
    let ours = 0;
    for (const [id, c] of this.clients || []) {
      if (id === bot.id) continue;
      if (String((c && c.w && c.w.strAreaName) || '').toLowerCase() === target) ours++;
    }
    // Only a private room counts: in a public one strangers fill seats we can't see.
    const cap = ours && target && !crowd.publicArea(target) ? this.squadBook().roomFull(map, ours) : null;
    this.info(`${bot.account.label}: ${target || map} is full${ours ? ` with ${ours} of ours - ${map} rooms take ${cap}` : ''}`);
    // The calls already open on that map take nobody past it either (a call keeps the cap it started with otherwise).
    if (cap) for (const h of this.helpCalls ? this.helpCalls() : []) if (h.map === crowd.baseMap(map) && (!h.cap || cap < h.cap)) h.cap = cap;
    return cap;
  }

  helpDone(bot, task, ok) {
    const h = this.helpById(task.id);
    if (!h) return;
    this.info(`${bot.account.label} is done with the ${task.monster} call${ok ? '' : ' (time ran out)'}`);
  }

  // ---------------- stuck watchdog ----------------
  // Runs every minute, but a tick can take longer (pre-emption dry runs load banks): overlapping ticks restarted the
  // same bot twice. A tick that finds the previous one still running is skipped.
  async watchdog() {
    if (this._watching) return;
    this._watching = true;
    try { await Hub.prototype.watchdogTick.call(this); } finally { this._watching = false; }
  }

  // New free-AC scripts in the Skua library (freegifts.discover): one DM to the owner per script version, so a claim that
  // isn't in lib/freegifts.json yet is added before its event ends (the owner 2026-10-13: "make sure they never miss those").
  freeAcWatch(found = null) {
    try { found = found || freegifts.discover(); } catch (e) { return []; }
    const seen = (this.settings.freeAcSeen = this.settings.freeAcSeen || {});
    const fresh = found.filter((f) => seen[f.script] !== f.version);
    for (const f of fresh) {
      seen[f.script] = f.version;
      this.info(`free AC watch: ${f.script} (${f.name}) looks like a free-AC claim the bots don't run yet`);
      this.notify('Possible free ACs', `The Skua library has "${f.name}" (${f.script}). It looks like a free-AC claim and the bots don't run it yet - ask Claude to add it to the free gifts.`, 'news');
    }
    if (fresh.length) this.saveSettings();
    return fresh;
  }

  async watchdogTick() {
    const now = Date.now();
    if (this.raidTick) await this.raidTick(now).catch((e) => this.info(`raid: ${e.message}`));
    if (typeof this.freeAcWatch === 'function' && (!this._freeAcAt || now - this._freeAcAt > 6 * 3600000)) { this._freeAcAt = now; this.freeAcWatch(); }
    for (const bot of this.bots.values()) {
      const s = bot.stats;
      const t = bot.current;
      const progress = s.kills + s.quests + s.drops;
      const w = bot._watch || (bot._watch = { progress, at: now, samples: [], restarts: [] });
      // A raid member waits for the army and fights in long quiet stretches; the raid's own 3 h limit (raidTick) ends
      // a stuck one for all four. Restarting one member alone would only send it back into the sync wait.
      if (t && (t.raid || t.crewScript)) { w.at = now; w.progress = progress; continue; }
      // "Farm until I have N" (dashboard orders): the order ends the moment the backpack + bank hold enough.
      if (t && t.untilHave && t.untilHave.item && bot.running) {
        const have = await Hub.held(bot, t.untilHave.item).catch(() => 0);
        if (have >= Number(t.untilHave.qty || 1)) {
          bot.journal(`have ${have} ${t.untilHave.item} (wanted ${t.untilHave.qty || 1}) - order done`);
          bot._dropCurrent = true;
          bot._untilDone = t;
          bot.restart();
          w.at = now;
          continue;
        }
      }
      w.samples = w.samples.filter((x) => now - x.t < 11 * 60000).concat({ t: now, kills: s.kills });
      // Scripts have no time limit, so every 10 min the brain is asked whether something more important is due
      // (dailies, a live event, the week's content, a full backpack). The script is stopped and carries on after.
      if (t && (t.brain || t.type === 'script') && (t.type === 'script' || t.style) && this.brain && this.brain.preempt && bot.running && !bot.paused
        && now - (bot._preemptAt || 0) > PREEMPT_EVERY && now - (t.startedAt || now) > PREEMPT_EVERY) {
        bot._preemptAt = now;
        const next = await this.brain.preempt(bot).catch(() => null);
        if (next && bot.current === t) {
          // An order goes back to the front of the queue when stopped, so the daily has to go in front of it.
          if (next.beforeOrder) { const { beforeOrder, ...d } = next; bot._pushFront = [...(bot._pushFront || []), d]; }
          if (next.eventCap) bot.journal(`today's event time (${next.eventCap} h) is used up - "${t.why || t.path}" carries on tomorrow`);
          else if (next.styleCap) bot.journal(`me time is over for today (${next.styleCap}) - ${t.wish || 'the wish'} carries on tomorrow`);
          else bot.journal(`pausing "${t.why || t.path}" for "${next.why || next.type}" - it carries on afterwards`);
          w.at = now;
          bot.restart();
          continue;
        }
      }
      // Waiting politely in a public room for players to fight a boss (lib/manners.js) is not being stuck. A Skua script
      // parked outside the boss cell stops asking (it just re-jumps on AFK), so the wait went stale, the watchdog
      // restarted the task every 11 min and the 15-min daily limit never came: Oren looped Lord of Order at
      // Akriloth 20x on 2026-09-28 and did no other daily. Ask for it here, once a minute, so the wait ends on time.
      if (bot.client && bot.client.mannersWait && !bot.client.mannersWait.gaveUp) {
        try { manners.recheck(bot.client, bot.client.mannersWait.boss, now); } catch { /* never break the watchdog */ }
      }
      const mw = bot.client && bot.client.mannersWait;
      if (mw && !mw.gaveUp && now - mw.last < 60000) { w.at = now; w.progress = progress; continue; }
      // A farm step killing its own monster is waiting on luck, not stuck (lib/droprates.js): restarting only replays
      // the script's prelude and parking gave up on drops that need hundreds of kills (Taro's Manslayer ~290). It
      // carries on until its dry streak passes the item's budget, then it is parked below without a second stall.
      const farm = t && t.type === 'script' && bot.running && !bot.paused ? await Hub.farmState(bot, now, this.dropRates).catch(() => null) : null;
      if (farm && farm.going) {
        w.at = now; w.progress = progress; w.items = bot.itemProgress || 0;
        if (bot.scriptActivityAt && now - bot.scriptActivityAt > MUTE_SCRIPT && now - (farm.f.saidAt || 0) > 3600000) {
          farm.f.saidAt = now;
          bot.journal(`farming ${farm.item}: ${farm.dry} kills${farm.f.monster ? ` of ${farm.f.monster}` : ''} without one so far (gives up at ${farm.budget}${farm.mean ? `; ~${farm.mean} kills a drop` : ''}) - still at it`);
        }
        continue;
      }
      // Kills alone are not progress for a Skua script: Valen killed in the same cell for two hours while its log
      // stood still, and the kill counter kept the watchdog asleep the whole time (2026-09-20). Half an hour without
      // a new line from the script, an item gained or a quest turned in means it is stuck inside a step
      // (bot.scriptActivityAt, lib/bot.js runSkua), however busy the character looks.
      const warnings = t && t.type === 'script' && bot.client && typeof bot.client.slowWarnings === 'function' ? bot.client.slowWarnings(now) : 0;
      const storm = warnings > SLOW_STORM;
      const items = bot.itemProgress || 0;
      if (storm) {
        if (w.items !== undefined && items !== w.items) { w.items = items; w.progress = progress; w.at = now; continue; }
        w.items = items;
        w.progress = progress;
      } else {
        w.items = items;
        const mute0 = t && t.type === 'script' && bot.scriptActivityAt && now - bot.scriptActivityAt > MUTE_SCRIPT;
        if (mute0 && bot.scriptActivityAt < w.at) w.at = bot.scriptActivityAt;
        if (progress !== w.progress) { w.progress = progress; if (!mute0) { w.at = now; continue; } }
        else if (bot.scriptActivityAt && bot.scriptActivityAt > w.at) { w.at = bot.scriptActivityAt; continue; }   // a Skua script moving on
        // Damage dealt is progress too, short of the 30-min mute rule: a solo boss fight outlasts 10 min. Sable needs
        // ~10 min per Undead Raxgore (963k HP) for LoO's Blessing of Order; the watchdog restarted her just before kills,
        // the rejoin reset the boss, and 4 of 15 imprints took 1.5 h (2026-10-10).
        else if (!mute0 && bot.client && bot.client.damageAt > w.at) { w.at = bot.client.damageAt; continue; }
      }
      const mute = storm || (t && t.type === 'script' && bot.scriptActivityAt && now - bot.scriptActivityAt > MUTE_SCRIPT);
      const working = bot.running && !bot.paused && t && ['farmLevel', 'kill', 'daily', 'script', 'quest'].includes(t.type);
      if (!working || !(await bot.playing().catch(() => false))) { w.at = now; continue; }
      // Queued for a Skua engine is not stuck: the main's ArchMage order was restarted 11x on 10-21 while it only waited,
      // and every restart sent it to the back of the engine line.
      if (this.engineWaiting && this.engineWaiting.has(bot.id)) { w.at = now; continue; }
      const limit = t.type === 'script' ? 10 * 60000 : 7 * 60000;
      if (now - w.at < limit || now - (t.startedAt || now) < limit) continue;
      w.restarts = w.restarts.filter((x) => now - x < 30 * 60000).concat(now);
      const mins = Math.round((now - w.at) / 60000);
      const spent = farm && farm.spent ? farm : null;
      const step = t.type === 'script' ? (spent ? bot.scriptStep || spent.line.replace(/\d+/g, '#') : bot.scriptStep) : null;
      const how = storm ? `the server refused its actions ${warnings}x in 10 min ("slow down") and no item or quest came of it` : mute ? 'the script has made no progress' : 'no kills, quests or drops';
      bot.journal(`watchdog: ${how} for ${mins} min while "${t.why || t.type}"${step ? ` at "${step}"` : ''} - restarting the task`, 'warn');
      bot.remember('stuck', { task: t.type, why: t.why || null, step, map: await bot.map().catch(() => null), minutes: mins });
      // Why? A known cause gets its remedy now; an unknown one goes on the owner's list (attention).
      const dx = typeof this.diagnose === 'function' ? await this.diagnose(bot, t, step, now).catch((e) => ({ cause: 'unknown', text: `diagnosis failed: ${e.message}` })) : { cause: 'n/a', text: '' };
      if (dx.text) bot.journal(`diagnosis: ${dx.text}`, dx.cause === 'unknown' || dx.cause === 'map code' ? 'warn' : 'info');
      const fixing = dx.remedy ? Hub.remedyFirst(bot, t, dx, now) : false;
      if (dx.remedy && !fixing) {
        bot.queue.unshift({ ...dx.remedy, why: `fixing why "${String(t.why || t.type).slice(0, 60)}" was stuck: ${dx.cause}` });
        bot.save();
      }
      if (dx.attention && typeof this.attend === 'function') this.attend(bot, t, step, dx);
      if (this.overseer) this.overseer.trigger(`${bot.id} stuck: no progress for ${mins} min on ${t.type} at /${await bot.map().catch(() => '?')}`);
      // The same script stuck at the same step again, with nothing gained since: restarting only replays it (Valen
      // and Sable restarted BlazeBeardStory 35 times on 2026-09-21). The brain parks it and moves on.
      // A rare drop farmed for an order (the owner's dashboard orders): its monster keeps dying, so it is not stuck - the
      // order stays (2026-10-19: the main's 0ArchMage was dropped after 400 Avatar Tyndarius kills without the 1%
      // Everlight Flame, and autopilot went off to the birthday event).
      if (spent && !t.brain) {
        bot.journal(`farming ${spent.item} for your order: ${spent.dry} kills without one (budget ${spent.budget}) - rare drop, keeping at it`);
        w.at = now;
        continue;
      }
      if (fixing) {
        bot.journal(`keeping "${t.why || t.path || t.type}": ${dx.cause} is being fixed first, then it carries on`);
        w.at = now;
        bot.restart();
        continue;
      }
      if (step && (spent || Hub.stuckAgain(bot, t, step, now))) {
        if (spent) {
          bot.journal(`farming ${spent.item}: ${spent.dry} kills${spent.f.monster ? ` of ${spent.f.monster}` : ''} since the last one, past its budget of ${spent.budget}${spent.mean ? ` (~${spent.mean} kills a drop)` : ''} - giving it a rest`, 'warn');
          if (this.dropRates) this.dropRates.parked(bot.id, spent.item);
        }
        if (t.brain && this.brain && this.brain.park) {
          const what = this.brain.park(bot, t, step);
          this.notify(`${bot.account.label} is stuck`, `${t.why || t.path}: no progress at "${step.slice(0, 80)}" twice - parked ${what}`, 'alert');
        } else {
          // An order is put back in the queue after a restart (bot.js); one stuck twice at the same step is dropped.
          bot._dropCurrent = true;
          bot.journal(`dropping the order "${t.why || t.path}": stuck twice at "${step}" with nothing gained`, 'warn');
          this.notify(`${bot.account.label} is stuck`, `${t.why || t.path}: no progress at "${step.slice(0, 80)}" twice - order dropped`, 'alert');
        }
        w.at = now;
        bot.restart();
        continue;
      }
      if (w.restarts.length >= 2 && t.brain && this.brain && !step) {
        await this.brain.failed(bot, t).catch(() => null);
        this.notify(`${bot.account.label} is stuck`, `No progress on ${t.why || t.type} twice in 30 min - skipped it`, 'alert');
      }
      w.at = now;
      bot.restart();
    }
  }
  // A stall whose cause the bot can fix itself (backpack full -> bank/tidy): the remedy runs first, ahead of the task
  // that restarts behind it, and the task is kept - not parked, not dropped. Once per task and cause every 2 h: a remedy
  // that didn't help leaves the old rules (park / drop) to the next stall.
  static remedyFirst(bot, t, dx, now = Date.now()) {
    const tries = bot._remedyTries || (bot._remedyTries = new Map());
    const key = `${typeof bot.taskKey === 'function' ? bot.taskKey(t) : (t.path || t.type)}|${dx.cause}`;
    const last = tries.get(key);
    if (last && now - last < 2 * 3600000) return false;
    tries.set(key, now);
    (bot._pushFront = bot._pushFront || []).push({ ...dx.remedy, why: `fixing why "${String(t.why || t.type).slice(0, 60)}" was stuck: ${dx.cause}` });
    if (typeof bot.save === 'function') bot.save();
    return true;
  }
  // Why is this task stuck? { cause, text, remedy?: task to run first, attention?: true when only the owner/Claude can fix it }
  async diagnose(bot, t, step, now = Date.now()) {
    const recent = (re, ms) => (bot.lastLog || []).filter((l) => re.test(l) && now - Date.parse(String(l).slice(0, 24)) < ms).length;
    const map = String((bot.client && bot.client.w && bot.client.w.strMapName) || await bot.map().catch(() => '') || '');
    const s = String(step || '');
    // 1. Nowhere to put what it farms (the Ordinance stall, 2026-10-07).
    const free = Math.min(await bot.freeSlots().catch(() => 99), await bot.freeSlots('misc').catch(() => 99));   // bag or misc pool (AQW 5.0)
    if (free <= 0 || recent(/(backpack|misc inventory) full - could not make room|inventory is (still )?full/i, 30 * 60000)) {
      return { cause: 'backpack full', text: `backpack full (${free} free) - making room first`, remedy: Hub.isGuest(bot) ? { type: 'bankAc' } : { type: 'tidy' } };
    }
    // 2. Dying over and over: the walls / help-call rules own this.
    if (recent(/\bdied\b|too strong/i, 30 * 60000) >= 3) return { cause: 'too strong', text: `dying here (${recent(/\bdied\b/i, 30 * 60000)} deaths in 30 min) - the boss rules take it from here` };
    // 3. Waiting for players in a public room is not stuck.
    if (bot.client && bot.client.mannersWait && !bot.client.mannersWait.gaveUp) return { cause: 'waiting for players', text: 'waiting for players to fight the boss' };
    // 4. The monster the step hunts is not on this map (wrong map or cell, or it changed form).
    const hunt = /Killing (.+?) for item|hunting (.+?) in /i.exec(s);
    const monName = hunt ? (hunt[1] || hunt[2]).trim() : null;
    const mons = (bot.client && bot.client.w && bot.client.w.monsters) || [];
    if (monName && monName !== '*' && mons.length && !mons.some((m) => String(m.strMonName).toLowerCase() === monName.toLowerCase())) {
      return { cause: 'monster missing', text: `no "${monName}" on /${map} (${[...new Set(mons.map((m) => m.strMonName))].slice(0, 5).join(', ')}) - re-joining`, attention: recent(/diagnosis: no ".+" on/i, 6 * 3600000) >= 1 };
    }
    // 5. Waiting for an item while this map's own code has been acting (knowledge/map-events.json): map code.
    const item = /for item: "?([^"#]+?)"?\s+[\d#]+\/|Farming (.+?) \(/i.exec(s);
    let events = null;
    try { events = JSON.parse(fs.readFileSync(path.join(P.KNOWLEDGE, 'map-events.json'), 'utf8'))[map] || null; } catch (e) { events = null; }
    if (item && events) {
      return { cause: 'map code', text: `waiting for ${(item[1] || item[2]).trim()} on /${map}, where the map's own code runs (${Object.keys(events).join(', ')}) - Claude needs to look`, attention: true };
    }
    // 6. The server keeps refusing ("slow down"): packets are already spaced out.
    if (bot.client && typeof bot.client.slowWarnings === 'function' && bot.client.slowWarnings(now) > 20) return { cause: 'slow down', text: 'the server refuses actions as too fast - sending slower' };
    return { cause: 'unknown', text: `no known cause at "${s.slice(0, 120) || t.type}" on /${map}`, attention: true };
  }

  // The owner's list (dashboard Home "Needs a look", /health): stuck work nothing here knows how to fix. One entry per
  // character + step, newest first, 40 kept, persisted in ~/seraph/attention.json.
  attend(bot, t, step, dx) {
    const file = path.join(P.ROOT, 'attention.json');
    let list = this._attention;
    if (!list) { try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { list = []; } }
    const key = `${bot.id}|${dx.cause}|${String(step || t.path || t.type).slice(0, 120)}`;
    const old = list.find((x) => x.key === key);
    if (old) { old.n++; old.at = Date.now(); } else {
      list.unshift({ key, bot: bot.id, at: Date.now(), n: 1, cause: dx.cause, text: dx.text, task: String(t.why || t.path || t.type).slice(0, 120), step: String(step || '').slice(0, 160) });
      this.notify(`${bot.account.label} needs a look`, dx.text, 'alert');
    }
    this._attention = list.sort((a, b) => b.at - a.at).slice(0, 40);
    try { fs.writeFileSync(file, JSON.stringify(this._attention, null, 1)); } catch (e) { /* list only */ }
  }
  attentionList() {
    if (!this._attention) { try { this._attention = JSON.parse(fs.readFileSync(path.join(P.ROOT, 'attention.json'), 'utf8')); } catch (e) { this._attention = []; } }
    return this._attention;
  }
  dismissAttention(key) { this._attention = this.attentionList().filter((x) => key && x.key !== key); try { fs.writeFileSync(path.join(P.ROOT, 'attention.json'), JSON.stringify(this._attention, null, 1)); } catch (e) { /* */ } return this._attention; }

  // A fight the owner wants to watch (Malgor, The Mainyu, the ultras - 2026-09-21: "i must witness them"): one Discord
  // alert per fight per half hour, saying where to join.
  announceFight(bot, name, map) {
    const now = Date.now();
    this._fights = this._fights || {};
    if (now - (this._fights[name] || 0) < 30 * 60000) return;
    this._fights[name] = now;
    const room = this.partyRoom ? this.partyRoom(bot) : null;
    const where = `/join ${map}${room ? `-${room}` : ''}`;
    this.info(`fight to watch: ${name} - ${bot.account.label} started it, ${where}`);
    this.notify(`${name}: the party is fighting now`, `${bot.account.label} started it. Watch with ${where}`, 'event');
  }

  // A script stalled at `step`: was it stuck there before, with nothing gained since (bot.itemProgress counts items
  // reaching a new high and quests turned in, lib/bot.js runSkua)? A slow farm that keeps gaining is never parked
  // (the owner: "as long as the bot is making progress toward that script goal then its working fine").
  // A4 (audit 2026-09-28): when the step names its own item and count, progress is that count or a quest turned in,
  // not any item reaching a new high somewhere - Archfiend restarted ~10 times on 09-27 without parking because
  // unrelated drops kept counting. Steps without an item keep the old rule.
  static stuckAgain(bot, t, step, now = Date.now()) {
    const stalls = bot._stalls || (bot._stalls = new Map());
    const key = bot.taskKey(t);
    const items = bot.itemProgress || 0;
    const quests = (bot.stats && bot.stats.quests) || 0;
    const own = Hub.stepItem(step);
    const have = own ? own.have : null;
    // Skua's anti-AFK line alternates its cell ("Jump request to [Enter, Spawn]" / "[Enter, Left]"), so the same
    // stuck step never matched twice (2026-09-28). Compare steps with bracketed cells and numbers blanked.
    step = String(step).replace(/\[[^\]]*\]/g, '[]').replace(/\d+/g, '#');
    const rec = stalls.get(key);
    if (!rec || rec.step !== step || now - rec.at > 24 * 3600000) { stalls.set(key, { step, n: 1, items, quests, have, kills: (bot.stats && bot.stats.kills) || 0, at: now }); return false; }
    rec.n++;
    const nothing = have !== null && rec.have !== null && rec.have !== undefined ? have <= rec.have && quests === rec.quests : items === rec.items;
    // A 1% drop (Asherion Armor from Sir Kut) needs ~100 kills; two half-hour stalls parked VerusDoomKnight for 24 h
    // every time (Nova, 2026-10-07). For the items in lib/rare-drops.json, kills since the last stall keep it going
    // up to `stalls` times; without kills it parks as before.
    const kills = (bot.stats && bot.stats.kills) || 0;
    const rare = Hub.rareDrop(step);
    const killing = rec.kills !== undefined && kills > rec.kills;
    Object.assign(rec, { items, quests, have, kills });
    if (nothing && rare && killing && rec.n < rare.stalls) return false;
    if (nothing) { stalls.delete(key); return true; }
    return false;
  }

  // Is the running script's farm step (bot.farm, lib/droprates.js) still worth waiting on?
  //   going - its monster died in the last FARM_KILL_GAP, the dry streak is under budget and there is room for the drop
  //   spent - the dry streak passed the item's budget: park it now
  // The step's least-dry item decides (a batch of quest items shares its kills). Null when no farm step is running.
  static async farmState(bot, now = Date.now(), dr = bot.hub && bot.hub.dropRates) {
    const f = bot.farm;
    if (!f || !dr || !f.items || !f.items.length) return null;
    const best = f.items.map((item) => ({ item, dry: dr.dry(bot.id, item), budget: dr.budget(item), mean: dr.mean(item) }))
      .sort((a, b) => a.dry / a.budget - b.dry / b.budget)[0];
    const out = { ...best, f, line: f.line || '' };
    if (best.dry >= best.budget) return { ...out, spent: true };
    if (!f.lastKillAt || now - f.lastKillAt > FARM_KILL_GAP) return { ...out, going: false };
    // A full bag makes every drop a lost drop: that is the diagnosis' job (it makes room), not luck.
    const free = Math.min(await bot.freeSlots().catch(() => 99), await bot.freeSlots('misc').catch(() => 99));
    if (free <= 0) return { ...out, going: false, full: true };
    return { ...out, going: true };
  }

  // The item a Skua step is after, and its count: '(HuntMonster) Killing Desolich for item: "Medal" 0/1',
  // "(_KillForItem) Farming Dreadhaven Helm (3/10)", "(BuyAllMerge) Farming Doom Doubloon (12/300)".
  static stepItem(step) {
    const s = String(step || '');
    const m = /for item:\s*"?(.+?)"?\s+(\d+)\s*\/\s*(\d+)\s*$/i.exec(s) || /Farming\s+(.+?)\s*\((\d+)\s*\/\s*(\d+)\)/i.exec(s);
    return m ? { item: m[1].trim(), have: Number(m[2]), want: Number(m[3]) } : null;
  }

  // The rare drop a step farms (lib/rare-drops.json), or null. Steps arrive with digits blanked: "Farming 💎 Asherion Armor (#/#)".
  static rareDrop(step) {
    if (!Hub._rare) { try { Hub._rare = JSON.parse(fs.readFileSync(path.join(__dirname, 'rare-drops.json'), 'utf8')); } catch { Hub._rare = { items: {} }; } }
    const s = String(step || '');
    const m = /for item:\s*"?(.+?)"?\s+[\d#]+\s*\//i.exec(s) || /Farming\s+(.+?)\s*\([\d#]+\s*\//i.exec(s);
    if (!m) return null;
    const name = m[1].replace(/^[^A-Za-z0-9]+/, '').trim().toLowerCase();
    const hit = Object.keys(Hub._rare.items || {}).find((k) => k.toLowerCase() === name);
    return hit ? { item: hit, stalls: Number(Hub._rare.stalls) || 8 } : null;
  }

  killsLast10Min(bot) {
    const w = bot._watch;
    if (!w || w.samples.length < 2) return null;
    return w.samples[w.samples.length - 1].kills - w.samples[0].kills;
  }

  // ---------------- level together ----------------
  levelPartyBots() {
    const lp = this.settings.levelParty;
    if (!lp || !lp.enabled) return [];
    return [...this.bots.values()].filter((b) => !Hub.isGuest(b) && b.account.status !== 'pending' && b.running && !this.assistFor(b));
  }
  inLevelParty(bot) { return this.levelPartyBots().includes(bot); }
  levelPartyLeader() {
    const bots = this.levelPartyBots().filter((b) => b.serverName);
    return bots.sort(Hub.partyRank)[0] || null;
  }
  // The level the group levels at: the weakest online member, unless the gap to this bot is too big.
  async levelPartyLevel(bot) {
    if (!this.inLevelParty(bot)) return null;
    const mine = await bot.level();
    let low = mine;
    for (const b of this.levelPartyBots()) {
      if (b === bot || !(await b.playing().catch(() => false))) continue;
      const l = await b.level().catch(() => 0);
      if (l > 0 && l < low && mine - l <= this.settings.levelParty.maxGap) low = l;
    }
    return low;
  }
  setLevelParty(patch) {
    Object.assign(this.settings.levelParty, patch);
    this.saveSettings();
    this.info(`level together ${this.settings.levelParty.enabled ? 'ON' : 'off'} (room ${this.settings.levelParty.room})`);
    return this.settings.levelParty;
  }
  // Every minute: the leader invites members who aren't in its in-game party yet (members auto-accept, see Bot).
  // Everyone who is online stays in one party, whatever they happen to be doing: a party means shared
  // quest credit, and someone is always in range when a boss call goes out.
  partyBots() {
    return [...this.bots.values()].filter((b) => !Hub.isGuest(b) && b.account.status !== 'pending' && b.running && !this.assistFor(b));
  }
  // Seat order, then name: with seven characters the alphabet made the level-3 Edda the leader (2026-10-21), and an
  // AQW party holds five, so the ultra four come first and the newcomers fill what is left.
  static partyRank(a, b) {
    const seats = Object.keys(ultraready.SEATS);
    const r = (x) => { const i = seats.indexOf(x.id); return i < 0 ? seats.length : i; };
    return r(a) - r(b) || a.id.localeCompare(b.id);
  }
  partyLeaderOf(list) { return list.filter((b) => b.serverName).sort(Hub.partyRank)[0] || null; }

  // A character who is still in an older party can never be invited into a new one: the server answers "they are
  // already in a party" and drops the invite. This timer used to repeat that every minute for ever - 1,724 refused
  // invites per character in a day, and the four never regrouped after the leader reconnected (2026-09-20). So the
  // second attempt makes that character leave its party first (World.partyLeave), and after three rounds the pair is
  // left alone for 15 minutes instead of spinning.
  async partyTick() {
    if (this.settings.party && this.settings.party.grouped === false) return;
    const all = this.partyBots().sort(Hub.partyRank);
    const leader = this.partyLeaderOf(all);
    if (!leader || !(await leader.playing().catch(() => false))) return;
    const own = String(await leader.name().catch(() => '')).toLowerCase();
    // world.partyMembers never counts yourself (Game.as adds only names != myUserName), so neither may this.
    const inParty = ((await leader.g('world.partyMembers', [])) || []).map((x) => String(x).toLowerCase()).filter((n) => n && n !== own);
    const tries = (this._partyTries = this._partyTries || new Map());
    for (const b of all) {
      if (b === leader || !b.serverName || b.serverName !== leader.serverName) continue;
      const name = String(await b.name()).toLowerCase();
      if (!name) continue;
      if (inParty.includes(name)) { tries.delete(b.id); continue; }
      if (inParty.length >= 4) continue;                              // World.isPartyFull
      const t = tries.get(b.id) || { n: 0, until: 0 };
      if (Date.now() < t.until) continue;
      t.n++;
      if (t.n > 1) {   // still outside after an invite: it is stuck in an older party and has to leave it first
        await b.client.fn('world.partyLeave').catch(() => null);
        await new Promise((r) => setTimeout(r, 1200));
      }
      await leader.client.fn('world.partyInvite', name).catch(() => null);
      if (t.n >= 3) { t.n = 0; t.until = Date.now() + 15 * 60000; b.journal(`could not join ${leader.id}'s party - trying again in 15 min`, 'warn'); }
      tries.set(b.id, t);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  // The server the whole party plays on (the owner 2026-09-19: one party, one room, faster progress). Headless clients used
  // to pick the least crowded server each, so the four were on different servers and never partied. The first
  // character online chooses; the rest follow; it is remembered across restarts. An account's own `server` wins.
  sharedServer(acc) {
    if (this.settings.party && this.settings.party.grouped === false) return null;
    if (Hub.isGuest(acc)) return null;                                       // The owner's own account picks its own server
    if (acc && (acc.server || (this.assistFor(this.bot(acc.id)) || {}).server)) return null;
    for (const b of this.bots.values()) {
      if (b.id === (acc && acc.id) || Hub.isGuest(b) || !b.client || !b.client.serverName || !(b.client.state && b.client.state.loaded)) continue;
      if (this.settings.partyServer !== b.client.serverName) { this.settings.partyServer = b.client.serverName; this.saveSettings(); }
      return b.client.serverName;
    }
    return this.settings.partyServer || null;
  }
  // Crowded or quiet (lib/crowd.js, the owner 2026-09-25): the server a character logs in to is the one its task asked for
  // (bot.ensureServer sets bot.wantServer and relogs), else the quiet server. An account's own server or the assist
  // server still wins (pickServer reads those first). settings.crowd === false goes back to one shared server.
  serverFor(acc) {
    if (this.settings.crowd === false) return this.sharedServer(acc);
    if (acc && (acc.server || (this.assistFor(this.bot(acc.id)) || {}).server)) return null;
    const bot = acc && this.bot(acc.id);
    return (bot && bot.wantServer) || crowd.QUIET_SERVER;
  }
  partyServer(bot) {
    const a = this.assistFor(bot);
    if (a && a.server) return a.server;
    const p = this.partyOf(bot);
    if (!p) {
      const lead = this.levelPartyLeader();
      return lead && lead !== bot && this.inLevelParty(bot) ? lead.serverName : null;
    }
    const leader = this.bot(p[1].leader);
    return leader && leader !== bot ? leader.serverName : p[1].server || null;
  }
  // ---------------- assist the owner's main (ultra party) ----------------
  assistFor(bot) {
    const a = this.settings.assist;
    if (!a || !a.enabled || !a.main || !bot) return null;
    return a.members.includes(bot.id) ? a : null;
  }
  setAssist(patch) {
    const a = this.settings.assist;
    for (const k of ['enabled', 'main', 'server', 'mainClass']) if (k in patch) a[k] = patch[k];
    if (Array.isArray(patch.members)) a.members = patch.members.map((m) => String(m).toLowerCase());
    this.saveSettings();
    this.info(`assist ${a.enabled ? 'ON' : 'off'}: ${a.members.join(', ') || 'nobody'} -> ${a.main}${a.server ? ' @ ' + a.server : ''}`);
    if (a.enabled) for (const id of a.members) { const b = this.bot(id); if (b && !b.running) b.start(); }
    this.emit('state');
    return a;
  }
  // Which class this bot wears for an ultra: every assisting bot gets a different needed class; the main's class is
  // already covered. Owned class lists are read live from each bot.
  async ultraClassFor(bot, ultra, cfg = this.settings.assist) {
    const members = [];
    for (const id of cfg.members) {
      const b = this.bot(id);
      if (!b) continue;
      const owned = await b.ownedClasses().catch(() => []);
      members.push({ id: b.id, owned, prefer: (b.persona && b.persona.prefer) || [] });
    }
    const { assigned, missing } = progression.assignUltraClasses(ultra, members, cfg.mainClass ? [cfg.mainClass] : []);
    if (missing.length) this.info(`${ultra.label}: party is missing ${missing.join(', ')}`);
    return assigned[bot.id] || null;
  }
  servers() {
    for (const b of this.bots.values()) if (b.servers && b.servers.length) return b.servers;
    return [];
  }

  setParty(name, leader, members) {
    this.settings.party[name] = { leader, members: [...new Set([leader, ...members])], room: 80000 + Math.floor(Math.random() * 9999) };
    for (const m of members) {
      const b = this.bot(m);
      if (b && m !== leader) { b.settings.role = 'follower'; b.settings.leader = leader; b.save(); }
    }
    this.saveSettings();
    return this.settings.party[name];
  }

  // ---------------- notifications / gallery / reports ----------------
  notify(title, body, kind = 'alert') {
    this.info(`notify: ${title} - ${body}`);
    if (this.settings.notify && this.settings.notify[kind] === false) return;
    // Discord is the only way the closed-lid server can reach the owner; the desktop toast is for the PC.
    if (this.discord && this.discord.enabled && kind !== 'levelUp' && kind !== 'drop') {
      const icon = { crash: '⚠️', alert: '⚠️', event: '🎉', news: '📰' }[kind] || '•';
      this.discord.send(`${icon} **${title}**${body ? `
${body}` : ''}`, { kind, key: `${kind}:${title}` });
    }
    if (!this.settings.notifications || !this.electron || !this.electron.Notification) return;
    try { new this.electron.Notification({ title, body: String(body || ''), silent: false }).show(); } catch { /* notifications unsupported */ }
  }

  async snap(id, label) {
    const client = this.clients.get(id);
    if (!client) return null;
    const file = path.join(P.account(id), 'gallery', `${localDay()}-${String(label).replace(/[^\w.-]+/g, '_')}.png`);
    try { await client.screenshot(file); this.info(`gallery: ${file}`); return file; } catch { return null; }
  }

  async writeReports() {
    if (!this.settings.reports || !fs.existsSync(P.VAULT)) return;
    const dir = path.join(P.VAULT, 'JOURNAL', 'auto');
    fs.mkdirSync(dir, { recursive: true });
    for (const bot of this.bots.values()) {
      try {
        const s = await bot.status();
        const day = localDay();
        const journal = bot.lastLog.filter((l) => l.startsWith(new Date().toISOString().slice(0, 10)) && /LEVEL UP|task start|enhanced|bought|completed quest|event|daily|goal|saved gear|error/i.test(l)).slice(-60);
        const hours = ((Date.now() - bot.stats.sessionStart) / 3600000).toFixed(1);
        const md = [
          `# ${day} — ${bot.account.label} (auto report)`,
          '',
          `Written by Seraph at ${new Date().toLocaleTimeString()}. Session ${hours} h.`,
          '',
          '| | |', '|---|---|',
          `| Level | ${s.level ?? '?'} (${s.exp ?? '?'}/${s.expTo ?? '?'} xp, ETA ${s.etaLevelMin ?? '?'} min) |`,
          `| Class | ${s.className ?? '?'} |`,
          `| Gold | ${s.gold ?? '?'} (${s.goldPerHour ?? '?'}/h) |`,
          `| Kills / quests / drops | ${bot.stats.kills} / ${bot.stats.quests} / ${bot.stats.drops} |`,
          `| Deaths / relogins | ${bot.stats.deaths} / ${bot.stats.relogins} |`,
          `| Now | ${s.current ? `${s.current.type} — ${s.current.why || ''}` : 'idle'} |`,
          '',
          '## Highlights', '', ...journal.map((l) => `- ${l.slice(11, 19)} ${l.slice(25)}`), '',
        ].join('\n');
        fs.writeFileSync(path.join(dir, `${day}-${bot.id}.md`), md);
      } catch (e) { this.info(`report failed for ${bot.id}: ${e.message}`); }
    }
  }

  stopAll() { for (const b of this.bots.values()) b.stop(true); }
  dispose() { this.disposed = true; if (this.discordBot) this.discordBot.stop(); if (this.friendWatch) this.friendWatch.stop(); if (this.playerWatch) this.playerWatch.stop(); if (this.overseer) this.overseer.stop(); try { require('./llm').stop(); } catch { /* */ } for (const t of this.timers) clearInterval(t); for (const id of [...this.clients.keys()]) this.close(id); if (this.flash) this.flash.stop(); }
}

// Reruns after a partial raid kill (someone died out of the turn-in) before they count as tries (the owner 2026-10-19).
Hub.PARTIAL_ROUNDS = 4;
// What a help call needs besides struggle/requestHelp (Seraph 5 squads): test hubs that bind a method list add these.
Hub.HELP_METHODS = ['helpCalls', 'anyHelp', 'helpById', 'helpOf', 'expireHelps', 'closeHelp', 'helpCandidates', 'squadInfo', 'squadBook',
  'escalateHelp', 'helpGuardKill', 'guardOn', 'helpTick', 'keepEngineTurn', 'engineTurnBack', 'roomFull', 'helpUnreachable', 'recordHelp', 'endHelp'];

Object.assign(Hub.prototype, require('./crewdaily').methods);
Object.assign(Hub.prototype, require('./weekly').methods);
module.exports = { Hub, RECONNECT };
