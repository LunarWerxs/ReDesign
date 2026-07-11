<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ImageIcon, LayoutDashboardIcon } from '@lucide/vue';
import { RouterLink, useRoute, type RouteLocationRaw } from 'vue-router';
import { t } from '@/i18n';

const props = withDefaults(
  defineProps<{
    viewerTo?: RouteLocationRaw;
    /** Draw the divider line under the header. */
    bordered?: boolean;
    /** Constrain the header row to the page content width instead of full-bleed. */
    contained?: boolean;
    /** Mirror the dashboard's optional right-side progress column. */
    sidebar?: boolean;
  }>(),
  {
    viewerTo: () => ({ path: '/viewer' }),
    bordered: true,
    contained: false,
    sidebar: false,
  },
);

const navItemClass =
  'relative z-10 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const activeNavClass = 'text-foreground';
const inactiveNavClass = 'text-muted-foreground hover:bg-background/70 hover:text-foreground';

// Sliding active-segment indicator, same visual language as the kit's SettingsTabs:
// an absolutely positioned div measured against the active link's offsetLeft/offsetWidth
// so the Dashboard <-> Viewer switch animates instead of jump-cutting the background.
const route = useRoute();
const dashboardLinkEl = ref<HTMLElement | null>(null);
const viewerLinkEl = ref<HTMLElement | null>(null);
const indicatorStyle = ref<{ transform: string; width: string }>({ transform: 'translateX(0px)', width: '0px' });
const indicatorReady = ref(false);

function measure() {
  const active = route.path === '/viewer' ? viewerLinkEl.value : dashboardLinkEl.value;
  if (!active) return;
  indicatorStyle.value = { transform: `translateX(${active.offsetLeft}px)`, width: `${active.offsetWidth}px` };
  indicatorReady.value = true;
}

watch(() => route.path, () => void nextTick(measure), { immediate: true });

onMounted(() => {
  void nextTick(measure);
  window.addEventListener('resize', measure);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', measure);
});
</script>

<template>
  <header
    class="sticky top-0 z-40 bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75"
    :class="props.bordered ? 'border-b' : ''"
  >
    <div
      :class="
        props.contained
          ? [
              'mx-auto h-[58px] w-full max-w-(--container-max) px-6',
              props.sidebar ? 'grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_380px]' : '',
            ]
          : 'px-[18px]'
      "
    >
      <div class="flex h-[58px] min-w-0 items-center gap-3">
        <RouterLink
          to="/"
          class="inline-flex shrink-0 items-center gap-2 text-base font-extrabold"
          :aria-label="t('topbar.reimagineControl')"
        >
          <img src="/icon.svg" alt="" aria-hidden="true" width="24" height="24" class="size-6 shrink-0" />
          <span><!-- i18n-ignore -->R<span class="text-primary"><!-- i18n-ignore -->ē</span><!-- i18n-ignore -->Design</span>
        </RouterLink>

        <nav class="relative flex shrink-0 items-center rounded-lg border bg-muted/40 p-0.5" :aria-label="t('topbar.workspace')">
          <div
            v-if="indicatorReady"
            class="pointer-events-none absolute inset-y-0.5 left-0.5 rounded-md bg-background shadow-xs transition-[transform,width] duration-200 ease-out"
            :style="indicatorStyle"
            aria-hidden="true"
          />
          <RouterLink v-slot="{ href, navigate, isActive }" to="/" custom>
            <a
              ref="dashboardLinkEl"
              :href="href"
              :class="[navItemClass, isActive ? activeNavClass : inactiveNavClass]"
              :aria-label="t('topbar.dashboard')"
              :title="t('topbar.dashboard')"
              @click="navigate"
            >
              <LayoutDashboardIcon class="size-3.5" />
              <span class="hidden md:inline">{{ t('topbar.dashboard') }}</span>
            </a>
          </RouterLink>
          <RouterLink v-slot="{ href, navigate, isActive }" :to="props.viewerTo" custom>
            <a
              ref="viewerLinkEl"
              :href="href"
              :class="[navItemClass, isActive ? activeNavClass : inactiveNavClass]"
              :aria-label="t('topbar.viewer')"
              :title="t('topbar.viewer')"
              @click="navigate"
            >
              <ImageIcon class="size-3.5" />
              <span class="hidden md:inline">{{ t('topbar.viewer') }}</span>
            </a>
          </RouterLink>
        </nav>

        <div class="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <slot name="status" />
        </div>

        <div class="flex shrink-0 items-center justify-end gap-1.5">
          <slot name="actions" />
        </div>
      </div>
    </div>
  </header>
</template>
