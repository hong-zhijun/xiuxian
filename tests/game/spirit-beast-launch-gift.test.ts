import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';

import { applyMigrations } from '../../apps/server/node/migrate';
import { eventNameOf } from '../../apps/server/src/modules/game/events';

const sourceDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
const giftMigration = '0071_spirit_beast_launch_gift.sql';

// 只放到本次贺礼为止：之后再加的迁移不会叠到这里的断言上。
const migrationDir = mkdtempSync(join(tmpdir(), 'spirit-beast-migrations-'));
for (const file of readdirSync(sourceDir).filter((name) => name.endsWith('.sql') && name <= giftMigration)) {
  copyFileSync(join(sourceDir, file), join(migrationDir, file));
}

it('灵兽上线贺礼：每个已有宗门获赠 5000 灵石、2000 灵气，缺行补齐，留天机录与公告，重复部署不重发，新宗门不补发', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // 构造贺礼之前的数据库（含 0070 的表与列），随后用生产迁移入口执行贺礼。
    db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
    for (const file of readdirSync(migrationDir).filter((name) => name.endsWith('.sql') && name < giftMigration).sort()) {
      db.exec(readFileSync(join(migrationDir, file), 'utf8'));
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(file);
    }
    const createSect = (id: string, balances: Record<string, number>) => {
      db.prepare('INSERT INTO users (id, normalized_account, password_hash, created_at, updated_at) VALUES (?, ?, ?, 0, 0)').run(id, id, 'test-hash');
      db.prepare('INSERT INTO sects (id, user_id, name, last_settled_at, created_at) VALUES (?, ?, ?, 0, 0)').run(id, id, id);
      for (const [resourceId, balance] of Object.entries(balances)) {
        db.prepare('INSERT INTO resource_balances (id, sect_id, resource_id, balance, remainder, updated_at) VALUES (?, ?, ?, ?, 0, 0)')
          .run(`${id}-${resourceId}`, id, resourceId, balance);
      }
    };
    createSect('alpha', { spiritStone: 1_000_000, spiritualEnergy: 300_000 });
    // 缺灵气行的宗门也要到账。
    createSect('beta', { spiritStone: 0 });

    expect(applyMigrations(db, migrationDir)).toContain(giftMigration);
    const balanceOf = (sectId: string, resourceId: string) =>
      db.prepare('SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = ?').get(sectId, resourceId)?.balance;
    expect(balanceOf('alpha', 'spiritStone')).toBe(6_000_000);
    expect(balanceOf('alpha', 'spiritualEnergy')).toBe(2_300_000);
    expect(balanceOf('beta', 'spiritStone')).toBe(5_000_000);
    expect(balanceOf('beta', 'spiritualEnergy')).toBe(2_000_000);

    const gifts = db.prepare("SELECT sect_id, effects FROM event_log WHERE event_id = 'spiritBeastLaunchGift' ORDER BY sect_id").all();
    expect(gifts.map((row) => row.sect_id)).toEqual(['alpha', 'beta']);
    expect(JSON.parse(String(gifts[0]?.effects))).toEqual({ spiritStone: '5000000', spiritualEnergy: '2000000' });
    expect(eventNameOf('spiritBeastLaunchGift')).toBe('灵兽上线贺礼');
    const announcement = db.prepare("SELECT user_id, sect_name, content FROM chat_messages WHERE id = 'announcement-spirit-beast-launch-20261020'").get();
    expect(announcement).toMatchObject({ user_id: 'system', sect_name: '系统' });
    expect(announcement?.content).toContain('5000 灵石、2000 灵气');

    // 重复部署：迁移只执行一次，余额不重复累加；之后新建的宗门不补发。
    createSect('gamma', { spiritStone: 0, spiritualEnergy: 0 });
    expect(applyMigrations(db, migrationDir)).toEqual([]);
    expect(balanceOf('alpha', 'spiritStone')).toBe(6_000_000);
    expect(balanceOf('gamma', 'spiritStone')).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS total FROM event_log WHERE event_id = 'spiritBeastLaunchGift'").get()?.total).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS total FROM chat_messages WHERE id = 'announcement-spirit-beast-launch-20261020'").get()?.total).toBe(1);
  } finally {
    db.close();
    rmSync(migrationDir, { recursive: true, force: true });
  }
});
