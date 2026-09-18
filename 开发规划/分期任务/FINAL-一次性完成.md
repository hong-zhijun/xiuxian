# FINAL：一次性完成全部游戏功能

3~5 人自用娱乐游戏，不需要企业级安全/幂等/事务守卫。已有基座：Vue+Vite 前端、Hono+D1 后端、完整鉴权(注册/登录/退出)、游戏配置(packages/game-config 里有全部数值)。

本任务一次性完成所有剩余功能：数据库、结算、全部游戏接口、前端页面。

**核心原则：简单直接，不搞花活。读状态→算结果→写回去，没有 CommandReceipt、没有 MutationGuard、没有乐观锁、没有幂等键。**

---

## 一、数据库迁移 (migrations/0004_game_tables.sql)

```sql
CREATE TABLE sects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  vein_level INTEGER NOT NULL DEFAULT 1,
  last_settled_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE disciples (
  id TEXT PRIMARY KEY,
  sect_id TEXT NOT NULL REFERENCES sects(id),
  name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT 'male',
  aptitude INTEGER NOT NULL,
  realm_id TEXT NOT NULL DEFAULT 'qiRefining',
  stage INTEGER NOT NULL DEFAULT 1,
  cultivation INTEGER NOT NULL DEFAULT 0,
  cultivation_remainder INTEGER NOT NULL DEFAULT 0,
  assignment TEXT NOT NULL DEFAULT 'idle',
  injured_until INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX disciples_sect_id_idx ON disciples (sect_id);

CREATE TABLE buildings (
  id TEXT PRIMARY KEY,
  sect_id TEXT NOT NULL REFERENCES sects(id),
  def_id TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(sect_id, def_id)
);

CREATE TABLE resource_balances (
  id TEXT PRIMARY KEY,
  sect_id TEXT NOT NULL REFERENCES sects(id),
  resource_id TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  remainder INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(sect_id, resource_id)
);
```

在 `apps/server/src/infra/db/readiness.ts` 的 REQUIRED_TABLES 里加上 `sects`、`disciples`、`buildings`、`resource_balances`。

---

## 二、后端游戏模块 (apps/server/src/modules/game/)

### 2.1 结算函数 settle.ts

纯函数，输入当前状态和当前时间，输出新状态。规则来自 03 第 3 节：

- elapsed = now - lastSettledAt，经济上限 12 小时 (43200 秒)
- 每种资源：基础产量 + 岗位弟子贡献，按小时算，余数保留
- 修炼弟子：累积修为，资质系数 = (8000 + aptitude * 40) / 10000
- 资源不超过容量上限，溢出丢弃
- 返回更新后的资源余额、弟子修为、新的 lastSettledAt

数值全部从 `packages/game-config` 的 `GAME_CONFIG_CONTENT` 读取，不要硬编码。

### 2.2 仓储 repository.ts

简单的 CRUD，用已有的 ParamRepository 基类：
- SectRepository: findByUserId, insert, updateLastSettledAt
- DiscipleRepository: findBySectId, insert, updateAssignment, updateCultivation (批量)
- BuildingRepository: findBySectId, insert, updateLevel
- ResourceBalanceRepository: findBySectId, upsertBalance (批量)

### 2.3 路由 routes.ts

所有接口都要求已登录（从 `authOf(c)` 拿 userId）。每个写操作前先调用结算。

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | /game/create-sect | 创建宗门：初始3弟子+3建筑+4种资源(按配置)，一个 D1 batch 写入 |
| GET | /game/sync | 结算 → 返回完整宗门状态(宗门/资源/弟子/建筑) |
| POST | /game/recruit | 结算 → 扣灵石 → 随机生成弟子(检查每日次数和弟子上限) |
| POST | /game/assign | 结算 → 改弟子岗位(body: {discipleId, assignment}) |
| POST | /game/upgrade-building | 结算 → 扣资源 → 建筑等级+1(检查等级上限和资源够不够) |
| POST | /game/breakthrough | 结算 → 检查修为够不够 → 扣灵气 → 随机判定成功/失败 |

随机数直接用 `Math.random()`，不需要注入。时间直接用 `Date.now()`。

错误处理直接用已有的 `AppError`，比如资源不足扔 `INSUFFICIENT_RESOURCE`，弟子上限扔 `CAPACITY_FULL`。

在 `app.ts` 里挂载：`app.route('/api/v1', createGameRoutes())`。

### 2.4 弟子随机生成

招募时随机生成：
- 名字：准备一个中文名字池（姓 + 名，各 20~30 个随机组合就行）
- 性别：随机
- 资质：1~100 随机
- 境界：炼气初期 (qiRefining, stage 1)
- 默认 idle

### 2.5 突破逻辑

按 03 第 4 节：
- 检查修为 >= 当前阶段门槛
- 概率 = clamp(baseChanceBp + 加成, minChanceBp, maxChanceBp)，P1 加成只看聚灵阵等级
- Math.random() * 10000 < 概率 → 成功：阶段+1，修为清零
- 失败：修为保留门槛的 90%，冷却 5 分钟 (injured_until = now + 300000)
- 境界阶段配置：炼气三阶段，门槛 30/90/180 修为

---

## 三、前端 (apps/web/src/)

不需要 Vue Router 和 Pinia。就两个状态：未登录、已登录。用 `ref` 管理状态就行。

### 3.1 改造 App.vue

- 启动时 `fetch('/api/v1/auth/me')` 检查登录状态
- 未登录：显示登录/注册表单
- 已登录但没宗门：显示创建宗门表单
- 已登录有宗门：显示游戏主界面

### 3.2 登录/注册

简单表单：账号、密码、邀请码(注册时)。调用已有的 `/api/v1/auth/register` 和 `/api/v1/auth/login`。
登录/注册成功后把 csrfToken 存到变量里，后续写请求带 `X-CSRF-Token` 头。

### 3.3 游戏主界面

一个页面搞定，分几个区块：

**顶栏**：宗门名 + 等级 + 退出按钮

**资源栏**：四种资源的当前值/容量，每秒客户端本地刷新模拟产出（纯展示，不影响服务端）

**弟子列表**：每个弟子显示名字、资质、境界、当前岗位、修为进度。每个弟子有：
- 岗位下拉框（修炼/药园/采矿/闲置）
- 突破按钮（修为够了才亮）

**建筑列表**：每个建筑显示名字、等级。有升级按钮（显示消耗）

**招募按钮**：显示消耗和今日剩余次数

所有操作调 API 后重新 sync 刷新状态。

### 3.4 样式

在已有 base.css 基础上扩展就行，保持简洁。深色/浅色跟随系统。手机能用就行（max-width: 720px 已经有了）。适当加点修仙风格的配色（暗金、深紫之类的）。

---

## 四、不要做的事

- ❌ 不要搞 Vue Router / Pinia，一个页面 ref 管理就行
- ❌ 不要搞 CommandReceipt / MutationGuard / 幂等键
- ❌ 不要搞乐观锁 / 版本号
- ❌ 不要搞 Clock/RNG 注入
- ❌ 不要搞 CI / E2E 测试 / Playwright
- ❌ 不要动已有的鉴权代码
- ❌ 不要新建共享包
- ❌ 不要写单元测试（能跑就行）
- ❌ 不要搞 P2~P6 的功能（战斗/事件/多人/交易/世界boss）

## 五、验收

1. `npm run typecheck` 通过
2. `npm run build` 通过
3. `npm run dev` 启动后能注册、登录、创建宗门、看到资源增长、招募弟子、分配岗位、升级建筑、突破
4. 就这样，能玩就行
