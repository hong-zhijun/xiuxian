import { describe, expect, it } from 'vitest';

import { REALMS, breakthroughEnergyCost } from '../../apps/server/src/modules/game/constants';
import {
  EQUIPMENT_QUALITIES,
  FORGE_RECIPES,
  forgeOddsOf,
  gearBonusOf,
  gearPowerBonusBpOf,
  qualityNameOf,
  qualityPowerBonusBp,
  refineCostUnits,
  refineMainGain,
  refinePowerBonusBp,
  refineSubGain,
  type EquipmentAttr,
  type EquipmentQuality,
} from '../../apps/server/src/modules/game/equipment';
import { discipleCombatPower } from '../../apps/server/src/modules/game/realms';
import { talentCatalog } from '../../apps/server/src/modules/game/talents';
import {
  defaultCustomSlot,
  defaultPlan,
  formatCostText,
  formatGainRatio,
  midSubValue,
  qualityChoices,
  simulate,
  subAttrChoices,
  targetOptions,
  validatePlan,
  wornItemOf,
  type SimDisciple,
  type SimEquipment,
  type SimEquipmentItem,
  type SimInput,
  type SimPlan,
  type SimRealm,
  type SimResource,
  type SlotId,
  type SlotPlan,
} from '../../apps/web/src/utils/upgradeSimulator';

/**
 * 提升模拟器（apps/web/src/utils/upgradeSimulator.ts）：默认方案的战力必须等于服务端 discipleCombatPower；
 * 升境界的修为 / 灵气 / 时间代价；自定义装备与保持当前调祭炼的增量与代价；悟道值与校验文案；
 * 单项拆解（排序、提升最大、全部一起）；装备视图为 null 时装备格不参与。
 *
 * 造数据方式照 advisor.test.ts，但境界表、天赋表、祭炼说明、炼器价目都直接取服务端的算好结果，
 * 期望值用服务端的 discipleCombatPower / refine 函数现算，不手抄数字（只在关键用例里手算一遍做对照）。
 */

/* ---------- 数据：与服务端 view.ts 的 realmCatalog / talentCatalog / refineGuideView 同一口径 ---------- */

const REALM_CATALOG: SimRealm[] = REALMS.map((realm) => ({
  id: realm.id,
  name: realm.name,
  stages: realm.stages.map((stage) => ({
    stage: stage.stage,
    name: stage.name,
    requiredCultivation: stage.requiredCultivation,
    breakthroughCost:
      stage.requiredCultivation === null ? null : String(breakthroughEnergyCost(realm.id, stage.stage)),
  })),
}));

const TALENTS = talentCatalog();

const REFINE_MAX_LEVEL = 12;

/**
 * 祭炼说明表：与服务端 view.ts 的 refineGuideView 同一口径（品质字段 + 逐重的增量与消耗；模拟不用成功率）。
 * view.ts 不在这里 import：它会把服务端仓储一起拉进根级的类型检查（D1 全局类型只在 apps/server 里）；
 * 视图本身由 apps/server/test/equipment-refine.test.ts 验证。
 */
function refineGuideOf(): SimEquipment['refineGuide'] {
  return {
    qualities: EQUIPMENT_QUALITIES.map((quality) => ({
      id: quality.id,
      name: quality.name,
      mainValue: quality.mainValue,
      subMin: quality.subMin,
      subMax: quality.subMax,
      powerBonusBp: quality.powerBonusBp,
      rows: Array.from({ length: REFINE_MAX_LEVEL }, (_, index) => {
        const level = index + 1;
        return {
          level,
          cost: Object.fromEntries(
            Object.entries(refineCostUnits(quality.id, level)).map(([resourceId, units]) => [resourceId, String(units)]),
          ),
          mainGain: refineMainGain(quality.id, level),
          subGain: refineSubGain(quality.id, level),
          powerBonusGainBp: refinePowerBonusBp(level) - refinePowerBonusBp(level - 1),
        };
      }),
    })),
  };
}

const REFINE_GUIDE = refineGuideOf();

const RESOURCES: SimResource[] = [
  { id: 'spiritStone', name: '灵石' },
  { id: 'spiritualEnergy', name: '灵气' },
  { id: 'ore', name: '矿石' },
  { id: 'xuantie', name: '玄铁' },
  { id: 'herb', name: '药材' },
];

const SLOT_VIEW = [
  { id: 'weapon', name: '兵器' },
  { id: 'armor', name: '护甲' },
  { id: 'artifact', name: '法器' },
];

/** 炼器坊等级：4 级时四个品质全部可炼。 */
const WORKSHOP_LEVEL = 4;

function forgeOptionsOf(workshopLevel: number): SimEquipment['forgeOptions'] {
  return FORGE_RECIPES.map((recipe) => ({
    quality: recipe.quality,
    name: qualityNameOf(recipe.quality),
    unlocked: workshopLevel >= recipe.workshopLevel,
    cost: recipe.cost,
    odds: { success: forgeOddsOf(recipe.quality, Math.max(workshopLevel, recipe.workshopLevel)).success },
  }));
}

function equipmentOf(
  items: SimEquipmentItem[],
  options: { workshopLevel?: number; unlocked?: boolean } = {},
): SimEquipment {
  return {
    unlocked: options.unlocked ?? true,
    slots: SLOT_VIEW,
    items,
    forgeOptions: forgeOptionsOf(options.workshopLevel ?? WORKSHOP_LEVEL),
    refineGuide: REFINE_GUIDE,
  };
}

interface ItemSpec {
  discipleId: string | null;
  slot: SlotId;
  quality: EquipmentQuality;
  mainAttr: EquipmentAttr;
  subAttr: EquipmentAttr;
  /** 副属性在祭炼前的数值（该品质区间内）。 */
  subValue: number;
  refineLevel: number;
}

/** 按服务端口径造一件装备视图：主属性 / 副属性 / 战力加成都含祭炼累计（同 view.ts 的 equipmentItemViewOf）。 */
function itemOf(spec: ItemSpec): SimEquipmentItem {
  const def = EQUIPMENT_QUALITIES.find((quality) => quality.id === spec.quality)!;
  let mainValue = def.mainValue;
  let subValue = spec.subValue;
  for (let level = 1; level <= spec.refineLevel; level += 1) {
    mainValue += refineMainGain(spec.quality, level);
    subValue += refineSubGain(spec.quality, level);
  }
  return {
    id: `${spec.discipleId ?? 'bag'}-${spec.slot}-${spec.quality}-${String(spec.refineLevel)}`,
    slot: spec.slot,
    quality: spec.quality,
    name: `${def.name}·${spec.slot}`,
    mainAttr: spec.mainAttr,
    mainValue,
    subAttr: spec.subAttr,
    subValue,
    powerBonusBp: qualityPowerBonusBp(spec.quality) + refinePowerBonusBp(spec.refineLevel),
    refineLevel: spec.refineLevel,
    discipleId: spec.discipleId,
  };
}

const BASE_DISCIPLE: SimDisciple = {
  id: 'd1',
  realmId: 'goldenCore',
  stage: 1,
  talent: 'none',
  attack: 40,
  defense: 30,
  speed: 25,
  luck: 20,
  physique: 15,
  gear: { attack: 0, defense: 0, speed: 0, luck: 0, physique: 0 },
  gearPowerBonusBp: 0,
  cultivationRatePerHour: 12,
  daoInsight: 0,
  daoInsightRemaining: 50,
};

/** 弟子：装备加成按服务端 gearBonusOf / gearPowerBonusBpOf 的口径，只算穿在他身上的件。 */
function discipleOf(overrides: Partial<SimDisciple>, items: readonly SimEquipmentItem[] = []): SimDisciple {
  const draft: SimDisciple = { ...BASE_DISCIPLE, ...overrides };
  const worn = items.filter((item) => item.discipleId === draft.id);
  return {
    ...draft,
    gear: gearBonusOf(
      worn.map((item) => ({
        main_attr: item.mainAttr,
        main_value: item.mainValue,
        sub_attr: item.subAttr,
        sub_value: item.subValue,
      })),
    ),
    gearPowerBonusBp: gearPowerBonusBpOf(worn.map((item) => ({ quality: item.quality, refine_level: item.refineLevel }))),
  };
}

function inputOf(disciple: SimDisciple, equipment: SimEquipment | null, cultivation = 0): SimInput {
  return { disciple, realmCatalog: REALM_CATALOG, talents: TALENTS, equipment, resources: RESOURCES, cultivation };
}

/** 服务端口径的战力（与 service.ts gearedCombatPower 同一组参数）。 */
function serverPower(disciple: SimDisciple, realmId = disciple.realmId, stage = disciple.stage): number {
  return discipleCombatPower(
    realmId,
    stage,
    disciple.attack + disciple.gear.attack,
    disciple.defense + disciple.gear.defense,
    disciple.speed + disciple.gear.speed,
    disciple.talent,
    disciple.gearPowerBonusBp,
  );
}

/** 方案：在缺省方案上改个别格 / 悟道值 / 目标。 */
function planOf(
  input: SimInput,
  slots: Partial<Record<SlotId, SlotPlan>> = {},
  options: { target?: { realmId: string; stage: number }; insight?: { attack?: number; defense?: number; speed?: number } } = {},
): SimPlan {
  const base = defaultPlan(input);
  return {
    target: options.target ?? base.target,
    slots: { ...base.slots, ...slots },
    insight: { ...base.insight, ...options.insight },
  };
}

/** 祭炼从第 from+1 重冲到第 to 重的消耗（服务端 refineCostUnits 逐重相加）。 */
function refineCostOf(quality: EquipmentQuality, from: number, to: number): Record<string, number> {
  const total: Record<string, number> = {};
  for (let level = from + 1; level <= to; level += 1) {
    for (const [id, amount] of Object.entries(refineCostUnits(quality, level))) {
      total[id] = (total[id] ?? 0) + amount;
    }
  }
  return total;
}

/** 炼器价目（服务端 FORGE_RECIPES，最小单位）。 */
function forgeCostOf(quality: EquipmentQuality): Record<string, number> {
  const recipe = FORGE_RECIPES.find((item) => item.quality === quality)!;
  return Object.fromEntries(Object.entries(recipe.cost).map(([id, amount]) => [id, Number(amount)]));
}

function sumCosts(...parts: Record<string, number>[]): Record<string, number> {
  const total: Record<string, number> = {};
  for (const part of parts) {
    for (const [id, amount] of Object.entries(part)) {
      total[id] = (total[id] ?? 0) + amount;
    }
  }
  return total;
}

/* ---------- 默认方案 = 服务端战力（验收硬条件） ---------- */

describe('默认方案的战力等于服务端 discipleCombatPower', () => {
  it('无装备：9 个境界 × 3 层，默认选项下当前与模拟战力都与服务端一致；拆解为空', () => {
    for (const realm of REALMS) {
      for (const stage of [1, 2, 3]) {
        const disciple = discipleOf({ realmId: realm.id, stage, attack: 37 + stage, defense: 21, speed: 58 });
        const input = inputOf(disciple, equipmentOf([]));
        const result = simulate(input, defaultPlan(input));
        expect(result.current.combatPower).toBe(serverPower(disciple));
        expect(result.simulated.combatPower).toBe(serverPower(disciple));
        expect(result.breakdown).toEqual([]);
        expect(result.total.gainRatio).toBe(0);
      }
    }
  });

  it('三件装备（含祭炼）加背包里一件未穿的：默认选项下战力与服务端一致', () => {
    const items = [
      itemOf({ discipleId: 'd1', slot: 'weapon', quality: 'common', mainAttr: 'attack', subAttr: 'luck', subValue: 3, refineLevel: 3 }),
      itemOf({ discipleId: 'd1', slot: 'armor', quality: 'spirit', mainAttr: 'defense', subAttr: 'speed', subValue: 6, refineLevel: 9 }),
      itemOf({ discipleId: 'd1', slot: 'artifact', quality: 'treasure', mainAttr: 'luck', subAttr: 'physique', subValue: 8, refineLevel: 12 }),
      itemOf({ discipleId: null, slot: 'artifact', quality: 'immortal', mainAttr: 'speed', subAttr: 'attack', subValue: 12, refineLevel: 0 }),
    ];
    for (const realmId of ['qiRefining', 'goldenCore', 'tribulation']) {
      const disciple = discipleOf({ realmId, stage: 2, attack: 44, defense: 33, speed: 51 }, items);
      // 凡品 3 重 200 + 灵品 9 重 400+100 + 宝品 12 重 700+600；背包里那件不计。
      expect(disciple.gearPowerBonusBp).toBe(200 + 500 + 1300);
      const input = inputOf(disciple, equipmentOf(items));
      const result = simulate(input, defaultPlan(input));
      expect(result.current.combatPower).toBe(serverPower(disciple));
      expect(result.simulated.combatPower).toBe(serverPower(disciple));
      expect(result.breakdown).toEqual([]);
    }
  });

  it('战意天赋：默认选项下按当前境界的战意加成算，与服务端一致（筑基 / 金丹 / 化神 / 渡劫）', () => {
    const items = [
      itemOf({ discipleId: 'd1', slot: 'weapon', quality: 'spirit', mainAttr: 'attack', subAttr: 'defense', subValue: 5, refineLevel: 5 }),
    ];
    for (const [realmId, stage] of [
      ['foundationEstablishment', 3],
      ['goldenCore', 1],
      ['spiritTransformation', 2],
      ['tribulation', 3],
    ] as const) {
      const disciple = discipleOf({ realmId, stage, talent: 'combat' }, items);
      const input = inputOf(disciple, equipmentOf(items));
      const result = simulate(input, defaultPlan(input));
      expect(result.current.combatPower).toBe(serverPower(disciple));
      expect(result.simulated.combatPower).toBe(serverPower(disciple));
    }
  });
});

/* ---------- 升境界：修为 / 灵气 / 时间 ---------- */

describe('升境界的代价', () => {
  it('跨境界：修为 = 当前层还差的 + 中间每层的门槛（目标层自己的不算）；灵气 = 每次突破的消耗之和', () => {
    const disciple = discipleOf({ realmId: 'qiRefining', stage: 1, cultivationRatePerHour: 10 });
    const input = inputOf(disciple, equipmentOf([]), 10);
    const plan = planOf(input, {}, { target: { realmId: 'foundationEstablishment', stage: 1 } });
    const result = simulate(input, plan);

    // 炼气一层门槛 30（已有 10）+ 炼气二层 90 + 炼气三层 180 = 290；突破灵气 20 + 40 + 60 = 120 展示单位。
    const realm = result.breakdown.find((row) => row.id === 'realm')!;
    expect(realm.cost).toEqual({ spiritualEnergy: 120_000 });
    expect(realm.notes).toEqual(['修为还差 290，约 29 小时（按当前修炼速度，不含突破失败）']);
    expect(result.simulated.realmName).toBe('筑基');
    expect(result.simulated.stageName).toBe('筑基初期');
    expect(realm.gainRatio).toBeCloseTo(serverPower(disciple, 'foundationEstablishment', 1) / serverPower(disciple) - 1, 10);
    expect(result.total.cost).toEqual({ spiritualEnergy: 120_000 });
  });

  it('同境界跨层：只算到目标层前一层的门槛与灵气', () => {
    const disciple = discipleOf({ realmId: 'qiRefining', stage: 1, cultivationRatePerHour: 10 });
    const input = inputOf(disciple, equipmentOf([]), 0);
    const result = simulate(input, planOf(input, {}, { target: { realmId: 'qiRefining', stage: 3 } }));
    const realm = result.breakdown.find((row) => row.id === 'realm')!;
    // 0 修为：炼气一层 30 + 炼气二层 90 = 120；灵气 20000 + 40000 = 60000（最小单位）。
    expect(realm.cost).toEqual({ spiritualEnergy: 60_000 });
    expect(realm.notes[0]).toContain('修为还差 120');
    expect(result.simulated.stageName).toBe('炼气三层');
  });

  it('修为已够：只说明可以直接突破，代价只有灵气', () => {
    const disciple = discipleOf({ realmId: 'qiRefining', stage: 1 });
    const input = inputOf(disciple, equipmentOf([]), 100);
    const result = simulate(input, planOf(input, {}, { target: { realmId: 'qiRefining', stage: 2 } }));
    const realm = result.breakdown.find((row) => row.id === 'realm')!;
    expect(realm.notes).toEqual(['修为已够，可以直接突破']);
    expect(realm.cost).toEqual({ spiritualEnergy: 20_000 });
  });

  it('不在修炼岗位（修炼速度为 0）时说明没有速度，不硬算时间', () => {
    const disciple = discipleOf({ realmId: 'qiRefining', stage: 1, cultivationRatePerHour: 0 });
    const input = inputOf(disciple, equipmentOf([]), 0);
    const result = simulate(input, planOf(input, {}, { target: { realmId: 'qiRefining', stage: 2 } }));
    const realm = result.breakdown.find((row) => row.id === 'realm')!;
    expect(realm.notes[0]).toContain('没有修炼速度');
  });

  it('目标就是当前层：没有升境界这一项，代价为空', () => {
    const disciple = discipleOf({});
    const input = inputOf(disciple, equipmentOf([]));
    const result = simulate(input, defaultPlan(input));
    expect(result.breakdown.some((row) => row.id === 'realm')).toBe(false);
    expect(result.total.cost).toEqual({});
  });

  it('战意天赋：升境界后按目标境界的战意加成算战力', () => {
    const disciple = discipleOf({ realmId: 'foundationEstablishment', stage: 1, talent: 'combat' });
    const input = inputOf(disciple, equipmentOf([]), 0);
    const result = simulate(input, planOf(input, {}, { target: { realmId: 'goldenCore', stage: 1 } }));
    // 金丹战意 +15%：92 × 1.15 → 105；若误用筑基的 +12.5% 会得 103。
    expect(result.simulated.combatPower).toBe(105);
    expect(result.simulated.combatPower).toBe(serverPower(disciple, 'goldenCore', 1));
  });
});

/* ---------- 装备：自定义一件、保持当前调祭炼、空着 ---------- */

describe('装备格的增量与代价', () => {
  it('自定义一件：主 / 副属性与战力加成含祭炼累计，替换身上的旧件时扣掉旧件的贡献', () => {
    const items = [
      itemOf({ discipleId: 'd1', slot: 'weapon', quality: 'common', mainAttr: 'attack', subAttr: 'luck', subValue: 3, refineLevel: 0 }),
    ];
    const disciple = discipleOf({}, items);
    expect(disciple.gear).toEqual({ attack: 8, defense: 0, speed: 0, luck: 3, physique: 0 });
    const equipment = equipmentOf(items);
    const input = inputOf(disciple, equipment);
    const plan = planOf(input, {
      weapon: { mode: 'custom', quality: 'treasure', mainAttr: 'attack', subAttr: 'speed', subValue: 8, refineLevel: 9 },
    });
    const result = simulate(input, plan);

    // 宝品主属性 20 + 祭炼 1..9 重（2×5 + 3×4 = 22）= 42；副属性 8 + 祭炼 5 重的 3 = 11；战力加成 700 + 九重的 100 = 800。
    expect(result.simulated.attrs.attack.gear).toBe(42);
    expect(result.simulated.attrs.speed.gear).toBe(11);
    expect(result.simulated.attrs.luck.gear).toBe(0);
    expect(result.simulated.combatPower).toBe(
      discipleCombatPower('goldenCore', 1, 40 + 42, 30, 25 + 11, 'none', 800),
    );
    const row = result.breakdown.find((item) => item.id === 'weapon')!;
    expect(row.label).toBe('兵器：换成宝品装备');
    expect(row.cost).toEqual(sumCosts(forgeCostOf('treasure'), refineCostOf('treasure', 0, 9)));
    expect(row.notes[0]).toMatch(/^炼器成功率 \d+%$/);
  });

  it('空着：卸下后扣掉这一格的属性与战力加成，没有代价', () => {
    const items = [
      itemOf({ discipleId: 'd1', slot: 'armor', quality: 'spirit', mainAttr: 'defense', subAttr: 'speed', subValue: 6, refineLevel: 5 }),
    ];
    const disciple = discipleOf({}, items);
    const input = inputOf(disciple, equipmentOf(items));
    const result = simulate(input, planOf(input, { armor: { mode: 'empty' } }));
    // 灵品护甲祭炼 5 重：防御 16 + 第 1..5 重的 2×5 = 26；身法 6 + 第 5 重的 2 = 8。
    expect(result.current.attrs.defense.gear).toBe(26);
    expect(result.current.attrs.speed.gear).toBe(8);
    expect(result.simulated.attrs.defense.gear).toBe(0);
    expect(result.simulated.attrs.speed.gear).toBe(0);
    expect(result.simulated.combatPower).toBe(discipleCombatPower('goldenCore', 1, 40, 30, 25, 'none', 0));
    const row = result.breakdown.find((item) => item.id === 'armor')!;
    expect(row.label).toBe('护甲：卸下');
    expect(row.cost).toEqual({});
  });

  it('保持当前调高祭炼：只加第 c+1..r 重的增量与代价，不重复算前面的重', () => {
    const items = [
      itemOf({ discipleId: 'd1', slot: 'armor', quality: 'spirit', mainAttr: 'defense', subAttr: 'speed', subValue: 6, refineLevel: 4 }),
    ];
    const disciple = discipleOf({}, items);
    const input = inputOf(disciple, equipmentOf(items));
    const result = simulate(input, planOf(input, { armor: { mode: 'keep', refineLevel: 9 } }));

    // 灵品：主属性 第 5 重起 +2，6～12 重每重 +3；副属性 第 5 重 +2；战力加成 九重累计 100。
    expect(result.simulated.attrs.defense.gear - result.current.attrs.defense.gear).toBe(2 + 3 * 4);
    expect(result.simulated.attrs.speed.gear - result.current.attrs.speed.gear).toBe(2);
    const row = result.breakdown.find((item) => item.id === 'armor')!;
    expect(row.label).toBe('护甲：祭炼 4 → 9 重');
    expect(row.cost).toEqual(refineCostOf('spirit', 4, 9));
    expect(row.notes).toEqual(['祭炼增量：防御 +14 · 身法 +2 · 战力加成 +1%']);
    expect(result.simulated.combatPower).toBe(
      discipleCombatPower('goldenCore', 1, 40, 30 + 38, 25 + 8, 'none', 500),
    );
  });

  it('祭炼只能往上调：低于现在的重数会被夹回现在的重数（不产生改动）', () => {
    const items = [
      itemOf({ discipleId: 'd1', slot: 'weapon', quality: 'common', mainAttr: 'attack', subAttr: 'luck', subValue: 3, refineLevel: 6 }),
    ];
    const disciple = discipleOf({}, items);
    const input = inputOf(disciple, equipmentOf(items));
    const result = simulate(input, planOf(input, { weapon: { mode: 'keep', refineLevel: 2 } }));
    expect(result.breakdown).toEqual([]);
    expect(result.simulated.combatPower).toBe(result.current.combatPower);
    const issues = validatePlan(input, planOf(input, { weapon: { mode: 'keep', refineLevel: 2 } }));
    expect(issues.slots.weapon?.refine).toBe('不能比现在的 6 重低');
  });

  it('自定义副属性数值超出品质区间：校验给出文案，计算时夹到区间内', () => {
    const disciple = discipleOf({});
    const input = inputOf(disciple, equipmentOf([]));
    const plan = planOf(input, {
      weapon: { mode: 'custom', quality: 'common', mainAttr: 'attack', subAttr: 'speed', subValue: 9, refineLevel: 0 },
    });
    expect(validatePlan(input, plan).slots.weapon?.subValue).toBe('副属性数值需在 2 ~ 4 之间');
    const result = simulate(input, plan);
    // 凡品副属性最多 4。
    expect(result.simulated.attrs.speed.gear).toBe(4);
  });

  it('主属性与副属性相同：校验给出文案，计算时副属性换成另一项', () => {
    const disciple = discipleOf({});
    const input = inputOf(disciple, equipmentOf([]));
    const plan = planOf(input, {
      weapon: { mode: 'custom', quality: 'common', mainAttr: 'attack', subAttr: 'attack', subValue: 3, refineLevel: 0 },
    });
    expect(validatePlan(input, plan).slots.weapon?.sub).toBe('副属性不能和主属性相同');
    const result = simulate(input, plan);
    expect(result.simulated.attrs.attack.gear).toBe(8);
    expect(result.simulated.attrs.defense.gear).toBe(3);
  });

  it('缺省的自定义一件：主属性取部位第一项，副属性取第一个不同的，副属性数值取区间中间值向下取整', () => {
    expect(defaultCustomSlot('weapon', 'common', null)).toEqual({
      mode: 'custom',
      quality: 'common',
      mainAttr: 'attack',
      subAttr: 'defense',
      subValue: 0,
      refineLevel: 0,
    });
    const equipment = equipmentOf([]);
    expect(midSubValue(equipment, 'common')).toBe(3);
    expect(midSubValue(equipment, 'spirit')).toBe(6);
    expect(midSubValue(equipment, 'treasure')).toBe(8);
    expect(midSubValue(equipment, 'immortal')).toBe(12);
    expect(defaultCustomSlot('armor', 'spirit', equipment)).toMatchObject({ mainAttr: 'defense', subAttr: 'attack', subValue: 6 });
    expect(defaultCustomSlot('artifact', 'treasure', equipment)).toMatchObject({ mainAttr: 'speed', subAttr: 'attack', subValue: 8 });
    expect(subAttrChoices('luck')).toEqual(['attack', 'defense', 'speed', 'physique']);
  });

  it('装备视图为 null：装备格不参与，不报错，境界与悟道值照常算', () => {
    const disciple = discipleOf({});
    const input = inputOf(disciple, null, 0);
    const plan = planOf(
      input,
      {
        weapon: { mode: 'custom', quality: 'immortal', mainAttr: 'attack', subAttr: 'luck', subValue: 12, refineLevel: 12 },
        armor: { mode: 'empty' },
      },
      { target: { realmId: 'nascentSoul', stage: 1 }, insight: { attack: 2 } },
    );
    const result = simulate(input, plan);
    expect(result.breakdown.map((row) => row.id)).toEqual(['realm', 'insight']);
    expect(result.simulated.attrs.attack.gear).toBe(0);
    expect(result.current.combatPower).toBe(serverPower(disciple));
  });

  it('装备视图未解锁（炼器未开放）：装备格整块不参与', () => {
    const items = [
      itemOf({ discipleId: 'd1', slot: 'weapon', quality: 'common', mainAttr: 'attack', subAttr: 'luck', subValue: 3, refineLevel: 0 }),
    ];
    const disciple = discipleOf({}, items);
    const input = inputOf(disciple, equipmentOf(items, { unlocked: false }));
    const result = simulate(input, planOf(input, { weapon: { mode: 'empty' } }));
    expect(result.breakdown).toEqual([]);
    expect(result.simulated.combatPower).toBe(serverPower(disciple));
  });
});

/* ---------- 悟道值 ---------- */

describe('悟道值', () => {
  it('悟道值加到基础属性；手上点数不够的部分在代价里写「还需」', () => {
    const disciple = discipleOf({ daoInsight: 6, daoInsightRemaining: 50 });
    const input = inputOf(disciple, equipmentOf([]));
    const result = simulate(input, planOf(input, {}, { insight: { attack: 5, defense: 3 } }));
    expect(result.simulated.attrs.attack.base).toBe(45);
    expect(result.simulated.attrs.defense.base).toBe(33);
    const row = result.breakdown.find((item) => item.id === 'insight')!;
    expect(row.label).toBe('悟道值：攻击 +5、防御 +3');
    expect(row.notes).toEqual(['还需 2 点悟道值（赌坊 / 悟道丹）']);
    expect(row.cost).toEqual({});
    expect(row.gainRatio).toBeCloseTo(serverPower({ ...disciple, attack: 45, defense: 33 }) / serverPower(disciple) - 1, 10);
  });

  it('手上点数够时代价里不写「还需」', () => {
    const disciple = discipleOf({ daoInsight: 10 });
    const input = inputOf(disciple, equipmentOf([]));
    const result = simulate(input, planOf(input, {}, { insight: { speed: 4 } }));
    expect(result.breakdown.find((item) => item.id === 'insight')!.notes).toEqual([]);
  });

  it('超过 100 与超过累计额度：校验给出文案，计算时夹到合法范围', () => {
    const disciple = discipleOf({ attack: 98, defense: 30, daoInsight: 20, daoInsightRemaining: 4 });
    const input = inputOf(disciple, equipmentOf([]));
    const plan = planOf(input, {}, { insight: { attack: 5, defense: 3 } });
    const issues = validatePlan(input, plan);
    expect(issues.insight.attack).toBe('攻击最多再加 2 点（上限 100）');
    expect(issues.insight.defense).toBeUndefined();
    expect(issues.insight.total).toBe('三项合计最多 4 点（还能累计分配的额度）');

    const result = simulate(input, plan);
    // 攻击最多再加 2（到 100），合计最多 4 点：攻击 2 + 防御 2。
    expect(result.simulated.attrs.attack.base).toBe(100);
    expect(result.simulated.attrs.defense.base).toBe(32);
  });

  it('累计额度用完时给出「已经用完」的文案', () => {
    const disciple = discipleOf({ daoInsightRemaining: 0 });
    const input = inputOf(disciple, equipmentOf([]));
    const issues = validatePlan(input, planOf(input, {}, { insight: { speed: 1 } }));
    expect(issues.insight.total).toBe('累计分配的额度已经用完');
  });
});

/* ---------- 单项拆解与全部一起 ---------- */

describe('单项拆解与全部一起', () => {
  it('每项单独算、按增幅从高到低排，增幅最高的一行标「提升最大」', () => {
    const disciple = discipleOf({});
    const input = inputOf(disciple, equipmentOf([]));
    const immortalArmor: SimEquipmentItem = itemOf({
      discipleId: null,
      slot: 'armor',
      quality: 'immortal',
      mainAttr: 'defense',
      subAttr: 'attack',
      subValue: 12,
      refineLevel: 0,
    });
    const plan = planOf(
      { ...input, equipment: equipmentOf([immortalArmor]) },
      { armor: { mode: 'custom', quality: 'immortal', mainAttr: 'defense', subAttr: 'attack', subValue: 12, refineLevel: 0 } },
      { target: { realmId: 'nascentSoul', stage: 1 }, insight: { attack: 3 } },
    );
    const result = simulate({ ...input, equipment: equipmentOf([immortalArmor]) }, plan);

    const power0 = serverPower(disciple);
    const realmGain = serverPower(disciple, 'nascentSoul', 1) / power0 - 1;
    const armorGain =
      discipleCombatPower('goldenCore', 1, 40 + 12, 30 + 24, 25, 'none', 1000) / power0 - 1;
    const insightGain = discipleCombatPower('goldenCore', 1, 43, 30, 25, 'none', 0) / power0 - 1;

    expect(result.breakdown.map((row) => row.id)).toEqual(['realm', 'armor', 'insight']);
    expect(result.breakdown[0]!.gainRatio).toBeCloseTo(realmGain, 10);
    expect(result.breakdown[1]!.gainRatio).toBeCloseTo(armorGain, 10);
    expect(result.breakdown[2]!.gainRatio).toBeCloseTo(insightGain, 10);
    expect(result.breakdown.map((row) => row.best)).toEqual([true, false, false]);
    expect(formatGainRatio(result.breakdown[0]!.gainRatio)).toBe('+43%');
  });

  it('全部一起是组合结果：总增幅 = 模拟战力 / 当前战力 − 1，不是各项相加', () => {
    const disciple = discipleOf({});
    const input = inputOf(disciple, equipmentOf([]));
    const immortalArmor = itemOf({
      discipleId: null,
      slot: 'armor',
      quality: 'immortal',
      mainAttr: 'defense',
      subAttr: 'attack',
      subValue: 12,
      refineLevel: 0,
    });
    const scoped = { ...input, equipment: equipmentOf([immortalArmor]) };
    const plan = planOf(
      scoped,
      { armor: { mode: 'custom', quality: 'immortal', mainAttr: 'defense', subAttr: 'attack', subValue: 12, refineLevel: 0 } },
      { target: { realmId: 'nascentSoul', stage: 1 }, insight: { attack: 3 } },
    );
    const result = simulate(scoped, plan);

    const combined = discipleCombatPower('nascentSoul', 1, 43 + 12, 30 + 24, 25, 'none', 1000);
    expect(result.simulated.combatPower).toBe(combined);
    expect(result.total.gainRatio).toBeCloseTo(combined / serverPower(disciple) - 1, 10);
    const sumOfSingles = result.breakdown.reduce((sum, row) => sum + row.gainRatio, 0);
    expect(result.total.gainRatio).not.toBeCloseTo(sumOfSingles, 6);
    expect(result.total.label).toBe('全部一起');
    // 金丹初期 → 元婴初期：金丹三层的门槛 1800 + 3600 + 3600 = 9000；灵气 20000 + 40000 + 60000。
    expect(result.total.cost).toEqual(sumCosts({ spiritualEnergy: 120_000 }, forgeCostOf('immortal')));
    expect(result.total.notes).toContain('修为还差 9000，约 32 天（按当前修炼速度，不含突破失败）');
  });

  it('没有任何改动：拆解为空，全部一起的增幅为 0', () => {
    const disciple = discipleOf({});
    const input = inputOf(disciple, equipmentOf([]));
    const result = simulate(input, defaultPlan(input));
    expect(result.breakdown).toEqual([]);
    expect(result.total.gainRatio).toBe(0);
    expect(result.total.best).toBe(false);
  });

  it('没有正增幅时不标「提升最大」（只有下降的一项）', () => {
    const items = [
      itemOf({ discipleId: 'd1', slot: 'weapon', quality: 'immortal', mainAttr: 'attack', subAttr: 'luck', subValue: 12, refineLevel: 12 }),
    ];
    const disciple = discipleOf({}, items);
    const input = inputOf(disciple, equipmentOf(items));
    const result = simulate(input, planOf(input, { weapon: { mode: 'empty' } }));
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0]!.gainRatio).toBeLessThan(0);
    expect(result.breakdown[0]!.best).toBe(false);
    expect(formatGainRatio(result.breakdown[0]!.gainRatio).startsWith('-')).toBe(true);
  });

  it('模拟不改动输入：入参在模拟前后深度相等', () => {
    const items = [
      itemOf({ discipleId: 'd1', slot: 'weapon', quality: 'spirit', mainAttr: 'attack', subAttr: 'defense', subValue: 5, refineLevel: 2 }),
    ];
    const disciple = discipleOf({ daoInsight: 9 }, items);
    const input = inputOf(disciple, equipmentOf(items), 50);
    const snapshot = structuredClone(input);
    simulate(input, planOf(input, { weapon: { mode: 'keep', refineLevel: 12 } }, { target: { realmId: 'mahayana', stage: 3 }, insight: { attack: 4 } }));
    expect(input).toEqual(snapshot);
  });
});

/* ---------- 选项与展示文案 ---------- */

describe('选项、校验与展示', () => {
  it('目标下拉框：从当前层起往上的所有层（按境界顺序展开），更低的层不列', () => {
    const disciple = discipleOf({ realmId: 'qiRefining', stage: 2 });
    const options = targetOptions(inputOf(disciple, null));
    expect(options).toHaveLength(REALMS.length * 3 - 1);
    expect(options[0]).toMatchObject({ realmId: 'qiRefining', stage: 2, label: '炼气二层' });
    expect(options[options.length - 1]).toMatchObject({ realmId: 'tribulation', stage: 3, label: '渡劫后期' });
  });

  it('自定义品质：炼器坊等级不够的标为未解锁，区间取服务端 subMin / subMax', () => {
    const choices = qualityChoices(equipmentOf([], { workshopLevel: 3 }));
    expect(choices.map((choice) => [choice.id, choice.unlocked, choice.subMin, choice.subMax])).toEqual([
      ['common', true, 2, 4],
      ['spirit', true, 4, 8],
      ['treasure', true, 6, 10],
      ['immortal', false, 8, 16],
    ]);
  });

  it('增幅文案：不足 10% 保留一位小数，负数也显示，0 显示 0%', () => {
    expect(formatGainRatio(0.12)).toBe('+12%');
    expect(formatGainRatio(0.035)).toBe('+3.5%');
    expect(formatGainRatio(-0.042)).toBe('-4.2%');
    expect(formatGainRatio(0)).toBe('0%');
    expect(formatGainRatio(1.234)).toBe('+123%');
  });

  it('代价文案：按资源名拼接，金额用展示单位', () => {
    expect(formatCostText({ spiritStone: 1_200_000, ore: 300_000, xuantie: 4_000 }, RESOURCES)).toBe(
      '1200 灵石 + 300 矿石 + 4 玄铁',
    );
    expect(formatCostText({}, RESOURCES)).toBe('');
  });

  it('装备格取穿在身上的那件（按部位与弟子 id 对得上）', () => {
    const items = [
      itemOf({ discipleId: 'd1', slot: 'weapon', quality: 'common', mainAttr: 'attack', subAttr: 'luck', subValue: 3, refineLevel: 0 }),
      itemOf({ discipleId: null, slot: 'weapon', quality: 'immortal', mainAttr: 'attack', subAttr: 'luck', subValue: 9, refineLevel: 0 }),
    ];
    expect(wornItemOf(equipmentOf(items), 'd1', 'weapon')?.quality).toBe('common');
    expect(wornItemOf(equipmentOf(items), 'd1', 'armor')).toBeNull();
    expect(wornItemOf(null, 'd1', 'weapon')).toBeNull();
  });
});
