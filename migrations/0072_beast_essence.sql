-- 御兽精魄按资源最小单位保存（1个 = 1000）；不补发历史放生收益。
INSERT INTO resource_balances (id, sect_id, resource_id, balance, remainder, updated_at)
SELECT lower(hex(randomblob(16))), id, 'beastEssence', 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sects
WHERE NOT EXISTS (SELECT 1 FROM resource_balances rb WHERE rb.sect_id = sects.id AND rb.resource_id = 'beastEssence');

ALTER TABLE beast_commands ADD COLUMN receipt_json TEXT;
