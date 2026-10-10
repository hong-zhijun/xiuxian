-- Migration number: 0046 	 Name: stone_gamble
--
-- 赌石（docs/赌石开发计划.md）：赌坊第四个玩法，花灵石 / 药材 / 矿石买原石，切开开出玄铁。
--   stone_gamble_busts（新表）<- 每宗门每档「连续垮了」的次数（隐藏保底，只在 service 里读写，不进任何接口 / 日志）。
--   stone_gamble_log（新表）<- 每次请求一行赌石记录（连切 10 块也只写一行）；cost / xuantie 存最小单位。
--
-- - CHECK 只写下限、不写上限：保底上限 STONE_PITY_BUSTS 在 stoneGamble.ts 里夹取（同 0044 的 REFINE_FAILS_CAP 做法），
--   以后调上限不必重建表（SQLite 不能就地改 CHECK，见 0020 / 0033 的说明）。
-- - 宗门不会被删除：sect_id 不建 CASCADE（与 0042 / 0044 同一做法）。

CREATE TABLE stone_gamble_busts (
  sect_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  busts INTEGER NOT NULL DEFAULT 0 CHECK (busts >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (sect_id, tier)
);

CREATE TABLE stone_gamble_log (
  id TEXT PRIMARY KEY,
  sect_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 1),
  pay_resource TEXT NOT NULL,
  cost INTEGER NOT NULL CHECK (cost >= 0),
  xuantie INTEGER NOT NULL CHECK (xuantie >= 0),
  bust_count INTEGER NOT NULL,
  small_count INTEGER NOT NULL,
  big_count INTEGER NOT NULL,
  jackpot_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_stone_gamble_log_sect ON stone_gamble_log (sect_id, created_at DESC);
