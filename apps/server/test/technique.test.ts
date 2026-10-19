import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { buyoutAuction, getAuction, getTechniqueLibrary, learnTechnique, processAuctionMerchant, setDiscipleTechnique, upgradeTechnique } from '../src/modules/game/service';
import { TechniqueRepository } from '../src/modules/game/repository';
import { techniqueProficiencyBp } from '../src/modules/game/techniques';

import { dataOf, errorOf, TestClient } from './support/authClient';

/**
 * 0066 功法：服务层 + D1 的集成测试（藏经阁开放条件、收录 / 参悟消耗、主修更换的熟练度、镇妖塔胜率预估、
 * 商人残卷交付）。
 *
 * 存储说明：本文件一份独立内存 D1，没有逐用例回滚 —— 每个用例用独立账号 / 宗门，断言按宗门 id 定界。
 * 时间说明：service 入口显式收 `now`；宗门的 last_settled_at 拨到 now（结算窗口为 0）。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;
const app = createApp({ logger: quietLogger });
const PASSWORD = 'password-123456';
const NOW = Date.UTC(2026, 9, 19, 4, 0); // UTC+8 当天 12:00
const HOUR_MS = 3_600_000;

let seq = 0;

interface SectFixture {
  api: TestClient;
  userId: string;
  sectId: string;
  discipleIds: string[];
}

async function makeSect(prefix: string, options: { strong?: boolean } = {}): Promise<SectFixture> {
  seq += 1;
  const api = new TestClient(app, env, {
    'cf-connecting-ip': `10.66.${Math.floor(seq / 250)}.${seq % 250}`,
  });
  const registered = await api.post('/api/v1/auth/register', { account: `${prefix}-${seq}`, password: PASSWORD });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `功法${seq}号` });
  expect(created.status).toBe(200);
  const sectId = (dataOf(created) as Record<string, any>).state.sect.id as string;
  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?').bind(sectId).first<{ user_id: string }>();

  for (let index = 0; index < 5; index += 1) {
    await env.DB.prepare(
      `INSERT INTO disciples (id, sect_id, name, gender, aptitude, attack, defense, speed, talent,
          realm_id, stage, cultivation, cultivation_remainder, assignment, injured_until, body_tempering_count, created_at)
       VALUES (?, ?, ?, 'male', 50, 50, 50, 50, 'none', 'qiRefining', 1, 0, 0, 'idle', NULL, 0, ?)`,
    )
      .bind(crypto.randomUUID(), sectId, `功法${seq}徒${index}`, NOW)
      .run();
  }
  if (options.strong === true) {
    await env.DB.prepare(
      `UPDATE disciples SET realm_id = 'tribulation', stage = 3, attack = 100, defense = 100, speed = 100, luck = 100, physique = 100 WHERE sect_id = ?`,
    )
      .bind(sectId)
      .run();
  }
  await env.DB.prepare('UPDATE sects SET last_settled_at = ?, level = 2 WHERE id = ?').bind(NOW, sectId).run();
  const ids = await env.DB.prepare('SELECT id FROM disciples WHERE sect_id = ? ORDER BY created_at, id')
    .bind(sectId)
    .all<{ id: string }>();
  return { api, userId: row!.user_id, sectId, discipleIds: ids.results.slice(0, 5).map((item) => item.id) };
}

/** 藏经阁建到 1 级（新宗门的建筑行可能不存在，缺行就补一行）。 */
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

async function setScrolls(sectId: string, techniqueId: string, scrolls: number, level = 0): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sect_techniques (sect_id, technique_id, level, scrolls) VALUES (?, ?, ?, ?)
     ON CONFLICT (sect_id, technique_id) DO UPDATE SET level = excluded.level, scrolls = excluded.scrolls`,
  )
    .bind(sectId, techniqueId, level, scrolls)
    .run();
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

describe('功法 · 藏经阁', () => {
  it('没有藏经阁：面板未开放，收录与参悟都拒绝', async () => {
    const sect = await makeSect('locked');
    const library = await getTechniqueLibrary(env.DB, sect.userId, NOW);
    expect(library.library.unlocked).toBe(false);
    await setScrolls(sect.sectId, 'qingfeng', 10);
    await expect(learnTechnique(env.DB, sect.userId, 'qingfeng', NOW)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  it('收录扣残卷、参悟扣残卷与灵石（灵石 = 单位 × 当前等级），满 10 级后拒绝', async () => {
    const sect = await makeSect('learn');
    await buildScripture(sect.sectId);
    await setScrolls(sect.sectId, 'qingfeng', 10);
    await setBalance(sect.sectId, 'spiritStone', 1_000_000);

    const learned = await learnTechnique(env.DB, sect.userId, 'qingfeng', NOW);
    expect(learned.library.items.find((item) => item.id === 'qingfeng')).toMatchObject({ learned: true, level: 1, scrolls: 0 });
    await expect(learnTechnique(env.DB, sect.userId, 'qingfeng', NOW)).rejects.toMatchObject({ code: 'INVALID_STATUS' });

    await setScrolls(sect.sectId, 'qingfeng', 5, 1);
    const before = await balanceOf(sect.sectId, 'spiritStone');
    const upgraded = await upgradeTechnique(env.DB, sect.userId, 'qingfeng', NOW);
    expect(upgraded.library.items.find((item) => item.id === 'qingfeng')).toMatchObject({ level: 2, scrolls: 0 });
    // 玄阶 1 → 2 级：灵石 50,000 × 1（最小单位）= 展示 50。
    expect(before - (await balanceOf(sect.sectId, 'spiritStone'))).toBe(50_000);
    await setScrolls(sect.sectId, 'qingfeng', 99, 10);
    await expect(upgradeTechnique(env.DB, sect.userId, 'qingfeng', NOW)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  it('残卷不足：收录与参悟都报 INVALID_STATUS，什么都不扣', async () => {
    const sect = await makeSect('short');
    await buildScripture(sect.sectId);
    await setScrolls(sect.sectId, 'pojia', 39);
    await expect(learnTechnique(env.DB, sect.userId, 'pojia', NOW)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    const row = await new TechniqueRepository(env.DB).findBySectId(sect.sectId);
    expect(row.find((item) => item.technique_id === 'pojia')).toMatchObject({ level: 0, scrolls: 39 });
  });
});

describe('功法 · 主修', () => {
  it('设为主修 → 更换（熟练度减半）→ 卸下（清零）；只能选已收录的', async () => {
    const sect = await makeSect('main');
    await buildScripture(sect.sectId);
    await setScrolls(sect.sectId, 'qingfeng', 0, 1);
    await setScrolls(sect.sectId, 'jingang', 0, 1);
    const disciple = sect.discipleIds[0]!;

    const set = await setDiscipleTechnique(env.DB, sect.userId, disciple, 'qingfeng', NOW);
    const view = set.disciples.find((item) => item.id === disciple)!;
    expect(view).toMatchObject({ techniqueId: 'qingfeng', techniqueName: '青锋剑诀', techniqueLevel: 1, techniqueProficiency: 0 });
    expect(set.learnedTechniques).toMatchObject([{ id: 'qingfeng', name: '青锋剑诀', level: 1 }, { id: 'jingang', name: '金刚不坏体', level: 1 }]);

    // 主修 48 小时后熟练度满（10000 基点），换功法时减半为 5000，之后从 5000 起算。
    const later = NOW + 48 * HOUR_MS;
    const switched = await setDiscipleTechnique(env.DB, sect.userId, disciple, 'jingang', later);
    const row = await env.DB.prepare('SELECT technique_prof_base, technique_since FROM disciples WHERE id = ?')
      .bind(disciple)
      .first<{ technique_prof_base: number; technique_since: number }>();
    expect(Number(row!.technique_prof_base)).toBe(5_000);
    expect(Number(row!.technique_since)).toBe(later);
    expect(techniqueProficiencyBp({ base: 5_000, since: later, now: later + 12 * HOUR_MS })).toBe(7_500);
    expect(switched.disciples.find((item) => item.id === disciple)!.techniqueName).toBe('金刚不坏体');

    const cleared = await setDiscipleTechnique(env.DB, sect.userId, disciple, null, later);
    expect(cleared.disciples.find((item) => item.id === disciple)).toMatchObject({
      techniqueId: null,
      techniqueName: '无',
      techniqueProficiency: 0,
    });
    const cleanRow = await env.DB.prepare('SELECT technique_id, technique_prof_base, technique_since FROM disciples WHERE id = ?')
      .bind(disciple)
      .first<{ technique_id: string | null; technique_prof_base: number; technique_since: number | null }>();
    expect(cleanRow).toMatchObject({ technique_id: null, technique_prof_base: 0, technique_since: null });

    await expect(setDiscipleTechnique(env.DB, sect.userId, disciple, 'taiyi', later)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });
  });

  it('路由：未知功法 / 多余字段一律 400', async () => {
    const sect = await makeSect('route');
    const unknown = await sect.api.post('/api/v1/game/techniques/learn', { techniqueId: 'nope' });
    expect(unknown.status).toBe(400);
    expect(errorOf(unknown).code).toBe('VALIDATION_ERROR');
    const extra = await sect.api.post('/api/v1/game/disciples/technique', {
      discipleId: sect.discipleIds[0],
      techniqueId: 'qingfeng',
      unexpected: true,
    });
    expect(extra.status).toBe(400);
  });
});

describe('功法 · 镇妖塔胜率预估', () => {
  it('入参同挑战：返回 50 场的胜率（整数百分比）与平均回合数，不扣次数、不写进度', async () => {
    const sect = await makeSect('preview', { strong: true });
    const response = await sect.api.post('/api/v1/game/tower/preview', { discipleIds: sect.discipleIds });
    if (response.status !== 200) throw new Error(`preview failed: ${JSON.stringify(errorOf(response))}`);
    expect(response.status).toBe(200);
    const preview = (dataOf(response) as { preview: { floor: number; samples: number; winRate: number; avgRounds: number } }).preview;
    expect(preview).toMatchObject({ floor: 1, samples: 50 });
    expect(preview.winRate).toBeGreaterThanOrEqual(0);
    expect(preview.winRate).toBeLessThanOrEqual(100);
    expect(preview.avgRounds).toBeGreaterThan(0);
    const tower = await env.DB.prepare('SELECT * FROM sect_towers WHERE sect_id = ?').bind(sect.sectId).first();
    expect(tower).toBeNull();
  });

  it('人数不对：VALIDATION_ERROR', async () => {
    const sect = await makeSect('preview-count');
    const four = await sect.api.post('/api/v1/game/tower/preview', { discipleIds: sect.discipleIds.slice(0, 4) });
    expect(four.status).toBe(400);
  });
});

describe('功法 · 商人残卷交付', () => {
  it('残卷拍下后张数进 sect_techniques.scrolls，不进资源余额', async () => {
    const buyer = await makeSect('merchant-buyer');
    // 拍卖行 3 级开放。
    await env.DB.prepare('UPDATE sects SET level = 3 WHERE id = ?').bind(buyer.sectId).run();
    await setBalance(buyer.sectId, 'spiritStone', 1_000_000_000);
    // 随机数全 0：本次到访的第三格材料换成残卷（玄阶首位青锋剑诀，2 张）。
    await env.DB.prepare('UPDATE auction_merchant_state SET next_arrival_at = ? WHERE id = 1').bind(NOW).run();
    await processAuctionMerchant(env.DB, NOW, () => 0);
    const lots = await env.DB.prepare(
      "SELECT id, item_id, quantity FROM auction_lots WHERE merchant_visit_id IS NOT NULL AND item_id LIKE 'techniqueScroll:%' AND status = 'active'",
    ).all<{ id: string; item_id: string; quantity: number }>();
    const lot = lots.results.find((item) => item.item_id === 'techniqueScroll:qingfeng');
    expect(lot).toBeDefined();

    await buyoutAuction(env.DB, buyer.userId, { lotId: lot!.id }, NOW);
    const rows = await new TechniqueRepository(env.DB).findBySectId(buyer.sectId);
    expect(rows.find((item) => item.technique_id === 'qingfeng')?.scrolls).toBe(Number(lot!.quantity));
    const hub = await getAuction(env.DB, buyer.userId, NOW);
    expect(hub.auction.merchant.present).toBe(true);
  });
});

describe('功勋兑换功法残卷', () => {
  it('按品阶扣功勋，残卷进 sect_techniques；不需要藏经阁', async () => {
    const sect = await makeSect('technique-merit');
    await env.DB.prepare("UPDATE resource_balances SET balance = 200000 WHERE sect_id = ? AND resource_id = 'bossMerit'")
      .bind(sect.sectId)
      .run();
    const result = await sect.api.post('/api/v1/game/world-boss/exchange', { itemId: 'techniqueScroll:taiyi', quantity: 3 });
    expect(result.status).toBe(200);
    const data = dataOf(result) as Record<string, any>;
    expect(data.outcome.scroll).toEqual({ techniqueId: 'taiyi', name: '太乙剑诀残卷（地阶）', quantity: 3 });
    expect(data.state.techniqueScrolls.taiyi).toBe(3);
    const row = await env.DB.prepare("SELECT scrolls FROM sect_techniques WHERE sect_id = ? AND technique_id = 'taiyi'")
      .bind(sect.sectId)
      .first<{ scrolls: number }>();
    expect(row?.scrolls).toBe(3);
    const merit = await env.DB.prepare("SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = 'bossMerit'")
      .bind(sect.sectId)
      .first<{ balance: number }>();
    expect(Number(merit?.balance)).toBe(170000);

    const unknown = await sect.api.post('/api/v1/game/world-boss/exchange', { itemId: 'techniqueScroll:nope', quantity: 1 });
    expect(errorOf(unknown).code).toBe('VALIDATION_ERROR');
  });
});
