import { GAME_CONFIG_CONTENT } from '@xiuxian/game-config';
import { describe, expect, it } from 'vitest';
import { resourceRates, settleEconomy, type DiscipleState } from '../../apps/server/src/modules/game/settle';

const disciple: DiscipleState = {
  id: 'worker', aptitude: 50, realmId: 'qiRefining', stage: 1, cultivation: 0,
  cultivationRemainder: 0, assignment: 'energyGathering', talent: 'spiritGathering',
};
const input = {
  config: GAME_CONFIG_CONTENT, lastSettledAt: 0, now: 3_600_000,
  resources: [{ resourceId: 'spiritualEnergy', balance: 0, remainder: 0 }],
  disciples: [disciple], buildingLevels: { spiritualArray: 1 }, productionBonusBp: 200,
};
describe('永久宗门产出奖励', () => {
  it('称号加成同时作用于建筑与岗位，展示速率与一小时入账一致', () => {
    const result = settleEconomy(input, () => 1);
    const rate = resourceRates(input.config, input.disciples, input.buildingLevels, 200).get('spiritualEnergy');
    expect(rate).toBe(408_000);
    expect(result.resources[0]).toMatchObject({ balance: rate, ratePerHour: rate, remainder: 0 });
  });
  it('离线中弟子在外的时段只获得基础产出加成，分次同步保持相同余数', () => {
    const absences = [{ discipleId: disciple.id, startMs: 600_000, endMs: 2_400_000 }];
    const whole = settleEconomy({ ...input, absences }, () => 1);
    const first = settleEconomy({ ...input, now: 1_200_001, absences }, () => 1);
    const second = settleEconomy({ ...input, resources: first.resources, lastSettledAt: 1_200_001, absences }, () => 1);
    expect(whole.resources[0]?.balance).toBe(346_800);
    expect(second.resources).toEqual(whole.resources);
  });
  it('奖励取得前的时段按旧速率结算，之后才使用新速率', () => {
    const before = settleEconomy({ ...input, productionBonusBp: 0 }, () => 1);
    const after = settleEconomy({ ...input, lastSettledAt: input.now, now: input.now * 2, resources: before.resources }, () => 1);
    expect(before.resources[0]?.balance).toBe(400_000);
    expect(after.resources[0]?.balance).toBe(808_000);
  });
});
