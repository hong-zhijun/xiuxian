<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import type { RaceStateView, SectStateView } from '../api/game';
import { fetchRaceState, placeRaceBet } from '../api/game';
import { formatAmount } from '../utils/format';

const props = defineProps<{
  state: SectStateView;
  busy: boolean;
}>();

const emit = defineEmits<{
  /** 下注成功后更新 state。 */
  'state-update': [state: SectStateView];
  /** 返回赌坊玩法列表。 */
  back: [];
  /** 结果提示。 */
  notify: [tone: 'success' | 'warning', title: string, message: string];
}>();

const RACE_BET_MIN_DISPLAY = 10;
const RACE_BET_MAX_DISPLAY = 500;
const UNITS_PER_DISPLAY = 1000;

const RACE_STEP_MS = 440;
const LANE_TRAVEL_PERCENT = 86;

const race = ref<RaceStateView | null>(null);
const loading = ref(true);
const submitting = ref(false);
const errorMsg = ref('');

const selectedBeast = ref<number | null>(null);
const betInput = ref('');

let pollTimer: number | undefined;
let countdownTimer: number | undefined;
const countdown = ref(0);

const spiritStone = computed(() => {
  const r = props.state.resources.find((item) => item.id === 'spiritStone');
  return Number(r?.balance ?? '0');
});

const betDisplay = computed(() => Number(betInput.value.trim()));
const betMinUnits = computed(() => Math.round(betDisplay.value * UNITS_PER_DISPLAY));
const betValid = computed(
  () =>
    Number.isFinite(betDisplay.value) &&
    Number.isInteger(betDisplay.value) &&
    betDisplay.value >= RACE_BET_MIN_DISPLAY &&
    betDisplay.value <= RACE_BET_MAX_DISPLAY,
);
const affordable = computed(() => betValid.value && betMinUnits.value <= spiritStone.value);
const hasTries = computed(() => props.state.gambling.remaining > 0);

const canBet = computed(
  () =>
    selectedBeast.value !== null &&
    betValid.value &&
    affordable.value &&
    (hasTries.value || hasExistingBet.value) &&
    !submitting.value &&
    !props.busy &&
    race.value?.phase === 'betting',
);

const hasExistingBet = computed(() => (race.value?.myBets.length ?? 0) > 0);

const betHint = computed(() => {
  if (betInput.value.trim() !== '' && !betValid.value) {
    return `赌注需为 ${String(RACE_BET_MIN_DISPLAY)}~${String(RACE_BET_MAX_DISPLAY)} 的整数`;
  }
  if (betValid.value && !affordable.value) {
    return `灵石不足：当前 ${formatAmount(spiritStone.value)} 灵石`;
  }
  return '';
});

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function loadRaceState(): Promise<void> {
  try {
    const { state: newState, race: raceData } = await fetchRaceState();
    emit('state-update', newState);
    const prevPhase = race.value?.phase;
    const prevRoundKey = race.value?.roundKey;
    race.value = raceData;
    countdown.value = raceData.remainingSeconds;

    if (prevPhase === 'sealed' && raceData.phase === 'settled') {
      startSettledAnimation(raceData);
    }
    if (prevRoundKey && prevRoundKey !== raceData.roundKey) {
      animPhase.value = 'idle';
    }
  } catch {
    /* ignore polling errors */
  } finally {
    loading.value = false;
  }
}

async function submitBet(): Promise<void> {
  if (!canBet.value || selectedBeast.value === null) return;
  submitting.value = true;
  errorMsg.value = '';
  try {
    const { state: newState, race: raceData } = await placeRaceBet(selectedBeast.value, betMinUnits.value);
    emit('state-update', newState);
    race.value = raceData;
    countdown.value = raceData.remainingSeconds;
    betInput.value = '';
    selectedBeast.value = null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errorMsg.value = msg;
  } finally {
    submitting.value = false;
  }
}

function startPolling(): void {
  stopPolling();
  pollTimer = window.setInterval(() => {
    void loadRaceState();
  }, 5000);
}

function stopPolling(): void {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function startCountdown(): void {
  stopCountdown();
  countdownTimer = window.setInterval(() => {
    if (countdown.value > 0) countdown.value -= 1;
  }, 1000);
}

function stopCountdown(): void {
  if (countdownTimer !== undefined) {
    window.clearInterval(countdownTimer);
    countdownTimer = undefined;
  }
}

/* ---------- 封盘动画 ---------- */

type AnimPhase = 'idle' | 'racing' | 'result';
const animPhase = ref<AnimPhase>('idle');
const animProgress = ref<number[]>([0, 0, 0, 0, 0]);
const animStep = ref(0);
let animTimer: number | undefined;

function startSettledAnimation(data: RaceStateView): void {
  if (!data.steps || !data.ranks) {
    animPhase.value = 'result';
    notifyResult(data);
    return;
  }
  animPhase.value = 'racing';
  animProgress.value = [0, 0, 0, 0, 0];
  animStep.value = 0;
  playAnimStep(data, 0);
}

function playAnimStep(data: RaceStateView, step: number): void {
  const steps = data.steps!;
  const count = steps[0]?.length ?? 0;
  if (step >= count) {
    animPhase.value = 'result';
    notifyResult(data);
    return;
  }
  animProgress.value = steps.map((lane) => lane[step] ?? 0);
  animStep.value = step + 1;
  const waitMs = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : RACE_STEP_MS;
  animTimer = window.setTimeout(() => playAnimStep(data, step + 1), waitMs);
}

function notifyResult(data: RaceStateView): void {
  if (data.winnerIndex === null) return;
  const beastName = data.beasts[data.winnerIndex]?.name ?? '?';
  const myWin = Number(data.myWinnings ?? '0');
  const myBet = Number(data.myTotalBet);
  if (myBet > 0) {
    if (myWin > 0) {
      emit('notify', 'success', `灵兽竞逐 · ${beastName}夺冠`, `恭喜！你赢得 ${formatAmount(String(myWin))} 灵石`);
    } else {
      emit('notify', 'warning', `灵兽竞逐 · ${beastName}夺冠`, `很遗憾，你押注的灵兽未能夺冠，损失 ${formatAmount(String(myBet))} 灵石`);
    }
  }
}

function oddsText(odds: number): string {
  return odds > 0 ? `${odds.toFixed(1)}x` : '—';
}

watch(() => race.value?.phase, (phase) => {
  if (phase === 'sealed' && animPhase.value === 'idle') {
    // wait for next poll to get settled data
  }
});

onMounted(() => {
  void loadRaceState();
  startPolling();
  startCountdown();
});

onUnmounted(() => {
  stopPolling();
  stopCountdown();
  window.clearTimeout(animTimer);
});
</script>

<template>
  <section class="race-panel" aria-labelledby="gambling-dialog-title">
    <template v-if="loading">
      <p class="race-note">加载中…</p>
    </template>

    <!-- 休赛时段 -->
    <template v-else-if="race?.phase === 'closed'">
      <p class="eyebrow">灵兽竞逐 · 休赛中</p>
      <p class="race-note">灵兽竞逐仅在每日 08:00–23:00（UTC+8）开放。</p>
      <p class="race-note">距离下次开赛：{{ formatCountdown(countdown) }}</p>
      <div class="race-foot">
        <button class="action-button race-foot-button" type="button" @click="emit('back')">返回赌坊</button>
      </div>
    </template>

    <!-- 结算后展示（带动画） -->
    <template v-else-if="race?.phase === 'settled' && animPhase === 'racing'">
      <p class="eyebrow">赛程 · 第 {{ animStep }}/{{ race.steps?.[0]?.length ?? 8 }} 步</p>
      <div class="race-track">
        <div
          v-for="beast in race.beasts"
          :key="beast.index"
          class="race-lane"
          :class="{ 'is-picked': race.myBets.some(b => b.beastIndex === beast.index) }"
        >
          <span class="race-lane-name">{{ beast.name }}</span>
          <span class="race-lane-odds">{{ oddsText(beast.odds) }}</span>
          <span class="race-lane-track">
            <span
              class="race-horse"
              :style="{ transform: `translateX(${(animProgress[beast.index] ?? 0) * LANE_TRAVEL_PERCENT}%)` }"
            >🐴</span>
          </span>
        </div>
      </div>
      <p class="race-note">灵兽奔跑中，终线之后才见分晓。</p>
    </template>

    <!-- 结算后结果 -->
    <template v-else-if="race?.phase === 'settled'">
      <p class="eyebrow">灵兽竞逐 · 已结算</p>
      <ul class="race-ranks" v-if="race.ranks">
        <li
          v-for="(beast, _i) in race!.beasts.slice().sort((a, b) => (race!.ranks![a.index] ?? 99) - (race!.ranks![b.index] ?? 99))"
          :key="beast.index"
          class="race-rank-row"
          :class="{ 'is-champion': beast.index === race.winnerIndex, 'is-picked': race.myBets.some(b => b.beastIndex === beast.index) }"
        >
          <span class="race-rank-no">第 {{ race.ranks[beast.index] }} 名</span>
          <strong class="race-rank-name">{{ beast.name }}</strong>
          <span class="race-rank-odds">{{ oddsText(beast.odds) }}</span>
          <span v-if="beast.index === race.winnerIndex" class="race-rank-tag">冠军</span>
          <span v-if="race.myBets.some(b => b.beastIndex === beast.index)" class="race-rank-tag is-picked">你押的</span>
        </li>
      </ul>

      <template v-if="Number(race.myTotalBet) > 0">
        <div class="race-outcome" role="status" aria-live="polite">
          <strong class="race-outcome-label" :class="Number(race.myWinnings ?? '0') > 0 ? 'is-win' : 'is-lose'">
            {{ Number(race.myWinnings ?? '0') > 0 ? '赢' : '输' }}
          </strong>
          <p class="race-outcome-net">
            灵石
            <strong :class="Number(race.myWinnings ?? '0') > 0 ? 'is-win' : 'is-lose'">
              {{ Number(race.myWinnings ?? '0') > 0
                ? `+${formatAmount(race.myWinnings ?? '0')}`
                : `-${formatAmount(race.myTotalBet)}`
              }}
            </strong>
          </p>
        </div>
      </template>

      <p class="race-note">下一轮即将开始，倒计时：{{ formatCountdown(countdown) }}</p>
      <div class="race-foot">
        <button class="action-button race-foot-button" type="button" @click="emit('back')">返回赌坊</button>
      </div>
    </template>

    <!-- 投注/封盘阶段 -->
    <template v-else-if="race">
      <p class="eyebrow">
        灵兽竞逐 ·
        {{ race.phase === 'betting' ? '投注中' : '封盘中' }}
        <span class="race-countdown">{{ formatCountdown(countdown) }}</span>
      </p>

      <!-- 灵兽卡片 -->
      <div class="race-horses" role="radiogroup" aria-label="选择灵兽">
        <button
          v-for="beast in race.beasts"
          :key="beast.index"
          class="race-horse-card"
          :class="{ 'is-selected': selectedBeast === beast.index }"
          type="button"
          role="radio"
          :disabled="race.phase !== 'betting' || submitting"
          :aria-checked="selectedBeast === beast.index"
          @click="selectedBeast = beast.index"
        >
          <strong>{{ beast.name }}</strong>
          <small class="race-card-odds">倍率 {{ oddsText(beast.odds) }}</small>
          <small class="race-card-pool">投注 {{ formatAmount(beast.pool) }}</small>
        </button>
      </div>

      <!-- 投注池信息 -->
      <p class="race-pool-info">
        总投注池：{{ formatAmount(race.totalPool) }} 灵石
        <template v-if="race.myBets.length > 0">
          · 你已投 {{ formatAmount(race.myTotalBet) }} 灵石
        </template>
      </p>

      <!-- 我的投注列表 -->
      <ul v-if="race.myBets.length > 0" class="race-my-bets">
        <li v-for="(bet, i) in race.myBets" :key="i" class="race-my-bet-row">
          {{ bet.beastName }} · {{ formatAmount(bet.amount) }} 灵石
        </li>
      </ul>

      <!-- 下注表单 -->
      <template v-if="race.phase === 'betting'">
        <label class="race-amount">
          <span class="eyebrow">赌注（{{ RACE_BET_MIN_DISPLAY }}~{{ RACE_BET_MAX_DISPLAY }} 灵石）</span>
          <input
            class="disciple-input race-amount-input"
            type="number"
            inputmode="numeric"
            :min="RACE_BET_MIN_DISPLAY"
            :max="RACE_BET_MAX_DISPLAY"
            step="1"
            :placeholder="`${RACE_BET_MIN_DISPLAY} ~ ${RACE_BET_MAX_DISPLAY}`"
            :value="betInput"
            :disabled="submitting"
            @input="betInput = ($event.target as HTMLInputElement).value"
          />
        </label>

        <p v-if="betHint !== ''" class="blocked-hint">{{ betHint }}</p>
        <p v-if="errorMsg" class="blocked-hint">{{ errorMsg }}</p>

        <button
          class="action-button primary-action realm-button race-run-button"
          :class="{ 'is-disabled': !canBet }"
          type="button"
          :disabled="!canBet"
          @click="submitBet"
        >
          <span>{{ submitting ? '下注中…' : `下注 · ${betValid ? betDisplay : RACE_BET_MIN_DISPLAY} 灵石` }}</span>
        </button>

        <p v-if="!hasTries && !hasExistingBet" class="blocked-hint">
          今日 {{ state.gambling.dailyLimit }} 次机会（论道 / 天机轮 / 灵兽竞逐共享）已用尽，明日再来。
        </p>
      </template>
      <template v-else>
        <p class="race-note">已封盘，等待结算中…</p>
      </template>

      <div class="race-foot">
        <button class="action-button race-foot-button" type="button" :disabled="submitting" @click="emit('back')">
          返回赌坊
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

.race-countdown {
  color: var(--gold, #caa96a);
  font-size: 14px;
  font-weight: 600;
  margin-left: 8px;
}

.race-horses {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.race-horse-card {
  display: flex;
  min-width: 100px;
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

.race-card-odds {
  color: var(--gold, #caa96a);
  font-size: 11px;
}

.race-card-pool {
  color: #7d9186;
  font-size: 11px;
}

.race-horse-card.is-selected .race-card-odds {
  color: rgba(202, 169, 106, 0.95);
}

.race-pool-info {
  margin-top: 10px;
  color: #a9bcb2;
  font-size: 12px;
}

.race-my-bets {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}

.race-my-bet-row {
  padding: 3px 0;
  color: #c8d6ce;
  font-size: 12px;
}

.race-my-bet-row::before {
  content: '• ';
  color: var(--gold, #caa96a);
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

.race-run-button {
  margin-top: 14px;
}

.race-note {
  margin-top: 8px;
  color: #7d9186;
  font-size: 12px;
  line-height: 1.6;
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

.race-lane-track::after {
  content: '';
  position: absolute;
  top: 0;
  right: 14%;
  bottom: 0;
  border-right: 1px dashed rgba(202, 169, 106, 0.35);
}

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
