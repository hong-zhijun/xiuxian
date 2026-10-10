-- Migration number: 0047 	 Name: stone_gamble_log_merge
--
-- 赌石记录并入赌坊记录（docs/赌石开发计划.md 1.7）：
--   dao_debate_log   <- 搬入 0046 stone_gamble_log 的已有行（bet_mode = 'stone'，与天机轮 / 灵兽竞逐同一张表）
--   stone_gamble_log <- 删除（以后赌石直接写 dao_debate_log，赌坊记录面板与战绩统计一起覆盖）
--
-- 搬运口径与 service.ts 的 stoneGamble 写入一致：
--   disciple_id = ''、disciple_name = '赌石'、multiplier = 块数、win_probability = NULL；
--   开出玄铁算 win、全垮算 lose；
--   stake_detail  = {"resourceId","amount"(字符串，最小单位),"tier","tierName","count"}
--   reward_detail = {"type":"resource","resourceId":"xuantie","amount"(字符串),"counts":{...}}
-- stone_gamble_busts（隐藏保底）不动。

INSERT INTO dao_debate_log (
  id, sect_id, disciple_id, disciple_name, bet_mode, multiplier,
  stake_detail, result, reward_detail, win_probability, created_at
)
SELECT
  id,
  sect_id,
  '',
  '赌石',
  'stone',
  count,
  json_object(
    'resourceId', pay_resource,
    'amount', CAST(cost AS TEXT),
    'tier', tier,
    'tierName', CASE tier
      WHEN 'gravel' THEN '碎石'
      WHEN 'mountain' THEN '山料'
      WHEN 'oldPit' THEN '老坑料'
      WHEN 'meteor' THEN '天外陨石'
      ELSE tier
    END,
    'count', count
  ),
  CASE WHEN xuantie > 0 THEN 'win' ELSE 'lose' END,
  json_object(
    'type', 'resource',
    'resourceId', 'xuantie',
    'amount', CAST(xuantie AS TEXT),
    'counts', json_object('bust', bust_count, 'small', small_count, 'big', big_count, 'jackpot', jackpot_count)
  ),
  NULL,
  created_at
FROM stone_gamble_log;

DROP TABLE stone_gamble_log;
