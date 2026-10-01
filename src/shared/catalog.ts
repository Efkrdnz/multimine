import type { ModelEntry, ProviderKind } from './types'

/**
 * Starting presets only. Every list is editable in Settings, any model id can be typed in the
 * agent editor, and "Refresh models" asks the vendor for its live list where it has one.
 */
export const DEFAULT_CATALOG: Record<ProviderKind, ModelEntry[]> = {
  'claude-cli': [
    { id: 'claude-fable-5-1', label: 'Fable 5.1' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }
  ],
  'codex-cli': [
    { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol' },
    { id: 'gpt-6-astra', label: 'GPT 6 Astra' }
  ],
  anthropic: [
    { id: 'claude-fable-5-1', label: 'Fable 5.1' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }
  ],
  openai: [
    { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol' },
    { id: 'gpt-6-astra', label: 'GPT 6 Astra' }
  ],
  google: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
    { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' }
  ],
  xai: [{ id: 'grok-4', label: 'Grok 4' }],
  openrouter: [{ id: 'openrouter/auto', label: 'OpenRouter Auto' }],
  compatible: [{ id: 'llama3.1', label: 'Local (Ollama)' }],
  mock: [{ id: 'mock', label: 'Mock (no AI)' }]
}

export const PROVIDER_LABEL: Record<ProviderKind, string> = {
  'claude-cli': 'Claude subscription (Claude Code)',
  'codex-cli': 'ChatGPT subscription (Codex CLI)',
  anthropic: 'Anthropic API key',
  openai: 'OpenAI API key',
  google: 'Gemini API key',
  groq: 'Groq API key',
  xai: 'xAI (Grok) API key',
  openrouter: 'OpenRouter API key',
  compatible: 'OpenAI-compatible (Ollama, LM Studio...)',
  mock: 'Mock (offline demo)'
}

export const SHORT_PROVIDER: Record<ProviderKind, string> = {
  'claude-cli': 'Claude sub',
  'codex-cli': 'Codex sub',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Gemini',
  groq: 'Groq',
  xai: 'xAI',
  openrouter: 'OpenRouter',
  compatible: 'Local',
  mock: 'Mock'
}

/** CLI providers ride a login; everything else but mock and compatible needs a key. */
export function needsKey(p: ProviderKind): boolean {
  return !['claude-cli', 'codex-cli', 'mock', 'compatible'].includes(p)
}

export function modelLabel(catalog: Partial<Record<ProviderKind, ModelEntry[]>>, p: ProviderKind, id: string): string {
  const list = catalog[p] ?? DEFAULT_CATALOG[p]
  return list.find((m) => m.id === id)?.label ?? id
}
