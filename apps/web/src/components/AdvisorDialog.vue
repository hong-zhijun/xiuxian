<script setup lang="ts">
import type { AdvisorAction, AdvisorView } from '../utils/advisor';
import ModalShell from './ModalShell.vue';

/**
 * 宗门参谋：只渲染 utils/advisor.ts 算好的结果（这里不做任何规则判断）。
 * 「去处理」emit action；关弹窗、打开对应的弹窗 / 滚动都在 SectScreen（见 onAdvisorAction）。
 */
defineProps<{
  view: AdvisorView;
}>();
const emit = defineEmits<{
  action: [action: AdvisorAction];
  close: [];
}>();

const STATUS_MARK = { done: '✓', short: '差', blocked: '缺' } as const;
</script>

<template>
  <ModalShell label="宗门参谋" @close="emit('close')">
    <section class="advisor" aria-labelledby="advisor-title">
      <header class="section-heading panel-heading compact-heading advisor-head">
        <div>
          <p class="eyebrow">宗门参谋</p>
          <h2 id="advisor-title">{{ view.goal ? view.goal.title : '宗门已满级' }}</h2>
        </div>
      </header>

      <template v-if="view.goal">
        <p class="advisor-summary" :class="{ 'is-ready': view.goal.ready }">{{ view.goal.summary }}</p>
        <ul class="advisor-list">
          <li
            v-for="line in view.goal.lines"
            :key="line.id"
            class="advisor-line"
            :class="[`is-${line.status}`, { 'is-bottleneck': line.bottleneck }]"
          >
            <span class="advisor-mark" aria-hidden="true">{{ STATUS_MARK[line.status] }}</span>
            <div class="advisor-body">
              <p class="advisor-text">
                {{ line.label }}
                <span v-if="line.bottleneck" class="advisor-flag">瓶颈</span>
              </p>
              <p class="advisor-detail">{{ line.detail }}</p>
            </div>
            <button v-if="line.action" class="advisor-go" type="button" @click="emit('action', line.action)">去看看</button>
          </li>
        </ul>

        <template v-if="view.goal.tips.length > 0">
          <h3 class="advisor-subtitle">怎么补</h3>
          <ul class="advisor-list">
            <li v-for="item in view.goal.tips" :key="item.id" class="advisor-tip" :class="{ 'is-key': item.key }">
              <div class="advisor-body">
                <p class="advisor-text">{{ item.text }}</p>
                <p v-if="item.detail" class="advisor-detail">{{ item.detail }}</p>
              </div>
              <button class="advisor-go" type="button" @click="emit('action', item.action)">去处理</button>
            </li>
          </ul>
        </template>
      </template>

      <h3 class="advisor-subtitle">战力提升</h3>
      <div v-if="view.arena" class="advisor-tip" :class="{ 'is-key': view.arena.key }">
        <div class="advisor-body">
          <p class="advisor-text">{{ view.arena.text }}</p>
          <p v-if="view.arena.detail" class="advisor-detail">{{ view.arena.detail }}</p>
        </div>
        <button class="advisor-go" type="button" @click="emit('action', view.arena.action)">去处理</button>
      </div>
      <ul v-if="view.mains.length > 0" class="advisor-mains">
        <li v-for="main in view.mains" :key="main.discipleId" class="advisor-main">
          <div class="advisor-main-head">
            <button
              class="advisor-name"
              type="button"
              :title="`查看${main.name}的详情`"
              @click="emit('action', { kind: 'disciple', discipleId: main.discipleId })"
            >
              {{ main.name }}
            </button>
            <span class="advisor-stage">{{ main.stageName }} · {{ main.talentName }} · 战力 {{ main.combatPower }}</span>
          </div>
          <ul class="advisor-reasons">
            <li v-for="reason in main.reasons" :key="reason" class="advisor-reason">{{ reason }}</li>
          </ul>
          <p v-if="main.note" class="advisor-note">{{ main.note }}</p>
          <ul v-if="main.tips.length > 0" class="advisor-list">
            <li v-for="item in main.tips" :key="item.id" class="advisor-step" :class="{ 'is-key': item.key }">
              <span class="advisor-text">{{ item.text }}</span>
              <span v-if="item.detail" class="advisor-gain">{{ item.detail }}</span>
              <button class="advisor-go" type="button" @click="emit('action', item.action)">去处理</button>
            </li>
          </ul>
          <p v-else class="advisor-detail">眼下没有能立刻提升战力的事，继续修炼</p>
        </li>
      </ul>
      <p v-else class="advisor-detail">暂无可出战的弟子</p>
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

.advisor-summary {
  margin: 0;
  color: var(--ink-text);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.advisor-summary.is-ready {
  color: var(--jade-bright);
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
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.advisor-reasons {
  flex-direction: row;
  flex-wrap: wrap;
  gap: 5px;
}

.advisor-line,
.advisor-tip,
.advisor-main {
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 5px;
}

.advisor-line,
.advisor-tip {
  display: flex;
  align-items: center;
  gap: 10px;
}

.advisor-line.is-bottleneck,
.advisor-tip.is-key,
.advisor-step.is-key {
  border-color: rgba(234, 209, 154, 0.6);
}

.advisor-mark {
  display: inline-flex;
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 11px;
}

.advisor-line.is-done .advisor-mark {
  color: var(--jade-bright);
  background: rgba(119, 184, 154, 0.14);
}

.advisor-line.is-short .advisor-mark {
  color: var(--gold-bright);
  background: rgba(202, 169, 106, 0.14);
}

.advisor-line.is-blocked .advisor-mark {
  color: #e58b7a;
  background: rgba(229, 139, 122, 0.14);
}

.advisor-line.is-done .advisor-text {
  color: var(--muted);
}

.advisor-body {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
}

.advisor-text {
  min-width: 0;
  margin: 0;
  flex: 1 1 auto;
  overflow-wrap: anywhere;
  color: var(--ink-text);
  font-size: 13px;
}

.advisor-detail {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.advisor-flag {
  margin-left: 4px;
  padding: 0 6px;
  border-radius: 999px;
  color: #1a1410;
  background: var(--gold-bright);
  font-size: 10px;
  vertical-align: 1px;
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
  align-items: baseline;
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

.advisor-stage {
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

.advisor-note {
  margin: 0;
  color: #e58b7a;
  font-size: 12px;
}

.advisor-step {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  padding: 6px 8px;
  border: 1px dashed var(--line);
  border-radius: 5px;
}

.advisor-step .advisor-text {
  flex: 1 1 140px;
}

.advisor-gain {
  color: var(--jade-bright);
  font-size: 12px;
  white-space: nowrap;
}
</style>
