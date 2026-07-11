<script setup lang="ts">
import { onMounted } from 'vue';
import { toast } from 'vue-sonner';
import { Loader2Icon } from '@lucide/vue';
import { Switch } from '@/components/ui/switch';
import SettingsGroup from '@/shell/SettingsGroup.vue';
import SettingsRow from '@/shell/SettingsRow.vue';
import InfoHint from '@/shell/InfoHint.vue';
import { useControlStore } from '@/stores/control';
import { api } from '@/lib/api';
import { t } from '@/i18n';

const store = useControlStore();

async function onToggle(enabled: boolean): Promise<void> {
  try {
    await store.setPortableMode(enabled);
  } catch {
    toast.error(t('portableMode.toggleFailed'));
    return;
  }
  if (!enabled) return;
  // Persisted, now actually pop the app window (best-effort; the daemon never throws here).
  try {
    const result = await api.openPortableWindow();
    if (result.ok) {
      toast.success(t('portableMode.opened'));
    } else {
      toast.error(result.reason === 'no-browser' ? t('portableMode.noBrowser') : t('portableMode.openFailed'));
    }
  } catch {
    toast.error(t('portableMode.openFailed'));
  }
}

onMounted(() => {
  void store.loadPortableModeSetting();
});
</script>

<template>
  <SettingsGroup :label="t('portableMode.label')">
    <SettingsRow :label="t('portableMode.label')">
      <template #info>
        <InfoHint :text="t('portableMode.hint')" />
      </template>
      <template #control>
        <Loader2Icon v-if="store.portableModeLoading" class="size-3.5 animate-spin text-muted-foreground" />
        <Switch
          v-else
          :model-value="store.portableModeEnabled"
          :aria-label="t('portableMode.label')"
          @update:model-value="(v) => onToggle(!!v)"
        />
      </template>
    </SettingsRow>
  </SettingsGroup>
</template>
