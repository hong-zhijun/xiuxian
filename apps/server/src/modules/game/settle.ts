import type { GameConfigContent } from '@xiuxian/game-core';

import {
  SCRIPTURE_LIBRARY_BUILDING_ID,
  SCRIPTURE_LIBRARY_CULTIVATION_BONUS_BP_PER_LEVEL,
  TALENT_CULTIVATION_BONUS_BP,
  TALENT_POSITION_BONUS_BP,
  effectiveCapacity,
  findStage,
} from './constants';
import { triggerEvents, type TriggeredEvent } from './events';

/**
 * 离线结算（纯计算；规则来自 03 第 3、4 节 + P3 随机事件）。
 *
 * 关键点：
 * - 只累计 [lastSettledAt, lastSettledAt + min(elapsed, 12h)]，超过上限的时段永久丢弃；
 * - 产量与修为都用「最小单位/小时 × 毫秒 + 余数」的整数算法，余数保留到下次；
 * - 资源触顶时丢弃溢出与小数余量；修为到突破门槛时停止积累并清理余量；
 * - 资源/修为结算完成后追加一次事件判定（P3 第 3 节）：这是本函数**唯一**的随机来源，
 *   通过可选参数 `random`（默认 Math.random）注入，便于测试；
 * - 所有数值来自配置，函数本身不读数据库、不取时间。
 */
export interface ResourceState {
  resourceId: string;
  balance: number;
  remainder: number;
}

export interface DiscipleState {
  id: string;
  aptitude: number;
  realmId: string;
  stage: number;
  cultivation: number;
  cultivationRemainder: number;
  assignment: string;
  /** V4 天赋 id（见 constants.ts 的 TALENTS）；缺省由调用方保证。 */
  talent: string;
}

export interface SettleInput {
  config: GameConfigContent;
  lastSettledAt: number;
  now: number;
  resources: readonly ResourceState[];
  disciples: readonly DiscipleState[];
  /** 宗门等级的资源容量倍率（默认 1；不传时与旧行为完全一致）。 */
  capacityMultiplier?: number;
  /** 建筑等级表（defId -> level），用于计算藏经阁的修炼加速。 */
  buildingLevels?: Record<string, number>;
}

export interface SettledResource extends ResourceState {
  /** 本段结算使用的产量（最小单位/小时，含岗位弟子贡献）。 */
  ratePerHour: number;
  /** 因容量不足丢弃的量（最小单位）。 */
  discarded: number;
  /** 本段结束时是否已满仓（满仓会丢弃小数余量）。 */
  capped: boolean;
}

export interface SettledDisciple {
  id: string;
  cultivation: number;
  cultivationRemainder: number;
  /** 本段结算使用的修炼速度（修为/小时）。 */
  ratePerHour: number;
}

export interface SettleResult {
  /** 新的最后结算时间（max(lastSettledAt, now)）；时钟回拨时不回拨。 */
  lastSettledAt: number;
  /** 本段实际计收益的毫秒数（已按 12 小时上限截断）。 */
  durationMs: number;
  cappedByOfflineLimit: boolean;
  clockWentBackwards: boolean;
  resources: SettledResource[];
  disciples: SettledDisciple[];
  totalDiscarded: number;
  /** 本段结算触发的事件（P3 第 3 节）；效果已直接作用到 resources 余额上。 */
  events: TriggeredEvent[];
}

const MS_PER_HOUR = 3_600_000;

export function settleEconomy(input: SettleInput, random: () => number = Math.random): SettleResult {
  const { config, lastSettledAt, now, resources, disciples } = input;
  const capacityMultiplier = input.capacityMultiplier ?? 1;
  const scriptureLibraryLevel = input.buildingLevels?.[SCRIPTURE_LIBRARY_BUILDING_ID] ?? 0;
  const elapsed = Math.max(0, now - lastSettledAt);
  const durationMs = Math.min(elapsed, config.offlineCapSeconds * 1000);

  const rateByResource = resourceRates(config, disciples);
  const settledResources = resources.map((resource) =>
    settleResource(
      resource,
      config,
      rateByResource.get(resource.resourceId) ?? 0,
      durationMs,
      capacityMultiplier,
    ),
  );

  const settledDisciples = disciples.map((disciple) =>
    settleDisciple(disciple, config, durationMs, scriptureLibraryLevel),
  );

  // P3 第 3 节：资源/修为结算完成后再判定事件，效果直接叠加到结算结果余额上。
  const events = triggerEvents(durationMs, random);
  applyEventEffects(settledResources, config, events, capacityMultiplier);

  return {
    lastSettledAt: Math.max(lastSettledAt, now),
    durationMs,
    cappedByOfflineLimit: elapsed > durationMs,
    clockWentBackwards: now < lastSettledAt,
    resources: settledResources,
    disciples: settledDisciples,
    totalDiscarded: settledResources.reduce((sum, item) => sum + item.discarded, 0),
    events,
  };
}

/**
 * 把事件效果叠加到结算结果余额上：资源不低于 0、不超过该资源容量（P3 第 3 节）。
 * 只改 balance（整数最小单位），不动产量/余数/丢弃量这类产量结算字段。
 */
function applyEventEffects(
  resources: SettledResource[],
  config: GameConfigContent,
  events: readonly TriggeredEvent[],
  capacityMultiplier: number,
): void {
  for (const event of events) {
    for (const [resourceId, amountText] of Object.entries(event.effects)) {
      const settled = resources.find((item) => item.resourceId === resourceId);
      if (settled === undefined) {
        continue;
      }
      const definition = config.resources.find((item) => item.id === resourceId);
      // 容量按宗门等级倍率放大后再夹取，否则升级后的加成就被基础容量截断了。
      const capacity =
        definition === undefined
          ? Number.MAX_SAFE_INTEGER
          : effectiveCapacity(definition.capacity, capacityMultiplier);
      settled.balance = Math.min(capacity, Math.max(0, settled.balance + Number(amountText)));
    }
  }
}

/** 每种资源的产量 = 基础产量 + 所有岗位弟子的产出（配置驱动，不硬编码）。 */
export function resourceRates(
  config: GameConfigContent,
  disciples: readonly DiscipleState[],
): Map<string, number> {
  const rates = new Map<string, number>();
  for (const resource of config.resources) {
    rates.set(resource.id, Number(resource.baseRatePerHour));
  }

  const positions = new Map<string, { outputPerHourPerDisciple: Record<string, string> }>(
    config.positions.map((position) => [String(position.id), position]),
  );
  for (const disciple of disciples) {
    const position = positions.get(disciple.assignment);
    if (position === undefined) {
      continue;
    }
    // V4 4.2：天赋匹配当前岗位时该弟子的产出 ×1.2（基点 12000 vs 10000）。
    const talentMatch =
      (disciple.talent === 'herbGathering' && disciple.assignment === 'herbGathering') ||
      (disciple.talent === 'mining' && disciple.assignment === 'oreGathering');
    const bonusMultiplier = talentMatch ? 10_000 + TALENT_POSITION_BONUS_BP : 10_000;

    for (const [resourceId, amountText] of Object.entries(position.outputPerHourPerDisciple)) {
      const base = Number(amountText);
      const effective = Math.floor((base * bonusMultiplier) / 10_000);
      rates.set(resourceId, (rates.get(resourceId) ?? 0) + effective);
    }
  }

  return rates;
}

/** 单名修炼弟子的修为速度（修为/小时）：基础 × (资质系数 / 10000) × 藏经阁加成，加成按配置封顶。 */
export function cultivationRatePerHour(
  config: GameConfigContent,
  disciple: DiscipleState,
  scriptureLibraryLevel = 0,
): number {
  if (disciple.assignment !== 'cultivating') {
    return 0;
  }
  const rawBonusBp = disciple.aptitude * config.cultivation.aptitudeCoefficientPerPointBp;
  const bonusBp = Math.min(rawBonusBp, config.cultivation.maxTotalBonusBp);
  const coefficientBp = config.cultivation.aptitudeCoefficientBaseBp + bonusBp;
  const baseRate = Math.floor((config.cultivation.baseRatePerHour * coefficientBp) / 10_000);
  // 藏经阁加成：每级 +10%
  const libraryBonusBp = scriptureLibraryLevel * SCRIPTURE_LIBRARY_CULTIVATION_BONUS_BP_PER_LEVEL;
  const result = Math.floor((baseRate * (10_000 + libraryBonusBp)) / 10_000);
  // V4 4.3：修炼天赋在藏经阁加成之后再 ×1.2。
  if (disciple.talent === 'cultivation') {
    return Math.floor((result * (10_000 + TALENT_CULTIVATION_BONUS_BP)) / 10_000);
  }
  return result;
}

function settleResource(
  resource: ResourceState,
  config: GameConfigContent,
  ratePerHour: number,
  durationMs: number,
  capacityMultiplier: number,
): SettledResource {
  const definition = config.resources.find((item) => item.id === resource.resourceId);
  const capacity =
    definition === undefined
      ? Number.MAX_SAFE_INTEGER
      : effectiveCapacity(definition.capacity, capacityMultiplier);

  if (ratePerHour <= 0 || durationMs <= 0) {
    return { ...resource, ratePerHour, discarded: 0, capped: resource.balance >= capacity };
  }

  const numerator = ratePerHour * durationMs + resource.remainder;
  const gain = Math.floor(numerator / MS_PER_HOUR);
  let remainder = numerator % MS_PER_HOUR;

  const room = Math.max(0, capacity - resource.balance);
  const accepted = Math.min(gain, room);
  const balance = resource.balance + accepted;
  const capped = balance >= capacity;
  if (capped) {
    // 满仓时丢弃小数余量，避免满仓暗存收益（03 第 3 节）
    remainder = 0;
  }

  return { resourceId: resource.resourceId, balance, remainder, ratePerHour, discarded: gain - accepted, capped };
}

function settleDisciple(
  disciple: DiscipleState,
  config: GameConfigContent,
  durationMs: number,
  scriptureLibraryLevel: number,
): SettledDisciple {
  const ratePerHour = cultivationRatePerHour(config, disciple, scriptureLibraryLevel);
  if (ratePerHour <= 0 || durationMs <= 0) {
    return {
      id: disciple.id,
      cultivation: disciple.cultivation,
      cultivationRemainder: disciple.cultivationRemainder,
      ratePerHour,
    };
  }

  const numerator = ratePerHour * durationMs + disciple.cultivationRemainder;
  const gain = Math.floor(numerator / MS_PER_HOUR);
  let remainder = numerator % MS_PER_HOUR;

  const threshold = findStage(disciple.realmId, disciple.stage).requiredCultivation;
  let cultivation = disciple.cultivation + gain;
  if (threshold !== null && cultivation >= threshold) {
    // 到突破门槛就停止积累并清理余量（不会自动突破）
    cultivation = threshold;
    remainder = 0;
  }

  return { id: disciple.id, cultivation, cultivationRemainder: remainder, ratePerHour };
}
