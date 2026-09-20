/**
 * 弟子名册的搜索 / 筛选 / 排序 / 状态派生（纯函数，不碰 DOM、不依赖 Vue）。
 *
 * 为什么这里不直接 import `DiscipleView`：本文件会被根级 node 测试直接 import
 * （根 `tsconfig.json` 的 lib 只有 ES2022，没有 DOM），而 `../api/game` 会连带把使用
 * DOM 类型的 `../api/client` 拉进程序并报错。所以这里只声明「筛选所需字段」的最小结构，
 * 调用方传入完整的 `DiscipleView` 依然结构兼容（多余字段不影响）。
 *
 * 所有判定都用服务端给的字段：
 * - 疗伤：`injuredUntil > serverNow`（serverNow 由调用方传 `Date.parse(state.serverNow)`）；
 * - 可破境：只看 `canBreakthrough`，前端不复制破境公式，也不因本地动画满环而放行；
 * - 境界高低：先比 `realmOrder` 再比 `stage`，绝不按境界名字符串排序。
 */

/** 筛选所需的弟子字段子集（对应 `DiscipleView` 的一个子集）。 */
export interface FilterableDisciple {
  id: string;
  name: string;
  /** 掌门私有备注，空串 = 未填写。 */
  note: string;
  realmId: string;
  realmName: string;
  /** 境界在服务端境界表里的下标（0 = 最低）。 */
  realmOrder: number;
  /** 境界内的阶段序号。 */
  stage: number;
  assignment: string;
  assignmentName: string;
  cultivation: number;
  /** null = 已达当前版本上限。 */
  requiredCultivation: number | null;
  combatPower: number;
  /** null = 未受伤。 */
  injuredUntil: string | null;
  canBreakthrough: boolean;
}

/** 服务端 `IDLE_ASSIGNMENT`（见 packages/game-core/src/config/schema.ts 的岗位枚举）。 */
export const IDLE_ASSIGNMENT_ID = 'idle';

/** 备注上限（与服务端 0013 迁移的 CHECK 一致）。 */
export const NOTE_MAX_LENGTH = 60;

/**
 * 状态展示优先级：疗伤中 > 可破境 > 已达当前版本上限 > 修为已满但暂不可破境 > 当前岗位名。
 * 列表行只显示这条优先级最高的一条，岗位名在其余情况下另以标签显示，不会消失。
 */
export type DiscipleStatusKey =
  | 'injured'
  | 'canBreakthrough'
  | 'capped'
  | 'cultivationFull'
  | 'assignment';

export interface DiscipleStatus {
  key: DiscipleStatusKey;
  label: string;
}

export type DiscipleStatusFilter = 'all' | 'canBreakthrough' | 'injured' | 'cultivationFull' | 'idle';

export type DiscipleSortKey = 'recruitOrder' | 'combatPower' | 'realm';

export interface DiscipleFilter {
  /** 姓名 / 备注搜索词（空串 = 不过滤）。 */
  search: string;
  /** 境界 id（空串 = 全部境界）。 */
  realmId: string;
  /** 岗位 id（空串 = 全部岗位）。 */
  assignment: string;
  status: DiscipleStatusFilter;
  sort: DiscipleSortKey;
}

export const DEFAULT_DISCIPLE_FILTER: DiscipleFilter = {
  search: '',
  realmId: '',
  assignment: '',
  status: 'all',
  sort: 'recruitOrder',
};

export const DISCIPLE_STATUS_FILTERS: readonly { value: DiscipleStatusFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'canBreakthrough', label: '可破境' },
  { value: 'injured', label: '疗伤' },
  { value: 'cultivationFull', label: '修为已满' },
  { value: 'idle', label: '闲置' },
];

/** 默认（招募顺序）排在最前。 */
export const DISCIPLE_SORT_OPTIONS: readonly { value: DiscipleSortKey; label: string }[] = [
  { value: 'recruitOrder', label: '招募顺序' },
  { value: 'combatPower', label: '战力高低' },
  { value: 'realm', label: '境界高低' },
];

/** 疗伤中：`injuredUntil > serverNow`（时间戳非法或 serverNow 缺失时不算受伤）。 */
export function isInjured(disciple: FilterableDisciple, serverNowMs: number): boolean {
  if (disciple.injuredUntil === null) return false;
  const until = Date.parse(disciple.injuredUntil);
  if (!Number.isFinite(until) || !Number.isFinite(serverNowMs)) return false;
  return until > serverNowMs;
}

/**
 * 修为是否已无增长空间：null 门槛（已达当前版本上限）或已到门槛。
 * 注意：这不代表可破境——可破境只看 `canBreakthrough`。
 */
export function hasFullCultivation(disciple: FilterableDisciple): boolean {
  return (
    disciple.requiredCultivation === null || disciple.cultivation >= disciple.requiredCultivation
  );
}

function formatCultivation(value: number): string {
  return String(Math.floor(value));
}

/** 列表行要显示的那一条状态（按优先级取最高的一条）。 */
export function discipleStatus(disciple: FilterableDisciple, serverNowMs: number): DiscipleStatus {
  if (isInjured(disciple, serverNowMs)) return { key: 'injured', label: '疗伤中' };
  if (disciple.canBreakthrough) return { key: 'canBreakthrough', label: '可破境' };
  if (disciple.requiredCultivation === null) return { key: 'capped', label: '已达当前版本上限' };
  if (disciple.cultivation >= disciple.requiredCultivation) {
    return { key: 'cultivationFull', label: '修为已满' };
  }
  return { key: 'assignment', label: disciple.assignmentName };
}

/** 历练状态里名册需要的最小结构（`DiscipleView.journey` 的一个子集）。 */
export interface JourneyBadge {
  status: 'none' | 'active' | 'ready';
  directionName: string | null;
  endsAt: string | null;
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * 名册行上的历练标记：在外显示「方向 · 剩余时间」；已归队待领取显示「已归队 · 待领取」；其余为 null。
 *
 * 剩余时间只按调用方给的 `serverNowMs`（服务端时间基准）估算，不读本机时钟；
 * 这里只做展示，不判定可否领取（可否领取只看服务端给的 `status`，前端计时器不能自行发奖）。
 */
export function journeyBadge(journey: JourneyBadge | undefined, serverNowMs: number): string | null {
  if (journey === undefined) return null;
  if (journey.status === 'ready') return '已归队 · 待领取';
  if (journey.status !== 'active') return null;

  // endsAt 缺失/非法时没有剩余时间可算，只显示方向名。
  const direction = journey.directionName ?? '历练中';
  if (journey.endsAt === null) return direction;
  const endsAtMs = Date.parse(journey.endsAt);
  if (!Number.isFinite(endsAtMs) || !Number.isFinite(serverNowMs)) return direction;

  const remainingMs = endsAtMs - serverNowMs;
  if (remainingMs >= HOUR_MS) {
    return `${journey.directionName ?? '历练'} · 约 ${Math.ceil(remainingMs / HOUR_MS)} 小时后归队`;
  }
  return `${journey.directionName ?? '历练'} · 约 ${Math.max(1, Math.ceil(remainingMs / MINUTE_MS))} 分钟后归队`;
}

export interface CultivationProgress {
  /** 0~100 的整数百分比（进度环用）。 */
  percent: number;
  /** 可读数字，如 `90/180`；到达版本上限时为 `已达当前版本上限`。 */
  text: string;
  /** requiredCultivation === null：满环只代表本版本练到头，不代表可破境。 */
  capped: boolean;
  /** 已到门槛（此时未必可破境）。 */
  full: boolean;
}

/** 进度 = cultivation / requiredCultivation，clamp 到 0%~100%，并给出可读数字。 */
export function cultivationProgress(
  cultivation: number,
  requiredCultivation: number | null,
): CultivationProgress {
  if (requiredCultivation === null) {
    return { percent: 100, text: '已达当前版本上限', capped: true, full: false };
  }
  if (requiredCultivation <= 0) {
    return {
      percent: 100,
      text: `${formatCultivation(cultivation)}/${requiredCultivation}`,
      capped: false,
      full: cultivation >= requiredCultivation,
    };
  }
  const raw = (cultivation / requiredCultivation) * 100;
  const percent = Math.min(100, Math.max(0, Math.round(raw)));
  return {
    percent,
    text: `${formatCultivation(cultivation)}/${requiredCultivation}`,
    capped: false,
    full: cultivation >= requiredCultivation,
  };
}

/** 搜索：trim、不区分大小写、包含匹配；空备注不匹配（避免空串命中所有弟子）。 */
export function matchesSearch(disciple: FilterableDisciple, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (query === '') return true;
  if (disciple.name.toLowerCase().includes(query)) return true;
  const note = disciple.note.trim();
  return note !== '' && note.toLowerCase().includes(query);
}

/**
 * 状态筛选：全部 / 可破境 / 疗伤 / 修为已满（含已达当前版本上限）/ 闲置。
 *
 * 「修为已满」刻意排除 `canBreakthrough`：可破境是独立筛选项，且此时行内标签显示「可破境」，
 * 若同时落进「修为已满」会让筛选结果与看到的标签互相矛盾（规格 2.1 的状态语义）。
 * 已达当前版本上限（requiredCultivation === null）同样没有成长空间，一并归入「修为已满」。
 * 疗伤中的弟子仍会命中（规格 2.1 把「疗伤/灵气不足」视为修为满但不可操作的原因之一），
 * 需要只看伤势时用「疗伤」筛选。
 */
export function matchesStatusFilter(
  disciple: FilterableDisciple,
  status: DiscipleStatusFilter,
  serverNowMs: number,
): boolean {
  if (status === 'all') return true;
  if (status === 'canBreakthrough') return disciple.canBreakthrough;
  if (status === 'injured') return isInjured(disciple, serverNowMs);
  if (status === 'cultivationFull') return !disciple.canBreakthrough && hasFullCultivation(disciple);
  return disciple.assignment === IDLE_ASSIGNMENT_ID;
}

/** 境界 / 岗位 / 状态 / 搜索四项组合筛选（每项空值或 all 表示不限）。 */
export function matchesFilters(
  disciple: FilterableDisciple,
  filter: DiscipleFilter,
  serverNowMs: number,
): boolean {
  if (!matchesSearch(disciple, filter.search)) return false;
  if (filter.realmId !== '' && disciple.realmId !== filter.realmId) return false;
  if (filter.assignment !== '' && disciple.assignment !== filter.assignment) return false;
  return matchesStatusFilter(disciple, filter.status, serverNowMs);
}

/**
 * 排序：默认保持 `state.disciples` 的原顺序（招募顺序）。
 * 相同排序值保持原顺序（Array.prototype.sort 在 ES2019 起保证稳定）。
 */
export function sortDisciples<T extends FilterableDisciple>(
  disciples: readonly T[],
  sort: DiscipleSortKey,
): T[] {
  const list = [...disciples];
  if (sort === 'combatPower') {
    list.sort((a, b) => b.combatPower - a.combatPower);
  } else if (sort === 'realm') {
    list.sort((a, b) => b.realmOrder - a.realmOrder || b.stage - a.stage);
  }
  return list;
}

/** 筛选 + 排序；返回新数组，不改动入参。 */
export function filterDisciples<T extends FilterableDisciple>(
  disciples: readonly T[],
  filter: DiscipleFilter,
  serverNowMs: number,
): T[] {
  return sortDisciples(
    disciples.filter((disciple) => matchesFilters(disciple, filter, serverNowMs)),
    filter.sort,
  );
}

export interface RealmFilterOption {
  realmId: string;
  realmName: string;
  realmOrder: number;
}

/** 境界筛选项：从当前弟子的 realmOrder/realmId/realmName 去重派生，按 realmOrder 升序。 */
export function realmOptions(disciples: readonly FilterableDisciple[]): RealmFilterOption[] {
  const byId = new Map<string, RealmFilterOption>();
  for (const disciple of disciples) {
    if (byId.has(disciple.realmId)) continue;
    byId.set(disciple.realmId, {
      realmId: disciple.realmId,
      realmName: disciple.realmName,
      realmOrder: disciple.realmOrder,
    });
  }
  return [...byId.values()].sort((a, b) => a.realmOrder - b.realmOrder);
}

/** 是否处于非默认筛选（决定「重置」按钮与无结果文案）。 */
export function isFilterActive(filter: DiscipleFilter): boolean {
  return (
    filter.search.trim() !== '' ||
    filter.realmId !== '' ||
    filter.assignment !== '' ||
    filter.status !== 'all' ||
    filter.sort !== 'recruitOrder'
  );
}
