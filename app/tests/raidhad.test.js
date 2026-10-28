// 2026-10-22 replays: (1) after restarts the hub forgot who turned Ultra Ezrajal in that morning and reran it for
// Sable and Oren; (2) Engineer died in 30 s, Valen (holding an old defeat item, so no Attempt report) came back
// "done" and the raid was called off while Nova was turning hers in.
const { Hub } = require('../lib/hub');

function hub(dailyDone) {
  const h = Object.create(Hub.prototype);
  h.settings = { raids: { done: {}, tries: {} }, mainSeat: false }; h.infos = [];
  h.info = (t) => h.infos.push(t); h.notify = () => {}; h.saveSettings = () => {};
  h.raidPotionsWrite = () => false; h.raidSeats = (s) => s; h.partyRoom = () => 13579;
  h.bots = new Map();
  for (const id of ['sable7', 'valen7', 'nova7', 'oren7']) {
    h.bots.set(id, { id, running: true, paused: false, serverName: 'Swordhaven', account: { label: id, kind: 'party' }, current: null, journal() {}, restart() {},
      turnedIn: new Map(), questAvailable: async () => !dailyDone.includes(id), dailyDone: async () => dailyDone.includes(id) });
  }
  h.bot = (id) => h.bots.get(id);
  h.raidDue = () => [{ id: 'ultra-ezrajal', name: 'Ultra Ezrajal', script: 'x.cs', quest: 8152, every: 'day', chain: true }];
  h._ultra = { ready: true, bosses: { 'ultra-ezrajal': { ready: true, seats: ['sable7', 'valen7', 'nova7', 'oren7'].map((id) => ({ id, cls: 'X' })), missing: [] } } };
  return h;
}

test('raid had: members the game says already turned it in are no "chain wait" - a kill for the rest books the boss', async () => {
  const h = hub(['sable7', 'oren7']);   // the hub's own turnedIn record is empty, as after a restart
  const r = await h.raidTick();
  eq(r.gain.slice().sort(), ['nova7', 'valen7']);
  eq(r.chainWait, [], 'done today, not waiting on the Time Inn order');
  eq(r.had.slice().sort(), ['oren7', 'sable7']);
  h.raidAttempt(h.bot('valen7'), { outcome: 'kill', class: 'X' });
  for (const id of ['sable7', 'oren7']) h.raidDone(h.bot(id), { raid: r.id, type: 'script' }, true);
  for (const id of ['valen7', 'nova7']) { h.bot(id).turnedIn.set(8152, Date.now()); h.raidDone(h.bot(id), { raid: r.id, type: 'script' }, true); }
  eq(h.raid, null);
  assert(h.settings.raids.done['ultra-ezrajal'], `booked: ${h.infos.join(' | ')}`);
});

test('raid had: a member whose script saw the boss go down is not "out without the kill" - no call-off', async () => {
  const h = hub([]);
  const r = await h.raidTick();
  const vae = h.bot('valen7');
  vae.bossDownAt = Date.now() + 1;   // "[BossDown] The boss is down: grail26 got the kill" - no Attempt report
  h.raidDone(vae, { raid: r.id, type: 'script' }, true);
  eq(r.back.valen7, 'kill (no turn-in)');
  assert(h.raid === r, `still running for the others: ${h.infos.join(' | ')}`);
  assert(!h.infos.some((t) => /calling off/.test(t)), h.infos.join(' | '));
});

test('raid had: a turn-in the hub saw beats the game still showing the quest open - no rerun, the boss is booked', async () => {
  const h = hub(['sable7', 'valen7', 'oren7']);
  const nyx = h.bot('nova7');
  nyx.turnedIn.set(8152, Date.now());   // her turn-in packet came in...
  nyx.questAvailable = async () => true;   // ...but the game still answers "open"
  nyx.dailyDone = async () => false;
  eq(await h.raidTick(), null, 'nobody can gain - no raid');
  assert(h.infos.some((t) => /not open for anyone/.test(t)), h.infos.join(' | '));
});
