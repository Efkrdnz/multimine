import { useEffect, useState } from 'react'
import type { PluginCall } from './pluginApi'

/** A chat as the plugin API lists it. */
export interface ChatChoice {
  id: string
  name: string
  provider: string
  model: string
  mcp: string[]
  busy: boolean
  active: boolean
}

/** The project's chats, kept fresh while the tool is open (a chat started elsewhere shows up). */
export function useChats(call: PluginCall): ChatChoice[] {
  const [chats, setChats] = useState<ChatChoice[]>([])
  useEffect(() => {
    let live = true
    const load = () =>
      void call<ChatChoice[]>('chats.list')
        .then((c) => live && setChats(c))
        .catch(() => undefined)
    load()
    const t = setInterval(load, 3000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [call])
  return chats
}

/**
 * Where a tool's work goes: a new chat (the default for builds, so a long job does not clutter
 * the conversation on screen) or any existing one. A chat that no longer exists reads as new.
 */
export function ChatTarget({ chats, value, onChange, testId, className = '' }: { chats: ChatChoice[]; value: string; onChange: (to: string) => void; testId?: string; className?: string }) {
  const known = value === 'new' || value === 'active' || chats.some((c) => c.id === value)
  return (
    <select className={`field !w-auto !py-1 !text-xs ${className}`} value={known ? value : 'new'} onChange={(e) => onChange(e.target.value)} title="Which chat does the work" data-testid={testId}>
      <option value="new">A new chat</option>
      {chats.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
          {c.active ? ' (on screen)' : ''}
          {c.busy ? ' - working' : ''}
        </option>
      ))}
    </select>
  )
}

/** What a send call resolves to. */
export type Sent = { chatId: string }

/** A short name for where something went, for a toast. */
export function chatLabel(chats: ChatChoice[], to: string, sent?: Sent): string {
  if (to === 'new') return 'a new chat'
  return `"${chats.find((c) => c.id === (sent?.chatId ?? to))?.name ?? 'the chat'}"`
}
