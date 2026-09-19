<script setup lang="ts">
import { computed, ref } from 'vue';

import type { AlchemyRecipeView, DiscipleView, SectStateView } from '../api/game';
import { formatAmount } from '../utils/format';

/**
 * 炼丹面板（弹窗内容）：配方炼制 + 弟子服药。
 *
 * 规则全部以服务端算好的 alchemy / disciples 字段为准：canCraft、blockedReason、
 * 淬体短板预览（bodyTemperingTarget / bodyTemperingGain）都不在前端复算；
 * 前端只做数量步进（1~5）与按钮派发。
 */
const props = defineProps<{
  state: SectStateView;
  busy: boolean;
}>();

const emit = defineEmits<{
  craft: [pillId: string, quantity: number];
  use: [pillId: string, discipleId: string];
}>();

const QUANTITY_MIN = 1;
const QUANTITY_MAX = 5;

/** 每个配方的炼制数量（1~5，默认 1）。 */
const quantities = ref<Record<string, number>>(
  Object.fromEntries(props.state.alchemy.recipes.map((recipe) => [recipe.id, 1])),
);

function stepQuantity(pillId: string, delta: number): void {
  const current = quantities.value[pillId] ?? QUANTITY_MIN;
  quantities.value = {
    ...quantities.value,
    [pillId]: Math.min(QUANTITY_MAX, Math.max(QUANTITY_MIN, current + delta)),
  };
}

const resourceName = computed<Record<string, string>>(() =>
  Object.fromEntries(props.state.resources.map((resource) => [resource.id, resource.name])),
);
const resourceBalance = computed<Record<string, number>>(() =>
  Object.fromEntries(props.state.resources.map((resource) => [resource.id, Number(resource.balance)])),
);

function costText(cost: Record<string, string>, quantity = 1): string {
  return Object.entries(cost)
    .map(
      ([resourceId, amount]) =>
        `${resourceName.value[resourceId] ?? resourceId} ${formatAmount(Number(amount) * quantity)}`,
    )
    .join(' · ');
}

function canCraftSelected(recipe: AlchemyRecipeView): boolean {
  const quantity = quantities.value[recipe.id] ?? QUANTITY_MIN;
  return recipe.canCraft && Object.entries(recipe.cost).every(
    ([resourceId, amount]) => (resourceBalance.value[resourceId] ?? 0) >= Number(amount) * quantity,
  );
}

function recipeOwned(pillId: string): number {
  return props.state.alchemy.recipes.find((recipe) => recipe.id === pillId)?.owned ?? 0;
}

function onCraft(recipe: AlchemyRecipeView): void {
  if (props.busy || !canCraftSelected(recipe)) return;
  emit('craft', recipe.id, quantities.value[recipe.id] ?? QUANTITY_MIN);
}

const ATTRIBUTE_NAMES: Record<string, string> = { attack: '攻击', defense: '防御', speed: '身法' };

function attributeName(attribute: string): string {
  return ATTRIBUTE_NAMES[attribute] ?? attribute;
}

/** 一条可执行的服药建议：目标弟子 + 丹药 + 效果预览 + 禁用原因。 */
interface UseOption {
  key: string;
  discipleId: string;
  discipleName: string;
  pillId: string;
  pillName: string;
  preview: string;
  stock: number;
}

/** 弟子用药建议（服务端规则的镜像展示；真正能否服用由服务端最终校验）。 */
const useOptions = computed<UseOption[]>(() => {
  if (!props.state.alchemy.unlocked) return [];
  const serverNow = Date.parse(props.state.serverNow);
  const pillName = (pillId: string): string =>
    props.state.alchemy.recipes.find((recipe) => recipe.id === pillId)?.name ?? pillId;

  const options: UseOption[] = [];
  const push = (
    disciple: DiscipleView,
    pillId: string,
    preview: string,
  ): void => {
    options.push({
      key: `${disciple.id}:${pillId}`,
      discipleId: disciple.id,
      discipleName: disciple.name,
      pillId,
      pillName: pillName(pillId),
      preview,
      stock: recipeOwned(pillId),
    });
  };

  for (const disciple of props.state.disciples) {
    const injured =
      disciple.injuredUntil !== null && Date.parse(disciple.injuredUntil) > serverNow;
    if (injured) {
      push(disciple, 'healingPill', '清除伤势，立刻可再出战');
    }
    if (disciple.requiredCultivation !== null && disciple.cultivation < disciple.requiredCultivation) {
      const gain = Math.min(120, disciple.requiredCultivation - disciple.cultivation);
      push(disciple, 'cultivationPill', `修为 +${gain}（达到 ${disciple.requiredCultivation} 门槛为止）`);
    }
    if (disciple.bodyTemperingTarget !== null) {
      push(
        disciple,
        'bodyTemperingPill',
        `本次补：${attributeName(disciple.bodyTemperingTarget)} +${disciple.bodyTemperingGain}`,
      );
    }
  }
  return options;
});

function onUse(option: UseOption): void {
  if (props.busy || option.stock < 1) return;
  emit('use', option.pillId, option.discipleId);
}
</script>

<template>
  <section class="alchemy-panel" aria-labelledby="alchemy-title">
    <header class="section-heading panel-heading compact-heading">
      <div>
        <p class="eyebrow">灵药园 · 丹房</p>
        <h2 id="alchemy-title">炼丹</h2>
      </div>
      <span class="count-badge">{{ useOptions.length }} 条用药建议</span>
    </header>

    <div v-if="!state.alchemy.unlocked" class="empty-state alchemy-locked">
      <span aria-hidden="true">丹</span>
      <strong>炼丹尚未开启</strong>
      <p>需要：宗门 2 级、灵药园 2 级</p>
      <p v-if="state.alchemy.blockedReason" class="blocked-hint">{{ state.alchemy.blockedReason }}</p>
    </div>

    <template v-else>
      <ul class="alchemy-recipe-list">
        <li v-for="recipe in state.alchemy.recipes" :key="recipe.id" class="alchemy-recipe">
          <div class="alchemy-pill-glyph" aria-hidden="true">丹</div>

          <div class="alchemy-recipe-copy">
            <div class="alchemy-recipe-title">
              <strong>{{ recipe.name }}</strong>
              <span class="alchemy-owned">库存 {{ recipe.owned }}</span>
            </div>
            <p class="alchemy-recipe-desc">{{ recipe.description }}</p>
            <p class="alchemy-recipe-cost">
              {{ (quantities[recipe.id] ?? 1) === 1 ? '单颗' : `本次 ${quantities[recipe.id]} 颗` }} ·
              {{ costText(recipe.cost, quantities[recipe.id] ?? 1) }}
            </p>
            <p v-if="recipe.blockedReason || !canCraftSelected(recipe)" class="blocked-hint">
              {{ recipe.blockedReason ?? '所选数量的资源不足' }}
            </p>
          </div>

          <div class="alchemy-recipe-actions">
            <div class="alchemy-stepper" role="group" :aria-label="`炼制数量 · ${recipe.name}`">
              <button
                type="button"
                :disabled="busy || (quantities[recipe.id] ?? 1) <= 1"
                aria-label="减少一颗"
                @click="stepQuantity(recipe.id, -1)"
              >−</button>
              <span aria-live="polite">{{ quantities[recipe.id] ?? 1 }}</span>
              <button
                type="button"
                :disabled="busy || (quantities[recipe.id] ?? 1) >= 5"
                aria-label="增加一颗"
                @click="stepQuantity(recipe.id, 1)"
              >+</button>
            </div>
            <button
              class="action-button primary-action alchemy-craft-button"
              :class="{ 'is-disabled': !canCraftSelected(recipe) }"
              type="button"
              :disabled="busy || !canCraftSelected(recipe)"
              @click="onCraft(recipe)"
            >
              <span>炼制</span>
            </button>
          </div>
        </li>
      </ul>

      <div class="alchemy-use-section">
        <h3 class="alchemy-use-title">弟子用药</h3>
        <ul v-if="useOptions.length > 0" class="alchemy-use-list">
          <li v-for="option in useOptions" :key="option.key" class="alchemy-use-row">
            <div class="alchemy-use-copy">
              <strong>{{ option.discipleName }}</strong>
              <span>{{ option.pillName }} · {{ option.preview }}</span>
            </div>
            <button
              class="upgrade-button"
              :class="{ 'is-disabled': option.stock < 1 }"
              type="button"
              :disabled="busy"
              :aria-disabled="option.stock < 1"
              :title="option.stock < 1 ? '丹药库存不足' : undefined"
              @click="onUse(option)"
            >
              <span>{{ option.stock < 1 ? '无库存' : '服用' }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="alchemy-use-empty">目前没有弟子需要服药：无人受伤、修为未满门槛且没有可补的属性短板。</p>
      </div>
    </template>
  </section>
</template>
