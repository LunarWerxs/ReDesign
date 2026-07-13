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
  <!-- single column: an active run renders BELOW the controls at full width instead of
       claiming a 380px side column and squishing the page (and the header above it) -->
  <div class="grid gap-5 py-6">
    <main class="grid min-w-0 content-start gap-[18px]">
      <InputGrid />
      <OptionsCard />
    </main>
    <section v-if="store.runId" class="grid min-w-0 content-start gap-[18px]">
      <ProgressCard />
    </section>
  </div>
</template>
