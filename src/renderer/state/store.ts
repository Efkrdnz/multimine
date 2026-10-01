import { create } from 'zustand'
import type {
  AgentSpec,
  AgentStatus,
  AppSettings,
  BusEvent,
  ChatMessage,
  CouncilCritic,
  InboxItem,
  MainEvent,
  MediaItem,
  ProjectInfo,
  SessionMeta,
  Usage
} from '@shared/types'

export type Panel = 'inbox' | 'media' | 'context' | null
export type Modal = { kind: 'agent'; agent: AgentSpec; isNew: boolean } | { kind: 'settings'; tab?: string } | null

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
  sessions: SessionMeta[]
  activeSession: string | null
  chats: Record<string, ChatMessage[]>
  status: Record<string, { status: AgentStatus; activity?: string }>
  bus: BusEvent[]
  inbox: InboxItem[]
  media: MediaItem[]
  council: CouncilCritic[]
  usage: Usage
  openChats: string[]
  focused: string | null
  split: boolean
  panel: Panel
  modal: Modal
  toasts: Toast[]
  set: (patch: Partial<State>) => void
  openChat: (id: string) => void
  closeChat: (id: string) => void
  toast: (level: Toast['level'], text: string) => void
}

let toastId = 0

export const useStore = create<State>((set, get) => ({
  ready: false,
  settings: null,
  keyed: [],
  project: null,
  sessions: [],
  activeSession: null,
  chats: {},
  status: {},
  bus: [],
  inbox: [],
  media: [],
  council: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  openChats: [],
  focused: null,
  split: false,
  panel: null,
  modal: null,
  toasts: [],
  set: (patch) => set(patch),
  openChat: (id) => {
    const open = get().openChats.includes(id) ? get().openChats : [...get().openChats, id]
    set({ openChats: open, focused: id })
  },
  closeChat: (id) => {
    const open = get().openChats.filter((x) => x !== id)
    set({ openChats: open, focused: get().focused === id ? (open.at(-1) ?? null) : get().focused })
  },
  toast: (level, text) => {
    const t = { id: ++toastId, level, text }
    set({ toasts: [...get().toasts, t] })
    setTimeout(() => set({ toasts: get().toasts.filter((x) => x.id !== t.id) }), level === 'error' ? 9000 : 4000)
  }
}))

/** Live events the space scene animates (bus packets, talking mouths) without going through React. */
type Listener = (e: MainEvent) => void
const sceneListeners = new Set<Listener>()
export function onSceneEvent(l: Listener): () => void {
  sceneListeners.add(l)
  return () => sceneListeners.delete(l)
}

export function applyEvent(e: MainEvent): void {
  const s = useStore.getState()
  switch (e.type) {
    case 'project': {
      const ids = new Set(e.project?.agents.map((a) => a.id) ?? [])
      s.set({ project: e.project, openChats: e.project ? s.openChats.filter((id) => ids.has(id)) : [] })
      break
    }
    case 'sessions':
      s.set({ sessions: e.sessions, activeSession: e.active })
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
      s.set({ status: { ...s.status, [e.agentId]: { status: e.status, activity: e.activity } } })
      break
    case 'bus':
      s.set({ bus: [...s.bus.slice(-300), e.event] })
      break
    case 'bus-reset':
      s.set({ bus: e.events.slice(-300) })
      break
    case 'inbox':
      s.set({ inbox: e.items })
      break
    case 'media':
      s.set({ media: e.items })
      break
    case 'council':
      s.set({ council: e.critics })
      break
    case 'settings':
      s.set({ settings: e.settings })
      break
    case 'usage':
      s.set({ usage: e.total })
      break
    case 'toast':
      s.toast(e.level, e.text)
      break
    case 'talk':
      break
  }
  for (const l of sceneListeners) l(e)
}

export const api = () => window.mm.api

/** Stable empties for selectors: a fresh [] or {} per call makes zustand re-render forever. */
export const EMPTY_LIST: never[] = []
export const EMPTY_MAP: Record<string, never> = {}
