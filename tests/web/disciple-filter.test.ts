import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DISCIPLE_FILTER,
  cultivationProgress,
  discipleStatus,
  filterDisciples,
  isFilterActive,
  isInjured,
  matchesSearch,
  realmOptions,
  type DiscipleFilter,
  type FilterableDisciple,
} from '../../apps/web/src/utils/discipleFilter';

/**
 * 弟子名册的筛选 / 排序 / 状态派生（apps/web/src/utils/discipleFilter.ts）。
 *
 * 全部用构造的纯数据，不连后端：这些规则必须是纯函数，才能被根级 node 测试直接跑。
 * 疗伤判定统一用固定的 serverNow，不依赖本机时钟，也不写时间敏感断言。
 */
const SERVER_NOW = Date.parse('2026-01-01T12:00:00.000Z');
const IN_ONE_HOUR = '2026-01-01T13:00:00.000Z';
const ONE_HOUR_AGO = '2026-01-01T11:00:00.000Z';

function makeDisciple(overrides: Partial<FilterableDisciple> & { id: string }): FilterableDisciple {
  return {
    name: '无名氏',
    note: '',
    realmId: 'qiRefining',
    realmName: '炼气',
    realmOrder: 0,
    stage: 1,
    assignment: 'idle',
    assignmentName: '闲置',
    cultivation: 0,
    requiredCultivation: 100,
    combatPower: 10,
    injuredUntil: null,
    canBreakthrough: false,
    ...overrides,
  };
}

function withFilter(overrides: Partial<DiscipleFilter>): DiscipleFilter {
  return { ...DEFAULT_DISCIPLE_FILTER, ...overrides };
}

function ids(disciples: readonly FilterableDisciple[]): string[] {
  return disciples.map((disciple) => disciple.id);
}

describe('搜索（姓名 / 私有备注）', () => {
  const scholar = makeDisciple({ id: 'a', name: 'Li Bai', note: '专修 剑道' });
  const nameless = makeDisciple({ id: 'b', name: '张三', note: '' });

  it('trim 后包含匹配姓名，不区分大小写', () => {
    expect(matchesSearch(scholar, '  li bai  ')).toBe(true);
    expect(matchesSearch(scholar, 'LI')).toBe(true);
    expect(matchesSearch(scholar, 'bai')).toBe(true);
  });

  it('包含匹配备注', () => {
    expect(matchesSearch(scholar, '剑')).toBe(true);
    expect(matchesSearch(scholar, ' 剑道 ')).toBe(true);
  });

  it('空查询不过滤，空备注不匹配任何非空查询', () => {
    expect(matchesSearch(nameless, '')).toBe(true);
    expect(matchesSearch(nameless, '   ')).toBe(true);
    expect(matchesSearch(nameless, '剑')).toBe(false);
    expect(matchesSearch(nameless, 'zhang')).toBe(false);
  });
});

describe('状态派生优先级', () => {
  it('疗伤中优先于可破境', () => {
    const injured = makeDisciple({
      id: 'a',
      injuredUntil: IN_ONE_HOUR,
      canBreakthrough: true,
      cultivation: 100,
      assignmentName: '采药',
    });
    expect(discipleStatus(injured, SERVER_NOW)).toEqual({ key: 'injured', label: '疗伤中' });
  });

  it('疗伤结束（injuredUntil <= serverNow）不再算疗伤', () => {
    const healed = makeDisciple({ id: 'a', injuredUntil: ONE_HOUR_AGO });
    expect(isInjured(healed, SERVER_NOW)).toBe(false);
    expect(discipleStatus(healed, SERVER_NOW).key).toBe('assignment');
  });

  it('可破境只看 canBreakthrough，优先于版本上限与岗位', () => {
    const ready = makeDisciple({
      id: 'a',
      canBreakthrough: true,
      requiredCultivation: null,
      assignmentName: '采灵',
    });
    expect(discipleStatus(ready, SERVER_NOW)).toEqual({ key: 'canBreakthrough', label: '可破境' });
  });

  it('修为满但 requiredCultivation === null 时是「已达当前版本上限」，不是可破境', () => {
    const capped = makeDisciple({ id: 'a', requiredCultivation: null, cultivation: 9999 });
    expect(discipleStatus(capped, SERVER_NOW)).toEqual({
      key: 'capped',
      label: '已达当前版本上限',
    });
    const progress = cultivationProgress(capped.cultivation, capped.requiredCultivation);
    expect(progress).toEqual({
      percent: 100,
      text: '已达当前版本上限',
      capped: true,
      full: false,
    });
  });

  it('修为到门槛但服务端没给 canBreakthrough 时是「修为已满」', () => {
    const full = makeDisciple({ id: 'a', cultivation: 100, requiredCultivation: 100 });
    expect(discipleStatus(full, SERVER_NOW)).toEqual({ key: 'cultivationFull', label: '修为已满' });
  });

  it('都没有时回落到当前岗位名（含闲置）', () => {
    const idle = makeDisciple({ id: 'a' });
    expect(discipleStatus(idle, SERVER_NOW)).toEqual({ key: 'assignment', label: '闲置' });
    const working = makeDisciple({ id: 'b', assignment: 'herbGathering', assignmentName: '采药' });
    expect(discipleStatus(working, SERVER_NOW)).toEqual({ key: 'assignment', label: '采药' });
  });

  it('进度百分比 clamp 到 0~100，数字保持可读', () => {
    expect(cultivationProgress(90, 180)).toEqual({
      percent: 50,
      text: '90/180',
      capped: false,
      full: false,
    });
    expect(cultivationProgress(999, 100).percent).toBe(100);
    expect(cultivationProgress(-5, 100).percent).toBe(0);
  });
});

describe('组合筛选（境界 / 岗位 / 状态 / 搜索）', () => {
  const roster = [
    makeDisciple({
      id: 'a',
      name: '赵一',
      note: '剑修',
      realmId: 'qiRefining',
      realmName: '炼气',
      realmOrder: 0,
      stage: 2,
      assignment: 'idle',
      assignmentName: '闲置',
    }),
    makeDisciple({
      id: 'b',
      name: '钱二',
      realmId: 'qiRefining',
      realmName: '炼气',
      realmOrder: 0,
      stage: 1,
      assignment: 'herbGathering',
      assignmentName: '采药',
      cultivation: 100,
      requiredCultivation: 100,
      combatPower: 30,
    }),
    makeDisciple({
      id: 'c',
      name: '孙三',
      realmId: 'foundationEstablishment',
      realmName: '筑基',
      realmOrder: 1,
      stage: 1,
      assignment: 'herbGathering',
      assignmentName: '采药',
      injuredUntil: IN_ONE_HOUR,
      canBreakthrough: true,
      // 真实服务端里 canBreakthrough 必然代表修为已到门槛 → 这里刻意给满修为，
      // 用来锁死「修为已满」筛选必须排除可破境者（否则筛选结果与行内标签互相矛盾）。
      cultivation: 300,
      requiredCultivation: 300,
      combatPower: 90,
    }),
    makeDisciple({
      id: 'd',
      name: '李四',
      realmId: 'goldenCore',
      realmName: '金丹',
      realmOrder: 2,
      stage: 1,
      assignment: 'idle',
      assignmentName: '闲置',
      requiredCultivation: null,
      cultivation: 5000,
      combatPower: 50,
    }),
  ];

  it('境界 + 岗位 + 状态 + 搜索可以同时生效', () => {
    const result = filterDisciples(
      roster,
      withFilter({
        search: '钱',
        realmId: 'qiRefining',
        assignment: 'herbGathering',
        status: 'cultivationFull',
      }),
      SERVER_NOW,
    );
    expect(ids(result)).toEqual(['b']);

    // 换成疗伤状态，同一条搜索就没有结果了（组合条件不是「或」）。
    const injuredOnly = filterDisciples(
      roster,
      withFilter({ search: '钱', realmId: 'qiRefining', assignment: 'herbGathering', status: 'injured' }),
      SERVER_NOW,
    );
    expect(injuredOnly).toEqual([]);
  });

  it('状态筛选各自的口径：可破境 / 疗伤 / 修为已满（含版本上限、排除可破境）/ 闲置', () => {
    expect(ids(filterDisciples(roster, withFilter({ status: 'canBreakthrough' }), SERVER_NOW))).toEqual(
      ['c'],
    );
    expect(ids(filterDisciples(roster, withFilter({ status: 'injured' }), SERVER_NOW))).toEqual(['c']);
    expect(ids(filterDisciples(roster, withFilter({ status: 'cultivationFull' }), SERVER_NOW))).toEqual([
      'b',
      'd',
    ]);
    expect(ids(filterDisciples(roster, withFilter({ status: 'idle' }), SERVER_NOW))).toEqual(['a', 'd']);
  });

  it('岗位筛选按岗位 id，境界筛选按境界 id', () => {
    expect(ids(filterDisciples(roster, withFilter({ assignment: 'herbGathering' }), SERVER_NOW))).toEqual(
      ['b', 'c'],
    );
    expect(ids(filterDisciples(roster, withFilter({ realmId: 'goldenCore' }), SERVER_NOW))).toEqual(['d']);
  });

  it('筛选条件互斥时返回空数组（无结果态）', () => {
    const empty = filterDisciples(
      roster,
      withFilter({ realmId: 'qiRefining', assignment: 'notExist' }),
      SERVER_NOW,
    );
    expect(empty).toEqual([]);
    expect(empty.length).toBe(0);
  });

  it('不修改入参，返回新数组', () => {
    const before = ids(roster);
    const result = filterDisciples(roster, withFilter({ sort: 'combatPower' }), SERVER_NOW);
    expect(ids(roster)).toEqual(before);
    expect(result).not.toBe(roster);
  });
});

describe('排序', () => {
  const roster = [
    makeDisciple({ id: 'a', realmOrder: 0, stage: 2, combatPower: 30 }),
    makeDisciple({ id: 'b', realmOrder: 1, stage: 3, combatPower: 30 }),
    makeDisciple({ id: 'c', realmOrder: 1, stage: 1, combatPower: 90 }),
    makeDisciple({ id: 'd', realmOrder: 2, stage: 1, combatPower: 10 }),
  ];

  it('默认（招募顺序）保持 state.disciples 的原顺序', () => {
    expect(ids(filterDisciples(roster, withFilter({}), SERVER_NOW))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('战力高低：从高到低，相同战力保持原顺序', () => {
    expect(ids(filterDisciples(roster, withFilter({ sort: 'combatPower' }), SERVER_NOW))).toEqual([
      'c',
      'a',
      'b',
      'd',
    ]);
  });

  it('境界高低：先比 realmOrder 再比 stage，都相同保持原顺序', () => {
    expect(ids(filterDisciples(roster, withFilter({ sort: 'realm' }), SERVER_NOW))).toEqual([
      'd',
      'b',
      'c',
      'a',
    ]);

    const sameRealm = [
      makeDisciple({ id: 'x', realmId: 'foundationEstablishment', realmOrder: 1, stage: 1 }),
      makeDisciple({ id: 'y', realmId: 'foundationEstablishment', realmOrder: 1, stage: 1 }),
    ];
    expect(ids(filterDisciples(sameRealm, withFilter({ sort: 'realm' }), SERVER_NOW))).toEqual([
      'x',
      'y',
    ]);
  });

  it('境界排序按 realmOrder，不按境界名字符串', () => {
    // 名字字符串排序会把「筑基」排在「炼气」前面，realmOrder 才是服务端顺序。
    const named = [
      makeDisciple({ id: 'qi', realmId: 'qiRefining', realmName: '炼气', realmOrder: 0, stage: 9 }),
      makeDisciple({ id: 'foundation', realmId: 'foundationEstablishment', realmName: '筑基', realmOrder: 1, stage: 1 }),
    ];
    expect(ids(filterDisciples(named, withFilter({ sort: 'realm' }), SERVER_NOW))).toEqual([
      'foundation',
      'qi',
    ]);
  });
});

describe('境界筛选项与重置态', () => {
  it('从当前弟子去重派生并按 realmOrder 升序', () => {
    const roster = [
      makeDisciple({ id: 'a', realmId: 'goldenCore', realmName: '金丹', realmOrder: 2 }),
      makeDisciple({ id: 'b', realmId: 'qiRefining', realmName: '炼气', realmOrder: 0 }),
      makeDisciple({ id: 'c', realmId: 'qiRefining', realmName: '炼气', realmOrder: 0 }),
    ];
    expect(realmOptions(roster)).toEqual([
      { realmId: 'qiRefining', realmName: '炼气', realmOrder: 0 },
      { realmId: 'goldenCore', realmName: '金丹', realmOrder: 2 },
    ]);
  });

  it('默认筛选不算「已筛选」，任一项改动都算', () => {
    expect(isFilterActive(DEFAULT_DISCIPLE_FILTER)).toBe(false);
    expect(isFilterActive(withFilter({ search: '  ' }))).toBe(false);
    expect(isFilterActive(withFilter({ search: '剑' }))).toBe(true);
    expect(isFilterActive(withFilter({ realmId: 'qiRefining' }))).toBe(true);
    expect(isFilterActive(withFilter({ assignment: 'idle' }))).toBe(true);
    expect(isFilterActive(withFilter({ status: 'injured' }))).toBe(true);
    expect(isFilterActive(withFilter({ sort: 'realm' }))).toBe(true);
  });
});
