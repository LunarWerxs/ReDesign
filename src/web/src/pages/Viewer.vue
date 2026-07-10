<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useViewerStore } from '@/stores/viewer';
import OutputGrid from '@/components/app/viewer/OutputGrid.vue';

const store = useViewerStore();
const route = useRoute();

function routeRunId(): string | null {
  const q = route.query.run;
  return typeof q === 'string' && q ? q : null;
}

onMounted(async () => {
  await store.loadRuns();
  store.load(routeRunId() || store.runs[0]?.runId || null);
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
    <OutputGrid />
  </div>
</template>
