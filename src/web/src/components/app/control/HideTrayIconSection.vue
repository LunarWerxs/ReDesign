<script setup lang="ts">
import { onMounted } from 'vue';
import { toast } from 'vue-sonner';
import { Loader2Icon } from '@lucide/vue';
import { Switch } from '@/components/ui/switch';
import SettingsGroup from '@/shell/SettingsGroup.vue';
import SettingsRow from '@/shell/SettingsRow.vue';
import InfoHint from '@/shell/InfoHint.vue';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';

const store = useControlStore();

async function onToggle(enabled: boolean): Promise<void> {
  try {
    await store.setHideTrayIcon(enabled);
  } catch {
    toast.error(t('hideTrayIcon.toggleFailed'));
  }
}

onMounted(() => {
  void store.loadHideTrayIconSetting();
});
</script>

<template>
  <SettingsGroup :label="t('hideTrayIcon.label')">
    <SettingsRow :label="t('hideTrayIcon.label')">
      <template #info>
        <InfoHint :text="t('hideTrayIcon.hint')" />
      </template>
      <template #control>
        <Loader2Icon v-if="store.hideTrayIconLoading" class="size-3.5 animate-spin text-muted-foreground" />
        <Switch
          v-else
          :model-value="store.hideTrayIconEnabled"
          :aria-label="t('hideTrayIcon.label')"
          @update:model-value="(v) => onToggle(!!v)"
        />
      </template>
    </SettingsRow>
  </SettingsGroup>
</template>
