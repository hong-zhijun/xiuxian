<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import type { DailyChestResult, DailyTaskView, DailyTasksView, SectStateView } from '../api/game';
import { claimDailyTask, fetchDailyTasks, openDailyChest } from '../api/game';
import type { ToastTone } from '../types/ui';
import { formatAmount } from '../utils/format';

/**
 * 宗门日课卡片（首页，docs/每日任务开发计划.md 2.7）。
 *
 * 进度、奖励、宝箱状态全部由服务端算好下发，这里只渲染并派发「领取」「开箱」。
 * 读取时机：挂载时一次；上层 refreshKey 变化时（关掉弹窗，进度可能变了）；跨过 UTC+8 零点时（整份日课换新）。
 * 写成功后服务端回执带回新的 state，经 state-update 交给上层（与镇妖塔面板同一做法）。
 */
const props = defineProps<{
  busy: boolean;
  /** 上层每次关掉弹窗就 +1，卡片据此重新读一次。 */
  refreshKey?: number;
}>();

const emit = defineEmits<{
  'state-update': [state: SectStateView];
  notify: [tone: ToastTone, title: string, message: string];
}>();

const view = ref<DailyTasksView | null>(null);
const loading = ref(false);
/** 领取 / 开箱在途：与 props.busy（全局门闩）分开，只锁日课这一块，避免连点。 */
const submitting = ref(false);
/** 今天刚开出的宝箱内容（只在本次打开的页面里保留；刷新后只显示「已开启」）。 */
const lastChest = ref<DailyChestResult | null>(null);

/** UTC+8 日期键（与服务端 dateKeyUtc8 同一口径）：用来判断是否跨了零点。 */
function utc8DateKey(now: number): string {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 读一次今天的日课。quiet = 后台重读（关弹窗、跨零点、写失败之后）：失败不弹提示，只保留上一份。 */
async function load(options: { quiet?: boolean } = {}): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const data = await fetchDailyTasks();
    view.value = data.dailyTasks;
    if (!data.dailyTasks.chest.claimed) lastChest.value = null;
  } catch (error) {
    if (options.quiet !== true) {
      emit('notify', 'warning', '宗门日课', error instanceof Error ? error.message : '日课加载失败，请稍后再试');
    }
  } finally {
    loading.value = false;
  }
}

async function claim(task: DailyTaskView): Promise<void> {
  if (props.busy || submitting.value || task.claimed || !task.completed) return;
  submitting.value = true;
  try {
    const data = await claimDailyTask(task.id);
    view.value = data.dailyTasks;
    emit('state-update', data.state);
    emit('notify', 'success', `日课「${task.name}」已完成`, data.result.message);
  } catch (error) {
    emit('notify', 'warning', '日课未领', error instanceof Error ? error.message : '领取失败，请稍后再试');
    // 服务端的判定可能和卡片不一致（比如已经领过、或已跨天）：静默重读一次，界面跟上。
    void load({ quiet: true });
  } finally {
    submitting.value = false;
  }
}

async function openChest(): Promise<void> {
  if (props.busy || submitting.value || view.value === null || !view.value.chest.available) return;
  submitting.value = true;
  try {
    const data = await openDailyChest();
    view.value = data.dailyTasks;
    lastChest.value = data.result;
    emit('state-update', data.state);
    emit('notify', 'success', '日课宝箱已开', data.result.message);
  } catch (error) {
    emit('notify', 'warning', '宝箱未开', error instanceof Error ? error.message : '开箱失败，请稍后再试');
    void load({ quiet: true });
  } finally {
    submitting.value = false;
  }
}

const total = computed(() => view.value?.tasks.length ?? 0);
const claimedCount = computed(() => view.value?.tasks.filter((task) => task.claimed).length ?? 0);
/** 标题旁的小红点：有可领取的任务，或者宝箱可开。 */
const hasAlert = computed(
  () =>
    view.value !== null &&
    (view.value.tasks.some((task) => task.completed && !task.claimed) || view.value.chest.available),
);

function progressPercent(task: DailyTaskView): number {
  return Math.min(100, Math.round((task.progress / task.target) * 100));
}

function taskButtonText(task: DailyTaskView): string {
  if (task.claimed) return '已领取';
  return task.completed ? '领取' : '进行中';
}

function chestButtonText(): string {
  if (view.value === null) return '';
  if (view.value.chest.claimed) return '今日已开';
  if (view.value.chest.available) return '开启宝箱';
  return `领完 ${String(total.value)} 个任务后可开`;
}

watch(
  () => props.refreshKey,
  () => {
    void load({ quiet: true });
  },
);

let dayTimer: number | undefined;

onMounted(() => {
  void load();
  // 每分钟看一眼日期：跨过 UTC+8 零点就重读（只在跨天时才发请求）。
  dayTimer = window.setInterval(() => {
    if (view.value !== null && view.value.dateKey !== utc8DateKey(Date.now())) void load({ quiet: true });
  }, 60_000);
});

onUnmounted(() => {
  if (dayTimer !== undefined) window.clearInterval(dayTimer);
});
</script>

<template>
  <section class="game-panel daily-panel" aria-labelledby="daily-title">
    <header class="section-heading daily-heading">
      <div class="daily-title-wrap">
        <h2 id="daily-title" class="home-section-title daily-title">
          宗门日课
          <i v-if="hasAlert" class="daily-alert" role="img" aria-label="有可领取的奖励" />
        </h2>
        <span v-if="view" class="daily-date">{{ view.dateKey }} · 每日零点刷新</span>
      </div>
      <div class="daily-heading-actions">
        <span v-if="view" class="count-badge">已领 {{ claimedCount }} / {{ total }}</span>
        <button class="quiet-button daily-refresh" type="button" :disabled="loading" @click="load()">刷新</button>
      </div>
    </header>

    <p v-if="view === null" class="daily-empty">{{ loading ? '日课加载中…' : '日课加载失败，请点刷新。' }}</p>

    <template v-else>
      <ul class="daily-list" aria-label="今日任务">
        <li
          v-for="task in view.tasks"
          :key="task.id"
          class="daily-task"
          :class="{ 'is-claimed': task.claimed, 'is-ready': task.completed && !task.claimed }"
        >
          <div class="daily-task-body">
            <div class="daily-task-line">
              <span class="daily-task-name">{{ task.name }}</span>
              <span class="daily-task-reward">灵石 +{{ formatAmount(task.reward) }}</span>
            </div>
            <div class="daily-task-progress">
              <span class="daily-track" aria-hidden="true"><span :style="{ width: `${progressPercent(task)}%` }" /></span>
              <span class="daily-task-count">{{ task.progress }} / {{ task.target }}</span>
            </div>
          </div>
          <button
            class="daily-task-action"
            type="button"
            :disabled="task.claimed || !task.completed || busy || submitting"
            :aria-label="task.completed && !task.claimed ? `领取「${task.name}」` : `${task.name}：${taskButtonText(task)}`"
            @click="claim(task)"
          >
            {{ taskButtonText(task) }}
          </button>
        </li>
      </ul>

      <div class="daily-chest" :class="{ 'is-ready': view.chest.available, 'is-open': view.chest.claimed }">
        <div class="daily-chest-text">
          <strong class="daily-chest-title">日课宝箱</strong>
          <span class="daily-chest-desc">{{ view.chest.description }}</span>
          <span v-if="lastChest" class="daily-chest-result">
            本次开出：玄铁 ×{{ lastChest.xuantie }} · 神木 ×{{ lastChest.shenmu }} · {{ lastChest.pillName }} ×1
          </span>
        </div>
        <button
          class="daily-chest-action"
          type="button"
          :disabled="!view.chest.available || busy || submitting"
          @click="openChest"
        >
          {{ chestButtonText() }}
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.daily-panel {
  min-width: 0;
  margin-top: 14px;
  padding: 15px 18px 16px;
}

.daily-heading {
  flex-wrap: wrap;
  align-items: flex-start;
  margin-bottom: 12px;
  padding-bottom: 11px;
  border-bottom: 1px solid var(--line);
}

.daily-title-wrap {
  display: flex;
  min-width: 0;
  flex: 1 1 180px;
  flex-direction: column;
  gap: 3px;
}

.daily-title {
  display: flex;
  align-items: center;
  gap: 4px;
}

.daily-date {
  color: var(--muted);
  font-size: 12px;
  letter-spacing: 0.04em;
}

.daily-alert {
  display: inline-block;
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  margin-left: 4px;
  border-radius: 50%;
  background: var(--red-bright);
  box-shadow: 0 0 0 2px rgba(8, 20, 17, 0.9);
}

.daily-heading-actions {
  display: flex;
  min-width: 0;
  flex: 0 1 auto;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.daily-refresh {
  padding: 4px 8px;
  font-size: 12px;
}

.daily-empty {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

/* 任务卡片：宽屏一排 5 个（最后一行会撑满，不留空位），窄屏一行一个。 */
.daily-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.daily-task {
  display: flex;
  flex: 1 1 200px;
  max-width: 100%;
  min-width: 0;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border: 1px solid rgba(202, 169, 106, 0.18);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.02);
}

.daily-task.is-ready {
  border-color: rgba(234, 209, 154, 0.5);
  background: rgba(202, 169, 106, 0.07);
}

.daily-task.is-claimed {
  opacity: 0.66;
}

.daily-task-body {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 6px;
}

.daily-task-line {
  display: flex;
  min-width: 0;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.daily-task-name {
  min-width: 0;
  overflow: hidden;
  color: var(--gold-bright);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.daily-task-reward {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}

.daily-task-progress {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.daily-track {
  display: block;
  min-width: 0;
  height: 5px;
  flex: 1 1 auto;
  overflow: hidden;
  border-radius: 3px;
  background: rgba(167, 184, 173, 0.14);
}

.daily-track > span {
  display: block;
  height: 100%;
  background: var(--jade);
}

.daily-task-count {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.daily-task-action {
  flex: 0 0 auto;
  min-width: 64px;
  min-height: 32px;
  padding: 4px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}

.daily-task.is-ready .daily-task-action {
  background: linear-gradient(180deg, #dfc381, #b28d4b);
  color: #0b1713;
  font-weight: 700;
}

.daily-task-action:not(:disabled):hover {
  border-color: rgba(234, 209, 154, 0.7);
}

.daily-task-action:disabled {
  cursor: not-allowed;
  opacity: 0.8;
}

.daily-chest {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 14px;
  margin-top: 10px;
  padding: 11px 12px;
  border: 1px dashed rgba(202, 169, 106, 0.3);
  border-radius: 4px;
}

.daily-chest.is-ready {
  border-style: solid;
  border-color: rgba(234, 209, 154, 0.55);
  background: rgba(202, 169, 106, 0.06);
}

.daily-chest-text {
  display: flex;
  min-width: 0;
  flex: 1 1 200px;
  flex-direction: column;
  gap: 3px;
}

.daily-chest-title {
  color: var(--gold);
  font-size: 13px;
  letter-spacing: 0.06em;
}

.daily-chest-desc,
.daily-chest-result {
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.daily-chest-result {
  color: var(--jade-bright);
}

.daily-chest-action {
  flex: 0 0 auto;
  min-height: 36px;
  padding: 6px 14px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  white-space: nowrap;
}

.daily-chest.is-ready .daily-chest-action {
  background: linear-gradient(180deg, #dfc381, #b28d4b);
  border-color: #d4b979;
  color: #0b1713;
  font-weight: 700;
}

.daily-chest-action:disabled {
  cursor: not-allowed;
  opacity: 0.8;
}

@media (max-width: 360px) {
  .daily-panel {
    padding: 12px 12px 13px;
  }
}
</style>
