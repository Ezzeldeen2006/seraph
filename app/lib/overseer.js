// The Overseer: a local AI brain (Ollama + an open model, default Qwen3 8B, see lib/llm.js) that watches the whole
// party and manages it. No cloud account is used (the owner's choice, 2026-09-17).
//  - Thinks on a timer (default every 10 min) and immediately on events (errors, death streaks, stuck goals, level
//    milestones). Each thought gets a live snapshot of every character and returns decisions as JSON.
//  - Decisions are validated against a whitelist (queue tasks, pause/resume, goal pauses, safe settings, notes, messages)
//    and applied in "autopilot" mode, or kept as proposals for the owner to approve in "advisor" mode.
//  - the owner can chat with it ("how do I…", "send everyone to…", "why is Nova dying?"). In chat it looks facts up with
//    read-only tools (vault notes, Skua scripts, AQW Wiki, asking a character) and can act when asked.
// The fast loop (combat, movement, quests) stays in code: a language model can't cast skills every 200 ms. The
// Overseer decides *what* each character should be doing and *why*.
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { P } = require('./paths');
const { readJson, writeJson, serverDay } = require('./util');
const knowledge = require('./knowledge');
const progression = require('./progression');
const personas = require('./personas');
const llm = require('./llm');
const lookup = require('./overseer-tools');
const knowledgebook = require('./knowledgebook');

const DIR = () => path.join(P.ROOT, 'overseer');

const TASK_TYPES = ['farmLevel', 'kill', 'script', 'daily', 'quest', 'enhance', 'sellJunk', 'tidy', 'bankAc', 'style', 'barber', 'gear', 'wait', 'equip', 'set'];
const SETTINGS = {
  giveUpDeaths: (v) => Number.isInteger(v) && v >= 1 && v <= 8,
  minEventLevel: (v) => Number.isInteger(v) && v >= 1 && v <= 100,
  maxEventHours: (v) => typeof v === 'number' && v >= 0 && v <= 6,
  minDailyLevel: (v) => Number.isInteger(v) && v >= 1 && v <= 100,
  combatEngine: (v) => ['auto', 'adaptive', 'skua'].includes(v),
};

const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['queue', 'clearQueue', 'skipCurrent', 'pause', 'resume', 'start', 'stop', 'pauseGoal', 'unpauseGoal', 'skipEvent', 'setting', 'assist', 'note', 'notify'] },
    bot: { type: 'string' },
    front: { type: 'boolean' },
    task: { type: 'object' },
    goal: { type: 'string' },
    event: { type: 'string' },
    key: { type: 'string' },
    value: {},
    enabled: { type: 'boolean' },
    members: { type: 'array', items: { type: 'string' } },
    text: { type: 'string' },
    why: { type: 'string' },
  },
  required: ['action', 'why'],
};
const THINK_SCHEMA = {
  type: 'object',
  properties: {
    thoughts: { type: 'string' },
    actions: { type: 'array', items: ACTION_SCHEMA },
    message: { type: 'string' },
    nextThinkMinutes: { type: 'integer' },
  },
  required: ['thoughts', 'actions'],
};
const CHAT_SCHEMA = {
  type: 'object',
  properties: { reply: { type: 'string' }, actions: { type: 'array', items: ACTION_SCHEMA } },
  required: ['reply', 'actions'],
};

function systemPrompt() {
  const goals = Object.entries(progression.GOALS).map(([id, g]) => `${id} (lvl ${g.when}${g.must ? ', must' : ''}${g.needsAc ? `, needs ${g.needsAc} AC` : ''}): ${g.label} - ${g.script}`).join('\n');
  const ultras = Object.entries(progression.ULTRAS).map(([id, u]) => `/${id} ${u.label} (${u.cadence}): ${u.classes.join(', ')}`).join('\n');
  const party = Object.values(personas.PERSONAS).map((p) => `${p.id} = ${p.name}, ${p.title} (${p.archetype}); ultra slot ${p.ultraClass}; ${p.temperament}`).join('\n');
  return `You are the Overseer: the AI brain of Seraph, the AdventureQuest Worlds (AQW) party client built for the owner. You run locally on his PC.
You manage a party of bot characters. The owner owns everything; his own main character is GRAIL26 (played by hand).

# How Seraph works
- Each character runs a bot loop. When its queue is empty, a rule brain picks the next task (bag hygiene, enhancements,
  wardrobe, barber, live events, dailies, progression goals, leveling, gold). Tasks you queue run BEFORE the rule brain.
- Combat, movement, questing, drops and banking are automatic. Don't micro-manage them. Your job is strategy: what each
  character should work on, noticing problems (deaths, stuck goals, failing scripts, wasted time) and fixing them, and
  keeping the party complementary for ultras.
- Task types: farmLevel {to, minutes} | kill {map, cell, pad, monster, item?, qty?, minutes} | script {path, hours} (path
  inside the Skua Scripts repo, e.g. "Other/Classes/VerusDoomKnight.cs") | daily {name} | quest {id, map, monster} |
  enhance | sellJunk | bankAc | style | barber | gear {kind: exp|gold|rep|boss|fight} | wait {minutes} | equip {item}.
- Seasonal event scripts are not goals: to stop a character dying in an event use {"action":"skipEvent","bot":"nova7","event":"TalkLikeaPirateDay"}.
- Safe settings: giveUpDeaths (1-8), minEventLevel, maxEventHours (0-6), minDailyLevel, combatEngine (auto|adaptive|skua).

# Hard rules (never break)
1. Never decline drops; AC-tagged drops are always kept and banked when needed. Never sell AC items. Never spend AC.
2. Never touch the owner's main account except through "assist" (bots follow him in ultras), and only when he asks.
3. Free-to-play only: no member-only content.
4. Don't send a character to content far above its level (it dies). Level first.
5. Few, meaningful actions. When things run well the right answer is an EMPTY actions list: the rule brain already levels,
   does dailies, events and goals by itself. Never queue what a character is already doing or will do anyway ("continue
   leveling" is not an action). Act only to fix a problem (deaths, errors, stuck/failing goals, idle or wasted time) or when
   The owner asks. Never repeat an action that already failed for the same reason: pause that goal and move on.
6. Be honest. Your own memory of AQW is unreliable: in chat, look facts up with your tools (search_notes / read_note for
   Seraph and strategy notes, wiki for AQW items/quests/classes, search_scripts for farming scripts, ask_character for a
   character's items/quests/location, web_search + read_url for anything current) before answering. The REFERENCE block
   (knowledge book, boosts calendar, web) was looked up for you: trust it over your memory. If you still don't know, say so.
7. Boosts: the party state lists today's boosts from the Artix calendar. 2x XP → leveling (the rule brain already does it),
   2x Rep → reputation classes, 2x Class Points → ranking classes, resource boosts (Legion Tokens, Void Auras, Spirit Orbs)
   → the farms that use them. Mention boosts when they matter.
8. Stuck: a character whose killsLast10Min is 0 while it "hunts" or "levels" is stuck, even if its journal says hunting.
   Say so plainly (the watchdog restarts it; if it keeps happening, pause that goal or change the task).

# The party
${party}

# Progression goals (id (min level): label - script)
${goals}

# Ultra comps (Skua v3 scripts)
${ultras}

# Seraph dashboard (for "how do I" questions)
Home (quick actions + character cards: Start/Pause/Stop/Watch/Ask), Live (all game screens at once, click a name to watch
full size), Brain (chat with you, your thoughts, proposals, autopilot/advisor switch), Ultras (help my main: main name,
server, class, helpers, switch), Plan (every goal per character, pause/resume), Items (search backpacks + banks of all
characters, recent drops), Tools (army commands for all bots, run a script, dailies tracker), Settings (notifications,
display, AI). Ctrl+K opens the command palette anywhere. F9 = fix display if the window goes black.
Start/stop Seraph: <seraph>\\Start Sable.bat / Stop Sable.bat. Logins: <accounts file>.`;
}

class Overseer extends EventEmitter {
  constructor(hub, opts = {}) {
    super();
    this.hub = hub;
    this.llm = opts.llm || ((prompt, o) => this.local(prompt, o));
    // Routine checks use the fast model when installed (qwen3 4B instruct fits the GPU next to the games); chat uses the smarter 8B.
    this.cfg = Object.assign({ enabled: true, mode: 'autopilot', thinkEveryMin: 10, model: 'auto', chatModel: 'qwen3:8b', minGapSec: 90 }, (hub.settings && hub.settings.overseer) || {});
    if (this.cfg.model === 'qwen3:8b' && !this.cfg.modelChosen) this.cfg.model = 'auto';
    fs.mkdirSync(DIR(), { recursive: true });
    this.memory = readJson(path.join(DIR(), 'memory.json'), { notes: [] });
    this.proposals = [];
    this.busy = false;
    this.lastThink = 0;
    this.lastError = null;
    this.nextThinkAt = Date.now() + 2 * 60000;
    this.triggers = [];
    this.timer = null;
  }

  saveCfg() { if (this.hub.settings) { this.hub.settings.overseer = this.cfg; if (this.hub.saveSettings) this.hub.saveSettings(); } }
  setCfg(patch) {
    for (const k of ['enabled', 'mode', 'thinkEveryMin', 'model', 'chatModel']) if (k in patch) this.cfg[k] = patch[k];
    if (patch.enabled) { llm.resume(); this.lastError = null; }
    if ('model' in patch) this.cfg.modelChosen = true;
    this.saveCfg();
    this.emit('update');
    return this.cfg;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => this.log('error', { error: e.message })), 15000);
    for (const bot of this.hub.bots.values()) this.watchBot(bot);
    if (this.hub.on) this.hub.on('accounts', () => { for (const bot of this.hub.bots.values()) this.watchBot(bot); });
  }
  stop() { clearInterval(this.timer); }

  watchBot(bot) {
    if (bot._overseerWatched) return;
    bot._overseerWatched = true;
    bot.on('alert', ({ title, body }) => this.trigger(`${bot.id}: ${title} - ${body}`));
    bot.on('levelUp', ({ level }) => { if (level % 5 === 0) this.trigger(`${bot.id} reached level ${level}`); });
    bot.on('log', ({ level, msg }) => { if (level === 'error') this.trigger(`${bot.id} error: ${msg}`); });
  }

  trigger(reason) {
    this.triggers.push({ t: Date.now(), reason });
    if (this.triggers.length > 20) this.triggers.shift();
  }

  async tick() {
    if (!this.cfg.enabled || this.busy) return;
    if (llm.paused()) { this.lastError = `Paused: ${llm.paused().why} (Task Manager). Send a message or turn the AI Brain on to restart it.`; return; }
    const now = Date.now();
    const gapOk = now - this.lastThink > this.cfg.minGapSec * 1000;
    if ((this.triggers.length && gapOk) || now >= this.nextThinkAt) await this.think(this.triggers.length ? 'event' : 'timer');
  }

  log(kind, data) {
    const row = { t: Date.now(), kind, ...data };
    try { fs.appendFileSync(path.join(DIR(), 'thoughts.jsonl'), JSON.stringify(row) + '\n'); } catch { /* */ }
    this.emit('thought', row);
    return row;
  }
  history(file, n = 60) {
    const f = path.join(DIR(), file);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').trim().split('\n').slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  // Everything the model needs to see, compact (a small local model has a small context).
  async snapshot() {
    const bots = [];
    for (const bot of this.hub.bots.values()) {
      const s = await bot.status().catch(() => ({}));
      const row = {
        id: bot.id, name: bot.persona ? bot.persona.name : bot.account.label, online: !!s.online, running: !!s.running, paused: !!s.paused,
        role: bot.persona ? `${bot.persona.archetype}, ultra slot ${bot.persona.ultraClass}, specialty path ${bot.persona.path.join(' > ')}` : null,
        level: s.level, class: s.className, gold: s.gold, map: s.map, hp: s.hpMax ? `${Math.round(s.hp / s.hpMax * 100)}%` : null,
        now: s.current ? { type: s.current.type, why: s.current.why, event: s.current.event, goal: s.current.goal, minutes: s.current.startedAt ? Math.round((Date.now() - s.current.startedAt) / 60000) : null } : null,
        queue: (s.queue || []).map((t) => t.type + (t.path ? `:${t.path}` : t.name ? `:${t.name}` : '')),
        session: s.stats ? { kills: s.stats.kills, deaths: s.stats.deaths, quests: s.stats.quests } : null,
        killsLast10Min: this.hub.killsLast10Min ? this.hub.killsLast10Min(bot) : null,
        stuck: this.hub.killsLast10Min && s.current && ['farmLevel', 'kill'].includes(s.current.type) && this.hub.killsLast10Min(bot) === 0 ? 'NO KILLS in the last 10 min although it says it is fighting' : undefined,
        xpPerHour: s.expPerHour,
        journal: (bot.lastLog || []).slice(-8).map((l) => `${l.slice(11, 16)} ${l.slice(25)}`.slice(0, 140)),
      };
      if (s.online && this.hub.brain) {
        const plan = await this.hub.brain.plan(bot).catch(() => null);
        if (plan) {
          row.stage = plan.stage.label;
          row.goals = plan.goals.filter((g) => !['later', 'planned'].includes(g.status)).map((g) => `${g.id}:${g.status}`).slice(0, 10);
        }
        row.dailiesToday = this.hub.brain.today(bot).dailies;
        const fails = this.hub.brain.state(bot).goalFails || {};
        if (Object.keys(fails).length) row.goalFails = fails;
      }
      bots.push(row);
    }
    const up = (this.hub.updater && this.hub.updater.state) || {};
    return {
      time: new Date().toISOString(), serverDay: serverDay(), gameEvent: up.game ? up.game.sTitle : null,
      boosts: this.hub.boosts ? (() => { const b = this.hub.boosts.summary(); return { activeToday: b.active.map((x) => x.title), upcoming: b.upcoming.filter((u) => u.boost).slice(0, 5).map((u) => `${u.date} ${u.title}`) }; })() : null,
      liveEventCandidates: knowledge.eventCandidates().map((e) => e.folder),
      assist: this.hub.settings && this.hub.settings.assist ? { enabled: this.hub.settings.assist.enabled, main: this.hub.settings.assist.main } : null,
      bots, memory: this.memory.notes.slice(-15).map((n) => n.text),
      recentDecisions: this.history('thoughts.jsonl', 30).filter((r) => r.kind === 'think').slice(-4).map((r) => ({ at: new Date(r.t).toISOString().slice(11, 16), thoughts: r.thoughts, actions: (r.actions || []).map((a) => `${a.action} ${a.bot || ''} -> ${a.result || ''}`) })),
    };
  }

  // Ask the local model. With `withTools` it may call read-only lookup tools before answering.
  async resolveModel(name) {
    if (name && name !== 'auto') return name;
    try { return await llm.pick(['qwen3:4b-instruct-2507-q4_K_M', 'qwen3:8b']); } catch (e) { if (llm.paused()) throw e; return 'qwen3:8b'; }
  }

  async local(prompt, { model, schema, withTools = false, think = false }) {
    const r = await llm.chat({
      model: await this.resolveModel(model || this.cfg.model), system: systemPrompt(), messages: [{ role: 'user', content: prompt }], schema,
      tools: withTools ? lookup.make(this.hub) : null, maxRounds: 4, log: (m) => this.log('status', { text: m }),
      options: think ? { num_ctx: 8192 } : {}, timeoutMs: 15 * 60000,
    });
    return { data: r.data, used: r.used, ms: r.ms };
  }

  async think(reason = 'manual') {
    if (this.busy) return null;
    this.busy = true;
    const triggers = this.triggers.splice(0);
    this.lastThink = Date.now();
    this.emit('update');
    try {
      const snap = await this.snapshot();
      const prompt = `It is ${snap.time}. You are thinking now because: ${reason}${triggers.length ? ` - ${triggers.map((t) => t.reason).join(' | ')}` : ' (routine check)'}.
Mode: ${this.cfg.mode}${this.cfg.mode === 'advisor' ? ' (your actions become proposals the owner approves)' : ' (your actions run immediately)'}.
Look at the party state. Is anything wrong or wasteful? Only then act. Reply with JSON, e.g. when all is fine:
{"thoughts": "Everyone is leveling and doing dailies normally. Nothing to fix.", "actions": [], "nextThinkMinutes": 15}
or when something is wrong:
{"thoughts": "Nova died 6 times on the chaos-slayer goal at level 52.", "actions": [{"action": "pauseGoal", "bot": "nova7", "goal": "chaos-slayer", "why": "dying repeatedly, retry when stronger"}], "nextThinkMinutes": 10}

PARTY STATE:
${JSON.stringify(snap)}`;
      const { data, ms } = await this.llm(prompt, { model: this.cfg.model, schema: THINK_SCHEMA, think: true });
      const actions = Array.isArray(data.actions) ? data.actions.slice(0, 8) : [];
      let results = [];
      if (this.cfg.mode === 'autopilot') results = await this.applyAll(actions, 'think');
      else {
        results = actions.map((a) => ({ ...a, result: 'proposed', id: `p${Date.now()}${Math.random().toString(36).slice(2, 6)}` }));
        this.proposals.push(...results);
        this.proposals = this.proposals.slice(-20);
      }
      if (data.message && this.hub.notify) this.hub.notify('Overseer', data.message, 'overseer');
      this.nextThinkAt = Date.now() + Math.max(2, Math.min(60, Number(data.nextThinkMinutes) || this.cfg.thinkEveryMin)) * 60000;
      this.lastError = null;
      return this.log('think', { reason, triggers: triggers.map((t) => t.reason), thoughts: data.thoughts, message: data.message || null, actions: results, ms });
    } catch (e) {
      this.nextThinkAt = Date.now() + 5 * 60000;
      this.lastError = e.message;
      return this.log('error', { reason, error: e.message });
    } finally { this.busy = false; this.emit('update'); }
  }

  async chat(message) {
    const text = String(message || '').trim();
    if (!text) throw new Error('empty message');
    llm.resume();   // The owner asked something himself: starting the local AI is wanted now
    const past = this.history('chat.jsonl', 6);
    this.appendChat({ role: 'owner', text });
    this.emit('chat');
    const snap = await this.snapshot();
    const command = Overseer.isCommand(text);
    let refs = await lookup.retrieve(text).catch(() => '');
    // Knowledge book (semantic search over the vault), boosts, and the web when the book has nothing solid.
    const book = await knowledgebook.search(text, 4).catch(() => []);
    const good = book.filter((h) => h.score >= 0.55);
    if (good.length) refs += `\n\n${good.map((h) => `KNOWLEDGE BOOK (${require('path').basename(h.file)} lines ${h.from}-${h.to}): ${h.text.slice(0, 1200)}`).join('\n\n')}`;
    if (this.hub.boosts && /boost|double|2x|triple|event|today|tomorrow|this week|calendar|legion token|spirit orb|void aura|xp|exp/i.test(text)) {
      const b = this.hub.boosts.summary();
      refs += `\n\nBOOSTS (Artix calendar, fetched ${b.fetchedAt}): active today: ${b.active.map((x) => x.title).join(', ') || 'none'}. Next 7 days: ${b.upcoming.map((u) => `${u.date} ${u.title}`).join('; ')}.`;
    }
    if (!good.length && !/GOAL /.test(refs) && !command) {
      try {
        const web = require(require('path').join(process.env.SERAPH_AI_CORE || 'seraph-ai-core', 'web'));
        const hits = await web.search(`AQW ${text}`, { max: 3 });
        const pages = [];
        for (const h of hits.slice(0, 2)) { try { const pg = await web.read(h.url, 2500); pages.push(`WEB (${h.title} - ${h.url}): ${pg.text}`); } catch (e) { /* skip */ } }
        if (pages.length) refs += `\n\n${pages.join('\n\n')}`;
      } catch (e) { /* offline */ }
    }
    const prompt = `the owner is talking to you.
Recent conversation:
${past.map((m) => `${m.role === 'owner' ? 'the owner' : 'You'}: ${m.text}`).join('\n') || '(none)'}

Party state right now:
${JSON.stringify(snap)}

REFERENCE (looked up for this question; trust it over your own memory):
${refs || '(nothing found)'}

The owner: ${text}

Answer THIS message fresh from the REFERENCE and party state; don't copy your earlier replies.
${command
    ? 'This is an instruction: do it with actions (they run right away) and confirm briefly what you did.'
    : 'This is a question: answer it using the party state and REFERENCE, step by step if it is a how-to. Do NOT take actions (actions must be []). You may suggest what he could ask you to do.'}
Reply with JSON: {"reply": "...", "actions": [...]}.`;
    try {
      const { data, used, ms } = await this.llm(prompt, { model: this.cfg.chatModel, schema: CHAT_SCHEMA, withTools: !refs });
      const results = command ? await this.applyAll(Array.isArray(data.actions) ? data.actions.slice(0, 10) : [], 'chat') : [];
      const row = this.appendChat({ role: 'overseer', text: data.reply, actions: results, lookedUp: used || [], ms });
      this.emit('chat');
      return row;
    } catch (e) {
      const row = this.appendChat({ role: 'overseer', text: `I couldn't think that through: ${e.message}`, error: true });
      this.emit('chat');
      return row;
    }
  }

  // Is this chat message an instruction (act) or a question (answer only)?
  static isCommand(text) {
    const t = String(text || '').trim().toLowerCase();
    if (/\?\s*$/.test(t) && !/^(can|could|would|will) you\b/.test(t)) return false;
    return /^(please\s+)?(send|make|start|stop|pause|resume|queue|go|have|let|tell|put|turn|run|switch|set|move|bring|get (everyone|all|them|\w+7)|help me|join|farm|level|bank|enhance|sell|clear|skip|focus|prioriti[sz]e|dress|visit)\b/.test(t)
      || /^(can|could|would|will) you\s+(send|make|start|stop|pause|resume|queue|have|put|turn|run|switch|set|move|bring|help|join|farm|level|bank|enhance|sell|clear|skip|focus)/.test(t);
  }

  appendChat(m) {
    const row = { t: Date.now(), ...m };
    try { fs.appendFileSync(path.join(DIR(), 'chat.jsonl'), JSON.stringify(row) + '\n'); } catch { /* */ }
    return row;
  }

  async applyAll(actions, source) {
    const out = [];
    for (const a of actions) {
      let result;
      try { result = await this.apply(a, source); } catch (e) { result = `rejected: ${e.message}`; }
      out.push({ ...a, result });
    }
    return out;
  }

  async approve(id) {
    const i = this.proposals.findIndex((p) => p.id === id);
    if (i < 0) throw new Error('no such proposal');
    const [p] = this.proposals.splice(i, 1);
    let result;
    try { result = await this.apply(p, 'approved'); } catch (e) { result = `rejected: ${e.message}`; }
    this.log('approved', { action: { ...p, result } });
    this.emit('update');
    return result;
  }
  dismiss(id) { this.proposals = this.proposals.filter((p) => p.id !== id); this.emit('update'); }

  // Validate and apply one decision. Throws with a reason when the action isn't allowed.
  async apply(a, source) {
    const bot = a.bot ? this.hub.bot(a.bot) : null;
    const needBot = () => { if (!bot) throw new Error(`unknown bot "${a.bot}"`); return bot; };
    switch (a.action) {
      case 'queue': {
        const b = needBot();
        const t = { ...(a.task || {}) };
        if (!TASK_TYPES.includes(t.type)) throw new Error(`task type "${t.type}" not allowed`);
        if (t.type === 'script') {
          const file = path.join(P.SCRIPTS, ...String(t.path || '').split('/'));
          if (!/\.cs$/.test(String(t.path)) || String(t.path).includes('..') || !fs.existsSync(file)) throw new Error(`script ${t.path} not found`);
          t.hours = Math.min(Number(t.hours) || 2, 4);
        }
        if (t.type === 'kill' && !t.map) throw new Error('kill task needs a map');
        // Small models like to "continue" what a bot already does; that only duplicates work.
        const same = (x) => x && x.type === t.type && (x.path || '') === (t.path || '') && (x.name || '') === (t.name || '') && (x.map || '') === (t.map || '');
        if (same(b.current) || (b.current && b.current.type === 'farmLevel' && t.type === 'farmLevel')) throw new Error('the bot is already doing that');
        if (b.queue.some(same)) throw new Error('already queued');
        if (t.type === 'daily' && this.hub.brain && this.hub.brain.today(b).dailies[t.name]) throw new Error(`daily ${t.name} already ${this.hub.brain.today(b).dailies[t.name]} today`);
        if (source === 'think' && ['farmLevel', 'daily'].includes(t.type)) throw new Error('the rule brain already levels and does dailies by itself');
        const task = { ...t, overseer: true, why: t.why || `Overseer: ${a.why}` };
        if (a.front) b.queue.unshift(task); else b.queue.push(task);
        b.save();
        return 'queued';
      }
      case 'clearQueue': { const b = needBot(); b.queue = []; b.save(); return 'cleared'; }
      case 'skipCurrent': { const b = needBot(); b.skip(60); return 'skipping'; }
      case 'pause': needBot().paused = true; return 'paused';
      case 'resume': needBot().paused = false; return 'resumed';
      case 'start': return needBot().start() ? 'started' : 'already running';
      case 'stop': needBot().stop(true); return 'stopping';
      case 'pauseGoal': case 'unpauseGoal': {
        const b = needBot();
        if (!progression.GOALS[a.goal]) throw new Error(`unknown goal ${a.goal}`);
        const g = this.hub.brain.goals(b);
        const paused = a.action === 'pauseGoal' ? [...new Set([...g.paused, a.goal])] : g.paused.filter((x) => x !== a.goal);
        writeJson(path.join(P.account(b.id), 'goals.json'), { ...(readJson(path.join(P.account(b.id), 'goals.json'), null) || {}), version: 2, paused, custom: g.custom });   // keeps a custom queue
        return a.action === 'pauseGoal' ? 'goal paused' : 'goal resumed';
      }
      case 'setting': {
        const b = needBot();
        const check = SETTINGS[a.key];
        if (!check || !check(a.value)) throw new Error(`setting ${a.key}=${JSON.stringify(a.value)} not allowed`);
        b.settings[a.key] = a.value;
        if (a.key === 'combatEngine') b.combat.engine = a.value;
        b.save();
        return 'set';
      }
      case 'assist': {
        if (source !== 'chat' && source !== 'approved') throw new Error('assist only changes when the owner asks');
        const patch = { enabled: !!a.enabled };
        if (Array.isArray(a.members)) patch.members = a.members;
        this.hub.setAssist(patch);
        return a.enabled ? 'assist on' : 'assist off';
      }
      case 'skipEvent': {
        const b = needBot();
        const ev = String(a.event || a.goal || '').trim();
        if (!ev) throw new Error('which event?');
        const day = this.hub.brain.today(b);
        (day.eventsTooHard = day.eventsTooHard || {})[ev] = true;
        this.hub.brain.saveState(b);
        if (b.current && b.current.event === ev) b.restart();
        return `event ${ev} skipped for today`;
      }
      case 'note': {
        if (!a.text) throw new Error('empty note');
        this.memory.notes.push({ t: Date.now(), text: String(a.text).slice(0, 300) });
        this.memory.notes = this.memory.notes.slice(-60);
        writeJson(path.join(DIR(), 'memory.json'), this.memory);
        return 'remembered';
      }
      case 'notify': if (this.hub.notify) this.hub.notify('Overseer', String(a.text || a.why).slice(0, 200), 'overseer'); return 'sent';
      default: throw new Error(`unknown action ${a.action}`);
    }
  }

  status() {
    return {
      ...this.cfg, busy: this.busy, lastThink: this.lastThink, nextThinkAt: this.nextThinkAt, pendingTriggers: this.triggers.length,
      lastError: this.lastError, proposals: this.proposals, memory: this.memory.notes.slice(-20), installed: fs.existsSync(llm.EXE),
    };
  }
}

module.exports = { Overseer, systemPrompt, THINK_SCHEMA, CHAT_SCHEMA };
