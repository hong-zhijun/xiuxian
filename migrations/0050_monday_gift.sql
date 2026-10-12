-- Migration number: 0050 	 Name: monday_gift
--
-- 周一上班福利（一次性数据迁移，随部署执行一次，d1_migrations 记录后不会重复发）：
--   给迁移时已存在的每个宗门 灵石 +10000、矿石 +10000（展示单位；库里是最小单位 ×1000）。
--
-- 做法与 0045 祭炼上线贺礼相同：
-- - 直接加在 resource_balances 上、不夹容量：超出容量的部分保留，只是满仓期间该资源不再自然产出。
-- - 每个宗门写一条 event_log（mondayGift，展示名见 events.ts 的 SYSTEM_EVENT_NAMES），玩家在天机录里能看到。
-- - 之后新建的宗门不发。

UPDATE resource_balances SET balance = balance + 10000000 WHERE resource_id = 'spiritStone';

UPDATE resource_balances SET balance = balance + 10000000 WHERE resource_id = 'ore';

INSERT INTO event_log (id, sect_id, event_id, description, effects, created_at)
SELECT lower(hex(randomblob(16))), id, 'mondayGift',
       '庆祝周一上班，宗门获赠灵石 10000、矿石 10000。',
       '{"spiritStone":"10000000","ore":"10000000"}',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects;
