import { describe, expect, it } from 'vitest';

import {
  CHART_RANGES,
  MARKET_STOCK_EXPANSION_MINUTE,
  STOCKS,
  marketFee,
  marketIndexAt,
  marketMinuteOf,
  marketPositionCap,
  marketSellableAt,
  marginLiquidationPrice,
  marginLiquidationTriggered,
  marginPnl,
  marginRequired,
  newsBetween,
  newsOfSlot,
  seedNumberOf,
  stockCandles,
  stockPriceAt,
} from '../../apps/server/src/modules/game/market';

const seed = seedNumberOf('market-test-seed');
const start = marketMinuteOf(Date.UTC(2026, 9, 1));

describe('灵股 · 价格模型', () => {
  it('确定性：同一种子同一分钟价格相同；换种子价格不同', () => {
    const stock = STOCKS[0]!;
    expect(stockPriceAt(seed, stock, start)).toBe(stockPriceAt(seed, stock, start));
    expect(stockPriceAt(seedNumberOf('another'), stock, start)).not.toBe(stockPriceAt(seed, stock, start));
  });

  it('均值回归：30 天内价格都在基准价的 0.4～2.5 倍之间', () => {
    for (const stock of STOCKS) {
      for (let minute = start; minute < start + 30 * 24 * 60; minute += 37) {
        const price = stockPriceAt(seed, stock, minute) / 1000;
        expect(price).toBeGreaterThan(stock.basePrice * 0.4);
        expect(price).toBeLessThan(stock.basePrice * 2.5);
      }
    }
  });

  it('单分钟波动小：相邻分钟平均涨跌低于来回手续费 0.6% 的一半，超过 0.6% 的分钟不到一成', () => {
    for (const stock of STOCKS) {
      let big = 0;
      let sum = 0;
      let total = 0;
      for (let minute = start; minute < start + 3 * 24 * 60; minute += 1) {
        const change = Math.abs(stockPriceAt(seed, stock, minute + 1) / stockPriceAt(seed, stock, minute) - 1);
        if (change > 0.006) big += 1;
        sum += change;
        total += 1;
      }
      expect(sum / total).toBeLessThan(0.003);
      expect(big / total).toBeLessThan(0.1);
    }
  });

  it('指数：围绕 1000 波动', () => {
    const value = marketIndexAt(seed, start);
    expect(value).toBeGreaterThan(500);
    expect(value).toBeLessThan(2000);
  });

  it('扩容后保留旧通道并启用四支新股', () => {
    expect(STOCKS).toHaveLength(10);
    expect(STOCKS.map((stock) => stock.channel)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(STOCKS.slice(6)).toMatchObject([
      { id: 'wanfa', name: '万法阁', code: 'WFG', sector: '功法', basePrice: 50, volatility: 0.3 },
      { id: 'yushou', name: '御兽盟', code: 'YSM', sector: '灵兽', basePrice: 36, volatility: 0.38 },
      { id: 'tanmi', name: '探秘司', code: 'TMS', sector: '秘境', basePrice: 44, volatility: 0.36 },
      { id: 'xuanfu', name: '玄符局', code: 'XFJ', sector: '符箓', basePrice: 28, volatility: 0.28 },
    ]);
    for (const stock of STOCKS.slice(6)) expect(stock.description.length).toBeGreaterThan(10);
    const legacyMinute = MARKET_STOCK_EXPANSION_MINUTE - 1;
    const newMinute = MARKET_STOCK_EXPANSION_MINUTE;
    const legacyStocks = STOCKS.slice(0, 6);
    const legacyLogSum = legacyStocks.reduce(
      (sum, stock) => sum + Math.log(stockPriceAt(seed, stock, legacyMinute) / (stock.basePrice * 1000)),
      0,
    );
    const expectedLegacyIndex = Math.round(Math.exp(legacyLogSum / legacyStocks.length) * 1000 * 100) / 100;
    expect(marketIndexAt(seed, legacyMinute)).toBe(expectedLegacyIndex);
    expect(legacyStocks.every((stock) => stockPriceAt(seed, stock, legacyMinute) > 0)).toBe(true);
    expect(STOCKS.slice(6).every((stock) => stockPriceAt(seed, stock, newMinute) > 0)).toBe(true);
    const legacyNews = newsBetween(seed, start, MARKET_STOCK_EXPANSION_MINUTE - 1);
    expect(legacyNews.every((news) => news.stockId === null || legacyStocks.some((stock) => stock.id === news.stockId))).toBe(true);
    const newNews = newsBetween(seed, newMinute, newMinute + 3 * 24 * 60);
    expect(newNews.some((news) => news.stockId !== null && STOCKS.slice(6).some((stock) => stock.id === news.stockId))).toBe(true);
  });
});

describe('灵股 · 消息', () => {
  it('每段最多一条，公布时间落在本段内；按时间倒序', () => {
    const news = newsBetween(seed, start, start + 3 * 24 * 60);
    expect(news.length).toBeGreaterThan(5);
    expect(news.length).toBeLessThanOrEqual(25);
    for (let index = 1; index < news.length; index += 1) {
      expect(news[index - 1]!.minute).toBeGreaterThanOrEqual(news[index]!.minute);
    }
    const slot = Math.floor(start / 180);
    const one = newsOfSlot(seed, slot);
    if (one !== null) {
      expect(one.minute).toBeGreaterThanOrEqual(slot * 180);
      expect(one.minute).toBeLessThan((slot + 1) * 180);
      expect(one.title.length).toBeGreaterThan(0);
    }
  });
});

describe('灵股 · K 线与交易规则', () => {
  it('K 线根数与周期一致，高低价包住开收盘，最后一根收在当前价', () => {
    const stock = STOCKS[3]!;
    for (const range of ['1h', '6h', '1d', '7d'] as const) {
      const candles = stockCandles(seed, stock, start + 1234, range);
      expect(candles).toHaveLength(CHART_RANGES[range].candles);
      for (const candle of candles) {
        expect(candle.h).toBeGreaterThanOrEqual(Math.max(candle.o, candle.c));
        expect(candle.l).toBeLessThanOrEqual(Math.min(candle.o, candle.c));
      }
      expect(candles.at(-1)!.c).toBe(stockPriceAt(seed, stock, start + 1234));
    }
  });

  it('手续费 0.3% 向上取整；持仓上限 20%；买入 10 分钟后可卖', () => {
    expect(marketFee(100_000)).toBe(300);
    expect(marketFee(1)).toBe(1);
    expect(marketFee(0)).toBe(0);
    expect(marketPositionCap(10_000_000)).toBe(2_000_000);
    expect(marketSellableAt(1_000)).toBe(1_000 + 600_000);
    expect(marketSellableAt(null)).toBeNull();
  });

  it('保证金合约：5 倍保证金、方向收益与强平边界', () => {
    expect(marginRequired(1_000_000)).toBe(200_000);
    expect(marginPnl('long', 100_000, 110_000, 10)).toBe(100_000);
    expect(marginPnl('short', 100_000, 90_000, 10)).toBe(100_000);
    const longLiq = marginLiquidationPrice('long', 100_000, 10, marginRequired(1_000_000));
    const shortLiq = marginLiquidationPrice('short', 100_000, 10, marginRequired(1_000_000));
    expect(longLiq).toBeGreaterThan(0);
    expect(longLiq).toBeLessThan(100_000);
    expect(shortLiq).toBeGreaterThan(100_000);
    expect(marginLiquidationTriggered('long', longLiq, longLiq)).toBe(true);
    expect(marginLiquidationTriggered('short', shortLiq, shortLiq)).toBe(true);
    expect(marginLiquidationTriggered('long', longLiq + 1, longLiq)).toBe(false);
    expect(marginLiquidationTriggered('short', shortLiq - 1, shortLiq)).toBe(false);
  });
});
