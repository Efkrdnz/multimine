import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, KeyRound, Lock } from 'lucide-react'
import { needsKey } from '@shared/catalog'
import { PROVIDER_NAME, onProvider } from '@shared/chat'
import type { AgentSpec, CliStatus, ProviderKind } from '@shared/types'
import { api, useStore } from '../state/store'
import { ProviderMark, providerTint } from './ProviderMark'

const GROUPS: { title: string; folded?: boolean; items: { p: ProviderKind; hint: string }[] }[] = [
  {
    title: 'Subscriptions',
    items: [
      { p: 'claude-cli', hint: 'Your Claude plan, through Claude Code' },
      { p: 'codex-cli', hint: 'Your ChatGPT plan, through Codex' }
    ]
  },
  {
    title: 'API keys',
    folded: true,
    items: [
      { p: 'anthropic', hint: 'Claude, billed per call' },
      { p: 'openai', hint: 'GPT, billed per call' },
      { p: 'google', hint: 'Gemini, billed per call' },
      { p: 'groq', hint: 'Fast open models' },
      { p: 'xai', hint: 'Grok' },
      { p: 'openrouter', hint: 'Many models, one key' },
      { p: 'compatible', hint: 'Ollama, LM Studio, any OpenAI-compatible server' }
    ]
  },
  { title: 'Offline', items: [{ p: 'mock', hint: 'A stand-in with no AI, to try things out' }] }
]

/** What the menu says about a subscription: found and logged in, or what is missing. */
export function cliNote(st: CliStatus | undefined): { ok: boolean; text: string } | null {
  if (!st) return null
  if (!st.installed) return { ok: false, text: 'Not installed' }
  if (st.loggedIn === false) return { ok: false, text: 'Not logged in' }
  return { ok: true, text: st.version ? `Ready · v${st.version}` : 'Ready' }
}

/** Asks once per run whether Claude Code and Codex are installed and logged in; the answer rarely changes while the app is open. */
export function loadClis(): void {
  if (!useStore.getState().clis) void api().detectClis().then((c) => useStore.getState().set({ clis: c }))
}

/** Moves a chat that has not started yet to another provider; a key provider with no key opens Settings instead. */
export function chooseProvider(agent: AgentSpec, p: ProviderKind): void {
  if (p === agent.provider) return
  const s = useStore.getState()
  if (needsKey(p) && !s.keyed.includes(p)) return s.set({ modal: { kind: 'settings', tab: 'providers' } })
  void api()
    .saveChat({ ...agent, ...onProvider(agent, p, s.settings?.catalog ?? {}, s.settings?.chatDefaults) })
    .catch((e) => s.toast('error', String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
}

/**
 * Who the chat is talking to: Claude, ChatGPT, an API key, or the offline stand-in. It can change
 * until the conversation starts; after that the chat keeps its provider (its model can still change).
 */
export function ProviderPicker({ agent, locked }: { agent: AgentSpec; locked: boolean }) {
  const [open, setOpen] = useState(false)
  // the subscriptions come first; the API-key providers fold away unless the chat is on one
  const [keysOpen, setKeysOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const keyed = useStore((s) => s.keyed)
  const clis = useStore((s) => s.clis)

  useEffect(() => {
    if (!open) return
    loadClis()
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  const pick = (p: ProviderKind) => {
    setOpen(false)
    chooseProvider(agent, p)
  }

  if (locked)
    return (
      <span
        className="flex items-center gap-1.5 rounded-lg py-0.5 pl-0.5 pr-1.5 text-[11px] font-semibold text-indigo-100/90"
        title={`This conversation is on ${PROVIDER_NAME[agent.provider]}. You can change the model; to switch to another provider, start a new chat (or a fresh start).`}
        data-testid="composer-provider"
        data-locked=""
      >
        <ProviderMark p={agent.provider} size={18} />
        {PROVIDER_NAME[agent.provider]}
        <Lock size={10} className="text-indigo-300/50" />
      </span>
    )
  return (
    <div className="relative" ref={box}>
      <button
        className={`lift-mark row flex items-center gap-1.5 rounded-lg border py-0.5 pl-0.5 pr-2 text-[11px] font-semibold ${open ? 'border-violet-400/60 bg-violet-500/15 text-white shadow-[0_0_0_3px_rgb(139_92_246/0.12)]' : 'border-white/10 text-indigo-100 hover:border-white/25 hover:bg-white/5'}`}
        onClick={() => (setOpen(!open), setKeysOpen(GROUPS.some((g) => g.folded && g.items.some((i) => i.p === agent.provider))))}
        title="Who this chat talks to. You can change it until the conversation starts."
        data-testid="composer-provider"
      >
        <ProviderMark p={agent.provider} size={18} />
        {PROVIDER_NAME[agent.provider]}
        <ChevronDown size={11} className={`text-indigo-300/70 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="glass menu-pop absolute bottom-full left-0 z-40 mb-2 w-[350px] rounded-2xl p-1.5 shadow-2xl" style={{ background: 'rgb(10 12 28 / 0.97)' }} data-testid="provider-menu">
          {GROUPS.map((g) => (
            <div key={g.title} className="mb-1 last:mb-0">
              {g.folded ? (
                <button className="flex w-full items-center gap-1 px-2 pb-0.5 pt-1.5 text-[9.5px] font-bold uppercase tracking-[0.14em] text-indigo-300/50 hover:text-indigo-200" onClick={() => setKeysOpen(!keysOpen)} data-testid="provider-more">
                  <ChevronRight size={10} className={`transition-transform duration-200 ${keysOpen ? 'rotate-90' : ''}`} />
                  {g.title} <span className="font-normal normal-case tracking-normal">({g.items.length})</span>
                </button>
              ) : (
                <div className="px-2 pb-0.5 pt-1.5 text-[9.5px] font-bold uppercase tracking-[0.14em] text-indigo-300/50">{g.title}</div>
              )}
              {(!g.folded || keysOpen) && (
                <div className={g.folded ? 'msg-in' : ''}>
                  {g.items.map(({ p, hint }) => {
                    const on = p === agent.provider
                    const note = p === 'claude-cli' ? cliNote(clis?.claude) : p === 'codex-cli' ? cliNote(clis?.codex) : null
                    const noKey = needsKey(p) && !keyed.includes(p)
                    return (
                      <button
                        key={p}
                        className={`lift-mark row relative flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left ${on ? 'bg-white/[0.06]' : 'hover:bg-white/[0.045]'}`}
                        style={on ? { boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${providerTint(p)} 45%, transparent)` } : undefined}
                        onClick={() => pick(p)}
                        data-testid={`provider-${p}`}
                      >
                        <ProviderMark p={p} size={g.folded ? 24 : 30} className={noKey ? 'opacity-60' : ''} />
                        <span className="min-w-0 flex-1">
                          <span className={`block text-[12.5px] font-semibold ${noKey ? 'text-indigo-200/60' : 'text-indigo-50'}`}>{PROVIDER_NAME[p]}</span>
                          <span className="block truncate text-[10.5px] text-indigo-300/55">{hint}</span>
                        </span>
                        {note && (
                          <span className={`flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10px] ${note.ok ? 'bg-emerald-400/10 text-emerald-200/90' : 'bg-amber-400/10 text-amber-200'}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${note.ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                            {note.text}
                          </span>
                        )}
                        {noKey && (
                          <span className="flex shrink-0 items-center gap-1 text-[10px] text-indigo-300/60">
                            <KeyRound size={10} /> add key
                          </span>
                        )}
                        {on && <Check size={14} className="pop shrink-0 text-violet-200" />}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
