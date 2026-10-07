import { describe, expect, it } from 'vitest';

import {
  auctionFee,
  auctionMinNextBid,
  auctionMinPrice,
  auctionSellerProceeds,
  auctionUnitFloor,
  findAuctionResource,
  isAuctionPill,
  parseEquipmentSnapshot,
} from '../../apps/server/src/modules/game/auction';

describe('拍卖行 · 最低价', () => {
  it('装备按炼器成本的 20%（玄铁按 50 灵石折算）', () => {
    // 凡品：80 + 150 = 230 → 46
    expect(auctionUnitFloor('equipment', 'common')).toBe(46_000);
    // 灵品：250 + 400 + 2 × 50 = 750 → 150
    expect(auctionUnitFloor('equipment', 'spirit')).toBe(150_000);
    // 仙品：1500 + 2500 + 18 × 50 = 4900 → 980
    expect(auctionUnitFloor('equipment', 'immortal')).toBe(980_000);
  });

  it('丹药按配方成本的 20%，按颗数相乘；玄铁 / 神木每个 10', () => {
    // 聚气丹：25 + 15 + 10 = 50 → 10
    expect(auctionUnitFloor('pill', 'cultivationPill')).toBe(10_000);
    expect(auctionMinPrice('pill', 'cultivationPill', 3)).toBe(30_000);
    // 洗髓丹：300 + 300 + 3 × 50 = 750 → 150
    expect(auctionUnitFloor('pill', 'talentPill')).toBe(150_000);
    expect(auctionMinPrice('resource', 'xuantie', 10)).toBe(100_000);
  });

  it('白名单：药材 / 功勋不能拍；未知丹药不能拍', () => {
    expect(findAuctionResource('shenmu')?.name).toBe('神木');
    expect(findAuctionResource('herb')).toBeUndefined();
    expect(findAuctionResource('bossMerit')).toBeUndefined();
    expect(isAuctionPill('healingPill')).toBe(true);
    expect(isAuctionPill('nope')).toBe(false);
  });
});

describe('拍卖行 · 竞价与手续费', () => {
  it('没人出价时下一口 = 起拍价；之后至少 +5%（向上取整到整灵石）且至少 +1', () => {
    expect(auctionMinNextBid({ startPrice: 600_000, currentPrice: null })).toBe(600_000);
    expect(auctionMinNextBid({ startPrice: 600_000, currentPrice: 600_000 })).toBe(630_000);
    expect(auctionMinNextBid({ startPrice: 1_000, currentPrice: 1_000 })).toBe(2_000);
    expect(auctionMinNextBid({ startPrice: 1_000, currentPrice: 101_000 })).toBe(107_000);
  });

  it('手续费 10%，卖家实得 = 成交价 − 手续费', () => {
    expect(auctionFee(630_000)).toBe(63_000);
    expect(auctionSellerProceeds(630_000)).toBe(567_000);
    expect(auctionFee(1_001)).toBe(100);
  });

  it('装备快照：字段齐全才算有效', () => {
    const ok = JSON.stringify({
      slot: 'weapon', quality: 'spirit', name: '剑', mainAttr: 'attack', mainValue: 16, subAttr: 'luck', subValue: 4, source: 'forge',
    });
    expect(parseEquipmentSnapshot(ok)?.name).toBe('剑');
    expect(parseEquipmentSnapshot('{"slot":"weapon"}')).toBeNull();
    expect(parseEquipmentSnapshot('not json')).toBeNull();
    expect(parseEquipmentSnapshot(null)).toBeNull();
  });
});
