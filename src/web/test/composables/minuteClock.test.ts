import { describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { useMinuteClock } from '@/composables/useMinuteClock';

describe('useMinuteClock', () => {
  it('ticks once a minute only while a visible consumer is mounted', async () => {
    vi.useFakeTimers();
    const component = defineComponent({ setup: () => ({ now: useMinuteClock() }), template: '<span>{{ now }}</span>' });
    const wrapper = mount(component);
    const first = wrapper.text();
    await vi.advanceTimersByTimeAsync(60_000);
    await nextTick();
    expect(wrapper.text()).not.toBe(first);

    wrapper.unmount();
    const calls = vi.getTimerCount();
    expect(calls).toBe(0);
    vi.useRealTimers();
  });

  it('stops its shared timer while the document is hidden', () => {
    vi.useFakeTimers();
    const hidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    const component = defineComponent({ setup: () => ({ now: useMinuteClock() }), template: '<span>{{ now }}</span>' });
    const wrapper = mount(component);

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);

    wrapper.unmount();
    if (hidden) Object.defineProperty(document, 'hidden', hidden);
    vi.useRealTimers();
  });
});
