import { describe, expect, it } from 'vitest';

import {
  isTalentMisplaced,
  moveBatches,
  planDispatch,
  type DispatchDisciple,
  type DispatchInput,
  type DispatchOffice,
} from '../../apps/web/src/utils/discipleDispatch';
import { postInsights, type PostInsightDisciple } from '../../apps/web/src/utils/postInsights';
import { talentNeeds, topTalentNeeds, type TalentNeedDisciple } from '../../apps/web/src/utils/talentNeeds';

/**
 * 门人调度（apps/web/src/utils/discipleDispatch.ts）：天赋对口岗位、闲置派修炼、采灵 / 吐纳名额、
 * 执事推荐（境界最高、不在外、不在守擂阵容、每天一次），以及执行顺序。
 */

const NOW = Date.parse('2026-10-06T12:00:00Z');

const ASSIGNMENTS = [
  { id: 'idle', name: '闲置', maxCount: null },
  { id: 'cultivating', name: '修炼', maxCount: null },
  { id: 'herbGathering', name: '药园', maxCount: null },
  { id: 'oreGathering', name: '采矿', maxCount: null },
  { id: 'stoneMining', name: '采灵', maxCount: 1 },
  { id: 'energyGathering', name: '吐纳', maxCount: 2 },
];

let seq = 0;
function disciple(overrides: Partial<DispatchDisciple>): DispatchDisciple {
  seq += 1;
  return {
    id: `d${seq}`,
    name: `弟子${seq}`,
    talent: 'none',
    talentName: '无',
    talentEffect: '',
    assignment: 'cultivating',
    realmOrder: 0,
    stage: 1,
    canBreakthrough: false,
    severeInjuredUntil: null,
    journey: { status: 'none', endsAt: null },
    stewardOffice: null,
    ...overrides,
  };
}

function office(overrides: Partial<DispatchOffice>): DispatchOffice {
  return {
    office: 'alchemy',
    name: '丹房执事',
    talentId: 'alchemy',
    talentName: '丹道',
    discipleId: null,
    paused: false,
    canAppointToday: true,
    ...overrides,
  };
}

function input(disciples: DispatchDisciple[], extra: Partial<DispatchInput> = {}): DispatchInput {
  return { disciples, assignments: ASSIGNMENTS, offices: [], defenseLineup: null, serverNowMs: NOW, ...extra };
}

describe('岗位推荐', () => {
  it('天赋不在对口岗位的调过去，闲置的去修炼，无加成天赋的保持原岗位', () => {
    const herb = disciple({ talent: 'herbGathering', talentName: '灵植', assignment: 'oreGathering' });
    const ore = disciple({ talent: 'mining', talentName: '矿脉', assignment: 'oreGathering' });
    const idle = disciple({ talent: 'combat', talentName: '战意', assignment: 'idle' });
    const fighter = disciple({ talent: 'combat', talentName: '战意', assignment: 'herbGathering' });
    const plan = planDispatch(input([herb, ore, idle, fighter]));
    expect(plan.moves.map((item) => [item.discipleId, item.to])).toEqual([
      [herb.id, 'herbGathering'],
      [idle.id, 'cultivating'],
    ]);
    expect(isTalentMisplaced(herb)).toBe(true);
    expect(isTalentMisplaced(fighter)).toBe(false);
    expect(plan.issues.map((item) => item.key)).toEqual(['misplaced', 'idle']);
  });

  it('在外历练、重伤卧床的弟子不调动', () => {
    const away = disciple({
      talent: 'mining',
      assignment: 'idle',
      journey: { status: 'active', endsAt: '2026-10-06T13:00:00Z' },
    });
    const hurt = disciple({ assignment: 'idle', severeInjuredUntil: '2026-10-07T00:00:00Z' });
    const back = disciple({
      talent: 'mining',
      assignment: 'idle',
      journey: { status: 'active', endsAt: '2026-10-06T11:00:00Z' },
    });
    const plan = planDispatch(input([away, hurt, back]));
    expect(plan.moves.map((item) => item.discipleId)).toEqual([back.id]);
  });

  it('聚灵按境界高低占采灵 / 吐纳名额；被错位弟子占着的名额先腾出来，没天赋的占位者让位回去修炼', () => {
    const squatter = disciple({ talent: 'cultivation', assignment: 'stoneMining' });
    const low = disciple({ talent: 'spiritGathering', assignment: 'idle', realmOrder: 0 });
    const high = disciple({ talent: 'spiritGathering', assignment: 'cultivating', realmOrder: 3 });
    const filler = [1, 2].map(() => disciple({ assignment: 'energyGathering' }));
    const plan = planDispatch(input([squatter, low, high, ...filler]));
    expect(plan.moves.map((item) => [item.discipleId, item.to])).toEqual([
      [squatter.id, 'cultivating'],
      [high.id, 'stoneMining'],
      [filler[0]!.id, 'cultivating'],
      [low.id, 'energyGathering'],
    ]);
    expect(plan.issues.some((item) => item.key === 'crowded')).toBe(false);
  });

  it('4 个聚灵抢 2 个名额（采灵 1 + 吐纳 2 中已坐 3 人）：境界高的轮换上岗，低的回去修炼；同境界不换、待命不算问题', () => {
    const seatedLow = disciple({ talent: 'spiritGathering', assignment: 'stoneMining', realmOrder: 1 });
    const seatedMid = disciple({ talent: 'spiritGathering', assignment: 'energyGathering', realmOrder: 2 });
    const seatedTop = disciple({ talent: 'spiritGathering', assignment: 'energyGathering', realmOrder: 4 });
    const reserveHigh = disciple({ talent: 'spiritGathering', realmOrder: 3 });
    const reserveSame = disciple({ talent: 'spiritGathering', realmOrder: 2 });
    const plan = planDispatch(input([seatedLow, seatedMid, seatedTop, reserveHigh, reserveSame]));
    expect(plan.moves.map((item) => [item.discipleId, item.to])).toEqual([
      [seatedLow.id, 'cultivating'],
      [reserveHigh.id, 'stoneMining'],
    ]);
    // reserveSame 与在岗最低的同境界：留在修炼待命，不提示「天赋未发挥」，名册也不描虚线。
    expect(plan.misplacedIds).not.toContain(reserveSame.id);
    expect(plan.issues.find((item) => item.key === 'misplaced')?.disciples.map((item) => item.id)).toEqual([
      reserveHigh.id,
    ]);
  });

  it('能换的位子被在外历练的人占着：提示暂时没有位置', () => {
    const awaySeat = disciple({
      assignment: 'stoneMining',
      journey: { status: 'active', endsAt: '2026-10-06T20:00:00Z' },
    });
    const seated = [1, 2].map(() => disciple({ talent: 'spiritGathering', assignment: 'energyGathering', realmOrder: 5 }));
    const waiting = disciple({ talent: 'spiritGathering', realmOrder: 1 });
    const plan = planDispatch(input([awaySeat, ...seated, waiting]));
    expect(plan.moves).toEqual([]);
    expect(plan.issues.find((item) => item.key === 'crowded')?.disciples.map((item) => item.id)).toEqual([waiting.id]);
  });

  it('执行顺序：不限人数的岗位在前，采灵 / 吐纳在后，同岗位合并', () => {
    const squatter = disciple({ talent: 'cultivation', assignment: 'stoneMining' });
    const spirit = disciple({ talent: 'spiritGathering', assignment: 'idle' });
    const idle = disciple({ assignment: 'idle' });
    const plan = planDispatch(input([squatter, spirit, idle]));
    expect(moveBatches(plan.moves, ASSIGNMENTS)).toEqual([
      { assignment: 'cultivating', discipleIds: [squatter.id, idle.id] },
      { assignment: 'stoneMining', discipleIds: [spirit.id] },
    ]);
  });
});

describe('执事推荐', () => {
  it('空缺时推荐境界最高、不在守擂阵容里的人选', () => {
    const low = disciple({ talent: 'alchemy', realmOrder: 1 });
    const high = disciple({ talent: 'alchemy', realmOrder: 4 });
    const guard = disciple({ talent: 'alchemy', realmOrder: 6 });
    const plan = planDispatch(input([low, high, guard], { offices: [office({})], defenseLineup: [guard.id] }));
    expect(plan.appointments.map((item) => item.discipleId)).toEqual([high.id]);
  });

  it('现任已是同境界不换；有更高境界才推荐替换', () => {
    const current = disciple({ talent: 'alchemy', realmOrder: 2, stage: 1 });
    const sameRealm = disciple({ talent: 'alchemy', realmOrder: 2, stage: 3 });
    expect(planDispatch(input([current, sameRealm], { offices: [office({ discipleId: current.id })] })).appointments).toEqual([]);

    const higher = disciple({ talent: 'alchemy', realmOrder: 3 });
    const plan = planDispatch(input([current, higher], { offices: [office({ discipleId: current.id })] }));
    expect(plan.appointments[0]).toMatchObject({ discipleId: higher.id, replacingName: current.name });
  });

  it('今天已任命过：不进推荐，只提示明日再换', () => {
    const candidate = disciple({ talent: 'alchemy' });
    const plan = planDispatch(input([candidate], { offices: [office({ canAppointToday: false })] }));
    expect(plan.appointments).toEqual([]);
    expect(plan.issues.find((item) => item.key === 'steward-tomorrow:alchemy')?.detail).toContain('明日');
  });
});

describe('人才缺口', () => {
  const TALENTS = [
    { id: 'herbGathering', name: '灵植', category: 'production', categoryName: '产出', condition: '在药园岗位时', effect: '药材产出 +20%' },
    { id: 'spiritGathering', name: '聚灵', category: 'production', categoryName: '产出', condition: '在采灵 / 吐纳岗位时', effect: '灵石 / 灵气产出 +20%' },
    { id: 'combat', name: '战意', category: 'combat', categoryName: '战斗', condition: '讨伐', effect: '战力 +10%' },
    { id: 'critical', name: '会心', category: 'combat', categoryName: '战斗', condition: '讨伐暴击时', effect: '伤害 +60%' },
    { id: 'alchemy', name: '丹道', category: 'steward', categoryName: '宗门', condition: '任丹房执事时', effect: '炼丹消耗 −8%' },
    { id: 'pillAffinity', name: '丹心', category: 'cultivation', categoryName: '修行', condition: '服用聚气丹时', effect: '修为 +20%' },
    { id: 'cultivation', name: '悟道', category: 'cultivation', categoryName: '修行', condition: '在修炼岗位时', effect: '修炼速度 +16%' },
  ];
  const row = (overrides: Partial<TalentNeedDisciple>): TalentNeedDisciple => ({
    id: `n${(seq += 1)}`,
    name: `门人${seq}`,
    talent: 'none',
    assignment: 'cultivating',
    realmOrder: 0,
    realmName: '炼气',
    ...overrides,
  });

  it('执事天赋 0 人急缺；聚灵按采灵 + 吐纳名额算缺口；药园缺口扣掉可调来的灵植', () => {
    const rows = talentNeeds({
      talents: TALENTS,
      assignments: ASSIGNMENTS,
      disciples: [
        row({ assignment: 'herbGathering' }),
        row({ assignment: 'herbGathering' }),
        row({ talent: 'herbGathering', assignment: 'oreGathering' }),
        row({ talent: 'spiritGathering', assignment: 'stoneMining' }),
        row({ talent: 'combat' }),
      ],
    });
    const byId = Object.fromEntries(rows.map((item) => [item.talentId, item]));
    expect(byId.alchemy).toMatchObject({ level: 'urgent', gap: 1 });
    expect(byId.spiritGathering).toMatchObject({ level: 'short', gap: 2 });
    expect(byId.herbGathering).toMatchObject({ level: 'short', gap: 1 });
    expect(byId.combat).toMatchObject({ level: 'short', gap: 2 });
    expect(byId.pillAffinity).toMatchObject({ level: 'info', gap: null });
    expect(byId.cultivation).toMatchObject({ level: 'info', gap: null });
    expect(rows[0]!.talentId).toBe('alchemy');

    const top = topTalentNeeds(rows, 10);
    expect(top.filter((item) => item.key === 'combat')).toHaveLength(1);
    expect(top.some((item) => item.key === 'critical')).toBe(false);
  });
});

describe('岗位概览', () => {
  const TALENT_NAMES = [
    { id: 'herbGathering', name: '灵植' },
    { id: 'cultivation', name: '悟道' },
    { id: 'alchemy', name: '丹道' },
  ];
  const person = (overrides: Partial<PostInsightDisciple>): PostInsightDisciple => ({
    id: `p${(seq += 1)}`,
    name: `门人${seq}`,
    talent: 'none',
    talentName: '无',
    talentEffect: '',
    assignment: 'cultivating',
    realmOrder: 2,
    realmName: '金丹',
    stage: 1,
    aptitude: 60,
    ...overrides,
  });

  it('药园：在岗最高取对口天赋、列出不在岗的备选、境界偏低的提示补境界', () => {
    const top = person({ talent: 'herbGathering', talentName: '灵植', talentEffect: '药材产出 +30%', assignment: 'herbGathering', realmOrder: 2 });
    const low = person({ talent: 'herbGathering', talentName: '灵植', assignment: 'herbGathering', realmOrder: 0, realmName: '炼气' });
    const backup = person({ talent: 'herbGathering', talentName: '灵植', assignment: 'oreGathering' });
    const others = [1, 2].map(() => person({ realmOrder: 3 }));
    const cards = postInsights({ disciples: [top, low, backup, ...others], assignments: ASSIGNMENTS, offices: [], talents: TALENT_NAMES });
    const herb = cards.find((card) => card.key === 'post:herbGathering')!;
    expect(herb.summary).toBe('在岗 2 人，其中灵植 2 人');
    expect(herb.lines[0]!.people[0]).toMatchObject({ id: top.id, note: '金丹·药材产出 +30%' });
    expect(herb.lines[1]!.people.map((item) => item.id)).toEqual([backup.id]);
    expect(herb.tips[0]!.people.map((item) => item.id)).toEqual([low.id]);
  });

  it('修炼：资质高却在产出岗位的建议去修炼，资质低在修炼的建议去产出；有岗位天赋的不参与', () => {
    const fast = person({ aptitude: 95, assignment: 'oreGathering' });
    const slow = person({ aptitude: 20 });
    const herbTalent = person({ talent: 'herbGathering', talentName: '灵植', aptitude: 99, assignment: 'oreGathering' });
    const mids = [50, 55, 60, 65].map((aptitude) => person({ aptitude }));
    const cards = postInsights({ disciples: [fast, slow, herbTalent, ...mids], assignments: ASSIGNMENTS, offices: [], talents: TALENT_NAMES });
    const tips = cards.find((card) => card.key === 'post:cultivating')!.tips;
    expect(tips.map((tip) => tip.people.map((item) => item.id))).toEqual([[fast.id], [slow.id]]);
  });

  it('执事：现任不在修炼时提示改去修炼，备选里有更高境界时提示可换', () => {
    const current = person({ talent: 'alchemy', talentName: '丹道', assignment: 'oreGathering', realmOrder: 1 });
    const better = person({ talent: 'alchemy', talentName: '丹道', realmOrder: 3 });
    const cards = postInsights({
      disciples: [current, better],
      assignments: ASSIGNMENTS,
      offices: [{ ...office({ discipleId: current.id }), effect: '全宗炼丹消耗 −10%' }],
      talents: TALENT_NAMES,
    });
    const card = cards.find((item) => item.key === 'office:alchemy')!;
    expect(card.summary).toBe(`现任 ${current.name}`);
    expect(card.lines[1]!.people.map((item) => item.id)).toEqual([better.id]);
    expect(card.tips).toHaveLength(2);
  });
});
