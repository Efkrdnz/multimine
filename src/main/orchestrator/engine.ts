import { addUsage, NO_USAGE } from '@shared/usage'
import type { PlanLimits } from '../providers/planLimits'
import { exec } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { serializeAgentFile } from '@shared/agentFile'
import { newId } from '@shared/ids'
import { roleTemplate } from '@shared/templates'
import { CONCISE_RULES, DIFFICULTIES, DIFFICULTY_RULES, downshift, type Difficulty, type TempModel } from '@shared/economy'
import {
  EFFORTS,
  MASTERMIND_ID,
  PERMISSIONS,
  PROVIDERS,
  type AgentSpec,
  type AgentStatus,
  type BusEvent,
  type BusKind,
  type Channel,
  type FallbackHop,
  type ProviderKind,
  type ChatMessage,
  type InboxItem,
  type MainEvent,
  type MediaItem,
  type Question,
  type Role,
  type SessionMeta,
  type Usage
} from '@shared/types'
import type { AppConfig } from '../store/appConfig'
import type { ProjectStore } from '../store/project'
import type { SessionStore } from '../store/sessions'
import { writeAtomic } from '../store/fsx'
import { ProviderRegistry } from '../providers/registry'
import type { HistoryItem, ToolDef, ToolOutput, TurnRequest } from '../providers/types'
import { findMediaUrls, MediaStore } from '../media/capture'
import type { McpHub } from '../mcp/hub'
import { BOOTSTRAP_TASK, buildSystemPrompt, inboundPrompt } from './prompts'
import { buildBrief } from './continuation'
import { failureOf, isPaid, ProviderHealth, type Failure } from '../providers/limits'
import { SHORT_PROVIDER, modelLabel } from '@shared/catalog'
import { formatAnswers, Inbox, recommendedAnswers } from './inbox'
import { runCouncil } from './council'
import { insideProject, workspaceTools } from './workspace'
import { verdictFor, Watchdog, type Trip, type WatchVerdict } from './watchdog'
import { describeTool, duration } from '@shared/activity'

export interface EngineDeps {
  project: ProjectStore
  sessions: SessionStore
  config: AppConfig
  providers: ProviderRegistry
  emit: (e: MainEvent) => void
  hub?: McpHub
  /** Which providers are out of usage: shared by every project, so one app-wide instance is passed in. */
  health?: ProviderHealth
  /** The Claude plan's usage windows, app-wide like `health`. */
  planLimits?: PlanLimits
  /** The URL of an agent's endpoint on the local MCP bus (set once the bus server is up). */
  busUrl?: (agentId: string) => string | undefined
}

interface Report {
  summary: string
  planMd?: string
  planPath?: string
  files?: string[]
}

interface TurnContext {
  from: string
  kind: BusKind
  reports: Report[]
}

export interface TurnResult {
  text: string
  reports: Report[]
  error?: string
}

const ROLES: Role[] = ['planner', 'implementer', 'designer', 'brainstormer', 'context-handler', 'asset-creator', 'ui-creator', 'critic', 'custom']
const text = (t: string, isError = false): ToolOutput => ({ text: t, isError })

/**
 * Tool output as the chat shows it. The model already has the whole thing; the window only needs
 * the start and the end, and a long run of builds would otherwise ship megabytes on every update.
 */
const CLIP = 4000
/**
 * In-process tools (API and mock agents) with the loop guard in front of each: a refused call is
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
 * Runs the team: one serial turn queue per agent, the bus between them, the inbox, the approval
 * gate, the council and the context loop. It has no Electron in it, so tests drive it directly.
 */
export class Engine {
  session!: SessionMeta
  chats: Record<string, ChatMessage[]> = {}
  bus: BusEvent[] = []
  media: MediaItem[] = []
  inbox!: Inbox
  private status = new Map<string, AgentStatus>()
  /** What each busy agent is doing, since when, and whether it has gone quiet: the live activity line. */
  private acts = new Map<string, { activity?: string; detail?: string; since: number; quiet?: string }>()
  /** When each turn last showed a sign of life (any event from its provider). */
  private lastBeat = new Map<string, number>()
  private quietTimer: ReturnType<typeof setInterval> | null = null
  /** Why a turn was stopped by the watchdog, for the result its caller gets. */
  private stopReasons = new Map<string, string>()
  /** Agents already paused by the watchdog: one question at a time, even with calls in parallel. */
  private pausedNow = new Set<string>()
  /** An instruction to resume a turn with after the watchdog paused it (providers with no per-call hook). */
  private redirects = new Map<string, string>()
  private queues = new Map<string, Promise<unknown>>()
  private turns = new Map<string, TurnContext>()
  private waits = new Map<string, string>()
  private controllers = new Map<string, AbortController>()
  /** Write-capable agents mid-turn, and when the last one stopped: the watcher's "an agent did it" window. */
  private writing = new Set<string>()
  private writingUntil = 0
  /** Agents running their current task on a fallback provider, and why. */
  private fallbacks = new Map<string, { provider: ProviderKind; model: string; reason: string }>()
  /** Agents running their current task on a cheaper model than their own (economy mode). */
  private temps = new Map<string, TempModel>()
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private totals: Usage = { ...NO_USAGE }
  /** This session's usage per agent: which one spent what. */
  private byAgent: Record<string, Usage> = {}
  private mediaStore: MediaStore

  readonly health: ProviderHealth

  constructor(private readonly d: EngineDeps) {
    this.mediaStore = new MediaStore(d.project.paths.media)
    this.health = d.health ?? new ProviderHealth((h) => d.emit({ type: 'provider-health', health: h }))
  }

  get project(): ProjectStore {
    return this.d.project
  }

  // ---------------------------------------------------------------- sessions

  async open(sessionId?: string): Promise<void> {
    const list = await this.d.sessions.list()
    const meta = (sessionId && list.find((s) => s.id === sessionId)) || list[0] || (await this.d.sessions.create('First session'))
    await this.load(meta)
  }

  private async load(meta: SessionMeta): Promise<void> {
    this.inbox?.cancelAll('The session was switched.')
    for (const c of this.controllers.values()) c.abort()
    this.session = meta
    this.chats = await this.d.sessions.loadChats(meta.id, this.d.project.list().map((a) => a.id))
    this.bus = await this.d.sessions.loadBus(meta.id)
    this.media = await this.d.sessions.loadMedia(meta.id)
    const saved = await this.d.sessions.loadInbox(meta.id)
    this.inbox = new Inbox(saved, (items) => {
      void this.d.sessions.saveInbox(this.session.id, items)
      this.d.emit({ type: 'inbox', items })
      this.emitChannels()
    })
    void this.d.sessions.saveInbox(meta.id, this.inbox.items)
    this.totals = { ...NO_USAGE }
    this.byAgent = {}
    for (const [agentId, msgs] of Object.entries(this.chats))
      for (const m of msgs)
        if (m.usage) {
          this.totals = addUsage(this.totals, m.usage)
          this.byAgent[agentId] = addUsage(this.byAgent[agentId], m.usage)
        }
    this.status.clear()
    await this.emitSessions()
    this.d.emit({ type: 'chat-reset', chats: this.chats })
    this.d.emit({ type: 'bus-reset', events: this.bus })
    this.d.emit({ type: 'inbox', items: this.inbox.items })
    this.d.emit({ type: 'media', items: this.media })
    this.d.emit({ type: 'usage', total: this.totals, byAgent: this.byAgent })
    this.d.emit({ type: 'council', critics: [] })
  }

  async emitSessions(): Promise<void> {
    this.d.emit({ type: 'sessions', sessions: await this.d.sessions.list(), active: this.session?.id ?? null })
  }

  async switchSession(id: string): Promise<void> {
    const meta = await this.d.sessions.get(id)
    if (meta) await this.load(meta)
  }

  async newSession(name?: string): Promise<void> {
    await this.load(await this.d.sessions.create(name))
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
   * Marks a busy agent quiet when nothing has come from it for a while, or one step has run for a
   * long time: the user sees it on the orb and in the chat instead of wondering whether it is stuck.
   */
  private checkQuiet(): void {
    const quietMs = Math.max(1, this.d.config.settings.watchdog?.quietMinutes ?? 5) * 60_000
    const now = Date.now()
    for (const agentId of this.turns.keys()) {
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
   * The loop guard's word on a call about to run. A trip waits for the user (a balloon over the
   * agent): continue forgives it, a note is handed to the model instead of running the call, and a
   * plain no stops the task. Automation never answers this one: it is there for when things go wrong.
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
    const agent = this.d.project.get(agentId)
    await this.logBus('approval', agentId, 'user', `Paused: ${agent?.name ?? agentId} ${trip.title}`)
    const prev = { status: this.status.get(agentId), act: this.acts.get(agentId) }
    this.setStatus(agentId, 'waiting', 'Paused by the loop guard')
    const item = await this.inbox.watchdog(agentId, trip.title, `${trip.detail}

**Continue** lets it carry on. **Tell it** gives it an instruction instead of this step. **Stop** ends the task and it reports back.`)
    const verdict = verdictFor(item)
    if (verdict.ok) wd.forgive(trip)
    if (!verdict.ok && verdict.stop && !ctl.signal.aborted) {
      this.stopReasons.set(agentId, `Stopped by the user: ${agent?.name ?? agentId} ${trip.title}.`)
      ctl.abort()
    }
    if (prev.status && prev.status !== 'waiting' && !ctl.signal.aborted) this.setStatus(agentId, prev.status, prev.act?.activity, prev.act?.detail)
    return verdict
  }

  /**
   * The conversations happening right now, for the scene to keep lit: every turn another agent
   * asked for, and every agent waiting on the user (drawn to Mastermind, who carries the question).
   */
  channels(): Channel[] {
    const out: Channel[] = []
    for (const [agentId, ctx] of this.turns)
      if (ctx.from !== 'user' && ctx.from !== agentId) out.push({ from: ctx.from, to: agentId, kind: ctx.kind })
    for (const item of this.inbox?.pending() ?? [])
      if (item.askedBy !== MASTERMIND_ID) out.push({ from: item.askedBy, to: MASTERMIND_ID, kind: item.kind === 'question' ? 'question' : 'approval' })
    return out
  }

  private emitChannels(): void {
    this.d.emit({ type: 'channels', channels: this.channels() })
  }

  /** True while (or just after) an agent with write access works: file changes then are the agent's, not the user's. */
  agentWriting(): boolean {
    return this.writing.size > 0 || Date.now() < this.writingUntil
  }

  /** The user changed files by hand (any editor): the Context Handler gets one batch with the diff. */
  async manualChanges(files: Map<string, 'added' | 'changed' | 'deleted'>): Promise<boolean> {
    const handler = this.d.project.contextHandler()
    if (!handler || !files.size) return false
    const list = [...files.entries()].map(([f, k]) => `- ${k}: ${f}`).join('\n')
    const changed = [...files.entries()].filter(([, k]) => k !== 'deleted').map(([f]) => f)
    const diff = changed.length ? await this.gitDiff(changed) : ''
    const body =
      `The user edited the project by hand (outside the team). Bring the context files up to date with these changes and add a changelog entry marked "manual".\n\n## Files\n${list}\n\n` +
      (diff ? `## Diff\n\`\`\`diff\n${diff}\n\`\`\`\n` : 'Read the files themselves; there is no git diff for them (new, or not a git repository).\n')
    await this.logBus('context', 'user', handler.id, `${files.size} manual change${files.size === 1 ? '' : 's'}`)
    void this.send(handler.id, body, 'user', 'context')
    return true
  }

  private gitDiff(files: string[]): Promise<string> {
    return new Promise((resolve) =>
      exec(`git diff HEAD -- ${files.map((f) => JSON.stringify(f)).join(' ')}`, { cwd: this.d.project.dir, timeout: 20_000, maxBuffer: 8_000_000 }, (err, stdout) =>
        resolve(err ? '' : stdout.length > 40_000 ? `${stdout.slice(0, 40_000)}\n... (diff truncated)` : stdout)
      )
    )
  }

  busy(agentId: string): boolean {
    return this.turns.has(agentId)
  }

  /** Queues a turn for an agent. Turns of one agent never overlap; different agents run in parallel. */
  send(agentId: string, body: string, from = 'user', kind: BusKind = 'message', temp?: TempModel | null): Promise<TurnResult> {
    // the incoming message is shown at once, even while the agent is still busy with an earlier turn
    const agent = this.d.project.get(agentId)
    const fromName = from === 'user' ? 'user' : (this.d.project.get(from)?.name ?? this.sourceNames.get(from) ?? from)
    const prompt = from === 'user' ? body : inboundPrompt(fromName, kind === 'delegate' || kind === 'context' || kind === 'report' ? kind : 'message', body)
    const userMsg: ChatMessage = { id: newId('u'), agentId, role: 'user', from, text: prompt, ts: Date.now() }
    if (agent) {
      this.upsert(userMsg, true)
      void this.persist(userMsg)
    }
    const prev = this.queues.get(agentId) ?? Promise.resolve()
    const next = prev.then(() => this.runTurn(agentId, userMsg, kind, temp ?? undefined))
    this.queues.set(
      agentId,
      next.catch(() => undefined)
    )
    return next
  }

  /** Runs the agent's last incoming message again (after a failed turn: an expired login, a dropped connection). */
  retry(agentId: string): Promise<TurnResult> | null {
    const last = [...(this.chats[agentId] ?? [])].reverse().find((m) => m.role === 'user')
    if (!last) return null
    const kind: BusKind = last.text.startsWith('## Task from') ? 'delegate' : last.text.startsWith('## Context update request') ? 'context' : 'message'
    const copy: ChatMessage = { ...last, id: newId('u'), ts: Date.now() }
    this.upsert(copy, true)
    void this.persist(copy)
    const prev = this.queues.get(agentId) ?? Promise.resolve()
    const next = prev.then(() => this.runTurn(agentId, copy, kind))
    this.queues.set(
      agentId,
      next.catch(() => undefined)
    )
    return next
  }

  stop(agentId: string): void {
    this.controllers.get(agentId)?.abort()
  }

  /** The conversation before `before` (the message this turn answers; later queued ones are not history yet). */
  private history(agentId: string, before: ChatMessage): HistoryItem[] {
    const all = this.chats[agentId] ?? []
    const upto = all.findIndex((m) => m.id === before.id)
    return (upto >= 0 ? all.slice(0, upto) : all)
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
    await this.d.sessions.appendChat(this.session.id, msg)
  }

  /** A note in an agent's chat that is not part of its conversation (a log line). */
  async note(agentId: string, body: string): Promise<void> {
    const msg: ChatMessage = { id: newId('n'), agentId, role: 'system', from: 'multimine', text: body, ts: Date.now() }
    this.upsert(msg, true)
    await this.persist(msg)
  }

  /** A provider's own session for this agent in this session (Claude session_id, Codex thread). */
  private resumeKey(agentId: string, provider: string): string | undefined {
    const raw = this.session.resume[`${agentId}|${provider}`] ?? this.session.resume[agentId]
    if (!raw) return undefined
    const [p, ...rest] = raw.split(':')
    return p === provider ? rest.join(':') : undefined
  }

  private async saveResume(agentId: string, provider: string, id: string): Promise<void> {
    this.session.resume[`${agentId}|${provider}`] = `${provider}:${id}`
    this.session.updated = Date.now()
    await this.d.sessions.save(this.session)
  }

  private async runTurn(agentId: string, userMsg: ChatMessage, kind: BusKind, temp?: TempModel): Promise<TurnResult> {
    const own = this.d.project.get(agentId)
    if (!own) return { text: '', reports: [], error: `No agent ${agentId}` }
    if (own.terminal) {
      // a terminal agent is the user at a keyboard: show the message there, do not run anything
      this.d.emit({ type: 'terminal-note', agentId, from: userMsg.from, text: userMsg.text })
      return { text: `Delivered to ${own.name}, a terminal session the user is driving. It will answer with message_agent when it can; do not wait on it.`, reports: [] }
    }
    // a downshifted task runs on the cheaper model for this turn only; the agent file is untouched
    const agent: AgentSpec = temp ? { ...own, model: temp.model, effort: temp.effort } : own
    if (temp) this.temps.set(agentId, temp)
    else this.temps.delete(agentId)
    const sessionId = this.session.id
    const from = userMsg.from
    const prompt = userMsg.text
    const history = this.history(agentId, userMsg)

    const ctx: TurnContext = { from, kind, reports: [] }
    this.turns.set(agentId, ctx)
    this.emitChannels()
    let ctl = new AbortController()
    this.controllers.set(agentId, ctl)
    this.setStatus(agentId, 'thinking', 'Thinking')
    const wset = this.d.config.settings.watchdog
    const wd = new Watchdog(wset, Date.now(), own.gated ? wset.planBudgetMinutes : wset.budgetMinutes)
    this.lastBeat.set(agentId, Date.now())
    this.quietTimer ??= setInterval(() => this.checkQuiet(), 15_000)
    this.stopReasons.delete(agentId)
    this.redirects.delete(agentId)

    const reply: ChatMessage = { id: newId('r'), agentId, role: 'assistant', from: agentId, text: '', ts: Date.now(), streaming: true, tools: [] }
    this.upsert(reply, true)

    const watchChanges = agent.permissions === 'write' && agent.role !== 'context-handler'
    if (agent.permissions === 'write') this.writing.add(agentId)
    const gitBefore = watchChanges ? await this.gitState() : null

    // The provider chain: the agent's own (or economy) model first, then its fallbacks. A provider
    // already known to be out of usage is skipped at the start; one that runs out mid-task hands the
    // task, with a brief of everything done so far, to the next - in the same reply bubble.
    const hops = this.hopsFor(own, agent)
    let i = this.startHop(hops)
    // a delegated task is self-contained (the task and its approved plan), so it starts a session of
    // its own: carrying every earlier task's transcript into each call is what made long sessions so
    // costly. Follow-ups (messages, reports, the user's own chat) resume the session it started.
    let fresh = kind === 'delegate'
    let promptNow = prompt
    let historyNow = fresh ? [] : history
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
        error = await this.runHop(hopAgent, promptNow, historyNow, !continuing && !fresh, reply, ctl, sessionId, wd, !continuing)
        fresh = false
        // the watchdog paused a provider it cannot hold mid-call: resume the same thread with the user's word
        const redirect = this.redirects.get(agentId)
        if (redirect && sessionId === this.session.id) {
          this.redirects.delete(agentId)
          ctl = new AbortController()
          this.controllers.set(agentId, ctl)
          for (const t of reply.tools ?? []) if (t.status === 'running') Object.assign(t, { status: 'error', endedAt: Date.now(), output: 'Interrupted by the watchdog.' })
          reply.text += `${reply.text ? '\n\n' : ''}*Paused by the loop guard; resumed with your instruction.*\n\n`
          this.upsert(reply, true)
          promptNow = redirect
          historyNow = []
          continuing = false
          error = undefined
          continue
        }
        if (!error || ctl.signal.aborted || sessionId !== this.session.id) break
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
        reply.text += `${reply.text ? '\n\n' : ''}---\n↪ *Switched to ${this.label(hops[next])} - ${this.label(hop)} ${failure === 'auth' ? 'is not signed in' : 'ran out of usage'}.*\n\n`
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
      if (this.writing.delete(agentId)) this.writingUntil = Date.now() + 4000
      this.emitChannels()
    }
    if (ctl.signal.aborted && (!error || this.stopReasons.has(agentId))) error = this.stopReasons.get(agentId) ?? 'Stopped.'
    this.stopReasons.delete(agentId)
    reply.streaming = false
    if (error) reply.error = error
    for (const t of reply.tools ?? []) if (t.status === 'running') t.status = 'error'
    if (sessionId === this.session.id) {
      this.upsert(reply, true)
      await this.persist(reply)
      this.setStatus(agentId, error && !/^Stopped/.test(error) ? 'error' : 'idle')
    }

    if (watchChanges && sessionId === this.session.id) {
      const after = await this.gitState()
      const files = ctx.reports.flatMap((r) => r.files ?? [])
      if (after !== gitBefore || files.length) void this.updateContext(agent, ctx.reports, after)
    }
    const reportText = ctx.reports
      .map((r) => `${r.summary}${r.planPath ? `\n\nPlan saved at ${r.planPath}` : ''}${r.planMd ? `\n\n${r.planMd}` : ''}${r.files?.length ? `\n\nFiles: ${r.files.join(', ')}` : ''}`)
      .join('\n\n')
    return { text: reportText || reply.text, reports: ctx.reports, error }
  }

  /** One provider's run of a turn, streaming into `reply`. Returns the error it ended on, if any. */
  private async runHop(agent: AgentSpec, prompt: string, history: HistoryItem[], mayResume: boolean, reply: ChatMessage, ctl: AbortController, sessionId: string, wd?: Watchdog, warm = false): Promise<string | undefined> {
    const agentId = agent.id
    const isCli = ProviderRegistry.isCli(agent.provider)
    const resumeId = mayResume ? this.resumeKey(agentId, agent.provider) : undefined
    let finalPrompt = prompt
    if (agent.provider === 'claude-cli' && !resumeId && history.length) {
      finalPrompt = `# Conversation so far\n${history.map((h) => `${h.role === 'user' ? 'User' : 'You'}: ${h.text}`).join('\n\n')}\n\n# Now\n${prompt}`
    }
    let error: string | undefined
    const req: TurnRequest = {
      agent,
      system: this.systemPrompt(agent),
      history,
      prompt: finalPrompt,
      cwd: this.d.project.dir,
      resumeId,
      // the agent's own turns keep its process warm; a hop carrying a brief to another provider does not
      poolKey: warm ? `${agentId}|${sessionId}` : undefined,
      tools: guardTools(await this.toolsFor(agent, isCli), wd && !isCli ? (n, i) => this.watchCall(agentId, wd, ctl, n, i) : undefined),
      busUrl: isCli ? this.d.busUrl?.(agentId) : undefined,
      externalMcp: this.d.config.settings.mcpServers.filter((s) => agent.mcp.includes(s.id)),
      apiKey: this.d.config.getKey(agent.provider),
      baseUrl: this.d.config.settings.baseUrls[agent.provider],
      executable: agent.provider === 'claude-cli' ? this.d.config.settings.claudePath : agent.provider === 'codex-cli' ? this.d.config.settings.codexPath : undefined,
      signal: ctl.signal,
      ask: (qs) => this.askUser(agentId, qs).then((item) => item.answers ?? {}),
      approvePlan: (plan) => this.requestApproval(agentId, `${agent.name} wants to leave plan mode`, plan).then((i) => ({ approved: !!i.approved, note: i.note })),
      approveAction: (title, detail, always) => this.approveAction(agentId, title, detail, always),
      // Claude holds each call on a hook; Codex cannot be held, so it is watched as calls start (below)
      watch: wd && agent.provider === 'claude-cli' ? (n, i) => this.watchCall(agentId, wd, ctl, n, i) : undefined
    }
    const findTool = (id: string, parent?: string) => {
      const top = reply.tools!.find((x) => x.id === (parent ?? id))
      return parent ? top?.children?.find((x) => x.id === id) : top
    }
    for await (const ev of this.d.providers.get(agent.provider).run(req)) {
      if (sessionId !== this.session.id) break
      this.lastBeat.set(agentId, Date.now())
      switch (ev.type) {
        case 'text':
          reply.text += ev.delta
          if (this.acts.get(agentId)?.activity !== 'Writing') this.setStatus(agentId, 'working', 'Writing')
          this.d.emit({ type: 'talk', agentId })
          break
        case 'thinking':
          reply.thinking = (reply.thinking ?? '') + ev.delta
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
        case 'resume':
          await this.saveResume(agentId, agent.provider, ev.id)
          break
        case 'call-usage':
          wd?.spend(ev)
          break
        case 'usage': {
          const u = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cacheRead: ev.cacheRead, cacheWrite: ev.cacheWrite, calls: ev.calls, costUsd: ev.costUsd }
          reply.usage = addUsage(reply.usage, u)
          this.totals = addUsage(this.totals, u)
          this.byAgent[agentId] = addUsage(this.byAgent[agentId], u)
          this.d.emit({ type: 'usage', total: { ...this.totals }, byAgent: { ...this.byAgent } })
          break
        }
        case 'limit':
          if (ev.window && agent.provider === 'claude-cli') this.d.planLimits?.record(ev.window, ev.used, ev.resetsAt, ev.state)
          // the provider's own warning: the next task this agent (or any on this login) starts goes to its fallback
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

  /** The agent's own model (or its economy model for this task), then its fallbacks or the default chain. */
  private hopsFor(own: AgentSpec, agent: AgentSpec): FallbackHop[] {
    const chain = own.fallback?.length ? own.fallback : this.d.config.settings.defaultFallback ?? []
    const hops: FallbackHop[] = [{ provider: agent.provider, model: agent.model, effort: agent.effort }]
    for (const h of chain) if (!hops.some((x) => x.provider === h.provider && x.model === h.model)) hops.push(h)
    return hops
  }

  /** Start on the first provider that is fresh; failing that, the first that is not exhausted; failing that, the agent's own. */
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

  /** Moving onto a pay-per-use key costs money: ask, as a balloon over the agent, with an "always" answer. */
  private async approvePaidFallback(own: AgentSpec, from: FallbackHop, to: FallbackHop, failure: Failure): Promise<boolean> {
    const title = `continue on ${this.label(to)} (paid API)`
    const detail = `${this.label(from)} ${failure === 'auth' ? 'is not signed in' : 'is out of usage'}.\n${own.name} can carry on with ${this.label(to)}, billed per call to your key.`
    await this.logBus('approval', own.id, 'user', `Allow ${title}?`)
    const prev = this.status.get(own.id)
    this.setStatus(own.id, 'waiting', 'paid fallback?')
    const item = await this.inbox.approval(own.id, title, `${detail}\n\n"Always" lets ${own.name} switch to paid keys without asking from now on.`, true, 'Always')
    this.setStatus(own.id, prev && prev !== 'waiting' ? prev : 'working')
    if (item.approved && item.always) {
      const fresh = this.d.project.get(own.id)
      if (fresh && !fresh.terminal) {
        await this.d.project.saveAgent({ ...fresh, fallbackPaidOk: true })
        this.d.emit({ type: 'project', project: this.d.project.info() })
      }
    }
    return !!item.approved
  }

  /** `git diff --stat` and the diff, for a continuation brief; empty outside a repository. */
  private gitDiffBrief(): Promise<{ diffStat?: string; diff?: string }> {
    const run = (cmd: string) =>
      new Promise<string>((resolve) => exec(cmd, { cwd: this.d.project.dir, timeout: 15_000, maxBuffer: 8_000_000 }, (err, out) => resolve(err ? '' : out.trim())))
    return Promise.all([run('git diff HEAD --stat'), run('git diff HEAD')]).then(([diffStat, diff]) => ({ diffStat: diffStat || undefined, diff: diff || undefined }))
  }

  systemPrompt(agent: AgentSpec): string {
    const eco = this.d.config.settings.economy
    const extra = [eco.enabled && eco.concise ? CONCISE_RULES : '', eco.enabled && eco.downshift && agent.id === MASTERMIND_ID ? DIFFICULTY_RULES : '']
      .filter(Boolean)
      .join('\n\n')
    const base = buildSystemPrompt({
      agent,
      agents: this.d.project.list(),
      projectDir: this.d.project.dir,
      multimineMd: this.d.project.multimineMd,
      hasContextHandler: !!this.d.project.contextHandler(),
      automation: this.d.config.settings.automation
    })
    return extra ? `${base}\n\n${extra}` : base
  }

  // ---------------------------------------------------------------- bus

  /** Names for senders that are not agents (a plugin), so a message reads "from UI Sketcher". */
  private sourceNames = new Map<string, string>()

  /** A message from outside the team (a tool or plugin) to an agent: on the bus, and queued for it. */
  async fromOutside(sourceId: string, name: string, to: string, body: string): Promise<void> {
    this.sourceNames.set(sourceId, name)
    await this.logBus('message', sourceId, to, body)
    void this.send(to, body, sourceId, 'message')
  }

  /**
   * A task the user started from a tool (the Logic Board's Build). Pressing the button is the user's
   * approval, so for Mastermind it is recorded as an approved plan and its id rides along: Mastermind
   * can hand it to a gated agent without asking again. Any other agent gets it as a delegated task,
   * in a session of its own, ending in a report.
   */
  async taskFromOutside(sourceId: string, name: string, to: string, title: string, body: string): Promise<string | undefined> {
    this.sourceNames.set(sourceId, name)
    await this.logBus('delegate', sourceId, to, title)
    if (to === MASTERMIND_ID) {
      const item = this.inbox.record({ kind: 'approval', askedBy: sourceId, title, planMd: body, status: 'answered', approved: true, note: `Approved from ${name}: you pressed Build.` })
      void this.send(to, `${body}\n\napproval_id: ${item.id}`, sourceId, 'message')
      return item.id
    }
    void this.send(to, body, sourceId, 'delegate')
    return undefined
  }

  private async logBus(kind: BusKind, from: string, to: string, summary: string): Promise<BusEvent> {
    const event: BusEvent = { id: newId('b'), ts: Date.now(), kind, from, to, summary: summary.slice(0, 280) }
    this.bus.push(event)
    if (this.bus.length > 2000) this.bus = this.bus.slice(-1500)
    this.d.emit({ type: 'bus', event })
    await this.d.sessions.appendBus(this.session.id, event)
    return event
  }

  /** True when `to` is (transitively) waiting on `from`: waiting back would deadlock both. */
  private wouldDeadlock(from: string, to: string): boolean {
    if (from === to) return true
    const seen = new Set<string>()
    for (let x: string | undefined = to; x; x = this.waits.get(x)) {
      if (x === from) return true
      if (seen.has(x)) return true
      seen.add(x)
    }
    return false
  }

  /** One agent hands something to another and (optionally) waits for the answer. */
  async relay(from: string, toRef: string, body: string, kind: BusKind, wait: boolean, difficulty?: Difficulty): Promise<ToolOutput> {
    const target = this.d.project.find(toRef)
    if (!target) return text(`No agent "${toRef}". Use list_agents.`, true)
    if (wait && this.wouldDeadlock(from, target.id)) return text(`${target.name} is waiting on you; waiting back would deadlock. Use report, or message without waiting.`, true)
    await this.logBus(kind, from, target.id, body)
    const temp = downshift(target, difficulty, this.d.config.settings.economy)
    if (!wait) {
      void this.send(target.id, body, from, kind, temp)
      return text(`Sent to ${target.name}. Not waiting for a reply.`)
    }
    this.waits.set(from, target.id)
    const prev = this.status.get(from)
    this.setStatus(from, 'working', `waiting for ${target.name}`)
    // Wait a while, never forever: a long job (an implementation, a build) would otherwise outlive the
    // caller's tool-call timeout and its report would have nowhere to go. Past the cap the caller gets
    // its turn back and the report arrives later as a message of its own.
    const capMs = Math.max(0.001, this.d.config.settings.handoffWaitMinutes ?? 10) * 60_000
    const run = this.send(target.id, body, from, kind, temp)
    let timer: ReturnType<typeof setTimeout> | undefined
    const capped = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), capMs)))
    try {
      const res = await Promise.race([run, capped])
      if (res === null) {
        void run.then((late) => this.deliverLate(from, target.id, late))
        const mins = Math.round(capMs / 60_000) || '<1'
        return text(
          `${target.name} is still working after ${mins} min. Its report will be delivered to you as a new message when it finishes - ` +
            'do not wait or poll for it. End this turn now with a short status for the user.'
        )
      }
      await this.logBus(res.reports.length ? 'report' : 'message', target.id, from, res.text || res.error || '(no reply)')
      return text(`${target.name} replied${res.error ? ` (with error: ${res.error})` : ''}:\n\n${res.text || '(no text)'}`, !!res.error && !res.text)
    } finally {
      clearTimeout(timer)
      this.waits.delete(from)
      if (this.turns.has(from)) this.setStatus(from, prev === 'thinking' ? 'thinking' : 'working')
    }
  }

  /** A report that came back after its caller stopped waiting: handed over as a fresh turn. */
  private async deliverLate(to: string, fromId: string, res: TurnResult): Promise<void> {
    const name = this.d.project.get(fromId)?.name ?? fromId
    await this.logBus('report', fromId, to, res.text || res.error || '(no reply)')
    if (to === 'user' || !this.d.project.get(to)) return
    const body = `${name} finished the task you handed over earlier${res.error ? ` (with error: ${res.error})` : ''}:\n\n${res.text || '(no text)'}`
    await this.send(to, body, fromId, 'report')
  }

  // ---------------------------------------------------------------- user in the loop

  /** Every question reaches the user through Mastermind, or is answered by Mastermind in automation mode. */
  async askUser(askedBy: string, questions: Question[]): Promise<InboxItem> {
    const who = this.d.project.get(askedBy)?.name ?? askedBy
    const title = questions.length === 1 ? questions[0].question : `${who} has ${questions.length} questions`
    if (askedBy !== MASTERMIND_ID) await this.logBus('question', askedBy, MASTERMIND_ID, title)
    if (this.d.config.settings.automation) {
      const { answers, reason } = await this.autoAnswer(askedBy, questions)
      const item = this.inbox.record({ kind: 'question', askedBy, title, questions, status: 'auto', answers, autoReason: reason })
      await this.logBus('answer', MASTERMIND_ID, askedBy, `(automation) ${Object.values(answers).join('; ')}`)
      return item
    }
    const prev = this.status.get(askedBy)
    this.setStatus(askedBy, 'waiting', 'waiting for you')
    this.setStatus(MASTERMIND_ID, this.status.get(MASTERMIND_ID) === 'idle' || !this.status.get(MASTERMIND_ID) ? 'waiting' : (this.status.get(MASTERMIND_ID) as AgentStatus))
    const item = await this.inbox.ask(askedBy, title, questions)
    this.setStatus(askedBy, prev && prev !== 'waiting' ? prev : 'working')
    if (!this.turns.has(MASTERMIND_ID) && this.inbox.pending().length === 0) this.setStatus(MASTERMIND_ID, 'idle')
    await this.logBus('answer', MASTERMIND_ID, askedBy, Object.values(item.answers ?? {}).join('; ') || item.note || '')
    return item
  }

  async requestApproval(askedBy: string, title: string, planMd: string): Promise<InboxItem> {
    await this.logBus('approval', askedBy, 'user', title)
    if (this.d.config.settings.automation) {
      return this.inbox.record({ kind: 'approval', askedBy, title, planMd, status: 'auto', approved: true, autoReason: 'Automation mode: approved on your behalf.' })
    }
    const prev = this.status.get(askedBy)
    this.setStatus(askedBy, 'waiting', 'waiting for approval')
    const item = await this.inbox.approval(askedBy, title, planMd)
    this.setStatus(askedBy, prev && prev !== 'waiting' ? prev : 'working')
    return item
  }

  /**
   * One action an agent wants to take. Auto-approved agents get a yes at once, except for the hard
   * stops (git push, recursive delete...), which wait for the user whatever the settings say.
   */
  async approveAction(askedBy: string, title: string, detail: string, always = false): Promise<boolean> {
    const agent = this.d.project.get(askedBy)
    if (!always && agent?.autoApprove) return true
    await this.logBus('approval', askedBy, 'user', `Allow ${title}?`)
    const prev = this.status.get(askedBy)
    this.setStatus(askedBy, 'waiting', `allow ${title}?`)
    const note = always ? 'This always needs you, even with auto-approve or automation on.' : `${agent?.name ?? askedBy} has auto-approve off.`
    const item = await this.inbox.approval(askedBy, title, `\`\`\`\n${detail}\n\`\`\`\n\n${note}`, true)
    this.setStatus(askedBy, prev && prev !== 'waiting' ? prev : 'working')
    return !!item.approved
  }

  /** Mastermind answering for the user: its own model reads the questions and the goal; failing that, the recommended options. */
  private async autoAnswer(askedBy: string, questions: Question[]): Promise<{ answers: Record<string, string>; reason: string }> {
    const mm = this.d.project.get(MASTERMIND_ID)!
    const goal = [...(this.chats[MASTERMIND_ID] ?? [])].reverse().find((m) => m.role === 'user' && m.from === 'user')?.text ?? ''
    const fallback = { answers: recommendedAnswers(questions), reason: 'Picked the recommended (first) option for each question.' }
    try {
      const out = await this.complete(
        mm,
        'You are Mastermind, answering an agent\'s questions on the user\'s behalf (automation mode). Choose what the user most likely wants given their goal and the project guidance. Answer with JSON only: {"answers":{"<question text>":"<chosen option label or short free text>"},"reason":"<one sentence>"}',
        `# Project guidance\n${this.d.project.multimineMd}\n\n# The user's goal\n${goal}\n\n# Questions from ${this.d.project.get(askedBy)?.name ?? askedBy}\n${JSON.stringify(questions, null, 2)}`
      )
      const start = out.indexOf('{')
      const end = out.lastIndexOf('}')
      const parsed = JSON.parse(out.slice(start, end + 1))
      if (!parsed || typeof parsed.answers !== 'object') return fallback
      const answers: Record<string, string> = {}
      for (const q of questions) answers[q.question] = String(parsed.answers[q.question] ?? fallback.answers[q.question])
      return { answers, reason: String(parsed.reason ?? 'Answered by Mastermind.') }
    } catch {
      return fallback
    }
  }

  /** A single completion with no tools and no chat log: the council, automation answers. */
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
      signal: ctl.signal,
      ask: async (qs) => recommendedAnswers(qs),
      approvePlan: async () => ({ approved: false }),
      approveAction: async () => false
    })) {
      if (ev.type === 'text') out += ev.delta
      if (ev.type === 'error') throw new Error(ev.message)
    }
    return out
  }

  // ---------------------------------------------------------------- agents

  async createAgent(spec: Partial<AgentSpec> & { name: string; role: Role }, by: string): Promise<AgentSpec> {
    const base = roleTemplate(spec.role, '')
    const id = this.d.project.freeId(spec.name)
    const agent: AgentSpec = { ...base, ...Object.fromEntries(Object.entries(spec).filter(([, v]) => v !== undefined)), id, role: spec.role }
    await this.d.project.saveAgent(agent)
    this.chats[id] ??= []
    this.d.emit({ type: 'project', project: this.d.project.info() })
    if (by !== 'user') await this.logBus('create', by, id, `created ${agent.name}`)
    if (agent.role === 'context-handler') void this.bootstrapContext(agent, by === 'user' ? MASTERMIND_ID : by)
    return agent
  }

  async bootstrapContext(handler: AgentSpec, from = MASTERMIND_ID): Promise<void> {
    await this.logBus('context', from, handler.id, 'bootstrap the context set')
    await this.send(handler.id, BOOTSTRAP_TASK, from, 'context')
  }

  /** After a write agent changed the project, the Context Handler (if there is one) brings the map up to date. */
  private async updateContext(agent: AgentSpec, reports: Report[], git: string | null): Promise<void> {
    const handler = this.d.project.contextHandler()
    if (!handler || handler.id === agent.id) return
    const summary = reports.map((r) => r.summary).join('\n\n') || '(no report was filed)'
    const files = reports.flatMap((r) => r.files ?? [])
    const body =
      `${agent.name} just changed the project.\n\n## Their report\n${summary}\n\n` +
      (files.length ? `## Files they named\n${files.map((f) => `- ${f}`).join('\n')}\n\n` : '') +
      (git ? `## git status\n\`\`\`\n${git}\n\`\`\`\n\n` : '') +
      'Update every affected context file and add a changelog entry.'
    await this.logBus('context', agent.id, handler.id, `update context after ${agent.name}`)
    await this.send(handler.id, body, agent.id, 'context')
  }

  private gitState(): Promise<string | null> {
    return new Promise((resolve) =>
      exec('git status --porcelain', { cwd: this.d.project.dir, timeout: 10_000 }, (err, stdout) => resolve(err ? null : stdout.trim()))
    )
  }

  // ---------------------------------------------------------------- media

  async addMedia(item: MediaItem | null): Promise<MediaItem | null> {
    if (!item) return null
    this.media = [...this.media, item]
    await this.d.sessions.saveMedia(this.session.id, this.media)
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

  coordinationTools(agent: AgentSpec): ToolDef[] {
    const me = agent.id
    const question = z.object({
      question: z.string(),
      header: z.string().optional(),
      options: z.array(z.object({ label: z.string(), description: z.string().optional() })).min(1).max(6),
      multiSelect: z.boolean().optional()
    })
    const tools: ToolDef[] = [
      {
        name: 'message_agent',
        description: 'Send a message to another agent (by id or name). By default waits for and returns its reply.',
        shape: { to: z.string(), message: z.string(), wait_for_reply: z.boolean().optional() },
        handler: (a) => this.relay(me, String(a.to), String(a.message), 'message', a.wait_for_reply !== false)
      },
      {
        name: 'report',
        description: 'Report your result to whoever gave you this task. Put a full plan or design in plan_md and every file you changed in files.',
        shape: { summary: z.string(), plan_md: z.string().optional(), files: z.array(z.string()).optional() },
        handler: async (a) => {
          const ctx = this.turns.get(me)
          const r: Report = { summary: String(a.summary), files: (a.files as string[] | undefined) ?? undefined }
          if (a.plan_md) {
            r.planMd = String(a.plan_md)
            r.planPath = await this.d.sessions.savePlan(this.session.id, newId('plan'), r.planMd)
          }
          if (!ctx) return text('No task in progress to report on.', true)
          ctx.reports.push(r)
          if (ctx.from === 'user') await this.logBus('report', me, 'user', r.summary)
          return text(`Report recorded${r.planPath ? ` (plan saved to ${r.planPath})` : ''}. It goes back to ${ctx.from === 'user' ? 'the user' : (this.d.project.get(ctx.from)?.name ?? this.sourceNames.get(ctx.from) ?? ctx.from)} when your turn ends.`)
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
        name: 'list_agents',
        description: 'List the team: ids, names, roles, providers, models and whether they are busy.',
        shape: {},
        handler: async () =>
          text(
            this.d.project
              .list()
              .map((x) => `${x.id} | ${x.name} | ${x.role} | ${x.provider} ${x.model} (${x.effort}) | ${x.permissions}${x.gated ? ' | gated' : ''}${this.busy(x.id) ? ' | busy' : ''}`)
              .join('\n')
          )
      },
      {
        name: 'read_context',
        description: 'Read a file from .multimine/context/ (e.g. index.md, registries.md, systems/x.md). Without a file, lists them.',
        shape: { file: z.string().optional() },
        handler: async (a) => {
          const dir = this.d.project.paths.context
          if (!a.file) {
            const files = await listDeep(dir)
            return text(files.length ? files.join('\n') : 'The context set is empty. Read the code instead.')
          }
          try {
            return text(await readFile(insideProject(dir, String(a.file)), 'utf8'))
          } catch {
            return text(`No context file ${a.file}. Read the code instead.`, true)
          }
        }
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

    if (agent.role === 'context-handler') {
      tools.push({
        name: 'update_context',
        description: 'Write a file under .multimine/context/ (index.md, registries.md, systems/<name>.md, changelog.md).',
        shape: { file: z.string(), content: z.string() },
        handler: async (a) => {
          const path = insideProject(this.d.project.paths.context, String(a.file))
          await writeAtomic(path, String(a.content))
          await this.logBus('context', me, 'context', `wrote ${a.file}`)
          return text(`Wrote .multimine/context/${relative(this.d.project.paths.context, path)}`)
        }
      })
    }

    if (me !== MASTERMIND_ID) return tools

    tools.push(
      {
        name: 'create_agent',
        description: 'Create a new agent. role: planner|implementer|designer|brainstormer|context-handler|asset-creator|ui-creator|critic|custom. The purpose is its system brief. mcp lists MCP server ids it may use (see Settings), e.g. meshy, wavespeed.',
        shape: {
          name: z.string(),
          role: z.enum(ROLES as [Role, ...Role[]]),
          purpose: z.string().optional(),
          provider: z.enum(PROVIDERS).optional(),
          model: z.string().optional(),
          effort: z.enum(EFFORTS).optional(),
          permissions: z.enum(PERMISSIONS).optional(),
          color: z.string().optional(),
          mcp: z.array(z.string()).optional().describe('MCP server ids this agent may use, e.g. ["meshy","wavespeed"]')
        },
        handler: async (a) => {
          const agentSpec = await this.createAgent(a as any, me)
          return text(`Created ${agentSpec.name} (id ${agentSpec.id}).\n\n${serializeAgentFile(agentSpec)}`)
        }
      },
      {
        name: 'update_agent',
        description: "Change an agent's configuration or purpose. Only the fields you pass change.",
        shape: {
          agent: z.string(),
          name: z.string().optional(),
          purpose: z.string().optional(),
          append_purpose: z.string().optional().describe('Text appended to the purpose (e.g. new reporting instructions)'),
          provider: z.enum(PROVIDERS).optional(),
          model: z.string().optional(),
          effort: z.enum(EFFORTS).optional(),
          permissions: z.enum(PERMISSIONS).optional(),
          mcp: z.array(z.string()).optional().describe('Replaces the MCP server ids this agent may use')
        },
        handler: async (a) => {
          const target = this.d.project.find(String(a.agent))
          if (!target) return text(`No agent ${a.agent}`, true)
          const { agent: _ref, append_purpose, ...patch } = a as Record<string, any>
          const next: AgentSpec = { ...target, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) }
          if (append_purpose) next.purpose = `${next.purpose.trim()}\n\n${String(append_purpose).trim()}\n`
          await this.d.project.saveAgent(next)
          this.d.emit({ type: 'project', project: this.d.project.info() })
          return text(`Updated ${next.name}.`)
        }
      },
      {
        name: 'delegate',
        description: 'Give an agent a task and wait for its report. Gated agents (implementers) need approval_id from an approved request_approval.',
        shape: {
          agent: z.string(),
          task: z.string(),
          approval_id: z.string().optional(),
          difficulty: z.enum(DIFFICULTIES).optional().describe('Economy mode: light and standard tasks run on a cheaper model for this task only')
        },
        handler: async (a) => {
          const target = this.d.project.find(String(a.agent))
          if (!target) return text(`No agent ${a.agent}`, true)
          if (target.terminal) return text(`${target.name} is a terminal session the user drives; it cannot take delegated work. Use message_agent to tell it something.`, true)
          if (target.gated) {
            const approval = a.approval_id ? this.inbox.get(String(a.approval_id)) : undefined
            if (!approval || approval.kind !== 'approval' || !approval.approved)
              return text(`${target.name} is gated: call request_approval with the plan first, then pass its approval_id here.`, true)
          }
          return this.relay(me, target.id, String(a.task), 'delegate', true, a.difficulty as Difficulty | undefined)
        }
      },
      {
        name: 'request_approval',
        description: 'Ask the user to approve a plan. Include your own critique and the council verdict in plan_md. Returns APPROVED with an approval_id, or REJECTED with feedback.',
        shape: { title: z.string(), plan_md: z.string() },
        handler: async (a) => {
          const item = await this.requestApproval(me, String(a.title), String(a.plan_md))
          return item.approved
            ? text(`APPROVED${item.status === 'auto' ? ' (automation mode)' : ''}. approval_id: ${item.id}${item.note ? `\nNote: ${item.note}` : ''}`)
            : text(`REJECTED.${item.note ? ` Feedback: ${item.note}` : ' No feedback given.'}`)
        }
      },
      {
        name: 'run_council',
        description: 'Have independent critics review a plan from several perspectives (two rounds: blind, then cross-examination). Returns the verdict table.',
        shape: { plan_md: z.string(), focus: z.string().optional() },
        handler: async (a) => text((await this.council(String(a.plan_md), a.focus as string | undefined)).report)
      }
    )
    return tools
  }

  async council(plan: string, focus?: string) {
    const cfg = this.d.config.settings.council
    await this.logBus('critique', MASTERMIND_ID, 'council', `council of ${cfg.size} reviewing a plan`)
    const result = await runCouncil(plan, cfg, {
      complete: (system, prompt, criticId) =>
        this.complete(
          { ...roleTemplate('critic', criticId), provider: cfg.provider, model: cfg.model, effort: cfg.effort, permissions: 'chat' },
          system,
          prompt
        ),
      progress: (critics) => this.d.emit({ type: 'council', critics })
    }, focus)
    await this.logBus('critique', 'council', MASTERMIND_ID, `council: ${result.passed ? 'passes' : 'does not pass'} (${result.approvals}/${result.verdicts.length})`)
    setTimeout(() => this.d.emit({ type: 'council', critics: [] }), 4000)
    return result
  }
}

async function listDeep(dir: string, base = dir): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await listDeep(full, base)))
    else out.push(relative(base, full).split('\\').join('/'))
  }
  return out.sort()
}
