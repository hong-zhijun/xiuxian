-- Migration number: 0068   Name: journey_long_durations
--
-- 历练新增 12 / 24 小时档：0014 的 duration_seconds CHECK 只允许 7200 / 21600，
-- SQLite 改不了 CHECK，只能重建表（与 0018 同一顺序：先改名备份 → 建新表 → 拷数据 → 删备份 → 重建索引）。
-- 列与其余约束和 0014 + 0036（bonus_detail）+ 0061（recalled_at）完全一致，只放宽时长白名单。
-- 没有任何表对 disciple_journeys 建外键，改名与删除不会级联。

ALTER TABLE disciple_journeys RENAME TO disciple_journeys_0068_old;

CREATE TABLE disciple_journeys (
  id TEXT PRIMARY KEY,
  sect_id TEXT NOT NULL REFERENCES sects (id),
  -- 不设外键：历史记录必须能在弟子被驱逐后留存
  disciple_id TEXT NOT NULL,
  disciple_name TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('daoSeeking', 'gathering')),
  -- 时长白名单：2 / 6 / 12 / 24 小时
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds IN (7200, 21600, 43200, 86400)),
  original_assignment TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  completed_at INTEGER,
  claimed_at INTEGER,
  reward_cultivation INTEGER NOT NULL CHECK (reward_cultivation >= 0),
  reward_resources TEXT NOT NULL DEFAULT '{}',
  extra_harvest INTEGER NOT NULL DEFAULT 0 CHECK (extra_harvest IN (0, 1)),
  injured INTEGER NOT NULL DEFAULT 0 CHECK (injured IN (0, 1)),
  injury_chance_bp INTEGER NOT NULL CHECK (injury_chance_bp >= 0 AND injury_chance_bp <= 10000),
  cultivation_awarded INTEGER CHECK (cultivation_awarded IS NULL OR cultivation_awarded >= 0),
  created_at INTEGER NOT NULL,
  bonus_detail TEXT NOT NULL DEFAULT '{}',
  recalled_at INTEGER,
  CHECK (ends_at > started_at),
  CHECK (claimed_at IS NULL OR completed_at IS NOT NULL)
);

INSERT INTO disciple_journeys (
  id, sect_id, disciple_id, disciple_name, direction, duration_seconds, original_assignment,
  started_at, ends_at, completed_at, claimed_at, reward_cultivation, reward_resources,
  extra_harvest, injured, injury_chance_bp, cultivation_awarded, created_at, bonus_detail, recalled_at
)
SELECT
  id, sect_id, disciple_id, disciple_name, direction, duration_seconds, original_assignment,
  started_at, ends_at, completed_at, claimed_at, reward_cultivation, reward_resources,
  extra_harvest, injured, injury_chance_bp, cultivation_awarded, created_at, bonus_detail, recalled_at
FROM disciple_journeys_0068_old;

DROP TABLE disciple_journeys_0068_old;

CREATE UNIQUE INDEX disciple_journeys_active_disciple_idx
  ON disciple_journeys (disciple_id)
  WHERE claimed_at IS NULL;

CREATE INDEX disciple_journeys_sect_open_idx
  ON disciple_journeys (sect_id, claimed_at);

CREATE INDEX disciple_journeys_sect_started_idx
  ON disciple_journeys (sect_id, started_at DESC);

CREATE INDEX disciple_journeys_disciple_idx
  ON disciple_journeys (disciple_id);
