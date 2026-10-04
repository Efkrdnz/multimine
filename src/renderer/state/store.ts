import { create } from 'zustand'
import { pushTerminalData } from '../ide/terminalBus'
import type { AgentSpec, AgentStatus, AppSettings, CliStatus, PluginInfo, ChatMessage, InboxItem, MainEvent, MediaItem, ProjectInfo, Usage, PlanWindow } from '@shared/types'

export type Panel = 'media' | 'instructions' | 'git' | null
export type Modal = { kind: 'chat'; agent: AgentSpec } | { kind: 'settings'; tab?: string } | { kind: 'plugins' } | null

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
  plugins: PluginInfo[]
  brokenPlugins: { dir: string; errors: string[] }[]
  /** Tool windows opened this run (kept mounted so they keep their state) and the one on screen. */
  openTools: string[]
  activeTool: string | null
  /** A plugin waiting for the user to agree to its permissions, and what to do after. */
  consent: { pluginId: string; thenOpen: boolean } | null
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
  plugins: [],
  brokenPlugins: [],
  openTools: [],
  activeTool: null,
  consent: null,
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

export function applyEvent(e: MainEvent): void {
  const s = useStore.getState()
  switch (e.type) {
    case 'project': {
      // the chat on screen stays while it exists; otherwise the most recent one comes up
      const ids = e.project?.agents.map((a) => a.id) ?? []
      const focused = s.focused && ids.includes(s.focused) ? s.focused : (ids[0] ?? null)
      s.set({ project: e.project, focused })
      if (focused !== s.focused) void window.mm.api.setActiveChat(focused)
      break
    }
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
