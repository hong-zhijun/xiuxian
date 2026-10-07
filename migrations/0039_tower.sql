-- Migration number: 0039 	 Name: tower
--
-- 镇妖塔（docs/镇妖塔开发计划.md）：每个宗门独立爬塔。
--   sect_towers（新表）<- 每宗门一行，第一次挑战 / 扫荡时创建（没有行 = 还没进过塔）：
--     max_floor       <- 历史最高层（0 = 一层都没过）；只增不减，不重置。
--     max_floor_at    <- 到达最高层的时间（UTC 毫秒），排行榜同层按它先到先排。
--     fail_date_key   <- 最近一次失败的 UTC+8 日期 'YYYY-MM-DD'；与今天不同视为今天 0 次。
--     fail_count      <- fail_date_key 那天已用的失败次数（上限见 tower.ts 的 TOWER_DAILY_FAILS）。
--     sweep_date_key  <- 最近一次扫荡的 UTC+8 日期；等于今天 = 今天已扫荡。
--     version         <- 每次写入 +1；命令提交时守卫要求它仍是读到的值（并发的两次挑战只成功一次）。
--
-- - 只存进度，不存战报：战报随挑战回执返回，不落库。
-- - 次数上限 / 层数规则都在代码里判定，CHECK 只限非负，以后调规则不必重建表。

CREATE TABLE sect_towers (
  sect_id TEXT PRIMARY KEY REFERENCES sects (id),
  max_floor INTEGER NOT NULL DEFAULT 0 CHECK (max_floor >= 0),
  max_floor_at INTEGER,
  fail_date_key TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0 CHECK (fail_count >= 0),
  sweep_date_key TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at INTEGER NOT NULL
);

-- 排行榜：按最高层降序、同层先到者在前。
CREATE INDEX idx_sect_towers_rank ON sect_towers (max_floor DESC, max_floor_at ASC);
