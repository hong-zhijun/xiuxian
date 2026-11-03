-- Migration number: 0086   Name: alliance
CREATE TABLE alliances (
  id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL UNIQUE, leader_sect_id TEXT NOT NULL,
  member_limit INTEGER NOT NULL DEFAULT 5 CHECK(member_limit=5),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), dissolved_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE alliance_members (
  sect_id TEXT NOT NULL PRIMARY KEY, alliance_id TEXT NOT NULL,
  contribution INTEGER NOT NULL DEFAULT 0 CHECK(contribution>=0), joined_at INTEGER NOT NULL
);
CREATE INDEX alliance_members_alliance ON alliance_members(alliance_id,joined_at,sect_id);
CREATE TABLE alliance_invites (
  id TEXT NOT NULL PRIMARY KEY, alliance_id TEXT NOT NULL, target_sect_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL, accepted_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX alliance_invites_target ON alliance_invites(target_sect_id,expires_at);
CREATE TABLE sect_alliance_wallets (
  sect_id TEXT NOT NULL PRIMARY KEY, merit INTEGER NOT NULL DEFAULT 0 CHECK(merit>=0),
  join_cooldown_until INTEGER, version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), updated_at INTEGER NOT NULL
);
CREATE TABLE alliance_bosses (
  id TEXT NOT NULL PRIMARY KEY, alliance_id TEXT NOT NULL, week_key TEXT NOT NULL,
  max_hp INTEGER NOT NULL CHECK(max_hp>0), remaining_hp INTEGER NOT NULL CHECK(remaining_hp>=0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','settled')),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), started_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL, settled_at INTEGER, UNIQUE(alliance_id,week_key)
);
CREATE INDEX alliance_boss_due ON alliance_bosses(status,ends_at);
CREATE TABLE alliance_boss_hits (
  id TEXT NOT NULL PRIMARY KEY, boss_id TEXT NOT NULL, alliance_id TEXT NOT NULL,
  sect_id TEXT NOT NULL, sect_name TEXT NOT NULL, date_key TEXT NOT NULL,
  damage INTEGER NOT NULL CHECK(damage>0), party TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX alliance_boss_hits_ranking ON alliance_boss_hits(boss_id,sect_id);
CREATE INDEX alliance_boss_hits_daily ON alliance_boss_hits(sect_id,date_key);
CREATE TABLE alliance_boss_rewards (
  boss_id TEXT NOT NULL, sect_id TEXT NOT NULL, rank INTEGER NOT NULL,
  merit INTEGER NOT NULL CHECK(merit>0), created_at INTEGER NOT NULL, PRIMARY KEY(boss_id,sect_id)
);
CREATE TABLE alliance_commands (
  sect_id TEXT NOT NULL, command_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(sect_id,command_id)
);
ALTER TABLE chat_messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'world';
ALTER TABLE chat_messages ADD COLUMN scope_id TEXT NOT NULL DEFAULT '';
CREATE INDEX chat_messages_scope ON chat_messages(channel,scope_id,created_at,id);
