# P0-02 数据库与迁移基座 — 验证记录

任务 ID：P0-02
状态：待验收（自测完成，未经独立评审）
日期：2026-09-17
执行环境：Windows 10.0.26200；Node 22.15.1；npm 10.9.2；wrangler 4.133.0（workerd 1.20260916.1）；@cloudflare/vitest-pool-workers 0.22.0（内置 workerd 1.20260815.1）；PowerShell 5.1
前置：P0-01 已完成并通过评审（证据 `docs/verification/P0-01/verification.md`；D17、D18 已确认）。开始前核对工作树：P0-01 的工程、lockfile、脚本均可用；`migrations/`、`scripts/` 目录此前不存在，本次新建。

## 1. 修改/新增文件

新增：

- `migrations/0001_p0_account_and_command.sql`：users、sessions、command_receipts、mutation_guards（含唯一/CHECK/外键与索引）
- `migrations/0002_p0_server_and_config.sql`：game_servers、config_versions
- `scripts/seed/seed.sql`：幂等种子（只写 game_servers 单服行；不写占位 config 哈希）
- `scripts/db/check-local-binding.mjs` + `scripts/db/check-local-binding.d.mts`：本地 D1 绑定守卫（CLI + 可复用函数）
- `apps/server/src/infra/db/client.ts`：`getDb`（绑定缺失显式抛错，不回退到本地 sqlite）
- `apps/server/src/infra/db/errors.ts`：DbBindingMissingError、MissingSchemaError、`classifyDbError`、`toSafeDbError`（对外消息不含 SQL/表名/连接信息）
- `apps/server/src/infra/db/repository.ts`：`ParamRepository`（参数化 all/one，唯一的 bind 入口）、`SqlValue`、`DbQueryError`
- `apps/server/src/infra/db/repositories.ts`：`GameServerRepository`、`ConfigVersionRepository`
- `apps/server/src/infra/db/readiness.ts`：`REQUIRED_TABLES`、`checkDbReadiness`（sqlite_master 参数化探针 + d1_migrations 计数）
- `apps/server/src/infra/db/index.ts`：barrel
- `apps/server/test/db-migrations.test.ts`：迁移、唯一/CHECK/外键约束、错误映射、seed 幂等、参数化注入
- `apps/server/test/health-ready-unmigrated.test.ts`：未迁移 D1 上 ready 失败、live 正常
- `apps/server/test/support/sql.ts`：测试侧 SQL 拆分/执行辅助
- `apps/server/test/sql-raw.d.ts`、`apps/server/test/test-bindings.d.ts`：`?raw` 与测试绑定类型声明
- `tests/smoke/local-binding-guard.test.ts`：守卫回归（通过/失败路径、BOM 容忍、真实配置自检）
- `tsconfig.json`（根）：把 `tests/` 与根 vitest 配置纳入 typecheck（此前 tests/ 未被类型检查）

修改：

- `apps/server/wrangler.jsonc`：新增 `d1_databases`（binding=DB、database_name=xiuxian-game-db、database_id=全零哨兵 UUID、`migrations_dir=../../migrations`）
- `apps/server/vitest.config.ts`：Node 侧读入 `migrations/` 注入 `TEST_MIGRATIONS` 绑定；注明状态隔离方式
- `apps/server/src/app.ts`：新增 `/api/v1/health/live` 与 `/api/v1/health/ready`（就绪失败 503，不泄露 SQL/表名）；保留 P0-01 的 `/api/health` 待 P0-03/P0-06 迁移
- `apps/server/package.json`：`dev` 固定 `--persist-to .wrangler/state/dev`；新增 `db:check:local-binding`、`db:migrate:local`、`db:seed:local`；`test:unit` 前置执行绑定守卫
- `package.json`（根）：新增同名的 `db:*` 脚本；`typecheck` 追加根级 `tsc`；`test:unit` 覆盖根级与 server
- `eslint.config.js`：为 `scripts/**/*.mjs` 声明 console/process 全局
- `apps/server/worker-configuration.d.ts`：重新生成（现在含 `DB: D1Database`）
- `docs/setup.md`：首次运行步骤、命令清单、D1 状态目录与守卫说明、目录说明
- `开发规划/07-进度与决策记录.md`：P0-01 完成、D17/D18 确认、P0-02 状态与证据

## 2. 验收逐条结果

| 任务卡验收点 | 结果 | 证据 |
| --- | --- | --- |
| 空本地 D1 迁移成功 | 通过 | 全新状态目录 `.wrangler/state/verify-p0-02` 上 `wrangler d1 migrations apply DB --local --persist-to …` 退出码 0：`About to apply 2 migration(s)` → `8 commands executed successfully` → `3 commands executed successfully`，两个迁移均 ✅；迁移后 `p0_tables = 6` |
| seed 重跑不重复 | 通过 | 同一库连续 `db:seed:local` 两次：`game_servers = 1`（`ON CONFLICT (code) DO NOTHING`）；workerd 测试 `seed 幂等：重复执行不新增，也不清掉已有数据` 用相对计数断言「再跑一次不新增、手工插入的 s-extra 不被删除」 |
| 生产/未知远程绑定执行测试立即失败 | 通过 | `db:check:local-binding` 在 `test:unit` 前自动执行；真实配置 exit 0。派生变体：换真实 `database_id`→exit 1、`remote: true`→exit 1、缺 `migrations_dir`→exit 1、缺 `d1_databases`→exit 1（见第 4 节命令输出）。守卫逻辑另有 6 个回归用例 |
| 模拟 D1 异常时 ready 失败、live 仍能响应 | 通过 | 未迁移的真实本地 D1（非 mock）→ `GET /api/v1/health/ready` 503（`TEMPORARILY_UNAVAILABLE` / `DB_SCHEMA_NOT_READY`），同一时刻 `GET /api/v1/health/live` 200；workerd 测试 `health-ready-unmigrated.test.ts` 覆盖同一场景 |
| 范围：DB binding、migrations/*.sql、infra/db 参数化仓储、本地 D1 测试状态、seed | 通过 | 见第 1 节文件清单；参数化读取由 `GameServerRepository`/`ConfigVersionRepository` 经 `ParamRepository` 唯一 bind 入口执行 |
| 实现：INTEGER 时间、外键/CHECK/唯一约束、ready 检查 DB、幂等 seed 不清存档 | 通过 | 迁移中时间列均为 `INTEGER`；`SqlValue` 只允许 string/number/null（不绑 BigInt，见 02 第 4 节）；约束由 workerd 测试逐条验证；`checkDbReadiness` 走 sqlite_master + d1_migrations；seed 不含 DELETE/UPDATE/DROP |
| 实现：开发与测试状态目录隔离 | 通过 | 开发/迁移/seed：`apps/server/.wrangler/state/dev`（验证后确认仍存在）；测试：pool 的 workerd 内存存储，不落盘；临时验证目录已删除 |
| 实现：ready 与 live 端点 | 通过 | `/api/v1/health/live`、`/api/v1/health/ready` 均已实现并测试（04 第 3 节路径） |
| 测试：在 workerd/D1 中验证迁移、唯一约束、错误映射、seed 重跑 | 通过 | `npm run test:unit` 退出码 0：根级 8 用例（包导入 1 + 绑定守卫 7），server 14 用例（路由 3 + 未迁移健康检查 2 + 迁移与约束 9） |
| 禁做：Docker/PostgreSQL 安装要求 | 通过 | 全程未使用；本地只用 wrangler 模拟的 D1 |
| 禁做：ORM 自动清库 | 通过 | 未引入 ORM；迁移只做 CREATE，seed 只做幂等 INSERT；无任何清库脚本 |
| 禁做：用普通 SQLite 驱动冒充 D1 | 通过 | 测试在 workerd 内通过 `cloudflare:test` 的 `env.DB` 执行，未使用 better-sqlite3/sqlite3 等驱动 |
| 禁做：默认连远程生产 | 通过 | `database_id` 为全零哨兵值；守卫断言无 `remote`/`experimental_remote`；所有 d1 命令显式 `--local` |

## 3. 未执行项（不得视为通过）

- 未创建任何远程 D1、未执行 `--remote` 迁移、未做 staging 远程复测（需授权；P5 前需复测 batch 回滚与幂等）。
- 未做真实连接级故障注入（例如 D1 网络中断/SQLITE_IOERR）；本任务验证的是「表缺失」这一真实异常路径，不含平台故障演练（属 P6 灾备）。
- 未验证 d1 配额、语句大小、单次查询/CPU 预算（P0/P6 复核官方当期限制）。
- 未实现 `command_receipts` 过期清理任务（P0-05 持久任务；本任务只建索引与约束）。
- `test:integration` / `test:e2e` 脚本与 CI（含绑定类型新鲜度、deploy dry-run）仍属 P0-07，本次未创建。
- 未做资源数值（1 单位 = 1000 最小单位）与安全整数上限的实现，属 P1 资源结算；本任务只保证列类型与绑定类型不收 BigInt。
- 未执行旧浏览器真机、Playwright、远程部署验收。

## 4. 关键命令与退出码

```text
npm run db:check:local-binding                      exit 0
  ✅ 本地 D1 绑定检查通过：binding=DB database_id=00000000-0000-0000-0000-000000000000 migrations_dir=../../migrations
守卫失败路径（变体配置写在 scratch，不修改仓库文件）：
  [exit=0] 仓库真实配置
  [exit=1] 换成真实 database_id → "D1 database_id 不是本地哨兵值（期望 …，实际 1111…）"
  [exit=1] 标记 remote: true   → "D1 绑定 \"DB\" 被标记为 remote，测试不允许连接远程库"
  [exit=1] 删掉 migrations_dir → "D1 绑定 \"DB\" 必须声明 migrations_dir"
  [exit=1] 删掉 d1_databases   → "缺少 d1_databases 绑定，本地/测试无法访问 D1"

npm run cf:types                                    exit 0（生成含 DB: D1Database 的 Env）
npm run typecheck                                   exit 0（server/web/3 packages + 根级 tests）
npm run lint                                        exit 0（0 error / 0 warning）
npm run test:unit                                   exit 0
  根级：Test Files 2 passed / Tests 8 passed
  server：Test Files 3 passed / Test Files 3 passed / Tests 14 passed
npm run build                                       exit 0（web 13 modules；server Total Upload: 66.73 KiB）

本地 D1 生命周期（wrangler CLI，全新状态目录 .wrangler/state/verify-p0-02）：
  未迁移：GET /api/v1/health/live → 200 {"ok":true,…}；GET /api/v1/health/ready → 503
          {"ok":false,"error":{"code":"TEMPORARILY_UNAVAILABLE","message":"数据库结构未就绪（迁移未应用）","details":{"reason":"DB_SCHEMA_NOT_READY"}}}
  wrangler d1 migrations apply DB --local --persist-to …            exit 0（8 + 3 commands，2 个迁移 ✅）
  wrangler d1 execute … --file scripts/seed/seed.sql（第 1 次）       success: true
  wrangler d1 execute … --file scripts/seed/seed.sql（第 2 次）       success: true
  查询：game_servers = 1，p0_tables = 6
  已迁移：GET /api/v1/health/live → 200；GET /api/v1/health/ready →
          {"ok":true,"data":{"status":"ready","appliedMigrations":2},…}；未知 API → JSON 404
  之后删除验证用状态目录；apps/server/.wrangler/state/dev 保留
清理：taskkill 后 8787 无监听残留
```

## 5. 环境与状态目录记录

| 用途 | 位置 | 说明 |
| --- | --- | --- |
| 开发（dev / migrate / seed） | `apps/server/.wrangler/state/dev` | 由 `--persist-to` 显式指定，避免与他人默认目录混用 |
| 集成测试（workerd） | workerd 内存存储 | 不落盘；pool-workers 0.22 起无逐用例回滚，测试必须自建独立主键（已写入测试注释与 docs/setup.md） |
| 本次验证临时目录 | `apps/server/.wrangler/state/verify-p0-02` | 验证结束后已删除，未污染开发状态 |

## 6. 风险与建议评审的决策

1. **pool-workers 0.22 取消逐用例回滚**：同一测试文件内数据累积，P0-04/P0-05 的测试必须按「独立主键 / 相对计数」书写；涉及并发写同一行的用例需要显式清理或使用独立账号/宗门 ID。已写入 `apps/server/test/db-migrations.test.ts` 头部注释与 `docs/setup.md`。
2. **新建约定（建议记为决策）**：表名用复数 snake_case（`users`/`sessions`/`command_receipts`/`mutation_guards`/`game_servers`/`config_versions`），列名 snake_case，`CommandReceipt.key` 落库为 `idempotency_key`（避开 SQL 关键字）；迁移文件头部已写明实体名 ↔ 表名映射。请在评审时确认该命名约定，或给出统一改名要求（改名越晚成本越高）。
3. **哨兵 database_id 与守卫**：`database_id` 固定为全零 UUID，并新增绑定守卫；接远程库必须先取得授权并同步更新守卫、05/07 记录。这样「误连生产库跑测试」会立即失败，但也意味着**任何**远程 D1 接入都会被守卫拦下，需要显式改守卫文件。
4. **ready 的判定范围**：当前 ready = 连接可用 + 6 张 P0 表存在 + `d1_migrations` 可读，不检查 seed（引用数据缺失不应让服务不可用）。若希望「未 seed 也算未就绪」，需在评审中明确。
5. `command_receipts` 目前只有 `expires_at` 索引，没有清理任务；P0-05 接入持久任务后补，避免现在写一个没有调度来源的死代码。
5. `command_receipts` 目前只有 `expires_at` 索引，没有清理任务；P0-05 接入持久任务后补，避免现在写一个没有调度来源的死代码。
6. **评审确认（2026-09-17）**：D19（命名约定）与 D20（哨兵 database_id + 守卫）已由用户确认；P0-02 状态改为「完成」。本节第 2 项不再是待决项。
## 7. 下一步

- 评审本任务（重点：命名约定、ready 判定范围、守卫策略），确认第 6 节的 2/3 两项是否登记为正式决策。
- 通过后执行 P0-03（contracts、game-config、Hono 错误中间件与结构化日志）。
