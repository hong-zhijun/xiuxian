<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

import { isTopModalLayer, modalLayerCount, popModalLayer, pushModalLayer } from '../utils/modalStack';

/**
 * 通用弹窗外壳：遮罩 + 面板容器 + 右上角关闭按钮。
 *
 * 关闭方式：点遮罩、点关闭、按 Esc（多层叠加时只关最上面那层）；打开期间锁住页面滚动，
 * 并把焦点移进弹窗。内容自己滚（`.modal-card` 是唯一的滚动容器，滚动条全局隐藏）。
 */
defineProps<{
  /** 给读屏用的弹窗名称（内容里的标题通常已有 h2，这里只补一个简短标签）。 */
  label: string;
  /** 窄一点的弹窗（二级弹窗用）。 */
  narrow?: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

// 层级栈与滚动锁放在独立模块里（写在 <script setup> 里的「模块级」变量其实是每个实例一份）。
const layerToken: object = {};

const dialog = ref<HTMLElement | null>(null);

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') {
    return;
  }
  if (!isTopModalLayer(layerToken)) {
    return;
  }
  emit('close');
}

onMounted(() => {
  pushModalLayer(layerToken);
  document.body.style.overflow = 'hidden';
  window.addEventListener('keydown', onKeydown);
  dialog.value?.focus();
});

onUnmounted(() => {
  popModalLayer(layerToken);
  window.removeEventListener('keydown', onKeydown);
  if (modalLayerCount() === 0) {
    document.body.style.overflow = '';
  }
});
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div
      ref="dialog"
      class="modal-card game-panel"
      :class="{ 'is-narrow': narrow }"
      role="dialog"
      aria-modal="true"
      :aria-label="label"
      tabindex="-1"
    >
      <button class="modal-close" type="button" aria-label="关闭" @click="emit('close')">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="m5 5 10 10M15 5 5 15" />
        </svg>
      </button>
      <slot />
    </div>
  </div>
</template>
