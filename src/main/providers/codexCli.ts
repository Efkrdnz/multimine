import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { clampEffort } from '@shared/effort'
import type { McpServerConfig } from '@shared/types'
import type { AgentEvent, ProviderAdapter, TurnRequest } from './types'

const toml = (s: string) => JSON.stringify(s)

function mcpArgs(id: string, s: Pick<McpServerConfig, 'transport' | 'url' | 'command' | 'args' | 'env'>): string[] {
  const out: string[] = []
  const key = `mcp_servers.${id}`
  if (s.transport === 'http') {
    out.push('-c', `${key}.url=${toml(s.url ?? '')}`)
  } else {
    out.push('-c', `${key}.command=${toml(s.command ?? '')}`)
    out.push('-c', `${key}.args=[${(s.args ?? []).map(toml).join(',')}]`)
    const env = Object.entries(s.env ?? {})
    if (env.length) out.push('-c', `${key}.env={${env.map(([k, v]) => `${k}=${toml(v)}`).join(',')}}`)
  }
  out.push('-c', `${key}.tool_timeout_sec=3600`)
  return out
}

/** The argument list for one `codex exec` turn. The prompt itself goes in on stdin (`-`). */
export function codexArgs(req: Pick<TurnRequest, 'agent' | 'cwd' | 'resumeId' | 'busUrl' | 'externalMcp'>): string[] {
  const { agent } = req
  const args = ['exec', '--json', '--skip-git-repo-check', '--cd', req.cwd]
  if (agent.model) args.push('-m', agent.model)
  args.push('-c', `model_reasoning_effort=${toml(clampEffort('codex-cli', agent.effort))}`)
  // codex exec cannot ask mid-run, so auto-approve means "full access" (network, outside the
  // folder) and off means sandboxed; pushing goes through the request_permission tool instead
  args.push('--sandbox', agent.permissions !== 'write' ? 'read-only' : agent.autoApprove ? 'danger-full-access' : 'workspace-write')
  if (req.busUrl) args.push(...mcpArgs('multimine', { transport: 'http', url: req.busUrl }))
  for (const s of req.externalMcp) args.push(...mcpArgs(s.id.replace(/[^a-zA-Z0-9_-]/g, '_'), s))
  if (req.resumeId) args.push('resume', req.resumeId)
  args.push('-')
  return args
}

/** Turns one line of `codex exec --json` output into zero or more agent events. */
export function codexEvents(line: string): AgentEvent[] {
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    return []
  }
  const item = ev.item ?? {}
  switch (ev.type) {
    case 'thread.started':
      return ev.thread_id ? [{ type: 'resume', id: ev.thread_id }] : []
    case 'item.started':
      if (item.type === 'command_execution') return [{ type: 'tool-start', id: item.id, name: 'shell', input: { command: item.command } }]
      if (item.type === 'mcp_tool_call') return [{ type: 'tool-start', id: item.id, name: `${item.server}.${item.tool}`, input: item.arguments ?? {} }]
      if (item.type === 'web_search') return [{ type: 'tool-start', id: item.id, name: 'web_search', input: { query: item.query } }]
      return []
    case 'item.completed':
      switch (item.type) {
        case 'agent_message':
          return item.text ? [{ type: 'text', delta: item.text }] : []
        case 'reasoning':
          return item.text ? [{ type: 'thinking', delta: item.text + '\n' }] : []
        case 'command_execution':
          return [{ type: 'tool-end', id: item.id, output: item.aggregated_output ?? '', isError: item.exit_code != null && item.exit_code !== 0 }]
        case 'mcp_tool_call': {
          const content = item.result?.content
          const text = Array.isArray(content) ? content.map((c: any) => c.text ?? JSON.stringify(c)).join('\n') : item.error?.message ?? ''
          return [{ type: 'tool-end', id: item.id, output: text, isError: item.status === 'failed' || !!item.error }]
        }
        case 'file_change':
          return [
            { type: 'tool-start', id: item.id, name: 'edit', input: { changes: item.changes } },
            { type: 'tool-end', id: item.id, output: (item.changes ?? []).map((c: any) => `${c.kind} ${c.path}`).join('\n'), isError: item.status === 'failed' }
          ]
        case 'web_search':
          return [{ type: 'tool-end', id: item.id, output: '' }]
        case 'error':
          return [{ type: 'error', message: item.message ?? 'Codex error' }]
        default:
          return []
      }
    case 'turn.completed':
      return [{ type: 'usage', inputTokens: ev.usage?.input_tokens ?? 0, outputTokens: ev.usage?.output_tokens ?? 0 }]
    case 'turn.failed':
      return [{ type: 'error', message: ev.error?.message ?? 'Codex turn failed' }]
    case 'error':
      return [{ type: 'error', message: ev.message ?? 'Codex error' }]
    default:
      return []
  }
}

/** The first turn carries the system prompt and history; a resumed thread already has them. */
export function codexPrompt(req: Pick<TurnRequest, 'system' | 'history' | 'prompt' | 'resumeId'>): string {
  if (req.resumeId) return req.prompt
  const history = req.history.length
    ? `\n\n# Conversation so far\n${req.history.map((h) => `${h.role === 'user' ? 'User' : 'You'}: ${h.text}`).join('\n\n')}`
    : ''
  return `${req.system}${history}\n\n# Message\n${req.prompt}`
}

/**
 * On Windows `codex` is a .cmd shim, which Node only runs through a shell, and a shell gets the
 * arguments joined by spaces as they are. Quote each one the way the Rust argv parser reads it.
 */
export function winQuote(arg: string): string {
  if (arg && !/[\s"^&|<>()%!]/.test(arg)) return arg
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

/** ChatGPT subscription agents: `codex exec --json`, on the user's own Codex login. */
export class CodexCliProvider implements ProviderAdapter {
  async *run(req: TurnRequest): AsyncIterable<AgentEvent> {
    const exe = req.executable || 'codex'
    const win = process.platform === 'win32'
    const args = codexArgs(req)
    const child = spawn(win ? winQuote(exe) : exe, win ? args.map(winQuote) : args, { cwd: req.cwd, shell: win, env: process.env })
    const onAbort = () => child.kill()
    req.signal.addEventListener('abort', onAbort, { once: true })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr = (stderr + d.toString()).slice(-4000)))
    const exited = new Promise<number>((resolve) => {
      child.on('error', (e) => {
        stderr += `\n${e.message}`
        resolve(-1)
      })
      child.on('close', (code) => resolve(code ?? 0))
    })
    child.stdin.end(codexPrompt(req))

    const lines = createInterface({ input: child.stdout })
    let wroteText = false
    let failed = false
    for await (const line of lines) {
      for (const ev of codexEvents(line)) {
        if (ev.type === 'text') {
          yield { type: 'text', delta: (wroteText ? '\n\n' : '') + ev.delta }
          wroteText = true
        } else {
          if (ev.type === 'error') failed = true
          yield ev
        }
      }
    }
    const code = await exited
    req.signal.removeEventListener('abort', onAbort)
    if (code !== 0 && !failed && !req.signal.aborted) {
      const hint = /not found|ENOENT|is not recognized/i.test(stderr) ? ' Is the Codex CLI installed (npm i -g @openai/codex) and logged in (codex login)?' : ''
      yield { type: 'error', message: `codex exited with ${code}.${hint}\n${stderr.trim()}` }
    }
  }
}
