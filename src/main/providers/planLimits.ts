import type { PlanWindow } from '@shared/types'

/**
 * How much of the Claude subscription's usage windows is spent, as Claude Code reports it with each
 * turn (`rate_limit_event`). One login per machine, so one record for the whole app, kept across
 * restarts. It only moves while a Claude agent runs: between turns it is the last word, dated.
 */

export const WARN_AT = 0.9

const LABEL: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly Opus',
  seven_day_sonnet: 'Weekly Sonnet',
  seven_day_overage_included: 'Weekly',
  overage: 'Extra usage'
}

export const windowLabel = (w: string): string => LABEL[w] ?? w.replace(/_/g, ' ')

/** Seconds or milliseconds since the epoch, as milliseconds. */
const ms = (t: number | undefined) => (!t ? undefined : t < 1e12 ? t * 1000 : t)

/** A reading as a fraction 0..1, whichever way it was given. */
export const fraction = (u: number) => Math.max(0, u <= 1 ? u : u / 100)

export function clock(at: number, now = Date.now()): string {
  const d = new Date(at)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return at - now > 20 * 3600_000 ? `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${hm}` : hm
}

export class PlanLimits {
  private windows = new Map<string, PlanWindow>()
  /** Per window, the reset period already warned about. */
  private warned = new Map<string, number>()

  constructor(private readonly changed: (windows: PlanWindow[], warning?: string) => void) {}

  /** The readings saved at the last run, as they were (no warning: it was given then). */
  restore(saved: PlanWindow[]): void {
    for (const w of saved) {
      if (!w || typeof w.window !== 'string' || typeof w.used !== 'number') continue
      this.windows.set(w.window, w)
      if (w.used >= WARN_AT || w.status === 'exhausted') this.warned.set(w.window, w.resetsAt ?? 0)
    }
  }

  list(now = Date.now()): PlanWindow[] {
    // a window whose reset has passed is no longer true
    return [...this.windows.values()].filter((w) => !w.resetsAt || w.resetsAt > now)
  }

  record(window: string, used: number | undefined, resetsAt: number | undefined, status: PlanWindow['status'], now = Date.now()): void {
    const prev = this.windows.get(window)
    const w: PlanWindow = {
      window,
      label: windowLabel(window),
      used: used === undefined ? (status === 'exhausted' ? 1 : (prev?.used ?? 0)) : fraction(used),
      resetsAt: ms(resetsAt) ?? prev?.resetsAt,
      status,
      at: now
    }
    this.windows.set(window, w)
    let warning: string | undefined
    const period = w.resetsAt ?? 0
    if ((w.used >= WARN_AT || status === 'exhausted') && this.warned.get(window) !== period) {
      this.warned.set(window, period)
      warning =
        status === 'exhausted'
          ? `Your Claude ${w.label.toLowerCase()} limit is used up${w.resetsAt ? `; it resets at ${clock(w.resetsAt, now)}` : ''}.`
          : `Claude ${w.label.toLowerCase()} usage is at ${Math.round(w.used * 100)}%${w.resetsAt ? `; it resets at ${clock(w.resetsAt, now)}` : ''}.`
    }
    this.changed(this.list(now), warning)
  }
}
