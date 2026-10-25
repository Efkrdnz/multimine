import { useEffect, useRef, useState } from 'react'
import { Boxes, Check, ImagePlus, ListChecks, PenTool, Send, Square, Table2, Users, Workflow, Zap } from 'lucide-react'
import { modelLabel, needsKey } from '@shared/catalog'
import { PROVIDER_NAME, providerLocked } from '@shared/chat'
import { downshift } from '@shared/economy'
import type { AgentSpec, Effort, ProviderKind } from '@shared/types'
import { SUPPORTED_EFFORTS } from '@shared/effort'
import { tokens } from '@shared/usage'
import { EMPTY_LIST, EMPTY_MAP, api, useStore } from '../state/store'
import { ActivityLine } from './ActivityLine'
import { MessageView } from './MessageView'
import { PromptCard } from './PromptCard'
import { ProviderPicker, chooseProvider, cliNote, loadClis } from './ProviderPicker'
import { ProviderMark, providerTint } from './ProviderMark'
import { AttachTray, pastedName, prepareImage, type Pending } from './Attachments'
import { newId } from '@shared/ids'

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
  const pick = 'row cursor-pointer rounded-md bg-transparent px-1.5 py-0.5 text-[11px] text-indigo-200/80 outline-none hover:bg-white/5 hover:text-white'
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
      {agent.permissions !== 'chat' && (
        <>
          <Dot />
          <button
            className={`${pick} inline-flex items-center gap-1 ${agent.planMode ? '!text-sky-200' : ''}`}
            onClick={() => save({ planMode: !agent.planMode })}
            title={`Plan mode${agent.planMode ? ' is on' : ''}: every message, it looks first and hands you a plan to approve before it changes anything. For one message only, start it with /plan.`}
            aria-pressed={agent.planMode}
            data-testid="composer-plan"
          >
            <ListChecks size={11} /> {agent.planMode ? 'Plan on' : 'Plan'}
          </button>
        </>
      )}
      <Dot />
      <button
        className={`${pick} inline-flex items-center gap-1 ${agent.coop ? '!text-amber-200' : ''}`}
        onClick={() => save({ coop: !agent.coop })}
        title={`Coop mode${agent.coop ? ' is on' : ''}: it works on it with you, asking you questions in rounds about everything that shapes the result. For one message only, start it with /coop.`}
        aria-pressed={agent.coop}
        data-testid="composer-coop"
      >
        <Users size={11} /> {agent.coop ? 'Coop on' : 'Coop'}
      </button>
      <ContextMeter agent={agent} />
    </div>
  )
}

/** The two subscriptions a new chat is most likely to use, as cards. */
const MAIN: { p: 'claude-cli' | 'codex-cli'; hint: string }[] = [
  { p: 'claude-cli', hint: 'Your Claude plan, through Claude Code' },
  { p: 'codex-cli', hint: 'Your ChatGPT plan, through Codex' }
]
/** The rest, as small chips under them. */
const OTHERS: ProviderKind[] = ['anthropic', 'openai', 'google', 'compatible', 'mock']

/** A chat with nothing in it yet: who it talks to (Claude or ChatGPT, picked right here), and what is around it. */
function EmptyChat({ agent }: { agent: AgentSpec }) {
  const project = useStore((s) => s.project?.name)
  const clis = useStore((s) => s.clis)
  const keyed = useStore((s) => s.keyed)
  useEffect(() => loadClis(), [])
  const tools = [
    { icon: <PenTool size={13} />, name: 'UI Sketcher', what: 'draw a screen, have it built' },
    { icon: <Boxes size={13} />, name: 'Asset Board', what: 'art and sound, made and dropped in' },
    { icon: <Workflow size={13} />, name: 'Logic Board', what: 'a mechanic in plain words' },
    { icon: <Table2 size={13} />, name: 'Tables', what: 'your numbers, linked to the code - try /table' }
  ]
  return (
    <div className="msg-in mx-auto mt-[9vh] max-w-[560px] text-center" data-testid="empty-chat">
      <div className="font-display text-2xl font-bold text-white">What are we building{project ? ` in ${project}` : ''}?</div>
      <p className="mt-2 text-sm leading-relaxed text-indigo-200/70">Pick who this chat talks to, then ask about the project or tell it what to do. Once the conversation starts it stays with them.</p>
      <div className="mt-6 grid grid-cols-2 gap-3 text-left" data-testid="provider-cards">
        {MAIN.map(({ p, hint }) => {
          const on = agent.provider === p
          const note = cliNote(p === 'claude-cli' ? clis?.claude : clis?.codex)
          const tint = providerTint(p)
          return (
            <button
              key={p}
              className={`provider-card lift-mark relative flex flex-col items-start gap-3 rounded-2xl border p-4 text-left ${on ? '' : 'border-white/[0.08] bg-white/[0.025] hover:border-white/20 hover:bg-white/[0.045]'}`}
              style={on ? { borderColor: `color-mix(in srgb, ${tint} 60%, transparent)`, background: `linear-gradient(160deg, color-mix(in srgb, ${tint} 14%, transparent), transparent 70%)`, boxShadow: `0 12px 40px -18px ${tint}` } : undefined}
              onClick={() => chooseProvider(agent, p)}
              aria-pressed={on}
              data-testid={`provider-card-${p}`}
            >
              {on && (
                <span className="pop absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full text-white" style={{ background: tint }}>
                  <Check size={12} strokeWidth={3} />
                </span>
              )}
              <ProviderMark p={p} size={40} />
              <span className="min-w-0">
                <span className="block font-display text-[17px] font-bold text-white">{PROVIDER_NAME[p]}</span>
                <span className="mt-0.5 block text-[11.5px] text-indigo-300/70">{hint}</span>
              </span>
              <span className={`flex items-center gap-1.5 text-[10.5px] ${!note ? 'text-indigo-300/50' : note.ok ? 'text-emerald-200/90' : 'text-amber-200/90'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${!note ? 'animate-pulse bg-indigo-300/50' : note.ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                {note?.text ?? 'Checking...'}
              </span>
            </button>
          )
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
        <span className="mr-0.5 text-[11px] text-indigo-300/50">or</span>
        {OTHERS.map((p) => {
          const on = agent.provider === p
          const noKey = needsKey(p) && !keyed.includes(p)
          return (
            <button
              key={p}
              className={`lift-mark row flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-[11px] ${on ? 'border-violet-400/50 bg-violet-500/15 text-white' : 'border-white/[0.08] text-indigo-200/75 hover:border-white/20 hover:bg-white/5 hover:text-white'}`}
              title={noKey ? `Add a ${PROVIDER_NAME[p]} key in Settings` : `Talk to ${PROVIDER_NAME[p]}`}
              onClick={() => chooseProvider(agent, p)}
              data-testid={`provider-chip-${p}`}
            >
              <ProviderMark p={p} size={18} className={noKey ? 'opacity-60' : ''} />
              {PROVIDER_NAME[p]}
            </button>
          )
        })}
      </div>
      <div className="mt-9 grid grid-cols-2 gap-2 text-left">
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

/** The slash commands the composer offers. */
const COMMANDS = [
  { cmd: '/table', hint: 'make or change a table from a description - linked to the code, kept in the Tables tool' },
  { cmd: '/plugin', hint: 'make a tool from a description - the chat writes it, checks it and installs it under Tools' },
  { cmd: '/idea', hint: 'brainstorm ideas about something - they go to the Idea Book for you to keep or dismiss' },
  { cmd: '/plan', hint: 'plan this message first - it hands you a plan to approve before it changes anything' },
  { cmd: '/coop', hint: 'work on this message together - it asks you questions in rounds as it goes' }
]

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
  // images about to go with the message: pasted, dropped or picked
  const [images, setImages] = useState<Pending[]>([])
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const busy = st?.status === 'thinking' || st?.status === 'working' || st?.status === 'waiting' || messages.at(-1)?.streaming

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  if (!agent) return null
  // while the draft is a bare `/word`, offer the commands it could be
  const commands = /^\/\w*$/.test(draft) ? COMMANDS.filter((c) => c.cmd.startsWith(draft)) : []
  // Quick runs one message on the provider's light tier; it is offered only where that is cheaper
  const light = settings ? downshift(agent, 'light', settings.economy) : null
  const attach = (files: File[], pasted = false) => {
    const pics = files.filter((f) => f.type.startsWith('image/'))
    if (files.length > pics.length) useStore.getState().toast('error', 'Only images can be attached for now.')
    const room = 10 - images.length
    if (pics.length > room) useStore.getState().toast('error', 'At most 10 images per message.')
    for (const f of pics.slice(0, Math.max(0, room))) {
      const id = newId('att')
      const name = pasted ? pastedName(f) : f.name || 'image.png'
      setImages((all) => [...all, { id, name }])
      prepareImage(f, name)
        .then((ready) => setImages((all) => all.map((x) => (x.id === id ? { ...x, ...ready } : x))))
        .catch((e) => setImages((all) => all.map((x) => (x.id === id ? { ...x, error: `${name}: ${(e as Error).message || 'could not be read'}` } : x))))
    }
  }
  const remove = (id: string) =>
    setImages((all) => {
      const gone = all.find((x) => x.id === id)
      if (gone?.url) URL.revokeObjectURL(gone.url)
      return all.filter((x) => x.id !== id)
    })
  const reading = images.some((x) => !x.data && !x.error)
  const send = () => {
    const text = draft.trim()
    const ready = images.filter((x) => x.data && x.mime)
    if ((!text && !ready.length) || reading) return
    setDraft('')
    setImages([])
    void api()
      .send(agentId, text, { quick: quick && !!light, images: ready.map(({ name, mime, data, w, h }) => ({ name, mime: mime!, data: data!, w, h })) })
      .catch((e) => useStore.getState().toast('error', String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
      .finally(() => ready.forEach((x) => x.url && URL.revokeObjectURL(x.url)))
    setQuick(false)
  }
  return (
    <div
      className="relative flex h-full min-w-0 flex-1 flex-col"
      data-chat-panel={agentId}
      data-testid={`chat-${agentId}`}
      onDragOver={(e) => {
        if (![...e.dataTransfer.items].some((i) => i.kind === 'file')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDragging(false)
        attach([...e.dataTransfer.files])
      }}
    >
      {dragging && (
        <div className="fade-in pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-violet-400/70 bg-violet-950/50 backdrop-blur-sm" onDragLeave={() => setDragging(false)}>
          <div className="flex items-center gap-2 font-display text-lg font-bold text-violet-100">
            <ImagePlus size={22} /> Drop images to attach
          </div>
        </div>
      )}
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
      {/* clear of Tuesday's orb in the corner, on a narrow window */}
      <div className="relative mx-auto w-full p-3" style={{ maxWidth: 'min(860px, calc(100% - 2 * var(--tuesday-clear, 0px)))' }}>
        {commands.length > 0 && (
          <div className="glass menu-pop absolute bottom-full left-3 right-3 z-20 mb-1 rounded-xl p-1" style={{ background: 'rgb(10 12 28 / 0.97)' }} data-testid="slash-menu">
            {commands.map((c) => (
              <button key={c.cmd} className="flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-white/5" onMouseDown={(e) => (e.preventDefault(), setDraft(`${c.cmd} `))}>
                <span className="font-mono text-[12.5px] text-violet-200">{c.cmd}</span>
                <span className="truncate text-[11.5px] text-indigo-300/70">{c.hint}</span>
                <span className="ml-auto shrink-0 text-[10px] text-indigo-300/40">Tab</span>
              </button>
            ))}
          </div>
        )}
        <div className={`composer rounded-2xl border bg-black/40 p-2 focus-within:border-violet-400/60 ${quick && light ? 'border-amber-400/50' : 'border-white/10'}`}>
          <AttachTray items={images} onRemove={remove} />
          <div className="flex items-end gap-2">
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              attach([...(e.target.files ?? [])])
              e.target.value = ''
            }}
            data-testid="chat-attach-input"
          />
          <button className="btn btn-ghost !p-2 text-indigo-300/70" title="Attach images (or paste or drop them here)" onClick={() => picker.current?.click()} data-testid="chat-attach">
            <ImagePlus size={15} />
          </button>
          <textarea
            className="scroll-thin max-h-48 min-h-[2.4rem] flex-1 resize-none bg-transparent px-1.5 py-1 text-sm outline-none"
            placeholder={quick && light ? `Quick: this message runs on ${modelLabel(settings?.catalog ?? {}, agent.provider, light.model)}...` : messages.length ? 'Reply...' : 'Ask about the project, or tell it what to build...'}
            value={draft}
            rows={Math.min(8, draft.split('\n').length)}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              // a screenshot on the clipboard becomes an attachment; text pastes as usual
              const files = [...e.clipboardData.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => !!f)
              if (!files.length) return
              e.preventDefault()
              attach(files, true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Tab' && commands.length) {
                e.preventDefault()
                setDraft(`${commands[0].cmd} `)
                return
              }
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
            <button className="btn btn-danger pop !p-2" title="Stop" onClick={() => void api().stop(agentId)} data-testid="chat-stop">
              <Square size={15} />
            </button>
          ) : null}
          <button className={`btn btn-primary !p-2 ${(draft.trim() || images.length) && !reading ? 'send-ready' : 'opacity-60'}`} title={reading ? 'Reading the images...' : 'Send (Enter)'} onClick={send} data-testid="chat-send">
            <Send size={15} />
          </button>
          </div>
        </div>
        <ComposerBar agent={agent} />
      </div>
    </div>
  )
}
