import { toast } from 'vue-sonner';
import { t } from '@/i18n';
import { errMessage } from '@/stores/control/state';

/**
 * Shared try/toast/return-boolean wrapper for the control store's uniform mutating
 * actions: run the api call, apply state on success (plus an optional success toast),
 * and on failure show the i18n-keyed error with the extracted message as description.
 * Only for the uniform shape, actions with extra branching (savePrompt's wasNew,
 * shutdownServer's TypeError special-case, applyUpdate) keep their own try/catch.
 */
export async function withToast<T>(
  fn: () => Promise<T>,
  opts: { onSuccess?: (r: T) => void; successMsg?: string; errKey: string },
): Promise<boolean> {
  try {
    const r = await fn();
    opts.onSuccess?.(r);
    if (opts.successMsg) toast.success(opts.successMsg);
    return true;
  } catch (e) {
    toast.error(t(opts.errKey), { description: errMessage(e) });
    return false;
  }
}
