<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { toast } from 'vue-sonner';
import { CloudIcon, CheckIcon, ExternalLinkIcon, Loader2Icon, RefreshCwIcon, LogOutIcon } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import SettingsGroup from '@/shell/SettingsGroup.vue';
import InfoHint from '@/shell/InfoHint.vue';
import { useControlStore } from '@/stores/control';
import { formatAgo } from '@/lib/relativeTime';
import { t } from '@/i18n';

const store = useControlStore();

const confirmDisconnect = ref(false);
const now = ref(Date.now());

function signIn(): void {
  // Open the OAuth flow in a NEW tab so the current app state isn't lost (the new tab lands on
  // /?connected=1 after auth).
  window.open('/oauth/login', '_blank', 'noopener,noreferrer');
}

/** Master toggle. ON with no connection yet → send through sign-in first. */
async function onToggle(enabled: boolean): Promise<void> {
  confirmDisconnect.value = false;
  if (enabled) {
    if (!store.syncStatus?.ok || !store.syncStatus.connected) {
      signIn();
      return;
    }
    try {
      await store.enableSync();
    } catch {
      toast.error(t('cloudSync.enableFailed'));
    }
  } else {
    try {
      await store.disableSync();
    } catch {
      toast.error(t('cloudSync.disableFailed'));
    }
  }
}

async function syncNow(): Promise<void> {
  try {
    await store.pullSync();
  } catch {
    toast.error(t('cloudSync.pullFailed'));
    return;
  }
  try {
    await store.pushSync();
  } catch {
    toast.error(t('cloudSync.pushFailed'));
  }
}

/** Two-step confirm, matching the delete-model / delete-key confirm pattern in this sheet. */
async function disconnect(): Promise<void> {
  if (!confirmDisconnect.value) {
    confirmDisconnect.value = true;
    return;
  }
  confirmDisconnect.value = false;
  try {
    await store.disableSync(true);
  } catch {
    toast.error(t('cloudSync.disableFailed'));
  }
}

const syncedAgo = computed(() => {
  const s = store.syncStatus;
  if (!s?.ok || !s.lastSyncedAt) return null;
  return formatAgo(now.value, new Date(s.lastSyncedAt).getTime(), t);
});

const syncError = computed(() => (store.syncStatus && !store.syncStatus.ok ? store.syncStatus : null));

onMounted(() => {
  now.value = Date.now();
});
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <SettingsGroup :label="t('cloudSync.label')" :description="t('cloudSync.privacyNote')">
      <!-- not connected yet → the primary action is signing in with Connections -->
      <div v-if="!store.syncStatus || (!store.syncStatus.ok && !store.syncStatus.retryAfterSeconds) || (store.syncStatus.ok && !store.syncStatus.connected)" class="flex flex-col gap-2.5 px-3.5 py-3">
        <span class="flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
          <CloudIcon class="size-3.5 shrink-0 text-sky-500" />
          {{ t('cloudSync.title') }}
          <InfoHint :text="t('cloudSync.enableHint')" />
        </span>
        <Button size="sm" class="self-start" @click="signIn">
          <CloudIcon class="size-3.5" />
          {{ t('cloudSync.signIn') }}
          <ExternalLinkIcon class="size-3.5 opacity-70" />
        </Button>
      </div>

      <template v-else>
        <!-- master toggle -->
        <div class="flex items-center justify-between gap-3 px-3.5 py-2.5">
          <span class="text-[13px] text-foreground">{{ t('cloudSync.enableLabel') }}</span>
          <Loader2Icon v-if="store.syncLoading" class="size-3.5 animate-spin text-muted-foreground" />
          <Switch
            v-else
            :model-value="store.syncStatus.ok && store.syncStatus.enabled"
            :aria-label="t('cloudSync.enableLabel')"
            @update:model-value="(v) => onToggle(!!v)"
          />
        </div>

        <!-- connecting / loading -->
        <div v-if="store.syncLoading && !(store.syncStatus.ok && store.syncStatus.enabled)" class="flex items-center gap-2 px-3.5 py-3 text-[12.5px] text-muted-foreground">
          <Loader2Icon class="size-3.5 animate-spin" />
          {{ t('cloudSync.connecting') }}
        </div>

        <!-- enabled + connected: signed-in identity, last-synced, sync now, disconnect -->
        <div v-else-if="store.syncStatus.ok && store.syncStatus.enabled && store.syncStatus.connected" class="flex flex-col gap-2.5 px-3.5 py-3">
          <div class="flex items-center justify-between gap-3">
            <img v-if="store.syncStatus.ok && store.syncStatus.picture" :src="store.syncStatus.picture" alt="" class="size-6 rounded-full object-cover shrink-0" />
            <span class="flex min-w-0 flex-col gap-0.5">
              <span class="truncate text-[12.5px] text-foreground/90">{{ t('cloudSync.signedInAs', { name: store.syncStatus.name || store.syncStatus.email }) }}</span>
              <span class="flex items-center gap-1 text-[12px] text-success">
                <CheckIcon class="size-3 shrink-0" />
                {{ syncedAgo ? t('cloudSync.syncedAgo', { time: syncedAgo }) : t('cloudSync.neverSynced') }}
              </span>
            </span>
            <Button variant="outline" size="sm" class="shrink-0" :disabled="store.syncActionBusy" @click="syncNow">
              <Loader2Icon v-if="store.syncActionBusy" class="size-3.5 animate-spin" />
              <RefreshCwIcon v-else class="size-3.5" />
              {{ t('cloudSync.syncNow') }}
            </Button>
          </div>
          <Button
            :variant="confirmDisconnect ? 'destructive' : 'ghost'"
            size="sm"
            class="self-start"
            @click="disconnect"
            @blur="confirmDisconnect = false"
          >
            <LogOutIcon class="size-3.5" />
            {{ confirmDisconnect ? t('cloudSync.disconnectConfirm') : t('cloudSync.disconnect') }}
          </Button>
        </div>

        <!-- inline, non-blocking error -->
        <p v-if="syncError" class="px-3.5 pb-3 text-[11.5px] text-destructive">
          {{ syncError.error }}
          <template v-if="syncError.retryAfterSeconds">
, {{ t('cloudSync.retryHint', { seconds: syncError.retryAfterSeconds }) }}
          </template>
        </p>
      </template>
    </SettingsGroup>
  </div>
</template>
