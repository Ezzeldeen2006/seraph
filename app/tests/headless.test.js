// The Linux-server additions: packet parsing, the headless world model, boss help, class plans, weekly schedule.
const protocol = require('../lib/net/protocol');
const { HeadlessClient } = require('../lib/net/headless');
const classplan = require('../lib/classplan');
const schedule = require('../lib/schedule');
const { Hub } = require('../lib/hub');

test('protocol: parses the three kinds of server message', async () => {
  const x = protocol.parse('%xt%loginResponse%-1%true%40736%valen7%Welcome!%');
  eq([x.kind, x.cmd, x.args[0], x.args[1]], ['xt', 'loginResponse', 'true', '40736']);
  const j = protocol.parse('{"t":"xt","b":{"r":-1,"o":{"cmd":"moveToArea","areaId":7}}}');
  eq([j.kind, j.cmd, j.data.areaId], ['json', 'moveToArea', 7]);
  const s = protocol.parse("<msg t='sys'><body action='joinOK' r='214929'></body></msg>");
  eq([s.kind, s.cmd, s.room], ['sys', 'joinOK', 214929]);
  eq(protocol.xt('gar', [1, 'a1>m:3', 'wvz'], 1), '%xt%zm%gar%1%1%a1>m:3%wvz%');
  assert(protocol.loginMsg('Bob', 'tok').includes(`SPIDER#0001~Bob~${protocol.clientVersion()}`), 'client version matches the live game');
  eq(protocol.CLIENT_VERSION, '5.01', 'fallback = AQW 5.0 (Game4000r1)');
});

// AQW 5.0 (2026-10-10): loadPrefs, moveToArea and loadInventoryBig arrive as "Z" + base64(zlib(text)). parse() called
// them 'bad', no character ever finished loading, and all four bots sat offline for 15 hours.
test('protocol: unpacks AQW 5.0 "Z" packets before parsing', async () => {
  const zlib = require('zlib');
  const text = JSON.stringify({ t: 'xt', b: { r: -1, o: { cmd: 'loadInventoryBig', items: [{ ItemID: 1, sName: 'Épée' }], iMiscSlots: 100 } } });
  const z = `Z${zlib.deflateSync(Buffer.from(text, 'utf8')).toString('base64')}`;
  const p = protocol.parse(z);
  eq([p.kind, p.cmd, p.data.items[0].sName, p.data.iMiscSlots], ['json', 'loadInventoryBig', 'Épée', 100]);
  eq(protocol.unpack(z.replace(/=+$/, '')), text, 'missing padding is fine (Game4000 allows it)');
  eq(protocol.unpack('%xt%server%-1%Zone%'), '%xt%server%-1%Zone%', 'plain messages pass through');
  eq(protocol.unpack('Zorro is not zlib'), 'Zorro is not zlib', 'a malformed envelope is passed on unchanged');
  const c = new HeadlessClient({ id: 'ztest', label: 'ztest', username: 'Tester' });
  let loaded = false;
  c.on('loaded', () => { loaded = true; });
  c.handle(p, z);
  assert(loaded && c.state.loaded, 'a compressed loadInventoryBig finishes the login');
});

function fakeClient() {
  const c = new HeadlessClient({ id: 'hltest', label: 'hltest', username: 'Tester' });
  c.sent = [];
  c.write = (m) => c.sent.push(m);
  c.w.myAvatar.uid = 11;
  return c;
}

test('headless: builds the world from moveToArea and asks for the character data', async () => {
  const c = fakeClient();
  c.handle(protocol.parse(JSON.stringify({ t: 'xt', b: { r: -1, o: {
    cmd: 'moveToArea', areaId: 555, areaName: 'faerie-3', strMapName: 'faerie',
    monmap: [{ MonMapID: 1, MonID: 9, strFrame: 'r2' }], mondef: [{ MonID: 9, strMonName: 'Pixie', intLevel: 5 }],
    uoBranch: [{ strUsername: 'Tester', entID: 11, intHP: 500, intHPMax: 600, intMP: 50, intMPMax: 100, intState: 1, intLevel: 20, strFrame: 'Enter' }],
  } } })));
  eq([c.w.strMapName, c.w.curRoom, c.w.monsters[0].strMonName, c.w.myAvatar.dataLeaf.intHPMax], ['faerie', 555, 'Pixie', 600]);
  await new Promise((r) => setTimeout(r, 2100));
  assert(c.sent.some((m) => m.startsWith('%xt%zm%moveToCell%555%')), 'enters the cell with the area room id');
  assert(c.sent.some((m) => m.startsWith('%xt%zm%retrieveInventory%555%11%')), 'asks for the inventory, or the server never sends it');
});

test('headless: attacks, paces skills, respects cooldown and mana, tracks kills', async () => {
  const c = fakeClient();
  c.w.strFrame = 'r2';
  c.w.monsters = [{ MonMapID: 3, strFrame: 'r2', strMonName: 'Pixie', intHP: 100, intHPMax: 100 }];
  c.w.actions.active = [{ ref: 'aa', cd: 2000, mp: 0 }, { ref: 'a1', cd: 5000, mp: 20 }];
  c.w.myAvatar.dataLeaf.intMP = 10;
  eq(await c.call('attackMonsterName', 'pix'), true);
  eq(await c.call('useSkill', 1), false, 'not enough mana');
  eq(await c.call('useSkill', 0), false, 'too soon after the aggro packet: the server would say slow down');
  await new Promise((r) => setTimeout(r, 480));
  eq(await c.call('useSkill', 0), true);
  eq(await c.call('useSkill', 0), false, 'on cooldown');
  assert(c.sent.some((m) => m === '%xt%zm%gar%1%1%aa>m:3%wvz%'), c.sent.join(' | '));
  let killed = 0;
  c.on('kill', () => { killed++; });
  c.onCombat({ m: { 3: { intHP: 0 } } });
  eq([killed, c.w.myAvatar.target], [1, null]);
});

test('headless: quest progress and achievements read like the game does', async () => {
  const c = fakeClient();
  c.w.myAvatar.objData.strQuests = '0a3';
  c.w.myAvatar.objData.strQuests2 = '00005';
  eq(await c.fn('world.getQuestValue', 1), 10, 'base 36');
  eq(await c.fn('world.getQuestValue', 104), 5, 'second bank');
  c.w.myAvatar.objData.ia0 = 5;
  eq([await c.fn('world.getAchievement', 'ia0', 0), await c.fn('world.getAchievement', 'ia0', 1)], [1, 0]);
});

test('headless: picks a server a free account can actually enter', async () => {
  const c = fakeClient();
  c.login = { level: 25, upgradeDays: 0 };
  const s = c.pickServer([
    { sName: 'Sir Ver', bOnline: 1, bUpg: 1, iCount: 10, iMax: 1000 },
    { sName: 'Gravelyn', bOnline: 1, bUpg: 0, iLevel: 50, iCount: 5, iMax: 1000 },
    { sName: 'Twig', bOnline: 1, bUpg: 0, iCount: 300, iMax: 1000 },
    { sName: 'Yorumi', bOnline: 1, bUpg: 0, iCount: 100, iMax: 1000 },
  ]);
  eq(s.sName, 'Yorumi', 'not member-only, not level-gated, least busy');
});

function botStub(id, server = 'Twig') {
  return { id, account: { id, label: id, status: 'active' }, running: true, serverName: server, current: null, stats: {}, ran: [], runNow(t) { this.ran.push(t); return Promise.resolve(true); } };
}

// The struggle rule (2026-09-25): everyone, on any server, meets in the party room on Swordhaven (tests/crowd.test.js).
test('party: a bot that keeps dying calls the others, who come and help', async () => {
  require('../lib/paths').ensureDirs();
  const hub = new Hub(null, { headless: true, autoOpen: false });
  const a = botStub('a'); const b = botStub('b'); const c = botStub('c', 'Yorumi');
  for (const x of [a, b, c]) hub.bots.set(x.id, x);
  await hub.requestHelp(a, { map: 'dragonchallenge-3', cell: 'Boss', monster: 'Greed Dragon', why: 'died 2x' });
  const room = hub.settings.levelParty.room;
  eq([a.ran[0].type, a.ran[0].map, a.ran[0].room, a.ran[0].server], ['assist', 'dragonchallenge', room, 'Swordhaven'], 'the caller goes too');
  eq([b.ran.length, c.ran.length], [1, 1], 'every other bot comes, whatever server it is on');
  eq(hub.helpTask(b), null, 'asked only once');
  const d = botStub('d'); hub.bots.set('d', d);
  eq(hub.helpTask(d).monster, 'Greed Dragon', 'a bot that comes online joins the call');
  hub.dispose();
});

test('classes: every character has a farm and a solo route, and never chases member-only classes', async () => {
  for (const id of ['sable7', 'valen7', 'nova7', 'oren7']) {
    const r = classplan.route(id);
    assert(r.farm.length && r.solo.length, `${id} routes`);
    for (const job of ['farm', 'solo', 'support']) for (const name of r[job] || []) assert(classplan.byName(name), `${name} is in the class table`);
  }
  eq(classplan.classFor('valen7', 'farm', ['Warrior', 'Master Ranger']).name, 'Master Ranger');
  eq(classplan.nextGoal('valen7', 'farm', ['Sorcerer', 'Master Ranger']).name, 'Chaos Slayer');
  eq(classplan.nextGoal('x', 'farm', []).name, 'Sorcerer', 'default route');
  eq(classplan.gaps('oren7', ['Mage']), ['farm', 'solo'], 'reports what is missing');
  eq(classplan.ultraSetup('Ultra Tyndarius').weekly, true);
  eq(classplan.ultraSetup('some new ultra').party.length, 4, 'unknown ultras fall back to a sane party');
});

test('schedule: the Lord of Order daily clock is due once a day from level 50; ultras are raids, not schedule entries', async () => {
  const day = {};
  eq(schedule.RECURRING.filter((r) => r.ultra).length, 0, 'no per-character ultra entries (they are hub raids now)');
  eq(schedule.due({}, day, { level: 30 }).some((r) => r.id === 'loo-daily'), false, 'too low');
  assert(schedule.due({}, day, { level: 72 }).some((r) => r.id === 'loo-daily'), 'due at 72');
  schedule.markDone(day, 'loo-daily', 'day');
  eq(schedule.due({}, day, { level: 72 }).some((r) => r.id === 'loo-daily'), false, 'done today');
  eq(schedule.periodKey('week', new Date('2026-09-24T12:00:00Z')), schedule.periodKey('week', new Date('2026-09-18T05:00:00Z')), 'same week (Friday to Thursday)');
});

test('raids: all four get the same boss script at once, early finishers wait, a turned-in quest books the kill', async () => {
  const { Hub } = require('../lib/hub');
  const ur = require('../lib/ultraready');
  const ids = ['sable7', 'valen7', 'nova7', 'oren7'];
  const mk = (id) => ({ id, running: true, paused: false, serverName: 'Twig', account: { label: id }, current: { type: 'script', why: 'Farmer Joe' }, restarted: 0, restart() { this.restarted++; }, journal() {} });
  const bots = new Map(ids.map((id) => [id, mk(id)]));
  const notes = [];
  const hub = Object.assign(Object.create(Hub.prototype), { settings: {}, bots, bot: (id) => bots.get(id), info() {}, notify: (t) => notes.push(t), saveSettings() {} });
  const ready = { ...ur.check([
    { id: 'sable7', level: 100, classes: ['Lord of Order'], weapon: { value: 0.51 } },
    { id: 'valen7', level: 100, classes: ['StoneCrusher', 'ArchPaladin'], weapon: { value: 0.51 } },
    { id: 'nova7', level: 100, classes: ['Verus DoomKnight'], weapon: { value: 0.51 } },
    { id: 'oren7', level: 100, classes: ['ArchPaladin'], weapon: { value: 0.51 } },
  ]) };
  hub._ultra = ready;
  // Since 2026-10-13 ArchPaladin may take the King's Echo seat at the three Time Inn ultras (Seraph's v3 script fix).
  // Since 2026-10-18 Nulgath takes AP in the KE seat too (seraph-ap-vhl-loo-* comps).
  eq(hub.raidDue().map((b) => b.id), ['ultra-ezrajal', 'ultra-warden', 'ultra-engineer', 'ultra-nulgath', 'ultra-speaker'], 'without King\'s Echo: the Time Inn three and Nulgath (AP for KE) and Speaker (LoO/SC/VDK/AP)');
  const today = require('../lib/schedule').periodKey('day', new Date());
  const week = require('../lib/schedule').periodKey('week', new Date());   // Nulgath (AP for KE since 2026-10-18) booked for the week
  hub.settings.raids = { done: { 'ultra-ezrajal': today, 'ultra-warden': today, 'ultra-engineer': today, 'ultra-nulgath': week }, tries: {} };
  eq(hub.raidDue().map((b) => b.id), ['ultra-speaker'], 'the Time Inn three done today: Speaker is next');
  const r = await hub.raidTick();
  eq([r.boss, r.members.length], ['ultra-speaker', 4]);
  eq([...bots.values()].map((b) => b.restarted), [1, 1, 1, 1], 'everyone switches at once (v3 waits only 5 min)');
  const task = hub.raidTask(bots.get('nova7'));
  eq([task.type, task.path], ['script', 'SeraphUltras/IndividualUltras/10UltraSpeakerv3.cs']);
  bots.get('nova7').turnedIn = new Map([[9173, Date.now() + 1]]);
  hub.raidDone(bots.get('nova7'), task, true);
  eq(hub.raidTask(bots.get('nova7')).type, 'wait', 'back first: waits for the others');
  // Booked once everyone who could gain turned it in (2026-10-18).
  for (const id of ['sable7', 'valen7', 'oren7']) { bots.get(id).turnedIn = new Map([[9173, Date.now() + 1]]); hub.raidDone(bots.get(id), hub.raidTask(bots.get(id)), true); }
  eq(hub.raid, null, 'closed once all four are back');
  assert(notes.some((t) => /Ultra Speaker killed/.test(t)), notes.join(' | '));
  eq(hub.raidDue().length, 0, 'booked for the week');
  // A boss that fails twice in its period waits for the next one.
  hub.settings.raids.done = { 'ultra-ezrajal': today, 'ultra-warden': today, 'ultra-engineer': today, 'ultra-nulgath': week }; for (const id of ids) bots.get(id).turnedIn = new Map();
  for (let i = 0; i < 2; i++) { await hub.raidTick(); for (const id of ids) hub.raidDone(bots.get(id), hub.raidTask(bots.get(id)), false); }
  eq(hub.raidDue().length, 0, 'two failed tries: no third this week');
  eq(await hub.raidTick(), null);
  // A raid that never comes back is closed after 3 h.
  hub.settings.raids.tries = {};
  const r2 = await hub.raidTick();
  await hub.raidTick(r2.started + 3 * 3600000 + 1);
  eq(hub.raid, null, 'timed out');
  // The game resets on its own clock: a boss whose quest is still locked waits an hour and costs no try.
  hub.settings.raids = { done: {}, tries: {} };
  bots.get('sable7').questAvailable = async () => false;
  // Time Inn chain (2026-10-18): Sable can't turn Ezrajal in, so she fights for the other three.
  const rl = await hub.raidTick();
  eq([rl.boss, rl.gain.includes('sable7'), rl.members.length], ['ultra-ezrajal', false, 4], 'the chain boss starts for those who can gain');
  eq(hub.settings.raids.tries['ultra-speaker'], undefined, 'and no try booked');
  hub.raid = null;
  // A boss whose map needs a story she lacks (not a chain boss, never turned in) still waits an hour.
  hub.settings.raids = { done: { 'ultra-ezrajal': today, 'ultra-warden': today, 'ultra-engineer': today, 'ultra-nulgath': week }, tries: {} };
  eq(await hub.raidTick(), null, 'Speaker locked for her: no raid');
  bots.get('sable7').questAvailable = async () => true;
  eq(await hub.raidTick(), null, 'still inside the hour');
  eq((await hub.raidTick(Date.now() + 3600001)).boss, 'ultra-speaker', 'an hour later they are asked again');
});

test('protocol: the login uses the client version read from the live game SWF (Game.as vParam)', async () => {
  const zlib = require('zlib');
  const { Updater } = require('../lib/updater');
  const protocol = require('../lib/net/protocol');
  const pool = Buffer.from('RARITY_GLOWSvParam4.391ISWEBvurl', 'latin1');
  const swf = Buffer.concat([Buffer.from('CWS    ', 'latin1'), zlib.deflateSync(Buffer.concat([Buffer.alloc(64), pool]))]);
  eq(Updater.clientVersionOf(swf), '4.391');
  eq(Updater.clientVersionOf(Buffer.from('ZWS....', 'latin1')), null, 'LZMA SWF: unknown, keep the last one');
  const was = protocol.clientVersion();
  try {
    protocol.setClientVersion('4.391');
    assert(protocol.loginMsg('Me', 'tok').includes('~Me~4.391]]'), protocol.loginMsg('Me', 'tok'));
    eq(protocol.setClientVersion('not a version'), '4.391', 'junk is ignored');
  } finally { protocol.setClientVersion(was); }
});

test('headless: the combat engine can see skill readiness and auras (not auto-attack only)', async () => {
  const c = fakeClient();
  c.w.strFrame = 'r2';
  c.w.monsters = [{ MonMapID: 4, strFrame: 'r2', strMonName: 'Pixie', intHP: 100, intHPMax: 100 }];
  c.w.actions.active = [{ ref: 'aa', cd: 2000, mp: 0 }, { ref: 'a1', cd: 3000, mp: 10 }, { ref: 'a2', cd: 3000, mp: 10, isOK: false }];
  c.w.myAvatar.dataLeaf.intMP = 50;
  eq(await c.call('canUseSkill', 1), false, 'no target yet');
  await c.call('attackMonsterName', '*');
  eq([await c.call('canUseSkill', 1), await c.call('canUseSkill', 2)], [true, false], 'locked skills are not ready');
  c.handleJson('aura+', { cmd: 'aura+', tInf: 'p:11', auras: [{ nam: 'Arcane Flux', val: 3, dur: 10, ts: Date.now() }] });
  c.handleJson('ct', { cmd: 'ct', a: [{ cmd: 'aura+', tInf: 'm:4', auras: [{ nam: 'Armor Shred', dur: 5, ts: Date.now() }] }] });
  eq(await c.call('GetAurasValue', 'Self', 'arcane flux'), 3);
  eq((await c.call('getSubjectAuras', 'Target')).map((a) => a.nam), ['Armor Shred']);
  c.handleJson('aura-', { cmd: 'aura-', tInf: 'm:4', aura: { nam: 'Armor Shred' } });
  eq(await c.call('getSubjectAuras', 'Target'), []);
  await c.fn('world.partyInvite', 'valen7');
  assert(c.sent.some((m) => m === '%xt%zm%gp%1%pi%valen7%'), 'party invite packet');
  c.handleJson('pa', { cmd: 'pa', owner: 'nova7', ul: ['nova7', 'valen7'] });
  eq(await c.get('world.partyMembers'), ['nova7', 'valen7']);
});

// ---- Ultras-v3 line-ups + the owner's rules (level 100, 30%+ weapon) ----
const ultraready = require('../lib/ultraready');
const member = (id, classes, dmg = 0.51, level = 100) => ({ id, level, classes, enhancements: [], weapon: { value: dmg, name: 'w' } });
const planned = () => [
  member('sable7', ['Lord of Order']),
  member('valen7', ['StoneCrusher', 'ArchPaladin', 'Void Highlord']),
  member('nova7', ['Verus DoomKnight', 'ArchFiend', 'Shaman']),
  member('oren7', ["King's Echo", 'ArchPaladin']),
];

test('ultras: the planned classes (LoO, SC+AP+VHL, VDK+AF+Shaman, KE+AP) cover all eleven v3 line-ups', async () => {
  const r = ultraready.check(planned());
  eq(Object.values(r.bosses).filter((b) => b.ready).length, ultraready.BOSSES.length, r.missing.join(' | '));
  eq(r.ready, true);
  const who = Object.fromEntries(r.bosses['ultra-speaker'].seats.map((s) => [s.id, s.cls]));
  eq(who, { sable7: 'Lord of Order', valen7: 'StoneCrusher', nova7: 'Verus DoomKnight', oren7: 'ArchPaladin' }, 'Speaker: Oren swaps King\'s Echo for ArchPaladin');
  const dage = Object.fromEntries(r.bosses['ultra-dage'].seats.map((s) => [s.id, s.cls]));
  eq([dage.valen7, dage.oren7], ['Void Highlord', 'ArchPaladin'], 'Dage: no King\'s Echo (1 star, 2026-10-20) - Valen takes the DPS seat on Void Highlord, Oren plays ArchPaladin');
});

test('ultras: one class short blocks only the bosses that need it, and says who needs what', async () => {
  const m = planned(); m[3] = member('oren7', ['ArchPaladin']);   // no King's Echo yet
  const r = ultraready.check(m);
  eq([r.bosses['ultra-tyndarius'].ready, r.bosses['ultra-speaker'].ready, r.bosses['ultra-gramiel'].ready, r.bosses['champion-drakath'].ready], [false, true, true, true]);
  assert(r.bosses['ultra-tyndarius'].missing.some((t) => /King's Echo for Ultra Avatar Tyndarius/.test(t)), r.bosses['ultra-tyndarius'].missing.join(' | '));
  assert(r.ready, 'Speaker, Gramiel and Drakath can still be fought');
});

test('ultras: level 99, a 29% weapon or fewer than four online blocks every boss and says why', async () => {
  const m = planned(); m[0] = member('sable7', ['Lord of Order'], 0.29); m[1] = member('valen7', ['StoneCrusher', 'ArchPaladin'], 0.51, 99);
  const r = ultraready.check(m);
  eq(r.ready, false);
  const text = r.missing.join(' | ');
  assert(/sable7: a weapon with at least 30% all damage \(has 29%\)/.test(text), text);
  assert(/valen7: level 100 \(is 99\)/.test(text), text);
  eq(ultraready.check([member('x', [])]).ready, false, 'needs four characters');
});

test('ultras: reads "all damage" from the item meta; seats aim at King\'s Echo and Verus DoomKnight', async () => {
  eq(ultraready.bestAllDamage([{ sES: 'Weapon', sName: 'NSoD', sMeta: 'dmgAll:0.51,Undead:0.3' }, { sES: 'Weapon', sName: 'Stick', sMeta: 'gold:0.5' }, { sES: 'he', sMeta: 'dmgAll:0.9' }]), { value: 0.51, name: 'NSoD' });
  // The game writes multipliers: Burning Blade is dmgAll:1.15 (+15%), not +115% (2026-09-22: every bot "passed" 30%).
  eq(ultraready.bestAllDamage([{ sES: 'Weapon', sName: 'Burning Blade', sMeta: 'dmgAll:1.15' }]), { value: 0.15, name: 'Burning Blade' });
  eq(ultraready.goalsFor('oren7').slice(0, 3), ['burning-blade-of-abezeth', 'ultra-stories', 'kings-echo'], 'the quickest 30% weapon first (Weapon-Route, 2026-09-29)');
  eq(ultraready.goalsFor('nova7').slice(2, 4), ['shaman', 'verus-doomknight'], 'the quick Shaman first: Champion Drakath opens early');
  eq(ultraready.goalsFor('sable7')[2], 'lord-of-order');
  eq(ultraready.goalsFor('valen7').slice(-4), ['void-avenger-scythe', 'hollowborn-reaper-scythe', 'necrotic-sword-of-doom', 'exalted-apotheosis'], 'then 40%, then the long ones');
  assert(ultraready.goalsFor('valen7').includes('necrotic-sword-of-doom'), 'everyone chases a 51% weapon');
  // SeraphUltras (2026-10-18) ships with the app (app/ultras) and lib/ultras.js installs it into the library.
  for (const b of ultraready.BOSSES) assert(require('fs').existsSync(require('path').join(__dirname, '..', 'ultras', b.script)), `${b.script} exists`);
});

// ---- Farmer Joe, read live from the Skua library ----
test('farmer joe: progression steps come straight from the Skua scripts, each tied to a real script and method', async () => {
  const fj = require('../lib/farmerjoe');
  const steps = fj.reload();
  assert(steps.length >= 15, `only ${steps.length} steps`);
  const mr = steps.find((s) => /Master Ranger/.test(s.label));
  eq([mr.level, mr.script, mr.entry], [30, 'Other/Classes/REP-based/MasterRanger.cs', 'GetMR']);
  assert(steps.some((s) => /ArchPaladin/.test(s.label)), 'ArchPaladin is on the route');
  const { Brain } = require('../lib/brain');
  const goals = Brain.orderGoals(require('../lib/progression').goalsFor(null), 'valen7');
  const ids = goals.map((g) => g.id);
  assert(ids.indexOf('master-ranger') < ids.indexOf('scarlet-sorceress'), 'Farmer Joe order kept');
  assert(ids.includes('fj-dragonslayer'), 'steps missing from our own list are added');
  for (let i = 1; i < goals.length; i++) assert(goals[i].when >= goals[i - 1].when, `sorted by level at ${goals[i].id}`);
});

test('army: one job for the whole party, spread over cells, finished only when everyone has their share', async () => {
  require('../lib/paths').ensureDirs();
  const hub = new Hub(null, { headless: true, autoOpen: false });
  const bots = ['a', 'b', 'c'].map((id) => botStub(id));
  for (const x of bots) hub.bots.set(x.id, x);
  hub.startArmy({ map: 'Tercessuinotlim', cells: ['m1', 'm2'], monster: 'Dark Makai', item: 'Tainted Gem', qty: 100, quests: [4778] });
  const tasks = bots.map((b) => hub.armyTask(b));
  eq(tasks.map((t) => t.cell), ['m1', 'm2', 'm1'], 'divided over the cells');
  eq([tasks[0].map, tasks[0].room, tasks[0].room === tasks[2].room], ['tercessuinotlim', hub.army.room, true], 'one room for everyone');
  eq(hub.armyTask(bots[0]), null, 'handed out once per bot');
  eq(hub.armyDone(bots[0], tasks[0].army), false, 'waits for the others');
  hub.armyDone(bots[1], tasks[0].army);
  eq(hub.armyDone(bots[2], tasks[0].army), true, 'last one closes the job');
  eq(hub.army, null);
  // Two bots after the same goal end up in the same room.
  bots[0].current = { goal: 'master-ranger' }; bots[0]._taskRoom = 4; bots[0].roomNumber = () => 4;
  eq(hub.sharedRoomFor(bots[1], 'master-ranger'), 4);
  eq(hub.sharedRoomFor(bots[1], 'shaman'), null);
  hub.dispose();
});

test('report: says what each bot is doing, what it got and what is next, in plain text', async () => {
  require('../lib/paths').ensureDirs();
  const hub = new Hub(null, { headless: true, autoOpen: false });
  const fs = require('fs'); const path = require('path'); const { P } = require('../lib/paths');
  const b = botStub('reporter');
  b.playing = async () => true; b.level = async () => 31; b.className = async () => 'Master Ranger';
  b.current = { type: 'farmLevel', why: '2x XP today', startedAt: Date.now() - 20 * 60000 };
  b.stats = { kills: 120, quests: 3, drops: 4, deaths: 1 };
  fs.mkdirSync(P.account('reporter'), { recursive: true });
  fs.writeFileSync(path.join(P.account('reporter'), 'history.jsonl'), [
    { t: Date.now() - 3600000, type: 'level', level: 31 },
    { t: Date.now() - 1800000, type: 'drop', item: 'Minion of Skudly', qty: 1, ac: true },
    { t: Date.now() - 900000, type: 'quest', id: 1, name: 'x' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  hub.brain.plan = async () => ({ goals: [{ id: 'shaman', label: 'Shaman', status: 'ready', when: 30 }, { id: 'archpaladin', label: 'ArchPaladin', status: 'later', when: 50 }, { id: 'mr', label: 'Master Ranger', status: 'owned', when: 30 }] });
  hub.bots.set(b.id, b);
  const text = await require('../lib/report').text(hub, { hours: 24 });
  for (const want of ['reporter', 'level 31 Master Ranger', 'leveling for 20 min', '2x XP today', 'AC: Minion of Skudly', '1 quests', 'Next: Shaman', 'ArchPaladin (lvl 50)', '1/3 goals done', 'Ultras: not yet']) assert(text.includes(want), `missing "${want}" in:\n${text}`);
  hub.dispose();
});

// Found live 2026-09-19: both worlds held the inventory packet's own objects, so a drop was added twice (Skua saw 40
// Bone Dust where the server had 37 and turned the quest in too early); updateQuest was read as a quest list.
test('headless: a drop is counted once in both worlds and updateQuest moves the quest slot', async () => {
  const c = fakeClient();
  c.swf.w.myAvatar.objData = c.swf.w.myAvatar.objData || {};
  const pkt = (o) => c.handle(protocol.parse(JSON.stringify({ t: 'xt', b: { r: -1, o } })));
  pkt({ cmd: 'loadInventoryBig', items: [{ ItemID: 598, sName: 'Bone Dust', iQty: 34, iStk: 10000 }], factions: [] });
  pkt({ cmd: 'addItems', items: { 598: { iQty: 3, iQtyNow: 37, CharItemID: 1 } } });
  eq(c.w.myAvatar.items.find((i) => i.ItemID === 598).iQty, 37, 'headless world');
  eq(Number(c.swf.w.invTree[598].iQty), 37, 'skua.swf model');
  c.w.myAvatar.objData.strQuests = '0'.repeat(100);
  c.swf.w.myAvatar.objData.strQuests = '0'.repeat(100);
  pkt({ cmd: 'updateQuest', iIndex: 78, iValue: 3 });
  eq(await c.fn('world.getQuestValue', 78), 3, 'headless world');
  eq(c.swf.w.getQuestValue(78), 3, 'skua.swf model');
});

// Both world models follow Game.as: `pa` adds the names in `ul` except your own (the leader is only ever told about
// the member who just joined), `pr` names the leaver in `unm` while `owner` is the NEW leader, and `pd` is somebody
// declining an invitation - not a party falling apart.
test('headless: the party list follows the game - add, keep, and only the leaver leaves', async () => {
  const c = fakeClient();
  const pkt = (o) => c.handle(protocol.parse(JSON.stringify({ t: 'xt', b: { r: -1, o } })));
  c.w.myAvatar.objData.strUsername = 'Tester';
  c.swf.w.me = 'tester';
  pkt({ cmd: 'pa', pid: 42, ul: ['Tester', 'Valen7'], owner: 'Tester' });
  pkt({ cmd: 'pa', pid: 42, ul: ['Nova7'], owner: 'Tester' });
  for (const w of [c.w, c.swf.w]) {
    eq([...w.partyMembers].sort(), ['nova7', 'valen7'], 'both joiners kept, never yourself');
    eq(w.partyID, 42);
  }
  pkt({ cmd: 'pd', unm: 'Oren7' });                       // declined an invitation
  eq([...c.w.partyMembers].sort(), ['nova7', 'valen7'], 'a decline does not empty the party');
  eq([...c.swf.w.partyMembers].sort(), ['nova7', 'valen7'], 'in the skua.swf model either');
  pkt({ cmd: 'pr', unm: 'Valen7', typ: 'l', owner: 'Nova7' });
  for (const w of [c.w, c.swf.w]) {
    eq(w.partyMembers, ['nova7'], 'only the member named in unm left');
    eq(w.partyOwner, 'Nova7', 'owner on a pr is the new leader');
  }
  pkt({ cmd: 'pr', unm: 'Tester', typ: 'l', owner: 'Nova7' });
  for (const w of [c.w, c.swf.w]) eq([w.partyMembers.length, w.partyID, w.partyOwner], [0, 0, ''], 'leaving clears the whole party');
});

test('headless: leaving a party is a game function on both clients', async () => {
  const c = fakeClient();
  eq(await c.fn('world.partyLeave'), true);
  assert(c.sent.some((m) => m === '%xt%zm%gp%1%pl%'), `World.partyLeave packet: ${c.sent.join(' ')}`);
});

// Found 2026-09-20 in the laptop log (67x "this.client.send(...).catch is not a function"): the Flash client's send
// returns a promise, so callers add .catch - accepting a party invite crashed halfway on the headless client.
test('headless: send returns a promise, like the Flash client', async () => {
  const c = fakeClient();
  const r = c.send('%xt%zm%gp%1%pa%1%');
  assert(r && typeof r.then === 'function' && typeof r.catch === 'function', 'thenable');
  eq(await r, true);
  eq(c.sent, ['%xt%zm%gp%1%pa%1%']);
});

test('headless: player and monster updates arrive as JSON too, not only as %xt% strings', async () => {
  const { HeadlessClient } = require('../lib/net/headless');
  const c = new HeadlessClient({ id: 'uotlsjson', label: 'uotlsjson', loginFile: null }, {});
  c.w.myAvatar.objData.strUsername = 'Oren7';
  c.w.myAvatar.dataLeaf.intHP = 0;
  c.w.myAvatar.dataLeaf.intHPMax = 2197;
  c.w.monsters = [{ MonMapID: 4, intHP: 100, intHPMax: 100, intState: 1 }];
  c.w.myAvatar.target = c.w.monsters[0];
  c.handleJson('uotls', { unm: 'oren7', o: { intHP: 2197, intHPMax: 2197, intState: 1 } });
  eq(c.w.myAvatar.dataLeaf.intHP, 2197, 'JSON uotls reaches dataLeaf (the model bot.js reads)');
  c.handleJson('mtls', { id: 4, o: { intHP: 0, intState: 0 } });
  eq(c.w.monsters[0].intHP, 0, 'JSON mtls reaches the monster');
  eq(c.w.myAvatar.target, null, 'a monster on 0 hp is no longer the target');
  c.applyUotls('oren7', 'intHP:1200,strFrame:r7');
  eq([c.w.myAvatar.dataLeaf.intHP, c.w.strFrame], [1200, 'r7'], 'the string form still works');
  c.disconnect();
});

test('headless: experience and gold grow with the server, so the rates are real', async () => {
  const { HeadlessClient } = require('../lib/net/headless');
  const c = new HeadlessClient({ id: 'expgrow', label: 'expgrow', loginFile: null }, {});
  c.w.myAvatar.objData.intExp = 1000;
  c.w.myAvatar.objData.intGold = 500;
  c.handleJson('addGoldExp', { intExp: 250, intGold: 90 });
  eq([c.w.myAvatar.objData.intExp, c.w.myAvatar.objData.intGold], [1250, 590], 'a kill adds experience and gold');
  c.handleJson('levelUp', { intLevel: 65, intExpToLevel: 1700000, xp: 0 });
  eq([c.w.myAvatar.objData.intLevel, c.w.myAvatar.objData.intExp, c.w.myAvatar.objData.intExpToLevel], [65, 0, 1700000], 'a level-up resets the bar');
  c.injecting = true;
  c.handleJson('levelUp', { intLevel: 100, intExpToLevel: 1, xp: 99 });
  eq(c.w.myAvatar.objData.intExp, 0, 'CoreBots\' fake level 100 never touches the real numbers');
  c.disconnect();
});

test('headless: 0 hit points before the first update is loading, not dying', async () => {
  const { HeadlessClient } = require('../lib/net/headless');
  const c = new HeadlessClient({ id: 'loadhp', label: 'loadhp', loginFile: null }, {});
  c.w.myAvatar.objData.strUsername = 'Loadhp';
  let died = 0;
  c.on('died', () => { died++; });
  c.w.myAvatar.dataLeaf.intHP = 0;                 // what initUserData gives everyone
  c.w.myAvatar.dataLeaf.intState = 1;
  c.checkDeath();
  eq([died, !!c._respawn], [0, false], 'a loading character is not dead');
  c.applyUotls('loadhp', 'intHP:2400,intHPMax:2400');
  eq(c.sawHp, true, 'the server has now said what our hit points are');
  c.applyUotls('loadhp', 'intHP:0');
  await new Promise((r) => setTimeout(r, 20));
  eq(died, 1, 'and now 0 hit points really is a death');
  c.disconnect();
  eq(c._respawn, null, 'a reconnect never leaves the respawn loop behind');
});

test('headless: the login packet never wipes the hit points we already know', async () => {
  const { HeadlessClient } = require('../lib/net/headless');
  const c = new HeadlessClient({ id: 'hpblank', label: 'hpblank', loginFile: null }, {});
  c.w.myAvatar.objData.strUsername = 'Hpblank';
  c.applyUotls('hpblank', 'intHP:2600,intHPMax:2600,intState:1');
  // Seraph asks for retrieveUserData after every room change; the answer always says intHP 0.
  c.onInitUserData({ strUsername: 'Hpblank', intHP: 0, intHPMax: 2600, intMP: 0, intMPMax: 100, intLevel: 66 });
  eq(c.w.myAvatar.dataLeaf.intHP, 2600, 'the real number survives the room change');
  c.applyUotls('hpblank', 'intHP:0,intState:0');                   // a real death
  eq([c.w.myAvatar.dataLeaf.intHP, c.w.myAvatar.dataLeaf.intState], [0, 0], 'a death still lands');
  c.disconnect();
});

// 2026-09-22 capture: an 8.9 s network stall; Skua asked for quest 3931 41 times (the server answered 14 and said
// "Please slow down" to the rest), CoreBots gave up, fell back to the quest file and KillQuest skipped the quest: the
// "Quest progression recovery failed" relog loop. Now an unanswered quest is asked for once and Skua's load call waits.
test('quests: a quest still waiting for its answer is not asked for again, and Skua\'s load waits for the answer', async () => {
  const { SkuaEngine } = require('../lib/skua/engine');
  const protocol = require('../lib/net/protocol');
  const c = new HeadlessClient({ id: 'qwait', label: 'qwait', username: 'Tester' });
  c.sent = [];
  c.write = (m) => c.sent.push(m);
  c.w.myAvatar.uid = 11;
  c.swf.game.sfc.myUserId = 11;
  const asks = () => c.sent.filter((m) => /%getQuests%/.test(m)).length;
  const replies = [];
  const eng = { client: c, send: (x) => replies.push(x), syncState() {} };
  const load = (i) => SkuaEngine.prototype.answerCall.call(eng, { f: 'callGameFunction', a: ['world.showQuests', '3931', 'q'], i });
  const answer = () => c.handle(protocol.parse(JSON.stringify({ t: 'xt', b: { r: -1, o: { cmd: 'getQuests', quests: { 3931: { QuestID: 3931, sName: 'Web of Fear', iSlot: 185, iValue: 25, turnin: [{ ItemID: 27341, iQty: 1 }], oItems: {} } } } } })));

  load(1);
  for (let i = 2; i <= 6; i++) load(i);
  eq(asks(), 1, 'six loads while it is unanswered: one request');
  await new Promise((r) => setTimeout(r, 50));
  eq(replies.length, 0, 'Skua\'s load calls wait for the answer');
  answer();
  await new Promise((r) => setTimeout(r, 20));
  eq(replies.map((r) => r.i).sort(), [1, 2, 3, 4, 5, 6], 'the answer releases every waiting load');
  assert(c.swf.w.questTree[3931], 'the quest is in the tree');
  load(7);
  eq([asks(), replies.length], [1, 7], 'a loaded quest is answered at once, no new request');

  // A quest the server never answers: after the wait (shortened here) it may be asked again, and it is not held again.
  process.env.SERAPH_QUEST_WAIT_MS = '60';
  try {
    SkuaEngine.prototype.answerCall.call(eng, { f: 'callGameFunction', a: ['world.showQuests', '99999', 'q'], i: 8 });
    await new Promise((r) => setTimeout(r, 120));
    assert(replies.some((r) => r.i === 8), 'answered after the wait even without the quest');
    SkuaEngine.prototype.answerCall.call(eng, { f: 'callGameFunction', a: ['world.showQuests', '99999', 'q'], i: 9 });
    eq(asks(), 3, 'asked again once the wait is over');
    await new Promise((r) => setTimeout(r, 10));
    assert(replies.some((r) => r.i === 9), 'and not held a second time within a minute');
  } finally { delete process.env.SERAPH_QUEST_WAIT_MS; }
});

// 2026-09-24: no barber visit ever stuck on the laptop. The real client sends the hair shop's id with changeColor
// (World.sendChangeColorRequest) and the headless world never read the server's answer.
test('headless: the barber sends the hair shop id and takes the new look from the server', async () => {
  const c = fakeClient();
  c.w.room = 7; c.w.curRoom = 7;
  const pkt = (o) => c.handle(protocol.parse(JSON.stringify({ t: 'xt', b: { r: -1, o } })));
  pkt({ cmd: 'loadHairShop', HairShopID: 3, hair: [{ HairID: 52, sName: 'Pony1Long' }] });
  await c.fn('world.sendChangeColorRequest', 111, 222, 333, 52);
  assert(c.sent.some((m) => /%xt%zm%changeColor%\d+%111%222%333%52%3%/.test(m)), c.sent.join(' | '));
  pkt({ cmd: 'changeColor', uid: 11, HairID: 52, strHairName: 'Pony1Long', strHairFilename: 'x.swf', intColorSkin: 111, intColorHair: 222, intColorEye: 333 });
  pkt({ cmd: 'changeArmorColor', uid: 11, intColorBase: 1, intColorTrim: 2, intColorAccessory: 3 });
  const o = c.w.myAvatar.objData;
  eq([o.HairID, o.strHairName, o.intColorHair, o.intColorEye, o.intColorBase, o.intColorTrim], [52, 'Pony1Long', 222, 333, 1, 2]);
  pkt({ cmd: 'changeColor', uid: 99, intColorHair: 5 });
  eq(o.intColorHair, 222, 'someone else\'s new look is not ours');
});

// Valen at /escherion 2026-10-13: CoreBots turns on both Skua aggro options, 8 aggroMon a second against a 2-4.5/s
// send rate. The queue filled with aggro, attacks waited ~30 s behind it or were dropped, and he only self-cast.
test('send queue: aggroMon spam collapses to one queued pull; overflow drops filler before attacks', async () => {
  const c = new HeadlessClient({ id: 'aggrospam', label: 'aggrospam', username: 'A' });
  c.sock = { destroyed: false, write: () => {} }; c.swf = { onOutgoing() {} }; c.flush = () => {};
  c.w.curRoom = 7;
  for (let i = 0; i < 200; i++) { c.xt('aggroMon', [1, 2, 3]); c.xt('aggroMon', [2, 3]); }
  c.xt('gar', [1, 'aa>m:2', 'wvz']);
  eq(c.outbox.filter((m) => m.startsWith('%xt%zm%aggroMon%')).length, 1, 'one aggroMon waits at a time');
  eq(c.outbox.length, 2);
  c._aggroAt = Date.now() - 3000; c.xt('aggroMon', [2, 3]);
  eq(c.outbox.filter((m) => m.startsWith('%xt%zm%aggroMon%')).length, 1, 'a fresh pull replaces the queued one');
  // Overflow: the filler goes, the attacks stay.
  c.outbox = [];
  for (let i = 0; i < 40; i++) c.outbox.push(`%xt%zm%mv%7%${i}%300%`);
  for (let i = 0; i < 30; i++) c.outbox.push(`%xt%zm%gar%7%${i}%aa>m:2%wvz%`);
  delete c.flush;
  c.flushing = false; c._lastWrite = 0;
  c.flush();
  await new Promise((r) => setTimeout(r, 20));
  eq(c.outbox.filter((m) => m.includes('%gar%')).length, 30, 'no attack dropped');
});
