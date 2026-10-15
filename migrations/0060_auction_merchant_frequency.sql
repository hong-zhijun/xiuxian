-- Migration number: 0060   Name: auction_merchant_frequency
-- 补货间隔改为从到访时刻起随机 2～4 小时，不再叠加商品的 6 小时停留。
-- 提前旧计划，不推迟已经到期的批次；正在竞拍的旧商品不变。
UPDATE auction_merchant_state
SET next_arrival_at = MIN(
      next_arrival_at,
      COALESCE(arrived_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
        + (120 + abs(random() % 121)) * 60000
    ),
    version = version + 1
WHERE id = 1;

INSERT INTO chat_messages (id, user_id, sect_name, content, created_at)
VALUES ('announcement-auction-merchant-frequency-20261015', 'system', '系统',
        '【游商加快到访】云游商人改为每隔2～4小时随机带来一批新货，不再等待上一批离开！每批商品仍保留6小时，已有竞拍不受影响。装备、玄铁和神木照常供应，到访时另发公告。',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000)
ON CONFLICT (id) DO NOTHING;
