<script setup lang="ts">
import { computed, ref } from 'vue';

import type { EquipmentItemView, EquipmentView, SectStateView } from '../api/game';
import ModalShell from './ModalShell.vue';
import RefineGuideDialog from './RefineGuideDialog.vue';
import RefineTag, { REFINE_LEVEL_NAMES } from './RefineTag.vue';

/**
 * 祭炼堂（首页「祭炼」卡片，弹窗内容，外壳由 SectScreen 用 ModalShell 提供）。
 *
 * 两个页签：
 * - 弟子身上：只列穿着装备的弟子（战力从高到低）；点一名弟子，叠出二级弹窗列他身上的装备；
 * - 背包：直接列装备，祭炼重数高的在前。
 * 每件装备只显示下一重的基础成功率（取自服务端的 refine.next）；点「祭炼」只 emit，
 * 由上层再叠出祭炼弹窗（RefineDialog），请求与刷新都在 SectScreen。
 */
const props = defineProps<{
  state: SectStateView;
  equipment: EquipmentView;
  busy: boolean;
}>();

const emit = defineEmits<{
  refine: [equipmentId: string];
}>();

/** 「说明」：叠出概率与花费表。 */
const showGuide = ref(false);

type Tab = 'worn' | 'bag';
const tab = ref<Tab>('worn');

const wornItems = computed(() => props.equipment.items.filter((item) => item.discipleId !== null));
const bagItems = computed(() => props.equipment.items.filter((item) => item.discipleId === null));

/** 弟子身上：按弟子分组，弟子按战力从高到低，组内按部位顺序（兵器 → 护甲 → 法器）。 */
const wornGroups = computed(() => {
  const slotOrder = new Map(props.equipment.slots.map((slot, index) => [slot.id, index]));
  const byDisciple = new Map<string, EquipmentItemView[]>();
  for (const item of wornItems.value) {
    if (item.discipleId === null) continue;
    byDisciple.set(item.discipleId, [...(byDisciple.get(item.discipleId) ?? []), item]);
  }
  return props.state.disciples
    .filter((disciple) => byDisciple.has(disciple.id))
    .sort((a, b) => b.combatPower - a.combatPower)
    .map((disciple) => ({
      id: disciple.id,
      name: disciple.name,
      stage: `${disciple.realmName} · ${disciple.stageName}`,
      power: disciple.combatPower,
      items: [...(byDisciple.get(disciple.id) ?? [])].sort(
        (a, b) => (slotOrder.get(a.slot) ?? 0) - (slotOrder.get(b.slot) ?? 0),
      ),
    }));
});

/** 弟子列表里每人一行的装备概况：各部位的重数（没穿的部位写「—」）。 */
function slotSummary(items: readonly EquipmentItemView[]): string {
  return props.equipment.slots
    .map((slot) => {
      const item = items.find((entry) => entry.slot === slot.id);
      if (item === undefined) return `${slot.name} —`;
      return `${slot.name} ${item.refineLevel > 0 ? (REFINE_LEVEL_NAMES[item.refineLevel] ?? '') : '未祭炼'}`;
    })
    .join(' · ');
}

/** 选中的弟子（二级弹窗）；他身上的装备被卸光或人离宗时，弹窗自动收起。 */
const pickedDiscipleId = ref<string | null>(null);
const pickedGroup = computed(() => wornGroups.value.find((group) => group.id === pickedDiscipleId.value) ?? null);

/** 背包：祭炼重数高的在前；同重数保持服务端顺序（新的在前，sort 是稳定排序）。 */
const bagSorted = computed(() => [...bagItems.value].sort((a, b) => b.refineLevel - a.refineLevel));

function nextText(item: EquipmentItemView): string {
  const next = item.refine.next;
  if (next === null) return '已至十二重圆满';
  return `冲击${REFINE_LEVEL_NAMES[next.level] ?? ''} · 成功率 ${String(next.successBp / 100)}%`;
}
</script>

<template>
  <section class="refine-hall" aria-labelledby="refine-hall-title">
    <header class="section-heading panel-heading compact-heading">
      <div>
        <p class="eyebrow">宗门</p>
        <h2 id="refine-hall-title">祭炼</h2>
      </div>
      <div class="refine-hall-head-actions">
        <button class="quiet-button refine-hall-guide" type="button" @click="showGuide = true">说明</button>
        <span class="count-badge">{{ equipment.items.length }} 件装备</span>
      </div>
    </header>

    <p v-if="!equipment.unlocked" class="blocked-hint">{{ equipment.blockedReason ?? '宗门 2 级开放祭炼。' }}</p>

    <template v-else>
      <p class="refine-hall-rules">
        一次冲一重，最高十二重；失败只耗材料，不降重、不损坏装备。五重、十二重副属性提升，九重起通灵，每重战力 +1%。
      </p>

      <div class="refine-hall-tabs" role="tablist" aria-label="装备来源">
        <button
          class="refine-hall-tab"
          :class="{ 'is-active': tab === 'worn' }"
          type="button"
          role="tab"
          :aria-selected="tab === 'worn'"
          @click="tab = 'worn'"
        >
          弟子身上（{{ wornGroups.length }} 人）
        </button>
        <button
          class="refine-hall-tab"
          :class="{ 'is-active': tab === 'bag' }"
          type="button"
          role="tab"
          :aria-selected="tab === 'bag'"
          @click="tab = 'bag'"
        >
          背包（{{ bagItems.length }}）
        </button>
      </div>

      <!-- 弟子身上：先选弟子（点一行叠出他的装备），不在这里摊开所有装备 -->
      <template v-if="tab === 'worn'">
        <p v-if="wornGroups.length === 0" class="blocked-hint">还没有弟子穿着装备：在弟子详情的「装备」页给弟子穿上。</p>
        <ul v-else class="refine-hall-list">
          <li v-for="group in wornGroups" :key="group.id">
            <button class="refine-hall-disciple" type="button" @click="pickedDiscipleId = group.id">
              <span class="refine-hall-disciple-copy">
                <span class="refine-hall-owner">
                  <strong>{{ group.name }}</strong>
                  <span>{{ group.stage }} · 战力 {{ group.power }}</span>
                </span>
                <span class="refine-hall-summary">{{ slotSummary(group.items) }}</span>
              </span>
              <span class="refine-hall-arrow" aria-hidden="true">›</span>
            </button>
          </li>
        </ul>
      </template>

      <!-- 背包：重数高的在前 -->
      <template v-else>
        <p v-if="bagSorted.length === 0" class="blocked-hint">背包里没有装备：去「炼器」打造，或讨伐妖王碰运气。</p>
        <ul v-else class="refine-hall-list">
          <li v-for="item in bagSorted" :key="item.id" class="refine-hall-item" :style="{ borderColor: item.color }">
            <div class="refine-hall-copy">
              <p class="refine-hall-name">
                <strong :style="{ color: item.color }">{{ item.name }}</strong>
                <RefineTag :level="item.refineLevel" />
                <span class="refine-hall-slot">{{ item.slotName }}</span>
              </p>
              <p class="refine-hall-attrs">
                {{ item.mainAttrName }} +{{ item.mainValue }} · {{ item.subAttrName }} +{{ item.subValue }}
              </p>
              <p class="refine-hall-next">{{ nextText(item) }}</p>
            </div>
            <button
              class="upgrade-button refine-hall-button"
              type="button"
              :disabled="busy || item.refine.next === null"
              @click="emit('refine', item.id)"
            >
              祭炼
            </button>
          </li>
        </ul>
      </template>
    </template>

    <RefineGuideDialog
      v-if="showGuide"
      :guide="equipment.refineGuide"
      :resources="state.resources"
      @close="showGuide = false"
    />

    <!-- 二级弹窗：选中弟子身上的装备（Esc / 点遮罩只关这一层；点「祭炼」再叠出祭炼弹窗）。 -->
    <ModalShell v-if="pickedGroup" narrow :label="`祭炼 · ${pickedGroup.name}的装备`" @close="pickedDiscipleId = null">
      <section class="refine-hall" aria-labelledby="refine-hall-picked-title">
        <header class="section-heading panel-heading compact-heading">
          <div>
            <p class="eyebrow">祭炼 · 选择装备</p>
            <h2 id="refine-hall-picked-title">{{ pickedGroup.name }}</h2>
          </div>
        </header>
        <p class="refine-hall-rules">{{ pickedGroup.stage }} · 战力 {{ pickedGroup.power }}</p>
        <ul class="refine-hall-list">
          <li v-for="item in pickedGroup.items" :key="item.id" class="refine-hall-item" :style="{ borderColor: item.color }">
            <div class="refine-hall-copy">
              <p class="refine-hall-name">
                <strong :style="{ color: item.color }">{{ item.name }}</strong>
                <RefineTag :level="item.refineLevel" />
                <span class="refine-hall-slot">{{ item.slotName }}</span>
              </p>
              <p class="refine-hall-attrs">
                {{ item.mainAttrName }} +{{ item.mainValue }} · {{ item.subAttrName }} +{{ item.subValue }}
              </p>
              <p class="refine-hall-next">{{ nextText(item) }}</p>
            </div>
            <button
              class="upgrade-button refine-hall-button"
              type="button"
              :disabled="busy || item.refine.next === null"
              @click="emit('refine', item.id)"
            >
              祭炼
            </button>
          </li>
        </ul>
      </section>
    </ModalShell>
  </section>
</template>

<style scoped>
.refine-hall {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}

.refine-hall-head-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
}

.refine-hall-guide {
  padding: 4px 10px;
  font-size: 12px;
}

.refine-hall-rules {
  margin: 0;
  color: #93a99e;
  font-size: 12px;
  line-height: 1.6;
}

.refine-hall-tabs {
  display: flex;
  gap: 6px;
}

.refine-hall-tab {
  padding: 5px 12px;
  border: 1px solid rgba(119, 184, 154, 0.16);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.02);
  color: #9db3a8;
  font-size: 12px;
  cursor: pointer;
}

.refine-hall-tab.is-active {
  border-color: rgba(234, 209, 154, 0.55);
  background: rgba(202, 169, 106, 0.12);
  color: var(--gold-bright, #ead19a);
}

.refine-hall-disciple {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 10px;
  border: 1px solid rgba(119, 184, 154, 0.16);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.016);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 150ms ease, background-color 150ms ease;
}

.refine-hall-disciple:hover {
  border-color: rgba(234, 209, 154, 0.5);
  background: rgba(202, 169, 106, 0.06);
}

.refine-hall-disciple:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgba(202, 169, 106, 0.3);
}

.refine-hall-disciple-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.refine-hall-summary {
  color: #7d9186;
  font-size: 11px;
}

.refine-hall-arrow {
  flex: 0 0 auto;
  color: var(--gold, #caa96a);
  font-size: 18px;
}

.refine-hall-owner {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}

.refine-hall-owner strong {
  color: #e4ece6;
  font-weight: 500;
}

.refine-hall-owner span {
  color: #7d9186;
  font-size: 11px;
}

.refine-hall-list {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.refine-hall-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid rgba(119, 184, 154, 0.16);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.016);
}

.refine-hall-copy {
  min-width: 0;
}

.refine-hall-name {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 6px;
  margin: 0;
  font-size: 13px;
}

.refine-hall-name strong {
  font-weight: 500;
  letter-spacing: 0.04em;
}

.refine-hall-name .refine-tag {
  margin-left: 0;
}

.refine-hall-slot {
  color: #7d9186;
  font-size: 11px;
}

.refine-hall-attrs,
.refine-hall-next {
  margin: 3px 0 0;
  color: #9db3a8;
  font-size: 11px;
  line-height: 16px;
}

.refine-hall-next {
  color: #7d9186;
}

.refine-hall-button {
  flex: 0 0 auto;
  white-space: nowrap;
}
</style>
