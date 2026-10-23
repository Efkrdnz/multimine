import { create } from 'zustand'
import { pushTerminalData } from '../ide/terminalBus'
import type { AgentSpec, AgentStatus, AppSettings, CliStatus, PluginInfo, ChatMessage, InboxItem, MainEvent, MediaItem, ProjectInfo, ProjectTab, RunState, UpdateState, Usage, PlanWindow } from '@shared/types'

export type Panel = 'media' | 'instructions' | 'git' | 'run' | null
export type Modal = { kind: 'chat'; agent: AgentSpec } | { kind: 'settings'; tab?: string } | { kind: 'plugins' } | { kind: 'make-tool'; editId?: string } | null

interface Toast {
  id: number
  level: 'info' | 'error'
  text: string
}

export interface State {
  ready: boolean
  settings: AppSettings | null
  keyed: string[]
  project: ProjectInfo | null
  /** The open projects, as tabs: the one on screen, and what the others are doing. */
  projects: ProjectTab[]
  /** Multimine's own update. */
  update: UpdateState | null
  /** Every chat's messages, by chat id. */
  chats: Record<string, ChatMessage[]>
  status: Record<string, { status: AgentStatus; activity?: string; detail?: string; since?: number; quiet?: string; temp?: { model: string; effort: string; difficulty: string }; fallback?: { provider: string; model: string; reason: string } }>
  /** Providers out of usage (or close to it) right now. */
  health: Record<string, { state: 'near' | 'exhausted'; until: number; reason: string }>
  /** What chats are waiting on the user for: questions, plans, permissions. */
  inbox: InboxItem[]
  media: MediaItem[]
  usage: Usage
  /** Usage per chat. */
  usageByAgent: Record<string, Usage>
  /** The Claude plan's usage windows, as last reported. */
  planLimits: PlanWindow[]
  /** The chat on screen. */
  focused: string | null
  /** Whether Claude Code and Codex are installed and logged in, once asked (the provider menu asks). */
  clis: { claude: CliStatus; codex: CliStatus } | null
  panel: Panel
  /** The code window: mounted once opened (so terminals and tabs survive), shown or hidden. */
  ide: 'closed' | 'open' | 'hidden'
  /** A file the IDE window should open (n tells a repeated request apart). */
  ideRequest: { path: string; line?: number; n: number } | null
  /** A table the Tables tool should show (a chat's table card asked for it). */
  tableRequest: { id: string; n: number } | null
  /** The last table a chat saved, so the Tables tool reloads it. */
  tablesChanged: { id: string; n: number } | null
  /** The run button's current or last run, and its output. */
  run: RunState | null
  runLines: string[]
  /** A problem turned up while the Run panel was closed. */
  runUnseen: boolean
  plugins: PluginInfo[]
  brokenPlugins: { dir: string; errors: string[] }[]
  /** Tool windows opened this run (kept mounted so they keep their state) and the one on screen. */
  openTools: string[]
  activeTool: string | null
  /** A plugin waiting for the user to agree to its permissions, and what to do after. */
  consent: { pluginId: string; thenOpen: boolean; madeBy?: string } | null
  /** How many times each tool was reinstalled this run: its window reloads on a change. */
  pluginReload: Record<string, number>
  modal: Modal
  toasts: Toast[]
  set: (patch: Partial<State>) => void
  /** Puts a chat on screen (closing any tool in front of it). */
  openChat: (id: string) => void
  toast: (level: Toast['level'], text: string) => void
}

let toastId = 0

export const useStore = create<State>((set, get) => ({
  ready: false,
  settings: null,
  keyed: [],
  project: null,
  projects: [],
  update: null,
  chats: {},
  status: {},
  health: {},
  inbox: [],
  media: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  usageByAgent: {},
  planLimits: [],
  focused: null,
  clis: null,
  panel: null,
  ide: 'closed',
  ideRequest: null,
  tableRequest: null,
  tablesChanged: null,
  run: null,
  runLines: [],
  runUnseen: false,
  plugins: [],
  brokenPlugins: [],
  openTools: [],
  activeTool: null,
  consent: null,
  pluginReload: {},
  modal: null,
  toasts: [],
  set: (patch) => set(patch),
  openChat: (id) => {
    set({ focused: id, activeTool: null })
    void window.mm.api.setActiveChat(id)
  },
  toast: (level, text) => {
    const t = { id: ++toastId, level, text }
    set({ toasts: [...get().toasts, t] })
    setTimeout(() => set({ toasts: get().toasts.filter((x) => x.id !== t.id) }), level === 'error' ? 9000 : 4000)
  }
}))

/** Live events a component needs without going through React state (a file changed on disk). */
type Listener = (e: MainEvent) => void
const listeners = new Set<Listener>()
export function onMainEvent(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** The chat each project had on screen, so coming back to a project comes back to it. */
const lastFocus = new Map<string, string>()

/** What belongs to the project on screen and is dropped when another one comes up (it sends its own). */
const PER_PROJECT: Partial<State> = {
  chats: {},
  status: {},
  inbox: [],
  media: [],
  run: null,
  runLines: [],
  runUnseen: false,
  openTools: [],
  activeTool: null,
  panel: null,
  ide: 'closed',
  ideRequest: null,
  tableRequest: null,
  modal: null
}

export function applyEvent(e: MainEvent): void {
  const s = useStore.getState()
  switch (e.type) {
    case 'project': {
      const switched = (s.project?.dir ?? null) !== (e.project?.dir ?? null)
      if (switched && s.project && s.focused) lastFocus.set(s.project.dir, s.focused)
      // the chat on screen stays while it exists; a project coming back brings back its own; otherwise the most recent
      const ids = e.project?.agents.map((a) => a.id) ?? []
      const prefer = switched ? (e.project ? lastFocus.get(e.project.dir) : undefined) : s.focused
      const focused = prefer && ids.includes(prefer) ? prefer : (ids[0] ?? null)
      s.set({ ...(switched ? PER_PROJECT : {}), project: e.project, focused })
      if (focused !== s.focused || switched) void window.mm.api.setActiveChat(focused)
      break
    }
    case 'projects':
      s.set({ projects: e.projects })
      break
    case 'update':
      s.set({ update: e.state })
      break
    case 'chat-reset':
      s.set({ chats: e.chats })
      break
    case 'chat-upsert': {
      const list = [...(s.chats[e.message.agentId] ?? [])]
      const i = list.findIndex((m) => m.id === e.message.id)
      if (i >= 0) list[i] = e.message
      else list.push(e.message)
      s.set({ chats: { ...s.chats, [e.message.agentId]: list } })
      break
    }
    case 'status':
      s.set({ status: { ...s.status, [e.agentId]: { status: e.status, activity: e.activity, detail: e.detail, since: e.since, quiet: e.quiet, temp: e.temp, fallback: e.fallback } } })
      break
    case 'inbox':
      s.set({ inbox: e.items })
      break
    case 'media':
      s.set({ media: e.items })
      break
    case 'settings':
      s.set({ settings: e.settings })
      break
    case 'usage':
      s.set({ usage: e.total, usageByAgent: e.byAgent ?? {} })
      break
    case 'toast':
      s.toast(e.level, e.text)
      break
    case 'plan-limits':
      s.set({ planLimits: e.windows })
      break
    case 'ide-open':
      // the code window takes the left side as the rail's own button does; the tool stays open behind it
      s.set({ ide: 'open', panel: null, activeTool: null, ideRequest: { path: e.path, line: e.line, n: (s.ideRequest?.n ?? 0) + 1 } })
      break
    case 'reveal': {
      // a notification from a project in another tab: bring that project up first
      if (e.dir && e.dir !== s.project?.dir) {
        void window.mm.api.switchProject(e.dir).then(() => applyEvent({ ...e, dir: undefined })).catch(() => undefined)
        break
      }
      if (e.panel === 'run') {
        s.set({ panel: 'run', activeTool: null, ide: s.ide === 'open' ? 'hidden' : s.ide, runUnseen: false })
        break
      }
      // a clicked notification: the chat that asked comes up, with its question in view
      const item = e.itemId ? s.inbox.find((x) => x.id === e.itemId) : undefined
      const id = item?.askedBy ?? e.agentId
      if (id && s.project?.agents.some((a) => a.id === id)) s.openChat(id)
      break
    }
    case 'terminal-data':
      pushTerminalData(e.id, e.data)
      return
    case 'plugins':
      s.set({ plugins: e.plugins, brokenPlugins: e.broken })
      break
    case 'plugin-installed': {
      // the plugins event (with the new tool) has just arrived; a tool already allowed everything it asks for just reloads
      const p = s.plugins.find((x) => x.manifest.id === e.id)
      if (!p) break
      if (p.enabled && !p.pending.length) {
        s.set({
          pluginReload: { ...s.pluginReload, [e.id]: (s.pluginReload[e.id] ?? 0) + 1 },
          openTools: s.openTools.includes(e.id) ? s.openTools : [...s.openTools, e.id],
          activeTool: e.id,
          panel: null,
          ide: s.ide === 'open' ? 'hidden' : s.ide
        })
        s.toast('info', `${p.manifest.name} was updated`)
      } else s.set({ consent: { pluginId: e.id, thenOpen: true, madeBy: e.chatId } })
      break
    }
    case 'tables-changed':
      s.set({ tablesChanged: { id: e.id, n: (s.tablesChanged?.n ?? 0) + 1 } })
      break
    case 'run': {
      const more = e.state.problems.length > (s.run?.problems.length ?? 0) && e.state.startedAt === s.run?.startedAt
      s.set({ run: e.state, ...(more && s.panel !== 'run' ? { runUnseen: true } : {}) })
      break
    }
    case 'run-output': {
      if (e.reset) {
        s.set({ runLines: e.lines })
        break
      }
      const next = s.runLines.concat(e.lines)
      s.set({ runLines: next.length > 5000 ? next.slice(-5000) : next })
      break
    }
    case 'provider-health':
      s.set({ health: e.health })
      break
  }
  for (const l of listeners) l(e)
}

export const api = () => window.mm.api

/** Stable empties for selectors: a fresh [] or {} per call makes zustand re-render forever. */
export const EMPTY_LIST: never[] = []
export const EMPTY_MAP: Record<string, never> = {}

/** Where the side sheets (git, media, instructions, code) dock: on the right of the chat. */
export const SIDE_DOCK = 'right-3'
