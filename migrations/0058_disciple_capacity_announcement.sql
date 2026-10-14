-- Migration number: 0058   Name: disciple_capacity_announcement
-- 弟子扩容和 0057 福利发放后的全服系统公告。
-- 使用固定消息 id，迁移或 SQL 重试都不会重复公告。

INSERT INTO chat_messages (id, user_id, sect_name, content, created_at)
VALUES (
  'announcement-disciple-capacity-20261014',
  'system',
  '系统',
  '【扩容贺礼】宗门5～15级弟子上限已提升，满级可收64人！福利发放时已建立的每个宗门均已获赠2000灵石，可用于招贤刷新（付费刷新每次100灵石）。奖励已直接到账，无需领取，天机录可查看「扩容贺礼」。祝各位掌门广纳贤才！',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
ON CONFLICT (id) DO NOTHING;
