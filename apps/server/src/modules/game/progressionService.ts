import type { ProgressionAction, ProgressionCosmetic, ProgressionPanel, ProgressionReward } from '@xiuxian/contracts';
import { AppError } from '../../http/appError';
import type { ParameterizedQuery } from '../../infra/db/repository';
import { dateKeyUtc8, realmIndex } from './constants';
import { BAG_CAPACITY, generateEquipment, type EquipmentSlot } from './equipment';
import { addTechniqueScrollsStatement, insertEquipmentStatement, techniqueGuardStatement } from './repository';
import { draftFor, processWorldSites } from './service';
import { TECHNIQUES } from './techniques';
import { MAKEUP_COST, QUESTS, RISING_STAR_BONUS_BP, achievementViews, checkinReward, checkinView, dayDistance, questViews, reputationShopViews, type CheckinRow, type ProgressionFacts } from './progression';

type Draft = Awaited<ReturnType<typeof draftFor>>;
interface QuestRow { completed: string; version: number }
interface CosmeticRow { cosmetic_id: string; kind: 'frame' | 'title'; name: string }
interface Receipt { fingerprint: string; receipt_json: string }
interface ProgressionData {
  checkin: CheckinRow | null; achievements: { achievement_id: string; progress: number; claimed: number }[];
  quests: QuestRow | null; cosmetics: CosmeticRow[]; purchases: { item_id: string; quantity: number }[];
  facts: ProgressionFacts;
  questFacts: ProgressionFacts;
}
const parseIds = (value: string | undefined): string[] => {
  if (!value) return [];
  try { const data: unknown = JSON.parse(value); return Array.isArray(data) ? data.filter((id): id is string => typeof id === 'string') : []; }
  catch { return []; }
};
function guard(sql: string, params: (string | number | null)[]): { id: string; statement: ParameterizedQuery } {
  const id = `${crypto.randomUUID()}:growth`;
  return { id, statement: { sql: `INSERT INTO mutation_guards(command_id,valid) SELECT ?, CASE WHEN ${sql} THEN 1 ELSE 0 END`, params: [id, ...params] } satisfies ParameterizedQuery };
}
/** Retained records are authoritative; no attempt to invent already-cleared history. */
async function factsOf(db: D1Database, d: Draft): Promise<ProgressionFacts> {
  const s = d.sect.id;
  const stats = await db.prepare(`SELECT
    COALESCE((SELECT max_floor FROM sect_towers WHERE sect_id=?),0) AS tower,
    COALESCE((SELECT SUM(damage) FROM world_boss_hits WHERE sect_id=?),0) AS bossDamage,
    (SELECT COUNT(*) FROM arena_rewards WHERE sect_id=? AND rank=1) AS champion,
    (SELECT COUNT(*) FROM beast_collection WHERE sect_id=? AND (seen_count>0 OR caught_count>0)) AS collection,
    (SELECT COUNT(*) FROM beast_collection WHERE sect_id=? AND best_quality='immortal') AS immortalBeast,
    (SELECT COUNT(*) FROM auction_lots WHERE status='sold' AND (seller_sect_id=? OR bidder_sect_id=?)) AS auctions,
    COALESCE((SELECT SUM(CASE WHEN json_valid(reward_detail) THEN COALESCE(json_extract(reward_detail,'$.counts.jackpot'),0) ELSE 0 END)
      FROM dao_debate_log WHERE sect_id=? AND bet_mode='stone' AND json_valid(stake_detail) AND json_extract(stake_detail,'$.tier')='meteor'),0) AS meteorJackpot,
    (COALESCE((SELECT SUM(profit) FROM stock_trades WHERE sect_id=? AND side='sell'),0)+COALESCE((SELECT SUM(CASE WHEN action='open' THEN -fee ELSE pnl END) FROM stock_margin_trades WHERE sect_id=?),0))/1000.0 AS stockProfit,
    COALESCE((SELECT value FROM sect_achievement_counters WHERE sect_id=? AND stat_id='tribute'),0)/1000.0 AS tribute,
    (SELECT COUNT(*) FROM event_log WHERE sect_id=? AND event_id='progressionCraftPill') AS alchemy,
    ((SELECT COUNT(*) FROM equipment WHERE sect_id=? AND source='forge')+(SELECT COUNT(*) FROM event_log WHERE sect_id=? AND event_id='progressionForgeEquipment')) AS forge,
    ((SELECT COUNT(*) FROM explorations WHERE sect_id=? AND success=1)+(SELECT COUNT(*) FROM realm_explorations WHERE sect_id=? AND status='completed')) AS explorations,
    (SELECT COUNT(*) FROM challenge_log WHERE attacker_sect_id=?) AS challenges,
    (SELECT COUNT(*) FROM world_boss_hits WHERE sect_id=?) AS bossHits,
    ((SELECT COUNT(*) FROM stock_trades WHERE sect_id=?)+(SELECT COUNT(*) FROM stock_margin_trades WHERE sect_id=?)) AS stockTrades
  `).bind(s,s,s,s,s,s,s,s,s,s,s,s,s,s,s,s,s,s,s,s).first<Record<string, number>>();
  const actual = stats ?? {};
  return {
    sectLevel: Number(d.sect.level), disciples: d.disciples.length,
    realmIndex: Math.max(0, ...d.disciples.map(row => realmIndex(row.realm_id))),
    ascended: d.disciples.filter(row => Number(row.ascension_level ?? 0) >= 1).length,
    tower: Number(actual.tower ?? 0), bossDamage: Number(actual.bossDamage ?? 0), champion: Number(actual.champion ?? 0),
    collection: Number(actual.collection ?? 0), immortalBeast: Number(actual.immortalBeast ?? 0),
    techniques: d.techniques.filter(row => Number(row.level) > 0).length,
    auctions: Number(actual.auctions ?? 0), meteorJackpot: Number(actual.meteorJackpot ?? 0), stockProfit: Math.max(0, Number(actual.stockProfit ?? 0)),
    ancestral: d.worldSites.filter(row => row.id === 'center-xuantie' || row.id === 'center-shenmu').length,
    tribute: Number(actual.tribute ?? 0), created: 1,
    assigned: d.disciples.filter(row => row.assignment !== 'idle').length,
    breakthrough: d.disciples.some(row => realmIndex(row.realm_id) > 0 || Number(row.stage) > 1) ? 1 : 0,
    // 库存行即使已服尽仍保留；上线前无炼丹日志，以持有过丹药的库存行兼容。
    alchemy: Math.max(Number(actual.alchemy ?? 0), d.pillInventories.length > 0 ? 1 : 0),
    forge: Number(actual.forge ?? 0), explorations: Number(actual.explorations ?? 0),
    challenges: Number(actual.challenges ?? 0), bossHits: Number(actual.bossHits ?? 0), stockTrades: Number(actual.stockTrades ?? 0), sites: d.worldSites.length,
  };
}
async function loadData(db: D1Database, d: Draft): Promise<ProgressionData> {
  const s = d.sect.id;
  const [checkin, achievements, quests, cosmetics, purchases, steps, facts] = await Promise.all([
    db.prepare('SELECT * FROM sect_checkin WHERE sect_id=?').bind(s).first<CheckinRow>(),
    db.prepare('SELECT achievement_id,progress,claimed FROM sect_achievements WHERE sect_id=?').bind(s).all<{ achievement_id: string; progress: number; claimed: number }>(),
    db.prepare('SELECT completed,version FROM sect_quests WHERE sect_id=?').bind(s).first<QuestRow>(),
    db.prepare('SELECT cosmetic_id,kind,name FROM sect_cosmetics WHERE sect_id=? ORDER BY created_at,cosmetic_id').bind(s).all<CosmeticRow>(),
    db.prepare('SELECT item_id,quantity FROM sect_reputation_purchases WHERE sect_id=?').bind(s).all<{ item_id: string; quantity: number }>(),
    db.prepare('SELECT step_id FROM sect_quest_steps WHERE sect_id=?').bind(s).all<{ step_id: string }>(), factsOf(db,d),
  ]);
  const saved = new Set(steps.results.map(row => row.step_id));
  const newlyCompleted = QUESTS.flatMap(chapter => chapter.steps.filter(step => facts[step.fact] >= step.target && !saved.has(`${chapter.id}:${step.id}`)).map(step => `${chapter.id}:${step.id}`));
  // 并发读只追加唯一事实，不改元数据version、不写绝对进度、不发奖。
  if (newlyCompleted.length > 0) await db.batch(newlyCompleted.map(id => db.prepare('INSERT OR IGNORE INTO sect_quest_steps(sect_id,step_id,completed_at) VALUES(?,?,?)').bind(s,id,d.now)));
  const questFacts = { ...facts };
  for (const chapter of QUESTS) for (const step of chapter.steps) if (saved.has(`${chapter.id}:${step.id}`)) questFacts[step.fact] = Math.max(questFacts[step.fact],step.target);
  // 只保存观测到的最高成就进度；原始事实与主线事实严格分离。
  const observed = achievementViews(facts,new Set());
  const progressWrites = observed.filter(item => item.progress > Number(achievements.results.find(row => row.achievement_id === item.id)?.progress ?? 0));
  if (progressWrites.length > 0) await db.batch(progressWrites.map(item => db.prepare(`INSERT INTO sect_achievements(sect_id,achievement_id,progress,claimed,updated_at)
    VALUES(?,?,?,0,?) ON CONFLICT(sect_id,achievement_id) DO UPDATE SET progress=MAX(progress,excluded.progress),updated_at=excluded.updated_at`).bind(s,item.id,Math.floor(item.progress),d.now)));
  return { checkin, achievements: achievements.results, quests, cosmetics: cosmetics.results, purchases: purchases.results, facts, questFacts };
}
function panelOf(d: Draft, data: ProgressionData): ProgressionPanel {
  return { checkin: checkinView(data.checkin,d.now,d.sect.created_at,d.balanceOf('spiritStone')),
    achievements: achievementViews(data.facts,new Set(data.achievements.filter(row => row.claimed === 1).map(row => row.achievement_id))).map(item => {
      const progress = item.claimed ? item.target : Math.min(item.target,Math.max(item.progress,Number(data.achievements.find(row => row.achievement_id === item.id)?.progress ?? 0)));
      return { ...item, progress, completed: progress >= item.target };
    }),
    quests: questViews(data.questFacts,new Set(parseIds(data.quests?.completed))), reputation: Number(d.sect.reputation),
    reputationShop: reputationShopViews(Number(d.sect.reputation),new Map(data.purchases.map(row => [row.item_id,Number(row.quantity)])),d.now),
    cosmetics: data.cosmetics.map(row => ({ id: row.cosmetic_id, kind: row.kind, name: row.name })),
    equippedFrame: d.progression.equipped_frame, equippedTitle: d.progression.equipped_title,
    productionBonusBp: d.progression.production_bonus_bp, renameTokens: d.progression.rename_tokens };
}
export async function getProgression(db: D1Database, userId: string, now: number) {
  const d = await draftFor(db,userId,now,() => 1);
  // 只读预览不掷离线事件；已经到期的历练归队必须持久化。
  if (d.hasJourneyReturns) await d.commit();
  return { state: d.view(), progression: panelOf(d,await loadData(db,d)) };
}
async function receiptOf(db: D1Database, sectId: string, commandId: string, fingerprint: string): Promise<{ message: string } | null> {
  const row = await db.prepare('SELECT fingerprint,receipt_json FROM progression_commands WHERE sect_id=? AND command_id=?').bind(sectId,commandId).first<Receipt>();
  if (!row) return null;
  if (row.fingerprint !== fingerprint) throw new AppError('VALIDATION_ERROR','操作标识已用于另一项成长操作');
  return JSON.parse(row.receipt_json) as { message: string };
}
export async function grantReward(db: D1Database, d: Draft, reward: ProgressionReward, guards: ReturnType<typeof guard>[]) {
  for (const [id,amount] of Object.entries(reward.resources ?? {})) {
    if (!d.balances.some(row => row.resource_id === id)) throw new AppError('INVALID_STATUS',`${d.resourceName(id)}尚未初始化，请完成数据库迁移`);
    d.addResource(id,Number(amount));
  }
  for (const [pillId,quantity] of Object.entries(reward.pills ?? {})) {
    guards.push(guard('COALESCE((SELECT quantity FROM pill_inventories WHERE sect_id=? AND pill_id=?),0)=?', [d.sect.id,pillId,d.basePillQuantity(pillId)]));
    d.addPill(pillId,quantity);
  }
  if (reward.reputation) {
    d.sect.reputation += reward.reputation;
    d.addStatement({ sql: 'UPDATE sects SET reputation=reputation+? WHERE id=?', params: [reward.reputation,d.sect.id] });
  }
  if (reward.scrolls) {
    const pool = TECHNIQUES.filter(row => row.tier === reward.scrolls?.tier), def = pool[Math.min(pool.length-1,Math.floor(Math.random()*pool.length))]!;
    const row = d.techniques.find(item => item.technique_id === def.id), id = `${crypto.randomUUID()}:scroll`;
    guards.push({ id, statement: techniqueGuardStatement(id,{sectId:d.sect.id,techniqueId:def.id,level:row?.level ?? 0,scrolls:row?.scrolls ?? 0}) });
    d.addStatement(addTechniqueScrollsStatement(d.sect.id,def.id,reward.scrolls.quantity));
    d.setTechnique({sect_id:d.sect.id,technique_id:def.id,level:row?.level ?? 0,scrolls:Number(row?.scrolls ?? 0)+reward.scrolls.quantity});
  }
  if (reward.cosmetic) {
    const c = reward.cosmetic;
    d.addStatement({sql:'INSERT INTO sect_cosmetics(sect_id,cosmetic_id,kind,name,created_at) VALUES(?,?,?,?,?)',params:[d.sect.id,c.id,c.kind,c.name,d.now]});
  }
  if (reward.renameToken) d.progression.rename_tokens += reward.renameToken;
  if (reward.equipmentBox) {
    const count = await db.prepare('SELECT COUNT(*) AS n FROM equipment WHERE sect_id=? AND disciple_id IS NULL').bind(d.sect.id).first<{n:number}>();
    const n = Number(count?.n ?? 0);
    if (n >= BAG_CAPACITY) throw new AppError('INVALID_STATUS','背包已满，请腾出一格再领取仙品装备箱');
    guards.push(guard('(SELECT COUNT(*) FROM equipment WHERE sect_id=? AND disciple_id IS NULL)=?',[d.sect.id,n]));
    const slot = (['weapon','armor','artifact'] as const)[Math.floor(Math.random()*3)] as EquipmentSlot;
    const generated = generateEquipment({slot,quality:'immortal',mainAttr:slot === 'weapon' ? 'attack' : slot === 'armor' ? 'defense' : 'speed',random:Math.random});
    d.addStatement(insertEquipmentStatement({id:crypto.randomUUID(),sectId:d.sect.id,...generated,source:'quest',now:d.now}));
  }
}
export function saveMetadata(d: Draft) {
  d.progression.version += 1;
  const p = d.progression;
  d.addStatement({ sql: `INSERT INTO sect_progression(sect_id,version,production_bonus_bp,rename_tokens,equipped_frame,equipped_title,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(sect_id) DO UPDATE SET version=excluded.version,production_bonus_bp=excluded.production_bonus_bp,
    rename_tokens=excluded.rename_tokens,equipped_frame=excluded.equipped_frame,equipped_title=excluded.equipped_title,updated_at=excluded.updated_at`,
    params:[d.sect.id,p.version,p.production_bonus_bp,p.rename_tokens,p.equipped_frame,p.equipped_title,d.now] });
}
export async function actProgression(db: D1Database, userId: string, input: ProgressionAction, now: number) {
  // 购买永久加成先按旧速率结算山河已到期的整点，之后再取得消费快照。
  if (input.action === 'buy-reputation' && input.id === 'title-rising-star') await processWorldSites(db,now,true);
  const d = await draftFor(db,userId,now);
  const fingerprint = JSON.stringify({action:input.action,id:'id' in input ? input.id : null});
  const previous = await receiptOf(db,d.sect.id,input.commandId,fingerprint);
  if (previous) return { ...await getProgression(db,userId,now), result: previous };
  const data = await loadData(db,d), panel = panelOf(d,data), guards: ReturnType<typeof guard>[] = [];
  // 声望可被既有挑战代码修改，不仅依赖成长元数据version。
  guards.push(guard('(SELECT reputation FROM sects WHERE id=?)=?',[d.sect.id,Number(d.sect.reputation)]));
  let message: string;
  if (input.action === 'checkin' || input.action === 'makeup') {
    const makeup = input.action === 'makeup', today = dateKeyUtc8(now), row = data.checkin;
    if (!makeup && panel.checkin.checkedToday) throw new AppError('INVALID_STATUS','今日已签到');
    if (makeup && !panel.checkin.canMakeup) throw new AppError('INVALID_STATUS',panel.checkin.blockedReason ?? '当前不能补签');
    const targetDate = makeup ? panel.checkin.makeupDate! : today;
    const streak = row?.last_checkin_date && dayDistance(row.last_checkin_date,targetDate) === 1 ? Number(row.streak)+1 : 1;
    const reward = checkinReward(streak,Math.random);
    if (makeup) d.requireResource('spiritStone',MAKEUP_COST);
    const version = Number(row?.version ?? 0);
    guards.push(guard('COALESCE((SELECT version FROM sect_checkin WHERE sect_id=?),0)=?',[d.sect.id,version]));
    d.addStatement({sql:'INSERT INTO sect_checkin_days(sect_id,date_key,streak,makeup,created_at) VALUES(?,?,?,?,?)',params:[d.sect.id,targetDate,streak,makeup?1:0,now]});
    d.addStatement({sql:`INSERT INTO sect_checkin(sect_id,streak,month_key,total_days,last_checkin_date,makeup_used,version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(sect_id) DO UPDATE SET streak=excluded.streak,month_key=excluded.month_key,total_days=excluded.total_days,
      last_checkin_date=excluded.last_checkin_date,makeup_used=excluded.makeup_used,version=excluded.version,updated_at=excluded.updated_at`,
      params:[d.sect.id,streak,today.slice(0,7),Number(row?.total_days ?? 0)+1,targetDate,panel.checkin.makeupUsed+(makeup?1:0),version+1,row?.created_at ?? now,now]});
    await grantReward(db,d,reward,guards);
    message = `${makeup?'补签':'签到'} ${targetDate}，连续 ${String(streak)} 天，获得${reward.description}`;
  } else if (input.action === 'claim-achievement') {
    const achievement = panel.achievements.find(row => row.id === input.id);
    if (!achievement) throw new AppError('VALIDATION_ERROR','未知成就');
    if (achievement.claimed) throw new AppError('INVALID_STATUS','此成就奖励已领取');
    if (!achievement.completed) throw new AppError('INVALID_STATUS','成就尚未完成');
    d.addStatement({sql:`INSERT INTO sect_achievements(sect_id,achievement_id,progress,claimed,claimed_at,updated_at) VALUES(?,?,?,1,?,?)
      ON CONFLICT(sect_id,achievement_id) DO UPDATE SET progress=excluded.progress,claimed=1,claimed_at=excluded.claimed_at,updated_at=excluded.updated_at`,params:[d.sect.id,input.id,achievement.target,now,now]});
    await grantReward(db,d,achievement.reward,guards); message = `领取「${achievement.name}」：${achievement.reward.description}`;
  } else if (input.action === 'claim-quest') {
    const quest = panel.quests.find(row => row.id === input.id);
    if (!quest) throw new AppError('VALIDATION_ERROR','未知主线章节');
    if (quest.claimed) throw new AppError('INVALID_STATUS','本章奖励已领取');
    if (!quest.unlocked || !quest.completed) throw new AppError('INVALID_STATUS','请先完成并领取前置章节及本章全部步骤');
    const completed = [...parseIds(data.quests?.completed),quest.id], index = QUESTS.findIndex(row => row.id === quest.id);
    guards.push(guard('COALESCE((SELECT version FROM sect_quests WHERE sect_id=?),0)=?',[d.sect.id,Number(data.quests?.version ?? 0)]));
    d.addStatement({sql:`INSERT INTO sect_quests(sect_id,chapter_id,step_index,completed,version,updated_at) VALUES(?,?,0,?,?,?)
      ON CONFLICT(sect_id) DO UPDATE SET chapter_id=excluded.chapter_id,step_index=0,completed=excluded.completed,version=excluded.version,updated_at=excluded.updated_at`,
      params:[d.sect.id,QUESTS[index+1]?.id ?? 'complete',JSON.stringify(completed),Number(data.quests?.version ?? 0)+1,now]});
    await grantReward(db,d,quest.reward,guards); message = `完成${quest.name}，获得${quest.reward.description}`;
  } else if (input.action === 'buy-reputation') {
    const item = panel.reputationShop.find(row => row.id === input.id);
    if (!item) throw new AppError('VALIDATION_ERROR','未知声望商品');
    if (!item.canBuy) throw new AppError('INVALID_STATUS',item.blockedReason ?? '当前无法兑换');
    d.sect.reputation -= item.cost;
    d.addStatement({sql:'UPDATE sects SET reputation=reputation-? WHERE id=?',params:[item.cost,d.sect.id]});
    d.addStatement({sql:`INSERT INTO sect_reputation_purchases(sect_id,item_id,quantity,updated_at) VALUES(?,?,1,?)
      ON CONFLICT(sect_id,item_id) DO UPDATE SET quantity=quantity+1,updated_at=excluded.updated_at`,params:[d.sect.id,item.id,now]});
    if (item.id === 'title-rising-star') d.progression.production_bonus_bp = Math.max(d.progression.production_bonus_bp,RISING_STAR_BONUS_BP);
    await grantReward(db,d,item.reward,guards); message = `消耗声望 ${String(item.cost)}，获得${item.reward.description}`;
  } else {
    const kind: ProgressionCosmetic['kind'] = input.action === 'set-frame' ? 'frame' : 'title';
    if (input.id !== null && !data.cosmetics.some(row => row.cosmetic_id === input.id && row.kind === kind)) throw new AppError('INVALID_STATUS','尚未拥有此宗门外观');
    if (kind === 'frame') d.progression.equipped_frame = input.id; else d.progression.equipped_title = input.id;
    message = input.id === null ? '已卸下宗门外观' : '已佩戴宗门外观';
  }
  saveMetadata(d);
  const result = { message };
  d.addStatement({sql:'INSERT INTO progression_commands(sect_id,command_id,fingerprint,receipt_json,created_at) VALUES(?,?,?,?,?)',params:[d.sect.id,input.commandId,fingerprint,JSON.stringify(result),now]});
  try { await d.commit({extraGuards:guards}); }
  catch (error) {
    const replay = await receiptOf(db,d.sect.id,input.commandId,fingerprint);
    if (replay) return { ...await getProgression(db,userId,now), result:replay };
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) throw new AppError('INVALID_STATUS','成长状态已变化，请刷新重试');
    throw error;
  }
  return { state:d.view(), progression:panelOf(d,await loadData(db,d)), result };
}
