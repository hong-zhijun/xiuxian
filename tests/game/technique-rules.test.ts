import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  BOSS_SCROLL_CHANCE,
  TECHNIQUES,
  bossScrollCountOf,
  bossScrollGrantOf,
  findTechnique,
  rollBossScroll,
  scrollItemIdOf,
  techniqueIdOfScrollItem,
  techniqueKeptProficiencyBp,
  techniqueLearnScrolls,
  techniqueLevelFactor,
  techniqueModifiersOf,
  techniqueProficiencyBp,
  techniqueProficiencyFactor,
  techniqueScaleOf,
  techniqueUpgradeCost,
} from '../../apps/server/src/modules/game/techniques';
import {
  simulateTowerBattle,
  towerAffixOf,
  towerFighterHp,
  towerStandardAttr,
  towerStandardPower,
  TOWER_MAX_ROUNDS,
  type TowerBattleResult,
  type TowerFighter,
} from '../../apps/server/src/modules/game/tower';
import { rollDamage, rollOutcome } from '../../apps/server/src/modules/game/worldBoss';
import { generateMerchantGoods, withTechniqueScrolls } from '../../apps/server/src/modules/game/auctionMerchant';

const HOUR = 3_600_000;

/** 按顺序循环吐出固定随机数。 */
function sequence(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index % values.length]!;
    index += 1;
    return value;
  };
}

/** 可复现的伪随机（LCG），用于批量场景。 */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function fighter(overrides: Partial<TowerFighter> = {}): TowerFighter {
  return {
    id: 'd',
    name: '弟子',
    power: 15,
    attack: 50,
    defense: 50,
    speed: 50,
    luck: 50,
    physique: 50,
    critBonusBp: 0,
    damageReductionBp: 0,
    ...overrides,
  };
}

function party(overrides: Partial<TowerFighter> = {}): TowerFighter[] {
  return Array.from({ length: 5 }, (_, index) => fighter({ id: `d${index}`, name: `弟子${index}`, ...overrides }));
}

/** 给第 index 名弟子挂上功法（参悟等级 / 熟练度可指定）。 */
function withTechnique(
  members: TowerFighter[],
  index: number,
  techniqueId: string,
  level = 10,
  proficiencyBp = 10_000,
): TowerFighter[] {
  const technique = techniqueModifiersOf({ techniqueId, level, proficiencyBp });
  return members.map((member, memberIndex) =>
    memberIndex === index ? { ...member, technique: technique! } : member,
  );
}

describe('功法 · 参悟与熟练度', () => {
  it('参悟系数 1 + 0.08 × (等级 − 1)：10 级 ×1.72；熟练度系数 0.6 + 0.4 × 熟练度', () => {
    expect(techniqueLevelFactor(1)).toBe(1);
    expect(techniqueLevelFactor(10)).toBeCloseTo(1.72);
    expect(techniqueProficiencyFactor(0)).toBeCloseTo(0.6);
    expect(techniqueProficiencyFactor(5_000)).toBeCloseTo(0.8);
    expect(techniqueProficiencyFactor(10_000)).toBe(1);
    expect(techniqueScaleOf(10, 10_000)).toBeCloseTo(1.72);
    expect(techniqueScaleOf(1, 0)).toBeCloseTo(0.6);
  });

  it('熟练度 48 小时从 0 涨到 100%，之后封顶；没有主修为 0', () => {
    const since = 1_000_000;
    expect(techniqueProficiencyBp({ base: 0, since: null, now: since + 99 * HOUR })).toBe(0);
    expect(techniqueProficiencyBp({ base: 0, since, now: since })).toBe(0);
    expect(techniqueProficiencyBp({ base: 0, since, now: since + 24 * HOUR })).toBe(5_000);
    expect(techniqueProficiencyBp({ base: 0, since, now: since + 48 * HOUR })).toBe(10_000);
    expect(techniqueProficiencyBp({ base: 0, since, now: since + 500 * HOUR })).toBe(10_000);
    expect(techniqueProficiencyBp({ base: 3_000, since, now: since + 24 * HOUR })).toBe(8_000);
  });

  it('换功法：熟练度减半后继续增长（减半 8000 → 4000，再过 24 小时 → 6500）', () => {
    expect(techniqueKeptProficiencyBp(8_000)).toBe(4_000);
    expect(techniqueKeptProficiencyBp(9_999)).toBe(4_999);
    const switchedAt = 5_000_000;
    // 4000 + 24 小时的增量（5000）= 9000；换一次功法的熟练度就是这么长起来的。
    expect(techniqueProficiencyBp({ base: 4_000, since: switchedAt, now: switchedAt + 24 * HOUR })).toBe(9_000);
  });

  it('收录残卷：玄 10 / 地 20 / 天 40；参悟每级残卷 5 / 8 / 12，灵石 = 单位 × 当前等级（最小单位，10 级封顶）', () => {
    expect(techniqueLearnScrolls('xuan')).toBe(10);
    expect(techniqueLearnScrolls('di')).toBe(20);
    expect(techniqueLearnScrolls('tian')).toBe(40);
    expect(techniqueUpgradeCost('xuan', 1)).toEqual({ scrolls: 5, stone: 50_000 });
    expect(techniqueUpgradeCost('di', 3)).toEqual({ scrolls: 8, stone: 450_000 });
    expect(techniqueUpgradeCost('tian', 9)).toEqual({ scrolls: 12, stone: 3_600_000 });
    expect(techniqueUpgradeCost('tian', 10)).toBeNull();
    expect(techniqueUpgradeCost('xuan', 0)).toBeNull();
  });

  it('12 门功法：id 唯一，品阶数 玄 5 / 地 5 / 天 2', () => {
    expect(new Set(TECHNIQUES.map((item) => item.id)).size).toBe(12);
    expect(TECHNIQUES.filter((item) => item.tier === 'xuan')).toHaveLength(5);
    expect(TECHNIQUES.filter((item) => item.tier === 'di')).toHaveLength(5);
    expect(TECHNIQUES.filter((item) => item.tier === 'tian')).toHaveLength(2);
    expect(findTechnique('qingfeng')?.name).toBe('青锋剑诀');
  });
});

describe('功法 · 战斗修正', () => {
  it('没有功法 / 未知功法返回 null', () => {
    expect(techniqueModifiersOf({ techniqueId: null, level: 1, proficiencyBp: 0 })).toBeNull();
    expect(techniqueModifiersOf({ techniqueId: 'nope', level: 1, proficiencyBp: 0 })).toBeNull();
  });

  it('增益按 S 缩放：青锋 L1 零熟练（S = 0.6）→ 第一次出手 ×1.3、攻击上限 +0.3；L10 满熟练 → ×1.5 → ×1.86', () => {
    const low = techniqueModifiersOf({ techniqueId: 'qingfeng', level: 1, proficiencyBp: 0 })!;
    const high = techniqueModifiersOf({ techniqueId: 'qingfeng', level: 10, proficiencyBp: 10_000 })!;
    expect(low.tower.firstStrikeMultiplier).toBeCloseTo(1.3);
    expect(low.tower.attackCapBonus).toBeCloseTo(0.3);
    expect(high.tower.firstStrikeMultiplier).toBeCloseTo(1.86);
    expect(high.boss.damageGain).toBeCloseTo(1 + 0.06 * 1.72);
  });

  it('代价不缩放：太乙血量 ×0.9、金刚伤害 ×0.9、血身伤害 ×0.92、背水血量 ×0.9、天机未暴击 ×0.9', () => {
    const low = { level: 1, proficiencyBp: 0 };
    expect(techniqueModifiersOf({ techniqueId: 'taiyi', ...low })!.tower.hpMultiplier).toBe(0.9);
    expect(techniqueModifiersOf({ techniqueId: 'jingang', ...low })!.tower.strikeMultiplier).toBe(0.9);
    expect(techniqueModifiersOf({ techniqueId: 'xueshen', ...low })!.tower.strikeMultiplier).toBe(0.92);
    expect(techniqueModifiersOf({ techniqueId: 'beishui', ...low })!.tower.hpMultiplier).toBe(0.9);
    expect(techniqueModifiersOf({ techniqueId: 'tianji', ...low })!.tower.nonCritMultiplier).toBe(0.9);
    // 剑气的 25% 触发率是开关型，不随 S 变化。
    expect(techniqueModifiersOf({ techniqueId: 'taiyi', level: 10, proficiencyBp: 10_000 })!.tower.procChance).toBe(0.25);
  });

  it('流云：追击上限 0.3 + 0.2S，最多连续 3 次；鬼影：第 1 回合必定追击，追击概率 +0.1S', () => {
    const liuyun = techniqueModifiersOf({ techniqueId: 'liuyun', level: 10, proficiencyBp: 10_000 })!;
    expect(liuyun.tower.extraChanceMax).toBeCloseTo(0.3 + 0.2 * 1.72);
    expect(liuyun.tower.maxStrikesPerAction).toBe(3);
    const guiying = techniqueModifiersOf({ techniqueId: 'guiying', level: 1, proficiencyBp: 0 })!;
    expect(guiying.tower.round1GuaranteedExtra).toBe(true);
    expect(guiying.tower.extraChanceBonus).toBeCloseTo(0.06);
  });

  it('金刚体魄权重 1 + 0.4S（满级 1.688）；百毒血量 +5% × S；背水低血量阈值 35%', () => {
    expect(techniqueModifiersOf({ techniqueId: 'jingang', level: 10, proficiencyBp: 10_000 })!.tower.physiqueWeight).toBeCloseTo(1.688);
    expect(techniqueModifiersOf({ techniqueId: 'baidu', level: 10, proficiencyBp: 10_000 })!.tower.hpMultiplier).toBeCloseTo(1.086);
    const beishui = techniqueModifiersOf({ techniqueId: 'beishui', level: 1, proficiencyBp: 0 })!;
    expect(beishui.tower.lowHpThreshold).toBe(0.35);
    expect(beishui.tower.lowHpMultiplier).toBeCloseTo(1.36);
  });

  it('金刚改体魄权重：同样的弟子血量变高（开场血量提升）', () => {
    const base = fighter({ power: 20, physique: 80 });
    const jingang = { ...base, technique: techniqueModifiersOf({ techniqueId: 'jingang', level: 10, proficiencyBp: 10_000 })! };
    expect(towerFighterHp(jingang)).toBeGreaterThan(towerFighterHp(base));
    expect(towerFighterHp(base)).toBe(Math.floor(4.5 * 20 * (0.5 + 0.8) * 100));
  });
});

describe('功法 · 残卷来源', () => {
  it('残卷物品 id 往返一致；矿石 / 玄铁等非残卷物品返回 null', () => {
    expect(techniqueIdOfScrollItem(scrollItemIdOf('qingfeng'))).toBe('qingfeng');
    expect(techniqueIdOfScrollItem('xuantie')).toBeNull();
    expect(techniqueIdOfScrollItem('techniqueScroll:nope')).toBeNull();
  });

  it('世界 Boss 张数：第 1～3 关 1 张，第 4～6 关 2 张，第 7 关起 3 张；天阶第 6 关之前不出', () => {
    expect([1, 3, 4, 6, 7, 12].map((stage) => bossScrollCountOf(stage))).toEqual([1, 1, 2, 2, 3, 3]);
    // 第 5 关：权重只剩玄 6 / 地 3，随机数取到最末端也只会是地阶（太乙 … 北水，地阶表的最后一门）。
    expect(findTechnique(rollBossScroll(5, () => 0.99)!)?.tier).toBe('di');
    // 第 6 关起才会出天阶：最末端的权重落到天阶（九转心经 / 一剑破甲中的最后一门）。
    expect(findTechnique(rollBossScroll(6, () => 0.99)!)?.tier).toBe('tian');
  });

  it('得到残卷：占比 ≥ 5% 必得（不取随机数）；否则 40% 概率；伤害第一另 +1 张', () => {
    expect(BOSS_SCROLL_CHANCE).toBe(0.4);
    const big = bossScrollGrantOf({ stage: 2, damageShare: 0.5, rank: 2, random: () => 0.99 });
    expect(Object.values(big).reduce((sum, count) => sum + count, 0)).toBe(1);
    const missed = bossScrollGrantOf({ stage: 2, damageShare: 0.01, rank: 2, random: () => 0.99 });
    expect(missed).toEqual({});
    const top = bossScrollGrantOf({ stage: 2, damageShare: 0.01, rank: 1, random: () => 0.99 });
    expect(Object.values(top).reduce((sum, count) => sum + count, 0)).toBe(1);
  });

  it('云游商人残卷：替换 1～2 单材料，单数不变，材料仍有玄铁和神木，残卷只出玄 / 地阶', () => {
    const random = seeded(31);
    for (let visit = 0; visit < 60; visit += 1) {
      const base = generateMerchantGoods(random);
      const goods = withTechniqueScrolls(base, random);
      expect(goods).toHaveLength(base.length);
      const scrolls = goods.filter((item) => techniqueIdOfScrollItem(item.itemId) !== null);
      expect(scrolls.length).toBeGreaterThanOrEqual(1);
      expect(scrolls.length).toBeLessThanOrEqual(2);
      expect(goods.some((item) => item.itemId === 'xuantie')).toBe(true);
      expect(goods.some((item) => item.itemId === 'shenmu')).toBe(true);
      for (const scroll of scrolls) {
        const technique = findTechnique(techniqueIdOfScrollItem(scroll.itemId)!)!;
        expect(['xuan', 'di']).toContain(technique.tier);
        expect(scroll.quantity).toBeGreaterThanOrEqual(2);
        expect(scroll.quantity).toBeLessThanOrEqual(5);
        expect(scroll.startPrice % 1000).toBe(0);
        expect(scroll.buyoutPrice).toBeGreaterThan(scroll.startPrice);
      }
    }
  });
});

describe('功法 · 镇妖塔战斗效果', () => {
  it('不修功法的弟子：结果里没有 techniqueSummary，战报行没有 tags / heals', () => {
    const result = simulateTowerBattle({ floor: 9, fighters: party({ power: 20 }), arenaLevel: 0, random: seeded(3) });
    expect('techniqueSummary' in result).toBe(false);
    for (const round of result.rounds) {
      expect('heals' in round).toBe(false);
      for (const hit of round.hits) expect('tags' in hit).toBe(false);
    }
  });

  it('青锋：本场第一次出手伤害 ×(1 + 0.5S)，战报带【青锋】，结算摘要记下额外伤害', () => {
    const base = party({ power: 20 });
    const plain = simulateTowerBattle({ floor: 1, fighters: base, arenaLevel: 0, random: sequence([0.5]) });
    const tech = simulateTowerBattle({
      floor: 1,
      fighters: withTechnique(base, 0, 'qingfeng'),
      arenaLevel: 0,
      random: sequence([0.5]),
    });
    const plainFirst = plain.rounds[0]!.hits[0]!;
    const techFirst = tech.rounds[0]!.hits[0]!;
    expect(techFirst.discipleId).toBe('d0');
    expect(techFirst.damage).toBeGreaterThan(plainFirst.damage);
    expect(techFirst.tags).toEqual(['青锋']);
    const entry = tech.techniqueSummary!.find((item) => item.discipleId === 'd0')!;
    expect(entry).toMatchObject({ techniqueName: '青锋剑诀', triggers: 1 });
    expect(entry.bonusDamage).toBeGreaterThan(0);
  });

  it('剑气：触发（随机数 0）额外造成伤害并带【剑气】；未触发（随机数 0.99）没有标签', () => {
    const members = withTechnique(party({ power: 20 }), 0, 'taiyi');
    const hit = simulateTowerBattle({ floor: 1, fighters: members, arenaLevel: 0, random: sequence([0]) }).rounds[0]!.hits[0]!;
    expect(hit.tags).toContain('剑气');
    const miss = simulateTowerBattle({ floor: 1, fighters: members, arenaLevel: 0, random: sequence([0.99]) }).rounds[0]!.hits[0]!;
    expect(miss.tags ?? []).not.toContain('剑气');
  });

  it('破甲：第一次出手必定暴击，即使暴击判定为失败（随机数 0.99）；之后出手 ×0.9', () => {
    const members = withTechnique(party({ power: 20 }), 0, 'pojia');
    const result = simulateTowerBattle({ floor: 1, fighters: members, arenaLevel: 0, random: sequence([0.99]) });
    const first = result.rounds[0]!.hits.find((hit) => hit.discipleId === 'd0')!;
    expect(first.crit).toBe(true);
    expect(first.tags).toContain('破甲');
  });

  it('金刚：开场血量提升，结算摘要记下 hpBonus 并计一次触发', () => {
    const plain = party({ power: 20, physique: 80 });
    const tech = withTechnique(plain, 0, 'jingang');
    const base = simulateTowerBattle({ floor: 1, fighters: plain, arenaLevel: 0, random: sequence([0.5]) });
    const boosted = simulateTowerBattle({ floor: 1, fighters: tech, arenaLevel: 0, random: sequence([0.5]) });
    expect(boosted.teamMaxHp).toBeGreaterThan(base.teamMaxHp);
    const entry = boosted.techniqueSummary!.find((item) => item.discipleId === 'd0')!;
    expect(entry.hpBonus).toBeGreaterThan(0);
    expect(entry.triggers).toBe(1);
  });

  it('血身：每回合结束回血（记入 heals 与摘要的 healed），回血不超过队伍血量上限', () => {
    const members = withTechnique(party({ power: 1, physique: 100_000 }), 0, 'xueshen');
    const result = simulateTowerBattle({ floor: 1, fighters: members, arenaLevel: 0, random: sequence([0.5]) });
    const heals = result.rounds.flatMap((round) => round.heals ?? []);
    expect(heals.length).toBeGreaterThan(0);
    expect(heals.every((heal) => heal.discipleId === 'd0' && heal.amount > 0)).toBe(true);
    expect(result.techniqueSummary!.find((item) => item.discipleId === 'd0')!.healed).toBe(
      heals.reduce((sum, heal) => sum + heal.amount, 0),
    );
    for (const round of result.rounds) expect(round.teamHp).toBeLessThanOrEqual(result.teamMaxHp);
  });

  it('百毒不侵：剧毒按人头分摊，持有者那一份免除（扣血少于全额 2.5%）', () => {
    const members = withTechnique(party({ power: towerStandardPower(15), physique: 100_000 }), 0, 'baidu');
    expect(towerAffixOf(15)?.id).toBe('poison');
    const result = simulateTowerBattle({ floor: 15, fighters: members, arenaLevel: 0, random: sequence([0.5]) });
    expect(result.rounds[0]!.poisonDamage).toBeLessThan(Math.floor(result.teamMaxHp * 0.025));
    expect(result.rounds[0]!.poisonDamage).toBeGreaterThan(0);
    expect(result.techniqueSummary!.find((item) => item.discipleId === 'd0')!.triggers).toBeGreaterThanOrEqual(1);
  });

  it('流云：随机数全为 0 时单次出手连续追击（最多 3 次），追击带【流云】标签', () => {
    const members = withTechnique(party({ power: 1, speed: 200, physique: 100_000 }), 0, 'liuyun');
    const round = simulateTowerBattle({ floor: 1, fighters: members, arenaLevel: 0, random: sequence([0]) }).rounds[0]!;
    const own = round.hits.filter((hit) => hit.discipleId === 'd0');
    expect(own).toHaveLength(3);
    // 第一次追击在无功法时也会发生（基础上限 30% 以内），不算流云的额外伤害；第三次是流云带来的连续追击。
    expect(own[1]!.extra).toBe(true);
    expect(own[1]!.tags ?? []).toEqual([]);
    expect(own[2]!.extra).toBe(true);
    expect(own[2]!.tags).toEqual(['流云']);
  });

  it('鬼影：第 1 回合必定追击（即使追击判定失败），追击带【鬼影】', () => {
    const members = withTechnique(party({ power: 1, speed: 50, physique: 100_000 }), 0, 'guiying');
    const round = simulateTowerBattle({ floor: 1, fighters: members, arenaLevel: 0, random: sequence([0.99]) }).rounds[0]!;
    const extra = round.hits.find((hit) => hit.discipleId === 'd0' && hit.extra);
    expect(extra?.tags).toEqual(['鬼影']);
  });

  it('天机：暴击判定只在天机加成后才成功的那次出手带【天机】（随机数 0.25：基础 20% 不暴击，×2 后暴击）', () => {
    const members = withTechnique(party({ power: 20, luck: 100 }), 0, 'tianji');
    const hit = simulateTowerBattle({ floor: 1, fighters: members, arenaLevel: 0, random: sequence([0.25]) }).rounds[0]!.hits[0]!;
    expect(hit.discipleId).toBe('d0');
    expect(hit.crit).toBe(true);
    expect(hit.tags).toEqual(['天机']);
  });

  it('破军：暴击伤害倍率加成（同一暴击下伤害更高，战报带【破军】）', () => {
    const plain = party({ power: 20, luck: 100 });
    const tech = withTechnique(plain, 0, 'pojun');
    const base = simulateTowerBattle({ floor: 1, fighters: plain, arenaLevel: 0, random: sequence([0]) }).rounds[0]!.hits[0]!;
    const boosted = simulateTowerBattle({ floor: 1, fighters: tech, arenaLevel: 0, random: sequence([0]) }).rounds[0]!.hits[0]!;
    expect(boosted.crit).toBe(true);
    expect(boosted.damage).toBeGreaterThan(base.damage);
    expect(boosted.tags).toEqual(['破军']);
  });

  it('九转：第 2 回合起伤害增益并带【九转】；第 1 回合不带标签', () => {
    const members = withTechnique(party({ power: 1, physique: 100_000 }), 0, 'jiuzhuan');
    const result = simulateTowerBattle({ floor: 1, fighters: members, arenaLevel: 0, random: sequence([0.5]) });
    expect(result.rounds.length).toBe(TOWER_MAX_ROUNDS);
    const round2 = result.rounds[1]!.hits.find((hit) => hit.discipleId === 'd0')!;
    expect(round2.tags).toEqual(['九转']);
    const round1 = result.rounds[0]!.hits.find((hit) => hit.discipleId === 'd0')!;
    expect(round1.tags ?? []).toEqual([]);
  });

  it('背水：队伍血量低于 35% 后持有者出手带【背水】（用一组战力扫描找到触发的场景）', () => {
    let tagged = false;
    // 1 层、体魄 1 的弱队：妖物一刀把队伍打到 35% 以下，但没有打空，持有者之后的出手带【背水】。
    for (let power = 3; power <= 7 && !tagged; power += 0.25) {
      const members = withTechnique(party({ power, physique: 1 }), 0, 'beishui');
      const result = simulateTowerBattle({ floor: 1, fighters: members, arenaLevel: 0, random: seeded(Math.round(power * 100)) });
      if (result.rounds.some((round) => round.hits.some((hit) => hit.tags?.includes('背水')))) tagged = true;
    }
    expect(tagged).toBe(true);
  });

  it('同样的随机序列 + 功法 → 结果确定（可重复）', () => {
    const make = (): TowerBattleResult =>
      simulateTowerBattle({
        floor: 12,
        fighters: withTechnique(party({ power: towerStandardPower(12) }), 1, 'taiyi', 6, 4_000),
        arenaLevel: 2,
        random: sequence([0.13, 0.71, 0.42, 0.95, 0.08, 0.66]),
      });
    expect(make()).toEqual(make());
  });
});

describe('功法 · 世界 Boss 修正（rollDamage / rollOutcome 的新参数）', () => {
  it('破军 +0.6 与天机未暴击 ×0.9：暴击伤害 = 基数 × (1.5 + 加成)；未暴击 = 基数 × 0.9', () => {
    const common = { partyBase: 1_000, arenaLevel: 0, avgLuck: 100, frenzy: false, random: () => 0.5 };
    // 随机数 0：暴击判定必定成功（20% 以内），浮动取最小值，两次比较用的是同一组随机数。
    const crit = rollDamage({ ...common, random: () => 0, critBonusBase: 0, critMultiplierBonus: 0.6 });
    expect(crit.crit).toBe(true);
    const noBonus = rollDamage({ ...common, random: () => 0, critBonusBase: 0 });
    expect(crit.damage / noBonus.damage).toBeCloseTo((1.5 + 0.6) / 1.5, 2);
    const miss = rollDamage({ ...common, avgLuck: 0, random: sequence([0.5, 0.99]), nonCritMultiplier: 0.9 });
    const missBase = rollDamage({ ...common, avgLuck: 0, random: sequence([0.5, 0.99]) });
    expect(miss.crit).toBe(false);
    expect(miss.damage / missBase.damage).toBeCloseTo(0.9, 2);
  });

  it('金刚 / 血身 / 百毒的受伤倍率：倍率 0 时不再普通受伤；重伤倍率同理', () => {
    const immune = rollOutcome({ fatigueCount: 0, physique: 50, berserk: false, normalInjuryMultiplier: 0, random: () => 0 });
    expect(immune).toEqual({ severe: false, injured: false });
    const noSevere = rollOutcome({ fatigueCount: 3, physique: 50, berserk: false, severeInjuryMultiplier: 0, random: () => 0 });
    expect(noSevere.severe).toBe(false);
    // 缺省倍率 = 原来的概率：随机数 0 时（< 任何正概率）必定受伤。
    expect(rollOutcome({ fatigueCount: 0, physique: 50, berserk: false, random: () => 0 }).injured).toBe(true);
  });
});

describe('功法 · 不修功法结果不变（回归）', () => {
  it('200 场固定种子（覆盖 1～120 层、词缀与首领层）的战斗结果 JSON 摘要与改造前一致', () => {
    const random = seeded(20_261_019);
    const digest = createHash('sha256');
    for (let index = 0; index < 200; index += 1) {
      const floor = 1 + ((index * 37) % 120);
      const attr = towerStandardAttr(floor);
      const power = towerStandardPower(floor) * (0.6 + random() * 0.8);
      const members = Array.from({ length: 5 }, (_, slot) =>
        fighter({
          id: `r${slot}`,
          name: `回归${slot}`,
          power,
          attack: Math.round(attr * (0.5 + random())),
          defense: Math.round(attr * (0.5 + random())),
          speed: Math.round(attr * (0.5 + random())),
          luck: 1 + Math.floor(random() * 100),
          physique: 1 + Math.floor(random() * 100),
          critBonusBp: slot === 0 ? 1_000 : 0,
          damageReductionBp: slot === 1 ? 2_000 : 0,
        }),
      );
      const result = simulateTowerBattle({ floor, fighters: members, arenaLevel: index % 6, random });
      digest.update(JSON.stringify(result));
    }
    // 摘要取自改造前的 tower.ts（HEAD 版本）用同一套输入算出的结果。
    expect(digest.digest('hex')).toBe(GOLDEN_DIGEST);
  });
});

/** 改造前（HEAD 的 tower.ts）同一套输入算出的摘要。 */
const GOLDEN_DIGEST = '8e4843f54531c4906cec5adf76e309bb0c2cc054c6fc89aa15216bf3885e1060';
