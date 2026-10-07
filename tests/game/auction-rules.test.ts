import { describe, expect, it } from 'vitest';

import {
  auctionFee,
  auctionMinNextBid,
  auctionMinPrice,
  auctionNetworkKey,
  auctionRetractPenalty,
  canRetractAuctionBid,
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

describe('拍卖行 · 同网络标识', () => {
  it('IPv4 原样；拿不到来源返回 null', () => {
    expect(auctionNetworkKey('203.0.113.7')).toBe('203.0.113.7');
    expect(auctionNetworkKey(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(auctionNetworkKey('unknown')).toBeNull();
    expect(auctionNetworkKey('')).toBeNull();
    expect(auctionNetworkKey('not-an-ip')).toBeNull();
  });

  it('IPv6 取前 64 位：同一宽带下后半段不同也算同一网络', () => {
    const phone = auctionNetworkKey('2408:8207:1851:a1c0:1d2e:3f40:5a6b:7c8d');
    const laptop = auctionNetworkKey('2408:8207:1851:a1c0::1');
    expect(phone).toBe('2408:8207:1851:a1c0');
    expect(laptop).toBe(phone);
    expect(auctionNetworkKey('2408:8207:1851:a1c1::1')).not.toBe(phone);
    expect(auctionNetworkKey('2001:db8::')).toBe('2001:db8:0:0');
    expect(auctionNetworkKey('fe80::1%eth0')).toBe('fe80:0:0:0');
    expect(auctionNetworkKey('1::2::3')).toBeNull();
  });
});

describe('拍卖行 · 撤销出价', () => {
  it('违约金 5%（向下取整）', () => {
    expect(auctionRetractPenalty(630_000)).toBe(31_500);
    expect(auctionRetractPenalty(1_001)).toBe(50);
  });

  it('只有领先者、竞价中、离结束超过 2 小时才能撤', () => {
    const now = 1_000_000;
    const twoHours = 2 * 3_600_000;
    expect(canRetractAuctionBid({ endsAt: now + twoHours + 1, isLeading: true, active: true }, now)).toBe(true);
    expect(canRetractAuctionBid({ endsAt: now + twoHours, isLeading: true, active: true }, now)).toBe(false);
    expect(canRetractAuctionBid({ endsAt: now + 10 * twoHours, isLeading: false, active: true }, now)).toBe(false);
    expect(canRetractAuctionBid({ endsAt: now + 10 * twoHours, isLeading: true, active: false }, now)).toBe(false);
  });
});
