import { useEffect, useRef, useState } from 'react'
import { FolderOpen, FolderPlus, Loader2, Play, Plus, X } from 'lucide-react'
import type { ProjectTab } from '@shared/types'
import { EMPTY_LIST, api, useStore } from '../state/store'

const errorText = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Opens a project in a new tab: a folder picked now, or one given. */
export async function openProjectTab(dir?: string | null): Promise<void> {
  const target = dir ?? (await api().pickProject())
  if (target) await api().openProject(target).catch((e) => useStore.getState().toast('error', errorText(e)))
}

/** Closes a project's tab, asking first when its chats or game are still going. */
export async function closeProjectTab(p: ProjectTab): Promise<void> {
  const going = [p.busy ? `${p.busy} chat${p.busy > 1 ? 's are' : ' is'} working` : '', p.running ? 'its game is running' : ''].filter(Boolean).join(' and ')
  if (going && !confirm(`Close ${p.name}? ${going[0].toUpperCase()}${going.slice(1)}; closing stops ${p.busy && p.running ? 'them' : 'it'}.`)) return
  await api().closeProject(p.dir).catch((e) => useStore.getState().toast('error', errorText(e)))
}

/** What a tab's project is doing, in a few words, for its tooltip. */
function doing(p: ProjectTab): string {
  const parts = [p.busy ? `${p.busy} chat${p.busy > 1 ? 's' : ''} working` : '', p.waiting ? `${p.waiting} waiting for you` : '', p.running ? 'game running' : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'idle'
}

function Tab({ p }: { p: ProjectTab }) {
  return (
    <div
      className={`row group relative flex h-8 min-w-0 max-w-[220px] shrink items-center gap-2 rounded-t-xl border border-b-0 pl-3 pr-1.5 text-[12.5px] ${p.active ? 'z-10 -mb-px border-white/12 bg-[#0c0e24] text-white shadow-[0_-6px_20px_-12px_rgba(139,92,246,0.8)]' : 'border-transparent text-indigo-300/75 hover:bg-white/[0.04] hover:text-indigo-100'}`}
      title={`${p.dir}\n${doing(p)}`}
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
      onAuxClick={(e) => e.button === 1 && void closeProjectTab(p)}
      data-testid={`project-tab-${p.name}`}
      data-active={p.active ? '' : undefined}
    >
      {p.active && <span className="absolute inset-x-3 top-0 h-[2px] rounded-full bg-gradient-to-r from-fuchsia-400 via-violet-400 to-cyan-300" />}
      <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => !p.active && void api().switchProject(p.dir)} data-testid={`project-tab-open-${p.name}`}>
        {p.busy ? <Loader2 size={13} className="shrink-0 animate-spin text-emerald-300" /> : <FolderOpen size={13} className={`shrink-0 ${p.active ? 'text-violet-300' : 'text-indigo-300/60'}`} />}
        <span className={`truncate ${p.active ? 'font-semibold' : ''}`}>{p.name}</span>
        {p.waiting > 0 && (
          <span className="pop flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-bold text-black" title={`${p.waiting} waiting for you`} data-testid={`project-tab-waiting-${p.name}`}>
            {p.waiting}
          </span>
        )}
        {p.running && <Play size={10} className="shrink-0 fill-emerald-400 text-emerald-400" aria-label="game running" />}
      </button>
      <button className={`shrink-0 rounded-md p-0.5 text-indigo-300/60 hover:bg-white/10 hover:text-white ${p.active ? '' : 'opacity-0 group-hover:opacity-100'}`} title="Close this project" onClick={() => void closeProjectTab(p)} data-testid={`project-tab-close-${p.name}`}>
        <X size={12} />
      </button>
    </div>
  )
}

/**
 * The open projects, as tabs across the top: one on screen, the others still working (a spinner
 * while a chat works, a count when one waits for you, a play mark while its game runs).
 */
export function ProjectTabs() {
  const projects = useStore((s) => s.projects)
  const recent = useStore((s) => s.settings?.recentProjects ?? EMPTY_LIST)
  const [menu, setMenu] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setMenu(false)
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [menu])
  const closed = recent.filter((d) => !projects.some((p) => p.dir === d))
  return (
    <div className="flex h-10 shrink-0 items-end gap-0.5 border-b border-white/12 bg-black/45 pl-4 pr-2" data-testid="project-tabs">
      <div className="glow-text mb-2.5 mr-4 shrink-0 font-display text-[11px] font-bold tracking-[0.28em]">MULTIMINE</div>
      {projects.map((p) => (
        <Tab key={p.dir} p={p} />
      ))}
      <div className="relative mb-1 ml-1" ref={box}>
        <button className={`flex h-7 w-7 items-center justify-center rounded-lg text-indigo-300/70 transition hover:bg-white/10 hover:text-white ${menu ? 'bg-white/10 text-white' : ''}`} title="Open another project in a new tab" onClick={() => (closed.length ? setMenu(!menu) : void openProjectTab())} data-testid="project-tab-add">
          <Plus size={15} />
        </button>
        {menu && (
          <div className="glass menu-pop absolute left-0 top-full z-50 mt-1 w-[320px] origin-top-left rounded-xl p-1" style={{ background: 'rgb(10 12 28 / 0.97)' }} data-testid="project-tab-menu">
            <button className="row flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] font-semibold text-indigo-50 hover:bg-white/5" onClick={() => (setMenu(false), void openProjectTab())}>
              <FolderPlus size={14} className="text-violet-300" /> Open a folder...
            </button>
            <div className="px-2.5 pb-0.5 pt-2 text-[9.5px] font-bold uppercase tracking-[0.14em] text-indigo-300/50">Recent</div>
            {closed.map((d) => (
              <button key={d} className="row flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-white/5" title={d} onClick={() => (setMenu(false), void openProjectTab(d))}>
                <FolderOpen size={13} className="shrink-0 text-indigo-300/60" />
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] text-indigo-50">{d.split(/[\\/]/).filter(Boolean).pop()}</span>
                  <span className="block truncate font-mono text-[10px] text-indigo-300/50">{d}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
