import { describe, expect, it } from 'vitest';

import {
  HORSE_NAMES,
  RACE_HORSE_COUNT,
  RACE_ODDS_MIN,
  RACE_RANK_GAP,
  RACE_STEP_COUNT,
  RACE_WEIGHT_MAX,
  RACE_WEIGHT_MIN,
  generateRace,
  generateRaceSteps,
  raceOdds,
  raceRanksOf,
  raceWeightedPick,
} from '../../apps/server/src/modules/game/gambling';

/**
 * 赛马纯规则（gambling.ts 的赛马段）。
 *
 * 全部用注入的固定随机源，不依赖 Math.random —— 这里断言的是「公式」而不是「运气」：
 * 赔率怎么算、名次怎么排、动画序列怎么收敛、整局怎么组起来。
 */

/** 固定序列的随机源：按顺序吐出给定值，用完后一直返回 fallback。 */
function sequence(values: number[], fallback = 0.5): () => number {
  const queue = [...values];
  return () => (queue.length > 0 ? (queue.shift() as number) : fallback);
}

describe('赛马：赔率', () => {
  it('赔率 = (1 / 胜率) × (1 − 抽水 10%)，四舍五入到一位小数', () => {
    expect(raceOdds(0.2)).toBe(4.5); // (1 / 0.2) × 0.9 = 4.5
    expect(raceOdds(0.5)).toBe(1.8); // (1 / 0.5) × 0.9 = 1.8
    expect(raceOdds(1 / 3)).toBe(2.7); // 3 × 0.9 = 2.7
  });

  it('下限 1.2：热门马不会被抽水压到 1x 以下，胜率 0 也不给 Infinity', () => {
    expect(raceOdds(0.95)).toBe(RACE_ODDS_MIN); // 1.0526 × 0.9 = 0.947 → 1.2
    expect(raceOdds(1)).toBe(RACE_ODDS_MIN);
    expect(raceOdds(0)).toBe(RACE_ODDS_MIN);
  });
});

describe('赛马：名次', () => {
  it('冠军固定第 1，其余按权重降序；权重相同按下标升序（结果确定）', () => {
    // 权重最弱的第 1 匹爆冷夺冠，其余按权重降序
    expect(raceRanksOf([1, 5, 5, 5, 5], 0)).toEqual([1, 2, 3, 4, 5]);
    // 权重全等：按下标升序排，冠军仍是第 1
    expect(raceRanksOf([3, 3, 3, 3, 3], 2)).toEqual([2, 3, 1, 4, 5]);
    expect(raceRanksOf([5, 4, 3, 2, 1], 0)).toEqual([1, 2, 3, 4, 5]);
  });

  it('名次刚好是 1~5 的一个排列', () => {
    const ranks = raceRanksOf([2, 5, 1, 4, 3], 3);
    expect([...ranks].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(ranks[3]).toBe(1);
  });
});

describe('赛马：动画序列', () => {
  it('每匹马 8 步、值域 0~1，最后一步严格等于名次对应的目标进度', () => {
    const steps = generateRaceSteps([1, 2, 3, 4, 5], sequence([0.1, 0.9, 0.3]));

    expect(steps).toHaveLength(RACE_HORSE_COUNT);
    for (const series of steps) {
      expect(series).toHaveLength(RACE_STEP_COUNT);
      for (const value of series) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
    // 冠军到 1.0，之后每落后一名少 0.06 —— 这是前端「最后一步对齐名次」的依据。
    expect(steps[0]?.[RACE_STEP_COUNT - 1]).toBe(1);
    expect(steps[1]?.[RACE_STEP_COUNT - 1]).toBeCloseTo(1 - RACE_RANK_GAP, 10);
    expect(steps[4]?.[RACE_STEP_COUNT - 1]).toBeCloseTo(1 - 4 * RACE_RANK_GAP, 10);
  });

  it('抖动只出现在中间步：换随机源，中间步不同、最后一步相同', () => {
    const low = generateRaceSteps([2], sequence([0]))[0]!;
    const high = generateRaceSteps([2], sequence([1]))[0]!;

    expect(low[RACE_STEP_COUNT - 1]).toBe(high[RACE_STEP_COUNT - 1]);
    expect(low).not.toEqual(high);
  });
});

describe('赛马：加权随机与整局生成', () => {
  it('加权随机：roll = 0 落在第一匹、接近 1 落在最后一匹；权重越大越容易被抽中', () => {
    expect(raceWeightedPick([1, 1, 1, 1, 1], 0)).toBe(0);
    expect(raceWeightedPick([1, 1, 1, 1, 1], 0.999)).toBe(4);
    // 权重 [5,1,1,1,1] 总权重 9：target 4.5 落在第一匹的区间里
    expect(raceWeightedPick([5, 1, 1, 1, 1], 0.5)).toBe(0);
    expect(raceWeightedPick([1, 1, 1, 1, 5], 0.5)).toBe(4);
  });

  it('整局：5 匹马、权重在范围内、胜率和为 1、名次是排列、冠军自洽', () => {
    // 权重 [1,5,5,5,5]（总 21），冠军 roll 落在第一匹：target = 0.01 × 21 = 0.21 < 1
    const race = generateRace(sequence([0.05, 0.85, 0.85, 0.85, 0.85, 0.01]));

    expect(race.horses).toHaveLength(RACE_HORSE_COUNT);
    expect(race.horses.map((horse) => horse.name)).toEqual([...HORSE_NAMES]);
    for (const horse of race.horses) {
      expect(horse.weight).toBeGreaterThanOrEqual(RACE_WEIGHT_MIN);
      expect(horse.weight).toBeLessThanOrEqual(RACE_WEIGHT_MAX);
      expect(horse.odds).toBeGreaterThanOrEqual(RACE_ODDS_MIN);
    }
    expect(race.horses.reduce((sum, horse) => sum + horse.winRate, 0)).toBeCloseTo(1, 10);

    expect(race.winnerIndex).toBe(0);
    expect(race.ranks[0]).toBe(1);
    expect([...race.ranks].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);

    // 冷门：权重 1 / 21 ≈ 4.76% → 赔率 21 × 0.9 = 18.9，够到大奖广播阈值（8.0）
    expect(race.horses[0]?.odds).toBe(18.9);

    // 动画序列与名次一一对应
    expect(race.steps).toHaveLength(RACE_HORSE_COUNT);
    expect(race.steps[0]?.[RACE_STEP_COUNT - 1]).toBe(1);
  });
});
