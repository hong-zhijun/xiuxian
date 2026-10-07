-- Migration number: 0041 	 Name: auction_network
--
-- 拍卖行：同一网络下的宗门不能互相交易（防小号低价转移装备）。
--   auction_lots.seller_net_hash <- 上架时卖家网络标识的哈希（IPv4 整个地址 / IPv6 前 64 位，见 auction.ts 的
--                                   auctionNetworkKey）；只存哈希不存明文。出价 / 一口价时买家的网络标识
--                                   与它相同就拒绝。NULL = 上架时拿不到来源（或本迁移之前上架的单），不做检查。

ALTER TABLE auction_lots ADD COLUMN seller_net_hash TEXT;
