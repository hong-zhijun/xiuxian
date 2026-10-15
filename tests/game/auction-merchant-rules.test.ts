import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from '../../apps/server/node/migrate';
import { auctionMinPrice, parseEquipmentSnapshot } from '../../apps/server/src/modules/game/auction';
import { generateMerchantGoods } from '../../apps/server/src/modules/game/auctionMerchant';

describe('游商商品与上线迁移', () => {
  it('多批货覆盖所有品质与部位，材料都有玄铁和神木，价格为整灵石且符合交易底价', () => {
    let seed = 59;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const qualities = new Set<string>();
    const slots = new Set<string>();
    for (let visit = 0; visit < 100; visit += 1) {
      const goods = generateMerchantGoods(random);
      expect(goods.length).toBeGreaterThanOrEqual(8);
      expect(goods.length).toBeLessThanOrEqual(12);
      expect(goods.some((item) => item.itemId === 'xuantie')).toBe(true);
      expect(goods.some((item) => item.itemId === 'shenmu')).toBe(true);
      for (const item of goods) {
        expect(item.startPrice % 1000).toBe(0);
        expect(item.buyoutPrice % 1000).toBe(0);
        expect(item.startPrice).toBeGreaterThanOrEqual(auctionMinPrice(item.kind, item.itemId, item.quantity));
        expect(item.buyoutPrice).toBeGreaterThan(item.startPrice);
        if (item.kind === 'equipment') {
          const equipment = parseEquipmentSnapshot(item.equipmentJson)!;
          expect(equipment.source).toBe('merchant');
          expect(equipment.refineLevel).toBe(0);
          expect(equipment.quality).toBe(item.itemId);
          qualities.add(equipment.quality);
          slots.add(equipment.slot);
        } else {
          expect(['xuantie', 'shenmu']).toContain(item.itemId);
          expect(item.quantity).toBeGreaterThanOrEqual(5);
          expect(item.quantity).toBeLessThanOrEqual(20);
        }
      }
    }
    expect([...qualities].sort()).toEqual(['common', 'immortal', 'spirit', 'treasure']);
    expect([...slots].sort()).toEqual(['armor', 'artifact', 'weapon']);
  });

  it('生产迁移完整保留旧拍卖单、出价、网络哈希和外键，允许系统卖家而不创建假账号', () => {
    const dir = fileURLToPath(new URL('../../migrations/', import.meta.url));
    const migration = '0059_auction_merchant.sql';
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
      for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql') && name < migration).sort()) {
        db.exec(readFileSync(join(dir, file), 'utf8'));
        db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(file);
      }
      db.exec(`INSERT INTO users (id, normalized_account, password_hash, created_at, updated_at) VALUES ('seller', 'seller', 'hash', 0, 0);
        INSERT INTO sects (id, user_id, name, last_settled_at, created_at) VALUES ('seller', 'seller', '卖方宗门', 0, 0);
        INSERT INTO auction_lots (id, seller_sect_id, seller_name, kind, item_id, item_name, quantity, start_price, buyout_price,
          current_price, bidder_sect_id, bidder_name, bid_count, status, ends_at, version, created_at, seller_net_hash)
        VALUES ('old-lot', 'seller', '卖方宗门', 'resource', 'xuantie', '玄铁', 10, 500000, 1000000, 600000,
          'buyer', '买方宗门', 1, 'active', 2000, 3, 1000, 'network-hash');
        INSERT INTO auction_bids (id, lot_id, sect_id, price, created_at) VALUES ('old-bid', 'old-lot', 'buyer', 600000, 1500);`);
      const lotBefore = db.prepare('SELECT * FROM auction_lots').get();
      const bidBefore = db.prepare('SELECT * FROM auction_bids').get();
      expect(applyMigrations(db, dir)).toContain(migration);
      expect(db.prepare("SELECT * FROM auction_lots WHERE id = 'old-lot'").get()).toEqual({ ...lotBefore, merchant_visit_id: null });
      expect(db.prepare('SELECT * FROM auction_bids').get()).toEqual(bidBefore);
      db.exec(`INSERT INTO auction_lots (id, seller_sect_id, seller_name, kind, item_id, item_name, quantity, start_price, ends_at, created_at, merchant_visit_id)
        VALUES ('merchant-lot', NULL, '云游商人', 'resource', 'shenmu', '神木', 5, 125000, 3000, 1000, 'visit');`);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM users').get()?.count).toBe(1);
      expect(applyMigrations(db, dir)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it.each(['首次等待', '旧计划尚未到期', '旧计划已经迟到'])('频率迁移提前%s，保留已有批次并且不推迟到期任务', (scenario) => {
    const dir = fileURLToPath(new URL('../../migrations/', import.meta.url));
    const db = new DatabaseSync(':memory:');
    const hour = 3_600_000;
    const now = Date.now();
    try {
      applyMigrations(db, dir);
      db.prepare('DELETE FROM d1_migrations WHERE name = ?').run('0060_auction_merchant_frequency.sql');
      const arrivedAt = scenario === '首次等待' ? null : now - (scenario === '旧计划已经迟到' ? 15 : 1) * hour;
      const originalNext = scenario === '旧计划已经迟到' ? now - 3 * hour : now + 6 * hour;
      const leavesAt = arrivedAt === null ? null : arrivedAt + 6 * hour;
      db.prepare('UPDATE auction_merchant_state SET next_arrival_at = ?, arrived_at = ?, leaves_at = ?, visit_id = ?, version = 7 WHERE id = 1')
        .run(originalNext, arrivedAt, leavesAt, 'existing-visit');
      applyMigrations(db, dir);
      const state = db.prepare('SELECT * FROM auction_merchant_state').get()!;
      expect(state).toMatchObject({ arrived_at: arrivedAt, leaves_at: leavesAt, visit_id: 'existing-visit', version: 8 });
      expect(Number(state.next_arrival_at)).toBeLessThanOrEqual(originalNext);
      if (scenario === '旧计划已经迟到') {
        expect(Number(state.next_arrival_at)).toBeLessThanOrEqual(now);
      } else {
        const base = arrivedAt ?? now;
        expect(Number(state.next_arrival_at)).toBeGreaterThanOrEqual(base + 2 * hour - 1000);
        expect(Number(state.next_arrival_at)).toBeLessThanOrEqual(base + 4 * hour);
      }
      expect(applyMigrations(db, dir)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
