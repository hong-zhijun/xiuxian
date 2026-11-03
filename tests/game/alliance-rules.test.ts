import { describe, expect, it } from 'vitest';
import { ALLIANCE_BOSS_HP, ALLIANCE_CREATE_COST, ALLIANCE_DAILY_ATTACKS, ALLIANCE_INVITE_MS, ALLIANCE_LEAVE_COOLDOWN_MS, ALLIANCE_MAX_MEMBERS, ALLIANCE_MIN_MEMBERS, ALLIANCE_SHOP, allianceActionSchema, allianceBossDamage, allianceChatQuerySchema, allianceChatSchema, allianceMerit, allianceWeek, normalizedAllianceName } from '../../apps/server/src/modules/game/alliance';

describe('仙盟协作规则',()=>{
  it('创建与成员边界保持规划3至5宗门，邀请七天、退盟24小时',()=>{
    expect(ALLIANCE_CREATE_COST).toBe(1000);
    expect(ALLIANCE_MIN_MEMBERS).toBe(3);
    expect(ALLIANCE_MAX_MEMBERS).toBe(5);
    expect(ALLIANCE_INVITE_MS).toBe(7*86_400_000);
    expect(ALLIANCE_LEAVE_COOLDOWN_MS).toBe(86_400_000);
  });
  it('仙盟名称按Unicode码点计算，拒绝单行控制字符和过长名',()=>{
    expect(normalizedAllianceName('  星河盟  ')).toBe('星河盟');
    expect(normalizedAllianceName('𠀀𠀀')).toBe('𠀀𠀀');
    expect(normalizedAllianceName('a')).toBeNull();
    expect(normalizedAllianceName('甲'.repeat(13))).toBeNull();
    expect(normalizedAllianceName('甲\n乙')).toBeNull();
    expect(normalizedAllianceName('甲\u0000乙')).toBeNull();
  });
  it('周一UTC8零点切周，跨年周归属稳定且精确持续七天',()=>{
    const before=allianceWeek(Date.parse('2026-11-01T15:59:59Z'));
    const after=allianceWeek(Date.parse('2026-11-01T16:00:00Z'));
    expect(before.key).toBe('2026-10-26');
    expect(after.key).toBe('2026-11-02');
    expect(after.startsAt).toBe(Date.parse('2026-11-02T00:00:00+08:00'));
    expect(after.endsAt-after.startsAt).toBe(7*86_400_000);
    expect(allianceWeek(Date.parse('2027-01-01T12:00:00+08:00')).key).toBe('2026-12-28');
  });
  it('盟BOSS100万HP、每日三次、伤害按3名弟子战力乘100且夹剩余HP',()=>{
    expect(ALLIANCE_BOSS_HP).toBe(1_000_000);
    expect(ALLIANCE_DAILY_ATTACKS).toBe(3);
    expect(allianceBossDamage([10,20,30],1_000_000)).toBe(6000);
    expect(allianceBossDamage([100,200,300],17)).toBe(17);
    expect(allianceBossDamage([10.9,20.9],1_000_000)).toBe(3000);
    expect(allianceBossDamage([10],0)).toBe(0);
  });
  it('参与者排名奖励300/200/150/100/100，未参战与越界不奖励',()=>{
    expect([1,2,3,4,5].map(allianceMerit)).toEqual([300,200,150,100,100]);
    expect(allianceMerit(0)).toBe(0);
    expect(allianceMerit(6)).toBe(0);
  });
  it('盟贡商品真实发残卷/材料/外观，成本与规划一致',()=>{
    expect(ALLIANCE_SHOP.map(item=>[item.id,item.cost])).toEqual([['tian-scroll',200],['xuantie-10',100],['shenmu-5',100],['frame-alliance',500]]);
    expect(ALLIANCE_SHOP[0]?.reward.scrolls).toEqual({tier:'tian',quantity:1});
    expect(ALLIANCE_SHOP[1]?.reward.resources).toEqual({xuantie:'10000'});
    expect(ALLIANCE_SHOP[2]?.reward.resources).toEqual({shenmu:'5000'});
    expect(ALLIANCE_SHOP[3]?.reward.cosmetic).toMatchObject({id:'frame-alliance',kind:'frame'});
  });
  it('请求schema只允许1至3名不同弟子、明确commandId，拒绝伪造余额与成员',()=>{
    const commandId='00000000-0000-4000-8000-000000000001',disciple='00000000-0000-4000-8000-000000000002';
    expect(allianceActionSchema.safeParse({action:'create',name:'星河盟',commandId}).success).toBe(true);
    expect(allianceActionSchema.safeParse({action:'attack',discipleIds:[disciple],commandId}).success).toBe(true);
    expect(allianceActionSchema.safeParse({action:'attack',discipleIds:[],commandId}).success).toBe(false);
    expect(allianceActionSchema.safeParse({action:'attack',discipleIds:[disciple,disciple],commandId}).success).toBe(false);
    expect(allianceActionSchema.safeParse({action:'buy',id:'tian-scroll',merit:10000,commandId}).success).toBe(false);
    expect(allianceActionSchema.safeParse({action:'leave'}).success).toBe(false);
  });
  it('聊天必须明确目标仙盟且严格拒绝其他scope与伪造sender',()=>{
    const allianceId='00000000-0000-4000-8000-000000000001',commandId='00000000-0000-4000-8000-000000000002';
    expect(allianceChatQuerySchema.safeParse({allianceId}).success).toBe(true);
    expect(allianceChatQuerySchema.safeParse({}).success).toBe(false);
    expect(allianceChatSchema.safeParse({allianceId,commandId,content:'大家好'}).success).toBe(true);
    expect(allianceChatSchema.safeParse({commandId,content:'大家好'}).success).toBe(false);
    expect(allianceChatSchema.safeParse({allianceId,commandId,content:'大家好',scope_id:'other'}).success).toBe(false);
    expect(allianceChatSchema.safeParse({allianceId,commandId,content:'大家好',userId:'fake'}).success).toBe(false);
  });
});
