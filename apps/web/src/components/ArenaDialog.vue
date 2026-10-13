<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

import type {
  ArenaDuelRoundView,
  ArenaDuelView,
  ArenaEntryView,
  ArenaIndividualMatchView,
  ArenaRankingView,
  ArenaTeamMatchView,
  ArenaView,
  SectStateView,
} from '../api/game';
import { fetchArena, setArenaLineup } from '../api/game';
import { selectionBlockReason } from '../utils/discipleFilter';
import DisciplePicker from './DisciplePicker.vue';

const props = defineProps<{
  state: SectStateView;
  busy?: boolean;
}>();

const emit = defineEmits<{
  notify: [tone: 'success' | 'warning', title: string, message: string];
}>();

type Tab = 'individual' | 'team' | 'ranks';
type Kind = 'individual' | 'team';
const KINDS: readonly Kind[] = ['individual', 'team'];

const RULES_TEXT = `宗门大比 · 玩法说明

报名：宗门 2 级解锁。每天 0:00~12:00 可呈报名册；12:00 结算，之后名册锁定到次日。没有呈报的宗门由掌门未点将，系统择优选人。
斗法台：瑞士轮配对，按积分相近原则两两对决（同宗门不互打），最多 10 回合；以弱胜强得 5 分、势均力敌得 3 分、以强胜弱得 1 分，平局 1 分、负 0 分，同分看胜场与伤害。
宗门战：瑞士轮车轮战，没有平局。赢方弟子带着剩余血量留场，输方换下一人；同样按胜负积分、同分看击杀数。
以弱克强：战力低的一方属性最多 +50%；宗门战另按宗门总战力补偿一次，两层取较大值。
灵力上限：宗门战总战力不能超过本纪上限（宗门 2 级及以上的宗门前 5 名弟子战力的平均值，每周一 0 点算定）。超了就自己调换弟子。
奖励：每天按名次发灵石、矿石、功勋与修为丹，归其宗门；周日的一纪之赏（天榜、宗榜前三）另有玄铁。`;

const showRules = ref(false);

const panel = ref<ArenaView | null>(null);
const loading = ref(false);
const submitting = ref(false);
const tab = ref<Tab>('individual');
const rankScope = ref<'daily' | 'season'>('daily');
const editing = ref<Kind | null>(null);
const draft = ref<string[]>([]);
/** 弹窗查看弟子详情的宗门 */
const popupEntry = ref<ArenaEntryView | null>(null);
/** 团队赛展开的场次 / 单场展开的回合 */
const expandedTeams = ref<string[]>([]);
const expandedDuels = ref<string[]>([]);
const loadedAt = ref(Date.now());
const clock = ref(Date.now());
let clockTimer: number | undefined;

async function refresh(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    applyPanel(await fetchArena());
  } catch (error) {
    emit('notify', 'warning', '宗门大比', error instanceof Error ? error.message : '面板加载失败');
  } finally {
    loading.value = false;
  }
}

function applyPanel(next: ArenaView): void {
  panel.value = next;
  loadedAt.value = Date.now();
  clock.value = loadedAt.value;
}

onMounted(() => {
  void refresh();
  clockTimer = window.setInterval(() => {
    clock.value = Date.now();
  }, 30_000);
});

onUnmounted(() => {
  if (clockTimer !== undefined) window.clearInterval(clockTimer);
});

/* ---------- 显示用的小工具 ---------- */

function formatNumber(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '0';
}

function formatRecord(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatCountdown(ms: number): string {
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${String(hours)} 小时 ${String(minutes)} 分` : `${String(minutes)} 分钟`;
}

function hpPercent(hp: number, max: number): number {
  return max > 0 ? Math.max(0, Math.round((hp / max) * 100)) : 0;
}

/* ---------- 状态与倒计时 ---------- */

const remainingMs = computed<number | null>(() => {
  const arena = panel.value;
  if (arena === null || arena.settleInMs === null) return null;
  return Math.max(0, arena.settleInMs - (clock.value - loadedAt.value));
});

const statusLine = computed(() => {
  const arena = panel.value;
  if (arena === null) return '';
  if (!arena.unlocked) return '宗门 2 级开放斗法台与宗门战。下面可以先看看各宗的名册与战报。';
  if (arena.canRegister) {
    const left = remainingMs.value;
    return `名册可改 · 12:00 结算${left === null ? '' : `，还剩 ${formatCountdown(left)}`}`;
  }
  if (arena.settled) return '今日已于 12:00 结算，战报与榜单见下方。';
  return '今日 12:00 已过，等待结算。';
});

/* ---------- 名册 ---------- */

const activeEntries = computed<ArenaEntryView[]>(() => {
  const arena = panel.value;
  if (arena === null) return [];
  if (tab.value === 'individual') return arena.allEntries.individual;
  if (tab.value === 'team') return arena.allEntries.team;
  return [];
});

const activePowerCap = computed<number | null>(() => panel.value?.teamPowerCap ?? null);

function teamPowerOf(entry: ArenaEntryView): number {
  return entry.disciples.reduce((sum, disciple) => sum + disciple.combatPower, 0);
}

function myEntry(kind: Kind): ArenaEntryView | null {
  return kind === 'individual' ? panel.value?.myIndividualEntry ?? null : panel.value?.myTeamEntry ?? null;
}

function powerOfIds(ids: readonly string[]): number {
  return ids.reduce((sum, id) => sum + (props.state.disciples.find((disciple) => disciple.id === id)?.combatPower ?? 0), 0);
}

const draftPower = computed(() => powerOfIds(draft.value));

const overCap = computed(
  () => editing.value === 'team' && activePowerCap.value !== null && draftPower.value > activePowerCap.value,
);

const canSubmit = computed(
  () =>
    editing.value !== null &&
    draft.value.length > 0 &&
    draft.value.length <= 5 &&
    !overCap.value &&
    !submitting.value &&
    props.busy !== true,
);

function startEditing(kind: Kind): void {
  editing.value = kind;
  draft.value = myEntry(kind)?.disciples.map((disciple) => disciple.id) ?? [];
}

function cancelEditing(): void {
  editing.value = null;
  draft.value = [];
}

function autoDraft(): void {
  const now = Date.now();
  draft.value = props.state.disciples
    .filter((disciple) => selectionBlockReason(disciple, now, { blockInjured: true, blockAway: true, blockSteward: true }) === null)
    .sort((a, b) => b.combatPower - a.combatPower)
    .slice(0, 5)
    .map((disciple) => disciple.id);
}

async function submitLineup(): Promise<void> {
  const kind = editing.value;
  if (kind === null || !canSubmit.value) return;
  submitting.value = true;
  try {
    applyPanel(await setArenaLineup(kind, draft.value));
    editing.value = null;
    draft.value = [];
    emit('notify', 'success', '宗门大比', kind === 'individual' ? '斗法台名册已呈报' : '宗门战名册已呈报');
  } catch (error) {
    emit('notify', 'warning', '宗门大比', error instanceof Error ? error.message : '呈报失败，请稍后再试');
  } finally {
    submitting.value = false;
  }
}

/* ---------- 赛程按轮分组 ---------- */

interface ArenaRound<T> {
  round: number;
  matches: T[];
}

const individualRounds = computed<ArenaRound<ArenaIndividualMatchView>[]>(() => {
  const rounds = new Map<number, ArenaIndividualMatchView[]>();
  for (const match of panel.value?.individualMatches ?? []) {
    rounds.set(match.round, [...(rounds.get(match.round) ?? []), match]);
  }
  return [...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([round, matches]) => ({ round, matches }));
});

const teamRounds = computed<ArenaRound<ArenaTeamMatchView>[]>(() => {
  const rounds = new Map<number, ArenaTeamMatchView[]>();
  for (const match of panel.value?.teamMatches ?? []) {
    rounds.set(match.round, [...(rounds.get(match.round) ?? []), match]);
  }
  return [...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([round, matches]) => ({ round, matches }));
});

function sideState(match: ArenaIndividualMatchView, side: 'fighterA' | 'fighterB'): 'win' | 'lose' | 'draw' {
  if (match.winnerId === null) return 'draw';
  return match.winnerId === match[side].id ? 'win' : 'lose';
}

function sideLabel(state: 'win' | 'lose' | 'draw'): string {
  return state === 'win' ? '胜' : state === 'draw' ? '平' : '败';
}

/* ---------- 宗门战 ---------- */

function toggleTeam(matchId: string): void {
  expandedTeams.value = expandedTeams.value.includes(matchId)
    ? expandedTeams.value.filter((id) => id !== matchId)
    : [...expandedTeams.value, matchId];
}

function duelKey(matchId: string, index: number): string {
  return `${matchId}#${String(index)}`;
}

function toggleDuel(matchId: string, index: number): void {
  const key = duelKey(matchId, index);
  expandedDuels.value = expandedDuels.value.includes(key)
    ? expandedDuels.value.filter((item) => item !== key)
    : [...expandedDuels.value, key];
}

function duelWinnerName(duel: ArenaDuelView): string {
  if (duel.winnerId === null) return '平';
  return duel.winnerId === duel.fighterA.id ? duel.fighterA.name : duel.fighterB.name;
}

function roundText(round: ArenaDuelRoundView, duel: ArenaDuelView): string {
  const first = round.firstId === duel.fighterA.id ? duel.fighterA.name : duel.fighterB.name;
  const hits = round.hits
    .map((hit) => `${hit.name}${hit.extra ? '（身法追击）' : ''} ${formatNumber(hit.damage)}${hit.crit ? '（破绽一击）' : ''}`)
    .join('、');
  const left = `${String(hpPercent(round.fighterAHp, duel.fighterAMaxHp))}% / ${String(hpPercent(round.fighterBHp, duel.fighterBMaxHp))}%`;
  return `第 ${String(round.round)} 招 · ${first}先手 · ${hits} · 剩余 ${left}`;
}

/* ---------- 榜单 ---------- */

const rankings = computed<{ individual: ArenaRankingView[]; team: ArenaRankingView[] }>(() => {
  const arena = panel.value;
  if (arena === null) return { individual: [], team: [] };
  if (rankScope.value === 'daily') {
    return { individual: arena.dailyIndividualRanking, team: arena.dailyTeamRanking };
  }
  return { individual: arena.seasonIndividualRanking, team: arena.seasonTeamRanking };
});

const mySectId = computed(() => props.state.sect.id);
</script>

<template>
  <section class="arena" aria-labelledby="arena-title">
    <header class="arena-head">
      <div class="arena-title-row">
        <h2 id="arena-title" class="arena-title">宗门大比</h2>
        <span v-if="panel" class="arena-season" title="一纪 = 一周，周日 12:00 收官">
          本纪 {{ panel.seasonId }}
        </span>
      </div>
      <p v-if="panel" class="arena-status" :class="{ 'is-open': panel.canRegister }">{{ statusLine }}</p>
      <p v-else class="arena-empty">{{ loading ? '大比加载中…' : '面板加载失败，请稍后再试。' }}</p>
      <button class="quiet-button arena-rules-toggle" type="button" :aria-expanded="showRules" @click="showRules = !showRules">
        {{ showRules ? '收起玩法说明' : '玩法说明' }}
      </button>
      <p v-if="showRules" class="arena-rules">{{ RULES_TEXT }}</p>
    </header>

    <template v-if="panel">
      <!-- 我的名册 -->
      <section class="arena-mine" aria-label="我的名册">
        <div v-for="kind in KINDS" :key="kind" class="arena-mine-row">
          <span class="arena-mine-kind">{{ kind === 'individual' ? '斗法台' : '宗门战' }}</span>
          <template v-if="myEntry(kind)">
            <span class="arena-tag" :class="myEntry(kind)?.auto ? 'is-auto' : 'is-set'">
              {{ myEntry(kind)?.auto ? '自动参赛' : '已报名' }}
            </span>
            <span class="arena-mine-names">
              {{ myEntry(kind)?.disciples.map((item) => item.name).join('、') || '暂无可出战弟子' }}
            </span>
          </template>
          <span v-else class="arena-mine-names">{{ panel.unlocked ? '暂无可出战弟子' : '宗门 2 级解锁' }}</span>
          <button
            v-if="panel.unlocked && panel.canRegister && editing === null"
            class="quiet-button arena-mine-action"
            type="button"
            :disabled="busy === true"
            @click="startEditing(kind)"
          >
            {{ myEntry(kind)?.auto ? '呈报名册' : '修改名册' }}
          </button>
        </div>
      </section>

      <!-- 名册编辑 -->
      <section v-if="editing !== null" class="arena-editor" aria-label="呈报名册">
        <p class="arena-section-title">
          呈报{{ editing === 'individual' ? '斗法台' : '宗门战' }}名册
          <span v-if="editing === 'team'" class="arena-cap" :class="{ 'is-over': overCap }">
            已选战力 {{ formatNumber(draftPower) }} / 上限 {{ formatNumber(activePowerCap ?? 0) }}
          </span>
        </p>
        <p class="arena-editor-hint">
          {{ editing === 'individual' ? '最多 5 人，同宗门不互打，按战力与属性两两对决。' : '按出战顺序依次上场，输了换下一人，赢的人带着剩余血量留场。' }}
          超出上限时请调换弟子。
        </p>
        <DisciplePicker
          v-model:selected="draft"
          :disciples="state.disciples"
          :min="1"
          :max="5"
          :busy="submitting || busy === true"
          sort="power"
          :show-order="editing === 'team'"
          :title="editing === 'individual' ? '选择斗法台弟子（最多 5 人）' : '选择宗门战弟子（最多 5 人，按顺序出战）'"
        >
          <template #actions>
            <button class="quiet-button" type="button" :disabled="submitting || busy === true" @click="autoDraft">
              择优选人
            </button>
          </template>
        </DisciplePicker>
        <div class="arena-editor-actions">
          <button class="quiet-button" type="button" :disabled="submitting" @click="cancelEditing">取消</button>
          <button class="arena-primary" type="button" :disabled="!canSubmit" @click="submitLineup">
            {{ submitting ? '呈报中…' : `呈报（${String(draft.length)} 人）` }}
          </button>
        </div>
      </section>

      <!-- 页签 -->
      <nav class="arena-tabs" role="tablist" aria-label="宗门大比">
        <button type="button" role="tab" :aria-selected="tab === 'individual'" :class="{ 'is-active': tab === 'individual' }" @click="tab = 'individual'">斗法台</button>
        <button type="button" role="tab" :aria-selected="tab === 'team'" :class="{ 'is-active': tab === 'team' }" @click="tab = 'team'">宗门战</button>
        <button type="button" role="tab" :aria-selected="tab === 'ranks'" :class="{ 'is-active': tab === 'ranks' }" @click="tab = 'ranks'">榜单</button>
      </nav>

      <!-- 报名状态：紧凑标签，点击弹窗看弟子 -->
      <section v-if="tab !== 'ranks'" class="arena-entries" aria-label="报名状态">
        <p class="arena-section-title">
          报名状态 · {{ tab === 'individual' ? '斗法台' : '宗门战' }}
          <span v-if="tab === 'team' && activePowerCap !== null" class="arena-cap">上限 {{ formatNumber(activePowerCap) }}</span>
        </p>
        <div v-if="activeEntries.length > 0" class="arena-entry-chips">
          <button
            v-for="entry in activeEntries"
            :key="entry.sectId"
            class="arena-chip"
            :class="{ 'is-mine': entry.sectId === mySectId }"
            type="button"
            @click="popupEntry = entry"
          >
            <strong>{{ entry.sectName }}</strong>
            <small>{{ formatNumber(teamPowerOf(entry)) }}</small>
          </button>
        </div>
        <p v-else class="arena-empty">
          {{ panel.settled ? '今日没有宗门参赛。' : '还没有宗门达到 2 级参赛。' }}
        </p>
      </section>

      <!-- 弟子详情弹窗 -->
      <Teleport to="body">
        <div v-if="popupEntry" class="arena-popup-mask" @click.self="popupEntry = null">
          <div class="arena-popup">
            <div class="arena-popup-head">
              <strong>{{ popupEntry.sectName }}</strong>
              <span class="arena-tag" :class="popupEntry.auto ? 'is-auto' : 'is-set'">
                {{ popupEntry.auto ? '自动参赛' : '已报名' }}
              </span>
              <span class="arena-popup-power">总战力 {{ formatNumber(teamPowerOf(popupEntry)) }}</span>
              <button class="arena-popup-close" type="button" @click="popupEntry = null">&#10005;</button>
            </div>
            <p v-if="popupEntry.auto" class="arena-popup-note">掌门未点将 · 择优出战</p>
            <ul class="arena-popup-list">
              <li v-for="disciple in popupEntry.disciples" :key="disciple.id">
                <span>{{ disciple.name }}</span>
                <small>{{ disciple.realmName }}</small>
                <span class="arena-popup-dp">{{ formatNumber(disciple.combatPower) }}</span>
              </li>
            </ul>
          </div>
        </div>
      </Teleport>

      <!-- 斗法台：紧凑单行，按轮分段 -->
      <section v-if="tab === 'individual'" class="arena-matches" aria-label="斗法台赛程">
        <p v-if="panel.dateKey !== null" class="arena-day">{{ panel.dateKey }} 战报</p>
        <p v-if="individualRounds.length === 0" class="arena-empty">
          {{ panel.dateKey === null ? '还没有结算过大比，12 点后出战报。' : '这一天没有对阵。' }}
        </p>
        <div v-for="rd in individualRounds" :key="rd.round" class="arena-round-group">
          <p class="arena-round-hd">第 {{ rd.round }} 轮 <small>{{ rd.matches.length }} 场</small></p>
          <div class="arena-ind-list">
            <div v-for="match in rd.matches" :key="match.id" class="arena-ind-row">
              <span class="arena-ind-v" :class="`is-${sideState(match, 'fighterA')}`">{{ sideLabel(sideState(match, 'fighterA')) }}</span>
              <span class="arena-ind-name" :class="{ 'is-win': sideState(match, 'fighterA') === 'win' }">{{ match.fighterA.name }}</span>
              <small class="arena-ind-sect">{{ match.fighterA.sectName }}</small>
              <span class="arena-ind-vs">vs</span>
              <span class="arena-ind-name" :class="{ 'is-win': sideState(match, 'fighterB') === 'win' }">{{ match.fighterB.name }}</span>
              <small class="arena-ind-sect">{{ match.fighterB.sectName }}</small>
              <span class="arena-ind-v" :class="`is-${sideState(match, 'fighterB')}`">{{ sideLabel(sideState(match, 'fighterB')) }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- 宗门战：紧凑单行，按轮分段，点击展开车轮战 -->
      <section v-if="tab === 'team'" class="arena-matches" aria-label="宗门战赛程">
        <p v-if="panel.dateKey !== null" class="arena-day">{{ panel.dateKey }} 战报</p>
        <p v-if="teamRounds.length === 0" class="arena-empty">
          {{ panel.dateKey === null ? '还没有结算过宗门战，12 点后出战报。' : '这一天没有宗门对决。' }}
        </p>
        <div v-for="rd in teamRounds" :key="rd.round" class="arena-round-group">
          <p class="arena-round-hd">第 {{ rd.round }} 轮 <small>{{ rd.matches.length }} 场</small></p>
          <div class="arena-team-list">
            <div v-for="match in rd.matches" :key="match.id" class="arena-team-item" :class="{ 'is-open': expandedTeams.includes(match.id) }">
              <button class="arena-team-row" type="button" @click="toggleTeam(match.id)">
                <span class="arena-team-side" :class="{ 'is-win': match.winnerSectId === match.sectA.id }">{{ match.sectA.name }}</span>
                <strong class="arena-team-score">{{ match.sectA.kills }}:{{ match.sectB.kills }}</strong>
                <span class="arena-team-side is-right" :class="{ 'is-win': match.winnerSectId === match.sectB.id }">{{ match.sectB.name }}</span>
                <span class="arena-team-arrow">{{ expandedTeams.includes(match.id) ? '▾' : '▸' }}</span>
              </button>
              <ol v-if="expandedTeams.includes(match.id)" class="arena-duels">
                <li v-for="(duel, index) in match.duels" :key="index" class="arena-duel">
                  <button class="arena-duel-head" type="button" @click="toggleDuel(match.id, index)">
                    <span :class="{ 'is-win': duel.winnerId === duel.fighterA.id }">{{ duel.fighterA.name }}</span>
                    <span class="arena-duel-vs">vs</span>
                    <span :class="{ 'is-win': duel.winnerId === duel.fighterB.id }">{{ duel.fighterB.name }}</span>
                    <span class="arena-duel-res">{{ duelWinnerName(duel) }}胜</span>
                  </button>
                  <ol v-if="expandedDuels.includes(duelKey(match.id, index))" class="arena-rounds">
                    <li v-for="round in duel.rounds" :key="round.round">{{ roundText(round, duel) }}</li>
                  </ol>
                </li>
              </ol>
            </div>
          </div>
        </div>
      </section>

      <!-- 榜单 -->
      <section v-if="tab === 'ranks'" class="arena-ranks" aria-label="大比榜单">
        <div class="arena-rank-toggle" role="group" aria-label="榜单范围">
          <button type="button" :class="{ 'is-active': rankScope === 'daily' }" @click="rankScope = 'daily'">日榜</button>
          <button type="button" :class="{ 'is-active': rankScope === 'season' }" @click="rankScope = 'season'">赛季（本纪）</button>
        </div>
        <p v-if="rankScope === 'daily' && panel.dateKey !== null" class="arena-day">{{ panel.dateKey }}</p>
        <div class="arena-rank-grid">
          <div>
            <p class="arena-section-title">{{ rankScope === 'daily' ? '斗法台日榜' : '天榜（个人）' }}</p>
            <ol v-if="rankings.individual.length > 0" class="arena-rank-list">
              <li v-for="row in rankings.individual" :key="row.id" class="arena-rank" :class="{ 'is-mine': row.sectName === state.sect.name }">
                <span class="arena-rank-no">{{ row.rank }}</span>
                <strong class="arena-rank-name">{{ row.name }}</strong>
                <small class="arena-rank-sub">{{ row.sectName }}</small>
                <span class="arena-rank-score">{{ row.points }}分 {{ formatRecord(row.wins) }}胜{{ formatRecord(row.losses) }}负</span>
              </li>
            </ol>
            <p v-else class="arena-empty">暂无记录。</p>
          </div>
          <div>
            <p class="arena-section-title">{{ rankScope === 'daily' ? '宗门战日榜' : '宗榜（宗门）' }}</p>
            <ol v-if="rankings.team.length > 0" class="arena-rank-list">
              <li v-for="row in rankings.team" :key="row.id" class="arena-rank" :class="{ 'is-mine': row.id === state.sect.id }">
                <span class="arena-rank-no">{{ row.rank }}</span>
                <strong class="arena-rank-name">{{ row.name }}</strong>
                <span class="arena-rank-score">{{ row.points }}分 {{ formatRecord(row.wins) }}胜{{ formatRecord(row.losses) }}负</span>
              </li>
            </ol>
            <p v-else class="arena-empty">暂无记录。</p>
          </div>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.arena {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  color: var(--ink-text);
}

.arena-head { display: grid; gap: 6px; }

.arena-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.arena-title { margin: 0; font-size: 20px; letter-spacing: 0.08em; }

.arena-season {
  color: var(--gold-bright);
  font-size: 13px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  padding: 2px 10px;
}

.arena-status { margin: 0; color: var(--muted); font-size: 13px; }
.arena-status.is-open { color: var(--jade-bright); }
.arena-rules-toggle { justify-self: start; }

.arena-rules {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: rgba(16, 36, 31, 0.6);
  color: var(--muted);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-line;
}

.arena-empty { margin: 0; color: var(--faint); font-size: 13px; }
.arena-day { margin: 0; color: var(--muted); font-size: 12px; }

.arena-section-title {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px;
  margin: 0 0 8px; color: var(--gold-bright); font-size: 14px; letter-spacing: 0.06em;
}

.arena-cap { color: var(--muted); font-size: 12px; letter-spacing: 0; }
.arena-cap.is-over { color: var(--red-bright); }

/* 我的名册 */
.arena-mine {
  display: grid; gap: 8px; padding: 12px;
  border: 1px solid var(--line); border-radius: 14px; background: rgba(16, 36, 31, 0.6);
}

.arena-mine-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.arena-mine-kind { min-width: 44px; color: var(--gold-bright); font-size: 13px; }
.arena-mine-names { flex: 1 1 180px; min-width: 0; color: var(--ink-text); font-size: 13px; overflow-wrap: anywhere; }
.arena-mine-action { margin-left: auto; }

.arena-tag {
  flex: none; border-radius: 999px; padding: 1px 8px;
  font-size: 12px; border: 1px solid var(--line-strong);
}
.arena-tag.is-set { color: var(--jade-bright); border-color: rgba(119, 184, 154, 0.5); }
.arena-tag.is-auto { color: var(--gold-bright); }

/* 名册编辑 */
.arena-editor { padding: 12px; border: 1px solid var(--line-strong); border-radius: 14px; background: rgba(18, 39, 32, 0.8); }
.arena-editor-hint { margin: 0 0 10px; color: var(--muted); font-size: 12px; }
.arena-editor-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }

.arena-primary {
  border: 1px solid var(--gold); border-radius: 999px;
  background: rgba(202, 169, 106, 0.16); color: var(--gold-bright);
  padding: 6px 16px; font: inherit; cursor: pointer;
}
.arena-primary:disabled { opacity: 0.45; cursor: not-allowed; }

/* 页签 */
.arena-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--line); }
.arena-tabs button, .arena-rank-toggle button, .arena-duel-head, .arena-team-row { font: inherit; }
.arena-tabs button {
  border: 0; border-bottom: 2px solid transparent; background: transparent;
  color: var(--muted); padding: 8px 12px; cursor: pointer;
}
.arena-tabs button.is-active { color: var(--gold-bright); border-bottom-color: var(--gold); }

/* 报名状态：紧凑标签 */
.arena-entry-chips {
  display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0;
}

.arena-chip {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--line); border-radius: 8px;
  background: rgba(16, 36, 31, 0.55); color: var(--ink-text);
  padding: 4px 10px; font: inherit; cursor: pointer;
}
.arena-chip:hover { border-color: var(--line-strong); }
.arena-chip.is-mine { border-color: var(--gold); }
.arena-chip strong { font-size: 13px; }
.arena-chip small { color: var(--muted); font-size: 11px; }

/* 弟子详情弹窗 */
.arena-popup-mask {
  position: fixed; inset: 0; z-index: 9999;
  display: grid; place-items: center;
  background: rgba(0, 0, 0, 0.5);
}

.arena-popup {
  width: 280px; max-height: 80vh; overflow-y: auto;
  border: 1px solid var(--line-strong); border-radius: 14px;
  background: var(--bg-card, rgba(16, 36, 31, 0.95));
  padding: 14px; color: var(--ink-text);
}

.arena-popup-head {
  display: flex; align-items: center; gap: 6px; margin-bottom: 8px;
}
.arena-popup-head strong { font-size: 14px; }
.arena-popup-power { margin-left: auto; color: var(--muted); font-size: 12px; }
.arena-popup-close {
  flex: none; border: 0; background: transparent; color: var(--faint);
  font-size: 16px; cursor: pointer; padding: 0 0 0 6px; line-height: 1;
}
.arena-popup-note { margin: 0 0 6px; color: var(--gold); font-size: 12px; }

.arena-popup-list {
  margin: 0; padding: 0; list-style: none; display: grid; gap: 4px;
}
.arena-popup-list li {
  display: flex; align-items: baseline; gap: 6px;
  padding: 4px 0; border-top: 1px solid var(--line); font-size: 13px;
}
.arena-popup-list li:first-child { border-top: 0; }
.arena-popup-list small { color: var(--faint); font-size: 11px; }
.arena-popup-dp { margin-left: auto; color: var(--muted); font-size: 12px; }

/* 赛程：按轮分段，紧凑行 */
.arena-matches { display: flex; flex-direction: column; gap: 10px; }

.arena-round-group { display: flex; flex-direction: column; gap: 4px; }

.arena-round-hd {
  margin: 0; color: var(--gold-bright); font-size: 13px; padding: 2px 0;
  border-bottom: 1px solid var(--line);
}
.arena-round-hd small { color: var(--faint); font-size: 11px; margin-left: 6px; }

/* 个人赛：单行对阵 */
.arena-ind-list { display: flex; flex-direction: column; gap: 2px; }

.arena-ind-row {
  display: flex; align-items: center; gap: 4px;
  padding: 3px 6px; border-radius: 6px; font-size: 12px;
}
.arena-ind-row:hover { background: rgba(202, 169, 106, 0.06); }

.arena-ind-v {
  flex: none; width: 18px; text-align: center; font-size: 11px;
  border-radius: 3px; padding: 0 2px;
}
.arena-ind-v.is-win { color: var(--gold-bright); }
.arena-ind-v.is-lose { color: var(--faint); }
.arena-ind-v.is-draw { color: var(--muted); }

.arena-ind-name { font-weight: 500; white-space: nowrap; }
.arena-ind-name.is-win { color: var(--gold-bright); }

.arena-ind-sect { color: var(--faint); font-size: 11px; white-space: nowrap; }

.arena-ind-vs { color: var(--faint); font-size: 10px; flex: none; padding: 0 2px; }

/* 宗门战：单行对阵 */
.arena-team-list { display: flex; flex-direction: column; gap: 2px; }

.arena-team-item {
  border: 1px solid var(--line); border-radius: 8px;
  background: rgba(16, 36, 31, 0.4); overflow: hidden;
}

.arena-team-row {
  display: flex; align-items: center; gap: 6px;
  width: 100%; border: 0; background: transparent;
  color: var(--ink-text); padding: 5px 8px; text-align: left; cursor: pointer;
  font-size: 13px;
}

.arena-team-side { min-width: 0; overflow-wrap: anywhere; color: var(--muted); }
.arena-team-side.is-right { text-align: right; margin-left: auto; }
.arena-team-side.is-win { color: var(--gold-bright); font-weight: 600; }

.arena-team-score { flex: none; color: var(--gold-bright); font-size: 13px; letter-spacing: 0.04em; }
.arena-team-arrow { flex: none; color: var(--faint); font-size: 10px; }

.arena-duels {
  display: grid; gap: 2px; margin: 0; padding: 2px 8px 6px; list-style: none;
}

.arena-duel { border-top: 1px solid var(--line); padding-top: 3px; }

.arena-duel-head {
  display: flex; align-items: center; gap: 4px;
  width: 100%; border: 0; background: transparent;
  color: var(--muted); padding: 2px 0; text-align: left; font-size: 12px; cursor: pointer;
}
.arena-duel-head .is-win { color: var(--gold-bright); }
.arena-duel-vs { color: var(--faint); font-size: 10px; }
.arena-duel-res { margin-left: auto; color: var(--jade-bright); font-size: 11px; white-space: nowrap; }

.arena-rounds {
  margin: 3px 0 0; padding: 0 0 0 12px;
  color: var(--muted); font-size: 11px; display: grid; gap: 2px;
}

/* 榜单 */
.arena-ranks { display: flex; flex-direction: column; gap: 10px; }

.arena-rank-toggle { display: inline-flex; gap: 6px; }
.arena-rank-toggle button {
  border: 1px solid var(--line); border-radius: 999px;
  background: transparent; color: var(--muted); padding: 4px 12px; cursor: pointer;
}
.arena-rank-toggle button.is-active { color: var(--gold-bright); border-color: var(--gold); }

.arena-rank-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px;
}

.arena-rank-list { display: grid; gap: 3px; margin: 0; padding: 0; list-style: none; }

.arena-rank {
  display: grid; grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: baseline; gap: 2px 6px;
  padding: 4px 6px; border-radius: 6px; font-size: 13px;
}
.arena-rank.is-mine { background: rgba(202, 169, 106, 0.1); }
.arena-rank-no { color: var(--gold); text-align: center; font-size: 12px; }
.arena-rank-name { min-width: 0; overflow-wrap: anywhere; }
.arena-rank-sub { grid-column: 2; color: var(--faint); font-size: 11px; }
.arena-rank-score { grid-column: 3; color: var(--muted); font-size: 11px; white-space: nowrap; }
</style>
