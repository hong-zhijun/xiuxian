<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import type { BondView, MentorshipView, RelationsAction, RelationsPanel } from '@xiuxian/contracts';

import type { SectStateView } from '../api/game';
import { fetchRelations, postRelationAction } from '../api/relations';

const props = defineProps<{ state: SectStateView; busy: boolean }>();
const emit = defineEmits<{
  'state-update': [state: SectStateView];
  notify: [tone: 'success' | 'warning', title: string, message: string];
}>();

const panel = ref<RelationsPanel | null>(null);
const loading = ref(false);
const submitting = ref(false);
const errorMessage = ref<string | null>(null);
const feedback = ref<string | null>(null);
const mentorId = ref('');
const discipleId = ref('');

const locked = computed(() => props.busy || loading.value || submitting.value);
const active = computed(() => panel.value?.mentorships.filter((item) => !item.graduated) ?? []);
const graduated = computed(() => panel.value?.mentorships.filter((item) => item.graduated) ?? []);
const mentorOptions = computed(() => panel.value?.mentors.filter((item) => item.realmIndex >= 3) ?? []);
/** 可拜师徒弟：境界比所选师傅低至少两个大境界，且不在任何进行中的师徒关系里。 */
const discipleOptions = computed(() => {
  const rows = panel.value?.disciples ?? [];
  const taken = new Set(active.value.flatMap((item) => [item.discipleId, item.mentorId]));
  const mentor = mentorOptions.value.find((item) => item.id === mentorId.value);
  return rows.filter((item) => item.id !== mentorId.value
    && !taken.has(item.id)
    && (mentor === undefined || mentor.realmIndex - item.realmIndex >= 2));
});

function accept(state: SectStateView): void {
  if (Date.parse(state.serverNow) >= Date.parse(props.state.serverNow)) emit('state-update', state);
}

async function load(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  errorMessage.value = null;
  try {
    const data = await fetchRelations();
    panel.value = data.relations;
    accept(data.state);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '师徒面板加载失败，请重试';
  } finally {
    loading.value = false;
  }
}

async function run(request: RelationsAction, successTitle: string): Promise<void> {
  if (locked.value) return;
  submitting.value = true;
  feedback.value = null;
  try {
    const data = await postRelationAction(request);
    panel.value = data.relations;
    accept(data.state);
    feedback.value = data.result.message;
    emit('notify', 'success', successTitle, data.result.message);
  } catch (error) {
    const message = error instanceof Error ? error.message : '操作失败，请稍后重试';
    feedback.value = message;
    emit('notify', 'warning', '操作未完成', message);
    void load();
  } finally {
    submitting.value = false;
  }
}

function acceptMentor(): void {
  if (!mentorId.value || !discipleId.value) return;
  const mentor = mentorOptions.value.find((item) => item.id === mentorId.value);
  const disciple = discipleOptions.value.find((item) => item.id === discipleId.value);
  if (!mentor || !disciple) return;
  void run({ action: 'mentor', mentorId: mentor.id, discipleId: disciple.id, commandId: crypto.randomUUID() }, '拜师成功');
  discipleId.value = '';
}

function graduate(item: MentorshipView): void {
  void run({ action: 'graduate', id: item.id, commandId: crypto.randomUUID() }, '弟子出师');
}

function cancel(item: MentorshipView): void {
  void run({ action: 'cancel-mentor', id: item.id, commandId: crypto.randomUUID() }, '师徒关系已解除');
}

function reroll(item: BondView): void {
  void run({ action: 'reroll-bond', id: item.id, commandId: crypto.randomUUID() }, '羁绊已重洗');
}

function bondLabel(item: BondView): string {
  return `${item.name} · 战力 +${String(item.powerBonusBp / 100)}%`;
}

onMounted(() => { void load(); });
</script>

<template>
  <section class="relations-dialog" aria-labelledby="relations-title">
    <header class="relations-heading">
      <div>
        <p class="eyebrow">宗门传承</p>
        <h2 id="relations-title">师徒与羁绊</h2>
      </div>
      <button class="relations-refresh" type="button" :disabled="loading" @click="load">刷新</button>
    </header>

    <p v-if="errorMessage" class="relations-hint">{{ errorMessage }}</p>
    <p v-else-if="panel === null" class="relations-hint">正在整理门中关系…</p>

    <template v-else>
      <p v-if="feedback" class="relations-feedback">{{ feedback }}</p>
      <p class="relations-summary">
        师徒名额 <b>{{ panel.activePairs }}/{{ panel.pairLimit }}</b>
        · 徒弟修炼 +{{ panel.cultivationBonusBp / 100 }}%
        · {{ panel.rerollPillId === 'talentPill' ? '洗髓丹' : panel.rerollPillId }} {{ panel.rerollPills }} 颗
      </p>

      <section class="relations-block" aria-labelledby="mentor-heading">
        <h3 id="mentor-heading">拜师</h3>
        <div class="relations-form">
          <label>
            师傅
            <select v-model="mentorId" :disabled="locked" @change="discipleId = ''">
              <option value="">选择师傅</option>
              <option v-for="item in mentorOptions" :key="item.id" :value="item.id">{{ item.name }} · {{ item.realmName }}</option>
            </select>
          </label>
          <label>
            徒弟
            <select v-model="discipleId" :disabled="locked || mentorId === ''">
              <option value="">选择徒弟</option>
              <option v-for="item in discipleOptions" :key="item.id" :value="item.id">{{ item.name }} · {{ item.realmName }}</option>
            </select>
          </label>
          <button class="relations-action" type="button" :disabled="locked || !mentorId || !discipleId" @click="acceptMentor">
            收徒
          </button>
        </div>
        <p class="relations-hint">师傅需元婴以上，且比徒弟高两个大境界；徒弟同时只能有一位师傅。</p>
      </section>

      <section class="relations-block" aria-labelledby="pairs-heading">
        <h3 id="pairs-heading">师徒关系</h3>
        <p v-if="active.length === 0" class="relations-hint">还没有进行中的师徒关系。</p>
        <ul v-else class="relations-list">
          <li v-for="item in active" :key="item.id" class="relations-row">
            <span class="relations-text"><b>{{ item.mentorName }}</b> → <b>{{ item.discipleName }}</b> · 目标 {{ item.targetRealmName }}</span>
            <span class="relations-tag">传道 {{ item.teachingValue }}</span>
            <button v-if="item.canGraduate" class="relations-action" type="button" :disabled="locked" @click="graduate(item)">准予出师</button>
            <span v-else class="relations-tag">未达出师境界</span>
            <button class="relations-quiet" type="button" :disabled="locked" @click="cancel(item)">解除</button>
          </li>
        </ul>
        <details v-if="graduated.length > 0" class="relations-history">
          <summary>已出师 {{ graduated.length }} 对</summary>
          <p v-for="item in graduated" :key="item.id" class="relations-hint">{{ item.mentorName }} ← {{ item.discipleName }}</p>
        </details>
      </section>

      <section class="relations-block" aria-labelledby="bonds-heading">
        <h3 id="bonds-heading">弟子羁绊</h3>
        <p v-if="panel.bonds.length === 0" class="relations-hint">新招募的弟子会随机与同门结下缘分。</p>
        <ul v-else class="relations-list">
          <li v-for="item in panel.bonds" :key="item.id" class="relations-row">
            <span class="relations-text"><b>{{ item.firstName }}</b> × <b>{{ item.secondName }}</b></span>
            <span class="relations-tag">{{ bondLabel(item) }}</span>
            <button class="relations-action" type="button" :disabled="locked || panel.rerollPills <= 0" @click="reroll(item)">
              换缘（洗髓丹 1）
            </button>
          </li>
        </ul>
      </section>

      <details class="relations-rules">
        <summary>规则说明</summary>
        <p v-for="(rule, index) in panel.rules" :key="index" class="relations-hint">{{ rule }}</p>
      </details>
    </template>
  </section>
</template>

<style scoped>
.relations-dialog { display: grid; gap: 18px; background: #0c1e1a; color: #e6efe8; padding: 20px; border-radius: 12px; }
.relations-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
.relations-heading h2 { margin: 2px 0 0; font-size: 22px; letter-spacing: 2px; }
.eyebrow { margin: 0; font-size: 11px; letter-spacing: 3px; color: #9fb7a8; }
.relations-refresh, .relations-action, .relations-quiet, .relationsDialog select {
  appearance: none; border: 1px solid #2f4a3f; background: #12281f; color: #e6efe8;
  border-radius: 8px; padding: 7px 12px; font-size: 13px; cursor: pointer;
}
.relations-refresh:hover, .relations-action:hover, .relations-quiet:hover { border-color: #c9a86a; color: #f1dfb5; }
.relations-action:disabled, .relations-refresh:disabled, .relations-quiet:disabled { opacity: 0.45; cursor: not-allowed; }
.relations-quiet { background: transparent; }
.relations-summary { margin: 0; font-size: 13px; color: #b9d0c0; }
.relations-summary b { color: #f1dfb5; }
.relations-block { display: grid; gap: 10px; padding-top: 12px; border-top: 1px solid #1d3a2e; }
.relations-block h3 { margin: 0; font-size: 16px; color: #f1dfb5; letter-spacing: 1px; }
.relations-form { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
.relations-form label { display: grid; gap: 5px; font-size: 12px; color: #9fb7a8; }
.relations-form select { min-width: 150px; }
.relations-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.relations-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; background: #10241c; border: 1px solid #1d3a2e; border-radius: 8px; padding: 9px 12px; }
.relations-text { flex: 1 1 200px; font-size: 13px; }
.relations-text b { color: #f1dfb5; }
.relations-tag { font-size: 12px; color: #9fb7a8; border: 1px solid #2f4a3f; border-radius: 6px; padding: 2px 8px; }
.relations-hint { margin: 0; font-size: 12px; color: #8fa79a; line-height: 1.7; }
.relations-feedback { margin: 0; font-size: 13px; color: #cfe8b8; background: #142b1f; border: 1px solid #2f5a3f; border-radius: 8px; padding: 8px 12px; }
.relations-history summary, .relations-rules summary { cursor: pointer; font-size: 12px; color: #9fb7a8; }
.relations-history p { margin: 4px 0; }
@media (max-width: 520px) {
  .relations-form { flex-direction: column; align-items: stretch; }
  .relations-form select { width: 100%; }
}
</style>
