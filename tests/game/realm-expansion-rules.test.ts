import { GAME_CONFIG_CONTENT } from '@xiuxian/game-config';
import { describe, expect, it } from 'vitest';

import { CULTIVATION_PILL_GAIN, cultivationPillGainOf } from '../../apps/server/src/modules/game/alchemy';
import {
  REALMS,
  REALM_CULTIVATION_MULTIPLIER,
  SECT_LEVELS,
  breakthroughEnergyCost,
  effectiveCapacity,
  findStage,
  nextStageOf,
  realmCultivationMultiplier,
} from '../../apps/server/src/modules/game/constants';
import {
  journeyBaseReward,
  journeyCultivationWithFortune,
  parseJourneyBonus,
  rollJourneyBonus,
  serializeJourneyBonus,
} from '../../apps/server/src/modules/game/journey';
import { cultivationRatePerHour } from '../../apps/server/src/modules/game/settle';
import { TALENT_REALM_MULTIPLIER_BP, talentBonusBp } from '../../apps/server/src/modules/game/talents';

/** 按顺序吐出给定随机数（用完后重复最后一个）。 */
function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

describe('境界扩充（计划第 1 节）', () => {
  it('9 个境界；化神后期补上门槛，渡劫后期封顶', () => {
    expect(REALMS.map((realm) => realm.name)).toEqual([
      '炼气', '筑基', '金丹', '元婴', '化神', '炼虚', '合体', '大乘', '渡劫',
    ]);
    expect(findStage('spiritTransformation', 3).requiredCultivation).toBe(97_200);
    expect(nextStageOf('spiritTransformation', 3)).toEqual({ realmId: 'voidRefinement', stage: 1 });
    expect(findStage('voidRefinement', 1).requiredCultivation).toBe(210_000);
    expect(findStage('tribulation', 2).requiredCultivation).toBe(1_375_000);
    expect(findStage('tribulation', 3).requiredCultivation).toBeNull();
    expect(nextStageOf('tribulation', 3)).toBeNull();
  });

  it('门槛逐层递增；等效挂机时长（门槛 ÷ 修炼倍率）从化神后期起不回落', () => {
    const thresholds = REALMS.flatMap((realm, index) =>
      realm.stages
        .filter((stage) => stage.requiredCultivation !== null)
        .map((stage) => ({ value: stage.requiredCultivation!, effective: stage.requiredCultivation! / REALM_CULTIVATION_MULTIPLIER[index]! })),
    );
    for (let index = 1; index < thresholds.length; index += 1) {
      expect(thresholds[index]!.value).toBeGreaterThanOrEqual(thresholds[index - 1]!.value);
    }
    const fromSpirit = thresholds.slice(14);
    for (let index = 1; index < fromSpirit.length; index += 1) {
      expect(fromSpirit[index]!.effective).toBeGreaterThanOrEqual(fromSpirit[index - 1]!.effective);
    }
  });

  it('修炼倍率、天赋系数、破境灵气：前五个境界与扩充前完全一致', () => {
    expect(REALM_CULTIVATION_MULTIPLIER).toEqual([1, 1, 1, 1, 1, 2, 3, 4, 5]);
    expect(TALENT_REALM_MULTIPLIER_BP).toHaveLength(9);
    expect(talentBonusBp('combat', 'tribulation')).toBe(3_500);
    expect(breakthroughEnergyCost('qiRefining', 1)).toBe(20_000);
    expect(breakthroughEnergyCost('spiritTransformation', 3)).toBe(60_000);
    expect(breakthroughEnergyCost('voidRefinement', 1)).toBe(60_000);
    expect(breakthroughEnergyCost('tribulation', 2)).toBe(600_000);
  });

  it('修炼速度、修为丹、历练修为都乘修炼倍率', () => {
    const disciple = {
      id: 'd',
      aptitude: 50,
      stage: 1,
      cultivation: 0,
      cultivationRemainder: 0,
      assignment: 'cultivating',
      talent: 'combat',
    };
    const spirit = cultivationRatePerHour(GAME_CONFIG_CONTENT, { ...disciple, realmId: 'spiritTransformation' });
    expect(cultivationRatePerHour(GAME_CONFIG_CONTENT, { ...disciple, realmId: 'voidRefinement' })).toBe(spirit * 2);
    expect(cultivationRatePerHour(GAME_CONFIG_CONTENT, { ...disciple, realmId: 'tribulation' })).toBe(spirit * 5);
    expect(realmCultivationMultiplier('unknown')).toBe(1);

    expect(cultivationPillGainOf('combat', 'spiritTransformation')).toBe(CULTIVATION_PILL_GAIN);
    expect(cultivationPillGainOf('combat', 'mahayana')).toBe(CULTIVATION_PILL_GAIN * 4);

    const journeyInput = { direction: 'daoSeeking' as const, durationSeconds: 7_200, aptitude: 50, talent: 'combat', combatPower: 0, luck: 50, physique: 50 };
    const base = journeyBaseReward({ ...journeyInput, realmId: 'spiritTransformation' })!.cultivation;
    expect(journeyBaseReward({ ...journeyInput, realmId: 'bodyIntegration' })!.cultivation).toBe(base * 3);
  });
});

describe('宗门等级扩充（计划第 2 节）', () => {
  it('15 级；每级的升级消耗都放得进上一级的资源容量', () => {
    expect(SECT_LEVELS.map((level) => level.level)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(SECT_LEVELS.slice(10).map((level) => level.name)).toEqual([
      '洞天福地', '上古仙门', '万法仙庭', '太虚圣宗', '道祖仙庭',
    ]);
    for (let index = 1; index < SECT_LEVELS.length; index += 1) {
      const previous = SECT_LEVELS[index - 1]!;
      for (const [resourceId, amount] of Object.entries(SECT_LEVELS[index]!.upgradeCost)) {
        const definition = GAME_CONFIG_CONTENT.resources.find((resource) => resource.id === resourceId);
        expect(definition, resourceId).toBeTruthy();
        expect(Number(amount)).toBeLessThanOrEqual(effectiveCapacity(definition!.capacity, previous.capacityMultiplier));
      }
    }
  });

  it('11 级起的弟子条件都指向新境界；弟子上限与容量单调递增', () => {
    const realmIds = new Set(REALMS.map((realm) => realm.id));
    for (const level of SECT_LEVELS) {
      for (const requirement of level.discipleRequirements) {
        expect(realmIds.has(requirement.minRealmId)).toBe(true);
      }
    }
    expect(SECT_LEVELS[14]!.discipleRequirements).toEqual([{ minRealmId: 'tribulation', count: 1 }]);
    for (let index = 1; index < SECT_LEVELS.length; index += 1) {
      expect(SECT_LEVELS[index]!.discipleCapacity).toBeGreaterThan(SECT_LEVELS[index - 1]!.discipleCapacity);
      expect(SECT_LEVELS[index]!.capacityMultiplier).toBeGreaterThan(SECT_LEVELS[index - 1]!.capacityMultiplier);
    }
  });
});

describe('历练奖励丰富化（计划第 3 节）', () => {
  const chances = { fortuneChanceBp: 1_200, insightChanceBp: 1_500, attributeChanceBp: 800 };
  const attributes = { attack: 50, defense: 50, speed: 50, luck: 50, physique: 50 };

  it('按顺序掷：机遇 → 悟道 → 淬炼 → 挑属性', () => {
    expect(rollJourneyBonus(chances, attributes, sequence([0.1, 0.1, 0.05, 0.99]))).toEqual({
      fortune: true,
      insight: true,
      attribute: 'physique',
    });
    expect(rollJourneyBonus(chances, attributes, sequence([0.5, 0.5, 0.5]))).toEqual({
      fortune: false,
      insight: false,
      attribute: null,
    });
  });

  it('淬炼只挑没满 100 的属性；全满视为没中', () => {
    const almostFull = { attack: 100, defense: 100, speed: 100, luck: 60, physique: 100 };
    expect(rollJourneyBonus(chances, almostFull, sequence([0.9, 0.9, 0, 0])).attribute).toBe('luck');
    const full = { attack: 100, defense: 100, speed: 100, luck: 100, physique: 100 };
    expect(rollJourneyBonus(chances, full, sequence([0.9, 0.9, 0, 0])).attribute).toBeNull();
  });

  it('机遇把保底修为再加一份；bonus_detail 序列化可逆，脏数据按没有处理', () => {
    expect(journeyCultivationWithFortune(270, 180, true)).toBe(450);
    expect(journeyCultivationWithFortune(270, 180, false)).toBe(270);
    const bonus = { fortune: true, insight: false, attribute: 'speed' as const };
    expect(parseJourneyBonus(serializeJourneyBonus(bonus))).toEqual(bonus);
    expect(parseJourneyBonus('{}')).toEqual({ fortune: false, insight: false, attribute: null });
    expect(parseJourneyBonus('not json')).toEqual({ fortune: false, insight: false, attribute: null });
    expect(parseJourneyBonus('{"attribute":"aptitude","fortune":1}')).toEqual({
      fortune: false,
      insight: false,
      attribute: null,
    });
  });
});
