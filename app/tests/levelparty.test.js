// Level together: shared room, weakest-member band, in-game party invites only between our own bots, no spinning.
const fs = require('fs');
const path = require('path');
const { FakeGame } = require('./fakegame');
const { Bot } = require('../lib/bot');
const { P } = require('../lib/paths');
const { Hub } = require('../lib/hub');

async function mk(id, level, hub) {
  const dir = P.account(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'login.txt'), `Username: ${id}\nPassword: pw\n`);
  const game = new FakeGame({ level });
  const bot = new Bot(game, { id, label: id, username: id, loginFile: path.join(dir, 'login.txt'), status: 'active' }, { hub });
  await bot.login();
  game.root.world.myAvatar.objData.strUsername = id;
  bot.running = true;
  return bot;
}

function fakeHub() {
  const hub = { bots: new Map(), settings: { levelParty: { enabled: true, room: 94242, maxGap: 25 }, assist: { enabled: false, members: [] }, party: {} }, info() {}, saveSettings() {}, bot(id) { return this.bots.get(id) || null; } };
  for (const k of ['partyOf', 'partyRoom', 'partyServer', 'partyBots', 'partyLeaderOf', 'partyTick', 'levelPartyBots', 'inLevelParty', 'levelPartyLeader', 'levelPartyLevel', 'assistFor']) hub[k] = Hub.prototype[k].bind(hub);
  return hub;
}

test('level together: shared room, moves bots already in another copy of the map, weakest band', async () => {
  const hub = fakeHub();
  const a = await mk('lpa', 17, hub); const b = await mk('lpb', 12, hub); const c = await mk('lpc', 60, hub);
  for (const x of [a, b, c]) hub.bots.set(x.id, x);
  eq(a.roomNumber(), 94242);
  a.client.root.world.strMapName = 'icestormarena'; a.client.root.world.strAreaName = 'icestormarena-11111';
  await a.join('icestormarena', 'r6', 'Left');
  const tfer = a.client.sent.map((s) => String(s[1] || '')).find((x) => x.includes('%tfer%'));
  assert(tfer && tfer.includes('icestormarena-94242'), `moved to party room: ${tfer}`);
  eq(await hub.levelPartyLevel(a), 12, 'Sable levels at the weaker member\'s band');
  eq(await hub.levelPartyLevel(c), 60, 'too big a gap: level 60 keeps its own band');
  hub.settings.levelParty.enabled = false;
  eq(hub.partyRoom(a), null, 'off -> own rooms');
});

test('level together: party invites accepted only from our own bots', async () => {
  const hub = fakeHub();
  const a = await mk('lpd', 20, hub); const b = await mk('lpe', 20, hub);
  hub.bots.set(a.id, a); hub.bots.set(b.id, b);
  await b.onPartyInvite({ cmd: 'pi', owner: 'RandomStranger', pid: 77 });
  assert(!b.client.sent.some((s) => String(s[1]).includes('%gp%')), 'stranger ignored');
  await b.onPartyInvite({ cmd: 'pi', owner: 'lpd', pid: 88 });
  assert(b.client.sent.some((s) => String(s[1]).includes('%gp%1%pa%88%')), 'accepted our leader');
  assert(b.lastLog.some((l) => /joined lpd's party/.test(l)), 'journaled');
});

// After the leader reconnected on 2026-09-20 the other three stayed in the old party, the server refused every
// invite ("they are already in a party") and the minute timer repeated it 1,724 times in a day.
test('level together: a character stuck in an older party is told to leave, then gives up for a while', async () => {
  const hub = fakeHub();
  const lead = await mk('lpf', 20, hub); const stuck = await mk('lpg', 20, hub);
  hub.bots.set(lead.id, lead); hub.bots.set(stuck.id, stuck);
  for (const b of [lead, stuck]) b.serverName = 'Twig';
  lead.client.root.world.partyMembers = [];              // the leader's party is empty: the invites never land
  const invites = () => lead.client.sent.filter((s) => s[0] === 'world.partyInvite').length;
  const leaves = () => stuck.client.sent.filter((s) => s[0] === 'world.partyLeave').length;

  await hub.partyTick();
  eq([invites(), leaves()], [1, 0], 'the first attempt is a plain invite');
  await hub.partyTick();
  eq([invites(), leaves()], [2, 1], 'still outside -> leave the old party first, then invite again');
  await hub.partyTick();
  eq([invites(), leaves()], [3, 2]);
  assert(stuck.lastLog.some((l) => /could not join lpf's party - trying again in 15 min/.test(l)), 'said so once');
  await hub.partyTick();
  await hub.partyTick();
  eq([invites(), leaves()], [3, 2], 'then it stops for 15 minutes instead of spinning every minute');

  // Once they are in, nothing is sent at all - and the leader's own name in the list never counts as a member.
  hub._partyTries.clear();
  lead.client.root.world.partyMembers = ['lpf', 'lpg'];
  await hub.partyTick();
  eq([invites(), leaves()], [3, 2], 'a member of the party is left alone');
  lead.client.root.world.partyMembers = ['lpf'];
  await hub.partyTick();
  eq(invites(), 4, 'the leader itself is not one of its four members');
});

test('farmLevel: a fallback band that is already below my level never spins (Sable AFK bug)', async () => {
  const bot = await mk('spinner', 17, null);
  bot.running = false;
  bot.fallbackUntil = Date.now() + 3600000;   // died 3x -> one band lower (oaklore, level 1-9)
  let hunts = 0;
  bot.hunt = async (_m, done) => { hunts++; return done(); };
  const t0 = Date.now();
  await bot.farmLevel({ to: 100, minutes: 0.02 });
  assert(hunts < 20, `hunt restarted ${hunts} times`);
  assert(Date.now() - t0 < 15000, 'finished');
});

test('combat keeper: drops dead targets and walks back into range', async () => {
  const bot = await mk('ranger', 20, null);
  const w = bot.client.root.world;
  w.myAvatar.target = { name: 'x', dataLeaf: { intHP: 0 } };
  eq(await bot.keepInRange(), false, 'dead target dropped');
  eq(w.myAvatar.target, null);
  w.myAvatar.target = { name: 'x', dataLeaf: { intHP: 50 } };
  bot._approachAt = 0;
  eq(await bot.keepInRange(), true);
  eq(bot.client.approaches, 1, 'approachTarget called');
});

test('journal: repeated lines are counted, not flooded', async () => {
  const bot = await mk('chatty', 5, null);
  const before = bot.lastLog.length;
  for (let i = 0; i < 50; i++) bot.journal('hunting Bone Berserker in oaklore r3');
  bot.journal('something else');
  const added = bot.lastLog.slice(before);
  eq(added.length, 3, added.join(' | '));
  assert(/repeated 49x/.test(added[1]), added[1]);
});
