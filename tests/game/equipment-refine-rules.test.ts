import { describe, expect, it } from 'vitest';

import {
  gearPowerBonusBpOf,
  nextRefineFails,
  refineChineseLevel,
  refineCostUnits,
  refineMainGain,
  refinePowerBonusBp,
  refineSubGain,
  refineSuccessBp,
  rollRefine,
  type EquipmentQuality,
} from '../../apps/server/src/modules/game/equipment';

const QUALITY_IDS: EquipmentQuality[] = ['common', 'spirit', 'treasure', 'immortal'];

/** 2.1 节成功率表（基础 / 每次失败加 / 上限，基点），按冲到 1～12 重逐行照抄。 */
const ODDS_TABLE: [number, number, number][] = [
  [10000, 0, 10000],
  [10000, 0, 10000],
  [10000, 0, 10000],
  [9000, 500, 10000],
  [8000, 500, 9500],
  [6500, 500, 8500],
  [5500, 400, 7500],
  [4500, 400, 6500],
  [3500, 300, 5500],
  [3000, 300, 4800],
  [2500, 200, 4000],
  [2000, 200, 3500],
];

/** 2.2 节消耗表（展示单位：灵石 / 矿石 / 玄铁），按 凡 / 灵 / 宝 / 仙 各 12 行逐格照抄。 */
const COST_TABLE: Record<EquipmentQuality, [number, number, number][]> = {
  common: [
    [12, 9, 0],
    [17, 14, 0],
    [23, 18, 0],
    [33, 27, 0],
    [45, 36, 0],
    [68, 45, 1],
    [90, 54, 1],
    [113, 72, 1],
    [147, 90, 1],
    [180, 108, 2],
    [225, 135, 2],
    [282, 162, 2],
  ],
  spirit: [
    [20, 15, 0],
    [28, 23, 0],
    [38, 30, 0],
    [55, 45, 0],
    [75, 60, 0],
    [113, 75, 1],
    [150, 90, 1],
    [188, 120, 2],
    [245, 150, 2],
    [300, 180, 3],
    [375, 225, 3],
    [470, 270, 4],
  ],
  treasure: [
    [28, 21, 0],
    [39, 32, 0],
    [53, 42, 0],
    [77, 63, 0],
    [105, 84, 0],
    [158, 105, 1],
    [210, 126, 1],
    [263, 168, 2],
    [343, 210, 3],
    [420, 252, 4],
    [525, 315, 4],
    [658, 378, 6],
  ],
  immortal: [
    [40, 30, 0],
    [55, 45, 0],
    [75, 60, 0],
    [110, 90, 0],
    [150, 120, 0],
    [225, 150, 1],
    [300, 180, 2],
    [375, 240, 3],
    [490, 300, 4],
    [600, 360, 5],
    [750, 450, 6],
    [940, 540, 8],
  ],
};

/** 2.3 节主属性增量：[冲 1～5 重, 冲 6～12 重]。 */
const MAIN_GAIN_TABLE: Record<EquipmentQuality, [number, number]> = {
  common: [1, 1],
  spirit: [2, 3],
  treasure: [2, 3],
  immortal: [3, 4],
};

/** 2.3 节副属性增量：[冲到 5 重, 冲到 12 重]。 */
const SUB_GAIN_TABLE: Record<EquipmentQuality, [number, number]> = {
  common: [1, 2],
  spirit: [2, 3],
  treasure: [3, 4],
  immortal: [4, 6],
};

describe('祭炼成功率（2.1）', () => {
  it('第 12 重：0 次 = 2000、5 次 = 3000、8 次 = 3500（封顶）、50 次 = 3500', () => {
    expect(refineSuccessBp(12, 0)).toBe(2000);
    expect(refineSuccessBp(12, 5)).toBe(3000);
    expect(refineSuccessBp(12, 8)).toBe(3500);
    expect(refineSuccessBp(12, 50)).toBe(3500);
  });

  it('第 1 重任何次数都是 100%；第 0 / 13 重不存在，成功率为 0', () => {
    expect(refineSuccessBp(1, 0)).toBe(10000);
    expect(refineSuccessBp(1, 50)).toBe(10000);
    expect(refineSuccessBp(0, 0)).toBe(0);
    expect(refineSuccessBp(13, 0)).toBe(0);
  });

  it('12 行成功率表逐行照抄：0 次 = 基础、1 次 = 基础 + 加成（不超上限）、50 次 = 上限', () => {
    ODDS_TABLE.forEach(([base, step, cap], index) => {
      const level = index + 1;
      expect(refineSuccessBp(level, 0)).toBe(base);
      expect(refineSuccessBp(level, 1)).toBe(Math.min(cap, base + step));
      expect(refineSuccessBp(level, 50)).toBe(cap);
    });
  });

  it('rollRefine：random × 10000 < 成功率 才成功（注入随机数）', () => {
    expect(rollRefine(12, 0, () => 0.1999)).toBe(true);
    expect(rollRefine(12, 0, () => 0.2)).toBe(false);
  });
});

describe('祭炼失败次数（隐藏补偿，只在服务端用）', () => {
  it('成功 → 清零；失败 → +1；封顶 50', () => {
    expect(nextRefineFails(3, true)).toBe(0);
    expect(nextRefineFails(3, false)).toBe(4);
    expect(nextRefineFails(50, false)).toBe(50);
    expect(nextRefineFails(49, false)).toBe(50);
  });
});

describe('祭炼消耗（2.2）', () => {
  it('仙品 9 重 = 灵石 490000 / 矿石 300000 / 玄铁 4000（最小单位）', () => {
    expect(refineCostUnits('immortal', 9)).toEqual({ spiritStone: 490000, ore: 300000, xuantie: 4000 });
  });

  it('凡品 1 重不消耗玄铁：没有 xuantie 键', () => {
    const cost = refineCostUnits('common', 1);
    expect(cost).toEqual({ spiritStone: 12000, ore: 9000 });
    expect('xuantie' in cost).toBe(false);
  });

  it('4 品质 × 12 重与 2.2 表逐格相等（展示值 × 1000；为 0 的资源不出现）', () => {
    for (const quality of QUALITY_IDS) {
      COST_TABLE[quality].forEach(([spiritStone, ore, xuantie], index) => {
        const expected: Record<string, number> = { spiritStone: spiritStone * 1000, ore: ore * 1000 };
        if (xuantie > 0) expected.xuantie = xuantie * 1000;
        expect(refineCostUnits(quality, index + 1)).toEqual(expected);
      });
    }
  });
});

describe('祭炼增量（2.3）', () => {
  it('主属性：4 品质 × 12 重逐格照抄（冲 1～5 重 / 6～12 重两档）', () => {
    for (const quality of QUALITY_IDS) {
      const [early, late] = MAIN_GAIN_TABLE[quality];
      for (let level = 1; level <= 12; level += 1) {
        expect(refineMainGain(quality, level)).toBe(level <= 5 ? early : late);
      }
    }
  });

  it('仙品 0 → 12 重主属性累计 +43（24 → 67）；宝品累计 +31', () => {
    const immortalTotal = Array.from({ length: 12 }, (_, index) => refineMainGain('immortal', index + 1)).reduce(
      (sum, gain) => sum + gain,
      0,
    );
    expect(immortalTotal).toBe(43);
    expect(24 + immortalTotal).toBe(67);
    const treasureTotal = Array.from({ length: 12 }, (_, index) => refineMainGain('treasure', index + 1)).reduce(
      (sum, gain) => sum + gain,
      0,
    );
    expect(treasureTotal).toBe(31);
  });

  it('副属性：只有冲到 5 重 / 12 重时增加，4 品质逐格照抄，其余各重为 0', () => {
    expect(refineSubGain('immortal', 5)).toBe(4);
    expect(refineSubGain('immortal', 12)).toBe(6);
    for (const quality of QUALITY_IDS) {
      const [atFive, atTwelve] = SUB_GAIN_TABLE[quality];
      for (let level = 1; level <= 12; level += 1) {
        const expected = level === 5 ? atFive : level === 12 ? atTwelve : 0;
        expect(refineSubGain(quality, level)).toBe(expected);
      }
    }
  });
});

describe('祭炼战力加成（第 2 节）', () => {
  it('0～12 重的累计加成逐格照抄（8 重及以下为 0，九重起递增）', () => {
    const expected = [0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 200, 300, 600];
    expected.forEach((bp, level) => {
      expect(refinePowerBonusBp(level)).toBe(bp);
    });
    expect(refinePowerBonusBp(-1)).toBe(0);
    expect(refinePowerBonusBp(13)).toBe(0);
  });

  it('8 → 0，9 → 100，11 → 300，12 → 600；仙品十二重一件 = 1600 基点', () => {
    expect(refinePowerBonusBp(8)).toBe(0);
    expect(refinePowerBonusBp(9)).toBe(100);
    expect(refinePowerBonusBp(11)).toBe(300);
    expect(refinePowerBonusBp(12)).toBe(600);
    expect(gearPowerBonusBpOf([{ quality: 'immortal', refine_level: 12 }])).toBe(1600);
  });

  it('没有重数字段的旧装备按 0 重算（只有品质加成）', () => {
    expect(gearPowerBonusBpOf([{ quality: 'immortal' }])).toBe(1000);
    expect(gearPowerBonusBpOf([{ quality: 'common', refine_level: 0 }, { quality: 'spirit', refine_level: 9 }])).toBe(
      200 + 400 + 100,
    );
  });
});

describe('祭炼重数中文名', () => {
  it('1 →「一重」，10 →「十重」，11 →「十一重」，12 →「十二重」，0 与越界为空串', () => {
    expect(refineChineseLevel(1)).toBe('一重');
    expect(refineChineseLevel(10)).toBe('十重');
    expect(refineChineseLevel(11)).toBe('十一重');
    expect(refineChineseLevel(12)).toBe('十二重');
    expect(refineChineseLevel(0)).toBe('');
    expect(refineChineseLevel(13)).toBe('');
    expect(refineChineseLevel(-1)).toBe('');
  });
});
