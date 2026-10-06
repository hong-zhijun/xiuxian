import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { dataOf, TestClient } from './support/authClient';

/**
 * 天赋重构（docs/天赋重构开发计划.md）：洗髓丹二选一、执事堂任命 / 卸任 / 出战拦截、
 * 炼器与丹房执事的加成。
 *
 * 存储说明：本文件一份独立内存 D1，没有逐用例回滚 —— 每个用例用独立账号 / 宗门。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;
const app = createApp({ logger: quietLogger });
const PASSWORD = 'password-123456';

let seq = 0;

interface SectFixture {
  api: TestClient;
  sectId: string;
  discipleIds: string[];
  state: () => Promise<Record<string, any>>;
}

async function makeSect(prefix: string): Promise<SectFixture> {
  seq += 1;
  const account = `${prefix}-${seq}`;
  const api = new TestClient(app, env, {
    'cf-connecting-ip': `10.11.${Math.floor(seq / 250)}.${seq % 250}`,
  });
  const registered = await api.post('/api/v1/auth/register', { account, password: PASSWORD });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `天赋${seq}号` });
  expect(created.status).toBe(200);
  const state = (dataOf(created) as Record<string, any>).state;
  // 炼丹解锁：宗门 2 级 + 灵药园 2 级。
  const sectId = state.sect.id as string;
  await env.DB.prepare('UPDATE sects SET level = 2 WHERE id = ?').bind(sectId).run();
  await env.DB.prepare('UPDATE buildings SET level = 2 WHERE sect_id = ? AND def_id = ?')
    .bind(sectId, 'herbGarden')
    .run();
  return {
    api,
    sectId,
    discipleIds: (state.disciples as { id: string }[]).map((item) => item.id),
    state: async () => {
      const result = await api.get('/api/v1/game/sync');
      expect(result.status).toBe(200);
      return (dataOf(result) as Record<string, any>).state;
    },
  };
}

async function setTalent(discipleId: string, talent: string, realmId = 'qiRefining'): Promise<void> {
  await env.DB.prepare('UPDATE disciples SET talent = ?, realm_id = ?, stage = 1 WHERE id = ?')
    .bind(talent, realmId, discipleId)
    .run();
}

async function setPillStock(sectId: string, pillId: string, quantity: number): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO pill_inventories (id, sect_id, pill_id, quantity, updated_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(crypto.randomUUID(), sectId, pillId, quantity, Date.now())
    .run();
}

async function discipleRow(discipleId: string) {
  return env.DB.prepare(
    'SELECT talent, talent_reroll_count, talent_candidate, steward_handover_until FROM disciples WHERE id = ?',
  )
    .bind(discipleId)
    .first<{
      talent: string;
      talent_reroll_count: number;
      talent_candidate: string | null;
      steward_handover_until: number | null;
    }>();
}

function errorOf(response: { body: unknown }): { code: string; message: string } {
  return (response.body as { error: { code: string; message: string } }).error;
}

function officeOf(state: Record<string, any>, office: string): Record<string, any> {
  return (state.stewards.offices as Record<string, any>[]).find((item) => item.office === office)!;
}

function discipleOf(state: Record<string, any>, discipleId: string): Record<string, any> {
  return (state.disciples as Record<string, any>[]).find((item) => item.id === discipleId)!;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('0034 迁移', () => {
  it('sect_stewards 表与 disciples 的三列都在', async () => {
    const columns = await env.DB.prepare('PRAGMA table_info(sect_stewards)').all<{ name: string }>();
    expect((columns.results ?? []).map((item) => item.name)).toEqual([
      'sect_id',
      'office',
      'disciple_id',
      'appointed_date_key',
      'updated_at',
    ]);
  });
});

describe('天赋视图', () => {
  it('弟子视图带当前境界的效果；state 带天赋总表与执事堂', async () => {
    const sect = await makeSect('talent-view');
    const discipleId = sect.discipleIds[0]!;
    await setTalent(discipleId, 'mining', 'goldenCore');
    const state = await sect.state();
    const disciple = discipleOf(state, discipleId);
    expect(disciple.talentName).toBe('矿脉');
    expect(disciple.talentEffect).toBe('矿石产出 +30%');
    expect(disciple.talentRerollRemaining).toBe(10);
    expect(disciple.talentCandidate).toBeNull();
    expect(disciple.combatBlockedReason).toBeNull();
    expect(state.talents).toHaveLength(11);
    expect(state.stewards.handoverHours).toBe(12);
    expect(state.stewards.offices.map((office: { office: string }) => office.office)).toEqual([
      'forging',
      'alchemy',
      'treasure',
    ]);
  });
});

describe('洗髓丹：洗出新天赋后二选一', () => {
  it('服用 → 候选（不与当前相同）→ 换成新天赋；有候选时不能再服', async () => {
    const sect = await makeSect('talent-reroll');
    const discipleId = sect.discipleIds[0]!;
    await setTalent(discipleId, 'combat');
    await setPillStock(sect.sectId, 'talentPill', 3);

    // 0 → 候选池（除战意外的 10 个）的第一个：灵植
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const used = await sect.api.post('/api/v1/game/use-pill', { pillId: 'talentPill', discipleId });
    expect(used.status).toBe(200);
    const outcome = (dataOf(used) as Record<string, any>).outcome;
    expect(outcome.effect.kind).toBe('talentReroll');
    expect(outcome.effect.candidate).toEqual({ id: 'herbGathering', name: '灵植', effect: '药材产出 +20%' });
    expect(await discipleRow(discipleId)).toMatchObject({
      talent: 'combat',
      talent_reroll_count: 1,
      talent_candidate: 'herbGathering',
    });

    const again = await sect.api.post('/api/v1/game/use-pill', { pillId: 'talentPill', discipleId });
    expect(errorOf(again).code).toBe('INVALID_STATUS');
    expect(errorOf(again).message).toContain('没有决定');

    const chosen = await sect.api.post('/api/v1/game/talent-choice', { discipleId, accept: true });
    expect(chosen.status).toBe(200);
    expect((dataOf(chosen) as Record<string, any>).outcome).toMatchObject({
      accepted: true,
      talent: 'herbGathering',
      talentName: '灵植',
      leftOffice: null,
    });
    expect(await discipleRow(discipleId)).toMatchObject({ talent: 'herbGathering', talent_candidate: null });
  });

  it('保留原天赋：候选清空、天赋不变；没有候选时不能选', async () => {
    const sect = await makeSect('talent-keep');
    const discipleId = sect.discipleIds[0]!;
    await setTalent(discipleId, 'combat');
    await setPillStock(sect.sectId, 'talentPill', 1);
    await sect.api.post('/api/v1/game/use-pill', { pillId: 'talentPill', discipleId });

    const kept = await sect.api.post('/api/v1/game/talent-choice', { discipleId, accept: false });
    expect(kept.status).toBe(200);
    expect(await discipleRow(discipleId)).toMatchObject({ talent: 'combat', talent_candidate: null });

    const none = await sect.api.post('/api/v1/game/talent-choice', { discipleId, accept: true });
    expect(errorOf(none).code).toBe('INVALID_STATUS');
  });

  it('每名弟子最多 10 次', async () => {
    const sect = await makeSect('talent-limit');
    const discipleId = sect.discipleIds[0]!;
    await setPillStock(sect.sectId, 'talentPill', 2);
    await env.DB.prepare('UPDATE disciples SET talent_reroll_count = 10 WHERE id = ?').bind(discipleId).run();
    const used = await sect.api.post('/api/v1/game/use-pill', { pillId: 'talentPill', discipleId });
    expect(errorOf(used).code).toBe('INVALID_STATUS');
    expect(errorOf(used).message).toContain('10 次');
  });

  it('功勋兑换洗髓丹：进丹库', async () => {
    const sect = await makeSect('talent-merit');
    await env.DB.prepare(
      "UPDATE resource_balances SET balance = 200000 WHERE sect_id = ? AND resource_id = 'bossMerit'",
    )
      .bind(sect.sectId)
      .run();
    const result = await sect.api.post('/api/v1/game/world-boss/exchange', { itemId: 'talentPill', quantity: 2 });
    expect(result.status).toBe(200);
    expect((dataOf(result) as Record<string, any>).outcome.pill).toEqual({
      pillId: 'talentPill',
      name: '洗髓丹',
      quantity: 2,
    });
    const row = await env.DB.prepare(
      "SELECT quantity FROM pill_inventories WHERE sect_id = ? AND pill_id = 'talentPill'",
    )
      .bind(sect.sectId)
      .first<{ quantity: number }>();
    expect(row?.quantity).toBe(2);
  });
});

describe('执事堂', () => {
  it('任命：天赋要对得上；同一职位每天只能任命一次；执事不能进守擂阵容', async () => {
    const sect = await makeSect('steward-appoint');
    const [a, b, c] = sect.discipleIds as [string, string, string];
    await setTalent(a, 'forging', 'nascentSoul');
    await setTalent(b, 'combat');
    await setTalent(c, 'forging');

    const wrong = await sect.api.post('/api/v1/game/steward/appoint', { office: 'forging', discipleId: b });
    expect(errorOf(wrong).code).toBe('INVALID_STATUS');
    expect(errorOf(wrong).message).toContain('需要「炼器」天赋');

    const ok = await sect.api.post('/api/v1/game/steward/appoint', { office: 'forging', discipleId: a });
    expect(ok.status).toBe(200);
    const state = (dataOf(ok) as Record<string, any>).state;
    expect(officeOf(state, 'forging')).toMatchObject({
      discipleId: a,
      effect: '全宗炼器成功率 +8%',
      paused: false,
      canAppointToday: false,
    });
    expect(discipleOf(state, a).stewardOffice).toBe('forging');
    expect(discipleOf(state, a).combatBlockedReason).toBe('任炼器执事');

    const sameDay = await sect.api.post('/api/v1/game/steward/appoint', { office: 'forging', discipleId: c });
    expect(errorOf(sameDay).code).toBe('INVALID_STATUS');
    expect(errorOf(sameDay).message).toContain('今天已经任命过');

    const lineup = await sect.api.post('/api/v1/game/set-defense-lineup', { discipleIds: [a, b, c] });
    expect(errorOf(lineup).code).toBe('INVALID_STATUS');
    expect(errorOf(lineup).message).toContain('不能出战');
  });

  it('卸任：职位空缺，原执事进入 12 小时交接期，期间仍不能出战', async () => {
    const sect = await makeSect('steward-dismiss');
    const [a, b, c] = sect.discipleIds as [string, string, string];
    await setTalent(a, 'alchemy');
    await sect.api.post('/api/v1/game/steward/appoint', { office: 'alchemy', discipleId: a });

    const before = Date.now();
    const dismissed = await sect.api.post('/api/v1/game/steward/dismiss', { office: 'alchemy' });
    expect(dismissed.status).toBe(200);
    const state = (dataOf(dismissed) as Record<string, any>).state;
    expect(officeOf(state, 'alchemy').discipleId).toBeNull();
    expect(discipleOf(state, a).combatBlockedReason).toBe('执事交接中');
    const row = await discipleRow(a);
    expect(row!.steward_handover_until).toBeGreaterThanOrEqual(before + 12 * 3_600_000);

    const lineup = await sect.api.post('/api/v1/game/set-defense-lineup', { discipleIds: [a, b, c] });
    expect(errorOf(lineup).code).toBe('INVALID_STATUS');
    expect(errorOf(lineup).message).toContain('交接中');

    const empty = await sect.api.post('/api/v1/game/steward/dismiss', { office: 'alchemy' });
    expect(errorOf(empty).code).toBe('INVALID_STATUS');
  });

  it('丹房执事：炼丹面板与实际扣款都是折后价', async () => {
    const sect = await makeSect('steward-alchemy');
    const a = sect.discipleIds[0]!;
    await setTalent(a, 'alchemy');
    await sect.api.post('/api/v1/game/steward/appoint', { office: 'alchemy', discipleId: a });

    const state = await sect.state();
    const healing = (state.alchemy.recipes as Record<string, any>[]).find((recipe) => recipe.id === 'healingPill')!;
    expect(healing.cost).toEqual({ herb: '9200', spiritStone: '13800' });
    expect(state.alchemy.costDiscountText).toBe('丹房执事：消耗 −8%');

    const crafted = await sect.api.post('/api/v1/game/craft-pill', { pillId: 'healingPill', quantity: 1 });
    expect(crafted.status).toBe(200);
    expect((dataOf(crafted) as Record<string, any>).outcome.cost).toEqual({ herb: '9200', spiritStone: '13800' });
  });

  it('洗髓换掉天赋的执事同批卸任；驱逐执事时职位清空', async () => {
    const sect = await makeSect('steward-reroll');
    const [a, b] = sect.discipleIds as [string, string];
    await setTalent(a, 'treasure');
    await setTalent(b, 'forging');
    await sect.api.post('/api/v1/game/steward/appoint', { office: 'treasure', discipleId: a });
    await sect.api.post('/api/v1/game/steward/appoint', { office: 'forging', discipleId: b });

    await setPillStock(sect.sectId, 'talentPill', 1);
    await sect.api.post('/api/v1/game/use-pill', { pillId: 'talentPill', discipleId: a });
    const chosen = await sect.api.post('/api/v1/game/talent-choice', { discipleId: a, accept: true });
    expect((dataOf(chosen) as Record<string, any>).outcome.leftOffice).toBe('寻宝执事');
    expect(officeOf((dataOf(chosen) as Record<string, any>).state, 'treasure').discipleId).toBeNull();

    const expelled = await sect.api.post('/api/v1/game/expel-disciple', { discipleId: b });
    expect(expelled.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT disciple_id FROM sect_stewards WHERE sect_id = ? AND office = 'forging'",
    )
      .bind(sect.sectId)
      .first<{ disciple_id: string | null }>();
    expect(row?.disciple_id).toBeNull();
  });
});
