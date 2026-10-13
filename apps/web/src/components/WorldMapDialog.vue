<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

import type {
  SectStateView,
  WorldActionResponse,
  WorldBattleResultView,
  WorldPanelView,
  WorldRoundView,
  WorldSiteView,
} from '../api/game';
import { attackWorldSite, fetchWorld, withdrawWorldSite } from '../api/game';
import { formatAmount, formatTime } from '../utils/format';
import ConfirmDialog from './ConfirmDialog.vue';
import DisciplePicker from './DisciplePicker.vue';
import ModalShell from './ModalShell.vue';
import WorldMapSvg from './WorldMapSvg.vue';

/**
 * 0051 山河舆图面板（docs/山河舆图开发计划.md 2.7）。
 *
 * 只在「打开时 / 操作后 / 点刷新 / 切换纪事范围」请求接口，不轮询；禁制护持倒计时由前端每 30 秒回算。
 * 能不能驱妖 / 斗法 / 撤回、守军与战力、护持时长全部由服务端算好，这里只渲染与选人。
 * 选人与撤回确认是叠在面板之上的二级弹窗；面板本身放地图、选中域的灵地与山河纪事。
 */
const props = defineProps<{
  state: SectStateView;
  busy?: boolean;
}>();

const emit = defineEmits<{
  'state-update': [state: SectStateView];
  notify: [tone: 'success' | 'warning', title: string, message: string];
}>();

const panel = ref<WorldPanelView | null>(null);
const loading = ref(false);
const submitting = ref(false);
const showRules = ref(false);
/** 纪事范围：all 天下 / mine 本宗（切换时带 scope 重新拉取）。 */
const scope = ref<'all' | 'mine'>('all');
/** 地图上金边的域（null = 还没拿到面板，拿到后按默认规则定下，之后由玩家点选）。 */
const selectedRegionId = ref<string | null>(null);
/** 正在选人的灵地与动作：驱妖开辟（beast）/ 斗法（battle）。 */
const picking = ref<{ siteId: string; mode: 'beast' | 'battle' } | null>(null);
const selected = ref<string[]>([]);
/** 等待确认撤回山门的灵地（null = 确认弹窗没开）。 */
const withdrawTarget = ref<WorldSiteView | null>(null);
/** 最近一场驱妖 / 斗法的战报。 */
const lastBattle = ref<WorldBattleResultView | null>(null);

/** 守方战力加成（展示用：与服务端 WORLD_DEFENDER_BONUS_BP = 1000，即 +10% 同口径）。 */
const DEFENDER_BONUS = 1.1;

/* ---------- 倒计时 ---------- */

const nowMs = ref(Date.now());
let clock: number | undefined;

/** 禁制护持剩余时间（「2:13」= 2 小时 13 分）；没有护持或已过期为 null。 */
function protectLeftText(untilIso: string | null): string | null {
  if (untilIso === null) return null;
  const until = Date.parse(untilIso);
  if (!Number.isFinite(until) || until <= nowMs.value) return null;
  const minutes = Math.max(1, Math.ceil((until - nowMs.value) / 60_000));
  return `${String(Math.floor(minutes / 60))}:${String(minutes % 60).padStart(2, '0')}`;
}

/* ---------- 展示 ---------- */

function powerText(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** 一回合的文字（战报与纪事共用）。 */
function roundText(round: WorldRoundView): string {
  const defender = round.defenderName;
  const guard = defender === null ? '守军缺席' : `${defender} ${powerText(round.defenderPower ?? 0)}`;
  return `第 ${String(round.round)} 回合：${round.attackerName} ${powerText(round.attackerPower)} 对 ${guard} → ${
    round.winner === 'attacker' ? '胜' : '负'
  }`;
}

/** 战报标题：驱妖（无守方）与斗法分开说。 */
function battleTitle(battle: WorldBattleResultView): string {
  const defender = battle.defenderName;
  if (defender === null) {
    return `${battle.won ? '驱妖开辟成功' : '驱妖失败'} · ${battle.siteName}`;
  }
  return `${battle.won ? '斗法夺地成功' : '斗法失败'} · ${battle.siteName}（守方 ${defender}）`;
}

const selectedRegion = computed(
  () => panel.value?.regions.find((region) => region.id === selectedRegionId.value) ?? null,
);

/** 选中域的灵地（服务端顺序：灵地 → 福地 → 洞天；中州为两处祖脉）。 */
const regionSites = computed(() =>
  (panel.value?.sites ?? []).filter((site) => site.regionId === selectedRegionId.value),
);

/** 域名旁的小字：主产 / 祖脉。 */
const regionTagline = computed(() => {
  const region = selectedRegion.value;
  if (region === null) return '';
  return region.resourceName === null ? '祖脉 · 灵气与稀有' : `主产${region.resourceName}`;
});

const pickingSite = computed(() => panel.value?.sites.find((site) => site.id === picking.value?.siteId) ?? null);

/* ---------- 选人（驱妖开辟 / 斗法） ---------- */

const disabled = computed(() => submitting.value || props.busy === true);

const pickingTitle = computed(() => {
  const site = pickingSite.value;
  const mode = picking.value?.mode;
  if (site === null || mode === undefined) return '';
  return mode === 'beast' ? `驱妖开辟「${site.name}」` : `斗法「${site.name}」`;
});

const pickingHint = computed(() => {
  const site = pickingSite.value;
  const mode = picking.value?.mode;
  if (site === null || mode === undefined) return '';
  const party = String(panel.value?.partySize ?? 3);
  if (mode === 'beast') {
    return `无主灵地盘踞着 3 只妖兽，派 ${party} 名弟子按点选顺序逐回合驱逐（妖兽战力为对位弟子的 90%，不加守方加成）。打赢即开辟，三人就地坐镇。`;
  }
  const holder = site.holder?.name ?? '';
  return `守方 ${holder} · 守军战力 ${powerText(site.garrisonPower)}；按点选顺序逐回合对阵守军，三局两胜，守方 +10%。守军缺席的回合直接判你胜。打赢即夺地，三人就地坐镇。`;
});

/** 斗法时逐回合的战力对照（守方含 +10%）；驱妖的妖兽战力由服务端定，这里不列。 */
const matchups = computed(() => {
  const site = pickingSite.value;
  if (site === null || picking.value?.mode !== 'battle') return [];
  return selected.value.map((id, index) => {
    const mine = props.state.disciples.find((disciple) => disciple.id === id);
    const guard = site.garrison[index];
    return {
      round: index + 1,
      mine: mine === undefined ? '—' : `${mine.name} ${powerText(mine.combatPower)}`,
      theirs:
        guard === undefined || guard.absent
          ? '缺席（直接胜）'
          : `${guard.name} ${powerText(guard.power * DEFENDER_BONUS)}`,
    };
  });
});

const confirmText = computed(() => {
  const left = String(panel.value?.battlesLeft ?? 0);
  return picking.value?.mode === 'beast' ? `驱妖开辟（今日还剩 ${left} 次）` : `斗法（今日还剩 ${left} 次）`;
});

/* ---------- 规则说明（数字尽量取面板给的值） ---------- */

const rulesItems = computed(() => {
  const data = panel.value;
  const party = String(data?.partySize ?? 3);
  return [
    `开放：宗门 ${String(data?.unlockSectLevel ?? 3)} 级。镇守名额随宗门等级增加：3～5 级 1 处，6～8 级 2 处，9 级及以上 3 处；名额满了先撤回一处。`,
    `驱妖开辟：无主灵地盘踞 3 只妖兽，派 ${party} 名弟子逐回合对阵，妖兽战力为对位弟子的 90%，不加守方加成。打赢即开辟。`,
    `斗法夺地：有主灵地派 ${party} 名弟子对阵守军，三局两胜，守方战力 +10%。打赢即夺地，原守军撤回不受伤。`,
    `坐镇：开辟或夺下后，这 ${party} 人就地坐镇，不能换防。坐镇期间只修炼、破境、服药、祭炼；不能转岗、任执事、历练、探秘境、镇妖塔、讨伐、比斗、进守擂阵容、论道、驱逐、穿卸装备，也不能再去打别的灵地。想换人只能先撤回山门，撤回后 24 小时内本宗不能再开辟或斗法这一处。`,
    '受伤：出战失败时，每名出战弟子有 30% 概率轻伤，疗伤 30 分钟。',
    `禁制护持：开辟或易主后 ${String(data?.protectHours ?? 4)} 小时内不能被斗法；撤回山门后灵地回到妖兽手里，没有禁制。`,
    `限制：每天最多斗法 ${String(data?.dailyBattles ?? 10)} 次（自然日，驱妖开辟也计入）；不能斗法宗门等级比自己低 ${String(data?.levelGap ?? 3)} 级及以上的宗门。`,
    '供奉：每个整点按灵地产出入账，只算完整的整点小时；中州祖脉每坐镇满 6 个整点小时另得 5 个玄铁 / 神木。',
  ];
});

/* ---------- 请求 ---------- */

/** 最近一次拉取的序号：快速切换纪事范围时，只采用最后发出的那次回执。 */
let requestSeq = 0;

function applyPanel(data: WorldPanelView): void {
  panel.value = data;
  nowMs.value = Date.now();
  if (selectedRegionId.value === null) selectedRegionId.value = defaultRegionOf(data);
}

/** 默认金边的域：第一个有本宗灵地的域（按域的顺序）；没有则中州。 */
function defaultRegionOf(data: WorldPanelView): string {
  const mine = data.regions.find((region) =>
    data.sites.some((site) => site.regionId === region.id && site.holder?.isMe === true),
  );
  return mine?.id ?? 'center';
}

async function refresh(): Promise<void> {
  const seq = ++requestSeq;
  loading.value = true;
  try {
    const data = await fetchWorld(scope.value);
    if (seq !== requestSeq) return;
    emit('state-update', data.state);
    applyPanel(data.world);
  } catch (error) {
    if (seq === requestSeq) {
      emit('notify', 'warning', '山河舆图', error instanceof Error ? error.message : '面板加载失败');
    }
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

async function run(action: () => Promise<WorldActionResponse>): Promise<boolean> {
  if (disabled.value) return false;
  submitting.value = true;
  try {
    const data = await action();
    emit('state-update', data.state);
    applyPanel(data.world);
    if (data.result.battle !== null) lastBattle.value = data.result.battle;
    const lost = data.result.battle !== null && !data.result.battle.won;
    emit('notify', lost ? 'warning' : 'success', '山河舆图', data.result.message);
    // 命令回执里的纪事固定是「天下」：本宗视图下补拉一次，免得筛选与列表对不上。
    if (data.world.scope !== scope.value) void refresh();
    return true;
  } catch (error) {
    emit('notify', 'warning', '山河舆图', error instanceof Error ? error.message : '操作失败，请稍后再试');
    void refresh();
    return false;
  } finally {
    submitting.value = false;
  }
}

function selectRegion(regionId: string): void {
  selectedRegionId.value = regionId;
}

function setScope(next: 'all' | 'mine'): void {
  if (scope.value === next) return;
  scope.value = next;
  void refresh();
}

function startPicking(site: WorldSiteView, mode: 'beast' | 'battle'): void {
  picking.value = { siteId: site.id, mode };
  selected.value = [];
  lastBattle.value = null;
}

async function confirmPick(): Promise<void> {
  const target = picking.value;
  const party = panel.value?.partySize ?? 3;
  if (target === null || selected.value.length !== party) return;
  const ids = [...selected.value];
  const ok = await run(() => attackWorldSite(target.siteId, ids));
  if (ok) {
    picking.value = null;
    selected.value = [];
  }
}

async function confirmWithdraw(): Promise<void> {
  const site = withdrawTarget.value;
  if (site === null) return;
  await run(() => withdrawWorldSite(site.id));
  withdrawTarget.value = null;
}

onMounted(() => {
  void refresh();
  clock = window.setInterval(() => {
    nowMs.value = Date.now();
  }, 30_000);
});

onUnmounted(() => {
  if (clock !== undefined) window.clearInterval(clock);
});
</script>

<template>
  <section class="world-panel" aria-labelledby="world-title">
    <div class="world-head modal-head">
      <h3 id="world-title" class="world-title">山河舆图</h3>
      <div class="world-head-actions">
        <button class="world-quiet-button" type="button" :aria-expanded="showRules" @click="showRules = !showRules">
          {{ showRules ? '收起说明' : '说明' }}
        </button>
        <button class="world-quiet-button" type="button" :disabled="loading" @click="refresh">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </div>

    <p v-if="panel === null" class="world-empty">{{ loading ? '山河舆图加载中…' : '面板加载失败，请点刷新。' }}</p>

    <template v-else>
      <p v-if="!panel.unlocked" class="world-locked">
        宗门 {{ panel.unlockSectLevel }} 级开放山河舆图，下面可以先看看各域的归属。
      </p>

      <p class="world-summary">
        <span class="world-label">镇守</span>
        <strong>{{ panel.held }}/{{ panel.cap }}</strong>
        <span class="world-sep" aria-hidden="true">·</span>
        <span class="world-label">今日斗法</span>
        <strong :class="{ 'is-out': panel.battlesLeft <= 0 }">{{ panel.battlesUsed }}/{{ panel.dailyBattles }}</strong>
      </p>

      <section v-if="showRules" class="world-rules" aria-labelledby="world-rules-title">
        <h4 id="world-rules-title" class="world-section-title">规则说明</h4>
        <ul class="world-rules-list">
          <li v-for="item in rulesItems" :key="item">{{ item }}</li>
        </ul>
      </section>

      <!-- 上一场驱妖 / 斗法的战报 -->
      <div v-if="lastBattle" class="world-result" :class="lastBattle.won ? 'is-won' : 'is-lost'">
        <p class="world-result-title">{{ battleTitle(lastBattle) }}</p>
        <p v-for="round in lastBattle.rounds" :key="round.round" class="world-result-line">{{ roundText(round) }}</p>
        <p v-if="lastBattle.injured.length > 0" class="world-result-line is-warn">
          受伤：{{ lastBattle.injured.join('、') }}（疗伤 30 分钟）
        </p>
      </div>

      <div class="world-main">
        <div class="world-map-col">
          <WorldMapSvg
            :regions="panel.regions"
            :sites="panel.sites"
            :selected-id="selectedRegionId ?? ''"
            @select="selectRegion"
          />
        </div>

        <section class="world-sites" aria-labelledby="world-sites-title">
          <header class="world-sites-head">
            <h4 id="world-sites-title" class="world-section-title">{{ selectedRegion?.name ?? '灵地' }}</h4>
            <span class="world-tagline">{{ regionTagline }}</span>
          </header>

          <p v-if="regionSites.length === 0" class="world-empty">这一域还没有灵地。</p>
          <ul v-else class="world-site-list">
            <li
              v-for="site in regionSites"
              :key="site.id"
              class="world-site"
              :class="{ 'is-mine': site.holder?.isMe === true, 'is-beast': site.holder === null }"
            >
              <div class="world-site-main">
                <p class="world-site-name">
                  <strong>{{ site.name }}</strong>
                  <span class="world-tier">{{ site.tierName }}</span>
                  <span v-if="site.holder?.isMe === true" class="world-tag is-mine">本宗</span>
                </p>
                <p class="world-site-output">
                  <span v-for="item in site.outputs" :key="item.resourceId">
                    {{ item.name }} +{{ formatAmount(item.perHour) }} / 时
                  </span>
                  <span v-if="site.rare !== null" class="world-rare">
                    每坐镇满 {{ site.rare.everyHours }} 个整点小时得 {{ site.rare.amount }} 个{{ site.rare.name }}
                  </span>
                </p>
                <p class="world-site-holder">
                  <template v-if="site.holder !== null">
                    占领：{{ site.holder.name }}（宗门 {{ site.holder.level }} 级）
                  </template>
                  <template v-else>妖兽盘踞</template>
                </p>
                <template v-if="site.holder !== null">
                  <p class="world-garrison-head">坐镇 {{ site.garrison.length }} 人 · 守军战力 {{ powerText(site.garrisonPower) }}</p>
                  <ul class="world-garrison">
                    <li v-for="member in site.garrison" :key="member.discipleId" :class="{ 'is-absent': member.absent }">
                      {{ member.name }} · {{ member.realmName }} · 战力 {{ powerText(member.power) }}
                      <em v-if="member.absent">缺席</em>
                    </li>
                  </ul>
                </template>
                <p v-if="protectLeftText(site.protectedUntil) !== null" class="world-protect">
                  禁制护持 · 剩 {{ protectLeftText(site.protectedUntil) }}
                </p>
              </div>

              <div class="world-site-actions">
                <button
                  v-if="site.action === 'beast'"
                  class="world-action is-primary"
                  type="button"
                  :disabled="disabled"
                  @click="startPicking(site, 'beast')"
                >
                  驱妖开辟
                </button>
                <button
                  v-else-if="site.action === 'battle'"
                  class="world-action is-primary"
                  type="button"
                  :disabled="disabled"
                  @click="startPicking(site, 'battle')"
                >
                  斗法
                </button>
                <button
                  v-else-if="site.action === 'mine'"
                  class="world-action"
                  type="button"
                  :disabled="disabled"
                  @click="withdrawTarget = site"
                >
                  撤回山门
                </button>
                <span v-else-if="site.blockedReason" class="world-blocked">{{ site.blockedReason }}</span>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <!-- 山河纪事：天下 / 本宗；只保留最近 3 天。 -->
      <section class="world-log" aria-labelledby="world-log-title">
        <header class="world-log-head">
          <div class="world-log-title-group">
            <h4 id="world-log-title" class="world-section-title">山河纪事</h4>
            <span class="world-tagline">只保留最近 3 天</span>
          </div>
          <div class="world-scope" role="group" aria-label="纪事范围">
            <button
              class="world-chip"
              :class="{ 'is-active': scope === 'all' }"
              type="button"
              :aria-pressed="scope === 'all'"
              @click="setScope('all')"
            >
              天下
            </button>
            <button
              class="world-chip"
              :class="{ 'is-active': scope === 'mine' }"
              type="button"
              :aria-pressed="scope === 'mine'"
              @click="setScope('mine')"
            >
              本宗
            </button>
          </div>
        </header>

        <p v-if="panel.logs.length === 0" class="world-empty">
          {{ scope === 'mine' ? '本宗还没有与灵地有关的纪事。' : '山河还很安静，还没有斗法与撤回的纪事。' }}
        </p>
        <ul v-else class="world-logs">
          <li v-for="log in panel.logs" :key="log.id" class="world-log-row" :class="`is-${log.kind}`">
            <details v-if="log.rounds !== null && log.rounds.length > 0" class="world-log-details">
              <summary>
                <time class="world-log-time" :datetime="log.createdAt">{{ formatTime(log.createdAt) }}</time>
                <span class="world-log-text">{{ log.text }}</span>
              </summary>
              <ul class="world-log-rounds">
                <li v-for="round in log.rounds" :key="round.round">{{ roundText(round) }}</li>
              </ul>
            </details>
            <template v-else>
              <time class="world-log-time" :datetime="log.createdAt">{{ formatTime(log.createdAt) }}</time>
              <span class="world-log-text">{{ log.text }}</span>
            </template>
          </li>
        </ul>
      </section>
    </template>

    <!-- 二级弹窗：驱妖开辟 / 斗法选人（Esc / 点遮罩只关这一层，不发请求）。 -->
    <ModalShell
      v-if="panel && picking && pickingSite"
      narrow
      :label="pickingTitle"
      :loading="submitting"
      loading-text="处理中…"
      @close="picking = null"
    >
      <section class="world-picking" aria-labelledby="world-picking-title">
        <header class="section-heading panel-heading compact-heading">
          <div>
            <p class="eyebrow">{{ pickingSite.regionName }} · {{ pickingSite.tierName }}</p>
            <h2 id="world-picking-title">{{ pickingTitle }}</h2>
          </div>
          <span class="count-badge">{{ selected.length }}/{{ panel.partySize }} 人</span>
        </header>
        <p class="world-picking-hint">{{ pickingHint }}</p>
        <ul v-if="picking.mode === 'battle' && matchups.length > 0" class="world-matchups">
          <li v-for="item in matchups" :key="item.round">
            第 {{ item.round }} 回合：{{ item.mine }} <span class="world-vs">对</span> {{ item.theirs }}
          </li>
        </ul>
        <DisciplePicker
          v-model:selected="selected"
          :disciples="state.disciples"
          :min="panel.partySize"
          :max="panel.partySize"
          :busy="disabled"
          sort="power"
          show-order
          :title="`选择 ${panel.partySize} 名弟子（点选顺序即回合顺序）`"
        />
        <div class="disciple-break-confirm-actions">
          <button class="action-button" type="button" :disabled="disabled" @click="picking = null">取消</button>
          <button
            class="action-button primary-action"
            type="button"
            :disabled="disabled || selected.length !== panel.partySize"
            @click="confirmPick"
          >
            <span>{{ submitting ? '处理中…' : confirmText }}</span>
          </button>
        </div>
      </section>
    </ModalShell>

    <ConfirmDialog
      v-if="withdrawTarget"
      eyebrow="山河舆图"
      :title="`撤回山门「${withdrawTarget.name}」`"
      message="撤回后灵地回到盘踞妖兽手里，坐镇的弟子立即解锁，没有禁制；已满的整点产出先结算给本宗。"
      :confirm-text="submitting ? '撤回中…' : '确认撤回'"
      :busy="disabled"
      @cancel="withdrawTarget = null"
      @confirm="confirmWithdraw"
    />
  </section>
</template>

<style scoped>
.world-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.world-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.world-title {
  margin: 0;
  color: var(--gold-bright, #ead19a);
  font-size: 16px;
  font-weight: 600;
}

.world-head-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.world-quiet-button {
  padding: 2px 10px;
  border: 1px solid rgba(202, 169, 106, 0.4);
  border-radius: 2px;
  background: rgba(202, 169, 106, 0.08);
  color: var(--gold, #caa96a);
  font-size: 12px;
  cursor: pointer;
}

.world-quiet-button:disabled {
  color: #63756c;
  cursor: not-allowed;
}

.world-empty {
  margin: 0;
  color: #6d8078;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.world-locked {
  margin: 0;
  padding: 6px 10px;
  border: 1px solid rgba(217, 138, 74, 0.4);
  border-radius: 3px;
  background: rgba(217, 138, 74, 0.08);
  color: #d9b06a;
  font-size: 12px;
}

.world-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 10px;
  margin: 0;
  padding: 6px 10px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.014);
  font-size: 12px;
}

.world-label {
  color: #8fa79b;
}

.world-sep {
  color: #5f7268;
}

.world-summary strong {
  color: var(--gold-bright, #ead19a);
}

.world-summary strong.is-out {
  color: #e06a5f;
}

.world-section-title {
  margin: 0;
  color: #8fa79b;
  font-size: 13px;
  font-weight: 600;
}

.world-tagline {
  color: #7d9186;
  font-size: 11px;
}

.world-rules {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-radius: 3px;
}

.world-rules-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding-left: 1.2em;
  color: #c8d6ce;
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.world-result {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 10px;
  border: 1px solid rgba(119, 184, 154, 0.3);
  border-radius: 3px;
  background: rgba(119, 184, 154, 0.06);
}

.world-result.is-lost {
  border-color: rgba(224, 106, 95, 0.32);
  background: rgba(224, 106, 95, 0.06);
}

.world-result-title {
  margin: 0;
  color: var(--gold-bright, #ead19a);
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.world-result.is-lost .world-result-title {
  color: #e8806c;
}

.world-result-line {
  margin: 0;
  color: #cbd8d0;
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.world-result-line.is-warn {
  color: #d9b06a;
}

/* 地图与灵地列表：窄屏上下排，宽屏（≥900px）左右排（1.3fr / 1fr）。 */
.world-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 14px;
}

@media (min-width: 900px) {
  .world-main {
    grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
  }
}

.world-map-col,
.world-sites {
  min-width: 0;
}

.world-sites {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.world-sites-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
}

.world-site-list,
.world-logs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.world-site {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px 10px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-left: 3px solid #d0584a;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.014);
}

.world-site.is-mine {
  border-left-color: #6fc79a;
  background: rgba(119, 184, 154, 0.07);
}

.world-site.is-beast {
  border-left-color: #9aa7a0;
}

.world-site-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.world-site-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  margin: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.world-site-name strong {
  color: var(--gold-bright, #ead19a);
}

.world-tier {
  color: #8fa79b;
  font-size: 11px;
}

.world-tag {
  padding: 0 6px;
  border-radius: 20px;
  font-size: 11px;
}

.world-tag.is-mine {
  background: rgba(119, 184, 154, 0.16);
  color: var(--jade-bright, #a6d5b9);
}

.world-site-output {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  margin: 0;
  color: #cbd8d0;
  font-size: 12px;
}

.world-rare {
  color: #d9b06a;
}

.world-site-holder,
.world-garrison-head,
.world-protect {
  margin: 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.world-site-holder {
  color: #8fa79b;
}

.world-garrison-head {
  color: #7d9186;
}

.world-garrison {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: 0;
  list-style: none;
  color: #a9bcb2;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.world-garrison li.is-absent {
  color: #5f6f68;
  text-decoration: line-through;
}

.world-garrison em {
  margin-left: 4px;
  font-style: normal;
  text-decoration: none;
  color: #6d8078;
}

.world-protect {
  color: #d9b06a;
}

.world-site-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.world-action {
  padding: 4px 10px;
  border: 1px solid rgba(202, 169, 106, 0.4);
  border-radius: 3px;
  background: rgba(202, 169, 106, 0.08);
  color: var(--gold, #caa96a);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}

.world-action.is-primary {
  border-color: rgba(234, 209, 154, 0.6);
  background: rgba(202, 169, 106, 0.18);
  color: var(--gold-bright, #ead19a);
}

.world-action:disabled {
  color: #63756c;
  cursor: not-allowed;
}

.world-blocked {
  color: #6d8078;
  font-size: 11px;
  text-align: right;
  overflow-wrap: anywhere;
}

.world-log {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.world-log-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.world-log-title-group {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
}

.world-scope {
  display: inline-flex;
  gap: 6px;
}

.world-chip {
  padding: 2px 12px;
  border: 1px solid rgba(202, 169, 106, 0.3);
  border-radius: 20px;
  background: transparent;
  color: #a9bcb2;
  font-size: 12px;
  cursor: pointer;
}

.world-chip.is-active {
  border-color: rgba(234, 209, 154, 0.6);
  background: rgba(202, 169, 106, 0.16);
  color: var(--gold-bright, #ead19a);
}

.world-log-row {
  color: #a9bcb2;
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.world-log-row.is-withdraw {
  color: #93a99e;
}

.world-log-time {
  margin-right: 8px;
  color: #6d8078;
  white-space: nowrap;
}

/* 去掉原生三角（会挂在内容左边缘外面），改在行尾提示可展开，时间列与普通行对齐。 */
.world-log-details summary {
  cursor: pointer;
  list-style: none;
}

.world-log-details summary::-webkit-details-marker {
  display: none;
}

.world-log-details summary .world-log-text::after {
  content: ' · 回合 ▾';
  color: var(--gold, #caa96a);
  white-space: nowrap;
}

.world-log-details[open] summary .world-log-text::after {
  content: ' · 收起 ▴';
}

.world-log-rounds {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 4px 0 2px 1.4em;
  padding: 0;
  color: #93a99e;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.world-picking {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.world-picking-hint {
  margin: 0;
  color: #93a99e;
  font-size: 12px;
  line-height: 1.6;
}

.world-matchups {
  margin: 0;
  padding: 0;
  list-style: none;
  color: #c8d6ce;
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.world-vs {
  color: #7d9186;
}

/* 窄屏：操作按钮另起一行靠右。 */
@media (max-width: 520px) {
  .world-site {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
