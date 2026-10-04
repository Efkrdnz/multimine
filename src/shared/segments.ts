import type { ChatMessage } from './types'

/**
 * A reply as it happened: thinking, text and tool calls in the order they came, so the chat can show
 * the work the way it was done instead of every tool first and every word after. `text`, `thinking`
 * and `tools` are kept alongside for search, history and older messages.
 */

/** Adds streamed text or thinking to a reply, continuing the last segment when it is the same kind. */
export function appendStream(m: ChatMessage, kind: 'text' | 'thinking', delta: string, now = Date.now()): void {
  const segs = (m.segments ??= [])
  const last = segs.at(-1)
  if (last && last.kind === kind) last.text = (last.text ?? '') + delta
  else {
    if (last && last.end === undefined) last.end = now
    segs.push({ kind, text: delta, at: now })
  }
  if (kind === 'text') m.text += m.text && last?.kind !== 'text' && !m.text.endsWith('\n') ? `\n\n${delta}` : delta
  else m.thinking = (m.thinking ?? '') + (m.thinking && last?.kind !== 'thinking' ? `\n\n${delta}` : delta)
}

/** A tool call starts: it takes its place in the order. */
export function appendTool(m: ChatMessage, toolId: string, now = Date.now()): void {
  const segs = (m.segments ??= [])
  const last = segs.at(-1)
  if (last && last.end === undefined) last.end = now
  segs.push({ kind: 'tool', toolId, at: now })
}

/** A note from Multimine itself (a switch of provider, a loop-guard pause), shown where it happened. */
export function appendNote(m: ChatMessage, note: string, now = Date.now()): void {
  appendStream(m, 'text', `${m.text && !m.text.endsWith('\n') ? '\n\n' : ''}${note}\n\n`, now)
}

/** The reply closes: whatever was still open ends now. */
export function closeSegments(m: ChatMessage, now = Date.now()): void {
  const last = m.segments?.at(-1)
  if (last && last.end === undefined) last.end = now
}

export type Block =
  | { kind: 'thinking'; text: string; at: number; ms: number; open: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'work'; toolIds: string[] }

/** Segments as the chat draws them: runs of tool calls become one block of work. */
export function blocks(m: ChatMessage, now = Date.now()): Block[] {
  const out: Block[] = []
  for (const s of m.segments ?? []) {
    if (s.kind === 'tool') {
      const last = out.at(-1)
      if (last?.kind === 'work') last.toolIds.push(s.toolId!)
      else out.push({ kind: 'work', toolIds: [s.toolId!] })
    } else if (s.kind === 'thinking') {
      if (!s.text?.trim()) continue
      out.push({ kind: 'thinking', text: s.text, at: s.at, ms: (s.end ?? now) - s.at, open: s.end === undefined })
    } else if (s.text?.trim()) out.push({ kind: 'text', text: s.text })
  }
  return out
}
