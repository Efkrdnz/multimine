import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, ChevronDown, Copy, FolderOpen, Leaf, Pencil, Plus, Trash2, Zap } from 'lucide-react'
import type { Usage } from '@shared/types'
import { tokens, usageLine } from '@shared/usage'
import { api, useStore } from '../state/store'

/** What a usage weighs: cached context a tenth, output five times (how it is priced). */
const weight = (u: Usage) => u.inputTokens + (u.cacheWrite ?? 0) * 1.25 + (u.cacheRead ?? 0) * 0.1 + u.outputTokens * 5

/** This session's usage, and which agent spent what. */
function UsagePill() {
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
        title="Tokens used this session - click for each agent's share"
        onClick={() => setOpen((o) => !o)}
        data-testid="usage"
      >
        <Bot size={13} /> {tokens(usage.inputTokens)} in{cached ? ` · ${tokens(cached)} cached` : ''} · {tokens(usage.outputTokens)} out{usage.costUsd ? ` · ≈$${usage.costUsd.toFixed(2)}` : ''}
      </button>
      {open && (
        createPortal(
        // on the body: the top bar's own stacking context sits under the chat dock
        <div className="glass fixed right-4 top-14 z-[60] max-h-[70vh] w-[380px] overflow-auto rounded-xl p-3 text-xs" style={{ background: 'rgb(10 12 28 / 0.96)' }} data-testid="usage-breakdown">
          <div className="mb-2 font-semibold text-indigo-100">Usage this session</div>
          {!rows.length && <div className="text-indigo-300/60">Nothing yet.</div>}
          {rows.map(([id, u]) => {
            const a = agents.find((x) => x.id === id)
            const share = Math.round((weight(u) / all) * 100)
            return (
              <div key={id} className="mb-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-indigo-100">
                    <span className="h-2 w-2 rounded-full" style={{ background: a?.color ?? '#a5b4fc' }} />
                    {a?.name ?? id}
                    {a?.model && <span className="text-indigo-300/50">{a.model} · {a.effort}</span>}
                  </span>
                  <span className="font-mono text-indigo-200">{share}%</span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded bg-white/5">
                  <div className="h-full rounded" style={{ width: `${share}%`, background: a?.color ?? '#a5b4fc' }} />
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

export function TopBar() {
  const project = useStore((s) => s.project)!
  const sessions = useStore((s) => s.sessions)
  const active = useStore((s) => s.activeSession)
  const settings = useStore((s) => s.settings)
  const [open, setOpen] = useState(false)
  const current = sessions.find((s) => s.id === active)
  const automation = !!settings?.automation

  const toggleAutomation = async () => {
    if (!automation && !confirm('Turn on automation?\n\nMastermind will answer agent questions and approve plans on your behalf until you turn it off. git push and destructive commands still wait for you.')) return
    await api().updateSettings({ automation: !automation })
  }

  const switchProject = async () => {
    const dir = await api().pickProject()
    if (dir) await api().openProject(dir)
  }

  return (
    <div className="absolute left-0 right-0 top-0 z-20 flex h-14 items-center gap-3 px-4" style={{ background: 'linear-gradient(180deg, rgb(4 5 13 / 0.92), rgb(4 5 13 / 0))' }}>
      <div className="flex items-center gap-2 pl-12">
        <span className="font-display text-lg font-bold tracking-[0.25em] glow-text">MULTIMINE</span>
        <button className="btn btn-ghost !px-2 text-xs text-indigo-200" onClick={switchProject} title={project.dir}>
          <FolderOpen size={14} /> {project.name}
        </button>
      </div>

      <div className="relative">
        <button className="btn" onClick={() => setOpen(!open)} data-testid="session-menu">
          <span className="max-w-56 truncate">{current?.name ?? 'No session'}</span>
          <ChevronDown size={14} />
        </button>
        {open && (
          <div className="glass rise absolute left-0 top-10 z-30 w-80 rounded-xl p-2" onMouseLeave={() => setOpen(false)}>
            <div className="scroll-thin max-h-72 overflow-y-auto">
              {sessions.map((s) => (
                <div key={s.id} className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${s.id === active ? 'bg-violet-500/20' : 'hover:bg-white/5'}`}>
                  <button className="flex-1 truncate text-left" onClick={() => void api().switchSession(s.id).then(() => setOpen(false))}>
                    {s.name}
                    <span className="ml-2 text-[10px] text-indigo-300/60">{new Date(s.updated).toLocaleDateString()}</span>
                  </button>
                  <button className="opacity-0 group-hover:opacity-100" title="Rename" onClick={() => {
                    const name = prompt('Session name', s.name)
                    if (name) void api().renameSession(s.id, name)
                  }}>
                    <Pencil size={13} />
                  </button>
                  <button className="opacity-0 group-hover:opacity-100" title="Duplicate" onClick={() => void api().duplicateSession(s.id)}>
                    <Copy size={13} />
                  </button>
                  <button className="text-red-300 opacity-0 group-hover:opacity-100" title="Delete" onClick={() => confirm(`Delete session "${s.name}"?`) && void api().deleteSession(s.id)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
            <button className="btn mt-2 w-full justify-center" onClick={() => {
              const name = prompt('New session name', `Session ${sessions.length + 1}`)
              if (name !== null) void api().newSession(name || undefined).then(() => setOpen(false))
            }}>
              <Plus size={14} /> New session
            </button>
          </div>
        )}
      </div>

      <div className="flex-1" />

      <UsagePill />
      <button
        className={`btn ${settings?.economy.enabled ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-100' : ''}`}
        onClick={() => settings && void api().updateSettings({ economy: { ...settings.economy, enabled: !settings.economy.enabled } })}
        title="Economy mode: short answers and cheaper models for easy tasks (configure in Settings)"
        data-testid="economy"
      >
        <Leaf size={14} /> Economy {settings?.economy.enabled ? 'ON' : 'off'}
      </button>
      <button className={`btn ${automation ? 'automation-on text-white' : ''}`} onClick={toggleAutomation} data-testid="automation" title="When on, Mastermind answers questions and approves plans for you">
        <Zap size={14} /> Automation {automation ? 'ON' : 'off'}
      </button>
    </div>
  )
}
