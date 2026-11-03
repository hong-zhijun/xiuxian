import { z } from 'zod';
import type { AchievementView, CheckinView, ProgressionCosmetic, ProgressionDestination, ProgressionReward, QuestChapterView, ReputationShopItem } from '@xiuxian/contracts';
import { dateKeyUtc8 } from './constants';

// 和公共契约保持同形，使用服务端本地 zod，兼容安装树中两个 zod 次版本。
const command = { commandId: z.uuid() };
export const progressionActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...command, action: z.literal('checkin') }),
  z.strictObject({ ...command, action: z.literal('makeup') }),
  z.strictObject({ ...command, action: z.literal('claim-achievement'), id: z.string().min(1).max(64) }),
  z.strictObject({ ...command, action: z.literal('claim-quest'), id: z.string().min(1).max(64) }),
  z.strictObject({ ...command, action: z.literal('buy-reputation'), id: z.string().min(1).max(64) }),
  z.strictObject({ ...command, action: z.literal('set-frame'), id: z.string().min(1).max(64).nullable() }),
  z.strictObject({ ...command, action: z.literal('set-title'), id: z.string().min(1).max(64).nullable() }),
]);
/** 阶段一成长规则；所有资源均为最小单位（展示数量 ×1000）。 */
export const MAKEUP_LIMIT = 3;
export const MAKEUP_COST = 500_000;
export const RISING_STAR_BONUS_BP = 200;
export const CHECKIN_PILLS = ['healingPill', 'cultivationPill', 'bodyTemperingPill', 'talentPill', 'greatCultivationPill', 'insightPill', 'aptitudePill'] as const;
export const CHECKIN_REWARDS: readonly ProgressionReward[] = [
  { resources: { spiritStone: '5000000' }, description: '灵石 5,000' },
  { resources: { herb: '2000000' }, description: '药材 2,000' },
  { resources: { ore: '2000000' }, description: '矿石 2,000' },
  { resources: { spiritualEnergy: '5000000' }, description: '灵气 5,000' },
  { description: '随机丹药 ×1' },
  { resources: { xuantie: '2000' }, description: '玄铁 ×2' },
  { resources: { shenmu: '1000', spiritStone: '20000000' }, description: '神木 ×1、灵石 20,000' },
];
export interface CheckinRow {
  sect_id: string; streak: number; month_key: string; total_days: number;
  last_checkin_date: string | null; makeup_used: number; version: number; created_at: number; updated_at: number;
}
export function shiftDate(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
export function dayDistance(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
export function checkinView(row: CheckinRow | null, now: number, createdAt: number, balance: number): CheckinView {
  const today = dateKeyUtc8(now), yesterday = shiftDate(today, -1), month = today.slice(0, 7);
  const checkedToday = row?.last_checkin_date === today;
  const last = row?.last_checkin_date ?? null;
  const gap = last === null ? Infinity : dayDistance(last, today);
  const streak = gap <= 1 ? Number(row?.streak ?? 0) : 0;
  // 补签必须先于今日签到；最多补回相邻三天，断签较久可从昨日重新起算。
  const makeupDate = checkedToday || last === yesterday || dateKeyUtc8(createdAt) > yesterday ? null
    : last !== null && gap > 1 && gap <= MAKEUP_LIMIT + 1 ? shiftDate(last, 1) : yesterday;
  const used = row?.month_key === month ? Number(row.makeup_used) : 0;
  const reason = checkedToday ? '今日已签到，请在下次签到前补签' : makeupDate === null ? '暂无可补签日期'
    : used >= MAKEUP_LIMIT ? '本月补签次数已用完' : balance < MAKEUP_COST ? '补签需要灵石 500' : null;
  return { dateKey: today, streak, totalDays: Number(row?.total_days ?? 0), checkedToday,
    nextDay: (streak % 7) + 1, days: CHECKIN_REWARDS.map((reward, i) => ({ day: i + 1, reward })),
    makeupDate, makeupUsed: used, makeupLimit: MAKEUP_LIMIT, makeupCost: String(MAKEUP_COST),
    canMakeup: reason === null, blockedReason: reason, milestone: '每连续 30 天额外获得同一门随机天阶功法残卷 ×5；断签清零，补签请先于今日签到。' };
}
export function checkinReward(streak: number, random: () => number): ProgressionReward {
  const base = CHECKIN_REWARDS[(streak - 1) % 7]!;
  const pill = (streak - 1) % 7 === 4 ? CHECKIN_PILLS[Math.min(CHECKIN_PILLS.length - 1, Math.max(0, Math.floor(random() * CHECKIN_PILLS.length)))]! : null;
  return { ...base, ...(pill === null ? {} : { pills: { [pill]: 1 } }),
    ...(streak % 30 === 0 ? { scrolls: { tier: 'tian' as const, quantity: 5 }, description: `${base.description}、天阶功法残卷 ×5` } : {}) };
}
export interface ProgressionFacts {
  sectLevel: number; disciples: number; realmIndex: number; ascended: number; tower: number;
  bossDamage: number; champion: number; collection: number; immortalBeast: number; techniques: number;
  auctions: number; meteorJackpot: number; stockProfit: number; ancestral: number; tribute: number;
  created: number; assigned: number; breakthrough: number; alchemy: number; forge: number;
  explorations: number; challenges: number; bossHits: number; stockTrades: number; sites: number;
}
export type FactKey = keyof ProgressionFacts;
export interface AchievementDefinition {
  id: string; category: string; name: string; fact: FactKey; target: number;
  tier: AchievementView['tier']; description?: string;
}
const series = (prefix: string, category: string, fact: FactKey, values: readonly number[], names: readonly string[]): AchievementDefinition[] =>
  values.map((target, i) => ({ id: `${prefix}-${target}`, category, name: names[i]!, fact, target, tier: (['bronze', 'silver', 'gold'] as const)[Math.min(i, 2)]! }));
export const ACHIEVEMENTS: readonly AchievementDefinition[] = [
  ...series('sect', '宗门', 'sectLevel', [5, 10, 15], ['一方宗门', '名震四方', '仙门至尊']),
  ...series('disciples', '宗门', 'disciples', [20, 40, 64], ['门徒渐众', '桃李天下', '满门英杰']),
  { id: 'realm-goldenCore', category: '修为', name: '金丹初成', fact: 'realmIndex', target: 2, tier: 'bronze' },
  { id: 'realm-nascentSoul', category: '修为', name: '元婴出窍', fact: 'realmIndex', target: 3, tier: 'silver' },
  { id: 'realm-spiritTransformation', category: '修为', name: '化神入道', fact: 'realmIndex', target: 4, tier: 'silver' },
  { id: 'realm-tribulation', category: '修为', name: '渡劫问仙', fact: 'realmIndex', target: 8, tier: 'gold' },
  { id: 'ascension-1', category: '修为', name: '羽化登仙', fact: 'ascended', target: 1, tier: 'gold' },
  ...series('tower', '战斗', 'tower', [50, 100, 200], ['镇妖先锋', '百层镇守', '镇妖无双']),
  { id: 'boss-damage-1000000', category: '战斗', name: '降妖百万', fact: 'bossDamage', target: 1_000_000, tier: 'silver', description: '现存世界 BOSS 出手记录累计伤害达到 100 万' },
  { id: 'arena-champion', category: '战斗', name: '大比魁首', fact: 'champion', target: 1, tier: 'gold', description: '现存大比日榜或赛季奖励记录中获得第一名' },
  ...series('collection', '收集', 'collection', [20, 40, 60], ['百兽初识', '御兽行家', '万兽宗师']),
  { id: 'beast-immortal', category: '收集', name: '仙兽相伴', fact: 'immortalBeast', target: 1, tier: 'gold' },
  { id: 'techniques-6', category: '收集', name: '博览群书', fact: 'techniques', target: 6, tier: 'silver' },
  { id: 'techniques-12', category: '收集', name: '万法归宗', fact: 'techniques', target: 12, tier: 'gold' },
  { id: 'auction-10', category: '经济', name: '拍卖常客', fact: 'auctions', target: 10, tier: 'bronze', description: '现存拍卖成交记录中作为买家或卖家成交 10 次' },
  { id: 'meteor-jackpot', category: '经济', name: '天外奇缘', fact: 'meteorJackpot', target: 1, tier: 'gold', description: '现存赌石记录中开出天外陨石档的天外奇珍' },
  { id: 'stock-profit-100000', category: '经济', name: '灵股巨擘', fact: 'stockProfit', target: 100_000, tier: 'silver', description: '现存现货及保证金成交流水累计净盈利 10 万灵石（扣亏损）' },
  { id: 'ancestral-site', category: '山河', name: '祖脉之主', fact: 'ancestral', target: 1, tier: 'gold' },
  { id: 'tribute-10000', category: '山河', name: '山河供奉', fact: 'tribute', target: 10_000, tier: 'silver', description: '累计获得 1 万灵气供奉；上线时已补计保留记录，此后永久累计（已清理旧历史无法补计）' },
];
export function achievementReward(def: AchievementDefinition): ProgressionReward {
  if (def.tier === 'bronze') return { reputation: 50, resources: { spiritStone: '20000000' }, description: '声望 50、灵石 20,000' };
  if (def.tier === 'silver') return { reputation: 150, resources: { beastEssence: '50000' }, description: '声望 150、御兽精魄 ×50' };
  return { reputation: 500, cosmetic: { id: `achievement:${def.id}`, name: `${def.name}·金章`, kind: 'frame' }, description: `声望 500、专属头像框「${def.name}·金章」` };
}
export function achievementViews(facts: ProgressionFacts, claimed: ReadonlySet<string>): AchievementView[] {
  return ACHIEVEMENTS.map(def => ({ ...def, description: def.description ?? `${def.name}：达到 ${String(def.target)}（按现存角色/图鉴/记录计算）`,
    progress: Math.min(def.target, Math.max(0, facts[def.fact])), completed: facts[def.fact] >= def.target || claimed.has(def.id), claimed: claimed.has(def.id), reward: achievementReward(def) }));
}
interface QuestDefinition {
  id: string; name: string; reward: ProgressionReward;
  steps: { id: string; name: string; fact: FactKey; target: number; destination: ProgressionDestination; description: string }[];
}
export const QUESTS: readonly QuestDefinition[] = [
  { id: 'kaishan', name: '第一章·开山', reward: { resources: { spiritStone: '10000000' }, description: '灵石 10,000' }, steps: [
    { id: 'create', name: '建立宗门', fact: 'created', target: 1, destination: 'sect', description: '为宗门取名，开启掌门之路。' },
    { id: 'recruit', name: '招募三名弟子', fact: 'disciples', target: 3, destination: 'disciples', description: '打开招贤，选择有缘人，使门下弟子达到三人。' },
    { id: 'assign', name: '派弟子任一岗位', fact: 'assigned', target: 1, destination: 'disciples', description: '在弟子列表选择岗位，安排任意一名弟子采集、吐纳或静修。' },
    { id: 'breakthrough', name: '完成首次破境', fact: 'breakthrough', target: 1, destination: 'disciples', description: '让弟子静修积累修为，修为满后打开详情，消耗灵气尝试破境。' },
    { id: 'level2', name: '宗门达到二级', fact: 'sectLevel', target: 2, destination: 'sect', description: '将聚灵阵升至二级，培养一名筑基弟子，再回宗门页升级。' },
  ] },
  { id: 'lipai', name: '第二章·立派', reward: { resources: { xuantie: '5000' }, description: '玄铁 ×5' }, steps: [
    { id: 'alchemy', name: '炼制或持有丹药', fact: 'alchemy', target: 1, destination: 'alchemy', description: '将灵药园升至二级后炼制一颗丹药，或从坊市购入丹药。' },
    { id: 'forge', name: '炼器一次', fact: 'forge', target: 1, destination: 'equipment', description: '打开炼器，选择部位并备齐灵石、矿石，炼制第一件装备。' },
    { id: 'tower10', name: '镇妖塔通关十层', fact: 'tower', target: 10, destination: 'tower', description: '选出能出战的弟子进入镇妖塔，逐层挑战至第十层。' },
    { id: 'level3', name: '宗门达到三级', fact: 'sectLevel', target: 3, destination: 'sect', description: '将灵矿升至二级，培养两名筑基弟子，再回宗门页升级。' },
  ] },
  { id: 'yangming', name: '第三章·扬名', reward: { resources: { shenmu: '3000' }, description: '神木 ×3' }, steps: [
    { id: 'explore3', name: '秘境通关三次', fact: 'explorations', target: 3, destination: 'realms', description: '在秘境选择适合队伍的关卡，成功速通或完成探索累计三次。' },
    { id: 'challenge', name: '登门挑战一次', fact: 'challenges', target: 1, destination: 'challenge', description: '在宗门挑战中选择对手，派出三名弟子完成一场挑战。' },
    { id: 'boss', name: '向世界 BOSS 出手一次', fact: 'bossHits', target: 1, destination: 'boss', description: '世界 BOSS 出现时，选择能出战的弟子进行一次讨伐。' },
    { id: 'level5', name: '宗门达到五级', fact: 'sectLevel', target: 5, destination: 'sect', description: '逐级发展宗门；五级需灵药园三级和两名金丹弟子，备齐资源后升级。' },
  ] },
  { id: 'wending', name: '第四章·问鼎', reward: { equipmentBox: true, description: '仙品装备箱 ×1（领取时直接开出一件随机部位仙品装备，背包需有空位）' }, steps: [
    { id: 'auction', name: '拍卖成交一次', fact: 'auctions', target: 1, destination: 'auction', description: '在拍卖行拍下心仪物品，或上架物品并等待买家成交。' },
    { id: 'stock', name: '完成灵股交易一次', fact: 'stockTrades', target: 1, destination: 'market', description: '打开灵股，选择一支股票完成一次买入或卖出。' },
    { id: 'world', name: '山河占领一处灵地', fact: 'sites', target: 1, destination: 'world', description: '在山河舆图选择灵地，派队驱妖开辟或挑战守军，获胜后占领。' },
    { id: 'level8', name: '宗门达到八级', fact: 'sectLevel', target: 8, destination: 'sect', description: '逐级发展宗门；八级需藏经阁三级和两名元婴弟子，备齐资源后升级。' },
  ] },
];
export function questViews(facts: ProgressionFacts, claimed: ReadonlySet<string>): QuestChapterView[] {
  return QUESTS.map((def, index) => ({ id: def.id, name: def.name, reward: def.reward,
    unlocked: index === 0 || claimed.has(QUESTS[index - 1]!.id), claimed: claimed.has(def.id),
    completed: claimed.has(def.id) || def.steps.every(step => facts[step.fact] >= step.target),
    steps: def.steps.map(step => ({ ...step, description: step.description, progress: Math.min(step.target, Math.max(0, facts[step.fact])), completed: facts[step.fact] >= step.target || claimed.has(def.id) })) }));
}
export const SHOP_COSMETICS: readonly ProgressionCosmetic[] = [
  { id: 'frame-jade', name: '青玉流光', kind: 'frame' }, { id: 'frame-cloud', name: '云海仙踪', kind: 'frame' },
  { id: 'frame-dragon', name: '金龙问道', kind: 'frame' }, { id: 'rising-star', name: '后起之秀', kind: 'title' },
];
export const REPUTATION_SHOP: readonly { id: string; name: string; cost: number; reward: ProgressionReward }[] = [
  { id: 'essence-10', name: '御兽精魄 ×10', cost: 100, reward: { resources: { beastEssence: '10000' }, description: '御兽精魄 ×10' } },
  { id: 'pill-talent', name: '洗髓丹 ×1', cost: 200, reward: { pills: { talentPill: 1 }, description: '洗髓丹 ×1' } },
  { id: 'pill-aptitude', name: '培元丹 ×1', cost: 200, reward: { pills: { aptitudePill: 1 }, description: '培元丹 ×1' } },
  ...SHOP_COSMETICS.filter(c => c.kind === 'frame').map((cosmetic, i) => ({ id: cosmetic.id, name: `头像框·${cosmetic.name}`, cost: [300, 500, 800][i]!, reward: { cosmetic, description: `头像框「${cosmetic.name}」（每月轮换）` } })),
  { id: 'title-rising-star', name: '称号·后起之秀', cost: 500, reward: { cosmetic: SHOP_COSMETICS[3]!, description: '称号「后起之秀」、全资源挂机产出永久 +2%（卸下称号仍生效）' } },
  { id: 'tian-scroll', name: '天阶功法残卷 ×1', cost: 800, reward: { scrolls: { tier: 'tian' as const, quantity: 1 }, description: '随机天阶功法残卷 ×1（可在藏经阁收录/参悟）' } },
  { id: 'rename-token', name: '宗门改名令 ×1', cost: 1000, reward: { renameToken: 1, description: '宗门改名令 ×1（宗门改名时优先消耗）' } },
];
export function activeShopFrame(now: number): string {
  const key = dateKeyUtc8(now); return SHOP_COSMETICS[(Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1) % 3]!.id;
}
export function reputationShopViews(reputation: number, purchased: ReadonlyMap<string, number>, now: number): ReputationShopItem[] {
  return REPUTATION_SHOP.map(item => {
    const count = purchased.get(item.id) ?? 0, limit = item.reward.cosmetic ? 1 : null;
    const reason = limit !== null && count >= limit ? '已拥有' : item.reward.cosmetic?.kind === 'frame' && item.id !== activeShopFrame(now) ? '本月未轮换到此头像框' : reputation < item.cost ? '声望不足' : null;
    return { ...item, purchased: count, limit, canBuy: reason === null, blockedReason: reason };
  });
}
