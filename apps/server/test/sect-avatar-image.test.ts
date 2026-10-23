import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { dataOf, errorOf, TestClient } from './support/authClient';

/**
 * 0073 宗门头像：上传（服务端按文件头再校验）、按内容哈希读取、与弟子头像共用一张表、
 * 去重与孤儿清理（两边互不误删）、宗门公开档案可见。
 *
 * 图片样本与 avatar-image.test.ts 是同一批 Pillow 生成的纯色小图，只为覆盖文件头解析：
 * 这里只留用得到的几张（WebP 有损、另一张 WebP、PNG 不接受）。
 *
 * 存储说明：本文件一份独立内存 D1，没有逐用例回滚 —— 每个用例用独立账号 / 宗门。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;
const app = createApp({ logger: quietLogger });
const PASSWORD = 'password-123456';

const WEBP_A =
  'UklGRkQAAABXRUJQVlA4IDgAAACQAwCdASpAAEAAPm02mEkkIyKhIggAgA2JaQAAGJQqvELjALiAAP7xlQ//rb6K/e2KeUAkUAAAAA==';
const WEBP_B =
  'UklGRkwAAABXRUJQVlA4IEAAAACQAwCdASpAAEAAPm02mEkkIyKhIggAgA2JaQAAEDdTUAV4hbkAAP7y63/4Nkim5H//4hz+tv+5TXBHR4VAgAAA';
const PNG_SQUARE =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKUlEQVR4nO3NMQEAAAjDMAb+PWMCvlRAk/TUZ/16BwAAAAAAAAAAAIct2OEARiJ/pmcAAAAASUVORK5CYII=';

let seq = 0;

interface SectFixture {
  api: TestClient;
  sectId: string;
  discipleIds: string[];
  state: () => Promise<Record<string, any>>;
}

async function makeSect(prefix: string): Promise<SectFixture> {
  seq += 1;
  const api = new TestClient(app, env, {
    'cf-connecting-ip': `10.73.${Math.floor(seq / 250)}.${seq % 250}`,
  });
  const registered = await api.post('/api/v1/auth/register', {
    account: `${prefix}-${seq}`,
    password: PASSWORD,
  });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `头像${seq}宗` });
  expect(created.status).toBe(200);
  const state = (dataOf(created) as Record<string, any>).state;
  return {
    api,
    sectId: state.sect.id as string,
    discipleIds: (state.disciples as { id: string }[]).map((item) => item.id),
    state: async () => {
      const result = await api.get('/api/v1/game/sync');
      expect(result.status).toBe(200);
      return (dataOf(result) as Record<string, any>).state;
    },
  };
}

function uploadSect(sect: SectFixture, mime: string, data: string) {
  return sect.api.post('/api/v1/game/set-sect-avatar-image', { mime, data });
}

function clearSect(sect: SectFixture) {
  return sect.api.post('/api/v1/game/clear-sect-avatar-image');
}

function sectHashOf(state: Record<string, any>): string | null {
  return (state.sect as { avatarHash: string | null }).avatarHash ?? null;
}

async function imageCount(hash: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM avatar_images WHERE hash = ?')
    .bind(hash)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** 图片接口返回二进制，不走 TestClient 的 JSON 解析。 */
async function fetchAvatar(sect: SectFixture | null, hash: string): Promise<Response> {
  const headers = new Headers();
  if (sect !== null) headers.set('cookie', sect.api.cookieHeader);
  return app.request(`https://example.com/api/v1/game/avatars/${hash}`, { headers }, env);
}

function bytesOf(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

/**
 * 图片按内容哈希跨宗门共用一份，而本文件各用例共享同一个库：
 * 测「清理」时在样本末尾追加几个字节，得到别的用例没用过的新哈希（文件头不变，校验照样通过）。
 */
function variant(base64: string, tag: string): string {
  return btoa(atob(base64) + tag);
}

describe('0073 迁移', () => {
  it('sects 多了可空的 avatar_hash 列，新建宗门默认没有头像', async () => {
    const columns = await env.DB.prepare('PRAGMA table_info(sects)').all<{
      name: string;
      notnull: number;
    }>();
    const column = columns.results.find((row) => row.name === 'avatar_hash');
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(0);
    const sect = await makeSect('sect-avatar-migrate');
    expect(sectHashOf(await sect.state())).toBeNull();
  });
});

describe('上传宗门头像', () => {
  it('WebP 能传，state 回填 64 位哈希，图片接口原样返回并带长缓存', async () => {
    const sect = await makeSect('sect-avatar-ok');
    const image = variant(WEBP_A, 'sect-ok');
    const result = await uploadSect(sect, 'image/webp', image);
    expect(result.status).toBe(200);
    const hash = sectHashOf((dataOf(result) as Record<string, any>).state);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // 随后的同步也带着它（不是只在响应里出现一次）。
    expect(sectHashOf(await sect.state())).toBe(hash);

    const response = await fetchAvatar(sect, hash!);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytesOf(image));
  });

  it('格式不对 / mime 与文件头不符 / base64 坏了，一律 400 且不写库', async () => {
    const sect = await makeSect('sect-avatar-bad');
    const cases: [string, string][] = [
      ['image/webp', PNG_SQUARE],
      ['image/jpeg', WEBP_A],
      ['image/webp', '%%%not-base64%%%'],
      ['image/png', PNG_SQUARE],
    ];
    for (const [mime, data] of cases) {
      const result = await uploadSect(sect, mime, data);
      expect(result.status, `${mime} ${data.slice(0, 12)}`).toBe(400);
      expect(errorOf(result).code).toBe('VALIDATION_ERROR');
    }
    expect(sectHashOf(await sect.state())).toBeNull();
  });

  it('超过 64KB 的请求体在 schema 层就被拒绝', async () => {
    const sect = await makeSect('sect-avatar-big');
    const result = await uploadSect(sect, 'image/webp', 'A'.repeat(90_000));
    expect(result.status).toBe(400);
    expect(sectHashOf(await sect.state())).toBeNull();
  });

  it('重复上传同一张图不报错也不多存一份；换图后没人用的旧图被删掉', async () => {
    const sect = await makeSect('sect-avatar-dedupe');
    const imageA = variant(WEBP_A, 'sect-dedupe');
    const imageB = variant(WEBP_B, 'sect-dedupe');

    await uploadSect(sect, 'image/webp', imageA);
    const again = await uploadSect(sect, 'image/webp', imageA);
    expect(again.status).toBe(200);
    const hashA = sectHashOf((dataOf(again) as Record<string, any>).state)!;
    expect(await imageCount(hashA)).toBe(1);

    // 换图：旧图没人再引用，同批删掉，图片接口 404。
    const replaced = await uploadSect(sect, 'image/webp', imageB);
    expect(replaced.status).toBe(200);
    const hashB = sectHashOf((dataOf(replaced) as Record<string, any>).state)!;
    expect(hashB).not.toBe(hashA);
    expect(await imageCount(hashA)).toBe(0);
    expect((await fetchAvatar(sect, hashA)).status).toBe(404);
    expect((await fetchAvatar(sect, hashB)).status).toBe(200);
  });

  it('移除后回到静态 Logo；本来就没有时重复移除也 200', async () => {
    const sect = await makeSect('sect-avatar-clear');
    const cleared = await clearSect(sect);
    expect(cleared.status).toBe(200);
    expect(sectHashOf((dataOf(cleared) as Record<string, any>).state)).toBeNull();

    const image = variant(WEBP_A, 'sect-clear');
    const uploaded = await uploadSect(sect, 'image/webp', image);
    const hash = sectHashOf((dataOf(uploaded) as Record<string, any>).state)!;

    const removed = await clearSect(sect);
    expect(removed.status).toBe(200);
    expect(sectHashOf((dataOf(removed) as Record<string, any>).state)).toBeNull();
    expect(await imageCount(hash)).toBe(0);

    const twice = await clearSect(sect);
    expect(twice.status).toBe(200);
  });
});

describe('与弟子头像共用 avatar_images', () => {
  it('同一张图两边共用一份；弟子移除后宗门还在用，图片保留', async () => {
    const sect = await makeSect('sect-avatar-share');
    const discipleId = sect.discipleIds[0]!;
    const image = variant(WEBP_A, 'sect-share');

    const uploaded = await uploadSect(sect, 'image/webp', image);
    const hash = sectHashOf((dataOf(uploaded) as Record<string, any>).state)!;
    const onDisciple = await sect.api.post('/api/v1/game/set-disciple-avatar-image', {
      discipleId,
      mime: 'image/webp',
      data: image,
    });
    expect(onDisciple.status).toBe(200);
    // 同一张图只存一份。
    expect(await imageCount(hash)).toBe(1);

    // 弟子移除：宗门还用着这张图，不能删。
    const removed = await sect.api.post('/api/v1/game/clear-disciple-avatar-image', { discipleId });
    expect(removed.status).toBe(200);
    expect(await imageCount(hash)).toBe(1);
    expect((await fetchAvatar(sect, hash)).status).toBe(200);

    // 宗门移除：两边都没人用了，删掉。
    const clearedSect = await clearSect(sect);
    expect(clearedSect.status).toBe(200);
    expect(await imageCount(hash)).toBe(0);
    expect((await fetchAvatar(sect, hash)).status).toBe(404);
  });

  it('驱逐弟子时，宗门还在用的头像图片不能被删掉', async () => {
    const sect = await makeSect('sect-avatar-expel');
    const discipleId = sect.discipleIds[sect.discipleIds.length - 1]!;
    const image = variant(WEBP_A, 'sect-expel');

    const uploaded = await uploadSect(sect, 'image/webp', image);
    const hash = sectHashOf((dataOf(uploaded) as Record<string, any>).state)!;
    const onDisciple = await sect.api.post('/api/v1/game/set-disciple-avatar-image', {
      discipleId,
      mime: 'image/webp',
      data: image,
    });
    expect(onDisciple.status).toBe(200);
    expect(await imageCount(hash)).toBe(1);

    const expelled = await sect.api.post('/api/v1/game/expel-disciple', { discipleId });
    expect(expelled.status).toBe(200);
    // 弟子走了，宗门头像还在用同一张图：图片保留，宗门头像照样能取。
    expect(await imageCount(hash)).toBe(1);
    expect((await fetchAvatar(sect, hash)).status).toBe(200);
    expect(sectHashOf(await sect.state())).toBe(hash);
  });
});

describe('公开可见', () => {
  it('宗门公开档案带 avatarHash，别的玩家也能取图', async () => {
    const owner = await makeSect('sect-avatar-public');
    const viewer = await makeSect('sect-avatar-viewer');
    const image = variant(WEBP_A, 'sect-public');
    const result = await uploadSect(owner, 'image/webp', image);
    const hash = sectHashOf((dataOf(result) as Record<string, any>).state)!;

    const publicSect = dataOf(await viewer.api.get(`/api/v1/game/sect/${owner.sectId}`)) as Record<
      string,
      any
    >;
    expect(publicSect.sect.avatarHash).toBe(hash);
    expect((await fetchAvatar(viewer, hash)).status).toBe(200);
  });

  it('江湖榜每行也带 avatarHash（没上传过的为 null）', async () => {
    const owner = await makeSect('sect-avatar-board');
    const viewer = await makeSect('sect-avatar-board-viewer');
    const image = variant(WEBP_A, 'sect-board');
    const result = await uploadSect(owner, 'image/webp', image);
    const hash = sectHashOf((dataOf(result) as Record<string, any>).state)!;

    const board = dataOf(await viewer.api.get('/api/v1/game/leaderboard')) as Record<string, any>;
    const rows = board.entries as { sectId: string; avatarHash: string | null }[];
    expect(rows.find((row) => row.sectId === owner.sectId)?.avatarHash).toBe(hash);
    // 刚建的另外一个宗门没有自定义头像：字段在，值为 null。
    expect(rows.find((row) => row.sectId === viewer.sectId)?.avatarHash).toBeNull();
  });

  it('未登录不能上传，也不能取图', async () => {
    const sect = await makeSect('sect-avatar-auth');
    const image = variant(WEBP_A, 'sect-auth');
    const result = await uploadSect(sect, 'image/webp', image);
    const hash = sectHashOf((dataOf(result) as Record<string, any>).state)!;

    expect((await fetchAvatar(null, hash)).status).toBe(401);

    const anonymous = new TestClient(app, env, { 'cf-connecting-ip': '10.73.250.250' });
    const upload = await anonymous.post('/api/v1/game/set-sect-avatar-image', {
      mime: 'image/webp',
      data: image,
    });
    expect(upload.status).toBe(401);
    expect((await anonymous.post('/api/v1/game/clear-sect-avatar-image')).status).toBe(401);
  });
});
