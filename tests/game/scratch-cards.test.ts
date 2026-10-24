import { describe, expect, it } from 'vitest';
import { rollScratchCard, scratchCardPanel, scratchCardBuySchema, scoreScratchDuel, scoreScratchLines } from '../../apps/server/src/modules/game/scratchCards';

describe('刮刮乐奖池与票面一致性', () => {
  it.each([
    [0, 0], [0.5999, 0], [0.6, 1], [0.8199, 1], [0.82, 2],
    [0.9399, 2], [0.94, 5], [0.9899, 5], [0.99, 10], [0.9989, 10], [0.999, 50], [0.9999, 50],
  ])('抽样值 %s 的奖额与九格图案一致', (roll, multiplier) => {
    let first = true;
    const card = rollScratchCard(() => { if (first) { first = false; return roll; } return 0.5; });
    expect(card.multiplier).toBe(multiplier);
    expect(card.symbols).toHaveLength(9);
    const counts = new Map<string, number>();
    for (const symbol of card.symbols) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    const matches = [...counts].filter(([, count]) => count >= 3);
    expect(matches).toEqual(multiplier === 0 ? [] : [[card.winningSymbol, 3]]);
  });

  it('所有概率桶完整覆盖万分位，实际返还率与展示值一致', () => {
    const counts = new Map<number, number>();
    let totalReturn = 0;
    for (let roll = 0; roll < 10_000; roll += 1) {
      let first = true;
      const card = rollScratchCard(() => { if (first) { first = false; return (roll + 0.5) / 10_000; } return 0.25; });
      counts.set(card.multiplier, (counts.get(card.multiplier) ?? 0) + 1);
      totalReturn += card.multiplier;
    }
    const panel = scratchCardPanel();
    expect(counts.get(0)).toBe(panel.blankChanceBp);
    for (const prize of panel.prizes) expect(counts.get(prize.multiplier)).toBe(prize.chanceBp);
    expect(totalReturn).toBe(panel.returnRateBp);
    expect(panel.returnRateBp).toBe(8500);
  });

  it('极端随机序列也不会生成额外三连', () => {
    for (const fixed of [0, 0.01, 0.5, 0.999999]) {
      const card = rollScratchCard(() => fixed);
      expect(card.symbols.every(symbol => typeof symbol === 'string')).toBe(true);
      const matches = [...new Set(card.symbols)].filter(symbol => card.symbols.filter(s => s === symbol).length >= 3);
      expect(matches).toEqual(card.winningSymbol === null ? [] : [card.winningSymbol]);
    }
  });

  it('请求拒绝客户端传入奖额或票面', () => {
    expect(scratchCardBuySchema.safeParse({ tier: 'basic', requestId: crypto.randomUUID(), reward: '999999' }).success).toBe(false);
    expect(scratchCardBuySchema.safeParse({ tier: 'basic', requestId: crypto.randomUUID(), symbols: [] }).success).toBe(false);
  });
});

describe('四种刮奖规则', () => {
  it.each([['triple', 9], ['numbers', 6], ['duel', 3], ['lines', 9]] as const)('%s 的票面能独立还原全部奖金', (mode, size) => {
    let seed = 731;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const card = rollScratchCard(random, mode);
      expect(card.mode).toBe(mode);
      expect(card.cells).toHaveLength(size);
      expect(card.multiplier).toBe(card.wins.reduce((sum, win) => sum + win.multiplier, 0));
      expect(card.multiplier).toBeLessThanOrEqual(scratchCardPanel().modes.find(item => item.id === mode)!.maxMultiplier);
      const highlighted = [...new Set(card.wins.flatMap(win => win.indexes))].sort();
      expect(card.cells.flatMap((cell, index) => cell.winning ? [index] : []).sort()).toEqual(highlighted);
      if (mode === 'numbers') {
        expect(new Set(card.targets).size).toBe(2);
        expect(new Set(card.cells.map(cell => cell.value)).size).toBe(6);
        expect(card.targets.every(target => target >= 1 && target <= 20)).toBe(true);
        expect(card.multiplier).toBe(card.cells.reduce((sum, cell) => sum + (card.targets.includes(Number(cell.value)) ? cell.multiplier : 0), 0));
      }
      if (mode === 'duel') {
        const wins = card.cells.filter((cell, index) => Number(cell.value) > card.targets[index]!).length;
        expect(card.multiplier).toBe(wins * 0.5 + (wins === 3 ? 2 : 0));
      }
    }
  });

  it.each([[0, 1], [0.7999, 1], [0.8, 2], [0.9499, 2], [0.95, 5], [0.9899, 5], [0.99, 10], [0.9999, 10]])('对号单格奖额边界 %s，多个命中会相加', (random, multiplier) => {
    let calls = 0;
    const card = rollScratchCard(() => ++calls <= 38 ? 0.9999 : random, 'numbers');
    expect(card.targets).toEqual([1, 2]);
    expect(card.cells.map(cell => cell.value)).toEqual(['01', '02', '03', '04', '05', '06']);
    expect(card.wins).toHaveLength(2);
    expect(card.multiplier).toBe(2 * multiplier);
  });

  it('比大小严格判胜，平局没有奖励，半倍小奖和全胜加奖分别结算', () => {
    expect(scoreScratchDuel([1, 4, 9], [1, 4, 9])).toEqual([]);
    expect(scoreScratchDuel([2, 1, 1], [1, 1, 1]).map(win => win.multiplier)).toEqual([0.5]);
    expect(scoreScratchDuel([2, 2, 1], [1, 1, 1]).map(win => win.multiplier)).toEqual([0.5, 0.5]);
    expect(scoreScratchDuel([9, 9, 9], [1, 1, 1]).map(win => win.multiplier)).toEqual([0.5, 0.5, 0.5, 2]);
    let roundWins = 0;
    for (let player = 1; player <= 9; player++) for (let opponent = 1; opponent <= 9; opponent++) if (scoreScratchDuel([player], [opponent]).length) roundWins++;
    const probability = roundWins / 81;
    const mode = scratchCardPanel().modes.find(item => item.id === 'duel')!;
    expect(Math.round((3 * probability * 0.5 + 2 * probability ** 3) * 10_000)).toBe(mode.returnRateBp);
    expect(Math.round((1 - (1 - probability) ** 3) * 10_000)).toBe(mode.winChanceBp);
  });

  it('八线玩法穷举19683种票面，交叉线叠加、满盘加奖和公布概率都准确', () => {
    const symbols = ['coin', 'sword', 'dragon'] as const;
    let wins = 0, total = 0, max = 0;
    for (let board = 0; board < 3 ** 9; board++) {
      let code = board;
      const cells = Array.from({ length: 9 }, () => { const symbol = symbols[code % 3]!; code = Math.floor(code / 3); return symbol; });
      const amount = scoreScratchLines(cells).reduce((sum, win) => sum + win.multiplier, 0);
      if (amount > 0) wins++;
      total += amount;
      max = Math.max(max, amount);
    }
    const mode = scratchCardPanel().modes.find(item => item.id === 'lines')!;
    expect(wins).toBe(12381);
    expect(total).toBe(17511);
    expect(max).toBe(mode.maxMultiplier);
    expect(Math.round(wins / 19683 * 10_000)).toBe(mode.winChanceBp);
    expect(Math.round(total / 19683 * 10_000)).toBe(mode.returnRateBp);
    expect(scoreScratchLines(Array(9).fill('dragon'))).toHaveLength(9);
    expect(scoreScratchLines(['coin', 'sword', 'dragon', 'sword', 'coin', 'dragon', 'dragon', 'dragon', 'coin']).map(win => win.label)).toEqual(['正对角线']);
  });

  it('对号模式公开的有奖概率和返还率符合不放回抽样与独立单格奖额', () => {
    const mode = scratchCardPanel().modes.find(item => item.id === 'numbers')!;
    expect(Math.round((1 - 14 * 13 / (20 * 19)) * 10_000)).toBe(mode.winChanceBp);
    expect(Math.round(6 * (2 / 20) * (0.8 + 2 * 0.15 + 5 * 0.04 + 10 * 0.01) * 10_000)).toBe(mode.returnRateBp);
  });

  it('旧请求默认三同，非法玩法及伪造中奖明细会被拒绝', () => {
    expect(scratchCardBuySchema.parse({ tier: 'basic', requestId: crypto.randomUUID() }).mode).toBe('triple');
    expect(scratchCardBuySchema.safeParse({ tier: 'basic', requestId: crypto.randomUUID(), mode: 'unknown' }).success).toBe(false);
    expect(scratchCardBuySchema.safeParse({ tier: 'basic', requestId: crypto.randomUUID(), mode: 'numbers', wins: [{ multiplier: 999 }] }).success).toBe(false);
  });
});
