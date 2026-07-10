<script setup lang="ts">
import { onMounted } from 'vue';
import { useControlStore } from '@/stores/control';
import InputGrid from '@/components/app/control/InputGrid.vue';
import OptionsCard from '@/components/app/control/OptionsCard.vue';
import ProgressCard from '@/components/app/control/ProgressCard.vue';

const store = useControlStore();

onMounted(() => {
  store.bootstrap();
});
</script>

<template>
  <div
    class="grid gap-5 py-6"
    :class="store.runId ? 'lg:grid-cols-[minmax(0,1fr)_380px]' : ''"
  >
    <main class="grid min-w-0 content-start gap-[18px]">
      <InputGrid />
      <OptionsCard />
    </main>
    <aside v-if="store.runId" class="grid min-w-0 content-start gap-[18px]">
      <ProgressCard />
    </aside>
  </div>
</template>
