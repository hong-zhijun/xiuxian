import { z } from 'zod';
import type { RebirthBonuses, RebirthShopItem } from '@xiuxian/contracts';

export const rebirthActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action:z.literal('rebirth'), commandId:z.uuid(), expectedVersion:z.number().int().nonnegative() }),
  z.strictObject({ action:z.literal('buy'), id:z.string().min(1).max(64), commandId:z.uuid(), expectedVersion:z.number().int().nonnegative() }),
]);
export const REBIRTH_DAO_YUN = 100;
export const REBIRTH_RETAIN_PERCENT = 30;
export const REBIRTH_BONUSES: RebirthBonuses = { productionBp:1000, breakthroughBp:500, powerBp:500 };
export const REBIRTH_DISCIPLE_CAPACITY = 64;
export const REBIRTH_BUILDING_CAPACITY = 8;
/** 使用整数比例，不经过浮点乘法；MAX_SAFE_INTEGER 以内也保持精确。 */
export function rebirthRetainedAmount(balance: number): number {
  if (!Number.isSafeInteger(balance) || balance < 0) throw new RangeError('资源余额必须为非负安全整数');
  return Number(BigInt(balance) * 3n / 10n);
}
export function nextRebirthBonuses(bonuses: RebirthBonuses): RebirthBonuses {
  return {productionBp:bonuses.productionBp+REBIRTH_BONUSES.productionBp,
    breakthroughBp:bonuses.breakthroughBp+REBIRTH_BONUSES.breakthroughBp,powerBp:bonuses.powerBp+REBIRTH_BONUSES.powerBp};
}
export interface RebirthActivities {
  journeys:number; exploration:number; captures:number; sites:number; auction:number;
  holdings:number; orders:number; margin:number; races:number;
}
export function rebirthBlockedReasons(level:number, ascended:number, activities:RebirthActivities): string[] {
  const reasons:string[]=[];
  if (level < 15) reasons.push('宗门达到十五级后才能开辟新界。');
  if (ascended < 1) reasons.push('需至少一名弟子成仙：将渡劫后期弟子修炼圆满后，在详情中渡劫飞升。');
  if (activities.journeys > 0) reasons.push('先召回在外弟子，并领取所有历练收获。');
  if (activities.exploration > 0) reasons.push('先完成或放弃当前秘境探索。');
  if (activities.captures > 0) reasons.push('先结束当前捕兽。');
  if (activities.sites > 0) reasons.push('先从山河舆图撤回全部灵地。');
  if (activities.auction > 0) reasons.push('先处理拍卖中的物品与竞价，并领取所有成交或流拍物品。');
  if (activities.holdings > 0) reasons.push('先卖出全部灵股持仓。');
  if (activities.orders > 0) reasons.push('先撤销或等待完成全部灵股挂单。');
  if (activities.margin > 0) reasons.push('先平掉全部保证金合约仓位。');
  if (activities.races > 0) reasons.push('先等待已投注的灵兽竞逐结算。');
  return reasons;
}
export const REBIRTH_RETAINED = [
  '全部弟子及其姓名、基础属性、天赋、洗髓/淬体/培元次数、悟道加点',
  '全部建筑及等级；弟子容量至少 64 人、建筑容量至少 8 座',
  '功法等级、残卷、弟子主修功法与熟练度、装备、灵兽与图鉴、丹药',
  '成就、主线、签到进度、声望、头像框、称号、改名令、道韵及所有永久加成',
  '当日招募、挑战、赌坊、讨伐等次数；转生不会额外补充额度',
];
export const REBIRTH_RESET = [
  '宗门等级回到一级，全部弟子回到炼气一层，修为及修为余数归零',
  '全部弟子的成仙状态和飞升保底归零，之后需要重新渡劫飞升',
  '全部资源余额（含御兽精魄、功勋）保留 30%，小数舍去；产出余数归零',
  '弟子岗位回到闲置，清除伤势、捕兽占用和执事交接期；执事职位全部空缺',
  '关闭自动讨伐，清空守擂阵容及当日大比报名',
];
export interface RebirthShopDefinition {
  id:string;name:string;cost:number;description:string;limit:number;
  bonus?:keyof RebirthBonuses;
  cosmetic?:{id:string;name:string;kind:'frame'|'title'};
}
export const REBIRTH_SHOP:readonly RebirthShopDefinition[]=[
  {id:'frame-astral',name:'星河开界头像框',cost:50,limit:1,description:'永久解锁宗门头像框「星河开界」，可在宗门成长中佩戴。',cosmetic:{id:'frame-astral',name:'星河开界',kind:'frame'}},
  {id:'title-worldwalker',name:'开界行者称号',cost:50,limit:1,description:'永久解锁宗门称号「开界行者」，可在宗门成长中佩戴。',cosmetic:{id:'title-worldwalker',name:'开界行者',kind:'title'}},
  {id:'bonus-production',name:'道韵·丰饶',cost:100,limit:5,description:'永久全资源产出 +1%，与转生加成相加，最多兑换五次。',bonus:'productionBp'},
  {id:'bonus-breakthrough',name:'道韵·悟道',cost:100,limit:5,description:'永久突破成功率 +1%，仍受当前成功率上限约束，最多兑换五次。',bonus:'breakthroughBp'},
  {id:'bonus-power',name:'道韵·神武',cost:100,limit:5,description:'永久全弟子战力 +1%，与转生加成相加，最多兑换五次。',bonus:'powerBp'},
];
export function rebirthShopViews(daoYun:number,purchased:ReadonlyMap<string,number>):RebirthShopItem[] {
  return REBIRTH_SHOP.map(item=>{
    const count=purchased.get(item.id)??0;
    const reason=count>=item.limit?'已达到兑换上限':daoYun<item.cost?'道韵不足':null;
    return {id:item.id,name:item.name,cost:item.cost,description:item.description,limit:item.limit,purchased:count,canBuy:reason===null,blockedReason:reason};
  });
}
