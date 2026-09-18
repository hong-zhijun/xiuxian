# P0-01 工程初始化与版本锁定 — 验证记录

任务 ID：P0-01
状态：待验收（自测完成，未经独立评审）
日期：2026-09-17
执行环境：Windows 10.0.26200；Node 22.15.1；npm 10.9.2；Git 2.49.0.windows.1；PowerShell 5.1
前置：P0 无前置任务；已阅读 `基础需求.md` 与开发规划 00/01/02/03/05/06、`分期任务/P0-工程与账号.md`。目录现状核对：仅有 `基础需求.md`、`开发规划.md`、`开发规划/`，无代码、无依赖、非 Git 仓库；原始需求与规划文档未被修改。

## 1. 修改/新增文件

根工程：

- `package.json`（npm workspaces：apps/*、packages/*；dev/build/typecheck/lint/test:unit/cf:types/deploy:* 脚本）
- `package-lock.json`（npm install 生成，241 包）
- `.npmrc`（npm 10 arborist 缺陷的 workaround，见第 4 节）
- `tsconfig.base.json`（strict、bundler 解析、noEmit、verbatimModuleSyntax）
- `eslint.config.js`（ESLint 10 flat config：js recommended + typescript-eslint + eslint-plugin-vue）
- `.gitignore`（node_modules、dist、.wrangler、.dev.vars 等）
- `vitest.config.ts`（根级 node 环境冒烟测试）
- `tests/smoke/workspace-packages.test.ts`
- `docs/setup.md`（本地运行说明）
- `docs/verification/P0-01/verification.md`（本文件）

前端 `apps/web/`：`package.json`、`vite.config.ts`（代理 `/api` → 127.0.0.1:8787、`build.target=['chrome109','firefox115']`）、`tsconfig.json`、`index.html`、`wrangler.toml`（Pages 配置）、`src/main.ts`、`src/App.vue`、`src/api/system.ts`、`src/styles/base.css`、`src/env.d.ts`

后端 `apps/server/`：`package.json`、`wrangler.jsonc`、`tsconfig.json`、`vitest.config.ts`、`src/index.ts`、`src/app.ts`、`test/app.test.ts`、`.dev.vars.example`、`worker-configuration.d.ts`（`wrangler types` 生成）

packages：`packages/contracts/`、`packages/game-core/`、`packages/game-config/` 各含 `package.json`、`tsconfig.json`、`src/index.ts`（占位，仅导出 `PACKAGE_NAME`，内容归属见 03 与 P0-03/P1）

Git：已执行 `git init`（用户授权，分支 `main`），**未提交、未配置远程**。

## 2. 验收逐条结果

| 任务卡验收点 | 结果 | 证据 |
| --- | --- | --- |
| 无 Docker 可安装 | 通过 | `npm ci` exit 0（added 241 packages）；全程未使用 Docker/PostgreSQL |
| typecheck | 通过 | `npm run typecheck` exit 0（web=vue-tsc、server=tsc、3 个 packages=tsc） |
| build | 通过 | `npm run build` exit 0；web `✓ 13 modules transformed`，server `Total Upload: 62.82 KiB / gzip: 15.63 KiB` + `--dry-run: exiting now.` |
| Vite + Wrangler 并行开发模式正常 | 通过 | `npm run dev` 后 `[server] Ready on http://127.0.0.1:8787`、`[web] VITE v8.3.0 ready ... http://localhost:5173/`，两个端口均返回 200 |
| Web 经 proxy 获取 serverTime | 通过 | `curl http://localhost:5173/api/health` → `{"ok":true,"service":"xiuxian-game-server","serverTime":"2026-09-17T07:29:11.268Z"}` HTTP 200 `application/json` |
| Worker 独立启动可响应 API | 通过 | `curl http://127.0.0.1:8787/api/health` → 同上结构，HTTP 200 `application/json` |
| 未知 API 返回 JSON 404 不是 HTML | 通过 | Worker：`curl .../api/unknown-route` → `{"ok":false,"error":{"code":"NOT_FOUND","message":"接口不存在"}}` HTTP 404 `application/json`；经 Vite 代理同样返回 JSON 404（未落入 SPA HTML） |
| PowerShell 命令可用 | 通过 | 以上命令均在 PowerShell 5.1 执行；根脚本用 `&&`（Windows 下由 npm 交给 cmd.exe 执行）与 concurrently，均通过 |
| Vite build.target=['chrome109','firefox115'] | 已配置 | `apps/web/vite.config.ts`；真机兼容未测（见第 3 节） |
| 生成绑定类型 | 通过 | `npm run cf:types` → `✨ Types written to worker-configuration.d.ts`（含全局 `Env`、运行时类型） |
| lockfile 与 .dev.vars.example | 通过 | `package-lock.json`、`apps/server/.dev.vars.example` 均在版本控制范围内（`.dev.vars` 被忽略） |

任务卡「测试」项：

| 测试点 | 结果 | 证据 |
| --- | --- | --- |
| 包导入 | 通过 | `npm run test:unit` → `tests/smoke/workspace-packages.test.ts` 1 passed（三个 `@xiuxian/*` 经 workspace 链接解析成功） |
| Worker health | 通过 | `apps/server/test/app.test.ts`（workerd 内，`SELF.fetch`）3 passed：200 + JSON + UTC ISO serverTime、JSON 404、no-store |
| 静态资源/API 路由 | 通过 | `GET http://localhost:5173/` 返回含 `<div id="app">` 的 HTML；`/src/main.ts` 被 Vite 转译（含 `createApp`）；`vite preview`（构建产物，4173）代理 `/api/health` → 200 |

工具版本与 compatibility_date 记录：见 `docs/setup.md` 第 2 节（wrangler 4.133.0 / workerd 1.20260916.1；pool-workers 0.22.0 内置 miniflare 5.20260815.0-alpha / workerd 1.20260815.1；`compatibility_date = "2026-08-22"`）。

## 3. 未执行项（不得视为通过）

- 未做任何 Cloudflare 远程操作：未创建 Pages/Workers 项目、未部署、未创建 D1、未配置 Route/域名/Secrets（均需授权）。
- 未执行 `wrangler deploy`（真实上传）与 `wrangler pages deploy`；`deploy:web:dry-run` 当前等同 `vite build`。
- 未执行 D1 迁移/seed（脚本属于 P0-02，未创建占位）。
- 未执行 Playwright E2E、多标签页、断网/超时等前端状态验证（P0-06/P0-07）。
- 未在真实浏览器里人工点击「获取服务器时间」按钮：本环境的命令执行器会在单次命令结束时回收子进程，dev server 无法跨命令常驻，因此只做了 HTTP 级验证（HTML 含 `<div id="app">`、`/src/main.ts` 被 Vite 转译、构建产物经 `vite preview` 代理 `/api/health` 返回 200）；工作面板浏览器插件本次调用被权限拒绝，未取得渲染截图。
- 未在 Chrome 109 / Firefox 115 ESR 真机或虚拟机上验证兼容性，仅配置了构建目标语法级别。
- 未做 D1 相关集成测试与并发/事务验证（P0-02/P0-05）。
- 未接入 CI（P0-07）。
- 未提交 Git（按任务卡「不自动提交」）。

## 4. 过程中发现的阻塞与新决策

1. **npm 10.9.2 解析 `vitest 4.1.x` 的 peer 集合时崩溃**（`TypeError: Cannot read properties of null (reading 'edgesOut')`，`@npmcli/arborist#loadPeerSet`）。最小复现：仅安装 `vitest@4.1.11` 即崩溃；`vitest@4.0.18`、`vitest@5.0.1` 正常；`npm@11.19.1` 处理同一组合正常。因 `@cloudflare/vitest-pool-workers` 0.22.0 的 peer 要求是 `vitest ^4.1.0`（最低版本 0.20.0 起均如此），无法降级 vitest，故在仓库 `.npmrc` 写 `legacy-peer-deps=true` 并注明根因与移除条件。**需评审：是否接受该 workaround，或要求开发机统一升级 npm ≥ 11。**
2. **compatibility_date 定为 `2026-08-22`**（不是实施当天 2026-09-17）：pool-workers 内置 workerd 1.20260815.1 报错 `This Worker requires compatibility date "2026-09-17", but the newest date supported by this server binary is "2026-08-22"`。取工具链共同支持的上限，使本地 dev/test 与部署运行时语义一致。**需评审：是否接受，或选择提升 npm 之外的其他方式（如不锁定 pool-workers 版本）。**
3. **pool-workers 0.22 的配置 API 变更**：不再导出 `/config`（`defineWorkersConfig`），改为插件 `cloudflareTest()`；`cloudflare:test` 类型需 tsconfig `types: ["@cloudflare/vitest-pool-workers/types"]`。已按实际导出实现并验证。
4. **Vite 默认只绑定 `localhost`**：`127.0.0.1:5173` 不可达（本机 localhost 解析到 `::1`），文档已注明用 `localhost` 访问前端；Worker 侧固定 `127.0.0.1:8787`。
5. **并行启动顺序竞争**：Worker 就绪前的 `/api` 请求会出现一次 `ECONNREFUSED 127.0.0.1:8787`（dev 日志已捕获），刷新后正常。前端加载/失败状态由 P0-06 处理，此处仅记录。

## 5. 关键命令与退出码

```text
node -v / npm -v / git --version                     退出码 0（22.15.1 / 10.9.2 / 2.49.0.windows.1）
npm install --no-audit --fund=false                  退出码 1（npm 10 arborist 崩溃，见 4.1）
npm install（含 .npmrc）                             退出码 0：up to date
npm ci                                               退出码 0：added 241 packages in 6s
npm run cf:types                                     退出码 0：Types written to worker-configuration.d.ts
npm run typecheck                                    退出码 0（5 个工作区全部执行）
npm run lint                                         退出码 0（0 error / 0 warning）
npm run test:unit                                    退出码 0（根级 1 passed；apps/server 3 passed）
npm run build                                        退出码 0（web 构建 + server dry-run）
npm run dev（脚本化启动后 curl 检查，再 taskkill）     退出码 0；关闭后 5173/8787/4173 无监听残留
git init / git status                                退出码 0（分支 main，13 项未跟踪，未提交）
git check-ignore -v node_modules apps/web/dist ...   确认忽略规则生效；.dev.vars.example 未被忽略
```

## 6. 下一步

- 评审本任务（对照任务卡与 02/05/06），决定第 4 节两项决策。
- 通过后执行 P0-02（数据库与迁移基座：DB binding、migrations、本地 D1、seed）。
