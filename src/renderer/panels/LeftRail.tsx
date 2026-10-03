import { useState } from 'react'
import { BookOpen, Code2, GitBranch, Image, Inbox, LayoutGrid, Plus, Settings, Sparkles } from 'lucide-react'
import { ToolsGrid } from '../tools/ToolsGrid'
import { roleTemplate } from '@shared/templates'
import { useStore } from '../state/store'

function RailButton({ icon, label, active, badge, onClick, testId }: { icon: React.ReactNode; label: string; active?: boolean; badge?: number; onClick: () => void; testId?: string }) {
  return (
    <button
      className={`group relative flex h-11 w-11 items-center justify-center rounded-xl border transition ${active ? 'border-violet-400/60 bg-violet-500/25 text-white' : 'border-white/10 bg-black/30 text-indigo-200 hover:border-violet-400/40 hover:text-white'}`}
      onClick={onClick}
      data-testid={testId}
    >
      {icon}
      {!!badge && <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-400 px-1 text-[11px] font-bold text-amber-950">{badge}</span>}
      <span className="pointer-events-none absolute left-14 whitespace-nowrap rounded-md bg-black/80 px-2 py-1 text-xs opacity-0 transition group-hover:opacity-100">{label}</span>
    </button>
  )
}

export function LeftRail() {
  const panel = useStore((s) => s.panel)
  const pending = useStore((s) => s.inbox.filter((i) => i.status === 'pending').length)
  const media = useStore((s) => s.media.length)
  const set = useStore((s) => s.set)
  const ide = useStore((s) => s.ide)
  const manual = useStore((s) => s.manual.count)
  // the code window and the drawers share the left side: opening one tucks the other away
  const toggle = (p: typeof panel) => set({ panel: panel === p ? null : p, ide: ide === 'open' ? 'hidden' : ide, activeTool: null })
  const toggleIde = () => set({ ide: ide === 'open' ? 'hidden' : 'open', panel: null, activeTool: null })
  const [tools, setTools] = useState(false)
  return (
    <div className="absolute left-3 top-16 z-30 flex flex-col gap-2">
      <RailButton testId="add-agent" icon={<Plus size={20} />} label="Create agent" onClick={() => set({ modal: { kind: 'agent', agent: { ...roleTemplate('custom', ''), name: '' }, isNew: true } })} />
      <RailButton testId="inbox" icon={<Inbox size={18} />} label="Mastermind inbox" active={panel === 'inbox'} badge={pending} onClick={() => toggle('inbox')} />
      <RailButton testId="media" icon={<Image size={18} />} label={`Media gallery (${media})`} active={panel === 'media'} onClick={() => toggle('media')} />
      <RailButton testId="context" icon={<BookOpen size={18} />} label="Context & multimine.md" active={panel === 'context'} onClick={() => toggle('context')} />
      <RailButton testId="code" icon={<Code2 size={18} />} label="Code: files, editor, terminal" active={ide === 'open'} badge={manual} onClick={toggleIde} />
      <RailButton testId="git" icon={<GitBranch size={18} />} label="Repository (git & GitHub)" active={panel === 'git'} onClick={() => toggle('git')} />
      <RailButton testId="open-mastermind" icon={<Sparkles size={18} />} label="Open Mastermind" onClick={() => useStore.getState().openChat('mastermind')} />
      <div className="relative">
        <RailButton testId="tools" icon={<LayoutGrid size={18} />} label="Tools" active={tools} onClick={() => setTools(!tools)} />
        {tools && <ToolsGrid onClose={() => setTools(false)} />}
      </div>
      <RailButton testId="settings" icon={<Settings size={18} />} label="Settings" onClick={() => set({ modal: { kind: 'settings' } })} />
    </div>
  )
}
