<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { BeastCaptureAction, BeastElement, SpiritBeastView, SpiritBeastsPanel } from '@xiuxian/contracts';
import { actBeastCapture, fetchSpiritBeasts, manageSpiritBeast, startBeastCapture, type SectStateView } from '../api/game';
import { formatAmount } from '../utils/format';

const props=defineProps<{state:SectStateView; discipleId?:string}>();
const emit=defineEmits<{'state-update':[state:SectStateView];back:[]}>();
const panel=ref<SpiritBeastsPanel|null>(null),pending=ref(false),error=ref('');
const tab=ref<'capture'|'owned'|'catalog'>(props.discipleId?'owned':'capture');
const areaId=ref('foothills'),discipleId=ref(props.discipleId??''),equipTo=ref(props.discipleId??'');
const element=ref<BeastElement|''>(''),quality=ref(''),tier=ref('');
const detail=ref<string|null>(null),confirmRelease=ref<string|null>(null);
const active=computed(()=>panel.value?.active??null);
const recent=computed(()=>panel.value?.recent??null);
const area=computed(()=>panel.value?.areas.find(a=>a.id===areaId.value));
const available=computed(()=>props.state.disciples.filter(d=>!d.combatBlockedReason&&!d.garrisonSiteName&&d.journey?.status!=='active'&&(!d.injuredUntil||Date.parse(d.injuredUntil)<=Date.parse(props.state.serverNow))));
const items=computed(()=>panel.value?.items.filter(b=>(!element.value||b.species.element===element.value)&&(!quality.value||b.quality===quality.value)&&(!tier.value||b.species.tier===tier.value))??[]);
const selected=computed(()=>panel.value?.items.find(b=>b.id===detail.value));
const attrNames={attack:'攻击',defense:'防御',speed:'身法',luck:'幸运',physique:'体魄'};
function attrs(a:SpiritBeastView['attrs']) {return Object.entries(a).filter(([,v])=>v>0).map(([k,v])=>`${attrNames[k as keyof typeof attrNames]} +${v}`).join(' · ');}
function affordable(b:SpiritBeastView) {return !!b.upgradeCost&&Object.entries(b.upgradeCost).every(([id,cost])=>Number(props.state.resources.find(r=>r.id===id)?.balance??0)>=cost);}
async function reload() {panel.value=(await fetchSpiritBeasts()).beasts;}
async function run(action:()=>Promise<{state:SectStateView;beasts:SpiritBeastsPanel}>) {
  if(pending.value)return;
  pending.value=true;error.value='';
  try {const r=await action();panel.value=r.beasts;emit('state-update',r.state);}
  catch(e) {error.value=e instanceof Error?e.message:'操作失败';try{await reload();}catch{/* keep the original error */}}
  finally{pending.value=false;}
}
function start() {void run(()=>startBeastCapture(areaId.value,discipleId.value,crypto.randomUUID()));}
function act(action:BeastCaptureAction) {const s=active.value;if(s)void run(()=>actBeastCapture(s.id,s.version,action,crypto.randomUUID()));}
function manage(b:SpiritBeastView,action:'equip'|'unequip'|'upgrade'|'lock'|'release') {
  if(action==='release'&&confirmRelease.value!==b.id){confirmRelease.value=b.id;return;}
  confirmRelease.value=null;
  void run(()=>manageSpiritBeast(b.id,b.version,action,crypto.randomUUID(),action==='equip'?equipTo.value:undefined,action==='lock'?!b.locked:undefined));
}
onMounted(async()=>{pending.value=true;try{await reload();if(!discipleId.value)discipleId.value=available.value[0]?.id??'';if(!equipTo.value)equipTo.value=available.value[0]?.id??'';}catch(e){error.value=e instanceof Error?e.message:'读取失败';}finally{pending.value=false;}});
</script>

<template>
  <section class="beast-panel">
    <header class="section-heading"><div><p class="eyebrow">宠物秘境</p><h2>寻兽 · 御灵</h2></div><button class="action-button" type="button" @click="emit('back')">返回秘境分类</button></header>
    <p class="beast-intro">山野有灵，各有所长。携一兽同行，以五行与功法应万变。</p>
    <div class="beast-tabs" role="tablist" aria-label="灵兽玩法">
      <button v-for="t in ([['capture','野外捕捉'],['owned','灵兽苑'],['catalog','灵兽图鉴']] as const)" :id="`beast-tab-${t[0]}`" :key="t[0]" class="action-button" role="tab" type="button" :aria-selected="tab===t[0]" :aria-controls="`beast-page-${t[0]}`" @click="tab=t[0]">{{ t[1] }}{{ t[0]==='owned'&&panel?` ${panel.items.length}/${panel.capacity}`:'' }}</button>
    </div>
    <p v-if="error" class="blocked-hint" role="alert">{{ error }}</p>
    <p v-if="!panel" class="beast-intro">{{ pending?'正在查看山野与灵兽……':'暂未读取到灵兽信息。' }}</p>
    <template v-if="panel">
      <p v-if="!panel.unlocked" class="blocked-hint">宗门 {{ panel.unlockLevel }} 级开放捕捉与培养，可以先查看图鉴。</p>
      <div v-show="tab==='capture'" id="beast-page-capture" role="tabpanel" aria-labelledby="beast-tab-capture">
        <template v-if="!active">
          <p class="beast-meta">今日尚可搜寻 {{ panel.remaining }}/{{ panel.dailyLimit }} 次 · 与普通秘境次数独立</p>
          <div class="beast-areas">
            <button v-for="a in panel.areas" :key="a.id" class="beast-area" :class="{'is-selected':areaId===a.id}" type="button" :aria-pressed="areaId===a.id" @click="areaId=a.id">
              <strong>{{ a.name }}</strong><span>{{ a.description }}</span><small>{{ a.unlocked?'已开放':`宗门 ${a.requiredSectLevel} 级开放` }} · 搜寻 {{ formatAmount(String(a.cost)) }} 灵石</small>
            </button>
          </div>
          <div v-if="area" class="beast-region-preview"><span>出没灵兽：</span><span v-for="s in panel.species.filter(s=>area?.speciesIds.includes(s.id))" :key="s.id" class="beast-tag" :data-element="s.element">{{ s.elementName }} · {{ s.name }}<small> {{ s.tierName }}</small></span></div>
          <label class="beast-field">出发弟子<select v-model="discipleId" :disabled="pending"><option value="" disabled>选择一名弟子</option><option v-for="d in available" :key="d.id" :value="d.id">{{ d.name }} · {{ d.stageName }} · 幸运 {{ d.luck+d.gear.luck+(d.spiritBeast?.attrs.luck??0) }}{{ d.spiritBeast?` · 携带${d.spiritBeast.name}`:' · 未携灵兽' }}</option></select></label>
          <button class="action-button primary-action" type="button" :disabled="pending||!panel.unlocked||!area?.unlocked||!discipleId||panel.remaining<=0||panel.items.length>=panel.capacity||Number(state.resources.find(r=>r.id==='spiritStone')?.balance??0)<(area?.cost??0)" @click="start">{{ pending?'正在搜寻……':'进入山野搜寻' }}</button>
          <p v-if="panel.items.length>=panel.capacity" class="blocked-hint">灵兽苑已满，请先整理。</p>
          <article v-if="recent&&recent.status!=='active'" class="beast-result"><strong>{{ recent.status==='caught'?'收服成功':recent.status==='expired'?'上次遭遇已过期':'上次搜寻结束' }} · {{ recent.species.name }}</strong><p v-if="recent.caught">{{ recent.caught.qualityName }} · {{ recent.caught.species.tierName }} · 已进入灵兽苑</p><p v-for="(line,i) in recent.logs.slice(-3)" :key="i">{{ line }}</p><button v-if="recent.caught" class="action-button" @click="tab='owned';detail=recent.caught.id">查看刚捕获的灵兽</button></article>
        </template>
        <article v-else class="beast-encounter">
          <div class="beast-encounter-head"><div class="beast-portrait" :data-element="active.species.element"><img v-if="active.species.image" :src="active.species.image" :alt="active.species.name"><span v-else>{{ active.species.glyph }}</span></div><div><span class="beast-tag" :data-element="active.species.element">{{ active.species.elementName }}行 · {{ active.species.tierName }}</span><h3>{{ active.species.name }}</h3><p>{{ active.species.skillName }} · {{ active.species.skillText }}</p><p class="beast-meta">品质收服后揭晓 · 当前收服率 {{ (active.captureRate*100).toFixed(1) }}%</p></div></div>
          <label>野生灵兽 {{ active.targetHp }}/{{ active.targetMaxHp }}<progress :value="active.targetHp" :max="active.targetMaxHp" /></label>
          <label>{{ active.discipleName }} {{ active.hp }}/{{ active.maxHp }}<progress :value="active.hp" :max="active.maxHp" /></label>
          <p class="beast-meta">已行动 {{ active.round }}/{{ active.maxRounds }} · 收服 {{ active.attempts }}/{{ active.maxAttempts }} · 关闭界面后可回来继续</p>
          <div class="beast-actions"><button class="action-button" :disabled="pending" @click="act('attack')">攻击（可能击杀）</button><button class="action-button" :disabled="pending" @click="act('restrain')">留手（保留 1 血）</button><button class="action-button primary-action" :disabled="pending||active.attempts>=active.maxAttempts" @click="act('capture')">御兽术 · 收服</button><button class="action-button" :disabled="pending" @click="act('leave')">离开</button></div>
          <ol class="beast-logs" aria-live="polite"><li v-for="(line,i) in active.logs.slice(-12)" :key="i">{{ line }}</li></ol>
        </article>
        <details class="beast-rules"><summary>捕捉与培养规则</summary><ul><li v-for="rule in panel.rules" :key="rule">{{ rule }}</li></ul></details>
      </div>
      <div v-show="tab==='owned'" id="beast-page-owned" role="tabpanel" aria-labelledby="beast-tab-owned">
        <div class="beast-filters"><select v-model="element" aria-label="按五行筛选"><option value="">全部五行</option><option v-for="(name,id) in {metal:'金',wood:'木',water:'水',fire:'火',earth:'土'}" :key="id" :value="id">{{ name }}</option></select><select v-model="tier" aria-label="按物种档次筛选"><option value="">全部档次</option><option value="spirit">灵兽</option><option value="rare">珍兽</option><option value="divine">神兽</option></select><select v-model="quality" aria-label="按品质筛选"><option value="">全部品质</option><option value="common">凡品</option><option value="spirit">灵品</option><option value="treasure">宝品</option><option value="immortal">仙品</option></select></div>
        <p v-if="!items.length" class="beast-intro">{{ panel.items.length?'没有符合筛选条件的灵兽。':'还没有灵兽，去野外寻找第一位伙伴吧。' }}</p>
        <div class="beast-grid"><button v-for="b in items" :key="b.id" type="button" class="beast-owned" :data-quality="b.quality" :class="{'is-selected':detail===b.id}" @click="detail=b.id;confirmRelease=null"><span class="beast-mini" :data-element="b.species.element"><img v-if="b.species.avatar" :src="b.species.avatar" :alt="b.species.name" width="96" height="96" loading="lazy" decoding="async"><span v-else>{{ b.species.glyph }}</span></span><span><strong>{{ b.species.name }}</strong><small>{{ b.qualityName }} · {{ b.species.tierName }} · {{ b.species.elementName }} · Lv.{{ b.level }}</small><small>{{ b.discipleName?`随行：${b.discipleName}`:'待命' }}{{ b.locked?' · 已锁定':'' }}</small></span></button></div>
        <article v-if="selected" class="beast-detail" :data-quality="selected.quality">
          <div class="beast-encounter-head"><div class="beast-portrait" :data-element="selected.species.element"><img v-if="selected.species.image" :src="selected.species.image" :alt="selected.species.name"><span v-else>{{ selected.species.glyph }}</span></div><div><h3>{{ selected.species.name }} · {{ selected.qualityName }}</h3><p>{{ selected.species.tierName }} · {{ selected.species.elementName }}行 · Lv.{{ selected.level }}/{{ panel.maxLevel }}</p><p>{{ attrs(selected.attrs) }}</p><p>【{{ selected.species.skillName }}】{{ selected.skillText }}</p></div></div>
          <label class="beast-field">携带弟子<select v-model="equipTo" :disabled="pending"><option value="" disabled>选择弟子</option><option v-for="d in available" :key="d.id" :value="d.id">{{ d.name }}{{ d.spiritBeast?`（当前：${d.spiritBeast.name}）`:'' }}</option></select></label>
          <div class="beast-actions"><button class="action-button primary-action" :disabled="pending||!equipTo||selected.discipleId===equipTo" @click="manage(selected,'equip')">{{ selected.discipleId?'更换携带弟子':'装备' }}</button><button v-if="selected.discipleId" class="action-button" :disabled="pending" @click="manage(selected,'unequip')">卸下</button><button class="action-button" :disabled="pending" @click="manage(selected,'lock')">{{ selected.locked?'解锁':'锁定' }}</button></div>
          <p v-if="selected.upgradeCost">下一级：{{ formatAmount(String(selected.upgradeCost.spiritStone)) }} 灵石 ＋ {{ formatAmount(String(selected.upgradeCost.spiritualEnergy)) }} 灵气</p><p v-else>已满级</p>
          <div class="beast-actions"><button class="action-button" :disabled="pending||!affordable(selected)" @click="manage(selected,'upgrade')">升级（必定成功）</button><button class="action-button" :disabled="pending||selected.locked||!!selected.discipleId" @click="manage(selected,'release')">{{ confirmRelease===selected.id?'确认永久放生，不返还资源':'放生' }}</button><button v-if="confirmRelease===selected.id" class="action-button" @click="confirmRelease=null">取消</button></div>
        </article>
      </div>
      <div v-show="tab==='catalog'" id="beast-page-catalog" role="tabpanel" aria-labelledby="beast-tab-catalog">
        <p class="beast-meta">已捕获 {{ panel.collection.filter(c=>c.caught>0).length }}/{{ panel.species.length }} 种 · 金克木、木克土、土克水、水克火、火克金</p>
        <div class="beast-catalog"><article v-for="s in panel.species" :key="s.id" class="beast-detail"><div class="beast-mini" :data-element="s.element"><img v-if="s.avatar" :src="s.avatar" :alt="s.name" width="96" height="96" loading="lazy" decoding="async"><span v-else>{{ s.glyph }}</span></div><h3>{{ s.name }} <small>{{ s.tierName }} · {{ s.elementName }}</small></h3><p>【{{ s.skillName }}】{{ s.skillText }}</p><p class="beast-meta">{{ attrs(s.attrs) }}（1 级凡品）</p><p class="beast-meta">出没：{{ panel.areas.filter(a=>a.speciesIds.includes(s.id)).map(a=>a.name).join('、') }}</p><p class="beast-meta">遭遇 {{ panel.collection.find(c=>c.speciesId===s.id)?.seen??0 }} 次 · 捕获 {{ panel.collection.find(c=>c.speciesId===s.id)?.caught??0 }} 次</p></article></div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.beast-panel {
  display: grid;
  gap: 16px;
}

.beast-panel h2,.beast-panel h3,.beast-panel p {
  margin: 0;
}

.beast-panel h3 {
  font-size: 16px;
}

.beast-intro,.beast-meta {
  color: var(--text-muted,#a3a8af);
  font-size: 13px;
  line-height: 1.7;
}

.beast-tabs,.beast-actions,.beast-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.beast-tabs [aria-selected=true] {
  border-color: var(--accent,#c0a773);
  color: var(--accent,#c0a773);
}

.beast-areas {
  display: grid;
  grid-template-columns: repeat(3,minmax(0,1fr));
  gap: 10px;
  margin: 12px 0;
}

.beast-area,.beast-owned,.beast-detail,.beast-result,.beast-encounter {
  border: 1px solid var(--line,#38404a);
  background: var(--panel-soft,rgba(128,128,128,.04));
  border-radius: 12px;
  padding: 14px;
  color: inherit;
}

.beast-area {
  display: grid;
  gap: 8px;
  text-align: left;
  cursor: pointer;
}

.beast-area span,.beast-area small {
  font-size: 12px;
  line-height: 1.6;
  opacity: .7;
}

.is-selected {
  outline: 1px solid var(--accent,#c0a773);
}

.beast-region-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 14px 0;
  font-size: 12px;
}

.beast-tag {
  display: inline-block;
  border: 1px solid currentColor;
  border-radius: 5px;
  padding: 3px 6px;
  font-size: 12px;
}

.beast-field {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 14px 0;
}

.beast-panel select {
  max-width: 100%;
  border: 1px solid var(--line,#38404a);
  border-radius: 6px;
  padding: 8px;
  background: var(--panel,#19202a);
  color: inherit;
}

.beast-encounter-head {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-bottom: 14px;
}

.beast-encounter-head>div:last-child {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.beast-portrait {
  width: 140px;
  height: 140px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  background: radial-gradient(circle,rgba(170,170,170,.12),transparent 70%);
  font-size: 72px;
  font-family: serif;
}

.beast-portrait img,.beast-mini img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.beast-encounter label {
  display: grid;
  gap: 5px;
  font-size: 13px;
  margin: 12px 0;
}

.beast-encounter progress {
  width: 100%;
  height: 12px;
  accent-color: #84a892;
}

.beast-logs {
  max-height: 240px;
  overflow: auto;
  padding: 12px 12px 12px 30px;
  background: rgba(128,128,128,.04);
  font-size: 12px;
  line-height: 1.8;
}

.beast-rules {
  font-size: 12px;
  line-height: 1.8;
  margin-top: 15px;
  opacity: .8;
}

.beast-grid,.beast-catalog {
  display: grid;
  grid-template-columns: repeat(2,minmax(0,1fr));
  gap: 10px;
  margin: 14px 0;
}

.beast-owned {
  display: flex;
  align-items: center;
  gap: 12px;
  text-align: left;
  cursor: pointer;
}

.beast-owned>span:last-child {
  display: grid;
  gap: 5px;
}

.beast-owned small {
  font-size: 12px;
  opacity: .7;
}

.beast-mini {
  display: grid;
  place-items: center;
  width: 55px;
  height: 55px;
  flex-shrink: 0;
  font-size: 32px;
  font-family: serif;
}

.beast-detail {
  display: grid;
  gap: 10px;
  margin-top: 12px;
}

.beast-detail p {
  font-size: 13px;
  line-height: 1.7;
}

.beast-result {
  display: grid;
  gap: 8px;
  margin-top: 15px;
}

.beast-result p {
  font-size: 12px;
  line-height: 1.7;
}

[data-element=metal] {
  color: #d4b982;
}

[data-element=wood] {
  color: #75ae83;
}

[data-element=water] {
  color: #7ba7cc;
}

[data-element=fire] {
  color: #cf8b75;
}

[data-element=earth] {
  color: #b9a273;
}

[data-quality=spirit] {
  border-color: #6a9e79;
}

[data-quality=treasure] {
  border-color: #688fb3;
}

[data-quality=immortal] {
  border-color: #c5a55e;
}

@media(max-width:600px) {
  .beast-areas,.beast-grid,.beast-catalog {
    grid-template-columns: 1fr;
  }
  .beast-portrait {
    width: 90px;
    height: 90px;
    font-size: 50px;
  }
  .beast-encounter-head {
    gap: 10px;
  }
  .beast-actions>.action-button {
    flex: 1 1 42%;
  }
  .section-heading {
    flex-wrap: wrap;
  }
  .beast-panel select {
    width: 100%;
  }
}
</style>
