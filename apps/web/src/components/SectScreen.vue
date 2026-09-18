<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';

import type {
  BuildingView,
  DiscipleView,
  PublicSectView,
  RecruitPreview,
  SecretRealmView,
  SectStateView,
} from '../api/game';
import type { ToastTone } from '../types/ui';
import { formatAmount, formatBp, formatRate, formatTime } from '../utils/format';
import { fetchRecruitPreview } from '../api/game';
import { resourceGlyph } from '../utils/glyph';
import AssignmentSelect from './AssignmentSelect.vue';
import EventLogPanel from './EventLogPanel.vue';
import ExplorePanel from './ExplorePanel.vue';
import ExplorePartyDialog from './ExplorePartyDialog.vue';
import LeaderboardPanel from './LeaderboardPanel.vue';
import RecruitDialog from './RecruitDialog.vue';
import ModalShell from './ModalShell.vue';
import SparDialog from './SparDialog.vue';
import SparHistoryPanel from './SparHistoryPanel.vue';

/**
 * 游戏主界面：服务端负责结算和规则，本组件只展示、本地平滑数值并派发操作。
 */
const props = defineProps<{
  state: SectStateView;
  busy: boolean;
}>();

const emit = defineEmits<{
  refresh: [];
  logout: [];
  recruit: [choice: number];
  assign: [discipleId: string, assignment: string];
  upgrade: [defId: string];
  'upgrade-sect': [];
  explore: [realmId: string, discipleIds: string[]];
  spar: [targetSectId: string, myDiscipleId: string, targetDiscipleId: string];
  breakthrough: [discipleId: string];
  notify: [tone: ToastTone, title: string, message: string];
}>();

/** 操作条里的弹窗开关：天机录 / 历练探索（宗门晋升与建筑仍在右栏常驻）。 */
const openPanel = ref<'events' | 'explore' | 'leaderboard' | 'spar-history' | null>(null);

/** 操作条角标：最近事件条数。 */
const recentEventCount = computed(() => props.state.recentEvents?.length ?? 0);

/** 招贤弹窗：候选人 + 开关（点「张榜招贤」时才拉预览）。 */
const recruitPreview = ref<RecruitPreview | null>(null);
const showRecruitDialog = ref(false);
const recruitLoading = ref(false);

/** 二级弹窗：当前正在点将出征的秘境（null = 未打开）。 */
const exploreRealm = ref<SecretRealmView | null>(null);

/** 切磋弹窗的目标宗门（null = 未打开）。 */
const sparTarget = ref<PublicSectView | null>(null);

/** 本地平滑显示：每秒按服务端给的产量推进，上限为容量（刷新后以服务端为准）。 */
const liveResources = ref<Record<string, number>>({});
const liveCultivation = ref<Record<string, number>>({});

function seedFromState(): void {
  liveResources.value = Object.fromEntries(
    props.state.resources.map((resource) => [resource.id, Number(resource.balance)]),
  );
  liveCultivation.value = Object.fromEntries(
    props.state.disciples.map((disciple) => [disciple.id, disciple.cultivation]),
  );
}

watch(() => props.state, seedFromState, { immediate: true });

const timer = window.setInterval(() => {
  const resources: Record<string, number> = { ...liveResources.value };
  for (const resource of props.state.resources) {
    const ratePerSecond = Number(resource.ratePerHour) / 3600;
    const capacity = Number(resource.capacity);
    // 只阻止增长越界：探索奖励允许把余额顶到容量之上，这里不能把它压回去（否则界面会跳变）。
    const current = resources[resource.id] ?? 0;
    resources[resource.id] = current >= capacity ? current : Math.min(capacity, current + ratePerSecond);
  }
  liveResources.value = resources;

  const cultivation: Record<string, number> = { ...liveCultivation.value };
  for (const disciple of props.state.disciples) {
    const threshold = disciple.requiredCultivation;
    const next = (cultivation[disciple.id] ?? 0) + disciple.cultivationRatePerHour / 3600;
    cultivation[disciple.id] = threshold === null ? next : Math.min(threshold, next);
  }
  liveCultivation.value = cultivation;
}, 1000);

onUnmounted(() => {
  window.clearInterval(timer);
});

const resourceName = computed<Record<string, string>>(() =>
  Object.fromEntries(props.state.resources.map((resource) => [resource.id, resource.name])),
);

const settlementText = computed(() => {
  const seconds = props.state.settle.durationSeconds;
  if (seconds < 60) return '方才完成结算';
  if (seconds < 3600) return `已结算 ${Math.floor(seconds / 60)} 分钟收益`;
  return `已结算 ${Math.floor(seconds / 3600)} 小时收益`;
});

function costText(cost: Record<string, string> | null): string {
  if (cost === null) return '已臻满级';
  return Object.entries(cost)
    .map(([resourceId, amount]) => `${resourceName.value[resourceId] ?? resourceId} ${formatAmount(amount)}`)
    .join(' · ');
}

function progressPercent(discipleId: string, required: number | null): number {
  if (required === null || required === 0) return 100;
  const current = liveCultivation.value[discipleId] ?? 0;
  return Math.min(100, Math.round((current / required) * 100));
}

function resourcePercent(resourceId: string, capacity: string): number {
  const maximum = Number(capacity);
  if (maximum <= 0) return 0;
  return Math.min(100, Math.round(((liveResources.value[resourceId] ?? 0) / maximum) * 100));
}


function resourceClass(resourceId: string): string {
  if (resourceId === 'spiritStone') return 'resource-stone';
  if (resourceId === 'spiritualEnergy') return 'resource-energy';
  if (resourceId === 'herb') return 'resource-herb';
  if (resourceId === 'ore') return 'resource-ore';
  return 'resource-default';
}

function buildingGlyph(defId: string): string {
  if (defId === 'spiritualArray') return '阵';
  if (defId === 'herbGarden') return '圃';
  if (defId === 'missionHall') return '令';
  if (defId === 'scriptureLibrary') return '经';
  if (defId === 'arenaHall') return '武';
  return '殿';
}

/** 宗门等级上限（与后端 SECT_LEVELS 一致）。 */
const MAX_SECT_LEVEL = 10;

/** 建筑等级用菱形字标显示（与后端建筑上限 5 级一致）。 */
const LEVEL_GLYPHS = ['壹', '贰', '叁', '肆', '伍'] as const;

/** 该建筑最大等级决定显示几个菱形。 */
function levelGlyphsFor(building: BuildingView): readonly string[] {
  return LEVEL_GLYPHS.slice(0, Math.min(building.maxLevel, LEVEL_GLYPHS.length));
}

function buildingDescription(defId: string): string {
  if (defId === 'spiritualArray') return '汇聚天地灵气，助益弟子问道';
  if (defId === 'herbGarden') return '培育灵植，为宗门积蓄药材';
  if (defId === 'missionHall') return '统筹宗门事务与弟子差遣';
  if (defId === 'scriptureLibrary') return '典藏万卷，加速弟子修炼';
  if (defId === 'arenaHall') return '锻炼武技，开启秘境探索';
  return '宗门基业，随等级提升效用';
}

/** 张榜招贤：先取本次候选人（服务端按宗门+当日+次数做种子，刷新不变），再弹窗三选一。 */
async function requestRecruit(): Promise<void> {
  if (props.busy || recruitLoading.value) return;
  recruitLoading.value = true;
  try {
    recruitPreview.value = await fetchRecruitPreview();
    showRecruitDialog.value = true;
  } catch (caught) {
    emit('notify', 'error', '招贤台未应', caught instanceof Error ? caught.message : '候选人生成失败');
  } finally {
    recruitLoading.value = false;
  }
}

/** 选中一位候选人：关掉弹窗，把 choice 交给 App.vue 去调接口。 */
function onRecruitChoose(choice: number): void {
  showRecruitDialog.value = false;
  recruitPreview.value = null;
  emit('recruit', choice);
}

function requestUpgrade(building: BuildingView): void {
  if (props.busy) return;
  if (!building.canUpgrade) {
    emit('notify', 'warning', `${building.name}暂不可升级`, building.blockedReason ?? '当前条件尚未满足。');
    return;
  }
  emit('upgrade', building.defId);
}

function requestUpgradeSect(): void {
  const upgrade = props.state.sectUpgrade;
  if (props.busy || upgrade === null) return;
  if (!upgrade.canUpgrade) {
    emit('notify', 'warning', `暂不可晋升${upgrade.nextLevelName}`, upgrade.blockedReason ?? '当前条件尚未满足。');
    return;
  }
  emit('upgrade-sect');
}

/** 秘境列表里点「探索」：打开二级弹窗选人。 */
function onSelectRealm(realm: SecretRealmView): void {
  exploreRealm.value = realm;
}

/** 选好人出发：关掉选人弹窗，把秘境与队伍交给上层调接口（结果由 App.vue 提示）。 */
function onPartyExplore(realmId: string, discipleIds: string[]): void {
  if (props.busy) return;
  exploreRealm.value = null;
  emit('explore', realmId, discipleIds);
}

/** 公开档案里点「切磋」：打开切磋弹窗。 */
function onSparRequest(sect: PublicSectView): void {
  if (props.busy) return;
  sparTarget.value = sect;
}

/** 出手：关掉切磋弹窗，把三方 id 交给上层调接口（结果由 App.vue 提示）。 */
function onSparSubmit(targetSectId: string, myDiscipleId: string, targetDiscipleId: string): void {
  if (props.busy) return;
  sparTarget.value = null;
  emit('spar', targetSectId, myDiscipleId, targetDiscipleId);
}

function requestBreakthrough(disciple: DiscipleView): void {
  if (props.busy) return;
  if (!disciple.canBreakthrough) {
    emit('notify', 'warning', `${disciple.name}暂不可突破`, disciple.blockedReason ?? '当前条件尚未满足。');
    return;
  }
  emit('breakthrough', disciple.id);
}
</script>

<template>
  <main class="game-shell" :aria-busy="busy">
    <header class="game-topbar">
      <div class="sect-identity">
        <div class="sect-emblem" aria-hidden="true"><span>{{ state.sect.name.slice(0, 1) }}</span></div>
        <div>
          <p class="eyebrow">太初界 · 掌门府</p>
          <h1>{{ state.sect.name }}</h1>
          <p class="sect-level">{{ state.sect.levelName }}（{{ state.sect.level }}/{{ MAX_SECT_LEVEL }}）· 声望 {{ state.sect.reputation }}</p>
        </div>
      </div>

      <dl class="sect-metrics" aria-label="宗门概况">
        <div><dt>宗门品阶</dt><dd><b>LV.</b>{{ state.sect.level }}</dd></div>
        <div><dt>灵脉品阶</dt><dd><b>LV.</b>{{ state.sect.veinLevel }}</dd></div>
        <div><dt>门下弟子</dt><dd>{{ state.recruit.discipleCount }}<b>/{{ state.sect.discipleCapacity }}</b></dd></div>
      </dl>

      <div class="header-actions">
        <button
          class="icon-action"
          type="button"
          :disabled="busy"
          aria-label="同步宗门状态"
          @click="emit('refresh')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 7v5h-5M4 17v-5h5M6.1 8.4A7 7 0 0 1 18.5 7M17.9 15.6A7 7 0 0 1 5.5 17" />
          </svg>
          <span>同步</span>
        </button>
        <button class="icon-action" type="button" :disabled="busy" aria-label="退出登录" @click="emit('logout')">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M10 5H5v14h5m5-4 4-3-4-3m4 3H9" />
          </svg>
          <span>离开</span>
        </button>
      </div>
    </header>


    <section class="overview-panel" aria-labelledby="resource-title">
      <header class="section-heading overview-heading">
        <div>
          <p class="eyebrow">宗门库藏</p>
          <h2 id="resource-title">山门百业，生生不息</h2>
        </div>
        <div class="settlement-badge">
          <span class="pulse-dot" aria-hidden="true" />
          <span>{{ settlementText }} · {{ formatTime(state.sect.lastSettledAt) }}</span>
        </div>
      </header>

      <ul class="resource-grid">
        <li
          v-for="resource in state.resources"
          :key="resource.id"
          class="resource-card"
          :class="resourceClass(resource.id)"
        >
          <div class="resource-glyph" aria-hidden="true">{{ resourceGlyph(resource.id) }}</div>
          <div class="resource-main">
            <span class="resource-name">{{ resource.name }}</span>
            <strong>{{ formatAmount(liveResources[resource.id] ?? 0) }}</strong>
            <span class="resource-capacity">库容 {{ formatAmount(resource.capacity) }}</span>
          </div>
          <div class="resource-rate">
            <span>每时产出</span>
            <strong>+{{ formatRate(resource.ratePerHour) }}</strong>
          </div>
          <div class="resource-track" aria-hidden="true">
            <span :style="{ width: `${resourcePercent(resource.id, resource.capacity)}%` }" />
          </div>
        </li>
      </ul>
    </section>

    <div class="action-bar" role="toolbar" aria-label="宗门操作">
      <button class="action-chip" type="button" @click="openPanel = 'events'">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 4h9a2 2 0 0 1 2 2v12a2 2 0 0 0 2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2 4h5m-5 4h5" />
        </svg>
        <span>天机录</span>
        <span v-if="recentEventCount > 0" class="chip-badge">{{ recentEventCount }}</span>
      </button>
      <button class="action-chip" type="button" @click="openPanel = 'explore'">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm3.4 5.6-2.1 5-5 2.1 2.1-5 5-2.1Z" />
        </svg>
        <span>历练探索</span>
      </button>
      <button class="action-chip" type="button" @click="openPanel = 'leaderboard'">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3.5 14.6 9l6 .9-4.3 4.2 1 6-5.3-2.8-5.3 2.8 1-6L3.4 9.9l6-.9 2.6-5.5Z" />
        </svg>
        <span>江湖榜</span>
      </button>
      <button class="action-chip" type="button" @click="openPanel = 'spar-history'">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 2a4 4 0 1 0 0-0" />
        </svg>
        <span>演武录</span>
      </button>
    </div>

    <div class="management-grid">
      <section class="game-panel disciple-panel" aria-labelledby="disciple-title">
        <header class="section-heading panel-heading">
          <div>
            <p class="eyebrow">门人名册</p>
            <h2 id="disciple-title">弟子修行</h2>
          </div>
          <span class="count-badge">{{ state.disciples.length }} 位门人</span>
        </header>

        <ul v-if="state.disciples.length > 0" class="disciple-list">
          <li v-for="disciple in state.disciples" :key="disciple.id" class="disciple-card">
            <div class="disciple-avatar" :class="`realm-${disciple.realmId}`" aria-hidden="true">
              <span>{{ disciple.name.slice(0, 1) }}</span>
              <i>{{ disciple.gender === 'female' ? '坤' : '乾' }}</i>
            </div>

            <div class="disciple-info">
              <div class="disciple-name-row">
                <div>
                  <strong>{{ disciple.name }}</strong>
                  <span class="realm-tag">{{ disciple.stageName }}</span>
                </div>
                <span class="aptitude-badge">资质 {{ disciple.aptitude }}</span>
              </div>

              <div class="disciple-stats">
                <span class="stat-tag stat-attack">攻 {{ disciple.attack }}</span>
                <span class="stat-tag stat-defense">防 {{ disciple.defense }}</span>
                <span class="stat-tag stat-speed">速 {{ disciple.speed }}</span>
                <span class="stat-tag stat-talent">{{ disciple.talentName }}</span>
                <span class="stat-tag stat-power">战力 {{ disciple.combatPower }}</span>
              </div>

              <div class="cultivation-row">
                <div class="cultivation-label">
                  <span>修为进境</span>
                  <span>
                    {{ Math.floor(liveCultivation[disciple.id] ?? 0) }}
                    <template v-if="disciple.requiredCultivation !== null"> / {{ disciple.requiredCultivation }}</template>
                    <template v-else> · 已臻当前绝顶</template>
                  </span>
                </div>
                <div class="cultivation-track" role="progressbar" :aria-label="`${disciple.name}修为进境`" :aria-valuenow="progressPercent(disciple.id, disciple.requiredCultivation)" aria-valuemin="0" aria-valuemax="100">
                  <span :style="{ width: `${progressPercent(disciple.id, disciple.requiredCultivation)}%` }" />
                </div>
                <span class="cultivation-rate">静修 +{{ disciple.cultivationRatePerHour }}/时</span>
              </div>
            </div>

            <div class="disciple-controls">
              <span class="control-caption">当前差遣</span>
              <AssignmentSelect
                :model-value="disciple.assignment"
                :options="state.assignments"
                :disabled="busy"
                :label="disciple.name"
                @change="emit('assign', disciple.id, $event)"
              />
              <button
                class="breakthrough-button"
                :class="{ 'is-disabled': !disciple.canBreakthrough }"
                type="button"
                :disabled="busy"
                :aria-disabled="!disciple.canBreakthrough"
                @click="requestBreakthrough(disciple)"
              >
                <span>
                  <b>破境</b>
                  <small>{{ formatBp(disciple.breakthroughChanceBp) }} 胜算 · 灵气 {{ formatAmount(disciple.breakthroughCost) }}</small>
                </span>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 15 5-8 5 8m-10 3h10" /></svg>
              </button>
            </div>
          </li>
        </ul>

        <div v-else class="empty-state">
          <span aria-hidden="true">寂</span>
          <strong>门下尚无弟子</strong>
          <p>可从右侧招贤台迎接有缘之人。</p>
        </div>
      </section>

      <aside class="management-rail">
        <section class="recruit-card" aria-labelledby="recruit-title">
          <div class="recruit-mist" aria-hidden="true" />
          <p class="eyebrow">招贤台</p>
          <h2 id="recruit-title">山门广纳有缘人</h2>
          <p>散修闻名而来，资质与姓名皆由天机择定。</p>

          <div class="recruit-quota">
            <div>
              <span>今日余次</span>
              <strong>{{ state.recruit.remaining }}<small>/{{ state.recruit.dailyLimit }}</small></strong>
            </div>
            <div class="quota-marks" aria-hidden="true">
              <i
                v-for="index in state.recruit.dailyLimit"
                :key="index"
                :class="{ spent: index <= state.recruit.usedToday }"
              />
            </div>
          </div>

          <button
            class="action-button recruit-button"
            :class="{ 'is-disabled': !state.recruit.canRecruit }"
            type="button"
            :disabled="busy"
            :aria-disabled="!state.recruit.canRecruit"
            @click="requestRecruit"
          >
            <span>张榜招贤</span>
            <small>消耗 {{ costText(state.recruit.cost) }}</small>
          </button>
        </section>

        <section v-if="state.sectUpgrade" class="game-panel sect-upgrade-panel" aria-labelledby="sect-upgrade-title">
          <header class="section-heading panel-heading compact-heading">
            <div>
              <p class="eyebrow">宗门晋升</p>
              <h2 id="sect-upgrade-title">{{ state.sectUpgrade.nextLevelName }}</h2>
            </div>
            <span class="count-badge">{{ state.sect.level }}/{{ MAX_SECT_LEVEL }}</span>
          </header>

          <div class="upgrade-body">
            <ul class="upgrade-requirements">
              <li v-for="req in state.sectUpgrade.requirements" :key="req.label" class="requirement-row">
                <span class="requirement-mark" :class="req.met ? 'req-met' : 'req-unmet'" aria-hidden="true">{{ req.met ? '✓' : '✗' }}</span>
                <span class="requirement-label">{{ req.label }}</span>
              </li>
            </ul>

            <p class="upgrade-cost">
              <span class="eyebrow">消耗</span>
              <span>{{ costText(state.sectUpgrade.cost) }}</span>
            </p>

            <button
              class="action-button primary-action sect-upgrade-button"
              :class="{ 'is-disabled': !state.sectUpgrade.canUpgrade }"
              type="button"
              :disabled="busy"
              :aria-disabled="!state.sectUpgrade.canUpgrade"
              @click="requestUpgradeSect"
            >
              <span>晋升宗门</span>
            </button>

            <p v-if="state.sectUpgrade.blockedReason" class="blocked-hint">{{ state.sectUpgrade.blockedReason }}</p>
          </div>
        </section>
        <section class="game-panel building-panel" aria-labelledby="building-title">
          <header class="section-heading panel-heading compact-heading">
            <div>
              <p class="eyebrow">宗门营造</p>
              <h2 id="building-title">山门建筑</h2>
            </div>
            <span class="count-badge">{{ state.buildings.length }}/{{ state.sect.buildingCapacity }}</span>
          </header>

          <ul v-if="state.buildings.length > 0" class="building-list">
            <li v-for="building in state.buildings" :key="building.defId" class="building-card">
              <div class="building-glyph" aria-hidden="true">{{ buildingGlyph(building.defId) }}</div>
              <div class="building-copy">
                <div>
                  <strong>{{ building.name }}</strong>
                  <span
                    v-for="(glyph, index) in levelGlyphsFor(building)"
                    :key="index"
                    :class="{ dim: building.level < index + 1 }"
                  >{{ glyph }}</span>
                </div>
                <p>{{ buildingDescription(building.defId) }}</p>
                <small>{{ costText(building.upgradeCost) }}</small>
              </div>
              <button
                class="upgrade-button"
                :class="{ 'is-disabled': !building.canUpgrade }"
                type="button"
                :disabled="busy"
                :aria-disabled="!building.canUpgrade"
                :aria-label="`升级${building.name}`"
                @click="requestUpgrade(building)"
              >
                <span>{{ building.level >= building.maxLevel ? '满级' : '升级' }}</span>
                <svg v-if="building.level < building.maxLevel" viewBox="0 0 18 18" aria-hidden="true">
                  <path d="m5 11 4-4 4 4" />
                </svg>
              </button>
            </li>
          </ul>

          <div v-else class="empty-state compact-empty">
            <span aria-hidden="true">山</span>
            <strong>暂无建筑</strong>
          </div>
        </section>
      </aside>
    </div>

    <footer class="game-footer">
      <span>天地法则由服务端裁定</span>
      <i aria-hidden="true" />
      <span>宗门每六十息自动同步</span>
      <i aria-hidden="true" />
      <span>离线期间亦会持续修行</span>
    </footer>
    <ModalShell v-if="openPanel === 'events'" label="近期异象" @close="openPanel = null">
      <EventLogPanel :state="state" />
    </ModalShell>

    <ModalShell v-if="openPanel === 'explore'" label="秘境探索" @close="openPanel = null">
      <ExplorePanel :state="state" :busy="busy" @select="onSelectRealm" />
    </ModalShell>

    <!-- 选人出征：叠在秘境列表之上，Esc / 点遮罩只关这一层。 -->
    <ModalShell
      v-if="exploreRealm"
      narrow
      :label="`选择弟子 · ${exploreRealm.name}`"
      @close="exploreRealm = null"
    >
      <ExplorePartyDialog
        :realm="exploreRealm"
        :state="state"
        :busy="busy"
        @explore="onPartyExplore"
      />
    </ModalShell>

    <ModalShell v-if="openPanel === 'leaderboard'" label="江湖榜" @close="openPanel = null">
      <LeaderboardPanel :state="state" :busy="busy" @spar="onSparRequest" />
    </ModalShell>

    <ModalShell v-if="openPanel === 'spar-history'" label="演武录" @close="openPanel = null">
      <SparHistoryPanel :state="state" />
    </ModalShell>

    <!-- 切磋：叠在江湖榜 / 公开档案之上，Esc 只关这一层。 -->
    <ModalShell
      v-if="sparTarget"
      narrow
      :label="`切磋 · ${sparTarget.name}`"
      @close="sparTarget = null"
    >
      <SparDialog :target="sparTarget" :state="state" :busy="busy" @spar="onSparSubmit" />
    </ModalShell>

    <!-- 招贤台：点「张榜招贤」拉到候选人后才打开。 -->
    <ModalShell
      v-if="showRecruitDialog && recruitPreview"
      label="招贤台"
      @close="showRecruitDialog = false"
    >
      <RecruitDialog
        :preview="recruitPreview"
        :cost-text="costText(state.recruit.cost)"
        :busy="busy"
        @choose="onRecruitChoose"
      />
    </ModalShell>
  </main>
</template>
