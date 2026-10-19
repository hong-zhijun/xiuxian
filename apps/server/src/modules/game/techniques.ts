/**
 * 功法（docs/功法开发计划.md）——纯定义与纯计算。
 *
 * 与 talents.ts / equipment.ts 同一做法：定义与公式硬编码在游戏模块里，不进 game-config，
 * 不读库、不取时间；随机源通过参数注入。
 *
 * 归属与规则要点：
 * - 功法归宗门：收录 / 参悟只做一次，修习同一功法的弟子共享等级；每名弟子一个「主修」槽。
 * - 熟练度：主修后随时间从 0 涨到 100%（48 小时），换功法减半，卸下清零；读时现算，不需要定时任务。
 * - 效果强度：增益实际值 = 基础值 × 参悟系数 × 熟练度系数（超出 1 的部分才缩放，见 scaleOf）；
 *   代价不随等级与熟练度变化；开关型效果（必定 / 免疫）不缩放。
 *
 * 金额一律是最小单位（1 展示单位 = 1000 最小单位）：参悟灵石 50,000 × 当前等级 = 展示 50 × 当前等级。
 */

/* ---------- 品阶 / 流派 ---------- */

export type TechniqueTier = 'xuan' | 'di' | 'tian';
export const TECHNIQUE_TIER_NAMES: Readonly<Record<TechniqueTier, string>> = {
  xuan: '玄阶',
  di: '地阶',
  tian: '天阶',
};

export type TechniqueSchool = 'sword' | 'body' | 'agile' | 'crit' | 'late';
export const TECHNIQUE_SCHOOLS: readonly { id: TechniqueSchool; name: string }[] = [
  { id: 'sword', name: '剑修' },
  { id: 'body', name: '体修' },
  { id: 'agile', name: '身法' },
  { id: 'crit', name: '暴击' },
  { id: 'late', name: '后劲' },
];

/* ---------- 收录 / 参悟 / 熟练度 常量 ---------- */

/** 参悟最高等级（收录后为 1 级）。 */
export const TECHNIQUE_MAX_LEVEL = 10;
/** 参悟系数每级 +8%：1 + 0.08 × (等级 − 1)。 */
export const TECHNIQUE_LEVEL_STEP = 0.08;
/** 熟练度系数 = 0.6 + 0.4 × 熟练度（0% 为 0.6，满熟练为 1.0）。 */
export const TECHNIQUE_PROFICIENCY_FLOOR = 0.6;
/** 熟练度满值（基点）：10000 = 100%。 */
export const TECHNIQUE_PROFICIENCY_FULL_BP = 10_000;
/** 从 0 涨到 100% 所需的时长。 */
export const TECHNIQUE_PROFICIENCY_FULL_MS = 48 * 3_600_000;
/** 换功法后保留的熟练度比例（减半）。 */
export const TECHNIQUE_SWITCH_KEEP_RATIO = 0.5;

/** 收录所需残卷（按品阶）。 */
export const TECHNIQUE_LEARN_SCROLLS: Readonly<Record<TechniqueTier, number>> = { xuan: 10, di: 20, tian: 40 };
/** 参悟每级所需残卷（按品阶）。 */
export const TECHNIQUE_LEVEL_SCROLLS: Readonly<Record<TechniqueTier, number>> = { xuan: 5, di: 8, tian: 12 };
/** 参悟每级所需灵石 = 本值 × 当前等级（最小单位）。 */
export const TECHNIQUE_LEVEL_STONE_UNIT: Readonly<Record<TechniqueTier, number>> = {
  xuan: 50_000,
  di: 150_000,
  tian: 400_000,
};

/** 残卷物品 id 前缀（云游商人拍卖的 kind: 'resource' 货品用它区分于玄铁 / 神木）。 */
export const TECHNIQUE_SCROLL_ITEM_PREFIX = 'techniqueScroll:';

/* ---------- 功法定义 ---------- */

export interface TechniqueDef {
  id: string;
  name: string;
  school: TechniqueSchool;
  tier: TechniqueTier;
  /** 战报标签（【青锋】）。 */
  tag: string;
  /** 一句话简介（藏经阁列表用，≤ 16 字）。 */
  summary: string;
  /** 镇妖塔增益文案（展示用，数值与 techniqueModifiersOf 同步）。 */
  towerGain: string;
  /** 代价文案（始终按基础值生效）；无代价为「无」。 */
  cost: string;
  /** 世界 Boss 增益文案。 */
  bossGain: string;
}

export const TECHNIQUES: readonly TechniqueDef[] = [
  {
    id: 'qingfeng', name: '青锋剑诀', school: 'sword', tier: 'xuan', tag: '青锋', summary: '首击爆发的入门剑诀',
    towerGain: '【青锋】本场第一次出手伤害 ×1.5；攻击修正比上限 +0.5',
    cost: '无', bossGain: '伤害 +6%',
  },
  {
    id: 'taiyi', name: '太乙剑诀', school: 'sword', tier: 'di', tag: '剑气', summary: '剑气纵横，高攻薄血',
    towerGain: '【剑气】每次出手 25% 概率额外造成 50% 伤害；攻击修正比上限 +1.2',
    cost: '血量 −10%', bossGain: '伤害 +15%',
  },
  {
    id: 'pojia', name: '一剑破甲', school: 'sword', tier: 'tian', tag: '破甲', summary: '一剑定胜负的开场斩',
    towerGain: '【破甲】本场第一次出手必定暴击且伤害 ×3',
    cost: '之后出手伤害 −10%', bossGain: '伤害 +20%',
  },
  {
    id: 'jingang', name: '金刚不坏体', school: 'body', tier: 'xuan', tag: '金刚', summary: '以体魄铸就铜皮铁骨',
    towerGain: '【金刚】血量公式中体魄权重 ×1.4，开场显示血量提升',
    cost: '伤害 −10%', bossGain: '普通受伤概率 ×0.6',
  },
  {
    id: 'xueshen', name: '不灭血身', school: 'body', tier: 'di', tag: '血身', summary: '越战越稳的回血功法',
    towerGain: '【血身】每回合结束为队伍回复自身最大血量的 4%',
    cost: '伤害 −8%', bossGain: '普通受伤 ×0.7、重伤 ×0.7',
  },
  {
    id: 'baidu', name: '百毒不侵', school: 'body', tier: 'xuan', tag: '百毒不侵', summary: '百毒难侵，剧毒层克星',
    towerGain: '【百毒不侵】剧毒按队伍血量扣血时，扣除本弟子那一份；血量 +5%',
    cost: '无', bossGain: '普通受伤 ×0.8',
  },
  {
    id: 'liuyun', name: '流云身法', school: 'agile', tier: 'di', tag: '流云', summary: '身法连击，追击不断',
    towerGain: '【流云】追击概率上限 30% → 50%，追击可以继续追击（每次出手最多连续 3 次）',
    cost: '妖物对队伍伤害 +（10% ÷ 出战人数）', bossGain: '伤害 +12%',
  },
  {
    id: 'guiying', name: '鬼影步', school: 'agile', tier: 'xuan', tag: '鬼影', summary: '首回合必定追击',
    towerGain: '【鬼影】第 1 回合必定追击；追击概率 +10%（仍受上限约束）',
    cost: '无', bossGain: '伤害 +8%',
  },
  {
    id: 'tianji', name: '天机诀', school: 'crit', tier: 'di', tag: '天机', summary: '暴击翻倍，看天吃饭',
    towerGain: '【天机】暴击率 ×2',
    cost: '未暴击伤害 ×0.9', bossGain: '暴击率 ×2',
  },
  {
    id: 'pojun', name: '破军诀', school: 'crit', tier: 'xuan', tag: '破军', summary: '暴击伤害大幅提升',
    towerGain: '【破军】暴击伤害倍率 +1.0',
    cost: '无', bossGain: '暴击伤害倍率 +0.6',
  },
  {
    id: 'jiuzhuan', name: '九转心经', school: 'late', tier: 'tian', tag: '九转', summary: '越打越强的后劲心经',
    towerGain: '【九转】第 n 回合伤害 ×(1 + 0.10 × (n − 1))',
    cost: '第 1 回合伤害 −20%', bossGain: '伤害 +15%',
  },
  {
    id: 'beishui', name: '背水诀', school: 'late', tier: 'di', tag: '背水', summary: '残血反扑，绝境翻盘',
    towerGain: '【背水】队伍血量低于 35% 时伤害 +60%',
    cost: '血量 −10%', bossGain: '伤害 +12%',
  },
];

export const TECHNIQUE_IDS: readonly string[] = TECHNIQUES.map((item) => item.id);

export function findTechnique(techniqueId: string): TechniqueDef | undefined {
  return TECHNIQUES.find((item) => item.id === techniqueId);
}

/** 功法显示名；空 / 未知返回「无」。 */
export function techniqueNameOf(techniqueId: string | null | undefined): string {
  return techniqueId === null || techniqueId === undefined ? '无' : (findTechnique(techniqueId)?.name ?? '无');
}

/** 残卷物品 id（拍卖行 / 云游商人货品用）。 */
export function scrollItemIdOf(techniqueId: string): string {
  return `${TECHNIQUE_SCROLL_ITEM_PREFIX}${techniqueId}`;
}

/** 残卷物品 id → 功法 id；不是残卷物品返回 null。 */
export function techniqueIdOfScrollItem(itemId: string): string | null {
  if (!itemId.startsWith(TECHNIQUE_SCROLL_ITEM_PREFIX)) return null;
  const techniqueId = itemId.slice(TECHNIQUE_SCROLL_ITEM_PREFIX.length);
  return findTechnique(techniqueId) === undefined ? null : techniqueId;
}

/* ---------- 参悟 / 熟练度 ---------- */

/** 参悟系数 = 1 + 0.08 × (等级 − 1)；等级夹到 1~10。 */
export function techniqueLevelFactor(level: number): number {
  const clamped = Math.min(TECHNIQUE_MAX_LEVEL, Math.max(1, Math.floor(level)));
  return 1 + TECHNIQUE_LEVEL_STEP * (clamped - 1);
}

/** 熟练度系数 = 0.6 + 0.4 × 熟练度（基点夹到 0~10000）。 */
export function techniqueProficiencyFactor(proficiencyBp: number): number {
  const ratio = Math.min(TECHNIQUE_PROFICIENCY_FULL_BP, Math.max(0, proficiencyBp)) / TECHNIQUE_PROFICIENCY_FULL_BP;
  return TECHNIQUE_PROFICIENCY_FLOOR + (1 - TECHNIQUE_PROFICIENCY_FLOOR) * ratio;
}

/** 效果强度 S = 参悟系数 × 熟练度系数（增益的缩放因子）。 */
export function techniqueScaleOf(level: number, proficiencyBp: number): number {
  return techniqueLevelFactor(level) * techniqueProficiencyFactor(proficiencyBp);
}

/**
 * 当前熟练度（基点，整数）：主修后随时间增长，48 小时满。
 * base = 主修时的熟练度（换功法减半后的值，卸下时为 0）；since = 主修时刻（毫秒）；null = 没有主修。
 */
export function techniqueProficiencyBp(input: { base: number; since: number | null; now: number }): number {
  if (input.since === null || !Number.isFinite(input.since)) return 0;
  const base = Number.isFinite(input.base) ? Math.floor(input.base) : 0;
  const elapsed = Math.max(0, input.now - input.since);
  const grown = (elapsed / TECHNIQUE_PROFICIENCY_FULL_MS) * TECHNIQUE_PROFICIENCY_FULL_BP;
  return Math.min(TECHNIQUE_PROFICIENCY_FULL_BP, Math.max(0, base + Math.floor(grown)));
}

/** 换功法时保留的熟练度（基点，向下取整）。 */
export function techniqueKeptProficiencyBp(currentBp: number): number {
  return Math.floor(Math.max(0, currentBp) * TECHNIQUE_SWITCH_KEEP_RATIO);
}

/* ---------- 收录 / 参悟消耗 ---------- */

/** 收录消耗的残卷数。 */
export function techniqueLearnScrolls(tier: TechniqueTier): number {
  return TECHNIQUE_LEARN_SCROLLS[tier];
}

/**
 * 从 level 参悟到 level + 1 的消耗：残卷数 + 灵石（最小单位，= 单位 × 当前等级）。
 * 已满级（10）返回 null。
 */
export function techniqueUpgradeCost(tier: TechniqueTier, level: number): { scrolls: number; stone: number } | null {
  if (level < 1 || level >= TECHNIQUE_MAX_LEVEL) return null;
  return {
    scrolls: TECHNIQUE_LEVEL_SCROLLS[tier],
    stone: TECHNIQUE_LEVEL_STONE_UNIT[tier] * Math.floor(level),
  };
}

/* ---------- 战斗修正（纯数据 + 纯函数） ---------- */

/**
 * 镇妖塔的战斗修正：每个字段的中性值（未修功法）见 neutralTowerMods。
 * 战斗模拟只读这个对象；没有功法的弟子不带它，走原有路径（随机数取用顺序不变）。
 */
export interface TechniqueTowerMods {
  /** 体魄权重（中性 1；金刚 1 + 0.4S，血量公式 0.5 + 权重 × 体魄 / 100）。 */
  physiqueWeight: number;
  /** 血量倍率（中性 1；百毒 1 + 0.05S，太乙 0.9，背水 0.9）。 */
  hpMultiplier: number;
  /** 攻击修正比上限的加成（中性 0；青锋 0.5S，太乙 1.2S）。 */
  attackCapBonus: number;
  /** 本场第一次出手的伤害倍率（中性 1；青锋 1 + 0.5S）。 */
  firstStrikeMultiplier: number;
  /** 本场第一次出手必定暴击，暴击倍率替换为该值（中性 null；破甲 1 + 2S）。 */
  firstStrikeCritMultiplier: number | null;
  /** 第一次出手之后每次出手的伤害倍率（中性 1；破甲 0.9）。 */
  laterStrikeMultiplier: number;
  /** 每次出手的伤害倍率（代价，中性 1；金刚 0.9，血身 0.92）。 */
  strikeMultiplier: number;
  /** 暴击率倍率（中性 1；天机 1 + S）。 */
  critRateMultiplier: number;
  /** 未暴击时的伤害倍率（代价，中性 1；天机 0.9）。 */
  nonCritMultiplier: number;
  /** 暴击伤害倍率的加成（中性 0；破军 S）。 */
  critMultiplierBonus: number;
  /** 剑气：每次出手的触发概率（中性 0；太乙 0.25，开关型触发率不缩放）。 */
  procChance: number;
  /** 剑气：触发时额外造成的伤害比例（中性 0；太乙 0.5S）。 */
  procRatio: number;
  /** 追击概率加成（中性 0；鬼影 0.1S，仍受上限约束）。 */
  extraChanceBonus: number;
  /** 追击概率上限（中性 undefined = 原上限 30%；流云 0.3 + 0.2S）。 */
  extraChanceMax?: number;
  /** 单次出手最多连续出手次数（中性 undefined = 2；流云 3）。 */
  maxStrikesPerAction?: number;
  /** 第 1 回合必定追击（鬼影）。 */
  round1GuaranteedExtra: boolean;
  /** 九转：第 n 回合伤害倍率 1 + growth × (n − 1)（中性 0；0.10S）。 */
  roundGrowth: number;
  /** 九转：第 1 回合的伤害倍率（代价，中性 1；0.8）。 */
  round1Multiplier: number;
  /** 背水：队伍血量比例低于该值时触发（中性 0 = 不触发）。 */
  lowHpThreshold: number;
  /** 背水：触发时的伤害倍率（中性 1；1 + 0.6S）。 */
  lowHpMultiplier: number;
  /** 百毒不侵：免除自己那一份剧毒（开关型，不缩放）。 */
  poisonImmune: boolean;
  /** 血身：每回合结束回复自身最大血量的比例（中性 0；0.04S）。 */
  healRatio: number;
  /** 流云：妖物对队伍伤害的基础加成，按 ÷ 出战人数 摊到每名弟子（中性 0；0.1）。 */
  monsterDamageBonus: number;
}

/**
 * 世界 Boss 的战斗修正（每名弟子一份；伤害类逐人乘，暴击类在出战弟子间取平均）。
 * 只看 Boss 列的增益与「伤害代价 / 未暴击代价」这类与攻击直接相关的代价；血量 / 妖物 / 回合类代价在 Boss 上不生效。
 */
export interface TechniqueBossMods {
  /** 伤害增益倍率（中性 1）。 */
  damageGain: number;
  /** 伤害代价倍率（中性 1；金刚 0.9，血身 0.92）。 */
  damageCost: number;
  /** 暴击率倍率（中性 1；天机 1 + S）。 */
  critRateMultiplier: number;
  /** 未暴击伤害倍率（中性 1；天机 0.9）。 */
  nonCritMultiplier: number;
  /** 暴击伤害倍率加成（中性 0；破军 0.6S）。 */
  critMultiplierBonus: number;
  /** 普通受伤概率倍率（中性 1；金刚 1 − 0.4S，血身 1 − 0.3S，百毒 1 − 0.2S）。 */
  normalInjuryMultiplier: number;
  /** 重伤概率倍率（中性 1；血身 1 − 0.3S）。 */
  severeInjuryMultiplier: number;
}

export interface TechniqueModifiers {
  id: string;
  name: string;
  tag: string;
  /** 效果强度 S（参悟系数 × 熟练度系数）。 */
  scale: number;
  tower: TechniqueTowerMods;
  boss: TechniqueBossMods;
}

function neutralTowerMods(): TechniqueTowerMods {
  return {
    physiqueWeight: 1,
    hpMultiplier: 1,
    attackCapBonus: 0,
    firstStrikeMultiplier: 1,
    firstStrikeCritMultiplier: null,
    laterStrikeMultiplier: 1,
    strikeMultiplier: 1,
    critRateMultiplier: 1,
    nonCritMultiplier: 1,
    critMultiplierBonus: 0,
    procChance: 0,
    procRatio: 0,
    extraChanceBonus: 0,
    round1GuaranteedExtra: false,
    roundGrowth: 0,
    round1Multiplier: 1,
    lowHpThreshold: 0,
    lowHpMultiplier: 1,
    poisonImmune: false,
    healRatio: 0,
    monsterDamageBonus: 0,
  };
}

function neutralBossMods(): TechniqueBossMods {
  return {
    damageGain: 1,
    damageCost: 1,
    critRateMultiplier: 1,
    nonCritMultiplier: 1,
    critMultiplierBonus: 0,
    normalInjuryMultiplier: 1,
    severeInjuryMultiplier: 1,
  };
}

/**
 * 功法的战斗修正（参数 = 功法 id、参悟等级、熟练度基点）。
 * 未知功法 / 没有功法（null）返回 null —— 调用方据此走原有路径。
 */
export function techniqueModifiersOf(input: {
  techniqueId: string | null | undefined;
  level: number;
  proficiencyBp: number;
}): TechniqueModifiers | null {
  if (input.techniqueId === null || input.techniqueId === undefined) return null;
  const def = findTechnique(input.techniqueId);
  if (def === undefined) return null;
  const s = techniqueScaleOf(input.level, input.proficiencyBp);
  const tower = neutralTowerMods();
  const boss = neutralBossMods();
  switch (def.id) {
    case 'qingfeng':
      tower.firstStrikeMultiplier = 1 + 0.5 * s;
      tower.attackCapBonus = 0.5 * s;
      boss.damageGain = 1 + 0.06 * s;
      break;
    case 'taiyi':
      tower.procChance = 0.25;
      tower.procRatio = 0.5 * s;
      tower.attackCapBonus = 1.2 * s;
      tower.hpMultiplier = 0.9;
      boss.damageGain = 1 + 0.15 * s;
      break;
    case 'pojia':
      tower.firstStrikeCritMultiplier = 1 + 2 * s;
      tower.laterStrikeMultiplier = 0.9;
      boss.damageGain = 1 + 0.2 * s;
      break;
    case 'jingang':
      tower.physiqueWeight = 1 + 0.4 * s;
      tower.strikeMultiplier = 0.9;
      boss.damageCost = 0.9;
      boss.normalInjuryMultiplier = 1 - 0.4 * s;
      break;
    case 'xueshen':
      tower.healRatio = 0.04 * s;
      tower.strikeMultiplier = 0.92;
      boss.damageCost = 0.92;
      boss.normalInjuryMultiplier = 1 - 0.3 * s;
      boss.severeInjuryMultiplier = 1 - 0.3 * s;
      break;
    case 'baidu':
      tower.hpMultiplier = 1 + 0.05 * s;
      tower.poisonImmune = true;
      boss.normalInjuryMultiplier = 1 - 0.2 * s;
      break;
    case 'liuyun':
      tower.extraChanceMax = 0.3 + 0.2 * s;
      tower.maxStrikesPerAction = 3;
      tower.monsterDamageBonus = 0.1;
      boss.damageGain = 1 + 0.12 * s;
      break;
    case 'guiying':
      tower.round1GuaranteedExtra = true;
      tower.extraChanceBonus = 0.1 * s;
      boss.damageGain = 1 + 0.08 * s;
      break;
    case 'tianji':
      tower.critRateMultiplier = 1 + s;
      tower.nonCritMultiplier = 0.9;
      boss.critRateMultiplier = 1 + s;
      boss.nonCritMultiplier = 0.9;
      break;
    case 'pojun':
      tower.critMultiplierBonus = s;
      boss.critMultiplierBonus = 0.6 * s;
      break;
    case 'jiuzhuan':
      tower.roundGrowth = 0.1 * s;
      tower.round1Multiplier = 0.8;
      boss.damageGain = 1 + 0.15 * s;
      break;
    case 'beishui':
      tower.lowHpThreshold = 0.35;
      tower.lowHpMultiplier = 1 + 0.6 * s;
      tower.hpMultiplier = 0.9;
      boss.damageGain = 1 + 0.12 * s;
      break;
    default:
      return null;
  }
  return { id: def.id, name: def.name, tag: def.tag, scale: s, tower, boss };
}

/* ---------- 残卷来源：世界 Boss 掉落 ---------- */

/** 世界 Boss 残卷：伤害占比 ≥ 5% 必得，否则 40% 概率得。 */
export const BOSS_SCROLL_MIN_SHARE = 0.05;
export const BOSS_SCROLL_CHANCE = 0.4;
/** 玄 / 地 / 天的掉落权重（第 6 关之前不出天阶）。 */
export const BOSS_SCROLL_TIER_WEIGHTS: Readonly<Record<TechniqueTier, number>> = { xuan: 6, di: 3, tian: 1 };
export const BOSS_SCROLL_TIAN_FROM_STAGE = 6;

/** 一关击杀时，一个得到残卷的宗门拿几张（不含伤害第一的 +1）：第 1～3 关 1 张，第 4～6 关 2 张，第 7 关起 3 张。 */
export function bossScrollCountOf(stage: number): number {
  const s = Math.max(1, Math.floor(stage));
  if (s <= 3) return 1;
  if (s <= 6) return 2;
  return 3;
}

/** 抽一张残卷：先按品阶权重，再在该品阶里等概率取一门（随机源注入；每张 2 次取用）。 */
export function rollBossScroll(stage: number, random: () => number): string {
  const includeTian = Math.floor(stage) >= BOSS_SCROLL_TIAN_FROM_STAGE;
  const tiers: TechniqueTier[] = includeTian ? ['xuan', 'di', 'tian'] : ['xuan', 'di'];
  const total = tiers.reduce((sum, tier) => sum + BOSS_SCROLL_TIER_WEIGHTS[tier], 0);
  let roll = random() * total;
  let tier: TechniqueTier = tiers[tiers.length - 1]!;
  for (const candidate of tiers) {
    roll -= BOSS_SCROLL_TIER_WEIGHTS[candidate];
    if (roll < 0) {
      tier = candidate;
      break;
    }
  }
  const pool = TECHNIQUES.filter((item) => item.tier === tier);
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  return pool[index]!.id;
}

/**
 * 一个参与宗门在一关击杀时获得的残卷（techniqueId → 张数）。
 * 得到的概率：占比 ≥ 5% 必得（不取随机数），否则 40% 概率（取一次随机数）；得到后按关卡给张数，
 * 伤害第一（rank 1）另 +1 张。没有任何残卷时返回空对象。
 */
export function bossScrollGrantOf(input: {
  stage: number;
  damageShare: number;
  rank: number;
  random: () => number;
}): Record<string, number> {
  const got = input.damageShare >= BOSS_SCROLL_MIN_SHARE || input.random() < BOSS_SCROLL_CHANCE;
  const count = (got ? bossScrollCountOf(input.stage) : 0) + (input.rank === 1 ? 1 : 0);
  const grant: Record<string, number> = {};
  for (let index = 0; index < count; index += 1) {
    const techniqueId = rollBossScroll(input.stage, input.random);
    grant[techniqueId] = (grant[techniqueId] ?? 0) + 1;
  }
  return grant;
}

/* ---------- 残卷来源：云游商人 ---------- */

/** 商人残卷只出玄阶与地阶。 */
export const MERCHANT_SCROLL_TIERS: readonly TechniqueTier[] = ['xuan', 'di'];
