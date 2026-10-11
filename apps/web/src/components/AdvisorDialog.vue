<script setup lang="ts">
import { computed } from 'vue';

import type { AdvisorAction, AdvisorView } from '../utils/advisor';
import ModalShell from './ModalShell.vue';

/**
 * 宗门参谋：只渲染 utils/advisor.ts 算好的结果（这里不做任何规则判断，也不带分数）。
 * 每条建议的「去处理」emit action；关弹窗、打开对应的弹窗 / 滚动都在 SectScreen（见 onAdvisorAction）。
 */
const props = defineProps<{
  view: AdvisorView;
}>();
const emit = defineEmits<{
  action: [action: AdvisorAction];
  close: [];
}>();

const headline = computed(() => {
  const count = props.view.badgeCount;
  if (count === 0) return '暂无待办';
  return `${count > 99 ? '99+' : String(count)} 项可处理`;
});
</script>

<template>
  <ModalShell label="宗门参谋" @close="emit('close')">
    <section class="advisor" aria-labelledby="advisor-title">
      <header class="section-heading panel-heading compact-heading advisor-head">
        <div>
          <p class="eyebrow">宗门参谋</p>
          <h2 id="advisor-title">下一步该做什么</h2>
        </div>
        <span class="count-badge">{{ headline }}</span>
      </header>

      <h3 class="advisor-subtitle">下一步</h3>
      <ul v-if="view.nextSteps.length > 0" class="advisor-list">
        <li v-for="item in view.nextSteps" :key="item.id" class="advisor-row">
          <span class="advisor-row-text">{{ item.text }}</span>
          <button class="advisor-go" type="button" @click="emit('action', item.action)">{{ item.actionLabel }}</button>
        </li>
      </ul>
      <p v-else class="advisor-empty">暂无需要处理的</p>

      <h3 class="advisor-subtitle">弟子培养</h3>
      <ul v-if="view.mainDisciples.length > 0" class="advisor-mains">
        <li v-for="main in view.mainDisciples" :key="main.discipleId" class="advisor-main">
          <div class="advisor-main-head">
            <button
              class="advisor-name"
              type="button"
              :title="`查看${main.name}的详情`"
              @click="emit('action', { kind: 'disciple', discipleId: main.discipleId })"
            >
              {{ main.name }}
            </button>
            <span class="advisor-tag">推荐培养</span>
            <span class="advisor-stage">{{ main.stageName }}</span>
          </div>
          <p class="advisor-meta">天赋 {{ main.talentName }} · 战力 {{ main.combatPower }}</p>
          <ul class="advisor-reasons">
            <li v-for="reason in main.reasons" :key="reason" class="advisor-reason">{{ reason }}</li>
          </ul>
          <p v-if="main.misplaced" class="advisor-misplaced">{{ main.misplaced }}</p>
          <div class="advisor-main-next">
            <template v-if="main.nextStep">
              <span class="advisor-row-text">{{ main.nextStep.text }}</span>
              <button class="advisor-go" type="button" @click="emit('action', main.nextStep.action)">
                {{ main.nextStep.actionLabel }}
              </button>
            </template>
            <span v-else class="advisor-row-text is-muted">状态良好，继续修炼</span>
          </div>
        </li>
      </ul>
      <p v-else class="advisor-empty">暂无需要处理的</p>

      <h3 class="advisor-subtitle">建筑</h3>
      <ul v-if="view.buildings.length > 0" class="advisor-list">
        <li v-for="item in view.buildings" :key="item.id" class="advisor-row" :class="{ 'is-note': !item.countsTowardBadge }">
          <span class="advisor-row-text">{{ item.text }}</span>
          <button class="advisor-go" type="button" @click="emit('action', item.action)">{{ item.actionLabel }}</button>
        </li>
      </ul>
      <p v-else class="advisor-empty">暂无需要处理的</p>

      <h3 class="advisor-subtitle">资源获取</h3>
      <ul v-if="view.income.length > 0" class="advisor-list">
        <li v-for="item in view.income" :key="item.id" class="advisor-row">
          <span class="advisor-row-text">{{ item.text }}</span>
          <button class="advisor-go" type="button" @click="emit('action', item.action)">{{ item.actionLabel }}</button>
        </li>
      </ul>
      <p v-else class="advisor-empty">暂无需要处理的</p>

      <h3 class="advisor-subtitle">资源使用</h3>
      <ul v-if="view.spending.items.length > 0" class="advisor-list">
        <li v-for="item in view.spending.items" :key="item.id" class="advisor-row">
          <span class="advisor-row-text">{{ item.text }}</span>
          <button class="advisor-go" type="button" @click="emit('action', item.action)">{{ item.actionLabel }}</button>
        </li>
      </ul>
      <p v-else class="advisor-empty">暂无需要处理的</p>
      <p class="advisor-note">{{ view.spending.note }}</p>
    </section>
  </ModalShell>
</template>

<style scoped>
.advisor {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}

.advisor-head h2 {
  overflow-wrap: anywhere;
}

.advisor-subtitle {
  margin: 8px 0 0;
  color: var(--gold);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.12em;
}

.advisor-list,
.advisor-mains,
.advisor-reasons {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.advisor-reasons {
  flex-direction: row;
  flex-wrap: wrap;
  gap: 5px;
}

.advisor-row,
.advisor-main {
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 5px;
}

.advisor-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.advisor-row.is-note {
  border-style: dashed;
}

.advisor-row-text {
  min-width: 0;
  flex: 1 1 auto;
  overflow-wrap: anywhere;
  color: var(--ink-text);
  font-size: 13px;
}

.advisor-row-text.is-muted {
  color: var(--muted);
}

.advisor-go {
  flex: 0 0 auto;
  padding: 4px 11px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  color: var(--gold-bright);
  background: transparent;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}

.advisor-go:hover {
  background: rgba(202, 169, 106, 0.1);
}

.advisor-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.advisor-main-head {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}

.advisor-name {
  min-width: 0;
  padding: 0;
  border: 0;
  color: var(--ink-text);
  background: transparent;
  font-size: 15px;
  overflow-wrap: anywhere;
  text-align: left;
  cursor: pointer;
}

.advisor-name:hover {
  color: var(--gold-bright);
}

.advisor-tag {
  padding: 1px 8px;
  border: 1px solid rgba(234, 209, 154, 0.6);
  border-radius: 999px;
  color: var(--gold-bright);
  font-size: 11px;
  white-space: nowrap;
}

.advisor-stage,
.advisor-meta {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.advisor-reason {
  padding: 1px 7px;
  border-radius: 4px;
  color: var(--jade-bright);
  background: rgba(119, 184, 154, 0.12);
  font-size: 11px;
}

.advisor-misplaced {
  margin: 0;
  color: var(--gold-bright);
  font-size: 12px;
}

.advisor-main-next {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
  padding-top: 6px;
  border-top: 1px dashed var(--line);
}

.advisor-empty {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.advisor-note {
  margin: 2px 0 0;
  color: var(--faint);
  font-size: 11px;
  overflow-wrap: anywhere;
}
</style>
