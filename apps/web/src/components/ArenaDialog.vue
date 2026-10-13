<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

import type {
  ArenaDuelRoundView,
  ArenaDuelView,
  ArenaEntryView,
  ArenaIndividualMatchView,
  ArenaRankingView,
  ArenaView,
  SectStateView,
} from '../api/game';
import { fetchArena, setArenaLineup } from '../api/game';
import { selectionBlockReason } from '../utils/discipleFilter';
import DisciplePicker from './DisciplePicker.vue';

/**
 * 0053 宗门大比（docs/宗门大比开发计划.md 第 8 节）：斗法台（个人赛）/ 宗门战（团队赛）/ 榜单。
 *
 * 只在「打开时 / 呈报名册后」请求接口，不轮询；名册、赛程、战报、榜单全部由服务端算好，这里只排版与交互。
 * 倒计时在本地按拿到面板时的剩余时间往下走（每 30 秒刷新一次显示）。
 */
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
斗法台：各宗门报名的弟子两两对决（同宗门不互打），最多 10 回合；胜 3 分、平 1 分、负 0 分，同分看胜场与伤害。
宗门战：宗门两两车轮战，没有平局。赢方弟子带着剩余血量留场，输方换下一人；同样按胜负积分、同分看击杀数。
以弱克强：战力低的一方属性最多 +50%；宗门战另按宗门总战力补偿一次，两层取较大值。
灵力上限：宗门战总战力不能超过本纪上限（宗门 2 级及以上的宗门前 5 名弟子战力的平均值，每周一 0 点算定）。超了就自己调换弟子。
奖励：每天按名次发灵石、矿石、功勋与修为丹，归其宗门；周日的一纪之赏（天榜、宗榜前三）另有玄铁。`;

const showRules = ref(false);

const panel = ref<ArenaView | null>(null);
const loading = ref(false);
const submitting = ref(false);
const tab = ref<Tab>('individual');
const rankScope = ref<'daily' | 'season'>('daily');
/** 正在编辑的名册（null = 没在编辑）。 */
const editing = ref<Kind | null>(null);
const draft = ref<string[]>([]);
/** 团队赛展开的场次 / 单场展开的回合（按 key 记）。 */
const expandedTeams = ref<string[]>([]);
const expandedDuels = ref<string[]>([]);
/** 拿到面板的时刻与当前时刻：倒计时据此在本地推算，不重新请求。 */
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

/** 胜负场数：平局的 0.5 场照实显示。 */
function formatRecord(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatCountdown(ms: number): string {
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${String(hours)} 小时 ${String(minutes)} 分` : `${String(minutes)} 分钟`;
}

/** 血量百分比（0~100）：满血按剩余 / 满血换算。 */
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

/** 择优选人：能出战的弟子按战力取前 5（与服务端自动参赛同一口径；只是预填，可以再改）。 */
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

/* ---------- 斗法台赛程（按层排开） ---------- */

interface ArenaLayer {
  round: number;
  matches: ArenaIndividualMatchView[];
}

const individualLayers = computed<ArenaLayer[]>(() => {
  const layers = new Map<number, ArenaIndividualMatchView[]>();
  for (const match of panel.value?.individualMatches ?? []) {
    layers.set(match.round, [...(layers.get(match.round) ?? []), match]);
  }
  return [...layers.entries()].sort((a, b) => a[0] - b[0]).map(([round, matches]) => ({ round, matches }));
});

function sideState(match: ArenaIndividualMatchView, side: 'fighterA' | 'fighterB'): 'win' | 'lose' | 'draw' {
  if (match.winnerId === null) return 'draw';
  return match.winnerId === match[side].id ? 'win' : 'lose';
}

/* ---------- 宗门战（车轮战，点开看每一场） ---------- */

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

/** 一回合的战报：先手、每一击（追击 / 破绽一击）、回合后双方剩余血量。 */
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

      <!-- 名册编辑（只在 12 点前、未结算时可用） -->
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
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'individual'"
          :class="{ 'is-active': tab === 'individual' }"
          @click="tab = 'individual'"
        >
          斗法台
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'team'"
          :class="{ 'is-active': tab === 'team' }"
          @click="tab = 'team'"
        >
          宗门战
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'ranks'"
          :class="{ 'is-active': tab === 'ranks' }"
          @click="tab = 'ranks'"
        >
          榜单
        </button>
      </nav>

      <!-- 报名状态：全部宗门（已报名 / 自动参赛） -->
      <section v-if="tab !== 'ranks'" class="arena-entries" aria-label="报名状态">
        <p class="arena-section-title">
          报名状态 · {{ tab === 'individual' ? '斗法台' : '宗门战' }}
          <span v-if="tab === 'team' && activePowerCap !== null" class="arena-cap">上限 {{ formatNumber(activePowerCap) }}</span>
        </p>
        <ul v-if="activeEntries.length > 0" class="arena-entry-list">
          <li
            v-for="entry in activeEntries"
            :key="entry.sectId"
            class="arena-entry"
            :class="{ 'is-mine': entry.sectId === mySectId }"
          >
            <div class="arena-entry-head">
              <strong class="arena-entry-name">{{ entry.sectName }}</strong>
              <span class="arena-tag" :class="entry.auto ? 'is-auto' : 'is-set'">
                {{ entry.auto ? '自动参赛' : '已报名' }}
              </span>
              <span v-if="tab === 'team'" class="arena-entry-power">战力 {{ formatNumber(teamPowerOf(entry)) }}</span>
            </div>
            <p v-if="entry.auto" class="arena-entry-note">掌门未点将 · 择优出战</p>
            <p class="arena-entry-members">
              {{ entry.disciples.map((item) => `${item.name}（${item.realmName}）`).join('、') || '暂无可出战弟子' }}
            </p>
          </li>
        </ul>
        <p v-else class="arena-empty">
          {{ panel.settled ? '今日没有宗门参赛。' : '还没有宗门达到 2 级参赛。' }}
        </p>
      </section>

      <!-- 斗法台：按层排开的对阵 -->
      <section v-if="tab === 'individual'" class="arena-bracket" aria-label="斗法台赛程">
        <p v-if="panel.dateKey !== null" class="arena-day">{{ panel.dateKey }} 战报</p>
        <p v-if="individualLayers.length === 0" class="arena-empty">
          {{ panel.dateKey === null ? '还没有结算过大比，12 点后出战报。' : '这一天没有对阵。' }}
        </p>
        <div v-for="layer in individualLayers" :key="layer.round" class="arena-layer">
          <p class="arena-layer-title">第 {{ layer.round }} 层 <span>· {{ layer.matches.length }} 场</span></p>
          <div class="arena-layer-matches">
            <article v-for="match in layer.matches" :key="match.id" class="arena-match">
              <div class="arena-fighter" :class="`is-${sideState(match, 'fighterA')}`">
                <strong>{{ match.fighterA.name }}</strong>
                <small>{{ match.fighterA.sectName }} · 战力 {{ formatNumber(match.fighterA.power) }}</small>
                <span class="arena-hp" :title="`剩余 ${String(match.fighterA.hpPct)}%`">
                  <i :style="{ width: `${String(match.fighterA.hpPct)}%` }" />
                </span>
                <span class="arena-verdict">{{ sideState(match, 'fighterA') === 'win' ? '胜' : sideState(match, 'fighterA') === 'draw' ? '平' : '败' }}</span>
              </div>
              <div class="arena-vs" aria-hidden="true"><span>VS</span></div>
              <div class="arena-fighter is-right" :class="`is-${sideState(match, 'fighterB')}`">
                <strong>{{ match.fighterB.name }}</strong>
                <small>{{ match.fighterB.sectName }} · 战力 {{ formatNumber(match.fighterB.power) }}</small>
                <span class="arena-hp" :title="`剩余 ${String(match.fighterB.hpPct)}%`">
                  <i :style="{ width: `${String(match.fighterB.hpPct)}%` }" />
                </span>
                <span class="arena-verdict">{{ sideState(match, 'fighterB') === 'win' ? '胜' : sideState(match, 'fighterB') === 'draw' ? '平' : '败' }}</span>
              </div>
            </article>
          </div>
        </div>
      </section>

      <!-- 宗门战：每场宗门对决，点开看车轮战 -->
      <section v-if="tab === 'team'" class="arena-team" aria-label="宗门战赛程">
        <p v-if="panel.dateKey !== null" class="arena-day">{{ panel.dateKey }} 战报</p>
        <p v-if="panel.teamMatches.length === 0" class="arena-empty">
          {{ panel.dateKey === null ? '还没有结算过宗门战，12 点后出战报。' : '这一天没有宗门对决。' }}
        </p>
        <article
          v-for="match in panel.teamMatches"
          :key="match.id"
          class="arena-team-match"
          :class="{ 'is-open': expandedTeams.includes(match.id) }"
        >
          <button
            class="arena-team-head"
            type="button"
            :aria-expanded="expandedTeams.includes(match.id)"
            @click="toggleTeam(match.id)"
          >
            <span class="arena-team-side" :class="{ 'is-win': match.winnerSectId === match.sectA.id }">
              {{ match.sectA.name }}
            </span>
            <strong class="arena-score">{{ match.sectA.kills }} : {{ match.sectB.kills }}</strong>
            <span class="arena-team-side is-right" :class="{ 'is-win': match.winnerSectId === match.sectB.id }">
              {{ match.sectB.name }}
            </span>
            <span class="arena-expand">{{ expandedTeams.includes(match.id) ? '收起' : '展开' }}</span>
          </button>
          <ol v-if="expandedTeams.includes(match.id)" class="arena-duels">
            <li v-for="(duel, index) in match.duels" :key="index" class="arena-duel">
              <button
                class="arena-duel-head"
                type="button"
                :aria-expanded="expandedDuels.includes(duelKey(match.id, index))"
                @click="toggleDuel(match.id, index)"
              >
                <span :class="{ 'is-win': duel.winnerId === duel.fighterA.id }">
                  {{ duel.fighterA.name }} <small>{{ duel.fighterA.hpPct }}%</small>
                </span>
                <span class="arena-vs-mini">vs</span>
                <span :class="{ 'is-win': duel.winnerId === duel.fighterB.id }">
                  {{ duel.fighterB.name }} <small>{{ duel.fighterB.hpPct }}%</small>
                </span>
                <span class="arena-duel-winner">胜者 {{ duelWinnerName(duel) }}</span>
              </button>
              <ol v-if="expandedDuels.includes(duelKey(match.id, index))" class="arena-rounds">
                <li v-for="round in duel.rounds" :key="round.round">{{ roundText(round, duel) }}</li>
              </ol>
            </li>
          </ol>
        </article>
      </section>

      <!-- 榜单：日榜 / 赛季（天榜、宗榜） -->
      <section v-if="tab === 'ranks'" class="arena-ranks" aria-label="大比榜单">
        <div class="arena-rank-toggle" role="group" aria-label="榜单范围">
          <button type="button" :class="{ 'is-active': rankScope === 'daily' }" @click="rankScope = 'daily'">日榜</button>
          <button type="button" :class="{ 'is-active': rankScope === 'season' }" @click="rankScope = 'season'">
            赛季（本纪）
          </button>
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
                <span class="arena-rank-score">{{ row.points }} 分 · {{ formatRecord(row.wins) }} 胜 {{ formatRecord(row.losses) }} 负</span>
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
                <span class="arena-rank-score">{{ row.points }} 分 · {{ formatRecord(row.wins) }} 胜 {{ formatRecord(row.losses) }} 负</span>
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

.arena-head {
  display: grid;
  gap: 6px;
}

.arena-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.arena-title {
  margin: 0;
  font-size: 20px;
  letter-spacing: 0.08em;
}

.arena-season {
  color: var(--gold-bright);
  font-size: 13px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  padding: 2px 10px;
}

.arena-status {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.arena-status.is-open {
  color: var(--jade-bright);
}

.arena-rules-toggle {
  justify-self: start;
}

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

.arena-empty {
  margin: 0;
  color: var(--faint);
  font-size: 13px;
}

.arena-day {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}

.arena-section-title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 8px;
  color: var(--gold-bright);
  font-size: 14px;
  letter-spacing: 0.06em;
}

.arena-cap {
  color: var(--muted);
  font-size: 12px;
  letter-spacing: 0;
}

.arena-cap.is-over {
  color: var(--red-bright);
}

/* 我的名册 */
.arena-mine {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: rgba(16, 36, 31, 0.6);
}

.arena-mine-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.arena-mine-kind {
  min-width: 44px;
  color: var(--gold-bright);
  font-size: 13px;
}

.arena-mine-names {
  flex: 1 1 180px;
  min-width: 0;
  color: var(--ink-text);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.arena-mine-action {
  margin-left: auto;
}

.arena-tag {
  flex: none;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 12px;
  border: 1px solid var(--line-strong);
}

.arena-tag.is-set {
  color: var(--jade-bright);
  border-color: rgba(119, 184, 154, 0.5);
}

.arena-tag.is-auto {
  color: var(--gold-bright);
}

/* 名册编辑 */
.arena-editor {
  padding: 12px;
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  background: rgba(18, 39, 32, 0.8);
}

.arena-editor-hint {
  margin: 0 0 10px;
  color: var(--muted);
  font-size: 12px;
}

.arena-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}

.arena-primary {
  border: 1px solid var(--gold);
  border-radius: 999px;
  background: rgba(202, 169, 106, 0.16);
  color: var(--gold-bright);
  padding: 6px 16px;
  font: inherit;
  cursor: pointer;
}

.arena-primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* 页签 */
.arena-tabs {
  display: flex;
  gap: 6px;
  border-bottom: 1px solid var(--line);
}

.arena-tabs button,
.arena-rank-toggle button,
.arena-duel-head,
.arena-team-head {
  font: inherit;
}

.arena-tabs button {
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--muted);
  padding: 8px 12px;
  cursor: pointer;
}

.arena-tabs button.is-active {
  color: var(--gold-bright);
  border-bottom-color: var(--gold);
}

/* 报名状态 */
.arena-entry-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.arena-entry {
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: rgba(16, 36, 31, 0.55);
}

.arena-entry.is-mine {
  border-color: var(--line-strong);
}

.arena-entry-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.arena-entry-name {
  min-width: 0;
  overflow-wrap: anywhere;
}

.arena-entry-power {
  margin-left: auto;
  color: var(--muted);
  font-size: 12px;
}

.arena-entry-note {
  margin: 4px 0 0;
  color: var(--gold);
  font-size: 12px;
}

.arena-entry-members {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

/* 斗法台赛程：按层排开，每场两名弟子之间一条线 */
.arena-bracket,
.arena-team {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.arena-layer-title {
  margin: 0 0 6px;
  color: var(--gold-bright);
  font-size: 13px;
}

.arena-layer-title span {
  color: var(--faint);
  font-size: 12px;
}

.arena-layer-matches {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 8px;
}

.arena-match {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: stretch;
  gap: 0;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: rgba(16, 36, 31, 0.55);
  overflow: hidden;
}

.arena-fighter {
  display: grid;
  gap: 2px;
  min-width: 0;
  padding: 8px 10px;
  position: relative;
}

.arena-fighter.is-right {
  text-align: right;
}

.arena-fighter strong {
  overflow-wrap: anywhere;
  font-size: 13px;
}

.arena-fighter small {
  color: var(--muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.arena-fighter.is-win {
  background: rgba(202, 169, 106, 0.12);
}

.arena-fighter.is-lose {
  opacity: 0.6;
}

.arena-verdict {
  position: absolute;
  top: 6px;
  right: 8px;
  color: var(--faint);
  font-size: 11px;
}

.arena-fighter.is-right .arena-verdict {
  right: auto;
  left: 8px;
}

.arena-fighter.is-win .arena-verdict {
  color: var(--gold-bright);
}

.arena-hp {
  display: block;
  height: 4px;
  border-radius: 999px;
  background: rgba(192, 216, 199, 0.12);
  overflow: hidden;
}

.arena-hp i {
  display: block;
  height: 100%;
  background: var(--jade);
}

.arena-vs {
  position: relative;
  display: grid;
  place-items: center;
  width: 36px;
  color: var(--gold);
  font-size: 11px;
}

.arena-vs::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--line-strong);
}

.arena-vs span {
  position: relative;
  padding: 0 2px;
  background: rgba(16, 36, 31, 0.9);
}

/* 宗门战 */
.arena-team-match {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: rgba(16, 36, 31, 0.55);
  overflow: hidden;
}

.arena-team-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--ink-text);
  padding: 10px 12px;
  text-align: left;
  cursor: pointer;
}

.arena-team-side {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--muted);
}

.arena-team-side.is-right {
  text-align: right;
}

.arena-team-side.is-win {
  color: var(--gold-bright);
  font-weight: 600;
}

.arena-score {
  color: var(--gold-bright);
  font-size: 16px;
  letter-spacing: 0.06em;
}

.arena-expand {
  color: var(--faint);
  font-size: 12px;
}

.arena-duels {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0 10px 10px;
  list-style: none;
}

.arena-duel {
  border-top: 1px solid var(--line);
  padding-top: 6px;
}

.arena-duel-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--muted);
  padding: 4px 2px;
  text-align: left;
  font-size: 13px;
  cursor: pointer;
}

.arena-duel-head small {
  color: var(--faint);
  font-size: 11px;
}

.arena-duel-head .is-win {
  color: var(--gold-bright);
}

.arena-vs-mini {
  color: var(--faint);
  font-size: 11px;
}

.arena-duel-winner {
  color: var(--jade-bright);
  font-size: 12px;
  white-space: nowrap;
}

.arena-rounds {
  margin: 6px 0 0;
  padding: 0 0 0 14px;
  color: var(--muted);
  font-size: 12px;
  display: grid;
  gap: 4px;
}

/* 榜单 */
.arena-ranks {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.arena-rank-toggle {
  display: inline-flex;
  gap: 6px;
}

.arena-rank-toggle button {
  border: 1px solid var(--line);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  padding: 4px 12px;
  cursor: pointer;
}

.arena-rank-toggle button.is-active {
  color: var(--gold-bright);
  border-color: var(--gold);
}

.arena-rank-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
}

.arena-rank-list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.arena-rank {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 4px 8px;
  padding: 6px 8px;
  border-radius: 8px;
  font-size: 13px;
}

.arena-rank.is-mine {
  background: rgba(202, 169, 106, 0.1);
}

.arena-rank-no {
  color: var(--gold);
  text-align: center;
}

.arena-rank-name {
  min-width: 0;
  overflow-wrap: anywhere;
}

.arena-rank-sub {
  grid-column: 2;
  color: var(--faint);
  font-size: 11px;
}

.arena-rank-score {
  grid-column: 3;
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}

@media (max-width: 560px) {
  .arena-match {
    grid-template-columns: minmax(0, 1fr);
  }

  .arena-vs {
    width: 100%;
    height: 22px;
  }

  .arena-vs::before {
    top: 50%;
    left: 12px;
    right: 12px;
  }

  .arena-fighter.is-right {
    text-align: left;
  }

  .arena-fighter.is-right .arena-verdict {
    right: 8px;
    left: auto;
  }

  .arena-team-head,
  .arena-duel-head {
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  }

  .arena-expand,
  .arena-duel-winner {
    grid-column: 1 / -1;
  }
}
</style>
