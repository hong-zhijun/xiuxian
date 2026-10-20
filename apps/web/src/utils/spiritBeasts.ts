import type { BeastAttrs, BeastElement, BeastQuality } from '@xiuxian/contracts';

/** 宠物秘境与灵兽苑共用的展示文案（数值与规则都以服务端面板为准）。 */
export const BEAST_ATTR_NAMES: Record<keyof BeastAttrs, string> = {
  attack: '攻击',
  defense: '防御',
  speed: '身法',
  luck: '幸运',
  physique: '体魄',
};

export const BEAST_ELEMENT_OPTIONS: readonly { id: BeastElement; name: string }[] = [
  { id: 'metal', name: '金' },
  { id: 'wood', name: '木' },
  { id: 'water', name: '水' },
  { id: 'fire', name: '火' },
  { id: 'earth', name: '土' },
];

export const BEAST_QUALITY_OPTIONS: readonly { id: BeastQuality; name: string }[] = [
  { id: 'common', name: '凡品' },
  { id: 'spirit', name: '灵品' },
  { id: 'treasure', name: '宝品' },
  { id: 'immortal', name: '仙品' },
];

/** 非零属性逐项列出：「攻击 +6 · 身法 +2」。 */
export function beastAttrList(attrs: BeastAttrs): { key: keyof BeastAttrs; label: string; value: number }[] {
  return (Object.keys(BEAST_ATTR_NAMES) as (keyof BeastAttrs)[])
    .filter((key) => attrs[key] > 0)
    .map((key) => ({ key, label: BEAST_ATTR_NAMES[key], value: attrs[key] }));
}
