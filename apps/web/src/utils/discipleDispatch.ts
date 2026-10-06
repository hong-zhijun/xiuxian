/**
 * 门人调度：根据天赋、岗位名额与执事堂现状，算出「哪里没安排好」和「推荐怎么调」（纯函数，不碰 DOM / Vue）。
 *
 * 规则与服务端同口径（服务端仍是最终裁决，执行时不合规的会被跳过并说明原因）：
 *   - 产出 / 修行天赋只在对应岗位生效：灵植 → 药园，矿脉 → 采矿，聚灵 → 采灵 / 吐纳，悟道 → 修炼
 *     （apps/server/src/modules/game/talents.ts 的 condition 列）；
 *   - 执事加成按任职者境界放大，所以每个职位推荐该天赋里境界最高、不在外、不在守擂阵容里的弟子；
 *     现任已是同境界就不换（换人会让原执事进 12 小时交接期）；每职位每天只能任命一次；
 *   - 没有岗位加成的弟子（战意 / 会心 / 铁骨 / 丹心 / 执事天赋 / 无天赋）保持原岗位，只把闲置的派去修炼；
 *   - 在外历练、重伤卧床的弟子不能转岗，不进推荐。
 */

export const IDLE = 'idle';
export const CULTIVATING = 'cultivating';

/** 天赋 → 能发挥作用的岗位（按优先顺序；采灵 / 吐纳有人数上限）。 */
export const TALENT_POSTS: Readonly<Record<string, readonly string[]>> = {
  herbGathering: ['herbGathering'],
  mining: ['oreGathering'],
  spiritGathering: ['stoneMining', 'energyGathering'],
  cultivation: [CULTIVATING],
};

export interface DispatchDisciple {
  id: string;
  name: string;
  talent: string;
  talentName: string;
  talentEffect: string;
  assignment: string;
  realmOrder: number;
  stage: number;
  canBreakthrough: boolean;
  severeInjuredUntil?: string | null;
  journey?: { status: string; endsAt: string | null };
  stewardOffice: string | null;
}

export interface DispatchAssignmentOption {
  id: string;
  name: string;
  maxCount: number | null;
}

export interface DispatchOffice {
  office: string;
  name: string;
  talentId: string;
  talentName: string;
  discipleId: string | null;
  paused: boolean;
  canAppointToday: boolean;
}

export interface DispatchInput {
  disciples: readonly DispatchDisciple[];
  assignments: readonly DispatchAssignmentOption[];
  offices: readonly DispatchOffice[];
  defenseLineup: readonly string[] | null;
  serverNowMs: number;
}

export interface DispatchMove {
  key: string;
  discipleId: string;
  discipleName: string;
  from: string;
  fromName: string;
  to: string;
  toName: string;
  reason: string;
}

export interface DispatchAppointment {
  key: string;
  office: string;
  officeName: string;
  discipleId: string;
  discipleName: string;
  /** 被替换的现任执事；空缺时为 null。 */
  replacingName: string | null;
  reason: string;
}

export interface DispatchIssue {
  key: string;
  title: string;
  /** 涉及的弟子（点名字可打开详情）；纯说明类提示为空数组。 */
  disciples: { id: string; name: string; note?: string }[];
  /** 补充说明（例如「采灵 / 吐纳已满」）。 */
  detail?: string;
  /** 一键调度能不能解决（不能的只提示）。 */
  fixable: boolean;
}

export interface DispatchPlan {
  moves: DispatchMove[];
  appointments: DispatchAppointment[];
  issues: DispatchIssue[];
}

/** 在外历练、尚未归队（不能转岗，也不能就任执事）。 */
export function isAway(disciple: DispatchDisciple, serverNowMs: number): boolean {
  const journey = disciple.journey;
  if (journey?.status !== 'active') return false;
  if (journey.endsAt === null) return true;
  const endsAt = Date.parse(journey.endsAt);
  return !Number.isFinite(endsAt) || endsAt > serverNowMs;
}

/** 不能转岗（在外历练 / 重伤卧床）。 */
export function isUnavailable(disciple: DispatchDisciple, serverNowMs: number): boolean {
  if (isAway(disciple, serverNowMs)) return true;
  const severe = disciple.severeInjuredUntil ?? null;
  if (severe !== null) {
    const until = Date.parse(severe);
    if (Number.isFinite(until) && until > serverNowMs) return true;
  }
  return false;
}

/** 天赋对应的岗位；没有岗位加成的天赋返回 null。 */
export function talentPostsOf(talent: string): readonly string[] | null {
  return TALENT_POSTS[talent] ?? null;
}

/** 天赋有对口岗位、但人不在对口岗位上（名册标记用）。 */
export function isTalentMisplaced(disciple: DispatchDisciple): boolean {
  const posts = talentPostsOf(disciple.talent);
  return posts !== null && !posts.includes(disciple.assignment);
}

/** 名册标记的提示文字：如「灵植在药园才生效」。 */
export function misplacedHint(disciple: DispatchDisciple, assignments: readonly DispatchAssignmentOption[]): string {
  const posts = talentPostsOf(disciple.talent) ?? [];
  const names = posts.map((id) => assignments.find((item) => item.id === id)?.name ?? id);
  return `${disciple.talentName}在${names.join(' / ')}才生效`;
}

function higherRealm(a: DispatchDisciple, b: DispatchDisciple): number {
  return b.realmOrder - a.realmOrder || b.stage - a.stage;
}

export function planDispatch(input: DispatchInput): DispatchPlan {
  const { disciples, assignments, offices, serverNowMs } = input;
  const lineup = new Set(input.defenseLineup ?? []);
  const nameOf = (id: string): string =>
    id === IDLE ? '闲置' : (assignments.find((item) => item.id === id)?.name ?? id);
  const maxOf = (id: string): number | null => assignments.find((item) => item.id === id)?.maxCount ?? null;
  const validPost = (id: string): boolean => assignments.some((item) => item.id === id);

  // 模拟调整后的岗位人数（有上限的岗位按顺序占位，挪走的人会腾出名额）。
  const counts = new Map<string, number>();
  for (const disciple of disciples) {
    counts.set(disciple.assignment, (counts.get(disciple.assignment) ?? 0) + 1);
  }
  const hasRoom = (post: string): boolean => {
    const max = maxOf(post);
    return max === null || (counts.get(post) ?? 0) < max;
  };

  const moves: DispatchMove[] = [];
  const moved = new Set<string>();
  const move = (disciple: DispatchDisciple, to: string, reason: string): void => {
    counts.set(disciple.assignment, (counts.get(disciple.assignment) ?? 1) - 1);
    counts.set(to, (counts.get(to) ?? 0) + 1);
    moved.add(disciple.id);
    moves.push({
      key: `move:${disciple.id}`,
      discipleId: disciple.id,
      discipleName: disciple.name,
      from: disciple.assignment,
      fromName: nameOf(disciple.assignment),
      to,
      toName: nameOf(to),
      reason,
    });
  };

  const available = disciples.filter((disciple) => !isUnavailable(disciple, serverNowMs));
  const misplaced = available.filter(isTalentMisplaced);
  const talentReason = (disciple: DispatchDisciple): string =>
    disciple.talentEffect === '' ? disciple.talentName : `${disciple.talentName}：${disciple.talentEffect}`;

  // 1) 不限人数的对口岗位先调（顺带把有上限岗位上的错位弟子挪走，腾出名额）。
  for (const disciple of misplaced) {
    const posts = talentPostsOf(disciple.talent) ?? [];
    const target = posts.find((post) => validPost(post) && maxOf(post) === null);
    if (target !== undefined && posts.length === 1) move(disciple, target, talentReason(disciple));
  }
  // 2) 有上限的对口岗位（聚灵 → 采灵 / 吐纳）：境界高的先占位。
  const crowded: DispatchDisciple[] = [];
  for (const disciple of [...misplaced].sort(higherRealm)) {
    if (moved.has(disciple.id)) continue;
    const posts = (talentPostsOf(disciple.talent) ?? []).filter(validPost);
    const target = posts.find(hasRoom);
    if (target === undefined) {
      crowded.push(disciple);
      continue;
    }
    move(disciple, target, talentReason(disciple));
  }
  // 3) 其余闲置的派去修炼。
  const idle = available.filter((disciple) => disciple.assignment === IDLE && !moved.has(disciple.id));
  if (validPost(CULTIVATING)) {
    for (const disciple of idle) move(disciple, CULTIVATING, '闲置没有任何产出，先去修炼');
  }

  // 执事堂：每个职位推荐该天赋里境界最高、不在外、不在守擂阵容里的弟子。
  const appointments: DispatchAppointment[] = [];
  const stewardIssues: DispatchIssue[] = [];
  for (const office of offices) {
    const current = office.discipleId === null ? undefined : disciples.find((item) => item.id === office.discipleId);
    const talented = disciples.filter((item) => item.talent === office.talentId);
    const candidates = talented
      // 任命只要求不在外（重伤也能坐镇）；现任即使在外也参与比较，免得推荐换下同境界的人。
      .filter((item) => !isAway(item, serverNowMs) || item.id === office.discipleId)
      .filter((item) => !lineup.has(item.id))
      .sort(higherRealm);
    const best = candidates[0];
    if (office.paused && current !== undefined) {
      stewardIssues.push({
        key: `steward-paused:${office.office}`,
        title: `${office.name}在外历练，加成暂停`,
        disciples: [{ id: current.id, name: current.name }],
        fixable: false,
      });
    }
    const better =
      best !== undefined &&
      best.id !== current?.id &&
      (current === undefined || best.realmOrder > current.realmOrder);
    if (!better) {
      if (office.discipleId === null && talented.length > 0 && best === undefined) {
        stewardIssues.push({
          key: `steward-blocked:${office.office}`,
          title: `${office.name}空缺`,
          disciples: talented.map((item) => ({ id: item.id, name: item.name })),
          detail: `有「${office.talentName}」天赋的弟子都在外或在守擂阵容里，暂时任命不了`,
          fixable: false,
        });
      }
      continue;
    }
    const reason =
      current === undefined
        ? `职位空缺，${best.name}有「${office.talentName}」天赋`
        : `${best.name}境界高于现任${current.name}，加成更大（${current.name}卸任后有交接期）`;
    if (!office.canAppointToday) {
      stewardIssues.push({
        key: `steward-tomorrow:${office.office}`,
        title: current === undefined ? `${office.name}空缺` : `${office.name}有更合适的人选`,
        disciples: [{ id: best.id, name: best.name }],
        detail: '今天已任命过，明日再换',
        fixable: false,
      });
      continue;
    }
    appointments.push({
      key: `appoint:${office.office}`,
      office: office.office,
      officeName: office.name,
      discipleId: best.id,
      discipleName: best.name,
      replacingName: current?.name ?? null,
      reason,
    });
  }

  const issues: DispatchIssue[] = [];
  if (misplaced.length > 0) {
    issues.push({
      key: 'misplaced',
      title: `${misplaced.length} 人天赋未发挥`,
      disciples: misplaced.map((item) => ({
        id: item.id,
        name: item.name,
        note: `${item.talentName}·在${nameOf(item.assignment)}`,
      })),
      fixable: true,
    });
  }
  if (crowded.length > 0) {
    issues.push({
      key: 'crowded',
      title: `${crowded.length} 名聚灵弟子没有位置`,
      disciples: crowded.map((item) => ({ id: item.id, name: item.name })),
      detail: '采灵 / 吐纳岗位已满，可手动把占位的其他弟子换走',
      fixable: false,
    });
  }
  if (idle.length > 0) {
    issues.push({
      key: 'idle',
      title: `${idle.length} 人闲置`,
      disciples: idle.map((item) => ({ id: item.id, name: item.name })),
      fixable: true,
    });
  }
  for (const appointment of appointments) {
    issues.push({
      key: `steward:${appointment.office}`,
      title: appointment.replacingName === null ? `${appointment.officeName}空缺` : `${appointment.officeName}有更合适的人选`,
      disciples: [{ id: appointment.discipleId, name: appointment.discipleName }],
      fixable: true,
    });
  }
  issues.push(...stewardIssues);
  const ready = disciples.filter((item) => item.canBreakthrough);
  if (ready.length > 0) {
    issues.push({
      key: 'breakthrough',
      title: `${ready.length} 人可破境`,
      disciples: ready.map((item) => ({ id: item.id, name: item.name })),
      detail: '破境有成败，不放进一键调度；可在名册多选后批量破境',
      fixable: false,
    });
  }

  return { moves, appointments, issues };
}

/**
 * 执行顺序：先调不限人数的岗位（把占着采灵 / 吐纳的错位弟子挪走），再调有上限的岗位，最后任命执事。
 * 同一目标岗位合成一次批量换岗请求。
 */
export function moveBatches(
  moves: readonly DispatchMove[],
  assignments: readonly DispatchAssignmentOption[],
): { assignment: string; discipleIds: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const item of moves) {
    groups.set(item.to, [...(groups.get(item.to) ?? []), item.discipleId]);
  }
  const capped = (id: string): boolean => assignments.find((item) => item.id === id)?.maxCount != null;
  return [...groups.entries()]
    .sort(([a], [b]) => Number(capped(a)) - Number(capped(b)))
    .map(([assignment, discipleIds]) => ({ assignment, discipleIds }));
}
