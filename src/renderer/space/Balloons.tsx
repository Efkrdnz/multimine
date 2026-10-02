import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { Check, MessageCircleQuestion, ShieldAlert, X } from 'lucide-react'
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
              {first.permission ? (
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
