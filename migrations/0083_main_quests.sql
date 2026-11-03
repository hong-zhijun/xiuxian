-- Migration number: 0083   Name: main_quests
CREATE TABLE sect_quests (
  sect_id TEXT NOT NULL PRIMARY KEY, chapter_id TEXT NOT NULL DEFAULT 'kaishan',
  step_index INTEGER NOT NULL DEFAULT 0 CHECK(step_index >= 0),
  completed TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  updated_at INTEGER NOT NULL
);
-- 读取主线时记录已经观测到的步骤。INSERT OR IGNORE 合并事实，避免并发 GET 互相覆盖；
-- 不建立新的玩法计数，不伪造被清理历史，保证消耗库存/分解装备后已完成引导不会倒退。
CREATE TABLE sect_quest_steps (
  sect_id TEXT NOT NULL, step_id TEXT NOT NULL, completed_at INTEGER NOT NULL,
  PRIMARY KEY(sect_id,step_id)
);
