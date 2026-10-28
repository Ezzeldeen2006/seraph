// The class ladder (the owner 2026-10-16): a boss killing a character inside its own script is tried with the class's
// careful rotation and other classes (lib/fightplan.js, hub.fightLadder) before the goal is parked or the owner is pinged;
// and raids are called off as soon as a member drops out (Valen, gold rule, 12 h of 3-man wipes on 2026-10-16).
const fightplan = require('../lib/fightplan');
const { Hub } = require('../lib/hub');

const R10 = 302500;
const MAIN = ["King's Echo", 'Void Highlord', 'Chaos Avenger'];

function ladderBot(cls, extra = {}) {
  const lines = [];
  const bot = {
    id: 'ladder', lines, settings: {}, account: { label: 'Ladder', kind: 'party' },
    current: { type: 'script', path: 'Other/Classes/ArcanaInvoker.cs', goal: 'arcana-invoker', brain: true },
    restarts: 0,
    journal(m) { lines.push(m); },
    restart() { this.restarts++; },
    taskKey(t) { return t ? [t.type, t.path || '', t.entry || '', t.args || '', t.name || '', t.goal || '', t.event || ''].join('|') : ''; },
    classPoints: async () => [...MAIN, 'ArchPaladin', 'Lord of Order'].map((name) => ({ name, cp: R10 })),
    client: { w: { strMapName: 'shadowrealm', myAvatar: { dataLeaf: { intHPMax: 2585 }, items: [{ sName: cls, sES: 'ar', bEquip: 1, iQty: R10 }] } } },
    ...extra,
  };
  return bot;
}
const champion = { name: 'Fiend Champion', hpMax: 229200, hp: 200000 };

test('class ladder: the steps follow the owner\'s order (KE normal, KE careful, VHL careful, CAV careful)', () => {
  const s = fightplan.steps("King's Echo", [...MAIN, 'ArchPaladin'], MAIN);
  eq(s.map((x) => `${x.cls}/${x.mode}`).join(', '), "King's Echo/Base, King's Echo/Solo, Void Highlord/Solo, Chaos Avenger/Solo");
  // No list: the best damage class it owns, then the toughest.
  const d = fightplan.steps('ArchPaladin', ['ArchPaladin', 'Lord of Order', 'Scarlet Sorceress', 'StoneCrusher'], null);
  eq(d.map((x) => x.cls).join(', '), 'ArchPaladin, Scarlet Sorceress, Lord of Order');
  // Classes it doesn't own (rank 10) are left out.
  eq(fightplan.steps("King's Echo", ["King's Echo"], MAIN).length, 2, 'only its own two rotations');
});

test('class ladder: holds the other death rules, switches after 3 deaths, hands over when every step failed', async () => {
  const h = Object.create(Hub.prototype);
  const bot = ladderBot("King's Echo");
  bot.settings.bossClasses = MAIN;
  const now = Date.now();
  eq(await h.fightLadder(bot, champion, now), true, '1st death: held');
  eq(await h.fightLadder(bot, champion, now + 1000), true, '2nd death: held');
  eq(bot.restarts, 0);
  eq(await h.fightLadder(bot, champion, now + 2000), true, '3rd death: switch');
  eq(bot.restarts, 1, 'the script restarts with the new step');
  eq(bot._fight.steps[bot._fight.i].mode, 'Solo', 'KE careful rotation');
  const keys = fightplan.cboKeys(bot);
  eq(keys.SoloClassSelect, "King's Echo"); eq(keys.SoloModeSelect, 'Solo');
  for (let i = 0; i < 3; i++) await h.fightLadder(bot, champion, now + 3000 + i);
  eq(fightplan.cboKeys(bot).SoloClassSelect, 'Void Highlord', 'then VHL');
  for (let i = 0; i < 3; i++) await h.fightLadder(bot, champion, now + 6000 + i);
  eq(fightplan.cboKeys(bot).SoloClassSelect, 'Chaos Avenger', 'then CAV');
  // The owner 2026-10-19 ("keep rotating until you find the class"): a hand-picked list goes round LAPS_WANTED times.
  eq(await h.fightLadder(bot, champion, now + 9000), true, 'last step of lap 1: still held, another lap follows');
  await h.fightLadder(bot, champion, now + 9001);
  await h.fightLadder(bot, champion, now + 9002);
  eq(bot._fight.lap, 2, 'lap 2');
  eq(fightplan.cboKeys(bot).SoloClassSelect, "King's Echo", 'back to the first step');
  let t = now + 10000;
  while (!fightplan.exhausted(bot, 'Fiend Champion') && t < now + 20000) await h.fightLadder(bot, champion, t++);
  eq(bot._fight.lap, fightplan.LAPS_WANTED);
  eq(await h.fightLadder(bot, champion, t), false, 'after the last lap: deaths count for the normal rules again');
  assert(fightplan.exhausted(bot, 'Fiend Champion'), 'every set-up failed');
  assert(bot.lines.some((l) => /beat every set-up/.test(l)), bot.lines.join(' | '));
});

test('class ladder: not for raids, helpers, small monsters or another task', async () => {
  const h = Object.create(Hub.prototype);
  const bot = ladderBot("King's Echo");
  eq(await h.fightLadder(bot, { name: 'Frogzard', hpMax: 900 }), false, 'not a boss');
  bot.current = { type: 'script', path: 'Ultrasv3/x.cs', raid: 'raid-1' };
  eq(await h.fightLadder(bot, champion), false, 'raid');
  bot.current = { type: 'assist' };
  eq(await h.fightLadder(bot, champion), false, 'assist');
  // A step only applies to its own task.
  const b2 = ladderBot("King's Echo");
  b2._fight = { key: 'other|task', boss: 'Fiend Champion', slot: 'solo', steps: [{ cls: 'Void Highlord', mode: 'Solo' }], i: 0, deaths: [] };
  eq(fightplan.cboKeys(b2), null);
});

test('class ladder: the farm class slot is swapped when the script fought with it', async () => {
  const h = Object.create(Hub.prototype);
  const bot = ladderBot('Legion Revenant', { account: { label: 'Main', kind: 'guest' } });
  bot.settings = { soloClass: "King's Echo", farmClass: 'Legion Revenant', bossClasses: MAIN };
  bot.classPoints = async () => [...MAIN, 'Legion Revenant'].map((name) => ({ name, cp: R10 }));
  for (let i = 0; i < 3; i++) await h.fightLadder(bot, champion, Date.now() + i);
  eq(fightplan.cboKeys(bot).FarmModeSelect, 'Solo', 'LR careful rotation first (2026-10-19)');
  for (let i = 0; i < 3; i++) await h.fightLadder(bot, champion, Date.now() + 10 + i);
  const k = fightplan.cboKeys(bot);
  eq(k.FarmClassSelect, "King's Echo", 'first ladder class after LR');
  eq(k.BossClassSelect, "King's Echo", 'boss steps (Core.UseBossClass) get it too');
  eq(k.SoloClassSelect, undefined);
});

test('class ladder: a kill is remembered and the next fight with that boss starts there', async () => {
  const fs = require('fs'); const path = require('path'); const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-'));
  const h = Object.create(Hub.prototype);
  const bot = ladderBot("King's Echo", { file: (n) => path.join(dir, n) });
  bot.settings.bossClasses = MAIN;
  for (let i = 0; i < 6; i++) await h.fightLadder(bot, champion, Date.now() + i);
  eq(fightplan.cboKeys(bot).SoloClassSelect, 'Void Highlord');
  assert(fightplan.onKill(bot, 'Fiend Champion'), 'learned');
  eq(JSON.parse(fs.readFileSync(path.join(dir, 'bossClasses.json'), 'utf8'))['Fiend Champion'].cls, 'Void Highlord');
  // Next task, first death: straight to VHL careful.
  const again = ladderBot("King's Echo", { file: (n) => path.join(dir, n) });
  again.settings.bossClasses = MAIN;
  again.current = { type: 'script', path: 'Other/Classes/ArcanaInvoker.cs', goal: 'arcana-invoker', brain: true, tries: 2 };
  eq(await h.fightLadder(again, champion), true);
  eq(again.restarts, 1);
  eq(fightplan.cboKeys(again).SoloClassSelect, 'Void Highlord');
  assert(again.lines.some((l) => /beat it before/.test(l)), again.lines.join(' | '));
});

test('class ladder: CoreBots gets normal rotations unless the ladder says otherwise', async () => {
  const cbo = require('../lib/skua/cbo');
  const bot = ladderBot("King's Echo", { account: { label: 'Main', kind: 'guest' } });
  bot.settings = { soloClass: "King's Echo", farmClass: 'Legion Revenant', privateRoom: 24680 };
  let k = await cbo.keysFor(bot);
  eq(k.SoloModeSelect, 'Base'); eq(k.SoloClassSelect, "King's Echo");
  bot._fight = { key: bot.taskKey(bot.current), boss: 'Fiend Champion', slot: 'solo', steps: [{ cls: "King's Echo", mode: 'Base' }, { cls: 'Chaos Avenger', mode: 'Solo' }], i: 1, deaths: [] };
  k = await cbo.keysFor(bot);
  eq(k.SoloClassSelect, 'Chaos Avenger'); eq(k.SoloModeSelect, 'Solo'); eq(k.FarmModeSelect, 'Base');
});

test('rotations: KE shields right after CORVAK, VHL never Unshackles on hard bosses, VHL easy mode stops the HP flip-flop', () => {
  const ov = require('../lib/skill-overrides.json').classes;
  const ke = ov["King's Echo"].Solo.skills.map((s) => s.skillId);
  // 2026-10-20: CORVAK is three entries (8 Residual Energy / 6 + mana < 40 % / mana < 20 %), Shield right after them.
  const firstOther = ke.findIndex((id) => id !== 4);
  eq(ke[0], 4, 'CORVAK first (once the stacks are up)'); eq(ke[firstOther], 3, "King's Shield straight after it");
  assert(!ov["King's Echo"].Solo.skills[firstOther].rules, 'Shield after CORVAK is ungated');
  assert(ov["King's Echo"].Solo.skills.some((s) => s.skillId === 4 && s.rules.some((r) => r.auraName === 'Residual Energy' && r.value === 8)), 'CORVAK on 8 Residual Energy');
  assert(!ov['Void Highlord'].Solo.skills.some((s) => s.skillId === 3), 'no Unshackle in the careful mode');
  const easy = ov['Void Highlord'].Base.skills;
  assert(!easy.some((s) => s.skillId === 1), 'no Shackle in the easy mode (it would undo Unshackle for 20% HP)');
  const un = easy.find((s) => s.skillId === 3);
  assert(un.rules.some((r) => r.type === 'Aura' && r.auraName === 'Unshackled') && un.skipOnMatch, 'Unshackle only when it is off');
  const cav = ov['Chaos Avenger'].Solo.skills[0];
  eq(cav.skillId, 3); eq(cav.rules[0].auraName, 'Chaotic Armor');
  for (const c of MAIN) assert(fightplan.hasCareful(c), `${c} has a careful mode`);
});

test('adaptive: King\'s Echo waits for Residual Energy / spent mana before CORVAK and shields when it hurts', () => {
  const { routineFor } = require('../lib/adaptive');
  const r = routineFor("King's Echo");
  const c = (o) => ({ H: 1, M: 1, def: false, self: () => null, target: () => null, ...o });
  eq(r.use(4, c({ M: 0.9 })), false, 'full mana, no stacks: CORVAK would hit weakly');
  eq(r.use(4, c({ M: 0.3 })), false, '2026-10-20: 30 % mana but no Residual Energy yet - keep Bolting');
  eq(r.use(4, c({ M: 0.15 })), true, 'dry: the refill');
  eq(r.emergency(3, c({ H: 0.4 })), true, 'low HP: King\'s Shield');
  eq(r.emergency(2, c({ H: 0.4 })), false, 'not Bolt');
});

function raidHub() {
  const h = Object.create(Hub.prototype);
  h.settings = {}; h.infos = [];
  h.info = (t) => h.infos.push(t); h.notify = () => {}; h.saveSettings = () => {};
  h.bots = new Map();
  for (const id of ['sable7', 'valen7', 'nova7', 'oren7']) {
    h.bots.set(id, { id, gold: 600000, goldNow() { return this.gold; }, restarts: 0, account: { label: id }, current: { type: 'script', raid: 'raid-1' }, restart() { this.restarts++; }, turnedIn: new Map() });
  }
  h.bot = (id) => h.bots.get(id);
  h.raid = { id: 'raid-1', boss: 'champion-drakath', name: 'Champion Drakath', quest: 8300, every: 'week', started: Date.now() - 120000, members: [...h.bots.keys()], back: {} };
  return h;
}

test('raids: a member that drops out calls the raid off for everyone; a gold stop holds the boss until the gold is there', () => {
  const h = raidHub();
  const v = h.bot('valen7');
  h.raidDone(v, { type: 'script', raid: 'raid-1' }, false, { goldWait: 5400000 });
  eq(h.raid, null, 'called off at once, not after 3 h');
  for (const id of ['sable7', 'nova7', 'oren7']) eq(h.bot(id).restarts, 1, `${id} goes back to its own work`);
  eq(h.settings.raids.tries['champion-drakath'].n, 1, 'a try for the period');
  assert(h.raidGoldShort('champion-drakath'), 'held while Valen is short');
  v.gold = 6000000;
  assert(!h.raidGoldShort('champion-drakath'), 'free once he has it');
  assert(h.infos.some((t) => /calling off Champion Drakath/.test(t)), h.infos.join(' | '));
});

test('raids: a member back with the kill does not call anything off', () => {
  const h = raidHub();
  const s = h.bot('sable7');
  s.turnedIn.set(8300, Date.now());
  h.raidDone(s, { type: 'script', raid: 'raid-1' }, true);
  assert(h.raid, 'the others finish');
  h.raidDone(h.bot('valen7'), { type: 'script', raid: 'raid-1' }, false);
  assert(h.raid, 'a kill is in: no call-off');
});

test('raids: a raid script stopped for gold never lands in the brain\'s gold-wait list', async () => {
  const { Brain } = require('../lib/brain');
  const brain = Object.create(Brain.prototype);
  const st = { goalFails: {} };
  brain.state = () => st; brain.saveState = () => {};
  brain.today = () => ({ goalsToday: {}, dailies: {}, goalChunks: 0 });
  const calls = [];
  brain.hub = { raidDone: (b, t, ok, info) => calls.push(info) };
  const bot = { id: 'v', journal() {}, goldNow: () => 1, taskKey: (t) => t.path };
  await brain.done(bot, { type: 'script', path: 'Ultrasv3/IndividualUltras/5ChampionDrakathv3.cs', raid: 'raid-1', brain: true }, { ok: true, goldWait: 5400000 });
  eq(Object.keys(st.goldWait || {}).length, 0, 'not stored');
  eq(calls[0].goldWait, 5400000, 'the hub hears about the gold');
});

test('main: an old solo kill no longer silences the ping once the class ladder tried everything', () => {
  const h = Object.create(Hub.prototype);
  const sent = [];
  h.discord = { enabled: true, send: (t) => sent.push(t) };
  h.notify = () => {};
  const bot = ladderBot('Chaos Avenger', { account: { label: 'GRAIL26', kind: 'guest' }, stopped: false, stop() { this.stopped = true; } });
  bot._soloBosses = { 'Fiend Champion': '2026-10-15' };
  eq(h.mainNeedsParty(bot, champion, 2), null);
  eq(sent.length, 0, 'killed it solo, ladder not done: quiet');
  bot._fight = { key: bot.taskKey(bot.current), boss: 'Fiend Champion', slot: 'solo', steps: fightplan.steps("King's Echo", MAIN, MAIN), i: 3, deaths: [], exhausted: true };
  h.mainNeedsParty(bot, champion, 2);
  eq(sent.length, 1, 'DM');
  assert(/tried King's Echo/.test(sent[0]) && /Chaos Avenger/.test(sent[0]), sent[0]);
  // The owner 2026-10-25: never a stop - the task rests and the autopilot goes on with other goals.
  assert(!bot.stopped, 'not stopped');
  eq(bot.restarts, 1, 'restarted onto other work');
  assert(bot.skipped && bot.skipped.get(bot.taskKey(bot.current)) > Date.now() + 5 * 3600000, 'the task rests 6 h');
});

// The owner 2026-10-19: LR for Avatar Tyndarius, Arcana Invoker for Nightbane - before the first death when the boss is
// in the cell (hub.preFightTick), and on the first death otherwise.
test('boss picks: Avatar Tyndarius in the cell switches to LR before the fight, once', async () => {
  const h = Object.create(Hub.prototype);
  const bot = ladderBot("King's Echo", { classPoints: async () => [...MAIN, 'Legion Revenant', 'Arcana Invoker'].map((name) => ({ name, cp: R10 })) });
  bot.settings.bossClasses = ['Arcana Invoker', "King's Echo", 'Legion Revenant', 'Void Highlord', 'Chaos Avenger'];
  bot.client.w.strFrame = 'r9';
  bot.client.w.monsters = [{ strMonName: 'Avatar Tyndarius', strFrame: 'r9', intState: 1 }, { strMonName: 'Shadefire Cavalry', strFrame: 'r8', intState: 1 }];
  eq(await h.preFightTick(bot), 'Avatar Tyndarius');
  eq(bot.restarts, 1);
  const k = fightplan.cboKeys(bot);
  eq(k.SoloClassSelect, 'Legion Revenant'); eq(k.BossClassSelect, 'Legion Revenant');
  eq(await h.preFightTick(bot), null, 'already on it: no second restart');
  eq(bot.restarts, 1);
  bot.client.w.strFrame = 'r8';
  const b2 = ladderBot("King's Echo"); b2.client.w.strFrame = 'r8'; b2.client.w.monsters = bot.client.w.monsters;
  eq(await h.preFightTick(b2), null, 'no picked boss in this cell');
});

test("boss picks: a task that just started does not switch for the boss of the cell it was left in (after an assist)", async () => {
  const h = Object.create(Hub.prototype);
  const bot = ladderBot("King's Echo", { classPoints: async () => [...MAIN, 'Legion Revenant', 'Arcana Invoker'].map((name) => ({ name, cp: R10 })) });
  bot.settings.bossClasses = ['Arcana Invoker', "King's Echo", 'Legion Revenant', 'Void Highlord', 'Chaos Avenger'];
  bot.client.w.strFrame = 'r9';
  bot.client.w.monsters = [{ strMonName: 'Avatar Tyndarius', strFrame: 'r9', intState: 1 }];
  const now = Date.now();
  bot.current.startedAt = now - 10000;
  bot.scriptStep = '(Ravenous) Unlocking Enhancement: Ravenous';
  eq(await h.preFightTick(bot, now), null, 'still in the helper room, the forge script never named the boss');
  eq(bot.restarts, 0);
  bot.scriptStep = '(HuntMonster) Killing Avatar Tyndarius for item: "Tyndarius Insignia" 0/1';
  eq(await h.preFightTick(bot, now), 'Avatar Tyndarius', 'the script itself is going for it: switch at once');
  const b2 = ladderBot("King's Echo", { classPoints: async () => [...MAIN, 'Legion Revenant'].map((name) => ({ name, cp: R10 })) });
  b2.settings.bossClasses = bot.settings.bossClasses;
  b2.client.w.strFrame = 'r9'; b2.client.w.monsters = bot.client.w.monsters;
  b2.current.startedAt = now - 3 * 60000;
  eq(await h.preFightTick(b2, now), 'Avatar Tyndarius', 'after 2 min the cell alone decides, as before');
});

test('boss picks: a first death to Nightbane switches to Arcana Invoker; a learned win comes first', async () => {
  const h = Object.create(Hub.prototype);
  const owned = async () => [...MAIN, 'Arcana Invoker'].map((name) => ({ name, cp: R10 }));
  const bot = ladderBot("King's Echo", { classPoints: owned });
  eq(await h.fightLadder(bot, { name: 'Nightbane', hpMax: 500000 }), true);
  eq(fightplan.cboKeys(bot).BossClassSelect, 'Arcana Invoker');
  const b2 = ladderBot("King's Echo", { classPoints: owned, _bossClasses: { Nightbane: { cls: 'Void Highlord', mode: 'Solo' } } });
  await h.fightLadder(b2, { name: 'Nightbane', hpMax: 500000 });
  eq(fightplan.cboKeys(b2).SoloClassSelect, 'Void Highlord', 'what beat it before wins over the pick');
});

test('raids: a partial kill reruns with the member who died swapped into a seat whose owner has the kill', async () => {
  const h = Object.create(Hub.prototype);
  h.settings = {}; h.infos = []; h.timers = [];
  h.info = (t) => h.infos.push(t); h.notify = () => {}; h.saveSettings = () => {};
  h.bots = new Map();
  const classes = { sable7: ['Lord of Order', 'StoneCrusher', 'ArchPaladin'], valen7: ['Lord of Order', 'StoneCrusher', 'ArchPaladin', 'Void Highlord'], nova7: ['Lord of Order', 'StoneCrusher', 'ArchPaladin', 'Void Highlord'], oren7: ['Lord of Order', 'StoneCrusher', 'ArchPaladin'] };
  for (const id of Object.keys(classes)) h.bots.set(id, { id, running: true, paused: false, serverName: 'Swordhaven', account: { label: id }, current: null, journal() {}, restart() {}, classPoints: async () => classes[id].map((name) => ({ name, cp: R10 })) });
  h.bot = (id) => h.bots.get(id);
  const seats = [{ id: 'sable7', cls: 'Lord of Order' }, { id: 'valen7', cls: 'StoneCrusher' }, { id: 'nova7', cls: 'Void Highlord' }, { id: 'oren7', cls: 'ArchPaladin' }];
  h.ultraReady = () => ({ bosses: { 'ultra-warden': { seats } } });
  const boss = { id: 'ultra-warden', name: 'Ultra Warden', script: 'x.cs', quest: 8153, every: 'day' };
  const r = h.beginRaid(boss, [...h.bots.values()], Date.now(), seats);
  for (const id of ['sable7', 'valen7', 'nova7']) h.bots.get(id).turnedIn = new Map([[8153, Date.now() + 1000]]);
  r.attempts = [{ outcome: 'kill' }];
  for (const id of ['sable7', 'valen7', 'nova7', 'oren7']) h.raidDone(h.bots.get(id), { type: 'script', raid: r.id }, true);
  const book = h.settings.raids;
  assert(!book.tries['ultra-warden'], 'a partial kill is no try');
  eq(book.partial['ultra-warden'].n, 1);
  eq(book.swap['ultra-warden'].ids.join(), 'oren7');
  const next = await h.raidSwapSeats(boss, [...h.bots.values()]);
  const o = next.find((s) => s.id === 'oren7');
  assert(o.cls !== 'ArchPaladin', `Oren leaves the seat he died in: ${JSON.stringify(next)}`);
  const took = next.find((s) => s.cls === 'ArchPaladin');
  assert(took && took.id !== 'oren7', 'someone with the kill takes the ArchPaladin seat');
});

test('raids: a rerun where the others turned it in earlier today books the kill when the last one gets it', async () => {
  const h = Object.create(Hub.prototype);
  h.settings = {}; h.infos = []; h.timers = [];
  h.info = (t) => h.infos.push(t); h.notify = () => {}; h.saveSettings = () => {};
  h.bots = new Map();
  for (const id of ['sable7', 'valen7', 'nova7', 'oren7']) h.bots.set(id, { id, running: true, paused: false, serverName: 'Swordhaven', account: { label: id }, current: null, journal() {}, restart() {} });
  h.bot = (id) => h.bots.get(id);
  const boss = { id: 'ultra-warden', name: 'Ultra Warden', script: 'x.cs', quest: 8153, every: 'day' };
  const t0 = Date.now();
  for (const id of ['sable7', 'valen7', 'nova7']) h.bots.get(id).turnedIn = new Map([[8153, t0 - 60000]]);
  const r = h.beginRaid(boss, [...h.bots.values()], t0, []);
  r.attempts = [{ outcome: 'kill' }];
  h.bots.get('oren7').turnedIn = new Map([[8153, t0 + 1000]]);
  for (const id of ['sable7', 'valen7', 'nova7', 'oren7']) h.raidDone(h.bots.get(id), { type: 'script', raid: r.id }, true);
  assert(h.settings.raids.done['ultra-warden'], `booked done: ${JSON.stringify(h.settings.raids)}`);
  assert(!(h.settings.raids.partial || {})['ultra-warden'], 'not a partial kill');
});

// 2026-10-26 (the owner: the new bots must not face what the first four already solved): a kill goes into the party's shared
// book, and a character with no win of its own starts with that set-up when it owns the class.
test('fight ladder: a boss the party beat with a class starts the next character on that class (shared book)', async () => {
  const first = ladderBot("King's Echo", { id: 'first-bot' });
  const ctx = { now: Date.now(), start: "King's Echo", slot: 'solo', owned: MAIN, wanted: null };
  fightplan.sharedBook()['Shared Test Boss'] = undefined;
  delete fightplan.sharedBook()['Shared Test Boss'];
  eq(fightplan.preFight(first, 'Shared Test Boss', 'k1', ctx), null, 'nothing known yet');
  // The first character wins with Void Highlord.
  first._fight = { key: 'k1', boss: 'Shared Test Boss', steps: [{ cls: 'Void Highlord', mode: 'Base' }], i: 0, deaths: [], lap: 1, laps: 1 };
  assert(fightplan.onKill(first, 'Shared Test Boss'), 'learned');
  const newbie = ladderBot("King's Echo", { id: 'newbie' });
  eq(fightplan.preFight(newbie, 'Shared Test Boss', 'k2', { ...ctx, owned: MAIN }), 'switch', 'newbie owns Void Highlord: starts with it');
  const poor = ladderBot('Mage', { id: 'poor' });
  eq(fightplan.preFight(poor, 'Shared Test Boss', 'k3', { ...ctx, start: 'Mage', owned: ['Mage'] }), null, 'a class it does not own is no hint');
});
