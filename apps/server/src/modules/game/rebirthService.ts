import type { RebirthAction, RebirthPanel } from '@xiuxian/contracts';
import { AppError } from '../../http/appError';
import type { ParameterizedQuery } from '../../infra/db/repository';
import { dateKeyUtc8 } from './constants';
import { draftFor, processWorldSites } from './service';
import { REBIRTH_BUILDING_CAPACITY, REBIRTH_DAO_YUN, REBIRTH_DISCIPLE_CAPACITY, REBIRTH_RESET, REBIRTH_RETAINED, REBIRTH_RETAIN_PERCENT, REBIRTH_SHOP, nextRebirthBonuses, rebirthBlockedReasons, rebirthRetainedAmount, rebirthShopViews, type RebirthActivities } from './rebirth';
import { rebirthSnapshotGuard } from './rebirthState';

type Draft = Awaited<ReturnType<typeof draftFor>>;
interface Purchase { item_id:string;quantity:number }
interface Receipt { fingerprint:string;receipt_json:string }
interface ActivityCheck { key:keyof RebirthActivities; sql:string;params:(string|number|null)[] }
function activityChecks(sectId:string,now:number):ActivityCheck[] {
  return [
    {key:'journeys',sql:'(SELECT COUNT(*) FROM disciple_journeys WHERE sect_id=? AND claimed_at IS NULL)',params:[sectId]},
    {key:'exploration',sql:"(SELECT COUNT(*) FROM realm_explorations WHERE sect_id=? AND status='in_progress')",params:[sectId]},
    {key:'captures',sql:"((SELECT COUNT(*) FROM beast_capture_sessions WHERE sect_id=? AND status='active' AND expires_at>?) + (SELECT COUNT(*) FROM disciples WHERE sect_id=? AND capture_until>?))",params:[sectId,now,sectId,now]},
    {key:'sites',sql:'(SELECT COUNT(*) FROM world_sites WHERE holder_sect_id=?)',params:[sectId]},
    {key:'auction',sql:`(SELECT COUNT(*) FROM auction_lots WHERE
      (seller_sect_id=? AND (status='active' OR (status='expired' AND seller_claimed_at IS NULL))) OR
      (bidder_sect_id=? AND (status='active' OR (status='sold' AND buyer_claimed_at IS NULL))))`,params:[sectId,sectId]},
    {key:'holdings',sql:'(SELECT COUNT(*) FROM stock_holdings WHERE sect_id=? AND (shares>0 OR cost>0))',params:[sectId]},
    {key:'orders',sql:"(SELECT COUNT(*) FROM stock_orders WHERE sect_id=? AND status='open')",params:[sectId]},
    {key:'margin',sql:'(SELECT COUNT(*) FROM stock_margin_positions WHERE sect_id=?)',params:[sectId]},
    {key:'races',sql:"(SELECT COUNT(*) FROM race_bets b JOIN race_rounds r ON r.id=b.round_id WHERE b.sect_id=? AND r.status='betting')",params:[sectId]},
  ];
}
function guard(sql:string,params:(string|number|null)[]):{id:string;statement:ParameterizedQuery} {
  const id=`${crypto.randomUUID()}:rebirth`;
  return {id,statement:{sql:`INSERT INTO mutation_guards(command_id,valid) SELECT ?,CASE WHEN ${sql} THEN 1 ELSE 0 END`,params:[id,...params]}};
}
async function activitiesOf(db:D1Database,d:Draft):Promise<RebirthActivities> {
  const checks=activityChecks(d.sect.id,d.now);
  const values=await db.prepare(`SELECT ${checks.map(check=>`${check.sql} AS ${check.key}`).join(',')}`).bind(...checks.flatMap(check=>check.params)).first<RebirthActivities>();
  return values ?? {journeys:0,exploration:0,captures:0,sites:0,auction:0,holdings:0,orders:0,margin:0,races:0};
}
async function purchasesOf(db:D1Database,sectId:string):Promise<Purchase[]> {
  return (await db.prepare('SELECT item_id,quantity FROM rebirth_purchases WHERE sect_id=?').bind(sectId).all<Purchase>()).results;
}
async function panelOf(db:D1Database,d:Draft):Promise<RebirthPanel> {
  const [activities,purchases]=await Promise.all([activitiesOf(db,d),purchasesOf(db,d.sect.id)]);
  const r=d.rebirth;
  const bonuses={productionBp:r.bonus_production_bp,breakthroughBp:r.bonus_breakthrough_bp,powerBp:r.bonus_power_bp};
  const blockedReasons=rebirthBlockedReasons(Number(d.sect.level),d.disciples.filter(row=>Number(row.ascension_level)>0).length,activities);
  return {cycle:r.cycle,daoYun:r.dao_yun,version:r.version,eligible:blockedReasons.length===0,blockedReasons,
    gainDaoYun:REBIRTH_DAO_YUN,retainPercent:REBIRTH_RETAIN_PERCENT,bonuses,nextBonuses:nextRebirthBonuses(bonuses),
    discipleCapacityFloor:Math.max(REBIRTH_DISCIPLE_CAPACITY,r.disciple_capacity_floor),buildingCapacityFloor:Math.max(REBIRTH_BUILDING_CAPACITY,r.building_capacity_floor),
    previewResources:d.balances.map(row=>({id:row.resource_id,name:d.resourceName(row.resource_id),before:String(row.balance),after:String(rebirthRetainedAmount(Number(row.balance)))})),
    retained:[...REBIRTH_RETAINED],reset:[...REBIRTH_RESET],shop:rebirthShopViews(r.dao_yun,new Map(purchases.map(row=>[row.item_id,Number(row.quantity)])))};
}
export async function getRebirth(db:D1Database,userId:string,now:number) {
  const d=await draftFor(db,userId,now,()=>1);
  if (d.hasJourneyReturns) await d.commit();
  return {state:d.view(),rebirth:await panelOf(db,d)};
}
async function receiptOf(db:D1Database,sectId:string,commandId:string,fingerprint:string):Promise<{message:string}|null> {
  const row=await db.prepare('SELECT fingerprint,receipt_json FROM rebirth_commands WHERE sect_id=? AND command_id=?').bind(sectId,commandId).first<Receipt>();
  if(!row)return null;
  if(row.fingerprint!==fingerprint)throw new AppError('VALIDATION_ERROR','操作标识已用于另一项开界操作');
  return JSON.parse(row.receipt_json) as {message:string};
}
function saveMetadata(d:Draft) {
  const r=d.rebirth;
  r.version+=1;
  d.addStatement({sql:`INSERT INTO sect_rebirth(sect_id,cycle,dao_yun,bonus_production_bp,bonus_breakthrough_bp,bonus_power_bp,
    disciple_capacity_floor,building_capacity_floor,version,last_rebirth_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(sect_id) DO UPDATE SET cycle=excluded.cycle,dao_yun=excluded.dao_yun,bonus_production_bp=excluded.bonus_production_bp,
    bonus_breakthrough_bp=excluded.bonus_breakthrough_bp,bonus_power_bp=excluded.bonus_power_bp,
    disciple_capacity_floor=excluded.disciple_capacity_floor,building_capacity_floor=excluded.building_capacity_floor,
    version=excluded.version,last_rebirth_at=excluded.last_rebirth_at,updated_at=excluded.updated_at`,params:[d.sect.id,r.cycle,r.dao_yun,r.bonus_production_bp,r.bonus_breakthrough_bp,r.bonus_power_bp,r.disciple_capacity_floor,r.building_capacity_floor,r.version,r.last_rebirth_at,d.now,d.now]});
  // 成长版本也是全局旧战斗/旧结算的守卫，转生与兑换均必须推进。
  d.progression.version+=1;
  const p=d.progression;
  d.addStatement({sql:`INSERT INTO sect_progression(sect_id,version,production_bonus_bp,rename_tokens,equipped_frame,equipped_title,updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(sect_id) DO UPDATE SET version=excluded.version,updated_at=excluded.updated_at`,params:[d.sect.id,p.version,p.production_bonus_bp,p.rename_tokens,p.equipped_frame,p.equipped_title,d.now]});
}
export async function actRebirth(db:D1Database,userId:string,input:RebirthAction,now:number) {
  // 新永久产出加成取得前，已有整点仍用旧加成；此后重新读取资源快照。
  if(input.action==='rebirth'||input.id==='bonus-production')await processWorldSites(db,now,true);
  const d=await draftFor(db,userId,now);
  const fingerprint=JSON.stringify({action:input.action,id:input.action==='buy'?input.id:null,expectedVersion:input.expectedVersion});
  const previous=await receiptOf(db,d.sect.id,input.commandId,fingerprint);
  if(previous)return {...await getRebirth(db,userId,now),result:previous};
  if(input.expectedVersion!==d.rebirth.version)throw new AppError('INVALID_STATUS','开界状态已变化，请刷新后重试');
  const metadataId=`${crypto.randomUUID()}:rebirth-version`;
  const guards=[{id:metadataId,statement:rebirthSnapshotGuard(metadataId,d.sect.id,{...d.rebirth})}];
  let message:string;
  if(input.action==='rebirth') {
    const panel=await panelOf(db,d);
    if(!panel.eligible)throw new AppError('INVALID_STATUS',panel.blockedReasons.join(' '));
    const checks=activityChecks(d.sect.id,now);
    guards.push(guard(checks.map(check=>`${check.sql}=0`).join(' AND '),checks.flatMap(check=>check.params)));
    guards.push(guard("EXISTS(SELECT 1 FROM sects WHERE id=? AND level=15) AND EXISTS(SELECT 1 FROM disciples WHERE sect_id=? AND ascension_level>=1)",[d.sect.id,d.sect.id]));
    // 成仙/保底不在通用结算守卫中，逐批检查原值，避免与渡劫并发覆盖。
    for(let start=0;start<d.disciples.length;start+=15) {
      const members=d.disciples.slice(start,start+15);
      guards.push(guard(members.map(()=> 'EXISTS(SELECT 1 FROM disciples WHERE id=? AND sect_id=? AND ascension_level=? AND ascension_pity=?)').join(' AND '),members.flatMap(row=>[row.id,d.sect.id,Number(row.ascension_level),Number(row.ascension_pity)])));
    }
    for(const row of d.balances) {
      const after=rebirthRetainedAmount(Number(row.balance));
      // 草稿已先结算旧时段；此相对扣减紧跟结算写回，同批只折损一次。
      d.addResource(row.resource_id,after-Number(row.balance));
      d.addStatement({sql:'UPDATE resource_balances SET remainder=0 WHERE sect_id=? AND resource_id=?',params:[d.sect.id,row.resource_id]});
    }
    d.addStatement({sql:`UPDATE disciples SET realm_id='qiRefining',stage=1,cultivation=0,cultivation_remainder=0,
      ascension_level=0,ascension_pity=0,assignment='idle',injured_until=NULL,severe_injured_until=NULL,
      capture_until=NULL,steward_handover_until=NULL WHERE sect_id=?`,params:[d.sect.id]});
    d.addStatement({sql:'UPDATE sects SET level=1,defense_lineup=NULL,last_settled_at=? WHERE id=?',params:[now,d.sect.id]});
    d.addStatement({sql:'UPDATE sect_stewards SET disciple_id=NULL,updated_at=? WHERE sect_id=?',params:[now,d.sect.id]});
    d.addStatement({sql:"UPDATE world_boss_auto_settings SET enabled=0,lock_until=0,pause_reason='开辟新界后已暂停自动讨伐',updated_at=? WHERE sect_id=?",params:[now,d.sect.id]});
    d.addStatement({sql:'DELETE FROM arena_entries WHERE sect_id=? AND date_key=?',params:[d.sect.id,dateKeyUtc8(now)]});
    d.addStatement({sql:"UPDATE beast_capture_sessions SET status='expired',version=version+1,updated_at=? WHERE sect_id=? AND status='active'",params:[now,d.sect.id]});
    const next=nextRebirthBonuses({productionBp:d.rebirth.bonus_production_bp,breakthroughBp:d.rebirth.bonus_breakthrough_bp,powerBp:d.rebirth.bonus_power_bp});
    d.rebirth.cycle+=1;d.rebirth.dao_yun+=REBIRTH_DAO_YUN;d.rebirth.last_rebirth_at=now;
    d.rebirth.bonus_production_bp=next.productionBp;d.rebirth.bonus_breakthrough_bp=next.breakthroughBp;d.rebirth.bonus_power_bp=next.powerBp;
    d.rebirth.disciple_capacity_floor=Math.max(d.rebirth.disciple_capacity_floor,REBIRTH_DISCIPLE_CAPACITY,d.disciples.length);
    d.rebirth.building_capacity_floor=Math.max(d.rebirth.building_capacity_floor,REBIRTH_BUILDING_CAPACITY,d.buildings.length);
    message=`已开辟第 ${String(d.rebirth.cycle+1)} 周目，获得道韵 ${String(REBIRTH_DAO_YUN)}；全资源产出 +10%、突破成功率 +5%、全弟子战力 +5%。`;
  } else {
    const def=REBIRTH_SHOP.find(item=>item.id===input.id);
    if(!def)throw new AppError('VALIDATION_ERROR','未知道韵商品');
    const purchases=await purchasesOf(db,d.sect.id);
    const purchased=Number(purchases.find(item=>item.item_id===def.id)?.quantity??0);
    if(purchased>=def.limit)throw new AppError('INVALID_STATUS','此道韵商品已达到兑换上限');
    if(d.rebirth.dao_yun<def.cost)throw new AppError('INSUFFICIENT_RESOURCE','道韵不足');
    guards.push(guard('COALESCE((SELECT quantity FROM rebirth_purchases WHERE sect_id=? AND item_id=?),0)=?',[d.sect.id,def.id,purchased]));
    d.rebirth.dao_yun-=def.cost;
    d.addStatement({sql:`INSERT INTO rebirth_purchases(sect_id,item_id,quantity,updated_at) VALUES(?,?,1,?)
      ON CONFLICT(sect_id,item_id) DO UPDATE SET quantity=quantity+1,updated_at=excluded.updated_at`,params:[d.sect.id,def.id,now]});
    if(def.cosmetic)d.addStatement({sql:'INSERT INTO sect_cosmetics(sect_id,cosmetic_id,kind,name,created_at) VALUES(?,?,?,?,?)',params:[d.sect.id,def.cosmetic.id,def.cosmetic.kind,def.cosmetic.name,now]});
    if(def.bonus==='productionBp')d.rebirth.bonus_production_bp+=100;
    if(def.bonus==='breakthroughBp')d.rebirth.bonus_breakthrough_bp+=100;
    if(def.bonus==='powerBp')d.rebirth.bonus_power_bp+=100;
    message=`消耗道韵 ${String(def.cost)}，兑换${def.name}。`;
  }
  saveMetadata(d);
  const result={message};
  d.addStatement({sql:'INSERT INTO rebirth_commands(sect_id,command_id,fingerprint,receipt_json,created_at) VALUES(?,?,?,?,?)',params:[d.sect.id,input.commandId,fingerprint,JSON.stringify(result),now]});
  try {await d.commit({extraGuards:guards});}
  catch(error) {
    const replay=await receiptOf(db,d.sect.id,input.commandId,fingerprint);
    if(replay)return {...await getRebirth(db,userId,now),result:replay};
    if(error instanceof Error&&/UNIQUE constraint failed/i.test(error.message))throw new AppError('INVALID_STATUS','开界状态已变化，请刷新后重试');
    throw error;
  }
  return {...await getRebirth(db,userId,now),result};
}
