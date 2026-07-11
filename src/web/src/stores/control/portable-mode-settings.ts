import { ref } from 'vue';
import { api } from '@/lib/api';

/**
 * Portable window opt-in (see src/portable-window.mjs): opens the app UI in a chromeless
 * Chromium app window instead of a normal browser tab, both from this toggle and from the
 * tray/start.cmd launcher, which reads the same setting back out of runtime.json. OFF by
 * default; toggled via PUT /api/settings. Mirrors @/stores/control/auto-update-settings.ts.
 */
export function createPortableModeSettingsActions() {
  const portableModeEnabled = ref(false);
  const portableModeLoading = ref(false); // initial load + toggle in flight

  /** Load the current setting (call on mount). Best-effort, leaves the default (off) on failure. */
  async function loadPortableModeSetting(): Promise<void> {
    portableModeLoading.value = true;
    try {
      const s = await api.getSettings();
      portableModeEnabled.value = s.portableMode;
    } catch {
      /* non-critical, leave the default */
    } finally {
      portableModeLoading.value = false;
    }
  }

  /** Toggle portable mode (optimistic; rolls back on failure). */
  async function setPortableMode(enabled: boolean): Promise<void> {
    const prev = portableModeEnabled.value;
    portableModeEnabled.value = enabled;
    portableModeLoading.value = true;
    try {
      const s = await api.setPortableMode(enabled);
      portableModeEnabled.value = s.portableMode;
    } catch (e) {
      portableModeEnabled.value = prev; // roll back
      throw e;
    } finally {
      portableModeLoading.value = false;
    }
  }

  return { portableModeEnabled, portableModeLoading, loadPortableModeSetting, setPortableMode };
}
