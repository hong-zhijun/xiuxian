-- Migration number: 0057   Name: disciple_capacity_gift
--
-- 宗门弟子扩容贺礼：执行迁移时已存在的每个宗门获赠 2000 灵石。
-- 展示单位 ×1000 = 数据库最小单位，2000 灵石对应 2000000。
-- 沿用运营福利口径：直接加余额、不夹仓库容量，每宗门在天机录留一条记录。
-- d1_migrations 保证整份迁移只执行一次，之后新建的宗门不发。

UPDATE resource_balances
SET balance = balance + 2000000
WHERE resource_id = 'spiritStone';

INSERT INTO event_log (id, sect_id, event_id, description, effects, created_at)
SELECT lower(hex(randomblob(16))), id, 'discipleCapacityGift',
       '庆贺宗门弟子上限提升，宗门获赠 2000 灵石，可用于招贤刷新，广纳贤才。',
       '{"spiritStone":"2000000"}',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects;
