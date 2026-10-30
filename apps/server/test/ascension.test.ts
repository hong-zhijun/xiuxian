import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { ascendDisciple } from '../src/modules/game/service';
import { dataOf, TestClient } from './support/authClient';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const app = createApp({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
const PASSWORD = 'password-123456';
let seq = 0;

async function makeFixture(): Promise<{ api: TestClient; userId: string; sectId: string; discipleId: string }> {
  seq += 1;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.88.0.${seq}` });
  const account = `ascension-${seq}`;
  expect((await api.post('/api/v1/auth/register', { account, password: PASSWORD })).status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `飞升测试${seq}` });
  expect(created.status).toBe(200);
  const state = dataOf(created) as { state: { sect: { id: string }; disciples: { id: string }[] } };
  const sectId = state.state.sect.id;
  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?').bind(sectId).first<{ user_id: string }>();
  const discipleId = state.state.disciples[0]!.id;
  await env.DB.prepare(
    `UPDATE disciples
        SET realm_id = 'tribulation', stage = 3, cultivation = 1250000,
            assignment = 'idle', injured_until = NULL, severe_injured_until = NULL,
            ascension_level = 0, ascension_pity = 0
      WHERE id = ?`,
  ).bind(discipleId).run();
  return { api, userId: row!.user_id, sectId, discipleId };
}

async function setBalance(sectId: string, resourceId: string, balance: number): Promise<void> {
  await env.DB.prepare('UPDATE resource_balances SET balance = ?, remainder = 0 WHERE sect_id = ? AND resource_id = ?')
    .bind(balance, sectId, resourceId)
    .run();
}

afterEach(() => vi.restoreAllMocks());

describe('飞升天门：渡劫后期免费三劫成仙', () => {
  it('不看宗门等级、不扣资源，三劫成功后直接标记已成仙，战力提升六倍', async () => {
    const fixture = await makeFixture();
    await env.DB.prepare('UPDATE sects SET level = 1 WHERE id = ?').bind(fixture.sectId).run();
    await setBalance(fixture.sectId, 'spiritStone', 12_345_000);
    await setBalance(fixture.sectId, 'spiritualEnergy', 67_890_000);
    const stoneBefore = (await env.DB.prepare("SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = 'spiritStone'").bind(fixture.sectId).first<{ balance: number }>())!.balance;
    const energyBefore = (await env.DB.prepare("SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = 'spiritualEnergy'").bind(fixture.sectId).first<{ balance: number }>())!.balance;
    const now = Date.now();
    await env.DB.prepare('UPDATE sects SET last_settled_at = ? WHERE id = ?').bind(now + 3_600_000, fixture.sectId).run();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const result = await ascendDisciple(env.DB, fixture.userId, fixture.discipleId, now);
    expect(result.outcome).toMatchObject({ success: true, ascended: true, pity: 0 });
    expect(result.outcome.rounds).toHaveLength(3);
    expect(result.outcome.combatPowerAfter).toBe(result.outcome.combatPowerBefore * 6);
    expect(await env.DB.prepare('SELECT ascension_level, ascension_pity FROM disciples WHERE id = ?').bind(fixture.discipleId).first())
      .toMatchObject({ ascension_level: 1, ascension_pity: 0 });
    expect(await env.DB.prepare("SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = 'spiritStone'").bind(fixture.sectId).first<{ balance: number }>()).toMatchObject({ balance: stoneBefore });
    expect(await env.DB.prepare("SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = 'spiritualEnergy'").bind(fixture.sectId).first<{ balance: number }>()).toMatchObject({ balance: energyBefore });

    await expect(ascendDisciple(env.DB, fixture.userId, fixture.discipleId, now)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  it('失败只增加保底层数，仍然不扣资源；非渡劫后期拒绝挑战', async () => {
    const fixture = await makeFixture();
    vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    const failed = await ascendDisciple(env.DB, fixture.userId, fixture.discipleId, Date.now());
    expect(failed.outcome.success).toBe(false);
    expect(failed.outcome.rounds).toHaveLength(3);
    expect(failed.outcome.pity).toBe(1);

    const other = await makeFixture();
    await env.DB.prepare("UPDATE disciples SET realm_id = 'mahayana', stage = 3 WHERE id = ?").bind(other.discipleId).run();
    await expect(ascendDisciple(env.DB, other.userId, other.discipleId, Date.now())).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });
});
