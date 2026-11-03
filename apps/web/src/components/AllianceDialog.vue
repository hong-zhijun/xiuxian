<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

import type { AllianceAction, AllianceChatMessage, AlliancePanel } from '@xiuxian/contracts';

import { fetchAlliance, fetchAllianceChat, postAllianceAction, postAllianceChat, type AllianceChatInput } from '../api/alliance';
import { ApiError } from '../api/client';
import type { SectStateView } from '../api/game';
import { selectionBlockReason } from '../utils/discipleFilter';
import { formatTime } from '../utils/format';
import DisciplePicker from './DisciplePicker.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import LoadingState from './LoadingState.vue';

const props = defineProps<{ state: SectStateView; busy: boolean }>();
const emit = defineEmits<{
  'state-update': [state: SectStateView];
  'busy-change': [busy: boolean];
  notify: [tone: 'success' | 'warning', title: string, message: string];
}>();

type Tab = 'members' | 'boss' | 'shop' | 'chat';
interface PendingAction { request: AllianceAction; scopeId: string | null }
const tabs: { id: Tab; name: string }[] = [
  { id: 'members', name: '盟中事务' }, { id: 'boss', name: '每周讨伐' },
  { id: 'shop', name: '盟贡商店' }, { id: 'chat', name: '仙盟频道' },
];
const panel = ref<AlliancePanel | null>(null);
const activeTab = ref<Tab>('members');
const loading = ref(false);
const submitting = ref(false);
const loadError = ref<string | null>(null);
const feedback = ref<string | null>(null);
const feedbackError = ref(false);
const failedAction = ref<PendingAction | null>(null);
const confirmation = ref<{ title: string; message: string; pending: PendingAction } | null>(null);
const createName = ref('');
const inviteSectId = ref('');
const selected = ref<string[]>([]);
const copied = ref(false);
const messages = ref<AllianceChatMessage[]>([]);
const chatDraft = ref('');
const chatError = ref<string | null>(null);
const chatLoading = ref(false);
const chatSending = ref(false);
const chatSuspended = ref(false);
const failedChat = ref<{ input: AllianceChatInput; scopeId: string } | null>(null);
const messageList = ref<HTMLElement | null>(null);
let active = true;
let scopeGeneration = 0;
let panelRequest = 0;
let chatController: AbortController | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

const alliance = computed(() => panel.value?.alliance ?? null);
const allianceId = computed(() => alliance.value?.id ?? null);
const boss = computed(() => panel.value?.boss ?? null);
const isLeader = computed(() => alliance.value?.isLeader === true);
const locked = computed(() => props.busy || loading.value || submitting.value || chatSending.value);
const actionLocked = computed(() => locked.value || failedAction.value !== null || failedChat.value !== null);
const nameLength = computed(() => Array.from(createName.value.trim()).length);
const validName = computed(() => nameLength.value >= 2 && nameLength.value <= 12 && !/[\r\n\u0000-\u001f\u007f]/u.test(createName.value));
const joinCooldown = computed(() => panel.value?.joinCooldownUntil !== null && panel.value?.joinCooldownUntil !== undefined && Date.parse(panel.value.joinCooldownUntil) > Date.parse(props.state.serverNow));
const canCreate = computed(() => panel.value !== null && alliance.value === null && !joinCooldown.value && validName.value && panel.value.reputation >= panel.value.createCost);
const hpPercent = computed(() => boss.value === null || boss.value.maxHp <= 0 ? 0 : Math.max(0, Math.min(100, boss.value.remainingHp / boss.value.maxHp * 100)));
const canAttack = computed(() => boss.value?.canAttack === true && selected.value.length >= 1 && selected.value.length <= 3 && selected.value.every((id) => {
  const disciple = props.state.disciples.find((entry) => entry.id === id);
  return disciple !== undefined && selectionBlockReason(disciple, Date.parse(props.state.serverNow), { blockInjured: true, blockAway: true, blockSteward: true }) === null;
}));

function uncertain(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.code === 'BAD_RESPONSE';
}
function scopeFailure(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'INVALID_STATUS' || error.status === 401 || error.status === 403 || error.status === 404);
}
function acceptState(state: SectStateView): void {
  if (Date.parse(state.serverNow) >= Date.parse(props.state.serverNow)) emit('state-update', state);
}
function stopPolling(): void {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = null;
}
/** 每次切换/离开仙盟都废弃已发出的读取，旧响应不得回填。 */
function cancelChat(clear = false, discardRetry = false): void {
  scopeGeneration += 1;
  chatController?.abort();
  chatController = null;
  chatLoading.value = false;
  stopPolling();
  if (clear) {
    messages.value = [];
    chatDraft.value = '';
    chatError.value = null;
    if (discardRetry) failedChat.value = null;
  }
}
function applyPanel(next: AlliancePanel): void {
  const previous = allianceId.value;
  const nextId = next.alliance?.id ?? null;
  if (previous !== nextId) {
    cancelChat(true, true);
    selected.value = [];
    inviteSectId.value = '';
    confirmation.value = null;
    if (failedAction.value !== null && failedAction.value.scopeId !== null && failedAction.value.scopeId !== nextId) failedAction.value = null;
  }
  panel.value = next;
}
async function load(quiet = false): Promise<boolean> {
  if (!active || submitting.value || chatSending.value || loading.value) return false;
  const request = ++panelRequest;
  loading.value = true;
  if (!quiet) loadError.value = null;
  let loaded = false;
  try {
    const data = await fetchAlliance();
    if (!active || request !== panelRequest) return false;
    applyPanel(data.alliance);
    acceptState(data.state);
    loadError.value = null;
    loaded = true;
  } catch (error) {
    if (!active || request !== panelRequest) return false;
    loadError.value = error instanceof Error ? error.message : '仙盟事务暂时无法读取，请重试';
    if (scopeFailure(error)) {
      chatSuspended.value = true;
      cancelChat(true, true);
      panel.value = null;
    }
  } finally {
    if (request === panelRequest) loading.value = false;
  }
  return loaded;
}
function nextPoll(): void {
  stopPolling();
  if (!active || activeTab.value !== 'chat' || allianceId.value === null || chatSuspended.value || document.hidden) return;
  pollTimer = setTimeout(() => { void pollChat(); }, 10_000);
}
async function scrollMessages(): Promise<void> {
  await nextTick();
  const element = messageList.value;
  if (element !== null) element.scrollTop = element.scrollHeight;
}
/** 每轮先核对会员资格；消息取回后再次核对，避免跨盟旧内容出现在当前频道。 */
async function pollChat(): Promise<void> {
  if (!active || activeTab.value !== 'chat' || document.hidden) return;
  if (locked.value || chatLoading.value) { nextPoll(); return; }
  const loaded = await load(true);
  const currentId = allianceId.value;
  if (!loaded || currentId === null || !active || activeTab.value !== 'chat' || document.hidden) { nextPoll(); return; }
  const generation = scopeGeneration;
  const controller = new AbortController();
  chatController = controller;
  chatLoading.value = true;
  try {
    const data = await fetchAllianceChat(currentId, controller.signal);
    if (!active || controller.signal.aborted || generation !== scopeGeneration || activeTab.value !== 'chat') return;
    const membership = await fetchAlliance();
    if (!active || controller.signal.aborted || generation !== scopeGeneration) return;
    applyPanel(membership.alliance);
    acceptState(membership.state);
    if (allianceId.value !== currentId || generation !== scopeGeneration) return;
    messages.value = data.messages;
    chatError.value = null;
    await scrollMessages();
  } catch (error) {
    if (!active || controller.signal.aborted || generation !== scopeGeneration) return;
    if (scopeFailure(error)) {
      chatSuspended.value = true;
      cancelChat(true, true);
      chatError.value = '你已失去当前仙盟频道资格，正在重新读取仙盟状态。';
      await load(true);
      return;
    }
    chatError.value = error instanceof Error ? error.message : '频道读取失败，请重试';
  } finally {
    if (generation === scopeGeneration) {
      chatController = null;
      chatLoading.value = false;
    }
    nextPoll();
  }
}
function actionRequest(request: AllianceAction): PendingAction {
  return { request, scopeId: allianceId.value };
}
function ask(request: AllianceAction, title: string, message: string): void {
  if (actionLocked.value) return;
  confirmation.value = { title, message, pending: actionRequest(request) };
}
function askCreate(): void {
  if (!canCreate.value || panel.value === null) return;
  ask({ action: 'create', name: createName.value.trim(), commandId: crypto.randomUUID() }, '创建仙盟', `创建「${createName.value.trim()}」将消耗 ${panel.value.createCost} 声望，并由本宗担任盟主。确认建立仙盟？`);
}
function askAccept(inviteId: string, name: string): void {
  ask({ action: 'accept', inviteId, commandId: crypto.randomUUID() }, '接受仙盟邀请', `确认加入「${name}」？加入后将与盟友共讨每周首领，使用本盟专属频道。`);
}
function askMember(action: 'transfer' | 'kick', sectId: string, name: string): void {
  ask({ action, sectId, commandId: crypto.randomUUID() }, action === 'transfer' ? '转让盟主' : '移出仙盟', action === 'transfer' ? `确认将盟主之位转让给「${name}」？转让后本宗将失去邀请、移出成员和解散权限。` : `确认将「${name}」移出仙盟？对方将失去本盟频道和周首领参与资格。`);
}
function askExit(action: 'leave' | 'disband'): void {
  ask({ action, commandId: crypto.randomUUID() }, action === 'leave' ? '退出仙盟' : '解散仙盟', action === 'leave' ? '确认退出当前仙盟？退出后将失去本盟频道与周首领参与资格，24 小时内不能创建或加入仙盟。' : '确认解散仙盟？所有成员将离盟，本盟频道关闭，此操作无法撤销。请先与盟友商议。');
}
function askBuy(item: AlliancePanel['shop'][number]): void {
  if (!item.canBuy) return;
  ask({ action: 'buy', id: item.id, commandId: crypto.randomUUID() }, '确认盟贡兑换', `消耗 ${item.cost} 盟贡兑换「${item.name}」。${item.description}`);
}
async function invite(): Promise<void> {
  const sectId = inviteSectId.value.trim();
  if (actionLocked.value || !isLeader.value || sectId === '' || sectId === props.state.sect.id) return;
  await submit(actionRequest({ action: 'invite', sectId, commandId: crypto.randomUUID() }));
}
async function attack(): Promise<void> {
  if (actionLocked.value || !canAttack.value) return;
  await submit(actionRequest({ action: 'attack', discipleIds: [...selected.value], commandId: crypto.randomUUID() }));
}
async function confirmAction(): Promise<void> {
  if (confirmation.value === null || actionLocked.value) return;
  const pending = confirmation.value.pending;
  confirmation.value = null;
  await submit(pending);
}
async function submit(pending: PendingAction): Promise<void> {
  if (locked.value) return;
  const membershipEntryReplay = pending.scopeId === null && (pending.request.action === 'create' || pending.request.action === 'accept');
  if (pending.scopeId !== allianceId.value && !membershipEntryReplay) {
    failedAction.value = null;
    confirmation.value = null;
    feedback.value = '仙盟身份已改变，请重新确认操作。';
    feedbackError.value = true;
    return;
  }
  cancelChat(false);
  panelRequest += 1;
  submitting.value = true;
  emit('busy-change', true);
  failedAction.value = null;
  feedback.value = null;
  feedbackError.value = false;
  let failed = false;
  try {
    const data = await postAllianceAction(pending.request);
    if (!active) return;
    applyPanel(data.alliance);
    acceptState(data.state);
    feedback.value = data.result.message;
    if (pending.request.action === 'create') createName.value = '';
    if (pending.request.action === 'invite') inviteSectId.value = '';
    emit('notify', 'success', '仙盟事务已更新', data.result.message);
  } catch (error) {
    if (!active) return;
    failed = true;
    if (uncertain(error)) failedAction.value = pending;
    if (scopeFailure(error)) { chatSuspended.value = true; cancelChat(true, true); }
    feedback.value = error instanceof Error ? error.message : '仙盟操作失败，请重试';
    feedbackError.value = true;
    emit('notify', 'warning', '仙盟操作未完成', feedback.value);
  } finally {
    submitting.value = false;
    emit('busy-change', false);
  }
  if (failed) await load(true);
  if (activeTab.value === 'chat') void pollChat();
}
async function retryAction(): Promise<void> {
  if (failedAction.value !== null) await submit(failedAction.value);
}
async function sendChat(input?: AllianceChatInput): Promise<void> {
  const currentId = allianceId.value;
  if (currentId === null) return;
  const request = input ?? { allianceId: currentId, content: chatDraft.value.trim(), commandId: crypto.randomUUID() };
  if (locked.value || failedAction.value !== null || request.allianceId !== currentId || request.content === '' || Array.from(request.content).length > 200) return;
  if (failedChat.value !== null && failedChat.value.scopeId !== currentId) { cancelChat(true, true); return; }
  cancelChat(false);
  chatSending.value = true;
  emit('busy-change', true);
  chatError.value = null;
  try {
    const data = await postAllianceChat(request);
    if (!active) return;
    const membership = await fetchAlliance();
    if (!active) return;
    applyPanel(membership.alliance);
    acceptState(membership.state);
    if (allianceId.value !== currentId) return;
    messages.value = data.messages;
    failedChat.value = null;
    chatDraft.value = '';
    await scrollMessages();
  } catch (error) {
    if (!active) return;
    if (scopeFailure(error)) {
      chatSuspended.value = true;
      cancelChat(true, true);
      chatError.value = '当前仙盟身份已改变，请刷新后重新进入频道。';
    } else {
      chatError.value = error instanceof Error ? error.message : '发送失败，请重试';
      if (uncertain(error)) failedChat.value = { input: request, scopeId: currentId };
    }
  } finally {
    chatSending.value = false;
    emit('busy-change', false);
  }
  if (messages.value.length === 0) await load(true);
  nextPoll();
}
function retryChat(): void {
  if (failedChat.value !== null) void sendChat(failedChat.value.input);
}
function refreshChat(): void {
  chatSuspended.value = false;
  void pollChat();
}
async function copySectId(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.state.sect.id);
    copied.value = true;
    if (copiedTimer !== null) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied.value = false; }, 2500);
  } catch {
    emit('notify', 'warning', '复制未完成', '可选中下方只读宗门 ID 手动复制。');
  }
}
function onVisible(): void {
  if (document.hidden) cancelChat(false);
  else if (activeTab.value === 'chat') void pollChat();
  else void load(true);
}
watch(activeTab, (tab) => {
  cancelChat(true);
  if (tab === 'chat') {
    chatSuspended.value = false;
    void pollChat();
  }
});
watch(() => props.state.disciples, () => {
  selected.value = selected.value.filter((id) => props.state.disciples.some((entry) => entry.id === id));
});
watch(() => props.busy, (value) => {
  if (!value && activeTab.value === 'chat') void pollChat();
});
onMounted(() => {
  void load();
  document.addEventListener('visibilitychange', onVisible);
});
onUnmounted(() => {
  active = false;
  panelRequest += 1;
  cancelChat(true, true);
  if (copiedTimer !== null) clearTimeout(copiedTimer);
  document.removeEventListener('visibilitychange', onVisible);
});
</script>

<template>
  <section class="alliance-dialog" aria-labelledby="alliance-title">
    <header class="section-heading panel-heading alliance-heading">
      <div><p class="eyebrow">同道相携 · 共守山河</p><h2 id="alliance-title">{{ alliance?.name ?? '仙盟' }}</h2></div>
      <button class="alliance-small-button" type="button" :disabled="locked" @click="activeTab === 'chat' ? refreshChat() : load()">{{ loading ? '读取中…' : '刷新' }}</button>
    </header>

    <LoadingState v-if="loading && panel === null" label="正在读取仙盟事务" />
    <div v-else-if="panel === null" class="empty-state alliance-empty"><span aria-hidden="true">盟</span><strong>仙盟事务暂不可用</strong><p>{{ loadError ?? '请重新读取仙盟信息。' }}</p><button class="action-button primary-action" type="button" :disabled="locked" @click="load()">重试</button></div>
    <template v-else>
      <div class="alliance-own-id"><label for="alliance-own-sect-id">我的宗门 ID</label><input id="alliance-own-sect-id" :value="state.sect.id" readonly aria-label="我的宗门 ID，可复制给朋友邀请" @focus="($event.target as HTMLInputElement).select()" /><button class="alliance-small-button" type="button" @click="copySectId">{{ copied ? '已复制' : '复制' }}</button></div>
      <div v-if="feedback" class="alliance-feedback" :class="{ error: feedbackError }" role="status"><span>{{ feedback }}</span><button v-if="failedAction" class="alliance-small-button" type="button" :disabled="locked" @click="retryAction">重试上次操作</button></div>
      <div v-if="loadError" class="alliance-feedback error" role="alert"><span>{{ loadError }} · 当前显示上次记录</span><button class="alliance-small-button" type="button" :disabled="locked" @click="load()">重新加载</button></div>
      <div v-if="failedChat" class="alliance-feedback error" role="status"><span>上一条仙盟消息结果尚未确认，请重试原消息后继续操作。</span><button class="alliance-small-button" type="button" :disabled="locked" @click="retryChat">重试原消息</button></div>

      <template v-if="alliance === null">
        <p class="alliance-intro">建立仙盟，与好友共同讨伐每周首领，积累盟贡。加入其他仙盟需由盟主邀请。</p>
        <p v-if="joinCooldown" class="alliance-feedback error">离盟冷却中，可在 {{ formatTime(panel.joinCooldownUntil) }} 后创建或加入仙盟。</p>
        <section class="alliance-card" aria-labelledby="alliance-invites-title"><div class="alliance-section-heading"><h3 id="alliance-invites-title">收到的邀请</h3><span class="count-badge">{{ panel.invites.length }}</span></div><ul v-if="panel.invites.length" class="alliance-row-list"><li v-for="invite in panel.invites" :key="invite.id"><div><strong>{{ invite.allianceName }}</strong><p>有效至 {{ formatTime(invite.expiresAt) }}</p></div><button class="action-button" type="button" :disabled="actionLocked || joinCooldown" @click="askAccept(invite.id, invite.allianceName)">接受邀请</button></li></ul><p v-else class="alliance-muted">暂无邀请。将上方宗门 ID 发给盟主，或请朋友从你的公开档案复制 ID 后邀请。</p></section>
        <section class="alliance-card" aria-labelledby="alliance-create-title"><div class="alliance-section-heading"><h3 id="alliance-create-title">自立仙盟</h3><span class="alliance-cost">{{ panel.createCost }} 声望</span></div><p class="alliance-muted">可用声望 {{ panel.reputation }} · 盟名 2–12 字，创建后由本宗担任盟主。</p><form class="alliance-form" @submit.prevent="askCreate"><label class="alliance-sr-only" for="alliance-create-name">新仙盟名称</label><input id="alliance-create-name" v-model="createName" class="alliance-input" type="text" placeholder="为仙盟起个名字" :disabled="actionLocked || joinCooldown" /><button class="action-button primary-action" type="submit" :disabled="actionLocked || !canCreate">创建仙盟</button></form><p v-if="createName && !validName" class="alliance-form-error">盟名需为 2–12 字且不能换行。</p></section>
        <section class="alliance-card" aria-labelledby="alliance-available-title"><div class="alliance-section-heading"><h3 id="alliance-available-title">四海仙盟</h3><span class="count-badge">{{ panel.available.length }}</span></div><ul v-if="panel.available.length" class="alliance-row-list"><li v-for="item in panel.available" :key="item.id"><div><strong>{{ item.name }}</strong><p>{{ item.active ? '盟约有效' : '已休止' }} · {{ item.members }}/{{ item.memberLimit }} 宗门</p></div><span class="alliance-muted">由盟主邀请加入</span></li></ul><p v-else class="alliance-muted">尚无仙盟，或暂时没有可展示的仙盟。</p></section>
      </template>

      <template v-else>
        <div class="alliance-summary"><span><b>{{ alliance.members.length }}/{{ alliance.memberLimit }}</b> 宗门</span><span>我的盟贡 <b>{{ panel.merit }}</b></span><span>{{ isLeader ? '本宗为盟主' : '本宗为盟员' }}</span><span>{{ alliance.active ? '仙盟已激活' : '集齐 3 宗后开启周首领' }}</span></div>
        <nav class="alliance-tabs" aria-label="仙盟栏目"><button v-for="tab in tabs" :key="tab.id" type="button" :class="{ active: activeTab === tab.id }" :aria-pressed="activeTab === tab.id" @click="activeTab = tab.id">{{ tab.name }}</button></nav>

        <section v-if="activeTab === 'members'" aria-labelledby="alliance-members-title">
          <div class="alliance-section-heading"><h3 id="alliance-members-title">盟中宗门</h3><span class="alliance-muted">同袍协力，共立功勋</span></div>
          <ul class="alliance-members"><li v-for="member in alliance.members" :key="member.sectId"><div class="alliance-member-seal" aria-hidden="true">{{ member.name.slice(0, 1) }}</div><div class="alliance-member-copy"><strong>{{ member.name }}<span v-if="member.sectId === alliance.leaderSectId" class="alliance-leader-tag">盟主</span><span v-if="member.sectId === state.sect.id" class="alliance-self-tag">本宗</span></strong><p>宗门 {{ member.level }} 级 · 累计贡献 {{ member.contribution }}</p></div><div v-if="isLeader && member.sectId !== state.sect.id" class="alliance-member-actions"><button class="alliance-small-button" type="button" :disabled="actionLocked" @click="askMember('transfer', member.sectId, member.name)">转让盟主</button><button class="alliance-small-button danger" type="button" :disabled="actionLocked" @click="askMember('kick', member.sectId, member.name)">移出</button></div></li></ul>
          <section v-if="isLeader" class="alliance-card alliance-invite-card" aria-labelledby="alliance-send-invite-title"><h3 id="alliance-send-invite-title">邀请同道</h3><p class="alliance-muted">请朋友提供宗门 ID，或从“江湖榜 → 公开档案”复制对方宗门 ID。</p><form class="alliance-form" @submit.prevent="invite"><label class="alliance-sr-only" for="alliance-invite-id">被邀请宗门 ID</label><input id="alliance-invite-id" v-model="inviteSectId" class="alliance-input" type="text" placeholder="输入对方的宗门 ID" :disabled="actionLocked" /><button class="action-button" type="submit" :disabled="actionLocked || !inviteSectId.trim() || inviteSectId.trim() === state.sect.id">发送邀请</button></form></section>
          <div class="alliance-exit-row"><p>{{ isLeader ? '盟主可先转让职务，或与全体盟员商议后解散仙盟。' : '退出后 24 小时内不能创建或加入其他仙盟。' }}</p><button class="alliance-small-button danger" type="button" :disabled="actionLocked" @click="askExit(isLeader ? 'disband' : 'leave')">{{ isLeader ? '解散仙盟' : '退出仙盟' }}</button></div>
        </section>

        <section v-else-if="activeTab === 'boss'" aria-labelledby="alliance-boss-title">
          <template v-if="boss"><div class="alliance-boss-card"><p class="eyebrow">每周仙盟首领 · {{ boss.weekKey }}</p><h3 id="alliance-boss-title">{{ boss.name }}</h3><div class="alliance-hp"><i :style="{ width: `${hpPercent}%` }" /></div><p class="alliance-hp-caption">剩余 {{ boss.remainingHp.toLocaleString() }} / {{ boss.maxHp.toLocaleString() }} 气血</p><div class="alliance-boss-facts"><span>本宗累计伤害 <b>{{ boss.damage.toLocaleString() }}</b></span><span>今日出手 <b>{{ boss.attacksToday }}/{{ boss.attackLimit }}</b></span><span>本轮结束 {{ formatTime(boss.endsAt) }}</span></div></div><DisciplePicker :disciples="state.disciples" :selected="selected" :min="1" :max="3" sort="power" show-technique :busy="actionLocked" title="派遣弟子 · 最多 3 人" @update:selected="selected = $event" /><p v-if="boss.blockedReason" class="alliance-form-error">{{ boss.blockedReason }}</p><div class="alliance-attack-row"><span>已选 {{ selected.length }}/3 人</span><button class="action-button primary-action" type="button" :disabled="actionLocked || !canAttack" @click="attack">{{ submitting ? '讨伐中…' : '出手讨伐' }}</button></div><section class="alliance-card"><div class="alliance-section-heading"><h3>本周伤害榜</h3><span class="alliance-muted">本盟宗门协作排行</span></div><ol v-if="boss.ranking.length" class="alliance-ranking"><li v-for="item in boss.ranking" :key="item.sectId" :class="{ self: item.sectId === state.sect.id }"><b>{{ item.rank }}</b><span>{{ item.name }}</span><strong>{{ item.damage.toLocaleString() }}</strong></li></ol><p v-else class="alliance-muted">首领已现，等待盟友率先出手。</p></section></template>
          <div v-else class="empty-state alliance-empty"><span aria-hidden="true">伐</span><strong>本周首领暂未现身</strong><p>可点击刷新查看最新讨伐状态。</p></div>
        </section>

        <section v-else-if="activeTab === 'shop'" aria-labelledby="alliance-shop-title"><div class="alliance-section-heading"><h3 id="alliance-shop-title">盟贡商店</h3><span class="alliance-cost">可用 {{ panel.merit }} 盟贡</span></div><p class="alliance-muted">与盟友协力讨伐，积累盟贡换取修行物资。</p><ul v-if="panel.shop.length" class="alliance-shop-list"><li v-for="item in panel.shop" :key="item.id"><div><strong>{{ item.name }}</strong><p>{{ item.description }}</p><small v-if="item.blockedReason">{{ item.blockedReason }}</small></div><button class="action-button" type="button" :disabled="actionLocked || !item.canBuy" @click="askBuy(item)">{{ item.cost }} 盟贡兑换</button></li></ul><div v-else class="empty-state alliance-empty"><span aria-hidden="true">贡</span><strong>暂无可兑换物品</strong></div></section>

        <section v-else aria-labelledby="alliance-chat-title"><div class="alliance-section-heading"><h3 id="alliance-chat-title">{{ alliance.name }} · 盟中传音</h3><span class="alliance-muted">{{ chatLoading ? '正在同步…' : '每 10 秒同步' }}</span></div><p class="alliance-muted">仅本盟成员可读写。离开此栏目或关闭弹窗后停止同步。</p><div ref="messageList" class="alliance-chat-list" aria-live="polite" aria-relevant="additions"><div v-if="messages.length === 0" class="alliance-chat-empty">{{ chatLoading ? '正在接通盟中传音…' : '暂无消息，和盟友打个招呼吧。' }}</div><article v-for="message in messages" :key="message.id" class="alliance-message" :class="{ self: message.isMe }"><header><strong>{{ message.sectName }}<small v-if="message.isMe">本宗</small></strong><time :datetime="message.createdAt">{{ formatTime(message.createdAt) }}</time></header><p>{{ message.content }}</p></article></div><div v-if="chatError" class="alliance-feedback error" role="alert"><span>{{ chatError }}</span><button class="alliance-small-button" type="button" :disabled="locked" @click="failedChat ? retryChat() : refreshChat()">{{ failedChat ? '重试原消息' : '重试同步' }}</button></div><form class="alliance-form alliance-chat-form" @submit.prevent="sendChat()"><label class="alliance-sr-only" for="alliance-chat-input">仙盟消息</label><input id="alliance-chat-input" v-model="chatDraft" class="alliance-input" type="text" maxlength="200" placeholder="向盟友传音（最多 200 字）" :disabled="actionLocked" /><button class="action-button primary-action" type="submit" :disabled="actionLocked || !chatDraft.trim()">{{ chatSending ? '发送中…' : '发送' }}</button></form></section>
      </template>
      <ConfirmDialog v-if="confirmation" eyebrow="仙盟事务" :title="confirmation.title" :message="confirmation.message" :confirm-text="`确认${confirmation.title}`" :busy="locked" @confirm="confirmAction" @cancel="confirmation = null" />
    </template>
  </section>
</template>

<style scoped>
.alliance-dialog { min-width: 0; color: var(--ink-text); background: #0c1e1a; box-shadow: 0 0 0 20px #0c1e1a; --modal-head-bg: #0c1e1a; }
.alliance-heading { align-items: flex-start; gap: 12px; margin-bottom: 13px; }
.alliance-heading h2 { margin: 0; font-family: 'STKaiti', 'KaiTi', serif; font-size: 25px; font-weight: 500; }
.alliance-small-button { appearance: none; flex: 0 0 auto; min-height: 29px; padding: 5px 9px; border: 1px solid #76643e; border-radius: 6px; color: #ead19a; background: #1a3027; font-family: inherit; font-size: 11px; line-height: 1.5; cursor: pointer; }
.alliance-small-button:not(:disabled):hover { border-color: #caa96a; background: #263c2f; }
.alliance-small-button:disabled { opacity: .45; cursor: not-allowed; }
.alliance-small-button.danger { border-color: #734c40; color: #d8a28b; background: #29221b; }
.alliance-own-id { display: flex; align-items: center; gap: 7px; padding: 9px; margin-bottom: 12px; border: 1px solid var(--line); border-radius: 8px; background: #10241e; }
.alliance-own-id label { flex: 0 0 auto; color: var(--muted); font-size: 11px; }
.alliance-own-id input { min-width: 0; width: 100%; border: 0; color: var(--jade-bright); background: transparent; font-family: monospace; font-size: 11px; }
.alliance-feedback { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 12px; padding: 10px; border: 1px solid #3e7354; border-radius: 8px; color: var(--jade-bright); background: #102d21; font-size: 12px; }
.alliance-feedback.error { border-color: #76483b; color: #d5aa8c; background: #2a201b; }
.alliance-intro { margin: 0 0 13px; color: var(--muted); font-size: 13px; line-height: 1.7; }
.alliance-card { margin: 12px 0; padding: 12px; border: 1px solid var(--line); border-radius: 9px; background: #10251e; }
.alliance-section-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 9px; }
.alliance-section-heading h3, .alliance-invite-card > h3 { margin: 0; font-family: 'STKaiti', 'KaiTi', serif; font-size: 19px; font-weight: 500; }
.alliance-muted { margin: 5px 0; color: var(--muted); font-size: 11px; line-height: 1.7; }
.alliance-cost { padding: 4px 8px; border: 1px solid var(--line-strong); border-radius: 99px; color: var(--gold-bright); font-size: 11px; }
.alliance-row-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.alliance-row-list > li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 0; border-top: 1px solid var(--line); }
.alliance-row-list strong { font-size: 13px; font-weight: 500; }
.alliance-row-list p { margin: 3px 0 0; color: var(--muted); font-size: 11px; }
.alliance-form { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.alliance-input { min-width: 0; flex: 1; padding: 9px 10px; border: 1px solid var(--line-strong); border-radius: 6px; color: var(--ink-text); background: #091b15; font-family: inherit; font-size: 12px; }
.alliance-input::placeholder { color: var(--faint); }
.alliance-input:focus { outline: 1px solid var(--gold); outline-offset: 1px; }
.alliance-form-error { margin: 8px 0; color: #d4a184; font-size: 12px; }
.alliance-summary { display: flex; flex-wrap: wrap; gap: 7px 15px; margin-bottom: 13px; color: var(--muted); font-size: 12px; }
.alliance-summary b { color: var(--gold-bright); font-weight: 500; }
.alliance-tabs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; margin-bottom: 14px; padding: 4px; border: 1px solid var(--line); border-radius: 9px; background: #091b15; }
.alliance-tabs button { padding: 9px 3px; border: 1px solid transparent; border-radius: 6px; color: var(--muted); background: transparent; font: inherit; font-size: 12px; cursor: pointer; }
.alliance-tabs button.active { border-color: var(--line-strong); color: var(--gold-bright); background: #213426; }
.alliance-members { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.alliance-members > li { display: flex; align-items: center; gap: 10px; padding: 11px; border: 1px solid var(--line); border-radius: 9px; background: #10251e; }
.alliance-member-seal { display: grid; width: 33px; height: 33px; flex: 0 0 auto; place-items: center; border: 1px solid var(--line-strong); border-radius: 8px; color: var(--gold-bright); background: #1b3025; font-family: 'STKaiti', 'KaiTi', serif; font-size: 18px; }
.alliance-member-copy { min-width: 0; flex: 1; }
.alliance-member-copy > strong { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 13px; font-weight: 500; }
.alliance-member-copy p { margin: 4px 0 0; color: var(--muted); font-size: 11px; }
.alliance-leader-tag, .alliance-self-tag { padding: 1px 5px; border: 1px solid var(--line-strong); border-radius: 4px; color: var(--gold); font-size: 10px; }
.alliance-self-tag { border-color: #3a6450; color: var(--jade); }
.alliance-member-actions { display: flex; flex-wrap: wrap; gap: 5px; }
.alliance-exit-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--line); }
.alliance-exit-row p { margin: 0; color: var(--muted); font-size: 11px; }
.alliance-boss-card { margin-bottom: 14px; padding: 17px; border: 1px solid #684e39; border-radius: 10px; background: radial-gradient(ellipse at top, #372c20, #16241b); text-align: center; }
.alliance-boss-card > h3 { margin: 4px 0 12px; color: var(--gold-bright); font-family: 'STKaiti', 'KaiTi', serif; font-size: 24px; font-weight: 500; }
.alliance-hp { height: 8px; overflow: hidden; border: 1px solid #794f3a; border-radius: 99px; background: #2c201b; }
.alliance-hp i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #8a4f37, #d69b60); }
.alliance-hp-caption { margin: 6px 0 10px; color: #d0ad8a; font-size: 11px; }
.alliance-boss-facts { display: flex; flex-wrap: wrap; justify-content: center; gap: 7px 17px; color: var(--muted); font-size: 11px; }
.alliance-boss-facts b { color: var(--gold-bright); font-weight: 500; }
.alliance-attack-row { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin: 13px 0; color: var(--muted); font-size: 12px; }
.alliance-ranking { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }
.alliance-ranking li { display: flex; align-items: center; gap: 9px; padding: 7px 3px; color: var(--muted); font-size: 12px; }
.alliance-ranking li > b { width: 21px; color: var(--gold); font-weight: 500; }
.alliance-ranking li > span { flex: 1; }
.alliance-ranking li > strong { color: var(--ink-text); font-weight: 500; }
.alliance-ranking li.self { color: var(--jade-bright); }
.alliance-shop-list { display: grid; gap: 8px; margin: 12px 0; padding: 0; list-style: none; }
.alliance-shop-list li { display: flex; align-items: center; justify-content: space-between; gap: 13px; padding: 12px; border: 1px solid var(--line); border-radius: 9px; background: #10251e; }
.alliance-shop-list strong { font-size: 14px; font-weight: 500; }
.alliance-shop-list p { margin: 5px 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.alliance-shop-list small { color: #d0a78c; font-size: 11px; }
.alliance-chat-list { min-height: 230px; max-height: 350px; overflow-y: auto; overscroll-behavior: contain; padding: 10px; border: 1px solid var(--line); border-radius: 9px; background: #091b15; }
.alliance-chat-empty { display: grid; min-height: 200px; align-items: center; color: var(--faint); text-align: center; font-size: 12px; }
.alliance-message { margin-bottom: 12px; padding: 9px 10px; border-left: 2px solid #3f6750; border-radius: 0 6px 6px 0; background: #11281e; }
.alliance-message.self { border-color: #b69956; background: #252c1e; }
.alliance-message header { display: flex; align-items: center; justify-content: space-between; gap: 9px; }
.alliance-message strong { color: var(--jade-bright); font-size: 12px; font-weight: 500; }
.alliance-message small { margin-left: 6px; color: var(--gold); font-size: 10px; }
.alliance-message time { flex: 0 0 auto; color: var(--faint); font-size: 10px; }
.alliance-message p { margin: 5px 0 0; overflow-wrap: anywhere; white-space: pre-wrap; font-size: 12px; line-height: 1.6; }
.alliance-chat-form { margin-top: 10px; }
.alliance-confirm { position: sticky; z-index: 4; bottom: 0; margin-top: 15px; padding: 14px; border: 1px solid #987344; border-radius: 9px; background: #292418; box-shadow: 0 -8px 25px #0c1e1a; }
.alliance-confirm h3 { margin: 4px 0 8px; color: var(--gold-bright); font-family: 'STKaiti', 'KaiTi', serif; font-size: 21px; font-weight: 500; }
.alliance-confirm > p:not(.eyebrow) { color: #d8c3a5; font-size: 12px; line-height: 1.7; }
.alliance-confirm > div { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.alliance-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }
.alliance-empty { padding: 25px 8px; }
.alliance-empty .action-button { margin-top: 8px; }
@media (max-width: 600px) {
  .alliance-tabs { gap: 2px; padding: 3px; }
  .alliance-tabs button { padding: 9px 2px; font-size: 11px; }
  .alliance-member-actions { width: 100%; margin-left: 43px; }
  .alliance-members > li { flex-wrap: wrap; }
  .alliance-shop-list li { align-items: stretch; flex-direction: column; }
  .alliance-form { flex-wrap: wrap; }
  .alliance-form .action-button { flex: 0 0 auto; }
  .alliance-row-list > li { align-items: flex-start; flex-wrap: wrap; }
}
</style>
