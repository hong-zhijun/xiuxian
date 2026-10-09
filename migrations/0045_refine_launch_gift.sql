-- Migration number: 0045 	 Name: refine_launch_gift
--
-- 装备祭炼上线贺礼（一次性数据迁移，随部署执行一次，d1_migrations 记录后不会重复发）：
--   给迁移时已存在的每个宗门 灵石 +10000、矿石 +5000（展示单位；库里是最小单位 ×1000）。
--
-- - 直接加在 resource_balances 上、不夹容量（与拍卖交付同一口径）：超出容量的部分保留，
--   只是满仓期间该资源不再自然产出。结算里的随机事件也不会再把超出容量的余额夹回容量
--   （同批修改的 settle.ts applyEventEffects）。
-- - 每个宗门写一条 event_log（refineLaunchGift，展示名见 events.ts 的 SYSTEM_EVENT_NAMES），
--   玩家在天机录里能看到这笔赠送。
-- - 之后新建的宗门不发。

UPDATE resource_balances SET balance = balance + 10000000 WHERE resource_id = 'spiritStone';

UPDATE resource_balances SET balance = balance + 5000000 WHERE resource_id = 'ore';

INSERT INTO event_log (id, sect_id, event_id, description, effects, created_at)
SELECT lower(hex(randomblob(16))), id, 'refineLaunchGift',
       '庆贺装备祭炼开启，宗门获赠灵石 10000、矿石 5000。',
       '{"spiritStone":"10000000","ore":"5000000"}',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects;
