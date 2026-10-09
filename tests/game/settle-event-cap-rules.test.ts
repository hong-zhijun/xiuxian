import { GAME_CONFIG_CONTENT } from '@xiuxian/game-config';
import { describe, expect, it } from 'vitest';

import type { TriggeredEvent } from '../../apps/server/src/modules/game/events';
import { applyEventEffects, type SettledResource } from '../../apps/server/src/modules/game/settle';

/**
 * 随机事件叠加到余额（settle.ts applyEventEffects）。
 *
 * 0045 起：余额本来就高于容量（拍卖交付、祭炼贺礼不夹容量）时，事件不能把它夹回容量；
 * 余额在容量以内时行为与原来一致。灵石基础容量 5000（最小单位 5_000_000），倍率取 1。
 */
const CAPACITY = 5_000_000;

function stone(balance: number): SettledResource {
  return { resourceId: 'spiritStone', balance, remainder: 0, ratePerHour: 0, discarded: 0, capped: false };
}

function event(amount: string): TriggeredEvent {
  return { id: 'e1', eventId: 'test', name: '测试', description: '', effects: { spiritStone: amount } };
}

function apply(balance: number, amount: string): number {
  const resources = [stone(balance)];
  applyEventEffects(resources, GAME_CONFIG_CONTENT, [event(amount)], 1);
  return resources[0]!.balance;
}

describe('随机事件与容量', () => {
  it('容量以内：收益照加，加满为止', () => {
    expect(apply(1_000_000, '80000')).toBe(1_080_000);
    expect(apply(CAPACITY - 30_000, '80000')).toBe(CAPACITY);
  });

  it('容量以内：损失照扣，不低于 0', () => {
    expect(apply(1_000_000, '-50000')).toBe(950_000);
    expect(apply(20_000, '-50000')).toBe(0);
  });

  it('已超出容量：收益事件不加也不把余额夹回容量', () => {
    expect(apply(15_000_000, '80000')).toBe(15_000_000);
  });

  it('已超出容量：损失事件照扣，不会先夹回容量', () => {
    expect(apply(15_000_000, '-50000')).toBe(14_950_000);
  });
});
