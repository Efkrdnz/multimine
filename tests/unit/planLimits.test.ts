import { expect, it } from 'vitest'
import type { PlanWindow } from '@shared/types'
import { PlanLimits } from '../../src/main/providers/planLimits'
import { Notifier } from '../../src/main/notify'

const T = Date.UTC(2026, 9, 3, 12, 0)
const H = 3600_000

it('keeps the latest reading per window and warns once per reset period at 90%', () => {
  const seen: { windows: PlanWindow[]; warning?: string }[] = []
  const p = new PlanLimits((windows, warning) => seen.push({ windows, warning }))
  // Claude reports seconds since the epoch and a utilization as a fraction or a percentage
  p.record('five_hour', 0.62, (T + 2 * H) / 1000, 'ok', T)
  p.record('seven_day', 41, (T + 50 * H) / 1000, 'ok', T)
  expect(p.list(T).map((w) => [w.window, w.label, w.used, w.resetsAt])).toEqual([
    ['five_hour', '5-hour', 0.62, T + 2 * H],
    ['seven_day', 'Weekly', 0.41, T + 50 * H]
  ])
  expect(seen.every((s) => !s.warning)).toBe(true)
  p.record('five_hour', 0.91, (T + 2 * H) / 1000, 'near', T + 1000)
  expect(seen.at(-1)!.warning).toMatch(/^Claude 5-hour usage is at 91%; it resets at \d\d:\d\d\.$/)
  p.record('five_hour', 0.95, (T + 2 * H) / 1000, 'near', T + 2000)
  expect(seen.at(-1)!.warning).toBeUndefined()
  // used up within the same period: it was already said
  p.record('five_hour', undefined, (T + 2 * H) / 1000, 'exhausted', T + 3000)
  expect(seen.at(-1)!.warning).toBeUndefined()
  // the next period warns again
  p.record('five_hour', 0.93, (T + 7 * H) / 1000, 'near', T + 5 * H)
  expect(seen.at(-1)!.warning).toContain('at 93%')
  // a window past its reset is no longer shown
  expect(p.list(T + 60 * H).map((w) => w.window)).toEqual([])
})

it('says a window that is used up, and does not warn again after a restart for the same period', () => {
  const warnings: string[] = []
  const p = new PlanLimits((_, w) => w && warnings.push(w))
  p.record('seven_day_opus', undefined, T + 30 * H, 'exhausted', T)
  expect(warnings[0]).toMatch(/^Your Claude weekly opus limit is used up; it resets at /)
  expect(p.list(T)[0].used).toBe(1)
  const again = new PlanLimits((_, w) => w && warnings.push(w))
  again.restore(p.list(T))
  again.record('seven_day_opus', 1, T + 30 * H, 'exhausted', T + H)
  expect(warnings).toHaveLength(1)
})

it('turns a warning into a desktop notification when the window is in the background', () => {
  const shown: string[] = []
  let focused = false
  const n = new Notifier({ show: (x) => shown.push(`${x.title}: ${x.body}`), isFocused: () => focused, settings: () => ({ enabled: true, whenFocused: false, onFinish: false }), agentName: (id) => id, groupMs: 0 })
  n.handle({ type: 'plan-limits', windows: [], warning: 'Claude 5-hour usage is at 91%.' })
  focused = true
  n.handle({ type: 'plan-limits', windows: [], warning: 'Claude weekly usage is at 92%.' })
  n.handle({ type: 'plan-limits', windows: [] })
  expect(shown).toEqual(['Claude usage: Claude 5-hour usage is at 91%.'])
})
