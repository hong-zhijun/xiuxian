-- Migration number: 0065   Name: world_boss_auto_launch_gift
--
-- 自动讨伐上线贺礼：迁移执行时已经建立的每个宗门获赠聚气丹 200 颗。
-- 使用库存增量 upsert；D1 迁移记录保证只发放一次，之后新建的宗门不重复领取。

INSERT INTO pill_inventories (id, sect_id, pill_id, quantity, updated_at)
SELECT lower(hex(randomblob(16))), id, 'cultivationPill', 200,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects
WHERE true
ON CONFLICT (sect_id, pill_id) DO UPDATE SET
  quantity = quantity + 200,
  updated_at = excluded.updated_at;

INSERT INTO event_log (id, sect_id, event_id, description, effects, created_at)
SELECT lower(hex(randomblob(16))), id, 'worldBossAutoLaunchGift',
       '庆祝世界 Boss 自动讨伐上线，宗门获赠聚气丹 200 颗。',
       '{"cultivationPill":"200"}',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects;

INSERT INTO chat_messages (id, user_id, sect_name, content, created_at)
VALUES (
  'announcement-world-boss-auto-20261018',
  'system',
  '系统',
  '【自动讨伐上线贺礼】为庆祝世界 Boss 自动讨伐上线，更新时已建立的每个宗门获赠聚气丹 200 颗，已直接放入丹药库存，无需领取。祝各位掌门讨伐顺利！',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
ON CONFLICT (id) DO NOTHING;
