import { useMemo, useState } from 'react'
import { BookOpen, Code2, Eraser, FolderOpen, GitBranch, Image, Inbox, LayoutGrid, Leaf, Map, Pencil, Plus, Search, Settings, Upload, Zap } from 'lucide-react'
import { SHORT_PROVIDER, modelLabel } from '@shared/catalog'
import { ROLE_LABEL, roleTemplate } from '@shared/templates'
import { MASTERMIND_ID, type AgentSpec } from '@shared/types'
import { EMPTY_MAP, api, useStore } from '../state/store'
import { ChatPanel } from '../panels/ChatDock'
import { OrbAvatar } from '../panels/OrbAvatar'
import { PlanGauge, UsagePill } from '../panels/TopBar'
import { PluginIcon } from '../tools/PluginIcon'
import { openTool } from '../tools/ToolsGrid'

type Panel = 'inbox' | 'media' | 'context' | 'git'

const STATUS_WORD = { idle: 'idle', thinking: 'thinking', working: 'working', waiting: 'waiting for you', error: 'error' } as const

/** Switches between the Focus layout and the space Map. */
export function LayoutSwitch({ compact = false }: { compact?: boolean }) {
  const layout = useStore((s) => s.settings?.layout ?? 'focus')
  const set = (l: 'focus' | 'map') => void api().updateSettings({ layout: l })
  return (
    <div className="flex rounded-lg bg-black/40 p-0.5 text-[11px]" data-testid="layout-switch">
      {(['focus', 'map'] as const).map((l) => (
        <button key={l} className={`rounded-md px-2 py-1 font-semibold capitalize ${layout === l ? 'bg-violet-500/30 text-white' : 'text-indigo-300/70 hover:text-indigo-100'}`} onClick={() => set(l)} title={l === 'focus' ? 'Sidebar and one chat' : 'The team as a map in space'} data-testid={`layout-${l}`}>
          {compact ? (l === 'focus' ? 'F' : 'M') : l}
        </button>
      ))}
    </div>
  )
}

/**
 * The Focus layout: everything the team is and has down the left, one conversation in the middle,
 * and the same drawers and tool windows as the Map, docked beside it.
 */
export function FocusShell() {
  const focused = useStore((s) => s.focused)
  const agents = useStore((s) => s.project?.agents ?? [])
  const id = focused && agents.some((a) => a.id === focused) ? focused : MASTERMIND_ID
  return (
    <div
      className="absolute inset-0 flex"
      style={{ background: 'radial-gradient(ellipse at 15% -10%, rgb(124 58 237 / 0.22), transparent 55%), radial-gradient(ellipse at 110% 110%, rgb(8 145 178 / 0.12), transparent 50%), #05060f' }}
      data-testid="focus"
    >
      <Sidebar current={id} />
      <div className="flex min-w-0 flex-1 flex-col">
        <FocusHeader agentId={id} />
        <div className="flex min-h-0 flex-1">
          <ChatPanel key={id} agentId={id} wide />
        </div>
      </div>
    </div>
  )
}

function Sidebar({ current }: { current: string }) {
  const project = useStore((s) => s.project)!
  const sessions = useStore((s) => s.sessions)
  const active = useStore((s) => s.activeSession)
  const status = useStore((s) => s.status)
  const inbox = useStore((s) => s.inbox)
  const plugins = useStore((s) => s.plugins)
  const activeTool = useStore((s) => s.activeTool)
  const panel = useStore((s) => s.panel)
  const ide = useStore((s) => s.ide)
  const manual = useStore((s) => s.manual.count)
  const media = useStore((s) => s.media.length)
  const [q, setQ] = useState('')
  const pending = inbox.filter((i) => i.status === 'pending')
  const match = (s: string) => s.toLowerCase().includes(q.trim().toLowerCase())
  const agents = useMemo(() => [...project.agents].sort((a, b) => (a.id === MASTERMIND_ID ? -1 : b.id === MASTERMIND_ID ? 1 : 0)).filter((a) => match(`${a.name} ${a.role}`)), [project.agents, q]) // eslint-disable-line react-hooks/exhaustive-deps
  const tools = plugins.filter((p) => match(p.manifest.name))
  const set = useStore.getState().set
  const focus = (id: string) => {
    useStore.getState().openChat(id)
    set({ activeTool: null })
  }
  const toggle = (p: Panel) => set({ panel: panel === p ? null : p, ide: ide === 'open' ? 'hidden' : ide, activeTool: null })

  return (
    <div className="flex w-[264px] shrink-0 flex-col border-r border-white/10 bg-black/30 backdrop-blur" data-testid="focus-sidebar">
      <div className="flex items-center gap-2 px-4 pb-2 pt-3">
        <div className="glow-text flex-1 font-display text-sm font-bold tracking-[0.25em]">MULTIMINE</div>
        <LayoutSwitch />
      </div>
      <button className="mx-3 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/5" title={project.dir} onClick={() => void api().pickProject().then((dir) => (dir ? api().openProject(dir) : undefined))} data-testid="focus-project">
        <FolderOpen size={14} className="shrink-0 text-indigo-300" />
        <span className="truncate font-semibold">{project.name}</span>
      </button>
      <div className="mx-3 mt-1 flex items-center gap-1">
        <select className="field !py-1 !text-xs" value={active ?? ''} onChange={(e) => void api().switchSession(e.target.value)} title="Session: the conversations of this team" data-testid="focus-session">
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost shrink-0 !p-1.5" title="New session" onClick={() => void api().newSession()} data-testid="focus-new-session">
          <Plus size={14} />
        </button>
      </div>
      <div className="relative mx-3 mt-2">
        <Search size={12} className="absolute left-2 top-2 text-indigo-300/60" />
        <input className="field !py-1 !pl-6 !text-xs" placeholder="Search agents and tools" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="scroll-thin mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <SectionHead title="Agents" action={() => set({ modal: { kind: 'agent', agent: { ...roleTemplate('custom', ''), name: '' }, isNew: true } })} actionTitle="Create an agent" testId="focus-add-agent" />
        {agents.map((a) => (
          <AgentRow key={a.id} a={a} selected={a.id === current && !activeTool} st={status[a.id]} asks={a.id === MASTERMIND_ID ? pending.length : pending.filter((i) => i.askedBy === a.id).length} onClick={() => focus(a.id)} />
        ))}
        <SectionHead title="Tools" action={() => set({ modal: { kind: 'plugins' } })} actionTitle="Manage tools" icon={<LayoutGrid size={12} />} />
        {tools.map((p) => (
          <button
            key={p.manifest.id}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] ${activeTool === p.manifest.id ? 'bg-violet-500/20 text-white' : 'text-indigo-100/85 hover:bg-white/5'} ${p.enabled ? '' : 'opacity-60'}`}
            onClick={() => (activeTool === p.manifest.id ? set({ activeTool: null }) : openTool(p))}
            data-testid={`focus-tool-${p.manifest.id}`}
          >
            <PluginIcon plugin={p} size={20} />
            <span className="truncate">{p.manifest.name}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-6 gap-0.5 border-t border-white/10 p-2">
        <NavButton icon={<Inbox size={16} />} label={`Inbox${pending.length ? ` (${pending.length})` : ''}`} badge={pending.length} active={panel === 'inbox'} onClick={() => toggle('inbox')} testId="inbox" />
        <NavButton icon={<Code2 size={16} />} label="Code: files, editor, terminal" badge={manual} active={ide === 'open'} onClick={() => set({ ide: ide === 'open' ? 'hidden' : 'open', panel: null, activeTool: null })} testId="code" />
        <NavButton icon={<GitBranch size={16} />} label="Repository: changes, commit, push" active={panel === 'git'} onClick={() => toggle('git')} testId="git" />
        <NavButton icon={<BookOpen size={16} />} label="Context & multimine.md" active={panel === 'context'} onClick={() => toggle('context')} testId="context" />
        <NavButton icon={<Image size={16} />} label={`Media gallery (${media})`} active={panel === 'media'} onClick={() => toggle('media')} testId="media" />
        <NavButton icon={<Settings size={16} />} label="Settings" onClick={() => set({ modal: { kind: 'settings' } })} testId="settings" />
      </div>
    </div>
  )
}

function SectionHead({ title, action, actionTitle, icon, testId }: { title: string; action: () => void; actionTitle: string; icon?: React.ReactNode; testId?: string }) {
  return (
    <div className="mb-1 mt-3 flex items-center px-2">
      <span className="label !mb-0 flex-1">{title}</span>
      <button className="rounded p-0.5 text-indigo-300/70 hover:bg-white/10 hover:text-white" title={actionTitle} onClick={action} data-testid={testId}>
        {icon ?? <Plus size={13} />}
      </button>
    </div>
  )
}

function AgentRow({ a, selected, st, asks, onClick }: { a: AgentSpec; selected: boolean; st?: { status: keyof typeof STATUS_WORD; activity?: string; detail?: string; quiet?: unknown }; asks: number; onClick: () => void }) {
  const busy = st && st.status !== 'idle'
  const line = st?.activity ? `${st.activity}${st.detail ? ` ${st.detail}` : ''}` : STATUS_WORD[st?.status ?? 'idle']
  return (
    <button className={`group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left ${selected ? 'bg-violet-500/20' : 'hover:bg-white/5'}`} onClick={onClick} data-testid={`focus-agent-${a.id}`}>
      <OrbAvatar color={a.color} brain={a.id === MASTERMIND_ID} status={st?.status} size={24} />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13px] ${selected ? 'font-semibold text-white' : 'text-indigo-50'}`}>{a.name}</span>
        <span className={`block truncate text-[10.5px] ${st?.status === 'error' ? 'text-red-300' : st?.status === 'waiting' || st?.quiet ? 'text-amber-300' : busy ? 'text-emerald-300/90' : 'text-indigo-300/50'}`}>{a.terminal ? 'terminal session' : line}</span>
      </span>
      {asks > 0 && <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-bold text-black">{asks}</span>}
    </button>
  )
}

function NavButton({ icon, label, onClick, active, badge, testId }: { icon: React.ReactNode; label: string; onClick: () => void; active?: boolean; badge?: number; testId?: string }) {
  return (
    <button className={`relative flex h-9 items-center justify-center rounded-lg ${active ? 'bg-violet-500/25 text-white' : 'text-indigo-300/80 hover:bg-white/5 hover:text-white'}`} title={label} onClick={onClick} data-testid={testId}>
      {icon}
      {!!badge && <span className="absolute right-0.5 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-400 px-0.5 text-[9px] font-bold text-black">{badge}</span>}
    </button>
  )
}

function FocusHeader({ agentId }: { agentId: string }) {
  const project = useStore((s) => s.project)!
  const agent = useStore((s) => s.project?.agents.find((a) => a.id === agentId))
  const settings = useStore((s) => s.settings)
  const catalog = useStore((s) => s.settings?.catalog ?? EMPTY_MAP)
  const tool = useStore((s) => s.plugins.find((p) => p.manifest.id === s.activeTool))
  const set = useStore.getState().set
  const automation = !!settings?.automation
  if (!agent) return null
  const toggleAutomation = async () => {
    if (!automation && !confirm('Turn on automation?\n\nMastermind will answer agent questions and approve plans on your behalf until you turn it off. git push and destructive commands still wait for you.')) return
    await api().updateSettings({ automation: !automation })
  }
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-4" data-testid="focus-header">
      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <span className="shrink-0 text-indigo-300/70">{project.name}</span>
        <span className="text-indigo-300/40">/</span>
        {tool ? (
          <span className="flex min-w-0 items-center gap-2 font-semibold">
            <PluginIcon plugin={tool} size={18} /> <span className="truncate">{tool.manifest.name}</span>
          </span>
        ) : (
          <>
            <OrbAvatar color={agent.color} brain={agentId === MASTERMIND_ID} size={20} />
            <span className="max-w-[240px] shrink-0 truncate font-display font-bold">{agent.name}</span>
            <span className="hidden min-w-0 truncate text-[11px] text-indigo-300/60 xl:inline">
              {ROLE_LABEL[agent.role]}
              {agent.provider !== 'mock' && ` · ${SHORT_PROVIDER[agent.provider]} ${modelLabel(catalog, agent.provider, agent.model)}`}
            </span>
            <button className="btn btn-ghost !p-1" title="Edit agent" onClick={() => set({ modal: { kind: 'agent', agent, isNew: false } })}>
              <Pencil size={13} />
            </button>
            <button className="btn btn-ghost !p-1" title="Clear this chat (starts a fresh conversation)" onClick={() => confirm(`Clear ${agent.name}'s chat in this session?`) && void api().clearChat(agentId)}>
              <Eraser size={13} />
            </button>
          </>
        )}
      </div>
      <PlanGauge />
      <UsagePill />
      <button className={`btn !px-2 !py-1 ${settings?.economy.enabled ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-100' : ''}`} title="Economy mode: short answers and cheaper models for easy tasks" onClick={() => settings && void api().updateSettings({ economy: { ...settings.economy, enabled: !settings.economy.enabled } })} data-testid="economy">
        <Leaf size={13} />
      </button>
      <button className={`btn !px-2 !py-1 ${automation ? 'automation-on text-white' : ''}`} title={`Automation ${automation ? 'on' : 'off'}: Mastermind answers questions and approves plans for you`} onClick={() => void toggleAutomation()} data-testid="automation">
        <Zap size={13} />
      </button>
      <button className="btn !py-1" title="Review the changes, commit and push" onClick={() => set({ panel: 'git', ide: 'hidden', activeTool: null })} data-testid="focus-commit">
        <Upload size={13} /> Commit & push
      </button>
      <button className="btn !py-1" title="Open the project in VS Code" onClick={() => void api().ideOpenExternal('.', 'code')}>
        <Code2 size={13} /> Open
      </button>
      <button className="btn btn-ghost !p-1.5" title="Map: the team in space" onClick={() => void api().updateSettings({ layout: 'map' })}>
        <Map size={15} />
      </button>
    </div>
  )
}
