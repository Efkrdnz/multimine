import { newId } from '@shared/ids'
import type { InboxItem, Question } from '@shared/types'

/**
 * Questions and approvals waiting on the user. Each pending item holds a resolver: the agent that
 * asked is blocked on it until the user (or automation) answers.
 */
export class Inbox {
  private waiters = new Map<string, (item: InboxItem) => void>()

  constructor(
    public items: InboxItem[],
    private readonly changed: (items: InboxItem[]) => void
  ) {
    // anything still pending from a previous run has nobody waiting on it any more
    for (const it of this.items) if (it.status === 'pending') Object.assign(it, { status: 'auto', note: 'Expired: the app restarted before it was answered.' })
  }

  pending(): InboxItem[] {
    return this.items.filter((i) => i.status === 'pending')
  }

  get(id: string): InboxItem | undefined {
    return this.items.find((i) => i.id === id)
  }

  private add(item: InboxItem): Promise<InboxItem> {
    this.items = [...this.items, item]
    this.changed(this.items)
    return new Promise((resolve) => this.waiters.set(item.id, resolve))
  }

  ask(askedBy: string, title: string, questions: Question[]): Promise<InboxItem> {
    return this.add({ id: newId('q'), ts: Date.now(), kind: 'question', askedBy, title, questions, status: 'pending' })
  }

  approval(askedBy: string, title: string, planMd: string, permission = false, alwaysLabel?: string): Promise<InboxItem> {
    return this.add({ id: newId('a'), ts: Date.now(), kind: 'approval', askedBy, title, planMd, status: 'pending', permission, alwaysLabel })
  }

  /** The loop guard pausing an agent: shown as a balloon with continue, tell it and stop. */
  watchdog(askedBy: string, title: string, detailMd: string): Promise<InboxItem> {
    return this.add({ id: newId('w'), ts: Date.now(), kind: 'approval', askedBy, title, planMd: detailMd, status: 'pending', permission: true, watchdog: true })
  }

  /** Records an item that was settled on the spot (automation), for the log. */
  record(item: Omit<InboxItem, 'id' | 'ts'>): InboxItem {
    const full: InboxItem = { ...item, id: newId(item.kind === 'question' ? 'q' : 'a'), ts: Date.now() }
    this.items = [...this.items, full]
    this.changed(this.items)
    return full
  }

  private settle(id: string, patch: Partial<InboxItem>): InboxItem | null {
    const item = this.get(id)
    if (!item || item.status !== 'pending') return null
    Object.assign(item, patch)
    this.items = [...this.items]
    this.changed(this.items)
    const w = this.waiters.get(id)
    this.waiters.delete(id)
    w?.(item)
    return item
  }

  answer(id: string, answers: Record<string, string>, note?: string): InboxItem | null {
    return this.settle(id, { status: 'answered', answers, note })
  }

  decide(id: string, approved: boolean, note?: string, always = false): InboxItem | null {
    return this.settle(id, { status: 'answered', approved, note, always: approved && always })
  }

  /** Settles every pending item (session switch, shutdown): questions empty, approvals refused. */
  cancelAll(reason: string): void {
    for (const it of this.pending()) this.settle(it.id, { status: 'auto', approved: false, answers: {}, note: reason })
  }
}

/** Answers as the model reads them. */
export function formatAnswers(item: InboxItem): string {
  const lines = Object.entries(item.answers ?? {}).map(([q, a]) => `- ${q}\n  -> ${a || '(no answer)'}`)
  const who = item.status === 'auto' ? 'Mastermind (automation mode) answered' : 'The user answered'
  return `${who}:\n${lines.join('\n') || '(nothing)'}${item.note ? `\nNote: ${item.note}` : ''}`
}

/** Automation's fallback: the first (recommended) option of each question. */
export function recommendedAnswers(questions: Question[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const q of questions) out[q.question] = q.options[0]?.label ?? ''
  return out
}
