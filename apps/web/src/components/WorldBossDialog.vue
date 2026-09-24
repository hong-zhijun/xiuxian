<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { CSSProperties } from 'vue';

import type { SectStateView, WorldBossHitView, WorldBossView } from '../api/game';
import { attackWorldBoss, fetchWorldBoss } from '../api/game';
import { formatAmount } from '../utils/format';
import DisciplePicker from './DisciplePicker.vue';

/**
 * 0025 世界 Boss（讨伐）面板（计划 4.3）。
 *
 * 只在「打开时 / 出手后 / 点刷新」请求接口，**不做定时轮询**（D1 免费额度很紧）；
 * 出手成功后就地播放抖动与飘字动画，并把新的 state 交给上层（与灵兽竞逐同一走向）。
 */
const props = defineProps<{
  state: SectStateView;
  busy?: boolean;
}>();

const emit = defineEmits<{
  'state-update': [state: SectStateView];
  notify: [tone: 'success' | 'warning', title: string, message: string];
}>();

const panel = ref<WorldBossView | null>(null);
const loading = ref(false);
const submitting = ref(false);
const selected = ref<string[]>([]);
const showRules = ref(false);

/** 被击中：`hitKey` 每次 +1 让抖动的 CSS 动画重新播放，飘字 0.9 秒后消失。 */
const hitKey = ref(0);
const hit = ref<{ damage: number; crit: boolean } | null>(null);
let hitTimer: number | null = null;

const boss = computed(() => panel.value?.boss ?? null);

const hpPercent = computed(() => {
  const current = boss.value;
  if (current === null || current.maxHp <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((current.hp / current.maxHp) * 100)));
});

/** Boss 主色：印章与血条共用的 CSS 变量（未出现时给一个中性色）。 */
const sealStyle = computed<CSSProperties>(() => ({
  '--boss-color': boss.value?.def.color ?? '#7a8c6e',
}));

/**
 * 「距结束」倒计时：打开面板 / 出手后拿到剩余秒数，之后由前端计时器自己走，
 * **不再发任何请求**（倒计时不是轮询）。
 *
 * 与 SpiritBeastRaceDialog.vue 的 startCountdown / stopCountdown 同一写法；
 * 唯一区别是把「剩余秒数」换算成绝对截止时刻再每秒回算 —— 后台标签页的 setInterval
 * 会被节流，纯递减会越走越慢，回算则回到前台立刻就是正确值。
 */
const remaining = ref(0);
let countdownDeadlineMs = 0;
let countdownTimer: number | undefined;

/** 拿到新的剩余秒数：以此为截止点重启倒计时。 */
function applyRemainingSeconds(seconds: number): void {
  remaining.value = Math.max(0, Math.floor(seconds));
  countdownDeadlineMs = Date.now() + remaining.value * 1000;
  startCountdown();
}

function tickCountdown(): void {
  remaining.value = Math.max(0, Math.ceil((countdownDeadlineMs - Date.now()) / 1000));
  if (remaining.value <= 0) stopCountdown();
}

function startCountdown(): void {
  stopCountdown();
  tickCountdown();
  if (remaining.value <= 0) return;
  countdownTimer = window.setInterval(tickCountdown, 1000);
}

function stopCountdown(): void {
  if (countdownTimer !== undefined) {
    window.clearInterval(countdownTimer);
    countdownTimer = undefined;
  }
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const statusText = computed(() => {
  const current = boss.value;
  if (current === null) {
    return panel.value !== null && panel.value.phase === 'closed'
      ? '今日已结束，明日 12:00 再临'
      : '未出现：12:00 降临';
  }
  if (current.status === 'killed') return '已击杀';
  if (current.status === 'fled') {
    return current.fledOutcome === 'repelled' ? '已击退' : '已逃走';
  }
  // 本地倒计时归零 = 讨伐时段已过（23:00）：服务端的下一次 Cron 已经收口，
  // 让玩家点刷新取最新状态，而不是继续显示「讨伐中」。
  if (current.phase === 'closed' || remaining.value <= 0) return '已结束，点击刷新';
  return current.phase === 'frenzy' ? '力竭中 ×1.5' : '讨伐中';
});

const canAttack = computed(
  () =>
    (panel.value?.attackable ?? false) &&
    remaining.value > 0 &&
    selected.value.length > 0 &&
    !submitting.value &&
    props.busy !== true,
);

/** 伤害是换算前的原始数字（不走 formatAmount 的千分位换算）。 */
function formatDamage(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : '0';
}

/**
 * 时刻一律按 **UTC+8** 渲染（业务日就是 UTC+8，见 constants.dateKeyUtc8）：
 * 不用浏览器本地时区，否则跨时区的玩家看到的出手时刻会与业务日对不上。
 */
function timeUtc8(ms: number): string {
  const shifted = new Date(ms + 8 * 3_600_000);
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 出手记录一行：`21:32  乾坤门 · 白折月、墨明烛 联手打出 9,870 【暴击】【最后一击】`。 */
function hitLine(entry: WorldBossHitView): string {
  const names = entry.discipleNames.join('、');
  const verb = entry.discipleNames.length > 1 ? '联手打出' : '打出';
  const tags = `${entry.isCrit ? '【暴击】' : ''}${entry.isLastHit ? '【最后一击】' : ''}`;
  return `${timeUtc8(entry.createdAt)}  ${entry.sectName} · ${names} ${verb} ${formatDamage(entry.damage)} ${tags}`.trim();
}

async function refresh(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const data = await fetchWorldBoss();
    panel.value = data.boss;
    emit('state-update', data.state);
    applyRemainingSeconds(data.boss.remainingSeconds);
  } catch (error) {
    emit('notify', 'warning', '讨伐', error instanceof Error ? error.message : '面板加载失败');
  } finally {
    loading.value = false;
  }
}

async function submit(): Promise<void> {
  if (!canAttack.value) return;
  submitting.value = true;
  try {
    const data = await attackWorldBoss(selected.value);
    panel.value = data.boss;
    emit('state-update', data.state);
    applyRemainingSeconds(data.boss.remainingSeconds);

    hitKey.value += 1;
    hit.value = { damage: data.result.actualDamage, crit: data.result.crit };
    if (hitTimer !== null) window.clearTimeout(hitTimer);
    hitTimer = window.setTimeout(() => {
      hit.value = null;
    }, 900);
    selected.value = [];

    const parts = [`造成 ${formatDamage(data.result.actualDamage)} 伤害`];
    if (data.result.crit) parts.push('暴击');
    if (data.result.frenzy) parts.push('力竭 ×1.5');
    if (data.result.lastHit) parts.push('最后一击');
    parts.push(`参与奖 灵石 ${formatAmount(data.result.participationReward)}`);
    emit('notify', 'success', '讨伐', parts.join(' · '));
  } catch (error) {
    emit('notify', 'warning', '讨伐', error instanceof Error ? error.message : '出手失败，请稍后再试');
  } finally {
    submitting.value = false;
  }
}

onMounted(() => {
  // 打开面板取一次数（剩余秒数由 applyRemainingSeconds 启动本地倒计时）。
  void refresh();
});

onUnmounted(() => {
  stopCountdown();
  if (hitTimer !== null) window.clearTimeout(hitTimer);
});

const RULES_TEXT = `讨伐 · 玩法说明

时间：每日 12:00 妖王降临，12:00–23:00 可出手，23:00 未击杀即逃走。
力竭：22:00–23:00 妖王力竭，受到的伤害 ×1.5。
次数：每个宗门每日 3 次（不占赌坊次数），每次派 1~3 名弟子。
弟子：在外历练或正在疗伤的弟子不能出战；出手不会让弟子受伤，也不占用弟子。
伤害：队伍战力 × 演武场加成 × 0.8~1.2 浮动 × 暴击（1.5 倍）× 力竭（1.5 倍）。
奖励：
· 参与奖：每次出手立即发放灵石（按本宗产出计算，带保底）。
· 击杀：全服伤害榜上的每个参与宗门按伤害占比分奖池（灵石/药材/矿石），
  并各得聚气丹 ×1；伤害最高的宗门额外得淬体丹 ×1；最后一击的宗门另有灵石。
· 击退：23:00 逃走时血量已被打掉 70% 以上 —— 奖池规则相同但减半，无丹药。
· 单纯逃走（不足 70%）：只保留已经发过的参与奖。`;

const levelName = (level: number): string =>
  ['一', '二', '三', '四', '五'][level - 1] ?? String(level);

const dayKeyText = computed(() => boss.value?.dayKey ?? '');
</script>

<template>
  <section class="boss-panel" aria-labelledby="world-boss-title">
    <div class="boss-head">
      <h3 id="world-boss-title" class="boss-title">
        讨伐
        <span v-if="dayKeyText" class="boss-day">{{ dayKeyText }}</span>
        <span v-if="boss" class="boss-level">{{ levelName(boss.level) }}阶</span>
      </h3>
      <div class="boss-head-actions">
        <span v-if="panel && remaining > 0" class="boss-countdown">
          距结束 {{ formatCountdown(remaining) }}
        </span>
        <button class="boss-quiet-button" type="button" @click="showRules = !showRules">
          {{ showRules ? '收起说明' : '说明' }}
        </button>
        <button class="boss-quiet-button" type="button" :disabled="loading" @click="refresh">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </div>

    <div v-if="showRules" class="boss-rules">
      <p class="boss-rules-text">{{ RULES_TEXT }}</p>
    </div>

    <template v-else>
      <!-- 史上最强一击（常驻） -->
      <p class="boss-record">
        <span class="boss-record-label">史上最强一击</span>
        <template v-if="panel?.topHit">
          <strong class="boss-record-who">
            {{ panel.topHit.sectName }} · {{ panel.topHit.discipleNames.join('、') }}
          </strong>
          <span class="boss-record-damage">{{ formatDamage(panel.topHit.damage) }}</span>
        </template>
        <span v-else class="boss-record-empty">暂无记录</span>
      </p>

      <!-- Boss 区 -->
      <div class="boss-stage">
        <div class="boss-seal-wrap">
          <svg class="boss-seal" :class="{ 'is-hit': hit !== null }" :style="sealStyle" viewBox="0 0 120 120" aria-hidden="true">
            <circle class="boss-seal-ring" cx="60" cy="60" r="54" />
            <circle class="boss-seal-face" cx="60" cy="60" r="44" />
            <text class="boss-seal-text" x="60" y="62" text-anchor="middle" dominant-baseline="middle">
              {{ boss?.def.sealCharacter ?? '？' }}
            </text>
          </svg>
          <span v-if="hit" :key="hitKey" class="boss-damage-float" :class="{ 'is-crit': hit.crit }">
            {{ hit.crit ? '暴击 ' : '' }}{{ formatDamage(hit.damage) }}
          </span>
        </div>

        <div class="boss-info">
          <p class="boss-name">{{ boss?.def.displayName ?? '妖王未现' }}</p>
          <p class="boss-desc">
            {{ boss?.def.description ?? '每日 12:00 妖王降临黑风岭外，全服共讨之。' }}
          </p>
          <p class="boss-status" :class="{ 'is-down': boss !== null && boss.status !== 'active' }">
            {{ statusText }}
          </p>
          <template v-if="boss">
            <div
              class="boss-hp"
              role="progressbar"
              :aria-valuenow="hpPercent"
              aria-valuemin="0"
              aria-valuemax="100"
              :style="sealStyle"
            >
              <div class="boss-hp-fill" :style="{ width: `${hpPercent}%` }"></div>
            </div>
            <p class="boss-hp-text">
              {{ formatDamage(boss.hp) }} / {{ formatDamage(boss.maxHp) }}（{{ hpPercent }}%）
            </p>
          </template>
        </div>
      </div>

      <!-- 出手区 -->
      <DisciplePicker
        v-model:selected="selected"
        :disciples="state.disciples"
        :min="1"
        :max="3"
        :busy="submitting || busy === true"
        title="选择出战弟子"
      />

      <button class="boss-attack-button" type="button" :disabled="!canAttack" @click="submit">
        <span v-if="submitting">讨伐中…</span>
        <span v-else>
          出手讨伐（今日剩余 {{ panel?.remaining ?? 0 }}/{{ panel?.dailyLimit ?? 3 }} 次）
        </span>
      </button>

      <!-- 今日伤害榜 -->
      <section class="boss-section">
        <h4 class="boss-section-title">今日伤害榜</h4>
        <p v-if="panel === null || panel.ranks.length === 0" class="boss-empty">今日还没有人出手。</p>
        <ul v-else class="boss-ranks">
          <li
            v-for="(rank, index) in panel.ranks"
            :key="rank.sectId"
            class="boss-rank"
            :class="{ 'is-me': rank.isMe }"
          >
            <span class="boss-rank-no">{{ index + 1 }}</span>
            <strong class="boss-rank-name">{{ rank.sectName }}</strong>
            <span class="boss-rank-damage">{{ formatDamage(rank.damage) }}</span>
            <span class="boss-rank-attempts">{{ rank.attempts }} 次</span>
            <span v-if="rank.isTopDamage" class="boss-tag">最高伤害</span>
            <span v-if="rank.isLastHit" class="boss-tag">最后一击</span>
          </li>
        </ul>
      </section>

      <!-- 出手记录 -->
      <section class="boss-section">
        <h4 class="boss-section-title">出手记录</h4>
        <p v-if="panel === null || panel.hits.length === 0" class="boss-empty">还没有出手记录。</p>
        <ul v-else class="boss-hits">
          <li
            v-for="entry in panel.hits"
            :key="`${entry.createdAt}-${entry.sectId}-${entry.damage}-${entry.discipleNames.join()}`"
            class="boss-hit"
          >
            {{ hitLine(entry) }}
          </li>
        </ul>
      </section>
    </template>
  </section>
</template>

<style scoped>
.boss-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.boss-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.boss-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  color: var(--gold-bright, #ead19a);
  font-size: 16px;
  font-weight: 600;
}

.boss-day,
.boss-level {
  color: #8fa79b;
  font-size: 12px;
  font-weight: 400;
}

.boss-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.boss-countdown {
  color: var(--gold, #caa96a);
  font-size: 12px;
}

.boss-quiet-button {
  padding: 2px 10px;
  border: 1px solid rgba(202, 169, 106, 0.4);
  border-radius: 2px;
  background: rgba(202, 169, 106, 0.08);
  color: var(--gold, #caa96a);
  font-size: 12px;
  cursor: pointer;
}

.boss-quiet-button:hover:not(:disabled) {
  background: rgba(202, 169, 106, 0.16);
}

.boss-quiet-button:disabled {
  color: #63756c;
  cursor: not-allowed;
}

.boss-rules-text {
  margin: 0;
  color: #c8d6ce;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
}

.boss-record {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  padding: 6px 10px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.014);
  font-size: 12px;
}

.boss-record-label {
  flex: 0 0 auto;
  color: #8fa79b;
}

.boss-record-who {
  color: var(--gold-bright, #ead19a);
}

.boss-record-damage {
  color: #e8b96a;
  font-weight: 600;
}

.boss-record-empty {
  color: #6d8078;
}

.boss-stage {
  display: flex;
  align-items: center;
  gap: 16px;
}

.boss-seal-wrap {
  position: relative;
  flex: 0 0 auto;
}

.boss-seal {
  width: 104px;
  height: 104px;
  filter: drop-shadow(0 0 10px color-mix(in srgb, var(--boss-color, #7a8c6e) 55%, transparent));
}

.boss-seal.is-hit {
  animation: boss-shake 420ms ease-in-out;
}

.boss-seal-ring {
  fill: none;
  stroke: var(--boss-color, #7a8c6e);
  stroke-width: 2;
  opacity: 0.85;
}

.boss-seal-face {
  fill: color-mix(in srgb, var(--boss-color, #7a8c6e) 32%, rgba(6, 18, 15, 0.9));
  stroke: var(--boss-color, #7a8c6e);
  stroke-width: 1;
}

.boss-seal-text {
  fill: #f2ecdc;
  font-family: 'STKaiti', 'KaiTi', 'Kaiti SC', 'Kai', serif;
  font-size: 40px;
}

@keyframes boss-shake {
  0%,
  100% {
    transform: translateX(0);
  }
  20% {
    transform: translateX(-6px) rotate(-2deg);
  }
  45% {
    transform: translateX(5px) rotate(2deg);
  }
  70% {
    transform: translateX(-3px);
  }
}

.boss-damage-float {
  position: absolute;
  top: -6px;
  left: 50%;
  color: #e8ddc4;
  font-size: 16px;
  font-weight: 700;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
  white-space: nowrap;
  animation: boss-float 900ms ease-out forwards;
}

.boss-damage-float.is-crit {
  color: #ffd45e;
  font-size: 22px;
}

@keyframes boss-float {
  0% {
    opacity: 0;
    transform: translate(-50%, 6px);
  }
  25% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -34px);
  }
}

.boss-info {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 4px;
}

.boss-name {
  margin: 0;
  color: var(--gold-bright, #ead19a);
  font-size: 15px;
  font-weight: 600;
}

.boss-desc {
  margin: 0;
  color: #9fb2a8;
  font-size: 12px;
  line-height: 1.6;
}

.boss-status {
  margin: 0;
  color: var(--jade-bright, #77b89a);
  font-size: 12px;
}

.boss-status.is-down {
  color: #b08a5a;
}

.boss-hp {
  height: 8px;
  margin-top: 2px;
  overflow: hidden;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.05);
}

.boss-hp-fill {
  height: 100%;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--boss-color, #7a8c6e) 70%, #d8433a),
    var(--boss-color, #7a8c6e)
  );
  transition: width 420ms ease;
}

.boss-hp-text {
  margin: 0;
  color: #8fa79b;
  font-size: 11px;
}

.boss-attack-button {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  border: 1px solid rgba(202, 169, 106, 0.55);
  border-radius: 3px;
  background: rgba(202, 169, 106, 0.12);
  color: var(--gold-bright, #ead19a);
  font-size: 13px;
  cursor: pointer;
  transition: background-color 150ms ease, border-color 150ms ease;
}

.boss-attack-button:hover:not(:disabled) {
  border-color: rgba(234, 209, 154, 0.8);
  background: rgba(202, 169, 106, 0.2);
}

.boss-attack-button:disabled {
  border-color: rgba(167, 184, 173, 0.11);
  background: rgba(255, 255, 255, 0.016);
  color: #63756c;
  cursor: not-allowed;
}

.boss-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.boss-section-title {
  margin: 0;
  color: #8fa79b;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
}

.boss-empty {
  margin: 0;
  color: #6d8078;
  font-size: 12px;
}

.boss-ranks,
.boss-hits {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.boss-rank {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.014);
  font-size: 12px;
}

.boss-rank.is-me {
  border-color: rgba(119, 184, 154, 0.5);
  background: rgba(119, 184, 154, 0.08);
}

.boss-rank-no {
  flex: 0 0 16px;
  color: #6d8078;
}

.boss-rank-name {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  color: #cbd8d0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.boss-rank-damage {
  color: #e8b96a;
  font-weight: 600;
}

.boss-rank-attempts {
  color: #6d8078;
}

.boss-tag {
  padding: 1px 6px;
  border-radius: 20px;
  background: rgba(202, 169, 106, 0.14);
  color: var(--gold, #caa96a);
  font-size: 11px;
}

.boss-hit {
  color: #a9bcb2;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
}

@media (prefers-reduced-motion: reduce) {
  .boss-seal.is-hit,
  .boss-damage-float {
    animation: none;
  }

  .boss-hp-fill {
    transition: none;
  }
}
</style>
