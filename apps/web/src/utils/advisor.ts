import { CULTIVATING, talentPostsOf } from './discipleDispatch';

/**
 * 宗门参谋：根据宗门现状算出「下一步该做什么」（纯函数，不碰 DOM / Vue）。
 *
 * 只用前端已有的数据：state（弟子、建筑、岗位、资源、宗门晋升、执事、历练名额）、hub（首页状态摘要）、
 * equipment（装备视图）、dailyTasks（日课摘要）与门人调度的建议条数；不改服务端、不加接口。
 * 输出只有标签、理由与「去哪里」（AdvisorAction），不带任何分数；跳转由 SectScreen 完成。
 *
 * 规则见 docs/宗门参谋开发计划.md：
 *   - 主力：排除执事，按内部潜力分取前 5（潜力分只用来排序，不输出）；
 *   - 每名主力只给一条「下一步」：按 2.3 的顺序取第一条满足的；
 *   - 建筑、资源获取、资源使用各出若干条，计入角标的才是「可执行」建议；
 *   - 「下一步」置顶 3 条按优先级取（数字越小越靠前）；角标 = 可执行建议的条数。
 *
 * 装备视图没加载（或炼器尚未开放）时，装备相关的几条直接跳过：没有装备可比，也没有可去的炼器。
 */

/** 所有建议的「去处理」按钮文字。 */
const ACTION_LABEL = '去处理';

/** 战斗天赋 id：照抄 apps/server/src/modules/game/talents.ts 里 category = 'combat' 的三项（战意 / 会心 / 铁骨），不 import 服务端代码。 */
const COMBAT_TALENT_IDS: readonly string[] = ['combat', 'critical', 'ironBody'];

/** 主力人数。 */
const MAIN_COUNT = 5;
/** 装备格数：兵器 / 护甲 / 法器。 */
const EQUIPMENT_SLOT_COUNT = 3;
/** 祭炼「到八重」：八重以上不主动建议。 */
const REFINE_TARGET_LEVEL = 8;
/** 「快满仓」：余额达到容量的这个比例（未满仓）。 */
const NEAR_CAPACITY_RATIO = 0.9;
/** 采灵 / 吐纳每人每小时的产出（展示单位，与服务端 game-config 的 positions 一致；只用于文案）。 */
const STONE_MINING_PER_HOUR = 15;
const ENERGY_GATHERING_PER_HOUR = 10;

/** 「下一步」优先级（2.7）：数字越小越靠前。 */
const PRIORITY = {
  /** 满仓浪费（快满仓归在这一档）。 */
  capped: 10,
  nearCapacity: 11,
  /** 演武场可升级。 */
  arenaUpgrade: 20,
  /** 主力受伤。 */
  mainInjured: 30,
  /** 主力可突破。 */
  mainBreakthrough: 40,
  /** 每日收益可领。 */
  dailyClaim: 50,
  /** 采灵 / 吐纳空位与闲置。 */
  postSeat: 60,
  /** 主力装备空格。 */
  mainEquipSlot: 70,
  /** 其他建筑可升级。 */
  otherBuilding: 80,
  /** 其余。 */
  rest: 90,
} as const;

/** 建筑排序（2.4）：演武场 → 灵矿 → 聚灵阵 → 藏经阁 → 炼器坊 → 灵药园 → 其他。 */
const BUILDING_ORDER: readonly string[] = [
  'arenaHall',
  'missionHall',
  'spiritualArray',
  'scriptureLibrary',
  'forgeWorkshop',
  'herbGarden',
];
/** 建筑收益文案（2.4）。 */
const BUILDING_BENEFIT: Readonly<Partial<Record<string, string>>> = {
  arenaHall: '战斗力每级 +10%',
  missionHall: '灵石产出',
  spiritualArray: '灵气产出',
  scriptureLibrary: '修炼速度',
  forgeWorkshop: '更高品质装备',
  herbGarden: '药材产出',
};

/** 属性中文名（战力里的三项：攻击 / 防御 / 身法）。 */
const STAT_LABELS: Readonly<Record<'attack' | 'defense' | 'speed', string>> = {
  attack: '攻击',
  defense: '防御',
  speed: '身法',
};

/** 首页功能弹窗（与首页功能卡片同一套打开方式，SectScreen 里走 openHubCard）。 */
export type AdvisorPanel =
  | 'daily'
  | 'alchemy'
  | 'forge'
  | 'steward'
  | 'boss'
  | 'tower'
  | 'explore'
  | 'veins'
  | 'auction';

/** 可滚动到的区域（元素 id）。 */
export type AdvisorScrollTarget = 'building-title' | 'sect-upgrade-title' | 'disciple-title';

/**
 * 「去处理」去哪里（只描述目标，不做跳转）：
 * - panel：打开首页功能弹窗；
 * - disciple：打开这名弟子的详情；
 * - scroll：滚动到页面上的区域；
 * - dispatch：打开门人调度。
 */
export type AdvisorAction =
  | { kind: 'panel'; panel: AdvisorPanel }
  | { kind: 'disciple'; discipleId: string }
  | { kind: 'scroll'; target: AdvisorScrollTarget }
  | { kind: 'dispatch' };

/**
 * 一条建议。countsTowardBadge = false 的只是说明（如「建筑被什么挡住了」），不计入角标，也不进「下一步」。
 * priority 数字越小越重要，只用于排序「下一步」。
 */
export interface Suggestion {
  id: string;
  text: string;
  actionLabel: string;
  action: AdvisorAction;
  countsTowardBadge: boolean;
  priority: number;
}

/** 主力卡片：名字、境界、天赋、战力、理由标签、错配提醒与这名弟子的下一步（null = 状态良好）。 */
export interface MainDiscipleAdvice {
  discipleId: string;
  name: string;
  realmName: string;
  stageName: string;
  talentName: string;
  combatPower: number;
  reasons: string[];
  nextStep: Suggestion | null;
  misplaced: string | null;
}

export interface AdvisorView {
  /** 下一步：从所有可执行建议里按优先级取的前 3 条。 */
  nextSteps: Suggestion[];
  mainDisciples: MainDiscipleAdvice[];
  buildings: Suggestion[];
  income: Suggestion[];
  spending: {
    items: Suggestion[];
    /** 固定说明（不计入角标）。 */
    note: string;
  };
  /** 角标：可执行建议的条数（下一步不重复计数）。 */
  badgeCount: number;
}

/* ---------- 输入结构（只声明用到的字段；完整的 SectStateView / HubView 等传入时结构兼容） ---------- */

export interface AdvisorDisciple {
  id: string;
  name: string;
  talent: string;
  talentName: string;
  assignment: string;
  realmOrder: number;
  realmName: string;
  stageName: string;
  aptitude: number;
  attack: number;
  defense: number;
  speed: number;
  combatPower: number;
  stewardOffice: string | null;
  injuredUntil: string | null;
  severeInjuredUntil: string | null;
  canBreakthrough: boolean;
  breakthroughReadyExceptEnergy: boolean;
  bodyTemperingRemaining: number;
  bodyTemperingTarget: 'attack' | 'defense' | 'speed' | null;
  aptitudePillRemaining: number;
  /** 历练状态：在外（active）的弟子不算闲置；可选，旧测试数据没有时按不在外处理。 */
  journey?: { status: string };
}

export interface AdvisorResource {
  id: string;
  name: string;
  balance: string;
  capacity: string;
  capped: boolean;
}

export interface AdvisorBuilding {
  defId: string;
  name: string;
  level: number;
  maxLevel: number;
  canUpgrade: boolean;
  blockedReason: string | null;
}

export interface AdvisorAssignment {
  id: string;
  name: string;
  currentCount: number | null;
  maxCount: number | null;
}

export interface AdvisorState {
  serverNow: string;
  resources: readonly AdvisorResource[];
  disciples: readonly AdvisorDisciple[];
  buildings: readonly AdvisorBuilding[];
  assignments: readonly AdvisorAssignment[];
  sectUpgrade: { canUpgrade: boolean } | null;
  stewards: { offices: readonly { discipleId: string | null }[] };
  journey: { activeCount: number; maxConcurrent: number; minAtHome: number };
}

export interface AdvisorHub {
  worldBoss: { attackable: boolean };
  tower: { sweepable: boolean };
  explore: { remaining: number };
  veins: { unlocked: boolean; holding: { ratePerHour: number } | null; freeCount: number };
  auction: { claimable: number };
}

export interface AdvisorEquipment {
  unlocked: boolean;
  items: readonly { discipleId: string | null; slot: string; quality: string; refineLevel: number }[];
}

export interface AdvisorDaily {
  tasks: readonly { completed: boolean; claimed: boolean }[];
  chest: { available: boolean };
}

export interface AdvisorInput {
  state: AdvisorState;
  /** 首页状态摘要；没取到为 null（相关建议跳过）。 */
  hub: AdvisorHub | null;
  /** 装备视图；没加载为 null（装备相关的几条跳过）。 */
  equipment: AdvisorEquipment | null;
  /** 日课摘要；没取到为 null（日课相关的建议跳过）。 */
  dailyTasks: AdvisorDaily | null;
  /** 门人调度的建议条数（SectScreen 的 dispatchCount）。 */
  dispatchSuggestionCount: number;
}

/* ---------- 内部小工具 ---------- */

function suggest(
  id: string,
  text: string,
  action: AdvisorAction,
  priority: number,
  countsTowardBadge = true,
): Suggestion {
  return { id, text, actionLabel: ACTION_LABEL, action, countsTowardBadge, priority };
}

/** 服务端时间戳还没过期（> now）。缺字段 / 非法时间戳不算。 */
function isAfter(iso: string | null, nowMs: number): boolean {
  if (iso === null) return false;
  const until = Date.parse(iso);
  return Number.isFinite(until) && until > nowMs;
}

/** 内部潜力分（只用来排序，不输出）：资质 × 0.45 + 战斗属性 × 0.35 + 境界分 × 0.20 + 战斗天赋 +8。 */
function potentialOf(disciple: AdvisorDisciple): number {
  const combat = disciple.attack * 0.4 + disciple.defense * 0.35 + disciple.speed * 0.25;
  const realm = (disciple.realmOrder / 8) * 100;
  const combatTalent = COMBAT_TALENT_IDS.includes(disciple.talent) ? 8 : 0;
  return disciple.aptitude * 0.45 + combat * 0.35 + realm * 0.2 + combatTalent;
}

/** 产出类天赋：TALENT_POSTS 里有非修炼岗位的（灵植 / 矿脉 / 聚灵）；悟道只对应修炼岗，不算产出类。 */
function isProductionTalent(talent: string): boolean {
  return (talentPostsOf(talent) ?? []).some((post) => post !== CULTIVATING);
}

/** 理由标签（最多 3 条）：资质高 / 战斗属性高 / 战斗天赋 / 全宗境界前 2；都不满足时「综合最均衡」。 */
function reasonsOf(disciple: AdvisorDisciple, higherRealmCount: number): string[] {
  const reasons: string[] = [];
  if (disciple.aptitude >= 75) reasons.push(`资质 ${String(disciple.aptitude)} · 修炼快`);
  const stats = [
    { label: STAT_LABELS.attack, value: disciple.attack },
    { label: STAT_LABELS.defense, value: disciple.defense },
    { label: STAT_LABELS.speed, value: disciple.speed },
  ];
  const best = stats.reduce((top, item) => (item.value > top.value ? item : top));
  if (best.value >= 75) reasons.push(`${best.label} ${String(best.value)}`);
  if (COMBAT_TALENT_IDS.includes(disciple.talent)) reasons.push(`${disciple.talentName}天赋`);
  // 「全宗前 2」按名次算：比他境界高的人不足 2 个（同境界并列）。
  if (higherRealmCount < 2) reasons.push('境界领先');
  if (reasons.length === 0) return ['综合最均衡'];
  return reasons.slice(0, 3);
}

/** 2.3 每名主力的下一步：按顺序取第一条满足的；都没有返回 null（状态良好）。 */
function nextStepOf(
  disciple: AdvisorDisciple,
  nowMs: number,
  gear: AdvisorEquipment | null,
): Suggestion | null {
  const id = disciple.id;
  const target: AdvisorAction = { kind: 'disciple', discipleId: id };
  // 重伤丹药无效，只能静养到期：只做说明，不计入角标、不进「下一步」。
  if (isAfter(disciple.severeInjuredUntil, nowMs)) {
    return suggest(`main:${id}:severe`, '重伤卧床，静养痊愈前无法培养（丹药无效）', target, PRIORITY.mainInjured, false);
  }
  if (isAfter(disciple.injuredUntil, nowMs)) {
    return suggest(`main:${id}:heal`, '受伤未愈，去疗伤', target, PRIORITY.mainInjured);
  }
  if (disciple.canBreakthrough) {
    return suggest(`main:${id}:breakthrough`, '可以突破了', target, PRIORITY.mainBreakthrough);
  }
  if (disciple.breakthroughReadyExceptEnergy) {
    return suggest(`main:${id}:energy`, '只差灵气就能突破', target, PRIORITY.rest);
  }
  if (gear !== null) {
    const worn = gear.items.filter((item) => item.discipleId === id);
    if (new Set(worn.map((item) => item.slot)).size < EQUIPMENT_SLOT_COUNT) {
      return suggest(
        `main:${id}:slot`,
        '装备有空格，去炼器或功勋兑换',
        { kind: 'panel', panel: 'forge' },
        PRIORITY.mainEquipSlot,
      );
    }
    if (worn.some((item) => item.quality === 'common' || item.quality === 'spirit')) {
      return suggest(`main:${id}:quality`, '穿着凡品 / 灵品，换成宝品以上', target, PRIORITY.rest);
    }
    if (worn.some((item) => item.refineLevel < REFINE_TARGET_LEVEL)) {
      return suggest(`main:${id}:refine`, '装备还没祭炼到八重，去祭炼', target, PRIORITY.rest);
    }
  }
  if (disciple.bodyTemperingRemaining > 0 && disciple.bodyTemperingTarget !== null) {
    const label = STAT_LABELS[disciple.bodyTemperingTarget];
    return suggest(`main:${id}:tempering`, `用淬体丹补「${label}」等弱项`, target, PRIORITY.rest);
  }
  if (disciple.aptitudePillRemaining > 0 && disciple.aptitude < 80) {
    return suggest(`main:${id}:aptitude`, '用培元丹提资质', target, PRIORITY.rest);
  }
  return null;
}

/** 2.2 错配提醒：资质高、不在修炼岗，而且天赋不是产出类。 */
function misplacedOf(disciple: AdvisorDisciple): string | null {
  if (disciple.aptitude < 75 || disciple.assignment === CULTIVATING) return null;
  if (isProductionTalent(disciple.talent)) return null;
  return '资质高，建议改去修炼';
}

/** 2.4 建筑：未满级的每座一条（演武场 → … → 其他），再加宗门可晋升。 */
function buildingSuggestions(state: AdvisorState): Suggestion[] {
  const rank = (defId: string): number => {
    const index = BUILDING_ORDER.indexOf(defId);
    return index < 0 ? BUILDING_ORDER.length : index;
  };
  const list = state.buildings
    .filter((building) => building.level < building.maxLevel)
    .sort((a, b) => rank(a.defId) - rank(b.defId))
    .map((building): Suggestion => {
      const benefit = BUILDING_BENEFIT[building.defId];
      const head = benefit === undefined ? building.name : `${building.name}（${benefit}）`;
      const target: AdvisorAction = { kind: 'scroll', target: 'building-title' };
      if (building.canUpgrade) {
        const priority = building.defId === 'arenaHall' ? PRIORITY.arenaUpgrade : PRIORITY.otherBuilding;
        return suggest(`building:${building.defId}`, `${head}可以升级`, target, priority);
      }
      const reason = building.blockedReason ?? '条件尚未满足';
      return suggest(`building:${building.defId}`, `${head}暂不能升级：${reason}`, target, PRIORITY.rest, false);
    });
  if (state.sectUpgrade?.canUpgrade === true) {
    list.push(
      suggest(
        'sect-upgrade',
        '宗门可晋升，容量与上限都会提高',
        { kind: 'scroll', target: 'sect-upgrade-title' },
        PRIORITY.rest,
      ),
    );
  }
  return list;
}

/** 2.5 资源获取：产出、岗位、每日收益哪里还能补。 */
function incomeSuggestions(input: AdvisorInput): Suggestion[] {
  const { state, hub, dailyTasks, dispatchSuggestionCount } = input;
  const list: Suggestion[] = [];
  const seatRoom = (postId: string): number | null => {
    const post = state.assignments.find((item) => item.id === postId);
    if (post === undefined || post.maxCount === null) return null;
    return Math.max(0, post.maxCount - (post.currentCount ?? 0));
  };

  // 在外历练的弟子岗位也是闲置，但人不在宗门，不算「闲置」。
  const idle = state.disciples.filter(
    (disciple) => disciple.assignment === 'idle' && disciple.journey?.status !== 'active',
  ).length;
  if (idle > 0) {
    list.push(
      suggest('income:idle', `${String(idle)} 名弟子闲置，派去修炼或岗位`, { kind: 'dispatch' }, PRIORITY.postSeat),
    );
  }
  const stoneRoom = seatRoom('stoneMining');
  if (stoneRoom !== null && stoneRoom > 0) {
    list.push(
      suggest(
        'income:seat:stoneMining',
        `采灵还空 ${String(stoneRoom)} 个位置，多一人每小时多约 ${String(STONE_MINING_PER_HOUR)} 灵石`,
        { kind: 'scroll', target: 'disciple-title' },
        PRIORITY.postSeat,
      ),
    );
  }
  const energyRoom = seatRoom('energyGathering');
  if (energyRoom !== null && energyRoom > 0) {
    list.push(
      suggest(
        'income:seat:energyGathering',
        `吐纳还空 ${String(energyRoom)} 个位置，多一人每小时多约 ${String(ENERGY_GATHERING_PER_HOUR)} 灵气`,
        { kind: 'scroll', target: 'disciple-title' },
        PRIORITY.postSeat,
      ),
    );
  }
  if (dispatchSuggestionCount > 0) {
    list.push(
      suggest(
        'income:dispatch',
        `门人调度有 ${String(dispatchSuggestionCount)} 项建议（天赋没在对口岗位）`,
        { kind: 'dispatch' },
        PRIORITY.rest,
      ),
    );
  }
  const vacant = state.stewards.offices.filter((office) => office.discipleId === null).length;
  if (vacant > 0) {
    list.push(
      suggest(
        'income:steward',
        `${String(vacant)} 个执事空缺，执事有产出 / 修炼加成`,
        { kind: 'panel', panel: 'steward' },
        PRIORITY.rest,
      ),
    );
  }
  // 同时在外不超过 maxConcurrent，出发后门内至少留 minAtHome 人（与服务端历练校验同一口径）。
  const { journey } = state;
  const journeySlots = Math.min(
    journey.maxConcurrent - journey.activeCount,
    state.disciples.length - journey.activeCount - journey.minAtHome,
  );
  if (journeySlots > 0) {
    list.push(
      suggest(
        'income:journey',
        `还能派 ${String(journeySlots)} 名弟子历练`,
        { kind: 'scroll', target: 'disciple-title' },
        PRIORITY.rest,
      ),
    );
  }

  // 每日收益没拿（与待办同一口径）。
  if (dailyTasks !== null) {
    const claimable = dailyTasks.tasks.filter((task) => task.completed && !task.claimed).length;
    if (claimable > 0) {
      list.push(
        suggest(
          'income:daily',
          `日课有 ${String(claimable)} 个任务可领取灵石`,
          { kind: 'panel', panel: 'daily' },
          PRIORITY.dailyClaim,
        ),
      );
    } else if (dailyTasks.chest.available) {
      list.push(suggest('income:daily-chest', '日课宝箱可开启', { kind: 'panel', panel: 'daily' }, PRIORITY.dailyClaim));
    }
  }
  if (hub !== null) {
    if (hub.tower.sweepable) {
      list.push(suggest('income:tower', '镇妖塔今日可扫荡', { kind: 'panel', panel: 'tower' }, PRIORITY.dailyClaim));
    }
    if (hub.explore.remaining > 0) {
      list.push(
        suggest('income:explore', `秘境今日还可探 ${String(hub.explore.remaining)} 次`, { kind: 'panel', panel: 'explore' }, PRIORITY.dailyClaim),
      );
    }
    if (hub.worldBoss.attackable) {
      list.push(suggest('income:boss', '讨伐开放中，可以出手', { kind: 'panel', panel: 'boss' }, PRIORITY.dailyClaim));
    }
    if (hub.veins.unlocked && hub.veins.holding === null && hub.veins.freeCount > 0) {
      list.push(
        suggest('income:veins', `${String(hub.veins.freeCount)} 条灵脉无主，可以进驻`, { kind: 'panel', panel: 'veins' }, PRIORITY.dailyClaim),
      );
    }
    if (hub.auction.claimable > 0) {
      list.push(
        suggest('income:auction', `拍卖行 ${String(hub.auction.claimable)} 件待领取`, { kind: 'panel', panel: 'auction' }, PRIORITY.dailyClaim),
      );
    }
  }

  // 产出偏慢：灵矿没满级且采灵没坐满 → 先升灵矿、把采灵坐满；灵气同理（聚灵阵 / 吐纳）。
  const missionHall = state.buildings.find((building) => building.defId === 'missionHall');
  if (missionHall !== undefined && missionHall.level < missionHall.maxLevel && stoneRoom !== null && stoneRoom > 0) {
    list.push(
      suggest('income:stone-slow', '灵石来源偏慢：先升灵矿、把采灵坐满', { kind: 'scroll', target: 'building-title' }, PRIORITY.rest),
    );
  }
  const spiritualArray = state.buildings.find((building) => building.defId === 'spiritualArray');
  if (spiritualArray !== undefined && spiritualArray.level < spiritualArray.maxLevel && energyRoom !== null && energyRoom > 0) {
    list.push(
      suggest('income:energy-slow', '灵气来源偏慢：先升聚灵阵、把吐纳坐满', { kind: 'scroll', target: 'building-title' }, PRIORITY.rest),
    );
  }

  return list;
}

/** 2.6 资源使用：满仓浪费与快满仓（资源 → 去哪里花）；每种资源一条。 */
const SPENDING_TARGETS: readonly { resourceId: string; hint: string; action: AdvisorAction }[] = [
  { resourceId: 'spiritStone', hint: '升级建筑 / 祭炼', action: { kind: 'scroll', target: 'building-title' } },
  { resourceId: 'herb', hint: '炼丹 / 坊市卖出', action: { kind: 'panel', panel: 'alchemy' } },
  { resourceId: 'ore', hint: '炼器 / 坊市卖出 / 赌石', action: { kind: 'panel', panel: 'forge' } },
  { resourceId: 'spiritualEnergy', hint: '突破', action: { kind: 'scroll', target: 'disciple-title' } },
  { resourceId: 'xuantie', hint: '炼器 / 祭炼', action: { kind: 'panel', panel: 'forge' } },
];

function spendingSuggestions(state: AdvisorState): Suggestion[] {
  const list: Suggestion[] = [];
  for (const target of SPENDING_TARGETS) {
    const resource = state.resources.find((item) => item.id === target.resourceId);
    if (resource === undefined) continue;
    if (resource.capped) {
      list.push(
        suggest(`spend:full:${target.resourceId}`, `${resource.name}已满仓，产出在浪费：${target.hint}`, target.action, PRIORITY.capped),
      );
      continue;
    }
    const capacity = Number(resource.capacity);
    if (capacity > 0 && Number(resource.balance) >= capacity * NEAR_CAPACITY_RATIO) {
      list.push(
        suggest(`spend:near:${target.resourceId}`, `${resource.name}快满仓了：${target.hint}`, target.action, PRIORITY.nearCapacity),
      );
    }
  }
  return list.sort((a, b) => a.priority - b.priority);
}

/**
 * 算出宗门参谋的全部内容（纯函数）。
 * 装备相关的几条只在装备视图已加载且炼器已开放时出（没有装备可比，也没有可去的炼器）。
 */
export function buildAdvisor(input: AdvisorInput): AdvisorView {
  const { state, equipment } = input;
  const nowMs = Date.parse(state.serverNow);
  const gear = equipment !== null && equipment.unlocked ? equipment : null;

  // 主力：排除执事，按潜力分从高到低（同分按战力高的在前）取前 5。
  const ranked = state.disciples
    .filter((disciple) => disciple.stewardOffice === null)
    .map((disciple) => ({ disciple, potential: potentialOf(disciple) }))
    .sort((a, b) => b.potential - a.potential || b.disciple.combatPower - a.disciple.combatPower)
    .slice(0, MAIN_COUNT);
  const mainDisciples: MainDiscipleAdvice[] = ranked.map(({ disciple }) => {
    // 全宗境界排名：比他高的人数（所有弟子，含执事）。
    const higherRealmCount = state.disciples.filter((other) => other.realmOrder > disciple.realmOrder).length;
    return {
      discipleId: disciple.id,
      name: disciple.name,
      realmName: disciple.realmName,
      stageName: disciple.stageName,
      talentName: disciple.talentName,
      combatPower: disciple.combatPower,
      reasons: reasonsOf(disciple, higherRealmCount),
      nextStep: nextStepOf(disciple, nowMs, gear),
      misplaced: misplacedOf(disciple),
    };
  });

  const buildings = buildingSuggestions(state);
  const income = incomeSuggestions(input);
  const spendingItems = spendingSuggestions(state);
  const mainSteps = mainDisciples.flatMap((main) => (main.nextStep === null ? [] : [main.nextStep]));

  // 角标：所有可执行建议的条数（主力下一步 + 建筑 + 资源获取 + 资源使用），下一步不重复计数。
  const all = [...mainSteps, ...buildings, ...income, ...spendingItems];
  const badgeCount = all.filter((item) => item.countsTowardBadge).length;
  // 下一步：可执行建议里按优先级取前 3（同优先级按产生顺序：主力 → 建筑 → 资源获取 → 资源使用）。
  const nextSteps = all
    .filter((item) => item.countsTowardBadge)
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 3);

  return {
    nextSteps,
    mainDisciples,
    buildings,
    income,
    spending: {
      items: spendingItems,
      note: '灵石优先顺序：演武场 → 主力突破 → 装备配齐 → 祭炼到八重 → 其他',
    },
    badgeCount,
  };
}
