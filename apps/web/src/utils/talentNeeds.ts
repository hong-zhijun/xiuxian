/**
 * 门人调度 ·「人才」页：按宗门现状算出每种天赋「有几人、还缺几人」，以及当前最该补的人才（纯函数）。
 *
 * 口径（天赋效果见 apps/server/src/modules/game/talents.ts）：
 *   - 执事天赋（炼器 / 丹道 / 寻宝）：每种有 1 人就能任执事，0 人 = 急缺；
 *   - 聚灵：采灵 + 吐纳的名额都该由聚灵弟子占，缺口 = 名额 − 聚灵人数；
 *   - 灵植 / 矿脉 / 悟道：缺口 = 药园 / 采矿 / 修炼岗位上「不是该天赋」的人数（换成对口天赋就有加成）；
 *   - 战斗天赋（战意 / 会心 / 铁骨）合起来看：守擂与讨伐一队 3 人，少于 3 人算缺；
 *   - 丹心只在服聚气丹时生效，不算缺口，只做说明。
 * 补人的途径：招贤台留意对应天赋的候选人，或给现有弟子服洗髓丹重洗天赋。
 */

export interface TalentNeedDisciple {
  id: string;
  name: string;
  talent: string;
  assignment: string;
  realmOrder: number;
  realmName: string;
}

export interface TalentNeedCatalogEntry {
  id: string;
  name: string;
  category: string;
  categoryName: string;
  condition: string;
  effect: string;
}

export interface TalentNeedAssignment {
  id: string;
  name: string;
  maxCount: number | null;
}

export type TalentNeedLevel = 'urgent' | 'short' | 'ok' | 'info';

export interface TalentNeedRow {
  talentId: string;
  name: string;
  categoryName: string;
  /** 生效条件 · 效果（如「在药园岗位时：药材产出 +x%」）。 */
  usage: string;
  holders: { id: string; name: string; realmName: string }[];
  /** 还缺几人；null = 不按人数衡量（丹心）。 */
  gap: number | null;
  level: TalentNeedLevel;
  /** 一句话说明为什么缺 / 够不够。 */
  advice: string;
}

/** 战斗天赋：守擂 / 讨伐一队 3 人。 */
const COMBAT_TALENTS = ['combat', 'critical', 'ironBody'];
const COMBAT_TEAM_SIZE = 3;

/** 「当前最需要」排序：急缺在前，同级里缺口大的在前，再按这个固定顺序。 */
const PRIORITY = ['alchemy', 'forging', 'treasure', 'spiritGathering', 'herbGathering', 'mining', 'combat', 'critical', 'ironBody', 'cultivation', 'pillAffinity'];
const LEVEL_ORDER: Record<TalentNeedLevel, number> = { urgent: 0, short: 1, info: 2, ok: 3 };

export function talentNeeds(input: {
  disciples: readonly TalentNeedDisciple[];
  talents: readonly TalentNeedCatalogEntry[];
  assignments: readonly TalentNeedAssignment[];
}): TalentNeedRow[] {
  const { disciples, talents, assignments } = input;
  const nameOf = (id: string): string => assignments.find((item) => item.id === id)?.name ?? id;
  const capOf = (id: string): number => assignments.find((item) => item.id === id)?.maxCount ?? 0;
  const holdersOf = (talentId: string) =>
    disciples
      .filter((item) => item.talent === talentId)
      .sort((a, b) => b.realmOrder - a.realmOrder)
      .map((item) => ({ id: item.id, name: item.name, realmName: item.realmName }));
  const staffedWithout = (post: string, talentId: string): number =>
    disciples.filter((item) => item.assignment === post && item.talent !== talentId).length;
  const combatHolders = disciples.filter((item) => COMBAT_TALENTS.includes(item.talent)).length;

  const rows = talents.map((talent): TalentNeedRow => {
    const holders = holdersOf(talent.id);
    const base = {
      talentId: talent.id,
      name: talent.name,
      categoryName: talent.categoryName,
      usage: `${talent.condition}：${talent.effect}`,
      holders,
    };

    if (talent.category === 'steward') {
      return holders.length === 0
        ? { ...base, gap: 1, level: 'urgent', advice: `没有${talent.name}弟子，对应执事无人可任` }
        : { ...base, gap: 0, level: 'ok', advice: `可由${holders[0]!.name}（${holders[0]!.realmName}）任执事，境界越高加成越大` };
    }

    if (talent.id === 'spiritGathering') {
      const slots = capOf('stoneMining') + capOf('energyGathering');
      const gap = Math.max(0, slots - holders.length);
      return gap > 0
        ? {
            ...base,
            gap,
            level: holders.length === 0 ? 'urgent' : 'short',
            advice: `${nameOf('stoneMining')}和${nameOf('energyGathering')}共 ${slots} 个名额，还差 ${gap} 名聚灵弟子`,
          }
        : { ...base, gap: 0, level: 'ok', advice: `${nameOf('stoneMining')} / ${nameOf('energyGathering')}名额都能由聚灵弟子占满` };
    }

    const post = { herbGathering: 'herbGathering', mining: 'oreGathering', cultivation: 'cultivating' }[talent.id];
    if (post !== undefined) {
      // 已有但不在对口岗位上的同天赋弟子先抵掉缺口：调过去就能补上（门人调度会推荐）。
      const misplaced = disciples.filter((item) => item.talent === talent.id && item.assignment !== post).length;
      const gap = Math.max(0, staffedWithout(post, talent.id) - misplaced);
      if (gap === 0) {
        return { ...base, gap: 0, level: 'ok', advice: `${nameOf(post)}岗位上都是（或可调来）${talent.name}弟子` };
      }
      return {
        ...base,
        gap,
        level: 'short',
        advice: `${nameOf(post)}还有 ${gap} 人不是${talent.name}，换成${talent.name}弟子就有加成`,
      };
    }

    if (COMBAT_TALENTS.includes(talent.id)) {
      const gap = Math.max(0, COMBAT_TEAM_SIZE - combatHolders);
      return gap > 0
        ? {
            ...base,
            gap,
            level: 'short',
            advice: `战斗天赋（战意 / 会心 / 铁骨）合计 ${combatHolders} 人，凑满守擂 / 讨伐一队还差 ${gap} 人`,
          }
        : { ...base, gap: 0, level: holders.length > 0 ? 'ok' : 'info', advice: `战斗天赋合计 ${combatHolders} 人，够凑一队` };
    }

    return { ...base, gap: null, level: 'info', advice: '常服聚气丹冲境界时才有用，不急' };
  });

  return rows.sort(
    (a, b) =>
      LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
      (b.gap ?? 0) - (a.gap ?? 0) ||
      PRIORITY.indexOf(a.talentId) - PRIORITY.indexOf(b.talentId),
  );
}

export interface TopTalentNeed {
  key: string;
  title: string;
  advice: string;
  level: TalentNeedLevel;
}

/** 「当前最需要」：急缺 / 不足的前 3 项；三种战斗天赋合成一条（任意一种都行）。 */
export function topTalentNeeds(rows: readonly TalentNeedRow[], limit = 3): TopTalentNeed[] {
  const result: TopTalentNeed[] = [];
  let combatAdded = false;
  for (const row of rows) {
    if (row.level !== 'urgent' && row.level !== 'short') continue;
    if (COMBAT_TALENTS.includes(row.talentId)) {
      if (combatAdded) continue;
      combatAdded = true;
      result.push({ key: 'combat', title: `战斗天赋 ×${row.gap ?? 0}`, advice: row.advice, level: row.level });
    } else {
      result.push({ key: row.talentId, title: `${row.name} ×${row.gap ?? 0}`, advice: row.advice, level: row.level });
    }
    if (result.length >= limit) break;
  }
  return result;
}
