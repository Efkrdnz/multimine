import { useEffect, useRef, useState } from 'react'
import { Boxes, PenTool, Send, Square, Table2, Workflow, Zap } from 'lucide-react'
import { modelLabel } from '@shared/catalog'
import { PROVIDER_NAME, providerLocked } from '@shared/chat'
import { downshift } from '@shared/economy'
import type { AgentSpec, Effort } from '@shared/types'
import { SUPPORTED_EFFORTS } from '@shared/effort'
import { tokens } from '@shared/usage'
import { EMPTY_LIST, EMPTY_MAP, api, useStore } from '../state/store'
import { ActivityLine } from './ActivityLine'
import { MessageView } from './MessageView'
import { PromptCard } from './PromptCard'
import { ProviderPicker } from './ProviderPicker'

/** How much a chat may do without asking, as the composer offers it. */
type Access = 'read' | 'supervised' | 'full'
const accessOf = (a: AgentSpec): Access => (a.permissions !== 'write' ? 'read' : a.autoApprove ? 'full' : 'supervised')
const ACCESS: Record<Access, { label: string; help: string; patch: Partial<AgentSpec> }> = {
  read: { label: 'Read only', help: 'Reads the project and answers; never edits or runs anything that changes it', patch: { permissions: 'read', autoApprove: false } },
  supervised: { label: 'Supervised', help: 'Asks before every edit and command', patch: { permissions: 'write', autoApprove: false } },
  full: { label: 'Full access', help: 'Edits and runs without asking. Pushing and destructive commands always ask.', patch: { permissions: 'write', autoApprove: true } }
}

const AMBER = 80_000
const RED = 150_000

/** How big the chat's current conversation is: every step it takes reads all of it again. */
function ContextMeter({ agent }: { agent: AgentSpec }) {
  const messages = useStore((s) => s.chats[agent.id] ?? EMPTY_LIST)
  const st = useStore((s) => s.status[agent.id])
  // the latest reply since the last fresh start that says how large the conversation was
  let size = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.fresh) break
    if (m.usage?.context) {
      size = m.usage.context
      break
    }
  }
  if (!size) return null
  const color = size >= RED ? 'text-red-300' : size >= AMBER ? 'text-amber-300' : 'text-indigo-300/60'
  const idle = !st || st.status === 'idle' || st.status === 'error'
  return (
    <span className="ml-auto flex items-center gap-1.5" data-testid="context-meter">
      <span className={`font-mono text-[11px] ${color}`} title={`This conversation is about ${tokens(size)} tokens. Every step reads all of it again${size >= AMBER ? ': starting fresh makes the next steps faster and cheaper' : ''}.`}>
        Context {tokens(size)}
      </span>
      {size >= AMBER && idle && (
        <button className="rounded-md border border-cyan-400/40 px-1.5 py-0.5 text-[10.5px] text-cyan-100 hover:bg-cyan-400/10" onClick={() => void api().freshStart(agent.id)} title="Start a new conversation: the messages stay, the agent starts clean with a short recap" data-testid="start-fresh">
          Start fresh
        </button>
      )}
    </span>
  )
}

const Dot = () => <span className="text-indigo-300/25">·</span>

/**
 * Who the chat talks to, its model, effort and access, saved to it as they change. The provider is
 * picked here until the conversation starts; after that only the model and the rest can change.
 */
function ComposerBar({ agent }: { agent: AgentSpec }) {
  const catalog = useStore((s) => s.settings?.catalog ?? EMPTY_MAP)
  const messages = useStore((s) => s.chats[agent.id] ?? EMPTY_LIST)
  const locked = providerLocked(messages)
  const models = catalog[agent.provider] ?? []
  const list = models.some((m) => m.id === agent.model) ? models : [{ id: agent.model, label: modelLabel(catalog, agent.provider, agent.model) }, ...models]
  const save = (patch: Partial<AgentSpec>) => void api().saveChat({ ...agent, ...patch })
  const pick = 'cursor-pointer rounded-md bg-transparent px-1.5 py-0.5 text-[11px] text-indigo-200/80 outline-none hover:bg-white/5 hover:text-white'
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1 px-1" data-testid="composer-bar">
      <ProviderPicker agent={agent} locked={locked} />
      {agent.provider !== 'mock' && (
        <select className={pick} value={agent.model} onChange={(e) => save({ model: e.target.value })} title="Model" data-testid="composer-model">
          {list.map((m) => (
            <option key={m.id} value={m.id} className="bg-[#0b0d1f]">
              {m.label}
            </option>
          ))}
        </select>
      )}
      <Dot />
      <select className={pick} value={agent.effort} onChange={(e) => save({ effort: e.target.value as Effort })} title="Effort: how hard it thinks (higher is slower and uses more)" data-testid="composer-effort">
        {SUPPORTED_EFFORTS[agent.provider].map((e) => (
          <option key={e} value={e} className="bg-[#0b0d1f]">
            {e[0].toUpperCase() + e.slice(1)} effort
          </option>
        ))}
      </select>
      {agent.permissions !== 'chat' && (
        <>
          <Dot />
          <select className={pick} value={accessOf(agent)} onChange={(e) => save(ACCESS[e.target.value as Access].patch)} title={ACCESS[accessOf(agent)].help} data-testid="composer-access">
            {(Object.keys(ACCESS) as Access[]).map((k) => (
              <option key={k} value={k} className="bg-[#0b0d1f]" title={ACCESS[k].help}>
                {ACCESS[k].label}
              </option>
            ))}
          </select>
        </>
      )}
      {agent.provider === 'claude-cli' && (
        <>
          <Dot />
          <button className={`${pick} ${agent.planMode ? '!text-sky-200' : ''}`} onClick={() => save({ planMode: !agent.planMode })} title="Plan mode: it plans and asks you to approve before it changes anything" data-testid="composer-plan">
            {agent.planMode ? 'Plan mode on' : 'Plan mode off'}
          </button>
        </>
      )}
      <ContextMeter agent={agent} />
    </div>
  )
}

/** A chat with nothing in it yet: what it is, and where to pick who it talks to. */
function EmptyChat({ agent }: { agent: AgentSpec }) {
  const project = useStore((s) => s.project?.name)
  const tools = [
    { icon: <PenTool size={13} />, name: 'UI Sketcher', what: 'draw a screen, have it built' },
    { icon: <Boxes size={13} />, name: 'Asset Board', what: 'art and sound, made and dropped in' },
    { icon: <Workflow size={13} />, name: 'Logic Board', what: 'a mechanic in plain words' },
    { icon: <Table2 size={13} />, name: 'Data Tables', what: 'game data as a spreadsheet' }
  ]
  return (
    <div className="mx-auto mt-[12vh] max-w-[520px] text-center" data-testid="empty-chat">
      <div className="font-display text-2xl font-bold text-white">What are we building{project ? ` in ${project}` : ''}?</div>
      <p className="mt-2 text-sm leading-relaxed text-indigo-200/70">
        Ask about the project or tell it what to do. This chat talks to <b className="text-indigo-50">{PROVIDER_NAME[agent.provider]}</b>
        {agent.provider === 'mock' ? ', an offline stand-in' : ''} - pick Claude, ChatGPT or another provider below before your first message.
      </p>
      <div className="mt-8 grid grid-cols-2 gap-2 text-left">
        {tools.map((t) => (
          <div key={t.name} className="flex items-start gap-2 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2">
            <span className="mt-0.5 text-violet-300/80">{t.icon}</span>
            <span className="min-w-0">
              <span className="block text-[12.5px] text-indigo-50">{t.name}</span>
              <span className="block text-[11px] text-indigo-300/60">{t.what}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2 text-[11px] text-indigo-300/45">Open them from the sidebar; each can send its work to a chat.</div>
    </div>
  )
}

/** What this chat is waiting on the user for, answered right here. */
function InlinePrompts({ agentId }: { agentId: string }) {
  const inbox = useStore((s) => s.inbox)
  const pending = inbox.filter((i) => i.status === 'pending' && i.askedBy === agentId)
  if (!pending.length) return null
  return (
    <div className="scroll-thin max-h-[45vh] space-y-2 overflow-y-auto px-3 pt-3" data-testid="inline-prompts">
      {pending.map((item) => (
        <PromptCard key={item.id} item={item} />
      ))}
    </div>
  )
}

export function ChatPanel({ agentId }: { agentId: string }) {
  const agent = useStore((s) => s.project?.agents.find((a) => a.id === agentId))
  const messages = useStore((s) => s.chats[agentId] ?? EMPTY_LIST)
  const st = useStore((s) => s.status[agentId])
  const settings = useStore((s) => s.settings)
  const [draft, setDraft] = useState('')
  const [quick, setQuick] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const busy = st?.status === 'thinking' || st?.status === 'working' || st?.status === 'waiting' || messages.at(-1)?.streaming

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  if (!agent) return null
  // Quick runs one message on the provider's light tier; it is offered only where that is cheaper
  const light = settings ? downshift(agent, 'light', settings.economy) : null
  const send = () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void api().send(agentId, text, { quick: quick && !!light })
    setQuick(false)
  }
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col" data-chat-panel={agentId} data-testid={`chat-${agentId}`}>
      <div className="scroll-thin flex-1 overflow-y-auto px-4 select-text">
        <div className="mx-auto max-w-[820px] pt-4">
          {messages.length === 0 && <EmptyChat agent={agent} />}
          {messages.map((m, i) => (
            <MessageView key={m.id} m={m} last={i === messages.length - 1 && !busy} />
          ))}
          <ActivityLine agentId={agentId} />
          <div ref={end} className="h-2" />
        </div>
      </div>
      <div className="mx-auto w-full max-w-[860px]">
        <InlinePrompts agentId={agentId} />
      </div>
      <div className="mx-auto w-full max-w-[860px] p-3">
        <div className={`flex items-end gap-2 rounded-xl border bg-black/40 p-2 focus-within:border-violet-400/60 ${quick && light ? 'border-amber-400/50' : 'border-white/10'}`}>
          <textarea
            className="scroll-thin max-h-48 min-h-[2.4rem] flex-1 resize-none bg-transparent px-1.5 py-1 text-sm outline-none"
            placeholder={quick && light ? `Quick: this message runs on ${modelLabel(settings?.catalog ?? {}, agent.provider, light.model)}...` : messages.length ? 'Reply...' : 'Ask about the project, or tell it what to build...'}
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
          {light && (
            <button
              className={`btn !p-2 ${quick ? 'border-amber-400/60 bg-amber-500/20 text-amber-100' : 'btn-ghost text-indigo-300/70'}`}
              title={`Quick: the next message runs on ${modelLabel(settings?.catalog ?? {}, agent.provider, light.model)} · ${light.effort} - cheaper and faster for small things - then the chat goes back to its own model`}
              onClick={() => setQuick(!quick)}
              data-testid="chat-quick"
            >
              <Zap size={15} />
            </button>
          )}
          {busy ? (
            <button className="btn btn-danger !p-2" title="Stop" onClick={() => void api().stop(agentId)} data-testid="chat-stop">
              <Square size={15} />
            </button>
          ) : null}
          <button className="btn btn-primary !p-2" title="Send (Enter)" onClick={send} data-testid="chat-send">
            <Send size={15} />
          </button>
        </div>
        <ComposerBar agent={agent} />
      </div>
    </div>
  )
}
