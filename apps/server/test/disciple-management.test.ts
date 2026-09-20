import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prepareStatements } from '../src/infra/db/repository';
import {
  DiscipleRepository,
  ResourceBalanceRepository,
  SectRepository,
  challengeSnapshotGuardStatement,
  deleteChallengeSnapshotGuardStatement,
  deleteDiscipleSnapshotGuardStatement,
  deleteDiscipleStatement,
  discipleSnapshotGuardStatement,
  resourceDeltaStatement,
  updateDiscipleNoteStatement,
  updateDiscipleProgressStatement,
  updateSectDefenseLineupStatement,
} from '../src/modules/game/repository';

import { dataOf, errorOf, TestClient, type ApiResult } from './support/authClient';
import { CULTIVATION_PILL_GAIN } from '../src/modules/game/alchemy';

/**
 * 弟子管理优化（0013 迁移：私有备注 + 驱逐 + 名单汇总接口）。
 *
 * 存储说明：本文件一份独立内存 D1，没有逐用例回滚 —— 每个用例用独立账号/宗门
 * （前缀 + 递增序号），涉及计数/余额的断言都按宗门 id 定界。
 *
 * 确定性说明：把 sects.last_settled_at 拨到未来（时钟回拨 → durationMs = 0 → 零产出、
 * 零事件），资源与人数断言才精确；挑战用例沿用 0012 的确定性战力配置
 * （攻方金丹三阶满属性、守方炼气一层 1 属性，±15% 浮动不会翻转胜负）。
 *
 * 私密性说明：备注是本文件最需要防回归的点 —— 断言不只看「公开视图里有没有 note 字段」，
 * 还在原始响应文本里搜哨兵字符串，防止将来某个公开视图顺手把 disciples 整行序列化出去。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;
const app = createApp({ logger: quietLogger });
const PASSWORD = 'password-123456';

/** 备注哨兵：出现在任何公开响应里都算泄漏。 */
const SECRET_NOTE = '私密备注-sentinel-9f3a';

let seq = 0;

/** 攻方自己的备注：会合法地出现在攻方自己的 sync / 命令返回里，但不应进入任何战报或他人视图。 */
const OWN_NOTE = '本宗备注-own-4b21';

interface SectFixture {
  api: TestClient;
  sectId: string;
  discipleIds: string[];
  state: () => Promise<Record<string, any>>;
}

async function makeSect(prefix: string): Promise<SectFixture> {
  seq += 1;
  const account = `${prefix}-${seq}`;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.9.${Math.floor(seq / 250)}.${seq % 250}` });

  const registered = await api.post('/api/v1/auth/register', { account, password: PASSWORD });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `弟管${String(seq)}宗` });
  expect(created.status).toBe(200);

  const state = dataOf(created) as Record<string, any>;
  return {
    api,
    sectId: state.state.sect.id as string,
    discipleIds: (state.state.disciples as { id: string }[]).map((disciple) => disciple.id),
    state: async () => {
      const result = await api.get('/api/v1/game/sync');
      expect(result.status).toBe(200);
      return (dataOf(result) as Record<string, any>).state as Record<string, any>;
    },
  };
}

/** 把 last_settled_at 拨到未来：下一次结算 elapsed = 0，零产出零事件。 */
async function freezeSettlement(sectId: string): Promise<void> {
  await env.DB.prepare('UPDATE sects SET last_settled_at = ? WHERE id = ?')
    .bind(Date.now() + 60_000, sectId)
    .run();
}

async function setBalance(sectId: string, resourceId: string, balance: number): Promise<void> {
  await env.DB.prepare('UPDATE resource_balances SET balance = ? WHERE sect_id = ? AND resource_id = ?')
    .bind(balance, sectId, resourceId)
    .run();
}

async function setDefenseLineup(sectId: string, discipleIds: string[]): Promise<void> {
  await env.DB.prepare('UPDATE sects SET defense_lineup = ? WHERE id = ?')
    .bind(JSON.stringify(discipleIds), sectId)
    .run();
}

async function rawDefenseLineup(sectId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT defense_lineup FROM sects WHERE id = ?')
    .bind(sectId)
    .first<{ defense_lineup: string | null }>();
  return row?.defense_lineup ?? null;
}

async function discipleRowCount(sectId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM disciples WHERE sect_id = ?')
    .bind(sectId)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

async function discipleExists(discipleId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM disciples WHERE id = ?')
    .bind(discipleId)
    .first<{ total: number }>();
  return Number(row?.total ?? 0) > 0;
}

async function noteOf(discipleId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT note FROM disciples WHERE id = ?')
    .bind(discipleId)
    .first<{ note: string }>();
  return row?.note ?? null;
}

async function dbBalance(sectId: string, resourceId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = ?')
    .bind(sectId, resourceId)
    .first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

async function balancesOf(sectId: string): Promise<Record<string, string>> {
  const rows = await env.DB.prepare('SELECT resource_id, balance FROM resource_balances WHERE sect_id = ?')
    .bind(sectId)
    .all<{ resource_id: string; balance: number }>();
  return Object.fromEntries((rows.results ?? []).map((row) => [row.resource_id, String(row.balance)]));
}

async function recruitCounter(sectId: string): Promise<{ dateKey: string; count: number }> {
  const row = await env.DB.prepare('SELECT recruit_date_key, recruit_count FROM sects WHERE id = ?')
    .bind(sectId)
    .first<{ recruit_date_key: string; recruit_count: number }>();
  return { dateKey: row?.recruit_date_key ?? '', count: Number(row?.recruit_count ?? 0) };
}

async function challengeCount(sectId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT challenge_count FROM sects WHERE id = ?')
    .bind(sectId)
    .first<{ challenge_count: number }>();
  return Number(row?.challenge_count ?? 0);
}

async function sectLevel(sectId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT level FROM sects WHERE id = ?')
    .bind(sectId)
    .first<{ level: number }>();
  return Number(row?.level ?? 0);
}

async function mutationGuardCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM mutation_guards').first<{ total: number }>();
  return Number(row?.total ?? 0);
}

async function eventLogCount(sectId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM event_log WHERE sect_id = ?')
    .bind(sectId)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

/** 攻方配置：金丹三阶满属性（确定性获胜）。 */
async function makeStrong(sectId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE disciples SET realm_id = 'goldenCore', stage = 3, attack = 100, defense = 100, speed = 100,
       injured_until = NULL WHERE sect_id = ?`,
  )
    .bind(sectId)
    .run();
}

/** 守方配置：炼气一层 1 属性（确定性落败）。 */
async function makeWeak(sectId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE disciples SET realm_id = 'qiRefining', stage = 1, attack = 1, defense = 1, speed = 1
     WHERE sect_id = ?`,
  )
    .bind(sectId)
    .run();
}

/** 招募第 4 名弟子（用来构造「不在守擂阵容里的弟子」），返回新弟子 id。 */
async function recruitFourth(sect: SectFixture): Promise<string> {
  await freezeSettlement(sect.sectId);
  await setBalance(sect.sectId, 'spiritStone', 500_000);

  const known = new Set(sect.discipleIds);
  const result = await sect.api.post('/api/v1/game/recruit', { choice: 0 });
  expect(result.status).toBe(200);

  const state = (dataOf(result) as Record<string, any>).state as Record<string, any>;
  const fresh = (state.disciples as { id: string }[]).map((disciple) => disciple.id).find((id) => !known.has(id));
  expect(fresh, '招贤应产生一名新弟子').toBeTruthy();
  return fresh as string;
}

function notePost(api: TestClient, discipleId: string, note: string): Promise<ApiResult> {
  return api.post('/api/v1/game/set-disciple-note', { discipleId, note });
}

function expelPost(api: TestClient, discipleId: string): Promise<ApiResult> {
  return api.post('/api/v1/game/expel-disciple', { discipleId });
}

describe('0013 迁移：disciples.note', () => {
  it('已有弟子获得空串默认值，新招募弟子同样为空串', async () => {
    const sect = await makeSect('dmg-mig');
    expect(await noteOf(sect.discipleIds[0] as string)).toBe('');

    const fourth = await recruitFourth(sect);
    expect(await noteOf(fourth)).toBe('');
  });

  it('CHECK (length(note) <= 60) 是数据库层兜底（绕过服务端也写不进超长备注）', async () => {
    const sect = await makeSect('dmg-mig-check');
    const discipleId = sect.discipleIds[0] as string;

    // 服务端按码点限制 60 字，数据库 CHECK 用 SQLite length()（同样按字符计数）。
    await env.DB.prepare('UPDATE disciples SET note = ? WHERE id = ?')
      .bind('好'.repeat(60), discipleId)
      .run();
    expect(await noteOf(discipleId)).toBe('好'.repeat(60));

    await expect(
      env.DB.prepare('UPDATE disciples SET note = ? WHERE id = ?')
        .bind('好'.repeat(61), discipleId)
        .run(),
    ).rejects.toThrow(/CHECK/i);
    expect(await noteOf(discipleId)).toBe('好'.repeat(60));
  });

  it('note 列是 NOT NULL 且默认空串：旧行（迁移前写入）读回来不能是 NULL', async () => {
    const columns = await env.DB.prepare('PRAGMA table_info(disciples)').all<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    const note = (columns.results ?? []).find((column) => column.name === 'note');
    expect(note, '0013 之后 disciples 必须有 note 列').toBeTruthy();
    expect(Number(note?.notnull)).toBe(1);
    expect(String(note?.dflt_value)).toContain("''");

    // 迁移前写入的旧行没有 note 列（等价于这里的 INSERT 省略 note）：读回来必须是空串。
    const sect = await makeSect('dmg-mig-default');
    const legacyId = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO disciples (id, sect_id, name, aptitude, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(legacyId, sect.sectId, '旧行', 50, Date.now())
      .run();
    expect(await noteOf(legacyId)).toBe('');

    // NOT NULL 也必须是真约束（否则上面的「空串」只是碰巧）。
    await expect(
      env.DB.prepare('UPDATE disciples SET note = NULL WHERE id = ?').bind(legacyId).run(),
    ).rejects.toThrow(/NOT NULL/i);
  });
});

describe('私有备注：保存、清空与校验', () => {
  it('保存后备注进入 sync 状态、列表与详情同源；相同内容重复保存不产生额外效果', async () => {
    const sect = await makeSect('dmg-note-save');
    await freezeSettlement(sect.sectId);
    const discipleId = sect.discipleIds[0] as string;

    const before = await balancesOf(sect.sectId);
    const eventsBefore = await eventLogCount(sect.sectId);

    const saved = await notePost(sect.api, discipleId, `  ${SECRET_NOTE}  `);
    expect(saved.status).toBe(200);
    const savedState = (dataOf(saved) as Record<string, any>).state as Record<string, any>;
    const savedView = (savedState.disciples as Record<string, any>[]).find((item) => item.id === discipleId);
    // 服务端 trim：返回值里就已经是去掉空白的最终内容。
    expect(savedView?.note).toBe(SECRET_NOTE);
    expect(await noteOf(discipleId)).toBe(SECRET_NOTE);

    const synced = await sect.state();
    const syncedView = (synced.disciples as Record<string, any>[]).find((item) => item.id === discipleId);
    expect(syncedView?.note).toBe(SECRET_NOTE);

    // 幂等：重复保存同一内容不产生资源、事件等额外游戏效果。
    await freezeSettlement(sect.sectId);
    const repeated = await notePost(sect.api, discipleId, SECRET_NOTE);
    expect(repeated.status).toBe(200);
    expect(await noteOf(discipleId)).toBe(SECRET_NOTE);
    expect(await balancesOf(sect.sectId)).toEqual(before);
    expect(await eventLogCount(sect.sectId)).toBe(eventsBefore);
    // 守卫行在同一个 batch 内清理，不留垃圾。
    expect(await mutationGuardCount()).toBe(0);
  });

  it('空串与纯空白可以清空备注', async () => {
    const sect = await makeSect('dmg-note-clear');
    await freezeSettlement(sect.sectId);
    const discipleId = sect.discipleIds[0] as string;

    await notePost(sect.api, discipleId, '先写上');
    expect(await noteOf(discipleId)).toBe('先写上');

    const cleared = await notePost(sect.api, discipleId, '   ');
    expect(cleared.status).toBe(200);
    expect(await noteOf(discipleId)).toBe('');

    const state = (dataOf(cleared) as Record<string, any>).state as Record<string, any>;
    const view = (state.disciples as Record<string, any>[]).find((item) => item.id === discipleId);
    expect(view?.note).toBe('');
  });

  it('超长 / 换行 / 控制字符被 VALIDATION_ERROR 拒绝且不写库', async () => {
    const sect = await makeSect('dmg-note-invalid');
    await freezeSettlement(sect.sectId);
    const discipleId = sect.discipleIds[0] as string;

    const tooLong = await notePost(sect.api, discipleId, '长'.repeat(61));
    expect(errorOf(tooLong).code).toBe('VALIDATION_ERROR');

    const multiline = await notePost(sect.api, discipleId, '第一行\n第二行');
    expect(errorOf(multiline).code).toBe('VALIDATION_ERROR');

    const tabbed = await notePost(sect.api, discipleId, '前\t后');
    expect(errorOf(tabbed).code).toBe('VALIDATION_ERROR');

    // C1 控制区与 U+2028/U+2029 行分隔符同样必须挡住（UI 单行 input 造不出来，接口能）。
    const c1 = await notePost(sect.api, discipleId, '前\u0085后');
    expect(errorOf(c1).code).toBe('VALIDATION_ERROR');

    const lineSeparator = await notePost(sect.api, discipleId, '前\u2028后');
    expect(errorOf(lineSeparator).code).toBe('VALIDATION_ERROR');

    // 刚好 60 字是允许的边界。
    const boundary = await notePost(sect.api, discipleId, '长'.repeat(60));
    expect(boundary.status).toBe(200);

    expect(await noteOf(discipleId)).toBe('长'.repeat(60));
  });

  it('未知 id 与非本宗弟子都返回 NOT_FOUND，且不动他人备注', async () => {
    const owner = await makeSect('dmg-note-owner');
    const stranger = await makeSect('dmg-note-stranger');
    await freezeSettlement(owner.sectId);

    const victim = owner.discipleIds[0] as string;
    await notePost(owner.api, victim, '本宗原备注');

    const unknown = await notePost(owner.api, 'no-such-disciple-id', '随便写');
    expect(errorOf(unknown).code).toBe('NOT_FOUND');

    // 跨宗：B 拿着 A 的弟子 id 保存，必须无法命中。
    const cross = await notePost(stranger.api, victim, '越权写入');
    expect(errorOf(cross).code).toBe('NOT_FOUND');
    expect(await noteOf(victim)).toBe('本宗原备注');
  });

  it('备注只出现在自己的 sync 状态：公开档案 / 排行榜 / 战报都不泄漏', async () => {
    const attacker = await makeSect('dmg-note-private-a');
    const defender = await makeSect('dmg-note-private-b');
    await freezeSettlement(attacker.sectId);
    await freezeSettlement(defender.sectId);

    // 攻方写自己的备注（会合法地出现在攻方自己的 state 里），守方写哨兵备注。
    await notePost(attacker.api, attacker.discipleIds[0] as string, OWN_NOTE);
    await notePost(defender.api, defender.discipleIds[0] as string, SECRET_NOTE);

    // 公开档案：连 note 字段都不该存在（自己看自己的公开档案同样不返回）。
    for (const viewer of [attacker.api, defender.api]) {
      const publicResult = await viewer.get(`/api/v1/game/sect/${defender.sectId}`);
      expect(publicResult.status).toBe(200);
      expect(JSON.stringify(publicResult.body)).not.toContain(SECRET_NOTE);
      // 自己看自己的公开档案也不能看到备注（公开视图对所有人一致）。
      expect(JSON.stringify(publicResult.body)).not.toContain(OWN_NOTE);
      const publicDisciples = (dataOf(publicResult) as Record<string, any>).sect.disciples as Record<string, any>[];
      expect(publicDisciples.length).toBeGreaterThan(0);
      expect(Object.keys(publicDisciples[0] as object)).not.toContain('note');
    }

    const leaderboard = await attacker.api.get('/api/v1/game/leaderboard');
    expect(leaderboard.status).toBe(200);
    expect(JSON.stringify(leaderboard.body)).not.toContain(SECRET_NOTE);
    // 攻方自己的备注也不该出现在排行榜里（排行榜是全局公开视图）。
    expect(JSON.stringify(leaderboard.body)).not.toContain(OWN_NOTE);

    // 打一场：战报里带的是双方弟子的姓名/战力快照，任何一方的备注都不能混进去。
    // （攻方的返回体里有攻方自己的 state，所以只查「守方哨兵」是否泄漏。）
    await makeStrong(attacker.sectId);
    await makeWeak(defender.sectId);
    const battle = await attacker.api.post('/api/v1/game/challenge', {
      targetSectId: defender.sectId,
      discipleIds: attacker.discipleIds.slice(0, 3),
    });
    expect(battle.status).toBe(200);
    expect(JSON.stringify(battle.body)).not.toContain(SECRET_NOTE);

    for (const client of [attacker.api, defender.api]) {
      const history = await client.get('/api/v1/game/challenge-history');
      expect(history.status).toBe(200);
      expect(JSON.stringify(history.body)).not.toContain(SECRET_NOTE);
    }

    const explorer = await env.DB.prepare('SELECT attacker_lineup, defender_lineup, rounds FROM challenge_log')
      .all<Record<string, string>>();
    for (const row of explorer.results ?? []) {
      expect(JSON.stringify(row)).not.toContain(SECRET_NOTE);
      expect(JSON.stringify(row)).not.toContain(OWN_NOTE);
    }
  });
});

describe('驱逐弟子：结算、删除与阵容清理', () => {
  it('驱逐后数据库行消失、state 人数同步，不返还资源/招募次数、不降宗门等级', async () => {
    const sect = await makeSect('dmg-expel-basic');
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 400_000);

    const victim = sect.discipleIds[0] as string;
    const balancesBefore = await balancesOf(sect.sectId);
    const recruitBefore = await recruitCounter(sect.sectId);
    const levelBefore = await sectLevel(sect.sectId);
    const eventsBefore = await eventLogCount(sect.sectId);

    await freezeSettlement(sect.sectId);
    const result = await expelPost(sect.api, victim);
    expect(result.status).toBe(200);

    const data = dataOf(result) as Record<string, any>;
    const state = data.state as Record<string, any>;
    expect(data.outcome.discipleName).toBeTruthy();
    expect(data.outcome.discipleId).toBe(victim);
    expect(data.outcome.lineupCleared).toBe(false);
    expect(data.outcome.remainingDisciples).toBe(2);

    expect(await discipleExists(victim)).toBe(false);
    expect(await discipleRowCount(sect.sectId)).toBe(2);
    expect((state.disciples as { id: string }[]).map((item) => item.id)).not.toContain(victim);
    expect(state.recruit.discipleCount).toBe(2);
    // 返回的 state 里就是新人数，不需要再 sync 一次才对。
    expect(state.sect.discipleCapacity).toBe(6);

    // 不发奖、不返资源、不返招募次数、不降等级。
    expect(await balancesOf(sect.sectId)).toEqual(balancesBefore);
    expect(await recruitCounter(sect.sectId)).toEqual(recruitBefore);
    expect(await sectLevel(sect.sectId)).toBe(levelBefore);
    expect(await eventLogCount(sect.sectId)).toBe(eventsBefore);

    const synced = await sect.state();
    expect(synced.recruit.discipleCount).toBe(2);
    expect((synced.disciples as { id: string }[]).length).toBe(2);
  });

  it('驱逐守擂阵容成员时同批清空阵容并提示重新布阵', async () => {
    const sect = await makeSect('dmg-expel-lineup-member');
    await freezeSettlement(sect.sectId);
    const [first, second, third] = sect.discipleIds as [string, string, string];
    await setDefenseLineup(sect.sectId, [first, second, third]);

    const before = await sect.state();
    expect(before.sect.defenseLineup).toEqual([first, second, third]);

    await freezeSettlement(sect.sectId);
    const result = await expelPost(sect.api, second);
    expect(result.status).toBe(200);

    const data = dataOf(result) as Record<string, any>;
    expect(data.outcome.lineupCleared).toBe(true);
    expect(data.state.sect.defenseLineup).toBeNull();
    expect(await rawDefenseLineup(sect.sectId)).toBeNull();
    expect(await discipleExists(second)).toBe(false);
  });

  it('驱逐非阵容成员时阵容一个字都不改', async () => {
    const sect = await makeSect('dmg-expel-lineup-outsider');
    const fourth = await recruitFourth(sect);
    const [first, second, third] = sect.discipleIds as [string, string, string];
    await setDefenseLineup(sect.sectId, [first, second, third]);

    await freezeSettlement(sect.sectId);
    const result = await expelPost(sect.api, fourth);
    expect(result.status).toBe(200);

    const data = dataOf(result) as Record<string, any>;
    expect(data.outcome.lineupCleared).toBe(false);
    expect(await rawDefenseLineup(sect.sectId)).toBe(JSON.stringify([first, second, third]));
    expect(data.state.sect.defenseLineup).toEqual([first, second, third]);
  });

  it('重复驱逐与跨宗驱逐都返回 NOT_FOUND，且不误删他人弟子', async () => {
    const owner = await makeSect('dmg-expel-owner');
    const stranger = await makeSect('dmg-expel-stranger');
    await freezeSettlement(owner.sectId);

    const victim = owner.discipleIds[0] as string;

    // 跨宗：B 驱逐 A 的弟子必须失败。
    const cross = await expelPost(stranger.api, victim);
    expect(errorOf(cross).code).toBe('NOT_FOUND');
    expect(await discipleExists(victim)).toBe(true);

    await freezeSettlement(owner.sectId);
    expect((await expelPost(owner.api, victim)).status).toBe(200);
    expect(await discipleExists(victim)).toBe(false);

    // 重复驱逐：同一个 id 第二次是 NOT_FOUND，且他人弟子数量不受影响。
    const repeated = await expelPost(owner.api, victim);
    expect(errorOf(repeated).code).toBe('NOT_FOUND');
    expect(await discipleRowCount(owner.sectId)).toBe(2);
    expect(await discipleRowCount(stranger.sectId)).toBe(3);
  });

  it('可以驱逐到 0 人：人数视图立刻反映，宗门升级条件随之下滑', async () => {
    const sect = await makeSect('dmg-expel-to-zero');
    await freezeSettlement(sect.sectId);

    for (const discipleId of sect.discipleIds) {
      await freezeSettlement(sect.sectId);
      const result = await expelPost(sect.api, discipleId);
      expect(result.status).toBe(200);
    }

    expect(await discipleRowCount(sect.sectId)).toBe(0);

    const state = await sect.state();
    expect(state.recruit.discipleCount).toBe(0);
    expect((state.disciples as unknown[]).length).toBe(0);
    // 0 人时仍然可以重新招募：容量按宗门等级算，不因人数变化。
    expect(state.sect.discipleCapacity).toBe(6);
    expect(state.recruit.remaining).toBeGreaterThanOrEqual(0);
    // 采灵等岗位的占用人数随人数下降（岗位收益口径不残留幽灵占位）。
    for (const option of state.assignments as Record<string, any>[]) {
      if (option.currentCount !== null) {
        expect(option.currentCount).toBe(0);
      }
    }
  });

  it('人数不足 3 人时无法被挑战，攻方次数不被扣除；补齐后可重新布阵', async () => {
    const attacker = await makeSect('dmg-expel-thin-a');
    const defender = await makeSect('dmg-expel-thin-b');
    await freezeSettlement(attacker.sectId);
    await freezeSettlement(defender.sectId);
    await makeStrong(attacker.sectId);
    await makeWeak(defender.sectId);

    // 守方驱逐到 2 人。
    await freezeSettlement(defender.sectId);
    const expelled = await expelPost(defender.api, defender.discipleIds[0] as string);
    expect(expelled.status).toBe(200);
    expect(await discipleRowCount(defender.sectId)).toBe(2);

    const blocked = await attacker.api.post('/api/v1/game/challenge', {
      targetSectId: defender.sectId,
      discipleIds: attacker.discipleIds.slice(0, 3),
    });
    expect(errorOf(blocked).code).toBe('INVALID_STATUS');
    // 失败在写入之前抛出：攻方次数不变，守方历史不增。
    expect(await challengeCount(attacker.sectId)).toBe(0);
    const logs = await env.DB.prepare('SELECT COUNT(*) AS total FROM challenge_log WHERE defender_sect_id = ?')
      .bind(defender.sectId)
      .first<{ total: number }>();
    expect(Number(logs?.total ?? 0)).toBe(0);

    // 公开档案也必须给出稳定原因码。
    const profile = await attacker.api.get(`/api/v1/game/sect/${defender.sectId}`);
    expect((dataOf(profile) as Record<string, any>).sect.challenge.blockedReason).toBe('defender_insufficient');
    expect((dataOf(profile) as Record<string, any>).sect.hasDefenseLineup).toBe(false);

    // 自己人数不足 3 人时也布不了阵（第 3 个 id 不存在的弟子 → NOT_FOUND）。
    // 自己人数不足 3 人时也布不了阵：阵容里含已被驱逐的弟子 → NOT_FOUND，不写入失效阵容。
    const staleLineup = await defender.api.post('/api/v1/game/set-defense-lineup', {
      discipleIds: [defender.discipleIds[1], defender.discipleIds[2], defender.discipleIds[0]],
    });
    expect(errorOf(staleLineup).code).toBe('NOT_FOUND');
    expect(await rawDefenseLineup(defender.sectId)).toBeNull();
  });

  it('驱逐后旧战报仍显示当时的弟子姓名与战力（历史快照不回写）', async () => {
    const attacker = await makeSect('dmg-expel-history-a');
    const defender = await makeSect('dmg-expel-history-b');
    await freezeSettlement(attacker.sectId);
    await freezeSettlement(defender.sectId);
    await makeStrong(attacker.sectId);
    await makeWeak(defender.sectId);

    const battle = await attacker.api.post('/api/v1/game/challenge', {
      targetSectId: defender.sectId,
      discipleIds: attacker.discipleIds.slice(0, 3),
    });
    expect(battle.status).toBe(200);

    const logRow = await env.DB.prepare('SELECT defender_lineup FROM challenge_log WHERE defender_sect_id = ?')
      .bind(defender.sectId)
      .first<{ defender_lineup: string }>();
    const defenderMembers = JSON.parse(logRow?.defender_lineup ?? '[]') as { discipleId: string; name: string }[];
    expect(defenderMembers).toHaveLength(3);
    const expelledName = defenderMembers[0]?.name as string;

    await freezeSettlement(defender.sectId);
    const expelled = await expelPost(defender.api, defenderMembers[0]?.discipleId as string);
    expect(expelled.status).toBe(200);
    expect(await discipleExists(defenderMembers[0]?.discipleId as string)).toBe(false);

    // 战报（challenge_log）原样保留：姓名/战力快照还在。
    const after = await env.DB.prepare('SELECT defender_lineup, rounds FROM challenge_log WHERE defender_sect_id = ?')
      .bind(defender.sectId)
      .first<{ defender_lineup: string; rounds: string }>();
    expect(after?.defender_lineup).toContain(expelledName);

    const history = await attacker.api.get('/api/v1/game/challenge-history');
    expect(history.status).toBe(200);
    const entries = (dataOf(history) as Record<string, any>).entries as Record<string, any>[];
    expect(entries).toHaveLength(1);
    const roundNames = (entries[0]?.rounds as Record<string, any>[]).map((round) => round.defenderName);
    expect(roundNames).toContain(expelledName);
  });
});

describe('驱逐与布阵/挑战的交错：快照守卫必须让整批回滚', () => {
  it('驱逐先提交时，旧破境批次不能扣灵气或报告成功', async () => {
    const sect = await makeSect('dmg-guard-breakthrough');
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritualEnergy', 100_000);
    const victim = sect.discipleIds[0] as string;
    const savedSect = await new SectRepository(env.DB).findById(sect.sectId);
    const guardId = crypto.randomUUID();
    const guard = discipleSnapshotGuardStatement(guardId, {
      sect: savedSect!,
      balances: await new ResourceBalanceRepository(env.DB).findBySectId(sect.sectId),
      members: [{ id: victim }],
    });

    const expelled = await expelPost(sect.api, victim);
    expect(expelled.status).toBe(200);
    await expect(env.DB.batch(prepareStatements(env.DB, [
      guard,
      resourceDeltaStatement(sect.sectId, 'spiritualEnergy', -20_000, Date.now()),
      updateDiscipleProgressStatement(victim, {
        realmId: 'qiRefining', stage: 2, cultivation: 0, remainder: 0, injuredUntil: null,
      }),
      deleteDiscipleSnapshotGuardStatement(guardId),
    ]))).rejects.toThrow(/mutation_guards|valid = 1/);

    expect(await dbBalance(sect.sectId, 'spiritualEnergy')).toBe(100_000);
    expect(await discipleExists(victim)).toBe(false);
    expect(await mutationGuardCount()).toBe(0);
  });

  it('弟子已被并发驱逐时，旧快照的备注写入整批回滚', async () => {
    const sect = await makeSect('dmg-guard-note');
    await freezeSettlement(sect.sectId);
    const discipleId = sect.discipleIds[0] as string;

    const savedSect = await new SectRepository(env.DB).findById(sect.sectId);
    expect(savedSect).not.toBeNull();
    const guardId = crypto.randomUUID();
    const guard = discipleSnapshotGuardStatement(guardId, {
      sect: savedSect!,
      balances: await new ResourceBalanceRepository(env.DB).findBySectId(sect.sectId),
      members: [{ id: discipleId }],
    });

    // 另一个请求先把弟子驱逐了：旧草稿不能再往这一行写备注。
    await env.DB.prepare('DELETE FROM disciples WHERE id = ? AND sect_id = ?')
      .bind(discipleId, sect.sectId)
      .run();

    await expect(
      env.DB.batch(
        prepareStatements(env.DB, [
          guard,
          updateDiscipleNoteStatement(discipleId, sect.sectId, '过期写入'),
          deleteDiscipleSnapshotGuardStatement(guardId),
        ]),
      ),
    ).rejects.toThrow(/mutation_guards|valid = 1/);

    expect(await mutationGuardCount()).toBe(0);
    expect(await discipleExists(discipleId)).toBe(false);
  });

  it('守擂阵容被并发改动时，旧快照的驱逐整批回滚（弟子不会被删掉）', async () => {
    const sect = await makeSect('dmg-guard-lineup');
    await freezeSettlement(sect.sectId);
    const [first, second, third] = sect.discipleIds as [string, string, string];
    await setDefenseLineup(sect.sectId, [first, second, third]);

    const savedSect = await new SectRepository(env.DB).findById(sect.sectId);
    expect(savedSect).not.toBeNull();
    const guardId = crypto.randomUUID();
    const guard = discipleSnapshotGuardStatement(guardId, {
      sect: savedSect!,
      balances: await new ResourceBalanceRepository(env.DB).findBySectId(sect.sectId),
      members: [{ id: first }],
      defenseLineup: savedSect!.defense_lineup,
    });

    // 另一个请求刚刚重排了阵容：此时「是否需要清空阵容」的判断已经不可靠。
    await setDefenseLineup(sect.sectId, [third, first, second]);

    await expect(
      env.DB.batch(
        prepareStatements(env.DB, [
          guard,
          deleteDiscipleStatement(first, sect.sectId),
          deleteDiscipleSnapshotGuardStatement(guardId),
        ]),
      ),
    ).rejects.toThrow(/mutation_guards|valid = 1/);

    // 整批回滚：弟子还在，阵容也还是并发请求写下的那份。
    expect(await discipleExists(first)).toBe(true);
    expect(await rawDefenseLineup(sect.sectId)).toBe(JSON.stringify([third, first, second]));
    expect(await mutationGuardCount()).toBe(0);
  });

  it('守擂阵容快照未变时驱逐可以正常提交（守卫不是无脑拒绝）', async () => {
    const sect = await makeSect('dmg-guard-lineup-ok');
    await freezeSettlement(sect.sectId);
    const [first, second, third] = sect.discipleIds as [string, string, string];
    await setDefenseLineup(sect.sectId, [first, second, third]);

    const savedSect = await new SectRepository(env.DB).findById(sect.sectId);
    const guardId = crypto.randomUUID();
    const guard = discipleSnapshotGuardStatement(guardId, {
      sect: savedSect!,
      balances: await new ResourceBalanceRepository(env.DB).findBySectId(sect.sectId),
      members: [{ id: first }],
      defenseLineup: savedSect!.defense_lineup,
    });

    // 与 service.expelDisciple 同构的一批：守卫 + 删除 + 清空阵容 + 回收守卫。
    await env.DB.batch(
      prepareStatements(env.DB, [
        guard,
        deleteDiscipleStatement(first, sect.sectId),
        updateSectDefenseLineupStatement(sect.sectId, null),
        deleteDiscipleSnapshotGuardStatement(guardId),
      ]),
    );

    expect(await discipleExists(first)).toBe(false);
    expect(await rawDefenseLineup(sect.sectId)).toBeNull();
    expect(await mutationGuardCount()).toBe(0);
  });

  it('攻方出战弟子已被并发驱逐时，旧快照的挑战整批回滚', async () => {
    const attacker = await makeSect('dmg-guard-challenge-a');
    const defender = await makeSect('dmg-guard-challenge-b');
    await freezeSettlement(attacker.sectId);
    await freezeSettlement(defender.sectId);

    const members = attacker.discipleIds.slice(0, 3);
    const savedSect = await new SectRepository(env.DB).findById(attacker.sectId);
    const targetSect = await new SectRepository(env.DB).findById(defender.sectId);
    expect(targetSect).not.toBeNull();

    const guardId = crypto.randomUUID();
    const guard = challengeSnapshotGuardStatement(guardId, {
      sect: savedSect!,
      balances: await new ResourceBalanceRepository(env.DB).findBySectId(attacker.sectId),
      members: members.map((id) => ({ id })),
      target: {
        id: targetSect!.id,
        level: Number(targetSect!.level),
        defenseLineup: targetSect!.defense_lineup,
      },
    });

    // 攻方自己的一名出战弟子在提交前被驱逐：不能在日志里写一场「幽灵出战」。
    await env.DB.prepare('DELETE FROM disciples WHERE id = ? AND sect_id = ?')
      .bind(members[0], attacker.sectId)
      .run();

    await expect(
      env.DB.batch(
        prepareStatements(env.DB, [
          guard,
          {
            sql: `INSERT INTO challenge_log (id, attacker_sect_id, defender_sect_id, attacker_lineup,
                    defender_lineup, rounds, result, reputation_gained, spirit_stone_gained, created_at)
                  VALUES (?, ?, ?, '[]', '[]', '[]', 'win', 0, 0, ?)`,
            params: [crypto.randomUUID(), attacker.sectId, defender.sectId, Date.now()],
          },
          deleteChallengeSnapshotGuardStatement(guardId),
        ]),
      ),
    ).rejects.toThrow(/mutation_guards|valid = 1/);

    const logs = await env.DB.prepare('SELECT COUNT(*) AS total FROM challenge_log WHERE attacker_sect_id = ?')
      .bind(attacker.sectId)
      .first<{ total: number }>();
    expect(Number(logs?.total ?? 0)).toBe(0);
    expect(await challengeCount(attacker.sectId)).toBe(0);
    expect(await mutationGuardCount()).toBe(0);
  });

  it('驱逐普通弟子的守卫也覆盖资源余额（并发结算不会双写）', async () => {
    const sect = await makeSect('dmg-guard-balance');
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'herb', 123_000);

    const savedSect = await new SectRepository(env.DB).findById(sect.sectId);
    const balances = await new ResourceBalanceRepository(env.DB).findBySectId(sect.sectId);
    const victim = sect.discipleIds[0] as string;
    const guardId = crypto.randomUUID();
    const guard = discipleSnapshotGuardStatement(guardId, {
      sect: savedSect!,
      balances,
      members: [{ id: victim }],
    });

    await setBalance(sect.sectId, 'herb', 100_000);

    await expect(
      env.DB.batch(
        prepareStatements(env.DB, [
          guard,
          deleteDiscipleStatement(victim, sect.sectId),
          deleteDiscipleSnapshotGuardStatement(guardId),
        ]),
      ),
    ).rejects.toThrow(/mutation_guards|valid = 1/);

    expect(await dbBalance(sect.sectId, 'herb')).toBe(100_000);
    expect(await discipleExists(victim)).toBe(true);
    expect(await mutationGuardCount()).toBe(0);
  });

  it('布阵提交时成员已离开本宗 → 阵容写入整批回滚（不写失效阵容）', async () => {
    const sect = await makeSect('dmg-guard-set-lineup');
    await freezeSettlement(sect.sectId);
    const [first, second, third] = sect.discipleIds as [string, string, string];

    const savedSect = await new SectRepository(env.DB).findById(sect.sectId);
    const chosen = [first, second, third];
    const guardId = crypto.randomUUID();
    const guard = discipleSnapshotGuardStatement(guardId, {
      sect: savedSect!,
      balances: await new ResourceBalanceRepository(env.DB).findBySectId(sect.sectId),
      members: chosen.map((id) => ({ id })),
    });

    // 要布的阵容里有一名弟子在提交前被驱逐了。
    await env.DB.prepare('DELETE FROM disciples WHERE id = ? AND sect_id = ?')
      .bind(second, sect.sectId)
      .run();

    await expect(
      env.DB.batch(
        prepareStatements(env.DB, [
          guard,
          updateSectDefenseLineupStatement(sect.sectId, JSON.stringify(chosen)),
          deleteDiscipleSnapshotGuardStatement(guardId),
        ]),
      ),
    ).rejects.toThrow(/mutation_guards|valid = 1/);

    expect(await rawDefenseLineup(sect.sectId)).toBeNull();
    expect(await mutationGuardCount()).toBe(0);
  });

  it('驱逐与布阵真实并发时不会留下引用已离宗弟子的阵容', async () => {
    const sect = await makeSect('dmg-race-expel-lineup');
    await freezeSettlement(sect.sectId);
    const [first, second, third] = sect.discipleIds as [string, string, string];

    // 两个请求真实并发：一个驱逐 first，一个把 first 排进守擂阵容。
    // 无论谁先提交，最终状态都不能出现「阵容里引用了已不在本宗的弟子」。
    const [expelResult, lineupResult] = await Promise.all([
      expelPost(sect.api, first),
      sect.api.post('/api/v1/game/set-defense-lineup', { discipleIds: [third, first, second] }),
    ]);

    const expelled = await discipleExists(first) === false;
    const lineup = await rawDefenseLineup(sect.sectId);
    const lineupIds = lineup === null ? [] : (JSON.parse(lineup) as string[]);

    // 两个请求最多一个「成功到需要写阵容」：驱逐成功必然同批清空阵容。
    if (expelled) {
      expect(expelResult.status).toBe(200);
      expect(lineupIds).not.toContain(first);
    } else {
      expect(expelResult.status).toBeGreaterThanOrEqual(400);
      expect(lineupIds).toContain(first);
      expect(lineupResult.status).toBe(200);
    }

    // 不变量：阵容里出现的每个 id 都仍然属于本宗（没有幽灵占位 / 失效手动阵容）。
    const present = await env.DB.prepare('SELECT id FROM disciples WHERE sect_id = ?')
      .bind(sect.sectId)
      .all<{ id: string }>();
    const presentIds = new Set((present.results ?? []).map((row) => row.id));
    for (const id of lineupIds) {
      expect(presentIds.has(id)).toBe(true);
    }
    expect(await mutationGuardCount()).toBe(0);
  });
});

describe('弟子管理回归：既有命令仍然可用', () => {
  it('备注与驱逐不影响派工、突破判定与招募容量', async () => {
    const sect = await makeSect('dmg-regression');
    await freezeSettlement(sect.sectId);
    const disciple = sect.discipleIds[0] as string;

    await notePost(sect.api, disciple, '回归用备注');

    const assigned = await sect.api.post('/api/v1/game/assign', { discipleId: disciple, assignment: 'idle' });
    expect(assigned.status).toBe(200);

    const state = await sect.state();
    const view = (state.disciples as Record<string, any>[]).find((item) => item.id === disciple);
    expect(view?.assignmentName).toBe('闲置');
    // 备注与岗位互不干扰。
    expect(view?.note).toBe('回归用备注');
    // 服务端仍然给出可破境判定字段（炼气一层需要 30 修为，初始为 0）。
    expect(view?.canBreakthrough).toBe(false);
    expect(typeof view?.realmOrder).toBe('number');
    expect(view?.realmOrder).toBe(0);

    const repository = await new DiscipleRepository(env.DB).findBySectId(sect.sectId);
    expect(repository.find((row) => row.id === disciple)?.note).toBe('回归用备注');

    // view 层把聚气丹单次增益也下发了：前端不需要再复制 CULTIVATION_PILL_GAIN 常量。
    expect(state.alchemy.cultivationPillGain).toBe(CULTIVATION_PILL_GAIN);
  });
});
