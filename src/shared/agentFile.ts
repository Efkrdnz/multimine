import { parse, stringify } from 'yaml'
import { EFFORTS, PROVIDERS, type AgentSpec, type FallbackHop, type Effort, type Permission, type ProviderKind, type Role } from './types'

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

const ROLES: Role[] = ['mastermind', 'planner', 'implementer', 'designer', 'brainstormer', 'context-handler', 'asset-creator', 'ui-creator', 'critic', 'custom']
const PERMS: Permission[] = ['chat', 'read', 'write']

/** A slug safe for a file name: lower case, dashes, never empty. */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || 'agent'
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/** Reads an agent file. Anything missing or malformed falls back to a sane default rather than failing. */
export function parseAgentFile(id: string, text: string): AgentSpec {
  const m = FRONT.exec(text)
  let meta: Record<string, unknown> = {}
  let body = text
  if (m) {
    try {
      const parsed = parse(m[1])
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>
    } catch {
      meta = {}
    }
    body = m[2]
  }
  const role = pick<Role>(meta.role, ROLES, 'custom')
  return {
    id,
    name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : id,
    role,
    provider: pick<ProviderKind>(meta.provider, PROVIDERS, 'mock'),
    model: typeof meta.model === 'string' ? meta.model : '',
    effort: pick<Effort>(meta.effort, EFFORTS, 'medium'),
    color: typeof meta.color === 'string' && /^#[0-9a-f]{6}$/i.test(meta.color) ? meta.color : '#7c9cff',
    permissions: pick<Permission>(meta.permissions, PERMS, 'read'),
    mcp: Array.isArray(meta.mcp) ? meta.mcp.filter((x): x is string => typeof x === 'string') : [],
    gated: meta.gated === true,
    planMode: meta.planMode === true,
    autoApprove: meta.autoApprove !== false,
    fallback: Array.isArray(meta.fallback)
      ? meta.fallback
          .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object')
          .map((h): FallbackHop => ({ provider: pick<ProviderKind>(h.provider, PROVIDERS, 'mock'), model: typeof h.model === 'string' ? h.model : '', effort: pick<Effort>(h.effort, EFFORTS, 'medium') }))
      : [],
    fallbackPaidOk: meta.fallbackPaidOk === true,
    purpose: body.replace(/^\s+/, '').replace(/\s+$/, '') + '\n'
  }
}

export function serializeAgentFile(agent: AgentSpec): string {
  const meta = {
    name: agent.name,
    role: agent.role,
    provider: agent.provider,
    model: agent.model,
    effort: agent.effort,
    color: agent.color,
    permissions: agent.permissions,
    mcp: agent.mcp,
    gated: agent.gated,
    planMode: agent.planMode,
    autoApprove: agent.autoApprove,
    fallback: agent.fallback ?? [],
    fallbackPaidOk: agent.fallbackPaidOk ?? false
  }
  return `---\n${stringify(meta).trimEnd()}\n---\n\n${agent.purpose.trim()}\n`
}
