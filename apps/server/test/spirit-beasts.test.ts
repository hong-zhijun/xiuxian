import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { dataOf, TestClient } from './support/authClient';
import { getSpiritBeasts, startBeastCapture, actBeastCapture, manageSpiritBeast, pruneBeastRecords, exchangeSpiritBeast, releaseSpiritBeasts } from '../src/modules/game/spiritBeastService';
import type { BeastQuality } from '@xiuxian/contracts';
import { assignDisciple, getSectState } from '../src/modules/game/service';
import type { SectStateView } from '../src/modules/game/view';

await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);
const app=createApp({logger:{info:()=>{},warn:()=>{},error:()=>{}}});
const NOW=Date.UTC(2026,9,20,8);let seq=0;
async function fixture(level=7) {
  const n=++seq,api=new TestClient(app,env,{'cf-connecting-ip':`10.70.0.${n}`});
  expect((await api.post('/api/v1/auth/register',{account:`beast-test-${n}`,password:'password-123456'})).status).toBe(200);
  const created=await api.post('/api/v1/game/create-sect',{name:`御兽${n}宗`});
  expect(created.status).toBe(200);
  const state=(dataOf(created) as {state:SectStateView}).state;
  const sectId=state.sect.id;
  const user=await env.DB.prepare('SELECT user_id FROM sects WHERE id=?').bind(sectId).first<{user_id:string}>();
  await env.DB.prepare('UPDATE sects SET level=?,last_settled_at=? WHERE id=?').bind(level,NOW,sectId).run();
  await env.DB.prepare('UPDATE resource_balances SET balance=10000000 WHERE sect_id=?').bind(sectId).run();
  return {api,sectId,userId:user!.user_id,discipleId:state.disciples[0]!.id,initialState:state};
}
const id=()=>crypto.randomUUID();
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function seedBeast(f:Fixture,species='white_tiger',quality:BeastQuality='common',level=1) {
  const beastId=id();
  await env.DB.prepare('INSERT INTO spirit_beasts(id,sect_id,species_id,quality,level,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(beastId,f.sectId,species,quality,level,NOW,NOW).run();
  return {beastId,version:0,commandId:id()};
}
async function balance(f:Fixture,resourceId='beastEssence') {
  return Number(await env.DB.prepare('SELECT balance FROM resource_balances WHERE sect_id=? AND resource_id=?').bind(f.sectId,resourceId).first<number>('balance'));
}
async function setBalance(f:Fixture,amount:number,resourceId='beastEssence') {
  await env.DB.prepare('UPDATE resource_balances SET balance=? WHERE sect_id=? AND resource_id=?').bind(amount,f.sectId,resourceId).run();
}
async function fill(f:Fixture,count:number) {
  await env.DB.batch(Array.from({length:count},()=>env.DB.prepare("INSERT INTO spirit_beasts(id,sect_id,species_id,quality,level,created_at,updated_at) VALUES(?,?,'claw_tiger','common',1,?,?)").bind(id(),f.sectId,NOW,NOW)));
}
describe('灵兽 · D1 集成',()=>{
  it('新宗门精魄初始为0，兑换固定凡品1级且不消耗搜寻，图鉴计获得不计野外遭遇',async()=>{
    const f=await fixture();
    expect(f.initialState.resources.find(r=>r.id==='beastEssence')?.balance).toBe('0');
    await setBalance(f,50_000);
    const exchanged=await exchangeSpiritBeast(env.DB,f.userId,{mode:'random',tier:'divine',commandId:id()},NOW,()=>.999);
    expect(exchanged.beasts.items[0]).toMatchObject({speciesId:'mountain_turtle',quality:'common',level:1,locked:false,discipleId:null,version:0});
    expect(await balance(f)).toBe(0);expect(exchanged.beasts.remaining).toBe(20);
    expect(exchanged.beasts.collection[0]).toMatchObject({seen:0,caught:1,bestQuality:'common'});
    expect(exchanged.receipt?.resourceChanges.beastEssence).toEqual({direction:'debit',amount:'50000'});
    expect(exchanged.state.disciples.every(d=>!d.captureUntil)).toBe(true);
  });
  it('随机兑换回执在物种被放生后仍可重放，不重新随机或发兽',async()=>{
    const f=await fixture(),input={mode:'random' as const,tier:'divine' as const,commandId:id()};
    const first=await exchangeSpiritBeast(env.DB,f.userId,input,NOW,()=>0),b=first.beasts.items[0]!;
    await manageSpiritBeast(env.DB,f.userId,{beastId:b.id,version:0,action:'release',commandId:id()},NOW);
    const before=await balance(f);
    const replay=await exchangeSpiritBeast(env.DB,f.userId,input,NOW,()=>{throw Error('must not reroll');});
    expect(replay.receipt).toEqual(first.receipt);expect(replay.beasts.items).toHaveLength(0);expect(await balance(f)).toBe(before);
    await expect(exchangeSpiritBeast(env.DB,f.userId,{...input,tier:'rare'},NOW)).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    const concurrent=await Promise.all([1,2].map(()=>exchangeSpiritBeast(env.DB,f.userId,{...input,commandId:'00000000-0000-4000-8000-000000000001'},NOW,()=>.5)));
    expect(concurrent[0]!.receipt).toEqual(concurrent[1]!.receipt);expect(concurrent[0]!.beasts.items).toHaveLength(1);
  });
  it('放生按当前品质返还精魄，等级不影响；重复和并发不重复入账',async()=>{
    const f=await fixture(),b=await seedBeast(f,'white_tiger','treasure',20),input={...b,action:'release' as const};
    const before=await balance(f),first=await manageSpiritBeast(env.DB,f.userId,input,NOW);
    expect(await balance(f)).toBe(before+80_000);expect(first.receipt?.beast.level).toBe(20);
    await manageSpiritBeast(env.DB,f.userId,input,NOW);expect(await balance(f)).toBe(before+80_000);
    const second=await seedBeast(f);
    const raced=await Promise.allSettled([1,2].map(()=>manageSpiritBeast(env.DB,f.userId,{...second,action:'release',commandId:id()},NOW)));
    expect(raced.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await balance(f)).toBe(before+90_000);
  });
  it('突破三种资源必须全额支付，满级可突破，仙品停止且保留锁定装备缓存',async()=>{
    const f=await fixture(),b=await seedBeast(f,'white_tiger','common',20);
    const eq=await manageSpiritBeast(env.DB,f.userId,{...b,action:'equip',discipleId:f.discipleId},NOW);
    let beast=eq.beasts.items[0]!;
    const locked=await manageSpiritBeast(env.DB,f.userId,{beastId:b.beastId,version:beast.version,action:'lock',locked:true,commandId:id()},NOW);beast=locked.beasts.items[0]!;
    for(const resourceId of ['beastEssence','spiritStone','spiritualEnergy']) {
      const previous=await balance(f,resourceId);await setBalance(f,0,resourceId);
      const oldEssence=await balance(f);
      await expect(manageSpiritBeast(env.DB,f.userId,{beastId:b.beastId,version:beast.version,action:'quality-breakthrough',commandId:id()},NOW)).rejects.toMatchObject({code:'INSUFFICIENT_RESOURCE'});
      expect(await balance(f)).toBe(oldEssence);
      await setBalance(f,previous,resourceId);
    }
    for(const nextQuality of ['spirit','treasure','immortal']) {
      const quote=beast.qualityBreakthrough!;
      for(const [resourceId,amount] of Object.entries(quote.cost))await setBalance(f,Number(amount),resourceId);
      const result=await manageSpiritBeast(env.DB,f.userId,{beastId:b.beastId,version:beast.version,action:'quality-breakthrough',commandId:id()},NOW);
      beast=result.beasts.items[0]!;expect(beast).toMatchObject({quality:nextQuality,level:20,locked:true,discipleId:f.discipleId});
      for(const resourceId of Object.keys(quote.cost))expect(await balance(f,resourceId)).toBe(0);
      const member=result.state.disciples.find(d=>d.id===f.discipleId)!;
      expect(member.spiritBeast?.quality).toBe(nextQuality);expect(member.spiritBeast?.attrs).toEqual(beast.attrs);
      const json=await env.DB.prepare('SELECT beast_json FROM disciples WHERE id=?').bind(f.discipleId).first<string>('beast_json');expect(JSON.parse(json!).quality).toBe(nextQuality);
      expect(result.beasts.collection[0]?.bestQuality).toBe(nextQuality);
    }
    expect(beast.qualityBreakthrough).toBeNull();
    await expect(manageSpiritBeast(env.DB,f.userId,{beastId:b.beastId,version:beast.version,action:'quality-breakthrough',commandId:id()},NOW)).rejects.toMatchObject({code:'INVALID_STATUS'});
  });
  it('突破幂等、旧version和跨宗门受保护，已有图鉴品质不因兑换凡品降低',async()=>{
    const f=await fixture(),g=await fixture(),b=await seedBeast(f,'claw_tiger','common',20),input={...b,action:'quality-breakthrough' as const};
    const before=await balance(f),first=await manageSpiritBeast(env.DB,f.userId,input,NOW);
    expect(await balance(f)).toBe(before-4000);
    expect((await manageSpiritBeast(env.DB,f.userId,input,NOW)).receipt).toEqual(first.receipt);
    await expect(manageSpiritBeast(env.DB,f.userId,{...input,commandId:id()},NOW)).rejects.toMatchObject({code:'INVALID_STATUS'});
    await expect(manageSpiritBeast(env.DB,g.userId,{...input,commandId:id()},NOW)).rejects.toMatchObject({code:'NOT_FOUND'});
    const exchanged=await exchangeSpiritBeast(env.DB,f.userId,{mode:'specific',tier:'spirit',speciesId:'claw_tiger',commandId:id()},NOW);
    expect(exchanged.beasts.collection[0]).toMatchObject({caught:1,bestQuality:'spirit'});
  });
  it('满容量、捕捉预留和过期预留均正确处理',async()=>{
    const f=await fixture();await fill(f,58);
    const started=await startBeastCapture(env.DB,f.userId,{areaId:'foothills',discipleId:f.discipleId,commandId:id()},NOW,()=>0);
    expect(started.beasts).toMatchObject({reservedSlots:1,availableSlots:1});
    const exchange=await exchangeSpiritBeast(env.DB,f.userId,{mode:'random',tier:'spirit',commandId:id()},NOW,()=>0);
    expect(exchange.beasts.items).toHaveLength(59);expect(exchange.beasts.availableSlots).toBe(0);
    const before=await balance(f);
    await expect(exchangeSpiritBeast(env.DB,f.userId,{mode:'random',tier:'spirit',commandId:id()},NOW)).rejects.toMatchObject({code:'INVALID_STATUS'});expect(await balance(f)).toBe(before);
    const caught=await actBeastCapture(env.DB,f.userId,{sessionId:started.beasts.active!.id,version:0,action:'capture',commandId:id()},NOW,()=>0);
    expect(caught.beasts.items).toHaveLength(60);expect(caught.beasts.reservedSlots).toBe(0);
    await expect(exchangeSpiritBeast(env.DB,f.userId,{mode:'random',tier:'spirit',commandId:id()},NOW)).rejects.toMatchObject({code:'INVALID_STATUS'});
    const g=await fixture();await fill(g,59);
    await startBeastCapture(env.DB,g.userId,{areaId:'foothills',discipleId:g.discipleId,commandId:id()},NOW,()=>0);
    const expired=await exchangeSpiritBeast(env.DB,g.userId,{mode:'random',tier:'spirit',commandId:id()},NOW+1_800_001,()=>0);
    expect(expired.beasts.items).toHaveLength(60);expect(expired.beasts.reservedSlots).toBe(0);
  });
  it('两个兑换争最后一格、兑换争余额、兑换与开始捕捉争最后一格均只允许一笔',async()=>{
    for(const mode of ['capacity','balance','capture'] as const) {
      const f=await fixture();if(mode!=='balance')await fill(f,59);else await setBalance(f,6000);
      const exchange=()=>exchangeSpiritBeast(env.DB,f.userId,{mode:'random',tier:'spirit',commandId:id()},NOW,()=>0);
      const attempts=await Promise.allSettled([exchange(),mode==='capture'?startBeastCapture(env.DB,f.userId,{areaId:'foothills',discipleId:f.discipleId,commandId:id()},NOW,()=>0):exchange()]);
      expect(attempts.filter(a=>a.status==='fulfilled')).toHaveLength(1);
      const panel=(await getSpiritBeasts(env.DB,f.userId,NOW)).beasts;
      expect(panel.items.length+panel.reservedSlots).toBeLessThanOrEqual(60);expect(await balance(f)).toBeGreaterThanOrEqual(0);
      if(mode==='balance')expect(await balance(f)).toBe(0);
    }
  });
  it('突破与兑换争同一笔精魄不能重复花费，跨操作复用命令被拒绝',async()=>{
    const f=await fixture(),b=await seedBeast(f,'claw_tiger','common',20);
    await setBalance(f,6000);
    const attempts=await Promise.allSettled([
      manageSpiritBeast(env.DB,f.userId,{...b,action:'quality-breakthrough'},NOW),
      exchangeSpiritBeast(env.DB,f.userId,{mode:'random',tier:'spirit',commandId:id()},NOW,()=>0),
    ]);
    expect(attempts.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const panel=(await getSpiritBeasts(env.DB,f.userId,NOW)).beasts;
    const advanced=panel.items.find(item=>item.id===b.beastId)!.quality==='spirit';
    expect(await balance(f)).toBe(advanced?2000:0);
    expect(panel.items).toHaveLength(advanced?1:2);
    const commandId=id(),g=await fixture();
    const exchanged=await exchangeSpiritBeast(env.DB,g.userId,{mode:'random',tier:'spirit',commandId},NOW,()=>0);
    const received=exchanged.beasts.items[0]!,before=await balance(g);
    await expect(manageSpiritBeast(env.DB,g.userId,{beastId:received.id,version:0,action:'release',commandId},NOW)).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    expect(await balance(g)).toBe(before);
    // 相同命令标识在另一个宗门独立生效。
    const third=await fixture();
    expect((await exchangeSpiritBeast(env.DB,third.userId,{mode:'random',tier:'spirit',commandId},NOW,()=>0)).beasts.items).toHaveLength(1);
  });
  it('收服与兑换并发时不占用对方容量，不吞精魄或重复计算图鉴',async()=>{
    for(const owned of [58,59]) {
      const f=await fixture();await fill(f,owned);
      const started=await startBeastCapture(env.DB,f.userId,{areaId:'foothills',discipleId:f.discipleId,commandId:id()},NOW,()=>0);
      const before=await balance(f),session=started.beasts.active!;
      const attempts=await Promise.allSettled([
        actBeastCapture(env.DB,f.userId,{sessionId:session.id,version:0,action:'capture',commandId:id()},NOW,()=>0),
        exchangeSpiritBeast(env.DB,f.userId,{mode:'random',tier:'spirit',commandId:id()},NOW,()=>0),
      ]);
      const captured=attempts[0]!.status==='fulfilled',exchanged=attempts[1]!.status==='fulfilled';
      expect(captured||exchanged).toBe(true);
      const panel=(await getSpiritBeasts(env.DB,f.userId,NOW)).beasts;
      expect(panel.items).toHaveLength(owned+Number(captured)+Number(exchanged));
      expect(panel.items.length+panel.reservedSlots).toBeLessThanOrEqual(60);
      expect(await balance(f)).toBe(before-(exchanged?6000:0));
      expect(panel.collection[0]?.caught).toBe(Number(captured)+Number(exchanged));
      if(owned===59)expect(exchanged).toBe(false);
    }
  });
  it('精魄余额缺行或容量不足不能删兽；旧版放生命令不补发材料',async()=>{
    const f=await fixture(),b=await seedBeast(f);
    const cap=Number((await getSpiritBeasts(env.DB,f.userId,NOW)).state.resources.find(r=>r.id==='beastEssence')!.capacity);
    await setBalance(f,cap-1);
    await expect(manageSpiritBeast(env.DB,f.userId,{...b,action:'release'},NOW)).rejects.toMatchObject({code:'INVALID_STATUS'});
    expect((await getSpiritBeasts(env.DB,f.userId,NOW)).beasts.items).toHaveLength(1);
    await env.DB.prepare("DELETE FROM resource_balances WHERE sect_id=? AND resource_id='beastEssence'").bind(f.sectId).run();
    await expect(manageSpiritBeast(env.DB,f.userId,{...b,action:'release'},NOW)).rejects.toMatchObject({code:'INVALID_STATUS'});
    expect((await getSpiritBeasts(env.DB,f.userId,NOW)).beasts.items).toHaveLength(1);
    const g=await fixture(),legacy={beastId:id(),version:0,commandId:id(),action:'release' as const};
    await env.DB.prepare('INSERT INTO beast_commands(sect_id,command_id,fingerprint,created_at) VALUES(?,?,?,?)').bind(g.sectId,legacy.commandId,JSON.stringify(legacy),NOW).run();
    const before=await balance(g);expect((await manageSpiritBeast(env.DB,g.userId,legacy,NOW)).receipt).toBeNull();expect(await balance(g)).toBe(before);
  });
  it('数据库批次失败时扣费、发兽、图鉴和回执一起回滚',async()=>{
    const f=await fixture(),commandId=id(),before=await balance(f);
    await env.DB.exec("CREATE TRIGGER beast_exchange_test_failure BEFORE INSERT ON spirit_beasts BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    try { await expect(exchangeSpiritBeast(env.DB,f.userId,{mode:'random',tier:'divine',commandId},NOW)).rejects.toThrow(); }
    finally { await env.DB.exec('DROP TRIGGER beast_exchange_test_failure'); }
    expect(await balance(f)).toBe(before);const panel=(await getSpiritBeasts(env.DB,f.userId,NOW)).beasts;
    expect(panel.items).toHaveLength(0);expect(panel.collection).toHaveLength(0);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM beast_commands WHERE sect_id=? AND command_id=?').bind(f.sectId,commandId).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM mutation_guards').first<number>('n')).toBe(0);
  });
  it('严格路由拒绝伪造产出、跨档物种和参数混用，档次门槛不被绕过',async()=>{
    const f=await fixture(3);
    for(const extra of [{quality:'immortal'},{level:20},{cost:0},{quantity:10},{speciesId:'white_tiger'}]) {
      const response=await f.api.post('/api/v1/game/spirit-beasts/exchange',{mode:'random',tier:'spirit',commandId:id(),...extra});expect(response.status).toBe(400);
    }
    expect((await f.api.post('/api/v1/game/spirit-beasts/exchange',{mode:'specific',tier:'spirit',speciesId:'white_tiger',commandId:id()})).status).toBe(400);
    await expect(exchangeSpiritBeast(env.DB,f.userId,{mode:'random',tier:'rare',commandId:id()},NOW)).rejects.toMatchObject({code:'INVALID_STATUS'});
    await expect(exchangeSpiritBeast(env.DB,f.userId,{mode:'random',tier:'divine',commandId:id()},NOW)).rejects.toMatchObject({code:'INVALID_STATUS'});
    const b=await seedBeast(f,'claw_tiger');
    expect((await f.api.post('/api/v1/game/spirit-beasts/manage',{...b,action:'release',locked:false})).status).toBe(400);
    const valid=await f.api.post('/api/v1/game/spirit-beasts/exchange',{mode:'specific',tier:'spirit',speciesId:'claw_tiger',commandId:id()});expect(valid.status).toBe(200);
  });
  it('培养与携带快照限制生效，旧会话兼容，不按同物种误拦放生',async()=>{
    const f=await fixture(),b=await seedBeast(f,'claw_tiger','common',20),another=await seedBeast(f,'claw_tiger');
    const equipped=await manageSpiritBeast(env.DB,f.userId,{...b,action:'equip',discipleId:f.discipleId},NOW);
    const current=equipped.beasts.items.find(item=>item.id===b.beastId)!;
    const started=await startBeastCapture(env.DB,f.userId,{areaId:'foothills',discipleId:f.discipleId,commandId:id()},NOW,()=>0);
    const session=started.beasts.active!;
    await expect(manageSpiritBeast(env.DB,f.userId,{...b,version:current.version,action:'quality-breakthrough',commandId:id()},NOW)).rejects.toMatchObject({code:'INVALID_STATUS'});
    await manageSpiritBeast(env.DB,f.userId,{...another,action:'release'},NOW);
    await env.DB.prepare('UPDATE spirit_beasts SET disciple_id=NULL WHERE id=?').bind(b.beastId).run();
    await expect(manageSpiritBeast(env.DB,f.userId,{...b,version:current.version,action:'release',commandId:id()},NOW)).rejects.toMatchObject({code:'INVALID_STATUS'});
    await env.DB.prepare("UPDATE beast_capture_sessions SET data=json_remove(data,'$.carriedBeastId') WHERE id=?").bind(session.id).run();
    await expect(manageSpiritBeast(env.DB,f.userId,{...b,version:current.version,action:'release',commandId:id()},NOW)).rejects.toMatchObject({code:'INVALID_STATUS'});
    expect((await actBeastCapture(env.DB,f.userId,{sessionId:session.id,version:0,action:'leave',commandId:id()},NOW)).beasts.active).toBeNull();
  });
  it('开放门槛、区域门槛与严格路由',async()=>{
    const f=await fixture(2);expect((await getSpiritBeasts(env.DB,f.userId,NOW)).beasts.unlocked).toBe(false);
    await expect(startBeastCapture(env.DB,f.userId,{areaId:'foothills',discipleId:f.discipleId,commandId:id()},NOW)).rejects.toMatchObject({code:'INVALID_STATUS'});
    expect((await f.api.post('/api/v1/game/beast-capture/start',{areaId:'foothills',discipleId:f.discipleId,commandId:id(),cheat:true})).status).toBe(400);
  });
  it('搜寻扣费一次、刷新恢复；弟子占用；收服重试不重复发兽',async()=>{
    const f=await fixture(),command={areaId:'foothills',discipleId:f.discipleId,commandId:id()};
    const started=await startBeastCapture(env.DB,f.userId,command,NOW,()=>0);
    expect(started.beasts.remaining).toBe(19);expect(started.beasts.active?.species.id).toBe('claw_tiger');
    expect(started.state.disciples.find(d=>d.id===f.discipleId)?.combatBlockedReason).toBe('捕捉灵兽中');
    const repeated=await startBeastCapture(env.DB,f.userId,command,NOW,()=>.999);
    expect(repeated.beasts.active?.id).toBe(started.beasts.active!.id);expect(repeated.beasts.remaining).toBe(19);
    await expect(assignDisciple(env.DB,f.userId,f.discipleId,'cultivating',NOW)).rejects.toMatchObject({code:'INVALID_STATUS'});
    const active=started.beasts.active!,action={sessionId:active.id,version:active.version,action:'capture' as const,commandId:id()};
    const caught=await actBeastCapture(env.DB,f.userId,action,NOW,()=>0);
    expect(caught.beasts.items).toHaveLength(1);expect(caught.beasts.active).toBeNull();expect(caught.beasts.recent?.caught?.level).toBe(1);
    expect((await actBeastCapture(env.DB,f.userId,action,NOW,()=>.999)).beasts.items).toHaveLength(1);
    const row=await env.DB.prepare('SELECT capture_until FROM disciples WHERE id=?').bind(f.discipleId).first<{capture_until:number|null}>();expect(row!.capture_until).toBeNull();
    expect(caught.beasts.collection[0]?.caught).toBe(1);
  });
  it('装备、培养、换人、锁定、放生与图鉴保留',async()=>{
    const f=await fixture(),start=await startBeastCapture(env.DB,f.userId,{areaId:'foothills',discipleId:f.discipleId,commandId:id()},NOW,()=>0);
    const s=start.beasts.active!,caught=await actBeastCapture(env.DB,f.userId,{sessionId:s.id,version:0,action:'capture',commandId:id()},NOW,()=>0);
    let b=caught.beasts.items[0]!;
    const equipped=await manageSpiritBeast(env.DB,f.userId,{beastId:b.id,version:b.version,action:'equip',discipleId:f.discipleId,commandId:id()},NOW);
    expect(equipped.state.disciples.find(d=>d.id===f.discipleId)?.spiritBeast?.name).toBe('裂爪虎');
    b=equipped.beasts.items[0]!;
    const upgraded=await manageSpiritBeast(env.DB,f.userId,{beastId:b.id,version:b.version,action:'upgrade',commandId:id()},NOW);
    expect(upgraded.beasts.items[0]!.level).toBe(2);
    const next=upgraded.state.disciples.find(d=>d.id!==f.discipleId)!.id;b=upgraded.beasts.items[0]!;
    const moved=await manageSpiritBeast(env.DB,f.userId,{beastId:b.id,version:b.version,action:'equip',discipleId:next,commandId:id()},NOW);
    expect(moved.state.disciples.find(d=>d.id===f.discipleId)?.spiritBeast).toBeNull();expect(moved.state.disciples.find(d=>d.id===next)?.spiritBeast?.level).toBe(2);
    b=moved.beasts.items[0]!;
    await expect(manageSpiritBeast(env.DB,f.userId,{beastId:b.id,version:b.version,action:'release',commandId:id()},NOW)).rejects.toMatchObject({code:'INVALID_STATUS'});
    const off=await manageSpiritBeast(env.DB,f.userId,{beastId:b.id,version:b.version,action:'unequip',commandId:id()},NOW);b=off.beasts.items[0]!;
    const lock=await manageSpiritBeast(env.DB,f.userId,{beastId:b.id,version:b.version,action:'lock',locked:true,commandId:id()},NOW);b=lock.beasts.items[0]!;
    await expect(manageSpiritBeast(env.DB,f.userId,{beastId:b.id,version:b.version,action:'release',commandId:id()},NOW)).rejects.toMatchObject({code:'INVALID_STATUS'});
    const unlock=await manageSpiritBeast(env.DB,f.userId,{beastId:b.id,version:b.version,action:'lock',locked:false,commandId:id()},NOW);b=unlock.beasts.items[0]!;
    const released=await manageSpiritBeast(env.DB,f.userId,{beastId:b.id,version:b.version,action:'release',commandId:id()},NOW);
    expect(released.beasts.items).toHaveLength(0);expect(released.beasts.collection[0]?.caught).toBe(1);
    expect((await getSectState(env.DB,f.userId,NOW))!.disciples.find(d=>d.id===next)?.spiritBeast).toBeNull();
  });
  it('并发搜寻只创建一次；过期释放占用；跨宗门不可操作',async()=>{
    const f=await fixture(),g=await fixture();
    const requests=await Promise.allSettled([1,2].map(()=>startBeastCapture(env.DB,f.userId,{areaId:'foothills',discipleId:f.discipleId,commandId:id()},NOW,()=>0)));
    expect(requests.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const active=(await getSpiritBeasts(env.DB,f.userId,NOW)).beasts.active!;
    await expect(actBeastCapture(env.DB,g.userId,{sessionId:active.id,version:0,action:'capture',commandId:id()},NOW,()=>0)).rejects.toMatchObject({code:'NOT_FOUND'});
    const expired=await getSpiritBeasts(env.DB,f.userId,NOW+1800001);expect(expired.beasts.active).toBeNull();
    const again=await startBeastCapture(env.DB,f.userId,{areaId:'foothills',discipleId:f.discipleId,commandId:id()},NOW+1800001,()=>0);expect(again.beasts.active?.id).not.toBe(active.id);
  });
  it('野生个体的血量与品质无关，遭遇时看不出品质',async()=>{
    // 第一次随机抽物种（0.25 → 青角鹿，体魄型），第二次抽品质（0 → 凡品，0.999 → 仙品）。
    const encounter=async(qualityRoll:number)=>{
      const f=await fixture(),rolls=[.25,qualityRoll];
      const r=await startBeastCapture(env.DB,f.userId,{areaId:'foothills',discipleId:f.discipleId,commandId:id()},NOW,()=>rolls.shift()??0);
      expect(r.beasts.active?.species.id).toBe('green_deer');
      const row=await env.DB.prepare("SELECT data FROM beast_capture_sessions WHERE id=?").bind(r.beasts.active!.id).first<{data:string}>();
      return {view:r.beasts.active!,quality:(JSON.parse(row!.data) as {quality:string}).quality};
    };
    const common=await encounter(0),immortal=await encounter(.999);
    expect(common.quality).toBe('common');expect(immortal.quality).toBe('immortal');
    expect(immortal.view.targetMaxHp).toBe(common.view.targetMaxHp);
  });
  it('定时清理只删 7 天前已结束的记录，整点之外不执行',async()=>{
    const f=await fixture(),old=NOW-8*86_400_000,hour=Date.UTC(2026,9,20,9);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO beast_commands(sect_id,command_id,fingerprint,created_at) VALUES(?,?,?,?)").bind(f.sectId,'old-command','{}',old),
      env.DB.prepare("INSERT INTO beast_commands(sect_id,command_id,fingerprint,created_at) VALUES(?,?,?,?)").bind(f.sectId,'new-command','{}',hour),
      env.DB.prepare("INSERT INTO beast_capture_sessions(id,sect_id,disciple_id,status,data,expires_at,created_at,updated_at) VALUES(?,?,?,'caught','{}',?,?,?)").bind('old-session',f.sectId,f.discipleId,old,old,old),
      env.DB.prepare("INSERT INTO beast_capture_daily(sect_id,date_key,used_count) VALUES(?,?,3)").bind(f.sectId,'2026-10-01'),
    ]);
    const count=async()=>Number((await env.DB.prepare("SELECT (SELECT COUNT(*) FROM beast_commands WHERE sect_id=?1)+(SELECT COUNT(*) FROM beast_capture_sessions WHERE sect_id=?1)+(SELECT COUNT(*) FROM beast_capture_daily WHERE sect_id=?1) n").bind(f.sectId).first<{n:number}>())!.n);
    await pruneBeastRecords(env.DB,hour+60_000);expect(await count()).toBe(4);
    await pruneBeastRecords(env.DB,hour);expect(await count()).toBe(1);
    expect(await env.DB.prepare("SELECT command_id FROM beast_commands WHERE sect_id=?").bind(f.sectId).first('command_id')).toBe('new-command');
  });
  it('品质突破要求满级：未满级时视图给出原因，服务端拒绝且不扣资源',async()=>{
    const f=await fixture(),b=await seedBeast(f,'claw_tiger','common',19);
    const beast=(await getSpiritBeasts(env.DB,f.userId,NOW)).beasts.items.find(item=>item.id===b.beastId)!;
    expect(beast.qualityBreakthrough?.blockedReason).toContain('Lv.20');
    const before=await balance(f);
    await expect(manageSpiritBeast(env.DB,f.userId,{...b,action:'quality-breakthrough'},NOW)).rejects.toMatchObject({code:'INVALID_STATUS'});
    expect(await balance(f)).toBe(before);
  });
  it('批量放生：一次放生多只并合计精魄；锁定、随行或版本变化整批拒绝；重放返回同一回执',async()=>{
    const f=await fixture();
    const a=await seedBeast(f,'claw_tiger','common'),c=await seedBeast(f,'white_tiger','treasure',5),kept=await seedBeast(f,'green_deer');
    await manageSpiritBeast(env.DB,f.userId,{...kept,action:'lock',locked:true},NOW);
    await expect(releaseSpiritBeasts(env.DB,f.userId,{beasts:[{beastId:a.beastId,version:0},{beastId:kept.beastId,version:1}],commandId:id()},NOW)).rejects.toMatchObject({code:'INVALID_STATUS'});
    await expect(releaseSpiritBeasts(env.DB,f.userId,{beasts:[{beastId:a.beastId,version:0},{beastId:c.beastId,version:3}],commandId:id()},NOW)).rejects.toMatchObject({code:'INVALID_STATUS'});
    await expect(releaseSpiritBeasts(env.DB,f.userId,{beasts:[{beastId:a.beastId,version:0},{beastId:a.beastId,version:0}],commandId:id()},NOW)).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    const before=await balance(f),input={beasts:[{beastId:a.beastId,version:0},{beastId:c.beastId,version:0}],commandId:id()};
    const done=await releaseSpiritBeasts(env.DB,f.userId,input,NOW);
    expect(done.beasts.items.map(item=>item.id)).toEqual([kept.beastId]);
    expect(await balance(f)).toBe(before+1000+80000);
    expect(done.receipt).toMatchObject({kind:'release-batch',released:[{id:expect.any(String)},{id:expect.any(String)}],resourceChanges:{beastEssence:{direction:'credit',amount:'81000'}}});
    const replayed=await releaseSpiritBeasts(env.DB,f.userId,input,NOW);
    expect(replayed.receipt).toEqual(done.receipt);expect(await balance(f)).toBe(before+81000);
    expect((await f.api.post('/api/v1/game/spirit-beasts/release-batch',{beasts:[],commandId:id()})).status).toBe(400);
  });
});
