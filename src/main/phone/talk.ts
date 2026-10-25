import type { WaitingItem } from '@shared/types'

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** "A, B or C." */
const either = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}`)

/** One waiting item, as said on the phone. */
export function spokenItem(w: WaitingItem): string {
  const who = w.chat
  const it = w.item
  if (it.kind === 'question') {
    const [q, ...more] = it.questions ?? []
    if (!q) return `${who} has a question.`
    const opts = q.options.map((o) => o.label).slice(0, 5)
    return `${who} asks: ${clip(q.question, 200)} The options are ${either(opts)}.${more.length ? ` And ${more.length} more question${more.length === 1 ? '' : 's'} after that.` : ''}`
  }
  if (it.hardStop) return `${who} wants to ${clip(it.title, 120)}, which needs your PIN.`
  if (it.watchdog) return `${who} was paused by the loop guard: ${clip(it.title, 160)}.`
  if (it.permission) return `${who} wants your OK to ${clip(it.title.replace(/^run: /, 'run '), 140)}.`
  return `${who} has a plan ready for you to approve.`
}

/** The first thing Tuesday says on a call. */
export function phoneGreeting(name: string, outbound: boolean, waiting: WaitingItem[], busy: number): string {
  const items = waiting.filter((w) => w.dir)
  if (outbound) {
    if (!items.length) return `Hi, it's ${name}. It's all answered now, nothing is waiting for you. Anything else?`
    const first = spokenItem(items[0])
    const ask = items[0].item.kind === 'question' ? 'What should I tell it?' : 'Should I approve it?'
    return items.length === 1 ? `Hi, it's ${name}. ${first} ${ask}` : `Hi, it's ${name}. ${items.length} things are waiting for you. First: ${first} ${ask}`
  }
  const parts = [busy ? `${busy} chat${busy === 1 ? ' is' : 's are'} working` : '', items.length ? `${items.length} thing${items.length === 1 ? ' is' : 's are'} waiting for you` : ''].filter(Boolean)
  return `Hi, ${name} here. ${parts.length ? `${parts.join(', and ')}.` : 'All quiet.'} What can I do?`
}

/** What Tuesday is told about a phone turn, ahead of the caller's words. */
export function phoneRule(waiting: WaitingItem[]): string {
  const items = waiting.filter((w) => w.dir).slice(0, 8)
  const list = items.map((w) => `- [${w.item.id}] ${w.project} / ${spokenItem(w)}${w.item.kind === 'approval' && !w.item.permission && w.item.planMd ? ` Plan: ${clip(w.item.planMd.replace(/\s+/g, ' '), 600)}` : ''}`)
  return [
    '[On the phone with the user. Answer in one to three short spoken sentences: no markdown, lists, code, ids, paths or links; name chats by name. One question at a time. Before you answer anything for them, read it back and wait for their yes.',
    'A hard stop (push, publish, deleting history) they want allowed: call answer as usual; they then enter their PIN on the keypad.',
    items.length ? `Waiting for them now:\n${list.join('\n')}]` : 'Nothing is waiting for them.]'
  ].join('\n')
}
