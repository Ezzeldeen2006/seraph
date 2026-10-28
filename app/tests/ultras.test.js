// SeraphUltras (2026-10-18): the noelrohi/Scripts Ultras v3 copy - installed into the library, raids pick the Comp that
// matches their seats and write the party layout, attempt reports are read, and Skua scripts can't enhance on the owner's
// account or in a raid.
const fs = require('fs');
const path = require('path');
const os = require('os');
const ultras = require('../lib/ultras');

test('ultras: install copies the vendored folder into the library and drops stale files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ultras-'));
  const src = path.join(tmp, 'src'); const lib = path.join(tmp, 'Scripts');
  fs.mkdirSync(path.join(src, 'IndividualUltras'), { recursive: true }); fs.mkdirSync(lib);
  fs.writeFileSync(path.join(src, 'IndividualUltras', 'a.cs'), 'A');
  eq(ultras.install(lib, src), 1);
  eq(ultras.install(lib, src), 0, 'nothing changed');
  fs.writeFileSync(path.join(lib, 'SeraphUltras', 'old.cs'), 'x');
  ultras.install(lib, src);
  assert(!fs.existsSync(path.join(lib, 'SeraphUltras', 'old.cs')), 'stale file gone');
  eq(fs.readFileSync(path.join(lib, 'SeraphUltras', 'IndividualUltras', 'a.cs'), 'utf8'), 'A');
});

test('ultras: the raid writes the layout and the Comp that matches the seats into DoAllUltras.cfg', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ultraopt-'));
  fs.writeFileSync(path.join(tmp, 'DoAllUltras.cfg'), 'Options:UltraEngineerLayout=old\nOptions:Other=1\n');
  const boss = { name: 'Ultra Engineer', script: 'SeraphUltras/IndividualUltras/3UltraEngineerv3.cs' };
  const comp = ultras.compFor(boss, ['Void Highlord', 'ArchPaladin', 'Lord of Order', 'StoneCrusher']);
  eq(comp, 'seraph-loo-sc-ap-vhl');
  eq(ultras.compFor(boss, ["King's Echo", 'ArchPaladin', 'Lord of Order', 'StoneCrusher']), 'seraph-loo-sc-ap-ke');
  eq(ultras.compFor({ name: 'Champion Drakath' }, ['ArchPaladin']), '', 'no Comps: default');
  ultras.setRaidOptions(tmp, boss, [{ user: 'Sable7', cls: 'Lord of Order' }, { user: 'Valen7', cls: 'Void Highlord' }], comp);
  const lines = fs.readFileSync(path.join(tmp, 'DoAllUltras.cfg'), 'utf8').trim().split('\n');
  assert(lines.includes('Options:Other=1'), 'other options kept');
  assert(lines.includes('Options:UltraEngineerLayout=Sable7=Lord of Order; Valen7=Void Highlord'));
  assert(lines.includes('Options:UltraEngineerComp=seraph-loo-sc-ap-vhl'));
  eq(lines.filter((l) => l.startsWith('Options:UltraEngineerLayout=')).length, 1);
});

test('ultras: an [UltraAttempt] line is read', () => {
  const a = ultras.attempt('[12:00:01] (End) [UltraAttempt] {"boss":"UltraEngineer","comp":"x","class":"StoneCrusher","role":"DroneKiller","outcome":"kill","bossHp":0,"bossMaxHp":1000000,"deaths":[{"atSec":12.5}]}');
  eq([a.boss, a.outcome, a.deaths[0].atSec], ['UltraEngineer', 'kill', 12.5]);
  eq(ultras.attempt('nothing here'), null);
});

test('ultras: a Skua script cannot enhance while the client blocks it; other packets pass', () => {
  const { SwfWorld } = require('../lib/skua/swfworld');
  const sent = []; const events = [];
  const client = { write: (s) => sent.push(s), emit: (e) => events.push(e), blockScriptEnhance: () => true, w: { myAvatar: { uid: 1, objData: {} } } };
  const swf = new SwfWorld(client);
  const sfc = swf.game.sfc;
  sfc.sendString('%xt%zm%enhanceItemShop%1%100%200%2142%');
  sfc.sendXtMessage('zm', 'enhanceItemLocal', [100, 200], 'str', 1);
  sfc.sendString('%xt%zm%moveToCell%1%Enter%Spawn%');
  eq(sent, ['%xt%zm%moveToCell%1%Enter%Spawn%']);
  eq(events.length, 2);
  client.blockScriptEnhance = () => false;
  sfc.sendString('%xt%zm%enhanceItemShop%1%100%200%2142%');
  eq(sent.length, 2, 'allowed when not blocked');
});

test('ultras: every boss runs from SeraphUltras and its option key matches the script', () => {
  const { BOSSES } = require('../lib/ultraready');
  for (const b of BOSSES) {
    assert(/^SeraphUltras\/IndividualUltras\//.test(b.script), b.id);
    const file = path.join(__dirname, '..', 'ultras', b.script);
    assert(fs.existsSync(file), `${b.script} vendored`);
    const src = fs.readFileSync(file, 'utf8');
    const key = ultras.optionKey(b);
    assert(src.includes(`"${key}"`), `${b.id}: option key ${key} in the script`);
    // The raid watch reads the boss HP by this name (King Drago was looked up as "Ultra Drago" until 2026-10-23).
    const m = /const string boss = "([^"]+)"/.exec(src);
    assert(m, `${b.id}: const string boss in the script`);
    eq(b.monster || b.name, m[1], `${b.id}: monster name`);
  }
});

test('ultras: a player who walks in later counts as in the room (World.manageAreaUser), lower case, once', () => {
  const { SwfWorld } = require('../lib/skua/swfworld');
  const client = { write: () => {}, w: { myAvatar: { uid: 1, objData: { strUsername: 'Sable7' } } } };
  const swf = new SwfWorld(client);
  swf.userTreeWrite('Valen7', { strFrame: 'Enter', strPad: 'Spawn' });
  swf.userTreeWrite('Valen7', { strFrame: 'r2' });
  swf.userTreeWrite('Nova7', { intHP: 100 });
  eq(swf.w.areaUsers, ['valen7'], 'only strFrame updates add a player');
});

test('ultras: a member back from a won fight whose turn-in was refused does not call the others off', () => {
  const { Hub } = require('../lib/hub');
  const calls = [];
  const self = { raid: { id: 'r1', name: 'Ultra Engineer', quest: 8154, started: 1, members: ['a', 'b', 'c', 'd'], back: {}, attempts: [] },
    info() {}, raidCallOff: (why) => calls.push(why), raidClose: (k) => calls.push(`close ${k}`) };
  self.raidAttempt = Hub.prototype.raidAttempt.bind(self);
  const bot = (id) => ({ id, account: { label: id }, turnedIn: new Map() });
  self.raidAttempt(bot('a'), { class: 'Lord of Order', outcome: 'kill', deaths: [] });
  Hub.prototype.raidDone.call(self, bot('a'), { raid: 'r1', type: 'script' }, true);
  eq(self.raid.back.a, 'kill (no turn-in)');
  eq(calls, [], 'no call-off while the others turn in');
  self.raid.attempts = [];
  self.raid.back = {};
  Hub.prototype.raidDone.call(self, bot('b'), { raid: 'r1', type: 'script' }, true);
  eq(calls.length, 1, 'no kill reported: called off as before');
});

// 2026-10-20 community research (vault STRATEGY/Research-2026-10-20 items 2, 3, 9).
test('ultras: Seraph fixes are in the vendored copy - KE CORVAK on 8 Residual Energy, Dage DPS seat without KE', () => {
  const { FIXES } = require('../tools/vendor-ultras');
  for (const [file, , to] of FIXES) {
    const text = fs.readFileSync(path.join(ultras.SRC, ...file.split('/')), 'utf8').replace(/\r\n/g, '\n');
    assert(text.includes(to), `${file} has the Seraph fix (run node tools/vendor-ultras.js --fixes)`);
  }
  const ready = require('../lib/ultraready');
  const dage = ready.BOSSES.find((b) => b.id === 'ultra-dage');
  assert(!dage.slots.flat().includes("King's Echo"), 'no King\'s Echo seat at Dage (1 star)');
  assert(dage.slots[3].includes('ArchFiend') && dage.slots[3].includes('Void Highlord'), 'AF / VHL take the DPS seat');
});

// 2026-10-24: Equalize hits the first player for <= 2,946 and +100 % per extra player (AQW Wiki); nobody in the party has
// v3's 5,100 HP, so nobody ever stepped in. One claimed player per Equalize instead.
test('ultras: Ultra Speaker sends exactly one player into each Equalize zone, from 3,200 HP', () => {
  const text = fs.readFileSync(path.join(ultras.SRC, 'IndividualUltras', '10UltraSpeakerv3.cs'), 'utf8');
  assert(!/health < 5100f/.test(text), "v3's 5,100 HP gate is gone");
  assert(/SeraphEqualizeMinHp = 3200f/.test(text));
  assert(/if \(!SeraphClaimEqualize\(\)\) \{ _movingToEqualize = false; return; \}[^\n]*\n\s*Bot\.Player\.WalkTo\(EqualizeX, EqualizeY\);/.test(text), 'the claim comes before the walk');
  assert(/now - at < 5000/.test(text) && /UpdateEntry\(path, "claim"/.test(text), 'a fresh claim of another player keeps the rest out');
  // The next Listen / Truth taunter keeps its global cooldown free (6 of 10 Power Splits healed the boss back otherwise).
  assert(/SeraphHoldForTaunt\(last\);/.test(text) && /\["TTL"\] = \('E', 3\.1\)/.test(text), 'taunt holds from the line cycle');
  for (const once of ['private const float SeraphEqualizeMinHp', 'private void SeraphHoldForTaunt', 'private static string _fbsMuteFile']) {
    eq(text.split(once).length - 1, 1, `${once} exactly once (fixes re-applied without doubling)`);
  }
  // The community sheet (Skardyy/Aqw-UltraSpeaker-Visualizer block.py) decides who takes each Truth / Listen.
  assert(/SeraphSheetNote\(line\);/.test(text), 'every line goes through the sheet');
  assert(/"TLT" : "LTTL"/.test(text) && /new\[\] \{ "AP", "SC", "SC" \} : new\[\] \{ "LR", "LR", "LOO", "LOO" \}/.test(text), 'the sheet blocks');
  // The sheet's taker takes its line; the others back it up, and out of step the backups decide (v3's "the AP takes
  // every Listen" stunned the AP before his own Truth and the untaunted burst wiped the party, 2026-10-24 15:39).
  assert(/if \(!sheet \|\| _sheetTaunter != SeraphSheetRole\(\)\)\s*\n\s*\{\s*\n\s*await SeraphBackupListenAsync\(listenTauntTurn, sheet\);/.test(text), 'Listen: the sheet, backups otherwise');
  assert(/if \(!sheet \|\| _sheetTaunter != SeraphSheetRole\(\) \|\| !SeraphCanTakeTruth\(SeraphTruthMinHp\)\)\s*\n\s*\{\s*\n\s*await SeraphBackupTruthAsync\(truthTauntTurn, sheet\);/.test(text), 'Truth: the sheet when it can take it safely, backups otherwise');
  assert(!/IsListenTaunter\(\)\)|truthTauntTurn % 3 == myIndex/.test(text), "v3's own taunt order is not used");
  assert(/!Engine\.HasAura\("Stasis", true\) && Engine\.GetAuraSecondsRemaining\("Magia Burn", true\) <= 1/.test(text), 'a Truth taker can press and has no Magia Burn at the burst');
  assert(/GetAuraSecondsRemaining\("Focus"\) >= 4\)\s*\n\s*return;/.test(text), 'a Truth backup stays out of a freshly taunted one');
  assert(/Engine\.HasAura\("Magia Burn", true\) \|\| Engine\.HasAura\("Sanctity", true\)\)/.test(text), 'nobody with Sanctity walks into Equalize (Shattered Heart)');
  assert(/new\[\] \{ "SC", "LR", "AP", "LOO" \}/.test(text), 'the zone order of the sheet');
  // A Listen its taunter misses (dead / stunned) is taken by the seat the block leaves free, if no Focus covers the burst.
  assert(/\(_sheetK - 1\) % 2 == 0 \? "LOO" : "SC"/.test(text) && /GetAuraSecondsRemaining\("Focus"\) >= 2\)\s*\n\s*return;/.test(text), 'backup seat and Focus check');
  assert(/me == "LR" && !SeraphVdkStunSafe\(0\)/.test(text), 'the VDK backs up a Listen only when its stun ends before the next Equalize');
  for (const once of ['private async Task SeraphBackupListenAsync', 'private async Task SeraphBackupTruthAsync', 'private async Task SeraphTauntNowAsync']) {
    eq(text.split(once).length - 1, 1, `${once} exactly once`);
  }
  const { applyFixes } = require('../tools/vendor-ultras');
  eq(applyFixes('IndividualUltras/10UltraSpeakerv3.cs', text), text, 're-applying the fixes changes nothing');
});

test('ultras: an attempt journal line carries haste, crit and dodge from the stat packets', () => {
  const { Bot } = require('../lib/bot');
  const b = Object.create(Bot.prototype);
  b.client = { w: { myAvatar: { dataLeaf: { sta: { $tha: 0.5, $tcr: 0.412, $tdo: 0.09, $ap: 3120.4, $sp: 2800 } } } } };
  const s = b.combatStats();
  eq([s.haste, s.crit, s.dodge], [0.5, 0.412, 0.09]);
  eq(Bot.statsText(s), 'haste 50% (cap), crit 41.2%, dodge 9%, AP 3120, SP 2800');
  b.client = { call: () => null };
  eq(b.combatStats(), null, 'no headless world: no stats');
});

// The owner 2026-10-20: no potions while a boss can be beaten without them; buy them after it beat the party 3x without.
test('ultras: potions per boss - off until 3 real fights are lost without them; the main drinks unless mainPotions is false', () => {
  const { Hub } = require('../lib/hub');
  const { P } = require('../lib/paths');
  const h = Object.create(Hub.prototype);
  h.settings = {}; h.infos = []; h.notes = [];
  h.info = (x) => h.infos.push(x); h.notify = (a) => h.notes.push(a);
  const boss = { id: 'ultra-nulgath', name: 'Ultra Nulgath' };
  const party = [{ id: 'a', account: { username: 'A' } }, { id: 'b', account: { username: 'B' } }];
  const realRoot = P.ROOT; const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pots-')); P.ROOT = tmp;
  try {
    const fight = (killed, extra = {}) => { const r = { boss: boss.id, name: boss.name, potions: h.raidPotionsWrite(boss, party), attempts: [{ outcome: 'wipe' }], ...extra }; h.raidPotionsLearn(r, killed); };
    eq(h.raidPotionsWrite(boss, party), false, 'a new boss starts without potions');
    eq(fs.readFileSync(path.join(tmp, 'raid-potions.txt'), 'utf8'), 'A=off\nB=off\n');
    fight(false); fight(false, { attempts: [] }); fight(false, { partial: { died: [] } }); fight(false);
    eq(h.raidPotionsOn(boss.id), false, 'a call-off before the fight or a partial kill is no verdict: 2 real losses');
    fight(false);
    eq(h.raidPotionsOn(boss.id), true, '3 real losses without potions -> potions on');
    assert(h.notes.some((n) => /potions from now on/.test(n)), 'the owner is told');
    const realGuest = Hub.isGuest; Hub.isGuest = (b) => b.id === 'b';
    // The owner 2026-10-22: "give my main potions" - his seat drinks (hub setting mainPotions false = off).
    try {
      h.raidPotionsWrite(boss, party);
      eq(fs.readFileSync(path.join(tmp, 'raid-potions.txt'), 'utf8'), 'A=on\nB=on\n', 'the main drinks too');
      h.settings.mainPotions = false;
      h.raidPotionsWrite(boss, party);
    } finally { Hub.isGuest = realGuest; delete h.settings.mainPotions; }
    eq(fs.readFileSync(path.join(tmp, 'raid-potions.txt'), 'utf8'), 'A=on\nB=off\n', 'mainPotions false: not the main');
    const g = { id: 'ultra-warden', name: 'Ultra Warden' };
    h.raidPotionsLearn({ boss: g.id, name: g.name, potions: false, attempts: [{}] }, true);
    for (let i = 0; i < 5; i++) h.raidPotionsLearn({ boss: g.id, name: g.name, potions: false, attempts: [{}] }, false);
    eq(h.raidPotionsOn(g.id), false, 'beaten once without potions: it stays without');
  } finally { P.ROOT = realRoot; }
});

test('ultras: Dage - Decay on "the power of the legion" (VDK at once, LoO scroll as backup); Nulgath - one Blade attacker with the main as LR (the owner 2026-10-24)', () => {
  const dage = fs.readFileSync(path.join(ultras.SRC, 'IndividualUltras', '9UltraDagev3.cs'), 'utf8');
  assert(/IndexOf\("power of the legion", StringComparison\.OrdinalIgnoreCase\) >= 0\)\s*\n\s*_ = SeraphLegionDecayAsync\(\);/.test(dage), 'the legion line casts Decay');
  assert(/Engine\.Cast\(vdk \? 4 : 5\);/.test(dage) && /if \(Engine\.HasAura\("Decay"\)\)\s*\n\s*break;/.test(dage), 'VDK skill 4 / LoO scroll until the boss shows Decay');
  eq(dage.split('private async Task SeraphLegionDecayAsync').length - 1, 1, 'once');
  const { applyFixes } = require('../tools/vendor-ultras');
  eq(applyFixes('IndividualUltras/9UltraDagev3.cs', dage), dage, 'idempotent');
  const comps = require('../lib/ultras-comps.json');
  for (const name of ['seraph-loo-lr-sc-af', 'seraph-loo-lr-sc-vhl']) {
    const c = comps.find((x) => x.name === name);
    eq(c.entries.map((e) => e.role).join(','), 'LeadTaunter,CueTaunter,NulgathAttacker,BladeAttacker', `${name}: two Nulgath taunters, one on the Blade until it dies`);
  }
});

test('ultras: Drago - LoO + StoneCrusher alternate on the Executioner, the LR seat keeps the Bowmaster taunted (2026-10-24)', () => {
  const t = fs.readFileSync(path.join(ultras.SRC, 'IndividualUltras', '7UltraDragov3.cs'), 'utf8');
  assert(/_ = SeraphBowTauntLoop\(rightSummon, _tauntCts\.Token\);/.test(t), 'LR seat on the Bowmaster');
  assert(/_role == "DPSAttackRightSummon1"\)\s*\n\s*\{[\s\S]{0,600}StartTauntLoop\(Bot, C, Engine, fightStartTime, 1,/.test(t), 'SC second Executioner taunter');
  assert(/if \(_role == "Taunter2AttackRightSummon2"\)\s*\n\s*targetLeftSummon = false;/.test(t), 'the LR seat never switches to the Executioner');
  const { applyFixes } = require('../tools/vendor-ultras');
  eq(applyFixes('IndividualUltras/7UltraDragov3.cs', t), t, 'idempotent');
});

test('ultras: Darkon - the LoO keeps Order (key 5) for the nuke at ~4.6 M HP (2026-10-24)', () => {
  const t = fs.readFileSync(path.join(ultras.SRC, 'IndividualUltras', '8UltraDarkonv3.cs'), 'utf8');
  assert(/if \(Bot\.Player\.CurrentClass\?\.Name == "Lord of Order"\)[^\n]*\n\s*SeraphHoldOrder\(boss\);/.test(t), 'held each tick');
  assert(/SeraphOrderAtHp = 4_650_000/.test(t) && /Engine\.LordOfOrderHoldsOrder = false;   \/\/ Seraph/.test(t), 'threshold and release at the end');
  const { applyFixes } = require('../tools/vendor-ultras');
  eq(applyFixes('IndividualUltras/8UltraDarkonv3.cs', t), t, 'idempotent');
});
