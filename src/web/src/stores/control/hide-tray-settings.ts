import { ref } from 'vue';
import { api } from '@/lib/api';

/**
 * Hide-tray-icon opt-in (see misc/ReDesign-Tray.ps1): hides the notification-area icon while
 * leaving the daemon, watchdog, and menu/quit machinery running untouched. OFF by default;
 * toggled via PUT /api/settings. The tray host re-reads runtime.json on its health timer, so a
 * change here reaches it within a few seconds without a restart. Mirrors
 * @/stores/control/portable-mode-settings.ts.
 */
export function createHideTraySettingsActions() {
  const hideTrayIconEnabled = ref(false);
  const hideTrayIconLoading = ref(false); // initial load + toggle in flight

  /** Load the current setting (call on mount). Best-effort, leaves the default (off) on failure. */
  async function loadHideTrayIconSetting(): Promise<void> {
    hideTrayIconLoading.value = true;
    try {
      const s = await api.getSettings();
      hideTrayIconEnabled.value = s.hideTrayIcon;
    } catch {
      /* non-critical, leave the default */
    } finally {
      hideTrayIconLoading.value = false;
    }
  }

  /** Toggle hide-tray-icon (optimistic; rolls back on failure). */
  async function setHideTrayIcon(enabled: boolean): Promise<void> {
    const prev = hideTrayIconEnabled.value;
    hideTrayIconEnabled.value = enabled;
    hideTrayIconLoading.value = true;
    try {
      const s = await api.setHideTrayIcon(enabled);
      hideTrayIconEnabled.value = s.hideTrayIcon;
    } catch (e) {
      hideTrayIconEnabled.value = prev; // roll back
      throw e;
    } finally {
      hideTrayIconLoading.value = false;
    }
  }

  return { hideTrayIconEnabled, hideTrayIconLoading, loadHideTrayIconSetting, setHideTrayIcon };
}
