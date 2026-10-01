import { useEffect, useRef, useState } from 'react'
import { Columns2, Eraser, Pencil, Send, Square, X } from 'lucide-react'
import { SHORT_PROVIDER, modelLabel } from '@shared/catalog'
import { ROLE_LABEL } from '@shared/templates'
import { MASTERMIND_ID } from '@shared/types'
import { EMPTY_LIST, EMPTY_MAP, api, useStore } from '../state/store'
import { MessageView } from './MessageView'
import { OrbAvatar } from './OrbAvatar'

const STATUS_TEXT = { idle: 'idle', thinking: 'thinking', working: 'working', waiting: 'waiting for you', error: 'error' }

function ChatPanel({ agentId }: { agentId: string }) {
  const agent = useStore((s) => s.project?.agents.find((a) => a.id === agentId))
  const messages = useStore((s) => s.chats[agentId] ?? EMPTY_LIST)
  const st = useStore((s) => s.status[agentId])
  const catalog = useStore((s) => s.settings?.catalog ?? EMPTY_MAP)
  const [draft, setDraft] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const busy = st?.status === 'thinking' || st?.status === 'working' || st?.status === 'waiting' || messages.at(-1)?.streaming

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  if (!agent) return null
  const send = () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void api().send(agentId, text)
  }
  const isMm = agentId === MASTERMIND_ID
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col" data-testid={`chat-${agentId}`}>
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <OrbAvatar color={agent.color} brain={isMm} status={st?.status} size={36} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-[15px] font-bold">{agent.name}</div>
          <div className="truncate text-[11px] text-indigo-300/80">
            {ROLE_LABEL[agent.role]} · {agent.provider === 'mock' ? '' : `${SHORT_PROVIDER[agent.provider]} `}{modelLabel(catalog, agent.provider, agent.model)} · {agent.effort} · <span className={st?.status === 'error' ? 'text-red-300' : st?.status === 'waiting' ? 'text-amber-300' : ''}>{st?.activity || STATUS_TEXT[st?.status ?? 'idle']}</span>
          </div>
        </div>
        <button className="btn btn-ghost !p-1.5" title="Edit agent" onClick={() => useStore.getState().set({ modal: { kind: 'agent', agent, isNew: false } })}>
          <Pencil size={15} />
        </button>
        <button className="btn btn-ghost !p-1.5" title="Clear this chat (starts a fresh conversation)" onClick={() => confirm(`Clear ${agent.name}'s chat in this session?`) && void api().clearChat(agentId)}>
          <Eraser size={15} />
        </button>
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto px-4 select-text">
        {messages.length === 0 && (
          <div className="mt-10 text-center text-sm text-indigo-300/60">
            {isMm ? 'Tell Mastermind what you want to build. It will route the work to your team.' : `Chat with ${agent.name} directly.`}
          </div>
        )}
        {messages.map((m, i) => (
          <MessageView key={m.id} m={m} last={i === messages.length - 1 && !busy} />
        ))}
        <div ref={end} className="h-2" />
      </div>
      <div className="border-t border-white/10 p-3">
        <div className="flex items-end gap-2 rounded-xl border border-white/10 bg-black/40 p-2 focus-within:border-violet-400/60">
          <textarea
            className="scroll-thin max-h-48 min-h-[2.4rem] flex-1 resize-none bg-transparent px-1.5 py-1 text-sm outline-none"
            placeholder={isMm ? 'Ask Mastermind...' : `Message ${agent.name}...`}
            value={draft}
            rows={Math.min(8, draft.split('\n').length)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            data-testid="chat-input"
          />
          {busy ? (
            <button className="btn btn-danger !p-2" title="Stop" onClick={() => void api().stop(agentId)}>
              <Square size={15} />
            </button>
          ) : null}
          <button className="btn btn-primary !p-2" title="Send (Enter)" onClick={send} data-testid="chat-send">
            <Send size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}

export function ChatDock() {
  const open = useStore((s) => s.openChats)
  const focused = useStore((s) => s.focused)
  const split = useStore((s) => s.split)
  const agents = useStore((s) => s.project?.agents ?? EMPTY_LIST)
  const status = useStore((s) => s.status)
  const { set, closeChat } = useStore.getState()
  if (!open.length) return null
  const primary = focused && open.includes(focused) ? focused : open[open.length - 1]
  const secondary = split ? open.filter((x) => x !== primary).at(-1) : undefined
  return (
    <div data-chat-dock className={`glass absolute bottom-3 right-3 top-16 z-20 flex flex-col rounded-2xl ${secondary ? 'w-[min(1040px,calc(100vw-120px))]' : 'w-[min(520px,calc(100vw-120px))]'}`}>
      <div className="flex items-center gap-1 overflow-x-auto border-b border-white/10 px-2 pt-2 scroll-thin">
        {open.map((id) => {
          const a = agents.find((x) => x.id === id)
          if (!a) return null
          const on = id === primary || id === secondary
          return (
            <div key={id} className={`flex shrink-0 items-center gap-1.5 rounded-t-lg px-2.5 py-1.5 text-xs ${on ? 'bg-white/10 text-white' : 'text-indigo-300 hover:bg-white/5'}`}>
              <button className="flex items-center gap-1.5" onClick={() => set({ focused: id })}>
                <OrbAvatar color={a.color} size={16} brain={id === MASTERMIND_ID} status={status[id]?.status} />
                {a.name}
              </button>
              <button className="opacity-60 hover:opacity-100" onClick={() => closeChat(id)}>
                <X size={12} />
              </button>
            </div>
          )
        })}
        <div className="flex-1" />
        <button className={`btn btn-ghost !p-1.5 ${split ? 'text-violet-300' : ''}`} title="Split view: two chats side by side" onClick={() => set({ split: !split })} disabled={open.length < 2}>
          <Columns2 size={15} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 divide-x divide-white/10">
        <ChatPanel key={primary} agentId={primary} />
        {secondary && <ChatPanel key={secondary} agentId={secondary} />}
      </div>
    </div>
  )
}
