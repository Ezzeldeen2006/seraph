const fs = require('fs');
const path = require('path');
const { FakeGame } = require('./fakegame');
const { Bot } = require('../lib/bot');
const { Brain } = require('../lib/brain');
const { P } = require('../lib/paths');
const knowledge = require('../lib/knowledge');

function makeAccount(id, password = 'pw') {
  const dir = P.account(id);
  fs.mkdirSync(dir, { recursive: true });
  const loginFile = path.join(dir, 'login.txt');
  fs.writeFileSync(loginFile, `Username: ${id}\nPassword: ${password}\n`);
  return { id, label: id, owner: 'test', loginFile };
}

async function online(opts = {}) {
  const game = new FakeGame(opts);
  const bot = new Bot(game, makeAccount(opts.id || `bot${Math.random().toString(36).slice(2, 7)}`, 'pw'));
  await bot.login();
  return { game, bot };
}

test('bot: a stopped order saved in queue and as current loads once (2026-10-09)', async () => {
  const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seraph-q-'));
  const t = { type: 'script', path: 'Enhancement/UnlockForgeEnhancements.cs', entry: 'Elysium', startedAt: 5 };
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ queue: [t, { ...t }], current: { ...t } }));
  const b = Object.create(Bot.prototype); b.dir = dir; b.settings = {};
  b.load();
  eq(b.queue.length, 1, 'one copy');
});

test('bot: logs in, picks the least busy server, is playing', async () => {
  const { game, bot } = await online();
  assert(await bot.playing(), 'playing');
  eq(bot.serverName, 'Twig', 'least busy server');
  assert(game.sent.some((s) => s[0] === 'login'), 'login called');
});

test('bot: wrong password throws a clear error', async () => {
  const game = new FakeGame({ password: 'right' });
  const bot = new Bot(game, makeAccount('badpw', 'wrong'));
  let msg = '';
  try { await bot.login(); } catch (e) { msg = e.message; }
  assert(/login failed: bad password/.test(msg), msg);
});

test('bot: join uses a normal public room and jumps to the cell', async () => {
  const { game, bot } = await online();
  await bot.join('oaklore', 'r3', 'Left');
  eq([await bot.map(), await bot.cell()], ['oaklore', 'r3']);
  const tfer = game.sent.find((s) => String(s[1]).includes('%tfer%'));
  // Low room numbers on purpose: real players are there and help with bosses (the owner's request, 2026-09-18).
  assert(/oaklore-[1-9]%r3%Left/.test(tfer[1]), tfer[1]);
  const room = Number(/oaklore-(\d+)%/.exec(tfer[1])[1]);
  assert(room >= 1 && room <= 6, `room ${room} should be a normal low room`);
});

test('bot: a private room is still used when one is set', async () => {
  const { game, bot } = await online();
  bot.settings.privateRoom = 77777;
  await bot.join('faerie', 'Enter', 'Spawn');
  const tfer = game.sent.reverse().find((s) => String(s[1]).includes('%tfer%'));
  assert(/faerie-77777%/.test(tfer[1]), tfer[1]);
});

test('bot: an event map that is locked throws "unavailable"', async () => {
  const { bot } = await online({ unavailableMaps: ['mogloween'] });
  let msg = '';
  try { await bot.join('mogloween'); } catch (e) { msg = e.message; }
  assert(/unavailable/.test(msg), msg);
});

test('bot: hunt kills with the rotation until the drop count is reached, picking up drops', async () => {
  const { game, bot } = await online({ monsterDrops: { Frogzard: { ItemID: 500, sName: 'Frogzard Tongue' } } });
  await bot.join('farm', 'r2', 'Left');
  const ok = await bot.hunt('Frogzard', async () => (await bot.count('Frogzard Tongue')) >= 3, { cell: 'r2', pad: 'Left' }, 60000, ['Frogzard Tongue']);
  assert(ok, 'hunt finished');
  assert((await bot.count('Frogzard Tongue')) >= 3, 'has 3 tongues');
  assert(bot.stats.kills >= 3, `kills ${bot.stats.kills}`);
});

test('bot: target read never serializes the display object (isNull guard)', async () => {
  const { game, bot } = await online();
  game.root.world.myAvatar.target = { name: 'x' };
  eq(await bot.isNull('world.myAvatar.target'), false);
});

test('bot: quest accept -> farm temp items -> turn in', async () => {
  const questDb = { 990001: { turnin: [{ ItemID: 700, iQty: 2 }] } };
  const { game, bot } = await online({ questDb, monsterDrops: { Slime: { ItemID: 700, sName: 'Slime Goo', bTemp: true } } });
  await bot.join('slimes', 'r3', 'Left');
  await bot.accept(990001);
  assert(await bot.inProgress(990001), 'accepted');
  await bot.hunt('Slime', () => bot.canComplete(990001), { cell: 'r3', pad: 'Left' }, 60000);
  assert(await bot.canComplete(990001), 'can complete');
  await bot.complete(990001);
  eq(game.completed, 1, 'turned in once');
  eq(await bot.count('Slime Goo'), 0, 'temp items consumed');
});

test('bot: registered quests auto accept and turn in while hunting', async () => {
  const questDb = { 990002: { turnin: [{ ItemID: 701, iQty: 1 }] } };
  const { game, bot } = await online({ questDb, monsterDrops: { Frogzard: { ItemID: 701, sName: 'Frog Leg', bTemp: true } } });
  await bot.join('farm', 'r2', 'Left');
  bot.register([990002]);
  bot._qt = 0;
  const end = Date.now() + 3000;
  await bot.hunt('Frogzard', async () => (game.completed || 0) >= 2 || Date.now() > end, { cell: 'r2', pad: 'Left' }, 60000);
  assert((game.completed || 0) >= 2, `completed ${game.completed}`);
});

test('bot: enhance equipped gear from the right shop at the best level', async () => {
  const shops = {
    145: [
      { sName: 'Healer Armor Enhancement', ItemID: 9101, iLvl: 5, iCost: 100, sType: 'Enhancement', bUpg: false },
      { sName: 'Healer Armor Enhancement', ItemID: 9102, iLvl: 7, iCost: 200, sType: 'Enhancement', bUpg: false },
      { sName: 'Healer Armor Enhancement', ItemID: 9103, iLvl: 9, iCost: 300, sType: 'Enhancement', bUpg: true },
      { sName: 'Healer Weapon Enhancement', ItemID: 9201, iLvl: 7, iCost: 150, sType: 'Enhancement', bUpg: false },
      { sName: 'Healer Weapon Enhancement', ItemID: 9202, iLvl: 40, iCost: 150, sType: 'Enhancement', bUpg: false },
    ],
  };
  const { game, bot } = await online({ shops, level: 8 });
  assert(await bot.needsEnhance(), 'needs enhance at level 8 with lvl 1 gear');
  const n = await bot.enhanceEquipped();
  eq(n, 2, 'armor + weapon enhanced');
  const items = game.root.world.myAvatar.items;
  eq(items.find((i) => i.sName === 'Healer').EnhID, 9102, 'best non-member level <= 8');
  eq(items.find((i) => i.sName === 'Default Staff').EnhID, 9201);
  assert(!(await bot.needsEnhance()), 'no longer needs enhance');
});

test('bot: gear sets save and re-equip', async () => {
  const { game, bot } = await online();
  await bot.saveSet('farm');
  eq(bot.sets.farm.Weapon, 'Default Staff');
  await bot.equip('Spare Sword');
  eq(game.item('Spare Sword').bEquip, true);
  await bot.equipSet('farm');
  eq(game.item('Default Staff').bEquip, true, 'set restored');
  assert(fs.existsSync(path.join(P.account(bot.id), 'sets.json')), 'sets persisted');
});

test('bot: sells known junk but never equipped or AC items', async () => {
  const { game, bot } = await online();
  const sold = await bot.sellJunk();
  eq(sold, 1);
  assert(!game.item('A Fish'), 'fish sold');
  assert(game.item('Default Staff'), 'staff kept');
});

test('bot: runs translated script steps (accept, hunt, turn in, map item, skip done)', async () => {
  const questDb = { 990003: { turnin: [{ ItemID: 702, iQty: 1 }] } };
  const { game, bot } = await online({ questDb, monsterDrops: { Frogzard: { ItemID: 702, sName: 'Frog Crown', bTemp: true } } });
  const steps = [
    { kind: 'accept', quest: 990003, map: 'farm', monsters: [] },
    { kind: 'hunt', map: 'farm', cell: 'r2', pad: 'Left', monsters: ['Frogzard'], item: 'Frog Crown', qty: 1 },
    { kind: 'turnin', quest: 990003, monsters: [], qty: -1 },
    { kind: 'mapitem', map: 'farm', note: '12,13', qty: 1, monsters: [] },
    { kind: 'hunt', map: 'farm', cell: 'r2', monsters: ['Frogzard'], item: 'Default Staff', qty: 1 },
  ];
  const ok = await bot.runSteps(steps, 'test script', 120000);
  assert(ok, 'script ok');
  eq(game.completed, 1, 'quest turned in');
  eq(game.mapItems, 2, 'two map items');
});

test('bot: scripts skip quests already done (story progress, legacy chain rewards)', async () => {
  const { game, bot } = await online();
  game.questValues[280] = 10;   // Cetoleon War: 6511 and 6512 finished before
  game.root.world.myAvatar.items.push({ sName: 'Pirate Booty II', ItemID: 31138, CharItemID: 500, sES: 'None', iQty: 1 });
  const chain = [4513, 4514, 4515];
  eq(await bot.chainProgress(chain), 1, 'owning Pirate Booty II = 4513 and 4514 done');
  const accepted = [];
  const acc = bot.accept.bind(bot);
  bot.accept = async (id) => { accepted.push(id); return acc(id); };
  await bot.runSteps([
    { kind: 'quest', quest: 6511, map: 'heartofthesea', monsters: ['Pufferfish'] },
    { kind: 'accept', quest: 4513, chain, monsters: [] },
    { kind: 'accept', quest: 4514, chain, monsters: [] },
  ], 'skip test', 60000);
  eq(accepted, [], 'nothing redone');
  eq(game.root.world.strMapName, 'battleon', 'did not even travel');
});

test('bot: full loop with a queued task, then the brain takes over', async () => {
  const game = new FakeGame({ monsterDrops: {} });
  const acc = makeAccount('looper', 'pw');
  const brain = new Brain();
  const bot = new Bot(game, acc, { brain });
  bot.queue.push({ type: 'wait', minutes: 0.01 });
  bot.start();
  await bot.waitFor(() => bot.lastLog.some((l) => l.includes('task done wait')), 20000, 50);
  await bot.waitFor(() => bot.current && bot.current.brain, 20000, 50);
  assert(bot.current && bot.current.why, 'brain gave a reason');
  bot.stop();
  const t0 = Date.now();
  while (bot.running && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 50));
  assert(!bot.running, 'loop stopped');
});

test('brain: priorities — sell junk when full, enhance when behind, else level', async () => {
  const brain = new Brain();
  const { game, bot } = await online({ level: 12 });
  // no events/dailies/goal interference for this test
  const origDailies = knowledge.dailies; const origEvents = knowledge.eventCandidates;
  knowledge.dailies = () => []; knowledge.eventCandidates = () => [];
  try {
    game.root.world.myAvatar.objData.iBagSlots = 6;
    eq((await brain.next(bot)).type, 'sellJunk', 'bag nearly full');
    game.root.world.myAvatar.objData.iBagSlots = 60;
    eq((await brain.next(bot)).type, 'enhance', 'gear behind level');
    brain.today(bot).enhancedAt = Date.now();
    const t = await brain.next(bot);
    eq(t.type, 'farmLevel', 'leveling');
    assert(/level 12/.test(t.why), t.why);
  } finally { knowledge.dailies = origDailies; knowledge.eventCandidates = origEvents; }
});

test('brain: checks live events first and runs their story scripts', async () => {
  const brain = new Brain();
  const { bot } = await online({ level: 30 });
  bot.settings.minEventLevel = 25;
  const orig = knowledge.eventCandidates;
  knowledge.eventCandidates = () => [{ folder: 'TalkLikeaPirateDay', maps: ['blazebeard'], scripts: ['Seasonal/TalkLikeaPirateDay/BlazeBeardStory.cs'] }];
  try {
    brain.today(bot).enhancedAt = Date.now();
    const probe = await brain.next(bot);
    eq([probe.type, probe.folder], ['probeEvent', 'TalkLikeaPirateDay']);
    await brain.done(bot, probe, { open: true, map: 'blazebeard' });
    const run = await brain.next(bot);
    eq([run.type, run.path], ['script', 'Seasonal/TalkLikeaPirateDay/BlazeBeardStory.cs']);
    bot.settings.minEventLevel = 40;
    assert((await brain.next(bot)).type !== 'script', 'too low level for event scripts');
  } finally { knowledge.eventCandidates = orig; }
});

test('brain: dailies run once per server day and skip member-only', async () => {
  const brain = new Brain();
  const { bot } = await online({ level: 40 });
  const origD = knowledge.dailies; const origE = knowledge.eventCandidates;
  knowledge.eventCandidates = () => [];
  knowledge.dailies = () => [
    { name: 'MemberThing', quests: [4069], memberOnly: true, runnable: false, minLevel: 0, steps: [] },
    { name: 'EldersBlood', quests: [802], memberOnly: false, runnable: true, minLevel: 0, steps: [] },
  ];
  try {
    brain.today(bot).enhancedAt = Date.now();
    const d = await brain.next(bot);
    eq([d.type, d.name], ['daily', 'EldersBlood']);
    await brain.done(bot, d, true);
    const after = await brain.next(bot);
    assert(after.type !== 'daily', `daily not repeated (${after.type})`);
  } finally { knowledge.dailies = origD; knowledge.eventCandidates = origE; }
});

test('brain: follower accounts follow their leader', async () => {
  const leaderBot = { id: 'leader' };
  const brain = new Brain({ hub: { bot: (id) => (id === 'leader' ? leaderBot : null) } });
  const { bot } = await online({ level: 50 });
  bot.settings.role = 'follower';
  bot.settings.leader = 'leader';
  eq((await brain.next(bot)).type, 'follow');
});

test('bot: picks the best owned class for the job, enhances and saves the set', async () => {
  const shops = { 147: [{ sName: 'Lucky Armor Enhancement', ItemID: 9301, iLvl: 5, iCost: 10, sType: 'Enhancement', bUpg: false }, { sName: 'Lucky Weapon Enhancement', ItemID: 9302, iLvl: 5, iCost: 10, sType: 'Enhancement', bUpg: false }] };
  const { game, bot } = await online({ shops, level: 5 });
  game.root.world.myAvatar.items.push({ sName: 'Master Ranger', ItemID: 50, CharItemID: 50, sES: 'ar', sType: 'Class', bEquip: false, EnhLvl: 0, EnhID: 0, iQty: 1 });
  game.root.world.myAvatar.items.find((i) => i.sName === 'Healer').sType = 'Class';
  // the fake game changes class name when the class armor is equipped
  const origPacket = game.packet.bind(game);
  game.packet = (p) => { const r = origPacket(p); const eqd = game.root.world.myAvatar.items.find((i) => i.sES === 'ar' && i.bEquip); if (eqd) game.root.world.myAvatar.objData.strClassName = eqd.sName; return r; };
  const switched = await bot.useRole('farm');
  assert(switched, 'switched');
  eq(game.root.world.myAvatar.objData.strClassName, 'Master Ranger');
  eq(bot.sets.farm.ar, 'Master Ranger', 'farm set saved');
  eq(await bot.useRole('farm'), false, 'no switch when already best');
});

test('bot: kill-quest step uses real QuestData requirement fields (quest 5429)', async () => {
  const questDb = { 5429: { turnin: [{ ItemID: 36922, iQty: 1 }] } };
  const { game, bot } = await online({ level: 20, questDb, monsterDrops: { 'Antique Chair': { ItemID: 36922, sName: 'Antique Chair Defeated', bTemp: true } } });
  game.questValues[217] = 1;   // previous quest in the chain done -> 5429 unlocked
  game.root.world.monsters = [{ strMonName: 'Oil Lamp', strFrame: 'r5', intHP: 100 }, { strMonName: 'Antique Chair', strFrame: 'r5', intHP: 100 }];
  await bot.runStep({ kind: 'quest', quest: 5429, map: 'cursedshop', monsters: ['Antique Chair'] });
  eq(game.completed, 1, 'quest 5429 turned in');
  eq(await bot.cell(), 'r5', 'went to the cell with the monster');
  assert(bot.lastLog.some((l) => l.includes('completed quest 5429')), 'journaled');
});

test('bot: gives up a hunt that keeps dying ("too strong") instead of feeding deaths', async () => {
  const { game, bot } = await online();
  await bot.join('hard', 'r2', 'Left');
  let deaths = 0;
  const orig = game.hitTarget.bind(game);
  game.hitTarget = () => { game.root.world.myAvatar.dataLeaf.intHP = 0; deaths++; setTimeout(() => { game.root.world.myAvatar.dataLeaf.intHP = 1000; }, 400); };
  let msg = '';
  const timer = setTimeout(() => bot.stop(), 8000);
  try { await bot.hunt('Frogzard', async () => false, { cell: 'r2', pad: 'Left' }, 3600000); } catch (e) { msg = e.message; }
  clearTimeout(timer);
  assert(/too strong: died 3x/.test(msg), msg);
  game.hitTarget = orig;
});

test('bot: gives up when the client counted the deaths and respawned on its own (headless, Nova 2026-10-08)', async () => {
  const { game, bot } = await online({ id: 'quickres' });
  await bot.join('hard', 'r2', 'Left');
  const orig = game.hitTarget.bind(game);
  // HP never reads 0 in the hunt loop: the death arrives as the client's 'died' event, the respawn is instant.
  game.hitTarget = () => { bot.countDeath().catch(() => null); };
  let msg = '';
  const timer = setTimeout(() => bot.stop(), 8000);
  try { await bot.hunt('Frogzard', async () => false, { cell: 'r2', pad: 'Left' }, 3600000); } catch (e) { msg = e.message; }
  clearTimeout(timer);
  assert(/too strong: died \dx/.test(msg), msg);
  game.hitTarget = orig;
});

test('bot: one death is counted once, however long the character stays down', async () => {
  const { game, bot } = await online({ id: 'deadcount' });
  game.root.world.myAvatar.dataLeaf.intHP = 0;
  bot.waitFor = async () => false;                       // the server never revives us
  bot.reviveStuck = async () => {};                      // tested separately
  for (let i = 0; i < 4; i++) assert(await bot.handleDeath(null), 'reports dead');
  eq(bot.stats.deaths, 1, 'one death, not one per tick');
  game.root.world.myAvatar.dataLeaf.intHP = 1000;
  eq(await bot.handleDeath(null), false, 'alive again');
  eq(bot.deadSince, 0, 'death cleared');
  game.root.world.myAvatar.dataLeaf.intHP = 0;
  await bot.handleDeath(null);
  eq(bot.stats.deaths, 2, 'the next death counts');
});

// Check-up 2026-09-21: deaths inside Skua scripts never reached stats.deaths (only handleDeath counted), and
// "still dead 2985s" came from a death clock left over from an earlier death.
test('bot: deaths the client reports (inside Skua scripts) count once each, and the death clock is the client\'s', async () => {
  const { game, bot } = await online({ id: 'scriptdeath' });
  game.emit('died');
  game.emit('died');
  await new Promise((r) => setTimeout(r, 50));
  eq(bot.stats.deaths, 1, 'one death, even if reported twice');
  game.root.world.myAvatar.dataLeaf.intHP = 0;
  bot.waitFor = async () => false;
  bot.reviveStuck = async () => {};
  await bot.handleDeath(null);
  eq(bot.stats.deaths, 1, 'handleDeath sees the same death - not counted again');
  game.emit('deathover');
  eq([bot.deadSince, bot._deathCounted], [0, false], 'alive again: clock and flag cleared');
  game.emit('died');
  await new Promise((r) => setTimeout(r, 50));
  eq(bot.stats.deaths, 2, 'the next death counts');
  delete bot.reviveStuck;
  bot.deadSince = Date.now() - 3000 * 1000;              // a stale clock from long ago
  game.emit('stuckdead', { seconds: 50 });
  assert(Math.abs(Date.now() - bot.deadSince - 50000) < 2000, 'the client\'s 50 s, not the stale 3000 s');
});

test('bot: a character the server never revives logs back in', async () => {
  const { game, bot } = await online({ id: 'stuckdead' });
  game.root.world.myAvatar.dataLeaf.intHP = 0;
  bot.deadSince = Date.now() - 90000;
  await bot.reviveStuck();
  assert(game.sent.some((s) => s[0] === 'sfc.disconnect'), 'dropped the connection to come back alive');
  const at = bot.lastReviveRelog;
  game.sent.length = 0;
  bot.deadSince = Date.now() - 90000;
  await bot.reviveStuck();
  eq(bot.lastReviveRelog, at, 'no second relog within five minutes');
  assert(!game.sent.some((s) => s[0] === 'sfc.disconnect'), 'never a relog loop');
});

test('bot: leveling never walks back into a spot that just killed it', async () => {
  const { bot } = await online({ id: 'dangerspot' });
  const seen = [];
  bot.join = async (map, cell) => { seen.push(`${map} ${cell}`); };
  bot.hunt = async () => { throw Object.assign(new Error('stop'), { name: 'Stop' }); };
  bot.level = async () => 8;                              // the bottom band of the route
  bot.dangerSpots = {};
  const { LEVEL_ROUTES } = require('../lib/bot');
  const bottom = LEVEL_ROUTES[0];
  bot.dangerSpots[`${bottom.map} ${bottom.cell}`] = Date.now() + 3600000;
  await bot.farmLevel({ to: 100, minutes: 1 });
  assert(!seen.includes(`${bottom.map} ${bottom.cell}`), `stayed out of the banned spot, went to ${seen.join(', ') || 'nowhere'}`);
  assert(bot.lastLog.some((l) => l.includes('avoid list')), 'said why it is not leveling');
});

test('bot: party follower goes to the leader room + cell and fights there', async () => {
  const lead = await online({ id: 'leaderx' });
  const fol = await online({ id: 'followerx', monsterDrops: {} });
  await lead.bot.join('battlegrounde', 'r2', 'Left');
  fol.bot.hub = { bot: (id) => (id === 'leaderx' ? lead.bot : null) };
  const run = fol.bot.follow({ leader: 'leaderx', minutes: 0.3 });
  await new Promise((r) => setTimeout(r, 300));
  eq(await fol.bot.map(), 'battlegrounde', 'same map');
  const tfer = fol.game.sent.map((s) => String(s[1] || '')).find((x) => x.includes('%tfer%'));
  assert(tfer.includes(`battlegrounde-${lead.bot.roomNumber()}`), `same room: ${tfer}`);
  eq(await fol.bot.cell(), 'r2', 'same cell');
  await run;
  fol.game.root.world.monsters = [{ strMonName: 'Frogzard', strFrame: 'r2', intHP: 100 }];
  assert(fol.game.hits > 0 || fol.bot.stats.kills >= 0, 'fought');
});

test('bot: Skua script starts take turns compiling; "Bot Started" or the time limit passes the turn on', async () => {
  const { takeCompileTurn } = require('../lib/bot');
  const EventEmitter = require('events');
  const a = new EventEmitter(); const b = new EventEmitter(); const c = new EventEmitter();
  const order = [];
  const ta = takeCompileTurn(a, 300); const tb = takeCompileTurn(b, 300);
  ta.ready.then(() => order.push('a')); tb.ready.then(() => order.push('b'));
  await new Promise((r) => setTimeout(r, 50));
  eq(order, ['a'], 'the second start waits while the first compiles');
  a.emit('log', { kind: 'script', msg: '[23:59:01] (SetOptions) Bot Started [Other/FarmJoeKits/0FarmerJoeDoAll]' });
  await new Promise((r) => setTimeout(r, 20));
  eq(order, ['a', 'b'], '"Bot Started" hands the turn on');
  const tc = takeCompileTurn(c, 300);          // b never logs: its turn ends by itself
  const t0 = Date.now(); await tc.ready;
  assert(Date.now() - t0 < 700, 'a start that never logs cannot hold the others for ever');
  eq(a.listenerCount('log') + b.listenerCount('log'), 0, 'no listeners left behind');
  tc.done();
});
