import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { dataOf, TestClient } from './support/authClient';
import { attributeScore } from '../src/modules/game/names';

/**
 * 宗门公开档案（GET /game/sect/:id）的公开进度：镇妖塔最高层与已收录功法数。
 *
 * 口径与镇妖塔 / 藏经阁一致：
 *   - towerFloor：sect_towers.max_floor，没有记录按 0 层（前端显示「未攀登」）；
 *   - techniqueCount：参悟到 1 级及以上的功法数量——只有残卷、还没参悟的不算
 *     （与弟子视图里的 learnedTechniques 同一口径）。
 *
 * 存储说明：本文件一份独立内存 D1；塔层与功法行直接用 SQL 造，档案接口是只读路径。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;
const app = createApp({ logger: quietLogger });
const PASSWORD = 'password-123456';

let seq = 0;

interface SectFixture {
  api: TestClient;
  sectId: string;
}

async function makeSect(prefix: string): Promise<SectFixture> {
  seq += 1;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.76.0.${seq}` });
  const registered = await api.post('/api/v1/auth/register', {
    account: `${prefix}-${seq}`,
    password: PASSWORD,
  });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `档案${seq}宗` });
  expect(created.status).toBe(200);
  return { api, sectId: (dataOf(created) as Record<string, any>).state.sect.id as string };
}

async function publicSectOf(viewer: TestClient, sectId: string): Promise<Record<string, any>> {
  const result = await viewer.get(`/api/v1/game/sect/${sectId}`);
  expect(result.status).toBe(200);
  return dataOf(result).sect as Record<string, any>;
}

describe('宗门公开档案 · 公开进度', () => {
  it('新宗门：没打过镇妖塔按 0 层，没收录功法按 0 部', async () => {
    const owner = await makeSect('sect-fields-new');
    const viewer = await makeSect('sect-fields-viewer');
    const sect = await publicSectOf(viewer.api, owner.sectId);
    expect(sect.towerFloor).toBe(0);
    expect(sect.techniqueCount).toBe(0);
  });

  it('镇妖塔最高层与已收录功法数按真实进度下发；只有残卷的功法不算收录', async () => {
    const owner = await makeSect('sect-fields-progress');
    const viewer = await makeSect('sect-fields-viewer2');

    await env.DB.prepare(
      'INSERT INTO sect_towers (sect_id, max_floor, max_floor_at, updated_at) VALUES (?, ?, ?, ?)',
    )
      .bind(owner.sectId, 27, Date.UTC(2026, 9, 20, 12), Date.UTC(2026, 9, 20, 12))
      .run();
    // qingfeng 参悟到 3 级（算收录）；taiyi 只攒了 5 张残卷（level 0，不算）。
    for (const row of [
      { techniqueId: 'qingfeng', level: 3, scrolls: 0 },
      { techniqueId: 'taiyi', level: 0, scrolls: 5 },
    ]) {
      await env.DB.prepare(
        'INSERT INTO sect_techniques (sect_id, technique_id, level, scrolls) VALUES (?, ?, ?, ?)',
      )
        .bind(owner.sectId, row.techniqueId, row.level, row.scrolls)
        .run();
    }

    const sect = await publicSectOf(viewer.api, owner.sectId);
    expect(sect.towerFloor).toBe(27);
    expect(sect.techniqueCount).toBe(1);
  });

  it('弟子的综合评分与天骄榜同一口径（六项基础属性，一位小数）', async () => {
    const owner = await makeSect('sect-fields-score');
    const viewer = await makeSect('sect-fields-viewer3');
    // 直接写库造一组确定的属性，再用同一个 attributeScore 算期望值。
    await env.DB.prepare(
      'UPDATE disciples SET aptitude = ?, attack = ?, defense = ?, speed = ?, luck = ?, physique = ? WHERE sect_id = ?',
    )
      .bind(88, 71, 64, 59, 52, 45, owner.sectId)
      .run();

    const sect = await publicSectOf(viewer.api, owner.sectId);
    const expected = attributeScore({ aptitude: 88, attack: 71, defense: 64, speed: 59, luck: 52, physique: 45 });
    expect(sect.disciples.length).toBeGreaterThan(0);
    for (const disciple of sect.disciples as { attributeScore: number }[]) {
      expect(disciple.attributeScore).toBe(expected);
    }
  });
});
