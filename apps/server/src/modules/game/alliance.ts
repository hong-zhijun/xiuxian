import { z } from 'zod';
import type { ProgressionReward } from '@xiuxian/contracts';
import { dateKeyUtc8 } from './constants';
export const ALLIANCE_CREATE_COST=1000;
export const ALLIANCE_MIN_MEMBERS=3;
export const ALLIANCE_MAX_MEMBERS=5;
export const ALLIANCE_BOSS_HP=1_000_000;
export const ALLIANCE_DAILY_ATTACKS=3;
export const ALLIANCE_INVITE_MS=7*86_400_000;
export const ALLIANCE_LEAVE_COOLDOWN_MS=86_400_000;
export const ALLIANCE_CHAT_COOLDOWN_MS=5000;
const command={commandId:z.uuid()};
export const allianceActionSchema=z.discriminatedUnion('action',[
  z.strictObject({...command,action:z.literal('create'),name:z.string().max(64)}),
  z.strictObject({...command,action:z.literal('invite'),sectId:z.string().min(1).max(64)}),
  z.strictObject({...command,action:z.literal('accept'),inviteId:z.uuid()}),
  z.strictObject({...command,action:z.literal('leave')}),z.strictObject({...command,action:z.literal('disband')}),
  z.strictObject({...command,action:z.literal('transfer'),sectId:z.string().min(1).max(64)}),
  z.strictObject({...command,action:z.literal('kick'),sectId:z.string().min(1).max(64)}),
  z.strictObject({...command,action:z.literal('attack'),discipleIds:z.array(z.uuid()).min(1).max(3).refine(ids=>new Set(ids).size===ids.length,'弟子不能重复')}),
  z.strictObject({...command,action:z.literal('buy'),id:z.string().min(1).max(64)}),
]);
export const allianceChatSchema=z.strictObject({...command,allianceId:z.uuid(),content:z.string().min(1).max(200)});
export const allianceChatQuerySchema=z.strictObject({allianceId:z.uuid()});
export function allianceWeek(now:number):{key:string;startsAt:number;endsAt:number} {
  const key=dateKeyUtc8(now),midnight=Date.parse(`${key}T00:00:00+08:00`);
  const weekday=(new Date(midnight+8*3_600_000).getUTCDay()+6)%7;
  const startsAt=midnight-weekday*86_400_000;
  return {key:dateKeyUtc8(startsAt),startsAt,endsAt:startsAt+7*86_400_000};
}
export function allianceBossDamage(powers:readonly number[],remainingHp:number):number {
  return Math.min(remainingHp,Math.max(1,powers.reduce((sum,power)=>sum+Math.max(0,Math.floor(power)),0)*100));
}
export function allianceMerit(rank:number):number {
  return [300,200,150,100,100][rank-1]??0;
}
export function normalizedAllianceName(value:string):string|null {
  const name=value.trim();
  return [...name].length>=2&&[...name].length<=12&&!/[\r\n\u0000-\u001f\u007f]/u.test(name)?name:null;
}
export const ALLIANCE_SHOP:readonly {id:string;name:string;cost:number;reward:ProgressionReward}[]=[
  {id:'tian-scroll',name:'天阶功法残卷 ×1',cost:200,reward:{scrolls:{tier:'tian',quantity:1},description:'随机天阶功法残卷 ×1，可在藏经阁使用'}},
  {id:'xuantie-10',name:'玄铁 ×10',cost:100,reward:{resources:{xuantie:'10000'},description:'玄铁 ×10'}},
  {id:'shenmu-5',name:'神木 ×5',cost:100,reward:{resources:{shenmu:'5000'},description:'神木 ×5'}},
  {id:'frame-alliance',name:'同盟之光头像框',cost:500,reward:{cosmetic:{id:'frame-alliance',name:'同盟之光',kind:'frame'},description:'永久头像框「同盟之光」，可在宗门成长中佩戴'}},
];
