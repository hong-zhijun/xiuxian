<script setup lang="ts">
import { computed, ref } from 'vue';

import type { DiscipleView, SectStateView, StewardOfficeView } from '../api/game';

/**
 * 执事堂（弹窗内容，外壳由 SectScreen 用 ModalShell 提供）。
 *
 * 三个职位（炼器 / 丹房 / 寻宝）：只能任命拥有对应天赋的弟子，加成按执事当前境界算；
 * 执事不能出战，卸任后有交接期。职位视图、效果文案、今天能否任命全部来自服务端 state.stewards，
 * 前端只负责挑人与二次确认，最终裁决在服务端。
 */
const props = defineProps<{
  state: SectStateView;
  busy: boolean;
}>();

const emit = defineEmits<{
  appoint: [office: string, discipleId: string];
  dismiss: [office: string];
}>();

const offices = computed(() => props.state.stewards.offices);
const handoverHours = computed(() => props.state.stewards.handoverHours);

/** 每个职位下拉框当前选中的弟子 id。 */
const picked = ref<Record<string, string>>({});
/** 正在确认卸任的职位（两步确认：卸任会让原执事进入交接期）。 */
const confirmingDismiss = ref<string | null>(null);

/** 能任这个职位的弟子：天赋对得上、不是现任、不在外历练（服务端还会再校验守擂阵容等）。 */
function candidatesOf(office: StewardOfficeView): DiscipleView[] {
  return props.state.disciples.filter(
    (disciple) =>
      disciple.talent === office.talentId &&
      disciple.id !== office.discipleId &&
      disciple.journey.status !== 'active',
  );
}

function selectedOf(office: StewardOfficeView): string {
  const list = candidatesOf(office);
  const current = picked.value[office.office];
  if (current !== undefined && list.some((disciple) => disciple.id === current)) return current;
  return list[0]?.id ?? '';
}

function appoint(office: StewardOfficeView): void {
  const discipleId = selectedOf(office);
  if (props.busy || discipleId === '' || !office.canAppointToday) return;
  emit('appoint', office.office, discipleId);
}

function dismiss(office: StewardOfficeView): void {
  if (props.busy || office.discipleId === null) return;
  confirmingDismiss.value = null;
  emit('dismiss', office.office);
}
</script>

<template>
  <section class="steward-hall" aria-labelledby="steward-hall-title">
    <header class="section-heading panel-heading compact-heading">
      <div>
        <p class="eyebrow">宗门</p>
        <h2 id="steward-hall-title">执事堂</h2>
      </div>
    </header>

    <ul class="steward-rules">
      <li>每个职位只能任命拥有对应天赋的弟子，加成随执事境界提高。</li>
      <li>执事照常修炼、突破，但<strong>不能出战</strong>（讨伐、秘境、切磋、守擂、镇妖塔）。</li>
      <li>卸任后有 {{ handoverHours }} 小时交接期，期间同样不能出战。</li>
      <li>同一职位每天只能任命一次；执事外出历练时加成暂停。</li>
    </ul>

    <ul class="steward-offices">
      <li v-for="office in offices" :key="office.office" class="steward-office">
        <div class="steward-office-head">
          <strong>{{ office.name }}</strong>
          <span class="stat-tag stat-talent">需「{{ office.talentName }}」天赋</span>
        </div>

        <div v-if="office.discipleId !== null" class="steward-current">
          <p>
            <span class="steward-current-name">{{ office.discipleName }}</span>
            <span class="realm-tag">{{ office.realmName }}</span>
          </p>
          <p class="steward-effect">{{ office.effect }}</p>
          <p v-if="office.paused" class="blocked-hint">外出历练中，加成暂停。</p>
        </div>
        <p v-else class="steward-vacant">空缺</p>

        <div class="steward-actions">
          <template v-if="candidatesOf(office).length > 0">
            <span class="disciple-select">
              <select
                class="disciple-input"
                :aria-label="`${office.name}人选`"
                :value="selectedOf(office)"
                :disabled="busy || !office.canAppointToday"
                @change="picked[office.office] = ($event.target as HTMLSelectElement).value"
              >
                <option v-for="disciple in candidatesOf(office)" :key="disciple.id" :value="disciple.id">
                  {{ disciple.name }} · {{ disciple.stageName }}{{ disciple.combatBlockedReason ? `（${disciple.combatBlockedReason}）` : '' }}
                </option>
              </select>
            </span>
            <button
              class="action-button primary-action"
              type="button"
              :disabled="busy || !office.canAppointToday"
              @click="appoint(office)"
            >
              {{ office.discipleId === null ? '任命' : '换人' }}
            </button>
          </template>
          <p v-else class="disciple-detail-hint">
            门下暂无「{{ office.talentName }}」天赋的弟子，可用洗髓丹洗出。
          </p>

          <button
            v-if="office.discipleId !== null && confirmingDismiss !== office.office"
            class="upgrade-button"
            type="button"
            :disabled="busy"
            @click="confirmingDismiss = office.office"
          >
            卸任
          </button>
        </div>

        <p v-if="!office.canAppointToday" class="disciple-detail-hint">今天已经任命过，明日才能再换人。</p>

        <div
          v-if="confirmingDismiss === office.office"
          class="disciple-pill-confirm"
          role="group"
          :aria-label="`确认卸任 · ${office.name}`"
        >
          <p>
            卸任后{{ office.discipleName }}进入 <strong>{{ handoverHours }} 小时</strong>交接期，期间不能出战。
          </p>
          <div class="disciple-pill-confirm-actions">
            <button class="upgrade-button" type="button" @click="confirmingDismiss = null">取消</button>
            <button class="action-button primary-action" type="button" :disabled="busy" @click="dismiss(office)">
              确认卸任
            </button>
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>
