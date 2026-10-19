-- Migration number: 0061 	 Name: journey_recall
--
-- 历练紧急召回：在外（未到期）的弟子可以立刻召回，本趟收获全部作废、也不会受伤，免费。
--   disciple_journeys.recalled_at <- 召回时刻；NULL = 正常归队（旧记录都是 NULL，不需要回填）。
--
-- 召回时同一条 UPDATE 把记录直接收口：ends_at / completed_at / claimed_at 都写成召回时刻，
-- 奖励快照清零（reward_cultivation = 0、reward_resources = '{}'、额外收获 / 受伤 / 额外奖励全清），
-- 所以「在外」「待领取」的判定不用改，召回的记录不会再发任何奖励。

ALTER TABLE disciple_journeys ADD COLUMN recalled_at INTEGER;
