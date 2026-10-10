<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';

import type {
  ResourceView,
  SectStateView,
  StoneGambleResult,
  StoneOutcomeId,
  StonePayResource,
  StoneTierId,
  StoneTierView,
} from '../api/game';
import { stoneGamble } from '../api/game';
import { formatAmount } from '../utils/format';
import ModalShell from './ModalShell.vue';

/**
 * 赌石（赌坊第四个玩法，弹窗内容；外壳与「返回」由 GamblingHouseDialog 接线）：
 * 花灵石 / 药材 / 矿石买一块原石，当场切开，开出玄铁。
 *
 * 服务端是唯一的规则来源：档位门槛、概率、玄铁个数、材料折算、保底与落格全部在服务端，
 * 这里只渲染 state.gambling.stones，并做一次「按钮能不能点」的预检（门槛 / 余额 / 玄铁容量）。
 * 预检只为禁用按钮与给出原因；点下去以服务端回执为准，结果与文案原样展示，不在前端算结果。
 *
 * 切石请求由本组件自己发起（与灵兽竞逐同一做法）：成功后把新 state 交给上层，并发出结果提示。
 * 开石动画纯属展示：结果到手后才开始演出（石块晃动、刀光一闪、按块依次裂开），
 * 天价金光满屏、大涨 / 小涨透出青光、垮了冒灰烟；系统要求减少动效时直接摆出结果。
 */
const props = defineProps<{
  state: SectStateView;
  busy: boolean;
}>();

const emit = defineEmits<{
  /** 切石成功后的 state 回执（上层据此覆盖顶层 state）。 */
  'state-update': [state: SectStateView];
  /** 切石结果提示（成功）；失败时用 warning。 */
  notify: [tone: 'success' | 'warning', title: string, message: string];
  /** 返回赌坊玩法列表。 */
  back: [];
}>();

/** 玄铁资源 id（只用于预检与展示，名字取自服务端资源表）。 */
const XUANTIE_ID = 'xuantie';

/** 资源最小单位换算：1 展示单位 = 1000 最小单位（与 utils/format.ts 同口径）。 */
const UNITS_PER_DISPLAY = 1000;

/** 支付方式的界面顺序。 */
const PAY_OPTIONS: readonly StonePayResource[] = ['spiritStone', 'herb', 'ore'];

/** 结果汇总的展示顺序：天价 → 大涨 → 小涨 → 垮了。 */
const SUMMARY_ORDER: readonly StoneOutcomeId[] = ['jackpot', 'big', 'small', 'bust'];

/** 动画节奏（毫秒）：石块晃动并被刀光切开的时长，以及每块依次翻开的间隔。 */
const CUT_MS = 900;
const FLIP_STEP_MS = 140;

/** 开石舞台的阶段：待切 · 等待结果 · 晃动切开 · 依次翻开 · 结果摆出。 */
type Phase = 'idle' | 'waiting' | 'cutting' | 'opening' | 'revealed';

const stones = computed(() => props.state.gambling.stones);
const tiers = computed<StoneTierView[]>(() => stones.value?.tiers ?? []);
const materialPerStone = computed(() => stones.value?.materialPerStone ?? 2);

const tierId = ref<StoneTierId>('gravel');
const payResource = ref<StonePayResource>('spiritStone');

/** 当前选中的档位：选中项不存在时回退到第一个够门槛的档位（只有列表为空时才是 null）。 */
const activeTier = computed<StoneTierView | null>(() => {
  const selected = tiers.value.find((tier) => tier.id === tierId.value);
  if (selected !== undefined) return selected;
  return tiers.value.find((tier) => tier.unlocked) ?? tiers.value[0] ?? null;
});

/* ---------- 资源与预检（只为禁用按钮，服务端再判一次） ---------- */

function resourceOf(resourceId: string): ResourceView | null {
  return props.state.resources.find((item) => item.id === resourceId) ?? null;
}

function resourceName(resourceId: string): string {
  return resourceOf(resourceId)?.name ?? resourceId;
}

/** 余额（最小单位）；查不到按 0 处理，按钮自然不可点，不会伪造余额。 */
function balanceMinOf(resourceId: string): number {
  const resource = resourceOf(resourceId);
  return resource === null ? 0 : Number(resource.balance);
}

const xuantieBalance = computed(() => balanceMinOf(XUANTIE_ID));

/**
 * 每块的花费（展示单位，只用于预览）：灵石 = 价格；药材 / 矿石 = 价格 × 材料换算（1 灵石 = 2 材料）。
 * 预检与服务端一样换算成最小单位比较；展示只用这个数字，不参与结算。
 */
function perStoneDisplay(tier: StoneTierView, pay: StonePayResource): number {
  return pay === 'spiritStone' ? tier.price : tier.price * materialPerStone.value;
}

/** 玄铁剩余容量够装几块该档的天价（与服务端 room 同口径）；≥ 1 就能切，连切 10 块也只看这一块。 */
function xuantieRoomOf(tier: StoneTierView): number {
  const xuantie = resourceOf(XUANTIE_ID);
  if (xuantie === null) return 0;
  const remaining = Number(xuantie.capacity) - Number(xuantie.balance);
  return Math.max(0, Math.floor(remaining / (tier.topPrize * UNITS_PER_DISPLAY)));
}

/** 能不能切（count 块）的原因：返回 null = 预检通过。文案与服务端保持一致。 */
function blockReasonOf(tier: StoneTierView | null, count: 1 | 10): string | null {
  if (!props.state.gambling.unlocked) return props.state.gambling.blockedReason ?? '赌坊尚未开启';
  if (tier === null) return '暂无可切的原石';
  if (!tier.unlocked) return tier.blockedReason ?? `${tier.name}尚未解锁`;
  const remaining = props.state.gambling.remaining;
  if (remaining < count) {
    return remaining <= 0 ? '今日赌坊次数已用完' : `今日赌坊次数只剩 ${String(remaining)} 次`;
  }
  const need = perStoneDisplay(tier, payResource.value) * UNITS_PER_DISPLAY * count;
  if (balanceMinOf(payResource.value) < need) return `${resourceName(payResource.value)}不足`;
  if (xuantieRoomOf(tier) < 1) return `玄铁库存快满了（装不下一块${tier.name}的天价 ${String(tier.topPrize)} 个）`;
  return null;
}

/* ---------- 切石与开石动画 ---------- */

const phase = ref<Phase>('idle');
const submitting = ref(false);
/** 本次要摆出的块数（结果到手前就按它摆石块）。 */
const shownCount = ref<1 | 10>(1);
/** 结果到手后才有值；动画、汇总都从它读。 */
const reveal = ref<StoneGambleResult | null>(null);
/** 已经翻开的块数（依次翻开时递增）。 */
const openedCount = ref(0);

let cutTimer: number | undefined;
let flipTimer: number | undefined;
/** 等动画演完再发的结果提示（提前发会抢先剧透结果）；弹窗中途关掉时在卸载前补发。 */
let pendingNotice: { title: string; message: string } | null = null;

function flushNotice(): void {
  if (pendingNotice === null) return;
  emit('notify', 'success', pendingNotice.title, pendingNotice.message);
  pendingNotice = null;
}

const animating = computed(
  () => phase.value === 'waiting' || phase.value === 'cutting' || phase.value === 'opening',
);

function canCut(count: 1 | 10): boolean {
  return blockReasonOf(activeTier.value, count) === null && !props.busy && !submitting.value && !animating.value;
}

/** 按钮下方的一句原因：「切石」不行先说它；它能切时再说明「连切 10 块」为何不行。 */
const hint = computed<string | null>(() => {
  const single = blockReasonOf(activeTier.value, 1);
  if (single !== null) return single;
  const ten = blockReasonOf(activeTier.value, 10);
  return ten === null ? null : `连切 10 块：${ten}`;
});

function clearTimers(): void {
  if (cutTimer !== undefined) window.clearTimeout(cutTimer);
  if (flipTimer !== undefined) window.clearTimeout(flipTimer);
  cutTimer = undefined;
  flipTimer = undefined;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 依次翻开下一块；全部翻完进入 revealed（汇总与效果只在这一阶段显示）。 */
function flipNext(): void {
  const total = reveal.value?.count ?? 0;
  if (openedCount.value < total) {
    openedCount.value += 1;
  }
  if (openedCount.value >= total) {
    flipTimer = undefined;
    phase.value = 'revealed';
    flushNotice();
    return;
  }
  flipTimer = window.setTimeout(flipNext, FLIP_STEP_MS);
}

/** 结果到手：减少动效时直接摆出结果；否则先晃动切开，再按块依次翻开。 */
function playReveal(result: StoneGambleResult): void {
  clearTimers();
  reveal.value = result;
  if (prefersReducedMotion()) {
    openedCount.value = result.count;
    phase.value = 'revealed';
    flushNotice();
    return;
  }
  openedCount.value = 0;
  phase.value = 'cutting';
  cutTimer = window.setTimeout(() => {
    cutTimer = undefined;
    phase.value = 'opening';
    flipNext();
  }, CUT_MS);
}

/**
 * 切石（POST /game/stone-gamble）：点下去先进入等待；服务端回执到手后才开始演出。
 * 失败只提示，不动已有的 state（扣费与落库都在服务端，未成功就不会扣）。
 */
async function cut(count: 1 | 10): Promise<void> {
  const tier = activeTier.value;
  if (tier === null || !canCut(count)) return;
  clearTimers();
  flushNotice();
  shownCount.value = count;
  reveal.value = null;
  openedCount.value = 0;
  submitting.value = true;
  phase.value = 'waiting';
  try {
    const { state: next, result } = await stoneGamble(tier.id, payResource.value, count);
    emit('state-update', next);
    pendingNotice = { title: `赌石 · ${result.tierName}`, message: result.message };
    playReveal(result);
  } catch (caught) {
    phase.value = 'idle';
    emit('notify', 'warning', '切石未成', caught instanceof Error ? caught.message : '切石暂时无法完成，请稍后重试。');
  } finally {
    submitting.value = false;
  }
}

/** 舞台上摆几块：有结果按结果的块数，否则按点下去的块数。 */
const displayCount = computed(() => reveal.value?.count ?? shownCount.value);
const blockIndexes = computed(() => Array.from({ length: displayCount.value }, (_, index) => index));

function blockClass(index: number): Record<string, boolean> {
  const outcome = reveal.value?.outcomes[index];
  const isOpen = (phase.value === 'opening' || phase.value === 'revealed') && index < openedCount.value;
  return {
    'is-waiting': phase.value === 'waiting',
    'is-cutting': phase.value === 'cutting',
    'is-open': isOpen,
    'is-bust': isOpen && outcome === 'bust',
    'is-small': isOpen && outcome === 'small',
    'is-big': isOpen && outcome === 'big',
    'is-jackpot': isOpen && outcome === 'jackpot',
  };
}

/** 整个舞台的光效：本次出现过天价 → 金光；出现过大涨 / 小涨 → 青光；只垮了 → 灰烟。 */
const effectTone = computed<'smoke' | 'glow' | 'gold' | null>(() => {
  const result = reveal.value;
  if (result === null || phase.value !== 'revealed') return null;
  if (result.counts.jackpot > 0) return 'gold';
  if (result.counts.big > 0 || result.counts.small > 0) return 'glow';
  return 'smoke';
});

const stageClass = computed(() => ({
  'is-solo': displayCount.value === 1,
  [`is-${phase.value}`]: true,
}));

function outcomeNameOf(tierIdValue: string, outcomeId: StoneOutcomeId): string {
  const tier = tiers.value.find((item) => item.id === tierIdValue);
  return tier?.outcomes.find((item) => item.id === outcomeId)?.name ?? outcomeId;
}

/** 汇总：只列出本次出现过的结果（服务端下发的 counts，前端不另算）。 */
const summaryRows = computed(() => {
  const result = reveal.value;
  if (result === null) return [];
  return SUMMARY_ORDER.filter((id) => result.counts[id] > 0).map((id) => ({
    id,
    label: outcomeNameOf(result.tier, id),
    count: result.counts[id],
  }));
});

/* ---------- 说明（赌石记录并入赌坊记录，在玩法列表的「赌坊记录」里查看） ---------- */

const showRules = ref(false);

/** 概率的展示：基点 → 百分比（服务端的概率都是 100 的整数倍）。 */
function percentText(chanceBp: number): string {
  return `${String(chanceBp / 100)}%`;
}

/** 按块数给记录一句话：一块写「切一块」，连切写「连切 N 块」。 */
function countText(count: number): string {
  return count === 1 ? '切一块' : `连切 ${String(count)} 块`;
}

onUnmounted(() => {
  clearTimers();
  flushNotice();
});
</script>

<template>
  <section class="stone-panel" aria-labelledby="stone-title">
    <header class="stone-head">
      <button class="stone-back" type="button" :disabled="submitting" @click="emit('back')">返回赌坊</button>
      <h3 id="stone-title" class="stone-title">赌石</h3>
      <div class="stone-head-actions">
        <button class="stone-chip" type="button" @click="showRules = true">说明</button>
      </div>
    </header>
    <p class="stone-note">花灵石或材料买一块原石，当场切开见玄铁。每切一块占 1 次赌坊次数（连切 10 块占 10 次）。</p>

    <p v-if="stones === null" class="blocked-hint">{{ state.gambling.blockedReason ?? '赌坊尚未开启' }}</p>

    <template v-else>
      <p class="eyebrow">原石档位</p>
      <div class="stone-tiers" role="radiogroup" aria-label="原石档位">
        <button
          v-for="tier in tiers"
          :key="tier.id"
          class="stone-tier"
          :class="{ 'is-selected': activeTier?.id === tier.id, 'is-locked': !tier.unlocked }"
          type="button"
          role="radio"
          :aria-checked="activeTier?.id === tier.id"
          :disabled="!tier.unlocked || animating || submitting || busy"
          @click="tierId = tier.id"
        >
          <strong>{{ tier.name }}</strong>
          <span class="stone-tier-price">{{ tier.price }} 灵石</span>
          <small>平均能开出 {{ tier.expectedXuantie }} 玄铁</small>
          <small>天价 {{ tier.topPrize }} 玄铁</small>
          <small v-if="!tier.unlocked && tier.blockedReason" class="stone-tier-lock">{{ tier.blockedReason }}</small>
        </button>
      </div>

      <p class="eyebrow">支付方式</p>
      <div class="stone-pays" role="radiogroup" aria-label="支付方式">
        <button
          v-for="option in PAY_OPTIONS"
          :key="option"
          class="stone-pay"
          :class="{ 'is-selected': payResource === option }"
          type="button"
          role="radio"
          :aria-checked="payResource === option"
          :disabled="animating || submitting || busy"
          @click="payResource = option"
        >
          <strong>{{ resourceName(option) }}</strong>
          <small v-if="activeTier">每块 {{ perStoneDisplay(activeTier, option) }} {{ resourceName(option) }}</small>
          <small>余额 {{ formatAmount(balanceMinOf(option)) }}</small>
        </button>
      </div>
      <p class="stone-balance">当前{{ resourceName(XUANTIE_ID) }}：{{ formatAmount(xuantieBalance) }}</p>

      <div class="stone-stage" :class="stageClass">
        <div class="stone-blocks">
          <span v-for="index in blockIndexes" :key="index" class="stone-block" :class="blockClass(index)">
            <i class="stone-core" aria-hidden="true"></i>
            <i class="stone-blade" aria-hidden="true"></i>
          </span>
        </div>
        <div
          v-if="effectTone"
          class="stone-effect"
          :class="{ 'is-smoke': effectTone === 'smoke', 'is-glow': effectTone === 'glow', 'is-gold': effectTone === 'gold' }"
          aria-hidden="true"
        ></div>
      </div>

      <div v-if="phase === 'revealed' && reveal" class="stone-summary" role="status">
        <strong class="stone-summary-title">{{ reveal.tierName }} · {{ countText(reveal.count) }}</strong>
        <p class="stone-summary-message">{{ reveal.message }}</p>
        <ul class="stone-summary-counts">
          <li v-for="row in summaryRows" :key="row.id" :class="`is-${row.id}`">{{ row.label }} {{ row.count }} 块</li>
        </ul>
        <p class="stone-summary-cost">
          花费 {{ formatAmount(reveal.cost) }} {{ resourceName(reveal.payResource) }} · {{ resourceName(XUANTIE_ID) }} +{{ formatAmount(reveal.xuantie) }}
        </p>
      </div>

      <div class="stone-cut-row">
        <button
          class="action-button primary-action realm-button stone-cut"
          :class="{ 'is-disabled': !canCut(1) }"
          type="button"
          :disabled="!canCut(1)"
          :aria-disabled="!canCut(1)"
          @click="cut(1)"
        >
          <span>切石</span>
        </button>
        <button
          class="action-button primary-action realm-button stone-cut"
          :class="{ 'is-disabled': !canCut(10) }"
          type="button"
          :disabled="!canCut(10)"
          :aria-disabled="!canCut(10)"
          @click="cut(10)"
        >
          <span>连切 10 块</span>
        </button>
      </div>
      <p v-if="hint" class="blocked-hint">{{ hint }}</p>
    </template>

    <!-- 说明：四档的概率、玄铁个数与门槛，全部来自服务端下发的档位表。 -->
    <ModalShell v-if="showRules" narrow label="赌石说明" @close="showRules = false">
      <section class="stone-rules-card" aria-labelledby="stone-rules-title">
        <h2 id="stone-rules-title" class="disciple-detail-title">赌石说明</h2>
        <p class="stone-rules-text">
          每块原石独立开一次，四种结果按下表概率决定，开出的玄铁个数固定。
          药材与矿石按坊市卖出价折算（2 材料 = 1 灵石）。玄铁剩余容量装不下一块该档的天价时不能切；能切时连切 10 块照常全部入账。
        </p>
        <ul class="stone-odds-list">
          <li v-for="tier in tiers" :key="tier.id" class="stone-odds-item">
            <p class="stone-odds-head">
              <strong>{{ tier.name }}</strong>
              <small>{{ tier.price }} 灵石 · 宗门 {{ tier.minSectLevel }} 级 · 平均 {{ tier.expectedXuantie }} 玄铁</small>
            </p>
            <p class="stone-odds-line">
              <span v-for="outcome in tier.outcomes" :key="outcome.id">
                {{ outcome.name }} {{ percentText(outcome.chanceBp) }} · {{ outcome.xuantie }} 玄铁
              </span>
            </p>
          </li>
        </ul>
        <button class="action-button primary-action realm-button" type="button" @click="showRules = false">
          <span>知道了</span>
        </button>
      </section>
    </ModalShell>

  </section>
</template>

<style scoped>
.stone-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.stone-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.stone-title {
  margin: 0;
  color: var(--gold, #caa96a);
  font-family: 'STKaiti', 'KaiTi', serif;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.08em;
}

.stone-head-actions {
  display: flex;
  gap: 6px;
}

.stone-back,
.stone-chip {
  padding: 2px 10px;
  border: 1px solid rgba(202, 169, 106, 0.4);
  border-radius: 2px;
  background: rgba(202, 169, 106, 0.08);
  color: var(--gold, #caa96a);
  font-size: 12px;
  cursor: pointer;
}

.stone-back:not(:disabled):hover,
.stone-chip:not(:disabled):hover {
  background: rgba(202, 169, 106, 0.16);
}

.stone-back:disabled,
.stone-chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.stone-note {
  margin: 0;
  color: #7d9186;
  font-size: 12px;
  line-height: 1.6;
}

/* ---------- 档位卡片 ---------- */

.stone-tiers {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
}

.stone-tier,
.stone-pay {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.014);
  color: #a9bcb2;
  text-align: left;
  transition: border-color 160ms ease, background-color 160ms ease;
}

.stone-tier:not(:disabled):hover,
.stone-pay:not(:disabled):hover {
  border-color: rgba(119, 184, 154, 0.4);
}

.stone-tier.is-selected,
.stone-pay.is-selected {
  border-color: rgba(202, 169, 106, 0.55);
  background: rgba(202, 169, 106, 0.1);
  color: var(--gold, #caa96a);
}

.stone-tier:disabled,
.stone-pay:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.stone-tier strong,
.stone-pay strong {
  color: #dce6e0;
  font-size: 14px;
  font-weight: 500;
}

.stone-tier.is-selected strong,
.stone-pay.is-selected strong {
  color: var(--gold, #caa96a);
}

.stone-tier small,
.stone-pay small {
  color: #7d9186;
  font-size: 11px;
  line-height: 1.5;
}

.stone-tier-price {
  color: var(--gold, #caa96a);
  font-size: 12px;
}

.stone-tier-lock {
  color: #c47272 !important;
}

.stone-pays {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.stone-pay {
  min-width: 110px;
  flex: 1 1 110px;
}

.stone-balance {
  margin: 0;
  color: #a9bcb2;
  font-size: 12px;
}

/* ---------- 开石舞台 ---------- */

.stone-stage {
  position: relative;
  display: flex;
  min-height: 160px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid rgba(202, 169, 106, 0.15);
  border-radius: 6px;
  background:
    radial-gradient(circle at 50% 40%, rgba(202, 169, 106, 0.08), transparent 70%),
    rgba(7, 22, 18, 0.6);
}

.stone-blocks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 16px;
}

.stone-block {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 38px;
  border-radius: 42% 58% 52% 48% / 55% 45% 55% 45%;
  background: linear-gradient(145deg, #948a7c, #4d463c 72%);
  box-shadow: inset -3px -4px 8px rgba(0, 0, 0, 0.35), inset 2px 2px 4px rgba(255, 255, 255, 0.07);
}

.stone-stage.is-solo .stone-block {
  width: 120px;
  height: 100px;
}

/* 裂开：两半各占一侧，翻开后向两边错开。 */
.stone-block::before,
.stone-block::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: inherit;
  transition: transform 450ms ease;
}

.stone-block::before {
  clip-path: inset(0 50% 0 0);
}

.stone-block::after {
  clip-path: inset(0 0 0 50%);
}

.stone-block.is-open::before {
  transform: translate(-7px, -2px) rotate(-6deg);
}

.stone-block.is-open::after {
  transform: translate(7px, 2px) rotate(6deg);
}

.stone-core {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  opacity: 0;
  pointer-events: none;
}

.stone-block.is-open .stone-core {
  opacity: 1;
}

.stone-block.is-bust .stone-core {
  background: radial-gradient(circle at 50% 60%, rgba(185, 185, 185, 0.6), transparent 70%);
}

.stone-block.is-small .stone-core {
  background: radial-gradient(circle, rgba(140, 240, 225, 0.95), rgba(119, 220, 205, 0.25) 60%, transparent 75%);
}

.stone-block.is-big .stone-core {
  background: radial-gradient(circle, rgba(170, 245, 230, 1), rgba(119, 220, 205, 0.35) 60%, transparent 78%);
}

.stone-block.is-jackpot .stone-core {
  background: radial-gradient(circle, rgba(255, 232, 160, 1), rgba(202, 169, 106, 0.35) 60%, transparent 80%);
}

/* 刀光：切开时一道亮线横扫石块。 */
.stone-blade {
  position: absolute;
  top: 50%;
  left: -15%;
  width: 130%;
  height: 2px;
  margin-top: -1px;
  background: linear-gradient(90deg, transparent, rgba(240, 252, 255, 0.95), transparent);
  opacity: 0;
  transform: rotate(-16deg) scaleX(0);
  pointer-events: none;
}

.stone-block.is-cutting .stone-blade {
  animation: stone-blade-slash 0.45s ease-out 0.25s both;
}

.stone-block.is-cutting {
  animation: stone-shake 0.22s ease-in-out 4;
}

.stone-block.is-waiting {
  animation: stone-tremble 0.5s ease-in-out infinite;
}

.stone-block.is-open.is-bust .stone-core {
  animation: stone-smoke 1.4s ease-out both;
}

.stone-block.is-open.is-small .stone-core,
.stone-block.is-open.is-big .stone-core {
  animation: stone-glow 0.9s ease-out both;
}

.stone-block.is-open.is-jackpot .stone-core {
  animation: stone-burst 0.9s ease-out both;
}

/* 整个舞台的光效（只在结果摆出时出现一次）。 */
.stone-effect {
  position: absolute;
  inset: 0;
  pointer-events: none;
  animation-fill-mode: both;
}

.stone-effect.is-smoke {
  background: radial-gradient(circle at 50% 60%, rgba(170, 170, 170, 0.35), transparent 65%);
  animation: stone-fade 1.6s ease-out both;
}

.stone-effect.is-glow {
  background: radial-gradient(circle at 50% 50%, rgba(119, 230, 215, 0.35), transparent 70%);
  animation: stone-fade 1.6s ease-out both;
}

.stone-effect.is-gold {
  background: radial-gradient(circle at 50% 50%, rgba(255, 214, 120, 0.55), rgba(202, 169, 106, 0.12) 60%, transparent 80%);
  animation: stone-gold 1.8s ease-out both;
}

/* ---------- 结果汇总 ---------- */

.stone-summary {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid rgba(202, 169, 106, 0.2);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.014);
}

.stone-summary-title {
  color: var(--gold, #caa96a);
  font-size: 14px;
  font-weight: 500;
}

.stone-summary-message {
  margin: 0;
  color: #dce6e0;
  font-size: 13px;
  line-height: 1.6;
}

.stone-summary-counts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin: 0;
  padding: 0;
  list-style: none;
  color: #a9bcb2;
  font-size: 12px;
}

.stone-summary-counts .is-jackpot {
  color: var(--gold, #caa96a);
}

.stone-summary-counts .is-big,
.stone-summary-counts .is-small {
  color: #77dcd0;
}

.stone-summary-counts .is-bust {
  color: #93a99e;
}

.stone-summary-cost {
  margin: 0;
  color: #7d9186;
  font-size: 12px;
}

/* ---------- 按钮 ---------- */

.stone-cut-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.stone-cut {
  width: 100%;
}

/* ---------- 说明弹窗 ---------- */

.stone-rules-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.stone-rules-text {
  margin: 0;
  color: #c8d6ce;
  font-size: 13px;
  line-height: 1.7;
}

.stone-odds-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.stone-odds-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid rgba(202, 169, 106, 0.12);
  border-radius: 4px;
  font-size: 12px;
}

.stone-odds-head,
.stone-odds-line {
  margin: 0;
}

.stone-odds-head small,
.stone-odds-line {
  color: #93a99e;
}

.stone-odds-line span {
  display: inline-block;
  margin-right: 12px;
}

/* 系统要求减少动效：去掉晃动、切开与光效的动画，只保留最终摆出的状态。 */
@media (prefers-reduced-motion: reduce) {
  .stone-block,
  .stone-block::before,
  .stone-block::after,
  .stone-core,
  .stone-blade {
    animation: none !important;
    transition: none !important;
  }

  .stone-effect {
    display: none;
  }
}

@keyframes stone-shake {
  0%,
  100% {
    transform: translateX(0) rotate(0deg);
  }
  25% {
    transform: translateX(-3px) rotate(-1.5deg);
  }
  75% {
    transform: translateX(3px) rotate(1.5deg);
  }
}

@keyframes stone-tremble {
  0%,
  100% {
    transform: translateX(0);
  }
  50% {
    transform: translateX(1.5px);
  }
}

@keyframes stone-blade-slash {
  0% {
    opacity: 0;
    transform: rotate(-16deg) scaleX(0);
  }
  40% {
    opacity: 1;
  }
  100% {
    opacity: 0.4;
    transform: rotate(-16deg) scaleX(1);
  }
}

@keyframes stone-smoke {
  0% {
    opacity: 0.2;
    transform: translateY(6px) scale(0.8);
  }
  100% {
    opacity: 1;
    transform: translateY(-6px) scale(1.2);
  }
}

@keyframes stone-glow {
  0% {
    opacity: 0.2;
  }
  100% {
    opacity: 1;
  }
}

@keyframes stone-burst {
  0% {
    opacity: 0;
    transform: scale(0.6);
  }
  60% {
    opacity: 1;
    transform: scale(1.15);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes stone-fade {
  0% {
    opacity: 0;
  }
  30% {
    opacity: 1;
  }
  100% {
    opacity: 0.5;
  }
}

@keyframes stone-gold {
  0% {
    opacity: 0;
  }
  20% {
    opacity: 1;
  }
  100% {
    opacity: 0.55;
  }
}
</style>
