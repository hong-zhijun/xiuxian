<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { DispatchPlan } from '../utils/discipleDispatch';
import ModalShell from './ModalShell.vue';

/**
 * 门人调度：上半部分列出「哪里没安排好」，下半部分是推荐的调整（可逐条取消），确认后一次执行。
 * 推荐由 utils/discipleDispatch.ts 的 planDispatch 算好传进来；执行与提示在 App.vue。
 */
const props = defineProps<{ plan: DispatchPlan; busy: boolean }>();
const emit = defineEmits<{
  apply: [moveKeys: string[], appointmentKeys: string[]];
  openDetail: [discipleId: string];
  close: [];
}>();

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
          <h2 id="dispatch-title">调度建议</h2>
        </div>
      </header>

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
</style>
