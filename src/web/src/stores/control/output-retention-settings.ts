import { ref } from 'vue';
import { api } from '@/lib/api';

/**
 * Output retention (see src/store.ts / http/routes/settings.ts): how long a finished run's output
 * files stay on disk before a cleanup sweep removes them. 0 (the default) keeps every run forever.
 * The sweep itself only runs once at server startup, so a lowered value takes effect on the next
 * launch, not immediately — see Settings ▸ General ▸ Output storage.
 *
 * `outputBytes` rides along on the same GET/PUT /api/settings payload as a read-only disk-usage
 * readout for that same settings row (walked on demand server-side, store.ts outputBytes()).
 * Mirrors @/stores/control/auto-update-settings.ts and portable-mode-settings.ts.
 */
export function createOutputRetentionSettingsActions() {
  const outputRetentionDays = ref(0);
  const outputBytes = ref(0);
  const outputRetentionLoading = ref(false); // initial load + change in flight

  /** Load the current setting + disk usage (call on mount). Best-effort, leaves the defaults on failure. */
  async function loadOutputRetentionSetting(): Promise<void> {
    outputRetentionLoading.value = true;
    try {
      const s = await api.getSettings();
      outputRetentionDays.value = s.outputRetentionDays;
      outputBytes.value = s.outputBytes;
    } catch {
      /* non-critical, leave the defaults */
    } finally {
      outputRetentionLoading.value = false;
    }
  }

  /** Change the retention window (optimistic; rolls back on failure). 0 means keep forever. */
  async function setOutputRetentionDays(days: number): Promise<void> {
    const prev = outputRetentionDays.value;
    outputRetentionDays.value = days;
    outputRetentionLoading.value = true;
    try {
      const s = await api.setOutputRetentionDays(days);
      outputRetentionDays.value = s.outputRetentionDays;
      outputBytes.value = s.outputBytes;
    } catch (e) {
      outputRetentionDays.value = prev; // roll back
      throw e;
    } finally {
      outputRetentionLoading.value = false;
    }
  }

  return {
    outputRetentionDays,
    outputBytes,
    outputRetentionLoading,
    loadOutputRetentionSetting,
    setOutputRetentionDays,
  };
}
