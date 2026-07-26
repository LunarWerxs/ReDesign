import {
  PROMPT_BUILDER_QUALITY_OPTIONS,
  PROMPT_BUILDER_REGISTRY,
  PROMPT_BUILDER_SCOPE_OPTIONS,
  type PromptBuilderBuiltInOption,
  type PromptBuilderCustomOptionCategory,
  type PromptBuilderQualityOption,
  type PromptBuilderScopeOption,
} from '@/lib/prompt-builder-registry';
import type {
  PromptBuilderCustomOptionSnapshot,
  PromptBuilderModifierId,
  PromptBuilderRecipe,
  PromptBuilderScopeId,
} from '@/types';

export {
  PROMPT_BUILDER_QUALITY_OPTIONS,
  PROMPT_BUILDER_REGISTRY,
  PROMPT_BUILDER_SCOPE_OPTIONS,
};

/** @deprecated Prefer PROMPT_BUILDER_SCOPE_OPTIONS. */
export const PROMPT_BUILDER_SCOPES = PROMPT_BUILDER_SCOPE_OPTIONS;
/** @deprecated Prefer PROMPT_BUILDER_QUALITY_OPTIONS. */
export const PROMPT_BUILDER_MODIFIERS = PROMPT_BUILDER_QUALITY_OPTIONS;

const DEFAULT_SCOPE: PromptBuilderScopeId = 'balanced';
const CUSTOM_OPTION_CATEGORIES: readonly PromptBuilderCustomOptionCategory[] = [
  'structure',
  'design',
];
const MAX_CUSTOM_OPTIONS = 50;
const MAX_CUSTOM_OPTION_ID_LENGTH = 100;
const MAX_CUSTOM_OPTION_LABEL_LENGTH = 100;
const MAX_CUSTOM_OPTION_DESCRIPTION_LENGTH = 300;
const MAX_CUSTOM_OPTION_INSTRUCTION_LENGTH = 4_000;

const scopeById = new Map<PromptBuilderScopeId, PromptBuilderScopeOption>(
  PROMPT_BUILDER_SCOPE_OPTIONS.map((option) => [option.id, option] as const),
);
const qualityById = new Map<
  PromptBuilderModifierId,
  PromptBuilderQualityOption
>(
  PROMPT_BUILDER_QUALITY_OPTIONS.map((option) => [option.id, option] as const),
);
const builtInIds = new Set<string>(
  PROMPT_BUILDER_REGISTRY.map((option) => option.id),
);
const customOptionCategories = new Set<string>(CUSTOM_OPTION_CATEGORIES);

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

function optionalBoundedText(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (value == null || value === '') return undefined;
  return boundedText(value, maxLength) ?? undefined;
}

function normalizeCustomOptions(
  value: unknown,
): PromptBuilderCustomOptionSnapshot[] {
  if (!Array.isArray(value)) return [];

  const seenIds = new Set<string>();
  const normalized: PromptBuilderCustomOptionSnapshot[] = [];

  for (const candidate of value.slice(0, MAX_CUSTOM_OPTIONS)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const raw = candidate as Record<string, unknown>;
    const id = boundedText(raw.id, MAX_CUSTOM_OPTION_ID_LENGTH);
    const label = boundedText(raw.label, MAX_CUSTOM_OPTION_LABEL_LENGTH);
    const instruction = boundedText(
      raw.instruction,
      MAX_CUSTOM_OPTION_INSTRUCTION_LENGTH,
    );
    const category =
      typeof raw.category === 'string' &&
      customOptionCategories.has(raw.category)
        ? (raw.category as PromptBuilderCustomOptionCategory)
        : null;

    if (
      !id ||
      !label ||
      !instruction ||
      !category ||
      builtInIds.has(id) ||
      seenIds.has(id)
    ) {
      continue;
    }

    seenIds.add(id);
    const description = optionalBoundedText(
      raw.description,
      MAX_CUSTOM_OPTION_DESCRIPTION_LENGTH,
    );
    normalized.push({
      id,
      label,
      ...(description ? { description } : {}),
      instruction,
      category,
    });
  }

  return CUSTOM_OPTION_CATEGORIES.flatMap((category) =>
    normalized.filter((option) => option.category === category),
  );
}

export function defaultPromptBuilderRecipe(): PromptBuilderRecipe {
  return { version: 1, scope: DEFAULT_SCOPE, modifiers: [] };
}

export function normalizePromptBuilderRecipe(value: unknown): PromptBuilderRecipe {
  if (!value || typeof value !== 'object') return defaultPromptBuilderRecipe();
  const raw = value as {
    version?: unknown;
    scope?: unknown;
    modifiers?: unknown;
    customOptions?: unknown;
  };
  if (raw.version !== 1) return defaultPromptBuilderRecipe();

  const scope = scopeById.has(raw.scope as PromptBuilderScopeId)
    ? (raw.scope as PromptBuilderScopeId)
    : DEFAULT_SCOPE;
  const requestedQualities = new Set(
    Array.isArray(raw.modifiers)
      ? raw.modifiers.filter(
          (id): id is PromptBuilderModifierId =>
            typeof id === 'string' &&
            qualityById.has(id as PromptBuilderModifierId),
        )
      : [],
  );
  const modifiers = PROMPT_BUILDER_QUALITY_OPTIONS.map(
    (option) => option.id,
  ).filter((id) => requestedQualities.has(id));
  const customOptions = normalizeCustomOptions(raw.customOptions);

  return {
    version: 1,
    scope,
    modifiers,
    ...(customOptions.length ? { customOptions } : {}),
  };
}

function qualitiesInPromptOrder(
  builtIn: PromptBuilderQualityOption[],
  custom: PromptBuilderCustomOptionSnapshot[],
): Array<PromptBuilderBuiltInOption | PromptBuilderCustomOptionSnapshot> {
  return CUSTOM_OPTION_CATEGORIES.flatMap((category) => [
    ...builtIn.filter((option) => option.category === category),
    ...custom.filter((option) => option.category === category),
  ]);
}

export function buildPromptFromRecipe(value: PromptBuilderRecipe): string {
  const recipe = normalizePromptBuilderRecipe(value);
  const scope = scopeById.get(recipe.scope) ?? scopeById.get(DEFAULT_SCOPE);
  const builtInQualities = recipe.modifiers
    .map((id) => qualityById.get(id))
    .filter(
      (option): option is PromptBuilderQualityOption => option !== undefined,
    );
  const qualities = qualitiesInPromptOrder(
    builtInQualities,
    recipe.customOptions ?? [],
  );

  const sections = [
    'Create one cohesive, polished redesign from the directions below. Treat them as one brief, not separate alternatives. If two directions create tension, preserve usability and the chosen redesign direction, then integrate the remaining qualities coherently.',
    `REDESIGN DIRECTION\n${scope?.instruction ?? ''}`,
  ];

  if (qualities.length) {
    sections.push(
      `COMBINED DESIGN QUALITIES\n${qualities
        .map(
          (option, index) =>
            `${index + 1}. ${option.instruction}`,
        )
        .join('\n')}`,
    );
  }

  sections.push(
    'Deliver a responsive, production-quality interface with realistic content and complete interaction states. Do not describe these instructions in the UI; express them through the design itself.',
  );
  return sections.join('\n\n');
}

/** Legacy recipe field helper. Built-in quality IDs remain in `modifiers`. */
export function promptBuilderModifierIds(): PromptBuilderModifierId[] {
  return PROMPT_BUILDER_QUALITY_OPTIONS.map((option) => option.id);
}
