import { describe, expect, it } from 'vitest';

import {
  buildAdvisor,
  formatHours,
  type AdvisorBuilding,
  type AdvisorDisciple,
  type AdvisorEquipment,
  type AdvisorEquipmentItem,
  type AdvisorInput,
  type AdvisorResource,
  type AdvisorSectUpgrade,
  type AdvisorState,
} from '../../apps/web/src/utils/advisor';

/**
 * 宗门参谋（apps/web/src/utils/advisor.ts）：晋升目标（缺口、耗时、瓶颈）、补缺口的办法与收益、
 * 演武场、主力推荐（含未分配悟道值）与每名主力的战力增幅、小红点。
 */

const NOW_ISO = '2026-10-06T12:00:00Z';
const FUTURE = '2026-10-07T12:00:00Z';

const RESOURCE_NAMES: Record<string, string> = {
  spiritStone: '灵石',
  spiritualEnergy: '灵气',
  herb: '药材',
  ore: '矿石',
  xuantie: '玄铁',
  shenmu: '神木',
};

const BUILDING_NAMES: Record<string, string> = {
  arenaHall: '演武场',
  missionHall: '灵矿',
  spiritualArray: '聚灵阵',
};

const ASSIGNMENTS: AdvisorState['assignments'] = [
  { id: 'idle', currentCount: null, maxCount: null },
  { id: 'cultivating', currentCount: null, maxCount: null },
  { id: 'herbGathering', currentCount: 0, maxCount: null },
  { id: 'oreGathering', currentCount: 0, maxCount: null },
  { id: 'stoneMining', currentCount: 1, maxCount: 1 },
  { id: 'energyGathering', currentCount: 2, maxCount: 2 },
];

let seq = 0;
function disciple(overrides: Partial<AdvisorDisciple> = {}): AdvisorDisciple {
  seq += 1;
  return {
    id: `d${String(seq)}`,
    name: `弟子${String(seq)}`,
    talent: 'none',
    talentName: '无',
    assignment: 'cultivating',
    realmOrder: 0,
    stage: 1,
    stageName: '炼气一层',
    aptitude: 50,
    attack: 50,
    defense: 50,
    speed: 50,
    gear: { attack: 0, defense: 0, speed: 0 },
    gearPowerBonusBp: 0,
    combatPower: 100,
    stewardOffice: null,
    injuredUntil: null,
    severeInjuredUntil: null,
    canBreakthrough: false,
    breakthroughReadyExceptEnergy: false,
    bodyTemperingRemaining: 0,
    bodyTemperingTarget: null,
    bodyTemperingGain: 0,
    daoInsight: 0,
    daoInsightRemaining: 50,
    ...overrides,
  };
}

function building(defId: string, overrides: Partial<AdvisorBuilding> = {}): AdvisorBuilding {
  return {
    defId,
    name: BUILDING_NAMES[defId] ?? defId,
    level: 1,
    maxLevel: 5,
    upgradeCost: null,
    canUpgrade: false,
    blockedReason: null,
    ...overrides,
  };
}

/** 资源：数量用展示单位传入，内部换成最小单位字符串。 */
function resource(id: string, balance: number, ratePerHour = 0, capacity = 100_000): AdvisorResource {
  return {
    id,
    name: RESOURCE_NAMES[id] ?? id,
    balance: String(balance * 1000),
    capacity: String(capacity * 1000),
    ratePerHour: String(ratePerHour * 1000),
  };
}

function upgradeOf(cost: Record<string, number>, overrides: Partial<AdvisorSectUpgrade> = {}): AdvisorSectUpgrade {
  return {
    nextLevel: 6,
    nextLevelName: '名门',
    cost: Object.fromEntries(Object.entries(cost).map(([id, amount]) => [id, String(amount * 1000)])),
    requirements: [],
    canUpgrade: false,
    ...overrides,
  };
}

function stateOf(overrides: Partial<AdvisorState> = {}): AdvisorState {
  return {
    serverNow: NOW_ISO,
    resources: [],
    disciples: [],
    buildings: [],
    assignments: ASSIGNMENTS,
    sectUpgrade: null,
    ...overrides,
  };
}

function item(overrides: Partial<AdvisorEquipmentItem> = {}): AdvisorEquipmentItem {
  seq += 1;
  return {
    id: `e${String(seq)}`,
    name: '宝品·青锋剑',
    slot: 'weapon',
    quality: 'treasure',
    mainAttr: 'attack',
    mainValue: 20,
    subAttr: 'defense',
    subValue: 6,
    powerBonusBp: 700,
    discipleId: null,
    ...overrides,
  };
}

function gearOf(items: AdvisorEquipmentItem[], unlockedUpTo = 'spirit'): AdvisorEquipment {
  const order = ['common', 'spirit', 'treasure', 'immortal'];
  const names: Record<string, string> = { common: '凡品', spirit: '灵品', treasure: '宝品', immortal: '仙品' };
  return {
    unlocked: true,
    items,
    forgeOptions: order.map((quality) => ({
      quality,
      name: names[quality] ?? quality,
      unlocked: order.indexOf(quality) <= order.indexOf(unlockedUpTo),
    })),
  };
}

function run(state: AdvisorState, equipment: AdvisorEquipment | null = null) {
  const input: AdvisorInput = { state, equipment };
  return buildAdvisor(input);
}

describe('formatHours', () => {
  it('不到 1 小时 / 小时 / 48 小时起按天 / 无限', () => {
    expect(formatHours(0.5)).toBe('不到 1 小时');
    expect(formatHours(10.2)).toBe('约 11 小时');
    expect(formatHours(100)).toBe('约 5 天');
    expect(formatHours(Number.POSITIVE_INFINITY)).toBe('遥遥无期');
  });
});

describe('晋升目标', () => {
  it('宗门满级时没有目标', () => {
    expect(run(stateOf()).goal).toBeNull();
  });

  it('按产出估算每种资源的耗时，最慢的标为瓶颈', () => {
    const view = run(
      stateOf({
        resources: [resource('spiritStone', 4000, 60), resource('herb', 3000, 20)],
        sectUpgrade: upgradeOf({ spiritStone: 10_000, herb: 2000 }),
      }),
    );
    const goal = view.goal!;
    expect(goal.title).toBe('晋升名门（6 级）');
    const stone = goal.lines.find((line) => line.id === 'res:spiritStone')!;
    expect(stone.status).toBe('short');
    expect(stone.bottleneck).toBe(true);
    expect(stone.detail).toBe('还差 6000，每小时 +60，约 5 天');
    const herb = goal.lines.find((line) => line.id === 'res:herb')!;
    expect(herb.status).toBe('done');
    expect(herb.bottleneck).toBe(false);
    expect(goal.summary).toContain('瓶颈是灵石');
  });

  it('没有产出的资源：凑不齐；容量不够：存不下', () => {
    const goal = run(
      stateOf({
        resources: [resource('xuantie', 0, 0), resource('ore', 100, 10, 500)],
        sectUpgrade: upgradeOf({ xuantie: 20, ore: 800 }),
      }),
    ).goal!;
    expect(goal.lines.find((line) => line.id === 'res:xuantie')).toMatchObject({
      status: 'blocked',
      detail: '还差 20，目前没有产出',
      bottleneck: true,
    });
    expect(goal.lines.find((line) => line.id === 'res:ore')).toMatchObject({
      status: 'blocked',
      detail: '仓库上限只有 500，存不下',
    });
    expect(goal.summary).toContain('玄铁目前没有产出');
  });

  it('未达成的条件可跳转，弟子条件跳到弟子区', () => {
    const goal = run(
      stateOf({
        sectUpgrade: upgradeOf({}, {
          requirements: [
            { label: '2名筑基弟子（当前1名）', met: false },
            { label: '灵矿 5级（当前5级）', met: true },
          ],
        }),
      }),
    ).goal!;
    expect(goal.lines[0]).toMatchObject({ status: 'blocked', action: { kind: 'scroll', target: 'disciple-title' } });
    expect(goal.lines[1]).toMatchObject({ status: 'done', action: null });
    expect(goal.summary).toContain('还有 1 个条件未达成');
  });

  it('条件已齐：给出「现在就能晋升」并亮红点', () => {
    const view = run(stateOf({ sectUpgrade: upgradeOf({}, { canUpgrade: true }) }));
    expect(view.goal!.tips[0]).toMatchObject({ id: 'goal:ready', key: true });
    expect(view.alert).toBe(true);
  });
});

describe('怎么补', () => {
  it('灵石缺口：坊市卖掉晋升用不到的材料，算出立得多少与覆盖比例', () => {
    const view = run(
      stateOf({
        resources: [resource('spiritStone', 0, 60), resource('herb', 3000)],
        sectUpgrade: upgradeOf({ spiritStone: 1000 }),
      }),
    );
    const sell = view.goal!.tips.find((t) => t.id === 'goal:spiritStone:sell')!;
    expect(sell.text).toBe('坊市卖掉用不到的 2000 药材');
    expect(sell.detail).toBe('立得 1000 灵石，补上缺口的 100%');
    expect(sell.key).toBe(true);
    expect(view.alert).toBe(true);
  });

  it('晋升本身要用的材料不算富余', () => {
    const view = run(
      stateOf({
        resources: [resource('spiritStone', 0, 60), resource('herb', 3000)],
        sectUpgrade: upgradeOf({ spiritStone: 1000, herb: 3000 }),
      }),
    );
    expect(view.goal!.tips.some((t) => t.id === 'goal:spiritStone:sell')).toBe(false);
  });

  it('岗位空位：补满后的每小时产出与缺口耗时变化', () => {
    const view = run(
      stateOf({
        resources: [resource('spiritStone', 0, 60)],
        assignments: [{ id: 'stoneMining', currentCount: 1, maxCount: 2 }],
        sectUpgrade: upgradeOf({ spiritStone: 600 }),
      }),
    );
    const post = view.goal!.tips.find((t) => t.id === 'goal:spiritStone:post')!;
    expect(post.text).toBe('采灵还空 1 个位置');
    expect(post.detail).toBe('每小时 +15 灵石，缺口约 10 小时 → 约 8 小时');
    expect(post.key).toBe(false);
  });

  it('不限人数的岗位：按闲置弟子数给出', () => {
    const view = run(
      stateOf({
        resources: [resource('herb', 0, 20)],
        disciples: [disciple({ assignment: 'idle' }), disciple({ assignment: 'idle', journey: { status: 'active' } })],
        sectUpgrade: upgradeOf({ herb: 400 }),
      }),
    );
    const post = view.goal!.tips.find((t) => t.id === 'goal:herb:post')!;
    expect(post.text).toBe('派 1 名闲置弟子去药园');
    expect(post.detail).toBe('每小时 +20 药材，缺口约 20 小时 → 约 10 小时');
  });

  it('不限人数的岗位且没有闲置弟子：建议再调 1 人', () => {
    const view = run(
      stateOf({
        resources: [resource('ore', 0, 15)],
        disciples: [disciple()],
        sectUpgrade: upgradeOf({ ore: 300 }),
      }),
    );
    const post = view.goal!.tips.find((t) => t.id === 'goal:ore:post')!;
    expect(post.text).toBe('再调 1 名弟子去采矿');
    expect(post.detail).toBe('每小时 +15 矿石，缺口约 20 小时 → 约 10 小时');
  });

  it('灵矿升级：每小时多多少、花费与回本天数', () => {
    const view = run(
      stateOf({
        resources: [resource('spiritStone', 0, 60)],
        buildings: [
          building('missionHall', {
            level: 5,
            maxLevel: 10,
            upgradeCost: { spiritStone: '1000000', ore: '1500000' },
            canUpgrade: false,
            blockedReason: '需要宗门 6 级',
          }),
        ],
        sectUpgrade: upgradeOf({ spiritStone: 5000 }),
      }),
    );
    const tip = view.goal!.tips.find((t) => t.id === 'goal:spiritStone:building')!;
    expect(tip.text).toBe('灵矿升到 6 级');
    expect(tip.detail).toBe('每小时 +12 灵石，花 1000 灵石 + 1500 矿石，约 4 天回本，暂不能升：需要宗门 6 级');
  });

  it('材料缺口：灵石富余时坊市直接买齐', () => {
    const view = run(
      stateOf({
        resources: [resource('spiritStone', 1000), resource('ore', 0, 15)],
        sectUpgrade: upgradeOf({ ore: 100 }),
      }),
    );
    const buy = view.goal!.tips.find((t) => t.id === 'goal:ore:buy')!;
    expect(buy.text).toBe('坊市直接买齐 100 矿石');
    expect(buy.detail).toBe('花约 66.7 灵石（灵石富余 1000）');
    expect(buy.key).toBe(true);
  });

  it('玄铁缺口：神木兑换 + 赌石 + 讨伐', () => {
    const view = run(
      stateOf({
        resources: [resource('xuantie', 0), resource('shenmu', 10)],
        sectUpgrade: upgradeOf({ xuantie: 10 }),
      }),
    );
    const ids = view.goal!.tips.map((t) => t.id);
    expect(ids).toEqual(['goal:xuantie:exchange', 'goal:xuantie:gamble', 'goal:xuantie:boss']);
    expect(view.goal!.tips[0]).toMatchObject({ text: '坊市用 10 神木换 5 玄铁', detail: '补上缺口的 50%', key: true });
  });
});

describe('演武场', () => {
  it('可升级时给出收益与花费并亮红点；满级不出', () => {
    const view = run(
      stateOf({
        buildings: [building('arenaHall', { level: 2, upgradeCost: { spiritStone: '80000' }, canUpgrade: true })],
      }),
    );
    expect(view.arena).toMatchObject({
      text: '演武场升到 3 级',
      detail: '讨伐 / 镇妖塔 / 秘境战斗力 +10%，花 80 灵石',
      key: true,
    });
    expect(view.alert).toBe(true);
    expect(run(stateOf({ buildings: [building('arenaHall', { level: 5 })] })).arena).toBeNull();
  });
});

describe('主力推荐', () => {
  it('排除执事、取前 5；未分配悟道值计入潜力', () => {
    const steward = disciple({ aptitude: 100, stewardOffice: 'forge' });
    const plain = Array.from({ length: 5 }, () => disciple());
    const insightful = disciple({ daoInsight: 40 });
    const view = run(stateOf({ disciples: [steward, ...plain, insightful] }));
    const ids = view.mains.map((main) => main.discipleId);
    expect(ids).toHaveLength(5);
    expect(ids).not.toContain(steward.id);
    expect(ids[0]).toBe(insightful.id);
    expect(view.mains[0]!.reasons[0]).toBe('悟道值 40 点未分配');
  });

  it('分配悟道值：攻击 → 防御 → 身法依次加到 100，只算手上的点数', () => {
    const d = disciple({ attack: 90, daoInsight: 30, daoInsightRemaining: 50 });
    const main = run(stateOf({ disciples: [d] })).mains[0]!;
    expect(main.tips[0]).toMatchObject({
      id: `main:${d.id}:insight`,
      text: '分配 30 点悟道值（攻击 +10、防御 +20）',
      detail: '战力 +6.6%',
      key: true,
    });
  });

  it('可突破：按境界基数算增幅；只差灵气不亮红点', () => {
    const ready = disciple({ realmOrder: 2, stage: 3, canBreakthrough: true });
    const energy = disciple({ realmOrder: 2, stage: 3, breakthroughReadyExceptEnergy: true });
    const view = run(stateOf({ disciples: [ready, energy] }));
    const byId = (id: string) => view.mains.find((main) => main.discipleId === id)!;
    expect(byId(ready.id).tips[0]).toMatchObject({ text: '可以突破了', detail: '战力 +11%', key: true });
    expect(byId(energy.id).tips[0]).toMatchObject({ text: '只差灵气就能突破', detail: '突破后战力 +11%', key: false });
  });

  it('背包里更好的装备：换上并算增幅；同一件只推荐给一个人', () => {
    const first = disciple({ aptitude: 90 });
    const second = disciple();
    const bag = item();
    const view = run(stateOf({ disciples: [first, second] }), gearOf([bag], 'none'));
    const tipsOf = (id: string) => view.mains.find((main) => main.discipleId === id)!.tips;
    expect(tipsOf(first.id)[0]).toMatchObject({ text: '换上背包里的宝品·青锋剑', detail: '战力 +14%', key: true });
    expect(tipsOf(second.id).some((t) => t.id.includes(':bag:'))).toBe(false);
  });

  it('空格与低品质：按炼器坊能炼的最高品质估算', () => {
    const d = disciple();
    const worn = item({ slot: 'armor', quality: 'common', mainAttr: 'defense', mainValue: 8, powerBonusBp: 200, discipleId: d.id });
    const view = run(
      stateOf({ disciples: [{ ...d, gear: { attack: 0, defense: 14, speed: 0 }, gearPowerBonusBp: 200 }] }),
      gearOf([worn], 'spirit'),
    );
    const forge = view.mains[0]!.tips.find((t) => t.id.endsWith(':forge'))!;
    expect(forge.text).toBe('炼灵品：补上兵器、法器，换掉护甲');
    expect(forge.detail).toMatch(/^战力约 \+/);
  });

  it('装备视图未加载：不出装备建议也不报错', () => {
    const view = run(stateOf({ disciples: [disciple()] }), null);
    expect(view.mains[0]!.tips).toEqual([]);
    expect(view.alert).toBe(false);
  });

  it('淬体丹：按服务端预览的弱项与增量算增幅', () => {
    const d = disciple({ bodyTemperingRemaining: 2, bodyTemperingTarget: 'defense', bodyTemperingGain: 10 });
    const tip = run(stateOf({ disciples: [d] })).mains[0]!.tips[0]!;
    expect(tip.text).toBe('服淬体丹（防御 +10）');
    expect(tip.key).toBe(false);
    const tiny = disciple({ bodyTemperingRemaining: 2, bodyTemperingTarget: 'defense', bodyTemperingGain: 2 });
    expect(run(stateOf({ disciples: [tiny] })).mains[0]!.tips).toEqual([]);
  });

  it('重伤 / 受伤给出说明', () => {
    const severe = disciple({ severeInjuredUntil: FUTURE });
    const hurt = disciple({ injuredUntil: FUTURE });
    const view = run(stateOf({ disciples: [severe, hurt] }));
    const noteOf = (id: string) => view.mains.find((main) => main.discipleId === id)!.note;
    expect(noteOf(severe.id)).toBe('重伤卧床，静养痊愈前无法出战');
    expect(noteOf(hurt.id)).toBe('受伤未愈，先疗伤再出战');
  });
});
