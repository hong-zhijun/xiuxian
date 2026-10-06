import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { dataOf, errorOf, TestClient } from './support/authClient';

/**
 * 0038 弟子自定义头像：上传（服务端按文件头再校验）、按内容哈希读取、去重与孤儿清理、公开可见。
 *
 * 图片样本是用 Pillow 生成的真实小图（纯色），只为覆盖文件头解析：
 *   WebP 有损（VP8）/ 无损（VP8L）、JPEG、非正方形、超大边长、PNG（不接受）。
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
const WEBP_LOSSLESS =
  'UklGRiQAAABXRUJQVlA4TBcAAAAvL8ALAAdQhSpUof8BICH8Xy9G9D/1AAA=';
const JPEG_SQUARE =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAgACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDfooorzDpCiiigAooooAKKKKAP/9k=';
const JPEG_WIDE =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAgADADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDfooorzDpCiiigAooooAKKKKACiiigAooooA//2Q==';
const WEBP_HUGE =
  'UklGRk4AAABXRUJQVlA4TEEAAAAv/8P/AAcQEf0PCASS/c0nKKL/Gf/5z3/+85///Oc///nPf/7zn//85z//+c9//vOf//znP//5z3/+85///Of/BgA=';
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
    'cf-connecting-ip': `10.38.${Math.floor(seq / 250)}.${seq % 250}`,
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

function upload(sect: SectFixture, discipleId: string, mime: string, data: string) {
  return sect.api.post('/api/v1/game/set-disciple-avatar-image', { discipleId, mime, data });
}

function hashOf(state: Record<string, any>, discipleId: string): string | null {
  return (
    (state.disciples as { id: string; avatarHash: string | null }[]).find(
      (item) => item.id === discipleId,
    )?.avatarHash ?? null
  );
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

describe('0038 迁移', () => {
  it('建了 avatar_images 表，disciples 多了可空的 avatar_hash 列', async () => {
    const table = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'avatar_images'",
    ).first<{ n: number }>();
    expect(Number(table?.n)).toBe(1);
    const sect = await makeSect('avatar-migrate');
    expect(hashOf(await sect.state(), sect.discipleIds[0]!)).toBeNull();
  });
});

describe('上传自定义头像', () => {
  it('WebP / JPEG / 无损 WebP 都能传，state 回填 64 位哈希，图片接口原样返回并带长缓存', async () => {
    const sect = await makeSect('avatar-ok');
    const [a, b, c] = sect.discipleIds;
    const cases: [string, string, string][] = [
      [a!, 'image/webp', WEBP_A],
      [b!, 'image/jpeg', JPEG_SQUARE],
      [c!, 'image/webp', WEBP_LOSSLESS],
    ];
    for (const [id, mime, data] of cases) {
      const result = await upload(sect, id, mime, data);
      expect(result.status).toBe(200);
      const hash = hashOf((dataOf(result) as Record<string, any>).state, id);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);

      const response = await fetchAvatar(sect, hash!);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(mime);
      expect(response.headers.get('cache-control')).toContain('immutable');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytesOf(data));
    }
  });

  it('格式不对、mime 与文件头不符、非正方形、边长超限、base64 坏了，一律 400 且不写库', async () => {
    const sect = await makeSect('avatar-bad');
    const id = sect.discipleIds[0]!;
    const cases: [string, string][] = [
      ['image/webp', PNG_SQUARE],
      ['image/jpeg', WEBP_A],
      ['image/jpeg', JPEG_WIDE],
      ['image/webp', WEBP_HUGE],
      ['image/webp', '%%%not-base64%%%'],
      ['image/png', PNG_SQUARE],
    ];
    for (const [mime, data] of cases) {
      const result = await upload(sect, id, mime, data);
      expect(result.status, `${mime} ${data.slice(0, 12)}`).toBe(400);
      expect(errorOf(result).code).toBe('VALIDATION_ERROR');
    }
    expect(hashOf(await sect.state(), id)).toBeNull();
  });

  it('超过 64KB 的请求体在 schema 层就被拒绝', async () => {
    const sect = await makeSect('avatar-big');
    const result = await upload(sect, sect.discipleIds[0]!, 'image/webp', 'A'.repeat(90_000));
    expect(result.status).toBe(400);
  });

  it('别的宗门的弟子不能改：NOT_FOUND', async () => {
    const owner = await makeSect('avatar-owner');
    const other = await makeSect('avatar-other');
    const result = await upload(other, owner.discipleIds[0]!, 'image/webp', WEBP_A);
    expect(result.status).toBe(404);
    expect(hashOf(await owner.state(), owner.discipleIds[0]!)).toBeNull();
  });
});

describe('去重与清理', () => {
  it('同一张图只存一份；换图 / 移除后没人用的旧图被删掉，别人还在用的保留', async () => {
    const sect = await makeSect('avatar-dedupe');
    const [a, b] = sect.discipleIds;
    const imageA = variant(WEBP_A, 'dedupe');
    await upload(sect, a!, 'image/webp', imageA);
    const shared = await upload(sect, b!, 'image/webp', imageA);
    const hashA = hashOf((dataOf(shared) as Record<string, any>).state, b!)!;
    expect(hashOf(await sect.state(), a!)).toBe(hashA);
    expect(await imageCount(hashA)).toBe(1);

    // a 换图：b 还在用 hashA，旧图保留。
    await upload(sect, a!, 'image/webp', WEBP_B);
    expect(await imageCount(hashA)).toBe(1);

    // b 移除：没人用 hashA 了，删掉；图片接口 404。
    const cleared = await sect.api.post('/api/v1/game/clear-disciple-avatar-image', { discipleId: b });
    expect(cleared.status).toBe(200);
    expect(hashOf((dataOf(cleared) as Record<string, any>).state, b!)).toBeNull();
    expect(await imageCount(hashA)).toBe(0);
    expect((await fetchAvatar(sect, hashA)).status).toBe(404);

    // 重复移除 / 重复上传同一张：显式早退，不报错。
    const again = await sect.api.post('/api/v1/game/clear-disciple-avatar-image', { discipleId: b });
    expect(again.status).toBe(200);
    expect((await upload(sect, a!, 'image/webp', WEBP_B)).status).toBe(200);
  });

  it('驱逐弟子时，没人再用的头像图片同批删掉', async () => {
    const sect = await makeSect('avatar-expel');
    const id = sect.discipleIds[sect.discipleIds.length - 1]!;
    const result = await upload(sect, id, 'image/jpeg', variant(JPEG_SQUARE, 'expel'));
    const hash = hashOf((dataOf(result) as Record<string, any>).state, id)!;
    expect(await imageCount(hash)).toBe(1);
    const expelled = await sect.api.post('/api/v1/game/expel-disciple', { discipleId: id });
    expect(expelled.status).toBe(200);
    expect(await imageCount(hash)).toBe(0);
  });
});

describe('公开可见', () => {
  it('天骄榜、弟子公开档案、宗门公开档案都带 avatarHash，其他玩家也能取图', async () => {
    const owner = await makeSect('avatar-public');
    const viewer = await makeSect('avatar-viewer');
    const id = owner.discipleIds[0]!;
    const result = await upload(owner, id, 'image/webp', WEBP_A);
    const hash = hashOf((dataOf(result) as Record<string, any>).state, id)!;

    const board = dataOf(await viewer.api.get('/api/v1/game/disciple-leaderboard')) as Record<string, any>;
    const entries = [...board.byCombatPower, ...board.byAttributeScore] as {
      discipleId: string;
      avatarHash: string | null;
    }[];
    for (const entry of entries.filter((item) => item.discipleId === id)) {
      expect(entry.avatarHash).toBe(hash);
    }

    const profile = dataOf(await viewer.api.get(`/api/v1/game/disciple-profile/${id}`)) as Record<string, any>;
    expect(profile.avatarHash).toBe(hash);

    const publicSect = (dataOf(await viewer.api.get(`/api/v1/game/sect/${owner.sectId}`)) as Record<string, any>).sect;
    const publicDisciple = (publicSect.disciples as { id: string; avatarHash: string | null }[]).find(
      (item) => item.id === id,
    );
    expect(publicDisciple?.avatarHash).toBe(hash);

    expect((await fetchAvatar(viewer, hash)).status).toBe(200);
  });

  it('未登录取图 401，哈希格式不对 404', async () => {
    const sect = await makeSect('avatar-auth');
    const result = await upload(sect, sect.discipleIds[0]!, 'image/webp', WEBP_A);
    const hash = hashOf((dataOf(result) as Record<string, any>).state, sect.discipleIds[0]!)!;
    expect((await fetchAvatar(null, hash)).status).toBe(401);
    expect((await fetchAvatar(sect, 'not-a-hash')).status).toBe(404);
  });
});
