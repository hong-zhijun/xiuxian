<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

/**
 * PC 端待办浮窗：固定在屏幕左上角，不随页面滚动；手机端不显示（见样式里的断点）。
 *
 * - 左侧留白够宽（≥ 1900px）时默认展开成一列，停在首页内容左边，不挡内容；
 * - 不够宽时默认收成左侧边缘的一个竖条「待办 N」，点开后浮在内容上方，点外面收起；
 * - 展开 / 收起记在本机（宽屏下手动收起后保持收起）。
 * 条目由 SectScreen 算好传进来，点一条 emit select，由 SectScreen 打开对应功能。
 */
export interface TodoItem {
  id: string;
  /** claim 可领取 / warn 提醒 / act 可操作 */
  tone: 'claim' | 'warn' | 'act';
  text: string;
  action: string;
}

defineProps<{ items: readonly TodoItem[] }>();

const emit = defineEmits<{ select: [id: string] }>();

const OPEN_KEY = 'todo-float-open';
const WIDE_QUERY = '(min-width: 1900px)';

const TONE_LABELS: Record<TodoItem['tone'], string> = { claim: '可领取', warn: '提醒', act: '可操作' };

function readPreference(): boolean | null {
  try {
    const value = localStorage.getItem(OPEN_KEY);
    return value === null ? null : value === '1';
  } catch {
    return null;
  }
}

const wide = ref(false);
const open = ref(false);
let media: MediaQueryList | null = null;

function onMediaChange(): void {
  wide.value = media?.matches ?? false;
  // 宽屏默认展开、窄屏默认收起；用户在宽屏上点过收起 / 展开就按他的来。
  const preference = readPreference();
  open.value = wide.value ? (preference ?? true) : false;
}

function toggle(): void {
  open.value = !open.value;
  if (wide.value) {
    try {
      localStorage.setItem(OPEN_KEY, open.value ? '1' : '0');
    } catch {
      /* 存不下只是下次又按默认来 */
    }
  }
}

function select(id: string): void {
  emit('select', id);
  // 窄屏是浮在内容上的：点了一条就收起，别挡住刚打开的功能。
  if (!wide.value) open.value = false;
}

/** 窄屏展开时点浮窗外面收起。 */
const root = ref<HTMLElement | null>(null);
function onDocumentPointer(event: PointerEvent): void {
  if (wide.value || !open.value) return;
  if (root.value !== null && !root.value.contains(event.target as Node)) open.value = false;
}

onMounted(() => {
  media = window.matchMedia(WIDE_QUERY);
  onMediaChange();
  media.addEventListener('change', onMediaChange);
  document.addEventListener('pointerdown', onDocumentPointer);
});

onUnmounted(() => {
  media?.removeEventListener('change', onMediaChange);
  document.removeEventListener('pointerdown', onDocumentPointer);
});

</script>

<template>
  <aside ref="root" class="todo-float" :class="{ 'is-wide': wide, 'is-open': open }" aria-label="待办">
    <button v-if="!open" class="todo-tab" type="button" :title="items.length > 0 ? `${items.length} 件待办` : '诸事已毕'" @click="toggle">
      <span>待</span>
      <span>办</span>
      <strong v-if="items.length > 0">{{ items.length }}</strong>
    </button>

    <section v-else class="todo-panel">
      <header class="todo-head">
        <strong>待办<template v-if="items.length > 0"> · {{ items.length }}</template></strong>
        <button class="todo-close" type="button" aria-label="收起待办" @click="toggle">收起</button>
      </header>
      <p v-if="items.length === 0" class="todo-empty">诸事已毕</p>
      <ul v-else class="todo-list">
        <li v-for="item in items" :key="item.id">
          <button class="todo-item" type="button" @click="select(item.id)">
            <span class="todo-tag" :class="`is-${item.tone}`">{{ TONE_LABELS[item.tone] }}</span>
            <span class="todo-text">{{ item.text }}</span>
            <span class="todo-action">{{ item.action }} ›</span>
          </button>
        </li>
      </ul>
    </section>
  </aside>
</template>

<style scoped>
.todo-float {
  position: fixed;
  z-index: 60;
  top: 18px;
  left: 0;
}

/* 收起：贴在左侧边缘的竖条（落在首页左右留白里）。 */
.todo-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 26px;
  padding: 8px 0;
  border: 1px solid rgba(202, 169, 106, 0.4);
  border-left: 0;
  border-radius: 0 6px 6px 0;
  background: rgba(13, 32, 27, 0.95);
  color: var(--gold, #caa96a);
  font-size: 12px;
  line-height: 1.3;
  cursor: pointer;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
}

.todo-tab strong {
  min-width: 18px;
  margin-top: 4px;
  padding: 1px 3px;
  border-radius: 20px;
  background: rgba(119, 184, 154, 0.18);
  color: var(--jade-bright, #77b89a);
  font-size: 11px;
  text-align: center;
}

.todo-panel {
  display: flex;
  width: 188px;
  max-height: calc(100vh - 36px);
  flex-direction: column;
  gap: 8px;
  margin-left: 12px;
  padding: 10px;
  overflow-y: auto;
  border: 1px solid rgba(202, 169, 106, 0.38);
  border-radius: 6px;
  background: linear-gradient(160deg, rgba(202, 169, 106, 0.08), transparent 55%), rgba(13, 32, 27, 0.97);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.4);
  scrollbar-width: none;
}

/* 窄屏展开时浮在内容上方，宽一点好读。 */
.todo-float:not(.is-wide) .todo-panel {
  width: 240px;
}

.todo-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.todo-head strong {
  color: var(--gold-bright, #ead19a);
  font-size: 14px;
}

.todo-close {
  padding: 0;
  border: 0;
  background: transparent;
  color: #7d9186;
  font-size: 11px;
  cursor: pointer;
}

.todo-empty {
  margin: 0;
  color: #6d8078;
  font-size: 12px;
}

.todo-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.todo-item {
  display: grid;
  width: 100%;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 3px 6px;
  padding: 6px 7px;
  border: 1px solid rgba(202, 169, 106, 0.2);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.02);
  color: #cbd8d0;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.todo-item:hover {
  border-color: rgba(234, 209, 154, 0.5);
  background: rgba(202, 169, 106, 0.08);
}

.todo-tag {
  align-self: start;
  padding: 0 5px;
  border-radius: 20px;
  font-size: 10px;
  white-space: nowrap;
}

.todo-tag.is-claim {
  background: rgba(119, 184, 154, 0.16);
  color: var(--jade-bright, #77b89a);
}

.todo-tag.is-warn {
  background: rgba(232, 128, 108, 0.16);
  color: #e8806c;
}

.todo-tag.is-act {
  background: rgba(202, 169, 106, 0.14);
  color: var(--gold, #caa96a);
}

.todo-text {
  min-width: 0;
  line-height: 1.4;
}

.todo-action {
  grid-column: 2;
  color: var(--gold, #caa96a);
  font-size: 11px;
}

/* 手机端不显示待办。 */
@media (max-width: 680px) {
  .todo-float {
    display: none;
  }
}
</style>
