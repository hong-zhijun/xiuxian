<script setup lang="ts">
import { computed } from 'vue';

import type { TalentCatalogEntry } from '../api/game';
import ModalShell from './ModalShell.vue';

/**
 * 天赋总表（弟子详情天赋旁的「?」）：11 个天赋 × 五个境界的数值，全部来自服务端 state.talents，
 * 前端只渲染。当前弟子的天赋行与当前境界列高亮，方便对照。
 */
const props = defineProps<{
  talents: TalentCatalogEntry[];
  /** 当前弟子的天赋 id（高亮那一行）。 */
  currentTalent?: string;
  /** 当前弟子的境界 id（高亮那一列）。 */
  currentRealmId?: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

const realmColumns = computed(() => props.talents[0]?.values ?? []);
</script>

<template>
  <ModalShell label="天赋一览" @close="emit('close')">
    <section class="talent-catalog" aria-labelledby="talent-catalog-title">
      <header class="section-heading panel-heading compact-heading">
        <div>
          <p class="eyebrow">天赋</p>
          <h2 id="talent-catalog-title">天赋一览</h2>
        </div>
      </header>
      <p class="disciple-detail-hint">
        天赋强度随境界提高（同一境界三个阶段相同）。「宗门」类天赋要在「执事堂」任命为执事才生效，执事不能出战。
        洗髓丹可以洗出新天赋，再二选一。
      </p>

      <p class="talent-catalog-swipe disciple-detail-hint">表格可左右滑动，查看各境界的数值。</p>
      <div class="talent-catalog-scroll">
        <table class="talent-catalog-table">
          <thead>
            <tr>
              <th scope="col">天赋</th>
              <th scope="col">类别</th>
              <th scope="col">生效条件</th>
              <th scope="col">效果</th>
              <th
                v-for="column in realmColumns"
                :key="column.realmId"
                scope="col"
                class="talent-catalog-value"
                :class="{ 'is-current': column.realmId === currentRealmId }"
              >
                {{ column.realmName }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="talent in talents"
              :key="talent.id"
              :class="[`is-${talent.category}`, { 'is-current': talent.id === currentTalent }]"
            >
              <th scope="row" class="talent-catalog-name">{{ talent.name }}</th>
              <td><span class="talent-catalog-category">{{ talent.categoryName }}</span></td>
              <td class="talent-catalog-condition">{{ talent.condition }}</td>
              <td>{{ talent.effect }}</td>
              <td
                v-for="value in talent.values"
                :key="value.realmId"
                class="talent-catalog-value"
                :class="{ 'is-current': value.realmId === currentRealmId }"
              >
                {{ value.text }}
              </td>
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
