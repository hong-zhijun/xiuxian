import { formatAmount } from './format';

/**
 * 宗门参谋：围绕「下一个目标」算清楚还差什么、要多久、怎么补最快（纯函数，不碰 DOM / Vue）。
 *
 * 1. 晋升目标：下一级宗门的资源消耗与条件；每种资源按当前每小时产出估算凑齐要多久，最慢的一项是瓶颈。
 * 2. 怎么补：只针对还差的资源给办法，每条都带具体的收益 / 花费（坊市卖富余材料、补岗位、升灵矿 / 聚灵阵……）。
 * 3. 战力提升：演武场 + 最值得培养的 5 名主力；每名主力列出收益最高的几步，并按战力公式算出「战力 +X%」。
 *
 * 每日可领的（日课、扫荡、拍卖待领……）已经在待办里，这里不重复。
 * 只用前端已有的数据（state 与装备视图）；收益数字照抄服务端规则（见各常量注释），只用于文案，不回传服务端。
 */

/** 战斗天赋 id：照抄 apps/server/src/modules/game/talents.ts 里 category = 'combat' 的三项（战意 / 会心 / 铁骨）。 */
const COMBAT_TALENT_IDS: readonly string[] = ['combat', 'critical', 'ironBody'];

/** 主力人数。 */
const MAIN_COUNT = 5;
/** 每名主力最多列几步。 */
const MAIN_TIP_COUNT = 3;
/** 战力增幅不到这个比例的（非红点）办法不列，免得刷屏。 */
const MIN_TIP_GAIN = 0.01;
/** 属性上限（服务端 ATTRIBUTE_MAX）。 */
const ATTRIBUTE_MAX = 100;
/** 「悟道值未分配」理由标签的门槛。 */
const INSIGHT_REASON_MIN = 10;
/** 坊市卖富余材料补上缺口的这个比例以上，算高收益（亮红点）。 */
const KEY_COVER_RATIO = 0.5;

/** 1 展示单位 = 1000 最小单位。 */
const UNIT = 1000;

/** 资源基础产出（最小单位 / 小时，game-config resources.baseRatePerHour）。 */
const BASE_STONE_RATE = 30_000;
const BASE_ENERGY_RATE = 20_000;
/** 灵矿：1～5 级每级 +20%，6～10 级每级 +40%（constants.ts missionHallSpiritStoneBonusBp）。 */
function missionHallLevelGainBp(nextLevel: number): number {
  return nextLevel <= 5 ? 2000 : 4000;
}
/** 聚灵阵每级 +40%（SPIRITUAL_ARRAY_ENERGY_BONUS_BP_PER_LEVEL）。 */
const SPIRITUAL_ARRAY_GAIN_BP = 4000;

/** 岗位每人每小时产出（最小单位，game-config positions）。 */
const POST_OUTPUT: Readonly<Record<string, { post: string; postName: string; perHour: number }>> = {
  spiritStone: { post: 'stoneMining', postName: '采灵', perHour: 15_000 },
  spiritualEnergy: { post: 'energyGathering', postName: '吐纳', perHour: 10_000 },
  herb: { post: 'herbGathering', postName: '药园', perHour: 20_000 },
  ore: { post: 'oreGathering', postName: '采矿', perHour: 15_000 },
};

/** 坊市（shop.ts）：卖 1 材料得 0.5 灵石，买 1 材料花 0.667 灵石；2 神木换 1 玄铁。 */
const SHOP_SELL_PRICE = 500;
const SHOP_BUY_PRICE = 667;
const SHOP_SHENMU_PER_XUANTIE = 2;
const SHOP_MATERIALS: readonly string[] = ['herb', 'ore'];

/** 装备品质（equipment.ts EQUIPMENT_QUALITIES）：主属性与战力加成（基点），从低到高。 */
const QUALITIES: readonly { id: string; mainValue: number; powerBonusBp: number }[] = [
  { id: 'common', mainValue: 8, powerBonusBp: 200 },
  { id: 'spirit', mainValue: 16, powerBonusBp: 400 },
  { id: 'treasure', mainValue: 20, powerBonusBp: 700 },
  { id: 'immortal', mainValue: 24, powerBonusBp: 1000 },
];
/** 部位主属性：法器可选身法 / 幸运，估算按身法（幸运不进战力）。 */
const SLOT_MAIN: Readonly<Record<string, CombatStat>> = { weapon: 'attack', armor: 'defense', artifact: 'speed' };
const SLOT_ORDER: readonly string[] = ['weapon', 'armor', 'artifact'];
const SLOT_NAMES: Readonly<Record<string, string>> = { weapon: '兵器', armor: '护甲', artifact: '法器' };

type CombatStat = 'attack' | 'defense' | 'speed';
const COMBAT_STATS: readonly CombatStat[] = ['attack', 'defense', 'speed'];
const STAT_LABELS: Readonly<Record<CombatStat, string>> = { attack: '攻击', defense: '防御', speed: '身法' };

/* ---------- 输出 ---------- */

/** 首页功能弹窗（SectScreen 里走 openHubCard）。 */
export type AdvisorPanel = 'forge' | 'shop' | 'gambling' | 'boss';

/** 可滚动到的区域（元素 id）。 */
export type AdvisorScrollTarget = 'building-title' | 'sect-upgrade-title' | 'disciple-title';

/** 「去处理」去哪里（只描述目标，跳转由 SectScreen 完成）。 */
export type AdvisorAction =
  | { kind: 'panel'; panel: AdvisorPanel }
  | { kind: 'disciple'; discipleId: string }
  | { kind: 'scroll'; target: AdvisorScrollTarget };

/** 一条办法：text 是动作，detail 是收益 / 花费；key = 明确的高收益动作（亮红点）。 */
export interface AdvisorTip {
  id: string;
  text: string;
  detail: string | null;
  action: AdvisorAction;
  key: boolean;
}

/** 晋升目标里的一行：一种资源或一个条件。 */
export interface AdvisorGoalLine {
  id: string;
  label: string;
  /** done = 已够 / 已达成；short = 资源还差（等得到）；blocked = 条件未达成或靠等凑不齐。 */
  status: 'done' | 'short' | 'blocked';
  detail: string;
  bottleneck: boolean;
  action: AdvisorAction | null;
}

export interface AdvisorGoal {
  title: string;
  ready: boolean;
  summary: string;
  lines: AdvisorGoalLine[];
  /** 怎么补：针对还差的资源（瓶颈在前）。 */
  tips: AdvisorTip[];
}

export interface AdvisorMain {
  discipleId: string;
  name: string;
  stageName: string;
  talentName: string;
  combatPower: number;
  reasons: string[];
  /** 受伤等说明；null = 没有。 */
  note: string | null;
  /** 收益最高的几步（按战力增幅从高到低）。 */
  tips: AdvisorTip[];
}

export interface AdvisorView {
  /** null = 宗门已满级。 */
  goal: AdvisorGoal | null;
  /** 演武场还能升时的一条；满级或没有演武场为 null。 */
  arena: AdvisorTip | null;
  mains: AdvisorMain[];
  /** 有明确瓶颈办法或高收益动作：按钮亮小红点。 */
  alert: boolean;
}

/* ---------- 输入（只声明用到的字段；SectStateView / EquipmentView 传入时结构兼容） ---------- */

export interface AdvisorDisciple {
  id: string;
  name: string;
  talent: string;
  talentName: string;
  assignment: string;
  realmOrder: number;
  stage: number;
  stageName: string;
  aptitude: number;
  attack: number;
  defense: number;
  speed: number;
  gear: { attack: number; defense: number; speed: number };
  gearPowerBonusBp: number;
  combatPower: number;
  stewardOffice: string | null;
  injuredUntil: string | null;
  severeInjuredUntil: string | null;
  canBreakthrough: boolean;
  breakthroughReadyExceptEnergy: boolean;
  bodyTemperingRemaining: number;
  bodyTemperingTarget: CombatStat | null;
  bodyTemperingGain: number;
  daoInsight: number;
  daoInsightRemaining: number;
  journey?: { status: string };
}

export interface AdvisorResource {
  id: string;
  name: string;
  balance: string;
  capacity: string;
  ratePerHour: string;
}

export interface AdvisorBuilding {
  defId: string;
  name: string;
  level: number;
  maxLevel: number;
  upgradeCost: Record<string, string> | null;
  canUpgrade: boolean;
  blockedReason: string | null;
}

export interface AdvisorAssignment {
  id: string;
  currentCount: number | null;
  maxCount: number | null;
}

export interface AdvisorSectUpgrade {
  nextLevel: number;
  nextLevelName: string;
  cost: Record<string, string>;
  requirements: readonly { label: string; met: boolean }[];
  canUpgrade: boolean;
}

export interface AdvisorState {
  serverNow: string;
  resources: readonly AdvisorResource[];
  disciples: readonly AdvisorDisciple[];
  buildings: readonly AdvisorBuilding[];
  assignments: readonly AdvisorAssignment[];
  sectUpgrade: AdvisorSectUpgrade | null;
}

export interface AdvisorEquipmentItem {
  id: string;
  name: string;
  slot: string;
  quality: string;
  mainAttr: string;
  mainValue: number;
  subAttr: string;
  subValue: number;
  powerBonusBp: number;
  discipleId: string | null;
}

export interface AdvisorEquipment {
  unlocked: boolean;
  items: readonly AdvisorEquipmentItem[];
  forgeOptions: readonly { quality: string; name: string; unlocked: boolean }[];
}

export interface AdvisorInput {
  state: AdvisorState;
  /** 装备视图；没加载为 null（装备相关的办法跳过）。 */
  equipment: AdvisorEquipment | null;
}

/* ---------- 小工具 ---------- */

function tip(id: string, text: string, detail: string | null, action: AdvisorAction, key = false): AdvisorTip {
  return { id, text, detail, action, key };
}

function isAfter(iso: string | null, nowMs: number): boolean {
  if (iso === null) return false;
  const until = Date.parse(iso);
  return Number.isFinite(until) && until > nowMs;
}

/** 时长：不到 1 小时 / 约 N 小时 / 约 N 天（48 小时起按天）。 */
export function formatHours(hours: number): string {
  if (!Number.isFinite(hours)) return '遥遥无期';
  if (hours < 1) return '不到 1 小时';
  if (hours < 48) return `约 ${String(Math.ceil(hours))} 小时`;
  return `约 ${String(Math.ceil(hours / 24))} 天`;
}

/** 战力增幅：+12% / +3.5%（不足 10% 保留 1 位小数）。 */
function formatGain(ratio: number): string {
  const pct = ratio * 100;
  const text = pct >= 10 ? String(Math.round(pct)) : String(Math.round(pct * 10) / 10);
  return `+${text}%`;
}

/** 资源名兜底（state.resources 里没有这项时用）。 */
const RESOURCE_NAMES: Readonly<Record<string, string>> = {
  spiritStone: '灵石',
  spiritualEnergy: '灵气',
  herb: '药材',
  ore: '矿石',
  xuantie: '玄铁',
  shenmu: '神木',
};

function resourceName(state: AdvisorState, id: string): string {
  return state.resources.find((item) => item.id === id)?.name ?? RESOURCE_NAMES[id] ?? id;
}

function costText(state: AdvisorState, cost: Record<string, string>): string {
  return Object.entries(cost)
    .filter(([, amount]) => Number(amount) > 0)
    .map(([id, amount]) => `${formatAmount(amount)} ${resourceName(state, id)}`)
    .join(' + ');
}

function balanceOf(state: AdvisorState, id: string): number {
  return Number(state.resources.find((item) => item.id === id)?.balance ?? 0);
}

/** 缺口展示：向上取整到整数展示单位（「还差 799.9」读起来别扭）。 */
function formatDeficit(deficit: number): string {
  return formatAmount(Math.ceil(deficit / UNIT) * UNIT);
}

/* ---------- 战力（realms.ts discipleCombatPower 的比例部分；天赋倍率前后相同，算增幅时约掉） ---------- */

interface PowerProfile {
  base: number;
  attack: number;
  defense: number;
  speed: number;
  bp: number;
}

function powerOf(p: PowerProfile): number {
  return p.base * (1 + (p.attack * 0.4 + p.defense * 0.35 + p.speed * 0.25) / 100) * (1 + p.bp / 10_000);
}

function gainOf(from: PowerProfile, to: PowerProfile): number {
  const now = powerOf(from);
  return now > 0 ? powerOf(to) / now - 1 : 0;
}

function profileOf(disciple: AdvisorDisciple): PowerProfile {
  return {
    base: (disciple.realmOrder * 3 + disciple.stage) * 10,
    attack: disciple.attack + disciple.gear.attack,
    defense: disciple.defense + disciple.gear.defense,
    speed: disciple.speed + disciple.gear.speed,
    bp: disciple.gearPowerBonusBp,
  };
}

/** 手上能分配的悟道值，按攻击 → 防御 → 身法依次加到 100 为止（只算手上有的点数）。 */
function insightPlanOf(disciple: AdvisorDisciple): Record<CombatStat, number> {
  let points = Math.max(0, Math.min(disciple.daoInsight, disciple.daoInsightRemaining));
  const plan: Record<CombatStat, number> = { attack: 0, defense: 0, speed: 0 };
  for (const stat of COMBAT_STATS) {
    const add = Math.min(points, Math.max(0, ATTRIBUTE_MAX - disciple[stat]));
    plan[stat] = add;
    points -= add;
  }
  return plan;
}

/* ---------- 主力推荐 ---------- */

/** 内部潜力分（只排序）：资质 × 0.45 + 战斗属性 × 0.35 + 境界分 × 0.20 + 战斗天赋 +8；战斗属性含手上未分配的悟道值。 */
function potentialOf(disciple: AdvisorDisciple): number {
  const plan = insightPlanOf(disciple);
  const combat =
    (disciple.attack + plan.attack) * 0.4 + (disciple.defense + plan.defense) * 0.35 + (disciple.speed + plan.speed) * 0.25;
  const realm = (disciple.realmOrder / 8) * 100;
  const combatTalent = COMBAT_TALENT_IDS.includes(disciple.talent) ? 8 : 0;
  return disciple.aptitude * 0.45 + combat * 0.35 + realm * 0.2 + combatTalent;
}

function reasonsOf(disciple: AdvisorDisciple, higherRealmCount: number): string[] {
  const reasons: string[] = [];
  const insight = Math.min(disciple.daoInsight, disciple.daoInsightRemaining);
  if (insight >= INSIGHT_REASON_MIN) reasons.push(`悟道值 ${String(insight)} 点未分配`);
  if (disciple.aptitude >= 75) reasons.push(`资质 ${String(disciple.aptitude)}`);
  const best = COMBAT_STATS.reduce((top, stat) => (disciple[stat] > disciple[top] ? stat : top));
  if (disciple[best] >= 75) reasons.push(`${STAT_LABELS[best]} ${String(disciple[best])}`);
  if (COMBAT_TALENT_IDS.includes(disciple.talent)) reasons.push(`${disciple.talentName}天赋`);
  if (higherRealmCount < 2) reasons.push('境界领先');
  if (reasons.length === 0) return ['综合最均衡'];
  return reasons.slice(0, 3);
}

interface RankedTip {
  tip: AdvisorTip;
  gain: number;
}

/** 装备：背包里有更好的就换上；空格 / 低品质按炼器坊能炼的最高品质估算。usedBag 防止同一件分给两个人。 */
function equipmentTips(
  disciple: AdvisorDisciple,
  profile: PowerProfile,
  gear: AdvisorEquipment,
  usedBag: Set<string>,
): RankedTip[] {
  const list: RankedTip[] = [];
  const bestForge = [...gear.forgeOptions].reverse().find((option) => option.unlocked) ?? null;
  const bestForgeQuality = bestForge === null ? null : (QUALITIES.find((q) => q.id === bestForge.quality) ?? null);
  const contribution = (item: AdvisorEquipmentItem | undefined): PowerProfile => {
    const delta: PowerProfile = { base: 0, attack: 0, defense: 0, speed: 0, bp: 0 };
    if (item === undefined) return delta;
    if (COMBAT_STATS.includes(item.mainAttr as CombatStat)) delta[item.mainAttr as CombatStat] += item.mainValue;
    if (COMBAT_STATS.includes(item.subAttr as CombatStat)) delta[item.subAttr as CombatStat] += item.subValue;
    delta.bp = item.powerBonusBp;
    return delta;
  };
  const swap = (out: PowerProfile, add: PowerProfile): PowerProfile => ({
    base: profile.base,
    attack: profile.attack - out.attack + add.attack,
    defense: profile.defense - out.defense + add.defense,
    speed: profile.speed - out.speed + add.speed,
    bp: profile.bp - out.bp + add.bp,
  });

  const emptySlots: string[] = [];
  const weakSlots: string[] = [];
  const forgeOut: PowerProfile = { base: 0, attack: 0, defense: 0, speed: 0, bp: 0 };
  const forgeIn: PowerProfile = { base: 0, attack: 0, defense: 0, speed: 0, bp: 0 };
  for (const slot of SLOT_ORDER) {
    const slotName = SLOT_NAMES[slot] ?? slot;
    const worn = gear.items.find((item) => item.discipleId === disciple.id && item.slot === slot);
    const out = contribution(worn);
    let bestBag: { item: AdvisorEquipmentItem; gain: number } | null = null;
    for (const item of gear.items) {
      if (item.discipleId !== null || item.slot !== slot || usedBag.has(item.id)) continue;
      const gain = gainOf(profile, swap(out, contribution(item)));
      if (gain > 0 && (bestBag === null || gain > bestBag.gain)) bestBag = { item, gain };
    }
    if (bestBag !== null) {
      usedBag.add(bestBag.item.id);
      list.push({
        tip: tip(
          `main:${disciple.id}:bag:${slot}`,
          `换上背包里的${bestBag.item.name}`,
          `战力 ${formatGain(bestBag.gain)}`,
          { kind: 'panel', panel: 'forge' },
          true,
        ),
        gain: bestBag.gain,
      });
      continue;
    }
    if (bestForge === null || bestForgeQuality === null) continue;
    const wornRank = worn === undefined ? -1 : QUALITIES.findIndex((q) => q.id === worn.quality);
    if (wornRank >= QUALITIES.indexOf(bestForgeQuality)) continue;
    // 新装备的副属性未知：换装时假定与旧装备相同（两边都不计副属性），只比主属性与品质加成。
    const outMain = { ...out };
    if (worn !== undefined && COMBAT_STATS.includes(worn.subAttr as CombatStat)) {
      outMain[worn.subAttr as CombatStat] -= worn.subValue;
    }
    forgeOut.attack += outMain.attack;
    forgeOut.defense += outMain.defense;
    forgeOut.speed += outMain.speed;
    forgeOut.bp += outMain.bp;
    forgeIn.bp += bestForgeQuality.powerBonusBp;
    forgeIn[SLOT_MAIN[slot] ?? 'attack'] += bestForgeQuality.mainValue;
    (worn === undefined ? emptySlots : weakSlots).push(slotName);
  }

  // 要炼的格子合成一条：「炼灵品：补上兵器、法器，换掉护甲」。
  if (bestForge !== null && emptySlots.length + weakSlots.length > 0) {
    const gain = gainOf(profile, swap(forgeOut, forgeIn));
    if (gain > 0) {
      const parts: string[] = [];
      if (emptySlots.length > 0) parts.push(`补上${emptySlots.join('、')}`);
      if (weakSlots.length > 0) parts.push(`换掉${weakSlots.join('、')}`);
      list.push({
        tip: tip(
          `main:${disciple.id}:forge`,
          `炼${bestForge.name}：${parts.join('，')}`,
          `战力约 ${formatGain(gain)}`,
          { kind: 'panel', panel: 'forge' },
        ),
        gain,
      });
    }
  }
  return list;
}

function mainTips(
  disciple: AdvisorDisciple,
  gear: AdvisorEquipment | null,
  usedBag: Set<string>,
): RankedTip[] {
  const profile = profileOf(disciple);
  const target: AdvisorAction = { kind: 'disciple', discipleId: disciple.id };
  const list: RankedTip[] = [];

  const plan = insightPlanOf(disciple);
  const insightTotal = plan.attack + plan.defense + plan.speed;
  if (insightTotal > 0) {
    const gain = gainOf(profile, {
      ...profile,
      attack: profile.attack + plan.attack,
      defense: profile.defense + plan.defense,
      speed: profile.speed + plan.speed,
    });
    const parts = COMBAT_STATS.filter((stat) => plan[stat] > 0).map((stat) => `${STAT_LABELS[stat]} +${String(plan[stat])}`);
    list.push({
      tip: tip(
        `main:${disciple.id}:insight`,
        `分配 ${String(insightTotal)} 点悟道值（${parts.join('、')}）`,
        `战力 ${formatGain(gain)}`,
        target,
        true,
      ),
      gain,
    });
  }

  if (disciple.canBreakthrough || disciple.breakthroughReadyExceptEnergy) {
    const gain = gainOf(profile, { ...profile, base: profile.base + 10 });
    list.push({
      tip: disciple.canBreakthrough
        ? tip(`main:${disciple.id}:breakthrough`, '可以突破了', `战力 ${formatGain(gain)}`, target, true)
        : tip(`main:${disciple.id}:energy`, '只差灵气就能突破', `突破后战力 ${formatGain(gain)}`, target),
      gain,
    });
  }

  if (gear !== null) list.push(...equipmentTips(disciple, profile, gear, usedBag));

  if (disciple.bodyTemperingRemaining > 0 && disciple.bodyTemperingTarget !== null && disciple.bodyTemperingGain > 0) {
    const stat = disciple.bodyTemperingTarget;
    const gain = gainOf(profile, { ...profile, [stat]: profile[stat] + disciple.bodyTemperingGain });
    list.push({
      tip: tip(
        `main:${disciple.id}:tempering`,
        `服淬体丹（${STAT_LABELS[stat]} +${String(disciple.bodyTemperingGain)}）`,
        `战力 ${formatGain(gain)}`,
        target,
      ),
      gain,
    });
  }

  return list.sort((a, b) => b.gain - a.gain);
}

function buildMains(state: AdvisorState, gear: AdvisorEquipment | null, nowMs: number): AdvisorMain[] {
  const ranked = state.disciples
    .filter((disciple) => disciple.stewardOffice === null)
    .map((disciple) => ({ disciple, potential: potentialOf(disciple) }))
    .sort((a, b) => b.potential - a.potential || b.disciple.combatPower - a.disciple.combatPower)
    .slice(0, MAIN_COUNT);
  const usedBag = new Set<string>();
  return ranked.map(({ disciple }) => {
    const higherRealmCount = state.disciples.filter((other) => other.realmOrder > disciple.realmOrder).length;
    let note: string | null = null;
    if (isAfter(disciple.severeInjuredUntil, nowMs)) note = '重伤卧床，静养痊愈前无法出战';
    else if (isAfter(disciple.injuredUntil, nowMs)) note = '受伤未愈，先疗伤再出战';
    return {
      discipleId: disciple.id,
      name: disciple.name,
      stageName: disciple.stageName,
      talentName: disciple.talentName,
      combatPower: disciple.combatPower,
      reasons: reasonsOf(disciple, higherRealmCount),
      note,
      tips: mainTips(disciple, gear, usedBag)
        .filter((item) => item.tip.key || item.gain >= MIN_TIP_GAIN)
        .slice(0, MAIN_TIP_COUNT)
        .map((item) => item.tip),
    };
  });
}

/* ---------- 晋升目标与补缺口 ---------- */

interface Shortage {
  id: string;
  name: string;
  /** 还差（最小单位）。 */
  deficit: number;
  /** 当前每小时产出（最小单位）。 */
  rate: number;
  hours: number;
}

function idleCount(state: AdvisorState): number {
  return state.disciples.filter((disciple) => disciple.assignment === 'idle' && disciple.journey?.status !== 'active')
    .length;
}

/** 岗位：有空位（或不限人数且有闲置弟子）时，补满后每小时多多少、缺口要多久。 */
function postTip(state: AdvisorState, short: Shortage): AdvisorTip | null {
  const output = POST_OUTPUT[short.id];
  if (output === undefined) return null;
  const post = state.assignments.find((item) => item.id === output.post);
  if (post === undefined) return null;
  const idle = idleCount(state);
  // 不限人数的岗位：有闲置弟子就按闲置人数，否则建议从别处调 1 人。
  const room = post.maxCount === null ? Math.max(1, idle) : Math.max(0, post.maxCount - (post.currentCount ?? 0));
  if (room <= 0) return null;
  const added = room * output.perHour;
  const hours = short.deficit / (short.rate + added);
  const head =
    post.maxCount !== null
      ? `${output.postName}还空 ${String(room)} 个位置`
      : idle > 0
        ? `派 ${String(room)} 名闲置弟子去${output.postName}`
        : `再调 1 名弟子去${output.postName}`;
  return tip(
    `goal:${short.id}:post`,
    head,
    `每小时 +${formatAmount(added)} ${short.name}，缺口${formatHours(short.hours)} → ${formatHours(hours)}`,
    { kind: 'scroll', target: 'disciple-title' },
  );
}

/** 灵矿 / 聚灵阵升一级：每小时多多少、花多少、几天回本（灵矿）。 */
function productionBuildingTip(state: AdvisorState, short: Shortage): AdvisorTip | null {
  const defId = short.id === 'spiritStone' ? 'missionHall' : short.id === 'spiritualEnergy' ? 'spiritualArray' : null;
  if (defId === null) return null;
  const building = state.buildings.find((item) => item.defId === defId);
  if (building === undefined || building.level >= building.maxLevel) return null;
  const next = building.level + 1;
  const gain =
    defId === 'missionHall'
      ? (BASE_STONE_RATE * missionHallLevelGainBp(next)) / 10_000
      : (BASE_ENERGY_RATE * SPIRITUAL_ARRAY_GAIN_BP) / 10_000;
  const parts = [`每小时 +${formatAmount(gain)} ${short.name}`];
  if (building.upgradeCost !== null) {
    parts.push(`花 ${costText(state, building.upgradeCost)}`);
    const stoneCost = Number(building.upgradeCost.spiritStone ?? 0);
    if (defId === 'missionHall' && stoneCost > 0) parts.push(`约 ${String(Math.ceil(stoneCost / gain / 24))} 天回本`);
  }
  if (!building.canUpgrade && building.blockedReason !== null) parts.push(`暂不能升：${building.blockedReason}`);
  return tip(`goal:${short.id}:building`, `${building.name}升到 ${String(next)} 级`, parts.join('，'), {
    kind: 'scroll',
    target: 'building-title',
  });
}

/** 灵石缺口：坊市卖掉这次晋升用不到的药材 / 矿石。 */
function sellMaterialsTip(state: AdvisorState, short: Shortage, need: (id: string) => number): AdvisorTip | null {
  // 补满缺口需要卖多少材料（展示单位，向上取整）。
  let wanted = Math.ceil(short.deficit / SHOP_SELL_PRICE);
  const sold: string[] = [];
  let total = 0;
  for (const id of SHOP_MATERIALS) {
    const spare = Math.floor(Math.max(0, balanceOf(state, id) - need(id)) / UNIT);
    const amount = Math.min(spare, wanted);
    if (amount <= 0) continue;
    sold.push(`${String(amount)} ${resourceName(state, id)}`);
    total += amount;
    wanted -= amount;
  }
  if (total <= 0) return null;
  const gained = total * SHOP_SELL_PRICE;
  const cover = Math.min(1, gained / short.deficit);
  return tip(
    'goal:spiritStone:sell',
    `坊市卖掉用不到的 ${sold.join('、')}`,
    `立得 ${formatAmount(gained)} 灵石，补上缺口的 ${String(Math.round(cover * 100))}%`,
    { kind: 'panel', panel: 'shop' },
    cover >= KEY_COVER_RATIO,
  );
}

/** 药材 / 矿石缺口：灵石有富余时坊市直接买齐。 */
function buyMaterialTip(state: AdvisorState, short: Shortage, need: (id: string) => number): AdvisorTip | null {
  if (!SHOP_MATERIALS.includes(short.id)) return null;
  const cost = Math.ceil(short.deficit / UNIT) * SHOP_BUY_PRICE;
  const spareStone = balanceOf(state, 'spiritStone') - need('spiritStone');
  if (spareStone < cost) return null;
  return tip(
    `goal:${short.id}:buy`,
    `坊市直接买齐 ${formatDeficit(short.deficit)} ${short.name}`,
    `花约 ${formatAmount(cost)} 灵石（灵石富余 ${formatAmount(spareStone)}）`,
    { kind: 'panel', panel: 'shop' },
    true,
  );
}

/** 玄铁 / 神木：坊市互换（2 神木 = 1 玄铁），外加讨伐、赌石的来源。 */
function rareTips(state: AdvisorState, short: Shortage, need: (id: string) => number): AdvisorTip[] {
  const list: AdvisorTip[] = [];
  if (short.id === 'xuantie') {
    const spareShenmu = Math.floor(Math.max(0, balanceOf(state, 'shenmu') - need('shenmu')) / UNIT);
    const amount = Math.min(Math.floor(spareShenmu / SHOP_SHENMU_PER_XUANTIE), Math.ceil(short.deficit / UNIT));
    if (amount > 0) {
      const cover = Math.min(1, (amount * UNIT) / short.deficit);
      list.push(
        tip(
          'goal:xuantie:exchange',
          `坊市用 ${String(amount * SHOP_SHENMU_PER_XUANTIE)} 神木换 ${String(amount)} 玄铁`,
          `补上缺口的 ${String(Math.round(cover * 100))}%`,
          { kind: 'panel', panel: 'shop' },
          cover >= KEY_COVER_RATIO,
        ),
      );
    }
    list.push(tip('goal:xuantie:gamble', '赌坊赌石开玄铁', '用灵石 / 药材 / 矿石买石头', { kind: 'panel', panel: 'gambling' }));
    list.push(tip('goal:xuantie:boss', '讨伐世界 Boss', '击杀奖励含玄铁', { kind: 'panel', panel: 'boss' }));
  }
  if (short.id === 'shenmu') {
    const spareXuantie = Math.floor(Math.max(0, balanceOf(state, 'xuantie') - need('xuantie')) / UNIT);
    const amount = Math.min(spareXuantie, Math.ceil(short.deficit / UNIT / SHOP_SHENMU_PER_XUANTIE));
    if (amount > 0) {
      list.push(
        tip(
          'goal:shenmu:exchange',
          `坊市用 ${String(amount)} 玄铁换 ${String(amount * SHOP_SHENMU_PER_XUANTIE)} 神木`,
          null,
          { kind: 'panel', panel: 'shop' },
        ),
      );
    }
    list.push(tip('goal:shenmu:boss', '讨伐世界 Boss', '第 6 关起击杀奖励含神木', { kind: 'panel', panel: 'boss' }));
  }
  return list;
}

function buildGoal(state: AdvisorState): AdvisorGoal | null {
  const upgrade = state.sectUpgrade;
  if (upgrade === null) return null;
  const title = `晋升${upgrade.nextLevelName}（${String(upgrade.nextLevel)} 级）`;
  const need = (id: string): number => Number(upgrade.cost[id] ?? 0);

  const lines: AdvisorGoalLine[] = [];
  const shortages: Shortage[] = [];
  for (const [id, amount] of Object.entries(upgrade.cost)) {
    const required = Number(amount);
    if (required <= 0) continue;
    const resource = state.resources.find((item) => item.id === id);
    const name = resourceName(state, id);
    const have = Number(resource?.balance ?? 0);
    const label = `${name} ${formatAmount(required)}`;
    if (have >= required) {
      lines.push({ id: `res:${id}`, label, status: 'done', detail: '已够', bottleneck: false, action: null });
      continue;
    }
    const deficit = required - have;
    const capacity = Number(resource?.capacity ?? 0);
    if (capacity > 0 && capacity < required) {
      lines.push({
        id: `res:${id}`,
        label,
        status: 'blocked',
        detail: `仓库上限只有 ${formatAmount(capacity)}，存不下`,
        bottleneck: false,
        action: { kind: 'scroll', target: 'building-title' },
      });
      continue;
    }
    const rate = Math.max(0, Number(resource?.ratePerHour ?? 0));
    const hours = rate > 0 ? deficit / rate : Number.POSITIVE_INFINITY;
    shortages.push({ id, name, deficit, rate, hours });
    lines.push({
      id: `res:${id}`,
      label,
      status: rate > 0 ? 'short' : 'blocked',
      detail:
        rate > 0
          ? `还差 ${formatDeficit(deficit)}，每小时 +${formatAmount(rate)}，${formatHours(hours)}`
          : `还差 ${formatDeficit(deficit)}，目前没有产出`,
      bottleneck: false,
      action: null,
    });
  }

  shortages.sort((a, b) => b.hours - a.hours);
  const slowest = shortages[0];
  if (slowest !== undefined) {
    const line = lines.find((item) => item.id === `res:${slowest.id}`);
    if (line !== undefined) line.bottleneck = true;
  }

  const unmet = upgrade.requirements.filter((req) => !req.met);
  for (const [index, req] of upgrade.requirements.entries()) {
    lines.push({
      id: `req:${String(index)}`,
      label: req.label,
      status: req.met ? 'done' : 'blocked',
      detail: req.met ? '已达成' : '未达成',
      bottleneck: false,
      action: req.met
        ? null
        : { kind: 'scroll', target: req.label.includes('弟子') ? 'disciple-title' : 'building-title' },
    });
  }

  const tips: AdvisorTip[] = [];
  if (upgrade.canUpgrade) {
    tips.push(tip('goal:ready', '条件已齐，现在就能晋升', null, { kind: 'scroll', target: 'sect-upgrade-title' }, true));
  }
  // 只给最慢的两种资源出办法（瓶颈在前）。
  for (const short of shortages.slice(0, 2)) {
    const candidates = [
      short.id === 'spiritStone' ? sellMaterialsTip(state, short, need) : null,
      buyMaterialTip(state, short, need),
      postTip(state, short),
      productionBuildingTip(state, short),
      ...rareTips(state, short, need),
    ];
    for (const item of candidates) if (item !== null) tips.push(item);
  }

  const summaryParts: string[] = [];
  if (upgrade.canUpgrade) {
    summaryParts.push('条件已齐，可以晋升');
  } else {
    if (slowest !== undefined) {
      summaryParts.push(
        Number.isFinite(slowest.hours)
          ? `照现在的产出，资源${formatHours(slowest.hours)}凑齐，瓶颈是${slowest.name}`
          : `${slowest.name}目前没有产出，光靠等凑不齐`,
      );
    }
    if (unmet.length > 0) summaryParts.push(`还有 ${String(unmet.length)} 个条件未达成`);
    if (summaryParts.length === 0) summaryParts.push('资源已够，还差条件');
  }

  return { title, ready: upgrade.canUpgrade, summary: summaryParts.join('；'), lines, tips };
}

/** 演武场：讨伐 / 镇妖塔 / 秘境战斗力每级 +10%。 */
function buildArena(state: AdvisorState): AdvisorTip | null {
  const arena = state.buildings.find((item) => item.defId === 'arenaHall');
  if (arena === undefined || arena.level >= arena.maxLevel) return null;
  const parts = ['讨伐 / 镇妖塔 / 秘境战斗力 +10%'];
  if (arena.upgradeCost !== null) parts.push(`花 ${costText(state, arena.upgradeCost)}`);
  if (!arena.canUpgrade && arena.blockedReason !== null) parts.push(`暂不能升：${arena.blockedReason}`);
  return tip(
    'arena',
    `${arena.name}升到 ${String(arena.level + 1)} 级`,
    parts.join('，'),
    { kind: 'scroll', target: 'building-title' },
    arena.canUpgrade,
  );
}

/** 算出宗门参谋的全部内容（纯函数）。 */
export function buildAdvisor(input: AdvisorInput): AdvisorView {
  const { state, equipment } = input;
  const nowMs = Date.parse(state.serverNow);
  const gear = equipment !== null && equipment.unlocked ? equipment : null;

  const goal = buildGoal(state);
  const arena = buildArena(state);
  const mains = buildMains(state, gear, nowMs);
  const alert =
    (goal?.tips.some((item) => item.key) ?? false) ||
    (arena?.key ?? false) ||
    mains.some((main) => main.tips.some((item) => item.key));
  return { goal, arena, mains, alert };
}
