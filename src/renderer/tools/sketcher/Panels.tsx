import { useState } from 'react'
import { ChevronDown, ChevronRight, Eye, EyeOff, Lock, Unlock } from 'lucide-react'
import { displayName } from '@shared/sketch/draw'
import { ANCHORS, byId, children, CONTAINERS, ELEMENT_TYPES, STATES, TYPE_LABEL, type Anchor, type ElementType, type Sketch, type SketchElement } from '@shared/sketch/model'
import { PRESETS } from '@shared/sketch/presets'
import { TypeIcon } from './icons'

/** The element palette: pick a type, then drag on the canvas (or click for its default size). */
export function Palette({ sketch, tool, setTool }: { sketch: Sketch; tool: ElementType | 'inventory' | null; setTool: (t: ElementType | 'inventory' | null) => void }) {
  const mc = sketch.preset === 'minecraft'
  return (
    <div className="grid grid-cols-4 gap-1">
      {ELEMENT_TYPES.map((t) => (
        <button
          key={t}
          title={`${TYPE_LABEL[t]} - drag on the canvas, or click for the default size`}
          onClick={() => setTool(tool === t ? null : t)}
          className={`flex flex-col items-center gap-0.5 rounded-lg border px-0.5 py-1.5 text-[9.5px] leading-none transition ${tool === t ? 'border-violet-400/70 bg-violet-500/25 text-white' : 'border-white/5 bg-white/[0.03] text-indigo-200/90 hover:border-violet-400/30 hover:bg-white/[0.06]'}`}
          data-testid={`sk-tool-${t}`}
        >
          <TypeIcon type={t} />
          <span className="max-w-full truncate">{TYPE_LABEL[t]}</span>
        </button>
      ))}
      {mc && (
        <button
          title="Player inventory: 3x9 slots and the hotbar, as vanilla places them in a 176-wide container"
          onClick={() => setTool(tool === 'inventory' ? null : 'inventory')}
          className={`col-span-4 rounded-lg border px-2 py-1.5 text-[11px] transition ${tool === 'inventory' ? 'border-violet-400/70 bg-violet-500/25 text-white' : 'border-white/5 bg-white/[0.03] text-indigo-200/90 hover:border-violet-400/30'}`}
          data-testid="sk-tool-inventory"
        >
          + Player inventory stamp
        </button>
      )}
    </div>
  )
}

/** The element tree: select, show/hide, lock, collapse. */
export function Layers({ sketch, selection, onSelect, onToggle }: { sketch: Sketch; selection: string[]; onSelect: (ids: string[], additive: boolean) => void; onToggle: (id: string, field: 'hidden' | 'locked') => void }) {
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const rows: { e: SketchElement; depth: number }[] = []
  const walk = (p: string | null, d: number) => {
    // top of the stack first, as layer lists read
    for (const e of [...children(sketch, p)].reverse()) {
      rows.push({ e, depth: d })
      if (!closed.has(e.id)) walk(e.id, d + 1)
    }
  }
  walk(null, 0)
  if (!rows.length) return <div className="px-2 py-3 text-xs text-indigo-300/60">Nothing yet. Pick an element above and drag on the canvas.</div>
  return (
    <div className="space-y-px" data-testid="sk-layers">
      {rows.map(({ e, depth }) => {
        const kids = children(sketch, e.id).length > 0
        const sel = selection.includes(e.id)
        return (
          <div
            key={e.id}
            onClick={(ev) => onSelect([e.id], ev.shiftKey)}
            className={`group flex cursor-pointer items-center gap-1 rounded-md py-0.5 pr-1 text-[11.5px] ${sel ? 'bg-violet-500/25 text-white' : 'text-indigo-100/85 hover:bg-white/5'} ${e.hidden ? 'opacity-45' : ''}`}
            style={{ paddingLeft: 4 + depth * 12 }}
          >
            <button
              className={`w-3 shrink-0 text-indigo-300/70 ${kids ? '' : 'invisible'}`}
              onClick={(ev) => {
                ev.stopPropagation()
                const next = new Set(closed)
                if (next.has(e.id)) next.delete(e.id)
                else next.add(e.id)
                setClosed(next)
              }}
            >
              {closed.has(e.id) ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
            </button>
            <TypeIcon type={e.type} size={12} />
            <span className="flex-1 truncate">{displayName(e)}</span>
            <button title={e.locked ? 'Unlock' : 'Lock'} className={`${e.locked ? '' : 'opacity-0 group-hover:opacity-60'} hover:opacity-100`} onClick={(ev) => (ev.stopPropagation(), onToggle(e.id, 'locked'))}>
              {e.locked ? <Lock size={11} /> : <Unlock size={11} />}
            </button>
            <button title={e.hidden ? 'Show' : 'Hide'} className={`${e.hidden ? '' : 'opacity-0 group-hover:opacity-60'} hover:opacity-100`} onClick={(ev) => (ev.stopPropagation(), onToggle(e.id, 'hidden'))}>
              {e.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
            </button>
          </div>
        )
      })}
    </div>
  )
}

function Num({ label, value, onChange, step = 1, min, max }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number }) {
  return (
    <label className="flex items-center gap-1 text-[11px] text-indigo-300/80">
      <span className="w-3 shrink-0 font-mono">{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
        onChange={(e) => e.target.value !== '' && Number.isFinite(Number(e.target.value)) && onChange(Number(e.target.value))}
        className="field !px-1.5 !py-1 font-mono !text-[11.5px]"
        data-testid={`sk-prop-${label}`}
      />
    </label>
  )
}

/**
 * The selected element's properties in the target's own units, or the sketch's when nothing is
 * selected. Every edit is one undo step (typing in a field merges into the step it started).
 */
export function Properties({ sketch, selection, onPatch, onSketch }: { sketch: Sketch; selection: string[]; onPatch: (id: string, patch: Partial<SketchElement>) => void; onSketch: (patch: Partial<Sketch>) => void }) {
  const units = PRESETS[sketch.preset].units
  if (selection.length > 1) return <div className="p-3 text-xs text-indigo-300/80">{selection.length} elements selected. Drag to move them together; Delete removes them; Ctrl+D duplicates.</div>
  const e = selection.length === 1 ? byId(sketch, selection[0]) : undefined
  if (!e) {
    return (
      <div className="space-y-3 p-3">
        <div>
          <div className="label">Canvas ({units})</div>
          <div className="grid grid-cols-2 gap-1.5">
            <Num label="W" value={sketch.canvas.w} min={16} onChange={(w) => onSketch({ canvas: { ...sketch.canvas, w: Math.max(16, Math.round(w)) } })} />
            <Num label="H" value={sketch.canvas.h} min={16} onChange={(h) => onSketch({ canvas: { ...sketch.canvas, h: Math.max(16, Math.round(h)) } })} />
          </div>
          {sketch.preset === 'minecraft' && <div className="mt-1.5 text-[10.5px] leading-snug text-indigo-300/60">427 x 240 is a 1280x720 window at GUI scale 3, the size most screens are judged at.</div>}
        </div>
        <div className="text-[11px] leading-relaxed text-indigo-300/70">
          Pick an element and drag on the canvas. Drop elements into a window, panel, layer or list to nest them; moving a container moves its contents.
          <br />
          <span className="text-indigo-300/50">Ctrl+wheel zooms, wheel or Space+drag pans, Alt+drag skips snapping, arrows nudge (Shift: a grid step).</span>
        </div>
      </div>
    )
  }
  const set = (patch: Partial<SketchElement>) => onPatch(e.id, patch)
  const parent = e.parent ? byId(sketch, e.parent) : undefined
  return (
    <div className="space-y-3 p-3" data-testid="sk-properties">
      <div>
        <div className="label">
          <span className="flex items-center gap-1.5">
            <TypeIcon type={e.type} size={12} /> {TYPE_LABEL[e.type]}
            {parent && <span className="ml-auto truncate normal-case tracking-normal text-indigo-300/60">in {displayName(parent)}</span>}
          </span>
        </div>
        <input className="field !py-1 !text-xs" value={e.name} onChange={(ev) => set({ name: ev.target.value.slice(0, 80) })} placeholder="Name" data-testid="sk-prop-name" />
      </div>
      {e.text !== undefined && (
        <div>
          <div className="label">Text</div>
          <input className="field !py-1 !text-xs" value={e.text} onChange={(ev) => set({ text: ev.target.value.slice(0, 500) })} data-testid="sk-prop-text" />
        </div>
      )}
      <div>
        <div className="label">Position and size ({units}{parent ? `, ${e.x - parent.x},${e.y - parent.y} in parent` : ''})</div>
        <div className="grid grid-cols-2 gap-1.5">
          <Num label="X" value={e.x} onChange={(x) => set({ x })} />
          <Num label="Y" value={e.y} onChange={(y) => set({ y })} />
          <Num label="W" value={e.w} min={1} onChange={(w) => set({ w: Math.max(1, w) })} />
          <Num label="H" value={e.h} min={1} onChange={(h) => set({ h: Math.max(1, h) })} />
        </div>
      </div>
      {e.type === 'slotgrid' && (
        <div>
          <div className="label">Grid</div>
          <div className="grid grid-cols-2 gap-1.5">
            <Num label="C" value={e.cols ?? 1} min={1} max={64} onChange={(c) => set(resizeGrid(e, Math.max(1, Math.min(64, Math.round(c))), e.rows ?? 1))} />
            <Num label="R" value={e.rows ?? 1} min={1} max={64} onChange={(r) => set(resizeGrid(e, e.cols ?? 1, Math.max(1, Math.min(64, Math.round(r)))))} />
          </div>
        </div>
      )}
      {e.value !== undefined && (
        <div>
          <div className="label">Fill {Math.round(e.value * 100)}%</div>
          <input type="range" min={0} max={1} step={0.01} value={e.value} onChange={(ev) => set({ value: Number(ev.target.value) })} className="w-full accent-violet-500" />
        </div>
      )}
      <div>
        <div className="label">Anchor</div>
        <div className="grid w-[84px] grid-cols-3 gap-0.5">
          {ANCHORS.map((a: Anchor) => (
            <button key={a} title={a} onClick={() => set({ anchor: a })} className={`h-5 rounded-sm border ${e.anchor === a ? 'border-violet-400 bg-violet-500/60' : 'border-white/10 bg-white/5 hover:bg-white/10'}`} />
          ))}
        </div>
      </div>
      {!CONTAINERS.has(e.type) || e.type === 'list' ? (
        <div>
          <div className="label">States to build</div>
          <div className="flex flex-wrap gap-1">
            {STATES.map((s) => {
              const on = e.states.includes(s)
              return (
                <button key={s} onClick={() => set({ states: on ? e.states.filter((x) => x !== s) : [...e.states, s] })} className={`rounded-full border px-2 py-0.5 text-[10.5px] ${on ? 'border-violet-400/70 bg-violet-500/30 text-white' : 'border-white/10 text-indigo-300/80 hover:bg-white/5'}`}>
                  {s}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
      <div>
        <div className="label">Notes for the builder</div>
        <textarea className="field min-h-[64px] !text-xs" value={e.notes} onChange={(ev) => set({ notes: ev.target.value.slice(0, 2000) })} placeholder="Behaviour, data it shows, what clicking does..." data-testid="sk-prop-notes" />
      </div>
    </div>
  )
}

/** Changing a slot grid's counts keeps each cell its current size (18 in a Minecraft GUI). */
function resizeGrid(e: SketchElement, cols: number, rows: number): Partial<SketchElement> {
  const cw = e.w / Math.max(1, e.cols ?? 1)
  const ch = e.h / Math.max(1, e.rows ?? 1)
  return { cols, rows, w: Math.round(cw * cols), h: Math.round(ch * rows) }
}
