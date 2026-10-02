import { PRESETS, PRESET_IDS, starter, type PresetId } from './presets'

/**
 * A UI sketch: a flat list of typed boxes in absolute canvas units. A box's parent is the container
 * it was dropped into; moving a container moves everything inside it. The list order is the z-order
 * among siblings (later is on top). Everything here is pure, so the editor, the exporter and the
 * tests share one set of rules.
 */
export const ELEMENT_TYPES = ['window', 'panel', 'group', 'button', 'label', 'textfield', 'slot', 'slotgrid', 'image', 'list', 'slider', 'checkbox', 'progress', 'tooltip'] as const
export type ElementType = (typeof ELEMENT_TYPES)[number]

export const CONTAINERS: ReadonlySet<ElementType> = new Set(['window', 'panel', 'group', 'list'])

export const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'] as const
export type Anchor = (typeof ANCHORS)[number]

export const STATES = ['hover', 'pressed', 'disabled', 'focused', 'selected'] as const

export const TYPE_LABEL: Record<ElementType, string> = {
  window: 'Window',
  panel: 'Panel',
  group: 'Layer',
  button: 'Button',
  label: 'Label',
  textfield: 'Text field',
  slot: 'Slot',
  slotgrid: 'Slot grid',
  image: 'Image',
  list: 'List',
  slider: 'Slider',
  checkbox: 'Checkbox',
  progress: 'Progress',
  tooltip: 'Tooltip'
}

export interface SketchElement {
  id: string
  type: ElementType
  name: string
  x: number
  y: number
  w: number
  h: number
  parent: string | null
  text?: string
  anchor: Anchor
  states: string[]
  notes: string
  /** Slot grid columns and rows. */
  cols?: number
  rows?: number
  /** Slider and progress fill, 0..1. */
  value?: number
  hidden?: boolean
  locked?: boolean
}

export interface Sketch {
  schema: 1
  name: string
  preset: PresetId
  canvas: { w: number; h: number }
  elements: SketchElement[]
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

let counter = 0
export function newElementId(): string {
  counter = (counter + 1) % 1e6
  return `e${Date.now().toString(36)}${counter.toString(36)}`
}

const HAS_TEXT: ReadonlySet<ElementType> = new Set(['window', 'button', 'label', 'textfield', 'checkbox', 'tooltip'])

function fill(d: Partial<SketchElement> & Pick<SketchElement, 'type' | 'x' | 'y' | 'w' | 'h'>, parent: string | null): SketchElement {
  const el: SketchElement = {
    id: d.id ?? newElementId(),
    type: d.type,
    name: d.name ?? TYPE_LABEL[d.type],
    x: d.x,
    y: d.y,
    w: Math.max(1, d.w),
    h: Math.max(1, d.h),
    parent,
    anchor: d.anchor ?? 'top-left',
    states: d.states ?? [],
    notes: d.notes ?? ''
  }
  if (d.text !== undefined) el.text = d.text
  else if (HAS_TEXT.has(d.type)) el.text = d.type === 'textfield' || d.type === 'window' ? '' : d.type === 'checkbox' ? 'Option' : TYPE_LABEL[d.type]
  if (d.type === 'slotgrid') {
    el.cols = d.cols ?? 9
    el.rows = d.rows ?? 3
  }
  if (d.type === 'slider' || d.type === 'progress') el.value = d.value ?? 0.5
  if (d.hidden) el.hidden = true
  if (d.locked) el.locked = true
  return el
}

/** Sketch names become folder names: lower case, dashes, nothing that could leave the folder. */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'sketch'
  )
}

export function newSketch(name: string, preset: PresetId): Sketch {
  let sk: Sketch = { schema: 1, name, preset, canvas: { ...PRESETS[preset].canvas }, elements: [] }
  for (const d of starter(preset)) sk = add(sk, d).sketch
  return sk
}

export const byId = (sk: Sketch, id: string): SketchElement | undefined => sk.elements.find((e) => e.id === id)

export function children(sk: Sketch, id: string | null): SketchElement[] {
  return sk.elements.filter((e) => e.parent === id)
}

/** Every element inside `id`, at any depth. */
export function descendants(sk: Sketch, id: string): SketchElement[] {
  const out: SketchElement[] = []
  const walk = (p: string) => {
    for (const c of sk.elements) if (c.parent === p) (out.push(c), walk(c.id))
  }
  walk(id)
  return out
}

const contains = (o: Rect, x: number, y: number) => x >= o.x && y >= o.y && x <= o.x + o.w && y <= o.y + o.h

/** The innermost visible container under a point, skipping `exclude` (an element and everything inside it). */
export function containerAt(sk: Sketch, x: number, y: number, exclude: ReadonlySet<string> = new Set()): SketchElement | null {
  let best: SketchElement | null = null
  let bestDepth = -1
  for (const e of sk.elements) {
    if (!CONTAINERS.has(e.type) || e.hidden || exclude.has(e.id) || !contains(e, x, y)) continue
    const d = depth(sk, e)
    // deeper wins; at equal depth, the later (on top) wins
    if (d >= bestDepth) (best = e), (bestDepth = d)
  }
  return best
}

export function depth(sk: Sketch, e: SketchElement): number {
  let d = 0
  for (let p = e.parent; p; p = byId(sk, p)?.parent ?? null) if (++d > 64) break
  return d
}

/** Adds an element; unless a parent is given, it goes into whatever container is under its centre. */
export function add(sk: Sketch, d: Partial<SketchElement> & Pick<SketchElement, 'type' | 'x' | 'y' | 'w' | 'h'>, parent?: string | null): { sketch: Sketch; id: string } {
  const p = parent !== undefined ? parent : (containerAt(sk, d.x + d.w / 2, d.y + d.h / 2)?.id ?? null)
  const el = fill(d, p)
  return { sketch: { ...sk, elements: [...sk.elements, el] }, id: el.id }
}

/** Changes an element's own fields. A position change carries its contents along. */
export function update(sk: Sketch, id: string, patch: Partial<Omit<SketchElement, 'id' | 'parent'>>): Sketch {
  const e = byId(sk, id)
  if (!e) return sk
  const dx = patch.x !== undefined ? patch.x - e.x : 0
  const dy = patch.y !== undefined ? patch.y - e.y : 0
  const inside = dx || dy ? new Set(descendants(sk, id).map((c) => c.id)) : new Set<string>()
  return {
    ...sk,
    elements: sk.elements.map((x) => {
      if (x.id === id) {
        const next = { ...x, ...patch }
        next.w = Math.max(1, next.w)
        next.h = Math.max(1, next.h)
        return next
      }
      return inside.has(x.id) ? { ...x, x: x.x + dx, y: x.y + dy } : x
    })
  }
}

/** The selection with anything already inside another selected element left out (it moves with it). */
export function roots(sk: Sketch, ids: readonly string[]): string[] {
  const set = new Set(ids)
  return ids.filter((id) => {
    for (let p = byId(sk, id)?.parent ?? null; p; p = byId(sk, p)?.parent ?? null) if (set.has(p)) return false
    return true
  })
}

export function move(sk: Sketch, ids: readonly string[], dx: number, dy: number): Sketch {
  if (!dx && !dy) return sk
  const moving = new Set<string>()
  for (const id of roots(sk, ids)) {
    const e = byId(sk, id)
    if (!e || e.locked) continue
    moving.add(id)
    for (const c of descendants(sk, id)) moving.add(c.id)
  }
  return { ...sk, elements: sk.elements.map((e) => (moving.has(e.id) ? { ...e, x: e.x + dx, y: e.y + dy } : e)) }
}

/**
 * After a move, each moved element belongs to the container now under its centre. A container is
 * re-parented as a whole, never into itself or anything inside it, and ends up drawn above its new parent.
 */
export function settle(sk: Sketch, ids: readonly string[]): Sketch {
  let out = sk
  for (const id of roots(sk, ids)) {
    const e = byId(out, id)
    if (!e) continue
    const exclude = new Set([id, ...descendants(out, id).map((c) => c.id)])
    const parent = containerAt(out, e.x + e.w / 2, e.y + e.h / 2, exclude)?.id ?? null
    if (parent === e.parent) continue
    const moved = [e, ...descendants(out, id)]
    const movedIds = new Set(moved.map((m) => m.id))
    const rest = out.elements.filter((x) => !movedIds.has(x.id))
    out = { ...out, elements: [...rest, { ...e, parent }, ...moved.slice(1)] }
  }
  return out
}

export function remove(sk: Sketch, ids: readonly string[]): Sketch {
  const gone = new Set<string>()
  for (const id of ids) {
    gone.add(id)
    for (const c of descendants(sk, id)) gone.add(c.id)
  }
  return { ...sk, elements: sk.elements.filter((e) => !gone.has(e.id)) }
}

/** Copies elements (with their contents) offset by `offset`; returns the ids of the new top-level copies. */
export function duplicate(sk: Sketch, ids: readonly string[], offset: number): { sketch: Sketch; ids: string[] } {
  const copies: SketchElement[] = []
  const top: string[] = []
  for (const id of roots(sk, ids)) {
    const e = byId(sk, id)
    if (!e) continue
    const map = new Map<string, string>()
    for (const src of [e, ...descendants(sk, id)]) {
      const nid = newElementId()
      map.set(src.id, nid)
      copies.push({ ...src, states: [...src.states], id: nid, parent: src.id === id ? src.parent : (map.get(src.parent!) ?? src.parent), x: src.x + offset, y: src.y + offset, name: src.id === id ? `${src.name} copy` : src.name })
    }
    top.push(map.get(id)!)
  }
  return { sketch: { ...sk, elements: [...sk.elements, ...copies] }, ids: top }
}

/** Plain-data clipboard: the elements with their contents, re-identified on paste. */
export function copy(sk: Sketch, ids: readonly string[]): SketchElement[] {
  const out: SketchElement[] = []
  for (const id of roots(sk, ids)) {
    const e = byId(sk, id)
    if (e) out.push({ ...e, parent: null }, ...descendants(sk, id))
  }
  return JSON.parse(JSON.stringify(out))
}

export function paste(sk: Sketch, clip: readonly SketchElement[], offset: number): { sketch: Sketch; ids: string[] } {
  if (!clip.length) return { sketch: sk, ids: [] }
  const map = new Map<string, string>()
  for (const e of clip) map.set(e.id, newElementId())
  const tops = clip.filter((e) => !e.parent || !map.has(e.parent))
  let out = sk
  const ids: string[] = []
  for (const t of tops) {
    const x = t.x + offset
    const y = t.y + offset
    const parent = containerAt(out, x + t.w / 2, y + t.h / 2)?.id ?? null
    out = { ...out, elements: [...out.elements, { ...t, id: map.get(t.id)!, parent, x, y }] }
    ids.push(map.get(t.id)!)
  }
  const rest = clip.filter((e) => e.parent && map.has(e.parent)).map((e) => ({ ...e, id: map.get(e.id)!, parent: map.get(e.parent!)!, x: e.x + offset, y: e.y + offset }))
  return { sketch: { ...out, elements: [...out.elements, ...rest] }, ids }
}

/** Moves an element among its siblings: up/down one step, or to the top/bottom of the stack. */
export function reorder(sk: Sketch, id: string, to: 'up' | 'down' | 'top' | 'bottom'): Sketch {
  const e = byId(sk, id)
  if (!e) return sk
  const sibs = children(sk, e.parent)
  const i = sibs.findIndex((s) => s.id === id)
  const j = to === 'top' ? sibs.length - 1 : to === 'bottom' ? 0 : to === 'up' ? Math.min(sibs.length - 1, i + 1) : Math.max(0, i - 1)
  if (i === j) return sk
  const order = sibs.map((s) => s.id)
  order.splice(i, 1)
  order.splice(j, 0, id)
  // rewrite the sibling slots in their new order, leaving everything else where it was
  const slots = sk.elements.map((x, k) => (x.parent === e.parent ? k : -1)).filter((k) => k >= 0)
  const next = [...sk.elements]
  slots.forEach((k, n) => (next[k] = byId(sk, order[n])!))
  return { ...sk, elements: next }
}

/** Drawing order: each element right after its parent, siblings in list order. */
export function drawOrder(sk: Sketch): SketchElement[] {
  const out: SketchElement[] = []
  const known = new Set(sk.elements.map((e) => e.id))
  const walk = (p: string | null) => {
    for (const e of sk.elements) if (e.parent === p || (p === null && e.parent && !known.has(e.parent))) (out.push(e), walk(e.id))
  }
  walk(null)
  return out
}

export const snap = (v: number, grid: number): number => (grid > 1 ? Math.round(v / grid) * grid : Math.round(v))

export interface Guide {
  axis: 'x' | 'y'
  at: number
}

/**
 * Where a box being moved lands: on the grid, unless one of its edges or its centre is within
 * `threshold` of another element's edge or centre, in which case it lines up with that instead.
 * Returns the guides that lined it up so the editor can draw them.
 */
export function snapRect(sk: Sketch, r: Rect, moving: ReadonlySet<string>, grid: number, threshold: number): { x: number; y: number; guides: Guide[] } {
  const xs: number[] = []
  const ys: number[] = []
  for (const e of sk.elements) {
    if (moving.has(e.id) || e.hidden) continue
    xs.push(e.x, e.x + e.w / 2, e.x + e.w)
    ys.push(e.y, e.y + e.h / 2, e.y + e.h)
  }
  xs.push(0, sk.canvas.w / 2, sk.canvas.w)
  ys.push(0, sk.canvas.h / 2, sk.canvas.h)
  const fit = (start: number, size: number, lines: number[], axis: 'x' | 'y') => {
    let best: { d: number; pos: number; at: number } | null = null
    for (const off of [0, size / 2, size]) {
      for (const l of lines) {
        const d = Math.abs(start + off - l)
        if (d <= threshold && (!best || d < best.d)) best = { d, pos: l - off, at: l }
      }
    }
    return best ? { pos: Math.round(best.pos), guide: { axis, at: best.at } as Guide } : { pos: snap(start, grid), guide: null }
  }
  const fx = fit(r.x, r.w, xs, 'x')
  const fy = fit(r.y, r.h, ys, 'y')
  return { x: fx.pos, y: fy.pos, guides: [fx.guide, fy.guide].filter((g): g is Guide => !!g) }
}

/** Positions relative to the parent, as a UI framework places children. */
export interface SketchNode {
  id: string
  type: ElementType
  name: string
  x: number
  y: number
  w: number
  h: number
  abs: { x: number; y: number }
  text?: string
  anchor: Anchor
  states?: string[]
  notes?: string
  cols?: number
  rows?: number
  value?: number
  children?: SketchNode[]
}

export function tree(sk: Sketch): SketchNode[] {
  const build = (p: SketchElement | null): SketchNode[] =>
    drawOrder(sk)
      .filter((e) => e.parent === (p?.id ?? null) && !e.hidden)
      .map((e) => {
        const n: SketchNode = { id: e.id, type: e.type, name: e.name, x: e.x - (p?.x ?? 0), y: e.y - (p?.y ?? 0), w: e.w, h: e.h, abs: { x: e.x, y: e.y }, anchor: e.anchor }
        if (e.text !== undefined && e.text !== '') n.text = e.text
        if (e.states.length) n.states = [...e.states]
        if (e.notes.trim()) n.notes = e.notes.trim()
        if (e.cols !== undefined) (n.cols = e.cols), (n.rows = e.rows)
        if (e.value !== undefined) n.value = e.value
        const kids = build(e)
        if (kids.length) n.children = kids
        return n
      })
  return build(null)
}

/** What lands in `sketch.json`: the sketch itself plus the tree an implementer reads. */
export function exportJson(sk: Sketch): string {
  const p = PRESETS[sk.preset]
  return JSON.stringify(
    {
      schema: 1,
      name: sk.name,
      preset: sk.preset,
      target: p.label,
      units: p.units,
      canvas: sk.canvas,
      note: 'tree[] is the GUI to build: x/y are relative to the parent, abs is the position on the canvas. elements[] is the editable form the UI Sketcher reopens.',
      tree: tree(sk),
      elements: sk.elements
    },
    null,
    2
  )
}

/** Reads a saved sketch back, repairing what it can; null when it is not a sketch at all. */
export function parseSketch(raw: unknown): Sketch | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const preset = PRESET_IDS.includes(o.preset as PresetId) ? (o.preset as PresetId) : null
  if (!preset || !Array.isArray(o.elements)) return null
  const c = o.canvas as { w?: unknown; h?: unknown } | undefined
  const canvas = { w: Number(c?.w) > 0 ? Number(c!.w) : PRESETS[preset].canvas.w, h: Number(c?.h) > 0 ? Number(c!.h) : PRESETS[preset].canvas.h }
  const elements: SketchElement[] = []
  const ids = new Set<string>()
  for (const r of o.elements as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object' || !ELEMENT_TYPES.includes(r.type as ElementType)) continue
    const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
    const id = typeof r.id === 'string' && r.id && !ids.has(r.id) ? r.id : newElementId()
    ids.add(id)
    const el = fill(
      {
        id,
        type: r.type as ElementType,
        name: typeof r.name === 'string' ? r.name.slice(0, 80) : undefined,
        x: num(r.x),
        y: num(r.y),
        w: num(r.w, 10),
        h: num(r.h, 10),
        text: typeof r.text === 'string' ? r.text.slice(0, 500) : undefined,
        anchor: ANCHORS.includes(r.anchor as Anchor) ? (r.anchor as Anchor) : undefined,
        states: Array.isArray(r.states) ? r.states.filter((s): s is string => typeof s === 'string').slice(0, 10) : undefined,
        notes: typeof r.notes === 'string' ? r.notes.slice(0, 2000) : undefined,
        cols: r.cols !== undefined ? Math.max(1, Math.min(64, num(r.cols, 1))) : undefined,
        rows: r.rows !== undefined ? Math.max(1, Math.min(64, num(r.rows, 1))) : undefined,
        value: r.value !== undefined ? Math.max(0, Math.min(1, num(r.value))) : undefined,
        hidden: r.hidden === true,
        locked: r.locked === true
      },
      typeof r.parent === 'string' ? r.parent : null
    )
    elements.push(el)
  }
  // a parent that is missing, or a loop, makes the element top level
  for (const e of elements) {
    const seen = new Set<string>([e.id])
    for (let p = e.parent; p; p = elements.find((x) => x.id === p)?.parent ?? null) {
      if (seen.has(p) || !ids.has(p)) {
        e.parent = null
        break
      }
      seen.add(p)
    }
  }
  return { schema: 1, name: typeof o.name === 'string' && o.name.trim() ? o.name.slice(0, 80) : 'Sketch', preset, canvas, elements }
}

/** One line per element, indented by depth: the summary a message carries so the reader need not open the file first. */
export function summary(sk: Sketch, max = 60): string {
  const lines: string[] = []
  const walk = (nodes: SketchNode[], d: number) => {
    for (const n of nodes) {
      if (lines.length >= max) return
      const extra = [n.text ? `"${n.text}"` : '', n.cols ? `${n.cols}x${n.rows}` : '', n.states?.length ? `[${n.states.join(', ')}]` : '', n.notes ? `- ${n.notes.replace(/\s+/g, ' ').slice(0, 80)}` : '']
        .filter(Boolean)
        .join(' ')
      lines.push(`${'  '.repeat(d)}- ${n.type} ${n.name !== TYPE_LABEL[n.type] ? `"${n.name}" ` : ''}${n.w}x${n.h} at ${n.x},${n.y}${extra ? ` ${extra}` : ''}`)
      if (n.children) walk(n.children, d + 1)
    }
  }
  walk(tree(sk), 0)
  const total = sk.elements.filter((e) => !e.hidden).length
  if (total > lines.length) lines.push(`- ... and ${total - lines.length} more in sketch.json`)
  return lines.join('\n')
}

/** Undo and redo over whole sketches (they are small and immutable, so a snapshot is the cheapest command). */
export class History {
  private past: Sketch[] = []
  private future: Sketch[] = []
  constructor(private readonly limit = 200) {}

  /** Records the state before a change. */
  push(before: Sketch): void {
    this.past.push(before)
    if (this.past.length > this.limit) this.past.shift()
    this.future = []
  }

  undo(current: Sketch): Sketch | null {
    const prev = this.past.pop()
    if (!prev) return null
    this.future.push(current)
    return prev
  }

  redo(current: Sketch): Sketch | null {
    const next = this.future.pop()
    if (!next) return null
    this.past.push(current)
    return next
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  clear(): void {
    this.past = []
    this.future = []
  }
}
