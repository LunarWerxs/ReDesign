import { describe, expect, it } from 'vitest';
import { nextTick, defineComponent } from 'vue';
import { mount } from '@vue/test-utils';
import { LazyTooltip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

describe('LazyTooltip', () => {
  it('mounts the tooltip on first focus and keeps focus on the trigger', async () => {
    const wrapper = mount(defineComponent({
      components: { LazyTooltip, TooltipContent, TooltipProvider, TooltipTrigger },
      template: '<TooltipProvider><LazyTooltip><TooltipTrigger as-child><button type="button">Run</button></TooltipTrigger><TooltipContent>Run again</TooltipContent></LazyTooltip></TooltipProvider>',
    }), { attachTo: document.body });

    expect(wrapper.findComponent(Tooltip).exists()).toBe(false);

    const button = wrapper.get('button').element as HTMLButtonElement;
    button.focus();
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await nextTick();
    await nextTick();

    expect(wrapper.findComponent(Tooltip).exists()).toBe(true);
    const active = document.activeElement as HTMLElement;
    expect(active.tagName).toBe('BUTTON');
    expect(active.textContent).toBe('Run');
    expect(active.isConnected).toBe(true);

    wrapper.unmount();
  });
});
