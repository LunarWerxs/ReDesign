<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useViewerStore } from '@/stores/viewer';
import OutputGrid from '@/components/app/viewer/OutputGrid.vue';
import RunGallery from '@/components/app/viewer/RunGallery.vue';

const store = useViewerStore();
const route = useRoute();

function routeRunId(): string | null {
  const q = route.query.run;
  return typeof q === 'string' && q ? q : null;
}

// No ?run= means "show me my runs", not "reopen whatever was newest". The gallery is the
// landing surface; opening a run is an explicit click (or a ?run= the app itself navigated to
// after a generation). See components/app/viewer/RunGallery.vue.
const showGallery = computed(() => !store.runId);

// Reconcile the viewer to THIS visit's route synchronously, in setup, before the first paint.
// The viewer store keeps runId across navigations, so returning to /viewer with no ?run= would
// otherwise render the previously-open run's stale grid for a frame before the gallery appears.
// store.load() sets runId (and clears the manifest for a null id) synchronously at its top.
if (routeRunId() !== store.runId) store.load(routeRunId());

onMounted(() => {
  void store.loadRuns();
});

watch(
  () => route.query.run,
  () => {
    // Reload when the run query changes, including to nothing (back-nav to
    // /viewer with no ?run), which clears the manifest and stops polling.
    const id = routeRunId();
    if (id !== store.runId) store.load(id);
  },
);

onUnmounted(() => store.stopPoll());
</script>

<template>
  <div>
    <RunGallery v-if="showGallery" />
    <OutputGrid v-else />
  </div>
</template>
