import { ChevronRight, FolderOpen } from 'lucide-react'
import type { ProviderKind } from '@shared/types'
import { EMPTY_LIST, api, useStore } from '../state/store'
import { ProviderMark } from './ProviderMark'
import { UpdatePill } from './UpdatePill'

/** The app's gem (build/icon.svg without its tile), drawn small for the welcome screen. */
function Gem({ size = 64 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="200 260 624 560" aria-hidden className="gem-float drop-shadow-[0_10px_30px_rgb(124_58_237/0.55)]">
      <defs>
        <linearGradient id="gem-a" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#c4b5fd" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
        <linearGradient id="gem-b" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a78bfa" />
          <stop offset="1" stopColor="#6d28d9" />
        </linearGradient>
        <linearGradient id="gem-c" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#67e8f9" />
          <stop offset="1" stopColor="#0891b2" />
        </linearGradient>
        <linearGradient id="gem-d" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#0e7490" />
        </linearGradient>
      </defs>
      <g stroke="#05060f" strokeOpacity="0.35" strokeWidth="6" strokeLinejoin="round">
        <polygon points="352,280 672,280 800,420 224,420" fill="url(#gem-a)" />
        <polygon points="352,280 432,420 224,420" fill="#ddd6fe" />
        <polygon points="512,280 592,420 432,420" fill="#ede9fe" />
        <polygon points="672,280 800,420 592,420" fill="url(#gem-b)" />
        <polygon points="224,420 432,420 512,800" fill="url(#gem-b)" />
        <polygon points="432,420 592,420 512,800" fill="url(#gem-c)" />
        <polygon points="592,420 800,420 512,800" fill="url(#gem-d)" />
      </g>
      <polygon points="380,300 420,300 360,400 320,400" fill="#ffffff" fillOpacity="0.55" />
    </svg>
  )
}

const WORKS_WITH: ProviderKind[] = ['claude-cli', 'codex-cli', 'google', 'openrouter', 'compatible']

export function Welcome() {
  const recent = useStore((s) => s.settings?.recentProjects ?? EMPTY_LIST)
  const open = async (dir?: string | null) => {
    const target = dir ?? (await api().pickProject())
    if (target) await api().openProject(target)
  }
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center">
      <div className="glass modal-in w-[520px] rounded-3xl p-8 text-center">
        <div className="flex justify-center">
          <Gem />
        </div>
        <div className="mt-4 font-display text-4xl font-bold tracking-[0.3em] glow-text">MULTIMINE</div>
        <p className="mt-3 text-sm text-indigo-200/80">Your coding agents - Claude Code, Codex or any API model - in one window, with game-dev tools built in. Open a project folder to start a chat.</p>
        <div className="mt-4 flex items-center justify-center gap-1.5" title="Claude, ChatGPT, Gemini, OpenRouter and local models">
          {WORKS_WITH.map((p) => (
            <ProviderMark key={p} p={p} size={22} />
          ))}
        </div>
        <div className="mt-4 flex justify-center empty:hidden">
          <UpdatePill />
        </div>
        <button className="btn btn-primary mx-auto mt-6 !px-5 !py-2.5 text-sm" onClick={() => void open()} data-testid="open-project">
          <FolderOpen size={16} /> Open project folder
        </button>
        {recent.length > 0 && (
          <div className="mt-7 text-left">
            <div className="label">Recent</div>
            {recent.map((d) => (
              <button key={d} className="row group flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left hover:bg-white/5" onClick={() => void open(d)}>
                <FolderOpen size={14} className="shrink-0 text-indigo-300/70 group-hover:text-violet-200" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-indigo-50">{d.split(/[\\/]/).filter(Boolean).pop()}</span>
                  <span className="block truncate font-mono text-[10.5px] text-indigo-300/55">{d}</span>
                </span>
                <ChevronRight size={14} className="shrink-0 -translate-x-1 text-indigo-300/50 opacity-0 transition duration-200 group-hover:translate-x-0 group-hover:opacity-100" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
