import { z } from 'zod';

/**
 * 游戏接口的请求 schema（严格：未声明字段一律拒绝）。
 * 账号/会话相关 schema 在 modules/auth/schema.ts。
 */

export const createSectRequestSchema = z.strictObject({
  name: z.string().trim().min(2, '宗门名至少 2 个字符').max(12, '宗门名最多 12 个字符'),
});

/**
 * V4 招募三选一：choice 是 0~2 的候选人序号（候选人由服务端确定性生成）。
 *
 * 0016：batch 是预览下发的批次标识（见 names.ts 的 recruitBatchId），必须原样回传。
 * 这里刻意**允许缺省**（空串/缺字段都放行到 service），让「旧客户端没带标识」能走到
 * 批次判定并拿到明确的「请刷新页面重新预览」提示（EXPIRED），而不是一条泛化的参数错误；
 * 取值是否等于当前批次由 service 的 recruitBatchStatus 判定，它不是授权凭据。
 */
export const recruitRequestSchema = z.strictObject({
  choice: z.number().int().min(0).max(2),
  batch: z.string().min(1).max(160).optional(),
});

export const assignRequestSchema = z.strictObject({
  discipleId: z.string().min(1).max(64),
  /** 岗位 id 的合法性由服务端按配置校验。 */
  assignment: z.string().min(1).max(32),
});

export const upgradeBuildingRequestSchema = z.strictObject({
  defId: z.string().min(1).max(64),
});

export const breakthroughRequestSchema = z.strictObject({
  discipleId: z.string().min(1).max(64),
});

/** V2-2 探索秘境：秘境 id 的合法性由服务端按 SECRET_REALMS 校验，人数/去重在 service 里判定。 */
export const exploreRequestSchema = z.strictObject({
  realmId: z.string().min(1).max(64),
  discipleIds: z.array(z.uuid()).min(1).max(3),
});

/**
 * V3 切磋：三个 id 都必须是 uuid（与 generateId/弟子 id 的生成方式一致）；
 * 「不能打自己」「弟子归属」「每日次数」等业务判定全部在 service 里。
 */
export const sparRequestSchema = z.strictObject({
  targetSectId: z.uuid(),
  myDiscipleId: z.uuid(),
  targetDiscipleId: z.uuid(),
});

/** V5 守擂阵容：固定 3 人，顺序即出战顺序（去重/归属在 service 里判定）。 */
export const setDefenseLineupSchema = z.strictObject({
  discipleIds: z.array(z.string().min(1)).length(3),
});

/** V5 挑战：目标宗门 + 攻方 3 人出战阵容（顺序即对阵顺序）。 */
export const challengeRequestSchema = z.strictObject({
  targetSectId: z.string().min(1),
  discipleIds: z.array(z.string().min(1)).length(3),
});

/** 丹药炼制：quantity 是 1~5 的整数；pill id 的合法性由服务端按 PILL_RECIPES 校验。 */
export const craftPillRequestSchema = z.strictObject({
  pillId: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(5),
});

/** 丹药服用：目标弟子必须属于当前宗门（服务端用 draft.discipleById 判定归属）。 */
export const usePillRequestSchema = z.strictObject({
  pillId: z.string().min(1).max(64),
  discipleId: z.string().min(1).max(64),
});

/**
 * 0013 弟子私有备注：只做「类型 + 宽松长度上限」的第一道防线，
 * 真正的规则（trim / 单行纯文本 / 无控制字符 / ≤60 个 Unicode 字符）在
 * service.normalizeDiscipleNote 里按码点判定，与 0013 迁移的 CHECK 保持一致。
 */
export const setDiscipleNoteRequestSchema = z.strictObject({
  discipleId: z.string().min(1).max(64),
  note: z.string().max(240),
});

/** 0013 驱逐弟子：只带目标 id；归属与人数规则由 service 判定。 */
export const expelDiscipleRequestSchema = z.strictObject({
  discipleId: z.string().min(1).max(64),
});

/**
 * 0014 历练预览：只带目标弟子 id；方向/时长的合法性由服务端按 JOURNEY_DIRECTIONS /
 * JOURNEY_DURATIONS_SECONDS 校验，这里只挡住空值与超长。
 */
export const journeyPreviewQuerySchema = z.strictObject({
  discipleId: z.string().min(1).max(64),
});

/**
 * 0014 出发：方向与时长只做「类型 + 宽松长度」的第一道防线，
 * 真正的白名单（daoSeeking/gathering × 7200/21600）在 journey.ts 里判定。
 */
export const startJourneyRequestSchema = z.strictObject({
  discipleId: z.string().min(1).max(64),
  direction: z.string().min(1).max(32),
  durationSeconds: z.number().int().positive(),
});

/** 0014 领取：只带历练记录 id；归属与状态由 service 判定（跨宗 id 一律 NOT_FOUND）。 */
export const claimJourneyRequestSchema = z.strictObject({
  journeyId: z.string().min(1).max(64),
});

/**
 * V6 交互式秘境探索（0015）：id/choiceId 只做「类型 + 宽松长度」的第一道防线，
 * 秘境与选项的合法性、探索记录的归属、是否仍有进行中的探索都在 service 层判定。
 */
export const startRealmExploreSchema = z.strictObject({
  realmId: z.string().min(1).max(64),
  discipleIds: z.array(z.string().min(1).max(64)).min(1).max(3),
});

/** V6 推进一关：探索记录 id + 当前遭遇里的选项 id（跨宗 id 一律 NOT_FOUND）。 */
export const chooseRealmExploreSchema = z.strictObject({
  explorationId: z.string().min(1).max(64),
  choiceId: z.string().min(1).max(64),
});

/** V6 放弃探索：结算已得奖励并结束这一局。 */
export const abandonExplorationSchema = z.strictObject({
  explorationId: z.string().min(1).max(64),
});

/**
 * 0017 弟子头像框：frameId 只接受 11 个固定字符串（'classic' + 'frame01'…'frame10'），
 * 不接受任意 URL / 路径 / 上传；非法值走既有的 400 VALIDATION_ERROR（不新造错误码）。
 * 白名单与 0017 迁移的 CHECK 保持一致。
 */
export const AVATAR_FRAME_IDS = [
  'classic',
  'frame01',
  'frame02',
  'frame03',
  'frame04',
  'frame05',
  'frame06',
  'frame07',
  'frame08',
  'frame09',
  'frame10',
] as const;

/** 0017 设置头像框：discipleId 只做长度防线，归属由 service 判定；frameId 必须命中白名单。 */
export const setDiscipleAvatarFrameRequestSchema = z.strictObject({
  discipleId: z.string().min(1).max(64),
  frameId: z.enum(AVATAR_FRAME_IDS),
});
