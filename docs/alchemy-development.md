# 丹药系统开发说明

版本：v1（第一版可玩闭环）

目标读者：负责直接修改本仓库的开发模型。

## 1. 背景与目标

当前游戏已经具备：宗门创建、离线结算、资源生产、弟子招募与派工、建筑升级、突破、秘境探索、排行榜、守擂和宗门挑战。

下一步加入丹药系统，目的不是再增加一层纯数值，而是让玩家可以把资源转成对弟子有针对性的培养收益：

1. 给受伤弟子快速恢复，减少探索失败后的等待。
2. 用丹药补充修为，让突破准备有资源决策。
3. 自动识别弟子战斗属性短板，提供有限、递减的永久修正。
4. 让药材、灵石、矿石和灵气都有新的消耗出口。
5. 让玩家在“升级建筑、招募弟子、炼丹培养”之间产生取舍。

本版本完成后，玩家应该能走通：

```text
灵药园生产药材
  -> 宗门达到 2 级且灵药园达到 2 级
  -> 打开炼丹面板
  -> 消耗资源炼制丹药
  -> 给指定弟子服用
  -> 修复伤势 / 补充修为 / 补齐战斗属性短板
```

## 2. 明确的设计决策

### 2.1 第一版不增加独立炼丹房

当前建筑路线已经固定：宗门 2 级自动解锁藏经阁，4 级自动解锁演武场，建筑容量也按现有路线平衡。直接新增一个自动解锁建筑会导致已有宗门的建筑数量超过容量，迫使本次开发同时重做建筑容量和升级平衡。

因此第一版把炼丹作为灵药园的附属功能：

- 解锁条件：宗门等级 `>= 2` 且 `herbGarden` 等级 `>= 2`。
- 不新增 `buildings` 行。
- 不修改现有宗门等级的建筑容量和自动解锁列表。
- 后续如果需要炼丹师、丹房专精，再单独做建筑版本迁移。

### 2.2 配方放在游戏模块代码，不改公共配置哈希

第一版配方是少量功能规则，放在 `apps/server/src/modules/game/alchemy.ts`，与 `events.ts`、`realms.ts` 的特定玩法定义保持一致。

本次不要扩展 `GameConfigContent`，不要修改：

- `packages/game-core/src/config/schema.ts`
- `packages/game-core/src/config/publicView.ts`
- `packages/game-config/src/index.ts`
- `GAME_CONFIG_VERSION`
- `GAME_CONFIG_PAYLOAD_HASH`

这样可以避免为少量丹药配方触发完整配置哈希和公共配置契约变更。丹药视图通过登录后的 `/game/sync` 返回。

### 2.3 第一版不做异步炼制队列

炼制是即时命令：检查资源、扣资源、增加库存，一次 D1 batch 完成。暂时不做：

- 炼制倒计时
- Worker 定时任务
- 炼丹队列
- 炼丹失败随机数
- 丹方掉落系统
- 玩家之间交易丹药

这样第一版可以完整验证玩法，而不会引入新的定时任务和并发状态机。

### 2.4 丹药不直接提高资质、境界或天赋

- 资质只影响修炼速度，第一版不允许丹药永久修改资质。
- 境界只能通过现有突破流程提升。
- 天赋不能洗练。
- 战斗属性丹只能修正当前短板，不能指定把最高属性继续堆高。

## 3. 第一版丹药清单

所有资源金额使用项目现有的“最小单位”整数。下表的数值是第一版基线，代码中必须集中定义，不能散落在 route 或组件里。

| id | 名称 | 炼制成本（每颗） | 服用效果 | 限制 |
| --- | --- | --- | --- | --- |
| `healingPill` | 回春丹 | `herb: 10000`、`spiritStone: 15000` | 清除一名弟子的当前疗伤状态 | 只有 `injured_until > now` 时可用 |
| `cultivationPill` | 聚气丹 | `herb: 25000`、`spiritualEnergy: 15000`、`spiritStone: 10000` | 增加 120 点当前阶段修为 | 不能用于已达本版本最高阶段的弟子；超过突破门槛的部分不保留 |
| `bodyTemperingPill` | 淬体丹 | `herb: 40000`、`ore: 20000`、`spiritStone: 30000` | 自动提升该弟子当前最明显的战斗属性短板 | 每名弟子最多服用 10 颗；没有短板时不可用 |

### 3.1 回春丹

服务端判断：

- `injured_until === null` 或 `injured_until <= now`：拒绝，返回 `INVALID_STATUS`。
- 满足条件：把 `injured_until` 更新为 `NULL`，库存减 1。
- 不改变修为、境界、属性和岗位。

### 3.2 聚气丹

服务端按弟子当前阶段查询 `findStage(realm_id, stage)`：

- `requiredCultivation === null`：拒绝。
- 当前修为已经大于等于门槛：拒绝，提示先突破。
- `gain = min(120, requiredCultivation - cultivation)`。
- cultivation 增加 `gain`。
- `cultivation_remainder` 保持不变，不因为服药丢弃离线结算的小数余数。
- 不自动触发突破，不改变 `injured_until`。

### 3.3 淬体丹：自动补短板

淬体丹不让前端指定攻击、防御或速度，而由服务端自动选择，避免客户端反复试探规则和把最高属性继续堆高。

对每名弟子计算三项属性：`attack`、`defense`、`speed`。对每一个候选属性 `x`：

```text
otherAverage = floor((另外两项属性之和) / 2)
gap = otherAverage - 当前属性
```

只有 `gap > 0` 的属性才是可补短板。选择 `gap` 最大者；若并列，使用固定顺序 `attack -> defense -> speed`。

提升量：

```text
gain = min(5, max(1, 1 + floor(gap / 10)), 100 - 当前属性)
```

如果没有可补属性，拒绝并返回 `INVALID_STATUS`。服用后：

- 对应属性增加 `gain`。
- `body_tempering_count` 增加 1。
- 达到 10 次后不再允许使用淬体丹。
- 不改变资质、天赋、境界、修为和战力公式。

例子：

```text
弟子属性：攻 32 / 防 76 / 速 70
攻的 otherAverage = 73，gap = 41
速的 otherAverage = 54，gap < 0
本次自动提升攻击 5 点，变成攻 37 / 防 76 / 速 70
```

## 4. 炼制规则

### 4.1 解锁

定义统一常量：

```ts
export const ALCHEMY_UNLOCK_SECT_LEVEL = 2;
export const ALCHEMY_UNLOCK_BUILDING_ID = 'herbGarden';
export const ALCHEMY_UNLOCK_BUILDING_LEVEL = 2;
export const BODY_TEMPERING_MAX_USES = 10;
export const CULTIVATION_PILL_GAIN = 120;
```

解锁判断必须只在服务端实现，并复用于：

- `SectStateView.alchemy.unlocked`
- `POST /game/craft-pill`
- `POST /game/use-pill`

未解锁时，所有相关写请求返回 `INVALID_STATUS`，不要只依赖前端禁用按钮。

### 4.2 炼制数量

- `quantity` 必须是整数，范围 `1..5`。
- 单次炼制成本 = 单颗成本 × quantity。
- 资源不足时整次失败，不能扣一部分资源或增加部分库存。
- 炼制成功后库存增加 quantity。
- 同一宗门、同一 pill_id 只有一条库存记录。

### 4.3 库存

库存数量是非负整数，不使用十进制字符串。

- 没有库存行时视为 0。
- 首次炼制时使用 upsert 创建库存行。
- 服用后库存减 1。
- 库存不足时返回 `INSUFFICIENT_RESOURCE` 不合适，应该返回 `INVALID_STATUS` 或新增 `PILL_OUT_OF_STOCK`。为减少错误码范围，第一版统一使用 `INVALID_STATUS`，错误消息为“丹药库存不足”。

## 5. 数据库设计

新增迁移：`migrations/0011_alchemy.sql`。

```sql
-- 每名弟子最多 10 次淬体丹服用次数。
ALTER TABLE disciples
  ADD COLUMN body_tempering_count INTEGER NOT NULL DEFAULT 0
  CHECK (body_tempering_count >= 0);

CREATE TABLE pill_inventories (
  id TEXT PRIMARY KEY,
  sect_id TEXT NOT NULL REFERENCES sects (id) ON DELETE CASCADE,
  pill_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at INTEGER NOT NULL,
  UNIQUE (sect_id, pill_id)
);

CREATE INDEX pill_inventories_sect_idx
  ON pill_inventories (sect_id);
```

`pill_id` 不建外键，因为配方定义属于代码常量，不是数据库实体。

### 5.1 必须同步修改的后端类型和仓储

在 `apps/server/src/modules/game/repository.ts`：

- `DiscipleRow` 增加 `body_tempering_count: number`。
- 所有 disciples 查询都选出 `body_tempering_count`。
- `NewDisciple` 可以增加 `bodyTemperingCount`，新建时传 0；SQL 也可以依赖默认值，但内存行必须有 0。
- 增加 `PillInventoryRow`：`id / sect_id / pill_id / quantity / updated_at`。
- 增加 `PillInventoryRepository.findBySectId`。
- 增加以下参数化语句构造器：
  - `upsertPillInventoryStatement`
  - `updatePillInventoryQuantityStatement`
  - `updateDiscipleBodyTemperingStatement`
  - `updateDiscipleCultivationStatement` 保持原有行为，不要覆盖新列。

在 `apps/server/src/infra/db/readiness.ts` 的 `REQUIRED_TABLES` 增加 `pill_inventories`。

## 6. 后端模块设计

### 6.1 新增 `alchemy.ts`

位置：`apps/server/src/modules/game/alchemy.ts`。

该文件只放纯定义和纯计算，不读取数据库：

- `PILL_RECIPES`
- `PILL_IDS`
- `PillId`、`PillAttribute` 等类型
- `isAlchemyUnlocked`
- `bodyTemperingTarget`
- `bodyTemperingGain`
- 配方查找函数

建议类型：

```ts
export type PillId = 'healingPill' | 'cultivationPill' | 'bodyTemperingPill';
export type PillAttribute = 'attack' | 'defense' | 'speed';

export interface PillRecipe {
  id: PillId;
  name: string;
  description: string;
  cost: Record<string, string>;
}
```

`bodyTemperingTarget` 的返回值应包含：

```ts
{
  attribute: PillAttribute;
  gain: number;
  gap: number;
} | null
```

不要在 `alchemy.ts` 中调用 `Date.now()`、数据库或随机数。

### 6.2 扩展 `SectSnapshot` 和 `SectDraft`

在 `apps/server/src/modules/game/service.ts`：

- `SectSnapshot` 加入 `pillInventories`。
- `loadSnapshot` 并行读取宗门库存。
- `SectDraft` 持有可变的 `pillInventories`。
- `SectDraft.view()` 把库存和配方状态传给 `buildSectStateView`。
- 炼丹提交在同一次 `db.batch` 的首条语句用现有 `mutation_guards` 校验宗门、资源、建筑、丹药库存和目标弟子的读取快照；末条清理守卫。冲突时整批回滚，提示刷新后重试。
- 炼制和服用必须遵循现有顺序：先结算，再校验，再扣资源/库存，最后一次提交。

建议增加的内部方法：

- `pillQuantity(pillId)`
- `requirePill(pillId)`
- `addPill(pillId, quantity)`
- `updateDisciple` 对应的内存修改和参数化语句追加

### 6.3 新增服务函数

```ts
export interface CraftPillOutcome {
  pillId: PillId;
  pillName: string;
  quantity: number;
  cost: Record<string, string>;
}

export async function craftPill(
  db: D1Database,
  userId: string,
  pillId: string,
  quantity: number,
  now: number,
): Promise<{ state: SectStateView; outcome: CraftPillOutcome }>;

export interface UsePillOutcome {
  pillId: PillId;
  pillName: string;
  discipleId: string;
  discipleName: string;
  effect: {
    kind: 'heal' | 'cultivation' | 'bodyTempering';
    gain?: number;
    attribute?: PillAttribute;
  };
}

export async function usePill(
  db: D1Database,
  userId: string,
  pillId: string,
  discipleId: string,
  now: number,
): Promise<{ state: SectStateView; outcome: UsePillOutcome }>;
```

服务函数要求：

1. 通过 `draftFor` 获取当前用户宗门；不能按请求体里的 sect id 查数据。
2. 先判定炼丹是否解锁。
3. 所有弟子必须由 `draft.discipleById` 获取，天然保证属于当前宗门。
4. 资源不足、库存不足、状态不满足都在写入前抛错。
5. 服用成功后库存减 1，不能出现库存负数。
6. 不使用 `Math.random()`。
7. 不新增幂等键或版本号；炼丹写入复用已有 `mutation_guards` 约束，防止并发请求覆盖库存或重复服用。

### 6.4 新增路由和 schema

在 `apps/server/src/modules/game/schema.ts` 增加：

```ts
export const craftPillRequestSchema = z.strictObject({
  pillId: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(5),
});

export const usePillRequestSchema = z.strictObject({
  pillId: z.string().min(1).max(64),
  discipleId: z.string().min(1).max(64),
});
```

在 `apps/server/src/modules/game/routes.ts` 挂载：

```text
POST /api/v1/game/craft-pill
POST /api/v1/game/use-pill
```

响应统一为：

```json
{
  "ok": true,
  "data": {
    "state": {},
    "outcome": {}
  },
  "requestId": "...",
  "serverTime": "..."
}
```

这两个接口都属于已登录写请求，自动经过现有 Origin 和 CSRF 中间件。

## 7. 状态视图契约

在 `apps/server/src/modules/game/view.ts` 和 `apps/web/src/api/game.ts` 保持同名类型。

### 7.1 `SectStateView`

增加：

```ts
alchemy: AlchemyView;
```

### 7.2 `AlchemyView`

```ts
export interface AlchemyRecipeView {
  id: string;
  name: string;
  description: string;
  cost: Record<string, string>;
  owned: number;
  canCraft: boolean;
  blockedReason: string | null;
}

export interface AlchemyView {
  unlocked: boolean;
  blockedReason: string | null;
  recipes: AlchemyRecipeView[];
}
```

`canCraft` 由服务端判断，至少考虑：

- 是否解锁
- 当前资源是否足够一颗

数量 × 成本的精确检查仍然由 craft 服务端执行。

### 7.3 `DiscipleView`

增加以下展示字段：

```ts
bodyTemperingUses: number;
bodyTemperingRemaining: number;
bodyTemperingTarget: 'attack' | 'defense' | 'speed' | null;
bodyTemperingGain: number;
```

这些字段只用于展示服务端已经算好的短板，不让前端复制短板算法。

## 8. 前端交互设计

### 8.1 新增组件

新增：`apps/web/src/components/AlchemyPanel.vue`。

复用现有：

- `ModalShell.vue`
- `formatAmount`
- `SectStateView`
- 现有按钮、列表、提示和禁用样式

### 8.2 入口

在 `SectScreen.vue` 操作条增加“炼丹”按钮，打开炼丹弹窗。不要新增路由，不要引入 Pinia。

### 8.3 面板内容

解锁前：

```text
炼丹尚未开启
需要：宗门 2 级、灵药园 2 级
```

解锁后，每个配方显示：

- 名称和简短用途
- 当前库存
- 单颗成本
- 炼制数量输入或步进按钮，范围 1~5
- 炼制按钮
- 资源不足时显示服务端 `blockedReason`

服用入口可以直接放在弟子卡片上：

- 受伤弟子显示“回春丹”使用按钮
- 修为未满门槛的弟子显示“聚气丹”使用按钮
- 有 `bodyTemperingTarget` 的弟子显示“淬体丹”使用按钮，并显示“本次补：攻击 +5”之类的预览
- 没有库存或不满足条件时按钮禁用

如果一次实现范围需要控制，允许第一版只在炼丹弹窗内选择弟子；但不能只实现后端而没有可操作入口。

### 8.4 App 事件处理

在 `App.vue`：

- 从 `api/game.ts` 引入 `craftPill`、`usePill`。
- 增加对应 handler，成功后接收服务端返回的完整 `state`。
- 使用现有 `busy` 门闩，避免同步轮询与服药/炼制并发。
- 成功后用 Toast 显示炼制数量或服用效果。
- 401 继续走现有会话失效逻辑。

## 9. 测试要求

至少增加 `apps/server/test/alchemy.test.ts`，使用现有 workerd/D1 测试方式和独立数据，不依赖测试用例自动回滚。

必须覆盖：

### 数据库和迁移

- 0011 迁移成功。
- `pill_inventories` 出现在 `REQUIRED_TABLES`。
- `quantity >= 0` 约束生效。
- 同一宗门同一 `pill_id` 唯一。
- 已有弟子迁移后 `body_tempering_count = 0`。

### 解锁和配方

- 宗门等级不足时不能炼制和服用。
- 灵药园等级不足时不能炼制和服用。
- 解锁后 sync 返回三种配方和库存 0。
- 未知 pill id 返回 `VALIDATION_ERROR` 或 `NOT_FOUND`，不能写库。

### 炼制

- 炼制 1 颗正确扣资源、增加库存。
- 炼制数量 1~5 生效，数量 0、负数、小数、超过 5 被拒绝。
- 资源不足时不扣资源、不增加库存。
- 多次炼制使用同一库存行，不产生重复行。
- craft 会先结算离线收益。
- 并发请求读取到旧资源余额或旧库存时，冲突请求整批回滚，不得扣费后丢失丹药。

### 服用

- 回春丹只能清除有效伤势。
- 聚气丹增加修为但不超过阶段门槛。
- 最高阶段弟子不能使用聚气丹。
- 淬体丹自动选择短板，结果符合公式。
- 淬体丹没有短板时拒绝。
- 淬体丹达到 10 次后拒绝。
- 服用成功扣库存 1，失败不扣库存。
- 不能使用其他宗门弟子作为目标。
- 所有成功写入在同一 batch 中完成。
- 最后一颗丹药被并发服用时，最多一个请求生效；失败请求不修改弟子。

### 契约和前端

- API 成功响应带 `state` 和 `outcome`。
- 未登录、缺 CSRF、跨源写请求仍由现有中间件拒绝。
- `SectStateView`、`AlchemyView` 前后端类型一致。
- `npm run typecheck`、`npm run build`、`npm run test:unit` 通过。

## 10. 实施顺序

按下面顺序提交，避免前后端同时大面积改动导致无法定位问题：

1. 新增 `migrations/0011_alchemy.sql`，更新 readiness 和 repository 类型。
2. 新增 `alchemy.ts`，实现配方、解锁和短板纯函数，并先为纯函数补测试。
3. 扩展 `SectSnapshot`、`SectDraft`、`SectStateView`，让 sync 能返回空库存和配方状态。
4. 实现 `craftPill`，补充 API schema、route 和后端测试。
5. 实现 `usePill`，补充伤势、修为、短板三条服用路径和后端测试。
6. 接入 `apps/web/src/api/game.ts` 类型和请求函数。
7. 新增 `AlchemyPanel.vue`，接入 `SectScreen.vue` 和 `App.vue`。
8. 运行格式/类型/构建/单测，修复所有失败。
9. 检查 `git diff`，确保没有修改鉴权、部署模型、配置哈希和无关玩法。

## 11. 明确禁止的范围扩张

本任务不要做以下事情：

- 不新增独立炼丹房或修改宗门建筑容量。
- 不修改现有 `GAME_CONFIG_VERSION` 和配置 payload hash。
- 不增加新的资源类型或货币。
- 不做异步生产、定时任务、炼丹队列。
- 不做丹方随机掉落、丹药交易、拍卖行。
- 不做资质洗练、天赋洗练、境界直升。
- 不改现有战斗力计算公式。
- 不重写 `SectDraft`、鉴权中间件或统一响应包。
- 不引入 Pinia、Vue Router 或新的状态管理框架。
- 不把资源/库存扣除拆成多个 D1 请求。
- 不通过前端计算规则绕过服务端校验。

## 12. 完成定义

满足以下条件才算完成：

- 登录用户在满足解锁条件后能看到炼丹面板。
- 能炼制三种丹药并看到库存变化。
- 能从弟子卡片或炼丹面板给正确目标服药。
- 丹药能真实影响伤势、修为和战斗属性。
- 资源、库存和弟子状态不会在失败操作中部分提交。
- 刷新页面后状态保持一致。
- 迁移、类型检查、构建和服务端单测通过。
- 代码中不存在对已删除规划文件的路径依赖。
