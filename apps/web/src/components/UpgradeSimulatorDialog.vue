<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { DiscipleView, EquipmentView, SectStateView } from '../api/game';
import {
  DEFAULT_CUSTOM_QUALITY,
  INSIGHT_ATTRS,
  SIM_ATTR_NAMES,
  SLOT_IDS,
  SLOT_MAIN_CHOICES,
  defaultCustomSlot,
  defaultPlan,
  formatCostText,
  formatGainRatio,
  midSubValue,
  qualityChoices,
  simulate,
  slotNameOf,
  subAttrChoices,
  targetOptions,
  validatePlan,
  wornItemOf,
  type AttrValue,
  type CustomSlotPlan,
  type InsightAttr,
  type Row,
  type SimAttr,
  type SimInput,
  type SimPlan,
  type SlotId,
  type SlotPlan,
} from '../utils/upgradeSimulator';
import ModalShell from './ModalShell.vue';

/**
 * 提升模拟（弟子详情里的「提升模拟」按钮打开）：只渲染与收集输入。
 *
 * 所有战力、代价与校验都在 utils/upgradeSimulator.ts 里算好，这里不写任何规则。
 * 整个弹窗只读：不 emit 任何写操作，关掉弹窗方案就丢弃；「还原」回到缺省方案（当前境界、三格保持当前、悟道值 0）。
 * 输入框的非法值由 validatePlan 给出文案，计算时用夹过的值。
 */
const props = defineProps<{
  state: SectStateView;
  disciple: DiscipleView;
  /** 装备视图；null = 还没加载（三格整块禁用）。 */
  equipment: EquipmentView | null;
  /** 每秒本地平滑的修为（只用于显示）；null = 用服务端值。 */
  liveCultivation: number | null;
}>();

const emit = defineEmits<{
  close: [];
}>();

/** 三种模拟方式（顺序即展示顺序）。 */
const MODES = [
  { id: 'keep', label: '保持当前' },
  { id: 'empty', label: '空着' },
  { id: 'custom', label: '自定义一件' },
] as const;

/** 对比表里的五项属性（战力单独一行）。 */
const COMPARE_ATTRS: readonly SimAttr[] = ['attack', 'defense', 'speed', 'luck', 'physique'];

const simInput = computed<SimInput>(() => ({
  disciple: props.disciple,
  realmCatalog: props.state.realmCatalog,
  talents: props.state.talents,
  equipment: props.equipment,
  resources: props.state.resources,
  cultivation: props.liveCultivation ?? props.disciple.cultivation,
}));

/** 模拟方案只存在于弹窗里（关掉即丢弃）；计算与校验都是它的纯函数。 */
const plan = ref<SimPlan>(defaultPlan(simInput.value));
/** 装备视图晚于弹窗到达时（打开详情后还在读取），三格换成「保持当前」的真实重数。 */
watch(
  () => props.equipment,
  (next, previous) => {
    if (previous === null && next !== null) {
      plan.value = { ...plan.value, slots: defaultPlan(simInput.value).slots };
    }
  },
);
const result = computed(() => simulate(simInput.value, plan.value));
const issues = computed(() => validatePlan(simInput.value, plan.value));
const targets = computed(() => targetOptions(simInput.value));
const qualities = computed(() => qualityChoices(props.equipment));
const hasChanges = computed(() => result.value.breakdown.length > 0);
const targetKey = computed(() => `${plan.value.target.realmId}:${String(plan.value.target.stage)}`);
/** 炼器未开放（或装备视图还没加载）：三格整块禁用，只能看。 */
const equipmentReady = computed(() => props.equipment !== null && props.equipment.unlocked);
/** 整块不可用时的说明：原因用服务端给的 blockedReason（如「需要宗门 2 级」）。 */
const equipmentLockedText = computed(() => {
  if (props.equipment === null) return '炼器未开放：装备还在读取中';
  return `炼器未开放：${props.equipment.blockedReason ?? '暂不可用'}`;
});

/** 输入框文本 → 数字：空串按 0，其余交给 Number（非法的由校验文案提示）。 */
function toNumber(text: string): number {
  return text.trim() === '' ? 0 : Number(text);
}

/** 数字框获得焦点时整段选中，直接敲数字就能替换原来的值。 */
function selectAll(event: FocusEvent): void {
  (event.target as HTMLInputElement).select();
}

function attrText(value: AttrValue): string {
  return value.gear > 0 ? `${String(value.base)} (+${String(value.gear)})` : String(value.base);
}

function refineText(level: number): string {
  return level === 0 ? '未祭炼' : `${String(level)} 重`;
}

/** 祭炼下拉框：从 from 重起到十二重。 */
function refineOptions(from: number): number[] {
  return Array.from({ length: 13 - from }, (_, index) => from + index);
}

function wornOf(slot: SlotId) {
  return wornItemOf(props.equipment, props.disciple.id, slot);
}

function slotNowText(slot: SlotId): string {
  const worn = wornOf(slot);
  if (worn === null) return '现在：空着';
  return `现在：${worn.name}（${refineText(worn.refineLevel)}）`;
}

/** 保持当前时祭炼的下限：身上那件现在的重数（没穿则 0）。 */
function keepFloorOf(slot: SlotId): number {
  return wornOf(slot)?.refineLevel ?? 0;
}

function keepLevelOf(slot: SlotId): number {
  const slotPlan = plan.value.slots[slot];
  return slotPlan.mode === 'keep' ? slotPlan.refineLevel : keepFloorOf(slot);
}

function customOf(slot: SlotId): CustomSlotPlan | null {
  const slotPlan = plan.value.slots[slot];
  return slotPlan.mode === 'custom' ? slotPlan : null;
}

/** 自定义时副属性的候选：主属性之外的四项。 */
function subChoicesOf(slot: SlotId): SimAttr[] {
  return subAttrChoices(customOf(slot)?.mainAttr ?? SLOT_MAIN_CHOICES[slot][0]);
}

/** 当前品质的副属性区间（输入框的 min / max 与提示）。 */
function rangeOf(slot: SlotId): { min: number; max: number } {
  const quality = qualities.value.find((item) => item.id === customOf(slot)?.quality);
  return quality === undefined ? { min: 0, max: 0 } : { min: quality.subMin, max: quality.subMax };
}

function reset(): void {
  plan.value = defaultPlan(simInput.value);
}

function setTarget(event: Event): void {
  const option = targets.value.find((item) => item.key === (event.target as HTMLSelectElement).value);
  if (option === undefined) return;
  plan.value = { ...plan.value, target: { realmId: option.realmId, stage: option.stage } };
}

function setSlot(slot: SlotId, next: SlotPlan): void {
  plan.value = { ...plan.value, slots: { ...plan.value.slots, [slot]: next } };
}

function chooseMode(slot: SlotId, mode: 'keep' | 'empty' | 'custom'): void {
  if (!equipmentReady.value) return;
  if (mode === 'keep') {
    setSlot(slot, defaultPlan(simInput.value).slots[slot]);
    return;
  }
  if (mode === 'empty') {
    setSlot(slot, { mode: 'empty' });
    return;
  }
  // 切到自定义：已经是自定义的保留原来的选择，否则给缺省值（凡品、部位的第一项主属性）。
  const current = plan.value.slots[slot];
  setSlot(slot, current.mode === 'custom' ? current : defaultCustomSlot(slot, DEFAULT_CUSTOM_QUALITY, props.equipment));
}

function setKeepLevel(slot: SlotId, event: Event): void {
  setSlot(slot, { mode: 'keep', refineLevel: Number((event.target as HTMLSelectElement).value) });
}

function patchCustom(slot: SlotId, patch: Partial<CustomSlotPlan>): void {
  const current = customOf(slot);
  if (current === null) return;
  setSlot(slot, { ...current, ...patch });
}

function onQualityChange(slot: SlotId, event: Event): void {
  const quality = (event.target as HTMLSelectElement).value;
  // 换品质时副属性数值跟着回到新区间的中间值（与服务端的区间一致）。
  patchCustom(slot, { quality, subValue: midSubValue(props.equipment, quality) });
}

function onMainChange(slot: SlotId, event: Event): void {
  const mainAttr = SLOT_MAIN_CHOICES[slot].find((attr) => attr === (event.target as HTMLSelectElement).value);
  if (mainAttr === undefined) return;
  const current = customOf(slot);
  // 主属性换成了副属性同一项时，副属性自动换成另一项。
  const subAttr = current !== null && current.subAttr !== mainAttr ? current.subAttr : subAttrChoices(mainAttr)[0];
  patchCustom(slot, { mainAttr, subAttr });
}

function onSubChange(slot: SlotId, event: Event): void {
  const subAttr = subChoicesOf(slot).find((attr) => attr === (event.target as HTMLSelectElement).value);
  if (subAttr === undefined) return;
  patchCustom(slot, { subAttr });
}

function onSubValueInput(slot: SlotId, event: Event): void {
  patchCustom(slot, { subValue: toNumber((event.target as HTMLInputElement).value) });
}

function onCustomRefineChange(slot: SlotId, event: Event): void {
  patchCustom(slot, { refineLevel: Number((event.target as HTMLSelectElement).value) });
}

function setInsight(attr: InsightAttr, event: Event): void {
  const value = toNumber((event.target as HTMLInputElement).value);
  plan.value = { ...plan.value, insight: { ...plan.value.insight, [attr]: value } };
}

/** 一行拆解的代价与说明：资源代价在前，其余说明逐条列出；什么都没有就写「无」。 */
function costLinesOf(row: Row): string[] {
  const lines: string[] = [];
  const resources = formatCostText(row.cost, props.state.resources);
  if (resources !== '') lines.push(resources);
  lines.push(...row.notes);
  return lines.length > 0 ? lines : ['无'];
}
</script>

<template>
  <ModalShell label="提升模拟" @close="emit('close')">
    <section class="sim" aria-labelledby="sim-title">
      <header class="section-heading panel-heading compact-heading sim-head">
        <div>
          <p class="eyebrow">提升模拟</p>
          <h2 id="sim-title">{{ disciple.name }}</h2>
        </div>
        <button class="quiet-button sim-reset" type="button" @click="reset">还原</button>
      </header>
      <p class="sim-note">只是算一算，不会改动任何数据；关掉弹窗就丢弃。</p>

      <h3 class="sim-subtitle">调整</h3>

      <div class="sim-field">
        <label class="field-label" for="sim-target">目标境界</label>
        <span class="disciple-select">
          <select id="sim-target" class="disciple-input" :value="targetKey" @change="setTarget">
            <option v-for="option in targets" :key="option.key" :value="option.key">{{ option.label }}</option>
          </select>
        </span>
        <p class="sim-note">
          当前 {{ result.current.stageName }}。突破要攒够修为，中间每层的门槛都算在内；突破成功后修为清零。
        </p>
      </div>

      <h4 class="sim-subhead">装备</h4>
      <p v-if="!equipmentReady" class="sim-locked">{{ equipmentLockedText }}</p>

      <section
        v-for="slot in SLOT_IDS"
        :key="slot"
        class="sim-slot"
        :class="{ 'is-disabled': !equipmentReady }"
        :aria-labelledby="`sim-slot-${slot}`"
      >
        <div class="sim-slot-head">
          <h5 :id="`sim-slot-${slot}`">{{ slotNameOf(equipment, slot) }}</h5>
          <span class="sim-slot-now">{{ slotNowText(slot) }}</span>
        </div>

        <div class="sim-modes" role="radiogroup" :aria-label="`${slotNameOf(equipment, slot)}的模拟方式`">
          <label
            v-for="mode in MODES"
            :key="mode.id"
            class="sim-mode"
            :class="{ 'is-selected': plan.slots[slot].mode === mode.id }"
          >
            <input
              type="radio"
              :name="`sim-mode-${slot}`"
              :value="mode.id"
              :checked="plan.slots[slot].mode === mode.id"
              :disabled="!equipmentReady"
              @change="chooseMode(slot, mode.id)"
            />
            <span>{{ mode.label }}</span>
          </label>
        </div>

        <!-- 保持当前：只能往上调祭炼；没穿装备时就是空着。 -->
        <div v-if="plan.slots[slot].mode === 'keep'" class="sim-field">
          <template v-if="wornOf(slot) !== null">
            <label class="field-label" :for="`sim-keep-${slot}`">祭炼到</label>
            <span class="disciple-select">
              <select
                :id="`sim-keep-${slot}`"
                class="disciple-input"
                :value="String(keepLevelOf(slot))"
                :disabled="!equipmentReady"
                @change="setKeepLevel(slot, $event)"
              >
                <option v-for="level in refineOptions(keepFloorOf(slot))" :key="level" :value="String(level)">
                  {{ refineText(level) }}
                </option>
              </select>
            </span>
          </template>
          <p v-else class="sim-note">没穿装备，保持当前就是空着。</p>
          <small v-if="issues.slots[slot]?.refine" class="sim-error">{{ issues.slots[slot]?.refine }}</small>
        </div>

        <!-- 自定义一件：品质、主 / 副属性、副属性数值、祭炼重数。 -->
        <div v-else-if="customOf(slot) !== null" class="sim-grid">
          <label class="sim-cell">
            <span class="field-label">品质</span>
            <span class="disciple-select">
              <select
                class="disciple-input"
                :value="customOf(slot)?.quality ?? ''"
                :disabled="!equipmentReady"
                @change="onQualityChange(slot, $event)"
              >
                <option v-for="quality in qualities" :key="quality.id" :value="quality.id">
                  {{ quality.name }}{{ quality.unlocked ? '' : '（炼器坊等级不够）' }}
                </option>
              </select>
            </span>
          </label>

          <div class="sim-cell">
            <span class="field-label">主属性</span>
            <span v-if="SLOT_MAIN_CHOICES[slot].length === 1" class="sim-fixed">
              {{ SIM_ATTR_NAMES[SLOT_MAIN_CHOICES[slot][0]] }}（固定）
            </span>
            <span v-else class="disciple-select">
              <select
                class="disciple-input"
                :value="customOf(slot)?.mainAttr ?? ''"
                :disabled="!equipmentReady"
                @change="onMainChange(slot, $event)"
              >
                <option v-for="attr in SLOT_MAIN_CHOICES[slot]" :key="attr" :value="attr">
                  {{ SIM_ATTR_NAMES[attr] }}
                </option>
              </select>
            </span>
            <small v-if="issues.slots[slot]?.main" class="sim-error">{{ issues.slots[slot]?.main }}</small>
          </div>

          <label class="sim-cell">
            <span class="field-label">副属性</span>
            <span class="disciple-select">
              <select
                class="disciple-input"
                :value="customOf(slot)?.subAttr ?? ''"
                :disabled="!equipmentReady"
                @change="onSubChange(slot, $event)"
              >
                <option v-for="attr in subChoicesOf(slot)" :key="attr" :value="attr">
                  {{ SIM_ATTR_NAMES[attr] }}
                </option>
              </select>
            </span>
            <small v-if="issues.slots[slot]?.sub" class="sim-error">{{ issues.slots[slot]?.sub }}</small>
          </label>

          <label class="sim-cell">
            <span class="field-label">副属性数值（{{ rangeOf(slot).min }} ~ {{ rangeOf(slot).max }}）</span>
            <input
              class="disciple-input"
              type="number"
              inputmode="numeric"
              step="1"
              :min="rangeOf(slot).min"
              :max="rangeOf(slot).max"
              :value="String(customOf(slot)?.subValue ?? 0)"
              :disabled="!equipmentReady"
              @focus="selectAll"
              @input="onSubValueInput(slot, $event)"
            />
            <small v-if="issues.slots[slot]?.subValue" class="sim-error">{{ issues.slots[slot]?.subValue }}</small>
          </label>

          <label class="sim-cell">
            <span class="field-label">祭炼</span>
            <span class="disciple-select">
              <select
                class="disciple-input"
                :value="String(customOf(slot)?.refineLevel ?? 0)"
                :disabled="!equipmentReady"
                @change="onCustomRefineChange(slot, $event)"
              >
                <option v-for="level in refineOptions(0)" :key="level" :value="String(level)">
                  {{ refineText(level) }}
                </option>
              </select>
            </span>
            <small v-if="issues.slots[slot]?.refine" class="sim-error">{{ issues.slots[slot]?.refine }}</small>
          </label>
        </div>
      </section>

      <section class="sim-insight" aria-labelledby="sim-insight-title">
        <h4 id="sim-insight-title" class="sim-subhead">悟道值</h4>
        <p class="sim-note">
          手上有 {{ disciple.daoInsight }} 点，还能累计分配 {{ disciple.daoInsightRemaining }} 点；加完的基础属性不超过 100。
          超出手上的部分会写在代价里。
        </p>
        <div class="sim-insight-grid">
          <label v-for="attr in INSIGHT_ATTRS" :key="attr" class="sim-cell">
            <span class="field-label">{{ SIM_ATTR_NAMES[attr] }}（基础 {{ disciple[attr] }}）</span>
            <input
              class="disciple-input"
              type="number"
              inputmode="numeric"
              min="0"
              step="1"
              :value="String(plan.insight[attr])"
              @focus="selectAll"
              @input="setInsight(attr, $event)"
            />
            <small v-if="issues.insight[attr]" class="sim-error">{{ issues.insight[attr] }}</small>
          </label>
        </div>
        <small v-if="issues.insight.total" class="sim-error">{{ issues.insight.total }}</small>
      </section>

      <h3 class="sim-subtitle">对比</h3>
      <table class="sim-compare">
        <thead>
          <tr>
            <th scope="col">项目</th>
            <th scope="col">当前</th>
            <th scope="col">模拟</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">境界</th>
            <td>{{ result.current.stageName }}</td>
            <td>{{ result.simulated.stageName }}</td>
          </tr>
          <tr v-for="attr in COMPARE_ATTRS" :key="attr">
            <th scope="row">{{ SIM_ATTR_NAMES[attr] }}</th>
            <td>{{ attrText(result.current.attrs[attr]) }}</td>
            <td>{{ attrText(result.simulated.attrs[attr]) }}</td>
          </tr>
          <tr class="sim-power-row">
            <th scope="row">战力</th>
            <td>{{ result.current.combatPower }}</td>
            <td>
              {{ result.simulated.combatPower }}
              <span class="sim-gain" :class="{ 'is-down': result.total.gainRatio < 0 }">
                {{ formatGainRatio(result.total.gainRatio) }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <h3 class="sim-subtitle">单项拆解</h3>
      <p v-if="!hasChanges" class="sim-empty">调整上面的选项看看能提升多少</p>
      <ul v-else class="sim-rows">
        <li v-for="row in result.breakdown" :key="row.id" class="sim-row" :class="{ 'is-best': row.best }">
          <div class="sim-row-head">
            <strong class="sim-row-label">{{ row.label }}</strong>
            <span class="sim-gain" :class="{ 'is-down': row.gainRatio < 0 }">{{ formatGainRatio(row.gainRatio) }}</span>
            <span v-if="row.best" class="sim-flag">提升最大</span>
          </div>
          <ul class="sim-costs">
            <li v-for="(line, index) in costLinesOf(row)" :key="index">{{ line }}</li>
          </ul>
        </li>
        <li class="sim-row is-total">
          <div class="sim-row-head">
            <strong class="sim-row-label">{{ result.total.label }}</strong>
            <span class="sim-gain" :class="{ 'is-down': result.total.gainRatio < 0 }">
              {{ formatGainRatio(result.total.gainRatio) }}
            </span>
          </div>
          <ul class="sim-costs">
            <li v-for="(line, index) in costLinesOf(result.total)" :key="index">{{ line }}</li>
          </ul>
          <p class="sim-note">各项相乘，所以总增幅不等于各项相加。</p>
        </li>
      </ul>
    </section>
  </ModalShell>
</template>

<style scoped>
.sim {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}

.sim-head {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.sim-head h2 {
  overflow-wrap: anywhere;
}

.sim-reset {
  min-height: 36px;
  flex: 0 0 auto;
}

.sim-note {
  margin: 0;
  color: #657970;
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.sim-subtitle,
.sim-subhead {
  margin: 8px 0 0;
  color: var(--gold);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.12em;
}

.sim-subhead {
  margin-top: 0;
}

.sim-field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}

.sim-field .disciple-select {
  min-width: 0;
}

.sim-slot {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 5px;
}

.sim-slot.is-disabled {
  opacity: 0.6;
}

.sim-slot-head {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 10px;
}

.sim-slot-head h5 {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
}

.sim-locked {
  margin: 0;
  color: var(--gold-bright);
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.sim-slot-now {
  min-width: 0;
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.sim-modes {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 6px;
}

.sim-mode {
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
}

.sim-mode.is-selected {
  border-color: rgba(234, 209, 154, 0.6);
  color: var(--gold-bright);
  background: rgba(202, 169, 106, 0.1);
}

.sim-mode input {
  margin: 0;
  accent-color: var(--gold);
}

/* 手机宽度下选项一项一行竖排（360px 不横向溢出）；弹窗够宽时再分两列。 */
.sim-grid,
.sim-insight-grid {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}

@media (min-width: 560px) {
  .sim-grid,
  .sim-insight-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.sim-cell {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.sim-cell .disciple-select {
  min-width: 0;
}

.sim-cell .disciple-input {
  width: 100%;
}

.sim-fixed {
  display: flex;
  min-height: 36px;
  align-items: center;
  font-size: 13px;
}

.sim-error {
  color: var(--red-bright);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.sim-compare {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 13px;
}

.sim-compare th,
.sim-compare td {
  padding: 6px 4px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  overflow-wrap: anywhere;
}

.sim-compare thead th {
  color: var(--muted);
  font-size: 12px;
  font-weight: 400;
}

.sim-compare tbody th {
  width: 30%;
  color: #aebeb5;
  font-weight: 400;
}

.sim-power-row td {
  color: var(--gold-bright);
  font-weight: 600;
}

.sim-gain {
  margin-left: 6px;
  color: var(--jade-bright);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.sim-gain.is-down {
  color: var(--red-bright);
}

.sim-rows {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.sim-row {
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 5px;
}

.sim-row.is-best {
  border-color: rgba(234, 209, 154, 0.6);
}

.sim-row.is-total {
  border-style: dashed;
}

.sim-row-head {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
}

.sim-row-label {
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  overflow-wrap: anywhere;
}

.sim-flag {
  padding: 1px 6px;
  border-radius: 3px;
  color: var(--gold-bright);
  background: rgba(202, 169, 106, 0.14);
  font-size: 11px;
}

.sim-costs {
  margin: 4px 0 0;
  padding: 0 0 0 14px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.sim-empty {
  margin: 0;
  padding: 14px 10px;
  border: 1px dashed var(--line);
  border-radius: 5px;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}
</style>
