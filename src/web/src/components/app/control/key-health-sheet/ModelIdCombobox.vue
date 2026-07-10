<script setup lang="ts">
// Free-text API-model Input + a searchable dropdown of models the app can
// actually see for this provider (live from the provider's own list-models
// API when a key is stored, falling back to the models.dev catalog). Typing
// stays fully available, the dropdown is a convenience, not a constraint.
import { computed, ref, watch } from 'vue';
import { ChevronsUpDownIcon, CloudIcon, ZapIcon } from '@lucide/vue';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { api } from '@/lib/api';
import { t } from '@/i18n';
import type { AvailableModel } from '@/types';

const props = defineProps<{
  id?: string;
  provider: string;
  baseUrl: string;
  keyEnv: string;
}>();

const modelValue = defineModel<string>({ default: '' });

const open = ref(false);
const loading = ref(false);
const loaded = ref(false);
const error = ref(false);
const options = ref<AvailableModel[]>([]);

const providerOptions = computed(() => options.value.filter((m) => m.source === 'provider'));
const catalogOptions = computed(() => options.value.filter((m) => m.source === 'catalog'));

async function load() {
  if (!props.provider) return;
  loading.value = true;
  error.value = false;
  try {
    const res = await api.availableModels({
      provider: props.provider,
      baseUrl: props.baseUrl,
      keyEnv: props.keyEnv,
    });
    options.value = res.models || [];
    loaded.value = true;
  } catch {
    error.value = true;
    options.value = [];
  } finally {
    loading.value = false;
  }
}

// Refetch whenever the dialog reopens against a (possibly) different provider,
// and once more if the provider/baseUrl changes while open.
watch(open, (v) => {
  if (v) void load();
});
watch(() => [props.provider, props.baseUrl], () => {
  loaded.value = false;
  if (open.value) void load();
});

function pick(id: string) {
  modelValue.value = id;
  open.value = false;
}
</script>

<template>
  <div class="flex items-center gap-1.5">
    <Input :id="id" v-model="modelValue" required class="flex-1" />
    <Popover v-model:open="open">
      <PopoverTrigger as-child>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          :title="t('keyModel.browseAvailableModels')"
          :aria-label="t('keyModel.browseAvailableModels')"
        >
          <ChevronsUpDownIcon class="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" :collision-padding="12" class="w-[min(360px,calc(100vw-2rem))] p-0">
        <Command>
          <CommandInput :placeholder="t('keyModel.searchModels')" />
          <CommandList class="max-h-[min(50vh,320px)]">
            <div v-if="loading" class="px-3 py-4 text-center text-xs text-muted-foreground">
              {{ t('keyModel.loadingModels') }}
            </div>
            <template v-else>
              <CommandEmpty>{{ t('keyModel.noModelsFound') }}</CommandEmpty>
              <p v-if="error" class="px-3 py-2 text-xs text-muted-foreground">{{ t('keyModel.couldNotLoadModels') }}</p>
              <CommandGroup v-if="providerOptions.length" :heading="t('keyModel.fromProviderAccount')">
                <CommandItem
                  v-for="m in providerOptions"
                  :key="m.id"
                  :value="`${m.id} ${m.label}`"
                  @select="pick(m.id)"
                >
                  <ZapIcon class="size-3.5 text-muted-foreground" />
                  <span class="truncate">{{ m.label }}</span>
                  <span v-if="m.label !== m.id" class="ml-auto truncate text-muted-foreground">{{ m.id }}</span>
                </CommandItem>
              </CommandGroup>
              <CommandGroup v-if="catalogOptions.length" :heading="t('keyModel.fromCatalog')">
                <CommandItem
                  v-for="m in catalogOptions"
                  :key="m.id"
                  :value="`${m.id} ${m.label}`"
                  @select="pick(m.id)"
                >
                  <CloudIcon class="size-3.5 text-muted-foreground" />
                  <span class="truncate">{{ m.label }}</span>
                  <span v-if="m.label !== m.id" class="ml-auto truncate text-muted-foreground">{{ m.id }}</span>
                </CommandItem>
              </CommandGroup>
            </template>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  </div>
</template>
