<script setup lang="ts">
import { computed } from 'vue';

import type { SectLevelCatalogEntry, SectStateView } from '../api/game';
import { formatAmount } from '../utils/format';
import ModalShell from './ModalShell.vue';

/**
 * 宗门等级一览（首页宗门品阶旁的「?」）：每级名称、弟子上限、资源容量倍率、升级消耗与条件。
 * 数据来自服务端 state.sectLevelCatalog（资源名取 state.resources），前端只渲染；当前等级高亮。
 */
const props = defineProps<{
  state: SectStateView;
}>();

const emit = defineEmits<{
  close: [];
}>();

const levels = computed<SectLevelCatalogEntry[]>(() => props.state.sectLevelCatalog);

function costText(cost: Record<string, string>): string {
  const entries = Object.entries(cost);
  if (entries.length === 0) return '—';
  return entries
    .map(([resourceId, amount]) => {
      const name = props.state.resources.find((resource) => resource.id === resourceId)?.name ?? resourceId;
      return `${name} ${formatAmount(amount)}`;
    })
    .join(' · ');
}
</script>

<template>
  <ModalShell label="宗门等级一览" @close="emit('close')">
    <section class="talent-catalog" aria-labelledby="sect-level-catalog-title">
      <header class="section-heading panel-heading compact-heading">
        <div>
          <p class="eyebrow">宗门</p>
          <h2 id="sect-level-catalog-title">宗门等级一览</h2>
        </div>
      </header>
      <p class="disciple-detail-hint">升级消耗与条件指「升到这一级」所需；资源容量是各项资源基础容量的倍数。</p>

      <p class="talent-catalog-swipe disciple-detail-hint">表格可左右滑动查看。</p>
      <div class="talent-catalog-scroll">
        <table class="talent-catalog-table sect-level-catalog-table">
          <thead>
            <tr>
              <th scope="col">等级</th>
              <th scope="col">名称</th>
              <th scope="col" class="talent-catalog-value">弟子上限</th>
              <th scope="col" class="talent-catalog-value">资源容量</th>
              <th scope="col">升级消耗</th>
              <th scope="col">条件</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="level in levels" :key="level.level" :class="{ 'is-current': level.level === state.sect.level }">
              <th scope="row" class="talent-catalog-name">{{ level.level }}</th>
              <td class="talent-catalog-name">{{ level.name }}</td>
              <td class="talent-catalog-value">{{ level.discipleCapacity }}</td>
              <td class="talent-catalog-value">×{{ level.capacityMultiplier }}</td>
              <td class="talent-catalog-condition">{{ costText(level.upgradeCost) }}</td>
              <td class="talent-catalog-condition">{{ level.requirements.length > 0 ? level.requirements.join('；') : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <button class="action-button primary-action realm-button" type="button" @click="emit('close')">
        <span>知道了</span>
      </button>
    </section>
  </ModalShell>
</template>
