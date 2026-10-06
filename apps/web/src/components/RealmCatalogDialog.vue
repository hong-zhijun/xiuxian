<script setup lang="ts">
import type { RealmCatalogEntry } from '../api/game';
import { formatAmount } from '../utils/format';
import ModalShell from './ModalShell.vue';

/**
 * 境界一览（弟子详情境界旁的「?」）：每个境界三个阶段的突破门槛、破境灵气，
 * 以及修炼倍率与天赋系数。数据全部来自服务端 state.realmCatalog，前端只渲染；
 * 当前弟子所在的阶段高亮。
 */
defineProps<{
  realms: RealmCatalogEntry[];
  currentRealmId?: string;
  currentStage?: number;
}>();

const emit = defineEmits<{
  close: [];
}>();
</script>

<template>
  <ModalShell label="境界一览" @close="emit('close')">
    <section class="talent-catalog" aria-labelledby="realm-catalog-title">
      <header class="section-heading panel-heading compact-heading">
        <div>
          <p class="eyebrow">境界</p>
          <h2 id="realm-catalog-title">境界一览</h2>
        </div>
      </header>
      <p class="disciple-detail-hint">
        修为到达门槛后破境进入下一阶段。修炼倍率同时作用于挂机修炼、历练修为与聚气丹 / 凝元丹；天赋系数决定天赋加成的强弱。
      </p>

      <p class="talent-catalog-swipe disciple-detail-hint">表格可左右滑动查看。</p>
      <div class="talent-catalog-scroll">
        <table class="talent-catalog-table">
          <thead>
            <tr>
              <th scope="col">境界</th>
              <th scope="col">阶段</th>
              <th scope="col" class="talent-catalog-value">突破门槛</th>
              <th scope="col" class="talent-catalog-value">破境灵气</th>
              <th scope="col" class="talent-catalog-value">修炼倍率</th>
              <th scope="col" class="talent-catalog-value">天赋系数</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="realm in realms" :key="realm.id">
              <tr
                v-for="(stage, index) in realm.stages"
                :key="`${realm.id}-${stage.stage}`"
                :class="{ 'is-current': realm.id === currentRealmId && stage.stage === currentStage }"
              >
                <th v-if="index === 0" scope="rowgroup" :rowspan="realm.stages.length" class="talent-catalog-name">
                  {{ realm.name }}
                </th>
                <td>{{ stage.name }}</td>
                <td class="talent-catalog-value">
                  {{ stage.requiredCultivation === null ? '当前最高' : stage.requiredCultivation.toLocaleString('zh-CN') }}
                </td>
                <td class="talent-catalog-value">
                  {{ stage.breakthroughCost === null ? '—' : formatAmount(stage.breakthroughCost) }}
                </td>
                <td v-if="index === 0" :rowspan="realm.stages.length" class="talent-catalog-value">
                  ×{{ realm.cultivationMultiplier }}
                </td>
                <td v-if="index === 0" :rowspan="realm.stages.length" class="talent-catalog-value">
                  {{ realm.talentMultiplierText }}
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <button class="action-button primary-action realm-button" type="button" @click="emit('close')">
        <span>知道了</span>
      </button>
    </section>
  </ModalShell>
</template>
