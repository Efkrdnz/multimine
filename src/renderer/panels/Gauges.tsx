import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, Gauge } from 'lucide-react'
import { PROVIDER_COLOR } from '@shared/chat'
import type { Usage } from '@shared/types'
import { tokens, usageLine } from '@shared/usage'
import { useStore } from '../state/store'

/** What a usage weighs: cached context a tenth, output five times (how it is priced). */
const weight = (u: Usage) => u.inputTokens + (u.cacheWrite ?? 0) * 1.25 + (u.cacheRead ?? 0) * 0.1 + u.outputTokens * 5

const SHORT: Record<string, string> = { five_hour: '5h', seven_day: 'week', seven_day_opus: 'Opus wk', seven_day_sonnet: 'Sonnet wk', seven_day_overage_included: 'week', overage: 'extra' }

const hhmm = (at: number) => {
  const d = new Date(at)
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return at - Date.now() > 20 * 3600_000 ? `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${t}` : t
}

/** How much of the Claude plan's usage windows is spent, as Claude Code last reported it. */
export function PlanGauge() {
  const all = useStore((s) => s.planLimits)
  const windows = all.filter((w) => !w.resetsAt || w.resetsAt > Date.now()).sort((a, b) => order(a.window) - order(b.window)).slice(0, 3)
  if (!windows.length) return null
  const last = Math.max(...windows.map((w) => w.at))
  const ago = Math.round((Date.now() - last) / 60_000)
  const tip = [
    ...windows.map((w) => `${w.label}: ${Math.round(w.used * 100)}% used${w.resetsAt ? `, resets ${hhmm(w.resetsAt)}` : ''}${w.status === 'exhausted' ? ' - used up' : ''}`),
    '',
    `Claude's own reading, ${ago < 1 ? 'just now' : `${ago} min ago`}. It updates while a Claude chat works.`
  ].join('\n')
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 font-mono text-[11px] text-indigo-200" title={tip} data-testid="plan-gauge">
      <Gauge size={13} />
      {windows.map((w) => {
        const pct = Math.round(w.used * 100)
        const color = w.status === 'exhausted' || w.used >= 0.95 ? '#f87171' : w.used >= 0.8 ? '#fbbf24' : '#34d399'
        return (
          <span key={w.window} className="flex items-center gap-1.5" data-testid={`plan-${w.window}`}>
            <span className="text-indigo-300/70">{SHORT[w.window] ?? w.label}</span>
            <span className="h-1.5 w-12 overflow-hidden rounded-full bg-white/10">
              <span className="block h-full rounded-full" style={{ width: `${Math.min(100, pct)}%`, background: color }} />
            </span>
            <span style={{ color: w.used >= 0.8 ? color : undefined }}>{pct}%</span>
            {w.resetsAt && <span className="text-indigo-300/50">{hhmm(w.resetsAt)}</span>}
          </span>
        )
      })}
    </div>
  )
}

const order = (w: string) => ['five_hour', 'seven_day', 'seven_day_overage_included', 'seven_day_opus', 'seven_day_sonnet', 'overage'].indexOf(w) + 1 || 99

/** Usage since the project was opened, and which chat spent what. */
export function UsagePill() {
  const usage = useStore((s) => s.usage)
  const byAgent = useStore((s) => s.usageByAgent)
  const agents = useStore((s) => s.project?.agents ?? [])
  const [open, setOpen] = useState(false)
  const rows = Object.entries(byAgent).sort((a, b) => weight(b[1]) - weight(a[1]))
  const all = rows.reduce((n, [, u]) => n + weight(u), 0) || 1
  const cached = (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  return (
    <div className="relative">
      <button
        className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 font-mono text-[11px] text-indigo-200 hover:border-white/25"
        title="Tokens used in this project's chats - click for each chat's share"
        onClick={() => setOpen((o) => !o)}
        data-testid="usage"
      >
        <Bot size={13} /> {tokens(usage.inputTokens)} in{cached ? ` · ${tokens(cached)} cached` : ''} · {tokens(usage.outputTokens)} out{usage.costUsd ? ` · ≈$${usage.costUsd.toFixed(2)}` : ''}
      </button>
      {open && (
        createPortal(
        // on the body, above every panel
        <div className="glass fixed right-4 top-14 z-[60] max-h-[70vh] w-[380px] overflow-auto rounded-xl p-3 text-xs" style={{ background: 'rgb(10 12 28 / 0.96)' }} data-testid="usage-breakdown">
          <div className="mb-2 font-semibold text-indigo-100">Usage by chat</div>
          {!rows.length && <div className="text-indigo-300/60">Nothing yet.</div>}
          {rows.map(([id, u]) => {
            const a = agents.find((x) => x.id === id)
            const share = Math.round((weight(u) / all) * 100)
            return (
              <div key={id} className="mb-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-indigo-100">
                    <span className="h-2 w-2 rounded-full" style={{ background: (a ? PROVIDER_COLOR[a.provider] : '#a5b4fc') }} />
                    {a?.name ?? id}
                    {a?.model && <span className="text-indigo-300/50">{a.model} · {a.effort}</span>}
                  </span>
                  <span className="font-mono text-indigo-200">{share}%</span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded bg-white/5">
                  <div className="h-full rounded" style={{ width: `${share}%`, background: (a ? PROVIDER_COLOR[a.provider] : '#a5b4fc') }} />
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-indigo-300/60">{usageLine(u)}</div>
              </div>
            )
          })}
          <div className="mt-1 text-[10px] leading-snug text-indigo-300/50">
            Shares weigh tokens the way they are priced: cached context a tenth, output five times. Every model call re-sends the whole conversation, so long turns and big instruction files cost the most.
          </div>
        </div>,
        document.body
        )
      )}
    </div>
  )
}
