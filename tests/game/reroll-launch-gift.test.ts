import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';

import { applyMigrations } from '../../apps/server/node/migrate';
import { eventNameOf } from '../../apps/server/src/modules/game/events';

const sourceDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
const giftMigration = '0062_reroll_launch_gift.sql';

// 只放到本次福利的最后一份迁移为止：之后再加的福利迁移不会叠到这里的余额断言上。
const migrationDir = mkdtempSync(join(tmpdir(), 'gift-migrations-'));
for (const file of readdirSync(sourceDir).filter((name) => name.endsWith('.sql') && name <= '0062_reroll_launch_gift.sql')) {
  copyFileSync(join(sourceDir, file), join(migrationDir, file));
}

it('洗练贺礼给所有已有宗门各加 3000 灵石、20 玄铁，缺行补齐，重复部署不重发，新宗门不补发', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // 构造上线前的真实数据库结构与迁移记录，随后用生产迁移入口执行福利。
    db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
    for (const file of readdirSync(migrationDir).filter((name) => name.endsWith('.sql') && name < giftMigration).sort()) {
      db.exec(readFileSync(join(migrationDir, file), 'utf8'));
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(file);
    }

    const createSect = (id: string, stone: number, xuantie: number | null) => {
      db.prepare('INSERT INTO users (id, normalized_account, password_hash, created_at, updated_at) VALUES (?, ?, ?, 0, 0)')
        .run(id, id, 'test-hash');
      db.prepare('INSERT INTO sects (id, user_id, name, last_settled_at, created_at) VALUES (?, ?, ?, 0, 0)')
        .run(id, id, id);
      db.prepare('INSERT INTO resource_balances (id, sect_id, resource_id, balance, remainder, updated_at) VALUES (?, ?, ?, ?, 123, 0)')
        .run(`${id}-stone`, id, 'spiritStone', stone);
      if (xuantie !== null) {
        db.prepare('INSERT INTO resource_balances (id, sect_id, resource_id, balance, updated_at) VALUES (?, ?, ?, ?, 0)')
          .run(`${id}-xuantie`, id, 'xuantie', xuantie);
      }
      db.prepare('INSERT INTO resource_balances (id, sect_id, resource_id, balance, updated_at) VALUES (?, ?, ?, 500, 0)')
        .run(`${id}-ore`, id, 'ore');
    };
    const balanceOf = (id: string, resourceId: string) =>
      db.prepare('SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = ?').get(id, resourceId)?.balance;
    createSect('small', 100_000, 1_000);
    createSect('full', 5_000_000, 900_000);
    // 理论上不会出现的缺行：迁移先补 0 行，照样到账。
    createSect('noXuantie', 0, null);

    expect(applyMigrations(db, migrationDir)).toContain(giftMigration);
    expect(balanceOf('small', 'spiritStone')).toBe(3_100_000);
    expect(balanceOf('full', 'spiritStone')).toBe(8_000_000);
    expect(balanceOf('noXuantie', 'spiritStone')).toBe(3_000_000);
    expect(balanceOf('small', 'xuantie')).toBe(21_000);
    expect(balanceOf('full', 'xuantie')).toBe(920_000);
    expect(balanceOf('noXuantie', 'xuantie')).toBe(20_000);
    expect(db.prepare("SELECT balance FROM resource_balances WHERE resource_id = 'ore'").all().map((row) => row.balance))
      .toEqual([500, 500, 500]);
    expect(db.prepare("SELECT COUNT(*) AS total FROM resource_balances WHERE resource_id = 'xuantie'").get()?.total).toBe(3);

    const gifts = db.prepare("SELECT sect_id, description, effects FROM event_log WHERE event_id = 'rerollLaunchGift' ORDER BY sect_id").all();
    expect(gifts.map((row) => row.sect_id)).toEqual(['full', 'noXuantie', 'small']);
    for (const gift of gifts) {
      expect(JSON.parse(String(gift.effects))).toEqual({ spiritStone: '3000000', xuantie: '20000' });
      expect(gift.description).toContain('灵石 3000');
      expect(gift.description).toContain('玄铁 20');
    }
    expect(eventNameOf('rerollLaunchGift')).toBe('洗练贺礼');
    const announcement = db.prepare("SELECT user_id, sect_name, content FROM chat_messages WHERE id = 'announcement-reroll-launch-20261016'").get();
    expect(announcement).toMatchObject({ user_id: 'system', sect_name: '系统' });
    expect(announcement?.content).toContain('3000灵石、20玄铁');

    createSect('new', 100_000, 0);
    expect(applyMigrations(db, migrationDir)).toEqual([]);
    expect(balanceOf('small', 'spiritStone')).toBe(3_100_000);
    expect(balanceOf('small', 'xuantie')).toBe(21_000);
    expect(balanceOf('new', 'spiritStone')).toBe(100_000);
    expect(balanceOf('new', 'xuantie')).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS total FROM event_log WHERE event_id = 'rerollLaunchGift'").get()?.total).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS total FROM chat_messages WHERE id = 'announcement-reroll-launch-20261016'").get()?.total).toBe(1);
  } finally {
    db.close();
    rmSync(migrationDir, { recursive: true, force: true });
  }
});
