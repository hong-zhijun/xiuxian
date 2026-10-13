-- Migration number: 0056   Name: arena_clear_all
--
-- 清空所有宗门大比记录，重新跑一次。

DELETE FROM arena_individual_matches;
DELETE FROM arena_team_matches;
DELETE FROM arena_individual_scores;
DELETE FROM arena_team_scores;
DELETE FROM arena_rewards;
DELETE FROM arena_season_individual;
DELETE FROM arena_season_team;
DELETE FROM arena_seasons;
DELETE FROM arena_entries;
