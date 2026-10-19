<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import type { SectStateView, TechniqueCatalogView, TechniqueLibraryView } from '../api/game';
import ModalShell from './ModalShell.vue';
import { fetchTechniques, learnTechnique, upgradeTechnique } from '../api/game';
import { formatAmount } from '../utils/format';

/**
 * 0066 藏经阁：功法收录 / 参悟（docs/功法开发计划.md 第 9 节）。
 *
 * 只在打开与每次操作后请求，不轮询；收录所需残卷、参悟消耗与是否可参悟都由服务端算好，这里只渲染。
 */
const props = defineProps<{
  state: SectStateView;
  busy?: boolean;
}>();

const emit = defineEmits<{
  'state-update': [state: SectStateView];
  notify: [tone: 'success' | 'warning', title: string, message: string];
}>();

const library = ref<TechniqueLibraryView | null>(null);
const loading = ref(false);
const pendingId = ref<string | null>(null);
const errorText = ref('');

const maxLevel = computed(() => library.value?.maxLevel ?? 10);
/** 点开详情的功法 id（详情跟着 library 刷新，收录 / 参悟后直接显示新状态）。 */
const selectedId = ref<string | null>(null);
const selected = computed(() => library.value?.items.find((item) => item.id === selectedId.value) ?? null);

/** 列表里的收集状态：已收录看参悟等级，未收录看残卷进度。 */
function progressText(item: TechniqueCatalogView): string {
  return item.learned ? `参悟 ${String(item.level)} 级` : `残卷 ${String(item.scrolls)} / ${String(item.learnScrolls)}`;
}

/** 按流派分组（服务端下发的流派顺序）。 */
const groups = computed(() => {
  const items = library.value?.items ?? [];
  return (library.value?.schools ?? []).map((school) => ({
    id: school.id,
    name: school.name,
    items: items.filter((item) => item.school === school.id),
  }));
});

async function refresh(): Promise<void> {
  loading.value = true;
  errorText.value = '';
  try {
    library.value = (await fetchTechniques()).library;
  } catch (caught) {
    errorText.value = caught instanceof Error ? caught.message : '藏经阁读取失败';
  } finally {
    loading.value = false;
  }
}

/** 收录 / 参悟：成功后用服务端回执刷新面板与宗门状态。 */
async function act(item: TechniqueCatalogView, kind: 'learn' | 'upgrade'): Promise<void> {
  if (props.busy === true || pendingId.value !== null) return;
  pendingId.value = item.id;
  errorText.value = '';
  try {
    const data = kind === 'learn' ? await learnTechnique(item.id) : await upgradeTechnique(item.id);
    library.value = data.library;
    emit('state-update', data.state);
    emit('notify', 'success', '藏经阁', data.result.message);
  } catch (caught) {
    errorText.value = caught instanceof Error ? caught.message : '操作失败';
    emit('notify', 'warning', '藏经阁', errorText.value);
  } finally {
    pendingId.value = null;
  }
}

function stoneText(minUnits: number | null): string {
  return minUnits === null ? '' : formatAmount(String(minUnits));
}

onMounted(() => {
  void refresh();
});
</script>

<template>
  <div class="technique-dialog">
    <p class="technique-intro">
      功法归宗门：收录与参悟只做一次，修习的弟子共享等级。点开功法查看效果与参悟。
    </p>
    <p v-if="library && !library.unlocked" class="technique-lock" role="status">
      宗门建有藏经阁（1 级）后，才能收录与参悟功法。
    </p>
    <p v-if="loading" class="technique-quiet">正在取阅典籍…</p>

    <section v-for="group in groups" :key="group.id" class="technique-group">
      <h3 class="technique-group-title">{{ group.name }}</h3>
      <ul class="technique-list">
        <li v-for="item in group.items" :key="item.id">
          <button
            class="technique-row"
            :class="{ 'is-learned': item.learned, 'is-ready': !item.learned && item.learnRemaining === 0 }"
            type="button"
            @click="selectedId = item.id"
          >
            <span class="technique-row-head">
              <strong>{{ item.name }}</strong>
              <span class="technique-tier">{{ item.tierName }}</span>
            </span>
            <span class="technique-summary">{{ item.summary }}</span>
            <span class="technique-progress">{{ progressText(item) }}</span>
          </button>
        </li>
      </ul>
    </section>

    <p v-if="errorText" class="technique-error" role="alert">{{ errorText }}</p>

    <ModalShell v-if="selected" narrow :loading="pendingId !== null" :label="selected.name" @close="selectedId = null">
      <div class="technique-detail">
        <header class="technique-detail-head">
          <h2>{{ selected.name }}</h2>
          <span class="technique-tier">{{ selected.tierName }} · {{ selected.schoolName }}</span>
        </header>
        <p class="technique-summary">{{ selected.summary }}</p>
        <dl class="technique-facts">
          <dt>镇妖塔</dt>
          <dd>{{ selected.towerGain }}</dd>
          <dt>世界 Boss</dt>
          <dd>{{ selected.bossGain }}</dd>
          <dt>代价</dt>
          <dd class="technique-cost">{{ selected.cost }}</dd>
          <dt>参悟</dt>
          <dd>
            <template v-if="selected.learned">
              {{ selected.level }} / {{ maxLevel }} 级 · 系数 ×{{ selected.levelFactor.toFixed(2) }} · 主修弟子 {{ selected.disciplesUsing }} 名
            </template>
            <template v-else>未收录</template>
          </dd>
          <dt>残卷</dt>
          <dd>
            现有 {{ selected.scrolls }} 张
            <template v-if="!selected.learned"> · 收录需 {{ selected.learnScrolls }} 张</template>
            <template v-else-if="selected.upgradeScrolls !== null">
              · 参悟到 {{ selected.level + 1 }} 级需 {{ selected.upgradeScrolls }} 张、灵石 {{ stoneText(selected.upgradeStone) }}
            </template>
            <template v-else> · 已满级</template>
          </dd>
        </dl>
        <div class="technique-actions">
          <button
            v-if="!selected.learned"
            class="action-button primary-action technique-button"
            type="button"
            :disabled="busy === true || pendingId !== null || !library?.unlocked || selected.learnRemaining > 0"
            @click="act(selected, 'learn')"
          >
            {{ selected.learnRemaining > 0 ? `还差 ${selected.learnRemaining} 张残卷` : '收录' }}
          </button>
          <button
            v-else-if="selected.upgradeScrolls !== null"
            class="action-button primary-action technique-button"
            type="button"
            :disabled="busy === true || pendingId !== null || !library?.unlocked"
            @click="act(selected, 'upgrade')"
          >
            参悟至 {{ selected.level + 1 }} 级
          </button>
        </div>
      </div>
    </ModalShell>
  </div>
</template>

<style scoped>
.technique-dialog {
  display: grid;
  gap: 14px;
  padding: 4px 2px 12px;
}

.technique-intro,
.technique-quiet,
.technique-lock {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}

.technique-lock {
  color: var(--gold);
}

.technique-group-title {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--gold);
}

.technique-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.technique-row {
  display: grid;
  width: 100%;
  gap: 3px;
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  color: var(--ink-text);
  text-align: left;
  cursor: pointer;
  transition: border-color 160ms ease, background-color 160ms ease;
}

.technique-row:hover {
  border-color: var(--line-strong);
  background: var(--surface-strong);
}

.technique-row.is-learned {
  border-color: var(--jade-dark);
}

.technique-row-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.technique-tier {
  font-size: 12px;
  color: var(--gold);
}

.technique-summary {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}

.technique-progress {
  font-size: 12px;
  color: var(--faint);
}

.technique-row.is-learned .technique-progress {
  color: var(--jade);
}

.technique-row.is-ready .technique-progress {
  color: var(--gold);
}

.technique-detail {
  display: grid;
  gap: 10px;
}

.technique-detail-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
  padding-right: 32px;
}

.technique-detail-head h2 {
  margin: 0;
  font-size: 18px;
}

.technique-facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
}

.technique-facts dt {
  color: var(--muted);
  white-space: nowrap;
}

.technique-facts dd {
  margin: 0;
}

.technique-facts dd.technique-cost {
  color: var(--red-bright);
}

.technique-actions {
  display: flex;
  justify-content: flex-end;
}

.technique-button {
  min-height: 34px;
  padding: 6px 16px;
  font-size: 13px;
}

.technique-error {
  margin: 0;
  color: var(--red-bright);
  font-size: 13px;
}

@media (max-width: 560px) {
  .technique-list {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
