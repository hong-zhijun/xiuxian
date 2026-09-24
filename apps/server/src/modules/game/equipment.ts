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
 * 除炼器与世界 Boss 以外的其他来源。
 */

export type EquipmentSlot = 'weapon' | 'armor' | 'artifact';
export type EquipmentQuality = 'common' | 'spirit' | 'treasure' | 'immortal';
/** 装备能加成的 5 项属性（与弟子表的 5 个 gear_ 列一一对应）。 */
export type EquipmentAttr = 'attack' | 'defense' | 'speed' | 'luck' | 'physique';
export type EquipmentSource = 'forge' | 'boss';

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
  /** 面板颜色（前端只渲染，不做品质判断）。 */
  color: string;
}

export const EQUIPMENT_QUALITIES: readonly EquipmentQualityDef[] = [
  { id: 'common', name: '凡品', mainValue: 4, subMin: 1, subMax: 2, salvageOre: 50, color: '#b9c0c9' },
  { id: 'spirit', name: '灵品', mainValue: 8, subMin: 2, subMax: 4, salvageOre: 120, color: '#4ade80' },
  { id: 'treasure', name: '宝品', mainValue: 12, subMin: 3, subMax: 6, salvageOre: 250, color: '#60a5fa' },
  { id: 'immortal', name: '仙品', mainValue: 18, subMin: 4, subMax: 8, salvageOre: 500, color: '#fbbf24' },
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
/** 一期只能炼凡品，必定成功（品质不随机）。 */
export const FORGE_QUALITY: EquipmentQuality = 'common';
/** 单次炼器的消耗（最小单位：矿石 150 + 灵石 80）。 */
export const FORGE_COST: Readonly<Record<string, string>> = { ore: '150000', spiritStone: '80000' };
/** 背包上限 = 本宗门**未穿戴**装备的件数上限（穿在身上的不占背包）。 */
export const BAG_CAPACITY = 50;
/** 世界 Boss 掉落：非第 1 名参与者的掉落概率。 */
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

/** 世界 Boss 击杀掉落的品质（计划 1.4）：按**该关**的伤害名次给。 */
export function bossDropQualities(stage: number): { top: EquipmentQuality; others: EquipmentQuality } {
  if (stage <= 2) {
    return { top: 'spirit', others: 'common' };
  }
  if (stage <= 4) {
    return { top: 'treasure', others: 'spirit' };
  }
  return { top: 'immortal', others: 'treasure' };
}

/** 「奖励」预览里的掉落说明（与发奖同一套品质表，前端不复制公式）。 */
export function bossDropDescription(stage: number): string {
  const { top, others } = bossDropQualities(stage);
  const percent = Math.round(BOSS_DROP_CHANCE_OTHERS * 100);
  return `伤害第 1 名必得 ${qualityNameOf(top)}装备 ×1；其他参与者 ${String(percent)}% 概率得 ${qualityNameOf(others)}装备 ×1`;
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
