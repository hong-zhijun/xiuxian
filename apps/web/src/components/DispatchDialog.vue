<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { DispatchPlan } from '../utils/discipleDispatch';
import type { PostCard } from '../utils/postInsights';
import { topTalentNeeds, type TalentNeedRow } from '../utils/talentNeeds';
import ModalShell from './ModalShell.vue';

/**
 * 门人调度：上半部分列出「哪里没安排好」，下半部分是推荐的调整（可逐条取消），确认后一次执行。
 * 推荐由 utils/discipleDispatch.ts 的 planDispatch 算好传进来；执行与提示在 App.vue。
 */
const props = defineProps<{
  plan: DispatchPlan;
  postCards: PostCard[];
  talentRows: TalentNeedRow[];
  busy: boolean;
}>();
const emit = defineEmits<{
  apply: [moveKeys: string[], appointmentKeys: string[]];
  openDetail: [discipleId: string];
  close: [];
}>();

type DispatchTab = 'dispatch' | 'posts' | 'talent';
const activeTab = ref<DispatchTab>('dispatch');
const TABS: readonly { id: DispatchTab; label: string }[] = [
  { id: 'dispatch', label: '调度' },
  { id: 'posts', label: '岗位' },
  { id: 'talent', label: '人才' },
];
const TAB_TITLES: Record<DispatchTab, string> = { dispatch: '调度建议', posts: '岗位概览', talent: '人才缺口' };

const topNeeds = computed(() => topTalentNeeds(props.talentRows));
const LEVEL_LABELS: Record<TalentNeedRow['level'], string> = {
  urgent: '急缺',
  short: '不足',
  ok: '够用',
  info: '可选',
};

/** 取消勾选的推荐项（默认全选；计划刷新后已不存在的 key 自然失效）。 */
const unchecked = ref(new Set<string>());

watch(
  () => props.plan,
  (plan) => {
    const keys = new Set([...plan.moves, ...plan.appointments].map((item) => item.key));
    unchecked.value = new Set([...unchecked.value].filter((key) => keys.has(key)));
  },
);

function toggle(key: string): void {
  const next = new Set(unchecked.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  unchecked.value = next;
}

const selectedMoves = computed(() => props.plan.moves.filter((item) => !unchecked.value.has(item.key)));
const selectedAppointments = computed(() =>
  props.plan.appointments.filter((item) => !unchecked.value.has(item.key)),
);
const selectedCount = computed(() => selectedMoves.value.length + selectedAppointments.value.length);
const suggestionCount = computed(() => props.plan.moves.length + props.plan.appointments.length);

function apply(): void {
  if (props.busy || selectedCount.value === 0) return;
  emit(
    'apply',
    selectedMoves.value.map((item) => item.key),
    selectedAppointments.value.map((item) => item.key),
  );
}
</script>

<template>
  <ModalShell label="门人调度" :loading="busy" loading-text="调度中…" @close="emit('close')">
    <section class="dispatch" aria-labelledby="dispatch-title">
      <header class="section-heading panel-heading compact-heading">
        <div>
          <p class="eyebrow">门人调度</p>
          <h2 id="dispatch-title">{{ TAB_TITLES[activeTab] }}</h2>
        </div>
      </header>

      <div class="disciple-tabs dispatch-tabs" role="tablist" aria-label="门人调度分区">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          class="disciple-tab"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.id"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>

      <template v-if="activeTab === 'posts'">
        <ul class="talent-need-list">
          <li v-for="card in postCards" :key="card.key" class="talent-need-row">
            <p class="talent-need-head">
              <strong>{{ card.title }}</strong>
              <span class="talent-need-count">{{ card.summary }}</span>
            </p>
            <div v-for="line in card.lines" :key="line.label" class="post-line">
              <span class="post-line-label">{{ line.label }}</span>
              <span v-if="line.people.length === 0" class="post-line-empty">{{ line.empty }}</span>
              <span v-else class="post-line-people">
                <button
                  v-for="person in line.people"
                  :key="person.id"
                  class="dispatch-name"
                  type="button"
                  :title="`查看${person.name}的详情`"
                  @click="emit('openDetail', person.id)"
                >
                  {{ person.name }}<small>{{ person.note }}</small>
                </button>
              </span>
            </div>
            <div v-for="tip in card.tips" :key="tip.text" class="post-tip">
              <p class="post-tip-text">{{ tip.text }}</p>
              <p class="dispatch-names">
                <button
                  v-for="person in tip.people"
                  :key="person.id"
                  class="dispatch-name"
                  type="button"
                  :title="`查看${person.name}的详情`"
                  @click="emit('openDetail', person.id)"
                >
                  {{ person.name }}<small>{{ person.note }}</small>
                </button>
              </p>
            </div>
          </li>
        </ul>
        <p class="dispatch-note">这里的建议涉及取舍，只做提示，不会被一键调度执行。</p>
      </template>

      <template v-else-if="activeTab === 'talent'">
        <h3 class="dispatch-subtitle">当前最需要</h3>
        <ul v-if="topNeeds.length > 0" class="dispatch-issues">
          <li v-for="need in topNeeds" :key="need.key" class="dispatch-issue">
            <p class="dispatch-issue-title">
              <span class="talent-need-level" :class="`is-${need.level}`">{{ LEVEL_LABELS[need.level] }}</span>
              {{ need.title }}
            </p>
            <p class="dispatch-issue-detail">{{ need.advice }}</p>
          </li>
        </ul>
        <p v-else class="dispatch-empty">各类天赋人才都够用。</p>
        <p class="dispatch-note">补人才：招贤台留意对应天赋的候选人，或给现有弟子服洗髓丹重洗天赋。</p>

        <h3 class="dispatch-subtitle">全部天赋</h3>
        <ul class="talent-need-list">
          <li v-for="row in talentRows" :key="row.talentId" class="talent-need-row">
            <p class="talent-need-head">
              <strong>{{ row.name }}</strong>
              <small>{{ row.categoryName }}</small>
              <span class="talent-need-count">{{ row.holders.length }} 人</span>
              <span class="talent-need-level" :class="`is-${row.level}`">{{ LEVEL_LABELS[row.level] }}</span>
            </p>
            <p class="talent-need-usage">{{ row.usage }}</p>
            <p class="talent-need-advice">{{ row.advice }}</p>
            <p v-if="row.holders.length > 0" class="dispatch-names">
              <button
                v-for="holder in row.holders"
                :key="holder.id"
                class="dispatch-name"
                type="button"
                :title="`查看${holder.name}的详情`"
                @click="emit('openDetail', holder.id)"
              >
                {{ holder.name }}<small>{{ holder.realmName }}</small>
              </button>
            </p>
          </li>
        </ul>
      </template>

      <template v-else>
        <h3 class="dispatch-subtitle">需要留意</h3>
        <ul v-if="plan.issues.length > 0" class="dispatch-issues">
          <li v-for="issue in plan.issues" :key="issue.key" class="dispatch-issue" :class="{ 'is-info': !issue.fixable }">
            <p class="dispatch-issue-title">
              <span class="dispatch-issue-mark" aria-hidden="true">{{ issue.fixable ? '!' : 'i' }}</span>
              {{ issue.title }}
            </p>
            <p v-if="issue.detail" class="dispatch-issue-detail">{{ issue.detail }}</p>
            <p v-if="issue.disciples.length > 0" class="dispatch-names">
              <button
                v-for="disciple in issue.disciples"
                :key="disciple.id"
                class="dispatch-name"
                type="button"
                :title="`查看${disciple.name}的详情`"
                @click="emit('openDetail', disciple.id)"
              >
                {{ disciple.name }}<small v-if="disciple.note">{{ disciple.note }}</small>
              </button>
            </p>
          </li>
        </ul>
        <p v-else class="dispatch-empty">门人都安排妥当了。</p>

        <h3 class="dispatch-subtitle">推荐调整</h3>
        <ul v-if="suggestionCount > 0" class="dispatch-suggestions">
          <li v-for="appointment in plan.appointments" :key="appointment.key">
            <label class="dispatch-suggestion">
              <input
                type="checkbox"
                :checked="!unchecked.has(appointment.key)"
                :disabled="busy"
                @change="toggle(appointment.key)"
              />
              <span class="dispatch-suggestion-body">
                <span class="dispatch-suggestion-main">
                  <strong>{{ appointment.discipleName }}</strong>
                  就任{{ appointment.officeName }}
                  <template v-if="appointment.replacingName">（替换{{ appointment.replacingName }}）</template>
                </span>
                <small>{{ appointment.reason }}</small>
              </span>
            </label>
          </li>
          <li v-for="item in plan.moves" :key="item.key">
            <label class="dispatch-suggestion">
              <input type="checkbox" :checked="!unchecked.has(item.key)" :disabled="busy" @change="toggle(item.key)" />
              <span class="dispatch-suggestion-body">
                <span class="dispatch-suggestion-main">
                  <strong>{{ item.discipleName }}</strong>
                  {{ item.fromName }} → <b>{{ item.toName }}</b>
                </span>
                <small>{{ item.reason }}</small>
              </span>
            </label>
          </li>
        </ul>
        <p v-else class="dispatch-empty">没有需要自动调整的地方。</p>

        <div class="dispatch-actions">
          <button class="action-button" type="button" :disabled="busy" @click="emit('close')">关闭</button>
          <button
            class="action-button dispatch-apply"
            type="button"
            :disabled="busy || selectedCount === 0"
            @click="apply"
          >
            执行选中的 {{ selectedCount }} 项
          </button>
        </div>
        <p class="dispatch-note">
          没有岗位加成的弟子保持原岗位；在外历练、重伤卧床的弟子不会被调动。执行时不符合条件的会被跳过并提示原因。
        </p>
      </template>
    </section>
  </ModalShell>
</template>

<style scoped>
.dispatch {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.dispatch-subtitle {
  margin: 6px 0 0;
  color: var(--gold);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.12em;
}

.dispatch-issues,
.dispatch-suggestions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.dispatch-issue {
  padding: 9px 11px;
  border: 1px solid rgba(202, 169, 106, 0.32);
  border-radius: 5px;
  background: rgba(202, 169, 106, 0.06);
}

.dispatch-issue.is-info {
  border-color: var(--line);
  background: rgba(255, 255, 255, 0.02);
}

.dispatch-issue-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--ink-text);
  font-size: 14px;
}

.dispatch-issue-mark {
  display: inline-flex;
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: #0b1713;
  background: var(--gold);
  font-size: 12px;
  font-weight: 700;
}

.is-info .dispatch-issue-mark {
  color: var(--ink-text);
  background: var(--jade-dark);
  font-style: italic;
}

.dispatch-issue-detail {
  margin: 4px 0 0 26px;
  color: var(--muted);
  font-size: 12px;
}

.dispatch-names {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 7px 0 0 26px;
}

.dispatch-name {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--jade-bright);
  background: transparent;
  font-size: 12px;
  cursor: pointer;
}

.dispatch-name:hover {
  border-color: var(--jade);
}

.dispatch-name small {
  color: var(--faint);
  font-size: 11px;
}

.dispatch-suggestion {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 5px;
  cursor: pointer;
}

.dispatch-suggestion input {
  margin-top: 3px;
  accent-color: var(--gold);
}

.dispatch-suggestion-body {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.dispatch-suggestion-main {
  color: var(--ink-text);
  font-size: 14px;
}

.dispatch-suggestion-main b {
  color: var(--gold-bright);
  font-weight: 500;
}

.dispatch-suggestion-body small {
  color: var(--muted);
  font-size: 12px;
}

.dispatch-empty {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.dispatch-actions {
  display: flex;
  gap: 10px;
  margin-top: 4px;
}

.dispatch-actions .action-button {
  min-height: 40px;
  flex: 1 1 0;
}

.dispatch-apply {
  border-color: #d4b979;
  color: #0b1713;
  background: var(--gold);
}

.dispatch-apply:disabled {
  opacity: 0.55;
}

.dispatch-note {
  margin: 0;
  color: var(--faint);
  font-size: 11px;
}

.dispatch-tabs {
  margin-bottom: 2px;
}

.talent-need-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.talent-need-row {
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: 5px;
}

.talent-need-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
}

.talent-need-head strong {
  color: var(--ink-text);
  font-size: 14px;
  font-weight: 500;
}

.talent-need-head small {
  color: var(--faint);
  font-size: 11px;
}

.talent-need-count {
  margin-left: auto;
  color: var(--muted);
  font-size: 12px;
}

.talent-need-level {
  padding: 1px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}

.talent-need-level.is-urgent {
  border-color: rgba(224, 123, 104, 0.7);
  color: var(--red-bright);
}

.talent-need-level.is-short {
  border-color: rgba(234, 209, 154, 0.6);
  color: var(--gold-bright);
}

.talent-need-level.is-ok {
  border-color: rgba(119, 184, 154, 0.5);
  color: var(--jade-bright);
}

.talent-need-usage,
.talent-need-advice {
  margin: 4px 0 0;
  font-size: 12px;
}

.talent-need-usage {
  color: var(--faint);
}

.talent-need-advice {
  color: var(--muted);
}

.talent-need-row .dispatch-names {
  margin-left: 0;
}

.post-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 6px;
}

.post-line-label {
  flex: 0 0 auto;
  color: var(--faint);
  font-size: 12px;
}

.post-line-empty {
  color: var(--muted);
  font-size: 12px;
}

.post-line-people {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 6px;
}

.post-tip {
  margin-top: 8px;
  padding: 6px 9px;
  border-left: 2px solid rgba(234, 209, 154, 0.6);
  background: rgba(202, 169, 106, 0.06);
}

.post-tip-text {
  margin: 0;
  color: var(--gold-bright);
  font-size: 12px;
}

.post-tip .dispatch-names {
  margin: 6px 0 0;
}
</style>
