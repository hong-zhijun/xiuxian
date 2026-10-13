<script setup lang="ts">
import { computed } from 'vue';

import type { WorldRegionView, WorldSiteView } from '../api/game';

/**
 * 山河舆图的地图：内联 SVG（viewBox 800×520，宽度撑满，不拖动、不缩放）。
 *
 * 五个域各一块多边形，中州居中，东西南北四域围绕；域内画该域灵地的小圆点：
 * 本宗玉绿实心、他宗红实心、妖兽盘踞灰色空心。几何（多边形顶点、圆点坐标）只是展示用，写死在这里，按 id 对应；
 * 域的选中只通过 `select` 往上抛，选中态由父组件持有。
 */
const props = defineProps<{
  regions: readonly WorldRegionView[];
  sites: readonly WorldSiteView[];
  /** 当前选中的域 id（金边高亮）。 */
  selectedId: string;
}>();

const emit = defineEmits<{
  select: [regionId: string];
}>();

interface RegionShape {
  /** 多边形顶点（SVG points）。 */
  points: string;
  /** 文字居中的 x，以及域名 / 主产两行的基线 y。 */
  x: number;
  nameY: number;
  productY: number;
  /** 域色（RGB 三元组，经 CSS 变量 --region-rgb 上色：主产 药材绿 / 矿石赤铜 / 灵气青 / 灵石金 / 中州紫）。 */
  rgb: string;
}

/** 五域几何（按域 id）。东在右、西在左、北在上、南在下，四域与中州之间留出一道缝。 */
const REGION_SHAPES: Record<string, RegionShape | undefined> = {
  north: {
    points: '246,44 402,22 554,44 530,164 402,176 270,164',
    x: 400,
    nameY: 74,
    productY: 106,
    rgb: '214, 178, 94',
  },
  south: {
    points: '270,356 402,344 530,356 554,476 402,498 246,476',
    x: 400,
    nameY: 396,
    productY: 428,
    rgb: '95, 196, 214',
  },
  west: {
    points: '34,150 222,118 232,262 222,406 34,374',
    x: 128,
    nameY: 186,
    productY: 218,
    rgb: '200, 116, 74',
  },
  east: {
    points: '578,118 766,150 766,374 578,406 568,262',
    x: 672,
    nameY: 186,
    productY: 218,
    rgb: '111, 191, 115',
  },
  center: {
    points: '300,200 500,200 546,262 500,324 300,324 254,262',
    x: 400,
    nameY: 236,
    productY: 268,
    rgb: '155, 123, 209',
  },
};

/** 灵地圆点坐标（按 site id；与服务端 WORLD_SITES 的 14 个 id 一一对应）。 */
const SITE_POINTS: Record<string, { x: number; y: number } | undefined> = {
  'north-lingdi': { x: 336, y: 132 },
  'north-fudi': { x: 400, y: 132 },
  'north-dongtian': { x: 464, y: 132 },
  'south-lingdi': { x: 336, y: 456 },
  'south-fudi': { x: 400, y: 456 },
  'south-dongtian': { x: 464, y: 456 },
  'west-lingdi': { x: 128, y: 266 },
  'west-fudi': { x: 128, y: 316 },
  'west-dongtian': { x: 128, y: 366 },
  'east-lingdi': { x: 672, y: 266 },
  'east-fudi': { x: 672, y: 316 },
  'east-dongtian': { x: 672, y: 366 },
  'center-xuantie': { x: 362, y: 298 },
  'center-shenmu': { x: 438, y: 298 },
};

/** 能画出来的域（服务端给的域里没有几何的一律跳过）。 */
const drawnRegions = computed(() => props.regions.filter((region) => REGION_SHAPES[region.id] !== undefined));

function shapeOf(regionId: string): RegionShape {
  // drawnRegions 已筛过，这里的兜底只为类型收窄，实际不会走到。
  return REGION_SHAPES[regionId] ?? { points: '', x: 0, nameY: 0, productY: 0, rgb: '255, 255, 255' };
}

/** 域内的灵地（有坐标的才画）。 */
function sitesOf(regionId: string): WorldSiteView[] {
  return props.sites.filter((site) => site.regionId === regionId && SITE_POINTS[site.id] !== undefined);
}

function pointOf(siteId: string): { x: number; y: number } {
  return SITE_POINTS[siteId] ?? { x: 0, y: 0 };
}

/** 圆点的状态：本宗 / 他宗 / 妖兽盘踞。 */
function dotClass(site: WorldSiteView): string {
  if (site.holder === null) return 'is-beast';
  return site.holder.isMe ? 'is-mine' : 'is-other';
}

function siteStateText(site: WorldSiteView): string {
  if (site.holder === null) return '妖兽盘踞';
  return site.holder.isMe ? '本宗占据' : `${site.holder.name}占据`;
}

/** 每个域的本宗 / 他宗 / 妖兽处数（给读屏用的域名说明）。 */
const regionCounts = computed(() => {
  const counts = new Map<string, { mine: number; other: number; beast: number }>();
  for (const site of props.sites) {
    const entry = counts.get(site.regionId) ?? { mine: 0, other: 0, beast: 0 };
    if (site.holder === null) entry.beast += 1;
    else if (site.holder.isMe) entry.mine += 1;
    else entry.other += 1;
    counts.set(site.regionId, entry);
  }
  return counts;
});

function regionAria(region: WorldRegionView): string {
  const counts = regionCounts.value.get(region.id) ?? { mine: 0, other: 0, beast: 0 };
  const product = region.resourceName === null ? '祖脉' : `主产${region.resourceName}`;
  return `${region.name}，${product}：本宗 ${String(counts.mine)} 处，他宗 ${String(counts.other)} 处，妖兽盘踞 ${String(counts.beast)} 处`;
}

/** 中州没有单一主产：标「灵气 · 稀有」（祖脉的产出）。 */
function productLabel(region: WorldRegionView): string {
  return region.resourceName ?? '灵气 · 稀有';
}

function regionStyle(regionId: string): Record<string, string> {
  return { '--region-rgb': shapeOf(regionId).rgb };
}

function select(regionId: string): void {
  emit('select', regionId);
}
</script>

<template>
  <div class="world-map">
    <svg class="world-map-svg" viewBox="0 0 800 520" role="group" aria-label="山河舆图：五域灵地分布">
      <rect class="world-map-bg" x="0" y="0" width="800" height="520" rx="12" />

      <g
        v-for="region in drawnRegions"
        :key="region.id"
        class="world-region"
        :class="{ 'is-selected': region.id === selectedId }"
        :style="regionStyle(region.id)"
        role="button"
        tabindex="0"
        :aria-pressed="region.id === selectedId"
        :aria-label="regionAria(region)"
        @click="select(region.id)"
        @keydown.enter.prevent="select(region.id)"
        @keydown.space.prevent="select(region.id)"
      >
        <polygon class="world-region-shape" :points="shapeOf(region.id).points" />
        <text class="world-region-name" :x="shapeOf(region.id).x" :y="shapeOf(region.id).nameY">{{ region.name }}</text>
        <text class="world-region-product" :x="shapeOf(region.id).x" :y="shapeOf(region.id).productY">{{ productLabel(region) }}</text>
        <circle
          v-for="site in sitesOf(region.id)"
          :key="site.id"
          class="world-site-dot"
          :class="dotClass(site)"
          :cx="pointOf(site.id).x"
          :cy="pointOf(site.id).y"
          r="12"
        >
          <title>{{ site.name }}（{{ site.tierName }}）· {{ siteStateText(site) }}</title>
        </circle>
      </g>
    </svg>

    <ul class="world-legend" aria-label="地图图例">
      <li><i class="world-legend-dot is-mine" aria-hidden="true" />本宗</li>
      <li><i class="world-legend-dot is-other" aria-hidden="true" />他宗</li>
      <li><i class="world-legend-dot is-beast" aria-hidden="true" />妖兽盘踞</li>
      <li><i class="world-legend-frame" aria-hidden="true" />金边为正在查看的域</li>
    </ul>
  </div>
</template>

<style scoped>
.world-map {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.world-map-svg {
  display: block;
  width: 100%;
  max-width: 100%;
  height: auto;
  user-select: none;
}

.world-map-bg {
  fill: rgba(9, 24, 20, 0.86);
  stroke: rgba(202, 169, 106, 0.2);
  stroke-width: 1.5;
}

.world-region {
  cursor: pointer;
  outline: none;
}

.world-region-shape {
  fill: rgba(var(--region-rgb), 0.12);
  stroke: rgba(var(--region-rgb), 0.75);
  stroke-width: 2;
  transition: fill 150ms ease, stroke 150ms ease;
}

.world-region:hover .world-region-shape {
  fill: rgba(var(--region-rgb), 0.2);
}

.world-region.is-selected .world-region-shape {
  fill: rgba(var(--region-rgb), 0.22);
  stroke: var(--gold-bright, #ead19a);
  stroke-width: 4;
}

.world-region:focus-visible .world-region-shape {
  stroke: var(--gold-bright, #ead19a);
  stroke-width: 3;
}

.world-region-name,
.world-region-product {
  text-anchor: middle;
  /* 深色描边让文字压在域色上也清楚。 */
  stroke: rgba(6, 16, 14, 0.85);
  stroke-width: 6px;
  paint-order: stroke;
  pointer-events: none;
}

.world-region-name {
  fill: #f1e6c8;
  font-size: 34px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.world-region-product {
  fill: rgb(var(--region-rgb));
  font-size: 26px;
}

.world-site-dot {
  pointer-events: none;
  stroke-width: 3;
}

.world-site-dot.is-mine {
  fill: #6fc79a;
  stroke: #0b1f19;
}

.world-site-dot.is-other {
  fill: #d0584a;
  stroke: #2a0d09;
}

.world-site-dot.is-beast {
  fill: none;
  stroke: #9aa7a0;
}

.world-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 14px;
  margin: 0;
  padding: 0;
  list-style: none;
  color: #8fa79b;
  font-size: 12px;
}

.world-legend li {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.world-legend-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.world-legend-dot.is-mine {
  background: #6fc79a;
}

.world-legend-dot.is-other {
  background: #d0584a;
}

.world-legend-dot.is-beast {
  border: 2px solid #9aa7a0;
  background: transparent;
}

.world-legend-frame {
  display: inline-block;
  width: 12px;
  height: 10px;
  border: 2px solid var(--gold-bright, #ead19a);
  border-radius: 2px;
}
</style>
