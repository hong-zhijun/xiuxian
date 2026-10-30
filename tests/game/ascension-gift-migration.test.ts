import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';

import { applyMigrations } from '../../apps/server/node/migrate';
import { eventNameOf } from '../../apps/server/src/modules/game/events';

const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
const giftMigration = '0076_ascension_gift.sql';

it('飞升贺礼：全服已有宗门各获 10 万灵气，缺行补齐，保留余额与余数，迁移重试和重复部署均不重发', () => {
  const db = new DatabaseSync(':memory:');
  const migrationDir = mkdtempSync(join(tmpdir(), 'ascension-energy-gift-'));
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql') && name <= giftMigration)) {
    copyFileSync(join(migrationsDir, file), join(migrationDir, file));
  }
  try {
    db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
    for (const file of readdirSync(migrationDir).filter((name) => name.endsWith('.sql') && name < giftMigration).sort()) {
      db.exec(readFileSync(join(migrationDir, file), 'utf8'));
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(file);
    }
    const createSect = (id: string) => {
      db.prepare('INSERT INTO users (id, normalized_account, password_hash, created_at, updated_at) VALUES (?, ?, ?, 0, 0)').run(id, id, 'test-hash');
      db.prepare('INSERT INTO sects (id, user_id, name, last_settled_at, created_at) VALUES (?, ?, ?, 0, 0)').run(id, id, id);
    };
    createSect('existing');
    createSect('missing');
    db.exec("INSERT INTO resource_balances VALUES ('energy', 'existing', 'spiritualEnergy', 123456789, 123, 0)");
    db.exec("INSERT INTO resource_balances VALUES ('stone', 'existing', 'spiritStone', 543210, 45, 0)");
    const energyOf = (sectId: string) => db.prepare("SELECT balance, remainder FROM resource_balances WHERE sect_id = ? AND resource_id = 'spiritualEnergy'").get(sectId);

    expect(applyMigrations(db, migrationDir)).toContain(giftMigration);
    expect(energyOf('existing')).toMatchObject({ balance: 223456789, remainder: 123 });
    expect(energyOf('missing')).toMatchObject({ balance: 100000000, remainder: 0 });
    expect(db.prepare("SELECT balance, remainder FROM resource_balances WHERE id = 'stone'").get()).toMatchObject({ balance: 543210, remainder: 45 });
    const gifts = db.prepare("SELECT sect_id, description, effects FROM event_log WHERE event_id = 'ascensionGift' ORDER BY sect_id").all();
    expect(gifts.map((row) => row.sect_id)).toEqual(['existing', 'missing']);
    for (const gift of gifts) {
      expect(gift.description).toContain('飞升贺礼');
      expect(gift.description).toContain('100000（10 万）灵气');
      expect(JSON.parse(String(gift.effects))).toEqual({ spiritualEnergy: '100000000' });
    }
    expect(eventNameOf('ascensionGift')).toBe('飞升贺礼');
    expect(db.prepare("SELECT user_id, sect_name, content FROM chat_messages WHERE id = 'announcement-ascension-gift-20261030'").get()).toMatchObject({
      user_id: 'system', sect_name: '系统', content: expect.stringContaining('【飞升贺礼】'),
    });

    db.exec(readFileSync(join(migrationDir, giftMigration), 'utf8'));
    expect(energyOf('existing')?.balance).toBe(223456789);
    expect(energyOf('missing')?.balance).toBe(100000000);
    createSect('new');
    expect(applyMigrations(db, migrationDir)).toEqual([]);
    expect(energyOf('new')).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE event_id = 'ascensionGift'").get()?.n).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE id = 'announcement-ascension-gift-20261030'").get()?.n).toBe(1);
  } finally {
    db.close();
    rmSync(migrationDir, { recursive: true, force: true });
  }
});
