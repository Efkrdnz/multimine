import type { Effort, ProviderKind } from './types'

/** Which effort levels each provider can actually express; the editor greys out the rest. */
export const SUPPORTED_EFFORTS: Record<ProviderKind, Effort[]> = {
  'claude-cli': ['low', 'medium', 'high', 'xhigh', 'max'],
  'codex-cli': ['low', 'medium', 'high', 'xhigh'],
  anthropic: ['low', 'medium', 'high', 'xhigh', 'max'],
  openai: ['low', 'medium', 'high', 'xhigh', 'max'],
  google: ['low', 'medium', 'high', 'xhigh', 'max'],
  groq: ['low', 'medium', 'high'],
  xai: ['low', 'medium', 'high', 'xhigh'],
  openrouter: ['low', 'medium', 'high'],
  compatible: ['medium'],
  mock: ['low', 'medium', 'high', 'xhigh', 'max']
}

const ORDER: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** The nearest supported level at or below the asked one (or the lowest supported, if none is below). */
export function clampEffort(provider: ProviderKind, effort: Effort): Effort {
  const allowed = SUPPORTED_EFFORTS[provider]
  const want = ORDER.indexOf(effort)
  for (let i = want; i >= 0; i--) if (allowed.includes(ORDER[i])) return ORDER[i]
  return allowed[0]
}

/** Extended-thinking token budget for providers that take one (Anthropic API, Gemini). */
export const THINKING_BUDGET: Record<Effort, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 63999
}

/** The reasoning-effort word OpenAI-style APIs and the Codex CLI accept. */
export function reasoningWord(provider: ProviderKind, effort: Effort): string {
  return clampEffort(provider, effort)
}
