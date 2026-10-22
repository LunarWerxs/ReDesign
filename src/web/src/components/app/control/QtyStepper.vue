<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { MinusIcon, PlusIcon } from '@lucide/vue';
import { t } from '@/i18n';

// A compact integer stepper: [−] [ value ] [+] — minus on the left, plus on the
// right, with the value still editable in the middle box. Clamps to [min, max].
const props = withDefaults(
  defineProps<{
    modelValue: number;
    min?: number;
    max?: number;
    step?: number;
    ariaLabel?: string;
    title?: string;
  }>(),
  { min: 1, max: 10, step: 1 },
);
const emit = defineEmits<{ 'update:modelValue': [value: number] }>();

const clamp = (n: number) => Math.min(props.max, Math.max(props.min, Math.round(n)));
const value = computed(() => {
  const n = Number(props.modelValue);
  return Number.isFinite(n) ? clamp(n) : props.min;
});
const canDec = computed(() => value.value > props.min);
const canInc = computed(() => value.value < props.max);

// A free-form draft so mid-edit typing isn't fought by the clamped bound value;
// it's reconciled on blur / Enter.
const draft = ref(String(value.value));
watch(value, (v) => {
  draft.value = String(v);
});

function set(n: number) {
  emit('update:modelValue', clamp(n));
}
function dec() {
  if (canDec.value) set(value.value - props.step);
}
function inc() {
  if (canInc.value) set(value.value + props.step);
}
function commit() {
  const n = Number(draft.value);
  set(Number.isFinite(n) && draft.value.trim() !== '' ? n : props.min);
  draft.value = String(value.value);
}
</script>

<template>
  <div
    class="inline-flex h-7 select-none items-stretch overflow-hidden rounded-md border border-input bg-input/20 dark:bg-input/30"
    @click.stop
    @keydown.stop
  >
    <button
      type="button"
      class="grid w-6 place-items-center text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-40"
      :disabled="!canDec"
      :aria-label="t('stepper.decrease')"
      @click="dec"
    >
      <MinusIcon class="size-3" />
    </button>
    <input
      v-model="draft"
      type="text"
      inputmode="numeric"
      class="w-8 border-x border-input bg-transparent text-center text-sm tabular-nums outline-none"
      :aria-label="ariaLabel"
      :title="title"
      @keydown.enter="commit"
      @blur="commit"
    />
    <button
      type="button"
      class="grid w-6 place-items-center text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-40"
      :disabled="!canInc"
      :aria-label="t('stepper.increase')"
      @click="inc"
    >
      <PlusIcon class="size-3" />
    </button>
  </div>
</template>
