-- Migration number: 0049 	 Name: stock_orders
--
-- 灵股挂单（docs/灵股挂单开发计划.md）：设好触发价和股数，价格到了自动成交。
--   stock_orders（新表）<- 每张挂单一行：限价买 / 限价卖 / 止损卖；未完成（open）或已结束（成交 / 撤单 / 过期 / 因规则取消）。
--   限价买：下单时冻结 reserved（触发价 × 股数 + 手续费），成交时多出的部分退回，结束时未用的全额退回。
--   限价卖 / 止损卖：下单时锁定股数（不从持仓扣），可用股数 = 持有股数 − 未完成卖单之和。
--   checked_minute：已经检查到哪一分钟（含）；每次只扫新的分钟，不做 72 小时全扫。
--
-- - 有效期 72 小时（expires_at）；version 每次写入 +1，成交 / 撤单 / 过期 / 推进检查进度都靠它挡住并发。
-- - 宗门不会被删除：sect_id 不建 CASCADE（同 0042 / 0044 / 0048）。

CREATE TABLE stock_orders (
  id TEXT PRIMARY KEY,
  sect_id TEXT NOT NULL,
  stock_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('limit_buy', 'limit_sell', 'stop_sell')),
  shares INTEGER NOT NULL CHECK (shares > 0),
  trigger_price INTEGER NOT NULL CHECK (trigger_price > 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'cancelled', 'expired')),
  -- 已经检查到哪一分钟（含）：每次只扫新的分钟，避免 72 小时 × 每次全扫
  checked_minute INTEGER NOT NULL,
  fill_price INTEGER,
  filled_at INTEGER,
  -- 结束原因：'filled' / 'user' / 'expired' / 'position_cap' / 'no_shares'；未结束为 NULL
  close_reason TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_stock_orders_sect ON stock_orders (sect_id, status);
CREATE INDEX idx_stock_orders_check ON stock_orders (status, checked_minute);
