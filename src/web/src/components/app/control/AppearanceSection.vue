<script setup lang="ts">
/**
 * Appearance: the three per-machine "how the app presents itself" switches, in one group
 * (2026-07-21). They used to be three separate one-row SettingsGroups stacked on top of each
 * other — three headings for three switches, which reads as three unrelated features rather
 * than one topic. Merged here; the individual TooltipPreferenceSection / PortableModeSection /
 * HideTrayIconSection components were deleted, not left behind as dead files.
 *
 * All three are local to this machine: tooltips are a localStorage kit flag with no server round
 * trip, the other two are daemon settings (PUT /api/settings) that the tray/launcher also read.
 */
import { onMounted } from 'vue';
import { toast } from 'vue-sonner';
import { Loader2Icon } from '@lucide/vue';
import { Switch } from '@/components/ui/switch';
import SettingsGroup from '@/shell/SettingsGroup.vue';
import SettingsRow from '@/shell/SettingsRow.vue';
import InfoHint from '@/shell/InfoHint.vue';
import { useControlStore } from '@/stores/control';
import { useTooltipConfig } from '@/lib/tooltip-config';
import { api } from '@/lib/api';
import { t } from '@/i18n';

const store = useControlStore();
const { enabled: tooltipsEnabled } = useTooltipConfig();

async function onPortableToggle(enabled: boolean): Promise<void> {
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

async function onTrayToggle(enabled: boolean): Promise<void> {
  try {
    await store.setHideTrayIcon(enabled);
  } catch {
    toast.error(t('hideTrayIcon.toggleFailed'));
  }
}

onMounted(() => {
  void store.loadPortableModeSetting();
  void store.loadHideTrayIconSetting();
});
</script>

<template>
  <SettingsGroup :label="t('appearance.label')">
    <SettingsRow :label="t('tooltipPreference.label')">
      <template #info>
        <InfoHint :text="t('tooltipPreference.hint')" />
      </template>
      <template #control>
        <Switch v-model="tooltipsEnabled" :aria-label="t('tooltipPreference.label')" />
      </template>
    </SettingsRow>

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
          @update:model-value="(v) => onPortableToggle(!!v)"
        />
      </template>
    </SettingsRow>

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
          @update:model-value="(v) => onTrayToggle(!!v)"
        />
      </template>
    </SettingsRow>
  </SettingsGroup>
</template>
