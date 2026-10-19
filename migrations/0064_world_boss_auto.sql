-- Migration number: 0064   Name: world_boss_auto
--
-- 世界 Boss 自动讨伐：每个宗门独立保存开关、调度时间和短租约。
-- 只有打开开关的宗门会被定时任务取出；租约防止多个 Worker 实例重复执行同一宗门。

CREATE TABLE world_boss_auto_settings (
  sect_id TEXT PRIMARY KEY REFERENCES sects (id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  lock_until INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  last_result TEXT,
  pause_reason TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX world_boss_auto_due_idx
  ON world_boss_auto_settings (enabled, next_run_at, lock_until);
