-- Migration number: 0042 	 Name: spirit_veins
--
-- 灵脉争夺（docs/灵脉争夺开发计划.md）：
--   spirit_veins（新表）<- 每条灵脉一行；id 与 veins.ts 的 VEINS 一一对应（本迁移预置 10 行）。
--     holder_sect_id / holder_name <- 占领者；NULL = 无主
--     garrison           <- 守军弟子 id 的 JSON 数组（按回合顺序）
--     held_since         <- 当前占领者的连续占领起点（算枯竭用）
--     protected_until    <- 保护期截止（进驻 / 易主后 1 小时）
--     settled_at         <- 产出已结算到的时刻（占领者变动 / 定时任务时推进）
--     exhausted_sect_id / exhausted_until <- 最近一次枯竭的原占领者与其冷却截止（期间不能再占这一条）
--     version            <- 每次写入 +1；命令 / 定时任务提交时守卫要求它仍是读到的值
--   vein_battles（新表）<- 战报；也用来数「今日抢夺次数」（attacker_sect_id + created_at）。
--   sect_vein_stats（新表）<- 每宗门累计从灵脉获得的灵气（最小单位，按实际入账前的产出计）。
--
-- - 宗门不会被删除：sect_id 列不建 CASCADE，与 sect_stewards 同一做法。

CREATE TABLE spirit_veins (
  id TEXT PRIMARY KEY,
  holder_sect_id TEXT,
  holder_name TEXT,
  garrison TEXT,
  held_since INTEGER,
  protected_until INTEGER,
  settled_at INTEGER,
  exhausted_sect_id TEXT,
  exhausted_until INTEGER,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_spirit_veins_holder ON spirit_veins (holder_sect_id);

INSERT INTO spirit_veins (id, updated_at) VALUES
  ('vein-eye', 0),
  ('vein-large-1', 0),
  ('vein-large-2', 0),
  ('vein-large-3', 0),
  ('vein-small-1', 0),
  ('vein-small-2', 0),
  ('vein-small-3', 0),
  ('vein-small-4', 0),
  ('vein-small-5', 0),
  ('vein-small-6', 0);

CREATE TABLE vein_battles (
  id TEXT PRIMARY KEY,
  vein_id TEXT NOT NULL,
  attacker_sect_id TEXT NOT NULL,
  attacker_name TEXT NOT NULL,
  defender_sect_id TEXT NOT NULL,
  defender_name TEXT NOT NULL,
  won INTEGER NOT NULL CHECK (won IN (0, 1)),
  rounds TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_vein_battles_attacker ON vein_battles (attacker_sect_id, created_at);
CREATE INDEX idx_vein_battles_created ON vein_battles (created_at);

CREATE TABLE sect_vein_stats (
  sect_id TEXT PRIMARY KEY REFERENCES sects (id),
  harvested INTEGER NOT NULL DEFAULT 0 CHECK (harvested >= 0),
  updated_at INTEGER NOT NULL
);
