import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { auctionUnitFloor } from '../src/modules/game/auction';
import { REALMS, dateKeyUtc8 } from '../src/modules/game/constants';
import {
  cancelAuction,
  equipItem,
  getEquipment,
  listAuctionItem,
  refineEquipment,
} from '../src/modules/game/service';
import { dataOf, errorOf, TestClient } from './support/authClient';

/**
 * 装备祭炼（docs/装备祭炼开发计划.md 6.2）：服务层 + D1 + 路由的集成测试。
 *
 * 存储说明：本文件一份独立内存 D1，没有逐用例回滚 —— 每个用例用独立账号 / 宗门，
 * 断言按宗门 id 定界。
 * 随机说明：祭炼判定用 Math.random，用例里用 vi.spyOn 钉住（0 = 必成功，0.99 = 必失败）。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;
const app = createApp({ logger: quietLogger });
const PASSWORD = 'password-123456';
const DAY_MS = 86_400_000;

let seq = 0;

interface SectFixture {
  api: TestClient;
  userId: string;
  sectId: string;
  discipleIds: string[];
  state: () => Promise<Record<string, any>>;
}

async function makeSect(prefix: string): Promise<SectFixture> {
  seq += 1;
  const account = `${prefix}-${seq}`;
  const api = new TestClient(app, env, {
    'cf-connecting-ip': `10.12.${Math.floor(seq / 250)}.${seq % 250}`,
  });
  const registered = await api.post('/api/v1/auth/register', { account, password: PASSWORD });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `祭炼${seq}号` });
  expect(created.status).toBe(200);
  const state = dataOf(created) as Record<string, any>;
  const sectId = state.state.sect.id as string;

  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?')
    .bind(sectId)
    .first<{ user_id: string }>();
  expect(row).not.toBeNull();

  return {
    api,
    userId: row!.user_id,
    sectId,
    discipleIds: (state.state.disciples as { id: string }[]).map((item) => item.id),
    state: async () => {
      const result = await api.get('/api/v1/game/sync');
      expect(result.status).toBe(200);
      return (dataOf(result) as Record<string, any>).state;
    },
  };
}

/** 以「今天的 UTC+8 日期」为第 0 天，取第 dayOffset 天 UTC+8 的 hour:minute。 */
function dayAt(dayOffset: number, hour: number, minute = 30): number {
  const parts = dateKeyUtc8(Date.now()).split('-').map(Number);
  return (
    Date.UTC(parts[0] ?? 1970, (parts[1] ?? 1) - 1, parts[2] ?? 1, hour - 8, minute) +
    dayOffset * DAY_MS
  );
}

function discipleOf(state: Record<string, any>, discipleId: string): Record<string, any> {
  const disciple = (state.disciples as { id: string }[]).find((item) => item.id === discipleId);
  expect(disciple).toBeTruthy();
  return disciple as Record<string, any>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ---------- 库级小工具（与 equipment.test.ts 同一写法） ---------- */

async function setSectLevel(sectId: string, level: number): Promise<void> {
  await env.DB.prepare('UPDATE sects SET level = ? WHERE id = ?').bind(level, sectId).run();
}

async function setBalance(sectId: string, resourceId: string, balance: number): Promise<void> {
  const updated = await env.DB.prepare(
    'UPDATE resource_balances SET balance = ?, remainder = 0 WHERE sect_id = ? AND resource_id = ?',
  )
    .bind(balance, sectId, resourceId)
    .run();
  if (Number(updated.meta.changes) > 0) return;
  await env.DB.prepare(
    `INSERT INTO resource_balances (id, sect_id, resource_id, balance, remainder, updated_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
  )
    .bind(crypto.randomUUID(), sectId, resourceId, balance, Date.now())
    .run();
}

async function balanceOf(sectId: string, resourceId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = ?',
  )
    .bind(sectId, resourceId)
    .first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

interface EquipmentRowFixture {
  id: string;
  disciple_id: string | null;
  quality: string;
  name: string;
  main_value: number;
  sub_value: number;
  refine_level: number;
}

async function rowOf(equipmentId: string): Promise<EquipmentRowFixture> {
  const row = await env.DB.prepare(
    `SELECT id, disciple_id, quality, name, main_value, sub_value, refine_level
       FROM equipment WHERE id = ?`,
  )
    .bind(equipmentId)
    .first<EquipmentRowFixture>();
  expect(row).not.toBeNull();
  return row!;
}

/** 隐藏的失败次数（只在库里）；没有记录返回 null。 */
async function refineFailsOf(sectId: string, level: number): Promise<number | null> {
  const row = await env.DB.prepare(
    'SELECT fails FROM equipment_refine_fails WHERE sect_id = ? AND level = ?',
  )
    .bind(sectId, level)
    .first<{ fails: number }>();
  return row === null ? null : Number(row.fails);
}

interface GearBonusFixture {
  attack: number;
  defense: number;
  speed: number;
  luck: number;
  physique: number;
}

async function gearOf(discipleId: string): Promise<GearBonusFixture> {
  const row = await env.DB.prepare(
    `SELECT gear_attack, gear_defense, gear_speed, gear_luck, gear_physique
       FROM disciples WHERE id = ?`,
  )
    .bind(discipleId)
    .first<Record<string, number>>();
  return {
    attack: Number(row?.gear_attack ?? 0),
    defense: Number(row?.gear_defense ?? 0),
    speed: Number(row?.gear_speed ?? 0),
    luck: Number(row?.gear_luck ?? 0),
    physique: Number(row?.gear_physique ?? 0),
  };
}

/** 弟子表上的装备战力加成列（基点）。 */
async function gearPowerBpOf(discipleId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT gear_power_bp FROM disciples WHERE id = ?')
    .bind(discipleId)
    .first<{ gear_power_bp: number }>();
  return Number(row?.gear_power_bp ?? 0);
}

interface NewEquipmentFixture {
  slot?: string;
  quality?: string;
  mainAttr?: string;
  mainValue?: number;
  subAttr?: string;
  subValue?: number;
  refineLevel?: number;
}

/** 直接入库一件背包里的装备（省去炼器）；默认是仙品兵器，祭炼用例的成本与增量最清楚。 */
async function insertEquipment(sectId: string, input: NewEquipmentFixture = {}): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO equipment
       (id, sect_id, disciple_id, slot, quality, name, main_attr, main_value,
        sub_attr, sub_value, refine_level, source, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'forge', ?)`,
  )
    .bind(
      id,
      sectId,
      input.slot ?? 'weapon',
      input.quality ?? 'immortal',
      `仙品·测试${id.slice(0, 8)}`,
      input.mainAttr ?? 'attack',
      input.mainValue ?? 24,
      input.subAttr ?? 'speed',
      input.subValue ?? 8,
      input.refineLevel ?? 0,
      Date.now(),
    )
    .run();
  return id;
}

async function setSevereInjury(discipleId: string, until: number | null): Promise<void> {
  await env.DB.prepare('UPDATE disciples SET severe_injured_until = ? WHERE id = ?')
    .bind(until, discipleId)
    .run();
}

/** 造一条「仍未到期的历练」→ 该弟子在外（requireNotAway 会拦）。 */
async function sendJourney(fixture: SectFixture, discipleId: string, now: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO disciple_journeys
       (id, sect_id, disciple_id, disciple_name, direction, duration_seconds,
        original_assignment, started_at, ends_at, completed_at, claimed_at,
        reward_cultivation, reward_resources, extra_harvest, injured, injury_chance_bp,
        cultivation_awarded, created_at)
     VALUES (?, ?, ?, '在外弟子', 'gathering', 7200, 'idle', ?, ?, NULL, NULL,
             100, '{}', 0, 0, 0, NULL, ?)`,
  )
    .bind(crypto.randomUUID(), fixture.sectId, discipleId, now, now + 3_600_000, now)
    .run();
}

/**
 * 冻结结算窗口的宗门（祭炼需要的资源都给足）：last_settled_at 设成用例自己的 now，
 * 服务调用也传同一个 now → 结算窗口恒为 0，资源断言只反映命令本身的收支。
 */
async function frozenSect(
  prefix: string,
  level = 2,
): Promise<{ fixture: SectFixture; now: number }> {
  const fixture = await makeSect(prefix);
  const now = dayAt(0, 12, 0);
  await setSectLevel(fixture.sectId, level);
  await env.DB.prepare('UPDATE sects SET last_settled_at = ? WHERE id = ?')
    .bind(now, fixture.sectId)
    .run();
  for (const resourceId of ['spiritStone', 'ore', 'xuantie']) {
    await setBalance(fixture.sectId, resourceId, 5_000_000);
  }
  return { fixture, now };
}

describe('0044 迁移：祭炼列与失败次数表', () => {
  it('equipment.refine_level 是 NOT NULL DEFAULT 0 的 INTEGER；equipment_refine_fails 表存在；旧装备入库即 0 重', async () => {
    const columns = await env.DB.prepare('PRAGMA table_info(equipment)').all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    const refine = (columns.results ?? []).find((item) => item.name === 'refine_level');
    expect(refine, 'refine_level 列不存在').toBeTruthy();
    expect(`${refine!.type}|${Number(refine!.notnull)}|${refine!.dflt_value ?? ''}`).toBe('INTEGER|1|0');

    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'equipment_refine_fails'",
    ).first<{ name: string }>();
    expect(table?.name).toBe('equipment_refine_fails');

    // 不写 refine_level 的老式 INSERT：默认 0 重。
    const { fixture } = await frozenSect('refine-migrate');
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO equipment (id, sect_id, disciple_id, slot, quality, name, main_attr, main_value,
          sub_attr, sub_value, source, created_at)
       VALUES (?, ?, NULL, 'weapon', 'common', '凡品·迁移', 'attack', 8, 'speed', 2, 'forge', ?)`,
    )
      .bind(id, fixture.sectId, Date.now())
      .run();
    expect((await rowOf(id)).refine_level).toBe(0);
  });
});

describe('0044 祭炼：成功 / 失败 / 穿戴 / 限制', () => {
  it('背包里成功：仙品 0 → 1 重，主属性 24 → 27，扣 40 灵石 / 30 矿石；面板给出下一重预览', async () => {
    const { fixture, now } = await frozenSect('refine-bag');
    const id = await insertEquipment(fixture.sectId, { quality: 'immortal', mainValue: 24 });
    const stoneBefore = await balanceOf(fixture.sectId, 'spiritStone');
    const oreBefore = await balanceOf(fixture.sectId, 'ore');

    vi.spyOn(Math, 'random').mockReturnValue(0);
    const result = await refineEquipment(env.DB, fixture.userId, id, now);
    expect(result.outcome).toMatchObject({
      equipmentId: id,
      success: true,
      fromLevel: 0,
      toLevel: 1,
      cost: { spiritStone: '40000', ore: '30000' },
    });
    expect(await balanceOf(fixture.sectId, 'spiritStone')).toBe(stoneBefore - 40_000);
    expect(await balanceOf(fixture.sectId, 'ore')).toBe(oreBefore - 30_000);
    expect(await rowOf(id)).toMatchObject({ refine_level: 1, main_value: 27 });

    const panel = dataOf(await fixture.api.get('/api/v1/game/equipment')) as Record<string, any>;
    const item = (panel.equipment.items as Record<string, any>[]).find((row) => row.id === id)!;
    expect(item.refineLevel).toBe(1);
    expect(item.powerBonusBp).toBe(1000);
    expect(item.refine.maxLevel).toBe(12);
    expect(item.refine.next).toMatchObject({
      level: 2,
      successBp: 10000,
      cost: { spiritStone: '55000', ore: '45000' },
      mainGain: 3,
      subGain: 0,
      powerBonusGainBp: 0,
    });
  });

  it('穿在身上成功：弟子的 gear 与战力立刻变化（命令回执与随后的 /game/sync 都对）', async () => {
    const { fixture, now } = await frozenSect('refine-worn');
    const discipleId = fixture.discipleIds[0]!;
    // 境界基数 = (境界序号 × 3 + 阶段) × 10：这里抬到基数 100，+1% 装备加成在整数战力上看得出来
    // （炼气一层基数只有 10，战力 floor 之后 +1% 常常不变）。
    await env.DB.prepare('UPDATE disciples SET realm_id = ?, stage = 1 WHERE id = ?')
      .bind(REALMS[3]!.id, discipleId)
      .run();
    const id = await insertEquipment(fixture.sectId, { quality: 'immortal', mainValue: 24, refineLevel: 8 });
    await equipItem(env.DB, fixture.userId, id, discipleId, now);
    expect(await gearPowerBpOf(discipleId)).toBe(1000);
    expect(await gearOf(discipleId)).toMatchObject({ attack: 24 });
    // 同一个 now 读一次面板：结算窗口为 0，战力只反映装备的变化。
    const beforePower = discipleOf((await getEquipment(env.DB, fixture.userId, now)).state, discipleId).combatPower;

    // 8 → 9 重：九重起祭炼战力 +100 基点，主属性 +4（冲 6～12 重）。
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const result = await refineEquipment(env.DB, fixture.userId, id, now);
    expect(result.outcome).toMatchObject({
      success: true,
      fromLevel: 8,
      toLevel: 9,
      cost: { spiritStone: '490000', ore: '300000', xuantie: '4000' },
    });
    expect(await rowOf(id)).toMatchObject({ refine_level: 9, main_value: 28 });
    expect(await gearOf(discipleId)).toMatchObject({ attack: 28 });
    expect(await gearPowerBpOf(discipleId)).toBe(1100);
    expect(discipleOf(result.state, discipleId).gearPowerBonusBp).toBe(1100);
    // 战力在命令回执里立刻变化（不必等下一次 sync）。
    expect(discipleOf(result.state, discipleId).combatPower).toBeGreaterThan(beforePower);
    expect(discipleOf(await fixture.state(), discipleId).gearPowerBonusBp).toBe(1100);
  });

  it('失败：只扣材料，重数与属性不变、不碎装备；失败次数记在 (宗门, 目标重数) 上；成功后清零', async () => {
    const { fixture, now } = await frozenSect('refine-fail');
    const id = await insertEquipment(fixture.sectId, { quality: 'immortal', refineLevel: 3, mainValue: 33, subValue: 8 });
    const stoneBefore = await balanceOf(fixture.sectId, 'spiritStone');
    const oreBefore = await balanceOf(fixture.sectId, 'ore');

    // 4 重基础成功率 90%：random 0.99 必失败。
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const first = await refineEquipment(env.DB, fixture.userId, id, now);
    expect(first.outcome).toMatchObject({
      success: false,
      fromLevel: 3,
      toLevel: 3,
      cost: { spiritStone: '110000', ore: '90000' },
    });
    expect(await balanceOf(fixture.sectId, 'spiritStone')).toBe(stoneBefore - 110_000);
    expect(await balanceOf(fixture.sectId, 'ore')).toBe(oreBefore - 90_000);
    expect(await rowOf(id)).toMatchObject({ refine_level: 3, main_value: 33, sub_value: 8 });
    expect(await refineFailsOf(fixture.sectId, 4)).toBe(1);

    await refineEquipment(env.DB, fixture.userId, id, now);
    expect(await refineFailsOf(fixture.sectId, 4)).toBe(2);
    expect(await rowOf(id)).toMatchObject({ refine_level: 3, main_value: 33 });

    // 第三次 random 0：基础 9000 + 2 × 500 = 10000，必成功；成功后该计数清零。
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const won = await refineEquipment(env.DB, fixture.userId, id, now);
    expect(won.outcome).toMatchObject({ success: true, fromLevel: 3, toLevel: 4 });
    expect(await rowOf(id)).toMatchObject({ refine_level: 4, main_value: 36, sub_value: 8 });
    expect(await refineFailsOf(fixture.sectId, 4)).toBe(0);
  });

  it('补偿是宗门级、按重数计数：A 冲 4 重失败 2 次后，B 冲 4 重按 2 次算（9499 成功；无补偿的宗门则失败）', async () => {
    const { fixture, now } = await frozenSect('refine-comp');
    const a = await insertEquipment(fixture.sectId, { quality: 'immortal', refineLevel: 3 });
    const b = await insertEquipment(fixture.sectId, { quality: 'immortal', refineLevel: 3 });
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    await refineEquipment(env.DB, fixture.userId, a, now);
    await refineEquipment(env.DB, fixture.userId, a, now);
    expect(await refineFailsOf(fixture.sectId, 4)).toBe(2);

    // 9499 < 10000（两次补偿之后的成功率）→ 成功。
    vi.spyOn(Math, 'random').mockReturnValue(0.9499);
    const withCompensation = await refineEquipment(env.DB, fixture.userId, b, now);
    expect(withCompensation.outcome.success).toBe(true);
    expect(await rowOf(b)).toMatchObject({ refine_level: 4 });
    expect(await refineFailsOf(fixture.sectId, 4)).toBe(0);

    // 对照：另一个宗门从没失败过，同样的 0.9499 只有 9000 基础成功率 → 失败。
    const other = await frozenSect('refine-comp-0');
    const c = await insertEquipment(other.fixture.sectId, { quality: 'immortal', refineLevel: 3 });
    const withoutCompensation = await refineEquipment(env.DB, other.fixture.userId, c, other.now);
    expect(withoutCompensation.outcome.success).toBe(false);
    expect(await rowOf(c)).toMatchObject({ refine_level: 3 });
  });

  it('资源不足：报 INSUFFICIENT_RESOURCE，装备与余额都不变', async () => {
    const { fixture, now } = await frozenSect('refine-poor');
    const id = await insertEquipment(fixture.sectId, { quality: 'immortal', refineLevel: 0 });
    // 1 重要矿石 30 个（30000 最小单位），这里只给 29.999 个。
    await setBalance(fixture.sectId, 'ore', 29_999);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await expect(refineEquipment(env.DB, fixture.userId, id, now)).rejects.toMatchObject({
      code: 'INSUFFICIENT_RESOURCE',
    });
    expect(await rowOf(id)).toMatchObject({ refine_level: 0, main_value: 24 });
    expect(await balanceOf(fixture.sectId, 'ore')).toBe(29_999);
    expect(await refineFailsOf(fixture.sectId, 1)).toBeNull();
  });

  it('十二重圆满：再祭炼报 INVALID_STATUS；面板 next = null，战力加成 1600 基点', async () => {
    const { fixture, now } = await frozenSect('refine-max');
    const id = await insertEquipment(fixture.sectId, { quality: 'immortal', refineLevel: 12, mainValue: 67 });
    await expect(refineEquipment(env.DB, fixture.userId, id, now)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
      message: expect.stringContaining('已祭炼至十二重圆满'),
    });
    expect((await rowOf(id)).refine_level).toBe(12);

    const panel = dataOf(await fixture.api.get('/api/v1/game/equipment')) as Record<string, any>;
    const item = (panel.equipment.items as Record<string, any>[]).find((row) => row.id === id)!;
    expect(item.refineLevel).toBe(12);
    expect(item.refine).toEqual({ maxLevel: 12, next: null });
    expect(item.powerBonusBp).toBe(1600);
  });

  it('在外历练 / 重伤卧床的弟子身上的装备不能祭炼，装备与材料都不变', async () => {
    const { fixture, now } = await frozenSect('refine-away');
    const [away, injured] = fixture.discipleIds as [string, string];
    const awayItem = await insertEquipment(fixture.sectId, { quality: 'immortal' });
    const injuredItem = await insertEquipment(fixture.sectId, {
      quality: 'immortal',
      slot: 'armor',
      mainAttr: 'defense',
    });
    // 先穿上再让人在外 / 重伤：穿戴本身也要求弟子不在外。
    await equipItem(env.DB, fixture.userId, awayItem, away, now);
    await equipItem(env.DB, fixture.userId, injuredItem, injured, now);
    await sendJourney(fixture, away, now);
    await setSevereInjury(injured, now + DAY_MS);
    const oreBefore = await balanceOf(fixture.sectId, 'ore');

    vi.spyOn(Math, 'random').mockReturnValue(0);
    await expect(refineEquipment(env.DB, fixture.userId, awayItem, now)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });
    await expect(refineEquipment(env.DB, fixture.userId, injuredItem, now)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });
    expect((await rowOf(awayItem)).refine_level).toBe(0);
    expect((await rowOf(injuredItem)).refine_level).toBe(0);
    expect(await balanceOf(fixture.sectId, 'ore')).toBe(oreBefore);
  });

  it('路由：POST /game/refine-equipment 一次只冲 1 重；多余字段被 schema 拒绝（400）', async () => {
    const { fixture } = await frozenSect('refine-route');
    const id = await insertEquipment(fixture.sectId, { quality: 'immortal', refineLevel: 0 });
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const refined = await fixture.api.post('/api/v1/game/refine-equipment', { equipmentId: id });
    expect(refined.status).toBe(200);
    const data = dataOf(refined) as Record<string, any>;
    expect(data.outcome).toMatchObject({ success: true, fromLevel: 0, toLevel: 1 });
    expect(data.state).toBeTruthy();
    expect((await rowOf(id)).refine_level).toBe(1);

    const rejected = await fixture.api.post('/api/v1/game/refine-equipment', { equipmentId: id, levels: 3 });
    expect(rejected.status).toBe(400);
    expect(errorOf(rejected).code).toBe('VALIDATION_ERROR');
    expect((await rowOf(id)).refine_level).toBe(1);
  });
});

describe('0044 祭炼 × 拍卖：重数跟着装备走', () => {
  it('7 重装备上架 → 下架退回仍是 7 重；老格式快照（JSON 没有 refineLevel）交付时按 0 重', async () => {
    const { fixture, now } = await frozenSect('refine-auc', 3);
    const floor = auctionUnitFloor('equipment', 'treasure') / 1000;

    const seven = await insertEquipment(fixture.sectId, { quality: 'treasure', refineLevel: 7 });
    const listed = await listAuctionItem(
      env.DB,
      fixture.userId,
      { kind: 'equipment', equipmentId: seven, startPrice: floor },
      now,
    );
    const lot = listed.auction.myLots.find((item) => item.status === 'active')!;
    expect(lot.equipment?.refineLevel).toBe(7);
    expect(await refineLevelsInBag(fixture.sectId)).toEqual([]);

    await cancelAuction(env.DB, fixture.userId, { lotId: lot.id }, now + 1);
    expect(await refineLevelsInBag(fixture.sectId)).toEqual([7]);

    // 老格式：上架时没有 refineLevel 字段（0044 之前的拍卖单）。
    const old = await insertEquipment(fixture.sectId, { quality: 'treasure', refineLevel: 0 });
    const relisted = await listAuctionItem(
      env.DB,
      fixture.userId,
      { kind: 'equipment', equipmentId: old, startPrice: floor },
      now + 2,
    );
    const oldLot = relisted.auction.myLots.find((item) => item.status === 'active')!;
    const raw = await env.DB.prepare('SELECT equipment_json FROM auction_lots WHERE id = ?')
      .bind(oldLot.id)
      .first<{ equipment_json: string }>();
    const snapshot = JSON.parse(raw!.equipment_json) as Record<string, unknown>;
    delete snapshot.refineLevel;
    await env.DB.prepare('UPDATE auction_lots SET equipment_json = ? WHERE id = ?')
      .bind(JSON.stringify(snapshot), oldLot.id)
      .run();

    await cancelAuction(env.DB, fixture.userId, { lotId: oldLot.id }, now + 3);
    expect(await refineLevelsInBag(fixture.sectId)).toEqual([0, 7]);
  });
});

/** 背包里装备的重数（按重数升序）。 */
async function refineLevelsInBag(sectId: string): Promise<number[]> {
  const result = await env.DB.prepare(
    'SELECT refine_level FROM equipment WHERE sect_id = ? AND disciple_id IS NULL ORDER BY refine_level ASC',
  )
    .bind(sectId)
    .all<{ refine_level: number }>();
  return (result.results ?? []).map((row) => Number(row.refine_level));
}

describe('0044 祭炼：视图不泄露隐藏补偿', () => {
  it('失败 3 次后，装备面板与祭炼回执的 JSON 里没有 fails 字样；refine.next.successBp 仍是基础值', async () => {
    const { fixture, now } = await frozenSect('refine-leak');
    // 冲 5 重：基础 80%、每次失败 +5%、封顶 95%，random 0.99 连续失败 3 次。
    // 不能用 4 重：4 重失败 2 次后已是 100%，第 3 次必成功。
    const id = await insertEquipment(fixture.sectId, { quality: 'immortal', refineLevel: 4 });
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    const outcomes: unknown[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await refineEquipment(env.DB, fixture.userId, id, now);
      expect(result.outcome.success).toBe(false);
      outcomes.push(result.outcome);
    }
    expect(await refineFailsOf(fixture.sectId, 5)).toBe(3);

    expect(JSON.stringify(outcomes)).not.toContain('fails');
    const panel = await fixture.api.get('/api/v1/game/equipment');
    expect(JSON.stringify(dataOf(panel))).not.toContain('fails');
    const item = ((dataOf(panel) as Record<string, any>).equipment.items as Record<string, any>[]).find(
      (row) => row.id === id,
    )!;
    expect(item.refine.next.level).toBe(5);
    expect(item.refine.next.successBp).toBe(8000);
  });
});
