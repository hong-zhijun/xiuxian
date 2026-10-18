-- Migration number: 0067   Name: technique_launch_gift
--
-- 功法上线贺礼：迁移执行时已经建立的每个宗门获赠青锋剑诀、金刚不坏体、鬼影步、破军诀（四门玄阶）各 10 张残卷，
-- 正好够全部收录，直接入账。使用 upsert 累加；D1 迁移记录保证只发放一次，之后新建的宗门不重复领取。

INSERT INTO sect_techniques (sect_id, technique_id, level, scrolls)
SELECT sects.id, gift.technique_id, 0, 10
FROM sects
CROSS JOIN (
  SELECT 'qingfeng' AS technique_id
  UNION ALL SELECT 'jingang'
  UNION ALL SELECT 'guiying'
  UNION ALL SELECT 'pojun'
) AS gift
WHERE true
ON CONFLICT (sect_id, technique_id) DO UPDATE SET
  scrolls = sect_techniques.scrolls + 10;

INSERT INTO event_log (id, sect_id, event_id, description, effects, created_at)
SELECT lower(hex(randomblob(16))), id, 'techniqueLaunchGift',
       '庆祝功法上线，宗门获赠青锋剑诀、金刚不坏体、鬼影步、破军诀残卷各 10 张。',
       '{}',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects;

INSERT INTO chat_messages (id, user_id, sect_name, content, created_at)
VALUES (
  'announcement-technique-launch-20261019',
  'system',
  '系统',
  '【功法上线贺礼】藏经阁新增功法，收录与参悟后可在镇妖塔、世界 Boss 中生效。福利发放时已建立的每个宗门获赠青锋剑诀、金刚不坏体、鬼影步、破军诀残卷各 10 张，已直接入账，无需领取。祝各位掌门修成绝学！',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
ON CONFLICT (id) DO NOTHING;
