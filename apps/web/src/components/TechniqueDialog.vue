<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';

import type {
  SectStateView,
  TechniqueCatalogView,
  TechniqueLibraryView,
  TechniqueShopTierView,
} from '../api/game';
import ModalShell from './ModalShell.vue';
import { buyTechniqueScrolls, fetchTechniques, learnTechnique, upgradeTechnique } from '../api/game';
import { formatAmount } from '../utils/format';

/**
 * 藏经阁（弹窗内容，外壳由 SectScreen 的 ModalShell 提供），两个标签页：
 * - 功法（0066，docs/功法开发计划.md 第 9 节）：全部功法按流派分组；列表只显示名称、进度与一句简介，
 *   收录 / 参悟在详情弹窗里做。
 * - 商店（0069，docs/藏经阁扩建与功法商店计划.md 3.2）：每天 0 点刷新的限量额度，只卖玄阶、地阶残卷（天阶不卖），
 *   购买直接在行内完成、不二次确认。
 *
 * 只在打开与每次操作后请求，不轮询；收录所需残卷、参悟消耗、商店额度与单价都由服务端算好，这里只渲染。
 */
const props = defineProps<{
  state: SectStateView;
  busy?: boolean;
}>();

const emit = defineEmits<{
  'state-update': [state: SectStateView];
  notify: [tone: 'success' | 'warning', title: string, message: string];
}>();

/* ---------- 标签页：真正的 tablist / tab / tabpanel（与坊市同一套约定） ---------- */

const TABS = [
  { id: 'library', label: '功法' },
  { id: 'shop', label: '商店' },
] as const;

type TechniqueTab = (typeof TABS)[number]['id'];

/** 默认停在「功法」；收录 / 参悟 / 购买成功后 library 换成新的，这里不动，留在当前标签页。 */
const tab = ref<TechniqueTab>('library');
const tabButtons = ref<Record<string, HTMLButtonElement | null>>({});

function tabButtonId(id: TechniqueTab): string {
  return `technique-tab-${id}`;
}

function tabPanelId(id: TechniqueTab): string {
  return `technique-panel-${id}`;
}

function setTabButton(id: TechniqueTab, element: Element | null): void {
  if (element instanceof HTMLButtonElement) tabButtons.value[id] = element;
  else delete tabButtons.value[id];
}

/** 方向键 / Home / End 在两个标签页之间移动（自动激活，焦点跟着走）。 */
function onTabKeydown(event: KeyboardEvent, current: TechniqueTab): void {
  const index = TABS.findIndex((item) => item.id === current);
  if (index < 0) return;
  let nextIndex = -1;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % TABS.length;
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    nextIndex = (index - 1 + TABS.length) % TABS.length;
  } else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = TABS.length - 1;
  else return;

  const target = TABS[nextIndex];
  if (target === undefined) return;
  event.preventDefault();
  tab.value = target.id;
  void nextTick(() => tabButtons.value[target.id]?.focus());
}

/* ---------- 功法标签：列表、详情、收录 / 参悟 ---------- */

const library = ref<TechniqueLibraryView | null>(null);
const loading = ref(false);
/** 进行中的操作对应的功法 id（收录 / 参悟 / 购买共用，同一时间只允许一个）。 */
const pendingId = ref<string | null>(null);
const errorText = ref('');

const maxLevel = computed(() => library.value?.maxLevel ?? 10);
/** 点开详情的功法 id（详情跟着 library 刷新，收录 / 参悟后直接显示新状态）。 */
const selectedId = ref<string | null>(null);
const selected = computed(() => library.value?.items.find((item) => item.id === selectedId.value) ?? null);

/** 列表里的收集状态：已收录看参悟等级，未收录看残卷进度。 */
function progressText(item: TechniqueCatalogView): string {
  return item.learned ? `参悟 ${String(item.level)} 级` : `残卷 ${String(item.scrolls)} / ${String(item.learnScrolls)}`;
}

/** 按流派分组（服务端下发的流派顺序）。 */
const groups = computed(() => {
  const items = library.value?.items ?? [];
  return (library.value?.schools ?? []).map((school) => ({
    id: school.id,
    name: school.name,
    items: items.filter((item) => item.school === school.id),
  }));
});

async function refresh(): Promise<void> {
  loading.value = true;
  errorText.value = '';
  try {
    library.value = (await fetchTechniques()).library;
  } catch (caught) {
    errorText.value = caught instanceof Error ? caught.message : '藏经阁读取失败';
  } finally {
    loading.value = false;
  }
}

/** 收录 / 参悟：成功后用服务端回执刷新面板与宗门状态。 */
async function act(item: TechniqueCatalogView, kind: 'learn' | 'upgrade'): Promise<void> {
  if (props.busy === true || pendingId.value !== null) return;
  pendingId.value = item.id;
  errorText.value = '';
  try {
    const data = kind === 'learn' ? await learnTechnique(item.id) : await upgradeTechnique(item.id);
    library.value = data.library;
    emit('state-update', data.state);
    emit('notify', 'success', '藏经阁', data.result.message);
  } catch (caught) {
    errorText.value = caught instanceof Error ? caught.message : '操作失败';
    emit('notify', 'warning', '藏经阁', errorText.value);
  } finally {
    pendingId.value = null;
  }
}

function stoneText(minUnits: number | null): string {
  return minUnits === null ? '' : formatAmount(String(minUnits));
}

/* ---------- 商店标签：每日限量的玄阶、地阶残卷 ---------- */

/** 单次购买张数的上限（与服务端 schema 一致）。 */
const SHOP_BUY_MAX_PER_ORDER = 20;

const shop = computed(() => library.value?.shop ?? null);

/** 商店列表：只列玄阶、地阶的功法（按服务端下发的品阶顺序，玄阶在前；同品阶保持功法原有的顺序）。 */
const shopItems = computed(() => {
  const items = library.value?.items ?? [];
  return (shop.value?.tiers ?? []).flatMap((tier) => items.filter((item) => item.tier === tier.tier));
});

/** 功法所属品阶的今日额度（天阶不在商店出售，返回 undefined）。 */
function shopTierOf(item: TechniqueCatalogView): TechniqueShopTierView | undefined {
  return shop.value?.tiers.find((tier) => tier.tier === item.tier);
}

/** 这一行最多能买几张：该品阶今天的剩余额度与单次上限取小；没有额度时为 0。 */
function shopMaxOf(item: TechniqueCatalogView): number {
  const tier = shopTierOf(item);
  return tier === undefined ? 0 : Math.min(tier.remaining, SHOP_BUY_MAX_PER_ORDER);
}

/** 购买张数的草稿（按功法 id 记，默认 1）。 */
const shopDrafts = ref<Record<string, number>>({});

/** 这一行当前的购买张数：草稿夹在 1 ～ 可买上限之间；没有可买时为 0。 */
function shopQuantityOf(item: TechniqueCatalogView): number {
  const max = shopMaxOf(item);
  if (max <= 0) return 0;
  return Math.min(max, Math.max(1, shopDrafts.value[item.id] ?? 1));
}

function shopStep(item: TechniqueCatalogView, delta: number): void {
  shopDrafts.value[item.id] = shopQuantityOf(item) + delta;
}

/**
 * 行内的购买状态：额度为 0（藏经阁等级不够，显示「藏经阁 N 级开放」）、今日售罄（按钮禁用），或可买。
 */
function shopStateOf(item: TechniqueCatalogView): 'locked' | 'soldout' | 'open' {
  const tier = shopTierOf(item);
  if (tier === undefined || tier.quota === 0) return 'locked';
  return tier.remaining === 0 ? 'soldout' : 'open';
}

/** 本次购买的总价文案（展示单位）。 */
function costText(item: TechniqueCatalogView, quantity: number): string {
  const tier = shopTierOf(item);
  return tier === undefined ? '' : formatAmount(tier.price * quantity);
}

/** 额度条的一项：有额度显示「已购 / 额度」，未开放显示开放等级。 */
function quotaText(tier: TechniqueShopTierView): string {
  return tier.quota > 0
    ? `${tier.tierName} ${String(tier.bought)}/${String(tier.quota)}`
    : `${tier.tierName} · 藏经阁 ${String(tier.openLevel)} 级开放`;
}

/** 购买：成功后用服务端回执刷新面板与宗门状态；失败沿用面板的错误提示。 */
async function buy(item: TechniqueCatalogView): Promise<void> {
  const quantity = shopQuantityOf(item);
  if (props.busy === true || pendingId.value !== null || quantity <= 0) return;
  pendingId.value = item.id;
  errorText.value = '';
  try {
    const data = await buyTechniqueScrolls(item.id, quantity);
    library.value = data.library;
    emit('state-update', data.state);
    emit('notify', 'success', '功法商店', data.result.message);
  } catch (caught) {
    errorText.value = caught instanceof Error ? caught.message : '购买失败';
    emit('notify', 'warning', '功法商店', errorText.value);
  } finally {
    pendingId.value = null;
  }
}

onMounted(() => {
  void refresh();
});
</script>

<template>
  <div class="technique-dialog">
    <div class="technique-tabs" role="tablist" aria-label="藏经阁分区">
      <button
        v-for="item in TABS"
        :id="tabButtonId(item.id)"
        :key="item.id"
        :ref="(element) => setTabButton(item.id, element as Element | null)"
        class="technique-tab"
        type="button"
        role="tab"
        :aria-selected="tab === item.id"
        :aria-controls="tabPanelId(item.id)"
        :tabindex="tab === item.id ? 0 : -1"
        @click="tab = item.id"
        @keydown="onTabKeydown($event, item.id)"
      >
        {{ item.label }}
      </button>
    </div>

    <p v-if="loading" class="technique-quiet">正在取阅典籍…</p>

    <!-- ---------- 功法：全部功法按流派分组，点开看详情、收录或参悟 ---------- -->
    <div
      v-show="tab === 'library'"
      :id="tabPanelId('library')"
      class="technique-panel"
      role="tabpanel"
      :aria-labelledby="tabButtonId('library')"
      tabindex="0"
    >
      <p class="technique-intro">功法归宗门：收录与参悟只做一次，修习的弟子共享等级。点开功法查看效果与参悟。</p>
      <p v-if="library && !library.unlocked" class="technique-lock" role="status">
        宗门建有藏经阁（1 级）后，才能收录与参悟功法。
      </p>

      <section v-for="group in groups" :key="group.id" class="technique-group">
        <h3 class="technique-group-title">{{ group.name }}</h3>
        <ul class="technique-list">
          <li v-for="item in group.items" :key="item.id">
            <button
              class="technique-card technique-row"
              :class="[
                `tier-${item.tier}`,
                { 'is-learned': item.learned, 'is-ready': !item.learned && item.learnRemaining === 0 },
              ]"
              type="button"
              @click="selectedId = item.id"
            >
              <span class="technique-card-head">
                <strong class="technique-name">{{ item.name }}</strong>
                <span class="technique-progress">{{ progressText(item) }}</span>
              </span>
              <span class="technique-summary">{{ item.summary }}</span>
            </button>
          </li>
        </ul>
      </section>
    </div>

    <!-- ---------- 商店：每天 0 点刷新的限量残卷，购买直接在行内完成 ---------- -->
    <div
      v-show="tab === 'shop'"
      :id="tabPanelId('shop')"
      class="technique-panel"
      role="tabpanel"
      :aria-labelledby="tabButtonId('shop')"
      tabindex="0"
    >
      <p v-if="library && shop && !shop.unlocked" class="technique-lock" role="status">
        宗门建有藏经阁后开放功法商店。
      </p>
      <template v-else-if="shop">
        <div class="technique-quota" aria-label="今日额度">
          <span class="technique-quota-title">今日额度</span>
          <template v-for="tier in shop.tiers" :key="tier.tier">
            <span class="technique-quota-sep" aria-hidden="true">·</span>
            <span class="technique-quota-item">{{ quotaText(tier) }}</span>
          </template>
          <span class="technique-quota-sep" aria-hidden="true">·</span>
          <span class="technique-quota-refresh">每日 0 点刷新</span>
        </div>
        <p v-if="shop.nextLevelHint" class="technique-quiet technique-quota-hint">{{ shop.nextLevelHint }}</p>

        <ul class="technique-list technique-shop-list">
          <li v-for="item in shopItems" :key="item.id">
            <div class="technique-card technique-shop-row" :class="`tier-${item.tier}`">
              <span class="technique-card-head">
                <strong class="technique-name">{{ item.name }}</strong>
                <span class="technique-progress">持有 {{ item.scrolls }} 张</span>
              </span>
              <span class="technique-shop-line">
                <span class="technique-summary">{{ formatAmount(shopTierOf(item)?.price ?? 0) }} 灵石 / 张</span>
                <span v-if="shopStateOf(item) === 'locked'" class="technique-shop-note">
                  藏经阁 {{ shopTierOf(item)?.openLevel ?? 0 }} 级开放
                </span>
                <button
                  v-else-if="shopStateOf(item) === 'soldout'"
                  class="action-button technique-buy-button"
                  type="button"
                  disabled
                >
                  已售罄
                </button>
                <span v-else class="technique-stepper">
                  <button
                    class="technique-step"
                    type="button"
                    :disabled="busy === true || pendingId !== null || shopQuantityOf(item) <= 1"
                    :aria-label="`${item.name}少买一张`"
                    @click="shopStep(item, -1)"
                  >
                    −
                  </button>
                  <output class="technique-step-value" :aria-label="`购买 ${String(shopQuantityOf(item))} 张`">
                    {{ shopQuantityOf(item) }}
                  </output>
                  <button
                    class="technique-step"
                    type="button"
                    :disabled="busy === true || pendingId !== null || shopQuantityOf(item) >= shopMaxOf(item)"
                    :aria-label="`${item.name}多买一张`"
                    @click="shopStep(item, 1)"
                  >
                    +
                  </button>
                  <button
                    class="action-button primary-action technique-buy-button"
                    type="button"
                    :disabled="busy === true || pendingId !== null"
                    :title="`花费 ${costText(item, shopQuantityOf(item))} 灵石`"
                    @click="buy(item)"
                  >
                    购买
                  </button>
                </span>
              </span>
            </div>
          </li>
        </ul>
      </template>
    </div>

    <p v-if="errorText" class="technique-error" role="alert">{{ errorText }}</p>

    <ModalShell v-if="selected" narrow :loading="pendingId !== null" :label="selected.name" @close="selectedId = null">
      <div class="technique-detail">
        <header class="technique-detail-head">
          <h2>{{ selected.name }}</h2>
          <span class="technique-tier">{{ selected.tierName }} · {{ selected.schoolName }}</span>
        </header>
        <p class="technique-summary">{{ selected.summary }}</p>
        <dl class="technique-facts">
          <dt>镇妖塔</dt>
          <dd>{{ selected.towerGain }}</dd>
          <dt>世界 Boss</dt>
          <dd>{{ selected.bossGain }}</dd>
          <dt>代价</dt>
          <dd class="technique-cost">{{ selected.cost }}</dd>
          <dt>参悟</dt>
          <dd>
            <template v-if="selected.learned">
              {{ selected.level }} / {{ maxLevel }} 级 · 系数 ×{{ selected.levelFactor.toFixed(2) }} · 主修弟子 {{ selected.disciplesUsing }} 名
            </template>
            <template v-else>未收录</template>
          </dd>
          <dt>残卷</dt>
          <dd>
            现有 {{ selected.scrolls }} 张
            <template v-if="!selected.learned"> · 收录需 {{ selected.learnScrolls }} 张</template>
            <template v-else-if="selected.upgradeScrolls !== null">
              · 参悟到 {{ selected.level + 1 }} 级需 {{ selected.upgradeScrolls }} 张、灵石 {{ stoneText(selected.upgradeStone) }}
            </template>
            <template v-else> · 已满级</template>
          </dd>
        </dl>
        <div class="technique-actions">
          <button
            v-if="!selected.learned"
            class="action-button primary-action technique-button"
            type="button"
            :disabled="busy === true || pendingId !== null || !library?.unlocked || selected.learnRemaining > 0"
            @click="act(selected, 'learn')"
          >
            {{ selected.learnRemaining > 0 ? `还差 ${selected.learnRemaining} 张残卷` : '收录' }}
          </button>
          <button
            v-else-if="selected.upgradeScrolls !== null"
            class="action-button primary-action technique-button"
            type="button"
            :disabled="busy === true || pendingId !== null || !library?.unlocked"
            @click="act(selected, 'upgrade')"
          >
            参悟至 {{ selected.level + 1 }} 级
          </button>
        </div>
      </div>
    </ModalShell>
  </div>
</template>

<style scoped>
/* 品阶颜色：组件内变量，深色主题下都看得清；边框 1px 实线，左侧 3px 同色淡条。 */
.technique-dialog {
  --tier-xuan: #3fa7c9;
  --tier-di: #9b6ad6;
  --tier-tian: #d4a73c;
  --tier-xuan-soft: rgba(63, 167, 201, 0.4);
  --tier-di-soft: rgba(155, 106, 214, 0.4);
  --tier-tian-soft: rgba(212, 167, 60, 0.4);

  display: grid;
  gap: 14px;
  padding: 4px 2px 12px;
}

/* ---------- 标签页（与坊市同一套样式） ---------- */

.technique-tabs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
}

.technique-tab {
  padding: 8px 10px;
  border: 1px solid rgba(119, 184, 154, 0.16);
  border-radius: 3px;
  color: #9db3a8;
  background: rgba(255, 255, 255, 0.02);
  font-size: 13px;
  letter-spacing: 0.06em;
  transition: border-color 140ms ease, background-color 140ms ease, color 140ms ease, transform 140ms ease;
}

.technique-tab:not(:disabled):hover {
  border-color: rgba(202, 169, 106, 0.3);
  color: #e4ece6;
}

.technique-tab:not(:disabled):active {
  transform: translateY(1px);
}

.technique-tab[aria-selected='true'] {
  border-color: rgba(202, 169, 106, 0.42);
  color: var(--gold-bright, #e0cd97);
  background: rgba(202, 169, 106, 0.08);
}

.technique-tab:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgba(202, 169, 106, 0.3);
}

.technique-panel {
  display: grid;
  gap: 14px;
  outline: none;
}

.technique-intro,
.technique-quiet,
.technique-lock {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}

.technique-lock {
  color: var(--gold);
}

.technique-group-title {
  margin: 0 0 6px;
  font-size: 13px;
  color: var(--gold);
}

/* ---------- 紧凑列表：宽屏三列、中屏两列、窄屏一列 ---------- */

.technique-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

@media (min-width: 720px) {
  .technique-list {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

/* 商店行多了步进器与购买按钮，宽屏也只排两列，免得按钮被挤到下一行。 */
@media (min-width: 720px) {
  .technique-shop-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 560px) {
  .technique-list {
    grid-template-columns: minmax(0, 1fr);
  }
}

.technique-card {
  display: grid;
  gap: 4px;
  width: 100%;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  color: var(--ink-text);
  text-align: left;
}

.technique-card.tier-xuan {
  border-color: var(--tier-xuan);
  border-left: 3px solid var(--tier-xuan-soft);
}

.technique-card.tier-di {
  border-color: var(--tier-di);
  border-left: 3px solid var(--tier-di-soft);
}

.technique-card.tier-tian {
  border-color: var(--tier-tian);
  border-left: 3px solid var(--tier-tian-soft);
}

.technique-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.technique-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
}

.technique-progress {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--faint);
  white-space: nowrap;
}

.technique-summary {
  display: block;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--muted);
}

/* 未收录的行整体淡一点；已收录正常。可收录（残卷够）的进度文字用金色。 */
.technique-row {
  cursor: pointer;
  transition: background-color 160ms ease, opacity 160ms ease;
}

.technique-row:hover {
  background: var(--surface-strong);
}

.technique-row:not(.is-learned) {
  opacity: 0.72;
}

.technique-row.is-learned .technique-progress {
  color: var(--jade);
}

.technique-row.is-ready .technique-progress {
  color: var(--gold);
}

/* ---------- 商店 ---------- */

.technique-quota {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 6px;
  font-size: 13px;
  color: var(--muted);
}

.technique-quota-title {
  color: var(--gold);
}

.technique-quota-sep {
  color: var(--faint);
}

.technique-quota-item {
  white-space: nowrap;
  color: var(--ink-text);
}

.technique-quota-refresh {
  font-size: 12px;
  color: var(--faint);
}

.technique-quota-hint {
  font-size: 12px;
}

.technique-shop-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}

.technique-shop-note {
  font-size: 12px;
  color: var(--faint);
}

.technique-stepper {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.technique-step {
  width: 24px;
  height: 24px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--surface-strong);
  color: var(--ink-text);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.technique-step:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.technique-step-value {
  min-width: 22px;
  text-align: center;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.technique-buy-button {
  min-height: 26px;
  margin-left: 2px;
  padding: 2px 10px;
  font-size: 12px;
}

/* ---------- 详情弹窗 ---------- */

.technique-tier {
  font-size: 12px;
  color: var(--gold);
}

.technique-detail {
  display: grid;
  gap: 10px;
}

.technique-detail .technique-summary {
  overflow: visible;
  white-space: normal;
}

.technique-detail-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
  padding-right: 32px;
}

.technique-detail-head h2 {
  margin: 0;
  font-size: 18px;
}

.technique-facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
}

.technique-facts dt {
  color: var(--muted);
  white-space: nowrap;
}

.technique-facts dd {
  margin: 0;
}

.technique-facts dd.technique-cost {
  color: var(--red-bright);
}

.technique-actions {
  display: flex;
  justify-content: flex-end;
}

.technique-button {
  min-height: 34px;
  padding: 6px 16px;
  font-size: 13px;
}

.technique-error {
  margin: 0;
  color: var(--red-bright);
  font-size: 13px;
}
</style>
