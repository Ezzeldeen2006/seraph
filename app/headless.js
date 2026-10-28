#!/usr/bin/env node
// Seraph without a screen: the same hub, brain and bots, talking to AQW over a socket.
// This is what runs on the Linux home server. Plain Node, no Electron, no Flash, no display.
//   node headless.js            start every active account
//   node headless.js --only nova7,valen7
// Stop it with Ctrl+C or `kill`; systemd restarts it (see deploy/seraph-bots.service).
'use strict';
const { Hub } = require('./lib/hub');
const accounts = require('./lib/accounts');
const api = require('./lib/api');
require('./lib/paths').ensureDirs();   // a fresh SERAPH_ROOT has no logs/ yet

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const only = (arg('--only') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// The API expects the desktop UI; headless has no windows, so every UI call is a no-op.
const noUi = {
  selected: () => null,
  select: () => null,
  capture: async () => null,
  setGrid: () => false,
  view: () => null,
  reload: () => null,
  repaint: () => null,
  show: () => null,
  hide: () => null,
};

const hub = new Hub(null, { headless: true, autoOpen: false });
hub.on('log', (line) => console.log(line));
// Each character's journal is the useful log on a server with no screen.
hub.on('accounts', () => {
  for (const [id, bot] of hub.bots) {
    if (bot._echo) continue;
    bot._echo = true;
    bot.on('log', (e) => console.log(`[${id}] ${e.msg}`));
  }
});

function start() {
  // "pending" = planned but not created in AQW yet (lib/accounts.js). They used to be opened anyway and each sent
  // one doomed login ("The username you typed was not found") on every start - 2026-10-21.
  const skip = (a) => a.status === 'disabled' || a.status === 'pending';
  const planned = accounts.load().accounts.filter((a) => a.status === 'pending');
  const list = accounts.load().accounts.filter((a) => !skip(a) && (!only.length || only.includes(a.id.toLowerCase())));
  if (!list.length) { console.error('no accounts to run'); process.exit(1); }
  console.log(`Seraph headless: ${list.length} character(s) - ${list.map((a) => a.label).join(', ')}`);
  if (planned.length) console.log(`waiting to be created in AQW: ${planned.map((a) => a.label).join(', ')} - press "I created it" on the tile`);
  api.start(hub, noUi);
  hub.start();
  // Open the characters a few seconds apart: four logins at once looks like an attack to the game server.
  list.forEach((acc, i) => setTimeout(() => {
    try { hub.open({ ...acc, autostart: acc.autostart !== false }); } catch (e) { console.error(`${acc.id}: ${e.message}`); }
  }, i * 12000));
}

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal}: logging the characters out…`);
  try { hub.dispose(); } catch (e) { /* going down anyway */ }
  setTimeout(() => process.exit(0), 2500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => console.error('unhandled:', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => console.error('uncaught:', e && e.stack ? e.stack : e));

start();
