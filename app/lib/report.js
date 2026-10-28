// Status report for the owner: what each character is doing, what it got, what it is working toward, and the party
// picture (boosts, ultra readiness, help calls, army). Plain text that reads well in a terminal and in Discord.
// Used by: GET /report/text, POST /report/discord, the 20:00 digest, and "6 Report.bat" on the PC.
'use strict';
const fs = require('fs');
const path = require('path');
const { P } = require('./paths');
const eta = require('./eta');

const ago = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
};

function history(botId, sinceMs) {
  const file = path.join(P.account(botId), 'history.jsonl');
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); } catch (e) { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const r = JSON.parse(lines[i]); if (r.t < sinceMs) break; out.push(r); } catch (e) { /* torn line */ }
  }
  return out.reverse();
}

const TASK_WORDS = {
  farmLevel: 'leveling', script: 'running a script', daily: 'doing a daily', quest: 'questing', kill: 'farming',
  assist: 'helping a party member', armyFarm: 'army farming', probeEvent: 'checking an event', enhance: 'enhancing gear',
  sellJunk: 'selling junk', tidy: 'tidying the wardrobe', bankAc: 'banking items', gear: 'changing gear', wait: 'waiting',
};

function describeTask(t) {
  if (!t) return 'idle';
  const what = TASK_WORDS[t.type] || t.type;
  const label = t.goal ? ` "${t.goal}"` : t.name ? ` ${t.name}` : t.path ? ` ${path.basename(t.path, '.cs')}` : '';
  const since = t.startedAt ? ` for ${ago(Date.now() - t.startedAt)}` : '';
  return `${what}${label}${since}${t.why ? ` - ${t.why}` : ''}`;
}

async function botSection(hub, bot, hours) {
  const since = Date.now() - hours * 3600000;
  const online = await bot.playing().catch(() => false);
  const lvl = online ? await bot.level().catch(() => '?') : '?';
  const cls = online ? await bot.className().catch(() => '?') : '?';
  const s = bot.stats || {};
  const lines = [];
  lines.push(`**${bot.account.label}** - level ${lvl} ${cls}${bot.serverName ? ` on ${bot.serverName}` : ''}${online ? '' : ' (offline)'}`);
  lines.push(`• Now: ${bot.paused ? 'paused' : describeTask(bot.current)}`);

  // Got: from the character's own history file.
  const h = history(bot.id, since);
  const drops = h.filter((r) => r.type === 'drop');
  const ac = drops.filter((r) => r.ac).map((r) => r.item);
  const quests = h.filter((r) => r.type === 'quest');
  const levels = h.filter((r) => r.type === 'level').map((r) => r.level);
  const deaths = h.filter((r) => r.type === 'death').length;
  const got = [];
  if (levels.length) got.push(`levels ${levels[0] - 1}→${levels[levels.length - 1]}`);
  if (quests.length) got.push(`${quests.length} quests`);
  if (drops.length) got.push(`${drops.length} drops`);
  if (ac.length) got.push(`AC: ${[...new Set(ac)].slice(0, 5).join(', ')}${ac.length > 5 ? '…' : ''}`);
  lines.push(`• Got (last ${hours} h): ${got.length ? got.join(' · ') : 'nothing logged yet'}${deaths ? ` · ${deaths} deaths` : ''}`);
  // When it reaches level 100 at the pace it really keeps (lib/eta.js).
  try { lines.push(`• ${eta.line(await eta.forBot(bot, hub))}`); } catch (e) { /* offline */ }
  // The walls in its way (lib/walls.js).
  const walls = hub.walls ? hub.walls.list().filter((w) => w.plan && w.plan.kind !== 'cleared' && w.plan.kind !== 'skip' && w.blocks[bot.id]) : [];
  if (walls.length) lines.push(`• Walls: ${walls.map((w) => `${w.boss || w.item} (${w.plan.kind})`).join(', ')}`);
  if (s.kills || s.deaths) lines.push(`• Since start: ${s.kills || 0} kills, ${s.quests || 0} quests, ${s.drops || 0} drops, ${s.deaths || 0} deaths`);

  // Getting / next: the brain's own goal plan.
  try {
    const plan = await hub.brain.plan(bot);
    const goals = (plan && plan.goals) || [];
    const current = bot.current && bot.current.goal ? goals.find((g) => g.id === bot.current.goal) : null;
    if (current) lines.push(`• Working on: ${current.label || current.id}${current.purpose ? ` (${current.purpose.split(' (')[0]})` : ''}`);
    const next = goals.filter((g) => g.status === 'ready' && (!current || g.id !== current.id)).slice(0, 3);
    const later = goals.filter((g) => g.status === 'later').slice(0, 2);
    if (next.length) lines.push(`• Next: ${next.map((g) => g.label || g.id).join(' → ')}`);
    if (later.length) lines.push(`• Later: ${later.map((g) => `${g.label || g.id} (lvl ${g.when})`).join(', ')}`);
    const owned = goals.filter((g) => g.status === 'owned').length;
    if (goals.length) lines.push(`• Progress: ${owned}/${goals.length} goals done`);
  } catch (e) { /* plan unavailable while logging in */ }
  return lines.join('\n');
}

async function build(hub, opts = {}) {
  const hours = Number(opts.hours || 24);
  const sections = [];
  const head = [`__**Seraph report** - ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}__`];

  const boosts = hub.boosts && hub.boosts.summary ? hub.boosts.summary() : null;
  if (boosts) {
    if (boosts.labels && boosts.labels.length) head.push(`Boost today: ${boosts.labels.join(', ')}`);
    const soon = (boosts.upcoming || []).filter((u) => u.boost).slice(0, 2).map((u) => `${u.title} (${u.date})`);
    if (soon.length) head.push(`Coming up: ${soon.join(', ')}`);
  }
  const u = hub.ultraReady ? hub.ultraReady() : null;
  if (u) head.push(u.ready ? `Ultras: READY (${u.compName})` : `Ultras: not yet - ${(u.missing || []).slice(0, 3).join('; ')}${(u.missing || []).length > 3 ? ` (+${u.missing.length - 3} more)` : ''}`);
  // Raids (hub.raidTick): kills and misses in the last 7 days, so a quiet week is visible too.
  const raids = ((hub.settings && hub.settings.raids && hub.settings.raids.log) || []).filter((r) => Date.now() - Date.parse(r.at) < 7 * 86400000);
  if (raids.length) {
    const killed = [...new Set(raids.filter((r) => r.killed).map((r) => r.boss))];
    head.push(`Raids this week: ${killed.length ? `killed ${killed.join(', ')}` : 'no kills'} (${raids.length} raid${raids.length === 1 ? '' : 's'}, ${raids.filter((r) => !r.killed).length} without a kill)`);
  }
  for (const h of hub.helpCalls ? hub.helpCalls() : [hub.help].filter(Boolean)) head.push(`Help call: ${h.who} vs ${h.monster} in ${h.map}${h.guard ? ' (guard)' : ''}${h.full ? '' : ` - squad: ${h.helpers.join(', ')}`}`);
  if (hub.walls) {
    const W = hub.walls.summary();
    const open = W.walls.filter((w) => w.plan.kind !== 'skip');
    const recent = (W.escorts || []).filter((e) => Date.now() - e.at < hours * 3600000);
    if (open.length || recent.length) head.push(`Walls: ${open.length} in the way${open.length ? ` (${open.slice(0, 4).map((w) => `${w.boss || w.item}: ${w.plan.kind}`).join(', ')})` : ''} · escorts ${W.mode}${recent.length ? `, ${recent.length} in ${hours} h: ${recent.map((e) => `${e.boss} ${e.result || 'running'}`).join('; ')}` : ''}`);
  }
  if (hub.army) head.push(`Army: ${hub.army.item || hub.army.monster} in ${hub.army.map} (${hub.army.done.length}/${hub.army.members.length} done)`);
  sections.push(head.join('\n'));

  for (const bot of hub.bots.values()) sections.push(await botSection(hub, bot, hours));
  return sections;
}

async function text(hub, opts) { return (await build(hub, opts)).join('\n\n'); }

// ---------------- the weekly report (overhaul Phase 5) ----------------
// What the week taught: levels and XP per character, the pace and the level-100 date, the routes that paid best, the
// walls cleared and still standing, the escorts, and the busiest hours on the crowded server.
const mfmt = (n) => `${Math.round(n / 1e5) / 10} M`;
async function weekly(hub, now = Date.now()) {
  const week = now - 7 * 86400000;
  const out = [`__**Seraph weekly** - week to ${new Date(now).toISOString().slice(0, 10)}__`];
  for (const bot of hub.bots.values()) {
    const h = history(bot.id, week);
    const levels = h.filter((r) => r.type === 'level').map((r) => r.level);
    const L = (bot.ledger && bot.ledger.data) || {};
    const days = Object.entries(L.xpDays || {}).filter(([d]) => Date.parse(d + 'T12:00:00Z') >= week);
    let xp = days.reduce((a, [, v]) => a + v, 0);
    let xpHow = days.length + ' day(s) counted';
    if (days.length < 5 && levels.length) { xp = levels.reduce((a, l) => a + eta.xpToLevel(l - 1, L.xpTable || {}), 0); xpHow = 'from the levels gained'; }
    const e = await eta.forBot(bot, hub, now).catch(() => null);
    const sum = bot.ledger ? bot.ledger.summary(now) : { routes: [], held: [] };
    const routes = sum.routes.slice(0, 4);
    const parked = Object.values(L.items || {}).reduce((a, it) => a + (it.attempts || []).filter((x) => x.outcome === 'parked' && x.at >= week).length, 0);
    out.push([
      '**' + bot.account.label + '** - level ' + (e && e.level ? e.level : '?') + (levels.length ? ' (+' + levels.length + ' this week)' : ''),
      '• XP: ' + mfmt(xp) + ' this week (' + xpHow + ') · ' + eta.line(e),
      routes.length ? '• Best routes (XP/h, measured): ' + routes.map((r) => r.route + ' ' + mfmt(r.xpPerHour)).join(' · ') : '• Routes: not enough measured time yet',
      '• Deaths ' + h.filter((r) => r.type === 'death').length + ' · quests ' + h.filter((r) => r.type === 'quest').length + ' · parked ' + parked + 'x this week · resting now ' + sum.held.length,
    ].join('\n'));
  }
  if (hub.walls) {
    const W = hub.walls;
    const cleared = W.list().filter((w) => w.cleared && Object.values(w.cleared).some((t) => t >= week))
      .map((w) => (w.boss || w.item) + ' (' + Object.entries(w.cleared).filter(([, t]) => t >= week).map(([id]) => id).join(', ') + ')');
    const open = W.list().filter((w) => w.plan && !['cleared', 'skip'].includes(w.plan.kind)).map((w) => (w.boss || w.item) + ': ' + w.plan.kind);
    const esc = W.data.escorts.filter((x) => x.at >= week);
    out.push([
      '**Party**',
      '• Walls cleared: ' + (cleared.length ? cleared.join('; ') : 'none'),
      '• Walls in the way: ' + (open.length ? open.join('; ') : 'none'),
      '• Escorts: ' + (esc.length ? esc.map((x) => x.boss + ' - ' + (x.result || 'running')).join('; ') : 'none') + ' (mode ' + W.mode(now) + ')',
    ].join('\n'));
  }
  if (hub.crowdHours) {
    const server = require('./crowd').CROWD_SERVER;
    const busy = hub.crowdHours.best(server, 4);
    if (busy.length) out.push('**Busiest hours on ' + server + '**: ' + busy.map((b) => b.at + ' (~' + b.avg + ')').join(' · '));
  }
  return out;
}

// Posted on Sundays with the 20:00 digest, and kept in ~/seraph/reports/weekly-<date>.md.
async function weeklyToDiscord(hub, now = Date.now()) {
  const parts = await weekly(hub, now);
  try {
    const dir = path.join(P.ROOT, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'weekly-' + new Date(now).toISOString().slice(0, 10) + '.md'), parts.join('\n\n') + '\n');
  } catch (e) { /* the Discord copy still goes */ }
  if (!hub.discord || !hub.discord.enabled) return false;
  for (const part of parts) hub.discord.send(part, { kind: 'report', quiet: 0 });
  return true;
}

// Discord caps a message at 2000 characters: one message per section keeps every part readable.
async function toDiscord(hub, opts) {
  if (!hub.discord || !hub.discord.enabled) return false;
  for (const part of await build(hub, opts)) hub.discord.send(part, { kind: 'report', quiet: 0 });
  return true;
}

module.exports = { build, text, toDiscord, history, weekly, weeklyToDiscord };
