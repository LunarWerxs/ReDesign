import { describe, expect, it } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';
import ReferenceCard from '@/components/app/viewer/ReferenceCard.vue';
import { TooltipProvider } from '@/components/ui/tooltip';

function mountCard(specVersion?: number) {
  return mount(defineComponent({
    components: { ReferenceCard, TooltipProvider },
    template: '<TooltipProvider><ReferenceCard :input="input" :run-id="\'run-1\'" :spec-version="specVersion" /></TooltipProvider>',
    setup: () => ({ specVersion, input: { id: 'input', name: 'Original', type: 'image' as const, preview: 'assets/inputs/shot.png' } }),
  }));
}

describe('ReferenceCard durable asset URLs', () => {
  it('reads snapshot assets from the owning run output', () => {
    const wrapper = mountCard(1);
    expect(wrapper.get('img').attributes('src')).toBe('/output-raw/run-1/assets/inputs/shot.png');
    expect(wrapper.get('a').attributes('href')).toBe('/output-raw/run-1/assets/inputs/shot.png');
  });

  it('keeps legacy manifests on the scratch input route', () => {
    const wrapper = mountCard();
    expect(wrapper.get('img').attributes('src')).toBe('/input/assets/inputs/shot.png');
  });
});
