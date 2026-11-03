-- Migration number: 0082   Name: achievements
-- 成就原始进度从现存角色/图鉴/日志读取；领取后不会因历史清理退回。
-- 山河供奉日志会清理，因此从存量日志补计并在新增日志时保存累计值。
CREATE TABLE sect_achievement_counters (
  sect_id TEXT NOT NULL, stat_id TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0 CHECK(value >= 0),
  PRIMARY KEY(sect_id,stat_id)
);
INSERT INTO sect_achievement_counters(sect_id,stat_id,value)
SELECT sect_id,'tribute',MAX(0,SUM(CASE WHEN json_valid(effects) THEN
  CAST(COALESCE(json_extract(effects,'$.spiritualEnergy'),0) AS INTEGER) ELSE 0 END))
FROM world_site_logs WHERE kind='settle' GROUP BY sect_id;
CREATE TRIGGER progression_tribute_insert AFTER INSERT ON world_site_logs
WHEN NEW.kind='settle' AND json_valid(NEW.effects)
BEGIN
  INSERT INTO sect_achievement_counters(sect_id,stat_id,value)
  VALUES(NEW.sect_id,'tribute',MAX(0,CAST(COALESCE(json_extract(NEW.effects,'$.spiritualEnergy'),0) AS INTEGER)))
  ON CONFLICT(sect_id,stat_id) DO UPDATE SET value=value+excluded.value;
END;
CREATE TABLE sect_achievements (
  sect_id TEXT NOT NULL, achievement_id TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0 CHECK(progress >= 0),
  claimed INTEGER NOT NULL DEFAULT 0 CHECK(claimed IN(0,1)), claimed_at INTEGER,
  updated_at INTEGER NOT NULL, PRIMARY KEY(sect_id,achievement_id)
);
CREATE TABLE sect_cosmetics (
  sect_id TEXT NOT NULL, cosmetic_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('frame','title')), name TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY(sect_id,cosmetic_id)
);
CREATE TABLE sect_reputation_purchases (
  sect_id TEXT NOT NULL, item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0), updated_at INTEGER NOT NULL,
  PRIMARY KEY(sect_id,item_id)
);
