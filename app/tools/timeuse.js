// Where did each character's time go? Read-only, from the journals (Seraph 5, 2026-10-26: the check-up that found
// 140 help calls a day per veteran, 5-10 h of engine waiting each, and forge scripts with 0 finishes in 120-166 starts).
// Run on the laptop:  nice -n 19 node ~/seraph/app/tools/timeuse.js [hours=24]
// Per character: loop stops, assists (count and time), time waiting for a Skua engine, time by task type, and the goals
// that took the most time with their starts and finishes.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(process.env.SERAPH_ROOT || path.join(process.env.HOME, 'seraph'), 'accounts');
const hours = Number(process.argv[2] || 24);
const since = Date.now() - hours * 3600e3;
const h = (ms) => `${(ms / 3600e3).toFixed(1)}h`;
const out = [];
for (const id of fs.readdirSync(root)) {
  const f = path.join(root, id, 'journal.log');
  if (!fs.existsSync(f)) continue;
  let cur = null; let curAt = 0; let waitAt = 0;
  const byType = {}; const byGoal = {}; const runs = {}; const done = {};
  let stops = 0; let engineWait = 0; let assists = 0; let assistMs = 0;
  const close = (t) => {
    if (!cur) return;
    const ms = t - curAt;
    byType[cur.type] = (byType[cur.type] || 0) + ms;
    if (cur.goal) byGoal[cur.goal] = (byGoal[cur.goal] || 0) + ms;
    if (cur.type === 'assist') { assists++; assistMs += ms; }
    cur = null;
  };
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!/^20\d\d-/.test(l)) continue;   // Skua's multi-line messages carry no time
    const t = Date.parse(l.slice(0, 24));
    if (!(t >= since)) continue;
    const msg = l.slice(25);
    if (msg.startsWith('task start ')) {
      close(t);
      try { cur = JSON.parse(msg.slice(11)); } catch (e) { cur = { type: '?' }; }
      curAt = t;
      if (cur.goal) runs[cur.goal] = (runs[cur.goal] || 0) + 1;
    } else if (msg.startsWith('task done') || msg.startsWith('task failed') || msg.startsWith('error:')) {
      if (cur && cur.goal && msg.startsWith('task done')) done[cur.goal] = (done[cur.goal] || 0) + 1;
      close(t);
    } else if (msg === 'bot loop stopped') { stops++; close(t); } else if (msg.startsWith('waiting for a free Skua engine')) waitAt = waitAt || t;
    else if (msg.startsWith('Skua engine:') && waitAt) { engineWait += t - waitAt; waitAt = 0; }
  }
  close(Date.now());
  const tracked = Object.values(byType).reduce((a, b) => a + b, 0);
  out.push(`== ${id}: tracked ${h(tracked)}, loop stops ${stops}, assists ${assists} (${h(assistMs)}), engine wait ${h(engineWait)}`);
  out.push(`  by type: ${Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${h(v)}`).join(', ')}`);
  out.push(`  by goal: ${Object.entries(byGoal).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${h(v)} (${runs[k] || 0} runs, ${done[k] || 0} done)`).join(', ')}`);
}
console.log(out.join('\n'));
