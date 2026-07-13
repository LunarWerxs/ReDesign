<script setup lang="ts">
import { ref, watch } from 'vue';
import { Loader2Icon, SparklesIcon } from '@lucide/vue';
import { toast } from 'vue-sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useControlStore } from '@/stores/control';
import { errMessage } from '@/stores/control/state';
import { t } from '@/i18n';
import type { ImportKeyResult } from '@/types';

const open = defineModel<boolean>('open', { default: false });
const store = useControlStore();

const text = ref('');
const importing = ref(false);
const results = ref<ImportKeyResult[]>([]);

// Fresh start each time the dialog opens.
watch(open, (o) => {
  if (o) {
    text.value = '';
    results.value = [];
  }
});

const STATUS_META: Record<ImportKeyResult['status'], { label: string; cls: string }> = {
  added: { label: 'keyImport.statusAdded', cls: 'bg-success/15 text-success' },
  duplicate: { label: 'keyImport.statusDuplicate', cls: 'bg-muted text-muted-foreground' },
  unknown: { label: 'keyImport.statusUnknown', cls: 'bg-warning/15 text-warning' },
  no_service: { label: 'keyImport.statusNoService', cls: 'bg-warning/15 text-warning' },
};

async function runImport() {
  if (!text.value.trim() || importing.value) return;
  importing.value = true;
  try {
    const r = await store.importKeys(text.value);
    results.value = r.results;
    if (r.added > 0) toast.success(t('keyImport.addedSummary', { count: r.added }, r.added));
    else toast(t('keyImport.nothingAdded'));
    text.value = '';
  } catch (e) {
    toast.error(t('keys.importFailed'), { description: errMessage(e) });
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <SparklesIcon class="size-4 text-primary" />
          {{ t('keyImport.title') }}
        </DialogTitle>
        <DialogDescription>{{ t('keyImport.description') }}</DialogDescription>
      </DialogHeader>

      <Textarea
        v-model="text"
        :placeholder="t('keyImport.placeholder')"
        rows="5"
        class="font-mono text-xs"
        spellcheck="false"
        autocomplete="off"
        @keydown.meta.enter="runImport"
        @keydown.ctrl.enter="runImport"
      />

      <div v-if="results.length" class="grid max-h-56 gap-1 overflow-y-auto rounded-md border bg-muted/20 p-2">
        <div class="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {{ t('keyImport.resultsTitle') }}
        </div>
        <div
          v-for="(r, i) in results"
          :key="i"
          class="flex items-center gap-2 rounded px-1 py-1 text-xs"
        >
          <span class="font-mono text-muted-foreground">{{ r.mask }}</span>
          <span v-if="r.label" class="font-medium">{{ r.label }}</span>
          <span v-if="r.probed" class="text-[10px] text-muted-foreground/70">· {{ t('keyImport.verified') }}</span>
          <span class="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium" :class="STATUS_META[r.status].cls">
            {{ t(STATUS_META[r.status].label) }}
          </span>
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="open = false">{{ t('keyImport.done') }}</Button>
        <Button :disabled="!text.trim() || importing" @click="runImport">
          <Loader2Icon v-if="importing" class="size-4 animate-spin" />
          {{ importing ? t('keyImport.detecting') : t('keyImport.detectAdd') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
