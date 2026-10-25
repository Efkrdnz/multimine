import type { WaitingItem } from '@shared/types'
import type { Buttons } from './api'

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A waiting item as a Telegram message: what it is, and buttons to answer it in one tap where that is enough. */
export function itemMessage(w: WaitingItem): { text: string; buttons?: Buttons } {
  const it = w.item
  const where = `${w.project} · ${w.chat}`
  if (it.kind === 'question') {
    const qs = it.questions ?? []
    if (qs.length === 1 && !qs[0].multiSelect) {
      const q = qs[0]
      const opts = q.options.slice(0, 8)
      return {
        text: `❓ ${where}\n\n${q.question}${opts.some((o) => o.description) ? `\n\n${opts.map((o) => `• ${o.label}${o.description ? `: ${clip(o.description, 140)}` : ''}`).join('\n')}` : ''}\n\nTap an answer, or reply in your own words.`,
        buttons: opts.map((o, i) => [{ text: clip(o.label, 60), data: `o:${it.id}:${i}` }])
      }
    }
    const list = qs.map((q, i) => `${i + 1}. ${q.question}\n   ${q.options.map((o) => o.label).join(' / ')}${q.multiSelect ? ' (one or more)' : ''}`)
    return { text: `❓ ${where} has ${qs.length} questions:\n\n${list.join('\n')}\n\nReply with your answers, in your own words.` }
  }
  const detail = clip((it.planMd ?? '').replace(/```/g, '').trim(), it.permission ? 600 : 3000)
  if (it.hardStop) return { text: `⛔ ${where} wants to: ${it.title}\n\n${detail}\n\nThis needs your PIN.`, buttons: [[{ text: '🔑 Allow with PIN', data: `y:${it.id}` }, { text: '✋ Deny', data: `n:${it.id}` }]] }
  if (it.watchdog) return { text: `⏸ ${where} was paused by the loop guard: ${it.title}\n\n${detail}\n\nContinue, stop, or reply with what it should do instead.`, buttons: [[{ text: '▶ Continue', data: `y:${it.id}` }, { text: '⏹ Stop', data: `n:${it.id}` }]] }
  if (it.permission) return { text: `🔐 ${where} wants to: ${it.title}\n\n${detail}`, buttons: [[{ text: '✅ Allow', data: `y:${it.id}` }, { text: '✋ Deny', data: `n:${it.id}` }]] }
  return { text: `📋 ${where} has a plan for you to approve:\n\n${detail}\n\nApprove it, or reply with what to change.`, buttons: [[{ text: '✅ Approve', data: `y:${it.id}` }, { text: '✋ Turn down', data: `n:${it.id}` }]] }
}

/** What Tuesday is told about a Telegram turn, ahead of the user's words. */
export function telegramRule(waiting: WaitingItem[], voice: boolean): string {
  const items = waiting.filter((w) => w.dir).slice(0, 8)
  const list = items.map((w) => `- [${w.item.id}] ${w.project} / ${w.chat}: ${w.item.kind === 'question' ? (w.item.questions ?? []).map((q) => `${q.question} (${q.options.map((o) => o.label).join(' / ')})`).join('; ') : w.item.title}`)
  return [
    `[On Telegram with the user, on their phone${voice ? ' (they sent a voice note; this is what it said)' : ''}. Keep replies short and in plain text: no markdown headings or tables. Before you answer anything for them, read it back and wait for their yes.`,
    'A hard stop (push, publish, deleting history) they want allowed: call answer as usual; they then send their PIN, which never reaches you.',
    items.length ? `Waiting for them now:\n${list.join('\n')}]` : 'Nothing is waiting for them.]'
  ].join('\n')
}
