import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import ModelRow from '@/components/app/control/ModelRow.vue';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useControlStore } from '@/stores/control';

describe('ModelRow', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('allows an already-selected unavailable model to be deselected', async () => {
    const store = useControlStore();
    store.selModels = ['retired'];
    const wrapper = mount(defineComponent({
      components: { ModelRow, TooltipProvider },
      template: '<TooltipProvider><ModelRow :model="model" /></TooltipProvider>',
      setup: () => ({ model: { id: 'retired', label: 'Retired', vision: false, enabled: false, keys: 0 } }),
    }));

    await wrapper.get('[role="button"]').trigger('click');

    expect(store.selModels).toEqual([]);
    wrapper.unmount();
  });
});
