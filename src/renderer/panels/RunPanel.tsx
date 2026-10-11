import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronRight, FileCode, Play, RotateCw, Send, Square, SquareTerminal, XCircle } from 'lucide-react'
import type { Crash } from '@shared/run/crash'
import { duration, elapsed } from '@shared/activity'
import { api, useStore } from '../state/store'
import { useNow } from '../state/useNow'
import { Drawer } from './Drawer'

/** Starts the game with the saved (or suggested) command; with none yet, opens the panel to ask for one. */
export async function startRun(command?: string): Promise<void> {
  const s = useStore.getState()
  try {
    await api().runStart(command)
    if (s.panel !== 'run') s.set({ panel: 'run', ide: s.ide === 'open' ? 'hidden' : s.ide, activeTool: null, runUnseen: false })
  } catch (e) {
    s.set({ panel: 'run', activeTool: null })
    s.toast('error', String((e as Error).message))
  }
}

/** The run's state in a few words: running for how long, or how it ended. */
export function runLine(run: NonNullable<ReturnType<typeof useStore.getState>['run']>, now: number): string {
  if (run.status === 'running') return `Running for ${elapsed(now - (run.startedAt ?? now))}`
  if (run.status === 'idle') return 'Not started'
  const took = run.endedAt && run.startedAt ? ` after ${duration(run.endedAt - run.startedAt)}` : ''
  if (run.stopped) return `Stopped${took}`
  return run.code === 0 ? `Finished${took}` : `Exited with ${run.code != null ? `code ${run.code}` : run.signal}${took}`
}

const KIND: Record<Crash['kind'], string> = { java: 'Java', minecraft: 'Minecraft', godot: 'Godot', python: 'Python', js: 'JavaScript', csharp: 'C#', rust: 'Rust', exit: 'Exit' }

/** The colour of an output line: errors red, warnings amber. */
function tone(l: string): string {
  if (/\b(ERROR|FATAL|SEVERE|Exception|Traceback|panicked)\b|^\s+at\s|^Caused by:|^\s*File "/.test(l)) return 'text-red-200/90'
  if (/\b(WARN|WARNING)\b/.test(l)) return 'text-amber-200/80'
  return 'text-slate-300/90'
}

const Output = memo(function Output({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lines])
  return (
    <pre
      ref={ref}
      className="scroll-thin min-h-0 flex-1 overflow-auto rounded-lg border border-white/10 bg-black/50 p-2 font-mono text-[11px] leading-[1.45] select-text"
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
      data-testid="run-output"
    >
      {lines.length ? lines.map((l, i) => <div key={i} className={tone(l)}>{l || ' '}</div>) : <span className="text-indigo-300/50">The game's output shows here.</span>}
    </pre>
  )
})

function Problem({ p }: { p: Crash }) {
  const [open, setOpen] = useState(false)
  const [to, setTo] = useState('active')
  const chats = useStore((s) => s.project?.agents ?? [])
  const focused = useStore((s) => s.focused)
  const toast = useStore((s) => s.toast)
  const top = p.places?.[0]
  const send = async () => {
    try {
      const id = await api().runSend(p.id, to)
      useStore.getState().openChat(id)
      useStore.getState().set({ panel: null })
      toast('info', `Sent to "${useStore.getState().project?.agents.find((a) => a.id === id)?.name ?? 'the chat'}"`)
    } catch (e) {
      toast('error', String((e as Error).message))
    }
  }
  const openFile = (path: string, line: number) => {
    const s = useStore.getState()
    s.set({ ide: 'open', panel: null, activeTool: null, ideRequest: { path, line, n: (s.ideRequest?.n ?? 0) + 1 } })
  }
  return (
    <div className={`rounded-lg border text-xs ${p.fatal ? 'border-red-400/35 bg-red-950/30' : 'border-amber-300/25 bg-amber-950/20'}`} data-testid="run-problem">
      <div className="flex items-start gap-2 px-2.5 py-2">
        {p.fatal ? <XCircle size={14} className="mt-0.5 shrink-0 text-red-300" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-indigo-300/70">
            {p.fatal ? 'Crash' : 'Error'} · {KIND[p.kind]}
          </div>
          <div className="break-words font-mono text-[11.5px] text-white">{p.title}</div>
          {p.cause && p.cause !== p.title && <div className="mt-0.5 break-words font-mono text-[11px] text-indigo-200/70">caused by {p.cause}</div>}
          {top && (
            <button className="mt-1 flex items-center gap-1 font-mono text-[11px] text-cyan-200 hover:underline" title="Open in the code window" onClick={() => openFile(top.path, top.line)} data-testid="run-problem-place">
              <FileCode size={11} /> {top.path}:{top.line}
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5 border-t border-white/5 px-2.5 py-1.5">
        <button className="flex items-center gap-1 text-[11px] text-indigo-300/80 hover:text-white" onClick={() => setOpen(!open)}>
          <ChevronRight size={11} className={`transition ${open ? 'rotate-90' : ''}`} /> {open ? 'Hide' : 'Trace'}
        </button>
        <span className="flex-1" />
        <select className="field !w-auto !max-w-[180px] !py-0.5 !text-[11px]" value={to} onChange={(e) => setTo(e.target.value)} title="Which chat fixes it" data-testid="run-send-target">
          <option value="active">{`${chats.find((c) => c.id === focused)?.name ?? 'The chat'} (on screen)`}</option>
          <option value="new">A new chat</option>
          {chats
            .filter((c) => c.id !== focused)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
        <button className="btn btn-primary !px-2 !py-0.5 !text-[11px]" title="Send the error, the trace and the code it points at to a chat to fix" onClick={() => void send()} data-testid="run-send">
          <Send size={11} /> Send to chat
        </button>
      </div>
      {open && (
        <div className="border-t border-white/5 p-2">
          {p.places && p.places.length > 1 && (
            <div className="mb-1.5 flex flex-wrap gap-x-3">
              {p.places.slice(1).map((pl) => (
                <button key={`${pl.path}:${pl.line}`} className="font-mono text-[10.5px] text-cyan-200/80 hover:underline" onClick={() => openFile(pl.path, pl.line)}>
                  {pl.path}:{pl.line}
                </button>
              ))}
            </div>
          )}
          <pre className="scroll-thin max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] text-red-100/80 select-text">{p.trace.join('\n')}</pre>
        </div>
      )}
    </div>
  )
}

/**
 * The run button's panel: the command that starts the game, its live output, and every crash or
 * error found in it, each one a click away from a chat with the trace and the code it points at.
 */
export function RunPanel() {
  const run = useStore((s) => s.run)
  const lines = useStore((s) => s.runLines)
  const project = useStore((s) => s.project)
  const [command, setCommand] = useState('')
  const [suggested, setSuggested] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const now = useNow(run?.status === 'running')

  useEffect(() => {
    useStore.getState().set({ runUnseen: false })
    void api()
      .runInfo()
      .then((r) => {
        setSaved(r.command)
        setSuggested(r.suggested)
        setCommand(r.command ?? r.suggested ?? '')
        useStore.getState().set({ run: r.state, runLines: r.lines })
      })
      .catch(() => undefined)
  }, [project?.dir])

  const running = run?.status === 'running'
  const problems = [...(run?.problems ?? [])].reverse()
  const go = () => {
    setSaved(command.trim() || saved)
    void startRun(command)
  }

  return (
    <Drawer title="Run" icon={<SquareTerminal size={16} className="text-emerald-300" />} width="w-[680px]">
      <div className="flex h-full min-h-0 flex-col gap-3" data-testid="run-panel">
        <div>
          <div className="flex gap-2">
            <input
              className="field flex-1 font-mono !text-xs"
              placeholder="The command that starts your game, e.g. ./gradlew runClient"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && go()}
              data-testid="run-command"
            />
            {running ? (
              <>
                <button className="btn !py-1" title="Stop and start again (F5)" onClick={go} data-testid="run-restart">
                  <RotateCw size={13} /> Restart
                </button>
                <button className="btn !py-1 border-red-400/50 bg-red-500/20 text-red-100" title="Stop the game and everything it started (Shift+F5)" onClick={() => void api().runStop()} data-testid="run-stop">
                  <Square size={12} /> Stop
                </button>
              </>
            ) : (
              <button className="btn btn-primary !py-1" disabled={!command.trim()} title="Start the game (F5)" onClick={go} data-testid="run-start">
                <Play size={13} /> Run
              </button>
            )}
          </div>
          <div className="mt-1 text-[11px] text-indigo-300/60">
            {!saved && suggested && command === suggested
              ? 'Suggested for this project. It is saved in .multimine/run.json once you run it.'
              : !saved && !suggested
                ? "Type the command that starts your game: a script, a built .exe, or your engine's command line. It runs in the project folder."
                : 'Runs in the project folder. Crashes and errors in its output show up below.'}
          </div>
        </div>
        {run && run.status !== 'idle' && (
          <div className="flex items-center gap-2 text-xs" data-testid="run-status">
            <span className={`h-2 w-2 rounded-full ${running ? 'animate-pulse bg-emerald-400' : run.code === 0 || run.stopped ? 'bg-indigo-300/50' : 'bg-red-400'}`} />
            <span className="text-indigo-100">{runLine(run, now)}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-indigo-300/50">{run.command}</span>
          </div>
        )}
        {problems.length > 0 && (
          <div className="scroll-thin max-h-[45%] shrink-0 space-y-2 overflow-y-auto">
            {problems.map((p) => (
              <Problem key={p.id} p={p} />
            ))}
          </div>
        )}
        <Output lines={lines} />
      </div>
    </Drawer>
  )
}
