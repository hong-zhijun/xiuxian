import type { BeastCaptureAction } from '@xiuxian/contracts';
import type { TechniqueModifiers } from './techniques';
import type { BeastMods } from './spiritBeasts';
import { BEAST_RULES, captureRate } from './spiritBeasts';
import { elementFactor } from './elements';
import { beastDefend, freshBeastState, type BeastCombatState } from './beastCombat';

export interface CaptureFighter {
  name:string; power:number; attack:number; defense:number; speed:number; luck:number; physique:number;
  hp:number; maxHp:number; strikes:number; beast?:BeastMods; technique?:TechniqueModifiers;
  guard:BeastCombatState;
}
export interface CaptureData {
  areaId:string; speciesId:string; quality: import('@xiuxian/contracts').BeastQuality;
  player:CaptureFighter; target:CaptureFighter; tier:import('@xiuxian/contracts').BeastTier;
  round:number; attempts:number; logs:string[]; caughtId:string|null;
}
export function makeCaptureFighter(f:Omit<CaptureFighter,'hp'|'maxHp'|'strikes'|'guard'>):CaptureFighter {
  const mods=f.technique?.arena;
  const maxHp=Math.max(1,Math.floor(4.5*f.power*(.5+f.physique/100*(mods?.physiqueWeight??1))*(mods?.hpMultiplier??1)*(1+(f.beast?.hp??0))*100));
  return {...f,hp:maxHp,maxHp,strikes:0,guard:freshBeastState()};
}
export function captureChance(d:CaptureData) { return captureRate(d.tier,d.target.hp,d.target.maxHp,d.player.power,d.target.power,d.player.luck); }

function attack(a:CaptureFighter,b:CaptureFighter,round:number,restrain:boolean,random:()=>number,logs:string[]) {
  const m=a.technique?.arena, beast=a.beast;
  const cap=Math.min(.85,(m?.extraChanceMax??.3)+(beast?.extraCap??0));
  const chance=Math.min(cap,Math.max(0,(a.speed-b.speed)*.005)+(m?.extraChanceBonus??0)+(beast?.extra??0));
  const max=m?.maxStrikesPerAction??2;
  for(let i=0;i<max;i++) {
    if(i>0 && !(i===1 && round===1 && m?.round1GuaranteedExtra) && random()>=chance) break;
    const first=a.strikes++===0;
    const forced=first && (m?.firstStrikeCritMultiplier!=null || beast?.firstCrit);
    const crit=forced || random()<Math.min(1,a.luck/100*.2*(m?.critRateMultiplier??1));
    let multiplier=crit?((first?m?.firstStrikeCritMultiplier:null)??1.5)+(m?.critMultiplierBonus??0)+(beast?.crit??0):1;
    multiplier*=first?(m?.firstStrikeMultiplier??1)*(1+(beast?.first??0)):(m?.laterStrikeMultiplier??1);
    multiplier*=m?.strikeMultiplier??1;
    if(!crit) multiplier*=m?.nonCritMultiplier??1;
    multiplier*=round===1?(m?.round1Multiplier??1):1+(m?.roundGrowth??0)*(round-1);
    if(a.hp/a.maxHp<.35) {multiplier*=1+(beast?.low??0); if(m?.lowHpThreshold && a.hp/a.maxHp<m.lowHpThreshold) multiplier*=m.lowHpMultiplier;}
    const raw=a.power*(.75+.25*Math.min(2+(m?.attackCapBonus??0),a.attack/50))*(.8+random()*.4)*multiplier*100
      /(1+b.defense/100)*elementFactor(beast?.element,b.beast?.element)*(b.technique?.arena.damageTakenMultiplier??1);
    const base=Math.max(1,Math.floor(raw));
    let damage=base; const tags:string[]=[];
    if(m?.procChance && random()<m.procChance) {damage+=Math.floor(base*m.procRatio);tags.push(a.technique!.tag);}
    if(beast?.procChance && random()<beast.procChance) {damage+=Math.floor(base*beast.proc);tags.push(beast.skillName);}
    if(beast && ((first&&(beast.first||beast.firstCrit))||(crit&&beast.crit)||(a.hp/a.maxHp<.35&&beast.low))) tags.push(beast.skillName);
    const defended=beastDefend(b.beast,b.guard,damage,b.hp,b.maxHp);
    damage=Math.min(defended.damage,restrain?Math.max(0,b.hp-1):b.hp);
    b.hp-=damage;
    logs.push(`${a.name}${i?'追击':'出手'}${crit?'暴击':''}，造成 ${damage} 伤害${tags.length?'【'+tags.join('、')+'】':''}${defended.absorbed?'（护盾吸收 '+defended.absorbed+'）':''}${defended.tags.length?'【'+defended.tags.join('、')+'】':''}`);
    if(b.hp<=0) break;
  }
}
function heal(f:CaptureFighter,logs:string[]) {
  if(f.hp<=0) return;
  const amount=Math.min(f.maxHp-f.hp,Math.floor(f.maxHp*((f.technique?.arena.healRatio??0)+(f.beast?.heal??0))));
  if(amount>0) {f.hp+=amount;logs.push(`${f.name}回复 ${amount} 血量`);}
}
export function stepCapture(original:CaptureData,action:BeastCaptureAction,random:()=>number):{data:CaptureData;status:'active'|'caught'|'killed'|'escaped'|'defeated'|'left'} {
  const d=structuredClone(original); let status:'active'|'caught'|'killed'|'escaped'|'defeated'|'left'='active';
  if(action==='leave') {d.logs.push('弟子主动离开，本次搜寻结束。');return {data:d,status:'left'};}
  d.round++;
  if(action==='capture') {
    d.attempts++;
    if(random()<captureChance(d)) {d.logs.push('御兽术成功，灵兽已收服！');return {data:d,status:'caught'};}
    d.logs.push('御兽术未能收服目标。');
    if(d.attempts>=BEAST_RULES.maxAttempts || random()<.12) {d.logs.push('灵兽挣脱束缚，逃入山林。');return {data:d,status:'escaped'};}
  } else {
    attack(d.player,d.target,d.round,action==='restrain',random,d.logs);
    if(d.target.hp<=0) {d.logs.push('野生灵兽被击败，无法捕获。');return {data:d,status:'killed'};}
  }
  attack(d.target,d.player,d.round,false,random,d.logs);
  if(d.player.hp<=0) {d.logs.push('弟子败退，携带的灵兽安全归来。');status='defeated';}
  else {heal(d.player,d.logs);heal(d.target,d.logs);}
  if(status==='active'&&d.round>=BEAST_RULES.maxRounds) {d.logs.push('搜寻时间耗尽，目标离去。');status='escaped';}
  d.logs=d.logs.slice(-60);
  return {data:d,status};
}
