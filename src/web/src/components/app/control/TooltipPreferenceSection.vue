<script setup lang="ts">
import { Switch } from '@/components/ui/switch';
import SettingsGroup from '@/shell/SettingsGroup.vue';
import SettingsRow from '@/shell/SettingsRow.vue';
import InfoHint from '@/shell/InfoHint.vue';
import { useTooltipConfig } from '@/lib/tooltip-config';
import { t } from '@/i18n';

// Kit-level kill switch (lib/tooltip-config.ts): localStorage-persisted, no server
// round trip, so this binds straight to the shared ref with no loading state.
const { enabled: tooltipsEnabled } = useTooltipConfig();
</script>

<template>
  <SettingsGroup :label="t('tooltipPreference.label')">
    <SettingsRow :label="t('tooltipPreference.label')">
      <template #info>
        <InfoHint :text="t('tooltipPreference.hint')" />
      </template>
      <template #control>
        <Switch
          v-model="tooltipsEnabled"
          :aria-label="t('tooltipPreference.label')"
        />
      </template>
    </SettingsRow>
  </SettingsGroup>
</template>
