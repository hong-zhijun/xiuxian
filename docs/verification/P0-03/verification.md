# P0-03 契约、配置和统一错误 — 验证记录

任务 ID：P0-03
状态：待验收（自测完成，未经独立评审）
日期：2026-09-17
执行环境：Windows 10.0.26200；Node 22.15.1；npm 10.9.2；wrangler 4.133.0；@cloudflare/vitest-pool-workers 0.22.0；zod 4.6.5；PowerShell 5.1
前置：P0-02 已完成并通过评审（证据 `docs/verification/P0-02/verification.md`；D19、D20 已确认）。开始前核对：`packages/*` 仍是 P0-01 的占位模块，D1 迁移/仓储/就绪检查可用，`/api/v1/health/live|ready` 已存在但用的是占位响应包。

## 1. 修改/新增文件

新增（`packages/contracts`，P0-03 的主体）：

- `src/primitives.ts`：最小单位十进制字符串（含 1e15 上限与安全整数转换/反向格式化）、基点 0～10000、稳定 id、UTC ISO 时间（毫秒 + Z）、幂等键（8～128 可打印非空白）、游标与分页（默认 20、上限 100）
- `src/errors.ts`：04 第 2 节的 16 个错误码、错误码→HTTP 状态映射、默认中文文案、`apiErrorSchema`
- `src/envelope.ts`：`ApiResponse<T>` 的成功/失败包 schema 与 TS 类型，`requestId` 为 UUID
- `src/index.ts`：barrel

新增（`packages/game-core`）：

- `src/config/canonical.ts`：规范化 JSON（键排序、数组保序、拒绝 undefined/NaN/BigInt，带字段路径的错误信息）
- `src/config/hash.ts`：`sha256:` 前缀的内容哈希（摘要函数注入，game-core 不接触平台全局）
- `src/config/schema.ts`：严格 Zod schema（资源/建筑/岗位/宗门初始值/招募/修炼/突破/服务器/离线上限）
- `src/config/validate.ts`：schema + 语义（重复 id、引用缺失、成本与范围）+ 哈希三道校验，`ConfigValidationError` 汇总全部问题
- `src/config/publicView.ts`：公开配置白名单投影（未列出的 section 默认不公开；`visibility: internal` 条目剔除）
- `src/index.ts`：导出 config 模块

新增（`packages/game-config`）：

- `src/index.ts`：版本 `p0.1.0`、内容哈希、基线配置内容（数值出处逐条标注为 03 的测试基线）

新增（`apps/server`）：

- `src/http/appError.ts`（AppEnv / AppError）、`envelope.ts`（成功/失败响应包构造）、`validation.ts`（严格 query/JSON 校验 → 400）、`requestContext.ts`（requestId、计时、成功路径访问日志）、`errorHandler.ts`（统一错误处理与 404）
- `src/infra/logging/redact.ts`、`logger.ts`：结构化 JSON 日志与键名脱敏
- `src/infra/crypto/sha256.ts`：Web Crypto 摘要适配层
- `src/config/loadGameConfig.ts`：启动期配置校验（顶层 await）与公开投影
- `src/modules/system/routes.ts`：health live/ready 与 config/public

新增（测试）：

- 根级：`tests/contracts/primitives.test.ts`、`tests/contracts/envelope.test.ts`、`tests/game-core/config-validation.test.ts`、`tests/game-core/config-public-view.test.ts`、`tests/game-config/config-integrity.test.ts`
- `apps/server/test/`：`app.test.ts`（改写）、`error-mapping.test.ts`、`logging.test.ts`、`support/memoryLogger.ts`

修改：

- `apps/server/src/app.ts`：改为装配层（no-store → 请求上下文 → `/api/v1` 路由 → 统一 404/错误处理），退役 `/api/health`
- `apps/server/src/infra/db/errors.ts` / `repository.ts`：`DbQueryError` 移到错误模块，仓储从那里导入
- `apps/web/src/api/system.ts`：改调 `/api/v1/health/live`，按新响应包读取
- `packages/*/package.json`、`apps/server/package.json`：加入 zod 与 workspace 依赖
- `scripts/seed/seed.sql`：新增 `config_versions` 行（版本 + 内容哈希，P0-02 曾把这一步留给 P0-03）
- `tsconfig.json`（根）：`types: ["node"]`（根级测试用 node:fs / Web Crypto）
- `docs/setup.md`：接口形状、配置哈希维护、目录与体积说明
- `开发规划/07-进度与决策记录.md`：P0-02 完成、D19/D20 确认、P0-03 状态与证据

## 2. 验收逐条结果

| 任务卡验收点 | 结果 | 证据 |
| --- | --- | --- |
| 多余字段返回固定格式 | 通过 | `GET /api/v1/config/public?unexpected=1` → 400 `{"ok":false,"error":{"code":"VALIDATION_ERROR","message":"请求参数不合法","details":{"fields":[{"path":"unexpected","message":"Unrecognized key: \"unexpected\""}]}},"requestId":...,"serverTime":...}`；schema 级用例见 `tests/contracts/primitives.test.ts` 与 `tests/contracts/envelope.test.ts`（成功包/失败包拒绝未声明字段） |
| 错误数字返回固定格式 | 通过 | 金额字符串拒绝前导零/负数/小数/科学计数法/超上限；基点拒绝 -1、10001、1.5、字符串；分页 limit 拒绝 0/101；UTC 时间拒绝秒级与偏移格式（用例覆盖，见第 4 节命令） |
| 内部异常不泄露堆栈/SQL | 通过 | 探针路由抛 `boom: SELECT * FROM users WHERE password_hash = ?` → 响应 500 `INTERNAL_ERROR`、`message` 为固定文案、无 details；响应文本经断言不含 `SELECT`/`password_hash`/`boom`/`at `；数据库缺表 → 503 `TEMPORARILY_UNAVAILABLE`/`DB_UNAVAILABLE`，响应不含表名与 `no such table`；排查信息只出现在日志（同一 requestId） |
| 无效配置启动失败 | 通过 | 临时把 `offlineCapSeconds` 改成 0（语义 invalid_range）后 `wrangler dev` 起不来：日志 `Uncaught Error: ConfigValidationError: 游戏配置校验失败（1 项）：offlineCapSeconds`，请求无响应（curl HTTP 000）；恢复后 SHA256 与改前一致且完整性测试仍通过 |
| 公开配置不暴露隐藏奖励 | 通过 | `/config/public` 只返回 9 个白名单 section；`tests/game-core/config-public-view.test.ts` 用夹具 section（`events` + `hiddenRewards`/`weight`/`rngSeed`）验证未知 section 被整体剔除；`visibility: internal` 条目被剔除且投影中不出现 `internal` 字样 |
| 范围：contracts、game-config、game-core/config | 通过 | 见第 1 节；`packages/*` 仍只暴露 TS 源码，无独立构建 |
| 范围：Hono 错误中间件与 Workers 结构化日志 | 通过 | `errorHandler.ts` 分类映射 AppError / DbQueryError / 其他；`logger.ts` 输出单行 JSON（level/event/time/requestId/...），`redact.ts` 按键名打码；每个请求恰好一行日志（成功 `http_request`、业务错误 `http_error`、未预期 `unhandled_error`、未知路由 `http_not_found`） |
| 实现：04 的响应包与错误码 | 通过 | 全部响应（含错误与 404）都带 `ok`/`data|error`/`requestId`/`serverTime`；错误码与状态映射与 04 第 2 节逐条一致（用例固化了整张映射表） |
| 实现：严格输入 schema | 通过 | query 与 JSON body 一律 strictObject 校验；校验失败只回字段路径与原因，不回显原始值 |
| 实现：UTC 时间与资源字符串类型 | 通过 | `utcIsoTimeSchema` 只接受 `toISOString()` 形状；金额用最小单位十进制字符串并提供 BigInt→安全整数转换与越界拦截 |
| 实现：configVersion 加哈希校验 | 通过 | `validateGameConfig` 在启动期比对内容哈希；篡改内容不改哈希会抛 `hash_mismatch`；`config_versions` 种子行与 `GAME_CONFIG_PAYLOAD_HASH` 由测试断言一致 |
| 实现：配置引用/重复 ID/负成本检查 | 通过 | 重复 id（资源/建筑/岗位）、未知引用（成本资源、岗位产出、初始建筑、初始岗位）、免费升级与空成本表、容量小于初始值、初始等级超上限、突破概率顺序、满资质系数超上限，均有专门用例 |
| 实现：requestId、日志脱敏 | 通过 | requestId 服务端生成（UUID）且与日志一致；脱敏覆盖 password/passwordHash/token/tokenHash/cookie/authorization/csrf/apiKey/secret/hash，含嵌套对象与数组 |
| 测试：schema 边界、错误映射、敏感字段脱敏、配置破损 | 通过 | `npm run test:unit` 退出码 0：根级 40 用例、apps/server 22 用例（详见第 4 节） |
| 禁做：把 Zod 验证只放前端 | 通过 | 校验在 Worker（`parseStrictQuery`/`parseStrictJson`）与启动期配置加载中执行；前端只做展示 |
| 禁做：把所有数据模型直接当公开 DTO | 通过 | 公开配置走白名单投影；响应包由 `ApiSuccess<T>`/`ApiError` 显式构造，没有把数据库行直接序列化 |

## 3. 未执行项（不得视为通过）

- 未接入鉴权/CSRF/限频（P0-04）：所有当前端点都是公开或运维端点，`UNAUTHENTICATED`/`CSRF_INVALID`/`RATE_LIMITED` 等错误码已定义但尚无触发路径。
- 未实现 `Idempotency-Key` 处理与 `CommandReceipt` 写入（P0-05）。
- 未做 Playwright/E2E 与真机浏览器验证；前端骨架只做了类型与代理链路层面的适配。
- 未创建任何 Cloudflare 远程资源，未验证 Workers Observability 的实际上报格式（只验证了本地 console 输出）。
- 未做响应包的性能/体积压测；未把 `/config/public` 的响应做缓存或 ETag（按 02 要求 API 一律 `no-store`）。
- 未做 `packages/*` 的独立单测运行器（根级 vitest 统一跑），也未接入 CI（P0-07）。

## 4. 关键命令与退出码

```text
npm install                                       exit 0（zod 4.6.5 装入 contracts/game-core）
npm run typecheck                                 exit 0（server + web + 3 packages + 根级 tests）
npm run lint                                      exit 0（0 error / 0 warning）
npm run test:unit                                 exit 0
  根级：Test Files 7 passed / Tests 40 passed
  apps/server：Test Files 5 passed / Tests 22 passed
npm run build                                     exit 0（web 13 modules；server Total Upload: 2188.84 KiB / gzip: 345.26 KiB，未 minify）
npm run cf:types                                  exit 0

接口行为（wrangler dev + 本地 D1，见第 5 节脚本）：
  GET /api/v1/health/live
    {"ok":true,"data":{"status":"live","configVersion":"p0.1.0"},"requestId":"0eade14c-...","serverTime":"2026-09-17T08:17:26.128Z"}  HTTP 200
  GET /api/v1/health/ready
    {"ok":true,"data":{"status":"ready","appliedMigrations":2,"configVersion":"p0.1.0"},"requestId":"...","serverTime":"..."}  HTTP 200
  GET /api/v1/config/public
    {"ok":true,"data":{"version":"p0.1.0","config":{"server":{...},"offlineCapSeconds":43200,"resources":[...],...}},...}  HTTP 200
  GET /api/v1/config/public?unexpected=1            HTTP 400 VALIDATION_ERROR（details.fields[0].path = unexpected）
  GET /api/v1/config/public?version=p9              HTTP 404 NOT_FOUND
  GET /api/v1/nope                                  HTTP 404 NOT_FOUND（JSON，非 HTML）
  GET /api/health                                   HTTP 404（已退役）
  响应头：Content-Type: application/json、Cache-Control: no-store
  日志行示例：
    {"level":"info","event":"http_request","time":"...","requestId":"c3b887ba-...","method":"GET","path":"/api/v1/config/public","status":200,"durationMs":0}
    {"level":"warn","event":"http_error","time":"...","requestId":"b5bc1497-...","method":"GET","path":"/api/v1/config/public","durationMs":1,"status":400,"code":"VALIDATION_ERROR"}

无效配置启动失败（临时注入 offlineCapSeconds = 0，随后恢复）：
  live HTTP=000（无响应）
  dev 日志：X [ERROR] service core:user:xiuxian-game-server: Uncaught Error: ConfigValidationError: 游戏配置校验失败（1 项）：offlineCapSeconds
  恢复后 config SHA256=0FD9464CB78B7EA33B861A57E163D57C2596CA78E260DBC7DF74951A4C0EC80E（与注入前一致），config-integrity 4/4 通过
```

## 5. 过程中发现并修掉的问题（供评审对照）

1. **Zod 4 的 refine 会在前面的检查失败后继续执行**，导致 `decimalAmountSchema` 对 `'1.5'` 调用 `BigInt` 抛 `SyntaxError`——那会把一个本该 400 的输入变成 500。已改为先确认格式再转换，并加了边界用例。
2. **错误请求被记两行日志**：Hono 在 `onError` 生成响应后，中间件的 `await next()` 仍会正常返回，导致错误请求同时出现 `http_error` 与 `http_request`。已改为中间件只记 2xx/3xx，错误路径由 errorHandler/notFound 各记一行。
3. **严格对象拒绝未声明参数时 Zod 的 issue 没有 path**，原实现只回 `(root)`；已把 `keys` 作为字段路径回给客户端（例如 `unexpected`）。
4. **`TextEncoder` 出现在 game-core** 违反了「不依赖平台全局」的约束；已把 `DigestFn` 改为接收字符串，UTF-8 编码下沉到 `apps/server/src/infra/crypto/sha256.ts`。

## 6. 风险与建议评审的决策

1. **配置哈希规范（建议记为决策）**：`sha256:` 前缀 + 规范化 JSON（键排序、数组保序）作为配置内容哈希；`packages/game-config` 常量、`config_versions` 种子行、Worker 启动校验三处必须一致，由 `tests/game-config/config-integrity.test.ts` 把关。更改算法或规范化规则会使所有哈希失效，需按 03 第 12 节的配置迁移流程处理。
2. **`/api/health` 退役**：P0-01 的临时健康检查已删除，前端骨架改调 `/api/v1/health/live`。P0-01 验证记录里的该端点描述随之失效（历史记录保留不改）。
3. **Worker 包体积**：引入 Zod 后 `wrangler deploy --dry-run` 从 66 KiB 涨到 2.1 MiB（gzip 345 KiB，未 minify）。未超平台限制，但建议在 P0-07/P6 决定是否开启 `minify` 或改为按需引入（zod/mini），并建立体积预算检查。
4. **公开配置里保留了 `visibility` 字段**：公开投影按白名单剔除 internal 条目，但保留 `visibility: 'public'` 标记本身（便于前端与配置对照）。如果不想暴露该字段，需要在投影里再剥一层——请在评审时确认。
5. **ready 的判定范围未变**：仍是「连接可用 + 6 张 P0 表 + d1_migrations」，不检查 seed；`configVersion` 只作为运行时版本信息返回，不参与就绪判定（哈希一致性已在启动期强制）。

## 7. 下一步

- 评审本任务（重点：配置哈希规范、`/api/health` 退役、包体积与 `visibility` 字段处理）。
- 通过后执行 P0-04（真实账号、Session、CSRF 与限频）。
