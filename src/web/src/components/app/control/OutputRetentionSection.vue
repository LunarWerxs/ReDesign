<script setup lang="ts">
// Output storage: how long a finished run's files stay on disk before a cleanup sweep removes
// them, plus a read-only disk-usage readout for the same row (see
// stores/control/output-retention-settings.ts / http/routes/settings.ts). Lives in the same
// General tab as AutoUpdateSection / AppearanceSection's portable-window toggle.
import { computed, onMounted } from 'vue';
import { toast } from 'vue-sonner';
import { Loader2Icon } from '@lucide/vue';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import SettingsGroup from '@/shell/SettingsGroup.vue';
import SettingsRow from '@/shell/SettingsRow.vue';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';

const store = useControlStore();

// A handful of sensible day counts plus 0 ("forever", the default) — not a free-typed number:
// this deletes the user's own output files, so the choices are deliberately coarse and safe.
const RETENTION_DAY_OPTIONS = [0, 7, 14, 30, 90, 180, 365];
const retentionOptions = computed(() =>
  RETENTION_DAY_OPTIONS.map((days) => ({
    value: String(days),
    label: days === 0 ? t('outputRetention.forever') : t('outputRetention.days', { count: days }, days),
  })),
);

/** Human-readable disk usage (binary/1024 units, matching what Explorer/du report). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${exponent === 0 ? value : value.toFixed(value < 10 ? 2 : 1)} ${units[exponent]}`;
}
const diskUsageLabel = computed(() => formatBytes(store.outputBytes));

async function onRetentionChange(value: unknown): Promise<void> {
  const days = Number(value);
  if (!Number.isFinite(days)) return;
  try {
    await store.setOutputRetentionDays(days);
  } catch {
    toast.error(t('outputRetention.toggleFailed'));
  }
}

onMounted(() => {
  void store.loadOutputRetentionSetting();
});
</script>

<template>
  <SettingsGroup :label="t('outputRetention.label')" :description="t('outputRetention.hint')">
    <SettingsRow :label="t('outputRetention.diskUsageLabel')">
      <template #control>
        <span class="font-mono text-[12.5px] text-foreground">{{ diskUsageLabel }}</span>
      </template>
    </SettingsRow>
    <SettingsRow :label="t('outputRetention.keepLabel')">
      <template #control>
        <Loader2Icon v-if="store.outputRetentionLoading" class="size-3.5 animate-spin text-muted-foreground" />
        <Select v-else :model-value="String(store.outputRetentionDays)" @update:model-value="onRetentionChange">
          <SelectTrigger class="h-8 w-[150px] text-[12.5px]" :aria-label="t('outputRetention.keepLabel')">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="opt in retentionOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </template>
    </SettingsRow>
  </SettingsGroup>
</template>
