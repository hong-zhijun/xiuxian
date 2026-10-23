import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { discipleCombatPower } from '../src/modules/game/realms';
import { dataOf, TestClient } from './support/authClient';

/**
 * 江湖榜（宗门排名）的名次规则：**等级 → 声望 → 门人战力 → 建宗时间**。
 *
 * - 等级高的在前；同等级比声望；都相同比「门人战力」（战力最高的 5 名弟子的含装备战力合计）；
 * - 只有三项全相同才看建宗时间（老的在前），末尾再按 id 兜底，名次不会因为同毫秒抖动；
 * - 这条规则替掉了原先「等级 → 声望 → 直接比建宗时间」的老做法：新宗门把门人练强就能越过老宗门。
 *
 * 存储说明：本文件一份独立内存 D1；断言只比较本用例自己创建的宗门之间的**相对顺序**，
 * 不受库里其它宗门影响。等级 / 声望 / 弟子属性都直接改库造，因为榜单是只读路径。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;
const app = createApp({ logger: quietLogger });
const PASSWORD = 'password-123456';
const HOUR = 3_600_000;

let seq = 0;

interface SectFixture {
  api: TestClient;
  sectId: string;
}

async function makeSect(prefix: string, createdAt: number): Promise<SectFixture> {
  seq += 1;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.75.0.${seq}` });
  const registered = await api.post('/api/v1/auth/register', {
    account: `${prefix}-${seq}`,
    password: PASSWORD,
  });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `榜${seq}宗` });
  expect(created.status).toBe(200);
  const sectId = (dataOf(created) as Record<string, any>).state.sect.id as string;
  // 建宗时间是最后一道排序键，必须能被精确摆布。
  await env.DB.prepare('UPDATE sects SET created_at = ? WHERE id = ?').bind(createdAt, sectId).run();
  return { api, sectId };
}

/** 改宗门行上的等级 / 声望（榜单只看这两列）。 */
async function tuneSect(
  sectId: string,
  patch: { level?: number; reputation?: number },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE sects
        SET level = coalesce(?, level),
            reputation = coalesce(?, reputation)
      WHERE id = ?`,
  )
    .bind(patch.level ?? null, patch.reputation ?? null, sectId)
    .run();
}

/**
 * 把整个宗门的弟子捏成同一副模子：境界 / 阶段 / 属性 / 天赋全部固定，
 * 只由 attack 决定战力高低（同时清掉装备与灵兽加成，排除干扰项）。
 */
async function tuneDisciples(sectId: string, attack: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE disciples
        SET realm_id = 'qiRefining', stage = 1, talent = 'none',
            attack = ?, defense = 10, speed = 10,
            gear_attack = 0, gear_defense = 0, gear_speed = 0, gear_luck = 0,
            gear_physique = 0, gear_power_bp = 0, beast_json = NULL
      WHERE sect_id = ?`,
  )
    .bind(attack, sectId)
    .run();
}

interface RankRow {
  sectId: string;
  level: number;
  reputation: number;
  sectPower: number;
}

async function leaderboardOf(api: TestClient): Promise<RankRow[]> {
  const result = await api.get('/api/v1/game/leaderboard');
  expect(result.status).toBe(200);
  return (dataOf(result) as { entries: RankRow[] }).entries;
}

/** 只保留本用例造的这几个宗门，按榜单顺序返回。 */
function orderOf(rows: RankRow[], sectIds: readonly string[]): string[] {
  const mine = new Set(sectIds);
  return rows.filter((row) => mine.has(row.sectId)).map((row) => row.sectId);
}

describe('江湖榜 · 宗门排名规则', () => {
  it('等级 → 声望 → 门人战力 → 建宗时间', async () => {
    const base = Date.UTC(2026, 9, 20, 0, 0);
    // 四个宗门按建宗时间从老到新：最老的那个门人最弱（旧规则下它会一直压在别人前面）。
    const oldWeak = await makeSect('lb-old-weak', base);
    const newStrong = await makeSect('lb-new-strong', base + HOUR);
    const repLeader = await makeSect('lb-rep', base + 2 * HOUR);
    const topLevel = await makeSect('lb-level', base + 3 * HOUR);

    await tuneDisciples(oldWeak.sectId, 1);
    await tuneDisciples(newStrong.sectId, 999);
    await tuneDisciples(repLeader.sectId, 1);
    await tuneDisciples(topLevel.sectId, 1);
    // 声望压过战力；等级压过一切。
    await tuneSect(repLeader.sectId, { reputation: 10 });
    await tuneSect(topLevel.sectId, { level: 2 });

    const rows = await leaderboardOf(oldWeak.api);
    const order = orderOf(rows, [
      oldWeak.sectId,
      newStrong.sectId,
      repLeader.sectId,
      topLevel.sectId,
    ]);

    expect(order).toEqual([topLevel.sectId, repLeader.sectId, newStrong.sectId, oldWeak.sectId]);

    // 榜行把排序键一起下发：同等级同声望的两个宗门，战力高的那个数字也更大。
    const powerOf = new Map(rows.map((row) => [row.sectId, row.sectPower]));
    expect(powerOf.get(newStrong.sectId)!).toBeGreaterThan(powerOf.get(oldWeak.sectId)!);
    expect(powerOf.get(topLevel.sectId)!).toBeGreaterThan(0);
  });

  it('等级 / 声望 / 门人战力全相同时，建宗早的在前', async () => {
    const base = Date.UTC(2026, 9, 21, 0, 0);
    const older = await makeSect('lb-tie-old', base);
    const newer = await makeSect('lb-tie-new', base + HOUR);
    // 同一个模子 → 门人战力完全相同，只能靠建宗时间分先后。
    for (const sect of [older, newer]) {
      await tuneDisciples(sect.sectId, 1);
    }

    const rows = await leaderboardOf(older.api);
    const mine = rows.filter(
      (row) => row.sectId === older.sectId || row.sectId === newer.sectId,
    );
    expect(mine.map((row) => row.sectId)).toEqual([older.sectId, newer.sectId]);
    // 确实是「靠时间分出来的」：两者战力相等。
    expect(mine[0]!.sectPower).toBe(mine[1]!.sectPower);
  });

  it('门人战力只算前 5 名弟子：人再多也不会把战力堆上去', async () => {
    const base = Date.UTC(2026, 9, 22, 0, 0);
    const crowd = await makeSect('lb-crowd', base);
    await tuneDisciples(crowd.sectId, 1);

    // 再塞 9 名同模弟子（共 12 名）。同模弟子的单体战力可以精确算出来。
    const template = await env.DB.prepare(
      `SELECT gender, aptitude, realm_id, stage, assignment
         FROM disciples WHERE sect_id = ? LIMIT 1`,
    )
      .bind(crowd.sectId)
      .first<Record<string, unknown>>();
    for (let index = 0; index < 9; index += 1) {
      await env.DB.prepare(
        `INSERT INTO disciples
           (id, sect_id, name, gender, aptitude, realm_id, stage, assignment, attack, defense, speed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 10, 10, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          crowd.sectId,
          `凑数${String(index)}`,
          template!.gender,
          template!.aptitude,
          template!.realm_id,
          template!.stage,
          template!.assignment,
          base,
        )
        .run();
    }

    const single = discipleCombatPower('qiRefining', 1, 1, 10, 10, 'none', 0);
    const rows = await leaderboardOf(crowd.api);
    expect(rows.find((row) => row.sectId === crowd.sectId)?.sectPower).toBe(single * 5);
  });
});
