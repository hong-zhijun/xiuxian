<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { BeastCaptureAction, BeastCaptureView, SpiritBeastsPanel } from '@xiuxian/contracts';

import { actBeastCapture, fetchSpiritBeasts, startBeastCapture, type SectStateView } from '../api/game';
import type { ToastTone } from '../types/ui';
import { formatAmount } from '../utils/format';
import { beastAttrList } from '../utils/spiritBeasts';
import BeastCaptureFx, { type CaptureFxKind } from './BeastCaptureFx.vue';
import DisciplePicker from './DisciplePicker.vue';

/**
 * 宠物秘境：野外捕捉与灵兽图鉴。已有灵兽的装备、培养与放生在首页「灵兽苑」。
 * 捕捉活动存在服务端：关闭弹窗不会放弃，重新打开回到进行中的遭遇；每场的结局用 toast 提示。
 */
const props = defineProps<{ state: SectStateView }>();
const emit = defineEmits<{
  'state-update': [state: SectStateView];
  notify: [tone: ToastTone, title: string, message: string];
}>();

const TABS = [
  { id: 'capture', label: '野外捕捉' },
  { id: 'catalog', label: '灵兽图鉴' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const tab = ref<TabId>('capture');
const panel = ref<SpiritBeastsPanel | null>(null);
const loading = ref(true);
const pending = ref(false);
const showRules = ref(false);
const areaId = ref('foothills');
const selectedDisciples = ref<string[]>([]);

const active = computed(() => panel.value?.active ?? null);
/** 一场结束时先把最后的遭遇留在画面上播完结局动画，再切回出发界面。 */
const held = ref<BeastCaptureView | null>(null);
const encounter = computed(() => held.value ?? active.value);
const fx = ref<{ kind: CaptureFxKind; id: number } | null>(null);
const confirmLeave = ref(false);
/** 动画播放或请求进行中都不接受下一次操作。 */
const busy = computed(() => pending.value || held.value !== null);
const area = computed(() => panel.value?.areas.find((item) => item.id === areaId.value) ?? null);
const areaSpecies = computed(() => {
  const current = area.value;
  return current === null ? [] : (panel.value?.species ?? []).filter((item) => current.speciesIds.includes(item.id));
});
const spiritStone = computed(() => Number(props.state.resources.find((item) => item.id === 'spiritStone')?.balance ?? 0));
const caughtCount = computed(() => panel.value?.collection.filter((item) => item.caught > 0).length ?? 0);
const NEED_DISCIPLE = '请选择一名出发弟子';
/** 不能出发的原因（null = 可以出发）。 */
const startBlock = computed<string | null>(() => {
  const p = panel.value;
  const a = area.value;
  if (p === null || a === null) return '正在读取';
  if (!p.unlocked) return `宗门 ${String(p.unlockLevel)} 级开放捕捉`;
  if (!a.unlocked) return `${a.name}需宗门 ${String(a.requiredSectLevel)} 级`;
  if (p.remaining <= 0) return '今日搜寻次数已用完';
  if (p.items.length >= p.capacity) return '灵兽苑已满，请先到灵兽苑放生整理';
  if (spiritStone.value < a.cost) return '灵石不足';
  if (selectedDisciples.value.length === 0) return NEED_DISCIPLE;
  return null;
});
/** 出发栏提示：选人提示交给选人组件自己显示，这里只说费用或其他阻碍。 */
const startHintBlocked = computed(() => startBlock.value !== null && startBlock.value !== NEED_DISCIPLE);
const startHint = computed(() =>
  startHintBlocked.value && startBlock.value !== null
    ? startBlock.value
    : `消耗 ${formatAmount(String(area.value?.cost ?? 0))} 灵石 · 15 回合内削弱并收服`,
);
const minutesLeft = computed(() => {
  const current = encounter.value;
  return current === null ? 0 : Math.max(0, Math.ceil((current.expiresAt - Date.parse(props.state.serverNow)) / 60_000));
});
/** 战报新的在上，只留最近 10 条。 */
const recentLogs = computed(() => (encounter.value?.logs ?? []).slice(-10).reverse());

function collectionOf(speciesId: string) {
  return panel.value?.collection.find((item) => item.speciesId === speciesId);
}
/** 图鉴卡片右上角：收服过几次 / 只遇见过 / 未遇见。 */
function statusOf(speciesId: string): string {
  const entry = collectionOf(speciesId);
  if (entry !== undefined && entry.caught > 0) return `已收服 ×${String(entry.caught)}`;
  if (entry !== undefined && entry.seen > 0) return `遇见 ${String(entry.seen)} 次`;
  return '未遇见';
}
function areaNamesOf(speciesId: string): string {
  return (panel.value?.areas ?? []).filter((item) => item.speciesIds.includes(speciesId)).map((item) => item.name).join('、');
}
function areaNameOf(id: string): string {
  return panel.value?.areas.find((item) => item.id === id)?.name ?? '山野';
}
function percent(value: number, max: number): number {
  return max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
}
function attrsText(attrs: Parameters<typeof beastAttrList>[0]): string {
  return beastAttrList(attrs).map((item) => `${item.label} +${String(item.value)}`).join(' · ');
}

const OUTCOMES: Record<Exclude<BeastCaptureView['status'], 'active'>, { tone: ToastTone; title: string }> = {
  caught: { tone: 'success', title: '收服成功' },
  killed: { tone: 'warning', title: '灵兽被击败' },
  escaped: { tone: 'warning', title: '灵兽逃走了' },
  defeated: { tone: 'warning', title: '弟子败退' },
  left: { tone: 'info', title: '已离开山野' },
  expired: { tone: 'info', title: '遭遇已过期' },
};

/** 一场捕捉结束时的结局提示。 */
function announce(view: BeastCaptureView | null): void {
  if (view === null || view.status === 'active') return;
  const outcome = OUTCOMES[view.status];
  let message = view.logs[view.logs.length - 1] ?? '';
  if (view.status === 'caught' && view.caught !== null) {
    message = `${view.caught.qualityName}${view.species.name}已进入灵兽苑，可在首页「灵兽苑」为弟子携带。`;
  } else if (view.status === 'killed') {
    message = '野生灵兽被击败，无法收服。血量低时改用「留手」更稳妥。';
  } else if (view.status === 'defeated') {
    message = `${view.discipleName}败退，需疗伤 10 分钟；携带的灵兽安全归来。`;
  }
  emit('notify', outcome.tone, outcome.title, message);
}

async function run(action: () => Promise<{ state: SectStateView; beasts: SpiritBeastsPanel }>): Promise<void> {
  if (pending.value) return;
  pending.value = true;
  try {
    const result = await action();
    panel.value = result.beasts;
    emit('state-update', result.state);
  } catch (caught) {
    emit('notify', 'warning', '宠物秘境', caught instanceof Error ? caught.message : '操作失败');
    try {
      panel.value = (await fetchSpiritBeasts()).beasts;
    } catch {
      /* 保留原来的错误提示 */
    }
  } finally {
    pending.value = false;
  }
}

function start(): void {
  const discipleId = selectedDisciples.value[0];
  if (discipleId === undefined || startBlock.value !== null) return;
  void run(() => startBeastCapture(areaId.value, discipleId, crypto.randomUUID()));
}

const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let fxSeq = 0;
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, reducedMotion ? 0 : ms));
}
/** 播放一段特效；ms 后自动收起（cast 由下一段特效接替，不自动收起）。 */
async function playFx(kind: CaptureFxKind, ms: number): Promise<void> {
  if (reducedMotion) return;
  const id = ++fxSeq;
  fx.value = { kind, id };
  if (kind === 'cast') return;
  await wait(ms);
  if (fx.value?.id === id) fx.value = null;
}

/** 结局对应的特效与停留时长；离开、过期直接切走。 */
const ENDING_FX: Partial<Record<BeastCaptureView['status'], { kind: CaptureFxKind; ms: number }>> = {
  caught: { kind: 'caught', ms: 1700 },
  escaped: { kind: 'escaped', ms: 1300 },
  killed: { kind: 'killed', ms: 1300 },
  defeated: { kind: 'defeated', ms: 1100 },
};

async function act(action: BeastCaptureAction): Promise<void> {
  const current = active.value;
  if (current === null || busy.value) return;
  confirmLeave.value = false;
  pending.value = true;
  // 出手的剑光与请求同时开始；御兽阵至少转 0.8 秒再揭晓结果。
  let lead: Promise<void> = Promise.resolve();
  if (action === 'attack' || action === 'restrain') {
    lead = playFx(action, 650);
  } else if (action === 'capture') {
    void playFx('cast', 0);
    lead = wait(800);
  }
  try {
    const [result] = await Promise.all([
      actBeastCapture(current.id, current.version, action, crypto.randomUUID()),
      lead,
    ]);
    emit('state-update', result.state);
    const recent = result.beasts.recent;
    const ending = result.beasts.active === null && recent !== null ? ENDING_FX[recent.status] : undefined;
    if (ending !== undefined && recent !== null) {
      held.value = recent;
      await playFx(ending.kind, ending.ms);
      held.value = null;
    }
    panel.value = result.beasts;
    if (result.beasts.active === null) {
      fx.value = null;
      announce(recent);
    } else if (action === 'capture') {
      await playFx('fail', 650);
    }
  } catch (caught) {
    fx.value = null;
    held.value = null;
    emit('notify', 'warning', '宠物秘境', caught instanceof Error ? caught.message : '操作失败');
    try {
      panel.value = (await fetchSpiritBeasts()).beasts;
    } catch {
      /* 保留原来的错误提示 */
    }
  } finally {
    pending.value = false;
  }
}

onMounted(async () => {
  try {
    panel.value = (await fetchSpiritBeasts()).beasts;
    // 默认停在已开放的最高区域。
    const unlocked = panel.value.areas.filter((item) => item.unlocked);
    areaId.value = unlocked[unlocked.length - 1]?.id ?? areaId.value;
  } catch (caught) {
    emit('notify', 'warning', '宠物秘境', caught instanceof Error ? caught.message : '读取失败');
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="beast-dialog" aria-labelledby="beast-title">
    <div class="beast-head modal-head">
      <h3 id="beast-title" class="beast-title">
        <span>宠物秘境</span>
        <span v-if="panel" class="beast-title-sub">今日搜寻 {{ panel.remaining }}/{{ panel.dailyLimit }}</span>
      </h3>
      <button class="beast-quiet-button" type="button" :aria-expanded="showRules" @click="showRules = !showRules">
        {{ showRules ? '收起说明' : '说明' }}
      </button>
    </div>

    <ul v-if="showRules && panel" class="beast-rules">
      <li v-for="rule in panel.rules" :key="rule">{{ rule }}</li>
    </ul>

    <div class="beast-tabs" role="tablist" aria-label="宠物秘境分区">
      <button
        v-for="item in TABS"
        :id="`beast-tab-${item.id}`"
        :key="item.id"
        class="beast-tab"
        type="button"
        role="tab"
        :aria-selected="tab === item.id"
        :aria-controls="`beast-page-${item.id}`"
        @click="tab = item.id"
      >
        {{ item.label }}
      </button>
    </div>

    <p v-if="!panel" class="beast-empty">{{ loading ? '正在探查山野……' : '暂未读取到灵兽信息，请稍后再试。' }}</p>

    <template v-else>
      <!-- ---------- 野外捕捉 ---------- -->
      <div
        v-show="tab === 'capture'"
        id="beast-page-capture"
        class="beast-page"
        role="tabpanel"
        aria-labelledby="beast-tab-capture"
      >
        <p v-if="!panel.unlocked" class="beast-lock">宗门 {{ panel.unlockLevel }} 级开放捕捉，现在可以先翻看图鉴。</p>

        <!-- 进行中的遭遇 -->
        <article
          v-if="encounter"
          class="encounter"
          :class="{ 'fx-defeated': fx?.kind === 'defeated' }"
          :data-element="encounter.species.element"
        >
          <div class="encounter-hero">
            <div class="encounter-portrait" :class="fx ? `fx-${fx.kind}` : ''">
              <img v-if="encounter.species.image" :src="encounter.species.image" :alt="encounter.species.name" />
              <span v-else>{{ encounter.species.glyph }}</span>
              <BeastCaptureFx v-if="fx" :key="fx.id" :kind="fx.kind" />
            </div>
            <div class="encounter-info">
              <p class="encounter-place">{{ areaNameOf(encounter.areaId) }} · 野生遭遇</p>
              <h4 class="encounter-name">{{ encounter.species.name }}</h4>
              <p class="encounter-chips">
                <span class="beast-chip is-element">{{ encounter.species.elementName }}行</span>
                <span class="beast-chip" :class="`is-tier-${encounter.species.tier}`">{{ encounter.species.tierName }}</span>
                <span class="beast-chip">品质收服后揭晓</span>
              </p>
              <p class="encounter-skill"><b>【{{ encounter.species.skillName }}】</b>{{ encounter.species.skillText }}</p>
            </div>
            <div class="encounter-rate">
              <strong>{{ (encounter.captureRate * 100).toFixed(1) }}<small>%</small></strong>
              <span>当前收服率</span>
            </div>
          </div>

          <div class="encounter-bars">
            <div class="hp-row is-wild">
              <span class="hp-label">{{ encounter.species.name }}</span>
              <span class="hp-track"><span class="hp-fill" :style="{ width: `${percent(encounter.targetHp, encounter.targetMaxHp)}%` }" /></span>
              <span class="hp-num">{{ encounter.targetHp }}/{{ encounter.targetMaxHp }}</span>
            </div>
            <div class="hp-row is-mine">
              <span class="hp-label">{{ encounter.discipleName }}</span>
              <span class="hp-track"><span class="hp-fill" :style="{ width: `${percent(encounter.hp, encounter.maxHp)}%` }" /></span>
              <span class="hp-num">{{ encounter.hp }}/{{ encounter.maxHp }}</span>
            </div>
          </div>

          <p class="encounter-meta">
            <span>回合 {{ encounter.round }}/{{ encounter.maxRounds }}</span>
            <span>收服 {{ encounter.attempts }}/{{ encounter.maxAttempts }}</span>
            <span>{{ minutesLeft }} 分钟后离去</span>
            <span>关闭弹窗不会放弃</span>
          </p>

          <div v-if="confirmLeave" class="encounter-confirm" role="alert">
            <p>确定离开？本次搜寻费用不退，{{ encounter.species.name }}会返回山林。</p>
            <button class="beast-quiet-button" type="button" :disabled="pending" @click="confirmLeave = false">继续捕捉</button>
            <button class="beast-quiet-button is-danger" type="button" :disabled="pending" @click="act('leave')">确认离开</button>
          </div>
          <div v-else class="encounter-actions">
            <button class="encounter-action" type="button" :disabled="busy" @click="act('attack')">
              <strong>攻击</strong><small>全力出手，可能击杀</small>
            </button>
            <button class="encounter-action" type="button" :disabled="busy" @click="act('restrain')">
              <strong>留手</strong><small>削弱但至少留 1 血</small>
            </button>
            <button
              class="encounter-action is-primary"
              type="button"
              :disabled="busy || encounter.attempts >= encounter.maxAttempts"
              @click="act('capture')"
            >
              <strong>御兽术</strong><small>按 {{ (encounter.captureRate * 100).toFixed(1) }}% 尝试收服</small>
            </button>
            <button class="encounter-action is-quiet" type="button" :disabled="busy" @click="confirmLeave = true">
              <strong>离开</strong><small>结束本次搜寻</small>
            </button>
          </div>

          <ol class="encounter-log" aria-label="战况" aria-live="polite">
            <li v-for="(line, index) in recentLogs" :key="`${String(encounter.round)}-${String(index)}`" :class="{ 'is-latest': index === 0 }">
              {{ line }}
            </li>
          </ol>
        </article>

        <!-- 出发前：区域 → 出没灵兽 → 选人 → 出发 -->
        <template v-else>
          <section class="beast-block" aria-labelledby="beast-area-title">
            <h4 id="beast-area-title" class="beast-section-title">选择区域 <small>搜寻次数与普通秘境独立</small></h4>
            <div class="area-grid">
              <button
                v-for="item in panel.areas"
                :key="item.id"
                class="area-card"
                :class="{ 'is-selected': areaId === item.id, 'is-locked': !item.unlocked }"
                type="button"
                :aria-pressed="areaId === item.id"
                @click="areaId = item.id"
              >
                <span class="area-card-head">
                  <strong>{{ item.name }}</strong>
                  <span class="area-cost">{{ formatAmount(String(item.cost)) }} 灵石</span>
                </span>
                <span class="area-desc">{{ item.description }}</span>
                <span class="area-foot">{{ item.unlocked ? `${String(item.speciesIds.length)} 种灵兽出没` : `宗门 ${String(item.requiredSectLevel)} 级开放` }}</span>
              </button>
            </div>
          </section>

          <section v-if="area" class="beast-block" aria-labelledby="beast-habitat-title">
            <h4 id="beast-habitat-title" class="beast-section-title">出没灵兽 <small>{{ area.name }}</small></h4>
            <ul class="habitat-list">
              <li v-for="item in areaSpecies" :key="item.id" class="habitat" :class="`is-${item.tier}`" :data-element="item.element">
                <span class="beast-avatar habitat-avatar">
                  <img v-if="item.avatar" :src="item.avatar" :alt="item.name" width="96" height="96" loading="lazy" decoding="async" />
                  <span v-else>{{ item.glyph }}</span>
                </span>
                <span class="habitat-text">
                  <strong>{{ item.name }}</strong>
                  <span class="habitat-chips">
                    <span class="beast-chip is-element">{{ item.elementName }}</span>
                    <span class="beast-chip" :class="`is-tier-${item.tier}`">{{ item.tierName }}</span>
                  </span>
                </span>
              </li>
            </ul>
          </section>

          <DisciplePicker
            v-model:selected="selectedDisciples"
            :disciples="state.disciples"
            mode="single"
            :min="1"
            :max="1"
            :busy="pending"
            sort="luck"
            title="选择出发弟子（幸运高者更易遇到稀有灵兽）"
          />

          <div class="start-bar">
            <p class="start-hint" :class="{ 'is-blocked': startHintBlocked }">
              {{ startHint }}
            </p>
            <button class="action-button primary-action" type="button" :disabled="pending || startBlock !== null" @click="start">
              {{ pending ? '正在搜寻……' : '进入山野搜寻' }}
            </button>
          </div>
        </template>
      </div>

      <!-- ---------- 灵兽图鉴 ---------- -->
      <div
        v-show="tab === 'catalog'"
        id="beast-page-catalog"
        class="beast-page"
        role="tabpanel"
        aria-labelledby="beast-tab-catalog"
      >
        <h4 class="beast-section-title">
          收服 {{ caughtCount }}/{{ panel.species.length }} 种
          <small>金克木 · 木克土 · 土克水 · 水克火 · 火克金（克制 +15%）</small>
        </h4>
        <ul class="catalog-grid">
          <li
            v-for="item in panel.species"
            :key="item.id"
            class="catalog-card"
            :class="[`is-${item.tier}`, { 'is-caught': (collectionOf(item.id)?.caught ?? 0) > 0 }]"
            :data-element="item.element"
          >
            <span class="catalog-side">
              <span class="beast-avatar catalog-avatar">
                <img v-if="item.avatar" :src="item.avatar" :alt="item.name" width="96" height="96" loading="lazy" decoding="async" />
                <span v-else>{{ item.glyph }}</span>
              </span>
              <span class="catalog-status">{{ statusOf(item.id) }}</span>
            </span>
            <div class="catalog-body">
              <p class="catalog-name">
                <strong>{{ item.name }}</strong>
                <span class="beast-chip is-element">{{ item.elementName }}行</span>
                <span class="beast-chip" :class="`is-tier-${item.tier}`">{{ item.tierName }}</span>
              </p>
              <p class="catalog-skill"><b>【{{ item.skillName }}】</b>{{ item.skillText }}</p>
              <p class="catalog-meta">{{ attrsText(item.attrs) }}（1 级凡品）</p>
              <p class="catalog-meta">出没：{{ areaNamesOf(item.id) }}</p>
            </div>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>

<style scoped>
.beast-dialog {
  display: grid;
  gap: 14px;
}

.beast-page {
  display: grid;
  gap: 16px;
}

.beast-block {
  display: grid;
  gap: 10px;
}

/* ---------- 区域卡片：选中态用边框与底色表达，不依赖 outline（点击后会被全局焦点样式清掉） ---------- */

.area-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.area-card {
  display: grid;
  align-content: start;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  color: var(--ink-text);
  text-align: left;
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease, box-shadow 140ms ease;
}

.area-card:hover {
  border-color: rgba(202, 169, 106, 0.4);
}

.area-card.is-selected {
  border-color: var(--gold);
  background: linear-gradient(180deg, rgba(202, 169, 106, 0.14), rgba(202, 169, 106, 0.04));
  box-shadow: inset 0 0 0 1px rgba(202, 169, 106, 0.45), 0 0 18px rgba(202, 169, 106, 0.12);
}

.area-card.is-locked {
  opacity: 0.55;
}

.area-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
}

.area-card-head strong {
  font-size: 14px;
}

.area-card.is-selected .area-card-head strong {
  color: var(--gold-bright);
}

.area-cost {
  color: var(--gold);
  font-size: 12px;
  white-space: nowrap;
}

.area-desc {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}

.area-foot {
  color: var(--faint);
  font-size: 11px;
}

/* ---------- 出没灵兽 ---------- */

.habitat-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.habitat {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid rgba(var(--el-rgb), 0.22);
  border-radius: 8px;
  background: linear-gradient(90deg, rgba(var(--el-rgb), 0.1), rgba(var(--el-rgb), 0.02));
}

.habitat.is-divine {
  border-color: rgba(235, 196, 124, 0.5);
  box-shadow: 0 0 14px rgba(235, 196, 124, 0.12);
}

.habitat-avatar {
  --beast-avatar-size: 42px;
}

.habitat-text {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.habitat-text strong {
  overflow: hidden;
  color: var(--ink-text);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.habitat-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

/* ---------- 出发栏 ---------- */

.start-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.start-hint {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}

.start-hint.is-blocked {
  color: var(--gold);
}

.start-bar .action-button {
  flex: 0 0 auto;
  min-width: 140px;
}

/* ---------- 遭遇（收服界面） ---------- */

.encounter {
  display: grid;
  gap: 14px;
  padding: 16px;
  border: 1px solid rgba(var(--el-rgb), 0.3);
  border-radius: 10px;
  background:
    radial-gradient(120% 90% at 0% 0%, rgba(var(--el-rgb), 0.14), transparent 60%),
    var(--surface);
}

.encounter-hero {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
}

.encounter-portrait {
  display: grid;
  place-items: center;
  width: 132px;
  height: 132px;
  border: 1px solid rgba(var(--el-rgb), 0.45);
  border-radius: 12px;
  background: radial-gradient(circle at 50% 42%, rgba(var(--el-rgb), 0.28), rgba(6, 16, 15, 0.7) 70%);
  color: var(--el);
  font-family: serif;
  font-size: 54px;
}

.encounter-portrait img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* ---------- 捕捉特效：立绘本身的反应（SVG 叠层见 BeastCaptureFx） ---------- */

.encounter-portrait {
  position: relative;
}

.encounter-portrait.fx-attack img,
.encounter-portrait.fx-restrain img,
.encounter-portrait.fx-fail img {
  animation: fx-shake 360ms ease-in-out 160ms;
}

.encounter-portrait.fx-cast img {
  animation: fx-bound 1.2s ease-in-out infinite;
}

.encounter-portrait.fx-caught img {
  animation: fx-sealed 1.1s ease-in forwards;
}

.encounter-portrait.fx-killed img {
  animation: fx-fall 900ms ease-out 200ms forwards;
}

.encounter-portrait.fx-escaped img {
  animation: fx-flee 900ms ease-in 350ms forwards;
}

.encounter.fx-defeated {
  animation: fx-defeated 1s ease-out;
}

@keyframes fx-shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-7px) rotate(-2deg); }
  45% { transform: translateX(6px) rotate(1.5deg); }
  70% { transform: translateX(-3px); }
}

@keyframes fx-bound {
  0%, 100% { filter: drop-shadow(0 0 0 rgba(230, 195, 122, 0)); }
  50% { filter: drop-shadow(0 0 10px rgba(230, 195, 122, 0.8)); }
}

@keyframes fx-sealed {
  0% { filter: brightness(1); transform: scale(1); }
  45% { filter: brightness(1.8) drop-shadow(0 0 16px rgba(255, 230, 170, 0.9)); transform: scale(1.04); }
  100% { filter: brightness(1.15) sepia(0.35); transform: scale(0.82); opacity: 0.55; }
}

@keyframes fx-fall {
  to { filter: grayscale(1) brightness(0.55); transform: translateY(6px) rotate(-6deg); opacity: 0.6; }
}

@keyframes fx-flee {
  20% { transform: translateX(-8px); }
  to { transform: translateX(150px); opacity: 0; }
}

@keyframes fx-defeated {
  0%, 100% { box-shadow: inset 0 0 0 rgba(224, 123, 104, 0); }
  30% { box-shadow: inset 0 0 48px rgba(224, 123, 104, 0.45); }
}

@media (prefers-reduced-motion: reduce) {
  .encounter-portrait img,
  .encounter {
    animation: none !important;
  }
}

.encounter-confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid rgba(224, 123, 104, 0.4);
  border-radius: 6px;
  background: rgba(224, 123, 104, 0.07);
}

.encounter-confirm p {
  flex: 1 1 220px;
  margin: 0;
  color: #e8c9bf;
  font-size: 12px;
}

.encounter-confirm .is-danger {
  border-color: rgba(224, 123, 104, 0.55);
  background: rgba(224, 123, 104, 0.1);
  color: var(--red-bright);
}

.encounter-info {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.encounter-info p {
  margin: 0;
}

.encounter-place {
  color: var(--faint);
  font-size: 12px;
}

.encounter-name {
  margin: 0;
  color: var(--el);
  font-family: serif;
  font-size: 22px;
  letter-spacing: 0.08em;
}

.encounter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.encounter-skill {
  color: #c7d3cc;
  font-size: 12px;
  line-height: 1.6;
}

.encounter-skill b {
  color: var(--el);
  font-weight: 600;
}

.encounter-rate {
  display: grid;
  justify-items: center;
  gap: 2px;
  min-width: 96px;
  padding: 10px 12px;
  border: 1px solid rgba(202, 169, 106, 0.35);
  border-radius: 10px;
  background: rgba(202, 169, 106, 0.07);
}

.encounter-rate strong {
  color: var(--gold-bright);
  font-size: 26px;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}

.encounter-rate strong small {
  font-size: 13px;
}

.encounter-rate span {
  color: var(--muted);
  font-size: 11px;
}

.encounter-bars {
  display: grid;
  gap: 8px;
}

.hp-row {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.hp-label {
  overflow: hidden;
  color: #c7d3cc;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hp-track {
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
}

.hp-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  transition: width 260ms ease;
}

.is-wild .hp-fill {
  background: linear-gradient(90deg, #a6503f, #e07b68);
}

.is-mine .hp-fill {
  background: linear-gradient(90deg, var(--jade-dark), var(--jade-bright));
}

.hp-num {
  min-width: 96px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.encounter-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin: 0;
  color: var(--faint);
  font-size: 12px;
}

.encounter-actions {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.encounter-action {
  display: grid;
  gap: 2px;
  padding: 9px 8px;
  border: 1px solid rgba(119, 184, 154, 0.24);
  border-radius: 6px;
  background: rgba(119, 184, 154, 0.06);
  color: var(--ink-text);
  text-align: center;
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease, transform 140ms ease;
}

.encounter-action strong {
  font-size: 14px;
  letter-spacing: 0.08em;
}

.encounter-action small {
  color: var(--muted);
  font-size: 11px;
}

.encounter-action:not(:disabled):hover {
  border-color: rgba(166, 213, 185, 0.6);
  background: rgba(119, 184, 154, 0.12);
}

.encounter-action:not(:disabled):active {
  transform: translateY(1px);
}

.encounter-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.encounter-action.is-primary {
  border-color: rgba(202, 169, 106, 0.6);
  background: linear-gradient(180deg, rgba(202, 169, 106, 0.22), rgba(202, 169, 106, 0.08));
}

.encounter-action.is-primary strong {
  color: var(--gold-bright);
}

.encounter-action.is-primary:not(:disabled):hover {
  border-color: var(--gold-bright);
  background: linear-gradient(180deg, rgba(202, 169, 106, 0.3), rgba(202, 169, 106, 0.12));
}

.encounter-action.is-quiet {
  border-color: var(--line);
  background: transparent;
}

.encounter-log {
  display: grid;
  gap: 2px;
  max-height: 190px;
  margin: 0;
  padding: 8px 10px 8px 26px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: rgba(6, 16, 15, 0.45);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}

.encounter-log li.is-latest {
  color: var(--ink-text);
}

/* ---------- 图鉴 ---------- */

.catalog-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.catalog-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-left: 3px solid rgba(var(--el-rgb), 0.55);
  border-radius: 8px;
  background: var(--surface);
}

.catalog-card.is-divine {
  border-color: rgba(235, 196, 124, 0.35);
  border-left-color: rgba(235, 196, 124, 0.8);
}

.catalog-avatar {
  --beast-avatar-size: 56px;
}

.catalog-card:not(.is-caught) .catalog-avatar img {
  filter: grayscale(0.85) brightness(0.75);
}

.catalog-body {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.catalog-body p {
  margin: 0;
}

.catalog-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}

.catalog-name strong {
  margin-right: 2px;
  color: var(--ink-text);
  font-size: 14px;
}

.catalog-side {
  display: grid;
  flex: 0 0 auto;
  justify-items: center;
  gap: 6px;
}

.catalog-status {
  color: var(--faint);
  font-size: 11px;
  white-space: nowrap;
}

.catalog-card.is-caught .catalog-status {
  color: var(--gold);
}

.catalog-skill {
  color: #c7d3cc;
  font-size: 12px;
  line-height: 1.6;
}

.catalog-skill b {
  color: var(--el);
  font-weight: 600;
}

.catalog-meta {
  color: var(--faint);
  font-size: 11px;
  line-height: 1.6;
}

@media (max-width: 640px) {
  .area-grid,
  .catalog-grid {
    grid-template-columns: 1fr;
  }

  .encounter {
    padding: 12px;
  }

  .encounter-hero {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .encounter-portrait {
    width: 92px;
    height: 92px;
    font-size: 40px;
  }

  .encounter-rate {
    grid-column: 1 / -1;
    grid-template-columns: auto auto;
    align-items: baseline;
    justify-content: center;
    gap: 8px;
  }

  .encounter-actions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .hp-row {
    grid-template-columns: 64px minmax(0, 1fr) auto;
  }

  .hp-num {
    min-width: 0;
  }

  .start-bar {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
