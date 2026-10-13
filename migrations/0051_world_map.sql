-- Migration number: 0051 	 Name: world_map
--
-- 山河舆图（docs/山河舆图开发计划.md）：取代灵脉争夺（0042）。
--   world_sites（新表）<- 14 处灵地，每处一行；id 与 world.ts 的 WORLD_SITES 一一对应（本迁移预置 14 行）。
--     holder_sect_id / holder_name <- 占领者；NULL = 无主（盘踞妖兽）
--     garrison           <- 坐镇弟子 id 的 JSON 数组（按回合顺序）
--     held_since         <- 当前占领者的占领时刻
--     protected_until    <- 禁制护持截止（开辟 / 易主后 4 小时）
--     settled_at         <- 产出已结算到的整点（毫秒）；无主时 NULL。占领时恒为整点
--     rare_hours         <- 祖脉：本轮已坐镇的整点小时数（满 6 结算 1 个稀有材料，余数留存）
--     version            <- 每次写入 +1；命令 / 定时任务提交时守卫要求它仍是读到的值
--   world_site_logs（新表）<- 山河纪事：斗法（含开辟）、撤回、供奉三类；只保留 3 天（定时任务清理）。
--     kind               <- battle 斗法 / withdraw 撤回 / settle 供奉
--     sect_id / sect_name <- 发起方（斗法 / 撤回）或领供奉的宗门
--     target_sect_id / target_name <- 斗法的守方宗门；妖兽开辟 / 撤回 / 供奉为 NULL
--     site_id            <- 斗法 / 撤回的灵地；供奉为 NULL（一次供奉可能合并多处）
--     won                <- 斗法时进攻方是否获胜（1 / 0）
--     rounds             <- 斗法回合 JSON；其余 NULL
--     effects            <- 供奉的 {资源 id: 最小单位字符串}；其余 NULL
--   「今日斗法」次数 = world_site_logs 里 kind = 'battle' 且 sect_id = 本宗、created_at 在今天之内。
--
-- 灵脉下线：spirit_veins 全部置为无主（表与战报保留，不删数据）；定时任务不再结算灵脉。
-- 宗门不会被删除：sect_id 列不建 CASCADE（同 0042 / 0048）。

CREATE TABLE world_sites (
  id TEXT PRIMARY KEY,
  holder_sect_id TEXT,
  holder_name TEXT,
  garrison TEXT,
  held_since INTEGER,
  protected_until INTEGER,
  settled_at INTEGER,
  rare_hours INTEGER NOT NULL DEFAULT 0 CHECK (rare_hours >= 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_world_sites_holder ON world_sites (holder_sect_id);

INSERT INTO world_sites (id, updated_at) VALUES
  ('east-lingdi', 0),
  ('east-fudi', 0),
  ('east-dongtian', 0),
  ('west-lingdi', 0),
  ('west-fudi', 0),
  ('west-dongtian', 0),
  ('south-lingdi', 0),
  ('south-fudi', 0),
  ('south-dongtian', 0),
  ('north-lingdi', 0),
  ('north-fudi', 0),
  ('north-dongtian', 0),
  ('center-xuantie', 0),
  ('center-shenmu', 0);

CREATE TABLE world_site_logs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('battle', 'withdraw', 'settle')),
  sect_id TEXT NOT NULL,
  sect_name TEXT NOT NULL,
  target_sect_id TEXT,
  target_name TEXT,
  site_id TEXT,
  won INTEGER CHECK (won IN (0, 1)),
  rounds TEXT,
  effects TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_world_site_logs_created ON world_site_logs (created_at);
CREATE INDEX idx_world_site_logs_sect ON world_site_logs (sect_id, kind, created_at);
CREATE INDEX idx_world_site_logs_target ON world_site_logs (target_sect_id, created_at);

-- 灵脉下线：全部置为无主（表与战报保留）。
UPDATE spirit_veins SET holder_sect_id = NULL, holder_name = NULL, garrison = NULL, held_since = NULL,
  protected_until = NULL, settled_at = NULL, version = version + 1;
