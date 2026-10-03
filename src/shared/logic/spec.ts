import { nodeById, portsOf, reachable, targetsOf, type Board, type LogicNode } from './model'
import { TARGETS } from './targets'

/**
 * The board as the agent reads it: an indented outline in which every box keeps its id, the order
 * is the order things happen in, and nothing is left to read off a picture. Deterministic, so the
 * same board always says the same thing and a changed one says exactly what changed.
 */

const KEYWORD: Record<LogicNode['kind'], string> = {
  event: 'WHEN',
  condition: 'IF',
  action: 'DO',
  wait: 'WAIT',
  repeat: 'REPEAT',
  value: '',
  note: ''
}

/** "On cast: the player presses the key", or whichever half is there. */
export function phrase(n: LogicNode): string {
  // a condition titled "If sneaking" reads "IF sneaking", not "IF If sneaking"
  const title = (n.kind === 'condition' ? n.title.replace(/^\s*if\b\s*/i, '') : n.title).trim()
  const text = n.text.trim()
  if (!text) return title || '(empty)'
  if (!title) return text
  // a title that the details already start with is not said twice
  return text.toLowerCase().startsWith(title.toLowerCase()) ? text : `${title}: ${text}`
}

/** One box as one line (its details' extra lines indented under it). */
export function line(n: LogicNode, indent: string): string[] {
  const words = phrase(n).split(/\r?\n/)
  const head = n.kind === 'value' ? `[${n.id}] ${n.title.trim()} = ${n.text.trim().split(/\r?\n/)[0] ?? ''}` : `[${n.id}] ${KEYWORD[n.kind]} ${words[0]}`
  const rest = n.kind === 'value' ? n.text.trim().split(/\r?\n/).slice(1) : words.slice(1)
  return [indent + head, ...rest.filter((l) => l.trim()).map((l) => `${indent}    ${l.trim()}`)]
}

export function spec(b: Board): string {
  const t = TARGETS[b.target]
  const out: string[] = [`Board "${b.name}" - ${t.label}, time in ${t.time}`]
  const values = b.nodes.filter((n) => n.kind === 'value').sort(byPlace)
  if (values.length) {
    out.push('', 'Values (boxes refer to them as {name})')
    for (const v of values) out.push(...line(v, '  '))
  }
  const printed = new Set<string>()
  const stack: string[] = []

  const walk = (n: LogicNode, indent: string) => {
    if (stack.includes(n.id)) return void out.push(`${indent}-> back to [${n.id}]`)
    if (printed.has(n.id)) return void out.push(`${indent}-> continue at [${n.id}]`)
    printed.add(n.id)
    stack.push(n.id)
    out.push(...line(n, indent))
    const ports = portsOf(n)
    if (n.kind === 'condition' || n.kind === 'repeat') {
      for (const port of ports) {
        const next = targetsOf(b, n.id, port)
        const label = n.kind === 'repeat' ? (port === 'each' ? 'each time:' : 'when done:') : `${port}:`
        out.push(`${indent}  ${label}${next.length ? '' : ' (nothing)'}`)
        sequence(next, `${indent}    `)
      }
    } else if (ports.length) {
      const next = targetsOf(b, n.id, ports[0])
      // an event's steps are its body; an action's next step follows it at the same depth
      sequence(next, n.kind === 'event' ? `${indent}  ` : indent)
    }
    stack.pop()
  }

  const sequence = (next: LogicNode[], indent: string) => {
    if (next.length <= 1) return next.forEach((x) => walk(x, indent))
    out.push(`${indent}then each of these, in this order:`)
    for (const x of next) walk(x, `${indent}  `)
  }

  for (const e of b.nodes.filter((n) => n.kind === 'event').sort(byPlace)) {
    out.push('')
    walk(e, '')
  }

  const reached = reachable(b)
  const loose = b.nodes.filter((n) => !reached.has(n.id) && n.kind !== 'value' && n.kind !== 'note').sort(byPlace)
  if (loose.length) {
    out.push('', 'Not linked to any event (not to be built yet)')
    for (const n of loose) out.push(...line(n, '  '))
  }
  const notes = b.nodes.filter((n) => n.kind === 'note' && phrase(n) !== '(empty)').sort(byPlace)
  if (notes.length) {
    out.push('', 'Notes from the designer')
    for (const n of notes) out.push(`  [${n.id}] ${phrase(n).replace(/\r?\n/g, ' ')}`)
  }
  return out.join('\n')
}

const byPlace = (p: LogicNode, q: LogicNode) => p.y - q.y || p.x - q.x

/** Where a box sits in the flow, said briefly: "after [C2] false". */
export function placeOf(b: Board, id: string): string {
  const into = b.links.filter((l) => l.to === id)
  if (!into.length) return ''
  return `after ${into
    .map((l) => {
      const from = nodeById(b, l.from)
      return from && portsOf(from).length > 1 ? `[${l.from}] ${l.port}` : `[${l.from}]`
    })
    .join(' and ')}`
}
