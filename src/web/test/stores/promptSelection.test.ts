import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { createControlState } from '@/stores/control/state';
import { createSelectionContentActions } from '@/stores/control/selection-content';
import type { PromptBuilderOption } from '@/types';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('prompt builder option library', () => {
  const option: PromptBuilderOption = {
    id: 'custom-dense-data',
    label: 'Dense data',
    instruction: 'Use an information-dense, highly scannable layout.',
    category: 'structure',
  };

  it('adopts the server snapshot after creating or editing an option', async () => {
    vi.spyOn(api, 'savePromptBuilderOption').mockResolvedValue({
      builderOption: option,
      builderOptions: [option],
    });
    const state = createControlState();
    const actions = createSelectionContentActions(state);

    const saved = await actions.savePromptBuilderOption({
      label: option.label,
      instruction: option.instruction,
      category: option.category,
    });

    expect(saved).toEqual(option);
    expect(state.builderOptions.value).toEqual([option]);
  });

  it('removes an option from local state only after the server confirms deletion', async () => {
    vi.spyOn(api, 'deletePromptBuilderOption').mockResolvedValue({
      id: option.id,
      builderOptions: [],
    });
    const state = createControlState();
    state.builderOptions.value = [option];
    const actions = createSelectionContentActions(state);

    expect(await actions.deletePromptBuilderOption(option.id)).toBe(true);
    expect(state.builderOptions.value).toEqual([]);
  });
});

describe('prompt picker visibility', () => {
  it('keeps legacy builder-only prompts out of Select all', () => {
    const state = createControlState();
    state.prompts.value = [
      {
        id: 'material-3',
        label: 'Material 3',
        user: 'legacy alias',
        pickerHidden: true,
      },
      {
        id: 'faithful',
        label: 'Faithful',
        user: 'keep the structure',
      },
    ];
    const actions = createSelectionContentActions(state);

    actions.selectAll('prompts');

    expect(state.selPrompts.value).toEqual(['faithful']);
  });
});
