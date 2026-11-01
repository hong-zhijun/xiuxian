import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

import { applyMigrations } from '../../apps/server/node/migrate';
import { eventNameOf } from '../../apps/server/src/modules/game/events';

const sourceDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
const migration = '0080_full_server_training_gift.sql';

it('全民修炼补给：每个已有宗门各得 2 万灵气和 2 万灵石，缺行补齐，重复迁移不重发', () => {
  const dir = mkdtempSync(join(tmpdir(), 'full-server-training-gift-'));
  for (const file of readdirSync(sourceDir).filter((name) => name.endsWith('.sql') && name <= migration)) {
    copyFileSync(join(sourceDir, file), join(dir, file));
  }
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql') && name < migration).sort()) {
      db.exec(readFileSync(join(dir, file), 'utf8'));
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(file);
    }
    const addSect = (id: string) => {
      db.prepare('INSERT INTO users (id, normalized_account, password_hash, created_at, updated_at) VALUES (?, ?, ?, 0, 0)').run(id, id, 'hash');
      db.prepare('INSERT INTO sects (id, user_id, name, last_settled_at, created_at) VALUES (?, ?, ?, 0, 0)').run(id, id, id);
    };
    addSect('alpha');
    addSect('beta');
    db.exec("INSERT INTO resource_balances VALUES ('energy', 'alpha', 'spiritualEnergy', 1234, 9, 0)");
    db.exec("INSERT INTO resource_balances VALUES ('stone', 'alpha', 'spiritStone', 5678, 11, 0)");

    expect(applyMigrations(db, dir)).toContain(migration);
    for (const resourceId of ['spiritualEnergy', 'spiritStone']) {
      expect(db.prepare('SELECT balance, remainder FROM resource_balances WHERE sect_id = ? AND resource_id = ?').get('alpha', resourceId)).toMatchObject({
        balance: resourceId === 'spiritualEnergy' ? 20_001_234 : 20_005_678,
        remainder: resourceId === 'spiritualEnergy' ? 9 : 11,
      });
      expect(db.prepare('SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = ?').get('beta', resourceId)?.balance).toBe(20_000_000);
    }
    expect(eventNameOf('fullServerTrainingGift')).toBe('全民修炼补给');
    expect(db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE event_id = 'fullServerTrainingGift'").get()?.n).toBe(2);
    expect(db.prepare("SELECT effects FROM event_log WHERE sect_id = 'alpha' AND event_id = 'fullServerTrainingGift'").get()?.effects).toBe(
      '{"spiritualEnergy":"20000000","spiritStone":"20000000"}',
    );
    expect(db.prepare("SELECT content FROM chat_messages WHERE id = 'announcement-full-server-training-gift-20261101'").get()?.content).toContain('20000 灵气与 20000 灵石');

    db.exec(readFileSync(join(dir, migration), 'utf8'));
    addSect('gamma');
    expect(applyMigrations(db, dir)).toEqual([]);
    expect(db.prepare("SELECT balance FROM resource_balances WHERE sect_id = 'alpha' AND resource_id = 'spiritualEnergy'").get()?.balance).toBe(20_001_234);
    expect(db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE event_id = 'fullServerTrainingGift'").get()?.n).toBe(2);
    expect(db.prepare("SELECT balance FROM resource_balances WHERE sect_id = 'gamma' AND resource_id = 'spiritualEnergy'").get()).toBeUndefined();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
