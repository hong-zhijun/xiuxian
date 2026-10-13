-- Migration number: 0055   Name: arena_clear_today
--
-- 清空今天（2026-10-13）的大比结算结果 + 本赛季累计，用于赛制重做后重跑。

DELETE FROM arena_individual_matches WHERE date_key = '2026-10-13';
DELETE FROM arena_team_matches WHERE date_key = '2026-10-13';
DELETE FROM arena_individual_scores WHERE date_key = '2026-10-13';
DELETE FROM arena_team_scores WHERE date_key = '2026-10-13';
DELETE FROM arena_rewards WHERE date_key = '2026-10-13';

-- 赛季累计也清掉（本赛季 2026-W42）
DELETE FROM arena_season_individual WHERE season_id = '2026-W42';
DELETE FROM arena_season_team WHERE season_id = '2026-W42';
DELETE FROM arena_seasons WHERE id = '2026-W42';

