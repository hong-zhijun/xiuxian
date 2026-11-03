import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import type { RebirthPanel } from '@xiuxian/contracts';

import { createApp } from '../src/app';
import { dateKeyUtc8 } from '../src/modules/game/constants';
import { REBIRTH_DISCIPLE_CAPACITY, REBIRTH_RETAIN_PERCENT } from '../src/modules/game/rebirth';
import { dataOf, errorOf, TestClient, type ApiResult } from './support/authClient';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const app = createApp({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
const REBIRTH = '/api/v1/game/rebirth';
const ACTION = '/api/v1/game/rebirth/action';
const PASSWORD = 'password-123456';
const DAY = 86_400_000;
let sequence = 0;

interface Fixture {
  api: TestClient;
  sectId: string;
  userId: string;
  discipleIds: string[];
}

async function makeSect(): Promise<Fixture> {
  sequence += 1;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.84.0.${sequence}` });
  const registered = await api.post('/api/v1/auth/register', {
    account: `rebirth-${sequence}`,
    password: PASSWORD,
  });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `开界${sequence}宗` });
  expect(created.status).toBe(200);
  const state = dataOf(created).state as {
    sect: { id: string };
    disciples: { id: string }[];
  };
  const sectId = state.sect.id;
  const owner = await env.DB.prepare('SELECT user_id FROM sects WHERE id=?')
    .bind(sectId).first<{ user_id: string }>();
  expect(owner).not.toBeNull();
  await freeze(sectId);
  return { api, sectId, userId: owner!.user_id, discipleIds: state.disciples.map(row => row.id) };
}

async function freeze(sectId: string, now = Date.now()): Promise<void> {
  await env.DB.prepare('UPDATE sects SET last_settled_at=? WHERE id=?').bind(now + DAY, sectId).run();
}

async function setEligible(sect: Fixture): Promise<void> {
  await env.DB.prepare('UPDATE sects SET level=15 WHERE id=?').bind(sect.sectId).run();
  await env.DB.prepare(`UPDATE disciples SET ascension_level=1,realm_id='tribulation',stage=3,
    cultivation=0,cultivation_remainder=0,ascension_pity=0 WHERE id=?`)
    .bind(sect.discipleIds[0]).run();
  await freeze(sect.sectId);
}

async function setBalance(sectId: string, resourceId: string, value: number): Promise<void> {
  await env.DB.prepare(`INSERT INTO resource_balances(id,sect_id,resource_id,balance,remainder,updated_at)
    VALUES(?,?,?,?,0,?) ON CONFLICT(sect_id,resource_id) DO UPDATE SET balance=excluded.balance,remainder=0`)
    .bind(crypto.randomUUID(), sectId, resourceId, value, Date.now()).run();
}

async function balance(sectId: string, resourceId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT balance FROM resource_balances WHERE sect_id=? AND resource_id=?')
    .bind(sectId, resourceId).first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

async function panel(sect: Fixture): Promise<RebirthPanel> {
  await freeze(sect.sectId);
  const result = await sect.api.get(REBIRTH);
  expect(result.status).toBe(200);
  return dataOf(result).rebirth as RebirthPanel;
}

async function action(sect: Fixture, body: Record<string, unknown>): Promise<ApiResult> {
  await freeze(sect.sectId);
  return sect.api.post(ACTION, body);
}

function commandId(): string {
  return crypto.randomUUID();
}

describe('转生与开界：真实 workerd D1 集成', () => {
  it('GET/POST 需要鉴权，资格按宗门等级与成仙弟子实时判断，预览固定30%资源', async () => {
    const anonymous = new TestClient(app, env);
    expect((await anonymous.get(REBIRTH)).status).toBe(401);
    expect((await anonymous.post(ACTION, {
      action: 'rebirth', commandId: commandId(), expectedVersion: 0,
    })).status).toBe(401);

    const sect = await makeSect();
    const initial = await panel(sect);
    expect(initial).toMatchObject({ cycle: 0, daoYun: 0, version: 0, eligible: false, retainPercent: REBIRTH_RETAIN_PERCENT });
    expect(initial.blockedReasons.join(' ')).toContain('十五级');

    await env.DB.prepare('UPDATE sects SET level=15 WHERE id=?').bind(sect.sectId).run();
    const noImmortal = await panel(sect);
    expect(noImmortal.eligible).toBe(false);
    expect(noImmortal.blockedReasons.join(' ')).toContain('成仙');

    await setBalance(sect.sectId, 'spiritStone', 1_234_567);
    await setEligible(sect);
    const eligible = await panel(sect);
    expect(eligible.eligible).toBe(true);
    expect(eligible.previewResources.find(row => row.id === 'spiritStone')).toMatchObject({ before: '1234567', after: '370370' });
    expect(eligible.gainDaoYun).toBe(100);
    expect(eligible.discipleCapacityFloor).toBeGreaterThanOrEqual(REBIRTH_DISCIPLE_CAPACITY);
    expect(eligible.nextBonuses).toEqual({ productionBp: 1000, breakthroughBp: 500, powerBp: 500 });
  });

  it('符合资格时原子转生：周目/道韵/容量与永久加成增加，弟子及建筑保留而境界、资源重置', async () => {
    const sect = await makeSect();
    await setEligible(sect);
    const firstDisciple = sect.discipleIds[0]!;
    await env.DB.prepare("UPDATE disciples SET assignment='herb',realm_id='tribulation',stage=3,cultivation=999,cultivation_remainder=7,ascension_level=1 WHERE id=?")
      .bind(firstDisciple).run();
    await setBalance(sect.sectId, 'spiritStone', 1_234_567);
    await setBalance(sect.sectId, 'ore', 1001);
    const beforeCount = sect.discipleIds.length;
    const command = commandId();
    const result = await action(sect, { action: 'rebirth', commandId: command, expectedVersion: 0 });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const rebirth = dataOf(result).rebirth as RebirthPanel;
    expect(rebirth).toMatchObject({ cycle: 1, daoYun: 100, version: 1, eligible: false, discipleCapacityFloor: 64, buildingCapacityFloor: 8 });
    expect(rebirth.bonuses).toEqual({ productionBp: 1000, breakthroughBp: 500, powerBp: 500 });

    const sectRow = await env.DB.prepare('SELECT level FROM sects WHERE id=?').bind(sect.sectId).first<{ level: number }>();
    expect(Number(sectRow?.level)).toBe(1);
    const disciples = await env.DB.prepare(`SELECT id,realm_id,stage,cultivation,cultivation_remainder,ascension_level,assignment
      FROM disciples WHERE sect_id=? ORDER BY created_at,id`).bind(sect.sectId).all<{
      id: string; realm_id: string; stage: number; cultivation: number; cultivation_remainder: number;
      ascension_level: number; assignment: string;
    }>();
    expect(disciples.results).toHaveLength(beforeCount);
    expect(disciples.results.every(row => row.realm_id === 'qiRefining' && Number(row.stage) === 1 && Number(row.cultivation) === 0
      && Number(row.cultivation_remainder) === 0 && Number(row.ascension_level) === 0 && row.assignment === 'idle')).toBe(true);
    expect(await balance(sect.sectId, 'spiritStone')).toBe(370_370);
    expect(await balance(sect.sectId, 'ore')).toBe(300);
    const stored = await env.DB.prepare(`SELECT cycle,dao_yun,bonus_production_bp,bonus_breakthrough_bp,bonus_power_bp,
      disciple_capacity_floor,building_capacity_floor,version FROM sect_rebirth WHERE sect_id=?`).bind(sect.sectId).first();
    expect(stored).toEqual({ cycle: 1, dao_yun: 100, bonus_production_bp: 1000, bonus_breakthrough_bp: 500,
      bonus_power_bp: 500, disciple_capacity_floor: 64, building_capacity_floor: 8, version: 1 });
  });

  it('同 commandId 跨请求回放不重复转生；同命令换操作或旧版本被拒，两个宗门状态互不影响', async () => {
    const sect = await makeSect();
    await setEligible(sect);
    await setBalance(sect.sectId, 'spiritStone', 1_000);
    const command = commandId();
    const first = await action(sect, { action: 'rebirth', commandId: command, expectedVersion: 0 });
    expect(first.status).toBe(200);
    const replay = await action(sect, { action: 'rebirth', commandId: command, expectedVersion: 0 });
    expect(replay.status).toBe(200);
    expect(dataOf(replay).result).toEqual(dataOf(first).result);
    expect((dataOf(replay).rebirth as RebirthPanel).cycle).toBe(1);
    const conflicting = await action(sect, { action: 'buy', id: 'frame-astral', commandId: command, expectedVersion: 0 });
    expect(conflicting.status).toBe(400);
    expect(errorOf(conflicting).code).toBe('VALIDATION_ERROR');
    const stale = await action(sect, { action: 'buy', id: 'frame-astral', commandId: commandId(), expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect(errorOf(stale).code).toBe('INVALID_STATUS');
    const other = await makeSect();
    await setEligible(other);
    const otherCommand = await action(other, { action: 'rebirth', commandId: command, expectedVersion: 0 });
    expect(otherCommand.status).toBe(200);
    expect((await panel(other)).cycle).toBe(1);
    expect((await panel(sect)).cycle).toBe(1);
  });

  it('并发转生只有一次成功，不能重复领取道韵或折损资源', async () => {
    const sect = await makeSect();
    await setEligible(sect);
    await setBalance(sect.sectId, 'spiritStone', 1_000_000);
    const responses = await Promise.all([1, 2].map(() => sect.api.post(ACTION, {
      action: 'rebirth', commandId: commandId(), expectedVersion: 0,
    })));
    expect(responses.filter(response => response.status === 200)).toHaveLength(1);
    expect(responses.some(response => response.status >= 500), JSON.stringify(responses)).toBe(false);
    expect((await panel(sect)).cycle).toBe(1);
    expect((await panel(sect)).daoYun).toBe(100);
    expect(await balance(sect.sectId, 'spiritStone')).toBe(300_000);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM rebirth_commands WHERE sect_id=?').bind(sect.sectId).first<{ n: number }>();
    expect(Number(row?.n)).toBe(1);
  });

  it('转生后道韵商店按余额与限购扣款，第二轮成长加成可真实持久化', async () => {
    const sect = await makeSect();
    await setEligible(sect);
    expect((await action(sect, { action: 'buy', id: 'bonus-production', commandId: commandId(), expectedVersion: 0 })).status).toBe(409);
    const reborn = await action(sect, { action: 'rebirth', commandId: commandId(), expectedVersion: 0 });
    expect(reborn.status).toBe(200);
    const version = (dataOf(reborn).rebirth as RebirthPanel).version;
    const buy = await action(sect, { action: 'buy', id: 'bonus-production', commandId: commandId(), expectedVersion: version });
    expect(buy.status).toBe(200);
    expect((dataOf(buy).rebirth as RebirthPanel).daoYun).toBe(0);
    expect((dataOf(buy).rebirth as RebirthPanel).bonuses.productionBp).toBe(1100);
    expect((await panel(sect)).shop.find(item => item.id === 'bonus-production')).toMatchObject({ purchased: 1, canBuy: false });
    expect(errorOf(await action(sect, { action: 'buy', id: 'bonus-production', commandId: commandId(), expectedVersion: (await panel(sect)).version })).code).toBe('INSUFFICIENT_RESOURCE');
    const metadata = await env.DB.prepare('SELECT bonus_production_bp FROM sect_rebirth WHERE sect_id=?').bind(sect.sectId).first<{ bonus_production_bp: number }>();
    expect(Number(metadata?.bonus_production_bp)).toBe(1100);
  });

  it('资源余数归零，建筑装备功法丹药、成长领取和当天额度原样保留', async () => {
    const sect = await makeSect();
    await setEligible(sect);
    const now = Date.now();
    const today = dateKeyUtc8(now);
    const equipmentId = commandId();
    await env.DB.batch([
      env.DB.prepare('UPDATE buildings SET level=7 WHERE sect_id=?').bind(sect.sectId),
      env.DB.prepare('UPDATE sects SET reputation=543,recruit_date_key=?,recruit_count=7,challenge_date_key=?,challenge_count=3,debate_date_key=?,debate_count=20 WHERE id=?').bind(today, today, today, sect.sectId),
      env.DB.prepare('UPDATE disciples SET body_tempering_count=3,note=?,technique_id=?,technique_prof_base=5000,technique_since=NULL WHERE id=?').bind('保留的弟子笔记', 'qingfeng', sect.discipleIds[0]),
      env.DB.prepare('UPDATE resource_balances SET remainder=271 WHERE sect_id=?').bind(sect.sectId),
      env.DB.prepare("INSERT INTO equipment(id,sect_id,disciple_id,slot,quality,name,main_attr,main_value,sub_attr,sub_value,source,created_at) VALUES(?,?,NULL,'weapon','spirit','保留法剑','attack',20,'speed',8,'forge',?)").bind(equipmentId, sect.sectId, now),
      env.DB.prepare("INSERT INTO sect_techniques(sect_id,technique_id,level,scrolls) VALUES(?,'qingfeng',3,17)").bind(sect.sectId),
      env.DB.prepare("INSERT INTO pill_inventories(id,sect_id,pill_id,quantity,updated_at) VALUES(?,?,'cultivationPill',9,?) ON CONFLICT(sect_id,pill_id) DO UPDATE SET quantity=9").bind(commandId(), sect.sectId, now),
      env.DB.prepare("INSERT INTO sect_progression(sect_id,version,production_bonus_bp,rename_tokens,equipped_frame,equipped_title,updated_at) VALUES(?,2,200,3,NULL,'rising-star',?)").bind(sect.sectId, now),
      env.DB.prepare("INSERT INTO sect_cosmetics(sect_id,cosmetic_id,kind,name,created_at) VALUES(?,'rising-star','title','后起之秀',?)").bind(sect.sectId, now),
      env.DB.prepare("INSERT INTO sect_achievements(sect_id,achievement_id,progress,claimed,claimed_at,updated_at) VALUES(?,'sect-5',5,1,?,?)").bind(sect.sectId, now, now),
      env.DB.prepare("INSERT INTO sect_quests(sect_id,chapter_id,step_index,completed,version,updated_at) VALUES(?,'lipai',0,'[\"kaishan\"]',1,?)").bind(sect.sectId, now),
      env.DB.prepare("INSERT INTO daily_tasks(sect_id,date_key,tasks,claimed,chest_claimed,version,created_at,updated_at) VALUES(?,?,'[\"recruit\"]','[\"recruit\"]',1,2,?,?)").bind(sect.sectId, today, now, now),
    ]);
    const beforeBuildings = await env.DB.prepare('SELECT id,def_id,level FROM buildings WHERE sect_id=? ORDER BY id').bind(sect.sectId).all();
    const beforeMember = await env.DB.prepare('SELECT name,aptitude,attack,defense,speed,luck,physique,talent,body_tempering_count,note,technique_id,technique_prof_base FROM disciples WHERE id=?').bind(sect.discipleIds[0]).first();
    const beforeEquipment = await env.DB.prepare('SELECT * FROM equipment WHERE id=?').bind(equipmentId).first();
    const result = await action(sect, { action: 'rebirth', commandId: commandId(), expectedVersion: 0 });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const state = dataOf(result).state as { sect: { discipleCapacity: number; buildingCapacity: number } };
    expect(state.sect).toMatchObject({ discipleCapacity: 64, buildingCapacity: 8 });
    expect((await env.DB.prepare('SELECT id,def_id,level FROM buildings WHERE sect_id=? ORDER BY id').bind(sect.sectId).all()).results).toEqual(beforeBuildings.results);
    expect(await env.DB.prepare('SELECT name,aptitude,attack,defense,speed,luck,physique,talent,body_tempering_count,note,technique_id,technique_prof_base FROM disciples WHERE id=?').bind(sect.discipleIds[0]).first()).toEqual(beforeMember);
    expect(await env.DB.prepare('SELECT * FROM equipment WHERE id=?').bind(equipmentId).first()).toEqual(beforeEquipment);
    expect(await env.DB.prepare("SELECT level,scrolls FROM sect_techniques WHERE sect_id=? AND technique_id='qingfeng'").bind(sect.sectId).first()).toEqual({ level: 3, scrolls: 17 });
    expect(await env.DB.prepare("SELECT quantity FROM pill_inventories WHERE sect_id=? AND pill_id='cultivationPill'").bind(sect.sectId).first()).toEqual({ quantity: 9 });
    expect(await env.DB.prepare('SELECT production_bonus_bp,rename_tokens,equipped_title,version FROM sect_progression WHERE sect_id=?').bind(sect.sectId).first()).toEqual({ production_bonus_bp: 200, rename_tokens: 3, equipped_title: 'rising-star', version: 3 });
    expect(await env.DB.prepare('SELECT reputation,recruit_count,challenge_count,debate_count FROM sects WHERE id=?').bind(sect.sectId).first()).toEqual({ reputation: 543, recruit_count: 7, challenge_count: 3, debate_count: 20 });
    expect(await env.DB.prepare('SELECT claimed,chest_claimed,version FROM daily_tasks WHERE sect_id=? AND date_key=?').bind(sect.sectId, today).first()).toEqual({ claimed: '["recruit"]', chest_claimed: 1, version: 2 });
    expect(await env.DB.prepare('SELECT claimed FROM sect_achievements WHERE sect_id=?').bind(sect.sectId).first()).toEqual({ claimed: 1 });
    expect(await env.DB.prepare('SELECT completed FROM sect_quests WHERE sect_id=?').bind(sect.sectId).first()).toEqual({ completed: '["kaishan"]' });
    expect((await env.DB.prepare('SELECT remainder FROM resource_balances WHERE sect_id=?').bind(sect.sectId).all<{ remainder: number }>()).results.every(row => row.remainder === 0)).toBe(true);
  });

  it('已归队未领取历练继续阻断，拒绝转生不折损余额或清除资源回执', async () => {
    const sect = await makeSect();
    await setEligible(sect);
    await setBalance(sect.sectId, 'spiritStone', 1_234_567);
    const now = Date.now();
    const journeyId = commandId();
    await env.DB.prepare(`INSERT INTO disciple_journeys(id,sect_id,disciple_id,disciple_name,direction,duration_seconds,
      original_assignment,started_at,ends_at,completed_at,claimed_at,reward_cultivation,reward_resources,
      extra_harvest,injured,injury_chance_bp,cultivation_awarded,created_at)
      VALUES(?,?,?,'待领弟子','gathering',7200,'idle',?,?,?,NULL,0,'{"spiritStone":1000000}',0,0,0,0,?)`)
      .bind(journeyId, sect.sectId, sect.discipleIds[1], now - 3 * 3_600_000, now - 3_600_000, now - 3_600_000, now - 3 * 3_600_000).run();
    const preview = await panel(sect);
    expect(preview.eligible).toBe(false);
    expect(preview.blockedReasons.join(' ')).toContain('历练');
    const rejected = await action(sect, { action: 'rebirth', commandId: commandId(), expectedVersion: 0 });
    expect(errorOf(rejected).code).toBe('INVALID_STATUS');
    expect(await balance(sect.sectId, 'spiritStone')).toBe(1_234_567);
    expect(await env.DB.prepare('SELECT claimed_at,reward_resources FROM disciple_journeys WHERE id=?').bind(journeyId).first()).toEqual({ claimed_at: null, reward_resources: '{"spiritStone":1000000}' });
    expect(await env.DB.prepare('SELECT * FROM sect_rebirth WHERE sect_id=?').bind(sect.sectId).first()).toBeNull();
  });

  it('现货持仓、未成交挂单、保证金与未结竞逐分别阻断且不遗失托管资产', async () => {
    const sect = await makeSect();
    await setEligible(sect);
    const now = Date.now();
    const orderId = commandId();
    const raceId = commandId();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO stock_holdings(sect_id,stock_id,shares,cost,last_buy_at,version,updated_at) VALUES(?,'tiangong',2,2000,?,0,?)").bind(sect.sectId, now, now),
      env.DB.prepare("INSERT INTO stock_orders(id,sect_id,stock_id,kind,shares,trigger_price,reserved,status,checked_minute,version,created_at,expires_at,updated_at) VALUES(?,?,'yunlai','limit_buy',1,1,2,'open',?,0,?,?,?)").bind(orderId, sect.sectId, Math.floor(now / 60_000), now, now + DAY, now),
      env.DB.prepare("INSERT INTO stock_margin_positions(sect_id,stock_id,side,shares,entry_price,margin,leverage,liquidation_price,opened_at,checked_minute,version,updated_at) VALUES(?,'yunlai','long',1,1000,200,5,900,?,?,0,?)").bind(sect.sectId, now, Math.floor(now / 60_000), now),
      env.DB.prepare("INSERT INTO race_rounds(id,round_key,beast_weights,status,total_pool,created_at) VALUES(?,?,'[1,1,1,1,1]','betting',1000,?)").bind(raceId, `rebirth-${raceId}`, now),
      env.DB.prepare('INSERT INTO race_bets(id,round_id,sect_id,beast_index,amount,created_at) VALUES(?,?,?,0,1000,?)').bind(commandId(), raceId, sect.sectId, now),
    ]);
    const blocked = await panel(sect);
    for (const word of ['持仓', '挂单', '保证金', '竞逐']) expect(blocked.blockedReasons.join(' ')).toContain(word);
    const rejected = await action(sect, { action: 'rebirth', commandId: commandId(), expectedVersion: 0 });
    expect(errorOf(rejected).code).toBe('INVALID_STATUS');
    expect(await env.DB.prepare("SELECT shares,cost FROM stock_holdings WHERE sect_id=? AND stock_id='tiangong'").bind(sect.sectId).first()).toEqual({ shares: 2, cost: 2000 });
    expect(await env.DB.prepare('SELECT reserved,status FROM stock_orders WHERE id=?').bind(orderId).first()).toEqual({ reserved: 2, status: 'open' });
    expect(await env.DB.prepare('SELECT margin FROM stock_margin_positions WHERE sect_id=?').bind(sect.sectId).first()).toEqual({ margin: 200 });
    expect(await env.DB.prepare('SELECT amount FROM race_bets WHERE round_id=?').bind(raceId).first()).toEqual({ amount: 1000 });
    await env.DB.batch([
      env.DB.prepare('UPDATE stock_holdings SET shares=0,cost=0 WHERE sect_id=?').bind(sect.sectId),
      env.DB.prepare("UPDATE stock_orders SET status='cancelled' WHERE id=?").bind(orderId),
      env.DB.prepare('DELETE FROM stock_margin_positions WHERE sect_id=?').bind(sect.sectId),
    ]);
    const raceOnly = await panel(sect);
    expect(raceOnly.blockedReasons).toHaveLength(1);
    expect(raceOnly.blockedReasons[0]).toContain('竞逐');
    await env.DB.prepare("UPDATE race_rounds SET status='settled',winner_index=0,settled_at=? WHERE id=?").bind(now, raceId).run();
    expect((await panel(sect)).eligible).toBe(true);
  });

  it('道韵三种加成各限五次；外观一次性购买与回放均不重复扣款', async () => {
    const sect = await makeSect();
    await setEligible(sect);
    expect((await action(sect, { action: 'rebirth', commandId: commandId(), expectedVersion: 0 })).status).toBe(200);
    await env.DB.prepare('UPDATE sect_rebirth SET dao_yun=1600 WHERE sect_id=?').bind(sect.sectId).run();
    let version = 1;
    for (const id of ['bonus-production', 'bonus-breakthrough', 'bonus-power']) {
      for (let i = 0; i < 5; i += 1) {
        const bought = await action(sect, { action: 'buy', id, commandId: commandId(), expectedVersion: version });
        expect(bought.status, JSON.stringify(bought.body)).toBe(200);
        version = (dataOf(bought).rebirth as RebirthPanel).version;
      }
      const sixth = await action(sect, { action: 'buy', id, commandId: commandId(), expectedVersion: version });
      expect(errorOf(sixth).code).toBe('INVALID_STATUS');
      expect((await panel(sect)).shop.find(item => item.id === id)).toMatchObject({ purchased: 5, canBuy: false });
    }
    expect((await panel(sect)).bonuses).toEqual({ productionBp: 1500, breakthroughBp: 1000, powerBp: 1000 });
    const purchaseId = commandId();
    const request = { action: 'buy', id: 'frame-astral', commandId: purchaseId, expectedVersion: version };
    expect((await action(sect, request)).status).toBe(200);
    expect((await action(sect, request)).status).toBe(200);
    expect((await panel(sect)).daoYun).toBe(50);
    expect(errorOf(await action(sect, { ...request, commandId: commandId(), expectedVersion: version + 1 })).code).toBe('INVALID_STATUS');
    expect((await action(sect, { action: 'buy', id: 'title-worldwalker', commandId: commandId(), expectedVersion: version + 1 })).status).toBe(200);
    expect((await panel(sect)).daoYun).toBe(0);
    const cosmetics = await env.DB.prepare('SELECT cosmetic_id FROM sect_cosmetics WHERE sect_id=? ORDER BY cosmetic_id').bind(sect.sectId).all<{ cosmetic_id: string }>();
    expect(cosmetics.results.map(row => row.cosmetic_id)).toEqual(['frame-astral', 'title-worldwalker']);
  }, 15_000);

  it('满员64人转生后弟子ID完整保留，一级宗门仍可容纳64人', async () => {
    const sect = await makeSect();
    await setEligible(sect);
    const additional = Array.from({ length: 64 - sect.discipleIds.length }, (_, index) => ({ id: commandId(), name: `保留门人${index}` }));
    await env.DB.batch(additional.map(row => env.DB.prepare(`INSERT INTO disciples(id,sect_id,name,gender,aptitude,attack,defense,speed,talent,
      realm_id,stage,cultivation,cultivation_remainder,assignment,body_tempering_count,note,created_at)
      VALUES(?,?,?,'male',50,50,50,50,'combat','qiRefining',1,0,0,'idle',0,'',?)`).bind(row.id, sect.sectId, row.name, Date.now())));
    const expectedIds = [...sect.discipleIds, ...additional.map(row => row.id)].sort();
    const response = await action(sect, { action: 'rebirth', commandId: commandId(), expectedVersion: 0 });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const state = dataOf(response).state as { sect: { level: number; discipleCapacity: number }; disciples: { id: string }[] };
    expect(state.sect).toMatchObject({ level: 1, discipleCapacity: 64 });
    expect(state.disciples.map(row => row.id).sort()).toEqual(expectedIds);
  });

  it('拍卖待领、交互秘境、捕兽和坐镇均阻断，清理活动后恢复转生资格', async () => {
    const sect = await makeSect();
    await setEligible(sect);
    const now = Date.now();
    const lotId = commandId();
    const realmId = commandId();
    const captureId = commandId();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO auction_lots(id,seller_sect_id,seller_name,kind,item_id,item_name,quantity,start_price,
        status,ends_at,ended_at,created_at) VALUES(?,?,'待领卖家','pill','healingPill','回春丹',1,1000,'expired',?,?,?)`)
        .bind(lotId, sect.sectId, now - 1000, now, now - DAY),
      env.DB.prepare(`INSERT INTO realm_explorations(id,sect_id,realm_id,total_stages,status,created_at,updated_at)
        VALUES(?,?,'qiRefining',3,'in_progress',?,?)`).bind(realmId, sect.sectId, now, now),
      env.DB.prepare(`INSERT INTO beast_capture_sessions(id,sect_id,disciple_id,status,version,data,expires_at,created_at,updated_at)
        VALUES(?,?,?,'active',0,'{}',?,?,?)`).bind(captureId, sect.sectId, sect.discipleIds[1], now + DAY, now, now),
      env.DB.prepare("UPDATE world_sites SET holder_sect_id=?,holder_name='占领者',garrison='[]',held_since=?,settled_at=?,updated_at=? WHERE id='east-lingdi'")
        .bind(sect.sectId, now, now + DAY, now),
    ]);
    const blocked = await panel(sect);
    for (const word of ['拍卖', '秘境', '捕兽', '灵地']) expect(blocked.blockedReasons.join(' ')).toContain(word);
    const rejected = await action(sect, { action: 'rebirth', commandId: commandId(), expectedVersion: 0 });
    expect(errorOf(rejected).code).toBe('INVALID_STATUS');
    expect(await env.DB.prepare('SELECT seller_claimed_at FROM auction_lots WHERE id=?').bind(lotId).first()).toEqual({ seller_claimed_at: null });
    expect(await env.DB.prepare('SELECT status FROM realm_explorations WHERE id=?').bind(realmId).first()).toEqual({ status: 'in_progress' });
    expect(await env.DB.prepare('SELECT status FROM beast_capture_sessions WHERE id=?').bind(captureId).first()).toEqual({ status: 'active' });
    await env.DB.batch([
      env.DB.prepare('UPDATE auction_lots SET seller_claimed_at=? WHERE id=?').bind(now, lotId),
      env.DB.prepare("UPDATE realm_explorations SET status='failed' WHERE id=?").bind(realmId),
      env.DB.prepare("UPDATE beast_capture_sessions SET status='expired' WHERE id=?").bind(captureId),
      env.DB.prepare("UPDATE world_sites SET holder_sect_id=NULL,holder_name=NULL,garrison=NULL,held_since=NULL,settled_at=NULL WHERE id='east-lingdi'").bind(),
    ]);
    expect((await panel(sect)).eligible).toBe(true);
  });

  it('开界关闭自动讨伐且清除租约，不能继续按旧角色状态自动出战', async () => {
    const sect = await makeSect();
    await setEligible(sect);
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO world_boss_auto_settings(sect_id,enabled,lock_until,next_run_at,updated_at)
      VALUES(?,1,?,?,?)`).bind(sect.sectId, now + DAY, now + 60_000, now).run();
    const response = await action(sect, { action: 'rebirth', commandId: commandId(), expectedVersion: 0 });
    expect(response.status).toBe(200);
    expect(await env.DB.prepare('SELECT enabled,lock_until,pause_reason FROM world_boss_auto_settings WHERE sect_id=?')
      .bind(sect.sectId).first()).toEqual({ enabled: 0, lock_until: 0, pause_reason: '开辟新界后已暂停自动讨伐' });
  });

  it('转生与称号产出相加，sync战力和突破成功率包含全局加成', async () => {
    const sect = await makeSect();
    await env.DB.prepare(`UPDATE disciples SET realm_id='qiRefining',stage=1,ascension_level=0,
      attack=100,defense=100,speed=100,talent='none',assignment='idle' WHERE sect_id=?`).bind(sect.sectId).run();
    const before = dataOf(await sect.api.get('/api/v1/game/sync')).state as {
      resources: { id: string; ratePerHour: string }[];
      disciples: { id: string; combatPower: number; breakthroughChanceBp: number }[];
    };
    await setEligible(sect);
    await env.DB.prepare(`INSERT INTO sect_progression(sect_id,version,production_bonus_bp,rename_tokens,updated_at)
      VALUES(?,0,200,0,?)`).bind(sect.sectId, Date.now()).run();
    const response = await action(sect, { action: 'rebirth', commandId: commandId(), expectedVersion: 0 });
    expect(response.status).toBe(200);
    const after = dataOf(response).state as {
      resources: { id: string; ratePerHour: string }[];
      disciples: { id: string; combatPower: number; breakthroughChanceBp: number }[];
      sect: { progression: { productionBonusBp: number } };
    };
    expect(after.sect.progression.productionBonusBp).toBe(1200);
    const original = before.disciples.find(row => row.id === sect.discipleIds[0])!;
    const boosted = after.disciples.find(row => row.id === sect.discipleIds[0])!;
    expect(boosted.combatPower).toBe(Math.floor(original.combatPower * 1.05));
    expect(boosted.breakthroughChanceBp).toBe(original.breakthroughChanceBp + 500);
    for (const resource of before.resources.filter(row => Number(row.ratePerHour) > 0)) {
      expect(Number(after.resources.find(row => row.id === resource.id)!.ratePerHour)).toBe(Math.floor(Number(resource.ratePerHour) * 1.12));
    }
    await freeze(sect.sectId);
    const persisted = dataOf(await sect.api.get('/api/v1/game/sync')).state as typeof after;
    expect(persisted.sect.progression.productionBonusBp).toBe(1200);
    expect(persisted.disciples.find(row => row.id === sect.discipleIds[0])?.combatPower).toBe(boosted.combatPower);
  });

  it('同一弟子转生后再飞升生成第二周目独立公告，并发重复飞升不重复公告', async () => {
    const sect = await makeSect();
    const discipleId = sect.discipleIds[0]!;
    const prepareAscension = async () => {
      await env.DB.prepare(`UPDATE disciples SET realm_id='tribulation',stage=3,cultivation=1250000,
        ascension_level=0,ascension_pity=0,assignment='idle',injured_until=NULL,severe_injured_until=NULL
        WHERE id=?`).bind(discipleId).run();
      await freeze(sect.sectId);
    };
    await prepareAscension();
    // 仅固定三劫的骰子；DB、app与返回体仍全部是真实集成路径。
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const first = await sect.api.post('/api/v1/game/ascend', { discipleId });
      expect(first.status).toBe(200);
      await env.DB.prepare('UPDATE sects SET level=15 WHERE id=?').bind(sect.sectId).run();
      expect((await action(sect, { action: 'rebirth', commandId: commandId(), expectedVersion: 0 })).status).toBe(200);
      await prepareAscension();
      const raced = await Promise.all([1, 2].map(() => sect.api.post('/api/v1/game/ascend', { discipleId })));
      expect(raced.filter(result => result.status === 200)).toHaveLength(1);
      expect(raced.some(result => result.status >= 500), JSON.stringify(raced)).toBe(false);
      const messages = await env.DB.prepare('SELECT id FROM chat_messages WHERE id=? OR id=? ORDER BY id')
        .bind(`ascension:${discipleId}`, `ascension:${discipleId}:1`).all<{ id: string }>();
      expect(messages.results.map(row => row.id)).toEqual([`ascension:${discipleId}`, `ascension:${discipleId}:1`]);
    } finally {
      random.mockRestore();
    }
  });
});
