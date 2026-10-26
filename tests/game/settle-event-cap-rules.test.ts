import { describe, expect, it } from 'vitest';

import type { TriggeredEvent } from '../../apps/server/src/modules/game/events';
import { applyEventEffects, type SettledResource } from '../../apps/server/src/modules/game/settle';

/**
 * 随机事件叠加到余额（settle.ts applyEventEffects）。
 *
 * 2026-10-26 起仓库不设上限：收益事件照加（不管原来的灵石容量 5_000_000），损失事件照扣、不低于 0。
 */
function stone(balance: number): SettledResource {
  return { resourceId: 'spiritStone', balance, remainder: 0, ratePerHour: 0, discarded: 0, capped: false };
}

function event(amount: string): TriggeredEvent {
  return { id: 'e1', eventId: 'test', name: '测试', description: '', effects: { spiritStone: amount } };
}

function apply(balance: number, amount: string): number {
  const resources = [stone(balance)];
  applyEventEffects(resources, [event(amount)]);
  return resources[0]!.balance;
}

describe('随机事件（仓库不设上限）', () => {
  it('收益照加，超过原来的容量也不截断', () => {
    expect(apply(1_000_000, '80000')).toBe(1_080_000);
    expect(apply(4_970_000, '80000')).toBe(5_050_000);
    expect(apply(15_000_000, '80000')).toBe(15_080_000);
  });

  it('损失照扣，不低于 0', () => {
    expect(apply(1_000_000, '-50000')).toBe(950_000);
    expect(apply(20_000, '-50000')).toBe(0);
    expect(apply(15_000_000, '-50000')).toBe(14_950_000);
  });
});
