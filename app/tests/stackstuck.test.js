// A server stack that stops counting (2026-10-20, Sable's Fiend Seals stuck at 1 for 790 grants): the bot
// notices a long run of grants with the same count below the cap and the hub relogs it.

function stackBot() {
  const { Bot } = require('../lib/bot');
  const bot = Object.create(Bot.prototype);
  require('events').EventEmitter.call(bot);
  bot.lines = [];
  bot.journal = (m) => bot.lines.push(m);
  bot.itemNameOf = (id) => `item ${id}`;
  return bot;
}

test('stack watch: a stack stuck at 1 asks for a relog once', () => {
  const bot = stackBot();
  const seen = [];
  bot.on('stackStuck', (e) => seen.push(e));
  bot.stackWatch('33265', { iQty: 1, iQtyNow: 24, iStk: 1000, sName: 'Fiend Seal' }, 0);
  for (let i = 0; i < 30; i++) bot.stackWatch('33265', { iQty: 1, iQtyNow: 1 }, 1000 + i);
  eq(seen.length, 1, 'one relog');
  eq(seen[0].name, 'item 33265');
  assert(bot.lines.some((l) => /server stack stuck/.test(l)), 'journals it');
  for (let i = 0; i < 30; i++) bot.stackWatch('33265', { iQty: 1, iQtyNow: 1 }, 60000 + i);
  eq(seen.length, 1, 'not again inside 30 min');
});

test('stack watch: normal counting, lag repeats and a full stack never relog', () => {
  const bot = stackBot();
  const seen = [];
  bot.on('stackStuck', (e) => seen.push(e));
  for (let q = 1; q <= 50; q++) { bot.stackWatch('1', { iQty: 1, iQtyNow: q, iStk: 500 }); if (q % 7 === 0) bot.stackWatch('1', { iQty: 1, iQtyNow: q }); }
  for (let i = 0; i < 30; i++) bot.stackWatch('2', { iQty: 1, iQtyNow: 99, iStk: 99 });
  for (let i = 0; i < 30; i++) bot.stackWatch('3', { iQty: 1, iQtyNow: 40 });   // cap unknown, not 1: leave it
  eq(seen.length, 0);
});

test('stack watch: the hub relogs a party bot but never the main or a raid member', () => {
  const { Hub } = require('../lib/hub');
  const calls = [];
  const client = { state: { loaded: true }, call: (f) => { calls.push(f); return Promise.resolve(); } };
  const hub = Object.create(Hub.prototype);
  hub.clients = new Map([['p', client], ['g', client]]);
  hub.bots = new Map([['p', { kind: 'party' }], ['g', { kind: 'guest' }]]);
  hub.info = () => {};
  hub.raid = null;
  const e = { name: 'Fiend Seal', qty: 1, grants: 12 };
  assert(hub.relogForStack('p', e), 'party bot relogs');
  eq(calls[0], 'sfc.disconnect');
  assert(!hub.relogForStack('g', e), 'main left alone');
  hub.raid = { members: ['p'] };
  assert(!hub.relogForStack('p', e), 'raid member left alone');
});
