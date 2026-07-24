<script setup lang="ts">
// Cloud sync has no on/off toggle (2026-07-21): being signed in IS the on state, Disconnect is
// the off state. Two states only —
//   · signed out → one row, "Sync settings" with the sign-in button in line with the label.
//   · signed in  → who you're signed in as, when it last synced, Sync now, Disconnect.
// (loadSyncStatus in stores/control/sync.ts enables sync on the daemon as soon as it sees a
// connected account, so there is nothing left for the owner to switch on afterwards.)
import { computed, onMounted, ref } from 'vue';
import { toast } from 'vue-sonner';
import { CloudIcon, CheckIcon, ExternalLinkIcon, Loader2Icon, RefreshCwIcon, LogOutIcon } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import SettingsGroup from '@/shell/SettingsGroup.vue';
import SettingsRow from '@/shell/SettingsRow.vue';
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

// Narrowed once here rather than re-testing `.ok` at every template site (SyncStatus is a
// union, and a template-side `status?.ok && status.name` doesn't narrow for vue-tsc).
const account = computed(() => (store.syncStatus?.ok ? store.syncStatus : null));
/** Signed in and syncing: the only state that shows the identity block. */
const connected = computed(() => !!account.value?.connected);

const syncedAgo = computed(() => {
  const last = account.value?.lastSyncedAt;
  return last ? formatAgo(now.value, new Date(last).getTime(), t) : null;
});

const syncError = computed(() => (store.syncStatus && !store.syncStatus.ok ? store.syncStatus : null));

onMounted(() => {
  now.value = Date.now();
});
</script>

<template>
  <SettingsGroup :label="t('cloudSync.label')" :description="t('cloudSync.privacyNote')">
    <!-- signed out (or still loading the status) → sign in, and syncing starts -->
    <SettingsRow v-if="!connected" :label="t('cloudSync.title')">
      <template #icon>
        <CloudIcon class="size-[18px] shrink-0 text-sky-500" />
      </template>
      <template #info>
        <InfoHint :text="t('cloudSync.enableHint')" />
      </template>
      <template #control>
        <Loader2Icon v-if="store.syncLoading" class="size-3.5 animate-spin text-muted-foreground" />
        <Button v-else size="sm" @click="signIn">
          {{ t('cloudSync.signIn') }}
          <ExternalLinkIcon class="size-3.5 opacity-70" />
        </Button>
      </template>
    </SettingsRow>

    <!-- signed in → identity, freshness, and the two actions -->
    <template v-else>
      <SettingsRow>
        <template #icon>
          <img
            v-if="account?.picture"
            :src="account.picture"
            alt=""
            class="size-[18px] shrink-0 rounded-full object-cover"
          />
          <CloudIcon v-else class="size-[18px] shrink-0 text-sky-500" />
        </template>
        <template #label>
          <span class="truncate">
            {{ t('cloudSync.signedInAs', { name: account?.name || account?.email || '' }) }}
          </span>
        </template>
        <template #description>
          <span class="flex items-center gap-1 text-success">
            <CheckIcon class="size-3 shrink-0" />
            {{ syncedAgo ? t('cloudSync.syncedAgo', { time: syncedAgo }) : t('cloudSync.neverSynced') }}
          </span>
        </template>
        <template #control>
          <Button variant="outline" size="sm" :disabled="store.syncActionBusy" @click="syncNow">
            <Loader2Icon v-if="store.syncActionBusy" class="size-3.5 animate-spin" />
            <RefreshCwIcon v-else class="size-3.5" />
            {{ t('cloudSync.syncNow') }}
          </Button>
        </template>
      </SettingsRow>

      <SettingsRow :label="t('cloudSync.disconnectLabel')">
        <template #control>
          <Button
            :variant="confirmDisconnect ? 'destructive' : 'ghost'"
            size="sm"
            :disabled="store.syncLoading"
            @click="disconnect"
            @blur="confirmDisconnect = false"
          >
            <Loader2Icon v-if="store.syncLoading" class="size-3.5 animate-spin" />
            <LogOutIcon v-else class="size-3.5" />
            {{ confirmDisconnect ? t('cloudSync.disconnectConfirm') : t('cloudSync.disconnect') }}
          </Button>
        </template>
      </SettingsRow>
    </template>

    <!-- inline, non-blocking error -->
    <p v-if="syncError" class="px-3.5 py-2 text-[11.5px] text-destructive">
      {{ syncError.error }}
      <template v-if="syncError.retryAfterSeconds">
        , {{ t('cloudSync.retryHint', { seconds: syncError.retryAfterSeconds }) }}
      </template>
    </p>
  </SettingsGroup>
</template>
