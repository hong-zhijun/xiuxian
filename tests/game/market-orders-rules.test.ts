import { describe, expect, it } from 'vitest';

import { dateKeyUtc8, dayStartMs } from '../../apps/server/src/modules/game/constants';
import {
  MARKET_DAILY_TRADES,
  MARKET_ORDER_TTL_MS,
  MARKET_TICK_MS,
  findOrderFill,
  findStock,
  limitBuyReserve,
  marketFee,
  marketMinuteOf,
  orderTriggered,
  seedNumberOf,
  stockPriceAt,
} from '../../apps/server/src/modules/game/market';

const seed = seedNumberOf('market-order-test-seed');
const stock = findStock('tiangong')!;
const start = marketMinuteOf(Date.UTC(2026, 9, 1, 2, 0));
/**
 * 极端触发价：价格（几千～几万最小单位）远低于 HIGH、远高于 LOW。
 * 买单 / 止损卖（价格 ≤ 触发价）：HIGH 永远满足、LOW 永远不满足；限价卖（价格 ≥ 触发价）反过来。
 */
const HIGH = 900_000_000;
const LOW = 1;

describe('灵股挂单 · 触发条件', () => {
  it('限价买：价格不高于触发价即成交（等于也成交）', () => {
    expect(orderTriggered('limit_buy', 1000, 1000)).toBe(true);
    expect(orderTriggered('limit_buy', 999, 1000)).toBe(true);
    expect(orderTriggered('limit_buy', 1001, 1000)).toBe(false);
  });

  it('限价卖：价格不低于触发价即成交（等于也成交）', () => {
    expect(orderTriggered('limit_sell', 1000, 1000)).toBe(true);
    expect(orderTriggered('limit_sell', 1001, 1000)).toBe(true);
    expect(orderTriggered('limit_sell', 999, 1000)).toBe(false);
  });

  it('止损卖：价格不高于触发价即成交（等于也成交）', () => {
    expect(orderTriggered('stop_sell', 1000, 1000)).toBe(true);
    expect(orderTriggered('stop_sell', 999, 1000)).toBe(true);
    expect(orderTriggered('stop_sell', 1001, 1000)).toBe(false);
  });
});

describe('灵股挂单 · 冻结额与常量', () => {
  it('限价买冻结 = 触发价 × 股数 + 手续费（手续费按触发价算）', () => {
    expect(limitBuyReserve(47_000, 100)).toBe(4_700_000 + marketFee(4_700_000));
    expect(limitBuyReserve(47_000, 100)).toBe(4_714_100);
    // 手续费至少 1 个最小单位
    expect(limitBuyReserve(1000, 1)).toBe(1000 + 3);
    expect(limitBuyReserve(1, 1)).toBe(1 + 1);
  });

  it('有效期 72 小时', () => {
    expect(MARKET_ORDER_TTL_MS).toBe(72 * 3_600_000);
  });
});

describe('灵股挂单 · 找成交分钟', () => {
  it('返回第一个满足触发条件的分钟，成交价是那一分钟的价格', () => {
    const target = start + 120;
    const trigger = stockPriceAt(seed, stock, target);
    const fill = findOrderFill({
      seed,
      stock,
      kind: 'limit_buy',
      triggerPrice: trigger,
      fromMinute: start,
      toMinute: start + 600,
      sellableAt: null,
      tradesUsedOnDay: () => 0,
    });
    expect(fill).not.toBeNull();
    expect(fill!.minute).toBeLessThanOrEqual(target);
    expect(fill!.price).toBe(stockPriceAt(seed, stock, fill!.minute));
    expect(fill!.price).toBeLessThanOrEqual(trigger);
    // 之前的每一分钟都不满足
    for (let minute = start; minute < fill!.minute; minute += 1) {
      expect(stockPriceAt(seed, stock, minute)).toBeGreaterThan(trigger);
    }
  });

  it('卖单：分钟起点早于可卖时刻的分钟跳过', () => {
    const sellableAt = (start + 30) * MARKET_TICK_MS;
    const fill = findOrderFill({
      seed,
      stock,
      kind: 'limit_sell',
      triggerPrice: LOW, // 价格永远不低于它：只看可卖时刻
      fromMinute: start,
      toMinute: start + 100,
      sellableAt,
      tradesUsedOnDay: () => 0,
    });
    expect(fill).toEqual({ minute: start + 30, price: stockPriceAt(seed, stock, start + 30) });
  });

  it('止损卖：可卖时刻之后，价格满足即成交', () => {
    const sellableAt = (start + 5) * MARKET_TICK_MS;
    const fill = findOrderFill({
      seed,
      stock,
      kind: 'stop_sell',
      triggerPrice: HIGH,
      fromMinute: start,
      toMinute: start + 100,
      sellableAt,
      tradesUsedOnDay: () => 0,
    });
    expect(fill?.minute).toBe(start + 5);
  });

  it('当天已满 30 笔：这一天的分钟都跳过，到第二天第一分钟成交', () => {
    const day = dateKeyUtc8(start * MARKET_TICK_MS);
    const nextDayMinute = (dayStartMs(start * MARKET_TICK_MS) + 86_400_000) / MARKET_TICK_MS;
    const fill = findOrderFill({
      seed,
      stock,
      kind: 'limit_buy',
      triggerPrice: HIGH,
      fromMinute: start,
      toMinute: nextDayMinute + 100,
      sellableAt: null,
      tradesUsedOnDay: (key) => (key === day ? MARKET_DAILY_TRADES : 0),
    });
    expect(fill?.minute).toBe(nextDayMinute);
  });

  it('当天笔数还差一笔时仍能成交', () => {
    const day = dateKeyUtc8(start * MARKET_TICK_MS);
    const fill = findOrderFill({
      seed,
      stock,
      kind: 'limit_buy',
      triggerPrice: HIGH,
      fromMinute: start,
      toMinute: start + 100,
      sellableAt: null,
      tradesUsedOnDay: (key) => (key === day ? MARKET_DAILY_TRADES - 1 : 0),
    });
    expect(fill?.minute).toBe(start);
  });

  it('区间内都不满足 → null', () => {
    expect(
      findOrderFill({
        seed,
        stock,
        kind: 'limit_sell',
        triggerPrice: HIGH,
        fromMinute: start,
        toMinute: start + 500,
        sellableAt: null,
        tradesUsedOnDay: () => 0,
      }),
    ).toBeNull();
    expect(
      findOrderFill({
        seed,
        stock,
        kind: 'limit_buy',
        triggerPrice: LOW,
        fromMinute: start,
        toMinute: start + 500,
        sellableAt: null,
        tradesUsedOnDay: () => 0,
      }),
    ).toBeNull();
    // 满足条件，但区间内的每一天都已满 30 笔
    const day = dateKeyUtc8(start * MARKET_TICK_MS);
    expect(
      findOrderFill({
        seed,
        stock,
        kind: 'limit_buy',
        triggerPrice: HIGH,
        fromMinute: start,
        toMinute: start + 500,
        sellableAt: null,
        tradesUsedOnDay: (key) => (key === day ? MARKET_DAILY_TRADES : 0),
      }),
    ).toBeNull();
  });
});
