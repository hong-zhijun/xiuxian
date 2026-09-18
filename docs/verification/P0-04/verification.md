# P0-04 真实账号、Session 和 CSRF — 验证记录

任务 ID：P0-04
状态：待验收（自测完成，未经独立评审）
日期：2026-09-17
执行环境：Windows 10.0.26200；Node 22.15.1；npm 10.9.2；wrangler 4.133.0；@cloudflare/vitest-pool-workers 0.22.0（内置 workerd 1.20260815.1）；@noble/hashes 2.4.0；PowerShell 5.1
前置：P0-01～P0-03 已完成并通过评审（D17～D21 已确认）。本任务未创建任何云资源、未部署、未提交 Git。

## 1. 修改/新增文件

新增（`apps/server`，本任务主体）：

- `src/config/authConfig.ts`：鉴权运行时变量读取（fail-closed：`REGISTRATION_ENABLED` 只在显式 `'true'` 时开；数值非法回退安全默认；`cookieSecure` 只在 `ENVIRONMENT=production` 时开）。
- `src/modules/auth/state.ts`：`AuthState`（sessionId/userId/csrfTokenHash/expiresAt）与 `UserSummary`。
- `src/modules/auth/tokens.ts`：32 字节随机令牌（base64url）、`sha256` 摘要、常量时间比较（workerd 无 `crypto.timingSafeEqual`）。
- `src/modules/auth/password.ts`：Argon2id 哈希（`@noble/hashes`，`m=19456,t=2,p=1,dk=32`）、`$argon2id$...$salt$hash` 编码/解析、`needsRehash`、`dummyVerify`。
- `src/modules/auth/cookie.ts`：`session`（HttpOnly + SameSite=Lax + Path=/，production 加 Secure）与 `csrf`（同属性但不带 HttpOnly）的设置/清除/读取。
- `src/modules/auth/schema.ts`：注册/登录严格 schema（账号 3～32 位 `[A-Za-z0-9_.-]`、密码 8～128、未声明字段拒绝）与 `normalizeAccount`（trim + 小写）。
- `src/modules/auth/repository.ts`：`UserRepository`、`SessionRepository`、`RateLimitRepository`（D1 单条原子 upsert + `RETURNING count`，固定窗口）。
- `src/modules/auth/service.ts`：注册/登录/会话加载/撤销/CSRF 轮换；限频判定（账号 + 来源 IP 双维度，只统计失败，成功清零）。
- `src/modules/auth/routes.ts`：`/auth/register`、`/auth/login`、`/auth/me`、`/auth/logout`。
- `src/middleware/session.ts`：读 Cookie → 查会话（未撤销、未过期、账号 active）→ 写 `auth`/`currentUser`（未登录为 `null`）。
- `src/middleware/origin.ts`：写请求必须有同源 Origin（`ALLOWED_ORIGINS` 仅本地白名单）。
- `src/middleware/csrf.ts`：默认保护所有非安全方法，只放行 `/api/v1/auth/login`、`/api/v1/auth/register`；已登录写请求要「头值 == Cookie 值」且 `sha256(头值) == sessions.csrf_token_hash`。
- `src/middleware/rateLimit.ts`：桶命名（`login:account:`、`login:ip:`、`register:ip:`，只放 sha256 摘要）与来源 IP 提取（`cf-connecting-ip` → `x-forwarded-for` 首段 → `'unknown'`）。
- `test/support/authClient.ts`：workerd 内测试脚手架（Cookie jar、Origin/CSRF 覆盖、独立来源 IP、`envWith` 变量覆盖）。
- `test/auth-password.test.ts`、`test/auth-account.test.ts`、`test/auth-security.test.ts`：见第 2 节。
- `scripts/accounts/manage.ts`：受控账号工具（`create-user` / `revoke-sessions` / `list-users`）。
- `scripts/tsconfig.json`：`scripts/**` 的独立 TS 工程（node 类型）。
- `tests/scripts/accounts-manage.test.ts`：脚本参数解析与 SQL 转义的单测。
- `migrations/0003_p0_auth_csrf_and_rate_limit.sql`：`sessions.csrf_token_hash`（`DEFAULT ''`）、`sessions_user_id_revoked_idx`、`auth_rate_limits` 表 + `expires_at` 索引。

修改：

- `apps/server/src/app.ts`：装配顺序加入 `sessionLoader` → `originGuard` → `csrfGuard`，并挂载 auth 路由。
- `apps/server/src/http/appError.ts`：`Variables` 增加 `auth`/`currentUser`（未登录为 `null`，不留 `undefined`）。
- `apps/server/src/infra/db/readiness.ts`：必需表加入 `auth_rate_limits`。
- `apps/server/src/infra/db/repository.ts`：仓储基类增加 `execute`（写语句返回 D1 meta）。
- `apps/server/wrangler.jsonc`：新增 `vars`（`ENVIRONMENT`、`REGISTRATION_ENABLED`、`INVITE_CODES`、`SESSION_TTL_SECONDS`、`LOGIN_RATE_LIMIT_MAX_ATTEMPTS`、`LOGIN_RATE_LIMIT_WINDOW_SECONDS`、`ALLOWED_ORIGINS`）。
- `apps/server/.dev.vars.example`：补充鉴权变量清单与 Argon2id/套餐提示。
- `apps/server/worker-configuration.d.ts`：`wrangler types` 重新生成（含新 vars，类型变为字面量，配置读取处统一放宽为 `string`）。
- `apps/server/package.json`：加入 `@noble/hashes@^2.4.0`（移除 hash-wasm 方案）。
- `package.json`：根 `typecheck` 追加 `scripts/tsconfig.json`；新增 `accounts` 脚本；devDependencies 加入 `tsx@4.23.13`。
- `eslint.config.js`：`scripts/**` 的 lint 规则块扩展到 `.ts` 并声明脚本用到的全局。
- `apps/server/test/db-migrations.test.ts`：迁移数断言改为与注入的迁移文件数一致（不再写死）。
- `docs/setup.md`：账号接口、受控账号脚本用法、注册开关、鉴权变量、Argon2id 与套餐要求、第 4/5/6 节更新。
- `开发规划/07-进度与决策记录.md`：P0-03 → 完成，P0-04 状态与证据，新增 D22～D24。

## 2. 验收逐条结果

任务卡验收标准（workerd + 真实 D1 单测；curl 项为 `wrangler dev` + 本地 D1 实测）：

| 验收点 | 结果 | 证据 |
| --- | --- | --- |
| 注册关闭不可绕过 | 通过 | 单测 `auth-account.test.ts > 注册关闭时不可绕过`（带邀请码仍 403 `FORBIDDEN`，用户数不变，无 Set-Cookie）；curl `A1 register-closed status=403 set-cookie=False body={...code=FORBIDDEN,message=当前未开放注册...}`。开关读取 fail-closed：只有 `REGISTRATION_ENABLED === 'true'` 才算开启 |
| 邀请码错误不可注册 | 通过 | curl `B1 register-wrong-invite status=403 set-cookie=False body={...code=FORBIDDEN,message=邀请码无效...}`；`B2 register-ok status=200`（正确邀请码，账号 `Invite-E2E` 规范化落库为 `invite-e2e`） |
| 错密码不泄露账号存在性 | 通过 | curl `A2 login-wrong-password status=401` 与 `A3 login-unknown-account status=401`，两者响应体除 `requestId`/`serverTime` 外逐字相同（`code=UNAUTHENTICATED`、`message=账号或密码不正确`）；单测 `错误密码与不存在的账号返回完全相同的错误` 断言 `errorOf(a) === errorOf(b)` 且响应体键集合相同；账号不存在时执行 `dummyVerify` 保持等价耗时 |
| 登录无需预先持有 session token | 通过 | curl `A4 login-ok status=200`（全新 Cookie jar，无任何 Cookie）；`B5 login-fresh status=200 set-cookie=True`；单测 `登录不需要预先持有 session token，成功后下发新会话` |
| Cookie 属性正确 | 通过 | curl 原始响应头：`session=...; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax`（本地无 Secure）与 `csrf=...; Max-Age=604800; Path=/; SameSite=Lax`（无 HttpOnly，供前端读取）；`ENVIRONMENT=production` 时两者均带 `Secure`（curl `C1`，并输出原始头）；退出时两个 Cookie 都以 `Max-Age=0` 清除（curl `A10`） |
| 令牌只存摘要 | 通过 | 单测断言 `sessions.token_hash !== Cookie 里的令牌`、`csrf_token_hash !== Cookie 里的 csrf 值`，且 `password_hash` 以 `$argon2id$` 开头、不含明文密码；curl 实测 `session`/`csrf` 为 43 字符 base64url，库中只存 sha256 摘要 |
| 退出后失效 | 通过 | curl `A10 logout-ok status=200 {loggedOut:true}` → `A11 me-after-logout status=401 UNAUTHENTICATED`；单测断言退出后 `countActiveForUser == 0` |
| 过期会话失效 | 通过 | 单测 `过期会话失效`：把 `sessions.expires_at` 改成过去时间后 `/auth/me` 返回 401 `UNAUTHENTICATED`（Cookie 与服务端摘要都仍然正确） |
| 跨源写请求不能执行写操作 | 通过 | curl `A7 logout-cross-origin status=403 CSRF_INVALID`（Origin: `https://evil.example`，且带正确 CSRF 头）；`A8 logout-no-origin status=403 CSRF_INVALID`（缺 Origin）；单测覆盖同两项 |
| 已登录但无 CSRF 不能写 | 通过 | curl `A6 logout-no-csrf status=403 CSRF_INVALID`；单测断言此时会话仍有效（`countActiveForUser == 1`），并覆盖「头与 Cookie 不一致」与「值被篡改」两种 403 |
| 未登录写请求返回 401 且不写入 | 通过 | 单测 `未登录的写请求返回 401（而不是 403），且不写入`（会话总数不变） |
| 同源 + 正确 CSRF 可以写 | 通过 | curl `A10`（退出成功）；单测 `同源 + 正确 CSRF 才能执行写操作（退出成功）` |
| 重复账号 | 通过 | curl `B4 register-duplicate status=409 STATE_CONFLICT`（文案「账号不可用（可能已被占用）」，不泄露 SQL/表名）；单测断言用户数不变；并发撞唯一约束时也映射为 409（`isUniqueViolation`） |
| 受控撤销会话（管理脚本路径） | 通过 | `npm run accounts -- revoke-sessions E2E-Controlled` 输出 `活跃会话 1 -> 0`；随后 curl `B0 me-after-script-revoke status=401`（脚本写入立即对运行中的 Worker 生效）；单测 `受控撤销会让所有会话立即失效` 覆盖同一 service 方法 |
| 登录失败限频（跨实例一致） | 通过 | curl `B6 rate-limit statuses=401,401,401,401,401,429`，429 响应含 `details.retryAfterSeconds=60`；curl `B8 register-flood statuses=200,200,200,200,200,429`（注册按 IP 限频）；单测覆盖「账号维度」「IP 维度换账号也挡」「成功登录清零」；计数落在 D1 单条原子 upsert，不含内存 Map |
| 日志无密码 / token / 邀请码 | 通过 | 单测 `日志里没有密码、会话令牌或 CSRF 值`（注入捕获型 logger，断言日志不含密码、session 令牌、csrf 值、邀请码，且事件名与 requestId 保留）；curl 实测：dev 日志中 `password-123456` 命中 0 次、两个 jar 的 `session`/`csrf` 值命中 0 次、邀请码命中 0 次（阶段 A/B 各一次，脚本第 4 节的 `LOG ...` 行） |
| 密码哈希 workerd 兼容性与耗时 | 通过 | 单测 `auth-password.test.ts` 全部通过（哈希/校验、随机盐、篡改与非法编码不放行、编码参数可解析、`needsRehash`、`dummyVerify`）；临时基准（跑完即删）在 workerd 内实测：`m=19456,t=2,p=1,dk=32` 单次哈希中位数 **142.0 ms**（样本 156.0/153.0/138.0/136.0/142.0 ms），校验中位数 **140.0 ms** |
| 受控账号创建（无万能密码、无未鉴权调试接口） | 通过 | `npm run accounts -- create-user E2E-Controlled`（密码经 stdin，未打印；账号规范化为 `e2e-controlled`；输出只含 id/account/status/createdAt 与哈希参数）；`list-users` 只列摘要（不含 `password_hash`）；重复创建同一账号被拒绝；远程目标需 `XIUXIAN_ACCOUNTS_TARGET=remote` + `XIUXIAN_ACCOUNTS_CONFIRM_REMOTE=yes`，否则退出码 1 并拒绝 |
| 禁做项：明文密码 | 通过 | 库中只有 `$argon2id$...`；脚本不打印、不写文件、不放进命令行参数；日志脱敏覆盖 password/token/cookie/csrf/hash/secret 等键名 |
| 禁做项：JWT 放 localStorage | 通过（未使用 JWT） | 会话为随机不透明令牌 + 服务端摘要，Cookie 走 HttpOnly；前端只读 `csrf`（非 HttpOnly）；本任务未引入任何 JWT/localStorage 方案 |
| 禁做项：万能管理密码 / 未鉴权调试接口 | 通过（不存在） | 除 `/auth/*` 与既有 `/health/*`、`/config/public` 外没有新增接口；没有后门口令分支，也没有跳过校验的调试路径 |
| 实现：CSRF 双重提交 + 服务端摘要 | 通过 | 见上表 CSRF 各项；`middleware/csrf.ts` 白名单是本文件里的显式常量，新增写接口默认受保护 |
| 实现：注册开关 / 邀请码（客户端不可绕过） | 通过 | 判定只在 `service.ts`（服务端），且 `parseStrictJson` 先拒绝未声明字段（`isAdmin` 等额外字段 400） |
| 实现：跨实例限频 | 通过 | `auth_rate_limits` + D1 原子 upsert（`INSERT ... ON CONFLICT ... RETURNING count`），无 Worker 内存状态 |
| 实现：严格输入 | 通过 | 单测 `严格输入：短密码、非法账号、未声明字段都返回 400` |
| 范围：只动任务卡指定模块 | 通过 | 见第 1 节；未改技术栈、未引入 ORM/常驻服务、未提前实现 P0-05 的幂等与资产批次 |

## 3. 未执行项（不得视为通过）

1. 远程 Cloudflare 资源（D1 实例、Worker/Pages 项目、secrets、路由、自定义域）未创建、未部署；远程 `wrangler d1 execute --remote` 未执行（脚本对远程有二次确认守卫，自测只验证了「拒绝执行」这一侧）。
2. staging D1 复测、多实例并发限频的真实分布式验证（本地只有单实例 + 单 SQLite）。
3. Workers 真机 CPU 时间计量：本机 workerd 实测约 140 ms/次 Argon2id，`Workers Free 10 ms/请求` 的结论来自套餐文档而非线上计量，**注册/登录需要 Paid 套餐这一点尚未在真实账号上验证**（见 D22）。
4. 浏览器真机（Chrome 109 / Firefox 115 ESR）验证 Cookie 与 CSRF 流程；Playwright/E2E 属 P0-06/P0-07。
5. CI（GitHub Actions）、部署流水线、Cron 清理 `auth_rate_limits`/过期会话（P0-05/P0-07）。
6. 前端接入：`apps/web` 仍只有健康检查骨架，未实现注册/登录页面（属 P0-06）。
7. 密码找回、账号禁用、改密码接口（03/04 未在 P0 定义）。
8. `npm audit` 报 4 个 high 级告警，全部来自 devDependencies 链（`miniflare` → `sharp`，用于本地开发工具）；修正需要 `npm audit fix --force` 降级 `@cloudflare/vitest-pool-workers`，本任务不做，登记待处理（不影响线上 Worker 依赖）。

## 4. 关键命令与退出码

Gate（全部 exit 0）：

| 命令 | 结果 |
| --- | --- |
| `npm ci` | exit 0（安装完成，锁文件可复现；含新增的 `@noble/hashes`、`tsx`） |
| `npm run typecheck` | exit 0（`apps/web` vue-tsc、contracts/game-config/game-core tsc、根 tests/tsconfig、`scripts/tsconfig.json`） |
| `npm run lint` | exit 0（0 error / 0 warning） |
| `npm run test:unit` | exit 0，共 **101** 用例：根级 node 8 文件 / 48 用例 + `apps/server` workerd 8 文件 / 53 用例 |
| `npm run build` | exit 0（web `index-Czj3isCW.js` 61.63 kB / gzip 24.56 kB；server `Total Upload: 2250.54 KiB / gzip: 361.84 KiB`，未 minify） |
| `npm run db:migrate:local` | exit 0（已有本地库只补 0003：`5 commands executed successfully`） |
| `npm run db:check:local-binding` | exit 0（D1 绑定仍是全零哨兵 UUID） |

本任务新增命令：

| 命令 | 结果 |
| --- | --- |
| `'password-123456' \| npx tsx scripts/accounts/manage.ts create-user E2E-Controlled` | exit 0，输出 id/account=`e2e-controlled`/status/createdAt，未打印明文 |
| `npm run accounts -- list-users` | exit 0（当时列出 1 个账号，`活跃会话=0/1` 随流程变化） |
| `npm run accounts -- revoke-sessions E2E-Controlled` | exit 0，输出 `活跃会话 1 -> 0` |
| `$env:XIUXIAN_ACCOUNTS_TARGET='remote'; npm run accounts -- list-users` | **exit 1**，输出「拒绝在远程 D1 上执行：请在命令里同时给出 --remote 与 --confirm-remote」 |
| `npx vitest run test/tmp-password-bench.test.ts`（临时基准，已删除） | exit 0，`hash-median-ms=142.0 verify-median-ms=140.0` |

命令级端到端（`wrangler dev` + 本地 D1，curl；脚本放会话临时目录，不进仓库）：

1. 阶段 A（默认 vars，注册关闭，`--persist-to apps/server/.wrangler/state/dev`，端口 8787）：
   `A1` 注册 403 · `A2` 错密码 401 · `A3` 不存在账号 401（与 A2 同文案）· `A4` 登录 200 + 两个 Cookie · `A5` `/auth/me` 200 · `A6` 退出缺 CSRF 403 · `A7` 跨源 403 · `A8` 缺 Origin 403 · `A9` `/auth/me` 仍 200（被拒的写请求没有副作用）· `A10` 退出 200 · `A11` `/auth/me` 401 · `A12/A13` 再登录 200（供脚本撤销）· `LOG password-hits=0 cookie-token-hits=0 error-lines=0`
2. 脚本撤销（见上表 `活跃会话 1 -> 0`）。
3. 阶段 B（`--var REGISTRATION_ENABLED:true --var INVITE_CODES:invite-alpha`）：
   `B0` 被撤销的会话 401 · `B1` 邀请码错误 403 · `B2` 注册 200 + Cookie（附原始 Set-Cookie 头）· `B3` `/auth/me` 200 · `B4` 重复注册 409 · `B5` 无任何 Cookie 登录 200 · `B6` 5 次失败后 429（`retryAfterSeconds=60`）· `B7` 同一账号换 IP 仍 429（账号维度锁定，见第 6 节）· `B8` 注册 5 次后 429 · `LOG password-hits=0 cookie-token-hits=0 invite-code-hits=0`
4. 阶段 C（`--var ENVIRONMENT:production` + 注册开启）：`C1` 注册 200，原始头 `session=...; Path=/; HttpOnly; Secure; SameSite=Lax`、`csrf=...; Path=/; Secure; SameSite=Lax` · `C2`/`C3` 两个不同 IP、不同账号的错密码各返回 401（互不影响）
5. 收尾：清理本地开发库里本次端到端产生的账号与限频行（`DELETE FROM sessions/auth_rate_limits/users`），`list-users` 回到「（没有账号）」，开发库只剩 seed 数据。

## 5. 过程中发现并修掉的问题（供评审对照）

1. **pool-workers 0.22 不再从 `cloudflare:test` 导出 `Env` 类型**：测试脚手架原本 `import type { Env } from 'cloudflare:test'` 导致 `TS2724`。改为直接使用 `wrangler types` 生成的全局 `Env`，避免两套绑定类型漂移。
2. **注册限频把测试互相打满**：注册按来源 IP 计数（5 次/60 秒固定窗口），测试脚手架默认没有 `cf-connecting-ip`，同一文件内前面的注册用例用光配额后，后续注册被 429 拦掉（表现为用户没建成、登录 401）。修法：测试客户端默认分配独立来源 IP；需要验证限频的用例显式指定 IP（`auth-security.test.ts`）。这一条同时说明该限频对共享出口 IP 的内测用户会有影响（见第 6 节）。
3. **就绪检查漏了 `auth_rate_limits`**：`0003` 新增表后 `REQUIRED_TABLES` 没跟上，`/health/ready` 会在缺表时误报 ready。已加入白名单（`infra/db/readiness.ts`），因此应用 `0003` 之前 ready 返回 503。
4. **迁移数断言写死**：`db-migrations.test.ts` 断言 `appliedMigrations === 2`，加迁移即失败。改为与注入的迁移文件数对齐（`env.TEST_MIGRATIONS.length`），同时仍能验证「全部迁移已应用」。
5. **`wrangler d1 execute --json` 的本地返回没有 `meta.changes`**（只有 `duration`）：脚本最初用它报告「影响会话数」，实测恒为 0（误导）。改为更新前后各查一次活跃会话数并打印 `1 -> 0`，不再依赖 meta。
6. **`npm run` 会吞掉长参数**：`npm run accounts -- revoke-sessions --account x` 里的 `--account` 被 npm 当作自身配置项吞掉（`--remote` 同样），导致脚本收到空白或裸 token。改为支持位置参数 + 环境变量，并把「多余位置参数/未知参数」都做成报错（附单测），避免静默按默认值执行。
7. **PowerShell 传递 JSON body 会被改写**：`curl --data '{"a":1}'` 经 PowerShell 参数绑定后被改写为非法 JSON（服务端返回 400 `BODY_NOT_JSON`，一度看起来像实现缺陷）。改为写临时文件 + `--data-binary @file` 后一切正常——这是验证脚本的问题，不是接口问题，记录下来避免下次误判。
8. **`config` 变量类型是字面量**：`wrangler types` 会把 `ENVIRONMENT: "local"` 生成字面量类型，使「运行时可能被覆盖」的判断在类型上成为恒假。统一用 `readVar(env, key)` 放宽为 `string`。

## 6. 风险与建议评审的决策

1. **D22（建议确认）**：密码哈希选 `@noble/hashes` 的 Argon2id，参数 `m=19456 KiB, t=2, p=1, dk=32`（OWASP 最低建议），编码 `$argon2id$m=..,t=..,p=..,dk=..$salt$hash`（base64url，参数随哈希保存以支持升参 + 登录后自动 rehash）。**本机 workerd 实测约 140～156 ms/次**，远超 Workers Free 的 10 ms/请求 CPU 上限，**因此注册与登录需要 Workers Paid 套餐**。备选方案与实测：PBKDF2-SHA256 600k ≈ 207 ms（更慢），Argon2id(8192,1,1) ≈ 31 ms（仍超 Free，且低于 OWASP 建议）。请确认「上 Paid 套餐」还是「更换更便宜的 KDF 并接受弱化参数」。
2. **D23（建议确认）**：CSRF 用「双提交 + 服务端摘要」（`session` HttpOnly + `csrf` 可读 Cookie + `X-CSRF-Token` 头 + `sessions.csrf_token_hash`），`middleware/csrf.ts` 默认保护所有非安全方法（白名单显式列出登录/注册）；Origin 校验作为第一道防线（写请求必须带同源 Origin），`ALLOWED_ORIGINS` 只用于本地开发。未登录写请求返回 401（不是 403）。
3. **D24（待确认，可延后）**：重复账号注册返回 409 `STATE_CONFLICT`，因此注册接口能区分「账号是否已存在」。当前注册默认关闭 + 邀请码，P0 阶段接受；若后续对外开放注册，需要改为统一文案 + 邮件/人工确认流程。同时**登录限频的账号维度意味着攻击者可在窗口内锁住指定账号**（可用性 vs 暴力破解成本的取舍），需要确认是否接受（可改为纯 IP 维度 + 指数退避）。
4. **风险：注册限频与共享出口 IP**：同一 NAT/校园网内多个内测用户共用来源 IP 时，5 次注册/60 秒的窗口可能误伤（错误提示是 429 + `retryAfterSeconds`）。当前注册是受控邀请制，影响可控；若内测用户集中，需要按邀请码或账号维度放宽。
5. **风险：会话只存摘要但不轮换**：登录会新建会话（不删除旧会话），退出只撤销当前会话；`revoke-sessions` 管理命令可撤销全部。多设备/多标签页会累积有效会话，过期时间统一 7 天（`SESSION_TTL_SECONDS`）。缓存清理与定期清理任务属 P0-05/P0-07。
6. **风险：本地 `wrangler d1 execute` 与运行中的 `wrangler dev` 并发访问同一 SQLite 文件**：本次实测（撤销脚本 + 运行中的 dev）行为正确且无锁错误，但该场景不在平台保证范围内；生产路径是同一个 D1 实例，不存在该问题。

## 7. 下一步

1. 等本次评审：确认 D22（Argon2id 参数与 Workers Paid）、D23（CSRF 机制）、D24（注册枚举与限频取舍）。
2. 评审通过后把 P0-04 标为完成，并从 P0-05（幂等命令 · 资产守恒批次 · 结算钩子）继续；`auth_rate_limits`/`sessions` 的清理任务、可注入 Clock、Cron 都在 P0-05 范围内。
3. 待授权事项（不在本任务内）：创建远程 D1/Worker/Pages 资源、配置 secrets、填充真实 `database_id`、执行远程迁移与部署。
