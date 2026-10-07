-- Migration number: 0043 	 Name: stock_market
--
-- 灵股行情（docs/灵股行情开发计划.md）：系统坐庄，价格由「种子 + 时间」算出，不存行情。
--   market_state（新表）<- 种子（首次使用时随机生成，只存在库里；代码里没有，开源仓库推算不出未来价格）。
--   stock_holdings（新表）<- 每宗门每支股票一行：股数、持仓成本（最小单位，不含手续费）、最近一次买入时间
--                            （买入后 10 分钟内不能卖）、version（并发守卫）。股数为 0 的行保留。
--   stock_trades（新表）<- 成交流水：数「今日笔数」、算收益榜（profit = 卖出实得 − 对应持仓成本）、我的成交。
--
-- - 股票定义（名字、基准价、波动）在 market.ts，stock_id 不建 CHECK，以后加股票不必重建表。

CREATE TABLE market_state (
  id TEXT PRIMARY KEY,
  seed TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE stock_holdings (
  sect_id TEXT NOT NULL REFERENCES sects (id),
  stock_id TEXT NOT NULL,
  shares INTEGER NOT NULL DEFAULT 0 CHECK (shares >= 0),
  cost INTEGER NOT NULL DEFAULT 0 CHECK (cost >= 0),
  last_buy_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (sect_id, stock_id)
);

CREATE TABLE stock_trades (
  id TEXT PRIMARY KEY,
  sect_id TEXT NOT NULL,
  stock_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  shares INTEGER NOT NULL CHECK (shares > 0),
  price INTEGER NOT NULL CHECK (price > 0),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  fee INTEGER NOT NULL CHECK (fee >= 0),
  profit INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_stock_trades_sect ON stock_trades (sect_id, created_at);
