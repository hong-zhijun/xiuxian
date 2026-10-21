import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { dataOf, TestClient } from './support/authClient';
import { getSectState } from '../src/modules/game/service';
import type { SectStateView } from '../src/modules/game/view';

/**
 * 天骄榜点开的弟子公开档案（GET /game/disciple-profile/:id）。
 *
 * 这里只锁「档案里该有什么」：灵兽与主修功法要和弟子详情同一个口径（同一套字段、同一个构造函数），
 * 并且跨宗观看时也拿得到；私有字段（备注、修为、岗位）不在档案里。
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
const app = createApp({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
const NOW = Date.UTC(2026, 9, 21, 8);
let seq = 0;

async function makeSect() {
  const n = ++seq;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.90.0.${n}` });
  expect((await api.post('/api/v1/auth/register', { account: `profile-test-${n}`, password: 'password-123456' })).status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `档案${n}宗` });
  expect(created.status).toBe(200);
  const state = (dataOf(created) as { state: SectStateView }).state;
  const sectId = state.sect.id;
  const user = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?').bind(sectId).first<{ user_id: string }>();
  await env.DB.prepare('UPDATE sects SET level = ?, last_settled_at = ? WHERE id = ?').bind(7, NOW, sectId).run();
  return { api, sectId, userId: user!.user_id, discipleId: state.disciples[0]!.id };
}

type Fixture = Awaited<ReturnType<typeof makeSect>>;

/** 直接写库造状态：档案接口是只读的，这里只需要「库里有什么」。 */
async function seedBeastAndTechnique(f: Fixture): Promise<void> {
  await env.DB.prepare('UPDATE disciples SET beast_json = ? WHERE id = ?')
    .bind(JSON.stringify({ speciesId: 'white_tiger', quality: 'treasure', level: 8 }), f.discipleId)
    .run();
  await env.DB.prepare(
    'INSERT INTO sect_techniques (sect_id, technique_id, level, scrolls) VALUES (?, ?, ?, 0)',
  ).bind(f.sectId, 'qingfeng', 3).run();
  await env.DB.prepare(
    'UPDATE disciples SET technique_id = ?, technique_prof_base = ?, technique_since = ? WHERE id = ?',
  ).bind('qingfeng', 4500, NOW, f.discipleId).run();
}

describe('弟子公开档案 · 灵兽与功法', () => {
  it('灵兽按弟子详情的同一口径展示：名称 / 品质 / 五行 / 档次 / 技能 / 属性', async () => {
    const owner = await makeSect();
    await seedBeastAndTechnique(owner);
    // 同宗视角：档案里的灵兽必须和弟子详情里的一模一样（两处共用 spiritBeastViewOf）。
    const mine = (await getSectState(env.DB, owner.userId, NOW))!.disciples.find((d) => d.id === owner.discipleId)!;
    const profile = dataOf(await owner.api.get(`/api/v1/game/disciple-profile/${owner.discipleId}`)) as Record<string, any>;

    expect(profile.isMe).toBe(true);
    expect(profile.spiritBeast).toEqual(mine.spiritBeast);
    expect(profile.spiritBeast).toMatchObject({
      speciesId: 'white_tiger',
      quality: 'treasure',
      level: 8,
      name: '庚金白虎',
      qualityName: '宝品',
      element: 'metal',
      elementName: '金',
      tierName: '神兽',
    });
    // 技能文案与属性都是算出来的：文案只锁「有内容」，数值直接和弟子详情逐个字段对齐。
    expect(String(profile.spiritBeast.skillName).length).toBeGreaterThan(0);
    expect(String(profile.spiritBeast.skillText).length).toBeGreaterThan(0);
    expect(profile.spiritBeast.attrs).toEqual(mine.spiritBeast!.attrs);
    expect(profile.spiritBeast.avatar).toContain('white_tiger');
  });

  it('未携带灵兽的弟子：spiritBeast 为 null，不是 undefined', async () => {
    const owner = await makeSect();
    const profile = dataOf(await owner.api.get(`/api/v1/game/disciple-profile/${owner.discipleId}`)) as Record<string, any>;
    expect(profile.spiritBeast).toBeNull();
  });

  it('功法：名称 / 本宗等级 / 熟练度；未修习时为 null + 无', async () => {
    const owner = await makeSect();
    const before = dataOf(await owner.api.get(`/api/v1/game/disciple-profile/${owner.discipleId}`)) as Record<string, any>;
    expect(before.techniqueId).toBeNull();
    // 与弟子详情同一口径：服务端对空值给「无」，卡片上显示成「未修习」由前端决定。
    expect(before.techniqueName).toBe('无');
    expect(before.techniqueLevel).toBe(0);
    expect(before.techniqueProficiency).toBe(0);

    await seedBeastAndTechnique(owner);
    const after = dataOf(await owner.api.get(`/api/v1/game/disciple-profile/${owner.discipleId}`)) as Record<string, any>;
    expect(after.techniqueId).toBe('qingfeng');
    expect(after.techniqueName).toBe('青锋剑诀');
    expect(after.techniqueLevel).toBe(3);
    // 接口按真实时钟算熟练度（主修时刻取未来时刻，增长被 clamp 在 0），因此只锁下界。
    expect(after.techniqueProficiency).toBeGreaterThanOrEqual(4500);

    // 同一门功法换个没收录的宗门：等级回落到 0，名称照常显示。
    await env.DB.prepare('DELETE FROM sect_techniques WHERE sect_id = ?').bind(owner.sectId).run();
    const orphan = dataOf(await owner.api.get(`/api/v1/game/disciple-profile/${owner.discipleId}`)) as Record<string, any>;
    expect(orphan.techniqueName).toBe('青锋剑诀');
    expect(orphan.techniqueLevel).toBe(0);
  });

  it('身上的装备按兵器 → 护甲 → 法器排列（与弟子详情概览的装备行同一顺序）', async () => {
    const owner = await makeSect();
    const slots = ['weapon', 'armor', 'artifact'];
    // 插入顺序刻意与字母序（armor < artifact < weapon）不同：档案要按部位表顺序返回。
    for (const [index, slot] of slots.entries()) {
      await env.DB.prepare(
        `INSERT INTO equipment (id, sect_id, disciple_id, slot, quality, name, main_attr, main_value,
                                sub_attr, sub_value, source, created_at, refine_level)
         VALUES (?, ?, ?, ?, 'common', ?, 'attack', 8, 'speed', 2, 'forge', ?, 0)`,
      ).bind(`eq-order-${String(index)}`, owner.sectId, owner.discipleId, slot, `凡品·${slot}`, NOW + index).run();
    }
    const profile = dataOf(await owner.api.get(`/api/v1/game/disciple-profile/${owner.discipleId}`)) as Record<string, any>;
    expect((profile.equipment as { slot: string }[]).map((item) => item.slot)).toEqual(slots);
    expect((profile.equipment as { slotName: string }[]).map((item) => item.slotName)).toEqual(['兵器', '护甲', '法器']);
  });

  it('跨宗观看同样带灵兽与功法，且不泄漏备注 / 修为 / 岗位', async () => {
    const owner = await makeSect();
    const viewer = await makeSect();
    await seedBeastAndTechnique(owner);
    await env.DB.prepare('UPDATE disciples SET note = ?, assignment = ? WHERE id = ?')
      .bind('掌门私记：此人可重点培养', 'herbGathering', owner.discipleId)
      .run();

    const profile = dataOf(await viewer.api.get(`/api/v1/game/disciple-profile/${owner.discipleId}`)) as Record<string, any>;
    expect(profile.isMe).toBe(false);
    expect(profile.spiritBeast).toMatchObject({ name: '庚金白虎', quality: 'treasure' });
    expect(profile.techniqueName).toBe('青锋剑诀');
    expect(profile.techniqueLevel).toBe(3);
    for (const privateField of ['note', 'cultivation', 'requiredCultivation', 'assignment', 'assignmentName']) {
      expect(profile).not.toHaveProperty(privateField);
    }
  });
});
