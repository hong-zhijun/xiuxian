<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { avatarImageUrl } from '../utils/avatarImage';

/**
 * 0073 宗门头像：有自定义头像就按内容哈希取图（圆形铺满），没有就显示宗门名首字。
 *
 * 尺寸由调用方的 class 给：`--sect-avatar-size`（默认 36px），首字字号按尺寸折算。
 * 观感与弟子头像同一套——墨绿底 + 金边 + 楷体首字；图片失败时回退首字，不显示破图。
 * 名字在外面已有语义文本，这里整块是装饰（aria-hidden）。
 */
const props = defineProps<{
  name: string;
  /** 0073 头像哈希；null / 不传 = 没有自定义头像。 */
  imageHash?: string | null;
}>();

const failed = ref(false);

const src = computed(() =>
  props.imageHash !== undefined && props.imageHash !== null && !failed.value
    ? avatarImageUrl(props.imageHash)
    : null,
);

// 换了宗门或换了图就重新给图片一次机会：上一次的 404 不该永久锁死这个位置。
watch(
  () => [props.name, props.imageHash],
  () => {
    failed.value = false;
  },
);
</script>

<template>
  <span class="sect-avatar" aria-hidden="true">
    <img
      v-if="src !== null"
      class="sect-avatar-img"
      :src="src"
      alt=""
      decoding="async"
      loading="lazy"
      @error="failed = true"
    />
    <span v-else class="sect-avatar-char">{{ name.slice(0, 1) }}</span>
  </span>
</template>
