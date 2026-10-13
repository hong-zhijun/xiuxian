import { describe, expect, it } from 'vitest';

import {
  ARENA_MAX_ROUNDS,
  ARENA_WIN_EVEN_POINTS,
  ARENA_WIN_STRONG_POINTS,
  ARENA_WIN_WEAK_POINTS,
  adjustTeamLineup,
  applyHandicap,
  arenaFighterHp,
  arenaHandicap,
  arenaSeasonRange,
  arenaSwissPair,
  arenaWeightedWinPoints,
  autoSelectLineup,
  calculateTeamPowerCap,
  dailyIndividualReward,
  seasonTeamReward,
  simulateArenaDuel,
  sortArenaIndividuals,
  type ArenaCandidate,
  type ArenaFighter,
} from '../../apps/server/src/modules/game/arena';

/** 按顺序循环吐出固定随机数。 */
function sequence(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index % values.length]!;
    index += 1;
    return value;
  };
}

/** 固定种子的线性同余随机数（只用于跑很多场、检查不变量）。 */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    return state / 0x7fff_ffff;
  };
}

function fighter(id: string, power: number, attr: number): ArenaFighter {
  return { id, name: id, power, attack: attr, defense: attr, speed: attr, luck: attr, physique: attr };
}

describe('宗门大比纯规则（arena.ts）', () => {
  it('以弱克强：强者无补偿，弱者按战力差补偿，上限 50%', () => {
    expect(arenaHandicap(300, 600)).toBe(0.5);
    expect(arenaHandicap(600, 300)).toBe(0);
    expect(arenaHandicap(100, 1000)).toBe(0.5);
    expect(arenaHandicap(500, 500)).toBe(0);
    const boosted = applyHandicap(fighter('a', 300, 40), 0.5);
    expect(boosted.attack).toBe(60);
    expect(boosted.physique).toBe(60);
    expect(boosted.power).toBe(300);
  });

  it('血量与镇妖塔同一公式（4.5 × 战力 ×（0.5 + 体魄 / 100）× 100）', () => {
    expect(arenaFighterHp(100, 50)).toBe(Math.floor(4.5 * 100 * 1 * 100));
  });

  it('赛季 id 按周一开始的 ISO 周编号；周日仍属于同一赛季', () => {
    const tuesday = Date.UTC(2026, 9, 13, 10) - 8 * 3_600_000;
    expect(arenaSeasonRange(tuesday)).toEqual({ id: '2026-W42', startDate: '2026-10-12', endDate: '2026-10-18' });
    const sunday = Date.UTC(2026, 9, 18, 13) - 8 * 3_600_000;
    expect(arenaSeasonRange(sunday).id).toBe('2026-W42');
    const nextMonday = Date.UTC(2026, 9, 19, 0, 30) - 8 * 3_600_000;
    expect(arenaSeasonRange(nextMonday).id).toBe('2026-W43');
    const newYearsEve = Date.UTC(2025, 11, 31, 12) - 8 * 3_600_000;
    expect(arenaSeasonRange(newYearsEve).id).toBe('2026-W01');
  });

  it('团队赛战力上限是各宗门前 5 人总战力的平均值', () => {
    expect(calculateTeamPowerCap([100, 200, 300])).toBe(200);
    expect(calculateTeamPowerCap([])).toBe(0);
  });

  it('战斗：每回合至多 10 回合，血量不为负，胜负与剩余血量一致', () => {
    const random = seeded(20_261_013);
    for (let i = 0; i < 500; i += 1) {
      const a = fighter('a', 300 + (i % 50), 40 + (i % 60));
      const b = fighter('b', 280 + (i % 70), 35 + (i % 65));
      const result = simulateArenaDuel({ fighterA: a, fighterB: b, random });
      expect(result.rounds.length).toBeLessThanOrEqual(ARENA_MAX_ROUNDS);
      for (const round of result.rounds) {
        expect(round.fighterAHp).toBeGreaterThanOrEqual(0);
        expect(round.fighterBHp).toBeGreaterThanOrEqual(0);
      }
      if (result.winnerId === 'a') expect(result.fighterBHp).toBe(0);
      if (result.winnerId === 'b') expect(result.fighterAHp).toBe(0);
      expect(result.fighterAHpPct).toBeGreaterThanOrEqual(0);
      expect(result.fighterAHpPct).toBeLessThanOrEqual(100);
    }
  });

  it('战斗：同一串随机数结果一致；续战血量不超过满血', () => {
    const a = fighter('a', 300, 50);
    const b = fighter('b', 300, 50);
    const first = simulateArenaDuel({ fighterA: a, fighterB: b, random: sequence([0.1, 0.9, 0.5, 0.3]) });
    const second = simulateArenaDuel({ fighterA: a, fighterB: b, random: sequence([0.1, 0.9, 0.5, 0.3]) });
    expect(second).toEqual(first);
    const carried = simulateArenaDuel({ fighterA: a, fighterB: b, startHpA: 10 ** 12, random: sequence([0.5]) });
    expect(carried.fighterAHp).toBeLessThanOrEqual(carried.fighterAMaxHp);
  });

  it('战斗：战力碾压的一方必胜', () => {
    const result = simulateArenaDuel({
      fighterA: fighter('a', 2000, 100),
      fighterB: fighter('b', 100, 10),
      random: seeded(7),
    });
    expect(result.winnerId).toBe('a');
  });

  it('自动选人：按战力取前 N 名，跳过不能出战的', () => {
    const candidates: ArenaCandidate[] = [
      { id: 'p1', combatPower: 1000, blocked: false },
      { id: 'p2', combatPower: 900, blocked: true },
      { id: 'p3', combatPower: 800, blocked: false },
      { id: 'p4', combatPower: 700, blocked: false },
    ];
    expect(autoSelectLineup(candidates, 2)).toEqual(['p1', 'p3']);
  });

  it('团队阵容超限：从最强起换成候补，仍超限则撤下最弱的', () => {
    const candidates: ArenaCandidate[] = [1000, 900, 800, 700, 600, 500, 400].map((combatPower, index) => ({
      id: `p${String(index + 1)}`,
      combatPower,
      blocked: false,
    }));
    const top5 = ['p1', 'p2', 'p3', 'p4', 'p5'];
    expect(adjustTeamLineup(candidates, top5, 3600)).toEqual(['p6', 'p2', 'p3', 'p4', 'p5']);
    const tight = adjustTeamLineup(candidates, top5, 1500);
    const total = tight.reduce((sum, id) => sum + candidates.find((c) => c.id === id)!.combatPower, 0);
    expect(total).toBeLessThanOrEqual(1500);
    expect(adjustTeamLineup(candidates, ['p1', 'p3'], Number.POSITIVE_INFINITY)).toEqual(['p1', 'p3']);
  });

  it('团队阵容：不能出战的人原地换成最强候补（出战顺序不变）', () => {
    const candidates: ArenaCandidate[] = [1000, 900, 800, 700, 600, 500].map((combatPower, index) => ({
      id: `p${String(index + 1)}`,
      combatPower,
      blocked: index === 0,
    }));
    expect(adjustTeamLineup(candidates, ['p1', 'p2', 'p3'], Number.POSITIVE_INFINITY)).toEqual(['p4', 'p2', 'p3']);
  });

  it('瑞士轮配对：同宗门不互打、不重赛、每轮每人最多一场', () => {
    const entrants = [
      { index: 0, groupId: 's1', points: 0, wins: 0, damage: 0 },
      { index: 1, groupId: 's1', points: 0, wins: 0, damage: 0 },
      { index: 2, groupId: 's2', points: 0, wins: 0, damage: 0 },
      { index: 3, groupId: 's2', points: 0, wins: 0, damage: 0 },
      { index: 4, groupId: 's3', points: 0, wins: 0, damage: 0 },
    ];
    const played = new Set<string>();
    let totalPairs = 0;
    for (let round = 0; round < 5; round += 1) {
      const pairs = arenaSwissPair(entrants, played);
      const usedThisRound = new Set<number>();
      for (const [i, j] of pairs) {
        expect(entrants[i]!.groupId).not.toBe(entrants[j]!.groupId);
        const key = `${String(Math.min(i, j))}:${String(Math.max(i, j))}`;
        expect(played.has(key)).toBe(false);
        expect(usedThisRound.has(i) || usedThisRound.has(j)).toBe(false);
        usedThisRound.add(i);
        usedThisRound.add(j);
        played.add(key);
      }
      totalPairs += pairs.length;
    }
    expect(totalPairs).toBeGreaterThan(0);
  });

  it('加权得分：以弱胜强 5 分、势均力敌 3 分、以强胜弱 1 分', () => {
    expect(arenaWeightedWinPoints(100, 200)).toBe(ARENA_WIN_STRONG_POINTS);
    expect(arenaWeightedWinPoints(100, 100)).toBe(ARENA_WIN_EVEN_POINTS);
    expect(arenaWeightedWinPoints(200, 100)).toBe(ARENA_WIN_WEAK_POINTS);
    expect(arenaWeightedWinPoints(0, 100)).toBe(ARENA_WIN_STRONG_POINTS);
  });

  it('排名：个人赛积分 → 胜场 → 伤害；奖励按名次（第 1 名另得修为丹）', () => {
    const ranked = sortArenaIndividuals([
      { id: 'b', points: 3, wins: 1, damage: 5 },
      { id: 'a', points: 6, wins: 2, damage: 1 },
      { id: 'c', points: 3, wins: 1, damage: 9 },
    ]);
    expect(ranked.map((row) => row.id)).toEqual(['a', 'c', 'b']);
    expect(dailyIndividualReward(1)).toEqual({ spiritStone: 1000, cultivationPill: 5 });
    expect(dailyIndividualReward(9)).toEqual({ spiritStone: 300, cultivationPill: 0 });
    expect(seasonTeamReward(1)).toEqual({ spiritStone: 1000, merit: 15, xuantie: 3 });
    expect(seasonTeamReward(4)).toEqual({ spiritStone: 0, merit: 0, xuantie: 0 });
  });
});
