import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';

import { applyMigrations } from '../../apps/server/node/migrate';
import { eventNameOf } from '../../apps/server/src/modules/game/events';

const sourceDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
const giftMigration = '0067_technique_launch_gift.sql';

// 只放到本次贺礼为止：之后再加的迁移不会叠到这里的断言上。
const migrationDir = mkdtempSync(join(tmpdir(), 'technique-migrations-'));
for (const file of readdirSync(sourceDir).filter((name) => name.endsWith('.sql') && name <= giftMigration)) {
  copyFileSync(join(sourceDir, file), join(migrationDir, file));
}

it('功法上线贺礼：每个已有宗门获赠四门玄阶残卷各 10 张，留天机录与公告，重复部署不重发，新宗门不补发', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // 构造贺礼之前的数据库（含 0066 的表与列），随后用生产迁移入口执行贺礼。
    db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
    for (const file of readdirSync(migrationDir).filter((name) => name.endsWith('.sql') && name < giftMigration).sort()) {
      db.exec(readFileSync(join(migrationDir, file), 'utf8'));
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(file);
    }
    const createSect = (id: string) => {
      db.prepare('INSERT INTO users (id, normalized_account, password_hash, created_at, updated_at) VALUES (?, ?, ?, 0, 0)').run(id, id, 'test-hash');
      db.prepare('INSERT INTO sects (id, user_id, name, last_settled_at, created_at) VALUES (?, ?, ?, 0, 0)').run(id, id, id);
    };
    createSect('alpha');
    createSect('beta');

    expect(applyMigrations(db, migrationDir)).toContain(giftMigration);
    const scrollsOf = (sectId: string, techniqueId: string) =>
      db.prepare('SELECT scrolls FROM sect_techniques WHERE sect_id = ? AND technique_id = ?').get(sectId, techniqueId)?.scrolls;
    for (const sectId of ['alpha', 'beta']) {
      for (const techniqueId of ['qingfeng', 'jingang', 'guiying', 'pojun']) {
        expect(scrollsOf(sectId, techniqueId)).toBe(10);
        expect(db.prepare('SELECT level FROM sect_techniques WHERE sect_id = ? AND technique_id = ?').get(sectId, techniqueId)?.level).toBe(0);
      }
      // 百毒不侵与各阶其余功法不在贺礼里。
      expect(scrollsOf(sectId, 'baidu')).toBeUndefined();
      expect(scrollsOf(sectId, 'pojia')).toBeUndefined();
    }
    const gifts = db.prepare("SELECT sect_id, description FROM event_log WHERE event_id = 'techniqueLaunchGift' ORDER BY sect_id").all();
    expect(gifts.map((row) => row.sect_id)).toEqual(['alpha', 'beta']);
    expect(eventNameOf('techniqueLaunchGift')).toBe('功法上线贺礼');
    const announcement = db.prepare("SELECT user_id, sect_name, content FROM chat_messages WHERE id = 'announcement-technique-launch-20261019'").get();
    expect(announcement).toMatchObject({ user_id: 'system', sect_name: '系统' });
    expect(announcement?.content).toContain('青锋剑诀、金刚不坏体、鬼影步、破军诀残卷各 10 张');

    // 重复部署：迁移只执行一次，残卷不重复累加；之后新建的宗门不补发。
    createSect('gamma');
    expect(applyMigrations(db, migrationDir)).toEqual([]);
    expect(scrollsOf('alpha', 'qingfeng')).toBe(10);
    expect(scrollsOf('gamma', 'qingfeng')).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS total FROM event_log WHERE event_id = 'techniqueLaunchGift'").get()?.total).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS total FROM chat_messages WHERE id = 'announcement-technique-launch-20261019'").get()?.total).toBe(1);
  } finally {
    db.close();
    rmSync(migrationDir, { recursive: true, force: true });
  }
});
