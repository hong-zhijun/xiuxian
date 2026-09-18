<script setup lang="ts">
import { ref, watch } from 'vue';

import type { PublicSectView } from '../api/game';
import { fetchPublicSect } from '../api/game';
import { formatTime } from '../utils/format';

/**
 * 别人宗门的公开档案（嵌在江湖榜弹窗里）。
 *
 * 只显示服务端给的公开字段：没有资源余额、修为进度、岗位、伤势、招募次数。
 */
const props = defineProps<{
  sectId: string;
  busy: boolean;
}>();

const emit = defineEmits<{
  back: [];
  spar: [sect: PublicSectView];
}>();

const sect = ref<PublicSectView | null>(null);
const loadError = ref<string | null>(null);

watch(
  () => props.sectId,
  async (sectId) => {
    sect.value = null;
    loadError.value = null;
    try {
      sect.value = await fetchPublicSect(sectId);
    } catch (caught) {
      loadError.value = caught instanceof Error ? caught.message : '档案读取失败';
    }
  },
  { immediate: true },
);

function requestSpar(): void {
  if (props.busy || sect.value === null || sect.value.disciples.length === 0) {
    return;
  }
  emit('spar', sect.value);
}
</script>

<template>
  <section class="public-sect" aria-labelledby="public-sect-title">
    <button class="quiet-button back-button" type="button" @click="emit('back')">← 返回榜单</button>

    <template v-if="sect">
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
        :class="{ 'is-disabled': busy || sect.disciples.length === 0 }"
        type="button"
        :disabled="busy"
        :aria-disabled="busy || sect.disciples.length === 0"
        @click="requestSpar"
      >
        <span>切磋</span>
      </button>
      <p class="public-note">每日 5 次切磋机会，同一宗门每日 1 次；胜者 +10 声望与 5000 灵石。</p>
    </template>

    <p v-else-if="loadError" class="explore-hint">{{ loadError }}</p>
    <p v-else class="explore-hint">正在翻阅档案……</p>
  </section>
</template>
