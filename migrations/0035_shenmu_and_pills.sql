-- Migration number: 0035 	 Name: shenmu_and_pills
--
-- 神木与新丹药：
--   1. 新资源「神木」（game-config v9.0.0）：所有已有宗门补一行余额（0）；新宗门建宗时按配置自动带上。
--      （config_versions 的 v9.0.0 行由 scripts/seed/seed.sql 负责，运行时不读这张表。）
--   2. disciples.aptitude_pill_count <- 已服用培元丹次数（上限见 alchemy.ts 的 APTITUDE_PILL_MAX_USES）。
--      CHECK 只限 >= 0、不写上限：上限在代码里判定，以后调上限不必重建 disciples（见 0020 的说明）。
--   悟道丹（加悟道值）与凝元丹（大聚气丹）不需要新列：悟道值沿用 0019 的两列，修为沿用 cultivation。

INSERT INTO resource_balances (id, sect_id, resource_id, balance, remainder, updated_at)
SELECT lower(hex(randomblob(16))), id, 'shenmu', 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects
WHERE NOT EXISTS (
  SELECT 1 FROM resource_balances rb WHERE rb.sect_id = sects.id AND rb.resource_id = 'shenmu'
);

ALTER TABLE disciples ADD COLUMN aptitude_pill_count INTEGER NOT NULL DEFAULT 0
  CHECK (aptitude_pill_count >= 0);
