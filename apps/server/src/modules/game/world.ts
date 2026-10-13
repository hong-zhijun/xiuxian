/**
 * 山河舆图（docs/山河舆图开发计划.md）——纯定义与纯计算。
 *
 * 与 tower.ts / auction.ts 同一做法：灵地定义、档位、产出折算、对决都硬编码在这里，不进 game-config；
 * 本文件不读库、不取时间，随机源通过参数注入。
 *
 * 金额一律是最小单位（1 展示单位 = 1000 最小单位）。
 */

const HOUR_MS = 3_600_000;

export const WORLD_UNLOCK_SECT_LEVEL = 3;
/** 坐镇 / 进攻队伍人数（固定）。 */
export const WORLD_PARTY_SIZE = 3;
/** 每天最多斗法次数（UTC+8 自然日；驱妖开辟也计入）。 */
export const WORLD_DAILY_BATTLES = 10;
/** 开辟 / 易主后的禁制护持时长：这段时间内不能被斗法。 */
export const WORLD_PROTECT_MS = 4 * HOUR_MS;
/** 撤回山门后，撤回的宗门这么久之内不能再开辟 / 斗法这一处（防「强队夺地 → 撤回 → 弱队再开辟」）。 */
export const WORLD_WITHDRAW_COOLDOWN_MS = 24 * HOUR_MS;
/** 不能斗法「宗门等级比自己低这么多及以上」的宗门。 */
export const WORLD_LEVEL_GAP = 3;
/** 有主灵地的守方战力加成（基点，1000 = +10%）；妖兽不加。 */
export const WORLD_DEFENDER_BONUS_BP = 1000;
/** 盘踞妖兽的战力 = 进攻方同位次弟子战力 × 0.9（基点）。 */
export const WORLD_BEAST_POWER_BP = 9000;
/** 进攻失败时每名进攻弟子受伤的概率与疗伤时长。 */
export const WORLD_ATTACK_INJURY_CHANCE = 0.3;
export const WORLD_ATTACK_INJURY_MS = 30 * 60 * 1000;
/** 祖脉：每坐镇满这么多个整点小时，结算一次稀有材料。 */
export const WORLD_RARE_EVERY_HOURS = 6;
/** 祖脉：每满一次给几个稀有材料（展示单位；原 1 个，2026-10 调整为 5 个）。 */
export const WORLD_RARE_PER_DROP = 5;
/** 稀有材料每个的入账（最小单位，即 1 展示单位）。 */
export const WORLD_RARE_UNIT = 1000;
/** 山河纪事保留时长（定时任务清理）。 */
export const WORLD_LOG_KEEP_MS = 3 * 24 * HOUR_MS;
/** 面板一次列出的纪事条数。 */
export const WORLD_LOG_LIMIT = 60;
/** 首页「失陷」统计回看的时长。 */
export const WORLD_LOST_WINDOW_MS = 24 * HOUR_MS;

/* ---------- 域与灵地 ---------- */

export type WorldRegionId = 'east' | 'west' | 'south' | 'north' | 'center';

export interface WorldRegionDef {
  id: WorldRegionId;
  name: string;
  /** 主产资源；中州（祖脉）为 null。 */
  resourceId: string | null;
}

/** 五个域（顺序即面板顺序：东、西、南、北、中州）。 */
export const WORLD_REGIONS: readonly WorldRegionDef[] = [
  { id: 'east', name: '青木域', resourceId: 'herb' },
  { id: 'west', name: '赤铜域', resourceId: 'ore' },
  { id: 'south', name: '云泽域', resourceId: 'spiritualEnergy' },
  { id: 'north', name: '古墟域', resourceId: 'spiritStone' },
  { id: 'center', name: '中州', resourceId: null },
];

export type WorldSiteTier = 'lingdi' | 'fudi' | 'dongtian' | 'zumai';

export const WORLD_SITE_TIERS: readonly { id: WorldSiteTier; name: string }[] = [
  { id: 'lingdi', name: '灵地' },
  { id: 'fudi', name: '福地' },
  { id: 'dongtian', name: '洞天' },
  { id: 'zumai', name: '祖脉' },
];

export interface WorldSiteDef {
  /** 与 world_sites.id 一一对应（迁移里预置）。 */
  id: string;
  name: string;
  regionId: WorldRegionId;
  tier: WorldSiteTier;
  /** 每小时产出：资源 id → 最小单位。 */
  outputs: Readonly<Record<string, number>>;
  /** 祖脉的稀有材料（每坐镇满 6 个整点小时得 1 个）；其余灵地为 null。 */
  rare: { resourceId: 'xuantie' | 'shenmu' } | null;
}

/**
 * 全服 14 处灵地（顺序即面板顺序）。每个域只产主产资源：
 * 青木域产药材、赤铜域产矿石、云泽域产灵气、古墟域产灵石；按档位取「灵地 / 福地 / 洞天」的每小时产出。
 * 中州两处是祖脉：每小时灵气 80，另外每坐镇满 6 个整点小时得 5 个玄铁（玄铁祖脉）/ 神木（神木祖脉）。
 */
export const WORLD_SITES: readonly WorldSiteDef[] = [
  { id: 'east-lingdi', name: '百草谷', regionId: 'east', tier: 'lingdi', outputs: { herb: 75_000 }, rare: null },
  { id: 'east-fudi', name: '万药林', regionId: 'east', tier: 'fudi', outputs: { herb: 120_000 }, rare: null },
  { id: 'east-dongtian', name: '青帝洞天', regionId: 'east', tier: 'dongtian', outputs: { herb: 180_000 }, rare: null },
  { id: 'west-lingdi', name: '赤砂岭', regionId: 'west', tier: 'lingdi', outputs: { ore: 75_000 }, rare: null },
  { id: 'west-fudi', name: '熔金峡', regionId: 'west', tier: 'fudi', outputs: { ore: 120_000 }, rare: null },
  { id: 'west-dongtian', name: '赤霄洞天', regionId: 'west', tier: 'dongtian', outputs: { ore: 180_000 }, rare: null },
  { id: 'south-lingdi', name: '雾隐泉', regionId: 'south', tier: 'lingdi', outputs: { spiritualEnergy: 30_000 }, rare: null },
  { id: 'south-fudi', name: '云梦泽', regionId: 'south', tier: 'fudi', outputs: { spiritualEnergy: 50_000 }, rare: null },
  { id: 'south-dongtian', name: '碧落洞天', regionId: 'south', tier: 'dongtian', outputs: { spiritualEnergy: 80_000 }, rare: null },
  { id: 'north-lingdi', name: '残碑坡', regionId: 'north', tier: 'lingdi', outputs: { spiritStone: 50_000 }, rare: null },
  { id: 'north-fudi', name: '旧市墟', regionId: 'north', tier: 'fudi', outputs: { spiritStone: 80_000 }, rare: null },
  { id: 'north-dongtian', name: '藏金洞天', regionId: 'north', tier: 'dongtian', outputs: { spiritStone: 120_000 }, rare: null },
  {
    id: 'center-xuantie',
    name: '玄铁祖脉',
    regionId: 'center',
    tier: 'zumai',
    outputs: { spiritualEnergy: 80_000 },
    rare: { resourceId: 'xuantie' },
  },
  {
    id: 'center-shenmu',
    name: '神木祖脉',
    regionId: 'center',
    tier: 'zumai',
    outputs: { spiritualEnergy: 80_000 },
    rare: { resourceId: 'shenmu' },
  },
];

export function findWorldSite(siteId: string): WorldSiteDef | undefined {
  return WORLD_SITES.find((site) => site.id === siteId);
}

export function findWorldRegion(regionId: string): WorldRegionDef | undefined {
  return WORLD_REGIONS.find((region) => region.id === regionId);
}

/** 灵地全名（「青木域 · 百草谷」）；查不到时退化为 id，不伪造名字。 */
export function worldSiteFullName(siteId: string): string {
  const site = findWorldSite(siteId);
  if (site === undefined) return siteId;
  return `${findWorldRegion(site.regionId)?.name ?? site.regionId} · ${site.name}`;
}

export function worldTierName(tier: WorldSiteTier | string): string {
  return WORLD_SITE_TIERS.find((item) => item.id === tier)?.name ?? '';
}

/** 镇守名额：宗门 3～5 级 1 处，6～8 级 2 处，9 级及以上 3 处；未开放（不到 3 级）为 0。 */
export function worldSiteCapOf(sectLevel: number): number {
  if (sectLevel < WORLD_UNLOCK_SECT_LEVEL) return 0;
  if (sectLevel <= 5) return 1;
  if (sectLevel <= 8) return 2;
  return 3;
}

/** 向下取整到整点（毫秒）。 */
export function hourFloor(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/** 向上取整到整点（毫秒）；已经是整点时返回自身。 */
export function hourCeil(ms: number): number {
  return Math.ceil(ms / HOUR_MS) * HOUR_MS;
}

/* ---------- 供奉（整点结算） ---------- */

export interface WorldSettlement {
  /** 本次结算的完整整点小时数（0 = 什么都不给）。 */
  hours: number;
  /** 资源 id → 入账（最小单位，未经仓库容量夹住）；hours 为 0 时为空对象。 */
  credits: Record<string, number>;
  /** 本次结算出的稀有材料次数（只有祖脉有；每次 WORLD_RARE_PER_DROP 个）。 */
  rareCount: number;
  /** 结算后的 settled_at（整点）。 */
  nextSettledAt: number;
  /** 结算后祖脉的稀有进度（0～5）。 */
  nextRareHours: number;
}

/**
 * 按整点结算一处灵地（纯函数，计划 1.5）。
 * - 只算完整持有的整点小时 [settledAt, hourFloor(now))；不满一小时的部分作废；
 * - settledAt 恒为整点（占领时 = 下一个整点），所以相减一定整除；
 * - 祖脉：rareHours + hours 每满 6 个结算一次（5 个稀有材料），余数留到下次。
 */
export function settleWorldSite(input: {
  outputs: Readonly<Record<string, number>>;
  rare: { resourceId: string } | null;
  settledAt: number;
  rareHours: number;
  now: number;
}): WorldSettlement {
  const boundary = hourFloor(input.now);
  if (input.settledAt >= boundary) {
    return { hours: 0, credits: {}, rareCount: 0, nextSettledAt: input.settledAt, nextRareHours: input.rareHours };
  }
  const hours = Math.floor((boundary - input.settledAt) / HOUR_MS);
  const credits: Record<string, number> = {};
  for (const [resourceId, perHour] of Object.entries(input.outputs)) {
    credits[resourceId] = perHour * hours;
  }
  let rareCount = 0;
  let nextRareHours = input.rareHours;
  if (input.rare !== null) {
    const total = input.rareHours + hours;
    rareCount = Math.floor(total / WORLD_RARE_EVERY_HOURS);
    nextRareHours = total % WORLD_RARE_EVERY_HOURS;
    if (rareCount > 0) {
      credits[input.rare.resourceId] =
        (credits[input.rare.resourceId] ?? 0) + rareCount * WORLD_RARE_PER_DROP * WORLD_RARE_UNIT;
    }
  }
  return { hours, credits, rareCount, nextSettledAt: boundary, nextRareHours };
}

/* ---------- 斗法限制 ---------- */

/** 是否「欺负新人」：守方宗门等级比进攻方低 WORLD_LEVEL_GAP 级及以上。 */
export function isWorldLevelGapBlocked(attackerLevel: number, defenderLevel: number): boolean {
  return attackerLevel - defenderLevel >= WORLD_LEVEL_GAP;
}

/* ---------- 对决 ---------- */

export interface WorldBattleRound {
  round: number;
  attackerName: string;
  attackerPower: number;
  /** 守方这一回合缺席（被驱逐 / 重伤 / 妖兽已无）时为 null。 */
  defenderName: string | null;
  defenderPower: number | null;
  winner: 'attacker' | 'defender';
}

/**
 * 三局两胜：第 i 回合是进攻第 i 人对守军第 i 人；双方战力各 ×(0.85～1.15)，
 * 有主灵地的守方再 ×1.1（defenderBonus = true；盘踞妖兽不加），高者胜。
 * 守军第 i 人缺席（null）时这一回合进攻方直接胜。先拿到 2 胜就结束。
 * 随机源取用顺序：每回合先进攻方浮动、再守方浮动（缺席回合不取）。
 */
export function resolveWorldBattle(input: {
  attackers: readonly { name: string; power: number }[];
  defenders: readonly ({ name: string; power: number } | null)[];
  defenderBonus: boolean;
  random: () => number;
}): { rounds: WorldBattleRound[]; won: boolean } {
  const rounds: WorldBattleRound[] = [];
  const defenderBonusBp = input.defenderBonus ? WORLD_DEFENDER_BONUS_BP : 0;
  let attackerWins = 0;
  let defenderWins = 0;
  for (let index = 0; index < WORLD_PARTY_SIZE; index += 1) {
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
      ((defender.power * (0.85 + input.random() * 0.3)) * (10_000 + defenderBonusBp)) / 10_000,
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

const BEAST_NAMES = ['盘踞妖兽 · 壹', '盘踞妖兽 · 贰', '盘踞妖兽 · 叁'] as const;

/** 无主灵地的 3 只盘踞妖兽：第 i 只的战力 = 进攻方第 i 人战力 × 0.9（取整）。 */
export function beastDefenders(attackers: readonly { power: number }[]): { name: string; power: number }[] {
  return BEAST_NAMES.map((name, index) => ({
    name,
    power: Math.floor(((attackers[index]?.power ?? 0) * WORLD_BEAST_POWER_BP) / 10_000),
  }));
}

/** 坐镇 JSON（弟子 id 数组）解析；脏数据返回空数组。 */
export function parseGarrison(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
