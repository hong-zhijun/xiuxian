import { describe, expect, it } from 'vitest';

import {
  DAILY_CHEST_DESCRIPTION,
  DAILY_CHEST_PILL_IDS,
  DAILY_CHEST_SHENMU_RANGE,
  DAILY_CHEST_XUANTIE_RANGE,
  DAILY_TASKS,
  DAILY_TASK_COUNT,
  DAILY_TASK_IDS,
  DAILY_TASK_MAX_PVP,
  DAILY_TASK_MIN_EASY,
  DAILY_TASK_STONE_PER_LEVEL,
  dailyTaskAvailableIds,
  dailyTaskReward,
  findDailyTask,
  isDailyTaskId,
  pickDailyTasks,
  rollDailyChest,
  type DailyTaskId,
  type DailyTaskSituation,
} from '../../apps/server/src/modules/game/dailyTasks';
import { GAMBLING_UNLOCK_SECT_LEVEL } from '../../apps/server/src/modules/game/gambling';
import { MARKET_UNLOCK_SECT_LEVEL } from '../../apps/server/src/modules/game/market';
import { TOWER_UNLOCK_SECT_LEVEL } from '../../apps/server/src/modules/game/tower';
import { VEIN_UNLOCK_SECT_LEVEL } from '../../apps/server/src/modules/game/veins';
import { UNITS_PER_DISPLAY } from '../../apps/server/src/modules/game/shop';

/**
 * 宗门日课纯规则（apps/server/src/modules/game/dailyTasks.ts，docs/每日任务开发计划.md 第 1、3.1 节）。
 *
 * 只测纯函数：不读库、不取时间。随机抽取用固定种子（同一种子必然同一结果），
 * 宝箱用注入的固定随机序列覆盖上下界。
 */

const ALL_IDS: readonly DailyTaskId[] = DAILY_TASK_IDS;

/** 一个处境：等级 1、没建演武场、弟子满编（只剩 4 个无条件任务）。 */
const LEVEL_ONE_BARE: DailyTaskSituation = {
  sectLevel: 1,
  arenaLevel: 0,
  towerMaxFloor: 0,
  discipleCount: 5,
  discipleCapacity: 5,
};

/** 一个处境：宗门 3 级、演武场已建、镇妖塔过过层、还能招人（10 个任务全部可选）。 */
const LEVEL_THREE_FULL: DailyTaskSituation = {
  sectLevel: 3,
  arenaLevel: 1,
  towerMaxFloor: 4,
  discipleCount: 3,
  discipleCapacity: 10,
};

function categoryOf(id: DailyTaskId): string {
  return findDailyTask(id)?.category ?? 'unknown';
}

/** 随机序列生成器：按取用顺序依次返回给定的值（用于固定宝箱的每一步随机）。 */
function sequence(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) throw new Error('随机序列用尽');
    return value;
  };
}

describe('日课任务池（计划 1.1）', () => {
  it('10 个任务的目标与类别与计划表一致', () => {
    const table = DAILY_TASKS.map((task) => [task.id, task.target, task.category]);
    expect(table).toEqual([
      ['bossHit', 3, 'normal'],
      ['explore', 2, 'normal'],
      ['challenge', 1, 'pvp'],
      ['spar', 2, 'normal'],
      ['gamble', 3, 'normal'],
      ['journey', 1, 'easy'],
      ['towerSweep', 1, 'easy'],
      ['recruit', 1, 'easy'],
      ['stockTrade', 1, 'easy'],
      ['veinAttack', 1, 'pvp'],
    ]);
  });

  it('任务 id 列表与任务池表同序，且每个 id 都能查到定义', () => {
    expect(DAILY_TASKS.map((task) => task.id)).toEqual([...DAILY_TASK_IDS]);
    for (const id of DAILY_TASK_IDS) {
      expect(findDailyTask(id)?.id).toBe(id);
    }
    expect(findDailyTask('nope')).toBeNull();
    expect(isDailyTaskId('spar')).toBe(true);
    expect(isDailyTaskId('nope')).toBe(false);
  });

  it('常量与计划一致：5 个、至少 2 个轻松、最多 1 个 PvP、单任务 50 灵石 / 级', () => {
    expect(DAILY_TASK_COUNT).toBe(5);
    expect(DAILY_TASK_MIN_EASY).toBe(2);
    expect(DAILY_TASK_MAX_PVP).toBe(1);
    expect(DAILY_TASK_STONE_PER_LEVEL).toBe(50);
  });

  it('出现条件与解锁常量一致：赌坊 / 镇妖塔 / 灵股 / 灵脉', () => {
    expect(dailyTaskAvailableIds({ ...LEVEL_ONE_BARE, sectLevel: GAMBLING_UNLOCK_SECT_LEVEL - 1 })).not.toContain('gamble');
    expect(dailyTaskAvailableIds({ ...LEVEL_ONE_BARE, sectLevel: GAMBLING_UNLOCK_SECT_LEVEL })).toContain('gamble');
    expect(dailyTaskAvailableIds({ ...LEVEL_ONE_BARE, sectLevel: MARKET_UNLOCK_SECT_LEVEL - 1 })).not.toContain('stockTrade');
    expect(dailyTaskAvailableIds({ ...LEVEL_ONE_BARE, sectLevel: MARKET_UNLOCK_SECT_LEVEL })).toContain('stockTrade');
    expect(dailyTaskAvailableIds({ ...LEVEL_ONE_BARE, sectLevel: VEIN_UNLOCK_SECT_LEVEL - 1 })).not.toContain('veinAttack');
    expect(dailyTaskAvailableIds({ ...LEVEL_ONE_BARE, sectLevel: VEIN_UNLOCK_SECT_LEVEL })).toContain('veinAttack');
    // 镇妖塔：解锁等级且闯过至少一层才有扫荡。
    expect(dailyTaskAvailableIds({ ...LEVEL_THREE_FULL, towerMaxFloor: 0 })).not.toContain('towerSweep');
    expect(dailyTaskAvailableIds({ ...LEVEL_THREE_FULL, sectLevel: TOWER_UNLOCK_SECT_LEVEL - 1 })).not.toContain('towerSweep');
  });
});

describe('出现条件（dailyTaskAvailableIds）', () => {
  it('1 级无演武场、弟子满编：只剩 4 个无条件任务', () => {
    expect(dailyTaskAvailableIds(LEVEL_ONE_BARE)).toEqual(['bossHit', 'challenge', 'spar', 'journey']);
  });

  it('演武场决定秘境探索；弟子没满才有招募弟子', () => {
    const available = dailyTaskAvailableIds({ ...LEVEL_ONE_BARE, arenaLevel: 1, discipleCount: 4 });
    expect(available).toContain('explore');
    expect(available).toContain('recruit');
    expect(available).toEqual(['bossHit', 'explore', 'challenge', 'spar', 'journey', 'recruit']);
  });

  it('宗门 3 级、全部前置满足：10 个任务全部可选，并保持任务池顺序', () => {
    expect(dailyTaskAvailableIds(LEVEL_THREE_FULL)).toEqual([...DAILY_TASK_IDS]);
  });
});

describe('抽取 5 个（pickDailyTasks，计划 1.2）', () => {
  it('同一种子结果相同，且与可选任务的输入顺序无关', () => {
    const ids = [...ALL_IDS];
    const reversed = [...ALL_IDS].reverse();
    expect(pickDailyTasks(ids, 'sect-a:2026-10-10')).toEqual(pickDailyTasks(ids, 'sect-a:2026-10-10'));
    expect(pickDailyTasks(reversed, 'sect-a:2026-10-10')).toEqual(pickDailyTasks(ids, 'sect-a:2026-10-10'));
  });

  it('不同种子会抽出不同的组合（结果随种子变化）', () => {
    const results = new Set<string>();
    for (let index = 0; index < 60; index += 1) {
      results.add(pickDailyTasks(ALL_IDS, `sect-b:2026-10-${String(index)}`).join(','));
    }
    expect(results.size).toBeGreaterThan(5);
  });

  it('结果不重复、只从可选里抽、按任务池顺序排列', () => {
    for (let index = 0; index < 40; index += 1) {
      const available = dailyTaskAvailableIds(LEVEL_THREE_FULL);
      const picked = pickDailyTasks(available, `sect-c:${String(index)}`);
      expect(new Set(picked).size).toBe(picked.length);
      expect(picked.every((id) => available.includes(id))).toBe(true);
      const order = picked.map((id) => DAILY_TASK_IDS.indexOf(id));
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
  });

  it('全部处境（10 个任务的所有子集）都满足：数量、轻松下限、PvP 上限', () => {
    for (let mask = 0; mask < 1 << ALL_IDS.length; mask += 1) {
      const subset = ALL_IDS.filter((_, bit) => (mask & (1 << bit)) !== 0);
      const picked = pickDailyTasks(subset, `subset:${String(mask)}`);

      const easyInSubset = subset.filter((id) => categoryOf(id) === 'easy').length;
      const pvpInSubset = subset.filter((id) => categoryOf(id) === 'pvp').length;
      const nonPvpInSubset = subset.length - pvpInSubset;
      const easyPicked = picked.filter((id) => categoryOf(id) === 'easy').length;
      const pvpPicked = picked.filter((id) => categoryOf(id) === 'pvp').length;

      // 数量：min(5, 可选数)，但 PvP 最多 1 个，所以还要再夹一次「非 PvP + 1 个 PvP」。
      expect(picked.length).toBe(
        Math.min(DAILY_TASK_COUNT, subset.length, nonPvpInSubset + Math.min(DAILY_TASK_MAX_PVP, pvpInSubset)),
      );
      expect(new Set(picked).size).toBe(picked.length);
      expect(picked.every((id) => subset.includes(id))).toBe(true);
      expect(easyPicked).toBeGreaterThanOrEqual(Math.min(DAILY_TASK_MIN_EASY, easyInSubset));
      expect(pvpPicked).toBeLessThanOrEqual(DAILY_TASK_MAX_PVP);
    }
  });

  it('真实处境下数量恰好是 min(5, 可选数)，且轻松保底生效', () => {
    const situations: DailyTaskSituation[] = [
      LEVEL_ONE_BARE,
      { ...LEVEL_ONE_BARE, arenaLevel: 1, discipleCount: 4 },
      { ...LEVEL_ONE_BARE, sectLevel: 2 },
      LEVEL_THREE_FULL,
    ];
    for (const situation of situations) {
      const available = dailyTaskAvailableIds(situation);
      for (let index = 0; index < 30; index += 1) {
        const picked = pickDailyTasks(available, `real:${String(situation.sectLevel)}:${String(index)}`);
        expect(picked.length).toBe(Math.min(DAILY_TASK_COUNT, available.length));
        const easyAvailable = available.filter((id) => categoryOf(id) === 'easy').length;
        const easyPicked = picked.filter((id) => categoryOf(id) === 'easy').length;
        expect(easyPicked).toBeGreaterThanOrEqual(Math.min(DAILY_TASK_MIN_EASY, easyAvailable));
        expect(picked.filter((id) => categoryOf(id) === 'pvp').length).toBeLessThanOrEqual(DAILY_TASK_MAX_PVP);
      }
    }
  });

  it('只有一个轻松可选时有几个算几个：这一个必定入选', () => {
    const picked = pickDailyTasks(['bossHit', 'spar', 'journey', 'challenge'], 'only-one-easy');
    expect(picked).toContain('journey');
    expect(picked).toHaveLength(4);
  });

  it('等级 1、无演武场、弟子满编：4 个可选全部入选', () => {
    const available = dailyTaskAvailableIds(LEVEL_ONE_BARE);
    expect([...pickDailyTasks(available, 'bare')].sort()).toEqual([...available].sort());
  });
});

describe('单个任务奖励（dailyTaskReward）', () => {
  it('宗门 10 级 = 500000 最小单位（10 × 50 灵石）', () => {
    expect(dailyTaskReward(10)).toBe(500000);
    expect(dailyTaskReward(10)).toBe(10 * 50 * UNITS_PER_DISPLAY);
  });

  it('按领取时的等级线性增长（1 级 = 50 灵石）', () => {
    expect(dailyTaskReward(1)).toBe(50_000);
    expect(dailyTaskReward(3)).toBe(150_000);
  });
});

describe('日课宝箱（rollDailyChest，计划 1.3）', () => {
  it('随机值取最小时：玄铁 3、神木 1、第一颗丹药', () => {
    expect(rollDailyChest(sequence([0, 0, 0]))).toEqual({ xuantie: 3, shenmu: 1, pillId: 'healingPill' });
  });

  it('随机值贴近 1 时：玄铁 5、神木 2、最后一颗丹药', () => {
    expect(rollDailyChest(sequence([0.9999999, 0.9999999, 0.9999999]))).toEqual({
      xuantie: 5,
      shenmu: 2,
      pillId: 'bodyTemperingPill',
    });
  });

  it('注入固定随机值：三种丹药各占约 1/3（丹药那一步的随机值分别落在三段）', () => {
    expect(rollDailyChest(sequence([0, 0, 0.1])).pillId).toBe('healingPill');
    expect(rollDailyChest(sequence([0, 0, 0.34])).pillId).toBe('cultivationPill');
    expect(rollDailyChest(sequence([0, 0, 0.67])).pillId).toBe('bodyTemperingPill');
  });

  it('取用顺序固定：玄铁、神木、丹药各一次', () => {
    expect(rollDailyChest(sequence([0.5, 0.5, 0.5]))).toEqual({ xuantie: 4, shenmu: 2, pillId: 'cultivationPill' });
  });

  it('多次随机后，玄铁 / 神木始终落在区间内，三种丹药都会出现', () => {
    const xuantieSeen = new Set<number>();
    const shenmuSeen = new Set<number>();
    const pillSeen = new Set<string>();
    for (let index = 0; index < 600; index += 1) {
      const roll = rollDailyChest(Math.random);
      xuantieSeen.add(roll.xuantie);
      shenmuSeen.add(roll.shenmu);
      pillSeen.add(roll.pillId);
      expect(roll.xuantie).toBeGreaterThanOrEqual(DAILY_CHEST_XUANTIE_RANGE[0]);
      expect(roll.xuantie).toBeLessThanOrEqual(DAILY_CHEST_XUANTIE_RANGE[1]);
      expect(roll.shenmu).toBeGreaterThanOrEqual(DAILY_CHEST_SHENMU_RANGE[0]);
      expect(roll.shenmu).toBeLessThanOrEqual(DAILY_CHEST_SHENMU_RANGE[1]);
    }
    expect([...xuantieSeen].sort()).toEqual([3, 4, 5]);
    expect([...shenmuSeen].sort()).toEqual([1, 2]);
    expect([...pillSeen].sort()).toEqual([...DAILY_CHEST_PILL_IDS].sort());
  });

  it('丹药候选就是三种回复 / 修为 / 淬体丹', () => {
    expect([...DAILY_CHEST_PILL_IDS]).toEqual(['healingPill', 'cultivationPill', 'bodyTemperingPill']);
  });

  it('宝箱文案与计划一致', () => {
    expect(DAILY_CHEST_DESCRIPTION).toBe('玄铁 3~5、神木 1~2、随机丹药 1 颗');
  });
});
