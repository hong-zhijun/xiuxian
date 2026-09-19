# 弱模型执行提示词：丹药系统

请在当前项目目录中直接实现 `docs/alchemy-development.md` 规定的丹药系统。先完整阅读该文档和当前相关源码，再修改代码；不要只给方案，不要停在分析阶段。

## 执行要求

1. 以 `docs/alchemy-development.md` 为唯一需求来源。
2. 先检查当前工作树，保留已有用户改动，不要重置或覆盖无关文件。
3. 严格按照文档的实施顺序开发：迁移与仓储 -> 纯函数 -> SectDraft/sync -> craft -> use -> API -> 前端 -> 测试。
4. 第一版不新增独立炼丹房；炼丹由“宗门 2 级 + 灵药园 2 级”解锁。
5. 第一版不修改 `GameConfigContent`、`GAME_CONFIG_VERSION`、`GAME_CONFIG_PAYLOAD_HASH` 和 `/config/public` 契约。
6. 第一版只实现三种丹药：回春丹、聚气丹、淬体丹。
7. 所有写操作必须沿用现有 `SectDraft`，先结算，再校验，再通过一次 D1 batch 写入；复用已有 `mutation_guards` 在同批校验读取快照，冲突时整批回滚。
8. 所有金额使用现有最小单位字符串；库存和次数使用非负整数。
9. 短板属性由服务端自动判断，客户端不能指定攻击/防御/速度，也不能绕过服务端规则。
10. 不引入 Vue Router、Pinia、异步炼制队列、定时任务、交易系统、随机炼丹失败或新的货币。

## 必须完成的结果

- 新增 `migrations/0011_alchemy.sql`。
- 新增 `apps/server/src/modules/game/alchemy.ts`。
- 增加 `pill_inventories` 仓储、`body_tempering_count` 字段、readiness 检查。
- 增加 `POST /api/v1/game/craft-pill` 和 `POST /api/v1/game/use-pill`。
- `GET /api/v1/game/sync` 返回 `alchemy` 状态和弟子淬体预览字段。
- 前端有可打开的炼丹面板，并能完成炼制和服用。
- 新增后端测试覆盖迁移、解锁、炼制、三种服用效果、库存和归属校验。
- 运行并修复 `npm run typecheck`、`npm run build`、`npm run test:unit`。

## 交付格式

开发过程中持续汇报正在检查和修改的文件。完成后输出：

1. 修改文件清单。
2. 实现的丹药规则和 API。
3. 运行过的命令及结果；未能运行的命令要明确说明原因。
4. 仍存在的风险或需要产品确认的点。

不要修改或删除部署配置、鉴权逻辑和与丹药无关的游戏玩法。完成前检查 `git diff --check` 和 `git status`。
