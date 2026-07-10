import { ref, watch } from 'vue';
import { api } from '@/lib/api';
import { useTheme, type ThemeMode } from '@/lib/theme';
import type { SyncStatus } from '@/types';

/**
 * "Sync my settings with Connections", opt-in cloud sync of Reimagine's one portable
 * preference (theme). Mirrors the shared shape used by RepoYeti/DevWebUI: `enableSync()`
 * seeds the daemon with the current local appearance; a debounced watcher on the theme
 * mode pushes further local changes while sync stays enabled+connected; `applyAppearance()`
 * absorbs a pulled/loaded blob back into the live theme, guarded so that doesn't itself
 * re-trigger a push.
 *
 * Call INSIDE the control Pinia store and spread the returned refs/functions into its
 * `return {}}`, mirroring how `useSelfUpdate` is composed there.
 */
export function createSyncActions() {
  const { mode: themeMode, setTheme } = useTheme();

  const syncStatus = ref<SyncStatus | null>(null);
  const syncLoading = ref(false); // initial load + enable/disable in flight
  const syncActionBusy = ref(false); // manual pull/push in flight

  // Set while applying a just-pulled/loaded appearance, so the theme watcher below
  // doesn't immediately echo it back out as a push.
  let applyingRemote = false;

  function currentAppearance(): Record<string, unknown> {
    return { theme: themeMode.value };
  }

  /** Apply a synced appearance blob to the live theme (best-effort, ignores unknown/missing keys). */
  function applyAppearance(appearance: Record<string, unknown> | null | undefined): void {
    if (!appearance) return;
    const theme = appearance.theme;
    if (theme === 'light' || theme === 'dark' || theme === 'system') {
      applyingRemote = true;
      setTheme(theme as ThemeMode);
      applyingRemote = false;
    }
  }

  function absorbSyncStatus(s: SyncStatus): void {
    syncStatus.value = s;
    if (s.ok) applyAppearance(s.appearance);
  }

  /** Load the current sync status (mount + once after returning from sign-in). Best-effort. */
  async function loadSyncStatus(): Promise<void> {
    syncLoading.value = true;
    try {
      absorbSyncStatus(await api.getSyncStatus());
    } catch {
      /* sync is optional, leave whatever we have */
    } finally {
      syncLoading.value = false;
    }
  }

  /** Turn sync on, seeding it with the current local appearance. */
  async function enableSync(): Promise<void> {
    syncLoading.value = true;
    try {
      absorbSyncStatus(await api.setSync({ enabled: true, appearance: currentAppearance() }));
    } finally {
      syncLoading.value = false;
    }
  }

  /** Turn sync off. `forget` also disconnects: deletes the remote doc + forgets the credential. */
  async function disableSync(forget = false): Promise<void> {
    syncLoading.value = true;
    try {
      absorbSyncStatus(await api.setSync({ enabled: false, ...(forget ? { forget: true } : {}) }));
    } finally {
      syncLoading.value = false;
    }
  }

  /** Manually pull the settings synced from another device. */
  async function pullSync(): Promise<void> {
    syncActionBusy.value = true;
    try {
      absorbSyncStatus(await api.syncPull());
    } finally {
      syncActionBusy.value = false;
    }
  }

  /** Manually push the current synced settings now. */
  async function pushSync(): Promise<void> {
    syncActionBusy.value = true;
    try {
      absorbSyncStatus(await api.syncPush());
    } finally {
      syncActionBusy.value = false;
    }
  }

  /** Push just the current local appearance (theme) as the synced blob. */
  async function pushAppearance(): Promise<void> {
    absorbSyncStatus(await api.setSync({ appearance: currentAppearance() }));
  }

  // When the owner changes theme locally AND sync is enabled+connected, debounce and push the
  // new appearance so other devices pick it up. Skipped while a remote appearance is being
  // applied (avoids echoing a just-pulled value straight back out) or while sync is off/disconnected.
  let pushAppearanceTimer: ReturnType<typeof setTimeout> | undefined;
  watch(themeMode, () => {
    if (applyingRemote) return;
    const s = syncStatus.value;
    if (!s || !s.ok || !s.enabled || !s.connected) return;
    clearTimeout(pushAppearanceTimer);
    pushAppearanceTimer = setTimeout(() => {
      void pushAppearance();
    }, 800);
  });

  return {
    syncStatus,
    syncLoading,
    syncActionBusy,
    loadSyncStatus,
    enableSync,
    disableSync,
    pullSync,
    pushSync,
    pushAppearance,
    applyAppearance,
  };
}
