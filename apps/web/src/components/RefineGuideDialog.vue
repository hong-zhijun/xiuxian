<script setup lang="ts">
import { computed, ref } from 'vue';

import type { RefineGuideView, ResourceView } from '../api/game';
import { formatAmount } from '../utils/format';
import ModalShell from './ModalShell.vue';
import { REFINE_LEVEL_NAMES } from './RefineTag.vue';

/**
 * 祭炼说明（二级弹窗，祭炼弹窗与祭炼堂的「说明」按钮共用）：
 * 选一个品质，逐重列出成功率、消耗与成功后的加成。数据全部来自服务端的 refineGuide，前端不复制表。
 */
const props = defineProps<{
  guide: RefineGuideView;
  resources: ResourceView[];
  /** 默认选中的品质（从某件装备打开时就是它的品质）；不传选仙品。 */
  initialQuality?: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

const qualityId = ref(
  props.guide.qualities.some((quality) => quality.id === props.initialQuality)
    ? (props.initialQuality as string)
    : (props.guide.qualities[props.guide.qualities.length - 1]?.id ?? ''),
);
const quality = computed(() => props.guide.qualities.find((item) => item.id === qualityId.value) ?? null);

function resourceName(resourceId: string): string {
  return props.resources.find((resource) => resource.id === resourceId)?.name ?? resourceId;
}

function costLines(cost: Record<string, string>): string[] {
  return Object.entries(cost).map(([resourceId, units]) => `${resourceName(resourceId)} ${formatAmount(units)}`);
}

function gainLines(row: { mainGain: number; subGain: number; powerBonusGainBp: number }): string[] {
  const lines = [`主属性 +${String(row.mainGain)}`];
  if (row.subGain > 0) lines.push(`副属性 +${String(row.subGain)}`);
  if (row.powerBonusGainBp > 0) lines.push(`战力 +${String(row.powerBonusGainBp / 100)}%`);
  return lines;
}
</script>

<template>
  <ModalShell label="祭炼说明" @close="emit('close')">
    <section class="refine-guide" aria-labelledby="refine-guide-title">
      <header class="section-heading panel-heading compact-heading">
        <div>
          <p class="eyebrow">祭炼</p>
          <h2 id="refine-guide-title">概率与花费</h2>
        </div>
      </header>

      <ul class="refine-guide-rules">
        <li>每次冲下一重，最高十二重；花费看<strong>要冲的那一重</strong>和装备品质，下表的成功率按要冲的那一重。</li>
        <li>失败只扣这一次的材料，不降重、不损坏装备，可以接着冲。</li>
        <li>五重、十二重时副属性额外提升；九重起「通灵」每重战力 +1%，十二重「圆满」再 +2%。</li>
        <li>分解装备只按品质返还，祭炼花的材料不退。</li>
      </ul>

      <div class="refine-guide-qualities" role="radiogroup" aria-label="装备品质">
        <button
          v-for="item in guide.qualities"
          :key="item.id"
          class="refine-guide-quality"
          :class="{ 'is-active': item.id === qualityId }"
          :style="{ '--quality': item.color }"
          type="button"
          role="radio"
          :aria-checked="item.id === qualityId"
          @click="qualityId = item.id"
        >
          {{ item.name }}
        </button>
      </div>

      <table v-if="quality" class="refine-guide-table">
        <thead>
          <tr>
            <th scope="col">冲到</th>
            <th scope="col">成功率</th>
            <th scope="col">每次花费</th>
            <th scope="col">成功后</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in quality.rows" :key="row.level" :class="{ 'is-mystic': row.level >= 9 && row.level < 12, 'is-perfect': row.level === 12 }">
            <th scope="row">{{ REFINE_LEVEL_NAMES[row.level] }}</th>
            <td>{{ row.successBp / 100 }}%</td>
            <td>
              <span v-for="line in costLines(row.cost)" :key="line" class="refine-guide-line">{{ line }}</span>
            </td>
            <td>
              <span v-for="line in gainLines(row)" :key="line" class="refine-guide-line">{{ line }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </ModalShell>
</template>

<style scoped>
.refine-guide {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}

.refine-guide-rules {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-left: 18px;
  list-style: disc;
  color: #93a99e;
  font-size: 12px;
  line-height: 1.6;
}

.refine-guide-rules strong {
  color: #dce6e0;
  font-weight: 500;
}

.refine-guide-qualities {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.refine-guide-quality {
  padding: 5px 12px;
  border: 1px solid rgba(119, 184, 154, 0.16);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.02);
  color: #9db3a8;
  font-size: 12px;
  cursor: pointer;
}

.refine-guide-quality.is-active {
  border-color: var(--quality);
  background: rgba(255, 255, 255, 0.05);
  color: var(--quality);
}

.refine-guide-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.refine-guide-table th,
.refine-guide-table td {
  padding: 6px 8px;
  border-bottom: 1px solid rgba(119, 184, 154, 0.1);
  text-align: left;
  vertical-align: top;
}

.refine-guide-table thead th {
  color: #7d9186;
  font-weight: 500;
}

.refine-guide-table tbody th {
  color: #cbd8d0;
  font-weight: 600;
  white-space: nowrap;
}

.refine-guide-table td {
  color: #cbd8d0;
}

.refine-guide-table tr.is-mystic th {
  color: #c084fc;
}

.refine-guide-table tr.is-perfect th {
  color: #ffb454;
}

.refine-guide-line {
  display: block;
  white-space: nowrap;
}
</style>
