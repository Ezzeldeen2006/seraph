// Ask a character a question ("did you get X?", "did you do Y?", "where are you?") and get an answer built only from
// real data: backpack, temp items, bank, the character's history (drops, quests, deaths, levels, banking, barber),
// quest progress in game, today's brain state, goals and live status. No guessing: if the data isn't there, it says so.
const fs = require('fs');
const path = require('path');
const knowledge = require('./knowledge');
const progression = require('./progression');

const STOP = new Set(['did', 'you', 'the', 'a', 'an', 'any', 'get', 'got', 'find', 'found', 'have', 'has', 'own', 'do', 'done', 'finish', 'finished', 'complete', 'completed', 'yet', 'already', 'your', 'my', 'of', 'for', 'to', 'in', 'is', 'are', 'it', 'drop', 'dropped', 'loot', 'looted', 'pick', 'picked', 'up', 'today', 'ever', 'still', 'how', 'many', 'much', 'what', 'where', 'when', 'please', 'hey', 'can', 'tell', 'me', 'we', 'i', 'there', 'some', 'quest']);
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Best fuzzy match of a phrase against names: exact > contains > all words present > most words present.
function match(phrase, names) {
  const want = norm(phrase);
  const ws = words(phrase);
  if (!want || !ws.length) return [];
  const scored = [];
  for (const name of names) {
    const n = norm(name);
    if (!n) continue;
    let score = 0;
    const compact = n.replace(/ /g, ''); const wantC = want.replace(/ /g, '');
    if (n === want || compact === wantC) score = 100;
    else if (wantC.length > 3 && compact.includes(wantC)) score = 75;
    else if (n.includes(want)) score = 80 - Math.min(20, n.length - want.length);
    else {
      const hit = ws.filter((w) => n.split(' ').some((t) => t === w || (w.length > 3 && t.startsWith(w)))).length;
      if (hit === ws.length) score = 60; else if (hit) score = 20 + (hit / ws.length) * 30;
    }
    if (score >= 45) scored.push({ name, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}

function readHistory(bot, max = 20000) {
  const file = path.join(bot.dir, 'history.jsonl');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-max);
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const n = (x) => Number(x || 0).toLocaleString();

// Pull the thing being asked about out of the question.
function subject(q, verbs) {
  const m = new RegExp(`\\b(?:${verbs})\\b\\s+(?:the\\s+|a\\s+|an\\s+|any\\s+|your\\s+)?(.+?)[?.!]*$`, 'i').exec(q);
  if (!m) return '';
  return m[1].replace(/\b(yet|already|today|ever|still)\b/gi, '')
    .replace(/^(?:(?:you|did|do|does|have|has|get|got|find|found|finish|finished|complete|completed|done|beat|clear|the|a|an|any|your)\s+)+/i, '').trim();
}

async function itemFacts(bot, phrase) {
  const inv = await bot.items().catch(() => []);
  const temp = await bot.tempItems().catch(() => []);
  const bank = await bot.bankItems(2 * 60000).catch(() => []);
  const hist = readHistory(bot).filter((h) => h.type === 'drop' || h.type === 'banked');
  const names = [...new Set([...inv, ...temp, ...bank].map((i) => i.sName).concat(hist.map((h) => h.item)).filter(Boolean))];
  const hits = match(phrase, names);
  if (!hits.length) return { found: false, phrase };
  const top = hits.filter((h) => h.score >= hits[0].score - 5).slice(0, 3).map((h) => h.name);
  return {
    found: true,
    items: top.map((name) => {
      const lower = name.toLowerCase();
      const qty = (list) => list.filter((i) => String(i.sName).toLowerCase() === lower).reduce((t, i) => t + Number(i.iQty || 1), 0);
      const drops = hist.filter((h) => h.type === 'drop' && String(h.item).toLowerCase() === lower);
      const worn = inv.some((i) => String(i.sName).toLowerCase() === lower && i.bEquip);
      return { name, backpack: qty(inv), temp: qty(temp), bank: qty(bank), worn, drops: drops.length, lastDrop: drops.length ? drops[drops.length - 1].t : null };
    }),
  };
}

async function questFacts(bot, phrase, brain) {
  const out = [];
  // Progression goals first ("lord of order", "13 lords of chaos", "archpaladin").
  const goals = brain ? brain.goals(bot).goals : progression.goalsFor(null);
  const goalHit = match(phrase, goals.map((g) => g.label))[0];
  if (goalHit && goalHit.score >= 60) {
    const g = goals.find((x) => x.label === goalHit.name);
    let done = false;
    if (g.have) done = await bot.owns(g.have).catch(() => false);
    else if (g.haveQuest) done = await bot.completedOnce(g.haveQuest).catch(() => false);
    out.push({ kind: 'goal', name: g.label, done, when: g.when, purpose: g.purpose });
  }
  // Dailies today.
  const day = brain ? brain.today(bot) : { dailies: {} };
  const dailyHit = match(phrase, Object.keys(day.dailies || {}).concat(knowledge.dailies().map((d) => d.name)))[0];
  if (dailyHit && dailyHit.score >= 60) out.push({ kind: 'daily', name: dailyHit.name, today: (day.dailies || {})[dailyHit.name] || 'not yet' });
  // Quests: history of turn-ins, then the quest database (one-time quests can be checked in game).
  const hist = readHistory(bot).filter((h) => h.type === 'quest' && h.name);
  const histHit = match(phrase, [...new Set(hist.map((h) => h.name))])[0];
  if (histHit) {
    const runs = hist.filter((h) => h.name === histHit.name);
    out.push({ kind: 'quest', name: histHit.name, done: true, times: runs.length, last: runs[runs.length - 1].t });
  } else if (!out.length) {
    const all = [...knowledge.quests().values()];
    const qHit = match(phrase, all.map((q) => q.Name))[0];
    if (qHit && qHit.score >= 60) {
      const q = all.find((x) => x.Name === qHit.name);
      const done = q.Once ? await bot.completedOnce(q.ID).catch(() => false) : null;
      out.push({ kind: 'quest', name: q.Name, id: q.ID, done, times: 0, once: !!q.Once });
    }
  }
  return out;
}

// Answer a question. `ctx` = { brain, persona }.
async function ask(bot, question, ctx = {}) {
  const q = String(question || '').trim();
  const p = ctx.persona || bot.persona || null;
  const who = p ? p.name : bot.account.label;
  const say = (text, facts = {}) => ({ who, question: q, answer: text, facts, t: Date.now() });
  if (!q) return say('Ask me something, like "did you get Blade of Awe?" or "where are you?"');
  const lq = q.toLowerCase();
  const online = await bot.playing().catch(() => false);
  const hist = readHistory(bot);

  if (/^(help|\?|what can (i|you) ask)/.test(lq)) {
    return say('Try: did you get <item> · did you do <quest/daily/goal> · where are you · what are you doing · level · gold · classes · kills today · deaths · what\'s next · when did you last die / level up · did you visit the barber · what are you wearing · who are you · what do you want.');
  }

  // --- status-like questions ---
  if (/\b(where|which map|what map)\b/.test(lq) && !/\bget|find\b/.test(lq)) {
    if (!online) return say(`I'm offline right now.`);
    return say(`I'm in /${await bot.map()} (${await bot.cell()}) on ${bot.serverName || '?'}.`, { map: await bot.map(), cell: await bot.cell() });
  }
  if (/\b(what are you doing|doing now|busy|current task|why)\b/.test(lq)) {
    const c = bot.current;
    if (!c) return say(bot.running ? 'Between tasks - deciding what to do next.' : 'Nothing, my bot is stopped.');
    return say(`${c.type}${c.path ? ` (${path.basename(c.path, '.cs')})` : c.name ? ` (${c.name})` : ''}: ${c.why || 'queued by hand'}. Started ${ago(c.startedAt || Date.now())}.`, { current: c });
  }
  if (/\b(what('?s| is) next|plan|goals?|what will you)\b/.test(lq) && ctx.brain) {
    const plan = await ctx.brain.plan(bot);
    const next = plan.goals.filter((g) => g.status === 'ready').slice(0, 3).map((g) => g.label);
    const later = plan.goals.filter((g) => g.status === 'later').slice(0, 3).map((g) => `${g.label} (lvl ${g.when})`);
    const owned = plan.goals.filter((g) => g.status === 'owned').map((g) => g.label);
    return say(`${plan.stage.label}, level ${plan.level}. ${next.length ? `Working on: ${next.join(', ')}.` : 'Nothing unlocked yet - leveling.'} ${later.length ? `Then: ${later.join(', ')}.` : ''}${owned.length ? ` Done: ${owned.join(', ')}.` : ''}`.trim(), { plan });
  }
  if (/\blevel\b/.test(lq) && !/\blevel ?up\b/.test(lq) && !/\b(get|find|do)\b/.test(lq)) {
    if (!online) return say(`I'm offline; last known level ${((hist.filter((h) => h.type === 'level').pop()) || {}).level || '?'}.`);
    const s = await bot.status();
    return say(`Level ${s.level} ${s.className} (${n(s.exp)}/${n(s.expTo)} XP${s.etaLevelMin != null ? `, next level in ~${s.etaLevelMin} min` : ''}).`, { level: s.level });
  }
  if (/\b(gold|money|coins)\b/.test(lq)) {
    if (!online) return say(`I'm offline right now.`);
    const s = await bot.status();
    return say(`${n(s.gold)} gold${s.goldPerHour != null ? ` (${n(s.goldPerHour)}/h)` : ''} and ${n(await bot.g('world.myAvatar.objData.intCoins', 0))} AC.`, { gold: s.gold });
  }
  if (/\b(classes|which class|what class)\b/.test(lq)) {
    if (!online) return say(`I'm offline right now.`);
    const owned = await bot.ownedClasses();
    return say(`Wearing ${await bot.className()}. I own: ${owned.join(', ') || 'none'}.`, { classes: owned });
  }
  // --- the character itself: who it is, what it wants, how its me time went ---
  if (/\b(who are you|about you|your style|describe yourself|personality)\b/.test(lq) && p) {
    return say(`${p.name}, ${p.title}. ${p.temperament} My look: ${p.style.look}.${p.fashion ? ` I'd call it ${p.fashion.identity}.` : ''}`, { persona: p.id });
  }
  if (/\b(what do you want|wish|dream|desire|want next|wishlist)\b/.test(lq) && p && p.fashion) {
    const st = ctx.brain ? ctx.brain.state(bot) : {};
    const day = ctx.brain ? ctx.brain.today(bot) : { styleMs: 0 };
    const got = []; const want = [];
    for (const d of p.fashion.dream || []) ((await bot.owns(d.name).catch(() => false)) ? got : want).push(d);
    const next = want[0];
    const mins = Math.round((day.styleMs || 0) / 60000);
    return say(`${next ? `Right now I want ${next.name} (${next.slot}) - ${next.why || 'it is just so me'}.` : 'I have everything I dreamed of. For now.'}${want.length > 1 ? ` After that: ${want.slice(1, 4).map((d) => d.name).join(', ')}.` : ''}${got.length ? ` Already mine: ${got.map((d) => d.name).join(', ')}.` : ''} Me time today: ${mins} min.`, { want: want.map((d) => d.name), got: got.map((d) => d.name), styleMin: mins, fails: st.wishFails || {} });
  }
  if (/\b(wear|wearing|outfit|look like|dressed)\b/.test(lq)) {
    if (!online) return say(`I'm offline right now.`);
    const set = await bot.equippedSet();
    const slot = { ar: 'class', co: 'armor', he: 'helm', ba: 'cape', Weapon: 'weapon', pe: 'pet', am: 'necklace', mi: 'misc' };
    return say(Object.entries(set).map(([k, v]) => `${slot[k] || k}: ${v}`).join(' · ') || 'Nothing equipped?', { set });
  }
  if (/\b(barber|hair)\b/.test(lq)) {
    const b = hist.filter((h) => h.type === 'barber').pop();
    return say(b ? `Yes, ${ago(b.t)}: ${b.hair || 'kept my hairstyle'}${b.ok ? '' : ' (the game did not confirm it)'}.` : 'Not yet - it is on my list once I reach level 5.', { barber: b || null });
  }
  if (/\b(last|when).*(die|died|death)|\bdeaths?\b/.test(lq)) {
    const deaths = hist.filter((h) => h.type === 'death');
    const today = deaths.filter((h) => Date.now() - h.t < 86400000);
    const last = deaths.pop();
    return say(last ? `${today.length} deaths in the last 24 h. Last one ${ago(last.t)} at /${last.map} ${last.cell}.` : 'I have not died since I started keeping history.', { deaths: today.length });
  }
  if (/\b(last|when).*level(ed)? ?up/.test(lq)) {
    const last = hist.filter((h) => h.type === 'level').pop();
    return say(last ? `Level ${last.level}, ${ago(last.t)}.` : 'No level-up recorded yet.');
  }
  if (/\bkills?\b/.test(lq)) return say(`${n(bot.stats.kills)} kills and ${n(bot.stats.quests)} quest turn-ins this session.`, { kills: bot.stats.kills });

  // --- did you DO x ---
  const doSubj = subject(q, 'do|did|finish|finished|complete|completed|done|beat|beaten|clear|cleared');
  if (/\b(do|did you do|finish|complete|done|beat|clear)\b/.test(lq) && doSubj && !/\b(get|got|find|found|have|own)\b/.test(lq)) {
    const facts = await questFacts(bot, doSubj, ctx.brain);
    if (!facts.length) return say(`I don't know anything called "${doSubj}". Try the exact quest, daily or goal name.`, { facts });
    const parts = facts.map((f) => {
      if (f.kind === 'goal') return f.done ? `${f.name}: yes, done.` : `${f.name}: not yet (unlocks at level ${f.when}${f.purpose ? ` - ${f.purpose}` : ''}).`;
      if (f.kind === 'daily') return `Daily ${f.name} today: ${f.today}.`;
      if (f.times) return `Quest "${f.name}": yes, turned in ${f.times}x, last ${ago(f.last)}.`;
      if (f.done === true) return `Quest "${f.name}": yes, it's completed on this character.`;
      if (f.done === false) return `Quest "${f.name}": no, not completed yet.`;
      return `Quest "${f.name}": I have no turn-in of it in my history.`;
    });
    return say(parts.join(' '), { facts });
  }

  // --- did you GET / FIND / HAVE x (default for anything else) ---
  const getSubj = subject(q, 'get|got|find|found|have|has|own|owns|drop|dropped|loot|looted|farm|farmed|many|much') || q.replace(/[?.!]+$/, '');
  if (!online) {
    const drops = hist.filter((h) => h.type === 'drop');
    const hit = match(getSubj, [...new Set(drops.map((d) => d.item))])[0];
    if (!hit) return say(`I'm offline, and I have no drop of "${getSubj}" in my history.`);
    const rows = drops.filter((d) => d.item === hit.name);
    return say(`I'm offline, but my history says I picked up ${hit.name} ${rows.length}x, last ${ago(rows[rows.length - 1].t)}.`);
  }
  const f = await itemFacts(bot, getSubj);
  if (!f.found) return say(`No. I don't have anything matching "${getSubj}" in my backpack, bank or drop history.`, f);
  const lines = f.items.map((it) => {
    const where = [];
    if (it.backpack) where.push(`${n(it.backpack)} in my backpack${it.worn ? ' (wearing it)' : ''}`);
    if (it.temp) where.push(`${n(it.temp)} as quest items`);
    if (it.bank) where.push(`${n(it.bank)} in the bank`);
    const drops = it.drops ? ` Dropped for me ${it.drops}x, last ${ago(it.lastDrop)}.` : '';
    return where.length ? `${it.name}: yes - ${where.join(', ')}.${drops}` : `${it.name}: not anymore (${it.drops ? `picked up ${it.drops}x before, probably used or sold` : 'seen before'}).${drops && !it.drops ? drops : ''}`;
  });
  return say(lines.join(' '), f);
}

module.exports = { ask, match, readHistory };
