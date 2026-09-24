import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { dateKeyUtc8 } from '../src/modules/game/constants';
import { discipleCombatPower } from '../src/modules/game/realms';
import {
  attackWorldBoss,
  challengeSect,
  listDiscipleLeaderboard,
  previewJourney,
  processWorldBoss,
} from '../src/modules/game/service';

import { dataOf, TestClient } from './support/authClient';

/**
 * 装备系统 · 一期 阶段一（docs/装备系统开发计划.md 2.2 / 1.2）。
 *
 * 本文件覆盖：0028 迁移（equipment 表 + disciples 的 5 个 gear 列）、
 * 战力接入（弟子视图 / 天骄榜 / 挑战 / 世界 Boss）、历练**不**计入装备。
 * 炼器 / 穿戴 / 分解 / 驱逐接口与 Boss 掉落写在各自的阶段测试里。
 *
 * 存储说明：本文件一份独立内存 D1，没有逐用例回滚 —— 每个用例用独立账号 / 宗门，
 * 断言按宗门 id 定界。
 *
 * 随机说明：战斗路径的浮动与暴击都用 `Math.random`。本文件把它钉成 0.5 ——
 * 浮动系数 0.85 + 0.5 × 0.3 = 1.0，于是「账面战力 = 浮动后的战力」，
 * 断言可以直接和 realm.ts 的 discipleCombatPower 对齐（暴击判定 0.5 > 20% 上限，必然不暴击）。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;
const app = createApp({ logger: quietLogger });
const PASSWORD = 'password-123456';
const DAY_MS = 86_400_000;

let seq = 0;

interface SectFixture {
  api: TestClient;
  userId: string;
  sectId: string;
  discipleIds: string[];
  state: () => Promise<Record<string, any>>;
}

async function makeSect(prefix: string): Promise<SectFixture> {
  seq += 1;
  const account = `${prefix}-${seq}`;
  const api = new TestClient(app, env, {
    'cf-connecting-ip': `10.9.${Math.floor(seq / 250)}.${seq % 250}`,
  });
  const registered = await api.post('/api/v1/auth/register', { account, password: PASSWORD });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `装备${seq}号` });
  expect(created.status).toBe(200);
  const state = dataOf(created) as Record<string, any>;
  const sectId = state.state.sect.id as string;

  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?')
    .bind(sectId)
    .first<{ user_id: string }>();
  expect(row).not.toBeNull();

  return {
    api,
    userId: row!.user_id,
    sectId,
    discipleIds: (state.state.disciples as { id: string }[]).map((item) => item.id),
    state: async () => {
      const result = await api.get('/api/v1/game/sync');
      expect(result.status).toBe(200);
      return (dataOf(result) as Record<string, any>).state;
    },
  };
}

/** 直接写弟子表上的 5 个冗余加成列（阶段二才会有写这 5 列的接口）。 */
async function setGear(
  discipleId: string,
  gear: { attack?: number; defense?: number; speed?: number; luck?: number; physique?: number },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE disciples
        SET gear_attack = ?, gear_defense = ?, gear_speed = ?, gear_luck = ?, gear_physique = ?
      WHERE id = ?`,
  )
    .bind(
      gear.attack ?? 0,
      gear.defense ?? 0,
      gear.speed ?? 0,
      gear.luck ?? 0,
      gear.physique ?? 0,
      discipleId,
    )
    .run();
}

/** 以「今天的 UTC+8 日期」为第 0 天，取第 dayOffset 天 UTC+8 的 hour:minute。 */
function dayAt(dayOffset: number, hour: number, minute = 30): number {
  const parts = dateKeyUtc8(Date.now()).split('-').map(Number);
  return (
    Date.UTC(parts[0] ?? 1970, (parts[1] ?? 1) - 1, parts[2] ?? 1, hour - 8, minute) +
    dayOffset * DAY_MS
  );
}

function discipleOf(state: Record<string, any>, discipleId: string): Record<string, any> {
  const disciple = (state.disciples as { id: string }[]).find((item) => item.id === discipleId);
  expect(disciple).toBeTruthy();
  return disciple as Record<string, any>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('0028 迁移：装备表与弟子加成列', () => {
  it('disciples 的 5 个 gear 列都是 NOT NULL DEFAULT 0', async () => {
    const columns = await env.DB.prepare('PRAGMA table_info(disciples)').all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    const byName = new Map((columns.results ?? []).map((item) => [item.name, item]));
    for (const name of ['gear_attack', 'gear_defense', 'gear_speed', 'gear_luck', 'gear_physique']) {
      const column = byName.get(name);
      expect(column, `${name} 列不存在`).toBeTruthy();
      expect(`${column!.type}|${Number(column!.notnull)}|${column!.dflt_value ?? ''}`).toBe('INTEGER|1|0');
    }
  });

  it('equipment 表与两条索引都在；每名弟子每个部位最多一件（背包行不受限）', async () => {
    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'equipment'",
    ).first<{ name: string }>();
    expect(table?.name).toBe('equipment');

    const indexes = await env.DB.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'equipment'`,
    ).all<{ name: string; sql: string | null }>();
    const byName = new Map((indexes.results ?? []).map((item) => [item.name, item.sql ?? '']));
    expect(byName.has('equipment_sect_idx')).toBe(true);
    // 部分唯一索引：只在 disciple_id 非空时生效（背包里的多件可以同部位）。
    expect(byName.get('equipment_disciple_slot_uniq')).toContain('disciple_id IS NOT NULL');

    const sect = await makeSect('eq-mig');
    const discipleId = sect.discipleIds[0]!;
    const insert = (id: string, disciple: string | null, slot: string) =>
      env.DB.prepare(
        `INSERT INTO equipment
           (id, sect_id, disciple_id, slot, quality, name, main_attr, main_value,
            sub_attr, sub_value, source, created_at)
         VALUES (?, ?, ?, ?, 'common', '凡品·青锋剑', 'attack', 4, 'speed', 1, 'forge', ?)`,
      )
        .bind(id, sect.sectId, disciple, slot, Date.now())
        .run();

    // 背包行（disciple_id IS NULL）同部位可以有任意多件。
    await insert(crypto.randomUUID(), null, 'weapon');
    await insert(crypto.randomUUID(), null, 'weapon');
    // 穿在身上的同一部位只能一件。
    await insert(crypto.randomUUID(), discipleId, 'weapon');
    await expect(insert(crypto.randomUUID(), discipleId, 'weapon')).rejects.toThrow();
  });

  it('新宗门的 5 个加成列默认 0（sync 下发的 gear 全 0）', async () => {
    const sect = await makeSect('eq-default');
    const state = await sect.state();
    expect(sect.discipleIds).toHaveLength(3);
    for (const discipleId of sect.discipleIds) {
      expect(discipleOf(state, discipleId).gear).toEqual({
        attack: 0,
        defense: 0,
        speed: 0,
        luck: 0,
        physique: 0,
      });
    }
  });
});

describe('战力计入装备（计划 1.2）', () => {
  it('弟子视图：战力含装备加成、gear 回显；基础属性本身不变', async () => {
    const sect = await makeSect('eq-view');
    const discipleId = sect.discipleIds[0]!;
    const before = discipleOf(await sect.state(), discipleId);
    const basePower = discipleCombatPower(
      before.realmId,
      Number(before.stage),
      Number(before.attack),
      Number(before.defense),
      Number(before.speed),
      before.talent,
    );
    expect(before.combatPower).toBe(basePower);

    await setGear(discipleId, { attack: 20, defense: 5, speed: 3, luck: 7, physique: 9 });
    const after = discipleOf(await sect.state(), discipleId);
    expect(after.gear).toEqual({ attack: 20, defense: 5, speed: 3, luck: 7, physique: 9 });
    expect(after.combatPower).toBe(
      discipleCombatPower(
        before.realmId,
        Number(before.stage),
        Number(before.attack) + 20,
        Number(before.defense) + 5,
        Number(before.speed) + 3,
        before.talent,
      ),
    );
    expect(after.combatPower).toBeGreaterThan(basePower);
    // 装备只做加成：三项基础属性与综合评分都不动。
    expect(after.attack).toBe(before.attack);
    expect(after.defense).toBe(before.defense);
    expect(after.speed).toBe(before.speed);
    expect(after.attributeScore).toBe(before.attributeScore);
  });

  it('天骄榜：战力榜吃装备加成，综合评分不受影响', async () => {
    const sect = await makeSect('eq-board');
    const discipleId = sect.discipleIds[0]!;
    const before = discipleOf(await sect.state(), discipleId);
    // 给一个夸张的加成，保证它在战力榜上排第一（同库里其它宗门都是裸装）。
    await setGear(discipleId, { attack: 5000, speed: 1000 });
    const board = await listDiscipleLeaderboard(env.DB, sect.userId);
    const top = board.byCombatPower[0];
    expect(top?.discipleId).toBe(discipleId);
    expect(top?.combatPower).toBe(
      discipleCombatPower(
        before.realmId,
        Number(before.stage),
        Number(before.attack) + 5000,
        Number(before.defense),
        Number(before.speed) + 1000,
        before.talent,
      ),
    );
    // 综合评分仍是基础属性算出来的那一份。
    expect(top?.attributeScore).toBe(before.attributeScore);
  });

  it('挑战：战报里的每轮战力就是含装备的战力（攻方）', async () => {
    const attacker = await makeSect('eq-challenge-a');
    const defender = await makeSect('eq-challenge-b');
    const discipleId = attacker.discipleIds[0]!;
    const target = discipleOf(await attacker.state(), discipleId);
    const gear = { attack: 300, defense: 20, speed: 40 };
    await setGear(discipleId, gear);

    // Math.random = 0.5 → 浮动系数 1.0，战报里的数字就是账面战力。
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const challenged = await challengeSect(
      env.DB,
      attacker.userId,
      defender.sectId,
      attacker.discipleIds,
      dayAt(0, 12, 0),
      env,
    );
    const expected = discipleCombatPower(
      target.realmId,
      Number(target.stage),
      Number(target.attack) + gear.attack,
      Number(target.defense) + gear.defense,
      Number(target.speed) + gear.speed,
      target.talent,
    );
    expect(challenged.result.rounds[0]?.attackerPower).toBe(expected);
    // 没穿装备时更低 —— 证明上面那个数字确实吃到了装备。
    expect(expected).toBeGreaterThan(
      discipleCombatPower(
        target.realmId,
        Number(target.stage),
        Number(target.attack),
        Number(target.defense),
        Number(target.speed),
        target.talent,
      ),
    );
  });

  it('世界 Boss：同一关、同一批弟子，穿上装备后这一次出手伤害更高', async () => {
    const sect = await makeSect('eq-boss');
    const discipleId = sect.discipleIds[0]!;
    const noon = dayAt(0, 12, 0);
    // Cron 先生成今天的第 1 关（12:00 在开放时段内）。
    await processWorldBoss(env.DB, noon);

    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const first = await attackWorldBoss(env.DB, sect.userId, { discipleIds: [discipleId] }, noon + 60_000);
    expect(first.result.members[0]?.outcome).toBe('normal');
    await setGear(discipleId, { attack: 300, defense: 100, speed: 100 });
    // 10 秒冷却之后同一名弟子再出手一次。
    const second = await attackWorldBoss(env.DB, sect.userId, { discipleIds: [discipleId] }, noon + 120_000);
    expect(second.result.damage).toBeGreaterThan(first.result.damage);
    expect(second.result.bossHp).toBeLessThan(first.result.bossHp);
  });

  it('历练不计入装备：受伤概率与额外收获只跟基础属性 / 幸运有关', async () => {
    const sect = await makeSect('eq-journey');
    const discipleId = sect.discipleIds[0]!;
    const now = dayAt(0, 12, 0);
    const snapshotOf = (preview: Awaited<ReturnType<typeof previewJourney>>) =>
      preview.directions.map((direction) => ({
        direction: direction.direction,
        durations: direction.durations.map((duration) => ({
          durationSeconds: duration.durationSeconds,
          cultivation: duration.cultivation,
          resources: duration.resources,
          extraChanceBp: duration.extraChanceBp,
          injuryChanceBp: duration.injuryChanceBp,
        })),
      }));

    const base = snapshotOf(await previewJourney(env.DB, sect.userId, discipleId, now));
    // 受伤概率与额外收获都要真的算过（不是 0 占位）。
    expect(base[0]?.durations[0]?.injuryChanceBp).toBeGreaterThan(0);
    expect(base[0]?.durations[0]?.extraChanceBp).toBeGreaterThan(0);

    // 巨量装备（含幸运 / 体魄）：如果历练读了装备，下面这一份必然与上面不同。
    await setGear(discipleId, {
      attack: 5000,
      defense: 5000,
      speed: 5000,
      luck: 80,
      physique: 60,
    });
    expect(snapshotOf(await previewJourney(env.DB, sect.userId, discipleId, now))).toEqual(base);

    // 对照：改**基础**幸运，额外收获概率必须跟着变（证明这份预览确实在按属性现算）。
    await env.DB.prepare('UPDATE disciples SET luck = 100 WHERE id = ?').bind(discipleId).run();
    const withBaseLuck = snapshotOf(await previewJourney(env.DB, sect.userId, discipleId, now));
    expect(withBaseLuck[0]?.durations[0]?.extraChanceBp).toBeGreaterThan(
      base[0]?.durations[0]?.extraChanceBp ?? 0,
    );
  });
});
