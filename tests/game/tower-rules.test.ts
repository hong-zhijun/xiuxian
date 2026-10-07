import { describe, expect, it } from 'vitest';

import {
  TOWER_DAILY_FAILS,
  TOWER_MAX_ROUNDS,
  TOWER_TIER_CAP_FLOOR,
  isTowerBossFloor,
  simulateTowerBattle,
  towerAffixOf,
  towerAttackFactor,
  towerClearEquipment,
  towerClearReward,
  towerCritRate,
  towerExtraActionChance,
  towerFailsToday,
  towerFloorTier,
  towerMonsterOf,
  towerStandardAttr,
  towerStandardPower,
  towerSweepReward,
  type TowerFighter,
} from '../../apps/server/src/modules/game/tower';

/** 按顺序循环吐出固定随机数。 */
function sequence(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index % values.length]!;
    index += 1;
    return value;
  };
}

function fighter(overrides: Partial<TowerFighter> = {}): TowerFighter {
  return {
    id: 'd',
    name: '弟子',
    power: 15,
    attack: 50,
    defense: 50,
    speed: 50,
    luck: 50,
    physique: 50,
    critBonusBp: 0,
    damageReductionBp: 0,
    ...overrides,
  };
}

function party(overrides: Partial<TowerFighter> = {}): TowerFighter[] {
  return Array.from({ length: 5 }, (_, index) => fighter({ id: `d${index}`, name: `弟子${index}`, ...overrides }));
}

describe('镇妖塔 · 层数曲线', () => {
  it('每 3 层一个境界小阶段，第 79 层到顶（渡劫后期），之后每层 ×1.02', () => {
    expect(TOWER_TIER_CAP_FLOOR).toBe(79);
    expect(towerFloorTier(1)).toBe(1);
    expect(towerFloorTier(4)).toBe(2);
    expect(towerFloorTier(79)).toBe(27);
    expect(towerFloorTier(80)).toBeCloseTo(27 * 1.02);
  });

  it('标准属性 50 → 75（第 80 层满额），取整', () => {
    expect(towerStandardAttr(1)).toBe(50);
    expect(towerStandardAttr(40)).toBe(62);
    expect(towerStandardAttr(80)).toBe(75);
    expect(towerStandardAttr(200)).toBe(75);
  });

  it('标准战力与 discipleCombatPower 同口径：第 1 层 = 炼气一层、属性 50、无装备 = 15', () => {
    expect(towerStandardPower(1)).toBe(15);
    expect(towerStandardPower(2)).toBeGreaterThan(towerStandardPower(1));
    expect(towerStandardPower(100)).toBeGreaterThan(towerStandardPower(79));
  });

  it('词缀每 5 层轮换，首领每 10 层', () => {
    expect(towerAffixOf(4)).toBeNull();
    expect(towerAffixOf(5)?.id).toBe('ironWall');
    expect(towerAffixOf(10)?.id).toBe('gale');
    expect(towerAffixOf(15)?.id).toBe('poison');
    expect(towerAffixOf(20)?.id).toBe('aegis');
    expect(towerAffixOf(25)?.id).toBe('berserk');
    expect(towerAffixOf(30)?.id).toBe('ironWall');
    expect(isTowerBossFloor(5)).toBe(false);
    expect(isTowerBossFloor(10)).toBe(true);
  });

  it('首领层更厚；疾风妖物身法 ×1.5', () => {
    const nine = towerMonsterOf(9);
    const ten = towerMonsterOf(10);
    expect(ten.isBoss).toBe(true);
    expect(ten.hp / towerStandardPower(10)).toBeGreaterThan(nine.hp / towerStandardPower(9));
    expect(ten.speed).toBe(Math.round(towerStandardAttr(10) * 1.5));
    expect(nine.speed).toBe(towerStandardAttr(9));
  });
});

describe('镇妖塔 · 战斗系数', () => {
  it('暴击率：幸运 100 → 20%，罡气翻倍', () => {
    expect(towerCritRate(100, null)).toBeCloseTo(0.2);
    expect(towerCritRate(50, towerAffixOf(20))).toBeCloseTo(0.2);
  });

  it('追击：身法每高出 1 点 +0.5%，0~30%', () => {
    expect(towerExtraActionChance(50, 60)).toBe(0);
    expect(towerExtraActionChance(70, 50)).toBeCloseTo(0.1);
    expect(towerExtraActionChance(200, 50)).toBe(0.3);
  });

  it('攻击修正：等于标准 = 1，最多算到 2 倍标准', () => {
    expect(towerAttackFactor(50, 50)).toBe(1);
    expect(towerAttackFactor(100, 50)).toBe(1.25);
    expect(towerAttackFactor(500, 50)).toBe(1.25);
  });
});

describe('镇妖塔 · 战斗模拟', () => {
  it('碾压：第 1 回合就打死，先手，记 1 回合', () => {
    const result = simulateTowerBattle({
      floor: 1,
      fighters: party({ power: 10_000 }),
      arenaLevel: 0,
      random: sequence([0.5]),
    });
    expect(result.won).toBe(true);
    expect(result.failReason).toBeNull();
    expect(result.teamFirst).toBe(true);
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]!.monsterHp).toBe(0);
    expect(result.rounds[0]!.monsterDamage).toBe(0);
  });

  it('被碾压：队伍血量打空 → wiped', () => {
    const result = simulateTowerBattle({
      floor: 60,
      fighters: party({ power: 10, attack: 1, defense: 1, speed: 1, luck: 1, physique: 1 }),
      arenaLevel: 0,
      random: sequence([0.5]),
    });
    expect(result.won).toBe(false);
    expect(result.failReason).toBe('wiped');
    expect(result.teamFirst).toBe(false);
    expect(result.rounds.at(-1)!.teamHp).toBe(0);
  });

  it('血厚伤低：10 回合打不死 → timeout', () => {
    const result = simulateTowerBattle({
      floor: 1,
      fighters: party({ power: 1, physique: 100_000 }),
      arenaLevel: 0,
      random: sequence([0.5]),
    });
    expect(result.won).toBe(false);
    expect(result.failReason).toBe('timeout');
    expect(result.rounds).toHaveLength(TOWER_MAX_ROUNDS);
  });

  it('剧毒：每回合开始扣 2.5% 最大血量', () => {
    const result = simulateTowerBattle({
      floor: 15,
      fighters: party({ power: towerStandardPower(15), physique: 100_000 }),
      arenaLevel: 0,
      random: sequence([0.5]),
    });
    expect(result.rounds[0]!.poisonDamage).toBe(Math.floor(result.teamMaxHp * 0.025));
  });

  it('身法高于妖物 + 随机 0 → 每人都追击、都暴击', () => {
    const result = simulateTowerBattle({
      floor: 1,
      fighters: party({ power: 1, speed: 100, physique: 100_000 }),
      arenaLevel: 0,
      random: sequence([0]),
    });
    const hits = result.rounds[0]!.hits;
    expect(hits).toHaveLength(10);
    expect(hits.filter((hit) => hit.extra)).toHaveLength(5);
    expect(hits.every((hit) => hit.crit)).toBe(true);
  });

  it('铁壁：攻击低于标准的弟子伤害减半', () => {
    const run = (attack: number) =>
      simulateTowerBattle({
        floor: 5,
        fighters: party({ power: 100, attack, physique: 100_000 }),
        arenaLevel: 0,
        random: sequence([0.5]),
      }).rounds[0]!.hits[0]!.damage;
    const standard = towerStandardAttr(5);
    expect(run(standard - 1)).toBeLessThan(run(standard) * 0.55);
  });

  it('同样的随机序列 → 同样的结果', () => {
    const make = () =>
      simulateTowerBattle({
        floor: 10,
        fighters: party({ power: towerStandardPower(10) }),
        arenaLevel: 0,
        random: sequence([0.13, 0.71, 0.42, 0.95, 0.08, 0.66]),
      });
    expect(make()).toEqual(make());
  });

  it('标定：标准队伍过普通层大概率胜，战力 ×0.7 基本必败', () => {
    let strong = 0;
    let weak = 0;
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let index = 0; index < 200; index += 1) {
      const attr = towerStandardAttr(41);
      const make = (scale: number) =>
        party({ power: towerStandardPower(41) * scale, attack: attr, defense: attr, speed: attr });
      if (simulateTowerBattle({ floor: 41, fighters: make(1), arenaLevel: 3, random }).won) strong += 1;
      if (simulateTowerBattle({ floor: 41, fighters: make(0.7), arenaLevel: 3, random }).won) weak += 1;
    }
    expect(strong).toBeGreaterThan(160);
    expect(weak).toBeLessThan(10);
  });
});

describe('镇妖塔 · 奖励与次数', () => {
  it('通关奖励：灵石 40 + 8 × 层，药材矿石各一半；首领层 ×3；30 层起首领层给玄铁神木', () => {
    expect(towerClearReward(9)).toEqual({ spiritStone: 112_000, herb: 56_000, ore: 56_000 });
    expect(towerClearReward(10)).toEqual({ spiritStone: 360_000, herb: 180_000, ore: 180_000 });
    expect(towerClearReward(30)).toEqual({
      spiritStone: 840_000,
      herb: 420_000,
      ore: 420_000,
      xuantie: 3_000,
      shenmu: 3_000,
    });
    expect(towerClearReward(31).xuantie).toBeUndefined();
  });

  it('首通装备：第 30 层灵品、60 宝品、90 起每 30 层仙品', () => {
    expect(towerClearEquipment(10)).toBeNull();
    expect(towerClearEquipment(29)).toBeNull();
    expect(towerClearEquipment(30)).toBe('spirit');
    expect(towerClearEquipment(40)).toBeNull();
    expect(towerClearEquipment(60)).toBe('treasure');
    expect(towerClearEquipment(90)).toBe('immortal');
    expect(towerClearEquipment(150)).toBe('immortal');
  });

  it('扫荡：0 层没有；30 层起玄铁神木 1 + (M − 30) / 10', () => {
    expect(towerSweepReward(0)).toEqual({});
    expect(towerSweepReward(20)).toEqual({ spiritStone: 400_000, herb: 210_000, ore: 210_000 });
    expect(towerSweepReward(29).xuantie).toBeUndefined();
    expect(towerSweepReward(30).xuantie).toBe(1_000);
    expect(towerSweepReward(40)).toMatchObject({ xuantie: 2_000, shenmu: 2_000 });
  });

  it('当日失败次数：日期不是今天就是 0', () => {
    expect(TOWER_DAILY_FAILS).toBe(5);
    expect(towerFailsToday(null, '2026-06-01')).toBe(0);
    expect(towerFailsToday({ fail_date_key: '2026-05-31', fail_count: 4 }, '2026-06-01')).toBe(0);
    expect(towerFailsToday({ fail_date_key: '2026-06-01', fail_count: 3 }, '2026-06-01')).toBe(3);
  });
});
