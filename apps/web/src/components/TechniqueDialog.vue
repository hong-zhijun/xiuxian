<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import type { SectStateView, TechniqueCatalogView, TechniqueLibraryView } from '../api/game';
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
      功法归宗门：收录与参悟只做一次，修习的弟子共享等级。参悟系数每级 +8%，熟练度满 48 小时（以主修为准）。
    </p>
    <p v-if="library && !library.unlocked" class="technique-lock" role="status">
      宗门建有藏经阁（1 级）后，才能收录与参悟功法。
    </p>
    <p v-if="loading" class="technique-quiet">正在取阅典籍…</p>

    <section v-for="group in groups" :key="group.id" class="technique-group">
      <h3 class="technique-group-title">{{ group.name }}</h3>
      <ul class="technique-list">
        <li
          v-for="item in group.items"
          :key="item.id"
          class="technique-card"
          :class="{ 'is-learned': item.learned }"
        >
          <div class="technique-head">
            <strong>{{ item.name }}</strong>
            <span class="technique-tier">{{ item.tierName }}</span>
            <span v-if="item.learned" class="technique-level">{{ item.level }} / {{ maxLevel }} 级</span>
            <span v-else class="technique-level is-unlearned">未收录</span>
          </div>
          <p class="technique-line"><b>镇妖塔</b>{{ item.towerGain }}</p>
          <p class="technique-line"><b>世界 Boss</b>{{ item.bossGain }}</p>
          <p class="technique-line is-cost"><b>代价</b>{{ item.cost }}</p>
          <p class="technique-line is-quiet">
            {{ item.scrollName }} {{ item.scrolls }} 张
            <template v-if="!item.learned">
              · 收录需 {{ item.learnScrolls }} 张，还差 {{ item.learnRemaining }} 张
            </template>
            <template v-else-if="item.upgradeScrolls !== null">
              · 参悟到 {{ item.level + 1 }} 级需残卷 {{ item.upgradeScrolls }} 张、灵石 {{ stoneText(item.upgradeStone) }}
            </template>
            <template v-else> · 已满级</template>
          </p>
          <p v-if="item.learned" class="technique-line is-quiet">
            主修弟子 {{ item.disciplesUsing }} 名 · 参悟系数 ×{{ item.levelFactor.toFixed(2) }}
          </p>
          <div class="technique-actions">
            <button
              v-if="!item.learned"
              class="action-button technique-button"
              type="button"
              :disabled="busy === true || pendingId !== null || !library?.unlocked || item.learnRemaining > 0"
              @click="act(item, 'learn')"
            >
              {{ item.learnRemaining > 0 ? '残卷不足' : '收录' }}
            </button>
            <button
              v-else-if="item.upgradeScrolls !== null"
              class="action-button technique-button"
              type="button"
              :disabled="busy === true || pendingId !== null || !library?.unlocked"
              @click="act(item, 'upgrade')"
            >
              参悟至 {{ item.level + 1 }} 级
            </button>
          </div>
        </li>
      </ul>
    </section>

    <p v-if="errorText" class="technique-error" role="alert">{{ errorText }}</p>
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
  font-size: 15px;
}

.technique-list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.technique-card {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
}

.technique-card.is-learned {
  border-color: var(--jade-dark, var(--jade));
}

.technique-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}

.technique-tier,
.technique-level {
  font-size: 12px;
  color: var(--gold);
}

.technique-level.is-unlearned {
  color: var(--faint);
}

.technique-line {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.technique-line b {
  margin-right: 6px;
  font-weight: 600;
}

.technique-line.is-cost {
  color: var(--gold);
}

.technique-line.is-quiet {
  color: var(--muted);
  font-size: 12px;
}

.technique-actions {
  display: flex;
  justify-content: flex-end;
}

.technique-button {
  min-width: 132px;
}

.technique-error {
  margin: 0;
  color: var(--red-bright, var(--red));
  font-size: 13px;
}

@media (max-width: 480px) {
  .technique-card {
    padding: 10px;
  }

  .technique-button {
    width: 100%;
  }
}
</style>
