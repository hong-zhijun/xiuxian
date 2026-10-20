<script setup lang="ts">
/**
 * 捕捉遭遇的立绘特效（纯 SVG + CSS 动画，叠在立绘上、不接收点击）：
 * - emerge：灵兽从草丛里窜出，草叶四散（立绘本身的弹出由父组件负责）；
 * - attack / restrain：三道 / 一道剑光划过（留手是淡青色的细剑光）；
 * - cast：御兽阵展开并旋转，等待服务端判定期间一直循环；
 * - caught：阵法收拢、金光一闪，盖下「收服」印；
 * - fail / escaped：阵法碎成四段飞散；
 * - killed / defeated：不画叠层，由父组件让立绘倒下变灰 / 让遭遇卡泛红。
 */
export type CaptureFxKind = 'emerge' | 'attack' | 'restrain' | 'cast' | 'caught' | 'fail' | 'escaped' | 'killed' | 'defeated';

defineProps<{ kind: CaptureFxKind }>();

const RUNES = [0, 45, 90, 135, 180, 225, 270, 315];
/** 灵兽现身时从立绘底部四散的草叶。 */
const LEAVES = [
  { dx: '-80px', dy: '-60px', rot: '-140deg', delay: '0ms' },
  { dx: '-46px', dy: '-104px', rot: '90deg', delay: '40ms' },
  { dx: '-8px', dy: '-120px', rot: '-60deg', delay: '80ms' },
  { dx: '36px', dy: '-108px', rot: '120deg', delay: '20ms' },
  { dx: '78px', dy: '-66px', rot: '-100deg', delay: '60ms' },
  { dx: '-96px', dy: '-14px', rot: '70deg', delay: '100ms' },
  { dx: '94px', dy: '-20px', rot: '-80deg', delay: '120ms' },
];
/** 阵法外环的四段圆弧（碎裂时各自朝外飞）。 */
const SHARDS = [
  { d: 'M100 10 A90 90 0 0 1 190 100', dx: '34px', dy: '-34px', rot: '24deg' },
  { d: 'M190 100 A90 90 0 0 1 100 190', dx: '34px', dy: '34px', rot: '-18deg' },
  { d: 'M100 190 A90 90 0 0 1 10 100', dx: '-34px', dy: '34px', rot: '20deg' },
  { d: 'M10 100 A90 90 0 0 1 100 10', dx: '-34px', dy: '-34px', rot: '-26deg' },
];
</script>

<template>
  <svg class="capture-fx" :class="`is-${kind}`" viewBox="0 0 200 200" aria-hidden="true">
    <defs>
      <radialGradient id="capture-fx-glow">
        <stop offset="0" stop-color="#fff1c9" stop-opacity="0.95" />
        <stop offset="0.55" stop-color="#e6c37a" stop-opacity="0.3" />
        <stop offset="1" stop-color="#e6c37a" stop-opacity="0" />
      </radialGradient>
    </defs>

    <g v-if="kind === 'emerge'" class="fx-leaves">
      <ellipse
        v-for="leaf in LEAVES"
        :key="leaf.rot"
        class="fx-leaf"
        cx="100"
        cy="150"
        rx="7"
        ry="3"
        :style="{ '--dx': leaf.dx, '--dy': leaf.dy, '--rot': leaf.rot, animationDelay: leaf.delay }"
      />
    </g>

    <g v-else-if="kind === 'attack' || kind === 'restrain'" class="fx-slashes">
      <path class="fx-slash" d="M38 44 L162 152" pathLength="1" />
      <template v-if="kind !== 'restrain'">
        <path class="fx-slash is-second" d="M154 38 L54 160" pathLength="1" />
        <path class="fx-slash is-third" d="M28 112 L174 84" pathLength="1" />
      </template>
    </g>

    <g v-else-if="kind !== 'killed' && kind !== 'defeated'" class="fx-seal">
      <circle class="fx-glow" cx="100" cy="100" r="98" fill="url(#capture-fx-glow)" />
      <g v-if="kind === 'fail' || kind === 'escaped'">
        <path
          v-for="shard in SHARDS"
          :key="shard.d"
          class="fx-shard"
          :d="shard.d"
          :style="{ '--dx': shard.dx, '--dy': shard.dy, '--rot': shard.rot }"
        />
      </g>
      <template v-else>
        <g class="fx-ring-outer">
          <circle class="fx-ring" cx="100" cy="100" r="90" />
          <rect
            v-for="deg in RUNES"
            :key="deg"
            class="fx-rune"
            x="96"
            y="6"
            width="8"
            height="8"
            :transform="`rotate(${String(deg)} 100 100) rotate(45 100 10)`"
          />
        </g>
        <g class="fx-ring-inner">
          <circle class="fx-ring is-thin" cx="100" cy="100" r="70" />
          <path class="fx-ring is-thin" d="M100 34 L157 133 L43 133 Z M100 166 L43 67 L157 67 Z" />
        </g>
      </template>
      <g v-if="kind === 'caught'" class="fx-stamp">
        <rect x="64" y="58" width="72" height="84" rx="6" />
        <text x="100" y="96">收</text>
        <text x="100" y="132">服</text>
      </g>
    </g>
  </svg>
</template>

<style scoped>
.capture-fx {
  position: absolute;
  z-index: 2;
  top: -22px;
  left: -22px;
  width: calc(100% + 44px);
  height: calc(100% + 44px);
  overflow: visible;
  pointer-events: none;
}

/* 只给做缩放 / 旋转动画的元素改变换原点：符文自带的 rotate(… 100 100) 要保持以画布为原点。 */
.fx-leaf,
.fx-seal,
.fx-ring-outer,
.fx-ring-inner,
.fx-glow,
.fx-stamp,
.fx-shard {
  transform-box: fill-box;
  transform-origin: center;
}

/* ---------- 现身草叶 ---------- */

.fx-leaf {
  fill: #7fbf6a;
  opacity: 0;
  animation: fx-leaf 800ms ease-out forwards;
}

@keyframes fx-leaf {
  0% { opacity: 0; transform: translate(0, 0) rotate(0); }
  15% { opacity: 1; }
  100% { opacity: 0; transform: translate(var(--dx), var(--dy)) rotate(var(--rot)); }
}

/* ---------- 剑光 ---------- */

.fx-slash {
  fill: none;
  stroke: #fff3d2;
  stroke-dasharray: 1 1;
  stroke-dashoffset: 1;
  stroke-linecap: round;
  stroke-width: 5;
  filter: drop-shadow(0 0 4px rgba(255, 200, 120, 0.9));
  animation: fx-slash 420ms ease-out forwards;
}

.fx-slash.is-second {
  animation-delay: 110ms;
}

.fx-slash.is-third {
  animation-delay: 220ms;
}

.is-restrain .fx-slash {
  stroke: #c4ecd4;
  stroke-width: 3;
  filter: drop-shadow(0 0 4px rgba(120, 200, 160, 0.9));
}

@keyframes fx-slash {
  0% { stroke-dashoffset: 1; opacity: 1; }
  60% { stroke-dashoffset: 0; opacity: 1; }
  100% { stroke-dashoffset: 0; opacity: 0; }
}

/* ---------- 御兽阵 ---------- */

.fx-ring {
  fill: none;
  stroke: #e6c37a;
  stroke-dasharray: 10 6;
  stroke-width: 2.5;
  filter: drop-shadow(0 0 3px rgba(230, 195, 122, 0.8));
}

.fx-ring.is-thin {
  stroke-dasharray: 3 5;
  stroke-width: 1.3;
  opacity: 0.85;
}

.fx-rune {
  fill: #ffe1a0;
}

.fx-glow {
  opacity: 0;
}

.is-cast .fx-seal {
  animation: fx-seal-in 360ms ease-out both;
}

.is-cast .fx-ring-outer {
  animation: fx-spin 2.4s linear infinite;
}

.is-cast .fx-ring-inner {
  animation: fx-spin 3.2s linear infinite reverse;
}

.is-cast .fx-glow {
  animation: fx-pulse 1.2s ease-in-out infinite;
}

.is-caught .fx-ring-outer,
.is-caught .fx-ring-inner {
  animation: fx-close 600ms ease-in forwards;
}

.is-caught .fx-glow {
  animation: fx-flash 900ms ease-out 300ms forwards;
}

.fx-stamp {
  animation: fx-stamp 520ms cubic-bezier(0.2, 1.6, 0.4, 1) 520ms both;
}

.fx-stamp rect {
  fill: rgba(184, 68, 47, 0.92);
  stroke: #f3c9a8;
  stroke-width: 2;
}

.fx-stamp text {
  fill: #fff1d6;
  font-family: serif;
  font-size: 30px;
  font-weight: 700;
  text-anchor: middle;
}

/* ---------- 阵法碎裂 ---------- */

.fx-shard {
  fill: none;
  stroke: #e6c37a;
  stroke-dasharray: 10 6;
  stroke-width: 2.5;
  animation: fx-shard 650ms ease-out forwards;
}

@keyframes fx-seal-in {
  from { opacity: 0; transform: scale(1.35); }
  to { opacity: 1; transform: scale(1); }
}

@keyframes fx-spin {
  to { transform: rotate(360deg); }
}

@keyframes fx-pulse {
  0%, 100% { opacity: 0.12; }
  50% { opacity: 0.42; }
}

@keyframes fx-close {
  to { opacity: 0; transform: scale(0.5) rotate(160deg); }
}

@keyframes fx-flash {
  0% { opacity: 0; transform: scale(0.5); }
  40% { opacity: 1; transform: scale(1.1); }
  100% { opacity: 0; transform: scale(1.3); }
}

@keyframes fx-stamp {
  from { opacity: 0; transform: scale(2.2) rotate(-14deg); }
  to { opacity: 1; transform: scale(1) rotate(-8deg); }
}

@keyframes fx-shard {
  from { opacity: 1; transform: translate(0, 0) rotate(0); }
  to { opacity: 0; transform: translate(var(--dx), var(--dy)) rotate(var(--rot)); }
}
</style>
