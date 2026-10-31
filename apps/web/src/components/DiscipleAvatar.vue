<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { avatarFrameOption, resolveAvatarFrameId } from '../utils/avatarFrames';
import { avatarImageUrl } from '../utils/avatarImage';

/**
 * 弟子头像：框图 + 中央姓名首字；有自定义头像（0038）时图片铺满整个圆形，框图与首字都不画。
 *
 * 层级固定为「最外修为环 → 框图 → 中央姓名首字」：修为环由调用方包在外层
 * （名册是 `.disciple-ring`，详情头部是 `.disciple-detail-portrait`），
 * 这里只画框图与首字。框图始终在首字**下面**，即使素材中央不透明也遮不住姓名。
 *
 * 服务端给的样式 id 只认白名单；未知值或图片加载失败都回退旧式外观（classic），
 * 绝不把破图、占位图或任意 URL 当成果。首字与性别标记是装饰，
 * 语义名称由调用方给出（名册按钮的 aria-label、详情头部的姓名标题）。
 */
const props = defineProps<{
  name: string;
  gender: string;
  realmId: string;
  /** 服务端样式 id（未知值按 classic 处理）。 */
  frameId: string;
  /** 0038 自定义头像的内容哈希；null / 不传 = 没有。图片加载失败时回退框图。 */
  imageHash?: string | null;
  /** 成仙后自动叠加金色仙纹边框，兼容自定义头像与原头像框。 */
  ascended?: boolean;
  /** detail = 详情头部与预览用的大尺寸。 */
  variant?: 'roster' | 'detail';
}>();

const imageFailed = ref(false);
const photoFailed = ref(false);

const photoSrc = computed(() =>
  props.imageHash !== undefined && props.imageHash !== null && !photoFailed.value
    ? avatarImageUrl(props.imageHash)
    : null,
);

const option = computed(() => avatarFrameOption(props.frameId));
/** 实际渲染用的样式 id：图片失败时回退 classic（只影响图片，不显示破图）。 */
const frameId = computed(() => resolveAvatarFrameId(props.frameId, imageFailed.value));
const showImage = computed(() => option.value.src !== null && !imageFailed.value);

// 换了弟子或换了样式就重新给图片一次机会：上一次的 404 不该永久锁死这一行。
watch(
  () => [props.name, option.value.src],
  () => {
    imageFailed.value = false;
  },
);
watch(
  () => props.imageHash,
  () => {
    photoFailed.value = false;
  },
);
</script>

<template>
  <div
    class="disciple-avatar"
    :class="[`realm-${realmId}`, { 'is-large': variant === 'detail', 'has-photo': photoSrc !== null, 'is-immortal': ascended }]"
    :data-frame="frameId"
    aria-hidden="true"
  >
    <img
      v-if="photoSrc !== null"
      class="disciple-photo"
      :src="photoSrc"
      alt=""
      decoding="async"
      loading="lazy"
      @error="photoFailed = true"
    />
    <img
      v-else-if="showImage"
      class="disciple-frame"
      :src="option.src ?? ''"
      alt=""
      decoding="async"
      @error="imageFailed = true"
    />
    <span v-if="photoSrc === null" class="disciple-avatar-char">{{ name.slice(0, 1) }}</span>
    <svg v-if="ascended" class="immortal-frame" viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <circle cx="50" cy="50" r="44" stroke="#f7d389" stroke-width="2.2" />
      <circle cx="50" cy="50" r="48" stroke="#f7d389" stroke-width="0.8" stroke-dasharray="24 8 2 8" />
      <path d="M50 0 55 6 50 12 45 6Z M100 50 94 55 88 50 94 45Z M50 100 45 94 50 88 55 94Z M0 50 6 45 12 50 6 55Z" fill="#ffe8ae" stroke="#9e712d" stroke-width="0.8" />
      <path d="M17 28c-7-2-8-9-3-12 3-2 6-1 7 2 5-4 12 0 10 5 M72 17c2-7 9-8 12-3 2 3 1 6-2 7 4 5 0 12-5 10 M83 72c7 2 8 9 3 12-3 2-6 1-7-2-5 4-12 0-10-5 M28 83c-2 7-9 8-12 3-2-3-1-6 2-7-4-5 0-12 5-10" stroke="#f7d389" stroke-width="1.4" stroke-linecap="round" />
    </svg>
    <i>{{ gender === 'female' ? '坤' : '乾' }}</i>
  </div>
</template>

<style scoped>
.disciple-avatar.is-immortal {
  border-color: #f7d389;
  color: #ffe8ae;
  box-shadow: 0 0 12px rgba(247, 211, 137, 0.3), 0 0 22px rgba(158, 215, 215, 0.12);
}
.immortal-frame {
  position: absolute;
  z-index: 3;
  inset: -10%;
  width: 120%;
  height: 120%;
  overflow: visible;
  pointer-events: none;
}
</style>
