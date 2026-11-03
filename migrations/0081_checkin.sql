-- Migration number: 0081   Name: checkin
-- 资源使用最小单位；缺失元数据行等价于 0/null，首次动作建立行但仍由 version=0 守卫。
CREATE TABLE sect_progression (
  sect_id TEXT NOT NULL PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  production_bonus_bp INTEGER NOT NULL DEFAULT 0 CHECK(production_bonus_bp >= 0),
  rename_tokens INTEGER NOT NULL DEFAULT 0 CHECK(rename_tokens >= 0),
  equipped_frame TEXT,
  equipped_title TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE sect_checkin (
  sect_id TEXT NOT NULL PRIMARY KEY,
  streak INTEGER NOT NULL DEFAULT 0 CHECK(streak >= 0),
  month_key TEXT NOT NULL,
  total_days INTEGER NOT NULL DEFAULT 0 CHECK(total_days >= 0),
  last_checkin_date TEXT,
  makeup_used INTEGER NOT NULL DEFAULT 0 CHECK(makeup_used BETWEEN 0 AND 3),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- 每日唯一凭据永久保留；补签同样受唯一键保护，不可重复获取日期奖励。
CREATE TABLE sect_checkin_days (
  sect_id TEXT NOT NULL, date_key TEXT NOT NULL, streak INTEGER NOT NULL,
  makeup INTEGER NOT NULL DEFAULT 0 CHECK(makeup IN(0,1)), created_at INTEGER NOT NULL,
  PRIMARY KEY(sect_id,date_key)
);
-- 成长命令回执不参加定时清理，commandId 重放跨天仍返回原消息且不重新发奖。
CREATE TABLE progression_commands (
  sect_id TEXT NOT NULL, command_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(sect_id,command_id)
);
