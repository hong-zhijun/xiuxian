-- Migration number: 0034 	 Name: talent_rework
--
-- 天赋重构（docs/天赋重构开发计划.md）：
--   disciples.talent_reroll_count    <- 已服用洗髓丹次数（上限 4，见 talents.ts 的 TALENT_REROLL_MAX_USES）。
--   disciples.talent_candidate       <- 洗髓丹洗出、尚未决定的候选天赋 id；NULL = 没有待决定的候选。
--   disciples.steward_handover_until <- 卸任执事后的交接期结束时间（UTC 毫秒）；期间不能出战；NULL = 无。
--   sect_stewards（新表）            <- 执事堂：每宗门每个职位一行；disciple_id 为 NULL 表示空缺，
--                                       保留这一行是为了记住「今天已经任命过」（appointed_date_key）。
--
-- - 天赋 id 不建 CHECK：天赋定义属于代码常量（与 pill_id 同理），以后增删天赋不必重建表。
-- - 老弟子的 talent 列不动：保留的 4 个 id 只改名字与效果。
-- - sect_stewards.disciple_id 不建外键：驱逐弟子时由服务端同批把职位置空（与装备的归属列同一做法）。

ALTER TABLE disciples ADD COLUMN talent_reroll_count INTEGER NOT NULL DEFAULT 0
  CHECK (talent_reroll_count >= 0);

ALTER TABLE disciples ADD COLUMN talent_candidate TEXT;

ALTER TABLE disciples ADD COLUMN steward_handover_until INTEGER;

CREATE TABLE sect_stewards (
  sect_id TEXT NOT NULL REFERENCES sects (id),
  office TEXT NOT NULL,
  disciple_id TEXT,
  appointed_date_key TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (sect_id, office)
);
