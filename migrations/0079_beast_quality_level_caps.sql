-- 灵兽按品质开放等级上限；保留现有灵兽身份、随行、锁定、版本和时间。
-- SQLite 无法直接修改 CHECK，先复制到新表，再替换旧表并恢复索引。
CREATE TABLE spirit_beasts_0079 (
  id TEXT PRIMARY KEY, sect_id TEXT NOT NULL REFERENCES sects(id) ON DELETE CASCADE,
  species_id TEXT NOT NULL, quality TEXT NOT NULL CHECK(quality IN ('common','spirit','treasure','immortal')),
  level INTEGER NOT NULL DEFAULT 1 CHECK(level >= 1 AND level <= CASE quality
    WHEN 'common' THEN 20 WHEN 'spirit' THEN 30 WHEN 'treasure' THEN 40 WHEN 'immortal' THEN 60 END),
  disciple_id TEXT REFERENCES disciples(id) ON DELETE SET NULL,
  locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0,1)), version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
INSERT INTO spirit_beasts_0079 (id,sect_id,species_id,quality,level,disciple_id,locked,version,created_at,updated_at)
SELECT id,sect_id,species_id,quality,level,disciple_id,locked,version,created_at,updated_at FROM spirit_beasts;
DROP TABLE spirit_beasts;
ALTER TABLE spirit_beasts_0079 RENAME TO spirit_beasts;
CREATE INDEX spirit_beasts_sect ON spirit_beasts(sect_id,created_at);
CREATE UNIQUE INDEX spirit_beast_slot ON spirit_beasts(disciple_id) WHERE disciple_id IS NOT NULL;
