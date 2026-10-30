import { GAME_CONFIG_CONTENT } from '@xiuxian/game-config';
import { describe, expect, it } from 'vitest';

import { cultivationRatePerHour, settleEconomy } from '../../apps/server/src/modules/game/settle';

const disciple = {
  id: 'cultivator', aptitude: 50, realmId: 'goldenCore', stage: 1,
  cultivation: 0, cultivationRemainder: 0, assignment: 'cultivating', talent: 'none',
};
const hour = 3_600_000;

describe('飞升更新修炼提速', () => {
  it('静修基础提高十倍，资质、藏经阁与境界加成继续生效，非修炼岗位不增加修为', () => {
    expect(cultivationRatePerHour(GAME_CONFIG_CONTENT, disciple)).toBe(600);
    expect(cultivationRatePerHour(GAME_CONFIG_CONTENT, { ...disciple, aptitude: 100 })).toBe(720);
    expect(cultivationRatePerHour(GAME_CONFIG_CONTENT, disciple, 10)).toBe(1500);
    expect(cultivationRatePerHour(GAME_CONFIG_CONTENT, { ...disciple, realmId: 'spiritTransformation' }, 10)).toBe(3000);
    expect(cultivationRatePerHour(GAME_CONFIG_CONTENT, { ...disciple, assignment: 'idle' })).toBe(0);
  });

  it('分段在线与整段离线结算收益相同，到突破门槛后停止累积', () => {
    const input = { config: GAME_CONFIG_CONTENT, lastSettledAt: 0, now: hour / 2, resources: [], disciples: [disciple] };
    const offline = settleEconomy(input, () => 0.999);
    const first = settleEconomy({ ...input, now: hour / 4 }, () => 0.999);
    const online = settleEconomy({
      ...input, lastSettledAt: first.lastSettledAt,
      disciples: [{ ...disciple, ...first.disciples[0]! }],
    }, () => 0.999);
    expect(offline.disciples[0]).toMatchObject({ cultivation: 300, cultivationRemainder: 0, ratePerHour: 600 });
    expect(online.disciples).toEqual(offline.disciples);
    const capped = settleEconomy({ ...input, disciples: [{ ...disciple, realmId: 'qiRefining' }] }, () => 0.999);
    expect(capped.disciples[0]).toMatchObject({ cultivation: 30, cultivationRemainder: 0 });
  });
});
