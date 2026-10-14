-- Migration number: 0059   Name: auction_merchant
-- 游商独立于玩家宗门，保留现有拍卖单和出价。先复制父子表，再按子→父顺序替换。
CREATE TABLE auction_merchant_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0,
  next_arrival_at INTEGER NOT NULL,
  visit_id TEXT,
  arrived_at INTEGER,
  leaves_at INTEGER
);
-- 首次随机等待 2～6 小时，不随部署立即上货。
INSERT INTO auction_merchant_state (id, next_arrival_at)
VALUES (1, CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 7200000 + abs(random() % 241) * 60000);

CREATE TABLE auction_lots_new (
  id TEXT PRIMARY KEY,
  seller_sect_id TEXT REFERENCES sects (id),
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
  created_at INTEGER NOT NULL,
  seller_net_hash TEXT,
  merchant_visit_id TEXT,
  CHECK ((seller_sect_id IS NOT NULL AND merchant_visit_id IS NULL) OR
         (seller_sect_id IS NULL AND merchant_visit_id IS NOT NULL))
);

CREATE TABLE auction_bids_new (
  id TEXT PRIMARY KEY,
  lot_id TEXT NOT NULL REFERENCES auction_lots_new (id),
  sect_id TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price > 0),
  created_at INTEGER NOT NULL
);

INSERT INTO auction_lots_new
SELECT id, seller_sect_id, seller_name, kind, item_id, item_name, quantity, equipment_json,
       start_price, buyout_price, current_price, bidder_sect_id, bidder_name, bid_count,
       status, ends_at, ended_at, fee, buyer_claimed_at, seller_claimed_at, version,
       created_at, seller_net_hash, NULL
FROM auction_lots;
INSERT INTO auction_bids_new SELECT * FROM auction_bids;
DROP TABLE auction_bids;
DROP TABLE auction_lots;
ALTER TABLE auction_lots_new RENAME TO auction_lots;
ALTER TABLE auction_bids_new RENAME TO auction_bids;
CREATE INDEX idx_auction_lots_status_ends ON auction_lots (status, ends_at);
CREATE INDEX idx_auction_lots_seller ON auction_lots (seller_sect_id, created_at);
CREATE INDEX idx_auction_lots_bidder ON auction_lots (bidder_sect_id, status);
CREATE INDEX idx_auction_bids_sect ON auction_bids (sect_id, created_at);
CREATE INDEX idx_auction_lots_merchant ON auction_lots (merchant_visit_id, status, ends_at);

INSERT INTO chat_messages (id, user_id, sect_name, content, created_at)
VALUES ('announcement-auction-merchant-20261014', 'system', '系统',
        '【拍卖行新玩法】云游商人将随机到访，每次带来8～12单装备、玄铁和神木，凡品至仙品装备均可能出现！支持竞拍与一口价，停留6小时，离开后随机间隔2～6小时再来。首次到访也随机等待，到访时另发全服公告。',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000)
ON CONFLICT (id) DO NOTHING;
