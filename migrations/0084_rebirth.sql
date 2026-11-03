-- Migration number: 0084   Name: rebirth
-- 每次开辟新界/道韵兑换同时递增本表与sect_progression.version，阻止旧快照写回。
CREATE TABLE sect_rebirth (
  sect_id TEXT NOT NULL PRIMARY KEY,
  cycle INTEGER NOT NULL DEFAULT 0 CHECK(cycle >= 0),
  dao_yun INTEGER NOT NULL DEFAULT 0 CHECK(dao_yun >= 0),
  bonus_production_bp INTEGER NOT NULL DEFAULT 0 CHECK(bonus_production_bp >= 0),
  bonus_breakthrough_bp INTEGER NOT NULL DEFAULT 0 CHECK(bonus_breakthrough_bp >= 0),
  bonus_power_bp INTEGER NOT NULL DEFAULT 0 CHECK(bonus_power_bp >= 0),
  disciple_capacity_floor INTEGER NOT NULL DEFAULT 0 CHECK(disciple_capacity_floor >= 0),
  building_capacity_floor INTEGER NOT NULL DEFAULT 0 CHECK(building_capacity_floor >= 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  last_rebirth_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE rebirth_purchases (
  sect_id TEXT NOT NULL, item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0), updated_at INTEGER NOT NULL,
  PRIMARY KEY(sect_id,item_id)
);
-- 回执永久保存；同commandId即使跨周目也不重新结算或扣费。
CREATE TABLE rebirth_commands (
  sect_id TEXT NOT NULL, command_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(sect_id,command_id)
);
