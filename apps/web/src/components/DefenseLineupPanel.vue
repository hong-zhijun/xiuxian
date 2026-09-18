<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { DiscipleView, SectStateView } from '../api/game';

/**
 * 守擂阵容（弹窗内容）：预设 3 人按顺序迎战来犯之敌，顺序就是迎战顺序。
 *
 * 注意：守阵是预设行为，受伤弟子也可以放进去（服务端也不检查伤势）。
 */
const props = defineProps<{
  state: SectStateView;
  busy: boolean;
}>();

const emit = defineEmits<{
  setLineup: [discipleIds: string[]];
}>();

const LINEUP_SIZE = 3;

const selected = ref<string[]>([]);

/** 当前已生效的守擂阵容（null = 尚未布阵）。 */
const current = computed(() => props.state.sect.defenseLineup);

const discipleById = computed(
  () => new Map(props.state.disciples.map((disciple) => [disciple.id, disciple])),
);

/** 按战力从高到低展示，方便快速挑强的。 */
const sortedDisciples = computed(() =>
  [...props.state.disciples].sort((a, b) => b.combatPower - a.combatPower),
);

// 每隔一秒不必要；这里只在 state 变化时把已选同步成服务端的当前阵容。
watch(
  () => props.state.sect.defenseLineup,
  (lineup) => {
    selected.value = lineup === null ? [] : [...lineup];
  },
  { immediate: true },
);

function isPicked(discipleId: string): boolean {
  return selected.value.includes(discipleId);
}

/** 已选的可以取消；选满 3 人后其余不可选。 */
function canPick(discipleId: string): boolean {
  return isPicked(discipleId) || selected.value.length < LINEUP_SIZE;
}

function toggle(discipleId: string, event: Event): void {
  const checked = (event.target as HTMLInputElement).checked;
  const next = [...selected.value];
  const index = next.indexOf(discipleId);
  if (checked && index < 0) {
    next.push(discipleId);
  }
  if (!checked && index >= 0) {
    next.splice(index, 1);
  }
  selected.value = next;
}

function isInjured(disciple: DiscipleView): boolean {
  return disciple.injuredUntil !== null && Date.parse(disciple.injuredUntil) > Date.now();
}

const canSubmit = computed(() => !props.busy && selected.value.length === LINEUP_SIZE);

function submit(): void {
  if (!canSubmit.value) {
    return;
  }
  emit('setLineup', [...selected.value]);
}

function slotDisciple(discipleId: string): DiscipleView | undefined {
  return discipleById.value.get(discipleId);
}
</script>

<template>
  <section class="defense-lineup" aria-labelledby="defense-lineup-title">
    <header class="section-heading panel-heading compact-heading">
      <div>
        <p class="eyebrow">守擂阵容</p>
        <h2 id="defense-lineup-title">山门布阵</h2>
      </div>
      <span class="count-badge">{{ selected.length }}/{{ LINEUP_SIZE }} 人</span>
    </header>

    <p class="lineup-note">预设 3 人按顺序迎战来犯之敌；尚未布阵时别人无法挑战你。守阵是预设行为，受伤弟子也能入选。</p>

    <div class="lineup-current">
      <p class="eyebrow">当前阵容</p>
      <ol v-if="current && current.length > 0" class="lineup-slots">
        <li v-for="(discipleId, index) in current" :key="`${discipleId}-${index}`" class="lineup-slot">
          <span class="slot-index">{{ index + 1 }}</span>
          <template v-if="slotDisciple(discipleId)">
            <span class="slot-name">{{ slotDisciple(discipleId)?.name }}</span>
            <span class="public-tag">{{ slotDisciple(discipleId)?.stageName }}</span>
            <span class="public-tag">战力 {{ slotDisciple(discipleId)?.combatPower }}</span>
          </template>
          <span v-else class="slot-name slot-gone">已离宗</span>
        </li>
      </ol>
      <p v-else class="lineup-empty">尚未布阵</p>
    </div>

    <div class="party-select">
      <div class="party-select-head">
        <span class="eyebrow">选择迎战弟子（按战力排序）</span>
      </div>
      <label
        v-for="disciple in sortedDisciples"
        :key="disciple.id"
        class="party-member"
        :class="{ 'is-picked': isPicked(disciple.id), 'is-injured': isInjured(disciple) }"
      >
        <input
          type="checkbox"
          :checked="isPicked(disciple.id)"
          :disabled="!canPick(disciple.id)"
          @change="toggle(disciple.id, $event)"
        />
        <span>
          {{ disciple.name }}（{{ disciple.stageName }} · 攻 {{ disciple.attack }} 防 {{ disciple.defense }}
          速 {{ disciple.speed }} · 战力 {{ disciple.combatPower }}）
        </span>
        <small v-if="isInjured(disciple)">疗伤中</small>
      </label>
      <p v-if="sortedDisciples.length === 0" class="blocked-hint">门下还没有弟子。</p>
    </div>

    <button
      class="action-button primary-action realm-button"
      :class="{ 'is-disabled': !canSubmit }"
      type="button"
      :disabled="busy"
      :aria-disabled="!canSubmit"
      @click="submit"
    >
      <span>确认阵容</span>
    </button>
    <p v-if="selected.length !== LINEUP_SIZE" class="blocked-hint">
      请选择 {{ LINEUP_SIZE }} 名弟子（当前 {{ selected.length }} 名）
    </p>
  </section>
</template>
