<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import type { AuctionActionResponse, AuctionLotView, AuctionView, SectStateView } from '../api/game';
import {
  bidAuction,
  buyoutAuction,
  cancelAuction,
  claimAuction,
  fetchAuction,
  listAuctionItem,
  retractAuctionBid,
} from '../api/game';
import { formatAmount } from '../utils/format';

/**
 * 0040 拍卖行面板（docs/拍卖行开发计划.md）。
 *
 * 只在「打开时 / 操作后 / 点刷新」请求接口，不轮询；剩余时间由前端每 30 秒自己回算。
 * 最低价、下一口最低出价、可上架库存都由服务端算好，这里只渲染与收集输入。
 * 价格输入是灵石个数（展示单位）；服务端下发的价格是最小单位，显示时用 formatAmount。
 */
const props = defineProps<{
  state: SectStateView;
  busy?: boolean;
}>();

const emit = defineEmits<{
  'state-update': [state: SectStateView];
  notify: [tone: 'success' | 'warning', title: string, message: string];
  /** 装备进出背包后通知上层刷新背包。 */
  'equipment-changed': [];
}>();

type Tab = 'hall' | 'sell' | 'mine';
type KindFilter = 'all' | 'equipment' | 'pill' | 'resource';

const panel = ref<AuctionView | null>(null);
const loading = ref(false);
const submitting = ref(false);
const tab = ref<Tab>('hall');
const kindFilter = ref<KindFilter>('all');
const sortKey = ref<'ending' | 'price'>('ending');
const showRules = ref(false);

/* ---------- 剩余时间：每 30 秒回算一次 ---------- */

const nowMs = ref(Date.now());
let clock: number | undefined;

function timeLeft(endsAt: number): string {
  const seconds = Math.max(0, Math.floor((endsAt - nowMs.value) / 1000));
  if (seconds <= 0) return '已到期';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${String(hours)} 时 ${String(minutes)} 分` : `${String(Math.max(1, minutes))} 分`;
}

/* ---------- 展示 ---------- */

/** 品质色（与服务端 EQUIPMENT_QUALITIES 同一套）。 */
const QUALITY_COLORS: Record<string, string> = {
  common: '#b9c0c9',
  spirit: '#4ade80',
  treasure: '#60a5fa',
  immortal: '#fbbf24',
};

function lotColor(lot: Pick<AuctionLotView, 'equipment'>): string {
  return lot.equipment === null ? '#e0cd97' : (QUALITY_COLORS[lot.equipment.quality] ?? '#cbd8d0');
}

function lotTitle(lot: AuctionLotView): string {
  return lot.kind === 'equipment' || lot.quantity <= 1 ? lot.itemName : `${lot.itemName} ×${String(lot.quantity)}`;
}

function equipmentLine(lot: Pick<AuctionLotView, 'equipment'>): string {
  const e = lot.equipment;
  if (e === null) return '';
  return `${e.qualityName}${e.slotName} · ${e.mainAttrName} +${String(e.mainValue)} · ${e.subAttrName} +${String(e.subValue)}`;
}

function stone(minUnits: number | null): string {
  return minUnits === null ? '—' : formatAmount(minUnits);
}

const STATUS_LABELS: Record<AuctionLotView['status'], string> = {
  active: '竞价中',
  sold: '已成交',
  expired: '流拍',
  cancelled: '已下架',
};

/** 我视角下的一单状态标签。 */
function myStatus(lot: AuctionLotView): string {
  if (lot.claimable === 'buyer') return '拍得 · 待领取';
  if (lot.claimable === 'seller') return '流拍 · 待领回';
  if (lot.status === 'active' && lot.endsAt <= nowMs.value) return '已到期 · 结算中';
  if (lot.status === 'active') {
    if (lot.isMine) return lot.currentPrice === null ? '竞价中 · 暂无出价' : `竞价中 · ${lot.leaderName ?? ''} 领先`;
    return lot.isLeading ? '我领先' : '已被超价';
  }
  if (lot.status === 'sold') {
    if (lot.isMine) return `已成交 · 实得 ${stone((lot.currentPrice ?? 0) - lot.fee)}`;
    return lot.isLeading ? '已拍得' : '未拍得';
  }
  return STATUS_LABELS[lot.status];
}

const feePercent = computed(() => (panel.value?.feeBp ?? 1000) / 100);

/* ---------- 大厅 ---------- */

const hallLots = computed(() => {
  const lots = (panel.value?.hall ?? []).filter(
    (lot) => kindFilter.value === 'all' || lot.kind === kindFilter.value,
  );
  if (sortKey.value === 'price') {
    return [...lots].sort((a, b) => (a.currentPrice ?? a.startPrice) - (b.currentPrice ?? b.startPrice));
  }
  return lots;
});

/** 每单的出价输入（灵石个数）；没填时按下一口最低出价。 */
const bidInputs = ref<Record<string, number | undefined>>({});

function bidValue(lot: AuctionLotView): number {
  const typed = bidInputs.value[lot.id];
  return typed !== undefined && Number.isFinite(typed) ? Math.floor(typed) : Math.ceil((lot.minNextBid ?? 0) / 1000);
}

/* ---------- 上架 ---------- */

const sellKind = ref<'equipment' | 'pill' | 'resource'>('equipment');
const sellItemId = ref<string>('');
const sellQuantity = ref<number>(1);
const sellStart = ref<number | undefined>(undefined);
const sellBuyout = ref<number | undefined>(undefined);

const sellOptions = computed(() => {
  const listable = panel.value?.listable;
  if (listable === undefined) return [];
  if (sellKind.value === 'equipment') {
    return listable.equipment.map((item) => ({
      id: item.id,
      label: item.name,
      detail: `${item.qualityName}${item.slotName} · ${item.mainAttrName} +${String(item.mainValue)} · ${item.subAttrName} +${String(item.subValue)}`,
      color: QUALITY_COLORS[item.quality] ?? '#cbd8d0',
      max: 1,
      unitMin: item.minPrice,
    }));
  }
  if (sellKind.value === 'pill') {
    return listable.pills.map((item) => ({
      id: item.pillId,
      label: item.name,
      detail: `库存 ${String(item.quantity)} 颗`,
      color: '#e0cd97',
      max: Math.min(item.quantity, panel.value?.pillMaxQuantity ?? 99),
      unitMin: item.unitMinPrice,
    }));
  }
  return listable.resources.map((item) => ({
    id: item.resourceId,
    label: item.name,
    detail: `库存 ${String(item.quantity)} 个`,
    color: '#e0cd97',
    max: Math.min(item.quantity, panel.value?.resourceMaxQuantity ?? 999),
    unitMin: item.unitMinPrice,
  }));
});

const sellChosen = computed(() => sellOptions.value.find((item) => item.id === sellItemId.value) ?? null);

/** 最低起拍价（灵石个数）= 单价下限 × 数量。 */
const sellMinStart = computed(() => {
  const chosen = sellChosen.value;
  if (chosen === null) return 0;
  return Math.ceil((chosen.unitMin * Math.max(1, sellQuantity.value)) / 1000);
});

const sellStartValue = computed(() => sellStart.value ?? sellMinStart.value);

/** 按起拍价成交时卖家到手（灵石个数，向下取整）。 */
const sellProceeds = computed(() =>
  Math.floor(sellStartValue.value * (1 - (panel.value?.feeBp ?? 1000) / 10_000)),
);

const sellError = computed<string | null>(() => {
  const current = panel.value;
  if (current === null) return null;
  if (current.myActiveCount >= current.maxActiveListings) {
    return `最多同时上架 ${String(current.maxActiveListings)} 单`;
  }
  const chosen = sellChosen.value;
  if (chosen === null) return '先选一件要上架的物品';
  if (!Number.isInteger(sellQuantity.value) || sellQuantity.value < 1 || sellQuantity.value > chosen.max) {
    return `数量 1～${String(chosen.max)}`;
  }
  if (!Number.isInteger(sellStartValue.value) || sellStartValue.value < sellMinStart.value) {
    return `起拍价不能低于 ${String(sellMinStart.value)} 灵石`;
  }
  if (sellStartValue.value > current.maxPrice) return '价格太高了';
  const buyout = sellBuyout.value;
  if (buyout !== undefined && (!Number.isInteger(buyout) || buyout < sellStartValue.value)) {
    return '一口价不能低于起拍价';
  }
  return null;
});

watch(sellKind, () => {
  sellItemId.value = '';
  sellQuantity.value = 1;
  sellStart.value = undefined;
  sellBuyout.value = undefined;
});

function pickSellItem(id: string): void {
  sellItemId.value = id;
  sellQuantity.value = 1;
  sellStart.value = undefined;
}

/* ---------- 我的 ---------- */

const claimLots = computed(() => {
  const seen = new Set<string>();
  return [...(panel.value?.myBids ?? []), ...(panel.value?.myLots ?? [])].filter((lot) => {
    if (lot.claimable === null || seen.has(lot.id)) return false;
    seen.add(lot.id);
    return true;
  });
});

/* ---------- 请求 ---------- */

const disabled = computed(() => submitting.value || props.busy === true);

async function refresh(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const data = await fetchAuction();
    emit('state-update', data.state);
    panel.value = data.auction;
    nowMs.value = Date.now();
  } catch (error) {
    emit('notify', 'warning', '拍卖行', error instanceof Error ? error.message : '面板加载失败');
  } finally {
    loading.value = false;
  }
}

/** 命令统一出口：回执里的 state / 面板落地 + toast；装备进出背包时通知上层。 */
async function run(action: () => Promise<AuctionActionResponse>, touchesEquipment = false): Promise<boolean> {
  if (disabled.value) return false;
  submitting.value = true;
  try {
    const data = await action();
    emit('state-update', data.state);
    panel.value = data.auction;
    nowMs.value = Date.now();
    emit('notify', 'success', '拍卖行', data.result.message);
    if (touchesEquipment) emit('equipment-changed');
    return true;
  } catch (error) {
    emit('notify', 'warning', '拍卖行', error instanceof Error ? error.message : '操作失败，请稍后再试');
    void refresh();
    return false;
  } finally {
    submitting.value = false;
  }
}

async function onBid(lot: AuctionLotView): Promise<void> {
  const ok = await run(() => bidAuction(lot.id, bidValue(lot)));
  if (ok) delete bidInputs.value[lot.id];
}

function onBuyout(lot: AuctionLotView): void {
  if (lot.buyoutPrice === null) return;
  if (!window.confirm(`确定用一口价 ${stone(lot.buyoutPrice)} 灵石买下「${lotTitle(lot)}」？`)) return;
  void run(() => buyoutAuction(lot.id), lot.kind === 'equipment');
}

function onCancel(lot: AuctionLotView): void {
  if (lot.currentPrice !== null) return;
  if (!window.confirm(`下架「${lotTitle(lot)}」？物品会退回。`)) return;
  void run(() => cancelAuction(lot.id), lot.kind === 'equipment');
}

function onRetract(lot: AuctionLotView): void {
  if (!lot.retractable) return;
  const penalty = lot.retractPenalty ?? 0;
  const refund = (lot.currentPrice ?? 0) - penalty;
  const ok = window.confirm(
    `撤销对「${lotTitle(lot)}」的出价？\n退回 ${stone(refund)} 灵石，违约金 ${stone(penalty)} 灵石赔给卖家；这一单回到无人出价。`,
  );
  if (!ok) return;
  void run(() => retractAuctionBid(lot.id));
}

function onClaim(lot: AuctionLotView): void {
  void run(() => claimAuction(lot.id), lot.kind === 'equipment');
}

async function onList(): Promise<void> {
  const chosen = sellChosen.value;
  if (chosen === null || sellError.value !== null) return;
  const kind = sellKind.value;
  const ok = await run(
    () =>
      listAuctionItem({
        kind,
        ...(kind === 'equipment' ? { equipmentId: chosen.id } : {}),
        ...(kind === 'pill' ? { pillId: chosen.id, quantity: sellQuantity.value } : {}),
        ...(kind === 'resource' ? { resourceId: chosen.id, quantity: sellQuantity.value } : {}),
        startPrice: sellStartValue.value,
        ...(sellBuyout.value === undefined ? {} : { buyoutPrice: sellBuyout.value }),
      }),
    kind === 'equipment',
  );
  if (ok) {
    sellItemId.value = '';
    sellQuantity.value = 1;
    sellStart.value = undefined;
    sellBuyout.value = undefined;
  }
}

/** 数字输入框：空串当作「没填」。 */
function numberOrUndefined(event: Event): number | undefined {
  const raw = (event.target as HTMLInputElement).value.trim();
  if (raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

const RULES_TEXT = `拍卖行 · 规则

开放：宗门 3 级。可拍卖背包里的装备（穿在身上的要先卸下）、丹药、玄铁、神木。
上架：物品立刻交给拍卖行保管，竞价 24 小时；可另设一口价。每个宗门最多同时上架 10 单。
      起拍价不能低于物品成本的 20%（装备按炼器成本、丹药按炼丹成本，玄铁 / 神木每个 10 灵石）。
      还没人出价时可以下架（大厅和「我的拍卖」里都能点），物品当场退回；有人出价后不能下架。
出价：出价的灵石立刻冻结；被别人超价时原数退回。下一口至少比当前价高 5%。
      领先时可以撤销出价：扣 5% 违约金赔给卖家，其余退回，这一单回到无人出价；拍卖结束前 2 小时内不能撤销。
      同一网络下（同一宽带 / 同一 Wi-Fi）的宗门之间不能互相出价、一口价。
      出价达到一口价时请直接一口价买下。
一口价：当场成交，物品直接到手（装备需要背包有空位）。
到期：价高者得，物品放进「我的拍卖 → 待领取」；没人出价则流拍，卖家在待领取里领回。
手续费：成交扣 10%，卖家实得 = 成交价 − 10%（灵石成交时直接到账）。`;

onMounted(() => {
  void refresh();
  clock = window.setInterval(() => {
    nowMs.value = Date.now();
  }, 30_000);
});

onUnmounted(() => {
  if (clock !== undefined) window.clearInterval(clock);
});
</script>

<template>
  <section class="auction-panel" aria-labelledby="auction-title">
    <div class="auction-head">
      <h3 id="auction-title" class="auction-title">拍卖行</h3>
      <div class="auction-head-actions">
        <button class="auction-quiet-button" type="button" @click="showRules = !showRules">
          {{ showRules ? '收起说明' : '说明' }}
        </button>
        <button class="auction-quiet-button" type="button" :disabled="loading" @click="refresh">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </div>

    <p v-if="showRules" class="auction-rules">{{ RULES_TEXT }}</p>

    <p v-else-if="panel === null" class="auction-empty">{{ loading ? '拍卖行加载中…' : '面板加载失败，请点刷新。' }}</p>

    <p v-else-if="!panel.unlocked" class="auction-locked">宗门 {{ panel.unlockSectLevel }} 级开放拍卖行。</p>

    <template v-else>
      <div class="auction-tabs" role="tablist">
        <button
          v-for="item in [
            { id: 'hall', label: '拍卖大厅' },
            { id: 'sell', label: '我要上架' },
            { id: 'mine', label: '我的拍卖' },
          ] as const"
          :key="item.id"
          class="auction-tab"
          :class="{ 'is-active': tab === item.id }"
          type="button"
          role="tab"
          :aria-selected="tab === item.id"
          @click="tab = item.id"
        >
          {{ item.label }}
          <span v-if="item.id === 'mine' && panel.claimableCount > 0" class="chip-badge">{{ panel.claimableCount }}</span>
        </button>
      </div>

      <!-- 大厅 -->
      <template v-if="tab === 'hall'">
        <div class="auction-filters">
          <button
            v-for="item in [
              { id: 'all', label: '全部' },
              { id: 'equipment', label: '装备' },
              { id: 'pill', label: '丹药' },
              { id: 'resource', label: '材料' },
            ] as const"
            :key="item.id"
            class="auction-filter"
            :class="{ 'is-active': kindFilter === item.id }"
            type="button"
            @click="kindFilter = item.id"
          >
            {{ item.label }}
          </button>
          <select v-model="sortKey" class="auction-sort" aria-label="排序">
            <option value="ending">即将结束</option>
            <option value="price">价格从低到高</option>
          </select>
        </div>

        <p v-if="hallLots.length === 0" class="auction-empty">暂时没有在拍的物品。</p>
        <ul v-else class="auction-list">
          <li v-for="lot in hallLots" :key="lot.id" class="auction-lot" :style="{ '--lot-color': lotColor(lot) }">
            <div class="auction-lot-main">
              <p class="auction-lot-name">
                <strong>{{ lotTitle(lot) }}</strong>
                <span v-if="lot.isMine" class="auction-tag">我上架的</span>
                <span v-else-if="lot.isLeading" class="auction-tag is-good">我领先</span>
              </p>
              <p v-if="lot.equipment" class="auction-lot-sub">{{ equipmentLine(lot) }}</p>
              <p class="auction-lot-sub">
                卖家 {{ lot.sellerName }} · 剩 {{ timeLeft(lot.endsAt) }} · {{ lot.bidCount }} 次出价
              </p>
            </div>
            <div class="auction-lot-price">
              <p>
                <span class="auction-label">{{ lot.currentPrice === null ? '起拍' : '当前' }}</span>
                <strong>{{ stone(lot.currentPrice ?? lot.startPrice) }}</strong>
              </p>
              <p v-if="lot.buyoutPrice !== null">
                <span class="auction-label">一口价</span>{{ stone(lot.buyoutPrice) }}
              </p>
            </div>
            <div v-if="lot.isMine" class="auction-lot-actions">
              <button
                class="auction-action"
                type="button"
                :disabled="disabled || lot.currentPrice !== null"
                :title="lot.currentPrice !== null ? '已有人出价，不能下架' : '下架并退回物品'"
                @click="onCancel(lot)"
              >
                下架
              </button>
            </div>
            <div v-else class="auction-lot-actions">
              <button
                v-if="lot.isLeading"
                class="auction-action"
                type="button"
                :disabled="disabled || !lot.retractable"
                :title="lot.retractable ? `扣 ${stone(lot.retractPenalty)} 灵石违约金给卖家` : '拍卖结束前 2 小时内不能撤销'"
                @click="onRetract(lot)"
              >
                撤销出价
              </button>
              <template v-if="lot.minNextBid !== null && !lot.isLeading">
                <input
                  class="auction-input"
                  type="number"
                  inputmode="numeric"
                  :min="Math.ceil(lot.minNextBid / 1000)"
                  :value="bidValue(lot)"
                  :aria-label="`给${lotTitle(lot)}出价（灵石）`"
                  @input="bidInputs[lot.id] = numberOrUndefined($event)"
                />
                <button class="auction-action" type="button" :disabled="disabled" @click="onBid(lot)">出价</button>
              </template>
              <button
                v-if="lot.buyoutPrice !== null"
                class="auction-action is-primary"
                type="button"
                :disabled="disabled"
                @click="onBuyout(lot)"
              >
                一口价
              </button>
            </div>
          </li>
        </ul>
      </template>

      <!-- 上架 -->
      <template v-else-if="tab === 'sell'">
        <p class="auction-hint">
          在拍 {{ panel.myActiveCount }} / {{ panel.maxActiveListings }} 单 · 竞价 {{ panel.durationHours }} 小时 ·
          成交扣 {{ feePercent }}% 手续费
        </p>
        <div class="auction-filters">
          <button
            v-for="item in [
              { id: 'equipment', label: '装备' },
              { id: 'pill', label: '丹药' },
              { id: 'resource', label: '玄铁 / 神木' },
            ] as const"
            :key="item.id"
            class="auction-filter"
            :class="{ 'is-active': sellKind === item.id }"
            type="button"
            @click="sellKind = item.id"
          >
            {{ item.label }}
          </button>
        </div>

        <p v-if="sellOptions.length === 0" class="auction-empty">
          {{ sellKind === 'equipment' ? '背包里没有可上架的装备（穿在身上的要先卸下）。' : '没有可上架的库存。' }}
        </p>
        <ul v-else class="auction-pick-list">
          <li v-for="item in sellOptions" :key="item.id">
            <button
              class="auction-pick"
              :class="{ 'is-active': sellItemId === item.id }"
              :style="{ '--lot-color': item.color }"
              type="button"
              @click="pickSellItem(item.id)"
            >
              <strong>{{ item.label }}</strong>
              <span>{{ item.detail }}</span>
            </button>
          </li>
        </ul>

        <div v-if="sellChosen" class="auction-form">
          <label v-if="sellKind !== 'equipment'" class="auction-field">
            <span>数量（最多 {{ sellChosen.max }}）</span>
            <input v-model.number="sellQuantity" class="auction-input" type="number" min="1" :max="sellChosen.max" />
          </label>
          <label class="auction-field">
            <span>起拍价（灵石，至少 {{ sellMinStart }}）</span>
            <input
              class="auction-input"
              type="number"
              :min="sellMinStart"
              :value="sellStartValue"
              @input="sellStart = numberOrUndefined($event)"
            />
          </label>
          <label class="auction-field">
            <span>一口价（可不填）</span>
            <input
              class="auction-input"
              type="number"
              :min="sellStartValue"
              :value="sellBuyout ?? ''"
              placeholder="不设"
              @input="sellBuyout = numberOrUndefined($event)"
            />
          </label>
          <p class="auction-hint">按起拍价成交，到手约 {{ sellProceeds }} 灵石（已扣 {{ feePercent }}% 手续费）。</p>
          <p v-if="sellError" class="auction-error">{{ sellError }}</p>
          <button class="auction-main-button" type="button" :disabled="disabled || sellError !== null" @click="onList">
            上架「{{ sellChosen.label }}」
          </button>
        </div>
      </template>

      <!-- 我的 -->
      <template v-else>
        <section class="auction-section">
          <h4 class="auction-section-title">待领取</h4>
          <p v-if="claimLots.length === 0" class="auction-empty">没有待领取的物品。</p>
          <ul v-else class="auction-list">
            <li v-for="lot in claimLots" :key="lot.id" class="auction-lot" :style="{ '--lot-color': lotColor(lot) }">
              <div class="auction-lot-main">
                <p class="auction-lot-name"><strong>{{ lotTitle(lot) }}</strong></p>
                <p class="auction-lot-sub">
                  {{ lot.claimable === 'buyer' ? `以 ${stone(lot.currentPrice)} 灵石拍得` : '流拍，物品退回' }}
                </p>
              </div>
              <div class="auction-lot-actions">
                <button class="auction-action is-primary" type="button" :disabled="disabled" @click="onClaim(lot)">
                  领取
                </button>
              </div>
            </li>
          </ul>
          <p v-if="claimLots.some((lot) => lot.kind === 'equipment')" class="auction-hint">
            领取装备需要背包有空位（当前 {{ panel.bagCount }} / {{ panel.bagCapacity }}）。
          </p>
        </section>

        <section class="auction-section">
          <h4 class="auction-section-title">我上架的</h4>
          <p v-if="panel.myLots.length === 0" class="auction-empty">还没有上架过。</p>
          <ul v-else class="auction-list">
            <li v-for="lot in panel.myLots" :key="lot.id" class="auction-lot" :style="{ '--lot-color': lotColor(lot) }">
              <div class="auction-lot-main">
                <p class="auction-lot-name"><strong>{{ lotTitle(lot) }}</strong></p>
                <p class="auction-lot-sub">
                  {{ myStatus(lot) }}<template v-if="lot.status === 'active'"> · 剩 {{ timeLeft(lot.endsAt) }}</template>
                </p>
              </div>
              <div class="auction-lot-price">
                <p>
                  <span class="auction-label">{{ lot.currentPrice === null ? '起拍' : '当前' }}</span>
                  <strong>{{ stone(lot.currentPrice ?? lot.startPrice) }}</strong>
                </p>
              </div>
              <div v-if="lot.status === 'active'" class="auction-lot-actions">
                <button
                  class="auction-action"
                  type="button"
                  :disabled="disabled || lot.currentPrice !== null"
                  :title="lot.currentPrice !== null ? '已有人出价，不能下架' : '下架并退回物品'"
                  @click="onCancel(lot)"
                >
                  下架
                </button>
              </div>
            </li>
          </ul>
        </section>

        <section class="auction-section">
          <h4 class="auction-section-title">我出价的</h4>
          <p v-if="panel.myBids.length === 0" class="auction-empty">还没有出过价。</p>
          <ul v-else class="auction-list">
            <li v-for="lot in panel.myBids" :key="lot.id" class="auction-lot" :style="{ '--lot-color': lotColor(lot) }">
              <div class="auction-lot-main">
                <p class="auction-lot-name"><strong>{{ lotTitle(lot) }}</strong></p>
                <p class="auction-lot-sub">
                  {{ myStatus(lot) }}<template v-if="lot.status === 'active'"> · 剩 {{ timeLeft(lot.endsAt) }}</template>
                </p>
              </div>
              <div class="auction-lot-price">
                <p><span class="auction-label">当前</span><strong>{{ stone(lot.currentPrice) }}</strong></p>
              </div>
              <div v-if="lot.status === 'active' && lot.isLeading" class="auction-lot-actions">
                <button
                  class="auction-action"
                  type="button"
                  :disabled="disabled || !lot.retractable"
                  :title="lot.retractable ? `扣 ${stone(lot.retractPenalty)} 灵石违约金给卖家` : '拍卖结束前 2 小时内不能撤销'"
                  @click="onRetract(lot)"
                >
                  撤销出价
                </button>
              </div>
            </li>
          </ul>
        </section>
      </template>
    </template>
  </section>
</template>

<style scoped>
.auction-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.auction-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.auction-title {
  margin: 0;
  color: var(--gold-bright, #ead19a);
  font-size: 16px;
  font-weight: 600;
}

.auction-head-actions {
  display: flex;
  gap: 8px;
}

.auction-quiet-button {
  padding: 2px 10px;
  border: 1px solid rgba(202, 169, 106, 0.4);
  border-radius: 2px;
  background: rgba(202, 169, 106, 0.08);
  color: var(--gold, #caa96a);
  font-size: 12px;
  cursor: pointer;
}

.auction-quiet-button:disabled {
  color: #63756c;
  cursor: not-allowed;
}

.auction-rules {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-radius: 3px;
  color: #c8d6ce;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
}

.auction-empty,
.auction-hint {
  margin: 0;
  color: #7d9186;
  font-size: 12px;
  line-height: 1.6;
}

.auction-locked {
  margin: 0;
  padding: 6px 10px;
  border: 1px solid rgba(217, 138, 74, 0.4);
  border-radius: 3px;
  background: rgba(217, 138, 74, 0.08);
  color: #d9b06a;
  font-size: 12px;
}

.auction-error {
  margin: 0;
  color: #e8806c;
  font-size: 12px;
}

.auction-tabs {
  display: flex;
  gap: 6px;
  border-bottom: 1px solid var(--line, rgba(202, 169, 106, 0.2));
}

.auction-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: -1px;
  padding: 6px 12px;
  border: 1px solid transparent;
  border-radius: 3px 3px 0 0;
  background: transparent;
  color: #8fa79b;
  font-size: 13px;
  cursor: pointer;
}

.auction-tab.is-active {
  border-color: var(--line, rgba(202, 169, 106, 0.2));
  border-bottom-color: var(--bg, #0a1916);
  background: rgba(202, 169, 106, 0.06);
  color: var(--gold-bright, #ead19a);
}

.auction-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.auction-filter {
  padding: 3px 10px;
  border: 1px solid rgba(202, 169, 106, 0.2);
  border-radius: 20px;
  background: transparent;
  color: #9fb2a8;
  font-size: 12px;
  cursor: pointer;
}

.auction-filter.is-active {
  border-color: rgba(202, 169, 106, 0.6);
  background: rgba(202, 169, 106, 0.12);
  color: var(--gold-bright, #ead19a);
}

.auction-sort {
  margin-left: auto;
  padding: 3px 6px;
  border: 1px solid rgba(202, 169, 106, 0.25);
  border-radius: 3px;
  background: rgba(13, 32, 27, 0.9);
  color: #cbd8d0;
  font-size: 12px;
}

.auction-list,
.auction-pick-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.auction-lot {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-left: 3px solid var(--lot-color, #e0cd97);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.014);
}

.auction-lot-main {
  min-width: 0;
}

.auction-lot-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 13px;
}

.auction-lot-name strong {
  color: var(--lot-color, #e0cd97);
}

.auction-lot-sub {
  margin: 2px 0 0;
  overflow: hidden;
  color: #8fa79b;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.auction-tag {
  padding: 0 6px;
  border-radius: 20px;
  background: rgba(202, 169, 106, 0.14);
  color: var(--gold, #caa96a);
  font-size: 11px;
}

.auction-tag.is-good {
  background: rgba(119, 184, 154, 0.16);
  color: var(--jade-bright, #77b89a);
}

.auction-lot-price {
  text-align: right;
  font-size: 12px;
  white-space: nowrap;
}

.auction-lot-price p {
  margin: 0;
  color: #cbd8d0;
}

.auction-lot-price strong {
  color: #e8b96a;
}

.auction-label {
  margin-right: 4px;
  color: #7d9186;
}

.auction-lot-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.auction-input {
  width: 92px;
  padding: 4px 6px;
  border: 1px solid rgba(202, 169, 106, 0.3);
  border-radius: 3px;
  background: rgba(6, 18, 15, 0.8);
  color: #e6efe9;
  font-size: 12px;
}

.auction-action {
  padding: 4px 10px;
  border: 1px solid rgba(202, 169, 106, 0.4);
  border-radius: 3px;
  background: rgba(202, 169, 106, 0.08);
  color: var(--gold, #caa96a);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}

.auction-action.is-primary {
  border-color: rgba(234, 209, 154, 0.6);
  background: rgba(202, 169, 106, 0.18);
  color: var(--gold-bright, #ead19a);
}

.auction-action:disabled {
  color: #63756c;
  cursor: not-allowed;
}

.auction-pick {
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: 2px;
  padding: 6px 10px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-left: 3px solid var(--lot-color, #e0cd97);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.014);
  color: #8fa79b;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.auction-pick strong {
  color: var(--lot-color, #e0cd97);
  font-size: 13px;
}

.auction-pick.is-active {
  border-color: rgba(119, 184, 154, 0.55);
  background: rgba(119, 184, 154, 0.08);
}

.auction-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-radius: 3px;
}

.auction-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: #9fb2a8;
  font-size: 12px;
}

.auction-field .auction-input {
  width: 140px;
}

.auction-main-button {
  min-height: 38px;
  border: 1px solid rgba(202, 169, 106, 0.55);
  border-radius: 3px;
  background: rgba(202, 169, 106, 0.12);
  color: var(--gold-bright, #ead19a);
  font-size: 13px;
  cursor: pointer;
}

.auction-main-button:disabled {
  border-color: rgba(167, 184, 173, 0.11);
  background: rgba(255, 255, 255, 0.016);
  color: #63756c;
  cursor: not-allowed;
}

.auction-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.auction-section-title {
  margin: 0;
  color: #8fa79b;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
}

/* 窄屏：价格挪到名字下面，操作按钮另起一行。 */
@media (max-width: 520px) {
  .auction-lot {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .auction-lot-actions {
    grid-column: 1 / -1;
    justify-content: flex-end;
  }

  .auction-field {
    flex-direction: column;
    align-items: stretch;
  }

  .auction-field .auction-input {
    width: 100%;
  }
}
</style>
