-- Migration number: 0040 	 Name: auction
--
-- 拍卖行（docs/拍卖行开发计划.md）：
--   auction_lots（新表）<- 一行一单。上架即托管：物品从卖家扣走、存在这一行里；
--     kind            <- 'equipment' | 'pill' | 'resource'
--     item_id         <- 装备品质 / 丹药 id / 资源 id（算最低价、交付用）
--     quantity        <- 装备恒为 1；丹药颗数；材料个数（展示单位）
--     equipment_json  <- 装备整份快照（原装备行在上架时删除，交付时按快照重新插一行）
--     start_price / buyout_price / current_price <- 最小单位灵石；current_price 为 NULL = 还没人出价
--     bidder_*        <- 当前领先者；出价时灵石已从他那里扣走，被超价时原路退回
--     status          <- 'active' 竞价中 / 'sold' 已成交 / 'expired' 流拍 / 'cancelled' 卖家撤回
--     buyer_claimed_at  <- 成交后买家领走物品的时间（一口价当场交付，同时写上）
--     seller_claimed_at <- 流拍后卖家领回物品的时间（撤回当场退回，同时写上）
--     fee             <- 成交时扣的手续费（卖家实得 = 成交价 − fee，成交那一刻直接入账）
--     version         <- 每次写入 +1；命令提交时守卫要求它仍是读到的值（并发出价只成功一个）
--   auction_bids（新表）<- 出价记录（「我参与的」列表用；不参与结算）。
--
-- - 卖家 / 买家的 sect_id 不建外键 CASCADE：宗门不会被删除，与 sect_stewards 同一做法。

CREATE TABLE auction_lots (
  id TEXT PRIMARY KEY,
  seller_sect_id TEXT NOT NULL REFERENCES sects (id),
  seller_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('equipment', 'pill', 'resource')),
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  equipment_json TEXT,
  start_price INTEGER NOT NULL CHECK (start_price > 0),
  buyout_price INTEGER CHECK (buyout_price IS NULL OR buyout_price >= start_price),
  current_price INTEGER,
  bidder_sect_id TEXT,
  bidder_name TEXT,
  bid_count INTEGER NOT NULL DEFAULT 0 CHECK (bid_count >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'expired', 'cancelled')),
  ends_at INTEGER NOT NULL,
  ended_at INTEGER,
  fee INTEGER NOT NULL DEFAULT 0 CHECK (fee >= 0),
  buyer_claimed_at INTEGER,
  seller_claimed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at INTEGER NOT NULL
);

-- 大厅（竞价中按结束时间）与定时结算（到期的 active）。
CREATE INDEX idx_auction_lots_status_ends ON auction_lots (status, ends_at);
-- 我上架的。
CREATE INDEX idx_auction_lots_seller ON auction_lots (seller_sect_id, created_at);
-- 我领先 / 我拍下待领取的。
CREATE INDEX idx_auction_lots_bidder ON auction_lots (bidder_sect_id, status);

CREATE TABLE auction_bids (
  id TEXT PRIMARY KEY,
  lot_id TEXT NOT NULL REFERENCES auction_lots (id),
  sect_id TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price > 0),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_auction_bids_sect ON auction_bids (sect_id, created_at);
