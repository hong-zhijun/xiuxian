<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import type {
  EquipmentItemView,
  EquipmentMainAttr,
  EquipmentSlotId,
  EquipmentSlotView,
  EquipmentView,
  SectStateView,
} from '../api/game';
import { formatAmount } from '../utils/format';

/**
 * 炼器与装备背包（弹窗内容，外壳由 SectScreen 用 ModalShell 提供）。
 *
 * 规则全部以服务端算好的 `equipment` 视图为准：解锁状态、炼器价格、可选部位与法器主属性候选、
 * 背包上限、分解返还都直接渲染 —— 前端不复制品质 / 属性规则表，也不复算任何数值。
 * 请求只 emit（`forge` / `salvage`），由 SectScreen 调接口并把最新的 state 与 equipment 传回来。
 */
const props = defineProps<{
  state: SectStateView;
  equipment: EquipmentView;
  busy: boolean;
}>();

const emit = defineEmits<{
  /** 炼器：法器必须带 mainAttr（speed / luck），其他部位传 undefined。 */
  forge: [slot: EquipmentSlotId, mainAttr: EquipmentMainAttr | undefined];
  /** 分解选中的背包装备（穿在身上的不可选；件数与返还矿石由服务端复核）。 */
  salvage: [equipmentIds: string[]];
}>();

/* ---------- 标签页：真正的 tablist / tab / tabpanel（与坊市 / 弟子详情同一套约定） ---------- */

const TABS = [
  { id: 'forge', label: '炼器' },
  { id: 'bag', label: '背包' },
] as const;

type EquipmentTab = (typeof TABS)[number]['id'];

const tab = ref<EquipmentTab>('forge');
const tabButtons = ref<Record<string, HTMLButtonElement | null>>({});

function tabButtonId(id: EquipmentTab): string {
  return `equipment-tab-${id}`;
}

function tabPanelId(id: EquipmentTab): string {
  return `equipment-panel-${id}`;
}

function setTabButton(id: EquipmentTab, element: Element | null): void {
  if (element instanceof HTMLButtonElement) tabButtons.value[id] = element;
  else delete tabButtons.value[id];
}

/** 方向键 / Home / End 在两个标签页之间移动（自动激活，焦点跟着走）。 */
function onTabKeydown(event: KeyboardEvent, current: EquipmentTab): void {
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

/* ---------- 台账：余额、背包容量（名字与数值都取自服务端） ---------- */

function resourceName(resourceId: string): string {
  return props.state.resources.find((resource) => resource.id === resourceId)?.name ?? resourceId;
}

/** 资源余额（最小单位）；查不到时按 0 处理 —— 按钮自然不可点，不会伪造余额。 */
function resourceBalance(resourceId: string): number {
  return Number(props.state.resources.find((resource) => resource.id === resourceId)?.balance ?? 0);
}

const bagCount = computed(() => props.equipment.bagCount);
const bagCapacity = computed(() => props.equipment.bagCapacity);
/** 背包满 = 不能再炼器（分解 / 卸下也一并被服务端拦住）。 */
const bagFull = computed(() => bagCount.value >= bagCapacity.value);
const oreName = computed(() => resourceName('ore'));

/* ---------- 炼器 ---------- */

/** 只有法器有主属性候选（身法 / 幸运）；其余部位由服务端按规则固定。 */
function toMainAttr(id: string): EquipmentMainAttr | null {
  return id === 'speed' || id === 'luck' ? id : null;
}

const forgeSlot = ref<EquipmentSlotId>(props.equipment.slots[0]?.id ?? 'weapon');
const forgeMainAttr = ref<EquipmentMainAttr | null>(
  toMainAttr(props.equipment.slots[0]?.mainAttrChoices[0]?.id ?? ''),
);

const currentSlot = computed<EquipmentSlotView | null>(
  () => props.equipment.slots.find((slot) => slot.id === forgeSlot.value) ?? null,
);

/**
 * 换部位时把主属性对齐到该部位的候选（法器默认第一个候选；其他部位清空）。
 * 只在部位 id 变化时触发 —— 炼器 / 分解后装备视图被换成新对象，不会因此重置玩家的选择。
 */
watch(forgeSlot, (slotId) => {
  const slot = props.equipment.slots.find((item) => item.id === slotId) ?? null;
  const first = slot?.mainAttrChoices[0];
  forgeMainAttr.value = first === undefined ? null : toMainAttr(first.id);
});

function selectSlot(slot: EquipmentSlotView): void {
  if (props.busy) return;
  forgeSlot.value = slot.id;
}

/** 单次消耗（最小单位 → 展示单位）。 */
const forgeCostText = computed(() =>
  Object.entries(props.equipment.forgeCost)
    .map(([resourceId, amount]) => `${resourceName(resourceId)} ${formatAmount(amount)}`)
    .join(' · '),
);

/** 按当前余额还差哪几样（只用于提前置灰；最终裁决在服务端）。 */
const forgeMissing = computed(() =>
  Object.entries(props.equipment.forgeCost)
    .filter(([resourceId, amount]) => resourceBalance(resourceId) < Number(amount))
    .map(([resourceId]) => resourceName(resourceId)),
);

const forgeHint = computed<string | null>(() => {
  if (!props.equipment.unlocked) {
    return props.equipment.blockedReason ?? '炼器尚未开启，需要宗门 2 级';
  }
  if (bagFull.value) {
    return `背包已满（${String(bagCount.value)}/${String(bagCapacity.value)}），请先分解`;
  }
  if (forgeMissing.value.length > 0) {
    return `${forgeMissing.value.join('、')}不足`;
  }
  return null;
});

const canForge = computed(
  () => props.equipment.unlocked && !bagFull.value && forgeMissing.value.length === 0 && !props.busy,
);

function onForge(): void {
  if (!canForge.value) return;
  const slot = currentSlot.value;
  // 有主属性候选（法器）时必须选一个；其余部位不能带 mainAttr（服务端严格校验）。
  const hasChoices = (slot?.mainAttrChoices.length ?? 0) > 0;
  emit('forge', forgeSlot.value, hasChoices ? (forgeMainAttr.value ?? undefined) : undefined);
}

/* ---------- 背包：筛选 / 多选 / 分解 ---------- */

const SLOT_ALL = 'all';

const slotFilter = ref<typeof SLOT_ALL | EquipmentSlotId>(SLOT_ALL);
const qualityFilter = ref<string>(SLOT_ALL);

const slotOptions = computed<{ id: typeof SLOT_ALL | EquipmentSlotId; name: string }[]>(() => [
  { id: SLOT_ALL, name: '全部' },
  ...props.equipment.slots.map((slot) => ({ id: slot.id, name: slot.name })),
]);

/**
 * 品质筛选项只列**当前装备里出现过**的品质：品质名与颜色都来自服务端视图，
 * 前端不硬编码品质表；某一品质没有装备时就不显示这个 chip。
 */
const qualityOptions = computed<{ id: string; name: string }[]>(() => {
  const names = new Map<string, string>();
  for (const item of props.equipment.items) {
    if (!names.has(item.quality)) names.set(item.quality, item.qualityName);
  }
  return [...names].map(([id, name]) => ({ id, name }));
});

/** 被筛掉的品质会在切换筛选条件后失效，这里同步回「全部」。 */
watch(qualityOptions, (options) => {
  if (qualityFilter.value !== SLOT_ALL && !options.some((option) => option.id === qualityFilter.value)) {
    qualityFilter.value = SLOT_ALL;
  }
});

const visibleItems = computed<EquipmentItemView[]>(() =>
  props.equipment.items.filter(
    (item) =>
      (slotFilter.value === SLOT_ALL || item.slot === slotFilter.value) &&
      (qualityFilter.value === SLOT_ALL || item.quality === qualityFilter.value),
  ),
);

/** 可分解 = 在背包里（穿在身上的不占背包，也不能分解）。 */
function isSalvageable(item: EquipmentItemView): boolean {
  return item.discipleId === null;
}

const selectedIds = ref<string[]>([]);

/** 选中集合始终与最新视图对齐：已被穿上 / 已分解的装备自动从选择里剔除。 */
const selectedItems = computed<EquipmentItemView[]>(() =>
  props.equipment.items.filter((item) => isSalvageable(item) && selectedIds.value.includes(item.id)),
);

const salvageOreTotal = computed(() =>
  selectedItems.value.reduce(
    (sum, item) => sum + (props.equipment.salvageOre[item.quality] ?? 0),
    0,
  ),
);

const salvageNames = computed(() => selectedItems.value.map((item) => item.name).join('、'));

function isSelected(item: EquipmentItemView): boolean {
  return selectedIds.value.includes(item.id);
}

function toggleSelect(item: EquipmentItemView): void {
  if (props.busy || !isSalvageable(item)) return;
  selectedIds.value = isSelected(item)
    ? selectedIds.value.filter((id) => id !== item.id)
    : [...selectedIds.value, item.id];
}

function clearSelection(): void {
  selectedIds.value = [];
  confirmingSalvage.value = false;
}

/** 二次确认（分解不可撤销）：确认后才提交。 */
const confirmingSalvage = ref(false);

function askSalvage(): void {
  if (props.busy || selectedItems.value.length === 0) return;
  confirmingSalvage.value = true;
}

function confirmSalvage(): void {
  if (props.busy || selectedItems.value.length === 0) return;
  const ids = selectedItems.value.map((item) => item.id);
  selectedIds.value = [];
  confirmingSalvage.value = false;
  emit('salvage', ids);
}
</script>

<template>
  <section class="equipment-panel" aria-labelledby="equipment-title">
    <header class="section-heading panel-heading compact-heading">
      <div>
        <p class="eyebrow">铸剑炉 · 兵甲库</p>
        <h2 id="equipment-title">炼器</h2>
      </div>
      <span class="count-badge">背包 {{ bagCount }}/{{ bagCapacity }}</span>
    </header>

    <div class="shop-tabs equipment-tabs" role="tablist" aria-label="炼器与背包">
      <button
        v-for="item in TABS"
        :id="tabButtonId(item.id)"
        :key="item.id"
        :ref="(element) => setTabButton(item.id, element as Element | null)"
        class="shop-tab"
        type="button"
        role="tab"
        :aria-selected="tab === item.id"
        :aria-controls="tabPanelId(item.id)"
        :tabindex="tab === item.id ? 0 : -1"
        :disabled="busy"
        @click="tab = item.id"
        @keydown="onTabKeydown($event, item.id)"
      >
        {{ item.label }}
      </button>
    </div>

    <div class="equipment-panels">
      <!-- ---------- 炼器 ---------- -->
      <div
        v-show="tab === 'forge'"
        :id="tabPanelId('forge')"
        class="equipment-panel-body"
        role="tabpanel"
        :aria-labelledby="tabButtonId('forge')"
        tabindex="0"
      >
        <template v-if="!equipment.unlocked">
          <div class="empty-state equipment-locked">
            <span aria-hidden="true">器</span>
            <strong>炼器尚未开启</strong>
            <p>需要：宗门 2 级</p>
            <p class="blocked-hint">{{ equipment.blockedReason ?? '炼器尚未开启，需要宗门 2 级' }}</p>
          </div>
        </template>

        <template v-else>
          <p class="eyebrow">选择部位</p>
          <div class="equipment-choices" role="group" aria-label="炼器部位">
            <button
              v-for="slot in equipment.slots"
              :key="slot.id"
              class="equipment-choice"
              :class="{ 'is-selected': forgeSlot === slot.id }"
              type="button"
              :disabled="busy"
              :aria-pressed="forgeSlot === slot.id"
              @click="selectSlot(slot)"
            >
              <strong>{{ slot.name }}</strong>
            </button>
          </div>

          <template v-if="(currentSlot?.mainAttrChoices.length ?? 0) > 0">
            <p class="eyebrow equipment-row-label">法器主属性</p>
            <div class="equipment-choices" role="group" aria-label="法器主属性">
              <button
                v-for="choice in currentSlot?.mainAttrChoices ?? []"
                :key="choice.id"
                class="equipment-choice"
                :class="{ 'is-selected': forgeMainAttr === choice.id }"
                type="button"
                :disabled="busy"
                :aria-pressed="forgeMainAttr === choice.id"
                @click="forgeMainAttr = toMainAttr(choice.id)"
              >
                <strong>{{ choice.name }}</strong>
              </button>
            </div>
          </template>

          <dl class="equipment-facts">
            <div>
              <dt>品质</dt>
              <dd>{{ equipment.forgeQualityName }}</dd>
            </div>
            <div>
              <dt>单次消耗</dt>
              <dd>{{ forgeCostText }}</dd>
            </div>
            <div>
              <dt>现有{{ oreName }}</dt>
              <dd>{{ formatAmount(resourceBalance('ore')) }}</dd>
            </div>
            <div>
              <dt>现有灵石</dt>
              <dd>{{ formatAmount(resourceBalance('spiritStone')) }}</dd>
            </div>
          </dl>

          <p v-if="forgeHint !== null" class="blocked-hint">{{ forgeHint }}</p>

          <button
            class="action-button primary-action equipment-forge-button"
            :class="{ 'is-disabled': !canForge }"
            type="button"
            :disabled="!canForge"
            :aria-disabled="!canForge"
            @click="onForge"
          >
            <span>炼制</span>
          </button>
          <p class="disciple-detail-hint">
            一期只炼{{ equipment.forgeQualityName }}；必定成功，属性随机生成后不再变化。
          </p>
        </template>
      </div>

      <!-- ---------- 背包 ---------- -->
      <div
        v-show="tab === 'bag'"
        :id="tabPanelId('bag')"
        class="equipment-panel-body"
        role="tabpanel"
        :aria-labelledby="tabButtonId('bag')"
        tabindex="0"
      >
        <p class="equipment-bag-count">
          已用 <strong>{{ bagCount }}</strong> / {{ bagCapacity }} · 穿在身上的不占背包
        </p>

        <div class="equipment-filter-row" role="group" aria-label="按部位筛选">
          <span class="eyebrow">部位</span>
          <button
            v-for="option in slotOptions"
            :key="option.id"
            class="equipment-chip"
            :class="{ 'is-active': slotFilter === option.id }"
            type="button"
            :aria-pressed="slotFilter === option.id"
            @click="slotFilter = option.id"
          >
            {{ option.name }}
          </button>
        </div>

        <div v-if="qualityOptions.length > 0" class="equipment-filter-row" role="group" aria-label="按品质筛选">
          <span class="eyebrow">品质</span>
          <button
            class="equipment-chip"
            :class="{ 'is-active': qualityFilter === SLOT_ALL }"
            type="button"
            :aria-pressed="qualityFilter === SLOT_ALL"
            @click="qualityFilter = SLOT_ALL"
          >
            全部
          </button>
          <button
            v-for="option in qualityOptions"
            :key="option.id"
            class="equipment-chip"
            :class="{ 'is-active': qualityFilter === option.id }"
            type="button"
            :aria-pressed="qualityFilter === option.id"
            @click="qualityFilter = option.id"
          >
            {{ option.name }}
          </button>
        </div>

        <ul v-if="visibleItems.length > 0" class="equipment-list">
          <li
            v-for="item in visibleItems"
            :key="item.id"
            class="equipment-card"
            :class="{ 'is-worn': !isSalvageable(item), 'is-picked': isSelected(item) }"
            :style="{ borderColor: item.color }"
          >
            <label class="equipment-card-pick">
              <input
                type="checkbox"
                :checked="isSelected(item)"
                :disabled="busy || !isSalvageable(item)"
                :aria-label="isSalvageable(item) ? `选择分解 ${item.name}` : `${item.name} 已穿戴，不能分解`"
                @change="toggleSelect(item)"
              />
            </label>

            <div class="equipment-card-copy">
              <div class="equipment-card-title">
                <strong :style="{ color: item.color }">{{ item.name }}</strong>
                <span class="equipment-card-slot">{{ item.slotName }}</span>
              </div>
              <p class="equipment-card-attrs">
                主属性 {{ item.mainAttrName }} +{{ item.mainValue }} · 副属性 {{ item.subAttrName }} +{{ item.subValue }}
              </p>
              <p class="equipment-card-owner">
                {{ isSalvageable(item) ? '背包' : `穿在 ${item.discipleName ?? '弟子'}身上` }}
                <template v-if="isSalvageable(item)">
                  · 分解返还{{ oreName }} {{ equipment.salvageOre[item.quality] ?? 0 }}
                </template>
              </p>
            </div>
          </li>
        </ul>

        <p v-else-if="equipment.items.length === 0" class="blocked-hint">
          还没有装备：去「炼器」打造，或讨伐妖王碰运气。
        </p>
        <p v-else class="blocked-hint">没有符合条件的装备。</p>

        <div v-if="selectedItems.length > 0 || confirmingSalvage" class="equipment-salvage">
          <p class="equipment-salvage-line">
            已选 <strong>{{ selectedItems.length }}</strong> 件 · 返还{{ oreName }}
            <strong>{{ salvageOreTotal }}</strong>
          </p>

          <template v-if="!confirmingSalvage">
            <div class="equipment-salvage-actions">
              <button class="quiet-button" type="button" :disabled="busy" @click="clearSelection">清空</button>
              <button
                class="action-button primary-action"
                type="button"
                :disabled="busy"
                @click="askSalvage"
              >
                分解 {{ selectedItems.length }} 件 · 返{{ oreName }} {{ salvageOreTotal }}
              </button>
            </div>
          </template>

          <div v-else class="equipment-salvage-confirm" role="group" aria-label="确认分解">
            <p>
              将分解 <strong>{{ selectedItems.length }}</strong> 件装备，返还{{ oreName }}
              <strong>{{ salvageOreTotal }}</strong>。
            </p>
            <p class="equipment-salvage-note">明细：{{ salvageNames }}。分解不可撤销。</p>
            <div class="equipment-salvage-actions">
              <button class="upgrade-button" type="button" :disabled="busy" @click="confirmingSalvage = false">
                取消
              </button>
              <button class="action-button primary-action" type="button" :disabled="busy" @click="confirmSalvage">
                确认分解
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.equipment-panel {
  min-width: 0;
}

.equipment-tabs {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.equipment-panels {
  margin-top: 14px;
}

.equipment-panel-body {
  outline: none;
}

.equipment-panel-body:focus-visible {
  box-shadow: inset 0 0 0 1px rgba(119, 184, 154, 0.24);
}

.equipment-locked {
  margin-top: 12px;
}

.equipment-choices {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(84px, 1fr));
  gap: 8px;
  margin-top: 8px;
}

.equipment-row-label {
  margin-top: 14px;
}

.equipment-choice {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 38px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: #cbd8d0;
  background: rgba(255, 255, 255, 0.014);
  font-size: 13px;
  letter-spacing: 0.05em;
  transition: border-color 140ms ease, background-color 140ms ease, color 140ms ease;
}

.equipment-choice:not(:disabled):hover {
  border-color: rgba(119, 184, 154, 0.4);
}

.equipment-choice.is-selected {
  border-color: rgba(202, 169, 106, 0.55);
  color: var(--gold-bright, #e0cd97);
  background: rgba(202, 169, 106, 0.1);
}

.equipment-choice:focus-visible,
.equipment-chip:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgba(202, 169, 106, 0.3);
}

.equipment-choice:disabled {
  color: #63756c;
  cursor: not-allowed;
}

.equipment-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 12px;
  margin-top: 14px;
}

.equipment-facts > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid rgba(119, 184, 154, 0.12);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.014);
}

.equipment-facts dt {
  color: #7d9186;
  font-size: 11px;
  letter-spacing: 0.04em;
}

.equipment-facts dd {
  margin: 0;
  color: #dce6e0;
  font-size: 12px;
}

.equipment-forge-button {
  width: 100%;
  min-height: 42px;
  justify-content: center;
  margin-top: 12px;
}

.equipment-bag-count {
  margin: 0;
  color: #9db3a8;
  font-size: 12px;
}

.equipment-bag-count strong {
  color: var(--gold-bright, #e0cd97);
  font-weight: 500;
}

.equipment-filter-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}

.equipment-filter-row .eyebrow {
  margin-right: 2px;
}

.equipment-chip {
  padding: 5px 10px;
  border: 1px solid rgba(119, 184, 154, 0.16);
  border-radius: 3px;
  color: #9db3a8;
  background: rgba(255, 255, 255, 0.02);
  font-size: 11px;
  letter-spacing: 0.05em;
  transition: border-color 140ms ease, background-color 140ms ease, color 140ms ease;
}

.equipment-chip:not(:disabled):hover {
  border-color: rgba(202, 169, 106, 0.3);
  color: #e4ece6;
}

.equipment-chip.is-active {
  border-color: rgba(202, 169, 106, 0.46);
  color: var(--gold-bright, #e0cd97);
  background: rgba(202, 169, 106, 0.09);
}

.equipment-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 8px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}

.equipment-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.016);
}

.equipment-card.is-picked {
  background: rgba(202, 169, 106, 0.08);
}

.equipment-card.is-worn {
  opacity: 0.78;
}

.equipment-card-pick input {
  margin: 2px 0 0;
  accent-color: #caa96a;
}

.equipment-card-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.equipment-card-title strong {
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.04em;
}

.equipment-card-slot {
  color: #7d9186;
  font-size: 11px;
}

.equipment-card-attrs {
  margin: 4px 0 0;
  color: #cbd8d0;
  font-size: 12px;
}

.equipment-card-owner {
  margin: 2px 0 0;
  color: #7d9186;
  font-size: 11px;
}

.equipment-salvage {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.equipment-salvage-line {
  margin: 0;
  color: #9db3a8;
  font-size: 12px;
}

.equipment-salvage-line strong {
  color: var(--gold-bright, #e0cd97);
  font-weight: 500;
}

.equipment-salvage-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.equipment-salvage-actions .action-button {
  flex: 1 1 0;
}

.equipment-salvage-confirm {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid rgba(202, 169, 106, 0.3);
  border-radius: 4px;
  background: rgba(202, 169, 106, 0.06);
}

.equipment-salvage-confirm p {
  margin: 0;
  color: #dce6e0;
  font-size: 12px;
}

.equipment-salvage-note {
  margin-top: 4px !important;
  color: #7d9186 !important;
  font-size: 11px !important;
}
</style>
