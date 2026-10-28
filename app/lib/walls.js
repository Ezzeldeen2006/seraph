// Walls: the bosses and steps that stop a character's progress, a plan for each, and party escorts
// (audit A2/A3/A6, 2026-09-28; the owner's decision 5: up to two ~45-min escort windows a day, all four in room 13579,
// class-quest bosses on ultra maps included, ultras stay private).
//
// A wall is noted when the brain parks work (the watchdog's "stuck twice at <step>", the death cap's "died 8x to <boss>")
// and from the park lines already in the journal at start. Each wall keeps which work of which character it blocks,
// deaths, the boss's HP and the fight estimate, and a plan:
//   solo    one of them has killed it alone before: the normal retry will do
//   escort  the party goes together: the blocked characters run their own script (quest accepted, their drop), the
//           others `follow` them in the party room; when the blocked step moves on, everything it blocked is un-parked
//   crowd   far too big for four (Desolich): public rooms at busy hours (lib/manners.js)
//   later   the party lost to it (two escorts without progress, or a failed help call): three days, then again
//   skip    only me time or events: cosmetic, never worth an escort
// Escorts run in plan-only mode for the first day (journal "would escort"), then live; hub.json `escorts`:
// "off" | "plan" | "on" overrides that.
'use strict';
const path = require('path');
const fs = require('fs');
const { P } = require('./paths');
const { readJson, writeJson, serverDay } = require('./util');
const crowd = require('./crowd');
const squad = require('./squad');

const ESCORT_MS = 45 * 60000;
// 2026-10-26 (the owner: the new bots must not wait while the first four's walls were cleared): the party sweeps its walls. An
// escort that got somebody past (the party kills a wall boss in seconds to minutes) is followed by the next one 3 min later;
// only escorts without progress back off (2 h) and two of them end the day's windows. 40 walls were waiting on 2 windows a day.
const ESCORTS_PER_DAY = 16;
const FAILED_PER_DAY = 2;
const ESCORT_GAP_MS = 2 * 3600000;
const ESCORT_GAP_AFTER_PROGRESS_MS = 3 * 60000;
const LATER_MS = 3 * 24 * 3600000;
const PLAN_ONLY_MS = 24 * 3600000;
const FAILS_LATER = 2;
const kfmt = (n) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10} M` : n >= 1e3 ? `${Math.round(n / 100) / 10} k` : String(Math.round(n)));

// What a step or a park reason says about the wall.
function parseStep(step) {
  const s = String(step || '');
  let m = /Killing\s+(.+?)\s+for item:\s*"?(.+?)"?\s+(\d+)\s*\/\s*(\d+)\s*$/i.exec(s);
  if (m) return { boss: m[1].trim(), item: m[2].trim(), have: +m[3], want: +m[4] };
  m = /died\s+\d+x\s+to\s+(.+?)\s+in\s+\d+\s+min/i.exec(s);
  if (m) return { boss: m[1].trim() };
  m = /Farming\s+(.+?)\s*\((\d+)\s*\/\s*(\d+)\)/i.exec(s);
  if (m) return { item: m[1].trim(), have: +m[2], want: +m[3] };
  m = /\bKilling\s+(.+?)\s*(?:\(|$)/i.exec(s);
  if (m) return { boss: m[1].trim() };
  return null;
}

// Only the fields that re-create the task (no timestamps, no marks).
const TASK_KEYS = ['type', 'path', 'entry', 'args', 'goal', 'why', 'brain', 'farmerJoe', 'rankClass', 'seat', 'hours', 'style', 'wish', 'route', 'countAs', 'event', 'recurring', 'every'];
function taskCopy(t) {
  const o = {};
  for (const k of TASK_KEYS) if (t && t[k] !== undefined && t[k] !== null) o[k] = t[k];
  return o;
}
const cosmeticTask = (t) => !!(t && (t.style || t.event || t.countAs === 'event' || /^me time:/i.test(String(t.why || ''))));
const dailyTask = (t) => !!(t && (t.type === 'daily' || t.recurring || /daily is up|Dailies\//i.test(`${t.why || ''} ${t.path || ''}`)));

// Fight estimate (A3): time to kill with the party against time to die, from the characters' own fight numbers.
function estimate(stats, bossHp, ownHp, partySize = 4) {
  if (!stats || !bossHp) return null;
  const out = { bossHp };
  if (stats.dps) { out.dps = stats.dps; out.soloTtkMin = Math.round((bossHp / stats.dps / 60) * 10) / 10; out.partyTtkMin = Math.round((bossHp / (stats.dps * partySize) / 60) * 10) / 10; }
  if (stats.hit && ownHp) { out.hit = stats.hit; out.hitsToDie = Math.max(1, Math.round(ownHp / stats.hit)); }
  return out;
}
function describe(w) {
  const e = w.estimate;
  if (!e) return '';
  const parts = [`${w.boss || w.item} ${kfmt(e.bossHp)} HP`];
  if (e.dps) parts.push(`my DPS ~${kfmt(e.dps)} → ${e.soloTtkMin} min alone, ~${e.partyTtkMin} min with the party`);
  if (e.hit) parts.push(`it hits me for ~${kfmt(e.hit)} (${e.hitsToDie} hits and I'm down)`);
  return parts.join('; ');
}

class Walls {
  constructor(hub, file = path.join(P.ROOT, 'walls.json')) {
    this.hub = hub;
    this.file = file;
    this.data = readJson(file, null) || { v: 1, walls: {}, escorts: [], createdAt: Date.now() };
    this.data.walls = this.data.walls || {};
    this.data.escorts = this.data.escorts || [];
    if (!this.data.planOnlyUntil) this.data.planOnlyUntil = Date.now() + PLAN_ONLY_MS;
    // Blocks older than the character's own way past the wall are stale (seeded back from the journal before note()
    // checked for that): drop them.
    // Only the walls that lost a block are planned again, and only when nothing is left (the bots aren't loaded yet,
    // so a solo kill can't be looked up here).
    for (const w of Object.values(this.data.walls)) {
      let changed = false;
      for (const [id, blk] of Object.entries(w.blocks || {})) {
        const past = w.cleared && w.cleared[id];
        if (!past) continue;
        for (const [key, t] of Object.entries(blk.tasks || {})) if (t.at <= past) { delete blk.tasks[key]; changed = true; }
        if (!Object.keys(blk.tasks || {}).length) delete w.blocks[id];
      }
      if (changed && !Object.keys(w.blocks || {}).length) w.plan = { kind: 'cleared', why: 'nothing is blocked by it any more', at: Date.now() };
    }
  }

  save() { try { writeJson(this.file, this.data); } catch (e) { /* next change saves */ } }
  bot(id) { return this.hub && this.hub.bot ? this.hub.bot(id) : null; }
  mode(now = Date.now()) {
    const m = this.hub && this.hub.settings && this.hub.settings.escorts;
    if (m === 'off' || m === 'plan' || m === 'on') return m;
    return now < this.data.planOnlyUntil ? 'plan' : 'on';
  }
  active() { return this.data.active || null; }
  list() { return Object.values(this.data.walls); }

  // Parked work: which wall stopped it. `info`: { boss, hpMax, ownHp, map, cell, deaths, stats }.
  note(bot, task, step, info = {}, now = Date.now()) {
    const p = parseStep(step) || {};
    const boss = info.boss || p.boss || null;
    const item = p.item || null;
    if (!boss && !item) return null;
    if (dailyTask(task)) return null;                     // dailies and Lord of Order: the manners rules and retry windows
    const id = String(boss || item).toLowerCase();
    const w = this.data.walls[id] || (this.data.walls[id] = { id, boss, item, firstAt: now, blocks: {}, deaths: {}, escortFails: 0 });
    // A park from before this character got past the wall (the journal seeding re-reads the last 24 h at every start):
    // Sable's 02:58 Dreadhaven park came back after her 03:00 kill (2026-09-29).
    if (w.cleared && w.cleared[bot.id] && w.cleared[bot.id] >= now) return w;
    Object.assign(w, { lastAt: now });
    if (!w.boss && boss) w.boss = boss;
    if (!w.item && item) w.item = item;
    if (p.want) w.want = p.want;
    if (info.map) w.map = info.map;
    if (info.cell) w.cell = info.cell;
    if (info.hpMax) w.hp = Number(info.hpMax);
    if (info.ownHp) w.ownHp = Math.min(w.ownHp || Infinity, Number(info.ownHp));
    if (info.deaths) w.deaths[bot.id] = (w.deaths[bot.id] || 0) + Number(info.deaths);
    if (info.stats && w.hp) { const e = estimate(info.stats, w.hp, info.ownHp); if (e) w.estimate = e; }
    const blk = w.blocks[bot.id] || (w.blocks[bot.id] = { tasks: {} });
    const key = bot.taskKey ? bot.taskKey(task) : JSON.stringify(taskCopy(task));
    blk.tasks[key] = { task: taskCopy(task), goal: task.goal || null, cosmetic: cosmeticTask(task), step: String(step).slice(0, 200), at: now, have: p.have === undefined ? null : p.have };
    blk.at = now;
    w.plan = this.plan(w, now);
    this.save();
    if (bot.journal) bot.journal(`wall: ${w.boss || w.item} blocks "${task.why || task.goal || task.path}" - plan: ${w.plan.kind} (${w.plan.why})${describe(w) ? ` · ${describe(w)}` : ''}`);
    return w;
  }

  plan(w, now = Date.now()) {
    const blocks = Object.entries(w.blocks);
    if (!blocks.length) return { kind: 'cleared', why: 'nothing is blocked by it any more', at: now };
    const tasks = blocks.flatMap(([, b]) => Object.values(b.tasks));
    if (tasks.every((t) => t.cosmetic)) return { kind: 'skip', why: 'only me time or events - cosmetic', at: now };
    const solo = w.boss && blocks.find(([id]) => { const b = this.bot(id); return b && this.hub.soloBosses && this.hub.soloBosses(b)[w.boss]; });
    if (solo) return { kind: 'solo', why: `${solo[0]} has killed ${w.boss} alone before`, at: now };
    // The ladder (the owner, 2026-10-09): solo -> party -> public last. A guess from HP or a time estimate never skips the
    // party any more (Avatar Tyndarius, 1.5 M HP, was "too big for four" and the party never tried); only a lost
    // party fight sends the work to public rooms.
    if (!crowd.LADDER && w.hp && w.ownHp && w.hp > crowd.MANNERS.hopelessHpRatio * w.ownHp) {
      const busy = this.hub.crowdHours ? this.hub.crowdHours.best(crowd.CROWD_SERVER, 2).map((b) => b.at).join(', ') : '';
      return { kind: 'crowd', why: `${kfmt(w.hp)} HP - four of us would not be enough; public rooms at busy hours${busy ? ` (busiest: ${busy})` : ''}`, at: now };
    }
    const lost = crowd.LADDER ? 'crowd' : 'later';
    const last = crowd.LADDER ? ' - last option: a public room with players' : '';
    if (w.laterUntil && now < w.laterUntil) return { kind: lost, why: `${w.laterWhy || 'the party lost to it'}${last}`, until: w.laterUntil, at: now };
    if (w.boss && this.hub.isPartyWall && this.hub.isPartyWall(w.boss)) return { kind: lost, why: `the whole party lost to it on a help call today${last}`, at: now };
    if (!crowd.LADDER && w.estimate && w.estimate.partyTtkMin > 40) return { kind: 'later', why: `the party would need ~${w.estimate.partyTtkMin} min (${describe(w)})`, at: now };
    return { kind: 'escort', why: `${blocks.length} character(s) blocked - the party kills it together`, at: now };
  }

  // The park lines already in each journal (last 24 h), so today's walls are known right after a restart.
  seedFromJournal(bot, now = Date.now()) {
    const file = path.join(P.account(bot.id), 'journal.log');
    let text = '';
    try {
      const st = fs.statSync(file);
      const fd = fs.openSync(file, 'r');
      const len = Math.min(st.size, 3 * 1048576);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch (e) { return 0; }
    let n = 0;
    for (const line of text.split('\n')) {
      const m = /^(\S+Z) parked "(.+?)" (?:for [^:]+|until [^:]+): (?:stuck twice at "(.+)" with nothing gained|(died \d+x to .+ in \d+ min))/.exec(line);
      if (!m) continue;
      const at = Date.parse(m[1]);
      if (!(at > now - 24 * 3600000)) continue;
      const task = this.hub.brain && this.hub.brain.taskForWhy ? this.hub.brain.taskForWhy(bot, m[2]) : null;
      if (!task) continue;
      if (this.note(bot, task, m[3] || m[4], {}, at)) n++;
    }
    return n;
  }

  // Everything the wall blocked for this character is un-parked: the blocked step moved on.
  clear(bot, w, why, now = Date.now()) {
    const blk = w.blocks[bot.id];
    if (!blk) return [];
    const brain = this.hub.brain;
    const freed = [];
    for (const [key, b] of Object.entries(blk.tasks)) {
      if (bot.skipped) bot.skipped.delete(key);
      if (b.goal && brain && brain.state) {
        const st = brain.state(bot);
        if (st.goalFails) delete st.goalFails[b.goal];
        if (st.goalFailAt) delete st.goalFailAt[b.goal];
        if (bot.ledger) bot.ledger.release(`goal:${b.goal}`);
      }
      if (b.task && b.task.rankClass && brain && brain.state) { const st = brain.state(bot); if (st.rankFails) delete st.rankFails[b.task.rankClass]; }
      freed.push(b.task.why || b.goal || key);
    }
    if (brain && brain.saveState) brain.saveState(bot);
    delete w.blocks[bot.id];
    (w.cleared = w.cleared || {})[bot.id] = now;
    w.plan = this.plan(w, now);
    this.save();
    if (bot.journal) bot.journal(`past ${w.boss || w.item} (${why}) - un-parked: ${freed.join(', ')}`);
    return freed;
  }

  // A class reached rank 10: its rank-up is no longer blocked by anything. Oren's Cryomancer block of 09-28 came
  // from a stale class-point read and outlived the rank; on 10-01 it pulled the whole party into a 9-second escort.
  dropRank(bot, cls, now = Date.now()) {
    let n = 0;
    for (const w of this.list()) {
      const blk = w.blocks[bot.id];
      if (!blk) continue;
      for (const [key, b] of Object.entries(blk.tasks)) if (b.task && b.task.rankClass === cls) { delete blk.tasks[key]; n++; }
      if (Object.keys(blk.tasks).length) continue;
      delete w.blocks[bot.id];
      w.plan = this.plan(w, now);
    }
    if (n) { this.save(); if (bot.journal) bot.journal(`${cls} is rank 10 - its rank-up is off the walls list`); }
    return n;
  }
  // Rank-up blocks of classes that are rank 10 by now (before an escort is planned around them).
  async pruneRanked(bots, now = Date.now()) {
    for (const bot of bots) {
      const mine = this.list().flatMap((w) => Object.values((w.blocks[bot.id] || {}).tasks || {})).map((b) => b.task && b.task.rankClass).filter(Boolean);
      if (!mine.length || !bot.unrankedClasses) continue;
      const open = await bot.unrankedClasses().then((l) => l.map((c) => c.name)).catch(() => null);
      if (!open) continue;
      for (const cls of new Set(mine)) if (!open.includes(cls)) this.dropRank(bot, cls, now);
    }
  }

  // ---------------- escorts ----------------
  // The work a character runs in an escort: the most important thing the wall blocks (Farmer Joe first).
  escortWork(bot, w) {
    const blk = w.blocks[bot.id];
    if (!blk) return null;
    const list = Object.entries(blk.tasks).filter(([, b]) => !b.cosmetic && b.task && b.task.type);
    list.sort(([, a], [, b]) => (b.task.farmerJoe ? 1 : 0) - (a.task.farmerJoe ? 1 : 0) || (b.task.rankClass ? 1 : 0) - (a.task.rankClass ? 1 : 0));
    const live = list.find(([, b]) => !this.hub.brain || !this.hub.brain.escortable || this.hub.brain.escortable(bot, b.task));
    return live ? { key: live[0], ...live[1] } : null;
  }

  // Every minute (hub timer): watch the running escort, or start one when the party is free.
  async tick(now = Date.now()) {
    const e = this.data.active;
    if (e) return this.watch(e, now);
    // Plans age: a party wall's day runs out, someone kills the boss alone. Plan them again every minute.
    for (const w of this.list()) if (w.plan && w.plan.kind !== 'cleared') w.plan = this.plan(w, now);
    const mode = this.mode(now);
    if (mode === 'off') return null;
    const hub = this.hub;
    const day = serverDay(new Date(now));
    const today = this.data.escorts.filter((x) => x.day === day);
    if (today.length >= ESCORTS_PER_DAY || today.filter((x) => x.result === 'no progress').length >= FAILED_PER_DAY) return null;
    const last = this.data.escorts[this.data.escorts.length - 1];
    const gap = last && /^past for /.test(String(last.result)) ? ESCORT_GAP_AFTER_PROGRESS_MS : ESCORT_GAP_MS;
    if (last && now - (last.endedAt || last.at) < gap) return null;
    const bots = [...hub.bots.values()].filter((b) => b.account.kind !== 'guest' && b.running && !b.paused && b.serverName && (!b.account.status || b.account.status === 'active'));
    if (bots.length < 2) return null;
    if (hub.raid || (hub.anyHelp ? hub.anyHelp(now) : hub.help && now < hub.help.until) || hub.army || hub.crew) return null;
    const Hub = hub.constructor;
    if (bots.some((b) => (Hub.dailyWork && Hub.dailyWork(b.current)) || (b.current && (b.current.raid || b.current.type === 'assist')))) return null;
    if (now - (this._prunedAt || 0) >= 10 * 60000) { this._prunedAt = now; await this.pruneRanked(bots, now); }
    // The party's server and room: everyone must be able to meet.
    const lvls = {};
    for (const b of bots) lvls[b.id] = await b.level().catch(() => 0);
    let pick = null;
    for (const w of this.list()) {
      if (!w.plan || w.plan.kind !== 'escort') continue;
      const needers = bots.filter((b) => this.escortWork(b, w)).map((b) => b.id);
      if (!needers.length) continue;
      const helpers = bots.filter((b) => !needers.includes(b.id)).map((b) => b.id);
      if (!helpers.length && needers.length < 2) continue;
      const blocked = needers.reduce((a, id) => a + Object.keys(w.blocks[id].tasks).length, 0);
      const fj = needers.some((id) => { const x = this.escortWork(this.bot(id), w); return x && x.task.farmerJoe; });
      const score = (fj ? 100 : 0) + blocked * 10 + needers.length;
      if (!pick || score > pick.score) pick = { w, needers, helpers, score };
    }
    if (!pick) return null;
    const { w, needers } = pick;
    let { helpers } = pick;
    // A squad, not everyone (Seraph 5, lib/squad.js): the cheapest strong helpers, as many as the room still takes. Before,
    // every escort took all the others along - and chaosrealm-13579 turned five of them away all morning (2026-10-26).
    if (hub.squadInfo && hub.settings.squads !== false && helpers.length) {
      const cap = hub.squadBook ? hub.squadBook().cap(w.map) : null;
      const size = Number.isFinite(Number(hub.settings.escortSize)) ? Number(hub.settings.escortSize) : squad.ESCORT_SIZE;
      const callerLevel = Math.min(...needers.map((id) => lvls[id] || 100));
      const pool = helpers.map((id) => this.bot(id)).filter(Boolean);
      helpers = squad.pick(await hub.squadInfo(pool, now), { size, callerLevel, cap: cap ? cap - needers.length : null });
    }
    if (!helpers.length && needers.length < 2) return null;
    const room = (hub.settings.levelParty && hub.settings.levelParty.room) || null;
    const rec = { id: `escort-${now}`, wall: w.id, boss: w.boss || w.item, needers, helpers, at: now, day, until: now + ESCORT_MS, mode, room, marks: {}, over: {}, passed: {} };
    this.data.escorts.push(rec);
    if (this.data.escorts.length > 100) this.data.escorts.splice(0, this.data.escorts.length - 100);
    const what = needers.map((id) => { const x = this.escortWork(this.bot(id), w); return `${id}: ${x.task.why || x.goal}`; }).join('; ');
    if (mode === 'plan') {
      rec.result = 'plan only';
      rec.endedAt = now;
      this.save();
      hub.info(`escort (plan only, live from ${new Date(this.data.planOnlyUntil).toISOString().slice(0, 16)}Z): would take ${helpers.join(', ') || 'nobody else'} with ${needers.join(', ')} past ${rec.boss} in room ${room} - ${what}`);
      return rec;
    }
    for (const id of needers) {
      const b = this.bot(id);
      const x = this.escortWork(b, w);
      rec.marks[id] = { items: b.itemProgress || 0, quests: (b.stats && b.stats.quests) || 0, key: x.key };
      if (b.skipped) b.skipped.delete(x.key);   // the escort runs the parked work itself
    }
    this.data.active = rec;
    this.save();
    hub.info(`escort: ${helpers.join(', ') || 'nobody else'} with ${needers.join(', ')} past ${rec.boss} in room ${room} - ${what}`);
    if (hub.notify) hub.notify(`Party escort: ${rec.boss}`, `${needers.join(', ')} ${needers.length > 1 ? 'are' : 'is'} blocked; everyone goes to room ${room} for up to 45 min`, 'event');
    for (const id of [...needers, ...helpers]) {
      const b = this.bot(id);
      if (b && b.current && b.current.escort !== rec.id) {
        if (helpers.includes(id) && hub.keepEngineTurn) hub.keepEngineTurn(b, now);
        b.journal(`pausing "${b.current.why || b.current.type}" for the ${rec.boss} escort`);
        Promise.resolve(b.restart()).catch(() => null);
      }
    }
    return rec;
  }

  // A helper that can't follow (the needer's room is full) leaves the escort and goes back to its own work.
  leave(bot, escortId, why) {
    const e = this.data.active;
    if (!e || e.id !== escortId || !e.helpers.includes(bot.id)) return false;
    e.helpers = e.helpers.filter((id) => id !== bot.id);
    (e.left = e.left || {})[bot.id] = why;
    this.save();
    if (bot.journal) bot.journal(`leaving the ${e.boss} escort (${why}) - back to my own work`);
    return true;
  }

  // The task a character runs while an escort is on (lib/bot.js loop): its own blocked work, or following a needer.
  taskFor(bot, now = Date.now()) {
    const e = this.data.active;
    if (!e || now > e.until) return null;
    const w = this.data.walls[e.wall];
    if (!w) return null;
    if (e.needers.includes(bot.id)) {
      if (e.over[bot.id] || e.passed[bot.id]) return null;
      const x = this.escortWork(bot, w);
      if (!x) return null;
      return { ...x.task, escort: e.id, brain: true, why: `escort: the party helps me past ${e.boss} (${x.task.why || x.goal || x.task.type})` };
    }
    if (e.helpers.includes(bot.id)) {
      const lead = e.needers.find((id) => !e.over[id] && !e.passed[id]) || e.needers[0];
      // The helpers go to the needer's server: its work decides (quiet work: Swordhaven and the party room).
      const lb = this.bot(lead);
      // A raid can take the needer mid-escort (raidTask runs before escorts since 1023b): the helpers can't enter the
      // ultra room, and following there cost the three girls 40 min of failed joins and relogs (2026-10-23).
      if (lb && lb.current && lb.current.raid) return null;
      const lx = lb ? this.escortWork(lb, w) : null;
      const server = crowd.serverFor(crowd.kindOf(lx ? lx.task : null)) || crowd.QUIET_SERVER;
      return { type: 'follow', leader: lead, server, minutes: Math.max(1, Math.round((e.until - now) / 60000)), escort: e.id, brain: true, why: `escort: helping ${lead} past ${e.boss}` };
    }
    return null;
  }
  isOn(id) { const e = this.data.active; return !!(e && e.id === id && Date.now() <= e.until); }

  // A needer's escort task ended (done, failed, parked, stopped): did it get past the wall?
  taskEnded(bot, task, gained, now = Date.now()) {
    const e = this.data.active;
    if (!e || !task || task.escort !== e.id || !e.needers.includes(bot.id)) return;
    const moved = gained && (gained.items > 0 || gained.quests > 0);
    if (moved) e.passed[bot.id] = now; else e.over[bot.id] = now;
    this.save();
    this.watch(e, now);
  }

  watch(e, now = Date.now()) {
    const w = this.data.walls[e.wall];
    for (const id of e.needers) {
      if (e.passed[id] || e.over[id]) continue;
      const b = this.bot(id);
      if (!b || !b.running) { e.over[id] = now; continue; }
      // Past the wall: its step is no longer the current one, and its own item or a quest moved since the start.
      const m = e.marks[id] || {};
      const step = parseStep(b.scriptStep);
      const atWall = step && w && ((w.boss && step.boss && step.boss.toLowerCase() === w.boss.toLowerCase()) || (w.item && step.item && step.item.toLowerCase() === w.item.toLowerCase()));
      if (atWall) { e.reached = e.reached || {}; e.reached[id] = now; }
      const moved = (b.itemProgress || 0) > (m.items || 0) || ((b.stats && b.stats.quests) || 0) > (m.quests || 0);
      const done = step && w && w.item && step.item && step.item.toLowerCase() === w.item.toLowerCase() && step.want && step.have >= step.want;
      if (done || (e.reached && e.reached[id] && !atWall && moved)) e.passed[id] = now;
    }
    const finished = e.needers.every((id) => e.passed[id] || e.over[id]);
    if (!finished && now <= e.until) { this.save(); return e; }
    return this.end(e, finished ? 'all needers are through' : 'time is up', now);
  }

  end(e, why, now = Date.now()) {
    const w = this.data.walls[e.wall];
    e.endedAt = now;
    const passed = e.needers.filter((id) => e.passed[id]);
    e.result = passed.length ? `past for ${passed.join(', ')}` : 'no progress';
    this.data.active = null;
    if (w) {
      for (const id of passed) { const b = this.bot(id); if (b) this.clear(b, w, 'party escort', now); }
      if (!passed.length) {
        w.escortFails = (w.escortFails || 0) + 1;
        if (w.escortFails >= FAILS_LATER) { w.laterUntil = now + LATER_MS; w.laterWhy = `${w.escortFails} escorts without getting past it`; w.escortFails = 0; }
      }
      w.plan = this.plan(w, now);
      (w.escorts = w.escorts || []).push({ at: e.at, result: e.result });
    }
    this.save();
    if (this.hub.info) this.hub.info(`escort ${e.boss}: over (${why}) - ${e.result}`);
    // Helpers stop following at once; needers keep running their own work (past the wall it just carries on).
    for (const id of e.helpers) { const b = this.bot(id); if (b && b.current && b.current.escort === e.id) Promise.resolve(b.restart()).catch(() => null); }
    return e;
  }

  // Dashboard / API.
  summary(now = Date.now()) {
    return {
      mode: this.mode(now), planOnlyUntil: this.data.planOnlyUntil, active: this.data.active,
      walls: this.list().filter((w) => w.plan && w.plan.kind !== 'cleared').map((w) => ({ id: w.id, boss: w.boss, item: w.item, map: w.map, hp: w.hp || null, plan: w.plan, blocks: Object.fromEntries(Object.entries(w.blocks).map(([id, b]) => [id, Object.values(b.tasks).map((t) => t.task.why || t.goal)])), estimate: w.estimate ? describe(w) : null, deaths: w.deaths })),
      escorts: this.data.escorts.slice(-10),
    };
  }
}

module.exports = { Walls, parseStep, estimate, describe, taskCopy, ESCORT_MS, ESCORTS_PER_DAY };
