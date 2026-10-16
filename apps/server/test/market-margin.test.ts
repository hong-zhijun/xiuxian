import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import {
  findStock,
  marketFee,
  marketMinuteOf,
  marginRequired,
  seedNumberOf,
  stockPriceAt,
} from '../src/modules/game/market';
import { getMarket, processStockMarginPositions, tradeStockMargin } from '../src/modules/game/service';
import { dataOf, TestClient } from './support/authClient';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await env.DB.prepare("INSERT INTO market_state (id, seed, created_at) VALUES ('main', 'margin-test-seed', 0)").run();

const app = createApp({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
const NOW = Date.UTC(2026, 5, 1, 4, 0, 30);
const FAR = NOW + 30 * 86_400_000;
const SEED = seedNumberOf('margin-test-seed');
const STOCK = findStock('tiangong')!;
let seq = 0;

async function makeSect(): Promise<{ api: TestClient; userId: string; sectId: string }> {
  seq += 1;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.42.0.${seq}` });
  expect((await api.post('/api/v1/auth/register', { account: `margin-${seq}`, password: 'password-123456' })).status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `合约宗${seq}号` });
  const sectId = (dataOf(created) as Record<string, any>).state.sect.id as string;
  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?').bind(sectId).first<{ user_id: string }>();
  await env.DB.prepare('UPDATE sects SET level = 5, last_settled_at = ? WHERE id = ?').bind(FAR, sectId).run();
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

describe('灵股保证金合约', () => {
  it('开多后可平仓，保证金和手续费按服务端价格结算', async () => {
    const sect = await makeSect();
    const price = stockPriceAt(SEED, STOCK, marketMinuteOf(NOW));
    const notional = price * 10;
    const margin = marginRequired(notional);
    const fee = marketFee(notional);
    const before = await stoneOf(sect.sectId);

    const opened = await tradeStockMargin(
      env.DB,
      sect.userId,
      { stockId: STOCK.id, action: 'open', side: 'long', shares: 10 },
      NOW,
    );
    expect(opened.result.side).toBe('long');
    expect(opened.result.margin).toBe(margin);
    expect(await stoneOf(sect.sectId)).toBe(before - margin - fee);
    expect(opened.market.stocks.find((stock) => stock.id === STOCK.id)?.marginPosition).toMatchObject({
      side: 'long',
      shares: 10,
      entryPrice: price,
      margin,
    });

    const closed = await tradeStockMargin(
      env.DB,
      sect.userId,
      { stockId: STOCK.id, action: 'close', shares: 10 },
      NOW,
    );
    expect(closed.result.action).toBe('close');
    expect(closed.result.pnl).toBe(-fee);
    expect(await stoneOf(sect.sectId)).toBe(before - fee - fee);
    expect(closed.market.stocks.find((stock) => stock.id === STOCK.id)?.marginPosition).toBeNull();
  });

  it('开空与开多共用每日人工成交额度', async () => {
    const sect = await makeSect();
    const opened = await tradeStockMargin(
      env.DB,
      sect.userId,
      { stockId: STOCK.id, action: 'open', side: 'short', shares: 2 },
      NOW,
    );
    expect(opened.result.side).toBe('short');
    expect(opened.market.tradesUsed).toBe(1);
    const position = await env.DB.prepare('SELECT side, shares FROM stock_margin_positions WHERE sect_id = ? AND stock_id = ?')
      .bind(sect.sectId, STOCK.id)
      .first<{ side: string; shares: number }>();
    expect(position).toMatchObject({ side: 'short', shares: 2 });
  });

  it('行情分钟越过强平线时自动爆仓，系统爆仓不占人工额度', async () => {
    const sect = await makeSect();
    const price = stockPriceAt(SEED, STOCK, marketMinuteOf(NOW));
    const margin = 10_000;
    await env.DB.prepare(
      `INSERT INTO stock_margin_positions
        (sect_id, stock_id, side, shares, entry_price, margin, leverage, liquidation_price, opened_at, checked_minute, version, updated_at)
       VALUES (?, ?, 'long', 1, ?, ?, 5, ?, ?, ?, 0, ?)`,
    )
      .bind(sect.sectId, STOCK.id, price, margin, price, NOW, marketMinuteOf(NOW) - 1, NOW)
      .run();
    const before = await stoneOf(sect.sectId);

    await processStockMarginPositions(env.DB, NOW);

    const position = await env.DB.prepare('SELECT 1 AS present FROM stock_margin_positions WHERE sect_id = ? AND stock_id = ?')
      .bind(sect.sectId, STOCK.id)
      .first();
    expect(position).toBeNull();
    const trade = await env.DB.prepare(
      "SELECT action, pnl FROM stock_margin_trades WHERE sect_id = ? AND stock_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(sect.sectId, STOCK.id)
      .first<{ action: string; pnl: number }>();
    expect(trade).toMatchObject({ action: 'liquidate' });
    expect(await stoneOf(sect.sectId)).toBe(before + Math.max(0, margin - marketFee(price)));
    const panel = await getMarket(env.DB, sect.userId, NOW);
    expect(panel.market.tradesUsed).toBe(0);
  });
});
