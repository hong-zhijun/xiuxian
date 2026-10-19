-- Migration number: 0069   Name: technique_shop
--
-- 功法商店（docs/藏经阁扩建与功法商店计划.md）：
--   technique_shop_daily（新表）<- 每宗门每天、每个品阶（玄 / 地）一行：当天已购买的残卷张数（bought）。
--   额度不落库：按藏经阁等级现算（techniques.ts 的 techniqueShopQuota），这张表只记「今天买了多少」。
--
-- - 购买时 upsert 累加（bought + 本次张数）；并发守卫靠 bought 挡住双击超额。
-- - 天阶残卷不在商店出售，tier 只允许 xuan / di。
-- - 宗门不会被删除：sect_id 不建 CASCADE（同 0048）。
-- - 旧日期的行不清理（每宗门每天每品阶至多两行，量很小）。

CREATE TABLE technique_shop_daily (
  sect_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('xuan', 'di')),
  bought INTEGER NOT NULL DEFAULT 0 CHECK (bought >= 0),
  PRIMARY KEY (sect_id, date_key, tier)
);
