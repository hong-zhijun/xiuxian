import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import {
  MARKET_DAILY_TRADES,
  MARKET_HOLD_MS,
  findStock,
  marketFee,
  marketMinuteOf,
  seedNumberOf,
  stockPriceAt,
} from '../src/modules/game/market';
import { getMarket, getMarketChart, tradeStock } from '../src/modules/game/service';

import { dataOf, errorOf, TestClient } from './support/authClient';

/**
 * 0043 灵股：服务层 + D1 的集成测试。
 * 种子固定写进 market_state，期望价格用同一个 stockPriceAt 算；宗门结算拨到很晚（窗口为 0）。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await env.DB.prepare("INSERT INTO market_state (id, seed, created_at) VALUES ('main', 'test-seed', 0)").run();

const app = createApp({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
const NOW = Date.UTC(2026, 5, 1, 4, 0, 30);
const FAR = NOW + 30 * 86_400_000;
const SEED = seedNumberOf('test-seed');
const stock = findStock('tiangong')!;

let seq = 0;

async function makeSect(level: number): Promise<{ api: TestClient; userId: string; sectId: string }> {
  seq += 1;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.41.0.${seq}` });
  expect((await api.post('/api/v1/auth/register', { account: `stock-${seq}`, password: 'password-123456' })).status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `股民${seq}号` });
  const sectId = (dataOf(created) as Record<string, any>).state.sect.id as string;
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

describe('灵股', () => {
  it('3 级开放；面板价格与模型一致', async () => {
    const low = await makeSect(2);
    await expect(
      tradeStock(env.DB, low.userId, { stockId: 'tiangong', side: 'buy', shares: 1 }, NOW),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });

    const sect = await makeSect(3);
    const panel = await getMarket(env.DB, sect.userId, NOW);
    const view = panel.market.stocks.find((item) => item.id === 'tiangong')!;
    expect(view.price).toBe(stockPriceAt(SEED, stock, marketMinuteOf(NOW)));
    expect(panel.market.stocks).toHaveLength(6);
    expect(panel.market.tradesLeft).toBe(MARKET_DAILY_TRADES);

    const chart = await getMarketChart(env.DB, 'tiangong', '1h', NOW);
    expect(chart.candles).toHaveLength(60);
  });

  it('买入扣灵石含手续费；10 分钟内不能卖；之后卖出按服务端价格结算并记收益', async () => {
    const sect = await makeSect(5);
    const before = await stoneOf(sect.sectId);
    const buyPrice = stockPriceAt(SEED, stock, marketMinuteOf(NOW));
    const bought = await tradeStock(env.DB, sect.userId, { stockId: 'tiangong', side: 'buy', shares: 10 }, NOW);
    const amount = buyPrice * 10;
    expect(await stoneOf(sect.sectId)).toBe(before - amount - marketFee(amount));
    const holding = bought.market.stocks.find((item) => item.id === 'tiangong')!.holding!;
    expect(holding).toMatchObject({ shares: 10, cost: amount, sellableAt: NOW + MARKET_HOLD_MS });

    await expect(
      tradeStock(env.DB, sect.userId, { stockId: 'tiangong', side: 'sell', shares: 5 }, NOW + 60_000),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    await expect(
      tradeStock(env.DB, sect.userId, { stockId: 'tiangong', side: 'sell', shares: 11 }, NOW + MARKET_HOLD_MS),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });

    const sellAt = NOW + MARKET_HOLD_MS;
    const sellPrice = stockPriceAt(SEED, stock, marketMinuteOf(sellAt));
    const mid = await stoneOf(sect.sectId);
    const sold = await tradeStock(env.DB, sect.userId, { stockId: 'tiangong', side: 'sell', shares: 4 }, sellAt);
    const proceeds = sellPrice * 4 - marketFee(sellPrice * 4);
    expect(await stoneOf(sect.sectId)).toBe(mid + proceeds);
    expect(sold.result.profit).toBe(proceeds - Math.floor((amount * 4) / 10));
    expect(sold.market.stocks.find((item) => item.id === 'tiangong')!.holding!.shares).toBe(6);
    expect(sold.market.myProfit).toBe(sold.result.profit);
    expect(sold.market.ranks.some((rank) => rank.isMe)).toBe(true);
    expect(sold.market.tradesUsed).toBe(2);
  });

  it('持仓成本不超过灵石容量的 20%；每日 30 笔；接口参数校验', async () => {
    const sect = await makeSect(3);
    // 宗门 3 级灵石容量 10,000 → 每支上限 2,000 灵石
    const price = stockPriceAt(SEED, stock, marketMinuteOf(NOW));
    const tooMany = Math.floor(2_000_000 / price) + 1;
    await expect(
      tradeStock(env.DB, sect.userId, { stockId: 'tiangong', side: 'buy', shares: tooMany }, NOW),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });

    for (let index = 0; index < MARKET_DAILY_TRADES; index += 1) {
      await env.DB.prepare(
        `INSERT INTO stock_trades (id, sect_id, stock_id, side, shares, price, amount, fee, profit, created_at)
         VALUES (?, ?, 'yunlai', 'buy', 1, 1000, 1000, 3, 0, ?)`,
      )
        .bind(crypto.randomUUID(), sect.sectId, NOW - 1000)
        .run();
    }
    await expect(
      tradeStock(env.DB, sect.userId, { stockId: 'tiangong', side: 'buy', shares: 1 }, NOW),
    ).rejects.toMatchObject({ code: 'DAILY_LIMIT' });

    const bad = await sect.api.post('/api/v1/game/market/trade', { stockId: 'tiangong', side: 'short', shares: 1 });
    expect(errorOf(bad).code).toBe('VALIDATION_ERROR');
    const badChart = await sect.api.get('/api/v1/game/market/chart?stockId=tiangong&range=5y');
    expect(errorOf(badChart).code).toBe('VALIDATION_ERROR');
  });
});
