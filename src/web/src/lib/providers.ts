// Client-side mirror of the backend provider registry (src/config/shared.ts):
// display names for grouping/labelling, the model-editor's provider options, and
// the OpenAI-compatible family (used to decide whether the tokenParam field shows).
export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI-compatible',
  gemini: 'Google Gemini',
  google: 'Google Gemini',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  xai: 'xAI',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  mistral: 'Mistral',
  moonshot: 'Moonshot',
  metaai: 'Meta AI',
};

export function providerLabel(provider?: string): string {
  const p = (provider || '').toLowerCase();
  return PROVIDER_LABELS[p] || provider || '';
}

export const providerOptions: { value: string; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'openai-compatible', label: 'OpenAI-compatible' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'google', label: 'Google' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'qwen', label: 'Qwen' },
  { value: 'xai', label: 'xAI' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'groq', label: 'Groq' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'moonshot', label: 'Moonshot' },
  { value: 'metaai', label: 'Meta AI' },
];

export const OPENAI_FAMILY = new Set([
  'openai',
  'openai-compatible',
  'deepseek',
  'qwen',
  'xai',
  'openrouter',
  'groq',
  'mistral',
  'moonshot',
  'metaai',
]);
