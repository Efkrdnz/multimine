import { memo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AlertTriangle, Brain, CheckCircle2, ChevronRight, Loader2, RotateCcw, Wrench, XCircle } from 'lucide-react'
import type { ChatMessage, ToolCallView } from '@shared/types'
import { EMPTY_LIST, api, useStore } from '../state/store'
import { MediaView } from './MediaView'
import { useNow } from '../state/useNow'
import { describeTool, duration, elapsed } from '@shared/activity'

const PLUGINS = [remarkGfm]

/** Markdown is the costly part of a chat; it only re-parses when its text changes. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={PLUGINS}>{text}</ReactMarkdown>
    </div>
  )
})

function show(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function statusIcon(t: ToolCallView, size = 13) {
  return t.status === 'running' ? <Loader2 size={size} className="shrink-0 animate-spin text-emerald-300" /> : t.status === 'error' ? <XCircle size={size} className="shrink-0 text-red-300" /> : <CheckCircle2 size={size} className="shrink-0 text-emerald-300" />
}

/** How long a call has run (ticking while it runs), or took. */
function Took({ t }: { t: ToolCallView }) {
  const now = useNow(t.status === 'running' && !!t.startedAt)
  if (!t.startedAt) return null
  const ms = (t.endedAt ?? now) - t.startedAt
  if (t.status !== 'running' && ms < 1000) return null
  return <span className="shrink-0 font-mono text-[10.5px] text-indigo-300/60">{t.status === 'running' ? elapsed(ms) : duration(ms)}</span>
}

function ToolCard({ t }: { t: ToolCallView }) {
  const [open, setOpen] = useState(false)
  const d = describeTool(t.name, t.input)
  const name = t.name.replace(/^mcp__multimine__/, '').replace(/^mcp__/, '')
  const kids = t.children ?? []
  const latest = kids.at(-1)
  return (
    <div className="my-1 rounded-lg border border-white/10 bg-black/25 text-xs" data-testid="tool-card">
      <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className={`shrink-0 transition ${open ? 'rotate-90' : ''}`} />
        <Wrench size={12} className="shrink-0 text-indigo-300" />
        <span className="shrink-0 font-mono font-semibold text-indigo-100">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-indigo-300/70">{d.brief}</span>
        <Took t={t} />
        {statusIcon(t)}
      </button>
      {(kids.length > 0 || t.progress) && (
        <div className="border-t border-white/5 px-2.5 py-1 text-[11px] text-indigo-300/80" data-testid="tool-steps">
          {t.progress && <div className="truncate italic">{t.progress}</div>}
          {kids.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span>{t.childCount ?? kids.length} steps</span>
              {latest && (
                <span className="min-w-0 truncate">
                  · {t.status === 'running' ? 'now' : 'last'}: {describeTool(latest.name, latest.input).verb} <span className="font-mono">{describeTool(latest.name, latest.input).brief}</span>
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t border-white/10 p-2.5">
          {kids.length > 0 && (
            <div className="space-y-0.5">
              {(t.childCount ?? 0) > kids.length && <div className="text-[10.5px] text-indigo-300/50">... {(t.childCount ?? 0) - kids.length} earlier steps</div>}
              {kids.map((k) => {
                const kd = describeTool(k.name, k.input)
                return (
                  <div key={k.id} className="flex items-center gap-1.5 font-mono text-[11px]">
                    {statusIcon(k, 11)}
                    <span className="shrink-0 text-indigo-100">{kd.verb}</span>
                    <span className="min-w-0 flex-1 truncate text-indigo-300/70">{kd.brief}</span>
                    <Took t={k} />
                  </div>
                )
              })}
            </div>
          )}
          <pre className="scroll-thin max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-indigo-200">{show(t.input)}</pre>
          {t.output !== undefined && <pre className="scroll-thin max-h-72 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 font-mono text-[11px] text-slate-200">{t.output || '(empty)'}</pre>}
        </div>
      )}
    </div>
  )
}

/** One message. Memoised: a streaming reply re-renders itself, not the whole conversation above it. */
export const MessageView = memo(function MessageView({ m, last = false }: { m: ChatMessage; last?: boolean }) {
  const agents = useStore((s) => s.project?.agents ?? EMPTY_LIST)
  const media = useStore((s) => s.media)
  const [thinkOpen, setThinkOpen] = useState(false)
  if (m.role === 'system') return <div className="my-2 text-center text-[11px] italic text-indigo-300/70">{m.text}</div>
  if (m.role === 'user') {
    const sender = m.from === 'user' ? null : agents.find((a) => a.id === m.from)
    return (
      <div className={`my-3 flex ${sender ? 'justify-start' : 'justify-end'}`}>
        <div className={`max-w-[88%] rounded-2xl px-3.5 py-2 ${sender ? 'border border-dashed border-violet-300/30 bg-violet-950/40' : 'bg-gradient-to-br from-indigo-600/70 to-violet-700/70'}`}>
          {sender && <div className="mb-1 text-[10px] font-bold uppercase tracking-wider" style={{ color: sender.color }}>from {sender.name}</div>}
          {sender ? <Markdown text={m.text} /> : <div className="whitespace-pre-wrap text-sm">{m.text}</div>}
        </div>
      </div>
    )
  }
  // media this message's tools produced: the saved path or the source URL shows up in a tool output
  const mine = media.filter((x) => x.agentId === m.agentId && x.ts >= m.ts && m.tools?.some((t) => t.output?.includes(x.path) || t.output?.includes(x.source)))
  return (
    <div className="my-3">
      {m.thinking && (
        <div className="mb-1">
          <button className="flex items-center gap-1.5 text-[11px] text-violet-300/80 hover:text-violet-200" onClick={() => setThinkOpen(!thinkOpen)}>
            <Brain size={12} /> {m.streaming && !m.text ? 'Thinking...' : 'Thoughts'} <ChevronRight size={11} className={`transition ${thinkOpen ? 'rotate-90' : ''}`} />
          </button>
          {thinkOpen && <div className="mt-1 whitespace-pre-wrap border-l-2 border-violet-400/30 pl-3 text-xs italic text-violet-200/70">{m.thinking}</div>}
        </div>
      )}
      {m.tools?.map((t) => <ToolCard key={t.id} t={t} />)}
      {m.text && <Markdown text={m.text} />}
      {mine.map((x) => (
        <div key={x.id} className="my-2">
          <MediaView item={x} compact />
        </div>
      ))}
      {m.streaming && !m.text && !m.tools?.length && !m.thinking && <Loader2 size={16} className="animate-spin text-violet-300" />}
      {m.error && (
        <div className="mt-2 flex gap-2 rounded-lg border border-red-400/30 bg-red-950/40 px-3 py-2 text-xs text-red-100">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span className="flex-1 whitespace-pre-wrap">{m.error}</span>
          {last && m.error !== 'Stopped.' && (
            <button className="btn shrink-0 self-start !py-1" onClick={() => void api().retry(m.agentId)} data-testid="retry">
              <RotateCcw size={12} /> Retry
            </button>
          )}
        </div>
      )}
      {m.usage && !m.streaming && (
        <div className="mt-1 font-mono text-[10px] text-indigo-300/40">
          {m.usage.inputTokens} in · {m.usage.outputTokens} out{m.usage.costUsd ? ` · $${m.usage.costUsd.toFixed(3)}` : ''}
        </div>
      )}
    </div>
  )
})
