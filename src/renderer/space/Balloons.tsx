import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Check, MessageCircleQuestion, PauseCircle, Play, Send, ShieldAlert, Square, X } from 'lucide-react'
import type { InboxItem } from '@shared/types'
import { api, useStore } from '../state/store'
import type { SpaceStage } from './SpaceStage'

/**
 * Speech balloons over the agents that are waiting on you. A permission (a command, a push) is
 * answered right here; a question or a plan opens the inbox. They follow their orb every frame.
 */
export function Balloons({ stage }: { stage: RefObject<SpaceStage | null> }) {
  const inbox = useStore((s) => s.inbox)
  const agents = useStore((s) => s.project?.agents)
  const nodes = useRef(new Map<string, HTMLDivElement>())

  // one balloon per agent: its oldest pending item, with a count of the rest
  const byAgent = useMemo(() => {
    const m = new Map<string, { first: InboxItem; count: number }>()
    for (const it of inbox) {
      if (it.status !== 'pending') continue
      const cur = m.get(it.askedBy)
      if (cur) cur.count++
      else m.set(it.askedBy, { first: it, count: 1 })
    }
    return [...m.entries()]
  }, [inbox])

  useEffect(() => {
    let raf = 0
    const tick = () => {
      for (const [id, el] of nodes.current) {
        const p = stage.current?.screenOf(id)
        if (!p) {
          el.style.display = 'none'
          continue
        }
        el.style.display = ''
        el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y - p.r - 18)}px) translate(-50%, -100%)`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [stage])

  if (!agents) return null
  return (
    <div className="pointer-events-none absolute inset-0 z-[15] overflow-hidden">
      {byAgent.map(([id, { first, count }]) => {
        const agent = agents.find((a) => a.id === id)
        const color = agent?.color ?? '#fbbf24'
        const name = agent?.name ?? id
        return (
          <div
            key={id}
            ref={(el) => {
              if (el) nodes.current.set(id, el)
              else nodes.current.delete(id)
            }}
            className="pointer-events-auto absolute left-0 top-0"
            data-testid={`balloon-${id}`}
          >
            <div className="rise relative max-w-[300px] rounded-2xl border border-amber-300/50 bg-[#1a1408]/92 px-3 py-2 text-xs shadow-[0_0_28px_-4px_rgba(251,191,36,0.55)] backdrop-blur">
              {first.watchdog ? (
                <WatchdogBalloon item={first} name={name} color={color} />
              ) : first.permission ? (
                <>
                  <div className="flex items-start gap-1.5 text-amber-100">
                    <ShieldAlert size={14} className="mt-0.5 shrink-0 text-amber-300" />
                    <span>
                      <b style={{ color }}>{name}:</b> I need permission to <b className="font-mono">{first.title}</b>
                    </span>
                  </div>
                  <div className="mt-2 flex gap-1.5">
                    <button className="btn btn-primary !px-2.5 !py-1 text-[11px]" onClick={() => void api().decide(first.id, true)} data-testid="balloon-allow">
                      <Check size={12} /> Allow
                    </button>
                    {first.alwaysLabel && (
                      <button className="btn !px-2.5 !py-1 text-[11px]" onClick={() => void api().decide(first.id, true, undefined, true)} title={`Allow, and don't ask ${name} again`}>
                        {first.alwaysLabel}
                      </button>
                    )}
                    <button className="btn btn-danger !px-2.5 !py-1 text-[11px]" onClick={() => void api().decide(first.id, false)}>
                      <X size={12} /> Deny
                    </button>
                    <button className="btn btn-ghost !px-2 !py-1 text-[11px] text-amber-200/80" onClick={() => useStore.getState().set({ panel: 'inbox' })}>
                      Details
                    </button>
                  </div>
                </>
              ) : (
                <button className="flex items-start gap-1.5 text-left text-amber-100" onClick={() => useStore.getState().set({ panel: 'inbox' })}>
                  <MessageCircleQuestion size={14} className="mt-0.5 shrink-0 text-amber-300" />
                  <span>
                    <b style={{ color }}>{name}:</b> {first.kind === 'approval' ? 'A plan needs your approval' : 'I have a question for you'} - <u>open</u>
                  </span>
                </button>
              )}
              {count > 1 && <span className="absolute -right-2 -top-2 rounded-full bg-amber-400 px-1.5 text-[10px] font-bold text-amber-950">{count}</span>}
              {/* the tail, pointing down at the orb */}
              <div className="absolute -bottom-[7px] left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-b border-r border-amber-300/50 bg-[#1a1408]" />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The loop guard paused this agent: say what it keeps doing, and let the user let it go on, stop it,
 * or tell it what to do instead (handed to the agent in place of the step it was about to repeat).
 */
function WatchdogBalloon({ item, name, color }: { item: InboxItem; name: string; color: string }) {
  const [telling, setTelling] = useState(false)
  const [note, setNote] = useState('')
  const tell = () => note.trim() && void api().decide(item.id, false, note.trim())
  return (
    <div className="w-[280px]" data-testid="balloon-watchdog">
      <div className="flex items-start gap-1.5 text-amber-100">
        <PauseCircle size={14} className="mt-0.5 shrink-0 text-amber-300" />
        <span>
          <b style={{ color }}>{name}</b> {item.title}. Paused until you decide.
        </span>
      </div>
      {telling ? (
        <div className="mt-2 space-y-1.5">
          <textarea
            autoFocus
            className="field min-h-[54px] !text-[11px]"
            placeholder="e.g. The world doesn't exist - create it first. / Stop testing and report."
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) (e.preventDefault(), tell())
              if (e.key === 'Escape') setTelling(false)
            }}
            data-testid="balloon-tell-input"
          />
          <div className="flex justify-end gap-1.5">
            <button className="btn btn-ghost !px-2 !py-1 text-[11px]" onClick={() => setTelling(false)}>
              Back
            </button>
            <button className="btn btn-primary !px-2.5 !py-1 text-[11px]" disabled={!note.trim()} onClick={tell} data-testid="balloon-tell-send">
              <Send size={12} /> Tell it
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button className="btn btn-primary !px-2.5 !py-1 text-[11px]" onClick={() => setTelling(true)} data-testid="balloon-tell">
            <Send size={12} /> Tell it...
          </button>
          <button className="btn !px-2.5 !py-1 text-[11px]" onClick={() => void api().decide(item.id, true)} title="Let it carry on (the counters reset, a long task gets 15 more minutes)" data-testid="balloon-continue">
            <Play size={12} /> Continue
          </button>
          <button className="btn btn-danger !px-2.5 !py-1 text-[11px]" onClick={() => void api().decide(item.id, false)} title="End the task; it reports back what it did" data-testid="balloon-stop">
            <Square size={12} /> Stop
          </button>
          <button className="btn btn-ghost !px-2 !py-1 text-[11px] text-amber-200/80" onClick={() => useStore.getState().set({ panel: 'inbox' })}>
            Details
          </button>
        </div>
      )}
    </div>
  )
}
