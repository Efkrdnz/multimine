import { query, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
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

export class ClaudeCliProvider implements ProviderAdapter {
  /**
   * The SDK's cost is a running total for a Claude session, resumed turns included: the last total
   * seen per session, so a turn reports only what it added.
   */
  private costSeen = new Map<string, number>()

  async *run(req: TurnRequest): AsyncIterable<AgentEvent> {
    const { agent } = req
    const abort = new AbortController()
    req.signal.addEventListener('abort', () => abort.abort(), { once: true })

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
      if (name === 'AskUserQuestion') {
        const questions = (input.questions ?? []) as Question[]
        const answers = await req.ask(questions)
        return { behavior: 'allow', updatedInput: { ...input, answers } }
      }
      if (name === 'ExitPlanMode') {
        const verdict = await req.approvePlan(String(input.plan ?? ''))
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
        const ok = readOnlyCommand(cmd) && !stop ? true : await req.approveAction(stop ?? `run: ${cmd.slice(0, 60)}`, cmd, !!stop)
        return ok ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `The user did not allow: ${stop ?? cmd}` }
      }
      if (disallowed.includes(name)) return { behavior: 'deny', message: `This agent's permissions (${agent.permissions}) do not allow ${name}.` }
      if (READ_TOOLS.includes(name)) return { behavior: 'allow', updatedInput: input }
      const detail = String(input.file_path ?? input.url ?? input.path ?? JSON.stringify(input).slice(0, 400))
      return (await req.approveAction(`${name.replace(/^mcp__/, '')} ${detail}`.slice(0, 90), JSON.stringify(input, null, 2).slice(0, 1500)))
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: `The user did not allow ${name}.` }
    }

    // a large CLAUDE.md is not sent with every call: the agent gets its outline and reads what it needs
    const doc = projectInstructions(req.cwd)

    let stream
    try {
      stream = query({
        prompt: req.prompt,
        options: {
          cwd: req.cwd,
          model: agent.model || undefined,
          effort: clampEffort('claude-cli', agent.effort),
          systemPrompt: { type: 'preset', preset: 'claude_code', append: doc.note && agent.permissions !== 'chat' ? `${req.system}\n\n${doc.note}` : req.system },
          resume: req.resumeId,
          includePartialMessages: true,
          // auto-approved writers skip edit prompts; otherwise every prompt reaches canUseTool and the user
          permissionMode: agent.planMode ? 'plan' : agent.permissions === 'write' && agent.autoApprove ? 'acceptEdits' : 'default',
          canUseTool,
          disallowedTools: disallowed,
          allowedTools: agent.autoApprove ? Object.keys(mcpServers).map((k) => `mcp__${k}`) : ['mcp__multimine'],
          mcpServers,
          settingSources: ['user', 'project', 'local'],
          settings: doc.excludes.length ? { claudeMdExcludes: doc.excludes } : undefined,
          abortController: abort,
          // the loop guard sees every call, including ones the user's own settings allow outright
          hooks: req.watch
            ? {
                PreToolUse: [
                  {
                    timeout: 86_400,
                    hooks: [
                      async (input: any) => {
                        const v = await req.watch!(String(input.tool_name ?? ''), input.tool_input)
                        return v.ok ? { continue: true } : { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: v.reason } }
                      }
                    ]
                  }
                ]
              }
            : undefined,
          pathToClaudeCodeExecutable: req.executable || undefined
        }
      })
    } catch (e) {
      yield { type: 'error', message: `Could not start Claude: ${(e as Error).message}` }
      return
    }

    const streamed = new Set<string>()
    let current: string | null = null
    const meter = new CallMeter()
    let sessionId: string | undefined
    try {
      for await (const msg of stream as AsyncIterable<any>) {
        if (msg.session_id) {
          // the session id is the resume handle; announce it once
          if (msg.type === 'system' && msg.subtype === 'init') {
            sessionId = msg.session_id
            yield { type: 'resume', id: msg.session_id }
          }
        }
        // every model call counts, a sub-agent's as much as the agent's own
        if (msg.type === 'assistant') {
          const d = meter.see(msg.message?.id, msg.message?.usage)
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
          continue
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
            if (ev?.type === 'message_start') current = ev.message?.id ?? null
            if (ev?.type === 'content_block_delta') {
              if (current) streamed.add(current)
              if (ev.delta?.type === 'text_delta') yield { type: 'text', delta: ev.delta.text }
              else if (ev.delta?.type === 'thinking_delta') yield { type: 'thinking', delta: ev.delta.thinking }
            }
            break
          }
          case 'assistant': {
            const m = msg.message
            const sawDeltas = m?.id && streamed.has(m.id)
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
              for (const block of content)
                if (block.type === 'tool_result') yield { type: 'tool-end', id: block.tool_use_id, output: textOf(block.content), isError: !!block.is_error }
            break
          }
          case 'rate_limit_event': {
            const info = msg.rate_limit_info ?? {}
            const state = info.status === 'rejected' ? 'exhausted' : info.status === 'allowed_warning' ? 'near' : 'ok'
            const pct = typeof info.utilization === 'number' ? ` (${Math.round(info.utilization <= 1 ? info.utilization * 100 : info.utilization)}% used)` : ''
            yield { type: 'limit', state, resetsAt: info.resetsAt, detail: `${String(info.rateLimitType ?? 'usage').replace(/_/g, ' ')} limit${pct}` }
            break
          }
          case 'result': {
            const u = msg.usage ?? {}
            const t = meter.total
            // the running total for the session: what this turn added is the growth since the last one
            // seen; a session resumed from before this app started has no baseline, so no cost is claimed
            const total = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined
            const added = costAdded(this.costSeen, sessionId ?? msg.session_id, req.resumeId, total)
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
    } catch (e) {
      if (!req.signal.aborted) yield { type: 'error', message: friendlyClaudeError((e as Error).message ?? String(e)) }
    }
  }
}
