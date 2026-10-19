/**
 * 功法平衡自检（docs/功法开发计划.md 第 10 节）。
 *
 * 用法：npx tsx scripts/technique/balance.ts
 *
 * 做法：同一层、同一支队伍（5 人，属性取该层标准值）。每种配置先把战力系数 k 调到「无功法基线胜率 ≈ 50%」
 * （胜负边缘，功法的影响才看得出来），再让队伍里的修习弟子配上某门功法，分两档 S（满级满熟练 = 1.72，
 * 1 级零熟练 = 0.6）各跑 2000 场。同一场次用同一组随机种子，与基线对比的 Δ 才公平。
 *
 * 三种配置：
 * - 单人修习（标准队）：第 1 名弟子修习，其余无功法 —— 最接近实战（每名弟子只有一门主修）；
 * - 单人修习（第 1 名身法 +80）：修习者是身法型弟子，看追击（流云 / 鬼影）的收益；
 * - 全员修习（标准队）：5 人全部修习同一门功法 —— 压力测试，看效果叠加后是否失控。
 */
import {
  simulateTowerBattle,
  towerStandardAttr,
  towerStandardPower,
  type TowerFighter,
} from '../../apps/server/src/modules/game/tower';
import {
  TECHNIQUES,
  techniqueModifiersOf,
  type TechniqueModifiers,
} from '../../apps/server/src/modules/game/techniques';

// 覆盖各词缀（铁壁 30、疾风 60、剧毒 15/40/65、罡气 45、狂暴 25/50/75/100）与首领层（10 的倍数）。
const FLOORS = [9, 15, 19, 30, 40, 45, 60, 65, 79, 100];
const BATTLES = 2000;
const CALIBRATION_BATTLES = 400;
const SCALES = [
  { label: '满级满熟练 S=1.72', level: 10, proficiencyBp: 10_000 },
  { label: '1 级零熟练 S=0.6', level: 1, proficiencyBp: 0 },
] as const;

interface Config {
  label: string;
  /** 前 holders 名弟子修习功法。 */
  holders: number;
  /** 第 1 名弟子的身法加成。 */
  speedBonus: number;
}

const CONFIGS: readonly Config[] = [
  { label: '单人修习（标准队）', holders: 1, speedBonus: 0 },
  { label: '单人修习（第 1 名身法 +80，身法流派）', holders: 1, speedBonus: 80 },
  { label: '全员修习（标准队）', holders: 5, speedBonus: 0 },
];

/** 可复现的伪随机（LCG）。 */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** 守关之地的演武场等级：随层数放大（只为让抽样贴近实战，比较时两边一致）。 */
function arenaLevelOf(floor: number): number {
  if (floor >= 80) return 5;
  if (floor >= 40) return 3;
  return 1;
}

/** 同一支队伍：5 人、属性取该层标准值、战力 = 标准战力 × k；前 holders 名配上功法（或不配）。 */
function party(floor: number, k: number, technique: TechniqueModifiers | null, config: Config): TowerFighter[] {
  const attr = towerStandardAttr(floor);
  const power = towerStandardPower(floor) * k;
  return Array.from({ length: 5 }, (_, index) => ({
    id: `b${String(index)}`,
    name: `弟子${String(index)}`,
    power,
    attack: attr,
    defense: attr,
    speed: index === 0 ? attr + config.speedBonus : attr,
    luck: 50,
    physique: 50,
    critBonusBp: 0,
    damageReductionBp: 0,
    ...(technique !== null && index < config.holders ? { technique } : {}),
  }));
}

/** 胜率（0~1）：第 i 场用种子 base + i，同一场次在各配置下的随机种子相同。 */
function winRate(
  floor: number,
  k: number,
  technique: TechniqueModifiers | null,
  config: Config,
  battles: number,
  base: number,
): number {
  let wins = 0;
  for (let index = 0; index < battles; index += 1) {
    const result = simulateTowerBattle({
      floor,
      fighters: party(floor, k, technique, config),
      arenaLevel: arenaLevelOf(floor),
      random: seeded(base + index),
    });
    if (result.won) wins += 1;
  }
  return wins / battles;
}

/** 二分找战力系数 k，使该配置下的无功法基线胜率约 50%。 */
function calibrate(floor: number, config: Config): number {
  let low = 0.2;
  let high = 3;
  for (let step = 0; step < 14; step += 1) {
    const mid = (low + high) / 2;
    if (winRate(floor, mid, null, config, CALIBRATION_BATTLES, 7_000) > 0.5) high = mid;
    else low = mid;
  }
  return (low + high) / 2;
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const delta = (value: number): string => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}pp`;
const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
const range = (values: number[]): string =>
  `${delta(Math.min(...values))} ~ ${delta(Math.max(...values))}`;

/** deltas[配置名][档位名] = 每层的 Δ（小数，相对同配置的无功法基线）。 */
const deltas = new Map<string, Map<string, Map<string, number[]>>>();
for (const config of CONFIGS) {
  deltas.set(
    config.label,
    new Map(TECHNIQUES.map((def) => [def.id, new Map(SCALES.map((scale) => [scale.label, [] as number[]]))])),
  );
}

const report: string[] = [];
for (const config of CONFIGS) {
  for (const floor of FLOORS) {
    const k = calibrate(floor, config);
    const baseline = winRate(floor, k, null, config, BATTLES, 1_000_000);
    report.push(`### ${config.label} · 第 ${String(floor)} 层（k = ${k.toFixed(3)}，基线 ${pct(baseline)}）`);
    report.push('');
    report.push('| 功法 | 品阶 | 满级满熟练 胜率 | Δ | 1 级零熟练 胜率 | Δ |');
    report.push('|---|---|---|---|---|---|');
    for (const def of TECHNIQUES) {
      const cells: string[] = [];
      for (const scale of SCALES) {
        const technique = techniqueModifiersOf({
          techniqueId: def.id,
          level: scale.level,
          proficiencyBp: scale.proficiencyBp,
        });
        const rate = winRate(floor, k, technique, config, BATTLES, 1_000_000);
        const change = rate - baseline;
        deltas.get(config.label)!.get(def.id)!.get(scale.label)!.push(change);
        cells.push(pct(rate), delta(change));
      }
      report.push(`| ${def.name} | ${def.tier} | ${cells.join(' | ')} |`);
    }
    report.push('');
  }
}

report.push(`## 汇总（Δ 为相对同配置无功法基线的胜率变化，跨 ${String(FLOORS.length)} 层）`);
report.push('');
report.push('| 配置 | 功法 | 满级满熟练 平均 Δ | 最小 ~ 最大 | 1 级零熟练 平均 Δ | 最小 ~ 最大 |');
report.push('|---|---|---|---|---|---|');
for (const config of CONFIGS) {
  for (const def of TECHNIQUES) {
    const high = deltas.get(config.label)!.get(def.id)!.get(SCALES[0].label)!;
    const low = deltas.get(config.label)!.get(def.id)!.get(SCALES[1].label)!;
    report.push(
      `| ${config.label} | ${def.name} | ${delta(mean(high))} | ${range(high)} | ${delta(mean(low))} | ${range(low)} |`,
    );
  }
}

console.log(report.join('\n'));
