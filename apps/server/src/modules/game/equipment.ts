/**
 * 装备系统（一期）——纯定义与纯计算（docs/装备系统开发计划.md 第 1 节）。
 *
 * 与 alchemy.ts / worldBoss.ts 同理：装备规则是少量功能定义，放在游戏模块代码里，
 * 不进 GameConfigContent，也不改公共配置哈希。
 *
 * 本文件只放纯定义和纯计算：不读数据库、不取时间（不调用 Date.now()）；
 * 所有随机都通过参数注入（random），便于测试。
 *
 * 一期不做（计划第 6 节）：强化 / 升级装备、炼器师与更高品质的炼器、套装效果、
 * 耐久与修理、玩家间交易、装备锁定、装备影响历练 / 论道 / 综合评分、背包扩容、
 * 除炼器、世界 Boss 与三期功勋兑换以外的其他来源。
 */

export type EquipmentSlot = 'weapon' | 'armor' | 'artifact';
export type EquipmentQuality = 'common' | 'spirit' | 'treasure' | 'immortal';
/** 装备能加成的 5 项属性（与弟子表的 5 个 gear_ 列一一对应）。 */
export type EquipmentAttr = 'attack' | 'defense' | 'speed' | 'luck' | 'physique';
export type EquipmentSource = 'forge' | 'boss' | 'tower';

/** 一组属性的数值（基础属性、装备加成、两者之和都用它）。 */
export interface AttrSet {
  attack: number;
  defense: number;
  speed: number;
  luck: number;
  physique: number;
}

export const EMPTY_ATTRS: AttrSet = { attack: 0, defense: 0, speed: 0, luck: 0, physique: 0 };

/** 品质定义（计划 1.1 的表）。 */
export interface EquipmentQualityDef {
  id: EquipmentQuality;
  name: string;
  /** 主属性加成（固定值）。 */
  mainValue: number;
  /** 副属性取值区间（整数，含两端）。 */
  subMin: number;
  subMax: number;
  /** 分解返还的矿石（展示单位；1 展示单位 = 1000 最小单位）。 */
  salvageOre: number;
  /**
   * 装备战力加成（基点，10000 = +100%）：穿在身上时，弟子战力再乘 (1 + 各件之和 / 10000)。
   * 与属性加成分开算 —— 属性加成照旧进攻 / 防 / 身法，这一项只放大战力。
   */
  powerBonusBp: number;
  /** 面板颜色（前端只渲染，不做品质判断）。 */
  color: string;
}

export const EQUIPMENT_QUALITIES: readonly EquipmentQualityDef[] = [
  { id: 'common', name: '凡品', mainValue: 8, subMin: 2, subMax: 4, salvageOre: 50, powerBonusBp: 200, color: '#b9c0c9' },
  { id: 'spirit', name: '灵品', mainValue: 16, subMin: 4, subMax: 8, salvageOre: 120, powerBonusBp: 400, color: '#4ade80' },
  { id: 'treasure', name: '宝品', mainValue: 20, subMin: 6, subMax: 10, salvageOre: 250, powerBonusBp: 700, color: '#60a5fa' },
  { id: 'immortal', name: '仙品', mainValue: 24, subMin: 8, subMax: 16, salvageOre: 500, powerBonusBp: 1000, color: '#fbbf24' },
];

/** 3 个装备格（计划 1.1）：兵器 = 攻击、护甲 = 防御，法器的主属性由玩家 / 随机二选一。 */
export const EQUIPMENT_SLOTS: readonly { id: EquipmentSlot; name: string; mainAttr: EquipmentAttr | null }[] = [
  { id: 'weapon', name: '兵器', mainAttr: 'attack' },
  { id: 'armor', name: '护甲', mainAttr: 'defense' },
  { id: 'artifact', name: '法器', mainAttr: null },
];

/** 法器可选的两种主属性。 */
export const ARTIFACT_MAIN_ATTRS: readonly EquipmentAttr[] = ['speed', 'luck'];

/** 部位名表：装备名 = `{品质名}·{部位名}`。 */
export const EQUIPMENT_SLOT_NAMES: Readonly<Record<EquipmentSlot, readonly string[]>> = {
  weapon: ['青锋剑', '玄铁刀', '赤霄剑', '破军枪', '流云扇'],
  armor: ['云纹甲', '玄龟甲', '青鸾衣', '磐石铠', '流光袍'],
  artifact: ['定风珠', '镇魂铃', '玲珑塔', '乾坤镜', '紫金葫芦'],
};

/** 副属性候选：攻击 / 防御 / 身法 / 幸运 / 体魄（与主属性不同）。 */
export const EQUIPMENT_ATTRS: readonly EquipmentAttr[] = ['attack', 'defense', 'speed', 'luck', 'physique'];

export const EQUIPMENT_ATTR_NAMES: Readonly<Record<EquipmentAttr, string>> = {
  attack: '攻击',
  defense: '防御',
  speed: '身法',
  luck: '幸运',
  physique: '体魄',
};

/** 炼器解锁：宗门等级下限（不需要建筑）。 */
export const FORGE_UNLOCK_SECT_LEVEL = 2;
/** 默认炼器品质（炼器坊 1 级只能炼凡品）；炼器必定成功，品质由玩家选、不随机。 */
export const FORGE_QUALITY: EquipmentQuality = 'common';

/* ---------- 装备二期：玄铁 · 炼器坊 · 各品质炼造消耗 ---------- */

/** 玄铁的资源 id（game-config 里的第五种资源）。 */
export const XUANTIE_RESOURCE_ID = 'xuantie';
/** 炼器坊的建筑 id。 */
export const FORGE_WORKSHOP_ID = 'forgeWorkshop';

/** 各品质单件炼造消耗（最小单位）与所需炼器坊等级。 */
export const FORGE_RECIPES: readonly { quality: EquipmentQuality; workshopLevel: number; cost: Readonly<Record<string, string>> }[] = [
  { quality: 'common', workshopLevel: 1, cost: { spiritStone: '80000', ore: '150000' } },
  // 玄铁下调约 4 成（原 3 / 10 / 30）：分解返还（1 / 3 / 8）仍低于炼造消耗，不能靠炼了再拆套利。
  { quality: 'spirit', workshopLevel: 2, cost: { spiritStone: '250000', ore: '400000', xuantie: '2000' } },
  { quality: 'treasure', workshopLevel: 3, cost: { spiritStone: '600000', ore: '1000000', xuantie: '6000' } },
  { quality: 'immortal', workshopLevel: 4, cost: { spiritStone: '1500000', ore: '2500000', xuantie: '18000' } },
];

/** 兼容一期：凡品的消耗。 */
export const FORGE_COST: Readonly<Record<string, string>> = FORGE_RECIPES[0]!.cost;

export function forgeRecipeOf(quality: string) {
  return FORGE_RECIPES.find((recipe) => recipe.quality === quality);
}

/** 炼器结果：成功 = 所选品质；降级 = 低一档；失败 = 不出装备（返还一半灵石矿石，玄铁全损）。永远不会高于所选品质。 */
export type ForgeResult = 'success' | 'downgrade' | 'fail';
export interface ForgeOdds {
  success: number;
  downgrade: number;
  fail: number;
}

const FORGE_BASE_ODDS: Readonly<Record<EquipmentQuality, ForgeOdds>> = {
  common: { success: 1, downgrade: 0, fail: 0 },
  spirit: { success: 0.7, downgrade: 0.2, fail: 0.1 },
  treasure: { success: 0.65, downgrade: 0.25, fail: 0.1 },
  // 仙品不会失败（最差降为宝品）：原 50% / 30% / 20% 期望要炼 2 次、玄铁约 60 个，比功勋直接兑换还贵。
  immortal: { success: 0.6, downgrade: 0.4, fail: 0 },
};

/** 炼器坊每比该品质的要求高 1 级，成功率 +10%（先抵消失败率，再抵消降级率）。 */
export const FORGE_SURPLUS_BONUS = 0.1;
/** 仙品保底：只有炼仙品计层。 */
export const FORGE_PITY_QUALITY: EquipmentQuality = 'immortal';
/** 仙品保底：每层成功率 +10%（与炼器坊加成同一抵扣顺序）。 */
export const FORGE_PITY_BONUS = 0.1;
/** 仙品保底最多 4 层：60% + 40% = 100%，即最迟第 5 次必出仙品。 */
export const FORGE_PITY_MAX = 4;
/** 失败时返还灵石、矿石的比例（玄铁不返还）。 */
export const FORGE_FAIL_REFUND_RATIO = 0.5;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** 保底层数夹到 [0, FORGE_PITY_MAX]（脏值不会把概率放大到 100% 以上）。 */
function clampPity(pity: number): number {
  return Math.min(FORGE_PITY_MAX, Math.max(0, Math.floor(Number(pity) || 0)));
}

/**
 * 炼器概率：炼器坊加成 +（仅仙品）保底加成 + 炼器执事加成（stewardBonusBp，天赋重构），
 * 先抵消失败率，再抵消降级率。
 */
export function forgeOddsOf(
  quality: EquipmentQuality,
  workshopLevel: number,
  pity = 0,
  stewardBonusBp = 0,
): ForgeOdds {
  const base = FORGE_BASE_ODDS[quality];
  let bonus =
    FORGE_SURPLUS_BONUS * Math.max(0, workshopLevel - (forgeRecipeOf(quality)?.workshopLevel ?? 1)) +
    (quality === FORGE_PITY_QUALITY ? FORGE_PITY_BONUS * clampPity(pity) : 0) +
    Math.max(0, stewardBonusBp) / 10_000;
  const fail = round2(Math.max(0, base.fail - bonus));
  bonus -= base.fail - fail;
  const downgrade = round2(Math.max(0, base.downgrade - bonus));
  return { success: round2(1 - fail - downgrade), downgrade, fail };
}

/** 按概率判定炼器结果；random 注入便于测试。 */
export function rollForgeResult(odds: ForgeOdds, random: () => number): ForgeResult {
  const roll = random();
  if (roll < odds.fail) return 'fail';
  if (roll < round2(odds.fail + odds.downgrade)) return 'downgrade';
  return 'success';
}

/** 炼完后的保底层数：只有炼仙品才变 —— 出仙品清零，否则 +1（封顶 FORGE_PITY_MAX）。 */
export function nextForgePity(quality: EquipmentQuality, result: ForgeResult, pity: number): number {
  if (quality !== FORGE_PITY_QUALITY) return clampPity(pity);
  return result === 'success' ? 0 : clampPity(clampPity(pity) + 1);
}

/** 低一档品质（凡品已是最低，保持凡品）。 */
export function lowerQuality(quality: EquipmentQuality): EquipmentQuality {
  const index = EQUIPMENT_QUALITIES.findIndex((item) => item.id === quality);
  return EQUIPMENT_QUALITIES[Math.max(0, index - 1)]!.id;
}

/** 失败返还（最小单位）：只返还灵石与矿石的一半，玄铁不返还。 */
export function forgeFailRefund(cost: Readonly<Record<string, string>>): Record<string, number> {
  const refund: Record<string, number> = {};
  for (const resourceId of ['spiritStone', 'ore']) {
    const amount = Math.floor(Number(cost[resourceId] ?? 0) * FORGE_FAIL_REFUND_RATIO);
    if (amount > 0) refund[resourceId] = amount;
  }
  return refund;
}

/** 炼器坊升级表：升到 level 需要的宗门等级与消耗（最小单位）。1 级随宗门 2 级自动获得。 */
export const FORGE_WORKSHOP_UPGRADES: readonly { level: number; sectLevel: number; cost: Readonly<Record<string, string>> }[] = [
  { level: 2, sectLevel: 3, cost: { spiritStone: '2000000', ore: '3000000', xuantie: '15000' } },
  { level: 3, sectLevel: 5, cost: { spiritStone: '6000000', ore: '6000000', xuantie: '40000' } },
  { level: 4, sectLevel: 7, cost: { spiritStone: '15000000', ore: '12000000', xuantie: '100000' } },
];

/** 从 currentLevel 升一级的条件；已满级返回 null。 */
export function forgeWorkshopUpgradeFrom(currentLevel: number) {
  return FORGE_WORKSHOP_UPGRADES.find((item) => item.level === currentLevel + 1) ?? null;
}

/** 分解返还玄铁（最小单位）：凡品 0 / 灵品 1 / 宝品 3 / 仙品 8。 */
const SALVAGE_XUANTIE: Readonly<Record<EquipmentQuality, number>> = {
  common: 0,
  spirit: 1000,
  treasure: 3000,
  immortal: 8000,
};

export function salvageXuantieUnits(quality: EquipmentQuality): number {
  return SALVAGE_XUANTIE[quality] ?? 0;
}

/**
 * 世界 Boss 玄铁：伤害占比 ≥ 15% 按关卡给量、伤害第 1 名更多；占比不足 15% 也按关卡给少量（三期）；击退减半（向下取整）。
 * 第 1～5 关查表（资源不足调整：各 +1）；第 6 关起每关再 +2 / 第 1 名 +3 / 不足门槛 +1，到第 10 关封顶。
 */
export const BOSS_XUANTIE_MIN_SHARE = 0.15;
const BOSS_XUANTIE_BY_STAGE: readonly { base: number; top: number }[] = [
  { base: 3, top: 4 },
  { base: 4, top: 6 },
  { base: 5, top: 7 },
  { base: 7, top: 10 },
  { base: 9, top: 13 },
];
/** 第 5 关以后每多一关的增量：占比达标 / 第 1 名 / 占比不足门槛。 */
const BOSS_XUANTIE_DEEP_STEP = { base: 2, top: 3, below: 1 } as const;
/** 玄铁随关卡递增的封顶关卡。 */
export const BOSS_XUANTIE_MAX_STAGE = 10;

/** 返回玄铁数量（展示单位整数；调用方 × 1000 入账）。 */
export function bossXuantieFor(input: { stage: number; damageShare: number; isTop: boolean; repelled: boolean }): number {
  if (input.damageShare <= 0) return 0;
  const stage = Math.min(BOSS_XUANTIE_MAX_STAGE, Math.max(1, Math.floor(input.stage)));
  const deep = Math.max(0, stage - BOSS_XUANTIE_BY_STAGE.length);
  // 三期：占比不足门槛的参与者每关也给（第 1～5 关 1 个，之后每关 +1；击退减半后向下取整）。
  if (input.damageShare < BOSS_XUANTIE_MIN_SHARE) {
    const below = 1 + BOSS_XUANTIE_DEEP_STEP.below * deep;
    return input.repelled ? Math.floor(below / 2) : below;
  }
  const row = BOSS_XUANTIE_BY_STAGE[Math.min(stage, BOSS_XUANTIE_BY_STAGE.length) - 1]!;
  const amount = input.isTop ? row.top + BOSS_XUANTIE_DEEP_STEP.top * deep : row.base + BOSS_XUANTIE_DEEP_STEP.base * deep;
  return input.repelled ? Math.floor(amount / 2) : amount;
}

/** 高级秘境探索成功时的玄铁掉落（只有这三个秘境）。 */
export const REALM_XUANTIE_DROPS: Readonly<Record<string, { chance: number; min: number; max: number }>> = {
  beastNest: { chance: 0.1, min: 1, max: 1 },
  ancientRealm: { chance: 0.15, min: 1, max: 2 },
  tribulationRuins: { chance: 0.2, min: 2, max: 3 },
};

/** 秘境列表里的概率掉落说明，如「玄铁 1~2（15%）」；不掉玄铁的秘境返回 null。 */
export function realmXuantieDropText(realmId: string): string | null {
  const drop = REALM_XUANTIE_DROPS[realmId];
  if (drop === undefined) return null;
  const amount = drop.min === drop.max ? String(drop.min) : `${String(drop.min)}~${String(drop.max)}`;
  return `玄铁 ${amount}（${String(Math.round(drop.chance * 100))}%）`;
}

/**
 * 秘境玄铁掉落（展示单位整数，0 = 没掉）；random 注入便于测试。
 * chanceBonusBp（天赋重构 · 寻宝执事）：掉落概率 ×(1 + 它 / 10000)，封顶 100%。
 */
export function realmXuantieDrop(realmId: string, random: () => number, chanceBonusBp = 0): number {
  const drop = REALM_XUANTIE_DROPS[realmId];
  const chance = drop === undefined ? 0 : Math.min(1, drop.chance * (1 + Math.max(0, chanceBonusBp) / 10_000));
  if (drop === undefined || random() >= chance) return 0;
  return drop.min + Math.min(drop.max - drop.min, Math.floor(random() * (drop.max - drop.min + 1)));
}
/** 背包上限 = 本宗门**未穿戴**装备的件数上限（穿在身上的不占背包）。 */
export const BAG_CAPACITY = 50;
/** 世界 Boss 掉落：击杀时掉高档装备的概率系数（概率 = 它 × √伤害占比）。 */
export const BOSS_HIGH_DROP_FACTOR = 0.75;
/**
 * 高档是仙品（第 5 关起）时改用这个系数：每天都能打到第 5 关以后，按 0.75 算
 * 活跃宗门一天能掉一件多仙品，仙品泛滥。灵 / 宝两档仍按 BOSS_HIGH_DROP_FACTOR。
 */
export const BOSS_IMMORTAL_DROP_FACTOR = 0.25;
/** 世界 Boss 掉落：未中高档时掉低档的概率。 */
export const BOSS_DROP_CHANCE_OTHERS = 0.4;
/** 分解返还矿石的换算：1 展示单位 = 1000 最小单位。 */
export const ORE_UNITS_PER_DISPLAY = 1000;

/** 未解锁时的统一文案（面板与炼器报错共用同一句）。 */
export const FORGE_LOCKED_REASON = `炼器尚未开启，需要宗门 ${String(FORGE_UNLOCK_SECT_LEVEL)} 级`;

/** 未解锁返回 null，否则返回原因（与 alchemyUnlockBlockedReason 同一写法）。 */
export function forgeUnlockBlockedReason(sectLevel: number): string | null {
  return sectLevel >= FORGE_UNLOCK_SECT_LEVEL ? null : FORGE_LOCKED_REASON;
}

/** 背包满的提示文案（卸下 / 炼器共用）。 */
export function bagFullReason(bagCount: number): string {
  return `背包已满（${String(bagCount)}/${String(BAG_CAPACITY)}），请先分解`;
}

export function findQuality(qualityId: string): EquipmentQualityDef | undefined {
  return EQUIPMENT_QUALITIES.find((quality) => quality.id === qualityId);
}

export function qualityNameOf(qualityId: string): string {
  return findQuality(qualityId)?.name ?? qualityId;
}

export function qualityColorOf(qualityId: string): string {
  return findQuality(qualityId)?.color ?? EQUIPMENT_QUALITIES[0]!.color;
}

export function isEquipmentSlot(value: string): value is EquipmentSlot {
  return EQUIPMENT_SLOTS.some((slot) => slot.id === value);
}

export function isEquipmentQuality(value: string): value is EquipmentQuality {
  return EQUIPMENT_QUALITIES.some((quality) => quality.id === value);
}

export function isEquipmentAttr(value: string): value is EquipmentAttr {
  return EQUIPMENT_ATTRS.some((attr) => attr === value);
}

export function findSlot(slotId: string): { id: EquipmentSlot; name: string; mainAttr: EquipmentAttr | null } | undefined {
  return EQUIPMENT_SLOTS.find((slot) => slot.id === slotId);
}

/** 部位显示名（`'weapon'` → 「兵器」）；脏值原样返回，前端不至于渲染空。 */
export function slotNameOf(slotId: string): string {
  return findSlot(slotId)?.name ?? slotId;
}

/** 属性显示名（`'physique'` → 「体魄」）。 */
export function attrNameOf(attrId: string): string {
  return isEquipmentAttr(attrId) ? EQUIPMENT_ATTR_NAMES[attrId] : attrId;
}

/** 按注入的随机源从数组里取一项（下标夹在合法区间内）。 */
function pick<T>(items: readonly T[], random: () => number): T {
  const index = Math.min(items.length - 1, Math.max(0, Math.floor(random() * items.length)));
  return items[index]!;
}

/**
 * 解析主属性（计划 1.1）：
 * - 兵器固定攻击、护甲固定防御；这两个部位**不能**指定主属性（指定了返回 null，调用方报错）；
 * - 法器必须给 `speed` 或 `luck`；炼器时由玩家给，Boss 掉落时省略（这里随机二选一）。
 * 返回 null = 非法组合，调用方抛 VALIDATION_ERROR。
 */
export function resolveMainAttr(
  slot: EquipmentSlot,
  chosen: string | undefined,
  random: () => number,
): EquipmentAttr | null {
  const def = findSlot(slot);
  if (def === undefined) {
    return null;
  }
  if (def.mainAttr !== null) {
    return chosen === undefined ? def.mainAttr : null;
  }
  if (chosen === undefined) {
    return pick(ARTIFACT_MAIN_ATTRS, random);
  }
  return ARTIFACT_MAIN_ATTRS.includes(chosen as EquipmentAttr) ? (chosen as EquipmentAttr) : null;
}

export interface GeneratedEquipment {
  slot: EquipmentSlot;
  quality: EquipmentQuality;
  name: string;
  mainAttr: EquipmentAttr;
  mainValue: number;
  subAttr: EquipmentAttr;
  /** 副属性数值（该品质区间内的整数，含两端）。 */
  subValue: number;
}

/**
 * 生成一件装备（属性定型后不再变化）。
 *
 * 随机消耗顺序固定为：① 部位名 → ② 副属性种类 → ③ 副属性数值（测试按这个顺序注入）。
 * `mainAttr` 必须是已经解析好的主属性（炼器用玩家选择，掉落用 resolveMainAttr 随机）。
 */
export function generateEquipment(input: {
  slot: EquipmentSlot;
  quality: EquipmentQuality;
  mainAttr: EquipmentAttr;
  random: () => number;
}): GeneratedEquipment {
  const qualityDef = findQuality(input.quality) ?? EQUIPMENT_QUALITIES[0]!;
  const name = `${qualityDef.name}·${pick(EQUIPMENT_SLOT_NAMES[input.slot], input.random)}`;
  const subAttr = pick(
    EQUIPMENT_ATTRS.filter((attr) => attr !== input.mainAttr),
    input.random,
  );
  const span = qualityDef.subMax - qualityDef.subMin + 1;
  const subValue =
    qualityDef.subMin + Math.min(span - 1, Math.max(0, Math.floor(input.random() * span)));
  return {
    slot: input.slot,
    quality: input.quality,
    name,
    mainAttr: input.mainAttr,
    mainValue: qualityDef.mainValue,
    subAttr,
    subValue,
  };
}

/** 世界 Boss 击杀掉落的品质（三期 2.1）：top = 高档，others = 低档；按关卡给。 */
export function bossDropQualities(stage: number): { top: EquipmentQuality; others: EquipmentQuality } {
  if (stage <= 2) {
    return { top: 'spirit', others: 'common' };
  }
  if (stage <= 4) {
    return { top: 'treasure', others: 'spirit' };
  }
  return { top: 'immortal', others: 'treasure' };
}

/** 该关高档掉落的系数：高档是仙品时用 BOSS_IMMORTAL_DROP_FACTOR，否则 BOSS_HIGH_DROP_FACTOR。 */
export function bossHighDropFactor(stage: number): number {
  return bossDropQualities(stage).top === 'immortal' ? BOSS_IMMORTAL_DROP_FACTOR : BOSS_HIGH_DROP_FACTOR;
}

/**
 * 击杀时掉高档装备的概率 = 该关系数（bossHighDropFactor）× √伤害占比。
 * 伤害占比先夹到 [0, 1]（负数与 >1 的脏值都不会把概率放大）。
 */
export function bossHighDropChance(damageShare: number, stage: number): number {
  const share = Math.min(1, Math.max(0, damageShare));
  return bossHighDropFactor(stage) * Math.sqrt(share);
}

/**
 * 世界 Boss 击杀掉落判定：先判高档，未中再判低档；都没中返回 null。
 *
 * 随机数取用顺序（测试依赖）：每个参与者先取一个判高档，未中高档才再取一个判低档；
 * damageShare ≤ 0 直接返回 null，且**不**取随机数。
 */
export function rollBossDrop(input: {
  stage: number;
  damageShare: number;
  random: () => number;
}): EquipmentQuality | null {
  if (input.damageShare <= 0) return null;
  const { top, others } = bossDropQualities(input.stage);
  if (input.random() < bossHighDropChance(input.damageShare, input.stage)) {
    return top;
  }
  return input.random() < BOSS_DROP_CHANCE_OTHERS ? others : null;
}

/** 「奖励」预览里的掉落说明（与发奖同一套判定，前端不复制公式）。 */
export function bossDropDescription(stage: number): string {
  const { top, others } = bossDropQualities(stage);
  const highPercent = Math.round(bossHighDropFactor(stage) * 100);
  const lowPercent = Math.round(BOSS_DROP_CHANCE_OTHERS * 100);
  return `按本关伤害占比各自判定：${qualityNameOf(top)}装备 ×1 概率 = ${String(highPercent)}% × √占比；未得时 ${String(lowPercent)}% 概率得 ${qualityNameOf(others)}装备 ×1`;
}

/** 分解返还的矿石（最小单位）= 品质表的展示单位 × 1000。 */
export function salvageOreUnits(quality: EquipmentQuality): number {
  return (findQuality(quality)?.salvageOre ?? 0) * ORE_UNITS_PER_DISPLAY;
}

/**
 * 一组装备的加成之和（按属性求和）。
 * 只认 5 个合法属性 id，其余（理论上不会出现的脏值）忽略。
 */
export function gearBonusOf(
  items: readonly { main_attr: string; main_value: number; sub_attr: string; sub_value: number }[],
): AttrSet {
  const bonus: AttrSet = { ...EMPTY_ATTRS };
  for (const item of items) {
    if (isEquipmentAttr(item.main_attr)) {
      bonus[item.main_attr] += Number(item.main_value);
    }
    if (isEquipmentAttr(item.sub_attr)) {
      bonus[item.sub_attr] += Number(item.sub_value);
    }
  }
  return bonus;
}

/**
 * 弟子表上 5 个冗余列的加成（计划 2.2）：**所有战斗计算只读这 5 列**，不查装备表。
 * 列的写入由 repository.refreshDiscipleGearStatement 按装备表重新求和完成。
 */
export function gearBonusOfDisciple(row: {
  gear_attack: number;
  gear_defense: number;
  gear_speed: number;
  gear_luck: number;
  gear_physique: number;
}): AttrSet {
  return {
    attack: Number(row.gear_attack),
    defense: Number(row.gear_defense),
    speed: Number(row.gear_speed),
    luck: Number(row.gear_luck),
    physique: Number(row.gear_physique),
  };
}

/** 单件装备的战力加成（基点）；脏品质按 0。 */
export function qualityPowerBonusBp(qualityId: string): number {
  return findQuality(qualityId)?.powerBonusBp ?? 0;
}

/**
 * 一组装备的战力加成之和（基点）：每件 = 品质加成 + 祭炼战力加成（按重数，0044）。
 * 与 repository.ts 的 GEAR_POWER_BP_CASE 同一口径，两处必须同时改。
 */
export function gearPowerBonusBpOf(items: readonly { quality: string; refine_level?: number }[]): number {
  return items.reduce(
    (sum, item) => sum + qualityPowerBonusBp(item.quality) + refinePowerBonusBp(Number(item.refine_level ?? 0)),
    0,
  );
}

/**
 * 弟子表上第 6 个冗余列 `gear_power_bp`（0032）：身上装备的战力加成之和（基点）。
 * 与 5 个属性列同一套写回（refreshDiscipleGearStatement），战斗计算只读这一列。
 */
export function gearPowerBonusBpOfDisciple(row: { gear_power_bp: number }): number {
  return Number(row.gear_power_bp) || 0;
}

/** 基础属性 + 装备加成（加成后可以超过 100；基础属性本身仍最高 100）。 */
export function withGear(base: AttrSet, gear: AttrSet): AttrSet {
  return {
    attack: base.attack + gear.attack,
    defense: base.defense + gear.defense,
    speed: base.speed + gear.speed,
    luck: base.luck + gear.luck,
    physique: base.physique + gear.physique,
  };
}

/* ---------- 祭炼（docs/装备祭炼开发计划.md） ---------- */

export const REFINE_MAX_LEVEL = 12;
export const REFINE_FAILS_CAP = 50;

/** 冲到第 N 重（下标 N - 1）的成功率：基础 / 每次失败加成 / 上限（基点）。 */
export const REFINE_ODDS: readonly { baseBp: number; stepBp: number; capBp: number }[] = [
  { baseBp: 10000, stepBp: 0, capBp: 10000 },
  { baseBp: 10000, stepBp: 0, capBp: 10000 },
  { baseBp: 10000, stepBp: 0, capBp: 10000 },
  { baseBp: 9000, stepBp: 500, capBp: 10000 },
  { baseBp: 8000, stepBp: 500, capBp: 9500 },
  { baseBp: 6500, stepBp: 500, capBp: 8500 },
  { baseBp: 5500, stepBp: 400, capBp: 7500 },
  { baseBp: 4500, stepBp: 400, capBp: 6500 },
  { baseBp: 3500, stepBp: 300, capBp: 5500 },
  { baseBp: 3000, stepBp: 300, capBp: 4800 },
  { baseBp: 2500, stepBp: 200, capBp: 4000 },
  { baseBp: 2000, stepBp: 200, capBp: 3500 },
];

/** 冲到第 N 重（下标 N - 1）的消耗，展示单位。0 表示不消耗。 */
export const REFINE_COSTS: Readonly<Record<EquipmentQuality, readonly { spiritStone: number; ore: number; xuantie: number }[]>> = {
  common: [
    { spiritStone: 12, ore: 9, xuantie: 0 },
    { spiritStone: 17, ore: 14, xuantie: 0 },
    { spiritStone: 23, ore: 18, xuantie: 0 },
    { spiritStone: 33, ore: 27, xuantie: 0 },
    { spiritStone: 45, ore: 36, xuantie: 0 },
    { spiritStone: 68, ore: 45, xuantie: 1 },
    { spiritStone: 90, ore: 54, xuantie: 1 },
    { spiritStone: 113, ore: 72, xuantie: 1 },
    { spiritStone: 147, ore: 90, xuantie: 1 },
    { spiritStone: 180, ore: 108, xuantie: 2 },
    { spiritStone: 225, ore: 135, xuantie: 2 },
    { spiritStone: 282, ore: 162, xuantie: 2 },
  ],
  spirit: [
    { spiritStone: 20, ore: 15, xuantie: 0 },
    { spiritStone: 28, ore: 23, xuantie: 0 },
    { spiritStone: 38, ore: 30, xuantie: 0 },
    { spiritStone: 55, ore: 45, xuantie: 0 },
    { spiritStone: 75, ore: 60, xuantie: 0 },
    { spiritStone: 113, ore: 75, xuantie: 1 },
    { spiritStone: 150, ore: 90, xuantie: 1 },
    { spiritStone: 188, ore: 120, xuantie: 2 },
    { spiritStone: 245, ore: 150, xuantie: 2 },
    { spiritStone: 300, ore: 180, xuantie: 3 },
    { spiritStone: 375, ore: 225, xuantie: 3 },
    { spiritStone: 470, ore: 270, xuantie: 4 },
  ],
  treasure: [
    { spiritStone: 28, ore: 21, xuantie: 0 },
    { spiritStone: 39, ore: 32, xuantie: 0 },
    { spiritStone: 53, ore: 42, xuantie: 0 },
    { spiritStone: 77, ore: 63, xuantie: 0 },
    { spiritStone: 105, ore: 84, xuantie: 0 },
    { spiritStone: 158, ore: 105, xuantie: 1 },
    { spiritStone: 210, ore: 126, xuantie: 1 },
    { spiritStone: 263, ore: 168, xuantie: 2 },
    { spiritStone: 343, ore: 210, xuantie: 3 },
    { spiritStone: 420, ore: 252, xuantie: 4 },
    { spiritStone: 525, ore: 315, xuantie: 4 },
    { spiritStone: 658, ore: 378, xuantie: 6 },
  ],
  immortal: [
    { spiritStone: 40, ore: 30, xuantie: 0 },
    { spiritStone: 55, ore: 45, xuantie: 0 },
    { spiritStone: 75, ore: 60, xuantie: 0 },
    { spiritStone: 110, ore: 90, xuantie: 0 },
    { spiritStone: 150, ore: 120, xuantie: 0 },
    { spiritStone: 225, ore: 150, xuantie: 1 },
    { spiritStone: 300, ore: 180, xuantie: 2 },
    { spiritStone: 375, ore: 240, xuantie: 3 },
    { spiritStone: 490, ore: 300, xuantie: 4 },
    { spiritStone: 600, ore: 360, xuantie: 5 },
    { spiritStone: 750, ore: 450, xuantie: 6 },
    { spiritStone: 940, ore: 540, xuantie: 8 },
  ],
};

/** 主属性增量：[冲 1～5 重, 冲 6～12 重]。 */
const REFINE_MAIN_GAIN: Readonly<Record<EquipmentQuality, readonly [number, number]>> = {
  common: [1, 1],
  spirit: [2, 3],
  treasure: [2, 3],
  immortal: [3, 4],
};

/** 副属性增量：[冲到 5 重, 冲到 12 重]。 */
const REFINE_SUB_GAIN: Readonly<Record<EquipmentQuality, readonly [number, number]>> = {
  common: [1, 2],
  spirit: [2, 3],
  treasure: [3, 4],
  immortal: [4, 6],
};

/** 当前重数 → 祭炼战力加成（基点，累计值）；下标 = 重数 0..12。 */
const REFINE_POWER_BP: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 200, 300, 600];

/** 中文重数（下标 = 重数）：一～十二重，与前端 RefineTag 同一张表。 */
const REFINE_CHINESE_LEVELS: readonly string[] = [
  '', '一重', '二重', '三重', '四重', '五重', '六重',
  '七重', '八重', '九重', '十重', '十一重', '十二重',
];

/** 第 N 重的中文名（1 → 「一重」… 12 → 「十二重」）；0 与越界返回空串。 */
export function refineChineseLevel(level: number): string {
  return REFINE_CHINESE_LEVELS[level] ?? '';
}

/** 冲到第 targetLevel 重的基础成功率（基点，不含隐藏补偿）；targetLevel 不在 1..12 返回 0。 */
export function refineSuccessBp(targetLevel: number, fails: number): number {
  const odds = REFINE_ODDS[targetLevel - 1];
  if (odds === undefined) return 0;
  return Math.min(odds.capBp, odds.baseBp + Math.max(0, fails) * odds.stepBp);
}

/** 按成功率判定本次祭炼是否成功；random 注入便于测试（取值 [0, 1)）。 */
export function rollRefine(targetLevel: number, fails: number, random: () => number): boolean {
  return random() * 10000 < refineSuccessBp(targetLevel, fails);
}

/** 祭炼后的连续失败次数：成功清零；失败 +1，封顶 REFINE_FAILS_CAP。 */
export function nextRefineFails(fails: number, success: boolean): number {
  return success ? 0 : Math.min(REFINE_FAILS_CAP, fails + 1);
}

/**
 * 冲到第 targetLevel 重的消耗（最小单位 = 展示值 × 1000），只放 > 0 的资源。
 * 例：仙品 9 重 → { spiritStone: 490000, ore: 300000, xuantie: 4000 }。
 */
export function refineCostUnits(quality: EquipmentQuality, targetLevel: number): Record<string, number> {
  const units: Record<string, number> = {};
  const row = REFINE_COSTS[quality][targetLevel - 1];
  if (row === undefined) return units;
  const costs: [string, number][] = [
    ['spiritStone', row.spiritStone],
    ['ore', row.ore],
    [XUANTIE_RESOURCE_ID, row.xuantie],
  ];
  for (const [resourceId, amount] of costs) {
    if (amount > 0) units[resourceId] = amount * ORE_UNITS_PER_DISPLAY;
  }
  return units;
}

/** 冲到第 targetLevel 重成功后主属性增加多少：冲 1～5 重与 6～12 重两档。 */
export function refineMainGain(quality: EquipmentQuality, targetLevel: number): number {
  if (targetLevel < 1 || targetLevel > REFINE_MAX_LEVEL) return 0;
  const [early, late] = REFINE_MAIN_GAIN[quality];
  return targetLevel <= 5 ? early : late;
}

/** 冲到第 targetLevel 重成功后副属性增加多少：只有冲到 5 重 / 12 重时有，其余各重为 0。 */
export function refineSubGain(quality: EquipmentQuality, targetLevel: number): number {
  const [atFive, atTwelve] = REFINE_SUB_GAIN[quality];
  if (targetLevel === 5) return atFive;
  if (targetLevel === REFINE_MAX_LEVEL) return atTwelve;
  return 0;
}

/** 当前重数对应的祭炼战力加成（基点，累计值）；越界（<0 或 >12）返回 0。 */
export function refinePowerBonusBp(level: number): number {
  return REFINE_POWER_BP[level] ?? 0;
}
