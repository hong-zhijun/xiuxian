import {
  ATTRIBUTE_INSIGHT_REWARDS,
  ATTRIBUTE_LABELS,
  ATTRIBUTE_MAX,
  ATTRIBUTE_STAKES,
  BETTABLE_ATTRIBUTES,
  BETTABLE_RESOURCES,
  DAO_INSIGHT_CAP,
  DEBATE_DAILY_LIMIT,
  DEBATE_TIER_ANCHOR,
  DEBATE_TIER_ANCHOR_RANGE,
  DEBATE_TIER_KEYS,
  DEBATE_TIER_PROBABILITIES,
  DEGRADED_WIN_RATES,
  FREE_BET_MIN,
  FREE_BET_WIN_MULTIPLIER,
  GAMBLING_LOCKED_REASON,
  GAMBLING_UNLOCK_SECT_LEVEL,
  LUCK_REVEAL_THRESHOLD_1,
  LUCK_REVEAL_THRESHOLD_2,
  OPPONENT_WEIGHT_SPREAD,
  PRESET_INSIGHT_REWARDS,
  PRESET_RESOURCE_REWARDS,
  PRESET_STAKES,
  REVEAL_OPPONENT_FACTOR,
  debateDayStateOf,
  debateTierProbability,
  freeBetReward,
  freeBetStake,
  gamblingUnlockBlockedReason,
  generateOpponentAttrs,
  generateRevealHints,
  isBettableResource,
  isGamblingUnlocked,
  revealCount,
} from '../../apps/server/src/modules/game/gambling';
import { describe, expect, it } from 'vitest';

/**
 * 赌坊纯函数（apps/server/src/modules/game/gambling.ts）：
 * 解锁门槛、赌注/奖励表、每日次数归一、幸运侦查文案（docs/赌坊开发计划.md 第 3、4、6 节）。
 * 不依赖 workerd/D1，跑在根级 node 测试里（vitest.config.ts）。
 */

const ATTRIBUTE_SAMPLE: Record<(typeof BETTABLE_ATTRIBUTES)[number], number> = {
  attack: 60,
  defense: 50,
  speed: 40,
  aptitude: 70,
  luck: 90,
  physique: 30,
};

describe('赌坊解锁与常量', () => {
  it('解锁只看宗门 2 级，不依赖建筑（计划 2.1）', () => {
    expect(GAMBLING_UNLOCK_SECT_LEVEL).toBe(2);
    expect(isGamblingUnlocked(1)).toBe(false);
    expect(isGamblingUnlocked(2)).toBe(true);
    expect(isGamblingUnlocked(9)).toBe(true);
    expect(gamblingUnlockBlockedReason(1)).toBe(GAMBLING_LOCKED_REASON);
    expect(gamblingUnlockBlockedReason(2)).toBeNull();
  });

  it('每日 10 次、悟道值累计上限 50、属性上限 100（计划 2.2 / 2.3）', () => {
    expect(DEBATE_DAILY_LIMIT).toBe(10);
    expect(DAO_INSIGHT_CAP).toBe(50);
    expect(ATTRIBUTE_MAX).toBe(100);
  });

  it('白名单：三种可赌资源 + 六项可赌属性', () => {
    expect([...BETTABLE_RESOURCES]).toEqual(['spiritStone', 'herb', 'ore']);
    expect([...BETTABLE_ATTRIBUTES]).toEqual([
      'attack',
      'defense',
      'speed',
      'aptitude',
      'luck',
      'physique',
    ]);
    expect(isBettableResource('spiritStone')).toBe(true);
    expect(isBettableResource('spiritualEnergy')).toBe(false);
    expect(isBettableResource('')).toBe(false);
    // 侦查文案要用到的展示名必须六项齐全。
    for (const attribute of BETTABLE_ATTRIBUTES) {
      expect(ATTRIBUTE_LABELS[attribute]).toBeTruthy();
    }
  });
});

describe('赌注与奖励表（计划第 3 节）', () => {
  it('模式 A：预设灵石赌注 / 灵石奖励 / 悟道值奖励', () => {
    expect(PRESET_STAKES).toEqual({ 1: 100000, 2: 200000, 3: 300000 });
    expect(PRESET_RESOURCE_REWARDS).toEqual({ 1: 180000, 2: 360000, 3: 540000 });
    expect(PRESET_INSIGHT_REWARDS).toEqual({ 1: 1, 2: 2, 3: 3 });
  });

  it('模式 B：最小赌注 10000、赢 1.8 倍（整数截断）', () => {
    expect(FREE_BET_MIN).toBe(10000);
    expect(FREE_BET_WIN_MULTIPLIER).toBe(1.8);
    expect(freeBetStake(10000, 1)).toBe(10000);
    expect(freeBetStake(10000, 3)).toBe(30000);
    expect(freeBetReward(10000, 1)).toBe(18000);
    expect(freeBetReward(10000, 3)).toBe(54000);
    // 1.8 倍会产生小数，一律 floor 到整数最小单位（计划 14.1）。
    expect(freeBetReward(10001, 1)).toBe(18001); // 18001.8 -> 18001
    expect(Number.isInteger(freeBetReward(12345, 2))).toBe(true);
  });

  it('模式 C：属性赌注点数与悟道值奖励', () => {
    expect(ATTRIBUTE_STAKES).toEqual({ 1: 1, 2: 2, 3: 3 });
    expect(ATTRIBUTE_INSIGHT_REWARDS).toEqual({ 1: 2, 2: 4, 3: 6 });
  });

  it('降级胜率：1x/2x/3x = 50% / 42% / 34%（基点，与档位表对齐）', () => {
    expect(DEGRADED_WIN_RATES).toEqual({ 1: 5000, 2: 4200, 3: 3400 });
    expect(DEGRADED_WIN_RATES[1] / 10_000).toBeCloseTo(0.5);
    expect(DEGRADED_WIN_RATES[2] / 10_000).toBeCloseTo(0.42);
    expect(DEGRADED_WIN_RATES[3] / 10_000).toBeCloseTo(0.34);
  });
});

describe('幸运侦查（计划 4.5）', () => {
  it('阈值 70 / 85 决定提示数量', () => {
    expect(LUCK_REVEAL_THRESHOLD_1).toBe(70);
    expect(LUCK_REVEAL_THRESHOLD_2).toBe(85);
    expect(revealCount(0)).toBe(0);
    expect(revealCount(69)).toBe(0);
    expect(revealCount(70)).toBe(1);
    expect(revealCount(84)).toBe(1);
    expect(revealCount(85)).toBe(2);
    expect(revealCount(100)).toBe(2);
  });

  it('幸运不足时没有提示；够时条数与幸运一致，且都是对手属性文案', () => {
    expect(generateRevealHints(ATTRIBUTE_SAMPLE, 1, 60)).toEqual([]);
    const one = generateRevealHints(ATTRIBUTE_SAMPLE, 1, 70);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatch(/^对手(攻击|防御|身法|资质|幸运|体魄)/);
    expect(generateRevealHints(ATTRIBUTE_SAMPLE, 1, 90)).toHaveLength(2);
  });

  it('是确定性纯函数：同输入同输出（不调用 jev、不用随机数）', () => {
    const first = generateRevealHints(ATTRIBUTE_SAMPLE, 2, 90);
    const second = generateRevealHints(ATTRIBUTE_SAMPLE, 2, 90);
    expect(first).toEqual(second);
    // 倍率改变对手基准与取样偏移，所以文案会变（但仍是确定性结果）。
    expect(generateRevealHints(ATTRIBUTE_SAMPLE, 3, 90)).not.toEqual(
      generateRevealHints(ATTRIBUTE_SAMPLE, 1, 90),
    );
  });
});

describe('论道每日次数归一（计划 2.2：UTC+8 自然日重置）', () => {
  /** 2026-01-05 09:00 UTC+8（= 01:00 UTC）。 */
  const NOON_UTC8 = Date.UTC(2026, 0, 5, 1, 0, 0);

  it('日期键是今天 → 用 debate_count，剩余 = 10 - 已用', () => {
    const state = debateDayStateOf(
      { debate_date_key: '2026-01-05', debate_count: 3 },
      NOON_UTC8,
    );
    expect(state.dateKey).toBe('2026-01-05');
    expect(state.keyMatches).toBe(true);
    expect(state.usedToday).toBe(3);
    expect(state.remaining).toBe(7);
  });

  it('日期键不是今天 → 视为 0（跨天重置）', () => {
    const state = debateDayStateOf(
      { debate_date_key: '2026-01-04', debate_count: 10 },
      NOON_UTC8,
    );
    expect(state.keyMatches).toBe(false);
    expect(state.usedToday).toBe(0);
    expect(state.remaining).toBe(DEBATE_DAILY_LIMIT);
  });

  it('空日期键（迁移前的宗门）与异常计数都被 clamp 到合法区间', () => {
    const legacy = debateDayStateOf({ debate_date_key: '', debate_count: 0 }, NOON_UTC8);
    expect(legacy.usedToday).toBe(0);
    expect(legacy.remaining).toBe(DEBATE_DAILY_LIMIT);

    const over = debateDayStateOf(
      { debate_date_key: '2026-01-05', debate_count: 99 },
      NOON_UTC8,
    );
    expect(over.usedToday).toBe(DEBATE_DAILY_LIMIT);
    expect(over.remaining).toBe(0);

    const negative = debateDayStateOf(
      { debate_date_key: '2026-01-05', debate_count: -5 },
      NOON_UTC8,
    );
    expect(negative.usedToday).toBe(0);
    expect(negative.remaining).toBe(DEBATE_DAILY_LIMIT);
  });
});

describe('对手属性生成（归一化权重）', () => {
  it('对手六项之和 ≈ 弟子六项之和 × 倍率系数', () => {
    const discipleTotal = Object.values(ATTRIBUTE_SAMPLE).reduce((a, b) => a + b, 0);
    for (const mult of [1, 2, 3] as const) {
      const opponent = generateOpponentAttrs(ATTRIBUTE_SAMPLE, mult);
      const opponentTotal = Object.values(opponent).reduce((a, b) => a + b, 0);
      const expected = discipleTotal * REVEAL_OPPONENT_FACTOR[mult];
      expect(opponentTotal).toBeGreaterThan(expected * 0.9);
      expect(opponentTotal).toBeLessThan(expected * 1.1);
    }
  });

  it('各项有长短板（不全等于均匀缩放）', () => {
    const opponent = generateOpponentAttrs(ATTRIBUTE_SAMPLE, 2);
    const ratios = BETTABLE_ATTRIBUTES.map(
      (attr) => opponent[attr] / (ATTRIBUTE_SAMPLE[attr] || 1),
    );
    const allSame = ratios.every((r) => Math.abs(r - ratios[0]!) < 0.01);
    expect(allSame).toBe(false);
  });

  it('每项保底 1，不封顶', () => {
    const lowAttrs = { attack: 0, defense: 0, speed: 1, aptitude: 0, luck: 0, physique: 0 } as Record<
      (typeof BETTABLE_ATTRIBUTES)[number],
      number
    >;
    const opponent = generateOpponentAttrs(lowAttrs, 1);
    for (const attr of BETTABLE_ATTRIBUTES) {
      expect(opponent[attr]).toBeGreaterThanOrEqual(1);
    }
  });

  it('spread 常量 = 0.40', () => {
    expect(OPPONENT_WEIGHT_SPREAD).toBe(0.40);
  });
});

describe('五档胜率（choice → 概率映射）', () => {
  it('档位表五个 key 与概率值', () => {
    expect(DEBATE_TIER_KEYS).toHaveLength(5);
    expect(DEBATE_TIER_PROBABILITIES).toEqual({
      disciple_clear: 0.65,
      disciple_slight: 0.55,
      even: 0.50,
      opponent_slight: 0.42,
      opponent_clear: 0.34,
    });
  });

  it('倍率锚与 ±0.06 范围', () => {
    expect(DEBATE_TIER_ANCHOR).toEqual({ 1: 0.50, 2: 0.42, 3: 0.34 });
    expect(DEBATE_TIER_ANCHOR_RANGE).toBe(0.06);
  });

  it('纯弟子优势 → 加权概率接近 0.65，但被锚 clamp', () => {
    const probs = { disciple_clear: 1, disciple_slight: 0, even: 0, opponent_slight: 0, opponent_clear: 0 };
    expect(debateTierProbability(probs, 1)).toBeCloseTo(0.56);
    expect(debateTierProbability(probs, 2)).toBeCloseTo(0.48);
    expect(debateTierProbability(probs, 3)).toBeCloseTo(0.40);
  });

  it('纯对手优势 → 加权概率接近 0.34，被锚 clamp', () => {
    const probs = { disciple_clear: 0, disciple_slight: 0, even: 0, opponent_slight: 0, opponent_clear: 1 };
    expect(debateTierProbability(probs, 1)).toBeCloseTo(0.44);
    expect(debateTierProbability(probs, 2)).toBeCloseTo(0.36);
    expect(debateTierProbability(probs, 3)).toBeCloseTo(0.34);
  });

  it('even 独占 → 加权概率 = 0.50，锚 clamp 后按倍率分化', () => {
    const probs = { disciple_clear: 0, disciple_slight: 0, even: 1, opponent_slight: 0, opponent_clear: 0 };
    expect(debateTierProbability(probs, 1)).toBeCloseTo(0.50);
    expect(debateTierProbability(probs, 2)).toBeCloseTo(0.48);
    expect(debateTierProbability(probs, 3)).toBeCloseTo(0.40);
  });

  it('undefined / 空对象 / 全零 → null（触发降级）', () => {
    expect(debateTierProbability(undefined, 1)).toBeNull();
    expect(debateTierProbability({}, 1)).toBeNull();
    expect(debateTierProbability({ disciple_clear: 0, even: 0 }, 1)).toBeNull();
  });

  it('降级胜率与锚表对齐', () => {
    for (const mult of [1, 2, 3] as const) {
      expect(DEGRADED_WIN_RATES[mult] / 10_000).toBeCloseTo(DEBATE_TIER_ANCHOR[mult]);
    }
  });
});
