# 本地开发环境与运行说明

本文件覆盖 P0-01「工程初始化与版本锁定」的交付内容。**本地开发不需要 Docker、不需要 PostgreSQL、不需要 Cloudflare 账号，也不需要任何常驻 Node 后端进程。**

- 前端：Vue 3 + Vite，开发时由 Vite dev server 提供（生产部署到 Cloudflare Pages）
- 后端：Cloudflare Workers + Hono，开发时由 `wrangler dev` 在本地 workerd 中运行
- 数据库：Cloudflare D1（本地由 Wrangler 模拟；绑定与迁移由 P0-02 添加）
- 工具：npm workspaces + Wrangler

## 1. 环境要求

| 项目 | 要求 | 本机实测值 |
| --- | --- | --- |
| Node.js | `>=22.13.0`（Vite 8 要求 `^20.19.0 \|\| >=22.12.0`；Wrangler 4 与 concurrently 要求 `>=22`） | 22.15.1 |
| npm | 任意；npm 10 需要仓库内 `.npmrc`（见第 5 节） | 10.9.2 |
| Git | 任意（仓库已 `git init`，未提交任何内容） | 2.49.0.windows.1 |
| Docker / PostgreSQL | **不需要** | 未安装、未使用 |

Windows 7 只是玩家浏览器兼容目标（Chrome 109 / Firefox 115 ESR），开发机使用受支持的现代系统。

## 2. 版本基线（P0-01 锁定，`package-lock.json` 已提交）

| 包 | 版本 | 说明 |
| --- | --- | --- |
| vue | 3.5.42 | 前端框架 |
| vite | 8.3.0 | 前端构建（`build.target = ['chrome109','firefox115']`） |
| @vitejs/plugin-vue | 6.0.9 | peer 要求 `vite ^5~^8` |
| vue-tsc | 3.3.11 | 前端类型检查 |
| hono | 4.13.8 | Worker 路由 |
| wrangler | 4.133.0 | 本地 workerd、构建、类型生成（自带 workerd 1.20260916.1） |
| @cloudflare/vitest-pool-workers | 0.22.0 | 在 workerd 内跑测试（内置 miniflare 5.20260815.0-alpha / workerd 1.20260815.1） |
| vitest | 4.1.11 | pool-workers 0.22 的 peer 要求 `^4.1.0`，故不能用 5.x |
| typescript | 5.9.3 | typescript-eslint 8.70.0 的 peer 上限是 `<6.1.0`，因此暂不上 TS 6/7 |
| eslint | 10.10.0 | |
| typescript-eslint | 8.70.0 | 支持 `eslint ^10` |
| eslint-plugin-vue | 10.11.0 | |
| vue-eslint-parser | 10.4.1 | |
| concurrently | 10.0.5 | `npm run dev` 并行启动 |
| @types/node | 22.20.3 | |
| @noble/hashes | 2.4.0 | Argon2id 密码哈希与会话/CSRF 摘要（纯 TS，无原生二进制；P0-04 引入） |
| tsx | 4.23.13 | 直接运行 `scripts/**` 下的 TypeScript（受控账号脚本；仓库根 devDependency） |
| compatibility_date | `2026-08-22` | 见第 5 节，取工具链共同支持上限 |
| zod | 4.6.5 | 请求/配置/事件 DSL 校验（P0-03 引入，contracts 与 game-core 各自依赖） |

`apps/server` 依赖 `@xiuxian/contracts`、`@xiuxian/game-config`、`@xiuxian/game-core`（workspace 链接，随 Worker 一起打包）。

## 3. 首次运行

```powershell
npm ci                 # 按 lockfile 安装（可复现）
npm run cf:types       # 生成 apps/server/worker-configuration.d.ts（绑定/运行时类型）
npm run db:migrate:local   # 在本地 D1（.wrangler/state/dev）应用 migrations/
npm run db:seed:local      # 幂等写入引用数据（可重复执行）
npm run dev            # 并行启动 wrangler dev(127.0.0.1:8787) 与 vite(localhost:5173)
```

浏览器打开 **http://localhost:5173**。页面上点击「获取服务器时间」，看到 UTC 时间字符串即说明 Vite 代理 → Worker 链路正常。

接口形状（P0-03 起统一，见 04 第 1、2 节）：

- 成功：`{ ok: true, data, requestId, serverTime }`；失败：`{ ok: false, error: { code, message, details? }, requestId, serverTime }`。
- `requestId` 由服务端生成（不接受客户端指定），与结构化日志里的 `requestId` 一致；
  `serverTime` 是本次请求的服务端 UTC 时间。
- `GET /api/v1/health/live`：只表示 Worker 能响应，不查数据库。
- `GET /api/v1/health/ready`：D1 连接可用且 P0 迁移已应用；未迁移时 503（响应不含 SQL、表名或连接信息）。
- `GET /api/v1/config/public`：只返回白名单 section 的公开配置（不含 internal 条目）；未知版本 404；未声明查询参数 400。
- 原 `/api/health` 已退役（返回 404 错误包），前端骨架改用 `/api/v1/health/live`。

账号接口（P0-04，见 04 第 3 节）：

- `POST /api/v1/auth/register`：受 `REGISTRATION_ENABLED` 与 `INVITE_CODES` 双重控制。关闭时（默认）即使用邀请码也返回 403 `FORBIDDEN`、不写库；开启后邀请码不匹配同样 403；账号重复返回 409 `STATE_CONFLICT`。成功后下发 `session` + `csrf` Cookie。
- `POST /api/v1/auth/login`：**不需要预先持有任何会话令牌**；失败统一返回 401 `UNAUTHENTICATED`「账号或密码不正确」（不区分账号不存在 / 密码错误），账号不存在时也走一次等价的 Argon2id 计算以避免用耗时枚举账号。
- `GET /api/v1/auth/me`：需要有效会话，返回 `{ user, sect, csrfToken }`（`sect` 在 P1 宗门系统之前恒为 `null`）；未登录 401。
- `POST /api/v1/auth/logout`：需要会话 + 同源 Origin + `X-CSRF-Token`，成功返回 `{ loggedOut: true }` 并清除两个 Cookie。

注册默认关闭，内测账号通过受控脚本创建（密码只以 Argon2id 哈希入库，脚本不打印明文）：

```powershell
# 交互式：隐藏回显，要求输入两次
npm run accounts -- create-user <账号>
# 非交互（管道）：密码从 stdin 读取一行
'<密码>' | npx tsx scripts/accounts/manage.ts create-user <账号>
npm run accounts -- list-users            # 只列摘要（账号/状态/活跃会话/创建时间）
npm run accounts -- revoke-sessions <账号> # 撤销该账号全部活跃会话
```

临时打开注册（不改仓库文件，用 `wrangler dev` 的变量覆盖）：

```powershell
cd apps/server
npm run dev -- --var REGISTRATION_ENABLED:true --var INVITE_CODES:invite-alpha
```

生产/预发环境用 `wrangler secret put` 或环境变量覆盖同名 `vars`（`ENVIRONMENT=production` 时 Cookie 自动带 `Secure`）。鉴权变量清单见 `apps/server/.dev.vars.example`。

注意：

- Vite 默认绑定 `localhost`（本机解析为 `::1`），请用 `localhost` 而不是 `127.0.0.1` 访问前端。
- 两个服务是并行启动的：若页面在 Worker 就绪前发出请求，会看到一次 `ECONNREFUSED 127.0.0.1:8787` 的代理错误，刷新后正常；前端加载/失败状态由 P0-06 处理。
- 迁移/seed 前不必先跑 dev：两者都作用于同一开发状态目录，命令本身不启动服务器。

## 4. 命令清单

命令清单（P0-01 + P0-02 实测）：

| 命令 | 作用 | 实测结果 |
| --- | --- | --- |
| `npm ci` | 按 lockfile 安装 | 通过（241 包） |
| `npm run dev` | Vite + Wrangler 并行开发模式（Worker 用 `.wrangler/state/dev`） | 通过（两个服务均就绪） |
| `npm run build` | 前端 `vite build` + 后端 `wrangler deploy --dry-run` | 通过 |
| `npm run typecheck` | 各工作区 tsc / vue-tsc + 根级 tests/tsconfig | 通过 |
| `npm run lint` | 根级 ESLint（flat config，含 .vue 与 scripts 下的 .mjs） | 通过（0 error / 0 warning） |
| `npm run test:unit` | 根级 node 环境测试 + `apps/server` 的 workerd/D1 测试 | 通过（48 + 53 用例） |
| `npm run cf:types` | `wrangler types` 生成绑定与运行时类型 | 通过 |
| `npm run db:check:local-binding` | 断言 D1 绑定仍指向本地哨兵库 | 通过（违规配置退出码 1） |
| `npm run db:migrate:local` | 在本地 D1 应用 `migrations/` | 通过（空库 3 个迁移；已有库只补 0003） |
| `npm run db:seed:local` | 执行 `scripts/seed/seed.sql`（幂等） | 通过（重复执行不新增） |
| `npm run accounts -- <命令> <账号>` | 受控账号管理：`create-user`（密码从 stdin/交互式读取）、`revoke-sessions`、`list-users`；默认只动本地 D1 | 通过（本地库创建/撤销/列表实测，见 P0-04 验证记录） |
| `npm run deploy:server:dry-run` | 等同 `build:server`（`wrangler deploy --dry-run`） | 通过 |
| `npm run deploy:web:dry-run` | 等同 `build:web`（Pages 无有意义的 dry-run，先做构建验证） | 通过 |

属于后续任务、**当前尚未创建**的脚本（见 02 第 6 节）：`test:integration`、`test:e2e`（P0-07 负责测试配置与 CI）。不要先写空脚本占位。

## 5. 已知问题与环境约定

1. **npm 10 的 arborist 缺陷**：npm 10.9.2 解析 `vitest 4.1.x` 的 peer 集合时会崩溃（`TypeError: Cannot read properties of null (reading 'edgesOut')`）。同一组合用 npm 11.19.1 实测正常，`vitest 4.1.x` 又是 `@cloudflare/vitest-pool-workers` 的 peer 要求，因此仓库内 `.npmrc` 设置 `legacy-peer-deps=true` 绕过。升级到 npm ≥ 11 后可删除该文件。
2. **compatibility_date = 2026-08-22**：`@cloudflare/vitest-pool-workers` 0.22 内置的 workerd 1.20260815.1 最高只支持 2026-08-22，而 wrangler 4.133.0 自带的 workerd 1.20260916.1 更高。取两者较小值可让本地开发、测试与部署使用同一运行时语义；升级 pool-workers 后再评估上调。
3. **vitest pool 的配置方式**：pool-workers 0.22 起改用插件 `cloudflareTest()`，不再提供 `defineWorkersConfig` 的 `/config` 子路径；`cloudflare:test` 的模块声明通过 tsconfig `types: ["@cloudflare/vitest-pool-workers/types"]` 引入。
4. **`apps/server/worker-configuration.d.ts` 由 `wrangler types` 生成并纳入版本控制**；改动 `wrangler.jsonc`（尤其 compatibility_date）后必须重新生成，否则 `wrangler dev` 会提示类型过期。CI 中的新鲜度检查属于 P0-07。
5. **本地 D1 状态目录隔离**：开发 / 迁移 / seed 统一使用 `apps/server/.wrangler/state/dev`；集成测试（vitest pool）使用 workerd 内存存储，不落盘、不碰开发目录，因此测试不会污染本地存档。注意 pool-workers 0.22 起**不再有逐用例回滚**：同一测试文件内数据会累积，测试要按「独立主键 / 相对计数」书写，不要依赖自动回滚。
6. **D1 绑定守卫**：`scripts/db/check-local-binding.mjs` 断言 `DB` 绑定的 `database_id` 仍是全零哨兵 UUID、没有被标记 `remote`、且声明了 `migrations_dir`。它在 `apps/server` 的 `test:unit` 前自动执行，也可在 CI 中单独跑。接远程库必须先取得授权并同步更新守卫与 07 记录，这样「拿生产库跑测试」会立即失败。
7. **配置哈希的维护方式**：`packages/game-config` 的 `GAME_CONFIG_PAYLOAD_HASH` 必须与 `scripts/seed/seed.sql` 里 `config_versions` 行的哈希一致。改动配置内容后跑 `npm run test:unit`，`tests/game-config/config-integrity.test.ts` 会失败并打印实际哈希，按提示更新这两处即可（Worker 启动时也会用同一算法校验）。
8. **Workspace 包与 Zod**：`packages/*` 通过 `exports` 直接暴露 TS 源码，没有独立构建步骤；`zod@4.6.5` 由 contracts 与 game-core 各自依赖（各自 node_modules 下一份，与 pool-workers 内部的 zod 4.4.3 互不影响）。
9. **Worker 包体积**：`wrangler deploy --dry-run` 当前产出约 2.1 MiB（gzip 345 KiB，含 Zod、未 minify）。未超平台限制，但体积预算与 `minify` 开关属于 P0-07/P6 的部署加固范围，本阶段不做。
10. **未验证项**：Cloudflare 远程资源创建与部署、远程 D1 迁移与 staging 复测、Cron、Secrets、Playwright E2E、Chrome 109 / Firefox 115 ESR 真机均未执行，也未创建任何云资源。
11. **密码哈希用 `@noble/hashes` 的 Argon2id（纯 TS，无原生二进制）**，参数 `m=19456 KiB, t=2, p=1, dk=32`（OWASP 最低建议），编码 `$argon2id$m=..,t=..,p=..,dk=..$<salt b64url>$<hash b64url>`，参数随哈希保存以支持升参与登录后自动 rehash。**本地/测试实测单次约 140～156 ms**（workerd 1.20260815.1，本机），而 **Workers Free 套餐的 CPU 上限是 10 ms/请求**：注册与登录在 Free 套餐下会因超出 CPU 限制失败，**因此这两条路径需要 Workers Paid**（见 07 的 D22）。
12. **`npm run accounts` 的传参方式**：npm run 会把 `--account`、`--remote` 这类以 `--` 开头的参数当成 npm 自己的配置项并吞掉（实测 npm 10.9.2），所以受控账号脚本用**位置参数**（`-- create-user <账号>`）表达账号，用环境变量 `XIUXIAN_ACCOUNTS_TARGET` / `XIUXIAN_ACCOUNTS_CONFIRM_REMOTE` 选择远程库；需要显式长参数时直接跑 `npx tsx scripts/accounts/manage.ts`。
13. **CSRF 采用「双提交 + 服务端摘要」**：会话下发两个 Cookie——`session`（HttpOnly + SameSite=Lax + Path=/，production 加 Secure）与 `csrf`（同属性但**不带 HttpOnly**，供前端读进 `X-CSRF-Token` 头）；服务端要求「头值 == Cookie 值」且 `sha256(头值) == sessions.csrf_token_hash`。`middleware/csrf.ts` **默认保护所有非安全方法**，只放行登录/注册；已登录写请求缺头 → 403，未登录写请求 → 401 且不写入。`GET /auth/me` 在 Cookie 缺失或与服务端摘要不符时会轮换 CSRF 令牌（自愈），前端刷新后不会卡死。
14. **登录限频是「账号 + 来源 IP」双维度、固定窗口（默认 5 次/60 秒）、只统计失败**：成功登录清零。副作用是攻击者可以持续用错密码把**某个账号**在该窗口内锁住（连正常用户也被挡），这是用可用性换暴力破解成本的取舍；后端记录、待评审确认。计数落在 D1（`auth_rate_limits` 单条原子 upsert），因此跨 Worker 实例一致，不依赖内存 Map。
15. **注册接口的枚举取舍**：重复账号返回 409 `STATE_CONFLICT` 与固定文案「账号不可用（可能已被占用）」，因此「账号是否已存在」对调用方是可区分的。当前注册默认关闭且需要邀请码，P0 阶段接受该取舍；若后续开放注册，需要改成统一文案 + 邮件/人工确认流程（已登记为待决策项）。
16. **`auth_rate_limits` 已加入就绪检查的必需表名单**（`infra/db/readiness.ts`），因此应用 `0003` 迁移前 `/api/v1/health/ready` 会返回 503；`db-migrations.test.ts` 的迁移数断言改为与注入的迁移文件数对齐，新增迁移不需要改断言。

## 6. 目录说明

```text
apps/web/                Vue 3 SPA（Cloudflare Pages 项目；wrangler.toml 为 Pages 配置）
apps/server/             Cloudflare Workers + Hono（wrangler.jsonc 为 Worker 配置）
  src/index.ts           Worker 入口（只导出 fetch；scheduled 由 P0-05 接入）
  src/app.ts             装配：no-store、requestId 与日志、会话/Origin/CSRF、/api/v1 路由、统一 404 与错误处理
  src/http/              AppError、响应包构造、严格输入校验、错误处理中间件
  src/middleware/        会话加载、Origin 校验、CSRF 校验、限频来源识别（P0-04）
  src/infra/db/          D1 客户端、参数化仓储基类与仓储、错误分类、就绪检查
  src/infra/logging/     结构化 JSON 日志 + 键名脱敏
  src/infra/crypto/      Web Crypto SHA-256 适配（配置内容哈希、会话/CSRF 摘要）
  src/config/            启动期配置校验（顶层 await，坏配置启动即失败）+ 鉴权变量读取（P0-04）
  src/modules/system/    health live/ready、config/public
  src/modules/auth/      注册/登录/me/退出、会话与 CSRF 令牌、Argon2id 密码哈希、限频计数（P0-04）
  test/                  workerd 内的响应包、错误映射、日志脱敏、健康检查、迁移/约束/seed、账号与会话安全测试
migrations/              D1 兼容 SQL，按编号前进（0001 账号与命令、0002 服务器与配置版本、0003 会话 CSRF 与限频表）
scripts/accounts/        受控账号管理脚本（创建账号 / 撤销会话 / 列表；默认只动本地 D1）
scripts/db/              本地 D1 绑定守卫
scripts/seed/seed.sql    幂等种子数据
scripts/tsconfig.json    scripts/** 的独立 TS 工程（node 类型，与 Worker/前端类型隔离）
packages/contracts/      Zod schema：统一响应包、错误码、公共标量（P0-03）
packages/game-core/      无 IO 纯函数：配置校验与公开投影（P0-03）、结算成长战斗（P1 起）
packages/game-config/    带版本的静态配置 + 内容哈希（P0-03）
tests/smoke/             根级 node 环境测试（包导入、绑定守卫）
tests/scripts/           根级 node 环境测试（受控账号脚本的参数解析与 SQL 转义）
docs/                    本文件与 docs/verification/<任务ID>/
开发规划/                 需求与规划文档
```

各 `packages/*` 通过 `exports` 直接暴露 TypeScript 源码（`./src/index.ts`），由 Vite/Wrangler 的打包器编译，无需单独的构建步骤。

## 7. 部署形态（未执行，需授权）

前端与后端是两个独立的 Cloudflare 项目，生产通过同域 Route 连接：

```text
game.example.com        -> Pages（apps/web 构建产物）
game.example.com/api/*  -> Workers Route（apps/server）
```

因此不需要 CORS，Cookie 自然共享。`apps/server/wrangler.jsonc` 中的 `routes` 目前是注释状态，`apps/web/wrangler.toml` 只声明 Pages 项目名与输出目录。创建项目、上传、绑定域名都需要用户明确授权。
