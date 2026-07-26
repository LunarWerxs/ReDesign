import { describe, expect, it } from 'vitest';
import {
  buildPromptFromRecipe,
  defaultPromptBuilderRecipe,
  normalizePromptBuilderRecipe,
  PROMPT_BUILDER_QUALITY_OPTIONS,
  PROMPT_BUILDER_REGISTRY,
  PROMPT_BUILDER_SCOPE_OPTIONS,
  promptBuilderModifierIds,
} from '@/lib/prompt-builder';

describe('prompt builder', () => {
  it('starts from a balanced redesign with no modifiers', () => {
    expect(defaultPromptBuilderRecipe()).toEqual({
      version: 1,
      scope: 'balanced',
      modifiers: [],
    });
  });

  it('combines Material 3 with an independent redesign direction and structure choices', () => {
    const prompt = buildPromptFromRecipe({
      version: 1,
      scope: 'faithful',
      modifiers: ['progressive-disclosure', 'material-3', 'strip-to-essentials'],
    });

    expect(prompt).toContain('Stay true to the original');
    expect(prompt).toContain('Use progressive disclosure');
    expect(prompt).toContain('Apply Material 3');
    expect(prompt).toContain('Strip the default view to its essentials');
    expect(prompt.match(/REDESIGN DIRECTION/g)).toHaveLength(1);
    expect(prompt.match(/COMBINED DESIGN QUALITIES/g)).toHaveLength(1);
  });

  it('keeps modifier order deterministic and removes duplicates and unknown values', () => {
    const recipe = normalizePromptBuilderRecipe({
      version: 1,
      scope: 'reimagine',
      modifiers: ['material-3', 'minimal', 'material-3', 'unknown'],
    });

    expect(recipe).toEqual({
      version: 1,
      scope: 'reimagine',
      modifiers: ['minimal', 'material-3'],
    });
    const prompt = buildPromptFromRecipe(recipe);
    expect(prompt.indexOf('restrained minimalist')).toBeLessThan(
      prompt.indexOf('Apply Material 3'),
    );
  });

  it('recognizes every supported modifier in a round trip', () => {
    const modifiers = promptBuilderModifierIds();
    const recipe = normalizePromptBuilderRecipe({
      version: 1,
      scope: 'balanced',
      modifiers,
    });

    expect(recipe.modifiers).toEqual(modifiers);
    expect(buildPromptFromRecipe(recipe)).not.toContain('undefined');
  });

  it('keeps all built-in metadata in one category-aware registry', () => {
    expect(PROMPT_BUILDER_REGISTRY).toHaveLength(
      PROMPT_BUILDER_SCOPE_OPTIONS.length +
        PROMPT_BUILDER_QUALITY_OPTIONS.length,
    );
    expect(PROMPT_BUILDER_REGISTRY.every((option) => option.instruction)).toBe(
      true,
    );
    expect(
      PROMPT_BUILDER_REGISTRY.every(
        (option) => option.labelKey && option.descriptionKey,
      ),
    ).toBe(true);
    expect(PROMPT_BUILDER_SCOPE_OPTIONS.every((option) => option.category === 'scope')).toBe(
      true,
    );
    expect(
      PROMPT_BUILDER_QUALITY_OPTIONS.map((option) => option.category),
    ).toEqual([
      'structure',
      'structure',
      'structure',
      'structure',
      'design',
      'design',
      'design',
      'design',
    ]);
  });

  it('normalizes and compiles snapshot custom options as part of the same brief', () => {
    const recipe = normalizePromptBuilderRecipe({
      version: 1,
      scope: 'balanced',
      modifiers: ['minimal'],
      customOptions: [
        {
          id: 'dense-data',
          label: 'Dense data',
          instruction: 'Fit complex data into an efficient, highly scannable layout.',
          category: 'design',
        },
        {
          id: 'guided-setup',
          label: 'Guided setup',
          description: 'Make first use easy.',
          instruction: 'Turn initial setup into a short, reassuring sequence.',
          category: 'structure',
        },
      ],
    });

    expect(recipe.customOptions).toEqual([
      {
        id: 'guided-setup',
        label: 'Guided setup',
        description: 'Make first use easy.',
        instruction: 'Turn initial setup into a short, reassuring sequence.',
        category: 'structure',
      },
      {
        id: 'dense-data',
        label: 'Dense data',
        instruction: 'Fit complex data into an efficient, highly scannable layout.',
        category: 'design',
      },
    ]);

    const prompt = buildPromptFromRecipe(recipe);
    expect(prompt).toContain('Turn initial setup into a short, reassuring sequence.');
    expect(prompt).toContain(
      'Fit complex data into an efficient, highly scannable layout.',
    );
    expect(prompt.match(/COMBINED DESIGN QUALITIES/g)).toHaveLength(1);
  });

  it('drops malformed, duplicate, and built-in-colliding custom snapshots', () => {
    const recipe = normalizePromptBuilderRecipe({
      version: 1,
      scope: 'balanced',
      modifiers: [],
      customOptions: [
        {
          id: 'minimal',
          label: 'Collision',
          instruction: 'Should not compile.',
          category: 'design',
        },
        {
          id: 'custom-a',
          label: 'Custom A',
          instruction: 'Compile me.',
          category: 'structure',
        },
        {
          id: 'custom-a',
          label: 'Duplicate',
          instruction: 'Should not compile.',
          category: 'design',
        },
        {
          id: 'missing-instruction',
          label: 'Incomplete',
          category: 'design',
        },
      ],
    });

    expect(recipe.customOptions).toEqual([
      {
        id: 'custom-a',
        label: 'Custom A',
        instruction: 'Compile me.',
        category: 'structure',
      },
    ]);
    expect(buildPromptFromRecipe(recipe)).not.toContain('Should not compile.');
  });

  it('falls back safely when persisted draft data is malformed', () => {
    expect(normalizePromptBuilderRecipe({ scope: 'other', modifiers: 'nope' })).toEqual(
      defaultPromptBuilderRecipe(),
    );
    expect(
      normalizePromptBuilderRecipe({
        version: 2,
        scope: 'faithful',
        modifiers: ['material-3'],
      }),
    ).toEqual(defaultPromptBuilderRecipe());
  });
});
