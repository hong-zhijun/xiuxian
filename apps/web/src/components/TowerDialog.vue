<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import type { SectStateView, TowerChallengeResultView, TowerRoundView, TowerView } from '../api/game';
import { challengeTower, fetchTower, sweepTower } from '../api/game';
import { formatAmount } from '../utils/format';
import { selectionBlockReason } from '../utils/discipleFilter';
import DisciplePicker from './DisciplePicker.vue';

/**
 * 0039 镇妖塔面板（docs/镇妖塔开发计划.md）。
 *
 * 只在「打开时 / 挑战后 / 扫荡后 / 点刷新」请求接口，不轮询；
 * 层数、妖物、奖励、次数、排行全部由服务端算好下发，这里只渲染。
 */
const props = defineProps<{
  state: SectStateView;
  busy?: boolean;
}>();

const emit = defineEmits<{
  'state-update': [state: SectStateView];
  notify: [tone: 'success' | 'warning', title: string, message: string];
  /** 首通拿到装备后通知上层刷新背包。 */
  'equipment-changed': [];
}>();

const panel = ref<TowerView | null>(null);
const loading = ref(false);
const submitting = ref(false);
const selected = ref<string[]>([]);
const showRules = ref(false);
const showRanks = ref(false);
const showAffixTip = ref(false);
/** 最近一场战斗（常驻到下一场 / 关掉弹窗）。 */
const lastBattle = ref<TowerChallengeResultView | null>(null);
const showLog = ref(false);

function toggleRules(): void {
  showRules.value = !showRules.value;
  if (showRules.value) showRanks.value = false;
}

function toggleRanks(): void {
  showRanks.value = !showRanks.value;
  if (showRanks.value) showRules.value = false;
}

const monster = computed(() => panel.value?.monster ?? null);

/** 词缀标签颜色（与讨伐同一套色调）。 */
const AFFIX_COLORS: Record<string, string> = {
  ironWall: '#d98a4a',
  gale: '#6fb6d9',
  poison: '#7fbf6a',
  aegis: '#a98ad9',
  berserk: '#d9534f',
};

const affixColor = computed(() => AFFIX_COLORS[monster.value?.affix?.id ?? ''] ?? '#8fa79b');

/** 印章颜色：首领层偏红，普通层用玉色。 */
const sealColor = computed(() => (monster.value?.isBoss ? '#c85a48' : '#6f9c86'));

function formatNumber(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '0';
}

function resourceName(resourceId: string): string {
  return props.state.resources.find((resource) => resource.id === resourceId)?.name ?? resourceId;
}

/** 奖励一行：「灵石 120 · 药材 60 · 玄铁 3」（到账为 0 的写「已满」）。 */
function rewardText(reward: Record<string, number>, showFull = false): string {
  const parts = Object.entries(reward).map(([resourceId, amount]) =>
    showFull && amount <= 0 ? `${resourceName(resourceId)} 已满` : `${resourceName(resourceId)} ${formatAmount(amount)}`,
  );
  return parts.length === 0 ? '无' : parts.join(' · ');
}

/* ---------- 队伍强度参考 ---------- */

const selectedDisciples = computed(() =>
  selected.value
    .map((id) => props.state.disciples.find((disciple) => disciple.id === id))
    .filter((disciple): disciple is NonNullable<typeof disciple> => disciple !== undefined),
);

/** 已选弟子平均战力 / 本层标准战力（百分比）；没选人为 null。 */
const strengthPercent = computed<number | null>(() => {
  const current = monster.value;
  const picked = selectedDisciples.value;
  if (current === null || picked.length === 0 || current.standardPower <= 0) return null;
  const average = picked.reduce((sum, disciple) => sum + disciple.combatPower, 0) / picked.length;
  return Math.round((average / current.standardPower) * 100);
});

/** 强度提示：首领层大约要标准的 110% 才稳，普通层 100%。 */
const strengthTone = computed(() => {
  const percent = strengthPercent.value;
  if (percent === null) return '';
  const target = monster.value?.isBoss ? 110 : 100;
  if (percent >= target) return 'is-good';
  if (percent >= target - 10) return 'is-close';
  return 'is-weak';
});

/* ---------- 一键选人 ---------- */

/**
 * 挑 5 名能出战的弟子：按战力排序；有词缀时，对策属性（含装备）每点再加 0.5% 权重。
 * 只是推荐，服务端照样按真实属性算。
 */
function autoPick(): void {
  const attribute = monster.value?.affix?.sortAttribute;
  const now = Date.now();
  const score = (disciple: (typeof props.state.disciples)[number]): number => {
    if (attribute === undefined) return disciple.combatPower;
    const value = disciple[attribute] + (disciple.gear?.[attribute] ?? 0);
    return disciple.combatPower * (1 + value * 0.005);
  };
  selected.value = props.state.disciples
    .filter(
      (disciple) =>
        selectionBlockReason(disciple, now, { blockInjured: true, blockAway: true, blockSteward: true }) === null,
    )
    .sort((a, b) => score(b) - score(a))
    .slice(0, panel.value?.partySize ?? 5)
    .map((disciple) => disciple.id);
}

/* ---------- 请求 ---------- */

const partySize = computed(() => panel.value?.partySize ?? 5);

/** 下一层首通有装备、背包却满了：先提示，挑战按钮不可点（服务端同样会拒绝）。 */
const bagBlocked = computed(
  () =>
    panel.value !== null &&
    panel.value.clearEquipment !== null &&
    panel.value.bagCount >= panel.value.bagCapacity,
);

const canChallenge = computed(
  () =>
    panel.value !== null &&
    panel.value.unlocked &&
    panel.value.failsLeft > 0 &&
    !bagBlocked.value &&
    selected.value.length === partySize.value &&
    !submitting.value &&
    props.busy !== true,
);

const challengeButtonText = computed(() => {
  const current = panel.value;
  if (current === null) return '加载中…';
  if (!current.unlocked) return `宗门 ${String(current.unlockSectLevel)} 级解锁`;
  if (current.failsLeft <= 0) return '今日失败次数已用完';
  if (bagBlocked.value) return '背包已满，先分解装备再来';
  return `挑战第 ${String(current.nextFloor)} 层（已选 ${String(selected.value.length)} / ${String(partySize.value)}）`;
});

const canSweep = computed(
  () =>
    panel.value !== null &&
    panel.value.unlocked &&
    panel.value.maxFloor > 0 &&
    !panel.value.sweptToday &&
    !submitting.value &&
    props.busy !== true,
);

async function refresh(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const data = await fetchTower();
    emit('state-update', data.state);
    panel.value = data.tower;
  } catch (error) {
    emit('notify', 'warning', '镇妖塔', error instanceof Error ? error.message : '面板加载失败');
  } finally {
    loading.value = false;
  }
}

async function submit(): Promise<void> {
  if (!canChallenge.value) return;
  submitting.value = true;
  try {
    const data = await challengeTower(selected.value);
    emit('state-update', data.state);
    panel.value = data.tower;
    lastBattle.value = data.result;
    showLog.value = false;
    if (data.result.equipment !== null) emit('equipment-changed');
    emit('notify', data.result.won ? 'success' : 'warning', '镇妖塔', data.result.message);
  } catch (error) {
    emit('notify', 'warning', '镇妖塔', error instanceof Error ? error.message : '挑战失败，请稍后再试');
  } finally {
    submitting.value = false;
  }
}

async function sweep(): Promise<void> {
  if (!canSweep.value) return;
  submitting.value = true;
  try {
    const data = await sweepTower();
    emit('state-update', data.state);
    panel.value = data.tower;
    emit('notify', 'success', '镇妖塔', data.result.message);
  } catch (error) {
    emit('notify', 'warning', '镇妖塔', error instanceof Error ? error.message : '扫荡失败，请稍后再试');
  } finally {
    submitting.value = false;
  }
}

/* ---------- 战报 ---------- */

/** 战报一行：先手 / 剧毒 / 每次出手 / 妖物反击 / 双方剩余血量。 */
function roundLine(round: TowerRoundView, monsterName: string): string {
  const parts: string[] = [];
  if (round.poisonDamage > 0) parts.push(`剧毒 −${formatNumber(round.poisonDamage)}`);
  const hits = round.hits
    .map((hit) => `${hit.name}${hit.extra ? '追击' : ''} ${formatNumber(hit.damage)}${hit.crit ? '（暴击）' : ''}`)
    .join('、');
  const strike = round.monsterDamage > 0 ? `${monsterName}反击 −${formatNumber(round.monsterDamage)}` : '';
  const ordered = round.teamFirst ? [hits, strike] : [strike, hits];
  parts.push(...ordered.filter((text) => text !== ''));
  parts.push(`妖物 ${formatNumber(round.monsterHp)} / 队伍 ${formatNumber(round.teamHp)}`);
  return `第 ${String(round.round)} 回合：${parts.join(' · ')}`;
}

const battleSummary = computed(() => {
  const battle = lastBattle.value;
  if (battle === null) return '';
  const totalDamage = battle.rounds.reduce(
    (sum, round) => sum + round.hits.reduce((acc, hit) => acc + hit.damage, 0),
    0,
  );
  const crits = battle.rounds.reduce((sum, round) => sum + round.hits.filter((hit) => hit.crit).length, 0);
  const extras = battle.rounds.reduce((sum, round) => sum + round.hits.filter((hit) => hit.extra).length, 0);
  const vigor = battle.vigor >= 1.05 ? '妖物状态正盛' : battle.vigor <= 0.95 ? '妖物状态不佳' : '妖物状态平平';
  return `${battle.teamFirst ? '我方先手' : '妖物先手'} · ${vigor} · 共 ${String(battle.rounds.length)} 回合 · 总伤害 ${formatNumber(totalDamage)}（${formatNumber(battle.monsterMaxHp)}）· 暴击 ${String(crits)} 次 · 追击 ${String(extras)} 次`;
});

const RULES_TEXT = `镇妖塔 · 玩法说明

挑战：宗门 2 级解锁，每次派 5 名弟子挑战「历史最高层 + 1」；层数只增不减，不能跳层。
次数：打赢不扣次数，打输扣 1 次；每天 5 次失败机会（0 点重置）。打输没有其它惩罚，不受伤、不扣资源。
出战：在外历练 / 疗伤中 / 重伤卧床 / 任执事的弟子不能上场。
层数：每 3 层对应一个境界小阶段（第 1 层 = 炼气一层，第 79 层 = 渡劫后期），之后每层再强 2%；
      「标准战力」= 本层标准弟子的战力，5 名这个战力的弟子普通层基本能过。
首领：每 10 层一个首领层，血量与攻击更高，大约要标准的 110% 才稳。
词缀：每 5 层一个 —— 铁壁（攻击低于本层标准的弟子伤害减半）、疾风（妖物身法 ×1.5）、
      剧毒（每回合开始损失 2.5% 最大血量）、罡气（未暴击的伤害 ×0.75，暴击率翻倍）、狂暴（妖物攻击 ×1.2）。
战斗：最多 10 回合，当场算完；每场妖物状态随机（血量与攻击 ±10%）。
      攻击：伤害越高；防御：受到的伤害越低；体魄：队伍血量越厚；
      身法：队伍平均身法不低于妖物时每回合先手，高出妖物越多越容易追击（多出手一次，最高 30%）；
      幸运：暴击率（幸运 100 → 20%），暴击伤害 ×1.5。
      战力计入装备与战意；会心暴击时额外加伤；铁骨按 5 人平均减少承伤；演武场加伤害。
      妖物打死 → 胜；队伍血量打空或 10 回合没打死 → 败。
奖励：每层第一次打过发通关奖励（灵石 / 药材 / 矿石，首领层 ×3；第 30 层起的首领层另给玄铁、神木）；
      每 30 层另送一件装备（第 30 层灵品、第 60 层宝品、第 90 层起仙品，部位随机）——背包满时不能挑战这些层。
扫荡：每天可扫荡一次，按此刻的最高层发灵石 / 药材 / 矿石，最高层 ≥30 另给玄铁、神木；当天不领作废。
      所有奖励入账都不超过资源容量，溢出作废。`;

/** 点了别处就收掉词缀气泡。 */
function onPanelClick(): void {
  showAffixTip.value = false;
}

onMounted(() => {
  void refresh();
});
</script>

<template>
  <section class="tower-panel" aria-labelledby="tower-title" @click="onPanelClick">
    <div class="tower-head modal-head">
      <h3 id="tower-title" class="tower-title">
        <span>镇妖塔</span>
        <span v-if="panel" class="tower-sub">最高第 {{ panel.maxFloor }} 层</span>
      </h3>
      <div class="tower-head-actions">
        <button class="tower-quiet-button" type="button" @click.stop="toggleRanks">
          {{ showRanks ? '收起排行' : '排行' }}
        </button>
        <button class="tower-quiet-button" type="button" @click.stop="toggleRules">
          {{ showRules ? '收起说明' : '说明' }}
        </button>
        <button class="tower-quiet-button" type="button" :disabled="loading" @click.stop="refresh">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </div>

    <div v-if="showRules" class="tower-box">
      <p class="tower-rules-text">{{ RULES_TEXT }}</p>
    </div>

    <div v-else-if="showRanks" class="tower-box">
      <p class="tower-box-title">
        全服排行（按最高层，同层先到者在前）
        <span v-if="panel?.myRank">· 我的名次 第 {{ panel.myRank }} 名</span>
        <span v-else>· 我还未上榜</span>
      </p>
      <p v-if="panel === null || panel.ranks.length === 0" class="tower-empty">还没有宗门闯过第 1 层。</p>
      <ul v-else class="tower-ranks">
        <li v-for="rank in panel.ranks" :key="rank.sectId" class="tower-rank" :class="{ 'is-me': rank.isMe }">
          <span class="tower-rank-no">{{ rank.rank }}</span>
          <strong class="tower-rank-name">{{ rank.sectName }}</strong>
          <span class="tower-rank-floor">第 {{ rank.maxFloor }} 层</span>
        </li>
      </ul>
    </div>

    <p v-else-if="panel === null" class="tower-empty">{{ loading ? '镇妖塔加载中…' : '面板加载失败，请点刷新。' }}</p>

    <template v-else>
      <p v-if="!panel.unlocked" class="tower-locked">
        宗门 {{ panel.unlockSectLevel }} 级解锁镇妖塔。下面可以先看看第 1 层的守关妖物。
      </p>

      <!-- 战绩：最高层 / 名次 / 今日失败机会 -->
      <p class="tower-record">
        <span class="tower-record-label">最高</span>
        <strong class="tower-record-value">第 {{ panel.maxFloor }} 层</strong>
        <span class="tower-record-label">名次</span>
        <strong class="tower-record-value">{{ panel.myRank === null ? '未上榜' : `第 ${panel.myRank} 名` }}</strong>
        <span class="tower-record-label">今日失败机会</span>
        <strong class="tower-record-value" :class="{ 'is-out': panel.failsLeft <= 0 }">
          {{ panel.failsLeft }} / {{ panel.dailyFails }}
        </strong>
      </p>

      <!-- 守关妖物 -->
      <div v-if="monster" class="tower-stage">
        <svg class="tower-seal" :style="{ '--seal-color': sealColor }" viewBox="0 0 120 120" aria-hidden="true">
          <circle class="tower-seal-ring" cx="60" cy="60" r="54" />
          <circle class="tower-seal-face" cx="60" cy="60" r="44" />
          <text class="tower-seal-floor" x="60" y="54" text-anchor="middle" dominant-baseline="middle">
            {{ monster.floor }}
          </text>
          <text class="tower-seal-unit" x="60" y="82" text-anchor="middle" dominant-baseline="middle">层</text>
        </svg>

        <div class="tower-info">
          <p class="tower-name">
            <span>第 {{ monster.floor }} 层 · {{ monster.name }}</span>
            <span v-if="monster.isBoss" class="tower-tag is-boss">首领</span>
            <span
              v-if="monster.affix"
              class="tower-affix"
              :style="{ borderColor: affixColor, color: affixColor }"
              role="button"
              tabindex="0"
              :aria-expanded="showAffixTip"
              @click.stop="showAffixTip = !showAffixTip"
              @keydown.enter.stop="showAffixTip = !showAffixTip"
            >
              {{ monster.affix.name }}
            </span>
          </p>
          <p v-if="monster.affix && showAffixTip" class="tower-affix-tip" :style="{ borderColor: affixColor }">
            {{ monster.affix.effect }}<br />{{ monster.affix.tip }}
          </p>
          <dl class="tower-stats">
            <div><dt>血量</dt><dd>{{ formatNumber(monster.hp) }}</dd></div>
            <div><dt>每回合攻击</dt><dd>{{ formatNumber(monster.attack) }}</dd></div>
            <div><dt>身法</dt><dd>{{ monster.speed }}</dd></div>
            <div><dt>标准属性</dt><dd>{{ monster.standardAttr }}</dd></div>
            <div><dt>标准战力</dt><dd>{{ formatNumber(monster.standardPower) }}</dd></div>
          </dl>
          <p class="tower-reward-line">
            通关奖励：{{ rewardText(panel.clearReward) }}
            <span v-if="panel.clearEquipment" class="tower-reward-gear">
              · {{ panel.clearEquipment.qualityName }}装备 ×1（部位随机）
            </span>
          </p>
        </div>
      </div>

      <!-- 接下来 5 层 -->
      <ol class="tower-upcoming" aria-label="接下来的层">
        <li
          v-for="floor in panel.upcoming"
          :key="floor.floor"
          class="tower-upcoming-item"
          :class="{ 'is-boss': floor.isBoss, 'is-next': floor.floor === panel.nextFloor }"
        >
          <span class="tower-upcoming-floor">{{ floor.floor }}</span>
          <span class="tower-upcoming-name">{{ floor.affixName ?? (floor.isBoss ? '首领' : floor.name) }}</span>
          <span class="tower-upcoming-power">战力 {{ formatNumber(floor.standardPower) }}</span>
          <span v-if="floor.equipmentQualityName" class="tower-upcoming-gear">{{ floor.equipmentQualityName }}装备</span>
        </li>
      </ol>

      <!-- 上一场战斗 -->
      <div v-if="lastBattle" class="tower-result" :class="lastBattle.won ? 'is-won' : 'is-lost'">
        <p class="tower-result-title">
          {{ lastBattle.won ? '镇压成功' : lastBattle.failReason === 'wiped' ? '力竭败退' : '回合耗尽' }}
          · 第 {{ lastBattle.floor }} 层 {{ lastBattle.monsterName }}
        </p>
        <p class="tower-result-line">{{ lastBattle.message }}</p>
        <p class="tower-result-line is-quiet">{{ battleSummary }}</p>
        <button class="tower-quiet-button tower-log-toggle" type="button" @click.stop="showLog = !showLog">
          {{ showLog ? '收起战报' : '展开逐回合战报' }}
        </button>
        <ol v-if="showLog" class="tower-log">
          <li v-for="round in lastBattle.rounds" :key="round.round">{{ roundLine(round, lastBattle.monsterName) }}</li>
        </ol>
      </div>

      <!-- 出战 -->
      <DisciplePicker
        v-model:selected="selected"
        :disciples="state.disciples"
        :min="partySize"
        :max="partySize"
        :busy="submitting || busy === true"
        sort="power"
        :title="`选择出战弟子（固定 ${partySize} 人）`"
        :extra-sort="monster?.affix?.sortAttribute"
      >
        <template #actions>
          <button class="quiet-button" type="button" :disabled="submitting || busy === true" @click="autoPick">
            一键选人
          </button>
        </template>
      </DisciplePicker>

      <p v-if="strengthPercent !== null" class="tower-strength" :class="strengthTone">
        已选弟子平均战力约为本层标准的 {{ strengthPercent }}%{{ monster?.isBoss ? '（首领层建议 110% 以上）' : '' }}
      </p>

      <p v-if="bagBlocked" class="tower-bag-warning">
        第 {{ panel.nextFloor }} 层通关送一件{{ panel.clearEquipment?.qualityName }}装备，但背包已满（{{ panel.bagCount }}/{{
          panel.bagCapacity
        }}）。请先在资源栏的「背包」里分解或给弟子穿上，再来挑战。
      </p>

      <button class="tower-main-button" type="button" :disabled="!canChallenge" @click.stop="submit">
        <span v-if="submitting">闯塔中…</span>
        <span v-else>{{ challengeButtonText }}</span>
      </button>

      <!-- 每日扫荡 -->
      <section class="tower-box tower-sweep">
        <div class="tower-sweep-text">
          <p class="tower-box-title">每日扫荡</p>
          <p v-if="panel.maxFloor <= 0" class="tower-empty">闯过第 1 层后，每天可按最高层领一次扫荡奖励。</p>
          <p v-else class="tower-reward-line">
            按最高第 {{ panel.maxFloor }} 层：{{ rewardText(panel.sweepReward) }}
            <span v-if="panel.maxFloor < panel.rareFloor" class="tower-hint">
              （最高层 ≥{{ panel.rareFloor }} 另得玄铁、神木）
            </span>
          </p>
        </div>
        <button class="tower-quiet-button tower-sweep-button" type="button" :disabled="!canSweep" @click.stop="sweep">
          {{ panel.sweptToday ? '今日已扫荡' : '扫荡' }}
        </button>
      </section>
    </template>
  </section>
</template>

<style scoped>
.tower-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tower-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.tower-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  color: var(--gold-bright, #ead19a);
  font-size: 16px;
  font-weight: 600;
}

.tower-sub {
  color: #8fa79b;
  font-size: 12px;
  font-weight: 400;
}

.tower-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tower-quiet-button {
  padding: 2px 10px;
  border: 1px solid rgba(202, 169, 106, 0.4);
  border-radius: 2px;
  background: rgba(202, 169, 106, 0.08);
  color: var(--gold, #caa96a);
  font-size: 12px;
  cursor: pointer;
}

.tower-quiet-button:hover:not(:disabled) {
  background: rgba(202, 169, 106, 0.16);
}

.tower-quiet-button:disabled {
  color: #63756c;
  cursor: not-allowed;
}

.tower-box {
  padding: 8px 10px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.014);
}

.tower-box-title {
  margin: 0 0 6px;
  color: var(--gold, #caa96a);
  font-size: 13px;
}

.tower-rules-text {
  margin: 0;
  color: #c8d6ce;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
}

.tower-empty {
  margin: 0;
  color: #6d8078;
  font-size: 12px;
}

.tower-locked {
  margin: 0;
  padding: 6px 10px;
  border: 1px solid rgba(217, 138, 74, 0.4);
  border-radius: 3px;
  background: rgba(217, 138, 74, 0.08);
  color: #d9b06a;
  font-size: 12px;
}

.tower-record {
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

.tower-record-label {
  color: #8fa79b;
}

.tower-record-value {
  color: var(--gold-bright, #ead19a);
}

.tower-record-value.is-out {
  color: #e06a5f;
}

.tower-stage {
  display: flex;
  align-items: center;
  gap: 16px;
}

.tower-seal {
  flex: 0 0 auto;
  width: 96px;
  height: 96px;
  filter: drop-shadow(0 0 10px color-mix(in srgb, var(--seal-color, #6f9c86) 55%, transparent));
}

.tower-seal-ring {
  fill: none;
  stroke: var(--seal-color, #6f9c86);
  stroke-width: 2;
  opacity: 0.85;
}

.tower-seal-face {
  fill: color-mix(in srgb, var(--seal-color, #6f9c86) 32%, rgba(6, 18, 15, 0.9));
  stroke: var(--seal-color, #6f9c86);
  stroke-width: 1;
}

.tower-seal-floor {
  fill: #f2ecdc;
  font-size: 30px;
  font-weight: 600;
}

.tower-seal-unit {
  fill: #d8cfb8;
  font-family: 'STKaiti', 'KaiTi', 'Kaiti SC', 'Kai', serif;
  font-size: 16px;
}

.tower-info {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 6px;
}

.tower-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--gold-bright, #ead19a);
  font-size: 15px;
  font-weight: 600;
}

.tower-tag {
  padding: 1px 8px;
  border-radius: 20px;
  font-size: 11px;
  font-weight: 400;
}

.tower-tag.is-boss {
  background: rgba(200, 90, 72, 0.18);
  color: #e8806c;
}

.tower-affix {
  padding: 1px 8px;
  border: 1px solid currentColor;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.03);
  font-size: 11px;
  font-weight: 400;
  cursor: pointer;
}

.tower-affix-tip {
  margin: 0;
  padding: 4px 8px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.02);
  color: #9fb2a8;
  font-size: 11px;
  line-height: 1.6;
}

.tower-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: 0;
  font-size: 12px;
}

.tower-stats div {
  display: flex;
  gap: 4px;
}

.tower-stats dt {
  color: #8fa79b;
}

.tower-stats dd {
  margin: 0;
  color: #cbd8d0;
}

.tower-reward-line {
  margin: 0;
  color: #c8d6ce;
  font-size: 12px;
  line-height: 1.6;
}

.tower-hint {
  color: #7d9186;
}

.tower-reward-gear,
.tower-upcoming-gear {
  color: var(--gold-bright, #e0cd97);
}

.tower-bag-warning {
  margin: -4px 0 0;
  padding: 6px 10px;
  border: 1px solid rgba(224, 106, 95, 0.4);
  border-radius: 3px;
  background: rgba(224, 106, 95, 0.08);
  color: #e8806c;
  font-size: 12px;
  line-height: 1.6;
}

.tower-upcoming {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tower-upcoming-item {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 4px 2px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.014);
  font-size: 11px;
}

.tower-upcoming-item.is-next {
  border-color: rgba(119, 184, 154, 0.55);
  background: rgba(119, 184, 154, 0.08);
}

.tower-upcoming-item.is-boss .tower-upcoming-floor {
  color: #e8806c;
}

.tower-upcoming-floor {
  color: var(--gold-bright, #ead19a);
  font-size: 13px;
  font-weight: 600;
}

.tower-upcoming-name,
.tower-upcoming-power {
  max-width: 100%;
  overflow: hidden;
  color: #8fa79b;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tower-result {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 10px;
  border: 1px solid rgba(119, 184, 154, 0.28);
  border-radius: 3px;
  background: rgba(119, 184, 154, 0.06);
}

.tower-result.is-lost {
  border-color: rgba(224, 106, 95, 0.32);
  background: rgba(224, 106, 95, 0.06);
}

.tower-result-title {
  margin: 0;
  color: var(--gold-bright, #ead19a);
  font-size: 13px;
  font-weight: 600;
}

.tower-result.is-lost .tower-result-title {
  color: #e8806c;
}

.tower-result-line {
  margin: 0;
  color: #cbd8d0;
  font-size: 12px;
  line-height: 1.7;
}

.tower-result-line.is-quiet {
  color: #8fa79b;
}

.tower-log-toggle {
  align-self: flex-start;
  margin-top: 4px;
}

.tower-log {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
  color: #a9bcb2;
  font-size: 12px;
  line-height: 1.6;
}

.tower-strength {
  margin: -4px 0 0;
  color: #8fa79b;
  font-size: 12px;
}

.tower-strength.is-good {
  color: var(--jade-bright, #77b89a);
}

.tower-strength.is-close {
  color: #d9b06a;
}

.tower-strength.is-weak {
  color: #e06a5f;
}

.tower-main-button {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  border: 1px solid rgba(202, 169, 106, 0.55);
  border-radius: 3px;
  background: rgba(202, 169, 106, 0.12);
  color: var(--gold-bright, #ead19a);
  font-size: 13px;
  cursor: pointer;
  transition: background-color 150ms ease, border-color 150ms ease;
}

.tower-main-button:hover:not(:disabled) {
  border-color: rgba(234, 209, 154, 0.8);
  background: rgba(202, 169, 106, 0.2);
}

.tower-main-button:disabled {
  border-color: rgba(167, 184, 173, 0.11);
  background: rgba(255, 255, 255, 0.016);
  color: #63756c;
  cursor: not-allowed;
}

.tower-sweep {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.tower-sweep-text {
  min-width: 0;
}

.tower-sweep-button {
  flex: 0 0 auto;
  padding: 4px 14px;
}

.tower-ranks {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tower-rank {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 1px solid var(--line, rgba(202, 169, 106, 0.2));
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.014);
  font-size: 12px;
}

.tower-rank.is-me {
  border-color: rgba(119, 184, 154, 0.5);
  background: rgba(119, 184, 154, 0.08);
}

.tower-rank-no {
  flex: 0 0 20px;
  color: #6d8078;
}

.tower-rank-name {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  color: #cbd8d0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tower-rank-floor {
  color: #e8b96a;
  font-weight: 600;
}

/* 窄屏：头部按钮换行；妖物卡印章缩小；扫荡按钮换到下一行。 */
@media (max-width: 480px) {
  .tower-head,
  .tower-head-actions {
    flex-wrap: wrap;
  }

  .tower-stage {
    gap: 10px;
  }

  .tower-seal {
    width: 72px;
    height: 72px;
  }

  .tower-sweep {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
