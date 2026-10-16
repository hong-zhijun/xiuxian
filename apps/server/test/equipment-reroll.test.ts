import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { REALMS, dateKeyUtc8 } from '../src/modules/game/constants';
import { refineSubGainTotal, rerollCostUnits, rerollSubAttr, splitSubValue } from '../src/modules/game/equipment';
import { equipItem, getEquipment, rerollEquipment } from '../src/modules/game/service';
import { dataOf, errorOf, TestClient } from './support/authClient';

/**
 * 装备洗练：纯计算 + 服务层 + D1 + 路由的集成测试。
 *
 * 存储说明：本文件一份独立内存 D1，没有逐用例回滚 —— 每个用例用独立账号 / 宗门，
 * 断言按宗门 id 定界。
 * 随机说明：洗练用 Math.random，用例里用 vi.spyOn 按取用顺序钉住（attr 模式先种类后数值）。
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
    'cf-connecting-ip': `10.13.${Math.floor(seq / 250)}.${seq % 250}`,
  });
  const registered = await api.post('/api/v1/auth/register', { account, password: PASSWORD });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `洗练${seq}号` });
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
  sub_attr: string;
  sub_value: number;
  refine_level: number;
}

async function rowOf(equipmentId: string): Promise<EquipmentRowFixture> {
  const row = await env.DB.prepare(
    `SELECT id, disciple_id, quality, name, main_value, sub_attr, sub_value, refine_level
       FROM equipment WHERE id = ?`,
  )
    .bind(equipmentId)
    .first<EquipmentRowFixture>();
  expect(row).not.toBeNull();
  return row!;
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

interface NewEquipmentFixture {
  slot?: string;
  quality?: string;
  mainAttr?: string;
  mainValue?: number;
  subAttr?: string;
  subValue?: number;
  refineLevel?: number;
}

/** 直接入库一件背包里的装备（省去炼器）；默认是仙品兵器。 */
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
 * 冻结结算窗口的宗门（洗练需要的资源都给足）：last_settled_at 设成用例自己的 now，
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

describe('洗练：纯计算', () => {
  it('祭炼累计副属性加成：仙品 4 重 0、5 重 4、12 重 10；凡品 12 重 3', () => {
    expect(refineSubGainTotal('immortal', 4)).toBe(0);
    expect(refineSubGainTotal('immortal', 5)).toBe(4);
    expect(refineSubGainTotal('immortal', 11)).toBe(4);
    expect(refineSubGainTotal('immortal', 12)).toBe(10);
    expect(refineSubGainTotal('common', 12)).toBe(3);
    expect(splitSubValue('immortal', 12, 21)).toEqual({ base: 11, refine: 10 });
  });

  it('消耗：玄铁固定 1 个；灵石按品质，只洗数值 ×2', () => {
    expect(rerollCostUnits('common', 'attr')).toEqual({ spiritStone: 20_000, xuantie: 1000 });
    expect(rerollCostUnits('immortal', 'attr')).toEqual({ spiritStone: 150_000, xuantie: 1000 });
    expect(rerollCostUnits('immortal', 'value')).toEqual({ spiritStone: 300_000, xuantie: 1000 });
    expect(rerollCostUnits('spirit', 'value')).toEqual({ spiritStone: 80_000, xuantie: 1000 });
  });

  it('attr 模式：种类从非主属性里取、数值在区间内，祭炼加成加回；value 模式种类不变', () => {
    const queue = [0, 0];
    const random = (): number => queue.shift() ?? 0;
    // 兵器主属性攻击：候选 [防御, 身法, 幸运, 体魄]，0 → 防御；数值 0 → 下限 8；十二重 +10。
    expect(
      rerollSubAttr({ quality: 'immortal', mainAttr: 'attack', subAttr: 'speed', refineLevel: 12, mode: 'attr', random }),
    ).toEqual({ subAttr: 'defense', subValue: 18, base: 8 });
    // value 模式只取一个随机数：0.999 → 上限 16。
    expect(
      rerollSubAttr({
        quality: 'immortal',
        mainAttr: 'attack',
        subAttr: 'speed',
        refineLevel: 0,
        mode: 'value',
        random: () => 0.999,
      }),
    ).toEqual({ subAttr: 'speed', subValue: 16, base: 16 });
    // 任何随机数都不会洗出主属性，基础值不出区间。
    for (let step = 0; step < 20; step += 1) {
      const roll = step / 20;
      const result = rerollSubAttr({
        quality: 'common',
        mainAttr: 'attack',
        subAttr: 'speed',
        refineLevel: 0,
        mode: 'attr',
        random: () => roll,
      });
      expect(result.subAttr).not.toBe('attack');
      expect(result.base).toBeGreaterThanOrEqual(2);
      expect(result.base).toBeLessThanOrEqual(4);
    }
  });
});

describe('洗练：服务层', () => {
  it('attr 模式：十二重仙品「身法 21」洗成「幸运 23」，祭炼的 +10 保留；扣 150 灵石 + 1 玄铁', async () => {
    const { fixture, now } = await frozenSect('reroll-attr');
    const id = await insertEquipment(fixture.sectId, {
      quality: 'immortal',
      refineLevel: 12,
      mainValue: 67,
      subAttr: 'speed',
      subValue: 21,
    });
    const stoneBefore = await balanceOf(fixture.sectId, 'spiritStone');
    const xuantieBefore = await balanceOf(fixture.sectId, 'xuantie');
    const oreBefore = await balanceOf(fixture.sectId, 'ore');

    // random 恒为 0.6：种类 → 候选第 3 个（幸运）；数值 → 8 + 5 = 13；13 + 10 = 23。
    vi.spyOn(Math, 'random').mockReturnValue(0.6);
    const result = await rerollEquipment(env.DB, fixture.userId, id, 'attr', now);
    expect(result.outcome).toMatchObject({
      equipmentId: id,
      mode: 'attr',
      from: { subAttr: 'speed', subAttrName: '身法', subValue: 21 },
      to: { subAttr: 'luck', subAttrName: '幸运', subValue: 23 },
      cost: { spiritStone: '150000', xuantie: '1000' },
    });
    expect(await rowOf(id)).toMatchObject({ sub_attr: 'luck', sub_value: 23, refine_level: 12, main_value: 67 });
    expect(await balanceOf(fixture.sectId, 'spiritStone')).toBe(stoneBefore - 150_000);
    expect(await balanceOf(fixture.sectId, 'xuantie')).toBe(xuantieBefore - 1000);
    expect(await balanceOf(fixture.sectId, 'ore')).toBe(oreBefore);
  });

  it('value 模式：种类不变、洗低了也直接覆盖；扣 300 灵石 + 1 玄铁', async () => {
    const { fixture, now } = await frozenSect('reroll-value');
    const id = await insertEquipment(fixture.sectId, {
      quality: 'immortal',
      refineLevel: 5,
      subAttr: 'physique',
      subValue: 19,
    });
    const stoneBefore = await balanceOf(fixture.sectId, 'spiritStone');

    vi.spyOn(Math, 'random').mockReturnValue(0);
    const result = await rerollEquipment(env.DB, fixture.userId, id, 'value', now);
    // 基础 15 → 8，五重的 +4 保留：19 → 12。
    expect(result.outcome).toMatchObject({
      from: { subAttr: 'physique', subValue: 19 },
      to: { subAttr: 'physique', subValue: 12 },
      cost: { spiritStone: '300000', xuantie: '1000' },
    });
    expect(await rowOf(id)).toMatchObject({ sub_attr: 'physique', sub_value: 12 });
    expect(await balanceOf(fixture.sectId, 'spiritStone')).toBe(stoneBefore - 300_000);
  });

  it('穿在身上：弟子的 gear 列同批重算，命令回执里的弟子立刻是新值', async () => {
    const { fixture, now } = await frozenSect('reroll-worn');
    const discipleId = fixture.discipleIds[0]!;
    await env.DB.prepare('UPDATE disciples SET realm_id = ?, stage = 1 WHERE id = ?')
      .bind(REALMS[3]!.id, discipleId)
      .run();
    const id = await insertEquipment(fixture.sectId, { quality: 'immortal', subAttr: 'speed', subValue: 8 });
    await equipItem(env.DB, fixture.userId, id, discipleId, now);
    expect(await gearOf(discipleId)).toMatchObject({ attack: 24, speed: 8, defense: 0 });

    // random 恒为 0：种类 → 防御；数值 → 下限 8。
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const result = await rerollEquipment(env.DB, fixture.userId, id, 'attr', now);
    expect(result.outcome.to).toMatchObject({ subAttr: 'defense', subValue: 8 });
    expect(await gearOf(discipleId)).toMatchObject({ attack: 24, speed: 0, defense: 8 });
    expect(discipleOf(result.state, discipleId).gear).toMatchObject({ attack: 24, speed: 0, defense: 8 });
    const synced = discipleOf((await getEquipment(env.DB, fixture.userId, now)).state, discipleId);
    expect(synced.gear).toMatchObject({ attack: 24, speed: 0, defense: 8 });
  });

  it('玄铁不足：报 INSUFFICIENT_RESOURCE，装备与余额都不变', async () => {
    const { fixture, now } = await frozenSect('reroll-poor');
    const id = await insertEquipment(fixture.sectId, {
      quality: 'common',
      mainValue: 8,
      subAttr: 'speed',
      subValue: 3,
    });
    await setBalance(fixture.sectId, 'xuantie', 999);
    const stoneBefore = await balanceOf(fixture.sectId, 'spiritStone');
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await expect(rerollEquipment(env.DB, fixture.userId, id, 'attr', now)).rejects.toMatchObject({
      code: 'INSUFFICIENT_RESOURCE',
    });
    expect(await rowOf(id)).toMatchObject({ sub_attr: 'speed', sub_value: 3 });
    expect(await balanceOf(fixture.sectId, 'xuantie')).toBe(999);
    expect(await balanceOf(fixture.sectId, 'spiritStone')).toBe(stoneBefore);
  });

  it('宗门未到 2 级：报 INVALID_STATUS', async () => {
    const { fixture, now } = await frozenSect('reroll-locked', 1);
    const id = await insertEquipment(fixture.sectId);
    await expect(rerollEquipment(env.DB, fixture.userId, id, 'attr', now)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });
  });

  it('在外历练 / 重伤卧床的弟子身上的装备不能洗练，装备与材料都不变', async () => {
    const { fixture, now } = await frozenSect('reroll-away');
    const [away, injured] = fixture.discipleIds as [string, string];
    const awayItem = await insertEquipment(fixture.sectId, { quality: 'immortal' });
    const injuredItem = await insertEquipment(fixture.sectId, {
      quality: 'immortal',
      slot: 'armor',
      mainAttr: 'defense',
    });
    await equipItem(env.DB, fixture.userId, awayItem, away, now);
    await equipItem(env.DB, fixture.userId, injuredItem, injured, now);
    await sendJourney(fixture, away, now);
    await setSevereInjury(injured, now + DAY_MS);
    const xuantieBefore = await balanceOf(fixture.sectId, 'xuantie');

    vi.spyOn(Math, 'random').mockReturnValue(0);
    await expect(rerollEquipment(env.DB, fixture.userId, awayItem, 'attr', now)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });
    await expect(rerollEquipment(env.DB, fixture.userId, injuredItem, 'value', now)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });
    expect(await rowOf(awayItem)).toMatchObject({ sub_attr: 'speed', sub_value: 8 });
    expect(await rowOf(injuredItem)).toMatchObject({ sub_attr: 'speed', sub_value: 8 });
    expect(await balanceOf(fixture.sectId, 'xuantie')).toBe(xuantieBefore);
  });
});

describe('洗练：路由与面板', () => {
  it('POST /game/reroll-equipment：mode 必填且只能是 attr / value；面板给出基础 + 祭炼拆分与两种消耗', async () => {
    const { fixture } = await frozenSect('reroll-route');
    const id = await insertEquipment(fixture.sectId, {
      quality: 'immortal',
      refineLevel: 12,
      subAttr: 'speed',
      subValue: 21,
    });

    const panel = dataOf(await fixture.api.get('/api/v1/game/equipment')) as Record<string, any>;
    const item = (panel.equipment.items as Record<string, any>[]).find((row) => row.id === id)!;
    expect(item.reroll).toEqual({
      subBase: 11,
      subRefine: 10,
      subMin: 8,
      subMax: 16,
      cost: {
        attr: { spiritStone: '150000', xuantie: '1000' },
        value: { spiritStone: '300000', xuantie: '1000' },
      },
    });

    vi.spyOn(Math, 'random').mockReturnValue(0);
    const rerolled = await fixture.api.post('/api/v1/game/reroll-equipment', { equipmentId: id, mode: 'value' });
    expect(rerolled.status).toBe(200);
    const data = dataOf(rerolled) as Record<string, any>;
    expect(data.outcome).toMatchObject({ mode: 'value', to: { subAttr: 'speed', subValue: 18 } });
    expect(data.state).toBeTruthy();

    for (const body of [
      { equipmentId: id },
      { equipmentId: id, mode: 'both' },
      { equipmentId: id, mode: 'attr', keep: true },
    ]) {
      const rejected = await fixture.api.post('/api/v1/game/reroll-equipment', body);
      expect(rejected.status).toBe(400);
      expect(errorOf(rejected).code).toBe('VALIDATION_ERROR');
    }
    expect(await rowOf(id)).toMatchObject({ sub_attr: 'speed', sub_value: 18 });
  });
});
