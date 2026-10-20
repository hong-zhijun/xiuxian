import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { dataOf, TestClient } from './support/authClient';
import { getSpiritBeasts, startBeastCapture, actBeastCapture, manageSpiritBeast, pruneBeastRecords } from '../src/modules/game/spiritBeastService';
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
  return {api,sectId,userId:user!.user_id,discipleId:state.disciples[0]!.id};
}
const id=()=>crypto.randomUUID();
describe('灵兽 · D1 集成',()=>{
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
});
