/**
 * 暴击的公共规则：镇妖塔、宗门大比（演武场）、讨伐、捕兽共用同一套底数与公式。
 *
 * - 暴击率 = 幸运 / 100 × 20% × 倍率（天机、罡气、邪祟），夹在 0~100%。
 * - 暴击伤害倍率 = 基础 ×1.5（破甲的首击必暴会换掉基础值）+ 各项加成（会心、破军、灵兽杀伐）。
 *
 * 各玩法只决定「传哪些倍率与加成」；改底数或公式只改这里。
 */

/** 幸运 100 时的暴击率。 */
export const CRIT_RATE_MAX = 0.2;
/** 基础暴击伤害倍率。 */
export const CRIT_MULTIPLIER = 1.5;

/** 暴击率：幸运 / 100 × 20% × multiplier，最高 100%。 */
export function critRate(luck: number, multiplier = 1): number {
  return Math.min(1, (Math.max(0, luck) / 100) * CRIT_RATE_MAX * multiplier);
}

/** 暴击伤害倍率：base + 各项加成（按传入顺序依次相加）。 */
export function critMultiplier(bonuses: readonly number[], base: number = CRIT_MULTIPLIER): number {
  return bonuses.reduce((sum, bonus) => sum + bonus, base);
}
