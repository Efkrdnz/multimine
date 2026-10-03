import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, Code2, Plus, X } from 'lucide-react'
import {
  addNode,
  connect,
  hasInput,
  KIND_LABEL,
  NODE_W,
  portsOf,
  setCases,
  updateNode,
  valueName,
  valuesIn,
  type Board,
  type CodeMap,
  type CodeRef,
  type Issue,
  type Kind,
  type Link,
  type LogicNode
} from '@shared/logic/model'
import { TARGETS, type PaletteItem } from '@shared/logic/targets'

export const KIND_COLOR: Record<Kind, string> = {
  event: '#f87171',
  condition: '#fbbf24',
  action: '#60a5fa',
  wait: '#a78bfa',
  repeat: '#c084fc',
  value: '#34d399',
  note: '#94a3b8'
}

export interface View {
  x: number
  y: number
  z: number
}

const HEADER = 30
const PORT_ROW = 22
const FOOT_PAD = 6

export interface CanvasProps {
  board: Board
  issues: Map<string, Issue[]>
  /** Ids in the last build, and the ones changed since it (null: never built). */
  built: Set<string> | null
  changed: Set<string>
  codeMap: CodeMap
  selection: Set<string>
  setSelection: (s: Set<string>) => void
  selectedLink: Link | null
  setSelectedLink: (l: Link | null) => void
  view: View
  setView: (v: View) => void
  /** An edit that is its own undo step. */
  change: (next: Board) => void
  /** A step of a drag or of typing: shown at once, made one undo step by `settle`. */
  preview: (next: Board) => void
  settle: (before: Board) => void
  openCode: (ref: CodeRef) => void
  toast: (text: string) => void
}

type Drag =
  | { kind: 'nodes'; startX: number; startY: number; before: Board; moved: boolean }
  | { kind: 'pan'; startX: number; startY: number; view: View }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; add: boolean }
  | { kind: 'wire'; from: string; port: string; x: number; y: number }

/** A quick-add menu: where it opens (world), and the output it will be linked from, if any. */
type Quick = { x: number; y: number; sx: number; sy: number; from?: { id: string; port: string } }

export function Canvas(p: CanvasProps) {
  const { board, view } = p
  const host = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [quick, setQuick] = useState<Quick | null>(null)
  const heights = useRef(new Map<string, number>())
  const [, remeasure] = useState(0)
  const observer = useMemo(
    () =>
      new ResizeObserver((entries) => {
        let moved = false
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.nodeId
          const h = (e.target as HTMLElement).offsetHeight
          if (id && heights.current.get(id) !== h) (heights.current.set(id, h), (moved = true))
        }
        if (moved) remeasure((n) => n + 1)
      }),
    []
  )
  useEffect(() => () => observer.disconnect(), [observer])
  const measure = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return
      heights.current.set(el.dataset.nodeId!, el.offsetHeight)
      observer.observe(el)
    },
    [observer]
  )

  const toWorld = (cx: number, cy: number) => {
    const r = host.current!.getBoundingClientRect()
    return { x: (cx - r.left - view.x) / view.z, y: (cy - r.top - view.y) / view.z }
  }

  const portPos = (n: LogicNode, port: string) => {
    const ports = portsOf(n)
    const h = heights.current.get(n.id) ?? HEADER + 60 + ports.length * PORT_ROW
    const i = ports.indexOf(port)
    return { x: n.x + NODE_W, y: n.y + h - FOOT_PAD - (ports.length - i) * PORT_ROW + PORT_ROW / 2 }
  }
  const inPos = (n: LogicNode) => ({ x: n.x, y: n.y + HEADER / 2 })

  // wheel zooms round the pointer; over a box being typed in it scrolls the text instead
  const onWheel = (e: React.WheelEvent) => {
    if ((e.target as HTMLElement).closest('textarea')) return
    const r = host.current!.getBoundingClientRect()
    const z = Math.min(2, Math.max(0.3, view.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
    const mx = e.clientX - r.left
    const my = e.clientY - r.top
    p.setView({ z, x: mx - ((mx - view.x) / view.z) * z, y: my - ((my - view.y) / view.z) * z })
  }

  const onBackgroundDown = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.bg) return
    setQuick(null)
    host.current?.focus()
    if (e.button === 1 || e.button === 2 || e.altKey) {
      e.preventDefault()
      return setDrag({ kind: 'pan', startX: e.clientX, startY: e.clientY, view })
    }
    if (e.button !== 0) return
    const w = toWorld(e.clientX, e.clientY)
    if (!e.shiftKey) (p.setSelection(new Set()), p.setSelectedLink(null))
    setDrag({ kind: 'marquee', x0: w.x, y0: w.y, x1: w.x, y1: w.y, add: e.shiftKey })
  }

  const onNodeDown = (e: React.MouseEvent, n: LogicNode) => {
    if (e.button !== 0) return
    e.stopPropagation()
    host.current?.focus()
    setQuick(null)
    p.setSelectedLink(null)
    let sel = p.selection
    if (e.shiftKey) {
      sel = new Set(sel)
      sel.has(n.id) ? sel.delete(n.id) : sel.add(n.id)
    } else if (!sel.has(n.id)) sel = new Set([n.id])
    p.setSelection(sel)
    setDrag({ kind: 'nodes', startX: e.clientX, startY: e.clientY, before: board, moved: false })
  }

  const onPortDown = (e: React.MouseEvent, n: LogicNode, port: string) => {
    e.stopPropagation()
    e.preventDefault()
    const w = toWorld(e.clientX, e.clientY)
    setDrag({ kind: 'wire', from: n.id, port, x: w.x, y: w.y })
  }

  useEffect(() => {
    if (!drag) return
    const move = (e: MouseEvent) => {
      if (drag.kind === 'pan') return p.setView({ ...drag.view, x: drag.view.x + e.clientX - drag.startX, y: drag.view.y + e.clientY - drag.startY })
      if (drag.kind === 'nodes') {
        const dx = (e.clientX - drag.startX) / view.z
        const dy = (e.clientY - drag.startY) / view.z
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return
        drag.moved = true
        const ids = p.selection
        p.preview({ ...drag.before, nodes: drag.before.nodes.map((n) => (ids.has(n.id) ? { ...n, x: Math.round(n.x + dx), y: Math.round(n.y + dy) } : n)) })
        return
      }
      const w = toWorld(e.clientX, e.clientY)
      if (drag.kind === 'marquee') setDrag({ ...drag, x1: w.x, y1: w.y })
      if (drag.kind === 'wire') setDrag({ ...drag, x: w.x, y: w.y })
    }
    const up = (e: MouseEvent) => {
      if (drag.kind === 'nodes' && drag.moved) p.settle(drag.before)
      if (drag.kind === 'marquee') {
        const [x0, x1] = [Math.min(drag.x0, drag.x1), Math.max(drag.x0, drag.x1)]
        const [y0, y1] = [Math.min(drag.y0, drag.y1), Math.max(drag.y0, drag.y1)]
        if (x1 - x0 > 4 || y1 - y0 > 4) {
          const hit = board.nodes.filter((n) => n.x < x1 && n.x + NODE_W > x0 && n.y < y1 && n.y + (heights.current.get(n.id) ?? 80) > y0).map((n) => n.id)
          p.setSelection(new Set([...(drag.add ? p.selection : []), ...hit]))
        }
      }
      if (drag.kind === 'wire') {
        const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node-id]') as HTMLElement | null
        const to = el?.dataset.nodeId
        if (to && to !== drag.from) {
          const r = connect(board, drag.from, drag.port, to)
          r.board ? p.change(r.board) : p.toast(r.error)
        } else if (!to) {
          const r = host.current!.getBoundingClientRect()
          setQuick({ x: drag.x, y: drag.y - HEADER / 2, sx: e.clientX - r.left, sy: e.clientY - r.top, from: { id: drag.from, port: drag.port } })
        }
      }
      setDrag(null)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => (window.removeEventListener('mousemove', move), window.removeEventListener('mouseup', up))
  })

  const onDouble = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.bg) return
    const w = toWorld(e.clientX, e.clientY)
    const r = host.current!.getBoundingClientRect()
    setQuick({ x: w.x, y: w.y, sx: e.clientX - r.left, sy: e.clientY - r.top })
  }

  const place = (item: PaletteItem) => {
    if (!quick) return
    const r = addNode(board, item.kind, quick.x, quick.y, item.title, item.text)
    let next = r.board
    if (quick.from) {
      const c = connect(next, quick.from.id, quick.from.port, r.id)
      if (c.board) next = c.board
    }
    p.change(next)
    p.setSelection(new Set([r.id]))
    setQuick(null)
  }

  const wires = board.links.map((l) => {
    const a = board.nodes.find((n) => n.id === l.from)
    const z = board.nodes.find((n) => n.id === l.to)
    if (!a || !z) return null
    const s = portPos(a, l.port)
    const t = inPos(z)
    const on = p.selectedLink && p.selectedLink.from === l.from && p.selectedLink.port === l.port && p.selectedLink.to === l.to
    return { l, d: curve(s.x, s.y, t.x, t.y), color: KIND_COLOR[a.kind], on, label: portsOf(a).length > 1 ? l.port : '' }
  })

  const dragging = drag?.kind === 'wire' ? board.nodes.find((n) => n.id === drag.from) : undefined
  const values = board.nodes.filter((n) => n.kind === 'value')

  return (
    <div
      ref={host}
      className="relative min-h-0 flex-1 overflow-hidden outline-none"
      style={{ background: 'radial-gradient(circle at 1px 1px, rgb(148 163 184 / 0.18) 1px, transparent 0) 0 0 / 24px 24px, rgb(6 8 20)', backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${24 * view.z}px ${24 * view.z}px`, cursor: drag?.kind === 'pan' ? 'grabbing' : 'default' }}
      tabIndex={-1}
      onMouseDown={onBackgroundDown}
      onDoubleClick={onDouble}
      onWheel={onWheel}
      // focusing a box near the edge makes the browser scroll this clipped host: turn that into a pan
      onScroll={(e) => {
        const el = e.currentTarget
        if (!el.scrollLeft && !el.scrollTop) return
        p.setView({ ...view, x: view.x - el.scrollLeft - (el.scrollLeft ? 24 : 0), y: view.y - el.scrollTop - (el.scrollTop ? 24 : 0) })
        el.scrollLeft = 0
        el.scrollTop = 0
      }}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="lb-canvas"
    >
      <div data-bg="1" className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
        <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1">
          {wires.map(
            (w) =>
              w && (
                <g key={`${w.l.from}|${w.l.port}|${w.l.to}`}>
                  <path d={w.d} fill="none" stroke="transparent" strokeWidth={12} className="pointer-events-auto cursor-pointer" onMouseDown={(e) => (e.stopPropagation(), p.setSelectedLink(w.l), p.setSelection(new Set()), host.current?.focus())} data-testid={`lb-link-${w.l.from}-${w.l.port}-${w.l.to}`} />
                  <path d={w.d} fill="none" stroke={w.color} strokeOpacity={w.on ? 1 : 0.75} strokeWidth={w.on ? 3.5 : 2} />
                </g>
              )
          )}
          {drag?.kind === 'wire' && dragging && (() => {
            const s = portPos(dragging, drag.port)
            return <path d={curve(s.x, s.y, drag.x, drag.y)} fill="none" stroke={KIND_COLOR[dragging.kind]} strokeWidth={2} strokeDasharray="6 4" />
          })()}
        </svg>
        {board.nodes.map((n) => (
          <NodeCard
            key={n.id}
            n={n}
            measure={measure}
            selected={p.selection.has(n.id)}
            issues={p.issues.get(n.id) ?? []}
            built={!!p.built?.has(n.id) && !p.changed.has(n.id)}
            changed={!!p.built && p.changed.has(n.id)}
            code={p.codeMap[n.id] ?? []}
            values={values}
            board={board}
            onDown={(e) => onNodeDown(e, n)}
            onPortDown={(e, port) => onPortDown(e, n, port)}
            preview={p.preview}
            settle={p.settle}
            change={p.change}
            openCode={p.openCode}
          />
        ))}
        {drag?.kind === 'marquee' && (
          <div
            className="pointer-events-none absolute rounded border border-sky-300/70 bg-sky-400/10"
            style={{ left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }}
          />
        )}
      </div>

      {!board.nodes.length && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="max-w-md text-center text-sm leading-relaxed text-indigo-200/70">
            Double-click to add a box, or pick one from the palette.
            <br />
            Start with an <b className="text-red-300">Event</b> (when it happens), then drag from a box's right edge to link what follows.
          </div>
        </div>
      )}

      {quick && (
        <QuickAdd
          at={{ x: quick.sx, y: quick.sy }}
          items={paletteFor(board).filter((i) => !quick.from || hasInput(i.kind))}
          onPick={place}
          onClose={() => setQuick(null)}
        />
      )}
    </div>
  )
}

export function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

/** The target's ready-made boxes, then a blank one of each kind. */
export function paletteFor(board: Board): PaletteItem[] {
  const ready = TARGETS[board.target].palette
  const blank: PaletteItem[] = (['event', 'condition', 'action', 'wait', 'repeat', 'value', 'note'] as Kind[]).map((k) => ({ kind: k, title: '', text: '' }))
  return [...blank, ...ready]
}

function QuickAdd({ at, items, onPick, onClose }: { at: { x: number; y: number }; items: PaletteItem[]; onPick: (i: PaletteItem) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const shown = items.filter((i) => `${i.title} ${i.text} ${KIND_LABEL[i.kind]}`.toLowerCase().includes(q.toLowerCase())).slice(0, 40)
  return (
    <div className="glass absolute z-20 w-64 rounded-xl p-1.5 shadow-2xl" style={{ left: at.x, top: at.y, background: 'rgb(12 14 32 / 0.97)' }} onMouseDown={(e) => e.stopPropagation()} data-testid="lb-quick">
      <input
        autoFocus
        className="field mb-1 !py-1 !text-xs"
        placeholder="Add a box..."
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'Enter' && shown[0]) onPick(shown[0])
        }}
      />
      <div className="scroll-thin max-h-72 overflow-y-auto">
        {shown.map((i, k) => (
          <button key={k} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-white/10" onClick={() => onPick(i)} data-testid={`lb-quick-${i.kind}-${i.title || 'blank'}`}>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: KIND_COLOR[i.kind] }} />
            <span className="truncate text-indigo-50">{i.title || `${KIND_LABEL[i.kind]} (blank)`}</span>
            {i.title && <span className="ml-auto shrink-0 text-[10px] text-indigo-300/50">{KIND_LABEL[i.kind]}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

interface NodeProps {
  n: LogicNode
  measure: (el: HTMLDivElement | null) => void
  selected: boolean
  issues: Issue[]
  built: boolean
  changed: boolean
  code: CodeRef[]
  values: LogicNode[]
  board: Board
  onDown: (e: React.MouseEvent) => void
  onPortDown: (e: React.MouseEvent, port: string) => void
  preview: (b: Board) => void
  settle: (before: Board) => void
  change: (b: Board) => void
  openCode: (ref: CodeRef) => void
}

function NodeCard({ n, measure, selected, issues, built, changed, code, values, board, onDown, onPortDown, preview, settle, change, openCode }: NodeProps) {
  const color = KIND_COLOR[n.kind]
  const ports = portsOf(n)
  // typing is one undo step per field visit
  const before = useRef<Board | null>(null)
  const focus = () => (before.current = board)
  const blur = () => {
    if (before.current && before.current !== board) settle(before.current)
    before.current = null
  }
  const worst = issues.some((i) => i.level === 'error') ? 'error' : issues.length ? 'warning' : null
  const refs = valuesIn(`${n.title} ${n.text}`)
  const note = n.kind === 'note'

  return (
    <div
      ref={measure}
      data-node-id={n.id}
      className={`absolute rounded-xl border shadow-lg ${selected ? 'ring-2 ring-sky-300/80' : ''}`}
      style={{ left: n.x, top: n.y, width: NODE_W, borderColor: `${color}66`, background: note ? 'rgb(51 47 30 / 0.92)' : 'rgb(15 18 38 / 0.95)' }}
      data-testid={`lb-node-${n.id}`}
    >
      {hasInput(n.kind) && <div className="absolute -left-[7px] top-[8px] h-3.5 w-3.5 rounded-full border-2 bg-[#0b0e22]" style={{ borderColor: color }} />}
      <div className="flex cursor-grab items-center gap-1.5 rounded-t-xl px-2 active:cursor-grabbing" style={{ height: HEADER, background: `linear-gradient(90deg, ${color}40, transparent)` }} onMouseDown={onDown}>
        <span className="rounded px-1 font-mono text-[10px] font-semibold" style={{ background: `${color}33`, color }}>
          {n.id}
        </span>
        <input
          className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold text-white outline-none placeholder:text-white/30"
          value={n.title}
          placeholder={n.kind === 'value' ? 'name' : KIND_LABEL[n.kind]}
          onMouseDown={(e) => e.stopPropagation()}
          onFocus={focus}
          onBlur={blur}
          onChange={(e) => preview(updateNode(board, n.id, { title: e.target.value }))}
          data-testid={`lb-title-${n.id}`}
        />
        {n.kind === 'value' && valueName(n.title) && <span className="font-mono text-[10px] text-emerald-300/80">{`{${valueName(n.title)}}`}</span>}
        {worst && <span className={`h-2 w-2 shrink-0 rounded-full ${worst === 'error' ? 'bg-red-400' : 'bg-amber-400'}`} title={issues.map((i) => i.text).join('\n')} data-testid={`lb-issue-${n.id}`} />}
        {built && <Check size={13} className="shrink-0 text-emerald-300" aria-label="built" data-testid={`lb-built-${n.id}`} />}
        {changed && <span className="h-2 w-2 shrink-0 rounded-full bg-amber-300 ring-2 ring-amber-300/30" title="Changed since the last build" data-testid={`lb-changed-${n.id}`} />}
      </div>
      <div className="px-2 pb-1.5 pt-1">
        <AutoText
          value={n.text}
          placeholder={PLACEHOLDER[n.kind]}
          values={values}
          onFocus={focus}
          onBlur={blur}
          onChange={(text) => preview(updateNode(board, n.id, { text }))}
          testId={`lb-text-${n.id}`}
        />
        {refs.length > 0 && n.kind !== 'value' && (
          <div className="mt-1 flex flex-wrap gap-1">
            {refs.map((r) => {
              const v = values.find((x) => valueName(x.title) === r)
              return (
                <span key={r} className={`rounded px-1 font-mono text-[10px] ${v ? 'bg-emerald-400/15 text-emerald-200' : 'bg-red-400/20 text-red-200'}`} title={v ? `${v.title} = ${v.text}` : 'No value of this name'}>
                  {`{${r}}`}
                  {v ? ` = ${v.text.slice(0, 24)}` : ''}
                </span>
              )
            })}
          </div>
        )}
        {code.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {code.slice(0, 4).map((c, i) => (
              <button
                key={i}
                className="flex max-w-full items-center gap-1 rounded bg-sky-400/15 px-1.5 py-0.5 font-mono text-[10px] text-sky-100 hover:bg-sky-400/30"
                title={`${c.file}${c.line ? `:${c.line}` : ''}${c.note ? ` - ${c.note}` : ''}\nOpen in the code window`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => openCode(c)}
                data-testid={`lb-code-${n.id}`}
              >
                <Code2 size={10} className="shrink-0" />
                <span className="truncate">
                  {c.file.split('/').pop()}
                  {c.line ? `:${c.line}` : ''}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {ports.length > 0 && (
        <div style={{ paddingBottom: FOOT_PAD }}>
          {ports.map((port, i) => (
            <div key={port} className="relative flex items-center justify-end gap-1 pr-3" style={{ height: PORT_ROW }}>
              {n.kind === 'condition' ? (
                <CaseLabel
                  value={port}
                  onRename={(v) => change(setCases(board, n.id, ports.map((x, k) => (k === i ? v : x))))}
                  onRemove={ports.length > 2 ? () => change(setCases(board, n.id, ports.filter((_, k) => k !== i))) : undefined}
                />
              ) : (
                <span className="text-[10.5px] text-indigo-200/70">{port}</span>
              )}
              <div
                className="absolute -right-[7px] top-1/2 h-3.5 w-3.5 -translate-y-1/2 cursor-crosshair rounded-full border-2 bg-[#0b0e22] hover:scale-125"
                style={{ borderColor: color, background: board.links.some((l) => l.from === n.id && l.port === port) ? color : undefined }}
                onMouseDown={(e) => onPortDown(e, port)}
                title="Drag to the box that comes next"
                data-testid={`lb-port-${n.id}-${port}`}
              />
            </div>
          ))}
          {n.kind === 'condition' && (
            <div className="flex justify-end pr-3">
              <button className="flex items-center gap-0.5 text-[10px] text-amber-200/60 hover:text-amber-100" onMouseDown={(e) => e.stopPropagation()} onClick={() => change(setCases(board, n.id, [...ports, `case ${ports.length + 1}`]))} title="Add a branch">
                <Plus size={10} /> branch
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const PLACEHOLDER: Record<Kind, string> = {
  event: 'When does this start? e.g. the player presses the skill key',
  condition: 'What is checked? e.g. the caster is sneaking',
  action: 'What happens? Use {name} for a value',
  wait: 'How long? e.g. 10 ticks',
  repeat: 'How often, how many times? e.g. every 5 ticks, 4 times',
  value: 'e.g. 6 + 2 per tier',
  note: 'A note for whoever builds it'
}

function CaseLabel({ value, onRename, onRemove }: { value: string; onRename: (v: string) => void; onRemove?: () => void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <span className="group flex items-center gap-0.5">
      {onRemove && (
        <button className="hidden text-indigo-300/50 hover:text-red-300 group-hover:block" onMouseDown={(e) => e.stopPropagation()} onClick={onRemove} title="Remove this branch">
          <X size={10} />
        </button>
      )}
      <input
        className="w-24 bg-transparent text-right text-[10.5px] text-amber-100/85 outline-none focus:text-white"
        value={text}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text.trim() && text !== value && onRename(text.trim())}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </span>
  )
}

/** A textarea that grows with its text and offers the board's values after a "{". */
function AutoText({ value, placeholder, values, onChange, onFocus, onBlur, testId }: { value: string; placeholder: string; values: LogicNode[]; onChange: (v: string) => void; onFocus: () => void; onBlur: () => void; testId: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.max(38, el.scrollHeight)}px`
  }, [value])
  const open = caret !== null ? /\{([^{}\n]*)$/.exec(value.slice(0, caret)) : null
  const names = values.map((v) => valueName(v.title)).filter(Boolean)
  const offer = open ? names.filter((n) => n.startsWith(valueName(open[1]) || '')).slice(0, 6) : []
  const insert = (name: string) => {
    if (!open || caret === null) return
    const start = caret - open[1].length
    const next = `${value.slice(0, start)}${name}}${value.slice(caret)}`
    onChange(next)
    requestAnimationFrame(() => {
      const el = ref.current
      if (el) (el.focus(), el.setSelectionRange(start + name.length + 1, start + name.length + 1))
    })
  }
  return (
    <div className="relative">
      <textarea
        ref={ref}
        rows={2}
        className="scroll-thin w-full resize-none bg-transparent text-[12px] leading-snug text-indigo-50 outline-none placeholder:text-indigo-300/35"
        value={value}
        placeholder={placeholder}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => (onChange(e.target.value), setCaret(e.target.selectionStart))}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
        onFocus={onFocus}
        onBlur={() => (setTimeout(() => setCaret(null), 150), onBlur())}
        onKeyDown={(e) => {
          if (offer.length && (e.key === 'Tab' || e.key === 'Enter')) (e.preventDefault(), insert(offer[0]))
          e.stopPropagation()
        }}
        data-testid={testId}
      />
      {offer.length > 0 && (
        <div className="absolute left-0 top-full z-10 mt-0.5 rounded-md border border-emerald-400/30 bg-[#0b1322] p-0.5 shadow-xl">
          {offer.map((name) => (
            <button key={name} className="block w-full rounded px-1.5 py-0.5 text-left font-mono text-[10.5px] text-emerald-200 hover:bg-emerald-400/15" onMouseDown={(e) => (e.preventDefault(), insert(name))}>
              {`{${name}}`}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
