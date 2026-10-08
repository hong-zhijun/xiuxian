<script setup lang="ts">
import ModalShell from './ModalShell.vue';

/**
 * 通用二次确认弹窗（替代 window.confirm）：叠在当前弹窗之上，取消 / Esc / 点遮罩只关这一层。
 * 正文 `message` 按原样换行；需要更复杂的正文时用默认插槽。
 */
defineProps<{
  /** 小标题（eyebrow），例如「拍卖行」。 */
  eyebrow: string;
  title: string;
  message?: string;
  confirmText: string;
  busy?: boolean;
}>();

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>

<template>
  <ModalShell narrow :label="title" @close="emit('cancel')">
    <section class="disciple-break-confirm" aria-labelledby="confirm-dialog-title">
      <header class="section-heading panel-heading compact-heading">
        <div>
          <p class="eyebrow">{{ eyebrow }}</p>
          <h2 id="confirm-dialog-title">{{ title }}</h2>
        </div>
      </header>

      <p v-if="message" class="disciple-detail-hint confirm-dialog-message">{{ message }}</p>
      <slot />

      <div class="disciple-break-confirm-actions">
        <button class="action-button" type="button" :disabled="busy" @click="emit('cancel')">取消</button>
        <button class="action-button primary-action" type="button" :disabled="busy" @click="emit('confirm')">
          <span>{{ confirmText }}</span>
        </button>
      </div>
    </section>
  </ModalShell>
</template>

<style scoped>
.confirm-dialog-message {
  white-space: pre-line;
}
</style>
