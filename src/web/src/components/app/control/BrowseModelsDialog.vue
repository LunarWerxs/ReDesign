<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { CheckIcon, Loader2Icon, PlusIcon } from '@lucide/vue';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useControlStore } from '@/stores/control';
import { api } from '@/lib/api';
import { errMessage } from '@/stores/control/state';
import { providerOptions, OPENAI_FAMILY } from '@/lib/providers';
import { t } from '@/i18n';
import type { AvailableModel, ModelSaveRequest, ProviderDefault } from '@/types';

const open = defineModel<boolean>('open', { default: false });
const store = useControlStore();

const provider = ref('openai');
const loading = ref(false);
const error = ref('');
const available = ref<AvailableModel[]>([]);
const source = ref<'provider' | 'catalog'>('provider');
const search = ref('');
const addingIds = ref<Set<string>>(new Set());

const defaults = computed<ProviderDefault>(
  () => store.providerDefaults[provider.value] || { baseUrl: '', keyEnv: '', color: '' },
);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return available.value;
  return available.value.filter((m) => m.id.toLowerCase().includes(q) || (m.label || '').toLowerCase().includes(q));
});

// A model is "already added" if an active model targets the same provider + apiModel.
function isConfigured(apiModel: string) {
  return store.models.some((m) => m.provider === provider.value && m.apiModel === apiModel);
}

async function load() {
  loading.value = true;
  error.value = '';
  available.value = [];
  try {
    const d = defaults.value;
    const res = await api.availableModels({ provider: provider.value, baseUrl: d.baseUrl, keyEnv: d.keyEnv });
    available.value = res.models;
    source.value = res.source;
    if (!res.models.length) error.value = t('browseModels.empty');
  } catch (e) {
    error.value = errMessage(e) || t('browseModels.error');
  } finally {
    loading.value = false;
  }
}

async function addModel(am: AvailableModel) {
  if (isConfigured(am.id) || addingIds.value.has(am.id)) return;
  const d = defaults.value;
  const body: ModelSaveRequest = {
    label: am.label || am.id,
    provider: provider.value,
    apiModel: am.id,
    keyEnv: d.keyEnv,
    baseUrl: d.baseUrl,
    vision: am.vision ?? true,
    enabled: true,
    maxTokens: 16000,
    supportsTemperature: true,
    temperature: 1,
    tokenParam: OPENAI_FAMILY.has(provider.value) ? 'max_tokens' : undefined,
    color: d.color || undefined,
  };
  addingIds.value = new Set(addingIds.value).add(am.id);
  try {
    await store.saveModel(body);
  } finally {
    const next = new Set(addingIds.value);
    next.delete(am.id);
    addingIds.value = next;
  }
}

// (Re)load whenever the dialog opens or the provider changes.
watch(open, (o) => {
  if (o) {
    search.value = '';
    load();
  }
});
watch(provider, () => {
  if (open.value) load();
});
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ t('browseModels.title') }}</DialogTitle>
        <DialogDescription>{{ t('browseModels.description') }}</DialogDescription>
      </DialogHeader>

      <div class="flex items-center gap-2">
        <Label class="text-xs text-muted-foreground">{{ t('browseModels.provider') }}</Label>
        <Select v-model="provider">
          <SelectTrigger class="h-8 w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="p in providerOptions" :key="p.value" :value="p.value">{{ p.label }}</SelectItem>
          </SelectContent>
        </Select>
        <Input v-model="search" :placeholder="t('browseModels.searchPlaceholder')" class="h-8 flex-1" />
      </div>

      <div class="grid max-h-72 gap-1 overflow-y-auto rounded-md border bg-muted/20 p-1.5">
        <div v-if="loading" class="flex items-center gap-2 px-2 py-6 text-xs text-muted-foreground">
          <Loader2Icon class="size-4 animate-spin" />
          {{ t('browseModels.loading') }}
        </div>
        <p v-else-if="error" class="px-2 py-6 text-center text-xs text-muted-foreground">{{ error }}</p>
        <template v-else>
          <div class="px-1 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
            {{ source === 'provider' ? t('browseModels.sourceProvider') : t('browseModels.sourceCatalog') }}
          </div>
          <div
            v-for="m in filtered"
            :key="m.id"
            class="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/50"
          >
            <span class="min-w-0 flex-1 truncate">
              <span class="font-medium">{{ m.label }}</span>
              <span v-if="m.label !== m.id" class="text-muted-foreground"> · {{ m.id }}</span>
            </span>
            <span v-if="isConfigured(m.id)" class="flex shrink-0 items-center gap-1 text-success">
              <CheckIcon class="size-3.5" /> {{ t('browseModels.added') }}
            </span>
            <Button
              v-else
              size="xs"
              variant="secondary"
              :disabled="addingIds.has(m.id)"
              @click="addModel(m)"
            >
              <Loader2Icon v-if="addingIds.has(m.id)" class="size-3 animate-spin" />
              <PlusIcon v-else class="size-3" />
              {{ addingIds.has(m.id) ? t('browseModels.adding') : t('browseModels.add') }}
            </Button>
          </div>
        </template>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="open = false">{{ t('browseModels.done') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
