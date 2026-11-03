import { describe, expect, it } from 'vitest';
import { REBIRTH_BONUSES, REBIRTH_BUILDING_CAPACITY, REBIRTH_DAO_YUN, REBIRTH_DISCIPLE_CAPACITY, REBIRTH_RESET, REBIRTH_RETAINED, REBIRTH_SHOP, nextRebirthBonuses, rebirthActionSchema, rebirthBlockedReasons, rebirthRetainedAmount, rebirthShopViews, type RebirthActivities } from '../../apps/server/src/modules/game/rebirth';

const none:RebirthActivities={journeys:0,exploration:0,captures:0,sites:0,auction:0,holdings:0,orders:0,margin:0,races:0};

describe('转生资源、资格与保留规则',()=>{
  it('每项资源精确保留30%，小数舍去，安全整数上界不经浮点乘法',()=>{
    for(const n of [0,1,2,3,9,10,11,999,1000,20_000_001,Number.MAX_SAFE_INTEGER]) {
      expect(rebirthRetainedAmount(n)).toBe(Number(BigInt(n)*3n/10n));
    }
    expect(rebirthRetainedAmount(1009)).toBe(302);
    expect(()=>rebirthRetainedAmount(-1)).toThrow();
    expect(()=>rebirthRetainedAmount(1.5)).toThrow();
    expect(()=>rebirthRetainedAmount(Number.MAX_SAFE_INTEGER+1)).toThrow();
  });
  it('十五级且有成仙弟子才能转生，原规划三项加成和道韵一次发放',()=>{
    expect(rebirthBlockedReasons(15,1,none)).toEqual([]);
    expect(rebirthBlockedReasons(14,1,none)).toHaveLength(1);
    expect(rebirthBlockedReasons(15,0,none)).toHaveLength(1);
    expect(rebirthBlockedReasons(1,0,none)).toHaveLength(2);
    expect(REBIRTH_DAO_YUN).toBe(100);
    expect(REBIRTH_BONUSES).toEqual({productionBp:1000,breakthroughBp:500,powerBp:500});
    expect(nextRebirthBonuses({productionBp:1100,breakthroughBp:700,powerBp:600})).toEqual({productionBp:2100,breakthroughBp:1200,powerBp:1100});
  });
  it('每种仍在进行或托管的活动都给出可执行处理指引',()=>{
    const labels:Record<keyof RebirthActivities,string>={journeys:'历练',exploration:'秘境',captures:'捕兽',sites:'灵地',auction:'拍卖',holdings:'持仓',orders:'挂单',margin:'合约',races:'竞逐'};
    for(const [key,label] of Object.entries(labels))expect(rebirthBlockedReasons(15,1,{...none,[key]:1})).toEqual([expect.stringContaining(label)]);
  });
  it('保留容量64人8建筑、物品与每日额度，明确重置成仙、岗位与伤势',()=>{
    expect(REBIRTH_DISCIPLE_CAPACITY).toBe(64);
    expect(REBIRTH_BUILDING_CAPACITY).toBe(8);
    expect(REBIRTH_RETAINED.join('')).toContain('装备');
    expect(REBIRTH_RETAINED.join('')).toContain('丹药');
    expect(REBIRTH_RETAINED.join('')).toContain('不会额外补充额度');
    expect(REBIRTH_RESET.join('')).toContain('飞升保底归零');
    expect(REBIRTH_RESET.join('')).toContain('御兽精魄、功勋');
    expect(REBIRTH_RESET.join('')).toContain('岗位回到闲置');
  });
});

describe('道韵商店与请求协议',()=>{
  it('外观50道韵一次性，三类永久加成100道韵最多五次',()=>{
    expect(REBIRTH_SHOP.map(item=>[item.id,item.cost,item.limit])).toEqual([
      ['frame-astral',50,1],['title-worldwalker',50,1],['bonus-production',100,5],['bonus-breakthrough',100,5],['bonus-power',100,5],
    ]);
    expect(REBIRTH_SHOP[1]?.cosmetic).toEqual({id:'title-worldwalker',name:'开界行者',kind:'title'});
    expect(REBIRTH_SHOP.filter(item=>item.bonus).map(item=>item.bonus)).toEqual(['productionBp','breakthroughBp','powerBp']);
  });
  it('按道韵余额与限购次数判断可兑换，不把过期购买数量重置',()=>{
    const empty=rebirthShopViews(49,new Map());
    expect(empty.every(item=>!item.canBuy)).toBe(true);
    const rich=rebirthShopViews(1000,new Map([['frame-astral',1],['bonus-power',5]]));
    expect(rich.find(item=>item.id==='frame-astral')).toMatchObject({canBuy:false,purchased:1});
    expect(rich.find(item=>item.id==='bonus-power')).toMatchObject({canBuy:false,purchased:5});
    expect(rich.find(item=>item.id==='bonus-production')).toMatchObject({canBuy:true,purchased:0});
    expect(rebirthShopViews(100,new Map([['bonus-power',4]])).find(item=>item.id==='bonus-power')?.canBuy).toBe(true);
  });
  it('严格校验命令ID、version与payload，不能伪造价格或跳过版本',()=>{
    const commandId='00000000-0000-4000-8000-000000000001';
    expect(rebirthActionSchema.safeParse({action:'rebirth',commandId,expectedVersion:0}).success).toBe(true);
    expect(rebirthActionSchema.safeParse({action:'buy',id:'bonus-power',commandId,expectedVersion:1}).success).toBe(true);
    for(const payload of [
      {action:'rebirth',commandId},
      {action:'rebirth',commandId,expectedVersion:-1},
      {action:'rebirth',commandId,expectedVersion:1.5},
      {action:'buy',id:'bonus-power',commandId,expectedVersion:0,cost:0},
      {action:'buy',id:'',commandId,expectedVersion:0},
      {action:'rebirth',commandId:'bad',expectedVersion:0},
    ])expect(rebirthActionSchema.safeParse(payload).success).toBe(false);
  });
});
