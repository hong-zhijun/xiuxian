import { createApp } from './app';
import { getDb } from './infra/db/client';
import { processWorldBoss, settleCurrentRound } from './modules/game/service';

const app = createApp();

// Worker 入口：/api/* 走 Hono，其余请求走 Assets 静态资源（SPA 回退到 index.html）。
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return app.fetch(request, env, ctx);
    }
    return (env as unknown as { ASSETS: Fetcher }).ASSETS.fetch(request);
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const db = getDb(env);
    const now = Date.now();
    // 0024 灵兽竞逐结算与 0025 世界 Boss（出现 / 逃走 / 发奖）各自兜错，互不影响。
    try {
      await settleCurrentRound(db, now);
    } catch (error) {
      console.warn(`settle_current_round_failed error=${String(error)}`);
    }
    try {
      await processWorldBoss(db, now);
    } catch (error) {
      console.warn(`process_world_boss_failed error=${String(error)}`);
    }
  },
} satisfies ExportedHandler<Env>;
