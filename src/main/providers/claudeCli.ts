import { query, type PermissionResult, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { clampEffort } from '@shared/effort'
import type { Question } from '@shared/types'
import type { AgentEvent, ProviderAdapter, TurnRequest } from './types'
import { hardStop } from './guard'
import { projectInstructions } from './projectDoc'

const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite']

const LOGIN_HELP =
  'Your Claude login has expired or is missing. Open a terminal, run `claude`, type `/login` and sign in with your subscription, then press Retry here.'

/** Claude Code's auth failures, said as what to do about them. Anything else passes through. */
export function friendlyClaudeError(raw: string): string {
  if (/authenticat|oauth|\b401\b|not logged in|invalid api key|please run \/login|credentials/i.test(raw)) return `${LOGIN_HELP}\n\n(${raw.trim()})`
  if (/rate.?limit|usage limit|\b429\b/i.test(raw)) return `Your Claude subscription hit its usage limit. Wait for it to reset, or switch this agent to another model or provider.\n\n(${raw.trim()})`
  return raw
}

/** A shell command that only looks at things. Anything else is refused to a read-only agent. */
export function readOnlyCommand(cmd: string): boolean {
  if (/[;&|]\s*(rm|mv|cp|chmod|chown|dd|mkfs|curl|wget)\b|>|\btee\b/.test(cmd)) return false
  return /^\s*(ls|dir|cat|head|tail|wc|find|grep|rg|tree|pwd|echo|git\s+(status|log|diff|show|branch|ls-files|blame)|type|which|stat|file)\b/.test(cmd)
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : typeof c === 'string' ? c : JSON.stringify(c)))
      .join('\n')
  return content == null ? '' : JSON.stringify(content)
}

/**
 * Claude subscription agents: the Claude Agent SDK, which drives the Claude Code runtime on the
 * user's own login. Real file tools, plan mode, AskUserQuestion and session resume come with it.
 */
/** One API message's usage, seen as it streams: the same message id can arrive more than once. */
export class CallMeter {
  private seen = new Map<string, { input: number; cacheRead: number; cacheWrite: number; output: number }>()
  readonly total = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }

  /** The growth since this message was last seen, or null when nothing grew. */
  see(id: string | undefined, u: any): { input: number; cacheRead: number; cacheWrite: number; output: number } | null {
    if (!id || !u) return null
    const now = { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 }
    const was = this.seen.get(id)
    if (!was) this.total.calls++
    const d = {
      input: Math.max(0, now.input - (was?.input ?? 0)),
      cacheRead: Math.max(0, now.cacheRead - (was?.cacheRead ?? 0)),
      cacheWrite: Math.max(0, now.cacheWrite - (was?.cacheWrite ?? 0)),
      output: Math.max(0, now.output - (was?.output ?? 0))
    }
    this.seen.set(id, { input: Math.max(now.input, was?.input ?? 0), cacheRead: Math.max(now.cacheRead, was?.cacheRead ?? 0), cacheWrite: Math.max(now.cacheWrite, was?.cacheWrite ?? 0), output: Math.max(now.output, was?.output ?? 0) })
    if (!d.input && !d.cacheRead && !d.cacheWrite && !d.output) return null
    this.total.input += d.input
    this.total.cacheRead += d.cacheRead
    this.total.cacheWrite += d.cacheWrite
    this.total.output += d.output
    return d
  }
}

/**
 * What a turn added to its Claude session's running cost total. A new session starts from zero; a
 * resumed one from the last total seen for it, and with none seen (resumed from before this app
 * started) nothing is claimed rather than the whole session's cost again.
 */
export function costAdded(seen: Map<string, number>, sessionId: string | undefined, resumeId: string | undefined, total: number | undefined): number | undefined {
  if (total === undefined) return undefined
  const before = (sessionId ? seen.get(sessionId) : undefined) ?? (resumeId ? seen.get(resumeId) : 0)
  if (sessionId) seen.set(sessionId, total)
  return before === undefined ? undefined : Math.max(0, total - before)
}

type QueryFn = typeof query

/** How long a warm session waits for its next turn before its process is let go. */
export const IDLE_MS = 20 * 60_000

/** A queue read as an async iterable: the prompt of a live query, and the messages of one turn. */
export class Channel<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private done = false

  push(x: T): void {
    if (this.done) return
    const w = this.waiters.shift()
    if (w) w({ value: x, done: false })
    else this.items.push(x)
  }

  end(): void {
    this.done = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () =>
        this.items.length ? Promise.resolve({ value: this.items.shift()!, done: false }) : this.done ? Promise.resolve({ value: undefined as never, done: true }) : new Promise((r) => this.waiters.push(r))
    }
  }
}

/**
 * One agent's Claude Code process, kept running between turns. A follow-up is one more message on
 * its prompt rather than a new process resuming the session from disk: no startup, no reload, and
 * the prompt cache stays warm. It is replaced when anything its options are made of changes.
 */
interface Live {
  key: string
  identity: string
  q: any
  input: Channel<SDKUserMessage>
  abort: AbortController
  /** The turn in progress (its messages), if any. */
  out: Channel<any> | null
  /** The request of the turn in progress, or the last one: its handlers answer the process. */
  turn: TurnRequest
  sessionId?: string
  dead: boolean
  idle?: ReturnType<typeof setTimeout>
  /** Why the process ended, when it ended on an error. */
  failure?: string
}

/** Thinking is asked for and shown as a summary; models before adaptive thinking get the default. */
function thinkingFor(model: string): { type: 'adaptive'; display: 'summarized' } | undefined {
  return /haiku|claude-3|-4-[0-5]\b/i.test(model) ? undefined : { type: 'adaptive', display: 'summarized' }
}

export class ClaudeCliProvider implements ProviderAdapter {
  /**
   * The SDK's cost is a running total for a Claude session, resumed turns included: the last total
   * seen per session, so a turn reports only what it added.
   */
  private costSeen = new Map<string, number>()
  private live = new Map<string, Live>()

  constructor(private readonly o: { query?: QueryFn; idleMs?: number } = {}) {}

  /** Lets go of warm processes whose key starts with `prefix` (all of them when it is empty). */
  release(prefix = ''): void {
    for (const s of [...this.live.values()]) if (s.key.startsWith(prefix)) this.close(s)
  }

  /** How many processes are being kept warm (for tests and diagnostics). */
  get warm(): number {
    return this.live.size
  }

  async *run(req: TurnRequest): AsyncIterable<AgentEvent> {
    if (!req.poolKey) return yield* this.oneShot(req)
    yield* this.pooled(req)
  }

  /** Everything a query is made of, with the handlers asking whichever request `current` returns. */
  private options(req: TurnRequest, current: () => TurnRequest) {
    const { agent } = req
    const mcpServers: Record<string, any> = {}
    if (req.busUrl) mcpServers.multimine = { type: 'http', url: req.busUrl, timeout: 3_600_000, alwaysLoad: true }
    for (const s of req.externalMcp) {
      mcpServers[s.id] =
        s.transport === 'http'
          ? { type: 'http', url: s.url, headers: s.headers ?? {} }
          : { type: 'stdio', command: s.command, args: s.args ?? [], env: s.env ?? {} }
    }
    const disallowed = agent.permissions === 'write' ? [] : agent.permissions === 'read' ? WRITE_TOOLS : [...WRITE_TOOLS, ...READ_TOOLS, 'Bash']

    const canUseTool = async (name: string, input: Record<string, unknown>): Promise<PermissionResult> => {
      const r = current()
      if (name === 'AskUserQuestion') {
        const questions = (input.questions ?? []) as Question[]
        const answers = await r.ask(questions)
        return { behavior: 'allow', updatedInput: { ...input, answers } }
      }
      if (name === 'ExitPlanMode') {
        const verdict = await r.approvePlan(String(input.plan ?? ''))
        return verdict.approved
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: `The plan was not approved.${verdict.note ? ` Feedback: ${verdict.note}` : ''} Revise it.` }
      }
      if (name.startsWith('mcp__multimine__')) return { behavior: 'allow', updatedInput: input }
      if (name === 'Bash') {
        const cmd = String(input.command ?? '')
        if (agent.permissions !== 'write' && !readOnlyCommand(cmd)) return { behavior: 'deny', message: 'This agent is read-only; that command changes things.' }
        const stop = hardStop(cmd)
        // a hard stop always asks; anything else asks only when auto-approve is off
        const ok = readOnlyCommand(cmd) && !stop ? true : await r.approveAction(stop ?? `run: ${cmd.slice(0, 60)}`, cmd, !!stop)
        return ok ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `The user did not allow: ${stop ?? cmd}` }
      }
      if (disallowed.includes(name)) return { behavior: 'deny', message: `This agent's permissions (${agent.permissions}) do not allow ${name}.` }
      if (READ_TOOLS.includes(name)) return { behavior: 'allow', updatedInput: input }
      const detail = String(input.file_path ?? input.url ?? input.path ?? JSON.stringify(input).slice(0, 400))
      return (await r.approveAction(`${name.replace(/^mcp__/, '')} ${detail}`.slice(0, 90), JSON.stringify(input, null, 2).slice(0, 1500)))
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: `The user did not allow ${name}.` }
    }

    // a large CLAUDE.md is not sent with every call: the agent gets its outline and reads what it needs
    const doc = projectInstructions(req.cwd)
    const append = doc.note && agent.permissions !== 'chat' ? `${req.system}\n\n${doc.note}` : req.system
    const thinking = thinkingFor(agent.model || '')
    const settings = { showThinkingSummaries: true, ...(doc.excludes.length ? { claudeMdExcludes: doc.excludes } : {}) }
    const fixed = {
      cwd: req.cwd,
      model: agent.model || undefined,
      effort: clampEffort('claude-cli', agent.effort),
      ...(thinking ? { thinking } : {}),
      systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append },
      includePartialMessages: true,
      // auto-approved writers skip edit prompts; otherwise every prompt reaches canUseTool and the user
      permissionMode: (agent.planMode ? 'plan' : agent.permissions === 'write' && agent.autoApprove ? 'acceptEdits' : 'default') as 'plan' | 'acceptEdits' | 'default',
      disallowedTools: disallowed,
      allowedTools: agent.autoApprove ? Object.keys(mcpServers).map((k) => `mcp__${k}`) : ['mcp__multimine'],
      mcpServers,
      settingSources: ['user', 'project', 'local'] as ('user' | 'project' | 'local')[],
      settings,
      pathToClaudeCodeExecutable: req.executable || undefined
    }
    // the loop guard sees every call, including ones the user's own settings allow outright
    const hooks = {
      PreToolUse: [
        {
          timeout: 86_400,
          hooks: [
            async (input: any) => {
              const watch = current().watch
              if (!watch) return { continue: true }
              const v = await watch(String(input.tool_name ?? ''), input.tool_input)
              return v.ok ? { continue: true } : { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: v.reason } }
            }
          ]
        }
      ]
    }
    return { fixed, canUseTool, hooks, identity: JSON.stringify(fixed) }
  }

  /** One process for one turn: helpers (the council, automation's answers) and fallback hops. */
  private async *oneShot(req: TurnRequest): AsyncIterable<AgentEvent> {
    const abort = new AbortController()
    req.signal.addEventListener('abort', () => abort.abort(), { once: true })
    const o = this.options(req, () => req)
    let stream
    try {
      stream = (this.o.query ?? query)({
        prompt: req.prompt,
        options: { ...o.fixed, resume: req.resumeId, canUseTool: o.canUseTool, abortController: abort, hooks: req.watch ? o.hooks : undefined }
      })
    } catch (e) {
      yield { type: 'error', message: `Could not start Claude: ${(e as Error).message}` }
      return
    }
    const t = new Translator(this.costSeen, req.resumeId)
    try {
      for await (const msg of stream as AsyncIterable<any>) yield* t.map(msg)
    } catch (e) {
      if (!req.signal.aborted) yield { type: 'error', message: friendlyClaudeError((e as Error).message ?? String(e)) }
    }
  }

  /** A turn on the agent's warm process, opening (or reopening) it when it cannot serve this turn. */
  private async *pooled(req: TurnRequest): AsyncIterable<AgentEvent> {
    const key = req.poolKey!
    let s = this.live.get(key)
    const draft = this.options(req, () => s?.turn ?? req)
    // the same process serves the turn only if nothing it was made from has changed and it holds
    // exactly the conversation this turn continues (a fresh task asks for none)
    if (s && (s.dead || s.out || s.identity !== draft.identity || s.sessionId !== req.resumeId)) {
      this.close(s)
      s = undefined
    }
    if (!s) {
      try {
        s = this.open(key, req, draft)
      } catch (e) {
        yield { type: 'error', message: `Could not start Claude: ${(e as Error).message}` }
        return
      }
    }
    const live = s
    if (live.idle) clearTimeout(live.idle)
    live.turn = req
    const out = new Channel<any>()
    live.out = out
    const t = new Translator(this.costSeen, req.resumeId, () => live.sessionId)
    // stopping a turn stops the process: the next turn resumes the session in a new one
    const onAbort = () => {
      void Promise.resolve(live.q.interrupt?.()).catch(() => undefined)
      this.close(live)
    }
    if (req.signal.aborted) {
      onAbort()
      live.out = null
      return
    }
    req.signal.addEventListener('abort', onAbort, { once: true })
    live.input.push({ type: 'user', message: { role: 'user', content: req.prompt }, parent_tool_use_id: null } as SDKUserMessage)
    let ended = false
    try {
      for await (const msg of out) {
        yield* t.map(msg)
        if (msg.type === 'result') {
          ended = true
          break
        }
      }
      if (!ended && !req.signal.aborted) yield { type: 'error', message: friendlyClaudeError(live.failure ?? 'Claude stopped before finishing the turn.') }
    } finally {
      req.signal.removeEventListener('abort', onAbort)
      if (live.out === out) live.out = null
      if (!live.dead) this.arm(live)
    }
  }

  private open(key: string, req: TurnRequest, o: ReturnType<ClaudeCliProvider['options']>): Live {
    const input = new Channel<SDKUserMessage>()
    const abort = new AbortController()
    const s: Live = { key, identity: o.identity, q: null, input, abort, out: null, turn: req, dead: false, sessionId: req.resumeId }
    const current = () => s.turn
    const fresh = this.options(req, current)
    s.q = (this.o.query ?? query)({
      prompt: input,
      options: { ...fresh.fixed, resume: req.resumeId, canUseTool: fresh.canUseTool, abortController: abort, hooks: fresh.hooks }
    })
    this.live.set(key, s)
    void this.pump(s)
    return s
  }

  /** Reads the live process for as long as it runs, handing each message to the turn in progress. */
  private async pump(s: Live): Promise<void> {
    try {
      for await (const msg of s.q as AsyncIterable<any>) {
        if (msg?.type === 'system' && msg.subtype === 'init' && msg.session_id) s.sessionId = msg.session_id
        else if (msg?.session_id && !s.sessionId) s.sessionId = msg.session_id
        s.out?.push(msg)
      }
    } catch (e) {
      s.failure = (e as Error)?.message ?? String(e)
    } finally {
      this.close(s)
    }
  }

  private arm(s: Live): void {
    if (s.idle) clearTimeout(s.idle)
    s.idle = setTimeout(() => this.close(s), this.o.idleMs ?? IDLE_MS)
    s.idle.unref?.()
  }

  private close(s: Live): void {
    if (s.idle) clearTimeout(s.idle)
    if (this.live.get(s.key) === s) this.live.delete(s.key)
    if (s.dead) return
    s.dead = true
    s.input.end()
    s.out?.end()
    s.abort.abort()
  }
}

/** Claude Code's messages as Multimine events, for one turn. */
class Translator {
  private streamed = new Set<string>()
  private current: string | null = null
  private meter = new CallMeter()
  private sessionId: string | undefined

  constructor(
    private readonly costSeen: Map<string, number>,
    private readonly resumeId: string | undefined,
    private readonly liveSession?: () => string | undefined
  ) {}

  *map(msg: any): Generator<AgentEvent> {
    // the session id is the resume handle; announce it when the process says it
    if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
      this.sessionId = msg.session_id
      yield { type: 'resume', id: msg.session_id }
    }
    // every model call counts, a sub-agent's as much as the agent's own
    if (msg.type === 'assistant') {
      const d = this.meter.see(msg.message?.id, msg.message?.usage)
      if (d) yield { type: 'call-usage', ...d }
    }
    // a sub-agent's inner traffic: its tool calls are shown nested under the call that started it
    const parent: string | undefined = msg.parent_tool_use_id ?? undefined
    if (parent) {
      if (msg.type === 'assistant')
        for (const block of msg.message?.content ?? []) if (block.type === 'tool_use') yield { type: 'tool-start', id: block.id, name: block.name, input: block.input, parent }
      if (msg.type === 'user' && Array.isArray(msg.message?.content))
        for (const block of msg.message.content) if (block.type === 'tool_result') yield { type: 'tool-end', id: block.tool_use_id, output: textOf(block.content), isError: !!block.is_error, parent }
      if (msg.type === 'tool_progress') yield { type: 'progress', id: parent }
      return
    }
    switch (msg.type) {
      case 'tool_progress':
        yield { type: 'progress', id: msg.tool_use_id }
        break
      case 'system':
        if (msg.subtype === 'task_progress' && msg.tool_use_id) yield { type: 'progress', id: msg.tool_use_id, note: String(msg.description ?? '').slice(0, 160) }
        break
      case 'stream_event': {
        const ev = msg.event
        if (ev?.type === 'message_start') this.current = ev.message?.id ?? null
        if (ev?.type === 'content_block_delta') {
          if (this.current) this.streamed.add(this.current)
          if (ev.delta?.type === 'text_delta') yield { type: 'text', delta: ev.delta.text }
          else if (ev.delta?.type === 'thinking_delta') yield { type: 'thinking', delta: ev.delta.thinking }
        }
        break
      }
      case 'assistant': {
        const m = msg.message
        const sawDeltas = m?.id && this.streamed.has(m.id)
        if (msg.error) {
          // a synthetic message carrying an API error: its text is the error, not a reply
          yield { type: 'error', message: friendlyClaudeError(`${msg.error}: ${(m?.content ?? []).map((b: any) => b.text ?? '').join(' ')}`) }
          break
        }
        for (const block of m?.content ?? []) {
          if (block.type === 'tool_use') yield { type: 'tool-start', id: block.id, name: block.name, input: block.input }
          else if (!sawDeltas && block.type === 'text') yield { type: 'text', delta: block.text }
          else if (!sawDeltas && block.type === 'thinking') yield { type: 'thinking', delta: block.thinking }
        }
        break
      }
      case 'user': {
        const content = msg.message?.content
        if (Array.isArray(content))
          for (const block of content) if (block.type === 'tool_result') yield { type: 'tool-end', id: block.tool_use_id, output: textOf(block.content), isError: !!block.is_error }
        break
      }
      case 'rate_limit_event': {
        const info = msg.rate_limit_info ?? {}
        const state = info.status === 'rejected' ? 'exhausted' : info.status === 'allowed_warning' ? 'near' : 'ok'
        const pct = typeof info.utilization === 'number' ? ` (${Math.round(info.utilization <= 1 ? info.utilization * 100 : info.utilization)}% used)` : ''
        yield {
          type: 'limit',
          state,
          resetsAt: info.resetsAt,
          detail: `${String(info.rateLimitType ?? 'usage').replace(/_/g, ' ')} limit${pct}`,
          window: typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined,
          used: typeof info.utilization === 'number' ? info.utilization : undefined
        }
        break
      }
      case 'result': {
        const u = msg.usage ?? {}
        const t = this.meter.total
        // the running total for the session: what this turn added is the growth since the last one
        // seen; a session resumed from before this app started has no baseline, so no cost is claimed
        const total = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined
        const added = costAdded(this.costSeen, this.sessionId ?? this.liveSession?.() ?? msg.session_id, this.resumeId, total)
        yield {
          type: 'usage',
          inputTokens: t.calls ? t.input : (u.input_tokens ?? 0),
          cacheRead: t.calls ? t.cacheRead : (u.cache_read_input_tokens ?? 0),
          cacheWrite: t.calls ? t.cacheWrite : (u.cache_creation_input_tokens ?? 0),
          outputTokens: t.calls ? t.output : (u.output_tokens ?? 0),
          calls: t.calls || undefined,
          costUsd: added
        }
        if (msg.subtype !== 'success' || msg.is_error) yield { type: 'error', message: friendlyClaudeError((msg.errors ?? [msg.result ?? msg.subtype]).join('; ')) }
        break
      }
    }
  }
}
