-- Migration number: 0074 	 Name: friday_gift
--
-- 周五下班福利（一次性数据迁移，随部署执行一次，d1_migrations 记录后不会重复发）：
--   给执行迁移时已存在的每个宗门 灵气 +10000（展示单位；库里是最小单位 ×1000 = 10000000），
--   并发一条全服系统公告「庆祝周五下班发灵气」。
--
-- 口径沿用 0071 灵兽上线贺礼（运营福利）：
-- - 直接加在 resource_balances 上、不夹仓库容量：超出容量的部分保留，只是满仓期间灵气不再自然产出；
-- - 每个宗门写一条 event_log（fridayGift，展示名「周五福利」见 events.ts 的 SYSTEM_EVENT_NAMES），
--   玩家在天机录里能看到；
-- - 公告用固定 id，迁移重试不会重复；
-- - 之后新建的宗门不发。

-- 理论上每个宗门都有这行余额（建宗按配置带上）；缺行的先补 0，保证人人到账。
INSERT INTO resource_balances (id, sect_id, resource_id, balance, remainder, updated_at)
SELECT lower(hex(randomblob(16))), sects.id, 'spiritualEnergy', 0, 0,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects
WHERE NOT EXISTS (
  SELECT 1 FROM resource_balances rb
   WHERE rb.sect_id = sects.id AND rb.resource_id = 'spiritualEnergy'
);

UPDATE resource_balances
SET balance = balance + 10000000
WHERE resource_id = 'spiritualEnergy';

INSERT INTO event_log (id, sect_id, event_id, description, effects, created_at)
SELECT lower(hex(randomblob(16))), id, 'fridayGift',
       '庆祝周五下班，宗门获赠灵气 10000。',
       '{"spiritualEnergy":"10000000"}',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects;

INSERT INTO chat_messages (id, user_id, sect_name, content, created_at)
VALUES (
  'announcement-friday-gift-20261023',
  'system',
  '系统',
  '【周五福利】庆祝周五下班，发灵气啦！福利发放时已建立的每个宗门均已获赠 10000 灵气，已直接到账、无需领取，天机录可查看「周五福利」。祝各位掌门周末修炼顺利！',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
ON CONFLICT (id) DO NOTHING;
