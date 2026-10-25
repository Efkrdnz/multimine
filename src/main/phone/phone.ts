import { join } from 'node:path'
import type { MainEvent, PhoneSettings, PhoneState, WaitingItem } from '@shared/types'
import type { AppConfig } from '../store/appConfig'
import { PhoneServer, type PhoneBrain } from './server'
import { TwilioClient } from './twilio'
import { FixedUrl, QuickTunnel, type PublicUrl } from './tunnel'

/** Where the auth token and the PIN are kept: with the API keys, encrypted. */
export const TOKEN_KEY = 'twilio-token'
export const PIN_KEY = 'phone-pin'

export interface PhoneDeps {
  config: AppConfig
  userDataDir: string
  emit: (e: MainEvent) => void
  brain: PhoneBrain
  /** Everything waiting on the user, in every open project. */
  waiting: () => WaitingItem[]
  /** Seconds since the user last touched the computer (Electron's powerMonitor); none: never away. */
  idleSeconds?: () => number
  fetcher?: typeof fetch
  /** The public address (tests pass a fixed one); default: the user's own URL, or a Cloudflare tunnel. */
  publicUrl?: (s: PhoneSettings) => PublicUrl
  now?: () => number
  /** How often the away check runs (default 30 s). */
  tickMs?: number
}

const minutesOf = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : null
}

/** Whether `now` (local time) is in the quiet hours; a range past midnight (23:00-08:00) wraps. */
export function inQuietHours(q: PhoneSettings['quietHours'], now: Date): boolean {
  if (!q.enabled) return false
  const from = minutesOf(q.from)
  const to = minutesOf(q.to)
  if (from == null || to == null || from === to) return false
  const t = now.getHours() * 60 + now.getMinutes()
  return from < to ? t >= from && t < to : t >= from || t < to
}

/** A phone number as Twilio wants it: + and digits. */
export const e164 = (n: string) => {
  const d = n.replace(/[^\d+]/g, '')
  return d.startsWith('+') ? `+${d.slice(1).replace(/\+/g, '')}` : d ? `+${d}` : ''
}

/**
 * The phone line to Tuesday: a local server for Twilio's webhooks, a public address for it (a
 * Cloudflare quick tunnel unless the user has their own), the Twilio number pointed at it, and a
 * watch that calls the user when a chat waits on them while they are away from the computer.
 */
export class Phone {
  readonly server: PhoneServer
  private tunnel: PublicUrl | null = null
  private base: string | null = null
  private st: PhoneState = { status: 'off', call: null, secrets: { token: false, pin: false } }
  private timer: ReturnType<typeof setInterval> | null = null
  private connected = ''
  private starting: Promise<void> | null = null
  /** Waiting items already called about: one call per question. */
  private calledFor = new Set<string>()
  private lastCallAt = 0
  private dialing = false

  constructor(private readonly d: PhoneDeps) {
    this.server = new PhoneServer({
      authToken: () => d.config.getKey(TOKEN_KEY) ?? '',
      pin: () => d.config.getKey(PIN_KEY) ?? '',
      userNumber: () => this.settings.myNumber,
      voice: () => ({ voice: this.settings.voice.trim(), language: this.settings.language.trim() || 'en-US' }),
      publicBase: () => this.base,
      brain: d.brain,
      onCall: (call) => this.set({ call: call ? { outbound: call.outbound, since: this.now() } : null })
    })
  }

  private get settings(): PhoneSettings {
    return this.d.config.settings.phone
  }

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }

  private secrets() {
    return { token: !!this.d.config.getKey(TOKEN_KEY), pin: !!this.d.config.getKey(PIN_KEY) }
  }

  state(): PhoneState {
    return { ...this.st, secrets: this.secrets() }
  }

  private set(patch: Partial<PhoneState>): void {
    this.st = { ...this.st, ...patch }
    this.d.emit({ type: 'phone', state: this.state() })
  }

  /** What setting up depends on: a change to any of it means setting up again. */
  private connectionKey(): string {
    const s = this.settings
    return JSON.stringify([s.enabled, s.accountSid.trim(), e164(s.twilioNumber), s.publicUrl.trim(), this.d.config.getKey(TOKEN_KEY) ?? ''])
  }

  /** Saves the auth token and the PIN (null removes one, undefined leaves it). */
  async setSecrets(token?: string | null, pin?: string | null): Promise<PhoneState> {
    if (typeof pin === 'string' && !/^\d{4,8}$/.test(pin.trim())) throw new Error('The PIN is 4 to 8 digits.')
    if (token !== undefined) await this.d.config.setKey(TOKEN_KEY, token?.trim() || null)
    if (pin !== undefined) await this.d.config.setKey(PIN_KEY, pin?.trim() || null)
    this.set({})
    return this.state()
  }

  /** Follows the settings: off, or set up (again, when what it depends on changed or it failed). */
  async apply(force = false): Promise<PhoneState> {
    if (!this.settings.enabled) {
      await this.stop()
      return this.state()
    }
    if (!force && this.connectionKey() === this.connected && (this.st.status === 'ready' || this.st.status === 'starting')) return this.state()
    this.starting ??= this.connect().finally(() => (this.starting = null))
    await this.starting
    return this.state()
  }

  private async connect(): Promise<void> {
    const s = this.settings
    const token = this.d.config.getKey(TOKEN_KEY) ?? ''
    this.connected = this.connectionKey()
    const missing = [!s.accountSid.trim() && 'the Account SID', !token && 'the auth token', !e164(s.twilioNumber) && 'the Twilio number', !e164(s.myNumber) && 'your number'].filter(Boolean)
    if (missing.length) return this.set({ status: 'error', detail: `Missing ${missing.join(', ')}.`, url: undefined })
    this.set({ status: 'starting', detail: s.publicUrl.trim() ? 'Connecting…' : 'Opening a Cloudflare tunnel…', url: undefined })
    try {
      await this.tunnel?.stop()
      this.base = null
      const port = await this.server.start()
      const tunnel: PublicUrl = this.d.publicUrl?.(s) ?? (s.publicUrl.trim() ? new FixedUrl(s.publicUrl.trim()) : new QuickTunnel(join(this.d.userDataDir, 'bin'), this.d.fetcher))
      tunnel.onLost = (why: string) => {
        this.set({ status: 'error', detail: `The connection dropped (${why}); setting it up again…` })
        setTimeout(() => void this.apply(true), 5000)
      }
      this.tunnel = tunnel
      const base = await tunnel.start(port)
      this.base = base
      this.set({ detail: 'Pointing your Twilio number here…' })
      const twilio = this.client()
      await twilio.setVoiceUrl(await twilio.numberSid(e164(s.twilioNumber)), `${base}/voice/incoming`)
      this.set({ status: 'ready', detail: undefined, url: base })
      this.timer ??= setInterval(() => void this.tick(), this.d.tickMs ?? 30_000)
    } catch (e) {
      this.set({ status: 'error', detail: (e as Error).message ?? String(e) })
    }
  }

  private client(): TwilioClient {
    return new TwilioClient({ accountSid: this.settings.accountSid.trim(), authToken: this.d.config.getKey(TOKEN_KEY) ?? '' }, this.d.fetcher)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.tunnel?.stop()
    this.tunnel = null
    this.base = null
    await this.server.stop()
    this.connected = ''
    if (this.st.status !== 'off' || this.st.call) this.set({ status: 'off', detail: undefined, url: undefined, call: null })
  }

  /** Rings the user's phone now; Tuesday speaks when they answer. */
  async callMe(): Promise<void> {
    if (this.st.status !== 'ready' || !this.base) throw new Error('The phone is not connected yet.')
    if (this.server.activeCall()) throw new Error('A call is already going on.')
    this.dialing = true
    try {
      this.lastCallAt = this.now()
      await this.client().call({ to: e164(this.settings.myNumber), from: e164(this.settings.twilioNumber), url: `${this.base}/voice/outbound`, statusCallback: `${this.base}/voice/status` })
    } finally {
      this.dialing = false
    }
  }

  /**
   * The away check: a chat has been waiting on the user for a minute or more, the computer has been
   * idle for the set time, it is not the quiet hours, no call is going on, and the last call was
   * more than five minutes ago. Each waiting item is called about once.
   */
  async tick(): Promise<boolean> {
    const s = this.settings
    if (this.st.status !== 'ready' || !s.callWhenAway || this.dialing || this.server.activeCall()) return false
    const now = this.now()
    if (inQuietHours(s.quietHours, new Date(now))) return false
    if ((this.d.idleSeconds?.() ?? 0) < Math.max(1, s.awayMinutes) * 60) return false
    const fresh = this.d.waiting().filter((w) => w.dir && !this.calledFor.has(w.item.id) && now - w.item.ts >= 60_000)
    if (!fresh.length || now - this.lastCallAt < 5 * 60_000) return false
    for (const w of fresh) this.calledFor.add(w.item.id)
    try {
      await this.callMe()
      return true
    } catch (e) {
      this.set({ detail: `Could not call you: ${(e as Error).message}` })
      return false
    }
  }

  /** A hard stop the caller wants allowed, during a call: the keypad takes the PIN after Tuesday's reply. */
  armHardStop(itemId: string, title: string, approve: boolean): boolean {
    const call = this.server.activeCall()
    if (!call) return false
    this.server.armHardStop(call.sid, itemId, title, approve)
    return true
  }

  onCall(): boolean {
    return !!this.server.activeCall()
  }
}
