import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ApiError } from '@/lib/httpClient';
import ModelIdCombobox from '@/components/app/control/key-health-sheet/ModelIdCombobox.vue';

const { availableModels } = vi.hoisted(() => ({ availableModels: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return { ...original, api: { ...original.api, availableModels } };
});

function mountPicker() {
  return mount(ModelIdCombobox, {
    props: {
      provider: 'openai-compatible',
      baseUrl: 'https://custom.example/v1',
      keyEnv: 'CUSTOM_API_KEYS',
      modelValue: '',
    },
    global: {
      stubs: {
        Popover: {
          props: ['open'],
          emits: ['update:open'],
          template: '<div><button data-open-picker @click="$emit(\'update:open\', true)" /><slot /></div>',
        },
        PopoverTrigger: { template: '<div><slot /></div>' },
        PopoverContent: { template: '<div><slot /></div>' },
        Command: { template: '<div><slot /></div>' },
        CommandInput: { template: '<input />' },
        CommandList: { template: '<div><slot /></div>' },
        CommandEmpty: { template: '<div><slot /></div>' },
        CommandGroup: { template: '<div><slot /></div>' },
        CommandItem: { template: '<button><slot /></button>' },
      },
    },
  });
}

describe('ModelIdCombobox', () => {
  afterEach(() => vi.clearAllMocks());

  it('explains a rejected draft binding while keeping free-text model entry available', async () => {
    availableModels.mockRejectedValueOnce(
      new ApiError(400, 'Catalog credentials must match a saved model', { code: 'catalog_binding_required' }),
    );
    const wrapper = mountPicker();

    await wrapper.find('[data-open-picker]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain(
      'For a new or changed custom provider, enter its model ID and save the model before browsing its available models.',
    );
    await wrapper.find('input').setValue('custom-vision-v1');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['custom-vision-v1']);
  });

  it('continues to show provider options for an allowed binding', async () => {
    availableModels.mockResolvedValueOnce({
      source: 'provider',
      models: [{ id: 'custom-vision-v1', label: 'Custom Vision', source: 'provider' }],
    });
    const wrapper = mountPicker();

    await wrapper.find('[data-open-picker]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Custom Vision');
  });
});
