import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { MERCHANT_STAY_MS } from '../src/modules/game/auctionMerchant';
import { AuctionRepository } from '../src/modules/game/repository';
import {
  bidAuction, buyoutAuction, cancelAuction, claimAuction, getAuction, getHub,
  processAuctionMerchant, processAuctions, retractAuctionBid,
} from '../src/modules/game/service';
import { dataOf, TestClient } from './support/authClient';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
const app = createApp({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
const NOW = Date.UTC(2026, 9, 14, 8);
const repo = new AuctionRepository(env.DB);
let seq = 0;

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM auction_bids WHERE lot_id IN (SELECT id FROM auction_lots WHERE merchant_visit_id IS NOT NULL)').run();
  await env.DB.prepare('DELETE FROM auction_lots WHERE merchant_visit_id IS NOT NULL').run();
  await env.DB.prepare("DELETE FROM chat_messages WHERE content LIKE '【游商到访】%'").run();
  await env.DB.prepare('UPDATE auction_merchant_state SET version = 0, next_arrival_at = ?, visit_id = NULL, arrived_at = NULL, leaves_at = NULL WHERE id = 1')
    .bind(NOW).run();
});

async function buyer() {
  seq += 1;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.59.0.${seq}` });
  expect((await api.post('/api/v1/auth/register', { account: `merchant-${seq}`, password: 'password-123456' })).status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `游商${seq}宗` });
  const sectId = (dataOf(created) as { state: { sect: { id: string } } }).state.sect.id;
  await env.DB.prepare('UPDATE sects SET level = 3, last_settled_at = ? WHERE id = ?')
    .bind(NOW + 30 * 86_400_000, sectId).run();
  await env.DB.prepare("UPDATE resource_balances SET balance = 10000000 WHERE sect_id = ? AND resource_id = 'spiritStone'")
    .bind(sectId).run();
  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?').bind(sectId).first<{ user_id: string }>();
  return { userId: row!.user_id, sectId };
}

async function balance(sectId: string, resource = 'spiritStone') {
  return Number((await env.DB.prepare('SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = ?')
    .bind(sectId, resource).first<{ balance: number }>())?.balance ?? 0);
}

describe('随机游商', () => {
  it('未到时间不上架；并发到访仅生成一批货和一条公告，刷新不重抽，下一次到访随机在离开后 2～6 小时', async () => {
    const fixture = await buyer();
    await processAuctionMerchant(env.DB, NOW - 1, () => 0);
    expect(await repo.merchantStock(NOW)).toBe(0);
    await Promise.all(Array.from({ length: 4 }, () => processAuctionMerchant(env.DB, NOW, () => 0)));
    const first = await getAuction(env.DB, fixture.userId, NOW);
    expect(first.auction.merchant).toMatchObject({ present: true, remainingLots: 8, leavesAt: NOW + MERCHANT_STAY_MS });
    expect(first.auction.hall).toHaveLength(8);
    expect(first.auction.hall.every((lot) => lot.isSystem && !lot.isMine)).toBe(true);
    const announcements = await env.DB.prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE content LIKE '【游商到访】%'")
      .first<{ count: number }>();
    expect(announcements?.count).toBe(1);
    const second = await getAuction(env.DB, fixture.userId, NOW + 1000);
    expect(second.auction.hall.map((lot) => lot.id)).toEqual(first.auction.hall.map((lot) => lot.id));
    expect((await getHub(env.DB, fixture.userId, NOW)).auction.merchantStock).toBe(8);
    const state = await repo.merchantState();
    expect(state!.next_arrival_at).toBe(NOW + MERCHANT_STAY_MS + 2 * 3_600_000);
    await processAuctions(env.DB, NOW + MERCHANT_STAY_MS);
    const absent = await getAuction(env.DB, fixture.userId, NOW + MERCHANT_STAY_MS);
    expect(absent.auction.merchant.present).toBe(false);
    expect(absent.auction.hall).toHaveLength(0);
    expect(absent.auction.claimableCount).toBe(0);
    await processAuctionMerchant(env.DB, Number(state!.next_arrival_at), () => 0.999);
    expect(await repo.merchantStock(Number(state!.next_arrival_at))).toBe(12);
    const nextState = await repo.merchantState();
    expect(nextState!.next_arrival_at).toBe(Number(state!.next_arrival_at) + MERCHANT_STAY_MS + 6 * 3_600_000);
  });

  it('一口价交付所有品质装备，材料按数量入账；不生成假宗门或系统灵石余额', async () => {
    const fixture = await buyer();
    await env.DB.prepare("UPDATE resource_balances SET balance = 20000000 WHERE sect_id = ? AND resource_id = 'spiritStone'")
      .bind(fixture.sectId).run();
    const userCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>();
    for (const roll of [0, 0.3, 0.6, 0.9]) {
      await env.DB.prepare('UPDATE auction_merchant_state SET next_arrival_at = ? WHERE id = 1').bind(NOW).run();
      await processAuctionMerchant(env.DB, NOW, () => roll);
      const lots = await repo.listActive(NOW, 200);
      const lot = lots.find((item) => item.item_id === (roll === 0 ? 'common' : roll === 0.3 ? 'spirit' : roll === 0.6 ? 'treasure' : 'immortal'))!;
      const before = await balance(fixture.sectId);
      await buyoutAuction(env.DB, fixture.userId, { lotId: lot.id }, NOW);
      expect(await balance(fixture.sectId)).toBe(before - Number(lot.buyout_price));
      const equipment = await env.DB.prepare('SELECT quality, name, source FROM equipment WHERE sect_id = ? ORDER BY rowid DESC LIMIT 1')
        .bind(fixture.sectId).first<{ quality: string; name: string; source: string }>();
      expect(equipment).toMatchObject({ quality: lot.item_id, name: lot.item_name, source: 'merchant' });
    }
    const lots = await repo.listActive(NOW, 200);
    for (const resource of ['xuantie', 'shenmu']) {
      const lot = lots.find((item) => item.item_id === resource)!;
      const before = await balance(fixture.sectId, resource);
      await buyoutAuction(env.DB, fixture.userId, { lotId: lot.id }, NOW);
      expect(await balance(fixture.sectId, resource)).toBe(before + Number(lot.quantity) * 1000);
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>())?.count).toBe(userCount?.count);
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('竞价超价退款、撤标回收违约金，最终到期只交付一次；游商不能被玩家下架', async () => {
    const alice = await buyer();
    const bob = await buyer();
    await processAuctionMerchant(env.DB, NOW, () => 0);
    const lot = (await repo.listActive(NOW, 200)).find((item) => item.kind === 'resource')!;
    const price = Number(lot.start_price) / 1000;
    await expect(cancelAuction(env.DB, alice.userId, { lotId: lot.id }, NOW)).rejects.toThrow('拍卖单不存在');
    await bidAuction(env.DB, alice.userId, { lotId: lot.id, price }, NOW);
    await bidAuction(env.DB, bob.userId, { lotId: lot.id, price: price + 10 }, NOW + 1000);
    expect(await balance(alice.sectId)).toBe(10_000_000);
    await retractAuctionBid(env.DB, bob.userId, { lotId: lot.id }, NOW + 2000);
    expect(await balance(bob.sectId)).toBe(10_000_000 - Math.floor((price + 10) * 1000 * 0.05));
    await bidAuction(env.DB, alice.userId, { lotId: lot.id, price }, NOW + 3000);
    const materialBefore = await balance(alice.sectId, lot.item_id);
    await Promise.all([processAuctions(env.DB, NOW + MERCHANT_STAY_MS), processAuctions(env.DB, NOW + MERCHANT_STAY_MS)]);
    expect((await repo.findById(lot.id))?.status).toBe('sold');
    await claimAuction(env.DB, alice.userId, { lotId: lot.id }, NOW + MERCHANT_STAY_MS);
    expect(await balance(alice.sectId, lot.item_id)).toBe(materialBefore + Number(lot.quantity) * 1000);
    await expect(claimAuction(env.DB, alice.userId, { lotId: lot.id }, NOW + MERCHANT_STAY_MS)).rejects.toThrow();
  });

  it('两人同时抢购只成交一次，败者不扣钱；自己的已冻结出价可抵一口价', async () => {
    const alice = await buyer();
    const bob = await buyer();
    await processAuctionMerchant(env.DB, NOW, () => 0);
    const lots = await repo.listActive(NOW, 200);
    const lot = lots.find((item) => item.kind === 'equipment')!;
    const results = await Promise.allSettled([
      buyoutAuction(env.DB, alice.userId, { lotId: lot.id }, NOW),
      buyoutAuction(env.DB, bob.userId, { lotId: lot.id }, NOW),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await balance(alice.sectId) + await balance(bob.sectId)).toBe(20_000_000 - Number(lot.buyout_price));
    const other = lots.find((item) => item.kind === 'resource')!;
    await env.DB.prepare("UPDATE resource_balances SET balance = ? WHERE sect_id = ? AND resource_id = 'spiritStone'")
      .bind(other.buyout_price, alice.sectId).run();
    await bidAuction(env.DB, alice.userId, { lotId: other.id, price: Number(other.start_price) / 1000 }, NOW);
    await buyoutAuction(env.DB, alice.userId, { lotId: other.id }, NOW);
    expect(await balance(alice.sectId)).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM mutation_guards').first<{ count: number }>())?.count).toBe(0);
  });
});
