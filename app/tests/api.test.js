const http = require('http');
const fs = require('fs');
const path = require('path');
const { FakeGame } = require('./fakegame');
const { Bot } = require('../lib/bot');
const { Brain } = require('../lib/brain');
const { P } = require('../lib/paths');
const api = require('../lib/api');
const accounts = require('../lib/accounts');

function req(method, url, data) {
  return new Promise((resolve, reject) => {
    const body = data === undefined ? null : JSON.stringify(data);
    const r = http.request({ host: '127.0.0.1', port: P.PORT, path: url, method, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ code: res.statusCode, json: JSON.parse(b || '{}') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

let server = null;
let hub = null;
const selections = [];

async function setup() {
  if (server) return;
  const brain = new Brain();
  hub = {
    bots: new Map(), clients: new Map(), log: ['x'], brain,
    updater: { state: { game: { sTitle: 'Test Event' } }, runAll: async () => ({ ran: true }) },
    settings: {}, info() {}, saveSettings() {},
    bot(id) { return this.bots.get(id) || null; },
    add(d) { const a = accounts.add(d); return a; },
    close() {}, setParty: (name, leader, members) => ({ name, leader, members, room: 123456 }),
    writeReports: async () => {}, snap: async () => 'file.png',
  };
  for (const id of ['alpha', 'beta']) {
    const dir = P.account(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'login.txt'), `Username: ${id}\nPassword: pw\n`);
    const acc = { id, label: id.toUpperCase(), owner: 'test', loginFile: path.join(dir, 'login.txt') };
    const reg = accounts.load(); reg.accounts.push(acc); accounts.save(reg);
    const game = new FakeGame();
    const bot = new Bot(game, acc, { brain });
    await bot.login();
    hub.bots.set(id, bot);
    hub.clients.set(id, game);
    game.view = { webContents: { reload() {} } };
  }
  server = api.start(hub, { selected: () => selections[selections.length - 1] || null, select: (id) => selections.push(id), show() {}, quit() {} });
  await new Promise((r) => setTimeout(r, 150));
}

test('api: lists every account with live status', async () => {
  await setup();
  const r = await req('GET', '/accounts');
  eq(r.code, 200);
  const ids = r.json.map((a) => a.id);
  assert(ids.includes('alpha') && ids.includes('beta'), ids.join(','));
  const alpha = r.json.find((a) => a.id === 'alpha');
  assert(alpha.online && alpha.level === 5, JSON.stringify(alpha).slice(0, 200));
});

test('api: per-account queue, settings, goals and brain preview', async () => {
  await setup();
  let r = await req('POST', '/a/beta/bot', { op: 'queue', task: { type: 'wait', minutes: 1 } });
  eq(r.json.queue.length, 1);
  r = await req('POST', '/a/beta/bot', { op: 'settings', settings: { role: 'farmer' } });
  eq(r.json.settings.role, 'farmer');
  r = await req('POST', '/a/beta/bot', { op: 'goals', pause: 'master-ranger' });
  assert(r.json.paused.includes('master-ranger'), 'goal paused');
  r = await req('POST', '/a/beta/bot', { op: 'goals', goals: [{ id: 'shaman', label: 'Shaman', script: 'x.cs', when: 1 }] });
  r = await req('POST', '/a/beta/bot', { op: 'goals', pause: 'shaman' });
  eq([r.json.custom, r.json.goals.map((x) => x.id)], [true, ['shaman']], 'a pause keeps the custom queue');
  r = await req('POST', '/a/beta/bot', { op: 'goals', reset: true });
  eq(r.json.custom, false);
  r = await req('POST', '/a/beta/bot', { op: 'brainPreview' });
  assert(r.json.type && r.json.why, JSON.stringify(r.json));
  r = await req('POST', '/a/beta/bot', { op: 'clear' });
  eq(r.json.queue.length, 0);
  eq((await req('POST', '/a/alpha/bot', { op: 'queue', task: { type: 'wait' } })).json.queue.length, 1, 'alpha queue separate');
});

test('api: bridge calls and events are routed to the right account', async () => {
  await setup();
  hub.clients.get('beta').root.world.strMapName = 'betamap';
  eq((await req('POST', '/a/beta/call', { fn: 'getGameObject', args: ['world.strMapName'] })).json.value, 'betamap');
  eq((await req('POST', '/a/alpha/call', { fn: 'getGameObject', args: ['world.strMapName'] })).json.value, 'battleon');
  eq((await req('GET', '/a/nobody/status')).code, 404);
});

test('api: legacy single-account routes still work (keeper / seraph.py)', async () => {
  await setup();
  const r = await req('POST', '/bot', { op: 'status' });
  eq(r.code, 200);
  assert(r.json.id, 'status of first account');
  eq((await req('GET', '/state')).code, 200);
});

test('api: scripts catalogue search, translate, knowledge, ui select', async () => {
  await setup();
  const s = await req('GET', '/scripts?q=cleric');
  assert(s.json.length > 0 && s.json.some((x) => /Cleric/i.test(x.path)), 'cleric script found');
  const t = await req('GET', '/translate?path=Story/Cleric.cs');
  assert(t.json.steps.length > 20, 'translated');
  const k = await req('GET', '/knowledge');
  eq(k.json.gameTitle, 'Test Event');
  await req('POST', '/ui/select', { id: 'beta' });
  eq(selections[selections.length - 1], 'beta');
  server.close();
});

test('api: eval calls a nested method on its own object (client.send), not on the bot', async () => {
  const sent = [];
  const bot = { id: 'evalme', client: { write: (p) => sent.push(p), send(p) { this.write(p); return 'ok'; } },
    items: async () => ['top-level still works'] };
  const { botOp } = require('../lib/api');
  eq(await botOp({}, bot, { op: 'eval', fn: 'client.send', args: ['%xt%zm%addLoadout%1%X%{}%%'] }), { value: 'ok' });
  eq(sent, ['%xt%zm%addLoadout%1%X%{}%%'], 'this was the client, so write() existed');
  eq(await botOp({}, bot, { op: 'eval', fn: 'items' }), { value: ['top-level still works'] });
});
