import { describe, expect, it } from 'vitest';

import {
  WORLD_LEVEL_GAP,
  WORLD_RARE_EVERY_HOURS,
  WORLD_RARE_PER_DROP,
  WORLD_REGIONS,
  WORLD_SITES,
  beastDefenders,
  hourCeil,
  hourFloor,
  isWorldLevelGapBlocked,
  parseGarrison,
  resolveWorldBattle,
  settleWorldSite,
  worldSiteCapOf,
  worldSiteFullName,
} from '../../apps/server/src/modules/game/world';

const HOUR = 3_600_000;
/** 整点（UTC 04:00 = UTC+8 12:00）。 */
const T0 = Date.UTC(2026, 5, 1, 4, 0);

describe('山河舆图 · 地图定义', () => {
  it('14 处灵地：id、域、档位与产出与计划一致', () => {
    expect(WORLD_SITES.map((site) => site.id)).toEqual([
      'east-lingdi',
      'east-fudi',
      'east-dongtian',
      'west-lingdi',
      'west-fudi',
      'west-dongtian',
      'south-lingdi',
      'south-fudi',
      'south-dongtian',
      'north-lingdi',
      'north-fudi',
      'north-dongtian',
      'center-xuantie',
      'center-shenmu',
    ]);
    expect(new Set(WORLD_SITES.map((site) => site.id)).size).toBe(14);
    expect(WORLD_SITES.map((site) => [site.name, site.regionId, site.tier, site.outputs, site.rare])).toEqual([
      ['百草谷', 'east', 'lingdi', { herb: 75_000 }, null],
      ['万药林', 'east', 'fudi', { herb: 120_000 }, null],
      ['青帝洞天', 'east', 'dongtian', { herb: 180_000 }, null],
      ['赤砂岭', 'west', 'lingdi', { ore: 75_000 }, null],
      ['熔金峡', 'west', 'fudi', { ore: 120_000 }, null],
      ['赤霄洞天', 'west', 'dongtian', { ore: 180_000 }, null],
      ['雾隐泉', 'south', 'lingdi', { spiritualEnergy: 50_000 }, null],
      ['云梦泽', 'south', 'fudi', { spiritualEnergy: 80_000 }, null],
      ['碧落洞天', 'south', 'dongtian', { spiritualEnergy: 120_000 }, null],
      ['残碑坡', 'north', 'lingdi', { spiritStone: 50_000 }, null],
      ['旧市墟', 'north', 'fudi', { spiritStone: 80_000 }, null],
      ['藏金洞天', 'north', 'dongtian', { spiritStone: 120_000 }, null],
      ['玄铁祖脉', 'center', 'zumai', { spiritualEnergy: 150_000 }, { resourceId: 'xuantie' }],
      ['神木祖脉', 'center', 'zumai', { spiritualEnergy: 150_000 }, { resourceId: 'shenmu' }],
    ]);
  });

  it('五个域：中州没有主产，其余四域的主产与计划一致', () => {
    expect(WORLD_REGIONS.map((region) => [region.id, region.name, region.resourceId])).toEqual([
      ['east', '青木域', 'herb'],
      ['west', '赤铜域', 'ore'],
      ['south', '云泽域', 'spiritualEnergy'],
      ['north', '古墟域', 'spiritStone'],
      ['center', '中州', null],
    ]);
  });

  it('灵地全名：域 · 灵地名；中州的祖脉同样带域名', () => {
    expect(worldSiteFullName('east-lingdi')).toBe('青木域 · 百草谷');
    expect(worldSiteFullName('center-shenmu')).toBe('中州 · 神木祖脉');
    expect(worldSiteFullName('nope')).toBe('nope');
  });

  it('镇守名额：3 级以下不开放；3～5 级 1 处；6～8 级 2 处；9 级及以上 3 处', () => {
    expect([1, 2].map(worldSiteCapOf)).toEqual([0, 0]);
    expect([3, 4, 5].map(worldSiteCapOf)).toEqual([1, 1, 1]);
    expect([6, 7, 8].map(worldSiteCapOf)).toEqual([2, 2, 2]);
    expect([9, 10].map(worldSiteCapOf)).toEqual([3, 3]);
  });

  it('整点取整：hourFloor 向下、hourCeil 向上；已是整点时 ceil 返回自身', () => {
    expect(hourFloor(T0 + 90 * 60_000)).toBe(T0 + HOUR);
    expect(hourCeil(T0 + 90 * 60_000)).toBe(T0 + 2 * HOUR);
    expect(hourCeil(T0)).toBe(T0);
    expect(hourCeil(T0 + 1)).toBe(T0 + HOUR);
    expect(hourFloor(T0 + HOUR - 1)).toBe(T0);
  });
});

describe('山河舆图 · 整点结算（计划 1.5）', () => {
  const plain = { outputs: { herb: 75_000 }, rare: null, rareHours: 0 } as const;

  it('跨整点按完整小时给；不满一小时的部分作废，结算推进到最近整点', () => {
    const result = settleWorldSite({ ...plain, settledAt: T0, now: T0 + 2 * HOUR + 40 * 60_000 });
    expect(result).toEqual({
      hours: 2,
      credits: { herb: 150_000 },
      rareCount: 0,
      nextSettledAt: T0 + 2 * HOUR,
      nextRareHours: 0,
    });
  });

  it('同一个整点之内什么都不给，settled_at 与 rare 进度保持不变', () => {
    const result = settleWorldSite({ ...plain, settledAt: T0, now: T0 + 59 * 60_000 });
    expect(result).toEqual({ hours: 0, credits: {}, rareCount: 0, nextSettledAt: T0, nextRareHours: 0 });
  });

  it('刚好到下一个整点就给 1 小时', () => {
    expect(settleWorldSite({ ...plain, settledAt: T0, now: T0 + HOUR }).credits).toEqual({ herb: 75_000 });
  });

  it('祖脉：本轮 5 小时 + 1 小时 = 满 6 个整点，得 5 个玄铁、余数归零', () => {
    const result = settleWorldSite({
      outputs: { spiritualEnergy: 80_000 },
      rare: { resourceId: 'xuantie' },
      settledAt: T0,
      rareHours: 5,
      now: T0 + HOUR,
    });
    expect(WORLD_RARE_EVERY_HOURS).toBe(6);
    expect(WORLD_RARE_PER_DROP).toBe(5);
    expect(result).toEqual({
      hours: 1,
      credits: { spiritualEnergy: 80_000, xuantie: 5_000 },
      rareCount: 1,
      nextSettledAt: T0 + HOUR,
      nextRareHours: 0,
    });
  });

  it('祖脉：11 小时 = 满 1 次（5 个稀有材料），余数 5 小时留存到下次', () => {
    const result = settleWorldSite({
      outputs: { spiritualEnergy: 80_000 },
      rare: { resourceId: 'shenmu' },
      settledAt: T0,
      rareHours: 0,
      now: T0 + 11 * HOUR,
    });
    expect(result.credits).toEqual({ spiritualEnergy: 880_000, shenmu: 5_000 });
    expect(result.rareCount).toBe(1);
    expect(result.nextRareHours).toBe(5);
  });

  it('祖脉：13 小时（含上次留存）= 满 2 次（10 个稀有材料），余数 1 小时', () => {
    const result = settleWorldSite({
      outputs: { spiritualEnergy: 80_000 },
      rare: { resourceId: 'xuantie' },
      settledAt: T0,
      rareHours: 0,
      now: T0 + 13 * HOUR,
    });
    expect(result.credits.xuantie).toBe(10_000);
    expect(result.rareCount).toBe(2);
    expect(result.nextRareHours).toBe(1);
  });

  it('祖脉没满 6 小时时不给稀有材料，只给灵气', () => {
    const result = settleWorldSite({
      outputs: { spiritualEnergy: 80_000 },
      rare: { resourceId: 'xuantie' },
      settledAt: T0,
      rareHours: 2,
      now: T0 + 3 * HOUR,
    });
    expect(result.credits).toEqual({ spiritualEnergy: 240_000 });
    expect(result.rareCount).toBe(0);
    expect(result.nextRareHours).toBe(5);
  });
});

describe('山河舆图 · 对决（计划 1.4）', () => {
  const team = (power: number) => [
    { name: '甲', power },
    { name: '乙', power },
    { name: '丙', power },
  ];

  it('斗法：守方 +10%，同战力同浮动时进攻方输', () => {
    const result = resolveWorldBattle({
      attackers: team(100),
      defenders: team(100),
      defenderBonus: true,
      random: () => 0.5,
    });
    expect(result.won).toBe(false);
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]).toMatchObject({ attackerPower: 100, defenderPower: 110, winner: 'defender' });
  });

  it('盘踞妖兽不加守方 10%：同样的战力差，妖兽战进攻方赢、斗法输', () => {
    const attackers = team(101);
    const beasts = team(100);
    const beastFight = resolveWorldBattle({ attackers, defenders: beasts, defenderBonus: false, random: () => 0.5 });
    expect(beastFight.won).toBe(true);
    expect(beastFight.rounds[0]).toMatchObject({ attackerPower: 101, defenderPower: 100, winner: 'attacker' });

    const pvpFight = resolveWorldBattle({ attackers, defenders: beasts, defenderBonus: true, random: () => 0.5 });
    expect(pvpFight.won).toBe(false);
    expect(pvpFight.rounds[0]).toMatchObject({ defenderPower: 110, winner: 'defender' });
  });

  it('盘踞妖兽战力 = 进攻方同位次弟子战力 × 0.9，名字为壹 / 贰 / 叁', () => {
    expect(beastDefenders([{ power: 100 }, { power: 200 }, { power: 333 }])).toEqual([
      { name: '盘踞妖兽 · 壹', power: 90 },
      { name: '盘踞妖兽 · 贰', power: 180 },
      { name: '盘踞妖兽 · 叁', power: 299 },
    ]);
  });

  it('守军缺席的回合进攻方直接胜，不取随机数；先拿 2 胜就结束', () => {
    let calls = 0;
    const result = resolveWorldBattle({
      attackers: team(1),
      defenders: [null, { name: '守', power: 1000 }, null],
      defenderBonus: true,
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

    const quick = resolveWorldBattle({
      attackers: team(1000),
      defenders: [null, null, null],
      defenderBonus: true,
      random: () => 0.5,
    });
    expect(quick.won).toBe(true);
    // 前两回合就拿够 2 胜，第 3 回合不再打
    expect(quick.rounds).toHaveLength(2);
  });

  it('等级差：低 3 级及以上（攻方比守方高）不能斗法', () => {
    expect(WORLD_LEVEL_GAP).toBe(3);
    expect(isWorldLevelGapBlocked(9, 6)).toBe(true);
    expect(isWorldLevelGapBlocked(9, 7)).toBe(false);
    expect(isWorldLevelGapBlocked(5, 9)).toBe(false);
  });

  it('坐镇 JSON：脏数据返回空数组', () => {
    expect(parseGarrison('["a","b",3]')).toEqual(['a', 'b']);
    expect(parseGarrison('oops')).toEqual([]);
    expect(parseGarrison(null)).toEqual([]);
  });
});
