// Local control API (127.0.0.1 only). Used by the dashboard UI, the keeper, seraph.py and Claude.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { P } = require('./paths');
const accounts = require('./accounts');
const knowledge = require('./knowledge');
const { translate } = require('./skua/translate');
const { readJson } = require('./util');
const personas = require('./personas');
const { ask } = require('./ask');
const progression = require('./progression');

function body(req) {
  return new Promise((res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { res({}); } }); });
}

let catalog = null;
function scriptCatalog() {
  if (!catalog) {
    const list = readJson(path.join(P.SCRIPTS, 'scripts.json'), []);
    catalog = (Array.isArray(list) ? list : []).map((s) => ({ name: s.name || s.fileName || String(s.path || s.filePath || '').split('/').pop(), path: s.path || s.filePath, description: s.description || '', tags: s.tags || [] }));
  }
  return catalog;
}

// A hand-given action on a character stopped by hand (the owner's main mid-change, 2026-10-22): bot.check() throws while the
// stop flag is up, even after the loop has ended. With no loop running the flag is lowered for this one action only.
async function byHand(bot, fn) {
  if (bot.running || !bot.stopFlag) return fn();
  bot.stopFlag = false;
  try { return await fn(); } finally { if (!bot.running) bot.stopFlag = true; }
}

async function botOp(hub, bot, cmd) {
  switch (cmd.op) {
    // A logged-out character (the owner's own account, or one that stepped aside) logs in first.
    case 'start': { if (bot.client && bot.client.headless && !(bot.client.state && bot.client.state.loaded) && !bot.client._reconnecting) hub.goOnline(bot.id); bot.paused = false; return { ok: bot.start() }; }
    case 'goOnline': return hub.goOnline(bot.id);
    case 'goOffline': return hub.goOffline(bot.id);
    // "I am playing this character myself": log out and stay out (hub.standAside). Automatic on AQW's
    // multiLoginWarning too; this is the by-hand version for when the owner is about to log in.
    case 'standAside': return hub.standAside(bot.account, bot.client, bot, cmd.why || 'you asked for this character');
    case 'routines': {
      const list = (bot.settings.routines = bot.settings.routines || []);
      if (cmd.remove) bot.settings.routines = list.filter((r) => r.id !== cmd.remove);
      if (cmd.pause) { const r = list.find((x) => x.id === cmd.pause); if (r) r.paused = !r.paused; }
      if (cmd.add) bot.settings.routines.push({ id: `r${Date.now().toString(36)}`, task: { ...cmd.add, repeat: 'daily' }, lastDay: null });
      bot.save();
      return { routines: bot.settings.routines };
    }
    case 'login': bot.stopFlag = false; await bot.ensureLogin(); return { ok: true, online: await bot.playing() };
    case 'stop': bot.stop(true); return { ok: true };
    case 'pause': bot.paused = true; return { ok: true };
    case 'resume': bot.paused = false; return { ok: true };
    case 'status': return bot.status(true);
    case 'queue': bot.queue.push(...(Array.isArray(cmd.tasks) ? cmd.tasks : [cmd.task])); bot.save(); return { queue: bot.queue };
    case 'queueFront': bot.queue.unshift(...(Array.isArray(cmd.tasks) ? cmd.tasks : [cmd.task])); bot.save(); return { queue: bot.queue };
    case 'remove': bot.queue.splice(cmd.index, 1); bot.save(); return { queue: bot.queue };
    case 'clear': bot.queue = []; bot.save(); return { queue: bot.queue };
    case 'skip': bot.skip(cmd.minutes || 60); return { ok: true };
    case 'restart': bot.restart(); return { ok: true };
    case 'retry': { const parked = hub.brain.retry(bot); bot.restart(); return { ok: true, ...parked }; }
    case 'settings': Object.assign(bot.settings, cmd.settings || {}); bot.save(); return { settings: bot.settings };
    case 'goals': {
      const g = hub.brain.goals(bot);
      // Keep the custom queue (goals.json goals): a pause used to write custom:true without it, and the bot fell back to
      // the default plan.
      const saved = { ...(readJson(hub.brain.goalsFile(bot), null) || {}), version: 2, paused: g.paused, custom: g.custom };
      if (cmd.goals) { saved.goals = cmd.goals; saved.custom = true; }
      if (cmd.reset) { delete saved.goals; saved.custom = false; }
      if (cmd.pause) saved.paused = [...new Set([...g.paused, cmd.pause])];
      if (cmd.unpause) saved.paused = g.paused.filter((x) => x !== cmd.unpause);
      require('./util').writeJson(path.join(P.account(bot.id), 'goals.json'), saved);
      return hub.brain.goals(bot);
    }
    // Skua's real engine: {op:'skua', path, entry?, args?, hours?} runs a script next; engine / engineLog / engineStop inspect it.
    case 'skua': {
      const st = { type: 'script', path: cmd.path, entry: cmd.entry || null, args: cmd.args || '', hours: Number(cmd.hours) || null, why: cmd.why || 'asked through the API' };
      if (cmd.now) bot.runNow(st); else if (cmd.last) { bot.queue.push(st); bot.save(); } else { bot.queue.unshift(st); bot.save(); }
      return { queue: bot.queue };
    }
    case 'engine': {
      const eng = hub.engines && hub.engines.get(bot.id);
      return { available: require('./skua/engine').available(), mode: bot.settings.scriptEngine || hub.settings.scriptEngine || 'skua', running: !!(eng && eng.running), script: eng ? eng.script : null, status: eng ? await eng.status() : null, busy: hub.engineBusy ? [...hub.engineBusy] : [] };
    }
    case 'engineLog': { const eng = hub.engines && hub.engines.get(bot.id); return { lines: eng ? eng.logs.slice(-(cmd.n || 100)) : [] }; }
    case 'engineStop': { const eng = hub.engines && hub.engines.get(bot.id); return eng ? eng.stop() : { ok: true, idle: true }; }
    // Enhance ONE slot for the class that is on now, on any account including the owner's own:
    //   {op:'enhanceSlot', type:'Lucky', slot:'ar'}            the class armour of whatever is worn
    //   {op:'enhanceSlot', type:'Fighter', slot:'ar', cls:'StoneCrusher'}   wear that outfit first
    // Deliberately one slot and one class per call: see the note on bot.enhanceEquipped.
    case 'enhanceSlot': return byHand(bot, async () => {
      const slot = String(cmd.slot || 'ar');
      if (cmd.cls) {
        const worn = await bot.wearOutfit(cmd.cls);
        if (!worn) throw new Error(`could not put on the ${cmd.cls} outfit`);
      }
      const cls = await bot.className();
      const before = ((await bot.items()).find((i) => i.bEquip && i.sES === slot) || {});
      // A forge special for that one slot (2026-10-22): {"slot":"Weapon","weapon":"Ravenous"}, cape/helm the same way.
      const n = await bot.enhanceEquipped({ type: String(cmd.type), weapon: cmd.weapon || null, cape: cmd.cape || null, helm: cmd.helm || null,
        source: `asked by hand (${cmd.type} on the ${slot} slot)`, onMain: true, onlySlots: [slot] });
      const after = ((await bot.items()).find((i) => i.bEquip && i.sES === slot) || {});
      return { ok: n > 0, applied: n, cls, slot, item: after.sName || before.sName || null,
        enhPattern: Number(after.EnhPatternID || 0), enhLevel: Number(after.EnhLvl || 0) };
    });
    case 'mainWeapons': return { weapons: await bot.weaponReport(cmd.slots || ['Weapon']) };
    case 'outfitCopy': return byHand(bot, () => bot.copyOutfit(String(cmd.from), String(cmd.name), cmd.set || {}));
    case 'outfitSlot': return byHand(bot, () => bot.pointOutfit(String(cmd.outfit), String(cmd.slot || 'Weapon'), String(cmd.item)));
    case 'outfitsToBag': return byHand(bot, async () => ({ moved: await bot.outfitsToBag(cmd.outfits || null) }));
    case 'plan': return hub.brain.plan(bot);
    case 'ahead': return hub.brain.ahead(bot);
    case 'rankUp': {
      const task = { type: 'script', path: 'CoreAdvanced.cs', entry: 'RankUpClass', args: JSON.stringify(String(cmd.name)), hours: Number(cmd.hours) || null, rankClass: String(cmd.name), why: `rank ${cmd.name} up to 10 (asked from the dashboard)` };
      if (cmd.now) bot.runNow(task); else { bot.queue.push(task); bot.save(); }
      return { queue: bot.queue };
    }
    case 'move': {
      const [t] = bot.queue.splice(cmd.from, 1);
      if (t) bot.queue.splice(Math.max(0, Math.min(bot.queue.length, cmd.to)), 0, t);
      bot.save();
      return { queue: bot.queue };
    }
    case 'now': {   // any task, right now (interrupts the current one)
      bot.runNow({ ...cmd.task, why: (cmd.task && cmd.task.why) || 'asked from the dashboard' });
      return { queue: bot.queue };
    }
    case 'brainPreview': return bot.brain.next(bot);
    case 'eval': {
      // "swf:<bridge call>" asks the skua.swf model the way the Skua engine does (answer(fn, args)), e.g.
      // swf:availableMonsters or swf:getGameObject ["world.strFrame"]: the model is separate from the headless world.
      if (/^swf:/.test(cmd.fn)) {
        const swf = bot.client && bot.client.swf;
        if (!swf) throw new Error('no Skua model on this bot');
        return { value: await swf.answer(cmd.fn.slice(4), cmd.args || []) };
      }
      // A dotted name is a method ON THAT OBJECT: `client.send` has to run with `this` = the client, or the first
      // thing it touches (client.write) is missing. Before 2026-10-21 everything was applied to the bot.
      const parts = String(cmd.fn).split('.');
      const owner = parts.slice(0, -1).reduce((o, k) => (o ? o[k] : undefined), bot) || bot;
      const target = owner[parts[parts.length - 1]];
      if (typeof target !== 'function') throw new Error(`no bot function ${cmd.fn}`);
      return { value: await byHand(bot, () => target.apply(owner, cmd.args || [])) };
    }
    default: throw new Error(`unknown op ${cmd.op}`);
  }
}

function start(hub, ui) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${P.PORT}`);
    const reply = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') return reply(204, {});
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      const first = hub.bots.values().next().value || null;
      // ----- hub -----
      if (url.pathname === '/state') {
        const c = hub.clients.values().next().value;
        return reply(200, { accounts: [...hub.clients.keys()], loaded: !!(c && c.state.loaded), uptime: process.uptime() * 1000, updater: hub.updater.state, knowledge: knowledge.meta(), selected: ui.selected() });
      }
      if (url.pathname === '/accounts' && req.method === 'GET') {
        const out = [];
        for (const acc of accounts.load().accounts) {
          const bot = hub.bot(acc.id);
          out.push(bot ? await bot.status() : { id: acc.id, label: acc.label, color: acc.color, owner: acc.owner, open: false, status: acc.status || 'active', persona: personas.card(personas.get(acc.persona)) });
        }
        return reply(200, out);
      }
      if (url.pathname === '/accounts' && req.method === 'POST') {
        const b = await body(req);
        if (!String(b.username || '').trim() || !String(b.password || '')) return reply(400, { error: 'username and password are both needed' });
        const acc = hub.add({ username: String(b.username).trim(), password: String(b.password), label: String(b.label || '').trim() || String(b.username).trim(), kind: b.kind === 'party' ? 'party' : 'guest', email: b.email || '' });
        return reply(200, { id: acc.id, label: acc.label, kind: acc.kind });
      }
      // Ways to get an item: Skua scripts and methods that name it, and the wiki routes for wearables (lib/finder.js).
      if (url.pathname === '/farm/find') return reply(200, await require('./finder').find(String(url.searchParams.get('item') || ''), { hub, bot: hub.bot(url.searchParams.get('for') || '') }));
      if (parts[0] === 'accounts' && parts[1] && parts[2] === 'update') return reply(200, accounts.update(parts[1], await body(req)));
      if (parts[0] === 'accounts' && parts[1] && parts[2] === 'remove') return reply(200, hub.remove(parts[1]));
      if (parts[0] === 'accounts' && parts[1] && parts[2] === 'activate' && req.method === 'POST') return reply(200, hub.activate(parts[1]));
      if (url.pathname === '/assist' && req.method === 'GET') return reply(200, { ...hub.settings.assist, servers: hub.servers ? hub.servers() : [] });
      if (url.pathname === '/assist' && req.method === 'POST') return reply(200, hub.setAssist(await body(req)));
      if (url.pathname === '/progression') return reply(200, { stages: progression.STAGES, goals: progression.GOALS, ultras: progression.ULTRAS, personas: Object.values(personas.PERSONAS).map(personas.card) });
      if (url.pathname === '/party' && req.method === 'POST') { const b = await body(req); return reply(200, hub.setParty(b.name || 'party', b.leader, b.members || [])); }
      // ----- overseer (local AI brain) -----
      if (url.pathname === '/health') {
        const h = hub.health ? (url.searchParams.get('now') ? { findings: await hub.health.check() } : hub.health.status()) : {};
        // Stuck work the watchdog could not explain (hub.diagnose -> attend): on the dashboard next to the health checks.
        const att = hub.attentionList ? hub.attentionList().filter((x) => Date.now() - x.at < 3 * 86400000).map((x) => ({ bot: x.bot, key: x.key, attention: true, text: `${x.text}${x.n > 1 ? ` (${x.n}x)` : ''} - ${x.task}` })) : [];
        return reply(200, { ...h, findings: [...att, ...((h && h.findings) || [])] });
      }
      if (url.pathname === '/attention/dismiss' && req.method === 'POST') { const b = await body(req); return reply(200, hub.dismissAttention(b.key)); }
      if (url.pathname === '/overseer' && req.method === 'GET') return reply(200, hub.overseer ? hub.overseer.status() : { enabled: false });
      if (url.pathname === '/overseer/settings' && req.method === 'POST') return reply(200, hub.overseer.setCfg(await body(req)));
      if (url.pathname === '/overseer/think' && req.method === 'POST') { require('./llm').resume(); hub.overseer.think('the owner asked me to think now'); return reply(200, { ok: true }); }
      if (url.pathname === '/overseer/chat' && req.method === 'POST') { const b = await body(req); return reply(200, await hub.overseer.chat(b.message)); }
      if (url.pathname === '/overseer/chat' && req.method === 'GET') return reply(200, hub.overseer.history('chat.jsonl', 60));
      if (url.pathname === '/overseer/thoughts') return reply(200, hub.overseer.history('thoughts.jsonl', 40).filter((r) => r.kind !== 'status' || Date.now() - r.t < 600000));
      if (url.pathname === '/overseer/approve' && req.method === 'POST') { const b = await body(req); return reply(200, { result: await hub.overseer.approve(b.id) }); }
      if (url.pathname === '/overseer/dismiss' && req.method === 'POST') { const b = await body(req); hub.overseer.dismiss(b.id); return reply(200, { ok: true }); }

      // ----- army commands (VibeSkua "army control"): one command, many bots -----
      if (url.pathname === '/army' && req.method === 'POST') {
        const b = await body(req);
        const ids = Array.isArray(b.members) && b.members.length ? b.members : [...hub.bots.keys()];
        const out = {};
        for (const id of ids) {
          const bot = hub.bot(id);
          if (!bot) { out[id] = 'no such bot'; continue; }
          switch (b.op) {
            case 'start': bot.paused = false; out[id] = bot.start() ? 'started' : 'already running'; break;
            case 'stop': bot.stop(true); out[id] = 'stopping'; break;
            case 'pause': bot.paused = true; out[id] = 'paused'; break;
            case 'resume': bot.paused = false; out[id] = 'resumed'; break;
            case 'farm': { if (!hub.army) hub.startArmy(b); break; }
            case 'goto': bot.queue.unshift({ type: 'gotoPlayer', player: b.player, why: `army: go to ${b.player}` }); bot.save(); out[id] = 'queued'; break;
            case 'join': bot.queue.unshift({ type: 'join', map: b.map, cell: b.cell, pad: b.pad, why: `army: join /${b.map}` }, { type: 'wait', minutes: b.minutes || 10, why: 'army: waiting there' }); bot.save(); out[id] = 'queued'; break;
            case 'script': bot.queue.push({ type: 'script', path: b.path, hours: Number(b.hours) || null, why: 'army: script for everyone' }); bot.save(); out[id] = 'queued'; break;
            case 'task': bot.queue.unshift({ ...b.task, why: b.task.why || 'army command' }); bot.save(); out[id] = 'queued'; break;
            case 'clear': bot.queue = []; bot.save(); out[id] = 'cleared'; break;
            default: out[id] = `unknown op ${b.op}`;
          }
        }
        return reply(200, out);
      }

      // ----- items across every character (backpack + bank) -----
      if (url.pathname === '/items') {
        const q = (url.searchParams.get('q') || '').toLowerCase().trim();
        const rows = [];
        for (const bot of hub.bots.values()) {
          if (!(await bot.playing().catch(() => false))) continue;
          const inv = await bot.items().catch(() => []);
          const bank = await bot.bankItems().catch(() => []);
          for (const [where, list] of [['backpack', inv], ['bank', bank]]) {
            for (const it of list) {
              if (q && !String(it.sName).toLowerCase().includes(q)) continue;
              rows.push({ bot: bot.id, name: it.sName, qty: Number(it.iQty || 1), where, equipped: !!it.bEquip, ac: !!it.bCoins, type: it.sType || it.sES || '', meta: it.sMeta || '' });
            }
          }
        }
        return reply(200, rows.slice(0, 400));
      }
      if (url.pathname === '/drops') {
        const { readHistory } = require('./ask');
        const rows = [];
        for (const bot of hub.bots.values()) for (const h of readHistory(bot, 3000)) if (h.type === 'drop') rows.push({ bot: bot.id, ...h });
        return reply(200, rows.sort((a, b) => b.t - a.t).slice(0, Number(url.searchParams.get('n') || 60)));
      }
      if (url.pathname === '/dailies') {
        const list = knowledge.dailies().filter((d) => d.runnable).map((d) => ({ name: d.name, minLevel: d.minLevel }));
        const bots = [];
        for (const bot of hub.bots.values()) {
          const day = hub.brain.today(bot);
          bots.push({ id: bot.id, level: await bot.level().catch(() => 0), dailies: day.dailies, goalsToday: day.goalsToday || {}, eventHours: Math.round((day.eventMs || 0) / 360000) / 10 });
        }
        return reply(200, { list, bots });
      }

      if (url.pathname === '/levelparty' && req.method === 'GET') return reply(200, { ...hub.settings.levelParty, members: hub.levelPartyBots().map((b) => b.id), leader: (hub.levelPartyLeader() || {}).id || null });
      if (url.pathname === '/levelparty' && req.method === 'POST') return reply(200, hub.setLevelParty(await body(req)));
      if (url.pathname === '/ultraready') return reply(200, req.method === 'POST' ? await hub.refreshUltraReady() : hub.ultraReady());
      // A raid now, past the readiness rules (a test fight): POST {boss: "ultra-ezrajal"}. GET = the raid running, if any.
      if (url.pathname === '/raid' && req.method === 'GET') return reply(200, { raid: hub.raid || null, log: ((hub.settings.raids || {}).log || []).slice(-10) });
      // Keep a boss off the automatic raids, or let it back: POST {boss, hold: true | false, days?, forever?}. A hold ends
      // by itself after `days` (14; hub.raidHeld) unless forever: true.
      if (url.pathname === '/raid/hold' && req.method === 'POST') {
        const b = await body(req);
        const s = new Set(hub.settings.raidHold || []);
        const meta = (hub.settings.raidHoldMeta = hub.settings.raidHoldMeta || {});
        if (b.hold === false) { s.delete(b.boss); delete meta[b.boss]; } else { s.add(b.boss); meta[b.boss] = { since: Date.now(), days: Number(b.days) > 0 ? Number(b.days) : 14, ...(b.forever ? { forever: true } : {}) }; }
        hub.settings.raidHold = [...s]; hub.saveSettings();
        return reply(200, { raidHold: hub.settings.raidHold, raidHoldMeta: meta });
      }
      if (url.pathname === '/raid' && req.method === 'POST') { const b = await body(req); return reply(200, await hub.startRaid(b.boss, { force: true, swap: b.swap })); }
      // Raid Planner (dashboard): GET = bosses, roles, characters + classes, the raid now; POST /raid/plan {boss, seats:
      // [{id, cls, role, potions, potionList, scroll}]} starts that line-up; POST /raid/stop calls the raid off (no try).
      if (url.pathname === '/raid/planner' && req.method === 'GET') return reply(200, await hub.raidPlanner());
      if (url.pathname === '/raid/plan' && req.method === 'POST') { const b = await body(req); const r = await hub.raidPlanStart(b); return reply(r.ok ? 200 : 400, r); }
      if (url.pathname === '/raid/stop' && req.method === 'POST') { const r = hub.raidStopByHand(); return reply(r.ok ? 200 : 400, r); }
      // Proven recipes (lib/recipes.js): run a boss's proven line-up now {boss}; make an alternate the proven one {boss, id}.
      if (url.pathname === '/raid/proven' && req.method === 'POST') { const b = await body(req); const r = await hub.raidProvenStart(b.boss); return reply(r.ok ? 200 : 400, r); }
      if (url.pathname === '/raid/recipe/promote' && req.method === 'POST') { const b = await body(req); const r = require('./recipes').promote(b.boss, b.id); return reply(r ? 200 : 400, r ? { ok: true, recipe: r } : { ok: false, error: 'no such line-up' }); }
      // Send the party to help one character now (the owner 2026-10-17: "send the party to help nova, the party help each
      // other in everything"): POST {id, monster?, map?, cell?} - the rest comes from where that character is. A wish
      // task makes it a farm call that lasts until the piece drops (3 h cap). GET = the call running; POST /help/end.
      // Several calls can be open at once (Seraph 5 squads): `calls` lists them all; POST /help/end {id?} ends one or all.
      if (url.pathname === '/help' && req.method === 'GET') return reply(200, { help: hub.help || null, calls: hub.helpCalls ? hub.helpCalls() : [], rooms: hub.squadBook ? hub.squadBook().data.rooms : {} });
      if (url.pathname === '/help/end' && req.method === 'POST') {
        const b = await body(req).catch(() => ({}));
        for (const h of hub.helpCalls ? hub.helpCalls() : [hub.help].filter(Boolean)) if (!b || !b.id || h.id === b.id) hub.endHelp('ended by hand', false, h);
        return reply(200, { ok: true });
      }
      if (url.pathname === '/help' && req.method === 'POST') {
        const b = await body(req);
        const bot = hub.bot(b.id);
        if (!bot) return reply(404, { error: 'no such bot' });
        const mon = b.monster || (bot.current && bot.current.route && bot.current.route.monster) || (bot.current && bot.current.monster);
        if (!mon) return reply(400, { error: 'monster unknown' });
        // item + want (+ have): a farm call - the party stays until the caller has `want` of it, not one kill (2026-10-27,
        // the main's 200 Water Elf Antlers from The Ashray: its merge script restarts its steps too often for the step
        // text to show the count when the call opens).
        const farm = b.item && Number(b.want) > 0 ? { item: String(b.item), want: Number(b.want), have: Number(b.have) || 0 } : null;
        const h = await hub.requestHelp(bot, { map: b.map || await bot.map(), cell: b.cell || await bot.cell(), monster: mon, why: b.why || 'asked through the API', ...(farm ? { farm } : {}) });
        return reply(200, { help: h });
      }
      if (url.pathname === '/boosts' && req.method === 'GET') return reply(200, hub.boosts ? hub.boosts.summary() : {});
      // Walls and party escorts (lib/walls.js). POST {mode: "off" | "plan" | "on" | "auto"} sets hub.json escorts.
      if (url.pathname === '/walls' && req.method === 'GET') return reply(200, hub.walls ? hub.walls.summary() : {});
      if (url.pathname === '/walls/mode' && req.method === 'POST') { const b = await body(req); if (b.mode === 'auto') delete hub.settings.escorts; else hub.settings.escorts = b.mode; hub.saveSettings(); return reply(200, hub.walls.summary()); }
      // What the Skua engines asked the world model for since the last 10-min report (count, ms, answer bytes).
      if (url.pathname === '/engine/calls' && req.method === 'GET') return reply(200, require('./skua/engine').callStats(false).slice(0, Number(url.searchParams.get('top') || 40)));
      // The engine budget (hub.engineRoom/engineGovernor): floor, ceiling, who holds or waits, the kernel's pressure.
      if (url.pathname === '/engine/budget' && req.method === 'GET') return reply(200, hub.engineBudget());
      // The engine limits (lib/enginelimits.js): every value, where it came from (hub.json / env / auto), the auto value
      // and the machine. POST {key: number | true/false | null} saves to hub.json; null or "auto" goes back to auto.
      // Counts apply to the next engine start, heap/recycle/nice to each character's next script.
      if (url.pathname === '/engine/settings') {
        const el = require('./enginelimits');
        if (req.method === 'POST') {
          const v = el.validate(await body(req));
          if (!v.ok) return reply(400, { error: v.errors.join('; '), errors: v.errors });
          Object.assign(hub.settings, v.set);
          for (const k of v.unset) delete hub.settings[k];
          hub.saveSettings();
          hub.info(`engine settings: ${[...Object.entries(v.set).map(([k, x]) => `${k}=${x}`), ...v.unset.map((k) => `${k}=auto`)].join(', ') || 'nothing changed'}`);
        }
        const r = el.resolve(hub.settings, { headless: !!hub.headless, characters: hub.bots ? hub.bots.size : 0 });
        return reply(200, { ...r, keys: el.KEYS });
      }
      if (url.pathname === '/crew' && req.method === 'GET') return reply(200, hub.crewStatus());
      // A one-off boss round with the party (crew.json "bosses"): {"name":"NightmareCarnax"}.
      if (url.pathname === '/crew/boss' && req.method === 'POST') { const b = await body(req); return reply(200, await hub.crewBossStart(String(b.name || ''))); }
      if (url.pathname === '/weekly' && req.method === 'GET') return reply(200, await hub.weeklyBoard());
      if (url.pathname === '/boosts/refresh' && req.method === 'POST') { await hub.boosts.refresh(); return reply(200, hub.boosts.summary()); }
      if (url.pathname === '/knowledgebook/rebuild' && req.method === 'POST') { require('./knowledgebook').rebuild(hub, (m) => hub.info(m)).catch((e) => hub.info(`knowledge book failed: ${e.message}`)); return reply(200, { started: true }); }
      if (url.pathname === '/hub/log') return reply(200, hub.log.slice(-200));
      if (url.pathname === '/hub/settings' && req.method === 'GET') return reply(200, hub.settings);
      if (url.pathname === '/hub/settings' && req.method === 'POST') { Object.assign(hub.settings, await body(req)); hub.saveSettings(); return reply(200, hub.settings); }
      if (url.pathname === '/update' && req.method === 'POST') return reply(200, await hub.updater.runAll());
      // The dashboard's "update the Skua library" button: the same single puller the updater uses (no second git).
      if (url.pathname === '/scripts/pull' && req.method === 'POST') return reply(200, await hub.updater.pullScripts());
      // The Flash standby (lib/flashstandby.js): the real AQW game for up to N characters when the headless client fails.
      if (url.pathname.startsWith('/flash')) {
        const sb = hub.standby;
        if (!sb) return reply(200, { available: false, why: 'the Flash standby only exists on the headless server' });
        const run = () => sb.tick().catch((e) => hub.info(`flash standby: ${e.message}`));
        if (url.pathname === '/flash' && req.method === 'GET') return reply(200, { available: true, ...(await sb.status()) });
        if (url.pathname === '/flash/settings' && req.method === 'POST') { const cfg = sb.setCfg(await body(req)); run(); return reply(200, cfg); }
        if (url.pathname === '/flash/standby' && req.method === 'POST') {
          const b = await body(req);
          if (b.on) { sb.autoOn = { at: new Date().toISOString(), reason: 'turned on from the dashboard', manual: true }; sb.note('standby ON - turned on from the dashboard'); }
          else { sb.autoOn = null; sb.trial = null; sb.note('standby OFF - turned off from the dashboard'); }
          sb.save(); run();
          return reply(200, { ok: true });
        }
        if (url.pathname === '/flash/shot' && req.method === 'GET') {
          const id = String(url.searchParams.get('id') || '');
          const client = hub.clients.get(id);
          if (!client || !client.flash) return reply(404, { error: 'not in Flash mode' });
          const file = require('path').join(P.TMP, `flash-${id}.png`);
          const got = await client.screenshot(file);
          if (!got) return reply(404, { error: 'no picture yet' });
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
          return res.end(require('fs').readFileSync(file));
        }
      }
      // Skua's "Reset Scripts" (delete + download again, compile cache cleared): lib/updater.js resetScripts.
      if (url.pathname === '/scripts/reset' && req.method === 'POST') { const b = await body(req).catch(() => ({})); return reply(200, await hub.updater.resetScripts((b && b.why) || 'asked through the API')); }
      // A message for the owner from a job outside the hub (the PC's engine/auto-update.js, over ssh): channel, or DM.
      if (url.pathname === '/notify' && req.method === 'POST') {
        const b = await body(req);
        hub.notify(String(b.title || 'Seraph'), String(b.body || ''), b.kind || 'alert');
        if (b.dm && hub.discord && hub.discord.enabled) hub.discord.send(`⚠️ **${b.title || 'Seraph'}**\n${b.body || ''}`, { kind: 'alert', key: `dm:${b.key || b.title}`, dm: true });
        return reply(200, { ok: true });
      }
      // Status report: GET /report/text?hours=24 (plain text) · POST /report/discord (post it to the channel)
      if (url.pathname === '/report/text') { const t = await require('./report').text(hub, { hours: Number(url.searchParams.get('hours') || 24) }); res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(t); }
      if (url.pathname === '/report/discord' && req.method === 'POST') { const b = await body(req); return reply(200, { sent: await require('./report').toDiscord(hub, { hours: b.hours || 24 }) }); }
      if (url.pathname === '/report' && req.method === 'POST') { await hub.writeReports(); return reply(200, { ok: true }); }
      // Weekly report (lib/report.js weekly): GET the text, POST to post it to Discord and save it under reports/.
      if (url.pathname === '/report/weekly' && req.method === 'GET') { const t = (await require('./report').weekly(hub)).join('\n\n'); res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(t); }
      if (url.pathname === '/report/weekly' && req.method === 'POST') return reply(200, { sent: await require('./report').weeklyToDiscord(hub) });
      // ETA to level 100 per character (lib/eta.js).
      if (url.pathname === '/eta' && req.method === 'GET') { const out = {}; for (const b of hub.bots.values()) out[b.id] = await require('./eta').forBot(b, hub).catch((e) => ({ error: e.message })); return reply(200, out); }
      if (url.pathname === '/scripts') {
        const words = (url.searchParams.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
        const flat = (x) => x.replace(/[^a-z0-9]/g, '');
        const hits = scriptCatalog().map((s) => {
          const hay = `${s.name} ${s.path} ${s.description} ${(s.tags || []).join(' ')}`.toLowerCase();
          if (!words.every((w) => hay.includes(w) || flat(hay).includes(flat(w)))) return null;
          const q = flat(words.join(''));
          return { s, score: (flat(s.name.toLowerCase()).includes(q) ? 0 : 2) + ((s.tags || []).some((t) => flat(t) === q) ? 0 : 1) + s.path.length / 1000 };
        }).filter(Boolean).sort((a, b) => a.score - b.score);
        return reply(200, hits.slice(0, 100).map((h) => h.s));
      }
      if (url.pathname === '/scripts/methods') {
        // Public methods of a script (and their parameters), to run one of them the Farmer Joe way (entry + args).
        const rel = String(url.searchParams.get('path') || '');
        const file = path.join(P.SCRIPTS, ...rel.split('/'));
        if (!file.startsWith(P.SCRIPTS) || !fs.existsSync(file)) return reply(404, { error: 'no such script' });
        const src = fs.readFileSync(file, 'utf8');
        const out = [];
        const re = /public\s+(?:static\s+)?void\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
        let m;
        while ((m = re.exec(src))) if (!out.some((x) => x.name === m[1])) out.push({ name: m[1], params: m[2].replace(/\s+/g, ' ').trim() });
        return reply(200, out);
      }
      if (url.pathname === '/translate') return reply(200, translate(P.SCRIPTS, url.searchParams.get('path')));
      if (url.pathname === '/knowledge') {
        return reply(200, { meta: knowledge.meta(), events: knowledge.eventCandidates().map((e) => ({ folder: e.folder, maps: e.maps })), dailies: knowledge.dailies().map((d) => ({ name: d.name, runnable: d.runnable, memberOnly: d.memberOnly, minLevel: d.minLevel })), gameTitle: hub.updater.state.game && hub.updater.state.game.sTitle });
      }
      if (url.pathname === '/ui/select' && req.method === 'POST') { const b = await body(req); ui.select(b.id || null); return reply(200, { selected: ui.selected() }); }
      if (url.pathname === '/ui/capture' && req.method === 'POST') return reply(200, await ui.capture(path.join(P.ROOT, 'shots')));
      if (url.pathname === '/ui/grid' && req.method === 'POST') { const b = await body(req); return reply(200, { grid: ui.setGrid ? ui.setGrid(b.on !== false) : false }); }
      if (url.pathname === '/ui/view' && req.method === 'POST') { const b = await body(req); if (ui.view) ui.view(b.view); return reply(200, { ok: true }); }
      if (url.pathname === '/ui/repaint' && req.method === 'POST') { if (ui.repaint) ui.repaint(); return reply(200, { ok: true }); }
      if (url.pathname === '/ui/reload' && req.method === 'POST') { if (ui.reload) ui.reload(); return reply(200, { ok: true }); }
      if (url.pathname === '/quit') { reply(200, { ok: true }); return setTimeout(() => ui.quit(), 300); }

      // ----- per account: /a/<id>/... ; legacy single-account routes use the first account -----
      let bot = first; let rest = url.pathname;
      if (parts[0] === 'a' && parts[1]) { bot = hub.bot(parts[1]); rest = '/' + parts.slice(2).join('/'); if (!bot) return reply(404, { error: `no account ${parts[1]}` }); }
      if (!bot) return reply(404, { error: 'no accounts' });
      const client = hub.clients.get(bot.id);
      if (rest === '/status') return reply(200, await bot.status(true));
      if (rest === '/events') {
        const since = Number(url.searchParams.get('since') || 0);
        const kinds = (url.searchParams.get('kinds') || '').split(',').filter(Boolean);
        return reply(200, client.events.filter((e) => e.n > since && (!kinds.length || kinds.includes(e.kind))).slice(-500));
      }
      // Packet sender / spammer (Skua "Packets" tab): { packet, times, everyMs }. Game packets only (%xt%zm%...).
      if (rest === '/packet' && req.method === 'POST') {
        const b = await body(req);
        if (!/^%xt%zm%/.test(String(b.packet || ''))) return reply(400, { error: 'only %xt%zm% game packets' });
        const times = Math.min(Number(b.times || 1), 200);
        for (let i = 0; i < times; i++) { await client.send(b.packet); if (i < times - 1) await new Promise((r) => setTimeout(r, Math.max(300, Number(b.everyMs || 1000)))); }
        return reply(200, { sent: times });
      }
      if (rest === '/call' && req.method === 'POST') { const b = await body(req); return reply(200, { value: await client.call(b.fn, ...(b.args || [])) }); }
      if (rest === '/bot' && req.method === 'POST') return reply(200, await botOp(hub, bot, await body(req)));
      if (rest === '/ask' && req.method === 'POST') {
        const b = await body(req);
        const r = await ask(bot, b.q, { brain: hub.brain, persona: bot.persona });
        try { fs.appendFileSync(path.join(P.account(bot.id), 'chat.jsonl'), JSON.stringify(r) + '\n'); } catch { /* */ }
        return reply(200, r);
      }
      if (rest === '/chat') {
        const f = path.join(P.account(bot.id), 'chat.jsonl');
        const rows = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').slice(-40).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
        return reply(200, rows);
      }
      if (rest === '/journal') return reply(200, bot.lastLog.slice(-Number(url.searchParams.get('n') || 100)));
      if (rest === '/screenshot' && req.method === 'POST') return reply(200, { file: await hub.snap(bot.id, 'manual') });
      if (rest === '/reload' && req.method === 'POST') { client.view.webContents.reload(); client.state.loaded = false; return reply(200, { ok: true }); }
      return reply(404, { error: 'unknown endpoint' });
    } catch (e) {
      return reply(500, { error: String((e && e.message) || e) });
    }
  });
  server.on('error', (e) => { hub.info(`api error: ${e.message}`); if (e.code === 'EADDRINUSE') ui.quit(); });
  // Local-model answers can take minutes: Node's default 2-minute socket timeout cut AI Brain replies off.
  server.timeout = 0;
  server.keepAliveTimeout = 30 * 60000;
  server.listen(P.PORT, '127.0.0.1', () => hub.info(`api on 127.0.0.1:${P.PORT}`));
  return server;
}

module.exports = { start, botOp };
