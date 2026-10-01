import { query, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { clampEffort } from '@shared/effort'
import type { Question } from '@shared/types'
import type { AgentEvent, ProviderAdapter, TurnRequest } from './types'
import { hardStop } from './guard'

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
export class ClaudeCliProvider implements ProviderAdapter {
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
      if (name.startsWith('mcp__')) return { behavior: 'allow', updatedInput: input }
      if (name === 'Bash') {
        const cmd = String(input.command ?? '')
        if (agent.permissions !== 'write' && !readOnlyCommand(cmd)) return { behavior: 'deny', message: 'This agent is read-only; that command changes things.' }
        const stop = hardStop(cmd)
        if (stop && !(await req.approveAction(stop, cmd))) return { behavior: 'deny', message: `The user did not allow: ${stop}` }
        return { behavior: 'allow', updatedInput: input }
      }
      if (disallowed.includes(name)) return { behavior: 'deny', message: `This agent's permissions (${agent.permissions}) do not allow ${name}.` }
      return { behavior: 'allow', updatedInput: input }
    }

    let stream
    try {
      stream = query({
        prompt: req.prompt,
        options: {
          cwd: req.cwd,
          model: agent.model || undefined,
          effort: clampEffort('claude-cli', agent.effort),
          systemPrompt: { type: 'preset', preset: 'claude_code', append: req.system },
          resume: req.resumeId,
          includePartialMessages: true,
          permissionMode: agent.planMode ? 'plan' : agent.permissions === 'write' ? 'acceptEdits' : 'default',
          canUseTool,
          disallowedTools: disallowed,
          allowedTools: Object.keys(mcpServers).map((k) => `mcp__${k}`),
          mcpServers,
          settingSources: ['user', 'project', 'local'],
          abortController: abort,
          pathToClaudeCodeExecutable: req.executable || undefined
        }
      })
    } catch (e) {
      yield { type: 'error', message: `Could not start Claude: ${(e as Error).message}` }
      return
    }

    const streamed = new Set<string>()
    let current: string | null = null
    try {
      for await (const msg of stream as AsyncIterable<any>) {
        if (msg.session_id) {
          // the session id is the resume handle; announce it once
          if (msg.type === 'system' && msg.subtype === 'init') yield { type: 'resume', id: msg.session_id }
        }
        if (msg.parent_tool_use_id) continue // a subagent's inner traffic
        switch (msg.type) {
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
          case 'result': {
            const u = msg.usage ?? {}
            yield {
              type: 'usage',
              inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
              outputTokens: u.output_tokens ?? 0,
              costUsd: msg.total_cost_usd
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
