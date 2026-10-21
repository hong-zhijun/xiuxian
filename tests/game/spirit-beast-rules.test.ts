import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { BEAST_SPECIES, BEAST_AREAS, BEAST_QUALITY_ORDER, BEAST_EXCHANGE_RULES, beastMods, beastAttributes, beastLevelFactor, beastPowerBonusBp, beastPowerBonusBpOf, beastReleaseReward, beastBreakthroughCost, wildBeastAttributes, exchangeSpecies, captureRate, encounterQuality, encounterSpecies } from '../../apps/server/src/modules/game/spiritBeasts';
import type { BeastQuality } from '@xiuxian/contracts';
import { ELEMENTS, elementFactor } from '../../apps/server/src/modules/game/elements';
import { makeCaptureFighter, stepCapture, type CaptureData } from '../../apps/server/src/modules/game/beastCapture';
import { beastDefend, freshBeastState } from '../../apps/server/src/modules/game/beastCombat';
import { simulateArenaDuel } from '../../apps/server/src/modules/game/arena';
import { simulateTowerBattle } from '../../apps/server/src/modules/game/tower';
import { techniqueModifiersOf } from '../../apps/server/src/modules/game/techniques';

const mods=(speciesId:string)=>beastMods({speciesId,quality:'common',level:1});
function encounter():CaptureData {
  return {areaId:'foothills',speciesId:'claw_tiger',quality:'common',tier:'spirit',round:0,attempts:0,logs:[],caughtId:null,
    player:makeCaptureFighter({name:'弟子',power:500,attack:100,defense:100,speed:100,luck:50,physique:100,beast:mods('vermilion_bird'),technique:techniqueModifiersOf({techniqueId:'taiyi',level:10,proficiencyBp:10000})!}),
    target:makeCaptureFighter({name:'野兽',power:10,attack:1,defense:1,speed:1,luck:1,physique:1,beast:mods('claw_tiger')})};
}
describe('灵兽纯规则',()=>{
  it('新成长按最终值取整，野生预算保留原数值',()=>{
    for(const species of BEAST_SPECIES) {
      const tierIndex={spirit:0,rare:1,divine:2}[species.tier];
      const sorted=(attrs:ReturnType<typeof beastAttributes>)=>Object.values(attrs).filter(v=>v>0).sort((a,b)=>b-a);
      expect(sorted(beastAttributes({speciesId:species.id,quality:'common',level:1}))).toEqual([[7,2],[10,3],[14,4]][tierIndex]);
      expect(sorted(beastAttributes({speciesId:species.id,quality:'immortal',level:20}))).toEqual([[23,6],[34,10],[47,13]][tierIndex]);
      expect(sorted(wildBeastAttributes(species.id))).toEqual([[6,2],[9,3],[12,4]][tierIndex]);
      const first=beastAttributes({speciesId:species.id,quality:'common',level:1}),wild=wildBeastAttributes(species.id);
      for(const key of Object.keys(first) as (keyof typeof first)[])expect(first[key]>0).toBe(wild[key]>0);
    }
    expect(beastMods({speciesId:'claw_tiger',quality:'common',level:20}).first).toBeCloseTo(.2*1.57);
  });
  it('枚举所有兑换、突破、放生路径，都不能增加精魄',()=>{
    for(const species of BEAST_SPECIES) {
      const multiplier={spirit:1,rare:3,divine:10}[species.tier];
      for(const [index,quality] of BEAST_QUALITY_ORDER.entries()) {
        expect(beastReleaseReward({speciesId:species.id,quality})).toBe([1,3,8,20][index]!*multiplier*1000);
      }
      for(const mode of ['randomCost','specificCost'] as const) {
        let spent=BEAST_EXCHANGE_RULES[species.tier][mode];
        for(const quality of BEAST_QUALITY_ORDER) {
          const beast={speciesId:species.id,quality};
          expect(beastReleaseReward(beast)).toBeLessThan(spent);
          const quote=beastBreakthroughCost(beast);
          if(quote) {
            expect(Number(quote.cost.beastEssence)).toBe([4,10,25][BEAST_QUALITY_ORDER.indexOf(quality)]!*multiplier*1000);
            expect(Number(quote.cost.beastEssence)).toBeGreaterThan(beastReleaseReward({...beast,quality:quote.nextQuality})-beastReleaseReward(beast));
            spent+=Number(quote.cost.beastEssence);
          } else expect(quality).toBe('immortal');
        }
      }
    }
  });
  it('兑换同档物种等概率，随机边界合法且不受野外权重影响',()=>{
    for(const tier of ['spirit','rare','divine'] as const) {
      const pool=BEAST_SPECIES.filter(s=>s.tier===tier);
      for(let i=0;i<pool.length;i++)expect(exchangeSpecies(tier,()=>(i+.5)/pool.length).id).toBe(pool[i]!.id);
      expect(exchangeSpecies(tier,()=>0).id).toBe(pool[0]!.id);
      expect(exchangeSpecies(tier,()=>.999999).id).toBe(pool.at(-1)!.id);
    }
  });
  it('十二物种、三档，五行均有入门和神兽',()=>{
    expect(BEAST_SPECIES).toHaveLength(12);expect(new Set(BEAST_SPECIES.map(b=>b.id)).size).toBe(12);
    for(const e of ELEMENTS)for(const tier of ['spirit','divine'])expect(BEAST_SPECIES.some(b=>b.element===e&&b.tier===tier)).toBe(true);
    for(const b of BEAST_SPECIES)expect(Object.values(b.attrs).filter(v=>v>0)).toHaveLength(2);
  });
  it('五行完整矩阵：五组克制、五组反克、无属性中性',()=>{
    const matrix=ELEMENTS.flatMap(a=>ELEMENTS.map(b=>elementFactor(a,b)));
    expect(matrix.filter(v=>v===1.15)).toHaveLength(5);expect(matrix.filter(v=>v===.85)).toHaveLength(5);
    expect(elementFactor('water','fire')).toBe(1.15);expect(elementFactor('fire','water')).toBe(.85);
    for(const e of ELEMENTS){expect(elementFactor(e,e)).toBe(1);expect(elementFactor(e,null)).toBe(1);expect(elementFactor(null,e)).toBe(1);}
  });
  it('成长只放大数值，概率、免疫和必暴固定',()=>{
    const high=beastMods({speciesId:'three_tail_fox',quality:'immortal',level:20});expect(high.procChance).toBe(.2);expect(high.proc).toBeGreaterThan(mods('three_tail_fox').proc);
    expect(beastMods({speciesId:'white_tiger',quality:'immortal',level:20}).firstCrit).toBe(true);
    expect(beastMods({speciesId:'green_qilin',quality:'immortal',level:20}).poisonImmune).toBe(true);
    expect(beastAttributes({speciesId:'claw_tiger',quality:'common',level:1}).attack).toBe(7);
  });
  it('幸运和削弱提高收服率，概率有界且不解锁区域外物种',()=>{
    const low=captureRate('rare',100,100,100,100,20),high=captureRate('rare',100,100,100,100,100);
    expect(high).toBeGreaterThan(low);expect(captureRate('rare',1,100,100,100,100)).toBeGreaterThan(high);
    expect(captureRate('divine',1,100,10000,1,99999)).toBeLessThanOrEqual(.9);
    for(let i=0;i<100;i++)expect(encounterSpecies(BEAST_AREAS[0].speciesIds,100,()=>i/100).tier).toBe('spirit');
    expect(encounterQuality(()=>0)).toBe('common');expect(encounterQuality(()=>.999)).toBe('immortal');
  });
  it('留手覆盖剑气、追击、离火，原状态不可变',()=>{
    const d=encounter(),before=structuredClone(d),r=stepCapture(d,'restrain',()=>0);
    expect(r.data.target.hp).toBe(1);expect(r.status).toBe('active');expect(d).toEqual(before);
  });
  it('普通攻击允许击杀，收服成功不触发反击',()=>{
    expect(stepCapture(encounter(),'attack',()=>0).status).toBe('killed');
    const d=encounter(),r=stepCapture(d,'capture',()=>0);expect(r.status).toBe('caught');expect(r.data.player.hp).toBe(d.player.hp);
  });
  it('最多五次收服，离开不攻击',()=>{
    const d=encounter();d.attempts=4;expect(stepCapture(d,'capture',()=>.999).status).toBe('escaped');
    expect(stepCapture(d,'leave',()=>{throw Error('must not roll');}).data.player.hp).toBe(d.player.hp);
  });
  it('护盾仅触发一次，不复活，吸收伤害',()=>{
    const state=freshBeastState(),m=mods('mountain_turtle');
    beastDefend(m,state,70,100,100);expect(state.shield).toBe(10);
    expect(beastDefend(m,state,8,30,100).damage).toBe(0);expect(state.shield).toBe(2);
    beastDefend(m,state,20,30,100);expect(state.shield).toBe(0);
    const dead=freshBeastState();beastDefend(m,dead,200,100,100);expect(dead.shield).toBe(0);
  });
  it('白虎首击必暴；狐火不以剑气追加伤害为基数',()=>{
    const a={id:'a',name:'甲',power:100,attack:50,defense:50,speed:50,luck:0,physique:50};
    const b={...a,id:'b',name:'乙',power:10000};
    expect(simulateArenaDuel({fighterA:{...a,beast:mods('white_tiger')},fighterB:b,random:()=>.99}).rounds[0]!.hits[0]!.crit).toBe(true);
    const technique=techniqueModifiersOf({techniqueId:'taiyi',level:1,proficiencyBp:10000})!;
    const base=simulateArenaDuel({fighterA:a,fighterB:b,random:()=>0}).rounds[0]!.hits[0]!.damage;
    const damage=simulateArenaDuel({fighterA:{...a,technique,beast:mods('three_tail_fox')},fighterB:b,random:()=>0}).rounds[0]!.hits[0]!.damage;
    expect(damage).toBe(base+Math.floor(base*.5)+Math.floor(base*.3));
  });
  it('镇妖塔实际应用猛袭和五行，不只是战报标签',()=>{
    const f={id:'a',name:'甲',power:1000,attack:50,defense:50,speed:50,luck:0,physique:50,critBonusBp:0,damageReductionBp:0};
    const base=simulateTowerBattle({floor:2,fighters:[f],arenaLevel:0,random:()=>.5});
    const boosted=simulateTowerBattle({floor:2,fighters:[{...f,beast:mods('claw_tiger')}],arenaLevel:0,random:()=>.5});
    expect(boosted.rounds[0]!.hits[0]!.damage).toBeGreaterThan(base.rounds[0]!.hits[0]!.damage*1.35);
  });
  it('十二张立绘与头像已随前端静态资源接入',()=>{
    const publicDir=fileURLToPath(new URL('../../apps/web/public',import.meta.url));
    for(const beast of BEAST_SPECIES) {
      expect(beast.image).toBe(`/images/spirit-beasts/${beast.id}-v1.webp`);
      expect(beast.avatar).toBe(`/images/spirit-beasts/${beast.id}-v1-avatar.webp`);
      expect(existsSync(join(publicDir,beast.image!))).toBe(true);
      expect(existsSync(join(publicDir,beast.avatar!))).toBe(true);
    }
  });
  it('战力档位按突破增量累进：抓到即得 1/2/3%，满配 7/12/18%，等级满 20 才吃满',()=>{
    const at=(speciesId:string,quality:BeastQuality,level:number)=>beastPowerBonusBp({speciesId,quality,level});
    // 抓到即得：品阶越高，白拿的越多（灵兽 1% / 珍兽 2% / 神兽 3%）。
    expect(at('claw_tiger','common',20)).toBe(100);
    expect(at('three_tail_fox','common',20)).toBe(200);
    expect(at('white_tiger','common',20)).toBe(300);
    // 每次突破的增量：神兽 +4 / +5 / +6，累计 3 / 7 / 12 / 18。
    expect(at('white_tiger','spirit',20)).toBe(700);
    expect(at('white_tiger','treasure',20)).toBe(1200);
    expect(at('white_tiger','immortal',20)).toBe(1800);
    // 灵兽 / 珍兽的天花板 7% / 12%（只压「抓到即得」，满配没动）。
    expect(at('claw_tiger','immortal',20)).toBe(700);
    expect(at('three_tail_fox','immortal',20)).toBe(1200);
    // 等级系数：1 级吃一半，20 级吃满，中间线性。
    expect(at('white_tiger','immortal',1)).toBe(900);
    expect(at('white_tiger','immortal',10)).toBe(1326);
    expect(beastLevelFactor(1)).toBe(.5);
    expect(beastLevelFactor(20)).toBe(1);
    // 身份不合法（物种 id 不存在）时按 0，不抛错。
    expect(at('not_a_beast','immortal',20)).toBe(0);
  });
  it('未携带 / 非法 beast_json 的弟子，灵兽战力加成按 0 算',()=>{
    expect(beastPowerBonusBpOf({beast_json:null})).toBe(0);
    expect(beastPowerBonusBpOf({})).toBe(0);
    expect(beastPowerBonusBpOf({beast_json:'{"speciesId":"nope","quality":"immortal","level":20}'})).toBe(0);
    expect(beastPowerBonusBpOf({beast_json:JSON.stringify({speciesId:'white_tiger',quality:'immortal',level:20})})).toBe(1800);
  });
});
