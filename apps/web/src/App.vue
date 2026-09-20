<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

import { ApiError, setCsrfToken } from './api/client';
import {
  assign,
  breakthrough,
  challenge,
  craftPill,
  expelDisciple,
  explore,
  fetchMe,
  logout as apiLogout,
  recruit,
  setDiscipleNote,
  setDefenseLineup,
  syncSect,
  upgradeBuilding,
  upgradeSect,
  usePill,
} from './api/game';
import type {
  ChallengeResultView,
  CraftPillOutcome,
  EventLogView,
  ExpelDiscipleOutcome,
  ResourceView,
  SectStateView,
  UsePillOutcome,
} from './api/game';
import CreateSectScreen from './components/CreateSectScreen.vue';
import LoginScreen from './components/LoginScreen.vue';
import SectScreen from './components/SectScreen.vue';
import ToastStack from './components/ToastStack.vue';
import type { ToastItem, ToastTone } from './types/ui';
import { formatAmount, formatBp } from './utils/format';

/**
 * 应用外壳：只有三种界面（未登录 / 未建宗门 / 游戏中），用 ref 管理，不用 Vue Router / Pinia。
 * 所有真实数值都来自服务端：每次操作后整体刷新 `state`，前端只做展示。
 */
type Phase = 'loading' | 'anonymous' | 'noSect' | 'playing';

interface ActionFeedback {
  tone?: ToastTone;
  title: string;
  message: string;
}

const phase = ref<Phase>('loading');
const state = ref<SectStateView | null>(null);
const busy = ref(false);
const toasts = ref<ToastItem[]>([]);

/** 最近一次挑战的战报（交给 SectScreen 的挑战弹窗展示；关掉弹窗即清空）。 */
const challengeResult = ref<ChallengeResultView | null>(null);

let syncTimer: number | undefined;
let nextToastId = 1;
const toastTimers = new Map<number, number>();

/** 事件提示窗口：只提示最近 5 分钟内发生的新事件。 */
const EVENT_NOTIFY_WINDOW_MS = 5 * 60 * 1000;
const seenEventIds = new Set<string>();
let eventTrackingReady = false;

function clearToastTimer(id: number): void {
  const timer = toastTimers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    toastTimers.delete(id);
  }
}

function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
  clearToastTimer(id);
}

function notify(tone: ToastTone, title: string, message: string): void {
  const id = nextToastId++;
  const toast: ToastItem = { id, tone, title, message };

  // 最多同时展示四条；被挤出的消息同步清理计时器，避免后台保留无效任务。
  const retained = toasts.value.slice(-3);
  const retainedIds = new Set(retained.map((item) => item.id));
  for (const item of toasts.value) {
    if (!retainedIds.has(item.id)) clearToastTimer(item.id);
  }
  toasts.value = [...retained, toast];

  const timeout = tone === 'error' ? 7200 : 4800;
  toastTimers.set(
    id,
    window.setTimeout(() => {
      dismissToast(id);
    }, timeout),
  );
}

function handleError(caught: unknown): void {
  if (caught instanceof ApiError && caught.status === 401) {
    setCsrfToken(null);
    state.value = null;
    phase.value = 'anonymous';
    resetEventTracking();
    notify('warning', '会话已失效', '请重新登录后再入山门。');
    return;
  }
  notify('error', '操作未完成', caught instanceof Error ? caught.message : '操作失败，请稍后重试。');
}
/** 把资源增减渲染成「灵石 +80 · 灵草 -15」这样的摘要。 */
function effectSummary(effects: Record<string, string>, resources: ResourceView[]): string {
  const names = new Map(resources.map((resource) => [resource.id, resource.name]));
  return Object.entries(effects)
    .map(([resourceId, amount]) => {
      const value = Number(amount);
      const sign = value < 0 ? '-' : '+';
      return `${names.get(resourceId) ?? resourceId} ${sign}${formatAmount(Math.abs(value))}`;
    })
    .join(' · ');
}

/** 资源净增 → success；净减 → warning；好坏参半 → info。 */
function eventTone(event: EventLogView): ToastTone {
  const amounts = Object.values(event.effects).map((amount) => Number(amount));
  const gained = amounts.some((amount) => amount > 0);
  const lost = amounts.some((amount) => amount < 0);
  if (gained && lost) return 'info';
  return lost ? 'warning' : 'success';
}

/**
 * 新事件提示：对比上一次同步拿到的事件列表，只提示新增且发生在最近 5 分钟内的事件。
 * 首次同步只登记不提示，避免刚进游戏就被历史事件刷屏。
 */
function announceEvents(next: SectStateView): void {
  const isFirstSync = !eventTrackingReady;
  eventTrackingReady = true;

  const nowMs = Date.parse(next.serverNow);
  const fresh: EventLogView[] = [];
  for (const event of next.recentEvents ?? []) {
    if (seenEventIds.has(event.id)) continue;
    seenEventIds.add(event.id);
    if (!isFirstSync) fresh.push(event);
  }

  // 由旧到新提示，阅读顺序与发生顺序一致。
  for (const event of fresh.reverse()) {
    const createdAt = Date.parse(event.createdAt);
    if (Number.isFinite(nowMs) && Number.isFinite(createdAt) && nowMs - createdAt > EVENT_NOTIFY_WINDOW_MS) {
      continue;
    }
    const effects = effectSummary(event.effects, next.resources);
    notify(
      eventTone(event),
      `天机异动 · ${event.name}`,
      effects === '' ? event.description : `${event.description}（${effects}）`,
    );
  }
}

function resetEventTracking(): void {
  seenEventIds.clear();
  eventTrackingReady = false;
}

/**
 * 同步（GET /game/sync）：服务端会先结算再返回完整状态。
 * 所有同步（包括后台轮询）都进入同一个 busy 门闩，避免与扣费写操作并发。
 */
async function refresh(showNotice = false): Promise<boolean> {
  if (busy.value) return false;
  busy.value = true;
  try {
    const next = await syncSect();
    state.value = next;
    if (next !== null) announceEvents(next);
    phase.value = next === null ? 'noSect' : 'playing';
    if (showNotice) {
      notify('success', '宗门已同步', '资源、弟子与建筑状态均已更新。');
    }
    return true;
  } catch (caught) {
    handleError(caught);
    return false;
  } finally {
    busy.value = false;
  }
}

async function bootstrap(): Promise<void> {
  try {
    await fetchMe();
  } catch (caught) {
    phase.value = 'anonymous';
    if (!(caught instanceof ApiError && caught.status === 401)) {
      notify('error', '山门连接失败', caught instanceof Error ? caught.message : '初始化失败，请稍后重试。');
    }
    return;
  }

  const synced = await refresh(false);
  if (!synced && phase.value === 'loading') {
    // 同步失败时仍留出可操作入口，避免页面永久卡在加载态。
    phase.value = 'anonymous';
  }
}

async function runAction(
  action: () => Promise<SectStateView | { state: SectStateView; outcome?: unknown }>,
  describe: (data: { state: SectStateView; outcome?: unknown }) => ActionFeedback | null,
): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const result = await action();
    const data = 'state' in result ? result : { state: result, outcome: undefined };
    state.value = data.state;
    announceEvents(data.state);
    const feedback = describe(data);
    if (feedback !== null) {
      notify(feedback.tone ?? 'success', feedback.title, feedback.message);
    }
  } catch (caught) {
    handleError(caught);
  } finally {
    busy.value = false;
  }
}

/** 招贤：choice 是弹窗里选中的候选人序号（候选人由服务端确定性生成，见 /game/recruit-preview）。 */
function onRecruit(choice: number): void {
  void runAction(
    () => recruit(choice),
    (data) => {
      const outcome = data.outcome as
        | { discipleName?: string; aptitude?: number; talentName?: string }
        | undefined;
      return {
        title: '招贤有得',
        message:
          outcome?.discipleName === undefined
            ? '招募完成。'
            : `新弟子 ${outcome.discipleName} 已入山门，资质 ${String(outcome.aptitude)}，天赋「${outcome.talentName ?? '无'}」。`,
      };
    },
  );
}

/**
 * 招贤台「换一批」：SectScreen 已经拿到服务端返回的 state，这里只负责接管。
 * （刷新弹窗内容属于弹窗内部事务，但 `state` 始终只在 App 赋值。）
 */
function onRecruitRefreshed(next: SectStateView): void {
  state.value = next;
  announceEvents(next);
}

function onAssign(discipleId: string, assignment: string): void {
  void runAction(
    () => assign(discipleId, assignment),
    () => ({ title: '差遣已定', message: '弟子岗位已调整，旧岗位收益已先行结算。' }),
  );
}

function onUpgrade(defId: string): void {
  void runAction(
    () => upgradeBuilding(defId),
    () => ({ title: '营造告成', message: '建筑已完成升级。' }),
  );
}

function onUpgradeSect(): void {
  void runAction(upgradeSect, (data) => ({
    title: '宗门晋升',
    message: `宗门已晋升为「${data.state.sect.levelName}」，弟子与建筑上限同步提升。`,
  }));
}

/** 秘境探索：服务端算胜负，这里只负责回填 state、提示结果，并顺带处理本次结算触发的事件。 */
async function onExplore(realmId: string, discipleIds: string[]): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const { state: next, result } = await explore(realmId, discipleIds);
    state.value = next;
    announceEvents(next);

    const chance = `胜算 ${formatBp(result.chanceBp)}`;
    const gained = effectSummary(result.rewards, next.resources);
    const detail = result.success && gained !== '' ? `${chance} · 获得 ${gained}` : chance;
    notify(
      result.success ? 'success' : 'warning',
      result.success ? `探索得手 · ${result.realmName}` : `探索受挫 · ${result.realmName}`,
      `${result.message}（${detail}）`,
    );
  } catch (caught) {
    handleError(caught);
  } finally {
    busy.value = false;
  }
}

/** 3v3 比分（攻方胜轮数 : 守方胜轮数），toast 标题里用。 */
function challengeScore(result: ChallengeResultView): string {
  const attackerWins = result.rounds.filter((round) => round.winner === 'attacker').length;
  return `${attackerWins}:${result.rounds.length - attackerWins}`;
}

/**
 * 登门挑战：服务端逐轮裁决，这里回填 state、把逐轮战报交给弹窗展示，并按胜负 toast。
 * toast 正文直接用服务端给的 message（已含比分与奖励），标题补一个比分，避免同一句话出现两遍。
 */
async function onChallenge(targetSectId: string, discipleIds: string[]): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  challengeResult.value = null;
  try {
    const { state: next, result } = await challenge(targetSectId, discipleIds);
    state.value = next;
    announceEvents(next);
    challengeResult.value = result;

    const won = result.result === 'win';
    notify(
      won ? 'success' : 'warning',
      `${won ? '挑战得胜' : '挑战失利'} · ${result.targetSectName}（${challengeScore(result)}）`,
      result.message,
    );
  } catch (caught) {
    handleError(caught);
  } finally {
    busy.value = false;
  }
}

/** 守擂阵容：固定 3 人、顺序即迎战顺序，服务端只存弟子 id。 */
async function onSetDefenseLineup(discipleIds: string[]): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const next = await setDefenseLineup(discipleIds);
    state.value = next;
    announceEvents(next);
    notify('success', '阵容已定', '守擂阵容已更新。');
  } catch (caught) {
    handleError(caught);
  } finally {
    busy.value = false;
  }
}

/** 挑战弹窗关闭：清掉战报，下次打开是干净的选人界面。 */
function onDismissChallengeResult(): void {
  challengeResult.value = null;
}

function onBreakthrough(discipleId: string): void {
  void runAction(
    () => breakthrough(discipleId),
    (data) => {
      const outcome = data.outcome as { success?: boolean; message?: string } | undefined;
      const succeeded = outcome?.success !== false;
      return {
        tone: succeeded ? 'success' : 'warning',
        title: succeeded ? '破境功成' : '突破未成',
        message: outcome?.message ?? '本次突破已结束。',
      };
    },
  );
}

const PILL_ATTRIBUTE_NAMES: Record<string, string> = { attack: '攻击', defense: '防御', speed: '身法' };

/** 炼丹：数量由炼丹面板选好（1~5），服务端整单校验并扣资源，返回完整 state。 */
function onCraftPill(pillId: string, quantity: number): void {
  void runAction(
    () => craftPill(pillId, quantity),
    (data) => {
      const outcome = data.outcome as CraftPillOutcome | undefined;
      return {
        title: '炼丹告成',
        message:
          outcome === undefined
            ? '丹药已收入丹库。'
            : `炼得 ${outcome.pillName} ×${String(outcome.quantity)}，已收入丹库。`,
      };
    },
  );
}

/** 服用丹药：目标与状态由服务端校验，成功后按效果提示（回春/修为/淬体）。 */
function onUsePill(pillId: string, discipleId: string): void {
  void runAction(
    () => usePill(pillId, discipleId),
    (data) => {
      const outcome = data.outcome as UsePillOutcome | undefined;
      const effect = outcome?.effect;
      let message = '丹药入腹，药力生效。';
      if (effect?.kind === 'heal') {
        message = `${outcome?.discipleName ?? '弟子'} 伤势尽复，可以再度出战。`;
      } else if (effect?.kind === 'cultivation') {
        message = `${outcome?.discipleName ?? '弟子'} 修为 +${String(effect.gain ?? 0)}。`;
      } else if (effect?.kind === 'bodyTempering') {
        message = `${outcome?.discipleName ?? '弟子'} ${PILL_ATTRIBUTE_NAMES[effect.attribute ?? ''] ?? '属性'} +${String(effect.gain ?? 0)}。`;
      }
      return { title: `服用${outcome?.pillName ?? '丹药'}`, message };
    },
  );
}

/** 0013 保存私有备注：内容规则由服务端裁决，成功与否则由返回的 state 决定提示文案。 */
function onSaveNote(discipleId: string, note: string): void {
  void runAction(
    () => setDiscipleNote(discipleId, note),
    (data) => {
      const saved = data.state.disciples.find((item) => item.id === discipleId)?.note ?? '';
      return {
        title: '备注已记下',
        message: saved === '' ? '这条备注已清空。' : `备注存为「${saved}」，只有你看得到。`,
      };
    },
  );
}

/**
 * 0013 驱逐弟子：二次确认在详情弹窗里完成（此处只会收到已确认的请求）。
 * 阵容清理与人数不足 3 人的后果都以服务端回执为准，前端不自己推算。
 */
function onExpelDisciple(discipleId: string): void {
  void runAction(
    () => expelDisciple(discipleId),
    (data) => {
      const outcome = data.outcome as ExpelDiscipleOutcome | undefined;
      const remaining = outcome?.remainingDisciples ?? data.state.disciples.length;
      const parts = [`${outcome?.discipleName ?? '该弟子'}已离开山门。`];
      if (outcome?.lineupCleared === true) {
        parts.push('该弟子原在守擂阵容中，阵容已清空，请重新布阵。');
      }
      if (remaining < 3) {
        parts.push(`门下仅剩 ${String(remaining)} 人，人数不足 3 人时无法出战挑战。`);
      }
      return { tone: 'warning', title: '弟子已驱逐', message: parts.join('') };
    },
  );
}

async function onLogout(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  let remoteLogoutFailed = false;
  try {
    await apiLogout();
  } catch {
    // 退出失败也让本地回到未登录（Cookie 可能已经失效）
    remoteLogoutFailed = true;
  } finally {
    setCsrfToken(null);
    state.value = null;
    resetEventTracking();
    phase.value = 'anonymous';
    busy.value = false;
    notify(
      remoteLogoutFailed ? 'warning' : 'info',
      '已离开山门',
      remoteLogoutFailed ? '服务端退出未确认，本地会话已清除。' : '本次宗门事务已妥善收起。',
    );
  }
}

async function completeAuthentication(): Promise<void> {
  phase.value = 'loading';
  notify('success', '身份核验通过', '正在为你开启山门。');
  const synced = await refresh(false);
  if (!synced && phase.value === 'loading') {
    phase.value = 'anonymous';
  }
}

function onAuthenticated(): void {
  void completeAuthentication();
}

function onSectCreated(created: SectStateView): void {
  state.value = created;
  phase.value = 'playing';
  notify('success', '开宗立派', `宗门《${created.sect.name}》已正式立于此界。`);
}

onMounted(() => {
  void bootstrap();
  // 每 60 秒同步一次；隐藏标签页不轮询，服务端仍是资源与修为的唯一权威。
  syncTimer = window.setInterval(() => {
    if (phase.value === 'playing' && !busy.value && !document.hidden) {
      void refresh(false);
    }
  }, 60_000);
});

onUnmounted(() => {
  if (syncTimer !== undefined) {
    window.clearInterval(syncTimer);
  }
  for (const timer of toastTimers.values()) {
    window.clearTimeout(timer);
  }
  toastTimers.clear();
});
</script>

<template>
  <div class="app-root">
    <div class="world-atmosphere" aria-hidden="true">
      <span class="moon-orb" />
      <span class="cloud cloud-one" />
      <span class="cloud cloud-two" />
      <span class="distant-peak peak-one" />
      <span class="distant-peak peak-two" />
    </div>

    <main v-if="phase === 'loading'" class="loading-screen" aria-live="polite">
      <div class="loading-emblem" aria-hidden="true">
        <span>玄</span>
      </div>
      <p class="eyebrow">太初界 · 山门驿</p>
      <h1>寻访宗门中</h1>
      <div class="loading-runes" aria-hidden="true"><i /><i /><i /></div>
      <p>正在越过云海，校验掌门玉令……</p>
    </main>

    <LoginScreen
      v-else-if="phase === 'anonymous'"
      @authenticated="onAuthenticated"
      @notify="notify"
    />

    <CreateSectScreen
      v-else-if="phase === 'noSect'"
      @created="onSectCreated"
      @logout="onLogout"
      @notify="notify"
    />

    <SectScreen
      v-else-if="state"
      :state="state"
      :busy="busy"
      :challenge-result="challengeResult"
      @refresh="refresh(true)"
      @logout="onLogout"
      @recruit="onRecruit"
      @assign="onAssign"
      @upgrade="onUpgrade"
      @upgrade-sect="onUpgradeSect"
      @explore="onExplore"
      @recruit-refreshed="onRecruitRefreshed"
      @challenge="onChallenge"
      @set-defense-lineup="onSetDefenseLineup"
      @dismiss-challenge-result="onDismissChallengeResult"
      @breakthrough="onBreakthrough"
      @craft-pill="onCraftPill"
      @use-pill="onUsePill"
      @save-note="onSaveNote"
      @expel="onExpelDisciple"
      @notify="notify"
    />

    <ToastStack :items="toasts" @dismiss="dismissToast" />
  </div>
</template>
