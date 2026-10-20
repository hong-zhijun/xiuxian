<script setup lang="ts">
import { computed } from 'vue';

/**
 * 宠物秘境「选草丛」的一丛草（纯 SVG）。variant 决定草叶的排布，三丛长得各不相同；
 * state：idle 轻轻摆动，picked 剧烈抖动并飞出草叶，faded 未被选中的淡出。
 * 选哪一丛不影响结果——灵兽由服务端在选定后才随机，这里只是演出。
 */
const props = defineProps<{ variant: number; state: 'idle' | 'picked' | 'faded' }>();

const PALETTE = ['#2c5a3e', '#3b744d', '#4f8f58', '#6dab66'] as const;

/** 确定性的伪随机：同一个 variant 每次画出来都一样。 */
function seeded(seed: number): () => number {
  let value = seed * 9301 + 49297;
  return () => {
    value = (value * 9301 + 49297) % 233280;
    return value / 233280;
  };
}

/** 从后往前四层草叶：越靠前越亮、越矮。 */
const blades = computed(() => {
  const random = seeded(props.variant + 1);
  const result: { d: string; fill: string }[] = [];
  PALETTE.forEach((fill, layer) => {
    const count = 7 - layer;
    for (let i = 0; i < count; i += 1) {
      const x = 22 + (96 * (i + 0.5)) / count + (random() - 0.5) * 12;
      const height = 58 + (3 - layer) * 9 + random() * 18;
      const lean = (random() - 0.5) * 34 + (x - 70) * 0.25;
      const width = 6 + random() * 4;
      const tipX = x + lean;
      const tipY = 100 - height;
      result.push({
        fill,
        d: `M${(x - width).toFixed(1)} 100 Q${(x - width + lean * 0.3).toFixed(1)} ${(100 - height * 0.55).toFixed(1)} ${tipX.toFixed(1)} ${tipY.toFixed(1)} `
          + `Q${(x + width + lean * 0.35).toFixed(1)} ${(100 - height * 0.5).toFixed(1)} ${(x + width).toFixed(1)} 100 Z`,
      });
    }
  });
  return result;
});

/** 选中时飞出的草叶：方向与旋转各不相同。 */
const LEAVES = [
  { x: 40, y: 40, dx: -46, dy: -40, rot: -80 },
  { x: 62, y: 30, dx: -14, dy: -58, rot: 60 },
  { x: 80, y: 32, dx: 18, dy: -60, rot: -40 },
  { x: 98, y: 42, dx: 50, dy: -36, rot: 90 },
  { x: 52, y: 56, dx: -56, dy: -10, rot: 120 },
  { x: 90, y: 58, dx: 56, dy: -14, rot: -110 },
];
</script>

<template>
  <svg class="search-bush" :class="`is-${state}`" viewBox="0 0 140 110" aria-hidden="true">
    <ellipse class="bush-shadow" cx="70" cy="101" rx="54" ry="7" />
    <g class="bush-body" :style="{ animationDelay: `${String(-props.variant * 0.9)}s` }">
      <path v-for="(blade, index) in blades" :key="index" class="bush-blade" :d="blade.d" :style="{ fill: blade.fill }" />
      <circle class="bush-glint" cx="48" cy="52" r="1.6" />
      <circle class="bush-glint is-late" cx="94" cy="44" r="1.3" />
    </g>
    <g v-if="state === 'picked'" class="bush-leaves">
      <ellipse
        v-for="(leaf, index) in LEAVES"
        :key="index"
        class="bush-leaf"
        :cx="leaf.x"
        :cy="leaf.y"
        rx="5"
        ry="2.2"
        :style="{ '--dx': `${String(leaf.dx)}px`, '--dy': `${String(leaf.dy)}px`, '--rot': `${String(leaf.rot)}deg`, animationDelay: `${String(index * 60)}ms` }"
      />
    </g>
  </svg>
</template>

<style scoped>
.search-bush {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

.bush-shadow {
  fill: rgba(0, 0, 0, 0.35);
}

.bush-body {
  transform-box: fill-box;
  transform-origin: 50% 100%;
  animation: bush-sway 3.2s ease-in-out infinite;
  transition: opacity 260ms ease, filter 260ms ease;
}

/* 全局 `svg path` 是图标描边样式（fill: none），草叶要用自己的填充。 */
.bush-blade {
  stroke: rgba(6, 16, 15, 0.35);
  stroke-width: 0.6;
}

.bush-glint {
  fill: #e8f7c8;
  animation: bush-glint 2.6s ease-in-out infinite;
}

.bush-glint.is-late {
  animation-delay: 1.3s;
}

.is-picked .bush-body {
  animation: bush-rustle 180ms ease-in-out infinite;
  filter: brightness(1.15);
}

.is-faded .bush-body {
  opacity: 0.3;
  filter: grayscale(0.4);
  animation-play-state: paused;
}

.bush-leaf {
  fill: #7fbf6a;
  transform-box: fill-box;
  transform-origin: center;
  animation: bush-leaf 900ms ease-out infinite;
}

@keyframes bush-sway {
  0%, 100% { transform: rotate(-1.2deg); }
  50% { transform: rotate(1.2deg); }
}

@keyframes bush-rustle {
  0%, 100% { transform: rotate(-4deg) translateX(-1px); }
  50% { transform: rotate(4deg) translateX(1px); }
}

@keyframes bush-glint {
  0%, 100% { opacity: 0; }
  50% { opacity: 0.9; }
}

@keyframes bush-leaf {
  0% { opacity: 0; transform: translate(0, 0) rotate(0); }
  15% { opacity: 1; }
  100% { opacity: 0; transform: translate(var(--dx), var(--dy)) rotate(var(--rot)); }
}

@media (prefers-reduced-motion: reduce) {
  .bush-body,
  .bush-glint,
  .bush-leaf {
    animation: none;
  }
}
</style>
