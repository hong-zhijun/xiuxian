-- Migration number: 0080   Name: full_server_training_gift
-- 全民修炼补给：发放时已建立的每个宗门获赠 20000 灵气与 20000 灵石。
-- 展示单位 ×1000 = 20000000 最小单位；固定天机录 id 防止重复发放。

INSERT INTO resource_balances (id, sect_id, resource_id, balance, remainder, updated_at)
SELECT lower(hex(randomblob(16))), sects.id, gift.resource_id, 0, 0,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects
JOIN (SELECT 'spiritualEnergy' AS resource_id UNION ALL SELECT 'spiritStone') AS gift
WHERE NOT EXISTS (
  SELECT 1 FROM resource_balances rb
   WHERE rb.sect_id = sects.id AND rb.resource_id = gift.resource_id
);

UPDATE resource_balances
SET balance = balance + 20000000,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE resource_id IN ('spiritualEnergy', 'spiritStone')
  AND NOT EXISTS (
    SELECT 1 FROM event_log
     WHERE id = 'full-server-training-gift-20261101:' || resource_balances.sect_id
  );

INSERT INTO event_log (id, sect_id, event_id, description, effects, created_at)
SELECT 'full-server-training-gift-20261101:' || id, id, 'fullServerTrainingGift',
       '全民修炼补给：宗门获赠 20000 灵气与 20000 灵石，已直接到账，无需领取。',
       '{"spiritualEnergy":"20000000","spiritStone":"20000000"}',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects
WHERE NOT EXISTS (
  SELECT 1 FROM event_log
   WHERE id = 'full-server-training-gift-20261101:' || sects.id
);

INSERT INTO chat_messages (id, user_id, sect_name, content, created_at)
VALUES (
  'announcement-full-server-training-gift-20261101',
  'system',
  '系统',
  '【全民修炼补给】全服发放修炼补给：发放时已建立的每个宗门获赠 20000 灵气与 20000 灵石，已直接到账，无需领取，天机录可查看「全民修炼补给」。',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
ON CONFLICT (id) DO NOTHING;
