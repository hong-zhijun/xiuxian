import {
  ATTRIBUTE_INSIGHT_REWARDS,
  ATTRIBUTE_LABELS,
  ATTRIBUTE_MAX,
  ATTRIBUTE_STAKES,
  BETTABLE_ATTRIBUTES,
  BETTABLE_RESOURCES,
  DAO_INSIGHT_CAP,
  DEBATE_DAILY_LIMIT,
  DEGRADED_WIN_RATES,
  FREE_BET_MIN,
  FREE_BET_WIN_MULTIPLIER,
  GAMBLING_LOCKED_REASON,
  GAMBLING_UNLOCK_SECT_LEVEL,
  LUCK_REVEAL_THRESHOLD_1,
  LUCK_REVEAL_THRESHOLD_2,
  PRESET_INSIGHT_REWARDS,
  PRESET_RESOURCE_REWARDS,
  PRESET_STAKES,
  debateDayStateOf,
  freeBetReward,
  freeBetStake,
  gamblingUnlockBlockedReason,
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

  it('降级胜率：1x/2x/3x = 50% / 40% / 30%（基点）', () => {
    expect(DEGRADED_WIN_RATES).toEqual({ 1: 5000, 2: 4000, 3: 3000 });
    expect(DEGRADED_WIN_RATES[1] / 10_000).toBeCloseTo(0.5);
    expect(DEGRADED_WIN_RATES[3] / 10_000).toBeCloseTo(0.3);
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
