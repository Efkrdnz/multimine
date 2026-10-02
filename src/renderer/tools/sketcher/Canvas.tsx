import { useEffect, useMemo, useRef, useState } from 'react'
import { drawSketch, type Look } from '@shared/sketch/draw'
import { byId, containerAt, descendants, drawOrder, move, roots, snap, snapRect, type ElementType, type Guide, type Rect, type Sketch } from '@shared/sketch/model'
import { PRESETS } from '@shared/sketch/presets'
import { OpsSvg } from './OpsSvg'

export interface View {
  zoom: number
  x: number
  y: number
}

/** Fits the whole canvas in a box of the given size, with a margin. */
export function fitView(sk: Sketch, w: number, h: number): View {
  const zoom = Math.max(0.05, Math.min((w - 48) / sk.canvas.w, (h - 48) / sk.canvas.h))
  return { zoom, x: (w - sk.canvas.w * zoom) / 2, y: (h - sk.canvas.h * zoom) / 2 }
}

type Drag =
  | { kind: 'move'; sx: number; sy: number; base: Sketch; ids: string[]; box: Rect; started: boolean }
  | { kind: 'resize'; sx: number; sy: number; base: Sketch; id: string; handle: string; orig: Rect; started: boolean }
  | { kind: 'draw'; sx: number; sy: number; type: ElementType | 'inventory' }
  | { kind: 'marquee'; sx: number; sy: number; add: boolean; prior: string[] }
  | { kind: 'pan'; cx: number; cy: number; view: View }

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
const CURSOR: Record<string, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }

function bounds(sk: Sketch, ids: readonly string[]): Rect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const id of ids) {
    const e = byId(sk, id)
    if (!e) continue
    x0 = Math.min(x0, e.x)
    y0 = Math.min(y0, e.y)
    x1 = Math.max(x1, e.x + e.w)
    y1 = Math.max(y1, e.y + e.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** The topmost visible element under a point. */
export function hitTest(sk: Sketch, x: number, y: number): string | null {
  const order = drawOrder(sk)
  const hiddenIds = new Set<string>()
  for (const e of order) if (e.hidden || (e.parent && hiddenIds.has(e.parent))) hiddenIds.add(e.id)
  for (let i = order.length - 1; i >= 0; i--) {
    const e = order[i]
    if (hiddenIds.has(e.id)) continue
    if (x >= e.x && y >= e.y && x <= e.x + e.w && y <= e.y + e.h) return e.id
  }
  return null
}

export function SketchCanvas({
  sketch,
  look,
  grid,
  showGrid,
  selection,
  tool,
  view,
  setView,
  onSelect,
  onBegin,
  onLive,
  onCommitMove,
  onDrawn
}: {
  sketch: Sketch
  look: Look
  grid: number
  showGrid: boolean
  selection: string[]
  tool: ElementType | 'inventory' | null
  view: View | null
  setView: (v: View) => void
  onSelect: (ids: string[]) => void
  /** A change is starting: record the state for undo. */
  onBegin: (before: Sketch) => void
  /** Mid-drag state, not yet in history. */
  onLive: (sk: Sketch) => void
  /** A move ended: re-parent what was moved. */
  onCommitMove: (ids: string[]) => void
  onDrawn: (type: ElementType | 'inventory', r: Rect) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [preview, setPreview] = useState<Rect | null>(null)
  const [guides, setGuides] = useState<Guide[]>([])
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [space, setSpace] = useState(false)
  const ops = useMemo(() => drawSketch(sketch, look), [sketch, look])

  // fit on first show and whenever the canvas size changes
  const fitKey = `${sketch.canvas.w}x${sketch.canvas.h}`
  const hasView = !!view
  useEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => el.clientWidth > 0 && setView(fitView(sketch, el.clientWidth, el.clientHeight))
    fit()
    // the window may be laid out after the first render; fit as soon as it has a size
    const ro = new ResizeObserver(() => !hasView && fit())
    ro.observe(el)
    return () => ro.disconnect()
  }, [fitKey, hasView])

  useEffect(() => {
    const down = (e: KeyboardEvent) => e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) && setSpace(true)
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpace(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => (window.removeEventListener('keydown', down), window.removeEventListener('keyup', up))
  }, [])

  // ctrl+wheel (and trackpad pinch) zooms at the pointer; a plain wheel pans
  useEffect(() => {
    const el = box.current
    if (!el || !view) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        const z = Math.max(0.05, Math.min(40, view.zoom * Math.exp(-e.deltaY * 0.0022)))
        const px = e.clientX - r.left
        const py = e.clientY - r.top
        setView({ zoom: z, x: px - ((px - view.x) / view.zoom) * z, y: py - ((py - view.y) / view.zoom) * z })
      } else setView({ ...view, x: view.x - e.deltaX, y: view.y - e.deltaY })
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [view, setView])

  if (!view) return <div ref={box} className="h-full w-full" />
  const z = view.zoom
  const toUnits = (cx: number, cy: number) => {
    const r = box.current!.getBoundingClientRect()
    return { x: (cx - r.left - view.x) / z, y: (cy - r.top - view.y) / z }
  }
  const threshold = 6 / z
  const single = selection.length === 1 ? byId(sketch, selection[0]) : undefined

  const down = (e: React.PointerEvent) => {
    if (e.button === 2) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    if (e.button === 1 || space) return setDrag({ kind: 'pan', cx: e.clientX, cy: e.clientY, view })
    const p = toUnits(e.clientX, e.clientY)
    if (tool) return setDrag({ kind: 'draw', sx: snap(p.x, grid), sy: snap(p.y, grid), type: tool })
    const handle = (e.target as Element).getAttribute('data-handle')
    if (handle && single && !single.locked) return setDrag({ kind: 'resize', sx: p.x, sy: p.y, base: sketch, id: single.id, handle, orig: { x: single.x, y: single.y, w: single.w, h: single.h }, started: false })
    const hit = hitTest(sketch, p.x, p.y)
    if (!hit) return setDrag({ kind: 'marquee', sx: p.x, sy: p.y, add: e.shiftKey, prior: e.shiftKey ? selection : [] })
    let sel = selection
    if (e.shiftKey) sel = selection.includes(hit) ? selection.filter((s) => s !== hit) : [...selection, hit]
    else if (!selection.includes(hit)) sel = [hit]
    onSelect(sel)
    const ids = roots(sketch, sel).filter((id) => !byId(sketch, id)?.locked)
    if (ids.length && sel.includes(hit)) setDrag({ kind: 'move', sx: p.x, sy: p.y, base: sketch, ids, box: bounds(sketch, ids), started: false })
  }

  const moveEv = (e: React.PointerEvent) => {
    const p = toUnits(e.clientX, e.clientY)
    if (!drag) return setHover(tool ? null : hitTest(sketch, p.x, p.y))
    if (drag.kind === 'pan') return setView({ ...drag.view, x: drag.view.x + e.clientX - drag.cx, y: drag.view.y + e.clientY - drag.cy })
    if (drag.kind === 'draw') {
      const x2 = snap(p.x, grid)
      const y2 = snap(p.y, grid)
      return setPreview({ x: Math.min(drag.sx, x2), y: Math.min(drag.sy, y2), w: Math.abs(x2 - drag.sx), h: Math.abs(y2 - drag.sy) })
    }
    if (drag.kind === 'marquee') {
      const r = { x: Math.min(drag.sx, p.x), y: Math.min(drag.sy, p.y), w: Math.abs(p.x - drag.sx), h: Math.abs(p.y - drag.sy) }
      setPreview(r)
      const inside = sketch.elements.filter((el) => !el.hidden && el.x >= r.x && el.y >= r.y && el.x + el.w <= r.x + r.w && el.y + el.h <= r.y + r.h).map((el) => el.id)
      return onSelect([...new Set([...drag.prior, ...roots(sketch, inside)])])
    }
    const dx = p.x - drag.sx
    const dy = p.y - drag.sy
    if (!drag.started) {
      if (Math.hypot(dx, dy) * z < 3) return
      onBegin(drag.base)
      setDrag({ ...drag, started: true })
    }
    if (drag.kind === 'move') {
      const moving = new Set(drag.ids.flatMap((id) => [id, ...descendants(drag.base, id).map((d) => d.id)]))
      const s = e.altKey ? { x: Math.round(drag.box.x + dx), y: Math.round(drag.box.y + dy), guides: [] } : snapRect(drag.base, { ...drag.box, x: drag.box.x + dx, y: drag.box.y + dy }, moving, grid, threshold)
      const next = move(drag.base, drag.ids, s.x - drag.box.x, s.y - drag.box.y)
      setGuides(s.guides)
      const lead = byId(next, drag.ids[0])!
      setDropTarget(containerAt(next, lead.x + lead.w / 2, lead.y + lead.h / 2, moving)?.id ?? null)
      return onLive(next)
    }
    // resize: the dragged edges follow the pointer on the grid; never below one unit
    const o = drag.orig
    let { x, y, w, h } = o
    if (drag.handle.includes('e')) w = Math.max(1, snap(o.x + o.w + dx, grid) - o.x)
    if (drag.handle.includes('s')) h = Math.max(1, snap(o.y + o.h + dy, grid) - o.y)
    if (drag.handle.includes('w')) {
      const nx = Math.min(snap(o.x + dx, grid), o.x + o.w - 1)
      w = o.x + o.w - nx
      x = nx
    }
    if (drag.handle.includes('n')) {
      const ny = Math.min(snap(o.y + dy, grid), o.y + o.h - 1)
      h = o.y + o.h - ny
      y = ny
    }
    onLive({ ...drag.base, elements: drag.base.elements.map((el) => (el.id === drag.id ? { ...el, x, y, w, h } : el)) })
  }

  const up = () => {
    if (drag?.kind === 'draw') {
      const p = preview
      onDrawn(drag.type, p && p.w >= 2 && p.h >= 2 ? p : { x: drag.sx, y: drag.sy, w: 0, h: 0 })
    }
    if (drag?.kind === 'move' && drag.started) onCommitMove(drag.ids)
    setDrag(null)
    setPreview(null)
    setGuides([])
    setDropTarget(null)
  }

  const hs = 7 / z
  const cursor = drag?.kind === 'pan' || space ? 'grabbing' : tool ? 'crosshair' : 'default'
  const gridPx = grid * z
  return (
    <div
      ref={box}
      className="relative h-full w-full touch-none overflow-hidden bg-[#070816]"
      style={{ cursor }}
      onPointerDown={down}
      onPointerMove={moveEv}
      onPointerUp={up}
      onPointerLeave={() => !drag && setHover(null)}
      data-testid="sketch-canvas"
    >
      <svg className="absolute inset-0 h-full w-full select-none">
        <g transform={`translate(${view.x} ${view.y}) scale(${z})`}>
          <rect x={-2 / z} y={-2 / z} width={sketch.canvas.w + 4 / z} height={sketch.canvas.h + 4 / z} fill="#000" opacity={0.5} />
          <OpsSvg ops={ops} />
          {showGrid && gridPx >= 5 && (
            <g opacity={look === 'wireframe' ? 0.5 : 0.18} pointerEvents="none">
              <defs>
                <pattern id="sk-grid" width={grid} height={grid} patternUnits="userSpaceOnUse">
                  <path d={`M ${grid} 0 L 0 0 0 ${grid}`} fill="none" stroke={look === 'wireframe' ? '#cbd5e1' : '#ffffff'} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                </pattern>
              </defs>
              <rect x={0} y={0} width={sketch.canvas.w} height={sketch.canvas.h} fill="url(#sk-grid)" />
            </g>
          )}
          {hover && !selection.includes(hover) && (() => {
            const e = byId(sketch, hover)
            return e ? <rect x={e.x} y={e.y} width={e.w} height={e.h} fill="none" stroke="#a78bfa" strokeOpacity={0.6} strokeWidth={1} vectorEffect="non-scaling-stroke" /> : null
          })()}
          {dropTarget && (() => {
            const e = byId(sketch, dropTarget)
            return e ? <rect x={e.x} y={e.y} width={e.w} height={e.h} fill="#34d399" fillOpacity={0.06} stroke="#34d399" strokeWidth={1.5} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" /> : null
          })()}
          {selection.map((id) => {
            const e = byId(sketch, id)
            return e ? <rect key={id} x={e.x} y={e.y} width={e.w} height={e.h} fill="none" stroke={e.locked ? '#f59e0b' : '#8b5cf6'} strokeWidth={1.5} vectorEffect="non-scaling-stroke" data-testid="sketch-selection" /> : null
          })}
          {single &&
            !single.locked &&
            !tool &&
            HANDLES.map((h) => {
              const cx = single.x + (h.includes('w') ? 0 : h.includes('e') ? single.w : single.w / 2)
              const cy = single.y + (h.includes('n') ? 0 : h.includes('s') ? single.h : single.h / 2)
              return <rect key={h} data-handle={h} x={cx - hs / 2} y={cy - hs / 2} width={hs} height={hs} fill="#fff" stroke="#8b5cf6" strokeWidth={1} vectorEffect="non-scaling-stroke" style={{ cursor: CURSOR[h] }} />
            })}
          {guides.map((g, i) =>
            g.axis === 'x' ? (
              <line key={i} x1={g.at} x2={g.at} y1={-10000} y2={10000} stroke="#f472b6" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ) : (
              <line key={i} y1={g.at} y2={g.at} x1={-10000} x2={10000} stroke="#f472b6" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            )
          )}
          {preview && <rect x={preview.x} y={preview.y} width={preview.w} height={preview.h} fill="#8b5cf6" fillOpacity={0.1} stroke="#8b5cf6" strokeDasharray="4 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
        </g>
      </svg>
      {(single || preview) && (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-0.5 font-mono text-[10px] text-indigo-200">
          {preview ? `${preview.w} x ${preview.h}` : single && `${single.x}, ${single.y}  ${single.w} x ${single.h} ${PRESETS[sketch.preset].units}`}
        </div>
      )}
    </div>
  )
}
