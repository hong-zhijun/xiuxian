import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import {
  attackVein,
  getVeins,
  occupyVein,
  processVeins,
  setVeinGarrison,
  withdrawVein,
} from '../src/modules/game/service';
import { VEIN_DAILY_ATTACKS } from '../src/modules/game/veins';

import { dataOf, errorOf, TestClient } from './support/authClient';

/**
 * 0042 灵脉争夺：服务层 + D1 的集成测试。
 *
 * 存储说明：本文件一份独立内存 D1；10 条灵脉是全服共享的行，所以每个用例开头先把灵脉全部清成无主，
 * 宗门各用独立账号。结算时间拨到很晚（结算窗口为 0），余额断言只受灵脉产出影响。
 * 胜负说明：对决用 Math.random —— 必胜 / 必败靠实力悬殊（渡劫后期满属性 vs 炼气一层属性 1），
 * 受伤判定用 vi.spyOn 固定随机数。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const app = createApp({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
const NOW = Date.UTC(2026, 5, 1, 4, 0);
const FAR = NOW + 30 * 86_400_000;
const HOUR = 3_600_000;

let seq = 0;

interface SectFixture {
  api: TestClient;
  userId: string;
  sectId: string;
  discipleIds: string[];
}

async function makeSect(prefix: string, level: number, strong: boolean): Promise<SectFixture> {
  seq += 1;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.31.${Math.floor(seq / 250)}.${seq % 250}` });
  expect((await api.post('/api/v1/auth/register', { account: `${prefix}-${seq}`, password: 'password-123456' })).status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `灵脉${seq}号` });
  const sectId = (dataOf(created) as Record<string, any>).state.sect.id as string;
  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?').bind(sectId).first<{ user_id: string }>();
  await env.DB.prepare('UPDATE sects SET level = ?, last_settled_at = ? WHERE id = ?').bind(level, FAR, sectId).run();
  const attr = strong ? 100 : 1;
  await env.DB.prepare(
    `UPDATE disciples SET realm_id = ?, stage = ?, attack = ?, defense = ?, speed = ?, luck = ?, physique = ?
     WHERE sect_id = ?`,
  )
    .bind(strong ? 'tribulation' : 'qiRefining', strong ? 3 : 1, attr, attr, attr, attr, attr, sectId)
    .run();
  const ids = await env.DB.prepare('SELECT id FROM disciples WHERE sect_id = ? ORDER BY created_at, id')
    .bind(sectId)
    .all<{ id: string }>();
  return { api, userId: row!.user_id, sectId, discipleIds: ids.results.map((item) => item.id) };
}

async function resetVeins(): Promise<void> {
  await env.DB.prepare(
    `UPDATE spirit_veins SET holder_sect_id = NULL, holder_name = NULL, garrison = NULL, held_since = NULL,
       protected_until = NULL, settled_at = NULL, exhausted_sect_id = NULL, exhausted_until = NULL`,
  ).run();
}

async function veinRow(veinId: string): Promise<Record<string, any>> {
  return (await env.DB.prepare('SELECT * FROM spirit_veins WHERE id = ?').bind(veinId).first<Record<string, any>>())!;
}

async function energyOf(sectId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = 'spiritualEnergy'",
  )
    .bind(sectId)
    .first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('灵脉争夺', () => {
  it('3 级开放；档位门槛；一宗一条（进驻新的自动让出旧的）', async () => {
    await resetVeins();
    const low = await makeSect('lock', 2, true);
    await expect(
      occupyVein(env.DB, low.userId, { veinId: 'vein-small-1', discipleIds: low.discipleIds }, NOW),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });

    const sect = await makeSect('one', 5, true);
    await expect(
      occupyVein(env.DB, sect.userId, { veinId: 'vein-large-1', discipleIds: sect.discipleIds }, NOW),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });

    const first = await occupyVein(env.DB, sect.userId, { veinId: 'vein-small-1', discipleIds: sect.discipleIds }, NOW);
    expect(first.veins.myVeinId).toBe('vein-small-1');
    expect(first.veins.veins.find((vein) => vein.id === 'vein-small-1')?.action).toBe('mine');

    const second = await occupyVein(env.DB, sect.userId, { veinId: 'vein-small-2', discipleIds: sect.discipleIds }, NOW + HOUR);
    expect(second.veins.myVeinId).toBe('vein-small-2');
    expect((await veinRow('vein-small-1')).holder_sect_id).toBeNull();
    // 让出时结算了 1 小时产出（25 灵气）
    expect(second.veins.harvested).toBe(25_000);
  });

  it('抢夺：保护期内不能抢；胜者接手、原占领者结算产出并收到通知', async () => {
    await resetVeins();
    const holder = await makeSect('hold', 4, false);
    const attacker = await makeSect('atk', 4, true);
    await occupyVein(env.DB, holder.userId, { veinId: 'vein-small-3', discipleIds: holder.discipleIds }, NOW);
    await expect(
      attackVein(env.DB, attacker.userId, { veinId: 'vein-small-3', discipleIds: attacker.discipleIds }, NOW + 30 * 60_000),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });

    const energyBefore = await energyOf(holder.sectId);
    const result = await attackVein(
      env.DB,
      attacker.userId,
      { veinId: 'vein-small-3', discipleIds: attacker.discipleIds },
      NOW + 2 * HOUR,
    );
    expect(result.result.battle?.won).toBe(true);
    expect(result.veins.myVeinId).toBe('vein-small-3');
    expect(result.veins.attacksUsed).toBe(1);
    const row = await veinRow('vein-small-3');
    expect(row.holder_sect_id).toBe(attacker.sectId);
    expect(Number(row.protected_until)).toBe(NOW + 3 * HOUR);
    // 被拦下的那次（+30 分钟）已顺手结算了半小时；这里再结算剩下的 1.5 小时 = 37.5 灵气
    expect(await energyOf(holder.sectId)).toBe(energyBefore + 37_500);

    const event = await env.DB.prepare("SELECT event_id FROM event_log WHERE sect_id = ? AND event_id = 'veinLost'")
      .bind(holder.sectId)
      .first();
    expect(event).not.toBeNull();
    const holderPanel = await getVeins(env.DB, holder.userId, NOW + 2 * HOUR + 1);
    expect(holderPanel.veins.battles[0]).toMatchObject({ iDefended: true, won: true, canRetake: true });
  });

  it('抢夺失败：进攻弟子可能受伤；守方收到「守住」通知', async () => {
    await resetVeins();
    const holder = await makeSect('def', 4, true);
    const attacker = await makeSect('weak', 4, false);
    await occupyVein(env.DB, holder.userId, { veinId: 'vein-small-4', discipleIds: holder.discipleIds }, NOW);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const result = await attackVein(
      env.DB,
      attacker.userId,
      { veinId: 'vein-small-4', discipleIds: attacker.discipleIds },
      NOW + 2 * HOUR,
    );
    expect(result.result.battle?.won).toBe(false);
    expect(result.result.battle?.injured).toHaveLength(3);
    const injured = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM disciples WHERE sect_id = ? AND injured_until > ?')
      .bind(attacker.sectId, NOW + 2 * HOUR)
      .first<{ cnt: number }>();
    expect(Number(injured?.cnt)).toBe(3);
    expect((await veinRow('vein-small-4')).holder_sect_id).toBe(holder.sectId);
    const held = await env.DB.prepare("SELECT event_id FROM event_log WHERE sect_id = ? AND event_id = 'veinHeld'")
      .bind(holder.sectId)
      .first();
    expect(held).not.toBeNull();
  });

  it('守军全部缺席时进攻方直接获胜；等级差 3 级不能抢；每日次数上限', async () => {
    await resetVeins();
    const holder = await makeSect('gone', 4, true);
    const bully = await makeSect('bully', 7, true);
    const peer = await makeSect('peer', 4, false);
    await occupyVein(env.DB, holder.userId, { veinId: 'vein-small-5', discipleIds: holder.discipleIds }, NOW);
    await expect(
      attackVein(env.DB, bully.userId, { veinId: 'vein-small-5', discipleIds: bully.discipleIds }, NOW + 2 * HOUR),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });

    // 守军被驱逐：弟子行没了，弱队也能直接拿下
    await env.DB.prepare('DELETE FROM disciples WHERE sect_id = ?').bind(holder.sectId).run();
    const won = await attackVein(env.DB, peer.userId, { veinId: 'vein-small-5', discipleIds: peer.discipleIds }, NOW + 2 * HOUR);
    expect(won.result.battle?.won).toBe(true);
    expect(won.result.battle?.rounds.every((round) => round.defenderName === null)).toBe(true);

    for (let index = 0; index < VEIN_DAILY_ATTACKS; index += 1) {
      await env.DB.prepare(
        `INSERT INTO vein_battles (id, vein_id, attacker_sect_id, attacker_name, defender_sect_id, defender_name, won, rounds, created_at)
         VALUES (?, 'vein-small-6', ?, 'x', 'y', 'y', 0, '[]', ?)`,
      )
        .bind(crypto.randomUUID(), bully.sectId, NOW + HOUR)
        .run();
    }
    const panel = await getVeins(env.DB, bully.userId, NOW + 2 * HOUR);
    expect(panel.veins.attacksLeft).toBe(0);
  });

  it('定时结算产出；灵眼占满 24 小时枯竭，原占领者 24 小时内不能再占', async () => {
    await resetVeins();
    const top = await makeSect('eye', 9, true);
    const other = await makeSect('eye2', 9, true);
    await occupyVein(env.DB, top.userId, { veinId: 'vein-eye', discipleIds: top.discipleIds }, NOW);

    const before = await energyOf(top.sectId);
    await processVeins(env.DB, NOW + HOUR);
    expect(await energyOf(top.sectId)).toBe(before + 60_000);

    await processVeins(env.DB, NOW + 25 * HOUR);
    const row = await veinRow('vein-eye');
    expect(row.holder_sect_id).toBeNull();
    expect(row.exhausted_sect_id).toBe(top.sectId);
    expect(Number(row.exhausted_until)).toBe(NOW + 48 * HOUR);
    // 结算到枯竭时刻为止：共 24 小时
    expect(await energyOf(top.sectId)).toBe(before + 24 * 60_000);

    await expect(
      occupyVein(env.DB, top.userId, { veinId: 'vein-eye', discipleIds: top.discipleIds }, NOW + 26 * HOUR),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    await occupyVein(env.DB, other.userId, { veinId: 'vein-eye', discipleIds: other.discipleIds }, NOW + 26 * HOUR);
    expect((await veinRow('vein-eye')).holder_sect_id).toBe(other.sectId);
  });

  it('换守军不影响计时；撤离结算产出后变无主；接口入参校验', async () => {
    await resetVeins();
    const sect = await makeSect('swap', 4, true);
    await occupyVein(env.DB, sect.userId, { veinId: 'vein-small-6', discipleIds: sect.discipleIds }, NOW);
    const reversed = [...sect.discipleIds].reverse();
    await setVeinGarrison(env.DB, sect.userId, { veinId: 'vein-small-6', discipleIds: reversed }, NOW + HOUR);
    const row = await veinRow('vein-small-6');
    expect(JSON.parse(row.garrison as string)).toEqual(reversed);
    expect(Number(row.held_since)).toBe(NOW);

    const left = await withdrawVein(env.DB, sect.userId, { veinId: 'vein-small-6' }, NOW + 2 * HOUR);
    expect(left.veins.myVeinId).toBeNull();
    expect(left.veins.harvested).toBe(50_000);

    const bad = await sect.api.post('/api/v1/game/veins/occupy', { veinId: 'vein-small-6', discipleIds: [sect.discipleIds[0]] });
    expect(bad.status).toBe(400);
    expect(errorOf(bad).code).toBe('VALIDATION_ERROR');
  });
});
