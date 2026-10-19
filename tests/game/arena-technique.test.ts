import { describe, expect, it } from 'vitest';

import {
  arenaFighterHp,
  simulateArenaDuel,
  type ArenaFighter,
} from '../../apps/server/src/modules/game/arena';
import { techniqueModifiersOf, type TechniqueModifiers } from '../../apps/server/src/modules/game/techniques';

/** 可复现的线性同余随机源（与功法规则测试同一写法）。 */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function fighter(id: string, overrides: Partial<ArenaFighter> = {}): ArenaFighter {
  return { id, name: id, power: 200, attack: 60, defense: 60, speed: 60, luck: 50, physique: 60, ...overrides };
}

/** 满级满熟练度的功法修正。 */
function maxed(techniqueId: string): TechniqueModifiers {
  return techniqueModifiersOf({ techniqueId, level: 10, proficiencyBp: 10_000 })!;
}

describe('宗门大比 · 功法', () => {
  it('双方都没修功法：带上 technique: undefined 与不带结果完全一致', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const plain = simulateArenaDuel({ fighterA: fighter('a'), fighterB: fighter('b', { speed: 40 }), random: seeded(seed) });
      const explicit = simulateArenaDuel({
        fighterA: { ...fighter('a'), technique: undefined },
        fighterB: { ...fighter('b', { speed: 40 }), technique: undefined },
        random: seeded(seed),
      });
      expect(explicit).toEqual(plain);
      for (const round of plain.rounds) {
        expect(round.heals).toBeUndefined();
        for (const hit of round.hits) expect(hit.tags).toBeUndefined();
      }
    }
  });

  it('一剑破甲：本场第一次出手必定暴击并带【破甲】标签', () => {
    const duel = simulateArenaDuel({
      fighterA: fighter('a', { technique: maxed('pojia'), speed: 90 }),
      fighterB: fighter('b'),
      random: seeded(7),
    });
    const first = duel.rounds[0]!.hits.find((hit) => hit.fighterId === 'a')!;
    expect(first.crit).toBe(true);
    expect(first.tags).toContain('破甲');
  });

  it('金刚不坏体：血量高于不修功法；不灭血身：回合结束回血', () => {
    expect(arenaFighterHp(200, 80, maxed('jingang'))).toBeGreaterThan(arenaFighterHp(200, 80));
    const duel = simulateArenaDuel({
      fighterA: fighter('a', { technique: maxed('xueshen'), power: 400 }),
      fighterB: fighter('b'),
      random: seeded(11),
    });
    expect(duel.rounds.some((round) => (round.heals ?? []).some((heal) => heal.fighterId === 'a' && heal.amount > 0))).toBe(true);
  });

  it('百毒不侵：同样的出手，受到的伤害更低', () => {
    const plain = simulateArenaDuel({ fighterA: fighter('a'), fighterB: fighter('b'), random: seeded(5) });
    const baidu = simulateArenaDuel({
      fighterA: fighter('a'),
      fighterB: fighter('b', { technique: maxed('baidu') }),
      random: seeded(5),
    });
    const firstHitOnB = (result: typeof plain) => result.rounds[0]!.hits.find((hit) => hit.fighterId === 'a')!.damage;
    expect(firstHitOnB(baidu)).toBeLessThan(firstHitOnB(plain));
  });

  it('流云身法：一次出手可以连续追击三击', () => {
    let maxStreak = 0;
    for (let seed = 1; seed <= 60 && maxStreak < 3; seed += 1) {
      const duel = simulateArenaDuel({
        fighterA: fighter('a', { technique: maxed('liuyun'), speed: 100 }),
        fighterB: fighter('b', { speed: 0, power: 2_000 }),
        random: seeded(seed),
      });
      for (const round of duel.rounds) {
        let streak = 0;
        for (const hit of round.hits) {
          streak = hit.fighterId === 'a' ? streak + 1 : 0;
          maxStreak = Math.max(maxStreak, streak);
        }
      }
    }
    expect(maxStreak).toBe(3);
  });

  it('鬼影步：第 1 回合必定追击', () => {
    const duel = simulateArenaDuel({
      fighterA: fighter('a', { technique: maxed('guiying'), speed: 90 }),
      fighterB: fighter('b', { power: 2_000 }),
      random: seeded(3),
    });
    const mine = duel.rounds[0]!.hits.filter((hit) => hit.fighterId === 'a');
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine[1]!.extra).toBe(true);
  });
});
