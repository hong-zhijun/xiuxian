<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import type { RebirthAction, RebirthBonuses, RebirthPanel, RebirthShopItem } from '@xiuxian/contracts';

import { ApiError } from '../api/client';
import type { SectStateView } from '../api/game';
import { fetchRebirth, postRebirthAction } from '../api/rebirth';
import { formatAmount } from '../utils/format';
import LoadingState from './LoadingState.vue';

const props = defineProps<{ state: SectStateView; busy: boolean }>();
const emit = defineEmits<{
  'state-update': [state: SectStateView];
  'busy-change': [busy: boolean];
  notify: [tone: 'success' | 'warning', title: string, message: string];
}>();

const panel = ref<RebirthPanel | null>(null);
const loading = ref(false);
const submitting = ref(false);
const loadError = ref<string | null>(null);
const feedback = ref<string | null>(null);
const feedbackError = ref(false);
const failedAction = ref<RebirthAction | null>(null);
const reviewing = ref(false);
const acknowledged = ref(false);
const activeTab = ref<'preview' | 'shop'>('preview');
let active = true;
let refreshPending = false;

const locked = computed(() => props.busy || loading.value || submitting.value);
const actionLocked = computed(() => locked.value || failedAction.value !== null);
const ascendedCount = computed(() => props.state.disciples.filter((disciple) => disciple.ascended).length);
const bonusLabels: { key: keyof RebirthBonuses; name: string; unit: string }[] = [
  { key: 'productionBp', name: '资源产出', unit: '%' },
  { key: 'breakthroughBp', name: '破境成功率', unit: '个百分点' },
  { key: 'powerBp', name: '弟子战力', unit: '%' },
];

function bonusAmount(bp: number): string {
  return Number.isInteger(bp / 100) ? String(bp / 100) : (bp / 100).toFixed(1);
}
function lostAmount(before: string, after: string): string {
  const loss = BigInt(before) - BigInt(after);
  return formatAmount(loss > 0n ? loss.toString() : '0');
}
function acceptState(state: SectStateView): void {
  if (Date.parse(state.serverNow) >= Date.parse(props.state.serverNow)) emit('state-update', state);
}

/** 读取与写入互斥；重新载入预览时必须重新审阅并确认损失。 */
async function load(): Promise<boolean> {
  if (!active) return false;
  if (locked.value) {
    refreshPending = true;
    return false;
  }
  refreshPending = false;
  loading.value = true;
  loadError.value = null;
  reviewing.value = false;
  acknowledged.value = false;
  let loaded = false;
  try {
    const data = await fetchRebirth();
    if (!active) return false;
    panel.value = data.rebirth;
    acceptState(data.state);
    loaded = true;
  } catch (error) {
    if (active) loadError.value = error instanceof Error ? error.message : '开辟新界预览加载失败，请重试';
  } finally {
    loading.value = false;
  }
  if (refreshPending && active && !props.busy) void load();
  return loaded;
}

async function reviewRebirth(): Promise<void> {
  if (actionLocked.value || panel.value?.eligible !== true) return;
  const loaded = await load();
  if (loaded && panel.value?.eligible === true) {
    reviewing.value = true;
    acknowledged.value = false;
  }
}

async function confirmRebirth(): Promise<void> {
  if (actionLocked.value || !reviewing.value || !acknowledged.value || panel.value?.eligible !== true) return;
  await submit({ action: 'rebirth', commandId: crypto.randomUUID(), expectedVersion: panel.value.version });
}

async function buy(item: RebirthShopItem): Promise<void> {
  if (actionLocked.value || panel.value === null || !item.canBuy) return;
  await submit({ action: 'buy', id: item.id, commandId: crypto.randomUUID(), expectedVersion: panel.value.version });
}

/** 重试保留完整请求与原 commandId；结果未确认前锁住新的转生和兑换。 */
async function submit(request: RebirthAction): Promise<void> {
  if (locked.value) return;
  submitting.value = true;
  emit('busy-change', true);
  feedback.value = null;
  feedbackError.value = false;
  failedAction.value = null;
  let failed = false;
  try {
    const data = await postRebirthAction(request);
    panel.value = data.rebirth;
    acceptState(data.state);
    reviewing.value = false;
    acknowledged.value = false;
    feedback.value = data.result.message;
    emit('notify', 'success', request.action === 'rebirth' ? '新界已开辟' : '道韵兑换完成', data.result.message);
  } catch (error) {
    failed = true;
    feedbackError.value = true;
    const message = error instanceof Error ? error.message : '操作失败，请稍后重试';
    feedback.value = message;
    if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.code === 'BAD_RESPONSE') failedAction.value = request;
    reviewing.value = false;
    acknowledged.value = false;
    emit('notify', 'warning', '操作结果待确认', message);
  } finally {
    submitting.value = false;
    emit('busy-change', false);
  }
  if (failed || refreshPending) void load();
}

function retryAction(): void {
  if (failedAction.value !== null) void submit(failedAction.value);
}
function onVisible(): void {
  if (document.visibilityState === 'visible') void load();
}
watch(() => props.busy, (value) => {
  if (!value && refreshPending) void load();
});
watch(activeTab, () => {
  reviewing.value = false;
  acknowledged.value = false;
});

onMounted(() => {
  void load();
  document.addEventListener('visibilitychange', onVisible);
});
onUnmounted(() => {
  active = false;
  document.removeEventListener('visibilitychange', onVisible);
});
</script>

<template>
  <section class="rebirth-dialog" aria-labelledby="rebirth-title">
    <header class="section-heading panel-heading rebirth-heading">
      <div>
        <p class="eyebrow">道途不止 · 开辟新界</p>
        <h2 id="rebirth-title">再启仙途</h2>
      </div>
      <button class="rebirth-small-button" type="button" :disabled="locked" @click="load">{{ loading ? '更新中…' : '刷新预览' }}</button>
    </header>

    <LoadingState v-if="loading && panel === null" label="正在推演新界与保留资源" />
    <div v-else-if="panel === null" class="empty-state rebirth-empty">
      <span aria-hidden="true">界</span>
      <strong>暂时无法推演新界</strong>
      <p>{{ loadError ?? '请重新获取转生预览。' }}</p>
      <button class="action-button primary-action" type="button" :disabled="locked" @click="load">重新加载</button>
    </div>
    <template v-else>
      <div class="rebirth-overview">
        <div><span>当前周目</span><strong>第 {{ panel.cycle + 1 }} 周目</strong></div>
        <div><span>可用道韵</span><strong>{{ panel.daoYun }}</strong></div>
        <div><span>下一次开辟</span><strong>第 {{ panel.cycle + 2 }} 周目</strong></div>
      </div>
      <nav class="rebirth-tabs" aria-label="开辟新界栏目">
        <button type="button" :class="{ active: activeTab === 'preview' }" :aria-pressed="activeTab === 'preview'" @click="activeTab = 'preview'">转生预览</button>
        <button type="button" :class="{ active: activeTab === 'shop' }" :aria-pressed="activeTab === 'shop'" @click="activeTab = 'shop'">道韵商店</button>
      </nav>

      <div v-if="feedback" class="rebirth-feedback" :class="{ error: feedbackError }" role="status">
        <span>{{ feedback }}</span>
        <button v-if="failedAction" class="rebirth-small-button" type="button" :disabled="locked" @click="retryAction">重试上次操作</button>
      </div>
      <div v-if="loadError" class="rebirth-feedback error" role="alert">
        <span>{{ loadError }} · 当前显示上次预览</span>
        <button class="rebirth-small-button" type="button" :disabled="locked" @click="load">重新加载</button>
      </div>

      <template v-if="activeTab === 'preview'">
        <section class="rebirth-section" aria-labelledby="rebirth-eligibility-title">
          <div class="rebirth-section-heading"><h3 id="rebirth-eligibility-title">开辟资格</h3><span class="rebirth-state-tag" :class="{ ready: panel.eligible }">{{ panel.eligible ? '可以开辟' : '尚有条件未满足' }}</span></div>
          <p class="rebirth-muted">宗门达到 15 级，且至少有 1 名已成仙弟子后，可开辟新界。</p>
          <div class="rebirth-criteria"><span :class="{ met: state.sect.level >= 15 }">宗门 {{ state.sect.level }}/15 级</span><span :class="{ met: ascendedCount > 0 }">已成仙 {{ ascendedCount }}/1 人</span></div>
          <ul v-if="panel.blockedReasons.length > 0" class="rebirth-blockers"><li v-for="reason in panel.blockedReasons" :key="reason">{{ reason }}</li></ul>
        </section>

        <section class="rebirth-section" aria-labelledby="rebirth-bonuses-title">
          <div class="rebirth-section-heading"><h3 id="rebirth-bonuses-title">下一周目 · 永久积累</h3><span class="rebirth-state-tag">道韵 +{{ panel.gainDaoYun }}</span></div>
          <div class="rebirth-bonuses">
            <div v-for="bonus in bonusLabels" :key="bonus.key"><span>{{ bonus.name }}</span><p><span>+{{ bonusAmount(panel.bonuses[bonus.key]) }}{{ bonus.unit }}</span><i aria-hidden="true">→</i><strong>+{{ bonusAmount(panel.nextBonuses[bonus.key]) }}{{ bonus.unit }}</strong></p></div>
          </div>
        </section>

        <section class="rebirth-section" aria-labelledby="rebirth-resources-title">
          <div class="rebirth-section-heading"><h3 id="rebirth-resources-title">资源保留 {{ panel.retainPercent }}%</h3><span class="rebirth-muted">按每项资源向下取整</span></div>
          <p class="rebirth-muted">开辟新界会失去以下差额；本次预览以最新结算后的资源为准。</p>
          <div class="rebirth-resource-table" role="table" aria-label="转生前后资源对比">
            <div class="rebirth-resource-row head" role="row"><span role="columnheader">资源</span><span role="columnheader">当前</span><span role="columnheader">保留</span><span role="columnheader">失去</span></div>
            <div v-for="resource in panel.previewResources" :key="resource.id" class="rebirth-resource-row" role="row"><strong role="cell">{{ resource.name }}</strong><span role="cell">{{ formatAmount(resource.before) }}</span><b role="cell">{{ formatAmount(resource.after) }}</b><span class="rebirth-loss" role="cell">−{{ lostAmount(resource.before, resource.after) }}</span></div>
          </div>
        </section>

        <div class="rebirth-impact-grid">
          <section class="rebirth-impact retained" aria-labelledby="rebirth-retained-title"><h3 id="rebirth-retained-title">带往新界</h3><ul><li v-for="item in panel.retained" :key="item">{{ item }}</li></ul><p>弟子容量至少 {{ panel.discipleCapacityFloor }} 人 · 建筑容量至少 {{ panel.buildingCapacityFloor }} 座</p></section>
          <section class="rebirth-impact reset" aria-labelledby="rebirth-reset-title"><h3 id="rebirth-reset-title">重新修行</h3><ul><li v-for="item in panel.reset" :key="item">{{ item }}</li></ul></section>
        </div>

        <section v-if="reviewing" class="rebirth-confirm" aria-labelledby="rebirth-confirm-title">
          <p class="eyebrow">最后确认</p>
          <h3 id="rebirth-confirm-title">确认以这些代价开辟新界</h3>
          <p>宗门回到 1 级，全部弟子重置修为、境界与成仙状态，资源仅保留 {{ panel.retainPercent }}%。完成后立即进入第 {{ panel.cycle + 2 }} 周目。</p>
          <ul><li v-for="item in panel.reset" :key="item">{{ item }}</li></ul>
          <label class="rebirth-acknowledgement"><input v-model="acknowledged" type="checkbox" :disabled="actionLocked" /><span>我已查看上方每项资源损失和重置清单，确认重新修行。</span></label>
          <div class="rebirth-actions"><button class="action-button" type="button" :disabled="locked" @click="reviewing = false; acknowledged = false">返回预览</button><button class="action-button rebirth-final-action" type="button" :disabled="actionLocked || !acknowledged || !panel.eligible" @click="confirmRebirth">{{ submitting ? '开辟中…' : `确认开辟新界 · 获得 ${panel.gainDaoYun} 道韵` }}</button></div>
        </section>
        <div v-else class="rebirth-actions"><p>确认前将重新获取一次预览，所有条件均以提交时判定为准。</p><button class="action-button primary-action" type="button" :disabled="actionLocked || !panel.eligible" @click="reviewRebirth">{{ loading ? '推演中…' : panel.eligible ? '审阅转生与损失' : '满足条件后开辟新界' }}</button></div>
      </template>

      <section v-else class="rebirth-section" aria-labelledby="rebirth-shop-title">
        <div class="rebirth-section-heading"><h3 id="rebirth-shop-title">道韵商店</h3><span class="rebirth-state-tag">余额 {{ panel.daoYun }}</span></div>
        <p class="rebirth-muted">开辟新界获得道韵，可兑换永久加成与宗门外观。兑换的加成将在后续周目继续保留。</p>
        <ul v-if="panel.shop.length > 0" class="rebirth-shop-list"><li v-for="item in panel.shop" :key="item.id"><div class="rebirth-shop-copy"><strong>{{ item.name }}</strong><p>{{ item.description }}</p><span>已兑换 {{ item.purchased }}/{{ item.limit }} 次</span><small v-if="item.blockedReason">{{ item.blockedReason }}</small></div><button class="action-button" type="button" :disabled="actionLocked || !item.canBuy" @click="buy(item)">{{ item.purchased >= item.limit ? '已兑完' : `${item.cost} 道韵兑换` }}</button></li></ul>
        <div v-else class="empty-state rebirth-empty"><span aria-hidden="true">韵</span><strong>暂无可兑换物品</strong><p>道韵商品加载完成后会显示在这里。</p></div>
        <p class="rebirth-muted rebirth-shop-tip">新获得的称号和头像框可在“宗门成长 → 声望”内佩戴。</p>
      </section>
    </template>
  </section>
</template>

<style scoped>
.rebirth-dialog { min-width: 0; color: var(--ink-text); background: #0c1e1a; box-shadow: 0 0 0 20px #0c1e1a; --modal-head-bg: #0c1e1a; }
.rebirth-heading { align-items: flex-start; gap: 12px; margin-bottom: 14px; padding-bottom: 12px; }
.rebirth-heading h2 { margin: 0; font-family: 'STKaiti', 'KaiTi', serif; font-size: 25px; font-weight: 500; }
.rebirth-small-button { appearance: none; flex: 0 0 auto; min-height: 30px; padding: 5px 10px; border: 1px solid #806c43; border-radius: 6px; color: #ead19a; background: #1a3027; font-family: inherit; font-size: 12px; font-weight: 500; line-height: 1.5; cursor: pointer; }
.rebirth-small-button:not(:disabled):hover { border-color: #caa96a; background: #263c2f; }
.rebirth-small-button:disabled { opacity: .5; cursor: not-allowed; }
.rebirth-overview { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 14px; }
.rebirth-overview > div { display: flex; flex-direction: column; gap: 5px; padding: 12px; border: 1px solid var(--line); border-radius: 9px; background: #102720; }
.rebirth-overview span { color: var(--muted); font-size: 11px; }
.rebirth-overview strong { color: var(--gold-bright); font-size: 17px; font-weight: 500; }
.rebirth-tabs { display: flex; gap: 6px; margin-bottom: 15px; padding: 4px; border: 1px solid var(--line); border-radius: 9px; background: #091a15; }
.rebirth-tabs button { flex: 1; padding: 9px; border: 1px solid transparent; border-radius: 6px; color: var(--muted); background: transparent; font: inherit; font-size: 13px; cursor: pointer; }
.rebirth-tabs button.active { border-color: var(--line-strong); color: var(--gold-bright); background: #213426; }
.rebirth-feedback { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 12px; padding: 10px; border: 1px solid #3e7354; border-radius: 8px; color: var(--jade-bright); background: #102d21; font-size: 12px; }
.rebirth-feedback.error { border-color: #76483b; color: var(--red-bright); background: #2a201b; }
.rebirth-section { margin: 0 0 16px; }
.rebirth-section-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 9px; }
.rebirth-section-heading h3, .rebirth-impact h3 { margin: 0; font-family: 'STKaiti', 'KaiTi', serif; font-size: 19px; font-weight: 500; }
.rebirth-state-tag { padding: 4px 8px; border: 1px solid var(--line-strong); border-radius: 999px; color: var(--gold); font-size: 11px; }
.rebirth-state-tag.ready { border-color: #3f765a; color: var(--jade-bright); }
.rebirth-muted { margin: 5px 0 10px; color: var(--muted); font-size: 12px; line-height: 1.6; }
.rebirth-criteria { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.rebirth-criteria span { padding: 5px 9px; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); font-size: 12px; }
.rebirth-criteria span.met { border-color: #356f5c; color: var(--jade-bright); background: #142e23; }
.rebirth-blockers { display: grid; gap: 5px; margin: 8px 0 0; padding: 10px 12px 10px 28px; border: 1px solid #6e493a; border-radius: 8px; color: #d8ac87; background: #281f18; font-size: 12px; }
.rebirth-bonuses { display: grid; gap: 7px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.rebirth-bonuses > div { padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: #10241e; }
.rebirth-bonuses > div > span { color: var(--muted); font-size: 11px; }
.rebirth-bonuses p { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin: 6px 0 0; font-size: 12px; }
.rebirth-bonuses p > span { color: var(--muted); }
.rebirth-bonuses i { color: var(--faint); font-style: normal; }
.rebirth-bonuses strong { color: var(--gold-bright); font-weight: 500; }
.rebirth-resource-table { overflow: hidden; border: 1px solid var(--line); border-radius: 9px; }
.rebirth-resource-row { display: grid; grid-template-columns: 1.2fr 1fr 1fr 1fr; align-items: center; gap: 7px; padding: 9px 10px; border-top: 1px solid var(--line); font-size: 12px; }
.rebirth-resource-row.head { border-top: 0; color: var(--muted); background: #142b22; font-size: 11px; }
.rebirth-resource-row > :not(:first-child) { text-align: right; overflow-wrap: anywhere; }
.rebirth-resource-row strong { font-size: 12px; font-weight: 500; }
.rebirth-resource-row b { color: var(--jade-bright); font-weight: 500; }
.rebirth-loss { color: #d6a68a; }
.rebirth-impact-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; margin: 0 0 15px; }
.rebirth-impact { padding: 12px; border: 1px solid var(--line); border-radius: 9px; background: #10251e; }
.rebirth-impact.retained h3 { color: var(--jade-bright); }
.rebirth-impact.reset { border-color: #604739; background: #211e18; }
.rebirth-impact.reset h3 { color: #dfb78b; }
.rebirth-impact ul, .rebirth-confirm ul { display: grid; gap: 6px; margin: 9px 0 0; padding-left: 18px; color: var(--muted); font-size: 12px; line-height: 1.6; }
.rebirth-impact p { margin: 10px 0 0; color: var(--jade-bright); font-size: 11px; }
.rebirth-actions { display: flex; justify-content: flex-end; align-items: center; gap: 10px; flex-wrap: wrap; }
.rebirth-actions > p { min-width: 0; flex: 1 1 150px; margin: 0; color: var(--muted); font-size: 11px; }
.rebirth-confirm { padding: 14px; border: 1px solid #997344; border-radius: 10px; background: #292418; }
.rebirth-confirm h3 { margin: 4px 0 8px; color: var(--gold-bright); font-family: 'STKaiti', 'KaiTi', serif; font-size: 21px; font-weight: 500; }
.rebirth-confirm > p:not(.eyebrow) { color: #d3bfa2; font-size: 12px; line-height: 1.7; }
.rebirth-acknowledgement { display: flex; align-items: flex-start; gap: 9px; margin: 14px 0; padding: 11px; border: 1px solid #70583a; border-radius: 7px; color: #ead7b5; background: #201e15; font-size: 12px; line-height: 1.6; cursor: pointer; }
.rebirth-acknowledgement input { flex: 0 0 auto; width: 17px; height: 17px; margin: 1px 0 0; accent-color: #caa96a; }
.rebirth-final-action { border-color: #ac8454; color: #f4dfb9; background: #604524; }
.rebirth-final-action:not(:disabled):hover { border-color: #ddba7a; background: #73512b; }
.rebirth-shop-list { display: grid; gap: 9px; margin: 12px 0; padding: 0; list-style: none; }
.rebirth-shop-list > li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 9px; background: #10251e; }
.rebirth-shop-copy { min-width: 0; }
.rebirth-shop-copy strong { font-size: 14px; font-weight: 500; }
.rebirth-shop-copy p { margin: 5px 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.rebirth-shop-copy > span { color: var(--gold); font-size: 11px; }
.rebirth-shop-copy small { display: block; margin-top: 4px; color: #d5aa88; font-size: 11px; }
.rebirth-shop-tip { padding-top: 8px; border-top: 1px solid var(--line); }
.rebirth-empty { padding: 25px 8px; }
.rebirth-empty .action-button { margin-top: 8px; }
@media (max-width: 600px) {
  .rebirth-overview { gap: 5px; }
  .rebirth-overview > div { padding: 9px 7px; }
  .rebirth-overview strong { font-size: 14px; }
  .rebirth-bonuses { grid-template-columns: 1fr; }
  .rebirth-bonuses > div { display: flex; align-items: center; justify-content: space-between; gap: 7px; }
  .rebirth-bonuses p { margin: 0; }
  .rebirth-impact-grid { grid-template-columns: 1fr; }
  .rebirth-resource-row { gap: 5px; padding: 9px 7px; font-size: 11px; }
  .rebirth-resource-row strong { font-size: 11px; }
  .rebirth-actions { align-items: stretch; flex-direction: column; }
  .rebirth-actions > p { flex-basis: auto; }
  .rebirth-shop-list > li { align-items: stretch; flex-direction: column; }
}
</style>
