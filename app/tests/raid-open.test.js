// Check-up 2026-10-05: a raid starts only when the boss quest is open for every member (one character without the
// story that opens the map stalled the whole party), not just the first.
const { Hub } = require('../lib/hub');

function hubWith(openFor) {
  const h = Object.create(Hub.prototype);
  h.settings = {}; h.infos = [];
  h.info = (t) => h.infos.push(t); h.notify = () => {}; h.saveSettings = () => {};
  h.bots = new Map();
  for (const id of ['sable7', 'valen7', 'nova7', 'oren7']) {
    h.bots.set(id, { id, running: true, paused: false, serverName: 'Swordhaven', account: { label: id }, current: null, journal() {}, restart() {}, questAvailable: async () => openFor(id) });
  }
  h.bot = (id) => h.bots.get(id);
  h.raidDue = () => [{ id: 'champion-drakath', name: 'Champion Drakath', script: 'x.cs', quest: 8300, every: 'week' }];
  return h;
}

test('raids: not started while the boss quest is locked for any member', async () => {
  let h = hubWith((id) => id !== 'nova7');
  eq(await h.raidTick(), null, 'Nova has not opened the map');
  assert(h.infos.some((t) => /not open for nova7/.test(t)), h.infos.join(' | '));
  assert(h.settings.raids.locked['champion-drakath'], 'waits an hour before asking again');
  h = hubWith(() => true);
  const r = await h.raidTick();
  eq(r && r.boss, 'champion-drakath', 'open for all four: the raid starts');
  eq(r.members.length, 4);
});
