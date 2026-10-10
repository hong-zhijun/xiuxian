-- Migration number: 0048 	 Name: daily_tasks
--
-- 宗门日课（docs/每日任务开发计划.md）：
--   daily_tasks（新表）<- 每宗门每天一行：当天抽到的 5 个任务（tasks）、已领取的任务（claimed）、宝箱是否已开（chest_claimed）。
--   进度不落库：全部从现有的记录表（世界 Boss 出手、探索、挑战、切磋……）按「本宗、今天」现算。
--
-- - 第一次读取当天日课时写入（INSERT ... ON CONFLICT DO NOTHING，并发首读只会留下一份）；之后一整天不变。
-- - version 每次写入 +1，领取 / 开箱的并发守卫靠它挡住双击。
-- - 宗门不会被删除：sect_id 不建 CASCADE（同 0042 / 0044）。
-- - 旧日期的行不清理（每宗门每天一行，量很小）；跨天未领的作废，不补发。

CREATE TABLE daily_tasks (
  sect_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  -- JSON 数组：当天抽到的任务 id（顺序即展示顺序）
  tasks TEXT NOT NULL,
  -- JSON 数组：已领取的任务 id
  claimed TEXT NOT NULL DEFAULT '[]',
  chest_claimed INTEGER NOT NULL DEFAULT 0 CHECK (chest_claimed IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (sect_id, date_key)
);
