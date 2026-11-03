import { describe, expect, it } from 'vitest';
import { ACHIEVEMENTS, CHECKIN_PILLS, CHECKIN_REWARDS, MAKEUP_COST, QUESTS, REPUTATION_SHOP, achievementReward, achievementViews, activeShopFrame, checkinReward, checkinView, progressionActionSchema, questViews, reputationShopViews, type CheckinRow, type ProgressionFacts } from '../../apps/server/src/modules/game/progression';

const at = (value: string) => Date.parse(value);
const now = at('2026-11-03T08:00:00+08:00');
const row = (last: string, streak = 1, overrides: Partial<CheckinRow> = {}): CheckinRow => ({sect_id:'s',streak,month_key:'2026-11',total_days:streak,last_checkin_date:last,makeup_used:0,version:0,created_at:0,updated_at:0,...overrides});
const facts = (overrides: Partial<ProgressionFacts> = {}): ProgressionFacts => ({sectLevel:1,disciples:1,realmIndex:0,ascended:0,tower:0,bossDamage:0,champion:0,collection:0,immortalBeast:0,techniques:0,auctions:0,meteorJackpot:0,stockProfit:0,ancestral:0,tribute:0,created:1,assigned:0,breakthrough:0,alchemy:0,forge:0,explorations:0,challenges:0,bossHits:0,stockTrades:0,sites:0,...overrides});

describe('成长签到与补签规则', () => {
  it('七日循环逐项保留规划最小单位奖励，丹药直接进入现有可服用id', () => {
    expect(CHECKIN_REWARDS.map(reward => reward.resources ?? null)).toEqual([
      {spiritStone:'5000000'},{herb:'2000000'},{ore:'2000000'},{spiritualEnergy:'5000000'},null,{xuantie:'2000'},{shenmu:'1000',spiritStone:'20000000'},
    ]);
    expect(checkinReward(8,() => 0).resources).toEqual({spiritStone:'5000000'});
    expect(checkinReward(5,() => 0).pills).toEqual({healingPill:1});
    expect(checkinReward(5,() => 0.99999).pills).toEqual({aptitudePill:1});
    expect(CHECKIN_PILLS).toContain('talentPill');
  });
  it('每连续30天额外天阶残卷5张，与当日循环奖励叠加', () => {
    expect(checkinReward(30,() => 0)).toMatchObject({resources:{herb:'2000000'},scrolls:{tier:'tian',quantity:5}});
    expect(checkinReward(60,() => 0).scrolls).toEqual({tier:'tian',quantity:5});
    expect(checkinReward(29,() => 0).scrolls).toBeUndefined();
  });
  it('UTC8午夜前后日期、连续状态与跨月补签计数精确', () => {
    const old = row('2026-10-31',7,{month_key:'2026-10',makeup_used:3});
    const preview = checkinView(old,at('2026-10-31T16:00:00Z'),0,MAKEUP_COST);
    expect(preview).toMatchObject({dateKey:'2026-11-01',streak:7,nextDay:1,makeupUsed:0});
    expect(checkinView(old,at('2026-10-31T15:59:59Z'),0,MAKEUP_COST).checkedToday).toBe(true);
  });
  it('断签清零，按顺序补回相邻漏签日期后才签到', () => {
    const preview = checkinView(row('2026-10-31',9),now,0,MAKEUP_COST);
    expect(preview).toMatchObject({streak:0,nextDay:1,makeupDate:'2026-11-01',canMakeup:true});
    expect(checkinView(row('2026-11-01',10),now,0,MAKEUP_COST).makeupDate).toBe('2026-11-02');
    expect(checkinView(row('2026-11-02',11),now,0,MAKEUP_COST)).toMatchObject({streak:11,makeupDate:null,canMakeup:false});
  });
  it('每月最多3次、每次500灵石，不能补建宗前或今日签到后的日期', () => {
    expect(checkinView(row('2026-11-01',4,{makeup_used:3}),now,0,MAKEUP_COST).canMakeup).toBe(false);
    expect(checkinView(row('2026-11-01'),now,0,MAKEUP_COST-1).blockedReason).toContain('灵石 500');
    expect(checkinView(null,now,now,MAKEUP_COST).makeupDate).toBeNull();
    expect(checkinView(row('2026-11-03'),now,0,MAKEUP_COST).canMakeup).toBe(false);
  });
});

describe('完整成就、主线与声望奖励', () => {
  it('规划全部27项成就不遗漏且id唯一，三档奖励准确', () => {
    expect(ACHIEVEMENTS).toHaveLength(27);
    expect(new Set(ACHIEVEMENTS.map(a => a.id)).size).toBe(27);
    for (const item of ACHIEVEMENTS) {
      const reward = achievementReward(item);
      expect(reward.reputation).toBe(item.tier==='bronze'?50:item.tier==='silver'?150:500);
      if(item.tier==='bronze') expect(reward.resources).toEqual({spiritStone:'20000000'});
      if(item.tier==='silver') expect(reward.resources).toEqual({beastEssence:'50000'});
      if(item.tier==='gold') expect(reward.cosmetic).toMatchObject({kind:'frame',id:`achievement:${item.id}`});
    }
  });
  it('已领取成就不随可变角色数据退回；未达标不提前完成', () => {
    const views=achievementViews(facts(),new Set(['sect-15']));
    expect(views.find(a=>a.id==='sect-15')).toMatchObject({completed:true,claimed:true});
    expect(views.find(a=>a.id==='sect-5')).toMatchObject({completed:false,claimed:false,progress:1});
    expect(achievementViews(facts({bossDamage:1_000_000,collection:60}),new Set()).filter(a=>a.completed).map(a=>a.id)).toEqual(expect.arrayContaining(['boss-damage-1000000','collection-60']));
  });
  it('四章17步按章节领奖解锁，四份原规划奖励保持完整', () => {
    expect(QUESTS.map(chapter=>chapter.steps.length)).toEqual([5,4,4,4]);
    expect(QUESTS.map(chapter=>chapter.reward)).toEqual([
      {resources:{spiritStone:'10000000'},description:'灵石 10,000'},
      {resources:{xuantie:'5000'},description:'玄铁 ×5'},
      {resources:{shenmu:'3000'},description:'神木 ×3'},
      expect.objectContaining({equipmentBox:true}),
    ]);
    expect(questViews(facts(),new Set()).map(q=>q.unlocked)).toEqual([true,false,false,false]);
    expect(questViews(facts(),new Set(['kaishan'])).map(q=>q.unlocked)).toEqual([true,true,false,false]);
  });
  it('商店全部6类奖励可用、头像框300/500/800每月轮换、称号永久200bp只买一次', () => {
    const shop=reputationShopViews(10000,new Map(),now);
    expect(shop).toHaveLength(9);
    expect(shop.filter(s=>s.reward.cosmetic?.kind==='frame').filter(s=>s.canBuy).map(s=>s.id)).toEqual([activeShopFrame(now)]);
    expect(REPUTATION_SHOP.filter(s=>s.reward.cosmetic?.kind==='frame').map(s=>s.cost)).toEqual([300,500,800]);
    expect(shop.find(s=>s.id==='pill-talent')?.reward.pills).toEqual({talentPill:1});
    expect(shop.find(s=>s.id==='pill-aptitude')?.reward.pills).toEqual({aptitudePill:1});
    expect(shop.find(s=>s.id==='tian-scroll')?.reward.scrolls).toEqual({tier:'tian',quantity:1});
    expect(shop.find(s=>s.id==='rename-token')?.reward.renameToken).toBe(1);
    expect(reputationShopViews(10000,new Map([['title-rising-star',1]]),now).find(s=>s.id==='title-rising-star')?.blockedReason).toBe('已拥有');
    expect(reputationShopViews(99,new Map(),now).find(s=>s.id==='essence-10')?.canBuy).toBe(false);
  });
  it('严格schema拒绝额外字段、缺少commandId与非法动作，允许null卸外观', () => {
    const commandId='00000000-0000-4000-8000-000000000001';
    expect(progressionActionSchema.safeParse({action:'checkin',commandId}).success).toBe(true);
    expect(progressionActionSchema.safeParse({action:'set-title',id:null,commandId}).success).toBe(true);
    expect(progressionActionSchema.safeParse({action:'checkin',commandId,amount:1000}).success).toBe(false);
    expect(progressionActionSchema.safeParse({action:'checkin'}).success).toBe(false);
    expect(progressionActionSchema.safeParse({action:'grant-money',commandId}).success).toBe(false);
  });
});
