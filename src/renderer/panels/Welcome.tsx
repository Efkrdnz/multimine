import { FolderOpen } from 'lucide-react'
import { EMPTY_LIST, api, useStore } from '../state/store'

export function Welcome() {
  const recent = useStore((s) => s.settings?.recentProjects ?? EMPTY_LIST)
  const open = async (dir?: string | null) => {
    const target = dir ?? (await api().pickProject())
    if (target) await api().openProject(target)
  }
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center">
      <div className="glass rise w-[520px] rounded-2xl p-8 text-center">
        <div className="font-display text-4xl font-bold tracking-[0.3em] glow-text">MULTIMINE</div>
        <p className="mt-3 text-sm text-indigo-200/80">Your coding agents - Claude Code, Codex or any API model - in one window, with game-dev tools built in. Open a project folder to start a chat.</p>
        <button className="btn btn-primary mx-auto mt-6 !px-5 !py-2.5 text-sm" onClick={() => void open()} data-testid="open-project">
          <FolderOpen size={16} /> Open project folder
        </button>
        {recent.length > 0 && (
          <div className="mt-6 text-left">
            <div className="label">Recent</div>
            {recent.map((d) => (
              <button key={d} className="block w-full truncate rounded-lg px-3 py-2 text-left font-mono text-xs text-indigo-200 hover:bg-white/5" onClick={() => void open(d)}>
                {d}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
