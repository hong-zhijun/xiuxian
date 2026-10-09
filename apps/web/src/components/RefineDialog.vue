<script setup lang="ts">
import { computed } from 'vue';

import type { EquipmentItemView, ResourceView } from '../api/game';
import { formatAmount, formatBp } from '../utils/format';
import ModalShell from './ModalShell.vue';
import RefineTag, { REFINE_LEVEL_NAMES } from './RefineTag.vue';

/**
 * 祭炼二级弹窗（0044，docs/装备祭炼开发计划.md 5.3）：叠在上层，Esc / 点遮罩只关它。
 * 成功率、消耗、增量都取自服务端的 `item.refine.next`，这里只渲染并比较余额。
 * 点「祭炼」只 emit：弹窗保持打开，数据刷新后自动显示下一重。
 */
const props = defineProps<{
  item: EquipmentItemView;
  resources: ResourceView[];
  busy: boolean;
}>();

const emit = defineEmits<{
  refine: [equipmentId: string];
  close: [];
}>();

const next = computed(() => props.item.refine.next);

const ownerText = computed(() =>
  props.item.discipleId === null ? '背包' : `穿在 ${props.item.discipleName ?? '弟子'} 身上`,
);

/** 本次消耗逐项：资源名、需要、拥有（都是最小单位），拥有不足的那项标红。 */
const costRows = computed(() => {
  if (next.value === null) return [];
  return Object.entries(next.value.cost).map(([resourceId, need]) => {
    const resource = props.resources.find((item) => item.id === resourceId);
    const have = Number(resource?.balance ?? 0);
    return {
      resourceId,
      name: resource?.name ?? resourceId,
      need: Number(need),
      have,
      lacking: have < Number(need),
    };
  });
});

const canRefine = computed(() => !props.busy && costRows.value.every((row) => !row.lacking));

/** 里程碑提示（只按下一重判断）：五重副属性、九重通灵、十二重圆满。 */
const milestoneHint = computed(() => {
  switch (next.value?.level) {
    case 5:
      return '五重：副属性一次性提升';
    case 9:
      return '九重通灵：此后每重战力 +1%';
    case 12:
      return '十二重圆满：副属性再提升，战力再 +2%';
    default:
      return null;
  }
});
</script>

<template>
  <ModalShell
    narrow
    :label="`祭炼 · ${item.name}`"
    :loading="busy"
    loading-text="祭炼中…"
    @close="emit('close')"
  >
    <section class="refine-dialog" aria-labelledby="refine-title">
      <header class="section-heading panel-heading compact-heading">
        <div>
          <p class="eyebrow">祭炼</p>
          <h2 id="refine-title" :style="{ color: item.color }">{{ item.name }}<RefineTag :level="item.refineLevel" /></h2>
        </div>
      </header>

      <p class="refine-owner">{{ ownerText }}</p>

      <template v-if="next === null">
        <p class="refine-hint">已祭炼至十二重圆满。</p>
        <div class="disciple-break-confirm-actions">
          <button class="action-button primary-action" type="button" @click="emit('close')">关闭</button>
        </div>
      </template>

      <template v-else>
        <p class="refine-target">冲击 <strong>{{ REFINE_LEVEL_NAMES[next.level] }}</strong></p>

        <dl class="refine-changes">
          <div>
            <dt>{{ item.mainAttrName }}</dt>
            <dd>{{ item.mainValue }} → {{ item.mainValue + next.mainGain }}</dd>
          </div>
          <div v-if="next.subGain > 0">
            <dt>{{ item.subAttrName }}</dt>
            <dd>{{ item.subValue }} → {{ item.subValue + next.subGain }}</dd>
          </div>
          <div v-if="next.powerBonusGainBp > 0">
            <dt>战力加成</dt>
            <dd>+{{ formatBp(item.powerBonusBp) }} → +{{ formatBp(item.powerBonusBp + next.powerBonusGainBp) }}</dd>
          </div>
        </dl>

        <p v-if="milestoneHint" class="refine-milestone">{{ milestoneHint }}</p>

        <p class="refine-odds">成功率 {{ next.successBp / 100 }}%</p>
        <p class="refine-note">失败只耗材料，不会降重、不会损坏装备。</p>

        <ul class="refine-cost" aria-label="本次消耗">
          <li v-for="row in costRows" :key="row.resourceId" :class="{ 'is-lacking': row.lacking }">
            <span>{{ row.name }}</span>
            <span>需要 {{ formatAmount(row.need) }} / 拥有 {{ formatAmount(row.have) }}</span>
          </li>
        </ul>

        <div class="disciple-break-confirm-actions">
          <button class="action-button" type="button" :disabled="busy" @click="emit('close')">取消</button>
          <button
            class="action-button primary-action"
            type="button"
            :disabled="!canRefine"
            @click="emit('refine', item.id)"
          >
            <span>祭炼</span>
          </button>
        </div>
      </template>
    </section>
  </ModalShell>
</template>

<style scoped>
.refine-dialog {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}

.refine-owner {
  margin: 0;
  color: #7d9186;
  font-size: 12px;
}

.refine-hint,
.refine-odds {
  margin: 0;
  color: #dce6e0;
  font-size: 13px;
}

.refine-target {
  margin: 0;
  color: #dce6e0;
  font-size: 13px;
}

.refine-target strong {
  color: var(--gold-bright, #e0cd97);
  font-weight: 500;
}

.refine-changes {
  display: grid;
  gap: 6px;
  margin: 0;
}

.refine-changes > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid rgba(119, 184, 154, 0.12);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.016);
}

.refine-changes dt {
  color: #7d9186;
  font-size: 12px;
}

.refine-changes dd {
  margin: 0;
  color: #e4ece6;
  font-size: 13px;
}

.refine-milestone {
  margin: 0;
  color: var(--gold-bright, #e0cd97);
  font-size: 12px;
}

.refine-note {
  margin: 0;
  color: #7d9186;
  font-size: 11px;
}

.refine-cost {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.refine-cost li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: #cbd8d0;
  font-size: 12px;
}

.refine-cost li.is-lacking {
  color: #e08a7a;
}
</style>
