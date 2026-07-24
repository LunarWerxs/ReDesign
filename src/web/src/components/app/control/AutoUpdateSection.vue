<script setup lang="ts">
// Updates: check-for-updates + auto-update, folded into one section (2026-07-11) so
// there's a single place to reason about staying current, instead of "Check for updates"
// living as a separate action-bar/menu item apart from the auto-update toggle.
import { computed, onMounted } from 'vue';
import { toast } from 'vue-sonner';
import { DownloadCloudIcon, Loader2Icon } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import SettingsGroup from '@/shell/SettingsGroup.vue';
import SettingsRow from '@/shell/SettingsRow.vue';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';

const store = useControlStore();

const checkLabel = computed(() => {
  if (store.updateApplying) return t('actions.updateTooltipApplying');
  if (store.updateChecking) return t('actions.updateTooltipChecking');
  if (store.updateStatus?.updateAvailable) return t('actions.updateTooltipAvailable');
  return t('actions.updateTooltipIdle');
});

async function onCheck(): Promise<void> {
  if (store.updateChecking || store.updateApplying) return;
  try {
    let status = store.updateStatus;
    if (!status) status = await store.checkForUpdate();
    if (!status?.ok) {
      toast.warning(t('actions.updateCheckFailed'), { description: status?.reason || undefined });
      return;
    }
    if (!status?.updateAvailable) {
      toast(t('actions.updateNone'));
      return;
    }
    if (!status.canApply) {
      toast.warning(t('actions.updateBlocked'), { description: status.reason || undefined });
      return;
    }
    const result = await store.applyUpdate();
    toast.success(t('actions.updateApplied'), {
      description: result.restartRequired ? t('actions.updateRestart') : undefined,
    });
  } catch (e) {
    toast.error(t('actions.updateFailed'), { description: e instanceof Error ? e.message : undefined });
  }
}

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
    <!-- What am I running? Answerable in Settings instead of only from a terminal. -->
    <SettingsRow :label="t('autoUpdate.versionLabel')">
      <template #control>
        <!-- i18n-ignore -->
        <span class="font-mono text-[12.5px] text-foreground">{{ store.appVersion || t('autoUpdate.versionUnknown') }}</span>
      </template>
    </SettingsRow>
    <SettingsRow :label="t('actions.checkUpdates')">
      <template #control>
        <Button
          variant="ghost"
          size="sm"
          :disabled="store.updateChecking || store.updateApplying"
          :title="checkLabel"
          @click="onCheck"
        >
          <Loader2Icon v-if="store.updateChecking || store.updateApplying" class="size-3.5 animate-spin" />
          <DownloadCloudIcon v-else class="size-3.5" />
          {{ t('actions.checkUpdatesShort') }}
        </Button>
      </template>
    </SettingsRow>
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
