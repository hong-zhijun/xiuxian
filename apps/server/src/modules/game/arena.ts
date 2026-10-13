/**
 * 宗门大比（docs/宗门大比开发计划.md）——纯定义与纯计算。
 *
 * 与 tower.ts / worldBoss.ts 同一做法：常量、奖励表、战斗模拟、阵容选取都在这里，不读库、不取时间、
 * 不调用 Math.random（随机源通过参数注入）。金额一律是展示单位，入库前由 service 乘 1000。
 *
 * 规则要点：
 * - 个人赛（斗法台）：各宗门报名的弟子两两对战（同宗门不互打）；未报名的宗门自动取战力最强的 5 人。
 * - 团队赛（宗门战）：宗门两两车轮战；赢方弟子带着剩余血量留场，输方换下一人（满血）。
 * - 以弱克强：弱方属性按战力差补偿（上限 50%）；团队赛再按宗门总战力补偿，两层取较大值。
 * - 团队赛战力上限：宗门等级 ≥ 2 的宗门「前 5 弟子总战力」的平均值，每周一 0 点算定，赛季内不变。
 */

import { dateKeyUtc8 } from './constants';

/* ---------- 参赛与时间 ---------- */

/** 报名名单上限（个人赛与团队赛各自最多 5 人）。 */
export const ARENA_MAX_ENTRY = 5;
/** 每天几点（UTC+8）结算；0 点起可报名，到这个整点为止。 */
export const ARENA_SETTLE_HOUR = 12;
/** 宗门等级达到几级才能参赛。 */
export const ARENA_UNLOCK_SECT_LEVEL = 2;
/** 日榜 / 赛季榜显示的名次上限。 */
export const ARENA_RANKING_SIZE = 20;
/** 战报、日积分、阵容只保留最近几天（定时任务清理）。 */
export const ARENA_RECORD_KEEP_DAYS = 2;

/* ---------- 战斗系数 ---------- */

/** 单场最多回合数。 */
export const ARENA_MAX_ROUNDS = 10;
/** 只为数字好看：伤害与血量都按同一比例放大（与镇妖塔相同）。 */
export const ARENA_DAMAGE_SCALE = 100;
/** 弟子血量 = 4.5 × 战力 ×（0.5 + 体魄 / 100）（与镇妖塔相同）。 */
export const ARENA_HP_FACTOR = 4.5;
/** 出手伤害浮动（均匀随机）。 */
export const ARENA_FLUCTUATION: readonly [number, number] = [0.8, 1.2];
/** 暴击：幸运 100 → 20%；暴击伤害 ×1.5。 */
export const ARENA_CRIT_RATE_MAX = 0.2;
export const ARENA_CRIT_MULTIPLIER = 1.5;
/** 追击：身法每高出对手 1 点 +0.5%，最高 30%。 */
export const ARENA_EXTRA_ACTION_PER_POINT = 0.005;
export const ARENA_EXTRA_ACTION_MAX = 0.3;
/** 攻击修正的参照属性（新弟子的平均值）与比值上限：0.75 + 0.25 × min(2, 攻击 / 50)。 */
export const ARENA_BASE_ATTR = 50;
export const ARENA_ATTACK_RATIO_CAP = 2;
/** 以弱克强：补偿系数上限与「(对方 / 我方 − 1) × 系数」里的系数。 */
export const ARENA_HANDICAP_MAX = 0.5;
export const ARENA_HANDICAP_FACTOR = 0.5;

/* ---------- 瑞士轮 ---------- */

/** 瑞士轮轮数（个人赛与团队赛统一）。 */
export const ARENA_SWISS_ROUNDS = 5;

/* ---------- 加权积分 ---------- */

/** 对手战力 / 我方战力的阈值：> 1.2 = 强者，< 0.8 = 弱者。 */
export const ARENA_WEIGHT_STRONG_RATIO = 1.2;
export const ARENA_WEIGHT_WEAK_RATIO = 0.8;

export const ARENA_WIN_STRONG_POINTS = 5;
export const ARENA_WIN_EVEN_POINTS = 3;
export const ARENA_WIN_WEAK_POINTS = 1;
export const ARENA_DRAW_POINTS = 1;
export const ARENA_LOSS_POINTS = 0;

/** 根据双方战力比返回胜方得分（赢强者 5、赢相近 3、赢弱者 1）。 */
export function arenaWeightedWinPoints(winnerPower: number, loserPower: number): number {
  if (winnerPower <= 0) return ARENA_WIN_STRONG_POINTS;
  const ratio = loserPower / winnerPower;
  if (ratio > ARENA_WEIGHT_STRONG_RATIO) return ARENA_WIN_STRONG_POINTS;
  if (ratio >= ARENA_WEIGHT_WEAK_RATIO) return ARENA_WIN_EVEN_POINTS;
  return ARENA_WIN_WEAK_POINTS;
}

/** 旧常量别名（团队赛胜方固定 3 分，保持与个人赛区分）。 */
export const ARENA_WIN_POINTS = 3;

/* ---------- 奖励（展示单位；入库时 × 1000，修为丹为颗数） ---------- */

export const ARENA_DAILY_INDIVIDUAL_REWARDS: readonly { rank: number; spiritStone: number; cultivationPill: number }[] = [
  { rank: 1, spiritStone: 1000, cultivationPill: 5 },
  { rank: 2, spiritStone: 600, cultivationPill: 0 },
  { rank: 3, spiritStone: 600, cultivationPill: 0 },
];
/** 日榜其余名次的参与奖（所有参赛弟子都有，奖励归其宗门）。 */
export const ARENA_DAILY_INDIVIDUAL_PARTICIPATION = { spiritStone: 300, cultivationPill: 0 };

export const ARENA_DAILY_TEAM_REWARDS: readonly { rank: number; spiritStone: number; ore: number; merit: number }[] = [
  { rank: 1, spiritStone: 1500, ore: 750, merit: 25 },
  { rank: 2, spiritStone: 900, ore: 400, merit: 15 },
  { rank: 3, spiritStone: 900, ore: 400, merit: 15 },
];
export const ARENA_DAILY_TEAM_PARTICIPATION = { spiritStone: 400, ore: 200, merit: 5 };

export const ARENA_SEASON_INDIVIDUAL_REWARDS: readonly { rank: number; spiritStone: number; cultivationPill: number }[] = [
  { rank: 1, spiritStone: 500, cultivationPill: 3 },
  { rank: 2, spiritStone: 300, cultivationPill: 1 },
  { rank: 3, spiritStone: 300, cultivationPill: 1 },
];

export const ARENA_SEASON_TEAM_REWARDS: readonly { rank: number; spiritStone: number; merit: number; xuantie: number }[] = [
  { rank: 1, spiritStone: 1000, merit: 15, xuantie: 3 },
  { rank: 2, spiritStone: 500, merit: 8, xuantie: 1 },
  { rank: 3, spiritStone: 500, merit: 8, xuantie: 1 },
];

/** 修为丹（个人赛奖励的丹药 id；数量为颗数，不乘 1000）。 */
export const ARENA_PILL_ID = 'cultivationPill';

/** 日榜个人奖（按名次；1~3 名有专属档，其余为参与奖）。 */
export function dailyIndividualReward(rank: number): { spiritStone: number; cultivationPill: number } {
  const item = ARENA_DAILY_INDIVIDUAL_REWARDS.find((row) => row.rank === rank) ?? ARENA_DAILY_INDIVIDUAL_PARTICIPATION;
  return { spiritStone: item.spiritStone, cultivationPill: item.cultivationPill };
}

/** 日榜宗门奖（按名次；1~3 名有专属档，其余为参与奖）。 */
export function dailyTeamReward(rank: number): { spiritStone: number; ore: number; merit: number } {
  const item = ARENA_DAILY_TEAM_REWARDS.find((row) => row.rank === rank) ?? ARENA_DAILY_TEAM_PARTICIPATION;
  return { spiritStone: item.spiritStone, ore: item.ore, merit: item.merit };
}

/** 赛季天榜奖（只有前三名有奖，其余为 0）。 */
export function seasonIndividualReward(rank: number): { spiritStone: number; cultivationPill: number } {
  const item = ARENA_SEASON_INDIVIDUAL_REWARDS.find((row) => row.rank === rank);
  return { spiritStone: item?.spiritStone ?? 0, cultivationPill: item?.cultivationPill ?? 0 };
}

/** 赛季宗榜奖（只有前三名有奖，其余为 0）。 */
export function seasonTeamReward(rank: number): { spiritStone: number; merit: number; xuantie: number } {
  const item = ARENA_SEASON_TEAM_REWARDS.find((row) => row.rank === rank);
  return { spiritStone: item?.spiritStone ?? 0, merit: item?.merit ?? 0, xuantie: item?.xuantie ?? 0 };
}

/* ---------- 赛季与结算时点 ---------- */

const DAY_MS = 86_400_000;
const UTC8_OFFSET_MS = 8 * 3_600_000;

/** UTC+8 的小时（0~23）。 */
export function arenaHourOf(now: number): number {
  return new Date(now + UTC8_OFFSET_MS).getUTCHours();
}

/** 到了结算时点（UTC+8 的小时 ≥ 12）。定时任务每 10 分钟跑一次，所以取「≥」以便漏跑后下一次补上。 */
export function isArenaSettleTime(nowHour: number): boolean {
  return nowHour >= ARENA_SETTLE_HOUR;
}

/** 周日（UTC+8）：当天 12 点结算完日赛后，顺带结算赛季。 */
export function isArenaSundaySettle(now: number): boolean {
  return new Date(now + UTC8_OFFSET_MS).getUTCDay() === 0;
}

/**
 * 赛季：一周一季，按 ISO 周编号（周一 0 点开始，周日 12 点收官）。
 * 返回 id（如 '2026-W42'）以及起止日期（UTC+8 的 'YYYY-MM-DD'）。
 */
export function arenaSeasonRange(now: number): { id: string; startDate: string; endDate: string } {
  const local = new Date(now + UTC8_OFFSET_MS);
  const weekday = (local.getUTCDay() + 6) % 7;
  const monday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - weekday);
  // ISO 周编号以周四所在的年份与周次为准。
  const thursday = new Date(monday + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return {
    id: `${String(year)}-W${String(week).padStart(2, '0')}`,
    startDate: new Date(monday).toISOString().slice(0, 10),
    endDate: new Date(monday + 6 * DAY_MS).toISOString().slice(0, 10),
  };
}

/** 赛季 id（如 '2026-W42'）。 */
export function arenaSeasonId(now: number): string {
  return arenaSeasonRange(now).id;
}

/** 团队赛战力上限：各宗门「前 5 弟子总战力」的平均值（向下取整）；没有宗门时为 0。 */
export function calculateTeamPowerCap(sectPowers: readonly number[]): number {
  if (sectPowers.length === 0) return 0;
  const sum = sectPowers.reduce((total, power) => total + Math.max(0, power), 0);
  return Math.floor(sum / sectPowers.length);
}

/* ---------- 以弱克强 ---------- */

/**
 * 补偿系数：我方战力不如对方时 = min(0.5, (对方 / 我方 − 1) × 0.5)，否则 0。
 * 例：300 对 600 → 弱方 +50%。
 */
export function arenaHandicap(myPower: number, opponentPower: number): number {
  if (myPower >= opponentPower) return 0;
  if (myPower <= 0) return ARENA_HANDICAP_MAX;
  return Math.min(ARENA_HANDICAP_MAX, (opponentPower / myPower - 1) * ARENA_HANDICAP_FACTOR);
}

/* ---------- 战斗 ---------- */

export interface ArenaFighter {
  id: string;
  name: string;
  /** 战力（计入装备与战意）：伤害基数，血量也由它算。 */
  power: number;
  attack: number;
  defense: number;
  speed: number;
  luck: number;
  physique: number;
}

export interface ArenaHit {
  fighterId: string;
  name: string;
  damage: number;
  crit: boolean;
  /** 身法追击（同一次出手后的第二击）。 */
  extra: boolean;
}

export interface ArenaRound {
  round: number;
  /** 本回合先出手的弟子。 */
  firstId: string;
  hits: ArenaHit[];
  /** 回合结束时的剩余血量（已 × DAMAGE_SCALE）。 */
  fighterAHp: number;
  fighterBHp: number;
}

export interface ArenaDuelResult {
  /** null = 平局（10 回合后剩余血量百分比相同）。 */
  winnerId: string | null;
  rounds: ArenaRound[];
  /** 打完时的剩余血量百分比（0~100；活着的至少 1）。 */
  fighterAHpPct: number;
  fighterBHpPct: number;
  /** 打完时的剩余血量（已 × DAMAGE_SCALE）；团队赛赢方据此带血打下一场。 */
  fighterAHp: number;
  fighterBHp: number;
  fighterAMaxHp: number;
  fighterBMaxHp: number;
  /** 本场双方造成的伤害合计。 */
  fighterADamage: number;
  fighterBDamage: number;
}

/** 弟子血量 = 4.5 × 战力 ×（0.5 + 体魄 / 100）（已 × DAMAGE_SCALE）。 */
export function arenaFighterHp(power: number, physique: number): number {
  return Math.max(
    1,
    Math.floor(ARENA_HP_FACTOR * Math.max(0, power) * (0.5 + Math.max(0, physique) / 100) * ARENA_DAMAGE_SCALE),
  );
}

/** 防御减免：承伤比例 = 100 / (100 + 防御)。 */
export function arenaDefenseFactor(defense: number): number {
  return 100 / (100 + Math.max(0, defense));
}

/** 暴击率：幸运 / 100 × 20%，最高 100%。 */
export function arenaCritRate(luck: number): number {
  return Math.min(1, (Math.max(0, luck) / 100) * ARENA_CRIT_RATE_MAX);
}

/** 追击概率：(我方身法 − 对方身法) × 0.5%，夹在 0~30%。 */
export function arenaExtraActionChance(mySpeed: number, opponentSpeed: number): number {
  return Math.min(ARENA_EXTRA_ACTION_MAX, Math.max(0, (mySpeed - opponentSpeed) * ARENA_EXTRA_ACTION_PER_POINT));
}

/** 攻击修正：0.75 + 0.25 × min(2, 攻击 / 50)。 */
export function arenaAttackFactor(attack: number): number {
  const ratio = Math.min(ARENA_ATTACK_RATIO_CAP, Math.max(0, attack) / ARENA_BASE_ATTR);
  return 0.75 + 0.25 * ratio;
}

/** 把补偿系数乘到攻击 / 防御 / 身法 / 幸运 / 体魄上（返回新对象，不改原值；战力不变）。 */
export function applyHandicap(fighter: ArenaFighter, handicapCoeff: number): ArenaFighter {
  const multiplier = 1 + Math.max(0, handicapCoeff);
  return {
    ...fighter,
    attack: fighter.attack * multiplier,
    defense: fighter.defense * multiplier,
    speed: fighter.speed * multiplier,
    luck: fighter.luck * multiplier,
    physique: fighter.physique * multiplier,
  };
}

function between(random: () => number, range: readonly [number, number]): number {
  return range[0] + random() * (range[1] - range[0]);
}

function clampHp(hp: number, max: number): number {
  return Math.min(max, Math.max(0, hp));
}

/** 百分比：已倒下为 0，还活着至少显示 1。 */
function hpPctOf(hp: number, max: number): number {
  if (hp <= 0) return 0;
  return Math.max(1, Math.round((hp / max) * 100));
}

/**
 * 一场 1v1（最多 10 回合，当场算完）。
 *
 * - 每回合身法高者先出手（同身法时甲方先）；每次出手伤害 = 战力 × 攻击修正 × 浮动 × 暴击 × 防御减免 × DAMAGE_SCALE；
 * - 出手后按追击概率再出一击（追击不再追击）；血量归零立即结束；
 * - 10 回合打完未分胜负：剩余血量百分比高者胜，相同为平局（winnerId = null）；
 * - startHpA / startHpB 为续战时的剩余血量（缺省满血）：团队赛赢方带血留场用。
 *
 * 随机源取用顺序（测试依赖它）：每次出手依次取「浮动 → 暴击」，然后取一次「追击判定」，追击时再取「浮动 → 暴击」。
 * 补偿系数由调用方先用 applyHandicap 作用到两名弟子身上。
 */
export function simulateArenaDuel(input: {
  fighterA: ArenaFighter;
  fighterB: ArenaFighter;
  startHpA?: number;
  startHpB?: number;
  random: () => number;
}): ArenaDuelResult {
  const { fighterA, fighterB, random } = input;
  const maxHpA = arenaFighterHp(fighterA.power, fighterA.physique);
  const maxHpB = arenaFighterHp(fighterB.power, fighterB.physique);
  let hpA = clampHp(input.startHpA ?? maxHpA, maxHpA);
  let hpB = clampHp(input.startHpB ?? maxHpB, maxHpB);
  let damageA = 0;
  let damageB = 0;
  const rounds: ArenaRound[] = [];

  /** 一次出手；返回 true 表示对方倒下。 */
  const strike = (attacker: ArenaFighter, defender: ArenaFighter, attackerIsA: boolean, extra: boolean, hits: ArenaHit[]): boolean => {
    const fluctuation = between(random, ARENA_FLUCTUATION);
    const crit = random() < arenaCritRate(attacker.luck);
    const raw =
      attacker.power * arenaAttackFactor(attacker.attack) * fluctuation * (crit ? ARENA_CRIT_MULTIPLIER : 1);
    const damage = Math.floor(raw * arenaDefenseFactor(defender.defense) * ARENA_DAMAGE_SCALE);
    hits.push({ fighterId: attacker.id, name: attacker.name, damage, crit, extra });
    if (attackerIsA) {
      damageA += damage;
      hpB = Math.max(0, hpB - damage);
      return hpB <= 0;
    }
    damageB += damage;
    hpA = Math.max(0, hpA - damage);
    return hpA <= 0;
  };

  /** 一方的一个出手回合：先一击，未倒下则按追击概率再一击。 */
  const turn = (attackerIsA: boolean, hits: ArenaHit[]): boolean => {
    const attacker = attackerIsA ? fighterA : fighterB;
    const defender = attackerIsA ? fighterB : fighterA;
    if (strike(attacker, defender, attackerIsA, false, hits)) return true;
    if (random() < arenaExtraActionChance(attacker.speed, defender.speed)) {
      return strike(attacker, defender, attackerIsA, true, hits);
    }
    return false;
  };

  for (let round = 1; round <= ARENA_MAX_ROUNDS; round += 1) {
    const aFirst = fighterA.speed >= fighterB.speed;
    const hits: ArenaHit[] = [];
    if (!turn(aFirst, hits)) {
      turn(!aFirst, hits);
    }
    rounds.push({
      round,
      firstId: aFirst ? fighterA.id : fighterB.id,
      hits,
      fighterAHp: hpA,
      fighterBHp: hpB,
    });
    if (hpA <= 0 || hpB <= 0) break;
  }

  const aDown = hpA <= 0;
  const bDown = hpB <= 0;
  let winnerId: string | null;
  if (aDown !== bDown) {
    winnerId = aDown ? fighterB.id : fighterA.id;
  } else {
    const pctA = hpA / maxHpA;
    const pctB = hpB / maxHpB;
    winnerId = pctA === pctB ? null : pctA > pctB ? fighterA.id : fighterB.id;
  }

  return {
    winnerId,
    rounds,
    fighterAHpPct: hpPctOf(hpA, maxHpA),
    fighterBHpPct: hpPctOf(hpB, maxHpB),
    fighterAHp: hpA,
    fighterBHp: hpB,
    fighterAMaxHp: maxHpA,
    fighterBMaxHp: maxHpB,
    fighterADamage: damageA,
    fighterBDamage: damageB,
  };
}

/* ---------- 阵容 ---------- */

/** 参与选人的候选弟子：战力（计入装备）与此刻能否出战。 */
export interface ArenaCandidate {
  id: string;
  combatPower: number;
  blocked: boolean;
}

/** 自动选人：能出战的弟子按战力从高到低取前 maxCount 名（同战力保持输入顺序）。 */
export function autoSelectLineup(candidates: readonly ArenaCandidate[], maxCount: number): string[] {
  return candidates
    .filter((candidate) => !candidate.blocked)
    .slice()
    .sort((a, b) => b.combatPower - a.combatPower)
    .slice(0, Math.max(0, maxCount))
    .map((candidate) => candidate.id);
}

/**
 * 团队赛阵容修正：去掉不能出战的人，缺额用战力最高的候补补齐（人数与原阵容相同）；
 * 总战力超过上限时，从最强的出战者起逐个换成下一名候补（战力最高的未上场者），直到不超限；
 * 候补用完仍超限，就从最弱的起逐个撤下，直到不超限（可能因此少于 5 人）。
 * powerCap 传 Infinity 时只做去伤与补齐（个人赛手动阵容用这一条）。
 */
export function adjustTeamLineup(
  candidates: readonly ArenaCandidate[],
  currentLineup: readonly string[],
  powerCap: number,
): string[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate] as const));
  const powerOf = (id: string): number => byId.get(id)?.combatPower ?? 0;
  const byPowerDesc = (a: ArenaCandidate, b: ArenaCandidate): number => b.combatPower - a.combatPower;

  const chosen = new Set(currentLineup);
  const reserve = candidates
    .filter((candidate) => !candidate.blocked && !chosen.has(candidate.id))
    .slice()
    .sort(byPowerDesc);
  // 按原排位保留；不能出战的人原地换成最强的候补（出战顺序不变）。
  const lineup: string[] = [];
  for (const id of new Set(currentLineup)) {
    const candidate = byId.get(id);
    if (candidate !== undefined && !candidate.blocked) {
      lineup.push(id);
    } else if (reserve.length > 0) {
      lineup.push(reserve.shift()!.id);
    }
  }
  while (lineup.length < currentLineup.length && reserve.length > 0) {
    lineup.push(reserve.shift()!.id);
  }

  let total = lineup.reduce((sum, id) => sum + powerOf(id), 0);
  const strongestFirst = [...lineup].sort((a, b) => powerOf(b) - powerOf(a));
  for (const outgoing of strongestFirst) {
    if (total <= powerCap || reserve.length === 0) break;
    const incoming = reserve.shift()!;
    lineup[lineup.indexOf(outgoing)] = incoming.id;
    total += incoming.combatPower - powerOf(outgoing);
  }
  while (total > powerCap && lineup.length > 0) {
    let weakest = 0;
    for (let index = 1; index < lineup.length; index += 1) {
      if (powerOf(lineup[index]!) < powerOf(lineup[weakest]!)) weakest = index;
    }
    total -= powerOf(lineup[weakest]!);
    lineup.splice(weakest, 1);
  }
  return lineup;
}

/* ---------- 赛程与榜单 ---------- */

/**
 * 循环赛配对（按下标）：两两配对，同组（同宗门）不互打。返回 [i, j]（i < j），顺序稳定。
 */
export function arenaCrossPairs(groups: readonly string[]): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      if (groups[i] !== groups[j]) pairs.push([i, j]);
    }
  }
  return pairs;
}

/**
 * 把按顺序排好的对阵分层（每一层里每名弟子最多一场）：依次放进第一个不冲突的层。
 * 返回每场所在层（1 起）。结算与读取战报都按同一份顺序调用，所以分层结果一致。
 */
export function arenaRoundLayers(pairs: readonly (readonly [string, string])[]): number[] {
  const layers: Set<string>[] = [];
  return pairs.map(([a, b]) => {
    let index = 0;
    while (index < layers.length && (layers[index]!.has(a) || layers[index]!.has(b))) index += 1;
    if (index === layers.length) layers.push(new Set<string>());
    layers[index]!.add(a);
    layers[index]!.add(b);
    return index + 1;
  });
}

/** 个人赛日榜排序：积分 → 胜场 → 造成伤害 → id。 */
export function sortArenaIndividuals<T extends { id: string; points: number; wins: number; damage: number }>(
  rows: readonly T[],
): T[] {
  return rows.slice().sort((a, b) => b.points - a.points || b.wins - a.wins || b.damage - a.damage || a.id.localeCompare(b.id));
}

/** 团队赛日榜排序：积分 → 总击杀 → id（同分看击杀数）。 */
export function sortArenaTeams<T extends { id: string; points: number; kills: number }>(rows: readonly T[]): T[] {
  return rows.slice().sort((a, b) => b.points - a.points || b.kills - a.kills || a.id.localeCompare(b.id));
}

/** 加权积分：胜方得分由双方战力比决定，平局固定 1 分，负方 0 分。 */
export function arenaWeightedOutcome(
  winner: 'a' | 'b' | null,
  powerA: number,
  powerB: number,
): { a: { points: number; wins: number; losses: number }; b: { points: number; wins: number; losses: number } } {
  if (winner === null) {
    return {
      a: { points: ARENA_DRAW_POINTS, wins: 0.5, losses: 0 },
      b: { points: ARENA_DRAW_POINTS, wins: 0.5, losses: 0 },
    };
  }
  const winPts =
    winner === 'a' ? arenaWeightedWinPoints(powerA, powerB) : arenaWeightedWinPoints(powerB, powerA);
  const won = { points: winPts, wins: 1, losses: 0 };
  const lost = { points: ARENA_LOSS_POINTS, wins: 0, losses: 1 };
  return winner === 'a' ? { a: won, b: lost } : { a: lost, b: won };
}

/**
 * 瑞士轮配对：按当前积分排名从高到低，依次为每人找积分最接近的未配对对手。
 * 同组（同宗门）不配对，已交手过的不再配对。无可配对对手的轮空。
 */
export function arenaSwissPair<T extends { index: number; groupId: string; points: number; wins: number; damage: number }>(
  entrants: readonly T[],
  played: ReadonlySet<string>,
): [number, number][] {
  const sorted = entrants.slice().sort((a, b) => b.points - a.points || b.wins - a.wins || b.damage - a.damage);
  const paired = new Set<number>();
  const pairs: [number, number][] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i]!;
    if (paired.has(a.index)) continue;
    for (let j = i + 1; j < sorted.length; j += 1) {
      const b = sorted[j]!;
      if (paired.has(b.index)) continue;
      if (a.groupId === b.groupId) continue;
      const lo = Math.min(a.index, b.index);
      const hi = Math.max(a.index, b.index);
      if (played.has(`${String(lo)}:${String(hi)}`)) continue;
      pairs.push([a.index, b.index]);
      paired.add(a.index);
      paired.add(b.index);
      break;
    }
  }
  return pairs;
}

/* ---------- 报名拦截 ---------- */

/**
 * 此刻能否出战（与出战入口同一套口径：在外历练、执事 / 交接期、坐镇、重伤卧床、疗伤）。
 * 能出战返回 null；不能返回一句原因（前端与报名报错直接用）。
 */
export function arenaFightBlockReason(input: {
  now: number;
  away: boolean;
  steward: boolean;
  stewardHandoverUntil: number | null;
  garrisoned: boolean;
  severeInjuredUntil: number | null;
  injuredUntil: number | null;
}): string | null {
  if (input.away) return '外出历练中';
  if (input.steward) return '任执事';
  if (input.stewardHandoverUntil !== null && input.stewardHandoverUntil > input.now) return '执事交接中';
  if (input.garrisoned) return '坐镇山河';
  if (input.severeInjuredUntil !== null && input.severeInjuredUntil > input.now) return '重伤卧床';
  if (input.injuredUntil !== null && input.injuredUntil > input.now) return '正在疗伤';
  return null;
}

/** 某个日期键（UTC+8）往前推 days 天。 */
export function arenaDateKeyBefore(now: number, days: number): string {
  return dateKeyUtc8(now - days * DAY_MS);
}
