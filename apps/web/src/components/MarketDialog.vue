<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import type {
  MarketChartRange,
  MarketChartView,
  MarketOrderKind,
  MarketOrderView,
  MarketView,
  SectStateView,
  StockView,
} from '../api/game';
import { cancelStockOrder, fetchMarket, fetchMarketChart, placeStockOrder, tradeStock } from '../api/game';
import { formatAmount } from '../utils/format';
import ModalShell from './ModalShell.vue';

/**
 * 0043 灵股行情面板（docs/灵股行情开发计划.md）。
 *
 * 系统坐庄：价格、K 线、消息、持仓全部由服务端算好；这里只渲染与下单。
 * 0049 挂单（docs/灵股挂单开发计划.md）：下单区下面设触发价，挂单列表在「挂单」标签里可撤单；
 * 挂单的成交 / 过期由服务端结算，这里只显示结果。
 * 面板打开期间按服务端给的下一跳时刻自动刷新（每分钟一次），关掉就停。
 * 颜色按 A 股习惯：红涨绿跌。
 */
const props = defineProps<{
  state: SectStateView;
  busy?: boolean;
}>();

const emit = defineEmits<{
  'state-update': [state: SectStateView];
  notify: [tone: 'success' | 'warning', title: string, message: string];
}>();

const market = ref<MarketView | null>(null);
const chart = ref<MarketChartView | null>(null);
const loading = ref(false);
const submitting = ref(false);
const showRules = ref(false);
const selectedId = ref<string>('');
const range = ref<MarketChartRange>('1h');
const shares = ref<number>(10);
type MarketTab = 'news' | 'trades' | 'orders' | 'ranks';
const tab = ref<MarketTab>('news');
/** 挂单表单：类型、触发价（展示单位，输入框里的字符串）、股数。 */
const orderKind = ref<MarketOrderKind>('limit_buy');
const orderTrigger = ref<string>('');
const orderShares = ref<string>('10');

const RANGES: readonly { id: MarketChartRange; label: string }[] = [
  { id: '1h', label: '分时 1 小时' },
  { id: '6h', label: '6 小时' },
  { id: '1d', label: '1 天' },
  { id: '7d', label: '7 天' },
];

const ORDER_KINDS: readonly { id: MarketOrderKind; label: string }[] = [
  { id: 'limit_buy', label: '限价买' },
  { id: 'limit_sell', label: '限价卖' },
  { id: 'stop_sell', label: '止损卖' },
];

const tabs = computed<readonly { id: MarketTab; label: string }[]>(() => [
  { id: 'news', label: '坊间消息' },
  { id: 'trades', label: '我的成交' },
  { id: 'orders', label: `挂单 ${String(market.value?.orders.open.length ?? 0)}` },
  { id: 'ranks', label: '收益榜' },
]);

const UP = '#e0544a';
const DOWN = '#3fae74';

const selected = computed<StockView | null>(
  () => market.value?.stocks.find((stock) => stock.id === selectedId.value) ?? market.value?.stocks[0] ?? null,
);

/* ---------- 展示 ---------- */

function price(minUnits: number): string {
  return (minUnits / 1000).toFixed(2);
}

function signed(value: number, digits = 2): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function toneOf(value: number): string {
  if (value > 0) return 'is-up';
  if (value < 0) return 'is-down';
  return '';
}

function timeText(ms: number): string {
  const shifted = new Date(ms + 8 * 3_600_000);
  return `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`;
}

/** 持仓汇总：总市值、总成本、浮动盈亏。 */
const portfolio = computed(() => {
  let value = 0;
  let cost = 0;
  for (const stock of market.value?.stocks ?? []) {
    if (stock.holding === null) continue;
    value += stock.holding.marketValue;
    cost += stock.holding.cost;
  }
  return { value, cost, profit: value - cost };
});

/* ---------- K 线（SVG 自绘） ---------- */

const CHART_W = 600;
const CHART_H = 220;
const PAD_TOP = 12;
const PAD_BOTTOM = 18;

const chartGeometry = computed(() => {
  const candles = chart.value?.candles ?? [];
  if (candles.length === 0) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (const candle of candles) {
    hi = Math.max(hi, candle.h);
    lo = Math.min(lo, candle.l);
  }
  const span = Math.max(1, hi - lo);
  const step = CHART_W / candles.length;
  const y = (value: number) => PAD_TOP + ((hi - value) / span) * (CHART_H - PAD_TOP - PAD_BOTTOM);
  const bars = candles.map((candle, index) => {
    const x = index * step + step / 2;
    const up = candle.c >= candle.o;
    const top = y(Math.max(candle.o, candle.c));
    const bottom = y(Math.min(candle.o, candle.c));
    return {
      key: candle.t,
      x,
      wickTop: y(candle.h),
      wickBottom: y(candle.l),
      bodyX: x - Math.max(1, step * 0.32),
      bodyY: top,
      bodyW: Math.max(2, step * 0.64),
      bodyH: Math.max(1, bottom - top),
      color: up ? UP : DOWN,
    };
  });
  // 5 根均线
  const ma: string[] = [];
  candles.forEach((_, index) => {
    if (index < 4) return;
    const avg = candles.slice(index - 4, index + 1).reduce((sum, candle) => sum + candle.c, 0) / 5;
    ma.push(`${String((index * step + step / 2).toFixed(1))},${String(y(avg).toFixed(1))}`);
  });
  const last = candles[candles.length - 1]!;
  return {
    bars,
    ma: ma.join(' '),
    hi,
    lo,
    lastY: y(last.c),
    last: last.c,
    firstTime: candles[0]!.t,
    lastTime: last.t,
  };
});

/* ---------- 下单 ---------- */

const disabled = computed(() => submitting.value || props.busy === true);

const estimate = computed(() => {
  const stock = selected.value;
  const count = Math.floor(shares.value);
  if (stock === null || !Number.isFinite(count) || count < 1) return null;
  const amount = stock.price * count;
  const fee = Math.max(1, Math.ceil((amount * (market.value?.feeBp ?? 30)) / 10_000));
  return { amount, fee, buyTotal: amount + fee, sellNet: amount - fee };
});

const sellLockLeft = computed(() => {
  const at = selected.value?.holding?.sellableAt ?? null;
  if (at === null) return 0;
  return Math.max(0, Math.ceil((at - clockMs.value) / 60_000));
});

/** 还能买多少灵石的（持仓成本上限 − 已有成本）。 */
const capLeft = computed(() => Math.max(0, (market.value?.positionCap ?? 0) - (selected.value?.holding?.cost ?? 0)));

function fillMax(side: 'buy' | 'sell'): void {
  const stock = selected.value;
  if (stock === null) return;
  if (side === 'sell') {
    shares.value = stock.holding?.available ?? 0;
    return;
  }
  const stone = Number(props.state.resources.find((resource) => resource.id === 'spiritStone')?.balance ?? 0);
  const feeRate = 1 + (market.value?.feeBp ?? 30) / 10_000;
  shares.value = Math.max(0, Math.min(Math.floor(capLeft.value / stock.price), Math.floor(stone / (stock.price * feeRate))));
}

/* ---------- 挂单（0049） ---------- */

const stoneBalance = computed<number>(() =>
  Number(props.state.resources.find((resource) => resource.id === 'spiritStone')?.balance ?? 0),
);

/** 触发价输入（展示单位）→ 最小单位整数；不是正数或超过 3 位小数返回 null。 */
function triggerMinUnits(text: string): number | null {
  if (text.trim() === '') return null;
  const display = Number(text);
  if (!Number.isFinite(display) || display <= 0) return null;
  const minUnits = Math.round(display * 1000);
  if (minUnits < 1 || Math.abs(minUnits - display * 1000) > 1e-6) return null;
  return minUnits;
}

/** 限价买的冻结额：触发价 × 股数 + 手续费（与服务端 limitBuyReserve 同一口径）。 */
function reserveOf(trigger: number, count: number): number {
  const amount = trigger * count;
  return amount + Math.max(1, Math.ceil((amount * (market.value?.feeBp ?? 30)) / 10_000));
}

const orderTriggerMin = computed<number | null>(() => triggerMinUnits(orderTrigger.value));
const orderShareCount = computed<number>(() => {
  const value = Number(orderShares.value);
  return Number.isInteger(value) ? value : NaN;
});
const orderReserve = computed<number | null>(() => {
  const trigger = orderTriggerMin.value;
  const count = orderShareCount.value;
  if (trigger === null || !Number.isInteger(count) || count < 1) return null;
  return reserveOf(trigger, count);
});

/** 不能下这单的原因（空串 = 可以下）。 */
const orderError = computed<string>(() => {
  const view = market.value;
  const stock = selected.value;
  if (view === null || stock === null) return '';
  if (!view.unlocked) return `宗门 ${String(view.unlockSectLevel)} 级开放灵股`;
  const trigger = orderTriggerMin.value;
  if (trigger === null) return '触发价要大于 0，最多 3 位小数';
  const count = orderShareCount.value;
  if (!Number.isInteger(count) || count < 1 || count > view.maxSharesPerTrade) {
    return `股数为 1～${String(view.maxSharesPerTrade)} 的整数`;
  }
  if (view.orders.open.length >= view.orders.maxOpen) {
    return `挂单已满（${String(view.orders.maxOpen)} 个），先撤掉一些再下单`;
  }
  if (orderKind.value === 'limit_buy') {
    const cost = stock.holding?.cost ?? 0;
    if (cost + trigger * count > view.positionCap) {
      return `这支股票的持仓成本最多 ${formatAmount(view.positionCap)} 灵石，还能再买 ${formatAmount(Math.max(0, view.positionCap - cost))} 灵石`;
    }
    if (reserveOf(trigger, count) > stoneBalance.value) return '灵石不够冻结';
    return '';
  }
  const available = stock.holding?.available ?? 0;
  if (count > available) return `只能卖可用的 ${String(available)} 股（其余挂着卖单）`;
  return '';
});

const orderHint = computed<string>(() => {
  const stock = selected.value;
  if (stock === null) return '';
  if (orderKind.value === 'limit_buy') {
    return orderReserve.value === null
      ? '填好触发价和股数，这里会显示要冻结多少灵石'
      : `冻结 ${formatAmount(orderReserve.value)} 灵石（触发价 × 股数 + 手续费），成交时按实际成交价结算，多出的退回`;
  }
  const holding = stock.holding;
  return holding === null
    ? '还没有持仓，不能下卖单'
    : `可卖 ${String(holding.available)} 股（持有 ${String(holding.shares)}，挂单锁定 ${String(holding.locked)}）`;
});

/** 最小单位 → 输入框里的展示价（固定 3 位小数）。 */
function priceInput(minUnits: number): string {
  return (minUnits / 1000).toFixed(3);
}

/** 最小单位 → 展示价（最多 3 位小数，去掉末尾的 0）。 */
function priceFine(minUnits: number): string {
  return String(Number((minUnits / 1000).toFixed(3)));
}

function useCurrentPrice(): void {
  const stock = selected.value;
  if (stock !== null) orderTrigger.value = priceInput(stock.price);
}

/** 限价买：按当前能冻结的灵石、持仓上限算最大股数；卖单：可卖的全部股数。 */
function fillOrderMax(): void {
  const stock = selected.value;
  const view = market.value;
  if (stock === null || view === null) return;
  if (orderKind.value !== 'limit_buy') {
    orderShares.value = String(stock.holding?.available ?? 0);
    return;
  }
  const trigger = orderTriggerMin.value;
  if (trigger === null) return;
  const byCap = Math.floor((view.positionCap - (stock.holding?.cost ?? 0)) / trigger);
  let count = Math.max(0, Math.min(byCap, view.maxSharesPerTrade, Math.floor(stoneBalance.value / trigger)));
  while (count > 0 && reserveOf(trigger, count) > stoneBalance.value) count -= 1;
  orderShares.value = String(count);
}

async function placeOrder(): Promise<void> {
  const stock = selected.value;
  const trigger = orderTriggerMin.value;
  if (stock === null || trigger === null || orderError.value !== '' || disabled.value) return;
  const count = orderShareCount.value;
  const kind = orderKind.value;
  submitting.value = true;
  try {
    const data = await placeStockOrder(stock.id, kind, count, trigger);
    emit('state-update', data.state);
    market.value = data.market;
    const label = ORDER_KINDS.find((item) => item.id === kind)?.label ?? '挂单';
    emit('notify', 'success', '灵股', `已挂${label}：${stock.name} ${String(count)} 股，触发价 ${priceFine(trigger)}`);
    // 下单即刷新：服务端会顺手结算（触发价已满足的，这一分钟就成交）。
    void refresh(true);
  } catch (error) {
    emit('notify', 'warning', '灵股', error instanceof Error ? error.message : '挂单失败，请稍后再试');
  } finally {
    submitting.value = false;
  }
}

async function cancelOrder(order: MarketOrderView): Promise<void> {
  if (disabled.value) return;
  submitting.value = true;
  try {
    const data = await cancelStockOrder(order.id);
    emit('state-update', data.state);
    market.value = data.market;
    const back = order.kind === 'limit_buy' ? `，退回 ${formatAmount(order.reserved)} 灵石` : '';
    emit('notify', 'success', '灵股', `已撤销${order.stockName}的${order.kindName}单${back}`);
  } catch (error) {
    emit('notify', 'warning', '灵股', error instanceof Error ? error.message : '撤单失败，请稍后再试');
  } finally {
    submitting.value = false;
  }
}

/** 挂单结束的文案（成交价 / 过期 / 取消原因）。 */
function orderResultText(order: MarketOrderView): string {
  const back = order.kind === 'limit_buy' ? `，退回 ${formatAmount(order.reserved)} 灵石` : '';
  if (order.status === 'filled') return `成交 @ ${priceFine(order.fillPrice ?? 0)}`;
  if (order.status === 'expired') return `已过期${back}`;
  if (order.closeReason === 'position_cap') return `超出持仓上限，已取消${back}`;
  if (order.closeReason === 'no_shares') return '持股不足，已取消';
  return `已撤单${back}`;
}

/** 日期时间（UTC+8，MM-DD HH:mm）。 */
function dateTimeText(iso: string): string {
  const ms = Date.parse(iso);
  const shifted = new Date(ms + 8 * 3_600_000);
  return `${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')} ${timeText(ms)}`;
}

async function trade(side: 'buy' | 'sell'): Promise<void> {
  const stock = selected.value;
  if (stock === null || disabled.value) return;
  const count = Math.floor(shares.value);
  if (!Number.isFinite(count) || count < 1) {
    emit('notify', 'warning', '灵股', '请输入股数');
    return;
  }
  submitting.value = true;
  try {
    const data = await tradeStock(stock.id, side, count);
    emit('state-update', data.state);
    market.value = data.market;
    emit('notify', side === 'sell' && data.result.profit < 0 ? 'warning' : 'success', '灵股', data.result.message);
    void loadChart();
  } catch (error) {
    emit('notify', 'warning', '灵股', error instanceof Error ? error.message : '下单失败，请稍后再试');
  } finally {
    submitting.value = false;
  }
}

/* ---------- 刷新：按服务端的下一跳时刻自动刷新 ---------- */

const clockMs = ref(Date.now());
let serverOffset = 0;
let tickTimer: number | undefined;
let clockTimer: number | undefined;

const nextTickLeft = computed(() => {
  const next = market.value?.nextTickAt;
  if (next === undefined) return 0;
  return Math.max(0, Math.ceil((next - (clockMs.value + serverOffset)) / 1000));
});

function scheduleTick(): void {
  if (tickTimer !== undefined) window.clearTimeout(tickTimer);
  const next = market.value?.nextTickAt;
  if (next === undefined) return;
  const wait = Math.min(70_000, Math.max(1_000, next - (Date.now() + serverOffset) + 1_500));
  tickTimer = window.setTimeout(() => {
    void refresh(true);
  }, wait);
}

async function loadChart(): Promise<void> {
  const stock = selected.value;
  if (stock === null) return;
  try {
    chart.value = (await fetchMarketChart(stock.id, range.value)).chart;
  } catch {
    chart.value = null;
  }
}

async function refresh(silent = false): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const data = await fetchMarket();
    emit('state-update', data.state);
    market.value = data.market;
    serverOffset = data.market.serverNow - Date.now();
    if (selectedId.value === '' && data.market.stocks.length > 0) selectedId.value = data.market.stocks[0]!.id;
    await loadChart();
  } catch (error) {
    if (!silent) emit('notify', 'warning', '灵股', error instanceof Error ? error.message : '行情加载失败');
  } finally {
    loading.value = false;
    scheduleTick();
  }
}

watch([selectedId, range], () => {
  void loadChart();
});

// 切换股票时，触发价默认填当前价（用户再改）。
watch(selectedId, () => {
  useCurrentPrice();
});

const RULES_TEXT = `灵股 · 规则

开放：宗门 3 级。6 支股票与 1 个综合指数（指数只看不交易），行情每 1 分钟一跳。
坐庄：系统坐庄，按服务端此刻的价格与你成交，不需要等别人挂单；只能买入、卖出，没有做空和杠杆。
价格：每支股票围着自己的基准价上下波动，长期不会涨上天或跌到零；镇妖司波动最大，云来商号最稳。
消息：坊间会不定时传出利好 / 利空消息，消息公布后几个小时内相关股票会慢慢走出一波行情，
      但传闻未必属实（约四分之一不应验或反着走）。看消息、看 K 线抓趋势，有赚有赔。
手续费：买卖各 0.3%，直接扣除。
限制：某支股票买入后 10 分钟内不能卖出；每天最多成交 30 笔；每支股票的持仓成本不超过宗门灵石容量的 20%。
收益榜：按累计已实现收益（卖出的盈亏）排名。`;

/** 说明弹窗正文：首行标题已由弹窗标题栏给出。 */
const RULES_BODY = RULES_TEXT.slice(RULES_TEXT.indexOf('\n\n') + 2);

onMounted(() => {
  void refresh();
  clockTimer = window.setInterval(() => {
    clockMs.value = Date.now();
  }, 1_000);
});

onUnmounted(() => {
  if (tickTimer !== undefined) window.clearTimeout(tickTimer);
  if (clockTimer !== undefined) window.clearInterval(clockTimer);
});
</script>

<template>
  <section class="market-panel" aria-labelledby="market-title">
    <div class="market-head modal-head">
      <h3 id="market-title" class="market-title">
        灵股行情
        <small v-if="market" :class="toneOf(market.index.change24hPct)">
          综指 {{ market.index.value.toFixed(2) }}（{{ signed(market.index.change24hPct) }}%）
        </small>
      </h3>
      <div class="market-head-actions">
        <span v-if="market" class="market-tick">{{ nextTickLeft }} 秒后下一跳</span>
        <button class="market-quiet-button" type="button" @click="showRules = true">说明</button>
        <button class="market-quiet-button" type="button" :disabled="loading" @click="refresh()">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </div>

    <p v-if="market === null" class="market-empty">{{ loading ? '行情加载中…' : '行情加载失败，请点刷新。' }}</p>

    <template v-else>
      <p v-if="!market.unlocked" class="market-locked">宗门 {{ market.unlockSectLevel }} 级开放灵股交易，现在可以先看行情。</p>

      <p class="market-record">
        <span class="market-label">今日成交</span>
        <strong>{{ market.tradesUsed }} / {{ market.dailyTrades }}</strong>
        <span class="market-label">持仓市值</span>
        <strong>{{ formatAmount(portfolio.value) }}</strong>
        <span class="market-label">浮动盈亏</span>
        <strong :class="toneOf(portfolio.profit)">{{ signed(portfolio.profit / 1000) }}</strong>
        <span class="market-label">累计收益</span>
        <strong :class="toneOf(market.myProfit)">{{ signed(market.myProfit / 1000) }}</strong>
      </p>

      <!-- 股票列表 -->
      <ul class="market-stocks">
        <li v-for="stock in market.stocks" :key="stock.id">
          <button
            class="market-stock"
            :class="{ 'is-active': selected?.id === stock.id }"
            type="button"
            @click="selectedId = stock.id"
          >
            <span class="market-stock-name">
              <strong>{{ stock.name }}</strong>
              <small>{{ stock.code }} · {{ stock.sector }}</small>
            </span>
            <span class="market-stock-price" :class="toneOf(stock.price - stock.prevPrice)">{{ price(stock.price) }}</span>
            <span class="market-stock-change" :class="toneOf(stock.change24hPct)">{{ signed(stock.change24hPct) }}%</span>
            <span v-if="stock.holding" class="market-stock-hold">持 {{ stock.holding.shares }}</span>
          </button>
        </li>
      </ul>

      <!-- 个股 -->
      <section v-if="selected" class="market-detail">
        <div class="market-detail-head">
          <p class="market-detail-name">
            <strong>{{ selected.name }}</strong>
            <span class="market-detail-price" :class="toneOf(selected.change24hPct)">
              {{ price(selected.price) }}
              <small>{{ signed(selected.change24hPct) }}%</small>
            </span>
          </p>
          <p class="market-detail-desc">
            {{ selected.description }} · 24 小时最高 {{ price(selected.high24h) }} / 最低 {{ price(selected.low24h) }}
          </p>
        </div>

        <div class="market-ranges" role="tablist">
          <button
            v-for="item in RANGES"
            :key="item.id"
            class="market-range"
            :class="{ 'is-active': range === item.id }"
            type="button"
            @click="range = item.id"
          >
            {{ item.label }}
          </button>
        </div>

        <div class="market-chart">
          <svg v-if="chartGeometry" :viewBox="`0 0 ${CHART_W} ${CHART_H}`" preserveAspectRatio="none" role="img" :aria-label="`${selected.name} K 线`">
            <line
              :x1="0"
              :x2="CHART_W"
              :y1="chartGeometry.lastY"
              :y2="chartGeometry.lastY"
              class="market-chart-last"
            />
            <g v-for="bar in chartGeometry.bars" :key="bar.key">
              <line :x1="bar.x" :x2="bar.x" :y1="bar.wickTop" :y2="bar.wickBottom" :stroke="bar.color" stroke-width="1" />
              <rect :x="bar.bodyX" :y="bar.bodyY" :width="bar.bodyW" :height="bar.bodyH" :fill="bar.color" />
            </g>
            <polyline v-if="chartGeometry.ma" :points="chartGeometry.ma" class="market-chart-ma" />
          </svg>
          <p v-else class="market-empty">K 线加载中…</p>
          <div v-if="chartGeometry" class="market-chart-axis">
            <span>高 {{ price(chartGeometry.hi) }}</span>
            <span>低 {{ price(chartGeometry.lo) }}</span>
            <span>{{ timeText(chartGeometry.firstTime) }} ～ {{ timeText(chartGeometry.lastTime) }} · 金线 5 根均线</span>
          </div>
        </div>

        <!-- 下单 -->
        <div class="market-trade">
          <div v-if="selected.holding" class="market-holding">
            <span>持有 <strong>{{ selected.holding.shares }}</strong> 股</span>
            <span>成本 {{ price(selected.holding.avgPrice) }}</span>
            <span>市值 {{ formatAmount(selected.holding.marketValue) }}</span>
            <span :class="toneOf(selected.holding.profit)">
              盈亏 {{ signed(selected.holding.profit / 1000) }}（{{ signed(selected.holding.profitPct) }}%）
            </span>
            <span v-if="sellLockLeft > 0" class="market-lock">{{ sellLockLeft }} 分钟后可卖</span>
            <span v-if="selected.holding.locked > 0" class="market-lock">挂单锁 {{ selected.holding.locked }} 股</span>
          </div>
          <div class="market-trade-row">
            <label class="market-shares">
              <span>股数</span>
              <input v-model.number="shares" class="market-input" type="number" min="1" :max="market.maxSharesPerTrade" />
            </label>
            <button class="market-quiet-button" type="button" @click="fillMax('buy')">可买最大</button>
            <button class="market-quiet-button" type="button" :disabled="!selected.holding" @click="fillMax('sell')">可卖全部</button>
          </div>
          <p v-if="estimate" class="market-estimate">
            成交额 {{ formatAmount(estimate.amount) }} · 手续费 {{ formatAmount(estimate.fee) }} ·
            买入共花 {{ formatAmount(estimate.buyTotal) }} / 卖出到手 {{ formatAmount(estimate.sellNet) }} ·
            还可买入成本 {{ formatAmount(capLeft) }}
          </p>
          <div class="market-trade-buttons">
            <button
              class="market-buy"
              type="button"
              :disabled="disabled || !market.unlocked || market.tradesLeft <= 0"
              @click="trade('buy')"
            >
              买入
            </button>
            <button
              class="market-sell"
              type="button"
              :disabled="disabled || !market.unlocked || market.tradesLeft <= 0 || !selected.holding || selected.holding.available <= 0 || sellLockLeft > 0"
              @click="trade('sell')"
            >
              卖出
            </button>
          </div>

          <!-- 挂单：设好触发价和股数，价格到了服务端自动成交（结果在「挂单」标签里） -->
          <div class="market-order-form">
            <p class="market-order-title">
              <strong>挂单</strong>
              <span>已挂 {{ market.orders.open.length }} / {{ market.orders.maxOpen }} · 有效 {{ market.orders.ttlHours }} 小时</span>
            </p>
            <div class="market-ranges" role="radiogroup" aria-label="挂单类型">
              <button
                v-for="item in ORDER_KINDS"
                :key="item.id"
                class="market-range"
                :class="{ 'is-active': orderKind === item.id }"
                type="button"
                role="radio"
                :aria-checked="orderKind === item.id"
                @click="orderKind = item.id"
              >
                {{ item.label }}
              </button>
            </div>
            <div class="market-trade-row">
              <label class="market-shares">
                <span>触发价</span>
                <input v-model="orderTrigger" class="market-input" type="number" min="0.001" step="0.001" inputmode="decimal" />
              </label>
              <button class="market-quiet-button" type="button" @click="useCurrentPrice()">用现价</button>
            </div>
            <div class="market-trade-row">
              <label class="market-shares">
                <span>股数</span>
                <input v-model="orderShares" class="market-input" type="number" min="1" :max="market.maxSharesPerTrade" />
              </label>
              <button class="market-quiet-button" type="button" @click="fillOrderMax()">
                {{ orderKind === 'limit_buy' ? '可买最大' : '可卖全部' }}
              </button>
            </div>
            <p class="market-estimate">{{ orderHint }}</p>
            <p v-if="orderError" class="market-order-error">{{ orderError }}</p>
            <button
              class="market-order-submit"
              type="button"
              :disabled="disabled || !market.unlocked || orderError !== ''"
              @click="placeOrder()"
            >
              挂单
            </button>
          </div>
        </div>
      </section>

      <!-- 消息 / 成交 / 挂单 / 收益榜 -->
      <div class="market-tabs" role="tablist">
        <button
          v-for="item in tabs"
          :key="item.id"
          class="market-range"
          :class="{ 'is-active': tab === item.id }"
          type="button"
          @click="tab = item.id"
        >
          {{ item.label }}
        </button>
      </div>

      <ul v-if="tab === 'news'" class="market-lines">
        <li v-if="market.news.length === 0" class="market-empty">近一天风平浪静。</li>
        <li v-for="news in market.news" :key="news.id">
          <span class="market-time">{{ timeText(news.at) }}</span>
          <span class="market-tag">{{ news.stockName }}</span>
          <span :class="news.direction > 0 ? 'is-up' : 'is-down'">{{ news.direction > 0 ? '利好' : '利空' }}</span>
          {{ news.title }}
        </li>
      </ul>

      <ul v-else-if="tab === 'trades'" class="market-lines">
        <li v-if="market.myTrades.length === 0" class="market-empty">还没有成交。</li>
        <li v-for="item in market.myTrades" :key="item.id">
          <span class="market-time">{{ timeText(item.createdAt) }}</span>
          <span :class="item.side === 'buy' ? 'is-up' : 'is-down'">{{ item.side === 'buy' ? '买入' : '卖出' }}</span>
          {{ item.stockName }} {{ item.shares }} 股 @ {{ price(item.price) }}
          <span v-if="item.side === 'sell'" :class="toneOf(item.profit)">（{{ signed(item.profit / 1000) }}）</span>
        </li>
      </ul>

      <ul v-else-if="tab === 'orders'" class="market-lines">
        <li v-if="market.orders.open.length === 0 && market.orders.recent.length === 0" class="market-empty">
          还没有挂单。在上面的「挂单」里设好触发价，价格到了自动成交。
        </li>
        <li v-for="order in market.orders.open" :key="order.id" class="market-order">
          <span class="market-time">{{ dateTimeText(order.expiresAt) }} 到期</span>
          <span class="market-tag">{{ order.stockName }}</span>
          <span :class="order.kind === 'limit_buy' ? 'is-up' : 'is-down'">{{ order.kindName }}</span>
          {{ order.shares }} 股 @ {{ priceFine(order.triggerPrice) }}
          <small class="market-order-note">
            {{ order.kind === 'limit_buy' ? `冻结 ${formatAmount(order.reserved)} 灵石` : `锁定 ${order.shares} 股` }}
          </small>
          <button class="market-quiet-button" type="button" :disabled="disabled" @click="cancelOrder(order)">撤单</button>
        </li>
        <li v-for="order in market.orders.recent" :key="order.id" class="market-order is-closed">
          <span class="market-time">{{ dateTimeText(order.filledAt ?? order.createdAt) }}</span>
          <span class="market-tag">{{ order.stockName }}</span>
          {{ order.kindName }} {{ order.shares }} 股：{{ orderResultText(order) }}
        </li>
      </ul>

      <ul v-else class="market-lines">
        <li v-if="market.ranks.length === 0" class="market-empty">还没有人卖出过。</li>
        <li v-for="rank in market.ranks" :key="rank.rank" :class="{ 'is-me': rank.isMe }">
          <span class="market-time">{{ rank.rank }}</span>
          {{ rank.sectName }}
          <strong :class="toneOf(rank.profit)">{{ signed(rank.profit / 1000) }}</strong>
        </li>
      </ul>
    </template>

    <!-- 二级弹窗：规则说明（Esc / 点遮罩只关这一层）。 -->
    <ModalShell v-if="showRules" label="灵股规则" @close="showRules = false">
      <section aria-labelledby="market-rules-title">
        <header class="section-heading panel-heading compact-heading">
          <div>
            <p class="eyebrow">灵股</p>
            <h2 id="market-rules-title">规则说明</h2>
          </div>
        </header>
        <p class="market-rules">{{ RULES_BODY }}</p>
      </section>
    </ModalShell>
  </section>
</template>

<style scoped>
.market-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.is-up {
  color: #e0544a;
}

.is-down {
  color: #3fae74;
}

.market-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.market-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  color: var(--gold-bright, #ead19a);
  font-size: 16px;
  font-weight: 600;
}

.market-title small {
  font-size: 12px;
  font-weight: 400;
}

.market-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.market-tick {
  color: #7d9186;
  font-size: 12px;
}

.market-quiet-button {
  padding: 2px 10px;
  border: 1px solid rgba(202, 169, 106, 0.4);
  border-radius: 2px;
  background: rgba(202, 169, 106, 0.08);
  color: var(--gold, #caa96a);
  font-size: 12px;
  cursor: pointer;
}

.market-quiet-button:disabled {
  color: #63756c;
  cursor: not-allowed;
}

.market-rules {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-radius: 3px;
  color: #c8d6ce;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
}

.market-empty {
  margin: 0;
  color: #6d8078;
  font-size: 12px;
}

.market-locked {
  margin: 0;
  padding: 6px 10px;
  border: 1px solid rgba(217, 138, 74, 0.4);
  border-radius: 3px;
  background: rgba(217, 138, 74, 0.08);
  color: #d9b06a;
  font-size: 12px;
}

.market-record {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  margin: 0;
  padding: 6px 10px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.014);
  font-size: 12px;
}

.market-label {
  color: #8fa79b;
}

.market-record strong {
  color: var(--gold-bright, #ead19a);
}

.market-record strong.is-up {
  color: #e0544a;
}

.market-record strong.is-down {
  color: #3fae74;
}

.market-stocks {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.market-stock {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 8px;
  padding: 6px 8px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.014);
  color: #cbd8d0;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.market-stock.is-active {
  border-color: rgba(234, 209, 154, 0.6);
  background: rgba(202, 169, 106, 0.1);
}

.market-stock-name {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.market-stock-name strong {
  overflow: hidden;
  color: var(--gold-bright, #ead19a);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.market-stock-name small {
  color: #7d9186;
  font-size: 11px;
}

.market-stock-price {
  align-self: center;
  font-size: 14px;
  font-weight: 600;
  text-align: right;
}

.market-stock-change {
  grid-column: 2;
  font-size: 11px;
  text-align: right;
}

.market-stock-hold {
  grid-column: 1;
  grid-row: 2;
  color: #d9b06a;
  font-size: 11px;
}

.market-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.012);
}

.market-detail-head p {
  margin: 0;
}

.market-detail-name {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.market-detail-name strong {
  color: var(--gold-bright, #ead19a);
  font-size: 15px;
}

.market-detail-price {
  font-size: 18px;
  font-weight: 600;
}

.market-detail-price small {
  margin-left: 4px;
  font-size: 12px;
}

.market-detail-desc {
  color: #8fa79b;
  font-size: 12px;
  line-height: 1.6;
}

.market-ranges,
.market-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.market-range {
  padding: 3px 10px;
  border: 1px solid rgba(202, 169, 106, 0.2);
  border-radius: 20px;
  background: transparent;
  color: #9fb2a8;
  font-size: 12px;
  cursor: pointer;
}

.market-range.is-active {
  border-color: rgba(202, 169, 106, 0.6);
  background: rgba(202, 169, 106, 0.12);
  color: var(--gold-bright, #ead19a);
}

.market-chart svg {
  display: block;
  width: 100%;
  height: 200px;
  border: 1px solid rgba(202, 169, 106, 0.12);
  border-radius: 3px;
  background: rgba(4, 12, 10, 0.5);
}

.market-chart-last {
  stroke: rgba(234, 209, 154, 0.35);
  stroke-dasharray: 4 4;
  stroke-width: 1;
}

.market-chart-ma {
  fill: none;
  stroke: #e0b95a;
  stroke-width: 1.4;
}

.market-chart-axis {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 10px;
  margin-top: 4px;
  color: #7d9186;
  font-size: 11px;
}

.market-trade {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.market-holding {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  color: #cbd8d0;
  font-size: 12px;
}

.market-holding strong {
  color: var(--gold-bright, #ead19a);
}

.market-lock {
  color: #d9b06a;
}

.market-trade-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.market-shares {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #9fb2a8;
  font-size: 12px;
}

.market-input {
  width: 110px;
  padding: 4px 6px;
  border: 1px solid rgba(202, 169, 106, 0.3);
  border-radius: 3px;
  background: rgba(6, 18, 15, 0.8);
  color: #e6efe9;
  font-size: 13px;
}

.market-estimate {
  margin: 0;
  color: #8fa79b;
  font-size: 12px;
  line-height: 1.6;
}

.market-trade-buttons {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.market-buy,
.market-sell {
  min-height: 36px;
  border: 1px solid;
  border-radius: 3px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.market-buy {
  border-color: rgba(224, 84, 74, 0.6);
  background: rgba(224, 84, 74, 0.16);
  color: #f08a80;
}

.market-sell {
  border-color: rgba(63, 174, 116, 0.6);
  background: rgba(63, 174, 116, 0.16);
  color: #6fd3a0;
}

.market-buy:disabled,
.market-sell:disabled {
  border-color: rgba(167, 184, 173, 0.11);
  background: rgba(255, 255, 255, 0.016);
  color: #63756c;
  cursor: not-allowed;
}

.market-lines {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  color: #a9bcb2;
  font-size: 12px;
  line-height: 1.6;
}

.market-lines li.is-me {
  color: #dce6e0;
}

.market-time {
  margin-right: 6px;
  color: #6d8078;
}

.market-tag {
  margin-right: 4px;
  padding: 0 6px;
  border-radius: 20px;
  background: rgba(202, 169, 106, 0.12);
  color: var(--gold, #caa96a);
  font-size: 11px;
}

.market-order-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px dashed rgba(202, 169, 106, 0.2);
}

.market-order-title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  margin: 0;
  color: #8fa79b;
  font-size: 12px;
}

.market-order-title strong {
  color: var(--gold-bright, #ead19a);
  font-size: 13px;
}

.market-order-error {
  margin: 0;
  color: #d9b06a;
  font-size: 12px;
}

.market-order-submit {
  min-height: 34px;
  border: 1px solid rgba(202, 169, 106, 0.6);
  border-radius: 3px;
  background: rgba(202, 169, 106, 0.14);
  color: var(--gold-bright, #ead19a);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.market-order-submit:disabled {
  border-color: rgba(167, 184, 173, 0.11);
  background: rgba(255, 255, 255, 0.016);
  color: #63756c;
  cursor: not-allowed;
}

.market-order {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}

.market-order.is-closed {
  color: #7d9186;
}

.market-order-note {
  color: #8fa79b;
  font-size: 11px;
}

/* 窄屏：股票两列；头部换行。 */
@media (max-width: 520px) {
  .market-stocks {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .market-chart svg {
    height: 160px;
  }
}
</style>
