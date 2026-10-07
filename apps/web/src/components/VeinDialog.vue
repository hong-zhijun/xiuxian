<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

import type {
  SectStateView,
  VeinActionResponse,
  VeinBattleResultView,
  VeinPanelView,
  VeinView,
} from '../api/game';
import { attackVein, fetchVeins, occupyVein, setVeinGarrison, withdrawVein } from '../api/game';
import { formatAmount } from '../utils/format';
import DisciplePicker from './DisciplePicker.vue';

/**
 * 0042 灵脉争夺面板（docs/灵脉争夺开发计划.md）。
 *
 * 只在「打开时 / 操作后 / 点刷新」请求接口，不轮询；倒计时由前端每 30 秒回算。
 * 能不能进驻 / 抢夺、守军战力、计时全部由服务端算好，这里只渲染与选人。
 */
const props = defineProps<{
  state: SectStateView;
  busy?: boolean;
}>();

const emit = defineEmits<{
  'state-update': [state: SectStateView];
  notify: [tone: 'success' | 'warning', title: string, message: string];
}>();

const panel = ref<VeinPanelView | null>(null);
const loading = ref(false);
const submitting = ref(false);
const showRules = ref(false);
/** 正在选人的操作：进驻 / 抢夺 / 换守军哪一条。 */
const picking = ref<{ veinId: string; mode: 'occupy' | 'attack' | 'garrison' } | null>(null);
const selected = ref<string[]>([]);
const lastBattle = ref<VeinBattleResultView | null>(null);

/* ---------- 倒计时 ---------- */

const nowMs = ref(Date.now());
let clock: number | undefined;

function leftText(until: number): string {
  const minutes = Math.max(0, Math.ceil((until - nowMs.value) / 60_000));
  if (minutes >= 60) return `${String(Math.floor(minutes / 60))} 时 ${String(minutes % 60)} 分`;
  return `${String(minutes)} 分`;
}

/* ---------- 展示 ---------- */

const TIER_ORDER: readonly VeinView['tier'][] = ['eye', 'large', 'small'];
const TIER_COLORS: Record<VeinView['tier'], string> = {
  eye: '#e8b96a',
  large: '#6fb6d9',
  small: '#77b89a',
};

const groups = computed(() =>
  TIER_ORDER.map((tier) => ({
    tier,
    veins: (panel.value?.veins ?? []).filter((vein) => vein.tier === tier),
  })).filter((group) => group.veins.length > 0),
);

const myVein = computed(() => panel.value?.veins.find((vein) => vein.id === panel.value?.myVeinId) ?? null);

function perHour(vein: VeinView): string {
  return `+${formatAmount(vein.ratePerHour)} / 时`;
}

function formatPower(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function timerLine(vein: VeinView): string {
  const parts: string[] = [];
  if (vein.protectedUntil !== null && vein.protectedUntil > nowMs.value) parts.push(`保护期剩 ${leftText(vein.protectedUntil)}`);
  if (vein.holder !== null && vein.exhaustsAt !== null) parts.push(`${leftText(vein.exhaustsAt)}后枯竭`);
  if (vein.cooldownUntil !== null && vein.cooldownUntil > nowMs.value) parts.push(`你的冷却剩 ${leftText(vein.cooldownUntil)}`);
  return parts.join(' · ');
}

const pickingVein = computed(() => panel.value?.veins.find((vein) => vein.id === picking.value?.veinId) ?? null);

const pickingTitle = computed(() => {
  const vein = pickingVein.value;
  const mode = picking.value?.mode;
  if (vein === null || mode === undefined) return '';
  if (mode === 'occupy') return `进驻「${vein.name}」：选 3 名守军`;
  if (mode === 'attack') return `抢夺「${vein.name}」：选 3 名出战弟子（按顺序对阵守军）`;
  return `更换「${vein.name}」的守军`;
});

/** 抢夺时逐回合的战力对照（守方含 +10%）。 */
const matchups = computed(() => {
  const vein = pickingVein.value;
  if (vein === null || picking.value?.mode !== 'attack') return [];
  const bonus = 1 + (panel.value?.defenderBonusPercent ?? 10) / 100;
  return selected.value.map((id, index) => {
    const mine = props.state.disciples.find((disciple) => disciple.id === id);
    const guard = vein.garrison[index];
    return {
      round: index + 1,
      mine: mine === undefined ? '—' : `${mine.name} ${formatPower(mine.combatPower)}`,
      theirs:
        guard === undefined || guard.absent
          ? '缺席（直接胜）'
          : `${guard.name} ${formatPower(guard.power * bonus)}`,
    };
  });
});

const confirmText = computed(() => {
  const mode = picking.value?.mode;
  if (mode === 'occupy') return '进驻';
  if (mode === 'attack') return `出战抢夺（今日还剩 ${String(panel.value?.attacksLeft ?? 0)} 次）`;
  return '换上守军';
});

/* ---------- 请求 ---------- */

const disabled = computed(() => submitting.value || props.busy === true);

async function refresh(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const data = await fetchVeins();
    emit('state-update', data.state);
    panel.value = data.veins;
    nowMs.value = Date.now();
  } catch (error) {
    emit('notify', 'warning', '灵脉', error instanceof Error ? error.message : '面板加载失败');
  } finally {
    loading.value = false;
  }
}

async function run(action: () => Promise<VeinActionResponse>): Promise<boolean> {
  if (disabled.value) return false;
  submitting.value = true;
  try {
    const data = await action();
    emit('state-update', data.state);
    panel.value = data.veins;
    nowMs.value = Date.now();
    if (data.result.battle !== null) lastBattle.value = data.result.battle;
    const lost = data.result.battle !== null && !data.result.battle.won;
    emit('notify', lost ? 'warning' : 'success', '灵脉', data.result.message);
    return true;
  } catch (error) {
    emit('notify', 'warning', '灵脉', error instanceof Error ? error.message : '操作失败，请稍后再试');
    void refresh();
    return false;
  } finally {
    submitting.value = false;
  }
}

function startPicking(vein: VeinView, mode: 'occupy' | 'attack' | 'garrison'): void {
  picking.value = { veinId: vein.id, mode };
  selected.value = mode === 'garrison' ? vein.garrison.map((member) => member.discipleId) : [];
  lastBattle.value = null;
}

/** 「去夺回」：跳到那条灵脉的抢夺选人。 */
function retake(veinId: string): void {
  const vein = panel.value?.veins.find((item) => item.id === veinId);
  if (vein === undefined) return;
  if (vein.action !== 'attack') {
    emit('notify', 'warning', '灵脉', vein.blockedReason ?? '现在还不能抢这一条');
    return;
  }
  startPicking(vein, 'attack');
}

async function confirmPick(): Promise<void> {
  const target = picking.value;
  if (target === null || selected.value.length !== (panel.value?.partySize ?? 3)) return;
  const ids = [...selected.value];
  const action =
    target.mode === 'occupy'
      ? () => occupyVein(target.veinId, ids)
      : target.mode === 'attack'
        ? () => attackVein(target.veinId, ids)
        : () => setVeinGarrison(target.veinId, ids);
  const ok = await run(action);
  if (ok) {
    picking.value = null;
    selected.value = [];
  }
}

function onWithdraw(vein: VeinView): void {
  if (!window.confirm(`撤离「${vein.name}」？撤离后灵脉变为无主，别人可以直接进驻。`)) return;
  void run(() => withdrawVein(vein.id));
}

function timeText(ms: number): string {
  const shifted = new Date(ms + 8 * 3_600_000);
  return `${String(shifted.getUTCMonth() + 1)}-${String(shifted.getUTCDate())} ${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`;
}

const RULES_TEXT = `灵脉争夺 · 规则

开放：宗门 3 级。全服 10 条灵脉 —— 小灵脉 6 条（宗门 3 级，+25 灵气/时，不限时）、
      大灵脉 3 条（宗门 6 级，+40/时，连续最多占 48 小时）、灵眼 1 条（宗门 9 级，+60/时，连续最多占 24 小时）。
      产出固定，不受聚灵阵加成；每 10 分钟结算一次，进灵气余额，不超过容量。
占领：每个宗门同时只能占 1 条，占新的一条时原来那条自动让出。无主灵脉派 3 名弟子直接进驻，不算抢夺次数。
驻守：没有代价 —— 守军照常产出、修炼、历练，随时可以换人或撤离。
抢夺：派 3 人按顺序对阵守军，三局两胜；每回合双方战力各浮动 ±15%，守方再 +10%。
      守军已离宗或重伤卧床的那一回合直接判你胜。赢了灵脉归你，原守军撤回不受伤；
      输了出战弟子各有 30% 概率受伤（疗伤 30 分钟）。每天最多抢 5 次。
      不能抢宗门等级比你低 3 级及以上的宗门；进驻 / 易主后 1 小时保护期。
枯竭：大灵脉 / 灵眼被同一宗门连续占满上限后灵气枯竭，守军撤回、灵脉无主，原占领者 24 小时内不能再占这一条。
      被抢走再抢回，连续占领时间重新算。`;

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
  <section class="vein-panel" aria-labelledby="vein-title">
    <div class="vein-head">
      <h3 id="vein-title" class="vein-title">灵脉争夺</h3>
      <div class="vein-head-actions">
        <button class="vein-quiet-button" type="button" @click="showRules = !showRules">
          {{ showRules ? '收起说明' : '说明' }}
        </button>
        <button class="vein-quiet-button" type="button" :disabled="loading" @click="refresh">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </div>

    <p v-if="showRules" class="vein-rules">{{ RULES_TEXT }}</p>

    <p v-else-if="panel === null" class="vein-empty">{{ loading ? '灵脉加载中…' : '面板加载失败，请点刷新。' }}</p>

    <template v-else>
      <p v-if="!panel.unlocked" class="vein-locked">宗门 {{ panel.unlockSectLevel }} 级开放灵脉争夺，下面可以先看看各灵脉的归属。</p>

      <p class="vein-record">
        <span class="vein-label">今日抢夺</span>
        <strong :class="{ 'is-out': panel.attacksLeft <= 0 }">{{ panel.attacksUsed }} / {{ panel.dailyAttacks }}</strong>
        <span class="vein-label">我的灵脉</span>
        <strong>{{ myVein ? `${myVein.name}（${perHour(myVein)}）` : '无' }}</strong>
        <span class="vein-label">累计获得</span>
        <strong>{{ formatAmount(panel.harvested) }} 灵气</strong>
      </p>

      <!-- 选人：进驻 / 抢夺 / 换守军 -->
      <section v-if="picking && pickingVein" class="vein-picking">
        <p class="vein-picking-title">{{ pickingTitle }}</p>
        <ul v-if="picking.mode === 'attack' && matchups.length > 0" class="vein-matchups">
          <li v-for="item in matchups" :key="item.round">
            第 {{ item.round }} 回合：{{ item.mine }} <span class="vein-vs">对</span> {{ item.theirs }}
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
          :title="`选择 ${panel.partySize} 名弟子（点选顺序即出场顺序）`"
        />
        <div class="vein-picking-actions">
          <button class="vein-action" type="button" :disabled="disabled" @click="picking = null">取消</button>
          <button
            class="vein-action is-primary"
            type="button"
            :disabled="disabled || selected.length !== panel.partySize"
            @click="confirmPick"
          >
            {{ submitting ? '处理中…' : confirmText }}
          </button>
        </div>
      </section>

      <!-- 上一场抢夺 -->
      <div v-if="lastBattle" class="vein-result" :class="lastBattle.won ? 'is-won' : 'is-lost'">
        <p class="vein-result-title">
          {{ lastBattle.won ? '抢夺成功' : '抢夺失败' }} · {{ lastBattle.veinName }}（守方 {{ lastBattle.defenderName }}）
        </p>
        <p v-for="round in lastBattle.rounds" :key="round.round" class="vein-result-line">
          第 {{ round.round }} 回合：{{ round.attackerName }} {{ formatPower(round.attackerPower) }} 对
          {{ round.defenderName === null ? '守军缺席' : `${round.defenderName} ${formatPower(round.defenderPower ?? 0)}` }}
          → {{ round.winner === 'attacker' ? '胜' : '负' }}
        </p>
        <p v-if="lastBattle.injured.length > 0" class="vein-result-line is-warn">受伤：{{ lastBattle.injured.join('、') }}（疗伤 30 分钟）</p>
      </div>

      <!-- 灵脉列表 -->
      <section v-for="group in groups" :key="group.tier" class="vein-group">
        <h4 class="vein-group-title" :style="{ color: TIER_COLORS[group.tier] }">
          {{ group.veins[0]?.tierName }}
          <small>
            宗门 {{ group.veins[0]?.minSectLevel }} 级 · {{ group.veins[0] ? perHour(group.veins[0]) : '' }}
            <template v-if="group.veins[0]?.holdLimitHours"> · 连续最多 {{ group.veins[0]?.holdLimitHours }} 小时</template>
          </small>
        </h4>
        <ul class="vein-list">
          <li
            v-for="vein in group.veins"
            :key="vein.id"
            class="vein-card"
            :class="{ 'is-mine': vein.holder?.isMe }"
            :style="{ '--vein-color': TIER_COLORS[vein.tier] }"
          >
            <div class="vein-card-main">
              <p class="vein-name">
                <strong>{{ vein.name }}</strong>
                <span v-if="vein.holder?.isMe" class="vein-tag is-mine">我的</span>
              </p>
              <p v-if="vein.holder === null" class="vein-sub">无主</p>
              <template v-else>
                <p class="vein-sub">
                  {{ vein.holder.name }}（宗门 {{ vein.holder.level }} 级）· 守军战力 {{ formatPower(vein.garrisonPower) }}
                </p>
                <p class="vein-sub vein-garrison">
                  <span v-for="member in vein.garrison" :key="member.discipleId" :class="{ 'is-absent': member.absent }">
                    {{ member.name }}<template v-if="member.realmName"> · {{ member.realmName }}</template>
                  </span>
                </p>
              </template>
              <p v-if="timerLine(vein)" class="vein-sub vein-timer">{{ timerLine(vein) }}</p>
            </div>
            <div class="vein-card-actions">
              <template v-if="vein.action === 'mine'">
                <button class="vein-action" type="button" :disabled="disabled" @click="startPicking(vein, 'garrison')">
                  换守军
                </button>
                <button class="vein-action" type="button" :disabled="disabled" @click="onWithdraw(vein)">撤离</button>
              </template>
              <button
                v-else-if="vein.action === 'occupy'"
                class="vein-action is-primary"
                type="button"
                :disabled="disabled"
                @click="startPicking(vein, 'occupy')"
              >
                进驻
              </button>
              <button
                v-else-if="vein.action === 'attack'"
                class="vein-action is-primary"
                type="button"
                :disabled="disabled"
                @click="startPicking(vein, 'attack')"
              >
                抢夺
              </button>
              <span v-else-if="vein.blockedReason" class="vein-blocked">{{ vein.blockedReason }}</span>
            </div>
          </li>
        </ul>
      </section>

      <!-- 最近战报 -->
      <section class="vein-group">
        <h4 class="vein-group-title">最近战报</h4>
        <p v-if="panel.battles.length === 0" class="vein-empty">还没有人抢过灵脉。</p>
        <ul v-else class="vein-battles">
          <li v-for="battle in panel.battles" :key="battle.id" class="vein-battle" :class="{ 'is-mine': battle.iAttacked || battle.iDefended }">
            <span class="vein-battle-time">{{ timeText(battle.createdAt) }}</span>
            <span>
              {{ battle.attackerName }} {{ battle.won ? '夺下' : '进攻' }}「{{ battle.veinName }}」{{ battle.won ? '' : '未果' }}（守方
              {{ battle.defenderName }}）
            </span>
            <button v-if="battle.canRetake" class="vein-action is-primary" type="button" :disabled="disabled" @click="retake(battle.veinId)">
              去夺回
            </button>
          </li>
        </ul>
      </section>
    </template>
  </section>
</template>

<style scoped>
.vein-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.vein-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.vein-title {
  margin: 0;
  color: var(--gold-bright, #ead19a);
  font-size: 16px;
  font-weight: 600;
}

.vein-head-actions {
  display: flex;
  gap: 8px;
}

.vein-quiet-button {
  padding: 2px 10px;
  border: 1px solid rgba(202, 169, 106, 0.4);
  border-radius: 2px;
  background: rgba(202, 169, 106, 0.08);
  color: var(--gold, #caa96a);
  font-size: 12px;
  cursor: pointer;
}

.vein-quiet-button:disabled {
  color: #63756c;
  cursor: not-allowed;
}

.vein-rules {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-radius: 3px;
  color: #c8d6ce;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
}

.vein-empty {
  margin: 0;
  color: #6d8078;
  font-size: 12px;
}

.vein-locked {
  margin: 0;
  padding: 6px 10px;
  border: 1px solid rgba(217, 138, 74, 0.4);
  border-radius: 3px;
  background: rgba(217, 138, 74, 0.08);
  color: #d9b06a;
  font-size: 12px;
}

.vein-record {
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

.vein-label {
  color: #8fa79b;
}

.vein-record strong {
  color: var(--gold-bright, #ead19a);
}

.vein-record strong.is-out {
  color: #e06a5f;
}

.vein-picking {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid rgba(119, 184, 154, 0.4);
  border-radius: 3px;
  background: rgba(119, 184, 154, 0.05);
}

.vein-picking-title {
  margin: 0;
  color: var(--gold-bright, #ead19a);
  font-size: 13px;
}

.vein-matchups {
  margin: 0;
  padding: 0;
  list-style: none;
  color: #c8d6ce;
  font-size: 12px;
  line-height: 1.7;
}

.vein-vs {
  color: #7d9186;
}

.vein-picking-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.vein-result {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 10px;
  border: 1px solid rgba(119, 184, 154, 0.3);
  border-radius: 3px;
  background: rgba(119, 184, 154, 0.06);
}

.vein-result.is-lost {
  border-color: rgba(224, 106, 95, 0.32);
  background: rgba(224, 106, 95, 0.06);
}

.vein-result-title {
  margin: 0;
  color: var(--gold-bright, #ead19a);
  font-size: 13px;
  font-weight: 600;
}

.vein-result.is-lost .vein-result-title {
  color: #e8806c;
}

.vein-result-line {
  margin: 0;
  color: #cbd8d0;
  font-size: 12px;
  line-height: 1.6;
}

.vein-result-line.is-warn {
  color: #d9b06a;
}

.vein-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.vein-group-title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  color: #8fa79b;
  font-size: 13px;
  font-weight: 600;
}

.vein-group-title small {
  color: #7d9186;
  font-size: 11px;
  font-weight: 400;
}

.vein-list,
.vein-battles {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.vein-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-left: 3px solid var(--vein-color, #77b89a);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.014);
}

.vein-card.is-mine {
  border-color: rgba(119, 184, 154, 0.5);
  border-left-color: var(--vein-color, #77b89a);
  background: rgba(119, 184, 154, 0.07);
}

.vein-card-main {
  min-width: 0;
}

.vein-name {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 13px;
}

.vein-name strong {
  color: var(--vein-color, #77b89a);
}

.vein-tag {
  padding: 0 6px;
  border-radius: 20px;
  font-size: 11px;
}

.vein-tag.is-mine {
  background: rgba(119, 184, 154, 0.16);
  color: var(--jade-bright, #77b89a);
}

.vein-sub {
  margin: 2px 0 0;
  overflow: hidden;
  color: #8fa79b;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vein-garrison span + span::before {
  content: '、';
}

.vein-garrison .is-absent {
  color: #5f6f68;
  text-decoration: line-through;
}

.vein-timer {
  color: #d9b06a;
}

.vein-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.vein-blocked {
  color: #6d8078;
  font-size: 11px;
  text-align: right;
}

.vein-action {
  padding: 4px 10px;
  border: 1px solid rgba(202, 169, 106, 0.4);
  border-radius: 3px;
  background: rgba(202, 169, 106, 0.08);
  color: var(--gold, #caa96a);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}

.vein-action.is-primary {
  border-color: rgba(234, 209, 154, 0.6);
  background: rgba(202, 169, 106, 0.18);
  color: var(--gold-bright, #ead19a);
}

.vein-action:disabled {
  color: #63756c;
  cursor: not-allowed;
}

.vein-battle {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  color: #a9bcb2;
  font-size: 12px;
  line-height: 1.6;
}

.vein-battle.is-mine {
  color: #dce6e0;
}

.vein-battle-time {
  color: #6d8078;
}

/* 窄屏：操作按钮另起一行靠右。 */
@media (max-width: 520px) {
  .vein-card {
    grid-template-columns: minmax(0, 1fr);
  }

  .vein-card-actions {
    justify-content: flex-end;
  }
}
</style>
