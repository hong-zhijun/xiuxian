<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import type {
  AlchemyRecipeView,
  DiscipleJourneyView,
  DiscipleView,
  JourneyDirection,
  JourneyDirectionPreviewView,
  JourneyDurationPreviewView,
  JourneyOutcomeView,
  JourneyPreviewView,
  JourneyRecordView,
  SectStateView,
} from '../api/game';
import type { ToastTone } from '../types/ui';
import { formatAmount, formatBp, formatTime } from '../utils/format';
import { NOTE_MAX_LENGTH, cultivationProgress, isInjured } from '../utils/discipleFilter';
import AssignmentSelect from './AssignmentSelect.vue';
import DiscipleRadarChart from './DiscipleRadarChart.vue';
import ModalShell from './ModalShell.vue';

/**
 * 弟子详情（弹窗内容）：姓名 / 备注 / 境界修为 / 岗位 / 四轴雷达图 / 属性 / 伤势 / 破境 /
 * 丹药选择入口 / 驱逐；0014 起追加「历练」区域（在外倒计时、返程结果与最近记录）。
 * 丹药列表只在玩家点击入口后通过二级弹窗展示。
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
  /** 0014 历练预览（由 SectScreen 拉取与清理；本组件只渲染，不发请求）。 */
  journeyPreview: JourneyPreviewView | null;
  /** 预览请求在途（决定按钮的「推演中…」文案）。 */
  journeyPreviewLoading: boolean;
  /** 宗门最近历练记录（最多 10 条，来自 state.journey.recent，关掉弹窗也不会丢）。 */
  journeyRecent: JourneyRecordView[];
  /** 本地推进的服务端时钟（归队倒计时只读它，绝不读 Date.now()）。 */
  localNowMs: number;
}>();

const emit = defineEmits<{
  assign: [discipleId: string, assignment: string];
  breakthrough: [discipleId: string];
  usePill: [pillId: string, discipleId: string];
  saveNote: [discipleId: string, note: string];
  expel: [discipleId: string];
  /** 0014 历练：拉预览 / 出发 / 领取。组件只 emit，请求与 state 回填都在上层。 */
  requestJourneyPreview: [discipleId: string];
  startJourney: [discipleId: string, direction: JourneyDirection, durationSeconds: number];
  claimJourney: [journeyId: string];
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

/* ---------- 0014 历练：状态、方向/时长选择与归队倒计时 ---------- */

/** 服务端给的历练状态与名额：本组件不复制任何门槛、奖励或概率公式。 */
const journey = computed<DiscipleJourneyView>(() => props.disciple.journey);
const outcome = computed<JourneyOutcomeView | null>(() => props.disciple.journey.outcome);

/** 资源 id → 名字（名字只在服务端的资源表里，前端不硬编码）。 */
const resourceNames = computed<Record<string, string>>(() =>
  Object.fromEntries(props.state.resources.map((resource) => [resource.id, resource.name])),
);

function resourceLabel(resourceId: string): string {
  return resourceNames.value[resourceId] ?? resourceId;
}

/** 奖励条目（名字与数量都格式化好）：模板只渲染，不在 v-for 里做取值判断。 */
interface ResourceLine {
  id: string;
  name: string;
  amount: string;
}

function resourceLines(resources: Record<string, string>): ResourceLine[] {
  return Object.entries(resources).map(([id, amount]) => ({
    id,
    name: resourceLabel(id),
    amount: formatAmount(amount),
  }));
}

/**
 * 出发前的计划器：只有预览属于当前弟子时才生效
 * （切换弟子后残留的旧预览直接忽略，绝不显示别人的数值）。
 */
const planner = computed<JourneyPreviewView | null>(() => {
  const preview = props.journeyPreview;
  if (preview === null || preview.discipleId !== props.disciple.id) return null;
  return preview;
});

/** 选中的方向/时长放在 ref 里：请求失败时保留当前选择，不会被打回默认值。 */
const selectedDirection = ref<JourneyDirection | null>(null);
const selectedDurationSeconds = ref<number | null>(null);

/** 生效方向：显式选中的可用方向，否则回落到第一个可选方向（不可选的不参与）。 */
const activeDirection = computed<JourneyDirectionPreviewView | null>(() => {
  const directions = planner.value?.directions ?? [];
  const picked = directions.find((item) => item.direction === selectedDirection.value);
  if (picked !== undefined && picked.available) return picked;
  return directions.find((item) => item.available) ?? null;
});

const activeDurations = computed<JourneyDurationPreviewView[]>(
  () => activeDirection.value?.durations ?? [],
);

/** 生效时长：显式选中的那一档，否则该方向的第一档（服务端给什么就显示什么）。 */
const activeDuration = computed<JourneyDurationPreviewView | null>(() => {
  const durations = activeDurations.value;
  const picked = durations.find((item) => item.durationSeconds === selectedDurationSeconds.value);
  return picked ?? durations[0] ?? null;
});

/** 这两个是给模板做「选中态」比较的原始值，避免在 v-for 里层层解引用。 */
const activeDirectionId = computed<JourneyDirection | null>(
  () => activeDirection.value?.direction ?? null,
);
const activeDurationSeconds = computed<number | null>(
  () => activeDuration.value?.durationSeconds ?? null,
);

function requestPreview(): void {
  if (props.busy || props.journeyPreviewLoading) return;
  emit('requestJourneyPreview', props.disciple.id);
}

function selectDirection(direction: JourneyDirectionPreviewView): void {
  if (props.busy || !direction.available) return;
  selectedDirection.value = direction.direction;
  // 换了方向后旧时长不一定还在，清空选择让它回落到该方向的第一档。
  selectedDurationSeconds.value = null;
}

function selectDuration(duration: JourneyDurationPreviewView): void {
  if (props.busy) return;
  selectedDurationSeconds.value = duration.durationSeconds;
}

function confirmStart(): void {
  if (props.busy) return;
  const direction = activeDirection.value;
  const duration = activeDuration.value;
  if (direction === null || duration === null) return;
  emit('startJourney', props.disciple.id, direction.direction, duration.durationSeconds);
}

function requestClaim(): void {
  if (props.busy) return;
  const journeyId = journey.value.journeyId;
  if (journeyId === null) return;
  emit('claimJourney', journeyId);
}

/** 修为预览：最高阶段为 0；受当前突破门槛限制时标「最多」（数值都来自服务端）。 */
function cultivationText(duration: JourneyDurationPreviewView): string {
  if (duration.cultivation <= 0) return '修为无增益';
  return `修为 +${duration.cultivation}${duration.cultivationCapped ? '（最多）' : ''}`;
}

/** 时长展示：两档都是整小时，把服务端给的秒数换算成小时。 */
function durationHours(seconds: number | null): string {
  if (seconds === null) return '—';
  return `${Math.round(seconds / 3600)} 小时`;
}

/** 入场错峰：只给前几项延迟，避免长列表末尾等太久（与名册行的做法一致）。 */
function journeyOrderStyle(index: number): Record<string, string> {
  return { '--journey-order': String(Math.min(index, 6)) };
}

/**
 * 在外剩余时间：只用 `localNowMs`（SectScreen 从服务端 serverNow 逐秒推进）计算，
 * 不读 `Date.now()`。归零也只显示「即将归队」——能不能领取由服务端的 status 决定，
 * 前端计时器不能自行判定可领取。
 */
const countdownText = computed<string>(() => {
  const endsAt = journey.value.endsAt;
  if (endsAt === null) return '—';
  const endsAtMs = Date.parse(endsAt);
  if (!Number.isFinite(endsAtMs) || !Number.isFinite(props.localNowMs)) return '—';
  const remainingMs = endsAtMs - props.localNowMs;
  if (remainingMs <= 0) return '即将归队';
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours} 时 ${String(minutes).padStart(2, '0')} 分 ${ss} 秒`;
  return `${minutes} 分 ${ss} 秒`;
});

/** 结果里的伤势是否已过复原时间（过期仍保留「途中受伤」的结果文字）。 */
const outcomeHealed = computed<boolean>(() => {
  const injuredUntil = outcome.value?.injuredUntil ?? null;
  if (injuredUntil === null) return false;
  const until = Date.parse(injuredUntil);
  if (!Number.isFinite(until) || !Number.isFinite(props.localNowMs)) return false;
  return until <= props.localNowMs;
});

const outcomeLines = computed<ResourceLine[]>(() => resourceLines(outcome.value?.resources ?? {}));

/** 在外时被历练挡住的写操作共用这一句原因（规则仍由服务端判定）。 */
const awayHint = computed<string | null>(() =>
  journey.value.status === 'active' ? '在外历练期间不能转岗、破境、服药或再次出发。' : null,
);

/** 驱逐被历练挡住时的原因：在外与待领取措辞分开，玩家才知道下一步该做什么。 */
const expelBlockedHint = computed<string | null>(() => {
  if (journey.value.status === 'active') return '在外历练中不能驱逐，请等他归队。';
  if (journey.value.status === 'ready') return '先领取历练收获后才能驱逐。';
  return null;
});

/** 最近记录（来自 state.journey.recent）：结果文字在这里拼好，模板只渲染。 */
interface JournalEntry {
  id: string;
  discipleName: string;
  directionName: string;
  durationText: string;
  status: JourneyRecordView['status'];
  statusLabel: string;
  resultLines: string[];
}

const RECORD_STATUS_LABELS: Record<JourneyRecordView['status'], string> = {
  active: '在外中',
  ready: '待领取',
  claimed: '已领取',
};

/** 结果摘要：受伤与额外收获都必须有文字，不能只靠 Toast（计划 5）。 */
function recordResultLines(record: JourneyRecordView): string[] {
  const recordOutcome = record.outcome;
  if (recordOutcome === null) {
    return [`预计 ${formatTime(record.endsAt)} 归队，结果到期后可见。`];
  }
  const lines = [
    recordOutcome.cultivationAwarded > 0 ? `修为 +${recordOutcome.cultivationAwarded}` : '修为无增益',
  ];
  for (const entry of resourceLines(recordOutcome.resources)) {
    lines.push(`${entry.name} +${entry.amount}`);
  }
  if (recordOutcome.extraHarvest) lines.push('额外收获');
  if (recordOutcome.injured) lines.push('途中受伤');
  return lines;
}

const journal = computed<JournalEntry[]>(() =>
  props.journeyRecent.map((record) => ({
    id: record.id,
    discipleName: record.discipleName,
    directionName: record.directionName,
    durationText: durationHours(record.durationSeconds),
    status: record.status,
    statusLabel: RECORD_STATUS_LABELS[record.status],
    resultLines: recordResultLines(record),
  })),
);

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
  // 在外历练期间服务端会拒绝服药，这里同步挡住（按钮已禁用，兜底键盘/程序化触发）。
  if (journey.value.status === 'active') {
    emit('notify', 'warning', `${props.disciple.name}正在外历练`, awayHint.value ?? '在外历练期间不能服药。');
    return;
  }
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
  // 在外 / 待领取都会被服务端拒绝驱逐，这里同步挡住入口并说明原因。
  if (props.busy || journey.value.status !== 'none') return;
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
        :disabled="busy || journey.status === 'active'"
        :label="disciple.name"
        @change="emit('assign', disciple.id, $event)"
      />
      <p v-if="awayHint" class="blocked-hint">{{ awayHint }}</p>
    </section>

    <!-- 0014 历练：状态、名额与预览都由服务端给；这里只渲染与选中。 -->
    <section class="disciple-detail-section disciple-journey" aria-labelledby="disciple-journey-title">
      <h3 id="disciple-journey-title" class="disciple-detail-title">历练</h3>
      <p class="disciple-journey-quota">
        在外 <strong>{{ state.journey.activeCount }}</strong>/{{ state.journey.maxConcurrent }} 人 · 至少留守
        {{ state.journey.minAtHome }} 人
      </p>

      <template v-if="journey.status === 'none'">
        <!-- 不可出发时只显示服务端的原因（筑基门槛 / 疗伤中 / 名额已满 / 在守擂阵容中）。 -->
        <template v-if="!journey.canStart">
          <p class="blocked-hint">{{ journey.blockedReason ?? '当前不可出发' }}</p>
          <button class="action-button primary-action disciple-journey-start" type="button" disabled>
            <span>确认出发</span>
          </button>
        </template>

        <button
          v-if="journey.canStart && planner === null"
          class="action-button primary-action disciple-journey-launch"
          type="button"
          :disabled="busy || journeyPreviewLoading"
          @click="requestPreview"
        >
          <span>{{ journeyPreviewLoading ? '推演中…' : '查看历练预览' }}</span>
        </button>

        <div v-if="journey.canStart && planner !== null" class="disciple-journey-planner">
          <p class="disciple-detail-hint">
            {{ planner.discipleName }} 可出发 · 宗门在外 {{ planner.activeCount }}/{{ planner.maxConcurrent }} 人
          </p>

          <ul class="journey-directions" role="radiogroup" aria-label="历练方向">
            <li
              v-for="(item, index) in planner.directions"
              :key="item.direction"
              class="journey-direction"
              :style="journeyOrderStyle(index)"
            >
              <button
                class="journey-direction-button"
                :class="{
                  'is-selected': activeDirectionId === item.direction,
                  'is-blocked': !item.available,
                }"
                type="button"
                role="radio"
                :disabled="busy || !item.available"
                :aria-checked="activeDirectionId === item.direction"
                @click="selectDirection(item)"
              >
                <strong>{{ item.name }}</strong>
                <small>{{ item.description }}</small>
              </button>
              <p v-if="!item.available" class="blocked-hint">{{ item.blockedReason ?? '当前不可选' }}</p>
            </li>
          </ul>

          <ul v-if="activeDurations.length > 0" class="journey-durations" role="radiogroup" aria-label="历练时长">
            <li
              v-for="(option, index) in activeDurations"
              :key="option.durationSeconds"
              :style="journeyOrderStyle(index)"
            >
              <button
                class="journey-duration-chip"
                :class="{ 'is-selected': activeDurationSeconds === option.durationSeconds }"
                type="button"
                role="radio"
                :disabled="busy"
                :aria-checked="activeDurationSeconds === option.durationSeconds"
                @click="selectDuration(option)"
              >
                <span class="journey-duration-head">
                  <strong>{{ option.durationLabel }}</strong>
                  <em>{{ cultivationText(option) }}</em>
                </span>
                <span class="journey-duration-tags">
                  <span v-for="line in resourceLines(option.resources)" :key="line.id" class="journey-tag">
                    {{ line.name }} +{{ line.amount }}
                  </span>
                  <span class="journey-tag is-extra">额外收获 {{ formatBp(option.extraChanceBp) }}</span>
                  <span class="journey-tag is-risk">实际受伤 {{ formatBp(option.injuryChanceBp) }}</span>
                </span>
                <span class="journey-return">预计 {{ formatTime(option.endsAt) }} 归队</span>
              </button>
            </li>
          </ul>

          <p v-if="planner.blockedReason" class="blocked-hint">{{ planner.blockedReason }}</p>
          <button
            class="action-button primary-action disciple-journey-start"
            type="button"
            :disabled="busy || activeDurationSeconds === null"
            @click="confirmStart"
          >
            <span>确认出发</span>
          </button>
          <p class="disciple-detail-hint">
            数值为服务端预览（不含随机结果）；出发后原岗位收益与静修暂停，到期按服务端时间归队。
          </p>
        </div>
      </template>

      <div v-if="journey.status === 'active'" class="journey-away">
        <p class="journey-state-line">
          <span class="realm-tag">{{ journey.directionName ?? '历练' }}</span>
          <span class="journey-state-badge">在外历练中</span>
          <span class="journey-duration">{{ durationHours(journey.durationSeconds) }}</span>
        </p>
        <dl class="disciple-facts">
          <div>
            <dt>预计归队</dt>
            <dd>{{ formatTime(journey.endsAt) }}</dd>
          </div>
          <div>
            <dt>剩余时间</dt>
            <dd class="journey-countdown">{{ countdownText }}</dd>
          </div>
        </dl>
        <p class="disciple-detail-hint">
          原岗位「{{ journey.originalAssignmentName ?? '闲置' }}」仍为他保留；在外期间该岗位收益与静修暂停。
        </p>
        <button class="action-button primary-action disciple-journey-start" type="button" disabled>
          <span>在外历练中</span>
        </button>
      </div>

      <div v-if="journey.status === 'ready'" class="journey-ready">
        <p class="journey-state-line">
          <span class="realm-tag">{{ journey.directionName ?? '历练' }}</span>
          <span class="journey-state-badge is-ready">已归队 · 待领取</span>
          <span class="journey-duration">{{ durationHours(journey.durationSeconds) }}</span>
        </p>

        <template v-if="outcome !== null">
          <dl class="disciple-facts">
            <div>
              <dt>实际入账修为</dt>
              <dd>+{{ outcome.cultivationAwarded }}</dd>
            </div>
            <div>
              <dt>出发时计划</dt>
              <dd>{{ outcome.cultivationPlanned }}</dd>
            </div>
          </dl>
          <ul v-if="outcomeLines.length > 0" class="journey-reward-list">
            <li v-for="line in outcomeLines" :key="line.id">
              <span class="journey-tag">{{ line.name }}</span>
              <strong>+{{ line.amount }}</strong>
            </li>
          </ul>
          <p v-else class="disciple-detail-hint">本次没有资源奖励。</p>
          <p v-if="outcome.extraHarvest" class="journey-flag is-extra">额外收获：修为与各项资源按保底值再加五成。</p>
          <p v-if="outcome.injured" class="journey-flag is-risk">
            途中受伤 ·
            {{ outcomeHealed ? '已痊愈' : `预计 ${formatTime(outcome.injuredUntil)} 复原` }}
          </p>
        </template>

        <button
          class="action-button primary-action disciple-journey-start"
          type="button"
          :disabled="busy"
          @click="requestClaim"
        >
          <span>{{ busy ? '领取中…' : '领取历练收获' }}</span>
        </button>
        <p class="disciple-detail-hint">领取前不能再次派他历练，也不能被驱逐；资源在领取时一次性入账。</p>
      </div>

      <!-- 最近记录来自 state.journey.recent：关掉弹窗再打开仍能看到已完成的结果。 -->
      <div class="journey-history">
        <h4 class="disciple-journey-subtitle">最近历练（最多 10 条）</h4>
        <ul v-if="journal.length > 0" class="journey-history-list">
          <li v-for="entry in journal" :key="entry.id" class="journey-record" :class="`is-${entry.status}`">
            <div class="journey-record-head">
              <strong class="journey-record-name">{{ entry.discipleName }}</strong>
              <span class="journey-tag">{{ entry.directionName }}</span>
              <span class="journey-duration">{{ entry.durationText }}</span>
              <span class="journey-record-status" :class="`is-${entry.status}`">{{ entry.statusLabel }}</span>
            </div>
            <ul class="journey-record-result">
              <li v-for="(line, index) in entry.resultLines" :key="index">{{ line }}</li>
            </ul>
          </li>
        </ul>
        <p v-else class="disciple-detail-hint">尚无历练记录。</p>
      </div>
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
      <!-- 在外时即便服务端还没把 canBreakthrough 打成 false，也一律挡住破境。 -->
      <p v-if="awayHint" class="blocked-hint">{{ awayHint }}</p>
      <button
        class="action-button primary-action disciple-break-button"
        :class="{ 'is-disabled': !disciple.canBreakthrough || journey.status === 'active' }"
        type="button"
        :disabled="busy || journey.status === 'active'"
        :aria-disabled="!disciple.canBreakthrough || journey.status === 'active'"
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
        :disabled="busy || !state.alchemy.unlocked || journey.status === 'active'"
        @click="showPillPicker = true"
      >
        服用丹药
      </button>
      <p v-if="awayHint" class="blocked-hint">{{ awayHint }}</p>
      <p class="disciple-detail-hint">点击后选择丹药；配方炼制仍在「炼丹」面板。</p>
    </section>

    <section class="disciple-detail-section disciple-danger" aria-labelledby="disciple-expel-title">
      <h3 id="disciple-expel-title" class="disciple-detail-title">驱逐出师门</h3>

      <template v-if="!confirmingExpel">
        <p class="disciple-detail-hint">
          驱逐后该弟子不再属于本宗，其占用的岗位收益同时结算。
        </p>
        <!-- 历练期间（在外或待领取）服务端会拒绝驱逐，这里先禁用并说明原因。 -->
        <p v-if="expelBlockedHint" class="blocked-hint">{{ expelBlockedHint }}</p>
        <button
          ref="expelTrigger"
          class="action-button disciple-danger-button"
          type="button"
          :disabled="busy || journey.status !== 'none'"
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
