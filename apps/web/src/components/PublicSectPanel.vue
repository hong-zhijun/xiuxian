<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { PublicDiscipleView, PublicSectView, SectStateView } from '../api/game';
import { fetchPublicSect } from '../api/game';
import { formatAmount, formatTime } from '../utils/format';
import DiscipleAvatar from './DiscipleAvatar.vue';
import DiscipleProfileDialog from './DiscipleProfileDialog.vue';
import LoadingState from './LoadingState.vue';
import SectAvatar from './SectAvatar.vue';

/**
 * 别人宗门的公开档案（江湖榜里点一行弹出的二级弹窗内容，外壳由 LeaderboardPanel 用 ModalShell 提供）。
 *
 * 版面（0073 重做）：
 *   名帖（宗门头像 / 名字 / 品阶 / 立宗时间 + 挑战按钮）→ 声望与门人两张小卡 → 挑战情报
 *   → 门人卡片（点开弟子公开档案，与天骄榜同一个 DiscipleProfileDialog）→ 宗门建筑。
 * 卡片沿用弟子详情的 .info-card / .stat-tag / .count-badge，只在这里补版面用的类。
 *
 * 只显示服务端给的公开字段：没有资源余额、修为进度、岗位、伤势、招募次数；
 * 挑战预览（剩余次数/等级差/奖励/守擂方式）由服务端相对当前玩家算好，不能挑战的原因留在挑战弹窗里说明。
 */
const props = defineProps<{
  sectId: string;
  state: SectStateView;
  busy: boolean;
}>();

const emit = defineEmits<{
  challenge: [sect: PublicSectView];
}>();

const sect = ref<PublicSectView | null>(null);
const loadError = ref<string | null>(null);
const loading = ref(true);
/** 正在查看公开档案的弟子（null = 没打开）。 */
const profileId = ref<string | null>(null);
let loadSeq = 0;

watch(
  () => [props.sectId, props.state] as const,
  async ([sectId]) => {
    const seq = ++loadSeq;
    sect.value = null;
    loadError.value = null;
    loading.value = true;
    try {
      const next = await fetchPublicSect(sectId);
      if (seq !== loadSeq) return;
      sect.value = next;
    } catch (caught) {
      if (seq !== loadSeq) return;
      loadError.value = caught instanceof Error ? caught.message : '档案读取失败';
    } finally {
      if (seq === loadSeq) loading.value = false;
    }
  },
  { immediate: true },
);

/** 门人按境界 → 阶段 → 战力排序（境界下标由服务端给，不按名称字符串比较）。 */
const disciples = computed<PublicDiscipleView[]>(() => {
  const list = [...(sect.value?.disciples ?? [])];
  list.sort(
    (a, b) => b.realmOrder - a.realmOrder || b.stage - a.stage || b.combatPower - a.combatPower,
  );
  return list;
});

/** 门内最强的那位（没有弟子时为 null）：给「门下弟子」小卡做一句摘要。 */
const topDisciple = computed<PublicDiscipleView | null>(() => disciples.value[0] ?? null);

const buildings = computed(() => sect.value?.buildings ?? []);

/** 等级差文案（与挑战弹窗同一口径：levelDifference = 对方等级 − 我方等级）。 */
const levelDiffText = computed(() => {
  const diff = sect.value?.challenge?.levelDifference;
  if (diff === undefined) return '';
  if (diff === 0) return '与贵宗同级';
  return diff > 0 ? `对方高 ${diff} 级` : `对方低 ${-diff} 级`;
});

/** 「若胜利」的奖励：两项都为 0 时沿用挑战弹窗的说法（等级差过大，只有胜负没有收益）。 */
const rewardText = computed(() => {
  const reward = sect.value?.challenge?.rewardPreview;
  if (reward === undefined) return '';
  const parts: string[] = [];
  if (reward.reputation > 0) parts.push(`声望 +${reward.reputation}`);
  if (reward.spiritStone > 0) parts.push(`灵石 +${formatAmount(reward.spiritStone)}`);
  return parts.length === 0 ? '无奖励（对方等级低出 3 级以上）' : parts.join('，');
});

const defenseText = computed(() => {
  const mode = sect.value?.challenge?.defenseMode;
  if (mode === null || mode === undefined) return '弟子不足，暂不能应战';
  return mode === 'configured' ? '已设守擂阵容' : '临时自动守擂';
});

/** 打开某个弟子的公开档案（只读；与天骄榜同一个弹窗，会叠在这一层上面）。 */
function openProfile(discipleId: string): void {
  profileId.value = discipleId;
}

/** 打开二级弹窗（能不能打由弹窗里的服务端情报裁决，这一页不做拦截）。 */
function requestChallenge(): void {
  if (props.busy || sect.value === null) {
    return;
  }
  emit('challenge', sect.value);
}
</script>

<template>
  <section class="public-sect" aria-labelledby="public-sect-title">
    <LoadingState v-if="loading" label="正在翻阅宗门档案" detail="正在读取对方门人与挑战情报。" />
    <p v-else-if="loadError" class="explore-hint">{{ loadError }}</p>

    <template v-else-if="sect">
      <!-- ---------- 名帖：头像 / 宗门名 / 品阶与立宗时间 / 挑战 ---------- -->
      <header class="public-hero">
        <SectAvatar class="public-hero-avatar" :name="sect.name" :image-hash="sect.avatarHash" />
        <div class="public-hero-copy">
          <p class="eyebrow">宗门档案</p>
          <h2 id="public-sect-title" class="public-hero-name">{{ sect.name }}</h2>
          <p class="public-hero-tags">
            <span class="stat-tag stat-talent">LV.{{ sect.level }} · {{ sect.levelName }}</span>
            <span class="stat-tag">立于 {{ formatTime(sect.createdAt) }}</span>
          </p>
        </div>
        <button
          v-if="sect.challenge"
          class="action-button primary-action public-challenge-button"
          :class="{ 'is-disabled': busy }"
          type="button"
          :disabled="busy"
          :aria-disabled="busy"
          @click="requestChallenge"
        >
          <span>挑战</span>
        </button>
      </header>

      <!-- ---------- 声望 / 门人：两张档案小卡 ---------- -->
      <div class="public-facts">
        <section class="info-card" aria-labelledby="public-reputation-title">
          <div class="info-card-head">
            <h3 id="public-reputation-title" class="info-card-title">声望</h3>
          </div>
          <strong class="info-card-value">{{ sect.reputation }}</strong>
          <p class="info-card-note">切磋、挑战与宗门征伐累积而来</p>
        </section>

        <section class="info-card" aria-labelledby="public-disciples-title">
          <div class="info-card-head">
            <h3 id="public-disciples-title" class="info-card-title">门下弟子</h3>
          </div>
          <strong class="info-card-value">{{ sect.disciples.length }} 位</strong>
          <p class="info-card-note">
            <template v-if="topDisciple">
              最强 {{ topDisciple.name }} · {{ topDisciple.stageName }}
            </template>
            <template v-else>山门清净，尚无弟子入门</template>
          </p>
        </section>
      </div>

      <!-- ---------- 挑战情报：数字全部来自服务端预览 ---------- -->
      <section
        v-if="sect.challenge"
        class="info-card public-challenge"
        aria-labelledby="public-challenge-title"
      >
        <div class="info-card-head">
          <h3 id="public-challenge-title" class="info-card-title">挑战情报</h3>
        </div>
        <p class="public-challenge-tags">
          <span class="stat-tag stat-power">
            今日剩余 {{ sect.challenge.remaining }}/{{ sect.challenge.dailyLimit }} 次
          </span>
          <span class="stat-tag">{{ levelDiffText }}</span>
          <span class="stat-tag">{{ defenseText }}</span>
        </p>
        <p class="info-card-note">若胜利：{{ rewardText }}</p>
      </section>

      <!-- ---------- 门人：一张卡片一位，点开弟子公开档案 ---------- -->
      <section class="public-section" aria-labelledby="public-roster-title">
        <div class="public-section-head">
          <p id="public-roster-title" class="public-section-title">
            门下弟子
            <span class="public-section-sub">共 {{ disciples.length }} 位</span>
          </p>
          <span v-if="disciples.length > 0" class="public-section-hint">点卡片查看弟子档案</span>
        </div>

        <ul v-if="disciples.length > 0" class="public-roster">
          <li v-for="(disciple, index) in disciples" :key="disciple.id">
            <button
              class="public-disciple"
              type="button"
              :aria-label="`查看 ${disciple.name} 的弟子档案`"
              @click="openProfile(disciple.id)"
            >
              <span class="public-disciple-avatar">
                <DiscipleAvatar
                  :name="disciple.name"
                  :gender="disciple.gender"
                  :realm-id="disciple.realmId"
                  frame-id="classic"
                  :image-hash="disciple.avatarHash"
                />
              </span>
              <span class="public-disciple-copy">
                <span class="public-disciple-line">
                  <strong class="public-disciple-name">{{ disciple.name }}</strong>
                  <span v-if="index === 0" class="public-disciple-top">最强</span>
                </span>
                <span class="public-disciple-meta">
                  {{ disciple.stageName }} · 资质 {{ disciple.aptitude }}
                </span>
                <span class="public-disciple-tags">
                  <span v-if="disciple.talentName !== '无'" class="stat-tag stat-talent">
                    {{ disciple.talentName }}
                  </span>
                  <span class="stat-tag stat-power">战力 {{ disciple.combatPower }}</span>
                </span>
              </span>
              <span class="rank-arrow" aria-hidden="true">›</span>
            </button>
          </li>
        </ul>
        <p v-else class="public-empty">门下暂无弟子</p>
      </section>

      <!-- ---------- 宗门建筑：公开档案只给名称与等级 ---------- -->
      <section class="info-card public-buildings" aria-labelledby="public-buildings-title">
        <div class="info-card-head">
          <h3 id="public-buildings-title" class="info-card-title">宗门建筑</h3>
          <span class="public-buildings-count">{{ buildings.length }} 座</span>
        </div>
        <p v-if="buildings.length > 0" class="public-buildings-tags">
          <span v-for="building in buildings" :key="building.name" class="stat-tag">
            {{ building.name }} Lv.{{ building.level }}
          </span>
        </p>
        <p v-else class="info-card-note">尚无建筑</p>
      </section>

      <!-- 弟子公开档案（只读）：叠在宗门档案上面，关掉回到这一页。 -->
      <DiscipleProfileDialog v-if="profileId" :disciple-id="profileId" @close="profileId = null" />
    </template>
  </section>
</template>

<style scoped>
/* 名帖：与弟子详情头部同一个三列节奏（头像 / 文本 / 右上角操作）。 */
.public-hero {
  display: grid;
  min-width: 0;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  /* 右上角是挑战按钮，要给弹窗右上角的关闭按钮让位（与 .dpf-head / .section-heading 同一做法）。 */
  padding-right: 36px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line);
}

.public-hero-avatar {
  --sect-avatar-size: 64px;
}

.public-hero-copy {
  min-width: 0;
}

.public-hero-name {
  overflow: hidden;
  margin: 3px 0 0;
  color: var(--gold-bright);
  font-family: 'STKaiti', 'KaiTi', serif;
  font-size: 26px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.public-hero-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin: 7px 0 0;
}

/* 比面板主按钮小一号，别跟宗门名抢注意力。 */
.public-challenge-button {
  flex: 0 0 auto;
  min-height: 36px;
  padding: 0 22px;
  font-size: 14px;
  letter-spacing: 0.08em;
}

/* 声望 / 门人：两张并排的小卡，窄屏收成一列。 */
.public-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 14px;
}

/* 挑战情报：整行一张卡，情报做成一排小标签。 */
.public-challenge {
  margin-top: 8px;
}

.public-challenge-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin: 0;
}

/* 门人区块：标题行沿用档案页的分区标题，正文是两列卡片。 */
.public-section {
  margin-top: 16px;
  padding-top: 13px;
  border-top: 1px solid var(--line);
}

.public-section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 10px;
}

.public-section-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  color: #dce6e0;
  font-family: 'STKaiti', 'KaiTi', serif;
  font-size: 15px;
  letter-spacing: 0.04em;
}

.public-section-sub {
  color: #7f948a;
  font-family: inherit;
  font-size: 12px;
  letter-spacing: 0;
}

.public-section-hint {
  color: #6b8177;
  font-size: 11px;
}

.public-roster {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 9px 0 0;
  padding: 0;
  list-style: none;
}

/* 一位弟子一张卡：头像 / 名字 + 境界与资质 + 天赋与战力 / 箭头。 */
.public-disciple {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: 42px minmax(0, 1fr) 12px;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border: 1px solid rgba(119, 184, 154, 0.16);
  border-radius: 3px;
  color: inherit;
  background: rgba(255, 255, 255, 0.018);
  text-align: left;
  transition: border-color 150ms ease, background-color 150ms ease;
}

.public-disciple:not(:disabled):hover {
  border-color: rgba(202, 169, 106, 0.42);
  background: rgba(202, 169, 106, 0.06);
}

.public-disciple-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 卡片里的头像比名册小一号：虚线 / 金弧装饰在这个尺寸只会糊成一团，去掉。 */
.public-disciple :deep(.disciple-avatar) {
  width: 42px;
  height: 42px;
  font-size: 17px;
}

.public-disciple :deep(.disciple-avatar::before),
.public-disciple :deep(.disciple-avatar::after) {
  display: none;
}

.public-disciple :deep(.disciple-avatar i) {
  width: 16px;
  height: 16px;
  font-size: 9px;
}

.public-disciple-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.public-disciple-line {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.public-disciple-name {
  overflow: hidden;
  color: #e4ece6;
  font-family: 'STKaiti', 'KaiTi', serif;
  font-size: 16px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 「最强」只在排序第一的那张卡上出现，与天骄榜的「本宗」同一种小徽章。 */
.public-disciple-top {
  flex: 0 0 auto;
  padding: 0 5px;
  border: 1px solid rgba(202, 169, 106, 0.34);
  border-radius: 2px;
  color: var(--gold);
  font-size: 10px;
  line-height: 15px;
}

.public-disciple-meta {
  overflow: hidden;
  color: #93a99e;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.public-disciple-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 1px;
}

/* 宗门建筑：一整行卡，建筑做成一排小标签。 */
.public-buildings {
  margin-top: 8px;
}

.public-buildings-count {
  margin-left: auto;
  color: var(--jade);
  font-size: 12px;
}

.public-buildings-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
}

@media (max-width: 520px) {
  /* 窄屏：名帖的挑战按钮换到第二行，两张小卡与门人卡片各收成一列。 */
  .public-hero {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .public-challenge-button {
    grid-column: 1 / -1;
    justify-self: stretch;
  }

  .public-facts,
  .public-roster {
    grid-template-columns: minmax(0, 1fr);
  }

  .public-hero-name {
    font-size: 22px;
  }
}
</style>
