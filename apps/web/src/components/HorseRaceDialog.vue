<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';

import type { HorseRaceResult, SectStateView } from '../api/game';
import { formatAmount } from '../utils/format';

/**
 * 赛马（赌坊第三个玩法）：选马下注 → 跑马动画 → 结果。
 *
 * 服务端是唯一的规则来源：赔率、名次、8 步进度序列（result.steps）、奖励金额与结果文案都原样渲染；
 * 这里只做两件事——把「进度 0~1」换算成 transform 位移，以及保证动画播完才露出胜负与金额（计划 §12.10）。
 *
 * 下注阶段服务端还没生成马匹（点「开跑」才请求），所以马名用本地常量摆位、赔率一律显示 ?，
 * 绝不在前端编造赔率或胜率。
 */
const props = defineProps<{
  state: SectStateView;
  busy: boolean;
  /** 刚跑完的一局；null = 还没跑过（上层每次开跑前都会清空）。 */
  result: HorseRaceResult | null;
}>();

const emit = defineEmits<{
  /** 开跑：horseIndex 0~4，betAmount 用**最小单位**整数（与后端 horseRaceRequestSchema 同口径）。 */
  race: [horseIndex: number, betAmount: number];
  /** 动画播完、结果露出：与天机轮的 reveal 同一套处理，由 SectScreen 补一条结果提示。 */
  reveal: [];
  /** 返回赌坊玩法列表。 */
  back: [];
}>();

/**
 * 5 匹马的名字：与后端 apps/server/src/modules/game/gambling.ts 的 HORSE_NAMES 同口径。
 * 只用于下注阶段占位（服务端返回的 horses[].name 才是权威，渲染时优先用它）。
 */
const HORSE_NAMES = ['赤兔', '绝影', '的卢', '乌骓', '踏雪'] as const;

/**
 * 赌注范围（展示单位）：与后端 gambling.ts 的 RACE_BET_MIN / RACE_BET_MAX
 * （10000 / 500000 最小单位）同口径。前端只是先挡一道，真正的校验仍在服务端。
 */
const RACE_BET_MIN_DISPLAY = 10;
const RACE_BET_MAX_DISPLAY = 500;

/** 1 展示单位 = 1000 最小单位（与 utils/format.ts 同口径）：输入是展示单位，提交时才换算。 */
const UNITS_PER_DISPLAY = 1000;

/** 动画：8 步 × 440ms ≈ 3.5 秒（计划 §2.7），步长与 css 的 transition 时长对齐。 */
const RACE_STEP_MS = 440;
/** 每匹马能推进的最大位移（百分比，相对整条跑道）：留出右缘余量，免得马头被跑道裁掉。 */
const LANE_TRAVEL_PERCENT = 86;

/** betting = 选马下注；racing = 动画中；result = 结果面板。 */
type Phase = 'betting' | 'racing' | 'result';
const phase = ref<Phase>('betting');

/**
 * 到手的结果：动画播完前只借它画赛道与赔率，胜负、名次与金额一概不露（计划 §12.10）。
 * 上层每次开跑前都会清空 props.result，所以这里只在「新结果到达」时才开跑，不会重播上一局。
 */
const shownResult = ref<HorseRaceResult | null>(null);

/* ---------- 选马与下注 ---------- */

/** 选中的马位；null = 还没选。 */
const selectedIndex = ref<number | null>(null);
/** 赌注草稿（展示单位文本）；提交时才 ×1000 换算成最小单位。 */
const betInput = ref('');

/** 灵石余额（最小单位）：余额上限先由前端挡一道，扣减仍由服务端裁决。 */
const spiritStone = computed(() => {
  const resource = props.state.resources.find((item) => item.id === 'spiritStone');
  return Number(resource?.balance ?? '0');
});

const betDisplay = computed(() => Number(betInput.value.trim()));
const betMinUnits = computed(() => Math.round(betDisplay.value * UNITS_PER_DISPLAY));
/** 合法赌注：展示单位整数且在 [RACE_BET_MIN_DISPLAY, RACE_BET_MAX_DISPLAY] 内。 */
const betValid = computed(
  () =>
    Number.isFinite(betDisplay.value) &&
    Number.isInteger(betDisplay.value) &&
    betDisplay.value >= RACE_BET_MIN_DISPLAY &&
    betDisplay.value <= RACE_BET_MAX_DISPLAY,
);
const affordable = computed(() => betValid.value && betMinUnits.value <= spiritStone.value);
const hasTries = computed(() => props.state.gambling.remaining > 0);
const running = computed(() => phase.value === 'racing');
const canRace = computed(
  () =>
    selectedIndex.value !== null &&
    betValid.value &&
    affordable.value &&
    hasTries.value &&
    !props.busy &&
    !running.value,
);

const selectedName = computed(() =>
  selectedIndex.value === null ? null : HORSE_NAMES[selectedIndex.value],
);

/** 一句提示：把「差在哪」说清楚，别只把按钮变灰。 */
const betHint = computed(() => {
  if (betInput.value.trim() !== '' && !betValid.value) {
    return `赌注需为 ${String(RACE_BET_MIN_DISPLAY)}~${String(RACE_BET_MAX_DISPLAY)} 的整数（展示单位）。`;
  }
  if (betValid.value && !affordable.value) {
    return `灵石不足：当前 ${formatAmount(spiritStone.value)} 灵石。`;
  }
  return '';
});

function race(): void {
  if (!canRace.value || selectedIndex.value === null) return;
  emit('race', selectedIndex.value, betMinUnits.value);
}

/* ---------- 跑马动画 ---------- */

/** 每匹马当前进度（0~1，取自 steps[h][step]）：驱动赛道上 :style 的 translateX。 */
const progress = ref<number[]>(HORSE_NAMES.map(() => 0));
/** 已跑到第几步（1-based）：只用于赛程文案。 */
const stepIndex = ref(0);
let stepTimer: number | undefined;

/** reduced-motion 时 base.css 把过渡压到 0.01ms：步长跟着归零，别让玩家白等 3.5 秒。 */
function stepWaitMs(): number {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : RACE_STEP_MS;
}

/**
 * 逐步推进（setTimeout 链而不是 async 循环）：计时器句柄留在组件里，
 * 面板被切走 / 弹窗关闭时 onUnmounted 一次就能清掉，不留还在改状态的孤儿任务。
 */
function playStep(result: HorseRaceResult, step: number): void {
  const count = result.steps[0]?.length ?? 0;
  if (step >= count) {
    // 动画播完才揭晓：只有走到这里才允许渲染名次、胜负与金额（计划 §12.10）。
    phase.value = 'result';
    emit('reveal');
    return;
  }
  progress.value = result.steps.map((lane) => lane[step] ?? 0);
  stepIndex.value = step + 1;
  stepTimer = window.setTimeout(() => {
    playStep(result, step + 1);
  }, stepWaitMs());
}

/** 起跑：从头开始摆马，并切进动画阶段（结果同上层的旧值无关）。 */
function startRace(result: HorseRaceResult): void {
  window.clearTimeout(stepTimer);
  progress.value = HORSE_NAMES.map(() => 0);
  stepIndex.value = 0;
  phase.value = 'racing';
  playStep(result, 0);
}

onUnmounted(() => {
  window.clearTimeout(stepTimer);
});

/**
 * 结果到达才开跑：赔率与名次必须由服务端裁决，前端不猜。
 * 上层每局开跑前都会清空 result，所以 null 就是「上一局翻篇」——回到下注阶段
 * （选中与赌注都留着，方便连赌；此时赔率重新变回 ?）。
 */
watch(
  () => props.result,
  (result) => {
    if (result === null) {
      shownResult.value = null;
      window.clearTimeout(stepTimer);
      phase.value = 'betting';
      return;
    }
    shownResult.value = result;
    startRace(result);
  },
);

/** 再来一局：清掉本局展示数据回到选马（马名回到常量、赔率回到 ?）。 */
function again(): void {
  shownResult.value = null;
  progress.value = HORSE_NAMES.map(() => 0);
  phase.value = 'betting';
}

/* ---------- 赛道与结果 ---------- */

interface RaceLane {
  index: number;
  name: string;
  /** 赔率（服务端返回前为 null，显示 ?）。 */
  odds: number | null;
  /** 动画进度（0~1）。 */
  progress: number;
  /** 是不是玩家押的那匹。 */
  picked: boolean;
  /** 冠军（只在结果阶段为 true：动画播完前绝不提前标出冠军）。 */
  champion: boolean;
  /** 最终名次（1-based；动画播完前为 null）。 */
  rank: number | null;
}

function buildLanes(result: HorseRaceResult | null, final: boolean): RaceLane[] {
  return HORSE_NAMES.map((fallbackName, index) => ({
    index,
    name: result?.horses[index]?.name ?? fallbackName,
    odds: result?.horses[index]?.odds ?? null,
    progress: progress.value[index] ?? 0,
    picked: (result?.selectedIndex ?? selectedIndex.value) === index,
    champion: final && result?.winnerIndex === index,
    rank: final ? (result?.ranks[index] ?? null) : null,
  }));
}

/** 赛道（按马的下标排列）：动画阶段每匹马一行。 */
const lanes = computed(() => buildLanes(shownResult.value, false));
/** 名次榜：结果阶段才按服务端 ranks 排序——名次与胜负同一时刻露出。 */
const ranked = computed(() =>
  buildLanes(shownResult.value, true).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)),
);

const stepCount = computed(() => shownResult.value?.steps[0]?.length ?? 0);

/** 结果阶段的零散文案都做成计算属性：模板里就不用到处判空。 */
const won = computed(() => shownResult.value?.result === 'win');
const finalBetText = computed(() => formatAmount(shownResult.value?.betAmount ?? '0'));
const finalOddsText = computed(() => `${(shownResult.value?.odds ?? 0).toFixed(1)}x`);
const finalMessage = computed(() => shownResult.value?.message ?? '');
/** 灵石变化：赢是奖励入账，输是赌注被扣（都用 formatAmount 折算成展示单位）。 */
const netText = computed(() => {
  const result = shownResult.value;
  if (result === null) return '';
  return result.result === 'win'
    ? `+${formatAmount(result.rewardAmount)}`
    : `-${formatAmount(result.betAmount)}`;
});

/** 赔率一律一位小数 + x；还没拿到服务端赔率时显示 ?。 */
function oddsText(odds: number | null): string {
  return odds === null ? '?' : `${odds.toFixed(1)}x`;
}
</script>

<template>
  <section class="race-panel" aria-labelledby="gambling-dialog-title">
    <!-- ---------- 选马下注 ---------- -->
    <template v-if="phase === 'betting'">
      <p class="eyebrow">选择马匹（只赌冠军）</p>
      <div class="race-horses" role="radiogroup" aria-label="选择马匹">
        <button
          v-for="(name, index) in HORSE_NAMES"
          :key="name"
          class="race-horse-card"
          :class="{ 'is-selected': selectedIndex === index }"
          type="button"
          role="radio"
          :disabled="busy"
          :aria-checked="selectedIndex === index"
          @click="selectedIndex = index"
        >
          <strong>{{ name }}</strong>
          <small>赔率 ?</small>
        </button>
      </div>

      <label class="race-amount">
        <span class="eyebrow">
          赌注（{{ RACE_BET_MIN_DISPLAY }}~{{ RACE_BET_MAX_DISPLAY }} 灵石，展示单位）
        </span>
        <input
          class="disciple-input race-amount-input"
          type="number"
          inputmode="numeric"
          :min="RACE_BET_MIN_DISPLAY"
          :max="RACE_BET_MAX_DISPLAY"
          step="1"
          :placeholder="`${RACE_BET_MIN_DISPLAY} ~ ${RACE_BET_MAX_DISPLAY}`"
          :value="betInput"
          :disabled="busy"
          @input="betInput = ($event.target as HTMLInputElement).value"
        />
      </label>

      <p v-if="betHint !== ''" class="blocked-hint">{{ betHint }}</p>
      <p v-if="selectedName !== null && betValid" class="race-stake-hint">
        押 {{ selectedName }} · 赌注 {{ betDisplay }} 灵石 · 赔率开跑后揭晓
      </p>
      <p class="race-note">
        五匹马本局实力随机，赔率随之浮动；押中冠军按赔率结算，未中则输掉赌注。
      </p>

      <button
        class="action-button primary-action realm-button race-run-button"
        :class="{ 'is-disabled': !canRace }"
        type="button"
        :disabled="busy || !canRace"
        :aria-disabled="!canRace"
        @click="race"
      >
        <span>{{ busy ? '马匹入场中…' : `开跑 · ${betValid ? betDisplay : RACE_BET_MIN_DISPLAY} 灵石` }}</span>
      </button>

      <p v-if="!hasTries" class="blocked-hint">
        今日 {{ state.gambling.dailyLimit }} 次机会（论道 / 天机轮 / 赛马共享）已用尽，明日再来。
      </p>

      <div class="race-foot">
        <button class="action-button race-foot-button" type="button" :disabled="busy" @click="emit('back')">
          返回赌坊
        </button>
      </div>
    </template>

    <!-- ---------- 跑马动画：只放马与赔率，不给任何名次线索 ---------- -->
    <template v-else-if="running">
      <p class="eyebrow">赛程 · 第 {{ stepIndex }}/{{ stepCount }} 步</p>
      <div class="race-track">
        <div
          v-for="lane in lanes"
          :key="lane.index"
          class="race-lane"
          :class="{ 'is-picked': lane.picked }"
        >
          <span class="race-lane-name">{{ lane.name }}</span>
          <span class="race-lane-odds">{{ oddsText(lane.odds) }}</span>
          <span class="race-lane-track">
            <span
              class="race-horse"
              :style="{ transform: `translateX(${lane.progress * LANE_TRAVEL_PERCENT}%)` }"
            >🐴</span>
          </span>
        </div>
      </div>
      <p class="race-note">马匹奔跑中，终线之后才见分晓。</p>
    </template>

    <!-- ---------- 结果：动画播完才渲染，名次 / 胜负 / 金额同时露出 ---------- -->
    <template v-else>
      <p class="eyebrow">赛马已定</p>
      <ul class="race-ranks">
        <li
          v-for="lane in ranked"
          :key="lane.index"
          class="race-rank-row"
          :class="{ 'is-champion': lane.champion, 'is-picked': lane.picked }"
        >
          <span class="race-rank-no">第 {{ lane.rank }} 名</span>
          <strong class="race-rank-name">{{ lane.name }}</strong>
          <span class="race-rank-odds">{{ oddsText(lane.odds) }}</span>
          <span v-if="lane.champion" class="race-rank-tag">冠军</span>
          <span v-if="lane.picked" class="race-rank-tag is-picked">你押的</span>
        </li>
      </ul>

      <div class="race-outcome" role="status" aria-live="polite">
        <strong class="race-outcome-label" :class="won ? 'is-win' : 'is-lose'">
          {{ won ? '赢' : '输' }}
        </strong>
        <p class="race-outcome-net">
          灵石 <strong :class="won ? 'is-win' : 'is-lose'">{{ netText }}</strong>
          <small>（赌注 {{ finalBetText }} · 赔率 {{ finalOddsText }}）</small>
        </p>
        <p class="race-outcome-message">{{ finalMessage }}</p>
      </div>

      <div class="race-foot">
        <button class="action-button race-foot-button" type="button" :disabled="busy" @click="again">
          再来一局
        </button>
        <button
          class="action-button primary-action realm-button race-foot-button"
          type="button"
          @click="emit('back')"
        >
          <span>返回赌坊</span>
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.race-panel {
  display: flex;
  flex-direction: column;
}

/* ---------- 选马与下注 ---------- */

.race-horses {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.race-horse-card {
  display: flex;
  min-width: 88px;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.014);
  color: #a9bcb2;
  text-align: left;
  transition: border-color 160ms ease, background-color 160ms ease, color 160ms ease;
}

.race-horse-card:not(:disabled):hover {
  border-color: rgba(119, 184, 154, 0.4);
}

.race-horse-card.is-selected {
  border-color: rgba(202, 169, 106, 0.55);
  color: var(--gold);
  background: rgba(202, 169, 106, 0.1);
}

.race-horse-card strong {
  font-size: 14px;
  font-weight: 600;
}

.race-horse-card small {
  color: #7d9186;
  font-size: 11px;
}

.race-horse-card.is-selected small {
  color: rgba(202, 169, 106, 0.85);
}

.race-amount {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 14px;
}

.race-amount-input {
  width: 100%;
}

.race-stake-hint {
  margin-top: 8px;
  color: #c8d6ce;
  font-size: 12px;
}

.race-note {
  margin-top: 8px;
  color: #7d9186;
  font-size: 12px;
  line-height: 1.6;
}

.race-run-button {
  margin-top: 14px;
}

/* ---------- 赛道 ---------- */

.race-track {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
  padding: 12px 0;
}

.race-lane {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.03);
}

/* 玩家押的那匹加一道金边，视线好跟。 */
.race-lane.is-picked {
  border-color: rgba(202, 169, 106, 0.45);
}

.race-lane-name {
  flex: 0 0 44px;
  color: #dce6e0;
  font-size: 13px;
}

.race-lane-odds {
  flex: 0 0 46px;
  color: var(--gold, #caa96a);
  font-size: 12px;
}

.race-lane-track {
  position: relative;
  flex: 1 1 auto;
  height: 30px;
  overflow: hidden;
  border-radius: 3px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0.06));
}

/* 终线：刚好落在马能跑到的最远处（LANE_TRAVEL_PERCENT = 86%）。 */
.race-lane-track::after {
  content: '';
  position: absolute;
  top: 0;
  right: 14%;
  bottom: 0;
  border-right: 1px dashed rgba(202, 169, 106, 0.35);
}

/* 宽度 = 整条跑道，于是 translateX 的百分比正好是「跑到哪儿」的比例（驱动值来自 steps）。 */
.race-horse {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  font-size: 20px;
  line-height: 1;
  transition: transform 400ms ease;
}

/* ---------- 结果 ---------- */

.race-ranks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.race-rank-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.02);
  font-size: 13px;
}

/* 冠军：金边 + 金色马名（名次与边框同时出现，动画阶段不会有这条）。 */
.race-rank-row.is-champion {
  border-color: var(--gold, #caa96a);
  background: rgba(202, 169, 106, 0.1);
}

.race-rank-row.is-champion .race-rank-name {
  color: var(--gold, #caa96a);
}

.race-rank-no {
  flex: 0 0 56px;
  color: #7d9186;
  font-size: 12px;
}

.race-rank-name {
  flex: 1 1 auto;
  color: #dce6e0;
}

.race-rank-odds {
  color: #a9bcb2;
  font-size: 12px;
}

.race-rank-tag {
  padding: 1px 6px;
  border: 1px solid rgba(202, 169, 106, 0.5);
  border-radius: 2px;
  color: var(--gold, #caa96a);
  font-size: 11px;
}

.race-rank-tag.is-picked {
  border-color: rgba(119, 184, 154, 0.5);
  color: #77b89a;
}

.race-outcome {
  margin-top: 16px;
}

.race-outcome-label {
  display: block;
  margin-top: 4px;
  font-family: 'STKaiti', 'KaiTi', serif;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.race-outcome-label.is-win,
.race-outcome-net .is-win {
  color: var(--gold, #caa96a);
}

.race-outcome-label.is-lose,
.race-outcome-net .is-lose {
  color: #b8735f;
}

.race-outcome-net {
  margin-top: 6px;
  color: #c8d6ce;
  font-size: 13px;
}

.race-outcome-net small {
  color: #7d9186;
  font-size: 11px;
}

.race-outcome-message {
  margin-top: 6px;
  color: #c8d6ce;
  font-size: 13px;
  line-height: 1.6;
}

/* ---------- 底部按钮 ---------- */

.race-foot {
  display: flex;
  gap: 10px;
  margin-top: 18px;
}

.race-foot-button {
  flex: 1 1 0;
  padding: 8px 12px;
  font-size: 13px;
}
</style>
