-- Migration number: 0075   Name: scratch_card_update_gift
--
-- 刮刮乐更新福利：部署迁移时已建立的每个宗门获赠 10000（1 万）灵石。
-- 展示单位 ×1000 = 数据库最小单位：10000 灵石 = 10000000。
-- 沿用运营福利口径：直接加余额，不夹仓库容量，缺失的灵石余额行先补齐。
-- 迁移与 d1_migrations 记录在同一事务提交，之后新建的宗门不发。
-- 每宗门使用固定天机录 id 作为发奖凭据，即使重复执行 SQL 也不会重复加款。

INSERT INTO resource_balances (id, sect_id, resource_id, balance, remainder, updated_at)
SELECT lower(hex(randomblob(16))), sects.id, 'spiritStone', 0, 0,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects
WHERE NOT EXISTS (
  SELECT 1 FROM resource_balances rb
   WHERE rb.sect_id = sects.id AND rb.resource_id = 'spiritStone'
);

UPDATE resource_balances
SET balance = balance + 10000000,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE resource_id = 'spiritStone'
  AND NOT EXISTS (
    SELECT 1 FROM event_log
     WHERE id = 'scratch-card-update-gift-20261024:' || resource_balances.sect_id
  );

INSERT INTO event_log (id, sect_id, event_id, description, effects, created_at)
SELECT 'scratch-card-update-gift-20261024:' || id, id, 'scratchCardUpdateGift',
       '庆贺刮刮乐四种玩法上线，宗门获赠 10000（1 万）灵石更新奖励，已直接到账，无需领取。',
       '{"spiritStone":"10000000"}',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects
WHERE NOT EXISTS (
  SELECT 1 FROM event_log
   WHERE id = 'scratch-card-update-gift-20261024:' || sects.id
);

INSERT INTO chat_messages (id, user_id, sect_name, content, created_at)
VALUES (
  'announcement-scratch-card-update-20261024',
  'system',
  '系统',
  '【刮刮乐更新】赌坊新增三同聚宝、幸运对号、点数争锋、八线来财四种刮刮乐，分别支持三同中奖、号码奖金累加、比大小全胜加奖、连线与满盘叠奖！可选 50 / 200 / 500 灵石票价，支持鼠标与触屏刮奖，刮开 80% 后松手自动揭晓。更新福利：发放时已建立的每个宗门获赠 10000（1 万）灵石，已直接到账，无需领取，超出仓库容量也会保留，天机录可查看「刮刮乐更新奖励」。',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
ON CONFLICT (id) DO NOTHING;
