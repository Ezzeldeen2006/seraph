// 2026-10-22 16:14: the owner logged in to his main mid-Tyndarius and the three bots stood in /ultratyndarius waiting for
// the army; 14:45 three loops died in a network drop mid-raid. A member who leaves calls the raid off, not as a try.
const { Hub } = require('../lib/hub');

function hub() {
  const h = Object.create(Hub.prototype);
  h.settings = { raids: { done: {}, tries: {} }, mainSeat: false }; h.infos = [];
  h.info = (t) => h.infos.push(t); h.notify = () => {}; h.saveSettings = () => {};
  h.raidPotionsWrite = () => true; h.raidSeats = (s) => s; h.partyRoom = () => 13579;
  h.raidWatch = async () => null;
  h.bots = new Map();
  for (const id of ['sable7', 'valen7', 'nova7', 'oren7']) {
    const b = { id, running: true, paused: false, serverName: 'Swordhaven', account: { label: id, kind: 'party' }, current: null, restarts: 0, journal() {},
      restart() { b.restarts++; }, turnedIn: new Map(), questAvailable: async () => true, dailyDone: async () => false };
    h.bots.set(id, b);
  }
  h.bot = (id) => h.bots.get(id);
  h.raidDue = () => [{ id: 'ultra-ezrajal', name: 'Ultra Ezrajal', script: 'x.cs', quest: 8152, every: 'day' }];
  h._ultra = { ready: true, bosses: { 'ultra-ezrajal': { ready: true, seats: ['sable7', 'valen7', 'nova7', 'oren7'].map((id) => ({ id, cls: 'X' })), missing: [] } } };
  return h;
}
function seat(h, r) { for (const b of h.bots.values()) b.current = { raid: r.id, type: 'script' }; }

test('raid left: a member whose loop stays stopped 5 min calls the raid off - no try, no potions verdict, the rest restart', async () => {
  const h = hub();
  const t0 = Date.now();
  const r = await h.raidTick(t0);
  assert(r && r.members.length === 4, h.infos.join(' | '));
  seat(h, r);
  r.fight = { startAt: t0, samples: [] };
  const nyx = h.bot('nova7');
  nyx.running = false;   // the reconnect failed, the loop is down
  eq(await h.raidTick(t0 + 60000), r, 'a short gap is not a departure');
  eq(await h.raidTick(t0 + 3 * 60000), r);
  eq(await h.raidTick(t0 + 6.5 * 60000), null, 'gone 5+ min: called off');
  assert(h.infos.some((t) => /nova7 left the raid/.test(t)), h.infos.join(' | '));
  eq(h.settings.raids.tries['ultra-ezrajal'], undefined, 'not a lost try');
  eq((h.settings.potionPolicy || {})['ultra-ezrajal'], undefined, 'no potions verdict');
  eq(nyx.restarts, 0, 'the one who left is not restarted');
  eq(h.bot('valen7').restarts, 1, 'the others go back to their own work');
});

test('raid left: a member back for a moment resets the clock', async () => {
  const h = hub();
  const t0 = Date.now();
  const r = await h.raidTick(t0);
  seat(h, r);
  const vae = h.bot('valen7');
  vae.running = false;
  await h.raidTick(t0 + 4 * 60000);
  vae.running = true;
  await h.raidTick(t0 + 4.5 * 60000);
  vae.running = false;
  eq(await h.raidTick(t0 + 8 * 60000), r, 'only 3.5 min since it went again');
});

test('raid left: the owner logging in to a member (standAside) calls it off at once and keeps that character out', async () => {
  const h = hub();
  const r = await h.raidTick();
  seat(h, r);
  const orr = h.bot('oren7');
  orr.stop = () => {};
  const client = { state: { loaded: false }, stop() {} };
  h.emit = () => {};
  h.standAside({ id: 'oren7', label: 'Oren7', kind: 'party' }, client, orr);
  eq(h.raid, null, 'called off at once');
  assert(h.infos.some((t) => /oren7 left the raid \(you logged in/.test(t)), h.infos.join(' | '));
  eq(h.settings.raids.tries['ultra-ezrajal'], undefined, 'not a lost try');
  eq(orr.restarts, 0, 'stays out');
  clearTimeout(client._standAsideTimer);
});

// 2026-10-23: an escort begun 20 s before the Engineer raid took Oren's slot back; the other three waited at
// "Ready: 3/4" for 50 min (his loop was running, so nothing called it off).
test('raid left: a running member on other work is sent back once after 2 min, called off at 5 min if still elsewhere', async () => {
  const h = hub();
  const t0 = Date.now();
  const r = await h.raidTick(t0);
  seat(h, r);
  r.fight = { startAt: t0, samples: [] };
  const orr = h.bot('oren7');
  const said = [];
  orr.journal = (t) => said.push(t);
  orr.current = { type: 'script', escort: 'escort-1', why: 'escort: the party helps me past Dark Makai' };
  eq(await h.raidTick(t0 + 60000), r);
  eq(orr.restarts, 0, 'not before 2 min');
  eq(await h.raidTick(t0 + 3 * 60000), r);
  eq(orr.restarts, 1, 'sent back to the raid');
  assert(said.some((t) => /back to the Ultra Ezrajal raid - "escort: the party helps me past Dark Makai" had taken my slot/.test(t)), said.join(' | '));
  eq(await h.raidTick(t0 + 4 * 60000), r);
  eq(orr.restarts, 1, 'only once');
  eq(await h.raidTick(t0 + 6.5 * 60000), null, 'still elsewhere: called off');
  assert(h.infos.some((t) => /oren7 left the raid \(still on other work/.test(t)), h.infos.join(' | '));
  eq(h.settings.raids.tries['ultra-ezrajal'], undefined, 'not a lost try');
});

test('raid left: a member sent back who takes the raid stays in it', async () => {
  const h = hub();
  const t0 = Date.now();
  const r = await h.raidTick(t0);
  seat(h, r);
  r.fight = { startAt: t0, samples: [] };
  const orr = h.bot('oren7');
  orr.current = { type: 'script', escort: 'escort-1' };
  orr.restart = () => { orr.restarts++; orr.current = { raid: r.id, type: 'script' }; };
  await h.raidTick(t0 + 60000);
  await h.raidTick(t0 + 3 * 60000);
  eq(orr.restarts, 1);
  eq(await h.raidTick(t0 + 7 * 60000), r, 'back in the raid: no call-off');
});
