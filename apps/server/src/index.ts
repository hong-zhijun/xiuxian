import { createApp } from './app';

const app = createApp();

// Worker 入口：只导出 fetch。scheduled（Cron 持久任务）由 P0-05 在此接入。
export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
