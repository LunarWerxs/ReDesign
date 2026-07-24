<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useMediaQuery } from '@vueuse/core';
import {
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from '@lucide/vue';
import Sidebar from '@/shell/Sidebar.vue';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useControlStore } from '@/stores/control';
import { useTheme, type ThemeMode } from '@/lib/theme';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/i18n';
import ModelList from './key-health-sheet/ModelList.vue';
import OrphanKeyPools from './key-health-sheet/OrphanKeyPools.vue';
import ModelKeyDialogs from './key-health-sheet/ModelKeyDialogs.vue';
import ImportKeysDialog from './key-health-sheet/ImportKeysDialog.vue';
import { providerOptions, providerLabel as providerLabelFor, OPENAI_FAMILY } from '@/lib/providers';
import CloudSyncSection from './CloudSyncSection.vue';
import AutoUpdateSection from './AutoUpdateSection.vue';
import AppearanceSection from './AppearanceSection.vue';
import AppActionsBar from '@/components/app/AppActionsBar.vue';
import SettingsTabs from '@/shell/SettingsTabs.vue';
import { useRoute } from 'vue-router';
import type { KeyEntry, KeyPool, Model, ModelSaveRequest, ProviderDefault } from '@/types';

interface ModelForm {
  id: string;
  label: string;
  provider: string;
  apiModel: string;
  keyEnv: string;
  baseUrl: string;
  maxTokens: string;
  vision: boolean;
  enabled: boolean;
  supportsTemperature: boolean;
  temperature: string;
  tokenParam: string;
  color: string;
}

// providerOptions + providerLabel now live in @/lib/providers (shared with the
// model picker) so the settings sheet and picker never drift.
// Sourced from the backend's src/config/shared.ts PROVIDER_DEFAULTS via GET /api/bootstrap
// (store.providerDefaults), the single source of truth, so the two never drift apart.
const openAiDefaults: ProviderDefault = { baseUrl: '', keyEnv: '', color: '' };
const tokenParamOptions = [
  { value: 'max_tokens', label: 'max_tokens' },
  { value: 'max_completion_tokens', label: 'max_completion_tokens' },
];

const store = useControlStore();

// Spend-to-date + "prices last updated" for the Run Cost Meter (see
// src/runner/cost.ts spendToDate(), src/config/pricing.json).
const spendLabel = computed(() => {
  const spend = store.spend;
  if (!spend || !spend.runCount) return null;
  const amount = spend.totalCost < 0.01 ? spend.totalCost.toFixed(4) : spend.totalCost.toFixed(2);
  return t('cost.actualCost', { amount });
});
const spendTitle = computed(() => {
  const spend = store.spend;
  if (!spend) return '';
  const bits: string[] = [];
  if (spend.anyEstimatePricing) bits.push(t('cost.estimatePricingIsGuess'));
  if (spend.anyUnpriced) bits.push(t('cost.unpriced'));
  return bits.join(' · ');
});
const pricingLastUpdatedLabel = computed(() => {
  const date = store.spend?.pricingLastUpdated;
  return date ? t('cost.pricesLastUpdated', { date }) : null;
});

const open = defineModel<boolean>('open', { default: false });
const emit = defineEmits<{ refresh: [] }>();
const { mode: themeMode, setTheme } = useTheme();
const themeIcon = computed(() =>
  themeMode.value === 'light' ? SunIcon : themeMode.value === 'dark' ? MoonIcon : MonitorIcon,
);
const themeLabel = computed(() =>
  themeMode.value === 'light' ? t('keyHealth.themeLight') : themeMode.value === 'dark' ? t('keyHealth.themeDark') : t('keyHealth.themeSystem'),
);
const themeCycle: ThemeMode[] = ['light', 'dark', 'system'];
function cycleTheme() {
  const next = themeCycle[(themeCycle.indexOf(themeMode.value) + 1) % themeCycle.length];
  if (next) setTheme(next);
}
// Viewer options only make sense on the viewer; models only on the dashboard.
const route = useRoute();
const isViewer = computed(() => route.name === 'Viewer');
const isDesktop = useMediaQuery('(min-width: 768px)');
const side = ref<'right' | 'bottom'>(isDesktop.value ? 'right' : 'bottom');

// Two tabs, General first (2026-07-21). "Preferences" and "App" were split across two tabs for
// six switches between them, so finding any one setting meant guessing which half it lived in;
// they're now one "General" tab and models/keys is the specialist second tab. On the viewer
// there are no models to configure, so General is the only tab.
// Panes stay mounted behind v-show (SettingsTabs rule) so store-driven sections keep
// their live state across tab switches.
type TabId = 'general' | 'main';
const tab = ref<TabId>('general');
const tabs = computed<{ id: TabId; label: string }[]>(() => {
  const general = { id: 'general' as const, label: t('keyHealth.tabGeneral') };
  return isViewer.value ? [general] : [general, { id: 'main' as const, label: t('keyHealth.tabModels') }];
});

watch(open, (o) => {
  if (o) {
    side.value = isDesktop.value ? 'right' : 'bottom';
    tab.value = 'general'; // every open lands on General
  }
});
const keyDialogOpen = ref(false);
const keySaving = ref(false);
const importOpen = ref(false);
const modelDialogOpen = ref(false);
const modelSaving = ref(false);
const keyForm = ref({
  pool: '',
  id: '',
  mask: '',
  key: '',
});
const modelForm = ref(defaultModelForm());

const supportsTokenParam = computed(() => OPENAI_FAMILY.has(modelForm.value.provider));

function defaultModelForm(): ModelForm {
  const defaults = defaultsForProvider('openai');
  return {
    id: '',
    label: '',
    provider: 'openai',
    apiModel: '',
    keyEnv: defaults.keyEnv,
    baseUrl: defaults.baseUrl,
    maxTokens: '16000',
    vision: true,
    enabled: true,
    supportsTemperature: true,
    temperature: '1',
    tokenParam: 'max_tokens',
    color: defaults.color,
  };
}

function defaultsForProvider(provider?: string): ProviderDefault {
  return (provider && store.providerDefaults[provider]) || store.providerDefaults.openai || openAiDefaults;
}

function providerLabel(provider?: string) {
  return providerLabelFor(provider) || t('keyHealth.provider');
}

function onOpenChange(value: boolean) {
  open.value = value;
  if (value) store.refreshKeys();
  else store.resetLiveCheck();
}

function poolLabel(pool?: string) {
  return (pool ?? '').replace('_API_KEYS', '');
}

// Each model owns the key pool named by its `keyEnv`; the two used to live in
// separate sections and are now shown as one (keys nested under their model).
function poolForModel(m: Model): KeyPool | undefined {
  return store.keys?.pools?.find((p) => p.pool === m.keyEnv);
}

function modelFormFrom(m: Model): ModelForm {
  return {
    id: m.id,
    label: m.label || '',
    provider: m.provider || 'openai',
    apiModel: m.apiModel || '',
    keyEnv: m.keyEnv || '',
    baseUrl: m.baseUrl || '',
    maxTokens: String(m.maxTokens || 16000),
    vision: m.vision !== false,
    enabled: m.enabled !== false,
    supportsTemperature: m.supportsTemperature !== false,
    temperature: m.temperature == null ? '' : String(m.temperature),
    tokenParam: m.tokenParam || 'max_tokens',
    color: m.color || defaultsForProvider(m.provider).color,
  };
}

function setModelProvider(provider: string) {
  const defaults = defaultsForProvider(provider);
  const knownBaseUrls = Object.values(store.providerDefaults).map((d) => d.baseUrl);
  const knownKeyEnvs = Object.values(store.providerDefaults).map((d) => d.keyEnv);
  modelForm.value.provider = provider;
  if (!modelForm.value.baseUrl || knownBaseUrls.includes(modelForm.value.baseUrl)) {
    modelForm.value.baseUrl = defaults.baseUrl;
  }
  if (!modelForm.value.keyEnv || knownKeyEnvs.includes(modelForm.value.keyEnv)) {
    modelForm.value.keyEnv = defaults.keyEnv;
  }
  if (!modelForm.value.color) modelForm.value.color = defaults.color;
  if (supportsTokenParam.value && !modelForm.value.tokenParam) modelForm.value.tokenParam = 'max_tokens';
}

// Numbered status circles for the collapsed header.
function badges(p?: KeyPool) {
  if (!p) return [];
  return [
    { n: p.available, label: t('keyHealth.statusOk'), cls: 'bg-success' },
    { n: p.dead, label: t('keyHealth.statusDead'), cls: 'bg-destructive' },
    { n: p.noBalance, label: t('keyHealth.statusNoBalance'), cls: 'bg-warning' },
    { n: p.cooling, label: t('keyHealth.statusCooling'), cls: 'bg-muted-foreground' },
  ].filter((b) => b.n > 0);
}

const STATUS_ORDER: Record<string, number> = { ok: 0, cooldown: 1, no_balance: 2, dead: 3, untested: 4 };
function sortedEntries(entries: KeyEntry[]) {
  return [...entries].sort((a, b) => {
    const sa = STATUS_ORDER[a.status] ?? 9;
    const sb = STATUS_ORDER[b.status] ?? 9;
    if (sa !== sb) return sa - sb;
    return String(a.mask).localeCompare(String(b.mask), undefined, { numeric: true });
  });
}

const keyDot: Record<string, string> = {
  ok: 'bg-success',
  dead: 'bg-destructive',
  no_balance: 'bg-warning',
  cooldown: 'bg-muted-foreground',
  untested: 'bg-muted-foreground',
};
const dotLabel: Record<string, string> = {
  ok: t('keyHealth.statusOk'),
  dead: t('keyHealth.statusDead'),
  no_balance: t('keyHealth.statusNoBalance'),
  cooldown: t('keyHealth.statusCooling'),
  untested: t('keyHealth.statusUntested'),
};

function openAddModel() {
  modelForm.value = defaultModelForm();
  modelDialogOpen.value = true;
}

function openEditModel(model: Model) {
  modelForm.value = modelFormFrom(model);
  modelDialogOpen.value = true;
}

async function saveModel() {
  const form = modelForm.value;
  const body: ModelSaveRequest = {
    id: form.id || undefined,
    label: form.label,
    provider: form.provider,
    apiModel: form.apiModel,
    keyEnv: form.keyEnv.toUpperCase(),
    baseUrl: form.baseUrl,
    vision: form.vision,
    enabled: form.enabled,
    maxTokens: Number(form.maxTokens),
    supportsTemperature: form.supportsTemperature,
    temperature: form.supportsTemperature && form.temperature !== '' ? Number(form.temperature) : null,
    tokenParam: supportsTokenParam.value ? form.tokenParam : undefined,
    color: form.color || undefined,
  };
  modelSaving.value = true;
  try {
    const ok = await store.saveModel(body);
    if (ok) modelDialogOpen.value = false;
  } finally {
    modelSaving.value = false;
  }
}

const deleteModelConfirmOpen = ref(false);
const deleteModelConfirmMessage = ref('');
const pendingDeleteModel = ref<Model | null>(null);

function deleteModel(model: Model) {
  // Removing a model also removes its key pool, unless another active model
  // shares the same keyEnv, in which case the shared keys stay put.
  const shared = store.models.some((m) => m.id !== model.id && m.keyEnv === model.keyEnv);
  const pool = poolForModel(model);
  const keyCount = pool?.entries?.length || 0;
  const removeKeys = keyCount > 0 && !shared;
  const message = removeKeys
    ? t('keyHealth.removeModelWithKeys', { label: model.label, count: keyCount, pool: poolLabel(model.keyEnv) }, keyCount)
    : t('keyHealth.removeModel', { label: model.label });
  pendingDeleteModel.value = model;
  deleteModelConfirmMessage.value = message;
  deleteModelConfirmOpen.value = true;
}

async function confirmDeleteModel() {
  const model = pendingDeleteModel.value;
  if (!model) return;
  const shared = store.models.some((m) => m.id !== model.id && m.keyEnv === model.keyEnv);
  const pool = poolForModel(model);
  const keyCount = pool?.entries?.length || 0;
  const removeKeys = keyCount > 0 && !shared;
  await store.deleteModel(model.id);
  if (removeKeys && pool) {
    for (const entry of pool.entries) await store.deleteKey(pool.pool, entry.id);
  }
  pendingDeleteModel.value = null;
  modelDialogOpen.value = false;
}

// The row's edit dialog owns the remove action now, so resolve the live model
// from the form's id.
async function removeCurrentModel() {
  const model = store.models.find((m) => m.id === modelForm.value.id);
  if (model) await deleteModel(model);
  else modelDialogOpen.value = false;
}

function openAddKey(pool: string) {
  keyForm.value = { pool, id: '', mask: '', key: '' };
  keyDialogOpen.value = true;
}

function openEditKey(pool: string, entry: KeyEntry) {
  keyForm.value = { pool, id: entry.id, mask: entry.mask, key: '' };
  keyDialogOpen.value = true;
}

async function saveKey() {
  keySaving.value = true;
  try {
    const ok = await store.saveKey({
      pool: keyForm.value.pool,
      id: keyForm.value.id || undefined,
      key: keyForm.value.key,
    });
    if (ok) keyDialogOpen.value = false;
  } finally {
    keySaving.value = false;
  }
}

const deleteKeyConfirmOpen = ref(false);
const deleteKeyConfirmMessage = ref('');
const pendingDeleteKey = ref<{ pool: string; entry: KeyEntry } | null>(null);

async function deleteKey(pool: string, entry: KeyEntry) {
  pendingDeleteKey.value = { pool, entry };
  deleteKeyConfirmMessage.value = t('keyHealth.deleteKeyConfirm', { mask: entry.mask, pool: poolLabel(pool) });
  deleteKeyConfirmOpen.value = true;
}

async function confirmDeleteKey() {
  const pending = pendingDeleteKey.value;
  if (!pending) return;
  await store.deleteKey(pending.pool, pending.entry.id);
  pendingDeleteKey.value = null;
}
</script>

<template>
  <Sidebar
    :open="open"
    :side="side"
    :title="t('keyHealth.settings')"
    :description="t('keyHealth.settingsDescription')"
    @update:open="onOpenChange"
  >
    <template #header>
      <span class="text-sm font-semibold text-foreground">{{ t('keyHealth.settings') }}</span>
      <!-- Theme, refresh and shutdown are ACTIONS, not settings: they belong on the header rail
           next to the theme toggle, not as a "Server" card buried at the bottom of a tab. -->
      <div class="ml-auto flex items-center">
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-label="t('keyHealth.themeToggle', { theme: themeLabel })"
              @click="cycleTheme"
            >
              <component :is="themeIcon" class="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('keyHealth.themeToggle', { theme: themeLabel }) }}</TooltipContent>
        </Tooltip>
        <AppActionsBar
          layout="icons"
          hide-keys
          hide-theme
          :show-recent-runs="false"
          @refresh="emit('refresh')"
        />
      </div>
    </template>

        <SettingsTabs v-model="tab" :tabs="tabs" class="mb-5" />

        <!-- General: appearance, cloud sync, updates ──────────────────────────── -->
        <div v-show="tab === 'general'">
          <div class="mb-5">
            <AppearanceSection />
          </div>

          <div class="mb-5">
            <CloudSyncSection />
          </div>

          <AutoUpdateSection />
        </div>

        <!-- Main: models + keys (dashboard only; the viewer has no main tab) ───── -->
        <div v-show="tab === 'main'">
        <section v-if="!isViewer" class="mb-5">
          <ModelList
            :provider-label="providerLabel"
            :pool-for-model="poolForModel"
            :badges="badges"
            :sorted-entries="sortedEntries"
            :key-dot="keyDot"
            :dot-label="dotLabel"
            :pool-label="poolLabel"
            :delete-key="deleteKey"
            @add-model="openAddModel"
            @edit-model="openEditModel"
            @add-key="openAddKey"
            @edit-key="openEditKey"
            @import-keys="importOpen = true"
          />

          <OrphanKeyPools
            :badges="badges"
            :sorted-entries="sortedEntries"
            :key-dot="keyDot"
            :dot-label="dotLabel"
            :pool-label="poolLabel"
            :delete-key="deleteKey"
            @add-key="openAddKey"
            @edit-key="openEditKey"
          />

          <div v-if="spendLabel" class="mt-3 flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2 text-xs">
            <span class="text-muted-foreground" :title="spendTitle">{{ t('cost.spendToDate') }}</span>
            <span class="font-mono font-semibold">{{ spendLabel }}</span>
          </div>
          <p v-if="pricingLastUpdatedLabel" class="mt-1.5 text-[11px] text-muted-foreground/70">
            {{ pricingLastUpdatedLabel }}
          </p>
        </section>
        </div>
  </Sidebar>

  <ImportKeysDialog v-model:open="importOpen" />

  <ModelKeyDialogs
    v-model:model-dialog-open="modelDialogOpen"
    v-model:key-dialog-open="keyDialogOpen"
    :model-form="modelForm"
    :model-saving="modelSaving"
    :key-form="keyForm"
    :key-saving="keySaving"
    :provider-options="providerOptions"
    :token-param-options="tokenParamOptions"
    :supports-token-param="supportsTokenParam"
    :provider-label="providerLabel"
    :pool-label="poolLabel"
    @save-model="saveModel"
    @remove-model="removeCurrentModel"
    :on-provider-change="setModelProvider"
    @save-key="saveKey"
  />

  <AlertDialog v-model:open="deleteModelConfirmOpen">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ deleteModelConfirmMessage }}</AlertDialogTitle>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ t('keyHealth.cancel') }}</AlertDialogCancel>
        <AlertDialogAction variant="destructive" @click="confirmDeleteModel">{{ t('keyHealth.remove') }}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <AlertDialog v-model:open="deleteKeyConfirmOpen">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ deleteKeyConfirmMessage }}</AlertDialogTitle>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ t('keyHealth.cancel') }}</AlertDialogCancel>
        <AlertDialogAction variant="destructive" @click="confirmDeleteKey">{{ t('keyHealth.delete') }}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
