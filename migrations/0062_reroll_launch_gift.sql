-- Migration number: 0062   Name: reroll_launch_gift
--
-- 装备洗练上线贺礼：执行迁移时已存在的每个宗门获赠 3000 灵石、20 玄铁，并发一条全服系统公告。
-- 展示单位 ×1000 = 数据库最小单位：3000 灵石 = 3000000，20 玄铁 = 20000。
-- 沿用运营福利口径（0045 / 0057）：直接加余额、不夹仓库容量，每宗门在天机录留一条记录。
-- d1_migrations 保证整份迁移只执行一次，之后新建的宗门不发；公告用固定 id，重试不会重复。

-- 理论上每个宗门都有这两行余额（建宗按配置带上，0030 补过玄铁）；缺行的先补 0，保证人人到账。
INSERT INTO resource_balances (id, sect_id, resource_id, balance, remainder, updated_at)
SELECT lower(hex(randomblob(16))), sects.id, r.resource_id, 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects
CROSS JOIN (SELECT 'spiritStone' AS resource_id UNION ALL SELECT 'xuantie') AS r
WHERE NOT EXISTS (
  SELECT 1 FROM resource_balances rb WHERE rb.sect_id = sects.id AND rb.resource_id = r.resource_id
);

UPDATE resource_balances
SET balance = balance + 3000000
WHERE resource_id = 'spiritStone';

UPDATE resource_balances
SET balance = balance + 20000
WHERE resource_id = 'xuantie';

INSERT INTO event_log (id, sect_id, event_id, description, effects, created_at)
SELECT lower(hex(randomblob(16))), id, 'rerollLaunchGift',
       '庆贺装备洗练开启，宗门获赠灵石 3000、玄铁 20。',
       '{"spiritStone":"3000000","xuantie":"20000"}',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects;

INSERT INTO chat_messages (id, user_id, sect_name, content, created_at)
VALUES (
  'announcement-reroll-launch-20261016',
  'system',
  '系统',
  '【洗练贺礼】祭炼堂新增「洗练」，可重洗装备副属性，祭炼加成始终保留！福利发放时已建立的每个宗门均已获赠3000灵石、20玄铁，奖励已直接到账，无需领取，天机录可查看「洗练贺礼」。祝各位掌门洗出极品！',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
ON CONFLICT (id) DO NOTHING;
