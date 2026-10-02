import type { ToolCallView } from '@shared/types'
import type { HistoryItem } from '../providers/types'

export interface BriefInput {
  /** The message the cut turn was answering. */
  task: string
  history: HistoryItem[]
  /** Every tool call the turn made before it was cut. */
  tools: ToolCallView[]
  /** What the turn had written so far. */
  partial: string
  /** `git diff --stat` and the diff itself, if the project is a repository. */
  diffStat?: string
  diff?: string
  previous: string
  reason: string
}

const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)} ...`)

function brief(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * Everything a fallback model needs to carry on a task another model was cut off in the middle of:
 * the task, the conversation, what was already done (each tool call and what it returned), what has
 * changed on disk, and the last words written. The new model continues; it does not start over.
 */
export function buildBrief(b: BriefInput): string {
  const parts: string[] = []
  parts.push(
    `# You are continuing a task that was interrupted\n` +
      `${b.previous} stopped part-way through this task (${b.reason}). You are taking over from where it stopped. ` +
      `Do not start over and do not redo steps that are already done: check the record below, verify where needed, and continue. ` +
      `When the task is finished, finish exactly as the task asks (a report, a reply).`
  )
  parts.push(`## The task\n${cap(b.task, 12_000)}`)
  const hist = b.history.slice(-12)
  if (hist.length) parts.push(`## Conversation before this task\n${hist.map((h) => `${h.role === 'user' ? 'User' : 'Agent'}: ${cap(h.text, 1500)}`).join('\n\n')}`)
  const tools = b.tools.slice(-50)
  if (tools.length) {
    const lines = tools.map((t) => {
      const out = t.output ? cap(t.output.replace(/\s+/g, ' ').trim(), 300) : t.status === 'running' ? '(was running when it stopped - check whether it completed)' : ''
      return `- ${t.name.replace(/^mcp__multimine__/, '')}(${cap(brief(t.input), 220)})${t.status === 'error' ? ' FAILED' : ''}${out ? ` -> ${out}` : ''}`
    })
    parts.push(`## Already done (${b.tools.length} tool call${b.tools.length === 1 ? '' : 's'}${b.tools.length > tools.length ? `, the last ${tools.length} shown` : ''})\n${lines.join('\n')}`)
  } else parts.push('## Already done\nNothing yet: no tool had been called.')
  if (b.diffStat) parts.push(`## Files changed so far\n\`\`\`\n${cap(b.diffStat, 4000)}\n\`\`\``)
  if (b.diff) parts.push(`## The changes\n\`\`\`diff\n${cap(b.diff, 15_000)}\n\`\`\``)
  if (b.partial.trim()) parts.push(`## The last thing it wrote\n${cap(b.partial.trim().split('\n').slice(-30).join('\n'), 3000)}`)
  parts.push('Continue now.')
  return parts.join('\n\n')
}
