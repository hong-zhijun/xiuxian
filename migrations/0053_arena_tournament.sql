-- Migration number: 0053 	 Name: arena_tournament
--
-- 宗门大比（docs/宗门大比开发计划.md 第 6 节）：每日 12:00（UTC+8）结算的个人赛（斗法台）与团队赛（宗门战），
-- 每周一个赛季（周日 12:00 结算赛季奖励）。
--   arena_seasons（新表）<- 每个赛季一行：起止日期、团队赛战力上限（周一 0 点按当时的宗门算定，赛季内不变）、赛季奖励是否已发
--   arena_entries（新表）<- 报名 / 自动参赛的阵容：每宗门每种赛制每天一行；auto = 1 为系统自动选出
--   arena_individual_scores / arena_team_scores（新表）<- 每日积分（日榜）；每天结算时写满全部参赛者（无场次也写一行），
--     写入即标记「当天已结算」，结算守卫据此保证只发一次奖
--   arena_season_individual / arena_season_team（新表）<- 赛季累计积分（天榜 / 宗榜）
--   arena_individual_matches / arena_team_matches（新表）<- 战报；只保留最近几天（定时任务清理）
--   arena_rewards（新表）<- 奖励发放记录
--
-- 金额一律是最小单位（1 展示单位 = 1000 最小单位）；规则与战斗都在 arena.ts（纯函数），这里只存结果。

CREATE TABLE arena_seasons (
  id TEXT PRIMARY KEY,                    -- 赛季 id（如 '2026-W42'）
  start_date TEXT NOT NULL,               -- 赛季起始日期（UTC+8，如 '2026-10-13'）
  end_date TEXT NOT NULL,                 -- 赛季结束日期
  team_power_cap INTEGER,                 -- 团队赛战力上限
  settled INTEGER NOT NULL DEFAULT 0,     -- 是否已结算赛季奖励（0/1）
  created_at INTEGER NOT NULL
);

-- 宗门大比报名（个人赛 + 团队赛共用）
CREATE TABLE arena_entries (
  sect_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('individual', 'team')),
  -- 出战弟子 id 的 JSON 数组（按出战顺序）；自动参赛的也写入（标记 auto = 1）
  lineup TEXT NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0,        -- 0 = 手动报名, 1 = 系统自动
  date_key TEXT NOT NULL,                 -- UTC+8 日期（如 '2026-10-13'）
  created_at INTEGER NOT NULL,
  PRIMARY KEY (sect_id, kind, date_key)
);

-- 个人赛每日积分
CREATE TABLE arena_individual_scores (
  date_key TEXT NOT NULL,
  disciple_id TEXT NOT NULL,
  sect_id TEXT NOT NULL,
  disciple_name TEXT NOT NULL,
  combat_power INTEGER NOT NULL,
  wins REAL NOT NULL DEFAULT 0,           -- 胜场（平局算 0.5）
  losses REAL NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,      -- 积分
  total_damage INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (date_key, disciple_id)
);

CREATE INDEX idx_arena_ind_scores_date ON arena_individual_scores (date_key, points DESC);

-- 团队赛每日积分
CREATE TABLE arena_team_scores (
  date_key TEXT NOT NULL,
  sect_id TEXT NOT NULL,
  sect_name TEXT NOT NULL,
  team_power INTEGER NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  kills INTEGER NOT NULL DEFAULT 0,       -- 总击杀数（同分排序用）
  created_at INTEGER NOT NULL,
  PRIMARY KEY (date_key, sect_id)
);

CREATE INDEX idx_arena_team_scores_date ON arena_team_scores (date_key, points DESC);

-- 赛季累计积分（个人）
CREATE TABLE arena_season_individual (
  season_id TEXT NOT NULL,
  disciple_id TEXT NOT NULL,
  sect_id TEXT NOT NULL,
  disciple_name TEXT NOT NULL,
  total_points INTEGER NOT NULL DEFAULT 0,
  total_wins REAL NOT NULL DEFAULT 0,
  total_losses REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (season_id, disciple_id)
);

-- 赛季累计积分（团队）
CREATE TABLE arena_season_team (
  season_id TEXT NOT NULL,
  sect_id TEXT NOT NULL,
  sect_name TEXT NOT NULL,
  total_points INTEGER NOT NULL DEFAULT 0,
  total_wins INTEGER NOT NULL DEFAULT 0,
  total_losses INTEGER NOT NULL DEFAULT 0,
  total_kills INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (season_id, sect_id)
);

-- 对战记录（个人赛每场 1v1）
CREATE TABLE arena_individual_matches (
  id TEXT PRIMARY KEY,
  date_key TEXT NOT NULL,
  -- 甲方
  fighter_a_id TEXT NOT NULL,
  fighter_a_name TEXT NOT NULL,
  fighter_a_sect_id TEXT NOT NULL,
  fighter_a_power INTEGER NOT NULL,
  -- 乙方
  fighter_b_id TEXT NOT NULL,
  fighter_b_name TEXT NOT NULL,
  fighter_b_sect_id TEXT NOT NULL,
  fighter_b_power INTEGER NOT NULL,
  -- 结果
  winner_id TEXT,                          -- null = 平局
  rounds TEXT NOT NULL,                   -- 回合详情 JSON
  fighter_a_hp_pct INTEGER NOT NULL,      -- 甲方剩余血量百分比 (0~100)
  fighter_b_hp_pct INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_arena_ind_matches_date ON arena_individual_matches (date_key);

-- 对战记录（团队赛：一场车轮战）
CREATE TABLE arena_team_matches (
  id TEXT PRIMARY KEY,
  date_key TEXT NOT NULL,
  sect_a_id TEXT NOT NULL,
  sect_a_name TEXT NOT NULL,
  sect_b_id TEXT NOT NULL,
  sect_b_name TEXT NOT NULL,
  winner_sect_id TEXT NOT NULL,
  -- 车轮战的每场 1v1 详情（JSON 数组，每个元素包含双方弟子、回合、胜负）
  duels TEXT NOT NULL,
  sect_a_kills INTEGER NOT NULL,
  sect_b_kills INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_arena_team_matches_date ON arena_team_matches (date_key);

-- 奖励发放记录（防重复发放）
CREATE TABLE arena_rewards (
  id TEXT PRIMARY KEY,
  date_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('daily_individual', 'daily_team', 'season_individual', 'season_team')),
  sect_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  rewards TEXT NOT NULL,                  -- {资源id: 最小单位} 的 JSON
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_arena_rewards_date ON arena_rewards (date_key, kind);
