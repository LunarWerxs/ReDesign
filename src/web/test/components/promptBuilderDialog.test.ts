import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PromptBuilderDialog from '@/components/app/control/PromptBuilderDialog.vue';
import { useControlStore } from '@/stores/control';
import type { Prompt, PromptBuilderOption, PromptBuilderRecipe } from '@/types';

const customOption: PromptBuilderOption = {
  id: 'dense-data',
  label: 'Dense data',
  description: 'Keep complex information easy to scan.',
  instruction: 'Use a compact, information-dense layout with strong scan paths.',
  category: 'structure',
};

const mountedWrappers: VueWrapper[] = [];

function mountBuilder(prompt: Prompt | null = null) {
  const wrapper = mount(PromptBuilderDialog, {
    props: { open: true, prompt },
    attachTo: document.body,
  });
  mountedWrappers.push(wrapper);
  return wrapper;
}

function bodyWrapper() {
  return new DOMWrapper(document.body);
}

function buttonWithText(wrapper: DOMWrapper<Element>, text: string) {
  const button = wrapper.findAll('button').find((candidate) => candidate.text().includes(text));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

describe('PromptBuilderDialog custom options', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    setActivePinia(createPinia());
  });

  afterEach(() => {
    for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount();
  });

  it('selects a reusable custom option and compiles it into the one applied prompt', async () => {
    const store = useControlStore();
    store.builderOptions = [customOption];
    store.builderOptionsLoaded = true;
    store.selPrompts = ['minimalist'];
    mountBuilder();
    await flushPromises();
    const wrapper = bodyWrapper();

    const card = wrapper.get('[data-builder-option="dense-data"]');
    await card.get('button[aria-pressed]').trigger('click');
    await buttonWithText(wrapper, 'Use once').trigger('click');

    expect(store.selPrompts).toEqual([]);
    expect(store.customOn).toBe(true);
    expect(store.custom).toContain(customOption.instruction);
    expect(store.custom.match(/COMBINED DESIGN QUALITIES/g)).toHaveLength(1);
  });

  it('creates a reusable option in context and selects its returned snapshot', async () => {
    const store = useControlStore();
    store.builderOptionsLoaded = true;
    const save = vi
      .spyOn(store, 'savePromptBuilderOption')
      .mockResolvedValue(customOption);
    mountBuilder();
    await flushPromises();
    const wrapper = bodyWrapper();

    await wrapper.get('[data-create-builder-option]').trigger('click');
    await wrapper.get('#prompt-builder-option-name').setValue('Dense data');
    await wrapper
      .get('#prompt-builder-option-description')
      .setValue('Keep complex information easy to scan.');
    await wrapper
      .get('#prompt-builder-option-instruction')
      .setValue(customOption.instruction);
    await wrapper.get('form[aria-busy]').trigger('submit');
    await flushPromises();

    expect(save).toHaveBeenCalledWith({
      label: 'Dense data',
      description: 'Keep complex information easy to scan.',
      instruction: customOption.instruction,
      category: 'structure',
    });

    await buttonWithText(wrapper, 'Use once').trigger('click');
    expect(store.custom).toContain(customOption.instruction);
  });

  it('shows and compiles a bookmark snapshot when its reusable option has changed', async () => {
    const store = useControlStore();
    store.builderOptionsLoaded = true;
    store.builderOptions = [
      {
        ...customOption,
        label: 'Dense data — revised',
        instruction: 'Use the latest revised density instruction.',
      },
    ];
    const bookmark: Prompt = {
      id: 'saved-density',
      label: 'Saved density',
      user: 'previously compiled',
      builder: {
        version: 1,
        scope: 'balanced',
        modifiers: [],
        customOptions: [customOption],
      },
    };

    mountBuilder(bookmark);
    await flushPromises();
    const wrapper = bodyWrapper();

    expect(wrapper.text()).toContain('Dense data');
    expect(wrapper.text()).not.toContain('Dense data — revised');
    expect(wrapper.text()).toContain('Saved copy');

    await buttonWithText(wrapper, 'Use once').trigger('click');
    expect(store.custom).toContain(customOption.instruction);
    expect(store.custom).not.toContain('latest revised density instruction');
  });

  it('does not overwrite the independent new-combination draft when inspecting a bookmark', async () => {
    const draft: PromptBuilderRecipe = {
      version: 1,
      scope: 'faithful',
      modifiers: ['progressive-disclosure'],
    };
    localStorage.setItem('redesign.prompt-builder-v1', JSON.stringify(draft));
    const bookmark: Prompt = {
      id: 'saved-density',
      label: 'Saved density',
      user: 'previously compiled',
      builder: {
        version: 1,
        scope: 'reimagine',
        modifiers: ['material-3'],
      },
    };

    mountBuilder(bookmark);
    await flushPromises();
    const wrapper = bodyWrapper();
    await buttonWithText(wrapper, 'Minimal visual language').trigger('click');
    await flushPromises();

    expect(JSON.parse(localStorage.getItem('redesign.prompt-builder-v1') || 'null')).toEqual(
      draft,
    );
  });
});
