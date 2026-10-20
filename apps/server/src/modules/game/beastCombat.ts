import type { BeastMods } from './spiritBeasts';
export interface BeastCombatState { firstGuardUsed: boolean; shieldUsed: boolean; shield: number }
export const freshBeastState = (): BeastCombatState => ({firstGuardUsed:false,shieldUsed:false,shield:0});
/** Receives already calculated elemental damage. Shields never revive a defeated owner. */
export function beastDefend(mods: BeastMods | undefined, state:BeastCombatState, damage:number, hp:number,maxHp:number) {
  let taken=damage; const tags:string[]=[];
  if(mods && damage>0) {
    taken*=1-mods.guard;
    if(!state.firstGuardUsed) { taken*=1-mods.firstGuard; state.firstGuardUsed=true; if(mods.firstGuard) tags.push(mods.skillName); }
    if(mods.guard) tags.push(mods.skillName);
  }
  taken=Math.max(0,Math.floor(taken));
  const absorbed=Math.min(state.shield,taken); state.shield-=absorbed; taken-=absorbed;
  const remaining=Math.max(0,hp-taken);
  if(mods?.shield && !state.shieldUsed && remaining>0 && remaining/maxHp<.35) {
    state.shieldUsed=true; state.shield+=Math.floor(maxHp*mods.shield); tags.push(mods.skillName);
  }
  return {damage:taken,absorbed,tags};
}
