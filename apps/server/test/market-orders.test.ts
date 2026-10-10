import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { dayStartMs } from '../src/modules/game/constants';
import {
  MARKET_DAILY_TRADES,
  MARKET_HOLD_MS,
  MARKET_ORDER_TTL_MS,
  MARKET_TICK_MS,
  findStock,
  limitBuyReserve,
  marketFee,
  marketMinuteOf,
  seedNumberOf,
  stockPriceAt,
} from '../src/modules/game/market';
import {
  cancelStockOrder,
  getMarket,
  placeStockOrder,
  processSectStockOrders,
  processStockOrders,
  tradeStock,
} from '../src/modules/game/service';

import { dataOf, errorOf, TestClient } from './support/authClient';

/**
 * 0049 灵股挂单：服务层 + D1 的集成测试（docs/灵股挂单开发计划.md 第 3.2 节）。
 *
 * 种子固定写进 market_state，期望价格用同一个 stockPriceAt 算；宗门结算拨到很晚（窗口为 0）。
 * 本文件一份独立内存 D1，没有逐用例回滚：每个用例用独立账号 / 宗门（前缀递增）。
 * 「永远不成交 / 立即成交」的触发价：天工坊行情在 1 万～12 万最小单位之间，
 * 限价买 1000（1 灵石）永远不满足；止损卖 / 限价买 100 万（1000 灵石）永远满足；限价卖 100 万永远不满足。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await env.DB.prepare("INSERT INTO market_state (id, seed, created_at) VALUES ('main', 'test-seed', 0)").run();

const app = createApp({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
const NOW = Date.UTC(2026, 5, 1, 4, 0, 30);
const FAR = NOW + 30 * 86_400_000;
const SEED = seedNumberOf('test-seed');
const stock = findStock('tiangong')!;
/** 永远不成交的限价买 / 限价卖触发价，以及永远成交的止损卖 / 限价买触发价。 */
const NEVER_BUY = 1000;
const NEVER_SELL = 900_000_000;
const ALWAYS_BUY = 1_000_000;

interface Sect {
  api: TestClient;
  userId: string;
  sectId: string;
}

interface HoldingRow {
  shares: number;
  cost: number;
  last_buy_at: number | null;
  version: number;
}

let seq = 0;

async function makeSect(level: number): Promise<Sect> {
  seq += 1;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.42.0.${seq}` });
  expect((await api.post('/api/v1/auth/register', { account: `order-${seq}`, password: 'password-123456' })).status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `挂单${seq}号` });
  const sectId = (dataOf(created) as { state: { sect: { id: string } } }).state.sect.id;
  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?').bind(sectId).first<{ user_id: string }>();
  await env.DB.prepare('UPDATE sects SET level = ?, last_settled_at = ? WHERE id = ?').bind(level, FAR, sectId).run();
  await env.DB.prepare("UPDATE resource_balances SET balance = 5000000 WHERE sect_id = ? AND resource_id = 'spiritStone'")
    .bind(sectId)
    .run();
  return { api, userId: row!.user_id, sectId };
}

async function stoneOf(sectId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = 'spiritStone'")
    .bind(sectId)
    .first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

async function holdingOf(sectId: string, stockId = 'tiangong'): Promise<HoldingRow | null> {
  return env.DB.prepare('SELECT shares, cost, last_buy_at, version FROM stock_holdings WHERE sect_id = ? AND stock_id = ?')
    .bind(sectId, stockId)
    .first<HoldingRow>();
}

async function eventsOf(sectId: string, eventId: string): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT description FROM event_log WHERE sect_id = ? AND event_id = ?')
    .bind(sectId, eventId)
    .all<{ description: string }>();
  return rows.results.map((row) => row.description);
}

/** 直接往流水里塞成交（占用某一天的笔数）。 */
async function addTrades(sectId: string, count: number, at: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await env.DB.prepare(
      `INSERT INTO stock_trades (id, sect_id, stock_id, side, shares, price, amount, fee, profit, created_at)
       VALUES (?, ?, 'yunlai', 'buy', 1, 1000, 1000, 3, 0, ?)`,
    )
      .bind(crypto.randomUUID(), sectId, at)
      .run();
  }
}

describe('灵股挂单', () => {
  it('限价买冻结触发价 × 股数 + 手续费；第 6 个未完成挂单被拒', async () => {
    const sect = await makeSect(3);
    const before = await stoneOf(sect.sectId);
    const placed = await placeStockOrder(
      env.DB,
      sect.userId,
      { stockId: 'tiangong', kind: 'limit_buy', shares: 100, triggerPrice: NEVER_BUY },
      NOW,
    );
    const reserve = limitBuyReserve(NEVER_BUY, 100);
    expect(reserve).toBe(100_300);
    expect(await stoneOf(sect.sectId)).toBe(before - reserve);
    expect(placed.market.orders.open).toHaveLength(1);
    expect(placed.market.orders.open[0]).toMatchObject({
      stockName: '天工坊',
      kind: 'limit_buy',
      kindName: '限价买',
      status: 'open',
      statusName: '未成交',
      shares: 100,
      triggerPrice: NEVER_BUY,
      reserved: reserve,
      closeReason: null,
    });

    for (let index = 0; index < 4; index += 1) {
      await placeStockOrder(env.DB, sect.userId, { stockId: 'yunlai', kind: 'limit_buy', shares: 1, triggerPrice: NEVER_BUY }, NOW);
    }
    await expect(
      placeStockOrder(env.DB, sect.userId, { stockId: 'yunlai', kind: 'limit_buy', shares: 1, triggerPrice: NEVER_BUY }, NOW),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });

    const panel = await getMarket(env.DB, sect.userId, NOW);
    expect(panel.market.orders.open).toHaveLength(5);
    expect(panel.market.orders.maxOpen).toBe(5);
    expect(panel.market.orders.ttlHours).toBe(72);
  });

  it('限价买到价：按成交分钟的价格成交，冻结多出的部分退回，持仓与流水正确', async () => {
    const sect = await makeSect(3);
    const minute = marketMinuteOf(NOW);
    const price = stockPriceAt(SEED, stock, minute);
    const trigger = price + 2000;
    const before = await stoneOf(sect.sectId);
    const placed = await placeStockOrder(
      env.DB,
      sect.userId,
      { stockId: 'tiangong', kind: 'limit_buy', shares: 10, triggerPrice: trigger },
      NOW,
    );
    const orderId = placed.market.orders.open[0]!.id;
    expect(await stoneOf(sect.sectId)).toBe(before - limitBuyReserve(trigger, 10));

    // 惰性结算：行情面板会处理本宗挂单，这一分钟的价格已经满足条件
    const panel = await getMarket(env.DB, sect.userId, NOW);
    expect(panel.market.orders.open).toHaveLength(0);
    expect(panel.market.orders.recent.find((item) => item.id === orderId)).toMatchObject({
      status: 'filled',
      statusName: '已成交',
      fillPrice: price,
      closeReason: 'filled',
      filledAt: new Date(minute * MARKET_TICK_MS).toISOString(),
    });

    const amount = price * 10;
    const fee = marketFee(amount);
    expect(await stoneOf(sect.sectId)).toBe(before - amount - fee);
    expect(await holdingOf(sect.sectId)).toMatchObject({ shares: 10, cost: amount, last_buy_at: minute * MARKET_TICK_MS });
    const trade = await env.DB.prepare(
      'SELECT side, shares, price, amount, fee, profit, created_at FROM stock_trades WHERE sect_id = ?',
    )
      .bind(sect.sectId)
      .first();
    expect(trade).toMatchObject({ side: 'buy', shares: 10, price, amount, fee, profit: 0, created_at: minute * MARKET_TICK_MS });
    expect(panel.market.tradesUsed).toBe(1);
    const logs = await eventsOf(sect.sectId, 'stockOrderFilled');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('限价买入天工坊 10 股成交');
  });

  it('卖单锁股数：超过可用股数被拒；锁定后手动卖出只能卖可用部分', async () => {
    const sect = await makeSect(3);
    await tradeStock(env.DB, sect.userId, { stockId: 'tiangong', side: 'buy', shares: 10 }, NOW);

    await expect(
      placeStockOrder(env.DB, sect.userId, { stockId: 'tiangong', kind: 'limit_sell', shares: 11, triggerPrice: NEVER_SELL }, NOW),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    const placed = await placeStockOrder(
      env.DB,
      sect.userId,
      { stockId: 'tiangong', kind: 'limit_sell', shares: 6, triggerPrice: NEVER_SELL },
      NOW,
    );
    expect(placed.market.stocks.find((item) => item.id === 'tiangong')!.holding).toMatchObject({
      shares: 10,
      locked: 6,
      available: 4,
    });
    // 锁定的股数不从持仓扣
    expect(await holdingOf(sect.sectId)).toMatchObject({ shares: 10 });
    await expect(
      placeStockOrder(env.DB, sect.userId, { stockId: 'tiangong', kind: 'stop_sell', shares: 5, triggerPrice: NEVER_SELL }, NOW),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });

    const sellAt = NOW + MARKET_HOLD_MS;
    await expect(
      tradeStock(env.DB, sect.userId, { stockId: 'tiangong', side: 'sell', shares: 5 }, sellAt),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS', message: expect.stringContaining('可卖 4 股') });
    const sold = await tradeStock(env.DB, sect.userId, { stockId: 'tiangong', side: 'sell', shares: 4 }, sellAt);
    expect(sold.market.stocks.find((item) => item.id === 'tiangong')!.holding).toMatchObject({
      shares: 6,
      locked: 6,
      available: 0,
    });
  });

  it('两个同时下的卖单只有一个能通过（不会各自拿到同一份可用股数）', async () => {
    const sect = await makeSect(3);
    await tradeStock(env.DB, sect.userId, { stockId: 'tiangong', side: 'buy', shares: 10 }, NOW);
    const results = await Promise.allSettled([
      placeStockOrder(env.DB, sect.userId, { stockId: 'tiangong', kind: 'limit_sell', shares: 10, triggerPrice: NEVER_SELL }, NOW),
      placeStockOrder(env.DB, sect.userId, { stockId: 'tiangong', kind: 'stop_sell', shares: 10, triggerPrice: 1 }, NOW),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const panel = await getMarket(env.DB, sect.userId, NOW);
    expect(panel.market.orders.open).toHaveLength(1);
    expect(panel.market.stocks.find((item) => item.id === 'tiangong')!.holding).toMatchObject({ locked: 10, available: 0 });
  });

  it('止损卖：买入后 10 分钟内不成交，过了可卖时刻，价格满足即在第一个可卖的分钟成交', async () => {
    const sect = await makeSect(3);
    await tradeStock(env.DB, sect.userId, { stockId: 'tiangong', side: 'buy', shares: 10 }, NOW);
    const buyAmount = stockPriceAt(SEED, stock, marketMinuteOf(NOW)) * 10;
    const placed = await placeStockOrder(
      env.DB,
      sect.userId,
      { stockId: 'tiangong', kind: 'stop_sell', shares: 10, triggerPrice: ALWAYS_BUY },
      NOW,
    );
    const orderId = placed.market.orders.open[0]!.id;

    // 价格一直满足，但还在锁定期内：仍然未成交
    const midway = await getMarket(env.DB, sect.userId, NOW + 5 * 60_000);
    expect(midway.market.orders.open.map((item) => item.id)).toEqual([orderId]);

    // 第一个可卖的分钟：分钟起点不早于 买入时刻 + 10 分钟
    const sellableAt = NOW + MARKET_HOLD_MS;
    let firstMinute = marketMinuteOf(sellableAt);
    if (firstMinute * MARKET_TICK_MS < sellableAt) firstMinute += 1;
    const later = await getMarket(env.DB, sect.userId, (firstMinute + 2) * MARKET_TICK_MS);
    const sellPrice = stockPriceAt(SEED, stock, firstMinute);
    expect(later.market.orders.recent.find((item) => item.id === orderId)).toMatchObject({
      status: 'filled',
      fillPrice: sellPrice,
      filledAt: new Date(firstMinute * MARKET_TICK_MS).toISOString(),
    });

    expect(await holdingOf(sect.sectId)).toMatchObject({ shares: 0, cost: 0 });
    const sell = await env.DB.prepare("SELECT profit FROM stock_trades WHERE sect_id = ? AND side = 'sell'")
      .bind(sect.sectId)
      .first<{ profit: number }>();
    const proceeds = sellPrice * 10 - marketFee(sellPrice * 10);
    expect(sell?.profit).toBe(proceeds - buyAmount);
    const logs = await eventsOf(sect.sectId, 'stockOrderFilled');
    expect(logs.some((text) => text.includes('止损卖出天工坊 10 股成交'))).toBe(true);
  });

  it('撤单：限价买的冻结灵石原路退回；不能撤别人的单，也不能撤已结束的单', async () => {
    const sect = await makeSect(3);
    const other = await makeSect(3);
    const before = await stoneOf(sect.sectId);
    const placed = await placeStockOrder(
      env.DB,
      sect.userId,
      { stockId: 'tiangong', kind: 'limit_buy', shares: 100, triggerPrice: NEVER_BUY },
      NOW,
    );
    const orderId = placed.market.orders.open[0]!.id;

    await expect(cancelStockOrder(env.DB, other.userId, orderId, NOW)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const cancelled = await cancelStockOrder(env.DB, sect.userId, orderId, NOW);
    expect(await stoneOf(sect.sectId)).toBe(before);
    expect(cancelled.market.orders.open).toHaveLength(0);
    expect(cancelled.market.orders.recent[0]).toMatchObject({ id: orderId, status: 'cancelled', closeReason: 'user' });
    await expect(cancelStockOrder(env.DB, sect.userId, orderId, NOW)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  it('到期：72 小时没成交 → 已过期，买单退回全部冻结灵石，天机录有一条', async () => {
    const sect = await makeSect(3);
    const before = await stoneOf(sect.sectId);
    const placed = await placeStockOrder(
      env.DB,
      sect.userId,
      { stockId: 'tiangong', kind: 'limit_buy', shares: 100, triggerPrice: NEVER_BUY },
      NOW,
    );
    const orderId = placed.market.orders.open[0]!.id;

    const panel = await getMarket(env.DB, sect.userId, NOW + MARKET_ORDER_TTL_MS + 60_000);
    expect(await stoneOf(sect.sectId)).toBe(before);
    expect(panel.market.orders.open).toHaveLength(0);
    expect(panel.market.orders.recent.find((item) => item.id === orderId)).toMatchObject({
      status: 'expired',
      statusName: '已过期',
      closeReason: 'expired',
    });
    const logs = await eventsOf(sect.sectId, 'stockOrderExpired');
    expect(logs).toEqual(['天工坊限价买单已过期，退回 100.3 灵石']);
  });

  it('每日 30 笔：当天已满的分钟不成交，顺延到第二天第一分钟成交', async () => {
    const sect = await makeSect(3);
    const minute = marketMinuteOf(NOW);
    const price = stockPriceAt(SEED, stock, minute);
    await addTrades(sect.sectId, MARKET_DAILY_TRADES - 1, dayStartMs(NOW) + 1000);

    // 挂单 A：还差一笔，这一分钟就能成交（占掉当天最后一笔）
    await placeStockOrder(env.DB, sect.userId, { stockId: 'tiangong', kind: 'limit_buy', shares: 1, triggerPrice: price + 100 }, NOW);
    const first = await getMarket(env.DB, sect.userId, NOW);
    expect(first.market.tradesUsed).toBe(MARKET_DAILY_TRADES);
    expect(first.market.orders.open).toHaveLength(0);

    // 挂单 B：当天已满，1 分钟后仍未成交
    const placedB = await placeStockOrder(
      env.DB,
      sect.userId,
      { stockId: 'tiangong', kind: 'limit_buy', shares: 1, triggerPrice: ALWAYS_BUY },
      NOW,
    );
    const orderB = placedB.market.orders.open[0]!.id;
    const sameDay = await getMarket(env.DB, sect.userId, NOW + 60_000);
    expect(sameDay.market.orders.open.map((item) => item.id)).toEqual([orderB]);

    // 到第二天：从第二天 0 点（UTC+8）的第一分钟起成交
    const nextDayMinute = (dayStartMs(NOW) + 86_400_000) / MARKET_TICK_MS;
    const nextDay = await getMarket(env.DB, sect.userId, NOW + 25 * 3_600_000);
    expect(nextDay.market.orders.open).toHaveLength(0);
    expect(nextDay.market.orders.recent.find((item) => item.id === orderB)).toMatchObject({
      status: 'filled',
      fillPrice: stockPriceAt(SEED, stock, nextDayMinute),
      filledAt: new Date(nextDayMinute * MARKET_TICK_MS).toISOString(),
    });
    expect(nextDay.market.tradesUsed).toBe(1);
  });

  it('同一单被多次同时处理，只成交一次', async () => {
    const sect = await makeSect(3);
    const minute = marketMinuteOf(NOW);
    const price = stockPriceAt(SEED, stock, minute);
    const before = await stoneOf(sect.sectId);
    await placeStockOrder(env.DB, sect.userId, { stockId: 'tiangong', kind: 'limit_buy', shares: 10, triggerPrice: price + 1000 }, NOW);

    await Promise.all([
      processStockOrders(env.DB, NOW),
      processSectStockOrders(env.DB, sect.sectId, NOW),
      processStockOrders(env.DB, NOW),
    ]);

    const trades = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM stock_trades WHERE sect_id = ?')
      .bind(sect.sectId)
      .first<{ cnt: number }>();
    expect(trades?.cnt).toBe(1);
    expect(await holdingOf(sect.sectId)).toMatchObject({ shares: 10 });
    expect(await eventsOf(sect.sectId, 'stockOrderFilled')).toHaveLength(1);
    expect(await stoneOf(sect.sectId)).toBe(before - price * 10 - marketFee(price * 10));
  });

  it('接口：POST 下单 / 撤单；参数不对返回 VALIDATION_ERROR', async () => {
    const sect = await makeSect(3);
    const placed = await sect.api.post('/api/v1/game/market/orders', {
      stockId: 'tiangong',
      kind: 'limit_buy',
      shares: 10,
      triggerPrice: NEVER_BUY,
    });
    const market = (dataOf(placed) as { market: { orders: { open: { id: string }[] } } }).market;
    expect(market.orders.open).toHaveLength(1);

    const cancelled = await sect.api.post('/api/v1/game/market/orders/cancel', { orderId: market.orders.open[0]!.id });
    const after = (dataOf(cancelled) as { market: { orders: { open: unknown[] } } }).market;
    expect(after.orders.open).toHaveLength(0);

    const badKind = await sect.api.post('/api/v1/game/market/orders', {
      stockId: 'tiangong',
      kind: 'short',
      shares: 10,
      triggerPrice: NEVER_BUY,
    });
    expect(errorOf(badKind).code).toBe('VALIDATION_ERROR');
    const extraField = await sect.api.post('/api/v1/game/market/orders', {
      stockId: 'tiangong',
      kind: 'limit_buy',
      shares: 10,
      triggerPrice: NEVER_BUY,
      side: 'buy',
    });
    expect(errorOf(extraField).code).toBe('VALIDATION_ERROR');
    const fractional = await sect.api.post('/api/v1/game/market/orders', {
      stockId: 'tiangong',
      kind: 'limit_buy',
      shares: 10,
      triggerPrice: 47.5,
    });
    expect(errorOf(fractional).code).toBe('VALIDATION_ERROR');
  });
});
