<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';

import type { DiscipleView, PublicSectView, SectStateView } from '../api/game';

/**
 * 切磋（二级弹窗内容）：各选一名弟子，胜负交给服务端判定。
 *
 * 攻方只能派未受伤的弟子；防方不检查伤势（打的是对方弟子，与对方状态无关）。
 */
const props = defineProps<{
  target: PublicSectView;
  state: SectStateView;
  busy: boolean;
}>();

const emit = defineEmits<{
  spar: [targetSectId: string, myDiscipleId: string, targetDiscipleId: string];
}>();

const myDiscipleId = ref('');
const targetDiscipleId = ref('');

/** 每秒推进一次「现在」：疗伤到期后自动恢复可选，不必等下一次 sync。 */
const nowTick = ref(Date.now());
const clock = window.setInterval(() => {
  nowTick.value = Date.now();
}, 1000);

onUnmounted(() => {
  window.clearInterval(clock);
});

/** 受伤弟子不能作为攻方出战（与服务端 `injured_until > now` 同一判定）。 */
function isInjured(disciple: DiscipleView): boolean {
  if (disciple.injuredUntil === null) {
    return false;
  }
  return Date.parse(disciple.injuredUntil) > nowTick.value;
}

const myAvailable = computed(() => props.state.disciples.filter((disciple) => !isInjured(disciple)));

const canSubmit = computed(
  () => !props.busy && myDiscipleId.value !== '' && targetDiscipleId.value !== '',
);

function submit(): void {
  if (!canSubmit.value) {
    return;
  }
  emit('spar', props.target.sectId, myDiscipleId.value, targetDiscipleId.value);
}
</script>

<template>
  <section class="spar-dialog" aria-labelledby="spar-title">
    <header class="section-heading panel-heading compact-heading">
      <div>
        <p class="eyebrow">以武会友</p>
        <h2 id="spar-title">{{ target.name }}</h2>
      </div>
      <span class="count-badge">切磋</span>
    </header>

    <p class="spar-note">双方各派一名弟子，战力高者胜。胜者 +10 声望与 5000 灵石，败者与平局无损失。</p>

    <div class="party-select">
      <div class="party-select-head">
        <span class="eyebrow">己方出战（未受伤 {{ myAvailable.length }} 位）</span>
      </div>
      <label
        v-for="disciple in myAvailable"
        :key="disciple.id"
        class="party-member"
        :class="{ 'is-picked': myDiscipleId === disciple.id }"
      >
        <input v-model="myDiscipleId" type="radio" name="spar-mine" :value="disciple.id" />
        <span>{{ disciple.name }}（{{ disciple.stageName }} · 攻 {{ disciple.attack }} 防 {{ disciple.defense }} 速 {{ disciple.speed }} · {{ disciple.talentName }}）</span>
      </label>
      <p v-if="myAvailable.length === 0" class="blocked-hint">门下弟子都在疗伤，暂时无人可出战。</p>
    </div>

    <div class="party-select">
      <div class="party-select-head">
        <span class="eyebrow">对方出战（{{ target.disciples.length }} 位可选）</span>
      </div>
      <label
        v-for="disciple in target.disciples"
        :key="disciple.id"
        class="party-member"
        :class="{ 'is-picked': targetDiscipleId === disciple.id }"
      >
        <input v-model="targetDiscipleId" type="radio" name="spar-theirs" :value="disciple.id" />
        <span>{{ disciple.name }}（{{ disciple.stageName }} · 攻 {{ disciple.attack }} 防 {{ disciple.defense }} 速 {{ disciple.speed }} · {{ disciple.talentName }}）</span>
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
      <span>出手</span>
    </button>
    <p v-if="!canSubmit && !busy" class="blocked-hint">双方各选一名弟子后即可出手。</p>
  </section>
</template>
