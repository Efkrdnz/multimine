import { useEffect, useState } from 'react'
import { ChevronRight, Loader2, Phone, PhoneCall } from 'lucide-react'
import type { AppSettings, PhoneSettings as Settings } from '@shared/types'
import { api, useStore } from '../state/store'

const STATUS = {
  off: { label: 'Off', cls: 'bg-white/10 text-indigo-200' },
  starting: { label: 'Connecting…', cls: 'bg-sky-500/20 text-sky-200' },
  ready: { label: 'Ready', cls: 'bg-emerald-500/20 text-emerald-200' },
  error: { label: 'Problem', cls: 'bg-red-500/20 text-red-200' }
} as const

/** Settings -> Tuesday -> Phone: the Twilio number, the PIN, and when Tuesday calls. */
export function PhoneSettings({ settings }: { settings: AppSettings }) {
  const p = settings.phone
  const name = settings.tuesday.name || 'Tuesday'
  const state = useStore((s) => s.phone)
  const [form, setForm] = useState(p)
  const [token, setToken] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [help, setHelp] = useState(!p.accountSid)
  useEffect(() => {
    void api()
      .phoneState()
      .then((phone) => useStore.getState().set({ phone }))
      .catch(() => undefined)
  }, [])
  const edit = (patch: Partial<Settings>) => setForm((f) => ({ ...f, ...patch }))
  // when it calls changes nothing about the connection: saved as it is changed
  const live = (patch: Partial<Settings>) => {
    edit(patch)
    void api().updateSettings({ phone: { ...p, ...patch } })
  }
  const toast = useStore.getState().toast

  const connect = async () => {
    setBusy(true)
    try {
      await api().phoneSetSecrets(token.trim() || undefined, pin.trim() || undefined)
      setToken('')
      setPin('')
      await api().updateSettings({ phone: { ...form, enabled: true } })
      const st = await api().phoneConnect()
      if (st.status === 'error') toast('error', st.detail ?? 'The phone did not connect.')
      else toast('info', `${name} answers your calls now.`)
    } catch (e) {
      toast('error', String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }
  const look = STATUS[state?.status ?? 'off']
  const field = (label: string, key: keyof Settings, placeholder: string, mono = true) => (
    <div>
      <label className="label">{label}</label>
      <input className={`field !py-1 text-xs ${mono ? 'font-mono' : ''}`} value={String(form[key] ?? '')} placeholder={placeholder} onChange={(e) => edit({ [key]: e.target.value } as Partial<Settings>)} data-testid={`phone-${key}`} />
    </div>
  )

  return (
    <section className="space-y-3" data-testid="phone-settings">
      <div className="flex items-center gap-2">
        <Phone size={15} className="text-cyan-300" />
        <div className="label !mb-0">Phone</div>
        <span className={`rounded-full px-2 py-px text-[10.5px] font-semibold ${look.cls}`} data-testid="phone-status">
          {state?.status === 'starting' && <Loader2 size={10} className="mr-1 inline animate-spin" />}
          {look.label}
        </span>
        {state?.call && <span className="rounded-full bg-cyan-500/20 px-2 py-px text-[10.5px] font-semibold text-cyan-100">On a call</span>}
        <span className="flex-1" />
        {state?.status === 'ready' && (
          <button className="btn !py-1 !text-xs" onClick={() => void api().phoneCallMe().then(() => toast('info', 'Calling you now…'), (e) => toast('error', String(e.message ?? e)))} data-testid="phone-call-me">
            <PhoneCall size={12} /> Call me now
          </button>
        )}
      </div>
      {state?.detail && <div className={`text-[11.5px] ${state.status === 'error' ? 'text-red-300' : 'text-indigo-200/70'}`}>{state.detail}</div>}

      <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-indigo-200/80">
        <button className="flex w-full items-center gap-1 text-left font-semibold text-indigo-100" onClick={() => setHelp(!help)}>
          <ChevronRight size={12} className={`transition ${help ? 'rotate-90' : ''}`} /> How it works and how to set it up
        </button>
        {help && (
          <ol className="mt-2 list-decimal space-y-1 pl-5 leading-relaxed">
            <li>
              Make a Twilio account and get a phone number that can take voice calls. A trial account only calls numbers you have verified, and its calls start with a short trial message.
            </li>
            <li>Copy the Account SID and the Auth token from the Twilio Console into the fields below, with the Twilio number and your own mobile number.</li>
            <li>Pick a PIN (4 to 8 digits). Calls in only come through from your number and with the PIN; a push, a publish or deleting history asks for it again on the keypad.</li>
            <li>
              <b>Save & connect.</b> Multimine opens a free Cloudflare tunnel so Twilio can reach this computer, and points your Twilio number at it. Calls work while the computer is on and Multimine is open.
            </li>
          </ol>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-black/20 p-3">
        {field('Account SID', 'accountSid', 'AC…')}
        <div>
          <label className="label">Auth token</label>
          <input className="field !py-1 font-mono text-xs" type="password" value={token} placeholder={state?.secrets.token ? 'saved (type to replace)' : 'from the Twilio Console'} onChange={(e) => setToken(e.target.value)} data-testid="phone-token" />
        </div>
        {field('Twilio number', 'twilioNumber', '+15551234567')}
        {field('Your number', 'myNumber', '+15557654321')}
        <div>
          <label className="label">PIN</label>
          <input className="field !py-1 font-mono text-xs" type="password" inputMode="numeric" value={pin} placeholder={state?.secrets.pin ? 'saved (type to replace)' : '4 to 8 digits'} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} data-testid="phone-pin" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {field('Language', 'language', 'en-US')}
          {field('Voice', 'voice', 'Polly.Joanna-Neural')}
        </div>
        <div className="col-span-2">{field('Your own public URL (optional)', 'publicUrl', 'empty: a free Cloudflare tunnel')}</div>
        <div className="col-span-2 flex items-center gap-2">
          <button className="btn btn-primary !py-1 !text-xs" disabled={busy} onClick={() => void connect()} data-testid="phone-connect">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Phone size={12} />} Save & connect
          </button>
          {p.enabled && (
            <button className="btn !py-1 !text-xs" onClick={() => void api().updateSettings({ phone: { ...p, enabled: false } })} data-testid="phone-off">
              Turn off
            </button>
          )}
          {state?.url && <span className="truncate font-mono text-[10.5px] text-indigo-300/60">{state.url}</span>}
        </div>
      </div>

      <div className="space-y-2 rounded-xl border border-white/10 bg-black/20 p-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.callWhenAway} onChange={(e) => live({ callWhenAway: e.target.checked })} data-testid="phone-away" />
          Call me when a chat asks something and I've been away for
          <input className="field !w-14 !py-0.5 text-center text-xs" type="number" min={1} max={240} value={form.awayMinutes} onChange={(e) => live({ awayMinutes: Math.max(1, Math.min(240, Number(e.target.value) || 10)) })} />
          minutes
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.quietHours.enabled} onChange={(e) => live({ quietHours: { ...form.quietHours, enabled: e.target.checked } })} />
          Never between
          <input className="field !w-32 !py-0.5 text-center text-xs" type="time" value={form.quietHours.from} onChange={(e) => live({ quietHours: { ...form.quietHours, from: e.target.value } })} />
          and
          <input className="field !w-32 !py-0.5 text-center text-xs" type="time" value={form.quietHours.to} onChange={(e) => live({ quietHours: { ...form.quietHours, to: e.target.value } })} />
        </label>
        <div className="text-[11px] text-indigo-300/60">
          Away means no mouse or keyboard on this computer. {name} calls once per question, at most every five minutes, reads it out and passes on your answer after reading it back to you.
        </div>
      </div>
    </section>
  )
}
