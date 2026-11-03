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
  /** 宗门成长获得的公开头像框。 */
  frameId?: string | null;
}>();
const frameKind = computed(() => {
  if (props.frameId?.startsWith('achievement:')) return 'gold';
  return ({ 'frame-jade': 'jade', 'frame-cloud': 'cloud', 'frame-dragon': 'gold', 'frame-astral': 'astral', 'frame-alliance': 'alliance' } as Record<string, string>)[props.frameId ?? ''] ?? null;
});

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
  <span class="sect-avatar" :class="frameKind ? `sect-frame-${frameKind}` : undefined" aria-hidden="true">
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

<style scoped>
.sect-frame-jade { outline: 2px solid #4c9e82; outline-offset: 2px; box-shadow: 0 0 0 5px rgb(76 158 130 / 13%); }
.sect-frame-cloud { outline: 2px solid #8ca9c9; outline-offset: 2px; box-shadow: 0 0 0 5px rgb(140 169 201 / 18%); }
.sect-frame-gold { outline: 2px solid #bf9346; outline-offset: 2px; box-shadow: 0 0 0 5px rgb(191 147 70 / 18%); }
.sect-frame-astral { outline: 2px solid #b5a3e0; outline-offset: 2px; box-shadow: 0 0 0 5px rgb(181 163 224 / 18%); }
.sect-frame-alliance { outline: 2px solid #d5b778; outline-offset: 2px; box-shadow: 0 0 0 5px rgb(80 142 133 / 25%); }
</style>
