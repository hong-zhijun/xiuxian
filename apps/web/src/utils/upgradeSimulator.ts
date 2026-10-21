import { formatHours } from './advisor';
import { formatAmount } from './format';

/**
 * 弟子提升模拟器（纯函数：不碰 Vue / DOM，不发请求，也不写任何数据；关掉弹窗就丢弃）。
 *
 * 玩家随意调境界、三件装备（保持当前 / 空着 / 自定义一件）和悟道值，这里算出：
 * 1. 当前与模拟后的属性（基础 + 装备两部分）与战力。战力公式与服务端 realms.ts 的 discipleCombatPower
 *    逐步一致（同样的运算顺序与 Math.floor），默认方案下算出的战力必须等于服务端给的 combatPower；
 * 2. 每一项改动**单独**作用在当前状态上的战力增幅与代价，按增幅从高到低排，最高的一行标「提升最大」；
 * 3. 「全部一起」：所有改动叠加后的总增幅与总代价（各项相乘，不是相加）。
 *
 * 数值口径照抄服务端，只读接口里已经算好的字段，前端不抄规则表：装备增量取 refineGuide 的 rows
 * （每行是「冲到这一重」的增量），品质的主属性 / 副属性区间 / 战力加成也从 refineGuide 来；
 * 战意天赋的加成取 talents 里对应境界的 bp（服务端只认战意）；炼器消耗与成功率取 forgeOptions。
 * 金额是最小单位（1 展示单位 = 1000），展示用 format.ts 的 formatAmount。
 */

/* ---------- 常量（照抄服务端，见各自注释） ---------- */

/** 装备部位（与服务端 EquipmentSlot 一致）。 */
export type SlotId = 'weapon' | 'armor' | 'artifact';
export const SLOT_IDS: readonly SlotId[] = ['weapon', 'armor', 'artifact'];
const SLOT_NAMES: Readonly<Record<SlotId, string>> = { weapon: '兵器', armor: '护甲', artifact: '法器' };

/** 五项属性（与服务端 EquipmentAttr 一致）。 */
export type SimAttr = 'attack' | 'defense' | 'speed' | 'luck' | 'physique';
export const SIM_ATTRS: readonly SimAttr[] = ['attack', 'defense', 'speed', 'luck', 'physique'];
export const SIM_ATTR_NAMES: Readonly<Record<SimAttr, string>> = {
  attack: '攻击',
  defense: '防御',
  speed: '身法',
  luck: '幸运',
  physique: '体魄',
};

/** 悟道值可加的三项（攻击 / 防御 / 身法，与悟道加点一致）。 */
export type InsightAttr = 'attack' | 'defense' | 'speed';
export const INSIGHT_ATTRS: readonly InsightAttr[] = ['attack', 'defense', 'speed'];

/** 部位可选的主属性（兵器固定攻击、护甲固定防御、法器身法或幸运；服务端 resolveMainAttr）。 */
export const SLOT_MAIN_CHOICES: Readonly<Record<SlotId, readonly SimAttr[]>> = {
  weapon: ['attack'],
  armor: ['defense'],
  artifact: ['speed', 'luck'],
};

/** 战意天赋 id：服务端 discipleCombatPower 只有它的加成进战力（talents.ts 的 'combat'）。 */
const COMBAT_TALENT_ID = 'combat';
/** 基础属性上限（服务端 ATTRIBUTE_MAX）：悟道值加完基础属性不能超过它。 */
const ATTRIBUTE_MAX = 100;
/** 祭炼最高重数（服务端 REFINE_MAX_LEVEL）。 */
const REFINE_MAX = 12;
/** 突破消耗的灵气资源 id（服务端 breakthroughEnergyCost 扣的是 spiritualEnergy）。 */
const ENERGY_ID = 'spiritualEnergy';
/** 自定义装备缺省品质（凡品）。 */
const DEFAULT_QUALITY = 'common';
/** 资源名兜底（state.resources 里没有这项时用）。 */
const RESOURCE_NAMES: Readonly<Partial<Record<string, string>>> = {
  spiritStone: '灵石',
  spiritualEnergy: '灵气',
  herb: '药材',
  ore: '矿石',
  xuantie: '玄铁',
  shenmu: '神木',
};

/* ---------- 输入（只声明用到的字段；SectStateView / EquipmentView 传入时结构兼容） ---------- */

/** 模拟用到的弟子字段。attack / defense / speed / luck / physique 是**基础**属性，gear 是装备加成。 */
export interface SimDisciple {
  id: string;
  realmId: string;
  stage: number;
  /** 天赋 id；只有战意（combat）的加成进战力。 */
  talent: string;
  attack: number;
  defense: number;
  speed: number;
  luck: number;
  physique: number;
  /** 身上装备的五项属性加成之和（服务端已算好）。 */
  gear: Readonly<Record<SimAttr, number>>;
  /** 身上装备的战力加成（基点，服务端已算好）。 */
  gearPowerBonusBp: number;
  /**
   * 灵兽战力加成（基点，服务端已算好）：与装备加成一起进同一个括号，战力里已经含它。
   * 模拟器不改灵兽，但必须把它算进战力，否则默认方案会与服务端差一截。
   */
  beastPowerBonusBp: number;
  /** 每小时修为（修炼岗位才有，否则 0）。 */
  cultivationRatePerHour: number;
  /** 悟道值余额（手上有几点）。 */
  daoInsight: number;
  /** 还能累计分配的额度（上限 − 已分配）。 */
  daoInsightRemaining: number;
}

/** 境界里的一层。 */
export interface SimRealmStage {
  stage: number;
  name: string;
  /** 突破门槛（修为）；null = 本版本最高阶段。 */
  requiredCultivation: number | null;
  /** 突破灵气（最小单位字符串）；最高阶段为 null。 */
  breakthroughCost: string | null;
}

/** 境界一览的一行（按境界顺序排列，下标即服务端 REALMS 下标）。 */
export interface SimRealm {
  id: string;
  name: string;
  stages: readonly SimRealmStage[];
}

/** 天赋总表的一行（只用到 id 与各境界的加成原值）。 */
export interface SimTalent {
  id: string;
  values: readonly { realmId: string; bp: number }[];
}

/** 资源（取名字用）。 */
export interface SimResource {
  id: string;
  name: string;
}

/** 装备视图里的一件（穿在身上的或背包里的）。 */
export interface SimEquipmentItem {
  id: string;
  slot: string;
  quality: string;
  name: string;
  mainAttr: string;
  mainValue: number;
  subAttr: string;
  subValue: number;
  /** 品质加成 + 祭炼累计（基点）。 */
  powerBonusBp: number;
  refineLevel: number;
  discipleId: string | null;
}

/** 祭炼说明表的一行：冲到第 level 重的增量与消耗。 */
export interface SimRefineRow {
  level: number;
  /** 本重消耗（最小单位字符串，只含 > 0 的资源）。 */
  cost: Readonly<Record<string, string>>;
  mainGain: number;
  subGain: number;
  powerBonusGainBp: number;
}

/** 装备品质（祭炼说明表里的一项，已带品质的主属性 / 副属性区间 / 战力加成）。 */
export interface SimQuality {
  id: string;
  name: string;
  mainValue: number;
  subMin: number;
  subMax: number;
  powerBonusBp: number;
  rows: readonly SimRefineRow[];
}

/** 炼器选项（某品质的消耗与成功率，已按炼器坊等级与执事算好）。 */
export interface SimForgeOption {
  quality: string;
  name: string;
  unlocked: boolean;
  cost: Readonly<Record<string, string>>;
  odds: { success: number };
}

/** 装备视图（只读）。 */
export interface SimEquipment {
  /** 炼器是否已开放；未开放时装备格整块不参与模拟。 */
  unlocked: boolean;
  slots: readonly { id: string; name: string }[];
  items: readonly SimEquipmentItem[];
  forgeOptions: readonly SimForgeOption[];
  refineGuide: { qualities: readonly SimQuality[] };
}

/** 模拟的全部输入。 */
export interface SimInput {
  disciple: SimDisciple;
  realmCatalog: readonly SimRealm[];
  talents: readonly SimTalent[];
  /** 装备视图；null = 还没加载（装备格不参与，不报错）。 */
  equipment: SimEquipment | null;
  resources: readonly SimResource[];
  /** 当前修为（弟子详情的实时修为；没有实时值时传服务端值）。 */
  cultivation: number;
}

/* ---------- 模拟选项（UI 收集；缺省值见 defaultPlan） ---------- */

/** 目标境界层（必须在当前层或之上；更低的会被夹回当前层）。 */
export interface SimTarget {
  realmId: string;
  stage: number;
}

/** 自定义一件：品质、主 / 副属性、副属性数值与祭炼重数。 */
export interface CustomSlotPlan {
  mode: 'custom';
  /** 品质 id：common / spirit / treasure / immortal。 */
  quality: string;
  /** 主属性（部位决定可选项，见 SLOT_MAIN_CHOICES）。 */
  mainAttr: SimAttr;
  /** 副属性：与主属性不同的一项。 */
  subAttr: SimAttr;
  /** 副属性数值（该品质 subMin ~ subMax）。 */
  subValue: number;
  /** 祭炼重数（0 ~ 12）。 */
  refineLevel: number;
}

/**
 * 一格的模拟方式：
 * - keep：保持身上穿着的那件，只能把祭炼重数往上调（没穿装备时等同于空着）；
 * - empty：卸下；
 * - custom：换成自定义的一件（替换身上那件时，旧装备只是回到背包）。
 */
export type SlotPlan = { mode: 'keep'; refineLevel: number } | { mode: 'empty' } | CustomSlotPlan;

/** 整个模拟方案。 */
export interface SimPlan {
  target: SimTarget;
  slots: Readonly<Record<SlotId, SlotPlan>>;
  insight: Readonly<Record<InsightAttr, number>>;
}

/* ---------- 输出 ---------- */

/** 一项属性：基础（悟道值已加进来）+ 装备加成。 */
export interface AttrValue {
  base: number;
  gear: number;
}

/** 某个状态下的境界、属性与战力。 */
export interface Snapshot {
  realmName: string;
  stageName: string;
  attrs: Readonly<Record<SimAttr, AttrValue>>;
  combatPower: number;
}

/** 拆解里的一行（一项改动，或「全部一起」）。 */
export interface Row {
  id: string;
  label: string;
  /** 战力增幅（0.12 = +12%；负数 = 战力下降）。 */
  gainRatio: number;
  /** 资源代价（最小单位，按 resourceId 合并）。 */
  cost: Record<string, number>;
  /** 其余代价与说明（修为与时间、还需的悟道值、炼器成功率……）。 */
  notes: string[];
  /** 拆解里增幅最高的一行（且增幅为正）标「提升最大」。 */
  best: boolean;
}

export interface SimResult {
  current: Snapshot;
  simulated: Snapshot;
  /** 每项改动单独的拆解，按增幅从高到低；没有任何改动时为空。 */
  breakdown: Row[];
  /** 全部一起（总增幅 + 总代价）。 */
  total: Row;
}

/** 校验文案：每个文案挂在对应的输入旁；有文案的输入在计算时会被夹到合法范围。 */
export interface PlanIssues {
  insight: Partial<Record<InsightAttr | 'total', string>>;
  slots: Partial<Record<SlotId, Partial<Record<'main' | 'sub' | 'subValue' | 'refine', string>>>>;
}

/** 目标境界的下拉选项（从当前层起往上的所有层）。 */
export interface TargetOption {
  /** 下拉框的值（realmId:stage）。 */
  key: string;
  realmId: string;
  stage: number;
  label: string;
}

/** 自定义品质的选项。unlocked = 炼器坊等级已够。 */
export interface QualityChoice {
  id: string;
  name: string;
  subMin: number;
  subMax: number;
  unlocked: boolean;
}

/* ---------- 小工具 ---------- */

function isSimAttr(value: string): value is SimAttr {
  return (SIM_ATTRS as readonly string[]).includes(value);
}

/** 整数夹到 [min, max]；NaN 与非有限值按 min 处理。 */
function clampInt(value: number, min: number, max: number): number {
  const whole = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.min(max, Math.max(min, whole));
}

/** 悟道值点数：非有限值与负数按 0，小数向下取整。 */
function nonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** 基点 → 百分数文案（400 → "4%"，150 → "1.5%"）；调用方自己拼 +。 */
function bpText(bp: number): string {
  return `${String(Number((bp / 100).toFixed(2)))}%`;
}

/** 成功率（0~1）→ 百分数整数文案（0.7 → "70"）。 */
function percentOf(ratio: number): string {
  return String(Math.round(ratio * 100));
}

/** 多份代价按资源 id 合并求和。 */
function mergeCosts(list: readonly Readonly<Record<string, number>>[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const cost of list) {
    for (const [id, amount] of Object.entries(cost)) {
      merged[id] = (merged[id] ?? 0) + amount;
    }
  }
  return merged;
}

/** 祭炼说明表里的消耗（最小单位字符串）→ 数字，只留 > 0 的资源。 */
function costUnitsOf(cost: Readonly<Record<string, string>>): Record<string, number> {
  const units: Record<string, number> = {};
  for (const [id, amount] of Object.entries(cost)) {
    const value = Number(amount);
    if (value > 0) units[id] = value;
  }
  return units;
}

/** 增幅：power / base − 1；基准为 0 时按 0 处理。 */
function gainOf(power: number, base: number): number {
  return base > 0 ? power / base - 1 : 0;
}

/** 装备 / 悟道 / 境界的增幅文案：+12%、+3.5%（不足 10% 保留一位小数），负数照样显示。 */
export function formatGainRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—';
  const pct = ratio * 100;
  const abs = Math.abs(pct);
  const text = abs >= 10 ? String(Math.round(abs)) : String(Math.round(abs * 10) / 10);
  if (text === '0') return '0%';
  return `${pct < 0 ? '-' : '+'}${text}%`;
}

/** 代价文案：「1200 灵石 + 300 矿石 + 4 玄铁」（资源名从 resources 取；没有代价返回空串）。 */
export function formatCostText(cost: Readonly<Record<string, number>>, resources: readonly SimResource[]): string {
  return Object.entries(cost)
    .filter(([, amount]) => amount > 0)
    .map(([id, amount]) => `${formatAmount(amount)} ${resources.find((item) => item.id === id)?.name ?? RESOURCE_NAMES[id] ?? id}`)
    .join(' + ');
}

/** 修为一行的文案：不含突破失败，按当前修炼速度估算时间。 */
function cultivationNote(need: number, ratePerHour: number): string {
  if (need <= 0) return '修为已够，可以直接突破';
  if (ratePerHour <= 0) return `修为还差 ${String(need)}，当前不在修炼岗位，没有修炼速度`;
  return `修为还差 ${String(need)}，${formatHours(need / ratePerHour)}（按当前修炼速度，不含突破失败）`;
}

/* ---------- 境界与装备的查找 ---------- */

/** 按境界顺序展开的一层（境界下标即服务端 REALMS 下标，战力公式用它）。 */
interface FlatStage {
  realmId: string;
  realmName: string;
  realmIndex: number;
  stage: number;
  stageName: string;
  requiredCultivation: number | null;
  breakthroughCost: number | null;
}

function flattenStages(realmCatalog: readonly SimRealm[]): FlatStage[] {
  return realmCatalog.flatMap((realm, realmIndex) =>
    realm.stages.map((stage) => ({
      realmId: realm.id,
      realmName: realm.name,
      realmIndex,
      stage: stage.stage,
      stageName: stage.name,
      requiredCultivation: stage.requiredCultivation,
      breakthroughCost: stage.breakthroughCost === null ? null : Number(stage.breakthroughCost),
    })),
  );
}

/** 模拟过程里共用的只读上下文。 */
interface SimContext {
  input: SimInput;
  stages: readonly FlatStage[];
  /** 弟子当前所在层在 stages 里的下标。 */
  currentIndex: number;
  /** 装备参与模拟的条件：装备视图已加载且炼器已开放；否则为 null（装备格不参与）。 */
  equipment: SimEquipment | null;
}

function contextOf(input: SimInput): SimContext {
  const stages = flattenStages(input.realmCatalog);
  const { disciple } = input;
  const found = stages.findIndex((item) => item.realmId === disciple.realmId && item.stage === disciple.stage);
  return {
    input,
    stages,
    currentIndex: Math.max(0, found),
    equipment: input.equipment !== null && input.equipment.unlocked ? input.equipment : null,
  };
}

function stageAt(ctx: SimContext, index: number): FlatStage {
  return ctx.stages[index];
}

/** 目标层在 stages 里的下标；找不到或比当前低时夹回当前层。 */
function targetIndexOf(ctx: SimContext, target: SimTarget): number {
  const index = ctx.stages.findIndex((item) => item.realmId === target.realmId && item.stage === target.stage);
  return index < ctx.currentIndex ? ctx.currentIndex : index;
}

function qualityOf(equipment: SimEquipment, qualityId: string): SimQuality | undefined {
  return equipment.refineGuide.qualities.find((quality) => quality.id === qualityId);
}

function forgeOptionOf(equipment: SimEquipment, qualityId: string): SimForgeOption | undefined {
  return equipment.forgeOptions.find((option) => option.quality === qualityId);
}

/** 身上这一格的装备（没有则 null）。 */
export function wornItemOf(
  equipment: SimEquipment | null,
  discipleId: string,
  slot: SlotId,
): SimEquipmentItem | null {
  if (equipment === null) return null;
  return equipment.items.find((item) => item.slot === slot && item.discipleId === discipleId) ?? null;
}

/** 部位名（装备视图里的名字优先，缺省用兵器 / 护甲 / 法器）。 */
export function slotNameOf(equipment: SimEquipment | null, slot: SlotId): string {
  return equipment?.slots.find((item) => item.id === slot)?.name ?? SLOT_NAMES[slot];
}

/** 副属性的候选：五项里不同于主属性的四项。 */
export function subAttrChoices(mainAttr: SimAttr): SimAttr[] {
  return SIM_ATTRS.filter((attr) => attr !== mainAttr);
}

/** 自定义品质的选项（区间与是否已炼器解锁）。 */
export function qualityChoices(equipment: SimEquipment | null): QualityChoice[] {
  if (equipment === null) return [];
  return equipment.refineGuide.qualities.map((quality) => ({
    id: quality.id,
    name: quality.name,
    subMin: quality.subMin,
    subMax: quality.subMax,
    unlocked: forgeOptionOf(equipment, quality.id)?.unlocked ?? false,
  }));
}

/** 副属性数值的缺省：该品质区间的中间值向下取整。 */
export function midSubValue(equipment: SimEquipment | null, qualityId: string): number {
  const quality = equipment === null ? undefined : qualityOf(equipment, qualityId);
  return quality === undefined ? 0 : Math.floor((quality.subMin + quality.subMax) / 2);
}

/** 目标境界的下拉选项：从当前层起往上的所有层（按境界顺序展开）。 */
export function targetOptions(input: SimInput): TargetOption[] {
  const ctx = contextOf(input);
  return ctx.stages.slice(ctx.currentIndex).map((stage) => ({
    key: `${stage.realmId}:${String(stage.stage)}`,
    realmId: stage.realmId,
    stage: stage.stage,
    label: stage.stageName,
  }));
}

/* ---------- 缺省方案与自定义默认值 ---------- */

function keepPlanOf(equipment: SimEquipment | null, discipleId: string, slot: SlotId): SlotPlan {
  return { mode: 'keep', refineLevel: wornItemOf(equipment, discipleId, slot)?.refineLevel ?? 0 };
}

/** 缺省方案：目标 = 当前层；三格都是「保持当前」（祭炼重数 = 现在的重数）；悟道值全 0。 */
export function defaultPlan(input: SimInput): SimPlan {
  const { disciple, equipment } = input;
  return {
    target: { realmId: disciple.realmId, stage: disciple.stage },
    slots: {
      weapon: keepPlanOf(equipment, disciple.id, 'weapon'),
      armor: keepPlanOf(equipment, disciple.id, 'armor'),
      artifact: keepPlanOf(equipment, disciple.id, 'artifact'),
    },
    insight: { attack: 0, defense: 0, speed: 0 },
  };
}

/**
 * 切到「自定义一件」时的缺省：主属性取部位的第一项，副属性取第一个不同的，
 * 副属性数值取该品质的中间值，祭炼 0 重。
 */
export function defaultCustomSlot(
  slot: SlotId,
  qualityId: string,
  equipment: SimEquipment | null,
): CustomSlotPlan {
  const mainAttr = SLOT_MAIN_CHOICES[slot][0];
  return {
    mode: 'custom',
    quality: qualityId,
    mainAttr,
    subAttr: subAttrChoices(mainAttr)[0],
    subValue: midSubValue(equipment, qualityId),
    refineLevel: 0,
  };
}

/** 缺省的自定义品质：凡品。 */
export const DEFAULT_CUSTOM_QUALITY = DEFAULT_QUALITY;

/* ---------- 方案解析（把 UI 给的值夹到合法范围，计算只认解析后的值） ---------- */

function saneMain(slot: SlotId, mainAttr: SimAttr): SimAttr {
  const choices = SLOT_MAIN_CHOICES[slot];
  return choices.includes(mainAttr) ? mainAttr : choices[0];
}

function saneSub(mainAttr: SimAttr, subAttr: SimAttr): SimAttr {
  return isSimAttr(subAttr) && subAttr !== mainAttr ? subAttr : subAttrChoices(mainAttr)[0];
}

/** 悟道值：每项不超过基础属性的上限，合计不超过还能累计分配的额度（超出的从后面的项扣）。 */
function insightPointsOf(disciple: SimDisciple, insight: SimPlan['insight']): Record<InsightAttr, number> {
  const points: Record<InsightAttr, number> = {
    attack: nonNegativeInt(insight.attack),
    defense: nonNegativeInt(insight.defense),
    speed: nonNegativeInt(insight.speed),
  };
  let left = Math.max(0, disciple.daoInsightRemaining);
  for (const attr of INSIGHT_ATTRS) {
    const room = Math.max(0, ATTRIBUTE_MAX - disciple[attr]);
    const take = Math.min(points[attr], room, left);
    points[attr] = take;
    left -= take;
  }
  return points;
}

/* ---------- 装备的一件（对弟子的贡献） ---------- */

/** 一件装备对弟子的贡献：主 / 副属性各加多少，战力加成（基点）多少。 */
interface Piece {
  mainAttr: SimAttr;
  mainValue: number;
  subAttr: SimAttr;
  subValue: number;
  powerBonusBp: number;
}

function pieceOf(item: SimEquipmentItem): Piece | null {
  if (!isSimAttr(item.mainAttr) || !isSimAttr(item.subAttr)) return null;
  return {
    mainAttr: item.mainAttr,
    mainValue: item.mainValue,
    subAttr: item.subAttr,
    subValue: item.subValue,
    powerBonusBp: item.powerBonusBp,
  };
}

/** 祭炼从第 from+1 重冲到第 to 重的累计增量与消耗（from = 0 即整件从零开始）。 */
interface RefineGains {
  mainGain: number;
  subGain: number;
  powerBonusGainBp: number;
  cost: Record<string, number>;
}

function refineGainsOf(quality: SimQuality | undefined, from: number, to: number): RefineGains {
  const gains: RefineGains = { mainGain: 0, subGain: 0, powerBonusGainBp: 0, cost: {} };
  if (quality === undefined) return gains;
  const costs: Record<string, number>[] = [];
  for (const row of quality.rows) {
    if (row.level > from && row.level <= to) {
      gains.mainGain += row.mainGain;
      gains.subGain += row.subGain;
      gains.powerBonusGainBp += row.powerBonusGainBp;
      costs.push(costUnitsOf(row.cost));
    }
  }
  gains.cost = mergeCosts(costs);
  return gains;
}

/* ---------- 状态与战力 ---------- */

/** 模拟的一个状态：所在层、五项基础属性、五项装备加成与装备战力加成。 */
interface State {
  stageIndex: number;
  base: Readonly<Record<SimAttr, number>>;
  gear: Readonly<Record<SimAttr, number>>;
  gearBp: number;
}

function initialState(ctx: SimContext): State {
  const { disciple } = ctx.input;
  return {
    stageIndex: ctx.currentIndex,
    base: {
      attack: disciple.attack,
      defense: disciple.defense,
      speed: disciple.speed,
      luck: disciple.luck,
      physique: disciple.physique,
    },
    gear: {
      attack: disciple.gear.attack,
      defense: disciple.gear.defense,
      speed: disciple.gear.speed,
      luck: disciple.gear.luck,
      physique: disciple.gear.physique,
    },
    gearBp: disciple.gearPowerBonusBp,
  };
}

/** 战意加成（基点）：只有弟子天赋是战意时才有，取目标境界的 bp。 */
function combatBpOf(ctx: SimContext, realmId: string): number {
  if (ctx.input.disciple.talent !== COMBAT_TALENT_ID) return 0;
  const talent = ctx.input.talents.find((item) => item.id === COMBAT_TALENT_ID);
  return talent?.values.find((value) => value.realmId === realmId)?.bp ?? 0;
}

/**
 * 战力：与服务端 realms.ts 的 discipleCombatPower 逐步一致（同样的运算顺序与 Math.floor，结果逐位相等）。
 * base = (境界下标 × 3 + 层数) × 10；属性 = 基础 + 装备；
 * power = floor(base × (1 + 属性加权) × (1 + 装备战力加成 + 灵兽战力加成))；
 * 战意再 power = floor(power × (10000 + bp) / 10000)。
 *
 * 灵兽不进模拟（模拟器只改境界 / 装备 / 悟道值），所以灵兽档位是一个常量项，
 * 但必须算进去，否则「默认方案的战力 = 服务端战力」这条硬条件在带灵兽的弟子上就不成立。
 */
function combatPowerOf(ctx: SimContext, state: State): number {
  const stage = stageAt(ctx, state.stageIndex);
  const base = (stage.realmIndex * 3 + stage.stage) * 10;
  const attack = state.base.attack + state.gear.attack;
  const defense = state.base.defense + state.gear.defense;
  const speed = state.base.speed + state.gear.speed;
  const attrBonus = (attack * 0.4 + defense * 0.35 + speed * 0.25) / 100;
  const bonusBp = state.gearBp + ctx.input.disciple.beastPowerBonusBp;
  let power = Math.floor(base * (1 + attrBonus) * (1 + bonusBp / 10_000));
  const combatBp = combatBpOf(ctx, stage.realmId);
  if (combatBp > 0) {
    power = Math.floor((power * (10_000 + combatBp)) / 10_000);
  }
  return power;
}

function attrsOf(state: State): Record<SimAttr, AttrValue> {
  return {
    attack: { base: state.base.attack, gear: state.gear.attack },
    defense: { base: state.base.defense, gear: state.gear.defense },
    speed: { base: state.base.speed, gear: state.gear.speed },
    luck: { base: state.base.luck, gear: state.gear.luck },
    physique: { base: state.base.physique, gear: state.gear.physique },
  };
}

function snapshotOf(ctx: SimContext, state: State): Snapshot {
  const stage = stageAt(ctx, state.stageIndex);
  return {
    realmName: stage.realmName,
    stageName: stage.stageName,
    attrs: attrsOf(state),
    combatPower: combatPowerOf(ctx, state),
  };
}

/** 装备加成里去掉一件（sign = -1）或加上一件（sign = 1）的属性与战力。 */
function gearWith(gear: Readonly<Record<SimAttr, number>>, piece: Piece | null, sign: 1 | -1): Record<SimAttr, number> {
  const next: Record<SimAttr, number> = { ...gear };
  if (piece !== null) {
    next[piece.mainAttr] += sign * piece.mainValue;
    next[piece.subAttr] += sign * piece.subValue;
  }
  return next;
}

/** 这一格从 before 换成 after（null = 空）：旧的贡献扣掉，新的加上。 */
function withPiece(state: State, before: Piece | null, after: Piece | null): State {
  return {
    ...state,
    gear: gearWith(gearWith(state.gear, before, -1), after, 1),
    gearBp: state.gearBp - (before?.powerBonusBp ?? 0) + (after?.powerBonusBp ?? 0),
  };
}

/* ---------- 改动：每一项改动 = 代价 + 说明 + 作用在状态上的方式 ---------- */

interface Change {
  id: string;
  label: string;
  cost: Record<string, number>;
  notes: string[];
  apply: (state: State) => State;
}

/** 升境界：修为 = 当前层还差的 + 中间每层的门槛（目标层自己的不算）；灵气 = 当前层到目标前一层的突破消耗之和。 */
function realmChange(ctx: SimContext, targetIndex: number): Change {
  const from = stageAt(ctx, ctx.currentIndex);
  const to = stageAt(ctx, targetIndex);
  let need = Math.max(0, (from.requiredCultivation ?? 0) - ctx.input.cultivation);
  let energy = 0;
  for (let index = ctx.currentIndex; index < targetIndex; index += 1) {
    const stage = stageAt(ctx, index);
    energy += stage.breakthroughCost ?? 0;
    if (index > ctx.currentIndex) {
      need += stage.requiredCultivation ?? 0;
    }
  }
  return {
    id: 'realm',
    label: `境界：${from.stageName} → ${to.stageName}`,
    cost: energy > 0 ? { [ENERGY_ID]: energy } : {},
    notes: [cultivationNote(need, ctx.input.disciple.cultivationRatePerHour)],
    apply: (state) => ({ ...state, stageIndex: targetIndex }),
  };
}

/** 保持当前：只把祭炼往上调（c+1..r 的增量与消耗）；没有变化时返回 null。 */
function keepRefineChange(
  slot: SlotId,
  name: string,
  worn: SimEquipmentItem,
  wornPiece: Piece,
  equipment: SimEquipment,
  targetLevel: number,
): Change {
  const from = clampInt(worn.refineLevel, 0, REFINE_MAX);
  const gains = refineGainsOf(qualityOf(equipment, worn.quality), from, targetLevel);
  const after: Piece = {
    ...wornPiece,
    mainValue: wornPiece.mainValue + gains.mainGain,
    subValue: wornPiece.subValue + gains.subGain,
    powerBonusBp: wornPiece.powerBonusBp + gains.powerBonusGainBp,
  };
  const parts: string[] = [];
  if (gains.mainGain > 0) parts.push(`${SIM_ATTR_NAMES[wornPiece.mainAttr]} +${String(gains.mainGain)}`);
  if (gains.subGain > 0) parts.push(`${SIM_ATTR_NAMES[wornPiece.subAttr]} +${String(gains.subGain)}`);
  if (gains.powerBonusGainBp > 0) parts.push(`战力加成 +${bpText(gains.powerBonusGainBp)}`);
  return {
    id: slot,
    label: `${name}：祭炼 ${String(from)} → ${String(targetLevel)} 重`,
    cost: gains.cost,
    notes: [`祭炼增量：${parts.join(' · ')}`],
    apply: (state) => withPiece(state, wornPiece, after),
  };
}

/** 一格的改动；保持当前且重数没变、或装备格不参与时返回 null（拆解里不列）。 */
function slotChange(ctx: SimContext, equipment: SimEquipment, slot: SlotId, slotPlan: SlotPlan): Change | null {
  const worn = wornItemOf(equipment, ctx.input.disciple.id, slot);
  const wornPiece = worn === null ? null : pieceOf(worn);
  const name = slotNameOf(equipment, slot);

  if (slotPlan.mode === 'empty') {
    // 本来就空着：没有变化，拆解里不列。
    if (worn === null) return null;
    return {
      id: slot,
      label: `${name}：卸下`,
      cost: {},
      notes: ['卸下后装备回到背包，不花费'],
      apply: (state) => withPiece(state, wornPiece, null),
    };
  }

  if (slotPlan.mode === 'keep') {
    if (worn === null || wornPiece === null) return null;
    const targetLevel = clampInt(slotPlan.refineLevel, clampInt(worn.refineLevel, 0, REFINE_MAX), REFINE_MAX);
    if (targetLevel === clampInt(worn.refineLevel, 0, REFINE_MAX)) return null;
    return keepRefineChange(slot, name, worn, wornPiece, equipment, targetLevel);
  }

  // 自定义一件：品质决定主 / 副属性的基础值与战力加成；祭炼 1..r 重的增量与消耗叠在上面。
  const quality = qualityOf(equipment, slotPlan.quality) ?? qualityOf(equipment, DEFAULT_QUALITY);
  if (quality === undefined) return null;
  const mainAttr = saneMain(slot, slotPlan.mainAttr);
  const subAttr = saneSub(mainAttr, slotPlan.subAttr);
  const subValue = clampInt(slotPlan.subValue, quality.subMin, quality.subMax);
  const refine = clampInt(slotPlan.refineLevel, 0, REFINE_MAX);
  const gains = refineGainsOf(quality, 0, refine);
  const piece: Piece = {
    mainAttr,
    mainValue: quality.mainValue + gains.mainGain,
    subAttr,
    subValue: subValue + gains.subGain,
    powerBonusBp: quality.powerBonusBp + gains.powerBonusGainBp,
  };
  const forge = forgeOptionOf(equipment, quality.id);
  const forgeNote =
    forge !== undefined && forge.unlocked
      ? `炼器成功率 ${percentOf(forge.odds.success)}%`
      : '炼器坊等级不够';
  const notes = [
    forgeNote,
    `${SIM_ATTR_NAMES[mainAttr]} +${String(piece.mainValue)} · ${SIM_ATTR_NAMES[subAttr]} +${String(piece.subValue)} · 战力加成 +${bpText(piece.powerBonusBp)}`,
  ];
  if (refine > 0) notes.push(`祭炼 ${String(refine)} 重`);
  return {
    id: slot,
    label: `${name}：换成${quality.name}装备`,
    cost: mergeCosts([costUnitsOf(forge?.cost ?? {}), gains.cost]),
    notes,
    apply: (state) => withPiece(state, wornPiece, piece),
  };
}

function insightChange(ctx: SimContext, points: Record<InsightAttr, number>): Change {
  const parts = INSIGHT_ATTRS.filter((attr) => points[attr] > 0).map(
    (attr) => `${SIM_ATTR_NAMES[attr]} +${String(points[attr])}`,
  );
  const total = points.attack + points.defense + points.speed;
  const shortfall = Math.max(0, total - ctx.input.disciple.daoInsight);
  return {
    id: 'insight',
    label: `悟道值：${parts.join('、')}`,
    cost: {},
    notes: shortfall > 0 ? [`还需 ${String(shortfall)} 点悟道值（赌坊 / 悟道丹）`] : [],
    apply: (state) => ({
      ...state,
      base: {
        ...state.base,
        attack: state.base.attack + points.attack,
        defense: state.base.defense + points.defense,
        speed: state.base.speed + points.speed,
      },
    }),
  };
}

/** 把方案拆成一项项改动（没有实际变化的不产生改动）。 */
function buildChanges(ctx: SimContext, plan: SimPlan): Change[] {
  const changes: Change[] = [];
  const targetIndex = targetIndexOf(ctx, plan.target);
  if (targetIndex > ctx.currentIndex) {
    changes.push(realmChange(ctx, targetIndex));
  }
  if (ctx.equipment !== null) {
    for (const slot of SLOT_IDS) {
      const change = slotChange(ctx, ctx.equipment, slot, plan.slots[slot]);
      if (change !== null) changes.push(change);
    }
  }
  const points = insightPointsOf(ctx.input.disciple, plan.insight);
  if (points.attack + points.defense + points.speed > 0) {
    changes.push(insightChange(ctx, points));
  }
  return changes;
}

/* ---------- 对外：模拟与校验 ---------- */

/**
 * 模拟：当前 / 模拟后的属性与战力；每项改动单独的拆解（按增幅排序，最高的标「提升最大」）；全部一起。
 * 默认方案下 simulated.combatPower === current.combatPower === 服务端 combatPower（验收硬条件）。
 */
export function simulate(input: SimInput, plan: SimPlan): SimResult {
  const ctx = contextOf(input);
  const current = initialState(ctx);
  const currentPower = combatPowerOf(ctx, current);
  const changes = buildChanges(ctx, plan);

  const breakdown: Row[] = changes.map((change) => ({
    id: change.id,
    label: change.label,
    gainRatio: gainOf(combatPowerOf(ctx, change.apply(current)), currentPower),
    cost: change.cost,
    notes: change.notes,
    best: false,
  }));
  breakdown.sort((a, b) => b.gainRatio - a.gainRatio);
  const top = breakdown[0];
  if (top !== undefined && top.gainRatio > 0) {
    top.best = true;
  }

  const after = changes.reduce((state, change) => change.apply(state), current);
  const total: Row = {
    id: 'total',
    label: '全部一起',
    gainRatio: gainOf(combatPowerOf(ctx, after), currentPower),
    cost: mergeCosts(changes.map((change) => change.cost)),
    notes: [...new Set(changes.flatMap((change) => change.notes))],
    best: false,
  };

  return {
    current: snapshotOf(ctx, current),
    simulated: snapshotOf(ctx, after),
    breakdown,
    total,
  };
}

/**
 * 校验：悟道值超上限 / 超累计额度、副属性数值超区间、主 / 副属性冲突、祭炼重数不合法。
 * 返回的文案挂在对应输入旁；计算时这些值会被夹到合法范围（见 simulate）。
 */
export function validatePlan(input: SimInput, plan: SimPlan): PlanIssues {
  const ctx = contextOf(input);
  const { disciple } = input;
  const issues: PlanIssues = { insight: {}, slots: {} };

  let total = 0;
  for (const attr of INSIGHT_ATTRS) {
    const value = plan.insight[attr];
    if (!Number.isInteger(value) || value < 0) {
      issues.insight[attr] = '请填写不小于 0 的整数';
      continue;
    }
    total += value;
    const room = Math.max(0, ATTRIBUTE_MAX - disciple[attr]);
    if (value > room) {
      issues.insight[attr] =
        room === 0
          ? `${SIM_ATTR_NAMES[attr]}已到 ${String(ATTRIBUTE_MAX)}，不能再加`
          : `${SIM_ATTR_NAMES[attr]}最多再加 ${String(room)} 点（上限 ${String(ATTRIBUTE_MAX)}）`;
    }
  }
  const remaining = Math.max(0, disciple.daoInsightRemaining);
  if (total > remaining) {
    issues.insight.total =
      remaining === 0 ? '累计分配的额度已经用完' : `三项合计最多 ${String(remaining)} 点（还能累计分配的额度）`;
  }

  const { equipment } = ctx;
  if (equipment !== null) {
    for (const slot of SLOT_IDS) {
      const slotPlan = plan.slots[slot];
      const worn = wornItemOf(equipment, disciple.id, slot);
      const slotIssues: Partial<Record<'main' | 'sub' | 'subValue' | 'refine', string>> = {};
      if (slotPlan.mode === 'keep' && worn !== null) {
        const current = clampInt(worn.refineLevel, 0, REFINE_MAX);
        if (!Number.isInteger(slotPlan.refineLevel) || slotPlan.refineLevel > REFINE_MAX) {
          slotIssues.refine = `祭炼重数最高 ${String(REFINE_MAX)} 重`;
        } else if (slotPlan.refineLevel < current) {
          slotIssues.refine = `不能比现在的 ${String(current)} 重低`;
        }
      }
      if (slotPlan.mode === 'custom') {
        const quality = qualityOf(equipment, slotPlan.quality);
        if (!SLOT_MAIN_CHOICES[slot].includes(slotPlan.mainAttr)) {
          slotIssues.main = `${slotNameOf(equipment, slot)}不能选这个主属性`;
        }
        if (slotPlan.subAttr === slotPlan.mainAttr) {
          slotIssues.sub = '副属性不能和主属性相同';
        }
        if (
          quality !== undefined &&
          (!Number.isInteger(slotPlan.subValue) || slotPlan.subValue < quality.subMin || slotPlan.subValue > quality.subMax)
        ) {
          slotIssues.subValue = `副属性数值需在 ${String(quality.subMin)} ~ ${String(quality.subMax)} 之间`;
        }
        if (!Number.isInteger(slotPlan.refineLevel) || slotPlan.refineLevel < 0 || slotPlan.refineLevel > REFINE_MAX) {
          slotIssues.refine = `祭炼重数需在 0 ~ ${String(REFINE_MAX)} 之间`;
        }
      }
      if (Object.keys(slotIssues).length > 0) {
        issues.slots[slot] = slotIssues;
      }
    }
  }
  return issues;
}
