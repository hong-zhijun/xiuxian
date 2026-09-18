<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { SecretRealmView, SectStateView } from '../api/game';
import { fetchSecretRealms } from '../api/game';
import { formatAmount } from '../utils/format';

/**
 * 秘境列表（弹窗内容）。
 *
 * 只负责按服务端算好的状态把秘境列出来 + 派发「点探索」：
 * 选弟子与真正的结算交给 ExplorePartyDialog / App.vue。
 */
const props = defineProps<{
  state: SectStateView;
  busy: boolean;
}>();

const emit = defineEmits<{
  select: [realm: SecretRealmView];
}>();

const realms = ref<SecretRealmView[]>([]);
const loadError = ref<string | null>(null);

let loadSeq = 0;

async function loadRealms(): Promise<void> {
  const seq = (loadSeq += 1);
  try {
    const list = await fetchSecretRealms();
    if (seq !== loadSeq) return; // 已有更新的请求在途，丢弃这次过期响应
    realms.value = list;
    loadError.value = null;
  } catch (caught) {
    if (seq !== loadSeq) return;
    loadError.value = caught instanceof Error ? caught.message : '秘境列表加载失败';
  }
}

watch(() => props.state, () => { void loadRealms(); }, { immediate: true });

const resourceNameMap = computed<Record<string, string>>(() =>
  Object.fromEntries(props.state.resources.map((resource) => [resource.id, resource.name])),
);

/** 有没有演武场以服务端算好的 `realms[].hasArena` 为准。 */
const hasArena = computed(() => realms.value.some((realm) => realm.hasArena));

/** 该秘境当前不能探索的原因（null = 可以探索）。 */
function realmBlockedReason(realm: SecretRealmView): string | null {
  if (realm.locked) {
    return `宗门需达 ${realm.requiredSectLevel} 级`;
  }
  if (!hasArena.value) {
    return '尚无演武场';
  }
  if (realm.dailyLimit !== null && realm.usedToday >= realm.dailyLimit) {
    return `今日次数已用完（${realm.dailyLimit} 次/天）`;
  }
  return null;
}

function canExplore(realm: SecretRealmView): boolean {
  return !props.busy && realmBlockedReason(realm) === null;
}

function openParty(realm: SecretRealmView): void {
  if (!canExplore(realm)) {
    return;
  }
  emit('select', realm);
}

function realmGlyph(realmId: string): string {
  const glyphs: Record<string, string> = {
    mistyForest: '雾',
    savageMine: '矿',
    fallenStarAbyss: '渊',
    beastNest: '兽',
    ancientRealm: '古',
    tribulationRuins: '劫',
  };
  return glyphs[realmId] ?? '境';
}
</script>

<template>
  <section class="explore-panel" aria-labelledby="explore-title">
    <header class="section-heading panel-heading compact-heading">
      <div>
        <p class="eyebrow">历练探索</p>
        <h2 id="explore-title">秘境</h2>
      </div>
      <span class="count-badge">{{ realms.length }} 处</span>
    </header>

    <p v-if="loadError" class="explore-hint">{{ loadError }}</p>
    <p v-else-if="realms.length > 0 && !hasArena" class="explore-hint">宗门尚无演武场（4 级解锁），暂时无法外派弟子探索秘境。</p>

    <ul v-if="realms.length > 0" class="realm-list">
      <li v-for="realm in realms" :key="realm.id" class="realm-row" :class="{ 'is-locked': realm.locked }">
        <div class="realm-glyph" aria-hidden="true">{{ realmGlyph(realm.id) }}</div>

        <div class="realm-copy">
          <div class="realm-title">
            <strong>{{ realm.name }}</strong>
            <span v-if="realmBlockedReason(realm)" class="realm-flag">{{ realmBlockedReason(realm) }}</span>
          </div>
          <p class="realm-desc">{{ realm.description }}</p>
          <div class="realm-meta">
            <span>难度 {{ realm.difficulty }}</span>
            <span v-if="realm.dailyLimit === null">不限次数</span>
            <span v-else>次数 {{ realm.usedToday }}/{{ realm.dailyLimit }}</span>
            <span>队伍 {{ realm.minParty }}~{{ realm.maxParty }} 人</span>
          </div>
          <div class="realm-tags">
            <span class="tag-label">奖励</span>
            <span v-for="(amount, resourceId) in realm.rewards" :key="resourceId" class="reward-tag is-gain">
              {{ resourceNameMap[resourceId] ?? resourceId }} {{ formatAmount(amount) }}
            </span>
            <span class="tag-label">消耗</span>
            <span v-for="(amount, resourceId) in realm.entryCost" :key="resourceId" class="reward-tag is-cost">
              {{ resourceNameMap[resourceId] ?? resourceId }} {{ formatAmount(amount) }}
            </span>
          </div>
        </div>

        <button
          class="realm-go"
          :class="{ 'is-disabled': !canExplore(realm) }"
          type="button"
          :disabled="busy"
          :aria-disabled="!canExplore(realm)"
          :aria-label="`探索${realm.name}`"
          @click="openParty(realm)"
        >
          探索
        </button>
      </li>
    </ul>

    <div v-else-if="loadError === null" class="empty-state compact-empty">
      <span aria-hidden="true">境</span>
      <strong>暂无秘境</strong>
    </div>
  </section>
</template>
