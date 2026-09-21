<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { PublicSectView, SectStateView } from '../api/game';
import { fetchPublicSect } from '../api/game';
import { formatAmount, formatTime } from '../utils/format';
import LoadingState from './LoadingState.vue';

/**
 * 别人宗门的公开档案（嵌在江湖榜弹窗里）。
 *
 * 只显示服务端给的公开字段：没有资源余额、修为进度、岗位、伤势、招募次数。
 * 挑战预览（剩余次数/等级差/奖励/守擂方式/阻止原因）都由服务端相对当前玩家算好。
 */
const props = defineProps<{
  sectId: string;
  state: SectStateView;
  busy: boolean;
}>();

const emit = defineEmits<{
  back: [];
  challenge: [sect: PublicSectView];
}>();

const sect = ref<PublicSectView | null>(null);
const loadError = ref<string | null>(null);
const loading = ref(true);
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

/** 能否挑战以服务端算好的 challenge.canChallenge 为准（自动守擂也可挑战）。 */
const canChallenge = computed(() => sect.value?.challenge?.canChallenge === true);

/** 不可挑战的原因文案（稳定原因码 → 中文）。 */
const BLOCKED_LABELS: Record<string, string> = {
  self: '不能挑战自己的宗门',
  daily_limit: '今日挑战次数已用完',
  already_challenged_today: '今日已挑战过该宗门（同一目标每日 1 次）',
  defender_insufficient: '对方门下弟子不足 3 人，暂时无法应战',
};

const blockedText = computed(() => {
  const reason = sect.value?.challenge?.blockedReason;
  return reason === null || reason === undefined ? null : (BLOCKED_LABELS[reason] ?? '暂时无法挑战');
});

/** 等级差标签：正 = 对方更高（以下克上），负 = 对方更低。 */
const levelDiffText = computed(() => {
  const preview = sect.value?.challenge;
  if (preview === null || preview === undefined) {
    return '';
  }
  const diff = preview.levelDifference;
  if (diff === 0) return '同级';
  return diff > 0 ? `对方高 ${diff} 级` : `对方低 ${-diff} 级`;
});

function defenseModeText(sectValue: PublicSectView): string {
  const mode = sectValue.challenge?.defenseMode;
  if (mode === 'configured') return '已设置守擂阵容';
  if (mode === 'automatic') return '将使用临时自动守擂';
  return '守擂存疑';
}

function requestChallenge(): void {
  if (props.busy || sect.value === null || !canChallenge.value) {
    return;
  }
  emit('challenge', sect.value);
}
</script>

<template>
  <section class="public-sect" aria-labelledby="public-sect-title">
    <button class="quiet-button back-button" type="button" @click="emit('back')">← 返回榜单</button>

    <LoadingState v-if="loading" label="正在翻阅宗门档案" detail="正在读取对方门人与挑战情报。" />

    <template v-else-if="sect">
      <header class="section-heading panel-heading compact-heading">
        <div>
          <p class="eyebrow">宗门档案</p>
          <h2 id="public-sect-title">{{ sect.name }}</h2>
        </div>
        <span class="count-badge">{{ sect.levelName }}</span>
      </header>

      <div class="public-meta">
        <span>品阶 {{ sect.level }} · {{ sect.levelName }}</span>
        <span>声望 {{ sect.reputation }}</span>
        <span>立于 {{ formatTime(sect.createdAt) }}</span>
      </div>

      <div v-if="sect.challenge" class="public-block challenge-preview">
        <p class="eyebrow">挑战情报</p>
        <div class="challenge-preview-meta">
          <span>今日剩余 {{ sect.challenge.remaining }}/{{ sect.challenge.dailyLimit }} 次</span>
          <span>{{ levelDiffText }}（{{ sect.challenge.levelDifference >= 0 ? '+' : '' }}{{ sect.challenge.levelDifference }}）</span>
          <span>{{ defenseModeText(sect) }}</span>
        </div>
        <p class="challenge-preview-reward">
          若胜利：声望 +{{ sect.challenge.rewardPreview.reputation }}，灵石 +
          {{ formatAmount(sect.challenge.rewardPreview.spiritStone) }}
        </p>
        <p v-if="sect.challenge.rewardPreview.spiritStone === 0" class="blocked-hint is-warning">
          对方等级低出 3 级以上：胜利也没有奖励，但仍会消耗 1 次挑战机会。
        </p>
        <p v-if="blockedText" class="blocked-hint">{{ blockedText }}</p>
      </div>

      <div class="public-block">
        <p class="eyebrow">门人名册（{{ sect.disciples.length }} 位）</p>
        <ul class="public-list">
          <li v-for="disciple in sect.disciples" :key="disciple.id" class="public-row">
            <span class="public-glyph" aria-hidden="true">{{ disciple.name.slice(0, 1) }}</span>
            <span class="public-name">{{ disciple.name }}</span>
            <span class="public-tag">{{ disciple.gender === 'female' ? '坤' : '乾' }}</span>
            <span class="public-tag">{{ disciple.stageName }}</span>
            <span class="public-tag">资质 {{ disciple.aptitude }}</span>
            <span class="public-tag">攻 {{ disciple.attack }}</span>
            <span class="public-tag">防 {{ disciple.defense }}</span>
            <span class="public-tag">速 {{ disciple.speed }}</span>
            <span class="public-tag is-talent">{{ disciple.talentName }}</span>
          </li>
        </ul>
        <p v-if="sect.disciples.length === 0" class="public-empty">门下暂无弟子</p>
      </div>

      <div class="public-block">
        <p class="eyebrow">山门建筑（{{ sect.buildings.length }} 座）</p>
        <ul class="public-list">
          <li v-for="building in sect.buildings" :key="building.name" class="public-row">
            <span class="public-glyph" aria-hidden="true">{{ building.name.slice(0, 1) }}</span>
            <span class="public-name">{{ building.name }}</span>
            <span class="public-tag">Lv.{{ building.level }}</span>
          </li>
        </ul>
        <p v-if="sect.buildings.length === 0" class="public-empty">尚无建筑</p>
      </div>

      <button
        class="action-button primary-action realm-button"
        :class="{ 'is-disabled': busy || !canChallenge }"
        type="button"
        :disabled="busy || !canChallenge"
        :aria-disabled="busy || !canChallenge"
        @click="requestChallenge"
      >
        <span>挑战</span>
      </button>
      <p class="public-note">每日 3 次挑战机会；同一宗门每天只能挑战 1 次；没有守擂阵容的宗门会临时自动守擂。</p>
    </template>

    <p v-else-if="loadError" class="explore-hint">{{ loadError }}</p>
  </section>
</template>
