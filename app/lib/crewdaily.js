// Crew dailies, the hub side (the owner 2026-10-25: "Nsod daily bosses allow 7 in the room so how is my main stuck? ... the
// Nulgath farming item daily quest should be run by all bots daily and they all help each other so no one gets stuck").
//
// The old way: every character ran the daily by itself, whenever its brain got to it, in a room of its own. The main
// died twice to Warlord Icewing alone and skipped the daily; three girls waited for strangers in public rooms; a help
// call found nobody, because the helpers were "on their dailies first". A crew daily is one run for everybody:
//
//   round   = the characters that still need the daily (up to 7, the main first) plus helpers who already have it
//   stage   = one hunt step of the daily (a boss and its quest item); all of them in the party's room, fighting it
//             together, until every one that needs it holds the item; the line-up comes from lib/partycomp.js
//   turn-in = each one runs the normal daily, whose hunts are skipped because the items are owned
//   again   = anybody still without it starts the next round, with everybody else as helpers (up to maxRounds)
//
// A round that cannot finish (the stage times out or the crew keeps dying) is retried once with a new line-up, then
// the round ends; after maxRounds the daily goes back to each character alone and the owner gets one alert. Raids pull
// their members out of a crew at any time. Config: lib/crew.json. Status: GET /crew.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { P } = require('./paths');
const { readJson, writeJson, serverDay } = require('./util');
const crew = require('./crew');
const knowledge = require('./knowledge');

const OFF_TYPES = ['assist', 'follow', 'escort', 'armyFarm'];

const methods = {
  // Today's book: rounds started, dailies given up, when the day was first seen (the reset relogs finish first).
  crewBook() {
    const day = serverDay();
    if (!this._crewBook || this._crewBook.day !== day) {
      let b = readJson(path.join(P.ROOT, 'crew.json'), null);
      // Walls outlive the day: a boss the full crew died to twice is left alone for 24 h (crewEnd).
      if (!b || b.day !== day) b = { day, firstSeen: Date.now(), rounds: {}, gaveUp: {}, done: {}, log: [], walls: (b && b.walls) || {} };
      if (!b.walls) b.walls = {};
      this._crewBook = b;
    }
    return this._crewBook;
  },
  crewSave() { try { writeJson(path.join(P.ROOT, 'crew.json'), this._crewBook); } catch (e) { /* memory still has it */ } },
  crewLog(text) {
    const b = this.crewBook();
    b.log.push({ at: new Date().toISOString(), text });
    if (b.log.length > 60) b.log.splice(0, b.log.length - 60);
    this.info(`crew: ${text}`);
  },

  // Does the crew run this daily for this character (so the brain leaves it alone)? Not once the crew gave up on it for
  // today, or after fallbackHours without a finish - then each character tries by itself as before.
  crewOwns(bot, name) {
    if (!crew.enabled(name) || (this.settings && this.settings.crew === false)) return false;
    const b = this.crewBook();
    if (this.crewWall(name)) return true;      // walled: nobody tries it alone either (they would only die at the same boss)
    if (b.gaveUp[name]) return false;
    if (Date.now() - b.firstSeen > crew.cfg.fallbackHours * 3600000 && !this.crew) return false;
    return true;
  },

  // The boss that beat the full crew twice in a row, while its 24 h last.
  crewWall(name, now = Date.now()) {
    const w = this.crewBook().walls[name];
    return w && w.until && w.until > now ? w : null;
  },

  // Free to be pulled into a crew right now: logged in, on autopilot work, not in a raid, a help call or a chore of the owner's.
  crewFree(b, now = Date.now()) {
    const H = this.constructor;
    if (!b || !b.running || b.paused || !b.serverName) return false;
    if (b.account && b.account.status && b.account.status !== 'active') return false;
    const c = b.client;
    if (c && (c._holdOffline || (c._standAsideUntil && c._standAsideUntil > now) || (c.state && c.state.loaded === false))) return false;
    if (H.isGuest(b) && !H.helper(b)) return false;
    if (this.raid && this.raid.members.includes(b.id)) return false;
    if (this.assistFor && this.assistFor(b)) return false;
    const t = b.current;
    if (t && (t.raid || OFF_TYPES.includes(t.type))) return false;
    // The owner's main only on autopilot work: a queued order of his, or a task he gave, is his (like hub.raidMain).
    if (H.isGuest(b) && (!t || !t.brain || (b.queue || []).length)) return false;
    return true;
  },

  // Does this character still need the daily today?
  async crewNeeds(b, name) {
    const d = knowledge.dailies().find((x) => x.name === name);
    if (!d || !d.runnable) return false;
    const lvl = await this.levelOf(b);
    if (lvl < Math.max(d.minLevel || 0, (crew.cfg.dailies[name] || {}).minLevel || 0)) return false;
    const day = this.brain.today(b);
    if (day.dailies[name] === 'done' || day.dailies[name] === 'unavailable') return false;
    if (d.enough && (await this.brain.held(b, d.enough[0])) >= d.enough[1]) return false;
    for (const q of d.quests) if (await b.questAvailable(q)) return true;
    return false;
  },

  async crewTick(now = Date.now()) {
    if ((this.settings && this.settings.crew === false) || this._crewBusy || !this.brain) return null;
    this._crewBusy = true;
    try {
      if (this.crew) return await this.crewCheck(this.crew, now);
      if (this.raid || this.army || (this.anyHelp ? this.anyHelp(now) : this.help && now < this.help.until)) return null;
      if (this._crewPause && now < this._crewPause) return null;
      return await this.crewMaybeStart(now);
    } catch (e) {
      this.info(`crew: ${e.message}`);
      return null;
    } finally { this._crewBusy = false; }
  },

  async crewMaybeStart(now) {
    const book = this.crewBook();
    if (now - book.firstSeen < crew.cfg.afterResetMin * 60000) return null;
    for (const name of crew.names()) {
      if (book.gaveUp[name] || this.crewWall(name, now)) continue;
      if (this._crewIdle && this._crewIdle[name] > now) continue;     // nobody needed it a moment ago
      const d = knowledge.dailies().find((x) => x.name === name);
      const stages = crew.stagesFor(d);
      if (!stages.length) continue;
      const free = [...this.bots.values()].filter((b) => this.crewFree(b, now));
      const needy = [];
      for (const b of free) if (await this.crewNeeds(b, name)) needy.push(b);
      if (!needy.length) {
        // Nobody free needs it: look again in 5 min (a busy character, or the main once the owner logs out, may still).
        (this._crewIdle = this._crewIdle || {})[name] = now + 5 * 60000;
        continue;
      }
      // The round cap only matters while somebody still needs the daily; after the last turn-in it is simply done.
      if ((book.rounds[name] || 0) >= crew.cfg.maxRounds) { this.crewGiveUp(name, `${book.rounds[name]} rounds`); continue; }
      if (free.length < crew.cfg.minCrew) {
        if (!this._crewWaitNote || now - this._crewWaitNote > 3600000) { this._crewWaitNote = now; this.crewLog(`${name}: ${needy.length} need it, only ${free.length} free - waiting for company (${crew.cfg.minCrew} at least)`); }
        continue;
      }
      const entry = async (b) => ({ id: b.id, guest: this.constructor.isGuest(b), level: await this.levelOf(b) });
      const nEntries = []; for (const b of needy) nEntries.push(await entry(b));
      const hEntries = []; for (const b of free) if (!needy.includes(b)) hEntries.push(await entry(b));
      const room = crew.pickRoom(nEntries, hEntries);
      // A stage that runs an army script (Flibbitiestgibbet) needs a class plan first - the owner's main as Legion Revenant, at
      // least one each of Lord of Order, StoneCrusher and Void Highlord. No plan, no point farming the earlier stages.
      const sc = stages.map((s) => crew.scriptFor(s)).find(Boolean);
      let plan = null;
      if (sc) {
        plan = await this.crewSeatPlan(room.all.map((m) => m.id), sc);
        if (plan.error) {
          const key = `${name}:${plan.error}`;
          if (this._crewPlanNote !== key || now - (this._crewPlanAt || 0) > 3600000) { this._crewPlanNote = key; this._crewPlanAt = now; this.crewLog(`${name}: waiting - ${plan.error}`); }
          continue;
        }
      }
      return this.crewStart(name, d, stages, room, now, plan);
    }
    return null;
  },

  crewStart(name, d, stages, room, now, plan = null) {
    const book = this.crewBook();
    const round = (book.rounds[name] = (book.rounds[name] || 0) + 1);
    const c = this.crew = {
      id: `crew-${name}-${now}`, daily: name, quest: d.quests[0], stages, i: 0, tries: 1, token: '0.1', phase: 'stage', round,
      members: room.all.map((m) => m.id), needy: room.needy.map((m) => m.id), helpers: room.helpers.map((m) => m.id),
      size: room.all.length, room: (this.settings.levelParty || {}).room, startedAt: now, stageAt: now, best: 0, bestAt: now, deaths: 0, deathsSinceProgress: 0,
      plan, ended: {}, scriptStage: !!crew.scriptFor(stages[0]),
    };
    c.h = this.crewHelp(c);
    if (plan) this.crewScriptPrep(c);
    this.crewSave();
    const label = (id) => { const b = this.bot(id); return (b && b.account && b.account.label) || id; };
    this.crewLog(`${name} round ${round}: ${c.needy.map(label).join(', ')} need it${c.helpers.length ? `; ${c.helpers.map(label).join(', ')} help` : ''} - stage 1/${stages.length} ${stages[0].monster} in ${stages[0].map}-${c.room}`);
    if (plan) this.crewLog(`army plan: ${plan.order.map((id) => `${label(id)} ${plan.seats[id]}`).join(', ')}`);
    this.notify(`Crew daily: ${name}`, `${c.members.length} characters meet in the party's room: ${stages.map((s) => s.monster).join(' > ')}`, 'info');
    for (const id of c.members) { const b = this.bot(id); if (b) Promise.resolve(b.runNow(this.crewTaskFor(b, c))).catch(() => null); }
    return c;
  },

  // A one-off boss round (the owner 2026-10-28: "go with the party army" for Nightmare Carnax). crew.json "bosses": one stage run
  // by its army script; every member without the item needs it, the rest help, and the round ends when they all hold it.
  // The owner's main comes along whatever it is doing (this is his order); the others when they are logged in and free of raids.
  async crewBossStart(name, now = Date.now()) {
    const def = crew.boss(name);
    if (!def || !def.stage) return { ok: false, error: `no crew boss ${name}` };
    if (this.crew) return { ok: false, error: `a crew round is on already (${this.crew.daily})` };
    if (this.raid) return { ok: false, error: 'an ultra raid is on - start it after the raid' };
    const H = this.constructor;
    const stage = Object.assign({}, def.stage, { map: String(def.stage.map).toLowerCase() });
    const sc = crew.scriptFor(stage);
    const up = (b) => !!(b && b.running && !b.paused && b.serverName && !(b.account && b.account.status && b.account.status !== 'active')
      && !(b.client && (b.client._holdOffline || (b.client._standAsideUntil && b.client._standAsideUntil > now)))
      && (!H.isGuest(b) || H.helper(b)) && !(this.assistFor && this.assistFor(b)));
    const needy = []; const helpers = [];
    for (const b of this.bots.values()) {
      if (!up(b)) continue;
      const level = await this.levelOf(b);
      if (level < (def.minLevel || 0)) continue;
      const has = (Number(await b.count(stage.item).catch(() => 0)) || 0) >= (stage.qty || 1);
      (has ? helpers : needy).push({ id: b.id, guest: H.isGuest(b), level });
    }
    if (!needy.length) return { ok: false, error: `everyone here already has ${stage.item}` };
    // Some bosses take fewer (bosses.<name>.maxRoom): Nightmare Carnax buffs only 4. A small room is filled so the army
    // script's classes are there: the main, then one owner of each needed class (those who need the item first), then rank.
    const max = def.maxRoom || crew.cfg.maxRoom;
    let room = crew.pickRoom(needy, helpers, max);
    if (sc && (sc.need || []).length && needy.length + helpers.length > max) {
      const fightplan = require('./fightplan');
      const lc = (x) => String(x || '').toLowerCase();
      const ranked = [...crew.rank(needy), ...crew.rank(helpers)];
      const owns = {};
      for (const m of ranked) owns[m.id] = fightplan.rank10(await this.bot(m.id).classPoints().catch(() => [])).map(lc);
      const pick = [];
      const add = (m) => { if (m && !pick.includes(m) && pick.length < max) pick.push(m); };
      add(ranked.find((m) => m.guest));
      for (const cls of sc.need) {
        const wanted = sc.need.filter((c) => lc(c) === lc(cls)).length;
        if (pick.filter((m) => !(sc.needMain && m.guest) && owns[m.id].includes(lc(cls))).length >= wanted) continue;
        add(ranked.find((m) => !pick.includes(m) && !m.guest && owns[m.id].includes(lc(cls))));
      }
      for (const m of ranked) add(m);
      room = { needy: pick.filter((m) => needy.includes(m)), helpers: pick.filter((m) => helpers.includes(m)), all: pick };
    }
    if (room.all.length < crew.cfg.minCrew) return { ok: false, error: `only ${room.all.length} free - ${crew.cfg.minCrew} at least` };
    let plan = null;
    if (sc) {
      plan = await this.crewSeatPlan(room.all.map((m) => m.id), sc);
      if (plan.error) return { ok: false, error: plan.error };
    }
    const c = this.crewStart(name, { quests: [stage.quest] }, [stage], room, now, plan);
    c.boss = true;
    this.crewSave();
    return { ok: true, crew: this.crewStatus().now };
  },

  // The pseudo help call lib/partycomp.js plans the line-up from (hub.partySeat reads it).
  crewHelp(c) {
    const stage = c.stages[c.i] || c.stages[c.stages.length - 1];
    const H = this.constructor;
    const by = c.members.find((id) => { const b = this.bot(id); return b && !H.isGuest(b); }) || c.members[0];
    return { id: `${c.id}:${c.token}`, by, helpers: c.members.filter((id) => id !== by), who: 'Crew', monster: stage.monster, map: stage.map, hpMax: null, until: Infinity };
  },

  // Characters' classes for the army script, from what each owns at rank 10 (lib/crew.js seatPlan).
  async crewSeatPlan(ids, sc) {
    const fightplan = require('./fightplan');
    const H = this.constructor;
    const members = [];
    for (const id of ids) {
      const b = this.bot(id);
      if (!b) continue;
      members.push({ id, guest: H.isGuest(b), level: await this.levelOf(b), classes: fightplan.rank10(await b.classPoints().catch(() => [])), current: await b.className().catch(() => '') });
    }
    return crew.seatPlan(members, sc);
  },

  // The v3 script's options for this crew (written by each member's engine into skua-options/<storage>.cfg, all the same):
  // "Class1..7 = ClassName,Username" in seat order, ArmySize, our own gear (no auto-enhance), potions as the crew config says.
  crewScriptOptions(c, sc) {
    const ids = (c.plan.order || c.members).filter((id) => c.members.includes(id));
    const o = { ArmySize: ids.length, DoEnh: 'False', UsePotions: sc.potions === false ? 'False' : 'True', PotionQuantity: 10 };
    ids.forEach((id, i) => { const b = this.bot(id); o[`Class${i + 1}`] = `${c.plan.seats[id]},${(b && b.account && (b.account.username || b.account.label)) || id}`; });
    for (let i = ids.length + 1; i <= 7; i++) o[`Class${i}`] = '';
    return o;
  },

  // The army's sync files from an earlier try (a roster that is no longer the roster would count toward "registered 7/7"
  // for up to 10 min): Skua keeps them in <config>/Skua and <config>/Skua/Options.
  crewClearSync() {
    const base = process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'Skua') : path.join(os.homedir(), '.config', 'Skua');
    const names = ['flibbi_class-v3.sync', 'Flibbitiestgibbet.sync', 'FlibbitiestgibbetBuffs.sync', 'UltraItemCheck.sync', 'FlibbitiestgibbetWipeDead.sync', 'FlibbitiestgibbetWipeAlive.sync',
      'nightmarecarnax_class-v3.sync', 'darkcarnax.sync', 'NightmareCarnaxWipeDead.sync', 'NightmareCarnaxWipeAlive.sync'];
    for (const dir of [base, path.join(base, 'Options')]) for (const n of names) { try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* not there */ } }
  },

  // Before the army script: the vendored scripts in the library, and who drinks potions (the v3 gate reads raid-potions.txt).
  crewScriptPrep(c) {
    const sc = crew.scriptFor(c.stages.find((s) => crew.scriptFor(s)));
    try { require('./ultras').install(); } catch (e) { this.crewLog(`could not install the army scripts: ${e.message}`); }
    this.crewClearSync();
    const H = this.constructor;
    const lines = c.members.map((id) => {
      const b = this.bot(id);
      const on = sc.potions !== false && (!H.isGuest(b) || (this.settings && this.settings.mainPotions) !== false);
      return `${(b && b.account && (b.account.username || b.account.label)) || id}=${on ? 'on' : 'off'}`;
    });
    try { fs.writeFileSync(path.join(P.ROOT, 'raid-potions.txt'), lines.join('\n') + '\n'); } catch (e) { this.crewLog(`could not write the potions file: ${e.message}`); }
  },

  // The member's army script ended (the army finished, or the fight was called off): it waits a moment instead of starting it
  // again at once; the crew tick decides whether the stage is over.
  crewScriptEnded(bot, task) {
    const c = this.crew;
    if (c && c.id === task.crew) (c.ended = c.ended || {})[bot.id] = { at: Date.now(), token: task.token };
  },

  crewTaskFor(b, c) {
    const s = c.stages[c.i];
    const sc = crew.scriptFor(s);
    if (sc && c.plan) {
      const cls = c.plan.seats[b.id];
      return {
        type: 'script', path: sc.script, storage: sc.storage, options: this.crewScriptOptions(c, sc), crewScript: true, crew: c.id, token: c.token, daily: c.daily,
        room: c.room, seat: { cls }, monster: s.monster, item: s.item, qty: s.qty,
        why: `crew daily ${c.daily}: the ${s.monster} army fight as ${cls}`,
      };
    }
    return {
      type: 'crewHunt', crew: c.id, token: c.token, daily: c.daily, who: 'Crew', map: s.map, room: c.room, cell: s.cell, pad: s.pad || 'Left',
      monster: s.monster, item: s.item, qty: s.qty, quest: s.quest, needy: c.needy.includes(b.id), minutes: crew.cfg.stageMaxMin,
      why: `crew daily ${c.daily}: ${s.monster} in ${s.map} (${s.item} ${s.qty})${c.needy.includes(b.id) ? '' : ' - helping'}`,
    };
  },

  // The bot loop asks for this before its own work (like helpTask): a member that finished its stage task, or came back
  // from a restart, goes straight to the crew's current stage.
  crewTask(bot) {
    const c = this.crew;
    if (!c || c.phase !== 'stage' || !c.members.includes(bot.id)) return null;
    const e = c.ended && c.ended[bot.id];
    if (e && e.token === c.token && Date.now() - e.at < 90000 && crew.scriptFor(c.stages[c.i])) return { type: 'wait', minutes: 1, crew: c.id, why: 'crew: the army fight is over for me - waiting for the others' };
    return this.crewTaskFor(bot, c);
  },

  crewStillIn(b, c, now) {
    if (!b || !b.running || b.paused || !b.serverName) return false;
    const cl = b.client;
    if (cl && (cl._holdOffline || (cl._standAsideUntil && cl._standAsideUntil > now))) return false;
    if (this.raid && this.raid.members.includes(b.id)) return false;
    const t = b.current;
    if (t && (t.raid || t.type === 'assist')) return false;
    return true;
  },

  async crewCheck(c, now) {
    // Members that left (offline, the owner took the main, a raid called them) are dropped; the rest carry on.
    const gone = c.members.filter((id) => !this.crewStillIn(this.bot(id), c, now));
    if (gone.length) {
      c.members = c.members.filter((id) => !gone.includes(id));
      c.needy = c.needy.filter((id) => !gone.includes(id));
      c.helpers = c.helpers.filter((id) => !gone.includes(id));
      this.crewLog(`${gone.join(', ')} left the crew (offline, in a raid or being played)`);
      if (c.phase === 'stage') { c.token = `${c.i}.${c.tries}.${now}`; c.h = this.crewHelp(c); }
      // The army script is seated for exactly these characters: re-plan without the ones who left, or end the round.
      if (c.phase === 'stage' && c.plan) {
        const sc0 = crew.scriptFor(c.stages.find((s) => crew.scriptFor(s)));
        const plan = await this.crewSeatPlan(c.members, sc0);
        if (plan.error) {
          const book = this.crewBook();
          book.rounds[c.daily] = Math.max(0, (book.rounds[c.daily] || 1) - 1);
          return this.crewEnd(c, false, `${plan.error} now - not counted, it starts again when they are free`);
        }
        c.plan = plan;
        if (c.scriptStage) this.crewRestart(c);
      }
    }
    // Too many gone at once (a raid took the veterans): the rest would only die at a boss they cannot kill. The round ends
    // without counting and the next one starts when they are free again - the items already won stay in the bags.
    if (gone.length && c.phase === 'stage' && c.members.length < Math.max(4, Math.ceil((c.size || c.members.length) * 0.6))) {
      const book = this.crewBook();
      book.rounds[c.daily] = Math.max(0, (book.rounds[c.daily] || 1) - 1);
      return this.crewEnd(c, false, `only ${c.members.length} of ${c.size} are left - not counted, it starts again when they are free`);
    }
    if (!c.needy.length) return this.crewEnd(c, false, 'nobody who needs it is left');
    if (c.members.length < 2) return this.crewEnd(c, false, 'the crew is down to one');

    if (c.phase === 'turnin') {
      let pending = 0;
      for (const id of c.needy) { const day = this.brain.today(this.bot(id)); if (day.dailies[c.daily] !== 'done' && day.dailies[c.daily] !== 'failed') pending++; }
      if (!pending || now - c.turnAt > 15 * 60000) return this.crewEnd(c, true, 'turned in');
      return null;
    }

    const stage = c.stages[c.i];
    let progress = 0; const behind = [];
    for (const id of c.needy) {
      const n = Number(await this.bot(id).count(stage.item).catch(() => 0)) || 0;
      progress += Math.min(n, stage.qty);
      if (n < stage.qty) behind.push(id);
    }
    const lacking = behind.length;
    if (progress > c.best) { c.best = progress; c.bestAt = now; c.deathsSinceProgress = 0; }
    if (!lacking) return this.crewAdvance(c, now);
    // One weak character that cannot get the item (it dies before it lands a hit) must not hold the others: once most of the
    // crew has it and nothing new came for stragglerMin minutes, the stage is over for them and the stragglers get the next round.
    if (!crew.scriptFor(stage) && c.needy.length - lacking >= Math.ceil(c.needy.length * 0.6) && now - c.bestAt > crew.cfg.stragglerMin * 60000) {
      c.needy = c.needy.filter((id) => !behind.includes(id));
      c.helpers.push(...behind);
      this.crewLog(`${behind.join(', ')} fell behind at ${stage.monster} (no ${stage.item}) - the others go on, ${behind.length > 1 ? 'they get' : 'it gets'} the next round`);
      return this.crewAdvance(c, now);
    }
    // An army script is a long fight that wipes and recovers by itself: only its own time limit counts, no death wall.
    const sc = crew.scriptFor(stage);
    const maxMin = sc ? sc.maxMin : crew.cfg.stageMaxMin;
    const maxTries = sc ? sc.tries : crew.cfg.stageTries;
    const wallHit = !sc && c.deathsSinceProgress >= crew.cfg.wallDeaths;
    const stuck = now - c.stageAt > maxMin * 60000 || wallHit;
    if (!stuck) return null;
    const why = wallHit ? `${c.deathsSinceProgress} deaths without a kill` : `${maxMin} min`;
    if (c.tries >= maxTries) return this.crewEnd(c, false, `${stage.monster} ${why} - ${lacking} of ${c.needy.length} still without ${stage.item}`, wallHit ? { wall: stage.monster } : null);
    // Once more with a new line-up: the deaths of this try make the planner seat another support.
    this.recordHelp({ monster: stage.monster, kills: c.best > 0 ? 1 : 0, deaths: c.deaths });
    c.tries++; c.stageAt = now; c.deaths = 0; c.deathsSinceProgress = 0; c.token = `${c.i}.${c.tries}`;
    c.h = this.crewHelp(c);
    this.crewLog(`${stage.monster} took ${why} (${lacking} of ${c.needy.length} without ${stage.item}) - trying again${sc ? ' (the army starts over)' : ' with a new line-up'}`);
    if (sc) { c.ended = {}; this.crewRestart(c); }
    return c;
  },

  crewAdvance(c, now) {
    const done = c.stages[c.i];
    this.recordHelp({ monster: done.monster, kills: 1, deaths: c.deaths });
    c.i++; c.tries = 1; c.stageAt = now; c.best = 0; c.bestAt = now; c.deaths = 0; c.deathsSinceProgress = 0; c.token = `${c.i}.1`;
    // A boss round has no daily to turn in: its army script turns the quest in, and everyone now holds the item.
    if (c.i >= c.stages.length) return c.boss ? this.crewEnd(c, true, `every one of them has ${done.item}`) : this.crewTurnIn(c, now);
    c.h = this.crewHelp(c);
    c.scriptStage = !!crew.scriptFor(c.stages[c.i]);
    c.ended = {};
    const s = c.stages[c.i];
    this.crewLog(`${done.monster} done - stage ${c.i + 1}/${c.stages.length}: ${s.monster} in ${s.map}`);
    return c;
  },

  // Everybody who needed it runs the normal daily now: its hunts see the items and skip, the quest is turned in.
  crewTurnIn(c, now) {
    c.phase = 'turnin'; c.turnAt = now;
    this.crewLog(`${c.daily}: every stage done - turning in`);
    for (const id of c.needy) {
      const b = this.bot(id);
      if (!b) continue;
      try { const day = this.brain.today(b); if (day.dailies[c.daily] === 'failed') delete day.dailies[c.daily]; if (day.dailyFails) delete day.dailyFails[c.daily]; this.brain.saveState(b); } catch (e) { /* the daily runs anyway */ }
      Promise.resolve(b.runNow({ type: 'daily', name: c.daily, brain: true, crew: c.id, why: `crew daily ${c.daily}: turning in` })).catch(() => null);
    }
    return c;
  },

  // Every member back to the task that fits its new stage (the army script must restart for a new seating).
  crewRestart(c) {
    this.crewClearSync();
    for (const id of c.members) { const b = this.bot(id); if (b) Promise.resolve(b.runNow(this.crewTaskFor(b, c))).catch(() => null); }
  },

  crewEnd(c, ok, why, info = null) {
    if (this.crew === c) this.crew = null;
    // The army script is no one's task once the round is over.
    for (const id of c.members) { const b = this.bot(id); if (b && b.current && b.current.crewScript && b.current.crew === c.id) Promise.resolve(b.restart()).catch(() => null); }
    const book = this.crewBook();
    if (ok) delete book.walls[c.daily];
    else if (info && info.wall && (c.size || 0) >= 5) {
      // A crew of five or more that died to the same boss in two rounds in a row cannot do it this way: leave the daily for 24 h
      // (not for each character to try alone and die) and tell the owner once.
      const prev = book.walls[c.daily];
      const again = prev && prev.stage === info.wall && Date.now() - prev.at < 3 * 3600000;
      const w = book.walls[c.daily] = { stage: info.wall, at: Date.now(), count: again ? (prev.count || 1) + 1 : 1, size: c.size };
      if (w.count >= 2 || (book.rounds[c.daily] || 0) >= crew.cfg.maxRounds) {
        w.until = Date.now() + 24 * 3600000;
        this.crewLog(`${c.daily}: ${info.wall} beat a crew of ${c.size} in ${w.count} rounds - the daily rests for 24 h (it needs more than the generic party fight)`);
        this.notify(`Crew daily ${c.daily} is walled by ${info.wall}`, `A crew of ${c.size} died to it in ${w.count} rounds (Icewing and Hydra Head 90 die in 15 s). It needs the Ultras-v3 army comp for ${info.wall}; resting the daily for 24 h.`, 'alert');
      }
    }
    this._crewPause = Date.now() + (ok ? 60000 : crew.cfg.pauseAfterRoundMin * 60000);
    this.crewLog(`${c.daily} round ${c.round} ${ok ? 'finished' : 'ended'}: ${why}`);
    this.crewSave();
    return null;
  },

  crewGiveUp(name, why) {
    const book = this.crewBook();
    book.gaveUp[name] = true;
    this.crewSave();
    this.crewLog(`${name}: the crew gave up for today (${why}) - each character tries it alone from now on`);
    this.notify(`Crew daily ${name} did not finish`, `${why}. The characters still without it try it alone for the rest of the day; the log is at GET /crew.`, 'alert');
  },

  // A death in the crew's room (hub.bossDeath calls this): stage deaths with no new item since count toward the wall.
  crewDeath(bot, killer) {
    const c = this.crew;
    if (!c || c.phase !== 'stage' || !c.members.includes(bot.id)) return false;
    c.deaths++; c.deathsSinceProgress++;
    return true;
  },

  crewStatus() {
    const book = this.crewBook();
    const c = this.crew;
    return {
      enabled: !(this.settings && this.settings.crew === false), dailies: crew.names(), day: book.day, rounds: book.rounds, gaveUp: book.gaveUp, done: book.done, walls: book.walls,
      now: c ? {
        daily: c.daily, round: c.round, phase: c.phase, stage: c.i + 1, stages: c.stages.length, monster: (c.stages[c.i] || {}).monster, try: c.tries,
        members: c.members, needy: c.needy, helpers: c.helpers, plan: c.plan ? c.plan.seats : null, minutes: Math.round((Date.now() - c.stageAt) / 60000), deaths: c.deaths,
      } : null,
      log: book.log.slice(-15),
    };
  },
};

module.exports = { methods };
