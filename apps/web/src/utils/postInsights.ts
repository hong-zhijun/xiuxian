import { TALENT_POSTS, CULTIVATING, IDLE, talentPostsOf } from './discipleDispatch';

/**
 * 门人调度 ·「岗位」页：每个岗位 / 执事一张卡片 —— 谁在岗、境界最高的是谁、还有几个备选，外加只做提示的建议（纯函数）。
 *
 * 提示依据（apps/server/src/modules/game/settle.ts）：
 *   - 岗位产出 = 基础 ×（1 + 对口天赋加成），境界只影响天赋加成（炼气 +20% … 化神 +50%）；
 *   - 只有修炼岗位长修为，修炼速度主要看资质；
 *   - 执事加成随境界变高，当执事不占岗位，所以执事本人最好在修炼。
 * 这些都是取舍，只提示、不放进一键调度。
 */

export interface PostInsightDisciple {
  id: string;
  name: string;
  talent: string;
  talentName: string;
  talentEffect: string;
  assignment: string;
  realmOrder: number;
  realmName: string;
  stage: number;
  aptitude: number;
}

export interface PostInsightAssignment {
  id: string;
  name: string;
  maxCount: number | null;
}

export interface PostInsightOffice {
  office: string;
  name: string;
  talentId: string;
  talentName: string;
  discipleId: string | null;
  effect: string | null;
  paused: boolean;
}

export interface PostPerson {
  id: string;
  name: string;
  note: string;
}

export interface PostLine {
  label: string;
  people: PostPerson[];
  /** 没有人时显示的文字。 */
  empty?: string;
}

export interface PostTip {
  text: string;
  people: PostPerson[];
}

export interface PostCard {
  key: string;
  title: string;
  summary: string;
  lines: PostLine[];
  tips: PostTip[];
}

/** 岗位 → 对口天赋（TALENT_POSTS 反查）。 */
function talentOfPost(post: string): string | undefined {
  return Object.entries(TALENT_POSTS).find(([, posts]) => posts.includes(post))?.[0];
}

function byRealm(a: PostInsightDisciple, b: PostInsightDisciple): number {
  return b.realmOrder - a.realmOrder || b.stage - a.stage;
}

/** 有产出 / 修行岗位加成的天赋（灵植、矿脉、聚灵、悟道）。 */
function hasPostTalent(disciple: PostInsightDisciple): boolean {
  return talentPostsOf(disciple.talent) !== null;
}

/** 门中境界的中位数（下标）：低于它算「境界偏低」。 */
function medianRealm(disciples: readonly PostInsightDisciple[]): number {
  if (disciples.length === 0) return 0;
  const sorted = disciples.map((item) => item.realmOrder).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * 资质门槛：门中资质最高 / 最低的四分之一（至少 1 人）里的边界值；门人太少（< 4）时不给资质建议。
 * side = 'high' 取最高那一档的下沿，'low' 取最低那一档的上沿。
 */
function aptitudeCut(disciples: readonly PostInsightDisciple[], side: 'high' | 'low'): number | null {
  if (disciples.length < 4) return null;
  const sorted = disciples.map((item) => item.aptitude).sort((a, b) => a - b);
  const count = Math.max(1, Math.floor(sorted.length / 4));
  return (side === 'high' ? sorted[sorted.length - count] : sorted[count - 1]) ?? null;
}

export function postInsights(input: {
  disciples: readonly PostInsightDisciple[];
  assignments: readonly PostInsightAssignment[];
  offices: readonly PostInsightOffice[];
  /** 天赋目录（只用 id → 名称，岗位上一个对口天赋弟子都没有时也能写出天赋名）。 */
  talents: readonly { id: string; name: string }[];
}): PostCard[] {
  const { disciples, assignments, offices } = input;
  const talentNameOf = (id: string): string => input.talents.find((item) => item.id === id)?.name ?? '对口天赋';
  const nameOf = (id: string): string =>
    id === IDLE ? '闲置' : (assignments.find((item) => item.id === id)?.name ?? id);
  const realmNote = (d: PostInsightDisciple): string => d.realmName;
  const median = medianRealm(disciples);
  const stewardIds = new Set(offices.map((item) => item.discipleId).filter((id): id is string => id !== null));

  const cards: PostCard[] = [];

  for (const post of assignments) {
    if (post.id === IDLE) continue;
    const inPost = disciples.filter((item) => item.assignment === post.id).sort(byRealm);
    const talentId = talentOfPost(post.id);
    const talented = talentId === undefined ? [] : disciples.filter((item) => item.talent === talentId).sort(byRealm);
    const talentedIn = talented.filter((item) => item.assignment === post.id);
    const backups = talented.filter((item) => item.assignment !== post.id);
    const talentName = talentId === undefined ? '' : talentNameOf(talentId);
    const cap = post.maxCount === null ? '' : ` / ${post.maxCount}`;

    const lines: PostLine[] = [];
    const top = talentedIn[0] ?? inPost[0];
    lines.push({
      label: '在岗最高',
      people:
        top === undefined
          ? []
          : [
              {
                id: top.id,
                name: top.name,
                note: talentedIn[0] === top && top.talentEffect !== '' ? `${top.realmName}·${top.talentEffect}` : top.realmName,
              },
            ],
      empty: '无人在岗',
    });
    if (talentId !== undefined) {
      lines.push({
        label: `备选（${talentName}不在岗）`,
        people: backups.map((item) => ({ id: item.id, name: item.name, note: `${item.realmName}·在${nameOf(item.assignment)}` })),
        empty: '没有',
      });
    }

    const tips: PostTip[] = [];
    const lowRealm = talentedIn.filter((item) => item.realmOrder < median);
    if (lowRealm.length > 0 && post.id !== CULTIVATING) {
      tips.push({
        text: '对口天赋但境界偏低，加成随境界提高；不必撤岗，可用聚气丹或历练补境界',
        people: lowRealm.map((item) => ({ id: item.id, name: item.name, note: `${item.realmName}·${item.talentEffect}` })),
      });
    }

    if (post.id === CULTIVATING) {
      // 资质建议：只看没有岗位天赋、也不是执事的人（他们放哪儿都一样，按修炼快慢分）。
      const free = disciples.filter((item) => !hasPostTalent(item) && !stewardIds.has(item.id));
      // 资质高低只在这群人里比：有岗位天赋的人去留看天赋，不看资质。
      const highAptitude = aptitudeCut(free, 'high');
      const lowAptitude = aptitudeCut(free, 'low');
      if (highAptitude !== null) {
        const fast = free.filter(
          (item) => item.aptitude >= highAptitude && item.assignment !== CULTIVATING && item.assignment !== IDLE,
        );
        if (fast.length > 0) {
          tips.push({
            text: '资质高、又没有产出天赋，在产出岗位上不长修为，建议去修炼',
            people: fast.map((item) => ({ id: item.id, name: item.name, note: `资质 ${item.aptitude}·在${nameOf(item.assignment)}` })),
          });
        }
      }
      if (lowAptitude !== null) {
        const slow = free.filter(
          (item) => item.aptitude <= lowAptitude && item.assignment === CULTIVATING && item.talent !== 'combat' && item.talent !== 'critical' && item.talent !== 'ironBody',
        );
        if (slow.length > 0) {
          tips.push({
            text: '资质低、没有产出或战斗天赋，修得慢，可考虑去药园 / 采矿产出',
            people: slow.map((item) => ({ id: item.id, name: item.name, note: `资质 ${item.aptitude}` })),
          });
        }
      }
    }

    cards.push({
      key: `post:${post.id}`,
      title: post.id === CULTIVATING ? '修炼' : post.name,
      summary:
        `在岗 ${inPost.length}${cap} 人` +
        (talentId === undefined ? '' : `，其中${talentName} ${talentedIn.length} 人`),
      lines,
      tips,
    });
  }

  for (const office of offices) {
    const current = office.discipleId === null ? undefined : disciples.find((item) => item.id === office.discipleId);
    const backups = disciples.filter((item) => item.talent === office.talentId && item.id !== office.discipleId).sort(byRealm);
    const tips: PostTip[] = [];
    if (current !== undefined && current.assignment !== CULTIVATING) {
      tips.push({
        text: `执事加成随境界变高，当执事不占岗位；${current.name}改去修炼，以后加成更大`,
        people: [{ id: current.id, name: current.name, note: `在${nameOf(current.assignment)}` }],
      });
    }
    if (current !== undefined && office.paused) {
      tips.push({ text: '执事在外历练，归队前加成暂停', people: [{ id: current.id, name: current.name, note: realmNote(current) }] });
    }
    if (current !== undefined && backups[0] !== undefined && backups[0].realmOrder > current.realmOrder) {
      tips.push({
        text: '备选里有境界更高的人选，换上加成更大（原执事卸任后有交接期）',
        people: [{ id: backups[0].id, name: backups[0].name, note: backups[0].realmName }],
      });
    }
    cards.push({
      key: `office:${office.office}`,
      title: office.name,
      summary: current === undefined ? '空缺' : `现任 ${current.name}`,
      lines: [
        {
          label: '现任',
          people:
            current === undefined
              ? []
              : [{ id: current.id, name: current.name, note: `${current.realmName}${office.effect ? `·${office.effect}` : ''}` }],
          empty: '空缺',
        },
        {
          label: `备选（${office.talentName}）`,
          people: backups.map((item) => ({ id: item.id, name: item.name, note: item.realmName })),
          empty: `门下没有其他${office.talentName}弟子`,
        },
      ],
      tips,
    });
  }

  return cards;
}
