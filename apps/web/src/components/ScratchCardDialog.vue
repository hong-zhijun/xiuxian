<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { ScratchCardBuyInput, ScratchCardMode, ScratchCardTicket, ScratchCardTier, SectStateView } from '../api/game';
import { buyScratchCard, fetchScratchCard } from '../api/game';
import { ApiError } from '../api/client';
import { formatAmount } from '../utils/format';
import ScratchSurface from './ScratchSurface.vue';

const props = defineProps<{ state: SectStateView; busy: boolean }>();
const emit = defineEmits<{
  'state-update': [state: SectStateView];
  notify: [tone: 'success' | 'warning', title: string, message: string];
  back: [];
}>();
const panel = computed(() => props.state.gambling.scratchCards);
const tierId = ref<ScratchCardTier>('basic');
const modeId = ref<ScratchCardMode>('triple');
const scratchProgress = ref(0);
const ticket = ref<ScratchCardTicket | null>(null);
const revealed = ref(false);
const submitting = ref(false);
const loading = ref(true);
const loadError = ref(false);
const pending = ref<ScratchCardBuyInput | null>(null);
const error = ref('');
const storageKey = `xiuxian:scratch-pending:${props.state.sect.id}`;
const activeTier = computed(() => panel.value?.tiers.find(tier => tier.id === tierId.value));
const activeMode = computed(() => panel.value?.modes.find(mode => mode.id === modeId.value));
const balance = computed(() => props.state.resources.find(item => item.id === 'spiritStone')?.balance ?? '0');
const blockReason = computed(() => {
  if (pending.value !== null) return null; // Retry the same purchase even after its last daily use committed.
  if (!props.state.gambling.unlocked) return props.state.gambling.blockedReason;
  if (props.state.gambling.remaining <= 0) return '今日赌坊次数已用完';
  if (activeTier.value === undefined || activeMode.value === undefined) return '暂无可购票签';
  if (Number(balance.value) < Number(activeTier.value.cost)) return '灵石不足';
  return null;
});
const canBuy = computed(() => !props.busy && !submitting.value && !loading.value && !loadError.value
  && blockReason.value === null && (ticket.value === null || revealed.value));
const selectionLocked = computed(() => props.busy || submitting.value || loading.value || pending.value !== null || (ticket.value !== null && !revealed.value));

function savePending(input: ScratchCardBuyInput | null): void {
  pending.value = input;
  try {
    if (input === null) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, JSON.stringify(input));
  } catch { /* A blocked browser store still permits retries during this visit. */ }
}

function chooseMode(mode: ScratchCardMode): void {
  if (selectionLocked.value || modeId.value === mode) return;
  modeId.value = mode;
  ticket.value = null;
  revealed.value = false;
  scratchProgress.value = 0;
  error.value = '';
}

function revealAll(): void {
  if (ticket.value === null || revealed.value) return;
  revealed.value = true;
  emit('notify', Number(ticket.value.reward) > 0 ? 'success' : 'warning', '刮刮乐', ticket.value.message);
}

async function recover(): Promise<void> {
  loading.value = true;
  loadError.value = false;
  error.value = '';
  try {
    const response = await fetchScratchCard(pending.value?.requestId);
    emit('state-update', response.state);
    ticket.value = response.ticket;
    if (response.ticket !== null) {
      revealed.value = true;
      tierId.value = response.ticket.tier;
      modeId.value = response.ticket.mode;
      savePending(null);
    }
  } catch (cause) {
    loadError.value = true;
    error.value = cause instanceof Error ? cause.message : '读取票签失败，请重试';
  } finally { loading.value = false; }
}

async function buy(): Promise<void> {
  if (!canBuy.value) return;
  submitting.value = true;
  error.value = '';
  const input = pending.value ?? { requestId: crypto.randomUUID(), tier: tierId.value, mode: modeId.value };
  savePending(input);
  try {
    const response = await buyScratchCard(input);
    ticket.value = response.ticket;
    revealed.value = false;
    scratchProgress.value = 0;
    emit('state-update', response.state);
    savePending(null);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '购票失败，请重试';
    // Unknown transport/server failures retain the ID: a lost response may hide a committed purchase.
    if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500
      && cause.code !== 'INVALID_STATUS') savePending(null);
  } finally { submitting.value = false; }
}

onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as ScratchCardBuyInput | null;
    if (saved !== null && typeof saved.requestId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved.requestId)
      && ['basic', 'lucky', 'fortune'].includes(saved.tier)
      && ['triple', 'numbers', 'duel', 'lines'].includes(saved.mode ?? 'triple')) {
      pending.value = { ...saved, mode: saved.mode ?? 'triple' };
      tierId.value = saved.tier;
      modeId.value = saved.mode ?? 'triple';
    }
  } catch { /* Invalid saved data is ignored. */ }
  void recover();
});
</script>

<template>
  <section class="scratch-dialog" aria-labelledby="scratch-title">
    <div class="scratch-heading">
      <div><p class="scratch-eyebrow">四种刮法 · 各有机缘</p><h3 id="scratch-title">刮刮乐</h3></div>
      <button class="quiet-button" type="button" :disabled="submitting" @click="emit('back')">返回赌坊</button>
    </div>
    <div class="scratch-modes" role="group" aria-label="选择刮奖玩法">
      <button v-for="mode in panel?.modes ?? []" :key="mode.id" type="button" class="scratch-mode"
        :class="{ selected: modeId === mode.id }" :aria-pressed="modeId === mode.id" :disabled="selectionLocked" @click="chooseMode(mode.id)">
        <strong>{{ mode.name }}</strong><span>{{ mode.tagline }}</span><small>最高 {{ mode.maxMultiplier }} 倍 · 有奖约 {{ mode.winChanceBp / 100 }}%</small>
      </button>
    </div>
    <p class="scratch-intro">{{ activeMode?.description }}</p>
    <div class="scratch-tiers" role="group" aria-label="票签档位">
      <button v-for="tier in panel?.tiers ?? []" :key="tier.id" class="scratch-tier" :class="{ selected: tierId === tier.id }"
        type="button" :aria-pressed="tierId === tier.id" :disabled="selectionLocked"
        @click="tierId = tier.id">
        <strong>{{ tier.name }}</strong><span>{{ formatAmount(tier.cost) }} 灵石</span><small>最高 {{ formatAmount(String(Number(tier.cost) * (activeMode?.maxMultiplier ?? 0))) }}</small>
      </button>
    </div>
    <div v-if="loading" class="scratch-empty" role="status">正在查看最近的票签…</div>
    <article v-else-if="ticket" class="scratch-ticket">
      <div class="scratch-ticket-top"><strong>{{ ticket.modeName }} · {{ ticket.tierName }}</strong><span>票价 {{ formatAmount(ticket.cost) }} 灵石</span></div>
      <div v-if="ticket.targets.length" class="scratch-targets">
        <span>{{ ticket.mode === 'numbers' ? '幸运号码' : '三局对手点数' }}</span>
        <strong v-for="(target, index) in ticket.targets" :key="index">{{ ticket.mode === 'numbers' ? String(target).padStart(2, '0') : target }}</strong>
      </div>
      <ScratchSurface :key="ticket.id" :revealed="revealed" @reveal="revealAll" @progress="scratchProgress = $event">
        <div class="scratch-board">
        <div class="scratch-grid" :class="`scratch-grid-${ticket.mode}`">
          <div v-for="(cell, index) in ticket.cells" :key="index" class="scratch-cell"
            :class="{ winning: revealed && cell.winning }" :style="{ '--cell-index': index }">
            <strong>{{ cell.value }}</strong><span>{{ cell.label }}</span>
            <small v-if="ticket.mode === 'numbers'">奖金 {{ formatAmount(String(Number(ticket.cost) * cell.multiplier)) }} 灵石</small>
            <small v-if="ticket.mode === 'duel'">{{ revealed ? (cell.winning ? '胜 · 返还半倍' : '未胜出') : '你的点数' }}</small>
          </div>
        </div>
        <svg v-if="revealed && ticket.mode === 'lines'" class="scratch-lines" viewBox="0 0 300 300" preserveAspectRatio="none" aria-hidden="true">
          <line v-for="(win, index) in ticket.wins.filter(item => item.indexes.length === 3)" :key="index"
            :x1="(win.indexes[0]! % 3) * 100 + 50" :y1="Math.floor(win.indexes[0]! / 3) * 100 + 50"
            :x2="(win.indexes[2]! % 3) * 100 + 50" :y2="Math.floor(win.indexes[2]! / 3) * 100 + 50" />
        </svg>
        </div>
      </ScratchSurface>
      <div class="scratch-result" aria-live="polite">
        <template v-if="revealed"><strong>{{ Number(ticket.reward) > 0 ? `奖金合计 ${formatAmount(ticket.reward)} 灵石` : '本张未中奖' }}</strong><p>{{ ticket.message }}</p></template>
        <p v-else>已刮 {{ scratchProgress }}% · 刮开80%后松手自动揭晓，也可一键刮开。</p>
      </div>
      <ul v-if="revealed && ticket.wins.length" class="scratch-win-list" aria-label="中奖明细">
        <li v-for="(win, index) in ticket.wins" :key="index"><span>{{ win.label }}</span><strong>{{ win.multiplier }}倍 · {{ formatAmount(String(Number(ticket.cost) * win.multiplier)) }} 灵石</strong></li>
      </ul>
    </article>
    <div v-else class="scratch-empty"><span aria-hidden="true">签</span><p>{{ activeMode?.name }} · {{ activeMode?.tagline }}</p></div>
    <div class="scratch-actions">
      <button v-if="ticket && !revealed" class="action-button primary-action" type="button" @click="revealAll">一键刮开</button>
      <button v-else-if="loadError" class="action-button" type="button" @click="recover">重新读取票签</button>
      <button v-else class="action-button primary-action" type="button" :disabled="!canBuy" @click="buy">
        {{ submitting ? '正在购票…' : pending ? '重试上次购票' : ticket ? '再买一张' : '购买一张' }}
        <span v-if="!submitting && !pending"> · {{ formatAmount(activeTier?.cost ?? '0') }} 灵石</span>
      </button>
      <span class="scratch-balance">持有 {{ formatAmount(balance) }} 灵石</span>
    </div>
    <p v-if="error" class="blocked-hint" role="alert">{{ error }}</p>
    <p v-else-if="pending" class="scratch-note">上次购票结果待确认，重试会取回同一张票。</p>
    <p v-else-if="blockReason" class="blocked-hint">{{ blockReason }}</p>
    <details class="scratch-rules">
      <summary>{{ activeMode?.name }} · 奖项与玩法说明</summary>
      <p v-for="rule in activeMode?.rules ?? []" :key="rule">{{ rule }}</p>
      <ul><li v-for="rule in activeMode?.rewardRules ?? []" :key="rule.label"><span>{{ rule.label }}</span><strong>{{ rule.payout }}</strong></li></ul>
      <p>本玩法有奖概率约 {{ (activeMode?.winChanceBp ?? 0) / 100 }}%，长期平均返还率约 {{ (activeMode?.returnRateBp ?? 0) / 100 }}%。各票价档位概率相同。</p>
      <p>奖额是实际返还金额，净收益＝奖额－票价；领到小奖也可能未回本。</p>
      <p>每张使用1次赌坊次数，与其他赌坊玩法共享每日额度。购票时完成开奖与奖金入账，刮开、返回或刷新均不再扣费。</p>
    </details>
  </section>
</template>

<style scoped>
.scratch-dialog { display: grid; gap: 16px; }
.scratch-modes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.scratch-mode { display: grid; gap: 6px; text-align: left; padding: 12px; border: 1px solid #465c4d; background: #172b24; border-radius: 8px; color: #ccdbc9; cursor: pointer; }
.scratch-mode strong { font-size: 16px; }.scratch-mode span { font-size: 12px; color: #b2bea5; }.scratch-mode small { font-size: 11px; color: #94aa98; }
.scratch-mode.selected { border-color: #cfad66; background: #383a25; }.scratch-mode:disabled { cursor: default; }.scratch-mode:disabled:not(.selected) { opacity: .6; }
.scratch-heading, .scratch-ticket-top, .scratch-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.scratch-eyebrow { margin: 0 0 6px; color: #bca774; font-size: 12px; letter-spacing: 2px; }
h3 { margin: 0; color: #ebd59e; font-size: 25px; }
.scratch-intro, .scratch-note { margin: 0; color: #a8b9ae; font-size: 13px; line-height: 1.7; }
.scratch-tiers { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.scratch-tier { display: grid; gap: 7px; padding: 14px 6px; border: 1px solid #56604d; border-radius: 8px; background: #182b25; color: #c3d0c6; cursor: pointer; }
.scratch-tier strong { font-size: 16px; }.scratch-tier small { color: #8da094; }
.scratch-tier.selected { border-color: #d3b36b; background: #373726; box-shadow: inset 0 0 0 1px #d3b36b; color: #f1dca9; }
.scratch-tier:disabled { cursor: default; }.scratch-tier:disabled:not(.selected) { opacity: .6; }
.scratch-ticket { border: 1px solid #a88b51; border-radius: 14px; padding: 12px; background: linear-gradient(145deg, #383a24, #172a24); }
.scratch-ticket-top { flex-wrap: wrap; padding: 3px 3px 13px; color: #e8d5a5; }.scratch-ticket-top span { font-size: 12px; color: #b9bca2; }
.scratch-targets { display: flex; align-items: center; gap: 10px; padding: 0 4px 12px; color: #c2cba9; font-size: 12px; }.scratch-targets strong { border: 1px solid #82764b; padding: 4px 9px; border-radius: 5px; color: #f0d59b; font-size: 19px; }
.scratch-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; padding: 10px; background: #10231d; }
.scratch-board { position: relative; }.scratch-lines { position: absolute; inset: 10px; width: calc(100% - 20px); height: calc(100% - 20px); pointer-events: none; }
.scratch-lines line { stroke: #ffe39b; stroke-width: 2; stroke-linecap: round; opacity: .65; stroke-dasharray: 500; animation: scratch-line .6s ease-out both; }
@keyframes scratch-line { from { stroke-dashoffset: 500; opacity: 0; } to { stroke-dashoffset: 0; opacity: .65; } }
.scratch-grid-numbers { grid-template-columns: repeat(2, 1fr); }.scratch-grid-numbers .scratch-cell { min-height: 93px; }.scratch-grid-duel .scratch-cell { min-height: 180px; }
.scratch-cell { display: grid; justify-items: center; align-content: center; gap: 4px; min-width: 0; min-height: 77px; border: 1px solid #455044; border-radius: 6px; color: #c0c9b1; background: #26352a; }
.scratch-cell strong { font: 700 30px serif; }.scratch-cell span { font-size: 11px; color: #a6b5a3; text-align: center; line-height: 1.5; }
.scratch-cell small { font-size: 11px; color: #cdbd8e; text-align: center; line-height: 1.6; }
.scratch-win-list { display: grid; gap: 6px; margin: 12px 0 0; padding: 12px 4px 0; border-top: 1px solid #69734a; list-style: none; font-size: 12px; color: #b9c7aa; }.scratch-win-list li { display: flex; justify-content: space-between; gap: 10px; }.scratch-win-list strong { font-weight: 500; color: #e7d19c; }
.scratch-cell.winning { border-color: #dfbd6d; background: #50452b; color: #ffe2a0; animation: scratch-prize .7s ease-out both; animation-delay: calc(var(--cell-index) * 40ms); }.scratch-cell.winning span { color: #eed7a4; }
@keyframes scratch-prize { 0% { transform: scale(.92); box-shadow: 0 0 0 transparent; } 45% { transform: scale(1.06); box-shadow: 0 0 22px #d8b26480; } 100% { transform: scale(1); box-shadow: inset 0 0 12px #d8b26420; } }
.scratch-result { text-align: center; padding: 15px 4px 3px; color: #ead397; }.scratch-result p { margin: 6px 0; font-size: 12px; color: #aabbab; line-height: 1.6; }
.scratch-empty { display: grid; place-content: center; min-height: 215px; text-align: center; border: 1px dashed #6d7354; border-radius: 12px; color: #a2b19f; }
.scratch-empty > span { margin: auto; display: grid; place-items: center; width: 65px; height: 65px; border: 1px solid #8d7950; color: #c1a66b; font: 32px serif; transform: rotate(-8deg); }
.scratch-actions { flex-wrap: wrap; }.scratch-balance { font-size: 12px; color: #9daf9f; }
.scratch-rules { color: #a4b49e; font-size: 12px; border-top: 1px solid #43503c; padding-top: 14px; line-height: 1.7; }
.scratch-rules summary { cursor: pointer; color: #c6bc93; }.scratch-rules ul { list-style: none; padding: 0; display: grid; gap: 6px; }.scratch-rules li { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }.scratch-rules strong { font-weight: 500; color: #d9ca9e; }
button:focus-visible, summary:focus-visible { outline: 2px solid #eed492; outline-offset: 3px; }
@media (max-width: 420px) { .scratch-tiers { gap: 6px; }.scratch-tier span { font-size: 12px; }.scratch-ticket { padding: 8px; }.scratch-balance { width: 100%; } }
@media (prefers-reduced-motion: reduce) { .scratch-cell.winning, .scratch-lines line { animation: none; } }
</style>
