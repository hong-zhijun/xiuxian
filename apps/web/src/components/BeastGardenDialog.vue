<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import type { BeastAttrs, BeastElement, BeastManageAction, BeastQuality, BeastTier, SpiritBeastView, SpiritBeastsPanel, BeastExchangeInput } from '@xiuxian/contracts';
import { exchangeSpiritBeast, fetchSpiritBeasts, manageSpiritBeast, releaseSpiritBeasts, type SectStateView, type SpiritBeastActionData } from '../api/game';
import { ApiError } from '../api/client';
import type { ToastTone } from '../types/ui';
import { formatAmount } from '../utils/format';
import { BEAST_ELEMENT_OPTIONS, BEAST_QUALITY_OPTIONS, beastAttrList } from '../utils/spiritBeasts';
import DisciplePicker from './DisciplePicker.vue';
import ModalShell from './ModalShell.vue';

const props = defineProps<{ state: SectStateView }>();
const emit = defineEmits<{
  'state-update': [state: SectStateView];
  notify: [tone: ToastTone, title: string, message: string];
  'open-capture': [];
  'busy-change': [busy: boolean];
}>();
const TIER_RANK = { divine: 3, rare: 2, spirit: 1 } as const;
const QUALITY_RANK: Record<BeastQuality, number> = { immortal: 4, treasure: 3, spirit: 2, common: 1 };
const panel = ref<SpiritBeastsPanel | null>(null);
const loading = ref(true);
const pending = ref(false);
const loadError = ref('');
const tab = ref<'collection' | 'exchange'>('collection');
const elementFilter = ref<BeastElement | ''>('');
const qualityFilter = ref<BeastQuality | ''>('');
const detailId = ref<string | null>(null);
const equipTargets = ref<string[]>([]);
const confirmRelease = ref(false);
const exchangeTier = ref<BeastTier>('spirit');
type ExchangeChoice = { mode: 'random'; tier: BeastTier } | { mode: 'specific'; tier: BeastTier; speciesId: string };
const exchangeChoice = ref<ExchangeChoice | null>(null);
interface Operation { run: () => Promise<SpiritBeastActionData>; message: string; after?: () => void }
const unresolved = shallowRef<Operation | null>(null);
const blocked = computed(() => pending.value || unresolved.value !== null);
watch(pending, busy => emit('busy-change', busy));
onUnmounted(() => emit('busy-change', false));
/** 默认不列随行中的灵兽（与装备背包的「显示已穿戴」一致），勾选后才显示。 */
const showCarried = ref(false);
const items = computed(() => (panel.value?.items ?? [])
  .filter(item => showCarried.value || item.discipleId === null)
  .filter(item => (elementFilter.value === '' || item.species.element === elementFilter.value) && (qualityFilter.value === '' || item.quality === qualityFilter.value))
  .slice().sort((a,b) => Number(b.discipleId !== null)-Number(a.discipleId !== null) || TIER_RANK[b.species.tier]-TIER_RANK[a.species.tier] || QUALITY_RANK[b.quality]-QUALITY_RANK[a.quality] || b.level-a.level));
const carriedCount = computed(() => panel.value?.items.filter(item => item.discipleId !== null).length ?? 0);
const selected = computed(() => panel.value?.items.find(item => item.id === detailId.value) ?? null);
const equipTarget = computed(() => props.state.disciples.find(item => item.id === equipTargets.value[0]) ?? null);
const offer = computed(() => panel.value?.exchangeOffers.find(item => item.tier === exchangeTier.value) ?? null);
const exchangeSpecies = computed(() => (panel.value?.species ?? []).filter(item => offer.value?.speciesIds.includes(item.id)));
const choiceOffer = computed(() => panel.value?.exchangeOffers.find(item => item.tier === exchangeChoice.value?.tier) ?? null);
const choiceSpecies = computed(() => {
  const choice = exchangeChoice.value;
  return choice?.mode === 'specific' ? panel.value?.species.find(item => item.id === choice.speciesId) ?? null : null;
});
const choiceCost = computed(() => exchangeChoice.value?.mode === 'specific' ? choiceOffer.value?.specificCost ?? '0' : choiceOffer.value?.randomCost ?? '0');
function balanceOf(id: string): number { return Number(props.state.resources.find(item => item.id === id)?.balance ?? 0); }
function exchangeBlock(cost: string): string | null {
  if (!offer.value?.unlocked) return '宗门 ' + String(offer.value?.requiredSectLevel ?? 3) + ' 级开放';
  if ((panel.value?.availableSlots ?? 0) < 1) return panel.value?.reservedSlots ? '需为捕捉保留一个位置，请先整理灵兽苑' : '灵兽苑已满，请先整理';
  if (balanceOf('beastEssence') < Number(cost)) return '御兽精魄不足';
  return null;
}
function affordable(beast: SpiritBeastView): boolean {
  return beast.upgradeCost !== null && balanceOf('spiritStone') >= beast.upgradeCost.spiritStone && balanceOf('spiritualEnergy') >= beast.upgradeCost.spiritualEnergy;
}
/* ---------- 批量放生：多选 + 按品质一键选中（锁定、随行的不参与），二次确认后一次提交 ---------- */
const selectedIds = ref<string[]>([]);
const confirmBatch = ref(false);
function releasable(beast: SpiritBeastView): boolean { return !beast.locked && beast.discipleId === null; }
/** 选中集合与最新视图对齐：已被装备、锁定或放生的自动剔除。 */
const selectedBeasts = computed(() => (panel.value?.items ?? []).filter(item => releasable(item) && selectedIds.value.includes(item.id)));
const batchReward = computed(() => selectedBeasts.value.reduce((sum, item) => sum + Number(item.releaseReward.beastEssence), 0));
const batchQualities = computed(() => BEAST_QUALITY_OPTIONS
  .map(option => ({ ...option, ids: (panel.value?.items ?? []).filter(item => releasable(item) && item.quality === option.id).map(item => item.id) }))
  .filter(group => group.ids.length > 0));
const lockedIdleCount = computed(() => (panel.value?.items ?? []).filter(item => item.locked && item.discipleId === null).length);
watch(selectedIds, () => { confirmBatch.value = false; });
function isPicked(id: string): boolean { return selectedIds.value.includes(id); }
function togglePick(beast: SpiritBeastView): void {
  if (blocked.value || !releasable(beast)) return;
  selectedIds.value = isPicked(beast.id) ? selectedIds.value.filter(id => id !== beast.id) : [...selectedIds.value, beast.id];
}
/** 某品质里已选了几只（批量按钮上显示部分选中）。 */
function pickedIn(ids: readonly string[]): number { return ids.filter(id => selectedIds.value.includes(id)).length; }
/** 已选但被当前筛选挡住、列表里看不到的只数。 */
const hiddenPicked = computed(() => selectedBeasts.value.filter(item => !items.value.some(visible => visible.id === item.id)).length);
function isQualityPicked(ids: readonly string[]): boolean { return ids.every(id => selectedIds.value.includes(id)); }
function toggleQuality(ids: readonly string[]): void {
  if (blocked.value) return;
  const drop = new Set(ids);
  selectedIds.value = isQualityPicked(ids) ? selectedIds.value.filter(id => !drop.has(id)) : [...new Set([...selectedIds.value, ...ids])];
}
function releaseBatch(): void {
  if (blocked.value || selectedBeasts.value.length === 0) return;
  if (!confirmBatch.value) { confirmBatch.value = true; return; }
  const beasts = selectedBeasts.value.map(item => ({ beastId: item.id, version: item.version }));
  const commandId = crypto.randomUUID();
  void perform({ run: () => releaseSpiritBeasts(beasts, commandId), message: '放生完成。', after: () => { selectedIds.value = []; } })
    .finally(() => { confirmBatch.value = false; });
}

/* ---------- 携带弟子：详情里只放按钮，点开二级弹窗再用选人组件挑 ---------- */
const equipPickerOpen = ref(false);
function openEquipPicker(beast: SpiritBeastView): void {
  if (blocked.value) return;
  equipTargets.value = beast.discipleId ? [beast.discipleId] : [];
  equipPickerOpen.value = true;
}
function breakthroughRows(beast: SpiritBeastView) {
  const cost = beast.qualityBreakthrough?.cost;
  return cost ? (['beastEssence','spiritStone','spiritualEnergy'] as const).map(id => ({ id, name: {beastEssence:'御兽精魄',spiritStone:'灵石',spiritualEnergy:'灵气'}[id], cost:cost[id], balance:balanceOf(id), lacking:balanceOf(id)<Number(cost[id]) })) : [];
}
function canBreakthrough(beast: SpiritBeastView): boolean {
  return beast.qualityBreakthrough !== null && !beast.qualityBreakthrough.blockedReason && breakthroughRows(beast).every(row => !row.lacking);
}
function previewText(beast: SpiritBeastView, attrs: BeastAttrs): string {
  return beastAttrList(attrs).map(attr => attr.label + ' ' + String(beast.attrs[attr.key]) + ' → ' + String(attr.value)).join(' · ');
}
function levelPercent(beast: SpiritBeastView): number { return Math.min(100,beast.level/(panel.value?.maxLevel ?? 20)*100); }
function open(beast: SpiritBeastView): void {
  if(blocked.value)return;
  detailId.value=beast.id;confirmRelease.value=false;equipTargets.value=beast.discipleId?[beast.discipleId]:[];
}
function closeDetail(): void { if(pending.value)return;detailId.value=null;confirmRelease.value=false;equipPickerOpen.value=false; }
function apply(data: SpiritBeastActionData): void { panel.value=data.beasts;emit('state-update',data.state); }
async function refreshPanel(): Promise<boolean> {
  loading.value=true;
  try { apply(await fetchSpiritBeasts());loadError.value='';return true; }
  catch(error) { loadError.value=error instanceof Error?error.message:'读取失败，请重试';return false; }
  finally { loading.value=false; }
}
/** 不再重试：先刷新拿到真实结果，再解除锁定并关掉二级弹窗，避免在未确认的状态上再提交一次新操作。 */
async function abandonUnresolved(): Promise<void> {
  if (pending.value) return;
  // 刷新失败时保留未决状态：否则玩家既看不到真实结果，也失去重试入口。
  if (!await refreshPanel()) return;
  unresolved.value=null;
  exchangeChoice.value=null;
  detailId.value=null;
  confirmRelease.value=false;
}
async function perform(operation: Operation): Promise<void> {
  if(pending.value)return;
  pending.value=true;
  try {
    const data=await operation.run();apply(data);unresolved.value=null;
    let message=operation.message;
    const receipt=data.receipt;
    const name=receipt?data.beasts.species.find(item=>item.id===receipt.beast.speciesId)?.name ?? '灵兽':'灵兽';
    if(receipt?.kind==='release-batch')message='放生 '+String(receipt.released?.length ?? 0)+' 只灵兽，获得 '+formatAmount(receipt.resourceChanges.beastEssence?.amount ?? '0')+' 御兽精魄。';
    if(receipt?.kind==='release')message=name+'已放生，获得 '+formatAmount(receipt.resourceChanges.beastEssence?.amount ?? '0')+' 御兽精魄。';
    if(receipt?.kind==='exchange')message='获得凡品'+name+'（Lv.1），已进入灵兽苑。';
    if(receipt?.kind==='quality-breakthrough')message=name+'突破至'+(BEAST_QUALITY_OPTIONS.find(item=>item.id===receipt.beast.quality)?.name ?? receipt.beast.quality)+'。';
    emit('notify','success','灵兽苑',message);confirmRelease.value=false;operation.after?.();
  } catch(error) {
    // 代理可能在写入成功后返回 HTML、空响应或错误信封；这些响应不能证明命令未提交。
    const uncertain=!(error instanceof ApiError) || error.status===0 || error.status>=500 || error.code==='BAD_RESPONSE' || error.code==='UNKNOWN_ERROR';
    unresolved.value=uncertain?operation:null;
    // 不确定失败不把解析层面的技术错误抛给玩家，只提示结果未确认并给出重试入口。
    emit('notify','warning','灵兽苑',uncertain&&error instanceof ApiError?'网络或响应异常，操作结果未确认，可以重试原操作，也可以刷新后放弃。':error instanceof Error?error.message:'操作失败');
    await refreshPanel();
  } finally { pending.value=false; }
}
function manage(beast: SpiritBeastView, action: BeastManageAction): void {
  if(blocked.value)return;
  if(action==='release'&&!confirmRelease.value){confirmRelease.value=true;return;}
  const discipleId=action==='equip'?equipTargets.value[0]:undefined;
  if(action==='equip'&&!discipleId)return;
  const commandId=crypto.randomUUID();
  const message=action==='upgrade'?beast.species.name+'升至 Lv.'+String(beast.level+1)+'。':action==='lock'?(beast.locked?'已解锁。':'已锁定。'):action==='equip'?'已更换携带灵兽。':action==='unequip'?'灵兽已卸下。':'操作完成。';
  void perform({run:()=>manageSpiritBeast(beast.id,beast.version,action,commandId,discipleId,action==='lock'?!beast.locked:undefined),message,after:action==='release'?()=>{detailId.value=null;}:action==='equip'?()=>{equipPickerOpen.value=false;}:undefined});
}
function confirmExchange(): void {
  const choice=exchangeChoice.value;
  if(!choice||blocked.value||exchangeBlock(choiceCost.value))return;
  const input: BeastExchangeInput={...choice,commandId:crypto.randomUUID()};
  void perform({run:()=>exchangeSpiritBeast(input),message:'兑换完成。',after:()=>{exchangeChoice.value=null;}});
}
function onTabKey(event: KeyboardEvent): void {
  if(blocked.value || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();tab.value=event.key==='Home'?'collection':event.key==='End'?'exchange':tab.value==='collection'?'exchange':'collection';
  const buttons=(event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  buttons?.[tab.value==='collection'?0:1]?.focus();
}
onMounted(refreshPanel);
</script>

<template>
  <section class="garden" aria-labelledby="garden-title">
    <div class="beast-head modal-head">
      <h3 id="garden-title" class="beast-title"><span>灵兽苑</span><span v-if="panel" class="beast-title-sub">随行 {{ carriedCount }}</span></h3>
      <button class="beast-quiet-button" type="button" :disabled="blocked" @click="emit('open-capture')">去捕捉</button>
    </div>
    <p v-if="loadError" class="blocked-hint">{{ loadError }} <button class="beast-quiet-button" :disabled="pending || loading" @click="refreshPanel">重新读取</button></p>
    <div v-if="unresolved && detailId === null && exchangeChoice === null" class="detail-upgrade">
      <p class="blocked-hint">上次操作结果尚未确认：重试会使用同一操作标识，不会重复扣费；也可以刷新查看结果后放弃。</p>
      <button class="action-button primary-action" :disabled="pending" @click="perform(unresolved)">重试原操作</button><button class="beast-quiet-button" type="button" :disabled="pending" @click="abandonUnresolved">刷新并放弃</button>
    </div>
    <p v-if="!panel" class="beast-empty">{{ loading ? '正在清点灵兽……' : '暂未读取到灵兽信息，请重试。' }}</p>
    <template v-else>
      <p class="beast-section-title"><span>御兽精魄 {{ formatAmount(balanceOf('beastEssence')) }}</span><small>灵兽 {{ panel.items.length }}/{{ panel.capacity }}</small></p>
      <p v-if="!panel.unlocked" class="beast-lock">宗门 {{ panel.unlockLevel }} 级开放灵兽玩法。</p>
      <template v-else>
        <div class="beast-tabs" role="tablist" aria-label="灵兽苑分区">
          <button id="garden-tab-collection" class="beast-tab" type="button" role="tab" :aria-selected="tab === 'collection'" aria-controls="garden-page-collection" :tabindex="tab === 'collection' ? 0 : -1" :disabled="blocked" @click="tab='collection'" @keydown="onTabKey">我的灵兽</button>
          <button id="garden-tab-exchange" class="beast-tab" type="button" role="tab" :aria-selected="tab === 'exchange'" aria-controls="garden-page-exchange" :tabindex="tab === 'exchange' ? 0 : -1" :disabled="blocked" @click="tab='exchange'" @keydown="onTabKey">精魄兑换</button>
        </div>
        <div v-if="tab === 'collection'" id="garden-page-collection" class="garden" role="tabpanel" aria-labelledby="garden-tab-collection">
          <div v-if="panel.items.length === 0" class="garden-empty"><p>灵兽苑还空着。可以去宠物秘境捕捉，或使用御兽精魄兑换灵兽。</p><button class="action-button primary-action" :disabled="blocked" @click="tab='exchange'">前往精魄兑换</button></div>
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

        <div v-if="batchQualities.length > 0" class="filter-group" role="group" aria-label="按品质批量选择放生">
          <span class="filter-label">批量</span>
          <button
            v-for="group in batchQualities"
            :key="group.id"
            class="filter-chip"
            type="button"
            :data-quality="group.id"
            :aria-pressed="isQualityPicked(group.ids)"
            :disabled="blocked"
            :title="isQualityPicked(group.ids) ? `取消选择全部${group.name}` : `选中全部待命的${group.name}`"
            @click="toggleQuality(group.ids)"
          >
            {{ group.name }} ×{{ group.ids.length }}<template v-if="pickedIn(group.ids) > 0 && !isQualityPicked(group.ids)">（已选 {{ pickedIn(group.ids) }}）</template>
          </button>
          <span v-if="lockedIdleCount > 0" class="garden-batch-note">已锁定的 {{ lockedIdleCount }} 只不参与</span>
        </div>
        <label v-if="carriedCount > 0" class="garden-carried-toggle">
          <input v-model="showCarried" type="checkbox" />
          显示已随行（{{ carriedCount }} 只）
        </label>

        <p v-if="items.length === 0" class="beast-empty">
          {{ !showCarried && carriedCount > 0 && panel.items.length === carriedCount ? `灵兽都在随行中（勾选「显示已随行」查看）。` : '没有符合筛选条件的灵兽。' }}
        </p>
        <ul v-else class="garden-grid">
          <li v-for="beast in items" :key="beast.id" class="garden-item" :class="{ 'is-picked': isPicked(beast.id) }">
            <label class="garden-pick">
              <input
                type="checkbox"
                :checked="isPicked(beast.id)"
                :disabled="blocked || !releasable(beast)"
                :aria-label="releasable(beast) ? `选择放生 ${beast.species.name}` : `${beast.species.name}已锁定或随行，不能放生`"
                @change="togglePick(beast)"
              />
            </label>
            <button
              class="garden-card"
              :class="{ 'is-carried': beast.discipleId !== null }"
              type="button"
              :data-element="beast.species.element"
              :data-quality="beast.quality"
              :disabled="blocked" @click="open(beast)"
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

        <div v-if="selectedBeasts.length > 0" class="garden-batch-bar">
          <p>
            已选 <strong>{{ selectedBeasts.length }}</strong> 只 · 获得御兽精魄 <strong>{{ formatAmount(batchReward) }}</strong>
            <template v-if="hiddenPicked > 0"> · 其中 {{ hiddenPicked }} 只不在当前筛选中</template>
          </p>
          <div class="detail-buttons">
            <button class="beast-quiet-button" type="button" :disabled="blocked" @click="selectedIds = []">清空</button>
            <button class="beast-quiet-button is-danger" type="button" :disabled="blocked" @click="releaseBatch">
              {{ confirmBatch ? `确认放生 ${String(selectedBeasts.length)} 只（不可撤销）` : '批量放生' }}
            </button>
            <button v-if="confirmBatch" class="beast-quiet-button" type="button" :disabled="blocked" @click="confirmBatch = false">取消</button>
          </div>
        </div>
          </template>
        </div>
        <div v-else id="garden-page-exchange" class="garden" role="tabpanel" aria-labelledby="garden-tab-exchange">
          <div class="filter-group" role="group" aria-label="兑换档次"><span class="filter-label">档次</span><button v-for="item in panel.exchangeOffers" :key="item.tier" class="filter-chip" type="button" :aria-pressed="exchangeTier === item.tier" :disabled="blocked" @click="exchangeTier=item.tier">{{ item.tierName }}</button></div>
          <p class="detail-skill">所有兑换均获得 1 级凡品，允许重复物种。随机兑换在所选档次内等概率抽取。</p>
          <div v-if="offer" class="detail-upgrade">
            <div class="garden-costs"><span>随机{{ offer.tierName }} · {{ offer.speciesIds.length }} 种物种</span><span>拥有 {{ formatAmount(balanceOf('beastEssence')) }} / 需要 {{ formatAmount(offer.randomCost) }} 精魄</span><p v-if="exchangeBlock(offer.randomCost)" class="blocked-hint">{{ exchangeBlock(offer.randomCost) }}</p></div>
            <button class="action-button primary-action" :disabled="blocked || !!exchangeBlock(offer.randomCost)" @click="exchangeChoice={mode:'random',tier:exchangeTier}">随机兑换</button>
          </div>
          <h4 class="beast-section-title">指定兑换 <small v-if="offer">每只 {{ formatAmount(offer.specificCost) }} 精魄</small></h4>
          <p v-if="offer && exchangeBlock(offer.specificCost)" class="blocked-hint">{{ exchangeBlock(offer.specificCost) }}</p>
          <ul class="garden-grid"><li v-for="species in exchangeSpecies" :key="species.id"><button class="garden-card" type="button" :data-element="species.element" data-quality="common" :disabled="blocked || !offer?.unlocked" @click="exchangeChoice={mode:'specific',tier:exchangeTier,speciesId:species.id}"><span class="beast-avatar garden-avatar"><img v-if="species.avatar" :src="species.avatar" :alt="species.name" width="96" height="96" loading="lazy" /></span><span class="garden-card-body"><span class="garden-card-name"><strong>{{ species.name }}</strong><span class="garden-level">Lv.1</span></span><span class="garden-card-chips"><span class="beast-chip is-quality">凡品</span><span class="beast-chip is-element">{{ species.elementName }}</span><span class="beast-chip" :class="'is-tier-'+species.tier">{{ species.tierName }}</span></span><span class="garden-holder">查看兑换详情</span></span></button></li></ul>
        </div>
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

        <div v-if="unresolved" class="detail-upgrade"><p class="blocked-hint">上次操作结果未确认，请重试原操作，或刷新并放弃。</p><button class="action-button primary-action" :disabled="pending" @click="perform(unresolved)">重试原操作</button><button class="beast-quiet-button" type="button" :disabled="pending" @click="abandonUnresolved">刷新并放弃</button></div>
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
            <div class="garden-costs">
              <span v-if="selected.upgradeCost">升到 Lv.{{ selected.level + 1 }}：{{ formatAmount(selected.upgradeCost.spiritStone) }} 灵石 ＋ {{ formatAmount(selected.upgradeCost.spiritualEnergy) }} 灵气</span>
              <span v-else>等级已满</span>
              <template v-if="selected.upgradePreview">
                <p class="detail-skill">{{ previewText(selected, selected.upgradePreview.attrs) }}</p>
                <p class="detail-skill">技能：{{ selected.upgradePreview.skillText }}</p>
              </template>
            </div>
            <button class="action-button primary-action" type="button" :disabled="blocked || !affordable(selected)" @click="manage(selected, 'upgrade')">{{ selected.upgradeCost && !affordable(selected) ? '资源不足' : '升级' }}</button>
          </div>
          <div class="detail-upgrade">
            <div class="garden-costs" v-if="selected.qualityBreakthrough">
              <span>突破至{{ selected.qualityBreakthrough.nextQualityName }} · 必定成功</span>
              <p v-for="row in breakthroughRows(selected)" :key="row.id" :class="{ 'blocked-hint': row.lacking }">{{ row.name }}：拥有 {{ formatAmount(row.balance) }} / 需要 {{ formatAmount(row.cost) }}</p>
              <p class="detail-skill">{{ previewText(selected, selected.qualityBreakthrough.attrs) }}</p>
              <p class="detail-skill">技能：{{ selected.qualityBreakthrough.skillText }}</p>
              <p v-if="selected.qualityBreakthrough.blockedReason" class="blocked-hint">{{ selected.qualityBreakthrough.blockedReason }}</p>
            </div>
            <span v-else>品质已达仙品</span>
            <button class="action-button primary-action" type="button" :disabled="blocked || !canBreakthrough(selected)" @click="manage(selected, 'quality-breakthrough')">品质突破</button>
          </div>
          <div class="detail-buttons">
            <button v-if="selected.discipleId" class="beast-quiet-button" type="button" :disabled="blocked" @click="manage(selected, 'unequip')">卸下</button>
            <button class="beast-quiet-button" type="button" :disabled="blocked" @click="manage(selected, 'lock')">
              {{ selected.locked ? '解锁' : '锁定' }}
            </button>
            <button
              class="beast-quiet-button is-danger"
              type="button"
              :disabled="blocked || selected.locked || selected.discipleId !== null"
              :title="selected.locked || selected.discipleId ? '先解锁并卸下才能放生' : '放生返还精魄，不返还培养投入'"
              @click="manage(selected, 'release')"
            >
              {{ confirmRelease ? '确认放生（获得 ' + formatAmount(selected.releaseReward.beastEssence) + ' 精魄）' : '放生（+' + formatAmount(selected.releaseReward.beastEssence) + ' 精魄）' }}
            </button>
            <button v-if="confirmRelease" class="beast-quiet-button" type="button" @click="confirmRelease = false">取消</button>
          </div>
        </div>

        <section class="detail-equip" aria-label="携带弟子">
          <div class="detail-equip-bar">
            <p>{{ selected.discipleName ? `当前由${selected.discipleName}携带。` : '待命中。' }}每名弟子携带一只；换人时对方原有的灵兽自动卸下。</p>
            <button class="action-button primary-action" type="button" :disabled="blocked" @click="openEquipPicker(selected)">
              {{ selected.discipleId ? '更换携带弟子' : '选择携带弟子' }}
            </button>
          </div>
        </section>
      </section>
    </ModalShell>
    <!-- 三级弹窗：为当前灵兽挑选携带弟子 -->
    <ModalShell v-if="equipPickerOpen && selected" :label="`携带弟子 · ${selected.species.name}`" :loading="pending" loading-text="正在更换携带弟子" @close="equipPickerOpen = false">
      <section class="garden-detail" aria-labelledby="garden-equip-title">
        <div class="beast-head modal-head">
          <h3 id="garden-equip-title" class="beast-title"><span>选择携带弟子</span><span class="beast-title-sub">{{ selected.species.name }} · {{ selected.qualityName }} · Lv.{{ selected.level }}</span></h3>
        </div>
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
          <div class="detail-buttons">
            <button class="beast-quiet-button" type="button" :disabled="pending" @click="equipPickerOpen = false">取消</button>
            <button
              class="action-button primary-action"
              type="button"
              :disabled="blocked || equipTarget === null || equipTarget.id === selected.discipleId"
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
        </div>
      </section>
    </ModalShell>
    <ModalShell v-if="exchangeChoice && choiceOffer" narrow label="确认兑换灵兽" :loading="pending" loading-text="正在兑换灵兽" @close="exchangeChoice=null">
      <section class="garden-detail" data-quality="common" :data-element="choiceSpecies?.element">
        <div class="beast-head modal-head"><h3 class="beast-title">{{ choiceSpecies ? '指定兑换 · '+choiceSpecies.name : '随机兑换 · '+choiceOffer.tierName }}</h3></div>
        <div v-if="unresolved" class="detail-upgrade"><p class="blocked-hint">上次操作结果未确认，请重试原操作，或刷新并放弃。</p><button class="action-button primary-action" :disabled="pending" @click="perform(unresolved)">重试原操作</button><button class="beast-quiet-button" type="button" :disabled="pending" @click="abandonUnresolved">刷新并放弃</button></div>
        <div v-if="choiceSpecies" class="detail-hero"><div class="detail-portrait"><img v-if="choiceSpecies.image" :src="choiceSpecies.image" :alt="choiceSpecies.name" /></div><div class="detail-info"><div class="detail-chips"><span class="beast-chip is-quality">凡品</span><span class="beast-chip is-element">{{ choiceSpecies.elementName }}行</span></div><ul class="detail-attrs"><li v-for="attr in beastAttrList(choiceSpecies.attrs)" :key="attr.key"><span>{{ attr.label }}</span><strong>+{{ attr.value }}</strong></li></ul><p class="detail-skill"><b>【{{ choiceSpecies.skillName }}】</b>{{ choiceSpecies.skillText }}</p></div></div>
        <p class="detail-skill">获得 1 级凡品{{ choiceSpecies?.name ?? choiceOffer.tierName }}，不自动装备。{{ exchangeChoice.mode === 'random' ? '在同档 '+choiceOffer.speciesIds.length+' 种物种中等概率随机，可能获得重复物种。' : '确定获得所选物种。' }}</p>
        <div class="detail-upgrade"><span :class="{'blocked-hint':balanceOf('beastEssence')<Number(choiceCost)}">御兽精魄：拥有 {{ formatAmount(balanceOf('beastEssence')) }} / 需要 {{ formatAmount(choiceCost) }}</span><button class="action-button primary-action" :disabled="blocked || !!exchangeBlock(choiceCost)" @click="confirmExchange">确认兑换</button></div>
        <p v-if="exchangeBlock(choiceCost)" class="blocked-hint">{{ exchangeBlock(choiceCost) }}</p>
        <div class="detail-buttons"><button class="beast-quiet-button" :disabled="pending" @click="exchangeChoice=null">取消</button></div>
      </section>
    </ModalShell>
  </section>
</template>
<style scoped>
/* 多资源费用与预览沿用原操作条，仅补充内部纵向排列和长内容收缩。 */
.garden-costs { display: grid; gap: 6px; min-width: 0; }
.garden-costs p { margin: 0; }
.garden-card:disabled { opacity: 0.45; cursor: not-allowed; }

/* 批量放生：卡片右上角的勾选框，与装备背包同一种多选方式。 */
.garden-item { position: relative; }
.garden-item .garden-card { padding-right: 36px; }
.garden-item.is-picked .garden-card {
  border-color: rgba(224, 123, 104, 0.6);
  background: linear-gradient(90deg, rgba(224, 123, 104, 0.12), transparent 70%), var(--surface);
}
.garden-pick { position: absolute; z-index: 1; top: 10px; right: 12px; display: flex; cursor: pointer; }
.garden-pick input { width: 16px; height: 16px; margin: 0; accent-color: var(--gold); cursor: pointer; }
.garden-pick input:disabled { cursor: not-allowed; opacity: 0.35; }
.garden-batch-note { color: var(--faint); font-size: 12px; }
.garden-carried-toggle { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; cursor: pointer; }
/* 底栏要压住滚到下面的卡片勾选框（勾选框 z-index 1）。 */
.garden-batch-bar {
  position: sticky;
  z-index: 3;
  bottom: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid rgba(224, 123, 104, 0.35);
  border-radius: 6px;
  background: var(--surface-strong);
}
.garden-batch-bar p { margin: 0; color: var(--muted); font-size: 12px; }
.garden-batch-bar strong { color: var(--gold-bright); }

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
