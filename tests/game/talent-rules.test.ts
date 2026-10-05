import { GAME_CONFIG_CONTENT } from '@xiuxian/game-config';
import { describe, expect, it } from 'vitest';

import {
  CULTIVATION_PILL_GAIN,
  cultivationPillGainOf,
  cultivationPillsToFull,
  discountedPillCost,
} from '../../apps/server/src/modules/game/alchemy';
import { forgeOddsOf, realmXuantieDrop } from '../../apps/server/src/modules/game/equipment';
import { discipleCombatPower } from '../../apps/server/src/modules/game/realms';
import { positionOutputPerHour } from '../../apps/server/src/modules/game/settle';
import {
  STEWARD_OFFICES,
  TALENT_IDS,
  TALENTS,
  generateTalent,
  rollTalentCandidate,
  stewardBonusBp,
  talentBonusBp,
  talentCatalog,
  talentEffectText,
  talentNameOf,
} from '../../apps/server/src/modules/game/talents';
import { rollDamage, rollOutcome } from '../../apps/server/src/modules/game/worldBoss';

/** 按顺序吐出给定随机数（用完后重复最后一个）。 */
function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

const REALM_IDS = ['qiRefining', 'foundationEstablishment', 'goldenCore', 'nascentSoul', 'spiritTransformation'];

describe('天赋表（计划 1.2）', () => {
  it('11 个天赋，保留 V4 的 4 个 id', () => {
    expect(TALENT_IDS).toEqual([
      'herbGathering',
      'mining',
      'spiritGathering',
      'cultivation',
      'pillAffinity',
      'combat',
      'critical',
      'ironBody',
      'forging',
      'alchemy',
      'treasure',
    ]);
    expect(TALENTS.map((talent) => talent.name)).toEqual([
      '灵植', '矿脉', '聚灵', '悟道', '丹心', '战意', '会心', '铁骨', '炼器', '丹道', '寻宝',
    ]);
    expect(talentNameOf('none')).toBe('无');
    expect(talentNameOf(null)).toBe('无');
  });

  it('境界系数：炼气 ×1、筑基 ×1.25、金丹 ×1.5、元婴 ×2、化神 ×2.5', () => {
    expect(REALM_IDS.map((realmId) => talentBonusBp('mining', realmId))).toEqual([2000, 2500, 3000, 4000, 5000]);
    expect(REALM_IDS.map((realmId) => talentBonusBp('combat', realmId))).toEqual([1000, 1250, 1500, 2000, 2500]);
    expect(REALM_IDS.map((realmId) => talentBonusBp('forging', realmId))).toEqual([400, 500, 600, 800, 1000]);
    expect(talentBonusBp('critical', 'spiritTransformation')).toBe(15_000);
  });

  it('只在天赋匹配时给加成；未知天赋 / 未知境界按 0 / 最低档', () => {
    expect(talentBonusBp('mining', 'goldenCore', 'herbGathering')).toBe(0);
    expect(talentBonusBp('mining', 'goldenCore', 'mining')).toBe(3000);
    expect(talentBonusBp('none', 'goldenCore')).toBe(0);
    expect(talentBonusBp('mining', 'unknownRealm')).toBe(2000);
  });

  it('效果文案按当前境界算，减益类带「−」', () => {
    expect(talentEffectText('mining', 'goldenCore')).toBe('矿石产出 +30%');
    expect(talentEffectText('ironBody', 'spiritTransformation')).toBe('受伤、重伤概率 −50%');
    expect(talentEffectText('combat', 'foundationEstablishment')).toBe('战力 +12.5%');
    expect(talentEffectText('none', 'goldenCore')).toBe('');
  });

  it('天赋总表：11 行 × 5 个境界，数值服务端算好', () => {
    const catalog = talentCatalog();
    expect(catalog).toHaveLength(11);
    const combat = catalog.find((entry) => entry.id === 'combat')!;
    expect(combat.categoryName).toBe('战斗');
    expect(combat.effect).toBe('战力');
    expect(combat.values.map((value) => value.text)).toEqual(['+10%', '+12.5%', '+15%', '+20%', '+25%']);
    expect(combat.values.map((value) => value.realmName)).toEqual(['炼气', '筑基', '金丹', '元婴', '化神']);
  });

  it('新弟子天赋等概率覆盖 11 个；洗髓候选不会与当前相同', () => {
    const seen = new Set<string>();
    for (let index = 0; index < TALENT_IDS.length; index += 1) {
      seen.add(generateTalent(() => (index + 0.5) / TALENT_IDS.length));
    }
    expect(seen.size).toBe(11);

    const candidates = new Set<string>();
    for (let index = 0; index < 10; index += 1) {
      const candidate = rollTalentCandidate('combat', () => (index + 0.5) / 10);
      expect(candidate).not.toBe('combat');
      candidates.add(candidate);
    }
    expect(candidates.size).toBe(10);
  });
});

describe('各系统接入', () => {
  it('战意：金丹 +15%，与旧的战斗天赋持平；化神 +25%', () => {
    const plain = discipleCombatPower('goldenCore', 1, 60, 60, 60);
    expect(discipleCombatPower('goldenCore', 1, 60, 60, 60, 'combat')).toBe(Math.floor(plain * 1.15));
    const high = discipleCombatPower('spiritTransformation', 1, 60, 60, 60);
    expect(discipleCombatPower('spiritTransformation', 1, 60, 60, 60, 'combat')).toBe(Math.floor(high * 1.25));
    expect(discipleCombatPower('goldenCore', 1, 60, 60, 60, 'critical')).toBe(plain);
  });

  it('聚灵：采灵 / 吐纳岗位产出随境界提高；岗位不对不加成', () => {
    const config = GAME_CONFIG_CONTENT;
    const base = { id: 'd', aptitude: 50, stage: 1, cultivation: 0, cultivationRemainder: 0 };
    const stone = positionOutputPerHour(config, {
      ...base,
      realmId: 'nascentSoul',
      assignment: 'stoneMining',
      talent: 'spiritGathering',
    });
    expect(stone.get('spiritStone')).toBe(15_000 * 1.4);
    const energy = positionOutputPerHour(config, {
      ...base,
      realmId: 'qiRefining',
      assignment: 'energyGathering',
      talent: 'spiritGathering',
    });
    expect(energy.get('spiritualEnergy')).toBe(12_000);
    const herb = positionOutputPerHour(config, {
      ...base,
      realmId: 'nascentSoul',
      assignment: 'herbGathering',
      talent: 'spiritGathering',
    });
    expect(herb.get('herb')).toBe(20_000);
  });

  it('丹心：每颗聚气丹修为随境界提高，服到满所需颗数随之减少', () => {
    expect(cultivationPillGainOf('combat', 'spiritTransformation')).toBe(CULTIVATION_PILL_GAIN);
    expect(cultivationPillGainOf('pillAffinity', 'qiRefining')).toBe(144);
    expect(cultivationPillGainOf('pillAffinity', 'spiritTransformation')).toBe(180);
    expect(cultivationPillsToFull(0, 360)).toBe(3);
    expect(cultivationPillsToFull(0, 360, 180)).toBe(2);
  });

  it('会心：只在暴击时把会心加成加进伤害基数', () => {
    const common = { partyBase: 100, arenaLevel: 0, avgLuck: 100, frenzy: false, critBonusBase: 50 };
    // 浮动取 0.5 → ×1.0；暴击判定 0.1 < 20% → 暴击：100 × 1.5 + 50 = 200
    expect(rollDamage({ ...common, random: sequence([0.5, 0.1]) })).toEqual({ damage: 20_000, crit: true });
    // 0.5 ≥ 20% → 不暴击：会心不生效
    expect(rollDamage({ ...common, random: sequence([0.5, 0.5]) })).toEqual({ damage: 10_000, crit: false });
  });

  it('铁骨：受伤 / 重伤概率按比例降低；「必重伤」那档不减免', () => {
    // 第 4 次出手、体魄 50：重伤 70% → 铁骨 50% 后 35%
    expect(rollOutcome({ fatigueCount: 4, physique: 50, berserk: false, injuryReductionBp: 5000, random: sequence([0.4, 0.99]) }))
      .toEqual({ severe: false, injured: false });
    expect(rollOutcome({ fatigueCount: 4, physique: 50, berserk: false, random: sequence([0.4]) }))
      .toEqual({ severe: true, injured: false });
    // 第 5 次起必重伤：铁骨不减免
    expect(rollOutcome({ fatigueCount: 5, physique: 50, berserk: false, injuryReductionBp: 5000, random: sequence([0.99]) }))
      .toEqual({ severe: true, injured: false });
  });

  it('炼器执事：成功率加成与炼器坊同一抵扣顺序（先抵失败、再抵降级）', () => {
    expect(forgeOddsOf('spirit', 2, 0, 400)).toEqual({ success: 0.74, downgrade: 0.2, fail: 0.06 });
    expect(forgeOddsOf('immortal', 4, 0, 1000)).toEqual({ success: 0.7, downgrade: 0.3, fail: 0 });
    expect(forgeOddsOf('immortal', 4, 4, 1000)).toEqual({ success: 1, downgrade: 0, fail: 0 });
  });

  it('丹道执事：炼丹消耗按比例降低，逐项向下取整', () => {
    expect(discountedPillCost({ herb: '10000', spiritStone: '15000' }, 800)).toEqual({
      herb: '9200',
      spiritStone: '13800',
    });
    expect(discountedPillCost({ herb: '10000' }, 0)).toEqual({ herb: '10000' });
  });

  it('寻宝执事：玄铁掉落概率同比例提高', () => {
    // 妖兽巢穴 10%：0.11 原本不掉；寻宝 +25% → 12.5%，0.11 就能掉
    expect(realmXuantieDrop('beastNest', sequence([0.11]))).toBe(0);
    expect(realmXuantieDrop('beastNest', sequence([0.11, 0]), 2500)).toBe(1);
  });
});

describe('执事堂（计划第 2 节）', () => {
  const disciples = [
    { id: 'a', talent: 'forging', realm_id: 'nascentSoul' },
    { id: 'b', talent: 'combat', realm_id: 'nascentSoul' },
  ];

  it('三个职位，职位 id 与所需天赋 id 相同', () => {
    expect(STEWARD_OFFICES.map((office) => [office.id, office.name, office.talentId])).toEqual([
      ['forging', '炼器执事', 'forging'],
      ['alchemy', '丹房执事', 'alchemy'],
      ['treasure', '寻宝执事', 'treasure'],
    ]);
  });

  it('职位有人且天赋对得上时按境界给加成；空缺 / 天赋不符 / 在外历练为 0', () => {
    const stewards = [{ office: 'forging', disciple_id: 'a' }];
    expect(stewardBonusBp({ office: 'forging', stewards, disciples, awayIds: new Set() })).toBe(800);
    expect(stewardBonusBp({ office: 'forging', stewards, disciples, awayIds: new Set(['a']) })).toBe(0);
    expect(stewardBonusBp({ office: 'alchemy', stewards, disciples, awayIds: new Set() })).toBe(0);
    expect(
      stewardBonusBp({ office: 'forging', stewards: [{ office: 'forging', disciple_id: 'b' }], disciples, awayIds: new Set() }),
    ).toBe(0);
    expect(
      stewardBonusBp({ office: 'forging', stewards: [{ office: 'forging', disciple_id: null }], disciples, awayIds: new Set() }),
    ).toBe(0);
  });
});
