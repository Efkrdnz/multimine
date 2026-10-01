import { exec } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { serializeAgentFile } from '@shared/agentFile'
import { newId } from '@shared/ids'
import { roleTemplate } from '@shared/templates'
import {
  EFFORTS,
  MASTERMIND_ID,
  PERMISSIONS,
  PROVIDERS,
  type AgentSpec,
  type AgentStatus,
  type BusEvent,
  type BusKind,
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
import { formatAnswers, Inbox, recommendedAnswers } from './inbox'
import { runCouncil } from './council'
import { insideProject, workspaceTools } from './workspace'

export interface EngineDeps {
  project: ProjectStore
  sessions: SessionStore
  config: AppConfig
  providers: ProviderRegistry
  emit: (e: MainEvent) => void
  hub?: McpHub
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

const ROLES: Role[] = ['planner', 'implementer', 'designer', 'brainstormer', 'context-handler', 'critic', 'custom']
const text = (t: string, isError = false): ToolOutput => ({ text: t, isError })

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
  private queues = new Map<string, Promise<unknown>>()
  private turns = new Map<string, TurnContext>()
  private waits = new Map<string, string>()
  private controllers = new Map<string, AbortController>()
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private totals: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
  private mediaStore: MediaStore

  constructor(private readonly d: EngineDeps) {
    this.mediaStore = new MediaStore(d.project.paths.media)
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
    })
    void this.d.sessions.saveInbox(meta.id, this.inbox.items)
    this.totals = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
    for (const msgs of Object.values(this.chats))
      for (const m of msgs)
        if (m.usage) {
          this.totals.inputTokens += m.usage.inputTokens
          this.totals.outputTokens += m.usage.outputTokens
          this.totals.costUsd = (this.totals.costUsd ?? 0) + (m.usage.costUsd ?? 0)
        }
    this.status.clear()
    await this.emitSessions()
    this.d.emit({ type: 'chat-reset', chats: this.chats })
    this.d.emit({ type: 'bus-reset', events: this.bus })
    this.d.emit({ type: 'inbox', items: this.inbox.items })
    this.d.emit({ type: 'media', items: this.media })
    this.d.emit({ type: 'usage', total: this.totals })
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

  private setStatus(agentId: string, status: AgentStatus, activity?: string): void {
    this.status.set(agentId, status)
    this.d.emit({ type: 'status', agentId, status, activity })
  }

  busy(agentId: string): boolean {
    return this.turns.has(agentId)
  }

  /** Queues a turn for an agent. Turns of one agent never overlap; different agents run in parallel. */
  send(agentId: string, body: string, from = 'user', kind: BusKind = 'message'): Promise<TurnResult> {
    const prev = this.queues.get(agentId) ?? Promise.resolve()
    const next = prev.then(() => this.runTurn(agentId, body, from, kind))
    this.queues.set(
      agentId,
      next.catch(() => undefined)
    )
    return next
  }

  stop(agentId: string): void {
    this.controllers.get(agentId)?.abort()
  }

  private history(agentId: string): HistoryItem[] {
    return (this.chats[agentId] ?? [])
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
      }, 40)
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

  private resumeKey(agent: AgentSpec): string | undefined {
    const raw = this.session.resume[agent.id]
    if (!raw) return undefined
    const [provider, ...rest] = raw.split(':')
    return provider === agent.provider ? rest.join(':') : undefined
  }

  private async saveResume(agent: AgentSpec, id: string): Promise<void> {
    this.session.resume[agent.id] = `${agent.provider}:${id}`
    this.session.updated = Date.now()
    await this.d.sessions.save(this.session)
  }

  private async runTurn(agentId: string, body: string, from: string, kind: BusKind): Promise<TurnResult> {
    const agent = this.d.project.get(agentId)
    if (!agent) return { text: '', reports: [], error: `No agent ${agentId}` }
    const sessionId = this.session.id
    const fromName = from === 'user' ? 'user' : (this.d.project.get(from)?.name ?? from)
    const prompt = from === 'user' ? body : inboundPrompt(fromName, kind === 'delegate' ? 'delegate' : kind === 'context' ? 'context' : 'message', body)

    const userMsg: ChatMessage = { id: newId('u'), agentId, role: 'user', from, text: from === 'user' ? body : prompt, ts: Date.now() }
    const history = this.history(agentId)
    this.upsert(userMsg, true)
    await this.persist(userMsg)

    const ctx: TurnContext = { from, kind, reports: [] }
    this.turns.set(agentId, ctx)
    const ctl = new AbortController()
    this.controllers.set(agentId, ctl)
    this.setStatus(agentId, 'thinking')

    const reply: ChatMessage = { id: newId('r'), agentId, role: 'assistant', from: agentId, text: '', ts: Date.now(), streaming: true, tools: [] }
    this.upsert(reply, true)

    const isCli = ProviderRegistry.isCli(agent.provider)
    const watchChanges = agent.permissions === 'write' && agent.role !== 'context-handler'
    const gitBefore = watchChanges ? await this.gitState() : null
    const resumeId = this.resumeKey(agent)
    let finalPrompt = prompt
    if (agent.provider === 'claude-cli' && !resumeId && history.length) {
      finalPrompt = `# Conversation so far\n${history.map((h) => `${h.role === 'user' ? 'User' : 'You'}: ${h.text}`).join('\n\n')}\n\n# Now\n${prompt}`
    }

    let error: string | undefined
    try {
      const req: TurnRequest = {
        agent,
        system: this.systemPrompt(agent),
        history,
        prompt: finalPrompt,
        cwd: this.d.project.dir,
        resumeId,
        tools: await this.toolsFor(agent, isCli),
        busUrl: isCli ? this.d.busUrl?.(agent.id) : undefined,
        externalMcp: this.d.config.settings.mcpServers.filter((s) => agent.mcp.includes(s.id)),
        apiKey: this.d.config.getKey(agent.provider),
        baseUrl: this.d.config.settings.baseUrls[agent.provider],
        executable: agent.provider === 'claude-cli' ? this.d.config.settings.claudePath : agent.provider === 'codex-cli' ? this.d.config.settings.codexPath : undefined,
        signal: ctl.signal,
        ask: (qs) => this.askUser(agent.id, qs).then((item) => item.answers ?? {}),
        approvePlan: (plan) => this.requestApproval(agent.id, `${agent.name} wants to leave plan mode`, plan).then((i) => ({ approved: !!i.approved, note: i.note })),
        approveAction: (title, detail) => this.approveAction(agent.id, title, detail)
      }
      for await (const ev of this.d.providers.get(agent.provider).run(req)) {
        if (sessionId !== this.session.id) break
        switch (ev.type) {
          case 'text':
            reply.text += ev.delta
            this.setStatusOnce(agentId, 'working')
            this.d.emit({ type: 'talk', agentId })
            break
          case 'thinking':
            reply.thinking = (reply.thinking ?? '') + ev.delta
            this.setStatusOnce(agentId, 'thinking')
            break
          case 'tool-start':
            reply.tools!.push({ id: ev.id, name: ev.name, input: ev.input, status: 'running' })
            this.setStatus(agentId, 'working', ev.name.replace(/^mcp__multimine__/, ''))
            break
          case 'tool-end': {
            const t = reply.tools!.find((x) => x.id === ev.id)
            if (t) Object.assign(t, { output: ev.output.slice(0, 20_000), status: ev.isError ? 'error' : 'done' })
            if (isCli && t && !t.name.includes('multimine')) void this.captureFromText(agent.id, ev.output, t.name)
            break
          }
          case 'resume':
            await this.saveResume(agent, ev.id)
            break
          case 'usage':
            reply.usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, costUsd: ev.costUsd }
            this.totals.inputTokens += ev.inputTokens
            this.totals.outputTokens += ev.outputTokens
            this.totals.costUsd = (this.totals.costUsd ?? 0) + (ev.costUsd ?? 0)
            this.d.emit({ type: 'usage', total: { ...this.totals } })
            break
          case 'error':
            error = ev.message
            break
        }
        this.upsert(reply)
      }
    } catch (e) {
      error = (e as Error).message ?? String(e)
    } finally {
      this.turns.delete(agentId)
      this.controllers.delete(agentId)
    }
    if (ctl.signal.aborted && !error) error = 'Stopped.'
    reply.streaming = false
    if (error) reply.error = error
    for (const t of reply.tools ?? []) if (t.status === 'running') t.status = 'error'
    if (sessionId === this.session.id) {
      this.upsert(reply, true)
      await this.persist(reply)
      this.setStatus(agentId, error && error !== 'Stopped.' ? 'error' : 'idle')
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

  private setStatusOnce(agentId: string, s: AgentStatus): void {
    if (this.status.get(agentId) !== s) this.setStatus(agentId, s)
  }

  systemPrompt(agent: AgentSpec): string {
    return buildSystemPrompt({
      agent,
      agents: this.d.project.list(),
      projectDir: this.d.project.dir,
      multimineMd: this.d.project.multimineMd,
      hasContextHandler: !!this.d.project.contextHandler(),
      automation: this.d.config.settings.automation
    })
  }

  // ---------------------------------------------------------------- bus

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
  async relay(from: string, toRef: string, body: string, kind: BusKind, wait: boolean): Promise<ToolOutput> {
    const target = this.d.project.find(toRef)
    if (!target) return text(`No agent "${toRef}". Use list_agents.`, true)
    if (wait && this.wouldDeadlock(from, target.id)) return text(`${target.name} is waiting on you; waiting back would deadlock. Use report, or message without waiting.`, true)
    await this.logBus(kind, from, target.id, body)
    if (!wait) {
      void this.send(target.id, body, from, kind)
      return text(`Sent to ${target.name}. Not waiting for a reply.`)
    }
    this.waits.set(from, target.id)
    const prev = this.status.get(from)
    this.setStatus(from, 'working', `waiting for ${target.name}`)
    try {
      const res = await this.send(target.id, body, from, kind)
      await this.logBus(res.reports.length ? 'report' : 'message', target.id, from, res.text || res.error || '(no reply)')
      return text(`${target.name} replied${res.error ? ` (with error: ${res.error})` : ''}:\n\n${res.text || '(no text)'}`, !!res.error && !res.text)
    } finally {
      this.waits.delete(from)
      if (this.turns.has(from)) this.setStatus(from, prev === 'thinking' ? 'thinking' : 'working')
    }
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

  /** Hard stops (git push, recursive delete...) always wait for the user, automation or not. */
  async approveAction(askedBy: string, title: string, detail: string): Promise<boolean> {
    await this.logBus('approval', askedBy, 'user', `Allow ${title}?`)
    const prev = this.status.get(askedBy)
    this.setStatus(askedBy, 'waiting', `allow ${title}?`)
    const item = await this.inbox.approval(askedBy, `Allow ${title}?`, `\`\`\`\n${detail}\n\`\`\`\n\nThis always needs you, even in automation mode.`)
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
      tools.push(...workspaceTools(this.d.project.dir, agent.permissions, (t, d) => this.approveAction(agent.id, t, d)))
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
          return text(`Report recorded${r.planPath ? ` (plan saved to ${r.planPath})` : ''}. It goes back to ${ctx.from === 'user' ? 'the user' : (this.d.project.get(ctx.from)?.name ?? ctx.from)} when your turn ends.`)
        }
      },
      {
        name: 'ask_user',
        description: 'Ask the user one to four structured questions. Each has 2-6 options, recommended first. Blocks until answered.',
        shape: { questions: z.array(question).min(1).max(4) },
        handler: async (a) => text(formatAnswers(await this.askUser(me, a.questions as Question[])))
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
        description: 'Create a new agent. role: planner|implementer|designer|brainstormer|context-handler|critic|custom. The purpose is its system brief.',
        shape: {
          name: z.string(),
          role: z.enum(ROLES as [Role, ...Role[]]),
          purpose: z.string().optional(),
          provider: z.enum(PROVIDERS).optional(),
          model: z.string().optional(),
          effort: z.enum(EFFORTS).optional(),
          permissions: z.enum(PERMISSIONS).optional(),
          color: z.string().optional()
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
          permissions: z.enum(PERMISSIONS).optional()
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
        shape: { agent: z.string(), task: z.string(), approval_id: z.string().optional() },
        handler: async (a) => {
          const target = this.d.project.find(String(a.agent))
          if (!target) return text(`No agent ${a.agent}`, true)
          if (target.gated) {
            const approval = a.approval_id ? this.inbox.get(String(a.approval_id)) : undefined
            if (!approval || approval.kind !== 'approval' || !approval.approved)
              return text(`${target.name} is gated: call request_approval with the plan first, then pass its approval_id here.`, true)
          }
          return this.relay(me, target.id, String(a.task), 'delegate', true)
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
