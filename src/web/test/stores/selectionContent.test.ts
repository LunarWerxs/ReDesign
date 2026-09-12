import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createControlState } from '@/stores/control/state';
import { createSelectionContentActions } from '@/stores/control/selection-content';
import { createRunAgainActions } from '@/stores/control/run-again';
import type { Manifest, Model } from '@/types';

const { api } = vi.hoisted(() => ({ api: {
  uploadLimits: vi.fn(),
  uploadInputs: vi.fn(),
  uploadReferences: vi.fn(),
} }));

vi.mock('@/lib/api', () => ({
  api,
  ApiError: class ApiError extends Error {
    constructor(readonly status: number, message = '') { super(message); }
  },
}));
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const image = (name: string) => new File([new Uint8Array([1])], name, { type: 'image/png' });
const item = (id: string) => ({ id, name: `${id}.png`, type: 'image', preview: id });
const model = (over: Partial<Model> = {}): Model => ({
  id: 'model', label: 'Model', vision: false, enabled: true, keys: 1, ...over,
});

describe('selection upload reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.uploadLimits.mockResolvedValue({ bodyLimitBytes: 40 * 1024 * 1024, imageLimitBytes: 20 * 1024 * 1024 });
  });

  it('serializes screenshot uploads so a late older catalog cannot replace the newest selection', async () => {
    const state = createControlState();
    const actions = createSelectionContentActions(state);
    let finishFirst!: (value: unknown) => void;
    api.uploadInputs
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ inputs: [item('a'), item('b')], addedIds: ['b'], saved: [{}] });

    const first = actions.uploadFiles([image('a.png')]);
    const second = actions.uploadFiles([image('b.png')]);
    await vi.waitFor(() => expect(api.uploadInputs).toHaveBeenCalledTimes(1));
    finishFirst({ inputs: [item('a')], addedIds: ['a'], saved: [{}] });
    await Promise.all([first, second]);

    expect(state.inputs.value.map((input) => input.id)).toEqual(['a', 'b']);
    expect(state.selInputs.value).toEqual(['b']);
  });

  it('serializes reference uploads and retains an existing selection with the newest batch', async () => {
    const state = createControlState();
    state.selReference.value = ['kept'];
    const actions = createSelectionContentActions(state);
    let finishFirst!: (value: unknown) => void;
    api.uploadReferences
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ references: [item('kept'), item('a'), item('b')], addedIds: ['b'], saved: [{}] });

    const first = actions.uploadReferences([image('a.png')]);
    const second = actions.uploadReferences([image('b.png')]);
    await vi.waitFor(() => expect(api.uploadReferences).toHaveBeenCalledTimes(1));
    finishFirst({ references: [item('kept'), item('a')], addedIds: ['a'], saved: [{}] });
    await Promise.all([first, second]);

    expect(state.references.value.map((reference) => reference.id)).toEqual(['kept', 'a', 'b']);
    expect(state.selReference.value).toEqual(['kept', 'a', 'b']);
  });
});

describe('Run again model reconciliation', () => {
  it('drops disabled and keyless historical models along with their quantities', () => {
    const state = createControlState();
    state.models.value = [model({ id: 'ready' }), model({ id: 'disabled', enabled: false }), model({ id: 'empty', keys: 0 })];
    const actions = createRunAgainActions(state);
    const manifest = {
      runId: 'run', status: 'done', inputs: [], prompts: [], models: [], jobs: [],
      config: { inputIds: [], modelIds: ['ready', 'disabled', 'empty'], promptIds: [], variantsByModel: { ready: 2, disabled: 3, empty: 4 } },
    } as Manifest;

    actions.stageRunAgain(manifest);
    actions.applyPendingRunAgain();

    expect(state.selModels.value).toEqual(['ready']);
    expect(state.modelQty.value).toEqual({ ready: 2 });
  });

  it('keeps a saved custom-named preset while removing only the manifest synthetic custom prompt', () => {
    const state = createControlState();
    state.prompts.value = [{ id: 'custom', label: 'Saved Custom', user: 'saved' }];
    const actions = createRunAgainActions(state);
    const manifest = {
      runId: 'run', status: 'done', inputs: [], models: [], jobs: [],
      prompts: [
        { id: 'custom', label: 'Saved Custom', user: 'saved', source: 'preset' },
        { id: 'custom-2', label: 'Custom', user: 'one-off', source: 'custom' },
      ],
      config: { inputIds: [], modelIds: [], promptIds: ['custom', 'custom-2'], maxCostUsd: 1.25 },
    } as Manifest;

    actions.stageRunAgain(manifest);
    actions.applyPendingRunAgain();

    expect(state.selPrompts.value).toEqual(['custom']);
    expect(state.custom.value).toBe('one-off');
    expect(state.maxCostUsd.value).toBe('1.25');
  });
});
