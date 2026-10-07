import { describe, expect, it } from 'vitest';

import {
  VEINS,
  VEIN_TIERS,
  isVeinLevelGapBlocked,
  parseGarrison,
  resolveVeinBattle,
  veinExhaustAt,
  veinProduction,
  veinTierOf,
} from '../../apps/server/src/modules/game/veins';

const HOUR = 3_600_000;

describe('灵脉 · 定义', () => {
  it('10 条：6 小 / 3 大 / 1 灵眼；档位产出与门槛', () => {
    expect(VEINS).toHaveLength(10);
    expect(VEINS.filter((vein) => vein.tier === 'small')).toHaveLength(6);
    expect(VEINS.filter((vein) => vein.tier === 'large')).toHaveLength(3);
    expect(VEINS.filter((vein) => vein.tier === 'eye')).toHaveLength(1);
    expect(new Set(VEINS.map((vein) => vein.id)).size).toBe(10);
    expect(VEIN_TIERS.map((tier) => [tier.id, tier.ratePerHour, tier.minSectLevel])).toEqual([
      ['small', 25_000, 3],
      ['large', 40_000, 6],
      ['eye', 60_000, 9],
    ]);
  });

  it('产出按时长折算、向下取整；时间倒退为 0', () => {
    expect(veinProduction(25_000, 0, HOUR)).toBe(25_000);
    expect(veinProduction(25_000, 0, 10 * 60_000)).toBe(4_166);
    expect(veinProduction(60_000, 1000, 0)).toBe(0);
  });

  it('枯竭：大灵脉 48 小时、灵眼 24 小时、小灵脉不限', () => {
    expect(veinExhaustAt('large', 100)).toBe(100 + 48 * HOUR);
    expect(veinExhaustAt('eye', 100)).toBe(100 + 24 * HOUR);
    expect(veinExhaustAt('small', 100)).toBeNull();
    expect(veinTierOf('nope').id).toBe('small');
  });

  it('等级差：低 3 级及以上不能抢', () => {
    expect(isVeinLevelGapBlocked(9, 6)).toBe(true);
    expect(isVeinLevelGapBlocked(9, 7)).toBe(false);
    expect(isVeinLevelGapBlocked(5, 9)).toBe(false);
  });

  it('守军 JSON：脏数据返回空数组', () => {
    expect(parseGarrison('["a","b",3]')).toEqual(['a', 'b']);
    expect(parseGarrison('oops')).toEqual([]);
    expect(parseGarrison(null)).toEqual([]);
  });
});

describe('灵脉 · 对决', () => {
  const team = (power: number) => [
    { name: '甲', power },
    { name: '乙', power },
    { name: '丙', power },
  ];

  it('同战力、同浮动：守方 +10% 稳赢', () => {
    const result = resolveVeinBattle({ attackers: team(100), defenders: team(100), random: () => 0.5 });
    expect(result.won).toBe(false);
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]).toMatchObject({ attackerPower: 100, defenderPower: 110, winner: 'defender' });
  });

  it('进攻方高出 10% 以上才赢；先拿 2 胜就结束', () => {
    const result = resolveVeinBattle({ attackers: team(112), defenders: team(100), random: () => 0.5 });
    expect(result.won).toBe(true);
    expect(result.rounds).toHaveLength(2);
  });

  it('守军缺席的回合进攻方直接胜，不取随机数', () => {
    let calls = 0;
    const result = resolveVeinBattle({
      attackers: team(1),
      defenders: [null, { name: '守', power: 1000 }, null],
      random: () => {
        calls += 1;
        return 0.5;
      },
    });
    expect(result.won).toBe(true);
    expect(result.rounds.map((round) => round.winner)).toEqual(['attacker', 'defender', 'attacker']);
    expect(result.rounds[0]?.defenderName).toBeNull();
    // 第 1、3 回合只取进攻方浮动；第 2 回合两方各一次
    expect(calls).toBe(4);
  });
});
