import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

import { applyMigrations } from '../../apps/server/node/migrate';
import { eventNameOf } from '../../apps/server/src/modules/game/events';

const sourceDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
const migration = '0078_ascension_spirit_stone_gift.sql';

it('飞升玩法上线贺礼：已有宗门各得 5 万灵石，重复迁移不重发，新宗门不补发', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascension-stone-gift-'));
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
    db.exec("INSERT INTO resource_balances VALUES ('stone', 'alpha', 'spiritStone', 1234, 9, 0)");

    expect(applyMigrations(db, dir)).toContain(migration);
    expect(db.prepare("SELECT balance, remainder FROM resource_balances WHERE sect_id = 'alpha' AND resource_id = 'spiritStone'").get()).toMatchObject({ balance: 50_001_234, remainder: 9 });
    expect(db.prepare("SELECT balance FROM resource_balances WHERE sect_id = 'beta' AND resource_id = 'spiritStone'").get()?.balance).toBe(50_000_000);
    expect(eventNameOf('ascensionSpiritStoneGift')).toBe('飞升贺礼');
    expect(db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE event_id = 'ascensionSpiritStoneGift'").get()?.n).toBe(2);
    expect(db.prepare("SELECT content FROM chat_messages WHERE id = 'announcement-ascension-spirit-stone-gift-20261031'").get()?.content).toContain('50000（5 万）灵石');

    db.exec(readFileSync(join(dir, migration), 'utf8'));
    addSect('gamma');
    expect(applyMigrations(db, dir)).toEqual([]);
    expect(db.prepare("SELECT balance FROM resource_balances WHERE sect_id = 'alpha' AND resource_id = 'spiritStone'").get()?.balance).toBe(50_001_234);
    expect(db.prepare("SELECT balance FROM resource_balances WHERE sect_id = 'gamma' AND resource_id = 'spiritStone'").get()).toBeUndefined();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
