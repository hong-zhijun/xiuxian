<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';

import {
  AVATAR_OUTPUT_SIZE,
  centeredCrop,
  compressAvatar,
  loadAvatarSource,
  sourceSize,
  type AvatarCrop,
  type AvatarSource,
  type CompressedAvatar,
} from '../utils/avatarImage';
import ModalShell from './ModalShell.vue';

/**
 * 0038 上传自定义头像的裁剪弹窗：拖动挪位置、滑块 / 滚轮缩放，圆圈里就是最终头像。
 * 「使用这张」时在浏览器里压缩成 160×160 的 WebP / JPEG（几 KB），再交给上层上传。
 */
const props = defineProps<{ file: File; busy: boolean }>();
const emit = defineEmits<{
  confirm: [image: CompressedAvatar];
  close: [];
}>();

/** 预览画布的显示边长（CSS 像素）。 */
const VIEW = 240;
const MAX_ZOOM = 4;

const canvas = ref<HTMLCanvasElement | null>(null);
const source = ref<AvatarSource | null>(null);
const loadError = ref<string | null>(null);
const working = ref(false);
/** 缩放倍数：1 = 取短边整幅。 */
const zoom = ref(1);
/** 裁剪中心（源图像素坐标）。 */
const center = ref({ x: 0, y: 0 });

const size = computed(() => (source.value === null ? { width: 1, height: 1 } : sourceSize(source.value)));
const baseSide = computed(() => Math.min(size.value.width, size.value.height));

/** 当前裁剪区域：中心被夹在图片范围内，圆圈里永远不会出现空白。 */
const crop = computed<AvatarCrop>(() => {
  const side = baseSide.value / zoom.value;
  const half = side / 2;
  const x = Math.min(Math.max(center.value.x, half), size.value.width - half);
  const y = Math.min(Math.max(center.value.y, half), size.value.height - half);
  return { x: x - half, y: y - half, size: side };
});

function release(value: AvatarSource | null): void {
  if (value !== null && !(value instanceof HTMLImageElement)) value.close();
}

async function load(file: File): Promise<void> {
  loadError.value = null;
  release(source.value);
  source.value = null;
  try {
    const loaded = await loadAvatarSource(file);
    const { width, height } = sourceSize(loaded);
    const initial = centeredCrop(width, height);
    zoom.value = 1;
    center.value = { x: initial.x + initial.size / 2, y: initial.y + initial.size / 2 };
    source.value = loaded;
  } catch (caught) {
    loadError.value = caught instanceof Error ? caught.message : '这张图片读不出来';
  }
}

watch(() => props.file, (file) => { void load(file); }, { immediate: true });
onUnmounted(() => release(source.value));

function draw(): void {
  const element = canvas.value;
  const image = source.value;
  if (element === null || image === null) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  const pixels = Math.round(VIEW * ratio);
  if (element.width !== pixels) {
    element.width = pixels;
    element.height = pixels;
  }
  const context = element.getContext('2d');
  if (context === null) return;
  const { x, y, size: side } = crop.value;
  context.imageSmoothingQuality = 'high';
  context.clearRect(0, 0, pixels, pixels);
  context.drawImage(image, x, y, side, side, 0, 0, pixels, pixels);
}

watch([crop, source, canvas], draw, { flush: 'post' });

/* ---------- 拖动 ---------- */

let dragging: { pointerId: number; x: number; y: number } | null = null;

function onPointerDown(event: PointerEvent): void {
  if (source.value === null) return;
  dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  if (dragging === null || dragging.pointerId !== event.pointerId) return;
  // 屏幕上挪 1px = 源图上挪 (裁剪边长 / 预览边长) 像素；先夹紧再挪，拖出边界后往回拖立刻生效。
  const scale = crop.value.size / VIEW;
  const half = crop.value.size / 2;
  center.value = {
    x: crop.value.x + half - (event.clientX - dragging.x) * scale,
    y: crop.value.y + half - (event.clientY - dragging.y) * scale,
  };
  dragging = { ...dragging, x: event.clientX, y: event.clientY };
}

function onPointerUp(event: PointerEvent): void {
  if (dragging?.pointerId === event.pointerId) dragging = null;
}

/* ---------- 缩放 ---------- */

function setZoom(next: number): void {
  // 以当前裁剪中心为基准缩放（先把中心固定成夹紧后的值，缩小时不会跳）。
  const half = crop.value.size / 2;
  center.value = { x: crop.value.x + half, y: crop.value.y + half };
  zoom.value = Math.min(Math.max(next, 1), MAX_ZOOM);
}

function onZoomInput(event: Event): void {
  setZoom(Number((event.target as HTMLInputElement).value));
}

function onWheel(event: WheelEvent): void {
  if (source.value === null) return;
  event.preventDefault();
  setZoom(zoom.value * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
}

/* ---------- 确认 ---------- */

async function confirm(): Promise<void> {
  if (source.value === null || working.value || props.busy) return;
  working.value = true;
  loadError.value = null;
  try {
    emit('confirm', await compressAvatar(source.value, crop.value));
  } catch (caught) {
    loadError.value = caught instanceof Error ? caught.message : '图片压缩失败';
  } finally {
    working.value = false;
  }
}
</script>

<template>
  <ModalShell label="上传头像" narrow :loading="busy" loading-text="上传中…" @close="emit('close')">
    <section class="avatar-crop" aria-labelledby="avatar-crop-title">
      <header class="section-heading panel-heading compact-heading">
        <div>
          <p class="eyebrow">自定义头像</p>
          <h2 id="avatar-crop-title">调整头像</h2>
        </div>
      </header>
      <p class="disciple-detail-hint">拖动图片调整位置，滑块或滚轮缩放；圆圈里的部分就是头像。</p>

      <div class="avatar-crop-stage">
        <canvas
          v-show="source !== null"
          ref="canvas"
          class="avatar-crop-canvas"
          :style="{ width: `${VIEW}px`, height: `${VIEW}px` }"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @wheel="onWheel"
        />
        <span v-show="source !== null" class="avatar-crop-mask" aria-hidden="true" />
        <p v-if="source === null && loadError === null" class="disciple-detail-hint">读取图片中…</p>
      </div>

      <label v-if="source !== null" class="avatar-crop-zoom">
        <span>缩放</span>
        <input
          type="range"
          min="1"
          :max="MAX_ZOOM"
          step="0.01"
          :value="zoom"
          aria-label="缩放头像"
          @input="onZoomInput"
        />
      </label>

      <p v-if="loadError !== null" class="avatar-crop-error" role="alert">{{ loadError }}</p>

      <div class="avatar-crop-actions">
        <button class="action-button" type="button" :disabled="busy || working" @click="emit('close')">取消</button>
        <button
          class="action-button avatar-crop-confirm"
          type="button"
          :disabled="source === null || busy || working"
          @click="confirm"
        >
          {{ working ? '压缩中…' : '使用这张' }}
        </button>
      </div>
      <p class="disciple-detail-hint avatar-crop-note">
        上传前会自动压缩成 {{ AVATAR_OUTPUT_SIZE }}×{{ AVATAR_OUTPUT_SIZE }} 的小图（通常不到 15KB），所有玩家都能看到。
      </p>
    </section>
  </ModalShell>
</template>

<style scoped>
.avatar-crop {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.avatar-crop-stage {
  position: relative;
  display: flex;
  width: 240px;
  height: 240px;
  margin: 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: #050c0b;
  overflow: hidden;
}

.avatar-crop-canvas {
  display: block;
  cursor: grab;
  touch-action: none;
}

.avatar-crop-canvas:active {
  cursor: grabbing;
}

/* 圆圈外面压暗：box-shadow 铺满整块舞台，只留中间的圆。 */
.avatar-crop-mask {
  position: absolute;
  inset: 0;
  border: 1px solid rgba(202, 169, 106, 0.6);
  border-radius: 50%;
  box-shadow: 0 0 0 200px rgba(5, 12, 11, 0.62);
  pointer-events: none;
}

.avatar-crop-zoom {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--muted);
  font-size: 13px;
}

.avatar-crop-zoom input {
  flex: 1;
  accent-color: var(--gold);
}

.avatar-crop-error {
  margin: 0;
  color: var(--red-bright);
  font-size: 13px;
}

.avatar-crop-actions {
  display: flex;
  gap: 10px;
}

.avatar-crop-actions .action-button {
  min-height: 40px;
  flex: 1 1 0;
}

.avatar-crop-confirm {
  border-color: #d4b979;
  color: #0b1713;
  background: var(--gold);
}

.avatar-crop-confirm:disabled {
  opacity: 0.55;
}

.avatar-crop-note {
  margin: 0;
}
</style>
