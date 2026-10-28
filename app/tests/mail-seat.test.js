// 2026-10-19: the AQW 5.0 mailbox (every bot claims its letters' rewards) and a raid seat the script could not equip
// (Nova's new Void Highlord was missing from the skua.swf model: Warden + Engineer lost the day's two tries at 04:00).
const protocol = require('../lib/net/protocol');
const { HeadlessClient } = require('../lib/net/headless');
const { Hub } = require('../lib/hub');

function client() {
  const c = new HeadlessClient({ id: 'mailtest', label: 'mailtest', username: 'Tester' });
  c.sent = [];
  c.write = (m) => c.sent.push(m);
  c.sock = { destroy() {} };
  c.inventoryLoaded = true;
  c.w.myAvatar.uid = 11;
  c.w.curRoom = 5;
  const notes = [];
  c.on('mailNote', (t) => notes.push(t));
  const json = (o) => c.handle(protocol.parse(JSON.stringify({ t: 'xt', b: { r: -1, o } })));
  return { c, json, notes };
}
const flush = () => new Promise((r) => setTimeout(r, 1300));
const sentCmds = (c) => c.sent.map((m) => String(m).split('%').slice(3, 6).join('%'));

test('mail: lists, marks read and claims every letter with rewards, one request at a time', async () => {
  const { c, json, notes } = client();
  c.mailCheck(0);
  await flush();
  eq(sentCmds(c)[0], 'mailList%5%0', 'the game\'s first page request');
  json({ cmd: 'mailList', mails: [
    { id: 7, subj: 'Welcome to 5.0', read: 0, att: [{ t: 'item', iid: 100, ok: 0 }, { t: 'gold', ok: 0 }] },
    { id: 6, subj: 'Old news', read: 1, att: [] },
    { id: 5, subj: 'Claimed before', read: 1, att: [{ t: 'ac', ok: 1 }] },
  ], items: {}, next: 0 });
  await flush();
  await flush();
  const cmds = sentCmds(c);
  assert(cmds.includes('mailRead%5%7'), cmds.join(' | '));
  assert(cmds.includes('mailClaim%5%7'), cmds.join(' | '));
  assert(!cmds.some((x) => /mailClaim%5%(5|6)/.test(x)), 'no claim for letters without unclaimed rewards');
  json({ cmd: 'mailClaim', id: 7, ok: 1, claimed: 1, got: [0, 1] });
  assert(notes.some((t) => /claimed the rewards from "Welcome to 5.0"/.test(t)), notes.join(' | '));
  await new Promise((r) => setTimeout(r, 1700));
  assert(sentCmds(c).some((x) => x.startsWith('retrieveInventory')), 'the inventory is re-read so scripts see the items');
  c.disconnect();
});

test('mail: a refused claim is noted and a busy one asked again; next pages are followed', async () => {
  const { c, json, notes } = client();
  json({ cmd: 'mailList', mails: [{ id: 9, subj: 'Gift', read: 1, att: [{ t: 'item', ok: 0 }] }], next: 3 });
  await flush(); await flush();
  assert(sentCmds(c).includes('mailClaim%5%9'), sentCmds(c).join(' | '));
  json({ cmd: 'mailClaim', id: 9, busy: 1 });
  await flush(); await flush();
  eq(sentCmds(c).filter((x) => x === 'mailClaim%5%9').length, 2, 'busy: asked once more');
  json({ cmd: 'mailClaim', id: 9, ok: 0, msg: 'Your inventory is full.' });
  assert(notes.some((t) => /could not claim "Gift": Your inventory is full/.test(t)), notes.join(' | '));
  assert(sentCmds(c).includes('mailList%5%3'), 'the next page is asked for');
  c.disconnect();
  eq(c._mail, null, 'a disconnect drops the mail queue, the next login starts over');
});

function raidHub() {
  const h = Object.create(Hub.prototype);
  h.settings = {}; h.infos = []; h.timers = [];
  h.info = (t) => h.infos.push(t); h.notify = () => {}; h.saveSettings = () => {};
  h.bots = new Map();
  h.clients = new Map();
  for (const id of ['sable7', 'valen7', 'nova7', 'oren7']) {
    h.bots.set(id, { id, running: true, paused: false, serverName: 'Swordhaven', account: { label: id }, current: null, journal() {}, restart() {} });
  }
  h.bot = (id) => h.bots.get(id);
  return h;
}

test('raids: a seat the script could not equip is no try, and twice a period at most', async () => {
  const h = raidHub();
  const boss = { id: 'ultra-warden', name: 'Ultra Warden', script: 'x.cs', quest: 8153, every: 'day' };
  for (let round = 1; round <= 3; round++) {
    const r = h.beginRaid(boss, [...h.bots.values()], Date.now(), []);
    const nyx = h.bots.get('nova7');
    nyx.seatEquipFailed = { cls: 'Void Highlord', at: Date.now() };
    h.raidDone(nyx, { type: 'script', raid: r.id }, true);
    eq(h.raid, null, 'called off');
    eq(r.back.nova7, 'no seat (Void Highlord)');
    const t = (h.settings.raids.tries || {})['ultra-warden'];
    eq(t ? t.n : 0, round <= 2 ? 0 : 1, `round ${round}`);
    eq(await h.raidTick(), null, 'raidTick waits for the relog');
    h._raidRelogUntil = 0;
  }
  for (const t of h.timers) clearTimeout(t);
});

test('mtcid: the server walks us through /dagepvp pads - both worlds follow, nothing is sent back', async () => {
  const { c } = client();
  c.w.strMapName = 'dagepvp';
  c.swf.w.strMapName = 'dagepvp';
  c.handle(protocol.parse('%xt%mtcid%-1%9%9%'));
  eq(c.w.strFrame, 'r6');
  eq(c.swf.w.strFrame, 'r6', 'Bot.Player.Cell (the skua.swf model) is what PvPMove waits for');
  eq(c.sent.length, 0, 'moveToCell(.., true, true): the client sends nothing');
  c.handle(protocol.parse('%xt%mtcid%-1%28%28%'));
  eq(c.swf.w.strFrame, 'r15');
  c.w.strMapName = 'battleon';
  c.handle(protocol.parse('%xt%mtcid%-1%3%3%'));
  eq(c.w.strFrame, 'r15', 'a map without a pad table stays put (noted as a map event)');
  c.disconnect();
});
