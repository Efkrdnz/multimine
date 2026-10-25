import { randomInt } from 'node:crypto'
import type { MainEvent, TelegramSettings, TelegramState, WaitingItem } from '@shared/types'
import type { AppConfig } from '../store/appConfig'
import { inQuietHours, PIN_KEY } from '../phone/phone'
import { TelegramApi, type TgCallback, type TgMessage, type TgUpdate } from './api'
import { itemMessage } from './text'
import { speak, transcribe, transcriber } from './voice'

export const TOKEN_KEY = 'telegram-token'

export interface TelegramDeps {
  config: AppConfig
  emit: (e: MainEvent) => void
  /** Everything waiting on the user, in every open project. */
  waiting: () => WaitingItem[]
  answer: (itemId: string, answers: Record<string, string>) => void
  decide: (itemId: string, approved: boolean, note?: string) => void
  /** One exchange with Tuesday: what the user wrote (or said), its reply. */
  ask: (text: string, voice: boolean) => Promise<string>
  /** The workspace in a few lines, for /status (no model involved). */
  status: () => string
  name: () => string
  idleSeconds?: () => number
  fetcher?: typeof fetch
  now?: () => number
  /** Seconds a poll waits for news (Telegram holds the request open). */
  pollSeconds?: number
  tickMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Tuesday on Telegram, through the user's own bot. It asks Telegram for news itself (long
 * polling), so nothing has to reach this computer from outside. Only the chat that sent the
 * pairing code is answered. What chats wait on goes to the user as messages with answer buttons;
 * anything they write or say goes to Tuesday. A hard stop needs the PIN, sent as a message that is
 * deleted at once and never reaches Tuesday.
 */
export class Telegram {
  private st: TelegramState = { status: 'off', secrets: { token: false, pin: false }, voice: null }
  private api: TelegramApi | null = null
  private gen = 0
  private abort: AbortController | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private pairCode = ''
  /** The message each waiting item was sent as, to update once it is answered. */
  private sent = new Map<string, { messageId: number; text: string }>()
  /** First seen, per waiting item: 'always' still gives the user a moment to answer at the computer. */
  private seen = new Map<string, number>()
  /** A hard stop waiting for the PIN. */
  private pendingPin: { itemId: string; title: string } | null = null
  /** Tuesday's turns from Telegram, one after another. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly d: TelegramDeps) {}

  private get settings(): TelegramSettings {
    return this.d.config.settings.telegram
  }

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }

  state(): TelegramState {
    const key = (p: string) => this.d.config.getKey(p)
    return {
      ...this.st,
      paired: this.settings.ownerChatId ? (this.settings.ownerName ?? 'you') : undefined,
      pairCode: this.settings.ownerChatId || this.st.status !== 'ready' ? undefined : this.pairCode,
      secrets: { token: !!key(TOKEN_KEY), pin: !!key(PIN_KEY) },
      voice: transcriber((p) => key(p))
    }
  }

  private set(patch: Partial<TelegramState>): void {
    this.st = { ...this.st, ...patch }
    this.d.emit({ type: 'telegram', state: this.state() })
  }

  async setToken(token: string | null): Promise<TelegramState> {
    await this.d.config.setKey(TOKEN_KEY, token?.trim() || null)
    this.set({})
    return this.state()
  }

  /** Follows the settings: off, or connected (again, when `force`). */
  async apply(force = false): Promise<TelegramState> {
    if (!this.settings.enabled) {
      await this.stop()
      return this.state()
    }
    if (!force && (this.st.status === 'ready' || this.st.status === 'starting')) return this.state()
    await this.connect()
    return this.state()
  }

  private async connect(): Promise<void> {
    await this.stop(false)
    const token = this.d.config.getKey(TOKEN_KEY)
    if (!token) return this.set({ status: 'error', detail: 'Missing the bot token.' })
    this.set({ status: 'starting', detail: 'Connecting to Telegram…' })
    const api = new TelegramApi(token, this.d.fetcher)
    try {
      const me = await api.getMe()
      this.api = api
      this.pairCode ||= String(randomInt(100_000, 1_000_000))
      const gen = ++this.gen
      this.abort = new AbortController()
      this.set({ status: 'ready', detail: undefined, bot: me.username })
      void this.loop(api, gen)
      this.timer ??= setInterval(() => void this.tick(), this.d.tickMs ?? 20_000)
    } catch (e) {
      this.set({ status: 'error', detail: (e as Error).message })
    }
  }

  async stop(announce = true): Promise<void> {
    this.gen++
    this.abort?.abort()
    this.abort = null
    this.api = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (announce && this.st.status !== 'off') this.set({ status: 'off', detail: undefined })
  }

  /** Forgets who it is paired with; a new code pairs again. */
  async unpair(): Promise<TelegramState> {
    await this.d.config.update({ telegram: { ...this.settings, ownerChatId: undefined, ownerName: undefined } })
    this.pairCode = String(randomInt(100_000, 1_000_000))
    this.d.emit({ type: 'settings', settings: this.d.config.settings })
    this.set({})
    return this.state()
  }

  /** A message to the user now (Settings' test button). */
  async test(): Promise<void> {
    const chat = this.settings.ownerChatId
    if (!this.api || !chat) throw new Error('Telegram is not connected and paired yet.')
    await this.api.sendMessage(chat, `Hi, it's ${this.d.name()}. This is where I'll find you when a chat needs you.`)
  }

  private async loop(api: TelegramApi, gen: number): Promise<void> {
    let offset = 0
    let failures = 0
    while (this.gen === gen) {
      try {
        const updates = await api.getUpdates(offset, this.d.pollSeconds ?? 30, this.abort?.signal)
        failures = 0
        if (this.st.detail) this.set({ detail: undefined })
        for (const u of updates) {
          offset = u.update_id + 1
          await this.handle(api, u).catch((e) => this.set({ detail: `Last message failed: ${(e as Error).message}` }))
        }
      } catch (e) {
        if (this.gen !== gen) return
        failures++
        this.set({ detail: `Telegram is not answering (${(e as Error).message}); trying again…` })
        await sleep(Math.min(30_000, 1000 * 2 ** failures))
      }
    }
  }

  private isOwner(chatId: number): boolean {
    return !!this.settings.ownerChatId && this.settings.ownerChatId === chatId
  }

  private async handle(api: TelegramApi, u: TgUpdate): Promise<void> {
    if (u.callback_query) return this.tapped(api, u.callback_query)
    const m = u.message
    if (!m || m.chat.type !== 'private') return
    // what piled up while Multimine was closed is too old to act on
    if (this.now() / 1000 - m.date > 600) return
    if (!this.isOwner(m.chat.id)) return this.stranger(api, m)
    const text = (m.text ?? '').trim()
    if (this.pendingPin && text && !text.startsWith('/')) return this.pin(api, m, text)
    if (/^\/start\b/.test(text)) return void (await api.sendMessage(m.chat.id, `Hi, it's ${this.d.name()}. Tell me what to do, or ask what's going on. Send a voice note if you'd rather talk.\n\n/status: what every chat is doing\n/waiting: what is waiting for you`))
    if (/^\/status\b/.test(text)) return void (await api.sendMessage(m.chat.id, this.d.status()))
    if (/^\/waiting\b/.test(text)) return this.sendAll(api, m.chat.id)
    const voice = m.voice ?? m.audio
    if (voice) {
      const key = (p: 'groq' | 'openai' | 'google') => this.d.config.getKey(p)
      if (!transcriber(key)) return void (await api.sendMessage(m.chat.id, "I can't listen to voice notes yet: add a Groq, OpenAI or Gemini key in Multimine's Settings -> Providers (Groq and Gemini have free tiers). Or type it."))
      void api.chatAction(m.chat.id, 'typing').catch(() => undefined)
      const heard = await transcribe(await api.download(voice.file_id), key, undefined, this.d.fetcher)
      if (!heard) return void (await api.sendMessage(m.chat.id, "I couldn't make out that voice note. Try again?"))
      await api.sendMessage(m.chat.id, `🎤 "${heard}"`)
      return this.converse(api, m.chat.id, heard, true)
    }
    if (text) return this.converse(api, m.chat.id, text, false)
  }

  /** Anyone but the user: the pairing code pairs, and nothing else gets anywhere. */
  private async stranger(api: TelegramApi, m: TgMessage): Promise<void> {
    const code = /^(?:\/start\s+)?(\d{6})$/.exec((m.text ?? '').trim())?.[1]
    if (!this.settings.ownerChatId && this.pairCode && code === this.pairCode) {
      const name = m.from?.first_name || m.from?.username || 'you'
      await this.d.config.update({ telegram: { ...this.settings, ownerChatId: m.chat.id, ownerName: name } })
      this.d.emit({ type: 'settings', settings: this.d.config.settings })
      this.set({})
      await api.sendMessage(m.chat.id, `Paired. Hi ${name}, it's ${this.d.name()}. When a chat needs you I'll message you here. Ask me anything, by text or voice note.\n\n/status: what every chat is doing\n/waiting: what is waiting for you`)
      return
    }
    await api.sendMessage(m.chat.id, 'This is a private assistant.')
  }

  /** One exchange with Tuesday, after the ones before it. */
  private converse(api: TelegramApi, chatId: number, text: string, voice: boolean): Promise<void> {
    const next = this.chain.then(async () => {
      const typing = setInterval(() => void api.chatAction(chatId, 'typing').catch(() => undefined), 4500)
      void api.chatAction(chatId, 'typing').catch(() => undefined)
      let reply: string
      try {
        reply = (await this.d.ask(text, voice)).trim() || 'Done.'
      } catch (e) {
        reply = `Sorry, that went wrong: ${(e as Error).message}`
      } finally {
        clearInterval(typing)
      }
      const openai = this.d.config.getKey('openai')
      if (voice && this.settings.voiceReplies && openai) {
        try {
          const ogg = await speak(reply, openai, this.d.fetcher)
          await api.sendVoice(chatId, ogg, reply.length <= 1024 ? reply : undefined)
          if (reply.length > 1024) await api.sendMessage(chatId, reply)
        } catch {
          await api.sendMessage(chatId, reply)
        }
      } else await api.sendMessage(chatId, reply)
      if (this.pendingPin) await api.sendMessage(chatId, `To allow ${this.pendingPin.title}, send your PIN. I'll delete the message right away.`)
    })
    this.chain = next.catch(() => undefined)
    return Promise.resolve()
  }

  /** A hard stop Tuesday passed on during a Telegram turn: the user's PIN, as their next message, allows it. */
  armHardStop(itemId: string, title: string): boolean {
    if (!this.api || !this.settings.ownerChatId) return false
    this.pendingPin = { itemId, title }
    return true
  }

  private async pin(api: TelegramApi, m: TgMessage, text: string): Promise<void> {
    const h = this.pendingPin!
    this.pendingPin = null
    // the PIN does not stay in the chat's history
    await api.deleteMessage(m.chat.id, m.message_id).catch(() => undefined)
    const pin = this.d.config.getKey(PIN_KEY)
    if (!pin || text !== pin) return void (await api.sendMessage(m.chat.id, `That is not the PIN. I left ${h.title} for you to decide in the app.`))
    const w = this.d.waiting().find((x) => x.item.id === h.itemId)
    if (!w) return void (await api.sendMessage(m.chat.id, `${h.title} was already answered.`))
    this.d.decide(h.itemId, true, 'Allowed on Telegram with the PIN.')
    await this.answered(api, h.itemId, '✓ Allowed with your PIN')
    await api.sendMessage(m.chat.id, `Done: ${h.title} is allowed.`)
  }

  /** A button under a waiting item. */
  private async tapped(api: TelegramApi, c: TgCallback): Promise<void> {
    const chatId = c.message?.chat.id
    if (!chatId || !this.isOwner(chatId)) return void (await api.answerCallback(c.id).catch(() => undefined))
    const [kind, itemId, index] = (c.data ?? '').split(':')
    const w = this.d.waiting().find((x) => x.item.id === itemId)
    if (!w) {
      await api.answerCallback(c.id, 'Already answered').catch(() => undefined)
      await this.answered(api, itemId, '— answered')
      return
    }
    const it = w.item
    if (kind === 'o' && it.kind === 'question') {
      const q = it.questions?.[0]
      const opt = q?.options[Number(index)]
      if (!q || !opt) return void (await api.answerCallback(c.id, 'That option is gone').catch(() => undefined))
      this.d.answer(it.id, { [q.question]: opt.label })
      await api.answerCallback(c.id, `Sent: ${opt.label}`).catch(() => undefined)
      return this.answered(api, it.id, `✓ ${opt.label}`)
    }
    if (kind === 'y' && it.hardStop) {
      if (!this.d.config.getKey(PIN_KEY)) return void (await api.answerCallback(c.id, 'Set a PIN in Settings -> Tuesday first'))
      this.pendingPin = { itemId: it.id, title: it.title }
      await api.answerCallback(c.id).catch(() => undefined)
      await api.sendMessage(chatId, `To allow ${it.title}, send your PIN. I'll delete the message right away.`)
      return
    }
    if (kind === 'y' || kind === 'n') {
      const yes = kind === 'y'
      this.d.decide(it.id, yes)
      await api.answerCallback(c.id, yes ? 'Done' : 'Turned down').catch(() => undefined)
      return this.answered(api, it.id, it.watchdog ? (yes ? '▶ Continued' : '⏹ Stopped') : yes ? '✅ Approved' : '✋ Turned down')
    }
    await api.answerCallback(c.id).catch(() => undefined)
  }

  /** A waiting item's message, once it is answered: what was decided, no buttons. */
  private async answered(api: TelegramApi, itemId: string, how: string): Promise<void> {
    const s = this.sent.get(itemId)
    const chat = this.settings.ownerChatId
    this.sent.delete(itemId)
    if (s && chat) await api.editMessage(chat, s.messageId, `${s.text}\n\n${how}`).catch(() => undefined)
  }

  private async sendItem(api: TelegramApi, chatId: number, w: WaitingItem, silent: boolean): Promise<void> {
    const { text, buttons } = itemMessage(w)
    const msg = await api.sendMessage(chatId, text, { buttons, silent })
    this.sent.set(w.item.id, { messageId: msg.message_id, text })
  }

  private async sendAll(api: TelegramApi, chatId: number): Promise<void> {
    const items = this.d.waiting().filter((w) => w.dir)
    if (!items.length) return void (await api.sendMessage(chatId, 'Nothing is waiting for you.'))
    for (const w of items) await this.sendItem(api, chatId, w, false)
  }

  /**
   * What chats wait on, to the user: when they are away from the computer (or always, after a
   * moment to answer at the computer), each item once, silently in the quiet hours. Items
   * answered elsewhere have their message updated.
   */
  async tick(): Promise<number> {
    const api = this.api
    const chat = this.settings.ownerChatId
    if (!api || !chat || this.st.status !== 'ready') return 0
    const items = this.d.waiting().filter((w) => w.dir)
    const open = new Set(items.map((w) => w.item.id))
    for (const id of [...this.sent.keys()]) if (!open.has(id)) await this.answered(api, id, '— answered')
    for (const id of [...this.seen.keys()]) if (!open.has(id)) this.seen.delete(id)
    const now = this.now()
    for (const w of items) if (!this.seen.has(w.item.id)) this.seen.set(w.item.id, now)
    const s = this.settings
    if (s.notify === 'off') return 0
    if (s.notify === 'away' && (this.d.idleSeconds?.() ?? 0) < Math.max(1, s.awayMinutes) * 60) return 0
    const fresh = items.filter((w) => !this.sent.has(w.item.id) && (s.notify === 'away' || now - (this.seen.get(w.item.id) ?? now) >= 15_000))
    const silent = inQuietHours(s.quietHours, new Date(now))
    for (const w of fresh) await this.sendItem(api, chat, w, silent)
    return fresh.length
  }
}
