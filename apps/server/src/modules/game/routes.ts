import { Hono } from 'hono';

import { AppError, authOf, type AppContext, type AppEnv } from '../../http/appError';
import { respondOk } from '../../http/envelope';
import { parseStrictJson } from '../../http/validation';
import { getDb } from '../../infra/db/client';
import {
  assignRequestSchema,
  breakthroughRequestSchema,
  challengeRequestSchema,
  createSectRequestSchema,
  exploreRequestSchema,
  recruitRequestSchema,
  setDefenseLineupSchema,
  upgradeBuildingRequestSchema,
} from './schema';
import {
  assignDisciple,
  breakthrough,
  challengeSect,
  createSect,
  exploreSectRealm,
  getPublicSect,
  getSectState,
  listChallengeHistory,
  listLeaderboard,
  listRecentEvents,
  listSecretRealms,
  previewRecruit,
  recruitDisciple,
  refreshRecruit,
  setDefenseLineup,
  upgradeBuilding,
  upgradeSect,
} from './service';
import type { SectStateView } from './view';

/**
 * 游戏接口（一次性可玩版本，任务卡第二节）。
 *
 * - 全部要求已登录（写请求的 401/CSRF/Origin 由 middleware 统一处理）；
 * - 每个写操作先结算再执行命令（结算逻辑在 service.ts / settle.ts）；
 * - 返回统一的 `{ state }`：前端拿到状态后整体刷新，不做增量合并。
 *
 * 说明：本版本没有幂等键与版本号（任务卡明确「不搞幂等、不搞乐观锁」），
 * 重复提交同一个写请求会重复生效。
 */
export function createGameRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/game/sync', async (c) => {
    const userId = requireUserId(c);
    const state = await getSectState(getDb(c.env), userId, Date.now());
    return respondOk(c, { state });
  });

  // P3：事件历史（最近 20 条，新的在前）；只查库，不做结算。
  routes.get('/game/events', async (c) => {
    const userId = requireUserId(c);
    const events = await listRecentEvents(getDb(c.env), userId);
    return respondOk(c, { events });
  });

  // V2-2：秘境列表（只读：不结算、不写库）。
  routes.get('/game/realms', async (c) => {
    const userId = requireUserId(c);
    const realms = await listSecretRealms(getDb(c.env), userId, Date.now());
    return respondOk(c, { realms });
  });

  routes.post('/game/create-sect', async (c) => {
    const userId = requireUserId(c);
    const body = await parseStrictJson(createSectRequestSchema, c);
    const state = await createSect(getDb(c.env), userId, body.name, Date.now());
    return respondOk(c, { state });
  });

  // V4：招募预览（只读：不结算、不写库；候选人由服务端按确定性 seed 生成）。
  routes.get('/game/recruit-preview', async (c) => {
    const userId = requireUserId(c);
    const preview = await previewRecruit(getDb(c.env), userId, Date.now());
    return respondOk(c, preview);
  });

  // V4：招募三选一（body 的 choice = 0~2，对应预览里的候选人序号）。
  routes.post('/game/recruit', async (c) => {
    const userId = requireUserId(c);
    const body = await parseStrictJson(recruitRequestSchema, c);
    const result = await recruitDisciple(getDb(c.env), userId, body.choice, Date.now());
    return respondOk(c, { state: result.state, outcome: result.outcome });
  });
 
  // 招贤台刷新（免费换一批候选人；每个宗门境界 3 次，升级重置）。请求体为空，不解析 JSON。
  routes.post('/game/recruit-refresh', async (c) => {
    const userId = requireUserId(c);
    const result = await refreshRecruit(getDb(c.env), userId, Date.now());
    return respondOk(c, { state: result.state, preview: result.preview });
  });

  routes.post('/game/assign', async (c) => {
    const userId = requireUserId(c);
    const body = await parseStrictJson(assignRequestSchema, c);
    const state: SectStateView = await assignDisciple(
      getDb(c.env),
      userId,
      body.discipleId,
      body.assignment,
      Date.now(),
    );
    return respondOk(c, { state });
  });

  routes.post('/game/upgrade-building', async (c) => {
    const userId = requireUserId(c);
    const body = await parseStrictJson(upgradeBuildingRequestSchema, c);
    const state = await upgradeBuilding(getDb(c.env), userId, body.defId, Date.now());
    return respondOk(c, { state });
  });

  routes.post('/game/breakthrough', async (c) => {
    const userId = requireUserId(c);
    const body = await parseStrictJson(breakthroughRequestSchema, c);
    const result = await breakthrough(getDb(c.env), userId, body.discipleId, Date.now());
    return respondOk(c, { state: result.state, outcome: result.outcome });
  });

  // 宗门升级没有请求体参数（条件全部由服务端判定），不挂 Zod schema。
  routes.post('/game/upgrade-sect', async (c) => {
    const userId = requireUserId(c);
    const state = await upgradeSect(getDb(c.env), userId, Date.now());
    return respondOk(c, { state });
  });

  // V2-2：探索秘境（结算 → 校验 → 扣入场费 → 出结果，写回一次 batch）。
  routes.post('/game/explore', async (c) => {
    const userId = requireUserId(c);
    const body = await parseStrictJson(exploreRequestSchema, c);
    const result = await exploreSectRealm(
      getDb(c.env),
      userId,
      body.realmId,
      body.discipleIds,
      Date.now(),
    );
    return respondOk(c, { state: result.state, result: result.result });
  });

  // V3：江湖榜（只读：不结算、不写库）；没有宗门时 entries 为空（未创建宗门的用户不报错）。
  routes.get('/game/leaderboard', async (c) => {
    const userId = requireUserId(c);
    const entries = await listLeaderboard(getDb(c.env), userId);
    return respondOk(c, { entries });
  });

  // V3：公开档案（只读：不结算、不写库；只返回安全字段，宗门不存在 404）。
  routes.get('/game/sect/:sectId', async (c) => {
    requireUserId(c);
    const sect = await getPublicSect(getDb(c.env), c.req.param('sectId'));
    return respondOk(c, { sect });
  });

  // 挑战历史（只读：最近 20 条 + 自身视角胜负统计）。
  routes.get('/game/challenge-history', async (c) => {
    const userId = requireUserId(c);
    const history = await listChallengeHistory(getDb(c.env), userId);
    return respondOk(c, history);
  });

  // V5：设置守擂阵容（结算 → 校验归属 → 写回，一次 batch）。
  routes.post('/game/set-defense-lineup', async (c) => {
    const userId = requireUserId(c);
    const body = await parseStrictJson(setDefenseLineupSchema, c);
    const state = await setDefenseLineup(getDb(c.env), userId, body.discipleIds, Date.now());
    return respondOk(c, { state });
  });

  // V5：挑战（结算 → 校验 → 3v3 逐对决斗 → 奖励 + 挑战记录，一次 batch 写回）。
  routes.post('/game/challenge', async (c) => {
    const userId = requireUserId(c);
    const body = await parseStrictJson(challengeRequestSchema, c);
    const result = await challengeSect(
      getDb(c.env),
      userId,
      body.targetSectId,
      body.discipleIds,
      Date.now(),
    );
    return respondOk(c, { state: result.state, result: result.result });
  });

  return routes;
}

/** 取当前登录用户；未登录抛 401（GET 请求没有 CSRF 中间件挡在前面）。 */
function requireUserId(c: AppContext): string {
  const auth = authOf(c);
  if (auth === null) {
    throw new AppError('UNAUTHENTICATED');
  }
  return auth.userId;
}
