import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { AllianceAction, AlliancePanel } from '@xiuxian/contracts';

import { createApp } from '../src/app';
import { actAlliance, getAlliance, processAllianceBosses } from '../src/modules/game/allianceService';
import { dataOf, errorOf, TestClient, type ApiResult } from './support/authClient';

/**
 * 真实 workerd/D1：注册、建宗和仙盟权限均经 app + support/authClient。
 * 独立账号隔离用例；只直接准备声望/历史事实，所有动作与回执均由真实业务写入。
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
const app = createApp({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
const PANEL = '/api/v1/game/alliance';
const ACTION = '/api/v1/game/alliance/action';
const CHAT = '/api/v1/game/alliance/chat';
let sequence = 0;

interface Fixture {
  api: TestClient;
  sectId: string;
  userId: string;
  discipleIds: string[];
}
type ActionInput = AllianceAction extends infer A ? A extends { commandId: string } ? Omit<A, 'commandId'> : never : never;

async function makeSect(): Promise<Fixture> {
  sequence += 1;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.86.${Math.floor(sequence / 250)}.${sequence % 250}` });
  expect((await api.post('/api/v1/auth/register', { account: `alliance-${sequence}`, password: 'password-123456' })).status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `仙盟测试${sequence}` });
  expect(created.status).toBe(200);
  const state = dataOf(created).state as { sect: { id: string }; disciples: { id: string }[] };
  const sectId = state.sect.id;
  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id=?').bind(sectId).first<{ user_id: string }>();
  await env.DB.prepare('UPDATE sects SET reputation=2000,last_settled_at=? WHERE id=?').bind(Date.now() + 86_400_000, sectId).run();
  return { api, sectId, userId: row!.user_id, discipleIds: state.disciples.map(item => item.id) };
}

async function panel(sect: Fixture): Promise<AlliancePanel> {
  const result = await sect.api.get(PANEL);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return dataOf(result).alliance as AlliancePanel;
}
async function action(sect: Fixture, input: ActionInput, commandId = crypto.randomUUID()): Promise<ApiResult> {
  return sect.api.post(ACTION, { ...input, commandId });
}
async function createAlliance(leader: Fixture): Promise<string> {
  const created = await action(leader, { action: 'create', name: `盟${leader.sectId.slice(0, 8)}` });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return (dataOf(created).alliance as AlliancePanel).alliance!.id;
}
async function invite(leader: Fixture, member: Fixture): Promise<string> {
  const invited = await action(leader, { action: 'invite', sectId: member.sectId });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  const view = await panel(member);
  const matching = view.invites.find(item => item.allianceId === (dataOf(invited).alliance as AlliancePanel).alliance!.id);
  expect(matching).toBeDefined();
  return matching!.id;
}
async function join(leader: Fixture, member: Fixture): Promise<void> {
  const inviteId = await invite(leader, member);
  const accepted = await action(member, { action: 'accept', inviteId });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
}
async function reputation(sectId: string): Promise<number> {
  return Number((await env.DB.prepare('SELECT reputation FROM sects WHERE id=?').bind(sectId).first<{ reputation: number }>())!.reputation);
}

describe('仙盟权限、协作奖励与私有聊天', () => {
  it('仙盟读写需要登录，写接口需要CSRF和严格schema，未入盟视图不泄露聊天', async () => {
    const anonymous = new TestClient(app, env);
    expect((await anonymous.get(PANEL)).status).toBe(401);
    expect((await anonymous.post(ACTION, { action: 'create', name: '未登录仙盟', commandId: crypto.randomUUID() })).status).toBe(401);
    const sect = await makeSect();
    const noCsrf = await sect.api.post(ACTION, { action: 'create', name: '无校验仙盟', commandId: crypto.randomUUID() }, { csrfToken: null });
    expect(noCsrf.status).toBe(403);
    const injected = await sect.api.post(ACTION, { action: 'create', name: '注入仙盟', commandId: crypto.randomUUID(), leaderSectId: sect.sectId });
    expect(injected.status).toBe(400);
    expect(errorOf(injected).code).toBe('VALIDATION_ERROR');
    expect((await panel(sect)).alliance).toBeNull();
    expect(await reputation(sect.sectId)).toBe(2000);
  });

  it('创建扣1000声望，同命令回放不重复扣款；同宗不能重复创建且换payload被拒', async () => {
    const leader = await makeSect();
    const commandId = crypto.randomUUID();
    const input = { action: 'create' as const, name: `首盟${sequence}号` };
    const created = await action(leader, input, commandId);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const first = dataOf(created).alliance as AlliancePanel;
    expect(first.alliance).toMatchObject({ leaderSectId: leader.sectId, isLeader: true, memberLimit: 5, active: false });
    expect(first.alliance!.members.map(member => member.sectId)).toEqual([leader.sectId]);
    expect(await reputation(leader.sectId)).toBe(1000);
    const replay = await action(leader, input, commandId);
    expect(replay.status).toBe(200);
    expect(dataOf(replay).result).toEqual(dataOf(created).result);
    expect((dataOf(replay).alliance as AlliancePanel).alliance!.id).toBe(first.alliance!.id);
    expect(await reputation(leader.sectId)).toBe(1000);
    expect(errorOf(await action(leader, { action: 'create', name: '重复创建' })).code).toBe('INVALID_STATUS');
    expect(errorOf(await action(leader, { action: 'create', name: '冲突名字' }, commandId)).code).toBe('VALIDATION_ERROR');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM alliance_members WHERE sect_id=?').bind(leader.sectId).first<{ n: number }>())!.n).toBe(1);
  });

  it('邀请只允许目标宗门接受，成员达到3人激活，同宗不能再加入另一个盟', async () => {
    const leader = await makeSect();
    const member = await makeSect();
    const stranger = await makeSect();
    const allianceId = await createAlliance(leader);
    const inviteId = await invite(leader, member);
    const stolen = await action(stranger, { action: 'accept', inviteId });
    expect(stolen.status).not.toBe(200);
    expect(stolen.status).toBeLessThan(500);
    expect((await panel(stranger)).alliance).toBeNull();
    const accepted = await action(member, { action: 'accept', inviteId });
    expect(accepted.status).toBe(200);
    expect((await panel(member)).alliance).toMatchObject({ id: allianceId, isLeader: false, active: false });
    await join(leader, stranger);
    const active = (await panel(leader)).alliance!;
    expect(active.active).toBe(true);
    expect(active.members).toHaveLength(3);
    expect(errorOf(await action(member, { action: 'create', name: '不许两盟' })).code).toBe('INVALID_STATUS');
    expect(errorOf(await action(member, { action: 'invite', sectId: leader.sectId })).code).toBe('INVALID_STATUS');
  });

  it('两个接受请求争夺最后一席只能一个成功，数据库始终最多5名成员', async () => {
    const leader = await makeSect();
    await createAlliance(leader);
    for (let index = 0; index < 3; index += 1) await join(leader, await makeSect());
    const first = await makeSect();
    const second = await makeSect();
    const firstInvite = await invite(leader, first);
    const secondInvite = await invite(leader, second);
    const results = await Promise.all([
      action(first, { action: 'accept', inviteId: firstInvite }),
      action(second, { action: 'accept', inviteId: secondInvite }),
    ]);
    expect(results.filter(result => result.status === 200)).toHaveLength(1);
    expect(results.some(result => result.status >= 500), JSON.stringify(results)).toBe(false);
    const current = (await panel(leader)).alliance!;
    expect(current.members).toHaveLength(5);
    const memberships = await env.DB.prepare('SELECT COUNT(*) AS n FROM alliance_members WHERE alliance_id=?').bind(current.id).first<{ n: number }>();
    expect(memberships?.n).toBe(5);
  }, 15_000);

  it('盟主转让、踢退与解散按身份检查，退盟钱包保留且24小时冷却含边界', async () => {
    const leader = await makeSect();
    const member = await makeSect();
    const allianceId = await createAlliance(leader);
    await join(leader, member);
    expect(errorOf(await action(member, { action: 'kick', sectId: leader.sectId })).code).toBe('INVALID_STATUS');
    expect(errorOf(await action(member, { action: 'transfer', sectId: leader.sectId })).code).toBe('INVALID_STATUS');
    expect(errorOf(await action(member, { action: 'disband' })).code).toBe('INVALID_STATUS');
    expect(errorOf(await action(leader, { action: 'leave' })).code).toBe('INVALID_STATUS');
    expect(errorOf(await action(leader, { action: 'disband' })).code).toBe('INVALID_STATUS');
    expect((await action(leader, { action: 'transfer', sectId: member.sectId })).status).toBe(200);
    expect((await panel(member)).alliance).toMatchObject({ leaderSectId: member.sectId, isLeader: true });
    expect(errorOf(await action(leader, { action: 'kick', sectId: member.sectId })).code).toBe('INVALID_STATUS');
    await env.DB.prepare('UPDATE sect_alliance_wallets SET merit=321 WHERE sect_id=?').bind(leader.sectId).run();
    const now = Date.now();
    const left = await actAlliance(env.DB, leader.userId, { action: 'leave', commandId: crypto.randomUUID() }, now);
    expect(left.alliance.alliance).toBeNull();
    expect(left.alliance.merit).toBe(321);
    expect(left.alliance.joinCooldownUntil).toBe(new Date(now + 86_400_000).toISOString());
    expect((await action(member, { action: 'disband' })).status).toBe(200);
    const stored = await env.DB.prepare('SELECT dissolved_at FROM alliances WHERE id=?').bind(allianceId).first<{ dissolved_at: number | null }>();
    expect(stored?.dissolved_at).not.toBeNull();
    await expect(actAlliance(env.DB, leader.userId, { action: 'create', name: '冷却重建', commandId: crypto.randomUUID() }, now + 86_400_000 - 1)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    const rebuilt = await actAlliance(env.DB, leader.userId, { action: 'create', name: '冷却边界', commandId: crypto.randomUUID() }, now + 86_400_000);
    expect(rebuilt.alliance.alliance).not.toBeNull();
    expect(rebuilt.alliance.merit).toBe(321);
  }, 15_000);

  it('仙盟聊天只对当前成员可见，跨盟/未入盟/退盟旧scope均拒绝且世界频道不混入', async () => {
    const leader = await makeSect();
    const member = await makeSect();
    const outsider = await makeSect();
    const homeless = await makeSect();
    const allianceId = await createAlliance(leader);
    await join(leader, member);
    const otherAllianceId = await createAlliance(outsider);
    const commandId = crypto.randomUUID();
    const content = `私有仙盟消息${sequence}`;
    const posted = await leader.api.post(CHAT, { allianceId, commandId, content });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect((dataOf(posted).messages as { content: string }[]).map(item => item.content)).toContain(content);
    expect((await leader.api.post(CHAT, { allianceId, commandId, content })).status).toBe(200);
    const viewed = await member.api.get(`${CHAT}?allianceId=${allianceId}`);
    expect(viewed.status).toBe(200);
    expect((dataOf(viewed).messages as { content: string; isMe: boolean }[])).toContainEqual(expect.objectContaining({ content, isMe: false }));
    for (const stranger of [outsider, homeless]) {
      const deniedRead = await stranger.api.get(`${CHAT}?allianceId=${allianceId}`);
      expect(errorOf(deniedRead).code).toBe('INVALID_STATUS');
      expect(JSON.stringify(deniedRead.body)).not.toContain(content);
      expect(errorOf(await stranger.api.post(CHAT, { allianceId, commandId: crypto.randomUUID(), content: '越权消息' })).code).toBe('INVALID_STATUS');
    }
    expect(errorOf(await leader.api.get(`${CHAT}?allianceId=${otherAllianceId}`)).code).toBe('INVALID_STATUS');
    const world = await member.api.get('/api/v1/game/chat');
    expect(world.status).toBe(200);
    expect(JSON.stringify(dataOf(world))).not.toContain(content);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE channel='alliance' AND scope_id=? AND content=?").bind(allianceId, content).first<{ n: number }>();
    expect(count?.n).toBe(1);
    expect((await action(member, { action: 'leave' })).status).toBe(200);
    const staleRead = await member.api.get(`${CHAT}?allianceId=${allianceId}`);
    expect(errorOf(staleRead).code).toBe('INVALID_STATUS');
    expect(JSON.stringify(staleRead.body)).not.toContain(content);
    expect(errorOf(await member.api.post(CHAT, { allianceId, commandId: crypto.randomUUID(), content: '旧scope消息' })).code).toBe('INVALID_STATUS');
    const otherChat = await outsider.api.get(`${CHAT}?allianceId=${otherAllianceId}`);
    expect(otherChat.status).toBe(200);
    expect(JSON.stringify(dataOf(otherChat))).not.toContain(content);
  }, 15_000);

  it('聊天输入与频率受控，同commandId换内容拒绝，非法消息不落库', async () => {
    const leader = await makeSect();
    const allianceId = await createAlliance(leader);
    const commandId = crypto.randomUUID();
    const first = await leader.api.post(CHAT, { allianceId, commandId, content: '有效消息' });
    expect(first.status).toBe(200);
    expect(errorOf(await leader.api.post(CHAT, { allianceId, commandId, content: '更换内容' })).code).toBe('VALIDATION_ERROR');
    expect(errorOf(await leader.api.post(CHAT, { allianceId, commandId: crypto.randomUUID(), content: '频率限制' })).code).toBe('INVALID_STATUS');
    for (const content of ['   ', 'x'.repeat(201), '控制\u0001字符']) {
      const invalid = await leader.api.post(CHAT, { allianceId, commandId: crypto.randomUUID(), content });
      expect(errorOf(invalid).code).toBe('VALIDATION_ERROR');
    }
    const stored = await env.DB.prepare("SELECT content FROM chat_messages WHERE channel='alliance' AND scope_id=?").bind(allianceId).all<{ content: string }>();
    expect(stored.results.map(row => row.content)).toEqual(['有效消息']);
  });

  it('盟主踢人立即撤销旧仙盟读写权限，解散后盟主旧聊天scope也失效', async () => {
    const leader = await makeSect();
    const member = await makeSect();
    const allianceId = await createAlliance(leader);
    await join(leader, member);
    const secret = '踢退前的仙盟消息';
    expect((await leader.api.post(CHAT, { allianceId, commandId: crypto.randomUUID(), content: secret })).status).toBe(200);
    expect((await action(leader, { action: 'kick', sectId: member.sectId })).status).toBe(200);
    expect((await panel(member)).alliance).toBeNull();
    expect((await panel(member)).joinCooldownUntil).not.toBeNull();
    const kicked = await member.api.get(`${CHAT}?allianceId=${allianceId}`);
    expect(errorOf(kicked).code).toBe('INVALID_STATUS');
    expect(JSON.stringify(kicked.body)).not.toContain(secret);
    expect(errorOf(await member.api.post(CHAT, { allianceId, commandId: crypto.randomUUID(), content: '被踢后发言' })).code).toBe('INVALID_STATUS');
    expect((await action(leader, { action: 'disband' })).status).toBe(200);
    expect(errorOf(await leader.api.get(`${CHAT}?allianceId=${allianceId}`)).code).toBe('INVALID_STATUS');
    expect(errorOf(await leader.api.post(CHAT, { allianceId, commandId: crypto.randomUUID(), content: '解散后发言' })).code).toBe('INVALID_STATUS');
    const messages = await env.DB.prepare("SELECT content FROM chat_messages WHERE channel='alliance' AND scope_id=?").bind(allianceId).all<{ content: string }>();
    expect(messages.results.map(row => row.content)).toEqual([secret]);
  }, 15_000);

  it('声望不足创建不生效，盟贡头像框只购买一次，余额仅够一次的并发兑换不透支', async () => {
    const sect = await makeSect();
    await env.DB.prepare('UPDATE sects SET reputation=999 WHERE id=?').bind(sect.sectId).run();
    expect(errorOf(await action(sect, { action: 'create', name: '声望不足' })).code).toBe('INSUFFICIENT_RESOURCE');
    expect(await reputation(sect.sectId)).toBe(999);
    expect((await panel(sect)).alliance).toBeNull();
    const now = Date.now();
    await env.DB.prepare('INSERT INTO sect_alliance_wallets(sect_id,merit,version,updated_at) VALUES(?,600,0,?)').bind(sect.sectId, now).run();
    const commandId = crypto.randomUUID();
    const frame = await action(sect, { action: 'buy', id: 'frame-alliance' }, commandId);
    expect(frame.status).toBe(200);
    expect((dataOf(frame).alliance as AlliancePanel).merit).toBe(100);
    expect((await action(sect, { action: 'buy', id: 'frame-alliance' }, commandId)).status).toBe(200);
    // 补足余额，保证拒绝来自已拥有而非余额不足。
    await env.DB.prepare('UPDATE sect_alliance_wallets SET merit=500 WHERE sect_id=?').bind(sect.sectId).run();
    expect(errorOf(await action(sect, { action: 'buy', id: 'frame-alliance' })).code).toBe('INVALID_STATUS');
    expect((await panel(sect)).merit).toBe(500);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sect_cosmetics WHERE sect_id=? AND cosmetic_id='frame-alliance'").bind(sect.sectId).first<{ n: number }>())!.n).toBe(1);
    await env.DB.prepare('UPDATE sect_alliance_wallets SET merit=100 WHERE sect_id=?').bind(sect.sectId).run();
    const before = Number((await env.DB.prepare("SELECT balance FROM resource_balances WHERE sect_id=? AND resource_id='shenmu'").bind(sect.sectId).first<{ balance: number }>())!.balance);
    const raced = await Promise.all([1, 2].map(() => action(sect, { action: 'buy', id: 'shenmu-5' })));
    expect(raced.filter(result => result.status === 200)).toHaveLength(1);
    expect(raced.some(result => result.status >= 500), JSON.stringify(raced)).toBe(false);
    expect((await panel(sect)).merit).toBe(0);
    expect(Number((await env.DB.prepare("SELECT balance FROM resource_balances WHERE sect_id=? AND resource_id='shenmu'").bind(sect.sectId).first<{ balance: number }>())!.balance)).toBe(before + 5000);
  }, 15_000);

  it('盟BOSS每天限3次，同命令伤害只记一次，未结战绩期间禁止成员离开', async () => {
    const leader = await makeSect();
    const member = await makeSect();
    const third = await makeSect();
    await createAlliance(leader);
    expect(errorOf(await action(leader, { action: 'attack', discipleIds: [leader.discipleIds[0]!] })).code).toBe('INVALID_STATUS');
    await join(leader, member);
    await join(leader, third);
    const initial = (await panel(leader)).boss!;
    expect(initial).toMatchObject({ maxHp: 1_000_000, remainingHp: 1_000_000, attackLimit: 3, attacksToday: 0 });
    const commandId = crypto.randomUUID();
    const input = { action: 'attack' as const, discipleIds: [leader.discipleIds[0]!] };
    const first = await action(leader, input, commandId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const damaged = (dataOf(first).alliance as AlliancePanel).boss!;
    expect(damaged.remainingHp).toBeLessThan(initial.remainingHp);
    const replay = await action(leader, input, commandId);
    expect(replay.status).toBe(200);
    expect((dataOf(replay).alliance as AlliancePanel).boss!.remainingHp).toBe(damaged.remainingHp);
    expect((dataOf(replay).alliance as AlliancePanel).boss!.attacksToday).toBe(1);
    expect(errorOf(await action(member, { action: 'leave' })).code).toBe('INVALID_STATUS');
    expect(errorOf(await action(leader, { action: 'attack', discipleIds: [member.discipleIds[0]!] })).code).toBe('NOT_FOUND');
    expect((await action(leader, input)).status).toBe(200);
    expect((await action(leader, input)).status).toBe(200);
    expect(errorOf(await action(leader, input)).code).toBe('DAILY_LIMIT');
    const hits = await env.DB.prepare('SELECT COUNT(*) AS n,SUM(damage) AS damage FROM alliance_boss_hits WHERE boss_id=? AND sect_id=?')
      .bind(initial.id, leader.sectId).first<{ n: number; damage: number }>();
    expect(hits?.n).toBe(3);
    expect((await panel(leader)).boss!.damage).toBe(hits?.damage);
  }, 15_000);

  it('击杀和周超时奖励均只能结算一次；退盟钱包保留且盟贡商店精确扣款', async () => {
    const leader = await makeSect();
    const member = await makeSect();
    const third = await makeSect();
    const allianceId = await createAlliance(leader);
    await join(leader, member);
    await join(leader, third);
    const boss = (await panel(leader)).boss!;
    // 准备已被盟友打至最后1血的真实持久状态，再由HTTP完成最后一击。
    await env.DB.prepare('UPDATE alliance_bosses SET remaining_hp=1 WHERE id=?').bind(boss.id).run();
    const killed = await action(leader, { action: 'attack', discipleIds: [leader.discipleIds[0]!] });
    expect(killed.status, JSON.stringify(killed.body)).toBe(200);
    expect((dataOf(killed).alliance as AlliancePanel).merit).toBe(300);
    await Promise.all([processAllianceBosses(env.DB, Date.now()), processAllianceBosses(env.DB, Date.now())]);
    expect((await panel(leader)).merit).toBe(300);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM alliance_boss_rewards WHERE boss_id=?').bind(boss.id).first<{ n: number }>())!.n).toBe(1);
    expect((await action(leader, { action: 'transfer', sectId: member.sectId })).status).toBe(200);
    expect((await action(leader, { action: 'leave' })).status).toBe(200);
    expect((await panel(leader)).merit).toBe(300);
    const before = Number((await env.DB.prepare("SELECT balance FROM resource_balances WHERE sect_id=? AND resource_id='xuantie'").bind(leader.sectId).first<{ balance: number }>())!.balance);
    await env.DB.prepare('UPDATE sects SET last_settled_at=? WHERE id=?').bind(Date.now() + 86_400_000, leader.sectId).run();
    const buyId = crypto.randomUUID();
    const bought = await action(leader, { action: 'buy', id: 'xuantie-10' }, buyId);
    expect(bought.status).toBe(200);
    expect((dataOf(bought).alliance as AlliancePanel).merit).toBe(200);
    expect((await action(leader, { action: 'buy', id: 'xuantie-10' }, buyId)).status).toBe(200);
    expect(Number((await env.DB.prepare("SELECT balance FROM resource_balances WHERE sect_id=? AND resource_id='xuantie'").bind(leader.sectId).first<{ balance: number }>())!.balance)).toBe(before + 10_000);
    expect(errorOf(await action(leader, { action: 'buy', id: 'frame-alliance' })).code).toBe('INSUFFICIENT_RESOURCE');

    const week = Date.now() + 8 * 86_400_000;
    const next = (await getAlliance(env.DB, member.userId, week)).alliance.boss;
    // 退盟后仅剩2人不激活；第三人重新加入后下一周BOSS才能创建。
    expect(next).toBeNull();
    const extra = await makeSect();
    await join(member, extra);
    const nextBoss = (await getAlliance(env.DB, member.userId, week)).alliance.boss!;
    const hitAt = week;
    await env.DB.prepare('UPDATE sects SET last_settled_at=? WHERE id=?').bind(hitAt + 86_400_000, member.sectId).run();
    const hit = await actAlliance(env.DB, member.userId, { action: 'attack', discipleIds: [member.discipleIds[0]!], commandId: crypto.randomUUID() }, hitAt);
    expect(hit.alliance.boss!.remainingHp).toBeLessThan(1_000_000);
    const endsAt = Date.parse(nextBoss.endsAt);
    await Promise.all([processAllianceBosses(env.DB, endsAt), processAllianceBosses(env.DB, endsAt)]);
    await processAllianceBosses(env.DB, endsAt + 1);
    const reward = await env.DB.prepare('SELECT merit FROM alliance_boss_rewards WHERE boss_id=? AND sect_id=?').bind(nextBoss.id, member.sectId).first<{ merit: number }>();
    expect(reward?.merit).toBe(300);
    const wallet = await env.DB.prepare('SELECT merit FROM sect_alliance_wallets WHERE sect_id=?').bind(member.sectId).first<{ merit: number }>();
    expect(wallet?.merit).toBe(300);
    const alliance = await env.DB.prepare('SELECT id FROM alliances WHERE id=?').bind(allianceId).first();
    expect(alliance).not.toBeNull();
  }, 20_000);
});
