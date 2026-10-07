import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import {
  AUCTION_DURATION_MS,
  auctionFee,
  auctionMinPrice,
  auctionUnitFloor,
} from '../src/modules/game/auction';
import { BAG_CAPACITY } from '../src/modules/game/equipment';
import {
  bidAuction,
  buyoutAuction,
  cancelAuction,
  claimAuction,
  getAuction,
  getSectState,
  listAuctionItem,
  processAuctions,
  retractAuctionBid,
} from '../src/modules/game/service';

import { dataOf, errorOf, TestClient } from './support/authClient';

/**
 * 0040 拍卖行：服务层 + D1 的集成测试。
 *
 * 存储说明：本文件一份独立内存 D1，每个用例用独立账号 / 宗门。
 * 时间说明：service 入口显式收 `now`；宗门的 last_settled_at 拨到很晚（结算窗口为 0），
 * 余额断言只受被测逻辑影响。到期用 now + 24 小时。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;
const app = createApp({ logger: quietLogger });
const PASSWORD = 'password-123456';
const NOW = Date.UTC(2026, 5, 1, 4, 0);
const FAR = NOW + 10 * AUCTION_DURATION_MS;

let seq = 0;

interface SectFixture {
  api: TestClient;
  userId: string;
  sectId: string;
}

async function makeSect(prefix: string, level = 3, ip?: string): Promise<SectFixture> {
  seq += 1;
  const api = new TestClient(app, env, {
    'cf-connecting-ip': ip ?? `10.11.${Math.floor(seq / 250)}.${seq % 250}`,
  });
  const registered = await api.post('/api/v1/auth/register', { account: `${prefix}-${seq}`, password: PASSWORD });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `拍卖${seq}号` });
  expect(created.status).toBe(200);
  const sectId = (dataOf(created) as Record<string, any>).state.sect.id as string;
  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?').bind(sectId).first<{ user_id: string }>();
  // 结算拨到很晚：之后任何 now 的结算窗口都是 0。
  await env.DB.prepare('UPDATE sects SET level = ?, last_settled_at = ? WHERE id = ?').bind(level, FAR, sectId).run();
  await setBalance(sectId, 'spiritStone', 1_000_000_000);
  return { api, userId: row!.user_id, sectId };
}

async function setBalance(sectId: string, resourceId: string, balance: number): Promise<void> {
  await env.DB.prepare('UPDATE resource_balances SET balance = ? WHERE sect_id = ? AND resource_id = ?')
    .bind(balance, sectId, resourceId)
    .run();
}

async function balanceOf(sectId: string, resourceId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = ?')
    .bind(sectId, resourceId)
    .first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

async function pillCount(sectId: string, pillId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT quantity FROM pill_inventories WHERE sect_id = ? AND pill_id = ?')
    .bind(sectId, pillId)
    .first<{ quantity: number }>();
  return Number(row?.quantity ?? 0);
}

async function addEquipment(sectId: string, quality = 'treasure'): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO equipment (id, sect_id, disciple_id, slot, quality, name, main_attr, main_value,
        sub_attr, sub_value, source, created_at)
     VALUES (?, ?, NULL, 'weapon', ?, '测试宝剑', 'attack', 20, 'luck', 8, 'forge', ?)`,
  )
    .bind(id, sectId, quality, NOW)
    .run();
  return id;
}

async function bagCount(sectId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM equipment WHERE sect_id = ? AND disciple_id IS NULL')
    .bind(sectId)
    .first<{ cnt: number }>();
  return Number(row?.cnt ?? 0);
}

/** 上架 10 个玄铁（起拍 600、可选一口价），返回拍卖单 id。 */
async function listXuantie(seller: SectFixture, buyoutPrice?: number): Promise<string> {
  await setBalance(seller.sectId, 'xuantie', 50_000);
  const listed = await listAuctionItem(
    env.DB,
    seller.userId,
    { kind: 'resource', resourceId: 'xuantie', quantity: 10, startPrice: 600, ...(buyoutPrice === undefined ? {} : { buyoutPrice }) },
    NOW,
  );
  const lot = listed.auction.myLots.find((item) => item.status === 'active');
  expect(lot).toBeDefined();
  return lot!.id;
}

describe('拍卖行', () => {
  it('宗门 3 级开放；起拍价不低于成本的 20%', async () => {
    const low = await makeSect('lock', 2);
    await expect(
      listAuctionItem(env.DB, low.userId, { kind: 'resource', resourceId: 'xuantie', quantity: 1, startPrice: 100 }, NOW),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });

    const seller = await makeSect('floor');
    await setBalance(seller.sectId, 'xuantie', 10_000);
    const floor = auctionMinPrice('resource', 'xuantie', 5) / 1000;
    await expect(
      listAuctionItem(env.DB, seller.userId, { kind: 'resource', resourceId: 'xuantie', quantity: 5, startPrice: floor - 1 }, NOW),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // 一口价低于起拍价：拒绝
    await expect(
      listAuctionItem(
        env.DB,
        seller.userId,
        { kind: 'resource', resourceId: 'xuantie', quantity: 5, startPrice: floor + 10, buyoutPrice: floor },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // 功勋 / 药材不能拍：schema 放行，service 拒绝
    const herb = await seller.api.post('/api/v1/game/auction/list', {
      kind: 'resource',
      resourceId: 'herb',
      quantity: 1,
      startPrice: 100,
    });
    expect(errorOf(herb).code).toBe('VALIDATION_ERROR');
    expect(await balanceOf(seller.sectId, 'xuantie')).toBe(10_000);
  });

  it('上架托管 → 出价冻结 → 被超价退回 → 到期成交：卖家实得扣 10%，买家去待领取领', async () => {
    const seller = await makeSect('flow-s');
    const alice = await makeSect('flow-a');
    const bob = await makeSect('flow-b');
    const lotId = await listXuantie(seller);
    expect(await balanceOf(seller.sectId, 'xuantie')).toBe(40_000);

    // 卖家不能给自己出价；低于起拍价拒绝
    await expect(bidAuction(env.DB, seller.userId, { lotId, price: 600 }, NOW + 1)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });
    await expect(bidAuction(env.DB, alice.userId, { lotId, price: 599 }, NOW + 1)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    const aliceBefore = await balanceOf(alice.sectId, 'spiritStone');
    const first = await bidAuction(env.DB, alice.userId, { lotId, price: 600 }, NOW + 1);
    expect(first.auction.hall.find((lot) => lot.id === lotId)?.isLeading).toBe(true);
    expect(await balanceOf(alice.sectId, 'spiritStone')).toBe(aliceBefore - 600_000);
    // 领先者不能再加价；加价不足 5% 拒绝
    await expect(bidAuction(env.DB, alice.userId, { lotId, price: 700 }, NOW + 2)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });
    await expect(bidAuction(env.DB, bob.userId, { lotId, price: 629 }, NOW + 2)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    const bobBefore = await balanceOf(bob.sectId, 'spiritStone');
    await bidAuction(env.DB, bob.userId, { lotId, price: 630 }, NOW + 2);
    expect(await balanceOf(alice.sectId, 'spiritStone')).toBe(aliceBefore);
    expect(await balanceOf(bob.sectId, 'spiritStone')).toBe(bobBefore - 630_000);

    // 到期前定时任务什么都不做
    await processAuctions(env.DB, NOW + 1000);
    const sellerStone = await balanceOf(seller.sectId, 'spiritStone');
    await processAuctions(env.DB, NOW + AUCTION_DURATION_MS + 1);
    expect(await balanceOf(seller.sectId, 'spiritStone')).toBe(sellerStone + 630_000 - auctionFee(630_000));

    // 到期后不能再出价
    await expect(
      bidAuction(env.DB, alice.userId, { lotId, price: 800 }, NOW + AUCTION_DURATION_MS + 2),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });

    const synced = await getSectState(env.DB, bob.userId, NOW + AUCTION_DURATION_MS + 3);
    expect(synced?.auction.claimable).toBe(1);
    const xuantieBefore = await balanceOf(bob.sectId, 'xuantie');
    const claimed = await claimAuction(env.DB, bob.userId, { lotId }, NOW + AUCTION_DURATION_MS + 4);
    expect(claimed.auction.claimableCount).toBe(0);
    expect(await balanceOf(bob.sectId, 'xuantie')).toBe(xuantieBefore + 10_000);
    await expect(claimAuction(env.DB, bob.userId, { lotId }, NOW + AUCTION_DURATION_MS + 5)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });
  });

  it('一口价：当场交付、领先者退回、卖家当场入账；出价到一口价要求直接买', async () => {
    const seller = await makeSect('buy-s');
    const alice = await makeSect('buy-a');
    const bob = await makeSect('buy-b');
    const lotId = await listXuantie(seller, 1000);

    await expect(bidAuction(env.DB, alice.userId, { lotId, price: 1000 }, NOW + 1)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    const aliceBefore = await balanceOf(alice.sectId, 'spiritStone');
    await bidAuction(env.DB, alice.userId, { lotId, price: 700 }, NOW + 1);

    const sellerBefore = await balanceOf(seller.sectId, 'spiritStone');
    const bobStone = await balanceOf(bob.sectId, 'spiritStone');
    const bobXuantie = await balanceOf(bob.sectId, 'xuantie');
    const bought = await buyoutAuction(env.DB, bob.userId, { lotId }, NOW + 2);
    expect(bought.auction.myBids).toHaveLength(0);
    expect(await balanceOf(bob.sectId, 'spiritStone')).toBe(bobStone - 1_000_000);
    expect(await balanceOf(bob.sectId, 'xuantie')).toBe(bobXuantie + 10_000);
    expect(await balanceOf(alice.sectId, 'spiritStone')).toBe(aliceBefore);
    expect(await balanceOf(seller.sectId, 'spiritStone')).toBe(sellerBefore + 900_000);

    await expect(buyoutAuction(env.DB, alice.userId, { lotId }, NOW + 3)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });
  });

  it('流拍：卖家领回；撤回：没人出价时当场退回，有人出价就不能撤', async () => {
    const seller = await makeSect('exp-s');
    const buyer = await makeSect('exp-b');
    const unsold = await listXuantie(seller);
    await processAuctions(env.DB, NOW + AUCTION_DURATION_MS + 1);
    const before = await balanceOf(seller.sectId, 'xuantie');
    await claimAuction(env.DB, seller.userId, { lotId: unsold }, NOW + AUCTION_DURATION_MS + 2);
    expect(await balanceOf(seller.sectId, 'xuantie')).toBe(before + 10_000);

    const second = await listXuantie(seller);
    const third = await listXuantie(seller);
    await bidAuction(env.DB, buyer.userId, { lotId: third, price: 600 }, NOW + 1);
    await expect(cancelAuction(env.DB, seller.userId, { lotId: third }, NOW + 2)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });
    // 别人的单不能撤
    await expect(cancelAuction(env.DB, buyer.userId, { lotId: second }, NOW + 2)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const xuantieBefore = await balanceOf(seller.sectId, 'xuantie');
    await cancelAuction(env.DB, seller.userId, { lotId: second }, NOW + 3);
    expect(await balanceOf(seller.sectId, 'xuantie')).toBe(xuantieBefore + 10_000);
  });

  it('同一网络不能互相交易：同 IP / 同 IPv6 /64 拒绝出价与一口价，换网络正常', async () => {
    const seller = await makeSect('net-s');
    const buyer = await makeSect('net-b');
    await setBalance(seller.sectId, 'xuantie', 50_000);
    const listed = await listAuctionItem(
      env.DB,
      seller.userId,
      { kind: 'resource', resourceId: 'xuantie', quantity: 10, startPrice: 600, buyoutPrice: 1000 },
      NOW,
      '2408:8207:1851:a1c0::10',
    );
    const lotId = listed.auction.myLots[0]!.id;
    await expect(
      bidAuction(env.DB, buyer.userId, { lotId, price: 600 }, NOW + 1, '2408:8207:1851:a1c0:aaaa::2'),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    await expect(
      buyoutAuction(env.DB, buyer.userId, { lotId }, NOW + 1, '2408:8207:1851:a1c0::10'),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    // 拿不到来源时不拦；换一个网络正常出价
    await bidAuction(env.DB, buyer.userId, { lotId, price: 600 }, NOW + 2, '198.51.100.20');
    const row = await env.DB.prepare('SELECT seller_net_hash FROM auction_lots WHERE id = ?')
      .bind(lotId)
      .first<{ seller_net_hash: string | null }>();
    expect(row?.seller_net_hash).toMatch(/^[0-9a-f]{64}$/);

    // 走接口：两个宗门的请求带同一个 cf-connecting-ip
    const homeSeller = await makeSect('net-api-s', 3, '203.0.113.9');
    const homeBuyer = await makeSect('net-api-b', 3, '203.0.113.9');
    await setBalance(homeSeller.sectId, 'xuantie', 50_000);
    const viaApi = await homeSeller.api.post('/api/v1/game/auction/list', {
      kind: 'resource',
      resourceId: 'xuantie',
      quantity: 10,
      startPrice: 600,
    });
    expect(viaApi.status).toBe(200);
    const apiLotId = (dataOf(viaApi) as Record<string, any>).auction.myLots[0].id as string;
    const blocked = await homeBuyer.api.post('/api/v1/game/auction/bid', { lotId: apiLotId, price: 600 });
    expect(errorOf(blocked).code).toBe('INVALID_STATUS');
  });

  it('撤销出价：领先者退回 95%、5% 赔给卖家，这一单回到无人出价；别人不能撤；结束前 2 小时内不能撤', async () => {
    const seller = await makeSect('rt-s');
    const alice = await makeSect('rt-a');
    const bob = await makeSect('rt-b');
    const lotId = await listXuantie(seller);
    await bidAuction(env.DB, alice.userId, { lotId, price: 600 }, NOW + 1);
    const bobBefore = await balanceOf(bob.sectId, 'spiritStone');
    const leading = await bidAuction(env.DB, bob.userId, { lotId, price: 700 }, NOW + 2);
    const bobLot = leading.auction.hall.find((lot) => lot.id === lotId)!;
    expect(bobLot.retractable).toBe(true);
    expect(bobLot.retractPenalty).toBe(35_000);

    // 被超价的人没有可撤的出价
    await expect(retractAuctionBid(env.DB, alice.userId, { lotId }, NOW + 3)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });

    const sellerBefore = await balanceOf(seller.sectId, 'spiritStone');
    const retracted = await retractAuctionBid(env.DB, bob.userId, { lotId }, NOW + 3);
    expect(await balanceOf(bob.sectId, 'spiritStone')).toBe(bobBefore - 35_000);
    expect(await balanceOf(seller.sectId, 'spiritStone')).toBe(sellerBefore + 35_000);
    const lot = retracted.auction.hall.find((item) => item.id === lotId)!;
    expect(lot).toMatchObject({ currentPrice: null, leaderName: null, bidCount: 0, minNextBid: 600_000 });
    expect(retracted.auction.myBids).toHaveLength(0);

    // 回到起拍价，别人可以重新出价；快到期时不能撤
    await bidAuction(env.DB, alice.userId, { lotId, price: 600 }, NOW + 4);
    await expect(
      retractAuctionBid(env.DB, alice.userId, { lotId }, NOW + AUCTION_DURATION_MS - 60_000),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  it('装备：上架即离开背包；一口价时买家背包满拒绝，腾出位置后买到、按快照入背包', async () => {
    const seller = await makeSect('eq-s');
    const buyer = await makeSect('eq-b');
    const equipmentId = await addEquipment(seller.sectId);
    const floor = auctionUnitFloor('equipment', 'treasure') / 1000;
    const listed = await listAuctionItem(
      env.DB,
      seller.userId,
      { kind: 'equipment', equipmentId, startPrice: floor, buyoutPrice: floor + 100 },
      NOW,
    );
    expect(await bagCount(seller.sectId)).toBe(0);
    const lot = listed.auction.myLots[0]!;
    expect(lot.equipment?.qualityName).toBe('宝品');
    expect(lot.equipment?.mainAttrName).toBe('攻击');

    for (let index = 0; index < BAG_CAPACITY; index += 1) await addEquipment(buyer.sectId, 'common');
    await expect(buyoutAuction(env.DB, buyer.userId, { lotId: lot.id }, NOW + 1)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });
    await env.DB.prepare('DELETE FROM equipment WHERE sect_id = ?').bind(buyer.sectId).run();
    await buyoutAuction(env.DB, buyer.userId, { lotId: lot.id }, NOW + 2);
    const got = await env.DB.prepare('SELECT quality, name, main_value, sub_attr FROM equipment WHERE sect_id = ?')
      .bind(buyer.sectId)
      .all<{ quality: string; name: string; main_value: number; sub_attr: string }>();
    expect(got.results).toEqual([{ quality: 'treasure', name: '测试宝剑', main_value: 20, sub_attr: 'luck' }]);
  });

  it('丹药：上架扣库存，拍下后领取入丹库', async () => {
    const seller = await makeSect('pill-s');
    const buyer = await makeSect('pill-b');
    await env.DB.prepare(
      'INSERT INTO pill_inventories (id, sect_id, pill_id, quantity, updated_at) VALUES (?, ?, ?, 5, ?)',
    )
      .bind(crypto.randomUUID(), seller.sectId, 'cultivationPill', NOW)
      .run();
    const panel = await getAuction(env.DB, seller.userId, NOW);
    expect(panel.auction.listable.pills).toEqual([
      expect.objectContaining({ pillId: 'cultivationPill', quantity: 5 }),
    ]);
    const price = auctionMinPrice('pill', 'cultivationPill', 3) / 1000;
    const listed = await listAuctionItem(
      env.DB,
      seller.userId,
      { kind: 'pill', pillId: 'cultivationPill', quantity: 3, startPrice: price },
      NOW,
    );
    expect(await pillCount(seller.sectId, 'cultivationPill')).toBe(2);
    const lotId = listed.auction.myLots[0]!.id;
    await bidAuction(env.DB, buyer.userId, { lotId, price }, NOW + 1);
    await claimAuction(env.DB, buyer.userId, { lotId }, NOW + AUCTION_DURATION_MS + 1);
    expect(await pillCount(buyer.sectId, 'cultivationPill')).toBe(3);
  });
});
