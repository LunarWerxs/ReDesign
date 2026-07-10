<script setup lang="ts">
import { onMounted } from 'vue';
import { toast } from 'vue-sonner';
import { Loader2Icon } from '@lucide/vue';
import { Switch } from '@/components/ui/switch';
import SettingsGroup from '@/shell/SettingsGroup.vue';
import SettingsRow from '@/shell/SettingsRow.vue';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';

const store = useControlStore();

async function onToggle(enabled: boolean): Promise<void> {
  try {
    await store.setAutoUpdate(enabled);
  } catch {
    toast.error(t('autoUpdate.toggleFailed'));
  }
}

onMounted(() => {
  void store.loadAutoUpdateSetting();
});
</script>

<template>
  <SettingsGroup :label="t('autoUpdate.label')" :description="t('autoUpdate.hint')">
    <SettingsRow :label="t('autoUpdate.enableLabel')">
      <template #control>
        <Loader2Icon v-if="store.autoUpdateLoading" class="size-3.5 animate-spin text-muted-foreground" />
        <Switch
          v-else
          :model-value="store.autoUpdateEnabled"
          :aria-label="t('autoUpdate.enableLabel')"
          @update:model-value="(v) => onToggle(!!v)"
        />
      </template>
    </SettingsRow>
  </SettingsGroup>
</template>
