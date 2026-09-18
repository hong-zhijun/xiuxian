import { findTalent } from './constants';

/**
 * 弟子随机生成（任务卡「2.4 弟子随机生成」+ V4 第五节的种子化版本）。
 *
 * - 无参版本（randomXxx）直接用 `Math.random()`：创建宗门的初始弟子只生成一次，不需要可复现；
 * - 带随机源的版本（generateXxx）由调用方注入 `() => number`，招募预览与招募本身共用同一 seed。
 */

const SURNAMES = [
  '云',
  '墨',
  '苏',
  '白',
  '顾',
  '沈',
  '叶',
  '陆',
  '江',
  '萧',
  '柳',
  '谢',
  '楚',
  '姜',
  '裴',
  '薛',
  '秦',
  '许',
  '方',
  '燕',
  '凌',
  '南宫',
  '上官',
  '司徒',
  '独孤',
] as const;

const GIVEN_NAMES = [
  '清和',
  '流云',
  '无咎',
  '青玄',
  '长风',
  '拾微',
  '闻笛',
  '砚舟',
  '惊蛰',
  '未名',
  '知微',
  '星澜',
  '疏影',
  '松声',
  '砚青',
  '微澜',
  '初霁',
  '望山',
  '怀玉',
  '拾光',
  '行舟',
  '半夏',
  '听雪',
  '明烛',
  '问天',
  '拂衣',
  '折月',
  '归远',
  '似锦',
  '织雪',
] as const;

export function randomDiscipleName(): string {
  const surname = SURNAMES[Math.floor(Math.random() * SURNAMES.length)] ?? '云';
  const given = GIVEN_NAMES[Math.floor(Math.random() * GIVEN_NAMES.length)] ?? '清和';
  return `${surname}${given}`;
}

export function randomGender(): 'male' | 'female' {
  return Math.random() < 0.5 ? 'male' : 'female';
}

/** 资质 1~100（任务卡）。 */
export function randomAptitude(): number {
  return 1 + Math.floor(Math.random() * 100);
}

/**
 * 基于种子的伪随机生成器（V4 第五节；用于招募预览的确定性）。
 * 同一个 seed 永远产生同一序列，刷新页面重新预览不会换人。
 */
export function seededRandom(seed: string): () => number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
    h ^= h >>> 16;
    return (h >>> 0) / 0x100000000;
  };
}

/** 带随机源的姓名生成（V4 5.1）：确定性命中招募预览与招募本身。 */
export function generateDiscipleName(random: () => number): string {
  const surname = SURNAMES[Math.floor(random() * SURNAMES.length)] ?? '云';
  const given = GIVEN_NAMES[Math.floor(random() * GIVEN_NAMES.length)] ?? '清和';
  return `${surname}${given}`;
}

export function generateGender(random: () => number): 'male' | 'female' {
  return random() < 0.5 ? 'male' : 'female';
}

/** 属性/资质 1~100（V4 5.1）。 */
export function generateStat(random: () => number): number {
  return 1 + Math.floor(random() * 100);
}

export function generateTalent(random: () => number): string {
  const talents = ['herbGathering', 'mining', 'cultivation', 'combat'];
  return talents[Math.floor(random() * talents.length)] ?? 'combat';
}

/** 招募候选人（V4 5.2）：招募预览与实际招募共用同一批人。 */
export interface RecruitCandidate {
  name: string;
  gender: string;
  aptitude: number;
  attack: number;
  defense: number;
  speed: number;
  talent: string;
  talentName: string;
}

/**
 * 根据宗门当前状态生成 3 个确定性候选人（V4 5.3；V5.2 加入刷新序号）。
 *
 * seed = `${sectId}:${dateKey}:${recruitCount}:${refreshSeq}`：
 *   - recruitCount：今日已招募次数（跨天重置）；
 *   - refreshSeq：本境界已用的招贤刷新次数（升级重置）。
 * 同一次机会（同一宗门、同一 UTC+8 自然日、同一已招募次数、同一刷新次数）永远生成同一批人，
 * 因此「预览第 N 张 = 招募时 candidates[N]」，而刷新一次（refreshSeq +1）就会真的换一批。
 */
export function generateCandidates(
  sectId: string,
  dateKey: string,
  recruitCount: number,
  refreshSeq = 0,
): RecruitCandidate[] {
  const seed = `${sectId}:${dateKey}:${recruitCount}:${refreshSeq}`;
  const random = seededRandom(seed);
  const candidates: RecruitCandidate[] = [];
  for (let i = 0; i < 3; i++) {
    const talent = generateTalent(random);
    candidates.push({
      name: generateDiscipleName(random),
      gender: generateGender(random),
      aptitude: generateStat(random),
      attack: generateStat(random),
      defense: generateStat(random),
      speed: generateStat(random),
      talent,
      talentName: findTalent(talent)?.name ?? talent,
    });
  }
  return candidates;
}
