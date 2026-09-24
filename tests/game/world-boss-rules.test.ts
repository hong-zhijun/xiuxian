import { describe, expect, it } from 'vitest';

import {
  WORLD_BOSS_DAILY_ATTACKS,
  WORLD_BOSS_MAX_LEVEL,
  WORLD_BOSS_MIN_HP,
  WORLD_BOSS_POOL_RESOURCES,
  WORLD_BOSSES,
  arenaCombatMultiplier,
  bossDisplayName,
  bossHpCoefficient,
  bossRewardMultiplier,
  computeMaxHp,
  dayIndexUtc8,
  halvePool,
  isFledByDamage,
  isWorldBossAttackable,
  killPoolBaseShare,
  lastHitReward,
  nextBossLevel,
  participationReward,
  rollDamage,
  splitPool,
  theoreticalDailyDamage,
  worldBossDefAt,
  worldBossIndexFor,
  worldBossPhaseOf,
} from '../../apps/server/src/modules/game/worldBoss';

function sequence(values: number[], fallback = 0.5): () => number {
  const queue = [...values];
  return () => (queue.length > 0 ? (queue.shift() as number) : fallback);
}

/** UTC+8 的某个时刻 → UTC 毫秒（业务日按 UTC+8，与 constants.ts 同一基准）。 */
function utc8(y: number, month: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(y, month - 1, day, hour - 8, minute);
}

describe('世界 Boss：阶段判定（UTC+8）', () => {
  it('07:59 before、08:00 open、22:00 frenzy、23:00 closed', () => {
    expect(worldBossPhaseOf(utc8(2026, 9, 23, 7, 59))).toBe('before');
    expect(worldBossPhaseOf(utc8(2026, 9, 23, 8, 0))).toBe('open');
    expect(worldBossPhaseOf(utc8(2026, 9, 23, 21, 59))).toBe('open');
    expect(worldBossPhaseOf(utc8(2026, 9, 23, 22, 0))).toBe('frenzy');
    expect(worldBossPhaseOf(utc8(2026, 9, 23, 23, 0))).toBe('closed');
    expect(worldBossPhaseOf(utc8(2026, 9, 23, 23, 30))).toBe('closed');
    // 次日 0:30 已经是新的一天、尚未到 08:00，所以是 before
    expect(worldBossPhaseOf(utc8(2026, 9, 24, 0, 30))).toBe('before');
  });

  it('只有 open / frenzy 可以出手', () => {
    expect(isWorldBossAttackable('open')).toBe(true);
    expect(isWorldBossAttackable('frenzy')).toBe(true);
    expect(isWorldBossAttackable('before')).toBe(false);
    expect(isWorldBossAttackable('closed')).toBe(false);
  });
});

describe('世界 Boss：等级与轮换', () => {
  it('前一天被击杀则 +1、否则 −1，夹取 1~5', () => {
    expect(nextBossLevel(null, true)).toBe(1);
    expect(nextBossLevel(null, false)).toBe(1);
    expect(nextBossLevel(3, true)).toBe(4);
    expect(nextBossLevel(3, false)).toBe(2);
    expect(nextBossLevel(5, true)).toBe(5);
    expect(nextBossLevel(1, false)).toBe(1);
    expect(nextBossLevel(0, false)).toBe(1);
  });

  it('血量系数与奖励加成按等级表', () => {
    expect([1, 2, 3, 4, 5].map(bossHpCoefficient)).toEqual([0.8, 0.9, 1, 1.1, 1.2]);
    expect([1, 2, 3, 4, 5].map(bossRewardMultiplier)).toEqual([1, 1.1, 1.2, 1.3, 1.4]);
    // 越界等级夹取到 1~5
    expect(bossHpCoefficient(0)).toBe(0.8);
    expect(bossHpCoefficient(9)).toBe(1.2);
    expect(bossRewardMultiplier(9)).toBe(1.4);
  });

  it('五只 Boss 按 dayIndex % 5 轮换，同一天内不变', () => {
    expect(WORLD_BOSSES).toHaveLength(5);
    const noon = utc8(2026, 9, 23, 12);
    expect(worldBossIndexFor(noon)).toBe(dayIndexUtc8(noon) % 5);
    expect(worldBossIndexFor(noon)).toBe(worldBossIndexFor(noon + 11 * 3_600_000));
    expect(worldBossIndexFor(noon + 24 * 3_600_000)).toBe((worldBossIndexFor(noon) + 1) % 5);
    expect(worldBossDefAt(0).name).toBe('黑风妖王');
    expect(worldBossDefAt(5).index).toBe(0);
  });

  it('显示名带中文阶数', () => {
    expect(bossDisplayName(0, 1)).toBe('黑风妖王 · 一阶');
    expect(bossDisplayName(0, 2)).toBe('黑风妖王 · 二阶');
    expect(bossDisplayName(4, 5)).toBe('裂山石魔 · 五阶');
  });
});

describe('世界 Boss：血量', () => {
  it('∑ 理论日伤害 × 血量系数，下限 10000', () => {
    expect(computeMaxHp([100_000, 50_000], 5)).toBe(180_000);
    expect(computeMaxHp([100_000], 3)).toBe(100_000);
    // 系数让结果低于下限时取 10000
    expect(computeMaxHp([10_000], 1)).toBe(WORLD_BOSS_MIN_HP);
    expect(computeMaxHp([], 5)).toBe(WORLD_BOSS_MIN_HP);
  });

  it('单宗门理论日伤害 = 前 3 战力 × 演武场加成 × 3 次 × DAMAGE_SCALE', () => {
    expect(arenaCombatMultiplier(0)).toBe(1);
    expect(arenaCombatMultiplier(2)).toBeCloseTo(1.2, 10);
    expect(theoreticalDailyDamage({ topPartyPower: 100, arenaLevel: 0 })).toBe(
      100 * 1 * WORLD_BOSS_DAILY_ATTACKS * 100,
    );
    expect(theoreticalDailyDamage({ topPartyPower: 100, arenaLevel: 2 })).toBe(36_000);
  });
});

describe('世界 Boss：伤害', () => {
  const party = { partyPower: 100, arenaLevel: 0, avgLuck: 0, frenzy: false };

  it('浮动下界 0.8、上界 1.2', () => {
    expect(rollDamage({ ...party, random: sequence([0, 1]) })).toEqual({
      damage: 8_000,
      crit: false,
    });
    expect(rollDamage({ ...party, random: sequence([1, 1]) })).toEqual({
      damage: 12_000,
      crit: false,
    });
  });

  it('暴击率 = luck 平均值 / 100 × 20%，暴击倍率 1.5', () => {
    // luck 平均 100 → 20%：roll 0.1 命中暴击
    const crit = rollDamage({ ...party, avgLuck: 100, random: sequence([0.5, 0.1]) });
    expect(crit).toEqual({ damage: 15_000, crit: true });
    // 同样的浮动，roll 0.5 不暴击
    const noCrit = rollDamage({ ...party, avgLuck: 100, random: sequence([0.5, 0.5]) });
    expect(noCrit).toEqual({ damage: 10_000, crit: false });
    // luck 平均 0 → 暴击率 0，roll 0 也不暴击
    expect(rollDamage({ ...party, random: sequence([0.5, 0]) }).crit).toBe(false);
  });

  it('力竭倍率 1.5', () => {
    expect(rollDamage({ ...party, frenzy: true, random: sequence([0.5, 0.5]) })).toEqual({
      damage: 15_000,
      crit: false,
    });
  });

  it('演武场每级 +10% 战力', () => {
    expect(rollDamage({ ...party, arenaLevel: 2, random: sequence([0.5, 0.5]) }).damage).toBe(
      12_000,
    );
  });
});

describe('世界 Boss：奖励', () => {
  it('参与奖 / 最后一击奖按该宗门自己的产出算，带保底与等级加成', () => {
    // 产出去到 0 时吃保底：10 × 等级 × 1000
    expect(participationReward(0, 3, 1)).toBe(30_000);
    expect(participationReward(0, 3, 3)).toBe(36_000);
    expect(participationReward(0, 1, 1)).toBe(10_000);
    // 产出够高时用产出：0.25 × 400000 = 100000 > 保底 30000
    expect(participationReward(400_000, 3, 1)).toBe(100_000);
    expect(participationReward(400_000, 3, 2)).toBe(110_000);
    // 最后一击是 0.5 倍产出
    expect(lastHitReward(0, 1, 1)).toBe(10_000);
    expect(lastHitReward(400_000, 1, 1)).toBe(200_000);
  });

  it('击杀奖池基础份按资源分别算（灵石/药材/矿石），缺项只吃保底', () => {
    const share = killPoolBaseShare({ spiritStone: 100_000, ore: 400_000 }, 1, 1);
    expect(Object.keys(share).sort()).toEqual([...WORLD_BOSS_POOL_RESOURCES].sort());
    expect(share.spiritStone).toBe(150_000);
    expect(share.herb).toBe(10_000);
    expect(share.ore).toBe(600_000);
    // 等级加成同样作用在奖池份上
    expect(killPoolBaseShare({ ore: 400_000 }, 1, 5).ore).toBe(840_000);
  });

  it('splitPool 按伤害占比向下取整，总和不超过奖池', () => {
    expect(splitPool(1_000, [100, 300])).toEqual([250, 750]);
    expect(splitPool(100, [1, 1, 1])).toEqual([33, 33, 33]);
    const pool = 999;
    const damages = [7, 11, 13, 17, 19];
    const shares = splitPool(pool, damages);
    expect(shares.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(pool);
    // 总量为 0 时人人 0，不出现 NaN
    expect(splitPool(pool, [0, 0])).toEqual([0, 0]);
    expect(splitPool(0, damages)).toEqual([0, 0, 0, 0, 0]);
  });

  it('击退：奖池减半；≥70% 才算击退', () => {
    expect(halvePool(1_001)).toBe(500);
    expect(isFledByDamage(1_000, 300)).toBe(true);
    expect(isFledByDamage(1_000, 301)).toBe(false);
    expect(isFledByDamage(0, 0)).toBe(false);
    expect(WORLD_BOSS_MAX_LEVEL).toBe(5);
  });
});
