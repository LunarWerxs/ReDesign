<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import AppTopbar from '@/components/app/AppTopbar.vue';
import StatusPill from '@/components/app/StatusPill.vue';
import { Settings as SettingsIcon } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import KeyHealthSheet from '@/components/app/control/KeyHealthSheet.vue';
import { useTheme } from '@/lib/theme';
import { usePushPanel } from '@/shell/usePushPanel';
import AppContainer from '@/shell/AppContainer.vue';
import AppFooter from '@/shell/AppFooter.vue';
import { useControlStore } from '@/stores/control';
import { useViewerStore } from '@/stores/viewer';
import { t } from '@/i18n';

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
const { containerStyle } = usePushPanel(settingsOpen, {
  shellMaxWidth: () => (isViewerRoute.value ? null : 800),
});
const viewerTo = computed(() => {
  const id = viewerStore.runId || controlStore.runId || controlStore.runs[0]?.runId || viewerStore.runs[0]?.runId;
  return id ? { path: '/viewer', query: { run: id } } : { path: '/viewer' };
});

function openSettings() {
  setTimeout(() => {
    settingsOpen.value = true;
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
    <div class="min-h-dvh bg-background text-foreground transition-[padding] duration-300 ease-in-out" :style="containerStyle">
      <AppTopbar
        :viewer-to="viewerTo"
        :bordered="false"
        contained
        :sidebar="!isViewerRoute && !!controlStore.runId"
      >
        <template #status>
          <StatusPill v-if="controlStore.running || controlStore.submitting" live>
            <span>{{ controlStore.runTitle || t('shell.runQueued') }} · </span>
            <span>{{ t('shell.doneCount', { done: controlStore.progress.done, total: controlStore.progress.total || controlStore.total }) }}</span>
          </StatusPill>
        </template>

        <template #actions>
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

      <AppFooter />

      <KeyHealthSheet v-model:open="settingsOpen" @refresh="refreshCurrentSurface" />
    </div>
  </TooltipProvider>
  <Toaster position="bottom-center" :duration="2600" close-button />
</template>
