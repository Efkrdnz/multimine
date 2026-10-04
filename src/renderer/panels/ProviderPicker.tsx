import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, KeyRound, Lock } from 'lucide-react'
import { needsKey } from '@shared/catalog'
import { PROVIDER_COLOR, PROVIDER_NAME, onProvider } from '@shared/chat'
import type { AgentSpec, CliStatus, ProviderKind } from '@shared/types'
import { EMPTY_MAP, api, useStore } from '../state/store'

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
function cliNote(st: CliStatus | undefined): { ok: boolean; text: string } | null {
  if (!st) return null
  if (!st.installed) return { ok: false, text: 'not installed' }
  if (st.loggedIn === false) return { ok: false, text: 'not logged in' }
  return { ok: true, text: st.version ? `v${st.version}` : 'ready' }
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
  const catalog = useStore((s) => s.settings?.catalog ?? EMPTY_MAP)
  const defaults = useStore((s) => s.settings?.chatDefaults)

  useEffect(() => {
    if (!open) return
    // ask once per run whether the CLIs are there; the answer rarely changes while the app is open
    if (!useStore.getState().clis) void api().detectClis().then((c) => useStore.getState().set({ clis: c }))
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
    if (p === agent.provider) return
    if (needsKey(p) && !keyed.includes(p)) return useStore.getState().set({ modal: { kind: 'settings', tab: 'providers' } })
    void api()
      .saveChat({ ...agent, ...onProvider(agent, p, catalog, defaults) })
      .catch((e) => useStore.getState().toast('error', String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
  }

  const dot = <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PROVIDER_COLOR[agent.provider], boxShadow: `0 0 6px ${PROVIDER_COLOR[agent.provider]}` }} />
  if (locked)
    return (
      <span
        className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-indigo-100/90"
        title={`This conversation is on ${PROVIDER_NAME[agent.provider]}. You can change the model; to switch to another provider, start a new chat (or a fresh start).`}
        data-testid="composer-provider"
        data-locked=""
      >
        {dot}
        {PROVIDER_NAME[agent.provider]}
        <Lock size={10} className="text-indigo-300/50" />
      </span>
    )
  return (
    <div className="relative" ref={box}>
      <button
        className={`flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold transition ${open ? 'border-violet-400/60 bg-violet-500/15 text-white' : 'border-white/10 text-indigo-100 hover:border-white/25 hover:bg-white/5'}`}
        onClick={() => (setOpen(!open), setKeysOpen(GROUPS.some((g) => g.folded && g.items.some((i) => i.p === agent.provider))))}
        title="Who this chat talks to. You can change it until the conversation starts."
        data-testid="composer-provider"
      >
        {dot}
        {PROVIDER_NAME[agent.provider]}
        <ChevronDown size={11} className={`text-indigo-300/70 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="glass rise absolute bottom-full left-0 z-40 mb-2 w-[340px] rounded-xl p-1.5 shadow-2xl" style={{ background: 'rgb(10 12 28 / 0.97)' }} data-testid="provider-menu">
          {GROUPS.map((g) => (
            <div key={g.title} className="mb-1 last:mb-0">
              {g.folded ? (
                <button className="flex w-full items-center gap-1 px-2 pb-0.5 pt-1.5 text-[9.5px] font-bold uppercase tracking-[0.14em] text-indigo-300/50 hover:text-indigo-200" onClick={() => setKeysOpen(!keysOpen)} data-testid="provider-more">
                  <ChevronRight size={10} className={`transition ${keysOpen ? 'rotate-90' : ''}`} />
                  {g.title} <span className="font-normal normal-case tracking-normal">({g.items.length})</span>
                </button>
              ) : (
                <div className="px-2 pb-0.5 pt-1.5 text-[9.5px] font-bold uppercase tracking-[0.14em] text-indigo-300/50">{g.title}</div>
              )}
              {(!g.folded || keysOpen) && g.items.map(({ p, hint }) => {
                const on = p === agent.provider
                const note = p === 'claude-cli' ? cliNote(clis?.claude) : p === 'codex-cli' ? cliNote(clis?.codex) : null
                const noKey = needsKey(p) && !keyed.includes(p)
                return (
                  <button key={p} className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left ${on ? 'bg-violet-500/20' : 'hover:bg-white/5'}`} onClick={() => pick(p)} data-testid={`provider-${p}`}>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PROVIDER_COLOR[p] }} />
                    <span className="min-w-0 flex-1">
                      <span className={`block text-[12.5px] ${noKey ? 'text-indigo-200/60' : 'text-indigo-50'}`}>{PROVIDER_NAME[p]}</span>
                      <span className="block truncate text-[10.5px] text-indigo-300/55">{hint}</span>
                    </span>
                    {note && <span className={`shrink-0 text-[10px] ${note.ok ? 'text-emerald-300/80' : 'text-amber-300'}`}>{note.text}</span>}
                    {noKey && (
                      <span className="flex shrink-0 items-center gap-1 text-[10px] text-indigo-300/60">
                        <KeyRound size={10} /> add key
                      </span>
                    )}
                    {on && <Check size={13} className="shrink-0 text-violet-300" />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
