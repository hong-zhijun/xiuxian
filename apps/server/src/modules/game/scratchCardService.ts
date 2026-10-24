import type { ScratchCardBuyInput, ScratchCardTicket } from '@xiuxian/contracts';
import { AppError } from '../../http/appError';
import { DEBATE_DAILY_LIMIT, gamblingUnlockBlockedReason } from './gambling';
import { insertDaoDebateLogStatement, updateSectDebateCounterStatement } from './repository';
import { SCRATCH_CARD_MODES, SCRATCH_CARD_PRIZES, SCRATCH_CARD_TIERS, rollScratchCard, scratchCardBuySchema } from './scratchCards';
import { draftFor, getSectState } from './service';
import type { SectStateView } from './view';

interface ReceiptRow { reward_detail: string }

// Existing single-mode receipts remain valid without a database migration.
function normalizeTicket(ticket: ScratchCardTicket): ScratchCardTicket {
  if (ticket.mode !== undefined && ticket.cells !== undefined) return ticket;
  const cells = ticket.symbols.map(symbol => {
    const prize = SCRATCH_CARD_PRIZES.find(item => item.symbol === symbol)!;
    return { value: prize.glyph, label: prize.name, multiplier: 0, winning: symbol === ticket.winningSymbol };
  });
  return { ...ticket, mode: 'triple', modeName: SCRATCH_CARD_MODES[0]!.name, cells, targets: [],
    wins: ticket.multiplier > 0 ? [{ label: '三同中奖', multiplier: ticket.multiplier, indexes: cells.flatMap((cell, index) => cell.winning ? [index] : []) }] : [] };
}

// The existing history row is also the durable receipt. Its primary key prevents
// two transactions from paying the same card, without introducing another ledger.
function receiptId(sectId: string, requestId: string): string {
  return `scratch:${sectId}:${requestId}`;
}

async function findTicket(db: D1Database, sectId: string, requestId?: string): Promise<ScratchCardTicket | null> {
  const query = requestId === undefined
    ? db.prepare("SELECT reward_detail FROM dao_debate_log WHERE sect_id = ? AND bet_mode = 'scratch' ORDER BY created_at DESC, id DESC LIMIT 1").bind(sectId)
    : db.prepare("SELECT reward_detail FROM dao_debate_log WHERE sect_id = ? AND bet_mode = 'scratch' AND id = ?").bind(sectId, receiptId(sectId, requestId));
  const row = await query.first<ReceiptRow>();
  return row === null ? null : normalizeTicket((JSON.parse(row.reward_detail) as { ticket: ScratchCardTicket }).ticket);
}

export async function getScratchCard(db: D1Database, userId: string, now: number, requestId?: string): Promise<{
  state: SectStateView; ticket: ScratchCardTicket | null;
}> {
  const state = await getSectState(db, userId, now);
  if (state === null) throw new AppError('NOT_FOUND', '尚未创建宗门');
  return { state, ticket: await findTicket(db, state.sect.id, requestId) };
}

export async function buyScratchCard(db: D1Database, userId: string, input: ScratchCardBuyInput, now: number): Promise<{
  state: SectStateView; ticket: ScratchCardTicket;
}> {
  const parsed = scratchCardBuySchema.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', '请选择有效的刮刮乐档位和购票编号');
  const purchase = parsed.data;
  const draft = await draftFor(db, userId, now);
  const replay = async (): Promise<{ state: SectStateView; ticket: ScratchCardTicket } | null> => {
    const ticket = await findTicket(db, draft.sect.id, purchase.requestId);
    if (ticket === null) return null;
    if (ticket.tier !== purchase.tier || ticket.mode !== purchase.mode) throw new AppError('INVALID_STATUS', '同一购票编号不能更换档位或玩法');
    const state = await getSectState(db, userId, now);
    if (state === null) throw new AppError('NOT_FOUND', '尚未创建宗门');
    return { state, ticket };
  };
  const previous = await replay();
  if (previous !== null) return previous;

  const blocked = gamblingUnlockBlockedReason(Number(draft.sect.level));
  if (blocked !== null) throw new AppError('INVALID_STATUS', blocked);
  const day = draft.debateDay;
  if (day.remaining <= 0) throw new AppError('DAILY_LIMIT', `今日赌坊次数已用完（共 ${DEBATE_DAILY_LIMIT} 次/天）`);
  const tier = SCRATCH_CARD_TIERS.find(item => item.id === purchase.tier)!;
  draft.requireResourceAvailable('spiritStone', tier.cost);
  const card = rollScratchCard(Math.random, purchase.mode);
  const reward = tier.cost * card.multiplier;
  const net = reward - tier.cost;
  const ticket: ScratchCardTicket = {
    id: receiptId(draft.sect.id, purchase.requestId),
    requestId: purchase.requestId,
    tier: tier.id,
    tierName: tier.name,
    cost: String(tier.cost),
    reward: String(reward),
    netGain: String(net),
    ...card,
    createdAt: new Date(now).toISOString(),
    message: reward === 0
      ? `本张未中奖，花费 ${tier.cost / 1000} 灵石。`
      : `本张奖金 ${reward / 1000} 灵石（实际返还），净收益 ${net >= 0 ? '+' : ''}${net / 1000} 灵石。`,
  };
  draft.requireResource('spiritStone', tier.cost);
  draft.grantResource('spiritStone', reward);
  const usedAfter = day.usedToday + 1;
  draft.addStatement(updateSectDebateCounterStatement(draft.sect.id, day.dateKey, usedAfter));
  draft.sect.debate_date_key = day.dateKey;
  draft.sect.debate_count = usedAfter;
  draft.addStatement(insertDaoDebateLogStatement({
    id: ticket.id, sectId: draft.sect.id, discipleId: '', discipleName: card.modeName, betMode: 'scratch',
    // Legacy column requires >=1; the receipt retains the exact zero/half multiplier.
    multiplier: Math.max(1, card.multiplier),
    stakeDetail: JSON.stringify({ resourceId: 'spiritStone', amount: ticket.cost, tier: tier.id, tierName: tier.name, mode: card.mode, modeName: card.modeName }),
    result: reward > 0 ? 'win' : 'lose',
    rewardDetail: JSON.stringify({ type: reward > 0 ? 'resource' : 'none', resourceId: 'spiritStone', amount: ticket.reward, ticket }),
    winProbability: null, now,
  }));
  try {
    await draft.commitGambling({ resourceId: 'spiritStone' });
  } catch (error) {
    // A simultaneous retry may already have committed the same receipt.
    const concurrent = await replay();
    if (concurrent !== null) return concurrent;
    throw error;
  }
  draft.debateDay = { ...day, usedToday: usedAfter, remaining: DEBATE_DAILY_LIMIT - usedAfter };
  return { state: draft.view(), ticket };
}
