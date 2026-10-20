-- 灵兽收藏与服务端捕捉会话；培养仅消耗既有灵石、灵气。
CREATE TABLE spirit_beasts (
  id TEXT PRIMARY KEY, sect_id TEXT NOT NULL REFERENCES sects(id) ON DELETE CASCADE,
  species_id TEXT NOT NULL, quality TEXT NOT NULL CHECK(quality IN ('common','spirit','treasure','immortal')),
  level INTEGER NOT NULL DEFAULT 1 CHECK(level BETWEEN 1 AND 20),
  disciple_id TEXT REFERENCES disciples(id) ON DELETE SET NULL,
  locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0,1)), version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX spirit_beasts_sect ON spirit_beasts(sect_id,created_at);
CREATE UNIQUE INDEX spirit_beast_slot ON spirit_beasts(disciple_id) WHERE disciple_id IS NOT NULL;
ALTER TABLE disciples ADD COLUMN beast_json TEXT;
ALTER TABLE disciples ADD COLUMN capture_until INTEGER;
CREATE TABLE beast_capture_sessions (
  id TEXT PRIMARY KEY, sect_id TEXT NOT NULL REFERENCES sects(id) ON DELETE CASCADE,
  disciple_id TEXT NOT NULL, status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX beast_capture_active ON beast_capture_sessions(sect_id) WHERE status='active';
CREATE INDEX beast_capture_recent ON beast_capture_sessions(sect_id,created_at DESC);
-- 定时清理按 created_at 删除 7 天前的记录。
CREATE INDEX beast_capture_created ON beast_capture_sessions(created_at);
CREATE TABLE beast_capture_daily (
  sect_id TEXT NOT NULL REFERENCES sects(id) ON DELETE CASCADE, date_key TEXT NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0 CHECK(used_count>=0), PRIMARY KEY(sect_id,date_key)
);
CREATE TABLE beast_collection (
  sect_id TEXT NOT NULL REFERENCES sects(id) ON DELETE CASCADE, species_id TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 0, caught_count INTEGER NOT NULL DEFAULT 0,
  best_quality TEXT, PRIMARY KEY(sect_id,species_id)
);
CREATE TABLE beast_commands (
  sect_id TEXT NOT NULL REFERENCES sects(id) ON DELETE CASCADE, command_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL, session_id TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY(sect_id,command_id)
);
CREATE INDEX beast_commands_created ON beast_commands(created_at);
