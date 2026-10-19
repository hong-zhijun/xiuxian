import { GAME_CONFIG_CONTENT } from '@xiuxian/game-config';
import { describe, expect, it } from 'vitest';

import { scriptureLibraryCultivationBonusBp, scriptureLibraryUpgradeFrom } from '../../apps/server/src/modules/game/constants';
import { cultivationRatePerHour } from '../../apps/server/src/modules/game/settle';
import {
  isTechniqueShopTier,
  TECHNIQUE_SHOP_PRICE,
  techniqueShopOpenLevel,
  techniqueShopQuota,
} from '../../apps/server/src/modules/game/techniques';

const config = GAME_CONFIG_CONTENT;
const disciple = {
  id: 'd',
  aptitude: 50,
  stage: 1,
  cultivation: 0,
  cultivationRemainder: 0,
  realmId: 'qiRefining',
  assignment: 'cultivating',
  talent: 'none',
};

describe('藏经阁扩建：上限 10 级', () => {
  it('配置上限 10；6～10 级走分档表（宗门等级门槛 = 目标等级），1～5 级不走', () => {
    expect(config.buildings.find((building) => building.id === 'scriptureLibrary')?.maxLevel).toBe(10);
    expect(scriptureLibraryUpgradeFrom(4)).toBeNull();
    expect(scriptureLibraryUpgradeFrom(5)).toMatchObject({ level: 6, sectLevel: 6 });
    expect(scriptureLibraryUpgradeFrom(5)?.cost).toEqual({ spiritStone: '1500000', herb: '600000' });
    expect(scriptureLibraryUpgradeFrom(8)?.cost).toEqual({ spiritStone: '6000000', herb: '2400000', xuantie: '10000' });
    expect(scriptureLibraryUpgradeFrom(9)?.cost.xuantie).toBe('20000');
    expect(scriptureLibraryUpgradeFrom(10)).toBeNull();
  });

  it('修炼加成：1～5 级每级 +10%，6～10 级每级 +20%（10 级共 +150%）', () => {
    expect([0, 1, 5, 6, 10].map(scriptureLibraryCultivationBonusBp)).toEqual([0, 1000, 5000, 7000, 15000]);
    // 同一名弟子：10 级的修炼速度是 0 级的 2.5 倍，5 级是 1.5 倍（与结算同一取整口径）。
    const base = cultivationRatePerHour(config, disciple, 0);
    expect(base).toBeGreaterThan(0);
    expect(cultivationRatePerHour(config, disciple, 10)).toBe(Math.floor((base * 25_000) / 10_000));
    expect(cultivationRatePerHour(config, disciple, 5)).toBe(Math.floor((base * 15_000) / 10_000));
  });
});

describe('功法商店：每日限量', () => {
  it('额度表：0 级全 0，1 级玄阶 2 / 地阶 0，3 级 3 / 1，10 级 6 / 4', () => {
    expect(techniqueShopQuota(0, 'xuan')).toBe(0);
    expect(techniqueShopQuota(0, 'di')).toBe(0);
    expect(techniqueShopQuota(1, 'xuan')).toBe(2);
    expect(techniqueShopQuota(1, 'di')).toBe(0);
    expect(techniqueShopQuota(3, 'xuan')).toBe(3);
    expect(techniqueShopQuota(3, 'di')).toBe(1);
    expect(techniqueShopQuota(10, 'xuan')).toBe(6);
    expect(techniqueShopQuota(10, 'di')).toBe(4);
  });

  it('等级取整并夹在 0～10；玄阶 1 级开放、地阶 3 级开放', () => {
    expect(techniqueShopQuota(-2, 'xuan')).toBe(0);
    expect(techniqueShopQuota(99, 'di')).toBe(4);
    expect(techniqueShopQuota(4.9, 'xuan')).toBe(3);
    expect(techniqueShopOpenLevel('xuan')).toBe(1);
    expect(techniqueShopOpenLevel('di')).toBe(3);
  });

  it('只卖玄阶、地阶（天阶不在商店出售）；单价玄阶 60 灵石、地阶 180 灵石（最小单位）', () => {
    expect(isTechniqueShopTier('xuan')).toBe(true);
    expect(isTechniqueShopTier('di')).toBe(true);
    expect(isTechniqueShopTier('tian')).toBe(false);
    expect(TECHNIQUE_SHOP_PRICE).toEqual({ xuan: 60_000, di: 180_000 });
  });
});
