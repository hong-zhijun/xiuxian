<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';

import type { DiscipleView, SecretRealmView, SectStateView } from '../api/game';
import { formatAmount } from '../utils/format';

/**
 * 选人出征（二级弹窗内容）。
 *
 * 只负责选人与本地校验；战力、成功率、扣资源、弟子受伤全部由服务端判定。
 * 提交后由父级关闭本弹窗并调接口。
 */
const props = defineProps<{
  realm: SecretRealmView;
  state: SectStateView;
  busy: boolean;
}>();

const emit = defineEmits<{
  explore: [realmId: string, discipleIds: string[]];
}>();

const selected = ref<string[]>([]);

/** 每秒推进一次「现在」：疗伤到期后自动恢复可选，不必等下一次 sync。 */
const nowTick = ref(Date.now());
const clock = window.setInterval(() => {
  nowTick.value = Date.now();
}, 1000);

onUnmounted(() => {
  window.clearInterval(clock);
});

/** 受伤弟子不能出战（与服务端 `injured_until > now` 同一判定，这里只用于界面）。 */
function isInjured(disciple: DiscipleView): boolean {
  if (disciple.injuredUntil === null) {
    return false;
  }
  return Date.parse(disciple.injuredUntil) > nowTick.value;
}

const injuredIds = computed(
  () => new Set(props.state.disciples.filter((disciple) => isInjured(disciple)).map((disciple) => disciple.id)),
);

const availableIds = computed(() =>
  props.state.disciples.filter((disciple) => !isInjured(disciple)).map((disciple) => disciple.id),
);

const resourceNameMap = computed<Record<string, string>>(() =>
  Object.fromEntries(props.state.resources.map((resource) => [resource.id, resource.name])),
);

/** 打着打着受伤/离队的弟子从名单里剔除，避免拿着无效队伍点「出发」。 */
watch(
  () => props.state,
  () => {
    selected.value = selected.value.filter((id) => !injuredIds.value.has(id));
  },
);

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

/** 已勾选的可以取消；受伤的不能选；满员后其余不能选。 */
function canPick(discipleId: string): boolean {
  if (injuredIds.value.has(discipleId)) {
    return false;
  }
  return selected.value.includes(discipleId) || selected.value.length < props.realm.maxParty;
}

/** 按队伍上限自动挑人（挑不齐最少人数时不点也行，只是省事）。 */
function pickUpToMax(): void {
  selected.value = availableIds.value.slice(0, props.realm.maxParty);
}

const canSubmit = computed(
  () =>
    !props.busy
    && selected.value.length >= props.realm.minParty
    && selected.value.length <= props.realm.maxParty,
);

function submit(): void {
  if (!canSubmit.value) {
    return;
  }
  emit('explore', props.realm.id, [...selected.value]);
}
</script>

<template>
  <section class="explore-party" aria-labelledby="explore-party-title">
    <header class="section-heading panel-heading compact-heading">
      <div>
        <p class="eyebrow">点将出征</p>
        <h2 id="explore-party-title">{{ realm.name }}</h2>
      </div>
      <span class="count-badge">{{ selected.length }}/{{ realm.maxParty }} 人</span>
    </header>

    <p class="realm-desc">{{ realm.description }}</p>

    <div class="realm-meta">
      <span>难度 {{ realm.difficulty }}</span>
      <span v-if="realm.dailyLimit === null">不限次数</span>
      <span v-else>次数 {{ realm.usedToday }}/{{ realm.dailyLimit }}</span>
      <span>队伍 {{ realm.minParty }}~{{ realm.maxParty }} 人</span>
    </div>

    <div class="realm-tags">
      <span class="tag-label">奖励</span>
      <span v-for="(amount, resourceId) in realm.rewards" :key="resourceId" class="reward-tag is-gain">
        {{ resourceNameMap[resourceId] ?? resourceId }} {{ formatAmount(amount) }}
      </span>
      <span class="tag-label">消耗</span>
      <span v-for="(amount, resourceId) in realm.entryCost" :key="resourceId" class="reward-tag is-cost">
        {{ resourceNameMap[resourceId] ?? resourceId }} {{ formatAmount(amount) }}
      </span>
    </div>

    <div class="party-select">
      <div class="party-select-head">
        <span class="eyebrow">选择弟子（{{ realm.minParty }}~{{ realm.maxParty }} 人）</span>
        <button class="quiet-button" type="button" @click="pickUpToMax">按上限自动选</button>
      </div>

      <label
        v-for="disciple in state.disciples"
        :key="disciple.id"
        class="party-member"
        :class="{ 'is-injured': injuredIds.has(disciple.id), 'is-picked': selected.includes(disciple.id) }"
      >
        <input
          type="checkbox"
          :checked="selected.includes(disciple.id)"
          :disabled="!canPick(disciple.id)"
          @change="toggle(disciple.id, $event)"
        />
        <span>{{ disciple.name }}（{{ disciple.stageName }} · 资质 {{ disciple.aptitude }}）</span>
        <small v-if="injuredIds.has(disciple.id)">疗伤中</small>
      </label>
    </div>

    <button
      class="action-button primary-action realm-button"
      :class="{ 'is-disabled': !canSubmit }"
      type="button"
      :disabled="busy"
      :aria-disabled="!canSubmit"
      @click="submit"
    >
      <span>出发探索（{{ selected.length }}/{{ realm.maxParty }}）</span>
    </button>

    <p v-if="selected.length < realm.minParty" class="blocked-hint">至少需要 {{ realm.minParty }} 名弟子</p>
  </section>
</template>
