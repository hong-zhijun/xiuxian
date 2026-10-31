import { GAME_CONFIG_CONTENT } from '@xiuxian/game-config';
import { describe, expect, it } from 'vitest';

import { spiritualArrayUpgradeFrom } from '../../apps/server/src/modules/game/constants';
import {
  positionOutputPerHour,
  resourceBaseRates,
  resourceRates,
  settleEconomy,
} from '../../apps/server/src/modules/game/settle';

const config = GAME_CONFIG_CONTENT;
const base = { id: 'd', aptitude: 50, stage: 1, cultivation: 0, cultivationRemainder: 0, realmId: 'qiRefining' };

describe('聚灵阵扩到 10 级', () => {
  it('配置上限 10；6～10 级走分档表（宗门等级门槛 = 目标等级），1～5 级不走', () => {
    expect(config.buildings.find((building) => building.id === 'spiritualArray')?.maxLevel).toBe(10);
    expect(spiritualArrayUpgradeFrom(4)).toBeNull();
    expect(spiritualArrayUpgradeFrom(5)).toMatchObject({ level: 6, sectLevel: 6 });
    expect(spiritualArrayUpgradeFrom(9)?.cost.xuantie).toBe('20000');
    expect(spiritualArrayUpgradeFrom(10)).toBeNull();
  });

  it('加成只作用于基础产出：10 级 ×5；吐纳与其他岗位不受影响', () => {
    const levels = { spiritualArray: 10 };
    expect(resourceBaseRates(config, levels).get('spiritualEnergy')).toBe(1_000_000);
    const energy = positionOutputPerHour(config, { ...base, assignment: 'energyGathering', talent: 'none' });
    expect(energy.get('spiritualEnergy')).toBe(100_000);
    // 视图速率：基础 1000 + 吐纳 2 × 100 = 1200。
    const rates = resourceRates(
      config,
      [
        { ...base, id: 'a', assignment: 'energyGathering', talent: 'none' },
        { ...base, id: 'b', assignment: 'energyGathering', talent: 'none' },
      ],
      levels,
    );
    expect(rates.get('spiritualEnergy')).toBe(1_200_000);
  });

});

describe('灵气产速提升十倍', () => {
  it('新老宗门基础产气、吐纳和聚灵天赋均生效；分段在线与离线收益一致', () => {
    expect(resourceBaseRates(config).get('spiritualEnergy')).toBe(200_000);
    // 新宗门的 1 级聚灵阵：200 × 1.4 + 聚灵吐纳 100 × 1.2 = 400 灵气 / 小时。
    const disciple = { ...base, assignment: 'energyGathering', talent: 'spiritGathering' };
    const input = {
      config,
      lastSettledAt: 0,
      now: 1_200_000,
      resources: [{ resourceId: 'spiritualEnergy', balance: 9_000_000, remainder: 0 }],
      disciples: [disciple],
      buildingLevels: { spiritualArray: 1 },
    };
    const offline = settleEconomy(input, () => 0.999);
    const first = settleEconomy({ ...input, now: 600_000 }, () => 0.999);
    const online = settleEconomy({ ...input, lastSettledAt: 600_000, resources: first.resources }, () => 0.999);
    expect(offline.resources[0]).toMatchObject({ ratePerHour: 400_000, balance: 9_133_333 });
    expect(online.resources).toEqual(offline.resources);
    // 10 级聚灵阵配聚灵吐纳：1000 + 120 = 1120 灵气 / 小时。
    expect(resourceRates(config, [disciple], { spiritualArray: 10 }).get('spiritualEnergy')).toBe(1_120_000);
  });
});
