import type { ScratchCardMode, ScratchCardModeView, ScratchCardPanel, ScratchCardTicket, ScratchCardWin, ScratchSymbol } from '@xiuxian/contracts';
import { z } from 'zod';

export const scratchCardBuySchema = z.strictObject({
  tier: z.enum(['basic', 'lucky', 'fortune']),
  requestId: z.uuid(),
  mode: z.enum(['triple', 'numbers', 'duel', 'lines']).default('triple'),
});
export const scratchCardQuerySchema = z.strictObject({ requestId: z.uuid().optional() });

export const SCRATCH_CARD_TIERS = [
  { id: 'basic', name: '随缘签', cost: 50_000 },
  { id: 'lucky', name: '鸿运签', cost: 200_000 },
  { id: 'fortune', name: '天赐签', cost: 500_000 },
] as const;

// Probabilities are per card, not independent per cell: exactly one prize or no prize.
export const SCRATCH_CARD_PRIZES = [
  { symbol: 'coin', name: '铜钱', glyph: '钱', multiplier: 1, chanceBp: 2200 },
  { symbol: 'sword', name: '灵剑', glyph: '剑', multiplier: 2, chanceBp: 1200 },
  { symbol: 'pill', name: '仙丹', glyph: '丹', multiplier: 5, chanceBp: 500 },
  { symbol: 'crane', name: '仙鹤', glyph: '鹤', multiplier: 10, chanceBp: 90 },
  { symbol: 'dragon', name: '金龙', glyph: '龙', multiplier: 50, chanceBp: 10 },
] as const;
export const SCRATCH_CARD_BLANK_CHANCE_BP = 6000;

export const SCRATCH_CARD_MODES: ScratchCardModeView[] = [
  {
    id: 'triple', name: '三同聚宝', tagline: '凑三同 · 冲大奖',
    description: '经典三同玩法：九格任意位置出现三个相同图案，领取该图案的奖金。',
    rules: ['九格中只需三个图案相同，无需连线。', '每张仅中一个奖项，最高返还50倍票价。'],
    rewardRules: SCRATCH_CARD_PRIZES.map(prize => ({ label: `三个${prize.name}（${prize.chanceBp / 100}%）`, payout: `${prize.multiplier}倍` })),
    maxMultiplier: 50, winChanceBp: 4000, returnRateBp: 8500,
  },
  {
    id: 'numbers', name: '幸运对号', tagline: '对号码 · 奖金累加',
    description: '对照两个幸运号码，刮出六个你的号码；每次对中，都领取该格标注的奖金。',
    rules: ['幸运号码和你的号码分别从01～20中不重复抽取。', '每格独立标注1、2、5或10倍奖金，对中任意幸运号码才获奖，最多中两格，奖金相加。'],
    rewardRules: [{ label: '命中号码', payout: '领取该格奖金' }, { label: '单格奖额分布', payout: '1倍80% / 2倍15% / 5倍4% / 10倍1%' }, { label: '同时命中两格', payout: '两格奖金相加' }],
    maxMultiplier: 20, winChanceBp: 5211, returnRateBp: 8400,
  },
  {
    id: 'duel', name: '点数争锋', tagline: '逐局比大小 · 全胜加奖',
    description: '刮出三局你的点数，逐局挑战对手。赢一局得半倍票价，三局全胜另加2倍。',
    rules: ['每局双方独立抽取1～9点，你的点数严格大于对手才获奖，相同点数不获奖。', '每赢一局返还0.5倍票价，三局奖金相加；全胜额外加2倍，合计3.5倍。'],
    rewardRules: [{ label: '赢一局', payout: '0.5倍' }, { label: '赢两局', payout: '合计1倍' }, { label: '三局全胜', payout: '1.5倍 + 2倍全胜奖' }],
    maxMultiplier: 3.5, winChanceBp: 8285, returnRateBp: 8422,
  },
  {
    id: 'lines', name: '八线来财', tagline: '横竖斜连线 · 多线多奖',
    description: '三行、三列和两条对角线都能中奖；一条线上三个图案相同，即领取该线奖金。',
    rules: ['每格从铜钱、灵剑、金龙中等概率独立产生图案；只计算完整的横、竖、对角线。', '每条中奖线分别计奖，交叉线可以重复计奖；九格完全相同时，额外加5倍满盘奖。'],
    rewardRules: [{ label: '每条铜钱线', payout: '0.5倍' }, { label: '每条灵剑线', payout: '1倍' }, { label: '每条金龙线', payout: '1.5倍' }, { label: '九格全同', payout: '八线奖金 + 5倍满盘奖' }],
    maxMultiplier: 17, winChanceBp: 6290, returnRateBp: 8897,
  },
];

export function scratchCardPanel(): ScratchCardPanel {
  return {
    modes: SCRATCH_CARD_MODES.map(mode => ({ ...mode, rules: [...mode.rules], rewardRules: mode.rewardRules.map(rule => ({ ...rule })) })),
    tiers: SCRATCH_CARD_TIERS.map(tier => ({ ...tier, cost: String(tier.cost), maxReward: String(tier.cost * 50) })),
    prizes: SCRATCH_CARD_PRIZES.map(prize => ({ ...prize })),
    blankChanceBp: SCRATCH_CARD_BLANK_CHANCE_BP,
    returnRateBp: SCRATCH_CARD_PRIZES.reduce((sum, prize) => sum + prize.multiplier * prize.chanceBp, 0),
  };
}

type CardRoll = Pick<ScratchCardTicket, 'mode' | 'modeName' | 'symbols' | 'winningSymbol' | 'multiplier' | 'cells' | 'targets' | 'wins'>;
function baseCard(mode: ScratchCardMode): CardRoll {
  return { mode, modeName: SCRATCH_CARD_MODES.find(item => item.id === mode)!.name, symbols: [], winningSymbol: null, multiplier: 0, cells: [], targets: [], wins: [] };
}
function shuffled<T>(items: T[], random: () => number): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [items[index], items[target]] = [items[target]!, items[index]!];
  }
  return items;
}
export const SCRATCH_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6],
] as const;
const LINE_NAMES = ['上横线', '中横线', '下横线', '左竖线', '中竖线', '右竖线', '正对角线', '反对角线'];
export const LINE_SYMBOLS = ['coin', 'sword', 'dragon'] as const;
const LINE_PAYOUTS = { coin: 0.5, sword: 1, dragon: 1.5 };
export function scoreScratchLines(symbols: ScratchSymbol[]): ScratchCardWin[] {
  const wins: ScratchCardWin[] = [];
  SCRATCH_LINES.forEach((line, index) => {
    const symbol = symbols[line[0]];
    if (symbol !== undefined && symbol in LINE_PAYOUTS && line.every(cell => symbols[cell] === symbol)) {
      wins.push({ label: LINE_NAMES[index]!, multiplier: LINE_PAYOUTS[symbol as keyof typeof LINE_PAYOUTS], indexes: [...line] });
    }
  });
  if (symbols.length === 9 && symbols.every(symbol => symbol === symbols[0])) {
    wins.push({ label: '九格全同 · 满盘奖', multiplier: 5, indexes: symbols.map((_, index) => index) });
  }
  return wins;
}
export function scoreScratchDuel(players: number[], opponents: number[]): ScratchCardWin[] {
  const wins: ScratchCardWin[] = [];
  players.forEach((player, index) => {
    if (player > opponents[index]!) wins.push({ label: `第${index + 1}局胜出`, multiplier: 0.5, indexes: [index] });
  });
  if (wins.length === 3) wins.push({ label: '三局全胜奖', multiplier: 2, indexes: [0, 1, 2] });
  return wins;
}
function completeCard(card: CardRoll): CardRoll {
  card.multiplier = card.wins.reduce((sum, win) => sum + win.multiplier, 0);
  return card;
}

export function rollScratchCard(random: () => number = Math.random, mode: ScratchCardMode = 'triple'): CardRoll {
  const card = baseCard(mode);
  if (mode === 'numbers') {
    card.targets = shuffled(Array.from({ length: 20 }, (_, index) => index + 1), random).slice(0, 2);
    const numbers = shuffled(Array.from({ length: 20 }, (_, index) => index + 1), random).slice(0, 6);
    card.cells = numbers.map((number, index) => {
      const roll = random();
      const multiplier = roll < 0.8 ? 1 : roll < 0.95 ? 2 : roll < 0.99 ? 5 : 10;
      const winning = card.targets.includes(number);
      if (winning) card.wins.push({ label: `号码${String(number).padStart(2, '0')}`, multiplier, indexes: [index] });
      return { value: String(number).padStart(2, '0'), label: `号码${index + 1}`, multiplier, winning };
    });
    return completeCard(card);
  }
  if (mode === 'duel') {
    card.targets = Array.from({ length: 3 }, () => Math.floor(random() * 9) + 1);
    const players = Array.from({ length: 3 }, () => Math.floor(random() * 9) + 1);
    card.wins = scoreScratchDuel(players, card.targets);
    card.cells = players.map((player, index) => ({ value: String(player), label: `第${index + 1}局 · 对手${card.targets[index]}点`, multiplier: 0.5, winning: player > card.targets[index]! }));
    return completeCard(card);
  }
  if (mode === 'lines') {
    card.symbols = Array.from({ length: 9 }, () => LINE_SYMBOLS[Math.floor(random() * LINE_SYMBOLS.length)]!);
    card.wins = scoreScratchLines(card.symbols);
    card.cells = card.symbols.map(symbol => {
      const prize = SCRATCH_CARD_PRIZES.find(item => item.symbol === symbol)!;
      return { value: prize.glyph, label: prize.name, multiplier: 0, winning: false };
    });
    for (const win of card.wins) for (const index of win.indexes) card.cells[index]!.winning = true;
    return completeCard(card);
  }
  const roll = Math.floor(random() * 10_000);
  let threshold = SCRATCH_CARD_BLANK_CHANCE_BP;
  let winner: typeof SCRATCH_CARD_PRIZES[number] | undefined;
  for (const prize of SCRATCH_CARD_PRIZES) {
    threshold += prize.chanceBp;
    if (roll >= threshold - prize.chanceBp && roll < threshold) {
      winner = prize;
      break;
    }
  }
  const symbols: ScratchSymbol[] = winner === undefined ? [] : Array<ScratchSymbol>(3).fill(winner.symbol);
  const counts = new Map<ScratchSymbol, number>();
  if (winner !== undefined) counts.set(winner.symbol, 3);
  while (symbols.length < 9) {
    const available = SCRATCH_CARD_PRIZES.filter(prize => (counts.get(prize.symbol) ?? 0) < 2);
    const symbol = available[Math.floor(random() * available.length)]!.symbol;
    counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    symbols.push(symbol);
  }
  card.symbols = shuffled(symbols, random);
  card.winningSymbol = winner?.symbol ?? null;
  card.cells = card.symbols.map(symbol => {
    const prize = SCRATCH_CARD_PRIZES.find(item => item.symbol === symbol)!;
    return { value: prize.glyph, label: prize.name, multiplier: 0, winning: symbol === card.winningSymbol };
  });
  if (winner !== undefined) card.wins.push({ label: `三个${winner.name}`, multiplier: winner.multiplier, indexes: card.symbols.flatMap((symbol, index) => symbol === winner.symbol ? [index] : []) });
  return completeCard(card);
}
