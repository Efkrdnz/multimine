import type { Usage } from './types'

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, calls: 0, costUsd: 0 }

/** Two usages added up; a cost only one side knows is kept. */
export function addUsage(a: Usage | undefined, b: Partial<Usage>): Usage {
  const x = a ?? NO_USAGE
  const cost = (x.costUsd ?? 0) + (b.costUsd ?? 0)
  return {
    inputTokens: x.inputTokens + (b.inputTokens ?? 0),
    outputTokens: x.outputTokens + (b.outputTokens ?? 0),
    cacheRead: (x.cacheRead ?? 0) + (b.cacheRead ?? 0),
    cacheWrite: (x.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
    calls: (x.calls ?? 0) + (b.calls ?? 0),
    costUsd: cost || undefined
  }
}

/** A token count said briefly: 812, 12k, 1.4M. */
export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${n < 10_000 ? (n / 1000).toFixed(1) : Math.round(n / 1000)}k`
  return `${n < 10_000_000 ? (n / 1e6).toFixed(1) : Math.round(n / 1e6)}M`
}

/** One line for a usage: fresh input, cached context, output, and the cost when known. */
export function usageLine(u: Usage): string {
  const parts = [`${tokens(u.inputTokens)} in`]
  if (u.cacheRead || u.cacheWrite) parts.push(`${tokens((u.cacheRead ?? 0) + (u.cacheWrite ?? 0))} cached`)
  parts.push(`${tokens(u.outputTokens)} out`)
  if (u.calls) parts.push(`${u.calls} call${u.calls === 1 ? '' : 's'}`)
  if (u.costUsd) parts.push(`≈$${u.costUsd < 1 ? u.costUsd.toFixed(3) : u.costUsd.toFixed(2)}`)
  return parts.join(' · ')
}
