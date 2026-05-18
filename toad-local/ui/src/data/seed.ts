import type { Provider } from '@/types';

// Static model registry for the provider/model picker. This is NOT seed
// "user data" — it's a hardcoded list of model names per provider that
// updates when a provider releases new ones. Last refreshed 2026-05-02.
//
// Anthropic: Opus 4.7 launched 2026-04-16; all 4.6+ models support a 1M
// context window via the (1M) variant (200K is the default for cost).
// OpenAI: GPT-5.5 launched 2026-04-23; the older 5.4 family stays
// available for cost-sensitive tasks.
// Gemini: 3.1 Pro is the current flagship; Flash-Lite is the cheapest.
export const SEED_PROVIDERS: Provider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    models: [
      'Default',
      'Opus 4.7',
      'Opus 4.7 (1M)',
      'Opus 4.6',
      'Sonnet 4.6',
      'Sonnet 4.6 (1M)',
      'Haiku 4.5',
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI Codex',
    models: [
      'Default',
      '5.5',
      '5.5 Pro',
      '5.5 Thinking',
      '5.4',
      '5.4-mini',
      '5.3-codex',
    ],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    models: [
      'Default',
      'Gemini 3.1 Pro',
      'Gemini 3.1 Flash-Lite',
      'Gemini 3 Pro',
      'Gemini 2.5 Pro',
      'Gemini 2.5 Flash',
    ],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    models: [
      'Default',
      'opencode/big-pickle',
      'opencode/deepseek-v4-flash-free',
      'opencode/minimax-m2.5-free',
      'opencode/nemotron-3-super-free',
      'opencode/qwen3.6-plus-free',
    ],
  },
];
