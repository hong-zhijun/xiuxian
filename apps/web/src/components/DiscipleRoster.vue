<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import type { AssignmentOptionView, DiscipleView } from '../api/game';
import type {
  CultivationProgress,
  DiscipleFilter,
  DiscipleSortKey,
  DiscipleStatus,
  DiscipleStatusFilter,
} from '../utils/discipleFilter';
import {
  DEFAULT_DISCIPLE_FILTER,
  DISCIPLE_STATUS_FILTERS,
  DISCIPLE_SORT_OPTIONS,
  cultivationProgress,
  discipleStatus,
  filterDisciples,
  isFilterActive,
  realmOptions,
} from '../utils/discipleFilter';

/**
 * 门人名册：搜索 / 境界 / 岗位 / 状态筛选 + 排序 + 精简列表行 + 「详情」入口。
 *
 * 所有筛选、排序、状态派生都在 `utils/discipleFilter.ts` 的纯函数里，本组件只持有筛选状态。
 * 列表只显示：头像外圈修为进度 + 修为数字、姓名、私有备注、境界阶段、战力、
 * 当前状态、「详情」；备注为空时整行不渲染备注（不占位）。
 * 本地每秒平滑的修为只用于显示，状态与筛选一律用最新服务端字段。
 */
const props = defineProps<{
  disciples: DiscipleView[];
  assignments: AssignmentOptionView[];
  /** `Date.parse(state.serverNow)`，用于「疗伤中」判定。 */
  serverNowMs: number;
  /** 每秒本地推进的修为（只用于显示，不参与判定）。 */
  liveCultivation: Record<string, number>;
  busy: boolean;
  /** 详情弹窗正在看的弟子 id（null = 未打开）：关闭后把焦点还回对应「详情」按钮。 */
  detailId: string | null;
}>();

const emit = defineEmits<{
  openDetail: [discipleId: string];
}>();

const filter = ref<DiscipleFilter>({ ...DEFAULT_DISCIPLE_FILTER });

interface RosterRow {
  disciple: DiscipleView;
  status: DiscipleStatus;
  displayStatus: DiscipleStatus;
  progress: CultivationProgress;
}

const realmFilters = computed(() => realmOptions(props.disciples));

const matched = computed(() => filterDisciples(props.disciples, filter.value, props.serverNowMs));

const rows = computed<RosterRow[]>(() =>
  matched.value.map((disciple) => {
    const status = discipleStatus(disciple, props.serverNowMs);
    return {
      disciple,
      status,
      // 卡片只显示当前状态：疗伤优先，其余统一显示当前岗位。
      // 可破境由满环表达，不再重复占用状态标签。
      displayStatus:
        status.key === 'injured'
          ? status
          : { key: 'assignment', label: disciple.assignmentName },
      progress: cultivationProgress(
        props.liveCultivation[disciple.id] ?? disciple.cultivation,
        disciple.requiredCultivation,
      ),
    };
  }),
);

const anyFilterActive = computed(() => isFilterActive(filter.value));

function resetFilter(): void {
  filter.value = { ...DEFAULT_DISCIPLE_FILTER };
}

function onSearchInput(event: Event): void {
  filter.value = { ...filter.value, search: (event.target as HTMLInputElement).value };
}

function onRealmChange(event: Event): void {
  filter.value = { ...filter.value, realmId: (event.target as HTMLSelectElement).value };
}

function onAssignmentChange(event: Event): void {
  filter.value = { ...filter.value, assignment: (event.target as HTMLSelectElement).value };
}

function onStatusChange(event: Event): void {
  filter.value = {
    ...filter.value,
    status: (event.target as HTMLSelectElement).value as DiscipleStatusFilter,
  };
}

function onSortChange(event: Event): void {
  filter.value = {
    ...filter.value,
    sort: (event.target as HTMLSelectElement).value as DiscipleSortKey,
  };
}

function ringClass(row: RosterRow): string {
  if (row.disciple.canBreakthrough) return 'is-ready';
  if (row.progress.capped) return 'is-capped';
  return row.progress.full ? 'is-full' : 'is-normal';
}

function ringStyle(row: RosterRow): Record<string, string> {
  return { '--progress-angle': `${row.progress.percent * 3.6}deg` };
}

function ringValueText(row: RosterRow): string {
  return row.progress.capped
    ? `${row.progress.percent}%，已达当前版本上限`
    : `${row.progress.percent}%，修为 ${row.progress.text}`;
}

function ringTooltip(row: RosterRow): string {
  return row.progress.capped ? '已达当前版本上限' : `修为 ${row.progress.text}`;
}

function rowIndexStyle(index: number): Record<string, string> {
  // 入场错峰：只给前若干行延迟，避免长列表末尾等太久。
  return { '--row-order': String(Math.min(index, 8)) };
}

/** 「详情」按钮引用：弹窗关闭后把焦点还回触发它的那一行。 */
const rowButtons = ref<Record<string, HTMLButtonElement | null>>({});
const searchInput = ref<HTMLInputElement | null>(null);

function setRowButton(discipleId: string, element: Element | null): void {
  if (element instanceof HTMLButtonElement) {
    rowButtons.value[discipleId] = element;
  } else {
    delete rowButtons.value[discipleId];
  }
}

watch(
  () => props.detailId,
  (next, previous) => {
    if (previous === null || previous === undefined || next !== null) return;
    void nextTick(() => {
      const button = rowButtons.value[previous];
      // 驱逐后该行已不存在；焦点退回始终存在的搜索框，不能留在被移除的弹窗里。
      if (button && document.contains(button)) button.focus();
      else searchInput.value?.focus();
    });
  },
);
</script>

<template>
  <div class="disciple-roster">
    <div class="disciple-toolbar">
      <label class="disciple-field disciple-field-search">
        <span class="disciple-field-label">搜索</span>
        <input
          ref="searchInput"
          class="disciple-input"
          type="search"
          placeholder="姓名或备注"
          :value="filter.search"
          @input="onSearchInput"
        />
      </label>

      <label class="disciple-field">
        <span class="disciple-field-label">境界</span>
        <span class="disciple-select">
          <select class="disciple-input" :value="filter.realmId" @change="onRealmChange">
            <option value="">全部境界</option>
            <option v-for="realm in realmFilters" :key="realm.realmId" :value="realm.realmId">
              {{ realm.realmName }}
            </option>
          </select>
        </span>
      </label>

      <label class="disciple-field">
        <span class="disciple-field-label">岗位</span>
        <span class="disciple-select">
          <select class="disciple-input" :value="filter.assignment" @change="onAssignmentChange">
            <option value="">全部岗位</option>
            <option v-for="option in assignments" :key="option.id" :value="option.id">
              {{ option.name }}
            </option>
          </select>
        </span>
      </label>

      <label class="disciple-field">
        <span class="disciple-field-label">状态</span>
        <span class="disciple-select">
          <select class="disciple-input" :value="filter.status" @change="onStatusChange">
            <option v-for="option in DISCIPLE_STATUS_FILTERS" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </span>
      </label>

      <label class="disciple-field">
        <span class="disciple-field-label">排序</span>
        <span class="disciple-select">
          <select class="disciple-input" :value="filter.sort" @change="onSortChange">
            <option v-for="option in DISCIPLE_SORT_OPTIONS" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </span>
      </label>

      <button class="quiet-button disciple-reset" type="button" :disabled="!anyFilterActive" @click="resetFilter">
        重置
      </button>
    </div>

    <p class="disciple-count" role="status" aria-live="polite">
      匹配 <strong>{{ rows.length }}</strong> / 共 <strong>{{ disciples.length }}</strong> 位门人
    </p>

    <ul v-if="rows.length > 0" class="disciple-list">
      <li
        v-for="(row, index) in rows"
        :key="row.disciple.id"
        class="disciple-row"
        :class="`status-${row.displayStatus.key}`"
        :style="rowIndexStyle(index)"
      >
        <div class="disciple-row-media">
          <div
            class="disciple-ring"
            :class="ringClass(row)"
            :style="ringStyle(row)"
            :data-progress="ringTooltip(row)"
            tabindex="0"
            role="progressbar"
            :aria-label="`${row.disciple.name}修为进度`"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="row.progress.percent"
            :aria-valuetext="ringValueText(row)"
          >
            <div class="disciple-avatar" :class="`realm-${row.disciple.realmId}`" aria-hidden="true">
              <span>{{ row.disciple.name.slice(0, 1) }}</span>
              <i>{{ row.disciple.gender === 'female' ? '坤' : '乾' }}</i>
            </div>
          </div>
        </div>

        <div class="disciple-row-info">
          <strong class="disciple-row-name" :title="row.disciple.name">{{ row.disciple.name }}</strong>
          <div class="disciple-card-tags">
            <span class="realm-tag">{{ row.disciple.stageName }}</span>
            <span class="disciple-status" :class="`is-${row.displayStatus.key}`">
              {{ row.displayStatus.label }}
            </span>
          </div>
        </div>

        <div class="disciple-card-meta">
          <span class="disciple-row-power">战力 {{ row.disciple.combatPower }}</span>
        </div>

        <p
          class="disciple-row-note"
          :class="{ 'is-empty': row.disciple.note === '' }"
          :title="row.disciple.note || undefined"
          :aria-hidden="row.disciple.note === ''"
        >
          {{ row.disciple.note || '占位' }}
        </p>

        <button
          :ref="(element) => setRowButton(row.disciple.id, element as Element | null)"
          class="disciple-detail-button"
          type="button"
          :aria-label="`查看 ${row.disciple.name} 的详情`"
          @click="emit('openDetail', row.disciple.id)"
        >
          <span>详情</span>
        </button>
      </li>
    </ul>

    <div v-else-if="disciples.length === 0" class="empty-state">
      <span aria-hidden="true">寂</span>
      <strong>门下尚无弟子</strong>
      <p>可从上方操作栏的「招贤台」张榜迎接有缘之人。</p>
    </div>

    <div v-else class="empty-state compact-empty disciple-empty-filter">
      <span aria-hidden="true">寻</span>
      <strong>没有符合条件的门人</strong>
      <p>当前搜索与筛选下没有结果，可放宽条件或直接重置。</p>
      <button class="quiet-button" type="button" @click="resetFilter">重置筛选</button>
    </div>
  </div>
</template>
