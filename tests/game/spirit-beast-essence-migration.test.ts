import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { applyMigrations } from '../../apps/server/node/migrate';

it('精魄迁移补齐老宗门0余额和NULL回执，重复部署不清零存档', () => {
  const dir=fileURLToPath(new URL('../../migrations/',import.meta.url));
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
    for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')&&f<'0072_beast_essence.sql').sort()) {
      db.exec(readFileSync(join(dir,file),'utf8'));db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(file);
    }
    db.exec("INSERT INTO users(id,normalized_account,password_hash,created_at,updated_at) VALUES('u','old-user','hash',0,0)");
    db.exec("INSERT INTO sects(id,user_id,name,last_settled_at,created_at) VALUES('s','u','旧宗门',0,0)");
    db.exec("INSERT INTO spirit_beasts(id,sect_id,species_id,quality,level,locked,created_at,updated_at) VALUES('b','s','white_tiger','treasure',20,1,0,0)");
    db.exec("INSERT INTO beast_commands(sect_id,command_id,fingerprint,created_at) VALUES('s','old-command','{}',0)");
    expect(applyMigrations(db,dir)).toContain('0072_beast_essence.sql');
    expect(db.prepare("SELECT balance,remainder FROM resource_balances WHERE sect_id='s' AND resource_id='beastEssence'").get()).toMatchObject({balance:0,remainder:0});
    expect(db.prepare("SELECT quality,level,locked FROM spirit_beasts WHERE id='b'").get()).toMatchObject({quality:'treasure',level:20,locked:1});
    expect(db.prepare("SELECT receipt_json FROM beast_commands WHERE command_id='old-command'").get()?.receipt_json).toBeNull();
    db.exec("UPDATE resource_balances SET balance=123000 WHERE resource_id='beastEssence'");
    expect(applyMigrations(db,dir)).toEqual([]);
    expect(db.prepare("SELECT balance FROM resource_balances WHERE resource_id='beastEssence'").get()?.balance).toBe(123000);
  } finally { db.close(); }
});
