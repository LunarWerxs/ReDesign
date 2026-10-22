interface PromptBuilderRegistryEntryShape {
  id: string;
  category: 'scope' | 'structure' | 'design';
  instruction: string;
  labelKey: `promptBuilder.${string}`;
  descriptionKey: `promptBuilder.${string}`;
}

/**
 * The authoritative registry for built-in Prompt Builder choices.
 *
 * Keep display metadata and compiler instructions together so adding a built-in
 * choice is a single-file change. The literal types derived below keep recipes,
 * the compiler, and the UI in sync with the registry.
 */
export const PROMPT_BUILDER_REGISTRY = [
  {
    id: 'faithful',
    category: 'scope',
    labelKey: 'promptBuilder.scopeFaithful',
    descriptionKey: 'promptBuilder.scopeFaithfulDescription',
    instruction:
      'Stay true to the original. Preserve its information architecture, layout relationships, recognizable interaction model, and complete feature set. Modernize the execution without turning it into a different product.',
  },
  {
    id: 'balanced',
    category: 'scope',
    labelKey: 'promptBuilder.scopeBalanced',
    descriptionKey: 'promptBuilder.scopeBalancedDescription',
    instruction:
      'Create a confident evolution of the original. Preserve the product’s purpose and essential capabilities, but freely improve hierarchy, grouping, navigation, and local layout wherever that makes the experience clearer.',
  },
  {
    id: 'reimagine',
    category: 'scope',
    labelKey: 'promptBuilder.scopeReimagine',
    descriptionKey: 'promptBuilder.scopeReimagineDescription',
    instruction:
      'Redesign the experience from first principles. You may replace the layout, navigation, and interaction model as long as the result serves the same user goal more effectively and retains the necessary functionality.',
  },
  {
    id: 'progressive-disclosure',
    category: 'structure',
    labelKey: 'promptBuilder.progressiveDisclosure',
    descriptionKey: 'promptBuilder.progressiveDisclosureDescription',
    instruction:
      'Use progressive disclosure. Keep the primary task, current state, and immediately useful information visible; move secondary, advanced, repetitive, or rare controls behind one obvious next layer such as an overflow menu, accordion, popover, drawer, or settings surface.',
  },
  {
    id: 'strip-to-essentials',
    category: 'structure',
    labelKey: 'promptBuilder.stripToEssentials',
    descriptionKey: 'promptBuilder.stripToEssentialsDescription',
    instruction:
      'Strip the default view to its essentials. Remove redundant copy, duplicated actions, decorative noise, and low-value chrome. Every visible element must earn its place, while required capabilities remain easy to reach.',
  },
  {
    id: 'conversion-focus',
    category: 'structure',
    labelKey: 'promptBuilder.conversionFocus',
    descriptionKey: 'promptBuilder.conversionFocusDescription',
    instruction:
      'Optimize around the single most important user action. Make its value and next step unmistakable, reduce friction, use sensible defaults and reassurance, and keep secondary actions available but visually subordinate.',
  },
  {
    id: 'approachable',
    category: 'structure',
    labelKey: 'promptBuilder.approachable',
    descriptionKey: 'promptBuilder.approachableDescription',
    instruction:
      'Make the experience approachable for a first-time, non-technical user. Prefer plain-language labels, forgiving choices, helpful empty states, clear feedback, and gentle guidance without adding explanatory clutter.',
  },
  {
    id: 'minimal',
    category: 'design',
    labelKey: 'promptBuilder.minimal',
    descriptionKey: 'promptBuilder.minimalDescription',
    instruction:
      'Use a restrained minimalist visual language: generous breathing room, disciplined alignment, a quiet palette, concise typography, and hierarchy created through scale and spacing instead of extra containers or decoration.',
  },
  {
    id: 'material-3',
    category: 'design',
    labelKey: 'promptBuilder.material3',
    descriptionKey: 'promptBuilder.material3Description',
    instruction:
      'Apply Material 3 (Material You) design theory as the visual system. Use a coherent tonal color scheme with correct on-colors, surface tint for elevation, the M3 shape and type scales, visible state layers, and recognizable M3 components where they fit. Adapt M3 to the product rather than forcing every available component into the screen.',
  },
  {
    id: 'clarity-accessibility',
    category: 'design',
    labelKey: 'promptBuilder.clarityAccessibility',
    descriptionKey: 'promptBuilder.clarityAccessibilityDescription',
    instruction:
      'Prioritize clarity and accessibility: strong hierarchy, readable typography, WCAG-AA contrast, generous targets, visible focus states, logical keyboard order, semantic structure, and reduced cognitive load.',
  },
  {
    id: 'playful-branded',
    category: 'design',
    labelKey: 'promptBuilder.playfulBranded',
    descriptionKey: 'promptBuilder.playfulBrandedDescription',
    instruction:
      'Give the product a distinctive, branded personality through a confident palette, expressive typography, thoughtful motion, and small moments of delight, without weakening usability or hierarchy.',
  },
] as const satisfies readonly PromptBuilderRegistryEntryShape[];

export type PromptBuilderBuiltInOption =
  (typeof PROMPT_BUILDER_REGISTRY)[number];
export type PromptBuilderOptionCategory =
  PromptBuilderBuiltInOption['category'];
export type PromptBuilderCustomOptionCategory = Exclude<
  PromptBuilderOptionCategory,
  'scope'
>;
export type PromptBuilderScopeOption = Extract<
  PromptBuilderBuiltInOption,
  { category: 'scope' }
>;
export type PromptBuilderQualityOption = Exclude<
  PromptBuilderBuiltInOption,
  PromptBuilderScopeOption
>;
export type PromptBuilderScopeId = PromptBuilderScopeOption['id'];
export type PromptBuilderModifierId = PromptBuilderQualityOption['id'];

export const PROMPT_BUILDER_SCOPE_OPTIONS =
  PROMPT_BUILDER_REGISTRY.filter(
    (option): option is PromptBuilderScopeOption =>
      option.category === 'scope',
  );

export const PROMPT_BUILDER_QUALITY_OPTIONS =
  PROMPT_BUILDER_REGISTRY.filter(
    (option): option is PromptBuilderQualityOption =>
      option.category !== 'scope',
  );
