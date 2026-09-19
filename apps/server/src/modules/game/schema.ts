import { z } from 'zod';

/**
 * 游戏接口的请求 schema（严格：未声明字段一律拒绝）。
 * 账号/会话相关 schema 在 modules/auth/schema.ts。
 */

export const createSectRequestSchema = z.strictObject({
  name: z.string().trim().min(2, '宗门名至少 2 个字符').max(12, '宗门名最多 12 个字符'),
});

/** V4 招募三选一：choice 是 0~2 的候选人序号（候选人由服务端确定性生成）。 */
export const recruitRequestSchema = z.strictObject({
  choice: z.number().int().min(0).max(2),
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
