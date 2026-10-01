<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import AppTopbar from '@/components/app/AppTopbar.vue';
import StatusPill from '@/components/app/StatusPill.vue';
import { LayoutGrid as AllRunsIcon, Settings as SettingsIcon } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import KeyHealthSheet from '@/components/app/control/KeyHealthSheet.vue';
import { useTheme } from '@/lib/theme';
import { usePushPanel } from '@/shell/usePushPanel';
import AppContainer from '@/shell/AppContainer.vue';
import AppFooter from '@/shell/AppFooter.vue';
import { useControlStore } from '@/stores/control';
import { useViewerStore } from '@/stores/viewer';
import { applyWindowSizeHint } from '@/lib/window-size-hint';
import { t } from '@/i18n';

// A portable (--app) window forwarded into an already-running Chromium instance ignores
// --window-size and the saved placement; the daemon/tray/start.cmd tag its URL with the size
// it should be and we correct it here before first paint. No-op in a browser tab or un-hinted.
applyWindowSizeHint();

// Install the reactive theme watcher once for the whole app.
useTheme();

const route = useRoute();
const controlStore = useControlStore();
const viewerStore = useViewerStore();
const settingsOpen = ref(false);
const isViewerRoute = computed(() => route.name === 'Viewer');
// The Settings sidebar pushes the page content. The shell is centered at
// --container-max (AppContainer/AppTopbar) EXCEPT on the Viewer route, whose
// OutputGrid body is full-bleed, so shellMaxWidth is disabled there.
// The shift reaches the template as --push-shift (read by pe-(--push-shift)), not a style object.
const { shiftPx } = usePushPanel(settingsOpen, {
  shellMaxWidth: () => (isViewerRoute.value ? null : 800),
});
// Only deep-link to a run this session is actually on: the one being viewed, or the one just
// generated. Falling back to "whatever run is newest on disk" is what made the Viewer tab
// reopen a stale run instead of showing the run gallery (pages/Viewer.vue).
const viewerTo = computed(() => {
  const id = viewerStore.runId || controlStore.runId;
  return id ? { path: '/viewer', query: { run: id } } : { path: '/viewer' };
});

function openSettings() {
  // Toggle: a second click on the gear closes the sidebar. The next-tick defer is kept
  // from the original open-only version (it dodged a focus/animation race on open).
  const next = !settingsOpen.value;
  setTimeout(() => {
    settingsOpen.value = next;
  }, 0);
}

async function refreshCurrentSurface() {
  if (isViewerRoute.value) {
    await viewerStore.loadRuns();
    if (viewerStore.runId) await viewerStore.refreshManifest();
    return;
  }
  await controlStore.bootstrap();
}

// Daemon-wide "update available" push (src/bus.ts) — opened once for the whole app's lifetime,
// same as the settings-sync load below, so an update is announced whether or not a run is active
// and whether or not the owner ever opens Settings. See @/stores/control/update-notify-events.
controlStore.connectUpdateEvents();

// Load the settings-sync status once for the whole app, and again after returning
// from the "Sign in with Connections" redirect (`?connected=1` on success, `?connect=failed`
// otherwise), then strip the query param so a refresh doesn't re-trigger anything.
onMounted(async () => {
  await controlStore.loadSyncStatus();
  const params = new URLSearchParams(window.location.search);
  if (params.has('connected') || params.has('connect')) {
    params.delete('connected');
    params.delete('connect');
    const query = params.toString();
    history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash);
    await controlStore.loadSyncStatus();
  }
});
</script>

<template>
  <TooltipProvider :delay-duration="120">
    <div class="push-shell min-h-dvh bg-background text-foreground pe-(--push-shift)" :style="{ '--push-shift': `${shiftPx}px` }">
      <!-- no :sidebar here; the header must never reserve the progress column and squish
           its own logo/status/settings when a run starts (progress lives below the content) -->
      <AppTopbar :viewer-to="viewerTo" :bordered="false" contained>
        <template #status>
          <StatusPill v-if="controlStore.running || controlStore.submitting" live>
            <span>{{ controlStore.runTitle || t('shell.runQueued') }} · </span>
            <span>{{ t('shell.doneCount', { done: controlStore.progress.done, total: controlStore.progress.total || controlStore.total }) }}</span>
          </StatusPill>
        </template>

        <template #actions>
          <!-- Back to the run gallery. The "Viewer" nav link deep-links to the CURRENT run, so
               without this there's no way to close a run and return to the overview but editing the
               URL. Shown only while a run is open. -->
          <Tooltip v-if="isViewerRoute && viewerStore.runId">
            <TooltipTrigger as-child>
              <Button as-child variant="ghost" size="icon" :aria-label="t('viewer.allRuns')">
                <RouterLink :to="{ path: '/viewer' }">
                  <AllRunsIcon class="size-4" />
                </RouterLink>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ t('viewer.allRuns') }}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger as-child>
              <Button variant="ghost" size="icon" :aria-label="t('shell.settings')" @click="openSettings">
                <SettingsIcon class="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ t('shell.settings') }}</TooltipContent>
          </Tooltip>
        </template>
      </AppTopbar>

      <AppContainer v-if="!isViewerRoute">
        <RouterView v-slot="{ Component, route: currentRoute }">
          <Transition name="page" mode="out-in">
            <component :is="Component" :key="currentRoute.name" />
          </Transition>
        </RouterView>
      </AppContainer>
      <RouterView v-else v-slot="{ Component, route: currentRoute }">
        <Transition name="page" mode="out-in">
          <component :is="Component" :key="currentRoute.name" />
        </Transition>
      </RouterView>

      <AppFooter discord="https://lunarwerx.com/discord/redesign" />

      <KeyHealthSheet v-model:open="settingsOpen" @refresh="refreshCurrentSurface" />
    </div>
  </TooltipProvider>
  <Toaster position="bottom-center" :duration="2600" close-button />
</template>
