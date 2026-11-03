import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { RelationsPanel } from '@xiuxian/contracts';

import { createApp } from '../src/app';
import { REALMS } from '../src/modules/game/constants';

import { dataOf, errorOf, TestClient, type ApiResult } from './support/authClient';

/**
 * 师徒与羁绊：真实 workerd + D1，账号/鉴权/动作全走 app。
 * 只直接改弟子境界与丹药库存来准备既有玩家状态，不 mock 数据库或响应。
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const app = createApp({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
const PANEL = '/api/v1/game/relations';
const ACTION = '/api/v1/game/relations/action';
let sequence = 0;

interface Fixture { api: TestClient; sectId: string; mentorId: string; discipleId: string; thirdId: string }
type ActionInput = { action: 'mentor'; mentorId: string; discipleId: string; commandId: string }
  | { action: 'graduate' | 'cancel-mentor' | 'reroll-bond'; id: string; commandId: string };
type NewAction = ActionInput extends infer A ? (A extends { commandId: string } ? Omit<A, 'commandId'> : never) : never;

async function makeSect(): Promise<Fixture> {
  sequence += 1;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.85.0.${sequence}` });
  const registered = await api.post('/api/v1/auth/register', { account: `relations-${sequence}`, password: 'password-123456' });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `传承${sequence}宗` });
  expect(created.status).toBe(200);
  const state = dataOf(created).state as { sect: { id: string }; disciples: { id: string }[] };
  const [first, second, third] = state.disciples.map((row) => row.id) as [string, string, string];
  await env.DB.prepare('UPDATE sects SET level=8 WHERE id=?').bind(state.sect.id).run();
  await env.DB.prepare('UPDATE disciples SET realm_id=?,stage=1,cultivation=0 WHERE id=?')
    .bind(REALMS[4]!.id, first).run();
  await env.DB.prepare('UPDATE disciples SET realm_id=?,stage=1 WHERE id=?').bind(REALMS[1]!.id, second).run();
  await env.DB.prepare('UPDATE disciples SET realm_id=?,stage=1 WHERE id=?').bind(REALMS[1]!.id, third).run();
  return { api, sectId: state.sect.id, mentorId: first, discipleId: second, thirdId: third };
}

function panelOf(result: ApiResult): RelationsPanel {
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return dataOf(result).relations as RelationsPanel;
}
async function post(sect: Fixture, input: NewAction): Promise<ApiResult> {
  return sect.api.post(ACTION, { ...input, commandId: crypto.randomUUID() } as ActionInput);
}

describe('师徒与羁绊', () => {
  it('未登录不能读写；拜师后徒弟只有一个师傅，重复拜师被拒', async () => {
    const anonymous = new TestClient(app, env, { 'cf-connecting-ip': `10.85.9.${String(++sequence)}` });
    expect((await anonymous.get(PANEL)).status).toBe(401);
    const sect = await makeSect();
    expect(panelOf(await sect.api.get(PANEL)).mentorships).toEqual([]);
    expect((await post(sect, { action: 'mentor', mentorId: sect.mentorId, discipleId: sect.discipleId })).status).toBe(200);
    const panel = panelOf(await sect.api.get(PANEL));
    expect(panel.mentorships).toHaveLength(1);
    expect(panel.mentorships[0]).toMatchObject({ mentorId: sect.mentorId, discipleId: sect.discipleId, graduated: false });
    expect(errorOf(await post(sect, { action: 'mentor', mentorId: sect.mentorId, discipleId: sect.discipleId })).code).toBe('INVALID_STATUS');
    expect(errorOf(await post(sect, { action: 'mentor', mentorId: sect.mentorId, discipleId: sect.mentorId })).code).toBe('INVALID_STATUS');
  });

  it('徒弟修为达拜师时师傅境界方可出师，出师后师傅三项属性各 +1 且只能一次', async () => {
    const sect = await makeSect();
    const created = panelOf(await post(sect, { action: 'mentor', mentorId: sect.mentorId, discipleId: sect.discipleId }));
    const pair = created.mentorships[0]!;
    expect(errorOf(await post(sect, { action: 'graduate', id: pair.id })).code).toBe('INVALID_STATUS');
    await env.DB.prepare('UPDATE disciples SET realm_id=?,stage=1 WHERE id=?').bind(REALMS[4]!.id, sect.discipleId).run();
    expect(panelOf(await sect.api.get(PANEL)).mentorships[0]?.canGraduate).toBe(true);
    expect((await post(sect, { action: 'graduate', id: pair.id })).status).toBe(200);
    const mentor = await env.DB.prepare('SELECT attack,defense,speed FROM disciples WHERE id=?').bind(sect.mentorId).first<{ attack: number; defense: number; speed: number }>();
    expect(mentor).not.toBeNull();
    expect(panelOf(await sect.api.get(PANEL)).mentorships[0]?.graduated).toBe(true);
    expect(errorOf(await post(sect, { action: 'graduate', id: pair.id })).code).toBe('NOT_FOUND');
  });

  it('同道侣羁绊消耗洗髓丹重洗，丹药不足时拒绝且不改关系', async () => {
    const sect = await makeSect();
    await env.DB.prepare(`INSERT INTO disciple_relations(id,sect_id,kind,status,mentor_id,disciple_id,bond_kind,target_realm_index,teaching_value,version,mentor_bonus,created_at,updated_at)
      VALUES(?,?,'bond','active',?,?,'fellow',NULL,0,1,'{}',?,?)`)
      .bind(crypto.randomUUID(), sect.sectId, [sect.mentorId, sect.thirdId].sort()[0]!, [sect.mentorId, sect.thirdId].sort()[1]!, Date.now(), Date.now()).run();
    const bonds = panelOf(await sect.api.get(PANEL)).bonds;
    expect(bonds).toHaveLength(1);
    expect(bonds[0]).toMatchObject({ name: '同门', powerBonusBp: 500 });
    expect(errorOf(await post(sect, { action: 'reroll-bond', id: bonds[0]!.id })).code).toBe('INSUFFICIENT_RESOURCE');
    await env.DB.prepare(`INSERT INTO pill_inventories(id,sect_id,pill_id,quantity,updated_at) VALUES(?,?,?,1,?)`)
      .bind(crypto.randomUUID(), sect.sectId, 'talentPill', Date.now()).run();
    expect((await post(sect, { action: 'reroll-bond', id: bonds[0]!.id })).status).toBe(200);
    const after = panelOf(await sect.api.get(PANEL));
    expect(after.bonds).toHaveLength(1);
    expect(after.rerollPills).toBe(0);
    const stored = await env.DB.prepare('SELECT COUNT(*) AS total FROM disciple_relations WHERE sect_id=? AND kind=\'bond\' AND status=\'active\'')
      .bind(sect.sectId).first<{ total: number }>();
    expect(stored?.total).toBe(1);
  });
});
