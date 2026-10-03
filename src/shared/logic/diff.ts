import { nodeById, type Board, type Link, type LogicNode } from './model'
import { line, phrase, placeOf } from './spec'

/**
 * What changed on a board since it was last built. Moving a box is not a change: only what it says
 * and how it is linked are.
 */
export interface BoardDiff {
  added: LogicNode[]
  changed: { before: LogicNode; after: LogicNode }[]
  removed: LogicNode[]
  linksAdded: Link[]
  linksRemoved: Link[]
}

const key = (l: Link) => `${l.from}|${l.port}|${l.to}`

const meaning = (n: LogicNode) => JSON.stringify([n.kind, n.title.trim(), n.text.trim(), n.cases ?? null])

export function boardDiff(built: Board, now: Board): BoardDiff {
  const before = new Map(built.nodes.map((n) => [n.id, n]))
  const after = new Map(now.nodes.map((n) => [n.id, n]))
  const bl = new Set(built.links.map(key))
  const al = new Set(now.links.map(key))
  return {
    added: now.nodes.filter((n) => !before.has(n.id)),
    changed: now.nodes.filter((n) => before.has(n.id) && meaning(before.get(n.id)!) !== meaning(n)).map((n) => ({ before: before.get(n.id)!, after: n })),
    removed: built.nodes.filter((n) => !after.has(n.id)),
    linksAdded: now.links.filter((l) => !bl.has(key(l))),
    linksRemoved: built.links.filter((l) => !al.has(key(l)))
  }
}

/** How many changes, counting a link between two boxes that are themselves new or gone as part of them. */
export function changeCount(d: BoardDiff): number {
  const boxes = new Set([...d.added, ...d.removed].map((n) => n.id))
  const loneLinks = [...d.linksAdded, ...d.linksRemoved].filter((l) => !boxes.has(l.from) && !boxes.has(l.to))
  return d.added.length + d.changed.length + d.removed.length + loneLinks.length
}

/** Boxes to mark as changed since the build: new, reworded, or relinked. */
export function changedIds(d: BoardDiff): Set<string> {
  const ids = new Set([...d.added, ...d.changed.map((c) => c.after)].map((n) => n.id))
  for (const l of [...d.linksAdded, ...d.linksRemoved]) ids.add(l.from)
  return ids
}

const linkText = (b: Board, l: Link) => {
  const from = nodeById(b, l.from)
  return `[${l.from}]${from && from.kind !== 'event' && from.kind !== 'action' && from.kind !== 'wait' ? ` ${l.port}` : ''} -> [${l.to}]`
}

/** The changes as the agent reads them. */
export function changeSpec(d: BoardDiff, built: Board, now: Board): string {
  const out: string[] = []
  if (d.added.length) {
    out.push('Added:')
    for (const n of d.added) {
      const [first, ...rest] = line(n, '  ')
      const at = placeOf(now, n.id)
      out.push(at ? `${first}   (${at})` : first, ...rest)
    }
  }
  if (d.changed.length) {
    out.push('Changed:')
    for (const c of d.changed) {
      out.push(...line(c.after, '  '))
      out.push(`      was: ${c.before.kind === 'value' ? `${c.before.title.trim()} = ${c.before.text.trim()}` : phrase(c.before)}`.replace(/\r?\n/g, ' '))
    }
  }
  if (d.removed.length) {
    out.push('Removed (take this behaviour out):')
    for (const n of d.removed) out.push(...line(n, '  '))
  }
  if (d.linksAdded.length) out.push(`Now linked: ${d.linksAdded.map((l) => linkText(now, l)).join(', ')}`)
  if (d.linksRemoved.length) out.push(`No longer linked: ${d.linksRemoved.map((l) => linkText(built, l)).join(', ')}`)
  return out.join('\n')
}
