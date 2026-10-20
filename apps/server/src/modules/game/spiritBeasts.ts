import type { BeastAttrs, BeastIdentity, BeastQuality, BeastSpeciesView, BeastTier } from '@xiuxian/contracts';
import { ELEMENT_NAMES } from './elements';

export const BEAST_RULES = {
  unlockLevel: 3, capacity: 60, maxLevel: 20, dailyLimit: 20,
  maxRounds: 15, maxAttempts: 5, sessionMs: 30 * 60_000,
} as const;
export const BEAST_QUALITY = {
  common: { name: '凡品', attrs: 1, skill: 1, weight: 70 },
  spirit: { name: '灵品', attrs: 1.2, skill: 1.1, weight: 24 },
  treasure: { name: '宝品', attrs: 1.4, skill: 1.2, weight: 5 },
  immortal: { name: '仙品', attrs: 1.6, skill: 1.3, weight: 1 },
} as const;
export const BEAST_TIER_NAMES: Record<BeastTier, string> = { spirit: '灵兽', rare: '珍兽', divine: '神兽' };
export const EMPTY_BEAST_ATTRS: BeastAttrs = { attack: 0, defense: 0, speed: 0, luck: 0, physique: 0 };
type Definition = Omit<BeastSpeciesView, 'elementName' | 'tierName' | 'image' | 'avatar'>;
/** 立绘与头像随前端静态资源部署，路径由 species_id 与版本推导，不进数据库、不进接口存档。 */
export const BEAST_ART_VERSION = 'v1';
export const BEAST_ASSET_DIR = '/images/spirit-beasts';
export const beastArtPath = (speciesId: string): string => `${BEAST_ASSET_DIR}/${speciesId}-${BEAST_ART_VERSION}.webp`;
export const beastAvatarPath = (speciesId: string): string => `${BEAST_ASSET_DIR}/${speciesId}-${BEAST_ART_VERSION}-avatar.webp`;
function attrs(main: keyof BeastAttrs, sub: keyof BeastAttrs, value: number, small: number): BeastAttrs {
  return { ...EMPTY_BEAST_ATTRS, [main]: value, [sub]: small };
}
const DEFINITIONS: Definition[] = [
  { id: 'claw_tiger', name: '裂爪虎', tier: 'spirit', element: 'metal', glyph: '虎', attrs: attrs('attack','speed',6,2), skillName: '猛袭', skillText: '首次出手伤害 +{first}%' },
  { id: 'green_deer', name: '青角鹿', tier: 'spirit', element: 'wood', glyph: '鹿', attrs: attrs('physique','defense',6,2), skillName: '回春', skillText: '回合结束回复自身最大血量 {heal}%' },
  { id: 'frost_crane', name: '霜羽鹤', tier: 'spirit', element: 'water', glyph: '鹤', attrs: attrs('speed','defense',6,2), skillName: '霜衣', skillText: '首次受到的直接伤害 −{firstGuard}%' },
  { id: 'flame_wolf', name: '赤焰狼', tier: 'spirit', element: 'fire', glyph: '狼', attrs: attrs('attack','physique',6,2), skillName: '凶性', skillText: '血量低于 35% 时伤害 +{low}%' },
  { id: 'armored_turtle', name: '玄甲龟', tier: 'spirit', element: 'earth', glyph: '龟', attrs: attrs('defense','physique',6,2), skillName: '厚甲', skillText: '最大血量 +{hp}%' },
  { id: 'three_tail_fox', name: '三尾灵狐', tier: 'rare', element: 'fire', glyph: '狐', attrs: attrs('attack','luck',9,3), skillName: '狐火', skillText: '出手时 20% 概率追加直接伤害的 {proc}%' },
  { id: 'rock_rhino', name: '岩甲犀', tier: 'rare', element: 'earth', glyph: '犀', attrs: attrs('defense','physique',9,3), skillName: '磐身', skillText: '受到的直接伤害 −{guard}%' },
  { id: 'white_tiger', name: '庚金白虎', tier: 'divine', element: 'metal', glyph: '虎', attrs: attrs('attack','luck',12,4), skillName: '杀伐', skillText: '首次出手必定暴击；暴击伤害倍率 +{crit}' },
  { id: 'green_qilin', name: '青木麒麟', tier: 'divine', element: 'wood', glyph: '麟', attrs: attrs('physique','defense',12,4), skillName: '生生不息', skillText: '回合结束回复自身最大血量 {heal}%；免疫自身剧毒' },
  { id: 'water_dragon', name: '玄水蛟龙', tier: 'divine', element: 'water', glyph: '蛟', attrs: attrs('speed','attack',12,4), skillName: '游龙', skillText: '追击概率 +{extra} 个百分点，概率上限 +{extraCap} 个百分点' },
  { id: 'vermilion_bird', name: '离火朱雀', tier: 'divine', element: 'fire', glyph: '雀', attrs: attrs('attack','luck',12,4), skillName: '离火', skillText: '出手时 25% 概率追加直接伤害的 {proc}%' },
  { id: 'mountain_turtle', name: '镇岳龙龟', tier: 'divine', element: 'earth', glyph: '龟', attrs: attrs('defense','physique',12,4), skillName: '镇岳', skillText: '最大血量 +{hp}%；首次低于 35% 且存活时获得最大血量 {shield}% 护盾（每场一次）' },
];
export const BEAST_AREAS = [
  { id: 'foothills', name: '青岚山麓', description: '五行灵兽栖息之地，适合初次御兽。', requiredSectLevel: 3, cost: 20_000, strength: 35, speciesIds: DEFINITIONS.slice(0,5).map(b=>b.id) },
  { id: 'mist_valley', name: '云雾深谷', description: '深入山谷，寻找灵狐与岩犀的踪迹。', requiredSectLevel: 5, cost: 60_000, strength: 95, speciesIds: DEFINITIONS.slice(0,7).map(b=>b.id) },
  { id: 'ancient_realm', name: '太古遗境', description: '古老血脉沉睡于此，偶有神兽幼体现身。', requiredSectLevel: 7, cost: 150_000, strength: 180, speciesIds: DEFINITIONS.map(b=>b.id) },
] as const;
export interface BeastMods {
  element: BeastSpeciesView['element']; name: string; skillName: string;
  first: number; heal: number; firstGuard: number; low: number; hp: number;
  procChance: number; proc: number; guard: number; crit: number; firstCrit: boolean;
  extra: number; extraCap: number; poisonImmune: boolean; shield: number;
}
export function beastMods(beast: Pick<BeastIdentity,'speciesId'|'quality'|'level'>): BeastMods {
  const def = DEFINITIONS.find(b=>b.id===beast.speciesId);
  if (!def) throw new Error('Unknown spirit beast');
  const s = BEAST_QUALITY[beast.quality].skill * (1 + .025 * (Math.max(1,Math.min(20,beast.level))-1));
  const m: BeastMods = { element: def.element, name: def.name, skillName: def.skillName, first:0,heal:0,firstGuard:0,low:0,hp:0,procChance:0,proc:0,guard:0,crit:0,firstCrit:false,extra:0,extraCap:0,poisonImmune:false,shield:0 };
  switch(def.id) {
    case 'claw_tiger': m.first=.2*s; break;
    case 'green_deer': m.heal=.01*s; break;
    case 'frost_crane': m.firstGuard=Math.min(.5,.2*s); break;
    case 'flame_wolf': m.low=.15*s; break;
    case 'armored_turtle': m.hp=.08*s; break;
    case 'three_tail_fox': m.procChance=.2; m.proc=.3*s; break;
    case 'rock_rhino': m.guard=Math.min(.3,.05*s); break;
    case 'white_tiger': m.firstCrit=true; m.crit=.3*s; break;
    case 'green_qilin': m.heal=Math.min(.05,.02*s); m.poisonImmune=true; break;
    case 'water_dragon': m.extra=.08*s; m.extraCap=.1*s; break;
    case 'vermilion_bird': m.procChance=.25; m.proc=.5*s; break;
    case 'mountain_turtle': m.hp=.12*s; m.shield=.1*s; break;
  }
  return m;
}
export function beastAttributes(beast: Pick<BeastIdentity,'speciesId'|'quality'|'level'>): BeastAttrs {
  const def = DEFINITIONS.find(b=>b.id===beast.speciesId);
  if (!def) return { ...EMPTY_BEAST_ATTRS };
  const s = BEAST_QUALITY[beast.quality].attrs * (1+.05*(Math.max(1,Math.min(20,beast.level))-1));
  return {attack:Math.floor(def.attrs.attack*s),defense:Math.floor(def.attrs.defense*s),speed:Math.floor(def.attrs.speed*s),luck:Math.floor(def.attrs.luck*s),physique:Math.floor(def.attrs.physique*s)};
}
export function beastSkillText(beast: Pick<BeastIdentity,'speciesId'|'quality'|'level'>): string {
  const def = DEFINITIONS.find(b=>b.id===beast.speciesId)!;
  const m = beastMods(beast);
  return def.skillText.replace(/\{(\w+)\}/g, (_,key: string)=> {
    const value = m[key as keyof BeastMods];
    return typeof value === 'number' ? String(Number((value*(key==='crit'?1:100)).toFixed(2))) : '';
  });
}
export const BEAST_SPECIES: BeastSpeciesView[] = DEFINITIONS.map(def=>({
  ...def, tierName: BEAST_TIER_NAMES[def.tier], elementName: ELEMENT_NAMES[def.element],
  image: beastArtPath(def.id), avatar: beastAvatarPath(def.id),
  skillText: beastSkillText({ speciesId:def.id,quality:'common',level:1 }),
}));
export function readBeast(row: { beast_json?: string | null }): BeastIdentity | null {
  if (!row.beast_json) return null;
  try {
    const b = JSON.parse(row.beast_json) as BeastIdentity;
    return b && BEAST_SPECIES.some(d=>d.id===b.speciesId) && Object.hasOwn(BEAST_QUALITY,b.quality)
      && Number.isInteger(b.level) && b.level>=1 && b.level<=BEAST_RULES.maxLevel ? b : null;
  } catch { return null; }
}
export function beastOf(row: { beast_json?: string | null }): BeastMods | undefined {
  const b=readBeast(row); return b ? beastMods(b) : undefined;
}
/** Boss has no rounds or health pool: convert defensive skills into injury risk modifiers. */
export function beastBossMods(row: { beast_json?: string | null }) {
  const m=beastOf(row);
  if(!m)return {damage:1,injury:1,severe:1,crit:0,text:''};
  const damage=1+m.first*.3+m.low*.5+m.extra+m.procChance*m.proc+(m.firstCrit?.08:0);
  const protection=Math.min(.45,m.heal*8+m.firstGuard*.75+m.guard*4+m.hp*.8+m.shield+(m.poisonImmune?.04:0));
  return {damage,injury:1-protection,severe:1-protection*.65,crit:m.crit,
    text:`${m.name}【${m.skillName}】：${damage>1?'伤害 +'+Number(((damage-1)*100).toFixed(1))+'%；':''}${m.crit?'暴伤倍率 +'+Number(m.crit.toFixed(2))+'；':''}${protection?'受伤概率 −'+Number((protection*100).toFixed(1))+'%，重伤概率 −'+Number((protection*.65*100).toFixed(1))+'%':''}`.replace(/；$/,'')};
}
export function withBeastAttributes(base: BeastAttrs, row: { beast_json?: string | null }): BeastAttrs {
  const b=readBeast(row); if (!b) return base;
  const a=beastAttributes(b);
  return {attack:base.attack+a.attack,defense:base.defense+a.defense,speed:base.speed+a.speed,luck:base.luck+a.luck,physique:base.physique+a.physique};
}
export function beastUpgradeCost(beast: Pick<BeastIdentity,'speciesId'|'level'>) {
  if(beast.level>=BEAST_RULES.maxLevel) return null;
  const tier=BEAST_SPECIES.find(b=>b.id===beast.speciesId)?.tier ?? 'spirit';
  const factor={spirit:1,rare:2,divine:3}[tier];
  return {spiritStone:10_000*beast.level*factor,spiritualEnergy:8_000*beast.level*factor};
}
export function weightedPick<T>(items: readonly T[], weight: (item:T)=>number, random:()=>number): T {
  const total=items.reduce((s,i)=>s+weight(i),0); let roll=random()*total;
  for(const i of items) { roll-=weight(i); if(roll<0) return i; }
  return items[items.length-1]!;
}
export function encounterSpecies(ids: readonly string[], luck: number, random:()=>number): BeastSpeciesView {
  const bonus=1+Math.max(-.25,Math.min(.5,(luck-50)/100));
  return weightedPick(BEAST_SPECIES.filter(b=>ids.includes(b.id)),b=>({spirit:100,rare:30*bonus,divine:2*bonus}[b.tier]),random);
}
export function encounterQuality(random:()=>number): BeastQuality {
  return weightedPick(Object.keys(BEAST_QUALITY) as BeastQuality[],q=>BEAST_QUALITY[q].weight,random);
}
export function captureRate(tier:BeastTier,hp:number,maxHp:number,power:number,strength:number,luck:number):number {
  const base={spirit:.2,rare:.12,divine:.04}[tier];
  const weakened=(1-Math.max(0,Math.min(1,hp/Math.max(1,maxHp))))*.45;
  const advantage=Math.max(-.2,Math.min(.15,(power/Math.max(1,strength)-1)*.15));
  return Math.max(.02,Math.min(.9,base+weakened+advantage+(Math.max(1,Math.min(100,luck))-50)*.0015));
}
