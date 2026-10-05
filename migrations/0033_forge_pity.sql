-- Migration number: 0033 	 Name: forge_pity
--
-- 炼器仙品保底：
--   sects.forge_pity <- 连续炼仙品没出仙品的次数（0~4）；每层下次仙品成功率 +10%，出仙品后清零。
--                       只在炼器 / 装备面板单独读写（repository.findForgePity / updateForgePityStatement），
--                       不进 SectRow。
--
-- - NOT NULL DEFAULT 0：旧宗门从 0 层开始，不需要回填。
-- - CHECK 只限 >= 0、不写上限：层数上限是 equipment.ts 的 FORGE_PITY_MAX（代码里夹取），
--   以后调上限不必重建 sects（SQLite 不能就地改 CHECK，见 0020 的说明）。

ALTER TABLE sects ADD COLUMN forge_pity INTEGER NOT NULL DEFAULT 0
  CHECK (forge_pity >= 0);
