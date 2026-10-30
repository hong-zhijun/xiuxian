-- Migration number: 0078   Name: ascension_spirit_stone_gift
-- 飞升玩法上线贺礼：发放时已建立的每个宗门获赠 50000（5 万）灵石。
-- 展示单位 ×1000 = 50000000 最小单位；固定天机录 id 防止重复发放。

INSERT INTO resource_balances (id, sect_id, resource_id, balance, remainder, updated_at)
SELECT lower(hex(randomblob(16))), sects.id, 'spiritStone', 0, 0,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects
WHERE NOT EXISTS (
  SELECT 1 FROM resource_balances rb
   WHERE rb.sect_id = sects.id AND rb.resource_id = 'spiritStone'
);

UPDATE resource_balances
SET balance = balance + 50000000,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE resource_id = 'spiritStone'
  AND NOT EXISTS (
    SELECT 1 FROM event_log
     WHERE id = 'ascension-spirit-stone-gift-20261031:' || resource_balances.sect_id
  );

INSERT INTO event_log (id, sect_id, event_id, description, effects, created_at)
SELECT 'ascension-spirit-stone-gift-20261031:' || id, id, 'ascensionSpiritStoneGift',
       '飞升玩法上线贺礼：宗门获赠 50000（5 万）灵石，已直接到账，无需领取。',
       '{"spiritStone":"50000000"}',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects
WHERE NOT EXISTS (
  SELECT 1 FROM event_log
   WHERE id = 'ascension-spirit-stone-gift-20261031:' || sects.id
);

INSERT INTO chat_messages (id, user_id, sect_name, content, created_at)
VALUES (
  'announcement-ascension-spirit-stone-gift-20261031',
  'system',
  '系统',
  '【飞升贺礼】渡劫后期弟子现在可以挑战飞升天门，三劫成功后战力大幅提升！玩法上线贺礼：发放时已建立的每个宗门获赠 50000（5 万）灵石，已直接到账，无需领取，天机录可查看「飞升贺礼」。',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
ON CONFLICT (id) DO NOTHING;
