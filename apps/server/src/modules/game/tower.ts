import type { BeastMods } from './spiritBeasts';
import { elementFactor, enemyElement } from './elements';
import { beastDefend, freshBeastState } from './beastCombat';
import { REALMS } from './constants';
import type { EquipmentQuality } from './equipment';
import { ARENA_COMBAT_BONUS_BP_PER_LEVEL } from './realms';
import type { TechniqueModifiers } from './techniques';

/**
 * 镇妖塔（单人爬塔）——纯定义与纯计算（docs/镇妖塔开发计划.md）。
 *
 * 与 worldBoss.ts / journey.ts 同一做法：层数曲线、词缀、战斗模拟、奖励表都硬编码在这里，
 * 不进 game-config；本文件不读库、不取时间，随机源通过参数注入（测试按取用顺序注入固定序列）。
 *
 * 规则要点：
 * - 每个宗门独立爬塔，每次只能挑战「历史最高层 + 1」；固定 5 人出战。
 * - 打赢不扣次数，打输扣 1 次；每天 5 次失败机会（UTC+8 自然日）。打输没有其它惩罚。
 * - 每层强度按「该层的标准弟子」定：每 3 层对应一个境界小阶段（炼气一层 → 渡劫后期共 79 层），
 *   之后每层再 +2%；标准属性 / 装备 / 演武场随层数从「白板」平滑过渡到「一整套宝品 + 演武场 5 级」。
 * - 战斗当场算完：最多 10 回合，攻击 / 防御 / 身法 / 幸运 / 体魄各管一件事（见 simulateTowerBattle）。
 *
 * 金额一律是最小单位（1 展示单位 = 1000 最小单位）。
 */

/** 出战人数（固定）。 */
export const TOWER_PARTY_SIZE = 5;
/** 解锁需要的宗门等级。 */
export const TOWER_UNLOCK_SECT_LEVEL = 2;
/** 每天的失败机会（打赢不扣）。 */
export const TOWER_DAILY_FAILS = 5;
/** 每场战斗的回合上限：到了还没打死妖物算失败。 */
export const TOWER_MAX_ROUNDS = 10;
/** 排行榜显示多少名。 */
export const TOWER_LEADERBOARD_SIZE = 20;

/* ---------- 层数曲线 ---------- */

/** 每个境界小阶段占几层。 */
export const TOWER_FLOORS_PER_STAGE = 3;
/** 境界小阶段总数（9 境界 × 3 阶段 = 27）。 */
export const TOWER_TOP_TIER = REALMS.length * 3;
/** 标准境界到顶（渡劫后期）的那一层：1 + (27 − 1) × 3 = 79。 */
export const TOWER_TIER_CAP_FLOOR = 1 + (TOWER_TOP_TIER - 1) * TOWER_FLOORS_PER_STAGE;
/** 到顶之后每层的强度增长。 */
export const TOWER_OVER_CAP_GROWTH = 1.02;
/** 标准属性 / 装备 / 演武场从第 1 层过渡到满额所用的层数（第 80 层满额）。 */
export const TOWER_GEAR_RAMP_FLOORS = 79;
/** 标准属性：第 1 层 50（新弟子的平均值），满额时 +25（一整套装备的主副属性）。 */
export const TOWER_BASE_ATTR = 50;
export const TOWER_GEAR_ATTR = 25;
/** 标准装备战力加成（基点）：满额 = 三件宝品（700 × 3）。 */
export const TOWER_GEAR_POWER_BP = 2100;
/** 标准演武场等级：满额 5 级。 */
export const TOWER_ARENA_LEVEL = 5;

/* ---------- 战斗系数 ---------- */

/** 只为数字好看：伤害与血量都按同一比例放大（与讨伐相同）。 */
export const TOWER_DAMAGE_SCALE = 100;
/** 妖物血量 = 它 × 标准队伍战力（5 人）× 标准演武场加成。 */
export const TOWER_MONSTER_HP_FACTOR = 6.5;
/** 妖物每回合攻击 = 它 × 标准队伍战力 ×（100 + 标准防御）/ 100。 */
export const TOWER_MONSTER_ATTACK_FACTOR = 0.6;
/** 弟子血量 = 它 × 战力 ×（0.5 + 体魄 / 100）。 */
export const TOWER_DISCIPLE_HP_FACTOR = 4.5;
/** 首领层（每 10 层）：血量 ×1.15、攻击 ×1.1。 */
export const TOWER_BOSS_HP_MULTIPLIER = 1.15;
export const TOWER_BOSS_ATTACK_MULTIPLIER = 1.1;
/** 妖物状态：每场战斗随机一次，血量与攻击一起 ×(0.9~1.1) —— 实力接近时胜负有起伏，不是一刀切。 */
export const TOWER_MONSTER_VIGOR: readonly [number, number] = [0.9, 1.1];
/** 弟子出手伤害浮动 / 妖物出手伤害浮动。 */
export const TOWER_DISCIPLE_FLUCTUATION: readonly [number, number] = [0.8, 1.2];
export const TOWER_MONSTER_FLUCTUATION: readonly [number, number] = [0.9, 1.1];
/** 暴击：幸运 100 → 20%；暴击伤害 ×1.5（会心另加）。 */
export const TOWER_CRIT_RATE_MAX = 0.2;
export const TOWER_CRIT_MULTIPLIER = 1.5;
/** 攻击修正：0.75 + 0.25 × 攻击 / 标准属性（比值最多算到 2）。 */
export const TOWER_ATTACK_RATIO_CAP = 2;
/** 追击：身法每高出妖物 1 点 +0.5%，最高 30%。 */
export const TOWER_EXTRA_ACTION_PER_POINT = 0.005;
export const TOWER_EXTRA_ACTION_MAX = 0.3;

/* ---------- 词缀（每 5 层一个） ---------- */

export type TowerAffixId = 'ironWall' | 'gale' | 'poison' | 'aegis' | 'berserk';

export interface TowerAffixDef {
  id: TowerAffixId;
  name: string;
  /** 界面文案（一句话）。 */
  effect: string;
  /** 配队提示。 */
  tip: string;
  /** 前端「推荐排序属性」。 */
  sortAttribute: 'attack' | 'defense' | 'speed' | 'luck' | 'physique';
}

/** 铁壁：攻击低于标准属性的弟子伤害减半。 */
export const TOWER_IRON_WALL_PENALTY = 0.5;
/** 疾风：妖物身法 ×1.5。 */
export const TOWER_GALE_SPEED_MULTIPLIER = 1.5;
/** 剧毒：每回合开始队伍损失最大血量的 2.5%。 */
export const TOWER_POISON_RATE = 0.025;
/** 罡气：未暴击的伤害 ×0.75，暴击率翻倍。 */
export const TOWER_AEGIS_NORMAL_FACTOR = 0.75;
export const TOWER_AEGIS_CRIT_RATE_MULTIPLIER = 2;
/** 狂暴：妖物攻击 ×1.2。 */
export const TOWER_BERSERK_ATTACK_MULTIPLIER = 1.2;

/** 按 5、10、15… 层依次轮换（第 5 层铁壁、第 10 层疾风……）。 */
export const TOWER_AFFIXES: readonly TowerAffixDef[] = [
  { id: 'ironWall', name: '铁壁', effect: '攻击低于标准的弟子伤害减半', tip: '派攻击高的弟子', sortAttribute: 'attack' },
  { id: 'gale', name: '疾风', effect: '妖物身法 ×1.5', tip: '派身法高的弟子', sortAttribute: 'speed' },
  { id: 'poison', name: '剧毒', effect: '每回合开始损失 2.5% 最大血量', tip: '派体魄高的弟子', sortAttribute: 'physique' },
  { id: 'aegis', name: '罡气', effect: '未暴击的伤害 ×0.75，暴击率翻倍', tip: '派幸运高的弟子', sortAttribute: 'luck' },
  { id: 'berserk', name: '狂暴', effect: '妖物攻击 ×1.2', tip: '派防御高的弟子', sortAttribute: 'defense' },
];

/** 某层的词缀：5 的倍数才有，其余返回 null。 */
export function towerAffixOf(floor: number): TowerAffixDef | null {
  if (floor < 1 || floor % 5 !== 0) return null;
  return TOWER_AFFIXES[(floor / 5 - 1) % TOWER_AFFIXES.length]!;
}

/** 首领层：10 的倍数。 */
export function isTowerBossFloor(floor: number): boolean {
  return floor >= 1 && floor % 10 === 0;
}

/* ---------- 守关妖物（名字只是装饰，按层轮换） ---------- */

const MONSTER_NAMES: readonly string[] = [
  '山魈', '赤眼狼妖', '青鳞蟒', '骨翼蝠', '石甲蜥',
  '阴风鬼', '血纹豹', '毒瘴蛛', '铁羽鹫', '寒潭蛟',
];
const BOSS_NAMES: readonly string[] = [
  '镇塔妖将', '噬魂魔君', '焚天火鸦', '九首蛇王', '幽冥鬼帝',
];

/** 守关妖物名：首领层用首领名，其余按层轮换。 */
export function towerMonsterName(floor: number): string {
  if (isTowerBossFloor(floor)) {
    return BOSS_NAMES[(floor / 10 - 1) % BOSS_NAMES.length]!;
  }
  return MONSTER_NAMES[(floor - 1) % MONSTER_NAMES.length]!;
}

/* ---------- 标准弟子与妖物属性 ---------- */

/** 这一层对应的境界小阶段（可以是小数；到顶后每层再 ×1.02）。 */
export function towerFloorTier(floor: number): number {
  const f = Math.max(1, Math.floor(floor));
  if (f <= TOWER_TIER_CAP_FLOOR) return 1 + (f - 1) / TOWER_FLOORS_PER_STAGE;
  return TOWER_TOP_TIER * TOWER_OVER_CAP_GROWTH ** (f - TOWER_TIER_CAP_FLOOR);
}

/** 装备 / 演武场的过渡进度：第 1 层 0，第 80 层起 1。 */
function gearRamp(floor: number): number {
  return Math.min(1, Math.max(0, (Math.floor(floor) - 1) / TOWER_GEAR_RAMP_FLOORS));
}

/** 标准属性（攻击 / 防御 / 身法，取整）：50 → 75。 */
export function towerStandardAttr(floor: number): number {
  return Math.round(TOWER_BASE_ATTR + TOWER_GEAR_ATTR * gearRamp(floor));
}

/** 标准演武场加成：1 + 标准等级 × 10%（等级随层数从 0 过渡到 5，可以是小数）。 */
export function towerStandardArenaMultiplier(floor: number): number {
  return 1 + (TOWER_ARENA_LEVEL * gearRamp(floor) * ARENA_COMBAT_BONUS_BP_PER_LEVEL) / 10_000;
}

/**
 * 标准弟子战力：与 realms.ts 的 discipleCombatPower 同一口径 ——
 * 境界小阶段 × 10 ×（1 + 标准属性 / 100）×（1 + 标准装备战力加成）。
 */
export function towerStandardPower(floor: number): number {
  const attr = towerStandardAttr(floor);
  return (
    towerFloorTier(floor) * 10 * (1 + attr / 100) * (1 + (TOWER_GEAR_POWER_BP * gearRamp(floor)) / 10_000)
  );
}

export interface TowerMonster {
  floor: number;
  name: string;
  isBoss: boolean;
  affix: TowerAffixDef | null;
  /** 血量（已 × DAMAGE_SCALE）。 */
  hp: number;
  /** 每回合攻击（已 × DAMAGE_SCALE，未计防御减免）。 */
  attack: number;
  speed: number;
  /** 本层标准属性（铁壁的门槛，也给前端做参考）。 */
  standardAttr: number;
  /** 本层标准弟子战力（给前端做参考：5 名这个战力的弟子大约能过）。 */
  standardPower: number;
}

/** 某层的守关妖物。 */
export function towerMonsterOf(floor: number): TowerMonster {
  const f = Math.max(1, Math.floor(floor));
  const affix = towerAffixOf(f);
  const isBoss = isTowerBossFloor(f);
  const standardAttr = towerStandardAttr(f);
  const standardPower = towerStandardPower(f);
  const partyPower = standardPower * TOWER_PARTY_SIZE;
  const hp = Math.floor(
    partyPower *
      TOWER_MONSTER_HP_FACTOR *
      towerStandardArenaMultiplier(f) *
      (isBoss ? TOWER_BOSS_HP_MULTIPLIER : 1) *
      TOWER_DAMAGE_SCALE,
  );
  const attack = Math.floor(
    partyPower *
      TOWER_MONSTER_ATTACK_FACTOR *
      ((100 + standardAttr) / 100) *
      (isBoss ? TOWER_BOSS_ATTACK_MULTIPLIER : 1) *
      (affix?.id === 'berserk' ? TOWER_BERSERK_ATTACK_MULTIPLIER : 1) *
      TOWER_DAMAGE_SCALE,
  );
  const speed = Math.round(standardAttr * (affix?.id === 'gale' ? TOWER_GALE_SPEED_MULTIPLIER : 1));
  return {
    floor: f,
    name: towerMonsterName(f),
    isBoss,
    affix,
    hp: Math.max(1, hp),
    attack: Math.max(1, attack),
    speed,
    standardAttr,
    standardPower: Math.round(standardPower),
  };
}

/* ---------- 战斗模拟 ---------- */

export interface TowerFighter {
  beast?: BeastMods;
  id: string;
  name: string;
  /** 战力（计入装备与战意，即 gearedCombatPower）。 */
  power: number;
  /** 战斗属性（基础 + 装备）。 */
  attack: number;
  defense: number;
  speed: number;
  luck: number;
  physique: number;
  /** 会心：暴击时伤害额外加成（基点）。 */
  critBonusBp: number;
  /** 铁骨：受到伤害减免（基点）。 */
  damageReductionBp: number;
  /** 主修功法的战斗修正（techniques.ts）；没有主修为 undefined，走原有路径。 */
  technique?: TechniqueModifiers;
}

export interface TowerHit {
  discipleId: string;
  name: string;
  damage: number;
  crit: boolean;
  /** 身法追击（同一回合的第二次出手）。 */
  extra: boolean;
  /** 本次出手触发的功法标志效果标签（如 ['剑气']）；没有触发时不带这个字段。 */
  tags?: string[];
}

/** 血身回血记录（每回合结束，只有这回合真的回了血才有）。 */
export interface TowerHeal {
  discipleId: string;
  name: string;
  amount: number;
}

/** 结算摘要：每名触发过标志效果的弟子一条（bonusDamage 只统计标志效果额外带来的伤害，不含代价）。 */
export interface TowerTechniqueSummary {
  discipleId: string;
  name: string;
  techniqueId: string;
  techniqueName: string;
  /** 标志效果触发次数（金刚开场计 1 次）。 */
  triggers: number;
  bonusDamage: number;
  healed: number;
  /** 开场血量提升（金刚 / 百毒的体魄权重与血量倍率带来的增量）；没有为 0。 */
  hpBonus: number;
}

export interface TowerRound {
  round: number;
  /** 本回合队伍先手。 */
  teamFirst: boolean;
  /** 剧毒在回合开始时扣的血（没有为 0）。 */
  poisonDamage: number;
  hits: TowerHit[];
  /** 妖物这一回合打出的伤害（妖物先倒下则为 0）。 */
  monsterDamage: number;
  /** 回合结束时的妖物血量 / 队伍血量。 */
  monsterHp: number;
  teamHp: number;
  /** 血身：本回合结束时的回血记录；没有回血时不带这个字段。 */
  heals?: TowerHeal[];
}

export interface TowerBattleResult {
  won: boolean;
  /** 失败原因：wiped = 队伍血量打空；timeout = 回合用完。 */
  failReason: 'wiped' | 'timeout' | null;
  rounds: TowerRound[];
  /** 本场妖物血量（已乘妖物状态）。 */
  monsterMaxHp: number;
  teamMaxHp: number;
  /** 妖物状态（0.9~1.1）。 */
  vigor: number;
  /** 队伍平均身法 ≥ 妖物身法 → 每回合先手。 */
  teamFirst: boolean;
  /** 结算摘要（只有有弟子触发过功法标志效果时才有）。 */
  techniqueSummary?: TowerTechniqueSummary[];
}

function between(random: () => number, range: readonly [number, number]): number {
  return range[0] + random() * (range[1] - range[0]);
}

/**
 * 弟子血量 = 4.5 × 战力 ×（0.5 + 体魄 / 100）（已 × DAMAGE_SCALE）。
 * 功法修正：金刚改体魄权重（默认 1），百毒 / 太乙 / 背水改血量倍率（默认 1）；没有功法时与原公式完全一致。
 */
export function towerFighterHp(
  fighter: Pick<TowerFighter, 'power' | 'physique'> & { technique?: TechniqueModifiers; beast?: BeastMods },
): number {
  const tower = fighter.technique?.tower;
  const weight = tower?.physiqueWeight ?? 1;
  const multiplier = (tower?.hpMultiplier ?? 1)*(1+(fighter.beast?.hp??0));
  return Math.floor(
    TOWER_DISCIPLE_HP_FACTOR *
      Math.max(0, fighter.power) *
      (0.5 + (weight * Math.max(0, fighter.physique)) / 100) *
      TOWER_DAMAGE_SCALE *
      multiplier,
  );
}

/** 暴击率：幸运 / 100 × 20%（罡气 ×2），最高 100%。 */
export function towerCritRate(luck: number, affix: TowerAffixDef | null): number {
  const multiplier = affix?.id === 'aegis' ? TOWER_AEGIS_CRIT_RATE_MULTIPLIER : 1;
  return Math.min(1, (Math.max(0, luck) / 100) * TOWER_CRIT_RATE_MAX * multiplier);
}

/**
 * 追击概率：(身法 − 妖物身法) × 0.5%，夹在 0~上限（默认 30%）。
 * bonus 是功法的概率加成（鬼影 +10% × S，仍受上限约束）；没有功法时 bonus = 0。
 */
export function towerExtraActionChance(
  speed: number,
  monsterSpeed: number,
  max: number = TOWER_EXTRA_ACTION_MAX,
  bonus = 0,
): number {
  return Math.min(max, Math.max(0, (speed - monsterSpeed) * TOWER_EXTRA_ACTION_PER_POINT) + bonus);
}

/** 攻击修正：0.75 + 0.25 × min(上限, 攻击 / 标准属性)；上限默认 2（青锋 / 太乙的功法加成另算）。 */
export function towerAttackFactor(attack: number, standardAttr: number, cap: number = TOWER_ATTACK_RATIO_CAP): number {
  const ratio = standardAttr <= 0 ? 1 : Math.min(cap, Math.max(0, attack) / standardAttr);
  return 0.75 + 0.25 * ratio;
}

/** 防御减免后的承伤比例：100 / (100 + 队伍平均防御)。 */
export function towerDefenseFactor(avgDefense: number): number {
  return 100 / (100 + Math.max(0, avgDefense));
}

/**
 * 一场战斗（最多 10 回合，当场算完）。
 *
 * - 队伍血量 = Σ 弟子血量（共用一条血）；
 * - 先手：队伍平均身法 ≥ 妖物身法时，每回合弟子先出手；否则妖物先出手；
 * - 弟子按身法从高到低依次出手：伤害 = 战力 × 攻击修正 × 演武场加成 × 浮动 × 暴击；
 *   出手后按追击概率再出手一次（追击不再追击）；
 * - 妖物每回合出手一次：伤害 = 攻击 × 浮动 × 防御减免 ×（1 − 队伍平均铁骨减免）；
 * - 剧毒：每回合开始先扣血；
 * - 妖物状态：每场随机一次，血量与攻击一起 ×0.9~1.1；
 * - 妖物血量归零 → 胜；队伍血量归零 → 败（wiped）；10 回合打完妖物还活着 → 败（timeout）。
 *
 * 随机源取用顺序（测试依赖它）：整场先取一次「妖物状态」（血量与攻击 ×0.9~1.1）；之后每回合内按出手顺序，
 * 弟子每次出手依次取「浮动 → 暴击」，然后取一次「追击判定」，追击时再取「浮动 → 暴击」；
 * 妖物出手取一次「浮动」。
 */
export function simulateTowerBattle(input: {
  floor: number;
  fighters: readonly TowerFighter[];
  /** 本宗演武场等级。 */
  arenaLevel: number;
  random: () => number;
}): TowerBattleResult {
  const monster = towerMonsterOf(input.floor);
  const affix = monster.affix;
  const standardAttr = towerStandardAttr(input.floor);
  const arena = 1 + (Math.max(0, input.arenaLevel) * ARENA_COMBAT_BONUS_BP_PER_LEVEL) / 10_000;
  const count = Math.max(1, input.fighters.length);
  const avgSpeed = input.fighters.reduce((sum, f) => sum + f.speed, 0) / count;
  const avgDefense = input.fighters.reduce((sum, f) => sum + f.defense, 0) / count;
  const avgReduction =
    input.fighters.reduce((sum, f) => sum + Math.min(10_000, Math.max(0, f.damageReductionBp)), 0) / count / 10_000;
  // 流云：每名持有者让妖物对队伍的伤害 +10% ÷ 出战人数（没有流云时乘 1，结果不变）。
  const monsterDamageMultiplier =
    1 + input.fighters.reduce((sum, f) => sum + (f.technique?.tower.monsterDamageBonus ?? 0), 0) / count;
  // 百毒不侵：免除自己那一份剧毒的人数。
  const immuneCount = input.fighters.filter((f) => f.technique?.tower.poisonImmune === true || f.beast?.poisonImmune).length;
  const teamFirst = avgSpeed >= monster.speed;
  // 身法从高到低；同身法保持派出顺序（sort 稳定）。
  const order = [...input.fighters].sort((a, b) => b.speed - a.speed);

  // 妖物状态：整场一个随机数，血量与攻击一起浮动（取用顺序里的第一个随机数）。
  const vigor = between(input.random, TOWER_MONSTER_VIGOR);
  const monsterMaxHp = Math.max(1, Math.floor(monster.hp * vigor));
  const monsterAttack = monster.attack * vigor;
  const teamMaxHp = input.fighters.reduce((sum, f) => sum + towerFighterHp(f), 0);
  let teamHp = teamMaxHp;
  let monsterHp = monsterMaxHp;
  const rounds: TowerRound[] = [];

  // 功法结算摘要：只给有主修的弟子建条目；没有任何触发时结果里不带这个字段。
  const summary = new Map<string, TowerTechniqueSummary>();
  const summaryOf = (fighter: TowerFighter, technique: TechniqueModifiers): TowerTechniqueSummary => {
    const existing = summary.get(fighter.id);
    if (existing !== undefined) return existing;
    const created: TowerTechniqueSummary = {
      discipleId: fighter.id,
      name: fighter.name,
      techniqueId: technique.id,
      techniqueName: technique.name,
      triggers: 0,
      bonusDamage: 0,
      healed: 0,
      hpBonus: 0,
    };
    summary.set(fighter.id, created);
    return created;
  };
  // 开场血量提升：金刚（体魄权重）与百毒（血量倍率）带来的增量；金刚开场计一次触发。
  for (const fighter of input.fighters) {
    const technique = fighter.technique;
    if (technique === undefined) continue;
    const hpBonus = Math.max(
      0,
      towerFighterHp(fighter) - towerFighterHp({ power: fighter.power, physique: fighter.physique }),
    );
    const weightBonus = technique.tower.physiqueWeight > 1;
    if (weightBonus || hpBonus > 0) {
      const entry = summaryOf(fighter, technique);
      entry.hpBonus = hpBonus;
      if (weightBonus) entry.triggers += 1;
    }
  }

  const strikeCounts = new Map<string, number>();
  const beastStates=new Map(input.fighters.map(f=>[f.id,freshBeastState()]));
  /**
   * 一次出手。随机源取用顺序：浮动 → 暴击判定 →（剑气的触发判定，仅太乙）。
   * chainTag 非空时表示这是功法带来的连续追击（流云 / 鬼影），整次伤害记作功法的额外伤害。
   */
  const strike = (fighter: TowerFighter, extra: boolean, round: number, chainTag: string | null): TowerHit => {
    const technique = fighter.technique;
    const mods = technique?.tower;
    const index = strikeCounts.get(fighter.id) ?? 0;
    strikeCounts.set(fighter.id, index + 1);
    const fluctuation = between(input.random, TOWER_DISCIPLE_FLUCTUATION);
    const roll = input.random();
    const naturalRate = towerCritRate(fighter.luck, affix);
    // 天机：暴击率 ×(1 + S)；破甲：本场第一次出手必定暴击，暴击倍率替换为 ×(1 + 2S)。
    const boostedRate = mods === undefined ? naturalRate : Math.min(1, naturalRate * mods.critRateMultiplier);
    const forcedCrit = index===0 ? (mods?.firstStrikeCritMultiplier ?? (fighter.beast?.firstCrit ? TOWER_CRIT_MULTIPLIER : null)) : null;
    const crit = forcedCrit !== null || roll < boostedRate;
    const naturalCrit = roll < naturalRate;
    const lowHpActive = mods !== undefined && mods.lowHpThreshold > 0 && teamHp < teamMaxHp * mods.lowHpThreshold;
    const cap = TOWER_ATTACK_RATIO_CAP + (mods?.attackCapBonus ?? 0);
    /** 伤害（labels = true 时带上功法的增益；false 时只保留代价，用来算「标志效果额外带来的伤害」）。 */
    const damageOf = (isCrit: boolean, labels: boolean): number => {
      let multiplier = 1;
      if (isCrit) {
        multiplier =
          (labels && forcedCrit !== null ? forcedCrit : TOWER_CRIT_MULTIPLIER) + Math.max(0, fighter.critBonusBp) / 10_000;
        if (labels && mods !== undefined) multiplier += mods.critMultiplierBonus;
        if (labels) multiplier += fighter.beast?.crit ?? 0;
      }
      if (!isCrit && affix?.id === 'aegis') multiplier *= TOWER_AEGIS_NORMAL_FACTOR;
      if (affix?.id === 'ironWall' && fighter.attack < standardAttr) multiplier *= TOWER_IRON_WALL_PENALTY;
      if (mods !== undefined) {
        // 青锋：本场第一次出手的增益；破甲：之后每次出手的代价。
        if (index === 0) {
          if (labels) multiplier *= mods.firstStrikeMultiplier;
        } else {
          multiplier *= mods.laterStrikeMultiplier;
        }
        multiplier *= mods.strikeMultiplier;
        if (!isCrit) multiplier *= mods.nonCritMultiplier;
        // 九转：第 1 回合的代价；之后回合的增益。
        if (round === 1) {
          multiplier *= mods.round1Multiplier;
        } else if (labels) {
          multiplier *= 1 + mods.roundGrowth * (round - 1);
        }
        // 背水：队伍血量低于阈值时的增益。
        if (labels && lowHpActive) multiplier *= mods.lowHpMultiplier;
      }
      if(labels && fighter.beast) {
        if(index===0) multiplier*=1+fighter.beast.first;
        if(teamHp/teamMaxHp<.35) multiplier*=1+fighter.beast.low;
      }
      multiplier*=elementFactor(fighter.beast?.element,enemyElement(input.floor));
      return Math.floor(
        Math.max(0, fighter.power) *
          towerAttackFactor(fighter.attack, standardAttr, cap) *
          arena *
          fluctuation *
          multiplier *
          TOWER_DAMAGE_SCALE,
      );
    };

    let damage = damageOf(crit, true);
    const tags: string[] = [];
    const directDamage=damage;
    if(fighter.beast) {
      const factor=elementFactor(fighter.beast.element,enemyElement(input.floor));
      if(factor!==1)tags.push(factor>1?'五行克制 +15%':'五行受克 −15%');
      if((index===0&&(fighter.beast.first||fighter.beast.firstCrit))||(crit&&fighter.beast.crit)||(teamHp/teamMaxHp<.35&&fighter.beast.low))tags.push(fighter.beast.skillName);
    }
    if (technique !== undefined && mods !== undefined) {
      const labelTriggered =
        (index === 0 && (mods.firstStrikeMultiplier !== 1 || forcedCrit !== null)) ||
        (crit && crit !== naturalCrit) ||
        (crit && mods.critMultiplierBonus !== 0) ||
        (round >= 2 && mods.roundGrowth !== 0) ||
        lowHpActive;
      if (labelTriggered) {
        const entry = summaryOf(fighter, technique);
        entry.triggers += 1;
        entry.bonusDamage += damage - damageOf(naturalCrit, false);
        tags.push(technique.tag);
      }
      // 剑气：每次出手 25% 概率额外造成 50% × S 的伤害（触发率为开关型，不缩放）。
      if (mods.procChance > 0 && input.random() < mods.procChance) {
        const procExtra = Math.floor(damage * mods.procRatio);
        const entry = summaryOf(fighter, technique);
        entry.triggers += 1;
        entry.bonusDamage += procExtra;
        tags.push(technique.tag);
        damage += procExtra;
      }
    }
    if(fighter.beast?.procChance && input.random()<fighter.beast.procChance) {damage+=Math.floor(directDamage*fighter.beast.proc);tags.push(fighter.beast.skillName);}
    if (chainTag !== null && technique !== undefined) {
      const entry = summaryOf(fighter, technique);
      entry.triggers += 1;
      entry.bonusDamage += damage;
      tags.push(chainTag);
    }
    const hit: TowerHit = { discipleId: fighter.id, name: fighter.name, damage, crit, extra };
    if (tags.length > 0) hit.tags = tags;
    return hit;
  };

  /** 队伍出手：打死妖物返回 true。 */
  const teamActs = (hits: TowerHit[], round: number): boolean => {
    for (const fighter of order) {
      const first = strike(fighter, false, round, null);
      hits.push(first);
      monsterHp = Math.max(0, monsterHp - first.damage);
      if (monsterHp <= 0) return true;
      const technique = fighter.technique;
      if (technique === undefined && !fighter.beast) {
        if (input.random() < towerExtraActionChance(fighter.speed, monster.speed)) {
          const second = strike(fighter, true, round, null);
          hits.push(second);
          monsterHp = Math.max(0, monsterHp - second.damage);
          if (monsterHp <= 0) return true;
        }
        continue;
      }
      // 功法路径：流云可连续追击（最多 3 次）；鬼影第 1 回合的第一次追击必定发生（仍取一次随机数，保持取用顺序一致）。
      const mods = technique?.tower ?? {maxStrikesPerAction:2,extraChanceMax:TOWER_EXTRA_ACTION_MAX,round1GuaranteedExtra:false,extraChanceBonus:0};
      const maxStrikes = mods.maxStrikesPerAction ?? 2;
      const extraTag =
        mods.extraChanceMax !== undefined || mods.round1GuaranteedExtra || mods.extraChanceBonus > 0
          ? technique?.tag ?? null
          : null;
      // 不带功法时本来就有的追击概率（含灵兽游龙的加成）：落在这部分里的追击不记作功法的额外伤害。
      const baseChance = towerExtraActionChance(
        fighter.speed,
        monster.speed,
        Math.min(.85, TOWER_EXTRA_ACTION_MAX + (fighter.beast?.extraCap ?? 0)),
        fighter.beast?.extra ?? 0,
      );
      const chance = towerExtraActionChance(
        fighter.speed,
        monster.speed,
        Math.min(.85,(mods.extraChanceMax ?? TOWER_EXTRA_ACTION_MAX)+(fighter.beast?.extraCap??0)),
        mods.extraChanceBonus+(fighter.beast?.extra??0),
      );
      let done = 1;
      while (done < maxStrikes) {
        const roll = input.random();
        const guaranteed = done === 1 && mods.round1GuaranteedExtra && round === 1;
        if (!guaranteed && roll >= chance) break;
        // 第一次追击若在无功法时也会发生，不算功法的额外伤害；之后的连续追击都是功法带来的。
        const fromTechnique = done > 1 || !(roll < baseChance);
        const second = strike(fighter, true, round, extraTag !== null && fromTechnique ? extraTag : null);
        hits.push(second);
        monsterHp = Math.max(0, monsterHp - second.damage);
        if (monsterHp <= 0) return true;
        done += 1;
      }
    }
    return false;
  };

  /** 妖物出手：返回伤害。 */
  const monsterActs = (): number => {
    const fluctuation = between(input.random, TOWER_MONSTER_FLUCTUATION);
    let damage = Math.floor(
      monsterAttack * fluctuation * towerDefenseFactor(avgDefense) * (1 - avgReduction) * monsterDamageMultiplier,
    );
    if(input.fighters.some(f=>f.beast)) {
      let allocated=0, adjusted=0;
      input.fighters.forEach((f,index)=>{
        const hp=towerFighterHp(f),share=index===input.fighters.length-1?damage-allocated:Math.floor(damage*hp/teamMaxHp);allocated+=share;
        const elemental=Math.floor(share*elementFactor(enemyElement(input.floor),f.beast?.element));
        adjusted+=beastDefend(f.beast,beastStates.get(f.id)!,elemental,hp*teamHp/teamMaxHp,hp).damage;
      });
      damage=adjusted;
    }
    teamHp = Math.max(0, teamHp - damage);
    return damage;
  };

  /** 血身：回合结束时，每名持有者为队伍回复自身最大血量 × 4% × S（不超过队伍血量上限）。 */
  const healRound = (): TowerHeal[] => {
    const heals: TowerHeal[] = [];
    if(teamHp<=0)return heals;
    for(const f of input.fighters) {
      const amount=Math.min(teamMaxHp-teamHp,Math.floor(towerFighterHp(f)*(f.beast?.heal??0)));
      if(amount>0) {teamHp+=amount;heals.push({discipleId:f.id,name:f.name+'【'+f.beast!.skillName+'】',amount});}
    }
    for (const fighter of input.fighters) {
      const technique = fighter.technique;
      if (technique === undefined || technique.tower.healRatio <= 0) continue;
      const before = teamHp;
      teamHp = Math.min(teamMaxHp, teamHp + Math.floor(towerFighterHp(fighter) * technique.tower.healRatio));
      const amount = teamHp - before;
      if (amount <= 0) continue;
      const entry = summaryOf(fighter, technique);
      entry.triggers += 1;
      entry.healed += amount;
      heals.push({ discipleId: fighter.id, name: fighter.name, amount });
    }
    return heals;
  };

  const finish = (result: Omit<TowerBattleResult, 'techniqueSummary'>): TowerBattleResult => {
    const entries = [...summary.values()].filter(
      (item) => item.triggers > 0 || item.healed > 0 || item.hpBonus > 0,
    );
    return entries.length > 0 ? { ...result, techniqueSummary: entries } : result;
  };

  for (let round = 1; round <= TOWER_MAX_ROUNDS; round += 1) {
    const hits: TowerHit[] = [];
    let poisonDamage = 0;
    let monsterDamage = 0;
    const record = (heals?: TowerHeal[]): void => {
      const row: TowerRound = { round, teamFirst, poisonDamage, hits, monsterDamage, monsterHp, teamHp };
      if (heals !== undefined && heals.length > 0) row.heals = heals;
      rounds.push(row);
    };

    if (affix?.id === 'poison') {
      const poisonFull = Math.floor(teamMaxHp * TOWER_POISON_RATE);
      // 百毒不侵：持有者免除自己那一份（没有百毒时与原来一样）。
      const poisonShare = immuneCount === 0 ? poisonFull : Math.floor((poisonFull * (count - immuneCount)) / count);
      poisonDamage = Math.min(teamHp, poisonShare);
      if (immuneCount > 0 && poisonFull > 0) {
        for (const fighter of input.fighters) {
          const technique = fighter.technique;
          if (technique !== undefined && technique.tower.poisonImmune) summaryOf(fighter, technique).triggers += 1;
        }
      }
      teamHp -= poisonDamage;
      if (teamHp <= 0) {
        record();
        return finish({ won: false, failReason: 'wiped', rounds, monsterMaxHp, teamMaxHp, vigor, teamFirst });
      }
    }

    if (teamFirst) {
      if (teamActs(hits, round)) {
        record();
        return finish({ won: true, failReason: null, rounds, monsterMaxHp, teamMaxHp, vigor, teamFirst });
      }
      monsterDamage = monsterActs();
      if (teamHp <= 0) {
        record();
        return finish({ won: false, failReason: 'wiped', rounds, monsterMaxHp, teamMaxHp, vigor, teamFirst });
      }
    } else {
      monsterDamage = monsterActs();
      if (teamHp <= 0) {
        record();
        return finish({ won: false, failReason: 'wiped', rounds, monsterMaxHp, teamMaxHp, vigor, teamFirst });
      }
      if (teamActs(hits, round)) {
        record();
        return finish({ won: true, failReason: null, rounds, monsterMaxHp, teamMaxHp, vigor, teamFirst });
      }
    }
    record(healRound());
  }
  return finish({ won: false, failReason: 'timeout', rounds, monsterMaxHp, teamMaxHp, vigor, teamFirst });
}

/* ---------- 奖励 ---------- */

/** 玄铁、神木开始出现的层数（扫荡按最高层、首通按首领层，同一个门槛）。 */
export const TOWER_RARE_FLOOR = 30;

/**
 * 通关奖励（每层只有第一次打过才有 —— 每次挑战的都是「最高层 + 1」，所以每场胜利都是首通）：
 *   灵石 = 40 + 8 × 层（展示单位），药材 / 矿石各为灵石的一半（向下取整）；
 *   首领层（每 10 层）资源 ×3；第 30 层起的首领层另得 玄铁 / 神木 各「层 / 10」个。
 */
export function towerClearReward(floor: number): Record<string, number> {
  const f = Math.max(1, Math.floor(floor));
  const boss = isTowerBossFloor(f);
  const stone = (40 + 8 * f) * (boss ? 3 : 1);
  const rewards: Record<string, number> = {
    spiritStone: stone * 1000,
    herb: Math.floor(stone / 2) * 1000,
    ore: Math.floor(stone / 2) * 1000,
  };
  if (boss && f >= TOWER_RARE_FLOOR) {
    rewards.xuantie = (f / 10) * 1000;
    rewards.shenmu = (f / 10) * 1000;
  }
  return rewards;
}

/**
 * 每日扫荡（按历史最高层 M；M = 0 不能扫荡）：
 *   灵石 = 100 + 15 × M，药材 / 矿石 = 50 + 8 × M（展示单位）；
 *   M ≥ 30 起另得 玄铁 / 神木 各 1 + floor((M − 30) / 10) 个。
 */
export function towerSweepReward(maxFloor: number): Record<string, number> {
  const m = Math.max(0, Math.floor(maxFloor));
  if (m <= 0) return {};
  const rewards: Record<string, number> = {
    spiritStone: (100 + 15 * m) * 1000,
    herb: (50 + 8 * m) * 1000,
    ore: (50 + 8 * m) * 1000,
  };
  if (m >= TOWER_RARE_FLOOR) {
    const rare = 1 + Math.floor((m - TOWER_RARE_FLOOR) / 10);
    rewards.xuantie = rare * 1000;
    rewards.shenmu = rare * 1000;
  }
  return rewards;
}

/** 首通发装备的层间隔：每 30 层一件（都是首领层）。 */
export const TOWER_EQUIPMENT_FLOOR_STEP = 30;

/**
 * 首通装备：第 30 层灵品、第 60 层宝品、第 90 层起每 30 层仙品；其余层 null。
 * 部位随机、法器主属性随机（与讨伐掉落同一做法）；背包满时不许开打（service 在战斗前拦）。
 */
export function towerClearEquipment(floor: number): EquipmentQuality | null {
  const f = Math.floor(floor);
  if (f < TOWER_EQUIPMENT_FLOOR_STEP || f % TOWER_EQUIPMENT_FLOOR_STEP !== 0) return null;
  const tier = f / TOWER_EQUIPMENT_FLOOR_STEP;
  if (tier === 1) return 'spirit';
  if (tier === 2) return 'treasure';
  return 'immortal';
}

/** 今天已用的失败次数：记录的日期不是今天就是 0。 */
export function towerFailsToday(row: { fail_date_key: string | null; fail_count: number } | null, todayKey: string): number {
  if (row === null || row.fail_date_key !== todayKey) return 0;
  return Math.max(0, Number(row.fail_count));
}
