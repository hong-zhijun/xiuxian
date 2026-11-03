<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import type {
  AchievementView,
  ProgressionAction,
  ProgressionDestination,
  ProgressionPanel,
  ProgressionReward,
  QuestChapterView,
  ReputationShopItem,
} from '@xiuxian/contracts';

import type { SectStateView } from '../api/game';
import { ApiError } from '../api/client';
import { createProgressionCommandId, fetchProgression, postProgressionAction } from '../api/progression';
import { formatAmount } from '../utils/format';
import LoadingState from './LoadingState.vue';

const props = defineProps<{
  state: SectStateView;
  busy: boolean;
}>();

const emit = defineEmits<{
  'state-update': [state: SectStateView];
  'navigate': [destination: ProgressionDestination];
  notify: [tone: 'success' | 'warning', title: string, message: string];
  'busy-change': [busy: boolean];
}>();

type Tab = 'checkin' | 'achievements' | 'quests' | 'reputation';
const tabs: { id: Tab; label: string; glyph: string }[] = [
  { id: 'checkin', label: '签到', glyph: '签' },
  { id: 'achievements', label: '成就', glyph: '勋' },
  { id: 'quests', label: '主线', glyph: '卷' },
  { id: 'reputation', label: '声望', glyph: '誉' },
];

const activeTab = ref<Tab>('quests');
const panel = ref<ProgressionPanel | null>(null);
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const submitting = ref(false);
const lastMessage = ref<string | null>(null);
const failedAction = ref<ProgressionAction | null>(null);
const feedbackError = ref(false);
let midnightTimer: ReturnType<typeof setTimeout> | null = null;
let active = true;
let refreshPending = false;

const busy = computed(() => props.busy || submitting.value || loading.value);
const checkin = computed(() => panel.value?.checkin ?? null);
const achievements = computed(() => panel.value?.achievements ?? []);
const quests = computed(() => panel.value?.quests ?? []);
const reputationShop = computed(() => panel.value?.reputationShop ?? []);
const cosmetics = computed(() => panel.value?.cosmetics ?? []);
const frameCosmetics = computed(() => cosmetics.value.filter((item) => item.kind === 'frame'));
const titleCosmetics = computed(() => cosmetics.value.filter((item) => item.kind === 'title'));
const completedCheckinCycle = computed(() => checkin.value !== null && checkin.value.checkedToday && checkin.value.streak > 0 && checkin.value.nextDay === 1);

function formatReward(reward: ProgressionReward): string {
  const parts: string[] = [];
  for (const [id, amount] of Object.entries(reward.resources ?? {})) parts.push(`${resourceName(id)} ×${formatAmount(amount)}`);
  for (const [id, amount] of Object.entries(reward.pills ?? {})) parts.push(`${pillName(id)} ×${String(amount)}`);
  if (reward.reputation) parts.push(`声望 +${String(reward.reputation)}`);
  if (reward.scrolls) parts.push(`${scrollName(reward.scrolls.tier)}阶残卷 ×${String(reward.scrolls.quantity)}`);
  if (reward.equipmentBox) parts.push('装备宝箱 ×1');
  if (reward.renameToken) parts.push(`改名令 ×${String(reward.renameToken)}`);
  if (reward.cosmetic) parts.push(reward.cosmetic.name);
  return parts.length > 0 ? parts.join(' · ') : reward.description;
}

function resourceName(id: string): string {
  const names: Record<string, string> = {
    spiritStone: '灵石',
    spiritualEnergy: '灵气',
    herb: '灵草',
    ore: '矿石',
    beastEssence: '御兽精魄',
    xuantie: '玄铁',
    shenmu: '神木',
    merit: '功勋',
  };
  return props.state.resources.find((resource) => resource.id === id)?.name ?? names[id] ?? id;
}
function pillName(id: string): string {
  const names: Record<string, string> = {
    healingPill: '回春丹',
    cultivationPill: '聚气丹',
    bodyTemperingPill: '淬体丹',
    talentPill: '洗髓丹',
    aptitudePill: '培元丹',
  };
  return props.state.alchemy.recipes.find((recipe) => recipe.id === id)?.name ?? names[id] ?? id;
}
function tierLabel(tier: AchievementView['tier']): string {
  return ({ bronze: '铜', silver: '银', gold: '金' })[tier];
}
function scrollName(tier: 'xuan' | 'di' | 'tian'): string {
  return ({ tian: '天', di: '地', xuan: '玄' })[tier];
}
function onTabKeydown(event: KeyboardEvent, index: number): void {
  let next = index;
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  else return;
  event.preventDefault();
  const tab = tabs[next];
  if (tab === undefined) return;
  activeTab.value = tab.id;
  document.getElementById(`progression-tab-${tab.id}`)?.focus();
}

function percent(value: number, target: number): number {
  return target <= 0 ? 100 : Math.min(100, Math.round((value / target) * 100));
}
function titleLabel(id: string | null): string {
  if (id === null) return '未佩戴';
  const item = titleCosmetics.value.find((entry) => entry.id === id);
  return item?.name ?? id;
}

function scheduleMidnightRefresh(): void {
  if (midnightTimer !== null) clearTimeout(midnightTimer);
  const current = Date.now();
  const shifted = new Date(current + 8 * 3_600_000);
  const nextUtc8Midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1) - 8 * 3_600_000;
  midnightTimer = setTimeout(() => {
    void load(true);
    scheduleMidnightRefresh();
  }, Math.max(1000, nextUtc8Midnight + 3000 - current));
}

function utc8DateKey(value: number): string {
  return new Date(value + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** GET 与写动作共用忙锁，避免晚到的旧 GET 覆盖领奖回执。 */
async function load(quiet = false): Promise<void> {
  if (!active) return;
  if (loading.value || submitting.value || props.busy) {
    refreshPending = true;
    return;
  }
  refreshPending = false;
  loading.value = true;
  if (!quiet) errorMessage.value = null;
  try {
    const data = await fetchProgression();
    if (!active) return;
    panel.value = data.progression;
    if (Date.parse(data.state.serverNow) >= Date.parse(props.state.serverNow)) emit('state-update', data.state);
    errorMessage.value = null;
  } catch (error) {
    if (active) errorMessage.value = error instanceof Error ? error.message : '成长面板加载失败，请重试';
  } finally {
    loading.value = false;
  }
  if (refreshPending && active && !props.busy) void load(true);
}

async function action(kind: ProgressionAction['action'], id?: string | null): Promise<void> {
  if (busy.value) return;
  if (failedAction.value !== null) {
    emit('notify', 'warning', '上次操作结果待确认', '请先点击“重试上次操作”确认回执，避免重复兑换。');
    return;
  }
  const commandId = createProgressionCommandId();
  let request: ProgressionAction;
  if (kind === 'checkin' || kind === 'makeup') request = { commandId, action: kind };
  else if (kind === 'claim-achievement' || kind === 'claim-quest' || kind === 'buy-reputation') {
    if (!id) return;
    request = { commandId, action: kind, id };
  } else if (kind === 'set-frame' || kind === 'set-title') {
    request = { commandId, action: kind, id: id ?? null };
  } else return;

  await submit(request);
}

/** 网络失败后保留同一 commandId，点重试只重放原请求，避免重复兑换。 */
async function submit(request: ProgressionAction): Promise<void> {
  if (busy.value) return;
  submitting.value = true;
  emit('busy-change', true);
  lastMessage.value = null;
  feedbackError.value = false;
  failedAction.value = null;
  let failed = false;
  try {
    const data = await postProgressionAction(request);
    panel.value = data.progression;
    if (Date.parse(data.state.serverNow) >= Date.parse(props.state.serverNow)) emit('state-update', data.state);
    lastMessage.value = data.result?.message ?? '操作已完成';
    emit('notify', 'success', '成长进度已更新', lastMessage.value);
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : '操作失败，请稍后重试';
    lastMessage.value = message;
    feedbackError.value = true;
    if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.code === 'BAD_RESPONSE') failedAction.value = request;
    emit('notify', 'warning', '操作未完成', message);
  } finally {
    submitting.value = false;
    emit('busy-change', false);
  }
  if (failed || refreshPending) void load(true);
}

function retryAction(): void {
  if (failedAction.value !== null) void submit(failedAction.value);
}

function onVisible(): void {
  if (document.visibilityState === 'visible' && panel.value?.checkin.dateKey !== utc8DateKey(Date.now())) void load(true);
}

function navigate(destination: ProgressionDestination): void {
  if (busy.value) return;
  emit('navigate', destination);
}

function isAchievementClaimable(item: AchievementView): boolean {
  return item.completed && !item.claimed;
}
function isQuestClaimable(item: QuestChapterView): boolean {
  return item.unlocked && item.completed && !item.claimed;
}
function isShopItem(item: ReputationShopItem): boolean {
  return item.canBuy;
}

watch(() => props.busy, (value) => {
  if (!value && (refreshPending || panel.value?.checkin.dateKey !== utc8DateKey(Date.now()))) void load(true);
});

onMounted(() => {
  void load();
  scheduleMidnightRefresh();
  document.addEventListener('visibilitychange', onVisible);
});
onUnmounted(() => {
  active = false;
  if (midnightTimer !== null) clearTimeout(midnightTimer);
  document.removeEventListener('visibilitychange', onVisible);
});
</script>

<template>
  <section class="progression-dialog" aria-labelledby="progression-title">
    <header class="progression-heading section-heading panel-heading">
      <div>
        <p class="eyebrow">宗门成长</p>
        <h2 id="progression-title">修行纪要</h2>
      </div>
      <div class="progression-summary">
        <span>声望 <b>{{ panel?.reputation ?? state.sect.reputation }}</b></span>
        <span v-if="panel && panel.productionBonusBp > 0">产出 +{{ Math.round(panel.productionBonusBp / 100) }}%</span>
        <button class="progression-refresh" type="button" :disabled="busy" @click="load(false)">{{ loading ? '更新中…' : '刷新' }}</button>
      </div>
    </header>

    <div v-if="loading && panel === null" class="progression-loading"><LoadingState label="正在翻阅成长纪要" /></div>
    <div v-else-if="errorMessage && panel === null" class="progression-error empty-state">
      <span aria-hidden="true">!</span><strong>成长纪要暂时无法打开</strong><p>{{ errorMessage }}</p>
      <button class="action-button primary-action" type="button" :disabled="busy" @click="load(false)">重试</button>
    </div>
    <template v-else>
      <nav class="progression-tabs" role="tablist" aria-label="成长栏目">
        <button v-for="(tab, index) in tabs" :id="`progression-tab-${tab.id}`" :key="tab.id" class="progression-tab" :class="{ active: activeTab === tab.id }" type="button" role="tab" :aria-selected="activeTab === tab.id" :aria-controls="`progression-panel-${tab.id}`" @click="activeTab = tab.id" @keydown="onTabKeydown($event, index)">
          <i aria-hidden="true">{{ tab.glyph }}</i>{{ tab.label }}
        </button>
      </nav>
      <div v-if="lastMessage" class="progression-feedback" :class="{ 'is-error': feedbackError }" role="status">
        <span>{{ lastMessage }}</span>
        <button v-if="failedAction" class="progression-refresh" type="button" :disabled="busy" @click="retryAction">重试上次操作</button>
      </div>
      <div v-if="errorMessage" class="progression-feedback is-error" role="alert">
        <span>{{ errorMessage }} · 当前显示上次记录</span>
        <button class="progression-refresh" type="button" :disabled="busy" @click="load(false)">重新加载</button>
      </div>

      <section v-if="activeTab === 'checkin' && checkin" id="progression-panel-checkin" class="progression-content" role="tabpanel" aria-labelledby="progression-tab-checkin">
        <header class="progression-subheading"><div><p class="eyebrow">每日修行</p><h3 id="progression-checkin-title">{{ checkin.checkedToday ? '今日已签到' : '今日签到' }}</h3></div><span class="progression-streak">连续 {{ checkin.streak }} 天</span></header>
        <div class="progression-stat-row"><span>累计签到 {{ checkin.totalDays }} 天</span><span>{{ checkin.checkedToday ? '下次' : '本次' }}第 {{ checkin.nextDay }} 天奖励</span><span>{{ checkin.milestone }}</span></div>
        <div class="checkin-days">
          <div v-for="day in checkin.days" :key="day.day" class="checkin-day" :class="{ done: completedCheckinCycle || day.day < checkin.nextDay, current: !completedCheckinCycle && day.day === checkin.nextDay }"><span>第 {{ day.day }} 天</span><strong>{{ formatReward(day.reward) }}</strong><b v-if="completedCheckinCycle || day.day < checkin.nextDay">已领</b><b v-else-if="day.day === checkin.nextDay">{{ checkin.checkedToday ? '下次可领' : '今日可领' }}</b></div>
        </div>
        <div v-if="checkin.canMakeup" class="progression-makeup-note"><strong>还有漏签可补：{{ checkin.makeupDate }}</strong><p>请先补签再签到。每次消耗 {{ formatAmount(checkin.makeupCost) }} 灵石，本期已补 {{ checkin.makeupUsed }}/{{ checkin.makeupLimit }} 次。</p></div>
        <p v-if="checkin.blockedReason" class="blocked-hint">{{ checkin.blockedReason }}</p>
        <div class="progression-actions"><button class="action-button primary-action" type="button" :disabled="busy || checkin.checkedToday" @click="action('checkin')">{{ submitting ? '签到中…' : checkin.checkedToday ? '今日已签到' : '签到并领取' }}</button><button v-if="checkin.canMakeup" class="action-button" type="button" :disabled="busy" @click="action('makeup')">补签（{{ formatAmount(checkin.makeupCost) }} 灵石）</button></div>
      </section>

      <section v-else-if="activeTab === 'achievements'" id="progression-panel-achievements" class="progression-content" role="tabpanel" aria-labelledby="progression-tab-achievements">
        <header class="progression-subheading"><div><p class="eyebrow">阶段记录</p><h3 id="progression-achievement-title">成就殿</h3></div><span class="count-badge">{{ achievements.filter((item) => item.claimed).length }}/{{ achievements.length }}</span></header>
        <div v-if="achievements.length === 0" class="empty-state compact-empty"><span aria-hidden="true">勋</span><strong>尚无成就记录</strong><p>完成宗门日常后，这里会留下你的足迹。</p></div>
        <ul v-else class="progression-list"><li v-for="item in achievements" :key="item.id" class="progression-card" :class="{ complete: item.completed, claimed: item.claimed }"><div class="progression-card-main"><div class="progression-card-title"><strong>{{ item.name }}</strong><span class="realm-tag">{{ item.category }} · {{ tierLabel(item.tier) }}</span></div><p>{{ item.description }}</p><div class="progression-progress"><i :style="{ width: `${percent(item.progress, item.target)}%` }" /><span>{{ item.progress }}/{{ item.target }}</span></div><small>奖励：{{ formatReward(item.reward) }}</small></div><button class="action-button" type="button" :disabled="busy || !isAchievementClaimable(item)" @click="action('claim-achievement', item.id)">{{ item.claimed ? '已领取' : item.completed ? '领取' : '进行中' }}</button></li></ul>
      </section>

      <section v-else-if="activeTab === 'quests'" id="progression-panel-quests" class="progression-content" role="tabpanel" aria-labelledby="progression-tab-quests">
        <header class="progression-subheading"><div><p class="eyebrow">宗门史诗</p><h3 id="progression-quest-title">主线任务</h3></div><span class="count-badge">{{ quests.filter((item) => item.completed).length }}/{{ quests.length }}</span></header>
        <div v-if="quests.length === 0" class="empty-state compact-empty"><span aria-hidden="true">卷</span><strong>主线正在编纂</strong><p>完成当前修行后会解锁新的章节。</p></div>
        <article v-for="chapter in quests" :key="chapter.id" class="quest-chapter" :class="{ locked: !chapter.unlocked }"><header><div><strong>{{ chapter.name }}</strong><p>{{ chapter.unlocked ? '章节进度' : '尚未解锁' }}</p></div><span class="realm-tag">{{ chapter.claimed ? '已完成' : chapter.completed ? '可领取' : chapter.unlocked ? '进行中' : '未解锁' }}</span></header><ul><li v-for="step in chapter.steps" :key="step.id" :class="{ done: step.completed }"><span class="quest-step-marker">{{ step.completed ? '✓' : '·' }}</span><div><strong>{{ step.name }}</strong><p>{{ step.description }}</p><div class="progression-progress"><i :style="{ width: `${percent(step.progress, step.target)}%` }" /><span>{{ step.progress }}/{{ step.target }}</span></div></div><button class="quest-destination" type="button" :disabled="busy || !chapter.unlocked" @click="navigate(step.destination)">前往</button></li></ul><footer><span>奖励：{{ formatReward(chapter.reward) }}</span><button class="action-button" type="button" :disabled="busy || !isQuestClaimable(chapter)" @click="action('claim-quest', chapter.id)">{{ chapter.claimed ? '已领取' : chapter.completed ? '领取章节奖励' : '完成任务后领取' }}</button></footer></article>
        <p class="progression-description quest-history-note">已完成的旧进度会自动计入；已清理且无法恢复的历史记录不补计，已确认完成的步骤不会回退。</p>
      </section>

      <section v-else id="progression-panel-reputation" class="progression-content" role="tabpanel" aria-labelledby="progression-tab-reputation">
        <header class="progression-subheading"><div><p class="eyebrow">宗门声望</p><h3 id="progression-reputation-title">声望兑换</h3></div><span class="progression-streak">{{ panel?.reputation ?? 0 }} 声望</span></header>
        <p class="progression-description">用宗门声望兑换修行资源、称号与外观。兑换成功后会立即刷新仓库与宗门成长效果。</p>
        <ul v-if="reputationShop.length > 0" class="progression-shop-list"><li v-for="item in reputationShop" :key="item.id" class="progression-shop-item"><div><strong>{{ item.name }}</strong><p>{{ formatReward(item.reward) }} · {{ item.limit === null ? `已兑换 ${item.purchased} 次` : `${item.purchased}/${item.limit} 次` }}</p><p>{{ item.reward.description }}</p><small v-if="item.blockedReason" class="blocked-hint">{{ item.blockedReason }}</small></div><button class="action-button primary-action" type="button" :disabled="busy || !isShopItem(item)" @click="action('buy-reputation', item.id)">{{ item.canBuy ? `${item.cost} 声望兑换` : '暂不可换' }}</button></li></ul><div v-else class="empty-state compact-empty"><span aria-hidden="true">誉</span><strong>暂无可兑换物品</strong><p>提升宗门声望后再来看看。</p></div>
        <div class="cosmetics-section"><header class="progression-subheading"><div><p class="eyebrow">宗门外观</p><h3>佩戴称号与头像框</h3></div></header><div class="cosmetic-grid"><div class="cosmetic-row"><span>头像框</span><button class="cosmetic-option" :class="{ selected: panel?.equippedFrame === null }" type="button" :disabled="busy" @click="action('set-frame', null)">素框</button><button v-for="item in frameCosmetics" :key="item.id" class="cosmetic-option" :class="{ selected: panel?.equippedFrame === item.id }" type="button" :disabled="busy" @click="action('set-frame', item.id)">{{ item.name }}</button></div><div class="cosmetic-row"><span>称号</span><button class="cosmetic-option" :class="{ selected: panel?.equippedTitle === null }" type="button" :disabled="busy" @click="action('set-title', null)">无</button><button v-for="item in titleCosmetics" :key="item.id" class="cosmetic-option" :class="{ selected: panel?.equippedTitle === item.id }" type="button" :disabled="busy" @click="action('set-title', item.id)">{{ item.name }}</button></div><p class="cosmetic-equipped">当前称号：{{ titleLabel(panel?.equippedTitle ?? null) }}</p></div></div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.progression-dialog {
  min-width: 0;
  color: var(--ink-text);
  background: #0c1e1a;
  /* 同色实底延伸到 ModalShell 内边距，遮住后方首页文字。 */
  box-shadow: 0 0 0 20px #0c1e1a;
  --modal-head-bg: #0c1e1a;
}
.progression-heading { align-items: flex-start; margin-bottom: 12px; padding-bottom: 12px; }
.progression-heading h2 { margin: 0; font-family: 'STKaiti', 'KaiTi', serif; font-size: 25px; font-weight: 500; }
.progression-summary { display: flex; flex-wrap: wrap; gap: 8px; color: var(--faint); font-size: 12px; }
.progression-summary span { padding: 5px 9px; border: 1px solid var(--line); border-radius: 999px; }
.progression-summary b { color: var(--gold-bright); }
.progression-refresh {
  appearance: none;
  min-height: 30px;
  padding: 5px 10px;
  border: 1px solid #806c43;
  border-radius: 6px;
  color: #ead19a;
  background: #1a3027;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
  cursor: pointer;
  transition: border-color 150ms ease, background-color 150ms ease;
}
.progression-refresh:not(:disabled):hover { border-color: #caa96a; background: #263c2f; }
.progression-refresh:focus-visible { outline: 2px solid #caa96a; outline-offset: 2px; }
.progression-refresh:disabled { opacity: .5; cursor: not-allowed; }
.progression-makeup-note { margin-top: 12px; padding: 10px 11px; border: 1px solid rgba(202,169,106,.35); border-radius: 8px; color: var(--gold-bright); background: rgba(202,169,106,.06); font-size: 12px; }
.progression-makeup-note p { margin: 3px 0 0; color: var(--muted); }
.progression-loading { min-height: 180px; display: grid; place-items: center; }
.progression-error { padding: 34px 12px; text-align: center; }
.progression-error .action-button { margin-top: 10px; }
.progression-tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 14px; padding: 5px; border: 1px solid var(--line); border-radius: 12px; background: rgba(3, 18, 14, .45); }
.progression-tab { min-height: 42px; border: 1px solid transparent; border-radius: 8px; color: var(--faint); background: transparent; cursor: pointer; font: inherit; }
.progression-tab i { display: inline-block; margin-right: 5px; color: var(--gold); font-style: normal; }
.progression-tab.active { border-color: rgba(202,169,106,.48); color: var(--ink-text); background: rgba(202,169,106,.13); }
.progression-feedback { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 10px; padding: 9px 11px; border: 1px solid rgba(116, 190, 143, .4); border-radius: 8px; color: #b8e8c5; background: rgba(61, 130, 86, .12); font-size: 12px; }
.progression-feedback.is-error { border-color: rgba(224,123,104,.4); color: var(--red-bright); background: rgba(224,123,104,.07); }
.progression-content { min-width: 0; }
.progression-subheading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.progression-subheading h3 { margin: 3px 0 0; font-family: 'STKaiti', 'KaiTi', serif; font-size: 21px; font-weight: 500; }
.progression-streak { flex: 0 0 auto; padding: 7px 10px; border: 1px solid rgba(202,169,106,.45); border-radius: 999px; color: var(--gold-bright); font-size: 12px; }
.progression-stat-row { display: flex; flex-wrap: wrap; gap: 7px 15px; margin-bottom: 14px; color: var(--faint); font-size: 12px; }
.checkin-days { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 8px; }
.checkin-day { display: flex; min-height: 78px; flex-direction: column; justify-content: space-between; gap: 6px; padding: 11px; border: 1px solid var(--line); border-radius: 9px; background: rgba(255,255,255,.018); }
.checkin-day span { color: var(--faint); font-size: 10px; letter-spacing: .1em; }
.checkin-day strong { color: var(--ink-text); font-size: 12px; font-weight: 500; }
.checkin-day b { color: var(--faint); font-size: 11px; font-weight: 400; }
.checkin-day.current { border-color: rgba(202,169,106,.64); box-shadow: inset 0 0 0 1px rgba(202,169,106,.13); }
.checkin-day.current b { color: var(--gold-bright); }
.checkin-day.done { opacity: .68; }
.progression-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 15px; }
.progression-list, .progression-shop-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.progression-card, .progression-shop-item, .quest-chapter { padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: rgba(255,255,255,.018); }
.progression-card { display: flex; align-items: flex-start; justify-content: space-between; gap: 13px; }
.progression-card.complete { border-color: rgba(202,169,106,.38); }
.progression-card.claimed { opacity: .72; }
.progression-card-main { min-width: 0; flex: 1; }
.progression-card-title { display: flex; align-items: center; gap: 8px; }
.progression-card-title strong, .progression-shop-item strong, .quest-chapter strong { font-size: 14px; font-weight: 600; }
.progression-card p, .progression-shop-item p, .quest-chapter p { margin: 4px 0; color: var(--faint); font-size: 12px; line-height: 1.5; }
.progression-card small, .progression-shop-item small { color: var(--gold); font-size: 11px; }
.progression-progress { display: flex; align-items: center; gap: 8px; margin: 8px 0 5px; color: var(--faint); font-size: 11px; }
.progression-progress { position: relative; height: 5px; overflow: visible; border-radius: 99px; background: rgba(190, 210, 194, .14); }
.progression-progress i { display: block; height: 100%; border-radius: inherit; background: var(--gold); }
.progression-progress span { position: absolute; top: 8px; right: 0; white-space: nowrap; }
.progression-card .progression-progress { margin-bottom: 19px; }
.quest-chapter { margin-bottom: 9px; }
.quest-chapter.locked { opacity: .62; }
.quest-chapter > header, .quest-chapter > footer { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.quest-chapter > ul { display: grid; gap: 8px; margin: 11px 0; padding: 0; list-style: none; }
.quest-chapter li { display: flex; align-items: flex-start; gap: 8px; padding: 8px; border-left: 2px solid var(--line); }
.quest-chapter li.done { border-color: var(--green-bright, #8ac69e); }
.quest-step-marker { width: 17px; color: var(--gold); font-size: 16px; text-align: center; }
.quest-chapter li > div { min-width: 0; flex: 1; }
.quest-chapter li .progression-progress { margin: 7px 0 9px; }
.quest-destination { flex: 0 0 auto; padding: 4px 7px; border: 1px solid var(--line); border-radius: 5px; color: var(--faint); background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
.quest-destination:hover { border-color: var(--gold); color: var(--gold-bright); }
.quest-chapter > footer { align-items: center; padding-top: 9px; border-top: 1px solid var(--line); color: var(--gold); font-size: 11px; }
.quest-chapter > footer .action-button { font-size: 12px; }
.progression-shop-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.progression-shop-item > div { min-width: 0; }
.progression-description { margin: 0 0 12px; color: var(--faint); font-size: 12px; line-height: 1.6; }
.cosmetics-section { margin-top: 20px; padding-top: 15px; border-top: 1px solid var(--line); }
.cosmetic-grid { display: grid; gap: 10px; }
.cosmetic-row { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.cosmetic-row > span { min-width: 48px; color: var(--faint); font-size: 12px; }
.cosmetic-option { padding: 6px 9px; border: 1px solid var(--line); border-radius: 999px; color: var(--faint); background: transparent; font: inherit; font-size: 12px; cursor: pointer; }
.cosmetic-option.selected { border-color: rgba(202,169,106,.68); color: var(--gold-bright); background: rgba(202,169,106,.13); }
.cosmetic-option:disabled, .quest-destination:disabled { opacity: .55; cursor: not-allowed; }
.cosmetic-equipped { margin: 3px 0 0; color: var(--gold); font-size: 11px; }
@media (max-width: 600px) { .progression-tabs { gap: 3px; padding: 3px; } .progression-tab { min-height: 38px; font-size: 12px; } .progression-tab i { display: none; } .progression-card, .progression-shop-item { align-items: stretch; flex-direction: column; } .progression-card .action-button, .progression-shop-item .action-button { width: 100%; } .checkin-days { grid-template-columns: repeat(2, minmax(0, 1fr)); } .quest-chapter > footer { align-items: stretch; flex-direction: column; } }
</style>
