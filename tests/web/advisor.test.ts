import { describe, expect, it } from 'vitest';

import {
  buildAdvisor,
  type AdvisorBuilding,
  type AdvisorDisciple,
  type AdvisorEquipment,
  type AdvisorHub,
  type AdvisorInput,
  type AdvisorState,
} from '../../apps/web/src/utils/advisor';

/**
 * 宗门参谋（apps/web/src/utils/advisor.ts）：主力推荐与理由、每名主力的下一步顺序、建筑、
 * 资源获取、资源使用、角标与「下一步」取前 3，以及 hub / equipment / dailyTasks 为 null 时不报错。
 */

const NOW_ISO = '2026-10-06T12:00:00Z';
const FUTURE = '2026-10-07T12:00:00Z';
const PAST = '2026-10-05T12:00:00Z';

const RESOURCE_NAMES: Record<string, string> = {
  spiritStone: '灵石',
  spiritualEnergy: '灵气',
  herb: '药材',
  ore: '矿石',
  xuantie: '玄铁',
};

const BUILDING_NAMES: Record<string, string> = {
  arenaHall: '演武场',
  missionHall: '灵矿',
  spiritualArray: '聚灵阵',
  scriptureLibrary: '藏经阁',
  forgeWorkshop: '炼器坊',
  herbGarden: '灵药园',
};

const ASSIGNMENTS: AdvisorState['assignments'] = [
  { id: 'idle', name: '闲置', currentCount: null, maxCount: null },
  { id: 'cultivating', name: '修炼', currentCount: null, maxCount: null },
  { id: 'herbGathering', name: '药园', currentCount: 0, maxCount: null },
  { id: 'oreGathering', name: '采矿', currentCount: 0, maxCount: null },
  { id: 'stoneMining', name: '采灵', currentCount: 1, maxCount: 1 },
  { id: 'energyGathering', name: '吐纳', currentCount: 2, maxCount: 2 },
];

const HUB_IDLE: AdvisorHub = {
  worldBoss: { attackable: false },
  tower: { sweepable: false },
  explore: { remaining: 0 },
  veins: { unlocked: false, holding: null, freeCount: 0 },
  auction: { claimable: 0 },
};

let seq = 0;
function disciple(overrides: Partial<AdvisorDisciple> = {}): AdvisorDisciple {
  seq += 1;
  return {
    id: `d${seq}`,
    name: `弟子${seq}`,
    talent: 'none',
    talentName: '无',
    assignment: 'cultivating',
    realmOrder: 0,
    realmName: '炼气',
    stageName: '炼气一层',
    aptitude: 50,
    attack: 50,
    defense: 50,
    speed: 50,
    combatPower: 100,
    stewardOffice: null,
    injuredUntil: null,
    severeInjuredUntil: null,
    canBreakthrough: false,
    breakthroughReadyExceptEnergy: false,
    bodyTemperingRemaining: 0,
    bodyTemperingTarget: null,
    aptitudePillRemaining: 0,
    ...overrides,
  };
}

function building(defId: string, overrides: Partial<AdvisorBuilding> = {}): AdvisorBuilding {
  return {
    defId,
    name: BUILDING_NAMES[defId] ?? defId,
    level: 1,
    maxLevel: 5,
    canUpgrade: false,
    blockedReason: '需要宗门 3 级',
    ...overrides,
  };
}

function resource(id: string, overrides: Partial<AdvisorState['resources'][number]> = {}): AdvisorState['resources'][number] {
  return {
    id,
    name: RESOURCE_NAMES[id] ?? id,
    balance: '0',
    capacity: '1000',
    capped: false,
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
    stewards: { offices: [] },
    // 默认名额已满（2 人在外）：没有历练空位，测试时按需改成有空位。
    journey: { activeCount: 2, maxConcurrent: 2, minAtHome: 3 },
    ...overrides,
  };
}

function run(
  state: Partial<AdvisorState> = {},
  extra: Partial<Omit<AdvisorInput, 'state'>> = {},
): ReturnType<typeof buildAdvisor> {
  return buildAdvisor({
    state: stateOf(state),
    hub: HUB_IDLE,
    equipment: null,
    dailyTasks: null,
    dispatchSuggestionCount: 0,
    ...extra,
  });
}

/** 装备视图：只放这次测试用到的字段。 */
function gear(items: AdvisorEquipment['items'], unlocked = true): AdvisorEquipment {
  return { unlocked, items };
}

function wornItem(discipleId: string, slot: string, quality = 'treasure', refineLevel = 0): AdvisorEquipment['items'][number] {
  return { discipleId, slot, quality, refineLevel };
}

function nextStepText(disciples: AdvisorDisciple[], equipment: AdvisorEquipment | null = null): string | null {
  const view = run({ disciples }, { equipment });
  return view.mainDisciples[0]?.nextStep?.text ?? null;
}

describe('主力推荐', () => {
  it('执事不进主力，其余按潜力分取前 5', () => {
    const steward = disciple({ name: '执事', stewardOffice: 'alchemy', aptitude: 100, attack: 100, defense: 100, speed: 100 });
    const others = [90, 85, 80, 75, 70, 65, 60].map((aptitude) => disciple({ aptitude }));
    const view = run({ disciples: [steward, ...others] });
    expect(view.mainDisciples.map((item) => item.discipleId)).toEqual(others.slice(0, 5).map((item) => item.id));
    expect(view.mainDisciples.some((item) => item.discipleId === steward.id)).toBe(false);
  });

  it('资质、战斗属性、战斗天赋都会影响排序；同分按战力高的在前', () => {
    // 潜力分（境界相同，只看资质、战斗属性、天赋）：资质 95 → 60.25；战斗属性 90 → 58.5；
    // 战意天赋（资质 60、战斗属性 50）→ 52.5；资质 70 → 49.0；无天赋（资质 60）→ 44.5。
    const highAptitude = disciple({ name: '高资质', aptitude: 95 });
    const mid = disciple({ name: '中资质', aptitude: 70 });
    const fighter = disciple({ name: '战斗属性高', aptitude: 60, attack: 90, defense: 90, speed: 90 });
    const talented = disciple({ name: '战意天赋', aptitude: 60, talent: 'combat', talentName: '战意' });
    const plain = disciple({ name: '无天赋', aptitude: 60 });
    const view = run({ disciples: [plain, mid, talented, fighter, highAptitude] });
    expect(view.mainDisciples.map((item) => item.name)).toEqual(['高资质', '战斗属性高', '战意天赋', '中资质', '无天赋']);

    // 潜力分完全相同（资质 40、属性相同）时，战力高的排前面。
    const tieLow = disciple({ name: '同分低战力', aptitude: 40, combatPower: 80 });
    const tieHigh = disciple({ name: '同分高战力', aptitude: 40, combatPower: 300 });
    const tie = run({ disciples: [tieLow, tieHigh] }).mainDisciples.map((item) => item.name);
    expect(tie).toEqual(['同分高战力', '同分低战力']);
  });

  it('理由标签：资质高、战斗属性高、战斗天赋、全宗境界前 2；都不满足时「综合最均衡」', () => {
    const top = disciple({ name: '全能', aptitude: 90, attack: 92, defense: 60, speed: 40, talent: 'critical', talentName: '会心', realmOrder: 6, realmName: '元婴' });
    const rival1 = disciple({ realmOrder: 7 });
    const rival2 = disciple({ realmOrder: 8 });
    const plain = disciple({ name: '均衡', aptitude: 50, attack: 50, defense: 50, speed: 50, realmOrder: 1 });
    const view = run({ disciples: [top, rival1, rival2, plain] });
    const byName = Object.fromEntries(view.mainDisciples.map((item) => [item.name, item]));
    // 理由最多 3 条：资质 → 战斗属性 → 战斗天赋 → 境界领先，超出的舍掉。
    expect(byName['全能']?.reasons).toEqual(['资质 90 · 修炼快', '攻击 92', '会心天赋']);
    expect(byName['均衡']?.reasons).toEqual(['综合最均衡']);

    const leader = disciple({ name: '境界领先', aptitude: 40, realmOrder: 5, realmName: '金丹', stageName: '金丹一层' });
    const lead = run({ disciples: [leader, disciple({ realmOrder: 1 })] }).mainDisciples[0];
    expect(lead?.reasons).toEqual(['境界领先']);
  });

  it('不输出分数字段：主力卡片只有名字、境界、天赋、战力、理由、错配与下一步', () => {
    const view = run({ disciples: [disciple({ aptitude: 80 })] });
    expect(Object.keys(view.mainDisciples[0] ?? {}).sort()).toEqual(
      ['combatPower', 'discipleId', 'misplaced', 'name', 'nextStep', 'realmName', 'reasons', 'stageName', 'talentName'].sort(),
    );
    expect(JSON.stringify(view)).not.toMatch(/score|potential|潜力|评分/i);
  });

  it('错配提醒：资质 ≥ 75、不在修炼岗、天赋不是产出类；悟道只对应修炼，不算产出类', () => {
    const idleHigh = disciple({ name: '闲置高资质', aptitude: 80, assignment: 'oreGathering' });
    const herb = disciple({ name: '灵植', aptitude: 80, talent: 'herbGathering', talentName: '灵植', assignment: 'oreGathering' });
    const cultivation = disciple({ name: '悟道', aptitude: 80, talent: 'cultivation', talentName: '悟道', assignment: 'oreGathering' });
    const inCultivation = disciple({ name: '在修炼', aptitude: 80, assignment: 'cultivating' });
    const view = run({ disciples: [idleHigh, herb, cultivation, inCultivation] });
    const byName = Object.fromEntries(view.mainDisciples.map((item) => [item.name, item.misplaced]));
    expect(byName['闲置高资质']).toBe('资质高，建议改去修炼');
    expect(byName['灵植']).toBeNull();
    expect(byName['悟道']).toBe('资质高，建议改去修炼');
    expect(byName['在修炼']).toBeNull();
  });
});

describe('每名主力的下一步（按顺序取第一条满足的）', () => {
  it('受伤 > 可突破 > 只差灵气 > 装备空格 > 凡品 / 灵品 > 未祭炼到八重 > 淬体丹 > 培元丹', () => {
    const everything = (overrides: Partial<AdvisorDisciple>): AdvisorDisciple =>
      disciple({
        injuredUntil: FUTURE,
        canBreakthrough: true,
        breakthroughReadyExceptEnergy: true,
        bodyTemperingRemaining: 1,
        bodyTemperingTarget: 'defense',
        aptitudePillRemaining: 1,
        aptitude: 70,
        ...overrides,
      });
    // 每一步的装备：两件（有空格）、三件但有凡品、三件宝品但未祭炼到八重。
    const twoWorn = [wornItem('x', 'weapon'), wornItem('x', 'armor')];
    const threeCommon = [wornItem('x', 'weapon', 'common'), wornItem('x', 'armor'), wornItem('x', 'artifact')];
    const threeRefine = [wornItem('x', 'weapon', 'treasure', 3), wornItem('x', 'armor', 'treasure', 8), wornItem('x', 'artifact', 'treasure', 8)];
    const threeRefined = [wornItem('x', 'weapon', 'treasure', 8), wornItem('x', 'armor', 'treasure', 8), wornItem('x', 'artifact', 'treasure', 8)];

    const chain: { name: string; text: string; d: AdvisorDisciple; items: AdvisorEquipment['items'] }[] = [];
    const withId = (items: AdvisorEquipment['items'], d: AdvisorDisciple): AdvisorEquipment['items'] =>
      items.map((item) => ({ ...item, discipleId: d.id }));

    // 1) 受伤压过一切。
    let d = everything({});
    chain.push({ name: '受伤', text: '受伤未愈，去疗伤', d, items: withId(threeRefined, d) });
    // 2) 去掉受伤：可突破。
    d = everything({ injuredUntil: null });
    chain.push({ name: '可突破', text: '可以突破了', d, items: withId(threeRefined, d) });
    // 3) 不能突破但只差灵气。
    d = everything({ injuredUntil: null, canBreakthrough: false });
    chain.push({ name: '只差灵气', text: '只差灵气就能突破', d, items: withId(threeRefined, d) });
    // 4) 装备有空格。
    d = everything({ injuredUntil: null, canBreakthrough: false, breakthroughReadyExceptEnergy: false });
    chain.push({ name: '装备空格', text: '装备有空格，去炼器或功勋兑换', d, items: withId(twoWorn, d) });
    // 5) 穿着凡品。
    d = everything({ injuredUntil: null, canBreakthrough: false, breakthroughReadyExceptEnergy: false });
    chain.push({ name: '凡品', text: '穿着凡品 / 灵品，换成宝品以上', d, items: withId(threeCommon, d) });
    // 6) 祭炼未到八重。
    d = everything({ injuredUntil: null, canBreakthrough: false, breakthroughReadyExceptEnergy: false });
    chain.push({ name: '祭炼', text: '装备还没祭炼到八重，去祭炼', d, items: withId(threeRefine, d) });
    // 7) 淬体丹补弱项（装备都已八重）。
    d = everything({ injuredUntil: null, canBreakthrough: false, breakthroughReadyExceptEnergy: false });
    chain.push({ name: '淬体丹', text: '用淬体丹补「防御」等弱项', d, items: withId(threeRefined, d) });
    // 8) 培元丹提资质。
    d = everything({ injuredUntil: null, canBreakthrough: false, breakthroughReadyExceptEnergy: false, bodyTemperingRemaining: 0, bodyTemperingTarget: null });
    chain.push({ name: '培元丹', text: '用培元丹提资质', d, items: withId(threeRefined, d) });

    for (const step of chain) {
      expect(nextStepText([step.d], gear(step.items)), step.name).toBe(step.text);
    }
  });

  it('以上都没有：下一步为 null（页面显示「状态良好，继续修炼」，不计入角标）', () => {
    const d = disciple({ aptitude: 60 });
    // 三个装备格都是八重宝品：装备相关的步骤都不出。
    const full = gear([
      wornItem(d.id, 'weapon', 'treasure', 8),
      wornItem(d.id, 'armor', 'treasure', 8),
      wornItem(d.id, 'artifact', 'treasure', 8),
    ]);
    const view = run({ disciples: [d] }, { equipment: full });
    expect(view.mainDisciples[0]?.nextStep).toBeNull();
    expect(view.badgeCount).toBe(0);
  });

  it('装备视图没加载（或炼器未开放）时跳过装备相关的步骤', () => {
    const d = disciple({ assignment: 'cultivating', bodyTemperingRemaining: 1, bodyTemperingTarget: 'speed' });
    // 没有装备视图：空格 / 凡品 / 祭炼都不出，直接落到淬体丹。
    expect(nextStepText([d], null)).toBe('用淬体丹补「身法」等弱项');
    // 炼器未开放的装备视图（尚未解锁）同样跳过。
    expect(nextStepText([d], gear([], false))).toBe('用淬体丹补「身法」等弱项');
  });

  it('已经过期的伤势不算受伤；下一步的动作：受伤打开弟子详情，空格去炼器', () => {
    const healed = disciple({ injuredUntil: PAST });
    expect(nextStepText([healed], null)).toBeNull();

    const hurt = disciple({ injuredUntil: FUTURE });
    const view = run({ disciples: [hurt] });
    expect(view.mainDisciples[0]?.nextStep?.action).toEqual({ kind: 'disciple', discipleId: hurt.id });

    const slot = disciple({});
    const slotView = run({ disciples: [slot] }, { equipment: gear([wornItem(slot.id, 'weapon')]) });
    expect(slotView.mainDisciples[0]?.nextStep?.action).toEqual({ kind: 'panel', panel: 'forge' });
  });
});

describe('建筑', () => {
  it('未满级的建筑按 演武场 → 灵矿 → 聚灵阵 → 藏经阁 → 炼器坊 → 灵药园 → 其他 排序；满级的不出', () => {
    const view = run({
      buildings: [
        building('unknownHall', { canUpgrade: true }),
        building('herbGarden', { canUpgrade: true }),
        building('forgeWorkshop', { canUpgrade: true }),
        building('scriptureLibrary', { canUpgrade: true }),
        building('spiritualArray', { canUpgrade: true }),
        building('missionHall', { canUpgrade: true }),
        building('arenaHall', { canUpgrade: true }),
        building('maxedHall', { level: 5, maxLevel: 5, canUpgrade: false }),
      ],
    });
    expect(view.buildings.map((item) => item.id)).toEqual([
      'building:arenaHall',
      'building:missionHall',
      'building:spiritualArray',
      'building:scriptureLibrary',
      'building:forgeWorkshop',
      'building:herbGarden',
      'building:unknownHall',
    ]);
  });

  it('可升级计入角标并带收益文案；不能升级只显示 blockedReason，不计入角标', () => {
    const view = run({
      buildings: [
        building('arenaHall', { canUpgrade: true }),
        building('missionHall', { canUpgrade: false, blockedReason: '需要宗门 3 级' }),
      ],
    });
    const arena = view.buildings[0]!;
    const mission = view.buildings[1]!;
    expect(arena.text).toBe('演武场（战斗力每级 +10%）可以升级');
    expect(arena.countsTowardBadge).toBe(true);
    expect(mission.text).toBe('灵矿（灵石产出）暂不能升级：需要宗门 3 级');
    expect(mission.countsTowardBadge).toBe(false);
    expect(arena.action).toEqual({ kind: 'scroll', target: 'building-title' });
  });

  it('宗门可晋升（canUpgrade）放在建筑里，计入角标；不能晋升时不出', () => {
    const can = run({ sectUpgrade: { canUpgrade: true } });
    expect(can.buildings.map((item) => item.text)).toEqual(['宗门可晋升，容量与上限都会提高']);
    expect(can.buildings[0]?.action).toEqual({ kind: 'scroll', target: 'sect-upgrade-title' });
    expect(can.badgeCount).toBe(1);
    expect(run({ sectUpgrade: { canUpgrade: false } }).buildings).toEqual([]);
  });
});

describe('资源获取', () => {
  it('闲置弟子：派去修炼或岗位，动作是门人调度', () => {
    const view = run({ disciples: [disciple({ assignment: 'idle' }), disciple({ assignment: 'idle' })] });
    expect(view.income.map((item) => item.text)).toEqual(['2 名弟子闲置，派去修炼或岗位']);
    expect(view.income[0]?.action).toEqual({ kind: 'dispatch' });
  });

  it('采灵 / 吐纳还有空位：说明每人每小时多产多少，并给出空位数', () => {
    const view = run({
      assignments: [
        { id: 'stoneMining', name: '采灵', currentCount: 0, maxCount: 2 },
        { id: 'energyGathering', name: '吐纳', currentCount: 1, maxCount: 2 },
      ],
    });
    expect(view.income.map((item) => item.text)).toEqual([
      '采灵还空 2 个位置，多一人每小时多约 15 灵石',
      '吐纳还空 1 个位置，多一人每小时多约 10 灵气',
    ]);
  });

  it('执事空缺、历练还能派人：按名额字段算（同时在外不超过 2，门内至少留 3 人）', () => {
    const view = run(
      {
        disciples: [disciple(), disciple(), disciple(), disciple(), disciple()],
        stewards: { offices: [{ discipleId: null }, { discipleId: 'x' }] },
        journey: { activeCount: 0, maxConcurrent: 2, minAtHome: 3 },
      },
    );
    expect(view.income.map((item) => item.text)).toEqual([
      '1 个执事空缺，执事有产出 / 修炼加成',
      '还能派 2 名弟子历练',
    ]);
    // 只有 4 人：门内至少留 3 人，所以只能再派 1 人。
    const four = run({
      disciples: [disciple(), disciple(), disciple(), disciple()],
      journey: { activeCount: 0, maxConcurrent: 2, minAtHome: 3 },
    });
    expect(four.income.map((item) => item.text)).toEqual(['还能派 1 名弟子历练']);
  });

  it('每日收益没拿：日课、镇妖塔、秘境、讨伐、灵脉、拍卖行都与待办同一口径', () => {
    const view = run(
      {},
      {
        hub: {
          worldBoss: { attackable: true },
          tower: { sweepable: true },
          explore: { remaining: 2 },
          veins: { unlocked: true, holding: null, freeCount: 1 },
          auction: { claimable: 3 },
        },
        dailyTasks: {
          tasks: [
            { completed: true, claimed: false },
            { completed: true, claimed: true },
            { completed: false, claimed: false },
          ],
          chest: { available: false },
        },
      },
    );
    expect(view.income.map((item) => item.text)).toEqual([
      '日课有 1 个任务可领取灵石',
      '镇妖塔今日可扫荡',
      '秘境今日还可探 2 次',
      '讨伐开放中，可以出手',
      '1 条灵脉无主，可以进驻',
      '拍卖行 3 件待领取',
    ]);
    expect(view.income.every((item) => item.countsTowardBadge)).toBe(true);
  });

  it('日课宝箱可开启；门人调度有建议：各出一条', () => {
    const view = run({}, { dailyTasks: { tasks: [], chest: { available: true } }, dispatchSuggestionCount: 3 });
    // 资源获取的顺序：岗位 / 门人调度在前，每日收益在后。
    expect(view.income.map((item) => item.text)).toEqual([
      '门人调度有 3 项建议（天赋没在对口岗位）',
      '日课宝箱可开启',
    ]);
  });

  it('灵石来源偏慢：灵矿没满级且采灵没坐满；灵气同理（聚灵阵 / 吐纳）', () => {
    const slow = run({
      buildings: [building('missionHall', { level: 2, maxLevel: 10 }), building('spiritualArray', { level: 3, maxLevel: 10 })],
      assignments: [
        { id: 'stoneMining', name: '采灵', currentCount: 0, maxCount: 1 },
        { id: 'energyGathering', name: '吐纳', currentCount: 1, maxCount: 2 },
      ],
    });
    expect(slow.income.map((item) => item.text)).toEqual([
      '采灵还空 1 个位置，多一人每小时多约 15 灵石',
      '吐纳还空 1 个位置，多一人每小时多约 10 灵气',
      '灵石来源偏慢：先升灵矿、把采灵坐满',
      '灵气来源偏慢：先升聚灵阵、把吐纳坐满',
    ]);
    // 灵矿已满级、采灵也坐满：不算偏慢。
    const fine = run({
      buildings: [building('missionHall', { level: 10, maxLevel: 10 })],
      assignments: [{ id: 'stoneMining', name: '采灵', currentCount: 1, maxCount: 1 }],
    });
    expect(fine.income.some((item) => item.text.startsWith('灵石来源偏慢'))).toBe(false);
  });
});

describe('资源使用', () => {
  it('满仓浪费：文案带去处，计入角标，排在快满仓前面', () => {
    const view = run({
      resources: [
        resource('herb', { balance: '950', capacity: '1000' }),
        resource('spiritStone', { balance: '1000', capacity: '1000', capped: true }),
      ],
    });
    expect(view.spending.items.map((item) => item.text)).toEqual([
      '灵石已满仓，产出在浪费：升级建筑 / 祭炼',
      '药材快满仓了：炼丹 / 坊市卖出',
    ]);
    expect(view.spending.items.every((item) => item.countsTowardBadge)).toBe(true);
  });

  it('快满仓：余额达到容量的 90% 且未满仓才算；不到 90% 不出', () => {
    const enough = run({ resources: [resource('ore', { balance: '900', capacity: '1000' })] });
    expect(enough.spending.items.map((item) => item.text)).toEqual(['矿石快满仓了：炼器 / 坊市卖出 / 赌石']);
    const notYet = run({ resources: [resource('ore', { balance: '899', capacity: '1000' })] });
    expect(notYet.spending.items).toEqual([]);
  });

  it('玄铁 / 灵气的去处；固定说明始终在，不计入角标', () => {
    const view = run({
      resources: [resource('xuantie', { balance: '1000', capacity: '1000', capped: true }), resource('spiritualEnergy', { balance: '1000', capacity: '1000', capped: true })],
    });
    expect(view.spending.items.map((item) => item.text)).toEqual([
      '灵气已满仓，产出在浪费：突破',
      '玄铁已满仓，产出在浪费：炼器 / 祭炼',
    ]);
    expect(view.spending.note).toBe('灵石优先顺序：演武场 → 主力突破 → 装备配齐 → 祭炼到八重 → 其他');
    expect(view.badgeCount).toBe(2);
  });
});

describe('角标与下一步', () => {
  it('角标 = 可执行建议条数（主力下一步、建筑、资源获取、资源使用），不计说明类', () => {
    const subject = disciple({ name: '主力', canBreakthrough: true, assignment: 'cultivating' });
    const view = run(
      {
        disciples: [subject],
        buildings: [building('arenaHall', { canUpgrade: true }), building('missionHall', { canUpgrade: false })],
        resources: [resource('spiritStone', { balance: '1000', capacity: '1000', capped: true })],
        assignments: [
          { id: 'idle', name: '闲置', currentCount: null, maxCount: null },
          { id: 'cultivating', name: '修炼', currentCount: null, maxCount: null },
          { id: 'stoneMining', name: '采灵', currentCount: 1, maxCount: 1 },
          { id: 'energyGathering', name: '吐纳', currentCount: 2, maxCount: 2 },
        ],
      },
      {},
    );
    // 主力可突破 1 + 演武场 1 + 灵石满仓 1 = 3（灵矿不能升级只是说明，不计）。
    expect(view.badgeCount).toBe(3);
  });

  it('下一步置顶 3 条：按优先级（满仓 → 演武场 → 主力受伤 / 可突破 …）取，不重复计数', () => {
    const subject = disciple({ name: '主力', canBreakthrough: true });
    const view = run({
      disciples: [subject],
      buildings: [building('arenaHall', { canUpgrade: true })],
      resources: [resource('spiritStone', { balance: '1000', capacity: '1000', capped: true })],
      assignments: [
        { id: 'idle', name: '闲置', currentCount: null, maxCount: null },
        { id: 'cultivating', name: '修炼', currentCount: null, maxCount: null },
        { id: 'stoneMining', name: '采灵', currentCount: 1, maxCount: 1 },
        { id: 'energyGathering', name: '吐纳', currentCount: 2, maxCount: 2 },
      ],
    });
    expect(view.nextSteps.map((item) => item.id)).toEqual([
      'spend:full:spiritStone',
      'building:arenaHall',
      `main:${subject.id}:breakthrough`,
    ]);
    expect(view.badgeCount).toBe(3);
  });

  it('下一步只取可执行建议：说明类不进下一步；全部说明时下一步为空', () => {
    const view = run({ buildings: [building('missionHall', { canUpgrade: false, blockedReason: '需要宗门 3 级' })] });
    expect(view.nextSteps).toEqual([]);
    expect(view.badgeCount).toBe(0);
    expect(view.buildings).toHaveLength(1);
  });

  it('主力受伤比演武场可升级靠后，但比其他建筑靠前', () => {
    const hurt = disciple({ name: '受伤', injuredUntil: FUTURE });
    const view = run({
      disciples: [hurt],
      buildings: [building('arenaHall', { canUpgrade: true }), building('herbGarden', { canUpgrade: true })],
    });
    expect(view.nextSteps.map((item) => item.id)).toEqual(['building:arenaHall', `main:${hurt.id}:heal`, 'building:herbGarden']);
  });
});

describe('输入为 null 时不报错', () => {
  it('hub / equipment / dailyTasks 都为 null：只出弟子、建筑与资源类建议，不抛错', () => {
    const subject = disciple({ canBreakthrough: true });
    const view = buildAdvisor({
      state: stateOf({
        disciples: [subject],
        resources: [resource('spiritStone', { balance: '1000', capacity: '1000', capped: true })],
      }),
      hub: null,
      equipment: null,
      dailyTasks: null,
      dispatchSuggestionCount: 0,
    });
    expect(view.mainDisciples[0]?.nextStep?.text).toBe('可以突破了');
    expect(view.income).toEqual([]);
    expect(view.badgeCount).toBe(2);
  });

  it('没有弟子时主力为空，资源获取里只剩 hub 与日课的内容', () => {
    const view = buildAdvisor({
      state: stateOf({ stewards: { offices: [{ discipleId: null }] } }),
      hub: null,
      equipment: null,
      dailyTasks: null,
      dispatchSuggestionCount: 0,
    });
    expect(view.mainDisciples).toEqual([]);
    expect(view.income.map((item) => item.text)).toEqual(['1 个执事空缺，执事有产出 / 修炼加成']);
  });
});

describe('执事排除', () => {
  it('全部都是执事时没有主力，也不报错', () => {
    const view = run({ disciples: [disciple({ stewardOffice: 'alchemy' }), disciple({ stewardOffice: 'forging' })] });
    expect(view.mainDisciples).toEqual([]);
  });
});
