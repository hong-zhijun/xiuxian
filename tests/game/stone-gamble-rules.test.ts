import { describe, expect, it } from 'vitest';

import {
  STONE_BATCH_COUNTS,
  STONE_CHANCE_TOTAL_BP,
  STONE_HISTORY_LIMIT,
  STONE_MATERIAL_PER_STONE,
  STONE_OUTCOME_IDS,
  STONE_OUTCOME_NAMES,
  STONE_PAY_RESOURCES,
  STONE_PITY_BUSTS,
  STONE_TIERS,
  STONE_TIER_IDS,
  cutStones,
  findStoneTier,
  nextStoneBusts,
  rollStone,
  stoneCostUnits,
  stoneExpectedXuantie,
  stoneJackpotBroadcast,
  stoneOutcomeOf,
  stoneResultMessage,
  stoneTierBlockedReason,
  stoneTopPrize,
  type StoneCutResult,
  type StoneOutcomeId,
  type StoneTierDef,
} from '../../apps/server/src/modules/game/stoneGamble';
import { SHOP_SELL_PRICE, UNITS_PER_DISPLAY } from '../../apps/server/src/modules/game/shop';

/**
 * 赌石纯函数（apps/server/src/modules/game/stoneGamble.ts，docs/赌石开发计划.md 第 1、3.1 节）：
 * 四档概率与玄铁个数、期望与价格、支付换算、隐藏保底与连切推进。
 *
 * 随机源用固定序列或线性同余注入，结果可复现；这里不触碰 Math.random（那只在 service 里）。
 */

/** 按取用顺序返回固定序列的随机源（用完后循环）。 */
function scripted(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index % values.length]!;
    index += 1;
    return value;
  };
}

/** 线性同余伪随机（取值 [0, 1)）：用于大样本统计，同一个种子永远给出同一串数。 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function tierOf(id: string): StoneTierDef {
  const tier = findStoneTier(id);
  if (tier === null) {
    throw new Error(`缺少档位 ${id}`);
  }
  return tier;
}

/** 玄铁个数（展示单位）按结果计数还原的总量：用来核对 xuantie = 各块之和。 */
function xuantieOfCounts(tier: StoneTierDef, counts: StoneCutResult['counts']): number {
  return STONE_OUTCOME_IDS.reduce((sum, id) => sum + counts[id] * stoneOutcomeOf(tier, id).xuantie, 0);
}

describe('赌石档位与概率表（计划 1.2）', () => {
  it('四档的 id / 名称 / 价格 / 宗门门槛与计划一致', () => {
    expect([...STONE_TIER_IDS]).toEqual(['gravel', 'mountain', 'oldPit', 'meteor']);
    expect(STONE_TIERS.map((tier) => [tier.id, tier.name, tier.price, tier.minSectLevel])).toEqual([
      ['gravel', '碎石', 150, 2],
      ['mountain', '山料', 500, 2],
      ['oldPit', '老坑料', 2000, 2],
      ['meteor', '天外陨石', 10_000, 6],
    ]);
  });

  it('每档四种结果（垮了 / 小涨 / 大涨 / 天价）按固定顺序给出，概率加起来正好 10000', () => {
    expect(STONE_CHANCE_TOTAL_BP).toBe(10_000);
    for (const tier of STONE_TIERS) {
      expect(tier.outcomes.map((item) => item.id)).toEqual(['bust', 'small', 'big', 'jackpot']);
      expect(tier.outcomes.reduce((sum, item) => sum + item.chanceBp, 0)).toBe(10_000);
      for (const item of tier.outcomes) {
        expect(Number.isInteger(item.chanceBp)).toBe(true);
        expect(item.chanceBp).toBeGreaterThan(0);
      }
    }
  });

  it('概率与玄铁个数逐项与计划表一致（格式：基点 / 个数）', () => {
    const table = STONE_TIERS.map((tier) =>
      tier.outcomes.map((item) => `${item.chanceBp}/${item.xuantie}`),
    );
    expect(table).toEqual([
      ['4000/0', '4600/1', '1200/3', '200/10'],
      ['3500/0', '4500/3', '1700/10', '300/40'],
      ['3000/0', '4500/12', '2100/25', '400/160'],
      ['2500/0', '4600/50', '2500/110', '400/800'],
    ]);
  });

  it('结果中文名与计划一致（服务端文案与界面共用，不在各处复制）', () => {
    expect(STONE_OUTCOME_NAMES).toEqual({ bust: '垮了', small: '小涨', big: '大涨', jackpot: '天价' });
    for (const tier of STONE_TIERS) {
      for (const item of tier.outcomes) {
        expect(item.name).toBe(STONE_OUTCOME_NAMES[item.id]);
      }
    }
  });

  it('天价 = 该档最大的玄铁个数（碎石 10 / 山料 40 / 老坑料 160 / 天外陨石 800）', () => {
    expect(STONE_TIERS.map((tier) => stoneTopPrize(tier))).toEqual([10, 40, 160, 800]);
    for (const tier of STONE_TIERS) {
      const max = Math.max(...tier.outcomes.map((item) => item.xuantie));
      expect(stoneTopPrize(tier)).toBe(max);
      expect(stoneOutcomeOf(tier, 'jackpot').xuantie).toBe(max);
    }
  });

  it('期望（展示单位）与计划表一致：1.02 / 4.25 / 17.05 / 82.5', () => {
    expect(stoneExpectedXuantie(tierOf('gravel'))).toBe(1.02);
    expect(stoneExpectedXuantie(tierOf('mountain'))).toBe(4.25);
    expect(stoneExpectedXuantie(tierOf('oldPit'))).toBe(17.05);
    expect(stoneExpectedXuantie(tierOf('meteor'))).toBe(82.5);
  });

  it('每档「价格 / 期望」在 110~150 灵石之间（防止以后调参把玄铁调得过便宜）', () => {
    for (const tier of STONE_TIERS) {
      const perXuantie = tier.price / stoneExpectedXuantie(tier);
      expect(perXuantie).toBeGreaterThanOrEqual(110);
      expect(perXuantie).toBeLessThanOrEqual(150);
    }
  });

  it('材料换算：1 灵石折 2 个材料（= 1000 / 卖出价），且只从 SHOP_SELL_PRICE 推导', () => {
    expect(STONE_MATERIAL_PER_STONE).toBe(UNITS_PER_DISPLAY / SHOP_SELL_PRICE);
    expect(STONE_MATERIAL_PER_STONE).toBe(2);
  });

  it('批量只有 1 或 10 块；支付方式为灵石 / 药材 / 矿石；保底上限 10；记录上限 20 条', () => {
    expect([...STONE_BATCH_COUNTS]).toEqual([1, 10]);
    expect([...STONE_PAY_RESOURCES]).toEqual(['spiritStone', 'herb', 'ore']);
    expect(STONE_PITY_BUSTS).toBe(10);
    expect(STONE_HISTORY_LIMIT).toBe(20);
  });
});

describe('赌石档位门槛与查询', () => {
  it('findStoneTier：已知 id 返回档位，未知 id 返回 null（由 service 拒绝）', () => {
    expect(findStoneTier('oldPit')?.name).toBe('老坑料');
    expect(findStoneTier('talentPill')).toBeNull();
    expect(findStoneTier('')).toBeNull();
  });

  it('stoneTierBlockedReason：门槛不够返回文案，够了返回 null', () => {
    expect(stoneTierBlockedReason(tierOf('meteor'), 2)).toBe('天外陨石需要宗门 6 级');
    expect(stoneTierBlockedReason(tierOf('meteor'), 5)).toBe('天外陨石需要宗门 6 级');
    expect(stoneTierBlockedReason(tierOf('meteor'), 6)).toBeNull();
    expect(stoneTierBlockedReason(tierOf('gravel'), 1)).toBe('碎石需要宗门 2 级');
    expect(stoneTierBlockedReason(tierOf('gravel'), 2)).toBeNull();
  });
});

describe('赌石支付（计划 1.3）', () => {
  it('灵石：价格 × 1000 最小单位，连切 10 块 × 10', () => {
    expect(stoneCostUnits(tierOf('gravel'), 'spiritStone', 1)).toBe(150_000);
    expect(stoneCostUnits(tierOf('meteor'), 'spiritStone', 1)).toBe(10_000_000);
    expect(stoneCostUnits(tierOf('mountain'), 'spiritStone', 10)).toBe(5_000_000);
  });

  it('药材 / 矿石：价格 × 2000 最小单位（= 价格 × 1000 × 1000 / 卖出价），连切 10 块 × 10', () => {
    for (const payResource of ['herb', 'ore'] as const) {
      expect(stoneCostUnits(tierOf('gravel'), payResource, 1)).toBe(300_000);
      expect(stoneCostUnits(tierOf('mountain'), payResource, 1)).toBe(1_000_000);
      expect(stoneCostUnits(tierOf('mountain'), payResource, 10)).toBe(10_000_000);
    }
  });

  it('材料付款不套利：材料按卖出价折算回灵石，正好等于直接付灵石（不能按买入价算）', () => {
    for (const tier of STONE_TIERS) {
      const stoneValue = (stoneCostUnits(tier, 'herb', 1) * SHOP_SELL_PRICE) / UNITS_PER_DISPLAY;
      expect(stoneValue).toBe(stoneCostUnits(tier, 'spiritStone', 1));
    }
  });

  it('所有花费都是整数最小单位', () => {
    for (const tier of STONE_TIERS) {
      for (const payResource of STONE_PAY_RESOURCES) {
        for (const count of STONE_BATCH_COUNTS) {
          expect(Number.isInteger(stoneCostUnits(tier, payResource, count))).toBe(true);
        }
      }
    }
  });
});

describe('赌石抽取（计划 1.5）', () => {
  it('rollStone：按累计基点边界取值，四种结果都能开出', () => {
    // 碎石累计边界：垮了 [0,4000) / 小涨 [4000,8600) / 大涨 [8600,9800) / 天价 [9800,10000)
    const gravel = tierOf('gravel');
    expect(rollStone(gravel, 0, scripted([0]))).toBe('bust');
    expect(rollStone(gravel, 0, scripted([0.39]))).toBe('bust');
    expect(rollStone(gravel, 0, scripted([0.41]))).toBe('small');
    expect(rollStone(gravel, 0, scripted([0.85]))).toBe('small');
    expect(rollStone(gravel, 0, scripted([0.87]))).toBe('big');
    expect(rollStone(gravel, 0, scripted([0.97]))).toBe('big');
    expect(rollStone(gravel, 0, scripted([0.99]))).toBe('jackpot');
    expect(rollStone(gravel, 0, scripted([0.999999]))).toBe('jackpot');
  });

  it('busts 低于保底线时仍可能开出「垮了」，busts = 9 也一样', () => {
    expect(rollStone(tierOf('mountain'), STONE_PITY_BUSTS - 1, scripted([0]))).toBe('bust');
  });

  it('busts ≥ STONE_PITY_BUSTS 时从小涨 / 大涨 / 天价重新归一抽取（山料：6500 基点）', () => {
    // 归一后累计：小涨 [0,4500) / 大涨 [4500,6200) / 天价 [6200,6500)，随机值 × 6500 落点。
    const mountain = tierOf('mountain');
    expect(rollStone(mountain, STONE_PITY_BUSTS, scripted([0]))).toBe('small');
    expect(rollStone(mountain, STONE_PITY_BUSTS, scripted([0.5]))).toBe('small');
    expect(rollStone(mountain, STONE_PITY_BUSTS, scripted([0.8]))).toBe('big');
    expect(rollStone(mountain, STONE_PITY_BUSTS, scripted([0.99]))).toBe('jackpot');
  });

  it('busts ≥ STONE_PITY_BUSTS 时永远不出 bust（大样本，四档都检查）', () => {
    for (const tier of STONE_TIERS) {
      const random = lcg(20_261_010 + tier.price);
      for (let index = 0; index < 5000; index += 1) {
        expect(rollStone(tier, STONE_PITY_BUSTS, random)).not.toBe('bust');
      }
    }
  });

  it('大样本抽取分布与概率表一致（每档每项偏差不超过 1 个百分点）', () => {
    const samples = 100_000;
    for (const tier of STONE_TIERS) {
      const random = lcg(7 + tier.price);
      const hits: Record<string, number> = { bust: 0, small: 0, big: 0, jackpot: 0 };
      for (let index = 0; index < samples; index += 1) {
        hits[rollStone(tier, 0, random)] += 1;
      }
      for (const item of tier.outcomes) {
        const observed = hits[item.id]! / samples;
        expect(Math.abs(observed - item.chanceBp / STONE_CHANCE_TOTAL_BP)).toBeLessThan(0.01);
      }
    }
  });

  it('nextStoneBusts：开出垮了 +1 且夹到 10；开出其他任何结果清零', () => {
    expect(nextStoneBusts(0, 'bust')).toBe(1);
    expect(nextStoneBusts(9, 'bust')).toBe(10);
    expect(nextStoneBusts(10, 'bust')).toBe(10);
    expect(nextStoneBusts(10, 'small')).toBe(0);
    expect(nextStoneBusts(7, 'big')).toBe(0);
    expect(nextStoneBusts(7, 'jackpot')).toBe(0);
  });

  it('cutStones：连切 10 块逐块推进次数（第 3 块触发保底后清零，第 4 块起重新计）', () => {
    // 起始 8 次：块 1、2 垮了 → 10 次；块 3 触发保底（排除垮了）→ 清零；块 4 垮了 → 1 次；块 5 起天价。
    const random = scripted([0, 0, 0.5, 0, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99]);
    const cut = cutStones(tierOf('gravel'), 10, 8, random);
    expect(cut.outcomes).toEqual([
      'bust',
      'bust',
      'small',
      'bust',
      'jackpot',
      'jackpot',
      'jackpot',
      'jackpot',
      'jackpot',
      'jackpot',
    ]);
    expect(cut.counts).toEqual({ bust: 3, small: 1, big: 0, jackpot: 6 });
    // 玄铁 = 小涨 1 × 1 + 天价 6 × 10；只算结果，不靠次数
    expect(cut.xuantie).toBe(61);
    expect(cut.nextBusts).toBe(0);
  });

  it('cutStones：每块恰好取一次随机数，counts 之和 = count，玄铁 = 各块之和（大样本）', () => {
    for (const tier of STONE_TIERS) {
      for (const count of STONE_BATCH_COUNTS) {
        for (let seed = 1; seed <= 50; seed += 1) {
          const random = lcg(seed * 977 + tier.price);
          const cut = cutStones(tier, count, seed % (STONE_PITY_BUSTS + 1), random);
          expect(cut.outcomes).toHaveLength(count);
          expect(STONE_OUTCOME_IDS.reduce((sum, id) => sum + cut.counts[id], 0)).toBe(count);
          expect(cut.xuantie).toBe(xuantieOfCounts(tier, cut.counts));
          expect(cut.nextBusts).toBeGreaterThanOrEqual(0);
          expect(cut.nextBusts).toBeLessThanOrEqual(STONE_PITY_BUSTS);
        }
      }
    }
  });

  it('cutStones：同一随机序列 + 同一起始次数得到同一结果（可复现）', () => {
    const first = cutStones(tierOf('oldPit'), 10, 3, lcg(42));
    const second = cutStones(tierOf('oldPit'), 10, 3, lcg(42));
    expect(second).toEqual(first);
  });
});

describe('赌石文案（服务端拼好，前端原样展示）', () => {
  it('单块：开出结果与玄铁数；垮了给「什么也没开出」', () => {
    const jackpot = cutStones(tierOf('mountain'), 1, 0, scripted([0.99]));
    expect(stoneResultMessage('山料', jackpot)).toBe('切开一块山料，天价！开出玄铁 ×40');
    const big = cutStones(tierOf('mountain'), 1, 0, scripted([0.9]));
    expect(stoneResultMessage('山料', big)).toBe('切开一块山料，大涨！开出玄铁 ×10');
    const bust = cutStones(tierOf('gravel'), 1, 0, scripted([0]));
    expect(stoneResultMessage('碎石', bust)).toBe('切开一块碎石，垮了，什么也没开出');
  });

  it('连切：列出出现过的结果（天价 → 大涨 → 小涨 → 垮了），玄铁为各块之和', () => {
    const cut: StoneCutResult = {
      outcomes: [],
      counts: { bust: 6, small: 2, big: 1, jackpot: 1 },
      xuantie: 56,
      nextBusts: 0,
    };
    expect(stoneResultMessage('山料', { ...cut, outcomes: Array.from({ length: 10 }, (): StoneOutcomeId => 'bust') })).toBe(
      '切开 10 块山料，开出玄铁 ×56（天价 1 块、大涨 1 块、小涨 2 块、垮了 6 块）',
    );
    const onlyBust: StoneCutResult = {
      outcomes: Array.from({ length: 10 }, (): StoneOutcomeId => 'bust'),
      counts: { bust: 10, small: 0, big: 0, jackpot: 0 },
      xuantie: 0,
      nextBusts: 10,
    };
    expect(stoneResultMessage('碎石', onlyBust)).toBe('切开 10 块碎石，开出玄铁 ×0（垮了 10 块）');
  });

  it('天价全服播报：一块一条，内容带宗门名、档位名与该档天价个数', () => {
    expect(stoneJackpotBroadcast('苍梧宗', '老坑料', 160)).toBe(
      '【赌石】苍梧宗切开一块老坑料，开出天价玄铁 ×160！',
    );
  });
});
