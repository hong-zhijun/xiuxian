import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { applyMigrations } from '../../apps/server/node/migrate';

it('Node 部署升级：已有玩家各得一亿灵石，重复启动不重发，更新后建宗不补发', () => {
  const dir = fileURLToPath(new URL('../../migrations/', import.meta.url));
  const migration = '0075_scratch_card_update_gift.sql';
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
    for (const file of readdirSync(dir).filter(file => file.endsWith('.sql') && file < migration).sort()) {
      db.exec(readFileSync(join(dir, file), 'utf8'));
      db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(file);
    }
    function addSect(id: string) {
      db.prepare('INSERT INTO users(id, normalized_account, password_hash, created_at, updated_at) VALUES(?, ?, ?, 0, 0)')
        .run(`user-${id}`, `account-${id}`, 'hash');
      db.prepare('INSERT INTO sects(id, user_id, name, last_settled_at, created_at) VALUES(?, ?, ?, 0, 0)')
        .run(id, `user-${id}`, `宗门${id}`);
    }
    const balanceOf = (id: string) => db.prepare("SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = 'spiritStone'").get(id)?.balance;
    addSect('existing');
    addSect('missing-balance');
    db.exec("INSERT INTO resource_balances(id, sect_id, resource_id, balance, remainder, updated_at) VALUES('balance', 'existing', 'spiritStone', 1234, 5, 0)");

    expect(applyMigrations(db, dir)).toEqual([migration]);
    expect(balanceOf('existing')).toBe(100_000_001_234);
    expect(balanceOf('missing-balance')).toBe(100_000_000_000);
    expect(db.prepare("SELECT remainder FROM resource_balances WHERE id = 'balance'").get()?.remainder).toBe(5);
    expect(db.prepare("SELECT COUNT(*) AS count FROM event_log WHERE event_id = 'scratchCardUpdateGift'").get()?.count).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE id = 'announcement-scratch-card-update-20261024'").get()?.count).toBe(1);

    addSect('new');
    expect(applyMigrations(db, dir)).toEqual([]);
    expect(balanceOf('existing')).toBe(100_000_001_234);
    expect(balanceOf('new')).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM event_log WHERE event_id = 'scratchCardUpdateGift'").get()?.count).toBe(2);
  } finally {
    db.close();
  }
});
