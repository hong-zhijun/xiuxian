<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

const props = defineProps<{ revealed: boolean }>();
const emit = defineEmits<{ reveal: []; progress: [percent: number] }>();
const surface = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const flakes = ref<{ id: number; x: number; y: number; drift: number }[]>([]);
const flakeTimers = new Set<number>();
let flakeId = 0;
let lastFlakeAt = 0;
type Point = { x: number; y: number };
const strokes: Point[][] = [];
let active: Point[] | null = null;
let observer: ResizeObserver | undefined;
let width = 0;
let height = 0;

function erase(points: Point[]): void {
  const context = canvas.value?.getContext('2d');
  if (context === null || context === undefined || points.length === 0) return;
  context.globalCompositeOperation = 'destination-out';
  context.lineWidth = Math.min(width, height) * 0.18;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.beginPath();
  context.moveTo(points[0]!.x * width, points[0]!.y * height);
  for (const point of points.slice(1)) context.lineTo(point.x * width, point.y * height);
  if (points.length === 1) context.lineTo(points[0]!.x * width + 0.1, points[0]!.y * height);
  context.stroke();
}

function paint(): void {
  const element = canvas.value;
  if (element === null || surface.value === null) return;
  const bounds = surface.value.getBoundingClientRect();
  width = bounds.width;
  height = bounds.height;
  if (width === 0 || height === 0) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  element.width = Math.round(width * ratio);
  element.height = Math.round(height * ratio);
  const context = element.getContext('2d', { willReadFrequently: true });
  if (context === null) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.globalCompositeOperation = 'source-over';
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#c4baa1');
  gradient.addColorStop(0.5, '#ece5d3');
  gradient.addColorStop(1, '#a89d82');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = 'rgba(80, 68, 43, .12)';
  context.lineWidth = 1;
  for (let x = -height; x < width; x += 16) {
    context.beginPath(); context.moveTo(x, 0); context.lineTo(x + height, height); context.stroke();
  }
  context.fillStyle = '#51472f';
  context.textAlign = 'center';
  context.font = '600 25px serif';
  context.fillText('刮 开 见 喜', width / 2, height / 2 - 4);
  context.font = '14px sans-serif';
  context.fillText('刮开80%后自动揭晓', width / 2, height / 2 + 28);
  context.strokeStyle = '#000';
  for (const stroke of strokes) erase(stroke);
}

function pointOf(event: PointerEvent): Point {
  const bounds = canvas.value!.getBoundingClientRect();
  return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
}

function start(event: PointerEvent): void {
  if (props.revealed || !event.isPrimary || event.button !== 0) return;
  event.preventDefault();
  canvas.value?.setPointerCapture(event.pointerId);
  active = [pointOf(event)];
  strokes.push(active);
  erase(active);
}

function move(event: PointerEvent): void {
  if (active === null || props.revealed) return;
  const point = pointOf(event);
  erase([active[active.length - 1]!, point]);
  active.push(point);
  const time = performance.now();
  if (time - lastFlakeAt > 35 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    lastFlakeAt = time;
    const id = flakeId++;
    flakes.value.push({ id, x: point.x * 100, y: point.y * 100, drift: id % 2 === 0 ? -18 : 18 });
    const timer = window.setTimeout(() => {
      flakes.value = flakes.value.filter(flake => flake.id !== id);
      flakeTimers.delete(timer);
    }, 420);
    flakeTimers.add(timer);
  }
}

function finish(): void {
  if (active === null) return;
  active = null;
  const element = canvas.value;
  const context = element?.getContext('2d');
  if (element === null || element === undefined || context === null || context === undefined) return;
  const pixels = context.getImageData(0, 0, element.width, element.height).data;
  let cleared = 0;
  let sampled = 0;
  for (let index = 3; index < pixels.length; index += 64) {
    sampled += 1;
    if (pixels[index]! < 128) cleared += 1;
  }
  if (sampled > 0) {
    emit('progress', Math.floor(cleared / sampled * 100));
    if (cleared / sampled >= 0.8) emit('reveal');
  }
}

onMounted(() => {
  observer = new ResizeObserver(paint);
  if (surface.value !== null) observer.observe(surface.value);
  paint();
});
onUnmounted(() => {
  observer?.disconnect();
  for (const timer of flakeTimers) window.clearTimeout(timer);
});
</script>

<template>
  <div ref="surface" class="scratch-surface" :class="{ 'is-revealed': revealed }">
    <div :aria-hidden="!revealed"><slot /></div>
    <canvas ref="canvas" aria-label="刮奖涂层，也可使用下方一键刮开按钮" :aria-hidden="revealed"
      @pointerdown="start" @pointermove="move" @pointerup="finish" @pointercancel="finish" />
    <i v-for="flake in flakes" :key="flake.id" class="scratch-flake" aria-hidden="true"
      :style="{ left: `${flake.x}%`, top: `${flake.y}%`, '--drift': `${flake.drift}px` }" />
  </div>
</template>

<style scoped>
.scratch-surface { position: relative; overflow: hidden; border-radius: 12px; }
canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; cursor: crosshair; }
.is-revealed canvas { opacity: 0; pointer-events: none; transition: opacity .25s; }
.scratch-flake { position: absolute; width: 5px; height: 3px; background: #d9ceb3; pointer-events: none; animation: scratch-flake .42s ease-out forwards; }
@keyframes scratch-flake { to { transform: translate(var(--drift), 30px) rotate(160deg); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .is-revealed canvas { transition: none; } }
</style>
