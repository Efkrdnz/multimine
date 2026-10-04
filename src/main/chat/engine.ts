import { addUsage, NO_USAGE } from '@shared/usage'
import { appendNote, appendStream, appendTool, closeSegments } from '@shared/segments'
import type { PlanLimits } from '../providers/planLimits'
import { exec } from 'node:child_process'
import { z } from 'zod'
import { newId } from '@shared/ids'
import { DEFAULT_CHAT_NAME, MOCK_DEFAULTS, newChat, providerLocked } from '@shared/chat'
import { CONCISE_RULES, RATE_SYSTEM, downshift, parseRating, type Difficulty, type TempModel } from '@shared/economy'
import type { AgentSpec, AgentStatus, ChatMessage, FallbackHop, InboxItem, MainEvent, MediaItem, ProviderKind, Question, TableCard, Usage } from '@shared/types'
import { cellText, parseTable, type Table } from '@shared/tables/model'
import { contextSection, tableCommandPrompt } from '@shared/tables/prompt'
import { TableStore } from '../store/tables'
import type { AppConfig } from '../store/appConfig'
import type { ProjectStore } from '../store/project'
import type { ChatStore } from '../store/chats'
import { ProviderRegistry } from '../providers/registry'
import type { HistoryItem, ToolDef, ToolOutput, TurnRequest } from '../providers/types'
import { findMediaUrls, MediaStore } from '../media/capture'
import type { McpHub } from '../mcp/hub'
import { buildSystemPrompt, toolPrompt } from './prompts'
import { buildBrief } from './continuation'
import { failureOf, isPaid, ProviderHealth, type Failure } from '../providers/limits'
import { SHORT_PROVIDER, modelLabel } from '@shared/catalog'
import { formatAnswers, Inbox } from './inbox'
import { insideProject, workspaceTools } from './workspace'
import { verdictFor, Watchdog, type Trip, type WatchVerdict } from './watchdog'
import { describeTool, duration } from '@shared/activity'

export interface EngineDeps {
  project: ProjectStore
  store: ChatStore
  config: AppConfig
  providers: ProviderRegistry
  emit: (e: MainEvent) => void
  hub?: McpHub
  /** Which providers are out of usage: shared by every project, so one app-wide instance is passed in. */
  health?: ProviderHealth
  /** The Claude plan's usage windows, app-wide like `health`. */
  planLimits?: PlanLimits
  /** The URL of a chat's endpoint on the local MCP bus (set once the bus server is up). */
  busUrl?: (chatId: string) => string | undefined
}

export interface TurnResult {
  text: string
  error?: string
}

export interface SendOptions {
  /** Quick: run this turn on the light tier of the chat's provider, then go back to its own model. */
  quick?: boolean
  /** Run this turn on exactly this cheaper model (tests). */
  temp?: TempModel | null
}

const text = (t: string, isError = false): ToolOutput => ({ text: t, isError })

/**
 * Tool output as the chat shows it. The model already has the whole thing; the window only needs
 * the start and the end, and a long run of builds would otherwise ship megabytes on every update.
 */
const CLIP = 4000
/**
 * In-process tools (API and mock chats) with the loop guard in front of each: a refused call is
 * never run, and the model gets the user's word as its result instead.
 */
export function guardTools(tools: ToolDef[], watch?: (name: string, input: unknown) => Promise<WatchVerdict>): ToolDef[] {
  if (!watch) return tools
  return tools.map((t) => ({
    ...t,
    handler: async (args: Record<string, unknown>): Promise<ToolOutput> => {
      const v = await watch(t.name, args)
      return v.ok ? t.handler(args) : { text: v.reason, isError: true }
    }
  }))
}

export function clip(out: string): string {
  return out.length <= CLIP ? out : `${out.slice(0, CLIP * 0.6)}\n\n... ${out.length - CLIP} characters not shown ...\n\n${out.slice(-CLIP * 0.4)}`
}

/**
 * Runs the project's chats: one serial turn queue per chat (different chats run in parallel), the
 * questions and permissions they wait on, fallbacks, the loop guard and usage. It has no Electron
 * in it, so tests drive it directly.
 */
export class Engine {
  /** Every chat's messages, by chat id. */
  chats: Record<string, ChatMessage[]> = {}
  media: MediaItem[] = []
  readonly inbox: Inbox
  private status = new Map<string, AgentStatus>()
  /** What each busy chat is doing, since when, and whether it has gone quiet: the live activity line. */
  private acts = new Map<string, { activity?: string; detail?: string; since: number; quiet?: string }>()
  /** When each turn last showed a sign of life (any event from its provider). */
  private lastBeat = new Map<string, number>()
  private quietTimer: ReturnType<typeof setInterval> | null = null
  /** Why a turn was stopped by the watchdog, for its result. */
  private stopReasons = new Map<string, string>()
  /** Chats already paused by the watchdog: one question at a time, even with calls in parallel. */
  private pausedNow = new Set<string>()
  /** An instruction to resume a turn with after the watchdog paused it (providers with no per-call hook). */
  private redirects = new Map<string, string>()
  private queues = new Map<string, Promise<unknown>>()
  private turns = new Set<string>()
  private controllers = new Map<string, AbortController>()
  /** Chats running their current turn on a fallback provider, and why. */
  private fallbacks = new Map<string, { provider: ProviderKind; model: string; reason: string }>()
  /** Chats running their current turn on a cheaper model than their own. */
  private temps = new Map<string, TempModel>()
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private totals: Usage = { ...NO_USAGE }
  /** Usage per chat: which one spent what. */
  private byAgent: Record<string, Usage> = {}
  private mediaStore: MediaStore

  readonly health: ProviderHealth

  constructor(private readonly d: EngineDeps) {
    this.mediaStore = new MediaStore(d.project.paths.media)
    this.health = d.health ?? new ProviderHealth((h) => d.emit({ type: 'provider-health', health: h }))
    this.inbox = new Inbox((items) => d.emit({ type: 'inbox', items }))
    this.tables = new TableStore(d.project.dir)
  }

  /** The project's tables, in `.multimine/tables/`. */
  readonly tables: TableStore

  get project(): ProjectStore {
    return this.d.project
  }

  /**
   * Stops every turn and waits (briefly) for them to wind down: the project is closing, and
   * nothing should write into it afterwards.
   */
  async close(reason: string): Promise<void> {
    this.inbox.cancelAll(reason)
    for (const c of this.controllers.values()) c.abort()
    const settled = Promise.allSettled([...this.queues.values()])
    await Promise.race([settled, new Promise((r) => setTimeout(r, 3000))])
    if (this.quietTimer) clearInterval(this.quietTimer)
    this.quietTimer = null
  }

  // ---------------------------------------------------------------- chats

  /** Loads the project's chats and the gallery; a project with no chat yet gets one. */
  async open(): Promise<void> {
    for (const chat of await this.d.store.list()) this.d.project.set(chat)
    if (!this.d.project.list().length) await this.createChat()
    this.chats = {}
    this.totals = { ...NO_USAGE }
    this.byAgent = {}
    for (const chat of this.d.project.list()) {
      const msgs = await this.d.store.loadMessages(chat.id)
      this.chats[chat.id] = msgs
      for (const m of msgs)
        if (m.usage) {
          this.totals = addUsage(this.totals, m.usage)
          this.byAgent[chat.id] = addUsage(this.byAgent[chat.id], m.usage)
        }
    }
    this.media = await this.d.store.loadMedia()
    this.emitProject()
    this.d.emit({ type: 'chat-reset', chats: this.chats })
    this.d.emit({ type: 'inbox', items: this.inbox.items })
    this.d.emit({ type: 'media', items: this.media })
    this.d.emit({ type: 'usage', total: this.totals, byAgent: this.byAgent })
  }

  private emitProject(): void {
    this.d.emit({ type: 'project', project: this.d.project.info() })
  }

  /** A new chat on the defaults from Settings; `patch` wins over them. */
  async createChat(patch: Partial<AgentSpec> = {}): Promise<AgentSpec> {
    const { id: _ignored, ...rest } = patch
    const chat = newChat(newId('c'), this.d.config.settings.chatDefaults ?? MOCK_DEFAULTS, rest)
    this.d.project.set(chat)
    await this.d.store.save(chat)
    this.chats[chat.id] ??= []
    this.emitProject()
    return chat
  }

  /** Changes a chat's settings. A different provider, model or permission is picked up by its next turn. */
  async saveChat(chat: AgentSpec): Promise<AgentSpec> {
    const before = this.d.project.get(chat.id)
    if (!before) throw new Error(`No chat ${chat.id}`)
    if (chat.provider !== before.provider && providerLocked(this.chats[chat.id] ?? []))
      throw new Error('This conversation has started, so it stays on its provider. Change the model, or start a new chat (or a fresh start) to switch.')
    const next: AgentSpec = { ...chat, id: before.id, created: before.created, updated: chat.updated || before.updated }
    this.d.project.set(next)
    await this.d.store.save(next)
    this.emitProject()
    return next
  }

  async deleteChat(id: string): Promise<void> {
    this.stop(id)
    this.d.project.delete(id)
    delete this.chats[id]
    delete this.byAgent[id]
    this.d.providers.release(`${id}|`)
    await this.d.store.remove(id)
    if (!this.d.project.list().length) await this.createChat()
    this.emitProject()
    this.d.emit({ type: 'chat-reset', chats: this.chats })
  }

  /** Empties a chat and starts its next turn on a new conversation. */
  async clearChat(id: string): Promise<void> {
    const chat = this.d.project.get(id)
    if (!chat) return
    await this.d.store.clearMessages(id)
    await this.d.store.forget(chat)
    this.chats[id] = []
    // a cleared chat is a new conversation: its warm process goes too
    this.d.providers.release(`${id}|`)
    this.d.emit({ type: 'chat-reset', chats: this.chats })
  }

  /** Moves a chat to the top of the list: it was just used. */
  private async touch(id: string): Promise<void> {
    const chat = this.d.project.get(id)
    if (!chat) return
    const next = { ...chat, updated: Date.now() }
    this.d.project.set(next)
    await this.d.store.save(next)
    this.emitProject()
  }

  // ---------------------------------------------------------------- turns

  private setStatus(agentId: string, status: AgentStatus, activity?: string, detail?: string): void {
    const prev = this.acts.get(agentId)
    const changed = this.status.get(agentId) !== status || prev?.activity !== activity || prev?.detail !== detail
    const act = { activity, detail, since: changed || !prev ? Date.now() : prev.since, quiet: changed ? undefined : prev?.quiet }
    if (status === 'idle' || status === 'error') this.acts.delete(agentId)
    else this.acts.set(agentId, act)
    this.status.set(agentId, status)
    this.emitStatus(agentId)
  }

  private emitStatus(agentId: string): void {
    const act = this.acts.get(agentId)
    this.d.emit({
      type: 'status',
      agentId,
      status: this.status.get(agentId) ?? 'idle',
      activity: act?.activity,
      detail: act?.detail,
      since: act?.since,
      quiet: act?.quiet,
      temp: this.temps.get(agentId),
      fallback: this.fallbacks.get(agentId)
    })
  }

  /**
   * Marks a busy chat quiet when nothing has come from it for a while, or one step has run for a
   * long time: the user sees it in the sidebar and the chat instead of wondering whether it is stuck.
   */
  private checkQuiet(): void {
    const quietMs = Math.max(1, this.d.config.settings.watchdog?.quietMinutes ?? 5) * 60_000
    const now = Date.now()
    for (const agentId of this.turns) {
      const act = this.acts.get(agentId)
      if (!act || this.status.get(agentId) === 'waiting') continue
      const silent = now - (this.lastBeat.get(agentId) ?? act.since)
      const running = now - act.since
      let quiet: string | undefined
      if (silent > quietMs) quiet = `No sign of life for ${duration(silent)}${act.activity ? ` (${act.activity}${act.detail ? ` ${act.detail}` : ''})` : ''}. It may be waiting on something, such as a window it opened.`
      else if (act.activity && act.activity !== 'Thinking' && act.activity !== 'Writing' && running > Math.max(quietMs * 2, 10 * 60_000)) quiet = `${act.activity}${act.detail ? ` ${act.detail}` : ''} has been running for ${duration(running)}.`
      if (quiet !== act.quiet) {
        act.quiet = quiet
        this.emitStatus(agentId)
      }
    }
    if (!this.turns.size && this.quietTimer) {
      clearInterval(this.quietTimer)
      this.quietTimer = null
    }
  }

  /**
   * The loop guard's word on a call about to run. A trip waits for the user: continue forgives it,
   * a note is handed to the model instead of running the call, and a plain no stops the turn.
   */
  private async watchCall(agentId: string, wd: Watchdog, ctl: AbortController, name: string, input: unknown): Promise<WatchVerdict> {
    if (this.pausedNow.has(agentId)) return { ok: true }
    const trip = wd.check(name, input, Date.now())
    if (!trip) return { ok: true }
    this.pausedNow.add(agentId)
    try {
      return await this.askWatchdog(agentId, wd, ctl, trip)
    } finally {
      this.pausedNow.delete(agentId)
    }
  }

  private async askWatchdog(agentId: string, wd: Watchdog, ctl: AbortController, trip: Trip): Promise<WatchVerdict> {
    const chat = this.d.project.get(agentId)
    const prev = { status: this.status.get(agentId), act: this.acts.get(agentId) }
    this.setStatus(agentId, 'waiting', 'Paused by the loop guard')
    const item = await this.inbox.watchdog(agentId, trip.title, `${trip.detail}

**Continue** lets it carry on. **Tell it** gives it an instruction instead of this step. **Stop** ends the turn.`)
    const verdict = verdictFor(item)
    if (verdict.ok) wd.forgive(trip)
    if (!verdict.ok && verdict.stop && !ctl.signal.aborted) {
      this.stopReasons.set(agentId, `Stopped by the user: ${chat?.name ?? agentId} ${trip.title}.`)
      ctl.abort()
    }
    if (prev.status && prev.status !== 'waiting' && !ctl.signal.aborted) this.setStatus(agentId, prev.status, prev.act?.activity, prev.act?.detail)
    return verdict
  }

  busy(agentId: string): boolean {
    return this.turns.has(agentId)
  }

  /**
   * Queues a turn. Turns of one chat never overlap; different chats run in parallel. `from` is
   * 'user', or the tool that sent it (`tool:<name>`), shown in the chat as where it came from.
   */
  send(agentId: string, body: string, from = 'user', opts: SendOptions = {}): Promise<TurnResult> {
    // the incoming message is shown at once, even while the chat is still busy with an earlier turn
    const chat = this.d.project.get(agentId)
    // `/table ...` (typed, or sent by the Tables tool) stays in the chat as written; its turn gets the table instructions
    const command = /^\/table(\s|$)/.test(body.trimStart()) ? ('table' as const) : undefined
    const prompt = from === 'user' || command ? body : toolPrompt(from.replace(/^tool:/, ''), body)
    const userMsg: ChatMessage = { id: newId('u'), agentId, role: 'user', from, text: prompt, ts: Date.now(), ...(command ? { command } : {}) }
    if (chat) {
      this.upsert(userMsg, true)
      void this.persist(userMsg).catch(() => undefined)
      void this.nameAfter(agentId, body)
        .then(() => this.touch(agentId))
        .catch(() => undefined)
    }
    return this.enqueue(agentId, userMsg, chat ? this.cheaperFor(chat, body, from, opts) : Promise.resolve(null))
  }

  /**
   * The cheaper model a message runs on, if any: Quick asks for the light tier; with economy's
   * rating on, one small call on the light tier rates the user's message first.
   */
  private cheaperFor(chat: AgentSpec, body: string, from: string, opts: SendOptions): Promise<TempModel | null> {
    const eco = this.d.config.settings.economy
    if (opts.temp !== undefined) return Promise.resolve(opts.temp)
    if (opts.quick) return Promise.resolve(downshift(chat, 'light', eco))
    // building a table reads code and writes careful JSON: never a light job
    if (eco.enabled && eco.autoRate && from === 'user' && !/^\/table(\s|$)/.test(body.trimStart())) return this.rate(chat, body).then((r) => downshift(chat, r, eco))
    return Promise.resolve(null)
  }

  /** Economy's rating of a message, on the light tier of the chat's provider; heavy when it cannot tell. */
  async rate(chat: AgentSpec, body: string): Promise<Difficulty> {
    const tier = this.d.config.settings.economy.tiers[chat.provider]
    const model = tier?.light || tier?.standard
    if (!model) return 'heavy'
    try {
      return parseRating(await this.complete({ ...chat, model, effort: 'low' }, RATE_SYSTEM, body.slice(0, 4000)))
    } catch {
      return 'heavy'
    }
  }

  private enqueue(agentId: string, userMsg: ChatMessage, temp: Promise<TempModel | null> = Promise.resolve(null)): Promise<TurnResult> {
    const prev = this.queues.get(agentId) ?? Promise.resolve()
    const next = prev.then(async () => this.runTurn(agentId, userMsg, (await temp) ?? undefined))
    this.queues.set(
      agentId,
      next.catch(() => undefined)
    )
    return next
  }

  /**
   * A new conversation in the same chat: the messages stay on screen, but the agent forgets them.
   * The next turn starts a clean context carrying only a short recap of where things were left.
   */
  async freshStart(agentId: string): Promise<boolean> {
    const chat = this.d.project.get(agentId)
    if (!chat || this.busy(agentId)) return false
    const before = (this.chats[agentId] ?? []).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim())
    const since = before.slice(before.map((m) => m.fresh).lastIndexOf(true) + 1).slice(-6)
    const recap = since.map((m) => `${m.role === 'user' ? (m.from === 'user' ? 'User' : `From ${m.from.replace(/^tool:/, '')}`) : 'You'}: ${clipTo(m.text.replace(/\s+/g, ' ').trim(), 500)}`).join('\n')
    await this.d.store.forget(chat)
    this.d.providers.release(`${agentId}|`)
    const msg: ChatMessage = { id: newId('n'), agentId, role: 'system', from: 'multimine', text: 'New conversation', ts: Date.now(), fresh: true, recap: recap || undefined }
    this.upsert(msg, true)
    await this.persist(msg)
    return true
  }

  /** A chat still called by its default name takes its name from the first thing the user says in it. */
  private async nameAfter(agentId: string, body: string): Promise<void> {
    const chat = this.d.project.get(agentId)
    if (!chat || chat.name !== DEFAULT_CHAT_NAME) return
    // only the first message names it: the one just sent is already in the chat
    if ((this.chats[agentId] ?? []).filter((m) => m.role === 'user').length > 1) return
    const first = body.split('\n').find((l) => l.trim())?.trim().replace(/^#+\s*/, '') ?? ''
    const name = clipTo(/^\/table(\s|$)/.test(first) ? `Table: ${first.replace(/^\/table\s*/, '')}` : first, 48)
    if (!name) return
    const next = { ...chat, name }
    this.d.project.set(next)
    await this.d.store.save(next)
    this.emitProject()
  }

  /** Runs the chat's last incoming message again (after a failed turn: an expired login, a dropped connection). */
  retry(agentId: string): Promise<TurnResult> | null {
    const last = [...(this.chats[agentId] ?? [])].reverse().find((m) => m.role === 'user')
    if (!last) return null
    const copy: ChatMessage = { ...last, id: newId('u'), ts: Date.now() }
    this.upsert(copy, true)
    void this.persist(copy).catch(() => undefined)
    return this.enqueue(agentId, copy)
  }

  stop(agentId: string): void {
    this.controllers.get(agentId)?.abort()
  }

  /** The conversation before `before` (the message this turn answers; later queued ones are not history yet). */
  private history(agentId: string, before: ChatMessage): HistoryItem[] {
    const all = this.chats[agentId] ?? []
    const upto = all.findIndex((m) => m.id === before.id)
    const earlier = upto >= 0 ? all.slice(0, upto) : all
    // a fresh start draws a line: nothing before it is this conversation's any more
    const line = earlier.map((m) => m.fresh).lastIndexOf(true)
    return earlier
      .slice(line + 1)
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim())
      .slice(-40)
      .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text }))
  }

  private upsert(msg: ChatMessage, immediate = false): void {
    const list = (this.chats[msg.agentId] ??= [])
    const i = list.findIndex((m) => m.id === msg.id)
    if (i >= 0) list[i] = msg
    else list.push(msg)
    const key = msg.id
    if (immediate) {
      clearTimeout(this.flushTimers.get(key))
      this.flushTimers.delete(key)
      this.d.emit({ type: 'chat-upsert', message: { ...msg, tools: msg.tools?.map((t) => ({ ...t })) } })
      return
    }
    if (this.flushTimers.has(key)) return
    this.flushTimers.set(
      key,
      setTimeout(() => {
        this.flushTimers.delete(key)
        const latest = this.chats[msg.agentId]?.find((m) => m.id === key)
        if (latest) this.d.emit({ type: 'chat-upsert', message: { ...latest, tools: latest.tools?.map((t) => ({ ...t })) } })
      }, 90)
    )
  }

  private async persist(msg: ChatMessage): Promise<void> {
    if (this.d.project.get(msg.agentId)) await this.d.store.appendMessage(msg)
  }

  /** A note in a chat that is not part of its conversation (a log line). */
  async note(agentId: string, body: string): Promise<void> {
    const msg: ChatMessage = { id: newId('n'), agentId, role: 'system', from: 'multimine', text: body, ts: Date.now() }
    this.upsert(msg, true)
    await this.persist(msg)
  }

  private async runTurn(agentId: string, userMsg: ChatMessage, temp?: TempModel): Promise<TurnResult> {
    const own = this.d.project.get(agentId)
    if (!own) return { text: '', error: `No chat ${agentId}` }
    // a cheaper turn runs on that model for this turn only; the chat's own settings are untouched
    const agent: AgentSpec = temp ? { ...own, model: temp.model, effort: temp.effort } : own
    if (temp) this.temps.set(agentId, temp)
    else this.temps.delete(agentId)
    const prompt = userMsg.command === 'table' ? tableCommandPrompt(userMsg.text.trimStart().replace(/^\/table\s*/, ''), await this.tables.list()) : userMsg.text
    const history = this.history(agentId, userMsg)

    this.turns.add(agentId)
    let ctl = new AbortController()
    this.controllers.set(agentId, ctl)
    this.setStatus(agentId, 'thinking', 'Thinking')
    const wd = new Watchdog(this.d.config.settings.watchdog, Date.now())
    this.lastBeat.set(agentId, Date.now())
    this.quietTimer ??= setInterval(() => this.checkQuiet(), 15_000)
    this.stopReasons.delete(agentId)
    this.redirects.delete(agentId)

    const reply: ChatMessage = { id: newId('r'), agentId, role: 'assistant', from: agentId, text: '', ts: Date.now(), streaming: true, tools: [] }
    this.upsert(reply, true)

    // The provider chain: the chat's own (or cheaper) model first, then its fallbacks. A provider
    // already known to be out of usage is skipped at the start; one that runs out mid-turn hands the
    // turn, with a brief of everything done so far, to the next - in the same reply bubble.
    const hops = this.hopsFor(own, agent)
    let i = this.startHop(hops)
    let promptNow = prompt
    let historyNow = history
    let continuing = false
    let error: string | undefined
    try {
      for (;;) {
        const hop = hops[i]
        const hopAgent: AgentSpec = { ...agent, provider: hop.provider, model: hop.model, effort: hop.effort }
        if (i > 0) {
          const why = continuing ? `${this.label(hops[i - 1])} ran out` : `${this.label(hops[0])} is ${this.health.get(hops[0].provider)?.state === 'near' ? 'near its limit' : 'out of usage'}`
          this.fallbacks.set(agentId, { provider: hop.provider, model: hop.model, reason: why })
          this.setStatus(agentId, this.status.get(agentId) ?? 'thinking')
        }
        error = await this.runHop(hopAgent, promptNow, historyNow, !continuing, reply, ctl, wd, !continuing)
        // the watchdog paused a provider it cannot hold mid-call: resume the same thread with the user's word
        const redirect = this.redirects.get(agentId)
        if (redirect && this.d.project.get(agentId)) {
          this.redirects.delete(agentId)
          ctl = new AbortController()
          this.controllers.set(agentId, ctl)
          for (const t of reply.tools ?? []) if (t.status === 'running') Object.assign(t, { status: 'error', endedAt: Date.now(), output: 'Interrupted by the watchdog.' })
          appendNote(reply, '*Paused by the loop guard; resumed with your instruction.*')
          this.upsert(reply, true)
          promptNow = redirect
          historyNow = []
          continuing = false
          error = undefined
          continue
        }
        if (!error || ctl.signal.aborted || !this.d.project.get(agentId)) break
        const failure = failureOf(error)
        if (!failure) break
        this.health.mark(hop.provider, 'exhausted', error.slice(0, 200), failure)
        const next = this.nextHop(hops, i)
        if (next < 0) break
        if (isPaid(hops[next].provider) && !own.fallbackPaidOk && !(await this.approvePaidFallback(own, hops[i], hops[next], failure))) {
          error = `${this.label(hop)} is out of usage and the paid fallback (${this.label(hops[next])}) was declined.`
          break
        }
        this.d.emit({ type: 'toast', level: 'info', text: `${own.name}: ${this.label(hop)} ${failure === 'auth' ? 'is not signed in' : 'is out of usage'} - continuing on ${this.label(hops[next])}` })
        promptNow = buildBrief({
          task: prompt,
          history,
          tools: reply.tools ?? [],
          partial: reply.text,
          ...(await this.gitDiffBrief()),
          previous: this.label(hop),
          reason: failure === 'auth' ? 'its login or key stopped working' : failure === 'rate' ? 'it was rate limited' : 'it ran out of usage'
        })
        historyNow = []
        continuing = true
        appendNote(reply, `---\n↪ *Switched to ${this.label(hops[next])} - ${this.label(hop)} ${failure === 'auth' ? 'is not signed in' : 'ran out of usage'}.*`)
        for (const t of reply.tools ?? []) if (t.status === 'running') t.status = 'error'
        this.upsert(reply, true)
        error = undefined
        i = next
      }
    } catch (e) {
      error = (e as Error).message ?? String(e)
    } finally {
      this.turns.delete(agentId)
      this.controllers.delete(agentId)
      this.lastBeat.delete(agentId)
      this.temps.delete(agentId)
      this.fallbacks.delete(agentId)
    }
    if (ctl.signal.aborted && (!error || this.stopReasons.has(agentId))) error = this.stopReasons.get(agentId) ?? 'Stopped.'
    this.stopReasons.delete(agentId)
    reply.streaming = false
    closeSegments(reply)
    if (error) reply.error = error
    for (const t of reply.tools ?? []) if (t.status === 'running') t.status = 'error'
    if (this.d.project.get(agentId)) {
      this.upsert(reply, true)
      await this.persist(reply)
      this.setStatus(agentId, error && !/^Stopped/.test(error) ? 'error' : 'idle')
    }
    return { text: reply.text, error }
  }

  /** One provider's run of a turn, streaming into `reply`. Returns the error it ended on, if any. */
  private async runHop(agent: AgentSpec, prompt: string, history: HistoryItem[], mayResume: boolean, reply: ChatMessage, ctl: AbortController, wd?: Watchdog, warm = false): Promise<string | undefined> {
    const agentId = agent.id
    const isCli = ProviderRegistry.isCli(agent.provider)
    const resumeId = mayResume ? this.d.store.resumeId(agentId, agent.provider) : undefined
    let finalPrompt = prompt
    if (agent.provider === 'claude-cli' && !resumeId && history.length) {
      finalPrompt = `# Conversation so far\n${history.map((h) => `${h.role === 'user' ? 'User' : 'You'}: ${h.text}`).join('\n\n')}\n\n# Now\n${prompt}`
    } else if (!resumeId && !history.length && mayResume) {
      // the first turn after a fresh start: the recap instead of everything that came before
      const recap = [...(this.chats[agentId] ?? [])].reverse().find((m) => m.fresh)?.recap
      if (recap) finalPrompt = `# Where we left off\n${recap}\n\n# Now\n${prompt}`
    }
    let error: string | undefined
    let lastContext = 0
    const req: TurnRequest = {
      agent,
      system: this.systemPrompt(agent, await this.tables.list()),
      history,
      prompt: finalPrompt,
      cwd: this.d.project.dir,
      resumeId,
      // the chat's own turns keep its process warm; a hop carrying a brief to another provider does not
      poolKey: warm ? `${agentId}|` : undefined,
      tools: guardTools(await this.toolsFor(agent, isCli), wd && !isCli ? (n, i) => this.watchCall(agentId, wd, ctl, n, i) : undefined),
      busUrl: isCli ? this.d.busUrl?.(agentId) : undefined,
      externalMcp: this.d.config.settings.mcpServers.filter((s) => agent.mcp.includes(s.id)),
      apiKey: this.d.config.getKey(agent.provider),
      baseUrl: this.d.config.settings.baseUrls[agent.provider],
      executable: agent.provider === 'claude-cli' ? this.d.config.settings.claudePath : agent.provider === 'codex-cli' ? this.d.config.settings.codexPath : undefined,
      signal: ctl.signal,
      ask: (qs) => this.askUser(agentId, qs).then((item) => item.answers ?? {}),
      approvePlan: (plan) => this.requestApproval(agentId, `${agent.name}: leave plan mode and start?`, plan).then((i) => ({ approved: !!i.approved, note: i.note })),
      approveAction: (title, detail, always) => this.approveAction(agentId, title, detail, always),
      // Claude holds each call on a hook; Codex cannot be held, so it is watched as calls start (below)
      watch: wd && agent.provider === 'claude-cli' ? (n, i) => this.watchCall(agentId, wd, ctl, n, i) : undefined
    }
    const findTool = (id: string, parent?: string) => {
      const top = reply.tools!.find((x) => x.id === (parent ?? id))
      return parent ? top?.children?.find((x) => x.id === id) : top
    }
    for await (const ev of this.d.providers.get(agent.provider).run(req)) {
      if (!this.d.project.get(agentId)) break
      this.lastBeat.set(agentId, Date.now())
      switch (ev.type) {
        case 'text':
          appendStream(reply, 'text', ev.delta)
          if (this.acts.get(agentId)?.activity !== 'Writing') this.setStatus(agentId, 'working', 'Writing')
          break
        case 'thinking':
          appendStream(reply, 'thinking', ev.delta)
          if (this.acts.get(agentId)?.activity !== 'Thinking') this.setStatus(agentId, 'thinking', 'Thinking')
          break
        case 'tool-start': {
          const now = Date.now()
          const d = describeTool(ev.name, ev.input)
          const view = { id: ev.id, name: ev.name, input: ev.input, status: 'running' as const, startedAt: now }
          if (ev.parent) {
            // a sub-agent's step: kept under the call that started it, the latest hundred of them
            const top = reply.tools!.find((x) => x.id === ev.parent)
            if (top) {
              top.children = [...(top.children ?? []), view].slice(-100)
              top.childCount = (top.childCount ?? 0) + 1
              top.beatAt = now
            }
            this.setStatus(agentId, 'working', `Sub-agent · ${d.verb}`, d.brief)
          } else {
            reply.tools!.push(view)
            appendTool(reply, ev.id, now)
            this.setStatus(agentId, 'working', d.verb, d.brief)
            // Codex runs a command before anyone can hold it: the watchdog can only pause the turn after
            if (wd && agent.provider === 'codex-cli')
              void this.watchCall(agentId, wd, ctl, ev.name, ev.input).then((v) => {
                if (!v.ok && !v.stop) {
                  this.redirects.set(agentId, v.reason)
                  ctl.abort()
                }
              })
          }
          break
        }
        case 'tool-end': {
          const t = findTool(ev.id, ev.parent)
          if (t) Object.assign(t, { output: clip(ev.output), status: ev.isError ? 'error' : 'done', endedAt: Date.now() })
          if (!ev.parent && t) this.setStatus(agentId, 'thinking', 'Thinking')
          if (isCli && t && !t.name.includes('multimine')) void this.captureFromText(agentId, ev.output, t.name)
          break
        }
        case 'progress': {
          const t = findTool(ev.id)
          if (t) {
            t.beatAt = Date.now()
            if (ev.note) t.progress = ev.note
          }
          break
        }
        case 'resume': {
          const chat = this.d.project.get(agentId)
          if (chat) await this.d.store.setResume(chat, agent.provider, ev.id)
          break
        }
        case 'call-usage':
          wd?.spend(ev)
          // how big the conversation is now: what the latest call had to read
          lastContext = ev.input + ev.cacheRead + ev.cacheWrite
          break
        case 'usage': {
          const u = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cacheRead: ev.cacheRead, cacheWrite: ev.cacheWrite, calls: ev.calls, costUsd: ev.costUsd }
          reply.usage = { ...addUsage(reply.usage, u), context: lastContext || ev.inputTokens + (ev.cacheRead ?? 0) + (ev.cacheWrite ?? 0) }
          this.totals = addUsage(this.totals, u)
          this.byAgent[agentId] = addUsage(this.byAgent[agentId], u)
          this.d.emit({ type: 'usage', total: { ...this.totals }, byAgent: { ...this.byAgent } })
          break
        }
        case 'limit':
          if (ev.window && agent.provider === 'claude-cli') this.d.planLimits?.record(ev.window, ev.used, ev.resetsAt, ev.state)
          // the provider's own warning: the next turn any chat on this login starts goes to its fallback
          if (ev.state === 'ok') this.health.clear(agent.provider)
          else this.health.mark(agent.provider, ev.state, ev.detail ?? 'usage limit', ev.state === 'near' ? 'near' : 'usage', ev.resetsAt)
          break
        case 'error':
          error = ev.message
          break
      }
      this.upsert(reply)
    }
    return error
  }

  /** The chat's own model (or this turn's cheaper one), then its fallbacks or the default chain. */
  private hopsFor(own: AgentSpec, agent: AgentSpec): FallbackHop[] {
    const chain = own.fallback?.length ? own.fallback : this.d.config.settings.defaultFallback ?? []
    const hops: FallbackHop[] = [{ provider: agent.provider, model: agent.model, effort: agent.effort }]
    for (const h of chain) if (!hops.some((x) => x.provider === h.provider && x.model === h.model)) hops.push(h)
    return hops
  }

  /** Start on the first provider that is fresh; failing that, the first that is not exhausted; failing that, the chat's own. */
  private startHop(hops: FallbackHop[]): number {
    const fresh = hops.findIndex((h) => this.health.fresh(h.provider))
    if (fresh >= 0) return fresh
    const usable = hops.findIndex((h) => this.health.usable(h.provider))
    return usable >= 0 ? usable : 0
  }

  private nextHop(hops: FallbackHop[], from: number): number {
    for (let j = from + 1; j < hops.length; j++) if (this.health.usable(hops[j].provider)) return j
    return -1
  }

  private label(h: FallbackHop): string {
    return `${SHORT_PROVIDER[h.provider]} ${modelLabel(this.d.config.settings.catalog, h.provider, h.model)}`.trim()
  }

  /** Moving onto a pay-per-use key costs money: ask, with an "always" answer. */
  private async approvePaidFallback(own: AgentSpec, from: FallbackHop, to: FallbackHop, failure: Failure): Promise<boolean> {
    const title = `continue on ${this.label(to)} (paid API)`
    const detail = `${this.label(from)} ${failure === 'auth' ? 'is not signed in' : 'is out of usage'}.\nThis chat can carry on with ${this.label(to)}, billed per call to your key.`
    const prev = this.status.get(own.id)
    this.setStatus(own.id, 'waiting', 'paid fallback?')
    const item = await this.inbox.approval(own.id, title, `${detail}\n\n"Always" lets this chat switch to paid keys without asking from now on.`, true, 'Always')
    this.setStatus(own.id, prev && prev !== 'waiting' ? prev : 'working')
    if (item.approved && item.always) {
      const fresh = this.d.project.get(own.id)
      if (fresh) await this.saveChat({ ...fresh, fallbackPaidOk: true })
    }
    return !!item.approved
  }

  /** `git diff --stat` and the diff, for a continuation brief; empty outside a repository. */
  private gitDiffBrief(): Promise<{ diffStat?: string; diff?: string }> {
    const run = (cmd: string) =>
      new Promise<string>((resolve) => exec(cmd, { cwd: this.d.project.dir, timeout: 15_000, maxBuffer: 8_000_000 }, (err, out) => resolve(err ? '' : out.trim())))
    return Promise.all([run('git diff HEAD --stat'), run('git diff HEAD')]).then(([diffStat, diff]) => ({ diffStat: diffStat || undefined, diff: diff || undefined }))
  }

  /** Every chat's system prompt: Multimine's own, the tables switched on as context, economy's rules. */
  systemPrompt(agent: AgentSpec, tables: Table[] = []): string {
    const eco = this.d.config.settings.economy
    const base = buildSystemPrompt({ agent, projectDir: this.d.project.dir, multimineMd: this.d.project.multimineMd })
    return [base, contextSection(tables), eco.enabled && eco.concise ? CONCISE_RULES : ''].filter(Boolean).join('\n\n')
  }

  /**
   * A chat saving a table: read leniently, every link checked against its file (the code is the
   * truth; links that do not match are dropped and reported), the user's context switch kept,
   * written to `.multimine/tables/`, and shown as a card in the chat.
   */
  async saveTable(chatId: string, raw: unknown): Promise<{ table: Table; card: TableCard; problems: string[] }> {
    const { table: parsed, problems } = parseTable(raw)
    if (!parsed.columns.length) throw new Error(`The table has no columns${problems.length ? `: ${problems.join('; ')}` : ''}.`)
    const before = await this.tables.get(parsed.id)
    const ask = raw && typeof raw === 'object' && typeof (raw as { context?: unknown }).context === 'boolean'
    const { table, report } = await this.tables.verify({ ...parsed, context: ask ? parsed.context : (before?.context ?? false) })
    await this.tables.save(table)
    const first = table.columns.slice(0, 6)
    const card: TableCard = {
      id: table.id,
      name: table.name,
      rows: table.rows.length,
      columns: table.columns.length,
      links: report.links,
      verified: report.verified,
      broken: report.broken.slice(0, 20),
      preview: { columns: first.map((c) => ({ key: c.key, label: c.label })), rows: table.rows.slice(0, 8).map((r) => Object.fromEntries(first.map((c) => [c.key, cellText(r.cells[c.key])]))) }
    }
    if (this.d.project.get(chatId)) {
      const msg: ChatMessage = { id: newId('n'), agentId: chatId, role: 'system', from: 'multimine', text: `Table "${table.name}" saved`, ts: Date.now(), table: card }
      this.upsert(msg, true)
      await this.persist(msg)
    }
    this.d.emit({ type: 'tables-changed', id: table.id })
    return { table, card, problems: [...problems, ...report.broken] }
  }

  // ---------------------------------------------------------------- tools and plugins

  /**
   * A message from a tool (the UI Sketcher, a plugin) to a chat: `to` is a chat id, 'active' (the
   * one on screen) or 'new'. A new chat can be started with MCP servers on (the Asset Board's
   * generators), but only servers the user has set up in Settings. Returns the chat it went to.
   */
  async fromTool(toolName: string, to: string, body: string, active?: string, opts: { mcp?: string[]; planMode?: boolean } = {}): Promise<string> {
    let id = to === 'active' ? active : to === 'new' ? undefined : to
    if (id && !this.d.project.get(id)) {
      if (to !== 'active') throw new Error(`No chat ${to}`)
      id = undefined
    }
    if (!id) {
      const name = body.split('\n').find((l) => l.trim() && !/^#+\s*$/.test(l))?.replace(/^#+\s*/, '').replace(/^\/table\s*/, '').trim()
      const mcp = (opts.mcp ?? []).filter((m) => this.d.config.settings.mcpServers.some((s) => s.id === m))
      const chat = await this.createChat({ name: clipTo(name ? `${toolName}: ${name}` : toolName, 48), mcp })
      // plan mode is Claude's: for any other provider there is nothing to switch on
      if (opts.planMode && chat.provider === 'claude-cli') await this.saveChat({ ...chat, planMode: true })
      id = chat.id
    }
    void this.send(id, body, `tool:${toolName}`).catch(() => undefined)
    return id
  }

  // ---------------------------------------------------------------- the user in the loop

  async askUser(askedBy: string, questions: Question[]): Promise<InboxItem> {
    const who = this.d.project.get(askedBy)?.name ?? askedBy
    const title = questions.length === 1 ? questions[0].question : `${who} has ${questions.length} questions`
    const prev = this.status.get(askedBy)
    this.setStatus(askedBy, 'waiting', 'waiting for you')
    const item = await this.inbox.ask(askedBy, title, questions)
    this.setStatus(askedBy, prev && prev !== 'waiting' ? prev : 'working')
    return item
  }

  async requestApproval(askedBy: string, title: string, planMd: string): Promise<InboxItem> {
    const prev = this.status.get(askedBy)
    this.setStatus(askedBy, 'waiting', 'waiting for approval')
    const item = await this.inbox.approval(askedBy, title, planMd)
    this.setStatus(askedBy, prev && prev !== 'waiting' ? prev : 'working')
    return item
  }

  /**
   * One action a chat wants to take. Auto-approved chats get a yes at once, except for the hard
   * stops (git push, recursive delete...), which wait for the user whatever the settings say.
   */
  async approveAction(askedBy: string, title: string, detail: string, always = false): Promise<boolean> {
    const chat = this.d.project.get(askedBy)
    if (!always && chat?.autoApprove) return true
    const prev = this.status.get(askedBy)
    this.setStatus(askedBy, 'waiting', `allow ${title}?`)
    const note = always ? 'This always needs you, even with auto-approve on.' : 'This chat is Supervised: it asks before every edit and command.'
    const item = await this.inbox.approval(askedBy, title, `\`\`\`\n${detail}\n\`\`\`\n\n${note}`, true)
    this.setStatus(askedBy, prev && prev !== 'waiting' ? prev : 'working')
    return !!item.approved
  }

  /** A single completion with no tools and no chat log (economy's rating of a message). */
  async complete(agent: AgentSpec, system: string, prompt: string): Promise<string> {
    const ctl = new AbortController()
    let out = ''
    for await (const ev of this.d.providers.get(agent.provider).run({
      agent: { ...agent, planMode: false, permissions: agent.provider === 'claude-cli' ? 'chat' : agent.permissions },
      system,
      history: [],
      prompt,
      cwd: this.d.project.dir,
      tools: [],
      externalMcp: [],
      apiKey: this.d.config.getKey(agent.provider),
      baseUrl: this.d.config.settings.baseUrls[agent.provider],
      executable: agent.provider === 'claude-cli' ? this.d.config.settings.claudePath : agent.provider === 'codex-cli' ? this.d.config.settings.codexPath : undefined,
      signal: ctl.signal,
      ask: async () => ({}),
      approvePlan: async () => ({ approved: false }),
      approveAction: async () => false
    })) {
      if (ev.type === 'text') out += ev.delta
      if (ev.type === 'error') throw new Error(ev.message)
    }
    return out
  }

  // ---------------------------------------------------------------- media

  async addMedia(item: MediaItem | null): Promise<MediaItem | null> {
    if (!item) return null
    this.media = [...this.media, item]
    await this.d.store.saveMedia(this.media)
    this.d.emit({ type: 'media', items: this.media })
    return item
  }

  private async captureFromText(agentId: string, output: string, source: string): Promise<void> {
    for (const url of findMediaUrls(output).slice(0, 6)) {
      try {
        await this.addMedia(await this.mediaStore.fromUrl(url, agentId, source))
      } catch {
        // a dead link is not worth failing a turn over
      }
    }
  }

  // ---------------------------------------------------------------- tools

  async toolsFor(agent: AgentSpec, cli: boolean): Promise<ToolDef[]> {
    const tools = this.coordinationTools(agent)
    if (!cli) {
      tools.push(...workspaceTools(this.d.project.dir, agent.permissions, (t, d, always) => this.approveAction(agent.id, t, d, always)))
      if (this.d.hub && agent.provider !== 'mock')
        for (const s of this.d.config.settings.mcpServers.filter((x) => agent.mcp.includes(x.id))) {
          try {
            tools.push(
              ...(await this.d.hub.toolDefs(s, async (data, mime, source) => {
                const item = await this.addMedia(await this.mediaStore.fromBase64(data, mime, agent.id, source))
                return item ? `[${item.kind} saved to the media gallery: ${item.path}]` : `[${mime} content]`
              }))
            )
          } catch (e) {
            await this.note(agent.id, `MCP server ${s.name} is unavailable: ${(e as Error).message}`)
          }
        }
    }
    return tools
  }

  /** The tools Multimine gives every chat on top of its provider's own. */
  coordinationTools(agent: AgentSpec): ToolDef[] {
    const me = agent.id
    const question = z.object({
      question: z.string(),
      header: z.string().optional(),
      options: z.array(z.object({ label: z.string(), description: z.string().optional() })).min(1).max(6),
      multiSelect: z.boolean().optional()
    })
    const cell = z.union([z.string(), z.number(), z.boolean(), z.null()])
    const link = z.object({ file: z.string(), line: z.number(), before: z.string(), after: z.string() })
    return [
      {
        name: 'save_table',
        description:
          "Save one of the project's tables (in .multimine/tables/, shown in the Tables tool). Reusing an id replaces that table. Every link is checked against its file; the result lists those that did not match.",
        shape: {
          id: z.string().optional().describe('A short slug; reuse an existing id to change that table'),
          name: z.string(),
          description: z.string().optional(),
          columns: z.array(
            z.object({
              key: z.string().optional(),
              label: z.string(),
              type: z.enum(['text', 'number', 'enum', 'bool']).optional(),
              values: z.array(z.string()).optional(),
              colors: z.record(z.string(), z.string()).optional(),
              note: z.string().optional()
            })
          ),
          rows: z.array(
            z.object({
              id: z.string().optional(),
              cells: z.record(z.string(), cell),
              file: z.string().optional(),
              idea: z.boolean().optional(),
              links: z.record(z.string(), link).optional()
            })
          )
        },
        handler: async (a) => {
          try {
            const { table, card, problems } = await this.saveTable(me, a)
            const lines = [`Saved the table "${table.name}" (id ${table.id}): ${card.rows} rows, ${card.columns} columns; ${card.verified} of ${card.links} links match the code.`]
            if (problems.length) lines.push(`Not saved as given - fix these and save again:\n${problems.slice(0, 30).map((p) => `- ${p}`).join('\n')}`)
            return text(lines.join('\n'))
          } catch (e) {
            return text((e as Error).message, true)
          }
        }
      },
      {
        name: 'read_table',
        description: "Read one of the project's tables as JSON (its columns, rows and code links). Without an id, lists them.",
        shape: { id: z.string().optional() },
        handler: async (a) => {
          const all = await this.tables.list()
          if (!a.id) return text(all.length ? all.map((t) => `${t.id}: ${t.name} (${t.rows.length} rows; ${t.columns.map((c) => c.label).join(', ')})${t.context ? ' - context' : ''}`).join('\n') : 'No tables yet.')
          const t = all.find((x) => x.id === String(a.id))
          return t ? text(JSON.stringify(t)) : text(`No table ${a.id}. Tables: ${all.map((x) => x.id).join(', ') || 'none'}.`, true)
        }
      },
      {
        name: 'ask_user',
        description: 'Ask the user one to four structured questions. Each has 2-6 options, recommended first. Blocks until answered.',
        shape: { questions: z.array(question).min(1).max(4) },
        handler: async (a) => text(formatAnswers(await this.askUser(me, a.questions as Question[])))
      },
      {
        name: 'request_permission',
        description:
          'Ask the user before an action that leaves this machine or cannot be undone: git push, publishing, force operations, deleting work. Blocks until they answer. Proceed only if it returns ALLOWED.',
        shape: { action: z.string().describe('Short, e.g. "git push origin main"'), detail: z.string().optional() },
        handler: async (a) =>
          (await this.approveAction(me, String(a.action), String(a.detail ?? a.action), true)) ? text('ALLOWED') : text('DENIED by the user. Do not do it.', true)
      },
      {
        name: 'show_media',
        description: 'Put an image/video/audio/3D model in the media gallery for the user to preview. Give an http(s) URL or a path in the project.',
        shape: { source: z.string(), title: z.string().optional() },
        handler: async (a) => {
          const src = String(a.source)
          try {
            const item = /^(https?:|data:)/.test(src)
              ? await this.mediaStore.fromUrl(src, me, src, a.title as string | undefined)
              : await this.mediaStore.fromFile(insideProject(this.d.project.dir, src), me, (a.title as string | undefined) ?? src)
            const saved = await this.addMedia(item)
            return saved ? text(`Shown in the gallery as ${saved.kind}: ${saved.path}`) : text('Not a recognised media type.', true)
          } catch (e) {
            return text(`Could not fetch it: ${(e as Error).message}`, true)
          }
        }
      }
    ]
  }
}

const clipTo = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
