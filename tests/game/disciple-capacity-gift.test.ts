import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';

import { applyMigrations } from '../../apps/server/node/migrate';
import { eventNameOf } from '../../apps/server/src/modules/game/events';

const migrationDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
const giftMigration = '0057_disciple_capacity_gift.sql';

it('扩容贺礼给所有已有宗门各加 2000 灵石，保留超容量余额，重复部署不重发，新宗门不补发', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // 构造上线前的真实数据库结构与迁移记录，随后用生产迁移入口执行福利。
    db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
    for (const file of readdirSync(migrationDir).filter((name) => name.endsWith('.sql') && name < giftMigration).sort()) {
      db.exec(readFileSync(join(migrationDir, file), 'utf8'));
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(file);
    }

    const createSect = (id: string, stone: number) => {
      db.prepare('INSERT INTO users (id, normalized_account, password_hash, created_at, updated_at) VALUES (?, ?, ?, 0, 0)')
        .run(id, id, 'test-hash');
      db.prepare('INSERT INTO sects (id, user_id, name, last_settled_at, created_at) VALUES (?, ?, ?, 0, 0)')
        .run(id, id, id);
      db.prepare('INSERT INTO resource_balances (id, sect_id, resource_id, balance, remainder, updated_at) VALUES (?, ?, ?, ?, 123, 0)')
        .run(`${id}-stone`, id, 'spiritStone', stone);
      db.prepare('INSERT INTO resource_balances (id, sect_id, resource_id, balance, updated_at) VALUES (?, ?, ?, 500, 0)')
        .run(`${id}-ore`, id, 'ore');
    };
    const stoneOf = (id: string) => db.prepare("SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = 'spiritStone'")
      .get(id)?.balance;
    createSect('small', 100_000);
    createSect('full', 5_000_000);

    expect(applyMigrations(db, migrationDir)).toEqual([giftMigration]);
    expect(stoneOf('small')).toBe(2_100_000);
    expect(stoneOf('full')).toBe(7_000_000);
    expect(db.prepare("SELECT balance FROM resource_balances WHERE resource_id = 'ore'").all().map((row) => row.balance))
      .toEqual([500, 500]);
    expect(db.prepare("SELECT remainder FROM resource_balances WHERE resource_id = 'spiritStone'").all().map((row) => row.remainder))
      .toEqual([123, 123]);
    const gifts = db.prepare("SELECT sect_id, description, effects FROM event_log WHERE event_id = 'discipleCapacityGift' ORDER BY sect_id").all();
    expect(gifts.map((row) => row.sect_id)).toEqual(['full', 'small']);
    for (const gift of gifts) {
      expect(JSON.parse(String(gift.effects))).toEqual({ spiritStone: '2000000' });
      expect(gift.description).toContain('2000 灵石');
    }
    expect(eventNameOf('discipleCapacityGift')).toBe('扩容贺礼');

    createSect('new', 100_000);
    expect(applyMigrations(db, migrationDir)).toEqual([]);
    expect(stoneOf('small')).toBe(2_100_000);
    expect(stoneOf('full')).toBe(7_000_000);
    expect(stoneOf('new')).toBe(100_000);
    expect(db.prepare("SELECT COUNT(*) AS total FROM event_log WHERE event_id = 'discipleCapacityGift'").get()?.total).toBe(2);
  } finally {
    db.close();
  }
});
