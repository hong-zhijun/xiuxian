<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { DiscipleView } from '../api/game';
import ModalShell from './ModalShell.vue';

/**
 * 更换天赋（弟子详情天赋旁的「更换」）：两步都在这一个弹窗里。
 *
 * 1. 确认：显示剩余可洗次数与洗髓丹库存，点「使用洗髓丹」→ 上层调 use-pill，服务端洗出候选天赋；
 * 2. 选择：返回的 state 里有了 talentCandidate，弹窗自动切到二选一，选好点「确定」→ 上层调 talent-choice。
 *
 * 步骤完全由服务端字段 talentCandidate 决定：中途关掉弹窗，候选天赋仍保留，再点「更换」直接回到第 2 步。
 */
const props = defineProps<{
  disciple: DiscipleView;
  /** 洗髓丹库存（颗）。 */
  owned: number;
  /** 洗髓丹的名字（服务端配方名）。 */
  pillName: string;
  /** 不能服丹的原因（炼丹未开启 / 在外历练 / 重伤）；能服为 null。 */
  blockedReason: string | null;
  busy: boolean;
}>();

const emit = defineEmits<{
  use: [];
  choose: [accept: boolean];
  close: [];
}>();

const candidate = computed(() => props.disciple.talentCandidate);
/** 第 2 步的选择：'new' = 换成新天赋，'old' = 保留原天赋。 */
const picked = ref<'old' | 'new'>('new');
/** 已提交选择：等候选清空（state 回来）就关弹窗。 */
const submitted = ref(false);

watch(candidate, (value, previous) => {
  if (value !== null && previous === null) picked.value = 'new';
  if (value === null && submitted.value) emit('close');
});

const useBlocked = computed<string | null>(() => {
  if (props.blockedReason !== null) return props.blockedReason;
  if (props.disciple.talentRerollRemaining <= 0) return '洗髓次数已用尽';
  if (props.owned < 1) return `${props.pillName}库存不足，可在炼丹房炼制或用功勋兑换`;
  return null;
});

function use(): void {
  if (props.busy || useBlocked.value !== null) return;
  emit('use');
}

function confirmChoice(): void {
  if (props.busy || candidate.value === null) return;
  submitted.value = true;
  emit('choose', picked.value === 'new');
}
</script>

<template>
  <ModalShell narrow :loading="busy" :label="`更换天赋 · ${disciple.name}`" @close="emit('close')">
    <section class="talent-reroll" aria-labelledby="talent-reroll-title">
      <header class="section-heading panel-heading compact-heading">
        <div>
          <p class="eyebrow">{{ pillName }}</p>
          <h2 id="talent-reroll-title">更换天赋</h2>
        </div>
      </header>

      <!-- 第 1 步：确认使用洗髓丹 -->
      <template v-if="candidate === null">
        <dl class="disciple-facts">
          <div>
            <dt>当前天赋</dt>
            <dd>{{ disciple.talentName }}<span v-if="disciple.talentEffect"> · {{ disciple.talentEffect }}</span></dd>
          </div>
          <div>
            <dt>剩余可洗</dt>
            <dd>{{ disciple.talentRerollRemaining }} / {{ disciple.talentRerollUses + disciple.talentRerollRemaining }} 次</dd>
          </div>
          <div>
            <dt>{{ pillName }}</dt>
            <dd>库存 {{ owned }} 颗 · 本次消耗 1 颗</dd>
          </div>
        </dl>
        <p class="disciple-detail-hint">洗出一个与当前不同的新天赋，再从新旧两个里选一个保留。</p>
        <p v-if="useBlocked" class="blocked-hint">{{ useBlocked }}</p>
        <div class="talent-reroll-actions">
          <button class="upgrade-button" type="button" @click="emit('close')">取消</button>
          <button
            class="action-button primary-action"
            type="button"
            :disabled="busy || useBlocked !== null"
            @click="use"
          >
            使用{{ pillName }}
          </button>
        </div>
      </template>

      <!-- 第 2 步：二选一 -->
      <template v-else>
        <p class="disciple-detail-hint">洗出了新天赋，选择要保留的一个：</p>
        <div class="talent-reroll-options" role="radiogroup" aria-label="选择天赋">
          <button
            class="talent-reroll-option"
            :class="{ 'is-selected': picked === 'old' }"
            type="button"
            role="radio"
            :aria-checked="picked === 'old'"
            @click="picked = 'old'"
          >
            <span class="eyebrow">原天赋</span>
            <strong>{{ disciple.talentName }}</strong>
            <small>{{ disciple.talentEffect || '—' }}</small>
          </button>
          <button
            class="talent-reroll-option"
            :class="{ 'is-selected': picked === 'new' }"
            type="button"
            role="radio"
            :aria-checked="picked === 'new'"
            @click="picked = 'new'"
          >
            <span class="eyebrow">新天赋</span>
            <strong>{{ candidate.name }}</strong>
            <small>{{ candidate.effect }}</small>
          </button>
        </div>
        <p v-if="picked === 'new' && disciple.stewardOffice" class="blocked-hint">
          {{ disciple.name }}正在任执事：换成新天赋会同时卸任，进入交接期。
        </p>
        <div class="talent-reroll-actions">
          <button class="action-button primary-action" type="button" :disabled="busy" @click="confirmChoice">
            确定
          </button>
        </div>
      </template>
    </section>
  </ModalShell>
</template>
