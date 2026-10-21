<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { DiscipleProfileView } from '../api/game';
import { fetchDiscipleProfile } from '../api/game';
import { beastAttrList } from '../utils/spiritBeasts';
import DiscipleAvatar from './DiscipleAvatar.vue';
import DiscipleRadarChart from './DiscipleRadarChart.vue';
import LoadingState from './LoadingState.vue';
import ModalShell from './ModalShell.vue';
import RefineTag from './RefineTag.vue';

/**
 * 天骄榜点开的弟子公开档案（只读）：境界、天赋、战力、综合评分、六轴雷达图与属性（含装备加成）、
 * 主修功法、已穿戴装备、携带的灵兽与伤势。数据全部来自 GET /game/disciple-profile/:id，
 * 不含掌门备注等私有字段。
 *
 * 版面与弟子详情的「概览」同一套路：分数 → 雷达图（六项属性与 `(+n)` 装备加成都在这张图里，
 * 不再另外列一遍属性卡）→ 天赋 / 功法一行两张卡 → 装备一行 → 灵兽一行。
 * 卡片本体用 base.css 的 .info-card / .beast-card（与弟子详情共用同一套观感）。
 */
const props = defineProps<{ discipleId: string }>();
const emit = defineEmits<{ close: [] }>();

const profile = ref<DiscipleProfileView | null>(null);
const loadError = ref<string | null>(null);
let loadSeq = 0;

async function load(discipleId: string): Promise<void> {
  const seq = (loadSeq += 1);
  profile.value = null;
  loadError.value = null;
  try {
    const result = await fetchDiscipleProfile(discipleId);
    if (seq === loadSeq) profile.value = result;
  } catch (caught) {
    if (seq === loadSeq) loadError.value = caught instanceof Error ? caught.message : '弟子档案读取失败';
  }
}

watch(() => props.discipleId, (id) => { void load(id); }, { immediate: true });

/** 熟练度（服务端给基点，0~10000），与弟子详情同一口径。 */
const techniquePercent = computed(() => Math.floor((profile.value?.techniqueProficiency ?? 0) / 100));

/**
 * 雷达图右侧数值列表的 `(+n)`：装备 + 灵兽的加成合计。
 * 两者都进战力公式的同一个括号，所以括号里的数字与服务端战力口径一致。
 */
const attributeBonus = computed(() => {
  const gear = profile.value?.gear;
  const beast = profile.value?.spiritBeast?.attrs;
  return {
    attack: (gear?.attack ?? 0) + (beast?.attack ?? 0),
    defense: (gear?.defense ?? 0) + (beast?.defense ?? 0),
    speed: (gear?.speed ?? 0) + (beast?.speed ?? 0),
    luck: (gear?.luck ?? 0) + (beast?.luck ?? 0),
    physique: (gear?.physique ?? 0) + (beast?.physique ?? 0),
  };
});

/** 灵兽档位（`+8.2%`）：基点按等级折算后不是整百分比，最多留一位小数；没有灵兽时为 null。 */
const beastPowerText = computed(() => {
  const bp = profile.value?.spiritBeast?.powerBonusBp ?? 0;
  return bp > 0 ? `+${String(Number((bp / 100).toFixed(1)))}%` : null;
});

const injuryText = computed(() => {
  if (profile.value?.injury === 'severe') return '重伤卧床';
  if (profile.value?.injury === 'injured') return '负伤';
  return null;
});
</script>

<template>
  <ModalShell label="弟子档案" @close="emit('close')">
    <LoadingState v-if="profile === null && loadError === null" label="正在读取弟子档案" />
    <p v-else-if="loadError" class="explore-hint">{{ loadError }}</p>

    <section v-else-if="profile" class="dpf-card" aria-labelledby="dpf-title">
      <header class="dpf-head">
        <DiscipleAvatar
          class="dpf-avatar"
          :name="profile.name"
          :gender="profile.gender"
          :realm-id="profile.realmId"
          :frame-id="profile.frameId"
          :image-hash="profile.avatarHash"
          variant="roster"
        />
        <div class="dpf-head-copy">
          <h2 id="dpf-title" class="dpf-name">
            {{ profile.name }}
            <span v-if="profile.isMe" class="rank-me">本宗</span>
          </h2>
          <p class="dpf-meta">
            <span>{{ profile.sectName }}</span>
            <span>{{ profile.realmName }} · {{ profile.stageName }}</span>
            <span v-if="injuryText" class="dpf-injury">{{ injuryText }}</span>
          </p>
        </div>
      </header>

      <div class="dpf-scores">
        <div class="disciple-score">
          <span class="disciple-score-label">战力</span>
          <strong class="disciple-score-value">{{ profile.combatPower }}</strong>
        </div>
        <div class="disciple-score">
          <span class="disciple-score-label">综合评分</span>
          <strong class="disciple-score-value">{{ profile.attributeScore.toFixed(1) }}</strong>
        </div>
      </div>

      <!-- 六项属性与 `(+n)` 装备加成都在雷达图右侧的数值列表里，下面不再重复列一遍属性卡。 -->
      <DiscipleRadarChart
        :name="profile.name"
        :aptitude="profile.aptitude"
        :attack="profile.attack"
        :defense="profile.defense"
        :speed="profile.speed"
        :luck="profile.luck"
        :physique="profile.physique"
        :bonus="attributeBonus"
      />

      <div class="disciple-stats">
        <span class="stat-tag">淬体 {{ profile.bodyTemperingUses }} 次</span>
        <span class="stat-tag">悟道 {{ profile.daoInsightUsed }} 点</span>
      </div>

      <div class="dpf-cards">
        <!-- 天赋 / 功法一行两张卡。 -->
        <section class="info-card" aria-labelledby="dpf-talent-title">
          <div class="info-card-head">
            <h3 id="dpf-talent-title" class="info-card-title">天赋</h3>
          </div>
          <strong class="info-card-value">{{ profile.talentName }}</strong>
          <p class="info-card-note">
            {{ profile.talentDescription === '' ? '当前境界下没有额外加成' : profile.talentDescription }}
          </p>
        </section>

        <section class="info-card" aria-labelledby="dpf-technique-title">
          <div class="info-card-head">
            <h3 id="dpf-technique-title" class="info-card-title">功法</h3>
          </div>
          <strong class="info-card-value">{{ profile.techniqueId === null ? '未修习' : profile.techniqueName }}</strong>
          <p v-if="profile.techniqueId !== null" class="info-card-note">
            {{ profile.techniqueLevel }} 级 · 熟练度 {{ techniquePercent }}%
          </p>
        </section>

        <!-- 装备一行：一件一行（部位 + 名称 + 祭炼 + 主 / 副属性），不再一件一个方框。 -->
        <section class="info-card dpf-wide" aria-labelledby="dpf-gear-title">
          <div class="info-card-head">
            <h3 id="dpf-gear-title" class="info-card-title">装备</h3>
          </div>
          <ul v-if="profile.equipment.length > 0" class="dpf-gear">
            <li v-for="item in profile.equipment" :key="item.id" class="dpf-gear-item">
              <span class="dpf-gear-slot">{{ item.slotName }}</span>
              <span class="dpf-gear-title">
                <strong class="dpf-gear-name" :style="{ color: item.color }">{{ item.name }}</strong>
                <RefineTag :level="item.refineLevel" />
              </span>
              <span class="dpf-gear-attrs">
                {{ item.mainAttrName }} +{{ item.mainValue }} · {{ item.subAttrName }} +{{ item.subValue }}
              </span>
            </li>
          </ul>
          <p v-else class="info-card-note">未穿戴装备</p>
        </section>

        <!-- 灵兽一行：与弟子详情的灵兽卡片同一套（头像 / 品质五行档次 / 技能 / 属性）。 -->
        <section
          class="info-card dpf-wide beast-card"
          :data-element="profile.spiritBeast?.element"
          :data-quality="profile.spiritBeast?.quality"
          aria-labelledby="dpf-beast-title"
        >
          <div class="info-card-head">
            <h3 id="dpf-beast-title" class="info-card-title">灵兽</h3>
          </div>
          <div v-if="profile.spiritBeast" class="beast-card-body">
            <span class="beast-avatar beast-card-avatar">
              <img
                :src="profile.spiritBeast.avatar"
                :alt="profile.spiritBeast.name"
                width="96"
                height="96"
                loading="lazy"
                decoding="async"
              />
            </span>
            <div class="beast-card-info">
              <p class="beast-card-name">
                <strong class="info-card-value">{{ profile.spiritBeast.name }}</strong>
                <span class="beast-card-level">Lv.{{ profile.spiritBeast.level }}</span>
                <span class="beast-chip is-quality">{{ profile.spiritBeast.qualityName }}</span>
                <span class="beast-chip is-element">{{ profile.spiritBeast.elementName }}行</span>
                <span class="beast-chip" :class="`is-tier-${profile.spiritBeast.tier}`">
                  {{ profile.spiritBeast.tierName }}
                </span>
              </p>
              <p class="info-card-note">
                <b class="beast-card-skill">【{{ profile.spiritBeast.skillName }}】</b>{{ profile.spiritBeast.skillText }}
              </p>
              <ul class="beast-card-attrs" aria-label="灵兽加成">
                <li v-for="attr in beastAttrList(profile.spiritBeast.attrs)" :key="attr.key">
                  {{ attr.label }} <strong>+{{ attr.value }}</strong>
                </li>
                <!-- 灵兽给弟子的战力加成（与装备加成一起进同一个括号，战力里已经含它）。 -->
                <li v-if="beastPowerText" class="beast-card-power">
                  战力 <strong>{{ beastPowerText }}</strong>
                </li>
              </ul>
            </div>
          </div>
          <p v-else class="info-card-note">未携带灵兽</p>
        </section>
      </div>
    </section>
  </ModalShell>
</template>

<style scoped>
/* 与弟子详情概览同一套纵向节奏：区块之间一律 16px。 */
.dpf-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 16px;
}

.dpf-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-right: 32px;
}

.dpf-avatar {
  width: 48px;
  height: 48px;
  flex-shrink: 0;
}

.dpf-head-copy {
  min-width: 0;
}

.dpf-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: #e4ece6;
  font-size: 18px;
  font-weight: 500;
}

.dpf-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  margin: 4px 0 0;
  color: #93a99e;
  font-size: 12px;
}

.dpf-injury {
  color: #e08a7a;
}

.dpf-scores {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

/* 天赋 / 功法一行两张卡；装备与灵兽各自占满一行（.dpf-wide）。 */
.dpf-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.dpf-wide {
  grid-column: 1 / -1;
}

/* 装备：一件一行，部位 / 名称 + 祭炼 / 主副属性三列对齐。 */
.dpf-gear {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.dpf-gear-item {
  display: grid;
  min-width: 0;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}

.dpf-gear-slot {
  color: var(--muted);
  font-size: 12px;
}

.dpf-gear-title {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 6px;
}

.dpf-gear-name {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dpf-gear-attrs {
  color: var(--faint);
  font-size: 12px;
}

@media (max-width: 420px) {
  .dpf-cards {
    grid-template-columns: minmax(0, 1fr);
  }

  /* 窄屏放不下三列：属性换到名称下面一行。 */
  .dpf-gear-item {
    grid-template-columns: 30px minmax(0, 1fr);
  }

  .dpf-gear-attrs {
    grid-column: 2;
  }
}
</style>
