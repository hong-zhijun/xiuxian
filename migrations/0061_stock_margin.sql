-- Migration number: 0061  Name: stock_margin
--
-- 灵股保证金合约：逐仓、一向持仓、固定 5 倍杠杆。
-- 与 0043 现货持仓 / 0049 现货挂单分表，避免改变既有现货语义。

CREATE TABLE stock_margin_positions (
  sect_id TEXT NOT NULL,
  stock_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  shares INTEGER NOT NULL CHECK (shares > 0),
  entry_price INTEGER NOT NULL CHECK (entry_price > 0),
  margin INTEGER NOT NULL CHECK (margin > 0),
  leverage INTEGER NOT NULL CHECK (leverage >= 1),
  liquidation_price INTEGER NOT NULL CHECK (liquidation_price > 0),
  opened_at INTEGER NOT NULL,
  -- 已扫描到的行情分钟（含），用于定时任务逐分钟捕捉穿线强平。
  checked_minute INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (sect_id, stock_id)
);

CREATE TABLE stock_margin_trades (
  id TEXT PRIMARY KEY,
  sect_id TEXT NOT NULL,
  stock_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('open', 'close', 'liquidate')),
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  shares INTEGER NOT NULL CHECK (shares > 0),
  price INTEGER NOT NULL CHECK (price > 0),
  notional INTEGER NOT NULL CHECK (notional > 0),
  fee INTEGER NOT NULL CHECK (fee >= 0),
  margin INTEGER NOT NULL CHECK (margin >= 0),
  pnl INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_stock_margin_trades_sect ON stock_margin_trades (sect_id, created_at);
CREATE INDEX idx_stock_margin_trades_action ON stock_margin_trades (action, created_at);
CREATE INDEX idx_stock_margin_positions_scan ON stock_margin_positions (stock_id, side);
