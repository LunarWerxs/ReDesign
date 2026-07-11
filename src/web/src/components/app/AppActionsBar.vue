<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  HistoryIcon,
  KeyRoundIcon,
  MonitorIcon,
  MoonIcon,
  PowerIcon,
  RefreshCwIcon,
  SquareIcon,
  SunIcon,
} from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useControlStore } from '@/stores/control';
import { useTheme, type ThemeMode } from '@/lib/theme';
import { t } from '@/i18n';

// Refresh and API keys need parent context (route-specific refresh; the key
// sheet lives at the App root), so they're emitted. Theme / cancel / shutdown
// are self-contained. `close` lets the containing menu dismiss itself.
const emit = defineEmits<{ refresh: []; keys: []; close: []; 'recent-runs': [] }>();
const props = withDefaults(
  defineProps<{
    layout?: 'icons' | 'menu';
    showRecentRuns?: boolean;
    hideKeys?: boolean;
    hideTheme?: boolean;
    fullWidth?: boolean;
  }>(),
  {
    layout: 'icons',
    showRecentRuns: false,
    hideKeys: false,
    hideTheme: false,
    fullWidth: false,
  },
);

const controlStore = useControlStore();
const { mode, setTheme } = useTheme();

const themeOrder: ThemeMode[] = ['light', 'dark', 'system'];
const themeIcon = computed(() =>
  mode.value === 'light' ? SunIcon : mode.value === 'dark' ? MoonIcon : MonitorIcon,
);
const labelForMode = (m: ThemeMode) =>
  m === 'light' ? t('actions.themeLight') : m === 'dark' ? t('actions.themeDark') : t('actions.themeSystem');
const themeLabel = computed(() => labelForMode(mode.value));
const nextThemeLabel = computed(() => {
  const next = themeOrder[(themeOrder.indexOf(mode.value) + 1) % themeOrder.length];
  return labelForMode(next ?? 'system');
});
function cycleTheme() {
  const next = themeOrder[(themeOrder.indexOf(mode.value) + 1) % themeOrder.length];
  if (next) setTheme(next);
}
function onRefresh() {
  emit('refresh');
  emit('close');
}
function onKeys() {
  emit('keys');
  emit('close');
}
function onRecentRuns() {
  emit('close');
  emit('recent-runs');
}
function onCancel() {
  controlStore.cancelRun();
  emit('close');
}
const shutdownConfirmOpen = ref(false);
function onShutdown() {
  shutdownConfirmOpen.value = true;
}
function confirmShutdown() {
  controlStore.shutdownServer();
  emit('close');
}

const destructiveClass = 'text-destructive hover:bg-destructive/10 hover:text-destructive';
const menuItemClass =
  'flex h-9 w-full items-center gap-3 px-3.5 text-left text-[13px] font-medium outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50';
const menuIconClass = 'size-4 shrink-0 text-muted-foreground';
const menuDestructiveClass = 'text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10';
</script>

<template>
  <div
    v-if="props.layout === 'menu'"
    :class="props.fullWidth ? 'w-full py-1' : 'w-max min-w-44 max-w-[calc(100vw-24px)] py-1'"
  >
    <button type="button" :class="menuItemClass" :aria-label="t('actions.refresh')" @click="onRefresh">
      <RefreshCwIcon :class="menuIconClass" />
      <span class="min-w-0 truncate">{{ t('actions.refresh') }}</span>
    </button>

    <button
      v-if="props.showRecentRuns"
      type="button"
      :class="menuItemClass"
      :aria-label="t('actions.recentRuns')"
      @click="onRecentRuns"
    >
      <HistoryIcon :class="menuIconClass" />
      <span class="min-w-0 truncate">{{ t('actions.recentRuns') }}</span>
    </button>

    <button v-if="!props.hideKeys" type="button" :class="menuItemClass" :aria-label="t('actions.apiKeys')" @click="onKeys">
      <KeyRoundIcon :class="menuIconClass" />
      <span class="min-w-0 truncate">{{ t('actions.apiKeys') }}</span>
    </button>

    <button v-if="!props.hideTheme" type="button" :class="menuItemClass" :aria-label="t('actions.theme', { mode: themeLabel })" @click="cycleTheme">
      <component :is="themeIcon" :class="menuIconClass" />
      <span class="min-w-0 truncate">{{ t('actions.theme', { mode: themeLabel }) }}</span>
    </button>

    <div class="my-1 border-t" />

    <button
      v-if="controlStore.running"
      type="button"
      :class="[menuItemClass, menuDestructiveClass]"
      :aria-label="t('actions.cancelRun')"
      @click="onCancel"
    >
      <SquareIcon class="size-4 shrink-0" />
      <span class="min-w-0 truncate">{{ t('actions.cancelRun') }}</span>
    </button>

    <button
      type="button"
      :class="[menuItemClass, menuDestructiveClass]"
      :aria-label="t('actions.shutdown')"
      @click="onShutdown"
    >
      <PowerIcon class="size-4 shrink-0" />
      <span class="min-w-0 truncate">{{ t('actions.shutdown') }}</span>
    </button>
  </div>

  <div v-else class="flex items-center gap-0.5 p-1.5">
    <Tooltip>
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon-sm" :aria-label="t('actions.refresh')" @click="onRefresh">
          <RefreshCwIcon class="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" :side-offset="8" class="grid max-w-[220px] gap-1 px-3 py-2 text-left leading-snug shadow-lg">
        <span class="text-xs font-semibold">{{ t('actions.refresh') }}</span>
        <span class="text-[11px] text-muted-foreground">{{ t('actions.refreshDescription') }}</span>
      </TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon-sm" :aria-label="t('actions.apiKeys')" @click="onKeys">
          <KeyRoundIcon class="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" :side-offset="8" class="grid max-w-[220px] gap-1 px-3 py-2 text-left leading-snug shadow-lg">
        <span class="text-xs font-semibold">{{ t('actions.apiKeys') }}</span>
        <span class="text-[11px] text-muted-foreground">{{ t('actions.apiKeysDescription') }}</span>
      </TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger as-child>
        <Button
          variant="ghost"
          size="icon-sm"
          :aria-label="t('actions.theme', { mode: themeLabel })"
          @click="cycleTheme"
        >
          <component :is="themeIcon" class="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" :side-offset="8" class="grid max-w-[220px] gap-1 px-3 py-2 text-left leading-snug shadow-lg">
        <span class="text-xs font-semibold">{{ t('actions.theme', { mode: themeLabel }) }}</span>
        <span class="text-[11px] text-muted-foreground">{{ t('actions.themeSwitch', { mode: nextThemeLabel }) }}</span>
      </TooltipContent>
    </Tooltip>
    <span class="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />
    <Tooltip v-if="controlStore.running">
      <TooltipTrigger as-child>
        <Button
          variant="ghost"
          size="icon-sm"
          :class="destructiveClass"
          :aria-label="t('actions.cancelRun')"
          @click="onCancel"
        >
          <SquareIcon class="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" :side-offset="8" class="grid max-w-[220px] gap-1 px-3 py-2 text-left leading-snug shadow-lg">
        <span class="text-xs font-semibold">{{ t('actions.cancelRun') }}</span>
        <span class="text-[11px] text-muted-foreground">{{ t('actions.cancelRunDescription') }}</span>
      </TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger as-child>
        <Button
          variant="ghost"
          size="icon-sm"
          :class="destructiveClass"
          :aria-label="t('actions.shutdown')"
          @click="onShutdown"
        >
          <PowerIcon class="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" :side-offset="8" class="grid max-w-[220px] gap-1 px-3 py-2 text-left leading-snug shadow-lg">
        <span class="text-xs font-semibold">{{ t('actions.shutdown') }}</span>
        <span class="text-[11px] text-muted-foreground">{{ t('actions.shutdownDescription') }}</span>
      </TooltipContent>
    </Tooltip>
  </div>

  <AlertDialog v-model:open="shutdownConfirmOpen">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ t('actions.shutdownConfirmTitle') }}</AlertDialogTitle>
        <AlertDialogDescription>{{ t('actions.shutdownConfirmBody') }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
        <AlertDialogAction variant="destructive" @click="confirmShutdown">{{ t('actions.shutdownConfirm') }}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
