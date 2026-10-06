import { describe, expect, it } from 'vitest';

import {
  isTalentMisplaced,
  moveBatches,
  planDispatch,
  type DispatchDisciple,
  type DispatchInput,
  type DispatchOffice,
} from '../../apps/web/src/utils/discipleDispatch';

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

  it('聚灵按境界高低占采灵 / 吐纳名额；被错位弟子占着的名额先腾出来', () => {
    const squatter = disciple({ talent: 'cultivation', assignment: 'stoneMining' });
    const low = disciple({ talent: 'spiritGathering', assignment: 'idle', realmOrder: 0 });
    const high = disciple({ talent: 'spiritGathering', assignment: 'cultivating', realmOrder: 3 });
    const filler = [1, 2].map(() => disciple({ assignment: 'energyGathering' }));
    const plan = planDispatch(input([squatter, low, high, ...filler]));
    expect(plan.moves.map((item) => [item.discipleId, item.to])).toEqual([
      [squatter.id, 'cultivating'],
      [high.id, 'stoneMining'],
      // 没抢到名额、原本闲置的聚灵弟子：先去修炼，总比闲着强（仍提示没有位置）。
      [low.id, 'cultivating'],
    ]);
    expect(plan.issues.find((item) => item.key === 'crowded')?.disciples.map((item) => item.id)).toEqual([low.id]);
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
