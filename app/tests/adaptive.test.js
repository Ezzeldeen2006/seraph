// Adaptive combat engine (port of VibeSkua's MasterSkillProvider).
const adaptive = require('../lib/adaptive');
const { Combat } = require('../lib/combat');

test('adaptive: stance starts defensive, burst damage locks defense, 7 s calm locks offense', async () => {
  const s = new adaptive.Stance();
  const base = { alive: true, hpMax: 1000, hasTarget: true, targetHpMax: 10000 };
  s.update({ ...base, hp: 1000, targetHp: 10000 }, 0);
  eq(s.mode, 'evaluating'); assert(s.defensive, 'defensive while evaluating');
  s.update({ ...base, hp: 950, targetHp: 9800 }, 3000);
  eq(s.mode, 'evaluating');
  s.update({ ...base, hp: 950, targetHp: 9700 }, 7100);
  eq(s.mode, 'offense', 'no burst for 7 s');
  const boss = new adaptive.Stance();
  boss.update({ ...base, hp: 1000, targetHp: 10000 }, 0);
  boss.update({ ...base, hp: 700, targetHp: 9900 }, 1000);
  eq(boss.mode, 'defense', '30% HP lost in one tick = high DPS boss');
  boss.update({ ...base, hp: 700, targetHp: 9900 }, 9000);
  eq(boss.mode, 'defense', 'stays locked');
  boss.update({ ...base, hp: 700, hasTarget: false, targetHp: -1 }, 9500);
  eq(boss.mode, 'evaluating', 'resets when the target is gone');
});

test('adaptive: aura lookup reads stacks and seconds remaining', async () => {
  const now = 1_000_000;
  const look = adaptive.auraLookup([{ nam: 'Doom', val: 12, dur: 10, ts: now - 4000 }, { nam: 'Shackled', dur: 0 }], now);
  eq(look('doom'), { value: 12, remaining: 6, category: '' });
  eq(look('Shackled').remaining, 999, 'no duration = permanent');
  eq(look('nothing'), null);
});

test('adaptive: routines know class mechanics (VDK doom stacks, emergency heals first)', async () => {
  const vdk = adaptive.routineFor('Verus DoomKnight');
  eq(vdk.sequence, [3, 4, 1, 2]);
  const ctx = (o) => ({ name: 'verus doomknight', H: 1, M: 1, def: false, highDps: false, evaluating: false, self: () => null, target: () => null, ...o });
  const doom = (v) => (n) => (n === 'Doom' ? { value: v, remaining: 99 } : null);
  eq(vdk.use(4, ctx({ self: doom(5) })), false, 'nuke waits for 10 Doom');
  eq(vdk.use(4, ctx({ self: doom(10) })), true);
  eq(vdk.use(1, ctx({})), true, 'Soul Fracture (1) every cycle, not only in Unleashed Doom (2026-10-20)');
  const all = () => true;
  eq(adaptive.choose(vdk, ctx({ H: 0.5, self: doom(0) }), all, 0).skill, 2, 'low HP -> emergency skill 2 first');
  const r = adaptive.choose(vdk, ctx({ H: 1, self: doom(0) }), all, 0);
  eq([r.skill, r.reason], [3, 'rotation']);
  eq(adaptive.choose(vdk, ctx({ self: doom(0) }), () => false, 0).skill, 0, 'nothing ready -> auto attack');
  assert(adaptive.routineFor('Healer') && adaptive.routineFor('Lord of Order') && adaptive.routineFor("King's Echo"), 'party classes covered');
  eq(adaptive.routineFor('Totally Made Up Class'), null, 'unknown class -> Skua rotation');
  assert(Object.keys(adaptive.SEQUENCES).length > 200, 'VibeSkua class table');
});

test('adaptive: combat tick casts the emergency heal on a low-HP Healer and keeps auto attack otherwise', async () => {
  const used = [];
  const state = { 'world.myAvatar.objData.strClassName': 'Healer', 'world.myAvatar.dataLeaf.intHP': 300, 'world.myAvatar.dataLeaf.intHPMax': 1000, 'world.myAvatar.dataLeaf.intMP': 100, 'world.myAvatar.dataLeaf.intMPMax': 100, 'world.myAvatar.target.dataLeaf.intHP': 500, 'world.myAvatar.target.dataLeaf.intHPMax': 500 };
  const game = {
    get: async (p) => (p.startsWith('world.actions.active') ? 0 : state[p]),
    call: async (fn, a) => { if (fn === 'useSkill') used.push(a); if (fn === 'isNull') return false; if (fn === 'getSubjectAuras') return '[]'; if (fn === 'canUseSkill') return a === 2 || a === 1; return true; },
  };
  const c = new Combat(game);
  await c.refresh('Base');
  assert(c.routine, 'Healer uses the adaptive engine');
  await c.tick();
  eq(used[0], 2, 'emergency: skill 2 at 30% HP');
  eq(c.last.reason, 'emergency');
  c.engine = 'skua'; c.className = null;
  await c.refresh('Base');
  eq(c.routine, null, 'engine switch to Skua rotations');
});

// 2026-10-20 community rules (vault STRATEGY/Research-2026-10-20 items 2 and 5).
test('adaptive: King\'s Echo CORVAKs on Residual Energy, shields when it hurts; LR reads real aura names', async () => {
  const ke = adaptive.routineFor("King's Echo");
  const ctx = (auras, o) => ({ name: "king's echo", H: 1, M: 1, def: false, highDps: false, evaluating: false, self: (n) => auras[n] || null, target: () => null, ...o });
  const re = (v) => ({ 'Residual Energy': { value: v, remaining: 8 } });
  eq(ke.use(4, ctx({}, { M: 0.5 })), false, 'half mana, no stacks: no CORVAK yet (the old rule fired at <= 60 %)');
  eq(ke.use(4, ctx(re(8), { M: 0.9 })), true, '8 stacks -> CORVAK');
  eq(ke.use(4, ctx(re(6), { M: 0.35 })), true, '6 stacks and mana under 40 % -> CORVAK');
  eq(ke.use(4, ctx(re(6), { M: 0.6 })), false, '6 stacks, mana left: keep stacking');
  eq(ke.use(4, ctx({}, { M: 0.15 })), true, 'dry: CORVAK refills mana');
  eq(ke.use(3, ctx({}, { H: 0.9 })), false, 'healthy: no Shield');
  eq(adaptive.choose(ke, ctx({}, { H: 0.3 }), () => true, 0).skill, 3, 'low HP -> Shield first');
  const lr = adaptive.routineFor('Legion Revenant');
  const lctx = (auras, o) => ({ name: 'legion revenant', H: 1, M: 1, def: false, highDps: false, evaluating: false, self: (n) => auras[n] || null, target: () => null, ...o });
  eq(lr.use(2, lctx({ Enveloped: { value: 5, remaining: 9 } })), false, 'Enveloped at 5 stacks: Wicked Purgatory waits');
  eq(lr.use(2, lctx({ Enveloped: { value: 3, remaining: 9 } })), true, 'Enveloped under 5: build it');
  eq(lr.use(2, lctx({ Enveloped: { value: 5, remaining: 2 } })), true, 'about to fade: refresh');
  eq([lr.use(1, lctx({})), lr.use(3, lctx({})), lr.use(4, lctx({}))], [true, true, true], 'Decay, Empowerment, Anathema whenever ready');
});

test('adaptive: Arcana Invoker keeps The World to the end and never resets the cycle early', async () => {
  const ai = adaptive.routineFor('Arcana Invoker');
  const ctx = (auras, o) => ({ name: 'arcana invoker', H: 1, M: 1, def: false, highDps: false, evaluating: false, self: (n) => auras[n] || null, target: () => null, ...o });
  const all = () => true;
  const pick = (auras, o) => adaptive.choose(ai, ctx(auras, o), all, 0).skill;
  eq(pick({}), 1, 'no cycle -> The Beginning and the End starts it');
  eq(pick({ '0 - The Fool': { value: 1, remaining: 90 } }), 2, 'Fool phase: Invocation, never 1 (it would reset the cycle)');
  eq(pick({ '0 - The Fool': { value: 1, remaining: 60 }, 'XX - Judgement': { value: 1, remaining: 29 } }), 1, 'Judgement -> 1 opens The World');
  eq(pick({ 'XXI - The World': { value: 4, remaining: 60 }, 'XX - Judgement': { value: 1, remaining: 20 } }), 4, 'The World: One With the Cycle first, 1 held');
  eq(pick({ 'XXI - The World': { value: 4, remaining: 3 } }), 1, 'The World about to end -> cash out');
  eq(pick({ '0 - The Fool': { value: 1, remaining: 90 } }, { H: 0.2, def: true }), 2, 'no emergency skill: low HP does not fire 1');
  eq(adaptive.choose(ai, ctx({ 'XXI - The World': { value: 4, remaining: 60 } }), (k) => k === 3, 0).skill, 3, 'Revocation when the others are cooling down');
});
