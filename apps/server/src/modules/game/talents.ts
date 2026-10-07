import { REALMS, realmIndex } from './constants';

/**
 * 天赋重构（docs/天赋重构开发计划.md）——纯定义与纯计算。
 *
 * 与 alchemy.ts / equipment.ts 同理：天赋是少量功能规则，放在游戏模块代码里，
 * 不进 GameConfigContent，也不改公共配置哈希。弟子表 talent 列只存 id；
 * 保留 V4 的 4 个 id（herbGathering / mining / cultivation / combat），只改名字与效果，
 * 老弟子不需要迁移数据。
 *
 * 本文件只放纯定义和纯计算：不读数据库、不取时间；随机通过参数注入。
 *
 * 天赋强度 = 基础值 × 境界系数（按弟子当前境界；同一境界的三个阶段相同）。
 */

export type TalentCategory = 'production' | 'cultivation' | 'combat' | 'steward';

export const TALENT_CATEGORY_NAMES: Readonly<Record<TalentCategory, string>> = {
  production: '产出',
  cultivation: '修行',
  combat: '战斗',
  steward: '宗门',
};

export interface TalentDef {
  id: string;
  name: string;
  category: TalentCategory;
  /** 炼气境界时的加成（基点，10000 = 100%）；其它境界按 TALENT_REALM_MULTIPLIER_BP 放大。 */
  baseBp: number;
  /** 生效条件（天赋表里的一列），如「在药园岗位时」。 */
  condition: string;
  /** 效果模板：`{value}` 换成带符号的百分比（如「+25%」「−20%」）。 */
  effect: string;
  /** 数值方向：减益类（铁骨、丹道）显示为「−」。 */
  sign: 1 | -1;
}

export const TALENTS: readonly TalentDef[] = [
  {
    id: 'herbGathering',
    name: '灵植',
    category: 'production',
    baseBp: 2000,
    condition: '在药园岗位时；历练采集',
    effect: '药材产出 {value}',
    sign: 1,
  },
  {
    id: 'mining',
    name: '矿脉',
    category: 'production',
    baseBp: 2000,
    condition: '在采矿岗位时；历练采集',
    effect: '矿石产出 {value}',
    sign: 1,
  },
  {
    id: 'spiritGathering',
    name: '聚灵',
    category: 'production',
    baseBp: 2000,
    condition: '在采灵 / 吐纳岗位时；历练',
    effect: '灵石 / 灵气产出 {value}',
    sign: 1,
  },
  {
    id: 'cultivation',
    name: '悟道',
    category: 'cultivation',
    baseBp: 1600,
    condition: '在修炼岗位时；历练',
    effect: '修炼速度 {value}',
    sign: 1,
  },
  {
    id: 'pillAffinity',
    name: '丹心',
    category: 'cultivation',
    baseBp: 2000,
    condition: '服用聚气丹时',
    effect: '每颗聚气丹修为 {value}',
    sign: 1,
  },
  {
    id: 'combat',
    name: '战意',
    category: 'combat',
    baseBp: 1000,
    condition: '讨伐、秘境、切磋、守擂、镇妖塔',
    effect: '战力 {value}',
    sign: 1,
  },
  {
    id: 'critical',
    name: '会心',
    category: 'combat',
    baseBp: 6000,
    condition: '讨伐、镇妖塔暴击时',
    effect: '自身伤害额外 {value}',
    sign: 1,
  },
  {
    id: 'ironBody',
    name: '铁骨',
    category: 'combat',
    baseBp: 2000,
    condition: '讨伐；镇妖塔（按 5 人平均）',
    effect: '受伤、重伤概率 / 镇妖塔承伤 {value}',
    sign: -1,
  },
  {
    id: 'forging',
    name: '炼器',
    category: 'steward',
    baseBp: 400,
    condition: '任炼器执事时',
    effect: '全宗炼器成功率 {value}',
    sign: 1,
  },
  {
    id: 'alchemy',
    name: '丹道',
    category: 'steward',
    baseBp: 800,
    condition: '任丹房执事时',
    effect: '全宗炼丹消耗 {value}',
    sign: -1,
  },
  {
    id: 'treasure',
    name: '寻宝',
    category: 'steward',
    baseBp: 1000,
    condition: '任寻宝执事时',
    effect: '全宗秘境收获与玄铁掉率 {value}',
    sign: 1,
  },
];

export const TALENT_IDS: readonly string[] = TALENTS.map((talent) => talent.id);

export function findTalent(talentId: string): TalentDef | undefined {
  return TALENTS.find((talent) => talent.id === talentId);
}

/** 天赋显示名；无 / 未知天赋返回「无」。 */
export function talentNameOf(talentId: string | null | undefined): string {
  return talentId === null || talentId === undefined ? '无' : (findTalent(talentId)?.name ?? '无');
}

/**
 * 境界系数（基点，下标对齐 REALMS）：炼气 ×1、筑基 ×1.25、金丹 ×1.5、元婴 ×2、化神 ×2.5；
 * 境界扩充后炼虚 ×2.75、合体 ×3、大乘 ×3.25、渡劫 ×3.5（化神之后每境界只 +0.25，防后期天赋失控）。
 */
export const TALENT_REALM_MULTIPLIER_BP: readonly number[] = [
  10_000, 12_500, 15_000, 20_000, 25_000, 27_500, 30_000, 32_500, 35_000,
];

/** 某境界下标的系数；越界夹到表的两端（以后开放新境界前先按最高档算）。 */
function realmMultiplierBp(index: number): number {
  const clamped = Math.min(TALENT_REALM_MULTIPLIER_BP.length - 1, Math.max(0, Math.floor(index)));
  return TALENT_REALM_MULTIPLIER_BP[clamped]!;
}

/**
 * 天赋在该境界的加成（基点，恒为非负；方向见 TalentDef.sign，由调用方按语义使用）。
 * expectedTalentId 给了时只在天赋匹配时返回加成，否则 0 —— 调用方写成
 * `talentBonusBp(disciple.talent, disciple.realm_id, 'mining')`，不用自己先比 id。
 */
export function talentBonusBp(talentId: string, realmId: string, expectedTalentId?: string): number {
  if (expectedTalentId !== undefined && talentId !== expectedTalentId) return 0;
  const def = findTalent(talentId);
  if (def === undefined) return 0;
  return Math.floor((def.baseBp * realmMultiplierBp(realmIndex(realmId))) / 10_000);
}

/** 基点 → 「+25%」「−20%」（最多一位小数，去掉多余的 0）。 */
function percentText(bp: number, sign: 1 | -1): string {
  const value = Number((bp / 100).toFixed(1));
  return `${sign < 0 ? '−' : '+'}${String(value)}%`;
}

/** 天赋在该境界的效果文案，如「矿石产出 +25%」；无 / 未知天赋返回空串。 */
export function talentEffectText(talentId: string, realmId: string): string {
  const def = findTalent(talentId);
  if (def === undefined) return '';
  return def.effect.replace('{value}', percentText(talentBonusBp(talentId, realmId), def.sign));
}

/** 天赋总表（弟子详情「?」弹窗）：每个天赋在五个境界的数值，全部服务端算好。 */
export interface TalentCatalogEntry {
  id: string;
  name: string;
  category: TalentCategory;
  categoryName: string;
  condition: string;
  /** 不带数值的效果描述，如「矿石产出」。 */
  effect: string;
  values: { realmId: string; realmName: string; text: string }[];
}

export function talentCatalog(): TalentCatalogEntry[] {
  return TALENTS.map((def) => ({
    id: def.id,
    name: def.name,
    category: def.category,
    categoryName: TALENT_CATEGORY_NAMES[def.category],
    condition: def.condition,
    effect: def.effect.replace(' {value}', '').replace('{value}', ''),
    values: REALMS.map((realm) => ({
      realmId: realm.id,
      realmName: realm.name,
      text: percentText(talentBonusBp(def.id, realm.id), def.sign),
    })),
  }));
}

/** 新弟子的天赋：11 个等概率。 */
export function generateTalent(random: () => number): string {
  const index = Math.min(TALENT_IDS.length - 1, Math.max(0, Math.floor(random() * TALENT_IDS.length)));
  return TALENT_IDS[index]!;
}

/* ---------- 洗髓丹（计划第 3 节） ---------- */

/** 洗髓丹的丹药 id。 */
export const TALENT_PILL_ID = 'talentPill';
/** 每名弟子最多服用洗髓丹的次数。 */
export const TALENT_REROLL_MAX_USES = 10;

/** 洗出的候选天赋：从「除当前天赋外」的天赋里等概率抽一个。 */
export function rollTalentCandidate(currentTalent: string, random: () => number): string {
  const pool = TALENT_IDS.filter((id) => id !== currentTalent);
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  return pool[index]!;
}

/* ---------- 执事堂（计划第 2 节） ---------- */

export type StewardOffice = 'forging' | 'alchemy' | 'treasure';

/** 三个执事职位：职位 id 与所需天赋 id 相同。 */
export const STEWARD_OFFICES: readonly { id: StewardOffice; name: string; talentId: string }[] = [
  { id: 'forging', name: '炼器执事', talentId: 'forging' },
  { id: 'alchemy', name: '丹房执事', talentId: 'alchemy' },
  { id: 'treasure', name: '寻宝执事', talentId: 'treasure' },
];

export function findStewardOffice(office: string) {
  return STEWARD_OFFICES.find((item) => item.id === office);
}

/** 卸任后的交接期：这段时间内不能出战。 */
export const STEWARD_HANDOVER_MS = 12 * 60 * 60 * 1000;

/**
 * 某职位此刻生效的加成（基点）：职位有人、天赋对得上、人不在外历练时，按他的境界算；否则 0。
 * stewards 是本宗的职位行，disciples 是本宗弟子，awayIds 是正在外历练的弟子 id。
 */
export function stewardBonusBp(input: {
  office: StewardOffice;
  stewards: readonly { office: string; disciple_id: string | null }[];
  disciples: readonly { id: string; talent: string; realm_id: string }[];
  awayIds: ReadonlySet<string>;
}): number {
  const def = findStewardOffice(input.office);
  const row = input.stewards.find((item) => item.office === input.office);
  if (def === undefined || row === undefined || row.disciple_id === null) return 0;
  if (input.awayIds.has(row.disciple_id)) return 0;
  const disciple = input.disciples.find((item) => item.id === row.disciple_id);
  if (disciple === undefined) return 0;
  return talentBonusBp(disciple.talent, disciple.realm_id, def.talentId);
}
