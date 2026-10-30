-- 飞升贺礼：发放时已建立的每个宗门获赠 100000（10 万）灵气。
-- 展示单位 ×1000 = 100000000 最小单位；不受库存限制，缺失余额行先补齐。
-- 每宗门固定天机录 id 防止重发；迁移与迁移记录在同一事务提交。

INSERT INTO resource_balances (id, sect_id, resource_id, balance, remainder, updated_at)
SELECT lower(hex(randomblob(16))), sects.id, 'spiritualEnergy', 0, 0,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects
WHERE NOT EXISTS (
  SELECT 1 FROM resource_balances rb
   WHERE rb.sect_id = sects.id AND rb.resource_id = 'spiritualEnergy'
);

UPDATE resource_balances
SET balance = balance + 100000000,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE resource_id = 'spiritualEnergy'
  AND NOT EXISTS (
    SELECT 1 FROM event_log
     WHERE id = 'ascension-gift-20261030:' || resource_balances.sect_id
  );

INSERT INTO event_log (id, sect_id, event_id, description, effects, created_at)
SELECT 'ascension-gift-20261030:' || id, id, 'ascensionGift',
       '飞升贺礼：宗门获赠 100000（10 万）灵气，已直接到账，无需领取。',
       '{"spiritualEnergy":"100000000"}',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects
WHERE NOT EXISTS (
  SELECT 1 FROM event_log
   WHERE id = 'ascension-gift-20261030:' || sects.id
);

INSERT INTO chat_messages (id, user_id, sect_name, content, created_at)
VALUES (
  'announcement-ascension-gift-20261030',
  'system',
  '系统',
  '【飞升贺礼】修炼速度大幅提升，弟子静修基础速度提升至原来的 10 倍！装备新增一键祭炼，连续尝试直到材料不足或十二重圆满。贺礼发放时已建立的每个宗门获赠 100000（10 万）灵气，已直接到账，无需领取，天机录可查看「飞升贺礼」。祝各位掌门早日飞升！',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
ON CONFLICT (id) DO NOTHING;
