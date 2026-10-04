import { EFFORTS, PERMISSIONS, PROVIDERS, type AgentSpec, type ChatDefaults, type Effort, type FallbackHop, type Permission, type ProviderKind } from './types'

export const DEFAULT_CHAT_NAME = 'New chat'

/** What a new chat starts with when nothing better is known: the offline stand-in. */
export const MOCK_DEFAULTS: ChatDefaults = { provider: 'mock', model: 'mock', effort: 'medium', permissions: 'write', autoApprove: false }

/** A new chat on the given defaults; `patch` wins over both. */
export function newChat(id: string, defaults: ChatDefaults, patch: Partial<AgentSpec> = {}): AgentSpec {
  const now = Date.now()
  return { id, name: DEFAULT_CHAT_NAME, ...defaults, mcp: [], planMode: false, fallback: [], fallbackPaidOk: false, created: now, updated: now, ...patch }
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/** A chat read back from disk. Anything missing or malformed falls back to a sane default rather than failing. */
export function parseChat(id: string, raw: unknown): AgentSpec {
  const m = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    id,
    name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : DEFAULT_CHAT_NAME,
    provider: pick<ProviderKind>(m.provider, PROVIDERS, 'mock'),
    model: typeof m.model === 'string' ? m.model : '',
    effort: pick<Effort>(m.effort, EFFORTS, 'medium'),
    permissions: pick<Permission>(m.permissions, PERMISSIONS, 'write'),
    mcp: Array.isArray(m.mcp) ? m.mcp.filter((x): x is string => typeof x === 'string') : [],
    planMode: m.planMode === true,
    autoApprove: m.autoApprove === true,
    fallback: Array.isArray(m.fallback)
      ? m.fallback
          .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object')
          .map((h): FallbackHop => ({ provider: pick<ProviderKind>(h.provider, PROVIDERS, 'mock'), model: typeof h.model === 'string' ? h.model : '', effort: pick<Effort>(h.effort, EFFORTS, 'medium') }))
      : [],
    fallbackPaidOk: m.fallbackPaidOk === true,
    created: num(m.created),
    updated: num(m.updated)
  }
}

/** A chat's colour, for its avatar: one per provider, so a glance says what runs it. */
export const PROVIDER_COLOR: Record<ProviderKind, string> = {
  'claude-cli': '#f59e0b',
  anthropic: '#fb923c',
  'codex-cli': '#10b981',
  openai: '#34d399',
  google: '#60a5fa',
  groq: '#f472b6',
  xai: '#e5e7eb',
  openrouter: '#a78bfa',
  compatible: '#22d3ee',
  mock: '#7c9cff'
}
