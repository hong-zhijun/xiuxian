-- Migration number: 0036 	 Name: journey_bonus
--
-- 历练奖励丰富化（docs/境界与宗门等级扩充开发计划.md 第 3 节）：
--   disciple_journeys.bonus_detail <- 出发时与额外收获 / 受伤一起掷出的额外奖励（受控 JSON）：
--     { "fortune": 机遇（保底修为再 +100%，已并入 reward_cultivation）,
--       "insight": 悟道（领取时悟道值 +1，已满则不得）,
--       "attribute": 淬炼（领取时该属性 +1，封顶 100；null = 没抽中） }
--   旧记录默认 '{}'，读取时按「没有额外奖励」处理。
--
-- 境界 / 宗门等级扩充本身不需要迁移：两者都是代码常量，数据库对 realm_id / level 没有约束。

ALTER TABLE disciple_journeys ADD COLUMN bonus_detail TEXT NOT NULL DEFAULT '{}';
