<script lang="ts">
/** 一次祭炼的结果（SectScreen 交给弹窗播动画；seq 每次 +1，弹窗按它触发）。 */
export interface RefineResult {
  seq: number;
  equipmentId: string;
  success: boolean;
  toLevel: number;
  /** 请求失败（材料不足、状态变化等）：弹窗只收起动画，原因由 SectScreen 走 toast。 */
  error: boolean;
}
</script>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';

import type { EquipmentItemView, ResourceView } from '../api/game';
import { formatAmount, formatBp } from '../utils/format';
import ModalShell from './ModalShell.vue';
import RefineTag, { REFINE_LEVEL_NAMES } from './RefineTag.vue';

/**
 * 祭炼二级弹窗（0044，docs/装备祭炼开发计划.md 5.3）：叠在上层，Esc / 点遮罩只关它。
 * 成功率、消耗、增量都取自服务端的 `item.refine.next`，这里只渲染并比较余额。
 * 点「祭炼」只 emit：弹窗保持打开，数据刷新后自动显示下一重。
 *
 * 祭炼动画（纯 SVG + CSS）：点下去先「炼制」至少 MIN_FORGE_MS（鼎火转旺、火星上升、法宝悬浮），
 * 结果到了再放「成功」（光环炸开，颜色按新重数：普通金 / 通灵紫 / 圆满赤金）或「未成」（青烟、法宝一抖），
 * 放完回到待机。炼制期间显示点下去那一刻的装备快照，免得结果在动画揭晓前就从数据里漏出来。
 */
const props = defineProps<{
  item: EquipmentItemView;
  resources: ResourceView[];
  busy: boolean;
  result: RefineResult | null;
}>();

const emit = defineEmits<{
  refine: [equipmentId: string];
  close: [];
}>();

/** 炼制阶段至少播多久（请求再快也要有个起伏）。 */
const MIN_FORGE_MS = 1200;
/** 成功 / 未成的动画时长。 */
const RESULT_MS = 1600;

type Phase = 'idle' | 'forging' | 'success' | 'fail';
const phase = ref<Phase>('idle');
/** 点「祭炼」那一刻的装备快照（炼制阶段显示它）。 */
const frozen = ref<EquipmentItemView | null>(null);
/** 正在播放的结果（成功时的新重数决定光环颜色）。 */
const shown = ref<RefineResult | null>(null);
let startedAt = 0;
let timer: number | undefined;

const view = computed(() => (phase.value === 'forging' && frozen.value !== null ? frozen.value : props.item));
const next = computed(() => view.value.refine.next);
const animating = computed(() => phase.value !== 'idle');

const ownerText = computed(() =>
  view.value.discipleId === null ? '背包' : `穿在 ${view.value.discipleName ?? '弟子'} 身上`,
);

/** 鼎上悬浮的法宝字：按部位。 */
const SLOT_GLYPHS: Record<string, string> = { weapon: '剑', armor: '甲', artifact: '宝' };
const glyph = computed(() => SLOT_GLYPHS[view.value.slot] ?? '器');

/** 成功光环的颜色：按新重数分三档（与 RefineTag 同色）。 */
const burstColor = computed(() => {
  const level = shown.value?.toLevel ?? 0;
  if (level >= 12) return '#ffb454';
  if (level >= 9) return '#c084fc';
  return '#f3d58a';
});

const resultText = computed(() => {
  if (phase.value === 'success') return `祭炼成功 · 已至${REFINE_LEVEL_NAMES[shown.value?.toLevel ?? 0] ?? ''}`;
  if (phase.value === 'fail') return '火候未到，材料已耗去，装备完好无损';
  if (phase.value === 'forging') return '鼎火正旺，祭炼中…';
  return '';
});

/** 本次消耗逐项：资源名、需要、拥有（都是最小单位），拥有不足的那项标红。 */
const costRows = computed(() => {
  if (next.value === null) return [];
  return Object.entries(next.value.cost).map(([resourceId, need]) => {
    const resource = props.resources.find((item) => item.id === resourceId);
    const have = Number(resource?.balance ?? 0);
    return {
      resourceId,
      name: resource?.name ?? resourceId,
      need: Number(need),
      have,
      lacking: have < Number(need),
    };
  });
});

const canRefine = computed(
  () => !props.busy && !animating.value && next.value !== null && costRows.value.every((row) => !row.lacking),
);

/** 里程碑提示（只按下一重判断）：五重副属性、九重通灵、十二重圆满。 */
const milestoneHint = computed(() => {
  switch (next.value?.level) {
    case 5:
      return '五重：副属性一次性提升';
    case 9:
      return '九重通灵：此后每重战力 +1%';
    case 12:
      return '十二重圆满：副属性再提升，战力再 +2%';
    default:
      return null;
  }
});

function clearTimer(): void {
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
  }
}

function startRefine(): void {
  if (!canRefine.value) return;
  clearTimer();
  frozen.value = props.item;
  shown.value = null;
  startedAt = Date.now();
  phase.value = 'forging';
  emit('refine', props.item.id);
}

// 结果到了：炼制不足 MIN_FORGE_MS 就再等一会儿，然后放成功 / 未成，放完回待机。
watch(
  () => props.result?.seq,
  () => {
    const result = props.result;
    if (result === null || result.equipmentId !== props.item.id || phase.value !== 'forging') return;
    clearTimer();
    const wait = Math.max(0, MIN_FORGE_MS - (Date.now() - startedAt));
    timer = window.setTimeout(() => {
      if (result.error) {
        phase.value = 'idle';
        return;
      }
      shown.value = result;
      phase.value = result.success ? 'success' : 'fail';
      timer = window.setTimeout(() => {
        phase.value = 'idle';
        timer = undefined;
      }, RESULT_MS);
    }, wait);
  },
);

onUnmounted(clearTimer);
</script>

<template>
  <ModalShell narrow :label="`祭炼 · ${view.name}`" @close="emit('close')">
    <section class="refine-dialog" aria-labelledby="refine-title">
      <header class="section-heading panel-heading compact-heading">
        <div>
          <p class="eyebrow">祭炼</p>
          <h2 id="refine-title" :style="{ color: view.color }">{{ view.name }}<RefineTag :level="view.refineLevel" /></h2>
        </div>
      </header>

      <p class="refine-owner">{{ ownerText }}</p>

      <!-- 祭炼动画：鼎、鼎火、悬浮的法宝；炼制 / 成功 / 未成三种状态由 phase 切换 class。 -->
      <div class="refine-stage">
        <svg
          class="refine-art"
          :class="`is-${phase}`"
          :style="{ '--burst': burstColor, '--item': view.color }"
          viewBox="0 0 200 150"
          role="img"
          :aria-label="resultText || '祭炼鼎'"
        >
          <!-- 法阵 -->
          <circle class="art-rune" cx="100" cy="58" r="46" />
          <circle class="art-rune art-rune-inner" cx="100" cy="58" r="34" />

          <!-- 成功：光环与光芒 -->
          <g class="art-burst">
            <circle class="art-ring" cx="100" cy="58" r="12" />
            <circle class="art-ring art-ring-late" cx="100" cy="58" r="12" />
            <g class="art-rays">
              <line v-for="index in 8" :key="index" x1="100" y1="34" x2="100" y2="22" :transform="`rotate(${index * 45} 100 58)`" />
            </g>
          </g>

          <!-- 未成：青烟 -->
          <g class="art-smoke">
            <circle cx="88" cy="70" r="9" />
            <circle class="art-smoke-b" cx="104" cy="66" r="11" />
            <circle class="art-smoke-c" cx="116" cy="72" r="8" />
          </g>

          <!-- 悬浮的法宝 -->
          <text class="art-glyph" x="100" y="68" text-anchor="middle">{{ glyph }}</text>

          <!-- 火星 -->
          <g class="art-sparks">
            <circle cx="86" cy="96" r="1.6" />
            <circle class="art-spark-b" cx="98" cy="96" r="1.3" />
            <circle class="art-spark-c" cx="108" cy="96" r="1.8" />
            <circle class="art-spark-d" cx="118" cy="96" r="1.4" />
            <circle class="art-spark-e" cx="93" cy="96" r="1.2" />
          </g>

          <!-- 鼎 -->
          <g class="art-cauldron">
            <path class="art-ear" d="M66 90 q-10 -12 2 -18" />
            <path class="art-ear" d="M134 90 q10 -12 -2 -18" />
            <path class="art-body" d="M62 96 h76 q-4 26 -38 28 q-34 -2 -38 -28 z" />
            <ellipse class="art-rim" cx="100" cy="96" rx="40" ry="6" />
            <path class="art-leg" d="M78 120 l-6 14" />
            <path class="art-leg" d="M122 120 l6 14" />
            <path class="art-leg" d="M100 124 v12" />
          </g>

          <!-- 鼎火 -->
          <g class="art-flames">
            <path class="art-flame" d="M86 146 q-6 -10 2 -20 q1 8 6 10 q2 6 -8 10 z" />
            <path class="art-flame art-flame-b" d="M100 148 q-8 -14 2 -26 q2 10 7 13 q2 8 -9 13 z" />
            <path class="art-flame art-flame-c" d="M114 146 q-6 -10 2 -20 q1 8 6 10 q2 6 -8 10 z" />
          </g>
        </svg>
        <p class="refine-result" :class="`is-${phase}`" aria-live="polite">{{ resultText }}</p>
      </div>

      <template v-if="next === null">
        <p class="refine-hint">已祭炼至十二重圆满。</p>
        <div class="disciple-break-confirm-actions">
          <button class="action-button primary-action" type="button" :disabled="animating" @click="emit('close')">关闭</button>
        </div>
      </template>

      <template v-else>
        <p class="refine-target">冲击 <strong>{{ REFINE_LEVEL_NAMES[next.level] }}</strong></p>

        <dl class="refine-changes">
          <div>
            <dt>{{ view.mainAttrName }}</dt>
            <dd>{{ view.mainValue }} → {{ view.mainValue + next.mainGain }}</dd>
          </div>
          <div v-if="next.subGain > 0">
            <dt>{{ view.subAttrName }}</dt>
            <dd>{{ view.subValue }} → {{ view.subValue + next.subGain }}</dd>
          </div>
          <div v-if="next.powerBonusGainBp > 0">
            <dt>战力加成</dt>
            <dd>+{{ formatBp(view.powerBonusBp) }} → +{{ formatBp(view.powerBonusBp + next.powerBonusGainBp) }}</dd>
          </div>
        </dl>

        <p v-if="milestoneHint" class="refine-milestone">{{ milestoneHint }}</p>

        <p class="refine-odds">成功率 {{ next.successBp / 100 }}%</p>
        <p class="refine-note">失败只耗材料，不会降重、不会损坏装备。</p>

        <ul class="refine-cost" aria-label="本次消耗">
          <li v-for="row in costRows" :key="row.resourceId" :class="{ 'is-lacking': row.lacking }">
            <span>{{ row.name }}</span>
            <span>需要 {{ formatAmount(row.need) }} / 拥有 {{ formatAmount(row.have) }}</span>
          </li>
        </ul>

        <div class="disciple-break-confirm-actions">
          <button class="action-button" type="button" @click="emit('close')">取消</button>
          <button class="action-button primary-action" type="button" :disabled="!canRefine" @click="startRefine">
            <span>{{ phase === 'forging' ? '祭炼中…' : '祭炼' }}</span>
          </button>
        </div>
      </template>
    </section>
  </ModalShell>
</template>

<style scoped>
.refine-dialog {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}

.refine-owner {
  margin: 0;
  color: #7d9186;
  font-size: 12px;
}

.refine-hint,
.refine-odds {
  margin: 0;
  color: #dce6e0;
  font-size: 13px;
}

.refine-target {
  margin: 0;
  color: #dce6e0;
  font-size: 13px;
}

.refine-target strong {
  color: var(--gold-bright, #e0cd97);
  font-weight: 500;
}

.refine-changes {
  display: grid;
  gap: 6px;
  margin: 0;
}

.refine-changes > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid rgba(119, 184, 154, 0.12);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.016);
}

.refine-changes dt {
  color: #7d9186;
  font-size: 12px;
}

.refine-changes dd {
  margin: 0;
  color: #e4ece6;
  font-size: 13px;
}

.refine-milestone {
  margin: 0;
  color: var(--gold-bright, #e0cd97);
  font-size: 12px;
}

.refine-note {
  margin: 0;
  color: #7d9186;
  font-size: 11px;
}

.refine-cost {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.refine-cost li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: #cbd8d0;
  font-size: 12px;
}

.refine-cost li.is-lacking {
  color: #e08a7a;
}

/* ---------- 祭炼动画 ---------- */

.refine-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 0 2px;
  border: 1px solid rgba(202, 169, 106, 0.12);
  border-radius: 4px;
  background: radial-gradient(circle at 50% 45%, rgba(202, 169, 106, 0.08), transparent 65%);
}

.refine-art {
  display: block;
  width: 200px;
  max-width: 100%;
  height: auto;
  overflow: visible;
}

/* 只给会动的元素设自身中心为变换原点；光芒的 line 带 rotate 属性，不能改它的原点。 */
.art-rune,
.art-glyph,
.art-flame,
.art-sparks circle,
.art-ring,
.art-rays,
.art-smoke circle {
  transform-box: fill-box;
  transform-origin: center;
}

.refine-result {
  min-height: 18px;
  margin: 0;
  color: #9db3a8;
  font-size: 12px;
  text-align: center;
}

.refine-result.is-success {
  color: var(--gold-bright, #ead19a);
  font-weight: 600;
  animation: art-pop 360ms ease-out;
}

.refine-result.is-fail {
  color: #a8b4ad;
}

/* 法阵 */
.art-rune {
  fill: none;
  stroke: rgba(202, 169, 106, 0.28);
  stroke-dasharray: 3 6;
  stroke-width: 1;
}

.art-rune-inner {
  stroke: rgba(202, 169, 106, 0.16);
  stroke-dasharray: 10 5;
}

.is-forging .art-rune {
  stroke: rgba(234, 209, 154, 0.6);
  animation: art-spin 2.4s linear infinite;
}

.is-forging .art-rune-inner {
  animation-direction: reverse;
  animation-duration: 1.6s;
}

/* 法宝字 */
.art-glyph {
  fill: var(--item, #e0cd97);
  font-family: 'STKaiti', 'KaiTi', serif;
  font-size: 30px;
  opacity: 0.85;
  animation: art-float 3s ease-in-out infinite;
}

.is-forging .art-glyph {
  opacity: 1;
  filter: drop-shadow(0 0 4px var(--item, #e0cd97));
  animation: art-float 0.9s ease-in-out infinite;
}

.is-success .art-glyph {
  opacity: 1;
  filter: drop-shadow(0 0 8px var(--burst));
  animation: art-pop 420ms ease-out;
}

.is-fail .art-glyph {
  opacity: 0.55;
  animation: art-shake 420ms ease-in-out;
}

/* 鼎 */
.art-body,
.art-rim {
  fill: #1b2f28;
  stroke: rgba(202, 169, 106, 0.75);
  stroke-width: 1.4;
}

.art-rim {
  fill: #0f1e1a;
}

.art-ear,
.art-leg {
  fill: none;
  stroke: rgba(202, 169, 106, 0.75);
  stroke-linecap: round;
  stroke-width: 2.4;
}

.is-forging .art-rim {
  fill: #3a2a12;
  animation: art-glow 0.6s ease-in-out infinite alternate;
}

/* 鼎火 */
.art-flame {
  fill: #f59e42;
  opacity: 0.55;
  transform-origin: bottom;
  animation: art-flicker 1.4s ease-in-out infinite;
}

.art-flame-b {
  fill: #fbbf24;
  animation-delay: -0.5s;
}

.art-flame-c {
  animation-delay: -0.9s;
}

.is-forging .art-flame {
  opacity: 1;
  animation: art-roar 0.32s ease-in-out infinite alternate;
}

.is-fail .art-flame {
  opacity: 0.25;
}

/* 火星：只在炼制时上升 */
.art-sparks circle {
  fill: #fde68a;
  opacity: 0;
}

.is-forging .art-sparks circle {
  animation: art-spark 1s ease-out infinite;
}

.is-forging .art-sparks .art-spark-b { animation-delay: 0.2s; }
.is-forging .art-sparks .art-spark-c { animation-delay: 0.45s; }
.is-forging .art-sparks .art-spark-d { animation-delay: 0.65s; }
.is-forging .art-sparks .art-spark-e { animation-delay: 0.8s; }

/* 成功光环 */
.art-burst {
  opacity: 0;
}

.is-success .art-burst {
  opacity: 1;
}

.art-ring {
  fill: none;
  stroke: var(--burst);
  stroke-width: 2;
  opacity: 0;
}

.is-success .art-ring {
  animation: art-ring 900ms ease-out forwards;
}

.is-success .art-ring-late {
  animation-delay: 220ms;
}

.art-rays line {
  stroke: var(--burst);
  stroke-linecap: round;
  stroke-width: 2;
}

.art-rays {
  opacity: 0;
}

.is-success .art-rays {
  animation: art-rays 900ms ease-out forwards;
}

/* 未成青烟 */
.art-smoke circle {
  fill: #8b9a93;
  opacity: 0;
}

.is-fail .art-smoke circle {
  animation: art-smoke 1.3s ease-out forwards;
}

.is-fail .art-smoke .art-smoke-b { animation-delay: 0.12s; }
.is-fail .art-smoke .art-smoke-c { animation-delay: 0.24s; }

@keyframes art-spin {
  to { transform: rotate(360deg); }
}

@keyframes art-float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
}

@keyframes art-pop {
  0% { transform: scale(0.8); }
  60% { transform: scale(1.18); }
  100% { transform: scale(1); }
}

@keyframes art-shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-4px); }
  50% { transform: translateX(4px); }
  75% { transform: translateX(-2px); }
}

@keyframes art-glow {
  to { fill: #6b4a14; }
}

@keyframes art-flicker {
  0%, 100% { transform: scaleY(1); }
  50% { transform: scaleY(0.82); }
}

@keyframes art-roar {
  from { transform: scaleY(1.05) scaleX(0.95); }
  to { transform: scaleY(1.45) scaleX(1.08); }
}

@keyframes art-spark {
  0% { opacity: 0; transform: translateY(0); }
  20% { opacity: 1; }
  100% { opacity: 0; transform: translateY(-46px); }
}

@keyframes art-ring {
  0% { opacity: 0.9; transform: scale(1); }
  100% { opacity: 0; transform: scale(5); }
}

@keyframes art-rays {
  0% { opacity: 0; transform: scale(0.6); }
  30% { opacity: 1; }
  100% { opacity: 0; transform: scale(1.4); }
}

@keyframes art-smoke {
  0% { opacity: 0.6; transform: translateY(0) scale(0.6); }
  100% { opacity: 0; transform: translateY(-34px) scale(1.6); }
}

/* 系统要求减少动效：只保留颜色与文字变化，不做位移与闪烁。 */
@media (prefers-reduced-motion: reduce) {
  .refine-art *,
  .refine-result {
    animation: none !important;
  }

  .is-success .art-burst,
  .is-success .art-rays {
    opacity: 1;
  }
}
</style>
