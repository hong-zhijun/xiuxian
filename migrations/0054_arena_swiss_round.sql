-- Migration number: 0054   Name: arena_swiss_round
--
-- 宗门大比改为瑞士轮 + 加权得分：对战记录新增 round 列（第几轮）。

ALTER TABLE arena_individual_matches ADD COLUMN round INTEGER NOT NULL DEFAULT 1;
ALTER TABLE arena_team_matches ADD COLUMN round INTEGER NOT NULL DEFAULT 1;
