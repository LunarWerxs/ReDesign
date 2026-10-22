<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { t } from '@/i18n';
</script>

<template>
  <main class="grid min-h-[calc(100dvh-58px)] place-items-center p-8 text-center">
    <div>
      <h1 class="text-2xl font-bold">{{ t('notFound.title') }}</h1>
      <p class="text-muted-foreground mt-2">
        <RouterLink to="/" class="underline">{{ t('notFound.backToControl') }}</RouterLink>
      </p>
    </div>
  </main>
</template>
