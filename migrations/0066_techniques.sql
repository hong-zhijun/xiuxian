-- Migration number: 0066   Name: techniques
--
-- 功法（docs/功法开发计划.md）：
-- - sect_techniques：宗门级的收录 / 参悟进度与残卷数（level = 0 表示未收录，行保留用来记残卷）。
-- - disciples 三列：主修功法、熟练度基点（0~10000）、主修时刻。熟练度读时现算
--   （base + (now − since) / 48h × 10000），不需要定时任务；卸下主修时三列清空。

CREATE TABLE sect_techniques (
  sect_id TEXT NOT NULL REFERENCES sects (id) ON DELETE CASCADE,
  technique_id TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0 AND level <= 10),
  scrolls INTEGER NOT NULL DEFAULT 0 CHECK (scrolls >= 0),
  PRIMARY KEY (sect_id, technique_id)
);

ALTER TABLE disciples ADD COLUMN technique_id TEXT;
ALTER TABLE disciples ADD COLUMN technique_prof_base INTEGER NOT NULL DEFAULT 0
  CHECK (technique_prof_base BETWEEN 0 AND 10000);
ALTER TABLE disciples ADD COLUMN technique_since INTEGER;
