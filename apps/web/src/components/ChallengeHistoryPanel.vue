<script setup lang="ts">
import { ref, watch } from 'vue';

import type { ChallengeHistoryEntryView, ChallengeHistoryView, ChallengeRoundView, SectStateView } from '../api/game';
import { fetchChallengeHistory } from '../api/game';
import { formatAmount, formatTime } from '../utils/format';

/**
 * 演武录：挑战记录（攻守双方视角都在这里，胜负按自己视角翻转）。
 * 点一条记录展开逐轮战报。
 */
const props = defineProps<{
  state: SectStateView;
}>();

const history = ref<ChallengeHistoryView | null>(null);
const loadError = ref<string | null>(null);
const expandedId = ref<string | null>(null);

let loadSeq = 0;

async function load(): Promise<void> {
  const seq = (loadSeq += 1);
  try {
    const data = await fetchChallengeHistory();
    if (seq !== loadSeq) return; // 已有更新的请求在途，丢弃这次过期响应
    history.value = data;
    loadError.value = null;
  } catch (caught) {
    if (seq !== loadSeq) return;
    loadError.value = caught instanceof Error ? caught.message : '读取失败';
  }
}

watch(() => props.state, () => { void load(); }, { immediate: true });

function toggleExpand(entryId: string): void {
  expandedId.value = expandedId.value === entryId ? null : entryId;
}

/** 从自己视角看这场是胜是负。 */
function isMyWin(entry: ChallengeHistoryEntryView): boolean {
  const attackerWon = entry.result === 'win';
  return entry.role === 'attacker' ? attackerWon : !attackerWon;
}

function resultLabel(entry: ChallengeHistoryEntryView): string {
  return isMyWin(entry) ? '胜' : '负';
}

function opponentName(entry: ChallengeHistoryEntryView): string {
  return entry.role === 'attacker' ? entry.defenderSectName : entry.attackerSectName;
}

function roleLabel(entry: ChallengeHistoryEntryView): string {
  return entry.role === 'attacker' ? '登门挑战' : '守擂应战';
}

/** 该轮是不是我方赢的。 */
function isMyRoundWin(entry: ChallengeHistoryEntryView, round: ChallengeRoundView): boolean {
  return (entry.role === 'attacker') === (round.winner === 'attacker');
}

function myName(entry: ChallengeHistoryEntryView, round: ChallengeRoundView): string {
  return entry.role === 'attacker' ? round.attackerName : round.defenderName;
}

function foeName(entry: ChallengeHistoryEntryView, round: ChallengeRoundView): string {
  return entry.role === 'attacker' ? round.defenderName : round.attackerName;
}

function myPower(entry: ChallengeHistoryEntryView, round: ChallengeRoundView): number {
  return entry.role === 'attacker' ? round.attackerPower : round.defenderPower;
}

function foePower(entry: ChallengeHistoryEntryView, round: ChallengeRoundView): number {
  return entry.role === 'attacker' ? round.defenderPower : round.attackerPower;
}

/** 自己视角的比分，例如 2:1。 */
function score(entry: ChallengeHistoryEntryView): string {
  const won = entry.rounds.filter((round) => isMyRoundWin(entry, round)).length;
  return `${won}:${entry.rounds.length - won}`;
}
</script>

<template>
  <section class="challenge-history" aria-labelledby="challenge-history-title">
    <header class="section-heading panel-heading compact-heading">
      <div>
        <p class="eyebrow">演武录</p>
        <h2 id="challenge-history-title">挑战记录</h2>
      </div>
      <span v-if="history" class="count-badge">{{ history.stats.total }} 场</span>
    </header>

    <div v-if="history && history.stats.total > 0" class="challenge-stats">
      <span class="stat-item is-win">{{ history.stats.wins }} 胜</span>
      <span class="stat-item is-lose">{{ history.stats.losses }} 负</span>
    </div>

    <p v-if="loadError" class="explore-hint">{{ loadError }}</p>

    <ul v-if="history && history.entries.length > 0" class="challenge-list">
      <li v-for="entry in history.entries" :key="entry.id" class="challenge-card">
        <button
          class="challenge-summary"
          type="button"
          :aria-expanded="expandedId === entry.id"
          @click="toggleExpand(entry.id)"
        >
          <span class="result-badge" :class="isMyWin(entry) ? 'is-win' : 'is-lose'" aria-hidden="true">
            {{ resultLabel(entry) }}
          </span>
          <span class="challenge-copy">
            <span class="challenge-title">
              <strong>{{ roleLabel(entry) }} · {{ opponentName(entry) }}</strong>
              <span class="event-time">{{ formatTime(entry.createdAt) }}</span>
            </span>
            <span class="challenge-meta">
              <span>比分 {{ score(entry) }}</span>
              <span v-if="entry.role === 'attacker' && entry.reputationGained > 0" class="is-gain">
                声望 +{{ entry.reputationGained }}
              </span>
              <span v-if="entry.role === 'attacker' && entry.spiritStoneGained > 0" class="is-gain">
                灵石 +{{ formatAmount(entry.spiritStoneGained) }}
              </span>
            </span>
          </span>
          <span class="challenge-chevron" aria-hidden="true">{{ expandedId === entry.id ? '▴' : '▾' }}</span>
        </button>

        <ol v-if="expandedId === entry.id" class="round-list">
          <li v-for="round in entry.rounds" :key="round.round" class="round-row">
            <span class="round-no">第 {{ round.round }} 轮</span>
            <span class="round-side" :class="isMyRoundWin(entry, round) ? 'is-win' : 'is-lose'">
              {{ myName(entry, round) }} {{ myPower(entry, round) }}
            </span>
            <span class="round-vs">对</span>
            <span class="round-side" :class="isMyRoundWin(entry, round) ? 'is-lose' : 'is-win'">
              {{ foeName(entry, round) }} {{ foePower(entry, round) }}
            </span>
          </li>
        </ol>
      </li>
    </ul>

    <div v-else-if="history && !loadError" class="empty-state compact-empty">
      <span aria-hidden="true">武</span>
      <strong>尚无挑战记录</strong>
      <p>在江湖榜中找对手，登门一战。</p>
    </div>
  </section>
</template>
