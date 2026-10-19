import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { TechniqueRepository } from '../src/modules/game/repository';
import { buyTechniqueScrolls, getTechniqueLibrary, upgradeBuilding } from '../src/modules/game/service';

import { dataOf, errorOf, TestClient } from './support/authClient';

/**
 * 0069 功法商店 + 藏经阁扩建：服务层 + D1 的集成测试（藏经阁开放条件、每日限量与跨天恢复、同品阶共用额度、
 * 天阶不卖、灵石不足、并发双击、路由校验），以及藏经阁 6～10 级的宗门等级门槛、分档消耗与满级拒绝。
 *
 * 存储说明：与 technique.test.ts 相同 —— 独立内存 D1，没有逐用例回滚；每个用例用独立账号 / 宗门，断言按宗门 id 定界。
 * 时间说明：service 入口显式收 now；宗门的 last_settled_at 拨到 now（结算窗口为 0），跨天用例把结算时间一并拨到新的 now。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;
const app = createApp({ logger: quietLogger });
const PASSWORD = 'password-123456';
const NOW = Date.UTC(2026, 9, 19, 4, 0); // UTC+8 当天 12:00
const DAY_MS = 24 * 3_600_000;

let seq = 0;

interface SectFixture {
  api: TestClient;
  userId: string;
  sectId: string;
}

async function makeSect(prefix: string): Promise<SectFixture> {
  seq += 1;
  const api = new TestClient(app, env, {
    'cf-connecting-ip': `10.67.${Math.floor(seq / 250)}.${seq % 250}`,
  });
  const registered = await api.post('/api/v1/auth/register', { account: `${prefix}-${seq}`, password: PASSWORD });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `商店${seq}号` });
  expect(created.status).toBe(200);
  const sectId = (dataOf(created) as Record<string, any>).state.sect.id as string;
  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?').bind(sectId).first<{ user_id: string }>();
  await env.DB.prepare('UPDATE sects SET last_settled_at = ?, level = 2 WHERE id = ?').bind(NOW, sectId).run();
  return { api, userId: row!.user_id, sectId };
}

/** 藏经阁建到指定等级（新宗门的建筑行可能不存在，缺行就补一行）。 */
async function buildScripture(sectId: string, level = 1): Promise<void> {
  const updated = await env.DB.prepare("UPDATE buildings SET level = ? WHERE sect_id = ? AND def_id = 'scriptureLibrary'")
    .bind(level, sectId)
    .run();
  if ((updated.meta?.changes ?? 0) === 0) {
    await env.DB.prepare(
      "INSERT INTO buildings (id, sect_id, def_id, level, created_at) VALUES (?, ?, 'scriptureLibrary', ?, ?)",
    )
      .bind(crypto.randomUUID(), sectId, level, NOW)
      .run();
  }
}

async function balanceOf(sectId: string, resourceId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = ?')
    .bind(sectId, resourceId)
    .first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

async function setBalance(sectId: string, resourceId: string, balance: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO resource_balances (id, sect_id, resource_id, balance, remainder, updated_at) VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT (sect_id, resource_id) DO UPDATE SET balance = excluded.balance`,
  )
    .bind(crypto.randomUUID(), sectId, resourceId, balance, NOW)
    .run();
}

/** 把结算时间拨到 at（之后的命令结算窗口为 0，余额断言只受购买影响）。 */
async function settleAt(sectId: string, at: number): Promise<void> {
  await env.DB.prepare('UPDATE sects SET last_settled_at = ? WHERE id = ?').bind(at, sectId).run();
}

describe('功法商店 · 开放与额度', () => {
  it('藏经阁 0 级：商店未开放，购买被拒', async () => {
    const sect = await makeSect('shop-locked');
    const library = await getTechniqueLibrary(env.DB, sect.userId, NOW);
    expect(library.library.shop).toMatchObject({ unlocked: false, scriptureLevel: 0 });
    await expect(
      buyTechniqueScrolls(env.DB, sect.userId, { techniqueId: 'qingfeng', quantity: 1 }, NOW),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  it('1 级买玄阶 2 张：扣 120 灵石、残卷 +2，额度用完后再买被拒且什么都不扣', async () => {
    const sect = await makeSect('shop-xuan');
    await buildScripture(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 1_000_000);
    const before = await balanceOf(sect.sectId, 'spiritStone');

    const bought = await buyTechniqueScrolls(env.DB, sect.userId, { techniqueId: 'qingfeng', quantity: 2 }, NOW);
    expect(before - (await balanceOf(sect.sectId, 'spiritStone'))).toBe(120_000);
    expect(bought.result.message).toBe('购得青锋剑诀残卷 ×2，花费 120 灵石');
    expect(bought.library.items.find((item) => item.id === 'qingfeng')).toMatchObject({ learned: false, scrolls: 2 });
    expect(bought.library.shop.tiers.find((tier) => tier.tier === 'xuan')).toMatchObject({
      quota: 2,
      bought: 2,
      remaining: 0,
      price: 60_000,
    });
    // 2 级与 1 级额度相同，提示直接指向额度变多的 3 级。
    expect(bought.library.shop.nextLevelHint).toBe('藏经阁 3 级：玄阶每日 3 张、地阶每日 1 张');
    const rows = await new TechniqueRepository(env.DB).findBySectId(sect.sectId);
    expect(rows.find((item) => item.technique_id === 'qingfeng')?.scrolls).toBe(2);

    const afterFirst = await balanceOf(sect.sectId, 'spiritStone');
    await expect(
      buyTechniqueScrolls(env.DB, sect.userId, { techniqueId: 'jingang', quantity: 1 }, NOW),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS', message: '今日玄阶残卷已售罄，明日再来' });
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(afterFirst);
  });

  it('数量超过今日剩余：报出还可购买的张数，什么都不扣', async () => {
    const sect = await makeSect('shop-partial');
    await buildScripture(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 1_000_000);
    await buyTechniqueScrolls(env.DB, sect.userId, { techniqueId: 'qingfeng', quantity: 1 }, NOW);
    const before = await balanceOf(sect.sectId, 'spiritStone');
    await expect(
      buyTechniqueScrolls(env.DB, sect.userId, { techniqueId: 'qingfeng', quantity: 2 }, NOW),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS', message: '今日玄阶残卷还可购买 1 张' });
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(before);
  });

  it('地阶在 1 级被拒（藏经阁 3 级起才出售）；天阶任何等级都不卖', async () => {
    const sect = await makeSect('shop-di');
    await buildScripture(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 1_000_000);
    await expect(
      buyTechniqueScrolls(env.DB, sect.userId, { techniqueId: 'taiyi', quantity: 1 }, NOW),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS', message: '藏经阁 3 级起才出售地阶残卷' });
    await expect(
      buyTechniqueScrolls(env.DB, sect.userId, { techniqueId: 'pojia', quantity: 1 }, NOW),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS', message: '天阶残卷不在功法商店出售' });

    // 藏经阁升到 3 级后地阶开放（额度 1 张，单价 180 灵石）。
    await buildScripture(sect.sectId, 3);
    const bought = await buyTechniqueScrolls(env.DB, sect.userId, { techniqueId: 'taiyi', quantity: 1 }, NOW);
    expect(bought.library.shop.tiers.find((tier) => tier.tier === 'di')).toMatchObject({ quota: 1, remaining: 0 });
    expect(bought.result.message).toBe('购得太乙剑诀残卷 ×1，花费 180 灵石');
  });

  it('同品阶的各门功法共用额度；第二天（0 点后）额度恢复', async () => {
    const sect = await makeSect('shop-daily');
    await buildScripture(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 10_000_000);
    await buyTechniqueScrolls(env.DB, sect.userId, { techniqueId: 'qingfeng', quantity: 2 }, NOW);
    await expect(
      buyTechniqueScrolls(env.DB, sect.userId, { techniqueId: 'guiying', quantity: 1 }, NOW),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });

    const nextDay = NOW + DAY_MS;
    await settleAt(sect.sectId, nextDay);
    const library = await getTechniqueLibrary(env.DB, sect.userId, nextDay);
    expect(library.library.shop.tiers.find((tier) => tier.tier === 'xuan')).toMatchObject({ bought: 0, remaining: 2 });
    const again = await buyTechniqueScrolls(env.DB, sect.userId, { techniqueId: 'guiying', quantity: 2 }, nextDay);
    expect(again.library.items.find((item) => item.id === 'guiying')).toMatchObject({ scrolls: 2 });
  });

  it('同时点两次：额度只被占用一次（并发守卫挡住超卖，只扣一次灵石）', async () => {
    const sect = await makeSect('shop-race');
    await buildScripture(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 1_000_000);
    const results = await Promise.allSettled([
      buyTechniqueScrolls(env.DB, sect.userId, { techniqueId: 'qingfeng', quantity: 2 }, NOW),
      buyTechniqueScrolls(env.DB, sect.userId, { techniqueId: 'qingfeng', quantity: 2 }, NOW),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(1_000_000 - 120_000);
    const rows = await new TechniqueRepository(env.DB).findBySectId(sect.sectId);
    expect(rows.find((item) => item.technique_id === 'qingfeng')?.scrolls).toBe(2);
  });
});

describe('功法商店 · 路由', () => {
  it('路由：张数越界、多余字段一律 400', async () => {
    const sect = await makeSect('shop-route-bad');
    const extra = await sect.api.post('/api/v1/game/techniques/shop/buy', {
      techniqueId: 'qingfeng',
      quantity: 1,
      unexpected: true,
    });
    expect(extra.status).toBe(400);
    const zero = await sect.api.post('/api/v1/game/techniques/shop/buy', { techniqueId: 'qingfeng', quantity: 0 });
    expect(zero.status).toBe(400);
    expect(errorOf(zero).code).toBe('VALIDATION_ERROR');
    const tooMany = await sect.api.post('/api/v1/game/techniques/shop/buy', { techniqueId: 'qingfeng', quantity: 21 });
    expect(tooMany.status).toBe(400);
  });

  it('路由：购买成功返回 state / library / result，library 带商店状态', async () => {
    const sect = await makeSect('shop-route-ok');
    await buildScripture(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 1_000_000);
    const response = await sect.api.post('/api/v1/game/techniques/shop/buy', { techniqueId: 'guiying', quantity: 1 });
    expect(response.status).toBe(200);
    const data = dataOf(response) as Record<string, any>;
    expect(data.result.message).toBe('购得鬼影步残卷 ×1，花费 60 灵石');
    expect(data.library.shop.tiers.find((tier: Record<string, any>) => tier.tier === 'xuan')).toMatchObject({
      bought: 1,
      remaining: 1,
    });
    expect(data.state.sect.id).toBe(sect.sectId);
  });
});

describe('藏经阁 6～10 级', () => {
  it('宗门等级不够拒绝；够了按分档扣费；10 级封顶', async () => {
    const sect = await makeSect('scripture-high');
    await buildScripture(sect.sectId, 5);
    await setBalance(sect.sectId, 'spiritStone', 50_000_000);
    await setBalance(sect.sectId, 'herb', 30_000_000);
    await setBalance(sect.sectId, 'xuantie', 100_000);
    await expect(upgradeBuilding(env.DB, sect.userId, 'scriptureLibrary', NOW)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });

    await env.DB.prepare('UPDATE sects SET level = 10 WHERE id = ?').bind(sect.sectId).run();
    const stone = await balanceOf(sect.sectId, 'spiritStone');
    const herb = await balanceOf(sect.sectId, 'herb');
    const level6 = await upgradeBuilding(env.DB, sect.userId, 'scriptureLibrary', NOW);
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(stone - 1_500_000);
    expect(await balanceOf(sect.sectId, 'herb')).toBe(herb - 600_000);
    expect(level6.buildings.find((building) => building.defId === 'scriptureLibrary')).toMatchObject({
      level: 6,
      maxLevel: 10,
    });

    let state = level6;
    for (let level = 7; level <= 10; level += 1) {
      state = await upgradeBuilding(env.DB, sect.userId, 'scriptureLibrary', NOW);
    }
    expect(state.buildings.find((building) => building.defId === 'scriptureLibrary')?.level).toBe(10);
    // 9、10 级各需玄铁 10,000 与 20,000（最小单位）。
    expect(await balanceOf(sect.sectId, 'xuantie')).toBe(100_000 - 30_000);
    await expect(upgradeBuilding(env.DB, sect.userId, 'scriptureLibrary', NOW)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });
  });
});
