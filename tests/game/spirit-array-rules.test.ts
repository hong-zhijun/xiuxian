import { GAME_CONFIG_CONTENT } from '@xiuxian/game-config';
import { describe, expect, it } from 'vitest';

import { spiritualArrayUpgradeFrom } from '../../apps/server/src/modules/game/constants';
import {
  positionOutputPerHour,
  resourceBaseRates,
  resourceRates,
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
    expect(resourceBaseRates(config, levels).get('spiritualEnergy')).toBe(100_000);
    const energy = positionOutputPerHour(config, { ...base, assignment: 'energyGathering', talent: 'none' });
    expect(energy.get('spiritualEnergy')).toBe(10_000);
    // 视图速率：基础 100 + 吐纳 2 × 10 = 120
    const rates = resourceRates(
      config,
      [
        { ...base, id: 'a', assignment: 'energyGathering', talent: 'none' },
        { ...base, id: 'b', assignment: 'energyGathering', talent: 'none' },
      ],
      levels,
    );
    expect(rates.get('spiritualEnergy')).toBe(120_000);
  });

});
