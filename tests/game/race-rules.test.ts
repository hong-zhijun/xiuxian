import { describe, expect, it } from 'vitest';

import {
  BEAST_NAMES,
  RACE_BEAST_COUNT,
  RACE_RANK_GAP,
  RACE_STEP_COUNT,
  RACE_VIRTUAL_BASE,
  RACE_WEIGHT_MAX,
  RACE_WEIGHT_MIN,
  beastWeightsFromRoundKey,
  generateRaceSteps,
  parimutuelOdds,
  raceDisplayOdds,
  raceRanksOf,
  raceWeightedPick,
} from '../../apps/server/src/modules/game/gambling';

function sequence(values: number[], fallback = 0.5): () => number {
  const queue = [...values];
  return () => (queue.length > 0 ? (queue.shift() as number) : fallback);
}

describe('灵兽竞逐：互赌倍率', () => {
  it('净池 / 灵兽池 = (总池 × 0.9) / 灵兽池，四舍五入一位小数', () => {
    expect(parimutuelOdds(100000, 50000)).toBe(1.8);
    expect(parimutuelOdds(100000, 20000)).toBe(4.5);
    expect(parimutuelOdds(100000, 100000)).toBe(0.9);
  });

  it('无人投注返回 0', () => {
    expect(parimutuelOdds(100000, 0)).toBe(0);
    expect(parimutuelOdds(0, 0)).toBe(0);
  });
});

describe('灵兽竞逐：展示赔率（虚拟底池）', () => {
  it('无人投注时赔率 = 总权重 × 0.9 / 该灵兽权重', () => {
    // weights [3, 1, 5, 2, 4], totalW = 15
    // beast 0 (w=3): 15*0.9/3 = 4.5
    const odds0 = raceDisplayOdds(0, 0, 3, 15);
    expect(odds0).toBe(4.5);
    // beast 1 (w=1): 15*0.9/1 = 13.5
    const odds1 = raceDisplayOdds(0, 0, 1, 15);
    expect(odds1).toBe(13.5);
    // beast 2 (w=5): 15*0.9/5 = 2.7
    const odds2 = raceDisplayOdds(0, 0, 5, 15);
    expect(odds2).toBe(2.7);
  });

  it('有人投注后赔率在初始基础上变化', () => {
    const totalW = 15;
    const w = 3; // beast 0
    const initialOdds = raceDisplayOdds(0, 0, w, totalW);
    // 往 beast 0 下注 100K 后赔率应降低
    const afterBet = raceDisplayOdds(100_000, 100_000, w, totalW);
    expect(afterBet).toBeLessThan(initialOdds);
    // 往其他灵兽下注 100K 后 beast 0 赔率应升高
    const afterOtherBet = raceDisplayOdds(100_000, 0, w, totalW);
    expect(afterOtherBet).toBeGreaterThan(initialOdds);
  });

  it('大量真实投注后虚拟底池影响可忽略', () => {
    const totalW = 15;
    const w = 3;
    const bigPool = 100_000_000;
    const beastPool = 20_000_000;
    const display = raceDisplayOdds(bigPool, beastPool, w, totalW);
    const pure = parimutuelOdds(bigPool, beastPool);
    expect(Math.abs(display - pure)).toBeLessThan(0.2);
  });
});

describe('灵兽竞逐：名次', () => {
  it('冠军固定第 1，其余按权重降序；权重相同按下标升序', () => {
    expect(raceRanksOf([1, 5, 5, 5, 5], 0)).toEqual([1, 2, 3, 4, 5]);
    expect(raceRanksOf([3, 3, 3, 3, 3], 2)).toEqual([2, 3, 1, 4, 5]);
    expect(raceRanksOf([5, 4, 3, 2, 1], 0)).toEqual([1, 2, 3, 4, 5]);
  });

  it('名次刚好是 1~5 的一个排列', () => {
    const ranks = raceRanksOf([2, 5, 1, 4, 3], 3);
    expect([...ranks].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(ranks[3]).toBe(1);
  });
});

describe('灵兽竞逐：动画序列', () => {
  it('每只灵兽 8 步、值域 0~1，最后一步严格等于名次对应的目标进度', () => {
    const steps = generateRaceSteps([1, 2, 3, 4, 5], sequence([0.1, 0.9, 0.3]));

    expect(steps).toHaveLength(RACE_BEAST_COUNT);
    for (const series of steps) {
      expect(series).toHaveLength(RACE_STEP_COUNT);
      for (const value of series) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
    expect(steps[0]?.[RACE_STEP_COUNT - 1]).toBe(1);
    expect(steps[1]?.[RACE_STEP_COUNT - 1]).toBeCloseTo(1 - RACE_RANK_GAP, 10);
    expect(steps[4]?.[RACE_STEP_COUNT - 1]).toBeCloseTo(1 - 4 * RACE_RANK_GAP, 10);
  });
});

describe('灵兽竞逐：加权随机与权重生成', () => {
  it('加权随机：roll = 0 落在第一只、接近 1 落在最后一只', () => {
    expect(raceWeightedPick([1, 1, 1, 1, 1], 0)).toBe(0);
    expect(raceWeightedPick([1, 1, 1, 1, 1], 0.999)).toBe(4);
    expect(raceWeightedPick([5, 1, 1, 1, 1], 0.5)).toBe(0);
    expect(raceWeightedPick([1, 1, 1, 1, 5], 0.5)).toBe(4);
  });

  it('beastWeightsFromRoundKey 生成 5 个 1~5 的整数权重', () => {
    const weights = beastWeightsFromRoundKey('2026-09-23T08:00');
    expect(weights).toHaveLength(RACE_BEAST_COUNT);
    for (const w of weights) {
      expect(w).toBeGreaterThanOrEqual(RACE_WEIGHT_MIN);
      expect(w).toBeLessThanOrEqual(RACE_WEIGHT_MAX);
    }
  });

  it('同一 roundKey 生成相同权重（确定性）', () => {
    const a = beastWeightsFromRoundKey('2026-09-23T08:00');
    const b = beastWeightsFromRoundKey('2026-09-23T08:00');
    expect(a).toEqual(b);
  });

  it('不同 roundKey 生成不同权重', () => {
    const a = beastWeightsFromRoundKey('2026-09-23T08:00');
    const b = beastWeightsFromRoundKey('2026-09-23T08:10');
    expect(a).not.toEqual(b);
  });

  it('灵兽名有 5 个', () => {
    expect(BEAST_NAMES).toHaveLength(RACE_BEAST_COUNT);
  });
});
