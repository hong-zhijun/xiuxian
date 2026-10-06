-- Migration number: 0037 	 Name: gift_talent_pill
--
-- 运营发放：迁移执行时已存在的每个宗门，洗髓丹库存 +20（只发一次 —— 迁移只会执行一次）。
--   - 还没有洗髓丹库存行的宗门插入一行 quantity = 20；
--   - 已经有的在原库存上 +20（不覆盖）。
--   - 迁移之后新建的宗门不发。
-- 同一宗门同一丹药只有一行（UNIQUE (sect_id, pill_id)），所以用 upsert。
-- SQLite 的 INSERT ... SELECT 后面接 ON CONFLICT 时 SELECT 必须带 WHERE（否则有解析歧义），故写 WHERE true。

INSERT INTO pill_inventories (id, sect_id, pill_id, quantity, updated_at)
SELECT lower(hex(randomblob(16))), id, 'talentPill', 20, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects
WHERE true
ON CONFLICT (sect_id, pill_id) DO UPDATE SET
  quantity = quantity + 20,
  updated_at = excluded.updated_at;
