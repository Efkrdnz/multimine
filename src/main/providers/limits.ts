import type { ProviderKind } from '@shared/types'

/** Why a provider stopped answering: out of usage, throttled for a moment, or its login/key is bad. */
export type Failure = 'usage' | 'rate' | 'auth'

const USAGE = /usage limit|quota|insufficient[_ ]?(quota|credits?|funds|balance)|credit balance|out of credits|billing|exceeded your current|resource[_ ]?exhausted|hit your .{0,20}limit|limit (has been )?reached|\b402\b|payment required/i
const RATE = /rate[ _-]?limit|too many requests|\b429\b|overloaded|try again in/i
const AUTH = /authenticat|oauth|\b401\b|invalid[_ ]api[_ ]key|incorrect api key|api key not valid|unauthori[sz]ed|login has expired|not logged in|please run \/login|codex login/i

/**
 * Whether an error means "this provider cannot serve you right now" (switch to the fallback) rather
 * than "something went wrong" (stop and show it). Only the first kind ever falls back: a real bug
 * must not be retried on somebody's paid key.
 */
export function failureOf(message: string | undefined): Failure | null {
  if (!message) return null
  if (USAGE.test(message)) return 'usage'
  if (AUTH.test(message)) return 'auth'
  if (RATE.test(message)) return 'rate'
  return null
}

/** Providers billed per call. Switching onto one asks first, unless the agent allows it. */
export function isPaid(p: ProviderKind): boolean {
  return p === 'anthropic' || p === 'openai' || p === 'google' || p === 'groq' || p === 'xai' || p === 'openrouter'
}

export interface HealthEntry {
  state: 'near' | 'exhausted'
  until: number
  reason: string
}

const DEFAULT_MS: Record<Failure | 'near', number> = { usage: 60 * 60_000, rate: 5 * 60_000, auth: 6 * 60 * 60_000, near: 20 * 60_000 }

/** Epoch seconds or milliseconds, whichever the vendor sent. */
function toMs(t: number | undefined): number | undefined {
  if (!t) return undefined
  return t < 1e12 ? t * 1000 : t
}

/**
 * What each provider can do right now, shared by every agent: one Claude login running out means
 * every Claude agent switches together. Entries expire on their own (at the vendor's reset time when
 * it said, otherwise after a default spell), and the provider is tried again at the next new task.
 */
export class ProviderHealth {
  private m = new Map<ProviderKind, HealthEntry>()

  constructor(private readonly changed: (snapshot: Record<string, HealthEntry>) => void = () => undefined) {}

  mark(p: ProviderKind, state: 'near' | 'exhausted', reason: string, kind: Failure | 'near', resetsAt?: number, now = Date.now()): void {
    const until = toMs(resetsAt) ?? now + DEFAULT_MS[kind]
    const cur = this.get(p, now)
    // an exhausted provider is not "upgraded" back to near by a later warning
    if (cur?.state === 'exhausted' && state === 'near') return
    this.m.set(p, { state, until, reason })
    this.changed(this.snapshot(now))
  }

  clear(p: ProviderKind): void {
    if (this.m.delete(p)) this.changed(this.snapshot())
  }

  get(p: ProviderKind, now = Date.now()): HealthEntry | null {
    const e = this.m.get(p)
    if (!e) return null
    if (e.until <= now) {
      this.m.delete(p)
      return null
    }
    return e
  }

  /** Good to start a new task on: not exhausted, and not merely near its limit. */
  fresh(p: ProviderKind, now = Date.now()): boolean {
    return this.get(p, now) === null
  }

  /** Good to keep using if nothing better is left: anything not exhausted. */
  usable(p: ProviderKind, now = Date.now()): boolean {
    return this.get(p, now)?.state !== 'exhausted'
  }

  snapshot(now = Date.now()): Record<string, HealthEntry> {
    const out: Record<string, HealthEntry> = {}
    for (const p of [...this.m.keys()]) {
      const e = this.get(p, now)
      if (e) out[p] = e
    }
    return out
  }
}
