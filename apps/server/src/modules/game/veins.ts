/**
 * 灵脉争夺（docs/灵脉争夺开发计划.md）——纯定义与纯计算。
 *
 * 与 tower.ts / auction.ts 同一做法：灵脉定义、档位、产出折算、对决都硬编码在这里，不进 game-config；
 * 本文件不读库、不取时间，随机源通过参数注入。
 *
 * 金额一律是最小单位（1 展示单位 = 1000 最小单位）。
 */

export const VEIN_UNLOCK_SECT_LEVEL = 3;
/** 守军 / 进攻队伍人数（固定）。 */
export const VEIN_PARTY_SIZE = 3;
/** 每天最多抢夺次数（进驻无主灵脉不算）。 */
export const VEIN_DAILY_ATTACKS = 5;
/** 进驻 / 易主后的保护期。 */
export const VEIN_PROTECT_MS = 60 * 60 * 1000;
/** 枯竭后原占领者不能再占这一条的时长。 */
export const VEIN_EXHAUST_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** 不能抢「宗门等级比自己低这么多及以上」的宗门。 */
export const VEIN_LEVEL_GAP = 3;
/** 守方战力加成（基点，1000 = +10%）。 */
export const VEIN_DEFENDER_BONUS_BP = 1000;
/** 进攻失败时每名进攻弟子受伤的概率与疗伤时长。 */
export const VEIN_ATTACK_INJURY_CHANCE = 0.3;
export const VEIN_ATTACK_INJURY_MS = 30 * 60 * 1000;
/** 战报列表保留条数。 */
export const VEIN_RECENT_BATTLES = 20;

const HOUR_MS = 3_600_000;

export type VeinTier = 'small' | 'large' | 'eye';

export interface VeinTierDef {
  id: VeinTier;
  name: string;
  /** 每小时灵气（最小单位）。 */
  ratePerHour: number;
  minSectLevel: number;
  /** 同一宗门连续占领上限；null = 不限。 */
  holdLimitMs: number | null;
}

export const VEIN_TIERS: readonly VeinTierDef[] = [
  { id: 'small', name: '小灵脉', ratePerHour: 25_000, minSectLevel: 3, holdLimitMs: null },
  { id: 'large', name: '大灵脉', ratePerHour: 40_000, minSectLevel: 6, holdLimitMs: 48 * HOUR_MS },
  { id: 'eye', name: '灵眼', ratePerHour: 60_000, minSectLevel: 9, holdLimitMs: 24 * HOUR_MS },
];

export interface VeinDef {
  /** 与 spirit_veins.id 一一对应（迁移里预置）。 */
  id: string;
  name: string;
  tier: VeinTier;
}

/** 全服灵脉（顺序即面板顺序）。加灵脉：这里加一条，再写迁移补一行。 */
export const VEINS: readonly VeinDef[] = [
  { id: 'vein-eye', name: '昆仑灵眼', tier: 'eye' },
  { id: 'vein-large-1', name: '东海龙脉', tier: 'large' },
  { id: 'vein-large-2', name: '西岭赤脉', tier: 'large' },
  { id: 'vein-large-3', name: '北原冰脉', tier: 'large' },
  { id: 'vein-small-1', name: '青竹泉眼', tier: 'small' },
  { id: 'vein-small-2', name: '落霞石脉', tier: 'small' },
  { id: 'vein-small-3', name: '幽谷灵泉', tier: 'small' },
  { id: 'vein-small-4', name: '松风岭脉', tier: 'small' },
  { id: 'vein-small-5', name: '白鹿溪脉', tier: 'small' },
  { id: 'vein-small-6', name: '云梦泽脉', tier: 'small' },
];

export function findVein(veinId: string): VeinDef | undefined {
  return VEINS.find((vein) => vein.id === veinId);
}

export function veinTierOf(tier: VeinTier | string): VeinTierDef {
  return VEIN_TIERS.find((item) => item.id === tier) ?? VEIN_TIERS[0]!;
}

/** 一段占领时间的产出（最小单位，向下取整）；时间倒退或为 0 时返回 0。 */
export function veinProduction(ratePerHour: number, fromMs: number, toMs: number): number {
  const elapsed = Math.max(0, toMs - fromMs);
  return Math.floor((ratePerHour * elapsed) / HOUR_MS);
}

/** 枯竭时刻 = 连续占领起点 + 上限；不限时的档位返回 null。 */
export function veinExhaustAt(tier: VeinTier | string, heldSince: number): number | null {
  const limit = veinTierOf(tier).holdLimitMs;
  return limit === null ? null : heldSince + limit;
}

/** 是否「欺负新人」：守方宗门等级比进攻方低 VEIN_LEVEL_GAP 级及以上。 */
export function isVeinLevelGapBlocked(attackerLevel: number, defenderLevel: number): boolean {
  return attackerLevel - defenderLevel >= VEIN_LEVEL_GAP;
}

/* ---------- 对决 ---------- */

export interface VeinRound {
  round: number;
  attackerName: string;
  attackerPower: number;
  /** 守方这一回合缺席（被驱逐 / 重伤）时为 null。 */
  defenderName: string | null;
  defenderPower: number | null;
  winner: 'attacker' | 'defender';
}

/**
 * 三局两胜：第 i 回合是进攻第 i 人对守军第 i 人；双方战力各 ×(0.85～1.15)，守方再 ×1.1，高者胜。
 * 守军第 i 人缺席（null）时这一回合进攻方直接胜。先拿到 2 胜就结束。
 * 随机源取用顺序：每回合先进攻方浮动、再守方浮动（缺席回合不取）。
 */
export function resolveVeinBattle(input: {
  attackers: readonly { name: string; power: number }[];
  defenders: readonly ({ name: string; power: number } | null)[];
  random: () => number;
}): { rounds: VeinRound[]; won: boolean } {
  const rounds: VeinRound[] = [];
  let attackerWins = 0;
  let defenderWins = 0;
  for (let index = 0; index < VEIN_PARTY_SIZE; index += 1) {
    if (attackerWins >= 2 || defenderWins >= 2) break;
    const attacker = input.attackers[index];
    if (attacker === undefined) break;
    const defender = input.defenders[index] ?? null;
    const attackerPower = Math.floor(attacker.power * (0.85 + input.random() * 0.3));
    if (defender === null) {
      rounds.push({
        round: index + 1,
        attackerName: attacker.name,
        attackerPower,
        defenderName: null,
        defenderPower: null,
        winner: 'attacker',
      });
      attackerWins += 1;
      continue;
    }
    const defenderPower = Math.floor(
      ((defender.power * (0.85 + input.random() * 0.3)) * (10_000 + VEIN_DEFENDER_BONUS_BP)) / 10_000,
    );
    const winner = attackerPower > defenderPower ? 'attacker' : 'defender';
    rounds.push({
      round: index + 1,
      attackerName: attacker.name,
      attackerPower,
      defenderName: defender.name,
      defenderPower,
      winner,
    });
    if (winner === 'attacker') attackerWins += 1;
    else defenderWins += 1;
  }
  return { rounds, won: attackerWins >= 2 };
}

/** 守军 JSON（弟子 id 数组）解析；脏数据返回空数组。 */
export function parseGarrison(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
