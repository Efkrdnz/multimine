import { useEffect, useState } from 'react'
import { ChevronRight, Loader2, Send } from 'lucide-react'
import type { AppSettings, TelegramSettings as Settings } from '@shared/types'
import { api, useStore } from '../state/store'

const STATUS = {
  off: { label: 'Off', cls: 'bg-white/10 text-indigo-200' },
  starting: { label: 'Connecting…', cls: 'bg-sky-500/20 text-sky-200' },
  ready: { label: 'Connected', cls: 'bg-emerald-500/20 text-emerald-200' },
  error: { label: 'Problem', cls: 'bg-red-500/20 text-red-200' }
} as const

const VOICE = { groq: 'your Groq key', openai: 'your OpenAI key', google: 'your Gemini key' } as const
const SPEECH = { auto: 'Whichever key there is', groq: 'Groq (listening only)', openai: 'OpenAI', google: 'Gemini' } as const

/** Settings -> Tuesday -> Telegram: the user's own bot, pairing, and when Tuesday messages them. */
export function TelegramSettings({ settings }: { settings: AppSettings }) {
  const t = settings.telegram
  const name = settings.tuesday.name || 'Tuesday'
  const state = useStore((s) => s.telegram)
  const [token, setToken] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [help, setHelp] = useState(!t.ownerChatId)
  const toast = useStore.getState().toast
  useEffect(() => {
    void api()
      .telegramState()
      .then((telegram) => useStore.getState().set({ telegram }))
      .catch(() => undefined)
  }, [])
  const save = (patch: Partial<Settings>) => void api().updateSettings({ telegram: { ...t, ...patch } })

  const connect = async () => {
    setBusy(true)
    try {
      await api().updateSettings({ telegram: { ...t, enabled: true } })
      const st = token.trim() ? await api().telegramSetToken(token.trim()) : await api().telegramConnect()
      setToken('')
      if (st.status === 'error') toast('error', st.detail ?? 'Telegram did not connect.')
    } catch (e) {
      toast('error', String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }
  const look = STATUS[state?.status ?? 'off']

  return (
    <section className="space-y-3" data-testid="telegram-settings">
      <div className="flex items-center gap-2">
        <Send size={15} className="text-sky-300" />
        <div className="label !mb-0">Telegram</div>
        <span className={`rounded-full px-2 py-px text-[10.5px] font-semibold ${look.cls}`} data-testid="telegram-status">
          {state?.status === 'starting' && <Loader2 size={10} className="mr-1 inline animate-spin" />}
          {look.label}
        </span>
        {state?.paired && <span className="text-[11px] text-emerald-200/80">paired with {state.paired}</span>}
        <span className="flex-1" />
        {state?.paired && state.status === 'ready' && (
          <button className="btn !py-1 !text-xs" onClick={() => void api().telegramTest().then(() => toast('info', 'Sent you a message on Telegram.'), (e) => toast('error', String(e.message ?? e)))} data-testid="telegram-test">
            Send a test message
          </button>
        )}
      </div>
      {state?.detail && <div className={`text-[11.5px] ${state.status === 'error' ? 'text-red-300' : 'text-indigo-200/70'}`}>{state.detail}</div>}

      {state?.status === 'ready' && !state.paired && state.pairCode && (
        <div className="rounded-xl border border-sky-400/30 bg-sky-500/10 p-3 text-sm" data-testid="telegram-pair">
          Open{' '}
          {state.bot ? (
            <button className="font-semibold text-sky-200 underline" onClick={() => void api().openPath(`https://t.me/${state.bot}`)}>
              @{state.bot}
            </button>
          ) : (
            'your bot'
          )}{' '}
          in Telegram and send it this code: <span className="ml-1 rounded bg-black/40 px-2 py-0.5 font-mono text-base font-bold tracking-widest text-white" data-testid="telegram-code">{state.pairCode}</span>
          <div className="mt-1 text-[11px] text-indigo-200/70">From then on it answers only you.</div>
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-indigo-200/80">
        <button className="flex w-full items-center gap-1 text-left font-semibold text-indigo-100" onClick={() => setHelp(!help)}>
          <ChevronRight size={12} className={`transition ${help ? 'rotate-90' : ''}`} /> How to set it up (free, two minutes)
        </button>
        {help && (
          <ol className="mt-2 list-decimal space-y-1 pl-5 leading-relaxed">
            <li>
              In Telegram, open <b>@BotFather</b>, send <span className="font-mono">/newbot</span>, and give the bot a name (Tuesday) and a username ending in "bot".
            </li>
            <li>BotFather replies with a token like 123456:ABC-DEF…: paste it below and press Save & connect.</li>
            <li>Send your bot the code that appears here. That pairs it with you; anyone else who finds the bot gets nowhere.</li>
            <li>
              Voice notes need a key for speech-to-text in Settings -&gt; Providers: Groq or Gemini (both have free tiers) or OpenAI. Nothing has to reach this computer from outside: Multimine asks Telegram for messages itself.
            </li>
          </ol>
        )}
      </div>

      <div className="flex items-end gap-2 rounded-xl border border-white/10 bg-black/20 p-3">
        <div className="min-w-0 flex-1">
          <label className="label">Bot token</label>
          <input className="field !py-1 font-mono text-xs" type="password" value={token} placeholder={state?.secrets.token ? 'saved (paste to replace)' : 'from @BotFather'} onChange={(e) => setToken(e.target.value)} data-testid="telegram-token" />
        </div>
        <button className="btn btn-primary !py-1 !text-xs" disabled={busy || (!token.trim() && !state?.secrets.token)} onClick={() => void connect()} data-testid="telegram-connect">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Save & connect
        </button>
        {t.enabled && (
          <button className="btn !py-1 !text-xs" onClick={() => save({ enabled: false })} data-testid="telegram-off">
            Turn off
          </button>
        )}
        {state?.paired && (
          <button className="btn !py-1 !text-xs" onClick={() => void api().telegramUnpair()} data-testid="telegram-unpair">
            Unpair
          </button>
        )}
      </div>

      <div className="flex items-end gap-2 rounded-xl border border-white/10 bg-black/20 p-3">
        <div className="w-48">
          <label className="label">PIN for hard stops</label>
          <input className="field !py-1 font-mono text-xs" type="password" inputMode="numeric" value={pin} placeholder={state?.secrets.pin ? 'saved (type to replace)' : '4 to 8 digits'} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} data-testid="telegram-pin" />
        </div>
        <button
          className="btn !py-1 !text-xs"
          disabled={pin.length < 4}
          onClick={() =>
            void api()
              .phoneSetSecrets(undefined, pin)
              .then(() => (setPin(''), toast('info', 'PIN saved.')), (e) => toast('error', String(e.message ?? e)))
          }
          data-testid="telegram-pin-save"
        >
          Save PIN
        </button>
        <div className="pb-1 text-[11px] text-indigo-300/60">The same PIN as phone calls. Without one, pushes and the like can only be allowed in the app.</div>
      </div>

      <div className="space-y-2 rounded-xl border border-white/10 bg-black/20 p-3 text-sm">
        <label className="flex items-center gap-2">
          When a chat asks something, message me
          <select className="field !w-auto !py-0.5 text-xs" value={t.notify} onChange={(e) => save({ notify: e.target.value as Settings['notify'] })} data-testid="telegram-notify">
            <option value="away">when I'm away for</option>
            <option value="always">always</option>
            <option value="off">never</option>
          </select>
          {t.notify === 'away' && (
            <>
              <input className="field !w-14 !py-0.5 text-center text-xs" type="number" min={1} max={240} value={t.awayMinutes} onChange={(e) => save({ awayMinutes: Math.max(1, Math.min(240, Number(e.target.value) || 5)) })} />
              minutes
            </>
          )}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={t.quietHours.enabled} onChange={(e) => save({ quietHours: { ...t.quietHours, enabled: e.target.checked } })} />
          Silently between
          <input className="field !w-32 !py-0.5 text-center text-xs" type="time" value={t.quietHours.from} onChange={(e) => save({ quietHours: { ...t.quietHours, from: e.target.value } })} />
          and
          <input className="field !w-32 !py-0.5 text-center text-xs" type="time" value={t.quietHours.to} onChange={(e) => save({ quietHours: { ...t.quietHours, to: e.target.value } })} />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={t.voiceReplies} onChange={(e) => save({ voiceReplies: e.target.checked })} data-testid="telegram-voice-replies" />
          Answer my voice notes with voice notes <span className="text-[11px] text-indigo-300/60">(needs a Gemini or OpenAI key)</span>
        </label>
        <label className="flex items-center gap-2">
          Voice uses
          <select className="field !w-auto !py-0.5 text-xs" value={t.speech ?? 'auto'} onChange={(e) => save({ speech: e.target.value as Settings['speech'] })} data-testid="telegram-speech">
            {(Object.keys(SPEECH) as (keyof typeof SPEECH)[]).map((k) => (
              <option key={k} value={k}>
                {SPEECH[k]}
              </option>
            ))}
          </select>
        </label>
        <div className="text-[11px] text-indigo-300/60">
          Voice notes: {state?.voice ? `understood with ${VOICE[state.voice]}` : 'add a Groq, Gemini or OpenAI key in Providers to send them (Groq and Gemini have free tiers)'}
          {state?.voice && (state.speaks ? `; replies spoken with ${VOICE[state.speaks]}.` : '; spoken replies need a Gemini or OpenAI key.')} A push, a publish or deleting history needs your PIN, sent as a message that {name} deletes at once.
        </div>
      </div>
    </section>
  )
}
