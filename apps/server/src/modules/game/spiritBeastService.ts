import type { BeastCaptureAction, BeastCaptureView, BeastIdentity, BeastQuality, SpiritBeastsPanel, SpiritBeastView } from '@xiuxian/contracts';
import { AppError } from '../../http/appError';
import type { ParameterizedQuery } from '../../infra/db/repository';
import { dateKeyUtc8 } from './constants';
import { battleAttrsOf, draftFor, gearedCombatPower, requireCanFight, techniqueModsOf } from './service';
import { BEAST_AREAS, BEAST_QUALITY, BEAST_RULES, BEAST_SPECIES, beastAttributes, beastMods, beastSkillText, beastUpgradeCost, encounterQuality, encounterSpecies, readBeast } from './spiritBeasts';
import { captureChance, makeCaptureFighter, stepCapture, type CaptureData } from './beastCapture';

interface BeastRow { id:string;sect_id:string;species_id:string;quality:BeastQuality;level:number;disciple_id:string|null;locked:number;version:number;created_at:number;updated_at:number }
interface SessionRow { id:string;sect_id:string;disciple_id:string;status:BeastCaptureView['status'];version:number;data:string;expires_at:number;created_at:number;updated_at:number }
type Draft = Awaited<ReturnType<typeof draftFor>>;
const identity=(b:BeastRow):BeastIdentity=>({id:b.id,speciesId:b.species_id,quality:b.quality,level:b.level});
function viewBeast(b:BeastRow,d:Draft):SpiritBeastView {
  const i=identity(b);return {...i,species:BEAST_SPECIES.find(s=>s.id===i.speciesId)!,qualityName:BEAST_QUALITY[b.quality].name,
    attrs:beastAttributes(i),skillText:beastSkillText(i),discipleId:b.disciple_id,
    discipleName:d.disciples.find(m=>m.id===b.disciple_id)?.name??null,locked:!!b.locked,version:b.version,upgradeCost:beastUpgradeCost(i)};
}
function sessionView(row:SessionRow,beasts:BeastRow[],d:Draft,now:number):BeastCaptureView {
  const s=JSON.parse(row.data) as CaptureData;
  const caught=beasts.find(b=>b.id===s.caughtId);
  return {id:row.id,version:row.version,status:row.status==='active'&&row.expires_at<=now?'expired':row.status,
    areaId:s.areaId,discipleId:row.disciple_id,discipleName:s.player.name,species:BEAST_SPECIES.find(b=>b.id===s.speciesId)!,
    hp:s.player.hp,maxHp:s.player.maxHp,targetHp:s.target.hp,targetMaxHp:s.target.maxHp,
    round:s.round,attempts:s.attempts,maxRounds:BEAST_RULES.maxRounds,maxAttempts:BEAST_RULES.maxAttempts,
    captureRate:captureChance(s),expiresAt:row.expires_at,logs:s.logs,caught:caught?viewBeast(caught,d):null};
}
async function loadPanel(db:D1Database,d:Draft,now:number):Promise<SpiritBeastsPanel> {
  const [items,sessions,daily,collection]=await Promise.all([
    db.prepare('SELECT * FROM spirit_beasts WHERE sect_id=? ORDER BY created_at DESC,id').bind(d.sect.id).all<BeastRow>(),
    db.prepare('SELECT * FROM beast_capture_sessions WHERE sect_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').bind(d.sect.id).all<SessionRow>(),
    db.prepare('SELECT used_count FROM beast_capture_daily WHERE sect_id=? AND date_key=?').bind(d.sect.id,dateKeyUtc8(now)).first<{used_count:number}>(),
    db.prepare('SELECT * FROM beast_collection WHERE sect_id=?').bind(d.sect.id).all<{species_id:string;seen_count:number;caught_count:number;best_quality:BeastQuality|null}>(),
  ]);
  const recent=sessions.results[0]?sessionView(sessions.results[0],items.results,d,now):null;
  return {unlocked:d.sect.level>=BEAST_RULES.unlockLevel,unlockLevel:BEAST_RULES.unlockLevel,capacity:BEAST_RULES.capacity,maxLevel:BEAST_RULES.maxLevel,
    dailyLimit:BEAST_RULES.dailyLimit,remaining:Math.max(0,BEAST_RULES.dailyLimit-(daily?.used_count??0)),
    items:items.results.map(b=>viewBeast(b,d)),species:BEAST_SPECIES,
    areas:BEAST_AREAS.map(a=>({...a,unlocked:d.sect.level>=a.requiredSectLevel,speciesIds:[...a.speciesIds]})),
    collection:collection.results.map(c=>({speciesId:c.species_id,seen:c.seen_count,caught:c.caught_count,bestQuality:c.best_quality})),
    active:recent?.status==='active'?recent:null,recent,
    rules:[
      '宗门 3 级开放；每日 20 次搜寻，UTC+8 零点恢复。普通秘境次数独立。',
      '每次搜寻消耗区域标示的灵石；收服不额外收费。失败、离开或超时不退搜寻费用。',
      '每场最多 15 次操作、5 次收服，30 分钟过期。关闭界面不放弃，返回后可继续。',
      '幸运提高稀有遭遇与收服概率（捕捉用途最高按 100 计算），不影响品质。',
      '留手覆盖全部追击和追加伤害，至少为目标保留 1 血；目标仍会反击。',
      '捕获后为 1 级，品质固定；升级只消耗灵石和灵气，最高 20 级。放生不返还资源。',
      '战败弟子疗伤 10 分钟，不损失携带灵兽。已装备或锁定的灵兽不能放生。',
      '技能在捕捉、镇妖塔与大比完整生效；世界 Boss 折算为伤害和受伤修正，旧式普通秘境仅计入属性。',
      '金克木、木克土、土克水、水克火、火克金：克制伤害 +15%，被克制 −15%。',
    ]};
}
export async function getSpiritBeasts(db:D1Database,userId:string,now:number) {
  const d=await draftFor(db,userId,now);return {beasts:await loadPanel(db,d,now)};
}
function guard(_d:Draft,sql:string,params:(string|number|null)[]) {
  const id=crypto.randomUUID();return {id,statement:{sql:`INSERT INTO mutation_guards(command_id,valid) SELECT ?, CASE WHEN ${sql} THEN 1 ELSE 0 END`,params:[id,...params]} satisfies ParameterizedQuery};
}
function requireUnlocked(d:Draft) {if(d.sect.level<BEAST_RULES.unlockLevel)throw new AppError('INVALID_STATUS','宗门 3 级开放灵兽玩法');}
function requireFree(d:Draft,id:string) {
  const member=d.discipleById(id);requireCanFight(d,member,'调整灵兽');
  if(d.activeExploration?.party && (JSON.parse(d.activeExploration.party) as string[]).includes(id)) throw new AppError('INVALID_STATUS','该弟子正在普通秘境中');
  return member;
}
/** 升级只改数值：随行弟子在历练、任执事或坐镇时也能升级，只避开正在捕捉或普通秘境中的弟子。 */
function requireNotInBattle(d:Draft,id:string) {
  const member=d.discipleById(id);
  if((member.capture_until??0)>d.now)throw new AppError('INVALID_STATUS',`${member.name}正在捕捉灵兽，结束后才能升级`);
  if(d.activeExploration?.party && (JSON.parse(d.activeExploration.party) as string[]).includes(id)) throw new AppError('INVALID_STATUS','该弟子正在普通秘境中');
}
async function replay(db:D1Database,sectId:string,commandId:string,fingerprint:string) {
  const row=await db.prepare('SELECT fingerprint,session_id FROM beast_commands WHERE sect_id=? AND command_id=?').bind(sectId,commandId).first<{fingerprint:string;session_id:string|null}>();
  if(row&&row.fingerprint!==fingerprint)throw new AppError('VALIDATION_ERROR','操作标识已用于另一项操作');return row;
}
function record(d:Draft,commandId:string,fingerprint:string,sessionId:string|null,now:number) {
  d.addStatement({sql:'INSERT INTO beast_commands(sect_id,command_id,fingerprint,session_id,created_at) VALUES(?,?,?,?,?)',params:[d.sect.id,commandId,fingerprint,sessionId,now]});
}
async function commit(db:D1Database,d:Draft,extra:ReturnType<typeof guard>[],commandId:string,fingerprint:string) {
  try {await d.commit({extraGuards:extra});}
  catch(error) {
    if(await replay(db,d.sect.id,commandId,fingerprint))return;
    if(error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new AppError('INVALID_STATUS','操作状态已变化，请刷新重试');
    throw error;
  }
}
function refreshCache(d:Draft,discipleId:string,beast:BeastRow|null) {
  const json=beast?JSON.stringify(identity(beast)):null;
  d.addStatement({sql:'UPDATE disciples SET beast_json=? WHERE id=? AND sect_id=?',params:[json,discipleId,d.sect.id]});
  const m=d.disciples.find(x=>x.id===discipleId);if(m)m.beast_json=json;
}
async function result(db:D1Database,userId:string,now:number) {
  const d=await draftFor(db,userId,now);return {state:d.view(),beasts:await loadPanel(db,d,now)};
}
export async function manageSpiritBeast(db:D1Database,userId:string,input:{beastId:string;version:number;commandId:string;action:'equip'|'unequip'|'upgrade'|'lock'|'release';discipleId?:string;locked?:boolean},now:number) {
  const d=await draftFor(db,userId,now);requireUnlocked(d);
  const fingerprint=JSON.stringify(input);
  if(await replay(db,d.sect.id,input.commandId,fingerprint))return result(db,userId,now);
  const b=await db.prepare('SELECT * FROM spirit_beasts WHERE id=? AND sect_id=?').bind(input.beastId,d.sect.id).first<BeastRow>();
  if(!b)throw new AppError('NOT_FOUND','灵兽不存在');
  if(b.version!==input.version)throw new AppError('INVALID_STATUS','灵兽信息已变化，请刷新');
  const extra=[guard(d,'EXISTS(SELECT 1 FROM spirit_beasts WHERE id=? AND sect_id=? AND version=?)',[b.id,d.sect.id,b.version])];
  if(b.disciple_id) {
    if(input.action==='upgrade')requireNotInBattle(d,b.disciple_id);
    else if(input.action!=='lock')requireFree(d,b.disciple_id);
  }
  if(input.action==='equip') {
    if(!input.discipleId)throw new AppError('VALIDATION_ERROR','请选择携带弟子');
    requireFree(d,input.discipleId);
    const old=await db.prepare('SELECT * FROM spirit_beasts WHERE disciple_id=? AND sect_id=?').bind(input.discipleId,d.sect.id).first<BeastRow>();
    if(old) {
      extra.push(guard(d,'EXISTS(SELECT 1 FROM spirit_beasts WHERE id=? AND version=?)',[old.id,old.version]));
      d.addStatement({sql:'UPDATE spirit_beasts SET disciple_id=NULL,version=version+1,updated_at=? WHERE id=?',params:[now,old.id]});
    } else extra.push(guard(d,'NOT EXISTS(SELECT 1 FROM spirit_beasts WHERE disciple_id=?)',[input.discipleId]));
    if(b.disciple_id&&b.disciple_id!==input.discipleId)refreshCache(d,b.disciple_id,null);
    b.disciple_id=input.discipleId;
    d.addStatement({sql:'UPDATE spirit_beasts SET disciple_id=?,version=version+1,updated_at=? WHERE id=?',params:[b.disciple_id,now,b.id]});
    refreshCache(d,b.disciple_id,b);
  } else if(input.action==='unequip') {
    if(b.disciple_id)refreshCache(d,b.disciple_id,null);
    d.addStatement({sql:'UPDATE spirit_beasts SET disciple_id=NULL,version=version+1,updated_at=? WHERE id=?',params:[now,b.id]});
  } else if(input.action==='upgrade') {
    const cost=beastUpgradeCost(identity(b));if(!cost)throw new AppError('INVALID_STATUS','灵兽已满级');
    d.requireResource('spiritStone',cost.spiritStone);d.requireResource('spiritualEnergy',cost.spiritualEnergy);
    b.level++;
    d.addStatement({sql:'UPDATE spirit_beasts SET level=?,version=version+1,updated_at=? WHERE id=?',params:[b.level,now,b.id]});
    if(b.disciple_id)refreshCache(d,b.disciple_id,b);
  } else if(input.action==='lock') {
    if(typeof input.locked!=='boolean')throw new AppError('VALIDATION_ERROR','请指定锁定状态');
    d.addStatement({sql:'UPDATE spirit_beasts SET locked=?,version=version+1,updated_at=? WHERE id=?',params:[input.locked?1:0,now,b.id]});
  } else {
    if(b.locked||b.disciple_id)throw new AppError('INVALID_STATUS','请先解锁并卸下灵兽再放生');
    d.addStatement({sql:'DELETE FROM spirit_beasts WHERE id=? AND sect_id=?',params:[b.id,d.sect.id]});
  }
  record(d,input.commandId,fingerprint,null,now);await commit(db,d,extra,input.commandId,fingerprint);
  return result(db,userId,now);
}
export async function startBeastCapture(db:D1Database,userId:string,input:{areaId:string;discipleId:string;commandId:string},now:number,random:()=>number=Math.random) {
  const d=await draftFor(db,userId,now);requireUnlocked(d);const fingerprint=JSON.stringify(input);
  if(await replay(db,d.sect.id,input.commandId,fingerprint))return result(db,userId,now);
  const area=BEAST_AREAS.find(a=>a.id===input.areaId);
  if(!area||d.sect.level<area.requiredSectLevel)throw new AppError('INVALID_STATUS','该捕捉区域尚未开放');
  const m=requireFree(d,input.discipleId);
  if((m.injured_until??0)>now)throw new AppError('INVALID_STATUS','弟子正在疗伤');
  const panel=await loadPanel(db,d,now);
  if(panel.active)throw new AppError('INVALID_STATUS','请先结束当前捕捉');
  if(panel.remaining<=0)throw new AppError('DAILY_LIMIT','今日搜寻次数已用完');
  if(panel.items.length>=panel.capacity)throw new AppError('INVALID_STATUS','灵兽苑已满，请先整理');
  d.requireResource('spiritStone',area.cost);
  const attrs=battleAttrsOf(m),power=gearedCombatPower(m),species=encounterSpecies(area.speciesIds,attrs.luck,random),quality=encounterQuality(random);
  const strength=area.strength*({spirit:1,rare:1.1,divine:1.2}[species.tier]);
  // 野生个体按凡品属性与技能出手：品质只决定收服结果，否则血量与伤害会提前暴露品质。
  const skill=beastMods({speciesId:species.id,quality:'common',level:1});
  const wildAttrs=beastAttributes({speciesId:species.id,quality:'common',level:1});
  const data:CaptureData={areaId:area.id,speciesId:species.id,quality,tier:species.tier,round:0,attempts:0,caughtId:null,
    player:makeCaptureFighter({name:m.name,power,...attrs,beast:readBeast(m)?beastMods(readBeast(m)!):undefined,technique:techniqueModsOf(d,m,now)??undefined}),
    target:makeCaptureFighter({name:species.name,power:strength,attack:40+wildAttrs.attack,defense:35+wildAttrs.defense,speed:40+wildAttrs.speed,luck:35+wildAttrs.luck,physique:40+wildAttrs.physique,beast:skill}),
    logs:[`${m.name}进入${area.name}，遭遇${species.elementName}行${species.name}。`, '品质将在收服成功后揭晓。']};
  const id=crypto.randomUUID(),expires=now+BEAST_RULES.sessionMs;
  // 伤势按「此刻是否在伤」比对：草稿里的 injured_until 可能已被到期归队改写，与库里的旧值不同。
  const extra=[
    guard(d,`EXISTS(SELECT 1 FROM disciples WHERE id=? AND realm_id=? AND stage=? AND assignment=? AND COALESCE(injured_until,0)<=? AND COALESCE(severe_injured_until,0)<=? AND technique_id IS ? AND beast_json IS ? AND capture_until IS ?) AND NOT EXISTS(SELECT 1 FROM disciple_journeys WHERE disciple_id=? AND claimed_at IS NULL AND ends_at>?) AND NOT EXISTS(SELECT 1 FROM realm_explorations WHERE sect_id=? AND status='in_progress' AND EXISTS(SELECT 1 FROM json_each(party) WHERE value=?))`,[m.id,m.realm_id,m.stage,m.assignment,now,now,m.technique_id,m.beast_json??null,m.capture_until??null,m.id,now,d.sect.id,m.id]),
    guard(d,'NOT EXISTS(SELECT 1 FROM beast_capture_sessions WHERE sect_id=? AND status=\'active\' AND expires_at>?)',[d.sect.id,now]),
    guard(d,'(SELECT COUNT(*) FROM spirit_beasts WHERE sect_id=?)=?',[d.sect.id,panel.items.length]),
    guard(d,'COALESCE((SELECT used_count FROM beast_capture_daily WHERE sect_id=? AND date_key=?),0)=?',[d.sect.id,dateKeyUtc8(now),BEAST_RULES.dailyLimit-panel.remaining]),
  ];
  d.addStatement({sql:"UPDATE beast_capture_sessions SET status='expired',version=version+1 WHERE sect_id=? AND status='active' AND expires_at<=?",params:[d.sect.id,now]});
  d.addStatement({sql:'INSERT INTO beast_capture_daily(sect_id,date_key,used_count) VALUES(?,?,1) ON CONFLICT(sect_id,date_key) DO UPDATE SET used_count=used_count+1',params:[d.sect.id,dateKeyUtc8(now)]});
  d.addStatement({sql:"INSERT INTO beast_capture_sessions(id,sect_id,disciple_id,status,data,expires_at,created_at,updated_at) VALUES(?,?,?,'active',?,?,?,?)",params:[id,d.sect.id,m.id,JSON.stringify(data),expires,now,now]});
  d.addStatement({sql:'UPDATE disciples SET capture_until=? WHERE id=?',params:[expires,m.id]});
  d.addStatement({sql:'INSERT INTO beast_collection(sect_id,species_id,seen_count) VALUES(?,?,1) ON CONFLICT(sect_id,species_id) DO UPDATE SET seen_count=seen_count+1',params:[d.sect.id,species.id]});
  record(d,input.commandId,fingerprint,id,now);await commit(db,d,extra,input.commandId,fingerprint);return result(db,userId,now);
}
export async function actBeastCapture(db:D1Database,userId:string,input:{sessionId:string;version:number;commandId:string;action:BeastCaptureAction},now:number,random:()=>number=Math.random) {
  const d=await draftFor(db,userId,now);const fingerprint=JSON.stringify(input);
  if(await replay(db,d.sect.id,input.commandId,fingerprint))return result(db,userId,now);
  const row=await db.prepare('SELECT * FROM beast_capture_sessions WHERE id=? AND sect_id=?').bind(input.sessionId,d.sect.id).first<SessionRow>();
  if(!row)throw new AppError('NOT_FOUND','捕捉记录不存在');
  if(row.version!==input.version||row.status!=='active')throw new AppError('INVALID_STATUS','遭遇已变化，请刷新后继续');
  const expired=row.expires_at<=now;
  const next=expired?{data:JSON.parse(row.data) as CaptureData,status:'expired' as const}:stepCapture(JSON.parse(row.data) as CaptureData,input.action,random);
  const extra=[guard(d,"EXISTS(SELECT 1 FROM beast_capture_sessions WHERE id=? AND sect_id=? AND version=? AND status='active')",[row.id,d.sect.id,row.version])];
  if(next.status==='caught') {
    const count=await db.prepare('SELECT COUNT(*) n FROM spirit_beasts WHERE sect_id=?').bind(d.sect.id).first<{n:number}>();
    if((count?.n??0)>=BEAST_RULES.capacity)throw new AppError('INVALID_STATUS','灵兽苑已满，请先整理后继续收服');
    extra.push(guard(d,'(SELECT COUNT(*) FROM spirit_beasts WHERE sect_id=?)<?',[d.sect.id,BEAST_RULES.capacity]));
    const b=next.data,id=crypto.randomUUID();b.caughtId=id;
    d.addStatement({sql:'INSERT INTO spirit_beasts(id,sect_id,species_id,quality,level,created_at,updated_at) VALUES(?,?,?,?,1,?,?)',params:[id,d.sect.id,b.speciesId,b.quality,now,now]});
    const ranks=['common','spirit','treasure','immortal'];
    const collection=await db.prepare('SELECT best_quality FROM beast_collection WHERE sect_id=? AND species_id=?').bind(d.sect.id,b.speciesId).first<{best_quality:BeastQuality|null}>();
    const best=ranks.indexOf(collection?.best_quality??'')>ranks.indexOf(b.quality)?collection!.best_quality!:b.quality;
    d.addStatement({sql:'UPDATE beast_collection SET caught_count=caught_count+1,best_quality=? WHERE sect_id=? AND species_id=?',params:[best,d.sect.id,b.speciesId]});
  }
  d.addStatement({sql:'UPDATE beast_capture_sessions SET status=?,version=version+1,data=?,updated_at=? WHERE id=?',params:[next.status,JSON.stringify(next.data),now,row.id]});
  if(next.status!=='active') {
    d.addStatement({sql:'UPDATE disciples SET capture_until=NULL WHERE id=? AND sect_id=?',params:[row.disciple_id,d.sect.id]});
    if(next.status==='defeated')d.addStatement({sql:'UPDATE disciples SET injured_until=MAX(COALESCE(injured_until,0),?) WHERE id=?',params:[now+600_000,row.disciple_id]});
  }
  record(d,input.commandId,fingerprint,row.id,now);await commit(db,d,extra,input.commandId,fingerprint);return result(db,userId,now);
}
const BEAST_RECORD_KEEP_MS=7*24*3_600_000;
/** 定时任务每小时顺带清理一次：7 天前的命令幂等记录、已结束或早已过期的捕捉记录与每日计数，防止表无限增长。 */
export async function pruneBeastRecords(db:D1Database,now:number) {
  if(new Date(now).getUTCMinutes()!==0)return;
  const before=now-BEAST_RECORD_KEEP_MS;
  await db.batch([
    db.prepare('DELETE FROM beast_commands WHERE created_at<?').bind(before),
    db.prepare("DELETE FROM beast_capture_sessions WHERE created_at<? AND (status<>'active' OR expires_at<=?)").bind(before,now),
    db.prepare('DELETE FROM beast_capture_daily WHERE date_key<?').bind(dateKeyUtc8(before)),
  ]);
}
