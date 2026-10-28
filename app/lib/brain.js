// The brain: when an account's queue is empty it decides what to do next, in priority order.
// Every account has a persona (lib/personas.js): the same priorities, tuned by its traits and its own class path.
// State per account in accounts\<id>\brain.json. Goal pauses / custom goals in accounts\<id>\goals.json.
const path = require('path');
const { P } = require('./paths');
const { readJson, writeJson, serverDay } = require('./util');
const knowledge = require('./knowledge');
const schedule = require('./schedule');
const classplan = require('./classplan');
const ultraready = require('./ultraready');
const farmerjoe = require('./farmerjoe');
const FARMER_JOE = 'Other/FarmJoeKits/0FarmerJoeDoAll.cs';
const SEAT_LEVEL = 100;   // ultra seat goals wait for this level, after Farmer Joe (5d2)
// (BOOST_LEVEL_MAX_MS removed 2026-10-09: double-XP days no longer grind, see step 5b2)
const EVENT_CAP_BEFORE_100_H = 1;          // seasonal events until level 100 (the owner 2026-09-28; 2 h after)
const crowd = require('./crowd');
// Scripts the schedule already runs as recurring clocks (Lord of Order): not run again as goals the same day.
const RECURRING_SCRIPTS = new Set(schedule.RECURRING.map((r) => r.script));
const rankOf = (cp) => require('./skua/swfworld').rankFromPoints(cp);   // the game's own rank table
const personas = require('./personas');
const progression = require('./progression');
const fashion = require('./fashion');
const freegifts = require('./freegifts');
const DRY = new (require('./als'))();   // Brain.dryRun (lib/als.js: a stand-in on the PC's Node 12)
const { Ledger } = require('./ledger');
// XP per hour measured in the audit (2026-09-28), used until a character has 30 min of its own on the route.
const ROUTE_PRIORS = { 'story-13loc': 2.5e6, grind: 0.75e6 };   // 2026-09-29 baseline: 13 LoC 2.1-3.8 M/h, plain grind 0.67-0.79 M/h (2x days 2.3 M/h)
const mxp = (n) => `${Math.round(n / 1e5) / 10} M`;
const hm = (ms) => (ms >= 3600000 ? `${Math.round(ms / 360000) / 10} h` : `${Math.round(ms / 60000)} min`);

// Kept for callers that still import it: the default path of an account without a persona.
const DEFAULT_GOALS = progression.goalsFor(null);

class Brain {
  constructor(opts = {}) {
    this.hub = opts.hub || null;
  }

  stateFile(bot) { return path.join(P.account(bot.id), 'brain.json'); }
  goalsFile(bot) { return path.join(P.account(bot.id), 'goals.json'); }
  state(bot) {
    const dry = DRY.getStore();
    if (dry && dry.bot === bot) return dry.state;
    if (!bot._brainState) bot._brainState = readJson(this.stateFile(bot), { days: {}, goalFails: {}, notes: [] });
    return bot._brainState;
  }
  saveState(bot) {
    const dry = DRY.getStore();
    if (dry && dry.bot === bot) return;   // a dry run's copy is thrown away
    writeJson(this.stateFile(bot), bot._brainState);
  }

  // Run `fn` (a dry next()) against a copy of the brain state. Everything it calls, however deep and across awaits,
  // sees the copy (AsyncLocalStorage); everyone else keeps the real state. Before (audit 2026-09-28) preempt/ahead
  // swapped a snapshot back in after seconds of awaiting, and lost a park, a finished daily or event time written
  // meanwhile by the running task.
  dryRun(bot, fn) {
    const state = JSON.parse(JSON.stringify(this.state(bot)));
    return DRY.run({ bot, state }, fn);
  }

  // Work is parked after three failed goal runs (or two failed rank-ups) for a day. When the reason was a bug in
  // Seraph rather than the game - Oren's whole day "dead" on 2026-09-20 parked Farmer Joe, Master Ranger and two
  // classes - the counters are worthless and the character should simply try again.
  retry(bot) {
    const st = this.state(bot);
    const parked = { goals: Object.keys(st.goalFails || {}), classes: Object.keys(st.rankFails || {}) };
    st.goalFails = {}; st.goalFailAt = {}; st.rankFails = {};
    // Today's event scripts too: the ones called too hard or parked as stuck (finished ones just exit again quickly).
    const today = this.today(bot);
    parked.events = [...new Set([...Object.keys(today.eventsTooHard || {}), ...Object.keys(today.eventScripts || {})])];
    today.eventsTooHard = {}; today.eventScripts = {};
    if (bot.skipped) bot.skipped.clear();
    if (bot.ledger) bot.ledger.releaseAll();
    bot._stalls = null;   // the watchdog's memory of stuck steps (hub.watchdog)
    this.saveState(bot);
    const all = [...parked.goals, ...parked.classes, ...parked.events];
    if (all.length) bot.journal(`trying parked work again: ${all.join(', ')}`);
    return parked;
  }
  persona(bot) { return personas.get(bot.account && bot.account.persona); }
  tuning(bot) { return personas.tuning(this.persona(bot)); }

  // Goals come from the progression plan for this persona. goals.json only stores pauses, unless `custom` is true.
  goals(bot) {
    const saved = readJson(this.goalsFile(bot), null) || {};
    const paused = Array.isArray(saved.paused) ? saved.paused : [];
    if (saved.custom && Array.isArray(saved.goals)) return { goals: saved.goals, paused, custom: true };
    if (!saved.version) writeJson(this.goalsFile(bot), { version: 2, paused, custom: false });
    return { goals: Brain.orderGoals(progression.goalsFor(this.persona(bot)), bot.id), paused, custom: false };
  }

  today(bot) {
    const st = this.state(bot);
    const day = serverDay();
    if (!st.days[day]) {
      st.days = { [day]: { dailies: {}, events: {}, eventScripts: {}, eventMs: 0, enhancedAt: 0, soldAt: 0 } };
      this.saveState(bot);
    }
    const d = st.days[day];
    for (const [k, v] of Object.entries({ bankedAt: 0, styledAt: 0, goalChunks: 0, goalsToday: {}, styleMs: 0, styleAllowMs: fashion.STYLE_BASE_MS })) if (!(k in d)) d[k] = v;
    return d;
  }

  // A human-readable explanation is attached to every decision (`why`), shown on the dashboard.
  // While Artix is full (bot.ensureServer), crowded work is set aside and the next pick is taken instead.
  async next(bot) {
    for (let i = 0; i < 8; i++) {
      const t = await this.pick(bot);
      if (!t || !(bot.crowdBlocked && bot.crowdBlocked(t))) return t;
      bot.crowdSkip(t);
    }
    return { type: 'farmLevel', to: 100, minutes: 30, brain: true, why: 'crowded work waits for a seat on Artix - leveling meanwhile' };
  }

  async pick(bot) {
    const lvl = await bot.level();
    const day = this.today(bot);
    const tune = this.tuning(bot);
    const role = bot.settings.role || 'solo';

    // 0. Helping the owner's main account (ultra party) beats everything else.
    const assist = this.hub && this.hub.assistFor ? this.hub.assistFor(bot) : null;
    if (assist) return { type: 'assist', main: assist.main, minutes: 20, brain: true, why: `helping ${assist.main}` };

    // 0a. An ultra raid: all four fight one boss together (hub.raidTick, Ultras-v3).
    const raid = this.hub && this.hub.raidTask ? this.hub.raidTask(bot) : null;
    if (raid) return raid;

    // 0b. Party follower: stick to the leader bot.
    if (role === 'follower' && bot.settings.leader && this.hub && this.hub.bot(bot.settings.leader)) {
      return { type: 'follow', leader: bot.settings.leader, minutes: 30, brain: true, why: `following ${bot.settings.leader}` };
    }

    // 1. Backpack hygiene: items I don't use go to the bank (never sold), then known junk is sold. Skua scripts refuse
    //    to start with fewer than 20 free slots, so this starts well before the backpack is full (it waited for < 8).
    const room = bot.constructor.ROOM || { low: 22, target: 30 };
    const free = await bot.freeSlots();
    // AQW 5.0: materials fill their own pool (bot.freeSlots('misc')); a full one leaves every material drop on the ground.
    const miscFull = room.miscLow !== undefined && (await bot.freeSlots('misc').catch(() => 99)) < room.miscLow;
    if (Date.now() - Math.max(day.soldAt, day.bankedAt) > 3600000 && (free < room.low || miscFull)) {
      const bankable = bot.bankableAc && ((await bot.bankableAc()).length || (bot.bankableOther && (await bot.bankableOther()).length));
      if (Date.now() - day.bankedAt > 3600000 && bankable) {
        day.bankedAt = Date.now(); this.saveState(bot);
        return { type: 'bankAc', brain: true, why: 'backpack almost full - banking items I don\'t use' };
      }
      // Nothing left to bank: the bank's space for regular items is full too. Sell the gear nobody keeps (lib/wardrobe.js,
      // The owner 2026-10-07), at most every 6 h; only if that frees nothing does the owner hear about it.
      const st1 = this.state(bot);
      if (bot.tidyWardrobe && process.env.SERAPH_TEST_NO_TIDY !== '1' && Date.now() - (st1.tidiedAt || 0) > 6 * 3600000) {
        st1.tidiedAt = Date.now(); this.saveState(bot);
        return { type: 'tidy', brain: true, why: 'backpack and bank full - selling gear nobody wears' };
      }
      if (free < 10 && !day.fullAlert) {
        day.fullAlert = true;
        bot.emit('alert', { title: 'backpack and bank are full', body: `${free} free backpack slots and no bank space left for regular items - Skua scripts need 20 free. Buy bank slots or tell Claude what to sell.` });
      }
      day.soldAt = Date.now(); this.saveState(bot);
      return { type: 'sellJunk', brain: true, why: 'backpack almost full' };
    }

    // 1b. Wardrobe tidy once a day: sell regular gear nobody keeps, bank what isn't needed (the owner 2026-10-07).
    const stT = this.state(bot);
    if (bot.tidyWardrobe && process.env.SERAPH_TEST_NO_TIDY !== '1' && Date.now() - (stT.tidiedAt || 0) > 24 * 3600000) {
      stT.tidiedAt = Date.now(); this.saveState(bot);
      return { type: 'tidy', brain: true, why: 'daily wardrobe tidy - selling gear nobody wears, banking the rest' };
    }

    // 2. Keep gear enhanced to level (at most every 30 min), keeping some of the persona's gold reserve.
    if (Date.now() - day.enhancedAt > 30 * 60000 && (await bot.needsEnhance()) && (await bot.gold()) > Math.min(tune.goldReserve, 2000 + lvl * 100)) {
      day.enhancedAt = Date.now(); this.saveState(bot);
      return { type: 'enhance', brain: true, why: 'equipped gear is below my level' };
    }

    // 3. Wardrobe: dress in the persona's style every 6 hours, and right after a drop it fell for (bot.noticeLook).
    const persona = this.persona(bot);
    if (persona && (Date.now() - day.styledAt > 6 * 3600000 || (bot._styleDirty && Date.now() - day.styledAt > 10 * 60000))) {
      day.styledAt = Date.now(); this.saveState(bot);
      return { type: 'style', brain: true, why: `dressing up (${persona.fashion ? persona.fashion.identity : persona.style.palette})` };
    }

    // 3b. The barber: each persona restyles itself once, again every 30 days, and whenever its look is redesigned.
    const st0 = this.state(bot);
    if (persona && persona.barber && lvl >= 5 && (Date.now() - (st0.barberAt || 0) > 30 * 86400000 || (st0.barberAt || 0) < (persona.lookSince || 0))) {
      st0.barberAt = Date.now(); this.saveState(bot);
      return { type: 'barber', brain: true, why: `visiting the barber (${persona.barber.hair[0]}, ${persona.style.palette})` };
    }

    // 3b. Weekly and monthly content (ultras, Champion Drakath, monthly chores) once the character can survive it.
    const party = this.hub && this.hub.bots ? [...this.hub.bots.values()].filter((b) => b.running).length : 1;
    const ultraOk = this.hub && this.hub.ultraReady ? this.hub.ultraReady().ready : false;
    for (const r of schedule.due(bot, this.state(bot), { level: lvl, partySize: party, member: (await bot.g('world.myAvatar.objData.iUpgDays', 0)) > 0 })) {
      if (r.ultra && !ultraOk) continue;   // The owner's rule: right party composition and 30%+ weapons, or no ultra
      if (r.have && (await bot.owns(r.have).catch(() => false))) continue;   // a daily class clock ends with the class
      if (r.needItem && (await this.held(bot, r.needItem[0]).catch(() => 0)) < r.needItem[1]) continue;   // e.g. 3 Gears of Doom for the wheel
      if ((bot.isSkipped && bot.isSkipped({ type: 'script', path: r.script }))) continue;
      return { type: 'script', path: r.script, brain: true, recurring: r.id, every: r.every, why: `${r.name} is up this ${r.every}` };
    }

    // 4. Live seasonal events: probe once a day, then run their story scripts (time-boxed by temperament).
    const up = this.hub && this.hub.updater ? this.hub.updater.state : {};
    const newsText = [...(up.news || []), up.game ? up.game.sTitle : ''].join(' ');
    const minEvent = bot.settings.minEventLevel ?? tune.minEventLevel;
    const maxEventH = this.eventCapH(bot, lvl);
    for (const ev of knowledge.eventCandidates(new Date(), newsText)) {
      if (!(ev.folder in day.events)) {
        return { type: 'probeEvent', folder: ev.folder, maps: ev.maps.slice(0, 3), brain: true, why: `checking if ${ev.folder} is live` };
      }
      // Free gifts first (lib/freegifts.js, the owner 2026-10-05: "claim the free acs"): not event time, no event level.
      if (day.events[ev.folder]) {
        const gift = freegifts.next(this.state(bot), { level: lvl, events: { [ev.folder]: true } });
        if (gift && !(bot.isSkipped && bot.isSkipped(gift))) {
          if (!DRY.getStore()) { freegifts.began(this.state(bot), gift); this.saveState(bot); }
          return gift;
        }
      }
      if ((day.eventsTooHard || {})[ev.folder]) continue;   // died too much in this event today
      // Ultra focus (the owner 2026-10-19: "stop farming for things that are good but arent actually the things that will
      // make the bots kill the ultras"): free gifts above, no event stories or event wishes.
      if (bot.settings.ultraFocus) continue;
      if (day.events[ev.folder] && lvl >= minEvent && day.eventMs < maxEventH * 3600000) {
        // Event time goes to what the character wants from this event first (the owner, 2026-09-24: "whats the point of
        // doing events stuff if they gain nothing"); the storyline only when it wants nothing here (or to unlock it).
        const persona4 = this.persona(bot);
        if (lvl >= 30 && persona4 && persona4.fashion && process.env.SERAPH_TEST_NO_STYLE !== '1') {
          const only = { [ev.folder]: true };
          const want = await fashion.nextWish(bot, persona4, this.state(bot), only);
          const wt = want && want.limited === ev.folder ? fashion.taskFor(persona4, want, only, this.state(bot).routeFails) : null;
          if (wt && !(bot.isSkipped && bot.isSkipped(wt))) return { ...wt, event: ev.folder, countAs: 'event', why: `${ev.folder} is live - event time for ${want.name} (${want.slot})` };
        }
        const done = day.eventScripts[ev.folder] || [];
        const script = ev.scripts.find((s) => !done.includes(s) && /Story|Quest|Reward|Hunt/i.test(s));
        if (script && !(bot.isSkipped && bot.isSkipped({ type: 'script', path: script, event: ev.folder }))) return { type: 'script', path: script, brain: true, event: ev.folder, why: `${ev.folder} is live - doing ${path.basename(script, '.cs')}` };
      }
    }

    // 4b. Brand-new characters level before anything that sends them to real monsters (level-1 dailies = deaths).
    const minDaily = bot.settings.minDailyLevel ?? 10;
    if (lvl < minDaily) return { type: 'farmLevel', to: minDaily, minutes: tune.levelChunkMin, brain: true, why: `level ${lvl} - too weak for dailies, leveling to ${minDaily} first` };

    // 5. Dailies after reset (diligent personas first thing; restless ones after one goal chunk).
    const g = this.goals(bot);
    const readyGoal = g.goals.some((x) => lvl >= x.when && !g.paused.includes(x.id));
    if (tune.dailiesFirst || day.goalChunks >= 1 || !readyGoal) {
      for (const d of knowledge.dailies()) {
        if (!d.runnable || d.minLevel > lvl || (day.dailies[d.name] && !this.dailyRetry(day, d.name))) continue;
        // Ultra focus: only the dailies named in settings.ultraDailies (NSoDDaily cost ~30 runs + help calls a day).
        if (bot.settings.ultraFocus && !(bot.settings.ultraDailies || []).includes(d.name)) continue;
        // A crewed daily (lib/crew.json) is run by the whole party together (hub.crewTick), never one character alone.
        if (this.hub && this.hub.crewOwns && this.hub.crewOwns(bot, d.name)) continue;
        if (d.enough && (await this.held(bot, d.enough[0])) >= d.enough[1]) continue;   // the script's own stop (knowledge.js)
        let available = false;
        for (const q of d.quests) if (await bot.questAvailable(q)) { available = true; break; }
        if (!available) { day.dailies[d.name] = 'unavailable'; this.saveState(bot); continue; }
        if ((bot.isSkipped && bot.isSkipped({ type: 'daily', name: d.name }))) continue;
        return { type: 'daily', name: d.name, brain: true, why: `daily ${d.name} is up` };
      }
    }

    // 5b. Me time (the owner, 2026-09-24): an hour a day for the character's own wishes - the look it dreams of. After the
    //     hour it decides whether to keep going (preempt -> fashion.keepGoing), never past 4 h a day.
    // styleFromLevel (2026-10-22): new characters level and gear up first - Vexa, Edda and Sunna from 75.
    if (lvl >= (Number(bot.settings.styleFromLevel) || 30) && persona && persona.fashion && !bot.settings.noStyleTime && process.env.SERAPH_TEST_NO_STYLE !== '1' && day.styleMs < day.styleAllowMs) {
      const wish = await fashion.nextWish(bot, persona, this.state(bot), day.events || {});
      const wt = wish && fashion.taskFor(persona, wish, day.events || {}, this.state(bot).routeFails);
      if (wt && !(bot.isSkipped && bot.isSkipped(wt))) return wt;
    }

    // 5b2 (removed 2026-10-09). Double-XP days no longer grind all day. The owner, 2026-10-05: XP comes from useful work
    // (quests, class and item farms), never grinding as its own goal while something useful can run - and again
    // 2026-10-09: "the bots level while doing quests and farming for items". The server-wide boost counts on goal kills
    // too. Boost kinds still steer the goal order below (2x Rep -> rep classes first).
    const boosts = this.hub && this.hub.boosts ? this.hub.boosts : null;
    const boostKinds = boosts ? boosts.activeKinds() : [];

    // 5c. Every class the character owns goes to rank 10 (the owner, 2026-09-19), with Skua's own RankUpClass
    // (class boost + Ice Storm Arena at the character's level). Two failed tries park that class for a day.
    const stR = this.state(bot);
    const skipNew = process.env.SERAPH_TEST_SKIP_FJ === '1';   // older unit tests only
    if (lvl >= 10 && !bot.settings.noRankUp && !skipNew) {
      stR.rankFails = stR.rankFails || {};
      // rankSkip (2026-10-22): the starter classes a new character was made with (Rogue, Mage, Healer) are never used
      // in a fight; ranking them is 300k class points of grinding (Edda's Rogue at 5,831 on her first day).
      const rankSkip = new Set((bot.settings.rankSkip || []).map((x) => String(x).toLowerCase()));
      for (const c of await bot.unrankedClasses()) {
        if (rankSkip.has(String(c.name).toLowerCase())) continue;
        const f = stR.rankFails[c.name];
        if (f && f.n >= 2 && Date.now() - f.at < 24 * 3600000) continue;
        const rt = { type: 'script', path: 'CoreAdvanced.cs', entry: 'RankUpClass', args: JSON.stringify(c.name), rankClass: c.name, brain: true, why: `ranking ${c.name} up to 10 (${c.cp.toLocaleString()} / 302,500 class points)` };
        if ((bot.isSkipped && bot.isSkipped(rt))) continue;
        return rt;
      }
    }

    // 5d. Farmer Joe (the owner, 2026-09-19): the Skua community's full route - levels 1-100, the classes, gear and
    // endgame material - run as the real 0FarmerJoeDoAll.cs in Skua's engine until it finishes. No time limit since
    // 2026-09-21 (the owner: "as long as the bot is making progress toward that script goal then its working fine"): it
    // stops when it is done, when it stops making progress (hub.watchdog) or for dailies/events (hub.preempt), and
    // picks up where it left off. It re-runs weekly to pick up new steps from Skua updates.
    if (!bot.settings.noFarmerJoe && !skipNew && !(stR.fjDoneAt && Date.now() - stR.fjDoneAt < 7 * 86400000)
      && !((stR.goalFails['farmer-joe'] || 0) >= 3 && Date.now() - ((stR.goalFailAt || {})['farmer-joe'] || 0) < 24 * 3600000)
      && !(bot.isSkipped && bot.isSkipped({ type: 'script', path: FARMER_JOE, goal: 'farmer-joe' }))) {
      return { type: 'script', path: FARMER_JOE, goal: 'farmer-joe', farmerJoe: true, brain: true, why: "Farmer Joe: Skua's 1-100 + endgame route" };
    }

    // 5d2. The ultra seat (the owner, 2026-09-21: "queue the required scripts to make them be able to do ultras"): this
    // character's seat class, the enhancement it needs, then a 30%+ weapon (ultraready.js). Only after Farmer Joe, at
    // level 100 (the owner, 2026-09-22: "you cant make them do ultras when they are still under level and will keep dying.
    // farmer joe is supposed to make them ready to end game"). Ahead of Farmer Joe, the seat scripts only ground XP up to
    // their unlock level or died at Binky, and Farmer Joe gets ArchPaladin, Lord of Order and StoneCrusher on its own
    // route. `noUltraPrep` turns it off per character.
    // A custom queue (goals.json `custom`, the 2026-10-05 plan from the whole Skua library) already orders the seat goals
    // where they belong; this step would jump the long ones (VDK, King's Echo) ahead of it at level 100.
    if (!bot.settings.noUltraPrep && !skipNew && lvl >= SEAT_LEVEL && !g.custom) {
      for (const id of ultraready.goalsFor(bot.id)) {
        let goal = g.goals.find((x) => x.id === id) || (progression.GOALS[id] ? { id, ...progression.GOALS[id] } : null);
        // The persona's list lifts goals outside its own path to level 80/90 (progression.goalsFor); a seat goal keeps
        // the game's own level instead (check-up 2026-09-21).
        const base = progression.GOALS[id];
        if (goal && base && base.when < goal.when) goal = { ...goal, when: base.when };
        // A weapon that would not beat the best one it already has is not worth the farm (Weapon-Route).
        const dmg = goal && (goal.allDamage || (base && base.allDamage));
        if (dmg && (await this.bestAllDamage(bot)) >= dmg) continue;
        if (!(await this.goalReady(bot, goal, lvl, g, stR, day))) continue;
        const t = { type: 'script', path: goal.script, entry: goal.entry || null, args: goal.args || '', hours: goal.repeat === 'daily' ? (goal.hours || tune.goalHours) : null, goal: goal.id, seat: true, brain: true, why: `ultra seat: ${goal.label}${goal.purpose ? ` - ${goal.purpose}` : ''}` };
        if (bot.isSkipped && bot.isSkipped(t)) continue;
        return t;
      }
    }

    // 5e. The 13 Lords of Chaos story before the other goals: the gate to Chaos Slayer, the Lord of Order dailies and
    // Chaos Avenger, and 2-3.8 M XP/h measured. (2026-09-28 to 10-05 plain grinding came before every goal below 100;
    // The owner undid that on 10-05: useful work gives the XP on the way.)
    if (lvl < 100 && !skipNew) {
      // Phase 5: each route's own measured XP per hour (lib/ledger.js), the audit's numbers until it has 30 min.
      const loc = this.routeXph(bot, 'story-13loc', ROUTE_PRIORS['story-13loc']);
      const story = g.goals.find((x) => x.id === 'story-13loc');
      if (story && (await this.goalReady(bot, story, lvl, g, stR, day))) {
        const t = { type: 'script', path: story.script, entry: story.entry || null, args: story.args || '', hours: null, goal: story.id, brain: true, why: `${story.label} - on the way to 100: ${story.purpose} (~${mxp(loc.xph)}/h${loc.measured ? ' measured' : ''})` };
        if (!(bot.isSkipped && bot.isSkipped(t))) return t;
      }
      // The owner, 2026-10-05: "you shouldnt stop every quest progress to just farm xp ... while grinding for the class the
      // bot gains xp". Level 100 comes on the way: the goals below (classes, reputations, materials) run first, and
      // plain grinding (step 7) is only for when none of them can run.
    }

    // 6. Progression goals: own class path first, then the must-haves every account needs for ultras.
    const kinds = boostKinds;
    const st = this.state(bot);
    const boostedGoals = Brain.boostedGoals(kinds);
    const ordered = boostedGoals.length ? [...g.goals.filter((x) => boostedGoals.includes(x.id)), ...g.goals.filter((x) => !boostedGoals.includes(x.id))] : g.goals;
    for (const goal of ordered) {
      if (g.paused.includes(goal.id) || lvl < goal.when) continue;
      // The Lord of Order goal is the schedule's own daily clock (loo-daily): running it again as a goal the same day did
      // nothing and counted as a failed try (Sable: lord-of-order 4 fails on 09-28).
      if (RECURRING_SCRIPTS.has(goal.script)) continue;
      if ((st.goalFails[goal.id] || 0) >= 3 && Date.now() - ((st.goalFailAt || {})[goal.id] || 0) < 24 * 3600000) continue;
      if (goal.repeat === 'daily' && day.goalsToday[goal.id] && !boostedGoals.includes(goal.id)) continue;
      if (goal.have && (await bot.owns(goal.have))) continue;
      if (goal.haveQuest && (await bot.completedOnce(goal.haveQuest))) continue;
      if (goal.haveQty && (await this.held(bot, goal.haveQty[0])) >= goal.haveQty[1]) continue;
      if (goal.haveAll && (await this.holdsAll(bot, goal.haveAll))) continue;
      // A reputation goal is done at its rank (points, e.g. 302500 = rank 10): without this it ran again every pick.
      if (goal.haveRep && bot.reps && ((bot.reps() || {})[goal.haveRep[0]] || 0) >= goal.haveRep[1]) continue;
      if (goal.requiresQuest && !(await bot.completedOnce(goal.requiresQuest))) continue;
      // A goal that needs a class first (requiresHave): Nova's Nulgath goals sent it to Taro Blademaster without
      // ArchPaladin while the ArchPaladin goal was parked, 43 deaths in a day (2026-10-08).
      if (goal.requiresHave && !(await bot.owns(goal.requiresHave))) continue;
      // An item count first (requiresQty: [name, n], backpack + bank): Dauntless waits for the first Ultra Speaker kill's
      // 5 Malgor Insignias (the owner 2026-10-13: "after the bots are able to defeat ultra malgor they farm for dauntless").
      if (goal.requiresQty && (await this.held(bot, goal.requiresQty[0])) < goal.requiresQty[1]) continue;
      if (goal.needsAc && (await bot.g('world.myAvatar.objData.intCoins', 0)) < goal.needsAc) continue;
      // Gold first (requiresGold): King's Echo buys 50 M of vouchers, and its script grinds that gold itself - hours of
      // gold farming that every other quest and goal pays for anyway (the owner 2026-10-14). Other goals first, KE at the gold.
      if (goal.requiresGold && (await bot.gold().catch(() => 0)) < goal.requiresGold) continue;
      const stage = progression.stageFor(lvl);
      const why = `${boostedGoals.includes(goal.id) ? 'Boost today! ' : ''}${stage.label}: ${goal.label}${persona && !goal.signature ? ' (every account needs it)' : ''}${goal.purpose ? ` - ${goal.purpose}` : ''}`;
      // Goals run until done like every script; only a daily-slice goal (`repeat: 'daily'`, e.g. Legion tokens to
      // 25,000) keeps a time box, or it would hold every later goal back for weeks.
      const gt = { type: 'script', path: goal.script, entry: goal.entry || null, args: goal.args || '', hours: goal.repeat === 'daily' ? (goal.hours || tune.goalHours) : null, goal: goal.id, brain: true, why };
      // A goal's own answers to its script's yes/no boxes, and the AC items it may buy (join-legion: Undead Warrior,
      // sold back once in the Legion). Everything else keeps the default "no" and the AC lock.
      if (goal.answers) gt.answers = { yesno: false, rules: goal.answers };
      if (goal.allowAc) gt.allowAc = goal.allowAc;
      if ((bot.isSkipped && bot.isSkipped(gt))) continue;
      return gt;
    }

    // 7. Level up: nothing useful can run right now (every goal is parked, done or above this level).
    if (lvl < 100) {
      const fjWhy = bot.settings.noFarmerJoe ? 'Farmer Joe is off' : stR.fjDoneAt ? 'Farmer Joe has finished its route' : 'Farmer Joe is blocked by a boss for now';
      const grind = this.routeXph(bot, 'grind', ROUTE_PRIORS.grind);
      return { type: 'farmLevel', to: 100, minutes: tune.levelChunkMin, brain: true, critical: 'xp', why: `level ${lvl}: ${fjWhy} and no class or goal can run now - grinding XP meanwhile (~${mxp(grind.xph)}/h${grind.measured ? ' measured' : ''})` };
    }

    // 7b. Free time (the owner, 2026-10-14): nothing left to do in the game - farm the extra looks (and seasonal ones),
    //     after any main-look piece still missing. No daily me-time cap here: this is time nothing else wants.
    if (persona && persona.fashion && !bot.settings.noStyleTime && process.env.SERAPH_TEST_NO_STYLE !== '1') {
      const wish = await fashion.nextWish(bot, persona, this.state(bot), day.events || {}, { free: true });
      const wt = wish && fashion.taskFor(persona, wish, day.events || {}, this.state(bot).routeFails);
      if (wt && !(bot.isSkipped && bot.isSkipped(wt))) return { ...wt, countAs: 'free', why: `free time: ${wt.why}` };
    }
    // 7c. Ultra focus keeps style time off, but a priority look (the owner 2026-10-19, Nova's N12) is still farmed here,
    //     before step 8 farms gold for parked work.
    if (persona && persona.fashion && persona.fashion.priority && bot.settings.noStyleTime && process.env.SERAPH_TEST_NO_STYLE !== '1') {
      const wish = await fashion.nextWish(bot, persona, this.state(bot), day.events || {}, { priorityOnly: true });
      const wt = wish && fashion.taskFor(persona, wish, day.events || {}, this.state(bot).routeFails);
      if (wt && !(bot.isSkipped && bot.isSkipped(wt))) return { ...wt, countAs: 'free', why: `priority look ${wish.priority}: ${wt.why}` };
    }

    // 8. Nothing else left: now the work waiting for gold may farm it itself, first in goal order.
    return this.goldStep(bot, g, lvl, day);
  }

  // Step 8 of pick(): nothing else left - gold, for the work that waits on it.
  async goldStep(bot, g, lvl, day) {
    // Paused goals stay paused here too (2026-10-19: ultra focus paused AFDL on all four, and step 8 still farmed and
    // spent 12.5 M for it on Valen and Nova).
    const goldFarm = { type: 'kill', map: 'battlegrounde', cell: 'r2', pad: 'center', monster: '*', quests: [3991, 3992], minutes: 30, brain: true };
    const waits = Object.values(this.state(bot).goldWait || {}).filter((w) => w && w.task && !w.task.raid && !g.paused.includes(w.task.goal));   // raids wait in the hub
    const rank = (id) => { const i = g.goals.findIndex((x) => x.id === id); return i < 0 ? 1e9 : i; };
    // A goal saving up its own gold (requiresGold: King's Echo's 50 M of vouchers, Oren's ultra caster seat for 4 of
    // the 11 ultras) ranked before a wait: that wait would spend the savings (Valiance 25 M at 22 M saved, 2026-10-19).
    // Plain gold farming until the goal can run.
    const gold = await bot.gold().catch(() => 0);
    let saving = null;
    for (const goal of g.goals) {
      if (!goal.requiresGold || gold >= goal.requiresGold) continue;
      if (await this.goalReady(bot, { ...goal, requiresGold: 0 }, lvl, g, this.state(bot), day).catch(() => false)) { saving = goal; break; }
    }
    if (waits.length) {
      const w = waits.sort((a, b) => rank(a.task.goal) - rank(b.task.goal) || a.at - b.at)[0];
      if (!saving || rank(w.task.goal) < rank(saving.id)) return { ...w.task, goldOk: true, brain: true, why: `nothing else left to do - farming the ${Math.round(w.gold / 1e5) / 10} M gold for ${w.label}` };
    }
    if (saving) return { ...goldFarm, why: `saving gold for ${saving.label || saving.id}: ${Math.round(gold / 1e5) / 10} of ${Math.round(saving.requiresGold / 1e5) / 10} M` };
    // Level 100 idle: gold for Forge enhancements.
    return { ...goldFarm, why: 'level 100 - farming gold' };
  }

  // How many of an item the character has, backpack and bank (a banked stack still counts toward a daily's stop).
  async held(bot, name) {
    const n = String(name).toLowerCase();
    let total = await bot.count(name).catch(() => 0);
    for (const it of await bot.bankItems().catch(() => [])) if (String(it.sName || '').toLowerCase() === n) total += Number(it.iQty || 0);
    return total;
  }

  // haveAll: [[name, n], ...] - done only when every one is held. The raid potions goal was "done" at 20 Honor Potions
  // while Valen had 8 Battle Elixirs, and v3 farmed 8 M gold for them inside the first Time Inn raid (2026-10-13).
  async holdsAll(bot, list) {
    for (const [name, n] of list || []) if ((await this.held(bot, name)) < n) return false;
    return true;
  }

  // Can this goal run now? (level, parked, paused, done today, already owned, prerequisites, AC)
  async goalReady(bot, goal, lvl, g, st, day) {
    if (!goal || !goal.script || g.paused.includes(goal.id) || lvl < (goal.when || 0)) return false;
    if ((st.goalFails[goal.id] || 0) >= 3 && Date.now() - ((st.goalFailAt || {})[goal.id] || 0) < 24 * 3600000) return false;
    if (goal.repeat === 'daily' && day.goalsToday[goal.id]) return false;
    if (goal.have && (await bot.owns(goal.have))) return false;
    if (goal.haveQuest && (await bot.completedOnce(goal.haveQuest))) return false;
    if (goal.haveQty && (await this.held(bot, goal.haveQty[0])) >= goal.haveQty[1]) return false;
    if (goal.haveAll && (await this.holdsAll(bot, goal.haveAll))) return false;
    if (goal.requiresQuest && !(await bot.completedOnce(goal.requiresQuest))) return false;
    if (goal.requiresHave && !(await bot.owns(goal.requiresHave))) return false;
    if (goal.requiresQty && (await this.held(bot, goal.requiresQty[0])) < goal.requiresQty[1]) return false;
    if (goal.needsAc && (await bot.g('world.myAvatar.objData.intCoins', 0)) < goal.needsAc) return false;
    if (goal.requiresGold && (await bot.gold().catch(() => 0)) < goal.requiresGold) return false;
    return true;
  }

  // Goals that a boost kind speeds up (reputation classes on 2x Rep, Nulgath grinds on Void Aura / Spirit Orb days, …).
  // Goal order: Farmer Joe (the Skua community's own 1-100 route, read live from the scripts) is the backbone;
  // The owner's ultra seat for this character (class + its enhancement + a 30%+ weapon) is folded in at its level.
  // Where a Farmer Joe step matches an existing goal, the existing one (with its completion check) is used and
  // told which method of the script to start at.
  static orderGoals(all, botId) {
    const MATCH = {
      'MasterRanger.cs': 'master-ranger', 'ScarletSorceress.cs': 'scarlet-sorceress', 'BurningBlade.cs': 'burning-blade',
      'BlazeBinder.cs': 'blaze-binder', 'ArchPaladin.cs': 'archpaladin', 'LordOfOrder.cs': 'lord-of-order',
      'UnlockForgeEnhancements.cs': 'forge-enhancements', 'DragonOfTime.cs': 'dragon-of-time',
      'EnoughDOOMforanArchfiend.cs': 'archfiend-doomlord', 'ShadowrealmMerge.cs': 'hollowborn-reaper-scythe',
    };
    const byId = new Map(all.map((g) => [g.id, { ...g }]));
    const fj = [];
    farmerjoe.steps().forEach((st, i) => {
      const base = path.basename(st.script);
      if (st.entry === 'BladeofAweREP') { const g = byId.get('awe-enhancements'); if (g) { g.fj = i; g.when = Math.min(g.when, st.level); } return; }
      const id = MATCH[base];
      if (id && byId.has(id)) {
        const g = byId.get(id);
        g.fj = i; g.when = Math.min(g.when, st.level);
        if (!g.entry && st.entry && base !== path.basename(g.script)) { g.script = st.script; g.entry = st.entry; }
        return;
      }
      if (!st.have || st.script === 'CoreFarms.cs') return;          // leveling and farms are handled elsewhere
      const id2 = `fj-${base.replace(/\.cs$/, '').toLowerCase()}`;
      if (byId.has(id2)) return;
      // A daily-quest class (Dailies/Cryomancer.cs: one token a day, 7 days) only progresses once per server day; as a
      // plain goal it restarted every minute all day once the daily was used (Sable7: 109 runs on 2026-09-22).
      const daily = /^Dailies\/|\/Daily-Classes\//.test(st.script) ? { repeat: 'daily' } : {};
      fj.push([id2, { id: id2, label: st.have, script: st.script, entry: st.entry, args: st.args, when: st.level, have: st.have, purpose: `Farmer Joe: ${st.label}`, fj: i, gear: /blade|scythe|cape|weapon/i.test(st.have), ...daily }]);
    });
    for (const [id, g] of fj) byId.set(id, g);
    const seat = new Set(ultraready.goalsFor(botId));
    const list = [...byId.values()];
    // Level first, then Farmer Joe's own order, with this character's ultra seat ahead of equal-level extras.
    return list.sort((a, b) => (a.when - b.when)
      || ((a.fj ?? 999) - (b.fj ?? 999))
      || ((seat.has(b.id) ? 1 : 0) - (seat.has(a.id) ? 1 : 0)));
  }

  static boostedGoals(kinds) {
    const map = {
      rep: ['master-ranger', 'shaman', 'chaos-slayer', 'stonecrusher', 'awe-enhancements'],
      legionToken: ['legion-tokens', 'legion-revenant'],
      voidAura: ['void-highlord'], spiritOrb: ['void-highlord'], darkSpiritOrb: ['void-highlord', 'legion-revenant'], bloodGem: ['void-highlord'],
      gold: ['forge-enhancements'],
    };
    return [...new Set((kinds || []).reduce((a, k) => a.concat(map[k] || []), []))];
  }

  // The ledger (lib/ledger.js): one attempt per finished or stopped task, with what it gained since it started.
  // 'finished' becomes 'progress' or 'nothing'.
  record(bot, task, outcome, extra = {}) {
    if (!task || !bot.ledger || typeof bot.gainedSince !== 'function') return null;
    try {
      const g = bot.gainedSince(task._mark);
      const gained = g.items > 0 || g.quests > 0 || g.drops > 0 || g.xp > 0;
      const out = outcome === 'finished' ? (gained ? 'progress' : 'nothing') : outcome;
      const route = task.goal || (task.type === 'farmLevel' ? 'grind' : task.path ? path.basename(task.path, '.cs') : task.type);
      return bot.ledger.attempt(bot.taskKey(task), { ...g, outcome: out, step: extra.step || null, route }, task.why || task.goal || task.type);
    } catch (e) { return null; }
  }
  // The best "all damage" weapon the character owns, backpack or bank (0.30 = +30%), cached 30 min.
  async bestAllDamage(bot, now = Date.now()) {
    if (bot._bestDmg && now - bot._bestDmg.at < 30 * 60000) return bot._bestDmg.value;
    let value = 0;
    try { value = ultraready.bestAllDamage([...await bot.items(), ...await bot.bankItems().catch(() => [])]).value; } catch (e) { value = 0; }
    bot._bestDmg = { at: now, value };
    return value;
  }

  // A route's XP per hour: measured (30 min or more in the ledger) or the prior.
  routeXph(bot, route, prior) {
    const r = bot.ledger && bot.ledger.data && bot.ledger.data.routes ? bot.ledger.data.routes[route] : null;
    return r && r.minutes >= 30 && r.xpPerHour > 0 ? { xph: r.xpPerHour, measured: true, minutes: r.minutes } : { xph: prior, measured: false };
  }

  // Work the back-off applies to: the brain's own scripts. Dailies, clocks (Lord of Order), events, raids, rank-ups, me
  // time and Farmer Joe's whole route have their own rules.
  backsOff(task) {
    return !!(task && task.brain && task.type === 'script' && !task.recurring && !task.raid && !task.event && !task.rankClass && !task.style && !task.farmerJoe);
  }

  // The task a park line in the journal was about ('parked "<why>" for 24 h: ...'), rebuilt so a wall seeded from the
  // journal can run it in an escort. Only work the brain builds the same way every time: Farmer Joe, goals, rank-ups.
  taskForWhy(bot, why) {
    const w = String(why || '');
    if (/^Farmer Joe:/.test(w)) return { type: 'script', path: FARMER_JOE, goal: 'farmer-joe', farmerJoe: true, brain: true, why: w };
    const r = /^ranking (.+?) up to 10/.exec(w);
    if (r) return { type: 'script', path: 'CoreAdvanced.cs', entry: 'RankUpClass', args: JSON.stringify(r[1]), rankClass: r[1], brain: true, why: w };
    if (/^me time:/i.test(w)) return { type: 'script', style: true, brain: true, why: w };
    const g = this.goals(bot).goals || [];
    const goal = g.find((x) => w.includes(`: ${x.label}`) || w.startsWith(`${x.label} - `) || w === x.label);
    if (!goal || !goal.script) return null;
    return { type: 'script', path: goal.script, entry: goal.entry || null, args: goal.args || '', goal: goal.id, brain: true, why: w };
  }

  // Would the brain run this (blocked) work now, if the wall were gone? Below level 100 only Farmer Joe, the 13 LoC
  // story and rank-ups are on the path (5e); everything else waits for 100. Cosmetic work never gets an escort.
  escortable(bot, task) {
    if (!task || task.style || task.event || task.countAs === 'event' || task.recurring) return false;
    if (task.farmerJoe) return !bot.settings.noFarmerJoe;
    if (task.rankClass) return true;
    const lvl = Number((bot.client && bot.client.w && bot.client.w.myAvatar && bot.client.w.myAvatar.objData && bot.client.w.myAvatar.objData.intLevel) || 0);
    if (lvl && lvl < 100) return task.goal === 'story-13loc';
    return !!task.goal;
  }

  // A wall: what the parked step or the killer says, with the numbers the difficulty estimate needs (lib/walls.js).
  noteWall(bot, task, step, opts = {}) {
    const walls = this.hub && this.hub.walls;
    if (!walls || DRY.getStore()) return null;
    try {
      const c = bot.client || {};
      const w0 = c.w || {};
      const me = (w0.myAvatar && w0.myAvatar.dataLeaf) || {};
      const k = opts.killer || null;
      const bossName = k ? k.name : ((require('./walls').parseStep(step) || {}).boss || null);
      const mon = bossName && Array.isArray(w0.monsters) ? w0.monsters.find((m) => String(m.strMonName || '').toLowerCase() === String(bossName).toLowerCase()) : null;
      const info = {
        boss: bossName, hpMax: (k && k.hpMax) || (mon && Number(mon.intHPMax)) || null, ownHp: Number(me.intHPMax) || null,
        map: w0.strMapName || null, cell: (k && k.cell) || (mon && mon.strFrame) || null, deaths: opts.deathsN || null,
        stats: typeof c.fightStats === 'function' ? c.fightStats(bossName) : null,
      };
      return walls.note(bot, task, step, info);
    } catch (e) { return null; }
  }

  // The owner's gold rule (2026-10-15): work whose script started grinding gold waits (bot.isSkipped) until the bot holds
  // that gold from everything else it does; then it runs again in its own place in the order.
  goldShort(bot, task) {
    const st = this.state(bot);
    const key = bot.taskKey(task);
    const w = st.goldWait && st.goldWait[key];
    if (!w) return false;
    if (bot.goldNow() < w.gold) return true;
    delete st.goldWait[key];
    bot.journal(`I have the ${Math.round(w.gold / 1e5) / 10} M gold "${w.label}" wanted - it can run again`);
    this.saveState(bot);
    return false;
  }

  async done(bot, task, result) {
    const day = this.today(bot);
    const st = this.state(bot);
    // Stopped for gold: not a failure, not "finished without gaining" - it waits for the gold (goldShort).
    // A raid script is the party's, never something to farm gold for and run alone later (brain step 8): the raid waits
    // for the member's gold instead (hub.raidDone -> raidCallOff -> goldHold).
    if (result && result.goldWait && task.type === 'script' && task.raid) {
      if (this.hub && this.hub.raidDone) this.hub.raidDone(bot, task, false, { goldWait: result.goldWait });
      return;
    }
    if (result && result.goldWait && task.type === 'script') {
      const copy = {};
      for (const [k, v] of Object.entries(task)) if (!['startedAt', 'tries', '_mark', 'goldOk'].includes(k)) copy[k] = v;
      (st.goldWait = st.goldWait || {})[bot.taskKey(task)] = { gold: result.goldWait, at: Date.now(), label: task.goal || task.path, task: copy };
      this.saveState(bot);
      if (task.escort && this.hub && this.hub.walls) this.hub.walls.taskEnded(bot, task, null);
      if (task.raid && this.hub && this.hub.raidDone) this.hub.raidDone(bot, task, false);
      return;
    }
    // D1 (audit 2026-09-28): a script that keeps finishing without gaining anything (fj-cryomancer: 183 starts for
    // 0.8 h) rests 30 min after the second such run in a row, doubling up to 24 h.
    const it = this.record(bot, task, result === false ? 'failed' : 'finished');
    if (task.escort && this.hub && this.hub.walls) this.hub.walls.taskEnded(bot, task, it && it.attempts ? it.attempts[it.attempts.length - 1] : null);
    if (it && result !== false && this.backsOff(task) && it.nothingRun >= 2 && bot.skipped) {
      const ms = Ledger.backoffMs(it.nothingRun);
      bot.skipped.why = `finished ${it.nothingRun}x in a row without gaining anything`;
      bot.skipped.set(bot.taskKey(task), Date.now() + ms);
      bot.journal(`"${task.why || task.path}" finished ${it.nothingRun}x in a row without gaining anything - resting it ${hm(ms)}`, 'warn');
    }
    if (task.raid && this.hub && this.hub.raidDone) this.hub.raidDone(bot, task, result !== false);
    if (task.rankClass) {
      const still = await bot.unrankedClasses().then((l) => l.some((c) => c.name === task.rankClass)).catch(() => false);
      if (still) {
        const f = (st.rankFails = st.rankFails || {})[task.rankClass] || { n: 0 };
        st.rankFails[task.rankClass] = { n: f.n + 1, at: Date.now() };
        if (f.n + 1 >= 2 && bot.ledger) { bot.ledger.item(`rank:${task.rankClass}`, `rank up ${task.rankClass}`); bot.ledger.hold(`rank:${task.rankClass}`, Date.now() + 24 * 3600000, `${f.n + 1} rank-up runs without reaching rank 10`); }
      }
      else { if (st.rankFails) delete st.rankFails[task.rankClass]; bot.journal(`${task.rankClass} is rank 10`); if (this.hub && this.hub.walls && this.hub.walls.dropRank) this.hub.walls.dropRank(bot, task.rankClass); }
    }
    // Farmer Joe finished: done for the week. Finishing within 15 min below level 100 means it stopped early (a failed
    // chunk; three in a day pause it for 24 h).
    if (task.farmerJoe && result && result.ok && !result.timedOut) {
      const quick = Date.now() - (task.startedAt || Date.now()) < 15 * 60000;
      if (quick && (await bot.level().catch(() => 0)) < 100) { this.goalFailed(bot, 'farmer-joe'); bot.journal('Farmer Joe stopped early - will retry', 'warn'); }
      else { st.fjDoneAt = Date.now(); bot.journal('Farmer Joe finished the whole route'); }
    }
    if (task.boost === 'exp') day.boostLevelMs = (day.boostLevelMs || 0) + (Date.now() - (task.startedAt || Date.now()));
    if (task.style) await this.wishEnded(bot, task, result !== false);
    if (task.gift) { freegifts.ended(st, task, result !== false); bot.journal(`free gift ${task.gift}: ${result !== false ? 'claimed (or already had it)' : 'the claim failed'}`); }
    if (task.type === 'daily') { if (result === false) this.dailyFailed(day, task.name); else day.dailies[task.name] = 'done'; }
    if (task.type === 'probeEvent') {
      day.events[task.folder] = !!(result && result.open);
      if (result && result.open && this.hub) this.hub.notify(`${task.folder} is live`, `${bot.account.label} found /${result.map} open`, 'event');
    }
    if (task.type === 'script' && task.event) {
      (day.eventScripts[task.event] = day.eventScripts[task.event] || []).push(task.path);
      day.eventMs += Date.now() - (task.startedAt || Date.now());
      // A failed event script (usually "too strong" deaths) means the whole event is too hard for this character today.
      if (result === false && !task.style) { (day.eventsTooHard = day.eventsTooHard || {})[task.event] = true; bot.journal(`event ${task.event} is too hard for me today - skipping it`, 'warn'); }
    }
    if (task.type === 'script' && task.recurring && result !== false) schedule.markDone(this.state(bot), task.recurring, task.every || 'week');   // survives the daily reset
    // A restless persona does its dailies after one chunk of the day's main work (step 5). Below level 100 that work is
    // the XP grind (5e), not a goal, so a grind chunk counts too: without this Nova never reached a single daily
    // (check-up 2026-10-04: 11 dailies 'to do' at 20:00 UTC, 27 grind chunks, 0 dailies).
    if (task.type === 'farmLevel' && task.critical) day.goalChunks++;
    if (task.type === 'script' && task.goal) {
      day.goalChunks++;
      day.goalsToday[task.goal] = true;
      if (result === false) this.goalFailed(bot, task.goal);
      // Backstop: a goal script that ends within 5 min and still leaves its item missing did nothing (a used-up
      // daily, a missing prerequisite). Count it as a failed try, so three of them rest the goal for 24 h instead of
      // restarting it every minute.
      else if (task.goal !== 'farmer-joe' && Date.now() - (task.startedAt || Date.now()) < 5 * 60000) {
        const goal = progression.GOALS[task.goal] || (this.goals(bot).goals || []).find((x) => x.id === task.goal);
        const missing = goal && ((goal.have && !(await bot.owns(goal.have).catch(() => true)))
          || (!goal.have && goal.haveQuest && !(await bot.completedOnce(goal.haveQuest).catch(() => true))));
        if (missing) {
          this.goalFailed(bot, task.goal);
          bot.journal(`${goal.label || task.goal}: the script ended in under 5 min without it - try ${this.state(bot).goalFails[task.goal]}/3 today`, 'warn');
        }
      }
    }
    this.saveState(bot);
  }

  async failed(bot, task, err) {
    const day = this.today(bot);
    const fit = this.record(bot, task, 'failed', { step: String(err && err.message || '').split(/\r?\n/)[0].slice(0, 120) });
    if (task.escort && this.hub && this.hub.walls) this.hub.walls.taskEnded(bot, task, fit && fit.attempts ? fit.attempts[fit.attempts.length - 1] : null);
    if (task.raid && this.hub && this.hub.raidDone) this.hub.raidDone(bot, task, false);
    if (task.type === 'daily') this.dailyFailed(day, task.name);
    if (task.type === 'probeEvent') day.events[task.folder] = false;
    if (task.gift) freegifts.ended(this.state(bot), task, false);
    // A crash in Seraph or the engine (compile cache, lost connection, engine exit) says nothing about the event: try
    // that script again in 15 min instead of calling the whole event too hard for the day.
    const ours = /Could not find file|Cached-Scripts|compil|disconnected|engine|exited|ENOENT|EACCES|spawn|timed out/i.test(String(err && err.message || ''));
    if (task.type === 'script' && task.event && ours) {
      bot.skipped = bot.skipped || new Map();
      bot.skipped.why = 'crashed in Seraph or the engine - trying again in 15 min';
      bot.skipped.set(bot.taskKey(task), Date.now() + 15 * 60000);
      bot.journal(`${path.basename(task.path, '.cs')} crashed (${String(err.message).split(/\r?\n/)[0].slice(0, 120)}) - trying it again in 15 min`, 'warn');
    } else if (task.type === 'script' && task.event && !task.style) { (day.eventScripts[task.event] = day.eventScripts[task.event] || []).push(task.path); (day.eventsTooHard = day.eventsTooHard || {})[task.event] = true; }
    if (task.type === 'script' && task.goal) { day.goalChunks++; day.goalsToday[task.goal] = true; this.goalFailed(bot, task.goal); }
    if (task.style) await this.wishEnded(bot, task, false, err);
    // A failed weekly/daily script is not marked done, so next() would pick it straight back up: rest it for an hour.
    if (task.type === 'script' && task.recurring) { bot.skipped = bot.skipped || new Map(); bot.skipped.why = 'failed - trying again in 1 h'; bot.skipped.set(bot.taskKey(task), Date.now() + 3600000); }
    this.saveState(bot);
  }

  // Seasonal events: 2 h a day at most (the owner, 2026-09-24), 1 h until level 100 (2026-09-28: events earned 273 k XP/h
  // with 15 deaths/h against 1.15 M/h grinding). A lower per-character setting still counts.
  eventCapH(bot, lvl = 100) {
    const cap = Math.min(fashion.EVENT_CAP_H, Number(bot.settings.maxEventHours) || fashion.EVENT_CAP_H);
    return Number(lvl) > 0 && Number(lvl) < 100 ? Math.min(cap, EVENT_CAP_BEFORE_100_H) : cap;
  }

  // A me-time task ended: count its time; got it -> celebrate and dress up; not got it -> a strike (two rest it 3 days).
  // A merge that simply ran out of today's hour is not a failure: it picks up tomorrow with the ingredients kept.
  async wishEnded(bot, task, ok, err = null) {
    const day = this.today(bot);
    const st = this.state(bot);
    const spent = Date.now() - (task.startedAt || Date.now());
    if (task.countAs === 'event') { if (task.type !== 'script') day.eventMs += spent; } else if (task.countAs !== 'free') day.styleMs += spent;
    const got = await bot.owns(task.wish).catch(() => false);
    if (got) {
      (st.wishGot = st.wishGot || {})[task.wish] = Date.now();
      if (st.wishFails) delete st.wishFails[task.wish];
      bot._styleDirty = true;
      bot.journal(`got ${task.wish} - dressing up`);
      const line = fashion.say(this.persona(bot), 'wishGot', task.wish);
      if (line) bot.journal(line);
    } else if (/too strong|died \d+x/i.test(String(err && err.message || ''))) {
      const key = fashion.routeKey(task.route || { kind: 'merge', script: task.path });
      (st.routeFails = st.routeFails || {})[key] = Date.now();
      bot.journal(`${task.wish}: too strong for me right now (${String(err.message).slice(0, 80)}) - that route rests 3 days`, 'warn');
    } else if (task.wishEvent && fashion.waitsForEvent(task.wish, day.events || {})) {
      bot.journal(`${task.wish} waits for ${task.wishEvent} to come back`);
    } else if (!ok && !task.wishEvent && Date.now() - (task.startedAt || Date.now()) < 5 * 60000 && (fashion.look(task.wish) || {}).seasonal) {
      // A seasonal piece on a map our event list doesn't know: most likely out of season, not a bad wish. Rest it.
      (st.wishFails = st.wishFails || {})[task.wish] = { n: 2, at: Date.now(), season: true };
      bot.journal(`${task.wish} seems out of season - trying again in a few days`);
    } else if (!ok || Date.now() - (task.startedAt || Date.now()) < 5 * 60000) {
      const f = (st.wishFails = st.wishFails || {})[task.wish] || { n: 0 };
      st.wishFails[task.wish] = { n: f.n + 1, at: Date.now() };
      bot.journal(`${task.wish}: no luck this time (${st.wishFails[task.wish].n}/2)`, 'warn');
    }
    this.saveState(bot);
  }

  goalFailed(bot, id) {
    const st = this.state(bot);
    st.goalFails[id] = (st.goalFails[id] || 0) + 1;
    st.goalFailAt = st.goalFailAt || {};
    st.goalFailAt[id] = Date.now();
    // Three failed tries park the goal for 24 h (brain.json decides); the ledger says so on the dashboard.
    if (st.goalFails[id] >= 3 && bot.ledger && !DRY.getStore()) {
      bot.ledger.item(`goal:${id}`, id);
      bot.ledger.hold(`goal:${id}`, Date.now() + 24 * 3600000, `${st.goalFails[id]} failed tries today`);
    }
  }

  // A task that was stopped before it ended (watchdog, pre-emption, reconnect, skip) still used the day's time.
  async interrupted(bot, task) {
    if (!task || !task.brain) return;
    this.record(bot, task, 'stopped');
    const day = this.today(bot);
    const spent = Date.now() - (task.startedAt || Date.now());
    if (task.type === 'script' && task.event) day.eventMs += spent;
    if (task.style && task.countAs !== 'event' && task.countAs !== 'free') day.styleMs += spent;
    if (task.event && task.type !== 'script') day.eventMs += spent;   // a wish farmed in event time
    if (task.boost === 'exp') day.boostLevelMs = (day.boostLevelMs || 0) + spent;
    // An hour of a goal script is the day's goal chunk, as preempt's dry run already assumes. Without this a restless
    // persona was paused for a daily, next() saw 0 chunks and restarted the goal: Nova paused Forge Elysium/Lament
    // for "daily MineCrafting" 6x on 2026-10-08 and never ran it.
    if (task.type === 'script' && task.goal && spent > 3600000) { day.goalChunks = Math.max(1, day.goalChunks || 0); day.goalsToday[task.goal] = true; }
    this.saveState(bot);
  }

  // The watchdog saw this script stall at the same step twice without gaining anything: stop picking it and move on.
  // Parked work shows on the dashboard; "Try parked work again" (retry) clears it. Returns what was parked.
  // A failed daily is tried again 2 h later, 3 tries a day: bosses in public rooms need players, and players come at
  // busy hours, not at the 04:00 UTC reset.
  dailyFailed(day, name) {
    day.dailies[name] = 'failed';
    day.dailyFails = day.dailyFails || {};
    day.dailyFails[name] = (day.dailyFails[name] || 0) + 1;
    (day.dailyFailAt = day.dailyFailAt || {})[name] = Date.now();
  }
  // Retries start on the shared two-hour windows (crowd.windowAfter), so every failed daily and Lord of Order go back
  // to Artix together instead of one hop each.
  dailyRetry(day, name, now = Date.now()) {
    if (day.dailies[name] !== 'failed') return false;
    const n = (day.dailyFails && day.dailyFails[name]) || 1;
    const at = (day.dailyFailAt && day.dailyFailAt[name]) || 0;
    return n < 3 && now >= crowd.windowAfter(at);
  }

  // opts.deaths: parked by the death cap (hub.deathCap), not by the watchdog.
  park(bot, task, step, opts = {}) {
    const st = this.state(bot);
    const day = this.today(bot);
    let what;
    if (task.type === 'script' && task.event) {
      (day.eventScripts[task.event] = day.eventScripts[task.event] || []).push(task.path);
      what = 'for the rest of today';
    } else if (task.rankClass) {
      (st.rankFails = st.rankFails || {})[task.rankClass] = { n: 2, at: Date.now() };
      what = 'for 24 h';
    } else if (task.goal) {
      st.goalFails[task.goal] = Math.max(3, st.goalFails[task.goal] || 0);
      (st.goalFailAt = st.goalFailAt || {})[task.goal] = Date.now();
      what = 'for 24 h';
    } else if (task.recurring && (task.every || 'week') === 'day') {
      // A daily chain (Lord of Order) stalls on bosses that need other players (Desolich, 8.2M HP), and those players
      // come at busy hours, not at the 04:00 UTC reset: try again in 2 h instead of giving the whole day up
      // (2026-09-27: parked at 04:45, never tried again that day).
      what = 'for 2 h';
    } else if (task.recurring) {
      schedule.markDone(st, task.recurring, task.every || 'week');
      what = `until next ${task.every || 'week'}`;
    } else {
      what = 'for 24 h';
    }
    const until = what === 'for 2 h' ? crowd.windowAfter(Date.now()) : Date.now() + 24 * 3600000;
    const rec = this.record(bot, task, 'parked', { step });
    this.noteWall(bot, task, step, opts);
    if (this.hub && this.hub.walls && task.escort) this.hub.walls.taskEnded(bot, task, rec && rec.attempts ? rec.attempts[rec.attempts.length - 1] : null);
    bot.skipped = bot.skipped || new Map();
    bot.skipped.why = opts.deaths ? String(step) : `stuck twice at "${String(step).slice(0, 100)}" with nothing gained`;
    bot.skipped.set(bot.taskKey(task), until);
    // A me-time wish whose boss kills the character (death cap) rests with its route for days, not a day: Nova died
    // 440 times to Admiral Zheng in a week for a pirate coat, re-tried every 24 h.
    if (task.style && task.wish && opts.deaths) {
      const key = fashion.routeKey(task.route || { kind: 'merge', script: task.path });
      (st.routeFails = st.routeFails || {})[key] = Date.now();
      (st.wishFails = st.wishFails || {})[task.wish] = { n: 2, at: Date.now() };
      what = 'for 3 days (the boss is too strong for now)';
    }
    this.saveState(bot);
    bot.journal(`parked "${task.why || task.path}" ${what}: ${opts.deaths ? step : `stuck twice at "${step}" with nothing gained`}`, 'warn');
    return what;
  }

  // Scripts have no time limit, so the brain has to be asked whether something more important is due while one
  // runs: a new day's dailies, an event going live, the week's content, a full backpack, assisting the owner. A dry run of
  // next() (state restored afterwards, as in ahead()); returns that task, or null to keep going.
  // A free gift to claim now: its event was found live today and this version of the script was not claimed yet.
  giftDue(bot, lvl) {
    const live = Object.fromEntries(Object.entries(this.today(bot).events || {}).filter(([, v]) => !!v));
    const gift = freegifts.next(this.state(bot), { level: lvl, events: live });
    return gift && !(bot.isSkipped && bot.isSkipped(gift)) ? gift : null;
  }

  async preempt(bot) {
    const cur = bot.current;
    // An order (Claude's or the owner's, queued) on a party character gives way to the day's dailies too: Valen's Forge
    // Elysium order (no time limit) ran through a whole day with no daily and no Lord of Order step (2026-10-10), and each
    // missed LoO day moves the ultras a day. Only dailies and recurring daily chains - never events or me time. The owner's
    // own accounts (kind 'guest') run their orders untouched.
    // A free gift (lib/freegifts.js) is one claim of a few minutes while its event lasts: it goes ahead of anything but a
    // raid - Lord of Order and long orders included. Sable (LoO at a 963k-HP boss for hours) and Valen (a Forge order)
    // still had their 500 free birthday ACs unclaimed on 2026-10-10 while the other two had theirs.
    if (cur && !cur.raid && !cur.gift && !(bot.account && bot.account.kind === 'guest') && bot.settings.autopilot !== false) {
      const gift = this.giftDue(bot, await bot.level().catch(() => 0));
      if (gift) return { ...gift, beforeOrder: true };
    }
    const order = cur && !cur.brain && cur.type === 'script' && !(bot.account && bot.account.kind === 'guest') && bot.settings.autopilot !== false;
    if (!cur || (!cur.brain && !order) || (cur.type !== 'script' && !cur.style) || cur.recurring || cur.raid) return null;
    if (cur.escort && this.hub && this.hub.walls && this.hub.walls.isOn(cur.escort)) return null;   // the party is with it
    // An event script stops once today's event time (the persona's maxEventHours) is used up. The cap used to be checked
    // only when an event script started, and scripts have no time limit, so events ran 5-6.5 h a day against a 1.3-3 h
    // cap (2026-09-22). Seasonal story rewards come back every year and don't help the ultras, so the cap holds; the
    // script carries on tomorrow (Skua skips the steps already done).
    let capH = 0;
    if (cur.event) {
      const maxH = this.eventCapH(bot, await bot.level().catch(() => 100));
      if (this.today(bot).eventMs + (Date.now() - (cur.startedAt || Date.now())) < maxH * 3600000) return null;
      capH = maxH;
    }
    // Me time: when today's allowance is used up, the character decides whether to spend another hour on its look
    // (fashion.keepGoing: vanity, and only while the farm is moving) - never past 4 h a day.
    let styleStop = null;
    if (cur.style && cur.countAs !== 'event' && cur.countAs !== 'free') {
      const d0 = this.today(bot);
      const used = d0.styleMs + (Date.now() - (cur.startedAt || Date.now()));
      const mark = bot.stats.drops + bot.stats.quests + (bot.scriptActivityAt || 0);
      if (cur._mark === undefined) cur._mark = mark;
      if (used >= d0.styleAllowMs) {
        const decision = fashion.keepGoing(this.persona(bot), used, mark !== cur._mark);
        cur._mark = mark;
        if (decision.go) {
          d0.styleAllowMs = Math.min(fashion.STYLE_MAX_MS, d0.styleAllowMs + 3600000);
          this.saveState(bot);
          bot.journal(`me time: another hour on ${cur.wish} (${Math.round(used / 60000)} min today, ${decision.why})`);
          const line = fashion.say(this.persona(bot), 'wishMore', cur.wish);
          if (line) bot.journal(line);
        } else {
          styleStop = decision.why;
        }
      }
    }
    const freshStyle = !cur.style && this.today(bot).styleMs === 0;
    let next = null;
    try {
      next = await this.dryRun(bot, async () => {
        const d = this.today(bot);
        const now = Date.now();
        if (capH) d.eventMs = Math.max(d.eventMs, capH * 3600000);   // the dry run must not pick an event again
        if (styleStop) d.styleMs = Math.max(d.styleMs, d.styleAllowMs);
        // Gear, wardrobe and barber can wait for the script to end; so can a backpack that still has room. Marking them
        // done in the dry run lets next() reach the dailies and events below them.
        d.enhancedAt = now; d.styledAt = now; this.state(bot).barberAt = now;
        if ((await bot.freeSlots().catch(() => 99)) > 2) { d.soldAt = now; d.bankedAt = now; }
        // A restless persona does its dailies after one goal chunk: an hour of a long script counts as that chunk.
        if (now - (cur.startedAt || now) > 3600000) d.goalChunks = Math.max(1, d.goalChunks || 0);
        return this.next(bot);
      });
    } catch (e) { next = null; }
    if (styleStop) {
      // The wish waits for tomorrow; the day's own work comes back.
      const day = this.today(bot); day.styleMs = Math.max(day.styleMs, day.styleAllowMs - (Date.now() - (cur.startedAt || Date.now()))); this.saveState(bot);
      const line = fashion.say(this.persona(bot), 'wishStop', cur.wish);
      if (line) bot.journal(line);
      return { ...(next || { type: 'wait', minutes: 1, brain: true, why: 'back to work' }), styleCap: styleStop };
    }
    if (!next || bot.taskKey(next) === bot.taskKey(cur)) return null;
    if (order) return next.type === 'daily' || (next.type === 'script' && next.recurring && next.every === 'day') ? { ...next, beforeOrder: true } : null;
    if (capH) return { ...next, eventCap: capH };
    const urgent = ['assist', 'follow', 'bankAc', 'sellJunk', 'tidy', 'daily', 'probeEvent'].includes(next.type)
      || (next.type === 'script' && (next.event || next.recurring || next.seat || next.raid))
      || (next.style && freshStyle)    // the day's hour of me time, once
      || next.boost;                   // a double-XP day started
    // (A goal used to give way to the XP grind here: the owner 2026-10-05, goals come first - they give XP too.)
    return urgent ? next : null;
  }

  // The admin dashboard's "plan ahead": the queue, what the brain would pick next (a dry run: its state is copied
  // first and restored after), classes still to rank, Farmer Joe, today's dailies and the goals ahead.
  async ahead(bot) {
    // A stopped bot still has its stop flag up, which makes every game read abort: lower it for the preview.
    const idle = !bot.running;
    const wasStop = bot.stopFlag;
    if (idle) bot.stopFlag = false;
    let next = null;
    try { next = bot.settings.autopilot === false ? null : await this.dryRun(bot, () => this.next(bot)); } catch (e) { next = { error: e.message }; }
    finally { if (idle && !bot.running) bot.stopFlag = wasStop; }
    const st = this.state(bot);
    const day = this.today(bot);
    const lvl = await bot.level().catch(() => 0);
    const rankFails = st.rankFails || {};
    const unranked = await bot.unrankedClasses().catch(() => []);
    const plan = await this.plan(bot).catch(() => null);
    return {
      autopilot: bot.settings.autopilot !== false,
      current: bot.current,
      queue: bot.queue,
      brainNext: next,
      rankUps: unranked.map((c) => ({ ...c, rank: rankOf(c.cp), parkedUntil: rankFails[c.name] && rankFails[c.name].n >= 2 ? rankFails[c.name].at + 24 * 3600000 : null })),
      farmerJoe: { off: !!bot.settings.noFarmerJoe, doneAt: st.fjDoneAt || null, failsToday: (st.goalFails || {})['farmer-joe'] || 0 },
      dailies: knowledge.dailies().filter((d) => d.runnable && d.minLevel <= lvl).map((d) => ({ name: d.name, status: day.dailies[d.name] || 'to do' })),
      stage: plan ? plan.stage : null,
      goals: plan ? plan.goals.filter((g) => g.status !== 'owned').slice(0, 20) : [],
      // What is resting and why, and the measured XP per hour of each route (lib/ledger.js).
      ledger: bot.ledger ? bot.ledger.summary() : null,
      walls: this.hub && this.hub.walls ? this.hub.walls.summary() : null,
      eta: await require('./eta').forBot(bot, this.hub).catch(() => null),
    };
  }

  // Progress summary for the dashboard: stage, goal status list, persona card.
  async plan(bot) {
    const online = await bot.playing().catch(() => false);
    const lvl = online ? await bot.level() : 0;
    const g = this.goals(bot);
    const st = this.state(bot);
    const goals = [];
    for (const goal of g.goals) {
      let status = lvl >= goal.when ? 'ready' : 'later';
      if (online && goal.have && (await bot.owns(goal.have).catch(() => false))) status = 'owned';
      else if (online && goal.haveQuest && (await bot.completedOnce(goal.haveQuest).catch(() => false))) status = 'owned';
      else if (g.paused.includes(goal.id)) status = 'paused';
      else if (online && goal.needsAc && Number(await bot.g('world.myAvatar.objData.intCoins', 0)) < goal.needsAc && !(goal.haveQuest && await bot.completedOnce(goal.haveQuest).catch(() => false))) status = 'needs AC';
      else if (online && goal.requiresQuest && !(await bot.completedOnce(goal.requiresQuest).catch(() => false))) status = 'locked';
      else if (online && goal.requiresHave && !(await bot.owns(goal.requiresHave).catch(() => true))) status = 'locked';
      // Only while the 24 h rest runs (goalReady skips it the same way): "stuck" on a goal that failed days ago is a
      // stale count, and it made a free goal read as stuck (2026-10-25).
      else if ((st.goalFails[goal.id] || 0) >= 3 && Date.now() - ((st.goalFailAt || {})[goal.id] || 0) < 24 * 3600000) status = 'stuck';
      goals.push({ id: goal.id, label: goal.label, when: goal.when, purpose: goal.purpose, must: !!goal.must, ultra: !!goal.ultra, gear: !!goal.gear, signature: !!goal.signature, status });
    }
    return { level: lvl, stage: progression.stageFor(lvl || 1), goals, persona: personas.card(this.persona(bot)) };
  }
}

module.exports = { Brain, DEFAULT_GOALS };
