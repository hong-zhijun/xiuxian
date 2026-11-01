import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { applyMigrations } from '../../apps/server/node/migrate';

it('灵兽等级扩展迁移：保留原兽、携带缓存和索引，按品质限制20/30/40/60级，重启不重置',()=>{
  const dir=fileURLToPath(new URL('../../migrations/',import.meta.url));
  const migration='0079_beast_quality_level_caps.sql',db=new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    db.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
    for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')&&f<migration).sort()) {
      db.exec(readFileSync(join(dir,file),'utf8'));db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(file);
    }
    db.exec("INSERT INTO users(id,normalized_account,password_hash,created_at,updated_at) VALUES('u','old-beast-user','hash',0,0)");
    db.exec("INSERT INTO sects(id,user_id,name,last_settled_at,created_at) VALUES('s','u','旧宗门',0,0)");
    db.exec("INSERT INTO disciples(id,sect_id,name,gender,aptitude,created_at,beast_json) VALUES('d','s','旧弟子','male',50,0,'{\"id\":\"b\",\"speciesId\":\"white_tiger\",\"quality\":\"immortal\",\"level\":20}')");
    db.exec("INSERT INTO spirit_beasts(id,sect_id,species_id,quality,level,disciple_id,locked,version,created_at,updated_at) VALUES('b','s','white_tiger','immortal',20,'d',1,8,123,456)");
    const before=db.prepare("SELECT * FROM spirit_beasts WHERE id='b'").get();
    const cache=db.prepare("SELECT beast_json FROM disciples WHERE id='d'").get()?.beast_json;
    expect(applyMigrations(db,dir)).toContain(migration);
    expect(db.prepare("SELECT * FROM spirit_beasts WHERE id='b'").get()).toEqual(before);
    expect(db.prepare("SELECT beast_json FROM disciples WHERE id='d'").get()?.beast_json).toBe(cache);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare("PRAGMA index_list(spirit_beasts)").all().map(row=>row.name)).toEqual(expect.arrayContaining(['spirit_beasts_sect','spirit_beast_slot']));
    for(const [quality,cap] of [['common',20],['spirit',30],['treasure',40],['immortal',60]] as const) {
      db.prepare("INSERT INTO spirit_beasts(id,sect_id,species_id,quality,level,created_at,updated_at) VALUES(?,'s','claw_tiger',?,?,0,0)").run(quality,quality,cap);
      expect(()=>db.prepare('UPDATE spirit_beasts SET level=? WHERE id=?').run(cap+1,quality)).toThrow(/CHECK/i);
    }
    db.exec("UPDATE spirit_beasts SET level=60 WHERE id='b'");
    expect(applyMigrations(db,dir)).toEqual([]);
    expect(db.prepare("SELECT level,version,locked FROM spirit_beasts WHERE id='b'").get()).toMatchObject({level:60,version:8,locked:1});
    expect(()=>db.exec("INSERT INTO spirit_beasts(id,sect_id,species_id,quality,disciple_id,created_at,updated_at) VALUES('dup','s','claw_tiger','common','d',0,0)")).toThrow(/UNIQUE/i);
  } finally {db.close();}
});
