// Phase 5 of the 2026-09-28 overhaul: the level-100 ETA (lib/eta.js), the route choice from measured XP per hour,
// crowd hours (lib/crowdhours.js) and the weekly report (lib/report.js weekly).
const fs = require('fs');
const path = require('path');
const eta = require('../lib/eta');
const { CrowdHours } = require('../lib/crowdhours');
const { Ledger, Holds } = require('../lib/ledger');
const { Brain } = require('../lib/brain');
const { P } = require('../lib/paths');
const { serverDay } = require('../lib/util');

test('eta: XP left to 100 from the measured table (+1 M a level from 7.58 M at 86), known levels override', async () => {
  eq([eta.xpToLevel(86), eta.xpToLevel(89), eta.xpToLevel(99)], [7.58e6, 10.58e6, 20.58e6]);
  const from87 = eta.remaining(87, 0, 8.58e6);
  eq(Math.round(from87 / 1e5) / 10, 189.5, '~190 M from the start of 87 (audit: 170-193 M)');
  eq(eta.remaining(99, 20e6, 20.58e6), 0.58e6);
  eq(eta.remaining(100, 0, 0), 0);
  eq(eta.remaining(98, 0, 0, { 98: 1e6, 99: 2e6 }), 3e6, 'levels seen in levelUp packets win');
});

test('eta: pace from the last full days, else from the week\'s level-ups; the line says where it came from', async () => {
  const now = Date.parse('2026-09-29T15:00:00Z');
  const d = (n) => serverDay(new Date(now - n * 86400000));
  const p1 = eta.pace({ [d(3)]: 30e6, [d(2)]: 20e6, [d(1)]: 25e6, [d(0)]: 5e6 }, [], {}, now);
  eq([p1.perDay, p1.source], [25e6, 'XP of the last 3 days']);
  const lv = [{ t: now - 3 * 86400000, level: 86 }, { t: now - 2 * 86400000, level: 87 }, { t: now - 86400000, level: 88 }];
  const p2 = eta.pace({}, lv, {}, now);
  eq(p2.perDay, Math.round((7.58e6 + 8.58e6) / 2), 'levels 86 and 87 crossed in two days');
  eq(eta.pace({}, [], {}, now).perDay, null);
  const line = eta.line({ level: 88, left: 150e6, perDay: 15e6, days: 10, at: '2026-10-09', source: 'XP of the last 3 days', boostNote: '2x XP: Double EXP (2026-09-30)' });
  assert(/level 100: 150 M XP to go at 15 M\/day \(XP of the last 3 days\) → ~10 days, 2026-10-09 · 2x XP/.test(line), line);
});

test('ledger: XP per day and level costs are kept for the ETA, written at most once a minute', async () => {
  const dir = path.join(process.env.SERAPH_ROOT, 'etaledger');
  fs.mkdirSync(dir, { recursive: true });
  const L = new Ledger(path.join(dir, 'ledger.json'));
  L.addXp(1000, '2026-09-28'); L.addXp(500, '2026-09-28'); L.addXp(0); L.levelCost(88, 9.58e6);
  eq([L.data.xpDays['2026-09-28'], L.data.xpTable[88]], [1500, 9.58e6]);
  assert(L._slowTimer, 'a slow save is pending, not a write per kill');
  L.flush();
  eq(new Ledger(path.join(dir, 'ledger.json')).data.xpDays['2026-09-28'], 1500);
  clearTimeout(L._slowTimer);
});

test('crowd hours: samples per hour of the week, busiest hours first', async () => {
  const C = new CrowdHours(path.join(process.env.SERAPH_ROOT, `crowd-${Date.now()}.json`));
  const sat18 = new Date('2026-09-26T18:10:00Z');
  const mon04 = new Date('2026-09-28T04:10:00Z');
  for (const c of [1400, 1500]) C.add([{ sName: 'Artix', iCount: c, iMax: 1500, bOnline: 1 }, { sName: 'Swordhaven', iCount: 300, bOnline: 1 }, { sName: 'Down', iCount: 0, bOnline: 0 }], sat18);
  for (const c of [200, 240]) C.add([{ sName: 'Artix', iCount: c, iMax: 1500, bOnline: 1 }], mon04);
  eq(C.best('Artix', 2).map((b) => [b.at, b.avg]), [['Sat 18:00 UTC', 1450], ['Mon 04:00 UTC', 220]]);
  eq(C.at('Artix', new Date('2026-10-03T18:40:00Z')), 1450, 'same hour next week');
  eq(C.at('Down', sat18), null);
});

test('brain: below 100, 13 LoC runs while it pays at least half of grinding, measured; the grind says its rate', async () => {
  const brain = new Brain();
  const id = `route${Math.random().toString(36).slice(2, 6)}`;
  fs.mkdirSync(P.account(id), { recursive: true });
  const bot = { id, ledger: new Ledger(path.join(P.account(id), 'ledger.json')) };
  eq(brain.routeXph(bot, 'grind', 1.15e6), { xph: 1.15e6, measured: false }, 'the audit number until measured');
  bot.ledger.route('grind', { minutes: 60, xp: 1.3e6 });
  bot.ledger.route('story-13loc', { minutes: 20, xp: 0.1e6 });
  eq(brain.routeXph(bot, 'grind', 1.15e6).measured, true);
  eq(brain.routeXph(bot, 'story-13loc', 2.5e6), { xph: 2.5e6, measured: false }, '20 min is not enough to judge');
  bot.ledger.route('story-13loc', { minutes: 40, xp: 0.2e6 });
  const loc = brain.routeXph(bot, 'story-13loc', 2.5e6);
  assert(loc.measured && loc.xph < 1.3e6 / 2, JSON.stringify(loc));
  clearTimeout(bot.ledger._saveTimer); clearTimeout(bot.ledger._slowTimer);
});

test('report: the weekly report - levels, XP, ETA, routes, walls cleared, escorts, busy hours', async () => {
  const { weekly } = require('../lib/report');
  const { Walls } = require('../lib/walls');
  const id = `weekly${Math.random().toString(36).slice(2, 6)}`;
  fs.mkdirSync(P.account(id), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(P.account(id), 'history.jsonl'), [
    { t: now - 3 * 86400000, type: 'level', level: 87 }, { t: now - 86400000, type: 'level', level: 88 }, { t: now - 3600000, type: 'death' }, { t: now - 3600000, type: 'quest' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const bot = { id, account: { label: 'Weekly7' }, status: async () => ({ level: 88, exp: 1e6, expTo: 9.58e6 }) };
  bot.ledger = new Ledger(path.join(P.account(id), 'ledger.json'));
  bot.ledger.route('grind', { minutes: 120, xp: 2.4e6 });
  const hub = { bots: new Map([[id, bot]]), settings: {}, bot: () => bot };
  hub.walls = new Walls(hub, path.join(process.env.SERAPH_ROOT, `wk-walls-${now}.json`));
  hub.walls.data.walls.dread = { id: 'dread', boss: 'SUPER Dreadhaven General', blocks: {}, cleared: { [id]: now - 3600000 }, plan: { kind: 'cleared' } };
  hub.walls.data.walls.alteon = { id: 'alteon', boss: 'Ultra Chaos Alteon', blocks: { [id]: { tasks: {} } }, plan: { kind: 'later', why: 'x' } };
  hub.walls.data.escorts.push({ at: now - 7200000, boss: 'DoomKitten', result: 'plan only' });
  hub.crowdHours = new CrowdHours(path.join(process.env.SERAPH_ROOT, `wk-crowd-${now}.json`));
  hub.crowdHours.add([{ sName: 'Artix', iCount: 1450, bOnline: 1 }]); hub.crowdHours.add([{ sName: 'Artix', iCount: 1450, bOnline: 1 }]);
  const text = (await weekly(hub, now)).join('\n\n');
  for (const re of [/\*\*Weekly7\*\* - level 88 \(\+2 this week\)/, /XP: 16\.2 M this week \(from the levels gained\)/, /level 100: .*XP to go at .*M\/day \(1 level-up this week\)/,
    /Best routes \(XP\/h, measured\): grind 1\.2 M/, /Deaths 1 · quests 1/, /Walls cleared: SUPER Dreadhaven General \(weekly/, /Walls in the way: Ultra Chaos Alteon: later/,
    /Escorts: DoomKitten - plan only/, /Busiest hours on Artix/]) assert(re.test(text), `${re}\n${text}`);
  clearTimeout(bot.ledger._saveTimer); clearTimeout(bot.ledger._slowTimer);
});
