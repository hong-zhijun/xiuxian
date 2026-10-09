-- Migration number: 0044 	 Name: equipment_refine
--
-- 装备祭炼（docs/装备祭炼开发计划.md）：
--   equipment.refine_level <- 祭炼重数 0~12；成功时与 main_value / sub_value 一起写（增量直接写进数值列）。
--   equipment_refine_fails（新表）<- 每宗门「冲第 level 重」的连续失败次数（隐藏的成功率补偿）。
--
-- - CHECK 只写下限、不写上限：上限在 equipment.ts 的 REFINE_MAX_LEVEL / REFINE_FAILS_CAP（代码里夹取），
--   以后调上限不必重建表（SQLite 不能就地改 CHECK，见 0020 / 0033 的说明）。
-- - 旧装备一律 0 重，不需要回填；弟子的 gear_power_bp 也不用重算（0 重不加战力）。
-- - 宗门不会被删除：sect_id 不建 CASCADE（与 0042 同一做法）。

ALTER TABLE equipment ADD COLUMN refine_level INTEGER NOT NULL DEFAULT 0
  CHECK (refine_level >= 0);

CREATE TABLE equipment_refine_fails (
  sect_id TEXT NOT NULL,
  level INTEGER NOT NULL CHECK (level >= 1),
  fails INTEGER NOT NULL DEFAULT 0 CHECK (fails >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (sect_id, level)
);
