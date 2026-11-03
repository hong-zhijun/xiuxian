import type { AllianceAction, AllianceChatMessage, AlliancePanel, AllianceSummary } from '@xiuxian/contracts';
import { AppError } from '../../http/appError';
import { prepareStatements, type ParameterizedQuery } from '../../infra/db/repository';
import { dateKeyUtc8 } from './constants';
import { grantReward, saveMetadata } from './progressionService';
import { draftFor, gearedCombatPower, requireCanFight } from './service';
import { ALLIANCE_BOSS_HP, ALLIANCE_CHAT_COOLDOWN_MS, ALLIANCE_CREATE_COST, ALLIANCE_DAILY_ATTACKS, ALLIANCE_INVITE_MS, ALLIANCE_LEAVE_COOLDOWN_MS, ALLIANCE_MAX_MEMBERS, ALLIANCE_MIN_MEMBERS, ALLIANCE_SHOP, allianceBossDamage, allianceMerit, allianceWeek, normalizedAllianceName } from './alliance';

type Draft=Awaited<ReturnType<typeof draftFor>>;
type Guard={id:string;statement:ParameterizedQuery};
interface AllianceRow {id:string;name:string;leader_sect_id:string;member_limit:number;version:number;dissolved_at:number|null;created_at:number;updated_at:number}
interface MemberRow {sect_id:string;alliance_id:string;contribution:number;joined_at:number;name:string;level:number}
interface Wallet {merit:number;join_cooldown_until:number|null;version:number}
interface Invite {id:string;alliance_id:string;target_sect_id:string;expires_at:number;accepted_at:number|null}
interface Boss {id:string;alliance_id:string;week_key:string;max_hp:number;remaining_hp:number;status:'active'|'settled';version:number;started_at:number;ends_at:number;settled_at:number|null}
interface Ranking {sect_id:string;sect_name:string;damage:number;first_hit:number}
const emptyWallet=():Wallet=>({merit:0,join_cooldown_until:null,version:0});
function guard(sql:string,params:(string|number|null)[]):Guard {
  const id=`${crypto.randomUUID()}:alliance`;
  return {id,statement:{sql:`INSERT INTO mutation_guards(command_id,valid) SELECT ?,CASE WHEN ${sql} THEN 1 ELSE 0 END`,params:[id,...params]}};
}
function walletGuard(sectId:string,wallet:Wallet):Guard {
  return guard('COALESCE((SELECT version FROM sect_alliance_wallets WHERE sect_id=?),0)=?',[sectId,wallet.version]);
}
async function walletOf(db:D1Database,sectId:string):Promise<Wallet> {
  return await db.prepare('SELECT merit,join_cooldown_until,version FROM sect_alliance_wallets WHERE sect_id=?').bind(sectId).first<Wallet>()??emptyWallet();
}
async function membershipOf(db:D1Database,sectId:string):Promise<AllianceRow|null> {
  return db.prepare(`SELECT a.* FROM alliance_members m JOIN alliances a ON a.id=m.alliance_id
    WHERE m.sect_id=? AND a.dissolved_at IS NULL`).bind(sectId).first<AllianceRow>();
}
async function membersOf(db:D1Database,allianceId:string):Promise<MemberRow[]> {
  return (await db.prepare(`SELECT m.*,s.name,s.level FROM alliance_members m JOIN sects s ON s.id=m.sect_id
    WHERE m.alliance_id=? ORDER BY m.joined_at,m.sect_id`).bind(allianceId).all<MemberRow>()).results;
}
async function rankingOf(db:D1Database,bossId:string):Promise<Ranking[]> {
  return (await db.prepare(`SELECT sect_id,MAX(sect_name) AS sect_name,SUM(damage) AS damage,MIN(created_at) AS first_hit
    FROM alliance_boss_hits WHERE boss_id=? GROUP BY sect_id ORDER BY damage DESC,first_hit,sect_id`).bind(bossId).all<Ranking>()).results;
}
function membershipGuard(sectId:string,alliance:AllianceRow|null):Guard {
  return alliance===null?guard('NOT EXISTS(SELECT 1 FROM alliance_members WHERE sect_id=?)',[sectId])
    :guard('EXISTS(SELECT 1 FROM alliance_members m JOIN alliances a ON a.id=m.alliance_id WHERE m.sect_id=? AND a.id=? AND a.version=? AND a.dissolved_at IS NULL)',[sectId,alliance.id,alliance.version]);
}
function bumpAlliance(d:Draft,a:AllianceRow):void {
  d.addStatement({sql:'UPDATE alliances SET version=version+1,updated_at=? WHERE id=?',params:[d.now,a.id]});
}
function writeWallet(d:Draft,sectId:string,wallet:Wallet,changes:{merit?:number;cooldown?:number|null}={}):void {
  d.addStatement({sql:`INSERT INTO sect_alliance_wallets(sect_id,merit,join_cooldown_until,version,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(sect_id) DO UPDATE SET merit=excluded.merit,join_cooldown_until=excluded.join_cooldown_until,version=excluded.version,updated_at=excluded.updated_at`,
    params:[sectId,changes.merit??wallet.merit,changes.cooldown===undefined?wallet.join_cooldown_until:changes.cooldown,wallet.version+1,d.now]});
}
function requireLeader(d:Draft,alliance:AllianceRow|null):AllianceRow {
  if(!alliance)throw new AppError('INVALID_STATUS','尚未加入仙盟');
  if(alliance.leader_sect_id!==d.sect.id)throw new AppError('INVALID_STATUS','只有盟主可以执行此操作');
  return alliance;
}
async function requireMovable(db:D1Database,allianceId:string):Promise<void> {
  const active=await db.prepare("SELECT 1 AS n FROM alliance_bosses WHERE alliance_id=? AND status='active' AND remaining_hp<max_hp LIMIT 1").bind(allianceId).first();
  if(active)throw new AppError('INVALID_STATUS','本周盟 BOSS 已有战绩，请等待结算后再调整成员或解散');
}
function movableGuard(allianceId:string):Guard {
  return guard("NOT EXISTS(SELECT 1 FROM alliance_bosses WHERE alliance_id=? AND status='active' AND remaining_hp<max_hp)",[allianceId]);
}
async function ensureBoss(db:D1Database,a:AllianceRow,memberCount:number,now:number):Promise<Boss|null> {
  if(memberCount<ALLIANCE_MIN_MEMBERS)return null;
  const week=allianceWeek(now);
  await db.prepare(`INSERT INTO alliance_bosses(id,alliance_id,week_key,max_hp,remaining_hp,status,version,started_at,ends_at)
    SELECT ?,?,?,?,?,'active',0,?,? WHERE EXISTS(SELECT 1 FROM alliances WHERE id=? AND dissolved_at IS NULL)
    ON CONFLICT(alliance_id,week_key) DO NOTHING`).bind(crypto.randomUUID(),a.id,week.key,ALLIANCE_BOSS_HP,ALLIANCE_BOSS_HP,week.startsAt,week.endsAt,a.id).run();
  return db.prepare('SELECT * FROM alliance_bosses WHERE alliance_id=? AND week_key=?').bind(a.id,week.key).first<Boss>();
}
/** 击杀/周末结算只由boss.version守卫一次成功，盟贡钱包独立成员关系永久保留。 */
export async function processAllianceBosses(db:D1Database,now:number):Promise<void> {
  const due=(await db.prepare("SELECT * FROM alliance_bosses WHERE status='active' AND (remaining_hp=0 OR ends_at<=?) ORDER BY ends_at,id").bind(now).all<Boss>()).results;
  for(const boss of due) {
    const ranking=await rankingOf(db,boss.id),g=guard("EXISTS(SELECT 1 FROM alliance_bosses WHERE id=? AND version=? AND status='active' AND (remaining_hp=0 OR ends_at<=?))",[boss.id,boss.version,now]);
    const writes:ParameterizedQuery[]=[g.statement,{sql:"UPDATE alliance_bosses SET status='settled',version=version+1,settled_at=? WHERE id=?",params:[now,boss.id]}];
    for(const [index,rank]of ranking.entries()) {
      const merit=allianceMerit(index+1);if(merit===0)continue;
      writes.push({sql:'INSERT INTO alliance_boss_rewards(boss_id,sect_id,rank,merit,created_at) VALUES(?,?,?,?,?)',params:[boss.id,rank.sect_id,index+1,merit,now]},
        {sql:`INSERT INTO sect_alliance_wallets(sect_id,merit,version,updated_at) VALUES(?,?,1,?)
          ON CONFLICT(sect_id) DO UPDATE SET merit=merit+excluded.merit,version=version+1,updated_at=excluded.updated_at`,params:[rank.sect_id,merit,now]},
        {sql:'UPDATE alliance_members SET contribution=contribution+? WHERE sect_id=? AND alliance_id=?',params:[merit,rank.sect_id,boss.alliance_id]});
    }
    writes.push({sql:'DELETE FROM mutation_guards WHERE command_id=?',params:[g.id]});
    try{await db.batch(prepareStatements(db,writes));}
    catch(error){if(!(error instanceof Error&&/CHECK constraint failed|UNIQUE constraint failed/.test(error.message)))throw error;}
  }
}
async function panelOf(db:D1Database,d:Draft):Promise<AlliancePanel> {
  const [a,wallet,available,invites]=await Promise.all([
    membershipOf(db,d.sect.id),walletOf(db,d.sect.id),
    db.prepare(`SELECT a.id,a.name,a.member_limit,COUNT(m.sect_id) AS members FROM alliances a
      LEFT JOIN alliance_members m ON m.alliance_id=a.id WHERE a.dissolved_at IS NULL GROUP BY a.id ORDER BY a.created_at DESC LIMIT 50`).all<{id:string;name:string;member_limit:number;members:number}>(),
    db.prepare(`SELECT i.id,i.alliance_id,a.name,i.expires_at FROM alliance_invites i JOIN alliances a ON a.id=i.alliance_id
      WHERE i.target_sect_id=? AND i.accepted_at IS NULL AND i.expires_at>? AND a.dissolved_at IS NULL ORDER BY i.created_at DESC`).bind(d.sect.id,d.now).all<{id:string;alliance_id:string;name:string;expires_at:number}>(),
  ]);
  let summary:AllianceSummary|null=null,bossView:AlliancePanel['boss']=null;
  if(a) {
    const members=await membersOf(db,a.id),boss=await ensureBoss(db,a,members.length,d.now);
    summary={id:a.id,name:a.name,leaderSectId:a.leader_sect_id,members:members.map(m=>({sectId:m.sect_id,name:m.name,level:Number(m.level),contribution:Number(m.contribution),joinedAt:new Date(m.joined_at).toISOString()})),memberLimit:a.member_limit,active:members.length>=ALLIANCE_MIN_MEMBERS,isLeader:a.leader_sect_id===d.sect.id,version:a.version};
    if(boss) {
      const ranking=await rankingOf(db,boss.id),count=await db.prepare('SELECT COUNT(*) AS n FROM alliance_boss_hits WHERE sect_id=? AND date_key=?').bind(d.sect.id,dateKeyUtc8(d.now)).first<{n:number}>();
      const attacks=Number(count?.n??0),reason=boss.status==='settled'?'本周盟 BOSS 已结算':boss.remaining_hp<=0?'盟 BOSS 已被击败':members.length<ALLIANCE_MIN_MEMBERS?'仙盟至少需要三名成员':attacks>=ALLIANCE_DAILY_ATTACKS?'今日出手次数已用完':null;
      bossView={id:boss.id,name:'太古盟劫兽',weekKey:boss.week_key,maxHp:boss.max_hp,remainingHp:boss.remaining_hp,
        damage:Number(ranking.find(row=>row.sect_id===d.sect.id)?.damage??0),attacksToday:attacks,attackLimit:ALLIANCE_DAILY_ATTACKS,canAttack:reason===null,blockedReason:reason,endsAt:new Date(boss.ends_at).toISOString(),ranking:ranking.map((r,index)=>({sectId:r.sect_id,name:r.sect_name,damage:Number(r.damage),rank:index+1}))};
    }
  }
  const cosmetics=new Set((await db.prepare('SELECT cosmetic_id FROM sect_cosmetics WHERE sect_id=?').bind(d.sect.id).all<{cosmetic_id:string}>()).results.map(row=>row.cosmetic_id));
  return {alliance:summary,available:available.results.map(row=>({id:row.id,name:row.name,members:Number(row.members),memberLimit:row.member_limit,active:Number(row.members)>=ALLIANCE_MIN_MEMBERS})),invites:invites.results.map(row=>({id:row.id,allianceId:row.alliance_id,allianceName:row.name,expiresAt:new Date(row.expires_at).toISOString()})),boss:bossView,merit:wallet.merit,reputation:Number(d.sect.reputation),createCost:ALLIANCE_CREATE_COST,joinCooldownUntil:wallet.join_cooldown_until&&wallet.join_cooldown_until>d.now?new Date(wallet.join_cooldown_until).toISOString():null,
    shop:ALLIANCE_SHOP.map(item=>{const reason=item.reward.cosmetic&&cosmetics.has(item.reward.cosmetic.id)?'已拥有此头像框':wallet.merit<item.cost?'盟贡不足':null;return{id:item.id,name:item.name,cost:item.cost,description:item.reward.description,canBuy:reason===null,blockedReason:reason};})};
}
export async function getAlliance(db:D1Database,userId:string,now:number) {
  await processAllianceBosses(db,now);
  const d=await draftFor(db,userId,now,()=>1);if(d.hasJourneyReturns)await d.commit();
  return {state:d.view(),alliance:await panelOf(db,d)};
}
async function receiptOf(db:D1Database,sectId:string,commandId:string,fingerprint:string):Promise<{message:string}|null> {
  const row=await db.prepare('SELECT fingerprint,receipt_json FROM alliance_commands WHERE sect_id=? AND command_id=?').bind(sectId,commandId).first<{fingerprint:string;receipt_json:string}>();
  if(!row)return null;if(row.fingerprint!==fingerprint)throw new AppError('VALIDATION_ERROR','操作标识已用于另一项仙盟操作');return JSON.parse(row.receipt_json)as{message:string};
}
async function commitAction(db:D1Database,d:Draft,input:{commandId:string},fingerprint:string,result:{message:string},guards:Guard[]) {
  saveMetadata(d);
  d.addStatement({sql:'INSERT INTO alliance_commands(sect_id,command_id,fingerprint,receipt_json,created_at) VALUES(?,?,?,?,?)',params:[d.sect.id,input.commandId,fingerprint,JSON.stringify(result),d.now]});
  try{await d.commit({extraGuards:guards});}
  catch(error){const replay=await receiptOf(db,d.sect.id,input.commandId,fingerprint);if(replay)return replay;if(error instanceof Error&&/UNIQUE constraint failed/i.test(error.message))throw new AppError('INVALID_STATUS','仙盟状态已变化，请刷新重试');throw error;}
  return result;
}
export async function actAlliance(db:D1Database,userId:string,input:AllianceAction,now:number) {
  await processAllianceBosses(db,now);
  const fingerprint=JSON.stringify(Object.fromEntries(Object.entries(input).filter(([key])=>key!=='commandId').sort(([left],[right])=>left.localeCompare(right))));
  const d=await draftFor(db,userId,now),previous=await receiptOf(db,d.sect.id,input.commandId,fingerprint);
  if(previous)return {...await getAlliance(db,userId,now),result:previous};
  const [a,wallet]=await Promise.all([membershipOf(db,d.sect.id),walletOf(db,d.sect.id)]);
  const guards:Guard[]=[membershipGuard(d.sect.id,a),walletGuard(d.sect.id,wallet)];
  let message:string;
  if(input.action==='create') {
    if(a)throw new AppError('INVALID_STATUS','已经加入仙盟');
    if((wallet.join_cooldown_until??0)>now)throw new AppError('INVALID_STATUS','退盟后需等待24小时才能加入或创建仙盟');
    const name=normalizedAllianceName(input.name);if(!name)throw new AppError('VALIDATION_ERROR','仙盟名需为2至12字的单行名称');
    if(Number(d.sect.reputation)<ALLIANCE_CREATE_COST)throw new AppError('INSUFFICIENT_RESOURCE','创建仙盟需要声望1000');
    guards.push(guard('(SELECT reputation FROM sects WHERE id=?)=?',[d.sect.id,Number(d.sect.reputation)]));
    const id=crypto.randomUUID();
    d.addStatement({sql:'INSERT INTO alliances(id,name,leader_sect_id,member_limit,version,created_at,updated_at) VALUES(?,?,?,5,0,?,?)',params:[id,name,d.sect.id,now,now]});
    d.addStatement({sql:'INSERT INTO alliance_members(sect_id,alliance_id,joined_at) VALUES(?,?,?)',params:[d.sect.id,id,now]});
    d.addStatement({sql:'UPDATE sects SET reputation=reputation-? WHERE id=?',params:[ALLIANCE_CREATE_COST,d.sect.id]});
    writeWallet(d,d.sect.id,wallet);message=`已创建「${name}」，邀请至少两位掌门即可激活仙盟。`;
  }else if(input.action==='invite') {
    const alliance=requireLeader(d,a);
    const target=await db.prepare('SELECT id FROM sects WHERE id=?').bind(input.sectId).first();if(!target)throw new AppError('NOT_FOUND','目标宗门不存在');
    if(await membershipOf(db,input.sectId))throw new AppError('INVALID_STATUS','目标宗门已加入仙盟');
    if((await membersOf(db,alliance.id)).length>=ALLIANCE_MAX_MEMBERS)throw new AppError('INVALID_STATUS','仙盟成员已满');
    const invite=await db.prepare('SELECT id FROM alliance_invites WHERE alliance_id=? AND target_sect_id=? AND accepted_at IS NULL AND expires_at>?').bind(alliance.id,input.sectId,now).first();
    if(invite)throw new AppError('INVALID_STATUS','已向该宗门发出邀请');
    d.addStatement({sql:'INSERT INTO alliance_invites(id,alliance_id,target_sect_id,expires_at,created_at) VALUES(?,?,?,?,?)',params:[crypto.randomUUID(),alliance.id,input.sectId,now+ALLIANCE_INVITE_MS,now]});bumpAlliance(d,alliance);message='邀请已发出，七天内可接受。';
  }else if(input.action==='accept') {
    if(a)throw new AppError('INVALID_STATUS','已经加入仙盟');
    if((wallet.join_cooldown_until??0)>now)throw new AppError('INVALID_STATUS','退盟后需等待24小时才能加入仙盟');
    const invite=await db.prepare('SELECT * FROM alliance_invites WHERE id=? AND target_sect_id=?').bind(input.inviteId,d.sect.id).first<Invite>();
    if(!invite||invite.accepted_at!==null||invite.expires_at<=now)throw new AppError('INVALID_STATUS','邀请已失效');
    const alliance=await db.prepare('SELECT * FROM alliances WHERE id=? AND dissolved_at IS NULL').bind(invite.alliance_id).first<AllianceRow>();if(!alliance)throw new AppError('INVALID_STATUS','仙盟已解散');
    const members=await membersOf(db,alliance.id);if(members.length>=ALLIANCE_MAX_MEMBERS)throw new AppError('INVALID_STATUS','仙盟成员已满');
    guards.push(guard('EXISTS(SELECT 1 FROM alliances WHERE id=? AND version=? AND dissolved_at IS NULL) AND (SELECT COUNT(*) FROM alliance_members WHERE alliance_id=?)<? AND EXISTS(SELECT 1 FROM alliance_invites WHERE id=? AND target_sect_id=? AND accepted_at IS NULL AND expires_at>?)',[alliance.id,alliance.version,alliance.id,ALLIANCE_MAX_MEMBERS,invite.id,d.sect.id,now]));
    d.addStatement({sql:'INSERT INTO alliance_members(sect_id,alliance_id,joined_at) VALUES(?,?,?)',params:[d.sect.id,alliance.id,now]});
    d.addStatement({sql:'UPDATE alliance_invites SET accepted_at=? WHERE id=?',params:[now,invite.id]});writeWallet(d,d.sect.id,wallet);bumpAlliance(d,alliance);message=`已加入「${alliance.name}」。`;
  }else if(input.action==='leave'||input.action==='kick'||input.action==='transfer'||input.action==='disband') {
    if(!a)throw new AppError('INVALID_STATUS','尚未加入仙盟');
    const members=await membersOf(db,a.id);
    if(input.action!=='leave')requireLeader(d,a);
    if(input.action==='transfer') {
      if(input.sectId===d.sect.id||!members.some(m=>m.sect_id===input.sectId))throw new AppError('INVALID_STATUS','请选择仙盟内另一位掌门');
      d.addStatement({sql:'UPDATE alliances SET leader_sect_id=? WHERE id=?',params:[input.sectId,a.id]});bumpAlliance(d,a);message='已转让盟主。';
    }else {
      await requireMovable(db,a.id);guards.push(movableGuard(a.id));
      if(input.action==='disband'&&members.length!==1)throw new AppError('INVALID_STATUS','请先让其他成员退盟，最后一位掌门才能解散仙盟');
      if(input.action==='leave'&&a.leader_sect_id===d.sect.id&&members.length>1)throw new AppError('INVALID_STATUS','请先转让盟主再退盟');
      const target=input.action==='kick'?input.sectId:d.sect.id;
      if(input.action==='kick'&&(target===d.sect.id||!members.some(m=>m.sect_id===target)))throw new AppError('INVALID_STATUS','不能踢出此宗门');
      const targetWallet=target===d.sect.id?wallet:await walletOf(db,target);if(target!==d.sect.id)guards.push(walletGuard(target,targetWallet));
      d.addStatement({sql:'DELETE FROM alliance_members WHERE sect_id=? AND alliance_id=?',params:[target,a.id]});writeWallet(d,target,targetWallet,{cooldown:now+ALLIANCE_LEAVE_COOLDOWN_MS});
      if(members.length===1)d.addStatement({sql:'UPDATE alliances SET dissolved_at=? WHERE id=?',params:[now,a.id]});
      bumpAlliance(d,a);message=members.length===1?'仙盟已解散，盟贡保留。':input.action==='kick'?'已移出该宗门。':'已退出仙盟，盟贡保留，24小时后可再次入盟。';
    }
  }else if(input.action==='attack') {
    if(!a)throw new AppError('INVALID_STATUS','尚未加入仙盟');
    const members=await membersOf(db,a.id);if(members.length<ALLIANCE_MIN_MEMBERS)throw new AppError('INVALID_STATUS','至少三名成员才能挑战盟 BOSS');
    const boss=await ensureBoss(db,a,members.length,now);if(!boss||boss.status!=='active'||boss.remaining_hp<=0)throw new AppError('INVALID_STATUS','本周盟 BOSS 已结算');
    if(input.discipleIds.length<1||input.discipleIds.length>3||new Set(input.discipleIds).size!==input.discipleIds.length)throw new AppError('VALIDATION_ERROR','请选择一至三名不同弟子');
    const party=input.discipleIds.map(id=>d.discipleById(id));
    for(const member of party){
      requireCanFight(d,member,'讨伐盟 BOSS');
      if((member.injured_until??0)>now||(member.severe_injured_until??0)>now)throw new AppError('INVALID_STATUS',`${member.name}正在疗伤`);
      if(d.activeExploration&&(JSON.parse(d.activeExploration.party) as string[]).includes(member.id))throw new AppError('INVALID_STATUS',`${member.name}正在秘境探索中`);
      guards.push(guard(`EXISTS(SELECT 1 FROM disciples WHERE id=? AND sect_id=? AND realm_id=? AND stage=? AND talent=?
        AND attack=? AND defense=? AND speed=? AND gear_attack=? AND gear_defense=? AND gear_speed=? AND gear_power_bp=?
        AND beast_json IS ? AND ascension_level=? AND COALESCE(injured_until,0)<=? AND COALESCE(severe_injured_until,0)<=?
        AND COALESCE(capture_until,0)<=? AND COALESCE(steward_handover_until,0)<=?)
        AND NOT EXISTS(SELECT 1 FROM disciple_journeys WHERE disciple_id=? AND claimed_at IS NULL AND ends_at>?)
        AND NOT EXISTS(SELECT 1 FROM sect_stewards WHERE sect_id=? AND disciple_id=?)
        AND NOT EXISTS(SELECT 1 FROM world_sites WHERE holder_sect_id=? AND json_valid(garrison) AND EXISTS(SELECT 1 FROM json_each(garrison) WHERE value=?))
        AND NOT EXISTS(SELECT 1 FROM realm_explorations WHERE sect_id=? AND status='in_progress' AND json_valid(party) AND EXISTS(SELECT 1 FROM json_each(party) WHERE value=?))`,
        [member.id,d.sect.id,member.realm_id,member.stage,member.talent,member.attack,member.defense,member.speed,member.gear_attack,member.gear_defense,member.gear_speed,member.gear_power_bp,member.beast_json??null,member.ascension_level,now,now,now,now,member.id,now,d.sect.id,member.id,d.sect.id,member.id,d.sect.id,member.id]));
    }
    const count=await db.prepare('SELECT COUNT(*) AS n FROM alliance_boss_hits WHERE sect_id=? AND date_key=?').bind(d.sect.id,dateKeyUtc8(now)).first<{n:number}>();const used=Number(count?.n??0);
    if(used>=ALLIANCE_DAILY_ATTACKS)throw new AppError('DAILY_LIMIT','今日盟 BOSS 出手次数已用完');
    guards.push(guard("EXISTS(SELECT 1 FROM alliance_bosses WHERE id=? AND version=? AND status='active' AND remaining_hp=?) AND (SELECT COUNT(*) FROM alliance_boss_hits WHERE sect_id=? AND date_key=?)=?",[boss.id,boss.version,boss.remaining_hp,d.sect.id,dateKeyUtc8(now),used]));
    const damage=allianceBossDamage(party.map(gearedCombatPower),boss.remaining_hp);
    d.addStatement({sql:'INSERT INTO alliance_boss_hits(id,boss_id,alliance_id,sect_id,sect_name,date_key,damage,party,created_at) VALUES(?,?,?,?,?,?,?,?,?)',params:[crypto.randomUUID(),boss.id,a.id,d.sect.id,d.sect.name,dateKeyUtc8(now),damage,JSON.stringify(input.discipleIds),now]});
    d.addStatement({sql:'UPDATE alliance_bosses SET remaining_hp=remaining_hp-?,version=version+1 WHERE id=?',params:[damage,boss.id]});bumpAlliance(d,a);message=`向太古盟劫兽造成 ${String(damage)} 点伤害。`;
  }else if(input.action==='buy') {
    const def=ALLIANCE_SHOP.find(item=>item.id===input.id);if(!def)throw new AppError('VALIDATION_ERROR','未知盟贡商品');
    if(wallet.merit<def.cost)throw new AppError('INSUFFICIENT_RESOURCE','盟贡不足');
    if(def.reward.cosmetic&&await db.prepare('SELECT 1 AS n FROM sect_cosmetics WHERE sect_id=? AND cosmetic_id=?').bind(d.sect.id,def.reward.cosmetic.id).first())throw new AppError('INVALID_STATUS','已拥有此头像框');
    writeWallet(d,d.sect.id,wallet,{merit:wallet.merit-def.cost});await grantReward(db,d,def.reward,guards);message=`消耗盟贡 ${String(def.cost)}，获得${def.reward.description}。`;
  }else throw new AppError('VALIDATION_ERROR','未知仙盟操作');
  const result=await commitAction(db,d,input,fingerprint,{message},guards);
  return {...await getAlliance(db,userId,now),result};
}
export async function getAllianceChat(db:D1Database,userId:string,allianceId:string):Promise<{messages:AllianceChatMessage[]}> {
  const d=await draftFor(db,userId,Date.now(),()=>1);
  const rows=await db.prepare(`SELECT c.id,c.sect_name,c.content,c.user_id,c.created_at FROM chat_messages c
    JOIN alliance_members m ON m.sect_id=? AND m.alliance_id=c.scope_id JOIN alliances a ON a.id=m.alliance_id
    WHERE c.channel='alliance' AND c.scope_id=? AND a.dissolved_at IS NULL ORDER BY c.created_at DESC,c.id DESC LIMIT 50`).bind(d.sect.id,allianceId).all<{id:string;sect_name:string;content:string;user_id:string;created_at:number}>();
  const a=await membershipOf(db,d.sect.id);if(!a||a.id!==allianceId)throw new AppError('INVALID_STATUS','仙盟身份已变化，请重新打开仙盟频道');
  return {messages:rows.results.reverse().map(row=>({id:row.id,sectName:row.sect_name,content:row.content,isMe:row.user_id===userId,createdAt:new Date(row.created_at).toISOString()}))};
}
export async function sendAllianceChat(db:D1Database,userId:string,input:{allianceId:string;commandId:string;content:string},now:number) {
  const d=await draftFor(db,userId,now),a=await membershipOf(db,d.sect.id);
  if(!a||a.id!==input.allianceId)throw new AppError('INVALID_STATUS','仙盟身份已变化，请重新打开仙盟频道');
  const fingerprint=JSON.stringify({action:'chat',allianceId:input.allianceId,content:input.content}),previous=await receiptOf(db,d.sect.id,input.commandId,fingerprint);
  if(previous)return getAllianceChat(db,userId,input.allianceId);
  const content=input.content.trim();if(!content||[...content].length>200||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content))throw new AppError('VALIDATION_ERROR','请输入1至200字的消息');
  const latest=await db.prepare("SELECT MAX(created_at) AS at FROM chat_messages WHERE user_id=? AND channel='alliance'").bind(userId).first<{at:number|null}>();
  if(latest?.at&&now-latest.at<ALLIANCE_CHAT_COOLDOWN_MS)throw new AppError('INVALID_STATUS','发言太快，请稍后再试');
  const guards=[membershipGuard(d.sect.id,a),guard("COALESCE((SELECT MAX(created_at) FROM chat_messages WHERE user_id=? AND channel='alliance'),0)=?",[userId,latest?.at??0])];
  d.addStatement({sql:"INSERT INTO chat_messages(id,user_id,sect_name,content,created_at,channel,scope_id) VALUES(?,?,?,?,?,'alliance',?)",params:[crypto.randomUUID(),userId,d.sect.name,content,now,a.id]});
  await commitAction(db,d,input,fingerprint,{message:'已发送'},guards);
  return getAllianceChat(db,userId,input.allianceId);
}
