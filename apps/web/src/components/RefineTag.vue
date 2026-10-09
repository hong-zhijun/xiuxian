<script lang="ts">
/**
 * 中文重数表（下标 = 重数）：一重 … 十二重，与服务端 equipment.ts 的 refineChineseLevel 同一张表。
 * 祭炼弹窗与回执文案共用这一份；成功率 / 消耗 / 增量一律以服务端的 refine.next 为准，前端不复制。
 */
export const REFINE_LEVEL_NAMES: readonly string[] = [
  '', '一重', '二重', '三重', '四重', '五重', '六重',
  '七重', '八重', '九重', '十重', '十一重', '十二重',
];
</script>

<script setup lang="ts">
import { computed } from 'vue';

/**
 * 装备名后的重数标签（0044 祭炼）：一～八重普通色，九～十一重紫色（通灵），十二重赤金（圆满）。
 * level <= 0 时什么都不渲染。
 */
const props = defineProps<{
  level: number;
}>();

const text = computed(() => REFINE_LEVEL_NAMES[props.level] ?? '');
const tier = computed(() => {
  if (props.level >= 12) return 'is-perfect';
  if (props.level >= 9) return 'is-mystic';
  return 'is-normal';
});
</script>

<template>
  <span v-if="level > 0" class="refine-tag" :class="tier">{{ text }}</span>
</template>

<style scoped>
/* 字体写死成正文字体：放进楷体大标题（祭炼弹窗、拍卖上架弹窗）时，11px 的楷体糊成一团。 */
.refine-tag {
  margin-left: 4px;
  font-family: 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', Arial, sans-serif;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  vertical-align: middle;
  white-space: nowrap;
}

.refine-tag.is-normal {
  color: #9fb2a8;
}

.refine-tag.is-mystic {
  color: #c084fc;
  text-shadow: 0 0 6px rgba(192, 132, 252, 0.45);
}

.refine-tag.is-perfect {
  color: #ffb454;
  text-shadow: 0 0 6px rgba(255, 140, 50, 0.55);
}
</style>
