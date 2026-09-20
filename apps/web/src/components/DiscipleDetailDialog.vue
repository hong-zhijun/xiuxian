<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import type { AlchemyRecipeView, DiscipleView, SectStateView } from '../api/game';
import type { ToastTone } from '../types/ui';
import { formatAmount, formatBp, formatTime } from '../utils/format';
import { NOTE_MAX_LENGTH, cultivationProgress, isInjured } from '../utils/discipleFilter';
import AssignmentSelect from './AssignmentSelect.vue';
import DiscipleRadarChart from './DiscipleRadarChart.vue';
import ModalShell from './ModalShell.vue';

/**
 * 弟子详情（弹窗内容）：姓名 / 备注 / 境界修为 / 岗位 / 四轴雷达图 / 属性 / 伤势 / 破境 /
 * 丹药选择入口 / 驱逐。丹药列表只在玩家点击入口后通过二级弹窗展示。
 *
 * 组件只拿 `discipleId` 对应的最新对象（由 SectScreen 每次渲染从 `state.disciples` 里取），
 * 自己不发请求、不复制任何服务端判定公式：能不能破境看 `canBreakthrough`，
 * 能不能服药看 `alchemy` 与字段预览，最终裁决都在 `/game/*`。
 * 所有写操作都只 emit，成功后弹窗保持打开并显示服务端回填的新值；
 * 驱逐成功时该弟子会从 `state.disciples` 消失，由 SectScreen 关掉弹窗。
 */
const props = defineProps<{
  state: SectStateView;
  disciple: DiscipleView;
  busy: boolean;
  /** 每秒本地平滑的修为（只用于显示）；null = 用服务端值。 */
  liveCultivation: number | null;
}>();

const emit = defineEmits<{
  assign: [discipleId: string, assignment: string];
  breakthrough: [discipleId: string];
  usePill: [pillId: string, discipleId: string];
  saveNote: [discipleId: string, note: string];
  expel: [discipleId: string];
  notify: [tone: ToastTone, title: string, message: string];
}>();

const serverNowMs = computed(() => Date.parse(props.state.serverNow));
const injured = computed(() => isInjured(props.disciple, serverNowMs.value));

const progress = computed(() =>
  cultivationProgress(
    props.liveCultivation ?? props.disciple.cultivation,
    props.disciple.requiredCultivation,
  ),
);

const energyName = computed(
  () => props.state.resources.find((resource) => resource.id === 'spiritualEnergy')?.name ?? '灵气',
);

/* ---------- 私有备注：单行 input，保存时 trim，空串 = 清空 ---------- */

const noteDraft = ref(props.disciple.note);
const serverNote = computed(() => props.disciple.note);
const noteLength = computed(() => Array.from(noteDraft.value).length);
const noteTooLong = computed(() => noteLength.value > NOTE_MAX_LENGTH);
/** 与服务端已保存内容（trim 后）不同才允许保存。 */
const noteDirty = computed(() => noteDraft.value.trim() !== serverNote.value);

// 服务端返回了新备注（保存成功、或服务端做了 trim）而本地没有未保存改动时，跟随服务端值。
watch(serverNote, (next) => {
  if (!noteDirty.value) noteDraft.value = next;
});

function onNoteInput(event: Event): void {
  noteDraft.value = (event.target as HTMLInputElement).value;
}

function saveNote(): void {
  if (props.busy || !noteDirty.value || noteTooLong.value) return;
  const note = noteDraft.value.trim();
  noteDraft.value = note;
  emit('saveNote', props.disciple.id, note);
}

/* ---------- 破境：判定与胜算/消耗全部来自服务端 ---------- */

function requestBreakthrough(): void {
  if (props.busy) return;
  if (!props.disciple.canBreakthrough) {
    emit(
      'notify',
      'warning',
      `${props.disciple.name}暂不可突破`,
      props.disciple.blockedReason ?? '当前条件尚未满足。',
    );
    return;
  }
  emit('breakthrough', props.disciple.id);
}

/* ---------- 丹药：详情只保留入口，点击后打开选择弹窗 ---------- */

const ATTRIBUTE_NAMES: Record<string, string> = { attack: '攻击', defense: '防御', speed: '身法' };
const PILL_ORDER = ['healingPill', 'cultivationPill', 'bodyTemperingPill'] as const;
const showPillPicker = ref(false);

interface PillOption {
  pillId: string;
  name: string;
  description: string;
  owned: number;
  /** 规则上可以服用（库存与最终裁决仍在服务端）。 */
  available: boolean;
  /** 本次效果预览（不可用时为空）。 */
  preview: string;
  /** 不可用 / 无库存时的原因。 */
  disabledReason: string;
}

const pillOptions = computed<PillOption[]>(() => {
  const byId = new Map<string, AlchemyRecipeView>(
    props.state.alchemy.recipes.map((recipe) => [recipe.id, recipe]),
  );
  const locked = !props.state.alchemy.unlocked;
  const lockedReason = props.state.alchemy.blockedReason ?? '炼丹尚未开启';
  // 单次增益由服务端下发（view.alchemy.cultivationPillGain），前端不复制这个常量。
  const gainPerPill = props.state.alchemy.cultivationPillGain;
  const disciple = props.disciple;
  const options: PillOption[] = [];

  for (const pillId of PILL_ORDER) {
    const recipe = byId.get(pillId);
    if (recipe === undefined) continue;

    let available = false;
    let preview = '';
    let reason = '';

    if (pillId === 'healingPill') {
      available = injured.value;
      preview = '清除伤势，立刻可再出战或突破';
      reason = '当前无恙，无需疗伤';
    } else if (pillId === 'cultivationPill') {
      const required = disciple.requiredCultivation;
      if (required === null) {
        reason = '已达当前版本上限，无法再靠丹药精进';
      } else {
        available = disciple.cultivation < required;
        preview = `修为 +${Math.min(gainPerPill, required - disciple.cultivation)}（达到 ${required} 门槛为止）`;
        reason = '修为已达门槛，无需进补';
      }
    } else {
      const target = disciple.bodyTemperingTarget;
      available = target !== null;
      preview =
        target === null
          ? ''
          : `本次补：${ATTRIBUTE_NAMES[target] ?? target} +${disciple.bodyTemperingGain}（已服 ${disciple.bodyTemperingUses} 次 · 剩余 ${disciple.bodyTemperingRemaining} 次）`;
      reason = '已无属性短板或淬体次数已用尽';
    }

    if (locked) {
      available = false;
      reason = lockedReason;
    }

    options.push({
      pillId,
      name: recipe.name,
      description: recipe.description,
      owned: recipe.owned,
      available,
      preview: available ? preview : '',
      disabledReason: available && recipe.owned < 1 ? '丹药库存不足，请先炼制' : reason,
    });
  }
  return options;
});

function usePill(option: PillOption): void {
  if (props.busy) return;
  if (!option.available || option.owned < 1) {
    emit('notify', 'warning', `暂不可服用${option.name}`, option.disabledReason);
    return;
  }
  showPillPicker.value = false;
  emit('usePill', option.pillId, props.disciple.id);
}

/* ---------- 驱逐：只在详情底部，二次确认后才 emit ---------- */
const confirmingExpel = ref(false);
/**
 * 本次是否由自己提交过驱逐请求：只用来把按钮文案切成「驱逐中…」。
 * 任何 busy 结束（含其他操作、同步轮询）都要复位，否则别的操作在途时会误导性地显示「驱逐中…」。
 */
const expelSubmitted = ref(false);
const expelTrigger = ref<HTMLButtonElement | null>(null);
const expelConfirm = ref<HTMLButtonElement | null>(null);

watch(
  () => props.busy,
  (next) => {
    if (!next) expelSubmitted.value = false;
  },
);

function askExpel(): void {
  confirmingExpel.value = true;
  void nextTick(() => expelConfirm.value?.focus());
}

function cancelExpel(): void {
  confirmingExpel.value = false;
  void nextTick(() => expelTrigger.value?.focus());
}

function confirmExpel(): void {
  if (props.busy) return;
  expelSubmitted.value = true;
  emit('expel', props.disciple.id);
}
</script>

<template>
  <section class="disciple-detail">
    <header class="section-heading panel-heading compact-heading">
      <div>
        <p class="eyebrow">门人详情</p>
        <h2 class="disciple-detail-name">{{ disciple.name }}</h2>
      </div>
      <span class="count-badge">{{ disciple.gender === 'female' ? '坤' : '乾' }} · 战力 {{ disciple.combatPower }}</span>
    </header>

    <section class="disciple-detail-section" aria-labelledby="disciple-note-title">
      <h3 id="disciple-note-title" class="disciple-detail-title">私有备注</h3>
      <div class="disciple-note-row">
        <input
          class="disciple-input"
          type="text"
          aria-label="私有备注"
          placeholder="只有你看得到，可留空"
          :value="noteDraft"
          @input="onNoteInput"
        />
        <button
          class="action-button disciple-note-save"
          :class="{ 'is-dirty': noteDirty }"
          type="button"
          :disabled="busy || !noteDirty || noteTooLong"
          @click="saveNote"
        >
          保存
        </button>
      </div>
      <p class="disciple-note-meta" :class="{ 'is-error': noteTooLong }" role="status">
        {{ noteLength }}/{{ NOTE_MAX_LENGTH }} 字 · {{ noteTooLong ? '备注超出字数上限' : '保存空内容即清空这条备注' }}
      </p>
    </section>

    <section class="disciple-detail-section" aria-labelledby="disciple-realm-title">
      <h3 id="disciple-realm-title" class="disciple-detail-title">境界与修为</h3>
      <p class="disciple-detail-realm">
        <span class="realm-tag">{{ disciple.stageName }}</span>
        <span>{{ disciple.realmName }}</span>
      </p>
      <div class="disciple-detail-progress">
        <span>{{ progress.text }}</span>
        <span>{{ progress.percent }}%</span>
      </div>
      <div
        class="disciple-cultivation-track"
        role="progressbar"
        aria-label="修为进境"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="progress.percent"
        :aria-valuetext="progress.text"
      >
        <span :style="{ width: `${progress.percent}%` }" />
      </div>
      <p class="disciple-detail-hint">
        {{
          progress.capped
            ? '已达当前版本上限：修为不再增长，满环也不代表可以破境。'
            : `静修 +${disciple.cultivationRatePerHour}/时`
        }}
      </p>
    </section>

    <section class="disciple-detail-section" aria-labelledby="disciple-attr-title">
      <h3 id="disciple-attr-title" class="disciple-detail-title">资质与战斗属性</h3>
      <DiscipleRadarChart
        :name="disciple.name"
        :aptitude="disciple.aptitude"
        :attack="disciple.attack"
        :defense="disciple.defense"
        :speed="disciple.speed"
      />
      <div class="disciple-stats">
        <span class="stat-tag stat-talent">天赋 {{ disciple.talentName }}</span>
        <span class="stat-tag stat-power">战力 {{ disciple.combatPower }}</span>
      </div>
      <p class="disciple-detail-hint">资质影响修炼速度，不直接计入战力；战力由服务端按攻防速与境界算出。</p>
    </section>

    <section class="disciple-detail-section" aria-labelledby="disciple-job-title">
      <h3 id="disciple-job-title" class="disciple-detail-title">当前差遣</h3>
      <AssignmentSelect
        :model-value="disciple.assignment"
        :options="state.assignments"
        :disabled="busy"
        :label="disciple.name"
        @change="emit('assign', disciple.id, $event)"
      />
    </section>

    <section class="disciple-detail-section" aria-labelledby="disciple-injury-title">
      <h3 id="disciple-injury-title" class="disciple-detail-title">伤势</h3>
      <p v-if="injured" class="disciple-detail-injury">
        疗伤中 · 预计 {{ formatTime(disciple.injuredUntil) }} 复原
      </p>
      <p v-else class="disciple-detail-hint">无恙，可以出战、探索与破境。</p>
    </section>

    <section class="disciple-detail-section" aria-labelledby="disciple-break-title">
      <h3 id="disciple-break-title" class="disciple-detail-title">破境</h3>
      <dl class="disciple-facts">
        <div>
          <dt>破境胜算</dt>
          <dd>{{ formatBp(disciple.breakthroughChanceBp) }}</dd>
        </div>
        <div>
          <dt>灵气消耗</dt>
          <dd>{{ formatAmount(disciple.breakthroughCost) }} {{ energyName }}</dd>
        </div>
      </dl>
      <p v-if="disciple.blockedReason" class="blocked-hint">{{ disciple.blockedReason }}</p>
      <button
        class="action-button primary-action disciple-break-button"
        :class="{ 'is-disabled': !disciple.canBreakthrough }"
        type="button"
        :disabled="busy"
        :aria-disabled="!disciple.canBreakthrough"
        @click="requestBreakthrough"
      >
        <span>破境</span>
      </button>
    </section>

    <section class="disciple-detail-section" aria-labelledby="disciple-pill-title">
      <h3 id="disciple-pill-title" class="disciple-detail-title">丹药服用</h3>
      <p v-if="!state.alchemy.unlocked" class="blocked-hint">
        {{ state.alchemy.blockedReason ?? '炼丹尚未开启' }}
      </p>
      <button
        class="action-button primary-action disciple-pill-launch"
        type="button"
        :disabled="busy || !state.alchemy.unlocked"
        @click="showPillPicker = true"
      >
        服用丹药
      </button>
      <p class="disciple-detail-hint">点击后选择丹药；配方炼制仍在「炼丹」面板。</p>
    </section>

    <section class="disciple-detail-section disciple-danger" aria-labelledby="disciple-expel-title">
      <h3 id="disciple-expel-title" class="disciple-detail-title">驱逐出师门</h3>

      <template v-if="!confirmingExpel">
        <p class="disciple-detail-hint">
          驱逐后该弟子不再属于本宗，其占用的岗位收益同时结算。
        </p>
        <button
          ref="expelTrigger"
          class="action-button disciple-danger-button"
          type="button"
          :disabled="busy"
          @click="askExpel"
        >
          驱逐弟子
        </button>
      </template>

      <div v-else class="disciple-expel-confirm" role="group" aria-labelledby="disciple-expel-confirm-title">
        <p id="disciple-expel-confirm-title" class="disciple-expel-question">
          确认驱逐「{{ disciple.name }}」？
        </p>
        <ul class="disciple-expel-warnings">
          <li>不返还培养消耗的资源与已用招募次数，也不降低宗门等级。</li>
          <li>若他在守擂阵容中，阵容会被清空，需要重新布阵。</li>
          <li>门下不足 3 人时无法组成主动挑战阵容，也无法被其他宗门挑战。</li>
        </ul>
        <div class="disciple-expel-actions">
          <button class="action-button" type="button" :disabled="busy" @click="cancelExpel">取消</button>
          <button
            ref="expelConfirm"
            class="action-button primary-action disciple-expel-confirm-button"
            type="button"
            :disabled="busy"
            @click="confirmExpel"
          >
            {{ busy && expelSubmitted ? '驱逐中…' : '确认驱逐' }}
          </button>
        </div>
      </div>
    </section>

    <ModalShell
      v-if="showPillPicker"
      narrow
      :label="`选择丹药 · ${disciple.name}`"
      @close="showPillPicker = false"
    >
      <section class="disciple-pill-picker" aria-labelledby="disciple-pill-picker-title">
        <header class="section-heading panel-heading compact-heading">
          <div>
            <p class="eyebrow">丹库</p>
            <h2 id="disciple-pill-picker-title">选择要服用的丹药</h2>
          </div>
        </header>
        <ul class="disciple-pill-list">
          <li
            v-for="option in pillOptions"
            :key="option.pillId"
            class="disciple-pill"
            :class="{ 'is-blocked': !option.available || option.owned < 1 }"
          >
            <div class="disciple-pill-copy">
              <div class="disciple-pill-title">
                <strong>{{ option.name }}</strong>
                <span class="alchemy-owned">库存 {{ option.owned }}</span>
              </div>
              <p class="disciple-pill-desc">{{ option.description }}</p>
              <p v-if="option.available && option.preview !== ''" class="disciple-pill-effect">
                本次效果：{{ option.preview }}
              </p>
              <p v-if="!option.available || option.owned < 1" class="blocked-hint">
                {{ option.owned < 1 ? '丹药库存不足，请先炼制' : option.disabledReason }}
              </p>
            </div>
            <button
              class="upgrade-button disciple-pill-button"
              type="button"
              :disabled="busy || !option.available || option.owned < 1"
              @click="usePill(option)"
            >
              <span>选择</span>
            </button>
          </li>
        </ul>
      </section>
    </ModalShell>
  </section>
</template>
