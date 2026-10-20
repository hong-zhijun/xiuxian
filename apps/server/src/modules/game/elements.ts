import type { BeastElement } from '@xiuxian/contracts';
export const ELEMENTS: readonly BeastElement[] = ['metal', 'wood', 'water', 'fire', 'earth'];
export const ELEMENT_NAMES: Record<BeastElement, string> = { metal: '金', wood: '木', water: '水', fire: '火', earth: '土' };
const CONQUERS: Record<BeastElement, BeastElement> = { metal: 'wood', wood: 'earth', earth: 'water', water: 'fire', fire: 'metal' };
export function elementFactor(attacker?: BeastElement | null, defender?: BeastElement | null): number {
  if (!attacker || !defender) return 1;
  return CONQUERS[attacker] === defender ? 1.15 : CONQUERS[defender] === attacker ? 0.85 : 1;
}
export function enemyElement(index: number): BeastElement { return ELEMENTS[Math.max(0, index - 1) % 5]!; }
