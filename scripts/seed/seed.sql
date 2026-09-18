-- 本地开发用种子数据（幂等：重复执行不新增、不修改、不删除任何已有行）。
-- 用法：npm run db:seed:local
--
-- 只包含 P0 阶段必须存在的引用行：
--   game_servers：单服（D03 同服一账号一宗门），自然日/周按 UTC+8 划分
--   config_versions：当前配置版本与内容哈希（P0-03 落地，来源 packages/game-config）
-- 哈希必须与 packages/game-config 的 GAME_CONFIG_PAYLOAD_HASH 一致，
-- 由 tests/game-config/config-integrity.test.ts 断言（改配置不改哈希会失败）。
--
-- 注意：本文件不得包含 DELETE/UPDATE/DROP；seed 不允许清空或回滚玩家存档。

INSERT INTO game_servers (id, code, time_zone, created_at)
VALUES ('s1', 's1', 'UTC+8', CAST(strftime('%s', 'now') AS INTEGER) * 1000)
ON CONFLICT (code) DO NOTHING;

INSERT INTO config_versions (id, version, payload_hash, created_at)
VALUES (
  'cfg-v2.1.0',
  'v2.1.0',
  'sha256:4cc6206898464139a8a2e978766ab18ab946f5a8c0ba5b56e651759e56fb9141',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
ON CONFLICT (version) DO NOTHING;
