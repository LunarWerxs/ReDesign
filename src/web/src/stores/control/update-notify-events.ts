import { toast } from 'vue-sonner';
import { t } from '@/i18n';
import { daemonEventsUrl } from '@/lib/api';
import type { DaemonEvent, UpdateApplyResult } from '@/types';

/**
 * Daemon-wide "an update is available" push (see src/bus.ts, src/auto-update.ts's notify path).
 * Opens ONE EventSource for the app's whole lifetime — App.vue calls `connect()` once on mount,
 * guarded so a remount/re-call is a no-op — because this is NOT scoped to a run, unlike
 * @/stores/viewer.ts's per-run SSE: an update can be announced whether or not anything is running.
 *
 * The offer is a persistent (non-auto-dismissing) toast with an "Update now" action wired to the
 * existing manual apply path, not a new notification-center UI: this app doesn't have one, and a
 * toast reuses infrastructure every other action-result already goes through.
 */
export function createUpdateNotifyEventsActions(deps: { applyUpdate: () => Promise<UpdateApplyResult> }) {
  let source: EventSource | null = null;
  let applying = false;

  // Fixed id: a second announcement before the first is dismissed REPLACES it rather than
  // stacking a duplicate toast (the scheduled check re-announces on every interval until the
  // owner acts, see src/auto-update.ts's "notified" reason).
  const TOAST_ID = 'update-available';

  async function updateNow(): Promise<void> {
    if (applying) return;
    applying = true;
    try {
      const result = await deps.applyUpdate();
      toast.success(t('actions.updateApplied'), {
        description: result.restartRequired ? t('actions.updateRestart') : undefined,
      });
    } catch (e) {
      toast.error(t('actions.updateFailed'), { description: e instanceof Error ? e.message : undefined });
    } finally {
      applying = false;
    }
  }

  function announce(info: { canApply: boolean; reason: string | null }): void {
    toast(t('notify.updateAvailableTitle'), {
      id: TOAST_ID,
      duration: Infinity,
      description: info.canApply ? t('notify.updateAvailableBody') : info.reason || t('notify.updateBlockedBody'),
      action: info.canApply ? { label: t('notify.updateNow'), onClick: () => void updateNow() } : undefined,
    });
  }

  function handleMessage(event: MessageEvent<string>): void {
    let payload: DaemonEvent;
    try {
      payload = JSON.parse(event.data) as DaemonEvent;
    } catch {
      return;
    }
    if (payload.type !== 'update_available') return;
    announce({ canApply: payload.canApply !== false, reason: payload.reason ?? null });
  }

  /** Open the connection once. Safe to call again (e.g. from a remounted root component). */
  function connect(): void {
    if (source || typeof EventSource === 'undefined') return;
    source = new EventSource(daemonEventsUrl);
    source.onmessage = handleMessage;
    // No onerror handler on purpose: EventSource reconnects on its own using the browser's
    // built-in backoff, same as @/stores/control/runs.ts's per-run subscriptions.
  }

  return { connect };
}
