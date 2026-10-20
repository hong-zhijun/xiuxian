-- Migration number: 0071   Name: spirit_beast_launch_gift
--
-- 灵兽上线贺礼：执行迁移时已存在的每个宗门获赠 5000 灵石、2000 灵气，并发一条全服系统公告。
-- 展示单位 ×1000 = 数据库最小单位：5000 灵石 = 5000000，2000 灵气 = 2000000。
-- 沿用运营福利口径（0045 / 0062）：直接加余额、不夹仓库容量，每宗门在天机录留一条记录。
-- d1_migrations 保证整份迁移只执行一次，之后新建的宗门不发；公告用固定 id，重试不会重复。

-- 理论上每个宗门都有这两行余额（建宗按配置带上）；缺行的先补 0，保证人人到账。
INSERT INTO resource_balances (id, sect_id, resource_id, balance, remainder, updated_at)
SELECT lower(hex(randomblob(16))), sects.id, r.resource_id, 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects
CROSS JOIN (SELECT 'spiritStone' AS resource_id UNION ALL SELECT 'spiritualEnergy') AS r
WHERE NOT EXISTS (
  SELECT 1 FROM resource_balances rb WHERE rb.sect_id = sects.id AND rb.resource_id = r.resource_id
);

UPDATE resource_balances
SET balance = balance + 5000000
WHERE resource_id = 'spiritStone';

UPDATE resource_balances
SET balance = balance + 2000000
WHERE resource_id = 'spiritualEnergy';

INSERT INTO event_log (id, sect_id, event_id, description, effects, created_at)
SELECT lower(hex(randomblob(16))), id, 'spiritBeastLaunchGift',
       '庆贺灵兽玩法上线，宗门获赠灵石 5000、灵气 2000。',
       '{"spiritStone":"5000000","spiritualEnergy":"2000000"}',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects;

INSERT INTO chat_messages (id, user_id, sect_name, content, created_at)
VALUES (
  'announcement-spirit-beast-launch-20261020',
  'system',
  '系统',
  '【灵兽上线贺礼】秘境探索新增「宠物秘境」，宗门 3 级即可派弟子野外捕捉十二种灵兽，携带灵兽可在捕捉、镇妖塔与大比中发挥五行与技能！福利发放时已建立的每个宗门均已获赠 5000 灵石、2000 灵气，奖励已直接到账，无需领取，天机录可查看「灵兽上线贺礼」。祝各位掌门觅得神兽！',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
ON CONFLICT (id) DO NOTHING;
