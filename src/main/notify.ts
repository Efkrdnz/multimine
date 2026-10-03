import type { InboxItem, MainEvent, NotificationSettings } from '@shared/types'

/**
 * Desktop notifications for the moments an agent is waiting on the user: a question, a plan to
 * approve, a permission, a paid fallback, the loop guard. Everything that needs the user already
 * becomes a pending inbox item, so this watches the inbox events main forwards to the window and
 * notifies once per new item. It knows nothing about Electron: main hands it `show` and `isFocused`.
 */

export const DEFAULT_NOTIFICATIONS: NotificationSettings = { enabled: true, whenFocused: false, onFinish: false }

export interface Note {
  title: string
  body: string
  /** What a click should bring up. */
  itemId?: string
  agentId?: string
}

export interface NotifierDeps {
  show: (n: Note) => void
  isFocused: () => boolean
  settings: () => NotificationSettings
  agentName: (id: string) => string
  /** How long to gather items that arrive together into one notification (0: at once). */
  groupMs?: number
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The words for one item: who needs what, and the item's own title. */
export function messageFor(item: InboxItem, agentName: string): Note {
  const title = item.watchdog
    ? `${agentName} is paused`
    : item.kind === 'question'
      ? `${agentName} has a question`
      : item.permission
        ? `${agentName} needs permission`
        : `${agentName} needs your approval`
  const what = item.watchdog ? `${agentName} ${item.title}` : item.kind === 'question' ? (item.questions?.[0]?.question ?? item.title) : item.title
  return { title, body: clip(what.replace(/\s+/g, ' ').trim(), 120), itemId: item.id, agentId: item.askedBy }
}

export class Notifier {
  private seen = new Set<string>()
  private queue: InboxItem[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private busy = new Map<string, boolean>()

  constructor(private readonly d: NotifierDeps) {}

  /** Every event main sends the window passes through here too. */
  handle(e: MainEvent): void {
    if (e.type === 'inbox') this.inbox(e.items)
    else if (e.type === 'status') this.status(e.agentId, e.status)
  }

  private allowed(): boolean {
    const s = this.d.settings()
    return s.enabled && (s.whenFocused || !this.d.isFocused())
  }

  private inbox(items: InboxItem[]): void {
    // only items still waiting count: a reload expires what was pending, automation settles at once
    for (const it of items) {
      if (this.seen.has(it.id)) continue
      this.seen.add(it.id)
      if (it.status === 'pending') this.queue.push(it)
    }
    if (!this.queue.length) return
    const wait = this.d.groupMs ?? 1500
    if (wait <= 0) this.flush()
    else this.timer ??= setTimeout(() => this.flush(), wait)
  }

  private flush(): void {
    this.timer = null
    const items = this.queue.splice(0)
    if (!items.length || !this.allowed()) return
    const first = messageFor(items[0], this.d.agentName(items[0].askedBy))
    if (items.length === 1) return this.d.show(first)
    const names = [...new Set(items.map((i) => this.d.agentName(i.askedBy)))]
    this.d.show({
      title: names.length === 1 ? `${names[0]} needs you (${items.length})` : `${names[0]} and ${names.length - 1} other${names.length > 2 ? 's' : ''} need you`,
      body: first.body,
      itemId: first.itemId,
      agentId: first.agentId
    })
  }

  /** Mastermind going from busy to idle: the task it was given is done (only when asked for). */
  private status(agentId: string, status: string): void {
    const wasBusy = this.busy.get(agentId) ?? false
    const isBusy = status === 'thinking' || status === 'working' || status === 'waiting'
    this.busy.set(agentId, isBusy)
    if (agentId !== 'mastermind' || !wasBusy || isBusy) return
    if (!this.d.settings().onFinish || !this.allowed()) return
    this.d.show({ title: `${this.d.agentName(agentId)} ${status === 'error' ? 'stopped with an error' : 'finished'}`, body: 'Open Multimine to see the reply.', agentId })
  }
}
