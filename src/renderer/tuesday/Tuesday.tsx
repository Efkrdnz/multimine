import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowUp, CheckCircle2, MessageCircleQuestion, Phone, RotateCcw, Settings2, Square, X } from 'lucide-react'
import { modelLabel } from '@shared/catalog'
import type { TuesdayNotice } from '@shared/types'
import { api, applyEvent, useStore } from '../state/store'
import { MessageView } from '../panels/MessageView'
import { PromptCard } from '../panels/PromptCard'
import { ProviderMark } from '../panels/ProviderMark'

const SUGGESTIONS = ["What's going on?", 'Anything waiting for me?', 'What finished while I was away?']

/** The orb itself: a turning ring around a breathing core. */
function Orb({ size, busy }: { size: number; busy: boolean }) {
  return (
    <span className="tuesday-orb block" style={{ width: size, height: size }} {...(busy ? { 'data-busy': '' } : {})}>
      <span className="ring" />
      <span className="core" />
    </span>
  )
}

const busyStatus = (s: string) => s === 'thinking' || s === 'working'

/** A line from Tuesday by the orb; a click brings up the chat it is about. */
function Notice({ n }: { n: TuesdayNotice }) {
  const icon = n.kind === 'ask' ? <MessageCircleQuestion size={14} className="shrink-0 text-amber-300" /> : n.kind === 'done' ? <CheckCircle2 size={14} className="shrink-0 text-emerald-300" /> : <AlertTriangle size={14} className="shrink-0 text-red-300" />
  const drop = () => useStore.getState().set({ notices: useStore.getState().notices.filter((x) => x.id !== n.id) })
  return (
    <div className="glass tuesday-panel group flex max-w-[320px] items-center gap-2 rounded-xl py-2 pl-3 pr-1.5 text-[12.5px]" data-testid="tuesday-notice">
      <button
        className="flex min-w-0 flex-1 items-center gap-2 text-left text-indigo-50"
        onClick={() => {
          drop()
          applyEvent({ type: 'reveal', dir: n.dir, agentId: n.chatId })
        }}
      >
        {icon}
        <span className="line-clamp-2">{n.text}</span>
      </button>
      <button className="rounded p-1 text-indigo-300/60 opacity-0 hover:text-white group-hover:opacity-100" onClick={drop} title="Dismiss">
        <X size={12} />
      </button>
    </div>
  )
}

/** Tuesday's conversation, what is waiting on the user, and a box to talk to it. */
function Panel() {
  const messages = useStore((s) => s.tuesdayMessages)
  const status = useStore((s) => s.tuesdayStatus)
  const spec = useStore((s) => s.tuesdaySpec)
  const waiting = useStore((s) => s.waiting)
  const catalog = useStore((s) => s.settings?.catalog ?? {})
  const name = useStore((s) => s.settings?.tuesday.name || 'Tuesday')
  const [draft, setDraft] = useState('')
  const [showWaiting, setShowWaiting] = useState(true)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const busy = busyStatus(status.status) || status.status === 'waiting'
  const last = messages.at(-1)

  useEffect(() => input.current?.focus(), [])
  // the newest message in view as it streams in
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, last?.text.length, last?.tools?.length])

  const send = (text = draft) => {
    if (!text.trim()) return
    setDraft('')
    void api().tuesdaySend(text.trim())
  }
  const close = () => useStore.getState().set({ tuesdayOpen: false })

  return (
    <div
      className="glass tuesday-panel fixed bottom-[84px] right-4 z-30 flex w-[min(430px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl"
      style={{ height: 'min(660px, calc(100vh - 140px))', background: 'rgb(9 10 26 / 0.97)' }}
      // Esc closes what is on top: a dialog opened from here first
      onKeyDown={(e) => e.key === 'Escape' && !useStore.getState().modal && close()}
      data-testid="tuesday-panel"
    >
      <div className="flex items-center gap-2.5 border-b border-white/10 px-3.5 py-2.5">
        <Orb size={26} busy={busyStatus(status.status)} />
        <div className="min-w-0 flex-1">
          <div className="font-display text-sm font-bold leading-tight text-white">{name}</div>
          <div className="flex items-center gap-1 truncate text-[10.5px] text-indigo-300/70">
            {busy ? (
              <span className="text-cyan-200/90">{status.status === 'waiting' ? 'Waiting for you' : (status.activity ?? 'Thinking')}…</span>
            ) : spec ? (
              <>
                <ProviderMark p={spec.provider} size={12} /> {modelLabel(catalog, spec.provider, spec.model) || spec.model || 'default model'}
              </>
            ) : null}
          </div>
        </div>
        <button className="rounded-md p-1.5 text-indigo-300/70 hover:bg-white/5 hover:text-white" title="New conversation (it starts clean, with a short recap)" onClick={() => void api().tuesdayFresh()} data-testid="tuesday-fresh">
          <RotateCcw size={14} />
        </button>
        <button className="rounded-md p-1.5 text-indigo-300/70 hover:bg-white/5 hover:text-white" title={`${name}'s settings`} onClick={() => useStore.getState().set({ modal: { kind: 'settings', tab: 'tuesday' } })} data-testid="tuesday-settings">
          <Settings2 size={14} />
        </button>
        <button className="rounded-md p-1.5 text-indigo-300/70 hover:bg-white/5 hover:text-white" title="Close (Esc)" onClick={close}>
          <X size={14} />
        </button>
      </div>

      {/* what waits on the user stays in view above the conversation */}
      {waiting.length > 0 && (
        <div className="mx-3 mt-2 rounded-xl border border-amber-300/20 bg-amber-400/[0.05] p-2" data-testid="tuesday-waiting">
          <button className="flex w-full items-center gap-2 px-1 text-left text-[11px] font-bold uppercase tracking-wider text-amber-200" onClick={() => setShowWaiting(!showWaiting)}>
            <MessageCircleQuestion size={13} /> Waiting for you ({waiting.length})<span className="flex-1" />
            <span className="font-normal normal-case tracking-normal text-amber-200/60">{showWaiting ? 'hide' : 'show'}</span>
          </button>
          {showWaiting && (
            <div className="scroll-thin mt-2 max-h-[38vh] space-y-2 overflow-y-auto pr-0.5">
              {waiting.map((w) => (
                <div key={w.item.id} data-testid="tuesday-waiting-item">
                  <button className="mb-1 px-1 text-left text-[11px] text-indigo-200/80 hover:text-white" title="Open this chat" onClick={() => w.dir && applyEvent({ type: 'reveal', dir: w.dir, itemId: w.item.id, agentId: w.item.askedBy })}>
                    {w.project} · <span className="font-semibold">{w.chat}</span>
                  </button>
                  <PromptCard item={w.item} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div ref={list} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3.5 py-2 select-text">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <Orb size={56} busy={false} />
            <div className="font-display text-base font-bold text-white">Hi, I'm {name}.</div>
            <div className="text-[12.5px] leading-relaxed text-indigo-200/75">I keep an eye on every chat in every open project. Ask me what's going on, have me start or steer a chat, or tell me how to answer what they ask.</div>
            <div className="mt-1 flex flex-wrap justify-center gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11.5px] text-indigo-100 hover:border-cyan-300/40 hover:bg-cyan-400/10" onClick={() => send(s)} data-testid="tuesday-suggestion">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => <MessageView key={m.id} m={m} last={i === messages.length - 1} />)
        )}
      </div>

      <div className="border-t border-white/10 p-2.5">
        <div className="flex items-end gap-2 rounded-xl border border-white/10 bg-black/30 px-3 py-2 focus-within:border-cyan-300/40">
          <textarea
            ref={input}
            className="scroll-thin max-h-32 min-h-[22px] flex-1 resize-none bg-transparent text-[13px] text-white outline-none placeholder:text-indigo-300/50"
            rows={Math.min(5, Math.max(1, draft.split('\n').length))}
            placeholder={`Ask ${name}…`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
            data-testid="tuesday-input"
          />
          {busy ? (
            <button className="rounded-lg bg-red-500/20 p-1.5 text-red-200 hover:bg-red-500/30" title="Stop" onClick={() => void api().tuesdayStop()} data-testid="tuesday-stop">
              <Square size={14} />
            </button>
          ) : (
            <button className="rounded-lg bg-gradient-to-br from-cyan-500 to-indigo-600 p-1.5 text-white disabled:opacity-40" disabled={!draft.trim()} title="Send (Enter)" onClick={() => send()} data-testid="tuesday-send">
              <ArrowUp size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Tuesday, in the bottom-right corner of every screen: the orb (with what waits on the user as a
 * badge), its lines when a chat finishes or asks, and its panel. Ctrl+Shift+Space opens it.
 */
export function Tuesday() {
  const open = useStore((s) => s.tuesdayOpen)
  const status = useStore((s) => s.tuesdayStatus.status)
  const waiting = useStore((s) => s.waiting.length)
  const notices = useStore((s) => s.notices)
  const name = useStore((s) => s.settings?.tuesday.name || 'Tuesday')
  const onCall = useStore((s) => !!s.phone?.call)

  useEffect(() => {
    void api()
      .phoneState()
      .then((phone) => useStore.getState().set({ phone }))
      .catch(() => undefined)
    void api()
      .tuesdayInit()
      .then((r) => useStore.getState().set({ tuesdayMessages: r.messages, tuesdayStatus: { status: r.status, activity: r.activity, detail: r.detail }, tuesdaySpec: r.spec, waiting: r.waiting }))
      .catch(() => undefined)
    const key = (e: KeyboardEvent) => {
      if (e.code === 'Space' && e.ctrlKey && e.shiftKey) {
        e.preventDefault()
        useStore.getState().set({ tuesdayOpen: !useStore.getState().tuesdayOpen })
      }
    }
    window.addEventListener('keydown', key)
    // the chat's message box keeps clear of the orb
    document.documentElement.style.setProperty('--tuesday-clear', '72px')
    return () => {
      window.removeEventListener('keydown', key)
      document.documentElement.style.removeProperty('--tuesday-clear')
    }
  }, [])
  // the chat it runs as follows its settings
  const settings = useStore((s) => s.settings?.tuesday)
  useEffect(() => {
    void api()
      .tuesdayInit()
      .then((r) => useStore.getState().set({ tuesdaySpec: r.spec }))
      .catch(() => undefined)
  }, [settings?.name, settings?.provider, settings?.model, settings?.effort])

  return (
    <>
      {open && <Panel />}
      {!open && notices.length > 0 && (
        <div className="fixed bottom-[84px] right-4 z-30 flex flex-col items-end gap-1.5">
          {notices.map((n) => (
            <Notice key={n.id} n={n} />
          ))}
        </div>
      )}
      <button
        className="fixed bottom-4 right-4 z-30 rounded-full outline-none"
        title={`${name} (Ctrl+Shift+Space)${onCall ? ' - on the phone with you' : ''}${waiting ? ` - ${waiting} waiting for you` : ''}`}
        aria-label={name}
        aria-expanded={open}
        onClick={() => useStore.getState().set({ tuesdayOpen: !open })}
        data-testid="tuesday-orb"
      >
        <Orb size={52} busy={busyStatus(status) || onCall} />
        {onCall && (
          <span className="pop absolute -bottom-1 -left-1 flex h-5 w-5 items-center justify-center rounded-full bg-cyan-400 text-[#032] shadow" data-testid="tuesday-on-call">
            <Phone size={11} />
          </span>
        )}
        {waiting > 0 && (
          <span className="pop absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-400 px-1 text-[11px] font-bold text-[#2a1a00] shadow" data-testid="tuesday-badge">
            {waiting}
          </span>
        )}
      </button>
    </>
  )
}
