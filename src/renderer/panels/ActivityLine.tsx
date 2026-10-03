import { AlertTriangle, Square } from 'lucide-react'
import { elapsed } from '@shared/activity'
import { api, useStore } from '../state/store'
import { useNow } from '../state/useNow'

/**
 * What a busy agent is doing right now, and for how long: "Running gradlew runClient · 4:12".
 * When it has gone quiet the line turns amber, says so, and offers to stop it.
 */
export function ActivityLine({ agentId }: { agentId: string }) {
  const st = useStore((s) => s.status[agentId])
  const busy = st && st.status !== 'idle' && st.status !== 'error'
  const now = useNow(!!busy)
  if (!busy) return null
  const label = st.status === 'waiting' ? st.activity || 'Waiting for you' : st.activity || (st.status === 'thinking' ? 'Thinking' : 'Working')
  return (
    <div className={`my-2 rounded-lg border px-2.5 py-1.5 text-xs ${st.quiet ? 'border-amber-400/40 bg-amber-500/10' : 'border-white/10 bg-black/20'}`} data-testid={`activity-${agentId}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${st.quiet ? 'bg-amber-400' : st.status === 'waiting' ? 'bg-amber-300' : 'animate-pulse bg-emerald-400'}`} />
        <span className="font-semibold text-indigo-100">{label}</span>
        {st.detail && <span className="min-w-0 flex-1 truncate font-mono text-indigo-300/80">{st.detail}</span>}
        {!st.detail && <span className="flex-1" />}
        {st.since && <span className="shrink-0 font-mono text-indigo-300/80" data-testid="activity-clock">{elapsed(now - st.since)}</span>}
      </div>
      {st.status === 'waiting' && (
        <div className="mt-1 text-[11px] text-amber-100/80">Waiting for you: answer in the balloon over its orb, or in the Inbox.</div>
      )}
      {st.quiet && (
        <div className="mt-1 flex items-start gap-1.5 text-amber-100/90">
          <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-300" />
          <span className="flex-1">{st.quiet}</span>
          <button className="btn btn-danger !px-2 !py-0.5 text-[11px]" onClick={() => void api().stop(agentId)}>
            <Square size={11} /> Stop
          </button>
        </div>
      )}
    </div>
  )
}
