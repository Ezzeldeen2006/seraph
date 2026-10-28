const { translate, literal, splitArgs, handle } = require('../lib/skua/translate');
const knowledge = require('../lib/knowledge');
const { Combat } = require('../lib/combat');
const util = require('../lib/util');
const accounts = require('../lib/accounts');
const { P } = require('../lib/paths');
const fs = require('fs');
const path = require('path');

// ---------- translator ----------
test('translate: C# literals and argument splitting', async () => {
  eq(literal('"Pure Darkness"'), 'Pure Darkness');
  eq(literal('42'), 42);
  eq(literal('new[] { 1, 2 }'), [1, 2]);
  eq(splitArgs('"a, b", 3, new[] { 4, 5 }'), ['"a, b"', '3', 'new[] { 4, 5 }']);
  const s = handle('KillMonster', '"oaklore", "r3", "Left", "Bone Berserker", "Bone", 5, isTemp: false')[0];
  eq([s.kind, s.map, s.cell, s.monsters[0], s.item, s.qty, s.temp], ['hunt', 'oaklore', 'r3', 'Bone Berserker', 'Bone', 5, false]);
});

test('translate: real Cleric story script -> quest chain steps', async () => {
  const r = translate(P.SCRIPTS, 'Story/Cleric.cs');
  assert(r.steps.length > 20, `only ${r.steps.length} steps`);
  assert(r.steps.some((s) => s.kind === 'accept' && s.quest === 2288), 'accept 2288');
  assert(r.steps.some((s) => s.kind === 'hunt' && s.map === 'lair' && s.item === 'Pure Darkness'), 'hunt Pure Darkness in lair');
  assert(!r.steps.some((s) => s.map && !/^[a-z0-9_-]+$/.test(s.map)), 'no garbage map names');
});

test('translate: LegacyQuestManager scripts accept each quest before hunting its items', async () => {
  const r = translate(P.SCRIPTS, 'Seasonal/TalkLikeaPirateDay/BlazeBeardStory.cs');
  const i = r.steps.findIndex((s) => s.kind === 'hunt' && s.item === 'Dwakel Scrap Metal');
  assert(i > 0, 'hunt Dwakel Scrap Metal');
  eq([r.steps[i - 1].kind, r.steps[i - 1].quest, r.steps[i].quest, r.steps[i + 1].kind, r.steps[i + 1].quest], ['accept', 4513, 4513, 'turnin', 4513], 'script says case 4514, but quest 4513 "Scrap Metal" is the one needing it');
  eq(r.steps.filter((s) => s.kind === 'hunt' && s.item === 'Dwakel Scrap Metal').length, 1, 'the logic function is not walked twice');
  eq(r.steps.filter((s) => s.kind === 'accept').length, 15, 'all 15 quests');
  // Core.FromTo ranges and several local QuestLogic functions in one script
  const b = translate(P.SCRIPTS, 'Story/QueenofMonsters/Extra/BrightOak.cs');
  const a = b.steps.findIndex((s) => s.kind === 'accept' && s.quest === 4801);
  eq([b.steps[a + 1].kind, b.steps[a + 1].quest, b.steps[a + 1].item], ['hunt', 4801, "Lapis' Runestones"], 'FromTo(4799, 4803) expanded');
  const c = b.steps.findIndex((s) => s.kind === 'accept' && s.quest === 4805);
  eq([b.steps[c + 1].quest, b.steps[c + 1].item], [4805, 'Wolfwood Twigs'], 'second local QuestLogic used for FromTo(4805, 4807)');
});

// ---------- knowledge ----------
test('knowledge: generates enhancement, daily and event tables from the scripts repo', async () => {
  const res = knowledge.generate();
  eq(res, { enhancements: 'ok', dailies: 'ok', events: 'ok' });
  const e = knowledge.enh();
  assert(Object.keys(e.forge).length > 150, 'forge classes');
  assert(e.unlocks.Awe === 2937, 'Awe unlock quest');
  assert(e.forge['verus doomknight'].requires.includes('Ravenous'), 'VDK requires Ravenous');
});

test('knowledge: enhancement plan picks the best unlocked specials', async () => {
  const none = knowledge.enhancementPlan('Verus DoomKnight', new Set(), 90);
  eq([none.type, none.weapon], ['Lucky', null], 'no unlocks -> basic Lucky');
  const awe = knowledge.enhancementPlan('Verus DoomKnight', new Set(['Awe']), 90);
  eq(awe.weapon, 'Spiral_Carve', 'Awe unlocked -> Spiral Carve');
  const all = knowledge.enhancementPlan('Verus DoomKnight', new Set(['Awe', 'Ravenous', 'ForgeHelm', 'Vainglory', 'Dauntless', 'Anima']), 100);
  eq([all.weapon, all.cape, all.helm], ['Dauntless', 'Vainglory', 'Anima']);
  eq(knowledge.enhancementPlan('Totally Unknown Mage', new Set(), 10).type, 'Wizard', 'guess by name');
});

test('knowledge: dailies know member-only and runnable F2P ones', async () => {
  const d = knowledge.dailies();
  const boost = d.find((x) => x.name === 'FreeDailyBoost');
  assert(boost && boost.memberOnly && !boost.runnable, 'Free Daily Boost is member only');
  assert(d.filter((x) => x.runnable).length >= 5, 'several runnable dailies');
  const elders = d.find((x) => x.name === 'EldersBlood');
  assert(elders && elders.steps.some((s) => s.kind === 'hunt' && s.map === 'arcangrove'), 'Elders Blood hunts in arcangrove');
});

test('knowledge: September event candidates include Talk Like a Pirate Day', async () => {
  const c = knowledge.eventCandidates(new Date('2026-09-17T12:00:00Z')).map((x) => x.folder);
  assert(c.includes('TalkLikeaPirateDay'), c.join(','));
  assert(!c.includes('Frostvale'), 'no Frostval in September');
  assert(knowledge.eventCandidates(new Date('2026-12-10T12:00:00Z')).some((x) => x.folder === 'Frostvale'), 'Frostval in December');
});

test('knowledge: class rotations and quest database', async () => {
  const rot = knowledge.rotation('Healer');
  assert(rot && rot.skills.length >= 4, 'Healer rotation');
  eq(knowledge.quest(4007).Name, 'Quest to Slay Bone Berserker');
  assert(knowledge.junk().has('a fish'), 'junk list parsed');
});

// ---------- combat ----------
test('combat: rules (health/mana) and mana-cost skip', async () => {
  const calls = [];
  const state = { 'world.myAvatar.objData.strClassName': 'Healer', 'world.myAvatar.dataLeaf.intHP': 900, 'world.myAvatar.dataLeaf.intHPMax': 1000, 'world.myAvatar.dataLeaf.intMP': 30, 'world.myAvatar.dataLeaf.intMPMax': 100, 'world.actions.active.1.mp': 0, 'world.actions.active.2.mp': 20, 'world.actions.active.3.mp': 50, 'world.actions.active.4.mp': 0, 'world.actions.active.5.mp': 0 };
  const c = new Combat({ get: async (p) => state[p], call: async (fn, id) => { calls.push([fn, id]); return fn === 'canUseSkill' ? true : fn === 'GetAurasValue' ? 444 : true; } });
  c.rot = { skillUseMode: 'UseIfAvailable', skills: [{ skillId: 3 }, { skillId: 2, rules: [{ type: 'Health', value: 50, comparison: 'less', isPercentage: true }] }, { skillId: 1 }] };
  c.costs = { 1: 0, 2: 20, 3: 50 };
  const cast = await c.tick();
  assert(cast, 'cast something');
  const used = calls.filter((x) => x[0] === 'useSkill').map((x) => x[1]);
  eq(used, [1], 'skill 3 skipped (mana), skill 2 skipped (HP rule), skill 1 used');
});

// ---------- util / accounts ----------
test('util: server day uses US Eastern time', async () => {
  eq(util.serverDay(new Date('2026-09-17T03:30:00Z')), '2026-09-16', 'before midnight ET');
  eq(util.serverDay(new Date('2026-09-17T04:30:00Z')), '2026-09-17', 'after midnight ET');
});

test('accounts: add, read credentials, update, remove (test root only)', async () => {
  fs.mkdirSync(P.ROOT, { recursive: true });
  const acc = accounts.add({ username: 'TestHero', password: 's3cret!', owner: 'chatgpt', email: 'x@y.z' });
  eq(acc.id, 'testhero');
  assert(acc.loginFile.startsWith(P.ROOT), 'login file inside test root');
  eq(accounts.credentials(acc), { user: 'TestHero', pass: 's3cret!' });
  accounts.update('testhero', { label: 'GPT Hero', autostart: true });
  eq(accounts.load().accounts.find((a) => a.id === 'testhero').label, 'GPT Hero');
  let dup = false; try { accounts.add({ username: 'TestHero', password: 'x' }); } catch { dup = true; }
  assert(dup, 'duplicate rejected');
  accounts.remove('testhero');
  assert(!accounts.load().accounts.find((a) => a.id === 'testhero'), 'removed');
});

test('schedule: days and weeks follow the AQW server clock (midnight US Eastern, weeklies on Friday)', () => {
  const { periodKey } = require('../lib/schedule');
  const k = (e, t) => periodKey(e, new Date(t));
  eq(k('day', '2026-09-23T00:06:00Z'), '2026-09-22', 'before the 04:00 UTC reset it is still yesterday');
  eq(k('day', '2026-09-23T04:01:00Z'), '2026-09-23', 'after the reset');
  eq(k('day', '2026-12-05T04:30:00Z'), '2026-12-04', 'winter reset is 05:00 UTC');
  eq(k('week', '2026-09-25T03:59:00Z'), 'w2026-09-18', 'Thursday night is last week');
  eq(k('week', '2026-09-25T04:01:00Z'), 'w2026-09-25', 'Friday morning starts a new week');
  eq(k('month', '2026-10-01T02:00:00Z'), '2026-9', 'the month turns at server midnight');
});

test('daily reset: each character logs out and back in once after the reset, one per tick, never mid-raid', () => {
  const { Hub } = require('../lib/hub');
  const mk = () => ({ _loginDay: '2026-09-23', state: { loaded: true }, calls: 0, call(fn) { if (fn === 'sfc.disconnect') this.calls++; return true; } });
  const ids = ['sable7', 'valen7', 'nova7', 'oren7'];
  const clients = new Map(ids.map((id) => [id, mk()]));
  const hub = Object.assign(Object.create(Hub.prototype), { headless: true, clients, bots: new Map(), info() {}, raid: null });
  const at = (t) => hub.resetRelogTick(Date.parse(t));
  eq(at('2026-09-24T03:59:00Z'), null, 'before the reset (midnight Eastern = 04:00 UTC)');
  eq(at('2026-09-24T04:01:00Z'), null, 'waits 2 min past the reset');
  clients.get('oren7')._loginDay = '2026-09-24';                     // reconnected after the reset: already fresh
  hub.raid = { members: ['valen7'] };
  eq(at('2026-09-24T04:03:00Z'), 'sable7', 'first character');
  eq(at('2026-09-24T04:04:00Z'), 'nova7', 'one per tick; the raid member waits');
  eq(at('2026-09-24T04:05:00Z'), null, 'Oren was fresh, Valen is raiding');
  hub.raid = null;
  eq(at('2026-09-24T06:00:00Z'), 'valen7', 'after the raid');
  eq(at('2026-09-24T12:00:00Z'), null, 'once a day');
  eq(ids.map((id) => clients.get(id).calls), [1, 1, 1, 0]);
});

test('skills: tested rotations are laid over the community file into UserAdvancedSkills.json (Skua loads that one)', () => {
  const fs = require('fs'); const path = require('path'); const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skua-'));
  fs.writeFileSync(path.join(dir, 'AdvancedSkills.json'), JSON.stringify({
    'Void Highlord': { Atk: { skillUseMode: 'WaitForCooldown', skills: [{ skillId: 3 }] }, Def: { skillUseMode: 'UseIfAvailable', skills: [{ skillId: 1 }] } },
    'Legion Revenant': { Base: { skillUseMode: 'UseIfAvailable', skills: [{ skillId: 3 }] } },
  }));
  require('../lib/skua/engine').writeUserSkills(dir);
  const u = JSON.parse(fs.readFileSync(path.join(dir, 'UserAdvancedSkills.json'), 'utf8'));
  eq(u['Void Highlord'].Atk.skillUseMode, 'UseIfAvailable', 'tested VHL Atk replaces the strict order');
  // 2026-10-16: no Shackle in the easy mode any more (it flipped Shackle <-> Unshackle for 20% HP each loop).
  eq(u['Void Highlord'].Atk.skills.map((s) => s.skillId), [4, 2, 3, 2]);
  assert(u['Void Highlord'].Atk.skills[2].rules[0].type === 'Health', 'Unshackle keeps its HP guard');
  assert(u['Void Highlord'].Solo, 'careful mode added for the class ladder');
  eq(u['Void Highlord'].Def.skills[0].skillId, 1, 'modes without a tested override stay as the community wrote them');
  eq(u['Legion Revenant'].Base.skills[0].skillId, 3, 'classes without overrides untouched');
  assert(u.ArchPaladin && u.ArchPaladin.Base.skillUseMode === 'UseIfAvailable', 'AP Base added');
});
