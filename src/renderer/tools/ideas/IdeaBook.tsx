import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronRight, Hammer, Lightbulb, ListChecks, MessageSquare, Plus, Search, Send, Sparkles, Trash2, Users, X } from 'lucide-react'
import type { PluginInfo } from '@shared/types'
import { newId } from '@shared/ids'
import { bookJson, EMPTY_BOOK, IDEAS_PATH, parseBook, workPrompt, type Idea, type IdeaBook as Book, type WorkHow } from '@shared/ideas'
import { useStore } from '../../state/store'
import { errText, usePluginApi, type PluginCall } from '../pluginApi'
import { ChatTarget, chatLabel, useChats, type ChatChoice, type Sent } from '../ChatTarget'

type Filter = 'open' | 'done' | 'all'

const tagsOf = (s: string) =>
  s
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 6)

/** The book on disk, read fresh: a chat may have added to it since. */
async function load(call: PluginCall): Promise<Book> {
  const text = await call<string>('files.read', IDEAS_PATH).catch(() => null)
  if (!text) return { ...EMPTY_BOOK, ideas: [] }
  try {
    return parseBook(JSON.parse(text))
  } catch {
    return { ...EMPTY_BOOK, ideas: [] }
  }
}

/** A little popover: who gets the work, and a button to send it. */
function SendTo({ chats, label, testId, onSend, onClose, children }: { chats: ChatChoice[]; label: string; testId: string; onSend: (to: string) => void; onClose: () => void; children?: React.ReactNode }) {
  const [to, setTo] = useState('new')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && onClose()
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [onClose])
  return (
    <div ref={box} className="glass menu-pop absolute right-0 top-full z-30 mt-1 w-[300px] origin-top-right space-y-2 rounded-xl p-3" style={{ background: 'rgb(10 12 28 / 0.97)' }} data-testid={`${testId}-pop`}>
      {children}
      <div className="flex items-center gap-2">
        <ChatTarget chats={chats} value={to} onChange={setTo} className="min-w-0 flex-1" testId={`${testId}-to`} />
        <button className="btn btn-primary shrink-0 !py-1 !text-xs" onClick={() => onSend(to)} data-testid={`${testId}-go`}>
          <Send size={12} /> {label}
        </button>
      </div>
    </div>
  )
}

const HOW: { id: WorkHow; label: string; icon: React.ReactNode; help: string }[] = [
  { id: 'build', label: 'Build now', icon: <Hammer size={11} />, help: 'It plans briefly and builds it right away.' },
  { id: 'plan', label: 'Plan first', icon: <ListChecks size={11} />, help: 'It looks, then hands you a plan to approve before it changes anything.' },
  { id: 'coop', label: 'Coop', icon: <Users size={11} />, help: 'You work it out together: it asks you questions in rounds, then builds it.' }
]

/** How the idea is worked on, as three small toggles. */
function HowPicker({ value, onChange }: { value: WorkHow; onChange: (h: WorkHow) => void }) {
  return (
    <div className="space-y-1">
      <div className="flex gap-1 rounded-lg bg-black/25 p-0.5" role="radiogroup" data-testid="idea-how">
        {HOW.map((h) => (
          <button
            key={h.id}
            role="radio"
            aria-checked={value === h.id}
            className={`flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[11px] ${value === h.id ? 'bg-indigo-500/40 text-white shadow' : 'text-indigo-200/70 hover:bg-white/5 hover:text-indigo-50'}`}
            onClick={() => onChange(h.id)}
            data-testid={`idea-how-${h.id}`}
          >
            {h.icon} {h.label}
          </button>
        ))}
      </div>
      <div className="text-[10.5px] text-indigo-300/70">{HOW.find((h) => h.id === value)?.help}</div>
    </div>
  )
}

/** One idea the chats proposed, waiting for a decision. */
function Proposal({ idea, onKeep, onDismiss }: { idea: Idea; onKeep: () => void; onDismiss: () => void }) {
  return (
    <div className="pop group flex flex-col rounded-xl border border-amber-300/20 bg-gradient-to-b from-amber-400/[0.07] to-transparent p-3" data-testid="idea-proposal">
      <div className="flex items-start gap-2">
        <Sparkles size={13} className="mt-0.5 shrink-0 text-amber-300" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-snug text-white">{idea.title}</div>
          {idea.details && <div className="mt-1 text-[11.5px] leading-relaxed text-indigo-200/75">{idea.details}</div>}
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-1.5">
        {idea.tags?.map((t) => (
          <span key={t} className="rounded-full bg-white/[0.06] px-1.5 py-px text-[10px] text-indigo-200/70">
            {t}
          </span>
        ))}
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-indigo-300/50" title={`From ${idea.from}`}>
          from {idea.from}
        </span>
        <button className="btn !px-2 !py-0.5 !text-[11px]" title="Not for this project" onClick={onDismiss} data-testid="idea-dismiss">
          <X size={11} />
        </button>
        <button className="btn btn-primary !px-2 !py-0.5 !text-[11px]" title="Keep it in the Idea Book" onClick={onKeep} data-testid="idea-keep">
          <Check size={11} /> Keep
        </button>
      </div>
    </div>
  )
}

/** One idea in the book: check it off, open it to edit, send it to a chat. */
function Row({ idea, chats, onChange, onRemove, onWork }: { idea: Idea; chats: ChatChoice[]; onChange: (patch: Partial<Idea>) => void; onRemove: () => void; onWork: (to: string, how: WorkHow) => void }) {
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [how, setHow] = useState<WorkHow>('build')
  const [title, setTitle] = useState(idea.title)
  const [details, setDetails] = useState(idea.details ?? '')
  const [tags, setTags] = useState((idea.tags ?? []).join(', '))
  useEffect(() => {
    setTitle(idea.title)
    setDetails(idea.details ?? '')
    setTags((idea.tags ?? []).join(', '))
  }, [idea.title, idea.details, idea.tags])
  const done = idea.status === 'done'
  const workChat = idea.workChatId ? chats.find((c) => c.id === idea.workChatId) : undefined
  const save = () => {
    const t = title.trim()
    if (!t) return setTitle(idea.title)
    const nextTags = tagsOf(tags)
    if (t !== idea.title || details.trim() !== (idea.details ?? '') || nextTags.join(',') !== (idea.tags ?? []).join(',')) onChange({ title: t, details: details.trim() || undefined, tags: nextTags.length ? nextTags : undefined })
  }
  return (
    <div className={`row group rounded-xl border ${open ? 'border-white/12 bg-white/[0.035]' : 'border-transparent hover:bg-white/[0.025]'}`} data-testid="idea-row">
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 transition ${done ? 'border-emerald-400 bg-emerald-400 text-[#06281c]' : 'border-indigo-300/40 hover:border-emerald-300'}`}
          title={done ? 'Not done after all' : 'Done'}
          onClick={() => onChange(done ? { status: 'open', doneAt: undefined } : { status: 'done', doneAt: Date.now() })}
          data-testid="idea-check"
        >
          {done && <Check size={11} strokeWidth={3.5} className="pop" />}
        </button>
        <button className="flex min-w-0 flex-1 items-baseline gap-2 text-left" onClick={() => setOpen(!open)} data-testid="idea-open">
          <span className={`truncate text-[13.5px] ${done ? 'text-indigo-300/50 line-through' : 'text-indigo-50'}`}>{idea.title}</span>
          {!open && idea.details && <span className="min-w-0 flex-1 truncate text-[11.5px] text-indigo-300/45">{idea.details}</span>}
        </button>
        {idea.tags?.map((t) => (
          <span key={t} className="hidden shrink-0 rounded-full bg-white/[0.06] px-1.5 py-px text-[10px] text-indigo-200/70 lg:inline">
            {t}
          </span>
        ))}
        {workChat && (
          <button className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-cyan-200/80 hover:bg-white/5 hover:text-cyan-100" title={`Open "${workChat.name}"`} onClick={() => useStore.getState().openChat(workChat.id)} data-testid="idea-work-chat">
            <MessageSquare size={11} /> <span className="max-w-[120px] truncate">{workChat.name}</span>
          </button>
        )}
        {!done && (
          <div className="relative shrink-0">
            <button className={`btn !px-2 !py-0.5 !text-[11px] ${sending ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`} onClick={() => setSending(!sending)} data-testid="idea-work">
              <Send size={11} /> Work on it
            </button>
            {sending && (
              <SendTo chats={chats} label="Send" testId="idea-work" onClose={() => setSending(false)} onSend={(to) => (setSending(false), onWork(to, how))}>
                <div className="text-[11.5px] text-indigo-200/80">Send "{idea.title}" to a chat to work on.</div>
                <HowPicker value={how} onChange={setHow} />
              </SendTo>
            )}
          </div>
        )}
        <ChevronRight size={13} className={`shrink-0 text-indigo-300/40 transition-transform ${open ? 'rotate-90' : ''}`} />
      </div>
      {open && (
        <div className="space-y-2 px-3 pb-3 pl-[42px]">
          <input className="field !py-1 !text-[13px] font-semibold" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} data-testid="idea-title-input" />
          <textarea className="field min-h-[70px] resize-y !text-[12.5px]" placeholder="Details: what it is, why it fits, how it might work" value={details} onChange={(e) => setDetails(e.target.value)} onBlur={save} data-testid="idea-details-input" />
          <div className="flex items-center gap-2">
            <input className="field !py-1 !text-xs" placeholder="Tags, separated by commas" value={tags} onChange={(e) => setTags(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} />
            <span className="shrink-0 text-[10.5px] text-indigo-300/50">
              {idea.from === 'you' ? 'yours' : `from ${idea.from}`} · {idea.created ? new Date(idea.created).toLocaleDateString() : ''}
            </span>
            <button className="btn btn-ghost !p-1.5 text-red-300/80" title="Delete this idea" onClick={onRemove} data-testid="idea-delete">
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The Idea Book: the project's ideas, kept in .multimine/ideas.json. Write one at the top, or have a
 * chat brainstorm (/idea); what chats propose waits under "To review" until it is kept or dismissed.
 * Check an idea off when it is done, or send it to a chat to work on it.
 */
export function IdeaBook({ plugin }: { plugin: PluginInfo }) {
  const call = usePluginApi(plugin.manifest.id)
  const chats = useChats(call)
  const toast = useStore((s) => s.toast)
  const changed = useStore((s) => s.ideasChanged)
  const [book, setBook] = useState<Book | null>(null)
  const [draft, setDraft] = useState('')
  const [filter, setFilter] = useState<Filter>('open')
  const [q, setQ] = useState('')
  const [brainstorm, setBrainstorm] = useState(false)
  const [topic, setTopic] = useState('')

  const reload = useCallback(() => void load(call).then(setBook), [call])
  useEffect(() => reload(), [reload, changed])

  /** Reads the book fresh, changes it, writes it: a chat adding ideas meanwhile is never lost. */
  const mutate = async (fn: (b: Book) => void) => {
    try {
      const fresh = await load(call)
      fn(fresh)
      await call('files.write', IDEAS_PATH, bookJson(fresh))
      setBook(fresh)
    } catch (e) {
      toast('error', `Could not save the Idea Book: ${errText(e)}`)
    }
  }
  const patch = (id: string, p: Partial<Idea>) => void mutate((b) => (b.ideas = b.ideas.map((i) => (i.id === id ? { ...i, ...p } : i))))

  const add = () => {
    const title = draft.trim()
    if (!title) return
    setDraft('')
    void mutate((b) => b.ideas.unshift({ id: newId('idea'), title, status: 'open', from: 'you', created: Date.now() }))
  }

  const send = async (to: string, text: string, done: string, how: WorkHow = 'build'): Promise<string | null> => {
    try {
      const sent = await call<Sent>('send', to, text, how === 'build' ? undefined : { [how]: true })
      toast('info', `${done} - ${chatLabel(chats, to, sent)}`)
      return sent.chatId
    } catch (e) {
      toast('error', errText(e))
      return null
    }
  }

  const proposals = useMemo(() => (book?.ideas ?? []).filter((i) => i.status === 'proposed'), [book])
  const kept = useMemo(() => (book?.ideas ?? []).filter((i) => i.status !== 'proposed'), [book])
  const counts = { open: kept.filter((i) => i.status === 'open').length, done: kept.filter((i) => i.status === 'done').length }
  const shown = kept
    .filter((i) => filter === 'all' || i.status === filter)
    .filter((i) => !q.trim() || `${i.title} ${i.details ?? ''} ${(i.tags ?? []).join(' ')}`.toLowerCase().includes(q.trim().toLowerCase()))
    // open ones first, newest first; done ones after, most recently done first
    .sort((a, b) => (a.status === b.status ? (a.status === 'done' ? (b.doneAt ?? 0) - (a.doneAt ?? 0) : b.created - a.created) : a.status === 'done' ? 1 : -1))

  if (!book) return <div className="p-6 text-sm text-indigo-300/70">Opening the Idea Book...</div>
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="idea-book">
      <div className="flex flex-wrap items-center gap-3 border-b border-white/10 px-5 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Lightbulb size={16} className="text-amber-300" />
          <span className="font-display text-[15px] font-bold">Ideas</span>
          <span className="text-[11.5px] text-indigo-300/60">
            {counts.open} open · {counts.done} done{proposals.length ? ` · ${proposals.length} to review` : ''}
          </span>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-indigo-100" title="While this is on, every chat saves the extra ideas it has here for you to review, instead of writing them in its replies. Off, chats are not told about it at all, which saves tokens.">
          <span>Side ideas from chats</span>
          <button
            role="switch"
            aria-checked={book.sideIdeas}
            className={`relative h-5 w-9 rounded-full transition ${book.sideIdeas ? 'bg-amber-400' : 'bg-white/15'}`}
            onClick={() => void mutate((b) => (b.sideIdeas = !b.sideIdeas))}
            data-testid="idea-side-toggle"
          >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${book.sideIdeas ? 'left-[18px]' : 'left-0.5'}`} />
          </button>
        </label>
        <div className="relative">
          <button className="btn !py-1" onClick={() => setBrainstorm(!brainstorm)} data-testid="idea-brainstorm">
            <Sparkles size={13} className="text-amber-300" /> Brainstorm
          </button>
          {brainstorm && (
            <SendTo
              chats={chats}
              label="Brainstorm"
              testId="idea-brainstorm"
              onClose={() => setBrainstorm(false)}
              onSend={(to) => {
                setBrainstorm(false)
                void send(to, `/idea ${topic.trim()}`.trim(), 'Asked for ideas').then((id) => id && setTopic(''))
              }}
            >
              <input className="field !py-1 !text-xs" placeholder="About what? (blank: whatever is most worth doing next)" value={topic} autoFocus onChange={(e) => setTopic(e.target.value)} data-testid="idea-brainstorm-topic" />
              <div className="text-[10.5px] leading-relaxed text-indigo-300/60">The chat saves its ideas here to review; its reply stays a sentence. Same as typing /idea in a chat.</div>
            </SendTo>
          )}
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto max-w-[960px] space-y-5">
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 p-1.5 pl-3 focus-within:border-amber-300/50">
            <Plus size={15} className="shrink-0 text-amber-300/80" />
            <input className="min-w-0 flex-1 bg-transparent py-1 text-[13.5px] outline-none placeholder:text-indigo-300/40" placeholder="Write an idea and press Enter" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} data-testid="idea-input" />
            <button className="btn btn-primary !py-1 !text-xs" disabled={!draft.trim()} onClick={add} data-testid="idea-add">
              Add
            </button>
          </div>

          {proposals.length > 0 && (
            <section data-testid="idea-review">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-amber-200/80">To review · {proposals.length}</span>
                <span className="text-[11px] text-indigo-300/50">ideas chats proposed: keep the good ones</span>
                <span className="flex-1" />
                <button className="btn btn-ghost !py-0.5 !text-[11px]" onClick={() => void mutate((b) => (b.ideas = b.ideas.filter((i) => i.status !== 'proposed')))} data-testid="idea-dismiss-all">
                  Dismiss all
                </button>
                <button className="btn !py-0.5 !text-[11px]" onClick={() => void mutate((b) => (b.ideas = b.ideas.map((i) => (i.status === 'proposed' ? { ...i, status: 'open' as const } : i))))} data-testid="idea-keep-all">
                  <Check size={11} /> Keep all
                </button>
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {proposals.map((i) => (
                  <Proposal key={i.id} idea={i} onKeep={() => patch(i.id, { status: 'open', created: Date.now() })} onDismiss={() => void mutate((b) => (b.ideas = b.ideas.filter((x) => x.id !== i.id)))} />
                ))}
              </div>
            </section>
          )}

          <section>
            <div className="mb-1.5 flex items-center gap-2">
              <div className="flex rounded-lg border border-white/10 p-0.5 text-[11.5px]">
                {(['open', 'done', 'all'] as Filter[]).map((f) => (
                  <button key={f} className={`row rounded-md px-2.5 py-0.5 ${filter === f ? 'bg-white/10 text-white' : 'text-indigo-300/70 hover:text-white'}`} onClick={() => setFilter(f)} data-testid={`idea-filter-${f}`}>
                    {f === 'open' ? `Open ${counts.open}` : f === 'done' ? `Done ${counts.done}` : 'All'}
                  </button>
                ))}
              </div>
              <span className="flex-1" />
              <div className="relative w-56">
                <Search size={12} className="absolute left-2 top-2 text-indigo-300/50" />
                <input className="field !py-1 !pl-6 !text-xs" placeholder="Search ideas" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            </div>
            {shown.length ? (
              <div className="space-y-0.5">
                {shown.map((i) => (
                  <Row
                    key={i.id}
                    idea={i}
                    chats={chats}
                    onChange={(p) => patch(i.id, p)}
                    onRemove={() => window.confirm(`Delete "${i.title}"?`) && void mutate((b) => (b.ideas = b.ideas.filter((x) => x.id !== i.id)))}
                    onWork={(to, how) => void send(to, workPrompt(i, how), `Sent "${i.title}"`, how).then((chatId) => chatId && patch(i.id, { workChatId: chatId }))}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-[12.5px] text-indigo-300/60">
                {kept.length
                  ? filter === 'done'
                    ? 'Nothing checked off yet.'
                    : 'No open ideas match.'
                  : 'No ideas yet. Write one above, press Brainstorm, or type /idea in any chat.'}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
