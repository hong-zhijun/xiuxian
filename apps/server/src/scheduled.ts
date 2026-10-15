import {
  processArenaTournament,
  processAuctions,
  processStockOrders,
  processWorldBoss,
  processWorldSites,
  settleCurrentRound,
} from './modules/game/service';

/**
 * 每 10 分钟一次的定时任务（Workers Cron 与 Node 版的计时器共用这一份）。
 * 0024 灵兽竞逐结算、0025 世界 Boss（出现 / 逃走 / 发奖）、0040 拍卖行到期结算、0051 山河舆图整点供奉（并清理 3 天前的纪事）、0049 灵股挂单、0053 宗门大比（12 点日赛、周日赛季）各自兜错，互不影响。
 */
export async function runScheduledTasks(db: D1Database, now: number): Promise<void> {
  // 先检查拍卖行：游商到访不等待讨伐或竞逐的结算。
  try {
    await processAuctions(db, now);
  } catch (error) {
    console.warn(`process_auctions_failed error=${String(error)}`);
  }
  try {
    await settleCurrentRound(db, now);
  } catch (error) {
    console.warn(`settle_current_round_failed error=${String(error)}`);
  }
  try {
    await processWorldBoss(db, now);
  } catch (error) {
    console.warn(`process_world_boss_failed error=${String(error)}`);
  }
  try {
    await processWorldSites(db, now);
  } catch (error) {
    console.warn(`process_world_sites_failed error=${String(error)}`);
  }
  try {
    await processStockOrders(db, now);
  } catch (error) {
    console.warn(`process_stock_orders_failed error=${String(error)}`);
  }
  try {
    await processArenaTournament(db, now);
  } catch (error) {
    console.warn(`process_arena_tournament_failed error=${String(error)}`);
  }
}
