import { TARGET_IDS, type TargetId } from './targets'

/**
 * A Logic Board: a mechanic drawn as boxes linked by arrows, every box holding plain words. The
 * arrows are the order things happen in; Value boxes are named numbers or rules the other boxes
 * refer to as {name}. An agent reads the board (as the outline in spec.ts) and writes the code, so
 * the thinking about *what* happens is done here and the agent only decides *how*.
 * Everything in this file is pure: the editor, the tests and the exporter share one set of rules.
 */

export const KINDS = ['event', 'condition', 'action', 'wait', 'repeat', 'value', 'note'] as const
export type Kind = (typeof KINDS)[number]

export const KIND_LABEL: Record<Kind, string> = {
  event: 'Event',
  condition: 'Condition',
  action: 'Action',
  wait: 'Wait',
  repeat: 'Repeat',
  value: 'Value',
  note: 'Note'
}

/** What each kind is for, said to the user in the palette. */
export const KIND_HELP: Record<Kind, string> = {
  event: 'Where it starts: a key press, a hit, a timer',
  condition: 'If / else, or several named cases',
  action: 'Something that happens',
  wait: 'A pause before the next box',
  repeat: 'Do the next boxes several times',
  value: 'A named number or rule, used as {name}',
  note: 'A comment for people; never built'
}

const PREFIX: Record<Kind, string> = { event: 'E', condition: 'C', action: 'A', wait: 'W', repeat: 'R', value: 'V', note: 'N' }

export interface LogicNode {
  /** Short and stable: E1, C2, A3... Agents and the code map refer to boxes by it. */
  id: string
  kind: Kind
  x: number
  y: number
  /** A short label ("On cast"). For a Value, its name. */
  title: string
  /** The details, in plain words. For a Value, its definition. */
  text: string
  /** A condition's branches; true / false when unset. */
  cases?: string[]
}

export interface Link {
  from: string
  port: string
  to: string
}

export interface Board {
  version: 1
  name: string
  target: TargetId
  nodes: LogicNode[]
  links: Link[]
  /** The number the next box's id gets. Never reused, so a deleted box's id never comes back. */
  nextId: number
  /** Its folder under .multimine/boards, fixed when it is made so a rename moves nothing. */
  folder?: string
}

export const boardFolder = (b: Board): string => b.folder ?? slug(b.name)

export const NODE_W = 240

export function newBoard(name: string, target: TargetId = 'generic'): Board {
  return { version: 1, name: name.trim() || 'Untitled board', target, nodes: [], links: [], nextId: 1 }
}

/** The outputs a box has, in the order they are drawn. */
export function portsOf(n: LogicNode): string[] {
  switch (n.kind) {
    case 'condition':
      return n.cases?.length ? n.cases : ['true', 'false']
    case 'repeat':
      return ['each', 'done']
    case 'value':
    case 'note':
      return []
    default:
      return ['then']
  }
}

export const hasInput = (k: Kind): boolean => k !== 'event' && k !== 'value' && k !== 'note'

/** A Value's name as the other boxes write it: lowercase, words joined by underscores. */
export function valueName(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** The {name}s a text refers to, in order, each once. */
export function valuesIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\{([^{}\n]+)\}/g)) {
    const name = valueName(m[1])
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

export function nodeById(b: Board, id: string): LogicNode | undefined {
  return b.nodes.find((n) => n.id === id)
}

export function addNode(b: Board, kind: Kind, x: number, y: number, title = '', text = ''): { board: Board; id: string } {
  const id = `${PREFIX[kind]}${b.nextId}`
  const node: LogicNode = { id, kind, x: Math.round(x), y: Math.round(y), title, text }
  return { board: { ...b, nodes: [...b.nodes, node], nextId: b.nextId + 1 }, id }
}

export function updateNode(b: Board, id: string, patch: Partial<Omit<LogicNode, 'id' | 'kind'>>): Board {
  return { ...b, nodes: b.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }
}

export function moveNodes(b: Board, ids: readonly string[], dx: number, dy: number): Board {
  const set = new Set(ids)
  return { ...b, nodes: b.nodes.map((n) => (set.has(n.id) ? { ...n, x: Math.round(n.x + dx), y: Math.round(n.y + dy) } : n)) }
}

/** A condition's branches renamed, added or dropped; links from a dropped branch go with it. */
export function setCases(b: Board, id: string, cases: string[]): Board {
  const clean = [...new Set(cases.map((c) => c.trim()).filter(Boolean))]
  const keep = clean.length >= 2 ? clean : ['true', 'false']
  const same = keep.length === 2 && keep[0] === 'true' && keep[1] === 'false'
  return {
    ...b,
    nodes: b.nodes.map((n) => (n.id === id ? { ...n, cases: same ? undefined : keep } : n)),
    links: b.links.filter((l) => l.from !== id || keep.includes(l.port))
  }
}

export type ConnectResult = { board: Board; error?: undefined } | { board?: undefined; error: string }

/** A link from one box's output to another box. Refused, with the reason, when it cannot mean anything. */
export function connect(b: Board, from: string, port: string, to: string): ConnectResult {
  const a = nodeById(b, from)
  const z = nodeById(b, to)
  if (!a || !z) return { error: 'That box is gone.' }
  if (from === to) return { error: 'A box cannot lead to itself.' }
  if (!portsOf(a).includes(port)) return { error: `${KIND_LABEL[a.kind]} boxes have no "${port}" output.` }
  if (!hasInput(z.kind)) return { error: z.kind === 'event' ? 'An Event is where things start: nothing leads into it.' : `${KIND_LABEL[z.kind]} boxes are not steps; refer to a value as {name} instead.` }
  if (b.links.some((l) => l.from === from && l.port === port && l.to === to)) return { error: 'They are already linked.' }
  return { board: { ...b, links: [...b.links, { from, port, to }] } }
}

export function disconnect(b: Board, link: Link): Board {
  return { ...b, links: b.links.filter((l) => !(l.from === link.from && l.port === link.port && l.to === link.to)) }
}

export function removeNodes(b: Board, ids: readonly string[]): Board {
  const set = new Set(ids)
  return { ...b, nodes: b.nodes.filter((n) => !set.has(n.id)), links: b.links.filter((l) => !set.has(l.from) && !set.has(l.to)) }
}

/** What a copy holds: some boxes and the links among them. */
export interface Fragment {
  nodes: LogicNode[]
  links: Link[]
}

export function copyFragment(b: Board, ids: readonly string[]): Fragment {
  const set = new Set(ids)
  return { nodes: b.nodes.filter((n) => set.has(n.id)).map((n) => ({ ...n })), links: b.links.filter((l) => set.has(l.from) && set.has(l.to)).map((l) => ({ ...l })) }
}

/** A fragment placed on a board under new ids, offset by (dx, dy). Returns the new ids. */
export function pasteFragment(b: Board, f: Fragment, dx: number, dy: number): { board: Board; ids: string[] } {
  let board = b
  const ids = new Map<string, string>()
  for (const n of f.nodes) {
    const r = addNode(board, n.kind, n.x + dx, n.y + dy, n.title, n.text)
    board = n.cases ? updateNode(r.board, r.id, { cases: [...n.cases] }) : r.board
    ids.set(n.id, r.id)
  }
  for (const l of f.links) {
    const from = ids.get(l.from)
    const to = ids.get(l.to)
    if (from && to) board = { ...board, links: [...board.links, { from, port: l.port, to }] }
  }
  return { board, ids: [...ids.values()] }
}

export function duplicate(b: Board, ids: readonly string[]): { board: Board; ids: string[] } {
  return pasteFragment(b, copyFragment(b, ids), 30, 30)
}

/** Where an output leads, in the order the boxes run: top to bottom, then left to right. */
export function targetsOf(b: Board, from: string, port: string): LogicNode[] {
  return b.links
    .filter((l) => l.from === from && l.port === port)
    .map((l) => nodeById(b, l.to))
    .filter((n): n is LogicNode => !!n)
    .sort((p, q) => p.y - q.y || p.x - q.x)
}

/** The boxes some event leads to (events included). */
export function reachable(b: Board): Set<string> {
  const seen = new Set<string>()
  const queue = b.nodes.filter((n) => n.kind === 'event').map((n) => n.id)
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const l of b.links) if (l.from === id && !seen.has(l.to)) queue.push(l.to)
  }
  return seen
}

export interface Issue {
  /** The box it is about; none for the board as a whole. */
  nodeId?: string
  level: 'error' | 'warning'
  text: string
}

/** Everything that would leave the agent guessing, each tied to the box it is about. */
export function validate(b: Board): Issue[] {
  const issues: Issue[] = []
  if (!b.nodes.some((n) => n.kind === 'event')) issues.push({ level: 'error', text: 'Add an Event box: nothing starts this mechanic.' })

  const values = b.nodes.filter((n) => n.kind === 'value')
  const names = new Map<string, string[]>()
  for (const v of values) {
    const name = valueName(v.title)
    if (!name) issues.push({ nodeId: v.id, level: 'error', text: 'Give this value a name.' })
    else names.set(name, [...(names.get(name) ?? []), v.id])
  }
  for (const [name, ids] of names) if (ids.length > 1) for (const id of ids.slice(1)) issues.push({ nodeId: id, level: 'error', text: `Another value is already called {${name}}.` })

  const used = new Set<string>()
  const reached = reachable(b)
  for (const n of b.nodes) {
    if (n.kind === 'note') continue
    const words = `${n.title} ${n.text}`
    for (const name of valuesIn(words)) {
      used.add(name)
      if (!names.has(name)) issues.push({ nodeId: n.id, level: 'error', text: `{${name}} is not a value on this board.` })
    }
    if (n.kind === 'value') {
      if (valueName(n.title) && !n.text.trim()) issues.push({ nodeId: n.id, level: 'warning', text: 'Say what this value is.' })
      continue
    }
    if (!n.title.trim() && !n.text.trim()) issues.push({ nodeId: n.id, level: 'warning', text: 'Say what this box does.' })
    if (!reached.has(n.id)) issues.push({ nodeId: n.id, level: 'warning', text: 'Nothing leads here: link it from an event or another box.' })
  }
  for (const v of values) {
    const name = valueName(v.title)
    if (name && !used.has(name)) issues.push({ nodeId: v.id, level: 'warning', text: `No box uses {${name}}.` })
  }
  for (const id of instantLoops(b)) issues.push({ nodeId: id, level: 'error', text: 'This loops forever in one moment: put a Wait or a Repeat in the loop.' })
  return issues
}

/** Boxes where a loop with no Wait or Repeat in it comes back round. */
function instantLoops(b: Board): string[] {
  const out = new Set<string>()
  const state = new Map<string, 'open' | 'done'>()
  const stack: string[] = []
  const visit = (id: string) => {
    state.set(id, 'open')
    stack.push(id)
    for (const l of b.links.filter((x) => x.from === id)) {
      const s = state.get(l.to)
      if (s === 'open') {
        const loop = stack.slice(stack.indexOf(l.to))
        if (!loop.some((x) => ['wait', 'repeat'].includes(nodeById(b, x)?.kind ?? ''))) out.add(l.to)
      } else if (!s) visit(l.to)
    }
    stack.pop()
    state.set(id, 'done')
  }
  for (const n of b.nodes) if (!state.has(n.id)) visit(n.id)
  return [...out]
}

/** A board read from disk, repaired rather than trusted: unknown kinds, bad links and ids are dropped. */
export function parseBoard(text: string): Board | null {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) return null
  const nodes: LogicNode[] = []
  const ids = new Set<string>()
  let max = 0
  for (const n of raw.nodes) {
    if (!n || !KINDS.includes(n.kind) || typeof n.id !== 'string' || ids.has(n.id)) continue
    ids.add(n.id)
    max = Math.max(max, Number(/\d+$/.exec(n.id)?.[0] ?? 0))
    nodes.push({
      id: n.id,
      kind: n.kind,
      x: Number(n.x) || 0,
      y: Number(n.y) || 0,
      title: String(n.title ?? ''),
      text: String(n.text ?? ''),
      ...(Array.isArray(n.cases) && n.kind === 'condition' && n.cases.length >= 2 ? { cases: n.cases.map(String) } : {})
    })
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const links: Link[] = []
  for (const l of Array.isArray(raw.links) ? raw.links : []) {
    const a = byId.get(l?.from)
    const z = byId.get(l?.to)
    if (!a || !z || a === z || !portsOf(a).includes(l.port) || !hasInput(z.kind)) continue
    if (links.some((x) => x.from === a.id && x.port === l.port && x.to === z.id)) continue
    links.push({ from: a.id, port: String(l.port), to: z.id })
  }
  return {
    version: 1,
    name: String(raw.name ?? 'Untitled board'),
    target: TARGET_IDS.includes(raw.target) ? raw.target : 'generic',
    nodes,
    links,
    nextId: Math.max(Number(raw.nextId) || 1, max + 1),
    ...(typeof raw.folder === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(raw.folder) ? { folder: raw.folder } : {})
  }
}

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'board'
  )
}

/** The code map an agent writes after a build: box id -> where it is implemented. */
export interface CodeRef {
  file: string
  line?: number
  note?: string
}
export type CodeMap = Record<string, CodeRef[]>

export function parseCodeMap(text: string): CodeMap {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch {
    return {}
  }
  const out: CodeMap = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [id, refs] of Object.entries(raw)) {
    const list = (Array.isArray(refs) ? refs : [refs])
      .map((r: any) => (typeof r === 'string' ? parseRef(r) : r && typeof r.file === 'string' ? { file: r.file, line: Number(r.line) || undefined, note: r.note ? String(r.note) : undefined } : null))
      .filter((r): r is CodeRef => !!r && !!r.file)
    if (list.length) out[id] = list
  }
  return out
}

/** "src/A.java:42" as a reference. */
function parseRef(s: string): CodeRef | null {
  const m = /^(.+?)(?::(\d+))?$/.exec(s.trim())
  return m ? { file: m[1], line: m[2] ? Number(m[2]) : undefined } : null
}
