import { GAME_CONFIG_CONTENT } from '@xiuxian/game-config';
import { describe, expect, it } from 'vitest';

import {
  assignmentLimitOf,
  missionHallSpiritStoneBonusBp,
  missionHallUpgradeFrom,
  stoneMiningLimitOf,
} from '../../apps/server/src/modules/game/constants';
import { positionOutputPerHour, resourceBaseRates } from '../../apps/server/src/modules/game/settle';

const config = GAME_CONFIG_CONTENT;
const base = { id: 'd', aptitude: 50, stage: 1, cultivation: 0, cultivationRemainder: 0, realmId: 'qiRefining' };

describe('灵石开源：采灵人数按宗门等级分档', () => {
  it('1～5 级 1 人、6～8 级 2 人、9～11 级 4 人、12 级起 6 人', () => {
    expect([1, 5, 6, 8, 9, 11, 12, 15].map(stoneMiningLimitOf)).toEqual([1, 1, 2, 2, 4, 4, 6, 6]);
    expect(assignmentLimitOf('stoneMining', 10)).toBe(4);
  });
});

describe('灵石开源：灵矿扩到 10 级', () => {
  it('配置上限 10；6～10 级走分档表（宗门等级门槛 = 目标等级），1～5 级不走', () => {
    expect(config.buildings.find((building) => building.id === 'missionHall')?.maxLevel).toBe(10);
    expect(missionHallUpgradeFrom(4)).toBeNull();
    expect(missionHallUpgradeFrom(5)).toMatchObject({ level: 6, sectLevel: 6 });
    expect(missionHallUpgradeFrom(5)?.cost).toEqual({ spiritStone: '1000000', ore: '1500000' });
    expect(missionHallUpgradeFrom(9)?.cost.xuantie).toBe('20000');
    expect(missionHallUpgradeFrom(10)).toBeNull();
  });

  it('加成：1～5 级每级 +20%，6～10 级每级 +40%（10 级 ×4）', () => {
    expect([0, 1, 5, 6, 8, 10].map(missionHallSpiritStoneBonusBp)).toEqual([0, 2000, 10_000, 14_000, 22_000, 30_000]);
    // 基础灵石 30 / 小时：5 级 60、10 级 120。
    expect(resourceBaseRates(config, { missionHall: 5 }).get('spiritStone')).toBe(60_000);
    expect(resourceBaseRates(config, { missionHall: 10 }).get('spiritStone')).toBe(120_000);
  });

  it('只加基础产出：采灵岗位产出不受灵矿等级影响', () => {
    const miner = positionOutputPerHour(config, { ...base, assignment: 'stoneMining', talent: 'none' });
    expect(miner.get('spiritStone')).toBe(15_000);
  });
});
