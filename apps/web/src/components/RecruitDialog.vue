<script setup lang="ts">
import type { RecruitPreview } from '../api/game';

/**
 * 招贤台（弹窗内容）：展示本次三位候选人，选一位迎入山门。
 *
 * 候选人是服务端按「宗门 + 当日 + 已招募次数 + 本境界刷新次数」做种子生成的，
 * 同一批刷新不变；招募后次数 +1、点「换一批」换一组人，下次打开就是最新那批。
 */
defineProps<{
  preview: RecruitPreview;
  /** 招募消耗（已格式化的展示文本）。 */
  costText: string;
  /** 全局忙碌（有写操作在途）。 */
  busy: boolean;
  /** 正在向服务端要新一批候选人。 */
  refreshing: boolean;
}>();

const emit = defineEmits<{
  choose: [choice: number];
  refresh: [];
}>();
</script>

<template>
  <section class="recruit-dialog" aria-labelledby="recruit-dialog-title">
    <header class="section-heading panel-heading compact-heading">
      <div>
        <p class="eyebrow">招贤台</p>
        <h2 id="recruit-dialog-title">有缘人求见</h2>
      </div>
      <span class="count-badge">择一入门</span>
    </header>

    <div class="recruit-refresh">
      <span class="recruit-refresh-count">
        本境界可刷新 <strong>{{ preview.refreshRemaining }}</strong>/{{ preview.refreshLimit }} 次
        <small>（宗门晋升后重置）</small>
      </span>
      <button
        class="quiet-button recruit-refresh-button"
        type="button"
        :disabled="busy || refreshing || preview.refreshRemaining <= 0"
        @click="emit('refresh')"
      >
        {{ refreshing ? '天机推演中…' : '换一批' }}
      </button>
    </div>

    <p class="recruit-cost">招募消耗：{{ costText }}</p>
    <p v-if="!preview.canRecruit" class="blocked-hint">{{ preview.blockedReason ?? '当前不可招募' }}</p>

    <ul class="candidate-list">
      <li v-for="(candidate, index) in preview.candidates" :key="`${candidate.name}-${index}`" class="candidate-card">
        <div class="candidate-head">
          <span class="candidate-glyph" aria-hidden="true">{{ candidate.name.slice(0, 1) }}</span>
          <div class="candidate-title">
            <strong>{{ candidate.name }}</strong>
            <span class="candidate-gender">{{ candidate.gender === 'female' ? '坤' : '乾' }}</span>
            <span class="candidate-talent">{{ candidate.talentName }}</span>
          </div>
        </div>

        <div class="disciple-stats">
          <span class="stat-tag stat-aptitude">资质 {{ candidate.aptitude }}</span>
          <span class="stat-tag stat-attack">攻 {{ candidate.attack }}</span>
          <span class="stat-tag stat-defense">防 {{ candidate.defense }}</span>
          <span class="stat-tag stat-speed">速 {{ candidate.speed }}</span>
        </div>

        <button
          class="action-button primary-action candidate-button"
          :class="{ 'is-disabled': !preview.canRecruit || busy }"
          type="button"
          :disabled="busy"
          :aria-disabled="!preview.canRecruit || busy"
          :aria-label="`迎入山门：${candidate.name}`"
          @click="emit('choose', index)"
        >
          <span>迎入山门</span>
        </button>
      </li>
    </ul>

    <p class="recruit-note">资质只影响修炼速度；攻 / 防 / 速 决定战力；天赋对应采药、采矿、修炼或战斗加成。</p>
  </section>
</template>
