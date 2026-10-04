import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Code2, Eraser, FolderOpen, GitBranch, Image, LayoutGrid, Leaf, RotateCcw, Search, Settings, SlidersHorizontal, SquarePen, Trash2, Upload } from 'lucide-react'
import { SHORT_PROVIDER, modelLabel } from '@shared/catalog'
import { PROVIDER_COLOR } from '@shared/chat'
import type { AgentSpec, AgentStatus } from '@shared/types'
import { EMPTY_MAP, api, useStore } from '../state/store'
import { ChatPanel } from '../panels/ChatPanel'
import { OrbAvatar } from '../panels/OrbAvatar'
import { PlanGauge, UsagePill } from '../panels/Gauges'
import { PluginIcon } from '../tools/PluginIcon'
import { openTool } from '../tools/openTool'

type Panel = 'media' | 'instructions' | 'git'

const STATUS_WORD: Record<AgentStatus, string> = { idle: 'idle', thinking: 'thinking', working: 'working', waiting: 'waiting for you', error: 'error' }

/** A new chat on the defaults, put on screen. */
export async function startChat(): Promise<void> {
  const chat = await api().createChat()
  useStore.getState().openChat(chat.id)
}

/**
 * The window: the project, its chats and its tools down the left; the chat on screen in the
 * middle; tool windows and the side sheets (code, git, media, instructions) docked beside it.
 */
export function Shell() {
  // Ctrl+N: a new chat, as in the Claude apps
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        void startChat()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  const focused = useStore((s) => s.focused)
  const tool = useStore((s) => s.activeTool)
  const chats = useStore((s) => s.project?.agents ?? [])
  const id = focused && chats.some((a) => a.id === focused) ? focused : chats[0]?.id
  // the chat on screen is where a tool's messages to 'active' go: main hears about it whenever it changes
  useEffect(() => {
    if (id && id !== focused) useStore.getState().set({ focused: id })
    void api().setActiveChat(id ?? null)
  }, [id, focused])
  return (
    <div
      className="absolute inset-0 flex"
      style={{ background: 'radial-gradient(ellipse at 15% -10%, rgb(124 58 237 / 0.22), transparent 55%), radial-gradient(ellipse at 110% 110%, rgb(8 145 178 / 0.12), transparent 50%), #05060f' }}
      data-testid="shell"
    >
      <Sidebar current={id} />
      <div className="flex min-w-0 flex-1 flex-col">
        {id && <Header agentId={id} />}
        {/* a tool window covers the chat; hidden, it cannot show through around the window's edges */}
        <div className={`flex min-h-0 flex-1 ${tool ? 'invisible' : ''}`}>{id && <ChatPanel key={id} agentId={id} />}</div>
      </div>
    </div>
  )
}

function Sidebar({ current }: { current?: string }) {
  const project = useStore((s) => s.project)!
  const status = useStore((s) => s.status)
  const inbox = useStore((s) => s.inbox)
  const plugins = useStore((s) => s.plugins)
  const activeTool = useStore((s) => s.activeTool)
  const panel = useStore((s) => s.panel)
  const ide = useStore((s) => s.ide)
  const media = useStore((s) => s.media.length)
  const [q, setQ] = useState('')
  const match = (s: string) => s.toLowerCase().includes(q.trim().toLowerCase())
  const chats = useMemo(() => project.agents.filter((a) => match(a.name)), [project.agents, q]) // eslint-disable-line react-hooks/exhaustive-deps
  const tools = plugins.filter((p) => match(p.manifest.name))
  const set = useStore.getState().set
  const toggle = (p: Panel) => set({ panel: panel === p ? null : p, ide: ide === 'open' ? 'hidden' : ide, activeTool: null })

  return (
    <div className="flex w-[264px] shrink-0 flex-col border-r border-white/10 bg-black/30 backdrop-blur" data-testid="sidebar">
      <div className="px-4 pb-2 pt-3">
        <div className="glow-text font-display text-sm font-bold tracking-[0.25em]">MULTIMINE</div>
      </div>
      <button className="mx-3 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/5" title={`${project.dir}\nOpen another project`} onClick={() => void api().pickProject().then((dir) => (dir ? api().openProject(dir) : undefined))} data-testid="sidebar-project">
        <FolderOpen size={14} className="shrink-0 text-indigo-300" />
        <span className="truncate font-semibold">{project.name}</span>
      </button>
      <button className="btn btn-primary mx-3 mt-2 justify-center !py-1.5" onClick={() => void startChat()} title="A new chat on your default model (Ctrl+N)" data-testid="new-chat">
        <SquarePen size={14} /> New chat
      </button>
      <div className="relative mx-3 mt-2">
        <Search size={12} className="absolute left-2 top-2 text-indigo-300/60" />
        <input className="field !py-1 !pl-6 !text-xs" placeholder="Search chats and tools" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="scroll-thin mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="label mb-1 mt-3 px-2">Chats</div>
        {chats.map((a) => (
          <ChatRow key={a.id} a={a} selected={a.id === current && !activeTool} st={status[a.id]} asks={inbox.filter((i) => i.status === 'pending' && i.askedBy === a.id).length} onClick={() => useStore.getState().openChat(a.id)} />
        ))}
        <div className="mb-1 mt-4 flex items-center px-2">
          <span className="label !mb-0 flex-1">Tools</span>
          <button className="rounded p-0.5 text-indigo-300/70 hover:bg-white/10 hover:text-white" title="Manage tools and plugins" onClick={() => set({ modal: { kind: 'plugins' } })} data-testid="manage-tools">
            <LayoutGrid size={12} />
          </button>
        </div>
        {tools.map((p) => (
          <button
            key={p.manifest.id}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] ${activeTool === p.manifest.id ? 'bg-violet-500/20 text-white' : 'text-indigo-100/85 hover:bg-white/5'} ${p.enabled ? '' : 'opacity-60'}`}
            onClick={() => (activeTool === p.manifest.id ? set({ activeTool: null }) : openTool(p))}
            data-testid={`tool-${p.manifest.id}`}
          >
            <PluginIcon plugin={p} size={20} />
            <span className="truncate">{p.manifest.name}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-0.5 border-t border-white/10 p-2">
        <NavButton icon={<Code2 size={16} />} label="Code: files, editor, terminal" active={ide === 'open'} onClick={() => set({ ide: ide === 'open' ? 'hidden' : 'open', panel: null, activeTool: null })} testId="code" />
        <NavButton icon={<GitBranch size={16} />} label="Repository: changes, commit, push" active={panel === 'git'} onClick={() => toggle('git')} testId="git" />
        <NavButton icon={<BookOpen size={16} />} label="Project instructions (multimine.md)" active={panel === 'instructions'} onClick={() => toggle('instructions')} testId="instructions" />
        <NavButton icon={<Image size={16} />} label={`Media gallery (${media})`} active={panel === 'media'} onClick={() => toggle('media')} testId="media" />
        <NavButton icon={<Settings size={16} />} label="Settings" onClick={() => set({ modal: { kind: 'settings' } })} testId="settings" />
      </div>
    </div>
  )
}

function ChatRow({ a, selected, st, asks, onClick }: { a: AgentSpec; selected: boolean; st?: { status: AgentStatus; activity?: string; detail?: string; quiet?: unknown }; asks: number; onClick: () => void }) {
  const busy = st && st.status !== 'idle'
  const catalog = useStore((s) => s.settings?.catalog ?? EMPTY_MAP)
  const line = st?.activity ? `${st.activity}${st.detail ? ` ${st.detail}` : ''}` : busy ? STATUS_WORD[st.status] : a.provider === 'mock' ? 'Mock (no AI)' : `${SHORT_PROVIDER[a.provider]} ${modelLabel(catalog, a.provider, a.model)}`
  return (
    <div className={`group flex w-full items-center rounded-lg ${selected ? 'bg-violet-500/20' : 'hover:bg-white/5'}`}>
      <button className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left" onClick={onClick} data-testid={`chat-row-${a.id}`}>
        <OrbAvatar color={PROVIDER_COLOR[a.provider]} status={st?.status} size={22} />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[13px] ${selected ? 'font-semibold text-white' : 'text-indigo-50'}`}>{a.name}</span>
          <span className={`block truncate text-[10.5px] ${st?.status === 'error' ? 'text-red-300' : st?.status === 'waiting' || st?.quiet ? 'text-amber-300' : busy ? 'text-emerald-300/90' : 'text-indigo-300/50'}`}>{line}</span>
        </span>
        {asks > 0 && <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-bold text-black">{asks}</span>}
      </button>
      <button className="mr-1 hidden rounded p-1 text-indigo-300/60 hover:bg-white/10 hover:text-red-300 group-hover:block" title="Delete this chat" onClick={() => confirm(`Delete the chat "${a.name}" and everything said in it?`) && void api().deleteChat(a.id)} data-testid={`chat-row-delete-${a.id}`}>
        <Trash2 size={12} />
      </button>
    </div>
  )
}

function NavButton({ icon, label, onClick, active, testId }: { icon: React.ReactNode; label: string; onClick: () => void; active?: boolean; testId?: string }) {
  return (
    <button className={`relative flex h-9 items-center justify-center rounded-lg ${active ? 'bg-violet-500/25 text-white' : 'text-indigo-300/80 hover:bg-white/5 hover:text-white'}`} title={label} onClick={onClick} data-testid={testId}>
      {icon}
    </button>
  )
}

/** The name of the chat on screen (click to rename), what runs it, and what can be done with it. */
function Header({ agentId }: { agentId: string }) {
  const project = useStore((s) => s.project)!
  const agent = useStore((s) => s.project?.agents.find((a) => a.id === agentId))
  const settings = useStore((s) => s.settings)
  const st = useStore((s) => s.status[agentId])
  const catalog = useStore((s) => s.settings?.catalog ?? EMPTY_MAP)
  const tool = useStore((s) => s.plugins.find((p) => p.manifest.id === s.activeTool))
  const [editing, setEditing] = useState<string | null>(null)
  const set = useStore.getState().set
  if (!agent) return null
  const rename = () => {
    const name = editing?.trim()
    setEditing(null)
    if (name && name !== agent.name) void api().saveChat({ ...agent, name })
  }
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-4" data-testid="header">
      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <span className="shrink-0 text-indigo-300/70">{project.name}</span>
        <span className="text-indigo-300/40">/</span>
        {tool ? (
          <span className="flex min-w-0 items-center gap-2 font-semibold">
            <PluginIcon plugin={tool} size={18} /> <span className="truncate">{tool.manifest.name}</span>
          </span>
        ) : (
          <>
            {editing !== null ? (
              <input className="field !w-64 !py-0.5 font-display font-bold" value={editing} autoFocus onChange={(e) => setEditing(e.target.value)} onBlur={rename} onKeyDown={(e) => (e.key === 'Enter' ? rename() : e.key === 'Escape' ? setEditing(null) : undefined)} data-testid="chat-name-input" />
            ) : (
              <button className="max-w-[280px] shrink-0 truncate font-display font-bold hover:underline" title="Rename" onClick={() => setEditing(agent.name)} data-testid="chat-name">
                {agent.name}
              </button>
            )}
            <span className="hidden min-w-0 truncate text-[11px] text-indigo-300/60 xl:inline">
              {st?.fallback ? (
                <span className="rounded bg-sky-400/20 px-1 font-semibold text-sky-200" title={`${st.fallback.reason}. Back to ${modelLabel(catalog, agent.provider, agent.model)} when it is available again.`}>
                  ↪ {SHORT_PROVIDER[st.fallback.provider as keyof typeof SHORT_PROVIDER]} {modelLabel(catalog, st.fallback.provider as typeof agent.provider, st.fallback.model)} (fallback)
                </span>
              ) : st?.temp ? (
                <span className="rounded bg-amber-400/20 px-1 font-semibold text-amber-200" title={`This message runs on a cheaper model; the chat goes back to ${modelLabel(catalog, agent.provider, agent.model)} · ${agent.effort} afterwards.`}>
                  ⚡ {modelLabel(catalog, agent.provider, st.temp.model)} · {st.temp.effort} (this message)
                </span>
              ) : agent.provider === 'mock' ? (
                'Mock (no AI)'
              ) : (
                `${SHORT_PROVIDER[agent.provider]} ${modelLabel(catalog, agent.provider, agent.model)}`
              )}
            </span>
            <button className="btn btn-ghost !p-1" title="Chat settings: provider, permissions, MCP servers, fallbacks" onClick={() => set({ modal: { kind: 'chat', agent } })} data-testid="chat-settings">
              <SlidersHorizontal size={13} />
            </button>
            <button className="btn btn-ghost !p-1" title="New conversation: the messages stay, the agent starts clean with a short recap" onClick={() => void api().freshStart(agentId)} data-testid="fresh-start">
              <RotateCcw size={13} />
            </button>
            <button className="btn btn-ghost !p-1" title="Clear this chat (deletes its messages and starts a fresh conversation)" onClick={() => confirm(`Clear the messages in "${agent.name}"?`) && void api().clearChat(agentId)} data-testid="clear-chat">
              <Eraser size={13} />
            </button>
          </>
        )}
      </div>
      <PlanGauge />
      <UsagePill />
      <button className={`btn !px-2 !py-1 ${settings?.economy.enabled ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-100' : ''}`} title="Economy mode: short answers (and, if switched on in Settings, easy messages on a cheaper model)" onClick={() => settings && void api().updateSettings({ economy: { ...settings.economy, enabled: !settings.economy.enabled } })} data-testid="economy">
        <Leaf size={13} />
      </button>
      <button className="btn !py-1" title="Review the changes, commit and push" onClick={() => set({ panel: 'git', ide: 'hidden', activeTool: null })} data-testid="commit">
        <Upload size={13} /> Commit & push
      </button>
      <button className="btn !py-1" title="Open the project in VS Code" onClick={() => void api().ideOpenExternal('.', 'code')}>
        <Code2 size={13} /> Open
      </button>
    </div>
  )
}
