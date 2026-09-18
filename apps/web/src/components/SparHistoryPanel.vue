<script setup lang="ts">
import { ref, watch } from 'vue';

import type { SectStateView, SparHistoryView, SparHistoryEntryView } from '../api/game';
import { fetchSparHistory } from '../api/game';
import { formatTime } from '../utils/format';

const props = defineProps<{
  state: SectStateView;
}>();

const history = ref<SparHistoryView | null>(null);
const loadError = ref<string | null>(null);

let loadSeq = 0;

async function load(): Promise<void> {
  const seq = (loadSeq += 1);
  try {
    const data = await fetchSparHistory();
    if (seq !== loadSeq) return;
    history.value = data;
    loadError.value = null;
  } catch (caught) {
    if (seq !== loadSeq) return;
    loadError.value = caught instanceof Error ? caught.message : '读取失败';
  }
}

watch(() => props.state, () => { void load(); }, { immediate: true });

function resultLabel(entry: SparHistoryEntryView): string {
  const fromAttacker = entry.result;
  if (entry.role === 'attacker') {
    return fromAttacker === 'win' ? '胜' : fromAttacker === 'lose' ? '负' : '平';
  }
  return fromAttacker === 'win' ? '负' : fromAttacker === 'lose' ? '胜' : '平';
}

function resultClass(entry: SparHistoryEntryView): string {
  const label = resultLabel(entry);
  if (label === '胜') return 'is-win';
  if (label === '负') return 'is-lose';
  return 'is-draw';
}

function opponentName(entry: SparHistoryEntryView): string {
  return entry.role === 'attacker' ? entry.defenderSectName : entry.attackerSectName;
}

function roleLabel(entry: SparHistoryEntryView): string {
  return entry.role === 'attacker' ? '挑战' : '应战';
}
</script>

<template>
  <section class="spar-history-panel" aria-labelledby="spar-history-title">
    <header class="section-heading panel-heading compact-heading">
      <div>
        <p class="eyebrow">演武录</p>
        <h2 id="spar-history-title">切磋记录</h2>
      </div>
      <span v-if="history" class="count-badge">{{ history.stats.total }} 场</span>
    </header>

    <div v-if="history && history.stats.total > 0" class="spar-stats">
      <span class="stat-item is-win">{{ history.stats.wins }} 胜</span>
      <span class="stat-item is-lose">{{ history.stats.losses }} 负</span>
      <span class="stat-item is-draw">{{ history.stats.draws }} 平</span>
    </div>

    <p v-if="loadError" class="explore-hint">{{ loadError }}</p>

    <ul v-if="history && history.entries.length > 0" class="spar-list">
      <li v-for="entry in history.entries" :key="entry.id" class="spar-card">
        <div class="spar-result-badge" :class="resultClass(entry)" aria-hidden="true">{{ resultLabel(entry) }}</div>
        <div class="spar-copy">
          <div>
            <strong>{{ roleLabel(entry) }} · {{ opponentName(entry) }}</strong>
            <span class="event-time">{{ formatTime(entry.createdAt) }}</span>
          </div>
          <small class="spar-detail">
            <span>我方战力 {{ entry.role === 'attacker' ? entry.attackerPower : entry.defenderPower }}</span>
            <span>对方战力 {{ entry.role === 'attacker' ? entry.defenderPower : entry.attackerPower }}</span>
            <span v-if="entry.reputationGained > 0" class="is-gain">声望 +{{ entry.reputationGained }}</span>
          </small>
        </div>
      </li>
    </ul>

    <div v-else-if="history && !loadError" class="empty-state compact-empty">
      <span aria-hidden="true">武</span>
      <strong>尚无切磋记录</strong>
      <p>在江湖榜中找到对手，一决高下。</p>
    </div>
  </section>
</template>

<style scoped>
.spar-stats {
  display: flex;
  gap: 1rem;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  background: var(--surface);
  margin-bottom: 1rem;
  font-weight: 600;
  font-size: 0.95rem;
}
.stat-item.is-win { color: var(--jade); }
.stat-item.is-lose { color: var(--red); }
.stat-item.is-draw { color: var(--muted); }

.spar-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.spar-card {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  padding: 0.75rem;
  border-radius: 8px;
  background: var(--surface);
}

.spar-result-badge {
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 0.8rem;
  color: var(--bg);
}
.spar-result-badge.is-win { background: var(--jade); }
.spar-result-badge.is-lose { background: var(--red); }
.spar-result-badge.is-draw { background: var(--muted); }

.spar-copy {
  flex: 1;
  min-width: 0;
}

.spar-copy > div {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.spar-detail {
  display: flex;
  gap: 0.75rem;
  color: var(--muted);
  margin-top: 0.25rem;
}
.spar-detail .is-gain { color: var(--jade); }
</style>
