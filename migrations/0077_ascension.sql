-- Migration number: 0077   Name: ascension
--
-- 成仙状态独立于境界保存：渡劫后期弟子通过三劫后直接成仙。
-- 不改 realm_id / stage，不消耗资源；战力倍率由服务端按阶位计算。

ALTER TABLE disciples ADD COLUMN ascension_level INTEGER NOT NULL DEFAULT 0
  CHECK (ascension_level >= 0 AND ascension_level <= 1);

ALTER TABLE disciples ADD COLUMN ascension_pity INTEGER NOT NULL DEFAULT 0
  CHECK (ascension_pity >= 0);
