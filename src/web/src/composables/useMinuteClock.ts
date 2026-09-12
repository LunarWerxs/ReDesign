import { onMounted, onUnmounted, readonly, ref } from 'vue';

const now = ref(Date.now());
let consumers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  now.value = Date.now();
}

function stopTimer(): void {
  if (timer != null) clearInterval(timer);
  timer = null;
}

function startTimer(): void {
  if (timer != null || (typeof document !== 'undefined' && document.hidden)) return;
  tick();
  timer = setInterval(tick, 60_000);
}

function onVisibilityChange(): void {
  if (typeof document !== 'undefined' && document.hidden) stopTimer();
  else if (consumers > 0) startTimer();
}

/** One minute-resolution clock shared by visible relative-time surfaces. */
export function useMinuteClock() {
  onMounted(() => {
    consumers += 1;
    if (consumers === 1 && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    startTimer();
  });

  onUnmounted(() => {
    consumers = Math.max(0, consumers - 1);
    if (consumers === 0) {
      stopTimer();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    }
  });

  return readonly(now);
}
