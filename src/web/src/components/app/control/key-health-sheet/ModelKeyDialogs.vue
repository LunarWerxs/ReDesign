<script setup lang="ts">
import { Loader2Icon, Trash2Icon } from '@lucide/vue';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { t } from '@/i18n';
import ModelIdCombobox from './ModelIdCombobox.vue';

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

defineProps<{
  modelForm: ModelForm;
  modelSaving: boolean;
  keyForm: { pool: string; id: string; mask: string; key: string };
  keySaving: boolean;
  providerOptions: { value: string; label: string }[];
  tokenParamOptions: { value: string; label: string }[];
  supportsTokenParam: boolean;
  providerLabel: (provider?: string) => string;
  poolLabel: (pool?: string) => string;
  onProviderChange: (provider: string) => void;
}>();

const modelDialogOpen = defineModel<boolean>('modelDialogOpen', { default: false });
const keyDialogOpen = defineModel<boolean>('keyDialogOpen', { default: false });

const emit = defineEmits<{
  'save-model': [];
  'remove-model': [];
  'save-key': [];
}>();
</script>

<template>
  <Dialog :open="modelDialogOpen" @update:open="modelDialogOpen = $event">
    <DialogContent class="max-h-[min(90vh,760px)] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{{ modelForm.id ? t('keyModel.editModel') : t('keyModel.addModel') }}</DialogTitle>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="emit('save-model')">
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="grid gap-1.5">
            <Label for="model-label">{{ t('keyModel.label') }}</Label>
            <Input id="model-label" v-model="modelForm.label" required />
          </div>
          <div class="grid gap-1.5">
            <Label for="model-id">{{ t('keyModel.modelId') }}</Label>
            <Input id="model-id" v-model="modelForm.id" :disabled="!!modelForm.id" :placeholder="t('keyModel.generatedFromLabel')" />
          </div>
          <div class="grid gap-1.5">
            <Label for="model-provider">{{ t('keyModel.provider') }}</Label>
            <Select :model-value="modelForm.provider" @update:model-value="(v) => { modelForm.provider = String(v); onProviderChange(String(v)); }">
              <SelectTrigger id="model-provider">
                <span>{{ providerLabel(modelForm.provider) }}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="provider in providerOptions" :key="provider.value" :value="provider.value">
                  {{ provider.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid gap-1.5">
            <Label for="model-api-model">{{ t('keyModel.apiModel') }}</Label>
            <ModelIdCombobox
              id="model-api-model"
              v-model="modelForm.apiModel"
              :provider="modelForm.provider"
              :base-url="modelForm.baseUrl"
              :key-env="modelForm.keyEnv"
            />
          </div>
          <div class="grid gap-1.5">
            <Label for="model-key-env">{{ t('keyModel.keyEnv') }}</Label>
            <Input
              id="model-key-env"
              :model-value="modelForm.keyEnv"
              required
              @update:model-value="modelForm.keyEnv = String($event).toUpperCase()"
            />
          </div>
          <div class="grid gap-1.5">
            <Label for="model-max-tokens">{{ t('keyModel.maxTokens') }}</Label>
            <Input id="model-max-tokens" v-model="modelForm.maxTokens" type="number" min="1" required />
          </div>
          <div class="grid gap-1.5 sm:col-span-2">
            <Label for="model-base-url">{{ t('keyModel.baseUrl') }}</Label>
            <Input id="model-base-url" v-model="modelForm.baseUrl" type="url" required />
          </div>
          <div v-if="supportsTokenParam" class="grid gap-1.5">
            <Label for="model-token-param">{{ t('keyModel.tokenParam') }}</Label>
            <Select :model-value="modelForm.tokenParam" @update:model-value="modelForm.tokenParam = String($event)">
              <SelectTrigger id="model-token-param">
                <span>{{ modelForm.tokenParam }}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in tokenParamOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid gap-1.5">
            <Label for="model-color">{{ t('keyModel.color') }}</Label>
            <div class="flex items-center gap-2">
              <Input id="model-color" v-model="modelForm.color" type="color" class="h-9 w-12 p-1" />
              <Input v-model="modelForm.color" pattern="#[0-9a-fA-F]{6}" />
            </div>
          </div>
        </div>

        <div class="flex flex-wrap gap-4 rounded-lg border bg-muted/20 px-3 py-2">
          <label class="flex cursor-pointer items-center gap-2 text-sm">
            <Switch v-model="modelForm.vision" />
            <span>{{ t('keyModel.vision') }}</span>
          </label>
          <label class="flex cursor-pointer items-center gap-2 text-sm">
            <Switch v-model="modelForm.supportsTemperature" />
            <span>{{ t('keyModel.temperature') }}</span>
          </label>
          <div v-if="modelForm.supportsTemperature" class="ml-auto flex min-w-32 items-center gap-2">
            <Label for="model-temperature" class="text-sm">{{ t('keyModel.temp') }}</Label>
            <Input
              id="model-temperature"
              v-model="modelForm.temperature"
              type="number"
              min="0"
              max="2"
              step="0.1"
              class="w-20"
            />
          </div>
        </div>

        <div class="flex items-center gap-2">
          <label class="flex cursor-pointer items-center gap-2 text-sm" :title="t('keyModel.enableOrDisableModel')">
            <Switch v-model="modelForm.enabled" />
            <span>{{ t('keyModel.enabled') }}</span>
          </label>
          <Button
            v-if="modelForm.id"
            type="button"
            variant="ghost"
            class="text-destructive hover:bg-destructive/10 hover:text-destructive"
            :disabled="modelSaving"
            @click="emit('remove-model')"
          >
            <Trash2Icon class="size-4" />
            {{ t('keyModel.remove') }}
          </Button>
          <div class="ml-auto flex items-center gap-2">
            <Button type="button" variant="ghost" @click="modelDialogOpen = false">{{ t('keyModel.cancel') }}</Button>
            <Button type="submit" :disabled="modelSaving">
              <Loader2Icon v-if="modelSaving" class="size-4 animate-spin" />
              {{ t('keyModel.save') }}
            </Button>
          </div>
        </div>
      </form>
    </DialogContent>
  </Dialog>

  <Dialog :open="keyDialogOpen" @update:open="keyDialogOpen = $event">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ keyForm.id ? t('keyModel.editApiKey') : t('keyModel.addApiKey') }}</DialogTitle>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="emit('save-key')">
        <div class="grid gap-1.5">
          <Label for="api-key-pool">{{ t('keyModel.pool') }}</Label>
          <Input id="api-key-pool" :model-value="poolLabel(keyForm.pool)" disabled />
        </div>
        <div v-if="keyForm.id" class="grid gap-1.5">
          <Label for="api-key-current">{{ t('keyModel.current') }}</Label>
          <Input id="api-key-current" :model-value="keyForm.mask" disabled />
        </div>
        <div class="grid gap-1.5">
          <Label for="api-key-value">{{ t('keyModel.apiKey') }}</Label>
          <Input
            id="api-key-value"
            v-model="keyForm.key"
            type="password"
            autocomplete="off"
            spellcheck="false"
            :placeholder="keyForm.id ? t('keyModel.pasteReplacementKey') : t('keyModel.pasteApiKey')"
            required
          />
        </div>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" @click="keyDialogOpen = false">{{ t('keyModel.cancel') }}</Button>
          <Button type="submit" :disabled="keySaving">
            <Loader2Icon v-if="keySaving" class="size-4 animate-spin" />
            {{ t('keyModel.save') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>
