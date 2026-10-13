-- Migration number: 0052 	 Name: world_withdraw_cooldown
--
-- 山河舆图 · 撤回冷却（docs/山河舆图开发计划.md 1.4）：
--   堵「强队夺地 → 撤回山门 → 弱队再开辟」绕开攻守绑定的漏洞：撤回后 24 小时内，撤回的宗门不能再开辟 / 斗法这一处。
--   world_sites.withdrawn_sect_id <- 最近一次撤回山门的宗门；NULL = 没有
--   world_sites.withdrawn_until   <- 该宗门对这一处的冷却截止（毫秒）；易主 / 结算都不清，过期自然失效

ALTER TABLE world_sites ADD COLUMN withdrawn_sect_id TEXT;
ALTER TABLE world_sites ADD COLUMN withdrawn_until INTEGER;
