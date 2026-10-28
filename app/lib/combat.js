// Two engines. "adaptive" (default for the 230+ classes VibeSkua knows, see lib/adaptive.js): stance detection, emergency
// survival skills, aura/stack/duration-aware rules. "skua": Skill rotations from Skua's AdvancedSkills.json, evaluated the same way Skua does (Health / Mana / Aura / MultiAura /
// Wait rules), plus a mana-cost check so skills that can't be afforded are not spammed ("Not enough mana!").
const knowledge = require('./knowledge');
const adaptive = require('./adaptive');

const DEFAULT = { skillUseMode: 'UseIfAvailable', skills: [{ skillId: 1 }, { skillId: 2 }, { skillId: 3 }, { skillId: 4 }] };

class Combat {
  constructor(game) {
    this.game = game;   // { get, call }
    this.className = null;
    this.mode = 'Base';
    this.rot = DEFAULT;
    this.costs = {};
    this.index = 0;
    this.lastAttack = 0;
    this.engine = 'auto';          // auto | adaptive | skua
    this.routine = null;
    this.stance = new adaptive.Stance();
    this.pointer = 0;
    this.last = null;              // last decision, for the dashboard/journal: { skill, reason, stance }
  }

  async refresh(mode = this.mode) {
    const cls = await this.game.get('world.myAvatar.objData.strClassName').catch(() => null);
    if (cls === this.className && mode === this.mode) return;
    this.className = cls;
    this.mode = mode;
    this.rot = knowledge.rotation(cls, mode) || DEFAULT;
    this.routine = this.engine === 'skua' ? null : adaptive.routineFor(cls);
    this.pointer = 0;
    this.stance.reset();
    this.costs = {};
    for (let i = 1; i <= 5; i++) {
      this.costs[i] = await this.game.get(`world.actions.active.${i}.mp`).catch(() => 0) || 0;
    }
  }

  async stats() {
    const [hp, hpMax, mp, mpMax] = await Promise.all([
      this.game.get('world.myAvatar.dataLeaf.intHP'), this.game.get('world.myAvatar.dataLeaf.intHPMax'),
      this.game.get('world.myAvatar.dataLeaf.intMP'), this.game.get('world.myAvatar.dataLeaf.intMPMax'),
    ]).catch(() => [0, 1, 0, 1]);
    return { hp: hp || 0, hpMax: hpMax || 1, mp: mp || 0, mpMax: mpMax || 1 };
  }

  async auraStacks(target, name) {
    const subject = String(target || 'self').toLowerCase() === 'target' ? 'Target' : 'Self';
    const v = await this.game.call('GetAurasValue', subject, name).catch(() => 444);
    return typeof v === 'number' && v < 442 ? v : 0;
  }

  static compare(value, greater, limit) { return greater ? value >= limit : value <= limit; }

  // true = use, false = don't, null = skip this skill entirely this round
  async ruleOk(skill, st) {
    for (const r of skill.rules || []) {
      const greater = r.comparison === 'greater';
      let ok = true;
      switch (r.type) {
        case 'Health': ok = st.hp > 0 && Combat.compare(r.isPercentage ? Math.floor(st.hp / st.hpMax * 100) : st.hp, greater, r.value); break;
        case 'Mana': ok = Combat.compare(r.isPercentage ? Math.floor(st.mp / st.mpMax * 100) : st.mp, greater, r.value); break;
        case 'Aura': ok = Combat.compare(await this.auraStacks(r.auraTarget, r.auraName), greater, r.value || 0); break;
        case 'MultiAura': {
          // JSON form stores a single check like an Aura rule; a list form (checks) is also accepted
          const checks = r.multiAuraChecks || r.checks || [r];
          const results = [];
          for (const c of checks) results.push(Combat.compare(await this.auraStacks(c.auraTarget, c.auraName), (c.comparison || r.comparison) === 'greater', c.stackCount ?? c.value ?? 0));
          ok = (r.multiAuraOperator || r.operator) === 'Or' ? results.some(Boolean) : results.every(Boolean);
          break;
        }
        case 'Wait': await new Promise((res) => setTimeout(res, Math.min(r.timeout || r.value || 0, 3000))); break;
        default: break;
      }
      if (!ok) return r.shouldSkip ? null : false;
    }
    return true;
  }

  // Adaptive tick (VibeSkua engine): read HP/MP, target HP and both aura lists once, update stance, pick a skill.
  async adaptiveTick() {
    const g = this.game;
    const st = await this.stats();
    const hasTarget = (await g.call('isNull', 'world.myAvatar.target').catch(() => true)) !== true;
    let targetHp = -1; let targetHpMax = -1;
    if (hasTarget) {
      targetHp = Number(await g.get('world.myAvatar.target.dataLeaf.intHP').catch(() => -1)) || -1;
      targetHpMax = Number(await g.get('world.myAvatar.target.dataLeaf.intHPMax').catch(() => -1)) || -1;
    }
    this.stance.update({ alive: st.hp > 0, hp: st.hp, hpMax: st.hpMax, hasTarget, targetHp, targetHpMax });
    if (!hasTarget || st.hp <= 0) return false;
    const parse = (v) => { if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } } return v || []; };
    const self = adaptive.auraLookup(parse(await g.call('getSubjectAuras', 'Self').catch(() => [])));
    const target = adaptive.auraLookup(parse(await g.call('getSubjectAuras', 'Target').catch(() => [])));
    // Counter-attack mechanic (VibeSkua UltraBossHelper): while the boss has "Counter Attack", stop hitting it.
    if (target('Counter Attack')) {
      await g.call('callGameFunction', 'world.cancelAutoAttack').catch(() => null);
      await g.call('callGameFunction', 'world.cancelTarget').catch(() => null);
      this.holdUntil = Date.now() + 2500;
      this.last = { skill: -1, reason: 'counter attack - holding', stance: this.stance.mode };
      return false;
    }
    const ctx = {
      name: this.routine.name, H: st.hp / st.hpMax, M: st.mp / st.mpMax,
      def: this.stance.defensive, highDps: this.stance.highDps, evaluating: this.stance.mode === 'evaluating', self, target,
    };
    const readyCache = {};
    for (const k of this.routine.sequence) {
      readyCache[k] = (this.costs[k] || 0) <= st.mp && (await g.call('canUseSkill', k).catch(() => false)) === true;
    }
    const pick = adaptive.choose(this.routine, ctx, (k) => readyCache[k], this.pointer);
    this.pointer = pick.pointer;
    this.last = { skill: pick.skill, reason: pick.reason, stance: this.stance.mode };
    await g.call('useSkill', pick.skill).catch(() => null);
    return pick.skill !== 0;
  }

  holding() { return Date.now() < (this.holdUntil || 0); }

  // One combat tick: auto-attack is implicit once a target is set; cast the next usable rotation skill.
  async tick() {
    if (this.routine) return this.adaptiveTick();
    const skills = (this.rot && this.rot.skills) || DEFAULT.skills;
    if (!skills.length) return false;
    const st = await this.stats();
    const waitMode = this.rot.skillUseMode === 'WaitForCooldown';
    for (let n = 0; n < skills.length; n++) {
      const skill = skills[this.index % skills.length];
      const id = skill.skillId;
      const cost = this.costs[id] || 0;
      if (cost > st.mp) { this.index++; continue; }
      const verdict = await this.ruleOk(skill, st);
      if (verdict === null || verdict === false) { this.index++; continue; }
      const ready = (await this.game.call('canUseSkill', id).catch(() => false)) === true;
      if (!ready) {
        if (waitMode) return false;   // wait for this skill instead of skipping it
        this.index++;
        continue;
      }
      await this.game.call('useSkill', id).catch(() => null);
      this.index++;
      return true;
    }
    return false;
  }
}

module.exports = { Combat, DEFAULT };
