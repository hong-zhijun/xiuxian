<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { BeastQuality, SpiritBeastView } from '@xiuxian/contracts';

import { fetchSpiritBeasts, manageSpiritBeast, type DiscipleView, type SectStateView } from '../api/game';
import type { ToastTone } from '../types/ui';
import { selectionBlockReason } from '../utils/discipleFilter';
import ModalShell from './ModalShell.vue';

/**
 * 弟子详情 → 灵兽卡片「更换」：为这名弟子选一只灵兽（或卸下），与「主修功法」同一种二级弹窗。
 * 列出灵兽苑里的全部灵兽；被别的弟子带着的也能选，确认后从对方身上换过来。
 * 装备 / 卸下要求弟子空闲（服务端 requireFree 同一口径），不满足时直接在弹窗里说明原因。
 */
const props = defineProps<{ state: SectStateView; disciple: DiscipleView }>();
const emit = defineEmits<{
  close: [];
  'state-update': [state: SectStateView];
  notify: [tone: ToastTone, title: string, message: string];
}>();

/** 选项值：灵兽 id；空串 = 卸下。 */
const UNEQUIP = '';
const TIER_RANK = { divine: 3, rare: 2, spirit: 1 } as const;
const QUALITY_RANK: Record<BeastQuality, number> = { immortal: 4, treasure: 3, spirit: 2, common: 1 };

const beasts = ref<SpiritBeastView[] | null>(null);
const loadError = ref('');
const pending = ref(false);
const current = computed(() => beasts.value?.find((item) => item.discipleId === props.disciple.id) ?? null);
const draft = ref<string | null>(null);
const selectedValue = computed(() => draft.value ?? current.value?.id ?? null);

const serverNowMs = computed(() => Date.parse(props.state.serverNow));
/** 灵兽装备、卸下都要求弟子空闲：在外、坐镇、执事、捕捉中会被服务端拒绝；疗伤不影响。 */
function busyReasonOf(discipleId: string): string | null {
  const member = props.state.disciples.find((item) => item.id === discipleId);
  if (member === undefined) return null;
  return selectionBlockReason(member, serverNowMs.value, { blockInjured: false, blockAway: true, blockSteward: true });
}
const selfBlocked = computed(() => busyReasonOf(props.disciple.id));

/** 当前携带的在最前，其次是待命的，再按档次、品质、等级从高到低。 */
const options = computed(() =>
  (beasts.value ?? []).slice().sort((a, b) =>
    Number(b.discipleId === props.disciple.id) - Number(a.discipleId === props.disciple.id)
    || Number(a.discipleId !== null) - Number(b.discipleId !== null)
    || TIER_RANK[b.species.tier] - TIER_RANK[a.species.tier]
    || QUALITY_RANK[b.quality] - QUALITY_RANK[a.quality]
    || b.level - a.level),
);

/** 别的弟子带着、而那名弟子此刻不空闲：换不过来。 */
function holderBlocked(beast: SpiritBeastView): string | null {
  if (beast.discipleId === null || beast.discipleId === props.disciple.id) return null;
  const reason = busyReasonOf(beast.discipleId);
  return reason === null ? null : `${beast.discipleName ?? '弟子'}${reason}，暂不能换走`;
}
function holderNote(beast: SpiritBeastView): string {
  if (beast.discipleId === props.disciple.id) return '当前携带';
  if (beast.discipleId !== null) return holderBlocked(beast) ?? `${beast.discipleName ?? '其他弟子'}携带中，确认后换给${props.disciple.name}`;
  return '待命';
}

const chosen = computed(() => beasts.value?.find((item) => item.id === selectedValue.value) ?? null);
const unchanged = computed(() => selectedValue.value === (current.value?.id ?? UNEQUIP) || selectedValue.value === null);

async function confirm(): Promise<void> {
  if (pending.value || unchanged.value || selfBlocked.value !== null) return;
  const target = selectedValue.value === UNEQUIP ? current.value : chosen.value;
  if (target === null) return;
  const equip = selectedValue.value !== UNEQUIP;
  pending.value = true;
  try {
    const result = await manageSpiritBeast(
      target.id,
      target.version,
      equip ? 'equip' : 'unequip',
      crypto.randomUUID(),
      equip ? props.disciple.id : undefined,
    );
    emit('state-update', result.state);
    emit('notify', 'success', '灵兽', equip
      ? `${props.disciple.name}携带了${target.qualityName}${target.species.name}。`
      : `${target.species.name}已卸下，回到灵兽苑待命。`);
    emit('close');
  } catch (caught) {
    emit('notify', 'warning', '灵兽', caught instanceof Error ? caught.message : '操作失败');
    try {
      beasts.value = (await fetchSpiritBeasts()).beasts.items;
      draft.value = null;
    } catch {
      /* 保留原来的错误提示 */
    }
  } finally {
    pending.value = false;
  }
}

onMounted(async () => {
  try {
    const panel = (await fetchSpiritBeasts()).beasts;
    beasts.value = panel.unlocked ? panel.items : [];
    if (!panel.unlocked) loadError.value = `宗门 ${String(panel.unlockLevel)} 级开放灵兽玩法。`;
  } catch (caught) {
    loadError.value = caught instanceof Error ? caught.message : '读取失败';
  }
});
</script>

<template>
  <ModalShell narrow :loading="pending" loading-text="正在更换灵兽" :label="`携带灵兽 · ${disciple.name}`" @close="emit('close')">
    <section class="beast-picker" aria-labelledby="beast-picker-title">
      <h3 id="beast-picker-title" class="beast-picker-title">选择携带灵兽 · {{ disciple.name }}</h3>

      <p v-if="selfBlocked" class="beast-picker-warn" role="status">{{ disciple.name }}{{ selfBlocked }}，空闲后才能更换灵兽。</p>

      <p v-if="beasts === null && loadError === ''" class="beast-picker-empty">正在清点灵兽……</p>
      <p v-else-if="loadError" class="beast-picker-empty">{{ loadError }}</p>
      <p v-else-if="options.length === 0" class="beast-picker-empty">灵兽苑还空着，先到秘境探索的「宠物秘境」捕捉灵兽吧。</p>

      <ul v-else class="beast-picker-list" role="radiogroup" aria-label="携带灵兽">
        <li v-for="beast in options" :key="beast.id">
          <button
            class="beast-picker-option"
            :class="{ 'is-selected': selectedValue === beast.id }"
            type="button"
            role="radio"
            :data-element="beast.species.element"
            :data-quality="beast.quality"
            :aria-checked="selectedValue === beast.id"
            :disabled="holderBlocked(beast) !== null"
            @click="draft = beast.id"
          >
            <span class="beast-avatar beast-picker-avatar">
              <img :src="beast.species.avatar ?? ''" :alt="beast.species.name" width="96" height="96" loading="lazy" decoding="async" />
            </span>
            <span class="beast-picker-body">
              <span class="beast-picker-head">
                <strong>{{ beast.species.name }}</strong>
                <span class="beast-picker-level">Lv.{{ beast.level }}</span>
                <span class="beast-chip is-quality">{{ beast.qualityName }}</span>
                <span class="beast-chip is-element">{{ beast.species.elementName }}</span>
                <span class="beast-chip" :class="`is-tier-${beast.species.tier}`">{{ beast.species.tierName }}</span>
              </span>
              <small class="beast-picker-skill"><b>【{{ beast.species.skillName }}】</b>{{ beast.skillText }}</small>
              <small class="beast-picker-holder" :class="{ 'is-current': beast.discipleId === disciple.id }">{{ holderNote(beast) }}</small>
            </span>
          </button>
        </li>
        <li v-if="current">
          <button
            class="beast-picker-option is-unequip"
            :class="{ 'is-selected': selectedValue === UNEQUIP }"
            type="button"
            role="radio"
            :aria-checked="selectedValue === UNEQUIP"
            @click="draft = UNEQUIP"
          >
            <span class="beast-picker-body">
              <span class="beast-picker-head"><strong>卸下灵兽</strong></span>
              <small class="beast-picker-holder">{{ current.species.name }}回到灵兽苑待命</small>
            </span>
          </button>
        </li>
      </ul>

      <div class="beast-picker-actions">
        <button class="quiet-button" type="button" @click="emit('close')">取消</button>
        <button
          class="action-button primary-action beast-picker-confirm"
          type="button"
          :disabled="pending || unchanged || selfBlocked !== null"
          @click="confirm"
        >
          确认
        </button>
      </div>
    </section>
  </ModalShell>
</template>

<style scoped>
.beast-picker {
  display: grid;
  gap: 10px;
}

.beast-picker-title {
  margin: 0;
  padding-right: 40px;
  color: var(--gold-bright);
  font-size: 16px;
}

.beast-picker-warn {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid rgba(202, 169, 106, 0.35);
  border-radius: 4px;
  background: rgba(202, 169, 106, 0.06);
  color: var(--gold);
  font-size: 12px;
}

.beast-picker-empty {
  margin: 0;
  padding: 18px 0;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}

.beast-picker-list {
  display: grid;
  gap: 6px;
  max-height: 60vh;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

/* 与「主修功法」选项同一套：选中金边 + 深一档底色，不依赖 outline。 */
.beast-picker-option {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-left: 3px solid rgba(var(--q-rgb, 146, 167, 157), 0.7);
  border-radius: 6px;
  background: var(--surface);
  color: var(--ink-text);
  text-align: left;
  cursor: pointer;
}

.beast-picker-option:not(:disabled):hover {
  border-color: rgba(202, 169, 106, 0.4);
}

.beast-picker-option.is-selected {
  border-color: var(--gold);
  background: var(--surface-strong);
  box-shadow: inset 0 0 0 1px rgba(202, 169, 106, 0.35);
}

.beast-picker-option:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.beast-picker-option.is-unequip {
  border-left-color: var(--line);
}

.beast-picker-avatar {
  --beast-avatar-size: 44px;
}

.beast-picker-body {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.beast-picker-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
}

.beast-picker-head strong {
  font-size: 14px;
}

.beast-picker-level {
  margin-right: 2px;
  color: var(--gold);
  font-size: 12px;
}

.beast-picker-skill {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.beast-picker-skill b {
  color: var(--el, var(--gold));
  font-weight: 600;
}

.beast-picker-holder {
  color: var(--faint);
  font-size: 11px;
}

.beast-picker-holder.is-current {
  color: var(--jade-bright);
}

.beast-picker-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}

.beast-picker-confirm {
  min-height: 36px;
  padding: 6px 18px;
}
</style>
