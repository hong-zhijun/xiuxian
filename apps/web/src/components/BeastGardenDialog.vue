<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { BeastElement, BeastQuality, SpiritBeastView, SpiritBeastsPanel } from '@xiuxian/contracts';

import { fetchSpiritBeasts, manageSpiritBeast, type SectStateView } from '../api/game';
import type { ToastTone } from '../types/ui';
import { formatAmount } from '../utils/format';
import { BEAST_ELEMENT_OPTIONS, BEAST_QUALITY_OPTIONS, beastAttrList } from '../utils/spiritBeasts';
import DisciplePicker from './DisciplePicker.vue';
import ModalShell from './ModalShell.vue';

/**
 * 灵兽苑（首页「宗门」列）：已收服灵兽的筛选、装备、培养、锁定与放生。
 * 从弟子出发换灵兽走弟子详情里的 BeastPickerDialog，不经过这里。
 */
const props = defineProps<{ state: SectStateView }>();
const emit = defineEmits<{
  'state-update': [state: SectStateView];
  notify: [tone: ToastTone, title: string, message: string];
  'open-capture': [];
}>();

type ManageAction = 'equip' | 'unequip' | 'upgrade' | 'lock' | 'release';

const TIER_RANK = { divine: 3, rare: 2, spirit: 1 } as const;
const QUALITY_RANK: Record<BeastQuality, number> = { immortal: 4, treasure: 3, spirit: 2, common: 1 };

const panel = ref<SpiritBeastsPanel | null>(null);
const loading = ref(true);
const pending = ref(false);
const elementFilter = ref<BeastElement | ''>('');
const qualityFilter = ref<BeastQuality | ''>('');
const detailId = ref<string | null>(null);
const equipTargets = ref<string[]>([]);
const confirmRelease = ref(false);

/** 随行的排在前面，其余按档次、品质、等级从高到低。 */
const items = computed(() =>
  (panel.value?.items ?? [])
    .filter((item) => (elementFilter.value === '' || item.species.element === elementFilter.value)
      && (qualityFilter.value === '' || item.quality === qualityFilter.value))
    .slice()
    .sort((a, b) =>
      Number(b.discipleId !== null) - Number(a.discipleId !== null)
      || TIER_RANK[b.species.tier] - TIER_RANK[a.species.tier]
      || QUALITY_RANK[b.quality] - QUALITY_RANK[a.quality]
      || b.level - a.level),
);
const carriedCount = computed(() => panel.value?.items.filter((item) => item.discipleId !== null).length ?? 0);
const selected = computed(() => panel.value?.items.find((item) => item.id === detailId.value) ?? null);
const equipTarget = computed(() => {
  const id = equipTargets.value[0];
  return id === undefined ? null : (props.state.disciples.find((item) => item.id === id) ?? null);
});

function balanceOf(resourceId: string): number {
  return Number(props.state.resources.find((item) => item.id === resourceId)?.balance ?? 0);
}
function affordable(beast: SpiritBeastView): boolean {
  const cost = beast.upgradeCost;
  return cost !== null && balanceOf('spiritStone') >= cost.spiritStone && balanceOf('spiritualEnergy') >= cost.spiritualEnergy;
}
function levelPercent(beast: SpiritBeastView): number {
  const max = panel.value?.maxLevel ?? 20;
  return Math.min(100, (beast.level / max) * 100);
}

function open(beast: SpiritBeastView): void {
  detailId.value = beast.id;
  confirmRelease.value = false;
  equipTargets.value = beast.discipleId === null ? [] : [beast.discipleId];
}
function closeDetail(): void {
  detailId.value = null;
  confirmRelease.value = false;
}

function successText(beast: SpiritBeastView, action: ManageAction): string {
  const name = beast.species.name;
  switch (action) {
    case 'equip':
      return `${equipTarget.value?.name ?? '弟子'}携带了${name}。`;
    case 'unequip':
      return `${name}已卸下，回到灵兽苑待命。`;
    case 'upgrade':
      return `${name}升至 Lv.${String(beast.level + 1)}。`;
    case 'lock':
      return beast.locked ? `${name}已解锁。` : `${name}已锁定，不会被误放生。`;
    case 'release':
      return `${name}已放生，图鉴记录保留。`;
  }
}

async function manage(beast: SpiritBeastView, action: ManageAction): Promise<void> {
  if (pending.value) return;
  if (action === 'release' && !confirmRelease.value) {
    confirmRelease.value = true;
    return;
  }
  const discipleId = action === 'equip' ? equipTargets.value[0] : undefined;
  if (action === 'equip' && discipleId === undefined) return;
  const message = successText(beast, action);
  pending.value = true;
  try {
    const result = await manageSpiritBeast(
      beast.id,
      beast.version,
      action,
      crypto.randomUUID(),
      discipleId,
      action === 'lock' ? !beast.locked : undefined,
    );
    panel.value = result.beasts;
    emit('state-update', result.state);
    emit('notify', 'success', '灵兽苑', message);
    if (action === 'release') closeDetail();
    confirmRelease.value = false;
  } catch (caught) {
    emit('notify', 'warning', '灵兽苑', caught instanceof Error ? caught.message : '操作失败');
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
  } catch (caught) {
    emit('notify', 'warning', '灵兽苑', caught instanceof Error ? caught.message : '读取失败');
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="garden" aria-labelledby="garden-title">
    <div class="beast-head modal-head">
      <h3 id="garden-title" class="beast-title">
        <span>灵兽苑</span>
        <span v-if="panel" class="beast-title-sub">{{ panel.items.length }}/{{ panel.capacity }} · 随行 {{ carriedCount }}</span>
      </h3>
      <button class="beast-quiet-button" type="button" @click="emit('open-capture')">去捕捉</button>
    </div>

    <p v-if="!panel" class="beast-empty">{{ loading ? '正在清点灵兽……' : '暂未读取到灵兽信息，请稍后再试。' }}</p>

    <template v-else>
      <p v-if="!panel.unlocked" class="beast-lock">宗门 {{ panel.unlockLevel }} 级开放灵兽玩法。</p>

      <template v-else-if="panel.items.length === 0">
        <div class="garden-empty">
          <p>灵兽苑还空着。到秘境探索的「宠物秘境」里，派弟子去山野寻找第一只灵兽吧。</p>
          <button class="action-button primary-action" type="button" @click="emit('open-capture')">前往宠物秘境</button>
        </div>
      </template>

      <template v-else>
        <div class="garden-filters">
          <div class="filter-group" role="group" aria-label="按五行筛选">
            <span class="filter-label">五行</span>
            <button class="filter-chip" type="button" :aria-pressed="elementFilter === ''" @click="elementFilter = ''">全部</button>
            <button
              v-for="option in BEAST_ELEMENT_OPTIONS"
              :key="option.id"
              class="filter-chip"
              type="button"
              :data-element="option.id"
              :aria-pressed="elementFilter === option.id"
              @click="elementFilter = option.id"
            >
              {{ option.name }}
            </button>
          </div>
          <div class="filter-group" role="group" aria-label="按品质筛选">
            <span class="filter-label">品质</span>
            <button class="filter-chip" type="button" :aria-pressed="qualityFilter === ''" @click="qualityFilter = ''">全部</button>
            <button
              v-for="option in BEAST_QUALITY_OPTIONS"
              :key="option.id"
              class="filter-chip"
              type="button"
              :data-quality="option.id"
              :aria-pressed="qualityFilter === option.id"
              @click="qualityFilter = option.id"
            >
              {{ option.name }}
            </button>
          </div>
        </div>

        <p v-if="items.length === 0" class="beast-empty">没有符合筛选条件的灵兽。</p>
        <ul v-else class="garden-grid">
          <li v-for="beast in items" :key="beast.id">
            <button
              class="garden-card"
              :class="{ 'is-carried': beast.discipleId !== null }"
              type="button"
              :data-element="beast.species.element"
              :data-quality="beast.quality"
              @click="open(beast)"
            >
              <span class="beast-avatar garden-avatar">
                <img v-if="beast.species.avatar" :src="beast.species.avatar" :alt="beast.species.name" width="96" height="96" loading="lazy" decoding="async" />
                <span v-else>{{ beast.species.glyph }}</span>
              </span>
              <span class="garden-card-body">
                <span class="garden-card-name">
                  <strong>{{ beast.species.name }}</strong>
                  <span class="garden-level">Lv.{{ beast.level }}</span>
                </span>
                <span class="garden-card-chips">
                  <span class="beast-chip is-quality">{{ beast.qualityName }}</span>
                  <span class="beast-chip is-element">{{ beast.species.elementName }}</span>
                  <span class="beast-chip" :class="`is-tier-${beast.species.tier}`">{{ beast.species.tierName }}</span>
                </span>
                <span class="garden-holder">
                  <span :class="{ 'is-on': beast.discipleId !== null }">{{ beast.discipleName ? `随行 · ${beast.discipleName}` : '待命' }}</span>
                  <span v-if="beast.locked" class="garden-locked">已锁定</span>
                </span>
              </span>
            </button>
          </li>
        </ul>
      </template>
    </template>

    <!-- 二级弹窗：灵兽详情（装备 / 升级 / 锁定 / 放生） -->
    <ModalShell v-if="selected && panel" label="灵兽详情" :loading="pending" loading-text="灵兽苑处理中" @close="closeDetail">
      <section class="garden-detail" :data-element="selected.species.element" :data-quality="selected.quality" aria-labelledby="garden-detail-title">
        <div class="beast-head modal-head">
          <h3 id="garden-detail-title" class="beast-title">
            <span>{{ selected.species.name }}</span>
            <span class="beast-title-sub">{{ selected.discipleName ? `随行 · ${selected.discipleName}` : '待命' }}</span>
          </h3>
        </div>

        <div class="detail-hero">
          <div class="detail-portrait">
            <img v-if="selected.species.image" :src="selected.species.image" :alt="selected.species.name" />
            <span v-else>{{ selected.species.glyph }}</span>
          </div>
          <div class="detail-info">
            <p class="detail-chips">
              <span class="beast-chip is-quality">{{ selected.qualityName }}</span>
              <span class="beast-chip is-element">{{ selected.species.elementName }}行</span>
              <span class="beast-chip" :class="`is-tier-${selected.species.tier}`">{{ selected.species.tierName }}</span>
              <span v-if="selected.locked" class="beast-chip">已锁定</span>
            </p>
            <div class="detail-level">
              <span>Lv.{{ selected.level }}<small>/{{ panel.maxLevel }}</small></span>
              <span class="detail-level-track"><span class="detail-level-fill" :style="{ width: `${levelPercent(selected)}%` }" /></span>
            </div>
            <ul class="detail-attrs">
              <li v-for="attr in beastAttrList(selected.attrs)" :key="attr.key">
                <span>{{ attr.label }}</span><strong>+{{ attr.value }}</strong>
              </li>
            </ul>
            <p class="detail-skill"><b>【{{ selected.species.skillName }}】</b>{{ selected.skillText }}</p>
          </div>
        </div>

        <div class="detail-actions">
          <div class="detail-upgrade">
            <span v-if="selected.upgradeCost">
              升到 Lv.{{ selected.level + 1 }}：{{ formatAmount(String(selected.upgradeCost.spiritStone)) }} 灵石 ＋
              {{ formatAmount(String(selected.upgradeCost.spiritualEnergy)) }} 灵气
            </span>
            <span v-else>已满级</span>
            <button
              class="action-button primary-action"
              type="button"
              :disabled="pending || !affordable(selected)"
              @click="manage(selected, 'upgrade')"
            >
              {{ selected.upgradeCost && !affordable(selected) ? '资源不足' : '升级' }}
            </button>
          </div>
          <div class="detail-buttons">
            <button v-if="selected.discipleId" class="beast-quiet-button" type="button" :disabled="pending" @click="manage(selected, 'unequip')">卸下</button>
            <button class="beast-quiet-button" type="button" :disabled="pending" @click="manage(selected, 'lock')">
              {{ selected.locked ? '解锁' : '锁定' }}
            </button>
            <button
              class="beast-quiet-button is-danger"
              type="button"
              :disabled="pending || selected.locked || selected.discipleId !== null"
              :title="selected.locked || selected.discipleId ? '先解锁并卸下才能放生' : '放生不返还资源'"
              @click="manage(selected, 'release')"
            >
              {{ confirmRelease ? '确认放生（不返还资源）' : '放生' }}
            </button>
            <button v-if="confirmRelease" class="beast-quiet-button" type="button" @click="confirmRelease = false">取消</button>
          </div>
        </div>

        <section class="detail-equip" aria-label="携带弟子">
          <DisciplePicker
            v-model:selected="equipTargets"
            :disciples="state.disciples"
            mode="single"
            :min="1"
            :max="1"
            :busy="pending"
            :block-injured="false"
            sort="power"
            title="选择携带弟子"
          />
          <div class="detail-equip-bar">
            <p>每名弟子携带一只；换人时对方原有的灵兽自动卸下。</p>
            <button
              class="action-button primary-action"
              type="button"
              :disabled="pending || equipTarget === null || equipTarget.id === selected.discipleId"
              @click="manage(selected, 'equip')"
            >
              {{
                equipTarget === null
                  ? '请选择弟子'
                  : equipTarget.id === selected.discipleId
                    ? `${equipTarget.name}正在携带`
                    : `让${equipTarget.name}携带`
              }}
            </button>
          </div>
        </section>
      </section>
    </ModalShell>
  </section>
</template>

<style scoped>
.garden {
  display: grid;
  gap: 14px;
}

.garden-empty {
  display: grid;
  justify-items: center;
  gap: 12px;
  padding: 28px 12px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}

.garden-empty p {
  margin: 0;
}

/* ---------- 筛选 ---------- */

.garden-filters {
  display: grid;
  gap: 8px;
}

.filter-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.filter-label {
  width: 32px;
  color: var(--faint);
  font-size: 12px;
}

.filter-chip {
  padding: 2px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  line-height: 20px;
  cursor: pointer;
}

.filter-chip:hover {
  border-color: rgba(202, 169, 106, 0.4);
  color: var(--ink-text);
}

.filter-chip[aria-pressed='true'] {
  border-color: rgba(202, 169, 106, 0.6);
  background: rgba(202, 169, 106, 0.12);
  color: var(--gold-bright);
}

.filter-chip[data-element][aria-pressed='true'] {
  border-color: rgba(var(--el-rgb), 0.7);
  background: rgba(var(--el-rgb), 0.14);
  color: var(--el);
}

.filter-chip[data-quality][aria-pressed='true'] {
  border-color: rgba(var(--q-rgb), 0.7);
  background: rgba(var(--q-rgb), 0.14);
  color: var(--q);
}

/* ---------- 灵兽卡片 ---------- */

.garden-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.garden-card {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-left: 3px solid rgba(var(--q-rgb), 0.75);
  border-radius: 8px;
  background: var(--surface);
  color: var(--ink-text);
  text-align: left;
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease, transform 140ms ease;
}

.garden-card:hover {
  border-color: rgba(var(--q-rgb), 0.5);
  border-left-color: var(--q);
  background: var(--surface-strong);
}

.garden-card:active {
  transform: translateY(1px);
}

.garden-card.is-carried {
  background: linear-gradient(90deg, rgba(119, 184, 154, 0.1), transparent 70%), var(--surface);
}

.garden-avatar {
  --beast-avatar-size: 52px;
}

.garden-card-body {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.garden-card-name {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.garden-card-name strong {
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.garden-level {
  color: var(--gold);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.garden-card-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.garden-holder {
  display: flex;
  gap: 8px;
  color: var(--faint);
  font-size: 11px;
}

.garden-holder .is-on {
  color: var(--jade-bright);
}

.garden-locked {
  color: var(--gold);
}

/* ---------- 详情（二级弹窗） ---------- */

.garden-detail {
  display: grid;
  gap: 16px;
}

.detail-hero {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 18px;
  padding: 14px;
  border: 1px solid rgba(var(--el-rgb), 0.3);
  border-radius: 10px;
  background: radial-gradient(120% 90% at 0% 0%, rgba(var(--el-rgb), 0.14), transparent 60%), var(--surface);
}

.detail-portrait {
  display: grid;
  place-items: center;
  width: 150px;
  height: 150px;
  border: 1px solid rgba(var(--q-rgb), 0.55);
  border-radius: 12px;
  background: radial-gradient(circle at 50% 42%, rgba(var(--el-rgb), 0.28), rgba(6, 16, 15, 0.7) 70%);
  box-shadow: 0 0 22px rgba(var(--q-rgb), 0.16);
  color: var(--el);
  font-family: serif;
  font-size: 60px;
}

.detail-portrait img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.detail-info {
  display: grid;
  align-content: start;
  gap: 10px;
  min-width: 0;
}

.detail-info p {
  margin: 0;
}

.detail-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.detail-level {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  color: var(--gold-bright);
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}

.detail-level small {
  color: var(--faint);
  font-size: 12px;
}

.detail-level-track {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
}

.detail-level-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--gold-dark), var(--gold-bright));
}

.detail-attrs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.detail-attrs li {
  display: flex;
  gap: 6px;
  padding: 3px 10px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.02);
  color: var(--muted);
  font-size: 12px;
}

.detail-attrs strong {
  color: var(--jade-bright);
  font-weight: 600;
}

.detail-skill {
  color: #c7d3cc;
  font-size: 12px;
  line-height: 1.7;
}

.detail-skill b {
  color: var(--el);
  font-weight: 600;
}

.detail-actions {
  display: grid;
  gap: 10px;
}

.detail-upgrade {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.015);
  color: var(--muted);
  font-size: 12px;
}

.detail-upgrade .action-button {
  flex: 0 0 auto;
  min-width: 96px;
}

.detail-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.detail-buttons .is-danger:not(:disabled) {
  border-color: rgba(224, 123, 104, 0.5);
  background: rgba(224, 123, 104, 0.08);
  color: var(--red-bright);
}

.detail-buttons button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.detail-equip {
  display: grid;
  gap: 10px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.detail-equip-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.detail-equip-bar p {
  margin: 0;
  color: var(--faint);
  font-size: 12px;
}

.detail-equip-bar .action-button {
  flex: 0 0 auto;
  min-width: 160px;
}

@media (max-width: 640px) {
  .garden-grid {
    grid-template-columns: 1fr;
  }

  .detail-hero {
    grid-template-columns: 1fr;
    justify-items: center;
  }

  .detail-portrait {
    width: 128px;
    height: 128px;
  }

  .detail-info {
    width: 100%;
  }

  .detail-upgrade {
    flex-direction: column;
    align-items: stretch;
  }

  .detail-equip-bar {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
